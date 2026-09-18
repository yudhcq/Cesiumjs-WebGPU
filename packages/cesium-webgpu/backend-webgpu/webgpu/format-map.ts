/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * T057 — format and type mapping tables (research §6.1, data-model §5.2, tasks.md T057).
 *
 * The logic layer never names a GPU format: it hands the backend upstream `PixelFormat` /
 * `PixelDatatype` / `RenderbufferFormat` / `BufferUsage` / `ComponentDatatype` values, and the
 * backend answers the only question WebGPU asks. This module is the **single** place where that
 * translation lives, so a format can never be mapped one way by `Texture` and another by
 * `Renderbuffer`.
 *
 * Three rules keep the mapping honest:
 *   1. every enum member the logic layer can pass has an entry — the unit test walks the upstream
 *      enum objects and fails on a missing one, so a new upstream format cannot silently fall
 *      through;
 *   2. a member this increment cannot serve throws a `DiagnosticError` naming the owning task —
 *      never a "closest" format, which would render a plausible but wrong image (FR-033);
 *   3. a mapping that is an **equivalence** rather than an identity (WebGPU has no `RGB8`,
 *      `LUMINANCE`, `ALPHA`, `RGBA4`, …) is recorded in `notes`, so the widening is auditable
 *      instead of implicit.
 *
 * `mapTextureFormat()` answers for the *sampled* format; `mapRenderbufferFormat()` for a render
 * attachment; `bufferUsageToGpu()` for a buffer; `vertexFormatFor()` for one vertex attribute.
 */
import PixelFormat from "@cesium/engine/Source/Core/PixelFormat.js";
import BufferUsage from "@cesium/engine/Source/Renderer/BufferUsage.js";
import PixelDatatype from "@cesium/engine/Source/Renderer/PixelDatatype.js";
import RenderbufferFormat from "@cesium/engine/Source/Renderer/RenderbufferFormat.js";

import { DiagnosticError } from "./errors.js";

const UPSTREAM_FORMAT_MODULE = "Renderer/Texture.js";

/** `ComponentDatatype.*` — the values `VertexArray` attributes carry (kept upstream module, GL numbers). */
export const ComponentDatatype = {
  BYTE: 0x1400,
  UNSIGNED_BYTE: 0x1401,
  SHORT: 0x1402,
  UNSIGNED_SHORT: 0x1403,
  INT: 0x1404,
  UNSIGNED_INT: 0x1405,
  FLOAT: 0x1406,
  DOUBLE: 0x140a,
  HALF_FLOAT: 0x140b,
} as const;

/** `IndexDatatype.*` (kept upstream `Core/IndexDatatype.js` numbers). */
export const IndexDatatype = {
  UNSIGNED_BYTE: 0x1401,
  UNSIGNED_SHORT: 0x1403,
  UNSIGNED_INT: 0x1405,
} as const;

/** How the source bytes of one texel are laid out relative to the GPU format. */
export type UploadShape =
  /** Source components and GPU components are the same: upload the rows unchanged. */
  | "identity"
  /** The GPU format has more components than the source: widen each texel (LUMINANCE/RGB/ALPHA). */
  | "widen"
  /** The source is a packed 16/32-bit value: unpack to bytes first (5_6_5 / 4_4_4_4 / 5_5_5_1). */
  | "unpack";

/** One `(PixelFormat, PixelDatatype)` → `GPUTextureFormat` mapping. */
export interface TextureFormatMapping {
  /** The `GPUTextureFormat` the logic layer's texture is realised with. */
  readonly format: GPUTextureFormat;
  /** The `GPUTextureSampleType` a bind group layout MUST declare for it. */
  readonly sampleType: GPUTextureSampleType;
  /** Components in the *source* data (upstream `PixelFormat.componentsLength`). */
  readonly sourceComponents: number;
  /** Components in the GPU format (always `sourceComponents` except for a widening equivalence). */
  readonly gpuComponents: number;
  /** Bytes per source component. */
  readonly bytesPerComponent: number;
  /** Bytes per source texel (upstream's `textureSizeInBytes / (width * height)`). */
  readonly bytesPerPixel: number;
  /** Whether the GPU format is an sRGB view of the source data. */
  readonly srgb: boolean;
  /** How `Texture#copyFrom` MUST transform the source bytes before `queue.writeTexture`. */
  readonly uploadShape: UploadShape;
  /** Recorded equivalences / degradations (FR-023: an approximation is never silent). */
  readonly notes: readonly string[];
}

