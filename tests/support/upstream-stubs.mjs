/**
 * Stub sources for the **kept upstream modules** the patch layer imports through bare deep specifiers.
 *
 * In the real build (`tools/rollup-plugin-engine-patch.mjs` + `@rollup/plugin-node-resolve`) those
 * specifiers resolve to the installed `@cesium/engine` package. Inside `node --test` they cannot be
 * resolved from a `data:` URL, so `tests/support/ts-module-loader.mjs` lets a test inject the source
 * that should stand in for them.
 *
 * Two rules keep this honest:
 *   1. a stub is only used by the **unit** layer; the contract suites run the real modules in a real
 *      browser, so a stub can never make a product claim true on its own;
 *   2. a stub mirrors the *interface the patch layer consumes* (member names, arity, semantics), and
 *      `tests/unit/context-construction.test.mjs` asserts the `ContextLimits` stub really carries all
 *      23 upstream members — so a stub that drifts from the upstream shape fails the suite.
 */

/** The 23 public members of the kept upstream `Renderer/ContextLimits.js` (measured in G-2). */
export const CONTEXT_LIMITS_MEMBERS = [
  "maximumTextureSize",
  "maximumCubeMapSize",
  "maximum3DTextureSize",
  "maximumTextureImageUnits",
  "maximumVertexTextureImageUnits",
  "maximumCombinedTextureImageUnits",
  "maximumTextureFilterAnisotropy",
  "maximumRenderbufferSize",
  "maximumVertexAttributes",
  "maximumVaryingVectors",
  "maximumVertexUniformVectors",
  "maximumFragmentUniformVectors",
  "maximumColorAttachments",
  "maximumDrawBuffers",
  "maximumSamples",
  "minimumAliasedLineWidth",
  "maximumAliasedLineWidth",
  "minimumAliasedPointSize",
  "maximumAliasedPointSize",
  "maximumViewportWidth",
  "maximumViewportHeight",
  "highpFloatSupported",
  "highpIntSupported",
];

/**
 * Source of the `Renderer/ContextLimits.js` stub: backing fields **plus** the public getters, exactly
 * like upstream (`ContextLimits.js:7-29` fields, `:32-330` accessors).
 */
export function contextLimitsStubSource() {
  const fields = CONTEXT_LIMITS_MEMBERS.map((member) => `  _${member}: ${typeof DEFAULT_LIMITS[member] === "boolean" ? "false" : "0"},`).join("\n");
  const accessors = CONTEXT_LIMITS_MEMBERS.map(
    (member) => `  ${member}: {\n    get: function () { return this._${member}; },\n    set: function (value) { this._${member} = value; },\n  },`,
  ).join("\n");
  return `const ContextLimits = {\n${fields}\n};\nObject.defineProperties(ContextLimits, {\n${accessors}\n});\nContextLimits.__written = [];\nexport default ContextLimits;\n`;
}

/** Values the composition is expected to publish (used to derive the stub's field types). */
export const DEFAULT_LIMITS = {
  maximumTextureSize: 0,
  maximumCubeMapSize: 0,
  maximum3DTextureSize: 0,
  maximumTextureImageUnits: 0,
  maximumVertexTextureImageUnits: 0,
  maximumCombinedTextureImageUnits: 0,
  maximumTextureFilterAnisotropy: 0,
  maximumRenderbufferSize: 0,
  maximumVertexAttributes: 0,
  maximumVaryingVectors: 0,
  maximumVertexUniformVectors: 0,
  maximumFragmentUniformVectors: 0,
  maximumColorAttachments: 0,
  maximumDrawBuffers: 0,
  maximumSamples: 0,
  minimumAliasedLineWidth: 0,
  maximumAliasedLineWidth: 0,
  minimumAliasedPointSize: 0,
  maximumAliasedPointSize: 0,
  maximumViewportWidth: 0,
  maximumViewportHeight: 0,
  highpFloatSupported: false,
  highpIntSupported: false,
};

