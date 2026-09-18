/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/Framebuffer.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * T061 (part 1 of 3) — `Framebuffer` → an **attachment description set** (research §6.1,
 * data-model §5.2, FR-030).
 *
 * A WebGL framebuffer is an object you bind; a WebGPU render pass takes its attachments in the
 * descriptor. There is therefore **no object to create**: the replacement is a description of
 * "which views does a pass render into", which is exactly what the derived pass state machine needs
 * (`webgpu/pass-encoder.ts`). The class:
 *
 *   * keeps upstream's option bag and **all** of its validation (`Cannot have both color texture and
 *     color renderbuffer attachments`, `… depth and depth-stencil …`, the colour-format check, …);
 *   * keeps the read surface the logic layer uses — `status`, `numberOfColorAttachments`,
 *     `depthTexture`, `depthRenderbuffer`, `stencilRenderbuffer`, `depthStencilTexture`,
 *     `depthStencilRenderbuffer`, `hasDepthAttachment`, `getColorTexture(i)`, `getColorRenderbuffer(i)`,
 *     `_getActiveColorAttachments()`, `destroyAttachments`, `destroy()`, `isDestroyed()`;
 *   * **implements the `WebgpuFramebufferRef` contract** (`id`, `colorAttachments`,
 *     `depthStencilAttachment`, `sampleCount`) so `Context#draw`/`Context#clear` can name it through
 *     `command._framebuffer`. It registers itself with the context in the constructor, which is the
 *     WebGPU counterpart of `glBindFramebuffer` making the target reachable.
 *
 * `_bind()` / `_unBind()` / `bindDraw()` / `bindRead()` have no counterpart (there is nothing to
 * bind) and are documented no-ops; the *semantics* they carried — "this is the target of the next
 * work operation" — are carried by the pass key instead.
 *
 * `status`: upstream returns `gl.checkFramebufferStatus`, and `FramebufferManager#status` forwards it
 * to callers that compare against `WebGLConstants.FRAMEBUFFER_COMPLETE`. WebGPU validates a render
 * pass at `beginRenderPass` time instead, so the replacement answers `FRAMEBUFFER_COMPLETE` (0x8CD5)
 * as long as the attachment set is well formed, and the *real* validation is reported by the frame's
 * error scope (T052) — a fabricated "incomplete" status would be just as wrong as a fabricated
 * "complete" one, but the former would break every caller for a reason that never happened.
 */
import PixelFormat from "@cesium/engine/Source/Core/PixelFormat.js";
import PixelDatatype from "@cesium/engine/Source/Renderer/PixelDatatype.js";

import { DiagnosticError } from "../webgpu/errors.js";
import { isColorAttachmentFormat, isDepthFormat } from "../webgpu/format-map.js";
import type { WebgpuFramebufferRef } from "./Context.js";
import type Renderbuffer from "./Renderbuffer.js";
import type Texture from "./Texture.js";

const UPSTREAM_MODULE = "Renderer/Framebuffer.js";

/** `WebGLConstants.FRAMEBUFFER_COMPLETE` — the only status a WebGPU attachment set can report. */
export const FRAMEBUFFER_COMPLETE = 0x8cd5;

/** `WebGLConstants.MAX_COLOR_ATTACHMENTS`-style guard; the real limit comes from `ContextLimits`. */
const DEFAULT_MAXIMUM_COLOR_ATTACHMENTS = 8;

export interface FramebufferOptions {
  readonly context: unknown;
  /**
   * Colour textures. Declared as `(Texture | undefined)[]` because upstream's arrays come from
   * `new Array(n)` and `FramebufferManager#setColorTexture` may leave holes; a hole means "this
   * attachment point is empty", which WebGPU expresses by simply not attaching it.
   */
  readonly colorTextures?: readonly (Texture | undefined)[] | undefined;
  readonly colorRenderbuffers?: readonly (Renderbuffer | undefined)[] | undefined;
  readonly depthTexture?: Texture | undefined;
  readonly depthRenderbuffer?: Renderbuffer | undefined;
  readonly stencilRenderbuffer?: Renderbuffer | undefined;
  readonly depthStencilTexture?: Texture | undefined;
  readonly depthStencilRenderbuffer?: Renderbuffer | undefined;
  readonly destroyAttachments?: boolean | undefined;
  /**
   * Backend-only: the single-sampled textures a multisampled colour attachment resolves into.
   *
   * Upstream cannot express "MSAA renderbuffer + resolve texture on one framebuffer" because GL
   * blits between two framebuffers instead (`MultisampleFramebuffer.js:96`). WebGPU resolves inside
   * `colorAttachments[i].resolveTarget`, so the replaced `MultisampleFramebuffer` passes the pairing
   * here. The key is additive: no upstream option changes meaning.
   */
  readonly resolveTextures?: readonly (Texture | undefined)[] | undefined;
}

