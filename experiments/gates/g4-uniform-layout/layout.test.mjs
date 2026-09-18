/**
 * T019 (a) — G-4 uniform-layout unit cross-check (`层=单元`, tasks.md T018/T019).
 *
 * Asserts, **without a GPU**, that the layout the generator produces for the real assembled terrain
 * GLSL is internally consistent and covers every case tasks.md T018 names:
 *
 *   1. the field set is exactly the union of the uniforms the assembled GLSL variants actually
 *      reference (no missing field, no invented field), for the default MVP configuration and for the
 *      whole define matrix;
 *   2. the generated WGSL `struct`, when parsed and laid out **independently** (its own re-implementation
 *      of the WGSL rules), agrees field-by-field with the CPU-side table (`byteOffset`/`byteSize`/
 *      `align`/`arrayStride`/`columnStride`) and on the struct size;
 *   3. `mat3` columns are 16-byte padded (`size 48`, `columnStride 16`), `vec3` is 12 bytes but aligned
 *      to 16, **every array has a 16-byte element stride** (a packed element type is widened to
 *      `vec4<T>`, because the uniform address space requires `StrideOf(array<T,N>) = 16 × k'` and WGSL
 *      has no stride attribute), and the `size 9` `czm_sphericalHarmonicCoefficients` is handled as
 *      `array<vec3<f32>, 9>` with stride 16 / 144 bytes — proven on the **real** upstream shader that
 *      references it (glTF image-based lighting), because the terrain shaders do not;
 *   4. `bool` (which is not host-shareable in the uniform address space) is mapped to `u32`, and sampler
 *      uniforms never appear inside the struct;
 *   5. when the real-device artefact `experiments/gates/out/g4-gpu.json` is present (gitignored, produced
 *      by `node experiments/gates/g4-uniform-layout/run-gpu.mjs`), the measured per-slot readback is
 *      cross-checked — 0 mismatching components and every member perturbation hitting exactly its slots
 *      — so the unit rules above are anchored to a real device when one is available.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { MVP_DEFINE_MATRIX, assembleMatrix, assembleVariant } from "./assemble-glsl.mjs";
import { crossCheckLayout, independentLayoutFromWgsl } from "./run.mjs";
import { emitVerificationWgsl, layoutUniforms, roundUp, shapeOf, typeInfo } from "./uniform-layout.mjs";
import { readText, repoPath } from "../../../tests/support/repo.mjs";

function unionUniforms(matrix) {
  return matrix.union.map((entry) => {
    const sizes = matrix.variants
      .filter((variant) => variant.uniforms.some((uniform) => uniform.name === entry.name))
      .map((variant) => variant.uniforms.find((uniform) => uniform.name === entry.name).size);
    return { name: entry.name, glslType: entry.glslType, size: Math.max(...sizes), sizesByVariant: sizes, variants: entry.variants };
  });
}

/** WGSL element type → the GLSL type `shapeOf`/`typeInfo` speak, for the non-widened arrays. */
const GLSL_BY_WGSL = {
  "vec2<f32>": "vec2",
  "vec3<f32>": "vec3",
  "vec4<f32>": "vec4",
  "ivec2": "ivec2",
  "mat3x3<f32>": "mat3",
  "mat4x4<f32>": "mat4",
};

const matrix = assembleMatrix();
const union = unionUniforms(matrix);
const unionLayout = layoutUniforms(union, { structName: "TerrainUniforms" });
const defaultLayout = layoutUniforms(
  matrix.defaultVariant.uniforms.map((entry) => ({ name: entry.name, glslType: entry.glslType, size: entry.size })),
  { structName: "TerrainUniforms" },
);

