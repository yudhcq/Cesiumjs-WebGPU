/**
 * Contract-suite page driver (`层=契约`) — tasks.md T043/T044/T047/T050/T051.
 *
 * Runs inside the browser, one backend per page load (principle II). The page:
 *   1. installs **platform-level instrumentation** before the bundle is imported: every
 *      `canvas.getContext("webgl2"|"webgl")` request and every WebGL2 object-creating call is counted.
 *      That counter is the evidence for "in this run the other backend created 0 GPU objects";
 *   2. imports the bundle the runner built (real manifest for `webgpu`, empty manifest for `webgl2`);
 *   3. runs one scenario (`?scenario=`) and publishes `globalThis.__contract`.
 *
 * Nothing here compares two backends inside one session: the page sees exactly one bundle and one
 * `RENDER_BACKEND`, and every cross-backend statement is made offline by the spec/harness from two
 * separate runs.
 */
import { partitionTrace } from "/experiments/gates/g3-pass-trace/partition.mjs";

/**
 * Upstream's engine assets/workers live outside the bundle (the terrain logic layer generates its
 * meshes in a `TaskProcessor` worker and `Transforms` fetches the IAU2006 XYS tables). Pointing
 * `buildModuleUrl` at the served upstream directory keeps every one of those requests same-origin —
 * the offline contract (T087) forbids *external* requests, not local ones. MUST be set before the
 * bundle is imported, because `buildModuleUrl` caches its base on first use.
 */
globalThis.CESIUM_BASE_URL = "/engine/";

const params = new URLSearchParams(globalThis.location.search);
const scenario = params.get("scenario") ?? "backend-core";
const backend = params.get("backend") ?? "webgpu";
const bundleUrl = params.get("bundle") ?? "/artifacts/contract/webgpu/bundle.js";

const report = {
  scenario,
  backend,
  bundleUrl,
  startedAt: new Date().toISOString(),
  environment: null,
  webgl2: null,
  steps: [],
  errors: [],
  result: {},
};

/** Platform-level counters: the *only* thing this page asserts about "the other backend". */
const webgl2Counters = {
  contextRequests: 0,
  contextRequestTypes: [],
  objectsCreated: 0,
  objectsByMethod: {},
  errors: [],
};

/**
 * The mirror image of {@link webgl2Counters}: how often this page touched the **WebGPU** device API.
 * A WebGL2 run MUST leave both counters at zero, which makes "the other backend was not used in this
 * run" a measurement on both sides rather than an assumption (FR-006/FR-011).
 */
const webgpuCounters = {
  adapterRequests: 0,
  deviceRequests: 0,
  errors: [],
};

function instrumentWebgpuSide() {
  const gpu = globalThis.navigator?.gpu;
  if (gpu === undefined) {
    webgpuCounters.errors.push("navigator.gpu is unavailable, so device requests cannot be counted");
    return;
  }
  const originalRequestAdapter = gpu.requestAdapter?.bind(gpu);
  if (typeof originalRequestAdapter === "function") {
    gpu.requestAdapter = (...args) => {
      webgpuCounters.adapterRequests += 1;
      return originalRequestAdapter(...args);
    };
  }
}

function instrumentWebgl2() {
  const proto = globalThis.WebGL2RenderingContext?.prototype;
  if (proto === undefined) {
    webgl2Counters.errors.push("WebGL2RenderingContext is unavailable, so its objects cannot be counted");
  } else {
    for (const name of [
      "createBuffer",
      "createTexture",
      "createFramebuffer",
      "createRenderbuffer",
      "createProgram",
      "createShader",
      "createVertexArray",
      "createSampler",
      "createQuery",
      "createTransformFeedback",
      "fenceSync",
    ]) {
      const original = proto[name];
      if (typeof original !== "function") continue;
      proto[name] = function instrumented(...args) {
        webgl2Counters.objectsCreated += 1;
        webgl2Counters.objectsByMethod[name] = (webgl2Counters.objectsByMethod[name] ?? 0) + 1;
        return original.apply(this, args);
      };
    }
  }

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function instrumented(type, ...rest) {
    const normalised = String(type).toLowerCase();
    if (normalised === "webgl2" || normalised === "webgl" || normalised === "experimental-webgl") {
      webgl2Counters.contextRequests += 1;
      webgl2Counters.contextRequestTypes.push(normalised);
    }
    return originalGetContext.call(this, type, ...rest);
  };
}

function step(name, detail = null) {
  report.steps.push({ name, at: new Date().toISOString(), detail });
}

/** The WGSL the contract workload draws with: a full-screen triangle, no external inputs. */
const TRIANGLE_WGSL = `
@vertex
fn vs_main(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return vec4f(position, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(0.15, 0.55, 0.85, 1.0);
}
`;

const TRIANGLE_VERTICES = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]);
/** Padded to 8 bytes: `queue.writeBuffer` requires a multiple of 4 (the fourth index is unused). */
const TRIANGLE_INDICES = new Uint16Array([0, 1, 2, 0]);

function createTriangleResources(device, format) {
  const module_ = device.createShaderModule({ label: "contract-triangle", code: TRIANGLE_WGSL });
  // WebGPU bakes the sample count **and the depth-stencil state** into the pipeline, so the workload
  // needs one pipeline per (format, sampleCount, depth) triple — exactly what the W4 front-end does
  // through the pipeline cache. `withDepth` matters because the canvas pass carries a depth-stencil
  // attachment (upstream's GL default framebuffer does, and the terrain's depth test needs it, W5),
  // while the offscreen colour-only target of this workload does not: a pipeline whose declared depth
  // state disagrees with the pass is a validation error, not a warning.
  const pipelines = new Map();
  const pipelineFor = (sampleCount, withDepth = true) => {
    const key = `${sampleCount}:${withDepth}`;
    let pipeline = pipelines.get(key);
    if (pipeline === undefined) {
      pipeline = device.createRenderPipeline({
        label: `contract-triangle-samples${sampleCount}${withDepth ? "-depth" : ""}`,
        layout: "auto",
        vertex: {
          module: module_,
          entryPoint: "vs_main",
          buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }],
        },
        fragment: { module: module_, entryPoint: "fs_main", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
        multisample: { count: sampleCount },
        ...(withDepth ? { depthStencil: { format: "depth24plus-stencil8", depthWriteEnabled: true, depthCompare: "less" } } : {}),
      });
      pipelines.set(key, pipeline);
    }
    return pipeline;
  };
  const vertexBuffer = device.createBuffer({ label: "contract-triangle-vertices", size: 48, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vertexBuffer, 0, TRIANGLE_VERTICES);
  const indexBuffer = device.createBuffer({ label: "contract-triangle-indices", size: 8, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(indexBuffer, 0, TRIANGLE_INDICES);
  return { module: module_, pipelineFor, vertexBuffer, indexBuffer };
}

function drawInputsFor(resources, overrides = {}) {
  const sampleCount = overrides.sampleCount ?? 1;
  const withDepth = overrides.withDepth ?? true;
  return {
    shaderProgramId: `contract-triangle-${sampleCount}${withDepth ? "-depth" : ""}`,
    pipeline: resources.pipelineFor(sampleCount, withDepth),
    vertexBuffers: [{ slot: 0, buffer: resources.vertexBuffer }],
    indexBuffer: { buffer: resources.indexBuffer, format: "uint16" },
    indexed: true,
    indexCount: 3,
    topology: "triangle-list",
    vertexLayout: [{ index: 0, componentDatatype: 5126, componentsPerAttribute: 3, normalized: false, offsetInBytes: 0, strideInBytes: 12 }],
    ...overrides,
  };
}

async function prefetchDevice() {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error("no WebGPU adapter is available in this browser");
  const device = await adapter.requestDevice();
  webgpuCounters.deviceRequests += 1;
  return { adapter, device };
}

function createCanvas(width, height) {
  const canvas = document.getElementById("contract-canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  return canvas;
}

function describeContext(context, bundle) {
  const read = (name) => {
    try {
      return context[name];
    } catch (error) {
      return `<throws:${error?.category ?? error?.name ?? "error"}>`;
    }
  };
  return {
    constructorName: context?.constructor?.name ?? null,
    isReplacement: context instanceof bundle.Context,
    hasId: typeof read("id") === "string",
    id: read("id"),
    drawingBufferWidth: read("drawingBufferWidth"),
    drawingBufferHeight: read("drawingBufferHeight"),
    webgl2: read("webgl2"),
    msaa: read("msaa"),
    depthTexture: read("depthTexture"),
    fragmentDepth: read("fragmentDepth"),
    stencilBits: read("stencilBits"),
    supportsBasis: read("supportsBasis"),
    textureFilterAnisotropic: read("textureFilterAnisotropic"),
    defaultTexture: read("defaultTexture") === undefined ? null : {
      width: context.defaultTexture.width,
      height: context.defaultTexture.height,
      flipY: context.defaultTexture.flipY,
      pixelFormat: context.defaultTexture.pixelFormat,
      pixelDatatype: context.defaultTexture.pixelDatatype,
      sampler: context.defaultTexture.samplerDescriptor,
    },
    uniformStatePresent: read("uniformState") !== undefined && read("uniformState") !== null,
  };
}

/** Read the presented canvas pixels back through the platform (proves presentation, not just submission). */
async function readPresentedCanvas(canvas) {
  const bitmap = await createImageBitmap(canvas);
  const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context2d = offscreen.getContext("2d");
  context2d.drawImage(bitmap, 0, 0);
  const { data } = context2d.getImageData(0, 0, bitmap.width, bitmap.height);
  let nonBlack = 0;
  const colours = new Set();
  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    if (r + g + b > 12) nonBlack += 1;
    if (colours.size < 64) colours.add(`${r},${g},${b}`);
  }
  const centre = (() => {
    const x = Math.floor(bitmap.width / 2);
    const y = Math.floor(bitmap.height / 2);
    const offset = (y * bitmap.width + x) * 4;
    return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
  })();
  return { width: bitmap.width, height: bitmap.height, nonBlackPixels: nonBlack, uniqueColours: colours.size, centre };
}

// ------------------------------------------------------------------------------------------------
// scenarios
// ------------------------------------------------------------------------------------------------

/** T043: the device is taken inside the `Scene` constructor and the capabilities are final by then. */
async function scenarioSceneConstruct(bundle, canvas) {
  const { adapter, device } = await prefetchDevice();
  report.environment = { adapterInfo: adapter.info ?? null, preferredFormat: navigator.gpu.getPreferredCanvasFormat(), deviceRequested: true };
  step("prefetch", { adapterInfo: adapter.info ?? null });

  bundle.deviceHandoff.resetSlot();
  bundle.deviceHandoff.install({ adapter, device, limits: adapter.limits, features: adapter.features, source: "contract-page" });
  step("install-handoff");

  const handoffBefore = bundle.deviceHandoff.audit();
  // The scene is constructed from the frozen MVP configuration (A6): the same object the runner records
  // in `VerificationRun.fixedConditions`, so the recorded and executed conditions cannot drift.
  bundle.sceneOptions.assertMvpSceneOptions();
  const scene = new bundle.Scene({ canvas, ...bundle.sceneOptions.MVP_SCENE_CONFIGURATION.sceneOptions });
  step("construct-scene", { contextConstructor: scene.context?.constructor?.name ?? null });

  const context = scene.context;
  const result = {
    handoffPendingBeforeConstruction: handoffBefore.pending,
    handoffPendingAfterConstruction: bundle.deviceHandoff.audit().pending,
    takeStack: bundle.deviceHandoff.audit().entries.find((entry) => entry.op === "take")?.stack ?? null,
    context: describeContext(context, bundle),
    contextLimitsWritten: typeof context?.contextLimitsWritten === "object" ? [...context.contextLimitsWritten] : null,
    // The kept upstream module must hold the published values (the logic layer reads it through getters).
    upstreamContextLimits: {
      maximumTextureSize: bundle.ContextLimits.maximumTextureSize,
      maximumSamples: bundle.ContextLimits.maximumSamples,
      maximumVertexAttributes: bundle.ContextLimits.maximumVertexAttributes,
      maximumDrawBuffers: bundle.ContextLimits.maximumDrawBuffers,
      maximumTextureFilterAnisotropy: bundle.ContextLimits.maximumTextureFilterAnisotropy,
      highpFloatSupported: bundle.ContextLimits.highpFloatSupported,
    },
    sceneConfiguration: {
      msaaSupported: scene.msaaSupported ?? null,
      logarithmicDepthBuffer: scene.logarithmicDepthBuffer ?? null,
    },
    deviceIdentity: context?.device === device,
    adapterIdentity: context?.adapter === adapter,
  };
  scene.destroy?.();
  context?.destroy?.();
  return result;
}

/** T044/T050: a real frame — clear, draws, a target switch, submit and present. */
async function scenarioDrawDispatch(bundle, canvas, options = {}) {
  const { adapter, device } = await prefetchDevice();
  report.environment = { adapterInfo: adapter.info ?? null, preferredFormat: navigator.gpu.getPreferredCanvasFormat() };
  bundle.deviceHandoff.resetSlot();
  bundle.deviceHandoff.install({ adapter, device, limits: adapter.limits, features: adapter.features, source: "contract-page" });
  const scene = new bundle.Scene({ canvas, ...bundle.sceneOptions.MVP_SCENE_CONFIGURATION.sceneOptions });
  const context = scene.context;
  step("construct-scene", { contextConstructor: context?.constructor?.name ?? null });

  const resources = createTriangleResources(device, context.swapchainFormat);
  const swapchainInputs = drawInputsFor(resources, { sampleCount: context.sampleCount });
  const offscreenInputs = drawInputsFor(resources, { sampleCount: 1, withDepth: false });
  const offscreen = device.createTexture({
    label: "contract-offscreen-colour",
    size: { width: canvas.width, height: canvas.height, depthOrArrayLayers: 1 },
    format: context.swapchainFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const offscreenTarget = { id: "contract-offscreen", colorAttachments: [{ id: "contract-offscreen-0", view: offscreen.createView() }], sampleCount: 1 };
  context.registerTarget(offscreenTarget);
  step("resources", { swapchainFormat: context.swapchainFormat, sampleCount: context.sampleCount });

  const frames = 3;
  for (let frame = 0; frame < frames; frame += 1) {
    context.beginFrame();
    context.clear({ color: { red: 0.05, green: 0.05, blue: 0.08, alpha: 1 } }, {});
    context.draw({ __webgpu: swapchainInputs, count: 3, renderState: {} }, {});
    // A second, structurally different draw (different vertex-layout fingerprint) exercises the cache.
    context.draw({ __webgpu: { ...swapchainInputs, vertexLayout: [] }, count: 3, renderState: {} }, {});
    context.clear({ __webgpuTargets: offscreenTarget }, {});
    context.draw({ __webgpu: offscreenInputs, __webgpuTargets: offscreenTarget, count: 3 }, {});
    context.endFrame();
    await context.awaitFrameErrors();
  }
  step("frames", { frames });

  const result = {
    counters: { ...context.counters },
    pipelineCache: bundle.pipelineCacheStats(),
    frameErrors: context.frameErrors(),
    lastFramePasses: context.lastFramePasses().map((pass) => ({
      index: pass.index,
      keyText: pass.keyText,
      clearOps: pass.clearOps,
      drawOps: pass.drawOps,
      sampleCount: pass.sampleCount,
      closedBy: pass.closedBy,
      gpuPassCount: pass.gpuPassCount,
    })),
    contextLimitsWritten: [...context.contextLimitsWritten],
  };
  // The presentation read-back needs the live context (and the last submitted frame), so the caller
  // decides when to tear down. Every scenario leaves exactly one backend alive at a time.
  if (options.keepContext === true) return { result, context };
  context.destroy();
  return { result, context: null };
}

/** T050: after a frame, what the platform reads back from the canvas is the drawn image. */
async function scenarioPresent(bundle, canvas) {
  const { result: dispatch } = await scenarioDrawDispatch(bundle, canvas, { keepContext: true });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  // Best-effort in-page read-back. `createImageBitmap` on a WebGPU canvas is not guaranteed, so the
  // authoritative presentation evidence is the harness screenshot taken right after this scenario —  // which is also why the backend is left alive and the last frame stays presented.
  let presented;
  try {
    presented = await readPresentedCanvas(canvas);
    if (presented.nonBlackPixels === 0 && presented.uniqueColours <= 1) {
      // Measured on headless Chrome 153: `createImageBitmap(canvas)` on a **WebGPU-configured** canvas
      // yields an all-zero image even while the compositor shows the frame. That is a platform blind
      // spot, not a product result, so it is flagged instead of being read as "the canvas is black".
      presented = {
        ...presented,
        readbackUnusable: true,
        reason:
          "createImageBitmap() on a WebGPU canvas returned an all-zero image in this browser build; the " +
          "authoritative presentation evidence is the harness screenshot of the canvas region",
      };
    }
  } catch (error) {
    presented = { readbackUnusable: true, reason: error?.message ?? String(error) };
  }
  step("read-presented-canvas", presented);
  return { ...dispatch, presented };
}

/** T051: `device.destroy()` — stop, destroy, re-probe, rebuild; the record is the evidence. */
async function scenarioDeviceLost(bundle, canvas) {
  const { adapter, device } = await prefetchDevice();
  report.environment = { adapterInfo: adapter.info ?? null };
  bundle.deviceHandoff.resetSlot();
  bundle.deviceHandoff.install({ adapter, device, limits: adapter.limits, features: adapter.features, source: "contract-page" });
  const scene = new bundle.Scene({ canvas, ...bundle.sceneOptions.MVP_SCENE_CONFIGURATION.sceneOptions });
  let context = scene.context;
  const resources = createTriangleResources(device, context.swapchainFormat);
  const firstFrameInputs = drawInputsFor(resources, { sampleCount: context.sampleCount });
  context.beginFrame();
  context.clear({ color: { red: 0, green: 0, blue: 0, alpha: 1 } }, {});
  context.draw({ __webgpu: firstFrameInputs, count: 3 }, {});
  context.endFrame();
  await context.awaitFrameErrors();
  step("first-frame", { counters: { ...context.counters } });

  const liveResourcesBefore = context.liveResourceCount;
  const record = await bundle.wholeSwitch.performWholeSwitch(
    "device-lost",
    {
      stopSubmitting: () => {
        context.stopSubmitting();
        step("stop-submitting");
      },
      destroy: () => {
        const destroyed = context.liveResourceCount;
        scene.destroy?.();
        context.destroy();
        bundle.deviceHandoff.clear();
        step("destroy", { destroyed });
        return { destroyedResources: destroyed };
      },
      rebuild: async () => {
        // Re-probe exactly like the initial probe (research §3): resetCycle + install + construct.
        bundle.deviceHandoff.resetSlot();
        const reprobe = await prefetchDevice();
        bundle.deviceHandoff.install({ adapter: reprobe.adapter, device: reprobe.device, limits: reprobe.adapter.limits, features: reprobe.adapter.features, source: "re-probe-after-loss" });
        const rebuilt = new bundle.Scene({ canvas, ...bundle.sceneOptions.MVP_SCENE_CONFIGURATION.sceneOptions });
        context = rebuilt.context;
        step("rebuild", { contextConstructor: context?.constructor?.name ?? null });
        return "webgpu";
      },
      residualDraws: () => context.residualDraws ?? 0,
    },
    "webgpu",
  );
  step("whole-switch", record);

  // The rebuilt backend must be usable (no refresh).
  const rebuiltResources = createTriangleResources(context.device, context.swapchainFormat);
  const rebuiltInputs = drawInputsFor(rebuiltResources, { sampleCount: context.sampleCount });
  context.beginFrame();
  context.clear({ color: { red: 0.1, green: 0.1, blue: 0.2, alpha: 1 } }, {});
  context.draw({ __webgpu: rebuiltInputs, count: 3 }, {});
  context.endFrame();
  await context.awaitFrameErrors();

  const result = {
    record,
    liveResourcesBefore,
    deviceLostReason: context.deviceLostReason,
    rebuiltUsable: context.counters.draws > 0,
    rebuiltCounters: { ...context.counters },
    frameErrors: context.frameErrors(),
    // No stale canvas: the destroyed backend's draw never returned to the screen as an overlay.
    overlayEvidence: { stopSubmittingDraws: context.counters.drawsAfterStop },
  };
  context.destroy();
  return result;
}

/** T047: record this run's frame-level pass sequence. The comparison happens offline. */
async function scenarioPassSequence(bundle, canvas) {
  if (backend === "webgl2") {
    // The upstream path: scripted GL workload recorded by wrapping the platform API (G-3's technique).
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, stencil: true });
    if (gl === null) throw new Error("no WebGL2 context is available");
    const operations = [];
    const original = {
      bindFramebuffer: WebGL2RenderingContext.prototype.bindFramebuffer,
      viewport: WebGL2RenderingContext.prototype.viewport,
      clear: WebGL2RenderingContext.prototype.clear,
      drawArrays: WebGL2RenderingContext.prototype.drawArrays,
      drawElements: WebGL2RenderingContext.prototype.drawElements,
      blitFramebuffer: WebGL2RenderingContext.prototype.blitFramebuffer,
    };
    let seq = 0;
    let currentFramebuffer = "default";
    const viewportOf = (context) => ({ x: 0, y: 0, width: context.drawingBufferWidth, height: context.drawingBufferHeight });
    const record = (op, extra = {}) => {
      operations.push({
        seq: (seq += 1),
        op,
        changed: true,
        targetId: currentFramebuffer,
        targetKind: currentFramebuffer === "default" ? "default-framebuffer" : "framebuffer",
        ...extra,
        identity: {
          colorTargets: currentFramebuffer === "default" ? ["canvas"] : [`color(${currentFramebuffer})`],
          depthStencilTarget: currentFramebuffer === "default" ? "canvas" : `depth(${currentFramebuffer})`,
          sampleCount: 1,
          viewport: viewportOf(gl),
          scissorRect: null,
          targetId: currentFramebuffer,
          targetKind: currentFramebuffer === "default" ? "default-framebuffer" : "framebuffer",
        },
      });
    };

    const program = createGlTriangleProgram(gl);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.useProgram(program);

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    const colorRenderbuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, colorRenderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, canvas.width, canvas.height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorRenderbuffer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(vao);

    WebGL2RenderingContext.prototype.bindFramebuffer = function traced(target, fb) {
      const id = fb === null || fb === undefined ? "default" : `fb-${fb.__traceId ?? (fb.__traceId = "x1")}`;
      currentFramebuffer = id;
      const result = original.bindFramebuffer.call(this, target, fb);
      record("bindFramebuffer", { previousTargetId: id, targetId: id });
      return result;
    };
    WebGL2RenderingContext.prototype.viewport = function traced(...args) {
      const result = original.viewport.apply(this, args);
      record("viewport", { viewport: { x: args[0], y: args[1], width: args[2], height: args[3] } });
      return result;
    };
    WebGL2RenderingContext.prototype.clear = function traced(mask) {
      const result = original.clear.call(this, mask);
      record("clear", { mask });
      return result;
    };
    WebGL2RenderingContext.prototype.drawArrays = function traced(...args) {
      const result = original.drawArrays.apply(this, args);
      record("drawArrays", { mode: args[0], count: args[2] });
      return result;
    };
    WebGL2RenderingContext.prototype.drawElements = function traced(...args) {
      const result = original.drawElements.apply(this, args);
      record("drawElements", { mode: args[0], count: args[1] });
      return result;
    };

    // Identical workload to the WebGPU side: clear+draw ×2 on the canvas, clear+draw offscreen, draw back.
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.05, 0.05, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.05, 0.05, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish();

    Object.assign(WebGL2RenderingContext.prototype, original);

    const partition = partitionTrace(operations);
    const result = {
      source: "webgl2-platform-trace",
      operationCount: operations.length,
      passes: partition.passes.map((pass) => ({
        index: pass.index,
        keyText: pass.key,
        clearOps: pass.clearOps,
        drawOps: pass.drawOps,
        sampleCount: pass.identity?.sampleCount ?? null,
      })),
      workOps: partition.work.length,
    };
    step("webgl2-sequences", { operations: operations.length, passes: partition.passes.length });
    return result;
  }

  const { adapter, device } = await prefetchDevice();
  bundle.deviceHandoff.resetSlot();
  bundle.deviceHandoff.install({ adapter, device, limits: adapter.limits, features: adapter.features, source: "contract-page" });
  const scene = new bundle.Scene({ canvas, ...bundle.sceneOptions.MVP_SCENE_CONFIGURATION.sceneOptions });
  const context = scene.context;
  const resources = createTriangleResources(device, context.swapchainFormat);
  const swapchainInputs = drawInputsFor(resources, { sampleCount: context.sampleCount });
  const offscreenInputs = drawInputsFor(resources, { sampleCount: 1, withDepth: false });
  const offscreen = device.createTexture({
    label: "contract-offscreen-colour",
    size: { width: canvas.width, height: canvas.height, depthOrArrayLayers: 1 },
    format: context.swapchainFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const offscreenTarget = { id: "contract-offscreen", colorAttachments: [{ id: "contract-offscreen-0", view: offscreen.createView() }], sampleCount: 1 };
  context.registerTarget(offscreenTarget);

  context.beginFrame();
  context.clear({ color: { red: 0.05, green: 0.05, blue: 0.08, alpha: 1 } }, {});
  context.draw({ __webgpu: swapchainInputs, count: 3 }, {});
  context.draw({ __webgpu: swapchainInputs, count: 3 }, {});
  context.clear({ __webgpuTargets: offscreenTarget }, {});
  context.draw({ __webgpu: offscreenInputs, __webgpuTargets: offscreenTarget, count: 3 }, {});
  context.draw({ __webgpu: swapchainInputs, count: 3 }, {});
  context.endFrame();
  await context.awaitFrameErrors();

  const passes = context.lastFramePasses();
  const result = {
    source: "webgpu-derived-passes",
    operationCount: passes.reduce((total, pass) => total + pass.clearOps + pass.drawOps, 0),
    passes: passes.map((pass) => ({ index: pass.index, keyText: pass.keyText, clearOps: pass.clearOps, drawOps: pass.drawOps, sampleCount: pass.sampleCount })),
    workOps: passes.reduce((total, pass) => total + pass.clearOps + pass.drawOps, 0),
    frameErrors: context.frameErrors(),
  };
  step("webgpu-sequences", { passes: passes.length });
  context.destroy();
  return result;
}

function createGlTriangleProgram(gl) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, "#version 300 es\nlayout(location=0) in vec3 position;\nvoid main() { gl_Position = vec4(position, 1.0); }\n"));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, "#version 300 es\nprecision highp float;\nout vec4 outColor;\nvoid main() { outColor = vec4(0.15, 0.55, 0.85, 1.0); }\n"));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  return program;
}

