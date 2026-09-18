// ============================================================================================
// G-6 fix — feasibility probe for the pipeline-overridable-constant (`override`) route.
//
// NOT a gate. This page answers, with device numbers, the question the G-6 fix depends on:
//
//   is creating a pipeline with a NEW `override` VALUE on an ALREADY-PARSED module cheaper than
//   creating a pipeline from a NEW module text?
//
// Four workloads, same timing discipline as `../../g6-variants/driver.js` (the budgeted number is
// the *total* cost including the `popErrorScope` validation round trip, because that is what one
// more variant actually costs):
//
//   `trivial`   — a ~6-line WGSL pair, fresh text per sample: the platform's per-pipeline floor.
//                 Without this control a constant per-pipeline cost would be misread as "shader size".
//   `freshModuleNewText`  — the real emitted pair with a new comment salt per sample (what today's
//                 variants cost: every new define combination is a new module text).
//   `cachedModuleNewOverride` — the real emitted pair, module created ONCE, one pipeline per
//                 distinct `override` value (what the fix would make a new variant cost).
//   `cachedModuleSameOverride` — same module, same override, repeatedly: the pure pipeline-creation
//                 cost with no specialisation change (the lower bound of the route).
//
// Every `createShaderModule` call is counted, and the module text hash is recorded, so "the module is
// parsed once" is *counted*, not asserted.
// ============================================================================================

const report = {
  ready: false,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  adapter: null,
  preferredFormat: null,
  errors: [],
  pages: [],
  measurements: null,
};

globalThis.__probe = report;

const note = (message) => report.pages.push(`${new Date().toISOString()} ${message}`);

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url} -> HTTP ${response.status}`);
  return await response.json();
}

function histogram(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted.length === 0 ? 0 : sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    mean: sorted.length === 0 ? 0 : total / sorted.length,
    totalMs: total,
  };
}

/** Short deterministic hash of a module text (identity of what the driver had to parse). */
function textHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv-${(hash >>> 0).toString(16)}`;
}

