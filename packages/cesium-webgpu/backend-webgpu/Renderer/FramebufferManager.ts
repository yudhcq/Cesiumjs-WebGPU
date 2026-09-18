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
 * T062 — `FramebufferManager` orchestration (research §6.1, tasks.md T062, FR-030).
 *
 * Upstream's manager is **pure bookkeeping over GL-free logic**: it decides *which* colour/depth
 * attachments a frame needs, keeps the multisample pairing consistent and forwards the resolve. It
 * calls no GL function itself (0 GL call sites) — which is why it is an `adapt` entry, not a
 * `replace`. The orchestration is therefore ported **verbatim**, with exactly four substitutions:
 *
 *   1. `Framebuffer` / `MultisampleFramebuffer` / `Renderbuffer` / `Texture` are the replaced,
 *      WebGPU-backed classes (relative imports, so the alias plugin keeps them in the patch layer);
 *   2. `DeveloperError` conditions keep their wording but are raised as `DiagnosticError`s, which is
 *      what every other replaced module does (they are the same caller errors, diagnosable in the
 *      same way);
 *   3. `prepareTextures` forwards to the resolve-pairing check of the replaced
 *      `MultisampleFramebuffer` and surfaces its {@link ResolveRecord} (evidence for the contract
 *      suite) instead of discarding the answer;
 *   4. the W2 placeholder's five failing entry points (`update` / `prepareTextures` / `clear` /
 *      `destroyFramebuffer` / `status`) are now real — they were the ones this task owns.
 *
 * `status` still delegates to `framebuffer.status`, which is the attachment set's completeness (see
 * `Framebuffer.ts`): WebGPU validates a pass at `beginRenderPass`, so a well-formed set reports
 * `FRAMEBUFFER_COMPLETE` and a malformed one never gets that far.
 */
import PixelFormat from "@cesium/engine/Source/Core/PixelFormat.js";
import defined from "@cesium/engine/Source/Core/defined.js";
import PixelDatatype from "@cesium/engine/Source/Renderer/PixelDatatype.js";
import RenderbufferFormat from "@cesium/engine/Source/Renderer/RenderbufferFormat.js";
import Sampler from "@cesium/engine/Source/Renderer/Sampler.js";

import { DiagnosticError } from "../webgpu/errors.js";
import Framebuffer from "./Framebuffer.js";
import MultisampleFramebuffer, { type ResolveRecord } from "./MultisampleFramebuffer.js";
import Renderbuffer from "./Renderbuffer.js";
import Texture from "./Texture.js";

const UPSTREAM_MODULE = "Renderer/FramebufferManager.js";

export interface FramebufferManagerOptions {
  readonly numSamples?: number | undefined;
  readonly colorAttachmentsLength?: number | undefined;
  readonly color?: boolean | undefined;
  readonly depth?: boolean | undefined;
  readonly depthStencil?: boolean | undefined;
  readonly supportsDepthTexture?: boolean | undefined;
  readonly createColorAttachments?: boolean | undefined;
  readonly createDepthAttachments?: boolean | undefined;
  readonly pixelDatatype?: number | undefined;
  readonly pixelFormat?: number | undefined;
}

/** A `ClearCommand`-shaped object (`clear()` swaps its framebuffer, exactly like upstream). */
interface ClearCommandLike {
  framebuffer?: unknown;
  execute(context: unknown, passState: unknown): void;
}

function callerError(entryPoint: string, message: string): DiagnosticError {
  return new DiagnosticError("internal", `FramebufferManager.${entryPoint}: ${message}`, {
    backend: "webgpu",
    upstreamModule: UPSTREAM_MODULE,
    requirementRef: "FR-030",
    entryPoint: `FramebufferManager#${entryPoint}`,
  });
}

/**
 * The replacement `FramebufferManager`.
 *
 * Upstream declares it as a plain function used with `new`; the construction shape is unchanged.
 */
export default class FramebufferManager {
  _numSamples: number;
  _colorAttachmentsLength: number;
  _color: boolean;
  _depth: boolean;
  _depthStencil: boolean;
  _supportsDepthTexture: boolean;
  _createColorAttachments: boolean;
  _createDepthAttachments: boolean;
  _pixelDatatype: number | undefined;
  _pixelFormat: number | undefined;
  _width: number | undefined;
  _height: number | undefined;
  _framebuffer: Framebuffer | undefined;
  _multisampleFramebuffer: MultisampleFramebuffer | undefined;
  _colorTextures: (Texture | undefined)[] | undefined;
  _colorRenderbuffers: (Renderbuffer | undefined)[] | undefined;
  _depthStencilRenderbuffer: Renderbuffer | undefined;
  _depthStencilTexture: Texture | undefined;
  _depthRenderbuffer: Renderbuffer | undefined;
  _depthTexture: Texture | undefined;
  _attachmentsDirty = false;
  #destroyed = false;
  #lastResolve: ResolveRecord | null = null;

