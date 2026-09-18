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
import { createDefaultTexture, type DefaultTexture } from "../webgpu/default-resources.js";
import { HANDOFF_CATEGORY, peek, take, type DeviceHandoff } from "../webgpu/device-handoff.js";
import { DiagnosticError } from "../webgpu/errors.js";
import { ErrorScopeCollector, type CollectedGpuError } from "../webgpu/error-scope.js";
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
import { Swapchain, type CanvasLike } from "../webgpu/swapchain.js";
import RenderState from "./RenderState.js";

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
  readonly vertexBuffers?: readonly { readonly slot: number; readonly buffer: GPUBuffer; readonly offset?: number; readonly size?: number }[];
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
  readonly depthStencilAttachment?: GPURenderPassDepthStencilAttachment;
  readonly sampleCount?: number;
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
  readonly vertexArray?: { readonly indexBuffer?: unknown; readonly numberOfVertices?: number };
  readonly color?: { readonly red?: number; readonly green?: number; readonly blue?: number; readonly alpha?: number };
  readonly clearColor?: { readonly red?: number; readonly green?: number; readonly blue?: number; readonly alpha?: number };
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
      sampleCount: this.capabilities.msaa === true ? 4 : 1,
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
    this.counters.frames += 1;
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

    const pipeline = this.#pipelineFor(inputs, renderState, target);
    encoder.setPipeline(pipeline);
    for (const [index, group] of (inputs.bindGroups ?? []).entries()) encoder.setBindGroup(index, group);
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

    if (inputs.indexed === true) {
      encoder.drawIndexed(inputs.indexCount ?? command.count ?? 0, inputs.instanceCount ?? command.instanceCount ?? 1, inputs.firstIndex ?? command.offset ?? 0, 0, 0);
      this.counters.drawIndexedCalls += 1;
    } else {
      encoder.draw(inputs.vertexCount ?? command.count ?? 0, inputs.instanceCount ?? command.instanceCount ?? 1, inputs.firstVertex ?? command.offset ?? 0, 0);
      this.counters.drawCalls += 1;
    }
    this.counters.draws += 1;
    void uniformMap;
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
    const key: RenderPassKey = {
      colorTargets: target === null ? ["swapchain"] : [target.id],
      depthStencilTarget: target === null || target.depthStencilAttachment === undefined ? null : `${target.id}:depth`,
      sampleCount: target?.sampleCount ?? this.#swapchain.sampleCount,
      viewport,
      scissorRect: scissor,
    };
    // The state machine owns the mechanism: `loadOp` when the clear opens the pass, the runtime's
    // native `clearBuffer` when it exists, else a GPU-pass reopen that keeps the derived pass intact.
    const work = this.#machine.beginWork(key, { kind: "clear", seq: this.counters.clears + 1, clearValue });
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
  get defaultCubeMap(): never {
    throw sliceCNotImplemented("defaultCubeMap");
  }
  get defaultEmissiveTexture(): never {
    throw sliceCNotImplemented("defaultEmissiveTexture");
  }
  get defaultNormalTexture(): never {
    throw sliceCNotImplemented("defaultNormalTexture");
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
    // The swap-chain/MSAA attachment(s) + the default texture + every registered render target.
    return (this.#swapchain.isDestroyed() ? 0 : 1) + 1 + this.#registeredTargets.size;
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
    clearPipelineCache();
    setPipelineFactory(null);
    this.#encoder = null;
    this.#registeredTargets.clear();
    this.#destroyed = true;
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  /** Register a render target so commands can name it (`Framebuffer` replacement wires this in W3). */
  registerTarget(target: WebgpuFramebufferRef): void {
    this.#registeredTargets.set(target.id, target);
  }

  /** Resolve the pipeline for one draw; always through the cache so hits/misses are counted (T048). */
  #pipelineFor(inputs: WebgpuDrawInputs, renderState: RenderStateLike, target: WebgpuFramebufferRef | null): GPURenderPipeline {
    const colorFormats = inputs.colorFormats ?? [this.#swapchain.format];
    const depthFormat = inputs.depthFormat ?? (target === null || target.depthStencilAttachment === undefined ? null : "depth24plus-stencil8");
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
    const provided = inputs.pipeline;
    return getOrCreatePipeline(key, provided === undefined ? null : () => provided).pipeline as GPURenderPipeline;
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
    return {
      colorAttachments: [
        {
          view: color.view,
          ...(color.resolveTarget === undefined ? {} : { resolveTarget: color.resolveTarget }),
          loadOp: "load",
          storeOp: "store",
        },
      ],
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

function resolveDrawInputs(command: CommandLike, program: unknown): WebgpuDrawInputs {
  const fromCommand = command.__webgpu;
  if (fromCommand !== undefined) return fromCommand;
  const fromProgram = (program as { __webgpu?: WebgpuDrawInputs } | undefined)?.__webgpu;
  if (fromProgram !== undefined) return fromProgram;
  throw new DiagnosticError(
    "not-implemented",
    "Context.draw: the command carries no WebGPU draw inputs (pipeline, bind groups, vertex/index buffers). The replaced " +
      "`ShaderProgram` (W4 / T075) and the resource layer (W3 / T055-T060) produce them; until then a draw MUST fail loudly " +
      "rather than be skipped — a skipped draw yields a plausible but wrong frame (FR-033).",
    {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      requirementRef: "FR-030",
      entryPoint: "Context#draw",
      plannedPhase: "W3 (T055-T060) + W4 (T075)",
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
