/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * **WGSL emission channel** of the parameterised shader assembly seam (tasks.md **T073**, and
 * **T074** for the depth-range pair; research §6.3 `WgslEmission.emit(...)`; contract
 * fork-patch-layer §5 rules R1–R6).
 *
 * The seam keeps the upstream inputs untouched — the **same** `sources` + `defines` that produce the
 * GLSL also produce the WGSL; nothing is translated from GLSL text. What WGSL needs and GLSL gets from
 * the driver is computed here:
 *
 *   1. **conditional compilation** (`glsl-preprocess.ts`, R4) selects the live regions of the WGSL
 *      leaf library — WGSL has no preprocessor;
 *   2. **varying pairing** (`varying-contract.ts`, R5) is *derived from the real assembled GLSL* and
 *      fed back in as `PAIR_<name>` defines, so the emitted vertex stage writes exactly the varyings
 *      the emitted fragment stage reads (mirroring the GL linker's pruning);
 *   3. the **uniform struct + bindings** come from `bind-layout.ts`, so the emitted struct and the
 *      CPU-side writer share one table;
 *   4. the **runtime-generated** fragments (`computeDayColor`, `getPosition`) come from
 *      `generated-fragments.ts` (R6);
 *   5. the **depth-range pair** (T074) lives in the prelude and the vertex leaf — see below.
 *
 * **Depth range (T074).** GL clip space has z ∈ [-w, w]; the WebGPU NDC cube has z ∈ [0, w] and a
 * vertex position outside it is clipped. The GLSL side must not change (`Core/PerspectiveFrustum.js`
 * and `Renderer/UniformState.js` are kept modules — principle I), so the remap is applied where the
 * WGSL is produced: the single `@builtin(position)` write of the vertex leaf goes through
 * `czms_remapClipDepth`, and the prelude declares `czms_unprojectDepth` as the inverse for any code
 * that reconstructs eye coordinates from a depth value. `assertDepthRangePair()` below is the
 * machine check behind the T074 unit suite: every `@builtin(position)`/`@builtin(frag_depth)` write
 * point in the emitted text MUST be remapped, and an unpaired depth reconstruction is a failure.
 *
 * **Coverage discipline.** The emitter has an explicit `SUPPORTED_DEFINES` set. Anything outside it
 * produces an **explicit diagnostic** and *no module* — it never silently degrades, and the caller is
 * required to treat that as a failure rather than as a skip. (The first G-5 run silently emitted
 * `APPLY_MATERIAL`; the gate's own check caught it, and this is the fix.)
 *
 * The modules are **text**, not `GPUShaderModule`s: creating a module is a device operation and this
 * layer is device-free (which is what makes it unit-testable and what keeps `createShaderModule`
 * calls at exactly 2 × the number of distinct module texts — G-6 rev3, 256 for 128 texts).
 *
 * Ported from the verified G-5 gate implementation
 * (`experiments/gates/g5-shader/wgsl-emitter.mjs`).
 *
 * Zero dependencies, cross-platform, no `node:` import.
 */
import { collapseBlank, preprocess } from "./glsl-preprocess.js";
import type { DefineList } from "./glsl-preprocess.js";
import { pruneWgsl } from "./wgsl-prune.js";
import { applyFlagsFromDefines, emitComputeDayColorWgsl, textureUnitsFromDefines } from "./generated-fragments.js";
import type { ApplyFlags } from "./generated-fragments.js";
import { attributeLayoutFromContract, deriveVaryingContract, emitVaryingStructs } from "./varying-contract.js";
import type { AttributeBinding, VaryingContract, VaryingRef } from "./varying-contract.js";
import { maxTextureUnitsFromLayout, uniformElementAccess } from "./bind-layout.js";
import type { BindLayoutResult } from "./bind-layout.js";
import { EXCLUDED_DEFINES } from "./terrain-variants.js";
import { WGSL_LEAVES } from "./wgsl/leaves.js";

/** The WGSL leaf library the emitter assembles (all four texts are templates; see `wgsl/index.ts`). */
export interface WgslLeafLibrary {
  readonly prelude: string;
  readonly vertex: string;
  readonly fragmentLibrary: string;
  readonly fragmentMain: string;
}

/** Defines whose GLSL regions the emitter deliberately does not implement (outside the MVP slice). */
export const UNSUPPORTED_BY_SCOPE: ReadonlySet<string> = new Set(EXCLUDED_DEFINES.map((entry) => entry.define));

/**
 * Defines the emitter can compile into a WGSL module.
 *
 * The list is explicit rather than "everything except the excluded set": a define the terrain path
 * never pushes but the emitter has no WGSL regions for must be refused, and an allow-list is the only
 * form of that statement that cannot silently widen when upstream adds a define.
 */
export const SUPPORTED_DEFINES: ReadonlySet<string> = new Set([
  "TEXTURE_UNITS",
  "QUANTIZATION_BITS12",
  "ENABLE_VERTEX_LIGHTING",
  "ENABLE_DAYNIGHT_SHADING",
  "GROUND_ATMOSPHERE",
  "PER_FRAGMENT_GROUND_ATMOSPHERE",
  "FOG",
  "INCLUDE_WEB_MERCATOR_Y",
  "APPLY_ALPHA",
  "GEODETIC_SURFACE_NORMALS",
  "EXAGGERATION",
]);

/**
 * The two dimensions upstream recomputes **inside a frame**, emitted as WGSL
 * **pipeline-overridable constants** instead of module text (G-6/T025 fix).
 *
 *   - `numberOfDayTextures` — the tile's imagery layer count
 *     (`GlobeSurfaceTileProvider.js:3035,3177`); a layer streaming in changes it mid-session.
 *   - `perFragmentGroundAtmosphere` — `cameraDistance > fadeOutDistance`
 *     (`GlobeSurfaceTileProvider.js:2600-2604`), recomputed every frame.
 *
 * Why they are not defines any more: built into the module text, each new value costs a full module
 * compile (measured 110.5 ms p50 / 138.1 ms p95 in the first G-6 run, 5× over the pre-registered
 * budget). As pipeline constants they cost a `createRenderPipeline` on an already-parsed module.
 * The constants are declared in **both** stages: WebGPU's pipeline `constants` map applies to the
 * whole pipeline, so a key that a stage's module does not declare is a validation error, and an
 * unused `override` declaration is legal (its default is simply never substituted).
 */
export const OVERRIDE_CONSTANTS: readonly { readonly name: string; readonly type: string; readonly from: string }[] = [
  { name: "numberOfDayTextures", type: "u32", from: "TEXTURE_UNITS (tile imagery layer count, GlobeSurfaceTileProvider.js:3035)" },
  { name: "perFragmentGroundAtmosphere", type: "u32", from: "PER_FRAGMENT_GROUND_ATMOSPHERE (camera distance, GlobeSurfaceTileProvider.js:2600-2604)" },
];

/** The `override` declarations every emitted module carries (both stages). */
export function emitOverrideDeclarations(): string {
  return [
    "// Pipeline-overridable constants (G-6/T025): the two dimensions that change **inside a frame**",
    "// live here, not in the module text, so a new value is a pipeline specialisation on this parsed",
    "// module instead of a new module. Declared in both stages because the pipeline `constants` map is",
    "// per pipeline, and a key a module does not declare is a validation error.",
    "override numberOfDayTextures : u32 = 0u;",
    "override perFragmentGroundAtmosphere : u32 = 0u;",
  ].join("\n");
}

/** The define names consumed by the pipeline constants (they must not reach the module text). */
export const OVERRIDE_DEFINES: ReadonlySet<string> = new Set(["TEXTURE_UNITS", "PER_FRAGMENT_GROUND_ATMOSPHERE"]);

/** The override values one variant's define set stands for (the pipeline `constants` map). */
export interface OverrideValues {
  readonly numberOfDayTextures: number;
  readonly perFragmentGroundAtmosphere: number;
}

export function overrideValuesForVariant(variant: { readonly defines: DefineList }): OverrideValues {
  return {
    numberOfDayTextures: textureUnitsFromDefines(variant.defines),
    perFragmentGroundAtmosphere: variant.defines.includes("PER_FRAGMENT_GROUND_ATMOSPHERE") ? 1 : 0,
  };
}

/** Stable identity of an override value tuple (`[numberOfDayTextures][flags]` at the pipeline level). */
export function overrideKey(overrides: OverrideValues): string {
  return OVERRIDE_CONSTANTS.map((constant) => `${constant.name}=${overrides[constant.name as keyof OverrideValues]}`).join(",");
}

/** One emission diagnostic. `severity: "error"` always accompanies `ok: false`. */
export interface ShaderEmissionDiagnostic {
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly defineSet?: string;
}

/** The `WgslEmission.emit(...)` request (research §6.3, made concrete). */
export interface WgslEmissionRequest {
  /** Stable variant identity (`<dimension>=<value>|…`), recorded on every diagnostic and in traces. */
  readonly variantKey: string;
  /** The assembled GLSL of both stages — produced by the *same* `ShaderSource` the GLSL channel uses. */
  readonly vertexGlsl: string;
  readonly fragmentGlsl: string;
  /**
   * The **witness** assembly the varying contract is derived from, when it must differ from the GLSL
   * above (G-6/T025).
   *
   * `PER_FRAGMENT_GROUND_ATMOSPHERE` is a pipeline-overridable constant, so one module text has to
   * satisfy **both** of its values. The pairing differs between them (in per-fragment mode the vertex
   * stage does not compute the atmosphere scattering and the fragment stage does not read it), and the
   * per-fragment pairing is a strict **subset** of the per-vertex one — so the module MUST use the
   * per-vertex (witness) pairing, which is the union. Without this input the emitter would derive the
   * pairing from whatever GLSL it was handed and the per-vertex/per-fragment variants would emit
   * *different module texts*, which both defeats the override and inflates the module count
   * (measured: 192 instead of 128 distinct texts over the same 768 reachable define sets).
   */
  readonly witness?: { readonly vertexGlsl: string; readonly fragmentGlsl: string; readonly defines: DefineList } | undefined;
  /** Upstream define list (both stages merged; the emitter splits it exactly like upstream does). */
  readonly defines: DefineList;
  /** Upstream `attributeLocations` (name → location), passed through untouched. */
  readonly attributeLocations?: Readonly<Record<string, number>> | null;
  /** Upstream `ShaderDestination` for this emission; `both` when the caller has one assembly. */
  readonly destination?: "vertex" | "fragment" | "both";
  /** `TEXTURE_UNITS` of this variant — the `numberOfDayTextures` override value. */
  readonly textureUnits: number;
  /** The imagery flags (`generated-fragments.applyFlagsFromDefines` result or a raw bitmask). */
  readonly flags: ApplyFlags | number;
  /** The bind layout the uniform struct and the samplers come from (`bind-layout.buildBindLayout`). */
  readonly layout: BindLayoutResult;
  /** The `czm_`/leaf library; defaults to the frozen production library. */
  readonly leaves?: WgslLeafLibrary;
  readonly sceneMode?: string;
  /** `true` to keep the whole prelude (debugging/measurement); `false` (default) prunes. */
  readonly keepWholePrelude?: boolean;
}

/** The structure report of one successful emission (the machine model G-6 and the gates consume). */
export interface WgslEmissionStructure {
  readonly defines: readonly string[];
  readonly overrides: OverrideValues;
  readonly overrideKey: string;
  readonly paired: readonly string[];
  readonly attributes: readonly string[];
  readonly vertexBufferLayout: ReturnType<typeof attributeLayoutFromContract>;
  readonly uniformMembers: number;
  readonly samplerBindings: number;
  readonly bindsComputeDayColor: boolean;
  readonly pruning: {
    readonly vertex: { readonly emittedBytes: number; readonly keptBytes: number; readonly removedBytes: number; readonly removedDeclarations: number };
    readonly fragment: { readonly emittedBytes: number; readonly keptBytes: number; readonly removedBytes: number; readonly removedDeclarations: number };
  };
}

/** The `WgslEmission.emit(...)` result (research §6.3). */
export interface WgslEmissionResult {
  readonly ok: boolean;
  /** WGSL module text of the vertex stage; `null` when `ok === false`. */
  readonly vertexModule: string | null;
  readonly fragmentModule: string | null;
  readonly varyingSet: readonly VaryingRef[];
  readonly bindLayout: BindLayoutResult | null;
  /** The vertex attribute bindings, upstream names → locations, passed through unchanged. */
  readonly attributeBindings: readonly AttributeBinding[];
  readonly diagnostics: readonly ShaderEmissionDiagnostic[];
  readonly contract: VaryingContract | null;
  readonly structure: WgslEmissionStructure | null;
}

/**
 * Declarations the pruner MUST keep even when an entry point does not reach them (T074).
 *
 * The depth-range remap is a **pair**: the write side (`czms_remapClipDepth`) is called by the vertex
 * entry point and survives pruning on its own, but the inverse (`czms_unprojectDepth`) is only *called*
 * by code that reconstructs eye coordinates from a depth value — which the terrain closure does not do
 * today, so a pure reachability walk drops it and the pair would exist only in the source, not in the
 * artefact `assertDepthRangePair()` inspects. Keeping both makes the contract checkable on the emitted
 * text at a cost of ~90 bytes per module.
 */
export const DEPTH_RANGE_PAIR_ROOTS: readonly string[] = ["czms_remapClipDepth", "czms_unprojectDepth"];

/** Defines present in the variant that the emitter must refuse (explicitly, with a reason). */
export function unsupportedDefines(variant: { readonly defines: DefineList }): { readonly define: string; readonly reason: string }[] {
  const unsupported: { define: string; reason: string }[] = [];
  for (const define of variant.defines) {
    const name = define.split(/\s+/)[0] ?? "";
    if (SUPPORTED_DEFINES.has(name)) continue;
    unsupported.push({
      define,
      reason: UNSUPPORTED_BY_SCOPE.has(name)
        ? "outside the MVP slice (registered with its upstream source in terrain-variants.EXCLUDED_DEFINES)"
        : "not a define this emitter knows; refusing to emit rather than degrade silently",
    });
  }
  return unsupported;
}

/** The emitter-internal defines that select the runtime-generated fragments (contract R6). */
export function emitterDefinesFor(defines: DefineList, contract: VaryingContract, sceneMode: string): string[] {
  const all = [...defines];
  for (const entry of contract.varyingSet) all.push(`PAIR_${entry.name}`);
  all.push(sceneMode === "SCENE3D" ? "POSITION_MODE_3D" : "POSITION_MODE_COLUMBUS_2D");
  all.push("Y_FRACTION_MERCATOR");
  return all;
}

/** The `@group(0)` binding for the uniform block, plus the sampler pairs of their own group. */
function emitBindings(layout: BindLayoutResult): string {
  return layout.wgslBindings;
}

/**
 * Emit one variant.
 *
 * @returns `ok: false` with diagnostics and **no module** when the define set is outside the MVP
 *   slice or the varying pairing is not satisfiable. A caller that ignores `ok` cannot accidentally
 *   ship a degraded module.
 */
export function emitTerrainWgsl(request: WgslEmissionRequest): WgslEmissionResult {
  const { variantKey, defines, layout } = request;
  const leaves = request.leaves ?? WGSL_LEAVES;
  const sceneMode = request.sceneMode ?? "SCENE3D";
  const diagnostics: ShaderEmissionDiagnostic[] = [];

  const unsupported = unsupportedDefines({ defines });
  if (unsupported.length > 0) {
    for (const entry of unsupported) diagnostics.push({ severity: "error", message: `unsupported define "${entry.define}": ${entry.reason}`, defineSet: variantKey });
    return { ok: false, vertexModule: null, fragmentModule: null, varyingSet: [], bindLayout: null, attributeBindings: [], diagnostics, contract: null, structure: null };
  }

  const contract = deriveVaryingContract({
    vertexSource: request.witness?.vertexGlsl ?? request.vertexGlsl,
    fragmentSource: request.witness?.fragmentGlsl ?? request.fragmentGlsl,
    defines: request.witness?.defines ?? defines,
    variantKey,
    attributeLocations: request.attributeLocations ?? null,
    source:
      request.witness === undefined
        ? "this variant's own assembled GLSL"
        : "per-vertex witness (union: PER_FRAGMENT_GROUND_ATMOSPHERE is a pipeline override)",
  });
  if (!contract.consistent) {
    // A fragment input without a matching vertex output is a hard `CreateRenderPipeline` failure in
    // WebGPU (spike REPORT §4 E1). The emitter refuses; the caller records it as an emission failure.
    diagnostics.push({
      severity: "error",
      message: `varying pairing is not satisfiable: ${JSON.stringify(contract.differences.unpairedFragmentInputs)} ${JSON.stringify(contract.differences.typeMismatches)}`,
      defineSet: variantKey,
    });
    return { ok: false, vertexModule: null, fragmentModule: null, varyingSet: contract.varyingSet, bindLayout: null, attributeBindings: contract.attributes, diagnostics, contract, structure: null };
  }

  const emissionDefines = emitterDefinesFor(defines, contract, sceneMode);
  const evaluate = (source: string): string => {
    const evaluated = preprocess(source, emissionDefines, { substituteText: false, variantKey });
    for (const diagnostic of evaluated.diagnostics) diagnostics.push({ severity: "error", message: `line ${diagnostic.line}: ${diagnostic.directive}: ${diagnostic.message}`, defineSet: variantKey });
    // `activeText` is the preprocessed result: inactive regions and the directives themselves are
    // gone. (Using `text` would ship *every* branch — the WGSL compiler then reports redeclarations.)
    return collapseBlank(evaluated.activeText);
  };

  const structs = emitVaryingStructs(contract, { fragmentBuiltins: true });
  const uniforms = [layout.wgslStruct, emitBindings(layout)].join("\n\n");
  const overrides = overrideValuesForVariant({ defines });
  const overridesWgsl = emitOverrideDeclarations();
  const computeDayColor = emitComputeDayColorWgsl({
    maxTextureUnits: maxTextureUnitsFromLayout(layout),
    apply: typeof request.flags === "number" ? applyFlagsFromMask(request.flags) : request.flags,
    access: uniformElementAccess(layout),
  });

  // The header MUST NOT carry anything that depends on a pipeline-overridable constant, or the module
  // text would vary with the very dimensions the constants are supposed to move out of it (the first
  // version printed the variant id and the full define list and reproduced the 768-text explosion).
  const staticDefines = defines.filter((define) => !OVERRIDE_DEFINES.has(define.split(/\s+/)[0] ?? ""));
  const header = [
    "// Generated by packages/cesium-webgpu/backend-webgpu/webgpu/wgsl-emitter.ts (tasks.md T073/T074).",
    `// Module-static upstream defines: ${staticDefines.join(" ") || "(none)"}`,
    `// Pipeline-overridable constants (NOT part of this text — see the declarations below): ${OVERRIDE_CONSTANTS.map((constant) => constant.name).join(", ")}`,
    `// Varying set (derived from the real assembled GLSL, not from the WGSL): ${contract.varyingSet.map((entry) => `${entry.name}@${entry.wgslLocation}`).join(" ") || "(none)"}`,
  ].join("\n");

  const vertexWgsl = [header, overridesWgsl, evaluate(leaves.prelude), uniforms, structs.vertexStruct, structs.vertexOutputStruct, evaluate(leaves.vertex), ""].join("\n\n");
  const fragmentWgsl = [header, overridesWgsl, evaluate(leaves.prelude), uniforms, structs.fragmentStruct, evaluate(leaves.fragmentLibrary), computeDayColor, evaluate(leaves.fragmentMain), ""].join("\n\n");

  // Second half of the G-6 fix: emit only what the entry point can reach. The whole `czm_` prelude is
  // inlined into both stages, but a variant calls a fraction of it, and pipeline creation on the
  // measured device is dominated by module size. The elimination is conservative — it can only keep
  // too much, never drop something reachable (`wgsl-prune.ts`).
  const keepWhole = request.keepWholePrelude === true;
  const vertexPruned = keepWhole ? { text: vertexWgsl, keptBytes: vertexWgsl.length, dropped: [] as string[], droppedBytes: 0, kept: [] as string[] } : pruneWgsl(vertexWgsl, { roots: ["vs_main", ...DEPTH_RANGE_PAIR_ROOTS] });
  const fragmentPruned = keepWhole ? { text: fragmentWgsl, keptBytes: fragmentWgsl.length, dropped: [] as string[], droppedBytes: 0, kept: [] as string[] } : pruneWgsl(fragmentWgsl, { roots: ["fs_main", ...DEPTH_RANGE_PAIR_ROOTS] });

  return {
    ok: true,
    vertexModule: vertexPruned.text,
    fragmentModule: fragmentPruned.text,
    varyingSet: contract.varyingSet,
    bindLayout: layout,
    attributeBindings: contract.attributes,
    diagnostics,
    contract,
    structure: {
      defines: [...defines],
      overrides,
      overrideKey: overrideKey(overrides),
      paired: contract.varyingSet.map((entry) => `${entry.name}@${entry.wgslLocation}`),
      attributes: contract.attributes.map((entry) => `${entry.name}@${entry.location}`),
      vertexBufferLayout: attributeLayoutFromContract(contract),
      uniformMembers: layout.uniformBlock.fields.length,
      samplerBindings: layout.samplers.length,
      bindsComputeDayColor: computeDayColor.length > 0,
      pruning: {
        vertex: { emittedBytes: vertexWgsl.length, keptBytes: vertexPruned.keptBytes, removedBytes: vertexWgsl.length - vertexPruned.keptBytes, removedDeclarations: vertexPruned.dropped.length },
        fragment: { emittedBytes: fragmentWgsl.length, keptBytes: fragmentPruned.keptBytes, removedBytes: fragmentWgsl.length - fragmentPruned.keptBytes, removedDeclarations: fragmentPruned.dropped.length },
      },
    },
  };
}

/** Decode a raw `APPLY_*` bitmask (the order of `APPLY_FLAG_DEFINES`) into flag booleans. */
export function applyFlagsFromMask(mask: number): ApplyFlags {
  return {
    alpha: (mask & 1) !== 0,
    dayNightAlpha: (mask & 2) !== 0,
    split: (mask & 4) !== 0,
    brightness: (mask & 8) !== 0,
    contrast: (mask & 16) !== 0,
    hue: (mask & 32) !== 0,
    saturation: (mask & 64) !== 0,
    gamma: (mask & 128) !== 0,
    colorToAlpha: (mask & 256) !== 0,
  };
}

// ------------------------------------------------------------------------------------------------
// T074 — the depth-range pair, as a machine check
// ------------------------------------------------------------------------------------------------

export interface DepthRangeCheck {
  readonly ok: boolean;
  readonly failures: readonly string[];
  /** Every `@builtin(position)` / `@builtin(frag_depth)` assignment found in the module. */
  readonly writePoints: readonly { readonly line: number; readonly text: string; readonly remapped: boolean }[];
  readonly remapDeclared: boolean;
  readonly unprojectDeclared: boolean;
  /** `czm_inverseProjection` / `czm_windowToEyeCoordinates` uses, each of which needs `czms_unprojectDepth`. */
  readonly depthReconstructionSites: readonly { readonly line: number; readonly text: string; readonly paired: boolean }[];
}

/**
 * T074's assertion: in the emitted modules, every depth write is remapped **and** every depth
 * reconstruction has the inverse available.
 *
 * The check is textual on purpose — it runs on the artefact the device receives, and it is the half of
 * T074 that a GPU-free CI can execute. The other half (that the remap is *correct*) is the real-device
 * golden readback (`tools/shader-verify.mjs --variants=mvp`).
 */
export function assertDepthRangePair(vertexModule: string, fragmentModule: string): DepthRangeCheck {
  const failures: string[] = [];
  const writePoints: { line: number; text: string; remapped: boolean }[] = [];
  const depthReconstructionSites: { line: number; text: string; paired: boolean }[] = [];
  const WRITE = /\b(out|output|result)\.position\s*=|\bgl_Position\b|@builtin\(frag_depth\)\s+[A-Za-z_]\w*\s*\)\s*(?:->|:)/;
  const REMAPPED = /czms_remapClipDepth\s*\(/;

  for (const [stage, text] of [
    ["vertex", vertexModule],
    ["fragment", fragmentModule],
  ] as const) {
    text.split("\n").forEach((line, index) => {
      if (WRITE.test(line) && line.includes("=")) {
        const remapped = REMAPPED.test(line);
        writePoints.push({ line: index + 1, text: `${stage}: ${line.trim().slice(0, 120)}`, remapped });
        if (!remapped) failures.push(`${stage}: depth write at line ${index + 1} is not remapped: ${line.trim().slice(0, 120)}`);
      }
      if (/\bczm\.czm_inverseProjection\b|\bczm_inverseProjection\b|\bczm\.czm_windowToEyeCoordinates\b/.test(line)) {
        depthReconstructionSites.push({ line: index + 1, text: `${stage}: ${line.trim().slice(0, 120)}`, paired: /czms_unprojectDepth\s*\(/.test(line) || /czms_unprojectDepth\s*\(/.test(text) });
      }
    });
  }

  const remapDeclared = /\bfn\s+czms_remapClipDepth\b/.test(vertexModule) || /\bfn\s+czms_remapClipDepth\b/.test(fragmentModule);
  const unprojectDeclared = /\bfn\s+czms_unprojectDepth\b/.test(vertexModule) || /\bfn\s+czms_unprojectDepth\b/.test(fragmentModule);
  if (!remapDeclared) failures.push("the depth remap helper `czms_remapClipDepth` is not present in the emitted modules");
  if (!unprojectDeclared) failures.push("the inverse helper `czms_unprojectDepth` is not present in the emitted modules — the pair is incomplete");
  if (writePoints.length === 0) failures.push("no depth write point was found in the emitted modules — the check has no subject");
  for (const site of depthReconstructionSites) if (!site.paired) failures.push(`a depth reconstruction at ${site.text} does not go through czms_unprojectDepth`);

  return { ok: failures.length === 0, failures, writePoints, remapDeclared, unprojectDeclared, depthReconstructionSites };
}

/**
 * `WgslEmission` — the internal interface research §6.3 names. Kept as a namespace object so the
 * signature is greppable as `WgslEmission.emit` and so the module can expose the helpers alongside it.
 */
export const WgslEmission = {
  emit: emitTerrainWgsl,
  overrideConstants: OVERRIDE_CONSTANTS,
  overrideValuesForVariant,
  overrideKey,
  supportedDefines: SUPPORTED_DEFINES,
  unsupportedDefines,
  assertDepthRangePair,
} as const;
