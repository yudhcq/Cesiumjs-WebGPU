#!/usr/bin/env node
/**
 * `tools/shader-model.mjs` — the **production** shader model: enumerate the MVP-reachable define
 * matrix, assemble the real GLSL through the installed upstream `ShaderSource` **and** through the
 * patch layer's replacement, derive the varying contract from that GLSL, build the union bind layout
 * and emit WGSL with the production emitter.
 *
 * This is the productionised counterpart of `experiments/gates/g5-shader/{define-matrix,model}.mjs`:
 * the gates proved the route with `.mjs` prototypes; every number they produced is reproduced here
 * through the code that actually ships (`packages/cesium-webgpu/backend-webgpu/webgpu/**` and
 * `.../Renderer/ShaderSource.ts`), which is what makes "re-run G-5 after W4" a real re-run rather
 * than a re-print.
 *
 * Two hard properties are computed here because everything else depends on them:
 *   - **GLSL byte identity**: `compareGlslChannels()` assembles each variant twice — once with the
 *     upstream class, once with the replacement — and compares the two texts byte for byte. The
 *     replacement's GLSL path is a faithful port, and this is the measurement that says so.
 *   - **emission closure**: a variant whose define set the emitter does not support is *rejected with
 *     a diagnostic*, never emitted with a missing region.
 *
 * Node-only, zero dependencies beyond the workspace, cross-platform.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { repoPath } from "../tests/support/repo.mjs";
import { loadTypeScriptModule } from "../tests/support/ts-module-loader.mjs";
import { upstreamStubs } from "../tests/support/upstream-stubs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
/** Where the gate artefacts live (`experiments/gates/out/`), the same location the gates used. */
export const OUT_DIR = path.join(REPO_ROOT, "experiments", "gates", "out");
const BACKEND = "packages/cesium-webgpu/backend-webgpu";
const WEBGPU = `${BACKEND}/webgpu`;

export const sha256 = (text) => `sha256-${createHash("sha256").update(text).digest("hex")}`;

/** The `Context` surface `ShaderSource.combineShader` reads. The SAME object for both channels. */
export const SHADER_CONTEXT_STUB = { webgl2: true, textureFloatLinear: false, floatingPointTexture: true, fragmentDepth: true };

/** Base sources exactly as `Scene/Globe.js:679-687` (`makeShadersDirty`) builds them for MVP. */
export async function baseSources() {
  const [AtmosphereCommon, GroundAtmosphere, GlobeFS, GlobeVS] = await Promise.all([
    import("@cesium/engine/Source/Shaders/AtmosphereCommon.js"),
    import("@cesium/engine/Source/Shaders/GroundAtmosphere.js"),
    import("@cesium/engine/Source/Shaders/GlobeFS.js"),
    import("@cesium/engine/Source/Shaders/GlobeVS.js"),
  ]);
  return {
    vertex: [AtmosphereCommon.default, GroundAtmosphere.default, GlobeVS.default],
    fragment: [AtmosphereCommon.default, GroundAtmosphere.default, GlobeFS.default],
    defines: [],
    source: "node_modules/@cesium/engine/Source/Scene/Globe.js:658-688 (makeShadersDirty, no material ⇒ defines=[])",
  };
}

/** The installed upstream module the replacement is compared against (the byte-identity oracle). */
export async function upstreamShaderSourceClass() {
  const module_ = await import("@cesium/engine/Source/Renderer/ShaderSource.js");
  return module_.default;
}

/** The `czm_` builtin/uniform table the upstream class builds, as a resolver for `glsl-preprocess`. */
export async function upstreamCzmResolver(ShaderSourceClass) {
  const table = ShaderSourceClass._czmBuiltinsAndUniforms;
  return (name) => table[name];
}

/** The automatic-uniform name set (needed so the layout can tell `origin: "automatic"`). */
export async function automaticUniformNames() {
  const module_ = await import("@cesium/engine/Source/Renderer/AutomaticUniforms.js");
  return new Set(Object.keys(module_.default));
}

/**
 * Load the production modules once: the replacement `ShaderSource`, the emitter, the bind layout,
 * the varying contract, the generated-fragment mirrors and the reachable define space.
 *
 * `externals` gives the replacement the same upstream collaborators the build would resolve, using
 * the **installed package** (not a stub) for the three that decide the GLSL bytes.
 */
