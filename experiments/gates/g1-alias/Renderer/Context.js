/**
 * G-1 gate stub — replacement for upstream `@cesium/engine/Source/Renderer/Context.js`.
 *
 * This file is the `localFile` of the gate-local replacement manifest
 * (`experiments/gates/g1-alias/manifest.gate.json`, entries: `Renderer/Context.js`). The T008
 * alias plugin (`tools/rollup-plugin-engine-patch.mjs`) rewrites every import that *resolves*
 * to `<node_modules>/@cesium/engine/Source/Renderer/Context.js` — including `Scene.js`'s own
 * relative `import Context from "../Renderer/Context.js"` (`Scene/Scene.js:40`) — to this file.
 *
 * SCOPE (tasks.md T015): this gate only proves the **module-level replacement seam**:
 *   1. the real build chain rewrites the module,
 *   2. the replacement is what the real upstream `Scene` consumes at runtime,
 *   3. the seam does not explode.
 * It deliberately does NOT implement the WebGPU backend (that is W2, T042+). Every member that
 * the W2 backend will own but this stub does not implement throws a **diagnosable**
 * `not-implemented` error instead of returning an empty/black result (same discipline as the
 * Phase-3 skeleton helper `notImplemented` in T037; MUST NOT fail silently).
 *
 * The implemented surface is exactly what the upstream `Scene` **construction** path reads, and
 * every value is derived from the real canvas/GL context rather than hard-coded, so that the
 * consumption assertions in the gate are meaningful:
 *   - `Scene.js:195`  `Scene.defaultLogDepthBuffer && context.fragmentDepth`
 *   - `Scene.js:715-720` `context.drawingBufferWidth` / `context.drawingBufferHeight`
 *   - upstream `Context.js:81-82,335` builds `shaderCache` / `textureCache` / `uniformState` in the
 *     constructor, and the logic layer reads `context.uniformState` while constructing the scene;
 *     those three classes are **kept upstream modules**, so the real classes are instantiated here
 *   - upstream `Context.js:86-140` populates the kept module `Renderer/ContextLimits.js`, which
 *     the logic layer reads through `ContextLimits` getters (research §4 capability table).
 *
 * Provenance markers (`G1_STUB_MARKER`, `__g1Implementation`) exist so the gate can assert that
 * the object `Scene` holds really came from this file and not from the upstream module.
 */

import ContextLimits from "@cesium/engine/Source/Renderer/ContextLimits.js";
import ShaderCache from "@cesium/engine/Source/Renderer/ShaderCache.js";
import TextureCache from "@cesium/engine/Source/Renderer/TextureCache.js";
import UniformState from "@cesium/engine/Source/Renderer/UniformState.js";

/** Unique marker of this replacement; the bundle/MUST contain it, upstream MUST NOT. */
export const G1_STUB_MARKER = "G1-ALIAS-CONTEXT-STUB-v1";

/** Repository-relative path of this implementation (recorded in the gate artefact). */
export const G1_STUB_IMPLEMENTATION = "experiments/gates/g1-alias/Renderer/Context.js";

/** Diagnostics sink: the gate page reads it to prove *consumption*, not just substitution. */
export function gateDiagnostics() {
  const scope = globalThis;
  if (scope.__G1_ALIAS_STUB__ === undefined) {
    scope.__G1_ALIAS_STUB__ = { marker: G1_STUB_MARKER, constructions: [], reads: {}, notImplemented: [] };
  }
  return scope.__G1_ALIAS_STUB__;
}

function countRead(name) {
  const diagnostics = gateDiagnostics();
  diagnostics.reads[name] = (diagnostics.reads[name] ?? 0) + 1;
}

