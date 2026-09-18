/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/RenderState.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * WHAT CHANGED vs UPSTREAM (tasks.md T049, research §5.3)
 *   Upstream `RenderState` is an **immutable GL state machine**: `apply`/`partialApply` issue the
 *   minimal set of `gl.*` calls that move the GL context from one state to another, and each state is
 *   frozen and reference-counted in a JSON-keyed cache.
 *
 *   In WebGPU there is no state machine to move — the state is *baked into the pipeline object*. The
 *   replacement therefore
 *     - keeps the **option shape identical** (95 construction/static-call sites across 43 logic-layer
 *       files build it with the same literal shape) and keeps
 *       `fromCache`/`removeFromCache`/`clone`/`removeViewport`/`getState`/`id` semantics;
 *     - turns `apply`/`partialApply` into a **pipeline-state diff**: `apply(renderState, passState)`
 *       returns the full `GpuPipelineState`, `partialApply(previous, next, …)` returns the fields that
 *       differ, whether the difference forces a new pipeline object, and the command-level state
 *       (`setViewport`/`setScissorRect`/`setStencilReference`) the backend must re-issue per draw. The
 *       `gl` first argument of upstream is gone because there is no GL context — upstream's only caller
 *       was `Renderer/Context.js`, which this patch layer also replaces;
 *     - rejects the states WebGPU cannot express (`lineWidth !== 1`, `sampleCoverage.enabled`,
 *       `depthRange !== (0, 1)`) through the shared `pipeline-cache.assertPipelineSupported`, so a
 *       mapping gap can never be silently ignored.
 *
 * The GL enum values below are the raw **GL ES 3.0 / WebGL 2** constants upstream re-exports as
 * `WebGLConstants.*` (e.g. `DepthFunction.LESS === WebGLConstants.LESS === 0x0201`). They are spelled
 * out numerically so this module — like the rest of the patch layer — has no dependency on the
 * upstream module graph, which also lets the unit tests load it in isolation.
 */
import { DiagnosticError } from "../webgpu/errors.js";
import { assertPipelineSupported, renderStateFingerprint, type RenderStateLike } from "../webgpu/pipeline-cache.js";

// --- GL ES 3.0 enum values (upstream `WebGLConstants` verbatim) --------------------------------
const WINDING_COUNTER_CLOCKWISE = 0x0901;
const CULL_FRONT = 0x0404;
const CULL_BACK = 0x0405;
const CULL_FRONT_AND_BACK = 0x0408;
const DEPTH_FUNC_NEVER = 0x0200;
const DEPTH_FUNC_LESS = 0x0201;
const STENCIL_ALWAYS = 0x0207;
const STENCIL_KEEP = 0x1e00;
const BLEND_ADD = 0x8006;
const BLEND_ONE = 1;
const BLEND_ZERO = 0;
const DEFAULT_STENCIL_MASK = ~0;

/** GL blending function enum → `GPUBlendFactor` (research §5.3; the mapping table T049 delivers). */
export const BLEND_FACTOR_MAP: Readonly<Record<number, GPUBlendFactor>> = {
  0x0000: "zero",
  0x0001: "one",
  0x0300: "src",
  0x0301: "one-minus-src",
  0x0302: "src-alpha",
  0x0303: "one-minus-src-alpha",
  0x0304: "dst-alpha",
  0x0305: "one-minus-dst-alpha",
  0x0306: "dst",
  0x0307: "one-minus-dst",
  0x0308: "src-alpha-saturated",
  0x8001: "constant",
  0x8002: "one-minus-constant",
  0x8003: "constant",
  0x8004: "one-minus-constant",
  0x88f9: "src1",
  0x88fa: "one-minus-src1",
  0x8589: "src1-alpha",
  0x88fb: "one-minus-src1-alpha",
};

/** GL blend equation enum → `GPUBlendOperation`. */
export const BLEND_EQUATION_MAP: Readonly<Record<number, GPUBlendOperation>> = {
  0x8006: "add",
  0x800a: "subtract",
  0x800b: "reverse-subtract",
  0x8007: "min",
  0x8008: "max",
};

