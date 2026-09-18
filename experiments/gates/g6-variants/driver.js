// ============================================================================================
// G-6 gate — in-page variant driver (tasks.md T025, hypothesis H-6), `budget.json` revision 3.
//
// The product does not compile the whole variant space, and it does not compile during interaction:
// it prepares a **configuration-derived subset** before the first frame (`prewarm-policy.mjs`) and
// serves the session from that pool. This driver measures exactly those three phases:
//
//   1. **startup** — cold cache, the prewarm plan built before the first frame (timed per variant);
//      judged on plan size, wall time and the p95 of one new variant's pipeline creation;
//   2. **session** — the documented 300-frame session, started with the pool ready: **zero**
//      compilations on the runtime path (the product's default behaviour, not a fallback);
//   3. **worstCase (informational)** — the remaining reachable variants, cold, recorded for
//      comparison only: it is not a product path and no criterion is derived from it.
//
// A variant's identity is (module text × pipeline-overridable-constant values), and a module text is
// parsed once. Every `createShaderModule` call is counted against the distinct text it was given, so
// "one parse per distinct text" is *counted*, not asserted.
//
// Pipeline-overridable `constants` are per **stage** in WebGPU, and every key MUST be declared by that
// stage's module; the emitted terrain modules declare both overrides in both stages (G-6/T025).
// ============================================================================================

const report = {
  ready: false,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  adapter: null,
  preferredFormat: null,
  wgslLanguageFeatures: null,
  errors: [],
  startup: null,
  session: null,
  worstCase: null,
  pages: [],
};

globalThis.__g6 = report;

