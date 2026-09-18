/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Swap chain and canvas presentation (research §5.1, data-model §4.1, tasks.md T050).
 *
 * Frame order, measured on the G-2/G-3 hardware (headless Chrome 153, adapter
 * `{vendor:"nvidia", architecture:"lovelace"}`, `preferredFormat: "bgra8unorm"`):
 *   1. `canvasContext.configure({ device, format, alphaMode, usage })` **once** per device/size;
 *   2. per frame: `canvasContext.getCurrentTexture()` → a `GPUTextureView` is the pass colour target;
 *   3. with 4× MSAA the pass attaches a **multisampled** colour texture and the swap-chain view becomes
 *      its `resolveTarget` — the pair `sampleCount: 4` + `resolveTarget` is mandatory, because WebGPU
 *      has no `blitFramebuffer`: the resolve is implicit at pass end (research §5.2);
 *   4. `endFrame` submits the command buffer; presentation is automatic (there is no `present()`).
 *
 * A canvas size or `devicePixelRatio` change invalidates the swap-chain texture and the multisample
 * attachment, so both are rebuilt; the unit test asserts the descriptor sizes follow
 * `clientWidth × devicePixelRatio` exactly.
 */
import { DiagnosticError } from "./errors.js";

/** The canvas surface this module needs (structural, so unit tests can supply a recorder). */
export interface CanvasLike {
  width: number;
  height: number;
  clientWidth?: number;
  clientHeight?: number;
  getContext(contextId: string, options?: unknown): unknown;
}

export interface SwapchainOptions {
  readonly canvas: CanvasLike;
  readonly device: GPUDevice;
  /** Defaults to `navigator.gpu.getPreferredCanvasFormat()` when available, else `bgra8unorm`. */
  readonly format?: GPUTextureFormat;
  readonly alphaMode?: GPUCanvasAlphaMode;
  /** 1 or 4 (WebGPU core guarantees 4× MSAA). */
  readonly sampleCount?: 1 | 4;
  /** Injected for determinism in tests; defaults to `globalThis.devicePixelRatio ?? 1`. */
  readonly devicePixelRatio?: () => number;
  /** Re-query window size before deciding whether to resize (injected for tests). */
  readonly resizeCanvasToDisplaySize?: (canvas: CanvasLike, dpr: number) => { width: number; height: number; changed: boolean };
}

/** One frame's pass target configuration. */
export interface FrameTargets {
  readonly colorAttachments: readonly GPURenderPassColorAttachment[];
  readonly depthStencilAttachment?: GPURenderPassDepthStencilAttachment;
}

/**
 * Compute the drawing-buffer size the way upstream's `Scene` expects it:
 * `clientWidth × devicePixelRatio`, falling back to the canvas attributes when the element has no
 * layout (offscreen / not yet attached).
 */
export function resolveDrawingBufferSize(
  canvas: CanvasLike,
  devicePixelRatio: number,
): { width: number; height: number; source: "client-size" | "canvas-attributes" } {
  const clientWidth = canvas.clientWidth ?? 0;
  const clientHeight = canvas.clientHeight ?? 0;
  if (clientWidth > 0 && clientHeight > 0) {
    return {
      width: Math.max(1, Math.floor(clientWidth * devicePixelRatio)),
      height: Math.max(1, Math.floor(clientHeight * devicePixelRatio)),
      source: "client-size",
    };
  }
  return {
    width: Math.max(1, Math.floor(canvas.width || 1)),
    height: Math.max(1, Math.floor(canvas.height || 1)),
    source: "canvas-attributes",
  };
}

export class Swapchain {
  readonly #canvas: CanvasLike;
  readonly #device: GPUDevice;
  readonly #context: GPUCanvasContext;
  readonly #format: GPUTextureFormat;
  readonly #alphaMode: GPUCanvasAlphaMode;
  readonly #sampleCount: 1 | 4;
  readonly #dpr: () => number;
  readonly #resize: ((canvas: CanvasLike, dpr: number) => { width: number; height: number; changed: boolean }) | null;

  #configured = false;
  #configureCount = 0;
  #rebuildCount = 0;
  #width = 0;
  #height = 0;
  #sizeSource: "client-size" | "canvas-attributes" = "canvas-attributes";
  #multisampleTexture: GPUTexture | null = null;
  #multisampleView: GPUTextureView | null = null;
  #frameOpen = false;
  #currentTexture: GPUTexture | null = null;
  #destroyed = false;

  constructor(options: SwapchainOptions) {
    this.#canvas = options.canvas;
    this.#device = options.device;
    this.#format = options.format ?? preferredFormat();
    this.#alphaMode = options.alphaMode ?? "opaque";
    this.#sampleCount = options.sampleCount ?? 1;
    this.#dpr = options.devicePixelRatio ?? (() => (typeof devicePixelRatio === "number" ? devicePixelRatio : 1));
    this.#resize = options.resizeCanvasToDisplaySize ?? null;
    const context = options.canvas.getContext("webgpu");
    if (context === null || context === undefined || typeof (context as GPUCanvasContext).configure !== "function") {
      throw new DiagnosticError(
        "render-failed",
        'the canvas did not return a WebGPU drawing context (`canvas.getContext("webgpu")`). The WebGPU backend ' +
          "cannot present anywhere else, and it MUST NOT fall back to a GL context inside the replacement " +
          "(plan.md D2-a: a fallback is a construction-time whole delegation, not a per-call retry).",
        { backend: "webgpu", upstreamModule: "Renderer/Context.js", requirementRef: "FR-001", entryPoint: "swapchain.constructor" },
      );
    }
    this.#context = context as GPUCanvasContext;
  }