// ------------------------------------------------------------------------------------------------
// W3 resource layer (tasks.md T064 / T058): the replaced resource classes, driven directly
// ------------------------------------------------------------------------------------------------

/**
 * The interleaved vertex layout both paths use: `position` (float32x3) | `colour` (float32x4).
 *
 * The colour travels **through the vertex buffer**, so the drawn pixel proves what the buffer holds — * which is what makes "buffer upload ordering" observable rather than assumed.
 */
const W3_VERTEX_STRIDE = 28;
/** The colour the **second** upload carries; the pixel MUST show this one (last write wins). */
const W3_ORDERED_COLOUR = [0.15, 0.55, 0.85, 1.0];
/** The colour the **first** (superseded) upload carries; showing it would mean the order broke. */
const W3_SUPERSEDED_COLOUR = [1.0, 0.0, 0.0, 1.0];
/** The colour drawn into the offscreen MSAA pair; the resolved half MUST show it. */
const W3_MSAA_COLOUR = [0.2, 0.8, 0.3, 1.0];

/** A full-viewport triangle whose three vertices carry `colour`. */
function interleavedTriangle(colour) {
  return new Float32Array([
    -1, -1, 0, ...colour,
     3, -1, 0, ...colour,
    -1,  3, 0, ...colour,
  ]);
}

const W3_VERTEX_WGSL = `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) colour: vec4f,
};

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) colour: vec4f) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(position, 1.0);
  out.colour = colour;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return in.colour;
}
`;

const W3_TEXTURED_WGSL = `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@location(0) position: vec2f, @location(1) uv: vec2f) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(position, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return textureSample(sourceTexture, sourceSampler, in.uv);
}
`;

/**
 * A GL-verbatim full-screen quad: (u,v) = (0,0) at the bottom-left **of the source image**.
 *
 * Vertices are bottom-left, bottom-right, top-left, top-right, so the two triangles are
 * (BL, BR, TL) and (BR, TR, TL) — index order `[0,1,2, 1,3,2]`. The obvious-looking `[0,1,2, 0,2,3]`
 * is wrong for this vertex order: it makes BL-BR-TL and BL-TL-TR, which together cover only the left
 * part of the half and left a black wedge on screen (measured, and the reason the four-corner
 * assertion below is worth having).
 */
const W3_QUAD_VERTICES = new Float32Array([
  -1, -1, 0, 0,
   1, -1, 1, 0,
  -1,  1, 0, 1,
   1,  1, 1, 1,
]);
const W3_QUAD_INDICES = new Uint16Array([0, 1, 2, 1, 3, 2]);

const W3_QUAD_ATTRIBUTES = [
  { index: 0, componentDatatype: 5126, componentsPerAttribute: 2, normalized: false, offsetInBytes: 0, strideInBytes: 16 },
  { index: 1, componentDatatype: 5126, componentsPerAttribute: 2, normalized: false, offsetInBytes: 8, strideInBytes: 16 },
];

/** A 2x2 source whose four texels are distinguishable: row 0 = red|green, row 1 = blue|yellow. */
const W3_2X2_SOURCE = new Uint8Array([
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 255, 255, 0, 255,
]);
const W3_EXPECTED_FLIPPED = { topLeft: [255, 0, 0], topRight: [0, 255, 0], bottomLeft: [0, 0, 255], bottomRight: [255, 255, 0] };
const W3_EXPECTED_UNFLIPPED = { topLeft: [0, 0, 255], topRight: [255, 255, 0], bottomLeft: [255, 0, 0], bottomRight: [0, 255, 0] };

/** WebGPU pipelines for the two W3 workloads, cached per (format, sampleCount). */
function createW3GpuPipelines(device, format, sampleCount, withDepth = true) {
  const vertexModule = device.createShaderModule({ label: "w3-vertex-colour", code: W3_VERTEX_WGSL });
  const texturedModule = device.createShaderModule({ label: "w3-textured-quad", code: W3_TEXTURED_WGSL });
  // The canvas pass carries a depth-stencil attachment (W5), the offscreen MSAA pair of this workload
  // does not — and WebGPU requires a pipeline's declared depth state to match its pass.
  const depthStencil = withDepth ? { depthStencil: { format: "depth24plus-stencil8", depthWriteEnabled: true, depthCompare: "less" } } : {};
  return {
    vertexModule,
    texturedModule,
    vertexPipeline: device.createRenderPipeline({
      label: `w3-vertex-colour-${format}-${sampleCount}${withDepth ? "-depth" : ""}`,
      layout: "auto",
      vertex: {
        module: vertexModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: W3_VERTEX_STRIDE,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: { module: vertexModule, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      multisample: { count: sampleCount },
      ...depthStencil,
    }),
    texturedPipeline: device.createRenderPipeline({
      label: `w3-textured-quad-${format}-${sampleCount}${withDepth ? "-depth" : ""}`,
      layout: "auto",
      vertex: {
        module: texturedModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 16,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x2" },
            ],
          },
        ],
      },
      fragment: { module: texturedModule, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      multisample: { count: sampleCount },
      ...depthStencil,
    }),
  };
}

/** The two viewport halves the W3 workloads render into. */
function w3HalfViewports(canvas) {
  const half = Math.floor(canvas.width / 2);
  return {
    left: { x: 0, y: 0, width: half, height: canvas.height },
    right: { x: half, y: 0, width: canvas.width - half, height: canvas.height },
  };
}

/** The normalised sample points the W3 suites assert on (25 % / 75 % of each half). */
function w3HalfSamplePoints() {
  return [
    { name: "left-top-left", x: 0.125, y: 0.25 },
    { name: "left-top-right", x: 0.375, y: 0.25 },
    { name: "left-bottom-left", x: 0.125, y: 0.75 },
    { name: "left-bottom-right", x: 0.375, y: 0.75 },
    { name: "right-top-left", x: 0.625, y: 0.25 },
    { name: "right-top-right", x: 0.875, y: 0.25 },
    { name: "right-bottom-left", x: 0.625, y: 0.75 },
    { name: "right-bottom-right", x: 0.875, y: 0.75 },
  ];
}

/**
 * `contract:resources` — the W3 independent test (`层=契约`, tasks.md T064).
 *
 * One page load, one backend. The workload uses the **production specifiers** for every resource
 * class, so under the real manifest the replacement implementations run and under the empty manifest
 * the upstream ones do; the report is the same shape either way, which is what makes the offline
 * comparison meaningful.
 */
