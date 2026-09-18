/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/Texture.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * T056 (+ T057 format table, + T058 origin policy) — `Texture` → `GPUTexture` + `GPUSampler`.
 *
 * WHAT IS PRESERVED (data-model §5.2, the logic layer's observable surface)
 *   the constructor option bag (`context`, `source`, `pixelFormat`, `pixelDatatype`, `flipY`,
 *   `preMultiplyAlpha`, `sampler`, `width`, `height`, `id`), the source type set (`ImageData` /
 *   `HTMLImageElement` / `HTMLCanvasElement` / `HTMLVideoElement` / `OffscreenCanvas` /
 *   `ImageBitmap` / `{width, height, arrayBufferView}`), the `copyFrom({source, xOffset, yOffset})`
 *   overload with its region semantics, `Texture.create`, `Texture.fromFramebuffer`, and the
 *   read surface `id` / `sampler` (get+set) / `pixelFormat` / `pixelDatatype` / `dimensions` /
 *   `preMultiplyAlpha` / `flipY` / `width` / `height` / `sizeInBytes` / `_target` /
 *   `isDestroyed` / `destroy`.
 *
 * WHAT CHANGES
 *   * `texImage2D`/`texSubImage2D` become `queue.writeTexture` (buffer sources) or
 *     `queue.copyExternalImageToTexture` (image sources). The **origin policy** (T058, G-6) lives in
 *     `webgpu/texture-upload.ts`: with `flipY` on, buffer rows are reversed on the CPU and image
 *     copies pass `flipY` to the GPU, so WebGPU's `v` behaves like GL's `t` and a verbatim GLSL→WGSL
 *     port samples the same texel.
 *   * `UNPACK_PREMULTIPLY_ALPHA_WEBGL` maps onto `GPUImageCopyTextureTagged.premultipliedAlpha` for
 *     image sources; a buffer source is premultiplied on the CPU (WebGPU has no unpack state).
 *   * `generateMipmap` has no WebGPU counterpart and fails loudly; upstream's `MipmapHint` path is
 *     not part of the MVP.
 *   * `copyFromFramebuffer` / `Texture.fromFramebuffer` (the framebuffer→texture copy) belong to
 *     **slice B** (`GlobeDepth`, tasks.md T097) and fail loudly naming it — implementing them here
 *     would pre-empt the slice-B task.
 */
import Cartesian2 from "@cesium/engine/Source/Core/Cartesian2.js";
import PixelFormat from "@cesium/engine/Source/Core/PixelFormat.js";
import PixelDatatype from "@cesium/engine/Source/Renderer/PixelDatatype.js";
import Sampler from "@cesium/engine/Source/Renderer/Sampler.js";

import { requireDevice } from "../webgpu/context-device.js";
import { DiagnosticError } from "../webgpu/errors.js";
import { mapTextureFormat, type TextureFormatMapping } from "../webgpu/format-map.js";
import { gpuResourceRegistry, nextResourceId } from "../webgpu/gpu-resource-registry.js";
import { anisotropyRecords, mapSampler } from "../webgpu/sampler-map.js";
import { externalImageFlipY, planTextureUpload, type UploadBytes } from "../webgpu/texture-upload.js";

const UPSTREAM_MODULE = "Renderer/Texture.js";

/** `Texture.defaultColor` upstream is `Color.WHITE` — kept explicit so the default is never guessed. */
const DEFAULT_COLOR_RGBA8 = [255, 255, 255, 255] as const;

/** The `GPUTextureUsage` a logic-layer texture needs: sampled, copied and attachable (see below). */
function defaultTextureUsage(): GPUTextureUsageFlags {
  const usage = globalThis.GPUTextureUsage;
  // Upstream's `Texture` declares no usage at all — a GL texture is attachable, samplable and
  // copyable the moment it exists, and the logic layer relies on that (a `Texture` handed to
  // `FramebufferManager` becomes a render attachment without any extra declaration). The WebGPU
  // counterpart of "no declared usage" is therefore the union, not a narrow guess; narrowing it by
  // default would break render-to-texture in a way that only shows up at draw time.
  return usage.TEXTURE_BINDING | usage.COPY_SRC | usage.COPY_DST | usage.RENDER_ATTACHMENT;
}

/** A source that is not a buffer view is an *image* source (research §6.1's type set). */
interface ImageLikeSource {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly naturalWidth?: number | undefined;
  readonly naturalHeight?: number | undefined;
  readonly videoWidth?: number | undefined;
  readonly videoHeight?: number | undefined;
}

/** A `{width, height, arrayBufferView}` source (upstream's "buffer source"). */
interface BufferLikeSource extends ImageLikeSource {
  readonly arrayBufferView: ArrayBufferView;
}

function isBufferSource(source: unknown): source is BufferLikeSource {
  return source !== null && typeof source === "object" && (source as { arrayBufferView?: unknown }).arrayBufferView !== undefined;
}

function isFramebufferSource(source: unknown): boolean {
  return source !== null && typeof source === "object" && (source as { framebuffer?: unknown }).framebuffer !== undefined;
}

/** Intrinsic dimensions of an image-like source, in upstream's precedence order. */
function intrinsicSize(source: ImageLikeSource): { width: number; height: number } {
  const width = source.videoWidth ?? source.naturalWidth ?? source.width ?? 0;
  const height = source.videoHeight ?? source.naturalHeight ?? source.height ?? 0;
  return { width, height };
}

export interface TextureOptions {
  readonly context: unknown;
  readonly source?: unknown;
  readonly pixelFormat?: number | undefined;
  readonly pixelDatatype?: number | undefined;
  readonly flipY?: boolean | undefined;
  readonly skipColorSpaceConversion?: boolean | undefined;
  readonly sampler?: { readonly maximumAnisotropy?: number } | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly preMultiplyAlpha?: boolean | undefined;
  readonly id?: string | undefined;
  /** Backend-only: narrow the `GPUTextureUsage` (defaults to the union; see `defaultTextureUsage`). */
  readonly usage?: GPUTextureUsageFlags | undefined;
  /** Backend-only: declare mip levels (upstream generates them through `generateMipmap`). */
  readonly mipLevelCount?: number | undefined;
  /** Backend-only: `GPUTextureSampleType` override for bind-group layouts. */
  readonly sampleType?: GPUTextureSampleType | undefined;
  /** Backend-only: the number of samples for a multisampled render attachment. */
  readonly sampleCount?: number | undefined;
}

/**
 * The replacement `Texture`.
 *
 * Upstream declares `Texture` as a plain function used with `new`; the construction shape and the
 * option bag are unchanged.
 */
export default class Texture {
  static defaultColor = { red: 1, green: 1, blue: 1, alpha: 1 };

  readonly _id: string;
  readonly _context: unknown;
  readonly _pixelFormat: number;
  readonly _pixelDatatype: number;
  readonly _width: number;
  readonly _height: number;
  readonly _dimensions: Cartesian2;
  readonly _preMultiplyAlpha: boolean;
  readonly _flipY: boolean;
  readonly _textureTarget = 0x0de1; // WebGLConstants.TEXTURE_2D — the only target the MVP uses
  readonly _sizeInBytes: number;
  _sampler: unknown;
  readonly formatMapping: TextureFormatMapping;
  readonly gpuTexture: GPUTexture;
  readonly #gpuView: GPUTextureView;
  readonly #gpuSizeInBytes: number;
  readonly #registryId: string;
  readonly #usage: GPUTextureUsageFlags;
  #gpuSampler: GPUSampler;
  #initialized = false;
  #hasMipmap = false;
  #destroyed = false;

  constructor(options: TextureOptions = {} as TextureOptions) {
    const context = options.context;
    const device = requireDevice(context, "Texture#constructor", UPSTREAM_MODULE);

    const source = options.source;
    const pixelFormat = options.pixelFormat ?? PixelFormat.RGBA;
    const pixelDatatype = options.pixelDatatype ?? PixelDatatype.UNSIGNED_BYTE;
    const flipY = options.flipY ?? true;
    let width = options.width;
    let height = options.height;
    if (source !== undefined && source !== null && !isFramebufferSource(source)) {
      const intrinsic = intrinsicSize(source as ImageLikeSource);
      if (width === undefined && intrinsic.width > 0) width = intrinsic.width;
      if (height === undefined && intrinsic.height > 0) height = intrinsic.height;
    }

    // Upstream: premultiplied alpha is the default for RGB/LUMINANCE (and always for opaque uploads).
    const preMultiplyAlpha = options.preMultiplyAlpha === true || pixelFormat === PixelFormat.RGB || pixelFormat === PixelFormat.LUMINANCE;

    if (width === undefined || height === undefined) {
      throw new DiagnosticError(
        "internal",
        "Texture: options requires a source field to create an initialized texture or width and height fields to create a blank texture.",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Texture#constructor" },
      );
    }
    if (!(width > 0) || !(height > 0)) {
      throw new DiagnosticError("internal", `Texture: width and height must be greater than zero (got ${width}×${height}).`, {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Texture#constructor",
      });
    }

    this.formatMapping = mapTextureFormat(pixelFormat, pixelDatatype, { where: "Texture#constructor" });
    if (PixelFormat.isDepthFormat(pixelFormat)) {
      if (source !== undefined && source !== null) {
        throw new DiagnosticError("internal", "Texture: when pixelFormat is DEPTH_COMPONENT or DEPTH_STENCIL, source cannot be provided.", {
          backend: "webgpu",
          upstreamModule: UPSTREAM_MODULE,
          requirementRef: "FR-030",
          entryPoint: "Texture#constructor",
        });
      }
      if ((context as { depthTexture?: boolean }).depthTexture !== true) {
        throw new DiagnosticError(
          "internal",
          "Texture: when pixelFormat is DEPTH_COMPONENT or DEPTH_STENCIL, the context MUST report the depth-texture capability. " +
            "Check context.depthTexture (slice A keeps it false; T097/T098a flip it for slice B).",
          { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Texture#constructor" },
        );
      }
    }
    if (isFramebufferSource(source)) {
      throw sliceBFramebufferCopy("Texture#constructor (source.framebuffer)");
    }

    this._id = nextResourceId("Texture", options.id);
    this._context = context;
    this._pixelFormat = pixelFormat;
    this._pixelDatatype = pixelDatatype;
    this._width = width;
    this._height = height;
    this._dimensions = new Cartesian2(width, height);
    this._preMultiplyAlpha = preMultiplyAlpha;
    this._flipY = flipY;
    this._sizeInBytes = PixelFormat.textureSizeInBytes(pixelFormat, pixelDatatype, width, height);

    this.#usage = options.usage ?? defaultTextureUsage();
    const sampleCount = Math.max(1, options.sampleCount ?? 1);
    this.gpuTexture = device.createTexture({
      label: `cesium-webgpu:Texture:${this._id}`,
      size: { width, height, depthOrArrayLayers: 1 },
      format: this.formatMapping.format,
      usage: this.#usage,
      ...(options.mipLevelCount === undefined ? {} : { mipLevelCount: Math.max(1, options.mipLevelCount) }),
      ...(sampleCount === 1 ? {} : { sampleCount }),
    });
    this.#gpuView = this.gpuTexture.createView();
    this.#gpuSizeInBytes = Math.ceil(width * height * this.formatMapping.bytesPerPixel * Math.max(1, options.mipLevelCount ?? 1) * sampleCount);
    this.#registryId = nextResourceId("Texture", this._id);
    gpuResourceRegistry.register({ id: this.#registryId, kind: "texture", bytes: this.#gpuSizeInBytes, upstreamClass: "Texture" });

    this._sampler = options.sampler ?? new Sampler();
    this.#gpuSampler = this.#createSampler();

    if (source !== undefined && source !== null) {
      this.copyFrom({ source });
      this.#initialized = true;
    } else if (width > 0 && height > 0 && !PixelFormat.isDepthFormat(pixelFormat)) {
      // Upstream's `loadNull` initialises a blank texture (GL gives it zeros). WebGPU leaves a fresh
      // texture's contents undefined, so the zeros are written explicitly — an undefined texture
      // would sample as garbage, which is exactly the "plausible but wrong" failure FR-033 forbids.
      this.#writeZeros();
      this.#initialized = true;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // the read surface the logic layer uses (data-model §5.2)
  // ---------------------------------------------------------------------------------------------

  get id(): string {
    return this._id;
  }

  get sampler(): unknown {
    return this._sampler;
  }

  set sampler(sampler: unknown) {
    this._sampler = sampler;
    this.#gpuSampler = this.#createSampler();
  }

  /** The `GPUSampler` the sampler description maps to (bind groups use this). */
  get gpuSampler(): GPUSampler {
    return this.#gpuSampler;
  }

  /** The default `GPUTextureView` (bind groups and render attachments use this). */
  get view(): GPUTextureView {
    return this.#gpuView;
  }

  /** The `GPUTextureSampleType` a bind-group layout MUST declare for this texture. */
  get sampleType(): GPUTextureSampleType {
    return this.formatMapping.sampleType;
  }

  get pixelFormat(): number {
    return this._pixelFormat;
  }

  get pixelDatatype(): number {
    return this._pixelDatatype;
  }

  get dimensions(): Cartesian2 {
    return this._dimensions;
  }

  get preMultiplyAlpha(): boolean {
    return this._preMultiplyAlpha;
  }

  get flipY(): boolean {
    return this._flipY;
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  get sizeInBytes(): number {
    if (this.#hasMipmap) return Math.floor((this._sizeInBytes * 4) / 3);
    return this._sizeInBytes;
  }

  /** Upstream `Texture.prototype._target` (the GL target enum); kept for shape compatibility. */
  get _target(): number {
    return this._textureTarget;
  }

  /** `true` once texel values have been uploaded (upstream's `_initialized`). */
  get initialized(): boolean {
    return this.#initialized;
  }

  /** The anisotropy requests recorded for this texture's sampler (FR-023). */
  get samplerNotes(): readonly string[] {
    return anisotropyRecords().map((record) => `maximumAnisotropy=${record.requested} recorded, not applied (WebGPU core is isotropic)`);
  }

  // ---------------------------------------------------------------------------------------------
  // factories
  // ---------------------------------------------------------------------------------------------

  /** Upstream `Texture.create` (replaceable so tests can spy on it). */
  static create(options: TextureOptions): Texture {
    return new Texture(options);
  }

  /**
   * Upstream `Texture.fromFramebuffer`.
   *
   * @throws a `DiagnosticError` (`category: "not-implemented"`) naming slice B (T097): the
   *   framebuffer→texture copy is the offscreen-depth path.
   */
  static fromFramebuffer(options: TextureOptions = {} as TextureOptions): never {
    void options;
    throw sliceBFramebufferCopy("Texture.fromFramebuffer");
  }

  // ---------------------------------------------------------------------------------------------
  // upload
  // ---------------------------------------------------------------------------------------------

  /**
   * Upstream `copyFrom({source, xOffset, yOffset, skipColorSpaceConversion})`.
   *
   * The region overload is preserved: `xOffset`/`yOffset` become the `origin` of the WebGPU copy, and
   * a partial copy into a not-yet-initialised texture first writes the blank (zero) image, exactly
   * like upstream's `loadNull()` branch.
   */
  copyFrom(options: { source?: unknown; xOffset?: number; yOffset?: number; skipColorSpaceConversion?: boolean } = {}): void {
    this.#assertAlive("copyFrom");
    const source = options.source;
    if (source === undefined || source === null) {
      throw new DiagnosticError("internal", 'Texture.copyFrom: Check.defined("options.source", source) failed.', {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Texture#copyFrom",
      });
    }
    if (PixelFormat.isDepthFormat(this._pixelFormat)) {
      throw new DiagnosticError("internal", "Texture.copyFrom: cannot call copyFrom when the texture pixel format is DEPTH_COMPONENT or DEPTH_STENCIL.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Texture#copyFrom",
      });
    }
    if (isFramebufferSource(source)) throw sliceBFramebufferCopy("Texture#copyFrom (source.framebuffer)");

    const xOffset = options.xOffset ?? 0;
    const yOffset = options.yOffset ?? 0;
    if (!(xOffset >= 0) || !(yOffset >= 0)) {
      throw new DiagnosticError("internal", "Texture.copyFrom: xOffset and yOffset MUST be greater than or equal to zero.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Texture#copyFrom",
      });
    }

    const intrinsic = intrinsicSize(source as ImageLikeSource);
    const sourceWidth = intrinsic.width > 0 ? intrinsic.width : this._width;
    const sourceHeight = intrinsic.height > 0 ? intrinsic.height : this._height;
    if (xOffset + sourceWidth > this._width || yOffset + sourceHeight > this._height) {
      throw new DiagnosticError(
        "internal",
        `Texture.copyFrom: xOffset + source.width (${xOffset + sourceWidth}) and yOffset + source.height (${yOffset + sourceHeight}) MUST be ` +
          `less than or equal to the texture size (${this._width}×${this._height}).`,
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Texture#copyFrom" },
      );
    }

    const device = requireDevice(this._context, "Texture#copyFrom", UPSTREAM_MODULE);
    const fullTextureCopy = xOffset === 0 && yOffset === 0 && sourceWidth === this._width && sourceHeight === this._height;
    if (!this.#initialized && !fullTextureCopy) {
      // Upstream zeroes the texture before a partial first copy (`loadNull`), so the untouched region
      // is defined. WebGPU leaves it undefined unless it is written.
      this.#writeZeros();
      this.#initialized = true;
    }

    if (isBufferSource(source)) {
      const mapping = this.formatMapping;
      const plan = planTextureUpload({
        source: source.arrayBufferView,
        width: sourceWidth,
        height: sourceHeight,
        sourceComponents: mapping.sourceComponents,
        gpuComponents: mapping.gpuComponents,
        bytesPerComponent: mapping.bytesPerComponent,
        flipY: this._flipY,
        uploadShape: mapping.uploadShape,
        ...(mapping.sampleType === "uint" ? { integerFormat: true } : {}),
        where: "Texture#copyFrom",
      });
      const bytes = preMultiplyAlphaBytes(plan.bytes, sourceWidth, sourceHeight, mapping.gpuComponents, mapping.bytesPerComponent, this._preMultiplyAlpha);
      // The row-reversal and widening of T058/T057 happen above; `writeTexture` itself is
      // unaffected by `UNPACK_*` state, which WebGPU does not have.
      device.queue.writeTexture(
        { texture: this.gpuTexture, origin: { x: xOffset, y: yOffset, z: 0 } },
        bytes,
        { bytesPerRow: plan.bytesPerRow, rowsPerImage: plan.rowsPerImage },
        { width: sourceWidth, height: sourceHeight, depthOrArrayLayers: 1 },
      );
      this.#initialized = true;
      return;
    }

    // ---- image source ---------------------------------------------------------------------------
    if (xOffset !== 0 || yOffset !== 0) {
      throw new DiagnosticError(
        "not-implemented",
        "Texture.copyFrom: a **partial** copy from an image source (HTMLImageElement / ImageBitmap / canvas / video) has no WebGPU " +
          "counterpart — `copyExternalImageToTexture` always copies the whole source, and WebGPU has no unpack sub-rectangle state. " +
          "The MVP terrain path uploads whole images; a partial image copy lands with the imagery increment.",
        {
          backend: "webgpu",
          upstreamModule: UPSTREAM_MODULE,
          requirementRef: "FR-030",
          entryPoint: "Texture#copyFrom",
          plannedPhase: "out of the MVP slice (partial external-image upload)",
          extra: { xOffset, yOffset },
        },
      );
    }
    device.queue.copyExternalImageToTexture(
      { source: source as GPUImageCopyExternalImageSource, flipY: externalImageFlipY(this._flipY) },
      { texture: this.gpuTexture, premultipliedAlpha: this._preMultiplyAlpha },
      { width: sourceWidth, height: sourceHeight, depthOrArrayLayers: 1 },
    );
    this.#initialized = true;
  }

  /**
   * Upstream `copyFromFramebuffer`.
   *
   * @throws a `DiagnosticError` (`category: "not-implemented"`) naming slice B (T097).
   */
  copyFromFramebuffer(..._args: unknown[]): never {
    void _args;
    throw sliceBFramebufferCopy("Texture#copyFromFramebuffer");
  }

  /**
   * Upstream `generateMipmap`.
   *
   * @throws a `DiagnosticError` (`category: "not-implemented"`): WebGPU has no mip-generation
   *   command; generating them needs an explicit downsample pass chain, which is out of the MVP
   *   (the terrain path samples imagery at `LINEAR`/`NEAREST` without mipmaps).
   */
  generateMipmap(..._args: unknown[]): never {
    void _args;
    throw new DiagnosticError(
      "not-implemented",
      "Texture.generateMipmap has no WebGPU counterpart: there is no `glGenerateMipmap`, and generating the chain requires an explicit " +
        "downsample pass per level. The replacement MUST NOT set `mipLevelCount > 1` and leave the levels undefined — those levels would " +
        "sample as garbage while the frame still looks plausible (FR-033).",
      {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Texture#generateMipmap",
        plannedPhase: "out of the MVP slice (mipmap generation passes)",
      },
    );
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    gpuResourceRegistry.release(this.#registryId);
    this.gpuTexture.destroy();
  }

  // ---------------------------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------------------------

  #createSampler(): GPUSampler {
    const device = requireDevice(this._context, "Texture#sampler", UPSTREAM_MODULE);
    const maximumAnisotropy = (this._sampler as { maximumAnisotropy?: number } | undefined)?.maximumAnisotropy ?? 1;
    const mapping = mapSampler(this._sampler as never, { label: `cesium-webgpu:Texture:${this._id}:sampler`, maxAnisotropy: maximumAnisotropy });
    return device.createSampler(mapping.descriptor);
  }

  /** Write the whole texture with zeros, exactly like upstream's `loadNull`. */
  #writeZeros(): void {
    const device = requireDevice(this._context, "Texture#copyFrom", UPSTREAM_MODULE);
    const components = Math.max(1, this.formatMapping.gpuComponents);
    const bytesPerRow = this._width * components * this.formatMapping.bytesPerComponent;
    const zeros = new Uint8Array(bytesPerRow * this._height);
    device.queue.writeTexture(
      { texture: this.gpuTexture },
      zeros,
      { bytesPerRow, rowsPerImage: this._height },
      { width: this._width, height: this._height, depthOrArrayLayers: 1 },
    );
  }

  #assertAlive(entryPoint: string): void {
    if (this.#destroyed) {
      throw new DiagnosticError(
        "render-failed",
        `Texture.${entryPoint}: this texture was destroyed, i.e. destroy() was called (upstream's destroyObject contract).`,
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: `Texture#${entryPoint}` },
      );
    }
  }
}

/**
 * Premultiply alpha on the CPU.
 *
 * `copyExternalImageToTexture` has a `premultipliedAlpha` flag, but `writeTexture` does not: WebGPU
 * has no `UNPACK_PREMULTIPLY_ALPHA_WEBGL`, so a buffer source is premultiplied here. Only 8-bit
 * unorm sources are handled — a float source with `preMultiplyAlpha` set never occurs upstream
 * (`preMultiplyAlpha` defaults on for RGB/LUMINANCE, which are 8-bit in every Cesium call site).
 */
function preMultiplyAlphaBytes(bytes: UploadBytes, width: number, height: number, components: number, bytesPerComponent: number, preMultiply: boolean): UploadBytes {
  if (!preMultiply || components !== 4 || bytesPerComponent !== 1) return bytes;
  const out = Uint8Array.from(bytes);
  const texels = width * height;
  for (let texel = 0; texel < texels; texel += 1) {
    const offset = texel * 4;
    const alpha = out[offset + 3] ?? 255;
    if (alpha === 255) continue;
    out[offset] = Math.round(((out[offset] ?? 0) * alpha) / 255);
    out[offset + 1] = Math.round(((out[offset + 1] ?? 0) * alpha) / 255);
    out[offset + 2] = Math.round(((out[offset + 2] ?? 0) * alpha) / 255);
  }
  return out;
}

/** The shared slice-B failure (tasks.md T097 owns the offscreen framebuffer→texture copy path). */
function sliceBFramebufferCopy(entryPoint: string): DiagnosticError {
  return new DiagnosticError(
    "not-implemented",
    `${entryPoint}: copying a framebuffer region into a texture belongs to slice B (offscreen depth / \`GlobeDepth\` wiring, tasks.md T097), ` +
      "which is a separate task from the resource layer (W3). It needs `copyTextureToTexture` between two attachments plus the depth-texture " +
      "capability flip (T098a), so implementing it here would pre-empt both. The replacement MUST fail loudly rather than copy nothing.",
    {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      requirementRef: "FR-030",
      entryPoint,
      plannedPhase: "slice B (T097/T098a: offscreen depth and framebuffer copy paths)",
    },
  );
}

/** The default 1×1 RGBA8 white texel upstream's `defaultTexture` uses (helper for `Context`). */
export const DEFAULT_TEXTURE_RGBA8: readonly [number, number, number, number] = DEFAULT_COLOR_RGBA8;