  constructor(options: FramebufferManagerOptions = {}) {
    this._numSamples = options.numSamples ?? 1;
    this._colorAttachmentsLength = options.colorAttachmentsLength ?? 1;

    this._color = options.color ?? true;
    this._depth = options.depth ?? false;
    this._depthStencil = options.depthStencil ?? false;
    this._supportsDepthTexture = options.supportsDepthTexture ?? false;

    if (!this._color && !this._depth && !this._depthStencil) {
      throw callerError("constructor", "Must enable at least one type of framebuffer attachment.");
    }
    if (this._depth && this._depthStencil) {
      throw callerError("constructor", "Cannot have both a depth and depth-stencil attachment.");
    }

    this._createColorAttachments = options.createColorAttachments ?? true;
    this._createDepthAttachments = options.createDepthAttachments ?? true;

    // Upstream leaves both undefined and resolves them in `update()`; keeping them undefined is what
    // makes `isDirty`'s "pixel type changed" test meaningful.
    this._pixelDatatype = options.pixelDatatype;
    this._pixelFormat = options.pixelFormat;

    this._width = undefined;
    this._height = undefined;

    if (this._color) {
      this._colorTextures = new Array<Texture | undefined>(this._colorAttachmentsLength);
      this._colorRenderbuffers = new Array<Renderbuffer | undefined>(this._colorAttachmentsLength);
    }
  }

  /** The render framebuffer of the current pairing (the multisample one when `numSamples > 1`). */
  get framebuffer(): Framebuffer | undefined {
    if (this._numSamples > 1) return this._multisampleFramebuffer?.getRenderFramebuffer();
    return this._framebuffer;
  }

  get numSamples(): number {
    return this._numSamples;
  }

  /** Upstream `status`: the attachment set's completeness (see `Framebuffer.ts`). */
  get status(): number | undefined {
    const framebuffer = this.framebuffer;
    if (framebuffer === undefined) {
      // Upstream would throw a TypeError dereferencing `undefined.status`; failing diagnosably with
      // the same meaning ("there is no framebuffer yet") is strictly more useful.
      throw callerError("status", "there is no framebuffer yet — `update()` MUST run before `status` is read (upstream dereferences it the same way).");
    }
    return framebuffer.status;
  }

  /** The resolve record of the last `prepareTextures()` call (`null` before the first one). */
  get lastResolve(): ResolveRecord | null {
    return this.#lastResolve;
  }

  /** Upstream's dirty test, unchanged (dimension / sample count / pixel type / missing framebuffer). */
  isDirty(width: number, height: number, numSamples = 1, pixelDatatype?: number, pixelFormat?: number): boolean {
    const dimensionChanged = this._width !== width || this._height !== height;
    const samplesChanged = this._numSamples !== numSamples;
    const pixelChanged =
      (defined(pixelDatatype) && this._pixelDatatype !== pixelDatatype) || (defined(pixelFormat) && this._pixelFormat !== pixelFormat);
    const framebufferDefined = numSamples === 1 ? defined(this._framebuffer) : defined(this._multisampleFramebuffer);

    return (
      this._attachmentsDirty ||
      dimensionChanged ||
      samplesChanged ||
      pixelChanged ||
      !framebufferDefined ||
      (this._color && !defined(this._colorTextures?.[0]))
    );
  }

