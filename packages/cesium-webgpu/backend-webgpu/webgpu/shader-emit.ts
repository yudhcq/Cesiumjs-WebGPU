/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * **The dual-emission seam** (tasks.md **T067**, SH-1; contract fork-patch-layer §5 rules **R1/R2**).
 *
 * The shader front end does **not** translate GLSL — it re-targets emission. `ShaderSource` is
 * parameterised with `emit: "glsl" | "wgsl"`; the inputs (`sources`, `defines`) and the variant
 * mechanism stay unchanged, and the GLSL view the logic layer probes stays byte-identical.
 *
 * This module is the part of the seam that is *not* the `ShaderSource` class itself:
 *
 *   - `assemblyInputsOf()` — the "装配所需内部件" R1 permits exporting: exactly the five inputs
 *     upstream `combineShader` reads, forwarded by reference so the WGSL channel can never rewrite
 *     what the GLSL channel sees;
 *   - `assertEmitTarget()` — `"glsl"` is the default; an unknown target is refused rather than
 *     coerced (a typo that silently produced GLSL would be invisible in every downstream check);
 *   - `emitShader()` — one stage, one target;
 *   - `assertVaryingsPair()` — the R5 pairing verdict on two emitted stages, read back **from the
 *     emitted text** (`varying-contract.varyingContractFromWgsl`), so the claim is about the artefact.
 *
 * The GLSL channel is byte-identity-by-construction: this module never builds GLSL itself, it calls
 * the upstream algorithm the replacement `ShaderSource` carries, and `tests/unit/
 * shader-source-dual-emit.test.mjs` compares the output with the **installed upstream module**
 * over the whole MVP-reachable define matrix (768 combinations) — the G-5 assertion, re-run against
 * the production seam.
 *
 * Zero dependencies in the runtime path; `node:` imports are not used here at all.
 */
import { varyingContractFromWgsl } from "./varying-contract.js";
import { emitTerrainWgsl } from "./wgsl-emitter.js";
import type { WgslEmissionResult } from "./wgsl-emitter.js";
import { preprocess } from "./glsl-preprocess.js";
import type { DefineList } from "./glsl-preprocess.js";

/** Emission target of the shader front end (contract §5 R1). Default is and stays `"glsl"`. */
export type ShaderEmitTarget = "glsl" | "wgsl";

/** The five assembly inputs upstream `combineShader` reads (`ShaderSource.js:155-304`). */
export interface AssemblyInputs {
  readonly sources: readonly string[];
  readonly defines: readonly string[];
  readonly includeBuiltIns: boolean;
  readonly pickColorQualifier: string | undefined;
  readonly destination: unknown;
}

/** The minimal `ShaderSource` surface the seam needs — satisfied by the replacement class. */
export interface ShaderSourceLike {
  readonly sources: readonly string[];
  readonly defines: readonly string[];
  readonly includeBuiltIns: boolean;
  readonly pickColorQualifier?: string | undefined;
  readonly destination?: unknown;
  emit?: ShaderEmitTarget;
  createCombinedVertexShader(context: unknown): string;
  createCombinedFragmentShader(context: unknown): string;
}

/**
 * Forward the upstream assembly inputs **by reference** (R1's "导出装配所需内部件").
 *
 * Nothing is copied and nothing is normalised: a copy would be a second source of truth, and the
 * whole point of the seam is that the WGSL channel consumes the same arrays the GLSL channel does.
 */
export function assemblyInputsOf(shaderSource: ShaderSourceLike): AssemblyInputs {
  return {
    sources: shaderSource.sources,
    defines: shaderSource.defines,
    includeBuiltIns: shaderSource.includeBuiltIns,
    pickColorQualifier: shaderSource.pickColorQualifier,
    destination: shaderSource.destination,
  };
}

/** Narrow an emission target. An unknown value is an error — never a silent fall-back to `"glsl"`. */
export function assertEmitTarget(value: unknown): ShaderEmitTarget {
  if (value === undefined || value === null) return "glsl";
  if (value === "glsl" || value === "wgsl") return value;
  throw new Error(`shader-emit: unknown emit target ${JSON.stringify(value)}; expected "glsl" or "wgsl" (the default is "glsl")`);
}

