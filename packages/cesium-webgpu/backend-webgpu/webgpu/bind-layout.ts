/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Bind-group layout generation (research §5.4, gate G-4): the uniform layout is generated from
 * the **assembled GLSL** that is actually compiled, so the WGSL `struct` and the CPU-side writer
 * cannot drift apart. Declared properties:
 *
 *   - `mat3` members occupy three padded columns; `vec3` members align to 16 bytes;
 *   - array elements are rounded up to a 16-byte step (the conservative layout adopted by
 *     decision R-1, `plan.md` Complexity Tracking);
 *   - `czm_sphericalHarmonicCoefficients` is `array<vec4<f32>, 9>`.
 *
 * PHASE 3 (W1) SKELETON: the generator lands with the shader front end (W4); the record shapes
 * are frozen here.
 */
import { throwNotImplemented } from "./errors.js";

const CAPABILITY = "bind-group layout generation";

/** One field of the generated uniform layout. */
export interface UniformFieldLayout {
  readonly name: string;
  /** Byte offset inside the uniform buffer (16-byte aligned where WGSL requires it). */
  readonly byteOffset: number;
  readonly byteSize: number;
  /** Array stride in bytes; `16` for scalar arrays under the conservative layout (R-1). */
  readonly arrayStride?: number;
  readonly wgslType: string;
}

/** The complete layout for one shader program. */
export interface BindLayout {
  readonly programId: string;
  readonly bufferSize: number;
  readonly fields: readonly UniformFieldLayout[];
  readonly samplers: readonly string[];
  /** `true` when a field needed padding to satisfy the WGSL alignment rules. */
  readonly padded: boolean;
}

/** Generate the WGSL `struct` and the CPU-side layout table for an assembled shader (W4/G-4). */
export function buildBindLayout(_assembledGlsl: string): BindLayout {
  return throwNotImplemented(CAPABILITY, {
    entryPoint: "bind-layout.buildBindLayout",
    plannedPhase: "W4 (G-4 generator)",
    requirementRef: "FR-030",
  });
}

/** Emit the WGSL `struct` declaration matching a layout (same generator, both sides). */
export function emitWgslStruct(_layout: BindLayout): string {
  return throwNotImplemented(CAPABILITY, {
    entryPoint: "bind-layout.emitWgslStruct",
    plannedPhase: "W4 (G-4 generator)",
    requirementRef: "FR-030",
  });
}