async function scenarioResources(bundle, canvas) {
  const isWebgpu = backend !== "webgl2";
  const viewports = w3HalfViewports(canvas);
  let context;

  if (isWebgpu) {
    const { adapter, device } = await prefetchDevice();
    report.environment = { adapterInfo: adapter.info ?? null, preferredFormat: navigator.gpu.getPreferredCanvasFormat() };
    bundle.deviceHandoff.resetSlot();
    bundle.deviceHandoff.install({ adapter, device, limits: adapter.limits, features: adapter.features, source: "contract-page" });
    context = new bundle.Context(canvas, {});
  } else {
    context = new bundle.Context(canvas, { webgl: { alpha: false, antialias: false, stencil: true } });
  }
  step("construct-context", { backend, constructor: context?.constructor?.name ?? null });

  // ---- buffers: three factories, usage mapping, index extras ----------------------------------
  const vertexTypedArray = interleavedTriangle(W3_SUPERSEDED_COLOUR);
  const vertexBuffer = bundle.Buffer.createVertexBuffer({ context, typedArray: vertexTypedArray, usage: bundle.BufferUsage.DYNAMIC_DRAW });
  // The second write MUST win: this is the observable half of "buffer upload ordering".
  vertexBuffer.copyFromArrayView(interleavedTriangle(W3_ORDERED_COLOUR), 0);
  const indexBuffer = bundle.Buffer.createIndexBuffer({
    context,
    typedArray: new Uint16Array([0, 1, 2, 0]),
    usage: bundle.BufferUsage.STATIC_DRAW,
    indexDatatype: bundle.IndexDatatype.UNSIGNED_SHORT,
  });
  const vertexArray = new bundle.VertexArray({
    context,
    attributes: [
      { index: 0, vertexBuffer, componentDatatype: 5126, componentsPerAttribute: 3, normalize: false, offsetInBytes: 0, strideInBytes: W3_VERTEX_STRIDE },
      { index: 1, vertexBuffer, componentDatatype: 5126, componentsPerAttribute: 4, normalize: false, offsetInBytes: 12, strideInBytes: W3_VERTEX_STRIDE },
    ],
    indexBuffer,
  });
  // A second triangle with a *distinct* colour, written once: it goes into the MSAA pair, so the
  // resolved half can only show it if the resolve really happened.
  const msaaVertexBuffer = bundle.Buffer.createVertexBuffer({ context, typedArray: interleavedTriangle(W3_MSAA_COLOUR), usage: bundle.BufferUsage.STATIC_DRAW });
  const msaaVertexArray = new bundle.VertexArray({
    context,
    attributes: [
      { index: 0, vertexBuffer: msaaVertexBuffer, componentDatatype: 5126, componentsPerAttribute: 3, normalize: false, offsetInBytes: 0, strideInBytes: W3_VERTEX_STRIDE },
      { index: 1, vertexBuffer: msaaVertexBuffer, componentDatatype: 5126, componentsPerAttribute: 4, normalize: false, offsetInBytes: 12, strideInBytes: W3_VERTEX_STRIDE },
    ],
    indexBuffer,
  });
  const quadVertexBuffer = bundle.Buffer.createVertexBuffer({ context, typedArray: W3_QUAD_VERTICES, usage: bundle.BufferUsage.STATIC_DRAW });
  const quadIndexBuffer = bundle.Buffer.createIndexBuffer({
    context,
    typedArray: W3_QUAD_INDICES,
    usage: bundle.BufferUsage.STATIC_DRAW,
    indexDatatype: bundle.IndexDatatype.UNSIGNED_SHORT,
  });
  const quadVertexArray = new bundle.VertexArray({
    context,
    attributes: W3_QUAD_ATTRIBUTES.map((attribute) => ({ ...attribute, vertexBuffer: quadVertexBuffer })),
    indexBuffer: quadIndexBuffer,
  });
  step("buffers", { vertexBytes: vertexBuffer.sizeInBytes, indexCount: indexBuffer.numberOfIndices });

  // ---- texture: the source type set, the format map, the origin policy ------------------------
  const sampler = new bundle.Sampler({ wrapS: bundle.TextureWrap.REPEAT, wrapT: bundle.TextureWrap.MIRRORED_REPEAT });
  const sourceTexture = new bundle.Texture({
    context,
    width: 2,
    height: 2,
    pixelFormat: bundle.PixelFormat.RGBA,
    pixelDatatype: bundle.PixelDatatype.UNSIGNED_BYTE,
    sampler,
    source: { width: 2, height: 2, arrayBufferView: W3_2X2_SOURCE },
  });
  const samplerMapping = isWebgpu ? bundle.samplerMap.mapSampler(sourceTexture.sampler) : null;

  // ---- MSAA: the pairing, the resolve, and the resolve result ---------------------------------
  const resolveTexture = new bundle.Texture({ context, width: canvas.width, height: canvas.height, sampler: bundle.Sampler.NEAREST });
  const colorRenderbuffer = new bundle.Renderbuffer({ context, format: bundle.RenderbufferFormat.RGBA8, width: canvas.width, height: canvas.height, numSamples: 4 });
  const multisampleFramebuffer = new bundle.MultisampleFramebuffer({
    context,
    width: canvas.width,
    height: canvas.height,
    colorTextures: [resolveTexture],
    colorRenderbuffers: [colorRenderbuffer],
    destroyAttachments: false,
  });
  const renderFramebuffer = multisampleFramebuffer.getRenderFramebuffer();
  const blit = multisampleFramebuffer.blitFramebuffers(context, false);
  // The attachment's real sample count: the descriptor value on the WebGPU path, the driver's answer
  // on the GL path (upstream's `Renderbuffer` stores `numSamples` nowhere).
  let attachmentSamples = colorRenderbuffer.numSamples ?? null;
  if (!isWebgpu) {
    const gl = context._gl;
    gl.bindRenderbuffer(gl.RENDERBUFFER, colorRenderbuffer._getRenderbuffer());
    attachmentSamples = gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_SAMPLES);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }
  step("msaa", { sampleCount: attachmentSamples, blit: blit ?? null });

  // ---- the frame: an ordered-buffer triangle on the left, the resolved image on the right -----
  const msaaTarget = isWebgpu ? renderFramebuffer : renderFramebuffer;
  if (isWebgpu) {
    const swapchain = createW3GpuPipelines(context.device, context.swapchainFormat, context.sampleCount, true);
    const offscreen = createW3GpuPipelines(context.device, "rgba8unorm", 4, false);
    // The bind group layout MUST come from the very pipeline it will be used with: an "auto" layout
    // belongs to its pipeline, and mixing two of them is a validation error (which the backend
    // correctly surfaced at frame end).
    const resolveBindGroup = context.device.createBindGroup({
      label: "w3-resolve-bind-group",
      layout: swapchain.texturedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: resolveTexture.view },
        { binding: 1, resource: resolveTexture.gpuSampler },
      ],
    });

    const renderFrame = () => {
      context.beginFrame();
      context.clear({ color: { red: 0, green: 0, blue: 0, alpha: 1 } }, {});
    context.draw(
      {
        vertexArray,
        count: 3,
        __webgpu: {
          shaderProgramId: "w3-ordered-triangle",
          pipeline: swapchain.vertexPipeline,
          topology: "triangle-list",
          colorFormats: [context.swapchainFormat],
          sampleCount: context.sampleCount,
          indexed: true,
          indexCount: 3,
        },
        renderState: { viewport: viewports.left },
      },
      {},
    );
    context.clear({ __webgpuTargets: renderFramebuffer }, {});
    context.draw(
      {
        vertexArray: msaaVertexArray,
        count: 3,
        __webgpuTargets: renderFramebuffer,
        __webgpu: {
          shaderProgramId: "w3-msaa-triangle",
          pipeline: offscreen.vertexPipeline,
          topology: "triangle-list",
          colorFormats: ["rgba8unorm"],
          sampleCount: 4,
          indexed: true,
          indexCount: 3,
        },
      },
      {},
    );
    context.draw(
      {
        vertexArray: quadVertexArray,
        count: 6,
        __webgpu: {
          shaderProgramId: "w3-textured-quad",
          pipeline: swapchain.texturedPipeline,
          bindGroups: [resolveBindGroup],
          topology: "triangle-list",
          colorFormats: [context.swapchainFormat],
          sampleCount: context.sampleCount,
          indexed: true,
          indexCount: 6,
        },
        renderState: { viewport: viewports.right },
      },
      {},
    );
      context.endFrame();
    };
    // Three identical frames, then two animation frames of settle time: the same discipline
    // `smoke:present` uses. A single frame is not reliably composited into the screenshot on a
    // WebGPU canvas (measured: partial tiles stay black), and the screenshot is the presentation
    // evidence T058/T064 assert on.
    for (let frame = 0; frame < 3; frame += 1) {
      renderFrame();
      await context.awaitFrameErrors();
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    step("frame", { counters: { ...context.counters }, frameErrors: context.frameErrors() });
  } else {
    const gl = context._gl;
    const program = createGlColourProgram(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(viewports.left.x, viewports.left.y, viewports.left.width, viewports.left.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer._getBuffer());
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, W3_VERTEX_STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, W3_VERTEX_STRIDE, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer._getBuffer());
    gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 0);

    // The MSAA pass: draw into the multisampled renderbuffer, then let the blit resolve it.
    renderFramebuffer.bindDraw();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(createGlSolidProgram(gl, W3_MSAA_COLOUR));
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer._getBuffer());
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, W3_VERTEX_STRIDE, 0);
    gl.disableVertexAttribArray(1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer._getBuffer());
    gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    multisampleFramebuffer.blitFramebuffers(context, false);

    // Present the resolved texture on the right half.
    gl.viewport(viewports.right.x, viewports.right.y, viewports.right.width, viewports.right.height);
    const textured = createGlTextureProgram(gl);
    gl.useProgram(textured.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, resolveTexture._texture);
    gl.uniform1i(textured.uniform, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVertexBuffer._getBuffer());
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIndexBuffer._getBuffer());
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    gl.finish();
    step("gl-frame");
  }

  const result = {
    backend,
    contextConstructor: context?.constructor?.name ?? null,
    contextIsReplacement: isWebgpu && context.constructor === bundle.contextModule.default,
    buffer: {
      vertexSizeInBytes: vertexBuffer.sizeInBytes,
      vertexUsage: vertexBuffer.usage,
      indexSizeInBytes: indexBuffer.sizeInBytes,
      indexUsage: indexBuffer.usage,
      indexDatatype: indexBuffer.indexDatatype,
      bytesPerIndex: indexBuffer.bytesPerIndex,
      numberOfIndices: indexBuffer.numberOfIndices,
      numberOfVertices: vertexArray.numberOfVertices,
      gpuLayout: isWebgpu ? vertexArray.toGpuVertexBuffers().map((binding) => ({ slot: binding.slot, arrayStride: binding.layout.arrayStride, stepMode: binding.layout.stepMode, attributes: binding.layout.attributes.length })) : null,
    },
    texture: {
      width: sourceTexture.width,
      height: sourceTexture.height,
      pixelFormat: sourceTexture.pixelFormat,
      pixelDatatype: sourceTexture.pixelDatatype,
      flipY: sourceTexture.flipY,
      preMultiplyAlpha: sourceTexture.preMultiplyAlpha,
      sizeInBytes: sourceTexture.sizeInBytes,
      gpuFormat: isWebgpu ? sourceTexture.formatMapping.format : null,
    },
    sampler: {
      wrapS: sourceTexture.sampler.wrapS,
      wrapT: sourceTexture.sampler.wrapT,
      wrapR: sourceTexture.sampler.wrapR,
      minificationFilter: sourceTexture.sampler.minificationFilter,
      magnificationFilter: sourceTexture.sampler.magnificationFilter,
      maximumAnisotropy: sourceTexture.sampler.maximumAnisotropy,
      gpuDescriptor: samplerMapping === null ? null : { ...samplerMapping.descriptor },
    },
    msaa: {
      requestSamples: 4,
      attachmentSamples,
      renderColorAttachments: renderFramebuffer.numberOfColorAttachments,
      colorColorAttachments: multisampleFramebuffer.getColorFramebuffer().numberOfColorAttachments,
      // Upstream's GL `Framebuffer` has no `colorAttachments` at all (it has GL attachment enums), so
      // the probe answers `false` there instead of reaching into a WebGPU-only property.
      resolveTargetPresent: renderFramebuffer.colorAttachments?.[0]?.resolveTarget !== undefined,
      resolveMechanism: blit === undefined || blit === null ? "blitFramebuffer" : blit.mechanism,
      resolveSampleCount: blit === undefined || blit === null ? attachmentSamples : blit.sampleCount,
    },
    ordering: { expectedColour: W3_ORDERED_COLOUR, supersededColour: W3_SUPERSEDED_COLOUR, msaaColour: W3_MSAA_COLOUR },
    counts: isWebgpu
      ? {
          draws: context.counters.draws,
          drawIndexedCalls: context.counters.drawIndexedCalls,
          passes: context.counters.passes,
          submittedCommandBuffers: context.counters.submittedCommandBuffers,
          frameErrors: context.frameErrors(),
          registry: bundle.gpuResourceRegistry.gpuResourceRegistry.stats(),
        }
      : { draws: null, drawIndexedCalls: null, passes: null, submittedCommandBuffers: null, frameErrors: [], registry: null },
    samplePoints: w3HalfSamplePoints(),
  };
  // The presented frame is the evidence, so the caller keeps the context alive for the screenshot.
  return { result, context };
}

/**
 * `visual:texture-origin` — T058's four-corner texel assertion (`层=视觉`).
 *
 * The same 2x2 source is uploaded twice: once with `flipY: true` (upstream's default) and once with
 * `flipY: false`. The two halves of the canvas therefore show the image and its vertical mirror, and
 * the harness samples the centre of each texel. With the WebGPU row-reversal in place the flipped
 * half matches GL's convention (v behaves like t); without it the halves would be swapped — which is
 * exactly the regression this suite exists to catch.
 */
async function scenarioTextureOrigin(bundle, canvas) {
  const { adapter, device } = await prefetchDevice();
  report.environment = { adapterInfo: adapter.info ?? null, preferredFormat: navigator.gpu.getPreferredCanvasFormat() };
  bundle.deviceHandoff.resetSlot();
  bundle.deviceHandoff.install({ adapter, device, limits: adapter.limits, features: adapter.features, source: "contract-page" });
  const context = new bundle.Context(canvas, {});
  step("construct-context", { constructor: context?.constructor?.name ?? null });

  const makeTexture = (flipY) =>
    new bundle.Texture({
      context,
      width: 2,
      height: 2,
      flipY,
      sampler: bundle.Sampler.NEAREST,
      pixelFormat: bundle.PixelFormat.RGBA,
      pixelDatatype: bundle.PixelDatatype.UNSIGNED_BYTE,
      source: { width: 2, height: 2, arrayBufferView: W3_2X2_SOURCE },
    });
  const flippedTexture = makeTexture(true);
  const unflippedTexture = makeTexture(false);

  const pipelines = createW3GpuPipelines(device, context.swapchainFormat, context.sampleCount);
  const bindGroupFor = (texture) =>
    device.createBindGroup({
      label: `w3-texture-origin-${texture.id}`,
      layout: pipelines.texturedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.view },
        { binding: 1, resource: texture.gpuSampler },
      ],
    });
  const quadVertexBuffer = bundle.Buffer.createVertexBuffer({ context, typedArray: W3_QUAD_VERTICES, usage: bundle.BufferUsage.STATIC_DRAW });
  const quadIndexBuffer = bundle.Buffer.createIndexBuffer({
    context,
    typedArray: W3_QUAD_INDICES,
    usage: bundle.BufferUsage.STATIC_DRAW,
    indexDatatype: bundle.IndexDatatype.UNSIGNED_SHORT,
  });
  const quadVertexArray = new bundle.VertexArray({
    context,
    attributes: W3_QUAD_ATTRIBUTES.map((attribute) => ({ ...attribute, vertexBuffer: quadVertexBuffer })),
    indexBuffer: quadIndexBuffer,
  });

  const viewports = w3HalfViewports(canvas);
  const drawFrame = () => {
    context.beginFrame();
    context.clear({ color: { red: 0, green: 0, blue: 0, alpha: 1 } }, {});
    for (const [texture, viewport, label] of [
      [flippedTexture, viewports.left, "flipY-true"],
      [unflippedTexture, viewports.right, "flipY-false"],
    ]) {
      context.draw(
        {
          vertexArray: quadVertexArray,
          count: 6,
          __webgpu: {
            shaderProgramId: `w3-texture-origin-${label}`,
            pipeline: pipelines.texturedPipeline,
            bindGroups: [bindGroupFor(texture)],
            topology: "triangle-list",
            colorFormats: [context.swapchainFormat],
            sampleCount: context.sampleCount,
            indexed: true,
            indexCount: 6,
          },
          renderState: { viewport },
        },
        {},
      );
    }
    context.endFrame();
  };
  for (let frame = 0; frame < 3; frame += 1) {
    drawFrame();
    await context.awaitFrameErrors();
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  step("frame", { counters: { ...context.counters }, frameErrors: context.frameErrors() });

  const planFor = (flipY) =>
    bundle.textureUpload.planTextureUpload({
      source: W3_2X2_SOURCE,
      width: 2,
      height: 2,
      sourceComponents: 4,
      gpuComponents: 4,
      bytesPerComponent: 1,
      flipY,
      uploadShape: "identity",
    });

  const result = {
    source: [...W3_2X2_SOURCE],
    uploads: {
      flipped: (() => {
        const plan = planFor(true);
        return { flipped: plan.flipped, bytesPerRow: plan.bytesPerRow, bytes: [...plan.bytes] };
      })(),
      unflipped: (() => {
        const plan = planFor(false);
        return { flipped: plan.flipped, bytesPerRow: plan.bytesPerRow, bytes: [...plan.bytes] };
      })(),
    },
    expected: { flipped: W3_EXPECTED_FLIPPED, unflipped: W3_EXPECTED_UNFLIPPED },
    counts: { draws: context.counters.draws, frameErrors: context.frameErrors() },
    samplePoints: w3HalfSamplePoints(),
  };
  return { result, context };
}

/** A GL program that draws the interleaved (position|colour) triangle. */
function createGlColourProgram(gl) {
  return createGlProgram(
    gl,
    `#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in vec4 colour;
out vec4 vColour;
void main() { vColour = colour; gl_Position = vec4(position, 1.0); }`,
    `#version 300 es
precision highp float;
in vec4 vColour;
out vec4 outColor;
void main() { outColor = vColour; }`,
  );
}

/** A GL program that paints a constant colour (the MSAA pass; colour comes from the uniform). */
function createGlSolidProgram(gl, colour) {
  const program = createGlProgram(
    gl,
    `#version 300 es
layout(location=0) in vec3 position;
void main() { gl_Position = vec4(position, 1.0); }`,
    `#version 300 es
precision highp float;
uniform vec4 uColour;
out vec4 outColor;
void main() { outColor = uColour; }`,
  );
  gl.useProgram(program);
  gl.uniform4f(gl.getUniformLocation(program, "uColour"), colour[0], colour[1], colour[2], colour[3]);
  return program;
}

/** A GL program that samples a texture with the GL-verbatim `(u,v)` convention. */
function createGlTextureProgram(gl) {
  const program = createGlProgram(
    gl,
    `#version 300 es
layout(location=0) in vec2 position;
layout(location=1) in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 0.0, 1.0); }`,
    `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTexture;
out vec4 outColor;
void main() { outColor = texture(uTexture, vUv); }`,
  );
  return { program, uniform: gl.getUniformLocation(program, "uTexture") };
}

function createGlProgram(gl, vertexSource, fragmentSource) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  return program;
}

// ------------------------------------------------------------------------------------------------
// W5 terrain (tasks.md T089-T096) — the real MVP scene, built from the production composition
// ------------------------------------------------------------------------------------------------

/**
 * Instrument `FramebufferManager.update` so every attachment request of this run is recorded.
 *
 * This is the **ordering evidence** the W5 phase opens with (tasks.md Phase 7, T097/T098a): the
 * replacement's slice-A degradation turns the "multisampled pass with a depth-stencil attachment but
 * no depth-stencil *texture*" case into a diagnosable failure, and the question is whether the MVP
 * terrain scene reaches it. Recording every call — and every thrown error — answers that by
 * measurement instead of by reading the request path.
 */
function instrumentFramebufferManager(bundle, log) {
  const prototype = bundle.framebufferManagerModule?.default?.prototype;
  if (prototype === undefined) return false;
  const original = prototype.update;
  prototype.update = function instrumentedUpdate(context, width, height, numSamples, pixelDatatype, pixelFormat) {
    const record = {
      numSamples: numSamples ?? null,
      resolvedSamples: context?.msaa === true ? (numSamples ?? 1) : 1,
      contextMsaa: context?.msaa === true,
      contextDepthTexture: context?.depthTexture === true,
      depthStencil: this._depthStencil === true,
      depth: this._depth === true,
      supportsDepthTexture: this._supportsDepthTexture === true,
      createDepthAttachments: this._createDepthAttachments !== false,
      width,
      height,
    };
    try {
      const result = original.call(this, context, width, height, numSamples, pixelDatatype, pixelFormat);
      log.push({ ...record, ok: true });
      return result;
    } catch (error) {
      log.push({ ...record, ok: false, category: error?.category ?? null, message: String(error?.message ?? error).slice(0, 300) });
      throw error;
    }
  };
  return true;
}

/**
 * Instrument `WgslEmission.emit`, so a rejected variant is reported with the *request* that produced
 * it (define list, texture-unit count, layout samplers) instead of only the exception text.
 */
function instrumentShaderEmission(bundle, log) {
  const emission = bundle.wgslEmitter?.WgslEmission;
  if (emission === undefined || typeof emission.emit !== "function") return false;
  const original = emission.emit.bind(emission);
  emission.emit = (request) => {
    const record = {
      variantKey: request?.variantKey ?? null,
      defines: [...(request?.defines ?? [])],
      textureUnits: request?.textureUnits ?? null,
      samplerNames: (request?.layout?.samplers ?? []).map((sampler) => sampler.glslName ?? sampler.name ?? null),
      uniformFieldCount: request?.layout?.uniformBlock?.fields?.length ?? null,
      vertexTextBytes: request?.vertexGlsl?.length ?? null,
      fragmentTextBytes: request?.fragmentGlsl?.length ?? null,
      fragmentHead: String(request?.fragmentGlsl ?? "").replace(/\s+/g, " ").slice(0, 220),
      vertexHead: String(request?.vertexGlsl ?? "").replace(/\s+/g, " ").slice(0, 160),
    };
    try {
      const result = original(request);
      log.push({ ...record, ok: result?.ok === true, diagnostics: (result?.diagnostics ?? []).map((diagnostic) => String(diagnostic.message).slice(0, 200)) });
      return result;
    } catch (error) {
      log.push({ ...record, ok: false, error: String(error?.message ?? error).slice(0, 300) });
      throw error;
    }
  };
  return true;
}

/**
 * Wrap `Context.draw` so the **real terrain draws** can be inspected: which pipeline (if any), which
 * vertex layout, and which render state the logic layer actually asked for.
 */
