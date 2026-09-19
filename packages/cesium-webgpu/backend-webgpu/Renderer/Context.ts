/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/Context.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * WHAT THIS MODULE DOES (tasks.md T043/T044/T050/T051/T052/T053)
 *   Upstream `Scene` builds `new Context(canvas, contextOptions)` **synchronously** and immediately
 *   reads the capability flags and `ContextLimits` (research §1.3/§3). The replacement therefore:
 *
 *   1. takes the pre-fetched `{adapter, device}` from the device hand-off slot **inside the
 *      constructor, with no `await` in between** (the H-2 claim G-2 measured);
 *   2. configures the canvas, composes the capability snapshot and publishes all 23 `ContextLimits`
 *      members into the **kept** upstream module before the constructor returns (T043/T045);
 *   3. creates the 1x1 white RGBA8 default texture (`flipY:false`, clamp-to-edge/linear sampler);
 *   4. assigns a stable, unique `id` (the logic layer uses it as an index-buffer cache key,
 *      `Scene/GlobeSurfaceTile.js:495,507`);
 *   5. executes commands on **derived passes** (`webgpu/pass-encoder.ts`): the pass identity is
 *      `(colorTargets, depthStencilTarget, sampleCount, viewport, scissorRect)` and nothing else, so
 *      `Pass`/`PassState`/program/uniform/`RenderState` changes never split a pass (T044/T046);
 *   6. submits at `endFrame` and lets WebGPU present the swap-chain texture; with 4x MSAA the colour
 *      attachment is the multisampled texture and the swap-chain view is its `resolveTarget` (T050);
 *   7. collects the asynchronous GPU error channels and raises them as a diagnosable error at frame
 *      end (T052), and fails loudly for everything outside the MVP slice (T053).
 *
 * WHEN THE HAND-OFF SLOT IS EMPTY (plan.md decision D2-a)
 *   The manifest is static, so the WebGL2 implementation cannot be selected at build time. The
 *   replacement therefore performs a **one-shot, construction-time whole delegation** to the copy of
 *   the upstream WebGL2 `Context` kept at `vendor/upstream-webgl2/Context.js`. The delegated instance
 *   is the only backend alive: this constructor never mixes the two, and it never silently degrades.
 *   See `webgpu/whole-switch.ts` and W6 (T100/T101) for the runtime fallback wiring.
 */
import ContextLimits from "@cesium/engine/Source/Renderer/ContextLimits.js";
import DrawCommand from "@cesium/engine/Source/Renderer/DrawCommand.js";
import PassState from "@cesium/engine/Source/Renderer/PassState.js";
import ShaderCache from "@cesium/engine/Source/Renderer/ShaderCache.js";
import ShaderProgram from "@cesium/engine/Source/Renderer/ShaderProgram.js";
import TextureCache from "@cesium/engine/Source/Renderer/TextureCache.js";
import UniformState from "@cesium/engine/Source/Renderer/UniformState.js";
import VertexArray from "@cesium/engine/Source/Renderer/VertexArray.js";

import UpstreamWebGL2Context from "../vendor/upstream-webgl2/Context.js";
import { applyContextLimits, composeCapabilities, MVP_SLICE, type BackendCapabilities, type ContextLimitsSnapshot } from "../webgpu/capability.js";
import { createDefaultCubeMap, createDefaultTexture, type DefaultCubeMap, type DefaultTexture } from "../webgpu/default-resources.js";
import { HANDOFF_CATEGORY, peek, take, type DeviceHandoff } from "../webgpu/device-handoff.js";
import { DiagnosticError } from "../webgpu/errors.js";
import { ErrorScopeCollector, type CollectedGpuError } from "../webgpu/error-scope.js";
import { gpuResourceRegistry } from "../webgpu/gpu-resource-registry.js";
import { sliceCNotImplemented } from "../webgpu/not-implemented.js";
import { PassStateMachine, type ClearMechanism, type DerivedPassRecord, type RenderPassKey } from "../webgpu/pass-encoder.js";
import {
  assertPipelineSupported,
  clear as clearPipelineCache,
  getOrCreate as getOrCreatePipeline,
  pipelineKeyToString,
  renderStateFingerprint,
  setPipelineFactory,
  stats as pipelineCacheStatsImpl,
  vertexLayoutFingerprint,
  type PipelineCacheKey,
  type RenderStateLike,
  type VertexAttributeLike,
} from "../webgpu/pipeline-cache.js";
import { CANVAS_DEPTH_FORMAT, Swapchain, type CanvasLike } from "../webgpu/swapchain.js";
import RenderState from "./RenderState.js";
import Texture from "./Texture.js";

const UPSTREAM_MODULE = "Renderer/Context.js";

/**
 * Backend-layer payload a *draw input* carries.
 *
 * W2 cannot build pipelines from upstream GLSL (the WGSL emission front-end is W4 / T073) and cannot
 * create buffers/textures from upstream resource objects (W3 / T055-T057). Rather than skipping those
 * draws — which would produce a plausible-looking but wrong frame — the command path consumes this
 * explicit payload when it is present and throws a diagnosable `not-implemented` naming the owning
 * task when it is not. W3/W4 fill the payload from the replaced `ShaderProgram` / `VertexArray` /
 * `Texture` / `Buffer` objects; nothing else has to change here.
 */
export interface WebgpuDrawInputs {
  readonly shaderProgramId?: string;
  readonly pipeline?: GPURenderPipeline;
  readonly bindGroups?: readonly GPUBindGroup[];
  /** Dynamic offsets, index-aligned with `bindGroups` (the uniform block's per-command slot, T076). */
  readonly dynamicOffsets?: readonly number[];
  readonly vertexBuffers?: readonly { readonly slot: number; readonly buffer: GPUBuffer; readonly offset?: number; readonly size?: number }[];
  /**
   * The `GPUVertexBufferLayout`s of the bound vertex buffers (W5).
   *
   * A draw whose pipeline is built by the replaced `ShaderProgram` MUST describe the buffer it binds;
   * these come from the replaced `VertexArray` (`toGpuVertexBuffers()`), which is the only place that
   * knows the real `arrayStride`/attribute formats of the terrain geometry.
   */
  readonly gpuVertexBuffers?: readonly GPUVertexBufferLayout[];
  readonly indexBuffer?: { readonly buffer: GPUBuffer; readonly format: GPUIndexFormat; readonly offset?: number; readonly size?: number } | null;
  readonly renderState?: RenderStateLike;
  readonly topology?: string;
  readonly vertexLayout?: readonly VertexAttributeLike[];
  readonly colorFormats?: readonly string[];
  readonly depthFormat?: string | null;
  readonly sampleCount?: number;
  /** `drawIndexed` vs `draw` (upstream decides from `command.vertexArray.indexBuffer`). */
  readonly indexed?: boolean;
  readonly indexCount?: number;
  readonly vertexCount?: number;
  readonly instanceCount?: number;
  readonly firstIndex?: number;
  readonly firstVertex?: number;
}