/**
 * A `(PixelFormat, PixelDatatype)` pair the backend deliberately does not serve.
 *
 * @throws a `DiagnosticError` (`category: "not-implemented"`) naming the task that lands it.
 */
function unsupported(pixelFormat: number, pixelDatatype: number, reason: string): never {
  throw new DiagnosticError(
    "not-implemented",
    `pixelFormat=${pixelFormat} / pixelDatatype=${pixelDatatype} has no WebGPU realisation in this increment: ${reason}. ` +
      "The replacement MUST fail loudly here — substituting a nearby format would render a plausible but wrong image (FR-033).",
    {
      backend: "webgpu",
      upstreamModule: UPSTREAM_FORMAT_MODULE,
      entryPoint: "format-map.mapTextureFormat",
      requirementRef: "FR-030",
      plannedPhase: "out of the MVP slice (compressed / 3D / cube-map texture paths)",
      extra: { pixelFormat, pixelDatatype },
    },
  );
}

/** `true` when the pair is a compressed format (any datatype). */
function isCompressed(pixelFormat: number): boolean {
  return PixelFormat.isCompressedFormat(pixelFormat);
}

/**
 * Map an upstream `(PixelFormat, PixelDatatype)` pair to a `GPUTextureFormat`.
 *
 * @param pixelFormat upstream `PixelFormat` value
 * @param pixelDatatype upstream `PixelDatatype` value
 * @param options `srgb` selects the sRGB view of the map (an explicit choice, never a default),
 *   `where` names the caller in the diagnostic.
 */
