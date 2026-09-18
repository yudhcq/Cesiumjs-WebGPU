#!/usr/bin/env node
/**
 * G-4 gate runner — **uniform 布局一致性 (H-4)** — tasks.md T018/T019.
 *
 *   node experiments/gates/g4-uniform-layout/run.mjs              # assemble + generate + judge
 *   node experiments/gates/g4-uniform-layout/run.mjs --skip-gpu   # generation only (no device)
 *   node experiments/gates/g4-uniform-layout/run-gpu.mjs          # the real-device half (T019b)
 *
 * What it does:
 *   1. assembles the **real** terrain GLSL through the upstream `ShaderSource` for a documented MVP
 *      define matrix (`assemble-glsl.mjs`) and collects the uniforms each variant actually references;
 *   2. generates the WGSL `struct`, the `@group(0)` bindings and the CPU-side layout table for
 *      (a) the default MVP configuration and (b) the union over the matrix ("no reachable variant may
 *      reference an unlaid-out uniform");
 *   3. cross-checks the generated layout against an **independent** parse of the generated WGSL
 *      (`layout.test.mjs` owns the detailed assertions; here the same checks run for the artefact);
 *   4. runs the real-device pixel assertion (`run-gpu.mjs`) — identity-style layout with known values
 *      plus a per-field perturbation — and folds its checks into the verdict;
 *   5. writes `experiments/gates/out/g4.json` (schema: `experiments/gates/README.md`, validated by
 *      `tools/scripts/check-gate.mjs`).
 *
 * Exit codes: 0 → `verdict === "pass"`; 1 → the gate failed (STOP: report to the entry-point agent for
 * a plan revision — the documented fallback is the conservative "one vec4 slot per scalar" layout);
 * 2 → the runner itself could not run (artefact still written as `partial`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXCLUDED_DEFINES, MVP_DEFINE_MATRIX, assembleMatrix } from "./assemble-glsl.mjs";
import { layoutUniforms, roundUp } from "./uniform-layout.mjs";

export const GATE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(GATE_DIR, "..", "..", "..");
export const OUT_DIR = path.join(REPO_ROOT, "experiments", "gates", "out");
const ENGINE_ROOT = path.join(REPO_ROOT, "node_modules", "@cesium", "engine");

const logLines = [];
function log(line) {
  const text = `[g4] ${line}`;
  logLines.push(text);
  if (!process.argv.includes("--quiet")) process.stdout.write(`${text}\n`);
}

function repoRelative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

function check(id, ok, detail, extra = {}) {
  return { id, ok: ok === true, detail, ...extra };
}

/**
 * Independent WGSL struct parser: reads `name : type` members from the generated text and recomputes
 * offsets from the WGSL rules *without* consulting `uniform-layout.mjs`'s own bookkeeping.
 */
export function parseWgslStruct(wgsl, structName) {
  const start = wgsl.indexOf(`struct ${structName} {`);
  if (start < 0) throw new Error(`g4: struct ${structName} not found in the generated WGSL`);
  const body = wgsl.slice(start + `struct ${structName} {`.length, wgsl.indexOf("}", start));
  const members = [];
  for (const line of body.split("\n")) {
    const match = /^\s*([A-Za-z_]\w*)\s*:\s*(.+?),\s*$/.exec(line);
    if (match === null) continue;
    const [, name, type] = match;
    const array = /^array<(.+),\s*(\d+)>$/.exec(type);
    members.push({ name, type, elementType: array === null ? type : array[1], length: array === null ? 1 : Number(array[2]) });
  }
  return members;
}

function independentShape(elementType) {
  const vector = /^vec(\d)<(f32|i32|u32)>$/.exec(elementType);
  if (vector !== null) {
    const components = Number(vector[1]);
    // Uniform address space: vec3 aligns to 16 even though it occupies 12 bytes.
    const align = components === 3 ? 16 : components === 2 ? 8 : components * 4;
    return { align, size: components * 4 };
  }
  const matrix = /^mat(\d)x(\d)<f32>$/.exec(elementType);
  if (matrix !== null) {
    const columns = Number(matrix[1]);
    const rows = Number(matrix[2]);
    const columnStride = roundUp(rows === 2 ? 8 : rows * 4, 16);
    return { align: 16, size: columns * columnStride, columnStride };
  }
  if (/^(f32|i32|u32)$/.test(elementType)) return { align: 4, size: 4 };
  throw new Error(`g4: unexpected WGSL element type "${elementType}"`);
}

