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
    "@cesium/engine/Source/Renderer/BufferUsage.js": `const BufferUsage = { STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048, STREAM_DRAW: 35040 };\nexport default BufferUsage;\n`,
    "@cesium/engine/Source/Renderer/ClearCommand.js": classStub("ClearCommand"),
    "@cesium/engine/Source/Renderer/CubeMap.js": classStub("CubeMap"),
    "@cesium/engine/Source/Renderer/Framebuffer.js": classStub("Framebuffer"),
    "@cesium/engine/Source/Renderer/MultisampleFramebuffer.js": classStub("MultisampleFramebuffer"),
    "@cesium/engine/Source/Renderer/PickId.js": classStub("PickId"),
    "@cesium/engine/Source/Renderer/PixelDatatype.js": `const PixelDatatype = { UNSIGNED_BYTE: 5121, UNSIGNED_SHORT: 5123, UNSIGNED_INT: 5125, FLOAT: 5126, HALF_FLOAT: 36193 };\nexport default PixelDatatype;\n`,
    "@cesium/engine/Source/Renderer/RenderState.js": classStub("RenderState"),
    "@cesium/engine/Source/Renderer/Renderbuffer.js": classStub("Renderbuffer"),
    "@cesium/engine/Source/Renderer/Sampler.js": classStub("Sampler"),
    "@cesium/engine/Source/Renderer/Texture.js": classStub("Texture"),
    "@cesium/engine/Source/Renderer/VertexArrayFacade.js": classStub("VertexArrayFacade"),
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
    "@cesium/engine/Source/Core/PixelFormat.js": `export default { RGBA: 6408, RGB: 6407, LUMINANCE: 6409, ALPHA: 6406, DEPTH_COMPONENT: 6402, DEPTH_STENCIL: 34041 };\n`,
    "@cesium/engine/Source/Core/PrimitiveType.js": `export default { TRIANGLES: 4, LINES: 1, POINTS: 0, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6, LINE_STRIP: 3, LINE_LOOP: 2 };\n`,
    "@cesium/engine/Source/Core/RuntimeError.js": `export default class RuntimeError extends Error { constructor(message) { super(message); this.name = "RuntimeError"; } }\n`,
    "@cesium/engine/Source/Core/WebGLConstants.js": `export default { ZERO: 0, ONE: 1, FUNC_ADD: 32774, LESS: 513, ALWAYS: 519, BACK: 1029, KEEP: 7680, CLAMP_TO_EDGE: 33071, LINEAR: 9729 };\n`,
    "@cesium/engine/Source/Shaders/ViewportQuadVS.js": `export default "in vec4 position; void main() { gl_Position = position; }";\n`,
  };
  return { ...base, ...overrides };
}
