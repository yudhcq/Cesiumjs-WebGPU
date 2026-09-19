/**
 * Contract-suite harness (`层=契约`) — tasks.md T043/T044/T047/T050/T051.
 *
 * HARD INVARIANT (constitution v2.0.0 principle II): one run enables **exactly one** backend. The
 * backend comes from `RENDER_BACKEND`, which `tests/support/backend-runner.mjs` sets for the child
 * process; this module has no way to enable a second one, and it never loads two bundles in one page.
 * Cross-backend comparisons are made by `tests/support/compare-offline.mjs` over the artefacts two
 * separate runs wrote.
 *
 * Each suite:
 *   1. builds the bundle for the active backend (real manifest for `webgpu`, empty manifest for `webgl2`);
 *   2. launches its own browser instance and loads its own page (isolation = separate process +
 *      separate page load);
 *   3. collects the page report **plus** the console transcript, uncaught page errors, failed requests
 *      and the platform-level WebGL2 object counters;
 *   4. writes the artefact to `artifacts/<suite>/<backend>.json`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createStaticServer } from "../../tools/scripts/serve.mjs";
import { REPO_ROOT, bundleRelativePath, ensureBundle } from "./backend-build.mjs";
import { decodePng, regionStatistics, samplePixels } from "./png-reader.mjs";

export const ARTIFACT_ROOT = path.join(REPO_ROOT, "artifacts");
export const PAGE_RELATIVE = "tests/contract/page/index.html";

/** Suite name → page scenario. `backend-core` is the composite independent test of W2. */
export const SUITE_SCENARIOS = {
  "contract-backend-core": "backend-core",
  "smoke:scene-construct": "scene-construct",
  "smoke:draw-dispatch": "draw-dispatch",
  "smoke:present": "present",
  "contract:pass-sequence": "pass-sequence",
  "contract:device-lost": "device-lost",
  "contract:resources": "resources",
  "visual:texture-origin": "texture-origin",
  "terrain:probe": "terrain-probe",
  "terrain:raster-probe": "terrain-raster-probe",
  "terrain:canvas-depth-probe": "canvas-depth-probe",
  // Phase 7-11 suites. Each scenario lives in its own module under `tests/contract/page/scenarios/`
  // (`probe.js`'s `SCENARIO_MODULES`), so adding a suite never edits a shared in-file registry.
  "contract:terrain-ready": "terrain-ready",
  "contract:terrain-offline": "terrain-offline",
  "contract:terrain-unavailable": "terrain-unavailable",
  "contract:interaction": "terrain-interaction",
  "contract:device-lost-terrain": "device-lost-terrain",
  "contract:offscreen-depth": "offscreen-depth",
  "contract:fallback": "fallback",
  "contract:handle": "handle",
  "contract:status": "status",
  "contract:whole-switch": "whole-switch",
  "contract:cross-equivalence": "cross-equivalence",
  "contract:demo": "demo",
  "visual:terrain": "terrain-multitile",
  "visual:terrain-geometry": "terrain-geometry",
  "visual:terrain-elevation": "terrain-elevation",
};

/** The backend of this run — one run, one backend, never a list. */
export function activeBackend() {
  const backend = process.env.RENDER_BACKEND ?? "webgpu";
  if (backend !== "webgpu" && backend !== "webgl2") {
    throw new Error(`RENDER_BACKEND must be "webgpu" or "webgl2" (got "${backend}"); one run enables exactly one backend`);
  }
  return backend;
}

/**
 * Directory name one suite's artefacts live in.
 *
 * `contract:resources` → `resources`, `smoke:present` → `present`, `visual:texture-origin` →
 * `texture-origin`. The `:` MUST NOT survive: it is a path separator on POSIX and illegal on Windows,
 * and the runner's suite names always carry one.
 */
export function artifactDirName(suiteName) {
  return suiteName.replace(/^[a-z]+[:-]/, "");
}

export function artifactPath(suiteName, backend = activeBackend()) {
  return path.join(ARTIFACT_ROOT, artifactDirName(suiteName), `${backend}.json`);
}

