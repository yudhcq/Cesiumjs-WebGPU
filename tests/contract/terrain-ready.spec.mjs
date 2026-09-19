/**
 * `contract:terrain-ready` — T091 (US1's Independent Test). `→ FR-001, FR-011, FR-015, SC-001`
 *
 * Run (one backend per run, never both — principle II):
 *   node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain-ready
 *   node tests/support/backend-runner.mjs --backend=webgl2 --suite=contract:terrain-ready
 *
 * WHAT IT PROVES
 *   The page-side scenario (`tests/contract/page/scenarios/terrain-ready.js`) drives the **shipped**
 *   entry point (`bundle.terrainScene.createTerrainScene` = `packages/cesium-webgpu/src/index.ts`) under
 *   fixed conditions and publishes its observations. This spec asserts, per backend:
 *
 *   (a) `whenTilesLoaded()` reports `loaded: true` and its elapsed time / `pendingTiles` are recorded;
 *   (b) the frame is neither blank nor a single flat colour — measured twice through two independent
 *       channels: the compositor screenshot the harness clips out of `#contract-canvas`, and the pixels
 *       `captureFrame()` hands back in the page;
 *   (c) zero uncaught errors (`assertCleanRun`, `run.pageErrors`, console errors) **and** zero
 *       diagnostics on a healthy bring-up (a silent `data-unavailable` / `render-failed` would fail);
 *   (d) multi-tile stitching: ≥2 **real** committed tiles take part. The coordinates come from the page
 *       but are cross-checked against Playwright's own request log *and* against the committed
 *       manifest on disk, so a page that invented them cannot pass;
 *   (e) `assertOtherBackendUntouched` — this run created zero GPU objects of the other backend;
 *   (f) the handle contract: `ready` never rejects, three `dispose()` calls are idempotent (the owned
 *       canvas is removed exactly once, no extra diagnostics), and after dispose `captureFrame()`
 *       rejects with an `internal` diagnostic instead of returning an empty frame.
 *
 * THRESHOLDS AND THEIR PROVENANCE (T091: "阈值落盘并记录来源") are in {@link THRESHOLDS}; every one of
 * them is written into `artifacts/terrain-ready/evidence.<backend>.json` next to the measurement it
 * judges, together with the Node-side derivations below.
 *
 * WHY THE SCREENSHOT IS THE PIXEL AUTHORITY
 *   The harness screenshots the clip `#contract-canvas` occupies. The scenario pins the entry's viewport
 *   to 320x200 CSS (= the container's size), so the canvas exactly fills `#contract-container` and a
 *   canvas that never received a frame shows that container's **black** background — i.e. a blank frame
 *   measures ≈ 0 non-background pixels instead of passing as content. That is what gives (b) its
 *   discriminating power; with a canvas larger than its container the page background would read as
 *   "non-background" and (b) would be true by construction.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "playwright/test";

import { ARTIFACT_ROOT, assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";

/** Repository root, derived from this file's own URL (the runner's cwd is not assumed). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SUITE = "contract:terrain-ready";
const SCENARIO = "terrain-ready";
const EVIDENCE_DIR = path.join(ARTIFACT_ROOT, "terrain-ready");

/** The committed dataset this contract is measured against. */
const DATASET_ID = "matterhorn-z0-12";
const DATASET_MANIFEST = path.join("packages", "cesium-webgpu", "fixtures", DATASET_ID, "manifest.json");
const FIXTURE_PATH_PREFIX = `/packages/cesium-webgpu/fixtures/${DATASET_ID}/`;

/** The pinned capture geometry (must equal the scenario's fixed conditions, asserted below). */
const CANVAS = { width: 320, height: 200 };
const VIEWPORT = { width: 320, height: 200, devicePixelRatio: 1 };
const CAMERA = { longitude: 6.8652, latitude: 45.8326, height: 24000, heading: 0, pitch: -50, roll: 0 };

/** Normalised sample points handed to the harness, so the artefact names individual screenshot pixels. */
const SAMPLE_POINTS = [
  { name: "centre", x: 0.5, y: 0.5 },
  { name: "upper-left-quarter", x: 0.25, y: 0.25 },
  { name: "lower-right-quarter", x: 0.75, y: 0.75 },
];

/**
 * Every threshold this suite judges with, plus where the number comes from.
 *
 * `MIN_*` values were chosen from **measured** evidence, not from taste:
 *   - the W5 offline run (`artifacts/terrain-offline/{webgpu,webgl2}.json`) renders the same camera and
 *     scene configuration and measured `nonBackground 110592/110592 = 1.0` with `uniqueColours 256`
 *     (saturated at the reader's cap) — so a terrain frame is nowhere near the 0.5 / 2 boundaries;
 *   - the same run requested **15 distinct** tiles (levels 0-9) for one settled frame, so "≥2 real
 *     tiles" is a floor, not an aspiration;
 *   - `stats().tileCount` counts *distinct paths served through the entry's reader*
 *     (`src/compose/scene-runtime.ts:232-258`), and `src/terrain/source.ts:306-314` reads
 *     `manifest.json` through that same reader — hence the documented +1.
 */
