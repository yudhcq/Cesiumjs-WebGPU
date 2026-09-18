/**
 * G-2 gate probe (tasks.md T016) — runs inside the browser, one backend per page load.
 *
 * `?backend=webgpu` (the primary run):
 *   1. instrument `HTMLCanvasElement.prototype.getContext` (platform-level observation; upstream code
 *      is never modified) so the gate can prove whether *anything* asked for a WebGL context;
 *   2. instrument the **kept upstream** `ContextLimits` object's getters (observation only: the saved
 *      getters are called unchanged, the descriptors are restored afterwards) so the gate can see
 *      *which* `ContextLimits` members the upstream logic layer reads **during construction**;
 *   3. prefetch `navigator.gpu` → `requestAdapter()` → `requestDevice()` (counting device requests);
 *   4. `installHandoff({adapter, device, limits, features})` and then — with **no `await` in between** —
 *      `new Scene({ canvas })`. The stub `Renderer/Context.js` takes the device synchronously inside
 *      its constructor and publishes the research §4 capabilities + `ContextLimits` before returning;
 *   5. collect the evidence: read log (with ticks) vs the construction window, per-flag values, the
 *      `ContextLimits` snapshot, the handoff audit (including the `take()` call stack), branch
 *      records, loud-failure probes and the WebGL-context request log.
 *
 * `?backend=webgl2` (the second backend run): no handoff is installed and the bundle's empty manifest
 * means the **upstream** `Renderer/Context.js` serves the scene; the probe asserts that provenance
 * (class identity, `webgl2 === true`, GL-derived drawing buffer) so the two runs cannot be confused.
 *
 * `?handoff=none` (negative control): the device is prefetched but **not** installed — the stub must
 * fail loudly, and the gate's checks MUST detect it.
 */

const params = new URLSearchParams(globalThis.location.search);
const bundleUrl = params.get("bundle") ?? "../out/g2-handoff/bundle.js";
const backend = params.get("backend") ?? "webgpu";
const handoffMode = params.get("handoff") ?? "install";

const report = {
  backend,
  handoffMode,
  startedAt: new Date().toISOString(),
  bundleUrl,
  environment: null,
  prefetch: null,
  handoff: null,
  construction: null,
  scene: null,
  capabilities: null,
  contextLimits: null,
  reads: null,
  branches: [],
  loudFailures: [],
  probes: {},
  errors: [],
};

/** The scene constructed by this probe (used for teardown after every assertion is recorded). */
let constructedScene = null;

function serialiseError(error) {
  if (error === null || error === undefined) return null;
  return {
    name: error.name ?? "Error",
    message: error.message ?? String(error),
    category: error.category ?? null,
    capability: error.capability ?? null,
    stack: typeof error.stack === "string" ? error.stack.split("\n").slice(0, 6).join("\n") : null,
  };
}

