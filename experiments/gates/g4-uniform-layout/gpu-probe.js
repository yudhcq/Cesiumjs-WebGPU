/**
 * G-4 gate in-page probe (tasks.md T019b) — the real-device half of the uniform-layout assertion.
 *
 * Input: `/experiments/gates/out/g4-gpu-input.json`, written by `run-gpu.mjs`:
 *   - `wgsl`            the generated struct + bindings + verification fragment shader (one pixel per
 *                       uniform slot: pixel x -> slot x);
 *   - `members`/`slots` the CPU-side layout table (offsets, strides, sizes);
 *   - `plans`           explicit byte-write plans (`{byteOffset, scalar, value}[]`) produced by the
 *                       **Node-side** layout generator, so the browser never re-derives a layout;
 *   - `expectedSlots`   the RGBA values the GPU MUST return for the baseline plan.
 *
 * Protocol (all four steps are evidence, not decoration):
 *   1. `getCompilationInfo()` on the shader module and an error scope around pipeline creation
 *      (a WGSL/naga error would otherwise be silent);
 *   2. baseline: write plan 0 -> render -> read back -> the readback MUST equal `expectedSlots`
 *      (this is where a wrong byteOffset/arrayStride/columnStride/padding shows up);
 *   3. control: write plan 0 twice -> **zero** changed slots (proves the comparison can say "no change");
 *   4. perturbation matrix: for every struct member, write the baseline plan with that member's values
 *      changed -> the set of changed slots MUST be exactly that member's slots (proves every uniform is
 *      actually read at the offset the table claims).
 */

// The input document is normally the gate's own `g4-gpu-input.json`; the negative control points the
// page at its own corrupted-plan document (`?input=…`) so both runs use the identical code path.
const INPUT_URL = new URLSearchParams(globalThis.location.search).get("input") ?? "/experiments/gates/out/g4-gpu-input.json";

const report = {
  startedAt: new Date().toISOString(),
  adapter: null,
  preferredFormat: null,
  device: null,
  compilation: null,
  pipeline: null,
  baseline: null,
  control: null,
  perturbations: null,
  errors: [],
};

function serialiseError(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 4).join("\n") : null };
}

/** Write a byte plan into the uniform staging buffer (little-endian, typed by the layout table). */
function writePlan(view, plan) {
  for (const entry of plan) {
    if (entry.scalar === "f32") view.setFloat32(entry.byteOffset, entry.value / 255, true);
    else if (entry.scalar === "i32") view.setInt32(entry.byteOffset, entry.value, true);
    else view.setUint32(entry.byteOffset, entry.value, true);
  }
}

async function readSlots(device, texture, slotCount, bytesPerRow) {
  const readback = device.createBuffer({ size: bytesPerRow, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow }, { width: slotCount, height: 1 });
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = Array.from(new Uint8Array(readback.getMappedRange().slice(0, slotCount * 4)));
  readback.unmap();
  readback.destroy();
  return bytes;
}