/** A render target the backend can attach: colour views (+ resolve targets) and depth/stencil. */
export interface WebgpuFramebufferRef {
  readonly id: string;
  readonly colorAttachments: readonly { readonly id: string; readonly view: GPUTextureView; readonly resolveTarget?: GPUTextureView; readonly clearValue?: GPUColor }[];
  readonly depthStencilAttachment?: GPURenderPassDepthStencilAttachment | undefined;
  readonly sampleCount?: number | undefined;
  /**
   * The `GPUTextureFormat` of each colour attachment, in attachment order (W5).
   *
   * A pipeline's `fragment.targets[i].format` MUST equal the attachment's format, and the format is a
   * property of the attachment — not of the render state — so the target is the only place the draw
   * path can read it. The replaced `Framebuffer` publishes it (`Texture#formatMapping.format` /
   * `Renderbuffer#gpuFormat`).
   */
  readonly colorFormats?: readonly string[] | undefined;
  /** The `GPUTextureFormat` of the depth-stencil attachment, or `null` when there is none (W5). */
  readonly depthFormat?: string | null | undefined;
}

export interface ContextOptions {
  getWebGLStub?: unknown;
  requestWebgl1?: boolean;
  webgl?: Record<string, unknown>;
  allowTextureFilterAnisotropic?: boolean;
  /** Backend-only: force the slice profile (used by the tests; production uses slice A). */
  slice?: "A" | "B";
  /** Backend-only: disable the asynchronous error-scope collection (declared blind spot). */
  errorScope?: boolean;
  /**
   * Backend-only: force the canvas pass's sample count (1 or 4).
   *
   * Production always uses 4 when the adapter supports MSAA; `1` exists for the read-back suites,
   * because a multisampled depth texture cannot be copied (`webgpu/swapchain.ts` `depthTexture`).
   */
  msaaSamples?: 1 | 4;
  [key: string]: unknown;
}

interface CommandLike {
  readonly _framebuffer?: WebgpuFramebufferRef | null;
  readonly framebuffer?: WebgpuFramebufferRef | null;
  readonly __webgpu?: WebgpuDrawInputs;
  readonly __webgpuTargets?: WebgpuFramebufferRef;
  readonly renderState?: RenderStateLike;
  readonly primitiveType?: number;
  readonly count?: number;
  readonly offset?: number;
  readonly instanceCount?: number;
  /** `command.uniformMap` — the per-command uniforms (`Context.js:1440 uniformMap = uniformMap ?? drawCommand._uniformMap`). */
  readonly uniformMap?: Record<string, unknown> | null;
  readonly _uniformMap?: Record<string, unknown> | null;
  /** The replaced `VertexArray` (W3 / T060); it carries the geometry half of the draw inputs. */
  readonly vertexArray?: { readonly indexBuffer?: unknown; readonly numberOfVertices?: number; readonly __webgpu?: GeometryDrawInputs };  /**
   * The replaced `ShaderProgram` (W4 / T075) — the source of the pipeline half.
   *
   * `DrawCommand.execute` calls `context.draw(this, passState)` with no program argument
   * (`DrawCommand.js:670`), so upstream's own fallback (`Context.js:1439`) is the normal path.
   * `shaderProgram` is the public name, `_shaderProgram` the field the kept `DrawCommand` stores.
   */
  readonly shaderProgram?: { readonly __webgpu?: WebgpuDrawInputs } | null;
  readonly _shaderProgram?: { readonly __webgpu?: WebgpuDrawInputs } | null;
  readonly color?: { readonly red?: number; readonly green?: number; readonly blue?: number; readonly alpha?: number };
  readonly clearColor?: { readonly red?: number; readonly green?: number; readonly blue?: number; readonly alpha?: number };
  /** `ClearCommand.depth` / `.stencil` — present ⇒ that attachment is cleared (W5). */
  readonly depth?: number;
  readonly stencil?: number;
}

/**
 * The geometry half of the draw inputs, as the replaced `VertexArray` publishes it (T060).
 *
 * Kept structurally identical to the matching members of {@link WebgpuDrawInputs} so the two can be
 * merged without translation; the separation exists because the two halves have **different
 * owners** — geometry is W3 (T055-T060), the pipeline and bind groups are W4 (T073/T075).
 */
export interface GeometryDrawInputs {
  readonly vertexBuffers?: WebgpuDrawInputs["vertexBuffers"];
  readonly gpuVertexBuffers?: WebgpuDrawInputs["gpuVertexBuffers"];
  readonly indexBuffer?: WebgpuDrawInputs["indexBuffer"];
  readonly vertexLayout?: WebgpuDrawInputs["vertexLayout"];
  readonly indexed?: boolean;
}

interface PassStateLike {
  readonly framebuffer?: WebgpuFramebufferRef | null;
  readonly viewport?: { x?: number; y?: number; width?: number; height?: number } | undefined;
  readonly scissorTest?: boolean | undefined;
  readonly blendingEnabled?: boolean | undefined;
  readonly context?: unknown;
}

/** Per-frame counters; the contract suites read them as evidence (T044/T047/T050). */
export interface ContextCounters {
  frames: number;
  draws: number;
  clears: number;
  drawCalls: number;
  drawIndexedCalls: number;
  clearsByLoadOp: number;
  clearsByClearBuffer: number;
  passes: number;
  submittedCommandBuffers: number;
  drawsAfterStop: number;
}

let contextIdCounter = 0;

/** Stable GUID-ish id of one context: unique per construction, stable for the instance's life. */
function createContextId(): string {
  contextIdCounter += 1;
  const random = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `webgpu-context-${contextIdCounter}-${Date.now().toString(16)}-${random}`;
}

/**
 * The replacement `Context`.
 *
 * Upstream declares `Context` as a plain function used with `new`, so the replacement keeps the same
 * construction shape: `new Context(canvas, contextOptions)`.
 */
export default class Context {
  readonly canvas!: CanvasLike;
  /** Scratch object the logic layer hangs per-context data on (22 references upstream). */
  readonly cache: Record<string, unknown> = {};
  readonly id!: string;

  readonly device!: GPUDevice;
  readonly adapter!: GPUAdapter;
  readonly capabilities!: BackendCapabilities;
  readonly contextLimits!: ContextLimitsSnapshot;
  readonly slice!: "A" | "B";

  readonly uniformState!: unknown;
  readonly shaderCache!: unknown;
  readonly textureCache!: unknown;
  readonly defaultTexture!: DefaultTexture;

  readonly counters: ContextCounters = {
    frames: 0,
    draws: 0,
    clears: 0,
    drawCalls: 0,
    drawIndexedCalls: 0,
    clearsByLoadOp: 0,
    clearsByClearBuffer: 0,
    passes: 0,
    submittedCommandBuffers: 0,
    drawsAfterStop: 0,
  };