function instrumentContextDraw(bundle, log, uniformTargets = [], pipelineRef = null, limit = 8) {
  const prototype = bundle.contextModule?.default?.prototype;
  if (prototype === undefined || typeof prototype.draw !== "function") return false;
  const original = prototype.draw;
  prototype.draw = function instrumentedDraw(command, passState, program, uniformMap) {
    let recordedIndex = -1;
    if (log.length < limit) {
      const renderState = command?.renderState ?? {};
      log.push({
        commandName: command?.constructor?.name ?? null,
        hasShaderProgram: command?.shaderProgram !== undefined || command?._shaderProgram !== undefined,
        shaderProgramVariant: (command?.shaderProgram ?? command?._shaderProgram)?.variantKey ?? null,
        pipelinePublished: (command?.shaderProgram ?? command?._shaderProgram)?.pipeline !== undefined,
        pipelineId: pipelineRef?.current?.idOf((command?.shaderProgram ?? command?._shaderProgram)?.pipeline) ?? null,
        vertexArray: command?.vertexArray === undefined ? null : {
          numberOfVertices: command.vertexArray.numberOfVertices ?? null,
          layout: (command.vertexArray.__webgpu?.vertexLayout ?? []).map((attribute) => ({ loc: attribute.index ?? attribute.location, comps: attribute.componentsPerAttribute, type: attribute.componentDatatype, offset: attribute.offsetInBytes, stride: attribute.strideInBytes, normalized: attribute.normalized })),
          indexed: command.vertexArray.__webgpu?.indexed ?? null,
        },
        count: command?.count ?? null,
        offset: command?.offset ?? null,
        renderState: {
          cull: renderState.cull ?? null,
          frontFace: renderState.frontFace ?? null,
          depthTest: renderState.depthTest ?? null,
          depthMask: renderState.depthMask ?? null,
          topology: renderState.topology ?? null,
          depthFormat: renderState.depthFormat ?? null,
          colorFormats: renderState.colorFormats ?? null,
          sampleCount: renderState.sampleCount ?? null,
        },
        passState: passState === undefined || passState === null ? null : { framebuffer: passState.framebuffer === undefined ? null : String(passState.framebuffer?.id ?? typeof passState.framebuffer), viewport: passState.viewport ?? null },
        rawVertexBuffers: (command?.vertexArray?.__webgpu?.vertexBuffers ?? []).map((binding) => ({ slot: binding.slot, buffer: binding.buffer, offset: binding.offset ?? 0, size: binding.size ?? null })),
        rawGpuVertexBuffers: (command?.vertexArray?.__webgpu?.gpuVertexBuffers ?? []).map((layout) => ({ arrayStride: layout.arrayStride, stepMode: layout.stepMode, attributes: layout.attributes.map((attribute) => ({ shaderLocation: attribute.shaderLocation, offset: attribute.offset, format: attribute.format })) })),
        rawIndexBuffer: command?.vertexArray?.__webgpu?.indexBuffer ?? null,
        uniformMapKeys: Object.keys(command?._uniformMap ?? command?.uniformMap ?? {}).slice(0, 16),
        // The frame this draw belongs to: the wrapper logs the **first** `limit` draws of the whole
        // session by default, which are the coarse ancestor tiles of the opening frames. A diagnosis of
        // a black *settled* frame has to look at the last frame's draws.
        frame: this.frameNumber ?? null,
        // The **same draw's** uniform values, invoked as `_setUniforms` invokes them (the callbacks
        // read `this`; entries the logic layer already resolved are plain objects/array-likes).
        uniformValues: (() => {
          const map = command?._uniformMap ?? command?.uniformMap ?? null;
          if (map === null || typeof map !== "object") return null;
          const normalise = (value) => {
            if (typeof value === "number") return Number(value);
            if (value === null || value === undefined) return null;
            if (ArrayBuffer.isView(value) || Array.isArray(value)) return Array.from(value).slice(0, 16).map((entry) => Number(entry));
            if (typeof value === "object") {
              if (typeof value.length === "number") return Array.from(value).slice(0, 16).map((entry) => Number(entry));
              const lanes = ["x", "y", "z", "w"].map((lane) => value[lane]);
              // A `Cartesian3` has no `w`, so the lane list is allowed to stop early — but the lanes it
              // does have must all be numbers.
              const present = lanes.filter((lane) => lane !== undefined);
              if (present.length >= 2 && present.every((lane) => typeof lane === "number")) return present;
              const colour = ["red", "green", "blue", "alpha"].map((lane) => value[lane]);
              if (colour.every((lane) => typeof lane === "number")) return colour;
            }
            return null;
          };
          const pick = (name) => {
            try {
              const candidate = map[name];
              return normalise(typeof candidate === "function" ? candidate.call(map) : candidate);
            } catch (error) {
              return `throws: ${String(error?.message ?? error).slice(0, 80)}`;
            }
          };
          return {
            u_center3D: pick("u_center3D"),
            u_tileRectangle: pick("u_tileRectangle"),
            u_modifiedModelView: pick("u_modifiedModelView"),
            u_modifiedModelViewProjection: pick("u_modifiedModelViewProjection"),
            u_minMaxHeight: pick("u_minMaxHeight"),
            u_initialColor: pick("u_initialColor"),
            u_southAndNorthLatitude: pick("u_southAndNorthLatitude"),
          };
        })(),
        programDynamicOffset: (command?.shaderProgram ?? command?._shaderProgram)?.uniformDynamicOffset ?? null,
      });
      // Non-serializable handles (the uniform ring's `GPUBuffer`) live in a side list: putting them in
      // the report would make it circular (measured: `JSON.stringify` on the program object fails).
      const probeProgram = command?.shaderProgram ?? command?._shaderProgram;
      if (uniformTargets.length < 4 && typeof probeProgram?.gpuUniformStaging === "function") {
        const staging = probeProgram.gpuUniformStaging();
        uniformTargets.push({
          buffer: staging.buffer,
          label: String(probeProgram.id),
          // Every member, with the offsets the WGSL `struct` was generated with: the W5 root-cause probe
          // has to name a float it read out of the block, not guess which of 53 members it belongs to.
          members: (probeProgram.layout?.members ?? []).map((member) => ({
            name: member.name,
            byteOffset: member.byteOffset,
            glslType: member.glslType,
            scalar: member.scalar,
            components: member.components,
            columns: member.columns,
            length: member.length,
            scalarOffsets: [...(member.scalarOffsets ?? [])],
          })),
          structSize: probeProgram.layout?.structSize ?? null,
          variantKey: probeProgram.variantKey ?? null,
          defines: [...(probeProgram.defines ?? [])],
          vertexModule: typeof probeProgram.wgsl?.vertexModule === "string" ? probeProgram.wgsl.vertexModule : null,
          fragmentModule: typeof probeProgram.wgsl?.fragmentModule === "string" ? probeProgram.wgsl.fragmentModule : null,
          // Live references; the scenario snapshots their state **after** the frames, because this wrapper
          // runs before `Context.draw` and would otherwise only see pre-draw values.
          program: probeProgram,
          gpuStaging: staging,
        });
      }
      recordedIndex = log.length - 1;
    }
    const recorded = recordedIndex;
    const result = original.call(this, command, passState, program, uniformMap);
    if (recorded >= 0) {
      // `_setUniforms` has run by now, so the command's own ring slot is known — the matrix the shader
      // reads lives at that offset, not at the one visible before the call.
      log[recorded].programDynamicOffsetAfter = (command?.shaderProgram ?? command?._shaderProgram)?.uniformDynamicOffset ?? null;
    }
    return result;
  };
  return true;
}

/**
 * Read the presented frame back **on the GPU side** (`copyTextureToBuffer` of the resolved canvas
 * texture), bypassing `createImageBitmap`, which W2 measured to be a platform blind spot on a WebGPU
 * canvas. This is debug evidence for the W5 terrain work: it distinguishes "the compositor did not
 * show the frame" from "the frame really is black".
 */
function enableFrameReadback(bundle, canvas, context) {
  const gpuContext = canvas.getContext("webgpu");
  const device = context.device;
  if (gpuContext === null || device === undefined) return null;
  // Tag every texture the canvas hands out, so "the frame was rendered into the texture we copied" is a
  // measured fact rather than an assumption.
  const originalGetCurrentTexture = gpuContext.getCurrentTexture.bind(gpuContext);
  let textureCounter = 0;
  gpuContext.getCurrentTexture = () => {
    const texture = originalGetCurrentTexture();
    if (texture !== undefined && texture !== null && texture.__probeTextureId === undefined) {
      Object.defineProperty(texture, "__probeTextureId", { value: (textureCounter += 1), enumerable: false });
    }
    return texture;
  };
  const textureIds = [];
  const width = canvas.width;
  const height = canvas.height;
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({ label: "probe-frame-readback", size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  let pending = null;
  let armed = false;
  const original = context.endFrame.bind(context);
  context.endFrame = () => {
    if (armed) {
      armed = false;
      try {
        const texture = gpuContext.getCurrentTexture();
        textureIds.push({ id: texture.__probeTextureId ?? null, frames: context.counters.frames, passes: context.counters.passes, submits: context.counters.submittedCommandBuffers });
        const encoder = device.createCommandEncoder({ label: "probe-frame-copy" });
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
        // The copy MUST be submitted **after** the frame's own commands: submitting it first reads the
        // texture before anything has been rendered into it (the first version did exactly that and
        // reported an all-zero frame for a canvas that was in fact fully covered).
        const finish = () => {
          device.queue.submit([encoder.finish()]);
          pending = buffer.mapAsync(GPUMapMode.READ);
        };
        original();
        finish();
        return;
      } catch (error) {
        step("frame-readback-failed", { message: String(error?.message ?? error).slice(0, 200) });
      }
    }
    return original();
  };
  return {
    textureIds,
    arm() {
      armed = true;
    },
    async read() {
      if (pending === null) return null;
      await pending;
      await context.device.queue.onSubmittedWorkDone();
      const range = new Uint8Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      pending = null;
      let nonBlack = 0;
      let nonTransparent = 0;
      let maxChannel = 0;
      const colours = new Set();
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = y * bytesPerRow + x * 4;
          const r = range[offset];
          const g = range[offset + 1];
          const b = range[offset + 2];
          const a = range[offset + 3];
          if (r + g + b > 24) nonBlack += 1;
          if (a > 8) nonTransparent += 1;
          if (Math.max(r, g, b) > maxChannel) maxChannel = Math.max(r, g, b);
          if (colours.size < 256) colours.add(`${r},${g},${b},${a}`);
        }
      }
      const centreOffset = Math.floor(height / 2) * bytesPerRow + Math.floor(width / 2) * 4;
      // A coarse coverage map + the bounding box of the non-background pixels: "how many pixels" alone
      // cannot tell a full screen from a small patch in one corner (W5).
      const cellsX = 12;
      const cellsY = 9;
      const cells = new Array(cellsX * cellsY).fill(0);
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = y * bytesPerRow + x * 4;
          if (range[offset] + range[offset + 1] + range[offset + 2] <= 24) continue;
          cells[Math.min(cellsY - 1, Math.floor((y / height) * cellsY)) * cellsX + Math.min(cellsX - 1, Math.floor((x / width) * cellsX))] += 1;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      return {
        width,
        height,
        nonBlackPixels: nonBlack,
        nonTransparentPixels: nonTransparent,
        maxChannel,
        // INSTRUMENT: the raw bytes of `copyTextureToBuffer` on the acquired canvas texture (bgra8unorm)
        // — what the GPU rendered, **not** the compositor's PNG. Counting stops at `colourCountCap`, so a
        // saturated count means ">= cap", never "exactly cap". This number MUST NOT be compared with the
        // harness screenshot's `uniqueColours`: that one goes through the compositor's colour conversion
        // (measured: a canvas texture that is a single colour, `uniqueColoursGpuReadback = 1`, yields a
        // saturated `uniqueColoursComposite` in the PNG of the very same frame).
        colourCountInstrument: "gpu-readback:copyTextureToBuffer(canvas texture, raw bgra8unorm bytes)",
        colourCountCap: 256,
        colourCountSaturated: colours.size >= 256,
        uniqueColoursGpuReadback: colours.size,
        uniqueColours: colours.size,
        centre: [range[centreOffset], range[centreOffset + 1], range[centreOffset + 2], range[centreOffset + 3]],
        nonBlackBoundingBox: maxX < 0 ? null : { minX, minY, maxX, maxY },
        coverageCells: cells,
        coverageCellsShape: [cellsX, cellsY],
      };
    },
  };
}

/**
 * Temporary W5 bisect: force pipeline-state overrides so a black frame can be attributed
 * (`cullMode:"none"` isolates winding/culling; `depthCompare:"always"` isolates the depth test).
 */
function overridePipelineState(bundle, { cullNone = false, depthAlways = false, log = null } = {}) {
  const prototype = bundle.renderStateModule?.default?.prototype;
  if (prototype === undefined || typeof prototype.toPipelineState !== "function") return false;
  const original = prototype.toPipelineState;
  prototype.toPipelineState = function instrumentedPipelineState(passState) {
    const state = original.call(this, passState);
    if (log !== null && log.length < 4) log.push({ cullMode: state.primitive.cullMode, frontFace: state.primitive.frontFace, depthCompare: state.depthStencil.depthCompare, depthWriteEnabled: state.depthStencil.depthWriteEnabled, depthFormat: state.depthStencil.format, samples: state.multisample.count, targets: state.targets.length, topology: state.primitive.topology });
    if (!cullNone && !depthAlways) return state;
    return {
      ...state,
      primitive: { ...state.primitive, ...(cullNone ? { cullMode: "none" } : {}) },
      depthStencil: { ...state.depthStencil, ...(depthAlways ? { depthCompare: "always" } : {}) },
    };
  };
  return true;
}

/**
 * `canvas-depth-probe` — W5 sanity check of the **canvas pass**: a known triangle, drawn through the
 * replacement `Context` with the depth-tested render state the terrain uses, read back on the GPU.
 *
 * It separates "the canvas pass cannot present a depth-tested draw" from "the terrain shader/geometry
 * produces nothing" — indistinguishable from a black screenshot alone.
 */
async function scenarioCanvasDepthProbe(bundle, canvas) {
  const { adapter, device } = await prefetchDevice();
  report.environment = { adapterInfo: adapter.info ?? null, preferredFormat: navigator.gpu.getPreferredCanvasFormat() };
  bundle.deviceHandoff.resetSlot();
  bundle.deviceHandoff.install({ adapter, device, limits: adapter.limits, features: adapter.features, source: "canvas-depth-probe" });
  const context = new bundle.Context(canvas, {});
  step("construct-context", { constructor: context?.constructor?.name ?? null, sampleCount: context.sampleCount, swapchainFormat: context.swapchainFormat });

  const readback = enableFrameReadback(bundle, canvas, context);
  const resources = createTriangleResources(device, context.swapchainFormat);
  const renderState = { depthTest: { enabled: true, func: 0x0201 }, depthMask: true, cull: { enabled: false } };
  const inputs = { ...drawInputsFor(resources, { sampleCount: context.sampleCount, colorFormats: [context.swapchainFormat], depthFormat: "depth24plus-stencil8" }), renderState };

  const renderFrame = () => {
    context.beginFrame();
    context.clear({ color: { red: 0.05, green: 0.05, blue: 0.15, alpha: 1 } }, {});
    context.draw({ __webgpu: inputs, count: 3, renderState }, {});
    context.endFrame();
  };
  renderFrame();
  await context.awaitFrameErrors();
  readback.arm();
  renderFrame();
  await context.awaitFrameErrors();
  const frame = await readback.read();
  step("canvas-depth-frame", { frame, frameErrors: context.frameErrors(), counters: { ...context.counters } });

  const result = {
    backend,
    sampleCount: context.sampleCount,
    swapchainFormat: context.swapchainFormat,
    frame,
    frameErrors: context.frameErrors(),
    passes: context.lastFramePasses().map((pass) => ({ index: pass.index, keyText: pass.keyText, drawOps: pass.drawOps, clearOps: pass.clearOps, sampleCount: pass.sampleCount })),
  };
  return { result, context };
}

/**
 * Record the derived pass/work order of every frame (W5 diagnosis): a clear that lands **after** the
 * terrain draws reopens the GPU pass with `loadOp: "clear"` and erases them, which is invisible in a
 * screenshot that only shows the final state.
 */
function recordFramePasses(context, log, limit = 6) {
  const original = context.endFrame.bind(context);
  context.endFrame = () => {
    const result = original();
    if (log.length < limit) {
      log.push(
        context.lastFramePasses().map((pass) => ({
          clearOps: pass.clearOps,
          drawOps: pass.drawOps,
          gpuPassCount: pass.gpuPassCount,
          workOrder: (pass.workOps ?? []).map((op) => op.kind).join(","),
        })),
      );
    }
    return result;
  };
  return true;
}

/**
 * Record the **actual** bindings of every indexed draw on the canvas pass (W5 root cause).
 *
 * Everything upstream of this point is intent: the command's vertex array, the program's bind group,
 * the pipeline cache. This wraps the real `GPURenderPassEncoder` the context opened, so the log is what
 * the GPU was told — pipeline, vertex buffers (with their labels and sizes), index buffer, bind groups
 * and dynamic offsets.
 */
function instrumentPassEncoders(log, limit = 40) {
  const prototype = globalThis.GPUCommandEncoder?.prototype;
  if (prototype === undefined || typeof prototype.beginRenderPass !== "function") return false;
  const originalBeginRenderPass = prototype.beginRenderPass;
  prototype.beginRenderPass = function instrumentedBeginRenderPass(descriptor) {
    const encoder = originalBeginRenderPass.call(this, descriptor);
    const bound = { pipeline: null, vertexBuffers: [], bindGroups: [], indexBuffer: null };
    const originalSetPipeline = encoder.setPipeline.bind(encoder);
    encoder.setPipeline = (pipeline) => {
      bound.pipeline = pipeline;
      return originalSetPipeline(pipeline);
    };
    const originalSetVertexBuffer = encoder.setVertexBuffer.bind(encoder);
    encoder.setVertexBuffer = (slot, buffer, offset, size) => {
      bound.vertexBuffers[slot] = { label: buffer?.label ?? null, size: buffer?.size ?? null, offset: offset ?? 0, size_parameter: size ?? null };
      return originalSetVertexBuffer(slot, buffer, offset, size);
    };
    const originalSetBindGroup = encoder.setBindGroup.bind(encoder);
    encoder.setBindGroup = (index, group, offsets) => {
      bound.bindGroups[index] = { offsets: offsets === undefined ? null : [...offsets] };
      return originalSetBindGroup(index, group, offsets);
    };
    const originalSetIndexBuffer = encoder.setIndexBuffer.bind(encoder);
    encoder.setIndexBuffer = (buffer, format, offset, size) => {
      bound.indexBuffer = { label: buffer?.label ?? null, size: buffer?.size ?? null, format, offset: offset ?? 0, size_parameter: size ?? null };
      return originalSetIndexBuffer(buffer, format, offset, size);
    };
    const originalDrawIndexed = encoder.drawIndexed.bind(encoder);
    encoder.drawIndexed = (indexCount, instanceCount, firstIndex, baseVertex, firstInstance) => {
      if (log.length < limit) {
        log.push({
          indexCount: indexCount ?? null,
          instanceCount: instanceCount ?? null,
          firstIndex: firstIndex ?? 0,
          baseVertex: baseVertex ?? 0,
          firstInstance: firstInstance ?? 0,
          pipelineLabel: bound.pipeline?.label ?? null,
          pipelineId: bound.pipeline?.__probePipelineId ?? null,
          vertexBuffers: bound.vertexBuffers.map((binding) => (binding === undefined ? null : { ...binding })),
          indexBuffer: bound.indexBuffer === null ? null : { ...bound.indexBuffer },
          bindGroups: bound.bindGroups.map((group) => (group === undefined ? null : { ...group })),
        });
      }
      return originalDrawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
    };
    return encoder;
  };
  return true;
}

/**
 * Record every `queue.writeBuffer` with the **CPU-side bytes** that were handed to it (W5 diagnosis).
 *
 * The vertex read-back says what the GPU holds; this says what the backend uploaded. When the two
 * disagree the upload path is at fault; when they agree the data never was what the shader needed.
 * Test-side only: it wraps the probe's own device.
 */