/** Diagnosable failure for every capability the W2 backend owns but this gate stub does not. */
function notImplemented(capability) {
  const diagnostics = gateDiagnostics();
  diagnostics.notImplemented.push(capability);
  const error = new Error(
    `G-1 alias stub (Renderer/Context.js replacement): "${capability}" is not implemented. ` +
      "This gate only proves the module-level replacement seam (tasks.md T015); the WebGPU backend is W2. " +
      "The stub fails loudly instead of returning an empty/black result.",
  );
  error.name = "G1AliasContextNotImplemented";
  error.category = "not-implemented";
  error.capability = capability;
  error.backend = "gate-stub";
  return error;
}

/** Ask the canvas for a WebGL2 context; `null` when this environment has none (e.g. CI). */
function acquireGl(canvas, webglOptions) {
  if (typeof canvas.getContext !== "function") return null;
  try {
    return canvas.getContext("webgl2", webglOptions) ?? null;
  } catch {
    return null;
  }
}

function extension(gl, names) {
  if (gl === null) return undefined;
  for (const name of names) {
    const value = gl.getExtension(name);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * The replacement context.
 *
 * @param {HTMLCanvasElement} canvas the canvas the scene draws into
 * @param {object} [options] upstream `ContextOptions` (`webgl` attributes are honoured)
 */
function G1AliasContext(canvas, options) {
  if (canvas === undefined || canvas === null) {
    throw new Error("G-1 alias stub: a canvas is required (upstream Context.js:44 `Check.defined`).");
  }
  const diagnostics = gateDiagnostics();
  const webglOptions = { ...(options?.webgl ?? {}) };
  // Upstream defaults (Context.js:55-58), kept identical so the gate exercises the real path.
  webglOptions.alpha = webglOptions.alpha ?? false;
  webglOptions.stencil = webglOptions.stencil ?? true;
  webglOptions.powerPreference = webglOptions.powerPreference ?? "high-performance";

  const gl = acquireGl(canvas, webglOptions);

  this._canvas = canvas;
  this._gl = gl;
  this._webgl2 = gl !== null && typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  this._id = `${G1_STUB_MARKER}-${diagnostics.constructions.length + 1}`;
  this._destroyed = false;
  this._notImplemented = notImplemented;

  // Validation/logging switches upstream exposes on the context (Context.js:75-79).
  this.validateFramebuffer = false;
  this.validateShaderProgram = false;
  this.logShaderCompilation = false;

  // Upstream `Context` builds these three collaborators in its constructor
  // (Context.js:81-82 `new ShaderCache(this)` / `new TextureCache()`, Context.js:335
  // `new UniformState()`), and the logic layer reads `context.uniformState` during scene
  // construction. They are **kept upstream modules** (not in the manifest), so the replacement
  // instantiates the real classes — the same thing the W2 backend will do (research §1 table:
  // `uniformState` is the single source of truth for uniform values, 57 logic-layer call sites).
  this._shaderCache = new ShaderCache(this);
  this._textureCache = new TextureCache();
  this._us = new UniformState();

  this._stencilBits = gl === null ? 0 : gl.getParameter(gl.STENCIL_BITS);

  if (gl !== null) {
    // Mirrors upstream Context.js:86-140 one-for-one: capabilities are read at construction time
    // and written into the *kept* upstream module `Renderer/ContextLimits.js`.
    ContextLimits._maximumCombinedTextureImageUnits = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
    ContextLimits._maximumCubeMapSize = gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE);
    ContextLimits._maximumFragmentUniformVectors = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
    ContextLimits._maximumTextureImageUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
    ContextLimits._maximumRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    ContextLimits._maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    ContextLimits._maximum3DTextureSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
    ContextLimits._maximumVaryingVectors = gl.getParameter(gl.MAX_VARYING_VECTORS);
    ContextLimits._maximumVertexAttributes = gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
    ContextLimits._maximumVertexTextureImageUnits = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS);
    ContextLimits._maximumVertexUniformVectors = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS);
    ContextLimits._maximumSamples = this._webgl2 ? gl.getParameter(gl.MAX_SAMPLES) : 0;

    const aliasedLineWidthRange = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE);
    ContextLimits._minimumAliasedLineWidth = aliasedLineWidthRange[0];
    ContextLimits._maximumAliasedLineWidth = aliasedLineWidthRange[1];
    const aliasedPointSizeRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    ContextLimits._minimumAliasedPointSize = aliasedPointSizeRange[0];
    ContextLimits._maximumAliasedPointSize = aliasedPointSizeRange[1];
    const maximumViewportDimensions = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    ContextLimits._maximumViewportWidth = maximumViewportDimensions[0];
    ContextLimits._maximumViewportHeight = maximumViewportDimensions[1];

    const highpFloat = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    ContextLimits._highpFloatSupported = highpFloat !== null && highpFloat.precision !== 0;
    const highpInt = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_INT);
    ContextLimits._highpIntSupported = highpInt !== null && highpInt.rangeMax !== 0;

    // Extension-derived capability flags (upstream Context.js:146-205).
    this._elementIndexUint = !!extension(gl, ["OES_element_index_uint"]);
    this._depthTexture = !!extension(gl, ["WEBGL_depth_texture", "WEBKIT_WEBGL_depth_texture"]);
    this._fragDepth = !!extension(gl, ["EXT_frag_depth"]);
    this._textureFloat = !!extension(gl, ["OES_texture_float"]);
    this._textureHalfFloat = !!extension(gl, ["OES_texture_half_float"]);
    this._supportsTextureLod = !!extension(gl, ["EXT_shader_texture_lod"]);
    this._colorBufferFloat = !!extension(gl, ["EXT_color_buffer_float", "WEBGL_color_buffer_float"]);
    this._colorBufferHalfFloat = !!extension(gl, ["EXT_color_buffer_half_float"]);
    this._floatBlend = !!extension(gl, ["EXT_float_blend"]);
    this._s3tc = !!extension(gl, ["WEBGL_compressed_texture_s3tc", "MOZ_WEBGL_compressed_texture_s3tc", "WEBKIT_WEBGL_compressed_texture_s3tc"]);
    this._pvrtc = !!extension(gl, ["WEBGL_compressed_texture_pvrtc", "WEBKIT_WEBGL_compressed_texture_pvrtc"]);
    this._astc = !!extension(gl, ["WEBGL_compressed_texture_astc"]);
    this._etc = !!extension(gl, ["WEBG_compressed_texture_etc"]);
    this._etc1 = !!extension(gl, ["WEBGL_compressed_texture_etc1"]);
    this._bc7 = !!extension(gl, ["EXT_texture_compression_bptc"]);

    const textureFilterAnisotropic =
      options?.allowTextureFilterAnisotropic === false ? undefined : extension(gl, ["EXT_texture_filter_anisotropic", "WEBKIT_EXT_texture_filter_anisotropic"]);
    ContextLimits._maximumTextureFilterAnisotropy =
      textureFilterAnisotropic === undefined ? 1.0 : gl.getParameter(textureFilterAnisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    ContextLimits._maximumDrawBuffers = this._webgl2 ? gl.getParameter(gl.MAX_DRAW_BUFFERS) : 0;
    ContextLimits._maximumColorAttachments = this._webgl2 ? gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) : 0;
  } else {
    for (const flag of [
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
    ]) {
      this[flag] = false;
    }
  }

  diagnostics.constructions.push({
    marker: G1_STUB_MARKER,
    canvas: { width: canvas.width ?? null, height: canvas.height ?? null, clientWidth: canvas.clientWidth ?? null, clientHeight: canvas.clientHeight ?? null },
    glContextType: gl === null ? null : this._webgl2 ? "webgl2" : "webgl1",
    webgl2: this._webgl2,
    webglOptions,
  });
}