  // Upstream validation/logging switches (`Context.js:75-79`); kept so the logic layer can set them.
  validateFramebuffer = false;
  validateShaderProgram = false;
  logShaderCompilation = false;

  #swapchain!: Swapchain;
  #machine!: PassStateMachine;
  #errors!: ErrorScopeCollector;
  #encoder: GPUCommandEncoder | null = null;
  #encodedPasses: DerivedPassRecord[] = [];
  #destroyed = false;
  #submissionStopped = false;
  #frameErrorPromise: Promise<void> = Promise.resolve();
  #frameErrors: CollectedGpuError[] = [];
  #deviceLostReason: string | null = null;
  #viewportQuadVertexArray: unknown = null;
  #defaultEmissiveTexture: Texture | undefined;
  #defaultCubeMap: DefaultCubeMap | undefined;
  #defaultNormalTexture: Texture | undefined;
  #deviceLostUnsubscribe: (() => void) | null = null;
  readonly #registeredTargets = new Map<string, WebgpuFramebufferRef>();
  readonly #contextLimitsWritten!: readonly string[];

  constructor(canvas: CanvasLike, options: ContextOptions = {}) {
    if (canvas === undefined || canvas === null) {
      throw new DiagnosticError(
        "internal",
        'the replacement Context requires a canvas (`Check.defined("canvas", canvas)` upstream, Context.js:44). ' +
          "Without a canvas neither the WebGPU swap chain nor the WebGL2 delegation has a surface.",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Context#constructor" },
      );
    }
    // ---- synchronous device hand-off: the central claim of H-2 / G-2 -----------------------------
    // No `await` may sit between install() and `new Scene()`; this call happens before any capability
    // is published so every read the upstream constructor performs already sees the final value.
    const handoff: DeviceHandoff | undefined = take();
    if (handoff === undefined) {
      // ---- plan.md D2-a: construction-time WHOLE delegation to the preserved upstream WebGL2 impl --
      const Delegated = UpstreamWebGL2Context as unknown as new (canvas: unknown, options: unknown) => Context;
      const delegated = new Delegated(canvas, options ?? {});
      Object.defineProperty(delegated, "__delegatedFrom", { value: "cesium-webgpu:Renderer/Context.ts", enumerable: false });
      return delegated;
    }

    this.canvas = canvas;
    this.id = createContextId();
    this.device = handoff.device;
    this.adapter = handoff.adapter;
    this.slice = options.slice ?? MVP_SLICE;

    const composed = composeCapabilities(handoff.adapter, {
      slice: this.slice,
      limits: handoff.limits,
      features: handoff.features,
      antialias: options.webgl?.antialias !== false,
    });
    this.capabilities = composed.capabilities;
    this.contextLimits = composed.limits;
    this.#contextLimitsWritten = applyContextLimits(composed.limits, ContextLimits as unknown as Record<string, unknown>);

    // Upstream collaborators built in the constructor (kept modules: `Context.js:81-82, :335`).
    this.uniformState = new (UniformState as unknown as new () => unknown)();
    this.shaderCache = new (ShaderCache as unknown as new (context: unknown) => unknown)(this);
    this.textureCache = new (TextureCache as unknown as new () => unknown)();
    this.defaultTexture = createDefaultTexture(this.device);

    this.#swapchain = new Swapchain({
      canvas,
      device: this.device,
      sampleCount: options.msaaSamples ?? (this.capabilities.msaa === true ? 4 : 1),
      alphaMode: "opaque",
    });
    this.#swapchain.configure();

    // A new context means a new device: pipelines built for a previous device MUST NOT be reused
    // (principle II — one backend at a time, so clearing here cannot disturb a live context).
    clearPipelineCache();
    setPipelineFactory((key) => this.#createPipeline(key));
    this.#machine = new PassStateMachine({
      targets: (key) => this.#resolveTargets(key),
      openEncoder: (descriptor) => {
        const encoder = this.#encoder;
        if (encoder === null) {
          throw new DiagnosticError("internal", "Context: no command encoder is open; beginFrame MUST run first.", {
            backend: "webgpu",
            upstreamModule: UPSTREAM_MODULE,
            requirementRef: "FR-030",
            entryPoint: "Context#draw",
          });
        }
        return encoder.beginRenderPass(descriptor);
      },
    });
    this.#errors = new ErrorScopeCollector(this.device, {
      ...(options.errorScope === undefined ? {} : { enabled: options.errorScope }),
      onError: (error) => {
        this.#frameErrors.push(error);
      },
    });
    this.#installDeviceLossWatcher();
  }

  // -----------------------------------------------------------------------------------------------
  // capability flags (read synchronously by the upstream Scene constructor — G-2 check (b))
  // -----------------------------------------------------------------------------------------------
  get webgl2(): boolean {
    return this.capabilities.webgl2;
  }
  get msaa(): boolean {
    return this.capabilities.msaa;
  }
  get depthTexture(): boolean {
    return this.capabilities.depthTexture;
  }
  get fragmentDepth(): boolean {
    return this.capabilities.fragmentDepth;
  }
  get instancedArrays(): boolean {
    return this.capabilities.instancedArrays;
  }
  get drawBuffers(): boolean {
    return this.capabilities.drawBuffers;
  }
  get elementIndexUint(): boolean {
    return this.capabilities.elementIndexUint;
  }
  get stencilBuffer(): boolean {
    return this.capabilities.stencilBuffer;
  }
  get stencilBits(): number {
    return this.capabilities.stencilBits;
  }
  get textureFilterAnisotropic(): boolean {
    return this.capabilities.textureFilterAnisotropic;
  }
  get supportsBasis(): boolean {
    return this.capabilities.supportsBasis;
  }
  get colorBufferFloat(): boolean {
    return this.capabilities.colorBufferFloat;
  }
  get colorBufferHalfFloat(): boolean {
    return this.capabilities.colorBufferHalfFloat;
  }
  get floatingPointTexture(): boolean {
    return this.capabilities.floatingPointTexture;
  }
  get halfFloatingPointTexture(): boolean {
    return this.capabilities.halfFloatingPointTexture;
  }
  get textureFloatLinear(): boolean {
    return this.capabilities.textureFloatLinear;
  }
  get textureHalfFloatLinear(): boolean {
    return this.capabilities.textureHalfFloatLinear;
  }
  get standardDerivatives(): boolean {
    return this.capabilities.standardDerivatives;
  }
  get blendMinmax(): boolean {
    return this.capabilities.blendMinmax;
  }
  get vertexArrayObject(): boolean {
    return this.capabilities.vertexArrayObject;
  }
  get antialias(): boolean {
    return this.capabilities.antialias;
  }
  get s3tc(): boolean {
    return this.capabilities.s3tc;
  }
  get pvrtc(): boolean {
    return this.capabilities.pvrtc;
  }
  get astc(): boolean {
    return this.capabilities.astc;
  }
  get etc(): boolean {
    return this.capabilities.etc;
  }
  get etc1(): boolean {
    return this.capabilities.etc1;
  }
  get bc7(): boolean {
    return this.capabilities.bc7;
  }

  get drawingBufferWidth(): number {
    return this.#swapchain.width;
  }
  get drawingBufferHeight(): number {
    return this.#swapchain.height;
  }

  /** Names of the `ContextLimits` backing fields published during construction (evidence). */
  get contextLimitsWritten(): readonly string[] {
    return this.#contextLimitsWritten;
  }

  /** The pass sequence of the last completed frame (T047 evidence). */
  lastFramePasses(): readonly DerivedPassRecord[] {
    return this.#encodedPasses.map((pass) => ({ ...pass, workOps: pass.workOps.map((op) => ({ ...op })) }));
  }

  /** GPU problems collected during the last frame (empty on a healthy frame). */
  frameErrors(): readonly CollectedGpuError[] {
    return this.#frameErrors.map((error) => ({ ...error }));
  }

  /** `device.lost` reason once the device has been lost, else `null`. */
  get deviceLostReason(): string | null {
    return this.#deviceLostReason;
  }

  /** The swap-chain format the canvas was configured with (evidence for the descriptor assertions). */
  get swapchainFormat(): GPUTextureFormat {
    return this.#swapchain.format;
  }

  /** `4` when the 4x MSAA attachment is in use, else `1`. */
  get sampleCount(): 1 | 4 {
    return this.#swapchain.sampleCount;
  }

  // -----------------------------------------------------------------------------------------------
  // frame lifecycle (research §5.1)
  // -----------------------------------------------------------------------------------------------

  /**
   * Start a frame: take the swap-chain texture, create the command encoder, open the error scopes and
   * reset the derived pass state machine.
   */
  beginFrame(): void {
    this.#assertAlive("beginFrame");
    this.#errors.beginFrame();
    this.#swapchain.beginFrame();
    this.#encoder = this.device.createCommandEncoder({ label: `cesium-webgpu:frame-${this.counters.frames}` });
    this.#frameErrors = [];
    this.#machine.beginFrame();
    // The ledger's frame stamp is what makes the leak assertion a plain set comparison (T063).
    gpuResourceRegistry.setFrame(this.counters.frames);
    this.counters.frames += 1;
  }

  /** The frame counter (`ShaderProgram` uses it to rewind its uniform ring exactly once per frame). */
  get frameNumber(): number {
    return this.counters.frames;
  }

  /**
   * The canvas depth-stencil texture of this frame (diagnostics / depth read-back).
   *
   * Only copyable while `sampleCount === 1` (see `ContextOptions.msaaSamples`).
   */
  canvasDepthTexture(): GPUTexture | null {
    return this.#swapchain.depthTexture();
  }

  /**
   * Close the pass, finish the command buffer and submit it. Presentation is automatic in WebGPU.
   *
   * The signature stays **synchronous**, exactly like upstream (`Scene/Scene.js:4597` calls it without
   * awaiting). The asynchronous error scopes are drained right after the submit; the resulting
   * rejection is available through {@link awaitFrameErrors} and the collected problems are kept in
   * {@link frameErrors}, so a broken frame is never silently accepted (T052).
   */
  endFrame(): void {
    this.#assertAlive("endFrame");
    this.#machine.endFrame();
    this.#encodedPasses = [...this.#machine.sequence().passes];
    this.counters.passes += this.#encodedPasses.length;
    const encoder = this.#encoder;
    if (encoder === null) {
      throw new DiagnosticError("internal", "Context.endFrame: no command encoder is open (beginFrame was not called).", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Context#endFrame",
      });
    }
    const commandBuffer = encoder.finish();
    if (!this.#submissionStopped) {
      this.device.queue.submit([commandBuffer]);
      this.counters.submittedCommandBuffers += 1;
    }
    this.#encoder = null;
    this.#swapchain.endFrame();
    this.#frameErrorPromise = this.#errors.endFrame();
    // Never let the rejection escape as an unhandled rejection: awaitFrameErrors() re-raises it.
    this.#frameErrorPromise.catch(() => undefined);
  }

  /**
   * Resolve when the frame's error scopes have been drained; **rejects** with the diagnosable error
   * when the frame produced a validation / out-of-memory / internal problem (T052).
   */
  async awaitFrameErrors(): Promise<void> {
    await this.#frameErrorPromise;
  }

  // -----------------------------------------------------------------------------------------------
  // command dispatch (research §5.1/§5.2, T044)
  // -----------------------------------------------------------------------------------------------

  /**
   * Execute one draw command on the derived pass its target identity selects.
   *
   * @throws a `DiagnosticError` when the command carries no backend draw inputs yet (the WGSL
   *   front-end is W4 / T073, the resource layer is W3 / T055-T060). Skipping the draw silently is
   *   forbidden: the frame would look plausible while drawing nothing (FR-033).
   */
  draw(command: CommandLike, passState: PassStateLike, program?: unknown, uniformMap?: unknown): void {
    this.#assertAlive("draw");
    if (this.#submissionStopped) {
      this.counters.drawsAfterStop += 1;
      throw new DiagnosticError(
        "device-lost",
        "Context.draw: submission has stopped (the device was lost and the whole switch is running). A draw MUST NOT " +
          "reach either backend while the switch runs (FR-006, data-model §2.4 `residualDraws === 0`).",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-006", entryPoint: "Context#draw" },
      );
    }
    const inputs = resolveDrawInputs(command, program);
    const renderState = (inputs.renderState ?? command.renderState ?? EMPTY_RENDER_STATE) as RenderStateLike;
    assertPipelineSupported(renderState);

    // Upstream `Context.continueDraw` calls `shaderProgram._setUniforms(uniformMap, uniformState)` and
    // then binds the uniform buffer (`Context.js:1440,1444`). Without the first call the uniform block is
    // never written and every vertex is clipped: the first W5 terrain frame had 98 healthy draw calls,
    // zero validation errors and not one painted pixel (FR-033 — a plausible frame that draws nothing).
    const programLike = (program ?? command.shaderProgram ?? command._shaderProgram) as
      | {
          __webgpu?: WebgpuDrawInputs;
          _setUniforms?: (uniformMap: unknown, uniformState: unknown, validate?: boolean) => void;
          uniformDynamicOffset?: number;
          createPipeline?: (request: unknown) => GPURenderPipeline;
          pipeline?: GPURenderPipeline;
        }
      | undefined;
    if (programLike !== undefined && typeof programLike._setUniforms === "function") {
      programLike._setUniforms((uniformMap ?? command.uniformMap ?? command._uniformMap) ?? null, this.uniformState);
    }
    const programInputs = programLike?.__webgpu;
    const bindGroups = programInputs?.bindGroups ?? inputs.bindGroups ?? [];
    const dynamicOffsets = programInputs?.dynamicOffsets ?? inputs.dynamicOffsets ?? [];

    const target = resolveTarget(command, passState);
    const viewport = viewportOf(renderState, passState, this.#swapchain);
    const scissor = scissorOf(renderState, passState);
    const key: RenderPassKey = {
      colorTargets: target === null ? ["swapchain"] : [target.id],
      depthStencilTarget: target === null || target.depthStencilAttachment === undefined ? null : `${target.id}:depth`,
      sampleCount: target?.sampleCount ?? this.#swapchain.sampleCount,
      viewport,
      scissorRect: scissor,
    };

    const work = this.#machine.beginWork(key, {
      kind: "draw",
      seq: this.counters.draws + 1,
      drawKind: inputs.indexed === true ? "drawIndexed" : "draw",
    });
    const encoder = work.encoder;

    const pipeline = this.#pipelineFor(inputs, renderState, target, programLike, passState);
    encoder.setPipeline(pipeline);
    for (const [index, group] of bindGroups.entries()) {
      const offset = dynamicOffsets[index];
      if (offset === undefined) encoder.setBindGroup(index, group);
      else encoder.setBindGroup(index, group, [offset]);
    }
    for (const binding of inputs.vertexBuffers ?? []) {
      if (binding.size === undefined) encoder.setVertexBuffer(binding.slot, binding.buffer, binding.offset ?? 0);
      else encoder.setVertexBuffer(binding.slot, binding.buffer, binding.offset ?? 0, binding.size);
    }
    if (inputs.indexBuffer !== undefined && inputs.indexBuffer !== null) {
      encoder.setIndexBuffer(inputs.indexBuffer.buffer, inputs.indexBuffer.format, inputs.indexBuffer.offset ?? 0, inputs.indexBuffer.size);
    }
    encoder.setViewport(viewport[0], viewport[1], viewport[2], viewport[3], 0, 1);
    if (scissor !== null) encoder.setScissorRect(scissor[0], scissor[1], scissor[2], scissor[3]);
    // `stencilTest.reference` is NOT pipeline state in WebGPU (research §5.3): it is command state.
    const reference = (renderState.stencilTest as { reference?: number } | undefined)?.reference ?? 0;
    encoder.setStencilReference(reference);

    // Upstream encodes "not an instanced draw" as `instanceCount === 0`
    // (`Renderer/DrawCommand.js:89` defaults `_instanceCount` to 0; `Context.js:1367,1390` dispatch to
    // `gl.drawElements`/`gl.drawArrays`, i.e. **one** instance). WebGPU has no such encoding:
    // `drawIndexed(count, 0, …)` draws **nothing at all** — and it is not a validation error, Chrome
    // only warns "calling Draw with an instance count of 0 is unusual". Forwarding the upstream value
    // therefore produced the W5 black frame: 98 successful `drawIndexed` calls, zero validation errors,
    // zero fragments (measured with the terrain raster probe, `artifacts/terrain-raster-probe/`).
    // The translation is upstream's own: 0 (or absent) ⇒ 1 instance, a positive value ⇒ that count.
    const instanceCount = instanceCountFromUpstream(inputs.instanceCount ?? command.instanceCount);
    if (inputs.indexed === true) {
      encoder.drawIndexed(inputs.indexCount ?? command.count ?? 0, instanceCount, inputs.firstIndex ?? command.offset ?? 0, 0, 0);
      this.counters.drawIndexedCalls += 1;
    } else {
      encoder.draw(inputs.vertexCount ?? command.count ?? 0, instanceCount, inputs.firstVertex ?? command.offset ?? 0, 0);
      this.counters.drawCalls += 1;
    }
    this.counters.draws += 1;
  }

  /** Execute one clear command. Returns the clear mechanism the state machine used (T044 evidence). */
  clear(command: CommandLike, passState: PassStateLike): ClearMechanism {
    this.#assertAlive("clear");
    if (this.#submissionStopped) {
      this.counters.drawsAfterStop += 1;
      return "loadOp";
    }
    const target = resolveTarget(command, passState);
    const renderState = (command.renderState ?? EMPTY_RENDER_STATE) as RenderStateLike;
    const viewport = viewportOf(renderState, passState, this.#swapchain);
    const scissor = scissorOf(renderState, passState);
    const color = command.color ?? command.clearColor;
    const clearValue: GPUColor = color === undefined ? { r: 0, g: 0, b: 0, a: 0 } : { r: color.red ?? 0, g: color.green ?? 0, b: color.blue ?? 0, a: color.alpha ?? 0 };
    // Upstream's `ClearCommand` names the attachment(s) to clear (`color` / `depth` / `stencil` are
    // independent), and the pass machine MUST clear exactly those: a depth-only clear that also cleared
    // the colour attachment erased a whole terrain frame in W5 (transparent black, 7 draws, no error).
    const clearColor = color !== undefined;
    const clearDepthStencil = command.depth !== undefined || command.stencil !== undefined;
    const key: RenderPassKey = {
      colorTargets: target === null ? ["swapchain"] : [target.id],
      depthStencilTarget: target === null || target.depthStencilAttachment === undefined ? null : `${target.id}:depth`,
      sampleCount: target?.sampleCount ?? this.#swapchain.sampleCount,
      viewport,
      scissorRect: scissor,
    };
    // The state machine owns the mechanism: `loadOp` when the clear opens the pass, the runtime's
    // native `clearBuffer` when it exists, else a GPU-pass reopen that keeps the derived pass intact.
    const work = this.#machine.beginWork(key, { kind: "clear", seq: this.counters.clears + 1, clearValue, clearColor, clearDepthStencil });
    const mechanism = work.clearMechanism ?? "loadOp";
    if (mechanism === "loadOp") this.counters.clearsByLoadOp += 1;
    else this.counters.clearsByClearBuffer += 1;
    this.counters.clears += 1;
    return mechanism;
  }

  /**
   * Create the upstream `DrawCommand` for a full-screen viewport quad (`Context.js:1625`).
   *
   * The API lands here; its two dependencies do not yet: the vertex array is built from the replaced
   * `VertexArray`/`Buffer` (W3 / T060) and the program from the replaced `ShaderProgram` (W4 / T075).
   * Both raise a diagnosable `not-implemented` today, which is why this method never returns a
   * half-built command.
   */
  createViewportQuadCommand(fragmentShaderSource: unknown, options: ViewportQuadOptions = {}): DrawCommand {
    this.#assertAlive("createViewportQuadCommand");
    const program = (ShaderProgram as unknown as { fromCache: (options: unknown) => unknown }).fromCache({
      context: this,
      vertexShaderSource: options.vertexShaderSource ?? VIEWPORT_QUAD_DEFAULT_VS,
      fragmentShaderSource,
      attributeLocations: options.attributeLocations ?? { position: 0 },
    });
    return new (DrawCommand as unknown as new (options?: unknown) => DrawCommand)({
      vertexArray: this.getViewportQuadVertexArray(),
      shaderProgram: program,
      uniformMap: options.uniformMap ?? {},
      pass: 0,
      owner: options.owner,
      renderState: (RenderState as unknown as { fromCache: (options?: unknown) => unknown }).fromCache({}),
    });
  }

  /** The cached viewport-quad vertex array (built through the replaced `VertexArray`, W3 / T060). */
  getViewportQuadVertexArray(): unknown {
    this.#assertAlive("getViewportQuadVertexArray");
    if (this.#viewportQuadVertexArray === null) {
      this.#viewportQuadVertexArray = (VertexArray as unknown as { fromGeometry: (options: unknown) => unknown }).fromGeometry({
        context: this,
        attributes: VIEWPORT_QUAD_ATTRIBUTES,
        indexBuffer: VIEWPORT_QUAD_INDICES,
      });
    }
    return this.#viewportQuadVertexArray;
  }

  // -----------------------------------------------------------------------------------------------
  // slice-C surface: explicit, diagnosable failures (T053)
  // -----------------------------------------------------------------------------------------------
  readPixels(): Promise<never> {
    return Promise.reject(sliceCNotImplemented("readPixels"));
  }
  readPixelsToPBO(): Promise<never> {
    return Promise.reject(sliceCNotImplemented("readPixelsToPBO"));
  }
  createPickId(): never {
    throw sliceCNotImplemented("createPickId");
  }
  getObjectByPickColor(): never {
    throw sliceCNotImplemented("getObjectByPickColor");
  }

  /**
   * The 1×1-per-face white cube-map placeholder upstream publishes (`Context.js` `defaultCubeMap`).
   *
   * `Renderer/UniformState.js:1558-1559` reads it on **every** frame
   * (`this._environmentMap = frameState.environmentMap ?? frameState.context.defaultCubeMap`), and
   * that module is byte-identical upstream, so the terrain MVP cannot render a single frame without
   * it. The `CubeMap` **class** stays a slice-C stub — this is the default resource only, and it is a
   * real six-face cube texture, so a shader that samples it gets upstream's exact white value.
   */
  get defaultCubeMap(): DefaultCubeMap {
    this.#assertAlive("defaultCubeMap");
    this.#defaultCubeMap ??= createDefaultCubeMap(this.device);
    return this.#defaultCubeMap;
  }

  /**
   * A 1×1 RGB texture initialised to `[0, 0, 0]` — the "not emissive" placeholder (T056).
   *
   * Upstream creates it lazily on first access; the same laziness is kept so a scene that never
   * touches it never allocates one.
   */
  get defaultEmissiveTexture(): Texture {
    this.#assertAlive("defaultEmissiveTexture");
    this.#defaultEmissiveTexture ??= new Texture({
      context: this,
      pixelFormat: PIXEL_FORMAT_RGB,
      source: { width: 1, height: 1, arrayBufferView: new Uint8Array([0, 0, 0]) },
      flipY: false,
    });
    return this.#defaultEmissiveTexture;
  }

  /**
   * A 1×1 RGB texture initialised to `[128, 128, 255]` — the tangent-space normal pointing at +Z
   * (T056).
   */
  get defaultNormalTexture(): Texture {
    this.#assertAlive("defaultNormalTexture");
    this.#defaultNormalTexture ??= new Texture({
      context: this,
      pixelFormat: PIXEL_FORMAT_RGB,
      source: { width: 1, height: 1, arrayBufferView: new Uint8Array([128, 128, 255]) },
      flipY: false,
    });
    return this.#defaultNormalTexture;
  }
  get defaultFramebuffer(): undefined {
    // The default framebuffer IS the swap chain; upstream's `defaultFramebuffer` object has no
    // counterpart, and `undefined` is the documented "use the canvas" value upstream also produces.
    return undefined;
  }
  get debugShaders(): boolean {
    return false;
  }
  get throwOnWebGLError(): boolean {
    return false;
  }

  // -----------------------------------------------------------------------------------------------
  // teardown and device loss (T051)
  // -----------------------------------------------------------------------------------------------

  /** Stop accepting draws (the first step of a whole switch). */
  stopSubmitting(): void {
    this.#submissionStopped = true;
  }

  /** Number of draws that reached this context after `stopSubmitting()` (MUST stay 0 — FR-006). */
  get residualDraws(): number {
    return this.counters.drawsAfterStop;
  }

  /** Number of GPU resources this context owns and releases on `destroy()` (whole-switch evidence). */
  get liveResourceCount(): number {
    if (this.#destroyed) return 0;
    // The swap-chain/MSAA attachment(s) + the default texture + the lazily created placeholders +
    // every registered render target.
    return (
      (this.#swapchain.isDestroyed() ? 0 : 1) +
      1 +
      (this.#defaultCubeMap === undefined ? 0 : 1) +
      (this.#defaultEmissiveTexture === undefined ? 0 : 1) +
      (this.#defaultNormalTexture === undefined ? 0 : 1) +
      this.#registeredTargets.size
    );
  }

  /**
   * The FR-017 graphics-memory proxy of the live ledger (T063).
   *
   * Every replaced resource class registers what it creates in `gpuResourceRegistry`, so this is the
   * same number the resource suites assert on — the context only exposes it.
   */
  get gpuResourceStats(): ReturnType<typeof gpuResourceRegistry.stats> {
    return gpuResourceRegistry.stats();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#submissionStopped = true;
    this.#machine.endFrame();
    this.#deviceLostUnsubscribe?.();
    this.#deviceLostUnsubscribe = null;
    this.#errors.destroy();
    this.#swapchain.destroy();
    this.defaultTexture.destroy();
    this.#defaultCubeMap?.destroy();
    this.#defaultCubeMap = undefined;
    this.#defaultEmissiveTexture?.destroy();
    this.#defaultEmissiveTexture = undefined;
    this.#defaultNormalTexture?.destroy();
    this.#defaultNormalTexture = undefined;
    clearPipelineCache();
    setPipelineFactory(null);
    this.#encoder = null;
    this.#registeredTargets.clear();
    this.#destroyed = true;
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  /** Register a render target so commands can name it (`Framebuffer` registers itself in W3/T061). */
  registerTarget(target: WebgpuFramebufferRef): void {
    this.#registeredTargets.set(target.id, target);
  }

  /** Forget a render target (the replaced `Framebuffer#destroy` calls this). */
  unregisterTarget(id: string): void {
    this.#registeredTargets.delete(id);
  }

  /** Resolve the pipeline for one draw; always through the cache so hits/misses are counted (T048). */
  #pipelineFor(inputs: WebgpuDrawInputs, renderState: RenderStateLike, target: WebgpuFramebufferRef | null, program?: unknown, passState?: PassStateLike): GPURenderPipeline {
    const colorFormats = inputs.colorFormats ?? target?.colorFormats ?? [this.#swapchain.format];
    const depthFormat =
      inputs.depthFormat !== undefined
        ? inputs.depthFormat
        : target !== null && target.depthFormat !== undefined
          ? target.depthFormat
          : target === null
            ? CANVAS_DEPTH_FORMAT
            : target.depthStencilAttachment === undefined
              ? null
              : CANVAS_DEPTH_FORMAT;
    const sampleCount = inputs.sampleCount ?? target?.sampleCount ?? this.#swapchain.sampleCount;
    const key: PipelineCacheKey = {
      shaderProgramId: inputs.shaderProgramId ?? "anonymous",
      renderStateFingerprint: renderStateFingerprint(renderState),
      vertexLayoutFingerprint: vertexLayoutFingerprint(inputs.vertexLayout ?? []),
      topology: inputs.topology ?? "triangle-list",
      colorFormats,
      depthFormat,
      sampleCount,
    };
    // The pipeline half belongs to the replaced `ShaderProgram` (W4/T075): it owns the emitted WGSL
    // modules and the pipeline cache key, and `ShaderProgram#createPipeline` is the documented seam
    // (`ShaderProgram.ts` `ProgramPipelineRequest`). The first W5 terrain frame measured what happens
    // without this call: the program never built a pipeline, so every tile draw was refused.
    const programLike = program as
      | { __webgpu?: WebgpuDrawInputs; createPipeline?: (request: unknown) => GPURenderPipeline; pipeline?: GPURenderPipeline }
      | undefined;
    const provided = inputs.pipeline ?? (programLike === undefined ? undefined : programLike.pipeline);
    if (provided !== undefined) {
      return getOrCreatePipeline(key, () => provided).pipeline as GPURenderPipeline;
    }
    if (programLike !== undefined && typeof programLike.createPipeline === "function") {
      return programLike.createPipeline({
        renderState,
        passState: passState ?? null,
        vertexLayout: inputs.vertexLayout ?? [],
        ...(inputs.gpuVertexBuffers === undefined ? {} : { vertexBuffers: inputs.gpuVertexBuffers }),
        topology: key.topology,
        colorFormats,
        depthFormat,
        sampleCount,
      });
    }
    throw new DiagnosticError(
      "not-implemented",
      `Context: a render pipeline is required for cache key [${pipelineKeyToString(key)}] but the command names neither a pipeline nor a ` +
        "replaced `ShaderProgram` that can build one. Skipping the draw would silently draw nothing while the frame looks plausible (FR-033).",
      { backend: "webgpu", upstreamModule: "Renderer/ShaderProgram.js", requirementRef: "FR-030", entryPoint: "Context#pipelineFor" },
    );
  }

  #createPipeline(key: PipelineCacheKey): GPURenderPipeline {
    // A cache miss without a payload cannot be satisfied: W4 (T073/T075) builds pipelines from the
    // WGSL front-end and passes them with the draw. Guessing one would silently draw the wrong shader.
    throw new DiagnosticError(
      "not-implemented",
      `Context: a render pipeline is required for cache key [${pipelineKeyToString(key)}] but no pipeline descriptor was ` +
        "supplied with the draw. WGSL emission and the replaced `ShaderProgram` land in W4 (T073/T075); the pipeline cache " +
        "(T048) only stores what the front-end builds. Returning any pipeline here would silently draw the wrong shader (FR-033).",
      { backend: "webgpu", upstreamModule: "Renderer/ShaderProgram.js", requirementRef: "FR-030", entryPoint: "Context#createPipeline", plannedPhase: "W4 (T073/T075)" },
    );
  }

  #installDeviceLossWatcher(): void {
    const lost = this.device.lost;
    if (lost === undefined || lost === null || typeof lost.then !== "function") return;
    let cancelled = false;
    void lost.then((info: GPUDeviceLostInfo) => {
      if (cancelled) return;
      this.#deviceLostReason = info?.reason ?? "unknown";
      this.#submissionStopped = true;
    });
    this.#deviceLostUnsubscribe = () => {
      cancelled = true;
    };
  }

  #assertAlive(entryPoint: string): void {
    if (this.#destroyed) {
      throw new DiagnosticError("render-failed", `Context.${entryPoint}: the context was destroyed. The backend MUST be rebuilt (T051).`, {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-003",
        entryPoint: `Context#${entryPoint}`,
      });
    }
  }

  /** Attachments for a derived pass key: the swap chain, or an explicitly registered target. */
  #resolveTargets(key: RenderPassKey): { colorAttachments: GPURenderPassColorAttachment[]; depthStencilAttachment?: GPURenderPassDepthStencilAttachment } {
    const target = this.#registeredTargets.get(key.colorTargets[0] ?? "swapchain");
    if (target !== undefined) {
      return {
        colorAttachments: target.colorAttachments.map((attachment) => ({
          view: attachment.view,
          ...(attachment.resolveTarget === undefined ? {} : { resolveTarget: attachment.resolveTarget }),
          ...(attachment.clearValue === undefined ? {} : { clearValue: attachment.clearValue }),
          loadOp: "load",
          storeOp: "store",
        })),
        ...(target.depthStencilAttachment === undefined ? {} : { depthStencilAttachment: target.depthStencilAttachment }),
      };
    }
    if (key.colorTargets[0] !== "swapchain") {
      throw new DiagnosticError(
        "internal",
        `Context: no registered render target "${key.colorTargets[0]}". Offscreen attachments arrive with the framebuffer ` +
          "attachment implementations (T061/T097); until then an unknown target MUST fail loudly instead of drawing into the canvas.",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Context#resolveTargets" },
      );
    }
    const color = this.#swapchain.colorTarget();
    const depth = this.#swapchain.depthStencilTarget();
    return {
      colorAttachments: [
        {
          view: color.view,
          ...(color.resolveTarget === undefined ? {} : { resolveTarget: color.resolveTarget }),
          loadOp: "load",
          storeOp: "store",
        },
      ],
      // Upstream's GL default framebuffer always carries depth+stencil; the canvas pass does too, so a
      // terrain command's `depthTest.enabled` render state has an attachment to test against.
      ...(depth === null
        ? {}
        : {
            depthStencilAttachment: {
              view: depth.view,
              depthClearValue: 1,
              depthLoadOp: "clear" as const,
              depthStoreOp: "store" as const,
              stencilClearValue: 0,
              stencilLoadOp: "clear" as const,
              stencilStoreOp: "store" as const,
            },
          }),
    };
  }
}