/** GL depth/stencil function enum → `GPUCompareFunction`. */
export const COMPARE_FUNCTION_MAP: Readonly<Record<number, GPUCompareFunction>> = {
  0x0200: "never",
  0x0201: "less",
  0x0202: "equal",
  0x0203: "less-equal",
  0x0204: "greater",
  0x0205: "not-equal",
  0x0206: "greater-equal",
  0x0207: "always",
};

/** GL stencil operation enum → `GPUStencilOperation`. */
export const STENCIL_OPERATION_MAP: Readonly<Record<number, GPUStencilOperation>> = {
  0x0000: "zero",
  0x1e00: "keep",
  0x1e01: "replace",
  0x1e02: "increment-clamp",
  0x1e03: "decrement-clamp",
  0x150a: "invert",
  0x8507: "increment-wrap",
  0x8508: "decrement-wrap",
};

/** GL winding order enum → `GPUFrontFace`. */
export const FRONT_FACE_MAP: Readonly<Record<number, GPUFrontFace>> = { 0x0900: "cw", 0x0901: "ccw" };

/** GL cull-face enum → `GPUCullMode`. */
export const CULL_MODE_MAP: Readonly<Record<number, GPUCullMode>> = { 0x0404: "front", 0x0405: "back", 0x0408: "none" };

function unsupported(table: string, value: number): never {
  throw new DiagnosticError(
    "not-implemented",
    `RenderState → WebGPU mapping has no entry for ${table} value ${value}. The backend MUST fail loudly ` +
      "instead of silently picking a default: a wrong blend/compare/stencil mapping changes every pixel the " +
      "command draws (research §5.3, T049).",
    { backend: "webgpu", upstreamModule: "Renderer/RenderState.js", requirementRef: "FR-030", entryPoint: "RenderState.mapping" },
  );
}

function mapOrThrow<T>(table: Readonly<Record<number, T>>, name: string, value: number | undefined, fallback: number): T {
  const resolved = value ?? fallback;
  const mapped = table[resolved];
  if (mapped === undefined) unsupported(name, resolved);
  return mapped;
}