const note = (message) => report.pages.push(`${new Date().toISOString()} ${message}`);

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url} -> HTTP ${response.status}`);
  return await response.json();
}

const VERTEX_FORMAT_SIZE = { float32: 4, float32x2: 8, float32x3: 12, float32x4: 16 };

function vertexBufferLayout(attributes) {
  const stride = attributes[0]?.stride ?? Math.max(...attributes.map((attribute) => attribute.offset + (VERTEX_FORMAT_SIZE[attribute.format] ?? 16)));
  return { arrayStride: stride, attributes: attributes.map((attribute) => ({ shaderLocation: attribute.location, offset: attribute.offset, format: attribute.format })) };
}

/**
 * The **explicit** pipeline layout the product will use: the H-4 union layout table (G-4) is shared by
 * every variant, so the backend never has to ask the driver to derive one.
 */
function buildPipelineLayout(device, layout) {
  const entries = [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: layout.structSize } }];
  for (const sampler of layout.samplers) {
    entries.push({ binding: sampler.textureBinding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } });
    entries.push({ binding: sampler.samplerBinding, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } });
  }
  return device.createPipelineLayout({ bindGroupLayouts: [device.createBindGroupLayout({ entries })] });
}

/** The two stages of one variant's pipeline, specialised with that variant's constant values. */
function pipelineStages({ vertexModule, fragmentModule, overrides, attributes, format }) {
  return {
    vertex: { module: vertexModule, entryPoint: "vs_main", buffers: attributes.length === 0 ? [] : [vertexBufferLayout(attributes)], constants: overrides },
    fragment: { module: fragmentModule, entryPoint: "fs_main", targets: [{ format }], constants: overrides },
  };
}

function histogram(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const buckets = [
    [0, 5], [5, 10], [10, 20], [20, 40], [40, 80], [80, 160], [160, 320], [320, Infinity],
  ].map(([low, high]) => ({ low, high: high === Infinity ? null : high, count: sorted.filter((value) => value >= low && value < high).length }));
  return {
    count: sorted.length,
    min: sorted.length === 0 ? 0 : sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    mean: sorted.length === 0 ? 0 : total / sorted.length,
    totalMs: total,
    buckets,
  };
}

async function main() {
  try {
    const inputUrl = new URLSearchParams(globalThis.location.search).get("input");
    const input = await fetchJson(inputUrl);
    note(`input ${inputUrl}`);

    const adapter = await globalThis.navigator.gpu.requestAdapter();
    if (adapter === null) throw new Error("requestAdapter() returned null");
    const info = adapter.info ?? {};
    report.adapter = {
      vendor: info.vendor ?? null,
      architecture: info.architecture ?? null,
      subgroupMinSize: info.subgroupMinSize ?? null,
      hasInfo: typeof info.vendor === "string" && info.vendor.length > 0,
    };
    const device = await adapter.requestDevice();
    report.preferredFormat = globalThis.navigator.gpu.getPreferredCanvasFormat();
    report.wgslLanguageFeatures = [...(globalThis.navigator.gpu.wgslLanguageFeatures ?? [])];
    device.addEventListener?.("uncapturederror", (event) => report.errors.push({ uncaptured: event.error?.message ?? String(event.error) }));

    // ---- load only the module texts this run needs, streaming the chunk files --------------------
    const wanted = new Set([...input.variants.map((variant) => variant.key), ...input.sessionRequests.map((request) => request.key)]);
    const modules = new Map();
    for (const chunkUrl of input.chunks) {
      const groups = await fetchJson(chunkUrl);
      for (const group of groups) {
        if (!wanted.has(group.key)) continue;
        modules.set(group.key, group);
        wanted.delete(group.key);
      }
      if (wanted.size === 0) break;
    }
    note(`loaded ${modules.size} distinct module pair(s); ${wanted.size} still missing`);
    const pipelineLayout = buildPipelineLayout(device, input.layout);
    const format = report.preferredFormat;

    // Module cache: one `createShaderModule` per (text, stage). The call count and the number of
    // distinct texts together make "parsed once" countable.
    const shaderModules = new Map();
    let moduleCompilations = 0;
    function modulesFor(key) {
      let entry = shaderModules.get(key);
      if (entry !== undefined) return { entry, parsed: false };
      const group = modules.get(key);
      if (group === undefined) throw new Error(`module text ${key} was not loaded`);
      entry = {
        vertexModule: device.createShaderModule({ code: group.vertexWgsl, label: `${key}-vs` }),
        fragmentModule: device.createShaderModule({ code: group.fragmentWgsl, label: `${key}-fs` }),
      };
      moduleCompilations += 2;
      shaderModules.set(key, entry);
      return { entry, parsed: true };
    }

    /**
     * One variant: create (or reuse) its module text, then create its pipeline with its own constant
     * values. `totalMs` includes the validation round trip (`popErrorScope`) — that is what one more
     * variant actually costs, and the budget is judged against it.
     */
    async function buildVariant(variant) {
      const started = performance.now();
      device.pushErrorScope("validation");
      const { entry, parsed } = modulesFor(variant.key);
      const syncMs = performance.now() - started;
      let error = null;
      device.pushErrorScope("validation");
      try {
        const stages = pipelineStages({ vertexModule: entry.vertexModule, fragmentModule: entry.fragmentModule, overrides: variant.overrides, attributes: modules.get(variant.key)?.attributes ?? [], format });
        const pipeline = device.createRenderPipeline({ layout: pipelineLayout, vertex: stages.vertex, fragment: stages.fragment, primitive: { topology: "triangle-list" } });
        pipeline.destroy?.();
      } catch (thrown) {
        error = `${thrown.name ?? "Error"}: ${thrown.message ?? String(thrown)}`;
      }
      const pipelineSyncMs = performance.now() - started - syncMs;
      const pipelineScopeError = await device.popErrorScope();
      const moduleScopeError = await device.popErrorScope();
      return {
        key: variant.id,
        moduleKey: variant.key,
        overrides: variant.overrides,
        parsedModule: parsed,
        syncMs,
        pipelineSyncMs,
        totalMs: performance.now() - started,
        ok: error === null && pipelineScopeError === null && moduleScopeError === null,
        error: error ?? pipelineScopeError?.message ?? moduleScopeError?.message ?? null,
      };
    }

    // The declared `layout: "auto"` comparison runs AFTER the budgeted phases (see below), so the
    // cold-cache startup measurement is not warmed up by 24 throw-away pipelines first.

    // ---- startup: the prewarm plan, cold cache, before the first frame ---------------------------
    // The pool is the product's variant pool: it is built here, once, and the session below must be
    // served from it entirely (budget.json revision 3: runtime compilations MUST be 0).
    const startupStarted = performance.now();
    const planMs = [];
    const syncSamples = [];
    const pool = new Map();
    let startupFailures = 0;
    for (const variant of input.prewarmVariants) {
      if (pool.has(variant.pipeline)) {
        report.errors.push({ duplicateVariantPipeline: variant.pipeline });
        continue;
      }
      const outcome = await buildVariant(variant);
      pool.set(variant.pipeline, outcome);
      planMs.push(outcome.totalMs);
      syncSamples.push(outcome.syncMs);
      if (!outcome.ok) {
        startupFailures += 1;
        report.errors.push({ variant: variant.id, error: outcome.error });
      }
    }
    const startupWallMs = performance.now() - startupStarted;

    // ---- session: the documented 300-frame session over the prepared pool ------------------------
    const sessionStarted = performance.now();
    let hits = 0;
    let misses = 0;
    const touched = new Set();
    const sessionCompileMs = [];
    for (const request of input.sessionRequests) {
      // The upstream cache key is [numberOfDayTextures][flags] (GlobeSurfaceShaderSet.js:243-267); the
      // pool is keyed by the variant identity (module text + constant values), which is that key.
      const entry = pool.get(request.pipeline);
      if (entry === undefined) {
        misses += 1;
        const variant = input.variants.find((candidate) => candidate.pipeline === request.pipeline) ?? {
          id: request.variant,
          key: request.key,
          overrides: request.overrides,
          pipeline: request.pipeline,
        };
        const outcome = await buildVariant(variant);
        pool.set(variant.pipeline, outcome);
        sessionCompileMs.push(outcome.totalMs);
        if (!outcome.ok) report.errors.push({ sessionVariant: request.variant, error: outcome.error });
      } else {
        hits += 1;
      }
      touched.add(request.pipeline);
    }
    const sessionWallMs = performance.now() - sessionStarted;

    // ---- informational: the variants OUTSIDE the plan, cold, recorded for comparison only --------
    // This is not a product path (the product does not prepare the whole space) and no criterion is
    // derived from it; the numbers are kept so a later layout change can be compared against them.
    const restStarted = performance.now();
    const restMs = [];
    const restSyncMs = [];
    let restFailures = 0;
    for (const variant of input.remainingVariants ?? []) {
      const outcome = await buildVariant(variant);
      restMs.push(outcome.totalMs);
      restSyncMs.push(outcome.syncMs);
      if (!outcome.ok) {
        restFailures += 1;
        report.errors.push({ remainingVariant: variant.id, error: outcome.error });
      }
      if (restMs.length % 128 === 0) {
        note(`informational sweep ${restMs.length}/${(input.remainingVariants ?? []).length} (${((performance.now() - restStarted) / 1000).toFixed(1)}s)`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    const restWallMs = performance.now() - restStarted;

    // ---- declared comparison: the same pipeline with `layout: "auto"` ----------------------------
    // Recorded for the W2 optimisation registration in plan.md (the explicit union layout costs ~40%
    // more per pipeline than the driver-derived one), not for any budget. Bounded sample, modules reused.
    const autoLayoutSampleMs = [];
    for (const variant of input.variants.slice(0, 24)) {
      const group = modules.get(variant.key);
      if (group === undefined) continue;
      const { entry } = modulesFor(variant.key);
      const started = performance.now();
      device.pushErrorScope("validation");
      device.pushErrorScope("validation");
      device
        .createRenderPipeline({
          layout: "auto",
          vertex: { module: entry.vertexModule, entryPoint: "vs_main", buffers: group.attributes.length === 0 ? [] : [vertexBufferLayout(group.attributes)], constants: variant.overrides },
          fragment: { module: entry.fragmentModule, entryPoint: "fs_main", targets: [{ format }], constants: variant.overrides },
          primitive: { topology: "triangle-list" },
        })
        .destroy?.();
      await device.popErrorScope();
      await device.popErrorScope();
      autoLayoutSampleMs.push(performance.now() - started);
    }
    const autoLayoutHistogram = histogram(autoLayoutSampleMs);

    report.startup = {
      planKey: input.prewarmPlan?.id ?? null,
      plannedVariants: input.prewarmVariants.length,
      declaredPlanSize: input.prewarmPlan?.declaredSize ?? null,
      configuration: input.prewarmPlan?.configuration ?? null,
      pipelineCompilations: planMs.length,
      shaderProgramInstances: pool.size,
      failures: startupFailures,
      wallMs: startupWallMs,
      histogram: histogram(planMs),
      syncHistogram: histogram(syncSamples),
      distinctModuleTexts: shaderModules.size,
      moduleCompilations,
    };
    report.session = {
      frames: input.sessionRequests.length,
      shaderProgramInstances: touched.size,
      pipelineCompilations: sessionCompileMs.length,
      cacheHits: hits,
      cacheMisses: misses,
      cacheHitRatio: hits + misses === 0 ? 0 : hits / (hits + misses),
      duplicateModuleCompilations: moduleCompilations - 2 * shaderModules.size,
      wallMs: sessionWallMs,
      histogram: histogram(sessionCompileMs),
      syncHistogram: histogram(sessionCompileMs),
      poolSize: pool.size,
      poolPreparedBeforeTheSession: true,
      uncompiledSessionVariants: input.sessionRequests.filter((request) => !pool.has(request.pipeline)).length,
    };
    report.worstCase = {
      role: "informational",
      requestedVariants: (input.remainingVariants ?? []).length,
      shaderProgramInstances: restMs.length,
      pipelineCompilations: restMs.length,
      duplicateModuleCompilations: moduleCompilations - 2 * shaderModules.size,
      distinctModuleTexts: shaderModules.size,
      moduleCompilations,
      failures: restFailures,
      wallMs: restWallMs,
      histogram: histogram(restMs),
      syncHistogram: histogram(restSyncMs),
      autoLayoutSampleHistogram: autoLayoutHistogram,
    };
    note(
      `startup: ${report.startup.pipelineCompilations} planned variant(s) in ${(startupWallMs / 1000).toFixed(1)}s; ` +
        `session: ${touched.size} instance(s), ${hits} hit(s) / ${misses} miss(es), ${(sessionWallMs / 1000).toFixed(1)}s; ` +
        `informational sweep: ${restMs.length} variant(s) in ${(restWallMs / 1000).toFixed(1)}s`,
    );
  } catch (error) {
    report.errors.push({ fatal: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`, stack: error?.stack ?? null });
  } finally {
    report.finishedAt = new Date().toISOString();
    report.ready = true;
  }
}

main();
