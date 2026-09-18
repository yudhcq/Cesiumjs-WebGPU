/**
 * Self-maintained ambient type declarations for the upstream engine internals
 * that this project's patch layer consumes.
 *
 * WHY THIS FILE EXISTS
 *   `@cesium/engine@26.3.0` ships `index.d.ts` for its public API only — `Source/**`
 *   contains just 2 `.d.ts` files (measured), so the deep modules under
 *   `Source/Renderer/**` have no types at all. The patch layer is TypeScript with
 *   `strict` on, therefore it needs declarations for the internal surface it touches.
 *   See plan.md "Complexity Tracking" (退出条件: delete this file the moment upstream
 *   publishes per-module declarations) and research.md §2.5.
 *
 * SCOPE RULE (do not relax)
 *   Declare ONLY symbols this project genuinely consumes. Each `declare module` block
 *   below is annotated with the consumption evidence (`file:line` in the upstream
 *   tarball, measured on 26.3.0). Adding a member here without a consumer is a
 *   contract violation of the patch-minimality rule (constitution principle I).
 *
 * The `UpstreamOpaque` alias is a deliberate, documented compromise: upstream
 * `Source/Core/**` (Matrix4, Color, BoundingRectangle, …) has no module declarations
 * either, and re-declaring that surface here would duplicate the public `index.d.ts`.
 * Values crossing that boundary stay opaque until upstream types exist.
 */
type UpstreamOpaque = any;

/**
 * `Source/Core/defined.js` / `Source/Core/destroyObject.js` — the two GL-free Core helpers the
 * replacement caches consume (upstream `TextureCache.js:1-2`, `ShaderCache.js:1-2`).
 */
declare module "@cesium/engine/Source/Core/defined.js" {
  const defined: (value: unknown) => boolean;
  export default defined;
}

declare module "@cesium/engine/Source/Core/destroyObject.js" {
  const destroyObject: (object: { destroy?: () => void }) => undefined;
  export default destroyObject;
}

/**
 * `Source/Renderer/ContextLimits.js` — 23 members declared below, covering the measured union
 * (measured: 9 distinct members referenced from the 1,306 non-`Renderer` modules) or by
 * the `Renderer/**` modules this patch layer reimplements (`RenderState` reads the aliased
 * line-width bounds, `ShaderProgram` reads the high-precision flags, `Texture`/`VertexArray`/
 * `Framebuffer`/`Renderbuffer`/`Texture3D`/`CubeMap` read their per-resource maxima).
 * NOTE: `research.md` §1.3 quotes "10 members" for the logic-layer-only measurement;
 * the declared set here is the union with the reimplemented backend modules (17).
 */
declare module "@cesium/engine/Source/Renderer/ContextLimits.js" {
  const ContextLimits: {
    readonly maximumTextureSize: number;
    readonly maximumCubeMapSize: number;
    readonly maximum3DTextureSize: number;
    readonly maximumTextureImageUnits: number;
    readonly maximumVertexTextureImageUnits: number;
    readonly maximumCombinedTextureImageUnits: number;
    readonly maximumTextureFilterAnisotropy: number;
    readonly maximumRenderbufferSize: number;
    readonly maximumVertexAttributes: number;
    readonly maximumVaryingVectors: number;
    readonly maximumVertexUniformVectors: number;
    readonly maximumFragmentUniformVectors: number;
    readonly maximumColorAttachments: number;
    readonly maximumDrawBuffers: number;
    readonly maximumSamples: number;
    readonly minimumAliasedLineWidth: number;
    readonly maximumAliasedLineWidth: number;
    // —— 以下 6 项由**补丁层重实现的 Renderer 模块**消费，逻辑层不读取，故早期声明面遗漏；
    //    依 research §4「事实更正记录 C-2」的实测并集补齐（声明面 17 → 23，与上游 23 名集合相等）。
    readonly minimumAliasedPointSize: number;
    readonly maximumAliasedPointSize: number;
    readonly maximumViewportWidth: number;
    readonly maximumViewportHeight: number;
    readonly highpFloatSupported: boolean;
    readonly highpIntSupported: boolean;
  };
  export default ContextLimits;
}

/**
 * `Source/Renderer/Context.js` — the device/command seam. 44 members declared.
 * External consumption counts (`research.md` §1.3, measured over 1,306 logic-layer files):
 * uniformState 57, defaultTexture 43, shaderCache 32, drawingBufferHeight/Width 29/23,
 * depthTexture 27, createViewportQuadCommand 26, cache 22, webgl2 17, createPickId 11,
 * halfFloatingPointTexture 9, stencilBuffer 8, fragmentDepth 7, colorBufferFloat 7,
 * endFrame 6, readPixels/readPixelsToPBO 5/1, id 5, floatingPointTexture 5,
 * colorBufferHalfFloat 3, instancedArrays 3, textureCache 3, drawBuffers 2,
 * elementIndexUint 2, getObjectByPickColor 2, destroy/beginFrame/msaa/floatBlend/
 * supportsTextureLod/supportsBasis/defaultCubeMap/s3tc/pvrtc/astc/etc/etc1/bc7 1 each.
 */