Object.defineProperties(G1AliasContext.prototype, {
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
  shaderCache: {
    get: function () {
      countRead("shaderCache");
      return this._shaderCache;
    },
  },
  textureCache: {
    get: function () {
      countRead("textureCache");
      return this._textureCache;
    },
  },
  uniformState: {
    get: function () {
      countRead("uniformState");
      return this._us;
    },
  },
  webgl2: {
    get: function () {
      countRead("webgl2");
      return this._webgl2;
    },
  },
  drawingBufferWidth: {
    get: function () {
      countRead("drawingBufferWidth");
      // Real drawing buffer when a GL context exists; the canvas backing store otherwise
      // (a canvas with no context yet reports its intrinsic width).
      return this._gl === null ? this._canvas.width : this._gl.drawingBufferWidth;
    },
  },
  drawingBufferHeight: {
    get: function () {
      countRead("drawingBufferHeight");
      return this._gl === null ? this._canvas.height : this._gl.drawingBufferHeight;
    },
  },
  stencilBuffer: {
    get: function () {
      countRead("stencilBuffer");
      return this._stencilBits >= 8;
    },
  },
  msaa: {
    get: function () {
      countRead("msaa");
      return this._webgl2;
    },
  },
  elementIndexUint: {
    get: function () {
      countRead("elementIndexUint");
      return this._elementIndexUint || this._webgl2;
    },
  },
  depthTexture: {
    get: function () {
      countRead("depthTexture");
      return this._depthTexture || this._webgl2;
    },
  },
  floatingPointTexture: {
    get: function () {
      countRead("floatingPointTexture");
      return this._webgl2 || this._textureFloat;
    },
  },
  halfFloatingPointTexture: {
    get: function () {
      countRead("halfFloatingPointTexture");
      return this._webgl2 || this._textureHalfFloat;
    },
  },
  supportsTextureLod: {
    get: function () {
      countRead("supportsTextureLod");
      return this._webgl2 || this._supportsTextureLod;
    },
  },
  supportsBasis: {
    get: function () {
      countRead("supportsBasis");
      return this._s3tc || this._pvrtc || this._astc || this._etc || this._etc1 || this._bc7;
    },
  },
  fragmentDepth: {
    get: function () {
      countRead("fragmentDepth");
      return this._fragDepth || this._webgl2;
    },
  },
  instancedArrays: {
    get: function () {
      countRead("instancedArrays");
      return this._webgl2 || this._instancedArrays === true;
    },
  },
  colorBufferFloat: {
    get: function () {
      countRead("colorBufferFloat");
      return this._colorBufferFloat;
    },
  },
  colorBufferHalfFloat: {
    get: function () {
      countRead("colorBufferHalfFloat");
      return (this._webgl2 && this._colorBufferFloat) || (!this._webgl2 && this._colorBufferHalfFloat);
    },
  },
  drawBuffers: {
    get: function () {
      countRead("drawBuffers");
      return this._webgl2;
    },
  },
  floatBlend: {
    get: function () {
      countRead("floatBlend");
      return this._floatBlend;
    },
  },
});

// --- members the W2 backend owns: explicit, diagnosable failures -------------------------------
for (const capability of ["defaultTexture", "defaultCubeMap"]) {
  Object.defineProperty(G1AliasContext.prototype, capability, {
    get: function () {
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
  Object.defineProperty(G1AliasContext.prototype, capability, {
    value: function () {
      throw notImplemented(capability);
    },
  });
}

G1AliasContext.prototype.isDestroyed = function () {
  return this._destroyed;
};

/** Upstream `Context.prototype.destroy` returns `undefined` and sets `Scene._context` to nothing. */
G1AliasContext.prototype.destroy = function () {
  this._destroyed = true;
  return undefined;
};

// Provenance markers read by the gate page (they are the assertion that the replacement is live).
G1AliasContext.G1_STUB_MARKER = G1_STUB_MARKER;
G1AliasContext.G1_STUB_IMPLEMENTATION = G1_STUB_IMPLEMENTATION;
G1AliasContext.__g1GateStub = true;

export default G1AliasContext;