interface RectangleLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ColorLike {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

/** The pipeline-embedded + command-level state one draw maps to (the WebGPU form of `RenderState.apply`). */
export interface GpuPipelineState {
  readonly primitive: {
    readonly topology: string;
    readonly cullMode: GPUCullMode;
    readonly frontFace: GPUFrontFace;
    readonly stripIndexFormat?: GPUIndexFormat;
  };
  readonly depthStencil: {
    readonly format: string | null;
    readonly depthWriteEnabled: boolean;
    readonly depthCompare: GPUCompareFunction;
    readonly depthBias: number;
    readonly depthBiasSlopeScale: number;
    readonly depthBiasClamp: number;
    readonly stencilFront: GPUStencilFaceState;
    readonly stencilBack: GPUStencilFaceState;
    readonly stencilReadMask: number;
    readonly stencilWriteMask: number;
  };
  readonly multisample: { readonly count: number };
  /** Per-target write mask / blend, index-aligned with the pass colour attachments. */
  readonly targets: readonly { readonly writeMask: number; readonly blend: GPUBlendState | undefined }[];
  /** Command-level state that is NOT part of the pipeline (upstream issued it per draw too). */
  readonly command: {
    readonly viewport: readonly [number, number, number, number] | null;
    readonly scissorRect: readonly [number, number, number, number] | null;
    readonly stencilReference: number;
    readonly blendConstant: readonly [number, number, number, number];
  };
}

/** What a state transition has to change (the pipeline-state diff replacing upstream `partialApply`). */
export interface GpuPipelineStateDiff {
  readonly changed: readonly string[];
  readonly command: GpuPipelineState["command"];
  readonly requiresNewPipeline: boolean;
}

export interface RenderStateOptions {
  frontFace?: number;
  cull?: { enabled?: boolean; face?: number };
  lineWidth?: number;
  polygonOffset?: { enabled?: boolean; factor?: number; units?: number };
  scissorTest?: { enabled?: boolean; rectangle?: Partial<RectangleLike> };
  depthRange?: { near?: number; far?: number };
  depthTest?: { enabled?: boolean; func?: number };
  colorMask?: { red?: boolean; green?: boolean; blue?: boolean; alpha?: boolean };
  depthMask?: boolean;
  stencilMask?: number;
  blending?: {
    enabled?: boolean;
    color?: Partial<ColorLike>;
    equationRgb?: number;
    equationAlpha?: number;
    functionSourceRgb?: number;
    functionSourceAlpha?: number;
    functionDestinationRgb?: number;
    functionDestinationAlpha?: number;
  };
  stencilTest?: {
    enabled?: boolean;
    frontFunction?: number;
    backFunction?: number;
    reference?: number;
    mask?: number;
    frontOperation?: { fail?: number; zFail?: number; zPass?: number };
    backOperation?: { fail?: number; zFail?: number; zPass?: number };
  };
  sampleCoverage?: { enabled?: boolean; value?: number; invert?: boolean };
  viewport?: Partial<RectangleLike>;
  /** Backend-only extras; not part of the upstream option shape and safely defaulted. */
  topology?: string;
  colorFormats?: readonly string[];
  depthFormat?: string | null;
  sampleCount?: number;
  stripIndexFormat?: GPUIndexFormat;
}

/** The upstream `PassState` fields this module consults (upstream `PassState.js` is a kept module). */
export interface PassStateLike {
  readonly viewport?: Partial<RectangleLike> | undefined;
  readonly scissorTest?: boolean | undefined;
  readonly context?: { readonly drawingBufferWidth?: number; readonly drawingBufferHeight?: number } | undefined;
}

function rectangleOf(source: Partial<RectangleLike> | undefined): RectangleLike {
  return { x: source?.x ?? 0, y: source?.y ?? 0, width: source?.width ?? 0, height: source?.height ?? 0 };
}

function colorOf(source: Partial<ColorLike> | undefined): ColorLike {
  return { red: source?.red ?? 0.0, green: source?.green ?? 0.0, blue: source?.blue ?? 0.0, alpha: source?.alpha ?? 0.0 };
}

let nextRenderStateId = 0;
let renderStateCache: Record<string, { referenceCount: number; state: RenderState }> = {};

/**
 * Validates and then finds or creates an immutable render state (upstream contract preserved).
 *
 * @throws a `DiagnosticError` (`not-implemented`) when WebGPU cannot express the requested state
 *   (`lineWidth !== 1`, `sampleCoverage.enabled`, `depthRange !== (0, 1)`).
 */
export default class RenderState implements RenderStateLike {
  id: number;
  frontFace: number;
  cull: { enabled: boolean; face: number };
  lineWidth: number;
  polygonOffset: { enabled: boolean; factor: number; units: number };
  scissorTest: { enabled: boolean; rectangle: RectangleLike };
  depthRange: { near: number; far: number };
  depthTest: { enabled: boolean; func: number };
  colorMask: { red: boolean; green: boolean; blue: boolean; alpha: boolean };
  depthMask: boolean;
  stencilMask: number;
  blending: {
    enabled: boolean;
    color: ColorLike;
    equationRgb: number;
    equationAlpha: number;
    functionSourceRgb: number;
    functionSourceAlpha: number;
    functionDestinationRgb: number;
    functionDestinationAlpha: number;
  };
  stencilTest: {
    enabled: boolean;
    frontFunction: number;
    backFunction: number;
    reference: number;
    mask: number;
    frontOperation: { fail: number; zFail: number; zPass: number };
    backOperation: { fail: number; zFail: number; zPass: number };
  };
  sampleCoverage: { enabled: boolean; value: number; invert: boolean };
  viewport: RectangleLike | undefined;
  readonly topology: string;
  readonly colorFormats: readonly string[];
  readonly depthFormat: string | null;
  readonly sampleCount: number;
  readonly stripIndexFormat: GPUIndexFormat | undefined;