declare module "@cesium/engine/Source/Renderer/Context.js" {
  export interface ContextLimitsSnapshot {
    maximumTextureSize: number;
    maximumCubeMapSize: number;
    maximum3DTextureSize: number;
    maximumTextureImageUnits: number;
    maximumVertexTextureImageUnits: number;
    maximumCombinedTextureImageUnits: number;
    maximumTextureFilterAnisotropy: number;
    maximumRenderbufferSize: number;
    maximumVertexAttributes: number;
    maximumVaryingVectors: number;
    maximumVertexUniformVectors: number;
    maximumFragmentUniformVectors: number;
    maximumColorAttachments: number;
    maximumDrawBuffers: number;
    maximumSamples: number;
    minimumAliasedLineWidth: number;
    maximumAliasedLineWidth: number;
  }

  export interface ContextOptions {
    canvas: HTMLCanvasElement;
    webgl2?: boolean;
    requestWebgl1?: boolean;
    msaa?: boolean | number;
    allowTextureFilterAnisotropic?: boolean;
    /** `webgl2` / `webgl1` / `other` instance name; upstream requires one of these. */
    context?: UpstreamOpaque;
    [key: string]: UpstreamOpaque;
  }

  export default class Context {
    constructor(options: ContextOptions);

    // --- identity / lifecycle -------------------------------------------------
    /** Stable per-context GUID; the logic layer uses it as a cache key (`Scene/GlobeSurfaceTile.js:495,507`). */
    readonly id: string;
    readonly canvas: HTMLCanvasElement;
    readonly cache: Record<string, UpstreamOpaque>;
    isDestroyed(): boolean;
    destroy(): void;

    // --- frame ----------------------------------------------------------------
    beginFrame(): void;
    endFrame(): void;
    readonly drawingBufferWidth: number;
    readonly drawingBufferHeight: number;

    // --- command dispatch -----------------------------------------------------
    draw(command: UpstreamOpaque, passState: UpstreamOpaque, shaderProgram?: UpstreamOpaque, uniformMap?: UpstreamOpaque): void;
    clear(command: UpstreamOpaque, passState: UpstreamOpaque): void;
    readPixels(options: UpstreamOpaque): Promise<UpstreamOpaque>;
    readPixelsToPBO(options: UpstreamOpaque): Promise<UpstreamOpaque>;
    createViewportQuadCommand(fragmentShaderSource: string, options?: UpstreamOpaque): UpstreamOpaque;
    getViewportQuadVertexArray(): UpstreamOpaque;
    createPickId(object: UpstreamOpaque): void;
    getObjectByPickColor(pickColor: UpstreamOpaque): UpstreamOpaque;

    // --- shared state ---------------------------------------------------------
    readonly uniformState: UpstreamOpaque;
    readonly shaderCache: UpstreamOpaque;
    readonly textureCache: UpstreamOpaque;

    // --- default resources ----------------------------------------------------
    readonly defaultTexture: UpstreamOpaque;
    readonly defaultCubeMap: UpstreamOpaque;
    readonly defaultEmissiveTexture: UpstreamOpaque;
    readonly defaultNormalTexture: UpstreamOpaque;
    readonly defaultFramebuffer: UpstreamOpaque;

    // --- capability flags (read during `Scene` construction and per frame) -----
    readonly webgl2: boolean;
    readonly antialias: boolean;
    readonly msaa: boolean;
    readonly stencilBuffer: boolean;
    readonly stencilBits: number;
    readonly depthTexture: boolean;
    readonly fragmentDepth: boolean;
    readonly floatingPointTexture: boolean;
    readonly halfFloatingPointTexture: boolean;
    readonly colorBufferFloat: boolean;
    readonly colorBufferHalfFloat: boolean;
    readonly floatBlend: boolean;
    readonly textureFloatLinear: boolean;
    readonly textureHalfFloatLinear: boolean;
    readonly supportsTextureLod: boolean;
    readonly textureFilterAnisotropic: boolean;
    readonly supportsBasis: boolean;
    readonly instancedArrays: boolean;
    readonly elementIndexUint: boolean;
    readonly drawBuffers: boolean;
    readonly vertexArrayObject: boolean;
    readonly s3tc: boolean;
    readonly pvrtc: boolean;
    readonly astc: boolean;
    readonly etc: boolean;
    readonly etc1: boolean;
    readonly bc7: boolean;
    readonly debugShaders: boolean;
    readonly throwOnWebGLError: boolean;
  }
}

/**
 * `Source/Renderer/RenderState.js` — option shape MUST stay identical (43+ logic-layer
 * files construct it; measured 95 construction/static-call sites). Only the constructor
 * input shape and the public entry points are declared here.
 */
