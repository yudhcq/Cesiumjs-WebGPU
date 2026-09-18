/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/createUniformArray.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 */
import { throwNotImplemented } from "../webgpu/errors.js";

const UPSTREAM_MODULE = "Renderer/createUniformArray.js";
const NOT_IMPLEMENTED = "array uniform setter generation";
const PLANNED_PHASE = "W3 (T055+)";

/**
 * Replacement skeleton: the whole module body is implemented in the phase named below; until then every entry point fails loudly.
 * Boundary: the patch only ever replaces `Source/Renderer/**`; upstream stays unmodified on disk.
 */
/**
 * Upstream entry point `createUniformArray(…)`.
 *
 * @throws a `DiagnosticError` with `category: "not-implemented"` until W3 (T055+) lands.
 */
export default function createUniformArray(..._args: unknown[]): never {
  return throwNotImplemented(NOT_IMPLEMENTED, {
    upstreamModule: UPSTREAM_MODULE,
    entryPoint: "createUniformArray",
    plannedPhase: PLANNED_PHASE,
  });
}
