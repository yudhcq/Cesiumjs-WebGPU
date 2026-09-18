/**
 * G-5 gate — the **WGSL emission channel** of the parameterised shader assembly seam
 * (tasks.md T022–T024; research §6.3 `WgslEmission.emit(...)`; contracts/fork-patch-layer R1–R6).
 *
 * The seam keeps the upstream inputs untouched — the **same** `sources` + `defines` that produce
 * the GLSL also produce the WGSL; nothing is translated from GLSL text. What WGSL needs and GLSL
 * gets from the driver is computed here:
 *
 *   1. **conditional compilation** (`glsl-preprocess.mjs`, contract R4) selects the live regions of
 *      the WGSL leaf library — WGSL has no preprocessor;
 *   2. **varying pairing** (`varying-pairing.mjs`, contract R5) is *derived from the real assembled
 *      GLSL* and fed back in as `PAIR_<name>` defines, so the emitted vertex stage writes exactly the
 *      varyings the emitted fragment stage reads (mirroring the GL linker's pruning);
 *   3. the **uniform struct + bindings** come from the H-4 layout table (G-4's generator), so the
 *      binding layout is the one a real device already accepted;
 *   4. the **runtime-generated** fragments (`computeDayColor`, `getPosition`) come from
 *      `mirror-generators.mjs` (contract R6).
 *
 * Coverage discipline (T023 (c)): the emitter has an explicit `SUPPORTED_DEFINES` set. Anything
 * outside it produces an **explicit diagnostic** and *no module* — it never silently degrades, and
 * the caller is required to treat that as a failure of the gate rather than as a skip.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collapseBlank, preprocess } from "./glsl-preprocess.mjs";
import { pruneWgsl } from "./wgsl-prune.mjs";
import { applyFlagsFromDefines, emitComputeDayColorWgsl, textureUnitsFromDefines } from "./mirror-generators.mjs";
import { attributeLayoutFromDerivation, emitVaryingStructs } from "./varying-pairing.mjs";
import { DEFINE_DESTINATION, EXCLUDED_DEFINES } from "./define-matrix.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WGSL_DIR = path.join(HERE, "wgsl");

/** Defines whose GLSL regions the emitter deliberately does not implement (out of the MVP slice). */
export const UNSUPPORTED_BY_SCOPE = new Set(EXCLUDED_DEFINES.map((entry) => entry.define));

/**
 * Defines the emitter can compile into a WGSL module. Everything else is rejected with a diagnostic
 * rather than degraded — including the G-4 `EXCLUDED_DEFINES`, whose WGSL regions this emitter does
 * **not** carry: emitting them would silently produce a module missing behaviour (T023 (c)). The
 * first version of this set forgot to subtract them and the gate's own
 * `uncovered-define-sets-fail-explicitly-not-silently` check caught it.
 */
export const SUPPORTED_DEFINES = new Set(Object.keys(DEFINE_DESTINATION).filter((name) => !UNSUPPORTED_BY_SCOPE.has(name)));

/** Preloaded WGSL leaves (module scope; the emitter runs the preprocessor over them per variant). */
export const WGSL_LEAVES = {
  prelude: fs.readFileSync(path.join(WGSL_DIR, "prelude.wgsl"), "utf8"),
  vertex: fs.readFileSync(path.join(WGSL_DIR, "terrain-vs.wgsl"), "utf8"),
  fragmentLibrary: fs.readFileSync(path.join(WGSL_DIR, "terrain-fs-lib.wgsl"), "utf8"),
  fragmentMain: fs.readFileSync(path.join(WGSL_DIR, "terrain-fs-main.wgsl"), "utf8"),
};

/** Emitter-internal defines that select the runtime-generated fragments (contract R6). */
export function emitterDefinesFor(variant, derivation) {
  const defines = [...variant.defines];
  for (const entry of derivation.paired) defines.push(`PAIR_${entry.name}`);
  defines.push(variant.sceneMode === "SCENE3D" ? "POSITION_MODE_3D" : "POSITION_MODE_COLUMBUS_2D");
  defines.push("Y_FRACTION_MERCATOR");
  return defines;
}

