/**
 * T074 — depth-range remap, handled as a **pair** (`层=单元` + `层=架构边界`; tasks.md T074;
 * research §5.4/§6.3, principle I).
 *
 * GL clip space has z ∈ [-w, w]; the WebGPU NDC cube has z ∈ [0, w] and a vertex position written
 * outside it is **clipped**. The GLSL side must not change (`Core/PerspectiveFrustum.js` and
 * `Renderer/UniformState.js` are kept modules), so the remap has to happen where the WGSL is
 * produced:
 *
 *   - the vertex leaf's **single** `@builtin(position)` write goes through `czms_remapClipDepth`;
 *   - the prelude declares `czms_unprojectDepth` as its inverse, so any code that reconstructs eye
 *     coordinates from a depth value can undo the same remap.
 *
 * The assertions below are textual because the subject is the artefact the device receives, and this
 * is the half of T074 a GPU-free CI can execute. The other half — that the remap is *correct* — is the
 * real-device golden readback (`node tools/shader-verify.mjs --variants=mvp`, 16384/16384 non-black).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assembleGlslForVariant, baseSources, enumerateMarginals, loadProduction, unionOfVariants, automaticUniformNames } from "../../tools/shader-model.mjs";

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function emitGolden() {
  const production = await loadProduction();
  const base = await baseSources();
  const automaticUniforms = await automaticUniformNames();
  const all = production.variants.enumerateReachableVariants();
  const inputs = await unionOfVariants({ variants: enumerateMarginals(all), production, base, automaticUniforms });
  const layout = production.bindLayout.layoutUniforms(inputs, { structName: "TerrainUniforms" });
  const variant = all.find((candidate) => candidate.defines.includes("TEXTURE_UNITS 1") && candidate.defines.includes("ENABLE_DAYNIGHT_SHADING"));
  const glsl = assembleGlslForVariant(variant, { ShaderSourceClass: production.ShaderSource, base, fragments: production.fragments, destinationOf: production.variants.destinationOf });
  const emission = production.emitter.emitTerrainWgsl({
    variantKey: variant.id,
    vertexGlsl: glsl.vertexSource,
    fragmentGlsl: glsl.fragmentSource,
    defines: variant.defines,
    textureUnits: 1,
    flags: production.fragments.applyFlagsFromDefines(variant.defines),
    layout,
    sceneMode: variant.sceneMode,
  });
  assert.equal(emission.ok, true, `the golden variant MUST emit: ${JSON.stringify(emission.diagnostics)}`);
  return { production, emission, variant };
}

test("every depth write in the emitted modules goes through the remap, and the inverse is present", async () => {
  const { production, emission } = await emitGolden();
  const check = production.emitter.assertDepthRangePair(emission.vertexModule, emission.fragmentModule);
  assert.deepEqual(check.failures, [], `the T074 pair MUST hold:\n${check.failures.join("\n")}`);
  assert.equal(check.ok, true);
  assert.equal(check.remapDeclared, true, "`czms_remapClipDepth` MUST be in the emitted text");
  assert.equal(check.unprojectDeclared, true, "`czms_unprojectDepth` MUST be in the emitted text (the pair is incomplete without it)");
  assert.ok(check.writePoints.length > 0, "the check MUST have a subject: at least one `@builtin(position)` write");
  assert.ok(
    check.writePoints.every((point) => point.remapped),
    `every depth write MUST be remapped:\n${check.writePoints.map((point) => `${point.remapped ? "ok  " : "MISS"} ${point.text}`).join("\n")}`,
  );
});

test("the remap is the GL→WebGPU clip-space mapping and its inverse is the exact algebraic inverse", async () => {
  const { production, emission } = await emitGolden();
  const text = emission.vertexModule;
  assert.match(text, /fn czms_remapClipDepth\(position: vec4<f32>\) -> vec4<f32>\s*\{\s*return vec4<f32>\(position\.x, position\.y, 0\.5 \* position\.z \+ 0\.5 \* position\.w, position\.w\);\s*\}/, "z' MUST be (z + w)/2 with w preserved (perspective-correct interpolation and the w-divide stay exactly as GL performed them)");
  assert.match(text, /fn czms_unprojectDepth\(ndcDepth: f32\) -> f32\s*\{\s*return 2\.0 \* ndcDepth - 1\.0;\s*\}/, "the inverse MUST be z = 2·z_ndc − 1");

  // The pair is algebraically consistent: for any (z, w), unproject(remap(z, w) / w) === z / w.
  const remap = (z, w) => (0.5 * z + 0.5 * w) / w;
  const unproject = (ndc) => 2 * ndc - 1;
  for (const [z, w] of [[0.5, 2], [-1, 1], [0, 4], [-3.25, 6.5]]) {
    assert.ok(Math.abs(unproject(remap(z, w)) - z / w) < 1e-12, `unproject(remap(${z}, ${w})) MUST be ${z / w}`);
  }
});

test("the remap lives in the emitter's library, not in the kept logic-layer modules (principle I)", async () => {
  const prelude = fs.readFileSync(repoPath(`${BACKEND}/webgpu/wgsl-prelude/czm-prelude.wgsl`), "utf8");
  assert.match(prelude, /fn czms_remapClipDepth/, "the remap MUST live in the backend-layer prelude");
  assert.match(prelude, /fn czms_unprojectDepth/, "its inverse MUST live beside it");

  // The upstream files that would be the "obvious" place to change MUST stay untouched: they are kept
  // modules, and `tools/scripts/gen-kept-hash.mjs --check` is the machine assertion (run by the W4
  // checkpoint). This test pins the *intent* so a future edit cannot quietly move the remap there.
  const uniformState = fs.readFileSync(repoPath("node_modules/@cesium/engine/Source/Renderer/UniformState.js"), "utf8");
  assert.doesNotMatch(uniformState, /0\.5 \* .*\+ 0\.5 \* /, "the depth remap MUST NOT have been added to UniformState.js");
  const frustum = fs.readFileSync(repoPath("node_modules/@cesium/engine/Source/Core/PerspectiveFrustum.js"), "utf8");
  assert.doesNotMatch(frustum, /webgpu|WebGPU/i, "PerspectiveFrustum.js MUST NOT know about the WebGPU backend");
});

test("a module whose depth write is NOT remapped is rejected by the check (negative control)", async () => {
  const { production, emission } = await emitGolden();
  const broken = emission.vertexModule.split("czms_remapClipDepth(").join("(");
  assert.notEqual(broken, emission.vertexModule, "the negative control MUST actually change the text");
  assert.doesNotMatch(broken.split("\n").find((line) => line.includes("out.position =")) ?? "", /czms_remapClipDepth/, "the negative control MUST remove the remap from the depth write");
  const check = production.emitter.assertDepthRangePair(broken, emission.fragmentModule);
  assert.equal(check.ok, false, "an unremapped depth write MUST fail the check");
  assert.ok(check.failures.some((failure) => /not remapped/.test(failure)), `the failure MUST name the unremapped write: ${JSON.stringify(check.failures)}`);
});

test("the prelude's depth pair is catalogued and the catalog is in sync (no silent second copy)", async () => {
  const prelude = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/wgsl-prelude/index.ts`));
  const catalog = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/wgsl-prelude/catalog.ts`));
  for (const wgslName of ["czms_remapClipDepth", "czms_unprojectDepth"]) {
    const entry = catalog.PRELUDE_CATALOG_ENTRIES.find((candidate) => candidate.wgslName === wgslName);
    assert.ok(entry !== undefined, `"${wgslName}" MUST have a prelude catalog entry`);
    assert.match(entry.upstream, /backend layer helper|T074/, `"${wgslName}" is NOT an upstream czm_ name and its catalog row MUST say so (got "${entry.upstream}")`);
  }
  assert.equal(prelude.catalogSummary().function >= 40, true);
});
