/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/Renderbuffer.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * T061 (part 2 of 3) — `Renderbuffer` → `GPUTexture` (research §6.1, data-model §5.2, FR-030).
 *
 * A GL renderbuffer is "a texture that cannot be sampled": storage for a render attachment. WebGPU
 * has no such object, so the replacement is a `GPUTexture` created with `RENDER_ATTACHMENT` usage —
 * and multisampled (`sampleCount: 4`) when upstream asks for `numSamples > 1`, which is exactly what
 * `MultisampleFramebuffer` needs for its resolve pair.
 *
 * WHAT IS PRESERVED: the option bag (`context`, `format`, `width`, `height`, `numSamples`), the
 * `format` / `width` / `height` accessors, `_getRenderbuffer()`, `isDestroyed()` and `destroy()`.
 * `format` is the **upstream** enum value (a `RenderbufferFormat` member), not the mapped
 * `GPUTextureFormat`: the logic layer compares it, so mapping it would change the read surface.
 */
import RenderbufferFormat from "@cesium/engine/Source/Renderer/RenderbufferFormat.js";

import { requireDevice } from "../webgpu/context-device.js";
import { DiagnosticError } from "../webgpu/errors.js";
import { mapRenderbufferFormat } from "../webgpu/format-map.js";
import { estimateTextureBytes, gpuResourceRegistry, nextResourceId } from "../webgpu/gpu-resource-registry.js";

const UPSTREAM_MODULE = "Renderer/Renderbuffer.js";

export interface RenderbufferOptions {
  readonly context: unknown;
  readonly format?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly numSamples?: number | undefined;
}

/**
 * The replacement `Renderbuffer`.
 *
 * Upstream declares `Renderbuffer` as a plain function used with `new`; the construction shape and
 * the option bag are unchanged.
 */
export default class Renderbuffer {
  readonly _context: unknown;
  readonly _format: number;
  readonly _width: number;
  readonly _height: number;
  readonly _numSamples: number;
  readonly gpuFormat: GPUTextureFormat;
  readonly kind: "color" | "depth" | "depth-stencil" | "stencil";
  readonly gpuTexture: GPUTexture;
  readonly notes: readonly string[];
  readonly #gpuView: GPUTextureView;
  readonly #registryId: string;
  #destroyed = false;

  constructor(options: RenderbufferOptions = {} as RenderbufferOptions) {
    const context = options.context;
    const device = requireDevice(context, "Renderbuffer#constructor", UPSTREAM_MODULE);

    const format = options.format ?? RenderbufferFormat.RGBA4;
    if (!RenderbufferFormat.validate(format)) {
      throw new DiagnosticError("internal", `Renderbuffer: invalid format ${String(format)} (RenderbufferFormat.validate).`, {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Renderbuffer#constructor",
        extra: { format: String(format) },
      });
    }
    const width = options.width ?? (context as { drawingBufferWidth?: number }).drawingBufferWidth ?? 0;
    const height = options.height ?? (context as { drawingBufferHeight?: number }).drawingBufferHeight ?? 0;
    if (!(width > 0)) {
      throw new DiagnosticError("internal", `Renderbuffer: width must be greater than zero (got ${String(width)}).`, {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Renderbuffer#constructor",
      });
    }
    if (!(height > 0)) {
      throw new DiagnosticError("internal", `Renderbuffer: height must be greater than zero (got ${String(height)}).`, {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Renderbuffer#constructor",
      });
    }
    const maximumRenderbufferSize = (context as { contextLimits?: { maximumRenderbufferSize?: number } }).contextLimits?.maximumRenderbufferSize;
    if (maximumRenderbufferSize !== undefined && width > maximumRenderbufferSize) {
      throw new DiagnosticError("internal", `Renderbuffer: width must be less than or equal to the maximum renderbuffer size (${maximumRenderbufferSize}).`, {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Renderbuffer#constructor",
      });
    }
    if (maximumRenderbufferSize !== undefined && height > maximumRenderbufferSize) {
      throw new DiagnosticError("internal", `Renderbuffer: height must be less than or equal to the maximum renderbuffer size (${maximumRenderbufferSize}).`, {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Renderbuffer#constructor",
      });
    }

    // WebGPU's only multisample counts are 1 and 4; upstream asks for 1 or for `context.msaa ? 4 : 1`
    // (FramebufferManager), so anything else is a caller error rather than something to round.
    const numSamples = options.numSamples ?? 1;
    if (numSamples !== 1 && numSamples !== 4) {
      throw new DiagnosticError(
        "not-implemented",
        `Renderbuffer: numSamples=${numSamples} is not expressible in WebGPU — \`GPUTextureDescriptor.sampleCount\` is 1 or 4. ` +
          "Upstream reaches 4 through `context.msaa` (which this backend publishes as true) and 1 otherwise.",
        {
          backend: "webgpu",
          upstreamModule: UPSTREAM_MODULE,
          requirementRef: "FR-030",
          entryPoint: "Renderbuffer#constructor",
          plannedPhase: "not planned: WebGPU supports 1x and 4x only",
          extra: { numSamples },
        },
      );
    }

    const mapping = mapRenderbufferFormat(format);
    this._context = context;
    this._format = format;
    this._width = width;
    this._height = height;
    this._numSamples = numSamples;
    this.gpuFormat = mapping.format;
    this.kind = mapping.kind;
    this.notes = mapping.notes;

    this.gpuTexture = device.createTexture({
      label: `cesium-webgpu:Renderbuffer:${format}:${width}x${height}x${numSamples}`,
      size: { width, height, depthOrArrayLayers: 1 },
      format: mapping.format,
      usage: globalThis.GPUTextureUsage.RENDER_ATTACHMENT | globalThis.GPUTextureUsage.COPY_SRC | globalThis.GPUTextureUsage.COPY_DST,
      ...(numSamples === 1 ? {} : { sampleCount: numSamples }),
    });
    this.#gpuView = this.gpuTexture.createView();
    this.#registryId = nextResourceId("Renderbuffer");
    gpuResourceRegistry.register({
      id: this.#registryId,
      kind: "texture",
      bytes: estimateTextureBytes({ width, height, bytesPerTexel: bytesPerTexelOfFormat(mapping.format), sampleCount: numSamples }),
      upstreamClass: "Renderbuffer",
    });
  }

  /** Read surface. */
  get format(): number {
    return this._format;
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  /** `4` for the multisampled attachment, else `1` (the pass state machine reads this). */
  get numSamples(): number {
    return this._numSamples;
  }

  /** The render-attachment view a render pass uses (`WebgpuFramebufferRef.colorAttachments[i].view`). */
  get view(): GPUTextureView {
    return this.#gpuView;
  }

  /** Upstream `_getRenderbuffer()` — the platform handle (`GPUTexture` in this backend). */
  _getRenderbuffer(): GPUTexture {
    return this.gpuTexture;
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
}

/** Bytes per texel of the mapped attachment format (the ledger's estimate). */
function bytesPerTexelOfFormat(format: GPUTextureFormat): number {
  switch (format) {
    case "rgba32float":
    case "depth24plus":
    case "depth24plus-stencil8":
      return 8;
    case "rgba16float":
      return 8;
    case "depth16unorm":
      return 2;
    case "stencil8":
      return 1;
    default:
      return 4;
  }
}
