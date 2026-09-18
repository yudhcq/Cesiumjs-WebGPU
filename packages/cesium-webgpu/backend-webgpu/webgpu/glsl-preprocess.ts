/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * GLSL conditional-compilation front end (contract fork-patch-layer §5 rule R4): upstream hands
 * `#define` / `#ifdef` / `#if` to the GL driver as text and lets the driver evaluate it
 * (`Renderer/ShaderSource.js:250-258`). The new backend has no driver doing that, so the
 * evaluation is implemented here, with the upstream ordering semantics preserved:
 * inline the `czm_` built-ins first, then evaluate the conditionals.
 *
 * Supported: `&&`, `||`, `!`, parentheses, `#elif` chains, arithmetic conditions such as
 * `#if TEXTURE_UNITS > 0`.
 *
 * PHASE 3 (W1) SKELETON: the evaluator lands with the shader front end in W4.
 */
import { throwNotImplemented } from "./errors.js";

const CAPABILITY = "GLSL conditional-compilation evaluation";

/** The define set of one shader variant. */
export type DefineTable = Readonly<Record<string, string | number | boolean>>;

/** Evaluate every `#if`/`#ifdef`/`#elif` chain of a source with a define table (W4). */
export function evaluateConditionals(_source: string, _defines: DefineTable): string {
  return throwNotImplemented(CAPABILITY, {
    entryPoint: "glsl-preprocess.evaluateConditionals",
    plannedPhase: "W4 (shader front end)",
    requirementRef: "FR-031",
  });
}

/** Inline the `czm_` built-in bodies before evaluating conditionals (upstream ordering, R4). */
export function inlineCzmBuiltins(_source: string): string {
  return throwNotImplemented(CAPABILITY, {
    entryPoint: "glsl-preprocess.inlineCzmBuiltins",
    plannedPhase: "W4 (shader front end)",
    requirementRef: "FR-031",
  });
}

/** The `TEXTURE_UNITS` define carries the number of texture units of the variant (research §6.3). */
export function textureUnitsDefine(_textureUnits: number): DefineTable {
  throwNotImplemented(CAPABILITY, {
    entryPoint: "glsl-preprocess.textureUnitsDefine",
    plannedPhase: "W4 (shader front end)",
    requirementRef: "FR-031",
  });
}
