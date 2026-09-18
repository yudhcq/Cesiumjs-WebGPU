/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/RenderState.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 */
import { throwNotImplemented } from "../webgpu/errors.js";

const UPSTREAM_MODULE = "Renderer/RenderState.js";
const NOT_IMPLEMENTED = "render-state to pipeline descriptor mapping";
const PLANNED_PHASE = "W2 (T049)";

/**
 * Replacement skeleton: the whole module body is implemented in the phase named below; until then every entry point fails loudly.
 * Boundary: the patch only ever replaces `Source/Renderer/**`; upstream stays unmodified on disk.
 */
export default class RenderState {
  /**
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W2 (T049) lands.
   */
  constructor(..._args: unknown[]) {
    throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "RenderState#constructor",
      plannedPhase: PLANNED_PHASE,
    });
  }

  /**
   * Upstream entry point `RenderState.fromCache`.
   *
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W2 (T049) lands.
   */
  static fromCache(..._args: unknown[]): never {
    return throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "RenderState.fromCache",
      plannedPhase: PLANNED_PHASE,
    });
  }

  /**
   * Upstream entry point `RenderState.partialApply`.
   *
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W2 (T049) lands.
   */
  static partialApply(..._args: unknown[]): never {
    return throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "RenderState.partialApply",
      plannedPhase: PLANNED_PHASE,
    });
  }

  /**
   * Upstream entry point `RenderState.apply`.
   *
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W2 (T049) lands.
   */
  static apply(..._args: unknown[]): never {
    return throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "RenderState.apply",
      plannedPhase: PLANNED_PHASE,
    });
  }
}