export function mapTextureFormat(
  pixelFormat: number,
  pixelDatatype: number,
  options: { srgb?: boolean; where?: string } = {},
): TextureFormatMapping {
  const where = options.where ?? "format-map.mapTextureFormat";
  if (isCompressed(pixelFormat)) {
    return unsupported(
      pixelFormat,
      pixelDatatype,
      "compressed texture upload (S3TC/PVRTC/ASTC/ETC/BC7) is outside the MVP slice; the terrain path uses uncompressed imagery",
    );
  }

  const componentsLength = PixelFormat.componentsLength(pixelFormat);
  const packed = PixelDatatype.isPacked(pixelDatatype);
  const sourceComponents = packed ? 1 : componentsLength;
  const bytesPerComponent = PixelDatatype.sizeInBytes(pixelDatatype) ?? 0;
  const bytesPerPixel = sourceComponents * bytesPerComponent;
  const srgb = options.srgb === true;
  const notes: string[] = [];

  if (srgb && pixelFormat !== PixelFormat.RGBA && pixelFormat !== PixelFormat.RGB) {
    throw new DiagnosticError(
      "internal",
      `${where}: an sRGB view only exists for RGB/RGBA colour textures (got pixelFormat=${pixelFormat}). ` +
        "Asking for sRGB on a depth, integer or single-channel format is a caller error, not a degradation.",
      { backend: "webgpu", upstreamModule: UPSTREAM_FORMAT_MODULE, requirementRef: "FR-030", entryPoint: where },
    );
  }

  const srgbVariant = (base: GPUTextureFormat): GPUTextureFormat => {
    if (!srgb) return base;
    if (base === "rgba8unorm") return "rgba8unorm-srgb";
    if (base === "bgra8unorm") return "bgra8unorm-srgb";
    return base;
  };

  const colour = (format: GPUTextureFormat, sampleType: GPUTextureSampleType, gpuComponents: number, uploadShape: UploadShape, extraNotes: readonly string[] = []): TextureFormatMapping => ({
    format: srgbVariant(format),
    sampleType,
    sourceComponents,
    gpuComponents,
    bytesPerComponent,
    bytesPerPixel,
    srgb,
    uploadShape,
    notes: [...extraNotes],
  });

  // ---- depth / stencil -------------------------------------------------------------------------
  if (pixelFormat === PixelFormat.DEPTH_COMPONENT) {
    if (pixelDatatype === PixelDatatype.UNSIGNED_SHORT) {
      return colour("depth16unorm", "depth", 1, "identity", ["GL DEPTH_COMPONENT16 ↔ WebGPU depth16unorm (16-bit unorm, identical precision)"]);
    }
    if (pixelDatatype === PixelDatatype.UNSIGNED_INT) {
      return colour("depth24plus", "depth", 1, "identity", [
        "GL DEPTH_COMPONENT24 (UNSIGNED_INT) ↔ WebGPU depth24plus: depth24plus has an implementation-chosen depth precision (≥24 bits on every conformant implementation), so the GL 24-bit guarantee is kept as a minimum, not as an exact match",
      ]);
    }
    return unsupported(pixelFormat, pixelDatatype, "only UNSIGNED_SHORT (depth16unorm) and UNSIGNED_INT (depth24plus) have a WebGPU depth format");
  }
  if (pixelFormat === PixelFormat.DEPTH_STENCIL) {
    if (pixelDatatype === PixelDatatype.UNSIGNED_INT_24_8) {
      return colour("depth24plus-stencil8", "depth", 1, "identity", ["GL DEPTH24_STENCIL8 ↔ WebGPU depth24plus-stencil8"]);
    }
    return unsupported(pixelFormat, pixelDatatype, "DEPTH_STENCIL requires UNSIGNED_INT_24_8 upstream as well");
  }

  // ---- uncompressed colour ---------------------------------------------------------------------
  switch (pixelFormat) {
    case PixelFormat.RGBA:
      if (pixelDatatype === PixelDatatype.UNSIGNED_BYTE) return colour("rgba8unorm", "float", 4, "identity");
      if (pixelDatatype === PixelDatatype.HALF_FLOAT) return colour("rgba16float", "float", 4, "identity");
      if (pixelDatatype === PixelDatatype.FLOAT) return colour("rgba32float", "unfilterable-float", 4, "identity", ["rgba32float is not filterable in core WebGPU; samplers MUST use NEAREST unless the `float32-filterable` feature is enabled"]);
      if (pixelDatatype === PixelDatatype.UNSIGNED_SHORT_4_4_4_4) {
        return colour("rgba8unorm", "float", 4, "unpack", ["GL RGBA4 (packed 4_4_4_4) has no WebGPU counterpart: unpacked to rgba8unorm (4 bits → 8 bits by bit replication)"]);
      }
      if (pixelDatatype === PixelDatatype.UNSIGNED_SHORT_5_5_5_1) {
        return colour("rgba8unorm", "float", 4, "unpack", ["GL RGB5_A1 (packed 5_5_5_1) has no WebGPU counterpart: unpacked to rgba8unorm"]);
      }
      return unsupported(pixelFormat, pixelDatatype, "no rgba8/rgba16/rgba32 realisation for this datatype");
    case PixelFormat.RGB:
      if (pixelDatatype === PixelDatatype.UNSIGNED_BYTE) {
        return colour("rgba8unorm", "float", 4, "widen", ["WebGPU has no 3-component 8-bit format: RGB8 is widened to rgba8unorm with alpha = 255 (the shader still reads .rgb)"]);
      }
      if (pixelDatatype === PixelDatatype.HALF_FLOAT) return colour("rgba16float", "float", 4, "widen", ["RGB16F widened to rgba16float (alpha = 1)"]);
      if (pixelDatatype === PixelDatatype.FLOAT) return colour("rgba32float", "unfilterable-float", 4, "widen", ["RGB32F widened to rgba32float (alpha = 1); not filterable in core WebGPU"]);
      if (pixelDatatype === PixelDatatype.UNSIGNED_SHORT_5_6_5) {
        return colour("rgba8unorm", "float", 4, "unpack", ["GL RGB565 has no WebGPU counterpart: unpacked to rgba8unorm"]);
      }
      return unsupported(pixelFormat, pixelDatatype, "no widened colour realisation for this datatype");
    case PixelFormat.LUMINANCE:
      if (pixelDatatype === PixelDatatype.UNSIGNED_BYTE) {
        return colour("rgba8unorm", "float", 4, "widen", ["WebGPU has no LUMINANCE format: r8 replicated into rgb with alpha = 255, so a shader reading .rgb keeps the GL value"]);
      }
      return unsupported(pixelFormat, pixelDatatype, "LUMINANCE is only exposed as 8-bit upstream");
    case PixelFormat.LUMINANCE_ALPHA:
      if (pixelDatatype === PixelDatatype.UNSIGNED_BYTE) {
        return colour("rgba8unorm", "float", 4, "widen", ["WebGPU has no LUMINANCE_ALPHA format: (l, a) widened to (l, l, l, a) in rgba8unorm"]);
      }
      return unsupported(pixelFormat, pixelDatatype, "LUMINANCE_ALPHA is only exposed as 8-bit upstream");
    case PixelFormat.ALPHA:
      if (pixelDatatype === PixelDatatype.UNSIGNED_BYTE) {
        return colour("rgba8unorm", "float", 4, "widen", ["WebGPU has no ALPHA-only format: alpha widened to (255, 255, 255, a) in rgba8unorm"]);
      }
      return unsupported(pixelFormat, pixelDatatype, "ALPHA is only exposed as 8-bit upstream");
    case PixelFormat.RED:
      if (pixelDatatype === PixelDatatype.UNSIGNED_BYTE) return colour("r8unorm", "float", 1, "identity");
      if (pixelDatatype === PixelDatatype.HALF_FLOAT) return colour("r16float", "float", 1, "identity");
      if (pixelDatatype === PixelDatatype.FLOAT) return colour("r32float", "unfilterable-float", 1, "identity", ["r32float is not filterable in core WebGPU"]);
      return unsupported(pixelFormat, pixelDatatype, "no single-channel float/unorm realisation for this datatype");
    case PixelFormat.RG:
      if (pixelDatatype === PixelDatatype.UNSIGNED_BYTE) return colour("rg8unorm", "float", 2, "identity");
      if (pixelDatatype === PixelDatatype.HALF_FLOAT) return colour("rg16float", "float", 2, "identity");
      if (pixelDatatype === PixelDatatype.FLOAT) return colour("rg32float", "unfilterable-float", 2, "identity", ["rg32float is not filterable in core WebGPU"]);
      return unsupported(pixelFormat, pixelDatatype, "no two-channel float/unorm realisation for this datatype");
    case PixelFormat.RED_INTEGER:
      if (pixelDatatype === PixelDatatype.UNSIGNED_BYTE) return colour("r8uint", "uint", 1, "identity");
      if (pixelDatatype === PixelDatatype.UNSIGNED_SHORT) return colour("r16uint", "uint", 1, "identity");
      if (pixelDatatype === PixelDatatype.UNSIGNED_INT) return colour("r32uint", "uint", 1, "identity");
      return unsupported(pixelFormat, pixelDatatype, "integer textures only carry UNSIGNED_* datatypes");
    case PixelFormat.RG_INTEGER:
      if (pixelDatatype === PixelDatatype.UNSIGNED_BYTE) return colour("rg8uint", "uint", 2, "identity");
      if (pixelDatatype === PixelDatatype.UNSIGNED_SHORT) return colour("rg16uint", "uint", 2, "identity");
      if (pixelDatatype === PixelDatatype.UNSIGNED_INT) return colour("rg32uint", "uint", 2, "identity");
      return unsupported(pixelFormat, pixelDatatype, "integer textures only carry UNSIGNED_* datatypes");
    case PixelFormat.RGB_INTEGER:
      if (pixelDatatype === PixelDatatype.UNSIGNED_BYTE) {
        return colour("rgba8uint", "uint", 4, "widen", ["WebGPU has no 3-component integer format: RGB8UI widened to rgba8uint with alpha = 255"]);
      }
      if (pixelDatatype === PixelDatatype.UNSIGNED_SHORT) {
        return colour("rgba16uint", "uint", 4, "widen", ["RGB16UI widened to rgba16uint with alpha = 65535"]);
      }
      if (pixelDatatype === PixelDatatype.UNSIGNED_INT) {
        return colour("rgba32uint", "uint", 4, "widen", ["RGB32UI widened to rgba32uint with alpha = 0xFFFFFFFF"]);
      }
      return unsupported(pixelFormat, pixelDatatype, "integer textures only carry UNSIGNED_* datatypes");
    case PixelFormat.RGBA_INTEGER:
      if (pixelDatatype === PixelDatatype.UNSIGNED_BYTE) return colour("rgba8uint", "uint", 4, "identity");
      if (pixelDatatype === PixelDatatype.UNSIGNED_SHORT) return colour("rgba16uint", "uint", 4, "identity");
      if (pixelDatatype === PixelDatatype.UNSIGNED_INT) return colour("rgba32uint", "uint", 4, "identity");
      return unsupported(pixelFormat, pixelDatatype, "integer textures only carry UNSIGNED_* datatypes");
    default:
      return unsupported(pixelFormat, pixelDatatype, "unknown PixelFormat value");
  }
}

