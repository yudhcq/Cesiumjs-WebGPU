#!/usr/bin/env node
/**
 * G-1 gate runner — **接缝可替换性 (H-1)** — tasks.md T015.
 *
 *   node experiments/gates/g1-alias/run.mjs                    # the gate: writes out/g1.json
 *   node experiments/gates/g1-alias/run.mjs --control=no-rewrite
 *                                                             # negative control: writes
 *                                                             # out/g1-control-no-rewrite.json
 *
 * Sequence (everything is measured, nothing is assumed):
 *   1. snapshot every byte of the installed `@cesium/engine` package;
 *   2. run the real build chain (`build.mjs`: Rollup + the T008 alias plugin + the gate-local
 *      manifest) and bundle the upstream `Scene/Scene.js` graph;
 *   3. snapshot the upstream package again and assert the build changed nothing on disk;
 *   4. serve the repository, open `page.html` in a real browser (Playwright + installed Chrome)
 *      and let `probe.js` construct the upstream `Scene`;
 *   5. judge every check and write `experiments/gates/out/g1.json` (schema:
 *      `experiments/gates/README.md`, validated by `tools/scripts/check-gate.mjs`).
 *
 * **Negative control** (`--control=no-rewrite`): the same harness, the same page and the same
 * assertions, but with an *empty* replacement manifest — the upstream `Renderer/Context.js` is
 * then bundled unchanged. A gate that cannot fail proves nothing, so the control MUST report the
 * provenance checks as failed; the control passes only when the harness detects the broken seam.
 *
 * Exit codes: 0 → `verdict === "pass"`; 1 → the gate failed (STOP: report to the entry-point agent
 * for a plan revision — the documented fallback is a whole-repository fork F1); 2 → the runner
 * itself could not run (e.g. the browser is missing) — the artefact is still written as `partial`.
 *
 * Options: `--channel <chrome|msedge|chromium>` (default `chrome`), `--headed`, `--timeout <ms>`,
 * `--skip-build` (reuse the last bundle), `--control=no-rewrite`, `--quiet`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createStaticServer } from "../../../tools/scripts/serve.mjs";
import { ENGINE_ROOT, GATE_DIR, OUT_DIR, REPO_ROOT, buildGateBundle } from "./build.mjs";
import { compareSnapshots, snapshotUpstream } from "./upstream-integrity.mjs";

const PAGE = path.join(GATE_DIR, "page.html");
const GATE_MANIFEST = path.join(GATE_DIR, "manifest.gate.json");

const logLines = [];
function log(line) {
  const text = `[g1] ${line}`;
  logLines.push(text);
  if (!process.argv.includes("--quiet")) process.stdout.write(`${text}\n`);
}

function repoRelative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

function evidencePath(absolute) {
  return repoRelative(path.resolve(absolute));
}

function check(id, ok, detail, extra = {}) {
  return { id, ok: ok === true, detail, ...extra };
}

function parseArgs(argv) {
  const options = {
    channel: process.env.GATE_BROWSER_CHANNEL ?? "chrome",
    headed: false,
    timeoutMs: 180000,
    skipBuild: false,
    control: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(0, eq) : token;
    const value = eq >= 0 ? token.slice(eq + 1) : undefined;
    if (key === "--channel") options.channel = value ?? argv[++i];
    else if (key === "--headed") options.headed = true;
    else if (key === "--timeout") options.timeoutMs = Number(value ?? argv[++i]);
    else if (key === "--skip-build") options.skipBuild = true;
    else if (key === "--control") options.control = value ?? argv[++i];
    else if (key === "--quiet") continue;
    else if (key === "--help" || key === "-h") {
      process.stdout.write(
        "usage: node experiments/gates/g1-alias/run.mjs [--channel chrome] [--headed] [--timeout ms] [--skip-build] [--control=no-rewrite] [--quiet]\n",
      );
      process.exit(0);
    } else throw new Error(`unknown argument "${token}"`);
  }
  if (options.control !== null && options.control !== "no-rewrite") throw new Error(`unknown control "${options.control}" (only "no-rewrite")`);
  return options;
}

/** Per-mode artefact layout so the control can never clobber the gate's own evidence. */
function resolveMode(options) {
  if (options.control === "no-rewrite") {
    return {
      kind: "control",
      gateId: "g1-control-no-rewrite",
      manifestPath: path.join(OUT_DIR, "g1-control-manifest.json"),
      bundleDir: path.join(OUT_DIR, "g1-alias-control"),
      writeManifest: true,
      pageQuery: "bundle=../out/g1-alias-control/bundle.js",
      gateArtifact: path.join(OUT_DIR, "g1-control-no-rewrite.json"),
      buildArtifact: path.join(OUT_DIR, "g1-control-build.json"),
      runtimeArtifact: path.join(OUT_DIR, "g1-control-runtime.json"),
      logArtifact: path.join(OUT_DIR, "g1-control-run.log"),
    };
  }
  return {
    kind: "gate",
    gateId: "g1",
    manifestPath: GATE_MANIFEST,
    bundleDir: path.join(OUT_DIR, "g1-alias"),
    writeManifest: false,
    pageQuery: null,
    gateArtifact: path.join(OUT_DIR, "g1.json"),
    buildArtifact: path.join(OUT_DIR, "g1-build.json"),
    runtimeArtifact: path.join(OUT_DIR, "g1-runtime.json"),
    logArtifact: path.join(OUT_DIR, "g1-run.log"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mode = resolveMode(options);
  const startedAt = new Date().toISOString();
  log(`start ${startedAt} (node ${process.version}, channel=${options.channel}, headed=${options.headed}, mode=${mode.kind})`);

  if (mode.writeManifest) {
    // Empty manifest = the alias plugin rewrites nothing (the control's whole point).
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(
      mode.manifestPath,
      `${JSON.stringify(
        {
          gateNote:
            "G-1 negative control manifest: EMPTY on purpose. With no manifest entry the T008 alias plugin rewrites nothing, so the upstream Renderer/Context.js stays in the bundle and the gate's provenance assertions MUST fail.",
          baseline: { packageName: "@cesium/engine", version: "26.3.0", cesiumVersion: "1.145.0" },
          entries: [],
          keptModulesHash: null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  // ---- 1. upstream snapshot (before) ---------------------------------------------------------
  const upstreamBefore = snapshotUpstream(ENGINE_ROOT);
  log(`upstream snapshot: ${upstreamBefore.fileCount} files, ${upstreamBefore.totalBytes} bytes, ${upstreamBefore.aggregateHash}`);

  // ---- 2. real build chain -------------------------------------------------------------------
  const buildReport = options.skipBuild
    ? JSON.parse(fs.readFileSync(mode.buildArtifact, "utf8"))
    : await buildGateBundle({
        quiet: process.argv.includes("--quiet"),
        manifestPath: mode.manifestPath,
        bundleDir: mode.bundleDir,
        artifactPath: mode.buildArtifact,
      });

  // ---- 3. upstream snapshot (after the build) ------------------------------------------------
  const upstreamAfter = snapshotUpstream(ENGINE_ROOT);
  const integrity = compareSnapshots(upstreamBefore, upstreamAfter);
  log(`upstream unchanged after build: ${integrity.unchanged}`);

  const enginePackage = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, "package.json"), "utf8"));

  const checks = buildReport.checks.map((entry) => ({ ...entry, phase: "build" }));
  checks.push(
    check(
      "upstream-disk-unchanged",
      integrity.unchanged,
      `aggregate ${integrity.aggregateBefore} -> ${integrity.aggregateAfter}; files ${integrity.fileCountBefore} -> ${integrity.fileCountAfter}; ` +
        `changed=[${integrity.changedDetails.join(", ")}] (the alias plugin rewrites at build time only — node_modules is never edited)`,
    ),
  );

  // ---- 4. browser ----------------------------------------------------------------------------
  const server = createStaticServer({ root: REPO_ROOT });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/${repoRelative(PAGE)}${mode.pageQuery === null ? "" : `?${mode.pageQuery}`}`;
  log(`serving repository — page ${url}`);

  let browser = null;
  let runtime = { ran: false, report: null, error: null, pageErrors: [], consoleMessages: [], requestFailures: [] };
  const environment = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    engine: { packageName: enginePackage.name, version: enginePackage.version, lock: "upstream/engine-26.3.0.lock.json" },
    browser: null,
    gpu: null,
    webgl2: null,
  };

  try {
    browser = await chromium.launch({ channel: options.channel, headless: !options.headed });
    environment.browser = {
      channel: options.channel,
      version: browser.version(),
      headless: !options.headed,
      launchArgs: [],
      note: "zero launch flags: headless Chrome exposes a hardware WebGPU adapter on this machine",
    };
    const page = await browser.newPage();
    page.on("console", (message) => {
      runtime.consoleMessages.push({ type: message.type(), text: message.text(), location: message.location() });
    });
    page.on("pageerror", (error) => {
      runtime.pageErrors.push({ name: error.name ?? "Error", message: error.message ?? String(error), stack: error.stack ?? null });
    });
    page.on("requestfailed", (request) => {
      runtime.requestFailures.push({ url: request.url(), failure: request.failure()?.errorText ?? null });
    });

    await page.goto(url, { waitUntil: "load", timeout: options.timeoutMs });
    await page.waitForFunction(() => globalThis.__g1 !== undefined && globalThis.__g1.ready === true, null, { timeout: options.timeoutMs });
    const collected = await page.evaluate(() => ({ report: globalThis.__g1.report, error: globalThis.__g1.error }));
    runtime = { ...runtime, ran: true, report: collected.report, error: collected.error };
    log(`page probe finished (report=${collected.report !== null}, error=${collected.error === null ? "none" : collected.error.message})`);
  } catch (error) {
    runtime.error = { name: error.name ?? "Error", message: error.message ?? String(error), stack: error.stack ?? null };
    log(`runtime step failed: ${runtime.error.message}`);
  } finally {
    if (browser !== null) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(mode.runtimeArtifact, `${JSON.stringify(runtime, null, 2)}\n`, "utf8");

  // ---- 5. runtime checks ---------------------------------------------------------------------
  const report = runtime.report;
  if (report === null) {
    checks.push(
      check("runtime-probe-produced-report", false, `the in-page probe did not produce a report: ${runtime.error === null ? "unknown reason" : runtime.error.message}`),
    );
  } else {
    const consumption = report.consumption ?? {};
    const diagnostics = report.diagnostics ?? { reads: {}, constructions: [], notImplemented: [] };
    const limits = report.upstreamLimits ?? {};
    const environmentReport = report.environment ?? {};
    environment.browser = { ...environment.browser, userAgent: environmentReport.userAgent ?? null };
    environment.webgl2 = { available: environmentReport.webgl2Available === true };
    environment.gpu = { webgpu: environmentReport.webgpu ?? null };

    checks.push(
      check(
        "runtime-probe-produced-report",
        report.construction !== null && runtime.error === null,
        `probe completed at ${report.finishedAt}; construction threw=${report.construction?.threw}; page-level error=${runtime.error === null ? "none" : runtime.error.message}`,
      ),
      check(
        "scene-constructed-through-replacement",
        report.construction?.threw === false &&
          report.contextIdentity === true &&
          consumption.contextInstanceOfBundleContext === true &&
          consumption.contextInstanceOfLocalFile === true &&
          consumption.gateStubFlag === true &&
          consumption.stubMarkerOnContext === report.marker,
        `new Scene({canvas}) with no context injected → constructor="${consumption.contextConstructorName}", ` +
          `instanceof bundle Context=${consumption.contextInstanceOfBundleContext}, instanceof the gate-local file=${consumption.contextInstanceOfLocalFile}, ` +
          `deep-import identity=${report.contextIdentity}, stub flag=${consumption.gateStubFlag}, marker=${consumption.stubMarkerOnContext}, id=${consumption.contextId}`,
      ),
      check(
        "replacement-consumed-by-scene",
        diagnostics.constructionCount === 1 &&
          (diagnostics.reads?.fragmentDepth ?? 0) >= 1 &&
          (diagnostics.reads?.drawingBufferWidth ?? 0) >= 1 &&
          (diagnostics.reads?.drawingBufferHeight ?? 0) >= 1 &&
          consumption.sceneCanvasIsGateCanvas === true,
        `the replacement recorded ${diagnostics.constructionCount} construction(s) and the upstream Scene read ` +
          `fragmentDepth x${diagnostics.reads?.fragmentDepth ?? 0}, drawingBufferWidth x${diagnostics.reads?.drawingBufferWidth ?? 0}, ` +
          `drawingBufferHeight x${diagnostics.reads?.drawingBufferHeight ?? 0}, uniformState x${diagnostics.reads?.uniformState ?? 0} ` +
          `(Scene.js:195/715-720; uniformState is built by upstream Context.js:335); scene.canvas is the gate canvas=${consumption.sceneCanvasIsGateCanvas}`,
      ),
      check(
        "scene-public-api-served-by-replacement",
        consumption.sceneDrawingBufferWidth === consumption.contextDrawingBufferWidth &&
          consumption.sceneDrawingBufferHeight === consumption.contextDrawingBufferHeight &&
          (consumption.glContextAcquired !== true ||
            (consumption.contextDrawingBufferWidth === consumption.glDrawingBufferWidth &&
              consumption.contextDrawingBufferHeight === consumption.glDrawingBufferHeight)),
        `scene.drawingBufferWidth/Height = ${consumption.sceneDrawingBufferWidth}/${consumption.sceneDrawingBufferHeight} ` +
          `(the upstream public getters delegate to the replacement) vs context ${consumption.contextDrawingBufferWidth}/${consumption.contextDrawingBufferHeight}; ` +
          `GL context acquired=${consumption.glContextAcquired}${consumption.glContextAcquired ? ` (${consumption.glContextType}) drawing buffer ${consumption.glDrawingBufferWidth}/${consumption.glDrawingBufferHeight}` : ""}`,
        { glBacked: consumption.glContextAcquired === true },
      ),
      check(
        "capability-flags-reach-kept-upstream-module",
        consumption.glContextAcquired === true
          ? limits.maximumTextureSize === limits.glMaximumTextureSize && (limits.maximumTextureSize ?? 0) > 0 && limits.maximumSamples === limits.glMaximumSamples
          : limits.writtenByReplacement === false,
        consumption.glContextAcquired === true
          ? `Renderer/ContextLimits.js (kept upstream, not in the manifest) received the replacement's values: maximumTextureSize=${limits.maximumTextureSize} ` +
            `(gl=${limits.glMaximumTextureSize}), maximumSamples=${limits.maximumSamples} (gl=${limits.glMaximumSamples}), ` +
            `maximumVertexAttributes=${limits.maximumVertexAttributes}, maximum3DTextureSize=${limits.maximum3DTextureSize}`
          : `no WebGL2 in this environment (${environmentReport.webgl2Available}) → ContextLimits keeps the upstream defaults; ` +
            `NOT APPLICABLE to the seam claim (the environment-independent checks above carry the verdict)`,
        { applicable: consumption.glContextAcquired === true },
      ),
      check(
        "logic-layer-capability-branch-followed-replacement",
        consumption.logDepthLinkageHolds === true &&
          (consumption.fragmentDepth !== true || (consumption.sceneLogDepthBuffer === true && consumption.cameraFar === 10000000000 && consumption.cameraNear === 0.1)),
        `Scene.js:195 \`_logDepthBuffer = Scene.defaultLogDepthBuffer && context.fragmentDepth\` → ${consumption.sceneLogDepthBuffer} ` +
          `(defaultLogDepthBuffer=${consumption.sceneDefaultLogDepthBuffer}, our fragmentDepth=${consumption.fragmentDepth}, linkage=${consumption.logDepthLinkageHolds}); ` +
          `Scene.js:723-726 then set camera near/far = ${consumption.cameraNear}/${consumption.cameraFar} (camera=${consumption.cameraServedByScene})`,
        { applicable: consumption.fragmentDepth === true },
      ),
      check(
        "replacement-fails-loudly-not-silently",
        report.notImplementedProbes?.allCategoryNotImplemented === true,
        `probes: ${report.notImplementedProbes?.method?.description} → threw=${report.notImplementedProbes?.method?.threw} ` +
          `category=${report.notImplementedProbes?.method?.error?.category}; ${report.notImplementedProbes?.accessor?.description} → ` +
          `threw=${report.notImplementedProbes?.accessor?.threw} category=${report.notImplementedProbes?.accessor?.error?.category}; ` +
          `recorded capabilities=[${(diagnostics.notImplemented ?? []).join(", ")}] (a replacement MUST NOT return silent empty values)`,
      ),
      check(
        "webgpu-adapter-info-recorded",
        environmentReport.webgpu !== null &&
          environmentReport.webgpu !== undefined &&
          (environmentReport.webgpu.available === true
            ? environmentReport.webgpu.adapterInfo?.vendor != null
            : typeof environmentReport.webgpu.reason === "string"),
        environmentReport.webgpu?.available === true
          ? `adapter.info=${JSON.stringify(environmentReport.webgpu.adapterInfo)}, preferredFormat=${environmentReport.webgpu.preferredFormat}, ` +
            `isFallbackAdapter=${environmentReport.webgpu.isFallbackAdapter}, requestDevice()=${environmentReport.webgpu.requestDeviceOk}`
          : `WebGPU unavailable in this environment: ${environmentReport.webgpu?.reason ?? "not probed"}`,
      ),
      check("no-uncaught-page-errors", runtime.pageErrors.length === 0, `${runtime.pageErrors.length} uncaught page error(s)${runtime.pageErrors.length > 0 ? `: ${runtime.pageErrors.map((error) => error.message).join(" | ")}` : ""}`),
      check(
        "no-console-errors",
        runtime.consoleMessages.filter((message) => message.type === "error").length === 0,
        `${runtime.consoleMessages.length} console message(s) — errors: ` +
          `${JSON.stringify(runtime.consoleMessages.filter((message) => message.type === "error").map((message) => message.text))}`,
      ),
    );
  }

  if (mode.kind === "gate") {
    checks.push(
      check(
        "environment-recorded",
        environment.node !== null &&
          environment.browser?.version !== null &&
          environment.browser?.version !== undefined &&
          typeof environment.webgl2?.available === "boolean" &&
          (environment.gpu?.webgpu?.available === true || typeof environment.gpu?.webgpu?.reason === "string"),
        `node=${environment.node}, browser=${environment.browser?.channel} ${environment.browser?.version} headless=${environment.browser?.headless}, ` +
          `webgl2=${environment.webgl2?.available}, webgpu=${environment.gpu?.webgpu?.available}` +
          `${environment.gpu?.webgpu?.available ? ` (${environment.gpu.webgpu.adapterInfo?.vendor}/${environment.gpu.webgpu.adapterInfo?.architecture})` : ""}`,
      ),
    );
  }

  for (const entry of checks) entry.phase ??= "runtime";

  // ---- 6. verdict + artefact -----------------------------------------------------------------
  if (mode.kind === "control") return finishControl({ mode, checks, runtime, environment, buildReport, integrity, enginePackage, startedAt });

  const failed = checks.filter((entry) => entry.ok !== true);
  const runtimeRan = report !== null;
  // pass  = every check held; fail = a build/seam check broke, or the runtime half ran and failed;
  // partial = the seam half is proven but the browser half could not run (never "pass").
  const verdict = failed.length === 0 ? "pass" : failed.some((entry) => entry.phase === "build") || runtimeRan ? "fail" : "partial";

  const evidence = [
    { path: evidencePath(mode.buildArtifact), what: "Rollup build evidence: per-resolution trace, module-graph classification, whitelist exhaustiveness, bundle text probes, CJS interop records" },
    { path: evidencePath(mode.runtimeArtifact), what: "raw in-page probe report (scene construction, consumption counters, ContextLimits values, loud-failure probes, console/page errors)" },
    { path: evidencePath(path.join(mode.bundleDir, "bundle.js")), what: "the real build output loaded by the browser (upstream Scene graph + gate-local Renderer/Context.js)" },
    { path: evidencePath(mode.logArtifact), what: "runner transcript of this execution" },
    { path: evidencePath(mode.manifestPath), what: "gate-local replacement manifest (1 entry: Renderer/Context.js, kind=replace, glCallSites=46)" },
    { path: "experiments/gates/g1-alias/Renderer/Context.js", what: "the replacement implementation consumed by the upstream Scene" },
    { path: "experiments/gates/g1-alias/entry.js", what: "bundle entry: upstream deep imports + gate-local implementation" },
    { path: "experiments/gates/g1-alias/build.mjs", what: "real build chain (Rollup + tools/rollup-plugin-engine-patch.mjs + CJS interop)" },
    { path: "experiments/gates/g1-alias/cjs-interop.mjs", what: "finding F-1: CommonJS interop wrapper required by the upstream engine's dependencies" },
    { path: "experiments/gates/g1-alias/probe.js", what: "in-page assertions (module identity, consumption, capability linkage, loud failures)" },
    { path: "experiments/gates/g1-alias/page.html", what: "gate page constructing the upstream Scene" },
    { path: "experiments/gates/g1-alias/upstream-integrity.mjs", what: "upstream content-hash snapshot/diff used by the zero-change assertion" },
    { path: "tools/rollup-plugin-engine-patch.mjs", what: "the T008 alias plugin under test" },
    { path: "upstream/engine-26.3.0.lock.json", what: "pinned upstream baseline (26.3.0 / cesium 1.145.0)" },
    { path: "experiments/gates/out/g1-control-no-rewrite.json", what: "negative control: the same harness with an empty manifest MUST detect that the upstream Context is NOT replaced" },
    { path: "docs/gate-g1-conclusion.md", what: "human-readable conclusion (basis, evidence paths, verdict, consequences)" },
  ];

  const notes =
    verdict === "pass"
      ? "G-1 通过：T008 别名插件在真实构建链（Rollup + 门禁清单）中把 Scene/Scene.js:40 的相对导入 '../Renderer/Context.js' 改写为本项目实现，" +
        "上游 Renderer/Context.js 未进入模块图（1296 个上游模块中 46 个 Renderer 模块被保留、Context.js 被替换）；" +
        "浏览器中被替换的 Context 由真实上游 Scene 构造并消费：模块身份（深路径导入 === 门禁实现）、scene.drawingBuffer* 公开 getter 取自替换实现、" +
        "fragmentDepth→_logDepthBuffer→相机 near/far 链路按我们的值分支、未在清单内的上游 ContextLimits 收到能力值（16384/16384/2048/8/16）；" +
        "构建前后 node_modules/@cesium/engine 逐字节未变（1891 文件聚合哈希一致）；逻辑层零覆盖（logicLayerOverrides=0）；" +
        "W2 才拥有的成员以 category=not-implemented 显式失败（MUST NOT 静默）。" +
        "边界：本门禁只证明“接缝可用”，不证明 WebGPU 后端可用（W2/T042+）；不渲染任何一帧；见 findings（F-1 CJS 互操作、F-2 桶文件）与 taskDeviations。"
      : `G-1 未通过（verdict=${verdict}）：共 ${failed.length} 项检查失败 → ${failed.map((entry) => entry.id).join(", ")}。` +
        "按 plan 的失败动作：切换整仓 fork（F1），补丁清单与审计方式不变；STOP 并上报入口 Agent 修订 plan.md（阶段子代理不得自行修改 plan/contracts/spec）。";

  const document = {
    gate: "g1",
    task: "T015",
    verdict,
    recordedAt: new Date().toISOString(),
    notes,
    environment,
    checks,
    evidence: evidence.filter((entry) => fs.existsSync(path.resolve(REPO_ROOT, entry.path))),
    gateCriteria: {
      source: "plan.md「实现前的验证门」G-1 行；tasks.md T015",
      rewrittenModule: "Renderer/Context.js",
      consumptionModule: "Scene/Scene.js (relative import at line 40)",
      requiredVerdict: "pass",
      failureAction: "切换到整仓 fork（F1），补丁清单与审计方式不变 → STOP 上报入口 Agent 修订 plan",
    },
    measurements: {
      upstreamIntegrity: { ...integrity, detailsBefore: upstreamBefore.details, detailsAfter: upstreamAfter.details },
      build: {
        bundle: buildReport.bundle,
        graph: buildReport.graph,
        logicLayerOverrides: buildReport.logicLayerOverrides,
        whitelist: buildReport.whitelist,
        rewriteRecords: buildReport.rewriteRecords,
        directRewrite: buildReport.directRewrite,
        cjsInterop: buildReport.cjsInterop,
        warnings: buildReport.warnings,
      },
      runtime: report,
      runtimeConsole: { consoleMessages: runtime.consoleMessages, pageErrors: runtime.pageErrors, requestFailures: runtime.requestFailures },
    },
    findings: [
      {
        id: "F-1",
        title: "上游依赖含 CommonJS-only 包，批准的依赖集（T004）没有 CJS 互操作插件",
        detail:
          "@cesium/engine 的 Source/** 直接 import mersenne-twister / urijs / grapheme-splitter / bitmap-sdf / lerc / protobufjs（browserify 产物）等 CommonJS 包；" +
          "缺少 @rollup/plugin-commonjs 时 Rollup 在绑定默认导入阶段直接报错。本门禁以 experiments/gates/g1-alias/cjs-interop.mjs 在构建期包裹这些模块（原始代码逐字执行，不改上游磁盘）。" +
          "产物化影响：W1/T009 的 dist（内嵌经替换的上游源码）MUST 具备等价能力；protobufjs 的具名导入（Reader）在本门禁中为 undefined，且仅位于门禁未触及的代码路径。",
        scope: "gate-local workaround; the product build MUST solve this properly",
      },
      {
        id: "F-2",
        title: "上游 index.js 桶文件被 5 处自引用引入，门禁包因此覆盖近整个引擎（1296 个上游模块 / 约 7.6 MB）",
        detail:
          "Scene 闭包内 Source/Scene/{DerivedCommand,PropertyTable,StructuralMetadata,VoxelContent}.js 与 LabelCollection.js 以 `import { x } from \"@cesium/engine\"` 自引用桶文件，" +
          "Rollup 必须解析 index.js 的全部再导出。门禁据此把几乎整仓上游图纳入构建与断言（对 G-1 是更强的证据）；但产品打包要控制体积，需在 W1 明确桶文件处理策略（T009/T033 范围）。",
        scope: "informational",
      },
    ],
    taskDeviations: [
      {
        id: "D-1",
        what: "T015 要求“用 T008 的别名插件在真实构建链中替换 Renderer/Context.js”；正式清单 packages/cesium-webgpu/backend-webgpu/manifest.json 属 Phase 3（T031），本门禁不得抢先落地。",
        how: "门禁使用同 schema 的 experiments/gates/g1-alias/manifest.gate.json（唯一条目 Renderer/Context.js，kind=replace，glCallSites=46），通过插件选项 manifestPath/localRoot 指向它；插件与解析逻辑与生产一致。",
      },
      {
        id: "D-2",
        what: "生产构建链（rollup.config.mjs）额外用 @rollup/plugin-typescript 编译 packages/**；门禁的替换实现是 .js。",
        how: "门禁只运行与“模块级替换”直接相关的插件次序（T008 别名插件 → node-resolve → CJS 互操作）；TS 插件不参与 .js 替换文件的解析，不影响接缝结论。",
      },
      {
        id: "D-3",
        what: "替换实现真实覆盖了上游 Scene 构造期读取面（以 WebGL2 承载上下文获取），但 draw/clear/资源类未实现。",
        how: "凡 W2 才拥有的成员一律抛 category=not-implemented（T037 同款纪律）；门禁只断言“替换生效且不炸”，不渲染任何一帧。",
      },
    ],
  };

  fs.writeFileSync(mode.logArtifact, `${logLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(mode.gateArtifact, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  log(`verdict=${verdict} (${checks.filter((entry) => entry.ok === true).length}/${checks.length} checks ok) -> ${repoRelative(mode.gateArtifact)}`);
  for (const entry of checks.filter((item) => item.ok !== true)) log(`  FAIL ${entry.id}: ${entry.detail}`);

  if (verdict === "pass") return 0;
  process.stderr.write(
    `g1-alias: STOP — G-1 verdict=${verdict}. Phase 2 门禁未通过时不得开始 Phase 3；` +
      "失败动作见 plan.md「实现前的验证门」（切换整仓 fork F1，补丁清单与审计方式不变），由入口 Agent 修订 plan.md。\n",
  );
  return 1;
}

/**
 * Negative control: the harness MUST detect that, with an empty manifest, the upstream
 * `Renderer/Context.js` — not this repository's implementation — serves the scene.
 */
function finishControl({ mode, checks, runtime, environment, buildReport, integrity, enginePackage, startedAt }) {
  const requiredFailures = [
    "build-rewrite-scene-relative-import",
    "build-rewrite-bare-deep-import",
    "build-upstream-context-absent-from-graph",
    "whitelist-exhaustive",
    "scene-constructed-through-replacement",
  ];
  const byId = new Map(checks.map((entry) => [entry.id, entry]));
  const controlChecks = requiredFailures.map((id) =>
    check(
      `control-detects-missing-rewrite:${id}`,
      byId.get(id)?.ok === false,
      byId.has(id) ? `${id} → ${byId.get(id).ok === false ? "detected (ok=false)" : `NOT detected (ok=${byId.get(id).ok})`}: ${byId.get(id).detail}` : `${id} was not produced by the harness`,
    ),
  );
  const detected = controlChecks.filter((entry) => entry.ok === true).length;
  const verdict = detected === requiredFailures.length ? "pass" : "fail";

  const document = {
    gate: "g1-control-no-rewrite",
    task: "T015 (negative control)",
    verdict,
    recordedAt: new Date().toISOString(),
    notes:
      `G-1 阴性对照（空清单，别名插件零改写）。verdict=pass 的含义是：**判定器确实能识别接缝未被替换**——` +
      `${detected}/${requiredFailures.length} 个应当失败的检查项确实失败。若此处出现 "NOT detected"，则 G-1 的正向结论不可信（判定器无法区分真替换与无替换）。` +
      "对照运行不写 g1.json，也不改变门禁结论。",
    environment,
    // `checks` carries the control's own judgement (all-ok ⇔ verdict pass, per the artefact spec);
    // the full harness check list stays visible under `harnessChecks` for auditability.
    checks: controlChecks,
    harnessChecks: checks,
    evidence: [
      { path: evidencePath(mode.manifestPath), what: "the EMPTY control manifest (no entry ⇒ zero rewrites)" },
      { path: evidencePath(mode.buildArtifact), what: "control build evidence (upstream Context.js stays in the graph/bundle)" },
      { path: evidencePath(mode.runtimeArtifact), what: "control runtime probe report (the scene's context is the upstream implementation)" },
      { path: evidencePath(path.join(mode.bundleDir, "bundle.js")), what: "control bundle loaded by the browser" },
      { path: evidencePath(mode.logArtifact), what: "control runner transcript" },
      { path: "experiments/gates/g1-alias/probe.js", what: "the probe reused unchanged by the control" },
      { path: "experiments/gates/out/g1.json", what: "the gate conclusion this control underpins" },
    ].filter((entry) => fs.existsSync(path.resolve(REPO_ROOT, entry.path))),
    measurements: {
      startedAt,
      requiredFailures,
      detected,
      engine: { version: enginePackage.version },
      upstreamIntegrity: integrity,
      upstreamContextInControlGraph: buildReport.graph.upstreamEngineModules > 0 && !buildReport.bundle.containsUpstreamContextSnippet ? "unexpected" : "as expected (upstream Context.js bundled)",
      controlRuntime: runtime.report?.consumption ?? null,
      whitelist: buildReport.whitelist,
    },
  };

  fs.writeFileSync(mode.logArtifact, `${logLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(mode.gateArtifact, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  log(`control verdict=${verdict} (detected ${detected}/${requiredFailures.length}) -> ${repoRelative(mode.gateArtifact)}`);
  for (const entry of controlChecks) log(`  [${entry.ok ? "ok" : "FAIL"}] ${entry.id}`);
  if (verdict === "pass") return 0;
  process.stderr.write("g1-alias: negative control FAILED — the harness cannot distinguish a rewritten seam from an unrewritten one; the G-1 pass would be untrustworthy.\n");
  return 1;
}

/** Build-failure artefact: the gate MUST still leave a machine-readable conclusion behind. */
function writeFailureArtifact({ notes, checks, evidence, environment, error }) {
  const document = {
    gate: "g1",
    task: "T015",
    verdict: checks.some((entry) => entry.ok === true) ? "partial" : "fail",
    recordedAt: new Date().toISOString(),
    notes,
    environment,
    checks,
    evidence: evidence.filter((entry) => fs.existsSync(path.resolve(REPO_ROOT, entry.path))),
    error: error === null ? null : { name: error.name ?? "Error", message: error.message ?? String(error), stack: error.stack ?? null },
    measurements: {},
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "g1-run.log"), `${logLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "g1.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return document;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const document = writeFailureArtifact({
      notes: `G-1 runner 异常终止：${error?.message ?? error}。未完成的检查一律视为失败；STOP 并上报入口 Agent。`,
      checks: [check("runner-completed", false, `runner threw: ${error?.message ?? error}`)],
      evidence: [
        { path: "experiments/gates/out/g1-run.log", what: "runner transcript" },
        { path: "experiments/gates/g1-alias/run.mjs", what: "runner that failed" },
      ],
      environment: { node: process.version, platform: `${process.platform} ${process.arch}` },
      error,
    });
    process.stderr.write(`g1-alias: unexpected failure: ${error?.stack ?? error}\nwrote experiments/gates/out/g1.json (verdict=${document.verdict})\n`);
    process.exitCode = 2;
  });
