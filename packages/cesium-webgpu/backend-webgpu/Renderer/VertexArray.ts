/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/VertexArray.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 */
import { throwNotImplemented } from "../webgpu/errors.js";

const UPSTREAM_MODULE = "Renderer/VertexArray.js";
const NOT_IMPLEMENTED = "vertex array objects (vertex buffer layouts)";
const PLANNED_PHASE = "W3 (T055+)";

/**
 * Replacement skeleton: the whole module body is implemented in the phase named below; until then every entry point fails loudly.
 * Boundary: the patch only ever replaces `Source/Renderer/**`; upstream stays unmodified on disk.
 */
export default class VertexArray {
  /**
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 (T055+) lands.
   */
  constructor(..._args: unknown[]) {
    throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "VertexArray#constructor",
      plannedPhase: PLANNED_PHASE,
    });
  }

  /**
   * Upstream entry point `VertexArray.fromGeometry`.
   *
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 (T055+) lands.
   */
  static fromGeometry(..._args: unknown[]): never {
    return throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "VertexArray.fromGeometry",
      plannedPhase: PLANNED_PHASE,
    });
  }
}