/** The attachment view a render pass uses, plus what the framebuffer knows about it. */
interface AttachmentEntry {
  readonly id: string;
  readonly view: GPUTextureView;
  readonly resolveTarget: GPUTextureView | undefined;
  readonly sampleCount: number;
  readonly source: "texture" | "renderbuffer";
}

let framebufferCounter = 0;

/**
 * The replacement `Framebuffer`.
 *
 * Upstream declares `Framebuffer` as a plain function used with `new`; the construction shape and
 * the option bag are unchanged.
 */
export default class Framebuffer implements WebgpuFramebufferRef {
  readonly id: string;
  readonly _context: unknown;
  readonly _colorTextures: (Texture | undefined)[] = [];
  readonly _colorRenderbuffers: (Renderbuffer | undefined)[] = [];
  readonly _activeColorAttachments: number[] = [];
  _depthTexture: Texture | undefined;
  _depthRenderbuffer: Renderbuffer | undefined;
  _stencilRenderbuffer: Renderbuffer | undefined;
  _depthStencilTexture: Texture | undefined;
  _depthStencilRenderbuffer: Renderbuffer | undefined;
  readonly destroyAttachments: boolean;
  readonly #colorAttachments: AttachmentEntry[] = [];
  readonly #depthStencilAttachment: GPURenderPassDepthStencilAttachment | undefined;
  readonly #sampleCount: number;
  #destroyed = false;