declare module "@cesium/engine/Source/Renderer/RenderState.js" {
  export interface RenderStateOptions {
    frontFace?: number;
    cull?: { enabled?: boolean; face?: number };
    lineWidth?: number;
    polygonOffset?: { enabled?: boolean; factor?: number; units?: number };
    scissorTest?: { enabled?: boolean; rectangle?: UpstreamOpaque };
    depthRange?: { near?: number; far?: number };
    depthTest?: { enabled?: boolean; func?: number };
    colorMask?: { red?: boolean; green?: boolean; blue?: boolean; alpha?: boolean };
    depthMask?: boolean;
    stencilMask?: number;
    blending?: {
      enabled?: boolean;
      color?: { red?: number; green?: number; blue?: number; alpha?: number };
      equationRgb?: number;
      equationAlpha?: number;
      functionSourceRgb?: number;
      functionSourceAlpha?: number;
      functionDestinationRgb?: number;
      functionDestinationAlpha?: number;
    };
    stencilTest?: {
      enabled?: boolean;
      frontFunction?: number;
      backFunction?: number;
      reference?: number;
      mask?: number;
      frontOperation?: { fail?: number; zFail?: number; zPass?: number };
      backOperation?: { fail?: number; zFail?: number; zPass?: number };
    };
    sampleCoverage?: { enabled?: boolean; value?: number; invert?: boolean };
    viewport?: UpstreamOpaque;
  }

  export default class RenderState {
    constructor(options?: RenderStateOptions);
    static fromCache(renderState: RenderStateOptions | RenderState): RenderState;
    static clone(renderState: RenderState, result?: RenderState): RenderState;
    static partialApply(renderState: RenderState, previousRenderState: RenderState): void;
    static apply(renderState: RenderState, context: UpstreamOpaque, passState: UpstreamOpaque): void;
    static removeViewport(renderState: RenderState): RenderState;
    [key: string]: UpstreamOpaque;
  }
}

/**
 * `Source/Renderer/ShaderProgram.js` — the read surface the logic layer depends on.
 * The GLSL view MUST stay observable (contract fork-patch-layer R2, `Scene/Primitive.js:722`
 * probes `vertexShaderSource` with a GLSL regex), and `_attributeLocations` MUST exist and
 * agree with `attributeLocations` (data-model §11 A9).
 */
declare module "@cesium/engine/Source/Renderer/ShaderProgram.js" {
  export interface ShaderProgramOptions {
    context: UpstreamOpaque;
    vertexShaderSource?: UpstreamOpaque;
    fragmentShaderSource?: UpstreamOpaque;
    attributeLocations?: Record<string, number>;
    [key: string]: UpstreamOpaque;
  }

  export default class ShaderProgram {
    constructor(options: ShaderProgramOptions);
    /** Raw GLSL handed in by the logic layer — MUST NOT be replaced with WGSL text. */
    readonly vertexShaderSource: string;
    /** Raw GLSL handed in by the logic layer — MUST NOT be replaced with WGSL text. */
    readonly fragmentShaderSource: string;
    /** Consumed by `ShaderProgram._bind` (`ShaderProgram.js:200-206`); MUST stay in sync with `attributeLocations`. */
    readonly _attributeLocations: Record<string, number> | undefined;
    readonly allUniforms: Record<string, UpstreamOpaque>;
    readonly vertexAttributes: UpstreamOpaque[];
    readonly numberOfVertexAttributes: number;
    static fromCache(options: ShaderProgramOptions): ShaderProgram;
    static fromShaderSource(options: ShaderProgramOptions): ShaderProgram;
    static getProgramNumber(shaderProgram: UpstreamOpaque): UpstreamOpaque;
    static getShaderSourceKey(shaderSource: UpstreamOpaque): string;
    isDestroyed(): boolean;
    destroy(): void;
    _bind(): void;
    _setUniforms(uniformMap: UpstreamOpaque): void;
  }
}

/**
 * `Source/Renderer/ShaderSource.js` — 79 logic-layer consumption sites. Enters the patch
 * list as `kind: "adapt-shader"` (contract R1: add a WGSL emission channel; the GLSL view
 * and the preprocessing semantics MUST NOT change).
 */
declare module "@cesium/engine/Source/Renderer/ShaderSource.js" {
  export interface ShaderSourceOptions {
    source: string;
    defines?: string[];
    pickColorQualifier?: string;
    [key: string]: UpstreamOpaque;
  }

  export default class ShaderSource {
    constructor(options: ShaderSourceOptions);
    readonly source: string;
    readonly defines: string[];
    clone(): ShaderSource;
    static replaceMain(source: string, main: string): string;
    static createPickVertexShaderSource(vertexShaderSource: string): string;
    static createPickFragmentShaderSource(fragmentShaderSource: string, pickColorQualifier: string): string;
    static findNormalVarying(shaderProgram: UpstreamOpaque): UpstreamOpaque;
    static findPositionVarying(shaderProgram: UpstreamOpaque): UpstreamOpaque;
  }
}