/** Snapshot a `GPUSupportedLimits` (its members are prototype getters in Chrome). */
function snapshotLimits(limits) {
  const out = {};
  if (limits === null || limits === undefined) return out;
  const names = new Set([...Object.getOwnPropertyNames(limits), ...Object.getOwnPropertyNames(Object.getPrototypeOf(limits) ?? {})]);
  for (const name of names) {
    if (name === "constructor") continue;
    try {
      const value = limits[name];
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") out[name] = value;
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Observation-only instrumentation of the upstream `ContextLimits` **backing fields**.
 *
 * The public getters of `Renderer/ContextLimits.js` are installed with `Object.defineProperties`
 * *without* `configurable: true`, so they cannot be wrapped; the backing data properties
 * (`_maximumTextureSize`, …) come from an object literal and **are** configurable. Wrapping them with
 * a logging getter/setter pair observes both
 *   - the writes performed by whichever `Context` implementation publishes the values, and
 *   - every read the upstream logic layer makes through the public getters (they return `ContextLimits._x`),
 * while returning exactly the same values (the upstream file on disk is never touched, and the
 * descriptors are restored when the probe finishes).
 */
function instrumentContextLimits(ContextLimits, tick) {
  const saved = new Map();
  const reads = [];
  const writes = [];
  for (const key of Object.getOwnPropertyNames(ContextLimits)) {
    if (!key.startsWith("_")) continue; // public getters are non-configurable; nothing to wrap there
    const descriptor = Object.getOwnPropertyDescriptor(ContextLimits, key);
    if (descriptor === undefined || typeof descriptor.get === "function" || descriptor.configurable !== true) continue;
    let current = descriptor.value;
    saved.set(key, descriptor);
    Object.defineProperty(ContextLimits, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        const phase = report.probes.getContextPhase ?? "idle";
        if (reads.length < 1000) reads.push({ member: key, value: current, phase, tick: tick() });
        return current;
      },
      set(next) {
        current = next;
        const phase = report.probes.getContextPhase ?? "idle";
        if (writes.length < 1000) writes.push({ member: key, value: typeof next === "number" || typeof next === "boolean" ? next : typeof next, phase, tick: tick() });
      },
    });
  }
  return {
    reads,
    writes,
    restore() {
      for (const [key, descriptor] of saved) Object.defineProperty(ContextLimits, key, descriptor);
    },
    captured: saved.size,
  };
}

async function run() {
  const canvas = document.getElementById("g2-canvas");
  const module = await import(bundleUrl);

  // ---- 1. platform-level observation: who asks for a WebGL context? ----------------------------
  const glRequests = [];
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
    if (typeof type === "string" && /webgl/i.test(type)) {
      glRequests.push({ type, isGateCanvas: this === canvas, duringConstruction: report.probes.getContextPhase === "construction" });
    }
    return originalGetContext.call(this, type, ...rest);
  };

  report.environment = {
    userAgent: globalThis.navigator?.userAgent ?? null,
    webgpuApi: typeof globalThis.navigator?.gpu === "object" && globalThis.navigator.gpu !== null,
    webgl2Api: (() => {
      try {
        const probe = document.createElement("canvas");
        return originalGetContext.call(probe, "webgl2") !== null;
      } catch {
        return false;
      }
    })(),
    devicePixelRatio: globalThis.devicePixelRatio ?? null,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  };

  const limitsInstrumentation = instrumentContextLimits(module.ContextLimits, module.gateClock);
  report.contextLimitsInstrumented = limitsInstrumentation.captured;

  try {
    if (backend === "webgl2") {
      report.probes.getContextPhase = "construction";
      const startTick = module.gateClock();
      let scene = null;
      let error = null;
      try {
        scene = new module.Scene({ canvas });
      } catch (thrown) {
        error = serialiseError(thrown);
      }
      const endTick = module.gateClock();
      report.probes.getContextPhase = "after";

      const context = scene === null ? null : scene.context;
      constructedScene = scene;
      report.construction = {
        startTick,
        endTick,
        threw: error !== null,
        error,
        contextIsStub: context?.__g2GateStub === true,
        contextConstructorName: context === null ? null : context.constructor?.name ?? null,
        contextIdentity: module.contextIdentity === true,
        contextIsReplaced: module.contextIsReplaced === true,
      };
      report.scene = scene === null ? null : describeScene(scene, context);
      if (scene !== null) {
        report.probes.instanceofUpstreamContext = context instanceof module.Context;
        report.probes.upstreamContextIsGateStub = context?.__g2GateStub === true;
        // Independent GL reference query (platform API only): proves the upstream Context derived its
        // ContextLimits values from the real WebGL2 implementation.
        try {
          const referenceCanvas = document.createElement("canvas");
          const referenceGl = originalGetContext.call(referenceCanvas, "webgl2");
          report.probes.glReference = referenceGl === null ? null : {
            maximumTextureSize: referenceGl.getParameter(referenceGl.MAX_TEXTURE_SIZE),
            maximumSamples: referenceGl.getParameter(referenceGl.MAX_SAMPLES),
            maximumVertexAttributes: referenceGl.getParameter(referenceGl.MAX_VERTEX_ATTRIBS),
            maximum3DTextureSize: referenceGl.getParameter(referenceGl.MAX_3D_TEXTURE_SIZE),
          };
        } catch (error) {
          report.probes.glReference = serialiseError(error);
        }
        report.probes.protobufReaderProbe = module.protobufReaderProbe ?? null;
        report.probes.contextLimitsAfterConstruction = {
          maximumTextureSize: module.ContextLimits.maximumTextureSize,
          maximumSamples: module.ContextLimits.maximumSamples,
          maximumVertexAttributes: module.ContextLimits.maximumVertexAttributes,
          maximum3DTextureSize: module.ContextLimits.maximum3DTextureSize,
          maximumTextureFilterAnisotropy: module.ContextLimits.maximumTextureFilterAnisotropy,
        };
      }
    } else {
      // ---- 2. prefetch the device ---------------------------------------------------------------
      const gpu = globalThis.navigator?.gpu ?? null;
      if (gpu === null) throw new Error("G-2 probe: navigator.gpu is unavailable in this browser.");
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter === null) throw new Error("G-2 probe: requestAdapter() returned null.");
      const adapterInfo = adapter.info ?? { vendor: null, architecture: null, device: null, description: null };
      let deviceRequests = 0;
      const originalRequestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = (...args) => {
        deviceRequests += 1;
        return originalRequestDevice(...args);
      };
      const device = await adapter.requestDevice();
      const limits = snapshotLimits(adapter.limits);
      const features = [...adapter.features];
      report.prefetch = {
        adapterInfo: { vendor: adapterInfo.vendor ?? null, architecture: adapterInfo.architecture ?? null, device: adapterInfo.device ?? null, description: adapterInfo.description ?? null },
        isFallbackAdapter: adapter.isFallbackAdapter ?? null,
        features,
        limits,
        deviceRequests,
        deviceIsObject: typeof device === "object" && device !== null,
        deviceLostHandled: typeof device.lost?.then === "function",
      };

      // ---- 3. handoff + SYNCHRONOUS construction (no await in between) --------------------------
      const installTick = module.gateClock();
      if (handoffMode === "install") {
        module.installHandoff({ adapter, device, limits, features, source: "g2-probe" }, { tick: installTick });
      }
      report.handoff = { installTick, installed: handoffMode === "install" };

      report.probes.getContextPhase = "construction";
      const startTick = module.gateClock();
      let scene = null;
      let constructionError = null;
      try {
        // The whole point of G-2: the upstream Scene is constructed SYNCHRONOUSLY, right after the
        // handoff, with no await/microtask in between.
        scene = new module.Scene({ canvas });
      } catch (thrown) {
        constructionError = serialiseError(thrown);
      }
      const endTick = module.gateClock();
      report.probes.getContextPhase = "after";

      const context = scene === null ? null : scene.context;
      constructedScene = scene;
      report.construction = {
        startTick,
        endTick,
        threw: constructionError !== null,
        error: constructionError,
        contextIsStub: context?.__g2GateStub === true,
        contextConstructorName: context === null ? null : context.constructor?.name ?? null,
        deviceIdentity: context === null ? null : context.device === device,
        adapterIdentity: context === null ? null : context.adapter === adapter,
        contextIdentity: module.contextIdentity === true,
        contextIsReplaced: module.contextIsReplaced === true,
      };
      report.scene = scene === null ? null : describeScene(scene, context);

      // ---- 4. construction-window analysis ------------------------------------------------------
      const diagnostics = module.g2Diagnostics();
      const inWindow = (entry) => entry.tick > startTick && entry.tick < endTick;
      const construction = diagnostics.constructions.at(-1) ?? null;
      report.capabilities = {
        composition: module.composeCapabilities({ adapter, device, limits, features }),
        declaredDefaults: Object.fromEntries(module.FLAG_TABLE.map((entry) => [entry.name, entry.value])),
        stubSnapshot: construction?.capabilitySnapshot ?? null,
        stubLimitsSnapshot: construction?.contextLimitsSnapshot ?? null,
        publishedAtTick: construction?.constructedAtTick ?? null,
      };
      report.reads = {
        counts: diagnostics.readCounts,
        duringConstruction: diagnostics.reads.filter(inWindow),
        all: diagnostics.reads,
        constructionWindow: { startTick, endTick },
      };
      // Snapshot *before* the loud-failure probes below, which legitimately append to the same array.
      report.probes.notImplementedAfterConstruction = [...diagnostics.notImplemented];
      report.probes.protobufReaderProbe = module.protobufReaderProbe ?? null;
      report.handoffAudit = module.handoffAudit();

      // ---- 5. loud-failure probes (the gate MUST NOT render a frame) ---------------------------
      if (context !== null) {
        for (const capability of ["draw", "clear", "beginFrame", "endFrame"]) {
          try {
            context[capability]({});
            report.loudFailures.push({ capability, threw: false, category: null });
          } catch (error) {
            report.loudFailures.push({ capability, threw: true, category: error.category ?? null, name: error.name ?? null });
          }
        }
        for (const accessor of ["defaultTexture", "defaultCubeMap"]) {
          try {
            void context[accessor];
            report.loudFailures.push({ capability: accessor, threw: false, category: null });
          } catch (error) {
            report.loudFailures.push({ capability: accessor, threw: true, category: error.category ?? null, name: error.name ?? null });
          }
        }
      }

      // ---- 6. slot contract probes -------------------------------------------------------------
      try {
        module.installHandoff({ adapter, device }, { scope: globalThis, tick: module.gateClock() });
        report.probes.doubleInstall = { threw: false, category: null };
      } catch (error) {
        report.probes.doubleInstall = { threw: true, category: error.category ?? null };
      }
      report.probes.peekAfterConstruction = module.peekHandoff({ scope: globalThis }) === undefined ? "empty" : "filled";
      report.probes.secondTake = module.takeHandoff({ scope: globalThis }) === undefined ? "empty" : "filled";
      report.probes.takeStack = (report.handoffAudit.audit.find((entry) => entry.op === "take") ?? {}).stack ?? null;
      report.probes.deviceRequests = deviceRequests;
      report.probes.glRequestsDuringConstruction = glRequests.filter((entry) => entry.duringConstruction === true);

      // ---- 7. observable logic-layer branches --------------------------------------------------
      if (context !== null && scene !== null) {
        context.recordBranch("Scene.js:195 fragmentDepth → _logDepthBuffer", "context.fragmentDepth", context.fragmentDepth, "scene.logarithmicDepthBuffer");
        context.recordBranch("Scene.js:723-726 _logDepthBuffer → camera near/far", "scene.logarithmicDepthBuffer", scene.logarithmicDepthBuffer, `camera.frustum.near/far = ${scene.camera.frustum.near}/${scene.camera.frustum.far}`);
        context.recordBranch("Scene/View.js:46 depthTexture → GlobeDepth creation", "context.depthTexture", context.depthTexture, "consequence observed via the WebGL-context request log (see probes.glRequestsDuringConstruction)");
        context.recordBranch("Scene.js:1721 msaa → Scene#msaaSupported", "context.msaa", context.msaa, "scene.msaaSupported");
        context.recordBranch(
          "Scene.js:1771-1781 compressed texture families → uncompressed path",
          "context.s3tc|pvrtc|astc|etc|etc1|bc7",
          [context.s3tc, context.pvrtc, context.astc, context.etc, context.etc1, context.bc7].join(","),
          "Scene#compressedTextureFormats-like probes stay false ⇒ the logic layer keeps its uncompressed texture path",
        );
        context.recordBranch("research §4 ContextLimits: maximumTextureFilterAnisotropy", "ContextLimits.maximumTextureFilterAnisotropy", module.ContextLimits.maximumTextureFilterAnisotropy, "sampler anisotropy request clamps to 1 (no anisotropic filtering in WebGPU)");
        report.branches = module.g2Diagnostics().branches.filter((entry) => entry.tick > endTick);
      }
      report.probes.glRequestsAll = glRequests;
      report.probes.notImplemented = module.g2Diagnostics().notImplemented;
      report.capabilities.stubSnapshotAfter = module.g2Diagnostics().constructions.at(-1)?.capabilitySnapshot ?? null;
      report.probes.protobufReaderProbe = module.protobufReaderProbe ?? null;
      report.probes.contextLimitsAfterConstruction = {
        maximumTextureSize: module.ContextLimits.maximumTextureSize,
        maximumSamples: module.ContextLimits.maximumSamples,
        maximumVertexAttributes: module.ContextLimits.maximumVertexAttributes,
        maximum3DTextureSize: module.ContextLimits.maximum3DTextureSize,
        maximumDrawBuffers: module.ContextLimits.maximumDrawBuffers,
        maximumColorAttachments: module.ContextLimits.maximumColorAttachments,
        maximumTextureFilterAnisotropy: module.ContextLimits.maximumTextureFilterAnisotropy,
        highpFloatSupported: module.ContextLimits.highpFloatSupported,
        highpIntSupported: module.ContextLimits.highpIntSupported,
      };
    }

    // ---- ContextLimits observation (both backends: the module is the same kept upstream module) --
    if (report.construction !== null) {
      const { startTick, endTick } = report.construction;
      const inWindow = (entry) => entry.tick > startTick && entry.tick < endTick;
      report.contextLimits = {
        instrumented: limitsInstrumentation.captured,
        writesDuringConstruction: limitsInstrumentation.writes.filter(inWindow),
        logicLayerReadsDuringConstruction: limitsInstrumentation.reads.filter((entry) => entry.phase === "construction"),
        reads: limitsInstrumentation.reads,
        writes: limitsInstrumentation.writes,
      };
    }

    // ---- teardown ------------------------------------------------------------------------------
    if (constructedScene !== null) {
      try {
        constructedScene.destroy();
        report.probes.destroyed = true;
        report.probes.contextDestroyedAfterSceneDestroy = constructedScene.context?.isDestroyed?.() ?? null;
      } catch (error) {
        report.probes.destroyed = serialiseError(error);
      }
    }
  } finally {
    limitsInstrumentation.restore();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  }

  return report;
}