/** A render-attachment format and what kind of attachment it is. */
export interface RenderbufferFormatMapping {
  readonly format: GPUTextureFormat;
  readonly kind: "color" | "depth" | "depth-stencil" | "stencil";
  readonly notes: readonly string[];
}

/** Map an upstream `RenderbufferFormat` to the `GPUTextureFormat` of the attachment. */
export function mapRenderbufferFormat(format: number): RenderbufferFormatMapping {
  switch (format) {
    case RenderbufferFormat.RGBA8:
      return { format: "rgba8unorm", kind: "color", notes: [] };
    case RenderbufferFormat.RGBA16F:
      return { format: "rgba16float", kind: "color", notes: [] };
    case RenderbufferFormat.RGBA32F:
      return { format: "rgba32float", kind: "color", notes: [] };
    case RenderbufferFormat.DEPTH_COMPONENT16:
      return { format: "depth16unorm", kind: "depth", notes: [] };
    case RenderbufferFormat.DEPTH_STENCIL:
    case RenderbufferFormat.DEPTH24_STENCIL8:
      return {
        format: "depth24plus-stencil8",
        kind: "depth-stencil",
        notes: format === RenderbufferFormat.DEPTH_STENCIL ? ["GL DEPTH_STENCIL ↔ WebGPU depth24plus-stencil8 (packed depth+stencil attachment)"] : [],
      };
    case RenderbufferFormat.STENCIL_INDEX8:
      return { format: "stencil8", kind: "stencil", notes: ["WebGPU has a stencil8 attachment format; it is not sampleable as a colour texture"] };
    case RenderbufferFormat.RGBA4:
      return {
        format: "rgba8unorm",
        kind: "color",
        notes: ["GL RGBA4 has no WebGPU counterpart: the attachment is rgba8unorm (more precision, same channel semantics)"],
      };
    case RenderbufferFormat.RGB5_A1:
    case RenderbufferFormat.RGB565:
      return {
        format: "rgba8unorm",
        kind: "color",
        notes: ["GL RGB5_A1/RGB565 has no WebGPU counterpart: the attachment is rgba8unorm (more precision, same channel semantics)"],
      };
    default:
      throw new DiagnosticError(
        "internal",
        `format-map.mapRenderbufferFormat: RenderbufferFormat value ${format} is not a known upstream enum member ` +
          "(RenderbufferFormat.validate). The replacement MUST fail loudly rather than guess an attachment format.",
        {
          backend: "webgpu",
          upstreamModule: "Renderer/Renderbuffer.js",
          entryPoint: "format-map.mapRenderbufferFormat",
          requirementRef: "FR-030",
          extra: { format },
        },
      );
  }
}

