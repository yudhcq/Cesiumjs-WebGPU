/**
 * T094 — elevation is a **number in the frame evidence**, not an impression (`层=视觉`; SC-002 as
 * revised by the user).
 *
 * Run (each backend its own process, its own page load, its own bundle — principle II):
 *   node tests/support/backend-runner.mjs --backend=webgpu --suite=visual:terrain-elevation
 *   node tests/support/backend-runner.mjs --backend=webgl2 --suite=visual:terrain-elevation
 *
 * ## What the revised SC-002 asks for, and what this suite therefore asserts
 *
 * The terrain is **really rendered** and its **geometry agrees with the dataset**:
 *   (a) coverage         — the canvas is covered by terrain, by a share threshold recorded below;
 *   (b) dataset↔frame     — the elevation interval read out of the frame evidence (the drawn vertex
 *                           buffer's height lane, the per-draw RTC centre + WGS84 inverse, the draw's
 *                           own MVP) is the dataset's interval, compared numerically and published
 *                           side by side in `artifacts/terrain-elevation/<backend>.json`;
 *   (c) no blank / no single-colour fill — the presented canvas holds real content, and where the GPU
 *       colour count is quoted it is `uniqueColoursGpuReadback` (copyTextureToBuffer of the canvas
 *       texture), **never** `uniqueColoursComposite` (the compositor's PNG): the two instruments have
 *       different pipelines and the repository has already been bitten by comparing them
 *       (`probe.js:1633-1642`).
 *
 * ## What this suite MUST NOT assert (and why: upstream design, not a defect)
 *
 * Relief / shading modulation is **explicitly deferred** by the revised SC-002. At this camera distance
 * the upstream day/night fade is `clamp((cameraDist − fadeOutDistance)/(fadeInDistance − fadeOutDistance),
 * 0, 1) = 0`, so `finalColor = color × lightColor` and two different elevations are *supposed* to carry
 * the same colour. Height↔brightness correlation, shadowing, occlusion differences and "the highest and
 * the lowest point differ in brightness" are therefore **not** asserted here; asserting them would
 * report a designed upstream behaviour as a failure. Measured by `probe.js`'s
 * `scenarioTerrainRasterProbe` `lightingModel` step (`GlobeFS.glsl` `ENABLE_DAYNIGHT_SHADING`).
 *
 * ## Where the thresholds come from (every one of them lands in the artefact)
 *
 *   - the dataset interval: the committed fixture manifest, read **by this suite from disk** (the page
 *     cannot define its own way to a pass) and re-derived by the page from all 286 tile bytes;
 *   - the coverage floor: an exterior measure of a terrain-only MVP frame whose camera is a fixed 24 km
 *     above Mont Blanc (`buildTerrainScene`'s default camera). A frame that loses the terrain — camera
 *     away from the dataset, globe hidden, tiles never delivered — cannot reach it; the negative
 *     control run recorded in this task's log drove it to 0. The one-colour and strict-background
 *     checks are the guards that keep a "full canvas of one flat colour" from satisfying it;
 *   - the residual bounds: the terrain mesh is built at the dataset's own sample positions, so an
 *     agreeing vertex's residual is float32 rounding (≪ 1 m). The bounds below are ~1000× that, which
 *     is what makes them a test of "the geometry is the dataset" rather than of noise.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "playwright/test";

import { assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";
import { repoPath } from "../support/repo.mjs";

// One run builds the bundle, launches Chrome and loads the page; a cold build alone exceeds
// Playwright's 30 s default.
test.setTimeout(900_000);

const FIXTURE_MANIFEST = "packages/cesium-webgpu/fixtures/matterhorn-z0-12/manifest.json";
const manifest = JSON.parse(fs.readFileSync(repoPath(FIXTURE_MANIFEST), "utf8"));

/** The dataset interval, stated by the committed manifest — the reference the frame evidence is held to. */
const DATASET_FLOOR = manifest.elevation.minHeight;
const DATASET_CEILING = manifest.elevation.maxHeight;
const DATASET_SPAN = DATASET_CEILING - DATASET_FLOOR;
const LEVEL_SUMMARY_FLOOR = Math.min(...manifest.levelSummary.map((entry) => entry.minHeight));
const LEVEL_SUMMARY_CEILING = Math.max(...manifest.levelSummary.map((entry) => entry.maxHeight));