/** Extra options of `createViewportQuadCommand` (upstream passes them through from `GlobeDepth`). */
export interface ViewportQuadOptions {
  readonly vertexShaderSource?: unknown;
  readonly attributeLocations?: Record<string, number>;
  readonly uniformMap?: Record<string, unknown>;
  readonly owner?: unknown;
}

const EMPTY_RENDER_STATE: RenderStateLike = {};

/**
 * Upstream's `instanceCount` encoding → the count WebGPU needs.
 *
 * Upstream `Renderer/DrawCommand.js:89` defaults `_instanceCount` to **0** and
 * `Renderer/Context.js:1367,1390` treats `0` as "a plain, non-instanced draw" (`gl.drawElements` /
 * `gl.drawArrays` draw exactly one instance). `GPURenderPassEncoder.drawIndexed(count, 0, …)` draws
 * nothing, so the value MUST be translated — this is the one place the two encodings differ, and
 * passing it through verbatim is invisible to the validation layer (measured in W5: 98 successful
 * indexed draws, `frameErrors: []`, zero fragments, black frame).
 */
function instanceCountFromUpstream(value: unknown): number {
  return typeof value === "number" && value > 0 ? value : 1;
}

/** `PixelFormat.RGB` (`0x1907`) — the format upstream's emissive/normal placeholders use. */
const PIXEL_FORMAT_RGB = 0x1907;

