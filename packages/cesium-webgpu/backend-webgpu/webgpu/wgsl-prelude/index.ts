/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * WGSL prelude library (contract fork-patch-layer §5 rule R3): the `czm_` built-ins used by the
 * terrain shader closure (about 40 of the 244 upstream built-ins) live here, **not** under
 * `Source/Shaders/**` — the upstream shader tree stays byte-identical.
 *
 * The prelude is added to every emitted WGSL module; the mapping from upstream leaf text to WGSL
 * is recorded in `webgpu/shader-leaf-map.json` (`leafHash` → `wgslFile`, verified on a real GPU).
 *
 * PHASE 3 (W1) SKELETON: the library lands with the shader front end in W4.
 */
import { throwNotImplemented } from "../errors.js";

const CAPABILITY = "WGSL czm_ prelude";

/** A prelude fragment: the WGSL text plus the upstream leaf it replaces. */
export interface PreludeFragment {
  /** Upstream leaf name, e.g. `czm_translateRelativeToEye`. */
  readonly name: string;
  /** Hash of the upstream leaf text this fragment is the translation of (contract §5 R7). */
  readonly leafHash: string;
  readonly wgsl: string;
}

/** Return the prelude fragments required by a set of assembled built-in names (W4). */
export function preludeFor(_builtinNames: readonly string[]): readonly PreludeFragment[] {
  return throwNotImplemented(CAPABILITY, {
    entryPoint: "wgsl-prelude.preludeFor",
    plannedPhase: "W4 (shader front end)",
    requirementRef: "FR-031",
  });
}

/** Render the prelude text prepended to an emitted WGSL module (W4). */
export function renderPrelude(_fragments: readonly PreludeFragment[]): string {
  return throwNotImplemented(CAPABILITY, {
    entryPoint: "wgsl-prelude.renderPrelude",
    plannedPhase: "W4 (shader front end)",
    requirementRef: "FR-031",
  });
}