  get format(): GPUTextureFormat {
    return this.#format;
  }

  get sampleCount(): 1 | 4 {
    return this.#sampleCount;
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  get sizeSource(): "client-size" | "canvas-attributes" {
    return this.#sizeSource;
  }

  get configureCount(): number {
    return this.#configureCount;
  }

  get rebuildCount(): number {
    return this.#rebuildCount;
  }

  /** Configure the canvas for this device (idempotent; re-issues only after a rebuild). */
  configure(): void {
    if (this.#configured) return;
    this.#context.configure({
      device: this.#device,
      format: this.#format,
      alphaMode: this.#alphaMode,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.#configured = true;
    this.#configureCount += 1;
    const { width, height, source } = resolveDrawingBufferSize(this.#canvas, this.#dpr());
    this.#width = width;
    this.#height = height;
    this.#sizeSource = source;
    this.#buildAttachments();
  }

  /** Recompute the drawing-buffer size; returns `true` when the swap-chain/render targets changed. */
  resizeIfNeeded(): boolean {
    if (this.#resize !== null) this.#resize(this.#canvas, this.#dpr());
    const { width, height, source } = resolveDrawingBufferSize(this.#canvas, this.#dpr());
    if (width === this.#width && height === this.#height && source === this.#sizeSource) return false;
    this.#width = width;
    this.#height = height;
    this.#sizeSource = source;
    this.#rebuildCount += 1;
    this.#buildAttachments();
    return true;
  }

  #buildAttachments(): void {
    // Keep the canvas attributes in sync so upstream's `drawingBufferWidth/Height` (which it reads
    // through the context) stay meaningful even when the element has no CSS layout.
    this.#canvas.width = this.#width;
    this.#canvas.height = this.#height;
    this.#multisampleTexture?.destroy();
    this.#multisampleTexture = null;
    this.#multisampleView = null;
    if (this.#sampleCount === 4) {
      this.#multisampleTexture = this.#device.createTexture({
        label: "cesium-webgpu:msaa-color",
        size: { width: this.#width, height: this.#height, depthOrArrayLayers: 1 },
        format: this.#format,
        sampleCount: 4,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.#multisampleView = this.#multisampleTexture.createView();
    }
  }

  /** Take the swap-chain texture of this frame (called from `Context.beginFrame`). */
  beginFrame(): void {
    if (this.#destroyed) {
      throw new DiagnosticError("render-failed", "swapchain: the swap chain was destroyed; the backend MUST be rebuilt (T051).", {
        backend: "webgpu",
        requirementRef: "FR-003",
        entryPoint: "swapchain.beginFrame",
      });
    }
    this.configure();
    this.resizeIfNeeded();
    this.#currentTexture = this.#context.getCurrentTexture();
    this.#frameOpen = true;
  }

  /** The multisampled colour attachment of this frame (`null` when `sampleCount === 1`). */
  multisampleView(): GPUTextureView | null {
    return this.#multisampleView;
  }

  /** The swap-chain view that receives the resolved image (the presentation target). */
  currentView(): GPUTextureView | null {
    return this.#currentTexture === null ? null : this.#currentTexture.createView();
  }

  /**
   * The colour attachment of this frame.
   *
   * With `sampleCount: 4` the attachment view is the multisampled texture and `resolveTarget` is the
   * swap-chain view; they are produced together so a caller can never set one without the other.
   */
  colorTarget(): { view: GPUTextureView; resolveTarget?: GPUTextureView } {
    if (!this.#frameOpen || this.#currentTexture === null) {
      throw new DiagnosticError(
        "internal",
        "swapchain: no frame is open. `Context.beginFrame` MUST take the swap-chain texture before any draw " +
          "(research §5.1).",
        { backend: "webgpu", requirementRef: "FR-001", entryPoint: "swapchain.colorTarget" },
      );
    }
    const resolveTarget = this.#currentTexture.createView();
    if (this.#sampleCount === 4) {
      if (this.#multisampleView === null) {
        throw new DiagnosticError("internal", "swapchain: the 4× multisample attachment is missing while sampleCount is 4.", {
          backend: "webgpu",
          requirementRef: "FR-001",
          entryPoint: "swapchain.colorTarget",
        });
      }
      return { view: this.#multisampleView, resolveTarget };
    }
    return { view: resolveTarget };
  }

  /** Frame finished: the swap-chain texture must not be used again (research §5.1). */
  endFrame(): void {
    this.#frameOpen = false;
    this.#currentTexture = null;
  }

  destroy(): void {
    this.#multisampleTexture?.destroy();
    this.#multisampleTexture = null;
    this.#multisampleView = null;
    this.#currentTexture = null;
    this.#destroyed = true;
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }
}

/** The swap-chain format: `preferredCanvasFormat` when present, else the measured `bgra8unorm`. */
export function preferredFormat(): GPUTextureFormat {
  const gpu = (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
  if (gpu !== undefined && typeof gpu.getPreferredCanvasFormat === "function") return gpu.getPreferredCanvasFormat();
  return "bgra8unorm";
}
