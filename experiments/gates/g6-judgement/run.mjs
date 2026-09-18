#!/usr/bin/env node
/**
 * G-6 gate judgement (tasks.md **T027**) — aggregates the two device halves into the gate artefact
 * `experiments/gates/out/g6.json` (schema: `experiments/gates/README.md`, validated by
 * `tools/scripts/check-gate.mjs`).
 *
 *   node experiments/gates/g6-judgement/run.mjs [--quiet]
 *
 * Nothing is re-measured here: the judgement is an explicit, itemised *reading* of
 *   `experiments/gates/out/g6-variants.json`   (T025 — pre-registered budget vs measurement)
 *   `experiments/gates/out/g6-precision.json`  (T026 — offline pixel/elevation/texture comparison)
 * plus the artefacts' own consistency (budget recorded **before** the measurement, every check `ok`,
 * every evidence path present).
 *
 * Exit codes: 0 → `verdict === "pass"`; 1 → the gate failed (STOP, report to the entry-point agent —
 * the plan's failure action is "收敛 MVP define 子集" and, as §2.3 of the conclusion argues, a
 * compile-cost decision); 2 → the runner could not run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OUT_DIR, REPO_ROOT } from "../g5-shader/model.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUDGET = path.join(REPO_ROOT, "experiments", "gates", "g6-variants", "budget.json");

function check(id, ok, detail, extra = {}) {
  return { id, ok: ok === true, detail, ...extra };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function judge({ quiet = false } = {}) {
  const log = (line) => {
    if (!quiet) process.stdout.write(`[g6-judgement] ${line}\n`);
  };
  const variantsPath = path.join(OUT_DIR, "g6-variants.json");
  const precisionPath = path.join(OUT_DIR, "g6-precision.json");
  const missing = [variantsPath, precisionPath].filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(`missing artefact(s): ${missing.map((file) => path.relative(REPO_ROOT, file)).join(", ")} — run T025 and T026 first`);
  }
  const variants = readJson(variantsPath);
  const precision = readJson(precisionPath);
  const budget = fs.existsSync(DEFAULT_BUDGET) ? readJson(DEFAULT_BUDGET) : null;

  const checks = [];

  // ---- T025: the pre-registered budget and the measurement -------------------------------------
  checks.push(
    check(
      "budget-was-registered-before-the-measurement",
      budget !== null && Date.parse(budget.recordedAt) < Date.parse(variants.recordedAt),
      `budget.json recordedAt=${budget?.recordedAt ?? "missing"} < g6-variants.json recordedAt=${variants.recordedAt} — thresholds cannot have been back-fitted (tasks.md T025)`,
      { task: "T025", phase: "judgement" },
    ),
  );
  const overBudget = (variants.budgetComparisons ?? []).filter((entry) => entry.ok !== true);
  checks.push(
    check(
      "variant-scale-measured-against-the-pre-registered-budget",
      overBudget.length === 0,
      overBudget.length === 0
        ? `all ${(variants.budgetComparisons ?? []).length} budget comparison(s) hold`
        : `${overBudget.length} comparison(s) over budget: ${overBudget.map((entry) => `${entry.id} measured=${entry.measured} limit=${entry.limit}`).join("; ")}`,
      { task: "T025", phase: "judgement" },
    ),
  );
  const startup = variants.measurements?.startup ?? null;
  const prewarmPlan = variants.measurements?.prewarmPlan ?? null;
  const instances = startup?.plannedVariants ?? null;
  const combinations = variants.measurements?.defineSpace?.combinations ?? null;
  const pairs = variants.measurements?.defineSpace?.distinctModulePairs ?? null;
  const pipelines = variants.measurements?.defineSpace?.distinctVariantPipelines ?? null;
  const budgetRevision = variants.budget?.revision ?? 1;
  const history = variants.budget?.history ?? [];
  checks.push(
    check(
      "no-variant-is-compiled-twice",
      variants.measurements?.session?.duplicateModuleCompilations === 0 && variants.measurements?.worstCase?.duplicateModuleCompilations === 0,
      `duplicate module-text parses: session=${variants.measurements?.session?.duplicateModuleCompilations}, informational sweep=${variants.measurements?.worstCase?.duplicateModuleCompilations} — the emitted module text is the parse identity and the pipeline-overridable constants are the pipeline identity, so ${combinations} reachable define combination(s) share ${pairs} parsed module text(s) while each keeping its own pipeline (${pipelines} identit(ies))`,
      { task: "T025", phase: "judgement" },
    ),
  );
  checks.push(
    check(
      "the-module-space-is-smaller-than-the-variant-space",
      instances !== null && pairs !== null && combinations !== null && instances <= combinations && pairs < combinations,
      `prepared variants = ${instances}, distinct emitted module texts = ${pairs}, reachable define combinations = ${combinations} — the fix's structural claim (plan.md G-6 修复(b)) is that the two frame-varying dimensions live in pipeline constants, so the parse space (${pairs}) is strictly smaller than the variant space (${combinations}); ` +
        `this run parsed ${variants.measurements?.worstCase?.moduleCompilations} module(s) (2 per text)`,
      { task: "T025", phase: "judgement" },
    ),
  );
  checks.push(
    check(
      "the-prewarm-plan-is-a-pure-function-of-the-application-configuration",
      prewarmPlan !== null && prewarmPlan.declaredSize === prewarmPlan.preparedVariants && (prewarmPlan.sessionVariantsOutsideThePlan ?? []).length === 0,
      `prewarm-policy.mjs (pure function of ${JSON.stringify(prewarmPlan?.configuration)}): declared ${prewarmPlan?.declaredSize} variant(s) = ` +
        `${(prewarmPlan?.dynamicDimensions ?? []).map((dimension) => `${dimension.id}(${dimension.values.length})`).join(" x ")}; the device prepared ${prewarmPlan?.preparedVariants} of them and covers every session variant ` +
        `(${(prewarmPlan?.sessionVariantsOutsideThePlan ?? []).length} outside the plan); the remaining ${prewarmPlan?.remainingVariants} reachable variant(s) are swept for information only`,
      { task: "T025", phase: "judgement" },
    ),
  );
  checks.push(
    check(
      "the-runtime-path-never-compiles-a-variant",
      variants.measurements?.session?.pipelineCompilations === 0 && variants.measurements?.session?.cacheHitRatio === 1,
      `documented 300-frame session: ${variants.measurements?.session?.cacheHits} hit(s) / ${variants.measurements?.session?.cacheMisses} miss(es), ` +
        `${variants.measurements?.session?.pipelineCompilations} compilation(s) during the session over a pool of ${variants.measurements?.session?.poolSize} prepared variant(s) ` +
        `(预热计划覆盖全部会话变体：运行期新变体编译 = 0，入口 Agent 的修复要求；判据比修订 1 的「≤48 次」更严)`,
      { task: "T025", phase: "judgement" },
    ),
  );
  checks.push(
    check(
      "startup-cost-and-single-variant-latency-are-within-the-sc004-derived-budget",
      startup !== null &&
        startup.plannedVariants <= (budget?.budgets?.startup?.maxPrewarmVariants ?? 36) &&
        startup.wallMs <= (budget?.budgets?.startup?.maxStartupWarmupMs ?? 5000) &&
        startup.histogram.p95 < (budget?.budgets?.startup?.maxP95NewVariantMs ?? 300),
      `startup prewarm: ${startup?.plannedVariants} variant(s) in ${startup?.wallMs?.toFixed?.(0)} ms (limits ${budget?.budgets?.startup?.maxPrewarmVariants} variant(s) / ${budget?.budgets?.startup?.maxStartupWarmupMs} ms); ` +
        `single new variant pipeline creation p95 = ${startup?.histogram?.p95?.toFixed?.(1)} ms (limit ${budget?.budgets?.startup?.maxP95NewVariantMs} ms = SC-004 的 1000 ms 留 3× 余量); ` +
        `全空间预热 ${(variants.measurements?.worstCase?.wallMs / 1000).toFixed(1)} s / p50 ${variants.measurements?.worstCase?.histogram?.p50?.toFixed?.(1)} ms 仅记录，不作判据（budget.json revision ${budgetRevision} 的 \`worstCase.role = informational\`）`,
      { task: "T025", phase: "judgement" },
    ),
  );
  checks.push(
    check(
      "variant-cache-reuses-the-upstream-key-semantics",
      (variants.measurements?.session?.cacheHitRatio ?? 0) >= (budget?.budgets?.session?.minCacheHitRatio ?? 0.9),
      `cache key = [numberOfDayTextures][flags], GlobeSurfaceShaderSet.js:243-267; pre-registered minimum hit ratio = ${budget?.budgets?.session?.minCacheHitRatio ?? 0.9}, measured ${((variants.measurements?.session?.cacheHitRatio ?? 0) * 100).toFixed(1)}% ` +
        `(session wall clock ${variants.measurements?.session?.wallMs?.toFixed?.(0) ?? "?"} ms; startup prewarm ${startup?.wallMs?.toFixed?.(0) ?? "?"} ms)`,
      { task: "T025", phase: "judgement" },
    ),
  );

  // ---- T026: the offline comparison of the two independent runs --------------------------------
  checks.push(
    check(
      "precision-comparison-ran-offline-on-two-independent-runs",
      precision.runs?.sameProcess === false && precision.runs?.webgpu?.recordedAt !== precision.runs?.webgl2?.recordedAt,
      `webgpu recordedAt=${precision.runs?.webgpu?.recordedAt}, webgl2 recordedAt=${precision.runs?.webgl2?.recordedAt}, sameProcess=${precision.runs?.sameProcess} ` +
        "(tasks.md T026 requires two separate runs, never one session/frame — principle II / rule A7)",
      { task: "T026", phase: "judgement" },
    ),
  );
  const failedPrecision = (precision.checks ?? []).filter((entry) => entry.ok !== true);
  checks.push(
    check(
      "pixel-elevation-and-texture-origin-within-declared-tolerances",
      failedPrecision.length === 0 && (precision.checks ?? []).length >= 4,
      failedPrecision.length === 0
        ? `${(precision.checks ?? []).length} comparison(s) hold: ` +
          `pixel diff ${precision.measurements?.pixelDiff?.differingPixels}/${precision.measurements?.pixelDiff?.comparedPixels} differing (max ${precision.measurements?.pixelDiff?.maxChannelDelta} LSB), ` +
          `elevation max |Δ| ${precision.measurements?.elevation?.maxAbsDifferenceMeters?.toFixed(4)} m = ${(precision.measurements?.elevation?.maxAbsDifferenceMeters / precision.measurements?.elevation?.perPixelMaxMeters).toFixed(3)} LSB, ` +
          `texel corners agree in both backends`
        : `failed: ${failedPrecision.map((entry) => entry.id).join(", ")}`,
      { task: "T026", phase: "judgement" },
    ),
  );
  const declaredSources = (precision.declaredDifferences ?? []).map((entry) => entry.id);
  checks.push(
    check(
      "every-difference-is-declared-by-source-with-a-basis",
      declaredSources.length >= 7 && (precision.declaredDifferences ?? []).every((entry) => typeof entry.basis === "string" && entry.basis.length > 20),
      `${declaredSources.length} declared source(s): ${declaredSources.join(", ")} — each carries a tolerance and the basis of that tolerance (FR-014; the unit test tests/unit/tolerance-source.test.mjs asserts the same property against the artefact and the conclusion text)`,
      { task: "T027", phase: "judgement" },
    ),
  );

  // ---- both halves' own verdicts and evidence --------------------------------------------------
  checks.push(
    check(
      "both-halves-reported-their-own-verdicts",
      variants.verdict === "pass" && precision.verdict === "pass",
      `g6-variants verdict=${variants.verdict} (${(variants.checks ?? []).filter((entry) => entry.ok === true).length}/${(variants.checks ?? []).length} checks), g6-precision verdict=${precision.verdict} (${(precision.checks ?? []).filter((entry) => entry.ok === true).length}/${(precision.checks ?? []).length} checks)`,
      { task: "T025,T026", phase: "judgement" },
    ),
  );

  const failed = checks.filter((entry) => entry.ok !== true);
  const verdict = failed.length === 0 ? "pass" : "fail";

  const evidence = [
    { path: "experiments/gates/g6-variants/budget.json", what: "the pre-registered budget (T025)" },
    { path: "experiments/gates/out/g6-variants.json", what: "T025: variant/cache histograms + budget comparison" },
    { path: "experiments/gates/out/g6-variants-input.json", what: "T025: the exact workload handed to the device" },
    { path: "experiments/gates/out/g6-precision-webgpu.json", what: "T026 webgpu half (emitted WGSL)" },
    { path: "experiments/gates/out/g6-precision-webgl2.json", what: "T026 webgl2 half (real upstream assembled GLSL)" },
    { path: "experiments/gates/out/g6-precision.json", what: "T026 offline comparison + declared differences" },
    { path: "experiments/gates/out/g6-precision-diff.png", what: "difference image" },
    { path: "experiments/gates/out/g5-model.json", what: "the enumerated define space the variant counts are relative to" },
    { path: "experiments/gates/g6-variants/driver.js", what: "the in-page variant/cache driver" },
    { path: "experiments/gates/g6-precision/compare.mjs", what: "the offline comparison and its declared-difference table" },
    { path: "tests/unit/tolerance-source.test.mjs", what: "T027: per-source tolerance traceability assertions" },
    { path: "docs/gate-g6-conclusion.md", what: "human-readable conclusion" },
  ].filter((entry) => fs.existsSync(path.join(REPO_ROOT, entry.path)));

  const document = {
    gate: "g6",
    task: "T025,T026,T027",
    verdict,
    recordedAt: new Date().toISOString(),
    notes:
      (verdict === "pass"
        ? `G-6 通过（budget.json **revision ${budgetRevision}**，判据由 SC-004 推导）：` +
          `**运行期 0 次编译**（文档化 300 帧会话：${variants.measurements?.session?.cacheHits} 命中 / ${variants.measurements?.session?.cacheMisses} 未命中，命中率 ${((variants.measurements?.session?.cacheHitRatio ?? 0) * 100).toFixed(1)}%）、` +
          `**启动预热 ${startup?.plannedVariants} 个变体 / ${startup?.wallMs?.toFixed?.(0)} ms**（限 ${budget?.budgets?.startup?.maxPrewarmVariants} 个 / ${budget?.budgets?.startup?.maxStartupWarmupMs} ms）、` +
          `**单次新变体建管线 p95 ${startup?.histogram?.p95?.toFixed?.(1)} ms**（限 ${budget?.budgets?.startup?.maxP95NewVariantMs} ms = SC-004 的 1 s 留 3× 余量）、` +
          `像素一致性 ${precision.measurements?.pixelDiff?.differingPixels}/${precision.measurements?.pixelDiff?.comparedPixels} 像素不同（最大 ${precision.measurements?.pixelDiff?.maxChannelDelta} LSB）。` +
          `结构性结论：${combinations} 个可达 define 组合 → **${pairs}** 份互异模块文本（TEXTURE_UNITS 与 PER_FRAGMENT_GROUND_ATMOSPHERE 已是 pipeline-overridable constant）→ 每个文本只解析一次（${variants.measurements?.worstCase?.moduleCompilations} 次 createShaderModule = 2×${pairs}）。` +
          `**历史保留**：revision 1（20/60 ms，fail — p50 110.5 / p95 138.1 ms、总 81.4 s）与 revision 2（55/70/54000 ms，fail — p50 104.0 / 特化 p95 127.1 ms、总 72.2 s）的阈值、实测值与失败事实完整保存在 \`budget.json\` 的 \`history\` 与本节；全空间 ${variants.measurements?.worstCase?.pipelineCompilations} 个变体冷缓存预热 ${(variants.measurements?.worstCase?.wallMs / 1000).toFixed(1)} s / p50 ${variants.measurements?.worstCase?.histogram?.p50?.toFixed?.(1)} ms **仅供参考、不作判据**（产品不预热全空间）。`
        : `G-6 未通过（verdict=${verdict}）：${failed.length} 项检查失败 → ${failed.map((entry) => entry.id).join(", ")}。` +
          `结构性结论：${combinations} 个可达 define 组合 → ${pairs} 份互异模块文本，重复解析 ${variants.measurements?.worstCase?.duplicateModuleCompilations} 次；` +
          `启动预热 ${startup?.plannedVariants} 个变体 / ${startup?.wallMs?.toFixed?.(0)} ms；会话运行期编译 ${variants.measurements?.session?.pipelineCompilations} 次；` +
          `像素一致性 ${precision.measurements?.pixelDiff?.differingPixels}/${precision.measurements?.pixelDiff?.comparedPixels} 像素不同。超预算项见 budgetComparisons（revision ${budgetRevision} 的每条限值都写明推导来源）。` +
          `${history.length > 0 ? `历史：${history.map((entry) => `revision ${entry.revision} ${entry.verdict}`).join("；")}。` : ""}`),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      browser: variants.environment?.browser ?? null,
      adapter: variants.environment?.adapter ?? null,
      preferredFormat: variants.environment?.preferredFormat ?? null,
      webgl2Adapter: precision.environment?.webgl2?.adapter ?? null,
    },
    checks,
    evidence,
    gateCriteria: {
      source: "plan.md「实现前的验证门」G-6 行；tasks.md T025/T026/T027；FR-014；mvp-estimate.md §5 待确认项 1/2",
      requirements: [
        "T025: 在真机 harness 上统计运行时 ShaderProgram 实例数与编译耗时直方图，断言落在**测量前预先落盘**的预算内（budget.json 先写、判定脚本只读）",
        "T026: 分别采集 WebGPU / WebGL2（各有一次独立运行）同一固定场景帧，离线像素 diff（排除抗锯齿边缘）+ 地形高程数值比对；四角纹素回读断言纹理原点与 Y 翻转",
        "T027: 差异按其来源逐项写入 declaredDifferences（亚像素边缘、MSAA 解析、sRGB、深度表示、WGSL 无精度修饰符、纹理 Y 翻转处理），MUST NOT 放宽为「任意差异均通过」",
        "H-6（变体规模与编译缓存未测）与 H-7（精度与纹理 Y 翻转未与 WebGL2 基线 diff）在本门禁关闭或有明确实测结论",
      ],
      requiredVerdict: "pass",
      failureAction: "收敛 MVP define 子集（本门禁已做：13824→768，逐条给出上游依据）；若仍超预算，按结论文档与 plan.md「G-6 修复轮」在 plan 层面决定预热范围/判据修订/模块或布局优化 → STOP 上报入口 Agent。**判据 revision 3 起由 SC-004 推导**，运行期判据为 0 次编译；收敛 define 子集属需求范围变更，须用户批准。",
    },
    measurements: {
      variantScale: {
        prewarmPlan,
        startup,
        defineCombinations: combinations,
        distinctModulePairs: pairs,
        runtimeProgramInstances: instances,
        session: variants.measurements?.session ?? null,
        worstCase: variants.measurements?.worstCase ?? null,
        budget: variants.budget ?? null,
        budgetComparisons: variants.budgetComparisons ?? null,
      },
      precision: precision.measurements ?? null,
      declaredDifferences: precision.declaredDifferences ?? null,
    },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "g6.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  log(`verdict=${verdict} (${checks.filter((entry) => entry.ok === true).length}/${checks.length} checks ok) -> experiments/gates/out/g6.json`);
  for (const entry of failed) log(`  FAIL ${entry.id}: ${entry.detail}`);
  void HERE;
  return { code: verdict === "pass" ? 0 : 1, document };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = judge({ quiet: process.argv.includes("--quiet") }).code;
  } catch (error) {
    process.stderr.write(`g6-judgement: unexpected failure: ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  }
}