test("the assembled terrain GLSL comes from the upstream assembler and the real define set", () => {
  assert.equal(matrix.variants.length, MVP_DEFINE_MATRIX.length);
  for (const variant of matrix.variants) {
    assert.ok(variant.vertexBytes > 10000, `${variant.id}: vertex shader assembly produced ${variant.vertexBytes} bytes`);
    assert.ok(variant.fragmentBytes > 10000, `${variant.id}: fragment shader assembly produced ${variant.fragmentBytes} bytes`);
    assert.ok(variant.referencedCount > 40, `${variant.id}: only ${variant.referencedCount} uniforms referenced`);
    assert.ok(variant.uniforms.every((entry) => /^(czm_|u_)/.test(entry.name)), `${variant.id}: unexpected uniform name`);
  }
  // The automatic uniforms are declared by the upstream module, not invented here.
  assert.ok(matrix.automaticUniformCount >= 90, `AutomaticUniforms declared ${matrix.automaticUniformCount} uniforms`);
  assert.ok(
    matrix.defaultVariant.uniforms.some((entry) => entry.origin === "automatic" && entry.name === "czm_normal3D"),
    "the default terrain configuration MUST reference the automatic uniform czm_normal3D",
  );
});

test("the field set is exactly the union of the uniforms the assembled GLSL references", () => {
  const expectedFields = union.map((entry) => entry.name).sort();
  const numericFields = unionLayout.members.map((member) => member.name).sort();
  const samplerFields = [...new Set(unionLayout.samplers.map((sampler) => sampler.glslName))].sort();
  assert.deepEqual([...numericFields, ...samplerFields].sort(), expectedFields, "every referenced uniform MUST have a layout entry, and no field may be invented");
  assert.deepEqual(
    defaultLayout.members.map((member) => member.name).sort(),
    matrix.defaultVariant.uniforms.filter((entry) => !/^sampler/.test(entry.glslType)).map((entry) => entry.name).sort(),
    "the default-configuration table MUST be exactly the uniforms that configuration references",
  );
  for (const entry of union) {
    const member = unionLayout.members.find((candidate) => candidate.name === entry.name);
    if (member === undefined) continue;
    assert.ok(member.length >= Math.max(...entry.sizesByVariant), `${entry.name}: array length ${member.length} MUST cover every variant (max ${Math.max(...entry.sizesByVariant)})`);
  }
});

