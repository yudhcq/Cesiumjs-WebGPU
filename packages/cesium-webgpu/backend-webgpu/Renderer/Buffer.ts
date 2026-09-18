/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/Buffer.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 */
import { throwNotImplemented } from "../webgpu/errors.js";

const UPSTREAM_MODULE = "Renderer/Buffer.js";
const NOT_IMPLEMENTED = "vertex/index/uniform buffers (GPUBuffer)";
const PLANNED_PHASE = "W3 (T055+)";

/**
 * Replacement skeleton: the whole module body is implemented in the phase named below; until then every entry point fails loudly.
 * Boundary: the patch only ever replaces `Source/Renderer/**`; upstream stays unmodified on disk.
 */
export default class Buffer {
  /**
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 (T055+) lands.
   */
  constructor(..._args: unknown[]) {
    throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "Buffer#constructor",
      plannedPhase: PLANNED_PHASE,
    });
  }

  /**
   * Upstream entry point `Buffer.createVertexBuffer`.
   *
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 (T055+) lands.
   */
  static createVertexBuffer(..._args: unknown[]): never {
    return throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "Buffer.createVertexBuffer",
      plannedPhase: PLANNED_PHASE,
    });
  }

  /**
   * Upstream entry point `Buffer.createIndexBuffer`.
   *
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 (T055+) lands.
   */
  static createIndexBuffer(..._args: unknown[]): never {
    return throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "Buffer.createIndexBuffer",
      plannedPhase: PLANNED_PHASE,
    });
  }

  /**
   * Upstream entry point `Buffer.createPixelBuffer`.
   *
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 (T055+) lands.
   */
  static createPixelBuffer(..._args: unknown[]): never {
    return throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "Buffer.createPixelBuffer",
      plannedPhase: PLANNED_PHASE,
    });
  }
}