/** A trivial `default`-exporting module: enough for the kept classes the patch layer only constructs. */
function classStub(name, instanceMembers = "") {
  return `export default class ${name} {\n  constructor(...args) { this.__args = args; ${instanceMembers} }\n  destroy() {}\n  isDestroyed() { return false; }\n}\n`;
}

/** `ShaderProgram` stub: records `fromCache` calls and returns a program-like object. */
const SHADER_PROGRAM_STUB = `class ShaderProgram {\n  constructor(options) { this.__options = options; this._attributeLocations = options?.attributeLocations; }\n  static fromCache(options) { ShaderProgram.__calls.push(options); return new ShaderProgram(options); }\n  static get __calls() { return (ShaderProgram.__callsStore ??= []); }\n}\nexport default ShaderProgram;\n`;

/**
 * The GL-free enum modules the W3 resource layer consumes through bare deep specifiers.
 *
 * These are **faithful** stubs, not placeholders: the backend's mapping tables (`webgpu/format-map.ts`,
 * `webgpu/sampler-map.ts`) read exactly the members and the predicates below, and
 * `tests/unit/gl-enum-parity.test.mjs` compares every one of them against the installed upstream
 * module, so a stub that drifts from @cesium/engine 26.3.0 fails the suite instead of quietly making a
 * unit test pass.
 */
const PIXEL_FORMAT_STUB = `const PixelFormat = {
  DEPTH_COMPONENT: 0x1902, DEPTH_STENCIL: 0x84f9, ALPHA: 0x1906, RED: 0x1903, RG: 0x8227,
  RGB: 0x1907, RGBA: 0x1908, RED_INTEGER: 0x8d94, RG_INTEGER: 0x8228, RGB_INTEGER: 0x8d98,
  RGBA_INTEGER: 0x8d99, LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190a,
  RGB_DXT1: 0x83f0, RGBA_DXT1: 0x83f1, RGBA_DXT3: 0x83f2, RGBA_DXT5: 0x83f3,
  RGB_PVRTC_4BPPV1: 0x8c00, RGB_PVRTC_2BPPV1: 0x8c01, RGBA_PVRTC_4BPPV1: 0x8c02, RGBA_PVRTC_2BPPV1: 0x8c03,
  RGBA_ASTC: 0x93b0, RGB_ETC1: 0x8d64, RGB8_ETC2: 0x9274, RGBA8_ETC2_EAC: 0x9278, RGBA_BC7: 0x8e8c,
};
PixelFormat.componentsLength = function (pixelFormat) {
  switch (pixelFormat) {
    case PixelFormat.RGB: case PixelFormat.RGB_INTEGER: return 3;
    case PixelFormat.RGBA: case PixelFormat.RGBA_INTEGER: return 4;
    case PixelFormat.LUMINANCE_ALPHA: case PixelFormat.RG: case PixelFormat.RG_INTEGER: return 2;
    case PixelFormat.ALPHA: case PixelFormat.RED: case PixelFormat.RED_INTEGER: case PixelFormat.LUMINANCE: return 1;
    default: return 1;
  }
};
PixelFormat.validate = function (pixelFormat) {
  return [PixelFormat.DEPTH_COMPONENT, PixelFormat.DEPTH_STENCIL, PixelFormat.ALPHA, PixelFormat.RED, PixelFormat.RG,
    PixelFormat.RGB, PixelFormat.RGBA, PixelFormat.RED_INTEGER, PixelFormat.RG_INTEGER, PixelFormat.RGB_INTEGER,
    PixelFormat.RGBA_INTEGER, PixelFormat.LUMINANCE, PixelFormat.LUMINANCE_ALPHA, PixelFormat.RGB_DXT1,
    PixelFormat.RGBA_DXT1, PixelFormat.RGBA_DXT3, PixelFormat.RGBA_DXT5, PixelFormat.RGB_PVRTC_4BPPV1,
    PixelFormat.RGB_PVRTC_2BPPV1, PixelFormat.RGBA_PVRTC_4BPPV1, PixelFormat.RGBA_PVRTC_2BPPV1, PixelFormat.RGBA_ASTC,
    PixelFormat.RGB_ETC1, PixelFormat.RGB8_ETC2, PixelFormat.RGBA8_ETC2_EAC, PixelFormat.RGBA_BC7].includes(pixelFormat);
};
PixelFormat.isColorFormat = function (pixelFormat) {
  return [PixelFormat.RED, PixelFormat.ALPHA, PixelFormat.RGB, PixelFormat.RGBA, PixelFormat.LUMINANCE, PixelFormat.LUMINANCE_ALPHA].includes(pixelFormat);
};
PixelFormat.isDepthFormat = function (pixelFormat) {
  return pixelFormat === PixelFormat.DEPTH_COMPONENT || pixelFormat === PixelFormat.DEPTH_STENCIL;
};
PixelFormat.isCompressedFormat = function (pixelFormat) {
  return [PixelFormat.RGB_DXT1, PixelFormat.RGBA_DXT1, PixelFormat.RGBA_DXT3, PixelFormat.RGBA_DXT5, PixelFormat.RGB_PVRTC_4BPPV1,
    PixelFormat.RGB_PVRTC_2BPPV1, PixelFormat.RGBA_PVRTC_4BPPV1, PixelFormat.RGBA_PVRTC_2BPPV1, PixelFormat.RGBA_ASTC,
    PixelFormat.RGB_ETC1, PixelFormat.RGB8_ETC2, PixelFormat.RGBA8_ETC2_EAC, PixelFormat.RGBA_BC7].includes(pixelFormat);
};
PixelFormat.textureSizeInBytes = function (pixelFormat, pixelDatatype, width, height) {
  let components = PixelFormat.componentsLength(pixelFormat);
  // Mirror upstream's PixelDatatype.isPacked / sizeInBytes on the stub's own members.
  const packed = pixelDatatype === 0x84fa || pixelDatatype === 0x8033 || pixelDatatype === 0x8034 || pixelDatatype === 0x8363;
  if (packed) components = 1;
  let sizeInBytes;
  switch (pixelDatatype) {
    case 0x1401: sizeInBytes = 1; break;
    case 0x1403: case 0x8033: case 0x8034: case 0x8363: case 0x8d61: sizeInBytes = 2; break;
    case 0x1405: case 0x1406: case 0x84fa: sizeInBytes = 4; break;
    default: sizeInBytes = 0;
  }
  return components * sizeInBytes * width * height;
};
export default PixelFormat;\n`;

