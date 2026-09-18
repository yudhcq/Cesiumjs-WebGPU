/**
 * G-2 gate stub — replacement for upstream `@cesium/engine/Source/Renderer/Context.js`.
 *
 * Tasks.md T016: "预取 adapter/device → 写入后端层交接槽 → **同步**构造上游 `Scene`（桩 Context 从槽中取设备），
 * 断言 (a) 两种后端下都能构造场景、(b) `ContextLimits` 与能力标志在 `Scene` 构造期同步可读、
 * (c) 记录被触发的逻辑层分支并与 research §4 表逐项一致".
 *
 * What this stub does — and deliberately does not do:
 *   - it **takes the device from the handoff slot synchronously, inside the constructor** (the H-2
 *     claim); `takeHandoff()` is called with no `await` in between, and the call stack of the take is
 *     recorded as evidence;
 *   - it composes the capability snapshot from `adapter.limits` / `adapter.features`
 *     (`capability-map.mjs`, the executable form of research §4) and publishes it **before the
 *     constructor returns**, so every capability/`ContextLimits` read performed by the upstream
 *     `Scene` constructor already sees the final value;
 *   - it writes the `ContextLimits` values into the **kept upstream module**
 *     `Renderer/ContextLimits.js` (the logic layer reads them through its getters);
 *   - it logs every capability read with a tick so the gate can prove *which* flags the logic layer
 *     consumed **during construction** and that the values did not change afterwards (an async
 *     "false value first, real value later" design would fail that assertion — research §3);
 *   - it does **not** acquire a WebGL context by default: `mode=strict` proves that the whole upstream
 *     `Scene` construction completes with zero WebGL context acquisitions. `mode=carrier` (opt-in via
 *     `globalThis.__G2_GL_CARRIER__`) additionally acquires a WebGL2 context for the upstream resource
 *     classes this gate does not replace — recorded as a deviation if it turns out to be necessary;
 *   - every member the W2 backend will own (`draw`, `clear`, `beginFrame`, `endFrame`,
 *     `defaultTexture`, …) throws a **diagnosable** `not-implemented` error (T037 discipline);
 *     it never returns an empty/black result.
 */

import ContextLimits from "@cesium/engine/Source/Renderer/ContextLimits.js";
import ShaderCache from "@cesium/engine/Source/Renderer/ShaderCache.js";
import TextureCache from "@cesium/engine/Source/Renderer/TextureCache.js";
import UniformState from "@cesium/engine/Source/Renderer/UniformState.js";

import { HANDOFF_CATEGORY, takeHandoff } from "../device-handoff.mjs";
import { MVP_SLICE, composeCapabilities } from "../capability-map.mjs";

/** Unique marker of this replacement; the bundle MUST contain it and the upstream module MUST NOT. */
export const G2_STUB_MARKER = "G2-HANDOFF-CONTEXT-STUB-v1";

/** Repository-relative path of this implementation (recorded in the gate artefact). */
export const G2_STUB_IMPLEMENTATION = "experiments/gates/g2-handoff/Renderer/Context.js";

/** Monotonic counter shared by the stub and the gate page (read ordering evidence). */
export function gateClock() {
  const scope = globalThis;
  scope.__G2_TICK__ = (scope.__G2_TICK__ ?? 0) + 1;
  return scope.__G2_TICK__;
}

/** Diagnostics sink: the gate page reads it to prove *consumption*, not just substitution. */
export function g2Diagnostics() {
  const scope = globalThis;
  if (scope.__G2_HANDOFF_STUB__ === undefined) {
    scope.__G2_HANDOFF_STUB__ = {
      marker: G2_STUB_MARKER,
      constructions: [],
      reads: [],
      readCounts: {},
      notImplemented: [],
      branches: [],
      glContextRequests: 0,
    };
  }
  return scope.__G2_HANDOFF_STUB__;
}

function recordRead(name, value) {
  const diagnostics = g2Diagnostics();
  diagnostics.readCounts[name] = (diagnostics.readCounts[name] ?? 0) + 1;
  // Bounded log: the first 500 reads are enough to prove ordering; counts stay exact.
  if (diagnostics.reads.length < 500) diagnostics.reads.push({ name, value: normalise(value), tick: gateClock() });
}