/** Which upstream buffer role a `Buffer` replacement is creating. */
export type BufferRole = "vertex" | "index" | "pixel";

/**
 * Map an upstream `BufferUsage` + role to a `GPUBufferUsage` combination (research §6.1).
 *
 * The combination is deliberately the **widest defensible** one for the role: WebGPU has no notion
 * of "the driver decided to place this in system memory", and upstream's `copyFromArrayView` may
 * run at any time, so every buffer keeps `COPY_DST`. The three roles differ only in where the data
 * can be *read*: vertex (`VERTEX`), index (`INDEX`), pixel (`COPY_SRC | MAP_READ`).
 */
export function bufferUsageToGpu(usage: number, role: BufferRole): GPUBufferUsageFlags {
  if (!BufferUsage.validate(usage)) {
    throw new DiagnosticError(
      "internal",
      `format-map.bufferUsageToGpu: usage ${usage} is not a BufferUsage member (BufferUsage.validate). ` +
        "Buffer's constructor validates the same value upstream, so reaching this point means the caller bypassed the option shape.",
      { backend: "webgpu", upstreamModule: "Renderer/Buffer.js", entryPoint: "format-map.bufferUsageToGpu", requirementRef: "FR-030", extra: { usage, role } },
    );
  }
  const usages = globalThis.GPUBufferUsage;
  switch (role) {
    case "index":
      return usages.INDEX | usages.COPY_DST | usages.COPY_SRC;
    case "pixel":
      // Upstream pixel buffers (PBOs) exist to be read back: MAP_READ is the only way WebGPU exposes
      // that, and read-back itself is the slice-C boundary (`Context#readPixels`).
      return usages.COPY_SRC | usages.COPY_DST | usages.MAP_READ;
    case "vertex":
    default:
      return usages.VERTEX | usages.COPY_DST | usages.COPY_SRC;
  }
}