const PIXEL_DATATYPE_STUB = `const PixelDatatype = {
  UNSIGNED_BYTE: 0x1401, UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, FLOAT: 0x1406, HALF_FLOAT: 0x8d61,
  UNSIGNED_INT_24_8: 0x84fa, UNSIGNED_SHORT_4_4_4_4: 0x8033, UNSIGNED_SHORT_5_5_5_1: 0x8034, UNSIGNED_SHORT_5_6_5: 0x8363,
};
PixelDatatype.isPacked = function (pixelDatatype) {
  return [PixelDatatype.UNSIGNED_INT_24_8, PixelDatatype.UNSIGNED_SHORT_4_4_4_4, PixelDatatype.UNSIGNED_SHORT_5_5_5_1, PixelDatatype.UNSIGNED_SHORT_5_6_5].includes(pixelDatatype);
};
PixelDatatype.sizeInBytes = function (pixelDatatype) {
  switch (pixelDatatype) {
    case PixelDatatype.UNSIGNED_BYTE: return 1;
    case PixelDatatype.UNSIGNED_SHORT: case PixelDatatype.UNSIGNED_SHORT_4_4_4_4:
    case PixelDatatype.UNSIGNED_SHORT_5_5_5_1: case PixelDatatype.UNSIGNED_SHORT_5_6_5: case PixelDatatype.HALF_FLOAT: return 2;
    case PixelDatatype.UNSIGNED_INT: case PixelDatatype.FLOAT: case PixelDatatype.UNSIGNED_INT_24_8: return 4;
    default: return undefined;
  }
};
PixelDatatype.validate = function (pixelDatatype) {
  return Object.values(PixelDatatype).includes(pixelDatatype);
};
export default PixelDatatype;\n`;

