/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Pipeline cache (research §5.3, data-model §4.2): one `GPURenderPipeline` per
 *
 *   PipelineCacheKey = (shaderProgramId, renderStateFingerprint, vertexLayoutFingerprint,
 *                       topology, colorFormats[], depthFormat?, sampleCount)
 *
 * Unsupported combinations (`lineWidth !== 1`, `sampleCoverage.enabled === true`) MUST raise a
 * diagnosable error instead of being silently ignored — WebGPU has no state for them.
 *
 * PHASE 3 (W1) SKELETON: the cache lands in W2/T048.
 */
import { throwNotImplemented } from "./errors.js";

const CAPABILITY = "pipeline cache";

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

/** Look up (or build and store) the pipeline for a key (W2/T048). */
export function getOrCreate(_key: PipelineCacheKey): PipelineRecord {
  return throwNotImplemented(CAPABILITY, {
    entryPoint: "pipeline-cache.getOrCreate",
    plannedPhase: "W2 (T048)",
    requirementRef: "FR-030",
  });
}

/** Snapshot of the cache statistics (compilation-count budget of G-6 / H-6). */
export function stats(): { readonly size: number; readonly hits: number; readonly misses: number } {
  return throwNotImplemented(CAPABILITY, {
    entryPoint: "pipeline-cache.stats",
    plannedPhase: "W2 (T048)",
    requirementRef: "FR-030",
  });
}

/** Drop every cached pipeline (device loss, whole-backend switch). */
export function clear(): void {
  throwNotImplemented(CAPABILITY, {
    entryPoint: "pipeline-cache.clear",
    plannedPhase: "W2 (T048)",
    requirementRef: "FR-030",
  });
}
