/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * WGSL emission (contract fork-patch-layer §5, gate G-5): the shader front end does **not**
 * translate GLSL — it re-targets emission. `ShaderSource` is parameterised with
 * `emit: "glsl" | "wgsl"`; the inputs (`sources`, `defines`) and the variant mechanism stay
 * unchanged, and the GLSL view the logic layer probes stays byte-identical (contract R1/R2).
 *
 * PHASE 3 (W1) SKELETON: the emitter lands with the shader front end in W4.
 */
import { throwNotImplemented } from "./errors.js";

const CAPABILITY = "WGSL emission";

/** Emission target of the shader front end (contract §5 R1). */
export type ShaderEmitTarget = "glsl" | "wgsl";

/** Inputs of one emission: the assembled source parts, the defines and the target. */
export interface ShaderEmitRequest {
  readonly shaderId: string;
  readonly sources: readonly string[];
  readonly defines: readonly string[];
  readonly emit: ShaderEmitTarget;
}

/** One emitted shader stage. */
export interface ShaderEmitResult {
  readonly shaderId: string;
  readonly target: ShaderEmitTarget;
  /** The emitted source text (GLSL for `glsl`, WGSL for `wgsl`). */
  readonly source: string;
  /** Varyings emitted by this stage; paired VS/FS sets are asserted on a real device (G-5 R5). */
  readonly varyings: readonly { readonly location: number; readonly name: string; readonly type: string }[];
}

/** Emit one shader stage for the requested target (W4). */
export function emitShader(_request: ShaderEmitRequest): ShaderEmitResult {
  return throwNotImplemented(CAPABILITY, {
    entryPoint: "shader-emit.emitShader",
    plannedPhase: "W4 (shader front end)",
    requirementRef: "FR-031",
  });
}

/** Pair the varying sets of a vertex/fragment variant (hard failure on mismatch, contract R5). */
export function assertVaryingsPair(_vertex: ShaderEmitResult, _fragment: ShaderEmitResult): void {
  throwNotImplemented(CAPABILITY, {
    entryPoint: "shader-emit.assertVaryingsPair",
    plannedPhase: "W4 (shader front end)",
    requirementRef: "FR-031",
  });
}