/** `Source/Renderer/ShaderCache.js` — a **kept** module the replacement `Context` constructs. */
declare module "@cesium/engine/Source/Renderer/ShaderCache.js" {
  const ShaderCache: {
    getShaderProgram(context: UpstreamOpaque, shaderSource: UpstreamOpaque, attributeLocations: Record<string, number> | undefined, programId?: string): UpstreamOpaque;
    replaceShaderProgram(context: UpstreamOpaque, shaderSource: UpstreamOpaque, attributeLocations: Record<string, number> | undefined, programId: string): UpstreamOpaque;
    getVertexArray(context: UpstreamOpaque, vertexArray: UpstreamOpaque): UpstreamOpaque;
    getDrawCommand(context: UpstreamOpaque, vertexArray: UpstreamOpaque): UpstreamOpaque;
    getPickId(context: UpstreamOpaque, pickId: UpstreamOpaque): UpstreamOpaque;
    [key: string]: UpstreamOpaque;
  };
  export default ShaderCache;
}

/**
 * `Source/Renderer/TextureCache.js` — a **kept** module the replacement `Context` constructs
 * (`Context.js:82 new TextureCache()`; `Scene/Scene.js:4428` reads `context.textureCache`).
 */
declare module "@cesium/engine/Source/Renderer/TextureCache.js" {
  export default class TextureCache {
    constructor();
    getTextureFromCache(key: string): UpstreamOpaque;
    addTextureToCache(key: string, texture: UpstreamOpaque): void;
    destroy(): void;
    isDestroyed(): boolean;
    [key: string]: UpstreamOpaque;
  }
}

/**
 * `Source/Renderer/UniformState.js` — a **kept** module (zero GL calls) the replacement `Context`
 * constructs (`Context.js:335 new UniformState()`); the logic layer reads it in 57 places.
 */
declare module "@cesium/engine/Source/Renderer/UniformState.js" {
  export default class UniformState {
    constructor();
    update(context: UpstreamOpaque, passState: UpstreamOpaque, camera: UpstreamOpaque, us: UpstreamOpaque): void;
    [key: string]: UpstreamOpaque;
  }
}

/** `Source/Renderer/Buffer.js` — 97 logic-layer consumption sites; 18 WebGL call sites. */
declare module "@cesium/engine/Source/Renderer/Buffer.js" {
  export interface BufferOptions {
    context: UpstreamOpaque;
    bufferTarget: number;
    typedArray?: UpstreamOpaque;
    sizeInBytes?: number;
    usage?: number;
    [key: string]: UpstreamOpaque;
  }

  export default class Buffer {
    constructor(options: BufferOptions);
    readonly sizeInBytes: number;
    readonly usage: number;
    copyFromArray(source: UpstreamOpaque, webglArrayBufferOffset?: number, sourceOffset?: number, length?: number): void;
    copyFromBuffer(source: UpstreamOpaque): void;
    copyFromArrayView(source: UpstreamOpaque, destinationOffsetInBytes?: number, lengthInBytes?: number): void;
    isDestroyed(): boolean;
    destroy(): void;
    static createVertexBuffer(options: BufferOptions): Buffer;
    static createIndexBuffer(options: BufferOptions): Buffer;
    static createPixelBuffer(options: BufferOptions): Buffer;
  }
}

/** `Source/Renderer/Texture.js` — 51 logic-layer sites; 58 WebGL call sites. */
declare module "@cesium/engine/Source/Renderer/Texture.js" {
  export interface TextureOptions {
    context: UpstreamOpaque;
    source?: UpstreamOpaque;
    width?: number;
    height?: number;
    pixelFormat?: number;
    pixelDatatype?: number;
    sampler?: UpstreamOpaque;
    flipY?: boolean;
    skipColorSpaceConversion?: boolean;
    [key: string]: UpstreamOpaque;
  }

  export default class Texture {
    constructor(options: TextureOptions);
    readonly width: number;
    readonly height: number;
    readonly pixelFormat: number;
    readonly pixelDatatype: number;
    readonly sampler: UpstreamOpaque;
    copyFrom(options: UpstreamOpaque): void;
    copyFromFramebuffer(framebuffer: UpstreamOpaque): void;
    isDestroyed(): boolean;
    destroy(): void;
    static readonly defaultColor: UpstreamOpaque;
    static create(options: TextureOptions): Texture;
    static fromFramebuffer(options: UpstreamOpaque): Texture;
  }
}

/** `Source/Renderer/Sampler.js` — 47 logic-layer sites. */
declare module "@cesium/engine/Source/Renderer/Sampler.js" {
  export interface SamplerOptions {
    wrapS?: number;
    wrapT?: number;
    minificationFilter?: number;
    magnificationFilter?: number;
    maximumAnisotropy?: number;
    [key: string]: UpstreamOpaque;
  }

