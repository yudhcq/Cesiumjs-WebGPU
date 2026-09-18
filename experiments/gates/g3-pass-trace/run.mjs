#!/usr/bin/env node
/**
 * G-3 gate runner — **通道状态机正确性 (H-3)** — tasks.md T020 + T021.
 *
 *   node experiments/gates/g3-pass-trace/run.mjs                 # record + partition + judge
 *   node experiments/gates/g3-pass-trace/run.mjs --skip-build    # reuse the last bundle
 *
 * T020: record the upstream original WebGL2 `clear`/`draw`/target-switch sequence of **one complete
 * frame** by wrapping platform APIs only (no upstream change, no `@private` semantics) → `out/g3-trace.json`.
 * T021: partition that trace by the derived pass identity
 * `(colorTargets, depthStencilTarget, sampleCount, viewport, scissorRect)` and assert
 *   (a) every target switch is covered (including the multisample resolve),
 *   (b) the partition boundaries correspond one-to-one with the `clear`/`draw` sequence,
 *   (c) no pass is left unclosed before `endFrame`,
 * → `out/g3.json` (schema: `experiments/gates/README.md`, validated by `tools/scripts/check-gate.mjs`).
 *
 * Exit codes: 0 → `verdict === "pass"`; 1 → the gate failed (STOP: report to the entry-point agent for a
 * plan revision); 2 → the runner itself could not run (artefact still written as `partial`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createStaticServer } from "../../../tools/scripts/serve.mjs";
import { compareSnapshots, snapshotUpstream } from "../g1-alias/upstream-integrity.mjs";
import { buildGateBundle, buildWorkerBundles } from "./build.mjs";
import { judgePartition, partitionTrace } from "./partition.mjs";

export const GATE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(GATE_DIR, "..", "..", "..");
export const OUT_DIR = path.join(REPO_ROOT, "experiments", "gates", "out");
const PAGE = path.join(GATE_DIR, "page.html");
const ENGINE_ROOT = path.join(REPO_ROOT, "node_modules", "@cesium", "engine");

const logLines = [];
function log(line) {
  const text = `[g3] ${line}`;
  logLines.push(text);
  if (!process.argv.includes("--quiet")) process.stdout.write(`${text}\n`);
}

function repoRelative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

function check(id, ok, detail, extra = {}) {
  return { id, ok: ok === true, detail, ...extra };
}

function parseArgs(argv) {
  const options = { channel: process.env.GATE_BROWSER_CHANNEL ?? "chrome", headed: false, timeoutMs: 240000, skipBuild: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(0, eq) : token;
    const value = eq >= 0 ? token.slice(eq + 1) : undefined;
    if (key === "--channel") options.channel = value ?? argv[++index];
    else if (key === "--headed") options.headed = true;
    else if (key === "--timeout") options.timeoutMs = Number(value ?? argv[++index]);
    else if (key === "--skip-build") options.skipBuild = true;
    else if (key === "--quiet") continue;
    else if (key === "--help" || key === "-h") {
      process.stdout.write("usage: node experiments/gates/g3-pass-trace/run.mjs [--channel chrome] [--headed] [--timeout ms] [--skip-build] [--quiet]\n");
      process.exit(0);
    } else throw new Error(`unknown argument "${token}"`);
  }
  return options;
}

/** Scan the gate's own recording code for upstream `@private` access (T020 forbids it). */
function privateMemberScan() {
  const files = [path.join(GATE_DIR, "platform-trace.js"), path.join(GATE_DIR, "frame-driver.js"), path.join(GATE_DIR, "entry.js")];
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    text.split(/\r?\n/).forEach((line, index) => {
      // Only the recording path is scanned; `scene.globe._surface` style reads would violate T020.
      const match = /\._(?!gl\b)[A-Za-z]\w*/.exec(line);
      if (match !== null && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")) hits.push({ file: repoRelative(file), line: index + 1, text: line.trim() });
    });
  }
  return hits;
}

