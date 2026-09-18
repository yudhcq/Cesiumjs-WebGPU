/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/CubeMapFace.js`
 * (kind: "stub-not-implemented") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 */
import { throwNotImplemented } from "../webgpu/errors.js";

const UPSTREAM_MODULE = "Renderer/CubeMapFace.js";
const NOT_IMPLEMENTED = "cube map face wrapper";
const PLANNED_PHASE = "slice C (T053)";

/**
 * Explicit-failure stub (slice C boundary, tasks.md T053): this capability MUST fail loudly on the new backend, never return an empty result or a black frame.
 * Boundary: the patch only ever replaces `Source/Renderer/**`; upstream stays unmodified on disk.
 */
export default class CubeMapFace {
  /**
   * @throws a `DiagnosticError` with `category: "not-implemented"` until slice C (T053) lands.
   */
  constructor(..._args: unknown[]) {
    throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "CubeMapFace#constructor",
      plannedPhase: PLANNED_PHASE,
    });
  }
}