export async function loadProduction() {
  const real = (specifier) => `export { default } from ${JSON.stringify(new URL(`../node_modules/${specifier}`, import.meta.url).href)};`;
  const externals = {
    ...upstreamStubs(),
    "@cesium/engine/Source/Shaders/Builtin/CzmBuiltins.js": real("@cesium/engine/Source/Shaders/Builtin/CzmBuiltins.js"),
    "@cesium/engine/Source/Renderer/AutomaticUniforms.js": real("@cesium/engine/Source/Renderer/AutomaticUniforms.js"),
    "@cesium/engine/Source/Renderer/demodernizeShader.js": real("@cesium/engine/Source/Renderer/demodernizeShader.js"),
  };
  const [shaderSource, emitter, bindLayout, varyingContract, fragments, variants, wgsl, prelude, shaderEmit] = await Promise.all([
    loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/ShaderSource.ts`), { externals }),
    loadTypeScriptModule(repoPath(`${WEBGPU}/wgsl-emitter.ts`)),
    loadTypeScriptModule(repoPath(`${WEBGPU}/bind-layout.ts`)),
    loadTypeScriptModule(repoPath(`${WEBGPU}/varying-contract.ts`)),
    loadTypeScriptModule(repoPath(`${WEBGPU}/generated-fragments.ts`)),
    loadTypeScriptModule(repoPath(`${WEBGPU}/terrain-variants.ts`)),
    loadTypeScriptModule(repoPath(`${WEBGPU}/wgsl/index.ts`)),
    loadTypeScriptModule(repoPath(`${WEBGPU}/wgsl-prelude/index.ts`)),
    loadTypeScriptModule(repoPath(`${WEBGPU}/shader-emit.ts`)),
  ]);
  return { ShaderSource: shaderSource.default, shaderSourceModule: shaderSource, emitter, bindLayout, varyingContract, fragments, variants, wgsl, prelude, shaderEmit };
}

/**
 * Assemble the real GLSL for one variant through a `ShaderSource` class (upstream or replacement),
 * including the runtime-generated `computeDayColor()` and the two position functions — exactly the
 * pushes `GlobeSurfaceShaderSet.js:472,474-475` performs. Without them the assembled GLSL does not
 * even compile in WebGL2 (`Function getPosition() called by main() is undefined`, G-5 finding F-7).
 */
export function assembleGlslForVariant(variant, { ShaderSourceClass, base, fragments, destinationOf = null, emit = "glsl", context = SHADER_CONTEXT_STUB }) {
  const vertexSource = new ShaderSourceClass({ sources: [...base.vertex], defines: [...base.defines] }).clone();
  const fragmentSource = new ShaderSourceClass({ sources: [...base.fragment], defines: [...base.defines] }).clone();
  vertexSource.emit = emit;
  fragmentSource.emit = emit;
  for (const define of variant.defines) {
    const destination = destinationOf === null ? "both" : destinationOf(define);
    if (destination === "vertex" || destination === "both") vertexSource.defines.push(define);
    if (destination === "fragment" || destination === "both") fragmentSource.defines.push(define);
  }
  fragmentSource.sources.push(
    fragments.emitComputeDayColorGlsl({ textureUnits: fragments.textureUnitsFromDefines(variant.defines), apply: fragments.applyFlagsFromDefines(variant.defines) }),
  );
  vertexSource.sources.push(fragments.emitPositionFunctionsGlsl({ sceneMode: variant.sceneMode ?? "SCENE3D", useWebMercatorProjection: true }));
  return {
    vertexSource: vertexSource.createCombinedVertexShader(context),
    fragmentSource: fragmentSource.createCombinedFragmentShader(context),
  };
}

/**
 * GLSL byte identity (contract R1 / SH-1 / G-5 assertion (a)).
 *
 * @returns `{ identical, total, differences, rows }` — a witness line is recorded for every mismatch.
 */
export async function compareGlslChannels({ variants, production, base, context = SHADER_CONTEXT_STUB }) {
  const upstream = await upstreamShaderSourceClass();
  const rows = [];
  const differences = [];
  let identical = 0;
  for (const variant of variants) {
    const left = assembleGlslForVariant(variant, { ShaderSourceClass: upstream, base, fragments: production.fragments, destinationOf: production.variants.destinationOf, context });
    const right = assembleGlslForVariant(variant, { ShaderSourceClass: production.ShaderSource, base, fragments: production.fragments, destinationOf: production.variants.destinationOf, context });
    const vertexEqual = left.vertexSource === right.vertexSource;
    const fragmentEqual = left.fragmentSource === right.fragmentSource;
    if (vertexEqual && fragmentEqual) identical += 1;
    else differences.push({ variant: variant.id, vertexEqual, fragmentEqual, firstDivergence: firstDivergence(right.vertexSource, left.vertexSource) ?? firstDivergence(right.fragmentSource, left.fragmentSource) });
    rows.push({ id: variant.id, vertexEqual, fragmentEqual, vertexBytes: left.vertexSource.length, fragmentBytes: left.fragmentSource.length, vertexHash: sha256(left.vertexSource), fragmentHash: sha256(left.fragmentSource) });
  }
  return { identical, total: variants.length, differences, rows };
}

/** First line at which two texts diverge (a witness for "not identical"). */
export function firstDivergence(a, b) {
  if (a === b) return null;
  const left = a.split("\n");
  const right = b.split("\n");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return { line: index + 1, seam: left[index] ?? "<eof>", upstream: right[index] ?? "<eof>" };
  }
  return { line: 0, seam: `<equal lines, ${a.length} vs ${b.length} bytes>`, upstream: "" };
}

/**
 * The union bind layout over a variant set.
 *
 * A single-dimension sweep from one base is not enough: several uniforms are introduced by a
 * **conjunction** (`uniform float u_dayTextureAlpha[TEXTURE_UNITS]` lives inside
 * `#if TEXTURE_UNITS > 0 && APPLY_ALPHA`). The marginal subset used by `--variants=mvp` is therefore
 * asserted equal to the full cross-product union by the harness rather than assumed.
 */
export async function unionOfVariants({ variants, production, base, automaticUniforms, context = SHADER_CONTEXT_STUB }) {
  const union = new Map();
  for (const variant of variants) {
    const glsl = assembleGlslForVariant(variant, { ShaderSourceClass: production.ShaderSource, base, fragments: production.fragments, destinationOf: production.variants.destinationOf, context });
    const uniforms = production.bindLayout.referencedUniforms([{ source: glsl.vertexSource, defines: variant.defines }, { source: glsl.fragmentSource, defines: variant.defines }], automaticUniforms);
    for (const uniform of uniforms) {
      const existing = union.get(uniform.name);
      if (existing === undefined) union.set(uniform.name, { name: uniform.name, glslType: uniform.glslType, size: uniform.size });
      else {
        if (existing.glslType !== uniform.glslType) throw new Error(`shader-model: uniform "${uniform.name}" conflicts across variants`);
        existing.size = Math.max(existing.size, uniform.size);
      }
    }
  }
  return [...union.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A provably-sufficient marginal subset for the union layout (`--variants=mvp` uses it; the harness
 * asserts its union equals the full cross product's).
 */
export function enumerateMarginals(variants) {
  const dimensionIds = [...new Set(variants.flatMap((variant) => variant.selection.map((entry) => entry.id)))];
  const keyOf = (selection) => [...selection].sort((a, b) => dimensionIds.indexOf(a.id) - dimensionIds.indexOf(b.id)).map((entry) => `${entry.id}=${entry.value}`).join("|");
  const byId = (selection, id) => selection.find((entry) => entry.id === id).value;
  const bases = [variants[0], variants[variants.length - 1]];
  const last = variants[variants.length - 1];
  const wanted = new Set([keyOf(variants[0].selection), keyOf(last.selection)]);
  for (const base of bases) {
    for (const first of dimensionIds) {
      for (const second of dimensionIds) {
        if (first !== second && dimensionIds.indexOf(second) < dimensionIds.indexOf(first)) continue;
        wanted.add(keyOf(base.selection.map((entry) => (entry.id === first || entry.id === second ? { id: entry.id, value: byId(last.selection, entry.id) } : entry))));
      }
      for (const value of [...new Set(variants.map((variant) => byId(variant.selection, first)))]) {
        wanted.add(keyOf(base.selection.map((entry) => (entry.id === first ? { id: entry.id, value } : entry))));
      }
    }
  }
  return variants.filter((variant) => wanted.has(keyOf(variant.selection)));
}

/**
 * Build the whole model: per-variant GLSL, varying contract, support verdict and — when
 * `onEmission` is supplied — the emitted module pair.
 *
 * @param {{variants?: object[], keepWgsl?: boolean, onEmission?: Function, quiet?: boolean}} [options]
 */
export async function buildProductionModel(options = {}) {
  const production = options.production ?? (await loadProduction());
  const base = options.base ?? (await baseSources());
  const automaticUniforms = options.automaticUniforms ?? (await automaticUniformNames());
  const variants = options.variants ?? production.variants.enumerateReachableVariants();
  const keepWgsl = options.keepWgsl === true;
  const marginal = options.marginal === true;
  const layoutVariants = marginal ? enumerateMarginals(variants) : variants;
  const layoutInputs = await unionOfVariants({ variants: layoutVariants, production, base, automaticUniforms });
  const layout = production.bindLayout.layoutUniforms(layoutInputs, { structName: "TerrainUniforms" });

  const entries = [];
  let emitted = 0;
  let rejected = 0;
  const unsupportedDefines = new Map();
  for (const variant of variants) {
    const glsl = assembleGlslForVariant(variant, { ShaderSourceClass: production.ShaderSource, base, fragments: production.fragments, destinationOf: production.variants.destinationOf });
    // The varying set is derived from the real assembled GLSL. `PER_FRAGMENT_GROUND_ATMOSPHERE` is a
    // pipeline override, so the module must satisfy *both* of its values: the pairing comes from the
    // per-vertex witness (the union), never from the per-fragment subset.
    const witness = production.variants.perVertexWitnessVariant(variant);
    const derivationGlsl = witness === null ? glsl : assembleGlslForVariant(witness, { ShaderSourceClass: production.ShaderSource, base, fragments: production.fragments, destinationOf: production.variants.destinationOf });
    const contract = production.varyingContract.deriveVaryingContract({
      vertexSource: derivationGlsl.vertexSource,
      fragmentSource: derivationGlsl.fragmentSource,
      defines: witness?.defines ?? variant.defines,
      variantKey: variant.id,
      source: witness === null ? "this variant's own assembled GLSL" : "per-vertex witness (union: PER_FRAGMENT_GROUND_ATMOSPHERE is a pipeline override)",
    });
    const emission = production.emitter.emitTerrainWgsl({
      variantKey: variant.id,
      vertexGlsl: glsl.vertexSource,
      fragmentGlsl: glsl.fragmentSource,
      defines: variant.defines,
      textureUnits: production.fragments.textureUnitsFromDefines(variant.defines),
      flags: production.fragments.applyFlagsFromDefines(variant.defines),
      layout,
      sceneMode: variant.sceneMode,
      ...(witness === null ? {} : { witness: { vertexGlsl: derivationGlsl.vertexSource, fragmentGlsl: derivationGlsl.fragmentSource, defines: witness.defines } }),
    });
    if (emission.ok) emitted += 1;
    else {
      rejected += 1;
      for (const diagnostic of emission.diagnostics) unsupportedDefines.set(diagnostic.message, variant.id);
    }
    const entry = {
      variant,
      contract,
      emission: {
        ok: emission.ok,
        structure: emission.structure,
        diagnostics: emission.diagnostics,
        vertexWgsl: keepWgsl ? emission.vertexModule : null,
        fragmentWgsl: keepWgsl ? emission.fragmentModule : null,
      },
    };
    entries.push(entry);
    if (options.onEmission !== undefined) options.onEmission(entry, emission, glsl);
  }

  const varyingShapes = new Map();
  for (const entry of entries) {
    if (!entry.emission.ok) continue;
    const key = (entry.emission.structure?.paired ?? []).join(",");
    varyingShapes.set(key, (varyingShapes.get(key) ?? 0) + 1);
  }

  return {
    production,
    layout,
    layoutInputs,
    unionUniforms: layoutInputs,
    layoutSource: marginal ? `marginal union (${layoutVariants.length}/${variants.length} variants)` : "full cross-product union",
    defineSpace: {
      sceneMode: production.variants.MVP_SCENE_MODE,
      alwaysDefines: production.variants.ALWAYS_DEFINES,
      dimensions: production.variants.REACHABLE_DIMENSIONS.map((dimension) => ({
        id: dimension.id,
        values: dimension.values,
        excludedValues: dimension.excludedValues,
        justification: dimension.justification,
        source: dimension.source,
      })),
      excludedDefines: production.variants.EXCLUDED_DEFINES,
    },
    entries,
    stats: {
      defineCombinations: entries.length,
      emitted,
      rejected,
      unsupportedDefines: [...unsupportedDefines.entries()].map(([message, variantId]) => ({ message, variantId })),
      distinctVaryingSets: varyingShapes.size,
      uniformMembers: layout.uniformBlock.fields.length,
      samplerBindings: layout.samplers.length,
      structSize: layout.structSize,
    },
  };
}

/** Write the model to `experiments/gates/out/g5-model-production.json` (diagnostics + structure only). */
export function writeModelReport(model, outFile) {
  const report = {
    tool: "tools/shader-model.mjs",
    recordedAt: new Date().toISOString(),
    node: process.version,
    layoutSource: model.layoutSource,
    stats: model.stats,
    layout: {
      structName: model.layout.structName,
      structSize: model.layout.structSize,
      wgslStruct: model.layout.wgslStruct,
      wgslBindings: model.layout.wgslBindings,
      memberCount: model.layout.uniformBlock.fields.length,
      samplers: model.layout.samplers,
      members: model.layout.uniformBlock.fields.map((member) => ({ ...member, scalarOffsets: undefined })),
    },
    unionUniforms: model.layoutInputs,
    variants: model.entries.map((entry) => ({
      id: entry.variant.id,
      defines: entry.variant.defines,
      ok: entry.emission.ok,
      paired: entry.emission.structure?.paired ?? [],
      attributes: entry.emission.structure?.attributes ?? [],
      overrides: entry.emission.structure?.overrides ?? null,
      pruning: entry.emission.structure?.pruning ?? null,
      varyingSource: entry.contract.source,
      diagnostics: entry.emission.diagnostics,
    })),
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