const RENDERBUFFER_FORMAT_STUB = `const RenderbufferFormat = {
  RGBA4: 0x8056, RGBA8: 0x8058, RGBA16F: 0x881a, RGBA32F: 0x8814, RGB5_A1: 0x8057, RGB565: 0x8d62,
  DEPTH_COMPONENT16: 0x81a5, STENCIL_INDEX8: 0x8d48, DEPTH_STENCIL: 0x84f9, DEPTH24_STENCIL8: 0x88f0,
};
RenderbufferFormat.validate = function (renderbufferFormat) {
  return [RenderbufferFormat.RGBA4, RenderbufferFormat.RGBA8, RenderbufferFormat.RGBA16F, RenderbufferFormat.RGBA32F,
    RenderbufferFormat.RGB5_A1, RenderbufferFormat.RGB565, RenderbufferFormat.DEPTH_COMPONENT16,
    RenderbufferFormat.STENCIL_INDEX8, RenderbufferFormat.DEPTH_STENCIL, RenderbufferFormat.DEPTH24_STENCIL8].includes(renderbufferFormat);
};
RenderbufferFormat.getColorFormat = function (datatype) {
  if (datatype === 0x1406) return RenderbufferFormat.RGBA32F;
  if (datatype === 0x8d61) return RenderbufferFormat.RGBA16F;
  return RenderbufferFormat.RGBA8;
};
export default RenderbufferFormat;\n`;

const TEXTURE_WRAP_STUB = `const TextureWrap = { CLAMP_TO_EDGE: 0x812f, REPEAT: 0x2901, MIRRORED_REPEAT: 0x8370 };
TextureWrap.validate = function (textureWrap) {
  return textureWrap === TextureWrap.CLAMP_TO_EDGE || textureWrap === TextureWrap.REPEAT || textureWrap === TextureWrap.MIRRORED_REPEAT;
};
export default TextureWrap;\n`;

const TEXTURE_MINIFICATION_FILTER_STUB = `const TextureMinificationFilter = {
  NEAREST: 0x2600, LINEAR: 0x2601, NEAREST_MIPMAP_NEAREST: 0x2700,
  LINEAR_MIPMAP_NEAREST: 0x2701, NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703,
};
TextureMinificationFilter.validate = function (filter) {
  return Object.values(TextureMinificationFilter).includes(filter);
};
export default TextureMinificationFilter;\n`;

const TEXTURE_MAGNIFICATION_FILTER_STUB = `const TextureMagnificationFilter = { NEAREST: 0x2600, LINEAR: 0x2601 };
TextureMagnificationFilter.validate = function (filter) {
  return filter === TextureMagnificationFilter.NEAREST || filter === TextureMagnificationFilter.LINEAR;
};
export default TextureMagnificationFilter;\n`;

/** Faithful `Sampler` stub: upstream's six private fields, its getters, `equals` and `NEAREST`. */
const SAMPLER_STUB = `class Sampler {
  constructor(options = {}) {
    const { wrapR = 0x812f, wrapS = 0x812f, wrapT = 0x812f, minificationFilter = 0x2601, magnificationFilter = 0x2601, maximumAnisotropy = 1.0 } = options;
    this._wrapR = wrapR; this._wrapS = wrapS; this._wrapT = wrapT;
    this._minificationFilter = minificationFilter; this._magnificationFilter = magnificationFilter;
    this._maximumAnisotropy = maximumAnisotropy;
  }
  get wrapR() { return this._wrapR; }
  get wrapS() { return this._wrapS; }
  get wrapT() { return this._wrapT; }
  get minificationFilter() { return this._minificationFilter; }
  get magnificationFilter() { return this._magnificationFilter; }
  get maximumAnisotropy() { return this._maximumAnisotropy; }
  static equals(left, right) {
    return left === right || (left != null && right != null && left._wrapR === right._wrapR && left._wrapS === right._wrapS &&
      left._wrapT === right._wrapT && left._minificationFilter === right._minificationFilter &&
      left._magnificationFilter === right._magnificationFilter && left._maximumAnisotropy === right._maximumAnisotropy);
  }
}
Sampler.NEAREST = Object.freeze(new Sampler({ minificationFilter: 0x2600, magnificationFilter: 0x2600 }));
export default Sampler;\n`;

