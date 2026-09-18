/**
 * G-5 gate — the single source of truth for "what the gate verified".
 *
 * `buildGateModel()` enumerates the MVP-reachable define matrix, assembles the **real** GLSL for
 * each variant through the upstream `ShaderSource`, derives its varying pairs from that GLSL, takes
 * the union of the referenced uniforms (H-4's layout generator) and emits the WGSL module pair.
 *
 * Everything else in G-5 (the model report, the device sweep, the gate verdict) is computed from
 * this model, so no artefact can drift from another.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { layoutUniforms } from "../g4-uniform-layout/uniform-layout.mjs";
import { collectDeclaredUniforms, collectReferencedIdentifiers } from "../g4-uniform-layout/assemble-glsl.mjs";
import { REACHABLE_DIMENSIONS, ALWAYS_DEFINES, EXCLUDED_DEFINES, MVP_SCENE_MODE, assembleGlslForVariant, enumerateReachableVariants, perVertexWitnessVariant } from "./define-matrix.mjs";
import { deriveVaryingPairs } from "./varying-pairing.mjs";
import { emitTerrainWgsl } from "./wgsl-emitter.mjs";

export const GATE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(GATE_DIR, "..", "..", "..");
export const OUT_DIR = path.join(REPO_ROOT, "experiments", "gates", "out");

/** Uniforms the assembled GLSL for one variant declares (conditionals evaluated). */
export function referencedUniforms(glsl, defines) {
  const declared = new Map();
  for (const stage of [glsl.vertexSource, glsl.fragmentSource]) {
    for (const [name, entry] of collectDeclaredUniforms(stage, defines)) {
      const existing = declared.get(name);
      if (existing === undefined) declared.set(name, { ...entry });
      else {
        if (existing.glslType !== entry.glslType) throw new Error(`g5: uniform "${name}" has conflicting types across stages (${existing.glslType} vs ${entry.glslType})`);
        // `TEXTURE_UNITS`-sized arrays legitimately differ in length between variants; the union
        // layout takes the maximum, and the per-variant length is recorded.
        existing.size = Math.max(existing.size, entry.size);
      }
    }
  }
  const referenced = new Set([...collectReferencedIdentifiers(glsl.vertexSource, defines), ...collectReferencedIdentifiers(glsl.fragmentSource, defines)]);
  return [...declared.values()].filter((entry) => referenced.has(entry.name));
}

/**
 * A fast, provably-sufficient subset for the uniform union.
 *
 * Every uniform is introduced by at least one define, but some are introduced by a **conjunction**
 * (`uniform float u_dayTextureAlpha[TEXTURE_UNITS]` lives inside `#if TEXTURE_UNITS > 0 && APPLY_ALPHA`),
 * so a single-dimension sweep from one base is not enough. The subset therefore contains, for two
 * bases (the first and the last variant) and for every pair of dimensions, the variants that deviate
 * on exactly those dimensions. `run.mjs` **asserts** that this subset's union equals the union over
 * the full cross product, so the shortcut can never silently under-cover.
 */
export function enumerateMarginals() {
  const all = enumerateReachableVariants();
  const dimensionIds = [...new Set(all.flatMap((variant) => variant.selection.map((entry) => entry.id)))];
  const keyOf = (selection) => selection.map((entry) => `${entry.id}=${entry.value}`).join("|");
  const byId = (selection, id) => selection.find((entry) => entry.id === id).value;
  const bases = [all[0], all[all.length - 1]];
  const wanted = new Set([keyOf(all[0].selection), keyOf(all[all.length - 1].selection)]);

  for (const base of bases) {
    for (const first of dimensionIds) {
      for (const second of dimensionIds) {
        if (first !== second && dimensionIds.indexOf(second) < dimensionIds.indexOf(first)) continue;
        const last = all[all.length - 1];
        const selection = base.selection.map((entry) => {
          if (entry.id === first || entry.id === second) return { id: entry.id, value: byId(last.selection, entry.id) };
          return entry;
        });
        wanted.add(keyOf(selection));
      }
      // also every individual value of every dimension on top of this base
      for (const value of [...new Set(all.map((variant) => byId(variant.selection, first)))]) {
        wanted.add(keyOf(base.selection.map((entry) => (entry.id === first ? { id: entry.id, value } : entry))));
      }
    }
  }
  return all.filter((variant) => wanted.has(keyOf(variant.selection)));
}