test("the CPU table and an independent re-layout of the generated WGSL agree field by field", () => {
  for (const layout of [defaultLayout, unionLayout]) {
    const crossCheck = crossCheckLayout(layout);
    assert.deepEqual(crossCheck.problems, [], `layout cross-check problems: ${crossCheck.problems.join("; ")}`);
    assert.equal(crossCheck.independent.structSize, layout.structSize);
  }
  // The independent recomputation really is independent: it only sees the WGSL text.
  const parsed = independentLayoutFromWgsl(unionLayout.wgslStruct, unionLayout.structName);
  assert.equal(parsed.members.length, unionLayout.members.length);
  assert.ok(parsed.structSize > 0);
  assert.match(unionLayout.wgslStruct, /^struct TerrainUniforms \{/);
});

test("mat3 column padding, vec3 alignment and array strides match the uniform layout rules", () => {
  const mat3 = unionLayout.members.filter((member) => member.glslType === "mat3");
  assert.ok(mat3.length > 0, "the terrain configuration references mat3 (czm_normal3D)");
  for (const member of mat3) {
    assert.equal(member.columnStride, 16, `${member.name}: mat3 columns MUST be 16-byte padded`);
    assert.equal(member.byteSize, 48, `${member.name}: mat3 size MUST be 3 x 16 bytes`);
    assert.equal(member.byteOffset % 16, 0, `${member.name}: mat3 MUST be 16-byte aligned`);
  }
  const vec3 = unionLayout.members.filter((member) => member.elementWgslType === "vec3<f32>" && member.length === 1);
  assert.ok(vec3.length >= 5, `expected several vec3 members, found ${vec3.length}`);
  for (const member of vec3) {
    assert.equal(member.align, 16, `${member.name}: vec3 MUST be aligned to 16`);
    assert.equal(member.byteSize, 12, `${member.name}: vec3 occupies 12 bytes`);
  }
  const arrays = unionLayout.members.filter((member) => member.length > 1);
  assert.ok(arrays.length >= 4, `expected several arrays, found ${arrays.length}`);
  for (const member of arrays) {
    // The uniform address space requires an element stride that is a multiple of 16, and WGSL derives
    // the stride from the element type — so the generator must widen a packed element type instead.
    assert.equal(member.arrayStride % 16, 0, `${member.name}: element stride ${member.arrayStride} MUST be a multiple of 16 (uniform address space)`);
    assert.equal(member.byteOffset % 16, 0, `${member.name}: an array MEMBER must be 16-byte aligned (RequiredAlignOf(array<T,N>, uniform) = 16)`);
    if (member.paddedElement === true) {
      assert.equal(member.elementWgslType, "vec4<" + member.scalar + ">", `${member.name}: a packed element MUST be widened to a 16-byte vector`);
      const widenedShape = shapeOf(typeInfo("vec4"));
      assert.equal(widenedShape.align, 16, `${member.name}: the widened element MUST be 16-byte aligned`);
      assert.equal(widenedShape.size, 16, `${member.name}: the widened element MUST occupy 16 bytes`);
    } else {
      const elementShape = shapeOf(typeInfo(GLSL_BY_WGSL[member.elementWgslType] ?? member.glslType));
      assert.equal(member.arrayStride, roundUp(elementShape.size, elementShape.align), `${member.name}: element stride MUST be roundUp(SizeOf(E), AlignOf(E)) when that is already a multiple of 16`);
    }
  }
  // The widening is declared, not silent: exactly the packed element types are widened.
  const widened = arrays.filter((member) => member.paddedElement === true);
  assert.ok(widened.length >= 4, `expected the packed scalar arrays to be widened, found ${widened.length}`);
  assert.ok(
    widened.every((member) => ["float", "int", "bool", "uint"].includes(member.glslType) || member.glslType.startsWith("bvec")),
    `only packed element types may be widened, got ${widened.map((member) => `${member.name}:${member.glslType}`).join(", ")}`,
  );
  assert.ok(widened.every((member) => member.arrayStride === 16 && member.byteOffset % 16 === 0), "widened arrays MUST be 16-byte strided and 16-byte aligned");
});

test("the size-9 czm_sphericalHarmonicCoefficients case is handled on the real shader that uses it", async () => {
  const { default: ImageBasedLightingStageFS } = await import("@cesium/engine/Source/Shaders/Model/ImageBasedLightingStageFS.js");
  const assembled = assembleVariant(
    { id: "image-based-lighting", defines: [] },
    { sources: { vertex: [ImageBasedLightingStageFS], fragment: [ImageBasedLightingStageFS], defines: [] } },
  );
  const entry = assembled.uniforms.find((uniform) => uniform.name === "czm_sphericalHarmonicCoefficients");
  assert.ok(entry, "the upstream image-based-lighting stage MUST declare czm_sphericalHarmonicCoefficients");
  assert.equal(entry.glslType, "vec3");
  assert.equal(entry.size, 9, "T018 names the size-9 case explicitly");
  const layout = layoutUniforms([{ name: entry.name, glslType: entry.glslType, size: entry.size }], { structName: "SphericalHarmonicsUniforms" });
  assert.equal(layout.members.length, 1);
  assert.equal(layout.members[0].wgslType, "array<vec3<f32>, 9>");
  assert.equal(layout.members[0].arrayStride, 16, "vec3 array elements are 16 bytes apart");
  assert.equal(layout.members[0].byteSize, 144, "9 elements x 16-byte stride = 144 bytes");
  assert.equal(layout.members[0].byteOffset % 16, 0);
  assert.equal(layout.members[0].scalarCount, 27);
  assert.deepEqual(crossCheckLayout(layout, "SphericalHarmonicsUniforms").problems, []);
});

test("bool uniforms map to u32 and samplers never appear inside the struct", () => {
  const booleans = unionLayout.members.filter((member) => member.glslType === "bool" || member.glslType.startsWith("bvec"));
  assert.ok(booleans.length > 0, "the terrain fragment shader declares GLSL bool uniforms (u_dayTextureUseWebMercatorT)");
  for (const member of booleans) {
    assert.equal(member.scalar, "u32", `${member.name}: bool is not host-shareable in the uniform address space`);
    assert.match(member.wgslType, /^u32$|^array<vec4<u32>/, `${member.name}: a bool array MUST be widened to a 16-byte element (${member.wgslType})`);
  }
  assert.ok(unionLayout.samplers.length >= 3, `expected sampler bindings, found ${unionLayout.samplers.length}`);
  for (const sampler of unionLayout.samplers) {
    assert.match(sampler.textureType, /^texture_(2d|cube|3d|2d_array)</);
    assert.equal(sampler.samplerBinding, sampler.textureBinding + 1, `${sampler.name}: texture and sampler bindings MUST be adjacent`);
    assert.ok(sampler.textureBinding >= 1, "binding 0 is the uniform buffer");
  }
  assert.ok(unionLayout.members.every((member) => !/sampler/.test(member.glslType)), "no sampler may be a struct member");
  // Every struct member is 16-byte aligned as a whole (uniform address space constraint on structures).
  assert.equal(unionLayout.structAlign % 16, 0);
  assert.equal(unionLayout.structSize % unionLayout.structAlign, 0);
});

test("the generated verification program exposes one slot per field/element/column", () => {
  const wgsl = emitVerificationWgsl(unionLayout);
  const expectedSlots = unionLayout.members.reduce((count, member) => count + member.length * member.columns, 0);
  assert.equal(unionLayout.slotPlan.length, expectedSlots);
  assert.equal((wgsl.match(/case \d+u: \{ return /g) ?? []).length, expectedSlots, "one switch case per slot");
  // Slot byteOffsets are strictly inside the struct and respect the member strides.
  for (const slot of unionLayout.slotPlan) {
    assert.ok(slot.byteOffset + slot.components * 4 <= unionLayout.structSize, `slot ${slot.index} (${slot.member}) exceeds the struct size`);
    assert.equal(slot.byteOffsets.length, slot.components);
  }
  // The struct text declares exactly the members the CPU table describes.
  const declared = [...unionLayout.wgslStruct.matchAll(/^\s+([A-Za-z_]\w*) : (.+),$/gm)].map((match) => `${match[1]}:${match[2]}`);
  assert.deepEqual(
    declared,
    unionLayout.members.map((member) => `${member.name}:${member.wgslType}`),
    "the WGSL struct MUST declare exactly the laid-out members, in table order",
  );
});

test("the real-device artefact (when present) confirms the layout on a GPU", (t) => {
  const artifactPath = repoPath("experiments/gates/out/g4-gpu.json");
  if (!fs.existsSync(artifactPath)) {
    t.diagnostic(
      "experiments/gates/out/g4-gpu.json is absent (it is gitignored and produced by " +
        "`node experiments/gates/g4-uniform-layout/run-gpu.mjs`): the static cross-checks above still ran, " +
        "but the measured per-slot confirmation was not available in this environment.",
    );
    return;
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.equal(artifact.checks.find((check) => check.id === "gpu-baseline-matches-cpu-layout")?.ok, true, "the device readback MUST match the CPU layout table");
  assert.equal(artifact.checks.find((check) => check.id === "gpu-every-uniform-perturbation-hits-its-slots")?.ok, true, "every uniform MUST be live at its declared offset");
  assert.equal(artifact.measurements.baseline.mismatchCount, 0);
  assert.equal(artifact.measurements.perturbations.length, artifact.measurements.memberCount);
  assert.ok(artifact.measurements.perturbations.every((entry) => entry.exact === true));
  assert.ok(artifact.environment.adapter?.vendor != null, "the artefact MUST record the adapter it was measured on");
});

test("the generator's rules are documented in one place (no silent divergence)", () => {
  const source = readText("experiments/gates/g4-uniform-layout/uniform-layout.mjs");
  for (const needle of ["PADDED_ELEMENT_WGSL", "roundUp(shape.size, shape.align)", "16", "uniform address space"]) {
    assert.ok(source.includes(needle), `uniform-layout.mjs MUST document its layout rules (missing "${needle}")`);
  }
  assert.match(source, /uniform_buffer_standard_layout/, "the generator MUST record WHY the packed layout is widened (the uniform address space requires a 16-byte element stride unless that language extension is supported)");
});