/** `Core/Cartesian2.js` stub — `Texture#dimensions` and the viewport/rectangle shapes. */
const CARTESIAN2_STUB = `export default class Cartesian2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  clone(result) { return result === undefined ? new Cartesian2(this.x, this.y) : (result.x = this.x, result.y = this.y, result); }
  equals(right) { return right !== undefined && this.x === right.x && this.y === right.y; }
}\n`;

/** `VertexArray` stub: `fromGeometry` records its arguments (T044's viewport-quad path). */
const VERTEX_ARRAY_STUB = `class VertexArray {\n  constructor(options) { this.__options = options; }\n  static fromGeometry(options) { VertexArray.__calls.push(options); return new VertexArray(options); }\n  static get __calls() { return (VertexArray.__callsStore ??= []); }\n}\nexport default VertexArray;\n`;

/** `DrawCommand` stub: keeps the option bag so a test can assert the command assembly. */
const DRAW_COMMAND_STUB = `export default class DrawCommand {\n  constructor(options) { Object.assign(this, options ?? {}); this.__options = options ?? {}; }\n  execute() {}\n}\n`;

/** `PassState` stub (upstream's kept `PassState.js`). */
const PASS_STATE_STUB = `export default class PassState {\n  constructor(context) { this.context = context; this.framebuffer = undefined; this.viewport = undefined; this.scissorTest = undefined; this.blendingEnabled = undefined; }\n}\n`;

/**
 * The default stub set: every bare deep specifier reachable from `Renderer/Context.ts` **and** from
 * the vendored WebGL2 context it delegates to. Tests override individual entries via
 * {@link upstreamStubs}.
 */