  constructor(options: RenderStateOptions = {}) {
    const cull = options.cull ?? {};
    const polygonOffset = options.polygonOffset ?? {};
    const scissorTest = options.scissorTest ?? {};
    const depthRange = options.depthRange ?? {};
    const depthTest = options.depthTest ?? {};
    const colorMask = options.colorMask ?? {};
    const blending = options.blending ?? {};
    const blendingColor = blending.color ?? {};
    const stencilTest = options.stencilTest ?? {};
    const stencilFront = stencilTest.frontOperation ?? {};
    const stencilBack = stencilTest.backOperation ?? {};
    const sampleCoverage = options.sampleCoverage ?? {};

    this.frontFace = options.frontFace ?? WINDING_COUNTER_CLOCKWISE;
    this.cull = { enabled: cull.enabled ?? false, face: cull.face ?? CULL_BACK };
    this.lineWidth = options.lineWidth ?? 1.0;
    this.polygonOffset = { enabled: polygonOffset.enabled ?? false, factor: polygonOffset.factor ?? 0, units: polygonOffset.units ?? 0 };
    this.scissorTest = { enabled: scissorTest.enabled ?? false, rectangle: rectangleOf(scissorTest.rectangle) };
    this.depthRange = { near: depthRange.near ?? 0, far: depthRange.far ?? 1 };
    this.depthTest = { enabled: depthTest.enabled ?? false, func: depthTest.func ?? DEPTH_FUNC_LESS };
    this.colorMask = {
      red: colorMask.red ?? true,
      green: colorMask.green ?? true,
      blue: colorMask.blue ?? true,
      alpha: colorMask.alpha ?? true,
    };
    this.depthMask = options.depthMask ?? true;
    this.stencilMask = options.stencilMask ?? DEFAULT_STENCIL_MASK;
    this.blending = {
      enabled: blending.enabled ?? false,
      color: colorOf(blendingColor),
      equationRgb: blending.equationRgb ?? BLEND_ADD,
      equationAlpha: blending.equationAlpha ?? BLEND_ADD,
      functionSourceRgb: blending.functionSourceRgb ?? BLEND_ONE,
      functionSourceAlpha: blending.functionSourceAlpha ?? BLEND_ONE,
      functionDestinationRgb: blending.functionDestinationRgb ?? BLEND_ZERO,
      functionDestinationAlpha: blending.functionDestinationAlpha ?? BLEND_ZERO,
    };
    this.stencilTest = {
      enabled: stencilTest.enabled ?? false,
      frontFunction: stencilTest.frontFunction ?? STENCIL_ALWAYS,
      backFunction: stencilTest.backFunction ?? STENCIL_ALWAYS,
      reference: stencilTest.reference ?? 0,
      mask: stencilTest.mask ?? DEFAULT_STENCIL_MASK,
      frontOperation: {
        fail: stencilFront.fail ?? STENCIL_KEEP,
        zFail: stencilFront.zFail ?? STENCIL_KEEP,
        zPass: stencilFront.zPass ?? STENCIL_KEEP,
      },
      backOperation: {
        fail: stencilBack.fail ?? STENCIL_KEEP,
        zFail: stencilBack.zFail ?? STENCIL_KEEP,
        zPass: stencilBack.zPass ?? STENCIL_KEEP,
      },
    };
    this.sampleCoverage = {
      enabled: sampleCoverage.enabled ?? false,
      value: sampleCoverage.value ?? 1.0,
      invert: sampleCoverage.invert ?? false,
    };
    this.viewport = options.viewport === undefined ? undefined : rectangleOf(options.viewport);

    this.topology = options.topology ?? "triangle-list";
    this.colorFormats = options.colorFormats ?? ["bgra8unorm"];
    this.depthFormat = options.depthFormat ?? null;
    this.sampleCount = options.sampleCount ?? 1;
    this.stripIndexFormat = options.stripIndexFormat;

    // Upstream validated `lineWidth` against `ContextLimits.minimum/maximumAliasedLineWidth`; both are
    // 1 in this backend, so the accepted input set is unchanged. The WebGPU-specific rejections are
    // shared with the pipeline cache so the two can never drift (T048/T049).
    assertPipelineSupported(this);
    this.id = nextRenderStateId++;
  }