function normalise(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  return typeof value;
}

/** Diagnosable failure for every capability the W2 backend owns but this gate stub does not. */
function notImplemented(capability) {
  const diagnostics = g2Diagnostics();
  diagnostics.notImplemented.push(capability);
  const error = new Error(
    `G-2 handoff stub (Renderer/Context.js replacement): "${capability}" is not implemented. ` +
      "This gate only proves device handoff + synchronous capability publication (tasks.md T016); " +
      "the WebGPU command path is W2 (T044). The stub fails loudly instead of returning an empty result.",
  );
  error.name = "G2HandoffContextNotImplemented";
  error.category = "not-implemented";
  error.capability = capability;
  error.backend = "gate-stub";
  return error;
}

/** Diagnosable failure when no device was handed over (negative control + honest boundary). */
function noDevice() {
  const error = new Error(
    "G-2 handoff stub: the device handoff slot is empty. The backend MUST install { adapter, device } " +
      "before the upstream Scene is constructed (research §3 step 1-3). Without it there is no WebGPU " +
      "device, and this gate deliberately does not fall back to WebGL2 inside the replacement — the " +
      "WebGL2 path is the upstream `Renderer/Context.js`, used when the alias manifest does not replace it.",
  );
  error.name = "G2HandoffContextNoDevice";
  error.category = HANDOFF_CATEGORY.missing;
  error.backend = "gate-stub";
  return error;
}

/** Ask the canvas for a WebGL2 context (carrier mode only); `null` when unavailable. */
function acquireGl(canvas, webglOptions) {
  if (typeof canvas.getContext !== "function") return null;
  try {
    g2Diagnostics().glContextRequests += 1;
    return canvas.getContext("webgl2", webglOptions) ?? null;
  } catch {
    return null;
  }
}

const CARRIER_FLAGS = [
  "_elementIndexUint",
  "_depthTexture",
  "_fragDepth",
  "_textureFloat",
  "_textureHalfFloat",
  "_supportsTextureLod",
  "_colorBufferFloat",
  "_colorBufferHalfFloat",
  "_floatBlend",
  "_s3tc",
  "_pvrtc",
  "_astc",
  "_etc",
  "_etc1",
  "_bc7",
];

/**
 * The replacement context.
 *
 * @param {HTMLCanvasElement} canvas the canvas the scene draws into
 * @param {object} [options] upstream `ContextOptions`
 */