function instrumentBufferUploads(device, log, limit = 600) {
  const labels = new WeakMap();
  const originalCreate = device.createBuffer.bind(device);
  device.createBuffer = (descriptor) => {
    const buffer = originalCreate(descriptor);
    labels.set(buffer, descriptor?.label ?? null);
    return buffer;
  };
  const originalWrite = device.queue.writeBuffer.bind(device.queue);
  device.queue.writeBuffer = (buffer, bufferOffset, data, dataOffset, size) => {
    if (log.length < limit && ArrayBuffer.isView(data)) {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, 64));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const floats = [];
      for (let offset = 0; offset + 4 <= bytes.byteLength && floats.length < 16; offset += 4) floats.push(Number(view.getFloat32(offset, true).toPrecision(9)));
      log.push({
        buffer,
        label: labels.get(buffer) ?? null,
        bufferOffset,
        dataOffset: dataOffset ?? null,
        size: size ?? null,
        byteLength: data.byteLength,
        typedArray: data.constructor?.name ?? null,
        viewByteOffset: data.byteOffset,
        firstFloats: floats,
      });
    }
    return originalWrite(buffer, bufferOffset, data, dataOffset, size);
  };
  return { log, labelOf: (buffer) => labels.get(buffer) ?? null };
}

/**
 * Record every `createRenderPipeline` descriptor, and tag the pipeline so a draw can name the exact one
 * it used (W5 diagnosis).
 *
 * The vertex fetch layout, the cull mode and the depth state are baked into the pipeline; the command's
 * own vertex array says nothing about what the GPU was actually told to read.
 */
function instrumentPipelines(device, log, limit = 120) {
  const original = device.createRenderPipeline.bind(device);
  let nextId = 0;
  device.createRenderPipeline = (descriptor) => {
    const pipeline = original(descriptor);
    const id = (nextId += 1);
    try {
      Object.defineProperty(pipeline, "__probePipelineId", { value: id, enumerable: false });
    } catch {
      // A frozen pipeline object would only cost the id, never the descriptor record below.
    }
    if (log.length < limit) {
      log.push({
        id,
        label: descriptor?.label ?? null,
        vertexEntryPoint: descriptor?.vertex?.entryPoint ?? null,
        fragmentEntryPoint: descriptor?.fragment?.entryPoint ?? null,
        vertexBuffers: (descriptor?.vertex?.buffers ?? []).map((buffer) => ({
          arrayStride: buffer.arrayStride,
          stepMode: buffer.stepMode ?? "vertex",
          attributes: (buffer.attributes ?? []).map((attribute) => ({ shaderLocation: attribute.shaderLocation, offset: attribute.offset, format: attribute.format })),
        })),
        colorFormats: (descriptor?.fragment?.targets ?? []).map((target) => target.format),
        topology: descriptor?.primitive?.topology ?? null,
        cullMode: descriptor?.primitive?.cullMode ?? "none",
        frontFace: descriptor?.primitive?.frontFace ?? null,
        depthFormat: descriptor?.depthStencil?.format ?? null,
        depthWriteEnabled: descriptor?.depthStencil?.depthWriteEnabled ?? null,
        depthCompare: descriptor?.depthStencil?.depthCompare ?? null,
        depthBias: descriptor?.depthStencil?.depthBias ?? null,
        depthBiasSlopeScale: descriptor?.depthStencil?.depthBiasSlopeScale ?? null,
        depthBiasClamp: descriptor?.depthStencil?.depthBiasClamp ?? null,
        stencilFront: descriptor?.depthStencil?.stencilFront ?? null,
        targetWriteMasks: (descriptor?.fragment?.targets ?? []).map((target) => target.writeMask ?? 0xf),
        targetBlend: (descriptor?.fragment?.targets ?? []).map((target) => target.blend ?? null),
        sampleCount: descriptor?.multisample?.count ?? 1,
      });
    }
    return pipeline;
  };
  return { log, idOf: (pipeline) => (pipeline === undefined || pipeline === null ? null : pipeline.__probePipelineId ?? null) };
}

/**
 * Force `COPY_SRC` on every buffer the backend creates, so a terrain vertex/index buffer can be read
 * back and decoded (W5 diagnosis). Test-side only: it only widens the usage flags of the probe's own
 * device.
 */