const THRESHOLDS = {
  MIN_NON_BACKGROUND_RATIO: {
    value: 0.5,
    source:
      "artifacts/terrain-offline/{webgpu,webgl2}.json (same camera/scene): nonBackground 110592/110592 = 1.0; " +
      "criterion a > 8 && r + g + b > 24 from tests/support/png-reader.mjs regionStatistics",
  },
  MIN_UNIQUE_COLOURS: {
    value: 2,
    source: "same artefacts: uniqueColours 256 (reader cap); a single flat colour measures exactly 1",
  },
  MIN_CAPTURED_NON_BACKGROUND_RATIO: {
    value: 0.5,
    source: "same criterion applied in the page to the pixels captureFrame() returns (measured twice, see the run artefact)",
  },
  MAX_SCREENSHOT_CAPTURE_DISAGREEMENT: {
    value: 0.2,
    source:
      "the two channels are different read-back paths (compositor screenshot vs `drawImage` of the canvas), so a small gap is expected; " +
      "0.2 is far below the 1.0 a blank frame would produce on either side",
  },
  MIN_DISTINCT_REAL_TILES: {
    value: 2,
    source: "T091 '多瓦片拼接': the committed dataset ships 286 tiles over 13 levels; the W5 offline run read 15 distinct tiles for one frame",
  },
  MANIFEST_READS_IN_TILE_COUNT: {
    value: 1,
    source: "src/terrain/source.ts:306-314 reads manifest.json through the reader that src/compose/scene-runtime.ts:232-258 counts",
  },
  MIN_DRAW_CALLS_PER_SETTLED_FRAME: {
    value: 1,
    source: "Scene#debugCommandFilter tally (src/compose/scene-runtime.ts:410-421); a frame that drew nothing is a failure, not a pass",
  },
  MIN_DRAW_COMMANDS_PER_SETTLED_FRAME: {
    value: 2,
    source:
      "measured on the WebGPU arm at the patch layer's `Context#draw`: the settled frame issues one draw command per visible tile " +
      "(W5's terrain probe measured 7 tiles to render for the same camera), so 2 is a floor for 'more than one tile was stitched in'",
  },
};

test.setTimeout(600_000);