/**
 * The two dimensions upstream recomputes **inside a frame**, emitted as WGSL
 * **pipeline-overridable constants** instead of module text (G-6/T025 fix; `plan.md` G-6 row).
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
export const OVERRIDE_CONSTANTS = [
  { name: "numberOfDayTextures", type: "u32", from: "TEXTURE_UNITS (tile imagery layer count, GlobeSurfaceTileProvider.js:3035)" },
  { name: "perFragmentGroundAtmosphere", type: "u32", from: "PER_FRAGMENT_GROUND_ATMOSPHERE (camera distance, GlobeSurfaceTileProvider.js:2600-2604)" },
];

/** The `override` declarations every emitted module carries (both stages). */
export function emitOverrideDeclarations() {
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
export const OVERRIDE_DEFINES = new Set(["TEXTURE_UNITS", "PER_FRAGMENT_GROUND_ATMOSPHERE"]);

/** The override values one variant's define set stands for (the pipeline `constants` map). */
export function overrideValuesForVariant(variant) {
  return {
    numberOfDayTextures: textureUnitsFromDefines(variant.defines),
    perFragmentGroundAtmosphere: variant.defines.includes("PER_FRAGMENT_GROUND_ATMOSPHERE") ? 1 : 0,
  };
}

/** Stable identity of an override value tuple (`[numberOfDayTextures][flags]` at the pipeline level). */
export function overrideKey(overrides) {
  return OVERRIDE_CONSTANTS.map((constant) => `${constant.name}=${overrides[constant.name]}`).join(",");
}

/** The number of `u_dayTextures` bindings the layout declares: the chain can never exceed it. */
export function maxTextureUnitsFromLayout(layout) {
  const units = layout.samplers.filter((sampler) => sampler.glslName === "u_dayTextures").length;
  if (units < 1) throw new Error("g5: the uniform layout declares no u_dayTextures binding — cannot size computeDayColor");
  return units;
}

/**
 * A uniform-array element access rendered **from the H-4 layout table**.
 *
 * The uniform address space requires a 16-byte element stride, and because WGSL derives the stride
 * from the element type a packed `float[]`/`bool[]` is widened to `vec4<f32>`/`vec4<u32>` by the G-4
 * generator (see its `PADDED_ELEMENT_WGSL`). Only the first lane(s) of such an element are
 * meaningful, so the emitted read appends `.x`/`.xy`. Deriving the suffix from the table — instead of
 * hard-coding it in the WGSL leaves — is what keeps the emitted text and the CPU-side writer from
 * silently disagreeing when the layout changes.
 */
export function uniformElementAccess(layout) {
  return (name, index) => {
    const member = layout.members.find((candidate) => candidate.name === name);
    if (member === undefined || member.paddedElement !== true) return `czm.${name}[${index}]`;
    return `czm.${name}[${index}].${"xyzw".slice(0, member.components)}`;
  };
}

/** Defines present in the variant that the emitter must refuse (explicitly, with a reason). */
export function unsupportedDefines(variant) {
  const unsupported = [];
  for (const define of variant.defines) {
    const name = define.split(/\s+/)[0];
    if (SUPPORTED_DEFINES.has(name)) continue;
    unsupported.push({
      define,
      reason: UNSUPPORTED_BY_SCOPE.has(name)
        ? "outside the MVP slice (registered with its upstream source in define-matrix.mjs EXCLUDED_DEFINES)"
        : "not a define this emitter knows; refusing to emit rather than degrade silently (T023 (c))",
    });
  }
  return unsupported;
}

/** The `@group(0)` bindings: one uniform buffer + one (texture, sampler) pair per sampler entry. */
function emitBindings(layout) {
  const lines = [`@group(0) @binding(0) var<uniform> czm : ${layout.structName};`];
  for (const sampler of layout.samplers) {
    lines.push(`@group(0) @binding(${sampler.textureBinding}) var ${sampler.name}_texture : ${sampler.textureType};`);
    lines.push(`@group(0) @binding(${sampler.samplerBinding}) var ${sampler.name}_sampler : sampler;`);
  }
  return lines.join("\n");
}

/**
 * Emit one variant.
 *
 * @param {{variant: object, glsl: {vertexSource: string, fragmentSource: string}, derivation: object,
 *          layout: object, leaves?: object}} input
 * @returns {{ok: boolean, vertexWgsl: string|null, fragmentWgsl: string|null, diagnostics: object[],
 *            unsupported: object[], structure: object}}
 */
export function emitTerrainWgsl({ variant, glsl, derivation, layout, leaves = WGSL_LEAVES }) {
  const unsupported = unsupportedDefines(variant);
  const diagnostics = [];
  if (unsupported.length > 0) {
    return { ok: false, vertexWgsl: null, fragmentWgsl: null, diagnostics, unsupported, structure: null };
  }
  if (!derivation.consistent) {
    // A fragment input without a matching vertex output is a hard `CreateRenderPipeline` failure in
    // WebGPU (spike REPORT §4 E1). The emitter refuses; the caller records it as an emission failure.
    return {
      ok: false,
      vertexWgsl: null,
      fragmentWgsl: null,
      diagnostics: [{ message: `varying pairing is not satisfiable: ${JSON.stringify(derivation.unpairedFragmentInputs)}` }],
      unsupported: [],
      structure: null,
    };
  }

  const defines = emitterDefinesFor(variant, derivation);
  const evaluate = (source) => {
    const evaluated = preprocess(source, defines, { substituteText: false });
    for (const diagnostic of evaluated.diagnostics) diagnostics.push({ ...diagnostic, defineSet: variant.id });
    // `activeText` is the preprocessed result: inactive regions and the directives themselves are
    // gone. (Using `text` would ship *every* branch — the WGSL compiler then reports redeclarations.)
    return collapseBlank(evaluated.activeText);
  };

  const structs = emitVaryingStructs(derivation, { fragmentBuiltins: true });
  const uniforms = [layout.wgslStruct, emitBindings(layout)].join("\n\n");
  const overrides = overrideValuesForVariant(variant);
  const overridesWgsl = emitOverrideDeclarations();
  const computeDayColor = emitComputeDayColorWgsl({
    maxTextureUnits: maxTextureUnitsFromLayout(layout),
    apply: applyFlagsFromDefines(variant.defines),
    access: uniformElementAccess(layout),
  });

  // The header MUST NOT carry anything that depends on a pipeline-overridable constant, or the module
  // text would vary with the very dimensions the constants are supposed to move out of it (the first
  // version printed the variant id and the full define list and reproduced the 768-text explosion).
  const staticDefines = variant.defines.filter((define) => !OVERRIDE_DEFINES.has(define.split(/\s+/)[0]));
  const header = [
    `// Generated by experiments/gates/g5-shader/wgsl-emitter.mjs (G-5 gate, tasks.md T022-T024).`,
    `// Module-static upstream defines: ${staticDefines.join(" ") || "(none)"}`,
    `// Pipeline-overridable constants (NOT part of this text — see the declarations below): ${OVERRIDE_CONSTANTS.map((constant) => constant.name).join(", ")}`,
    `// Varying set (derived from the real assembled GLSL, not from the WGSL): ${derivation.paired.map((entry) => `${entry.name}@${entry.location}`).join(" ") || "(none)"}`,
  ].join("\n");

  const vertexWgsl = [header, overridesWgsl, evaluate(leaves.prelude), uniforms, structs.vertexStruct, structs.vertexOutputStruct, evaluate(leaves.vertex), ""].join("\n\n");
  const fragmentWgsl = [
    header,
    overridesWgsl,
    evaluate(leaves.prelude),
    uniforms,
    structs.fragmentStruct,
    evaluate(leaves.fragmentLibrary),
    computeDayColor,
    evaluate(leaves.fragmentMain),
    "",
  ].join("\n\n");
  // Second half of the G-6 fix: emit only what the entry point can reach. The whole `czm_` prelude is
  // inlined into both stages, but a variant calls a fraction of it, and pipeline creation on the
  // measured device is dominated by module size (plan.md G-6 修复(b)). The elimination is
  // conservative — it can only keep too much, never drop something reachable (wgsl-prune.mjs).
  const vertexPruned = pruneWgsl(vertexWgsl, { roots: ["vs_main"] });
  const fragmentPruned = pruneWgsl(fragmentWgsl, { roots: ["fs_main"] });

  return {
    ok: true,
    vertexWgsl: vertexPruned.text,
    fragmentWgsl: fragmentPruned.text,
    diagnostics,
    unsupported: [],
    structure: {
      defines,
      overrides,
      overrideKey: overrideKey(overrides),
      paired: derivation.paired.map((entry) => `${entry.name}@${entry.location}`),
      attributes: derivation.attributes.map((entry) => `${entry.name}@${entry.location}`),
      vertexBufferLayout: attributeLayoutFromDerivation(derivation),
      uniformMembers: layout.members.length,
      samplerBindings: layout.samplers.length,
      bindsComputeDayColor: computeDayColor.length > 0,
      pruning: {
        vertex: { emittedBytes: vertexWgsl.length, keptBytes: vertexPruned.keptBytes, removedBytes: vertexPruned.droppedBytes, removedDeclarations: vertexPruned.dropped.length },
        fragment: { emittedBytes: fragmentWgsl.length, keptBytes: fragmentPruned.keptBytes, removedBytes: fragmentPruned.droppedBytes, removedDeclarations: fragmentPruned.dropped.length },
      },
    },
  };
}
