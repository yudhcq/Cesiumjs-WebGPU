/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/Renderbuffer.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 */
import { throwNotImplemented } from "../webgpu/errors.js";

const UPSTREAM_MODULE = "Renderer/Renderbuffer.js";
const NOT_IMPLEMENTED = "depth/stencil render buffers (attachment textures)";
const PLANNED_PHASE = "W3";

/**
 * Replacement skeleton: the whole module body is implemented in the phase named below; until then every entry point fails loudly.
 * Boundary: the patch only ever replaces `Source/Renderer/**`; upstream stays unmodified on disk.
 */
export default class Renderbuffer {
  /**
   * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 lands.
   */
  constructor(..._args: unknown[]) {
    throwNotImplemented(NOT_IMPLEMENTED, {
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "Renderbuffer#constructor",
      plannedPhase: PLANNED_PHASE,
    });
  }
}