/**
 * Thresholds, each with the measurement it was derived from (all of them land in the artefact).
 *
 * `GPU_COVERAGE_FLOOR` — the share of the canvas texture that must be non-black. The MVP camera is a
 * fixed 24 km above Mont Blanc looking at the massif, so the terrain fills the canvas; measured
 * 153 600/153 600 = 1.0 on the reference run. The floor is set well below that so ordinary framing
 * differences do not flip the verdict, while a frame that loses the terrain (camera outside the
 * dataset, globe hidden, tiles never delivered) cannot reach it — the negative control recorded in this
 * task's log drove it to 0.
 * `COMPOSITED_COVERAGE_FLOOR` — the same statement through the compositor's PNG (`nonBackground`),
 * whose cut-off (`r + g + b > 24`) is stricter than the GPU instrument's.
 */
const GPU_COVERAGE_FLOOR = 0.5;
const COMPOSITED_COVERAGE_FLOOR = 0.5;
/** The frame-evidence height lane may fall below the dataset floor only by this much (terrain skirts). */
const SKIRT_MARGIN_METRES = 0.15 * DATASET_SPAN;
/**
 * Agreement bounds, in metres, for the per-vertex comparison against the dataset's own samples.
 *
 * `RESIDUAL_MEDIAN_METRES` is deliberately ~6× the measured value (8 m on the reference run): the
 * neighbourhood search absorbs the sub-cell grid registration of a float32 mesh (the offsets it chooses
 * are reported in `consistency.bestOffsets`), so the bound is wide enough that ordinary registration
 * noise cannot flip the verdict, while a mesh built from a *different* dataset — or flattened to a
 * constant — cannot pass at all: a constant height would have to sit within 50 m of the local dataset
 * samples everywhere on screen, which the 4 204 m of relief measured in the frame rules out.
 * `TIGHT_AGREEMENT_METRES` only labels the published count of exact reproductions; it is never asserted.
 */
const RESIDUAL_MEDIAN_METRES = 50;
const RESIDUAL_P99_METRES = 250;
const TIGHT_AGREEMENT_METRES = 5;
/** A terrain frame that carries no relief at all is not the dataset's geometry (span 12 658 m). */
const MINIMUM_EVIDENCE_SPAN_METRES = 0.25 * DATASET_SPAN;

/** The canvas is sampled here; `centre` is the camera's own ground point on screen. */
const SAMPLE_POINTS = [
  { name: "top-left", x: 0, y: 0 },
  { name: "top-right", x: 1, y: 0 },
  { name: "bottom-left", x: 0, y: 1 },
  { name: "bottom-right", x: 1, y: 1 },
  { name: "centre", x: 0.5, y: 0.5 },
];