async function main() {
  let shaderModuleCalls = 0;
  try {
    const inputUrl = new URLSearchParams(globalThis.location.search).get("input");
    const input = await fetchJson(inputUrl);
    note(`input ${inputUrl}`);

    const adapter = await globalThis.navigator.gpu.requestAdapter();
    if (adapter === null) throw new Error("requestAdapter() returned null");
    const info = adapter.info ?? {};
    report.adapter = { vendor: info.vendor ?? null, architecture: info.architecture ?? null, hasInfo: typeof info.vendor === "string" && info.vendor.length > 0 };
    const device = await adapter.requestDevice();
    report.preferredFormat = globalThis.navigator.gpu.getPreferredCanvasFormat();
    device.addEventListener?.("uncapturederror", (event) => report.errors.push({ uncaptured: event.error?.message ?? String(event.error) }));

    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [device.createBindGroupLayout({ entries: input.layoutEntries })] });
    const format = report.preferredFormat;
    const samples = input.samples ?? 16;

    // Load the requested module texts out of the G-5 chunk files.
    const wanted = new Set(input.wantedKeys);
    const modules = new Map();
    for (const chunkUrl of input.chunks) {
      for (const group of await fetchJson(chunkUrl)) {
        if (!wanted.has(group.key)) continue;
        modules.set(group.key, group);
        wanted.delete(group.key);
      }
      if (wanted.size === 0) break;
    }
    if (modules.size !== input.wantedKeys.length) throw new Error(`loaded ${modules.size}/${input.wantedKeys.length} module pair(s)`);
    note(`loaded ${modules.size} representative module pair(s)`);

    /**
     * One timed unit: optional `createShaderModule` calls + one `createRenderPipeline` + the
     * validation round trip. `constants` are the pipeline-overridable values for this pipeline.
     */
    async function timePipeline({ vertexWgsl, fragmentWgsl, vertexModule: prebuiltVertex, fragmentModule: prebuiltFragment, constants, attributes }) {
      const started = performance.now();
      device.pushErrorScope("validation");
      let vertexModule = prebuiltVertex;
      let fragmentModule = prebuiltFragment;
      if (vertexWgsl !== null && vertexWgsl !== undefined) {
        vertexModule = device.createShaderModule({ code: vertexWgsl });
        shaderModuleCalls += 1;
      }
      if (fragmentWgsl !== null && fragmentWgsl !== undefined) {
        fragmentModule = device.createShaderModule({ code: fragmentWgsl });
        shaderModuleCalls += 1;
      }
      const syncMs = performance.now() - started;
      device.pushErrorScope("validation");
      let thrown = null;
      try {
        const pipeline = device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: { module: vertexModule, entryPoint: "vs_main", buffers: attributes.length === 0 ? [] : [{ arrayStride: attributes[0].stride, attributes: attributes.map((attribute) => ({ shaderLocation: attribute.location, offset: attribute.offset, format: attribute.format })) }] },
          fragment: { module: fragmentModule, entryPoint: "fs_main", targets: [{ format }], ...(constants === undefined ? {} : { constants }) },
          primitive: { topology: "triangle-list" },
        });
        pipeline.destroy?.();
      } catch (error) {
        thrown = `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
      }
      const pipelineSyncMs = performance.now() - started - syncMs;
      const pipelineError = await device.popErrorScope();
      const moduleError = await device.popErrorScope();
      return { totalMs: performance.now() - started, syncMs, pipelineSyncMs, ok: thrown === null && pipelineError === null && moduleError === null, error: thrown ?? pipelineError?.message ?? moduleError?.message ?? null };
    }

    // ---- workload 1: trivial module pair, fresh text per sample (platform floor) ------------------
    const trivialVertex = [
      "@vertex fn vs_main(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {",
      "  return vec4<f32>(f32((index << 1u) & 2u) * 2.0 - 1.0, f32(index & 2u) * 2.0 - 1.0, 0.0, 1.0);",
      "}",
    ].join("\n");
    const trivialFragmentBase = ["@fragment fn fs_main() -> @location(0) vec4<f32> {", "  return vec4<f32>(0.25, 0.5, 0.75, 1.0);", "}"].join("\n");
    const trivial = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const outcome = await timePipeline({
        vertexWgsl: `// trivial salt ${sample}\n${trivialVertex}`,
        fragmentWgsl: `// trivial salt ${sample}\n${trivialFragmentBase}`,
        attributes: [],
      });
      trivial.push(outcome.totalMs);
      if (!outcome.ok) report.errors.push({ workload: "trivial", sample, error: outcome.error });
    }

    // ---- the real emitted pair ---------------------------------------------------------------------
    const representative = modules.get(input.wantedKeys[0]);
    const attributes = representative.attributes ?? [];

    // ---- workload 2: the real pair, NEW module text per sample (today's per-variant cost) ---------
    const freshModuleNewText = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const outcome = await timePipeline({
        vertexWgsl: `// fresh-module salt ${sample}\n${representative.vertexWgsl}`,
        fragmentWgsl: `// fresh-module salt ${sample}\n${representative.fragmentWgsl}`,
        attributes,
      });
      freshModuleNewText.push(outcome.totalMs);
      if (!outcome.ok) report.errors.push({ workload: "freshModuleNewText", sample, error: outcome.error });
    }

    // ---- workload 3/4: one module, many pipelines with different `override` values ----------------
    // The probe declares its own pipeline-overridable constants and *uses* them, so the value really
    // changes the generated code (an unused override can be optimised away and would flatter the route).
    const overrideDeclaration = [
      "// probe: pipeline-overridable constants (G-6 fix feasibility)",
      "override probeChainLength : u32 = 0u;",
      "override probeSelector : u32 = 0u;",
    ].join("\n");
    const overrideUse = [
      "  var probeAccumulator = 0.0;",
      "  for (var probeIndex = 0u; probeIndex < 8u; probeIndex = probeIndex + 1u) {",
      "    if (probeIndex < probeChainLength) { probeAccumulator = probeAccumulator + f32(probeIndex) * 0.125; }",
      "  }",
      "  if (probeSelector == 0xFFFFFFFFu) { return vec4<f32>(probeAccumulator); }",
    ].join("\n");
    const instrumentedFragment = representative.fragmentWgsl.replace(
      /@fragment\s*\nfn fs_main\(([^)]*)\)\s*->\s*@location\(0\)\s*vec4<f32>\s*\{/,
      (match) => `${match}\n${overrideUse}`,
    );
    if (instrumentedFragment === representative.fragmentWgsl) throw new Error("the probe could not instrument fs_main (pattern not found)");
    const instrumentedFragmentWgsl = `${overrideDeclaration}\n${instrumentedFragment}`;
    const instrumentedVertexWgsl = `${overrideDeclaration}\n${representative.vertexWgsl}`;

    const cachedVertexModuleKey = textHash(instrumentedVertexWgsl);
    const cachedFragmentModuleKey = textHash(instrumentedFragmentWgsl);
    const vertexModule = device.createShaderModule({ code: instrumentedVertexWgsl });
    const fragmentModule = device.createShaderModule({ code: instrumentedFragmentWgsl });
    shaderModuleCalls += 2;

    // Warm both modules so the workload measures *specialisation*, not first-parse (the count of
    // `createShaderModule` calls above is what proves the modules are parsed once).
    const warm = await timePipeline({ vertexModule, fragmentModule, attributes, constants: { probeChainLength: 0, probeSelector: 0 } });
    if (!warm.ok) report.errors.push({ workload: "overrideWarmup", error: warm.error });

    const cachedModuleNewOverride = [];
    const overrideValues = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const chainLength = (sample % 8) + 1;
      const selector = sample % 2 === 0 ? 0 : 1;
      const constants = { probeChainLength: chainLength, probeSelector: selector };
      const started = performance.now();
      device.pushErrorScope("validation");
      device.pushErrorScope("validation");
      let thrown = null;
      try {
        device
          .createRenderPipeline({
            layout: pipelineLayout,
            vertex: { module: vertexModule, entryPoint: "vs_main", buffers: attributes.length === 0 ? [] : [{ arrayStride: attributes[0].stride, attributes: attributes.map((attribute) => ({ shaderLocation: attribute.location, offset: attribute.offset, format: attribute.format })) }] },
            fragment: { module: fragmentModule, entryPoint: "fs_main", targets: [{ format }], constants },
            primitive: { topology: "triangle-list" },
          })
          .destroy?.();
      } catch (error) {
        thrown = `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
      }
      const pipelineError = await device.popErrorScope();
      const moduleError = await device.popErrorScope();
      const outcome = { totalMs: performance.now() - started, ok: thrown === null && pipelineError === null && moduleError === null, error: thrown ?? pipelineError?.message ?? moduleError?.message ?? null };
      cachedModuleNewOverride.push(outcome.totalMs);
      overrideValues.push(constants);
      if (!outcome.ok) report.errors.push({ workload: "cachedModuleNewOverride", sample, constants, error: outcome.error });
    }

    const cachedModuleSameOverride = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const started = performance.now();
      device.pushErrorScope("validation");
      device.pushErrorScope("validation");
      let thrown = null;
      try {
        device
          .createRenderPipeline({
            layout: pipelineLayout,
            vertex: { module: vertexModule, entryPoint: "vs_main", buffers: attributes.length === 0 ? [] : [{ arrayStride: attributes[0].stride, attributes: attributes.map((attribute) => ({ shaderLocation: attribute.location, offset: attribute.offset, format: attribute.format })) }] },
            fragment: { module: fragmentModule, entryPoint: "fs_main", targets: [{ format }], constants: { probeChainLength: 3, probeSelector: 1 } },
            primitive: { topology: "triangle-list" },
          })
          .destroy?.();
      } catch (error) {
        thrown = `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
      }
      const pipelineError = await device.popErrorScope();
      const moduleError = await device.popErrorScope();
      const outcome = { totalMs: performance.now() - started, ok: thrown === null && pipelineError === null && moduleError === null, error: thrown ?? pipelineError?.message ?? moduleError?.message ?? null };
      cachedModuleSameOverride.push(outcome.totalMs);
      if (!outcome.ok) report.errors.push({ workload: "cachedModuleSameOverride", sample, error: outcome.error });
    }

    report.measurements = {
      representative: { key: representative.key, vertexBytes: representative.vertexWgsl.length, fragmentBytes: representative.fragmentWgsl.length, attributes: attributes.length },
      moduleIdentity: { vertexModuleKey: cachedVertexModuleKey, fragmentModuleKey: cachedFragmentModuleKey, shaderModuleCallsTotal: shaderModuleCalls, note: "the probe declares its override-bearing modules exactly once; only the trivial/fresh-module workloads create new modules per sample" },
      samples,
      overrideValues,
      trivial: histogram(trivial),
      freshModuleNewText: histogram(freshModuleNewText),
      cachedModuleNewOverride: histogram(cachedModuleNewOverride),
      cachedModuleSameOverride: histogram(cachedModuleSameOverride),
    };
    note(
      `trivial p50=${histogram(trivial).p50.toFixed(2)}ms; fresh module p50=${histogram(freshModuleNewText).p50.toFixed(2)}ms; ` +
        `cached module + new override p50=${histogram(cachedModuleNewOverride).p50.toFixed(2)}ms; cached module + same override p50=${histogram(cachedModuleSameOverride).p50.toFixed(2)}ms`,
    );
  } catch (error) {
    report.errors.push({ fatal: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`, stack: error?.stack ?? null });
  } finally {
    report.finishedAt = new Date().toISOString();
    report.ready = true;
  }
}

main();
