/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Pipeline cache (research §5.3, data-model §4.2, tasks.md T048): one `GPURenderPipeline` per
 *
 *   PipelineCacheKey = (shaderProgramId, renderStateFingerprint, vertexLayoutFingerprint,
 *                       topology, colorFormats[], depthFormat?, sampleCount)
 *
 * `renderStateFingerprint` MUST cover **every** `RenderState` field: a field that does not reach the
 * fingerprint would silently reuse a pipeline built for different state, which is exactly the class
 * of defect the fingerprint exists to prevent (the unit test drives the coverage from the upstream
 * field list, not from a hand-written copy).
 *
 * Unsupported combinations (`lineWidth !== 1`, `sampleCoverage.enabled === true`, a `depthRange`
 * other than `(0, 1)`) MUST raise a diagnosable error instead of being silently ignored: WebGPU has
 * no state for them (research §5.3).
 */
import { DiagnosticError } from "./errors.js";

/** Identity of one render pipeline. */
export interface PipelineCacheKey {
  readonly shaderProgramId: string;
  readonly renderStateFingerprint: string;
  readonly vertexLayoutFingerprint: string;
  readonly topology: string;
  readonly colorFormats: readonly string[];
  readonly depthFormat: string | null;
  readonly sampleCount: number;
}

/** Bookkeeping record kept per cached pipeline (hit/miss counters feed the G-6 budget). */
export interface PipelineRecord {
  readonly key: PipelineCacheKey;
  readonly pipeline: unknown;
  readonly createdAt: number;
  hits: number;
  misses: number;
}

/** Structural view of `RenderState` consumed by the cache (implemented by `Renderer/RenderState.ts`). */
export interface RenderStateLike {
  readonly frontFace?: number;
  readonly cull?: { readonly enabled?: boolean; readonly face?: number } | undefined;
  readonly lineWidth?: number;
  readonly polygonOffset?: { readonly enabled?: boolean; readonly factor?: number; readonly units?: number } | undefined;
  readonly scissorTest?: { readonly enabled?: boolean; readonly rectangle?: { readonly x?: number; readonly y?: number; readonly width?: number; readonly height?: number } } | undefined;
  readonly depthRange?: { readonly near?: number; readonly far?: number } | undefined;
  readonly depthTest?: { readonly enabled?: boolean; readonly func?: number } | undefined;
  readonly colorMask?: { readonly red?: boolean; readonly green?: boolean; readonly blue?: boolean; readonly alpha?: boolean } | undefined;
  readonly depthMask?: boolean;
  readonly stencilMask?: number;
  readonly blending?: {
    readonly enabled?: boolean;
    readonly color?: { readonly red?: number; readonly green?: number; readonly blue?: number; readonly alpha?: number } | undefined;
    readonly equationRgb?: number;
    readonly equationAlpha?: number;
    readonly functionSourceRgb?: number;
    readonly functionSourceAlpha?: number;
    readonly functionDestinationRgb?: number;
    readonly functionDestinationAlpha?: number;
  } | undefined;
  readonly stencilTest?: {
    readonly enabled?: boolean;
    readonly frontFunction?: number;
    readonly backFunction?: number;
    readonly reference?: number;
    readonly mask?: number;
    readonly frontOperation?: { readonly fail?: number; readonly zFail?: number; readonly zPass?: number } | undefined;
    readonly backOperation?: { readonly fail?: number; readonly zFail?: number; readonly zPass?: number } | undefined;
  } | undefined;
  readonly sampleCoverage?: { readonly enabled?: boolean; readonly value?: number; readonly invert?: boolean } | undefined;
  readonly viewport?: { readonly x?: number; readonly y?: number; readonly width?: number; readonly height?: number } | undefined;
}

/** Vertex-attribute description the cache fingerprints (research §5.3, upstream `VertexArray` shape). */
export interface VertexAttributeLike {
  readonly index?: number;
  readonly componentDatatype?: number;
  readonly componentsPerAttribute?: number;
  readonly normalized?: boolean;
  readonly offsetInBytes?: number;
  readonly strideInBytes?: number;
  readonly instanced?: boolean;
  readonly divisor?: number;
  readonly [key: string]: unknown;
}

/**
 * The upstream `RenderState` field list this fingerprint MUST cover. Kept next to the code so the
 * unit test can compare it against the installed upstream module instead of trusting the comment.
 */
export const RENDER_STATE_FIELDS = [
  "frontFace",
  "cull",
  "lineWidth",
  "polygonOffset",
  "scissorTest",
  "depthRange",
  "depthTest",
  "colorMask",
  "depthMask",
  "stencilMask",
  "blending",
  "stencilTest",
  "sampleCoverage",
  "viewport",
] as const;
export type RenderStateField = (typeof RENDER_STATE_FIELDS)[number];

function diagnostic(capability: string, detail: string, requirementRef: string): DiagnosticError {
  return new DiagnosticError("not-implemented", `${capability} is not supported by the WebGPU backend: ${detail}`, {
    backend: "webgpu",
    requirementRef,
    entryPoint: "pipeline-cache",
    upstreamModule: "Renderer/RenderState.js",
  });
}

