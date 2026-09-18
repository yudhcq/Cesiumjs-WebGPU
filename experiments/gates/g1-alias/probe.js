/**
 * G-1 gate probe — runs inside the browser (tasks.md T015).
 *
 * The bundle under test is the **real build output** of `build.mjs`
 * (`experiments/gates/out/g1-alias/bundle.js`), produced by Rollup with the T008 alias plugin.
 * Its `Scene` and `Context` bindings therefore come from the upstream package except for
 * `Renderer/Context.js`, which the alias plugin rewrote to `./Renderer/Context.js`.
 *
 * What this probe does:
 *   1. constructs the real upstream `Scene` with **no context injected** — the only way it can
 *      obtain a context is the rewritten module;
 *   2. asserts, in the page, that the object the scene holds is the replacement (module identity,
 *      constructor, provenance marker) and that the scene's own public API is served by it;
 *   3. asserts that the upstream logic-layer branch that depends on a capability flag
 *      (`Scene.js:195` → `_logDepthBuffer`, `Scene.js:723-726` → camera near/far) followed our
 *      value, and that the upstream *kept* module `Renderer/ContextLimits.js` received the
 *      capability values our constructor wrote;
 *   4. probes one method and one accessor that the W2 backend still owns, and asserts they fail
 *      **loudly** with `category === "not-implemented"` instead of returning a silent empty value;
 *   5. records the environment (browser, WebGL2 availability, WebGPU `adapter.info`).
 *
 * `scene._context` is an upstream `@private` member. It is used **only here, as a gate assertion**
 * — the implementation path (`packages/cesium-webgpu/**`) never touches it (asserted by the
 * `private-members-confined-to-gate-assertions` build check).
 *
 * The bundle is loaded through a dynamic import so the runner can point the very same probe at a
 * **negative control bundle** (`page.html?bundle=../out/g1-alias-control/bundle.js`, built with an
 * empty manifest): a gate that cannot fail proves nothing, so `run.mjs --control=no-rewrite`
 * checks that this probe really does report "not our implementation" when no rewrite happens.
 */
const BUNDLE_URL = new URLSearchParams(globalThis.location?.search ?? "").get("bundle") ?? "../out/g1-alias/bundle.js";
const bundle = await import(BUNDLE_URL);
const { Context, ContextLimits, G1_STUB_IMPLEMENTATION, G1_STUB_MARKER, LocalContext, Scene, contextIdentity, gateDiagnostics } = bundle;

function serialiseError(error) {
  if (error === null || error === undefined) return null;
  return {
    name: error.name ?? null,
    message: error.message ?? String(error),
    category: error.category ?? null,
    capability: error.capability ?? null,
    stack: error.stack ?? null,
  };
}

/** Keep the report structured-cloneable: never put live engine/GL objects into it. */
function safeValue(value) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === "number" || type === "string" || type === "boolean") return value;
  return { kind: type, constructorName: value?.constructor?.name ?? null };
}

function probe(description, fn) {
  try {
    return { description, threw: false, value: safeValue(fn()), error: null };
  } catch (error) {
    return { description, threw: true, value: null, error: serialiseError(error) };
  }
}

async function probeWebGpu() {
  const result = { available: false, reason: null, adapterInfo: null, isFallbackAdapter: null, preferredFormat: null, requestDeviceOk: null };
  if (typeof navigator === "undefined" || navigator.gpu === undefined) {
    result.reason = "navigator.gpu is undefined";
    return result;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) {
      result.reason = "requestAdapter() returned null";
      return result;
    }
    const info = adapter.info ?? {};
    result.available = true;
    result.adapterInfo = {
      vendor: info.vendor ?? null,
      architecture: info.architecture ?? null,
      device: info.device ?? null,
      description: info.description ?? null,
      subgroupMinSize: info.subgroupMinSize ?? null,
      subgroupMaxSize: info.subgroupMaxSize ?? null,
    };
    result.isFallbackAdapter = adapter.isFallbackAdapter ?? null;
    result.preferredFormat = navigator.gpu.getPreferredCanvasFormat();
    const device = await adapter.requestDevice();
    result.requestDeviceOk = device !== null && device !== undefined;
    device?.destroy?.();
  } catch (error) {
    result.reason = `${error.name ?? "Error"}: ${error.message ?? error}`;
  }
  return result;
}

