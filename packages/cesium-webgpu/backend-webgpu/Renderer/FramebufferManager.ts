/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/FramebufferManager.js`
 * (kind: "adapt") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * SCOPE OF THIS PHASE (T043 finding; T062 owns the orchestration)
 *   `Scene` constructs a `FramebufferManager` through `InvertClassification` during construction, so a
 *   placeholder that threw would make T043's construct-time takeover impossible. Upstream's constructor
 *   is pure bookkeeping (option normalisation, attachment arrays, dirty flag) and creates **no** GPU
 *   resource, so the replacement ports that bookkeeping verbatim — including the two documented
 *   `DeveloperError` conditions and the `framebuffer`/`numSamples`/`status` accessors the logic layer
 *   reads (29 consumption sites).
 *
 *   Everything that would *allocate* render targets (`update`, `prepareTextures`, `clear`,
 *   `destroyFramebuffer`) belongs to W3: the attachment implementations are T061's (`Framebuffer` /
 *   `Renderbuffer` / `MultisampleFramebuffer`) and the orchestration is T062's. Those entry points fail
 *   loudly today, naming the owning tasks — never a silent no-op, which would present a
 *   half-initialised framebuffer as if it were ready.
 */
import { DiagnosticError } from "../webgpu/errors.js";

/** GL enums used for the option defaults (spelled numerically; no upstream import). */
const PIXEL_FORMAT_RGBA = 0x1908;
const PIXEL_DATATYPE_UNSIGNED_BYTE = 0x1401;

export interface FramebufferManagerOptions {
  numSamples?: number;
  colorAttachmentsLength?: number;
  color?: boolean;
  depth?: boolean;
  depthStencil?: boolean;
  supportsDepthTexture?: boolean;
  createColorAttachments?: boolean;
  createDepthAttachments?: boolean;
  pixelDatatype?: number;
  pixelFormat?: number;
}

function notYetImplemented(capability: string): DiagnosticError {
  return new DiagnosticError(
    "not-implemented",
    `${capability} is not implemented in this build (FramebufferManager). The framebuffer ATTACHMENT implementations ` +
      "are delivered by T061 (`Framebuffer`/`Renderbuffer`/`MultisampleFramebuffer`) and the orchestration by T062 (W3). " +
      "The manager is constructible from W2 on because the upstream `Scene` builds one during construction (T043); " +
      "allocating render targets before those land MUST fail loudly rather than return an uninitialised framebuffer.",
    { backend: "webgpu", upstreamModule: "Renderer/FramebufferManager.js", requirementRef: "FR-030", entryPoint: "FramebufferManager", plannedPhase: "W3 (T061/T062)" },
  );
}

export default class FramebufferManager {
  _numSamples: number;
  _colorAttachmentsLength: number;
  _color: boolean;
  _depth: boolean;
  _depthStencil: boolean;
  _supportsDepthTexture: boolean;
  _createColorAttachments: boolean;
  _createDepthAttachments: boolean;
  _pixelDatatype: number;
  _pixelFormat: number;
  _width: number | undefined;
  _height: number | undefined;
  _framebuffer: unknown = undefined;
  _multisampleFramebuffer: unknown = undefined;
  _colorTextures: unknown[] | undefined;
  _colorRenderbuffers: unknown[] | undefined;
  _colorRenderbuffer: unknown = undefined;
  _depthStencilRenderbuffer: unknown = undefined;
  _depthStencilTexture: unknown = undefined;
  _depthRenderbuffer: unknown = undefined;
  _depthTexture: unknown = undefined;
  _attachmentsDirty = false;

  constructor(options: FramebufferManagerOptions = {}) {
    this._numSamples = options.numSamples ?? 1;
    this._colorAttachmentsLength = options.colorAttachmentsLength ?? 1;

    this._color = options.color ?? true;
    this._depth = options.depth ?? false;
    this._depthStencil = options.depthStencil ?? false;
    this._supportsDepthTexture = options.supportsDepthTexture ?? false;

    if (!this._color && !this._depth && !this._depthStencil) {
      throw new DiagnosticError("internal", "Must enable at least one type of framebuffer attachment.", {
        backend: "webgpu",
        upstreamModule: "Renderer/FramebufferManager.js",
        requirementRef: "FR-030",
        entryPoint: "FramebufferManager#constructor",
      });
    }
    if (this._depth && this._depthStencil) {
      throw new DiagnosticError("internal", "Cannot have both a depth and depth-stencil attachment.", {
        backend: "webgpu",
        upstreamModule: "Renderer/FramebufferManager.js",
        requirementRef: "FR-030",
        entryPoint: "FramebufferManager#constructor",
      });
    }

    this._createColorAttachments = options.createColorAttachments ?? true;
    this._createDepthAttachments = options.createDepthAttachments ?? true;
    this._pixelDatatype = options.pixelDatatype ?? PIXEL_DATATYPE_UNSIGNED_BYTE;
    this._pixelFormat = options.pixelFormat ?? PIXEL_FORMAT_RGBA;

    if (this._color) {
      this._colorTextures = new Array(this._colorAttachmentsLength);
      this._colorRenderbuffers = new Array(this._colorAttachmentsLength);
    }
  }

  /** The render framebuffer of the current pairing (upstream: the multisample one when `numSamples > 1`). */
  get framebuffer(): unknown {
    if (this._numSamples > 1) return this._multisampleFramebuffer;
    return this._framebuffer;
  }

  get numSamples(): number {
    return this._numSamples;
  }

  get status(): never {
    throw notYetImplemented("FramebufferManager#status");
  }

  /** Upstream's dirty test, unchanged (dimension / sample count / pixel type / missing framebuffer). */
  isDirty(width: number, height: number, numSamples = 1, pixelDatatype?: number, pixelFormat?: number): boolean {
    const dimensionChanged = this._width !== width || this._height !== height;
    const samplesChanged = this._numSamples !== numSamples;
    const pixelChanged = (pixelDatatype !== undefined && this._pixelDatatype !== pixelDatatype) || (pixelFormat !== undefined && this._pixelFormat !== pixelFormat);
    const framebufferDefined = numSamples === 1 ? this._framebuffer !== undefined : this._multisampleFramebuffer !== undefined;
    return this._attachmentsDirty || dimensionChanged || samplesChanged || pixelChanged || !framebufferDefined;
  }

  getColorTexture(index = 0): unknown {
    return this._colorTextures?.[index];
  }

  setColorTexture(texture: unknown, index = 0): void {
    if (this._colorTextures === undefined) return;
    this._colorTextures[index] = texture;
    this._attachmentsDirty = true;
  }

  getColorRenderbuffer(index = 0): unknown {
    return this._colorRenderbuffers?.[index];
  }

  setColorRenderbuffer(renderbuffer: unknown, index = 0): void {
    if (this._colorRenderbuffers === undefined) return;
    this._colorRenderbuffers[index] = renderbuffer;
    this._attachmentsDirty = true;
  }

  getDepthRenderbuffer(): unknown {
    return this._depthRenderbuffer;
  }

  setDepthRenderbuffer(renderbuffer: unknown): void {
    this._depthRenderbuffer = renderbuffer;
    this._attachmentsDirty = true;
  }

  getDepthTexture(): unknown {
    return this._depthTexture;
  }

  setDepthTexture(texture: unknown): void {
    this._depthTexture = texture;
    this._attachmentsDirty = true;
  }

  getDepthStencilRenderbuffer(): unknown {
    return this._depthStencilRenderbuffer;
  }

  setDepthStencilRenderbuffer(renderbuffer: unknown): void {
    this._depthStencilRenderbuffer = renderbuffer;
    this._attachmentsDirty = true;
  }

  getDepthStencilTexture(): unknown {
    return this._depthStencilTexture;
  }

  setDepthStencilTexture(texture: unknown): void {
    this._depthStencilTexture = texture;
    this._attachmentsDirty = true;
  }

  /** Allocate/attach the render targets for this configuration — W3 (T061/T062). */
  update(): never {
    throw notYetImplemented("FramebufferManager#update");
  }

  /** Ensure the resolve of a multisampled pairing has happened — W3 (T061/T062). */
  prepareTextures(): never {
    throw notYetImplemented("FramebufferManager#prepareTextures");
  }

  /** Clear the managed framebuffer through the context — W3 (T061/T062). */
  clear(): never {
    throw notYetImplemented("FramebufferManager#clear");
  }

  destroyFramebuffer(): never {
    throw notYetImplemented("FramebufferManager#destroyFramebuffer");
  }

  isDestroyed(): boolean {
    return false;
  }

  destroy(): void {
    // No GPU resource was allocated while `update()` cannot run, so there is nothing to release yet.
    this._framebuffer = undefined;
    this._multisampleFramebuffer = undefined;
  }
}