  export default class Sampler {
    constructor(options?: SamplerOptions);
    readonly wrapS: number;
    readonly wrapT: number;
    readonly minificationFilter: number;
    readonly magnificationFilter: number;
    readonly maximumAnisotropy: number;
    static readonly NEAREST: Sampler;
    static equals(left?: Sampler, right?: Sampler): boolean;
  }
}

/** `Source/Renderer/VertexArray.js` — 16 logic-layer sites; 10 WebGL call sites. */
declare module "@cesium/engine/Source/Renderer/VertexArray.js" {
  export interface VertexArrayOptions {
    context: UpstreamOpaque;
    attributes: UpstreamOpaque[];
    indexBuffer?: UpstreamOpaque;
    numberOfVertices?: number;
    [key: string]: UpstreamOpaque;
  }

  export default class VertexArray {
    constructor(options: VertexArrayOptions);
    readonly numberOfVertices: number;
    readonly indexBuffer: UpstreamOpaque;
    readonly attributes: UpstreamOpaque[];
    isDestroyed(): boolean;
    destroy(): void;
    _bind(): void;
    _unBind(): void;
    static fromGeometry(options: UpstreamOpaque): VertexArray;
  }
}

/** `Source/Renderer/Framebuffer.js` — 6 logic-layer sites; 9 WebGL call sites. */
declare module "@cesium/engine/Source/Renderer/Framebuffer.js" {
  export interface FramebufferOptions {
    context: UpstreamOpaque;
    colorAttachments?: UpstreamOpaque;
    depthStencilAttachment?: UpstreamOpaque;
    depthTexture?: UpstreamOpaque;
    [key: string]: UpstreamOpaque;
  }

  export default class Framebuffer {
    constructor(options: FramebufferOptions);
    readonly id: string;
    readonly status: UpstreamOpaque;
    readonly colorTextures: UpstreamOpaque[];
    readonly depthTexture: UpstreamOpaque;
    readonly depthStencilTexture: UpstreamOpaque;
    isDestroyed(): boolean;
    destroy(): void;
  }
}

/** `Source/Renderer/Renderbuffer.js` — 3 logic-layer sites; 6 WebGL call sites. */
declare module "@cesium/engine/Source/Renderer/Renderbuffer.js" {
  export default class Renderbuffer {
    constructor(options: UpstreamOpaque);
    readonly width: number;
    readonly height: number;
    readonly format: number;
    isDestroyed(): boolean;
    destroy(): void;
  }
}

/** `Source/Renderer/MultisampleFramebuffer.js` — reachable from `Scene`; 3 WebGL call sites. */
declare module "@cesium/engine/Source/Renderer/MultisampleFramebuffer.js" {
  export default class MultisampleFramebuffer {
    constructor(options: UpstreamOpaque);
    readonly framebuffer: UpstreamOpaque;
    readonly colorTextures: UpstreamOpaque[];
    readonly depthStencilTexture: UpstreamOpaque;
    isDestroyed(): boolean;
    destroy(): void;
  }
}

/** `Source/Renderer/FramebufferManager.js` — 29 logic-layer sites. */
declare module "@cesium/engine/Source/Renderer/FramebufferManager.js" {
  export default class FramebufferManager {
    constructor(context: UpstreamOpaque, pixelFormat?: number, pixelDatatype?: number);
    readonly pixelFormat: number;
    readonly pixelDatatype: number;
    readonly depthTexture: UpstreamOpaque;
    isDestroyed(): boolean;
    destroy(): void;
    getFramebuffer(): UpstreamOpaque;
    getColorTexture(): UpstreamOpaque;
    getDepthTexture(): UpstreamOpaque;
    clear(): void;
    update(): void;
  }
}

/** `Source/Renderer/Texture3D.js` — `kind: "stub-not-implemented"` in the MVP (slice C); 37 WebGL call sites. */
declare module "@cesium/engine/Source/Renderer/Texture3D.js" {
  export default class Texture3D {
    constructor(options: UpstreamOpaque);
    readonly width: number;
    readonly height: number;
    readonly depth: number;
    readonly sampler: UpstreamOpaque;
    isDestroyed(): boolean;
    destroy(): void;
    static create(options: UpstreamOpaque): Texture3D;
  }
}

/** `Source/Renderer/CubeMap.js` — `kind: "stub-not-implemented"` in the MVP (slice C); 33 WebGL call sites. */
declare module "@cesium/engine/Source/Renderer/CubeMap.js" {
  export default class CubeMap {
    constructor(options: UpstreamOpaque);
    readonly id: string;
    isDestroyed(): boolean;
    destroy(): void;
    static readonly FaceName: Record<string, number>;
    static readonly faceNames: string[];
    static loadFace(cubeMap: CubeMap, source: UpstreamOpaque, face: number): Promise<void>;
    static getDirection(face: number): UpstreamOpaque;
    static createVertexArray(context: UpstreamOpaque): UpstreamOpaque;
  }
}

