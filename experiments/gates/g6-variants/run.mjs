#!/usr/bin/env node
/**
 * G-6 gate runner, part 1 — **H-6: 变体规模与编译缓存** (tasks.md T025).
 *
 *   node experiments/gates/g6-variants/run.mjs [--quiet] [--budget <file>] [--model <file>]
 *
 * The budget is **pre-registered**: this runner only *reads* `experiments/gates/g6-variants/budget.json`
 * and refuses to run if the file is missing or was written after the measurement started — the
 * thresholds can never be back-fitted to the numbers (tasks.md T025).
 *
 * Two workloads are measured on the hardware adapter (`page.html` + `driver.js`):
 *   - `session`: a documented 300-frame MVP session driven through upstream's
 *     `[numberOfDayTextures][flags]` cache semantics → runtime `ShaderProgram` instance count,
 *     cache-hit ratio and the compile-time histogram of the misses;
 *   - `worstCase`: cold cache, one pipeline per distinct emitted module pair.
 *
 * Artefacts: `experiments/gates/out/g6-variants.json` (+ `g6-variants-input.json`, `g6-variants-run.log`).
 * Exit codes: 0 → inside budget; 1 → over budget (STOP, the plan's failure action applies);
 * 2 → the runner could not run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { histogram, runGatePage } from "../shared/page-runner.mjs";
import { GATE_DIR as G5_DIR, OUT_DIR, REPO_ROOT } from "../g5-shader/model.mjs";
import { enumerateReachableVariants } from "../g5-shader/define-matrix.mjs";
import { overrideKey, overrideValuesForVariant } from "../g5-shader/wgsl-emitter.mjs";
import { DEFAULT_APP_CONFIGURATION, PREWARM_DYNAMIC_DIMENSIONS, PREWARM_PLAN_SIZE, prewarmPlan } from "./prewarm-policy.mjs";
import { selectVariant } from "../../../tools/shader-verify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "page.html");
const DEFAULT_BUDGET = path.join(HERE, "budget.json");

const logLines = [];
function log(line, quiet) {
  const text = `[g6-variants] ${line}`;
  logLines.push(text);
  if (!quiet) process.stdout.write(`${text}\n`);
}

/**
 * The documented MVP session: tile streams change the imagery layer count, the camera changes the
 * ground-atmosphere mode and fog, and terrain normals availability changes the lighting define. Each
 * phase requests one variant per frame through the upstream cache key.
 *
 * **Revision 3**: the session is a session of **one application configuration** — the
 * construction-fixed dimensions (quantization, imagery adjustments, geodetic normals/exaggeration)
 * stay constant, because the product recomputes its prewarm plan when they change (see
 * `prewarm-policy.mjs`). That is what makes the runtime compile count zero measurable rather than
 * aspirational. The full define matrix is still swept by G-5 (768 pipelines), so no coverage is lost.
 */