/** One emitted shader stage. */
export interface ShaderEmitResult {
  readonly shaderId: string;
  readonly target: ShaderEmitTarget;
  /** The emitted source text (GLSL for `glsl`, WGSL for `wgsl`). */
  readonly source: string;
  /** Varyings emitted by this stage; paired VS/FS sets are asserted on a real device (SH-2). */
  readonly varyings: readonly { readonly location: number; readonly name: string; readonly type: string }[];
}

/** Inputs of one emission: the assembled source parts, the defines and the target. */
export interface ShaderEmitRequest {
  readonly shaderId: string;
  readonly sources: readonly string[];
  readonly defines: readonly string[];
  readonly emit: ShaderEmitTarget;
  /**
   * The assembled GLSL of the stage. When present, the GLSL channel returns it verbatim — that is
   * what the `ShaderSource` replacement produces, and the seam MUST NOT re-derive it.
   */
  readonly assembledGlsl?: string | undefined;
  /** Compile-time conditional evaluation of `sources` for this define set (the WGSL-channel input). */
  readonly evaluate?: ((sources: readonly string[], defines: DefineList) => string) | undefined;
}

/**
 * The default conditional evaluator used when a request does not supply one: concatenate the sources
 * (upstream's `combineShader` joins them with `#line 0`) and return the live text.
 */
function defaultEvaluate(sources: readonly string[], defines: DefineList): string {
  const combined = sources.map((source) => `\n#line 0\n${source}`).join("");
  return preprocess(combined, defines).activeText;
}

/**
 * Emit one shader stage for the requested target.
 *
 * `emit: "glsl"` returns `assembledGlsl` when the caller has it (the production path) or the
 * conditionally-evaluated source otherwise; it never rewrites the GLSL. `emit: "wgsl"` returns the
 * evaluated (directive-free) source, which the emitter then assembles into a full module — a single
 * stage on its own is not a module, so the WGSL branch is explicitly marked as an intermediate and
 * callers that need modules use `emitTerrainWgsl`.
 */
export function emitShader(request: ShaderEmitRequest): ShaderEmitResult {
  const target = assertEmitTarget(request.emit);
  const evaluate = request.evaluate ?? defaultEvaluate;
  if (target === "glsl") {
    return { shaderId: request.shaderId, target, source: request.assembledGlsl ?? evaluate(request.sources, request.defines), varyings: [] };
  }
  return { shaderId: request.shaderId, target, source: evaluate(request.sources, request.defines), varyings: [] };
}

/**
 * Pair the varying sets of a vertex/fragment variant (hard failure on mismatch, contract R5).
 *
 * @throws with the difference report when a fragment input has no vertex output, a location differs,
 *   or the vertex stage declares an output it never writes (the E1 trap: benign in GL because the
 *   linker prunes it, a hard `CreateRenderPipeline` failure in WGSL).
 */
export function assertVaryingsPair(vertex: ShaderEmitResult, fragment: ShaderEmitResult): void {
  const check = varyingContractFromWgsl(vertex.source, fragment.source);
  const failures: string[] = [];
  if (check.unpaired.length > 0) failures.push(`fragment input(s) without a vertex output: ${check.unpaired.join(", ")}`);
  if (check.locationMismatch.length > 0) failures.push(`location mismatch: ${JSON.stringify(check.locationMismatch)}`);
  if (check.vertexDeclaresNeverWritten.length > 0) failures.push(`vertex output(s) declared but never written: ${check.vertexDeclaresNeverWritten.join(", ")}`);
  if (failures.length > 0) {
    throw new Error(`shader-emit: the varying sets of "${vertex.shaderId}"/"${fragment.shaderId}" do not pair up (contract R5, spike §4 E1): ${failures.join("; ")}`);
  }
}

/** Emit a full terrain module pair through the WGSL channel (convenience for tools and the harness). */
export function emitTerrainShaderPair(request: Parameters<typeof emitTerrainWgsl>[0]): WgslEmissionResult {
  return emitTerrainWgsl(request);
}