/** `Source/Renderer/CubeMapFace.js` — `kind: "stub-not-implemented"` in the MVP (slice C); 27 WebGL call sites. */
declare module "@cesium/engine/Source/Renderer/CubeMapFace.js" {
  export default class CubeMapFace {
    constructor(options: UpstreamOpaque);
    readonly id: string;
    isDestroyed(): boolean;
    destroy(): void;
  }
}

/** `Source/Renderer/TextureAtlas.js` — `kind: "stub-not-implemented"` in the MVP (slice C); 4 WebGL call sites. */
declare module "@cesium/engine/Source/Renderer/TextureAtlas.js" {
  export default class TextureAtlas {
    constructor(options: UpstreamOpaque);
    readonly texture: UpstreamOpaque;
    readonly numberOfImages: number;
    addImage(source: UpstreamOpaque): UpstreamOpaque;
    isDestroyed(): boolean;
    destroy(): void;
  }
}

/** `Source/Renderer/Sync.js` — `kind: "stub-not-implemented"` in the MVP (slice C); 3 WebGL call sites. */
declare module "@cesium/engine/Source/Renderer/Sync.js" {
  export default class Sync {
    isDestroyed(): boolean;
    destroy(): void;
    static create(context: UpstreamOpaque, options?: UpstreamOpaque): Sync;
  }
}

/** `Source/Renderer/createUniform.js` — 16 WebGL call sites; uniform dispatch for the patch layer. */
declare module "@cesium/engine/Source/Renderer/createUniform.js" {
  const createUniform: (
    gl: UpstreamOpaque,
    activeUniform: UpstreamOpaque,
    uniformState: UpstreamOpaque,
    context: UpstreamOpaque,
    duplicateUniformNames?: UpstreamOpaque,
  ) => { name: string; set: () => void; [key: string]: UpstreamOpaque };
  export default createUniform;
}

/** `Source/Renderer/createUniformArray.js` — 14 WebGL call sites. */
declare module "@cesium/engine/Source/Renderer/createUniformArray.js" {
  const createUniformArray: (
    gl: UpstreamOpaque,
    activeUniform: UpstreamOpaque,
    uniformState: UpstreamOpaque,
    context: UpstreamOpaque,
    duplicateUniformNames?: UpstreamOpaque,
  ) => { name: string; set: () => void; [key: string]: UpstreamOpaque };
  export default createUniformArray;
}

/** `Source/Renderer/PixelDatatype.js` — 89 logic-layer sites (GL-free, kept byte-identical). */
declare module "@cesium/engine/Source/Renderer/PixelDatatype.js" {
  const PixelDatatype: {
    readonly UNSIGNED_BYTE: number;
    readonly UNSIGNED_SHORT: number;
    readonly UNSIGNED_INT: number;
    readonly FLOAT: number;
    readonly HALF_FLOAT: number;
    readonly validate: (pixelDatatype: number) => boolean;
    readonly toWebGLConstant: (pixelDatatype: number) => number;
    readonly sizeInBytes: (pixelDatatype: number) => number;
    readonly isPacked: (pixelDatatype: number) => boolean;
    readonly getTypedArrayConstructor: (pixelDatatype: number) => UpstreamOpaque;
    readonly fromName: (name: string) => number | undefined;
    [key: string]: UpstreamOpaque;
  };
  export default PixelDatatype;
}

/** `Source/Renderer/BufferUsage.js` — GL-free, kept byte-identical. */
declare module "@cesium/engine/Source/Renderer/BufferUsage.js" {
  const BufferUsage: {
    readonly STATIC_DRAW: number;
    readonly DYNAMIC_DRAW: number;
    readonly STREAM_DRAW: number;
    readonly DYNAMIC_READ: number;
    readonly validate: (bufferUsage: number) => boolean;
    [key: string]: UpstreamOpaque;
  };
  export default BufferUsage;
}

/**
 * `Source/Core/PixelFormat.js` — consumed by the W3 resource layer (`webgpu/format-map.ts` maps
 * `PixelFormat` × `PixelDatatype` to `GPUTextureFormat`; `Renderer/Texture.ts` uses
 * `textureSizeInBytes` and the depth-format predicate; `Renderer/Framebuffer.ts` uses the colour /
 * depth predicates for its upstream validation). GL-free and kept byte-identical.
 */