  constructor(options: FramebufferOptions = {} as FramebufferOptions) {
    const context = options.context;
    if (context === undefined || context === null) {
      throw new DiagnosticError("internal", 'Framebuffer: Check.defined("options.context", context) failed.', {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Framebuffer#constructor",
      });
    }
    this._context = context;
    this.id = `webgpu-framebuffer-${(framebufferCounter += 1)}`;
    this.destroyAttachments = options.destroyAttachments ?? true;

    // ---- upstream validation, verbatim (a texture and a renderbuffer on one point is a caller error)
    if (options.colorTextures !== undefined && options.colorRenderbuffers !== undefined) {
      throw new DiagnosticError("internal", "Framebuffer: cannot have both color texture and color renderbuffer attachments.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Framebuffer#constructor",
      });
    }
    if (options.depthTexture !== undefined && options.depthRenderbuffer !== undefined) {
      throw new DiagnosticError("internal", "Framebuffer: cannot have both a depth texture and depth renderbuffer attachment.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Framebuffer#constructor",
      });
    }
    if (options.depthStencilTexture !== undefined && options.depthStencilRenderbuffer !== undefined) {
      throw new DiagnosticError("internal", "Framebuffer: cannot have both a depth-stencil texture and depth-stencil renderbuffer attachment.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Framebuffer#constructor",
      });
    }
    const depthAttachment = options.depthTexture !== undefined || options.depthRenderbuffer !== undefined;
    const depthStencilAttachment = options.depthStencilTexture !== undefined || options.depthStencilRenderbuffer !== undefined;
    if (depthAttachment && depthStencilAttachment) {
      throw new DiagnosticError("internal", "Framebuffer: cannot have both a depth and depth-stencil attachment.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Framebuffer#constructor",
      });
    }
    if (options.stencilRenderbuffer !== undefined && depthStencilAttachment) {
      throw new DiagnosticError("internal", "Framebuffer: cannot have both a stencil and depth-stencil attachment.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Framebuffer#constructor",
      });
    }
    if (depthAttachment && options.stencilRenderbuffer !== undefined) {
      throw new DiagnosticError("internal", "Framebuffer: cannot have both a depth and stencil attachment.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Framebuffer#constructor",
      });
    }

    const maximumColorAttachments = (context as { contextLimits?: { maximumColorAttachments?: number } }).contextLimits?.maximumColorAttachments ?? DEFAULT_MAXIMUM_COLOR_ATTACHMENTS;
    const resolveTextures = options.resolveTextures;

    if (options.colorTextures !== undefined) {
      const textures = options.colorTextures;
      if (textures.length > maximumColorAttachments) {
        throw new DiagnosticError("internal", "Framebuffer: the number of color attachments exceeds the number supported.", {
          backend: "webgpu",
          upstreamModule: UPSTREAM_MODULE,
          requirementRef: "FR-030",
          entryPoint: "Framebuffer#constructor",
        });
      }
      for (let index = 0; index < textures.length; index += 1) {
        const texture = textures[index];
        if (texture === undefined) continue;
        if (!isColorAttachmentFormat(texture.pixelFormat)) {
          throw new DiagnosticError("internal", "Framebuffer: the color-texture pixel-format must be a color format.", {
            backend: "webgpu",
            upstreamModule: UPSTREAM_MODULE,
            requirementRef: "FR-030",
            entryPoint: "Framebuffer#constructor",
          });
        }
        if (texture.pixelDatatype === PixelDatatype.FLOAT && (context as { colorBufferFloat?: boolean }).colorBufferFloat !== true) {
          throw new DiagnosticError(
            "internal",
            "Framebuffer: the color texture pixel datatype is FLOAT and this context does not support it. See Context.colorBufferFloat.",
            { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Framebuffer#constructor" },
          );
        }
        if (texture.pixelDatatype === PixelDatatype.HALF_FLOAT && (context as { colorBufferHalfFloat?: boolean }).colorBufferHalfFloat !== true) {
          throw new DiagnosticError(
            "internal",
            "Framebuffer: the color texture pixel datatype is HALF_FLOAT and this context does not support it. See Context.colorBufferHalfFloat.",
            { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Framebuffer#constructor" },
          );
        }
        this._colorTextures[index] = texture;
        this._activeColorAttachments[index] = 0x8ce0 + index; // GL COLOR_ATTACHMENT0 + i
        this.#colorAttachments.push({
          id: `${this.id}:color${index}`,
          view: texture.view,
          resolveTarget: undefined,
          sampleCount: 1,
          source: "texture",
        });
      }
    }

    if (options.colorRenderbuffers !== undefined) {
      const renderbuffers = options.colorRenderbuffers;
      if (renderbuffers.length > maximumColorAttachments) {
        throw new DiagnosticError("internal", "Framebuffer: the number of color attachments exceeds the number supported.", {
          backend: "webgpu",
          upstreamModule: UPSTREAM_MODULE,
          requirementRef: "FR-030",
          entryPoint: "Framebuffer#constructor",
        });
      }
      for (let index = 0; index < renderbuffers.length; index += 1) {
        const renderbuffer = renderbuffers[index];
        if (renderbuffer === undefined) continue;
        const resolve = resolveTextures?.[index];
        if (renderbuffer.numSamples > 1 && resolve === undefined) {
          // The WebGPU MSAA rule: a multisampled colour attachment that is never resolved cannot be
          // read afterwards, and the pass would be legal while the *result* silently never appears.
          throw new DiagnosticError(
            "internal",
            `Framebuffer: colour attachment ${index} is multisampled (sampleCount ${renderbuffer.numSamples}) but no resolve target was supplied. ` +
              "In WebGPU the resolve happens through `colorAttachments[i].resolveTarget`; without it the pass's output is unreachable, " +
              "which is a silently lost frame. `MultisampleFramebuffer` supplies the pairing.",
            { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Framebuffer#constructor", extra: { index } },
          );
        }
        this._colorRenderbuffers[index] = renderbuffer;
        this._activeColorAttachments[index] = 0x8ce0 + index;
        this.#colorAttachments.push({
          id: `${this.id}:color${index}`,
          view: renderbuffer.view,
          resolveTarget: resolve?.view,
          sampleCount: renderbuffer.numSamples,
          source: "renderbuffer",
        });
      }
    }

    if (options.depthTexture !== undefined) {
      const texture = options.depthTexture;
      if (texture.pixelFormat !== PixelFormat.DEPTH_COMPONENT) {
        throw new DiagnosticError("internal", "Framebuffer: the depth-texture pixel-format must be DEPTH_COMPONENT.", {
          backend: "webgpu",
          upstreamModule: UPSTREAM_MODULE,
          requirementRef: "FR-030",
          entryPoint: "Framebuffer#constructor",
        });
      }
      this._depthTexture = texture;
      this.#depthStencilAttachment = { view: texture.view, depthLoadOp: "load", depthStoreOp: "store" };
    }
    if (options.depthRenderbuffer !== undefined) {
      this._depthRenderbuffer = options.depthRenderbuffer;
      this.#depthStencilAttachment = { view: options.depthRenderbuffer.view, depthLoadOp: "load", depthStoreOp: "store" };
    }
    if (options.stencilRenderbuffer !== undefined) {
      this._stencilRenderbuffer = options.stencilRenderbuffer;
      this.#depthStencilAttachment = { view: options.stencilRenderbuffer.view, depthLoadOp: "load", depthStoreOp: "store", stencilLoadOp: "load", stencilStoreOp: "store" };
    }
    if (options.depthStencilTexture !== undefined) {
      const texture = options.depthStencilTexture;
      if (texture.pixelFormat !== PixelFormat.DEPTH_STENCIL) {
        throw new DiagnosticError("internal", "Framebuffer: the depth-stencil pixel-format must be DEPTH_STENCIL.", {
          backend: "webgpu",
          upstreamModule: UPSTREAM_MODULE,
          requirementRef: "FR-030",
          entryPoint: "Framebuffer#constructor",
        });
      }
      this._depthStencilTexture = texture;
      this.#depthStencilAttachment = { view: texture.view, depthLoadOp: "load", depthStoreOp: "store", stencilLoadOp: "load", stencilStoreOp: "store" };
    }
    if (options.depthStencilRenderbuffer !== undefined) {
      this._depthStencilRenderbuffer = options.depthStencilRenderbuffer;
      this.#depthStencilAttachment = {
        view: options.depthStencilRenderbuffer.view,
        depthLoadOp: "load",
        depthStoreOp: "store",
        stencilLoadOp: "load",
        stencilStoreOp: "store",
      };
    }

    // A pass has exactly one sample count, so every colour attachment MUST agree.
    const colourSampleCounts = new Set(this.#colorAttachments.map((attachment) => attachment.sampleCount));
    if (colourSampleCounts.size > 1) {
      throw new DiagnosticError(
        "internal",
        `Framebuffer: the colour attachments disagree on the sample count (${[...colourSampleCounts].join(", ")}). A WebGPU render pass has one ` +
          "`sampleCount` for all of its attachments, so this framebuffer cannot be realised.",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Framebuffer#constructor" },
      );
    }
    this.#sampleCount = colourSampleCounts.size === 0 ? 1 : [...colourSampleCounts][0]!;

    // The WebGPU counterpart of `glBindFramebuffer`: making the target reachable for the command
    // path. `Context#registerTarget` stores the attachment set under `id`, which is what a command's
    // `_framebuffer`/`__webgpuTargets` names.
    const register = (context as { registerTarget?: (target: WebgpuFramebufferRef) => void }).registerTarget;
    if (typeof register === "function") register.call(context, this);
  }

  // ---------------------------------------------------------------------------------------------
  // the `WebgpuFramebufferRef` contract (Context#draw / Context#clear / the pass state machine)
  // ---------------------------------------------------------------------------------------------

  get colorAttachments(): readonly { readonly id: string; readonly view: GPUTextureView; readonly resolveTarget?: GPUTextureView; readonly clearValue?: GPUColor }[] {
    return this.#colorAttachments.map((attachment) => ({
      id: attachment.id,
      view: attachment.view,
      ...(attachment.resolveTarget === undefined ? {} : { resolveTarget: attachment.resolveTarget }),
    }));
  }

  get depthStencilAttachment(): GPURenderPassDepthStencilAttachment | undefined {
    return this.#depthStencilAttachment;
  }

  /** The pass sample count implied by the colour attachments (1 when there are none). */
  get sampleCount(): number {
    return this.#sampleCount;
  }

  // ---------------------------------------------------------------------------------------------
  // upstream read surface
  // ---------------------------------------------------------------------------------------------

  /** Upstream `status`; WebGPU validates at `beginRenderPass`, so a well-formed set is COMPLETE. */
  get status(): number {
    return FRAMEBUFFER_COMPLETE;
  }

  get numberOfColorAttachments(): number {
    return this._activeColorAttachments.length;
  }

  get depthTexture(): Texture | undefined {
    return this._depthTexture;
  }

  get depthRenderbuffer(): Renderbuffer | undefined {
    return this._depthRenderbuffer;
  }

  get stencilRenderbuffer(): Renderbuffer | undefined {
    return this._stencilRenderbuffer;
  }

  get depthStencilTexture(): Texture | undefined {
    return this._depthStencilTexture;
  }

  get depthStencilRenderbuffer(): Renderbuffer | undefined {
    return this._depthStencilRenderbuffer;
  }

  /** Upstream `hasDepthAttachment` — depth, depth-stencil, texture or renderbuffer. */
  get hasDepthAttachment(): boolean {
    return Boolean(this._depthTexture ?? this._depthRenderbuffer ?? this._depthStencilTexture ?? this._depthStencilRenderbuffer);
  }

  /** Upstream `_getActiveColorAttachments()` (the GL attachment enums, kept as-is). */
  _getActiveColorAttachments(): readonly number[] {
    return this._activeColorAttachments;
  }

  getColorTexture(index: number): Texture | undefined {
    if (index === undefined || index === null || index < 0 || index >= this._colorTextures.length) {
      throw new DiagnosticError(
        "internal",
        "Framebuffer.getColorTexture: index is required, must be greater than or equal to zero and must be less than the number of color attachments.",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Framebuffer#getColorTexture" },
      );
    }
    return this._colorTextures[index];
  }

  getColorRenderbuffer(index: number): Renderbuffer | undefined {
    if (index === undefined || index === null || index < 0 || index >= this._colorRenderbuffers.length) {
      throw new DiagnosticError(
        "internal",
        "Framebuffer.getColorRenderbuffer: index is required, must be greater than or equal to zero and must be less than the number of color attachments.",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Framebuffer#getColorRenderbuffer" },
      );
    }
    return this._colorRenderbuffers[index];
  }

  /**
   * Upstream `_bind()`. There is no framebuffer object in WebGPU — the target is named by the pass
   * descriptor — so there is nothing to bind. Documented no-op, not a silent capability loss.
   */
  _bind(): void {
    // Intentionally empty: the pass descriptor names the attachments.
  }

  /** Upstream `_unBind()`; see {@link Framebuffer#_bind}. */
  _unBind(): void {
    // Intentionally empty: a pass ends by `end()`, there is no unbind.
  }

  /** Upstream `bindDraw()` (GL `DRAW_FRAMEBUFFER`); see {@link Framebuffer#_bind}. */
  bindDraw(): void {
    // Intentionally empty.
  }

  /** Upstream `bindRead()` (GL `READ_FRAMEBUFFER`); see {@link Framebuffer#_bind}. */
  bindRead(): void {
    // Intentionally empty.
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  /**
   * Upstream `destroy()`.
   *
   * There is no GPU object of its own to release (that is the "no object counterpart" of research
   * §6.1). The attachments are released when this framebuffer owns them — upstream's
   * `destroyAttachments` flag, which both `FramebufferManager` call sites set to `false` because the
   * manager owns the pairing. The flag is honoured rather than ignored so an owning call site keeps
   * its upstream meaning.
   */
  destroy(): void {
    if (this.#destroyed) return;
    if (this.destroyAttachments) {
      for (const texture of this._colorTextures) texture?.destroy();
      for (const renderbuffer of this._colorRenderbuffers) renderbuffer?.destroy();
      this._depthTexture?.destroy();
      this._depthRenderbuffer?.destroy();
      this._stencilRenderbuffer?.destroy();
      this._depthStencilTexture?.destroy();
      this._depthStencilRenderbuffer?.destroy();
      this._depthTexture = undefined;
      this._depthRenderbuffer = undefined;
      this._stencilRenderbuffer = undefined;
      this._depthStencilTexture = undefined;
      this._depthStencilRenderbuffer = undefined;
    }
    const unregister = (this._context as { unregisterTarget?: (id: string) => void }).unregisterTarget;
    if (typeof unregister === "function") unregister.call(this._context, this.id);
    this.#destroyed = true;
  }
}