/** Public-surface description of the constructed scene (no `@private` member is touched). */
function describeScene(scene, context) {
  const frustum = scene.camera?.frustum ?? null;
  return {
    canvasIsGateCanvas: scene.canvas === document.getElementById("g2-canvas"),
    drawingBufferWidth: scene.drawingBufferWidth,
    drawingBufferHeight: scene.drawingBufferHeight,
    logarithmicDepthBuffer: scene.logarithmicDepthBuffer,
    msaaSupported: scene.msaaSupported,
    msaaSamples: scene.msaaSamples,
    cameraNear: frustum === null ? null : frustum.near,
    cameraFar: frustum === null ? null : frustum.far,
    contextDrawingBufferWidth: context === null ? null : context.drawingBufferWidth,
    contextDrawingBufferHeight: context === null ? null : context.drawingBufferHeight,
    contextFragmentDepth: context === null ? null : context.fragmentDepth,
    contextDepthTexture: context === null ? null : context.depthTexture,
    contextMsaa: context === null ? null : context.msaa,
    contextWebgl2: context === null ? null : context.webgl2,
    contextId: context === null ? null : context.id,
  };
}

globalThis.__g2 = { ready: false, report: null, error: null };

try {
  const result = await run();
  report.finishedAt = new Date().toISOString();
  globalThis.__g2 = { ready: true, report: result, error: null };
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.errors.push(serialiseError(error));
  globalThis.__g2 = { ready: true, report, error: serialiseError(error) };
}
