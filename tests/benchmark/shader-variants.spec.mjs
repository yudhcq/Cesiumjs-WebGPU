/**
 * T079 — **SH-6 variant scale & compile-cost gate** (`层=基准`, tasks.md T079; H-6;
 * `contracts/verification-and-benchmark.md` §4 gate SH-6 and §2 the two independent runs).
 *
 * Run (**one backend per run** — the runner injects `RENDER_BACKEND`; the two commands are serial):
 *   node tests/support/backend-runner.mjs --backend=webgpu --suite=bench:shader-variants
 *   node tests/support/backend-runner.mjs --backend=webgl2 --suite=bench:shader-variants
 *
 * What this suite proves (the registered criteria are `budget.json` revision 3, derived from
 * `spec.md` FR-002 / SC-004, with revisions 1-2 kept in that file's `history` as fail records):
 *   1. **runtime compilations = 0** — a documented 300-frame session over the prewarm pool compiles
 *      nothing, counted twice (phase bookkeeping *and* the wrapped `createRenderPipeline` delta);
 *   2. **single new variant pipeline p95 < 300 ms** — measured cold on a real hardware adapter, with
 *      the page's raw samples reduced by `variantHistogram` (nearest rank) from `variant-budget.ts`;
 *   3. **startup prewarm ≤ 5 s**, recording the variant count (which MUST equal the analytically
 *      derived plan size, 36) and the elapsed time;
 *   4. structural: the emitted module text is the parse identity — `createShaderModule` calls
 *      = 2 × distinct module texts, repeated parses = 0;
 *   5. the **768-variant full-space prewarm is reference only** (`criterion: false`): its numbers are
 *      recorded and never judged.
 *
 * The measurement itself runs in `tests/benchmark/page/shader-variants.html`, which renders nothing
 * and reads nothing back: SH-6 is a gate on compile **counts and cost**, not on pixels (pixels are
 * SH-2/SH-5's business). The Node side builds the module corpus with the **production** emitter
 * (`tools/shader-model.mjs` → `packages/cesium-webgpu/backend-webgpu/webgpu/**`), writes the input the
 * page fetches, and judges the collected numbers.
 *
 * Two independent runs (contract §2): the WebGPU run measures; the WebGL2 run executes the same suite
 * file and asserts the **isolation criterion** — in that run the WebGPU path created 0 GPU objects and
 * never touched a device — and exits 0. Nothing here compares the two backends in one session.
 *
 * Artefacts: `artifacts/shader-variants.json` (the WebGPU measurement; thresholds + fingerprint +
 * verdict), `artifacts/shader-variants-webgl2.json` (the WebGL2 isolation record),
 * `artifacts/shader-variants/{input.json,variant-budget.js,terrain-variants.js}` (the run's own
 * measurement input: the module corpus the page parses, plus the transpiled tolerance module the page
 * imports — the same source the Node side judges with, so the two evaluations cannot drift).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";
import { test } from "playwright/test";
import ts from "typescript";

import { createStaticServer } from "../../tools/scripts/serve.mjs";
import { assembleGlslForVariant, automaticUniformNames, baseSources, enumerateMarginals, loadProduction, unionOfVariants } from "../../tools/shader-model.mjs";
import { activeBackend } from "../support/contract-harness.mjs";
import { REPO_ROOT, repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";

// One run builds the corpus, launches Chrome and drives the whole variant space on the device; the
// cold informational sweep alone is ~1.5 minutes on the gate device, so the budget is stated here.
test.setTimeout(900_000);

const SUITE = "bench:shader-variants";
const PAGE_RELATIVE = "tests/benchmark/page/shader-variants.html";
const PAGE = repoPath(PAGE_RELATIVE);
const ARTIFACT_RELATIVE = "artifacts/shader-variants.json";
const ISOLATION_ARTIFACT_RELATIVE = "artifacts/shader-variants-webgl2.json";
const SUPPORT_DIR_RELATIVE = "artifacts/shader-variants";
const INPUT_RELATIVE = `${SUPPORT_DIR_RELATIVE}/input.json`;
const BUDGET_RELATIVE = "experiments/gates/g6-variants/budget.json";
const VARIANT_BUDGET_TS = "packages/cesium-webgpu/backend-webgpu/webgpu/variant-budget.ts";
const TERRAIN_VARIANTS_TS = "packages/cesium-webgpu/backend-webgpu/webgpu/terrain-variants.ts";

/** The registered threshold values this suite MUST still be judged by (budget.json revision 3). */
const EXPECTED_PLAN_SIZE = 36;
const EXPECTED_REACHABLE_VARIANTS = 768;

/**
 * The documented MVP session (the gate's `SESSION_PLAN`, `experiments/gates/g6-variants/run.mjs`): a
 * session of **one application configuration** — the construction-fixed dimensions (quantization,
 * imagery adjustments, geodetic normals/exaggeration) stay constant, because the product recomputes its
 * prewarm plan when they change. Only the dynamic dimensions move: imagery layer count 1→2→3→2, the
 * ground-atmosphere mode (recomputed from the camera distance every frame), fog, and whether the tile
 * carries vertex normals.
 */