/** Bytes per component of a `ComponentDatatype` value. */
export function componentDatatypeSizeInBytes(componentDatatype: number): number {
  switch (componentDatatype) {
    case ComponentDatatype.BYTE:
    case ComponentDatatype.UNSIGNED_BYTE:
      return 1;
    case ComponentDatatype.SHORT:
    case ComponentDatatype.UNSIGNED_SHORT:
    case ComponentDatatype.HALF_FLOAT:
      return 2;
    case ComponentDatatype.INT:
    case ComponentDatatype.UNSIGNED_INT:
    case ComponentDatatype.FLOAT:
      return 4;
    case ComponentDatatype.DOUBLE:
      return 8;
    default:
      throw new DiagnosticError(
        "internal",
        `format-map.componentDatatypeSizeInBytes: unknown ComponentDatatype ${componentDatatype}. ` +
          "The replacement MUST reject an attribute it cannot size instead of guessing a stride.",
        { backend: "webgpu", upstreamModule: "Renderer/VertexArray.js", entryPoint: "format-map.componentDatatypeSizeInBytes", requirementRef: "FR-030", extra: { componentDatatype } },
      );
  }
}

/**
 * `ComponentDatatype` → `GPUVertexFormat`, indexed by `componentsPerAttribute` (1..4).
 *
 * `ComponentDatatype` → `GPUVertexFormat`, indexed by `componentsPerAttribute` (1..4).
 *
 * The arrays are **not** offset: `TABLE[datatype][componentsPerAttribute]` answers directly, so
 * entry 1 is the 1-component format (or the next wider one where WebGPU has none). Where WebGPU
 * has no exact format for a component count (no 1- or 3-component 8/16-bit format) the entry repeats
 * the next wider format, and `vertexFormatFor` records the widening.
 */
const VERTEX_FORMAT_BY_DATATYPE: Record<number, readonly GPUVertexFormat[] | undefined> = {
  [ComponentDatatype.UNSIGNED_BYTE]: ["uint8x2", "uint8x2", "uint8x2", "uint8x4", "uint8x4"],
  [ComponentDatatype.BYTE]: ["sint8x2", "sint8x2", "sint8x2", "sint8x4", "sint8x4"],
  [ComponentDatatype.UNSIGNED_SHORT]: ["uint16x2", "uint16x2", "uint16x2", "uint16x4", "uint16x4"],
  [ComponentDatatype.SHORT]: ["sint16x2", "sint16x2", "sint16x2", "sint16x4", "sint16x4"],
  [ComponentDatatype.UNSIGNED_INT]: ["uint32", "uint32", "uint32x2", "uint32x3", "uint32x4"],
  [ComponentDatatype.INT]: ["sint32", "sint32", "sint32x2", "sint32x3", "sint32x4"],
  [ComponentDatatype.FLOAT]: ["float32", "float32", "float32x2", "float32x3", "float32x4"],
  [ComponentDatatype.HALF_FLOAT]: ["float16x2", "float16x2", "float16x2", "float16x4", "float16x4"],
};

