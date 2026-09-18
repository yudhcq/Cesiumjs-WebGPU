/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/SharedContext.js`
 * (kind: "adapt") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 */
import { throwNotImplemented } from "../webgpu/errors.js";

const UPSTREAM_MODULE = "Renderer/SharedContext.js";
const NOT_IMPLEMENTED = "GL context multiplexing and 2D blit (no counterpart on the new backend)";
const PLANNED_PHASE = "slice C";

/**
 * Adaptation skeleton: the upstream implementation is reused and only the semantics named below change.
 * Boundary: the patch only ever replaces `Source/Renderer/**`; upstream stays unmodified on disk.
 */
export default class SharedContext {
  /**
   * @throws a `DiagnosticError` with `category: "not-implemented"` until slice C lands.
   */
  constructor(..._args: unknown[]) {
    throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "SharedContext#constructor",
      plannedPhase: PLANNED_PHASE,
    });
  }
}
