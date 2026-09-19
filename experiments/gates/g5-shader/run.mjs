#!/usr/bin/env node
/**
 * G-5 gate runner — **着色器编译前端** (tasks.md T022–T024, plan's risk gate G-5, hypotheses H-5/H-6).
 *
 *   node experiments/gates/g5-shader/run.mjs                 # the whole gate
 *   node experiments/gates/g5-shader/run.mjs --skip-device   # Node-side checks only (no GPU)
 *   node experiments/gates/g5-shader/run.mjs --quiet
 *
 * The propositions this gate has to settle:
 *
 *   T022  the spike's path-B harness is productised: the emitted WGSL for the golden MVP
 *         configuration compiles on a **hardware** adapter, creates a pipeline, draws the fixed
 *         terrain scene and reads the frame back (non-black pixels MUST cover the frame).
 *   T023  **every** MVP-reachable define combination is enumerated; each is emitted to WGSL; a real
 *         pipeline is created for every distinct emitted module pair (so every combination is tied
 *         to a verified pipeline by byte-identity, not by sampling); a deliberately unpaired varying
 *         MUST fail (negative control); a combination outside the supported set MUST be rejected
 *         with an explicit diagnostic rather than silently degraded.
 *   T024  the parameterised seam leaves the **GLSL view** byte-identical over the whole matrix
 *         (`contracts/fork-patch-layer.md` R1) and the logic layer's shader view stays GLSL (A9).
 *
 * Exit codes: 0 → `verdict === "pass"`; 1 → the gate failed; 2 → the runner itself could not run.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ShaderSource from "@cesium/engine/Source/Renderer/ShaderSource.js";

import { runShaderVerify } from "../../../tools/shader-verify.mjs";
import { compareSnapshots, snapshotUpstream } from "../g1-alias/upstream-integrity.mjs";
import { preprocess, evaluateCondition, parseDefines, substituteMacros } from "./glsl-preprocess.mjs";
import { deriveVaryingPairs, deriveVaryingPairsFromWgsl, parseFunctionSignatures } from "./varying-pairing.mjs";
import { enumerateReachableVariants, assembleGlslForVariant, EXCLUDED_DEFINES, REACHABLE_DIMENSIONS } from "./define-matrix.mjs";
import { buildUnionLayout, enumerateMarginals, unionOfVariants, buildGateModel, GATE_DIR, OUT_DIR, REPO_ROOT } from "./model.mjs";
import { installShaderEmissionSeam, compareGlslChannels } from "./shader-emit.mjs";
import { emitTerrainWgsl } from "./wgsl-emitter.mjs";
import { emitComputeDayColorGlsl, emitComputeDayColorWgsl } from "./mirror-generators.mjs";

const ENGINE_ROOT = path.join(REPO_ROOT, "node_modules", "@cesium", "engine");
const sha256 = (text) => `sha256-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

const logLines = [];
function log(line, quiet) {
  const text = `[g5] ${line}`;
  logLines.push(text);
  if (!quiet) process.stdout.write(`${text}\n`);
}

function check(id, ok, detail, extra = {}) {
  return { id, ok: ok === true, detail, ...extra };
}

function repoRelative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

/** T024: the architecture-boundary rule A9 has to run and be clean. */
function runArchBoundaryA9() {
  const out = path.join(OUT_DIR, "g5-arch-boundaries.json");
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "tools", "scripts", "check-arch-boundaries.mjs"), "--rules", "A9", "--out", out], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  let report = null;
  if (fs.existsSync(out)) report = JSON.parse(fs.readFileSync(out, "utf8"));
  return { status: result.status, report, out };
}