const VIEWPORT_QUAD_DEFAULT_VS = "in vec4 position; void main() { gl_Position = position; }";

/** Upstream's viewport-quad geometry (`Context.js` builds it from a 4-vertex strip). */
const VIEWPORT_QUAD_ATTRIBUTES = [
  { index: 0, componentDatatype: 5126, componentsPerAttribute: 4, normalized: false, offsetInBytes: 0, strideInBytes: 16 },
];
const VIEWPORT_QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

function resolveTarget(command: CommandLike, passState: PassStateLike): WebgpuFramebufferRef | null {
  const explicit = command.__webgpuTargets ?? command._framebuffer ?? command.framebuffer ?? passState.framebuffer;
  return explicit === undefined ? null : explicit;
}

/**
 * Resolve a draw's backend inputs from the three places that can carry them.
 *
 * W2 introduced the explicit `__webgpu` payload because neither half existed yet. W3 landed the
 * **geometry** half: the replaced `VertexArray` publishes `__webgpu` with its vertex buffers, index
 * buffer and layout (T060), so a command that carries a real vertex array no longer has to be
 * skipped. The **pipeline** half is still W4's (T073/T075) and stays an explicit requirement.
 *
 * The merge order is "explicit payload wins, geometry fills the gaps": a caller that builds the whole
 * payload by hand (the contract workload does) keeps full control, while a command assembled by the
 * logic layer only needs to name its `vertexArray`.
 */