declare module "@cesium/engine/Source/Core/PixelFormat.js" {
  const PixelFormat: {
    readonly DEPTH_COMPONENT: number;
    readonly DEPTH_STENCIL: number;
    readonly ALPHA: number;
    readonly RED: number;
    readonly RG: number;
    readonly RGB: number;
    readonly RGBA: number;
    readonly RED_INTEGER: number;
    readonly RG_INTEGER: number;
    readonly RGB_INTEGER: number;
    readonly RGBA_INTEGER: number;
    readonly LUMINANCE: number;
    readonly LUMINANCE_ALPHA: number;
    readonly componentsLength: (pixelFormat: number) => number;
    readonly validate: (pixelFormat: number) => boolean;
    readonly isColorFormat: (pixelFormat: number) => boolean;
    readonly isDepthFormat: (pixelFormat: number) => boolean;
    readonly isCompressedFormat: (pixelFormat: number) => boolean;
    readonly textureSizeInBytes: (pixelFormat: number, pixelDatatype: number, width: number, height: number) => number;
    readonly toInternalFormat: (pixelFormat: number, pixelDatatype: number, context: UpstreamOpaque) => number;
    readonly flipY: (arrayView: UpstreamOpaque, width: number, height: number) => UpstreamOpaque;
    [key: string]: UpstreamOpaque;
  };
  export default PixelFormat;
}

/**
 * `Source/Core/Cartesian2.js` — the `Texture#dimensions` return type (upstream:
 * `Texture.js:233 this._dimensions = new Cartesian2(width, height)`). GL-free, kept byte-identical.
 */
declare module "@cesium/engine/Source/Core/Cartesian2.js" {
  export default class Cartesian2 {
    constructor(x?: number, y?: number);
    x: number;
    y: number;
    clone(result?: Cartesian2): Cartesian2;
    equals(right?: Cartesian2): boolean;
    [key: string]: UpstreamOpaque;
  }
}

/**
 * `Source/Renderer/RenderbufferFormat.js` — GL-free, kept byte-identical. Consumed by
 * `webgpu/format-map.ts` (`mapRenderbufferFormat`) and `Renderer/FramebufferManager.ts`
 * (upstream's depth/colour attachment selection).
 */
declare module "@cesium/engine/Source/Renderer/RenderbufferFormat.js" {
  const RenderbufferFormat: {
    readonly RGBA4: number;
    readonly RGBA8: number;
    readonly RGBA16F: number;
    readonly RGBA32F: number;
    readonly RGB5_A1: number;
    readonly RGB565: number;
    readonly DEPTH_COMPONENT16: number;
    readonly STENCIL_INDEX8: number;
    readonly DEPTH_STENCIL: number;
    readonly DEPTH24_STENCIL8: number;
    readonly validate: (renderbufferFormat: number) => boolean;
    readonly getColorFormat: (datatype: number) => number;
    [key: string]: UpstreamOpaque;
  };
  export default RenderbufferFormat;
}

/**
 * `Source/Renderer/TextureWrap.js` / `TextureMinificationFilter.js` /
 * `TextureMagnificationFilter.js` — GL-free, kept byte-identical. All three are consumed by
 * `webgpu/sampler-map.ts`, which is the one place a kept `Sampler` becomes a `GPUSamplerDescriptor`.
 */
declare module "@cesium/engine/Source/Renderer/TextureWrap.js" {
  const TextureWrap: {
    readonly CLAMP_TO_EDGE: number;
    readonly REPEAT: number;
    readonly MIRRORED_REPEAT: number;
    readonly validate: (textureWrap: number) => boolean;
    [key: string]: UpstreamOpaque;
  };
  export default TextureWrap;
}

declare module "@cesium/engine/Source/Renderer/TextureMinificationFilter.js" {
  const TextureMinificationFilter: {
    readonly NEAREST: number;
    readonly LINEAR: number;
    readonly NEAREST_MIPMAP_NEAREST: number;
    readonly LINEAR_MIPMAP_NEAREST: number;
    readonly NEAREST_MIPMAP_LINEAR: number;
    readonly LINEAR_MIPMAP_LINEAR: number;
    readonly validate: (textureMinificationFilter: number) => boolean;
    [key: string]: UpstreamOpaque;
  };
  export default TextureMinificationFilter;
}

declare module "@cesium/engine/Source/Renderer/TextureMagnificationFilter.js" {
  const TextureMagnificationFilter: {
    readonly NEAREST: number;
    readonly LINEAR: number;
    readonly validate: (textureMagnificationFilter: number) => boolean;
    [key: string]: UpstreamOpaque;
  };
  export default TextureMagnificationFilter;
}

/** `Source/Renderer/PassState.js` — 7 logic-layer sites; GL-free, kept byte-identical. */
declare module "@cesium/engine/Source/Renderer/PassState.js" {
  export default class PassState {
    constructor(context: UpstreamOpaque);
    context: UpstreamOpaque;
    framebuffer: UpstreamOpaque;
    blendFramebuffer: UpstreamOpaque;
    viewport: UpstreamOpaque;
    scissor: UpstreamOpaque;
    [key: string]: UpstreamOpaque;
  }
}

