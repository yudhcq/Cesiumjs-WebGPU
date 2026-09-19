/**
 * T088 — data unavailability and render failure are **distinguishable** (FR-004 / contract TS-5).
 *
 * Run (each backend its own process, its own page load — principle II):
 *   node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain-unavailable
 *   node tests/support/backend-runner.mjs --backend=webgl2 --suite=contract:terrain-unavailable
 *
 * What this suite is allowed to claim, and on what evidence:
 *
 *  (a) **No uncaught failure**: a page where part of the tiles cannot be read is not a failing page
 *      (`assertCleanRun`: no page error, no console error, no error reported by the page itself).
 *  (b) **The classification is exact, and it discriminates**: every fault of the "data" family —
 *      a tile missing from the committed dataset, a reader that rejects, a reader that never settles,
 *      a tile that carries no valid sample — is reported as `category: "data-unavailable"`, with the
 *      fault named by `failure`. Undecodable bytes and an unparseable manifest are the **reverse
 *      controls**: they MUST be classified `"decode"`, i.e. the label is measured rather than recited.
 *      Without that contrast, "the happy path is labelled correctly" would prove nothing.
 *  (c) **The remaining tiles keep rendering**: the frame loop advances while the failures happen,
 *      tiles keep being delivered after the first failure, the globe reaches `tilesLoaded`, the
 *      presented canvas holds non-background pixels and the terrain path made draws.
 *  (d) **No error geometry**: every buffer handed upstream is finite and inside the committed
 *      dataset's own vertical range, a degraded tile is flat (no spike, no NaN), and on the WebGPU
 *      path the floats copied back out of the draw's vertex buffer contain no non-finite value.
 *      All of it numeric; nothing here is judged by eye.
 *  (e) **One backend per run**: the other backend created zero GPU objects (`assertOtherBackendUntouched`).
 *
 * The bounds in (d) come from the committed fixture manifest read **here**, not from the page's own
 * report, so the page cannot define its way to a pass.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "playwright/test";

import { assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";
import { repoPath } from "../support/repo.mjs";

test.setTimeout(900_000);

const FIXTURE_MANIFEST = "packages/cesium-webgpu/fixtures/matterhorn-z0-12/manifest.json";
const manifest = JSON.parse(fs.readFileSync(repoPath(FIXTURE_MANIFEST), "utf8"));
const SAMPLE_COUNT = manifest.sampleWidth * manifest.sampleHeight;
const DATASET_FLOOR = Math.min(...manifest.levelSummary.map((entry) => entry.minHeight));
const DATASET_CEILING = Math.max(...manifest.levelSummary.map((entry) => entry.maxHeight));

/** The categories the product vocabulary reserves for a *data* problem (api/types.ts: FR-004). */
const DATA_UNAVAILABLE = "data-unavailable";