export const SESSION_PLAN = [
  { frames: 60, why: "initial tiles: 1 imagery layer, day/night shading, ground atmosphere per-vertex, no fog", selection: { textureUnits: 1, quantization: "QUANTIZATION_BITS12", lighting: "daynight", groundAtmosphere: "per-vertex", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 40, why: "a second imagery layer streams in", selection: { textureUnits: 2, quantization: "QUANTIZATION_BITS12", lighting: "daynight", groundAtmosphere: "per-vertex", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 40, why: "a third imagery layer streams in", selection: { textureUnits: 3, quantization: "QUANTIZATION_BITS12", lighting: "daynight", groundAtmosphere: "per-vertex", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 30, why: "camera moves far away → per-fragment ground atmosphere", selection: { textureUnits: 3, quantization: "QUANTIZATION_BITS12", lighting: "daynight", groundAtmosphere: "per-fragment", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 30, why: "fog switches on (scene.fog.enabled)", selection: { textureUnits: 3, quantization: "QUANTIZATION_BITS12", lighting: "daynight", groundAtmosphere: "per-fragment", fog: "FOG", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 30, why: "fog off, ground atmosphere back to per-vertex", selection: { textureUnits: 3, quantization: "QUANTIZATION_BITS12", lighting: "daynight", groundAtmosphere: "per-vertex", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 30, why: "terrain with vertex normals → ENABLE_VERTEX_LIGHTING", selection: { textureUnits: 3, quantization: "QUANTIZATION_BITS12", lighting: "vertex", groundAtmosphere: "per-vertex", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 40, why: "a layer is removed again while vertex lighting stays active", selection: { textureUnits: 2, quantization: "QUANTIZATION_BITS12", lighting: "vertex", groundAtmosphere: "per-vertex", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
];

function check(id, ok, detail, extra = {}) {
  return { id, ok: ok === true, detail, ...extra };
}

/** One budget comparison row. */
function budgetCheck(id, value, limit, comparison, detail) {
  const ok = comparison === "max" ? value <= limit : value >= limit;
  return { id, ok, detail, measured: value, limit, comparison };
}

async function main() {
  const argv = process.argv.slice(2);
  const quiet = argv.includes("--quiet");
  let budgetPath = DEFAULT_BUDGET;
  let modelPath = path.join(OUT_DIR, "g5-model.json");
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(0, eq) : token;
    const value = eq >= 0 ? token.slice(eq + 1) : argv[index + 1];
    if (key === "--budget") budgetPath = path.resolve(value);
    else if (key === "--model") modelPath = path.resolve(value);
  }

  const startedAt = new Date().toISOString();
  log(`start ${startedAt} (node ${process.version})`, quiet);

  // ---- the pre-registered budget ---------------------------------------------------------------
  if (!fs.existsSync(budgetPath)) {
    throw new Error(`the budget MUST be pre-registered at ${path.relative(REPO_ROOT, budgetPath)} before any measurement (tasks.md T025)`);
  }
  const budget = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
  const budgetRecordedAt = Date.parse(budget.recordedAt);
  if (!Number.isFinite(budgetRecordedAt)) throw new Error("budget.json has no parseable recordedAt");
  if (budgetRecordedAt > Date.parse(startedAt)) throw new Error(`budget.json was written after this run started (${budget.recordedAt} > ${startedAt}) — thresholds MUST NOT be back-fitted`);
  log(`budget ${path.relative(REPO_ROOT, budgetPath)} recordedAt=${budget.recordedAt} (before this run)`, quiet);

  if (!fs.existsSync(modelPath)) {
    throw new Error(`missing ${path.relative(REPO_ROOT, modelPath)} — run \`node tools/shader-verify.mjs --family=globe --variants=all-reachable\` first (it publishes the emitted module pairs)`);
  }
  const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  const rowById = new Map((model.rows ?? []).filter((row) => row.rejected !== true).map((row) => [row.id, row]));
  if (rowById.size === 0) throw new Error("g6: the G-5 model carries no per-variant rows — re-run `node tools/shader-verify.mjs --family=globe --variants=all-reachable`");
  log(`model: ${model.stats.defineCombinations} define combination(s), ${model.stats.distinctModulePairs} distinct module text(s), ${model.stats.distinctVariantPipelines} variant pipeline identit(ies)`, quiet);

  /**
   * The variant identity the runtime caches on: the emitted module text **plus** the pipeline's
   * overridable-constant values (G-6/T025). `numberOfDayTextures` and `perFragmentGroundAtmosphere` are
   * pipeline constants, so two define sets that share a module text are still two variants — and a
   * variant is one `createRenderPipeline` over an already-parsed module.
   */
  const variantOf = (variant) => {
    const row = rowById.get(variant.id);
    if (row === undefined) throw new Error(`g6: variant ${variant.id} has no emitted module text (was it rejected?)`);
    const overrides = row.overrides ?? overrideValuesForVariant(variant);
    return { id: variant.id, key: row.group, overrides, pipeline: row.pipeline ?? `${row.group}#${overrideKey(overrides)}` };
  };
  const variants = enumerateReachableVariants().map(variantOf);

  // ---- the prewarm plan (the product's default variant preparation, budget.json revision 3) -----
  const plan = prewarmPlan(DEFAULT_APP_CONFIGURATION);
  const prewarmVariants = plan.planned.map(variantOf);
  const remainingVariants = plan.remaining.map(variantOf);
  const plannedPipelines = new Set(prewarmVariants.map((variant) => variant.pipeline));

  // ---- the session workload ---------------------------------------------------------------------
  const sessionRequests = [];
  for (const phase of SESSION_PLAN) {
    const variant = variantOf(selectVariant(phase.selection));
    for (let frame = 0; frame < phase.frames; frame += 1) sessionRequests.push({ frame, phase: phase.why, variant: variant.id, key: variant.key, overrides: variant.overrides, pipeline: variant.pipeline });
  }
  const sessionVariantsOutsideThePlan = [...new Set(sessionRequests.map((request) => request.pipeline))].filter((pipeline) => !plannedPipelines.has(pipeline));

  const chunkFiles = fs.readdirSync(path.join(OUT_DIR, "g5-modules")).filter((name) => /^chunk-\d+\.json$/.test(name)).sort();
  const input = {
    chunks: chunkFiles.map((name) => `/${path.relative(REPO_ROOT, path.join(OUT_DIR, "g5-modules", name)).split(path.sep).join("/")}`),
    sessionRequests,
    variants,
    prewarmVariants,
    remainingVariants,
    prewarmPlan: {
      id: "g6-reachable-subset-prewarm",
      configuration: DEFAULT_APP_CONFIGURATION,
      dynamicDimensions: PREWARM_DYNAMIC_DIMENSIONS.map((dimension) => ({ id: dimension.id, values: dimension.values, why: dimension.why })),
      declaredSize: PREWARM_PLAN_SIZE,
    },
    layout: { structName: model.layout.structName, structSize: model.layout.structSize, samplers: model.layout.samplers, members: model.layout.members },
  };
  log(
    `session: ${sessionRequests.length} frame(s) over ${new Set(sessionRequests.map((request) => request.pipeline)).size} distinct variant(s) ` +
      `(outside the prewarm plan: ${sessionVariantsOutsideThePlan.length}); startup prewarm: ${prewarmVariants.length} planned variant(s) over ${new Set(prewarmVariants.map((variant) => variant.key)).size} module text(s); ` +
      `informational: the remaining ${remainingVariants.length} variant(s)`,
    quiet,
  );

  const run = await runGatePage({
    page: PAGE,
    globalName: "__g6",
    input,
    inputFile: path.join(OUT_DIR, "g6-variants-input.json"),
    quiet,
  });
  const collected = run.collected;
  if (collected === null) throw new Error(`the device page produced no report: ${run.runtimeError ?? "unknown reason"}`);

  const session = collected.session ?? { shaderProgramInstances: -1, cacheHitRatio: -1, histogram: histogram([]), syncHistogram: histogram([]), pipelineCompilations: -1, duplicateModuleCompilations: -1, cacheHits: -1, cacheMisses: -1, wallMs: -1 };
  const startup = collected.startup ?? { plannedVariants: -1, pipelineCompilations: -1, histogram: histogram([]), syncHistogram: histogram([]), distinctModuleTexts: -1, moduleCompilations: -1, failures: -1, wallMs: -1 };
  const worstCase = collected.worstCase ?? { role: "informational", pipelineCompilations: -1, duplicateModuleCompilations: -1, distinctModuleTexts: -1, moduleCompilations: -1, histogram: histogram([]), syncHistogram: histogram([]), autoLayoutSampleHistogram: histogram([]), failures: -1, wallMs: -1 };
  if (collected.session === null || collected.session === undefined) {
    throw new Error(`the device page produced no session report: ${JSON.stringify(collected.errors?.slice(0, 3))}`);
  }
  if (collected.startup === null || collected.startup === undefined) {
    throw new Error(`the device page produced no startup (prewarm) report: ${JSON.stringify(collected.errors?.slice(0, 3))}`);
  }

  // ---- budget comparison ------------------------------------------------------------------------
  const comparisons = [
    // --- runtime: the documented session over the prepared pool (product path) ---------------------
    budgetCheck("session-shader-program-instances", session.shaderProgramInstances, budget.budgets.session.maxShaderProgramInstances, "max", `${session.shaderProgramInstances} runtime program instance(s) touched by a ${sessionRequests.length}-frame session`),
    budgetCheck("session-pipeline-compilations", session.pipelineCompilations, budget.budgets.session.maxPipelineCompilations, "max", `${session.pipelineCompilations} pipeline compilation(s) during the session — the prewarm plan covers every session variant (${sessionVariantsOutsideThePlan.length} outside the plan), so the runtime path MUST NOT compile`),
    budgetCheck("session-duplicate-module-compilations", session.duplicateModuleCompilations, budget.budgets.session.maxDuplicateModuleCompilations, "max", `${session.duplicateModuleCompilations} identical module text(s) parsed twice anywhere in this run (MUST be 0: the emitted text is the parse identity)`),
    budgetCheck("session-cache-hit-ratio", Number(session.cacheHitRatio.toFixed(4)), budget.budgets.session.minCacheHitRatio, "min", `${(session.cacheHitRatio * 100).toFixed(1)}% of the ${sessionRequests.length} requests were served from the prepared pool`),
    budgetCheck("session-p50-compile-ms", Number(session.histogram.p50.toFixed(3)), budget.budgets.session.maxP50CompileMs, "max", `p50 ${session.histogram.p50.toFixed(2)} ms over ${session.histogram.count} runtime compilation(s) — the limit is unchanged from revision 1 and the sample set is empty by design (0 compilations): the per-variant cost is judged by the startup criteria, where it is actually paid`),
    budgetCheck("session-p95-compile-ms", Number(session.histogram.p95.toFixed(3)), budget.budgets.session.maxP95CompileMs, "max", `p95 ${session.histogram.p95.toFixed(2)} ms over ${session.histogram.count} runtime compilation(s)`),
    budgetCheck("session-total-compile-ms", Number(session.histogram.totalMs.toFixed(3)), budget.budgets.session.maxTotalCompileMs, "max", `total runtime compile time ${session.histogram.totalMs.toFixed(1)} ms`),
    // --- startup: the prewarm plan, cold, before the first frame (product path) ---------------------
    budgetCheck("startup-prewarm-variants", startup.plannedVariants, budget.budgets.startup.maxPrewarmVariants, "max", `${startup.plannedVariants} planned variant(s) prepared before the first frame (analytic upper bound from prewarm-policy.mjs: ${PREWARM_PLAN_SIZE})`),
    budgetCheck("startup-warmup-ms", Number(startup.wallMs.toFixed(3)), budget.budgets.startup.maxStartupWarmupMs, "max", `startup prewarm wall clock ${startup.wallMs.toFixed(0)} ms for ${startup.plannedVariants} variant(s) (~${(startup.wallMs / Math.max(1, startup.plannedVariants)).toFixed(0)} ms each); a loading cost, not an interaction stall (SC-004 bounds the latter)`)    ,
    budgetCheck("startup-p95-new-variant-ms", Number(startup.histogram.p95.toFixed(3)), budget.budgets.startup.maxP95NewVariantMs, "max", `p95 ${startup.histogram.p95.toFixed(2)} ms for one new variant's pipeline creation (p50 ${startup.histogram.p50.toFixed(2)} ms, max ${startup.histogram.max.toFixed(2)} ms) — SC-004 (no interaction stall > 1000 ms) leaves a 3x margin`),
    // --- structural (budgeted: they must hold, they are not measurements of cost) ------------------
    budgetCheck("worst-case-duplicate-module-compilations", worstCase.duplicateModuleCompilations, budget.budgets.worstCase.maxDuplicateModuleCompilations, "max", `${worstCase.duplicateModuleCompilations} identical module text(s) parsed twice`),
    budgetCheck("worst-case-distinct-module-texts", worstCase.distinctModuleTexts, budget.budgets.worstCase.maxDistinctModuleTexts, "max", `${worstCase.distinctModuleTexts} distinct emitted module text(s) for ${variants.length} variant identit(ies) — the 768→128 reduction is the fix's structural claim (analytic bound in budget.json)`),
    budgetCheck("worst-case-module-compilations", worstCase.moduleCompilations, budget.budgets.worstCase.maxModuleCompilations, "max", `${worstCase.moduleCompilations} createShaderModule call(s) = 2 per distinct text (vertex + fragment); a module text MUST be parsed at most once`),
  ];

  const overBudget = comparisons.filter((entry) => entry.ok !== true);
  const verdict = overBudget.length === 0 && collected.errors.length === 0 ? "pass" : "fail";

  const checks = [
    check("budget-pre-registered-before-measurement", budgetRecordedAt < Date.parse(startedAt), `budget.json revision ${budget.revision ?? 1} recordedAt=${budget.recordedAt} < run start ${startedAt}; the runner only reads it (no write path exists)`),
    check("device-is-a-hardware-adapter", collected.adapter?.hasInfo === true, `adapter.info=${JSON.stringify(collected.adapter)}, preferredFormat=${collected.preferredFormat}, wgslLanguageFeatures=${JSON.stringify(collected.wgslLanguageFeatures ?? null)}`),
    check("device-reported-no-errors", collected.errors.length === 0, `${collected.errors.length} device/page error(s): ${JSON.stringify(collected.errors.slice(0, 3))}`),
    check("variant-scale-within-pre-registered-budget", overBudget.length === 0, overBudget.length === 0 ? `all ${comparisons.length} budget comparison(s) hold` : `${overBudget.length} over budget: ${overBudget.map((entry) => `${entry.id}(${entry.measured} vs ${entry.limit})`).join(", ")}`),
    check(
      "cache-is-keyed-by-the-emitted-module-text-and-its-constant-values",
      session.duplicateModuleCompilations === 0 && worstCase.duplicateModuleCompilations === 0,
      `identical emitted module texts parsed twice: session=${session.duplicateModuleCompilations}, informational sweep=${worstCase.duplicateModuleCompilations} — the emitted text is the parse identity, so define sets that differ only in a pipeline-overridable constant share one parsed module ` +
        `(${worstCase.distinctModuleTexts} text(s) for ${variants.length} variant identit(ies)); ${worstCase.moduleCompilations} createShaderModule call(s) = 2 per text`,
    ),
    check(
      "compile-cost-histogram-recorded-for-every-phase",
      startup.histogram.count === startup.pipelineCompilations &&
        session.histogram.count === session.pipelineCompilations &&
        worstCase.histogram.count === worstCase.pipelineCompilations &&
        startup.syncHistogram !== undefined &&
        session.syncHistogram !== undefined,
      `startup prewarm: ${startup.histogram.count} planned variant(s), p50=${startup.histogram.p50.toFixed(2)} ms p95=${startup.histogram.p95.toFixed(2)} ms max=${startup.histogram.max.toFixed(2)} ms ` +
        `(synchronous part only: p50=${startup.syncHistogram.p50.toFixed(3)} ms); session: ${session.histogram.count} runtime compilation(s) ` +
        `(synchronous part only: p50=${session.syncHistogram.p50.toFixed(3)} ms); informational full-space sweep: ${worstCase.histogram.count} variant(s), p50=${worstCase.histogram.p50.toFixed(2)} ms ` +
        `(recorded for comparison against later layout work, not judged). The budget judges the **total** per-variant cost (including the validation round trip), since that is what one more variant actually costs`,
    ),
    check(
      "session-runs-entirely-from-the-prepared-pool",
      session.cacheHitRatio >= budget.budgets.session.minCacheHitRatio && Number.isFinite(session.cacheHitRatio) && session.pipelineCompilations === 0 && sessionVariantsOutsideThePlan.length === 0,
      `cache key = [numberOfDayTextures][flags] (GlobeSurfaceShaderSet.js:243-267): ${session.cacheHits} hit(s) / ${session.cacheMisses} miss(es) = ${(session.cacheHitRatio * 100).toFixed(1)}% over ${sessionRequests.length} frame(s), ` +
        `${session.pipelineCompilations} compilation(s); the prewarm plan holds ${startup.plannedVariants} prepared variant(s) before the first frame and covers every session variant (${sessionVariantsOutsideThePlan.length} outside it)`,
    ),
    check(
      "the-prewarm-plan-is-the-policy-function-and-within-the-registered-bound",
      startup.plannedVariants === PREWARM_PLAN_SIZE && plan.size === PREWARM_PLAN_SIZE && remainingVariants.length === variants.length - plan.size,
      `prewarm-policy.mjs (pure function of the application configuration ${JSON.stringify(DEFAULT_APP_CONFIGURATION)}) yields ${plan.size} variant(s) = ` +
        `${PREWARM_DYNAMIC_DIMENSIONS.map((dimension) => `${dimension.id}(${dimension.values.length})`).join(" x ")}; the device prepared ${startup.plannedVariants} of them ` +
        `(registered bound ${budget.budgets.startup.maxPrewarmVariants}); the informational sweep covers the remaining ${remainingVariants.length}`,
    ),
  ];

  const failed = checks.filter((entry) => entry.ok !== true);
  const finalVerdict = failed.length === 0 ? "pass" : "fail";

  const document = {
    gate: "g6-variants",
    task: "T025",
    verdict: finalVerdict,
    recordedAt: new Date().toISOString(),
    notes:
      `H-6 关闭情况见 verdict。测量口径（budget.json revision ${budget.revision ?? 1}）：**运行期** = 一次文档化 MVP 应用配置下的 300 帧会话（构造期固定 BITS12 + 大地法线/夸张 + alpha<1 影像；运行中只有动态维度变化：影像层数 1→2→3→2、地面大气 per-vertex/per-fragment、雾开关、光照 daynight/vertex），在**预热池已就绪**之后开始，按上游 ` +
      "`[numberOfDayTextures][flags]` 缓存键查表（运行期 MUST 0 次编译）；**启动期** = 按 `prewarm-policy.mjs` 的纯函数计划（36 个变体身份）冷缓存预热；" +
      `**仅供参考**：计划之外的其余 ${remainingVariants.length} 个变体各建一次管线（产品不预热全空间，该段不参与 verdict，仅用于与后续布局优化比较）。` +
      `设计要点：**发射产物文本 = 解析身份，constant 取值 = 管线身份**——768 个 define 组合只发射出 ${model.stats.distinctModulePairs} 份互异模块文本（TEXTURE_UNITS 与 PER_FRAGMENT_GROUND_ATMOSPHERE 已移出模块文本），因此每个文本只解析一次（重复解析数 MUST 为 0）。` +
      `预算在测量前写入 budget.json（recordedAt=${budget.recordedAt}），判定脚本只读不写。`,
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      browser: { channel: process.env.GATE_BROWSER_CHANNEL ?? "chrome", version: run.browserVersion, headless: true, launchArgs: [] },
      adapter: collected.adapter ?? null,
      preferredFormat: collected.preferredFormat ?? null,
      wgslLanguageFeatures: collected.wgslLanguageFeatures ?? null,
    },
    budget: { path: path.relative(REPO_ROOT, budgetPath).split(path.sep).join("/"), revision: budget.revision ?? 1, recordedAt: budget.recordedAt, supersedes: budget.supersedes ?? null, history: budget.history ?? null, source: budget.source, budgets: budget.budgets },
    checks,
    budgetComparisons: comparisons,
    evidence: [
      { path: "experiments/gates/g6-variants/budget.json", what: "the pre-registered budget revision 3 (written before any G-6 measurement; carries the full history of revisions 1-2 including the first-round fail and why those thresholds were invalid)" },
      { path: "experiments/gates/out/g6-variants.json", what: "this artefact: per-phase histograms + budget comparison" },
      { path: "experiments/gates/out/g6-variants-input.json", what: "the exact workload handed to the device page (frame-by-frame session requests, the prewarm plan and the informational remainder)" },
      { path: "experiments/gates/g6-variants/prewarm-policy.mjs", what: "the prewarm plan as a pure function of the application configuration (dynamic dimensions x construction-fixed dimensions = 36)" },
      { path: "experiments/gates/out/g6-override-probe.json", what: "the device control experiment that selected the fix route (platform floor, cached-module specialisation vs new module text)" },
      { path: "experiments/gates/out/g5-model.json", what: "the enumerated define space, the distinct emitted module texts and the per-variant constant values the workload is derived from" },
      { path: "experiments/gates/g6-variants/driver.js", what: "the in-page startup/session/informational driver" },
    ].filter((entry) => fs.existsSync(path.join(REPO_ROOT, entry.path))),
    measurements: {
      defineSpace: { combinations: model.stats.defineCombinations, distinctModulePairs: model.stats.distinctModulePairs, distinctVariantPipelines: model.stats.distinctVariantPipelines, uniformMembers: model.stats.uniformMembers, samplerBindings: model.stats.samplerBindings, structSize: model.stats.structSize, dimensionEffect: model.stats.dimensionEffect ?? null },
      prewarmPlan: { id: input.prewarmPlan.id, configuration: input.prewarmPlan.configuration, dynamicDimensions: input.prewarmPlan.dynamicDimensions, declaredSize: PREWARM_PLAN_SIZE, preparedVariants: startup.plannedVariants, remainingVariants: remainingVariants.length, sessionVariantsOutsideThePlan },
      startup,
      session: { ...session, plan: SESSION_PLAN },
      worstCase,
      histogramBucketsMs: { startup: startup.histogram.buckets, session: session.histogram.buckets, worstCase: worstCase.histogram.buckets },
    },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "g6-variants-run.log"), `${logLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "g6-variants.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(HERE, "last-device-report.json"), `${JSON.stringify(collected, null, 2)}\n`, "utf8");
  log(`verdict=${finalVerdict} (${checks.filter((entry) => entry.ok === true).length}/${checks.length} checks ok) -> experiments/gates/out/g6-variants.json`, quiet);
  for (const entry of failed) log(`  FAIL ${entry.id}: ${entry.detail}`, quiet);
  for (const entry of overBudget) log(`  OVER BUDGET ${entry.id}: measured=${entry.measured} limit=${entry.limit}`, quiet);
  void G5_DIR;

  if (finalVerdict === "pass") return 0;
  process.stderr.write(
    "g6-variants: STOP — 变体规模/编译缓存超出**预先登记**的预算。按 plan 的失败动作：收敛 MVP define 子集（只保留地形路径实际可达组合）→ 上报入口 Agent 修订 plan.md。\n",
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
      fs.writeFileSync(path.join(OUT_DIR, "g6-variants-run.log"), `${logLines.join("\n")}\n`, "utf8");
      fs.writeFileSync(
        path.join(OUT_DIR, "g6-variants.json"),
        `${JSON.stringify({ gate: "g6-variants", task: "T025", verdict: "fail", recordedAt: new Date().toISOString(), notes: `G-6 变体规模 runner 异常终止：${error?.message ?? error}`, checks: [{ id: "runner-completed", ok: false, detail: String(error?.message ?? error) }], evidence: [{ path: "experiments/gates/g6-variants/run.mjs", what: "runner that failed" }] }, null, 2)}\n`,
        "utf8",
      );
      process.stderr.write(`g6-variants: unexpected failure: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    });
}