/**
 * Reject the `RenderState` combinations WebGPU cannot express (research §5.3, T048/T049).
 *
 * Called by the pipeline cache *and* by `RenderState.toPipelineState`, so the two can never drift.
 */
export function assertPipelineSupported(renderState: RenderStateLike): void {
  const lineWidth = renderState.lineWidth ?? 1;
  if (lineWidth !== 1) {
    throw diagnostic(
      `lineWidth=${lineWidth}`,
      "WebGPU has no wide lines (`primitive` carries no line width); the value MUST stay 1. " +
        "Silently ignoring it would draw thinner lines than the logic layer asked for (research §5.3).",
      "FR-030",
    );
  }
  const sampleCoverage = renderState.sampleCoverage;
  if (sampleCoverage?.enabled === true) {
    throw diagnostic(
      "sampleCoverage.enabled=true",
      "WebGPU has no sample coverage state (`gl.sampleCoverage`); ignoring it would change the coverage of every " +
        "fragment the logic layer draws (research §5.3).",
      "FR-030",
    );
  }
  const depthRange = renderState.depthRange;
  const near = depthRange?.near ?? 0;
  const far = depthRange?.far ?? 1;
  if (near !== 0 || far !== 1) {
    throw diagnostic(
      `depthRange=(${near}, ${far})`,
      "WebGPU has no `gl.depthRange`; the MVP asserts the default (0, 1) and records the difference. " +
        "Depth-range remapping is handled shader-side (research §5.3/§5.4, T074) and a non-default viewport depth " +
        "range needs that work first.",
      "FR-030",
    );
  }
}

function round(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  return Number.isFinite(resolved) ? resolved : fallback;
}

/**
 * Canonical, order-stable fingerprint of every `RenderState` field.
 *
 * The output is a string (not a hash) so a failing assertion can show exactly which field differs.
 */
export function renderStateFingerprint(renderState: RenderStateLike): string {
  assertPipelineSupported(renderState);
  const cull = renderState.cull;
  const polygonOffset = renderState.polygonOffset;
  const scissorTest = renderState.scissorTest;
  const scissorRectangle = scissorTest?.rectangle;
  const depthRange = renderState.depthRange;
  const depthTest = renderState.depthTest;
  const colorMask = renderState.colorMask;
  const blending = renderState.blending;
  const blendingColor = blending?.color;
  const stencilTest = renderState.stencilTest;
  const stencilFront = stencilTest?.frontOperation;
  const stencilBack = stencilTest?.backOperation;
  const sampleCoverage = renderState.sampleCoverage;
  const viewport = renderState.viewport;
  return [
    `frontFace=${round(renderState.frontFace, 2305)}`,
    `cull=${cull?.enabled === true ? 1 : 0}:${round(cull?.face, 1029)}`,
    `lineWidth=${round(renderState.lineWidth, 1)}`,
    `polygonOffset=${polygonOffset?.enabled === true ? 1 : 0}:${round(polygonOffset?.factor, 0)}:${round(polygonOffset?.units, 0)}`,
    `scissorTest=${scissorTest?.enabled === true ? 1 : 0}:${round(scissorRectangle?.x, 0)},${round(scissorRectangle?.y, 0)},${round(scissorRectangle?.width, 0)},${round(scissorRectangle?.height, 0)}`,
    `depthRange=${round(depthRange?.near, 0)}:${round(depthRange?.far, 1)}`,
    `depthTest=${depthTest?.enabled === true ? 1 : 0}:${round(depthTest?.func, 513)}`,
    `colorMask=${colorMask?.red !== false ? 1 : 0}${colorMask?.green !== false ? 1 : 0}${colorMask?.blue !== false ? 1 : 0}${colorMask?.alpha !== false ? 1 : 0}`,
    `depthMask=${renderState.depthMask !== false ? 1 : 0}`,
    `stencilMask=${round(renderState.stencilMask, 0xffffffff) >>> 0}`,
    `blending=${blending?.enabled === true ? 1 : 0}:${round(blendingColor?.red, 0)},${round(blendingColor?.green, 0)},${round(blendingColor?.blue, 0)},${round(blendingColor?.alpha, 0)}:${round(blending?.equationRgb, 32774)}:${round(blending?.equationAlpha, 32774)}:${round(blending?.functionSourceRgb, 1)}:${round(blending?.functionSourceAlpha, 1)}:${round(blending?.functionDestinationRgb, 0)}:${round(blending?.functionDestinationAlpha, 0)}`,
    `stencilTest=${stencilTest?.enabled === true ? 1 : 0}:${round(stencilTest?.frontFunction, 519)}:${round(stencilTest?.backFunction, 519)}:${round(stencilTest?.reference, 0)}:${round(stencilTest?.mask, 0xffffffff) >>> 0}:${round(stencilFront?.fail, 7680)}:${round(stencilFront?.zFail, 7680)}:${round(stencilFront?.zPass, 7680)}:${round(stencilBack?.fail, 7680)}:${round(stencilBack?.zFail, 7680)}:${round(stencilBack?.zPass, 7680)}`,
    `sampleCoverage=${sampleCoverage?.enabled === true ? 1 : 0}:${round(sampleCoverage?.value, 1)}:${sampleCoverage?.invert === true ? 1 : 0}`,
    `viewport=${viewport === undefined || viewport === null ? "auto" : `${round(viewport.x, 0)},${round(viewport.y, 0)},${round(viewport.width, 0)},${round(viewport.height, 0)}`}`,
  ].join("|");
}