function render(device, pipeline, bindGroup, textureView, plan, view, staging) {
  writePlan(view, plan.plan);
  device.queue.writeBuffer(staging.uniformBuffer, 0, view.buffer, 0, staging.buffer.byteLength);
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: textureView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

async function run() {
  const input = await (await fetch(INPUT_URL)).json();
  const canvas = document.getElementById("g4-canvas");
  canvas.width = input.slotCount;
  canvas.height = 1;
  canvas.style.width = `${Math.min(input.slotCount, 900)}px`;
  canvas.style.height = "40px";

  const gpu = navigator.gpu;
  if (gpu === undefined || gpu === null) throw new Error("G-4 probe: navigator.gpu is unavailable");
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (adapter === null) throw new Error("G-4 probe: requestAdapter() returned null");
  const info = adapter.info ?? {};
  report.adapter = { vendor: info.vendor ?? null, architecture: info.architecture ?? null, device: info.device ?? null, description: info.description ?? null };
  report.preferredFormat = gpu.getPreferredCanvasFormat();
  const device = await adapter.requestDevice();
  report.device = {
    limits: {
      maxUniformBufferBindingSize: device.limits.maxUniformBufferBindingSize,
      maxBindingsPerBindGroup: device.limits.maxBindingsPerBindGroup,
      maxColorAttachments: device.limits.maxColorAttachments,
    },
    features: [...device.features],
  };

  // ---- 1. compile the generated WGSL ------------------------------------------------------------
  const module = device.createShaderModule({ code: input.wgsl, label: "g4-generated-uniform-layout" });
  const compilation = await module.getCompilationInfo();
  report.compilation = {
    messages: compilation.messages.map((message) => ({ type: message.type, lineNum: message.lineNum, linePos: message.linePos, message: message.message })),
    errors: compilation.messages.filter((message) => message.type === "error").length,
    warnings: compilation.messages.filter((message) => message.type === "warning").length,
  };

  const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
  device.pushErrorScope("validation");
  const texture = device.createTexture({ size: { width: input.slotCount, height: 1 }, format: "rgba8unorm", usage });
  const textureView = texture.createView();

  // ---- explicit bind group layout: exactly the bindings the generator declared ------------------
  // (`layout: "auto"` would DROP the bindings the verification shader never samples, so the bind group
  //  — and with it this whole assertion — would no longer reflect the generated binding plan.)
  const FRAGMENT = GPUShaderStage.FRAGMENT;
  const layoutEntries = [{ binding: 0, visibility: FRAGMENT, buffer: { type: "uniform" } }];
  for (const samplerEntry of input.samplers) {
    const isCube = /cube/.test(samplerEntry.textureType);
    layoutEntries.push({ binding: samplerEntry.textureBinding, visibility: FRAGMENT, texture: { sampleType: "float", viewDimension: isCube ? "cube" : "2d" } });
    layoutEntries.push({ binding: samplerEntry.samplerBinding, visibility: FRAGMENT, sampler: { type: "filtering" } });
  }
  const bindGroupLayout = device.createBindGroupLayout({ entries: layoutEntries, label: "g4-generated-layout" });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list" },
  });

  const uniformBuffer = device.createBuffer({ size: input.bufferBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const staging = { buffer: new ArrayBuffer(input.bufferBytes), uniformBuffer };
  const view = new DataView(staging.buffer);

  // ---- sampler bindings (1x1 stand-ins; the verification shader never samples them) --------------
  const bindGroupEntries = [{ binding: 0, resource: { buffer: uniformBuffer } }];
  const sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
  for (const samplerEntry of input.samplers) {
    const isCube = /cube/.test(samplerEntry.textureType);
    const textureUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    const stand = isCube
      ? device.createTexture({ size: { width: 1, height: 1, depthOrArrayLayers: 6 }, format: "rgba8unorm", usage: textureUsage })
      : device.createTexture({ size: { width: 1, height: 1 }, format: "rgba8unorm", usage: textureUsage });
    bindGroupEntries.push({ binding: samplerEntry.textureBinding, resource: isCube ? stand.createView({ dimension: "cube" }) : stand.createView() });
    bindGroupEntries.push({ binding: samplerEntry.samplerBinding, resource: sampler });
  }
  const bindGroup = device.createBindGroup({ layout: bindGroupLayout, entries: bindGroupEntries });
  report.pipeline = {
    bindGroupEntryCount: bindGroupEntries.length,
    declaredBindingCount: layoutEntries.length,
    samplerBindings: input.samplers.length,
    structSize: input.structSize,
    bufferBytes: input.bufferBytes,
    slotCount: input.slotCount,
    targetFormat: "rgba8unorm",
  };
  const scoped = await device.popErrorScope();
  report.pipeline.validationError = scoped?.message ?? null;

  const bytesPerRow = Math.ceil((input.slotCount * 4) / 256) * 256;

  // ---- 2. baseline -------------------------------------------------------------------------------
  render(device, pipeline, bindGroup, textureView, input.plans.baseline, view, staging);
  const baselineBytes = await readSlots(device, texture, input.slotCount, bytesPerRow);
  const mismatches = [];
  for (const expected of input.expectedSlots) {
    for (let component = 0; component < 4; component += 1) {
      const actual = baselineBytes[expected.index * 4 + component];
      const wanted = expected.rgba[component];
      if (actual !== wanted) mismatches.push({ slot: expected.index, member: expected.member, element: expected.element, column: expected.column, component, expected: wanted, actual });
    }
  }
  report.baseline = { mismatches, mismatchCount: mismatches.length, slotCount: input.slotCount, bytes: baselineBytes };

  // ---- 3. control: writing the same plan twice MUST change nothing -------------------------------
  render(device, pipeline, bindGroup, textureView, input.plans.baseline, view, staging);
  const controlBytes = await readSlots(device, texture, input.slotCount, bytesPerRow);
  const controlChanged = [];
  for (let index = 0; index < baselineBytes.length; index += 1) if (baselineBytes[index] !== controlBytes[index]) controlChanged.push(Math.floor(index / 4));
  report.control = { changedSlots: [...new Set(controlChanged)], note: "same plan written twice: the comparison MUST report zero changed slots" };

  // ---- 4. perturbation matrix --------------------------------------------------------------------
  const perturbations = [];
  for (const perturbation of input.perturbations) {
    render(device, pipeline, bindGroup, textureView, perturbation.plan, view, staging);
    const bytes = await readSlots(device, texture, input.slotCount, bytesPerRow);
    const changed = [];
    for (let index = 0; index < baselineBytes.length; index += 1) if (baselineBytes[index] !== bytes[index]) changed.push(Math.floor(index / 4));
    const changedSlots = [...new Set(changed)];
    perturbations.push({
      member: perturbation.member,
      expectedSlots: perturbation.expectedSlots,
      changedSlots,
      exact: changedSlots.length === perturbation.expectedSlots.length && changedSlots.every((slot) => perturbation.expectedSlots.includes(slot)),
      unidentified: changedSlots.filter((slot) => !perturbation.expectedSlots.includes(slot)),
      silent: perturbation.expectedSlots.filter((slot) => !changedSlots.includes(slot)),
    });
  }
  report.perturbations = perturbations;

  return report;
}

globalThis.__g4 = { ready: false, report: null, error: null };
try {
  const result = await run();
  report.finishedAt = new Date().toISOString();
  globalThis.__g4 = { ready: true, report: result, error: null };
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.errors.push(serialiseError(error));
  globalThis.__g4 = { ready: true, report, error: serialiseError(error) };
}
