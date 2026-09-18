// ============================================================================================
// G-5 gate — in-page WebGPU probe (tasks.md T022/T023).
//
// Two modes, both driven by `tools/shader-verify.mjs`:
//
//   "sweep" — for every **distinct emitted module pair** of the MVP-reachable define matrix:
//             `createShaderModule` (both stages) + `createRenderPipeline`, with validation error
//             scopes around both. A module pair that fails anywhere is reported with its
//             diagnostics; the runner turns that into a gate failure.
//
//   "mvp"   — the golden configuration, rendered: real vertex buffer from the fixed terrain scene,
//             the uniform struct written strictly through the CPU layout table (H-4), an explicit
//             bind group, a draw, and a readback assertion. This is the productised form of the
//             spike's `webgpu-harness.mjs` path B (`experiments/shader-spike/REPORT.md` §4).
//
// Results are published on `globalThis.__g5`; the runner polls `__g5.ready`.
// ============================================================================================

const report = {
  ready: false,
  mode: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  adapter: null,
  device: null,
  preferredFormat: null,
  errors: [],
  sweep: null,
  mvp: null,
  pages: [],
};

globalThis.__g5 = report;

function note(message) {
  report.pages.push(`${new Date().toISOString()} ${message}`);
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url} -> HTTP ${response.status}`);
  return await response.text();
}

async function compilationMessages(module) {
  const info = typeof module.getCompilationInfo === "function" ? await module.getCompilationInfo() : typeof module.compilationInfo === "function" ? await module.compilationInfo() : null;
  if (info === null) return { messages: [], unavailable: true };
  return {
    messages: [...info.messages].map((entry) => ({
      type: entry.type,
      lineNum: entry.lineNum,
      linePos: entry.linePos,
      message: entry.message,
    })),
    unavailable: false,
  };
}

const VERTEX_FORMAT_SIZE = { float32: 4, float32x2: 8, float32x3: 12, float32x4: 16, uint32: 4, uint32x2: 8, uint32x3: 12, uint32x4: 16, sint32: 4 };

function vertexBufferLayout(attributes) {
  // The layout is derived on the Node side (`attributeLayoutFromDerivation`, upstream TerrainEncoding
  // offsets), never invented here: the pipeline MUST be created with the attribute layout the real
  // terrain path uses.
  const stride = attributes[0]?.stride ?? Math.max(...attributes.map((attribute) => attribute.offset + (VERTEX_FORMAT_SIZE[attribute.format] ?? 16)));
  return {
    arrayStride: stride,
    attributes: attributes.map((attribute) => ({ shaderLocation: attribute.location, offset: attribute.offset, format: attribute.format })),
  };
}

/** Compile one module pair and create the pipeline; returns a structured result. */
async function compileAndCreatePipeline(device, { vertexWgsl, fragmentWgsl, vertexModule: prebuiltVertex = null, fragmentModule: prebuiltFragment = null, attributes, vertexConstants = null, fragmentConstants = null, constants = null, format, label }) {
  const result = { label, vertex: null, fragment: null, pipeline: null, ok: false };
  const reused = prebuiltVertex !== null && prebuiltFragment !== null;
  device.pushErrorScope("validation");
  const vertexModule = prebuiltVertex ?? device.createShaderModule({ code: vertexWgsl, label: `${label}-vs` });
  const fragmentModule = prebuiltFragment ?? device.createShaderModule({ code: fragmentWgsl, label: `${label}-fs` });
  const scopeErrors = [];
  const firstError = await device.popErrorScope();
  if (firstError !== null) scopeErrors.push(`module creation: ${firstError.message}`);
  // Compilation messages are per module: re-derive them only for a freshly created module, and report
  // the cached verdict (recorded once per module text) when the module was reused.
  result.vertex = reused ? { cached: true, messages: [] } : await compilationMessages(vertexModule);
  result.fragment = reused ? { cached: true, messages: [] } : await compilationMessages(fragmentModule);
  if (result.vertex.messages.some((message) => message.type === "error")) scopeErrors.push("vertex module reported error messages");
  if (result.fragment.messages.some((message) => message.type === "error")) scopeErrors.push("fragment module reported error messages");

  device.pushErrorScope("validation");
  let pipeline = null;
  let pipelineError = null;
  try {
    pipeline = device.createRenderPipeline({
      layout: "auto",
      label: `${label}-pipeline`,
      vertex: { module: vertexModule, entryPoint: "vs_main", buffers: attributes.length === 0 ? [] : [vertexBufferLayout(attributes)], ...((vertexConstants ?? constants) === null ? {} : { constants: vertexConstants ?? constants }) },
      fragment: { module: fragmentModule, entryPoint: "fs_main", targets: [{ format }], ...((fragmentConstants ?? constants) === null ? {} : { constants: fragmentConstants ?? constants }) },
      primitive: { topology: "triangle-list" },
    });
  } catch (error) {
    pipelineError = `${error.name ?? "Error"}: ${error.message ?? String(error)}`;
  }
  const pipelineScopeError = await device.popErrorScope();
  if (pipelineScopeError !== null) pipelineError = pipelineError ?? pipelineScopeError.message;
  result.pipelineError = pipelineError;
  result.pipeline = pipeline === null ? null : "created";
  result.reusedModules = reused;
  result.ok = scopeErrors.length === 0 && pipelineError === null && result.vertex.messages.every((message) => message.type !== "error") && result.fragment.messages.every((message) => message.type !== "error");
  result.scopeErrors = scopeErrors;
  if (pipeline !== null) pipeline.destroy?.();
  return result;
}

/** Negative control: intentionally remove a vertex output the fragment stage still reads (spike E1). */
function unpairedControlVariant(vertexWgsl, pairedName) {
  const declaration = new RegExp(`\\s*@location\\(\\d+\\)\\s+${pairedName}\\s*:\\s*[^,]+,\\n`, "m");
  const assignment = new RegExp(`^\\s*out\\.${pairedName}\\s*=[^;]*;\\s*$\\n?`, "m");
  const withoutDeclaration = vertexWgsl.replace(declaration, "\n");
  return {
    broken: withoutDeclaration.replace(assignment, ""),
    removed: declaration.test(vertexWgsl) && assignment.test(vertexWgsl),
  };
}

async function runSweep(device, input, format) {
  const started = Date.now();
  const results = [];
  const chunks = input.chunks ?? [];
  // The sweep walks the **reachable define combinations** (rows), not the distinct module texts: a
  // variant's identity is its module pair *plus its pipeline-constant values* (G-6/T025), so each
  // combination gets its own pipeline with its own `constants`, while the module text is parsed once
  // per distinct pair and reused. This is strictly stronger than the previous one-pipeline-per-text
  // sweep and it is also cheaper (768 pipelines over 128 parses instead of 768 parses).
  const index = await (await fetch(input.groupsUrl)).json();
  const rows = index.rows ?? [];
  const groupsByKey = new Map();
  const moduleCache = new Map();
  let moduleCompilations = 0;
  let failed = 0;
  let processed = 0;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    for (const group of await (await fetch(chunks[chunkIndex])).json()) groupsByKey.set(group.key, group);
  }

  for (const row of rows) {
    const group = groupsByKey.get(row.group);
    if (group === undefined) {
      failed += 1;
      report.errors.push({ row: row.id, missingGroup: row.group });
      continue;
    }
    let cached = moduleCache.get(row.group);
    if (cached === undefined) {
      cached = {
        vertexModule: device.createShaderModule({ code: group.vertexWgsl, label: `${row.group}-vs` }),
        fragmentModule: device.createShaderModule({ code: group.fragmentWgsl, label: `${row.group}-fs` }),
        verdict: null,
      };
      moduleCompilations += 2;
      moduleCache.set(row.group, cached);
    }
    const outcome = await compileAndCreatePipeline(device, {
      vertexWgsl: group.vertexWgsl,
      fragmentWgsl: group.fragmentWgsl,
      vertexModule: cached.vertexModule,
      fragmentModule: cached.fragmentModule,
      attributes: row.attributes ?? group.attributes,
      constants: row.overrides,
      format,
      label: row.id,
    });
    if (cached.verdict === null) cached.verdict = outcome.ok;
    if (!outcome.ok) {
      failed += 1;
      report.errors.push({ row: row.id, group: row.group, overrides: row.overrides, diagnostics: outcome });
    }
    processed += 1;
    // Keep memory bounded: only the tally plus the failure detail is retained per row.
    results.push({
      index: processed - 1,
      id: row.id,
      key: row.group,
      overrides: row.overrides,
      ok: outcome.ok,
      reusedModules: outcome.reusedModules === true,
      pipelineError: outcome.pipelineError,
      vertexErrors: outcome.vertex.messages.filter((message) => message.type === "error").length,
      fragmentErrors: outcome.fragment.messages.filter((message) => message.type === "error").length,
    });
    if (processed % 128 === 0) {
      note(`sweep ${processed}/${rows.length} combination(s), ${failed} failure(s), ${((Date.now() - started) / 1000).toFixed(1)}s`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  // Negative control: a deliberately unpaired varying MUST fail pipeline creation (spike E1).
  let negativeControl = { ran: false };
  if (input.negativeControl !== null && input.negativeControl !== undefined) {
    const vertexWgsl = await fetchText(input.negativeControl.vertexUrl);
    const fragmentWgsl = await fetchText(input.negativeControl.fragmentUrl);
    const broken = unpairedControlVariant(vertexWgsl, input.negativeControl.varying);
    const outcome = await compileAndCreatePipeline(device, {
      vertexWgsl: broken.broken,
      fragmentWgsl,
      attributes: input.negativeControl.attributes,
      constants: input.negativeControl.constants ?? null,
      format,
      label: "negative-control-unpaired-varying",
    });
    negativeControl = {
      ran: true,
      removed: broken.removed,
      varying: input.negativeControl.varying,
      ok: outcome.ok,
      pipelineError: outcome.pipelineError,
      vertexErrorCount: outcome.vertex.messages.filter((message) => message.type === "error").length,
    };
  }

  report.sweep = {
    groupCount: rows.length,
    combinationCount: rows.length,
    distinctModuleTexts: moduleCache.size,
    moduleCompilations,
    distinctVariantPipelines: new Set(rows.map((row) => `${row.group}#${JSON.stringify(row.overrides)}`)).size,
    failed,
    elapsedMs: Date.now() - started,
    results,
    negativeControl,
  };
}

