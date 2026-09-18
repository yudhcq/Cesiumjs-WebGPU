/**
 * T081 — the `ShaderBuilder` boundary (`层=单元` + `层=架构边界`; tasks.md T081; contract
 * fork-patch-layer §5 rule **R9**, architecture rules A3/A4).
 *
 * R9 has two halves and both are asserted here, because either one alone can be satisfied while the
 * other silently rots:
 *
 *   1. **`Renderer/ShaderBuilder.js` stays byte-identical in the MVP.** That is a claim about the
 *      installed upstream package, so it is checked against the package itself: no local replacement
 *      exists, the module is recorded in `manifest.json` → `keptModules` (and *not* in `entries[]`,
 *      which is what would make the alias plugin rewrite it), the recorded content hash equals the
 *      installed file's, and `node tools/scripts/gen-kept-hash.mjs --check` exits 0.
 *   2. **The families it assembles fail explicitly.** The model / voxel / Gaussian-splat paths reach
 *      the WebGPU shader front end with the same `ShaderProgram.fromCache` call as the globe does
 *      (`ShaderBuilder.js:512-517`), so without a guard they would be compiled — or worse, be
 *      silently skipped. `assertShaderFamilySupported` refuses them with
 *      `category: "not-implemented"`, and the terrain closure passes.
 *
 * The family probes are the **real upstream leaves**, not hand-written look-alikes: a criterion that
 * only recognises a string invented inside a test would be worthless.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { REPO_ROOT, exists, listFiles, readJson, repoPath } from "../support/repo.mjs";
import { upstreamStubs } from "../support/upstream-stubs.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assertDiagnostic } from "../support/fake-gpu.mjs";
import { hashFile } from "../../tools/lib/patch-layer.mjs";
import { baseSources, loadProduction } from "../../tools/shader-model.mjs";

const BACKEND = "packages/cesium-webgpu/backend-webgpu";
const MANIFEST = `${BACKEND}/manifest.json`;
const KEPT_MODULE = "Renderer/ShaderBuilder.js";
const UPSTREAM_KEPT_MODULE = "node_modules/@cesium/engine/Source/Renderer/ShaderBuilder.js";
const GEN_KEPT_HASH = "tools/scripts/gen-kept-hash.mjs";

function realUpstream(specifier) {
  return `export { default } from ${JSON.stringify(new URL(`../../node_modules/${specifier}`, import.meta.url).href)};`;
}

const programModule = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/ShaderProgram.ts`), {
  externals: {
    ...upstreamStubs(),
    "@cesium/engine/Source/Renderer/AutomaticUniforms.js": realUpstream("@cesium/engine/Source/Renderer/AutomaticUniforms.js"),
    "@cesium/engine/Source/Core/destroyObject.js": realUpstream("@cesium/engine/Source/Core/destroyObject.js"),
  },
});

test("R9: there is no local replacement for Renderer/ShaderBuilder.js", () => {
  assert.equal(exists(`${BACKEND}/Renderer/ShaderBuilder.js`), false, "the patch layer MUST NOT carry a `ShaderBuilder.js` (contract R9 keeps the upstream module byte-identical)");
  assert.equal(exists(`${BACKEND}/Renderer/ShaderBuilder.ts`), false, "nor a TypeScript replacement under any other extension");
  const localFiles = listFiles(`${BACKEND}/Renderer`).filter((file) => /ShaderBuilder/i.test(file));
  assert.deepEqual(localFiles, [], `no local module may shadow ShaderBuilder (found: ${localFiles.join(", ")})`);

  // The kept module is real and on disk in the installed package (the alias plugin leaves it alone).
  assert.equal(exists(UPSTREAM_KEPT_MODULE), true, "the kept upstream module MUST be installed");
});

test("R9: ShaderBuilder.js is recorded in manifest keptModules and is not a replacement entry", () => {
  const manifest = readJson(MANIFEST);

  assert.equal(manifest.keptModulesAlgorithm, "sha256");
  assert.ok(Object.prototype.hasOwnProperty.call(manifest.keptModules, KEPT_MODULE), `${KEPT_MODULE} MUST be listed in keptModules`);
  assert.match(manifest.keptModules[KEPT_MODULE], /^sha256-[0-9a-f]{64}$/, "the kept module MUST be recorded with a content hash");

  const replacements = manifest.entries.filter((entry) => entry.upstreamModule === KEPT_MODULE);
  assert.deepEqual(replacements, [], `${KEPT_MODULE} MUST NOT be a replacement entry (that is what would make the alias plugin rewrite it)`);

  // Every kept module lives under Renderer/** — the patch boundary (manifest rule 1 / rule A3).
  for (const module_ of Object.keys(manifest.keptModules)) {
    assert.match(module_, /^Renderer\/[A-Za-z0-9_]+\.js$/, `kept module "${module_}" MUST stay inside the renderer backend layer`);
  }
});

test("R9: the kept module's bytes are unchanged (gen-kept-hash --check exits 0)", () => {
  const recordedBefore = readJson(MANIFEST).keptModules[KEPT_MODULE];

  const result = spawnSync(process.execPath, [repoPath(GEN_KEPT_HASH), "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, `gen-kept-hash --check MUST exit 0:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(`${result.stdout}`, /no drift/, "the check MUST report that the recorded hashes match the installed upstream");

  const recordedAfter = readJson(MANIFEST).keptModules[KEPT_MODULE];
  assert.equal(recordedAfter, recordedBefore, "--check MUST NOT rewrite the recorded hash");
  assert.equal(
    recordedAfter,
    hashFile(repoPath(UPSTREAM_KEPT_MODULE)),
    "the recorded hash MUST equal the sha256 of the installed upstream ShaderBuilder.js (byte identity)",
  );
});

test("R9: the model / voxel / Gaussian-splat families are refused with not-implemented", async () => {
  const { assertShaderFamilySupported, shaderFamilyOf, SHADER_FAMILY_BOUNDARY } = programModule;
  assert.equal(typeof assertShaderFamilySupported, "function", "ShaderProgram.ts MUST export the T081 guard");

  const [GeometryStageVS, MaterialStageFS, VoxelFS, VoxelVS, GaussianSplatVS] = await Promise.all([
    import("@cesium/engine/Source/Shaders/Model/GeometryStageVS.js"),
    import("@cesium/engine/Source/Shaders/Model/MaterialStageFS.js"),
    import("@cesium/engine/Source/Shaders/Voxels/VoxelFS.js"),
    import("@cesium/engine/Source/Shaders/Voxels/VoxelVS.js"),
    import("@cesium/engine/Source/Shaders/PrimitiveGaussianSplatVS.js"),
  ]);

  const cases = [
    {
      family: "model",
      // `Scene/Model/GeometryPipelineStage.js:260` pushes the define; `Model/GeometryStageVS.glsl:25`
      // and `Model/MaterialStageFS.glsl:166` carry the `#ifdef HAS_NORMALS` text.
      assembly: { sources: [GeometryStageVS.default, MaterialStageFS.default], defines: ["HAS_NORMALS", "LIGHTING_PBR"] },
    },
    {
      family: "voxel",
      // `Scene/VoxelRenderResources.js:181` adds `Voxels/VoxelFS.glsl`, whose `getVoxelIntersection`
      // (line 44) is the marker; `:105` pushes `SHAPE_BOX`.
      assembly: { sources: [VoxelFS.default], defines: ["SHAPE_BOX", "VOXEL_SHAPE_BOX"] },
    },
    {
      family: "gaussian-splat",
      // `Scene/GaussianSplatPrimitive.js:1580-1581` adds the two splat leaves;
      // `PrimitiveGaussianSplatVS.glsl:10,188` carry the marker text.
      assembly: { sources: [GaussianSplatVS.default], defines: [] },
    },
  ];

  for (const { family, assembly } of cases) {
    assert.equal(shaderFamilyOf(assembly), family, `the ${family} family MUST be recognised from its real upstream leaves`);
    assert.throws(
      () => assertShaderFamilySupported(assembly),
      (error) => {
        assertDiagnostic(error, "not-implemented", `the ${family} boundary`);
        assert.equal(error.details?.upstreamModule, "Renderer/ShaderBuilder.js", `the ${family} diagnostic MUST name the kept module it comes from`);
        assert.equal(error.details?.extra?.shaderFamily, family);
        assert.match(error.message, /ShaderBuilder/, `the ${family} diagnostic MUST explain why the family is refused`);
        return true;
      },
    );
    assert.equal(assembly.defines.includes("HAS_NORMALS") && family !== "model", false, "the model marker MUST NOT be claimed by another family");
  }

  // Either signal is enough on its own: the assembled GLSL text, or the define list (a vertex-only
  // voxel assembly carries no fragment text, which is exactly what the define half is for).
  assert.equal(shaderFamilyOf({ sources: [GeometryStageVS.default], defines: [] }), "model", "the GLSL text alone MUST be sufficient");
  assert.equal(shaderFamilyOf({ sources: ["void main() {}"], defines: ["HAS_NORMALS"] }), "model", "the define alone MUST be sufficient");
  assert.equal(shaderFamilyOf({ sources: [VoxelVS.default], defines: ["SHAPE_BOX"] }), "voxel", "a voxel vertex stage is caught by its define");

  // The rule set is data with provenance, so an upstream upgrade is a visible diff.
  assert.deepEqual(
    SHADER_FAMILY_BOUNDARY.map((rule) => rule.family),
    ["model", "voxel", "gaussian-splat"],
    "every R9 family MUST have a rule",
  );
  for (const rule of SHADER_FAMILY_BOUNDARY) {
    assert.match(rule.upstreamSource, /Source\//, `the "${rule.family}" criterion MUST cite the upstream line it came from`);
  }
});

test("R9: the terrain closure is not refused by the guard", async () => {
  const { assertShaderFamilySupported, shaderFamilyOf } = programModule;
  const base = await baseSources();
  const production = await loadProduction();
  const variant = production.variants.enumerateReachableVariants().find((candidate) => candidate.defines.includes("TEXTURE_UNITS 1"));
  assert.ok(variant !== undefined);

  // Every leaf of the closure on its own, and the closure as a whole with a real variant's defines.
  for (const [name, source] of [
    ["GlobeVS", base.vertex[2]],
    ["GlobeFS", base.fragment[2]],
    ["AtmosphereCommon", base.vertex[0]],
    ["GroundAtmosphere", base.vertex[1]],
  ]) {
    const assembly = { sources: [source], defines: [...variant.defines] };
    assert.equal(shaderFamilyOf(assembly), "terrain", `${name} MUST belong to the supported closure`);
    assert.doesNotThrow(() => assertShaderFamilySupported(assembly), `${name} MUST NOT be refused`);
  }

  const closure = { sources: [...base.vertex, ...base.fragment], defines: [...variant.defines] };
  assert.equal(shaderFamilyOf(closure), "terrain");
  assert.doesNotThrow(() => assertShaderFamilySupported(closure));
});
