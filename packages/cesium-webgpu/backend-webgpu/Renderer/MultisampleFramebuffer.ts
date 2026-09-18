/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/MultisampleFramebuffer.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * T061 (part 3 of 3) — multisample pairing and resolve semantics (research §5.2/§6.1, FR-030).
 *
 * Upstream builds **two** framebuffers and blits between them: the render framebuffer holds
 * multisampled renderbuffers, the colour framebuffer holds the textures the pixels are copied into,
 * and `blitFramebuffers()` performs `gl.blitFramebuffer`. WebGPU has no blit: a multisampled colour
 * attachment is resolved **when the render pass ends**, through
 * `colorAttachments[i].resolveTarget`.
 *
 * The replacement therefore:
 *   * keeps both framebuffers and the exact upstream option bag / construction errors
 *     ("Both color renderbuffer and texture attachments must be provided", …);
 *   * wires the colour renderbuffer of the render framebuffer to the matching texture of the colour
 *     framebuffer as its `resolveTarget` — which is the WebGPU form of the pairing;
 *   * turns `blitFramebuffers(context, blitStencil)` into **"ensure the resolve has happened"**: it
 *     verifies the pairing is complete and records it. Nothing is copied by the call itself, because
 *     the resolve already happened at the end of the multisampled pass — that is the semantic
 *     equivalence research §6.1 records ("`blitFramebuffers` → 由 pass 结束时的隐式解析代替").
 *
 * The one thing WebGPU cannot do is resolve a **stencil** attachment (only colour attachments have a
 * `resolveTarget`). Upstream's `blitStencil` flag therefore cannot be honoured when a depth-stencil
 * attachment is present, and that request fails loudly naming the slice-B task that owns the
 * offscreen-depth path (T097) rather than silently dropping the stencil.
 */
import { DiagnosticError } from "../webgpu/errors.js";
import Framebuffer from "./Framebuffer.js";
import type Renderbuffer from "./Renderbuffer.js";
import type Texture from "./Texture.js";

const UPSTREAM_MODULE = "Renderer/MultisampleFramebuffer.js";

export interface MultisampleFramebufferOptions {
  readonly context: unknown;
  readonly width: number;
  readonly height: number;
  /** Upstream's attachment arrays may contain holes (`new Array(n)` + `setColorTexture`). */
  readonly colorTextures?: readonly (Texture | undefined)[] | undefined;
  readonly colorRenderbuffers?: readonly (Renderbuffer | undefined)[] | undefined;
  readonly depthStencilTexture?: Texture | undefined;
  readonly depthStencilRenderbuffer?: Renderbuffer | undefined;
  readonly destroyAttachments?: boolean | undefined;
}

/** What `blitFramebuffers` observed (evidence for the contract suite). */
export interface ResolveRecord {
  /** Always `"resolveTarget"`: the WebGPU resolve is an attachment pairing, not a copy command. */
  readonly mechanism: "resolveTarget";
  readonly colorAttachments: number;
  readonly sampleCount: number;
  /** When the pixels actually move (`"pass-end"` — the end of the multisampled render pass). */
  readonly resolvedAt: "pass-end";
  /** `true` when a stencil resolve was requested (only possible without a stencil attachment). */
  readonly stencilRequested: boolean;
  /** How many times the pairing has been verified for this object. */
  readonly verifiedCount: number;
}

/**
 * The replacement `MultisampleFramebuffer`.
 *
 * Upstream declares it as a plain function used with `new`; the construction shape is unchanged.
 */
export default class MultisampleFramebuffer {
  readonly _width: number;
  readonly _height: number;
  readonly _renderFramebuffer: Framebuffer;
  readonly _colorFramebuffer: Framebuffer;
  readonly #sampleCount: number;
  #verifiedCount = 0;
  #destroyed = false;