/** Harness self-test: a full-screen triangle with a constant colour, through the same readback path. */
const SELF_TEST_WGSL = {
  vertex: `@vertex fn vs_main(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}`,
  fragment: `@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(0.25, 0.5, 0.75, 1.0); }`,
};

async function runMvp(device, input, format) {
  const cases = [];
  for (const testCase of input.cases) {
    const vertexWgsl = await fetchText(testCase.vertexUrl);
    const fragmentWgsl = await fetchText(testCase.fragmentUrl);
    const outcome = await compileAndCreatePipeline(device, {
      vertexWgsl,
      fragmentWgsl,
      attributes: testCase.attributes,
      // `constants` are per **stage** in WebGPU, and each key MUST be declared by that stage's module.
      // Both emitted stages declare the two overrides (G-6/T025), so both get the variant's values.
      vertexConstants: testCase.constants ?? null,
      fragmentConstants: testCase.constants ?? null,
      format,
      label: testCase.id,
    });
    const entry = { id: testCase.id, compile: outcome, draw: null, vertexOnlyDraw: null };
    if (outcome.ok) {
      entry.draw = await drawAndReadback(device, { ...testCase, vertexWgsl, fragmentWgsl }, format, { vertex: testCase.constants ?? null, fragment: testCase.constants ?? null });
      // Geometry-coverage probe: the same vertex stage with a constant-colour fragment stage. If the
      // textured frame is black while this one is not, the difference is inside the fragment stage.
      // The replacement fragment module declares none of the overrides, so it MUST be given none.
      entry.vertexOnlyDraw = await drawAndReadback(device, { ...testCase, vertexWgsl, fragmentWgsl: testCase.constantFragmentWgsl }, format, { vertex: testCase.constants ?? null, fragment: null });
    }
    cases.push(entry);
  }
  report.mvp = { cases };
}

