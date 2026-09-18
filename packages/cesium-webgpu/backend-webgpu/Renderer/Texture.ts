/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/Texture.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 */
import { throwNotImplemented } from "../webgpu/errors.js";

const UPSTREAM_MODULE = "Renderer/Texture.js";
const NOT_IMPLEMENTED = "texture and sampler resources (GPUTexture/GPUSampler, Y-flip policy)";
const PLANNED_PHASE = "W3 (T057+)";

/**
 * Replacement skeleton: the whole module body is implemented in the phase named below; until then every entry point fails loudly.
 * Boundary: the patch only ever replaces `Source/Renderer/**`; upstream stays unmodified on disk.
 */
export default class Texture {
  /**
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 (T057+) lands.
   */
  constructor(..._args: unknown[]) {
    throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "Texture#constructor",
      plannedPhase: PLANNED_PHASE,
    });
  }

  /**
   * Upstream entry point `Texture.create`.
   *
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 (T057+) lands.
   */
  static create(..._args: unknown[]): never {
    return throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "Texture.create",
      plannedPhase: PLANNED_PHASE,
    });
  }

  /**
   * Upstream entry point `Texture.fromFramebuffer`.
   *
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 (T057+) lands.
   */
  static fromFramebuffer(..._args: unknown[]): never {
    return throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "Texture.fromFramebuffer",
      plannedPhase: PLANNED_PHASE,
    });
  }
}
