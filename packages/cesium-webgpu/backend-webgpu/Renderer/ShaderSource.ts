/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/ShaderSource.js`
 * (kind: "adapt-shader") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 */
import { throwNotImplemented } from "../webgpu/errors.js";

const UPSTREAM_MODULE = "Renderer/ShaderSource.js";
const NOT_IMPLEMENTED = "shader compile-target parameterisation (GLSL/WGSL dual emit)";
const PLANNED_PHASE = "W4 (shader front end)";

/**
 * Adaptation skeleton: only the compile-target parameterisation is added on top of the upstream implementation.
 * Boundary: the patch only ever replaces `Source/Renderer/**`; upstream stays unmodified on disk.
 */
export default class ShaderSource {
  /**
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W4 (shader front end) lands.
   */
  constructor(..._args: unknown[]) {
    throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "ShaderSource#constructor",
      plannedPhase: PLANNED_PHASE,
    });
  }
}