/** Render the fixed scene with the given modules and read the frame back. */
async function drawAndReadback(device, testCase, format, stageConstants = { vertex: null, fragment: null }) {
  const { scene, samplers } = testCase;
  const hasGeometry = scene.vertexBytes > 0 && scene.indexCount > 0;
  const hasUniforms = scene.uniformBytes > 0 && samplers.length > 0;
  const result = { rendered: false, width: scene.viewport.width, height: scene.viewport.height };

  let vertexBuffer = null;
  let indexBuffer = null;
  let uniformBuffer = null;
  if (hasGeometry) {
    vertexBuffer = device.createBuffer({ size: scene.vertexBytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertexBuffer, 0, new Uint8Array(scene.vertexBytesArray));
    indexBuffer = device.createBuffer({ size: scene.indexBytes, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(indexBuffer, 0, new Uint8Array(scene.indexBytesArray));
  }

  let bindGroupLayout = null;
  let bindGroup = null;
  if (hasUniforms) {
    uniformBuffer = device.createBuffer({ size: scene.uniformBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniformBuffer, 0, new Uint8Array(scene.uniformBytesArray));
    // Explicit bind group layout: the union layout table (G-4) — extra entries are permitted and let
    // the same group layout serve every variant.
    const entries = [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }];
    const resources = [];
    for (const sampler of samplers) {
      const texture = device.createTexture({
        size: [scene.imagery.width, scene.imagery.height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      // `writeTexture` needs a rows-aligned layout; the fixture is tiny, so pad to 256 bytes/row.
      const paddedRow = Math.max(256, scene.imagery.width * 4);
      const padded = new Uint8Array(paddedRow * scene.imagery.height);
      for (let row = 0; row < scene.imagery.height; row += 1) {
        padded.set(new Uint8Array(scene.imagery.rgba).subarray(row * scene.imagery.width * 4, (row + 1) * scene.imagery.width * 4), row * paddedRow);
      }
      device.queue.writeTexture({ texture }, padded, { bytesPerRow: paddedRow }, { width: scene.imagery.width, height: scene.imagery.height });
      const samplerObject = device.createSampler({ magFilter: "linear", minFilter: "linear" });
      entries.push({ binding: sampler.textureBinding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } });
      entries.push({ binding: sampler.samplerBinding, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } });
      resources.push({ texture, sampler: samplerObject, samplerEntry: sampler });
    }
    bindGroupLayout = device.createBindGroupLayout({ entries });
    const bindGroupEntries = [{ binding: 0, resource: { buffer: uniformBuffer } }];
    for (const resource of resources) {
      bindGroupEntries.push({ binding: resource.samplerEntry.textureBinding, resource: resource.texture.createView() });
      bindGroupEntries.push({ binding: resource.samplerEntry.samplerBinding, resource: resource.sampler });
    }
    bindGroup = device.createBindGroup({ layout: bindGroupLayout, entries: bindGroupEntries });
  }

  device.pushErrorScope("validation");
  const vertexModule = device.createShaderModule({ code: testCase.vertexWgsl });
  const fragmentModule = device.createShaderModule({ code: testCase.fragmentWgsl });
  const pipeline = device.createRenderPipeline({
    layout: bindGroupLayout === null ? "auto" : device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: vertexModule, entryPoint: "vs_main", buffers: testCase.attributes.length === 0 ? [] : [vertexBufferLayout(testCase.attributes)], ...(stageConstants.vertex === null ? {} : { constants: stageConstants.vertex }) },
    // The variant's pipeline-overridable constants (G-6/T025). The module's own defaults are the
    // "nothing enabled" state, so omitting them would render the golden configuration with zero
    // imagery layers — the constants are part of the variant, not an optimisation. A replacement
    // fragment module that declares none of them MUST be given none (keys are per stage).
    fragment: { module: fragmentModule, entryPoint: "fs_main", targets: [{ format }], ...(stageConstants.fragment === null ? {} : { constants: stageConstants.fragment }) },
    primitive: { topology: "triangle-list" },
  });
  const renderError = await device.popErrorScope();

  const target = device.createTexture({
    size: [scene.viewport.width, scene.viewport.height],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const bytesPerRow = Math.ceil((scene.viewport.width * 4) / 256) * 256;
  const readback = device.createBuffer({ size: bytesPerRow * scene.viewport.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
  pass.setPipeline(pipeline);
  if (bindGroup !== null) pass.setBindGroup(0, bindGroup);
  if (vertexBuffer !== null) {
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, "uint32");
    pass.drawIndexed(scene.indexCount);
  } else {
    pass.draw(3);
  }
  pass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, { width: scene.viewport.width, height: scene.viewport.height });
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();

  let nonBackground = 0;
  let nonBlack = 0;
  const histogram = new Map();
  for (let index = 0; index < pixels.length; index += 4) {
    const key = `${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
    if (pixels[index] !== 0 || pixels[index + 1] !== 0 || pixels[index + 2] !== 0) nonBlack += 1;
    if (!(pixels[index] === 0 && pixels[index + 1] === 0 && pixels[index + 2] === 0 && pixels[index + 3] === 255)) nonBackground += 1;
  }
  const corner = (x, y) => {
    const offset = y * bytesPerRow + x * 4;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
  };

  return {
    rendered: true,
    renderError: renderError === null ? null : renderError.message,
    totalPixels: (pixels.length / 4) | 0,
    nonBlackPixels: nonBlack,
    nonBackgroundPixels: nonBackground,
    uniqueColors: histogram.size,
    topColors: [...histogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    corners: {
      topLeft: corner(0, 0),
      topRight: corner(scene.viewport.width - 1, 0),
      bottomLeft: corner(0, scene.viewport.height - 1),
      bottomRight: corner(scene.viewport.width - 1, scene.viewport.height - 1),
      center: corner(scene.viewport.width >> 1, scene.viewport.height >> 1),
    },
    /** Raw frame, so the runner can hash / diff it offline without a second render. */
    rgbaBase64: bytesToBase64(pixels),
    bytesPerRow,
  };
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function main() {
  try {
    const inputUrl = new URLSearchParams(globalThis.location.search).get("input");
    const input = await (await fetch(inputUrl)).json();
    report.mode = input.mode;
    note(`input ${inputUrl} mode=${input.mode}`);

    if (globalThis.navigator.gpu === undefined) throw new Error("navigator.gpu is undefined (WebGPU unavailable)");
    const adapter = await globalThis.navigator.gpu.requestAdapter();
    if (adapter === null) throw new Error("requestAdapter() returned null");
    // `GPUAdapterInfo` exposes its fields as getters on the prototype, so it must be copied
    // field by field (JSON.stringify(adapter.info) would serialise to `{}`).
    const info = adapter.info ?? {};
    report.adapter = {
      vendor: info.vendor ?? null,
      architecture: info.architecture ?? null,
      device: info.device ?? null,
      description: info.description ?? null,
      subgroupMinSize: info.subgroupMinSize ?? null,
      subgroupMaxSize: info.subgroupMaxSize ?? null,
      isFallbackAdapter: adapter.isFallbackAdapter ?? null,
      hasInfo: typeof info.vendor === "string" && info.vendor.length > 0,
    };
    const device = await adapter.requestDevice();
    report.preferredFormat = globalThis.navigator.gpu.getPreferredCanvasFormat();
    report.device = {
      limits: {
        maxTextureDimension2D: device.limits.maxTextureDimension2D,
        maxUniformBufferBindingSize: device.limits.maxUniformBufferBindingSize,
        maxBindGroups: device.limits.maxBindGroups,
        maxVertexBuffers: device.limits.maxVertexBuffers,
        maxVertexAttributes: device.limits.maxVertexAttributes,
      },
    };
    device.addEventListener?.("uncapturederror", (event) => report.errors.push({ uncaptured: event.error?.message ?? String(event.error) }));
    note(`adapter ${JSON.stringify(report.adapter)} preferredFormat=${report.preferredFormat}`);

    if (input.mode === "sweep") await runSweep(device, input, report.preferredFormat);
    else if (input.mode === "mvp") {
      // Harness self-test first: if this cannot produce a non-black frame, a black terrain frame
      // would say nothing about the emitted WGSL.
      report.selfTest = await compileAndCreatePipeline(device, { vertexWgsl: SELF_TEST_WGSL.vertex, fragmentWgsl: SELF_TEST_WGSL.fragment, attributes: [], format: report.preferredFormat, label: "harness-self-test" });
      if (report.selfTest.ok) {
        report.selfTest.draw = await drawAndReadback(
          device,
          {
            vertexWgsl: SELF_TEST_WGSL.vertex,
            fragmentWgsl: SELF_TEST_WGSL.fragment,
            attributes: [],
            scene: input.selfTestScene,
            layout: { structName: "None", members: [] },
            samplers: [],
          },
          report.preferredFormat,
        );
      }
      await runMvp(device, input, report.preferredFormat);
    } else throw new Error(`unknown mode "${input.mode}"`);
  } catch (error) {
    report.errors.push({ fatal: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`, stack: error?.stack ?? null });
  } finally {
    report.finishedAt = new Date().toISOString();
    report.ready = true;
  }
}

main();
