#!/usr/bin/env node
/**
 * G-2 gate runner — **设备交接与同步构造 (H-2)** — tasks.md T016/T017.
 *
 *   node experiments/gates/g2-handoff/run.mjs                        # the gate: writes out/g2.json
 *   node experiments/gates/g2-handoff/run.mjs --control=no-handoff   # negative control
 *
 * Sequence (everything is measured, nothing is assumed):
 *   1. snapshot every byte of the installed `@cesium/engine` package;
 *   2. build **two** real bundles (`build.mjs`): the gate manifest (Context replaced) and an empty
 *      manifest (upstream Context = the WebGL2 run);
 *   3. snapshot the upstream package again and assert the build changed nothing on disk;
 *   4. **two independent browser runs** (separate browser instances, separate page loads, one backend
 *      each — 原则 II: never both backends in one session, and nothing is compared across them):
 *      `webgpu` = prefetch adapter/device → handoff slot → synchronous `new Scene()`;
 *      `webgl2`  = the upstream `Context` serves the scene;
 *   5. judge every check and write `experiments/gates/out/g2.json` (schema:
 *      `experiments/gates/README.md`, validated by `tools/scripts/check-gate.mjs`).
 *
 * **Negative control** (`--control=no-handoff`): the same bundle, but the device is prefetched and
 * **not** installed. The replacement `Context` MUST fail loudly (`category = "device-handoff/missing"`)
 * and the gate's handoff-dependent checks MUST go false — a gate that cannot fail proves nothing.
 *
 * Exit codes: 0 → `verdict === "pass"`; 1 → the gate failed (STOP: report to the entry-point agent for
 * a plan revision); 2 → the runner itself could not run (artefact still written as `partial`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createStaticServer } from "../../../tools/scripts/serve.mjs";
import { OUT_DIR, REPO_ROOT, buildBoth } from "./build.mjs";
import { compareSnapshots, snapshotUpstream } from "../g1-alias/upstream-integrity.mjs";

const GATE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(GATE_DIR, "page.html");
const ENGINE_ROOT = path.join(REPO_ROOT, "node_modules", "@cesium", "engine");

const logLines = [];
function log(line) {
  const text = `[g2] ${line}`;
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
  const options = { channel: process.env.GATE_BROWSER_CHANNEL ?? "chrome", headed: false, timeoutMs: 240000, skipBuild: false, control: null };
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
      process.stdout.write("usage: node experiments/gates/g2-handoff/run.mjs [--channel chrome] [--headed] [--timeout ms] [--skip-build] [--control=no-handoff] [--quiet]\n");
      process.exit(0);
    } else throw new Error(`unknown argument "${token}"`);
  }
  if (options.control !== null && options.control !== "no-handoff") throw new Error(`unknown control "${options.control}" (only "no-handoff")`);
  return options;
}

/** One independent browser run: fresh browser instance, fresh page, one backend. */
async function runProbe({ label, bundleFile, backend, handoff, channel, headed, timeoutMs, server, port }) {
  const browser = await chromium.launch({ channel, headless: !headed });
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => pageErrors.push({ name: error.name ?? "Error", message: error.message ?? String(error), stack: error.stack ?? null }));
  page.on("requestfailed", (request) => requestFailures.push({ url: request.url(), failure: request.failure()?.errorText ?? null }));

  const query = [
    // Absolute path from the static-server root: the page imports it as a module specifier.
    `bundle=/${repoRelative(bundleFile)}`,
    `backend=${backend}`,
    `handoff=${handoff}`,
  ].join("&");
  const url = `http://127.0.0.1:${port}/${repoRelative(PAGE)}?${query}`;
  log(`[${label}] ${url}`);

  const run = {
    label,
    backend,
    handoff,
    browserVersion: browser.version(),
    pageId: `${label}-${Date.now().toString(36)}`,
    consoleMessages,
    pageErrors,
    requestFailures,
    report: null,
    error: null,
  };
  try {
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForFunction(() => globalThis.__g2 !== undefined && globalThis.__g2.ready === true, null, { timeout: timeoutMs });
    const collected = await page.evaluate(() => ({ report: globalThis.__g2.report, error: globalThis.__g2.error }));
    run.report = collected.report;
    run.error = collected.error;
    log(`[${label}] probe finished (report=${run.report !== null}, error=${run.error === null ? "none" : run.error.message})`);
  } catch (error) {
    run.error = { name: error.name ?? "Error", message: error.message ?? String(error), stack: error.stack ?? null };
    log(`[${label}] runtime step failed: ${run.error.message}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  return run;
}

const CAPABILITY_READ_MUST_HAPPEN_DURING_CONSTRUCTION = ["fragmentDepth", "depthTexture", "drawingBufferWidth", "drawingBufferHeight"];

function sameValue(a, b) {
  return a === b;
}

/** Judge the whole gate from the two probe reports + the two build reports + the integrity diff. */
export function judge({ webgpu, webgl2, gateBuild, webgl2Build, integrity, enginePackage }) {
  const checks = [];
  for (const report of [gateBuild, webgl2Build]) {
    for (const entry of report.checks) checks.push({ ...entry, id: `${report.label}-${entry.id}`, phase: "build" });
  }
  checks.push(
    check(
      "upstream-disk-unchanged",
      integrity.unchanged === true,
      `aggregate ${integrity.aggregateBefore} → ${integrity.aggregateAfter}; files ${integrity.fileCountBefore} → ${integrity.fileCountAfter}; ` +
        `changed=[${integrity.changedDetails.join(", ")}] (both bundles are produced by build-time rewrites; node_modules is never edited)`,
      { phase: "build" },
    ),
  );

  const gpu = webgpu.report;
  const gl = webgl2.report;

  // ---------------------------------------------------------------------------------------------
  // WebGPU run
  // ---------------------------------------------------------------------------------------------
  if (gpu === null) {
    checks.push(check("webgpu-run-produced-report", false, `the WebGPU page probe produced no report: ${webgpu.error?.message ?? "unknown reason"}`, { phase: "runtime" }));
  } else {
    const prefetch = gpu.prefetch ?? null;
    const construction = gpu.construction ?? null;
    const scene = gpu.scene ?? null;
    const snapshot = gpu.capabilities?.stubSnapshot ?? null;
    const limitsSnapshot = gpu.capabilities?.stubLimitsSnapshot ?? null;
    const composition = gpu.capabilities?.composition ?? null;
    const declaredDefaults = gpu.capabilities?.declaredDefaults ?? {};
    const readsDuring = gpu.reads?.duringConstruction ?? [];
    const limitsDuring = gpu.contextLimits?.logicLayerReadsDuringConstruction ?? [];
    const limitsWrites = gpu.contextLimits?.writesDuringConstruction ?? [];
    const audit = gpu.handoffAudit ?? { audit: [] };
    const glRequestsDuringConstruction = gpu.probes?.glRequestsDuringConstruction ?? [];
    const loudFailures = gpu.loudFailures ?? [];

    checks.push(
      check("webgpu-run-produced-report", gpu.errors.length === 0 && construction !== null, `probe finished at ${gpu.finishedAt}; probe-level errors=${gpu.errors.length}`, { phase: "runtime" }),
      check(
        "webgpu-prefetch-adapter-and-device",
        prefetch !== null && prefetch.deviceRequests === 1 && prefetch.deviceIsObject === true && prefetch.adapterInfo?.vendor != null && prefetch.deviceLostHandled === true,
        prefetch === null
          ? "no prefetch was performed"
          : `adapter.info=${JSON.stringify(prefetch.adapterInfo)}, isFallbackAdapter=${prefetch.isFallbackAdapter}, features=${JSON.stringify(prefetch.features)}, ` +
            `requestDevice() calls=${prefetch.deviceRequests}, device.lost handled=${prefetch.deviceLostHandled}, ` +
            `limits(selected)=${JSON.stringify({ maxTextureDimension2D: prefetch.limits.maxTextureDimension2D, maxTextureDimension3D: prefetch.limits.maxTextureDimension3D, maxVertexAttributes: prefetch.limits.maxVertexAttributes, maxColorAttachments: prefetch.limits.maxColorAttachments, maxInterStageShaderVariables: prefetch.limits.maxInterStageShaderVariables })}`,
        { phase: "runtime" },
      ),
      check(
        "handoff-slot-contract",
        gpu.probes?.doubleInstall?.threw === true &&
          gpu.probes?.doubleInstall?.category === "device-handoff/already-installed" &&
          gpu.probes?.peekAfterConstruction === "empty" &&
          gpu.probes?.secondTake === "empty" &&
          audit.installedAtTick === gpu.handoff?.installTick &&
          audit.audit.filter((entry) => entry.op === "take").length === 1,
        `install() twice → threw=${gpu.probes?.doubleInstall?.threw} category=${gpu.probes?.doubleInstall?.category}; ` +
          `peek() after construction=${gpu.probes?.peekAfterConstruction}; a second take()=${gpu.probes?.secondTake}; take() calls in the audit=${audit.audit.filter((entry) => entry.op === "take").length}`,
        { phase: "runtime" },
      ),
      check(
        "scene-constructed-on-webgpu",
        construction !== null &&
          construction.threw === false &&
          construction.contextIsStub === true &&
          construction.contextIdentity === true &&
          construction.contextIsReplaced === true &&
          construction.deviceIdentity === true &&
          construction.adapterIdentity === true &&
          scene?.canvasIsGateCanvas === true,
        construction === null
          ? "no construction was attempted"
          : `new Scene({canvas}) threw=${construction.threw} (${construction.error?.message ?? "no error"}); context constructor="${construction.contextConstructorName}", ` +
            `is the gate stub=${construction.contextIsStub}, deep-import identity=${construction.contextIdentity}, bundle reports replacement=${construction.contextIsReplaced}, ` +
            `context.device === prefetched device=${construction.deviceIdentity}, context.adapter === prefetched adapter=${construction.adapterIdentity}; scene.canvas is the gate canvas=${scene?.canvasIsGateCanvas}`,
        { phase: "runtime" },
      ),
      check(
        "device-handoff-is-synchronous",
        typeof gpu.probes?.takeStack === "string" &&
          gpu.probes.takeStack.includes("G2HandoffContext") &&
          gpu.probes.takeStack.includes("Scene") &&
          gpu.capabilities?.publishedAtTick > construction?.startTick &&
          gpu.capabilities?.publishedAtTick < construction?.endTick,
        `take() was called from the replacement's constructor: stack contains "G2HandoffContext"=${gpu.probes?.takeStack?.includes("G2HandoffContext")}, ` +
          `contains "Scene"=${gpu.probes?.takeStack?.includes("Scene")}; capability publication tick=${gpu.capabilities?.publishedAtTick} inside the construction window ` +
          `(${construction?.startTick}..${construction?.endTick}); install tick=${gpu.handoff?.installTick} < construction start`,
        { phase: "runtime" },
      ),
      check(
        "capabilities-and-limits-synchronously-readable",
        snapshot !== null &&
          limitsSnapshot !== null &&
          CAPABILITY_READ_MUST_HAPPEN_DURING_CONSTRUCTION.every((name) => readsDuring.some((entry) => entry.name === name)) &&
          // every capability read inside the construction window already returned the FINAL value:
          readsDuring.every((entry) => snapshot[entry.name] === undefined || sameValue(entry.value, snapshot[entry.name])) &&
          // and nothing changed after construction:
          JSON.stringify(gpu.capabilities?.stubSnapshotAfter) === JSON.stringify(snapshot) &&
          // ContextLimits: every member published inside the construction window, nothing read before it,
          // and every read the upstream logic layer made during construction already saw the final value:
          limitsWrites.length === 23 &&
          limitsWrites.every((entry) => /^_/.test(entry.member)) &&
          limitsWrites.every((entry) => limitsSnapshot[entry.member.slice(1)] === undefined || sameValue(entry.value, limitsSnapshot[entry.member.slice(1)])) &&
          limitsDuring.every((entry) => limitsSnapshot[entry.member.slice(1)] === undefined || sameValue(entry.value, limitsSnapshot[entry.member.slice(1)])),
        snapshot === null
          ? "the replacement published no capability snapshot"
          : `capability reads during construction: ${[...new Set(readsDuring.map((entry) => entry.name))].join(", ") || "none"}; ` +
            `every one already equalled the final published value; ` +
            `ContextLimits: ${limitsWrites.length} backing member(s) written inside the construction window, ` +
            `${limitsDuring.length} read(s) by the upstream logic layer during construction ` +
            `(${[...new Set(limitsDuring.map((entry) => entry.member))].slice(0, 8).join(", ")}${limitsDuring.length > 8 ? ", …" : ""}), all already final; ` +
            `snapshot unchanged after construction=${JSON.stringify(gpu.capabilities?.stubSnapshotAfter) === JSON.stringify(snapshot)}`,
        { phase: "runtime" },
      ),
      check(
        "capability-values-match-research-table",
        snapshot !== null &&
          composition !== null &&
          Object.keys(declaredDefaults).every((name) => sameValue(snapshot[name], composition.flags[name])) &&
          limitsSnapshot !== null &&
          limitsSnapshot.maximumSamples >= 4 &&
          limitsSnapshot.maximumTextureSize === prefetch?.limits?.maxTextureDimension2D &&
          limitsSnapshot.maximum3DTextureSize === prefetch?.limits?.maxTextureDimension3D &&
          limitsSnapshot.maximumVertexAttributes === prefetch?.limits?.maxVertexAttributes &&
          limitsSnapshot.maximumColorAttachments === prefetch?.limits?.maxColorAttachments &&
          limitsSnapshot.maximumVaryingVectors === prefetch?.limits?.maxInterStageShaderVariables,
        snapshot === null
          ? "no capability snapshot"
          : `flags=${JSON.stringify(snapshot)}; every flag equals the value composed from this adapter's limits/features ` +
            `(derived flags such as colorBufferFloat/textureFloatLinear come from adapter.features, not from the static fallback); ` +
            `maximumSamples=${limitsSnapshot?.maximumSamples} (>= 4); maximumTextureSize=${limitsSnapshot?.maximumTextureSize} ← adapter.limits.maxTextureDimension2D=${prefetch?.limits?.maxTextureDimension2D}; ` +
            `maximum3DTextureSize=${limitsSnapshot?.maximum3DTextureSize}; maximumVertexAttributes=${limitsSnapshot?.maximumVertexAttributes}; maximumColorAttachments=${limitsSnapshot?.maximumColorAttachments}; ` +
            `maximumVaryingVectors=${limitsSnapshot?.maximumVaryingVectors} ← maxInterStageShaderVariables=${prefetch?.limits?.maxInterStageShaderVariables}`,
        { phase: "runtime" },
      ),
      check(
        "false-capabilities-declared-with-branches",
        snapshot !== null &&
          composition !== null &&
          composition.falseFlags.length > 0 &&
          composition.falseFlags.every((name) => sameValue(snapshot[name], false) && typeof composition.unimplementedBranches[name] === "string" && composition.unimplementedBranches[name].length > 0),
        snapshot === null
          ? "no capability snapshot"
          : `false capabilities: [${composition?.falseFlags?.join(", ") ?? "?"}] — each has a declared unimplemented branch and notes; ` +
            `depthTexture=false carries the slice-A declaration (flips to true in slice B / T098a)`,
        { phase: "runtime" },
      ),
      check(
        "construction-hit-no-not-implemented-branch",
        Array.isArray(gpu.probes?.notImplementedAfterConstruction) && gpu.probes.notImplementedAfterConstruction.length === 0,
        `not-implemented hits recorded up to the end of construction: ${JSON.stringify(gpu.probes?.notImplementedAfterConstruction ?? null)} ` +
          "(the construction path MUST NOT reach a member the W2 backend owns; the post-construction loud-failure probes are separate)",
        { phase: "runtime" },
      ),
      check(
        "logic-layer-branches-match-research-4",
        construction?.threw === false &&
          scene !== null &&
          snapshot !== null &&
          gpu.branches.length >= 6 &&
          (snapshot.fragmentDepth !== true || (scene.logarithmicDepthBuffer === true && scene.cameraNear === 0.1 && scene.cameraFar === 10000000000)) &&
          (snapshot.depthTexture !== false || glRequestsDuringConstruction.length === 0) &&
          (snapshot.msaa !== true || scene.msaaSupported === true) &&
          snapshot.s3tc === false &&
          snapshot.bc7 === false &&
          gpu.probes?.contextLimitsAfterConstruction?.maximumTextureFilterAnisotropy === 1,
        scene === null
          ? "no scene to observe"
          : `fragmentDepth=${snapshot?.fragmentDepth} → scene.logarithmicDepthBuffer=${scene.logarithmicDepthBuffer}, camera near/far=${scene.cameraNear}/${scene.cameraFar} (Scene.js:195 + :723-726); ` +
            `depthTexture=${snapshot?.depthTexture} → WebGL context requests during construction=${glRequestsDuringConstruction.length} (View.js:46 consequence: GlobeDepth is not created ⇒ nothing needs GL); ` +
            `msaa=${snapshot?.msaa} → scene.msaaSupported=${scene.msaaSupported} (Scene.js:1721); compressed families s3tc..bc7=${snapshot?.s3tc},${snapshot?.pvrtc},${snapshot?.astc},${snapshot?.etc},${snapshot?.etc1},${snapshot?.bc7} (Scene.js:1771-1781); ` +
            `ContextLimits.maximumTextureFilterAnisotropy=${gpu.probes?.contextLimitsAfterConstruction?.maximumTextureFilterAnisotropy}; recorded branches=${gpu.branches.length}`,
        { phase: "runtime" },
      ),
      check(
        "context-limits-written-to-kept-upstream-module",
        gpu.probes?.contextLimitsAfterConstruction?.maximumTextureSize === prefetch?.limits?.maxTextureDimension2D &&
          gpu.probes?.contextLimitsAfterConstruction?.maximumSamples === 4 &&
          gpu.probes?.contextLimitsAfterConstruction?.maximum3DTextureSize === prefetch?.limits?.maxTextureDimension3D &&
          gpu.probes?.contextLimitsAfterConstruction?.maximumDrawBuffers === prefetch?.limits?.maxColorAttachments &&
          gpu.probes?.contextLimitsAfterConstruction?.highpFloatSupported === true &&
          glRequestsDuringConstruction.length === 0,
        `the KEPT upstream module Renderer/ContextLimits.js (read through its public getters) holds: ` +
          `${JSON.stringify(gpu.probes?.contextLimitsAfterConstruction ?? null)} — derived from the WebGPU device, with 0 WebGL contexts acquired, ` +
          `so the values cannot have come from GL`,
        { phase: "runtime" },
      ),
      check(
        "gate-does-not-render-a-frame",
        loudFailures.length === 6 && loudFailures.every((entry) => entry.threw === true && entry.category === "not-implemented"),
        `loud-failure probes: ${loudFailures.map((entry) => `${entry.capability}→${entry.category ?? "no-throw"}`).join(", ")} ` +
          "(this gate claims device handoff + synchronous construction only; rendering is W2/T044 and MUST NOT be silently stubbed)",
        { phase: "runtime" },
      ),
      check(
        "protobufjs-named-export-resolved-at-runtime",
        gpu.probes?.protobufReaderProbe?.createIsFunction === true && gpu.probes?.protobufReaderProbe?.readerType === "function",
        `protobufjs namespace probe (F-1 condition 5): Reader=${gpu.probes?.protobufReaderProbe?.readerType}, Reader.create is a function=${gpu.probes?.protobufReaderProbe?.createIsFunction}, ` +
          `Root=${gpu.probes?.protobufReaderProbe?.rootType}, keys=[${(gpu.probes?.protobufReaderProbe?.keys ?? []).join(", ")}]`,
        { phase: "runtime" },
      ),
      check("webgpu-run-no-uncaught-page-errors", webgpu.pageErrors.length === 0, `${webgpu.pageErrors.length} uncaught page error(s)${webgpu.pageErrors.length > 0 ? `: ${webgpu.pageErrors.map((error) => error.message).join(" | ")}` : ""}`, { phase: "runtime" }),
      check(
        "webgpu-run-no-console-errors",
        webgpu.consoleMessages.filter((message) => message.type === "error").length === 0,
        `${webgpu.consoleMessages.length} console message(s); errors=${JSON.stringify(webgpu.consoleMessages.filter((message) => message.type === "error").map((message) => message.text))}`,
        { phase: "runtime" },
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // WebGL2 run (upstream Context, empty manifest) — T016 (a): "两种后端下都能构造场景"
  // ---------------------------------------------------------------------------------------------
  if (gl === null) {
    checks.push(check("webgl2-run-produced-report", false, `the WebGL2 page probe produced no report: ${webgl2.error?.message ?? "unknown reason"}`, { phase: "runtime" }));
  } else {
    const construction = gl.construction ?? null;
    const scene = gl.scene ?? null;
    const reference = gl.probes?.glReference ?? null;
    checks.push(
      check("webgl2-run-produced-report", gl.errors.length === 0 && construction !== null, `probe finished at ${gl.finishedAt}; probe-level errors=${gl.errors.length}`, { phase: "runtime" }),
      check(
        "scene-constructed-on-webgl2",
        construction !== null &&
          construction.threw === false &&
          construction.contextIsStub === false &&
          construction.contextConstructorName === "Context" &&
          construction.contextIdentity === false &&
          construction.contextIsReplaced === false &&
          gl.probes?.instanceofUpstreamContext === true &&
          gl.probes?.upstreamContextIsGateStub === false &&
          scene?.contextWebgl2 === true &&
          scene?.drawingBufferWidth > 0 &&
          scene?.drawingBufferHeight > 0,
        construction === null
          ? "no construction was attempted"
          : `new Scene({canvas}) threw=${construction.threw}; context constructor="${construction.contextConstructorName}" (upstream class), is the gate stub=${construction.contextIsStub}, ` +
            `instanceof the deep bare import=${gl.probes?.instanceofUpstreamContext}, deep-import identity with the local file=${construction.contextIdentity}; ` +
            `context.webgl2=${scene?.contextWebgl2}, drawing buffer=${scene?.drawingBufferWidth}x${scene?.drawingBufferHeight}`,
        { phase: "runtime" },
      ),
      check(
        "webgl2-run-capabilities-are-gl-derived",
        reference !== null &&
          gl.probes?.contextLimitsAfterConstruction?.maximumTextureSize === reference.maximumTextureSize &&
          gl.probes?.contextLimitsAfterConstruction?.maximumSamples === reference.maximumSamples &&
          gl.probes?.contextLimitsAfterConstruction?.maximumVertexAttributes === reference.maximumVertexAttributes &&
          (gl.contextLimits?.writesDuringConstruction ?? []).length >= 20,
        reference === null
          ? "no independent GL reference query"
          : `ContextLimits (kept upstream module) matches the independently queried WebGL2 limits: maximumTextureSize=${gl.probes?.contextLimitsAfterConstruction?.maximumTextureSize} vs gl ${reference.maximumTextureSize}, ` +
            `maximumSamples=${gl.probes?.contextLimitsAfterConstruction?.maximumSamples} vs gl ${reference.maximumSamples}, maximumVertexAttributes=${gl.probes?.contextLimitsAfterConstruction?.maximumVertexAttributes} vs gl ${reference.maximumVertexAttributes}; ` +
            `upstream Context writes during construction=${(gl.contextLimits?.writesDuringConstruction ?? []).length}, logic-layer reads during construction=${(gl.contextLimits?.logicLayerReadsDuringConstruction ?? []).length}. ` +
            `These GL values differ from the WebGPU adoption values, so the two runs cannot be confused.`,
        { phase: "runtime" },
      ),
      check("webgl2-run-no-uncaught-page-errors", webgl2.pageErrors.length === 0, `${webgl2.pageErrors.length} uncaught page error(s)${webgl2.pageErrors.length > 0 ? `: ${webgl2.pageErrors.map((error) => error.message).join(" | ")}` : ""}`, { phase: "runtime" }),
      check(
        "webgl2-run-no-console-errors",
        webgl2.consoleMessages.filter((message) => message.type === "error").length === 0,
        `${webgl2.consoleMessages.length} console message(s); errors=${JSON.stringify(webgl2.consoleMessages.filter((message) => message.type === "error").map((message) => message.text))}`,
        { phase: "runtime" },
      ),
    );
  }

  checks.push(
    check(
      "two-independent-runs-no-shared-session",
      webgpu.pageId !== webgl2.pageId && webgpu.label === "webgpu" && webgl2.label === "webgl2",
      `run isolation: webgpu=${webgpu.pageId} (browser ${webgpu.browserVersion}) vs webgl2=${webgl2.pageId} (browser ${webgl2.browserVersion}); ` +
        "each run used its own browser instance and its own page load, and no artefact is compared across the two backends " +
        "(原则 II: 两条后端 MUST NOT 同会话/同帧运行)",
      { phase: "runtime" },
    ),
    check(
      "environment-recorded",
      typeof enginePackage.version === "string" &&
        typeof webgpu.browserVersion === "string" &&
        webgpu.report?.environment?.webgpuApi === true &&
        typeof webgl2.report?.environment?.webgl2Api === "boolean",
      `node=${process.version}, browser=${webgpu.browserVersion} (headless), upstream @cesium/engine ${enginePackage.version}, ` +
        `webgpuApi=${webgpu.report?.environment?.webgpuApi}, webgl2Api=${webgl2.report?.environment?.webgl2Api}, ` +
        `adapter.info=${JSON.stringify(webgpu.report?.prefetch?.adapterInfo ?? null)}`,
      { phase: "runtime" },
    ),
  );

  return checks;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const controlMode = options.control === "no-handoff";
  const startedAt = new Date().toISOString();
  log(`start ${startedAt} (node ${process.version}, channel=${options.channel}, headed=${options.headed}, mode=${controlMode ? "control:no-handoff" : "gate"})`);

  const upstreamBefore = snapshotUpstream(ENGINE_ROOT);
  log(`upstream snapshot: ${upstreamBefore.fileCount} files, ${upstreamBefore.totalBytes} bytes, ${upstreamBefore.aggregateHash}`);

  let builds;
  if (options.skipBuild) {
    builds = {
      gate: JSON.parse(fs.readFileSync(path.join(OUT_DIR, "g2-build.json"), "utf8")),
      webgl2: JSON.parse(fs.readFileSync(path.join(OUT_DIR, "g2-webgl2-build.json"), "utf8")),
    };
  } else {
    builds = await buildBoth({ quiet: process.argv.includes("--quiet") });
  }

  const upstreamAfter = snapshotUpstream(ENGINE_ROOT);
  const integrity = compareSnapshots(upstreamBefore, upstreamAfter);
  log(`upstream unchanged after build: ${integrity.unchanged}`);
  const enginePackage = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, "package.json"), "utf8"));

  const server = createStaticServer({ root: REPO_ROOT });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  let webgpu = { label: "webgpu", backend: "webgpu", pageId: "none", browserVersion: "none", report: null, error: null, consoleMessages: [], pageErrors: [], requestFailures: [] };
  let webgl2 = { label: "webgl2", backend: "webgl2", pageId: "none", browserVersion: "none", report: null, error: null, consoleMessages: [], pageErrors: [], requestFailures: [] };
  try {
    webgpu = await runProbe({
      label: "webgpu",
      bundleFile: path.join(OUT_DIR, "g2-handoff", "bundle.js"),
      backend: "webgpu",
      handoff: controlMode ? "none" : "install",
      channel: options.channel,
      headed: options.headed,
      timeoutMs: options.timeoutMs,
      server,
      port,
    });
    // The WebGL2 run only runs in gate mode: the control is about the WebGPU handoff only.
    if (!controlMode) {
      webgl2 = await runProbe({
        label: "webgl2",
        bundleFile: path.join(OUT_DIR, "g2-webgl2", "bundle.js"),
        backend: "webgl2",
        handoff: "none",
        channel: options.channel,
        headed: options.headed,
        timeoutMs: options.timeoutMs,
        server,
        port,
      });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const suffix = controlMode ? "g2-control-no-handoff" : "g2";
  fs.writeFileSync(path.join(OUT_DIR, `${suffix}-webgpu.json`), `${JSON.stringify(webgpu, null, 2)}\n`, "utf8");
  if (!controlMode) fs.writeFileSync(path.join(OUT_DIR, "g2-webgl2.json"), `${JSON.stringify(webgl2, null, 2)}\n`, "utf8");

  const checks = judge({ webgpu, webgl2, gateBuild: builds.gate, webgl2Build: builds.webgl2, integrity, enginePackage });

  if (controlMode) {
    return finishControl({ checks, webgpu, upstream: { integrity, enginePackage }, startedAt });
  }

  const failed = checks.filter((entry) => entry.ok !== true);
  const runtimeRan = webgpu.report !== null && webgl2.report !== null;
  const verdict = failed.length === 0 ? "pass" : failed.some((entry) => entry.phase === "build") || runtimeRan ? "fail" : "partial";

  const evidence = [
    { path: "experiments/gates/out/g2-build.json", what: "real build chain evidence for the gate bundle (alias rewrites, graph classification, whitelist, CJS plugin, MISSING_EXPORT)" },
    { path: "experiments/gates/out/g2-webgl2-build.json", what: "build evidence for the WebGL2 run (empty manifest ⇒ upstream Context stays)" },
    { path: "experiments/gates/out/g2-webgpu.json", what: "raw WebGPU page probe report (prefetch, handoff audit with the take() stack, construction window, capability/ContextLimits snapshots, read log, branch records, loud failures)" },
    { path: "experiments/gates/out/g2-webgl2.json", what: "raw WebGL2 page probe report (upstream Context provenance, GL-derived ContextLimits, independent GL reference query)" },
    { path: "experiments/gates/out/g2-run.log", what: "runner transcript of this execution" },
    { path: "experiments/gates/g2-handoff/Renderer/Context.js", what: "the replacement consumed by the upstream Scene (synchronous device take + capability publication)" },
    { path: "experiments/gates/g2-handoff/capability-map.mjs", what: "the executable form of research §4 (flag table, ContextLimits mapping, composition)" },
    { path: "experiments/gates/g2-handoff/device-handoff.mjs", what: "the handoff slot prototype (T042 contract) with its audit log" },
    { path: "experiments/gates/g2-handoff/probe.js", what: "in-page probe: GL-context instrumentation, ContextLimits instrumentation, prefetch, handoff, synchronous construction, loud-failure probes" },
    { path: "experiments/gates/g2-handoff/build.mjs", what: "real build chain (Rollup + T008 alias plugin + @rollup/plugin-commonjs)" },
    { path: "experiments/gates/g1-alias/upstream-integrity.mjs", what: "upstream content-hash snapshot/diff reused from G-1 (sanctioned reuse)" },
    { path: "tests/unit/capability-mapping.test.mjs", what: "T017: the research §4 mapping asserted without a GPU" },
    { path: "docs/gate-g2-conclusion.md", what: "human-readable conclusion (basis, evidence paths, verdict, consequences)" },
  ];

  const gpuReport = webgpu.report;
  const notes =
    verdict === "pass"
      ? "G-2 通过：预取 adapter/device 后写入交接槽，上游 Scene 在**同一同步流程**中构造（take() 的调用栈来自替换实现的构造函数），" +
        "替换实现按 research §4 在构造期发布能力标志并把 ContextLimits 写进**未列入清单的上游模块** Renderer/ContextLimits.js；" +
        "构造窗口内逻辑层读取的每个能力/limits 值都已等于最终值（异步方案会在构造期暴露假值，本门禁据此排除该风险）；" +
        "depthTexture=false（切片 A）的后果被独立观测证实：整段构造过程 **0 次 WebGL 上下文申请**；两种后端各自独立运行都能构造场景（WebGPU 走替换实现，WebGL2 走上游原版实现，两者互不比较）；" +
        "构建前后 node_modules/@cesium/engine 逐字节未变；F-1 的 CJS 互操作以真实依赖 @rollup/plugin-commonjs 接入：MISSING_EXPORT 由 1 降为 0，protobufjs.Reader.create 在运行期确为函数。" +
        "边界：本门禁不渲染任何一帧（draw/clear/beginFrame/endFrame 一律 category=not-implemented），不主张命令路径可用（W2/T044）；" +
        "构造期所需的上游资源类替换面、能力表的逐项来源、以及 research §4 行号漂移见 findings 与 deviations。"
      : `G-2 未通过（verdict=${verdict}）：共 ${failed.length} 项检查失败 → ${failed.map((entry) => entry.id).join(", ")}。` +
        "按 plan 的失败动作：逐项修正能力表并补测试；某标志无法诚实回答则降为 false 并登记 → STOP 并上报入口 Agent 修订 plan.md（阶段子代理不得自行修改 plan/contracts/spec）。";

  const document = {
    gate: "g2",
    task: "T016",
    verdict,
    recordedAt: new Date().toISOString(),
    notes,
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      engine: { packageName: enginePackage.name, version: enginePackage.version, lock: "upstream/engine-26.3.0.lock.json" },
      browser: { channel: options.channel, version: webgpu.browserVersion, headless: !options.headed, launchArgs: [], note: "zero launch flags; a fresh browser instance per backend" },
      adapter: gpuReport?.prefetch?.adapterInfo ?? null,
      preferredFormat: null,
      gpu: gpuReport?.prefetch
        ? { available: true, features: gpuReport.prefetch.features, isFallbackAdapter: gpuReport.prefetch.isFallbackAdapter, requestDeviceCalls: gpuReport.prefetch.deviceRequests }
        : { available: false, reason: webgpu.error?.message ?? "probe did not run" },
      webgl2: { available: webgl2.report?.environment?.webgl2Api ?? null },
    },
    checks,
    evidence: evidence.filter((entry) => fs.existsSync(path.resolve(REPO_ROOT, entry.path))),
    gateCriteria: {
      source: "plan.md「实现前的验证门」G-2 行；tasks.md T016",
      requirements: [
        "(a) 两种后端下都能构造场景",
        "(b) ContextLimits 与能力标志在 Scene 构造期同步可读",
        "(c) 记录被触发的逻辑层分支并与 research §4 表逐项一致",
      ],
      requiredVerdict: "pass",
      failureAction: "逐项修正能力表并补测试；某标志无法诚实回答则降为 false 并登记 → STOP 上报入口 Agent 修订 plan",
    },
    measurements: {
      upstreamIntegrity: { ...integrity, detailsBefore: upstreamBefore.details, detailsAfter: upstreamAfter.details },
      build: { gate: { checks: builds.gate.checks, graph: builds.gate.graph, rewriteRecords: builds.gate.rewriteRecords, whitelist: builds.gate.whitelist, cjsPlugin: builds.gate.cjsPlugin }, webgl2: { checks: builds.webgl2.checks, graph: builds.webgl2.graph, rewriteRecords: builds.webgl2.rewriteRecords, whitelist: builds.webgl2.whitelist, cjsPlugin: builds.webgl2.cjsPlugin } },
      webgpu: gpuReport,
      webgl2: webgl2.report,
      runIsolation: { webgpu: { browser: webgpu.browserVersion, pageId: webgpu.pageId }, webgl2: { browser: webgl2.browserVersion, pageId: webgl2.pageId } },
    },
    findings: [
      {
        id: "F-1",
        title: "CommonJS 互操作：已按授权以真实依赖 @rollup/plugin-commonjs 接入并验证；protobufjs 具名导出的 MISSING_EXPORT 根因已查清",
        detail:
          "@rollup/plugin-commonjs 29.0.3（devDependency，精确锁版）已接入本门禁的真实构建链。根因：上游 Source/Scene/GoogleEarthEnterpriseImageryProvider.js:482 " +
          "使用命名空间成员访问 `protobuf.Reader.create(data)`（第 1 行是 `import * as protobuf from \"protobufjs/dist/minimal/protobuf.js\"`）；" +
          "G-1 的门禁内包裹（cjs-interop.mjs）只导出 default，Rollup 无法静态绑定该成员，于是把它降级为一次具名导入并在 :482:26 报 MISSING_EXPORT、运行期取到 undefined —— 不会自愈。" +
          "接入真实插件后：两个 bundle 的 MISSING_EXPORT 均为 0，且页面运行期探测 `typeof protobuf.Reader.create === \"function\"` 为真（保护 Google Earth 影像解析路径）。" +
          "对本组门禁无影响（GE 影像不在 MVP 路径上）；对 W1 产品打包的影响：dist 内嵌上游源码后该路径同样需要具名导出，MUST 继续使用该插件（或等价具名导出合成），否则 GE 影像路径一旦被触达即 TypeError。",
        followUp: ["T040（许可证与署名：MIT 纳入允许集合，见条件 3 的落点说明）", "T072 编号核对（见 F-3）"],
        conditions: {
          exactVersion: "29.0.3",
          devDependencyOnly: true,
          license: "MIT",
          licenseGateTask: "T040（本 tasks.md 的许可证任务；提示词中的 T072 在本 tasks.md 是 varying 契约任务）",
        },
      },
      {
        id: "F-2",
        title: "research §4 的行号与已装 26.3.0 不一致（webgl2 标志在 Scene.js 中已无消费点）",
        detail:
          "research §4 记 `Scene/Scene.js:3905` 消费 `context.webgl2`，但 26.3.0 中 Scene.js 全文没有 `context.webgl2`/`_context.webgl2` 读取（3905 行是 shadowState 代码）；" +
          "`context.msaa` 实际只在 `Scene#msaaSupported` getter（Scene.js:1719-1721）中读取，不在构造函数内。" +
          "本门禁因此以**实测读取日志**（g2-webgpu.json → reads.duringConstruction）作为「构造期消费面」的证据，而不是照抄行号；" +
          "capability-map.mjs 的 consumers 字段保留了 research 原文并在该条目标注不可复现。分支断言仍逐项成立：fragmentDepth→_logDepthBuffer→相机 near/far、depthTexture→（无 GL 依赖的构造后果）、压力测试族全 false、maximumTextureFilterAnisotropy=1。",
        followUp: ["W2/T045 实现时以实测消费点为准；若 research 行号需修订，由入口 Agent 决定（子代理不得改 research/plan）"],
      },
      {
        id: "F-3",
        title: "提示词中的「T072 许可证允许集合」在本 tasks.md 中不存在——许可证任务是 T040",
        detail:
          "本 tasks.md（整体重新生成版）中 T040 是「许可证与署名（Apache-2.0）… tools/scripts/check-license-notice.mjs」，" +
          "而 T072 是「varying 成对推导与契约」。F-1 条件 3（MIT 纳入许可证允许集合）已按 T040 登记（tests/unit/deps-locked.test.mjs 断言已安装包声明 license === \"MIT\"），" +
          "MUST 在 T040 的实现/校验中把 MIT 写入允许集合。",
        followUp: ["T040"],
      },
      {
        id: "F-4",
        title: "切片 A 的 depthTexture=false 是本门禁唯一的能力降级，且其后果被独立证实",
        detail:
          "depthTexture=false（research §4 切片 A 临时值）使 View.js:46 不创建 GlobeDepth。本门禁没有直接读取私有成员，而是用平台级观测作为后果证据：" +
          "整段 Scene 构造期间 HTMLCanvasElement.getContext 的 webgl2 申请次数为 0（替换实现为 strict 模式，不申请 GL）。" +
          "切片 B（T098a）翻转为 true 后 MUST 重跑本门禁。",
        followUp: ["T098a（切片 B 功能翻转）", "T045（能力合成正式实现）"],
      },
      {
        id: "F-5",
        title: "替换实现以 strict 模式构造成功 ⇒ W2 的 Context 替换不必携带 WebGL 上下文",
        detail:
          "G-1 的桩以 WebGL2 承载上下文获取（其 D-3 偏离）；G-2 的桩**不申请任何 GL 上下文**仍完成整个上游 Scene 构造，" +
          "说明构造期没有走到需要 GL 的资源类。若 W2 在其它配置（如 depthTexture=true 的切片 B、开启 globe depth）下需要资源类，替换清单必须同时覆盖 Texture/Framebuffer/Renderbuffer 等（T031 的 11 项 replace 已含这些）。",
        followUp: ["T031", "T045", "T098a"],
      },
    ],
    deviations: [
      {
        id: "D-1",
        what: "tasks.md T016 要求「桩 Context 从槽中取设备」并断言两种后端都能构造场景；正式清单与 W2 的资源类替换（Texture/Framebuffer/…）属 Phase 3/4。",
        how: "门禁使用同 schema 的 g2-handoff/manifest.gate.json（唯一条目 Renderer/Context.js）；「WebGL2 后端」用**空清单**构建的第二个 bundle 承载（即上游原版 Renderer/Context.js），而不是在替换实现内部做 GL 回退——后者需要动态决定模块解析，属 W2 设计（plan 未规定，MUST 由入口 Agent 在 W2 定案）。",
      },
      {
        id: "D-2",
        what: "T016 未要求替换实现在无设备时降级为 WebGL2；research §3 步骤 4 描述的是「不写入交接槽 → 用上游原版 WebGL2 Context」。",
        how: "门禁桩在槽为空时抛 category=\"device-handoff/missing\" 的可诊断错误（阴性对照据此成立）。产品语义由 T042/T043 落地时决定；本门禁把该决定显式登记为待入口 Agent 确认的设计点。",
      },
      {
        id: "D-3",
        what: "research §4 的 `webgl2` 消费点行号不可复现（见 F-2）；ContextLimits 成员数 research §4 记为 10 而实测上游模块有 23 个公开成员。",
        how: "门禁以实测为准：capability-map.mjs 覆盖 ContextLimits 全部 23 个公开成员，并在 F-2 中记录行号漂移；不修改 research/plan。",
      },
      {
        id: "D-4",
        what: "T017（tests/unit/capability-mapping.test.mjs）为无 GPU 可运行的单元测试，而门禁产物 experiments/gates/out/** 不入库。",
        how: "该测试的判据全部来自静态的能力映射表 + @webgpu/types 的真实成员名（无 GPU 亦可运行）；门禁产物存在时额外交叉校验实测值，不存在时打印诊断而不静默跳过。",
      },
    ],
  };

  fs.writeFileSync(path.join(OUT_DIR, "g2-run.log"), `${logLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "g2.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  log(`verdict=${verdict} (${checks.filter((entry) => entry.ok === true).length}/${checks.length} checks ok) -> experiments/gates/out/g2.json`);
  for (const entry of failed) log(`  FAIL ${entry.id}: ${entry.detail}`);

  if (verdict === "pass") return 0;
  process.stderr.write(
    "g2-handoff: STOP — G-2 verdict=" + verdict + ". Phase 2 门禁未通过时不得开始 Phase 3；" +
      "失败动作见 plan.md「实现前的验证门」（逐项修正能力表并补测试；无法诚实回答的标志降为 false 并登记），由入口 Agent 修订 plan.md。\n",
  );
  return 1;
}

/** Negative control: with the device prefetched but NOT installed, the gate MUST detect the failure. */
function finishControl({ checks, webgpu, upstream, startedAt }) {
  const requiredFailures = [
    "scene-constructed-on-webgpu",
    "device-handoff-is-synchronous",
    "capabilities-and-limits-synchronously-readable",
    "capability-values-match-research-table",
    "false-capabilities-declared-with-branches",
    "logic-layer-branches-match-research-4",
    "context-limits-written-to-kept-upstream-module",
    "gate-does-not-render-a-frame",
  ];
  const byId = new Map(checks.map((entry) => [entry.id, entry]));
  const controlChecks = requiredFailures.map((id) =>
    check(
      `control-detects-missing-handoff:${id}`,
      byId.get(id)?.ok === false,
      byId.has(id) ? `${id} → ${byId.get(id).ok === false ? "detected (ok=false)" : `NOT detected (ok=${byId.get(id).ok})`}: ${byId.get(id).detail}` : `${id} was not produced by the judge`,
    ),
  );
  const errorCategory = webgpu.report?.construction?.error?.category ?? null;
  controlChecks.push(
    check(
      "control-diagnosable-error-category",
      errorCategory === "device-handoff/missing",
      `construction failed with category=${JSON.stringify(errorCategory)} (expected "device-handoff/missing": the replacement MUST fail loudly when no device was handed over, never silently)`,
    ),
  );
  const detected = controlChecks.filter((entry) => entry.ok === true).length;
  const verdict = detected === controlChecks.length ? "pass" : "fail";

  const document = {
    gate: "g2-control-no-handoff",
    task: "T016 (negative control)",
    verdict,
    recordedAt: new Date().toISOString(),
    notes:
      `G-2 阴性对照（预取设备但**不安装**交接槽）。verdict=pass 的含义是：**判定器确实能识别「没有设备交接就构造不出场景」**——` +
      `${detected}/${controlChecks.length} 个应当失败的检查项确实失败。若出现 "NOT detected"，则 G-2 的正向结论不可信。` +
      "对照运行不写 g2.json，也不改变门禁结论。",
    environment: { node: process.version, platform: `${process.platform} ${process.arch}`, engine: upstream.enginePackage.version, browser: webgpu.browserVersion },
    checks: controlChecks,
    harnessChecks: checks,
    evidence: [
      { path: "experiments/gates/out/g2-control-no-handoff-webgpu.json", what: "control page probe report (prefetch happened, handoff slot left empty, construction threw with a diagnosable category)" },
      { path: "experiments/gates/out/g2-control-no-handoff.json", what: "this artefact" },
      { path: "experiments/gates/out/g2.json", what: "the gate conclusion this control underpins" },
    ].filter((entry) => fs.existsSync(path.resolve(REPO_ROOT, entry.path))),
    measurements: { startedAt, requiredFailures, detected, upstreamIntegrity: upstream.integrity, constructionError: webgpu.report?.construction?.error ?? null, prefetch: webgpu.report?.prefetch ?? null },
  };
  fs.writeFileSync(path.join(OUT_DIR, "g2-control-no-handoff.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  log(`control verdict=${verdict} (detected ${detected}/${controlChecks.length}) -> experiments/gates/out/g2-control-no-handoff.json`);
  for (const entry of controlChecks) log(`  [${entry.ok ? "ok" : "FAIL"}] ${entry.id}`);
  if (verdict === "pass") return 0;
  process.stderr.write("g2-handoff: negative control FAILED — the harness cannot distinguish a handed-over device from an empty slot; the G-2 pass would be untrustworthy.\n");
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "g2-run.log"), `${logLines.join("\n")}\n`, "utf8");
    fs.writeFileSync(
      path.join(OUT_DIR, "g2.json"),
      `${JSON.stringify(
        {
          gate: "g2",
          task: "T016",
          verdict: "partial",
          recordedAt: new Date().toISOString(),
          notes: `G-2 runner 异常终止：${error?.message ?? error}。未完成的检查一律视为失败；STOP 并上报入口 Agent。`,
          environment: { node: process.version, platform: `${process.platform} ${process.arch}` },
          checks: [check("runner-completed", false, `runner threw: ${error?.message ?? error}`)],
          evidence: [{ path: "experiments/gates/g2-handoff/run.mjs", what: "runner that failed" }],
          error: { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack ?? null },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    process.stderr.write(`g2-handoff: unexpected failure: ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  });