const SESSION_PLAN = [
  { frames: 60, why: "initial tiles: 1 imagery layer, day/night shading, ground atmosphere per-vertex, no fog", selection: { textureUnits: "1", quantization: "QUANTIZATION_BITS12", lighting: "daynight", groundAtmosphere: "per-vertex", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 40, why: "a second imagery layer streams in", selection: { textureUnits: "2", quantization: "QUANTIZATION_BITS12", lighting: "daynight", groundAtmosphere: "per-vertex", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 40, why: "a third imagery layer streams in", selection: { textureUnits: "3", quantization: "QUANTIZATION_BITS12", lighting: "daynight", groundAtmosphere: "per-vertex", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 30, why: "camera moves far away → per-fragment ground atmosphere", selection: { textureUnits: "3", quantization: "QUANTIZATION_BITS12", lighting: "daynight", groundAtmosphere: "per-fragment", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 30, why: "fog switches on (scene.fog.enabled)", selection: { textureUnits: "3", quantization: "QUANTIZATION_BITS12", lighting: "daynight", groundAtmosphere: "per-fragment", fog: "FOG", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 30, why: "fog off, ground atmosphere back to per-vertex", selection: { textureUnits: "3", quantization: "QUANTIZATION_BITS12", lighting: "daynight", groundAtmosphere: "per-vertex", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 30, why: "terrain with vertex normals → ENABLE_VERTEX_LIGHTING", selection: { textureUnits: "3", quantization: "QUANTIZATION_BITS12", lighting: "vertex", groundAtmosphere: "per-vertex", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
  { frames: 40, why: "a layer is removed again while vertex lighting stays active", selection: { textureUnits: "2", quantization: "QUANTIZATION_BITS12", lighting: "vertex", groundAtmosphere: "per-vertex", fog: "none", ocean: "none", imageryOps: "alpha", tileLimitRectangle: "none", geodetic: "both" } },
];

const repoRelative = (absolute) => path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
const shortHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function writeJson(absolute, payload) {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** The pre-registered budget file. This suite only ever **reads** it (no write path exists here). */
function readBudget() {
  const file = repoPath(BUDGET_RELATIVE);
  assert.ok(fs.existsSync(file), `the budget MUST be pre-registered at ${BUDGET_RELATIVE} before any measurement (tasks.md T025/T079)`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The production tolerance module (device-free, `node:`-free — the page imports the same source). */
async function loadVariantBudget() {
  return await loadTypeScriptModule(repoPath(VARIANT_BUDGET_TS));
}

/**
 * Transpile the two modules the page imports into the run's support directory.
 *
 * `variant-budget.ts` is device-free **and** `node:`-free precisely so the page can import it; the
 * relative `.js` specifier it uses (`./terrain-variants.js`) resolves unchanged because both files are
 * emitted side by side. The emitted module is imported back here so a broken transpile fails loudly
 * instead of leaving the page with a silently missing judge.
 */
function transpileForPage(relativeSource, outFileName) {
  const source = fs.readFileSync(repoPath(relativeSource), "utf8");
  const output = ts.transpileModule(source, {
    fileName: relativeSource,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true },
  }).outputText;
  const outFile = repoPath(`${SUPPORT_DIR_RELATIVE}/${outFileName}`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, output, "utf8");
  return outFile;
}

/**
 * Build the whole variant corpus with the **production** emitter: every reachable define combination,
 * grouped by the byte identity of its emitted module pair (the parse identity), with the
 * pipeline-overridable constant values that make each variant a distinct pipeline.
 */
async function buildCorpus() {
  const production = await loadProduction();
  const base = await baseSources();
  const automaticUniforms = await automaticUniformNames();
  const variants = production.variants.enumerateReachableVariants();
  const layoutInputs = await unionOfVariants({ variants: enumerateMarginals(variants), production, base, automaticUniforms });
  const layout = production.bindLayout.layoutUniforms(layoutInputs, { structName: "TerrainUniforms" });

  const groups = new Map();
  const rows = [];
  const rejected = [];

  /** `WgslEmission.emit` with the per-vertex witness for the `PER_FRAGMENT_GROUND_ATMOSPHERE` override. */
  const emit = (variant) => {
    const glsl = assembleGlslForVariant(variant, { ShaderSourceClass: production.ShaderSource, base, fragments: production.fragments, destinationOf: production.variants.destinationOf });
    const witness = production.variants.perVertexWitnessVariant(variant);
    const derivation = witness === null ? glsl : assembleGlslForVariant(witness, { ShaderSourceClass: production.ShaderSource, base, fragments: production.fragments, destinationOf: production.variants.destinationOf });
    return production.emitter.emitTerrainWgsl({
      variantKey: variant.id,
      vertexGlsl: glsl.vertexSource,
      fragmentGlsl: glsl.fragmentSource,
      defines: variant.defines,
      textureUnits: production.fragments.textureUnitsFromDefines(variant.defines),
      flags: production.fragments.applyFlagsFromDefines(variant.defines),
      layout,
      sceneMode: variant.sceneMode,
      ...(witness === null ? {} : { witness: { vertexGlsl: derivation.vertexSource, fragmentGlsl: derivation.fragmentSource, defines: witness.defines } }),
    });
  };

  for (const variant of variants) {
    const emission = emit(variant);
    if (!emission.ok) {
      rejected.push({ id: variant.id, diagnostics: emission.diagnostics.map((diagnostic) => diagnostic.message) });
      continue;
    }
    const key = `${shortHash(emission.vertexModule)}_${shortHash(emission.fragmentModule)}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        representative: variant.id,
        memberCount: 0,
        attributes: emission.structure.vertexBufferLayout,
        vertexWgsl: emission.vertexModule,
        fragmentWgsl: emission.fragmentModule,
        vertexBytes: emission.vertexModule.length,
        fragmentBytes: emission.fragmentModule.length,
      };
      groups.set(key, group);
    }
    group.memberCount += 1;
    const overrides = emission.structure.overrides;
    rows.push({
      id: variant.id,
      group: key,
      overrides,
      pipeline: `${key}#${production.emitter.overrideKey(overrides)}`,
      paired: emission.structure.paired,
    });
  }

  const plan = production.variants.prewarmPlan(production.variants.DEFAULT_APP_CONFIGURATION);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const planned = plan.planned.map((variant) => rowById.get(variant.id));
  const remaining = plan.remaining.map((variant) => rowById.get(variant.id));
  assert.ok(planned.every((row) => row !== undefined), "every planned variant MUST have been emitted");
  assert.ok(remaining.every((row) => row !== undefined), "every variant outside the plan MUST have been emitted");

  const findVariant = (selection) => {
    const wanted = Object.entries(selection);
    const found = variants.find((variant) => wanted.every(([id, value]) => variant.selection.some((entry) => entry.id === id && entry.value === value)));
    assert.ok(found !== undefined, `no reachable variant matches the session selection ${JSON.stringify(selection)}`);
    return found;
  };

  assert.equal(new Set(planned.map((row) => row.pipeline)).size, planned.length, "the prewarm plan MUST hold distinct variant identities (a duplicate would mean the plan, not the session, is wrong)");

  const sessionRequests = [];
  for (const phase of SESSION_PLAN) {
    const row = rowById.get(findVariant(phase.selection).id);
    assert.ok(row !== undefined, `the session phase "${phase.why}" MUST resolve to an emitted variant`);
    for (let frame = 0; frame < phase.frames; frame += 1) {
      sessionRequests.push({ frame, phase: phase.why, variant: row.id, group: row.group, overrides: row.overrides, pipeline: row.pipeline });
    }
  }

  return {
    production,
    layout,
    variants,
    groups,
    rows,
    rejected,
    plan,
    planned,
    remaining,
    sessionRequests,
    stats: {
      reachableVariants: variants.length,
      emitted: rows.length,
      rejected: rejected.length,
      distinctModulePairs: groups.size,
      moduleCompilations: 2 * groups.size,
      planSize: plan.size,
      plannedModuleTexts: new Set(planned.map((row) => row.group)).size,
      sessionFrames: sessionRequests.length,
      sessionDistinctVariants: new Set(sessionRequests.map((request) => request.pipeline)).size,
      sessionVariantsOutsideThePlan: [...new Set(sessionRequests.map((request) => request.pipeline))].filter((pipeline) => !planned.some((row) => row.pipeline === pipeline)).length,
    },
  };
}

/** Drive the SH-6 page once and return everything the spec asserts on. */
async function runVariantPage({ backend, inputRelative = null, timeoutMs = 600_000 }) {
  assert.ok(fs.existsSync(PAGE), `the SH-6 page MUST exist at ${PAGE_RELATIVE}`);
  const server = createStaticServer({ root: REPO_ROOT });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const channel = process.env.BENCH_BROWSER_CHANNEL ?? process.env.CONTRACT_BROWSER_CHANNEL ?? "chrome";
  const headless = process.env.CONTRACT_HEADED !== "1";
  const browser = await chromium.launch({ channel, headless });
  const context = await browser.newContext({ viewport: { width: 480, height: 320 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => pageErrors.push({ name: error.name ?? "Error", message: error.message ?? String(error) }));
  page.on("requestfailed", (request) => requestFailures.push({ url: request.url(), failure: request.failure()?.errorText ?? null }));

  const query = [`backend=${backend}`, ...(inputRelative === null ? [] : [`input=${encodeURIComponent(`/${inputRelative}`)}`])].join("&");
  const url = `http://127.0.0.1:${port}/${PAGE_RELATIVE}?${query}`;
  const run = { url, channel, headless, browserVersion: browser.version(), consoleMessages, pageErrors, requestFailures, report: null, error: null };
  try {
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForFunction(() => globalThis.__shaderVariants !== undefined && globalThis.__shaderVariants.ready === true, null, { timeout: timeoutMs });
    run.report = await page.evaluate(() => globalThis.__shaderVariants);
  } catch (error) {
    run.error = { name: error?.name ?? "Error", message: error?.message ?? String(error) };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
  return run;
}

/** `EnvironmentFingerprint` (contract §6): the numbers are only comparable within one fingerprint. */
function environmentFingerprint({ backend, browserVersion, channel, headless, adapter, degraded, degradedReason }) {
  const cpus = os.cpus() ?? [];
  return {
    os: { platform: os.platform(), release: os.release(), arch: os.arch(), version: typeof os.version === "function" ? os.version() : null },
    cpu: { model: cpus[0]?.model?.trim() ?? null, cores: cpus.length, totalMemoryBytes: os.totalmem() },
    gpu: {
      vendor: adapter?.vendor ?? null,
      architecture: adapter?.architecture ?? null,
      device: adapter?.device ?? null,
      description: adapter?.description ?? null,
      hasInfo: adapter?.hasInfo === true,
      isFallbackAdapter: adapter?.isFallbackAdapter === true,
    },
    browser: { channel, version: browserVersion, headless },
    backend,
    node: process.version,
    degraded,
    degradedReason,
  };
}

function assertCleanRun(run) {
  assert.equal(run.error, null, `the SH-6 page did not finish: ${run.error?.message ?? ""}`);
  assert.ok(run.report !== null && run.report !== undefined, "the SH-6 page MUST publish `globalThis.__shaderVariants`");
  assert.deepEqual(run.pageErrors, [], `uncaught page error(s): ${JSON.stringify(run.pageErrors)}`);
  assert.deepEqual(run.report.errors, [], `the page reported errors: ${JSON.stringify(run.report.errors)}`);
  const consoleErrors = run.consoleMessages.filter((message) => message.type === "error");
  assert.deepEqual(consoleErrors, [], `console error(s): ${JSON.stringify(consoleErrors)}`);
}

// ================================================================================================
// The registered budget, the tolerance records, and the deliberate-degradation self-test
// ================================================================================================

test("bench:shader-variants — the registered budget revision 3 is intact and the records still match it", async () => {
  const budget = readBudget();
  const records = await loadVariantBudget();

  assert.equal(budget.gate, "g6", "the SH-6 thresholds come from the G-6 gate's pre-registered budget");
  assert.equal(budget.revision, 3, "revision 3 is the current budget (revisions 1-2 were replaced, not deleted)");
  assert.equal(budget.kind, "pre-registered");
  assert.equal(budget.registeredBeforeAnyMeasurement, true);

  // ---- the history MUST NOT have been deleted or rewritten (revision 3's own contract) ----------
  assert.ok(Array.isArray(budget.history) && budget.history.length >= 2, `revisions 1 and 2 MUST stay in \`history\` (found ${budget.history?.length ?? 0} entries)`);
  const [revision1, revision2] = budget.history;
  assert.equal(revision1.revision, 1);
  assert.equal(revision2.revision, 2);
  assert.match(revision1.verdict, /^fail/, "revision 1's fail verdict MUST be preserved");
  assert.match(revision2.verdict, /^fail/, "revision 2's fail verdict MUST be preserved");
  assert.equal(revision1.session.maxP50CompileMs, 20, "revision 1's registered thresholds MUST be preserved verbatim");
  assert.equal(revision1.session.maxP95CompileMs, 60);
  assert.equal(revision1.session.maxPipelineCompilations, 48);
  assert.equal(revision1.measured.worstCaseP50, 110.5, "revision 1's measured values MUST be preserved verbatim");
  assert.equal(revision1.measured.worstCaseP95, 138.1);
  assert.equal(revision2.measured.worstCaseP50, 104.0, "revision 2's measured values MUST be preserved verbatim");
  assert.equal(revision2.measured.specP95, 127.1);
  assert.equal(budget.supersedes.revision, 2, "revision 3 records which revision it supersedes");
  assert.equal(budget.budgets.worstCase.role, "informational", "the full-space sweep is reference only in the registered budget");
  assert.equal(budget.budgets.worstCase.gated, false);

  // ---- the executable records MUST still equal the registered numbers ---------------------------
  assert.equal(records.RUNTIME_VARIANT_COMPILATIONS.threshold, budget.budgets.session.maxPipelineCompilations, "runtime compilation budget drifted from the registered budget");
  assert.equal(records.RUNTIME_VARIANT_COMPILATIONS.threshold, 0, "the runtime path MUST compile nothing (revision 3 tightened ≤48 to exactly 0)");
  assert.equal(records.NEW_VARIANT_PIPELINE_P95_MS.threshold, budget.budgets.startup.maxP95NewVariantMs);
  assert.equal(records.NEW_VARIANT_PIPELINE_P95_MS.threshold, 300);
  assert.equal(records.NEW_VARIANT_PIPELINE_P95_MS.comparison, "lessThan", "the criterion is p95 < 300 ms (strict)");
  assert.equal(records.STARTUP_PREWARM_MS.threshold, budget.budgets.startup.maxStartupWarmupMs);
  assert.equal(records.STARTUP_PREWARM_MS.threshold, 5000);
  assert.equal(records.STARTUP_PREWARM_VARIANTS.threshold, budget.budgets.startup.maxPrewarmVariants);
  assert.equal(records.STARTUP_PREWARM_VARIANTS.threshold, EXPECTED_PLAN_SIZE, "the prewarm bound MUST be the analytically derived plan size");
  assert.equal(records.STARTUP_PREWARM_VARIANTS.threshold, records.PREWARM_PLAN_SIZE, "the record MUST derive the plan size from the prewarm policy, not from a literal");
  assert.equal(records.REPEATED_MODULE_PARSES.threshold, budget.budgets.session.maxDuplicateModuleCompilations);
  assert.equal(records.REPEATED_MODULE_PARSES.threshold, budget.budgets.worstCase.maxDuplicateModuleCompilations);
  assert.equal(records.REPEATED_MODULE_PARSES.threshold, 0);
  assert.equal(records.REACHABLE_VARIANT_COUNT, EXPECTED_REACHABLE_VARIANTS, "the reachable define space MUST still be 768 combinations");
  assert.equal(records.FULL_SPACE_PREWARM_VARIANTS.threshold, EXPECTED_REACHABLE_VARIANTS);
  assert.equal(records.FULL_SPACE_PREWARM_VARIANTS.criterion, false, "the 768-variant full-space prewarm is reference only, never a criterion");
  assert.equal(records.REFERENCE_ONLY_RECORDS.length, 1, "exactly one registered record is reference only");
  assert.equal(records.CRITERION_RECORDS.length, 5, "five records decide the verdict");
  for (const record of records.TOLERANCE_RECORDS) {
    for (const field of ["metric", "threshold", "unit", "rationale", "source"]) {
      assert.ok(record[field] !== undefined && record[field] !== null && `${record[field]}`.length > 0, `every ToleranceRecord MUST carry a ${field} (${record.metric})`);
    }
  }
  console.log(
    `[${SUITE}] registered budget revision ${budget.revision} intact (history: rev1 ${revision1.verdict.slice(0, 4)}, rev2 ${revision2.verdict.slice(0, 4)}); ` +
      `${records.CRITERION_RECORDS.length} criterion record(s) + ${records.REFERENCE_ONLY_RECORDS.length} reference-only`,
  );
});

test("bench:shader-variants — a deliberately over-budget measurement MUST fail (人工劣化必须使判定失败)", async () => {
  const records = await loadVariantBudget();

  // The in-budget control first: a judge that fails everything would be useless.
  const inBudget = { runtimeVariantCompilations: 0, newVariantPipelineP95Ms: 97.9, startupPrewarmMs: 2255, startupPrewarmVariants: EXPECTED_PLAN_SIZE, repeatedModuleParses: 0, fullSpacePrewarmVariants: 732 };
  const control = records.evaluateVariantBudget(inBudget);
  assert.equal(control.verdict, "pass", `the gate-device numbers MUST be within the registered budget: ${JSON.stringify(control.failures)}`);

  // Every criterion violated at once: the verdict MUST fail and MUST name each violating metric.
  const overBudget = { runtimeVariantCompilations: 1, newVariantPipelineP95Ms: 301, startupPrewarmMs: 5001, startupPrewarmVariants: EXPECTED_PLAN_SIZE + 1, repeatedModuleParses: 2, fullSpacePrewarmVariants: 732 };
  const degraded = records.evaluateVariantBudget(overBudget);
  assert.equal(degraded.verdict, "fail", "an over-budget measurement MUST fail the gate");
  assert.deepEqual(
    degraded.failures.map((failure) => failure.metric).sort(),
    ["newVariantPipelineP95Ms", "repeatedModuleParses", "runtimeVariantCompilations", "startupPrewarmMs", "startupPrewarmVariants"],
    "every violated criterion MUST be reported by name",
  );
  assert.ok(!degraded.failures.some((failure) => failure.metric === "fullSpacePrewarmVariants"), "the reference-only record MUST NOT be able to fail the run");

  // A missing measurement is a failure, never a pass (an absent number is not a zero).
  const missing = records.evaluateVariantBudget({});
  assert.equal(missing.verdict, "fail", "a missing measurement MUST fail");
  assert.equal(missing.failures.length, records.CRITERION_RECORDS.length, "every criterion without a measurement MUST fail");

  // Boundaries: `< 300` is strict, `<= 5000` and `== 36` are inclusive.
  assert.equal(records.evaluateVariantBudget({ ...inBudget, newVariantPipelineP95Ms: 300 }).verdict, "fail", "p95 == 300 MUST fail (the bound is strict)");
  assert.equal(records.evaluateVariantBudget({ ...inBudget, startupPrewarmMs: 5000 }).verdict, "pass", "startup == 5000 ms MUST pass (the bound is inclusive)");
  assert.equal(records.evaluateVariantBudget({ ...inBudget, startupPrewarmMs: 5000.5 }).verdict, "fail");
  assert.equal(records.evaluateVariantBudget({ ...inBudget, runtimeVariantCompilations: null }).verdict, "fail", "a null measurement MUST fail");

  // The histogram the p95 comes from: nearest rank, and "no samples" is not "0 ms".
  const histogram = records.variantHistogram(Array.from({ length: 20 }, (_unused, index) => index * 10));
  assert.equal(histogram.count, 20);
  assert.equal(histogram.p50, 90, "nearest-rank p50 over [0,10,…,190] is the 10th sample");
  assert.equal(histogram.p95, 180, "nearest-rank p95 over [0,10,…,190] is the 19th sample");
  assert.equal(histogram.min, 0);
  assert.equal(histogram.max, 190);
  assert.equal(histogram.buckets.reduce((total, bucket) => total + bucket.count, 0), 20, "every sample MUST fall in exactly one bucket");
  assert.equal(records.measuredP95(records.variantHistogram([])), null, "an empty sample set MUST be a missing measurement, not a p95 of 0 ms");
  assert.equal(records.evaluateVariantBudget({ ...inBudget, newVariantPipelineP95Ms: records.measuredP95(records.variantHistogram([])) }).verdict, "fail");
  console.log(`[${SUITE}] self-test: over-budget → fail (${degraded.failures.length} named failure(s)), in-budget → pass, missing → fail`);
});

// ================================================================================================
// The measurement itself (one backend per run)
// ================================================================================================

const backend = activeBackend();

test(`bench:shader-variants — ${backend}: runtime compilations 0, prewarm and new-variant cost inside the registered budget`, async () => {
  const records = await loadVariantBudget();
  const budget = readBudget();

  // ----------------------------------------------------------------------------------------------
  // WebGL2 run: the isolation criterion only (contract §2 — one run enables exactly one backend).
  // ----------------------------------------------------------------------------------------------
  if (backend === "webgl2") {
    const run = await runVariantPage({ backend });
    assertCleanRun(run);
    const report = run.report;
    assert.equal(report.mode, "isolation", "the WebGL2 run of this suite MUST execute no SH-6 measurement");
    assert.ok(typeof report.skipped?.reason === "string" && report.skipped.reason.length > 0, "the WebGL2 run MUST state why it measures nothing");
    assert.ok(typeof report.skipped?.blindSpot === "string" && report.skipped.blindSpot.length > 0, "the WebGL2 run MUST record the blind spot");

    // "Only one backend was enabled": in THIS run the WebGPU path created 0 GPU objects ...
    assert.ok(report.webgpu !== null && report.webgpu !== undefined, "the WebGPU platform counters MUST be published");
    assert.equal(report.webgpu.adapterRequests, 0, "this WebGL2 run MUST NOT request a WebGPU adapter");
    assert.equal(report.webgpu.deviceRequests, 0, "this WebGL2 run MUST NOT request a WebGPU device");
    assert.equal(report.webgpu.gpuObjectsCreated, 0, `this WebGL2 run MUST NOT create any WebGPU object (got ${JSON.stringify(report.webgpu.objectsByMethod)})`);
    assert.equal(report.webgpu.prototypeInstrumented, true, "the prototype-level WebGPU object counters MUST have been installed, or '0 objects' would be an assumption");
    // ... and no device was touched: no module, no pipeline, no encoder was ever created.
    for (const method of ["createShaderModule", "createRenderPipeline", "createRenderPipelineAsync", "createBuffer", "createTexture", "createBindGroup", "createCommandEncoder"]) {
      assert.equal(report.webgpu.objectsByMethod[method] ?? 0, 0, `this WebGL2 run MUST NOT call ${method}`);
    }
    // The WebGL2 side is equally untouched: SH-6 measures compilation counts, not pixels.
    assert.equal(report.webgl2.contextRequests, 0, "this suite MUST NOT request a WebGL context — it renders nothing");
    assert.equal(report.webgl2.objectsCreated, 0, `this suite MUST NOT create WebGL objects (got ${JSON.stringify(report.webgl2.objectsByMethod)})`);
    assert.equal(report.renderedPixels, 0, "SH-6 renders nothing");
    assert.equal(report.readbacks, 0, "SH-6 reads nothing back");

    writeJson(repoPath(ISOLATION_ARTIFACT_RELATIVE), {
      gate: "SH-6",
      task: "T079",
      suite: SUITE,
      backend,
      verdict: "pass",
      recordedAt: new Date().toISOString(),
      isolation: "separate-process",
      runId: process.env.VERIFICATION_RUN_ID ?? null,
      url: run.url,
      notes:
        "SH-6 is a WebGPU compile-count/compile-cost gate: the WebGL2 run of this suite carries the contract §2 " +
        "criterion only — in this run the WebGPU path created 0 GPU objects and no device was touched — and exits 0. " +
        "It executes no measurement, so no number here may be read as a WebGL2 result.",
      skipped: report.skipped,
      counters: { webgpu: report.webgpu, webgl2: report.webgl2 },
      environment: environmentFingerprint({ backend, browserVersion: run.browserVersion, channel: run.channel, headless: run.headless, adapter: null, degraded: false, degradedReason: null }),
      registeredBudget: { path: BUDGET_RELATIVE, revision: budget.revision, recordedAt: budget.recordedAt },
    });
    console.log(
      `[${SUITE}] backend=webgl2 verdict=pass (isolation): webgpu adapterRequests=0 deviceRequests=0 gpuObjects=0; webgl2 contextRequests=0 objects=0; ` +
        `no measurement was executed -> ${ISOLATION_ARTIFACT_RELATIVE}`,
    );
    return;
  }

  // ----------------------------------------------------------------------------------------------
  // WebGPU run: the corpus, the device measurement, the verdict.
  // ----------------------------------------------------------------------------------------------
  const corpus = await buildCorpus();
  assert.deepEqual(corpus.rejected, [], `the emitter MUST emit every reachable define combination: ${JSON.stringify(corpus.rejected.slice(0, 3))}`);
  assert.equal(corpus.stats.reachableVariants, EXPECTED_REACHABLE_VARIANTS);
  assert.equal(corpus.stats.planSize, EXPECTED_PLAN_SIZE, "the prewarm plan MUST be the analytic 36-variant plan");
  assert.equal(corpus.stats.sessionVariantsOutsideThePlan, 0, "the documented session MUST be covered by the prewarm plan, or '0 runtime compilations' would be unmeasurable");

  const supportDir = repoPath(SUPPORT_DIR_RELATIVE);
  fs.mkdirSync(supportDir, { recursive: true });
  const terrainModuleFile = transpileForPage(TERRAIN_VARIANTS_TS, "terrain-variants.js");
  const budgetModuleFile = transpileForPage(VARIANT_BUDGET_TS, "variant-budget.js");
  const budgetModuleUrl = `/${repoRelative(budgetModuleFile)}`;
  assert.ok(fs.existsSync(terrainModuleFile), `the page's copy of the prewarm policy MUST exist at ${repoRelative(terrainModuleFile)}`);
  // Import the module the page imports, so a broken transpile fails here instead of silently leaving
  // the page without a judge (the page reports a missing judge as an error, but this is clearer).
  const pageBudgetModule = await import(pathToFileURL(budgetModuleFile).href);
  assert.equal(typeof pageBudgetModule.variantHistogram, "function", "the module the page imports MUST expose variantHistogram");
  assert.equal(typeof pageBudgetModule.evaluateVariantBudget, "function", "the module the page imports MUST expose evaluateVariantBudget");
  assert.equal(pageBudgetModule.STARTUP_PREWARM_VARIANTS.threshold, EXPECTED_PLAN_SIZE, "the transpiled module MUST carry the same thresholds");

  const input = {
    mode: "shader-variants",
    suite: SUITE,
    backend: "webgpu",
    budgetModuleUrl,
    prewarmPlan: {
      id: "g6-reachable-subset-prewarm",
      configuration: corpus.production.variants.DEFAULT_APP_CONFIGURATION,
      dynamicDimensions: corpus.production.variants.PREWARM_DYNAMIC_DIMENSIONS.map((dimension) => ({ id: dimension.id, values: dimension.values, why: dimension.why })),
      declaredSize: corpus.production.variants.PREWARM_PLAN_SIZE,
    },
    corpus: {
      reachableVariants: corpus.stats.reachableVariants,
      emitted: corpus.stats.emitted,
      distinctModulePairs: corpus.stats.distinctModulePairs,
      moduleCompilations: corpus.stats.moduleCompilations,
      planSize: corpus.stats.planSize,
      sessionFrames: corpus.stats.sessionFrames,
    },
    layout: {
      structName: corpus.layout.structName,
      structSize: corpus.layout.structSize,
      maxBindingsPerGroup: corpus.layout.maxBindingsPerGroup,
      samplers: corpus.layout.samplers.map((sampler) => ({ name: sampler.name, textureBinding: sampler.textureBinding, samplerBinding: sampler.samplerBinding, groupIndex: sampler.groupIndex, textureType: sampler.textureType })),
    },
    groups: [...corpus.groups.values()],
    prewarmVariants: corpus.planned.map(({ id, group, overrides, pipeline }) => ({ id, group, overrides, pipeline })),
    remainingVariants: corpus.remaining.map(({ id, group, overrides, pipeline }) => ({ id, group, overrides, pipeline })),
    sessionRequests: corpus.sessionRequests,
  };
  const inputFile = repoPath(INPUT_RELATIVE);
  fs.mkdirSync(path.dirname(inputFile), { recursive: true });
  fs.writeFileSync(inputFile, JSON.stringify(input), "utf8");

  const run = await runVariantPage({ backend, inputRelative: repoRelative(inputFile) });
  assertCleanRun(run);
  const report = run.report;
  assert.equal(report.mode, "shader-variants");
  assert.equal(report.corpus.distinctModulePairs, corpus.stats.distinctModulePairs, "the page MUST have been handed the corpus this spec built");

  // ---- instrumentation: the numbers are counted by wrappers, not by bookkeeping alone ------------
  assert.equal(report.instrumentation.status.createShaderModule, "wrapped", `createShaderModule MUST be wrapped to count calls (${report.instrumentation.status.createShaderModule})`);
  assert.equal(report.instrumentation.status.createRenderPipeline, "wrapped", `createRenderPipeline MUST be wrapped to count calls (${report.instrumentation.status.createRenderPipeline})`);
  assert.equal(report.counters.shaderModuleCallsMatch, true, `createShaderModule calls MUST be 2 × distinct module texts (got ${report.counters.createShaderModuleCalls} for ${report.counters.distinctModulePairs})`);
  assert.equal(report.counters.pipelineCallsMatch, true, `createRenderPipeline calls MUST equal the per-phase counts (got ${report.counters.createRenderPipelineCalls}, expected ${report.counters.expectedPipelineCalls})`);
  assert.equal(report.counters.prototypeCountsMatchWrapper, true, `the prototype-level counters MUST agree with the device wrappers (${JSON.stringify(report.counters.prototypeCounts)})`);

  // ---- structural: the emitted text is the parse identity ---------------------------------------
  assert.equal(report.counters.distinctModuleTexts, corpus.stats.distinctModulePairs, "the whole reachable space MUST reduce to the analytic number of distinct module texts");
  assert.equal(report.counters.moduleCompilations, 2 * corpus.stats.distinctModulePairs, "a module text MUST be parsed exactly twice (one vertex + one fragment module)");
  assert.equal(report.counters.repeatedParses, 0, `no module text may be parsed twice (got ${report.counters.repeatedParses} repeated parse(s))`);
  assert.equal(report.startup.distinctModuleTexts, corpus.stats.plannedModuleTexts, "the plan's module texts MUST be the ones this spec emitted for it");

  // ---- startup: the plan, cold, before the first frame -------------------------------------------
  assert.equal(report.startup.plannedVariants, EXPECTED_PLAN_SIZE, "the prewarm plan MUST be the analytic 36-variant plan");
  assert.equal(report.startup.declaredPlanSize, EXPECTED_PLAN_SIZE);
  assert.equal(report.startup.pipelineCompilations, EXPECTED_PLAN_SIZE);
  assert.equal(report.startup.failures, 0, "every planned variant MUST create its pipeline with 0 validation errors");
  assert.equal(report.startup.samplesMs.length, EXPECTED_PLAN_SIZE, "one duration sample per planned variant");
  assert.equal(report.startup.histogram.count, EXPECTED_PLAN_SIZE);

  // ---- session: the prepared pool serves every frame ---------------------------------------------
  assert.equal(report.session.frames, corpus.stats.sessionFrames);
  assert.equal(report.session.poolPreparedBeforeTheSession, true);
  assert.equal(report.session.runtimeCompilations, 0, `the session MUST compile nothing (got ${report.session.runtimeCompilations} runtime compilation(s))`);
  assert.equal(report.session.pipelineCallsDuringSession, 0, `the wrapped createRenderPipeline MUST be called 0 times during the session (got ${report.session.pipelineCallsDuringSession})`);
  assert.equal(report.session.cacheMisses, 0, `every session request MUST be served from the pool (got ${report.session.cacheMisses} miss(es))`);
  assert.equal(report.session.cacheHitRatio, 1);
  assert.equal(report.session.shaderProgramInstances, corpus.stats.sessionDistinctVariants, "the session MUST touch exactly the distinct variants the plan covers");

  // ---- reference only: the cold complement of the plan -------------------------------------------
  assert.equal(report.fullSpace.role, "informational");
  assert.equal(report.fullSpace.criterion, false, "the full-space sweep MUST NOT be a criterion");
  assert.equal(report.fullSpace.pipelineCompilations, EXPECTED_REACHABLE_VARIANTS - EXPECTED_PLAN_SIZE);
  assert.equal(report.fullSpace.failures, 0, "the reference sweep MUST NOT hide a validation error");
  assert.equal(report.fullSpace.samplesMs.length, EXPECTED_REACHABLE_VARIANTS - EXPECTED_PLAN_SIZE);

  // ---- the judgement: same records, same samples, Node side --------------------------------------
  const startupHistogram = records.variantHistogram(report.startup.samplesMs);
  assert.deepEqual(startupHistogram, report.startup.histogram, "the page's histogram MUST equal the one the judge computes from the same raw samples (no drift between the two evaluations)");
  const measurement = {
    runtimeVariantCompilations: report.session.runtimeCompilations,
    newVariantPipelineP95Ms: records.measuredP95(startupHistogram),
    startupPrewarmMs: report.startup.wallMs,
    startupPrewarmVariants: report.startup.plannedVariants,
    repeatedModuleParses: report.counters.repeatedParses,
    fullSpacePrewarmVariants: report.fullSpace.requestedVariants,
  };
  const verdict = records.evaluateVariantBudget(measurement);
  assert.equal(report.budgetVerdict?.verdict, verdict.verdict, "the in-page verdict MUST agree with the Node-side verdict (one tolerance module, two evaluations)");

  const adapter = report.adapter ?? null;
  const degradedReason =
    adapter === null
      ? "no WebGPU adapter was reported by the page"
      : adapter.hasInfo !== true
        ? `adapter.info carries no vendor/architecture (${JSON.stringify(adapter)}), so this machine cannot certify a hardware compile-cost budget`
        : adapter.isFallbackAdapter === true
          ? "the adapter identifies itself as a fallback (software) adapter, so the numbers are not hardware numbers"
          : null;
  const degraded = degradedReason !== null;

  const blindSpots = [
    "SH-6 renders nothing and reads nothing back: the gate is about compile counts and compile cost, so this artefact says nothing about pixels (SH-2/SH-5 own those).",
    "The cold whole-space sweep is reference only (`criterion: false` in the registered budget and in variant-budget.ts): it is not a product path and no bound can be derived for it from SC-004.",
    "Timings are wall-clock on one machine and one browser build; compare them only within the same EnvironmentFingerprint.",
    "The pipeline layout is the explicit H-4 union layout the page builds from the bind-layout table (the production pipeline-layout builder lands with the W5 ShaderProgram replacement), so the per-variant cost measured here is the union-layout pipeline the product creates.",
    "One browser process, one adapter, one session: the numbers do not cover thermal/contention effects across runs.",
    ...(degraded ? [`DEGRADED: ${degradedReason}`] : []),
  ];

  const artefact = {
    gate: "SH-6",
    task: "T079",
    suite: SUITE,
    backend,
    verdict: verdict.verdict,
    recordedAt: new Date().toISOString(),
    isolation: "separate-process",
    runId: process.env.VERIFICATION_RUN_ID ?? null,
    url: run.url,
    page: PAGE_RELATIVE,
    notes:
      "SH-6 变体规模与编译耗时门禁（tasks.md T079，H-6）。判据 = `experiments/gates/g6-variants/budget.json` revision 3：运行期编译 0 次、单次新变体 p95 < 300 ms、启动预热 ≤ 5000 ms（记录变体数 36 = 纯函数计划大小）、重复解析 0；" +
      "全空间 768 变体预热**仅供参考、不作判据**（`criterion: false`）。语料由**生产**发射器（tools/shader-model.mjs → wgpu/**）枚举 768 个可达 define 组合得到 128 份互异模块文本；" +
      "页面只做 createShaderModule/createRenderPipeline 的计数与计时，不渲染、不回读。revision 1/2 的 fail 记录与阈值完整保留在 budget.json 的 history 中，本套件断言其未被改写。",
    environment: environmentFingerprint({ backend, browserVersion: run.browserVersion, channel: run.channel, headless: run.headless, adapter, degraded, degradedReason }),
    registeredBudget: {
      path: BUDGET_RELATIVE,
      revision: budget.revision,
      recordedAt: budget.recordedAt,
      supersedes: budget.supersedes,
      history: budget.history,
      budgets: budget.budgets,
      source: budget.source,
    },
    registeredThresholds: records.registeredThresholds(),
    measurement,
    budgetVerdict: verdict,
    budgetVerdictInPage: report.budgetVerdict,
    corpus: { ...corpus.stats, layout: { structName: corpus.layout.structName, structSize: corpus.layout.structSize, samplers: corpus.layout.samplers.length, maxBindingsPerGroup: corpus.layout.maxBindingsPerGroup } },
    instrumentation: report.instrumentation,
    counters: report.counters,
    startup: report.startup,
    session: report.session,
    fullSpace: report.fullSpace,
    pageNotes: report.notes,
    blindSpots,
    evidence: [
      { path: ARTIFACT_RELATIVE, what: "this artefact: the measurements, the registered thresholds with their rationale/source, the environment fingerprint and the verdict" },
      { path: BUDGET_RELATIVE, what: "the pre-registered budget revision 3 (and the preserved fail records of revisions 1-2)" },
      { path: "tests/benchmark/page/shader-variants.html", what: "the in-page driver that counts and times createShaderModule/createRenderPipeline" },
      { path: VARIANT_BUDGET_TS, what: "the ToleranceRecords and the budget arithmetic both the page and this spec judge with" },
      { path: "tools/shader-model.mjs", what: "the production model: enumeration, GLSL assembly, union bind layout and WGSL emission" },
      { path: INPUT_RELATIVE, what: "the exact measurement input the page fetched (module corpus, override values, prewarm plan, session requests)" },
      { path: "experiments/gates/g6-variants/driver.js", what: "the pre-W4 gate driver this page's measurement definitions follow, so the numbers stay comparable with docs/gate-g6-conclusion.md §0.2" },
    ],
  };

  // The artefact is written **before** the verdict is asserted: an over-budget run still lands on disk.
  writeJson(repoPath(ARTIFACT_RELATIVE), artefact);

  if (degraded) {
    console.error(
      `[${SUITE}] DEGRADED — ${degradedReason}\n` +
        `[${SUITE}] the WebGPU path therefore FAILS (a synthetic pass on a non-hardware adapter would be exactly the silent degradation the constitution forbids); ` +
        `the blind spot is recorded in ${ARTIFACT_RELATIVE}`,
    );
  }
  if (verdict.verdict !== "pass") {
    console.error(`[${SUITE}] OVER BUDGET: ${verdict.failures.map((failure) => `${failure.metric}=${failure.measured} (${failure.reason})`).join("; ")}`);
  }

  assert.equal(degraded, false, `the WebGPU SH-6 run MUST be a hardware run: ${degradedReason}`);
  assert.equal(verdict.verdict, "pass", `SH-6 MUST stay inside the registered budget revision 3: ${JSON.stringify(verdict.failures)}`);

  console.log(
    `[${SUITE}] backend=webgpu verdict=pass | distinctModuleTexts=${report.counters.distinctModuleTexts} createShaderModule=${report.counters.createShaderModuleCalls} repeatedParses=${report.counters.repeatedParses} ` +
      `runtimeCompilations=${report.session.runtimeCompilations} prewarm=${report.startup.plannedVariants} variants/${Math.round(report.startup.wallMs)} ms p95=${startupHistogram.p95.toFixed(1)} ms ` +
      `(p50=${startupHistogram.p50.toFixed(1)} ms, max=${startupHistogram.max.toFixed(1)} ms) | reference: ${report.fullSpace.pipelineCompilations} variants/${(report.fullSpace.wallMs / 1000).toFixed(1)} s ` +
      `p50=${report.fullSpace.histogram.p50.toFixed(1)} ms -> ${ARTIFACT_RELATIVE}`,
  );
});