function writeEvidence(payload) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, `evidence.${payload.backend}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** The committed dataset's own tile list, read from disk: "real tile" is decided here, not in the page. */
function readManifestTiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, DATASET_MANIFEST), "utf8"));
  return {
    manifest: DATASET_MANIFEST.split(path.sep).join("/"),
    datasetId: manifest.datasetId ?? null,
    sampleWidth: manifest.sampleWidth ?? null,
    sampleHeight: manifest.sampleHeight ?? null,
    levels: Array.isArray(manifest.levels) ? manifest.levels.length : null,
    tileCount: Array.isArray(manifest.tiles) ? manifest.tiles.length : (manifest.tileCount ?? null),
    tiles: new Set((manifest.tiles ?? []).map((tile) => `${tile.level}/${tile.x}/${tile.y}`)),
  };
}

/** Paths of every `.hgt` request the browser itself made, as Playwright saw them. */
function observedTilePaths(requests) {
  const paths = new Set();
  for (const entry of requests) {
    let url;
    try {
      url = new URL(entry.url);
    } catch {
      continue;
    }
    if (url.pathname.endsWith(".hgt")) paths.add(url.pathname);
  }
  return [...paths].sort();
}

function describeNumber(entry) {
  return entry === undefined || entry === null ? "<missing>" : entry.label;
}

test("the shipped entry point brings up the MVP terrain scene end to end on this backend", async () => {
  const run = await runContractSuite(SUITE, {
    viewport: CANVAS,
    timeoutMs: 300_000,
    captureCanvas: true,
    samplePoints: SAMPLE_POINTS,
  });

  const result = run.report?.result?.[SCENARIO] ?? null;
  const screenshot = run.canvasScreenshot ?? null;
  const manifest = readManifestTiles();
  const observedTiles = observedTilePaths(run.requests);

  const acceptance = result?.acceptance ?? {};
  const handleContract = result?.handleContract ?? {};
  const acceptanceTiles = result?.fetchEvidence?.acceptance?.tiles ?? [];

  // Node-side derivations, recorded even when an assertion below fails.
  const tilesNotInCommittedManifest = acceptanceTiles.filter((tile) => tile.tile === null || !manifest.tiles.has(tile.tile));
  const tilesNotSeenByTheBrowser = acceptanceTiles.filter((tile) => !observedTiles.includes(tile.path));
  const foreignTileRequests = observedTiles.filter((tilePath) => !tilePath.startsWith(FIXTURE_PATH_PREFIX));
  const failedTileRequests = (run.requestFailures ?? []).filter((failure) => {
    try {
      return new URL(failure.url).pathname.endsWith(".hgt");
    } catch {
      return false;
    }
  });
  const screenshotRatio = screenshot === null || screenshot.considered === 0 ? null : screenshot.nonBackground / screenshot.considered;
  const capturedRatio = acceptance?.capturedFrame?.inPage?.nonBackgroundRatio ?? null;
  const ratioDisagreement = screenshotRatio === null || capturedRatio === null ? null : Math.abs(screenshotRatio - capturedRatio);

  const evidence = {
    suite: SUITE,
    scenario: SCENARIO,
    backend: run.backend,
    url: run.url,
    browserVersion: run.browserVersion,
    thresholds: THRESHOLDS,
    dataset: { ...manifest, tiles: `${manifest.tiles.size} tile keys loaded from the manifest` },
    scenarioResult: result,
    nodeSide: {
      screenshot,
      observedTilePaths: observedTiles,
      observedTileCount: observedTiles.length,
      foreignTileRequests,
      failedTileRequests,
      tilesNotInCommittedManifest,
      tilesNotSeenByTheBrowser,
      screenshotRatio,
      capturedRatio,
      ratioDisagreement,
      requestFailures: run.requestFailures,
      badResponses: run.badResponses,
      pageErrors: run.pageErrors,
      consoleErrors: (run.consoleMessages ?? []).filter((message) => message.type === "error"),
      runError: run.error,
    },
    verdict: "written before the assertions, so a failure still leaves the measurement on disk",
  };
  writeEvidence(evidence);

  console.log(
    `terrain-ready[${run.backend}]: ${JSON.stringify({
      screenshot: screenshot === null ? null : { width: screenshot.width, height: screenshot.height, nonBackground: screenshot.nonBackground, considered: screenshot.considered, uniqueColours: screenshot.uniqueColours, centre: screenshot.centre },
      captured: capturedRatio === null ? null : { ratio: capturedRatio, uniqueColours: acceptance?.capturedFrame?.inPage?.uniqueColours ?? null },
      tiles: acceptanceTiles.map((tile) => tile.tile),
      statsTileCount: describeNumber(acceptance?.statsAtLoad?.tileCount),
      oneFrameDraws: describeNumber(acceptance?.statsOneFrame?.drawCallCount),
      oneFrameTrianglesByProductTally: describeNumber(acceptance?.statsOneFrame?.triangleCount),
      measuredFrame: acceptance?.settledFrameGeometry ?? null,
      tilesLoaded: acceptance?.tilesLoaded ?? null,
      statuses: (acceptance?.statuses ?? []).map((status) => status.active),
      diagnostics: (acceptance?.diagnostics ?? []).length,
      disposals: (handleContract?.disposals ?? []).map((entry) => `${entry.attempt}:${entry.threw === null ? "ok" : "threw"}/${entry.diagnosticsAdded}`),
      postDisposeCapture: handleContract?.postDispose?.captureFrame?.category ?? null,
      postDisposeDiagnosticsDelivered: handleContract?.diagnosticsDeliveredAfterDispose ?? null,
    })}`,
  );

  // ---- (c) zero uncaught errors, and no silent degradation ---------------------------------------
  assertCleanRun(run, assert);
  assert.deepEqual(run.pageErrors, [], `uncaught page error(s) in this run: ${JSON.stringify(run.pageErrors)}`);
  assert.notEqual(result, null, "the scenario MUST publish its result under report.result[\"terrain-ready\"]");

  // ---- the run really enabled one backend, and it is this one ------------------------------------
  assert.equal(run.backend, result.backend, "the page's backend MUST be the backend the runner enabled");
  assert.deepEqual(
    (result.acceptance?.statuses ?? []).map((status) => status.active),
    [run.backend],
    `the entry's own status report MUST name the active path (got ${JSON.stringify(result.acceptance?.statuses)})`,
  );
  assert.equal(result.entry.exportedFromBundle, true, "the bundle MUST expose terrainScene.createTerrainScene (T089)");
  assert.equal(result.entry.probeSceneAssemblyUsed, false, "this suite MUST drive the shipped entry point, not the probe's own scene assembly");

  // ---- fixed conditions (T091): camera / time / seed / viewport / pixel ratio / dataset -----------
  assert.deepEqual(result.fixed.camera, CAMERA, "the camera MUST be the pinned pose");
  assert.deepEqual(result.fixed.viewport, VIEWPORT, "the viewport (CSS size and device pixel ratio) MUST be pinned");
  assert.deepEqual(result.fixed.backingStore, { width: 320, height: 200 }, "the pinned viewport implies a 320x200 backing store");
  assert.equal(result.fixed.datasetId, DATASET_ID, "the dataset MUST be the pinned fixture");
  assert.equal(result.fixed.sceneTimeIso.value, "2026-03-20T12:00:00Z", "the scene time MUST be the pinned instant");
  assert.equal(result.fixed.seed.value, null, "this scenario has no random source, so the seed MUST be recorded as null rather than invented");

  // The entry drove the canvas the harness screenshots — otherwise the pixel evidence below would be
  // measuring an element nothing ever drew into.
  assert.equal(result.acceptance.domAfterCreate.canvasesInContainer, 1, "the entry MUST NOT add a second canvas to the container");
  assert.equal(result.acceptance.domAfterCreate.drivenIsTheScreenshotTarget, true, "the driven canvas MUST be the harness screenshot target #contract-canvas");
  assert.equal(result.acceptance.domBefore.canvasesInContainer, 1, "the page pre-places exactly one canvas");
  // The canvas the entry drives MUST carry the pinned viewport geometry — not the entry's own default
  // (384x288), and not whatever the page happened to leave behind. On the WebGPU path the swap chain
  // re-derives this from the canvas's CSS box × the page DPR (`swapchain.ts:181-197`) and on the WebGL2
  // path `resolveSceneCanvas` writes it directly; both are required to land on the pinned number.
  assert.deepEqual(result.acceptance.domAfterCreate.backingStore, { width: VIEWPORT.width, height: VIEWPORT.height }, "the driven canvas's backing store MUST be the pinned viewport geometry");
  assert.deepEqual(result.acceptance.domBefore.backingStore, { width: VIEWPORT.width, height: VIEWPORT.height }, "the page's pre-placed canvas starts at the harness viewport size");
  assert.equal(result.acceptance.domAfterCreate.activeContext.present, true, `the canvas MUST own a live ${run.backend} context (${result.acceptance.domAfterCreate.activeContext.checkedVia})`);
  assert.equal(result.acceptance.domAfterCreate.activeContext.error, null, "asking the canvas for its own context type MUST NOT throw");
  assert.equal(result.acceptance.domAfterCreate.page.devicePixelRatio, 1, "the harness browser context pins the page DPR to 1; the render DPR (2) is the scenario's own fixed condition");
  const box = result.acceptance.domAfterCreate.boundingBox;
  assert.ok(box !== null, "the canvas MUST be laid out (the harness clip needs a bounding box)");
  assert.ok(
    box.x >= 0 && box.y >= 0 && box.x + box.width <= result.acceptance.domAfterCreate.page.innerWidth && box.y + box.height <= result.acceptance.domAfterCreate.page.innerHeight,
    `the canvas MUST lie inside the browser viewport, or the screenshot clip would be cut: ${JSON.stringify(box)} vs ${result.acceptance.domAfterCreate.page.innerWidth}x${result.acceptance.domAfterCreate.page.innerHeight}`,
  );
  assert.equal(box.width, CANVAS.width, "the canvas CSS box MUST be the pinned width");
  assert.equal(box.height, CANVAS.height, "the canvas CSS box MUST be the pinned height");

  // ---- (a) whenTilesLoaded() ----------------------------------------------------------------
  assert.equal(result.acceptance.ready.state, "fulfilled", "ready MUST NOT reject (failures go to diagnostics)");
  assert.equal(result.acceptance.tilesLoaded.loaded, true, `whenTilesLoaded() MUST report loaded:true (got ${JSON.stringify(result.acceptance.tilesLoaded)})`);
  assert.equal(result.acceptance.tilesLoaded.pendingTiles, 0, "a loaded globe MUST have no tile read in flight");
  assert.ok(result.acceptance.tilesLoaded.elapsedMs > 0 && result.acceptance.tilesLoaded.elapsedMs <= result.acceptance.tilesLoaded.timeoutMs, `tiles MUST load inside the pinned budget (got ${result.acceptance.tilesLoaded.elapsedMs} ms of ${result.acceptance.tilesLoaded.timeoutMs} ms)`);

  // ---- (b) the frame is neither blank nor a single flat colour -----------------------------------
  assert.notEqual(screenshot, null, "the harness MUST capture the canvas region for this suite");
  assert.equal(screenshot.captured, true, `the canvas MUST be screenshotted (${screenshot.reason ?? ""})`);
  assert.equal(screenshot.width, CANVAS.width, "the screenshot MUST be the canvas region at 1x, as clipped");
  assert.equal(screenshot.height, CANVAS.height, "the screenshot MUST be the canvas region at 1x, as clipped");
  assert.equal(screenshot.considered, CANVAS.width * CANVAS.height, "every pixel of the canvas region MUST be considered");
  assert.ok(
    screenshotRatio >= THRESHOLDS.MIN_NON_BACKGROUND_RATIO.value,
    `the composited frame MUST NOT be blank: ${screenshot.nonBackground}/${screenshot.considered} = ${screenshotRatio} non-background pixels, threshold ${THRESHOLDS.MIN_NON_BACKGROUND_RATIO.value} (${THRESHOLDS.MIN_NON_BACKGROUND_RATIO.source})`,
  );
  assert.ok(
    screenshot.uniqueColours >= THRESHOLDS.MIN_UNIQUE_COLOURS.value,
    `the frame MUST NOT be one flat colour: ${screenshot.uniqueColours} distinct colours, threshold ${THRESHOLDS.MIN_UNIQUE_COLOURS.value}`,
  );
  const centre = (screenshot.samples ?? []).find((sample) => sample.name === "centre");
  assert.ok(centre !== undefined, "the harness MUST report the sampled centre pixel");
  assert.ok(centre.rgba[0] + centre.rgba[1] + centre.rgba[2] > 24, `the centre of the frame MUST have been drawn into: ${JSON.stringify(centre)}`);
  assert.equal(acceptance.capturedFrame.shape.pixelFormat, "rgba8", "captureFrame() MUST return RGBA8");
  assert.equal(acceptance.capturedFrame.shape.origin, "top-left", "captureFrame() MUST be top-left origin");
  assert.equal(acceptance.capturedFrame.shape.premultiplied, false, "captureFrame() MUST NOT be premultiplied");
  assert.equal(acceptance.capturedFrame.shape.pixelsIsUint8Array, true, "captureFrame() MUST return a Uint8Array");
  assert.equal(acceptance.capturedFrame.shape.width, VIEWPORT.width, "captureFrame() MUST return the drawing-buffer width");
  assert.equal(acceptance.capturedFrame.shape.height, VIEWPORT.height, "captureFrame() MUST return the drawing-buffer height");
  assert.ok(
    capturedRatio >= THRESHOLDS.MIN_CAPTURED_NON_BACKGROUND_RATIO.value,
    `the frame the page read back MUST NOT be blank either: ${capturedRatio}, threshold ${THRESHOLDS.MIN_CAPTURED_NON_BACKGROUND_RATIO.value} (${THRESHOLDS.MIN_CAPTURED_NON_BACKGROUND_RATIO.source})`,
  );
  assert.ok(
    ratioDisagreement <= THRESHOLDS.MAX_SCREENSHOT_CAPTURE_DISAGREEMENT.value,
    `the compositor screenshot and the in-page readback MUST agree on how much of the frame is content: screenshot ${screenshotRatio} vs capture ${capturedRatio}`,
  );

  // "unmeasured MUST be NaN, never 0" (T089 / FR-033), and a measured frame MUST be a real ratio.
  assert.equal(acceptance.statsAfterReset.nonBackgroundRatio.kind, "nan", "with nothing captured yet, the pixel statistics MUST be unmeasured (NaN), not 0");
  assert.equal(acceptance.statsAfterReset.uniqueColorCount.kind, "nan", "with nothing captured yet, uniqueColorCount MUST be unmeasured (NaN), not 0");
  assert.equal(acceptance.statsAfterReset.frameTimeMs.p50.kind, "nan", "after resetStats() the frame-time window is empty, so p50 MUST be unmeasured (NaN), not 0");
  assert.equal(acceptance.statsAfterReset.depthDiscontinuityRatio.kind, "nan", "the depth ratio MUST be unmeasured (NaN) rather than a fabricated 0 — no legal depth copy exists for depth24plus-stencil8 on this Chrome (docs/gate-g7-conclusion.md §0 F4)");
  assert.equal(acceptance.statsAfterReset.tileCount.value, 0, "resetStats() MUST clear the tile counter");
  assert.equal(acceptance.statsOneFrame.nonBackgroundRatio.kind, "finite", "after a capture the pixel statistics MUST be a measurement");
  assert.ok(acceptance.statsOneFrame.nonBackgroundRatio.value >= THRESHOLDS.MIN_CAPTURED_NON_BACKGROUND_RATIO.value, `stats().nonBackgroundRatio MUST report real coverage (got ${acceptance.statsOneFrame.nonBackgroundRatio.label})`);
  assert.equal(acceptance.statsSettled.depthDiscontinuityRatio.kind, "nan", "the depth ratio stays unmeasured on the settled frame as well");

  // ---- (d) multi-tile stitching, with tile coordinates as the evidence --------------------------
  assert.ok(
    acceptanceTiles.length >= THRESHOLDS.MIN_DISTINCT_REAL_TILES.value,
    `the acceptance scene MUST read at least ${THRESHOLDS.MIN_DISTINCT_REAL_TILES.value} distinct tiles (got ${acceptanceTiles.length}: ${JSON.stringify(result.fetchEvidence?.acceptance?.tileCoordinates)})`,
  );
  assert.ok(
    result.fetchEvidence.acceptance.distinctLevels.length >= 1 && result.fetchEvidence.acceptance.allUnderFixturePrefix,
    `every tile MUST come from the pinned dataset prefix ${FIXTURE_PATH_PREFIX} (got ${JSON.stringify(result.fetchEvidence?.acceptance?.paths)})`,
  );
  assert.deepEqual(tilesNotInCommittedManifest, [], `the tile coordinates MUST be tiles the committed dataset actually ships (unmatched: ${JSON.stringify(tilesNotInCommittedManifest)})`);
  assert.deepEqual(tilesNotSeenByTheBrowser, [], `every tile the page claims MUST appear in the browser's own request log (missing: ${JSON.stringify(tilesNotSeenByTheBrowser)})`);
  assert.ok(
    observedTiles.length >= THRESHOLDS.MIN_DISTINCT_REAL_TILES.value,
    `the run's own request log MUST contain at least ${THRESHOLDS.MIN_DISTINCT_REAL_TILES.value} tiles (got ${observedTiles.length})`,
  );
  assert.deepEqual(foreignTileRequests, [], `this run MUST NOT fetch tiles outside the pinned dataset (got ${JSON.stringify(foreignTileRequests)})`);
  const tileCount = acceptance.statsAtLoad.tileCount;
  assert.equal(tileCount.kind, "finite", "stats().tileCount MUST be a measurement");
  assert.ok(
    tileCount.value >= THRESHOLDS.MIN_DISTINCT_REAL_TILES.value + THRESHOLDS.MANIFEST_READS_IN_TILE_COUNT.value,
    `stats().tileCount MUST count the ${THRESHOLDS.MIN_DISTINCT_REAL_TILES.value} real tiles plus the ${THRESHOLDS.MANIFEST_READS_IN_TILE_COUNT.value} manifest read (got ${tileCount.label}; ${THRESHOLDS.MANIFEST_READS_IN_TILE_COUNT.source})`,
  );
  assert.ok(
    acceptance.statsOneFrame.drawCallCount.value >= THRESHOLDS.MIN_DRAW_CALLS_PER_SETTLED_FRAME.value,
    `the settled frame MUST draw something (got ${acceptance.statsOneFrame.drawCallCount.label} draw calls)`,
  );
  // The geometry of that same settled frame, measured at the patch layer's own `draw` entry point
  // rather than through the product's command tally — see `productFindings` below for why the tally's
  // `triangleCount` cannot be used for this.
  const geometry = acceptance.settledFrameGeometry;
  if (run.backend === "webgpu") {
    assert.equal(geometry.instrumented, true, "the draw instrumentation MUST be installed on the patch-layer Context");
    assert.equal(geometry.available, true, "the settled frame MUST contain draws");
    assert.ok(
      geometry.draws >= THRESHOLDS.MIN_DRAW_COMMANDS_PER_SETTLED_FRAME.value,
      `the settled frame MUST issue at least ${THRESHOLDS.MIN_DRAW_COMMANDS_PER_SETTLED_FRAME.value} draw commands (got ${geometry.draws})`,
    );
    assert.ok(
      geometry.trianglesFromIndices > 0,
      `the settled frame MUST submit real triangles (got ${geometry.trianglesFromIndices} from index counts ${JSON.stringify(geometry.indexCounts)})`,
    );
    assert.ok(
      geometry.distinctIndexBuffers >= THRESHOLDS.MIN_DISTINCT_REAL_TILES.value,
      `multi-tile stitching needs at least ${THRESHOLDS.MIN_DISTINCT_REAL_TILES.value} distinct tile geometries in one frame (got ${geometry.distinctIndexBuffers} distinct index buffers)`,
    );
  } else {
    // Upstream's `Context` executes a WebGL2 run's draws, so the patch-layer entry point is never
    // called: the count is recorded as unavailable on this path instead of being asserted as zero.
    assert.equal(geometry.available, false, `the WebGL2 path MUST NOT claim patch-layer draw instrumentation (got ${JSON.stringify(geometry)})`);
  }

  // Known product defects this suite measured. They are recorded, **not** worked around and **not**
  // asserted as expected behaviour: neither is part of T091's acceptance criteria, and fixing them is a
  // `packages/**` change that this test-only task must not make.
  const productFindings = [
    {
      id: "stats.triangleCount-is-structurally-zero",
      claim: "`stats().triangleCount` reports 0 for every frame while `drawCallCount` reports the frame's real draw count.",
      evidence: {
        drawCallCount: acceptance.statsOneFrame.drawCallCount.label,
        triangleCount: acceptance.statsOneFrame.triangleCount.label,
        trianglesMeasuredFromIndexCounts: geometry.trianglesFromIndices,
        drawsMeasured: geometry.draws,
      },
      cause:
        "src/compose/scene-runtime.ts:416-418 multiplies by `command.instanceCount`, and Cesium's DrawCommand defaults it to 0 for non-instanced draws (node_modules/@cesium/engine/Source/Renderer/DrawCommand.js:89; Context.js:1367 treats 0 as the non-instanced case).",
      requiredChange: "multiply by `instanceCount > 0 ? instanceCount : 1` (packages/cesium-webgpu/src/compose/scene-runtime.ts) — NOT made by this task",
    },
    {
      id: "viewport.devicePixelRatio-is-replaced-for-a-laid-out-canvas",
      claim:
        "For a canvas that has a CSS layout, `options.viewport.devicePixelRatio` does not decide the drawing buffer: the swap chain re-derives it from the client box × the page DPR and writes the canvas attributes back, so requesting DPR 2 for a 320x200 box yields a 320x200 buffer.",
      evidence: {
        measuredWithRequestedDpr2OnALaidOutCanvas: {
          requested: { width: 320, height: 200, devicePixelRatio: 2 },
          measuredBackingStore: { width: 320, height: 200 },
          measuredCssBox: { width: 320, height: 200 },
          capturedWhen: "this suite's first WebGPU run (the assertion that failed named exactly this mismatch); the scenario now pins DPR 1 so the declared condition and the measurement agree",
        },
        measuredWithRequestedDpr2OnAnUnlaidOutCanvas: {
          requested: handleContract.viewport ?? null,
          measuredBackingStore: handleContract.canvas.backingStore,
          note: "the same entry call DOES honour the ratio when no client box exists — so the divergence is in the swap chain, not in the entry",
        },
      },
      cause:
        "backend-webgpu/webgpu/swapchain.ts:181-197 (`resizeIfNeeded`/`#buildAttachments`) with `resolveDrawingBufferSize` (swapchain.ts:60-72): on the `client-size` branch the size is `clientWidth × dpr()` where `dpr()` defaults to `globalThis.devicePixelRatio` (the page's, 1 here) — the entry's viewport never reaches the swap chain.",
      requiredChange:
        "either thread the entry's `viewport.devicePixelRatio` into the swap chain, or document the option as advisory for laid-out canvases (packages/cesium-webgpu/**) — NOT decided by this task",
    },
  ];
  evidence.productFindings = productFindings;
  evidence.nodeSide.settledFrameGeometry = geometry;
  // Written a second time here so the findings survive a later assertion failure.
  writeEvidence(evidence);
  console.log(`terrain-ready[${run.backend}] product findings: ${JSON.stringify(productFindings.map((finding) => ({ id: finding.id, evidence: finding.evidence })))}`);

  // ---- (e) the other backend was never touched --------------------------------------------------
  assertOtherBackendUntouched(run, assert);

  // ---- the hand-off preconditions (AGENTS.md §7): the slot was free, and the scene ran on this path
  assert.equal(result.acceptance.handoff.slotPendingBefore, false, "the device-hand-off slot MUST be empty before a scene is created (a parked device would mean a second context is about to take it)");
  assert.equal(result.handleContract.handoff.slotPendingBefore, false, "the device-hand-off slot MUST be empty before the handle-contract scene is created");
  if (run.backend === "webgpu") {
    assert.deepEqual(result.acceptance.handoff.auditOps, ["reset-cycle", "install"], `a WebGPU run MUST park its own probed device before constructing the scene (got ${JSON.stringify(result.acceptance.handoff)})`);
  } else {
    assert.equal(result.acceptance.handoff.installed, false, "a WebGL2 run MUST NOT install a WebGPU device hand-off");
  }

  // ---- (c, cont.) a healthy bring-up reports nothing at all -------------------------------------
  assert.deepEqual(acceptance.diagnostics, [], `a healthy acceptance run MUST report no diagnostic (got ${JSON.stringify(acceptance.diagnostics)})`);
  // Blanket "zero failed requests" is deliberately NOT asserted: the scene keeps rendering after the
  // report is published (`requestRenderMode: false`), so tearing the page down can abort a tile read
  // in flight. What MUST NOT fail is a tile read itself.
  assert.deepEqual(failedTileRequests, [], `no fixture tile read may fail in this run: ${JSON.stringify(failedTileRequests)}`);
  assert.deepEqual(evidence.nodeSide.badResponses, [], `no response may be an error in this run: ${JSON.stringify(evidence.nodeSide.badResponses)}`);

  // ---- (f) the handle contract ------------------------------------------------------------------
  assert.equal(handleContract.ready.state, "fulfilled", "ready MUST NOT reject on the handle-contract scene either");
  assert.deepEqual(handleContract.members.filter((member) => member.present === false), [], "every contracted handle member MUST be present");
  assert.equal(handleContract.canvas.createdByEntry, true, "the entry MUST create a canvas when the host has none");
  // The viewport the entry was asked for MUST be what its canvas carries when the swap chain cannot
  // measure a client box (no CSS layout ⇒ `resolveDrawingBufferSize` falls back to the attributes).
  assert.deepEqual(
    handleContract.canvas.backingStore,
    handleContract.canvas.expectedBackingStore,
    `the entry MUST honour the pinned viewport (including its pixel ratio) when nothing overrides it: expected ${JSON.stringify(handleContract.canvas.expectedBackingStore)}, got ${JSON.stringify(handleContract.canvas.backingStore)}`,
  );
  assert.deepEqual(handleContract.canvas.expectedBackingStore, { width: 400, height: 300 }, "the handle-contract arm pins 200x150 at DPR 2");
  assert.equal(handleContract.captureBeforeDispose.settled, "fulfilled", `captureFrame() MUST work on a live scene (got ${JSON.stringify(handleContract.captureBeforeDispose)})`);
  assert.deepEqual(handleContract.diagnosticsBeforeDispose, 0, "a healthy bring-up MUST NOT report a diagnostic");
  assert.equal(handleContract.disposals.length, 3, "three dispose() calls MUST be attempted");
  for (const disposal of handleContract.disposals) {
    assert.equal(disposal.threw, null, `dispose() #${disposal.attempt} MUST NOT throw: ${JSON.stringify(disposal.threw)}`);
    assert.equal(disposal.diagnosticsAdded, 0, `dispose() #${disposal.attempt} MUST NOT report a diagnostic (idempotent: it must not re-run the teardown)`);
  }
  assert.equal(handleContract.disposals[0].canvasInHost, false, "the first dispose() MUST remove the canvas the entry created");
  assert.equal(handleContract.removeCallsAcrossThreeDisposals, 1, "three dispose() calls MUST remove the owned canvas exactly once");
  assert.deepEqual(
    handleContract.postDispose.whenTilesLoaded,
    { settled: "fulfilled", loaded: false, pendingTiles: 0 },
    "after dispose() whenTilesLoaded() MUST answer loaded:false rather than hang or reject",
  );
  assert.equal(handleContract.postDispose.captureFrame.settled, "rejected", "after dispose() captureFrame() MUST fail loudly");
  assert.equal(handleContract.postDispose.captureFrame.returnedFrame, false, "after dispose() captureFrame() MUST NOT return a frame (an empty frame would pass as a result — FR-033)");
  assert.equal(handleContract.postDispose.captureFrame.category, "internal", `after dispose() captureFrame() MUST be reported as category "internal" (got ${JSON.stringify(handleContract.postDispose.captureFrame)})`);
  assert.equal(handleContract.postDispose.canvasRemovedFromHost, true, "the owned canvas MUST be gone after disposal");
  // Both halves of the refusal contract, asserted strictly: the promise rejects **and** the diagnostic
  // reaches subscribers with its true category (FR-004/FR-033 — a refusal reported only through a
  // rejected promise would be invisible to `diagnostics.onError`, and any console line would fail
  // `assertCleanRun` above).
  assert.equal(handleContract.diagnosticsDeliveredAfterDispose, 2, `both post-dispose refusals MUST reach diagnostics.onError (got ${handleContract.diagnosticsDeliveredAfterDispose})`);
  assert.equal(handleContract.diagnostics.length, 2, `the two post-dispose calls MUST each report exactly one diagnostic (got ${JSON.stringify(handleContract.diagnostics)})`);
  assert.deepEqual(handleContract.diagnostics.map((diagnostic) => diagnostic.category), ["internal", "internal"], `post-dispose diagnostics MUST be category "internal" (got ${JSON.stringify(handleContract.diagnostics)})`);
  assert.ok(/dispose/i.test(handleContract.diagnostics[0].message) && /whenTilesLoaded/.test(handleContract.diagnostics[0].message), `the diagnostic MUST name the refused call: ${handleContract.diagnostics[0].message}`);
  assert.ok(/dispose/i.test(handleContract.diagnostics[1].message) && /captureFrame/.test(handleContract.diagnostics[1].message), `the diagnostic MUST name the refused call: ${handleContract.diagnostics[1].message}`);
  assert.equal(handleContract.statuses.length, 1, "the entry MUST publish exactly one status per scene");
  assert.equal(handleContract.statuses[0].active, run.backend, "the handle-contract scene MUST run on this run's backend");

  // ---- the bundle-level provenance the artefact keeps for the reader ------------------------------
  assert.equal(result.fetchWrapperRestored, true, "the scenario MUST leave globalThis.fetch as it found it");
  assert.ok(result.fetchEvidence.acceptance.requests >= result.fetchEvidence.acceptance.tileRequests, "every tile read is a request");

  evidence.verdict = {
    passed: true,
    screenshotRatio,
    capturedRatio,
    ratioDisagreement,
    acceptanceTiles: result.fetchEvidence.acceptance.tileCoordinates,
    tilesLoaded: result.acceptance.tilesLoaded,
    tileCount: tileCount.label,
    oneFrame: {
      drawCalls: acceptance.statsOneFrame.drawCallCount.label,
      trianglesByProductTally: acceptance.statsOneFrame.triangleCount.label,
      trianglesMeasuredFromIndexCounts: geometry.trianglesFromIndices,
      distinctIndexBuffers: geometry.distinctIndexBuffers,
    },
    handleContract: {
      ready: handleContract.ready.state,
      removeCallsAcrossThreeDisposals: handleContract.removeCallsAcrossThreeDisposals,
      postDisposeCaptureFrame: handleContract.postDispose.captureFrame,
      postDisposeDiagnosticsDelivered: handleContract.diagnosticsDeliveredAfterDispose,
    },
    productFindings: productFindings.map((finding) => finding.id),
  };
  writeEvidence(evidence);
});