  /** Plain-object copy of every field (upstream shape preserved; `viewport` stays optional). */
  static getState(renderState: RenderState): RenderStateOptions {
    return {
      frontFace: renderState.frontFace,
      cull: { enabled: renderState.cull.enabled, face: renderState.cull.face },
      lineWidth: renderState.lineWidth,
      polygonOffset: { enabled: renderState.polygonOffset.enabled, factor: renderState.polygonOffset.factor, units: renderState.polygonOffset.units },
      scissorTest: { enabled: renderState.scissorTest.enabled, rectangle: { ...renderState.scissorTest.rectangle } },
      depthRange: { near: renderState.depthRange.near, far: renderState.depthRange.far },
      depthTest: { enabled: renderState.depthTest.enabled, func: renderState.depthTest.func },
      colorMask: { ...renderState.colorMask },
      depthMask: renderState.depthMask,
      stencilMask: renderState.stencilMask,
      blending: {
        enabled: renderState.blending.enabled,
        color: { ...renderState.blending.color },
        equationRgb: renderState.blending.equationRgb,
        equationAlpha: renderState.blending.equationAlpha,
        functionSourceRgb: renderState.blending.functionSourceRgb,
        functionSourceAlpha: renderState.blending.functionSourceAlpha,
        functionDestinationRgb: renderState.blending.functionDestinationRgb,
        functionDestinationAlpha: renderState.blending.functionDestinationAlpha,
      },
      stencilTest: {
        enabled: renderState.stencilTest.enabled,
        frontFunction: renderState.stencilTest.frontFunction,
        backFunction: renderState.stencilTest.backFunction,
        reference: renderState.stencilTest.reference,
        mask: renderState.stencilTest.mask,
        frontOperation: { ...renderState.stencilTest.frontOperation },
        backOperation: { ...renderState.stencilTest.backOperation },
      },
      sampleCoverage: { ...renderState.sampleCoverage },
      ...(renderState.viewport === undefined ? {} : { viewport: { ...renderState.viewport } }),
      topology: renderState.topology,
      colorFormats: renderState.colorFormats,
      depthFormat: renderState.depthFormat,
      sampleCount: renderState.sampleCount,
      ...(renderState.stripIndexFormat === undefined ? {} : { stripIndexFormat: renderState.stripIndexFormat }),
    };
  }

  /** Immutable, reference-counted render state (upstream `fromCache` semantics preserved). */
  static fromCache(renderState: RenderStateOptions | RenderState): RenderState {
    const options = renderState instanceof RenderState ? RenderState.getState(renderState) : renderState;
    const partialKey = JSON.stringify(options);
    const cached = renderStateCache[partialKey];
    if (cached !== undefined) {
      cached.referenceCount += 1;
      return cached.state;
    }
    const states = new RenderState(options);
    const fullKey = JSON.stringify(RenderState.getState(states));
    let fullCached = renderStateCache[fullKey];
    if (fullCached === undefined) {
      fullCached = { referenceCount: 0, state: states };
      renderStateCache[fullKey] = fullCached;
    }
    fullCached.referenceCount += 1;
    renderStateCache[partialKey] = { referenceCount: 1, state: fullCached.state };
    return fullCached.state;
  }

  /** Decrement the reference counts of the (partial and full) cache keys of `renderState`. */
  static removeFromCache(renderState: RenderStateOptions | RenderState): void {
    const options = renderState instanceof RenderState ? RenderState.getState(renderState) : renderState;
    const fullKey = JSON.stringify(RenderState.getState(new RenderState(options)));
    const fullCached = renderStateCache[fullKey];
    const partialKey = JSON.stringify(options);
    const cached = renderStateCache[partialKey];
    if (cached !== undefined) {
      cached.referenceCount -= 1;
      if (cached.referenceCount <= 0) {
        delete renderStateCache[partialKey];
        if (fullCached !== undefined) fullCached.referenceCount -= 1;
      }
    }
    if (fullCached !== undefined && fullCached.referenceCount <= 0) delete renderStateCache[fullKey];
  }

  /** Test-only view of the cache (upstream keeps the same escape door). */
  static getCache(): Record<string, { referenceCount: number; state: RenderState }> {
    return renderStateCache;
  }

  /** Test-only cache wipe; the product rebuilds the cache with the context instead. */
  static clearCache(): void {
    renderStateCache = {};
    nextRenderStateId = 0;
  }

  static clone(renderState: RenderState, result?: RenderState): RenderState {
    const cloned = (result ?? Object.create(RenderState.prototype)) as RenderState;
    Object.assign(cloned, RenderState.getState(renderState));
    cloned.id = renderState.id;
    return cloned;
  }

  static removeViewport(renderState: RenderState): RenderState {
    const options = RenderState.getState(renderState);
    delete options.viewport;
    const withoutViewport = new RenderState(options);
    withoutViewport.id = renderState.id;
    return withoutViewport;
  }