function writeArtifact(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Capture the canvas region of the page as a PNG and reduce it to statistics.
 *
 * This is the authoritative **presentation** evidence: `createImageBitmap(canvas)` inside the page is
 * best-effort on a WebGPU canvas, while a screenshot is what the compositor actually shows. The page
 * leaves its last frame presented (and its backend alive) for the suites that need this.
 *
 * `samplePoints` are **normalised** coordinates of individual pixels the suite wants to assert on
 * (T058's four-corner texel assertion, T064's two half-viewport probes). A screenshot is a
 * downscaled-to-1x copy of the canvas region, so a point is rounded to the nearest pixel — the suites
 * pick points far from an edge, which is what makes that safe.
 */
async function captureCanvasRegion(page, viewport, suiteName, backend, samplePoints = []) {
  const box = await page.locator("#contract-canvas").boundingBox();
  if (box === null) return { captured: false, reason: "the canvas is not laid out" };
  const buffer = await page.screenshot({
    clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
  });
  const image = decodePng(buffer);
  const statistics = regionStatistics(image, { x: 0, y: 0, width: image.width, height: image.height });
  const file = path.join(ARTIFACT_ROOT, artifactDirName(suiteName), `${backend}-canvas.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  void viewport;
  return {
    captured: true,
    path: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
    width: image.width,
    height: image.height,
    ...statistics,
    ...(samplePoints.length === 0 ? {} : { samples: samplePixels(image, samplePoints) }),
  };
}

/**
 * Run one contract suite in this process and return everything the spec needs to assert.
 *
 * @param {string} suiteName key of {@link SUITE_SCENARIOS}
 * @param {{viewport?: {width: number, height: number}, timeoutMs?: number, force?: boolean, captureCanvas?: boolean, samplePoints?: {name: string, x: number, y: number}[]}} [options]
 */
export async function runContractSuite(suiteName, options = {}) {
  const scenario = SUITE_SCENARIOS[suiteName];
  if (scenario === undefined) throw new Error(`unknown contract suite "${suiteName}"; known: ${Object.keys(SUITE_SCENARIOS).join(", ")}`);  const backend = activeBackend();
  const build = await ensureBundle({ backend, force: options.force === true });

  const server = createStaticServer({ root: REPO_ROOT });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  const viewport = options.viewport ?? { width: 320, height: 200 };
  const browser = await chromium.launch({
    channel: process.env.CONTRACT_BROWSER_CHANNEL ?? "chrome",
    headless: process.env.CONTRACT_HEADED !== "1",
  });
  const context = await browser.newContext({ viewport: { width: 480, height: 320 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];
  const requests = [];
  const badResponses = [];
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => pageErrors.push({ name: error.name ?? "Error", message: error.message ?? String(error) }));
  page.on("requestfailed", (request) => requestFailures.push({ url: request.url(), failure: request.failure()?.errorText ?? null }));
  // Every request this page made, plus every response the server refused. The offline contract
  // (`contract:terrain-offline`, T087) asserts "zero *external* requests" against this list, so it is
  // collected unconditionally rather than only for the suites that assert on it.
  page.on("request", (request) => requests.push({ url: request.url(), resourceType: request.resourceType() }));
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push({ url: response.url(), status: response.status() });
  });

  // "Forced offline" arm for the offline contract (`contract:terrain-offline`, T087 / FR-012).
  //
  // Asserting "zero external requests were made" is a measurement of a run that *could* have reached
  // the network; this option removes the possibility instead, so the suite proves the scenario
  // completes with every non-local request refused. Loopback stays reachable because the bundle, the
  // fixture tiles and upstream's `Assets/`/workers are served by this run's own static server; the
  // assertion is about *external* requests, not about local ones.
  const blockedExternalRequests = [];
  if (options.blockExternal === true) {
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.protocol === "data:" || url.protocol === "blob:") {
        return route.continue();
      }
      blockedExternalRequests.push({ url: url.href, resourceType: route.request().resourceType() });
      return route.abort("internetdisconnected");
    });
  }

  const query = [
    `bundle=/${bundleRelativePath(backend)}`,
    `backend=${backend}`,
    `scenario=${scenario}`,
    `width=${viewport.width}`,
    `height=${viewport.height}`,
    // Extra, suite-declared parameters (e.g. a diagnostic variant of the same scenario). They only
    // ever narrow one run's fixed conditions; nothing here can enable a second backend (principle II).
    ...Object.entries(options.query ?? {}).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`),
  ].join("&");
  const url = `http://127.0.0.1:${port}/${PAGE_RELATIVE}?${query}`;
  const timeoutMs = options.timeoutMs ?? 240000;

  const run = {
    suite: suiteName,
    scenario,
    backend,
    isolation: "separate-process",
    runId: `${backend}-${process.pid}-${Date.now()}`,
    url,
    browserVersion: browser.version(),
    build,
    consoleMessages,
    pageErrors,
    requestFailures,
    requests,
    badResponses,
    blockedExternalRequests,
    report: null,
    error: null,
    startedAt: new Date().toISOString(),
  };

  try {
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForFunction(() => globalThis.__contract !== undefined && globalThis.__contract.ready === true, null, { timeout: timeoutMs });
    run.report = await page.evaluate(() => globalThis.__contract);
    // The page leaves its last frame presented for exactly this step: the screenshot is what the
    // compositor shows, i.e. the strongest evidence that the draw reached the screen. Suites that
    // assert on pixels ask for it explicitly; the two W2 suites always get it.
    const shouldCapture =
      options.captureCanvas ?? /terrain|visual|present|backend-core/.test(suiteName);
    if (shouldCapture === true) {
      run.canvasScreenshot = await captureCanvasRegion(page, viewport, suiteName, backend, options.samplePoints ?? []);
    }
  } catch (error) {
    run.error = { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack ?? null };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
  run.finishedAt = new Date().toISOString();
  writeArtifact(artifactPath(suiteName, backend), run);
  return run;
}

/** Assertion helper: the report exists and the page recorded no failure of its own. */
export function assertCleanRun(run, assert) {
  assert.equal(run.error, null, `the page did not finish: ${run.error?.message ?? ""}`);
  assert.ok(run.report !== null, "the page MUST publish a report");
  assert.deepEqual(run.report.errors, [], `the page reported errors: ${JSON.stringify(run.report.errors)}`);
  assert.deepEqual(run.pageErrors, [], `uncaught page error(s): ${JSON.stringify(run.pageErrors)}`);
  const consoleErrors = run.consoleMessages.filter((message) => message.type === "error");
  assert.deepEqual(consoleErrors, [], `console error(s): ${JSON.stringify(consoleErrors)}`);
}

/**
 * The single-backend assertion (FR-006/FR-011, T102's rule applied from W2 on): in this run the other
 * backend created **zero** GPU objects — it never even asked for a context or a device of its own kind.
 */
export function assertOtherBackendUntouched(run, assert) {
  const counters = run.report.webgl2;
  const gpuCounters = run.report.webgpu;
  assert.ok(counters !== null && counters !== undefined, "the WebGL2 platform counters MUST be published");
  assert.ok(gpuCounters !== null && gpuCounters !== undefined, "the WebGPU platform counters MUST be published");
  if (run.backend === "webgpu") {
    assert.equal(counters.contextRequests, 0, `this WebGPU run MUST NOT request a WebGL context (got ${JSON.stringify(counters.contextRequestTypes)})`);
    assert.equal(counters.objectsCreated, 0, `this WebGPU run MUST NOT create WebGL objects (got ${JSON.stringify(counters.objectsByMethod)})`);
  } else {
    assert.equal(gpuCounters.adapterRequests, 0, `this WebGL2 run MUST NOT request a WebGPU adapter (got ${gpuCounters.adapterRequests})`);
    assert.equal(gpuCounters.deviceRequests, 0, "this WebGL2 run MUST NOT request a WebGPU device");
  }
}