function G2HandoffContext(canvas, options) {
  if (canvas === undefined || canvas === null) {
    throw new Error("G-2 handoff stub: a canvas is required (upstream Context.js:44 `Check.defined`).");
  }
  const diagnostics = g2Diagnostics();
  const constructedAtTick = gateClock();

  // ---- synchronous device handoff: the central claim of this gate -------------------------------
  // No `await` is allowed between install() and new Scene(); this call is made inside the
  // constructor, before any capability is published, and its stack is recorded as evidence.
  const payload = takeHandoff({ tick: constructedAtTick, source: G2_STUB_MARKER });
  if (payload === undefined) throw noDevice();

  const capabilities = composeCapabilities({
    adapter: payload.adapter,
    device: payload.device,
    limits: payload.limits,
    features: payload.features,
    slice: MVP_SLICE,
  });

  this._canvas = canvas;
  this._device = payload.device;
  this._adapter = payload.adapter;
  this._capabilities = capabilities;
  this._flags = { ...capabilities.flags };
  this._id = `${G2_STUB_MARKER}-${diagnostics.constructions.length + 1}`;
  this._destroyed = false;
  this._notImplemented = notImplemented;
  this._mode = globalThis.__G2_GL_CARRIER__ === true ? "carrier" : "strict";

  // Upstream Context.js:75-79 validation/logging switches.
  this.validateFramebuffer = false;
  this.validateShaderProgram = false;
  this.logShaderCompilation = false;

  // Upstream collaborators built in the constructor (Context.js:81-82, :335). Kept modules.
  this._shaderCache = new ShaderCache(this);
  this._textureCache = new TextureCache();
  this._us = new UniformState();
  this._stencilBits = capabilities.flags.stencilBits;

  // ---- publish the composition into the KEPT upstream ContextLimits module ---------------------
  for (const [member, value] of Object.entries(capabilities.limits)) {
    const backing = `_${member}`;
    if (backing in ContextLimits) ContextLimits[backing] = value;
  }

  // Carrier mode: a real WebGL2 context for the upstream resource classes this gate does not
  // replace. Strict mode leaves `_gl` null and records whether anything needed it.
  this._gl = null;
  this._glAcquired = false;
  if (this._mode === "carrier") {
    const webglOptions = { ...(options?.webgl ?? {}) };
    webglOptions.alpha = webglOptions.alpha ?? false;
    webglOptions.stencil = webglOptions.stencil ?? true;
    webglOptions.powerPreference = webglOptions.powerPreference ?? "high-performance";
    this._gl = acquireGl(canvas, webglOptions);
    this._glAcquired = this._gl !== null;
    for (const flag of CARRIER_FLAGS) this[flag] = false;
  }

  // ---- construction-time snapshots (the "synchronously readable" evidence) ---------------------
  // NOTE: the snapshot is taken from the composed values, NOT by reading `ContextLimits` back. The
  // gate instruments the upstream module's backing fields, so every read observed during the
  // construction window is attributable to the *upstream logic layer* — the replacement only writes.
  const contextLimitsSnapshot = { ...capabilities.limits };
  diagnostics.constructions.push({
    marker: G2_STUB_MARKER,
    mode: this._mode,
    constructedAtTick,
    deviceIsObject: typeof this._device === "object" && this._device !== null,
    adapterVendor: payload.adapter?.info?.vendor ?? null,
    capabilitySnapshot: { ...this._flags },
    contextLimitsSnapshot,
    limitsWritten: Object.keys(capabilities.limits),
    limitsSource: payload.limits === undefined || payload.limits === null ? "device.limits" : "explicit",
  });
  this._contextLimitsSnapshot = contextLimitsSnapshot;
  this._capabilitySnapshot = { ...this._flags };
  this._publishedAtTick = gateClock();
}

Object.defineProperties(G2HandoffContext.prototype, {
  id: {
    get: function () {
      return this._id;
    },
  },
  canvas: {
    get: function () {
      return this._canvas;
    },
  },
  device: {
    get: function () {
      return this._device;
    },
  },
  adapter: {
    get: function () {
      return this._adapter;
    },
  },
  shaderCache: {
    get: function () {
      recordRead("shaderCache", this._shaderCache);
      return this._shaderCache;
    },
  },
  textureCache: {
    get: function () {
      recordRead("textureCache", this._textureCache);
      return this._textureCache;
    },
  },
  uniformState: {
    get: function () {
      recordRead("uniformState", this._us);
      return this._us;
    },
  },
  drawingBufferWidth: {
    get: function () {
      const value = this._gl === null ? this._canvas.width : this._gl.drawingBufferWidth;
      recordRead("drawingBufferWidth", value);
      return value;
    },
  },
  drawingBufferHeight: {
    get: function () {
      const value = this._gl === null ? this._canvas.height : this._gl.drawingBufferHeight;
      recordRead("drawingBufferHeight", value);
      return value;
    },
  },
  stencilBuffer: {
    get: function () {
      const value = this._flags.stencilBuffer === true;
      recordRead("stencilBuffer", value);
      return value;
    },
  },
  // --- research §4 capability flags: every one of them is logged with the adopted value ---------
  webgl2: {
    get: function () {
      recordRead("webgl2", this._flags.webgl2);
      return this._flags.webgl2;
    },
  },
  msaa: {
    get: function () {
      recordRead("msaa", this._flags.msaa);
      return this._flags.msaa;
    },
  },
  depthTexture: {
    get: function () {
      recordRead("depthTexture", this._flags.depthTexture);
      return this._flags.depthTexture;
    },
  },
  fragmentDepth: {
    get: function () {
      recordRead("fragmentDepth", this._flags.fragmentDepth);
      return this._flags.fragmentDepth;
    },
  },
  instancedArrays: {
    get: function () {
      recordRead("instancedArrays", this._flags.instancedArrays);
      return this._flags.instancedArrays;
    },
  },
  drawBuffers: {
    get: function () {
      recordRead("drawBuffers", this._flags.drawBuffers);
      return this._flags.drawBuffers;
    },
  },
  colorBufferFloat: {
    get: function () {
      recordRead("colorBufferFloat", this._flags.colorBufferFloat);
      return this._flags.colorBufferFloat;
    },
  },
  colorBufferHalfFloat: {
    get: function () {
      recordRead("colorBufferHalfFloat", this._flags.colorBufferHalfFloat);
      return this._flags.colorBufferHalfFloat;
    },
  },
  floatingPointTexture: {
    get: function () {
      recordRead("floatingPointTexture", this._flags.floatingPointTexture);
      return this._flags.floatingPointTexture;
    },
  },
  halfFloatingPointTexture: {
    get: function () {
      recordRead("halfFloatingPointTexture", this._flags.halfFloatingPointTexture);
      return this._flags.halfFloatingPointTexture;
    },
  },
  elementIndexUint: {
    get: function () {
      recordRead("elementIndexUint", this._flags.elementIndexUint);
      return this._flags.elementIndexUint;
    },
  },
  textureFilterAnisotropic: {
    get: function () {
      recordRead("textureFilterAnisotropic", this._flags.textureFilterAnisotropic);
      return this._flags.textureFilterAnisotropic;
    },
  },
  supportsBasis: {
    get: function () {
      recordRead("supportsBasis", this._flags.supportsBasis);
      return this._flags.supportsBasis;
    },
  },
  standardDerivatives: {
    get: function () {
      recordRead("standardDerivatives", this._flags.standardDerivatives);
      return this._flags.standardDerivatives;
    },
  },
  blendMinmax: {
    get: function () {
      recordRead("blendMinmax", this._flags.blendMinmax);
      return this._flags.blendMinmax;
    },
  },
  textureFloatLinear: {
    get: function () {
      recordRead("textureFloatLinear", this._flags.textureFloatLinear);
      return this._flags.textureFloatLinear;
    },
  },
  textureHalfFloatLinear: {
    get: function () {
      recordRead("textureHalfFloatLinear", this._flags.textureHalfFloatLinear);
      return this._flags.textureHalfFloatLinear;
    },
  },
  vertexArrayObject: {
    get: function () {
      recordRead("vertexArrayObject", this._flags.vertexArrayObject);
      return this._flags.vertexArrayObject;
    },
  },
});