  /**
   * The full state this `RenderState` maps to (the WebGPU form of upstream `RenderState.apply`).
   *
   * `passState` participates only through the upstream viewport/scissor fallback chain
   * `renderState.viewport ?? passState.viewport` (research §5.3).
   */
  static apply(renderState: RenderState, passState?: PassStateLike | null): GpuPipelineState {
    return renderState.toPipelineState(passState);
  }

  /**
   * The **pipeline-state diff** replacing upstream `partialApply` (T049).
   *
   * Upstream was `partialApply(gl, previousRenderState, renderState, previousPassState, passState,
   * clear)`; the `gl` argument is gone because there is no GL context to move. The return value names
   * the fields that differ, whether the difference forces a different pipeline object, and the
   * command-level state the backend must re-issue for this draw.
   */
  static partialApply(
    previousRenderState: RenderState | undefined,
    renderState: RenderState,
    previousPassState?: PassStateLike | null,
    passState?: PassStateLike | null,
    clear = false,
  ): GpuPipelineStateDiff {
    return renderState.pipelineDiff(previousRenderState, previousPassState, passState, clear);
  }

  /** The mapping table applied to this state (see `GpuPipelineState`). */
  toPipelineState(passState?: PassStateLike | null): GpuPipelineState {
    assertPipelineSupported(this);
    const cullMode: GPUCullMode = this.cull.enabled === true ? mapOrThrow(CULL_MODE_MAP, "cull.face", this.cull.face, CULL_BACK) : "none";
    const frontFace = mapOrThrow(FRONT_FACE_MAP, "frontFace", this.frontFace, WINDING_COUNTER_CLOCKWISE);
    const depthCompare: GPUCompareFunction =
      this.depthTest.enabled === true ? mapOrThrow(COMPARE_FUNCTION_MAP, "depthTest.func", this.depthTest.func, DEPTH_FUNC_LESS) : "always";
    const depthWriteEnabled = this.depthTest.enabled === true && this.depthMask === true;

    const stencilFace = (compare: number, operation: { fail: number; zFail: number; zPass: number }): GPUStencilFaceState => ({
      compare: mapOrThrow(COMPARE_FUNCTION_MAP, "stencilTest.function", compare, STENCIL_ALWAYS),
      failOp: mapOrThrow(STENCIL_OPERATION_MAP, "stencilTest.operation.fail", operation.fail, STENCIL_KEEP),
      depthFailOp: mapOrThrow(STENCIL_OPERATION_MAP, "stencilTest.operation.zFail", operation.zFail, STENCIL_KEEP),
      passOp: mapOrThrow(STENCIL_OPERATION_MAP, "stencilTest.operation.zPass", operation.zPass, STENCIL_KEEP),
    });

    const writeMask = (this.colorMask.red ? 1 : 0) | (this.colorMask.green ? 2 : 0) | (this.colorMask.blue ? 4 : 0) | (this.colorMask.alpha ? 8 : 0);

    const blend: GPUBlendState | undefined =
      this.blending.enabled === true
        ? {
            color: {
              operation: mapOrThrow(BLEND_EQUATION_MAP, "blending.equationRgb", this.blending.equationRgb, BLEND_ADD),
              srcFactor: mapOrThrow(BLEND_FACTOR_MAP, "blending.functionSourceRgb", this.blending.functionSourceRgb, BLEND_ONE),
              dstFactor: mapOrThrow(BLEND_FACTOR_MAP, "blending.functionDestinationRgb", this.blending.functionDestinationRgb, BLEND_ZERO),
            },
            alpha: {
              operation: mapOrThrow(BLEND_EQUATION_MAP, "blending.equationAlpha", this.blending.equationAlpha, BLEND_ADD),
              srcFactor: mapOrThrow(BLEND_FACTOR_MAP, "blending.functionSourceAlpha", this.blending.functionSourceAlpha, BLEND_ONE),
              dstFactor: mapOrThrow(BLEND_FACTOR_MAP, "blending.functionDestinationAlpha", this.blending.functionDestinationAlpha, BLEND_ZERO),
            },
          }
        : undefined;

    const viewportSource = this.viewport ?? passState?.viewport ?? undefined;
    const viewport: readonly [number, number, number, number] | null =
      viewportSource === undefined
        ? null
        : [viewportSource.x ?? 0, viewportSource.y ?? 0, viewportSource.width ?? 0, viewportSource.height ?? 0];

    // Scissor: `passState.scissorTest` overrides the command-level state (upstream RenderState.js:859-861);
    // `enabled === false` means "the whole target", which the backend expresses as `null`.
    const scissorEnabled = passState?.scissorTest ?? this.scissorTest.enabled;
    const scissorRect: readonly [number, number, number, number] | null =
      scissorEnabled === true
        ? [this.scissorTest.rectangle.x, this.scissorTest.rectangle.y, this.scissorTest.rectangle.width, this.scissorTest.rectangle.height]
        : null;

    return {
      primitive: {
        topology: this.topology,
        cullMode,
        frontFace,
        ...(this.stripIndexFormat === undefined ? {} : { stripIndexFormat: this.stripIndexFormat }),
      },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled,
        depthCompare,
        depthBias: this.polygonOffset.enabled === true ? this.polygonOffset.units : 0,
        depthBiasSlopeScale: this.polygonOffset.enabled === true ? this.polygonOffset.factor : 0,
        depthBiasClamp: 0,
        stencilFront: stencilFace(this.stencilTest.frontFunction, this.stencilTest.frontOperation),
        stencilBack: stencilFace(this.stencilTest.backFunction, this.stencilTest.backOperation),
        stencilReadMask: this.stencilTest.mask,
        stencilWriteMask: this.stencilMask,
      },
      multisample: { count: this.sampleCount },
      targets: this.colorFormats.map(() => ({ writeMask, blend })),
      command: {
        viewport,
        scissorRect,
        stencilReference: this.stencilTest.reference,
        blendConstant: [this.blending.color.red, this.blending.color.green, this.blending.color.blue, this.blending.color.alpha],
      },
    };
  }

