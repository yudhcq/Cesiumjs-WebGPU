/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/TextureCache.js`
 * (kind: "adapt") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 */
import { throwNotImplemented } from "../webgpu/errors.js";

const UPSTREAM_MODULE = "Renderer/TextureCache.js";
const NOT_IMPLEMENTED = "texture cache and default-texture lifetime";
const PLANNED_PHASE = "W3";

/**
 * Adaptation skeleton: the upstream implementation is reused and only the semantics named below change.
 * Boundary: the patch only ever replaces `Source/Renderer/**`; upstream stays unmodified on disk.
 */
export default class TextureCache {
  /**
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 lands.
   */
  constructor(..._args: unknown[]) {
    throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "TextureCache#constructor",
      plannedPhase: PLANNED_PHASE,
    });
  }
}