const NORMALIZED_VERTEX_FORMAT_BY_DATATYPE: Record<number, readonly GPUVertexFormat[] | undefined> = {
  [ComponentDatatype.UNSIGNED_BYTE]: ["unorm8x2", "unorm8x2", "unorm8x2", "unorm8x4", "unorm8x4"],
  [ComponentDatatype.BYTE]: ["snorm8x2", "snorm8x2", "snorm8x2", "snorm8x4", "snorm8x4"],
  [ComponentDatatype.UNSIGNED_SHORT]: ["unorm16x2", "unorm16x2", "unorm16x2", "unorm16x4", "unorm16x4"],
  [ComponentDatatype.SHORT]: ["snorm16x2", "snorm16x2", "snorm16x2", "snorm16x4", "snorm16x4"],
};

/**
 * Map one vertex attribute to a `GPUVertexFormat`.
 *
 * `componentsPerAttribute` is 1..4 upstream; WebGPU has no 1- or 3-component 8/16-bit format, so
 * those are served by the next wider format with a recorded note — the same equivalence direction
 * the terrain layout (research §1.6: all attributes FLOAT, non-normalized) never needs, but which
 * a `TerrainEncoding` quantization mode or a model path can reach.
 */
export function vertexFormatFor(
  componentDatatype: number,
  componentsPerAttribute: number,
  normalized: boolean,
): { format: GPUVertexFormat; components: number; notes: readonly string[] } {
  if (!Number.isInteger(componentsPerAttribute) || componentsPerAttribute < 1 || componentsPerAttribute > 4) {
    throw new DiagnosticError(
      "internal",
      `format-map.vertexFormatFor: componentsPerAttribute must be 1..4 (upstream VertexArray validation), got ${componentsPerAttribute}.`,
      { backend: "webgpu", upstreamModule: "Renderer/VertexArray.js", entryPoint: "format-map.vertexFormatFor", requirementRef: "FR-030", extra: { componentsPerAttribute } },
    );
  }
  const table = normalized ? NORMALIZED_VERTEX_FORMAT_BY_DATATYPE : VERTEX_FORMAT_BY_DATATYPE;
  const formats = table[componentDatatype];
  if (formats === undefined) {
    throw new DiagnosticError(
      "not-implemented",
      `format-map.vertexFormatFor: ComponentDatatype ${componentDatatype}${normalized ? " (normalized)" : ""} has no GPUVertexFormat in this increment. ` +
        "The upstream terrain attributes are FLOAT and non-normalized (research §1.6); other datatypes land with the model/voxel paths.",
      {
        backend: "webgpu",
        upstreamModule: "Renderer/VertexArray.js",
        entryPoint: "format-map.vertexFormatFor",
        requirementRef: "FR-030",
        plannedPhase: "out of the MVP slice (model / voxel vertex layouts)",
        extra: { componentDatatype, componentsPerAttribute, normalized },
      },
    );
  }
  const format = formats[componentsPerAttribute];
  if (format === undefined) {
    throw new DiagnosticError(
      "internal",
      `format-map.vertexFormatFor: no GPUVertexFormat for ${componentsPerAttribute} component(s) of ComponentDatatype ${componentDatatype}.`,
      { backend: "webgpu", upstreamModule: "Renderer/VertexArray.js", entryPoint: "format-map.vertexFormatFor", requirementRef: "FR-030" },
    );
  }
  const notes: string[] = [];
  const produced = componentsPerAttribute === 1 && format.endsWith("x2") ? 2 : componentsPerAttribute === 3 && format.endsWith("x4") ? 4 : componentsPerAttribute;
  if (produced !== componentsPerAttribute) {
    notes.push(
      `WebGPU has no ${componentsPerAttribute}-component format for this datatype: the attribute is read as ${format} ` +
        `(${produced} components); the extra lanes are the following component's bytes and MUST be ignored by the shader.`,
    );
  }
  return { format, components: produced, notes };
}

/** `true` when the pair can be a colour render attachment (used by `Framebuffer` validation). */
export function isColorAttachmentFormat(pixelFormat: number): boolean {
  return PixelFormat.isColorFormat(pixelFormat);
}

/** `true` when the pair is a depth / depth-stencil format (used by `Framebuffer` validation). */
export function isDepthFormat(pixelFormat: number): boolean {
  return PixelFormat.isDepthFormat(pixelFormat);
}

/** Exposed so callers and tests can iterate the upstream enums without importing them themselves. */
export const upstreamEnums = {
  PixelFormat,
  PixelDatatype,
  RenderbufferFormat,
  BufferUsage,
} as const;
