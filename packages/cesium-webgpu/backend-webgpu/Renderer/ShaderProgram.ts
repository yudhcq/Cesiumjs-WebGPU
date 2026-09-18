/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/ShaderProgram.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 */
import { throwNotImplemented } from "../webgpu/errors.js";

const UPSTREAM_MODULE = "Renderer/ShaderProgram.js";
const NOT_IMPLEMENTED = "shader compilation and reflection (GPUShaderModule/GPURenderPipeline)";
const PLANNED_PHASE = "W2/W4 (T048, T081+)";

/**
 * Replacement skeleton: the whole module body is implemented in the phase named below; until then every entry point fails loudly.
 * Boundary: the patch only ever replaces `Source/Renderer/**`; upstream stays unmodified on disk.
 */
export default class ShaderProgram {
  /**
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W2/W4 (T048, T081+) lands.
   */
  constructor(..._args: unknown[]) {
    throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "ShaderProgram#constructor",
      plannedPhase: PLANNED_PHASE,
    });
  }

  /**
   * Attribute locations as reported by the upstream program (contract fork-patch-layer §5 R2).
   *
   * The replacement MUST keep this read surface in sync with `attributeLocations`; the logic
   * layer reads it directly (for example `Scene/Cesium3DTileBatchTable.js`).
   */
  declare readonly _attributeLocations: Record<string, number> | undefined;

  /**
   * Upstream entry point `ShaderProgram.fromCache`.
   *
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W2/W4 (T048, T081+) lands.
   */
  static fromCache(..._args: unknown[]): never {
    return throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "ShaderProgram.fromCache",
      plannedPhase: PLANNED_PHASE,
    });
  }
}