/** Recompute the layout from the generated WGSL alone (the cross-check of T019 (a)). */
export function independentLayoutFromWgsl(wgsl, structName) {
  const members = [];
  let offset = 0;
  let maxAlign = 16;
  for (const parsed of parseWgslStruct(wgsl, structName)) {
    const shape = independentShape(parsed.elementType);
    // Element stride = roundUp(SizeOf(E), AlignOf(E)) (device-verified in run-gpu.mjs); the array is
    // aligned like its element.
    const arrayStride = parsed.length > 1 ? roundUp(shape.size, shape.align) : null;
    const align = shape.align;
    offset = roundUp(offset, align);
    const byteSize = parsed.length > 1 ? parsed.length * arrayStride : shape.size;
    members.push({ name: parsed.name, wgslType: parsed.type, align, byteOffset: offset, byteSize, arrayStride, columnStride: shape.columnStride ?? null });
    offset += byteSize;
    maxAlign = Math.max(maxAlign, align);
  }
  const structAlign = roundUp(16, maxAlign);
  return { members, structAlign, structSize: roundUp(offset, structAlign) };
}

/** Compare the generator's table with the independent recomputation. */
export function crossCheckLayout(layout, structName = layout.structName) {
  const independent = independentLayoutFromWgsl(layout.wgslStruct, structName);
  const problems = [];
  if (independent.members.length !== layout.members.length) problems.push(`member count ${independent.members.length} != ${layout.members.length}`);
  for (const expected of independent.members) {
    const actual = layout.members.find((member) => member.name === expected.name);
    if (actual === undefined) {
      problems.push(`member ${expected.name} is in the WGSL struct but not in the layout table`);
      continue;
    }
    for (const field of ["byteOffset", "byteSize", "align", "arrayStride", "columnStride"]) {
      if (actual[field] !== expected[field]) problems.push(`${expected.name}.${field}: table=${actual[field]} independent=${expected[field]}`);
    }
  }
  if (independent.structSize !== layout.structSize) problems.push(`structSize table=${layout.structSize} independent=${independent.structSize}`);
  return { ok: problems.length === 0, problems, independent };
}