async function record(options) {
  const server = createStaticServer({ root: REPO_ROOT });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/${repoRelative(PAGE)}`;
  log(`opening ${url}`);

  const runtime = { ran: false, report: null, error: null, pageErrors: [], consoleMessages: [], requestFailures: [], httpErrors: [], browserVersion: "none" };
  let browser = null;
  try {
    browser = await chromium.launch({ channel: options.channel, headless: !options.headed });
    runtime.browserVersion = browser.version();
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => runtime.pageErrors.push({ name: error.name ?? "Error", message: error.message ?? String(error) }));
    page.on("console", (message) => runtime.consoleMessages.push({ type: message.type(), text: message.text() }));
    page.on("requestfailed", (request) => runtime.requestFailures.push({ url: request.url(), failure: request.failure()?.errorText ?? null }));
    page.on("response", (response) => {
      if (response.status() >= 400) runtime.httpErrors.push({ url: response.url(), status: response.status() });
    });
    await page.goto(url, { waitUntil: "load", timeout: options.timeoutMs });
    await page.waitForFunction(() => globalThis.__g3 !== undefined && globalThis.__g3.ready === true, null, { timeout: options.timeoutMs });
    const collected = await page.evaluate(() => ({ report: globalThis.__g3.report, error: globalThis.__g3.error }));
    runtime.ran = true;
    runtime.report = collected.report;
    runtime.error = collected.error;
    log(`page finished (trace ops=${runtime.report?.trace?.ops?.length ?? 0}, error=${runtime.error === null ? "none" : runtime.error.message})`);
  } catch (error) {
    runtime.error = { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack ?? null };
    log(`runtime step failed: ${runtime.error.message}`);
  } finally {
    if (browser !== null) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
  return runtime;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  log(`start ${startedAt} (node ${process.version}, channel=${options.channel}, headed=${options.headed})`);

  const upstreamBefore = snapshotUpstream(ENGINE_ROOT);
  log(`upstream snapshot: ${upstreamBefore.fileCount} files, ${upstreamBefore.totalBytes} bytes, ${upstreamBefore.aggregateHash}`);

  const buildReport = options.skipBuild
    ? JSON.parse(fs.readFileSync(path.join(OUT_DIR, "g3-build.json"), "utf8"))
    : await buildGateBundle({ quiet: process.argv.includes("--quiet") });
  const workerReport = options.skipBuild ? null : await buildWorkerBundles({ quiet: process.argv.includes("--quiet") });

  const upstreamAfter = snapshotUpstream(ENGINE_ROOT);
  const integrity = compareSnapshots(upstreamBefore, upstreamAfter);
  log(`upstream unchanged after build: ${integrity.unchanged}`);
  const enginePackage = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, "package.json"), "utf8"));

  const runtime = await record(options);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "g3-runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`, "utf8");

  const ops = runtime.report?.trace?.ops ?? [];
  const traceArtifact = {
    gate: "g3-trace",
    task: "T020",
    recordedAt: new Date().toISOString(),
    notes:
      "T020 录制产物：上游原版 WebGL2 globe/地形路径的**单帧**平台调用序列（bindFramebuffer/draw*/clear*/viewport/scissor/blitFramebuffer 等）。" +
      "由 platform-trace.js 包装 WebGL2RenderingContext.prototype 采集，未修改上游实现、未读取上游 @private 成员。",
    environment: { node: process.version, browser: runtime.browserVersion, channel: options.channel, headless: !options.headed },
    scene: runtime.report?.scene ?? null,
    frame: runtime.report?.frame ?? null,
    summary: runtime.report?.trace?.summary ?? null,
    finalState: runtime.report?.trace?.finalState ?? null,
    ops,
  };
  fs.writeFileSync(path.join(OUT_DIR, "g3-trace.json"), `${JSON.stringify(traceArtifact, null, 2)}\n`, "utf8");
  log(`wrote out/g3-trace.json (${ops.length} operation(s))`);

  // ---- T021: partition + judgement ---------------------------------------------------------------
  const partition = partitionTrace(ops);
  const judged = ops.length > 0 ? judgePartition(ops, { frameEndSeq: ops[ops.length - 1]?.seq ?? null }) : { checks: [], measurements: { passCount: 0 } };
  const privateHits = privateMemberScan();

  const checks = buildReport.checks.map((entry) => ({ ...entry, phase: "build" }));
  if (workerReport !== null) {
    buildReport.workers = { dir: workerReport.dir, files: workerReport.files, sizes: workerReport.sizes };
    checks.push(...workerReport.checks.map((entry) => ({ ...entry, phase: "build" })));
  }
  checks.push(
    check("upstream-disk-unchanged", integrity.unchanged === true, `aggregate ${integrity.aggregateBefore} → ${integrity.aggregateAfter} over ${integrity.fileCountBefore} file(s); changed=[${integrity.changedDetails.join(", ")}]`, { phase: "build" }),
  );

  if (ops.length === 0) {
    checks.push(check("frame-recorded", false, `no platform operations were recorded: ${runtime.error?.message ?? "the page produced no trace"}`, { phase: "runtime" }));
  } else {
    const summary = runtime.report.trace.summary;
    const scene = runtime.report.scene ?? {};
    const consoleErrors = runtime.consoleMessages.filter((message) => message.type === "error");
    // The published ESM package ships no `Assets/**`; these three URLs therefore 404 in any browser run.
    const toleratedAssetPaths = ["Assets/Images/ion-credit.png", "Assets/approximateTerrainHeights.json", "Assets/IAU2006_XYS/"];
    const toleratedHttpErrors = runtime.httpErrors.filter((failure) => toleratedAssetPaths.some((path_) => failure.url.includes(path_)));
    const unexpectedHttpErrors = runtime.httpErrors.filter((failure) => !toleratedAssetPaths.some((path_) => failure.url.includes(path_)));
    checks.push(
      check("frame-recorded", runtime.error === null && summary.drawCount > 0 && summary.clearCount > 0 && summary.triangleCount > 0, `${ops.length} platform operation(s): ${summary.drawCount} draw, ${summary.clearCount} clear, ${summary.blitCount} blit, ${summary.bindFramebufferCount} bindFramebuffer, ${summary.viewportCount} viewport, ${summary.triangleCount} triangle(s), ${summary.programs} program(s)`, { phase: "runtime" }),
      check("upstream-webgl2-path-confirmed", scene.contextConstructor === "Context" && scene.webgl2 === true && runtime.report.bundle.upstreamContextIsPresent === true, `context constructor="${scene.contextConstructor}", webgl2=${scene.webgl2}, bundle carries the upstream Context=${runtime.report.bundle.upstreamContextIsPresent}, GL version=${scene.version}, drawing buffer=${scene.drawingBufferWidth}x${scene.drawingBufferHeight}, MSAA supported=${scene.msaaSupported} (samples=${scene.msaaSamples}, max=${scene.maximumSamples}), depthTexture=${scene.depthTexture}`, { phase: "runtime" }),
      check("tracer-uses-platform-apis-only", privateHits.length === 0, `upstream @private-style member access in the recording code (excluding the GL context handle): ${privateHits.length}${privateHits.length > 0 ? ` → ${privateHits.map((hit) => `${hit.file}:${hit.line} ${hit.text}`).join(" | ")}` : ""}`, { phase: "runtime" }),
      check("scene-path-is-the-terrain-path", scene.terrainProvider !== null && typeof scene.terrainProvider === "string" && summary.triangleCount > 0, `terrain provider=${scene.terrainProvider}, globe tiles loaded before the recorded frame=${scene.globeTilesLoaded}, triangles drawn=${summary.triangleCount} (Globe/QuadtreePrimitive/GlobeSurfaceTile path)`, { phase: "runtime" }),
      check("no-uncaught-page-errors", runtime.pageErrors.every((error) => error.message === "RequestErrorEvent") && (runtime.pageErrors.length === 0) === (toleratedHttpErrors.length === 0), `${runtime.pageErrors.length} uncaught page error(s): ${JSON.stringify(runtime.pageErrors.map((error) => error.message))} — ` +
        `the only tolerated shape is Cesium's own \`RequestErrorEvent\` raised for a MISSING PACKAGE ASSET, and it is tolerated only when the corresponding HTTP 404 is on the allow-list (${toleratedHttpErrors.length} tolerated 404(s) in this run)`, { phase: "runtime" }),
      check("no-console-errors", consoleErrors.length === toleratedHttpErrors.length && consoleErrors.every((message) => /Failed to load resource/.test(message.text)), `${runtime.consoleMessages.length} console message(s); ${consoleErrors.length} error(s) for ${toleratedHttpErrors.length} tolerated missing-asset 404(s); texts=${JSON.stringify(consoleErrors.map((message) => message.text))}`, { phase: "runtime" }),
      check(
        "worker-requests-all-served",
        runtime.requestFailures.filter((failure) => /\/Workers\//.test(failure.url)).length === 0 && runtime.httpErrors.filter((failure) => /\/Workers\//.test(failure.url)).length === 0,
        `failed worker request(s): ${JSON.stringify([...runtime.requestFailures.filter((failure) => /\/Workers\//.test(failure.url)).map((failure) => failure.url), ...runtime.httpErrors.filter((failure) => /\/Workers\//.test(failure.url)).map((failure) => `${failure.url} (HTTP ${failure.status})`)])}; ` +
          `all HTTP error(s) in this run: ${JSON.stringify(runtime.httpErrors.map((failure) => `${failure.url} (HTTP ${failure.status})`))} — ` +
          `the gate builds module-worker bundles of the upstream worker sources into its own base directory (${buildReport.workers?.files?.join(", ") ?? "n/a"}); ` +
          `a worker the page requests but the gate did not build MUST fail loudly instead of silently degrading the terrain path`,
        { phase: "runtime" },
      ),
      check(
        "no-unexpected-http-errors",
        unexpectedHttpErrors.length === 0,
        `${runtime.httpErrors.length} HTTP error response(s); ${toleratedHttpErrors.length} tolerated missing-package-asset 404(s) ` +
          `[${toleratedHttpErrors.map((failure) => failure.url.split("/Assets/")[1]).join(", ")}]; unexpected=${JSON.stringify(unexpectedHttpErrors.map((failure) => `${failure.url} (HTTP ${failure.status})`))}. ` +
          `Rationale: the published ESM package ships only Source/ (no Assets/**, no Workers/**), so these three asset URLs cannot be served by any gate-local means; ` +
          `they are unrelated to the terrain render path (no imagery, no GroundPrimitive, sun/moon hidden) and Cesium treats them as non-fatal. Any OTHER HTTP error is a hard failure.`,
        { phase: "runtime" },
      ),
      check("environment-recorded", typeof runtime.browserVersion === "string" && scene.maximumSamples > 0, `node=${process.version}, browser=${runtime.browserVersion} (headless=${!options.headed}), engine ${enginePackage.version}, GL ${scene.version}`, { phase: "runtime" }),
    );
    for (const entry of judged.checks) checks.push({ ...entry, phase: "runtime" });
  }

  const failed = checks.filter((entry) => entry.ok !== true);
  const runtimeRan = runtime.ran && ops.length > 0;
  const verdict = failed.length === 0 ? "pass" : failed.some((entry) => entry.phase === "build") || runtimeRan ? "fail" : "partial";

  const evidence = [
    { path: "experiments/gates/out/g3-trace.json", what: "T020 recording: the upstream WebGL2 platform call sequence of one complete frame (bindFramebuffer/draw/clear/viewport/scissor/blitFramebuffer)" },
    { path: "experiments/gates/out/g3-runtime.json", what: "raw page report (scene facts, frame timing, console/page errors, tracer summary)" },
    { path: "experiments/gates/out/g3-build.json", what: "build evidence: upstream modules in the graph, no replacement applied, CJS plugin, warnings" },
    { path: "experiments/gates/out/g3-run.log", what: "runner transcript of this execution" },
    { path: "experiments/gates/g3-pass-trace/platform-trace.js", what: "the platform-API tracer (wraps WebGL2RenderingContext.prototype only)" },
    { path: "experiments/gates/g3-pass-trace/partition.mjs", what: "T021 derived-pass partition + judgement" },
    { path: "experiments/gates/g3-pass-trace/partition.test.mjs", what: "T021 unit test (positive + negative synthetic traces)" },
    { path: "experiments/gates/g3-pass-trace/frame-driver.js", what: "page driver: one complete frame of the upstream globe/terrain path" },
    { path: "experiments/gates/g1-alias/upstream-integrity.mjs", what: "upstream content-hash snapshot/diff reused from G-1 (sanctioned reuse)" },
    { path: "docs/gate-g3-conclusion.md", what: "human-readable conclusion (basis, evidence paths, verdict, consequences)" },
  ];

  const document = {
    gate: "g3",
    task: "T020/T021",
    verdict,
    recordedAt: new Date().toISOString(),
    notes:
      (verdict === "pass"
        ? "G-3 通过：上游原版 WebGL2 globe/地形路径的单帧平台调用序列被完整录制（仅包装 WebGL2RenderingContext.prototype，未改上游、未读 @private），" +
          `并按派生式通道身份 (colorTargets, depthStencilTarget, sampleCount, viewport, scissorRect) 分区：${judged.measurements.passCount} 个通道、${judged.measurements.switchCount} 次目标切换（含 ${judged.measurements.resolveBlitCount} 次多采样解析 blit）、` +
          `${judged.measurements.drawCount} 次绘制 / ${judged.measurements.clearCount} 次清除；全部目标切换都恰好落在通道边界上，通道边界与 clear/draw 序列一一对应，帧末通道落在呈现目标（默认 framebuffer）上，endFrame 只需闭合一个通道。` +
          "身份只使用平台可见状态（Pass/PassState/程序/uniform/RenderState 的变化不构成边界），与 research §5.2 一致。" +
          "边界：本门禁只录制**上游原始** WebGL2 路径（不涉及我们的后端）；真机像素/跨后端一致性属 G-6。"
        : `G-3 未通过（verdict=${verdict}）：共 ${failed.length} 项检查失败 → ${failed.map((entry) => entry.id).join(", ")}。` +
          "按 plan 的失败动作：在后端层内部引入显式通道提示（不改逻辑层），或在 endFrame 前强制拆通道 → STOP 并上报入口 Agent 修订 plan.md（阶段子代理不得自行修改 plan/contracts/spec）。"),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      engine: { packageName: enginePackage.name, version: enginePackage.version, lock: "upstream/engine-26.3.0.lock.json" },
      browser: { channel: options.channel, version: runtime.browserVersion, headless: !options.headed, launchArgs: [], note: "zero launch flags; WebGL2 via the upstream Context" },
      webgl: runtime.report?.scene ?? null,
      adapter: null,
      preferredFormat: null,
    },
    checks,
    evidence: evidence.filter((entry) => fs.existsSync(path.resolve(REPO_ROOT, entry.path))),
    gateCriteria: {
      source: "plan.md「实现前的验证门」G-3 行；tasks.md T020/T021",
      requirements: [
        "T020: 通过包装平台 API 录制上游原版 WebGL2 单帧 clear/draw 与目标切换序列（不改上游、不改 @private）",
        "T021(a): 全部目标切换序列都被覆盖（含多采样解析的目标切换）",
        "T021(b): 分区边界与 clear/draw 序列一一对应",
        "T021(c): endFrame 前无未闭合通道",
      ],
      requiredVerdict: "pass",
      failureAction: "在后端层内部引入显式通道提示（不改逻辑层），或在 endFrame 前强制拆通道 → STOP 上报入口 Agent 修订 plan",
    },
    measurements: {
      upstreamIntegrity: { ...integrity, detailsBefore: upstreamBefore.details, detailsAfter: upstreamAfter.details },
      build: { checks: buildReport.checks, graph: buildReport.graph, bundle: buildReport.bundle },
      scene: runtime.report?.scene ?? null,
      frame: runtime.report?.frame ?? null,
      traceSummary: runtime.report?.trace?.summary ?? null,
      partition: judged.measurements,
      passKeys: partition.passes.map((pass) => ({ index: pass.index, key: pass.key, drew: pass.drawOps, cleared: pass.clearOps })),
      privateMemberHits: privateHits,
      consoleErrors: runtime.consoleMessages.filter((message) => message.type === "error").map((message) => message.text),
    },
    findings: [
      {
        id: "F-1",
        title: "录制用的是上游默认 EllipsoidTerrainProvider（零网络），地形瓦片数据集属 W5/T085",
        detail:
          "T020 要求录制地形路径的完整帧。MVP 的固定地形数据集（T085）尚未落盘，且门禁 MUST NOT 依赖网络；因此门禁使用上游**默认**的 `EllipsoidTerrainProvider`，" +
          "它走的是同一条 Globe → QuadtreePrimitive → GlobeSurfaceTile → GlobeSurfaceShaderSet 路径与同一套 GlobeVS/GlobeFS 着色器，但不产生多瓦片层级。" +
          "本门禁的通道身份只由平台可见的 (colorTargets, depthStencilTarget, sampleCount, viewport, scissorRect) 决定，因此**同目标的额外瓦片只会落在同一通道内**；" +
          "该推断在 T021(b) 中由「同一通道内多次 draw」的实测（见 measurements.partition.passesWithMultipleDraws）支持。真实瓦片树的通道覆盖仍应在 T085 之后重跑本门禁。",
        followUp: ["T085（数据集落盘）", "T098b（切片 B 全量验证时重跑）"],
      },
      {
        id: "F-2",
        title: "clear 与通道起始的关系（T044 的 loadOp 依据）",
        detail:
          "T021 的 `clears-are-first-in-their-pass` 检查记录每个通道内首次操作是否为 clear —— 这是 research §5.1「首次操作走 loadOp:\"clear\"，其余走 clearBuffer 兜底」的实测依据。",
        followUp: ["T044（Context.clear 的 loadOp/clearBuffer 取舍）", "T046（pass-encoder）"],
      },
      {
        id: "F-3",
        title: "本门禁的边界",
        detail:
          "门禁只录制**上游原始** WebGL2 路径（这正是 T020 的要求），不渲染我们的后端、不做跨后端像素比较（属 G-6），也不建立 WebGPU 通道——它回答的是「派生式身份是否足以覆盖上游的目标切换序列」。",
        followUp: ["T046（以本门禁的 trace 做录制-回放）", "G-6"],
      },
    ],
    deviations: [
      {
        id: "D-1",
        what: "T020 的失败动作/通过判据以「地形（terrain）」为对象，而可用的地形数据尚未落盘（T085）。",
        how: "使用上游默认 EllipsoidTerrainProvider（零网络、确定性），并在 F-1 中登记覆盖边界与后续重跑义务；不修改 tasks/plan。",
      },
      {
        id: "D-2",
        what: "T020 明确「MUST NOT 修改上游实现」→ 本门禁的构建**不应用替换清单**（不使用 T008 别名插件），因此 bundle 里是上游原版 Context/Scene。",
        how: "build.mjs 断言图中含上游 Renderer/Context.js 与 Scene/Scene.js、且没有任何门禁本地 Renderer 替换；F-3 说明该选择与 T020 一致。",
      },
    ],
  };

  fs.writeFileSync(path.join(OUT_DIR, "g3-run.log"), `${logLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "g3.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  log(`verdict=${verdict} (${checks.filter((entry) => entry.ok === true).length}/${checks.length} checks ok) -> experiments/gates/out/g3.json`);
  for (const entry of failed) log(`  FAIL ${entry.id}: ${entry.detail}`);

  if (verdict === "pass") return 0;
  process.stderr.write(
    `g3-pass-trace: STOP — G-3 verdict=${verdict}. Phase 2 门禁未通过时不得开始 Phase 3；` +
      "失败动作见 plan.md「实现前的验证门」（后端层内部引入显式通道提示，或 endFrame 前强制拆通道），由入口 Agent 修订 plan.md。\n",
  );
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "g3-run.log"), `${logLines.join("\n")}\n`, "utf8");
    fs.writeFileSync(
      path.join(OUT_DIR, "g3.json"),
      `${JSON.stringify(
        {
          gate: "g3",
          task: "T020/T021",
          verdict: "partial",
          recordedAt: new Date().toISOString(),
          notes: `G-3 runner 异常终止：${error?.message ?? error}。未完成的检查一律视为失败；STOP 并上报入口 Agent。`,
          environment: { node: process.version, platform: `${process.platform} ${process.arch}` },
          checks: [check("runner-completed", false, `runner threw: ${error?.message ?? error}`)],
          evidence: [{ path: "experiments/gates/g3-pass-trace/run.mjs", what: "runner that failed" }],
          error: { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack ?? null },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    process.stderr.write(`g3-pass-trace: unexpected failure: ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  });