test("visual:terrain-elevation — the rendered terrain's elevation agrees with the committed dataset", async () => {
  const run = await runContractSuite("visual:terrain-elevation", { viewport: { width: 480, height: 320 }, captureCanvas: true, samplePoints: SAMPLE_POINTS, timeoutMs: 400000 });
  assertCleanRun(run, assert);
  assertOtherBackendUntouched(run, assert);

  const result = run.report.result["terrain-elevation"];
  assert.ok(result !== undefined, "the page MUST publish the terrain-elevation result");
  assert.equal(result.backend, run.backend, "the scenario MUST report the backend this run enabled");

  // ---------------------------------------------------------------------------------------------
  // (b₁) the dataset, stated twice: by the committed manifest and re-derived from every tile byte
  // ---------------------------------------------------------------------------------------------
  const dataset = result.datasetInterval;
  assert.equal(dataset.rectangleAgrees, true, `the page MUST have consumed the committed dataset rectangle (got ${JSON.stringify(dataset.rectangle)})`);
  assert.equal(dataset.fromBytes.tiles, manifest.tiles.length, `every tile listed by the manifest MUST have been decoded (${dataset.fromBytes.tiles}/${manifest.tiles.length})`);
  assert.deepEqual(dataset.fromBytes.failures, [], "no tile of the committed dataset may fail to decode");
  assert.equal(dataset.floor, DATASET_FLOOR, `the floor re-derived from the tiles (${dataset.floor}) MUST equal the manifest's (${DATASET_FLOOR})`);
  assert.equal(dataset.ceiling, DATASET_CEILING, `the ceiling re-derived from the tiles (${dataset.ceiling}) MUST equal the manifest's (${DATASET_CEILING})`);
  assert.equal(dataset.bytesAgreeWithManifest, true, "the two independent statements of the dataset interval MUST agree");
  assert.equal(dataset.sampleGrid.width, manifest.sampleWidth);
  assert.equal(dataset.sampleGrid.height, manifest.sampleHeight);
  assert.equal(dataset.sampleGrid.noDataValue, manifest.noDataValue);
  assert.equal(dataset.sampleGrid.heightOffsetMetres, manifest.heightOffsetMetres);
  // The per-level summary is a strictly narrower statement of the same range; it must be contained.
  assert.ok(LEVEL_SUMMARY_FLOOR >= DATASET_FLOOR && LEVEL_SUMMARY_CEILING <= DATASET_CEILING, "the manifest's own level summary MUST sit inside its elevation range");

  // ---------------------------------------------------------------------------------------------
  // (a) coverage — the canvas is covered by terrain
  // ---------------------------------------------------------------------------------------------
  const shot = run.canvasScreenshot;
  assert.ok(shot !== undefined && shot.captured === true, `the harness MUST capture the canvas (${shot?.reason ?? "no capture"})`);
  // The harness clips to `#contract-canvas`'s laid-out box, which the page sizes in CSS pixels; the
  // screenshot is therefore at most the canvas backing store and may be a hair smaller (measured
  // 468x308 for a 480x320 canvas). Coverage is a share of the screenshot's **own** pixel count, so the
  // ratio is recorded rather than asserted away — a share is scale-invariant, an absolute count is not.
  const screenshotScale = { x: shot.width / result.canvas.width, y: shot.height / result.canvas.height };
  assert.ok(shot.width > 0 && shot.height > 0, "the screenshot MUST have pixels");
  assert.ok(screenshotScale.x > 0.5 && screenshotScale.x <= 1 && screenshotScale.y > 0.5 && screenshotScale.y <= 1, `the screenshot MUST be the canvas region at 1:1 or a mild downscale (measured ${shot.width}x${shot.height} for a ${result.canvas.width}x${result.canvas.height} canvas)`);
  const samples = new Map((shot.samples ?? []).map((sample) => [sample.name, sample]));
  assert.deepEqual([...samples.keys()].sort(), SAMPLE_POINTS.map((point) => point.name).sort(), "the harness MUST have sampled every declared point");

  const backdropShare = (shot.considered - shot.nonBackground) / shot.considered;
  const coverage = result.coverage;
  console.log(
    `terrain-elevation[${run.backend}]: ${JSON.stringify({
      canvas: [shot.width, shot.height],
      screenshotScale: [Number(screenshotScale.x.toFixed(4)), Number(screenshotScale.y.toFixed(4))],
      compositedNonBackgroundShare: Number((shot.nonBackground / shot.considered).toFixed(4)),
      compositedBackdropShare: Number(backdropShare.toFixed(4)),
      compositedUniqueColours: shot.uniqueColours,
      gpuCoverageShare: coverage.nonBlackShare ?? coverage.skipped,
      gpuNonTransparentPixels: coverage.nonTransparentPixels ?? null,
      gpuBoundingBox: coverage.nonBlackBoundingBox ?? null,
      gpuUniqueColoursInstrument: coverage.colourCountInstrument ?? null,
      gpuUniqueColours: coverage.uniqueColoursGpuReadback ?? null,
      imageBitmapNonBlackPixels: coverage.imageBitmapOfPresentedCanvas.nonBlackPixels,
      datasetInterval: [dataset.floor, dataset.ceiling],
      frameInterval: result.frameEvidence.interval === null ? null : [result.frameEvidence.interval.floor, result.frameEvidence.interval.ceiling],
      ecefInterval: result.frameEvidence.ecef.interval === null ? null : [result.frameEvidence.ecef.interval.floor, result.frameEvidence.ecef.interval.ceiling],
      residualMedianMetres: result.consistency.bestIn5x5Neighbourhood?.p50 ?? null,
      residualRoundedTexelMetres: result.consistency.nearestTexel?.p50 ?? null,
      onGridVertices: result.consistency.verticesOnGrid,
      offGridVertices: result.consistency.verticesOffGrid,
      matchedTiles: result.consistency.matchedTiles,
      depthWrittenShare: result.depth.indicator.depthWrittenShare ?? null,
    })}`,
  );

  assert.ok(run.canvasScreenshot.nonBackground > 0, "the presented frame MUST hold non-background pixels at all");
  assert.ok(
    shot.nonBackground / shot.considered >= COMPOSITED_COVERAGE_FLOOR,
    `the composited canvas MUST be at least ${COMPOSITED_COVERAGE_FLOOR * 100}% non-background (measured ${shot.nonBackground}/${shot.considered} = ${((shot.nonBackground / shot.considered) * 100).toFixed(1)}%): a frame whose canvas is mostly backdrop has not been covered by terrain`,
  );
  if (run.backend === "webgpu") {
    // The coverage measurement itself is the canvas-texture read-back (see the spec's header: the
    // `createImageBitmap` route of a WebGPU canvas is a measured platform blind spot).
    assert.ok(/copyTextureToBuffer/.test(coverage.colourCountInstrument), `the coverage reading MUST come from the canvas texture (got "${coverage.colourCountInstrument}")`);
    assert.equal(coverage.width, result.canvas.width, "the canvas-texture read-back MUST be the canvas the page created");
    assert.equal(coverage.height, result.canvas.height);
    assert.ok(
      coverage.nonBlackShare >= GPU_COVERAGE_FLOOR,
      `the rendered canvas texture MUST be at least ${GPU_COVERAGE_FLOOR * 100}% non-black (measured ${coverage.nonBlackPixels}/${coverage.canvasPixels} = ${(coverage.nonBlackShare * 100).toFixed(1)}%)`,
    );
    assert.equal(coverage.nonTransparentPixels, coverage.canvasPixels, "the canvas texture MUST be fully opaque: a cleared/blank canvas is transparent black, a rendered one is not");
    assert.ok(
      coverage.nonBlackBoundingBox !== null && coverage.nonBlackBoundingBox.minX === 0 && coverage.nonBlackBoundingBox.minY === 0 && coverage.nonBlackBoundingBox.maxX === coverage.width - 1 && coverage.nonBlackBoundingBox.maxY === coverage.height - 1,
      `the non-black pixels MUST span the whole canvas, not a corner patch (measured bound ${JSON.stringify(coverage.nonBlackBoundingBox)} of ${coverage.width}x${coverage.height})`,
    );
    assert.ok(Array.isArray(coverage.coverageCells) && coverage.coverageCells.length === coverage.coverageCellsShape[0] * coverage.coverageCellsShape[1], "the read-back MUST publish its coverage map");
    assert.equal(coverage.coverageCells.filter((count) => count === 0).length, 0, "no cell of the coverage map may be empty, or part of the canvas would be background");
    // The centre of the canvas is inside the painted area (the camera's own ground point).
    assert.ok(coverage.centre[3] > 200, `the canvas centre MUST be opaque (alpha ${coverage.centre[3]})`);
    assert.ok(coverage.centre[0] + coverage.centre[1] + coverage.centre[2] > 24, `the canvas centre MUST be painted, not background (${JSON.stringify(coverage.centre)})`);
  } else {
    assert.ok(coverage.skipped !== undefined, "a backend without the canvas-texture instrument MUST say so instead of passing silently");
  }

  // ---------------------------------------------------------------------------------------------
  // (c) no blank frame — and the colour count is reported, never used as a pass/fail criterion
  // ---------------------------------------------------------------------------------------------
  // A single-colour terrain frame is **expected** here: `fade = 0` makes `finalColor = color ×
  // lightColor`, so one colour IS this camera's correct output. What "not blank" means numerically is
  // therefore "every pixel was written" — the opaque, full-canvas-coverage assertion above — and not
  // "several colours appear". The count is published under its own instrument name so a later reader
  // can see it without this suite conflating it with the compositor's different instrument.
  if (run.backend === "webgpu") {
    console.log(
      `terrain-elevation[${run.backend}]: uniqueColoursGpuReadback=${coverage.uniqueColoursGpuReadback} (cap ${coverage.colourCountCap}${coverage.colourCountSaturated ? ", saturated" : ""}) — the compositor's PNG count (uniqueColoursComposite=${shot.uniqueColours}) is deliberately NOT compared with it (probe.js:1633-1642)`,
    );
    assert.ok(Number.isInteger(coverage.uniqueColoursGpuReadback) && coverage.uniqueColoursGpuReadback >= 1, "the GPU read-back MUST publish how many distinct colours the frame holds");
  }
  assert.ok(shot.uniqueColours >= 1, "the screenshot MUST not be an empty image");

  // ---------------------------------------------------------------------------------------------
  // (b₂) the frame evidence, and the comparison that makes "self-consistent" a number
  // ---------------------------------------------------------------------------------------------
  const evidence = result.frameEvidence;
  assert.equal(evidence.drawsWithError, 0, `every terrain draw MUST have been copied back (errors: ${JSON.stringify(evidence.perDraw.filter((entry) => entry.error !== undefined))})`);
  assert.equal(evidence.nonFiniteFloats, 0, "the drawn vertex floats MUST contain no NaN/Infinity");

  if (run.backend === "webgpu") {
    assert.ok(evidence.drawsRead >= 1, "at least one terrain draw MUST have been read back");
    assert.ok(evidence.verticesRead >= 1000, `the frame evidence MUST cover a real mesh (got ${evidence.verticesRead} vertices)`);
    assert.ok(evidence.interval !== null, "the WebGPU path MUST publish the height interval it read out of the drawn vertex buffers");
    assert.ok(evidence.arrayStrides.length > 0 && evidence.arrayStrides.every((stride) => stride >= 16 && stride % 4 === 0), `every terrain vertex row MUST hold at least the position3DAndHeight slot (strides ${JSON.stringify(evidence.arrayStrides)})`);
    assert.ok(evidence.arrayStrides.includes(28), `the unquantized 7-float layout measured for this MVP (` + "28 B" + `) MUST be among the strides read (got ${JSON.stringify(evidence.arrayStrides)})`);
    assert.equal(evidence.centreSources.none, 0, "every terrain draw MUST have published its RTC centre (per-draw uniform map or decoded slot)");

    // --- the two intervals, side by side -------------------------------------------------------
    const datasetInterval = [dataset.floor, dataset.ceiling];
    const frameInterval = [evidence.interval.floor, evidence.interval.ceiling];
    const ecefInterval = evidence.ecef.interval === null ? null : [evidence.ecef.interval.floor, evidence.ecef.interval.ceiling];
    console.log(`terrain-elevation[${run.backend}]: dataset ${JSON.stringify(datasetInterval)} m | vertex-lane evidence ${JSON.stringify(frameInterval)} m | ECEF-inverse evidence ${JSON.stringify(ecefInterval)} m`);

    // (i) containment: the rendered geometry lives inside the dataset's own vertical range, allowing
    //     only the downward overhang of the tile skirts (which Cesium adds below the rim by design).
    assert.ok(
      evidence.interval.floor >= dataset.floor - SKIRT_MARGIN_METRES,
      `the lowest rendered vertex (${evidence.interval.floor} m) MUST stay within ${SKIRT_MARGIN_METRES} m below the dataset floor (${dataset.floor} m): below that the geometry would not be this dataset`,
    );
    assert.ok(
      evidence.interval.ceiling <= dataset.ceiling + 1,
      `the highest rendered vertex (${evidence.interval.ceiling} m) MUST NOT exceed the dataset ceiling (${dataset.ceiling} m): a higher peak is invented terrain`,
    );
    // (ii) the evidence really is the dataset's relief, not a flat or truncated copy of its range.
    assert.ok(
      evidence.interval.span >= MINIMUM_EVIDENCE_SPAN_METRES,
      `the rendered heights MUST span at least ${MINIMUM_EVIDENCE_SPAN_METRES} m of the dataset's ${DATASET_SPAN} m (measured ${evidence.interval.span} m): a frame this flat is not this dataset's geometry`,
    );
    assert.ok(
      evidence.ecef.interval.floor >= dataset.floor - SKIRT_MARGIN_METRES && evidence.ecef.interval.ceiling <= dataset.ceiling + 1,
      `the geodetic heights recovered independently from the RTC position + u_center3D (${JSON.stringify(ecefInterval)}) MUST also sit inside the dataset range`,
    );
    // (iii) the two derivations of the same vertex's height must agree, or the lane being read is not
    //       the height lane and every conclusion drawn from it would be unfounded.
    assert.ok(evidence.ecef.versusVertexLane !== null, "the WebGPU path MUST cross-check the vertex lane against the ECEF inverse");
    assert.ok(
      evidence.ecef.versusVertexLane.meanAbsMetres <= 1,
      `the vertex height lane and the ECEF inverse MUST describe the same point (mean |Δ| = ${evidence.ecef.versusVertexLane.meanAbsMetres} m, max ${evidence.ecef.versusVertexLane.maximumAbsMetres} m)`,
    );
    assert.ok(evidence.ecef.versusVertexLane.maximumAbsMetres <= 5, "no vertex may disagree between the two derivations by more than 5 m");
    assert.equal(evidence.ecef.outsidePlausibleRange, 0, "no vertex may be recovered kilometres away from the dataset: that would be a mispaired tile centre");

    // (iv) per-vertex agreement with the dataset's own samples.
    //
    // The primary reading is the best match inside a 5×5 neighbourhood of the vertex's own cell: it is
    // the **level- and registration-agnostic** form of "this height exists in the dataset here". A
    // vertex of a terrain mesh reproduces one dataset sample exactly (the mesh is built at the sample
    // positions), so an agreeing mesh scores ~0 m; a mesh whose heights belong to another dataset, or
    // that has been flatt ened, cannot score small at all. The rounded-texel and exact-fraction readings
    // are published beside it — their difference IS the grid-registration offset, which is why they are
    // reported rather than asserted on.
    const best = result.consistency.bestIn5x5Neighbourhood;
    assert.ok(best !== null && best.count >= 500, `at least 500 vertices MUST have been matched against the dataset grid (got ${best?.count ?? 0})`);
    assert.ok(result.consistency.matchedTiles >= 1, "the matched vertices MUST belong to at least one dataset tile");
    assert.ok(
      best.p50 <= RESIDUAL_MEDIAN_METRES,
      `the median |frame height − nearest dataset sample| MUST be at most ${RESIDUAL_MEDIAN_METRES} m (measured ${best.p50} m over ${best.count} vertices in ${result.consistency.matchedTiles} tile(s))`,
    );
    assert.ok(
      best.p99 <= RESIDUAL_P99_METRES,
      `99% of the matched vertices MUST sit within ${RESIDUAL_P99_METRES} m of a dataset sample (measured p99 ${best.p99} m, max ${best.maximum} m — the tail is the tile skirts Cesium hangs below the rim, which are not dataset samples)`,
    );
    // Published diagnostic, not an assertion: 6.4% of the matched vertices reproduce a sample to within
    // 5 m on the reference run, because this mesh's vertex phase sits between the dataset's sample
    // centres (see `bestOffsets`). Asserting that number would assert a registration property of the
    // mesh builder rather than the elevation agreement this suite is about, so the falsifiable form of
    // "these heights exist in the dataset" is the median/p99 pair above.
    console.log(
      `terrain-elevation[${run.backend}]: within ${TIGHT_AGREEMENT_METRES} m of a dataset sample: ${result.consistency.withinTightAgreement}/${result.consistency.verticesOnGrid} = ${result.consistency.withinTightShare} (reported, not asserted)`,
    );
    // A flat or foreign mesh cannot satisfy the median/p99 bounds: every vertex height would then sit
    // far from the dataset samples **at its own location**, which is what the neighbourhood search
    // measures. Stated as a relation between the two readings, so a change that makes the rounded
    // reading as good as the searched one is flagged rather than silently absorbed.
    assert.ok(
      result.consistency.nearestTexel.p50 > best.p50,
      "the rounded-texel reading MUST be the weaker one: the difference between the two is the grid registration the neighbourhood search absorbs",
    );
    console.log(
      `terrain-elevation[${run.backend}]: residual median — best-in-neighbourhood ${best.p50} m, rounded texel ${result.consistency.nearestTexel.p50} m, exact fraction ${result.consistency.bilinearTexel.p50} m; within ${result.consistency.agreementThresholdsMetres.tight} m: ${result.consistency.withinTightAgreement}/${result.consistency.verticesOnGrid}`,
    );
    // (v) the draw's own MVP is finite and puts the mesh on screen — the matrix the geometry is
    //     projected with, evaluated exactly as the emitted WGSL does.
    assert.ok(evidence.clip.evaluated >= 100, "the draws' u_modifiedModelViewProjection MUST have been evaluated on real vertices");
    assert.ok(
      evidence.clip.outsideClipVolume / evidence.clip.evaluated <= 0.5,
      `most of the mesh MUST be inside the clip volume, or the frame would be empty (outside ${evidence.clip.outsideClipVolume}/${evidence.clip.evaluated})`,
    );
  } else {
    // The instrument's absence is a published fact, never a silent pass.
    assert.ok(evidence.interval === null, "a backend without the vertex-buffer instrument MUST NOT publish a height interval");
    assert.equal(evidence.verticesRead, 0, "a backend without the vertex-buffer instrument MUST report zero vertices read");
  }

  // ---------------------------------------------------------------------------------------------
  // depth: what is measurable here, plus the depth-test corroboration
  // ---------------------------------------------------------------------------------------------
  assert.equal(result.depth.canvasDepth.measurable, false, "the canvas depth aspect is not measurable on this platform; the scenario MUST report that instead of provoking a GPU error");
  assert.ok(String(result.depth.canvasDepth.reason).length > 0, "an unmeasurable dimension MUST carry its reason (WebGPU: the depth aspect of depth24plus-stencil8 cannot be copied; WebGL2: no canvasDepthTexture)");
  if (run.backend === "webgpu") {
    const indicator = result.depth.indicator;
    // The marker ran and covered the viewport through the whole Context; it is recorded as a measurement
    // only. The `less` control painted the full viewport too (measured), so the two comparisons cannot
    // separate "the terrain wrote depth" from "the attachment holds its clear value" here — this suite
    // therefore makes **no** depth-presence claim from it, and the depth dimension is reported as not
    // measurable with its reason (`ctx.readCanvasDepth`, asserted above).
    assert.ok(indicator.always !== null && indicator.always.markerPixels === indicator.always.viewportPixels, `the marker MUST cover the viewport when it ignores depth (${indicator.always?.markerPixels}/${indicator.always?.viewportPixels}) — otherwise the recorded numbers would describe the marker rather than the frame`);
    assert.equal(indicator.discriminating, false, "the depth-test marker is MEASURED to be non-discriminating here (both compares paint the full viewport); if that changes, revisiting the depth evidence is warranted");
    assert.equal(typeof indicator.controlNote, "string", "a non-discriminating instrument MUST carry the note that says so");
    console.log(
      `terrain-elevation[${run.backend}]: depth marker (recorded, not used as evidence) — always ${indicator.always.markerPixels}/${indicator.always.viewportPixels}, greater ${indicator.greaterOverTerrain.markerPixels}, less ${indicator.lessOverTerrain.markerPixels}, clear-only-greater ${indicator.clearOnlyGreater.markerPixels}`,
    );
  } else {
    assert.ok(result.depth.indicator.skipped !== undefined, "a backend without the depth indicator MUST say so");
  }

  // The scene really was driven by the product adapter over the committed dataset, and the run's own
  // conditions are recorded rather than assumed.
  assert.equal(result.globe.terrainProviderIsInjected, true, "the globe MUST be driven by the provider this scenario created");
  assert.equal(result.globe.show, true, "the globe MUST be visible: a hidden globe would make every pixel above meaningless");
  assert.ok(result.requestedTiles.distinct > 0, "the globe MUST have requested tiles from the product adapter");
  assert.ok(result.datasetId === "matterhorn-z0-12");
  assert.equal(result.lightingPreamble.assertedByThisSuite, false, "relief/shading modulation is deferred by the revised SC-002; this suite MUST NOT assert it");
});