/**
 * Canonical fingerprint of a vertex layout (only fields that reach the pipeline descriptor).
 *
 * `shaderLocation` comes from the upstream attribute-name→location map; the buffer identity does
 * NOT participate (the same layout served by a different buffer reuses the pipeline).
 */
export function vertexLayoutFingerprint(attributes: readonly VertexAttributeLike[]): string {
  return [...attributes]
    .map((attribute) => ({
      index: round(attribute.index, 0),
      componentDatatype: round(attribute.componentDatatype, 0),
      componentsPerAttribute: round(attribute.componentsPerAttribute, 0),
      normalized: attribute.normalized === true,
      offsetInBytes: round(attribute.offsetInBytes, 0),
      strideInBytes: round(attribute.strideInBytes, 0),
      instanced: attribute.instanced === true,
      divisor: round(attribute.divisor, attribute.instanced === true ? 1 : 0),
    }))
    .sort((left, right) => left.index - right.index)
    .map((attribute) => `${attribute.index}:${attribute.componentDatatype}:${attribute.componentsPerAttribute}:${attribute.normalized ? 1 : 0}:${attribute.offsetInBytes}:${attribute.strideInBytes}:${attribute.instanced ? 1 : 0}:${attribute.divisor}`)
    .join(";");
}

export function pipelineKeyEquals(left: PipelineCacheKey, right: PipelineCacheKey): boolean {
  return (
    left.shaderProgramId === right.shaderProgramId &&
    left.renderStateFingerprint === right.renderStateFingerprint &&
    left.vertexLayoutFingerprint === right.vertexLayoutFingerprint &&
    left.topology === right.topology &&
    left.depthFormat === right.depthFormat &&
    left.sampleCount === right.sampleCount &&
    left.colorFormats.length === right.colorFormats.length &&
    left.colorFormats.every((format, index) => format === right.colorFormats[index])
  );
}

export function pipelineKeyToString(key: PipelineCacheKey): string {
  return [
    `program=${key.shaderProgramId}`,
    `rs=${key.renderStateFingerprint}`,
    `vertex=${key.vertexLayoutFingerprint}`,
    `topology=${key.topology}`,
    `color=[${key.colorFormats.join("|")}]`,
    `depth=${key.depthFormat ?? "none"}`,
    `samples=${key.sampleCount}`,
  ].join("; ");
}

/** A pipeline factory: real `device.createRenderPipeline` in production, a recorder in unit tests. */
export type PipelineFactory = (key: PipelineCacheKey) => unknown;

let factory: PipelineFactory | null = null;
const records = new Map<string, PipelineRecord>();
let hits = 0;
let misses = 0;

/** Install the pipeline factory (`device.createRenderPipeline` bound to the active device). */
export function setPipelineFactory(next: PipelineFactory | null): void {
  factory = next;
}

/** Look up (or build and store) the pipeline for a key. */
export function getOrCreate(key: PipelineCacheKey, createPipeline: PipelineFactory | null = factory): PipelineRecord {
  const id = pipelineKeyToString(key);
  const existing = records.get(id);
  if (existing !== undefined) {
    existing.hits += 1;
    hits += 1;
    return existing;
  }
  if (createPipeline === null) {
    throw new DiagnosticError(
      "internal",
      "pipeline-cache: no pipeline factory is installed. The replacement Context installs " +
        "`device.createRenderPipeline` at construction time (T048/T043); without it the backend cannot build " +
        "a pipeline and MUST NOT substitute a placeholder.",
      { backend: "webgpu", requirementRef: "FR-030", entryPoint: "pipeline-cache.getOrCreate" },
    );
  }
  const pipeline = createPipeline(key);
  const record: PipelineRecord = { key, pipeline, createdAt: Date.now(), hits: 0, misses: 1 };
  records.set(id, record);
  misses += 1;
  return record;
}

/** Snapshot of the cache statistics (compilation-count budget of G-6 / H-6). */
export function stats(): { readonly size: number; readonly hits: number; readonly misses: number } {
  return { size: records.size, hits, misses };
}

/** Every cached record, in insertion order (evidence artefacts). */
export function all(): readonly PipelineRecord[] {
  return [...records.values()];
}

/** Drop every cached pipeline (device loss, whole-backend switch). */
export function clear(): void {
  records.clear();
  hits = 0;
  misses = 0;
}