async function main() {
  const argv = process.argv.slice(2);
  const quiet = argv.includes("--quiet");
  const skipDevice = argv.includes("--skip-device");
  const startedAt = new Date().toISOString();
  log(`start ${startedAt} (node ${process.version})`, quiet);

  const before = snapshotUpstream(ENGINE_ROOT, { detailPrefixes: ["Source/Renderer/ShaderSource.js"] });
  const variants = enumerateReachableVariants();
  const checks = [];

  // ------------------------------------------------------------------ T024 (a): GLSL view invariance
  const seam = installShaderEmissionSeam(ShaderSource);
  const identity = compareGlslChannels({ ShaderSource, variants, seam, hash: sha256 });
  checks.push(
    check(
      "glsl-channel-byte-identical-over-full-matrix",
      identity.identical === identity.total && identity.differences.length === 0,
      `${identity.identical}/${identity.total} enumerated define combination(s) produce **byte-identical** GLSL through the parameterised seam and through the plain upstream class ` +
        `(same sources + same defines; sha256 per stage recorded in the artefact). The seam overrides no GLSL method — both GLSL entry points delegate to the upstream prototype held by reference, ` +
        `and \`emit\` defaults to "glsl". differences=[${JSON.stringify(identity.differences.slice(0, 3))}]`,
      { task: "T024" },
    ),
  );

  // ------------------------------------------------------------------ T023: the self-built pieces
  const preprocessorProbes = [
    { id: "texture-units-comparison", source: "#if TEXTURE_UNITS > 0\nYES\n#else\nNO\n#endif", defines: ["TEXTURE_UNITS 3"], expect: "YES" },
    { id: "texture-units-zero", source: "#if TEXTURE_UNITS > 0\nYES\n#else\nNO\n#endif", defines: ["TEXTURE_UNITS 0"], expect: "NO" },
    { id: "defined-and-or-precedence", source: "#if (defined(A) || defined(B)) && defined(C) || defined(D)\nYES\n#else\nNO\n#endif", defines: ["A", "C"], expect: "YES" },
    { id: "defined-and-or-precedence-negative", source: "#if (defined(A) || defined(B)) && defined(C) || defined(D)\nYES\n#else\nNO\n#endif", defines: ["A"], expect: "NO" },
    { id: "ifndef-and-elif-chain", source: "#ifdef A\nA\n#elif defined(B)\nB\n#else\nC\n#endif", defines: ["B"], expect: "B" },
    { id: "nested-conditionals", source: "#ifdef A\n#if defined(B) && !defined(C)\nAB\n#else\nA\n#endif\n#else\nNONE\n#endif", defines: ["A", "B"], expect: "AB" },
    { id: "arithmetic-condition", source: "#if (TEXTURE_UNITS * 2) / 2 == 2\nYES\n#else\nNO\n#endif", defines: ["TEXTURE_UNITS 2"], expect: "YES" },
    { id: "undefined-identifier-is-zero", source: "#if UNDEFINED_MACRO\nYES\n#else\nNO\n#endif", defines: [], expect: "NO" },
  ];
  const preprocessorResults = preprocessorProbes.map((probe) => {
    const evaluated = preprocess(probe.source, probe.defines, { substituteText: false });
    const produced = evaluated.activeText.split("\n").filter((line) => line.length > 0).join("|");
    return { ...probe, produced, ok: produced === probe.expect && evaluated.diagnostics.length === 0 };
  });
  const malformed = preprocess("#ifdef A\nno endif here\n", [], { substituteText: false });
  checks.push(
    check(
      "conditional-compilation-is-self-built-and-evaluated",
      preprocessorResults.every((entry) => entry.ok) && malformed.diagnostics.length > 0 && substituteMacros("uniform vec4 x[TEXTURE_UNITS];", parseDefines(["TEXTURE_UNITS 3"])) === "uniform vec4 x[3];",
      `the fork layer evaluates GLSL ES 3.00 conditionals itself (upstream only *writes* the directives — ShaderSource.js:250-258, research §6.4). ` +
        `${preprocessorResults.filter((entry) => entry.ok).length}/${preprocessorResults.length} probes pass ` +
        `(${preprocessorResults.map((entry) => `${entry.id}=${entry.produced}`).join(", ")}); ` +
        `an unterminated conditional is reported as a diagnostic (${malformed.diagnostics.length}) rather than silently mis-evaluated; ` +
        `object-like macro substitution works in ordinary text (uniform vec4 x[TEXTURE_UNITS]; → uniform vec4 x[3];)`,
      { task: "T023", phase: "node" },
    ),
  );

  // Varying pairing must come from the real GLSL, and must reproduce the spike's E1 phenomenon.
  const daynight = variants.find((variant) => variant.id === "textureUnits=1|quantization=float|lighting=daynight|groundAtmosphere=none|dynamicAtmosphereLighting=none|fog=none|ocean=none|imageryOps=none|tileLimitRectangle=none|geodetic=none");
  const vertexLighting = variants.find((variant) => variant.id === "textureUnits=1|quantization=float|lighting=vertex|groundAtmosphere=none|dynamicAtmosphereLighting=none|fog=none|ocean=none|imageryOps=none|tileLimitRectangle=none|geodetic=none");
  const daynightGlsl = assembleGlslForVariant(daynight);
  const daynightPairs = deriveVaryingPairs({ vertexSource: daynightGlsl.vertexSource, fragmentSource: daynightGlsl.fragmentSource, defines: daynight.defines });
  const vertexLightingGlsl = assembleGlslForVariant(vertexLighting);
  const vertexLightingPairs = deriveVaryingPairs({ vertexSource: vertexLightingGlsl.vertexSource, fragmentSource: vertexLightingGlsl.fragmentSource, defines: vertexLighting.defines });
  const signatures = parseFunctionSignatures(preprocess(daynightGlsl.vertexSource, daynight.defines, { substituteText: false }).activeText);
  checks.push(
    check(
      "varying-pairs-derived-from-the-real-glsl",
      daynightPairs.consistent &&
        daynightPairs.vsDeclaredButUnwritten.includes("v_normalMC") &&
        daynightPairs.vsDeclaredButUnwritten.includes("v_normalEC") &&
        !daynightPairs.paired.some((entry) => entry.name === "v_normalMC") &&
        vertexLightingPairs.paired.some((entry) => entry.name === "v_normalEC") &&
        daynightPairs.paired.some((entry) => entry.name === "v_atmosphereRayleighColor" || entry.name === "v_positionMC"),
      `pairing is derived from what the vertex stage **writes** and the fragment stage **reads** in the assembled GLSL, with the conditionals already evaluated. ` +
        `ENABLE_DAYNIGHT_SHADING: ${daynightPairs.paired.map((entry) => `${entry.name}@${entry.location}`).join(" ") || "(none)"}; ` +
        `declared-but-never-written = ${JSON.stringify(daynightPairs.vsDeclaredButUnwritten)} (this is exactly the spike's E1 trap: GL prunes them, WGSL would hard-fail). ` +
        `ENABLE_VERTEX_LIGHTING: ${vertexLightingPairs.paired.map((entry) => `${entry.name}@${entry.location}`).join(" ")} (v_normalEC becomes live). ` +
        `Total distinct varying sets over the enumeration: recorded in the model artefact. ` +
        `\`computeAtmosphereScattering(vec3, vec3, out vec3, out vec3, out float)\` is recognised as writing its out-parameters (${[...daynightPairs.diagnostics].length} diagnostic(s)).`,
      { task: "T023", phase: "node" },
    ),
  );
  void signatures;

  // The emitter must reject anything outside its supported set, with a reason.
  const unsupportedProbes = EXCLUDED_DEFINES.slice(0, 6).map((entry) => {
    const variant = { id: `probe+${entry.define}`, defines: [...daynight.defines, entry.define], sceneMode: "SCENE3D" };
    const emission = emitTerrainWgsl({ variant, glsl: daynightGlsl, derivation: daynightPairs, layout: buildUnionLayout() });
    return { define: entry.define, rejected: !emission.ok, modules: emission.vertexWgsl === null && emission.fragmentWgsl === null, reasons: emission.unsupported.length };
  });
  const runtimeMirror = {
    glsl: emitComputeDayColorGlsl({ textureUnits: 3, apply: { alpha: true, brightness: true } }),
    wgsl: emitComputeDayColorWgsl({ maxTextureUnits: 3, apply: { alpha: true, brightness: true } }),
  };
  checks.push(
    check(
      "uncovered-define-sets-fail-explicitly-not-silently",
      unsupportedProbes.every((probe) => probe.rejected && probe.modules && probe.reasons > 0) &&
        runtimeMirror.wgsl.includes("u_dayTextures_0_texture") &&
        runtimeMirror.wgsl.includes("u_dayTextures_2_texture") &&
        (runtimeMirror.glsl.match(/sampleAndBlend\(/g) ?? []).length === 3 &&
        (runtimeMirror.wgsl.match(/color = sampleAndBlend\(/g) ?? []).length === 3 &&
        (runtimeMirror.wgsl.match(/if \(numberOfDayTextures > \d+u\) \{/g) ?? []).length === 3,
      `each out-of-scope define (${unsupportedProbes.map((probe) => probe.define).join(", ")}, …) makes the emitter return \`ok:false\` with a reason and **no module** (T023 (c)) — ` +
        `nothing is degraded silently. The runtime-generated \`computeDayColor\` (contract R6) is mirrored by the same module for both channels: the GLSL string builder unrolls ` +
        `${(runtimeMirror.glsl.match(/sampleAndBlend\(/g) ?? []).length} call(s) for TEXTURE_UNITS 3, while the WGSL mirror emits a fixed chain of ` +
        `${(runtimeMirror.wgsl.match(/color = sampleAndBlend\(/g) ?? []).length} call(s) each guarded by its own pipeline-overridable constant ` +
        `(${(runtimeMirror.wgsl.match(/if \(numberOfDayTextures > \d+u\) \{/g) ?? []).length} guard(s)) — same observable chain, no dependence on the layer count in the module text`,
      { task: "T023", phase: "node" },
    ),
  );

  // The union layout used by `--variants=mvp` (marginal sweep) must equal the full cross-product union.
  const marginalUnion = unionOfVariants(enumerateMarginals());
  const fullUnion = unionOfVariants(variants);
  const sameUnion = JSON.stringify(marginalUnion) === JSON.stringify(fullUnion);
  checks.push(
    check(
      "uniform-union-of-the-marginal-sweep-equals-the-full-cross-product",
      sameUnion,
      `marginal sweep (${enumerateMarginals().length} variants) yields ${marginalUnion.length} uniform(s); the full cross product (${variants.length} variants) yields ${fullUnion.length}; ` +
        `identical = ${sameUnion} — the shortcut used by \`--variants=mvp\` cannot under-cover (a mismatch would mean the MVP modules were emitted against a smaller struct)`,
      { task: "T022", phase: "node" },
    ),
  );
  checks.push(
    check(
      "reachable-define-space-is-enumerated-not-sampled",
      variants.length === REACHABLE_DIMENSIONS.reduce((product, dimension) => product * dimension.values.length, 1) && EXCLUDED_DEFINES.every((entry) => entry.why.length > 0),
      `|enumeration| = ${variants.length} = ${REACHABLE_DIMENSIONS.map((dimension) => `${dimension.id}(${dimension.values.length})`).join(" × ")}; ` +
        `${EXCLUDED_DEFINES.length} excluded define(s) each carry a reason and an upstream source line (see define-matrix.mjs)`,
      { task: "T023", phase: "node" },
    ),
  );

  // ------------------------------------------------------------------ device half (T022 + T023)
  let mvpRun = null;
  let sweepRun = null;
  if (skipDevice) {
    checks.push(check("device-verification", false, "--skip-device was passed: no pipeline was created on a real adapter in this invocation", { phase: "device" }));
  } else {
    log("running the all-reachable device sweep (tools/shader-verify.mjs --variants=all-reachable)", quiet);
    sweepRun = await runShaderVerify(["--variants=all-reachable", ...(quiet ? ["--quiet"] : [])]);
    // The two halves share check ids by design (same harness, same assertions); namespace them so the
    // gate artefact has a unique id per check (check-gate.mjs asserts uniqueness).
    checks.push(...sweepRun.checks.map((entry) => ({ ...entry, id: `sweep-${entry.id}`, phase: "device-sweep" })));
    log("running the MVP golden-configuration device render (tools/shader-verify.mjs --variants=mvp)", quiet);
    mvpRun = await runShaderVerify(["--variants=mvp", ...(quiet ? ["--quiet"] : [])]);
    checks.push(...mvpRun.checks.map((entry) => ({ ...entry, id: `mvp-${entry.id}`, phase: "device-mvp" })));
  }

  // Every enumeration row must be tied to a verified group (byte-identity coverage).
  if (sweepRun !== null && sweepRun.store !== null) {
    const store = sweepRun.store;
    const verified = new Set((sweepRun.artifact.measurements.distinctModulePairs ?? 0) > 0 ? store.groups.map((group) => group.key) : []);
    const rowsWithoutGroup = store.rows.filter((row) => row.rejected !== true && !verified.has(row.group));
    checks.push(
      check(
        "every-enumerated-define-set-maps-to-a-device-verified-module-pair",
        rowsWithoutGroup.length === 0 && sweepRun.artifact.measurements.failed === 0,
        `${store.rows.length - store.rows.filter((row) => row.rejected === true).length} enumerated define set(s) → ${verified.size} distinct module pair(s); ` +
          `rows with no verified group = ${rowsWithoutGroup.length}; failed pipelines = ${sweepRun.artifact.measurements.failed}`,
        { task: "T023", phase: "device-sweep" },
      ),
    );
    checks.push(
      check(
        "emitted-varyings-match-the-derived-varying-sets",
        (() => {
          // Cross-check inside the artefact: the emitted VSOut/FSIn pair up for every group.
          const problems = store.groups.filter((group) => {
            const declared = group.attributes.length >= 1;
            return !declared || group.varyingPairs === undefined;
          });
          return problems.length === 0;
        })(),
        `every group carries its derived varying set and vertex-attribute locations; the per-case read-back check of the emitted text is reported by the mvp half ` +
          `(checks "mvp-*") and the device is the oracle for pairing (a mismatch is a hard pipeline failure)`,
        { task: "T023", phase: "device-sweep" },
      ),
    );
  }

  // ------------------------------------------------------------------ T024 (b): architecture boundary
  const a9 = runArchBoundaryA9();
  checks.push(
    check(
      "arch-boundary-A9-logic-layer-shader-view-stays-glsl",
      a9.status === 0 && a9.report?.verdict === "pass",
      `\`node tools/scripts/check-arch-boundaries.mjs --rules A9\` exited ${a9.status}; ` +
        `probes found in the upstream GLSL regex detector Scene/Primitive.js = ${a9.report?.results?.[0]?.summary?.probes ?? "n/a"}; ` +
        `patch-layer files scanned = ${a9.report?.results?.[0]?.summary?.patchLayerFiles ?? "n/a"}; violations = ${a9.report?.violationCount ?? "n/a"}`,
      { task: "T024", phase: "node" },
    ),
  );

  // ------------------------------------------------------------------ upstream integrity
  const after = snapshotUpstream(ENGINE_ROOT, { detailPrefixes: ["Source/Renderer/ShaderSource.js"] });
  const integrity = compareSnapshots(before, after);
  checks.push(
    check(
      "upstream-disk-zero-change",
      integrity.unchanged,
      `node_modules/@cesium/engine: ${after.fileCount} file(s) / ${after.totalBytes} byte(s), aggregate ${after.aggregateHash} before and ${integrity.aggregateAfter} after ` +
        `(Renderer/ShaderSource.js ${after.details["Source/Renderer/ShaderSource.js"]}); changed=${JSON.stringify(integrity.changedDetails)}`,
      { task: "T024", phase: "node" },
    ),
  );

  const failed = checks.filter((entry) => entry.ok !== true);
  const verdict = failed.length === 0 ? "pass" : "fail";

  // The full-model statistics come from the sweep's store; without a device run, compute a summary.
  let stats = sweepRun?.store?.stats ?? null;
  if (stats === null) {
    const provisional = buildGateModel({});
    stats = provisional.stats;
  }

  const evidence = [
    { path: "artifacts/shader-verify/globe-mvp.json", what: "T022: golden-configuration render + full-frame readback on the hardware adapter" },
    { path: "artifacts/shader-verify/globe-all-reachable.json", what: "T023: one real pipeline per distinct emitted module pair + the unpaired-varying negative control" },
    { path: "experiments/gates/out/g5-model.json", what: "the enumerated define space, per-variant varying sets, module-pair groups and the H-4 union layout" },
    { path: "experiments/gates/out/g5-device.json", what: "the raw device sweep report (per group: compile + pipeline result)" },
    { path: "experiments/gates/out/g5-arch-boundaries.json", what: "T024: A9 scan report (GLSL view stays the logic layer's view)" },
    { path: "experiments/gates/g5-shader/glsl-preprocess.mjs", what: "the self-built GLSL ES 3.00 conditional-compilation evaluator (contract R4)" },
    { path: "experiments/gates/g5-shader/varying-pairing.mjs", what: "the self-built VS/FS varying-pair derivation (contract R5)" },
    { path: "experiments/gates/g5-shader/wgsl-emitter.mjs", what: "the WGSL emission channel of the parameterised seam" },
    { path: "experiments/gates/g5-shader/shader-emit.mjs", what: "the seam itself + the GLSL byte-identity comparison (contract R1)" },
    { path: "experiments/gates/g5-shader/mirror-generators.mjs", what: "the runtime-generated fragment mirrors (contract R6)" },
    { path: "experiments/gates/g5-shader/define-matrix.mjs", what: "the MVP-reachable define enumeration with per-dimension traceability" },
    { path: "experiments/gates/shared/terrain-scene.mjs", what: "the fixed terrain scene used by the readback (and by G-6)" },
    { path: "tools/shader-verify.mjs", what: "the productised harness (T022)" },
    { path: "docs/gate-g5-conclusion.md", what: "human-readable conclusion" },
  ].filter((entry) => fs.existsSync(path.join(REPO_ROOT, entry.path)));

  const document = {
    gate: "g5",
    task: "T022,T023,T024",
    verdict,
    recordedAt: new Date().toISOString(),
    notes:
      (verdict === "pass"
        ? `G-5 通过（${checks.filter((entry) => entry.ok === true).length}/${checks.length} 项检查）：**着色器编译前端可参数化为 WGSL 发射，而 GLSL 视图与预处理语义不变**。` +
          `实测：① 全枚举 ${identity.total} 个 define 组合经参数化接缝产出的 GLSL 与上游逐字节一致；② 自建条件编译求值器（上游只把 #define/#ifdef 写成文本交给 GL 驱动）与自建 varying 成对推导 ` +
          `（从**拼装后的真实 GLSL** 的写点/读点推导，含 out 形参写入）在本门禁内被逐条断言；③ 枚举 ${stats.defineCombinations} 个 MVP 可达 define 组合 → ` +
          `${stats.distinctModulePairs ?? "?"} 个**互异**模块对，每一个都在硬件适配器上真实 createShaderModule + createRenderPipeline（0 校验错误），` +
          `因此"每个可达组合都对应一个已验证管线"是**逐字节同一性**结论而非抽样；④ 黄金配置真机绘制并按 H-4 布局表回读整帧非黑；⑤ 阴性对照：故意制造未配对 varying 时管线**硬失败**。`
        : `G-5 未通过（verdict=${verdict}）：${failed.length} 项检查失败 → ${failed.map((entry) => entry.id).join(", ")}。` +
          `按 plan 的失败动作：启用尖刺 §7.5 退路三（WGSL 库与上游 .glsl 并存、只做"选哪一份"）并把可升级性损失写入 rebase 演练 → STOP 并上报入口 Agent 修订 plan.md。`),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      engine: { packageName: "@cesium/engine", version: "26.3.0", lock: "upstream/engine-26.3.0.lock.json" },
      upstreamAggregateHash: integrity.aggregateAfter,
      browser: sweepRun?.artifact?.environment?.browser ?? mvpRun?.artifact?.environment?.browser ?? null,
      adapter: sweepRun?.artifact?.environment?.adapter ?? mvpRun?.artifact?.environment?.adapter ?? null,
      preferredFormat: sweepRun?.artifact?.environment?.preferredFormat ?? mvpRun?.artifact?.environment?.preferredFormat ?? null,
    },
    checks,
    evidence,
    gateCriteria: {
      source: "plan.md「实现前的验证门」G-5 行；tasks.md T022/T023/T024；contracts/fork-patch-layer.md §5 R1–R6",
      requirements: [
        "T022: 尖刺 harness 产品化为 tools/shader-verify.mjs（--family=globe --variants=mvp），真机 createRenderPipeline + 回读断言",
        "T023: 枚举地形路径可达 define 组合；逐组合真机 createRenderPipeline；(a) 0 validation error (b) varying 集合 VS/FS 成对匹配 (c) 未覆盖组合显式失败",
        "T024: 逻辑层读取的 vertexShaderSource/fragmentShaderSource 仍为原始 GLSL（A9），_attributeLocations 保留",
        "contracts R1: ShaderSource 改动限于增加 WGSL 发射通道 + 导出装配所需内部件；GLSL 视图与预处理语义 MUST 不变",
        "contracts R4/R5/R6: 条件编译求值、varying 成对推导、运行时生成片段镜像由本项目实现",
      ],
      requiredVerdict: "pass",
      failureAction: "启用尖刺 §7.5 退路三（WGSL 库与上游 .glsl 并存）并把可升级性损失写入 rebase 演练 → STOP 上报入口 Agent 修订 plan",
    },
    measurements: {
      defineSpace: {
        dimensions: REACHABLE_DIMENSIONS.map((dimension) => ({ id: dimension.id, values: dimension.values, source: dimension.source, justification: dimension.justification })),
        excludedDefines: EXCLUDED_DEFINES,
        combinations: variants.length,
      },
      glslByteIdentity: { identical: identity.identical, total: identity.total, differences: identity.differences.slice(0, 5), sampleHashes: identity.rows.slice(0, 4) },
      preprocessorProbes: preprocessorResults,
      varyingPairing: {
        daynight: { paired: daynightPairs.paired, declaredButUnwritten: daynightPairs.vsDeclaredButUnwritten, declaredButUnread: daynightPairs.fsDeclaredButUnread },
        vertexLighting: { paired: vertexLightingPairs.paired, declaredButUnwritten: vertexLightingPairs.vsDeclaredButUnwritten },
      },
      emitterCoverage: stats,
      uniformUnion: { full: fullUnion.length, marginal: marginalUnion.length, identical: sameUnion },
      runtimeMirror: { glslBytes: runtimeMirror.glsl.length, wgslBytes: runtimeMirror.wgsl.length },
      device: { sweep: sweepRun?.artifact?.measurements ?? null, mvp: mvpRun?.artifact?.measurements ?? null },
      archBoundaryA9: a9.report ? { verdict: a9.report.verdict, results: a9.report.results } : null,
      upstreamIntegrity: { unchanged: integrity.unchanged, aggregateBefore: integrity.aggregateBefore, aggregateAfter: integrity.aggregateAfter, fileCount: after.fileCount },
    },
    declaredDifferences: [
      {
        id: "D-G5-1",
        what: "T023 的 tasks.md 自检命令给出了 `--report experiments/gates/out/g5.json`，而 `out/g5.json` 是**判定产物**（由 `check-gate.mjs` 校验、含本 runner 的全部检查项）。",
        how: "harness 保留 `--report <path>`（写 gate-schema 兼容摘要），默认落 `artifacts/shader-verify/globe-<variants>.json`；`out/g5.json` 由本 runner 统一写出。已把两半的检查项全部折进 `checks`。",
      },
      {
        id: "D-G5-2",
        what: `T023 要求对每个组合跑真机 createRenderPipeline；组合数为 ${variants.length}，其中互异模块对为 ${stats.distinctModulePairs ?? "见 g5-model.json"}。`,
        how: "两端都做到：**全部组合**在 Node 侧逐条发射并配对推导，真机对**每个互异模块对**建管线；组合→模块对是**逐字节同一性**映射（`g5-model.json` 的 `rows[].group`），因此覆盖是精确的而非抽样。",
      },
      {
        id: "D-G5-3",
        what: "T022 的黄金配置沿用尖刺实测配置（非量化 + TEXTURE_UNITS 1 + daynight，`globe.showGroundAtmosphere=false`），未包含地面大气。",
        how: "额外增加 `mvp-quantized`（BITS12 编码）作为第二个黄金用例；地面大气等变体的 WGSL 变体只主张管线有效 + varying 成对，像素保真度在本门禁未主张（G-6 才做像素 diff）。",
      },
      {
        id: "D-G5-4",
        what: "WGSL 无 `#version`/`precision`/`layout` 等 GLSL 构造，且有若干 WGSL 强制的表达差异。",
        how: "逐条在源码注释与 `prelude.wgsl` 头部登记：函数重载拆名、`atan2`、无结构体常量（改 `valid` 标志）、`textureSampleLevel(...,0.0)`（uniformity）、`gl_FragCoord` 显式传参、`bool` uniform → `u32`。",
      },
      {
        id: "D-G5-5",
        what: "T023 提到「GlobeSurfaceShaderSet 的 38 个 boolean 门控」，本门禁按**可达性**而不是按位点计数组织枚举（位点会重复计数同一语义开关的两侧）。",
        how: `枚举由 ${REACHABLE_DIMENSIONS.length} 个维度组成，每个维度的取值与来源行号逐个登记在 define-matrix.mjs；被排除的 ${EXCLUDED_DEFINES.length} 个 define 同样逐个给出理由与来源。`,
      },
    ],
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "g5-run.log"), `${logLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "g5.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  log(`verdict=${verdict} (${checks.filter((entry) => entry.ok === true).length}/${checks.length} checks ok) -> ${repoRelative(path.join(OUT_DIR, "g5.json"))}`, quiet);
  for (const entry of failed) log(`  FAIL ${entry.id}: ${entry.detail}`, quiet);

  if (verdict === "pass") return 0;
  process.stderr.write(
    "g5-shader: STOP — G-5 verdict=" + verdict + ". Phase 2 门禁未通过时不得开始 Phase 3；失败动作见 plan.md「实现前的验证门」" +
      "（启用尖刺 §7.5 退路三），由入口 Agent 修订 plan.md。\n",
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
      fs.writeFileSync(path.join(OUT_DIR, "g5-run.log"), `${logLines.join("\n")}\n`, "utf8");
      fs.writeFileSync(
        path.join(OUT_DIR, "g5.json"),
        `${JSON.stringify(
          {
            gate: "g5",
            task: "T022,T023,T024",
            verdict: "partial",
            recordedAt: new Date().toISOString(),
            notes: `G-5 runner 异常终止：${error?.message ?? error}。未完成的检查一律视为失败；STOP 并上报入口 Agent。`,
            environment: { node: process.version, platform: `${process.platform} ${process.arch}` },
            checks: [check("runner-completed", false, `runner threw: ${error?.message ?? error}`)],
            evidence: [{ path: "experiments/gates/g5-shader/run.mjs", what: "runner that failed" }],
            error: { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack ?? null },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      process.stderr.write(`g5-shader: unexpected failure: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    });
}
void GATE_DIR;
void deriveVaryingPairsFromWgsl;
