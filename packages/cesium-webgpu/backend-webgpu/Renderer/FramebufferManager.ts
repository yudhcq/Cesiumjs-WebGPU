/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/FramebufferManager.js`
 * (kind: "adapt") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 */
import { throwNotImplemented } from "../webgpu/errors.js";

const UPSTREAM_MODULE = "Renderer/FramebufferManager.js";
const NOT_IMPLEMENTED = "multisample/resolve orchestration for derived passes";
const PLANNED_PHASE = "W3";

/**
 * Adaptation skeleton: the upstream implementation is reused and only the semantics named below change.
 * Boundary: the patch only ever replaces `Source/Renderer/**`; upstream stays unmodified on disk.
 */
export default class FramebufferManager {
  /**
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 lands.
   */
  constructor(..._args: unknown[]) {
    throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "FramebufferManager#constructor",
      plannedPhase: PLANNED_PHASE,
    });
  }
}