async function main() {
  const options = { skipGpu: process.argv.includes("--skip-gpu"), quiet: process.argv.includes("--quiet") };
  const startedAt = new Date().toISOString();
  log(`start ${startedAt} (node ${process.version})`);

  const enginePackage = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, "package.json"), "utf8"));
  const matrix = assembleMatrix();
  log(`assembled ${matrix.variants.length} MVP variants; automatic uniforms declared=${matrix.automaticUniformCount}; union=${matrix.union.length}`);

  // ---- layout for the default MVP configuration and for the whole reachable matrix -----------------
  const defaultUniforms = matrix.defaultVariant.uniforms.map((entry) => ({ name: entry.name, glslType: entry.glslType, size: entry.size }));
  const unionUniforms = matrix.union.map((entry) => {
    const sizes = matrix.variants
      .filter((variant) => variant.uniforms.some((uniform) => uniform.name === entry.name))
      .map((variant) => variant.uniforms.find((uniform) => uniform.name === entry.name).size);
    return { name: entry.name, glslType: entry.glslType, size: Math.max(...sizes), sizesByVariant: sizes, variants: entry.variants };
  });
  const defaultLayout = layoutUniforms(defaultUniforms, { structName: "TerrainUniforms" });
  const unionLayout = layoutUniforms(unionUniforms, { structName: "TerrainUniforms" });
  const defaultCrossCheck = crossCheckLayout(defaultLayout);
  const unionCrossCheck = crossCheckLayout(unionLayout);

  // ---- auxiliary case: `size 9` czm_sphericalHarmonicCoefficients (T018 names it explicitly) -----
  // The terrain shaders do NOT reference it (it belongs to the glTF image-based-lighting stage), so
  // instead of inventing a uniform the gate assembles the real upstream shader that does.
  const { assembleVariant } = await import("./assemble-glsl.mjs");
  const { default: ImageBasedLightingStageFS } = await import("@cesium/engine/Source/Shaders/Model/ImageBasedLightingStageFS.js");
  const spherical = assembleVariant(
    { id: "image-based-lighting", config: "upstream glTF image-based-lighting stage (real shader that references czm_sphericalHarmonicCoefficients[9])", defines: [] },
    { sources: { vertex: [ImageBasedLightingStageFS], fragment: [ImageBasedLightingStageFS], defines: [] } },
  );
  const sphericalUniforms = spherical.uniforms
    .filter((entry) => entry.name === "czm_sphericalHarmonicCoefficients")
    .map((entry) => ({ name: entry.name, glslType: entry.glslType, size: entry.size }));
  const sphericalLayout = layoutUniforms(sphericalUniforms, { structName: "SphericalHarmonicsUniforms" });

  const generated = {
    tool: "g4-uniform-layout/run",
    recordedAt: new Date().toISOString(),
    node: process.version,
    engine: { packageName: enginePackage.name, version: enginePackage.version },
    shaderContext: matrix.context,
    baseSources: matrix.baseSources,
    defineMatrix: MVP_DEFINE_MATRIX,
    excludedDefines: EXCLUDED_DEFINES,
    automaticUniformCount: matrix.automaticUniformCount,
    variants: matrix.variants.map((variant) => ({ id: variant.id, config: variant.config, defines: variant.defines, declaredCount: variant.declaredCount, referencedCount: variant.referencedCount, samplerNames: variant.samplerNames, uniforms: variant.uniforms.map((entry) => ({ name: entry.name, glslType: entry.glslType, size: entry.size, origin: entry.origin })) })),
    union: unionUniforms.map((entry) => ({ name: entry.name, glslType: entry.glslType, size: entry.size, sizesByVariant: entry.sizesByVariant, variantCount: entry.variants.length })),
    defaultUniforms,
    defaultLayout: { ...defaultLayout, wgslProgram: undefined },
    unionLayout: { ...unionLayout, wgslProgram: undefined },
    auxiliarySphericalHarmonics: { uniforms: sphericalUniforms, layout: { ...sphericalLayout, wgslProgram: undefined } },
  };

  // ---- artefacts -----------------------------------------------------------------------------------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const layoutArtifact = path.join(OUT_DIR, "g4-layout.json");
  const glslArtifact = path.join(OUT_DIR, "g4-glsl-variants.json");
  const wgslArtifact = path.join(OUT_DIR, "g4-uniform.wgsl");
  const slotArtifact = path.join(OUT_DIR, "g4-slots.json");
  fs.writeFileSync(layoutArtifact, `${JSON.stringify(generated, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    glslArtifact,
    `${JSON.stringify({ recordedAt: generated.recordedAt, baseSources: matrix.baseSources, defineMatrix: MVP_DEFINE_MATRIX, variants: matrix.variants.map((variant) => ({ id: variant.id, defines: variant.defines, declaredCount: variant.declaredCount, referencedCount: variant.referencedCount, uniforms: variant.uniforms, declaredButUnreferenced: variant.declaredButUnreferenced })) }, null, 2)}\n`,
    "utf8",
  );

  const { emitVerificationWgsl, writeStructBytes, expectedSlotBytes } = await import("./uniform-layout.mjs");
  const unionWgsl = emitVerificationWgsl(unionLayout);
  fs.writeFileSync(wgslArtifact, unionWgsl, "utf8");
  const writePlan = writeStructBytes(unionLayout, { salt: 0 });
  const expectedSlots = expectedSlotBytes(unionLayout, writePlan);
  fs.writeFileSync(
    slotArtifact,
    `${JSON.stringify({ structName: unionLayout.structName, structSize: unionLayout.structSize, bufferBytes: roundUp(unionLayout.structSize, 16) + 16, members: unionLayout.members, samplers: unionLayout.samplers, slots: unionLayout.slotPlan, expectedSlots, generatedAt: generated.recordedAt }, null, 2)}\n`,
    "utf8",
  );
  log(`wrote ${repoRelative(layoutArtifact)}, ${repoRelative(wgslArtifact)} (${unionWgsl.length} bytes), ${repoRelative(slotArtifact)}`);

  // ---- checks --------------------------------------------------------------------------------------
  const checks = [
    check(
      "upstream-baseline-version",
      enginePackage.version === "26.3.0",
      `installed @cesium/engine ${enginePackage.version} (same baseline as upstream/engine-26.3.0.lock.json)`,
      { phase: "generation" },
    ),
    check(
      "real-glsl-assembled-by-upstream-assembler",
      matrix.variants.every((variant) => variant.declaredCount > 0 && variant.vertexBytes > 10000 && variant.fragmentBytes > 10000) &&
        matrix.baseSources.vertex.length === 3 &&
        matrix.baseSources.fragment.length === 3,
      `all ${matrix.variants.length} variants were assembled by the upstream ShaderSource (VS sources = AtmosphereCommon+GroundAtmosphere+GlobeVS, FS = …+GlobeFS, defines=[] as in Globe.js:679-687); ` +
        `sizes: ${matrix.variants.map((variant) => `${variant.id}=${variant.vertexBytes}/${variant.fragmentBytes}B`).join(", ")}`,
      { phase: "generation" },
    ),
    check(
      "uniform-set-comes-from-preprocessed-glsl",
      matrix.variants.every((variant) => variant.referencedCount > 0 && variant.declaredButUnreferenced !== undefined && variant.uniforms.every((entry) => entry.name.length > 0)),
      `each variant's uniform set is computed after evaluating its #ifdef/#if/#else conditionals: ` +
        matrix.variants.map((variant) => `${variant.id}=${variant.referencedCount}`).join(", ") +
        ` (declared but unreferenced uniforms are excluded and recorded: ${matrix.defaultVariant.declaredButUnreferenced.length} in the default config)`,
      { phase: "generation" },
    ),
    check(
      "no-conflicting-declarations-across-variants",
      matrix.inconsistencies.filter((entry) => entry.expected.split("[")[0] !== entry.actual.split("[")[0]).length === 0,
      `type conflicts across variants: ${JSON.stringify(matrix.inconsistencies.filter((entry) => entry.expected.split("[")[0] !== entry.actual.split("[")[0]))}; ` +
        `array sizes vary with TEXTURE_UNITS by design (recorded per variant in sizesByVariant)`,
      { phase: "generation" },
    ),
    check(
      "default-config-uniform-table",
      defaultLayout.members.length > 30 && defaultLayout.members.every((member) => Number.isInteger(member.byteOffset) && member.byteOffset % member.align === 0) && defaultLayout.structSize > 0,
      `default MVP config: ${defaultLayout.members.length} numeric member(s) + ${defaultLayout.samplers.length} sampler binding(s), structSize=${defaultLayout.structSize} bytes, ` +
        `align=${defaultLayout.structAlign}; every byteOffset is a multiple of its member alignment`,
      { phase: "generation" },
    ),
    check(
      "union-layout-covers-every-reachable-variant",
      unionUniforms.every((entry) => unionLayout.members.some((member) => member.name === entry.name) || unionLayout.samplers.some((sampler) => sampler.glslName === entry.name)) &&
        unionUniforms.every((entry) => {
          const member = unionLayout.members.find((candidate) => candidate.name === entry.name);
          return member === undefined || member.length >= Math.max(...entry.sizesByVariant);
        }),
      `union over ${matrix.variants.length} variants = ${unionUniforms.length} uniform(s) → ${unionLayout.members.length} struct member(s) + ${unionLayout.samplers.length} sampler binding(s); ` +
        `every array is sized to the maximum over the matrix (e.g. ${unionUniforms.filter((entry) => entry.size > 1).map((entry) => `${entry.name}[${entry.size}]`).join(", ") || "none"})`,
      { phase: "generation" },
    ),
    check(
      "layout-matches-independent-wgsl-recomputation",
      defaultCrossCheck.ok && unionCrossCheck.ok,
      `independent parse of the generated WGSL (struct members + WGSL alignment rules recomputed from scratch) agrees with the CPU table: ` +
        `default problems=[${defaultCrossCheck.problems.join("; ")}], union problems=[${unionCrossCheck.problems.join("; ")}]`,
      { phase: "generation" },
    ),
    check(
      "mat3-column-padding-and-vec3-alignment",
      (() => {
        const normal = unionLayout.members.find((member) => member.glslType === "mat3");
        const vec3 = unionLayout.members.filter((member) => member.glslType === "vec3" && member.length === 1);
        return normal !== undefined && normal.columns === 3 && normal.columnStride === 16 && normal.byteSize === 48 && normal.byteOffset % 16 === 0 && vec3.length > 0 && vec3.every((member) => member.align === 16 && member.byteSize === 12);
      })(),
      `mat3 (${unionLayout.members.filter((member) => member.glslType === "mat3").map((member) => `${member.name} size=${member.byteSize} columnStride=${member.columnStride}`).join(", ") || "none"}) — 3 columns × 16-byte padding; ` +
        `${unionLayout.members.filter((member) => member.glslType === "vec3" && member.length === 1).length} vec3 member(s) each align=16/size=12`,
      { phase: "generation" },
    ),
    check(
      "array-element-stride-16",
      unionLayout.members.filter((member) => member.length > 1).length > 0 &&
        unionLayout.members
          .filter((member) => member.length > 1)
          .every((member) => member.arrayStride % 16 === 0 && member.byteOffset % 16 === 0 && (member.paddedElement === true ? member.elementWgslType.startsWith("vec4<") : true)),
      `every array member is 16-byte strided and 16-byte aligned, as the uniform address space requires ` +
        `(StrideOf(array<T,N>) = 16 × k'; RequiredAlignOf(array<T,N>, uniform) = roundUp(16, AlignOf(T))): ` +
        `${unionLayout.members.filter((member) => member.length > 1).map((member) => `${member.name}[${member.length}] ${member.wgslType} stride=${member.arrayStride}@${member.byteOffset}`).join(", ") || "none"}`,
      { phase: "generation" },
    ),
    check(
      "packed-arrays-widened-to-a-conforming-element",
      unionLayout.members.filter((member) => member.length > 1 && member.paddedElement === true).length > 0 &&
        unionLayout.members.filter((member) => member.length > 1 && member.paddedElement !== true).every((member) => member.arrayStride % 16 === 0),
      (() => {
        const widened = unionLayout.members.filter((member) => member.length > 1 && member.paddedElement === true);
        return `DECLARED LAYOUT DEVIATION (the conforming one): ${widened.map((member) => `${member.name}[${member.length}] GLSL ${member.glslType} → ${member.wgslType} stride=16`).join(", ")} — ` +
          `WGSL derives an array's element stride from its element type and has no stride attribute, so a packed element (stride 4/8) cannot satisfy the uniform address space's 16-byte ` +
          `requirement; the specification's own remedy is to change the element type. The widening is this generator's choice, it is declared here, the CPU writer writes only the meaningful ` +
          `lane(s) of each element, and the real-device assertion (run-gpu.mjs) re-derives every slot from the same table. The alternative — the compact 4-byte layout the first G-4 run used — ` +
          `is only valid where the uniform_buffer_standard_layout language extension is announced, i.e. it makes correctness depend on the implementation being lenient (plan's R-1 row).`;
      })(),
      { phase: "generation", conservativeLayout: true },
    ),
    check(
      "spherical-harmonic-size-9-handled",
      sphericalUniforms.length === 1 &&
        sphericalLayout.members.length === 1 &&
        sphericalLayout.members[0].length === 9 &&
        sphericalLayout.members[0].elementWgslType === "vec3<f32>" &&
        sphericalLayout.members[0].arrayStride === 16 &&
        sphericalLayout.members[0].byteSize === 144,
      `assembled the real upstream shader that references it (${spherical.id}): ${sphericalUniforms.map((entry) => `${entry.glslType}[${entry.size}] ${entry.name}`).join(", ")} → ` +
        `${sphericalLayout.members.map((member) => `${member.wgslType} stride=${member.arrayStride} byteSize=${member.byteSize}`).join(", ") || "not generated"} (9 vec3 elements × 16-byte stride = 144 bytes)`,
      { phase: "generation" },
    ),
    check(
      "samplers-excluded-from-uniform-struct",
      unionLayout.samplers.length > 0 &&
        unionLayout.samplers.every((sampler) => /^texture_/.test(sampler.textureType) && sampler.textureBinding >= 1 && sampler.samplerBinding === sampler.textureBinding + 1) &&
        unionLayout.members.every((member) => !/sampler/.test(member.glslType)),
      `sampler uniforms → bindings: ${unionLayout.samplers.map((sampler) => `${sampler.name} (${sampler.glslType} → ${sampler.textureType} @binding(${sampler.textureBinding}) + sampler @binding(${sampler.samplerBinding}))`).join(", ")}`,
      { phase: "generation" },
    ),
    check(
      "bool-uniform-mapped-to-u32",
      unionLayout.members.filter((member) => member.glslType === "bool" || member.glslType.startsWith("bvec")).every((member) => member.scalar === "u32") &&
        unionLayout.members.some((member) => member.glslType === "bool"),
      `GLSL bool/bvec members: ${unionLayout.members.filter((member) => member.glslType === "bool" || member.glslType.startsWith("bvec")).map((member) => `${member.glslType} ${member.name} → ${member.wgslType}`).join(", ") || "none"} ` +
        `(bool is not host-shareable in the WGSL uniform address space)`,
      { phase: "generation" },
    ),
  ];

  // ---- real-device half (T019b) --------------------------------------------------------------------
  let gpuReport = null;
  if (options.skipGpu) {
    checks.push(check("gpu-pixel-assertion", false, "--skip-gpu was passed: the real-device assertion did not run in this invocation", { phase: "gpu" }));
  } else {
    const { runGpu, runNegativeControl } = await import("./run-gpu.mjs");
    gpuReport = await runGpu({ quiet: options.quiet, layout: unionLayout, wgsl: unionWgsl });
    checks.push(...gpuReport.checks.map((entry) => ({ ...entry, phase: "gpu" })));
    // Negative control: a deliberately shifted byte offset MUST be detected (otherwise the assertion is vacuous).
    const control = await runNegativeControl({ quiet: true });
    checks.push(
      check(
        "gpu-negative-control-detects-shifted-layout",
        control.verdict === "pass",
        `negative control (member "${control.measurements.shiftedMember}" written 4 bytes late): verdict=${control.verdict}, ` +
          `mismatching component(s)=${control.measurements.mismatchCount}, mismatching slots=${JSON.stringify(control.measurements.mismatchingSlots)} ` +
          `vs the shifted member's slots=${JSON.stringify(control.measurements.shiftedSlots)} — a device assertion that cannot fail proves nothing`,
        { phase: "gpu" },
      ),
    );
  }

  const failed = checks.filter((entry) => entry.ok !== true);
  const verdict = failed.length === 0 ? "pass" : "fail";

  const evidence = [
    { path: "experiments/gates/out/g4-layout.json", what: "generated layouts: define matrix, per-variant referenced uniforms, default-config per-field table (byteOffset/byteSize/arrayStride/columnStride), union layout, spherical-harmonics case" },
    { path: "experiments/gates/out/g4-glsl-variants.json", what: "per-variant uniform sets extracted from the real assembled GLSL (declared vs referenced)" },
    { path: "experiments/gates/out/g4-uniform.wgsl", what: "the generated WGSL struct + bindings + the verification program compiled on the real device" },
    { path: "experiments/gates/out/g4-slots.json", what: "slot plan + CPU-expected RGBA values used by the pixel assertion" },
    { path: "experiments/gates/out/g4-gpu.json", what: "real-device assertion report (pipeline compile diagnostics, per-slot readback comparison, per-field perturbation matrix)" },
    { path: "experiments/gates/out/g4-control-shift.json", what: "negative control: a deliberately shifted byte offset MUST be detected by the same assertions (and localised to the affected field)" },
    { path: "experiments/gates/out/g4-run.log", what: "runner transcript of this execution" },
    { path: "experiments/gates/g4-uniform-layout/assemble-glsl.mjs", what: "real GLSL assembly through the upstream ShaderSource + the MVP define matrix" },
    { path: "experiments/gates/g4-uniform-layout/uniform-layout.mjs", what: "the generator under test (WGSL struct + CPU layout table + slot plan)" },
    { path: "experiments/gates/g4-uniform-layout/layout.test.mjs", what: "T019 (a): unit cross-check of layout ↔ WGSL" },
    { path: "experiments/gates/g4-uniform-layout/run-gpu.mjs", what: "T019 (b): real-device pixel assertion (identity-style writes + per-field perturbation + the shifted-offset negative control)" },
    { path: "experiments/gates/g4-uniform-layout/gpu-probe.js", what: "in-page WebGPU program: compiles the generated WGSL, writes the struct through the CPU table, reads back" },
    { path: "docs/gate-g4-conclusion.md", what: "human-readable conclusion (basis, evidence paths, verdict, consequences)" },
  ];

  const defaultSample = defaultLayout.members.slice(0, 6).map((member) => `${member.name}@${member.byteOffset}+${member.byteSize}`).join(", ");
  const document = {
    gate: "g4",
    task: "T018",
    verdict,
    recordedAt: new Date().toISOString(),
    notes:
      (verdict === "pass"
        ? "G-4 通过：地形着色器 uniform 布局由**拼装后的真实 GLSL**（上游 ShaderSource + Globe.js:679-687 的真实源与 GlobeSurfaceShaderSet:278-377 的真实 define）实际引用的名字集合生成，" +
          `覆盖 MVP define 矩阵 ${matrix.variants.length} 个变体的并集（` +
          `${unionLayout.members.length} 个 struct 成员 + ${unionLayout.samplers.length} 个 sampler 绑定，默认配置 ${defaultLayout.members.length} 个成员）；` +
          "含 mat3 列 16 字节填充（size 48）、vec3→16 字节对齐、数组元素 16 字节 stride、bool→u32（uniform 地址空间不允许 bool），" +
          "`size 9` 的 czm_sphericalHarmonicCoefficients 用在**真实**上游着色器（glTF image-based lighting）上单独验证（地形路径不引用它）：array<vec3<f32>,9> stride=16 → 144 字节；" +
          "生成布局与**独立重新解析 WGSL** 的结果逐字段一致；真机像素断言：按 CPU 布局表写入已知值 → 回读逐 slot 相等，且**逐字段扰动**只改变该字段对应的 slot（证明每个 uniform 都真正生效）。" +
          "边界：本门禁不生成 bind group 之外的东西，也不主张着色器发射（G-5）；sampler 数组按元素展开为独立 binding（固定长度纹理数组需 binding_array，未作为核心保证）。"
        : `G-4 未通过（verdict=${verdict}）：共 ${failed.length} 项检查失败 → ${failed.map((entry) => entry.id).join(", ")}。` +
          "按 plan 的失败动作：退化为「每标量一个 vec4 槽」的保守布局 → STOP 并上报入口 Agent 修订 plan.md（阶段子代理不得自行修改 plan/contracts/spec）。"),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      engine: { packageName: enginePackage.name, version: enginePackage.version, lock: "upstream/engine-26.3.0.lock.json" },
      browser: gpuReport?.environment?.browser ?? null,
      adapter: gpuReport?.environment?.adapter ?? null,
      preferredFormat: gpuReport?.environment?.preferredFormat ?? null,
    },
    checks,
    evidence: evidence.filter((entry) => fs.existsSync(path.resolve(REPO_ROOT, entry.path))),
    gateCriteria: {
      source: "plan.md「实现前的验证门」G-4 行；tasks.md T018/T019",
      requirements: [
        "从拼装后的真实 GLSL 实际引用的 uniform 名集合生成 WGSL struct 与 CPU 侧布局表",
        "含 mat3 列填充、数组元素 16 字节对齐、vec3→16 字节对齐、size 9 的 czm_sphericalHarmonicCoefficients",
        "对地形着色器全部 uniform 产出逐字段偏移表（byteOffset/byteSize/arrayStride）",
        "(a) 单元交叉校验「生成布局 ↔ WGSL 结构逐字段一致」；(b) 真机断言地形全部 uniform 生效",
      ],
      requiredVerdict: "pass",
      failureAction: "退化为「每标量一个 vec4 槽」的保守布局 → STOP 上报入口 Agent 修订 plan",
    },
    measurements: {
      defineMatrix: MVP_DEFINE_MATRIX,
      excludedDefines: EXCLUDED_DEFINES,
      automaticUniformCount: matrix.automaticUniformCount,
      variants: generated.variants.map((variant) => ({ id: variant.id, referencedCount: variant.referencedCount, defines: variant.defines })),
      unionCount: unionUniforms.length,
      defaultConfig: { memberCount: defaultLayout.members.length, samplerCount: defaultLayout.samplers.length, structSize: defaultLayout.structSize, sampleFields: defaultSample },
      unionConfig: { memberCount: unionLayout.members.length, samplerCount: unionLayout.samplers.length, structSize: unionLayout.structSize, padding: unionLayout.padding, bindingCount: unionLayout.bindingCount },
      crossCheck: { default: defaultCrossCheck.problems, union: unionCrossCheck.problems, independentStructSize: unionCrossCheck.independent.structSize },
      sphericalHarmonics: { uniforms: sphericalUniforms, layout: sphericalLayout.members },
      defaultFieldTable: defaultLayout.members.map((member) => ({ name: member.name, glslType: member.glslType, wgslType: member.wgslType, byteOffset: member.byteOffset, byteSize: member.byteSize, align: member.align, arrayStride: member.arrayStride, columnStride: member.columnStride, length: member.length })),
      samplers: unionLayout.samplers,
      gpu: gpuReport?.measurements ?? null,
    },
    findings: gpuReport?.findings ?? [],
    deviations: [
      {
        id: "D-1",
        what: "tasks.md T018 提到「默认配置 92 个声明」，实测上游 AutomaticUniforms 声明 93 个自动 uniform。",
        how: "门禁以实测为准（automaticUniformCount=93，记录在 g4-layout.json 与 measurements 中）；不修改 research/tasks。",
      },
      {
        id: "D-2",
        what: "T018 把 `size 9` 的 czm_sphericalHarmonicCoefficients 列为必须覆盖的用例，但地形着色器（GlobeVS/GlobeFS）**不引用**它。",
        how: "不为凑用例而虚构 uniform：改用**真实引用它的上游着色器**（Shaders/Model/ImageBasedLightingStageFS.js，glTF image-based lighting）经同一 ShaderSource 装配后验证 size 9 → array<vec3<f32>,9>、stride 16、144 字节。",
      },
      {
        id: "D-3",
        what: "T018 要求对「地形着色器全部 uniform」产出逐字段偏移表；不同 TEXTURE_UNITS 下同名数组的长度不同（如 u_dayTextures[1..3]）。",
        how: "同时产出两份布局：默认配置的逐字段表（写入 artefact 的 measurements.defaultFieldTable）与 define 矩阵并集布局（数组长度取矩阵最大，保证任何可达变体都在表内），并把 sizesByVariant 逐条记录。",
      },
      {
        id: "D-4",
        what: "GLSL 的 `sampler2D x[N]` 在 WGSL 中无法作为固定长度纹理数组核心保证（需 binding_array）。",
        how: "生成器把 sampler 数组按元素展开为独立的 texture+sampler binding（budget: 每个 sampler 2 个 binding），并断言 sampler 不出现在 uniform struct 中。",
      },
    ],
  };

  fs.writeFileSync(path.join(OUT_DIR, "g4-run.log"), `${logLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "g4.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  log(`verdict=${verdict} (${checks.filter((entry) => entry.ok === true).length}/${checks.length} checks ok) -> experiments/gates/out/g4.json`);
  for (const entry of failed) log(`  FAIL ${entry.id}: ${entry.detail}`);

  if (verdict === "pass") return 0;
  process.stderr.write(
    `g4-uniform-layout: STOP — G-4 verdict=${verdict}. Phase 2 门禁未通过时不得开始 Phase 3；` +
      "失败动作见 plan.md「实现前的验证门」（退化为每标量一个 vec4 槽的保守布局），由入口 Agent 修订 plan.md。\n",
  );
  return 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, "g4-run.log"), `${logLines.join("\n")}\n`, "utf8");
      fs.writeFileSync(
        path.join(OUT_DIR, "g4.json"),
        `${JSON.stringify(
          {
            gate: "g4",
            task: "T018",
            verdict: "partial",
            recordedAt: new Date().toISOString(),
            notes: `G-4 runner 异常终止：${error?.message ?? error}。未完成的检查一律视为失败；STOP 并上报入口 Agent。`,
            environment: { node: process.version, platform: `${process.platform} ${process.arch}` },
            checks: [check("runner-completed", false, `runner threw: ${error?.message ?? error}`)],
            evidence: [{ path: "experiments/gates/g4-uniform-layout/run.mjs", what: "runner that failed" }],
            error: { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack ?? null },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      process.stderr.write(`g4-uniform-layout: unexpected failure: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    });
}