test("unavailable terrain data is a classified state and the remaining tiles keep rendering", async () => {
  const run = await runContractSuite("contract:terrain-unavailable", { viewport: { width: 384, height: 288 }, timeoutMs: 420000 });
  const report = run.report;
  assert.ok(report !== null, "the page MUST publish a report");

  // (a) The page itself must be clean: a tile that cannot be read is data, not an exception.
  assertCleanRun(run, assert);

  const result = report.result["terrain-unavailable"];
  assert.ok(result !== undefined, "the scenario MUST publish its result");

  // The scenario measured the product constant through the published bundle, and the fixture it was
  // pointed at is the committed one.
  assert.ok(Number.isFinite(result.tileTimeoutDefaultMs) && result.tileTimeoutDefaultMs > 0, "a tile read MUST be bounded by default");
  assert.equal(result.dataset.tileCount, manifest.tiles.length, "the scenario MUST have consumed the committed dataset");
  assert.equal(result.dataset.noDataValue, manifest.noDataValue);

  // -------------------------------------------------------------------------------------------
  // (b) classification: exact, and able to discriminate
  // -------------------------------------------------------------------------------------------
  const arms = result.classification;
  // The four faults of the "data" family. An undecodable tile is deliberately **not** in this loop:
  // it is the reverse control below, and it must be classified differently.
  for (const name of ["missing", "readerError", "timeout", "empty"]) {
    const arm = arms[name];
    assert.ok(arm.diagnostics.length > 0, `${name}: the fault MUST be reported instead of thrown`);
    assert.deepEqual(arm.categories, [DATA_UNAVAILABLE], `${name}: the fault MUST be reported with exactly one category, "data-unavailable"`);
    assert.equal(arm.nonFinite, 0, `${name}: the degraded tile MUST contain no NaN/Infinity sample`);
    assert.equal(arm.flat, true, `${name}: the degraded tile MUST be flat — no spike, no hole through the surface`);
    assert.equal(arm.samples, SAMPLE_COUNT, `${name}: the degraded tile MUST keep the dataset's sample shape`);
    assert.ok(arm.minimum >= DATASET_FLOOR && arm.maximum <= DATASET_CEILING, `${name}: ${arm.minimum}..${arm.maximum} MUST stay inside the committed dataset range ${DATASET_FLOOR}..${DATASET_CEILING}`);
    for (const diagnostic of arm.diagnostics) {
      assert.equal(typeof diagnostic.reason, "string");
      assert.ok(diagnostic.reason.length > 0, `${name}: a diagnostic MUST carry a reason`);
      assert.equal(typeof diagnostic.failure, "string");
      assert.ok(diagnostic.tilePath.includes("matterhorn-z0-12"), `${name}: the diagnostic MUST name the file it is about (${diagnostic.tilePath})`);
      assert.equal(typeof diagnostic.level, "number");
    }
  }

  // Each fault keeps its own identity — "data-unavailable" for all four is the *point*, and the
  // sub-classification is what makes them actionable.
  assert.deepEqual(arms.missing.failures, ["missing"]);
  assert.deepEqual(arms.readerError.failures, ["reader-error"]);
  assert.deepEqual(arms.timeout.failures, ["timeout"]);
  assert.deepEqual(arms.empty.failures, ["empty"]);
  // A tile that is not in the committed manifest is answered from the manifest: nothing is fetched.
  assert.equal(arms.missing.readsForTheMissingTile, 0, "a tile absent from the manifest MUST NOT be read at all");
  // A reader that never settles is bounded: the page waited for the timeout, and no longer.
  assert.ok(arms.timeout.elapsedMs >= result.tileTimeoutMs, `the timeout arm MUST have waited for the bound (${arms.timeout.elapsedMs} ms)`);
  assert.ok(arms.timeout.elapsedMs < result.tileTimeoutMs + 10_000, `the timeout arm MUST settle at the bound (${arms.timeout.elapsedMs} ms)`);

  // REVERSE CONTROLS — the same channel, a different fault, a different category.
  assert.deepEqual(arms.decode.failures, ["decode-error"]);
  assert.deepEqual(
    arms.decode.categories,
    ["decode"],
    "an undecodable tile MUST NOT be labelled data-unavailable: if both faults shared a label, the label would distinguish nothing",
  );
  assert.equal(arms.refused.unparseableManifest.rejected, true, "an unparseable manifest MUST refuse the provider");
  assert.equal(arms.refused.unparseableManifest.category, "decode");
  assert.equal(arms.refused.unreachableManifest.rejected, true, "an unreachable manifest MUST refuse the provider");
  assert.equal(arms.refused.unreachableManifest.category, DATA_UNAVAILABLE);
  assert.notEqual(
    arms.refused.unparseableManifest.category,
    arms.refused.unreachableManifest.category,
    "the two provider-level refusals MUST be distinguishable from each other",
  );

  // A data problem MUST NOT be reported as a render failure, on either channel: the scene raised
  // nothing, and no data-unavailable classification leaked into a render-error record.
  assert.deepEqual(result.scene.renderErrors, [], "a tile we cannot read MUST NOT surface as a scene render error");
  assert.deepEqual(result.scene.frameErrors, [], "a tile we cannot read MUST NOT break a frame");
  for (const entry of result.scene.renderErrors) {
    assert.notEqual(entry.category, DATA_UNAVAILABLE, "a render-error record MUST NOT carry the data-unavailable category");
  }

  // -------------------------------------------------------------------------------------------
  // (c) the remaining tiles keep rendering
  // -------------------------------------------------------------------------------------------
  const mixed = result.mixed;
  assert.ok(mixed.diagnostics.length > 0, "the mixed arm MUST have produced failures — otherwise it proves nothing about the failing case");
  assert.deepEqual(mixed.categories, [DATA_UNAVAILABLE], "every failure of the mixed arm MUST be classified data-unavailable");
  assert.ok((mixed.failureCounts["reader-error"] ?? 0) > 0, "the mixed arm MUST include a rejecting reader");
  assert.ok((mixed.failureCounts.timeout ?? 0) > 0, "the mixed arm MUST include a reader that never settles");
  assert.equal(mixed.unclassifiedDiagnostics, 0, "every mixed-arm failure MUST be a full diagnostic, not an anonymous error");
  for (const diagnostic of mixed.diagnostics) {
    assert.ok(diagnostic.tilePath.includes("/matterhorn-z0-12/"), `the diagnostic MUST name the tile it is about (${diagnostic.tilePath})`);
    assert.equal(typeof diagnostic.level, "number");
    assert.equal(typeof diagnostic.x, "number");
    assert.equal(typeof diagnostic.y, "number");
    assert.ok(diagnostic.reason.length > 0);
  }

  const early = result.progress.early;
  const first = early[0];
  const lastEarly = early[early.length - 1];
  const late = result.progress.late;
  // The loop advanced **while** the failures were happening, and the failures did not stop the
  // tile pipeline: more tiles were delivered after the first failures than before them.
  assert.ok(lastEarly.frames > first.frames, `the frame count MUST keep growing while tiles fail (${first.frames} → ${lastEarly.frames})`);
  assert.ok(late.frames > lastEarly.frames, `the frame count MUST keep growing after the failures (${lastEarly.frames} → ${late.frames})`);
  assert.ok(lastEarly.diagnostics >= first.diagnostics, "failures MUST be observable while they happen");
  assert.ok(late.delivered > lastEarly.delivered, `tiles MUST keep being delivered after failures started (${lastEarly.delivered} → ${late.delivered})`);
  assert.ok(late.reads > 0, "the reader MUST have been used — a scenario that reads nothing cannot fail");

  assert.equal(result.scene.tilesLoaded, true, "the globe MUST report the visible tiles loaded: a failed read degrades a tile, it does not block the queue");
  assert.ok(result.scene.frameTimes.count > 10, `the run MUST have rendered many frames (got ${result.scene.frameTimes.count})`);
  assert.ok(result.scene.frameTimes.maximumMs < 1000, `no frame may stall for more than 1000 ms (worst frame ${result.scene.frameTimes.maximumMs} ms) — the page MUST NOT freeze while data is unavailable`);
  assert.equal(result.scene.terrainProviderName, "CustomHeightmapTerrainProvider", "the scene MUST be driven by the product terrain provider");

  assert.ok(result.geometry.delivered > 0, "the provider MUST have delivered tiles to the scene");
  assert.ok(result.geometry.realTiles > 0, `the healthy tiles MUST still deliver real data (real ${result.geometry.realTiles} / degraded ${result.geometry.degradedTiles})`);
  assert.ok(result.geometry.degradedTiles > 0, "the failing tiles MUST have been delivered as degraded buffers, not dropped");

  // The presentation evidence the harness takes after the page reports ready.
  assert.ok(run.canvasScreenshot !== undefined && run.canvasScreenshot.captured === true, `the canvas MUST be capturable: ${JSON.stringify(run.canvasScreenshot)}`);
  assert.ok(run.canvasScreenshot.nonBackground > 0, `the presented frame MUST hold non-background pixels (got ${run.canvasScreenshot.nonBackground})`);
  assert.ok(run.canvasScreenshot.uniqueColours >= 1, "the presented frame MUST not be an empty image");

  // -------------------------------------------------------------------------------------------
  // (d) no error geometry — numeric only
  // -------------------------------------------------------------------------------------------
  assert.equal(result.geometry.nonFiniteSamples, 0, "no delivered buffer may contain a non-finite sample");
  assert.equal(result.geometry.widestDegradedRange, 0, "a degraded tile MUST be flat: any spread would be invented terrain");
  assert.ok(
    result.geometry.minimum >= DATASET_FLOOR && result.geometry.maximum <= DATASET_CEILING,
    `the delivered heights ${result.geometry.minimum}..${result.geometry.maximum} MUST stay inside the committed dataset range ${DATASET_FLOOR}..${DATASET_CEILING}: a sample outside it is a spike`,
  );
  for (const tile of result.geometry.sample) {
    assert.equal(tile.nonFinite, 0, `${tile.tile}: MUST contain no NaN/Infinity sample`);
    if (tile.flat === true) {
      assert.equal(tile.distinctSampleValues, 1, `${tile.tile}: a degraded tile MUST be flat`);
    } else {
      assert.ok(tile.distinctSampleValues > 1, `${tile.tile}: a served tile MUST carry real terrain, not a constant`);
    }
  }

  // The GPU-side corroboration. On the WebGPU path the drawn vertex buffer is copied back and the
  // values the shader would consume are checked directly; a path where the instrument is unavailable
  // MUST say so explicitly rather than pass silently.
  assert.ok(result.vertexBuffer !== null, "the scenario MUST report the vertex-buffer measurement or its absence");
  if (run.backend === "webgpu") {
    assert.equal(
      result.vertexBuffer.ok,
      true,
      `the WebGPU path MUST copy back the drawn vertex buffer (${result.vertexBuffer.reason ?? "no reason given"})`,
    );
    assert.equal(result.vertexBuffer.nonFinite, 0, "the vertex floats the draw names MUST contain no NaN/Infinity");
  } else {
    assert.equal(result.vertexBuffer.ok, false);
    assert.ok(result.vertexBuffer.reason.length > 0, "an unavailable measurement MUST carry a reason");
  }
  if (run.backend === "webgpu") {
    assert.ok(result.frame !== null && result.frame !== undefined, "the WebGPU path MUST publish the canvas-texture readback of the settled frame");
    // The readback is a *second* instrument on the same frame; the authoritative presentation evidence
    // is the harness screenshot asserted above (a composited screenshot is what the user sees).
    assert.equal(result.frame.width, 384);
    assert.equal(result.frame.height, 288);
    assert.ok(Number.isFinite(result.frame.nonBlackPixels) && result.frame.nonBlackPixels >= 0, "the frame readback MUST publish a finite pixel count");
    assert.ok(Array.isArray(result.frame.coverageCells) && result.frame.coverageCells.length > 0, "the frame readback MUST publish its coverage map");
    assert.ok(Number.isFinite(result.frame.maxChannel), "the frame readback MUST publish the strongest channel value it saw");
  }

  // -------------------------------------------------------------------------------------------
  // (e) one backend per run
  // -------------------------------------------------------------------------------------------
  assertOtherBackendUntouched(run, assert);

  console.log(
    `terrain-unavailable[${run.backend}]: ${JSON.stringify({
      categories: mixed.categories,
      failureCounts: mixed.failureCounts,
      classificationArms: Object.fromEntries(
        Object.entries(arms).map(([name, arm]) => [name, name === "refused" ? { unparseable: arm.unparseableManifest.category, unreachable: arm.unreachableManifest.category } : arm.categories]),
      ),
      delivery: { real: result.geometry.realTiles, degraded: result.geometry.degradedTiles, nonFiniteSamples: result.geometry.nonFiniteSamples },
      heightRange: [result.geometry.minimum, result.geometry.maximum],
      tilesLoaded: result.scene.tilesLoaded,
      frames: result.scene.frameTimes.count,
      worstFrameMs: result.scene.frameTimes.maximumMs,
      canvasScreenshot: { nonBackground: run.canvasScreenshot.nonBackground, uniqueColours: run.canvasScreenshot.uniqueColours },
      vertexBuffer: result.vertexBuffer.ok === true ? { ok: true, nonFinite: result.vertexBuffer.nonFinite, range: [result.vertexBuffer.minimum, result.vertexBuffer.maximum] } : { ok: false, reason: result.vertexBuffer.reason },
    })}`,
  );
});