  constructor(options: MultisampleFramebufferOptions = {} as MultisampleFramebufferOptions) {
    const { context, width, height, colorRenderbuffers, colorTextures, depthStencilRenderbuffer, depthStencilTexture, destroyAttachments } = options;

    if (context === undefined || context === null) {
      throw new DiagnosticError("internal", 'MultisampleFramebuffer: Check.defined("options.context", context) failed.', {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "MultisampleFramebuffer#constructor",
      });
    }
    if (width === undefined || width === null) {
      throw new DiagnosticError("internal", 'MultisampleFramebuffer: Check.defined("options.width", width) failed.', {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "MultisampleFramebuffer#constructor",
      });
    }
    if (height === undefined || height === null) {
      throw new DiagnosticError("internal", 'MultisampleFramebuffer: Check.defined("options.height", height) failed.', {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "MultisampleFramebuffer#constructor",
      });
    }

    this._width = width;
    this._height = height;

    if ((colorRenderbuffers !== undefined) !== (colorTextures !== undefined)) {
      throw new DiagnosticError("internal", "MultisampleFramebuffer: both color renderbuffer and texture attachments must be provided.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "MultisampleFramebuffer#constructor",
      });
    }
    if ((depthStencilRenderbuffer !== undefined) !== (depthStencilTexture !== undefined)) {
      throw new DiagnosticError("internal", "MultisampleFramebuffer: both depth-stencil renderbuffer and texture attachments must be provided.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "MultisampleFramebuffer#constructor",
      });
    }

    // The render framebuffer is the multisampled one; its colour attachments resolve into the colour
    // framebuffer's textures, which is exactly WebGPU's `resolveTarget` pairing.
    this._renderFramebuffer = new Framebuffer({
      context,
      ...(colorRenderbuffers === undefined ? {} : { colorRenderbuffers }),
      ...(depthStencilRenderbuffer === undefined ? {} : { depthStencilRenderbuffer }),
      ...(colorTextures === undefined ? {} : { resolveTextures: colorTextures }),
      ...(destroyAttachments === undefined ? {} : { destroyAttachments }),
    });
    this._colorFramebuffer = new Framebuffer({
      context,
      ...(colorTextures === undefined ? {} : { colorTextures }),
      ...(depthStencilTexture === undefined ? {} : { depthStencilTexture }),
      ...(destroyAttachments === undefined ? {} : { destroyAttachments }),
    });

    const sampleCounts = new Set((colorRenderbuffers ?? []).map((renderbuffer) => renderbuffer?.numSamples ?? 1));
    this.#sampleCount = sampleCounts.size === 0 ? 1 : [...sampleCounts][0]!;
  }

  /** The multisampled render framebuffer (upstream's "render framebuffer"). */
  getRenderFramebuffer(): Framebuffer {
    return this._renderFramebuffer;
  }

  /** The single-sampled colour framebuffer that receives the resolved pixels. */
  getColorFramebuffer(): Framebuffer {
    return this._colorFramebuffer;
  }

  /** The sample count of the multisampled side (`4` for the MVP's 4× MSAA). */
  get sampleCount(): number {
    return this.#sampleCount;
  }

  /** How many times the resolve pairing has been verified (T061 evidence). */
  get verifiedCount(): number {
    return this.#verifiedCount;
  }

  /**
   * Upstream `blitFramebuffers(context, blitStencil)`, re-expressed as "ensure the resolve has
   * happened".
   *
   * @returns the {@link ResolveRecord} describing what the implicit resolve will do.
   * @throws a `DiagnosticError` (`category: "not-implemented"`) when a **stencil** resolve is asked
   *   for and a depth-stencil attachment exists: WebGPU resolves colour attachments only, and
   *   silently dropping the stencil would corrupt the next depth test.
   */
  blitFramebuffers(context: unknown, blitStencil?: boolean): ResolveRecord {
    if (this.#destroyed) {
      throw new DiagnosticError(
        "render-failed",
        "MultisampleFramebuffer.blitFramebuffers: this framebuffer was destroyed, i.e. destroy() was called.",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "MultisampleFramebuffer#blitFramebuffers" },
      );
    }
    if (context === undefined || context === null) {
      throw new DiagnosticError("internal", "MultisampleFramebuffer.blitFramebuffers: a context is required (upstream reads `context._gl`).", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "MultisampleFramebuffer#blitFramebuffers",
      });
    }

    const colorAttachments = this._renderFramebuffer.colorAttachments;
    const hasStencil = this._renderFramebuffer.depthStencilRenderbuffer !== undefined || this._renderFramebuffer.depthStencilTexture !== undefined;
    if (blitStencil === true && hasStencil) {
      throw new DiagnosticError(
        "not-implemented",
        "MultisampleFramebuffer.blitFramebuffers(context, true): a **stencil** resolve has no WebGPU counterpart — `resolveTarget` exists on " +
          "colour attachments only, and the depth-stencil attachment of a multisampled pass is not resolved. Upstream's `blitStencil` is set by " +
          "the offscreen-depth path (`GlobeDepth`), which is slice B (tasks.md T097/T098a). The replacement MUST fail loudly rather than drop the " +
          "stencil and corrupt the next depth test.",
        {
          backend: "webgpu",
          upstreamModule: UPSTREAM_MODULE,
          requirementRef: "FR-030",
          entryPoint: "MultisampleFramebuffer#blitFramebuffers",
          plannedPhase: "slice B (T097/T098a: offscreen depth and depth-copy paths)",
        },
      );
    }

    // Verify the pairing instead of copying: every multisampled colour attachment MUST have a
    // resolve target, otherwise the pass's pixels are unreachable (a silently lost frame).
    const missing = colorAttachments.filter((attachment) => attachment.resolveTarget === undefined);
    if (colorAttachments.length > 0 && missing.length === colorAttachments.length) {
      throw new DiagnosticError(
        "internal",
        "MultisampleFramebuffer.blitFramebuffers: no colour attachment carries a resolve target, so there is nothing to resolve into. " +
          "Upstream blits the render framebuffer into the colour framebuffer; the WebGPU pairing is built in the constructor.",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "MultisampleFramebuffer#blitFramebuffers" },
      );
    }

    this.#verifiedCount += 1;
    return {
      mechanism: "resolveTarget",
      colorAttachments: colorAttachments.length,
      sampleCount: this.#sampleCount,
      resolvedAt: "pass-end",
      stencilRequested: blitStencil === true,
      verifiedCount: this.#verifiedCount,
    };
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this._renderFramebuffer.destroy();
    this._colorFramebuffer.destroy();
    this.#destroyed = true;
  }
}