  /** Fingerprint covering every field (shared implementation, T048). */
  fingerprint(): string {
    return renderStateFingerprint(this);
  }

  /** The pipeline-state diff against `previous` (see `partialApply`). */
  pipelineDiff(
    previous: RenderState | undefined,
    previousPassState?: PassStateLike | null,
    passState?: PassStateLike | null,
    clear = false,
  ): GpuPipelineStateDiff {
    const next = this.toPipelineState(passState);
    if (previous === undefined) {
      return { changed: ["<first-state>"], command: next.command, requiresNewPipeline: true };
    }
    const before = previous.toPipelineState(previousPassState);
    const changed: string[] = [];
    if (previous.fingerprint() !== this.fingerprint()) {
      if (JSON.stringify(before.primitive) !== JSON.stringify(next.primitive)) changed.push("primitive");
      if (JSON.stringify(before.depthStencil) !== JSON.stringify(next.depthStencil)) changed.push("depthStencil");
      if (JSON.stringify(before.multisample) !== JSON.stringify(next.multisample)) changed.push("multisample");
      if (JSON.stringify(before.targets) !== JSON.stringify(next.targets)) changed.push("targets");
    }
    if (JSON.stringify(before.command.viewport) !== JSON.stringify(next.command.viewport)) changed.push("viewport");
    if (JSON.stringify(before.command.scissorRect) !== JSON.stringify(next.command.scissorRect)) changed.push("scissorRect");
    if (clear) changed.push("clear");
    return {
      changed,
      command: next.command,
      requiresNewPipeline: changed.some(
        (field) => field === "<first-state>" || field === "primitive" || field === "depthStencil" || field === "multisample" || field === "targets",
      ),
    };
  }
}

/** The GL defaults this mapping falls back to (exported so the unit test can assert them). */
export const RENDER_STATE_DEFAULTS = {
  WINDING_COUNTER_CLOCKWISE,
  CULL_BACK,
  CULL_FRONT,
  CULL_FRONT_AND_BACK,
  DEPTH_FUNC_LESS,
  DEPTH_FUNC_NEVER,
  STENCIL_ALWAYS,
  STENCIL_KEEP,
  BLEND_ADD,
  BLEND_ONE,
  BLEND_ZERO,
} as const;