export function upstreamStubs(overrides = {}) {
  const base = {
    "@cesium/engine/Source/Renderer/ContextLimits.js": contextLimitsStubSource(),
    "@cesium/engine/Source/Renderer/DrawCommand.js": DRAW_COMMAND_STUB,
    "@cesium/engine/Source/Renderer/PassState.js": PASS_STATE_STUB,
    "@cesium/engine/Source/Renderer/ShaderCache.js": classStub("ShaderCache"),
    "@cesium/engine/Source/Renderer/ShaderProgram.js": SHADER_PROGRAM_STUB,
    "@cesium/engine/Source/Renderer/TextureCache.js": classStub("TextureCache"),
    "@cesium/engine/Source/Renderer/UniformState.js": classStub("UniformState"),
    "@cesium/engine/Source/Renderer/VertexArray.js": VERTEX_ARRAY_STUB,
    // --- reached only through the vendored WebGL2 Context (D2-a delegation) ---------------------
    "@cesium/engine/Source/Renderer/Buffer.js": classStub("Buffer"),
    "@cesium/engine/Source/Renderer/BufferUsage.js": `const BufferUsage = { STREAM_DRAW: 35040, STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048, DYNAMIC_READ: 35049 };\nBufferUsage.validate = function (usage) { return Object.values(BufferUsage).includes(usage); };\nexport default BufferUsage;\n`,
    "@cesium/engine/Source/Renderer/ClearCommand.js": classStub("ClearCommand"),
    "@cesium/engine/Source/Renderer/CubeMap.js": classStub("CubeMap"),
    "@cesium/engine/Source/Renderer/Framebuffer.js": classStub("Framebuffer"),
    "@cesium/engine/Source/Renderer/MultisampleFramebuffer.js": classStub("MultisampleFramebuffer"),
    "@cesium/engine/Source/Renderer/PickId.js": classStub("PickId"),
    "@cesium/engine/Source/Renderer/PixelDatatype.js": PIXEL_DATATYPE_STUB,
    "@cesium/engine/Source/Renderer/RenderState.js": classStub("RenderState"),
    "@cesium/engine/Source/Renderer/Renderbuffer.js": classStub("Renderbuffer"),
    "@cesium/engine/Source/Renderer/RenderbufferFormat.js": RENDERBUFFER_FORMAT_STUB,
    "@cesium/engine/Source/Renderer/Sampler.js": SAMPLER_STUB,
    "@cesium/engine/Source/Renderer/Texture.js": classStub("Texture"),
    "@cesium/engine/Source/Renderer/TextureMagnificationFilter.js": TEXTURE_MAGNIFICATION_FILTER_STUB,
    "@cesium/engine/Source/Renderer/TextureMinificationFilter.js": TEXTURE_MINIFICATION_FILTER_STUB,
    "@cesium/engine/Source/Renderer/TextureWrap.js": TEXTURE_WRAP_STUB,
    "@cesium/engine/Source/Renderer/VertexArrayFacade.js": classStub("VertexArrayFacade"),
    "@cesium/engine/Source/Core/Cartesian2.js": CARTESIAN2_STUB,
    "@cesium/engine/Source/Core/Check.js": `const Check = { defined: (name, value) => { if (value === undefined || value === null) throw new Error(\`DeveloperError: \${name} is required.\`); }, typeOf: () => true };\nexport default Check;\n`,
    "@cesium/engine/Source/Core/Color.js": `export default class Color {\n  constructor(red = 1, green = 1, blue = 1, alpha = 1) { this.red = red; this.green = green; this.blue = blue; this.alpha = alpha; }\n  static clone(color) { return new Color(color.red, color.green, color.blue, color.alpha); }\n}\nColor.WHITE = new Color(1, 1, 1, 1);\n`,
    "@cesium/engine/Source/Core/ComponentDatatype.js": `export default { FLOAT: 5126, UNSIGNED_BYTE: 5121, UNSIGNED_SHORT: 5123, UNSIGNED_INT: 5125 };\n`,
    "@cesium/engine/Source/Core/createGuid.js": `export default function createGuid() { return "stub-guid-" + Math.random().toString(16).slice(2); }\n`,
    "@cesium/engine/Source/Core/Frozen.js": `export default { EMPTY_OBJECT: Object.freeze({}), EMPTY_ARRAY: Object.freeze([]) };\n`,
    "@cesium/engine/Source/Core/defined.js": `export default function defined(value) { return value !== undefined && value !== null; }\n`,
    "@cesium/engine/Source/Core/destroyObject.js": `export default function destroyObject(object) { if (object && typeof object.destroy === "function") object.destroy(); return undefined; }\n`,
    "@cesium/engine/Source/Core/DeveloperError.js": `export default class DeveloperError extends Error { constructor(message) { super(message); this.name = "DeveloperError"; } }\n`,
    "@cesium/engine/Source/Core/Geometry.js": classStub("Geometry"),
    "@cesium/engine/Source/Core/GeometryAttribute.js": classStub("GeometryAttribute"),
    "@cesium/engine/Source/Core/loadKTX2.js": `export default async function loadKTX2() { throw new Error("loadKTX2 stub"); }\n`,
    "@cesium/engine/Source/Core/Matrix4.js": classStub("Matrix4"),
    "@cesium/engine/Source/Core/PixelFormat.js": PIXEL_FORMAT_STUB,
    "@cesium/engine/Source/Core/PrimitiveType.js": `export default { TRIANGLES: 4, LINES: 1, POINTS: 0, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6, LINE_STRIP: 3, LINE_LOOP: 2 };\n`,
    "@cesium/engine/Source/Core/RuntimeError.js": `export default class RuntimeError extends Error { constructor(message) { super(message); this.name = "RuntimeError"; } }\n`,
    "@cesium/engine/Source/Core/WebGLConstants.js": `export default { ZERO: 0, ONE: 1, FUNC_ADD: 32774, LESS: 513, ALWAYS: 519, BACK: 1029, KEEP: 7680, CLAMP_TO_EDGE: 33071, LINEAR: 9729 };\n`,
    "@cesium/engine/Source/Shaders/ViewportQuadVS.js": `export default "in vec4 position; void main() { gl_Position = position; }";\n`,
  };
  return { ...base, ...overrides };
}