export async function runProbe() {
  const startedAt = new Date().toISOString();
  const diagnostics = gateDiagnostics();
  const report = {
    startedAt,
    bundleLoaded: true,
    bundleUrl: BUNDLE_URL,
    marker: G1_STUB_MARKER,
    implementation: G1_STUB_IMPLEMENTATION,
    /** Deep bare import and gate-local file MUST be the same module instance. */
    contextIdentity,
    canvas: null,
    construction: null,
    consumption: null,
    upstreamLimits: null,
    notImplementedProbes: null,
    destroyObservation: null,
    environment: {
      userAgent: navigator.userAgent,
      devicePixelRatio: globalThis.devicePixelRatio ?? null,
      webgl2Available: null,
      webgpu: null,
    },
    diagnostics: null,
  };

  const container = document.getElementById("g1-container");
  const canvas = document.getElementById("g1-canvas");
  canvas.width = 320;
  canvas.height = 200;
  report.canvas = {
    id: canvas.id,
    parentId: container?.id ?? null,
    width: canvas.width,
    height: canvas.height,
    clientWidth: canvas.clientWidth,
    clientHeight: canvas.clientHeight,
    hasParentNode: canvas.parentNode !== null && canvas.parentNode !== undefined,
  };
  // Independent WebGL2 availability probe on a throwaway canvas, so "no GL" is distinguishable
  // from "the stub failed to acquire one".
  const probeCanvas = document.createElement("canvas");
  probeCanvas.width = 8;
  probeCanvas.height = 8;
  report.environment.webgl2Available = probeCanvas.getContext("webgl2") !== null;
  report.environment.webgpu = await probeWebGpu();

  let scene = null;
  try {
    // The decisive step: the real upstream Scene, with no `context` handed to it.
    scene = new Scene({ canvas });
    report.construction = { threw: false, error: null };
  } catch (error) {
    report.construction = { threw: true, error: serialiseError(error) };
  }

  if (scene !== null) {
    // ---- (a) the scene's context is our replacement -----------------------------------------
    const context = scene._context; // PRIVATE MEMBER — gate assertion only (tasks.md T015)
    const glAquired = context?._gl ?? null;
    report.consumption = {
      contextConstructorName: context?.constructor?.name ?? null,
      contextInstanceOfBundleContext: context instanceof Context,
      contextInstanceOfLocalFile: context instanceof LocalContext,
      gateStubFlag: context?.constructor?.__g1GateStub ?? null,
      stubMarkerOnContext: context?.constructor?.G1_STUB_MARKER ?? null,
      contextId: typeof context?.id === "string" ? context.id : null,
      /** Real values read back through upstream `Scene`'s own public getters. */
      sceneDrawingBufferWidth: scene.drawingBufferWidth,
      sceneDrawingBufferHeight: scene.drawingBufferHeight,
      contextDrawingBufferWidth: context?.drawingBufferWidth ?? null,
      contextDrawingBufferHeight: context?.drawingBufferHeight ?? null,
      glContextAcquired: glAquired !== null,
      glContextType: glAquired === null ? null : glAquired instanceof WebGL2RenderingContext ? "webgl2" : "webgl1",
      glDrawingBufferWidth: glAquired === null ? null : glAquired.drawingBufferWidth,
      glDrawingBufferHeight: glAquired === null ? null : glAquired.drawingBufferHeight,
      /** Capability flag read by `Scene.js:195`. */
      fragmentDepth: context?.fragmentDepth ?? null,
      sceneDefaultLogDepthBuffer: Scene.defaultLogDepthBuffer,
      sceneLogDepthBuffer: scene._logDepthBuffer, // upstream @private — gate assertion only
      logDepthLinkageHolds: scene._logDepthBuffer === (Scene.defaultLogDepthBuffer === true && context?.fragmentDepth === true),
      cameraNear: scene.camera?.frustum?.near ?? null,
      cameraFar: scene.camera?.frustum?.far ?? null,
      cameraServedByScene: scene.camera?.constructor?.name ?? null,
      sceneCanvasIsGateCanvas: scene.canvas === canvas,
      sceneMsaaSamples: scene.msaaSamples ?? null,
      /** Independent control: a throwaway WebGL2 context reports the same drawing buffer size. */
      probeGlDrawingBufferWidth: (() => {
        const gl = probeCanvas.getContext("webgl2");
        return gl === null ? null : gl.drawingBufferWidth;
      })(),
    };

    // ---- (c) the kept upstream module received our capability values -------------------------
    report.upstreamLimits = {
      module: "node_modules/@cesium/engine/Source/Renderer/ContextLimits.js (not in the manifest)",
      maximumTextureSize: ContextLimits.maximumTextureSize,
      maximumCubeMapSize: ContextLimits.maximumCubeMapSize,
      maximum3DTextureSize: ContextLimits.maximum3DTextureSize,
      maximumSamples: ContextLimits.maximumSamples,
      maximumVertexAttributes: ContextLimits.maximumVertexAttributes,
      maximumTextureImageUnits: ContextLimits.maximumTextureImageUnits,
      glMaximumTextureSize: glAquired === null ? null : glAquired.getParameter(glAquired.MAX_TEXTURE_SIZE),
      glMaximumSamples: glAquired === null || !(glAquired instanceof WebGL2RenderingContext) ? null : glAquired.getParameter(glAquired.MAX_SAMPLES),
      writtenByReplacement: (ContextLimits.maximumTextureSize ?? 0) > 0,
    };

    // ---- (d) the stub fails loudly on capabilities the W2 backend owns ----------------------
    const methodProbe = probe("context.draw(...)", () => context.draw());
    const accessorProbe = probe("context.defaultTexture", () => context.defaultTexture);
    report.notImplementedProbes = {
      method: methodProbe,
      accessor: accessorProbe,
      /** `true` when both probes failed with `category === "not-implemented"` (never silently). */
      allCategoryNotImplemented:
        methodProbe.threw && methodProbe.error?.category === "not-implemented" && accessorProbe.threw && accessorProbe.error?.category === "not-implemented",
    };

    // ---- informational: what upstream `Scene.destroy()` reaches (NOT a gate criterion) ------
    // The kept collaborators (`shaderCache` / `textureCache` / `uniformState`) make the teardown
    // path reachable, so this normally completes. It is recorded for completeness; the teardown
    // semantics of the *WebGPU* resource layer remain W2 scope (T042+).
    const destroyResult = probe("scene.destroy()", () => scene.destroy());
    report.destroyObservation = {
      note: "informational only: what upstream Scene.destroy() reached through the replacement; the WebGPU resource/teardown semantics belong to W2 (T042+)",
      threw: destroyResult.threw,
      error: destroyResult.error,
      sceneContextAfterDestroy: scene._context === undefined || scene._context === null ? "cleared" : "still set",
    };
  }

  report.diagnostics = {
    constructionCount: diagnostics.constructions.length,
    constructions: diagnostics.constructions,
    reads: { ...diagnostics.reads },
    notImplemented: [...diagnostics.notImplemented],
  };
  report.finishedAt = new Date().toISOString();
  return report;
}

window.__g1 = {
  ready: false,
  report: null,
  error: null,
};

runProbe()
  .then((result) => {
    window.__g1.report = result;
    window.__g1.ready = true;
  })
  .catch((error) => {
    window.__g1.error = { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack ?? null };
    window.__g1.ready = true;
  });