// Compressed texture families: read through the same logging path (all false in the MVP).
for (const family of ["s3tc", "pvrtc", "astc", "etc", "etc1", "bc7"]) {
  Object.defineProperty(G2HandoffContext.prototype, family, {
    get: function () {
      recordRead(family, this._flags[family]);
      return this._flags[family];
    },
  });
}

// --- members the W2 backend owns: explicit, diagnosable failures -------------------------------
for (const capability of ["defaultTexture", "defaultCubeMap"]) {
  Object.defineProperty(G2HandoffContext.prototype, capability, {
    get: function () {
      recordRead(capability, "<not-implemented>");
      throw notImplemented(capability);
    },
  });
}

for (const capability of [
  "beginFrame",
  "endFrame",
  "clear",
  "draw",
  "createViewportQuadCommand",
  "createPickId",
  "getObjectByPickColor",
  "readPixels",
  "readPixelsToPBO",
]) {
  Object.defineProperty(G2HandoffContext.prototype, capability, {
    value: function () {
      recordRead(capability, "<not-implemented>");
      throw notImplemented(capability);
    },
  });
}

G2HandoffContext.prototype.isDestroyed = function () {
  return this._destroyed;
};

G2HandoffContext.prototype.destroy = function () {
  this._destroyed = true;
  return undefined;
};

/** Record a logic-layer branch and its condition value (gate evidence for T016 check (c)). */
G2HandoffContext.prototype.recordBranch = function (id, condition, value, consequence) {
  const diagnostics = g2Diagnostics();
  diagnostics.branches.push({ id, condition, value: normalise(value), consequence, tick: gateClock() });
  return value;
};

G2HandoffContext.G2_STUB_MARKER = G2_STUB_MARKER;
G2HandoffContext.G2_STUB_IMPLEMENTATION = G2_STUB_IMPLEMENTATION;
G2HandoffContext.__g2GateStub = true;
// Also on the prototype so instances answer `context.__g2GateStub` (provenance probe).
G2HandoffContext.prototype.__g2GateStub = true;

export default G2HandoffContext;
