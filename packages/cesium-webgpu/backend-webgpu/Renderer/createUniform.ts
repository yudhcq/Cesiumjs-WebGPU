/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/createUniform.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 */
import { throwNotImplemented } from "../webgpu/errors.js";

const UPSTREAM_MODULE = "Renderer/createUniform.js";
const NOT_IMPLEMENTED = "uniform setter generation (bind-group/uniform-buffer writes)";
const PLANNED_PHASE = "W3 (T055+)";

/**
 * Replacement skeleton: the whole module body is implemented in the phase named below; until then every entry point fails loudly.
 * Boundary: the patch only ever replaces `Source/Renderer/**`; upstream stays unmodified on disk.
 */
/**
 * Upstream entry point `createUniform(…)`.
 *
 * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 (T055+) lands.
 */
export default function createUniform(..._args: unknown[]): never {
  return throwNotImplemented(NOT_IMPLEMENTED, {
    upstreamModule: UPSTREAM_MODULE,
    entryPoint: "createUniform",
    plannedPhase: PLANNED_PHASE,
  });
}