function resolveDrawInputs(command: CommandLike, program: unknown): WebgpuDrawInputs {
  const fromCommand = command.__webgpu;
  // Upstream `Context.js:1439`: `shaderProgram = shaderProgram ?? drawCommand._shaderProgram`, and
  // `DrawCommand.js:670` calls `context.draw(this, passState)` with **no** program argument — so the
  // command's own program is the normal source, not an optional extra. (The first W5 terrain frame
  // measured the consequence of missing it: every globe tile draw failed with "the command carries no
  // render pipeline" even though the replaced `ShaderProgram` had published one.)
  const programLike = (program ?? command.shaderProgram ?? command._shaderProgram) as { __webgpu?: WebgpuDrawInputs } | undefined;
  const fromProgram = programLike?.__webgpu;
  const fromVertexArray = command.vertexArray?.__webgpu;
  const base: WebgpuDrawInputs = fromCommand ?? fromProgram ?? {};

  const vertexBuffers = base.vertexBuffers ?? fromVertexArray?.vertexBuffers;
  const gpuVertexBuffers = base.gpuVertexBuffers ?? fromVertexArray?.gpuVertexBuffers;
  const indexBuffer = base.indexBuffer ?? fromVertexArray?.indexBuffer ?? null;
  const vertexLayout = base.vertexLayout ?? fromVertexArray?.vertexLayout;
  const merged: WebgpuDrawInputs = {
    ...base,
    ...(vertexBuffers === undefined ? {} : { vertexBuffers }),
    ...(gpuVertexBuffers === undefined ? {} : { gpuVertexBuffers }),
    indexBuffer,
    ...(vertexLayout === undefined ? {} : { vertexLayout }),
    indexed: base.indexed ?? fromVertexArray?.indexed ?? indexBuffer !== null,
  };

  if (merged.pipeline !== undefined) return merged;

  // A replaced `ShaderProgram` builds its pipeline through `createPipeline` (the W4/T075 seam), so a
  // command that names its program is complete without a pre-built pipeline (W5).
  if (programLike !== undefined && typeof (programLike as { createPipeline?: unknown }).createPipeline === "function") return merged;

  throw new DiagnosticError(
    "not-implemented",
    "Context.draw: the command carries no render pipeline and no replaced `ShaderProgram` that could build one. The geometry half is " +
      "resolved from the replaced `VertexArray` (W3 / T060), the render state from the replaced `RenderState` (W2 / T049), and the pipeline " +
      "from the replaced `ShaderProgram` (W4 / T075) — a command with none of them cannot be drawn, and skipping it would yield a plausible " +
      "but wrong frame (FR-033).",
    {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      requirementRef: "FR-030",
      entryPoint: "Context#draw",
      extra: {
        hasVertexBuffers: vertexBuffers !== undefined,
        hasIndexBuffer: indexBuffer !== null,
        hasRenderState: base.renderState !== undefined || command.renderState !== undefined,
      },
    },
  );
}