  /** Allocate/attach the render targets for this configuration (upstream's `update`, ported). */
  update(context: unknown, width: number, height: number, numSamples?: number, pixelDatatype?: number, pixelFormat?: number): void {
    if (!defined(width) || !defined(height)) {
      throw callerError("update", "width and height must be defined.");
    }
    if (context === undefined || context === null) {
      throw callerError("update", "a context is required (upstream reads `context.msaa` and `context.depthTexture`).");
    }
    // Upstream: `numSamples = context.msaa ? (numSamples ?? 1) : 1`.
    const resolvedSamples = (context as { msaa?: boolean }).msaa === true ? (numSamples ?? 1) : 1;
    const resolvedDatatype = pixelDatatype ?? (this._color ? (this._pixelDatatype ?? PixelDatatype.UNSIGNED_BYTE) : undefined);
    const resolvedFormat = pixelFormat ?? (this._color ? (this._pixelFormat ?? PixelFormat.RGBA) : undefined);

    if (!this.isDirty(width, height, resolvedSamples, resolvedDatatype, resolvedFormat)) return;

    // Upstream calls `destroy()` here and then rebuilds in place. The observable effect is "the
    // previous pairing's attachments are released"; `#destroyed` is *not* set, because the manager
    // stays usable — that is what the separate `#releaseAttachments()` exists for.
    this.#releaseAttachments();
    this.destroyFramebuffer();
    this._width = width;
    this._height = height;
    this._numSamples = resolvedSamples;
    this._pixelDatatype = resolvedDatatype;
    this._pixelFormat = resolvedFormat;
    this._attachmentsDirty = false;

    // ---- colour attachments --------------------------------------------------------------------
    if (this._color && this._createColorAttachments) {
      for (let index = 0; index < this._colorAttachmentsLength; index += 1) {
        this._colorTextures![index] = new Texture({
          context,
          width,
          height,
          ...(resolvedFormat === undefined ? {} : { pixelFormat: resolvedFormat }),
          ...(resolvedDatatype === undefined ? {} : { pixelDatatype: resolvedDatatype }),
          sampler: Sampler.NEAREST,
        });
        if (this._numSamples > 1) {
          const format = RenderbufferFormat.getColorFormat(resolvedDatatype ?? PixelDatatype.UNSIGNED_BYTE);
          this._colorRenderbuffers![index] = new Renderbuffer({ context, width, height, format, numSamples: this._numSamples });
        }
      }
    }

    // ---- depth-stencil -------------------------------------------------------------------------
    if (this._depthStencil && this._createDepthAttachments) {
      if (this._supportsDepthTexture && (context as { depthTexture?: boolean }).depthTexture === true) {
        this._depthStencilTexture = new Texture({
          context,
          width,
          height,
          pixelFormat: PixelFormat.DEPTH_STENCIL,
          pixelDatatype: PixelDatatype.UNSIGNED_INT_24_8,
          sampler: Sampler.NEAREST,
        });
        if (this._numSamples > 1) {
          this._depthStencilRenderbuffer = new Renderbuffer({ context, width, height, format: RenderbufferFormat.DEPTH24_STENCIL8, numSamples: this._numSamples });
        }
      } else {
        this._depthStencilRenderbuffer = new Renderbuffer({ context, width, height, format: RenderbufferFormat.DEPTH_STENCIL });
      }
    }

    // ---- depth ---------------------------------------------------------------------------------
    if (this._depth && this._createDepthAttachments) {
      if (this._supportsDepthTexture && (context as { depthTexture?: boolean }).depthTexture === true) {
        this._depthTexture = new Texture({
          context,
          width,
          height,
          pixelFormat: PixelFormat.DEPTH_COMPONENT,
          pixelDatatype: PixelDatatype.UNSIGNED_INT,
          sampler: Sampler.NEAREST,
        });
      } else {
        this._depthRenderbuffer = new Renderbuffer({ context, width, height, format: RenderbufferFormat.DEPTH_COMPONENT16 });
      }
    }

    // ---- the pairing ---------------------------------------------------------------------------
    if (this._numSamples > 1) {
      // Upstream reaches `MultisampleFramebuffer`'s "Both depth-stencil renderbuffer and texture
      // attachments must be provided" error here, because its `else` branch creates a **single-sampled**
      // depth-stencil renderbuffer — which a WebGPU pass cannot even attach next to multisampled colour
      // attachments (all attachments of a pass share one sample count). The outcome is the same failure;
      // naming the *cause* makes it actionable, and it is exactly the capability `depthTexture` that
      // slice B flips.
      if (this._depthStencil && this._createDepthAttachments && this._depthStencilTexture === undefined) {
        throw new DiagnosticError(
          "not-implemented",
          "FramebufferManager.update: a multisampled pass with a depth-stencil attachment needs a **depth-stencil texture**, and " +
            "`context.depthTexture` is false in slice A. Every attachment of a WebGPU render pass shares one sample count, so the " +
            "single-sampled fallback renderbuffer cannot be attached next to the multisampled colour attachment — which is exactly why " +
            "the depth-texture capability flip is the blocking item of slice B (tasks.md T097/T098a).",
          {
            backend: "webgpu",
            upstreamModule: UPSTREAM_MODULE,
            requirementRef: "FR-030",
            entryPoint: "FramebufferManager#update",
            plannedPhase: "slice B (T097/T098a: offscreen depth and the depthTexture capability flip)",
            extra: { numSamples: this._numSamples, supportsDepthTexture: this._supportsDepthTexture },
          },
        );
      }
      this._multisampleFramebuffer = new MultisampleFramebuffer({
        context,
        width: this._width,
        height: this._height,
        colorTextures: this._colorTextures,
        colorRenderbuffers: this._colorRenderbuffers,
        depthStencilTexture: this._depthStencilTexture,
        depthStencilRenderbuffer: this._depthStencilRenderbuffer,
        destroyAttachments: false,
      });
    } else {
      this._framebuffer = new Framebuffer({
        context,
        colorTextures: this._colorTextures,
        depthTexture: this._depthTexture,
        depthRenderbuffer: this._depthRenderbuffer,
        depthStencilTexture: this._depthStencilTexture,
        depthStencilRenderbuffer: this._depthStencilRenderbuffer,
        destroyAttachments: false,
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // attachment accessors (upstream's read/write surface, including its caller-error conditions)
  // ---------------------------------------------------------------------------------------------

  getColorTexture(index = 0): Texture | undefined {
    if (index >= this._colorAttachmentsLength) throw callerError("getColorTexture", "index must be smaller than total number of color attachments.");
    return this._colorTextures?.[index];
  }

  setColorTexture(texture: Texture | undefined, index = 0): void {
    if (this._createColorAttachments) throw callerError("setColorTexture", "createColorAttachments must be false if setColorTexture is called.");
    if (index >= this._colorAttachmentsLength) throw callerError("setColorTexture", "index must be smaller than total number of color attachments.");
    this._attachmentsDirty = texture !== this._colorTextures?.[index];
    if (this._colorTextures !== undefined) this._colorTextures[index] = texture;
  }

  getColorRenderbuffer(index = 0): Renderbuffer | undefined {
    if (index >= this._colorAttachmentsLength) throw callerError("getColorRenderbuffer", "index must be smaller than total number of color attachments.");
    return this._colorRenderbuffers?.[index];
  }

  setColorRenderbuffer(renderbuffer: Renderbuffer | undefined, index = 0): void {
    if (this._createColorAttachments) throw callerError("setColorRenderbuffer", "createColorAttachments must be false if setColorRenderbuffer is called.");
    if (index >= this._colorAttachmentsLength) throw callerError("setColorRenderbuffer", "index must be smaller than total number of color attachments.");
    this._attachmentsDirty = renderbuffer !== this._colorRenderbuffers?.[index];
    if (this._colorRenderbuffers !== undefined) this._colorRenderbuffers[index] = renderbuffer;
  }

  getDepthRenderbuffer(): Renderbuffer | undefined {
    return this._depthRenderbuffer;
  }

  setDepthRenderbuffer(renderbuffer: Renderbuffer | undefined): void {
    if (this._createDepthAttachments) throw callerError("setDepthRenderbuffer", "createDepthAttachments must be false if setDepthRenderbuffer is called.");
    this._attachmentsDirty = renderbuffer !== this._depthRenderbuffer;
    this._depthRenderbuffer = renderbuffer;
  }

  getDepthTexture(): Texture | undefined {
    return this._depthTexture;
  }

  setDepthTexture(texture: Texture | undefined): void {
    if (this._createDepthAttachments) throw callerError("setDepthTexture", "createDepthAttachments must be false if setDepthTexture is called.");
    this._attachmentsDirty = texture !== this._depthTexture;
    this._depthTexture = texture;
  }

  getDepthStencilRenderbuffer(): Renderbuffer | undefined {
    return this._depthStencilRenderbuffer;
  }

  setDepthStencilRenderbuffer(renderbuffer: Renderbuffer | undefined): void {
    if (this._createDepthAttachments) throw callerError("setDepthStencilRenderbuffer", "createDepthAttachments must be false if setDepthStencilRenderbuffer is called.");
    this._attachmentsDirty = renderbuffer !== this._depthStencilRenderbuffer;
    this._depthStencilRenderbuffer = renderbuffer;
  }

  getDepthStencilTexture(): Texture | undefined {
    return this._depthStencilTexture;
  }

  setDepthStencilTexture(texture: Texture | undefined): void {
    if (this._createDepthAttachments) throw callerError("setDepthStencilTexture", "createDepthAttachments must be false if setDepthStencilTexture is called.");
    this._attachmentsDirty = texture !== this._depthStencilTexture;
    this._depthStencilTexture = texture;
  }

  // ---------------------------------------------------------------------------------------------
  // resolve / clear / teardown
  // ---------------------------------------------------------------------------------------------

  /**
   * If using MSAA, ensure the resolve has happened (upstream's `blitFramebuffers`).
   *
   * @returns the resolve record, or `null` when the pairing is single-sampled (nothing to resolve).
   */
  prepareTextures(context: unknown, blitStencil?: boolean): ResolveRecord | null {
    if (this._numSamples > 1) {
      const multisampleFramebuffer = this._multisampleFramebuffer;
      if (multisampleFramebuffer === undefined) {
        throw callerError("prepareTextures", "the multisample pairing is missing — `update()` MUST run before `prepareTextures()`.");
      }
      this.#lastResolve = multisampleFramebuffer.blitFramebuffers(context, blitStencil);
      return this.#lastResolve;
    }
    return null;
  }

  /** Clear the managed framebuffer through the context (upstream's `clear`, ported). */
  clear(context: unknown, clearCommand: ClearCommandLike, passState: unknown): void {
    const framebuffer = clearCommand.framebuffer;
    clearCommand.framebuffer = this.framebuffer;
    clearCommand.execute(context, passState);
    clearCommand.framebuffer = framebuffer;
  }

  /** Release the framebuffer objects (the attachments stay: `destroyAttachments` is false). */
  destroyFramebuffer(): void {
    if (this._framebuffer !== undefined) {
      this._framebuffer.destroy();
      this._framebuffer = undefined;
    }
    if (this._multisampleFramebuffer !== undefined) {
      this._multisampleFramebuffer.destroy();
      this._multisampleFramebuffer = undefined;
    }
    this.#lastResolve = null;
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  /** Upstream's `destroy`, ported: release what this manager created, keep what it was handed. */
  destroy(): void {
    this.#releaseAttachments();
    this.destroyFramebuffer();
    this.#destroyed = true;
  }

  /**
   * Upstream's `destroy` body (the attachment half), extracted so `update()` can release the old
   * pairing without marking the manager destroyed.
   */
  #releaseAttachments(): void {
    if (this._color) {
      const colorTextures = this._colorTextures ?? [];
      const colorRenderbuffers = this._colorRenderbuffers ?? [];
      for (let index = 0; index < colorTextures.length; index += 1) {
        const texture = colorTextures[index];
        if (this._createColorAttachments && texture !== undefined && !texture.isDestroyed()) texture.destroy();
        if (texture !== undefined && texture.isDestroyed()) colorTextures[index] = undefined;

        const renderbuffer = colorRenderbuffers[index];
        if (this._createColorAttachments && renderbuffer !== undefined && !renderbuffer.isDestroyed()) renderbuffer.destroy();
        if (renderbuffer !== undefined && renderbuffer.isDestroyed()) colorRenderbuffers[index] = undefined;
      }
    }

    if (this._depthStencil) {
      if (this._createDepthAttachments) {
        if (this._depthStencilTexture !== undefined && !this._depthStencilTexture.isDestroyed()) this._depthStencilTexture.destroy();
        if (this._depthStencilRenderbuffer !== undefined && !this._depthStencilRenderbuffer.isDestroyed()) this._depthStencilRenderbuffer.destroy();
      }
      if (this._depthStencilTexture !== undefined && this._depthStencilTexture.isDestroyed()) this._depthStencilTexture = undefined;
      if (this._depthStencilRenderbuffer !== undefined && this._depthStencilRenderbuffer.isDestroyed()) this._depthStencilRenderbuffer = undefined;
    }

    if (this._depth) {
      if (this._createDepthAttachments) {
        if (this._depthTexture !== undefined && !this._depthTexture.isDestroyed()) this._depthTexture.destroy();
        if (this._depthRenderbuffer !== undefined && !this._depthRenderbuffer.isDestroyed()) this._depthRenderbuffer.destroy();
      }
      if (this._depthTexture !== undefined && this._depthTexture.isDestroyed()) this._depthTexture = undefined;
      if (this._depthRenderbuffer !== undefined && this._depthRenderbuffer.isDestroyed()) this._depthRenderbuffer = undefined;
    }
  }
}
