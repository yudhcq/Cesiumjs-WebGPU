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
  // WebGPU bakes the sample count into the pipeline, so the workload needs one pipeline per
  // (format, sampleCount) pair — exactly what the W4 front-end will do through the pipeline cache.
  const pipelines = new Map();
  const pipelineFor = (sampleCount) => {
    let pipeline = pipelines.get(sampleCount);
    if (pipeline === undefined) {
      pipeline = device.createRenderPipeline({
        label: `contract-triangle-samples${sampleCount}`,
        layout: "auto",
        vertex: {
          module: module_,
          entryPoint: "vs_main",
          buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }],
        },
        fragment: { module: module_, entryPoint: "fs_main", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
        multisample: { count: sampleCount },
      });
      pipelines.set(sampleCount, pipeline);
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
  return {
    shaderProgramId: `contract-triangle-${sampleCount}`,
    pipeline: resources.pipelineFor(sampleCount),
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
  const offscreenInputs = drawInputsFor(resources, { sampleCount: 1 });
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
  // authoritative presentation evidence is the harness screenshot taken right after this scenario —
  // which is also why the backend is left alive and the last frame stays presented.
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

/** T051: `device.destroy()` → stop, destroy, re-probe, rebuild; the record is the evidence. */
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
  const offscreenInputs = drawInputsFor(resources, { sampleCount: 1 });
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
 * The colour travels **through the vertex buffer**, so the drawn pixel proves what the buffer holds —
 * which is what makes "buffer upload ordering" observable rather than assumed.
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
function createW3GpuPipelines(device, format, sampleCount) {
  const vertexModule = device.createShaderModule({ label: "w3-vertex-colour", code: W3_VERTEX_WGSL });
  const texturedModule = device.createShaderModule({ label: "w3-textured-quad", code: W3_TEXTURED_WGSL });
  return {
    vertexModule,
    texturedModule,
    vertexPipeline: device.createRenderPipeline({
      label: `w3-vertex-colour-${format}-${sampleCount}`,
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
    }),
    texturedPipeline: device.createRenderPipeline({
      label: `w3-textured-quad-${format}-${sampleCount}`,
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
    const swapchain = createW3GpuPipelines(context.device, context.swapchainFormat, context.sampleCount);
    const offscreen = createW3GpuPipelines(context.device, "rgba8unorm", 4);
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

const SCENARIOS = {
  "scene-construct": scenarioSceneConstruct,
  "draw-dispatch": scenarioDrawDispatch,
  present: scenarioPresent,
  "device-lost": scenarioDeviceLost,
  "pass-sequence": scenarioPassSequence,
  resources: scenarioResources,
  "texture-origin": scenarioTextureOrigin,
};

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
      const runner = SCENARIOS[scenario];
      if (runner === undefined) throw new Error(`unknown scenario "${scenario}" (known: ${Object.keys(SCENARIOS).join(", ")})`);
      const outcome = await runner(bundle, canvas);
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