function viewportOf(renderState: RenderStateLike, passState: PassStateLike, swapchain: Swapchain): readonly [number, number, number, number] {
  const viewport = renderState.viewport ?? passState.viewport;
  if (viewport !== undefined && viewport !== null) {
    return [viewport.x ?? 0, viewport.y ?? 0, viewport.width ?? 0, viewport.height ?? 0];
  }
  return [0, 0, swapchain.width, swapchain.height];
}

function scissorOf(renderState: RenderStateLike, passState: PassStateLike): readonly [number, number, number, number] | null {
  const enabled = passState.scissorTest ?? renderState.scissorTest?.enabled ?? false;
  if (enabled !== true) return null;
  const rectangle = renderState.scissorTest?.rectangle;
  return [rectangle?.x ?? 0, rectangle?.y ?? 0, rectangle?.width ?? 0, rectangle?.height ?? 0];
}

/** Exported for diagnostics/tests: whether the hand-off slot is still holding a device. */
export function handoffPending(): boolean {
  return peek() !== undefined;
}

/** Pipeline-cache counters of the module instance this `Context` uses (T048 evidence, contract suites). */
export function pipelineCacheStats(): { readonly size: number; readonly hits: number; readonly misses: number } {
  return pipelineCacheStatsImpl();
}

/** The hand-off failure category, re-exported so the diagnostics surface uses G-2's wording. */
export const CONTEXT_HANDOFF_CATEGORY = HANDOFF_CATEGORY;

/** The upstream `PassState` class, re-exported for the contract harness (kept module). */
export { PassState as ContextPassState };