function enableBufferReadback(device) {
  const original = device.createBuffer.bind(device);
  device.createBuffer = (descriptor) => {
    const usage = (descriptor?.usage ?? 0) | GPUBufferUsage.COPY_SRC;
    return original({ ...descriptor, usage });
  };
  // The staging buffers are created through the **unpatched** entry point: a `MAP_READ | COPY_DST`
  // buffer must not be forced to carry the readback flag as well.
  const createStaging = (label, size) => original({ label, size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const readFloats = async (buffer, floatCount, byteOffset = 0) => {
    const byteLength = floatCount * 4;
    const size = Math.ceil(byteLength / 4) * 4;
    const staging = createStaging("probe-readback", size);
    device.pushErrorScope("validation");
    const encoder = device.createCommandEncoder({ label: "probe-buffer-copy" });
    encoder.copyBufferToBuffer(buffer, byteOffset, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    const scopeError = await device.popErrorScope();
    if (scopeError !== null) throw new Error(`copyBufferToBuffer(${size} B from ${buffer.size} B buffer, usage ${buffer.usage}): ${scopeError.message}`);
    await staging.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    const view = new DataView(bytes.buffer);
    return Array.from({ length: floatCount }, (_, index) => view.getFloat32(index * 4, true));
  };
  const readUint16 = async (buffer, count) => {
    const size = Math.ceil((count * 2) / 4) * 4;
    const staging = createStaging("probe-readback-index", size);
    const encoder = device.createCommandEncoder({ label: "probe-buffer-copy-index" });
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    const view = new DataView(bytes.buffer);
    return Array.from({ length: count }, (_, index) => view.getUint16(index * 2, true));
  };
  return { readFloats, readUint16, createStaging };
}

/**
 * Record any uniform member whose value reaches the encoder as a **function** (W5 diagnosis): upstream
 * stores `() => value` callbacks in `command.uniformMap`, so a function here means the callback was
 * never invoked.
 */
function instrumentUniformValues(bundle, log, limit = 6) {
  const target = bundle.uniformWriter?.MemberWriteTarget;
  if (target?.prototype?.set === undefined) return false;
  const original = target.prototype.set;
  target.prototype.set = function instrumentedSet(value) {
    if (typeof value === "function" && log.length < limit) {
      log.push({ member: this.field?.name ?? null, kind: "function", source: String(value).replace(/\s+/g, " ").slice(0, 120) });
    }
    return original.call(this, value);
  };
  return true;
}

/** Record every clear of the frame (W5 diagnosis): the last one before the draws decides the pixels. */
function instrumentContextClear(bundle, log, limit = 12) {
  const prototype = bundle.contextModule?.default?.prototype;
  if (prototype === undefined || typeof prototype.clear !== "function") return false;
  const original = prototype.clear;
  prototype.clear = function instrumentedClear(command, passState) {
    if (log.length < limit) {
      const color = command?.color ?? command?.clearColor ?? null;
      log.push({
        color: color === null ? null : { red: color.red ?? null, green: color.green ?? null, blue: color.blue ?? null, alpha: color.alpha ?? null },
        depth: command?.depth ?? null,
        stencil: command?.stencil ?? null,
        mechanism: null,
      });
      const mechanism = original.call(this, command, passState);
      log[log.length - 1].mechanism = mechanism;
      return mechanism;
    }
    return original.call(this, command, passState);
  };
  return true;
}

/**
 * Read the canvas depth buffer back and count the pixels any geometry reached.
 *
 * This is the measurement that separates "nothing rasterised" from "everything rasterised black":
 * a colour-only read-back cannot tell those apart (W5). It requires a single-sampled canvas pass,
 * because a multisampled depth texture cannot be copied.
 */
async function readCanvasDepth(context, canvas, createStaging, options = {}) {
  const device = context.device;
  const texture = context.canvasDepthTexture();
  if (texture === undefined || texture === null) return { skipped: "no canvas depth texture" };
  // MEASURED LIMITATION, and the reason this is gated rather than attempted (Chrome 153, Windows,
  // RTX 4080 SUPER): **no** legal copy exists for the canvas depth attachment of this scene.
  //   - multisampled path (the MVP default): "sample count (4) is not 1 when copying to or from a
  //     buffer" — a validation rule, independent of driver;
  //   - single-sampled path (`?samples=1`): "The depth aspect of [Texture
  //     \"cesium-webgpu:canvas-depth-stencil\"] format TextureFormat::Depth24PlusStencil8 cannot be
  //     selected in a texture to buffer copy." — the spec allows it, this Chrome does not implement it.
  // Attempting the copy anyway raises an *uncaptured* WebGPU error, which the backend reports at frame
  // end by design (research §6.2: a GPU error is never swallowed), and that in turn made every suite
  // running this probe fail on a page error the probe itself provoked. Verified as the cause, not
  // assumed: the error message is a texture-copy validation message and the two paths were measured
  // separately (see `docs/gate-g*-conclusion.md` for the depth evidence actually used, which is the
  // depth-test indicator below — `createDepthIndicatorResources`).
  // The copy is kept behind an explicit opt-in so a future browser that implements the depth-aspect
  // copy needs no new code, only `{ attempt: true }`.
  if (options.attempt !== true) {
    return {
      measurable: false,
      reason: "copyTextureToBuffer cannot select the depth aspect of this canvas texture on Chrome 153 (measured); depth presence is proven through the depth test instead",
      sampleCount: context.sampleCount,
      textureFormat: texture.format ?? null,
    };
  }
  const width = canvas.width;
  const height = canvas.height;
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = createStaging === null || createStaging === undefined
    ? device.createBuffer({ label: "probe-depth-readback", size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    : createStaging("probe-depth-readback", bytesPerRow * height);
  const encoder = device.createCommandEncoder({ label: "probe-depth-copy" });
  // A combined depth-stencil texture MUST be copied aspect by aspect (`"all"` is a validation error).
  encoder.copyTextureToBuffer({ texture, aspect: "depth-only" }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const view = new DataView(bytes.buffer);
  let pixelsWithGeometry = 0;
  let nearestDepth = 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      const word = view.getUint32(offset, true);
      // depth24plus-stencil8: the depth occupies the low 24 bits of the word.
      const depth = (word & 0xffffff) / 0xffffff;
      if (depth < 0.999999) pixelsWithGeometry += 1;
      if (depth < nearestDepth) nearestDepth = depth;
    }
  }
  return { width, height, pixelsWithGeometry, nearestDepth: Number(nearestDepth.toFixed(6)), sampleCount: context.sampleCount };
}

/** Tile — degrees for the geographic scheme (level 0 = 2 tiles in x, 1 in y). */
function heightmapTileRectangle(x, y, level) {
  const width = 360 / 2 ** (level + 1);
  const height = 180 / 2 ** level;
  return { west: -180 + x * width, east: -180 + (x + 1) * width, north: 90 - y * height, south: 90 - (y + 1) * height };
}

/**
 * An analytic height field over the fixture's coverage (Mont Blanc), used by the ordering probe so
 * the scene's *configuration* and framebuffer request path are exercised without depending on the
 * committed dataset (T084/T085 land it separately). Row 0 is the northernmost row, as upstream's
 * `HeightmapTerrainData` expects.
 */
function analyticHeightmap(bundle, width, height, centre) {
  const sample = new Float32Array(width * height);
  return (x, y, level) => {
    const rectangle = heightmapTileRectangle(x, y, level);
    for (let row = 0; row < height; row += 1) {
      const latitude = rectangle.north + ((rectangle.south - rectangle.north) * row) / (height - 1);
      for (let column = 0; column < width; column += 1) {
        const longitude = rectangle.west + ((rectangle.east - rectangle.west) * column) / (width - 1);
        const east = (longitude - centre.longitude) * 77.6;
        const north = (latitude - centre.latitude) * 111.2;
        const distance = Math.sqrt(east * east + north * north);
        sample[row * width + column] = Math.max(-120, 4810 - 32 * distance);
      }
    }
    return sample;
  };
}

/**
 * The MVP terrain scene: the frozen scene configuration (`baseLayer:false`, `skyBox:false`,
 * `skyAtmosphere:false`, no post-processing, `logarithmicDepthBuffer:false`) plus a real heightmap
 * terrain provider, `globe.enableLighting = true`, a fixed camera and a manual render loop.
 *
 * The upstream `Scene` is constructed **directly** rather than through `CesiumWidget`: the widget
 * also creates a `Sun` and a `Moon`, and `Moon` fetches `Assets/Textures/moonSmall.jpg` — an external
 * asset request the offline contract (T087) forbids and whose failure is an uncaught
 * `RequestErrorEvent` (measured). Building the scene directly means those objects are never created,
 * which is the strongest form of the pinned `false` flags.
 *
 * Returns the report plus the live scene so a caller can keep rendering (the suites do).
 */
async function buildTerrainScene(bundle, canvas, options = {}) {
  const isWebgpu = backend !== "webgl2";
  const framebufferUpdates = [];
  const requestedTiles = [];
  const renderErrors = [];
  const emissionLog = [];
  const instrumented = instrumentFramebufferManager(bundle, framebufferUpdates);
  const emissionInstrumented = instrumentShaderEmission(bundle, emissionLog);
  const drawLog = [];
  const uniformTargets = [];
  const clearLog = [];
  instrumentContextClear(bundle, clearLog, 12);
  const pipelineRef = { current: null };
  const drawInstrumented = instrumentContextDraw(bundle, drawLog, uniformTargets, pipelineRef);
  const pipelineStateLog = [];
  const uniformValueLog = [];
  instrumentUniformValues(bundle, uniformValueLog);
  const pipelineOverridden = overridePipelineState(bundle, { cullNone: options.cullNone === true || params.get("cull") === "none", depthAlways: params.get("depth") === "always", log: pipelineStateLog });

  if (isWebgpu) {
    const { adapter, device } = await prefetchDevice();
    report.environment = { adapterInfo: adapter.info ?? null, preferredFormat: navigator.gpu.getPreferredCanvasFormat() };
    bundle.deviceHandoff.resetSlot();
    bundle.deviceHandoff.install({ adapter, device, limits: adapter.limits, features: adapter.features, source: "terrain" });
  } else {
    report.environment = { adapterInfo: null, preferredFormat: null };
  }

  const provider =
    options.provider ??
    (options.ellipsoidProvider === true
      ? new bundle.EllipsoidTerrainProvider()
      : new bundle.CustomHeightmapTerrainProvider({
          width: 65,
          height: 65,
          tilingScheme: new bundle.GeographicTilingScheme(),
          credit: "ordering probe: analytic height field (no external data source)",
          callback: (x, y, level) => {
            requestedTiles.push(`${level}/${x}/${y}`);
            return analyticHeightmap(bundle, 65, 65, options.centre ?? { longitude: 6.8652, latitude: 45.8326 })(x, y, level);
          },
        }));

  bundle.sceneOptions.assertMvpSceneOptions();
  const widgetOptions = bundle.sceneOptions.MVP_SCENE_CONFIGURATION.widgetOptions;
  const sceneOptions = bundle.sceneOptions.MVP_SCENE_CONFIGURATION.sceneOptions;
  for (const flag of ["baseLayer", "skyBox", "skyAtmosphere"]) {
    if (widgetOptions[flag] !== false) throw new Error(`${flag} MUST be pinned false`);
  }
  const scene = new bundle.Scene({
    canvas,
    contextOptions: options.singleSample === true ? { ...sceneOptions.contextOptions, msaaSamples: 1 } : sceneOptions.contextOptions,
    scene3DOnly: sceneOptions.scene3DOnly,
    requestRenderMode: false,
  });
  // `Scene` does not take `logarithmicDepthBuffer` as a constructor option (it starts from the static
  // `Scene.defaultLogDepthBuffer`, which upstream sets to `true`, gated by `context.fragmentDepth`), so
  // the pinned value is applied through the documented setter before the first frame.
  scene.logarithmicDepthBuffer = sceneOptions.logarithmicDepthBuffer;
  // The three pinned flags are realised by *not constructing* the corresponding objects; the globe is
  // the only scene content, with lighting on (the MVP set).
  const globe = new bundle.Globe();
  scene.globe = globe;
  if (options.globeHidden === true) globe.show = false;
  globe.enableLighting = options.lightingOff === true ? false : bundle.sceneOptions.MVP_GLOBE_OPTIONS.enableLighting;
  globe.depthTestAgainstTerrain = bundle.sceneOptions.MVP_GLOBE_OPTIONS.depthTestAgainstTerrain;
  scene.terrainProvider = provider;
  if (scene.logarithmicDepthBuffer !== false) throw new Error("the scene turned the logarithmic depth buffer back on");
  const camera = options.camera ?? { longitude: 6.8652, latitude: 45.8326, height: 24000, heading: 0, pitch: -50, roll: 0 };
  scene.camera.setView({
    destination: bundle.Cartesian3.fromDegrees(camera.longitude, camera.latitude, camera.height),
    orientation: {
      heading: bundle.Math.toRadians(camera.heading),
      pitch: bundle.Math.toRadians(camera.pitch),
      roll: bundle.Math.toRadians(camera.roll),
    },
  });
  step("construct-scene", { contextConstructor: scene.context?.constructor?.name ?? null, backend, latitude: camera.latitude });
  const readback = options.readback === true && isWebgpu ? enableFrameReadback(bundle, canvas, scene.context) : null;
  // Installed **before** the terrain tiles are requested, so the upload records exist for the buffers
  // the draws later name.
  const uploads = options.uploadLog === true && isWebgpu ? instrumentBufferUploads(scene.context.device, []) : null;
  const pipelineLog = options.pipelineLog === true && isWebgpu ? instrumentPipelines(scene.context.device, []) : null;
  pipelineRef.current = pipelineLog;
  const drawBindings = options.pipelineLog === true && isWebgpu ? [] : null;
  const drawBindingsInstrumented = drawBindings === null ? false : instrumentPassEncoders(drawBindings);
  const bufferReadback = options.bufferReadback === true && isWebgpu ? enableBufferReadback(scene.context.device) : null;
  const bufferReadbackStaging = bufferReadback?.createStaging ?? null;
  const framePassLog = [];
  if (isWebgpu) recordFramePasses(scene.context, framePassLog, options.recordFrames ?? 6);
  scene.renderError.addEventListener((_scene, error) => {
    renderErrors.push({ name: error?.name ?? "Error", category: error?.category ?? null, message: String(error?.message ?? error).slice(0, 400), stack: String(error?.stack ?? "").split("\n").slice(0, 6).join(" | ") });
  });

  const frameErrors = [];
  const frameTimesMs = [];
  const renderFrames = async (count, settleMs = 12) => {    for (let index = 0; index < count; index += 1) {
      const started = performance.now();
      try {
        scene.initializeFrame();
        scene.render(bundle.JulianDate.fromIso8601("2026-03-20T12:00:00Z"));
      } catch (error) {
        frameErrors.push({ frame: index, name: error?.name ?? "Error", category: error?.category ?? null, message: String(error?.message ?? error).slice(0, 400) });
        throw error;
      }
      frameTimesMs.push(performance.now() - started);
      if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
  };

  /**
   * Forget the recorded draws (and the uniform targets they named), so the **next** frame's draws are
   * the ones the probe inspects. Without it the log holds the session's opening frames, whose tiles are
   * the coarse ancestors still on screen while the fine tiles load — a different tile than the settled
   * frame draws (measured: the opening draws are level-0 tiles, the settled frame draws finer ones).
   */
  const resetDrawLog = () => {
    drawLog.length = 0;
    uniformTargets.length = 0;
    if (drawBindings !== null) drawBindings.length = 0;
    // The pipeline log is deliberately **not** cleared: the programs of the opening frames built their
    // pipelines then, and the settled frame reuses them — clearing it would lose the descriptor the
    // settled frame's draws actually used.
  };

  return { scene, globe, provider, renderFrames, frameErrors, renderErrors, frameTimesMs, framebufferUpdates, requestedTiles, emissionLog, emissionInstrumented, drawLog, drawInstrumented, pipelineStateLog, pipelineOverridden, framePassLog, readback, bufferReadback, bufferReadbackStaging, uniformValueLog, uniformTargets, clearLog, instrumented, isWebgpu, uploads, pipelineLog, drawBindings, drawBindingsInstrumented, resetDrawLog };
}

/** Wait until the globe reports every visible tile loaded, or the budget runs out. */
async function renderUntilTilesLoaded(terrain, budgetMs = 30000) {
  const started = Date.now();
  let frames = 0;
  while (Date.now() - started < budgetMs) {
    await terrain.renderFrames(1, 16);
    frames += 1;
    if (terrain.scene.globe.tilesLoaded === true && frames > 4) break;
  }
  return { frames, tilesLoaded: terrain.scene.globe.tilesLoaded === true, elapsedMs: Date.now() - started };
}
/**
 * `terrain-probe` — the Phase 7 opening measurement plus the terrain-ready evidence.
 *
 * Reports: every `FramebufferManager.update` of the run (with its attachment shape and whether the
 * slice-A degradation refused it), the tile statistics, the context counters, the elevation range
 * actually handed to the globe, and the presented pixels.
 */
async function scenarioTerrainProbe(bundle, canvas) {
  const cameraVariant = params.get("camera");
  const camera =
    cameraVariant === "far"
      ? { longitude: 6.8652, latitude: 45.8326, height: 20000000, heading: 0, pitch: -90, roll: 0 }
      : cameraVariant === "close"
        ? { longitude: 6.8652, latitude: 45.8326, height: 3000, heading: 0, pitch: -30, roll: 0 }
        : undefined;
  const terrain = await buildTerrainScene(bundle, canvas, {
    readback: true,
    bufferReadback: true,
    singleSample: params.get("samples") === "1",
    cullNone: params.get("cull") === "none",
    lightingOff: params.get("lighting") === "off",
    globeHidden: params.get("globe") === "hidden",
    ellipsoidProvider: params.get("provider") === "ellipsoid",
    ...(camera === undefined ? {} : { camera }),
  });
  const load = await renderUntilTilesLoaded(terrain);
  step("tiles-loaded", load);
  // The compositor needs more than one frame on a WebGPU canvas (W2's measurement: "a single frame is
  // not reliably composited into the screenshot — partial tiles stay black"), so settle before the
  // harness takes its canvas screenshot.
  await terrain.renderFrames(3, 16);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  let gpuFrame = null;
  let depthFrame = null;
  let overlayFrame = null;
  if (terrain.readback !== null) {
    terrain.readback.arm();
    await terrain.renderFrames(1, 16);
    gpuFrame = await terrain.readback.read();
    depthFrame = await readCanvasDepth(terrain.scene.context, canvas, terrain.bufferReadbackStaging);
    // Control experiment: draw a known full-viewport triangle through the **same** context right after
    // the terrain frames. If it appears and the terrain does not, the canvas/present path is fine and the
    // terrain draw itself produces nothing; if it does not appear either, the frame is not reaching the
    // canvas at all.
    const controlContext = terrain.scene.context;
    const controlResources = createTriangleResources(controlContext.device, controlContext.swapchainFormat);
    const controlRenderState = { depthTest: { enabled: false }, depthMask: false, cull: { enabled: false } };
    const controlInputs = {
      ...drawInputsFor(controlResources, { sampleCount: controlContext.sampleCount, colorFormats: [controlContext.swapchainFormat], depthFormat: "depth24plus-stencil8" }),
      renderState: controlRenderState,
    };
    terrain.readback.arm();
    controlContext.beginFrame();
    controlContext.clear({ color: { red: 1, green: 0, blue: 0, alpha: 1 } }, {});
    controlContext.draw({ __webgpu: controlInputs, count: 3, renderState: controlRenderState }, {});
    controlContext.endFrame();
    await controlContext.awaitFrameErrors();
    overlayFrame = await terrain.readback.read();
  }
  step("settled", { frameTimes: terrain.frameTimesMs.slice(-3), gpuFrame, overlayFrame });

  // Decode the first real terrain draw's vertex data, so "no fragments" can be attributed to the
  // geometry rather than guessed at.
  let geometry = null;
  const firstDraw = terrain.drawLog.find((entry) => (entry.rawVertexBuffers ?? []).length > 0);
  if (terrain.bufferReadback !== null && firstDraw !== undefined) {
    try {
      const stride = firstDraw.rawGpuVertexBuffers?.[0]?.arrayStride ?? 28;
      const vertexCount = Math.min(6, Math.floor(4096 / Math.max(4, stride)));
      const bytes = Math.min(4096, vertexCount * stride);
      const floats = await terrain.bufferReadback.readFloats(firstDraw.rawVertexBuffers[0].buffer, Math.floor(bytes / 4));
      const rows = [];
      for (let vertex = 0; vertex < Math.floor(floats.length / (stride / 4)); vertex += 1) {
        rows.push(floats.slice(vertex * (stride / 4), (vertex + 1) * (stride / 4)).map((value) => Number(value.toFixed(6))));
      }
      const indices = firstDraw.rawIndexBuffer === null || firstDraw.rawIndexBuffer === undefined ? null : await terrain.bufferReadback.readUint16(firstDraw.rawIndexBuffer.buffer, 12);
      const uniformTarget = terrain.uniformTargets[0] ?? null;
      const uniformOffset = firstDraw.programDynamicOffset ?? 0;
      const uniformFloats = uniformTarget === null ? null : await terrain.bufferReadback.readFloats(uniformTarget.buffer, 240, uniformOffset);
      const uniformSlotFloats = uniformTarget === null ? null : await terrain.bufferReadback.readFloats(uniformTarget.buffer, 240, 4096);
      geometry = {
        arrayStride: stride,
        gpuVertexBuffers: firstDraw.rawGpuVertexBuffers,
        numberOfVertices: firstDraw.vertexArray?.numberOfVertices ?? null,
        firstVertices: rows,
        firstIndices: indices,
        indexFormat: firstDraw.rawIndexBuffer?.format ?? null,
        count: firstDraw.count,
        uniformMapKeys: firstDraw.uniformMapKeys,
        uniformFloats,
        uniformOffset,
        uniformSlotFloats,
        uniformMembers: uniformTarget?.members ?? null,
        uniformDiagnostics: uniformTarget === null ? null : { uniformCount: uniformTarget.program?._uniforms?.length ?? null, automaticCount: uniformTarget.program?._automaticUniforms?.length ?? null, manualCount: uniformTarget.program?._manualUniforms?.length ?? null, stagingCounters: uniformTarget.gpuStaging?.counters() ?? null, stagingBytesWritten: uniformTarget.gpuStaging?.staging?.bytesWritten ?? null, stagingMissing: [...(uniformTarget.gpuStaging?.staging?.missingMembers ?? [])].slice(0, 10), dynamicOffset: uniformTarget.program?.uniformDynamicOffset ?? null },
        uniformStructSize: uniformTarget?.structSize ?? null,
        vertexShaderLines: (() => {
          const module = uniformTarget?.program?.wgsl?.vertexModule;
          if (typeof module !== "string") return null;
          return module
            .split("\n")
            .filter((line) => /getPosition|vs_main|out\.position|modelViewProjection|czms_remapClipDepth|position3DAndHeight/i.test(line))
            .slice(0, 40)
            .map((line) => line.trim());
        })(),
      };
    } catch (error) {
      geometry = { error: String(error?.message ?? error).slice(0, 300) };
    }
  }
  step("geometry-sample", geometry);

  const context = terrain.scene.context;
  const globe = terrain.scene.globe;
  const surface = globe._surface;
  const result = {
    backend,
    instrumentedFramebufferManager: terrain.instrumented,
    framebufferUpdates: terrain.framebufferUpdates,
    failingUpdates: terrain.framebufferUpdates.filter((entry) => entry.ok === false),
    depthStencilTextureRequests: terrain.framebufferUpdates.filter((entry) => entry.depthStencil && entry.supportsDepthTexture && entry.resolvedSamples > 1),
    frameErrors: terrain.frameErrors,
    renderErrors: terrain.renderErrors,
    emissionLog: terrain.emissionLog.filter((entry) => entry.ok === false),
    emissionInstrumented: terrain.emissionInstrumented,
    drawLog: terrain.drawLog,
    drawInstrumented: terrain.drawInstrumented,
    pipelineStateLog: terrain.pipelineStateLog,
    pipelineOverridden: terrain.pipelineOverridden,
    framePassLog: terrain.framePassLog,
    clearLog: terrain.clearLog,
    sceneBackgroundColor: { red: terrain.scene.backgroundColor?.red ?? null, green: terrain.scene.backgroundColor?.green ?? null, blue: terrain.scene.backgroundColor?.blue ?? null, alpha: terrain.scene.backgroundColor?.alpha ?? null },
    uniformValueLog: terrain.uniformValueLog,
    readbackTextureIds: terrain.readback?.textureIds ?? null,
    geometry,
    lastFramePasses: terrain.isWebgpu ? context.lastFramePasses().map((pass) => ({ index: pass.index, keyText: pass.keyText, clearOps: pass.clearOps, drawOps: pass.drawOps, sampleCount: pass.sampleCount, gpuPassCount: pass.gpuPassCount, workOrder: (pass.workOps ?? []).map((op) => op.kind).join(",") })) : null,
    contextDepthTexture: context?.depthTexture ?? null,
    contextMsaa: context?.msaa ?? null,
    sceneMsaaSamples: terrain.scene.msaaSamples,
    sceneLogarithmicDepthBuffer: terrain.scene.logarithmicDepthBuffer,
    requestedTiles: terrain.requestedTiles,
    globeDiagnostics: {
      show: globe.show,
      tilesLoaded: globe.tilesLoaded,
      terrainProviderName: globe.terrainProvider?.constructor?.name ?? null,
      terrainProviderIsOurs: globe.terrainProvider === terrain.provider,
      surfaceStatistics: surface?._statistics === undefined ? null : {
        numberOfTilesLoaded: surface._statistics.numberOfTilesLoaded ?? null,
        numberOfCommands: surface._statistics.numberOfCommands ?? null,
      },
      queueHigh: surface?._tileLoadQueueHigh?.length ?? null,
      queueLow: surface?._tileLoadQueueLow?.length ?? null,
      queueMedium: surface?._tileLoadQueueMedium?.length ?? null,
      tilesToRenderLength: surface?._tilesToRender?.length ?? null,
      cameraHeight: terrain.scene.camera.positionCartographic?.height ?? null,
    },
    counts: terrain.isWebgpu
      ? {
          draws: context.counters.draws,
          drawIndexedCalls: context.counters.drawIndexedCalls,
          passes: context.counters.passes,
          submittedCommandBuffers: context.counters.submittedCommandBuffers,
          frameErrors: context.frameErrors(),
          registry: bundle.gpuResourceRegistry.gpuResourceRegistry.stats(),
        }
      : { draws: null },
    camera: {
      longitude: 6.8652,
      latitude: 45.8326,
      height: 24000,
    },
    tilesLoad: load,
    gpuFrame,
    depthFrame,
    overlayFrame,
  };
  return { result, context: terrain.isWebgpu ? context : null };
}

// ------------------------------------------------------------------------------------------------
// W5 root cause: did the terrain rasterise at all, and with which vertex transform?
// ------------------------------------------------------------------------------------------------

/**
 * A full-viewport triangle written at clip depth **1.0** with `depthWriteEnabled: false`.
 *
 * This is the working replacement for reading the canvas depth buffer back. `copyTextureToBuffer`
 * **cannot** read the depth aspect of `depth24plus-stencil8` (measured on Chrome 153:
 * "The depth aspect of [Texture "cesium-webgpu:canvas-depth-stencil"] format
 * TextureFormat::Depth24PlusStencil8 cannot be selected in a texture to buffer copy."), so the depth
 * attachment is interrogated *through the depth test* instead:
 *
 *   - `depthCompare: "always"`  → the triangle paints the whole viewport (control: the draw works);
 *   - `depthCompare: "greater"` → the fragment depth (1.0) beats the stored depth only where geometry
 *     wrote a depth **below** 1.0, i.e. exactly where the terrain rasterised.
 *
 * The probe frame is opened with a draw as its first work operation, so the pass machine opens it with
 * `loadOp: "load"` for both colour and depth (`webgpu/pass-encoder.ts` `#descriptorFor`) and the depth
 * written by the previous terrain frame survives.
 */
function createDepthIndicatorResources(device, format, sampleCount) {
  const code = `
@vertex
fn vs_main(@builtin(vertex_index) index : u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let corner = corners[index];
  return vec4f(corner, 1.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(0.0, 1.0, 0.0, 1.0);
}
`;
  const module_ = device.createShaderModule({ label: "probe-depth-indicator", code });
  const pipelines = new Map();
  const pipelineFor = (depthCompare) => {
    let pipeline = pipelines.get(depthCompare);
    if (pipeline === undefined) {
      pipeline = device.createRenderPipeline({
        label: `probe-depth-indicator-${depthCompare}`,
        layout: "auto",
        vertex: { module: module_, entryPoint: "vs_main" },
        fragment: { module: module_, entryPoint: "fs_main", targets: [{ format }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth24plus-stencil8", depthWriteEnabled: false, depthCompare },
        multisample: { count: sampleCount },
      });
      pipelines.set(depthCompare, pipeline);
    }
    return pipeline;
  };
  return { module: module_, pipelineFor };
}

/** One indicator draw through the replacement `Context` (no program: the pipeline is supplied). */
function depthIndicatorInputs(resources, { depthCompare, sampleCount, format }) {
  const renderState = { depthTest: { enabled: false }, depthMask: false, cull: { enabled: false }, colorFormats: [format], depthFormat: "depth24plus-stencil8", sampleCount };
  return {
    shaderProgramId: `probe-depth-indicator-${depthCompare}`,
    pipeline: resources.pipelineFor(depthCompare),
    vertexBuffers: [],
    indexed: false,
    vertexCount: 3,
    topology: "triangle-list",
    colorFormats: [format],
    depthFormat: "depth24plus-stencil8",
    sampleCount,
    renderState,
  };
}

/** Decode one member of a uniform block from the floats a read-back produced (`scalarOffsets`-driven). */
function decodeMember(floats, member) {
  return (member.scalarOffsets ?? []).map((offset) => floats[offset / 4] ?? null);
}

/**
 * Name every non-zero member of a uniform block dump, and list the members that are entirely zero.
 *
 * A member that the shader needs for the vertex transform but that the block carries as zeros is the
 * exact signature of a broken automatic-uniform assembly — which is why the probe reports the *values*,
 * not only the names.
 */
function decodeBlock(floats, members) {
  const named = {};
  const zeroMembers = [];
  for (const member of members) {
    const values = decodeMember(floats, member);
    if (values.every((value) => value === 0)) zeroMembers.push(member.name);
    named[member.name] = values.map((value) => Number(Number(value).toPrecision(9)));
  }
  return { named, zeroMembers };
}

/** `Matrix4 * vec4` in Cesium's storage order (column-major, identical to the WGSL `mat4x4<f32>`). */
function multiplyMatrix4Vector(matrix, vector) {
  const [x, y, z, w] = vector;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12] * w,
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13] * w,
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14] * w,
    matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15] * w,
  ];
}

/** `czms_remapClipDepth` as the emitted WGSL writes it (`globe-vs.wgsl:28-30`). */
function remapClipDepth(clip) {
  return [clip[0], clip[1], 0.5 * clip[2] + 0.5 * clip[3], clip[3]];
}

/**
 * `terrain-raster-probe` — the W5 root-cause measurement.
 *
 * Three independent questions, answered by measurement rather than by inference:
 *
 *   1. **What do the vertex and uniform buffers actually hold?** The first terrain draw's vertex rows,
 *      index rows and both uniform slots (the automatic block at offset 0 and the command slot at the
 *      dynamic offset) are read back and decoded through the program's own layout table.
 *   2. **Where does the vertex transform put the vertices?** The clip-space position of the drawn
 *      vertices is evaluated in JavaScript with `czms_remapClipDepth(MP * vec4(position, 1))`, exactly
 *      as the emitted WGSL computes it, and each vertex is classified inside/outside the WebGPU clip
 *      volume. A vertex count of 0 inside is the "zero fragments" mechanism.
 *   3. **Did anything rasterise?** The depth-presence indicator above separates "no fragments" from
 *      "fragments that are black", which a colour read-back alone cannot do.
 */
async function scenarioTerrainRasterProbe(bundle, canvas) {
  const terrain = await buildTerrainScene(bundle, canvas, {
    readback: true,
    bufferReadback: true,
    uploadLog: true,
    pipelineLog: true,
    singleSample: params.get("samples") !== "0",
    cullNone: params.get("cull") === "none",
    lightingOff: params.get("lighting") === "off",
    globeHidden: params.get("globe") === "hidden",
    ellipsoidProvider: params.get("provider") === "ellipsoid",
  });
  const load = await renderUntilTilesLoaded(terrain);
  step("tiles-loaded", load);
  await terrain.renderFrames(3, 16);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const context = terrain.scene.context;
  const device = context.device;
  const readback = terrain.readback;
  // Forget the opening frames' draws: the frame that is read back below is the one whose tiles,
  // vertex buffers and uniforms the probe must describe.
  terrain.resetDrawLog();
  readback.arm();
  await terrain.renderFrames(1, 16);
  const gpuFrame = await readback.read();
  const terrainFramePasses = context.lastFramePasses().map((pass) => ({ index: pass.index, keyText: pass.keyText, clearOps: pass.clearOps, drawOps: pass.drawOps, gpuPassCount: pass.gpuPassCount, openedWithLoadOpClear: pass.openedWithLoadOpClear, workOrder: pass.workOps.map((op) => `${op.kind}${op.clearMechanism === undefined ? "" : `(${op.clearMechanism})`}`).join(" → ") }));
  step("terrain-frame", { frameTimes: terrain.frameTimesMs.slice(-3), gpuFrame, recordedDrawFrame: terrain.drawLog[0]?.frame ?? null, terrainFramePasses });

  // ---- 1. the geometry ---------------------------------------------------------------------------
  // Prefer a draw that really carries a terrain program **and** real vertex buffers: the first logged
  // draws of a frame are not necessarily tile draws.
  const drawWithGeometry = (entry) => (entry.rawVertexBuffers ?? []).length > 0 && (entry.count ?? 0) > 0;
  const firstDraw =
    terrain.drawLog.find((entry) => drawWithGeometry(entry) && entry.hasShaderProgram === true) ??
    terrain.drawLog.find(drawWithGeometry) ??
    null;
  let geometry = { error: "no draw with vertex buffers was recorded (drawLog length " + String(terrain.drawLog.length) + ")" };
  let firstRow = null;
  let firstFloats = null;
  if (terrain.bufferReadback !== null && firstDraw !== null) {
    try {
      const stride = firstDraw.rawGpuVertexBuffers?.[0]?.arrayStride ?? 28;
      const floatsPerRow = stride / 4;
      const buffer = firstDraw.rawVertexBuffers[0].buffer;
      const totalRows = firstDraw.vertexArray?.numberOfVertices ?? 0;
      const declaredBytes = totalRows * stride;
      // The whole vertex array, so "the first row is degenerate" can be told apart from "the whole
      // buffer is degenerate" — 125 KB is nothing next to a wrong diagnosis.
      const floats = await terrain.bufferReadback.readFloats(buffer, Math.min(Math.ceil(declaredBytes / 4), Math.floor(buffer.size / 4)));
      firstFloats = floats;
      const rowAt = (index) => (index * floatsPerRow + floatsPerRow > floats.length ? null : floats.slice(index * floatsPerRow, (index + 1) * floatsPerRow).map((value) => Number(value.toPrecision(9))));
      const firstRows = [];
      for (let vertex = 0; vertex < 8; vertex += 1) firstRows.push(rowAt(vertex));
      const probeIndices = [64, 65, 66, 2048, 4224, 4225, 4484].filter((index) => index < totalRows);
      const laneMinimum = new Array(floatsPerRow).fill(Number.POSITIVE_INFINITY);
      const laneMaximum = new Array(floatsPerRow).fill(Number.NEGATIVE_INFINITY);
      const distinctPositions = new Set();
      for (let row = 0; row + 1 <= Math.floor(floats.length / floatsPerRow); row += 1) {
        const base = row * floatsPerRow;
        for (let lane = 0; lane < floatsPerRow; lane += 1) {
          const value = floats[base + lane];
          if (value < laneMinimum[lane]) laneMinimum[lane] = value;
          if (value > laneMaximum[lane]) laneMaximum[lane] = value;
        }
        if (distinctPositions.size < 4096) distinctPositions.add(`${floats[base]},${floats[base + 1]},${floats[base + 2]}`);
      }
      const uploads = (terrain.uploads?.log ?? []).filter((entry) => entry.buffer === buffer);
      firstRow = firstRows[0];
      geometry = {
        arrayStride: stride,
        gpuVertexBuffers: firstDraw.rawGpuVertexBuffers,
        numberOfVertices: totalRows,
        declaredBytes,
        gpuBufferSize: buffer.size,
        gpuBufferUsage: buffer.usage,
        count: firstDraw.count,
        indexFormat: firstDraw.rawIndexBuffer?.format ?? null,
        firstVertices: firstRows,
        probeRows: probeIndices.map((index) => ({ index, row: rowAt(index) })),
        distinctPositions: distinctPositions.size,
        laneMinimum: laneMinimum.map((value) => Number(value.toPrecision(9))),
        laneMaximum: laneMaximum.map((value) => Number(value.toPrecision(9))),
        firstIndices: firstDraw.rawIndexBuffer === null || firstDraw.rawIndexBuffer === undefined ? null : await terrain.bufferReadback.readUint16(firstDraw.rawIndexBuffer.buffer, 12),
        uniformMapKeys: firstDraw.uniformMapKeys,
        uniformValues: firstDraw.uniformValues ?? null,
        programDynamicOffset: firstDraw.programDynamicOffset,
        shaderProgramVariant: firstDraw.shaderProgramVariant,
        pipelineId: firstDraw.pipelineId ?? null,
        // CPU → GPU: what the backend *uploaded* into this very buffer (the upload records are keyed
        // by the `GPUBuffer` identity, so this is the same object the draw binds).
        uploads: uploads.map((entry) => ({ label: entry.label, bufferOffset: entry.bufferOffset, byteLength: entry.byteLength, typedArray: entry.typedArray, viewByteOffset: entry.viewByteOffset, firstFloats: entry.firstFloats })),
        uploadCount: (terrain.uploads?.log ?? []).length,
      };
    } catch (error) {
      geometry = { error: String(error?.message ?? error).slice(0, 400) };
    }
  }
  step("geometry-sample", { ...geometry, firstVertices: undefined });

  // ---- 1b. the pipeline the draw actually used ---------------------------------------------------
  const pipeline = (terrain.pipelineLog?.log ?? []).find((entry) => entry.id === geometry.pipelineId) ?? null;
  step("pipeline", pipeline === null ? { error: `no pipeline descriptor recorded for id ${String(geometry.pipelineId)}` } : { id: pipeline.id, label: pipeline.label, vertexBuffers: pipeline.vertexBuffers, cullMode: pipeline.cullMode, depthFormat: pipeline.depthFormat, depthCompare: pipeline.depthCompare, sampleCount: pipeline.sampleCount });

  // ---- 2. the uniform block, named -----------------------------------------------------------------
  const target = terrain.uniformTargets[0] ?? null;
  let uniforms = { error: "no uniform staging area was recorded (the terrain draws did not publish a program)" };
  let automaticDecoded = null;
  let slotDecoded = null;
  if (target !== null && terrain.bufferReadback !== null) {
    try {
      const floatCount = Math.floor((target.structSize ?? 0) / 4);
      const automaticFloats = await terrain.bufferReadback.readFloats(target.buffer, floatCount, 0);
      // `firstDraw.programDynamicOffset` is sampled *before* `_setUniforms` runs (the draw wrapper
      // precedes the real call), so the live value is taken from the program **after** the frames.
      const offset = target.program?.uniformDynamicOffset ?? firstDraw?.programDynamicOffset ?? 0;
      const slotFloats = await terrain.bufferReadback.readFloats(target.buffer, floatCount, offset);
      automaticDecoded = decodeBlock(automaticFloats, target.members ?? []);
      slotDecoded = decodeBlock(slotFloats, target.members ?? []);
      uniforms = {
        structSize: target.structSize,
        slotSize: target.gpuStaging?.slotSize ?? null,
        variantKey: target.variantKey,
        defines: target.defines,
        memberCount: (target.members ?? []).length,
        automaticSlotOffset: 0,
        commandSlotOffset: offset,
        automaticZeroMembers: automaticDecoded.zeroMembers,
        commandZeroMembers: slotDecoded.zeroMembers,
        // Slot 0 is written by every member of every draw (the automatic setter path writes through
        // `UniformStaging.writeMember` into slot 0), so it is *not* purely automatic: it carries the
        // last draw's manual uniforms too. Both dumps are reported so the two can be compared.
        automatic: automaticDecoded.named,
        command: slotDecoded.named,
      };
    } catch (error) {
      uniforms = { error: String(error?.message ?? error).slice(0, 400) };
    }
  }
  step("uniform-block", { structSize: uniforms.structSize ?? null, automaticZeroMembers: uniforms.automaticZeroMembers ?? null, commandSlotOffset: uniforms.commandSlotOffset ?? null });

  // ---- 3. the clip-space verdict, computed exactly as the emitted WGSL does -----------------------
  let clipVerdict = { error: "the uniform block or the vertex rows were not readable" };
  if (automaticDecoded !== null && slotDecoded !== null && firstFloats !== null && firstDraw !== null) {
    const stride = geometry.arrayStride ?? 28;
    const matrix = slotDecoded.named.u_modifiedModelViewProjection ?? automaticDecoded.named.u_modifiedModelViewProjection;
    const center = slotDecoded.named.u_center3D ?? automaticDecoded.named.u_center3D;
    const view = automaticDecoded.named.czm_view;
    const projection = automaticDecoded.named.czm_projection;
    const vertices = [];
    const vertexCount = Math.floor(Math.min(firstFloats.length, 64 * (stride / 4)) / (stride / 4));
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const base = vertex * (stride / 4);
      vertices.push([firstFloats[base], firstFloats[base + 1], firstFloats[base + 2], firstFloats[base + 3]]);
    }
    const rows = vertices.map((vertex) => {
      const clip = remapClipDepth(multiplyMatrix4Vector(matrix, [vertex[0], vertex[1], vertex[2], 1]));
      const w = clip[3];
      const inside = w > 0 && Math.abs(clip[0]) <= w && Math.abs(clip[1]) <= w && clip[2] >= 0 && clip[2] <= w;
      // The independent path: world = position + u_center3D, then view and projection separately. A
      // mismatch with `MP * position` means the RTC centre and the matrix translation disagree.
      const world = [vertex[0] + center[0], vertex[1] + center[1], vertex[2] + center[2]];
      const eye = multiplyMatrix4Vector(view, [world[0], world[1], world[2], 1]);
      const independent = remapClipDepth(multiplyMatrix4Vector(projection, eye));
      return {
        position: vertex.slice(0, 3).map((value) => Number(value.toPrecision(9))),
        height: Number(vertex[3].toPrecision(9)),
        clip: clip.map((value) => Number(value.toPrecision(9))),
        independentClip: independent.map((value) => Number(value.toPrecision(9))),
        insideClipVolume: inside,
        ndc: w === 0 ? null : [clip[0] / w, clip[1] / w, clip[2] / w].map((value) => Number(value.toPrecision(6))),
      };
    });
    const insideCount = rows.filter((row) => row.insideClipVolume).length;
    // The **pairing test**: `u_center3D` is the RTC origin of the very draw that owns this vertex
    // buffer, so `position + u_center3D` MUST land on the WGS84 shell (`k ≈ 1`; the terrain heights of
    // the fixture live in [-1120, 9000] m, i.e. `k` in [0.9998, 1.0014]). A `k` far from 1 means the
    // vertex positions and the tile centre do not belong to the same tile — the "RTC pairing" failure.
    const pairedCenter = firstDraw?.uniformValues?.u_center3D ?? center;
    const surfaceCheck =
      Array.isArray(pairedCenter) && pairedCenter.length >= 3
        ? vertices.slice(0, 8).map((vertex) => {
            const world = [vertex[0] + pairedCenter[0], vertex[1] + pairedCenter[1], vertex[2] + pairedCenter[2]];
            const k = Math.sqrt((world[0] / 6378137) ** 2 + (world[1] / 6378137) ** 2 + (world[2] / 6356752.3142451793) ** 2);
            return { world: world.map((value) => Number(value.toPrecision(9))), ellipsoidScale: Number(k.toPrecision(9)), heightMetres: Number((Math.hypot(world[0], world[1], world[2]) * (1 - 1 / k)).toPrecision(9)), vertexHeight: Number(vertex[3].toPrecision(9)) };
          })
        : null;
    clipVerdict = {
      vertexRowsEvaluated: rows.length,
      insideClipVolume: insideCount,
      outsideClipVolume: rows.length - insideCount,
      matrixSource: slotDecoded.named.u_modifiedModelViewProjection === undefined ? "automatic slot" : "command slot",
      center: (center ?? []).map((value) => Number(Number(value).toPrecision(9))),
      pairedCenter: Array.isArray(pairedCenter) ? pairedCenter.map((value) => Number(Number(value).toPrecision(9))) : pairedCenter,
      surfaceCheck,
      rows,
    };
  }
  step("clip-verdict", { inside: clipVerdict.insideClipVolume ?? null, evaluated: clipVerdict.vertexRowsEvaluated ?? null });

  // ---- 3b. per-draw clip extents, paired through the slot the draw actually bound ------------------
  // `programDynamicOffsetAfter` is the ring slot `_setUniforms` selected for **that** draw, so the matrix
  // read here is the one the vertex shader of that draw reads — the only pairing that cannot be fooled by
  // the shared scratch objects upstream's uniform map holds.
  const perDrawClip = [];
  if (target !== null && terrain.bufferReadback !== null && (target.members ?? []).length > 0) {
    const structFloats = Math.floor((target.structSize ?? 0) / 4);
    for (const draw of terrain.drawLog) {
      const offset = draw.programDynamicOffsetAfter;
      if (offset === null || offset === undefined || (draw.rawVertexBuffers ?? []).length === 0) continue;
      try {
        const slotFloats = await terrain.bufferReadback.readFloats(target.buffer, structFloats, offset);
        const decoded = decodeBlock(slotFloats, target.members ?? []);
        const matrix = decoded.named.u_modifiedModelViewProjection;
        if (matrix === undefined) continue;
        const stride = draw.rawGpuVertexBuffers?.[0]?.arrayStride ?? 28;
        const floatsPerRow = stride / 4;
        // **Every** vertex of the mesh (4485 of them, 125 KB), not just the first row: sampling one row
        // makes the tile look 50:1 flat, because a grid row has a constant latitude and therefore spans
        // no screen height at all.
        const gridWidth = draw.rawIndexBuffer === null || draw.rawIndexBuffer === undefined ? null : (await terrain.bufferReadback.readUint16(draw.rawIndexBuffer.buffer, 6))[1] ?? null;
        const totalVertices = draw.vertexArray?.numberOfVertices ?? 0;
        const floats = await terrain.bufferReadback.readFloats(draw.rawVertexBuffers[0].buffer, totalVertices * floatsPerRow);
        const ndcList = [];
        let inside = 0;
        for (let vertex = 0; vertex < totalVertices; vertex += 1) {
          const base = vertex * floatsPerRow;
          const clip = remapClipDepth(multiplyMatrix4Vector(matrix, [floats[base], floats[base + 1], floats[base + 2], 1]));
          const w = clip[3];
          if (!(w > 0)) continue;
          const ndc = [clip[0] / w, clip[1] / w, clip[2] / w];
          ndcList.push(ndc);
          if (Math.abs(ndc[0]) <= 1 && Math.abs(ndc[1]) <= 1 && ndc[2] >= 0 && ndc[2] <= 1) inside += 1;
        }
        const xs = ndcList.map((ndc) => ndc[0]);
        const ys = ndcList.map((ndc) => ndc[1]);
        perDrawClip.push({
          frame: draw.frame,
          slotOffset: offset,
          pipelineId: draw.pipelineId ?? null,
          vertexBuffer: draw.rawVertexBuffers[0].buffer.label ?? null,
          gridWidth,
          verticesEvaluated: totalVertices,
          insideClipVolume: inside,
          ndcMinimum: ndcList.length === 0 ? null : [Math.min(...xs), Math.min(...ys)].map((value) => Number(value.toPrecision(6))),
          ndcMaximum: ndcList.length === 0 ? null : [Math.max(...xs), Math.max(...ys)].map((value) => Number(value.toPrecision(6))),
          ndcWidth: ndcList.length === 0 ? null : Number(((Math.max(...xs) - Math.min(...xs)) / 2).toPrecision(6)),
          ndcHeight: ndcList.length === 0 ? null : Number(((Math.max(...ys) - Math.min(...ys)) / 2).toPrecision(6)),
          // The whole mesh's screen-space size in pixels of the 384x288 canvas (100 % = the full canvas).
          screenWidthPixels: ndcList.length === 0 ? null : Number((((Math.max(...xs) - Math.min(...xs)) / 2) * (384 / 2)).toPrecision(6)),
          screenHeightPixels: ndcList.length === 0 ? null : Number((((Math.max(...ys) - Math.min(...ys)) / 2) * (288 / 2)).toPrecision(6)),
          centre: (decoded.named.u_center3D ?? []).map((value) => Number(Number(value).toPrecision(9))),
        });
      } catch (error) {
        perDrawClip.push({ frame: draw.frame, error: String(error?.message ?? error).slice(0, 200) });
      }
    }
  }
  step("per-draw-clip", {
    draws: perDrawClip.length,
    vertices: perDrawClip.map((entry) => entry.verticesEvaluated ?? null),
    inside: perDrawClip.map((entry) => entry.insideClipVolume ?? null),
    screenWidthPixels: perDrawClip.map((entry) => entry.screenWidthPixels ?? null),
    screenHeightPixels: perDrawClip.map((entry) => entry.screenHeightPixels ?? null),
  });

  // ---- 3c. why the frame is a single flat colour ------------------------------------------------
  // `GlobeFS.glsl`'s `ENABLE_DAYNIGHT_SHADING` branch multiplies the base colour by the day/night term
  // only as far as the lighting fade allows:
  //     fade       = clamp((cameraDist - fadeOutDist) / (fadeInDist - fadeOutDist), 0, 1)
  //     finalColor = color * czm_lightColor * mix(1.0, diffuseIntensity, fade)
  // A camera 24 km above the ground is far inside `u_lightingFadeDistance` (the fade-out starts at
  // ~0.5 x pi x the polar radius), so `fade` is 0 and the terrain colour is the **unmodulated** base
  // colour — the source of "one unique colour" in the frame statistics. Computed here from the values
  // the GPU block actually holds, so the flat frame is self-explained by the artefact rather than by
  // an argument about the shader.
  const automaticNamed = uniforms.automatic ?? {};
  const commandNamed = uniforms.command ?? {};
  const lightingModel = (() => {
    const view = automaticNamed.czm_view;
    const lightColor = automaticNamed.czm_lightColor;
    const fade = commandNamed.u_lightingFadeDistance ?? automaticNamed.u_lightingFadeDistance;
    const initialColor = commandNamed.u_initialColor ?? automaticNamed.u_initialColor;
    if (!Array.isArray(view) || view.length < 16 || !Array.isArray(fade) || fade.length < 2) {
      return { error: "the automatic block does not carry `czm_view` / `u_lightingFadeDistance`" };
    }
    const cameraDist = Math.hypot(view[12], view[13], view[14]);
    const fadeOutDistance = fade[0];
    const fadeInDistance = fade[1];
    const fadeValue = Math.max(0, Math.min(1, (cameraDist - fadeOutDistance) / (fadeInDistance - fadeOutDistance)));
    const rgb = Array.isArray(initialColor) && initialColor.length >= 3 ? initialColor.slice(0, 3).map((component) => component * (Array.isArray(lightColor) ? lightColor[0] ?? 1 : 1)) : null;
    return {
      source: "node_modules/@cesium/engine/Source/Shaders/GlobeFS.glsl (`ENABLE_DAYNIGHT_SHADING`) == webgpu/wgsl/leaves/globe-fragment-main.wgsl:82",
      cameraDist: Number(cameraDist.toPrecision(9)),
      fadeOutDistance,
      fadeInDistance,
      fade: Number(fadeValue.toPrecision(9)),
      lightingFactor: Number(fadeValue.toPrecision(9)),
      unmodulatedBaseColorRgb: Array.isArray(initialColor) ? initialColor.slice(0, 3) : null,
      expectedFrameColourRgb: rgb === null ? null : rgb.map((component) => Math.round(component * 255)),
      measuredCentreBgraBytes: gpuFrame === null || gpuFrame === undefined ? null : gpuFrame.centre,
      verdict:
        fadeValue === 0
          ? "the near-ground camera is inside `u_lightingFadeDistance`, so the day/night term is faded out " +
            "entirely (`mix(1, diffuse, 0) = 1`) and the terrain colour is `u_initialColor * czm_lightColor`. " +
            "A single-colour frame is upstream's behaviour for this camera, not a missing shading path."
          : `the lighting fade is ${String(fadeValue)} at this camera distance, so the day/night term is only partly mixed in`,
    };
  })();
  step("lighting-model", { fade: lightingModel.fade ?? null, cameraDist: lightingModel.cameraDist ?? null, expectedFrameColourRgb: lightingModel.expectedFrameColourRgb ?? null, measuredCentreBgraBytes: lightingModel.measuredCentreBgraBytes ?? null });

  // ---- 4. did anything rasterise? ----------------------------------------------------------------
  const indicator = createDepthIndicatorResources(device, context.swapchainFormat, context.sampleCount);
  const renderState = { depthTest: { enabled: false }, depthMask: false, cull: { enabled: false } };
  const drawIndicator = async (depthCompare, options = {}) => {
    const inputs = depthIndicatorInputs(indicator, { depthCompare, sampleCount: context.sampleCount, format: context.swapchainFormat });
    readback.arm();
    context.beginFrame();
    if (options.clearOnly === true) {
      // A frame that **only clears** (the clear includes the depth attachment), so the depth buffer holds
      // exactly its clear value and nothing has been drawn. This is the discrimination control: the
      // `greater` marker over it MUST paint 0 px if the marker really tests "stored depth < clear value".
      context.clear({ color: { red: 0, green: 0, blue: 0, alpha: 1 }, depth: 1, stencil: 0 }, {});
    } else {
      context.draw({ __webgpu: inputs, count: 3, renderState }, {});
    }
    context.endFrame();
    await context.awaitFrameErrors().catch((error) => ({ error: String(error?.message ?? error).slice(0, 300) }));
    return readback.read();
  };
  // The green marker layer, measured three ways so every number is interpretable on its own:
  //   * `indicatorAlways`      — the marker ignores depth entirely: proves the probe's own draw lands;
  //   * `clearOnlyThenGreater` — depth is at its clear value with no geometry: MUST be 0 painted px;
  //   * `terrainFrameGreater`  — depth as the terrain frame left it: the px where depth ≠ clear value.
  //
  // ORDER IS LOAD-BEARING: the terrain reading MUST come first, because the clear-only control clears the
  // depth attachment and every later frame loads that cleared buffer (measured: running the control first
  // made the terrain reading report 0 px, i.e. the control erased the very state it was calibrating).
  const depthPresence = {
    terrainFrameGreater: await drawIndicator("greater"),
    indicatorAlways: await drawIndicator("always"),
    clearOnlyThenGreater: await drawIndicator("greater", { clearOnly: true }),
  };
  depthPresence.pixelsWhereDepthDiffersFromClear = depthPresence.terrainFrameGreater?.nonBlackPixels ?? null;
  depthPresence.discriminationControl = depthPresence.clearOnlyThenGreater?.nonBlackPixels ?? null;
  depthPresence.indicatorLayerWorks = (depthPresence.indicatorAlways?.nonBlackPixels ?? 0) > 0;
  depthPresence.differenceFromControl =
    depthPresence.pixelsWhereDepthDiffersFromClear === null || depthPresence.discriminationControl === null
      ? null
      : depthPresence.pixelsWhereDepthDiffersFromClear - depthPresence.discriminationControl;
  depthPresence.verdict =
    depthPresence.indicatorLayerWorks !== true
      ? "inconclusive: the marker draw painted nothing, so a 0 from the `greater` variants cannot be attributed"
      : depthPresence.discriminationControl !== 0
        ? `inconclusive: the clear-only control painted ${String(depthPresence.discriminationControl)} px, so the marker does not discriminate`
        : depthPresence.differenceFromControl > 0
          ? `DEPTH WRITTEN: the terrain left a stored depth below the clear value over ${String(depthPresence.differenceFromControl)} px ` +
            `(clear-only control: 0, terrain frame: ${String(depthPresence.pixelsWhereDepthDiffersFromClear)})`
          : "NO DEPTH WRITTEN: the terrain frame's depth is identical to a frame that only cleared, so no geometry rasterised";
  step("depth-presence", {
    verdict: depthPresence.verdict,
    indicatorAlways: depthPresence.indicatorAlways?.nonBlackPixels ?? null,
    clearOnlyThenGreater: depthPresence.discriminationControl,
    terrainFrameGreater: depthPresence.pixelsWhereDepthDiffersFromClear,
    difference: depthPresence.differenceFromControl,
  });

  // ---- 5. the geometry bisect: the terrain's own buffers, drawn by a shader this probe owns --------
  // If this paints, the buffers and the vertex fetch are fine and the fault is on the terrain program's
  // transform side; if it does not, the bytes the draw binds are not the bytes that were read back.
  let geometryProbe = { skipped: "no recorded terrain draw" };
  if (firstDraw !== null && firstDraw.rawVertexBuffers.length > 0 && firstDraw.rawGpuVertexBuffers.length > 0) {
    const probeModule = device.createShaderModule({
      label: "probe-terrain-geometry",
      code: `
@vertex
fn vs_main(@location(0) position3DAndHeight : vec4<f32>, @location(1) textureCoordAndEncodedNormals : vec4<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(position3DAndHeight.xy / 8000.0, 0.5, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 1.0, 1.0);
}
`,
    });
    const probePipeline = device.createRenderPipeline({
      label: "probe-terrain-geometry",
      layout: "auto",
      vertex: { module: probeModule, entryPoint: "vs_main", buffers: firstDraw.rawGpuVertexBuffers },
      fragment: { module: probeModule, entryPoint: "fs_main", targets: [{ format: context.swapchainFormat }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus-stencil8", depthWriteEnabled: false, depthCompare: "always" },
      multisample: { count: context.sampleCount },
    });
    const probeRenderState = { depthTest: { enabled: false }, depthMask: false, cull: { enabled: false } };
    const probeInputs = {
      shaderProgramId: "probe-terrain-geometry",
      pipeline: probePipeline,
      vertexBuffers: firstDraw.rawVertexBuffers.map((binding) => ({ slot: binding.slot, buffer: binding.buffer, offset: binding.offset ?? 0 })),
      indexBuffer: firstDraw.rawIndexBuffer,
      indexed: true,
      indexCount: firstDraw.count,
      gpuVertexBuffers: firstDraw.rawGpuVertexBuffers,
      topology: "triangle-list",
      colorFormats: [context.swapchainFormat],
      depthFormat: "depth24plus-stencil8",
      sampleCount: context.sampleCount,
      renderState: probeRenderState,
    };
    readback.arm();
    context.beginFrame();
    context.draw({ __webgpu: probeInputs, count: firstDraw.count, renderState: probeRenderState }, {});
    context.endFrame();
    await context.awaitFrameErrors().catch((error) => {
      geometryProbe.error = String(error?.message ?? error).slice(0, 300);
    });
    geometryProbe = { ...geometryProbe, ...(await readback.read()) };
    geometryProbe.verdict =
      (geometryProbe.nonBlackPixels ?? 0) > 0
        ? `the terrain's own vertex/index buffers DO rasterise (${geometryProbe.nonBlackPixels} px): the fetch and the buffers are fine, the fault is in the terrain program's uniform transform`
        : "the terrain's own vertex/index buffers rasterise NOTHING even with a trivial shader: the bound geometry is not what was read back";
  }
  step("geometry-bisect", geometryProbe.verdict === undefined ? geometryProbe : { verdict: geometryProbe.verdict, nonBlackPixels: geometryProbe.nonBlackPixels ?? null });

  // ---- 6. leave the **terrain** frame presented ---------------------------------------------------
  // The harness screenshots the canvas after the page reports ready, and it uses the same
  // `regionStatistics` schema the WebGL2 reference run uses. Leaving the probe's own marker frames on
  // screen would make the two paths incomparable, so the last thing this scenario does is render the
  // terrain again (three frames, so the compositor definitely picks it up).
  await terrain.renderFrames(3, 16);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const result = {
    backend,
    variantKey: target?.variantKey ?? null,
    tilesLoad: load,
    gpuFrame,
    geometry,
    pipeline,
    pipelineCount: (terrain.pipelineLog?.log ?? []).length,
    pipelineDescriptors: (terrain.pipelineLog?.log ?? []).map((entry) => ({ id: entry.id, label: entry.label, vertexBuffers: entry.vertexBuffers, cullMode: entry.cullMode, frontFace: entry.frontFace, depthFormat: entry.depthFormat, depthWriteEnabled: entry.depthWriteEnabled, depthCompare: entry.depthCompare, sampleCount: entry.sampleCount, colorFormats: entry.colorFormats })),
    terrainFramePasses,
    clearLog: terrain.clearLog,
    uniforms,
    clipVerdict,
    perDrawClip,
    lightingModel,
    depthPresence,
    geometryProbe,
    drawBindings: terrain.drawBindingsInstrumented ? terrain.drawBindings : { instrumented: false },
    renderErrors: terrain.renderErrors,
    frameErrors: terrain.frameErrors,
    counts: {
      draws: context.counters.draws,
      drawIndexedCalls: context.counters.drawIndexedCalls,
      passes: context.counters.passes,
      frameErrors: context.frameErrors(),
    },
    globeDiagnostics: {
      tilesLoaded: terrain.scene.globe.tilesLoaded,
      tilesToRenderLength: terrain.scene.globe._surface?._tilesToRender?.length ?? null,
      terrainProviderName: terrain.scene.globe.terrainProvider?.constructor?.name ?? null,
    },
    pipelineStateLog: terrain.pipelineStateLog,
    lastFramePasses: context.lastFramePasses().map((pass) => ({ index: pass.index, keyText: pass.keyText, clearOps: pass.clearOps, drawOps: pass.drawOps, gpuPassCount: pass.gpuPassCount, openedWithLoadOpClear: pass.openedWithLoadOpClear })),
    canvasDepthTextureFormat: context.canvasDepthTexture()?.format ?? null,
    sampleCount: context.sampleCount,
    vertexModule: target?.vertexModule ?? null,
    fragmentModule: target?.fragmentModule ?? null,
    // Which `#ifdef`-style regions the emitted module actually carries (the defines the module was
    // emitted with, recovered from the module text itself rather than from the request).
    emittedDefineMarkers: (() => {
      const text = target?.fragmentModule ?? "";
      if (typeof text !== "string" || text.length === 0) return null;
      return ["ENABLE_DAYNIGHT_SHADING", "GROUND_ATMOSPHERE", "PER_FRAGMENT_GROUND_ATMOSPHERE", "DYNAMIC_ATMOSPHERE_LIGHTING", "ENABLE_VERTEX_LIGHTING", "TEXTURE_UNITS"]
        .filter((marker) => text.includes(marker));
    })(),
    /**
     * What this probe established, so the next phase does not have to re-derive it (W5 root cause).
     *
     * Everything here is a *measurement* recorded in this same artefact; the strings are the shared
     * conclusion for whoever picks the phase up next, not a substitute for the numbers above.
     */
    conclusion: {
      rootCauseOne:
        "Context.draw forwarded upstream's `instanceCount === 0` verbatim to `drawIndexed`, which draws " +
        "nothing (upstream's GL path reads 0 as 'not instanced'). 98 healthy draws, zero validation errors, " +
        "zero fragments. Fixed in Renderer/Context.ts (`instanceCountFromUpstream`).",
      rootCauseTwo:
        "RenderState.FRONT_FACE_MAP carried an inverted winding mapping, so `cullMode:'back'` culled every " +
        "terrain *surface* triangle and kept only the skirt walls (frame = tile outlines, 1990 px). Fixed in " +
        "Renderer/RenderState.ts (1:1 mapping), verified against the WebGL2 reference run of the same scene.",
      flatColour:
        "The frame is a single colour because the day/night term is faded out at this camera distance " +
        "(`fade === 0` in GlobeFS's ENABLE_DAYNIGHT_SHADING branch) — upstream's behaviour for a near-ground " +
        "camera with no imagery layer, not a missing shading path. See `lightingModel`.",
      notTheCause: [
        "missing automatic uniforms: both blocks decode to real values; the members that are zero are the ones that should be zero",
        "geometry, RTC pairing and the vertex fetch: the mesh is a coherent RTC grid (k ~ 1 against the tile centre) and rasterises 73921 px through a probe-owned shader",
        "the uniform ring / dynamic offsets / bind group: the real pass-encoder bindings show one vertex buffer, the index buffer and a per-draw dynamic offset for every tile draw",
        "the pass machine's clear semantics: all three clears precede the seven tile draws (`terrainFramePasses[0].workOrder`)",
        "channel order and alpha: the centre value is bgra8unorm's B lane (127 = 0.5 x 255 = u_initialColor.b)",
      ],
    },
  };
  return { result, context };
}

const SCENARIOS = {
  "canvas-depth-probe": scenarioCanvasDepthProbe,
  "terrain-probe": scenarioTerrainProbe,
  "terrain-raster-probe": scenarioTerrainRasterProbe,
  "scene-construct": scenarioSceneConstruct,
  "draw-dispatch": scenarioDrawDispatch,
  present: scenarioPresent,
  "device-lost": scenarioDeviceLost,
  "pass-sequence": scenarioPassSequence,
  resources: scenarioResources,
  "texture-origin": scenarioTextureOrigin,
};

/**
 * Scenarios that live in their **own file** under `tests/contract/page/scenarios/`.
 *
 * `SCENARIOS` above is one 3000-line file because the W2/W3 scenarios share a great deal of inline
 * instrumentation. The Phase 7 acceptance suites do not need to edit this file at all: each one owns
 * `scenarios/<name>.js`, whose default export is `(bundle, canvas, ctx) => result`. Two suites can
 * therefore be written **in parallel without touching a common file** — and a missing module fails
 * loudly as an import error instead of silently degrading to "unknown scenario".
 *
 * The map is explicit (rather than a filename convention probed with `fetch`) so that a typo, a syntax
 * error or a missing file inside a scenario module is never mistaken for "no such scenario".
 */
const SCENARIO_MODULES = {
  "terrain-offline": "./scenarios/terrain-offline.js",
  "terrain-unavailable": "./scenarios/terrain-unavailable.js",
  "terrain-ready": "./scenarios/terrain-ready.js",
  "terrain-interaction": "./scenarios/terrain-interaction.js",
  "device-lost-terrain": "./scenarios/device-lost-terrain.js",
  "offscreen-depth": "./scenarios/offscreen-depth.js",
  "terrain-multitile": "./scenarios/terrain-multitile.js",
  "terrain-geometry": "./scenarios/terrain-geometry.js",
  "terrain-elevation": "./scenarios/terrain-elevation.js",
  "cross-equivalence": "./scenarios/cross-equivalence.js",
  handle: "./scenarios/handle.js",
  status: "./scenarios/status.js",
  "whole-switch": "./scenarios/whole-switch.js",
  demo: "./scenarios/demo.js",
  fallback: "./scenarios/fallback.js",
};

/**
 * Everything a scenario module may use, passed in explicitly.
 *
 * Scenario modules import **nothing** from this file (that would re-run `main()`), so the helper set is
 * handed over as a single object. All entries are the very functions this page uses for its own
 * scenarios — there is no second copy to drift out of sync.
 */
function scenarioContext() {
  return {
    report,
    params,
    backend,
    step,
    partitionTrace,
    createCanvas,
    describeContext,
    readPresentedCanvas,
    prefetchDevice,
    createTriangleResources,
    drawInputsFor,
    buildTerrainScene,
    renderUntilTilesLoaded,
    heightmapTileRectangle,
    analyticHeightmap,
    instrumentFramebufferManager,
    instrumentShaderEmission,
    instrumentContextDraw,
    instrumentContextClear,
    recordFramePasses,
    instrumentPassEncoders,
    instrumentBufferUploads,
    instrumentPipelines,
    instrumentUniformValues,
    enableFrameReadback,
    enableBufferReadback,
    readCanvasDepth,
    overridePipelineState,
    createDepthIndicatorResources,
    depthIndicatorInputs,
    decodeMember,
    decodeBlock,
    multiplyMatrix4Vector,
    remapClipDepth,
  };
}

/** Resolve one scenario to its runner, preferring the in-file registry. */
async function resolveScenario(name) {
  const inline = SCENARIOS[name];
  if (inline !== undefined) return { runner: inline, source: "probe.js" };
  const modulePath = SCENARIO_MODULES[name];
  if (modulePath === undefined) return { runner: undefined, source: null };
  const module = await import(modulePath);
  const runner = module.default;
  if (typeof runner !== "function") {
    throw new Error(`scenario module ${modulePath} MUST default-export a function (got ${typeof runner})`);
  }
  return { runner, source: modulePath };
}

/** `backend-core` is the composite independent test: construct + whole-switch + dispatch/present.
 *
 * The present phase runs **last** and leaves its frame on screen, because the harness screenshots the
 * canvas right after the page reports ready (that screenshot is the presentation evidence). */
async function runComposite(bundle, canvas) {
  step("composite-scene-construct");
  report.result.sceneConstruct = await scenarioSceneConstruct(bundle, canvas);
  step("composite-device-lost");
  report.result.deviceLost = await scenarioDeviceLost(bundle, canvas);
  step("composite-present");
  report.result.present = await scenarioPresent(bundle, canvas);
  step("composite-done");
  return report.result;
}

async function main() {
  instrumentWebgl2();
  instrumentWebgpuSide();
  try {
    const bundle = await import(bundleUrl);
    step("bundle-imported", { contextIsReplacement: bundle.Context?.name === "Context" });
    const canvas = createCanvas(Number(params.get("width") ?? 320), Number(params.get("height") ?? 200));
    report.result.bundleProvenance = {
      contextConstructorName: bundle.contextModule?.default?.name ?? null,
      contextLimitsMembers: ["maximumTextureSize", "maximumSamples", "maximumTextureFilterAnisotropy"].map((name) => ({ name, value: bundle.ContextLimits?.[name] ?? null })),
    };
    if (scenario === "backend-core") {
      await runComposite(bundle, canvas);
    } else {
      const { runner, source } = await resolveScenario(scenario);
      if (runner === undefined) {
        throw new Error(`unknown scenario "${scenario}" (in-file: ${Object.keys(SCENARIOS).join(", ")}; modules: ${Object.keys(SCENARIO_MODULES).join(", ")})`);
      }
      step("scenario-resolved", { scenario, source });
      const outcome = await runner(bundle, canvas, scenarioContext());
      report.result[scenario] = outcome !== null && typeof outcome === "object" && "result" in outcome ? outcome.result : outcome;
    }
  } catch (error) {
    report.errors.push({ name: error?.name ?? "Error", message: error?.message ?? String(error), category: error?.category ?? null, stack: error?.stack ?? null });
  } finally {
    report.webgl2 = webgl2Counters;
    report.webgpu = webgpuCounters;
    report.ready = true;
    globalThis.__contract = report;
  }
}

await main();