/** Uniform union (name → glslType/size, max size over the variants) for a variant subset. */
export function unionOfVariants(variants) {
  const union = new Map();
  for (const variant of variants) {
    const glsl = assembleGlslForVariant(variant);
    for (const uniform of referencedUniforms(glsl, variant.defines)) {
      const existing = union.get(uniform.name);
      if (existing === undefined) union.set(uniform.name, { name: uniform.name, glslType: uniform.glslType, size: uniform.size });
      else {
        if (existing.glslType !== uniform.glslType) throw new Error(`g5: uniform "${uniform.name}" conflicts across variants`);
        existing.size = Math.max(existing.size, uniform.size);
      }
    }
  }
  return [...union.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The H-4 layout for a variant subset (used by the `mvp` mode of `tools/shader-verify.mjs`). */
export function buildUnionLayout(variants = enumerateMarginals(), structName = "TerrainUniforms") {
  return layoutUniforms(unionOfVariants(variants), { structName });
}

/**
 * @param {{variants?: object[], keepWgsl?: boolean, onEmission?: (entry: object, emission: object) => void}} [options]
 *   `keepWgsl` defaults to **false**: the full matrix is ~1.4 GB of WGSL text, so callers that need
 *   the text (the model report, the device sweep) consume it through `onEmission` and keep only what
 *   they need (hashes, group representatives).
 */
export function buildGateModel(options = {}) {
  const variants = options.variants ?? enumerateReachableVariants();
  const keepWgsl = options.keepWgsl === true;
  const union = new Map();
  const entries = [];

  for (const variant of variants) {
    const glsl = assembleGlslForVariant(variant);
    const uniforms = referencedUniforms(glsl, variant.defines);
    for (const uniform of uniforms) {
      const existing = union.get(uniform.name);
      if (existing === undefined) union.set(uniform.name, { name: uniform.name, glslType: uniform.glslType, size: uniform.size });
      else {
        if (existing.glslType !== uniform.glslType) throw new Error(`g5: uniform "${uniform.name}" conflicts across variants`);
        existing.size = Math.max(existing.size, uniform.size);
      }
    }
    // The varying set is derived from the real assembled GLSL. `PER_FRAGMENT_GROUND_ATMOSPHERE` is a
    // pipeline override, so the module has to satisfy *both* of its values: the pairing is derived from
    // the per-vertex witness (the union), not from the per-fragment subset (define-matrix.mjs).
    const witness = perVertexWitnessVariant(variant);
    const derivationGlsl = witness === null ? glsl : assembleGlslForVariant(witness);
    const derivation = deriveVaryingPairs({ vertexSource: derivationGlsl.vertexSource, fragmentSource: derivationGlsl.fragmentSource, defines: witness?.defines ?? variant.defines });
    derivation.source = witness === null ? "this variant's own assembled GLSL" : "per-vertex witness (union: PER_FRAGMENT_GROUND_ATMOSPHERE is a pipeline override)";
    entries.push({ variant, glsl, uniforms, derivation });
  }

  const layout = layoutUniforms([...union.values()].sort((a, b) => a.name.localeCompare(b.name)), { structName: "TerrainUniforms" });

  let emitted = 0;
  let rejected = 0;
  const unsupportedDefines = new Map();
  for (const entry of entries) {
    const emission = emitTerrainWgsl({ variant: entry.variant, glsl: entry.glsl, derivation: entry.derivation, layout });
    entry.emission = {
      ok: emission.ok,
      structure: emission.structure,
      unsupported: emission.unsupported,
      diagnostics: emission.diagnostics,
      ...(keepWgsl ? { vertexWgsl: emission.vertexWgsl, fragmentWgsl: emission.fragmentWgsl } : {}),
    };
    if (emission.ok) emitted += 1;
    else {
      rejected += 1;
      for (const unsupported of emission.unsupported) unsupportedDefines.set(unsupported.define, unsupported.reason);
    }
    // The GLSL text is not needed after emission and is by far the largest allocation.
    delete entry.glsl;
    if (options.onEmission !== undefined) options.onEmission(entry, emission);
  }

  const varyingShapes = new Map();
  for (const entry of entries) {
    if (!entry.emission.ok) continue;
    const key = entry.emission.structure.paired.join(",");
    varyingShapes.set(key, (varyingShapes.get(key) ?? 0) + 1);
  }

  return {
    variants: entries.map((entry) => entry.variant),
    entries,
    layout,
    unionUniforms: [...union.values()].sort((a, b) => a.name.localeCompare(b.name)),
    defineSpace: {
      sceneMode: MVP_SCENE_MODE,
      alwaysDefines: ALWAYS_DEFINES,
      dimensions: REACHABLE_DIMENSIONS.map((dimension) => ({
        id: dimension.id,
        values: dimension.values,
        excludedValues: dimension.excludedValues,
        justification: dimension.justification,
        source: dimension.source,
      })),
      excludedDefines: EXCLUDED_DEFINES,
    },
    stats: {
      defineCombinations: entries.length,
      emitted,
      rejected,
      unsupportedDefines: [...unsupportedDefines.entries()].map(([define, reason]) => ({ define, reason })),
      distinctVaryingSets: varyingShapes.size,
      varyingSetHistogram: [...varyingShapes.entries()].map(([paired, count]) => ({ paired: paired.length === 0 ? [] : paired.split(","), count })),
      uniformMembers: layout.members.length,
      samplerBindings: layout.samplers.length,
      structSize: layout.structSize,
    },
  };
}