/** `Source/Renderer/DrawCommand.js` — 37 logic-layer sites; GL-free, kept byte-identical. */
declare module "@cesium/engine/Source/Renderer/DrawCommand.js" {
  export default class DrawCommand {
    constructor(options?: UpstreamOpaque);
    execute(context: UpstreamOpaque, passState: UpstreamOpaque): void;
    [key: string]: UpstreamOpaque;
  }
}

/** `Source/Renderer/ClearCommand.js` — 22 logic-layer sites; GL-free, kept byte-identical. */
declare module "@cesium/engine/Source/Renderer/ClearCommand.js" {
  export default class ClearCommand {
    constructor(options?: UpstreamOpaque);
    execute(context: UpstreamOpaque, passState: UpstreamOpaque): void;
    static readonly ALL: number;
    [key: string]: UpstreamOpaque;
  }
}

/** `Source/Renderer/ComputeCommand.js` — 6 logic-layer sites; MVP scene config keeps the dispatch count at 0 (data-model §11 A6). */
declare module "@cesium/engine/Source/Renderer/ComputeCommand.js" {
  export default class ComputeCommand {
    constructor(options?: UpstreamOpaque);
    execute(context: UpstreamOpaque, passState: UpstreamOpaque): void;
    [key: string]: UpstreamOpaque;
  }
}

/** `Source/Renderer/VertexArrayFacade.js` — 3 logic-layer sites; GL-free, kept byte-identical. */
declare module "@cesium/engine/Source/Renderer/VertexArrayFacade.js" {
  export default class VertexArrayFacade {
    constructor(context: UpstreamOpaque, attributes: UpstreamOpaque[], sizeInVertices?: number, indices?: boolean);
    readonly length: number;
    resize(sizeInVertices: number): void;
    write(index: number, geometry: UpstreamOpaque, name: string, componentDatatype: number, sizeInComponents: number): void;
    isDestroyed(): boolean;
    destroy(): void;
  }
}

/** `Source/Renderer/ShaderBuilder.js` — MVP keeps this module byte-identical (contract R9). */
declare module "@cesium/engine/Source/Renderer/ShaderBuilder.js" {
  const ShaderBuilder: {
    new (options?: UpstreamOpaque): UpstreamOpaque;
    prototype: UpstreamOpaque;
    [key: string]: UpstreamOpaque;
  };
  export default ShaderBuilder;
}

/** `Source/Renderer/loadCubeMap.js` — `kind: "adapt"` (slice C boundary: cube maps are stubbed). */
declare module "@cesium/engine/Source/Renderer/loadCubeMap.js" {
  const loadCubeMap: (context: UpstreamOpaque, options: UpstreamOpaque) => Promise<UpstreamOpaque>;
  export default loadCubeMap;
}

/**
 * `Source/Core/Frozen.js` — consumed by the replacement `Renderer/ShaderSource.ts`
 * (upstream `ShaderSource.js:1,333` uses `Frozen.EMPTY_OBJECT` as the default options object).
 */
declare module "@cesium/engine/Source/Core/Frozen.js" {
  const Frozen: { EMPTY_OBJECT: Readonly<Record<string, never>>; EMPTY_ARRAY: readonly never[] };
  export default Frozen;
}

/**
 * `Source/Core/DeveloperError.js` — consumed by the replacement `Renderer/ShaderSource.ts`
 * (upstream `ShaderSource.js:3,128,174,342` throws it for a malformed pick qualifier, an
 * inconsistent `#version` and a circular `czm_` dependency).
 */
declare module "@cesium/engine/Source/Core/DeveloperError.js" {
  export default class DeveloperError extends Error {
    constructor(message: string);
  }
}

/**
 * `Source/Shaders/Builtin/CzmBuiltins.js` — the `czm_` built-in table the shader front end inlines
 * before evaluating conditionals (upstream `ShaderSource.js:4,417-422`; contract R4).
 */
declare module "@cesium/engine/Source/Shaders/Builtin/CzmBuiltins.js" {
  const CzmBuiltins: Record<string, string>;
  export default CzmBuiltins;
}

/**
 * `Source/Renderer/AutomaticUniforms.js` — the automatic-uniform declarations merged into the same
 * table (upstream `ShaderSource.js:5,423-431`). Only `getDeclaration` is consumed.
 */
declare module "@cesium/engine/Source/Renderer/AutomaticUniforms.js" {
  const AutomaticUniforms: Record<string, { getDeclaration?: (name: string) => string }>;
  export default AutomaticUniforms;
}

/**
 * `Source/Renderer/demodernizeShader.js` — the WebGL1 path only. The replacement `ShaderSource.ts`
 * keeps the call so the port stays faithful, and it is unreachable for the WebGL2 baseline
 * (`context.webgl2 === true`), which is why the declaration stays this coarse.
 */
declare module "@cesium/engine/Source/Renderer/demodernizeShader.js" {
  const demodernizeShader: (source: string, isFragmentShader: boolean) => string;
  export default demodernizeShader;
}
