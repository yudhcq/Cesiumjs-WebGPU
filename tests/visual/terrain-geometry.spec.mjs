/**
 * T093 — geometric defects caught by **numbers** (`层=视觉`, FR-016).
 *
 * Run (one backend per process, one page load each — principle II):
 *   node tests/support/backend-runner.mjs --backend=webgpu --suite=visual:terrain-geometry
 *   node tests/support/backend-runner.mjs --backend=webgl2 --suite=visual:terrain-geometry
 *
 * ## What this suite refuses to do
 *
 * FR-016 requires seam cracks, holes, wrong occlusion and anomalous vertices to be caught by numerical
 * assertions and explicitly **not** by a human looking at a picture. Two of the instruments the task
 * text lists are therefore not used, and each refusal is stated with its reason:
 *
 * - **"pixel ratio at depth discontinuities"** — `docs/gate-g7-conclusion.md` §0 (13 measurements, 5
 *   conclusions) established that this machine's canvas depth face is `depth24plus-stencil8` and
 *   **cannot be copied** (`depth32float`/`depth16unorm` can). `readCanvasDepth` returns a structured
 *   "not measurable" record unless `{attempt:true}` is passed, and passing it would only prove the
 *   instrument is absent. The seam class is measured at the **mesh** level instead — the per-tile
 *   sample grids the rasteriser actually consumes, read back through the product provider. That is a
 *   *stronger* statement about geometry than a depth histogram would be: it names the tile and the
 *   height step in metres.
 * - **height/brightness statistics** — the MVP renders the surface as `baseColor × lightColor`
 *   (`fade = 0`, T094), i.e. the frame is a single-colour field; a brightness statistic would carry no
 *   geometric information.
 *
 * ## The four assertion arms, and where each one holds
 *
 * | arm | instrument | webgpu | webgl2 |
 * |---|---|---|---|
 * | A frame/holes | harness screenshot (compositor) + connected components | yes | yes |
 * | B seams | per-tile sample grids via `provider.requestTileGeometry` | yes | yes |
 * | C vertices | same grids vs the dataset's own `levelSummary` intervals | yes | yes |
 * | D draws/triangles | pass-encoder + `Context.draw` records (webgpu) / real `drawElements` (webgl2) | yes | yes, by a different instrument |
 *
 * The **provider-level** arms (B, C) are backend-independent because they read the data *before* either
 * rasteriser sees it; the frame arm (A) is the compositor's own output on both paths; the draw arm (D)
 * is the one genuinely asymmetric instrument (there is no GPU pass/vertex introspection on the WebGL2
 * path — the same asymmetry T088 hit with its vertex-buffer read-back), so the two paths publish
 * **different, separately-reasoned** measurements and the suite never copies one path's numbers onto
 * the other. A measurement that is unavailable on a path is asserted to be **unavailable with a
 * reason**, never silently treated as "ok".
 *
 * ## Violations, not first-failure
 *
 * Every arm reports into one list and the suite fails once, with all of them. A run asked to catch a
 * defect should say **which invariants broke and by how much**, and a counter-example that trips two
 * arms must show both — an assertion that stops at the first failure would hide the rest.
 *
 * ## Thresholds
 *
 * Every number below is justified in {@link CRITERIA} (why it is what it is, and where it came from),
 * and is mirrored into `artifacts/terrain-geometry/criteria.json` together with the values this run
 * measured, so a threshold cannot drift away from its evidence.
 *
 * ## Counter-examples (mandatory self-check)
 *
 * No file is edited to produce a counter-example: `TERRAIN_GEOMETRY_INJECT` is passed to the page as a
 * query parameter, and the scenario damages one tile's *data* while running exactly the same code path.
 * The arms that can be driven red are exercised in the task report; a suite whose assertion cannot fail
 * is not evidence.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "playwright/test";

import { ARTIFACT_ROOT, artifactDirName, assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";
import { decodePng } from "../support/png-reader.mjs";

// One run builds the bundle, launches Chrome and settles a terrain tile tree; a cold build alone
// exceeds Playwright's 30 s default.
test.setTimeout(300_000);

/** The fixed viewport of the terrain suites (T087/T088); it also fixes the canvas backing store. */
const VIEWPORT = { width: 384, height: 288 };
const SUITE = "visual:terrain-geometry";

/**
 * The criteria this suite asserts, with the source of every number.
 *
 * `source` fields are written into `artifacts/terrain-geometry/criteria.json` verbatim: a threshold
 * without a traceable origin is not evidence.
 */
const CRITERIA = {
  frame: {
    /**
     * The share of canvas pixels that carry the frame's **surface colour**, with the DOM overlay's
     * rectangle excluded. The MVP's surface is a single colour (`fade = 0`, T094), so "one uniform field"
     * is the pixel-level equivalent of "no hole, no exposed clear colour, no garbage region": any of those
     * introduces a second colour over a contiguous area.
     *
     * "Carries the surface colour" is tested with {@link CRITERIA.frame.surfaceChannelTolerance} per
     * channel, not by exact equality: the WebGL2 path's compositor emits the *same* surface colour as both
     * `0,0,127` (83.1 %) and `0,1,127` (16.9 %) — measured 2026-09-19, and the same 1-LSB band is visible
     * in `artifacts/terrain-unavailable/webgl2-canvas.png` from T088. The WebGPU path is exact (1 colour).
     * A 1-LSB rounding band is not a geometric defect; the clear colour is `0,0,0`, 127 LSB away, so the
     * tolerance cannot hide a hole.
     */
    minSurfaceShare: 0.99,
    /** Per-channel distance within which a pixel counts as the surface (see the note above). */
    surfaceChannelTolerance: 2,
    /** No enclosed region of a different colour: a hole is exactly that. Area threshold in pixels. */
    interiorHoleMinPixels: 24,
    /** The overlay box may not cover more than this share of the canvas, or "measured" means too little. */
    maxOverlayShare: 0.15,
    /**
     * The share of the frame that may be the frame's **own clear colour**, on the paths where that colour
     * is measurable (the WebGPU path records the clear command; the WebGL2 path does not, and says so).
     * This is the most direct "the surface is missing here" statement available without a depth face:
     * the clear colour is `0,0,0`, 127 LSB away from the surface colour, so no rounding can blur the two.
     * Measured 0 % on both green runs (the surface fills the frame).
     */
    maxClearShare: 0.05,
    source:
      "calibrated 2026-09-19 on the green runs of this suite: webgpu surfaceShare 1.0 (104 236 considered pixels, exactly 1 colour, clear-colour share 0), webgl2 modal colour 0,0,127 over 83.09 % + 0,1,127 over 16.91 % = the same 104 236 pixels (clear colour not recorded on that path); interior holes 0 on both; measured DOM overlay box 227x28 px = 5.7 % of the canvas (the credit display); clear colour 0,0,0 vs surface 0,0,127",
  },
  seam: {
    /**
     * A seam step must be explainable by **one cell of local relief**, because the committed dataset
     * samples at cell centres (`tools/build-terrain-fixture.mjs:605-607`, mirrored into the manifest as
     * `sampleGrid.alignment = "target-cell-centres within each tile rectangle"`) while
     * `HeightmapTessellator` places sample `i` at `i/(n-1)` of the rectangle edge-to-edge
     * (`node_modules/@cesium/engine/Source/Core/HeightmapTessellator.js:296,376`). Adjoining tiles'
     * compared edge profiles are therefore one cell apart *by construction*: a step of ~1 cell of local
     * relief is the convention, and `stepInLocalCells` is the scale-free way to say so.
     *
     * The measured baseline is exactly that: 2026-09-19, 8 same-level seams, `stepInLocalCells`
     * 0.71 … 1.08 (worst absolute step 539 m at level 8, where one cell is 597 m). The tolerance of
     * 4 cells leaves ~3.7x headroom over the convention while the deleted-tile counter-example measures
     * ~21 cells (see the task report), so the band is wide enough for the sampling residual and far too
     * narrow for a crack.
     */
    maxLocalCells: 4,
    /**
     * The degenerate case the ratio cannot see: both edges flat at different heights (local step scale 0).
     * 2 m is twice the dataset's 1 m coding step (`encoding: uint16 metres`, `heightOffsetMetres: -32768`).
     */
    flatEdgeFloorMetres: 2,
    /**
     * An absolute ceiling, so a run where `localStepScale` is itself inflated cannot hide a crack. The
     * dataset's whole declared range is 12 658 m (manifest `levelSummary`, -6883 … 5775); the measured
     * baseline worst step is 539 m, so 2000 m is ~3.7x the baseline and still 4x below the
     * counter-example's step.
     */
    absoluteCeilingMetres: 2000,
    source:
      "calibrated 2026-09-19 on the green run of this suite (8 seams, worst 539 m = 1.077 local cells; 4 parent/child corner pairs, worst 189 m) + the dataset's own sampling convention and coding step (packages/cesium-webgpu/fixtures/matterhorn-z0-12/manifest.json)",
  },
  vertices: {
    /**
     * The per-level interval the **dataset itself publishes** (`manifest.levelSummary[level].minHeight/
     * maxHeight`). A tile's finite sample range is a subset of its level's range, so the assertion needs
     * no tolerance at all: `withinDeclaredInterval` is an exact set-membership statement.
     */
    requireWithinDeclaredInterval: true,
    /**
     * A terrain tile of this dataset is never constant; a constant tile is a deleted/degraded one.
     * Measured baseline 2026-09-19: every probed tile reaches the summariser's 8-value cap.
     */
    minDistinctSampleValues: 2,
    requireFinite: true,
    /**
     * The largest sample-to-sample step inside one tile, against the measured baseline of the green run:
     * 2026-09-19 measured 970 m (a level-8 tile, where one cell is 597 m — a ~3.5:1 slope, plausible
     * alpine relief). 2500 m is 2.6x that baseline, and the `spike:` counter-example (~26 000 m) is an
     * order of magnitude above it, so this arm has room for the dataset and none for an anomalous vertex.
     */
    maxNeighbourStepMetres: 2500,
    source:
      "calibrated 2026-09-19 on the green run of this suite (geometrySummary.maxNeighbourStepMetres = 970 m over 8 probed tiles; distinctSampleValues >= 8 everywhere) + manifest.levelSummary as the outer interval",
  },
  draws: {
    /** The 97x97 sample grid cannot be drawn with fewer than 96x96x2 triangles: a structural floor. */
    minimumTrianglesPerTile: 96 * 96 * 2,
    /** Skirt allowance: the measured mesh is the grid plus exactly one skirt ring (+768 triangles). */
    maximumTrianglesPerTile: 96 * 96 * 2 * 2,
    /** The pass-encoder instrument records at most this many draws (`instrumentPassEncoders(log, 40)`). */
    instrumentLimit: 40,
    /** Draws the pass record may hold beyond the indexed draws the other instrument logged. */
    maxUnaccountedDraws: 4,
    source:
      "measured baseline 2026-09-19: 9 indexed draws, all 57 600 indices = 19 200 triangles = 96x96x2 grid + 768 skirt triangles, 6 distinct dynamic slots for the 6 rendered tiles, 9 draw ops in the replacement Context's own pass record (the two instruments agree exactly); the dataset's 97x97 grid gives the floor, probe.js instrumentPassEncoders(log, 40) the truncation guard",
  },
};

/**
 * Reduce the presented frame to the statements the frame arm asserts.
 *
 * The screenshot is the compositor's output for the canvas *region*, and upstream's credit display is a
 * DOM sibling positioned over the canvas, so its box is excluded using the rectangle the **page measured**
 * (`presentation.overlays.union`) — never guessed. Pixels under the overlay are excluded from every
 * statistic rather than assumed to be surface.
 */
function analyseFrame(image, exclusion, channelTolerance, clearColour) {
  const excluded = (x, y) =>
    exclusion !== null && exclusion !== undefined && x >= exclusion.x && x < exclusion.x + exclusion.width && y >= exclusion.y && y < exclusion.y + exclusion.height;
  const clearChannels = clearColour === null || clearColour === undefined ? null : clearColour.split(",").map(Number);
  const near = (channels, x, y) => {
    const offset = (y * image.width + x) * 4;
    return (
      Math.abs(image.rgba[offset] - channels[0]) <= channelTolerance &&
      Math.abs(image.rgba[offset + 1] - channels[1]) <= channelTolerance &&
      Math.abs(image.rgba[offset + 2] - channels[2]) <= channelTolerance &&
      Math.abs(image.rgba[offset + 3] - channels[3]) <= channelTolerance
    );
  };
  const histogram = new Map();
  let considered = 0;
  let clearPixels = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (excluded(x, y)) continue;
      const offset = (y * image.width + x) * 4;
      const key = `${image.rgba[offset]},${image.rgba[offset + 1]},${image.rgba[offset + 2]},${image.rgba[offset + 3]}`;
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
      considered += 1;
      if (clearChannels !== null && near(clearChannels, x, y)) clearPixels += 1;
    }
  }
  const ranked = [...histogram.entries()].sort((left, right) => right[1] - left[1]);
  const [modalColour, modalCount] = ranked[0] ?? [null, 0];
  const modalChannels = (modalColour ?? "0,0,0,0").split(",").map(Number);
  /** The surface colour, within the compositor-rounding tolerance measured on each path. */
  const nearModal = ranked.filter(([colour]) => colour.split(",").map(Number).every((channel, index) => Math.abs(channel - modalChannels[index]) <= channelTolerance));
  const surfaceCount = nearModal.reduce((sum, [, count]) => sum + count, 0);
  const isSurface = (x, y) => excluded(x, y) || near(modalChannels, x, y);

  // Connected components (4-connectivity) of the **non-surface** mask: a hole, a crack and an exposed
  // clear-colour region are all "a contiguous region that is not the surface".
  const seen = new Uint8Array(image.width * image.height);
  const components = [];
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (seen[y * image.width + x] === 1 || isSurface(x, y)) continue;
      const stack = [[x, y]];
      seen[y * image.width + x] = 1;
      let area = 0;
      let touchesBorder = false;
      const bounds = { minX: x, maxX: x, minY: y, maxY: y };
      while (stack.length > 0) {
        const [cx, cy] = stack.pop();
        area += 1;
        if (cx === 0 || cy === 0 || cx === image.width - 1 || cy === image.height - 1) touchesBorder = true;
        if (cx < bounds.minX) bounds.minX = cx;
        if (cx > bounds.maxX) bounds.maxX = cx;
        if (cy < bounds.minY) bounds.minY = cy;
        if (cy > bounds.maxY) bounds.maxY = cy;
        for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
          if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) continue;
          const index = ny * image.width + nx;
          if (seen[index] === 1 || isSurface(nx, ny)) continue;
          seen[index] = 1;
          stack.push([nx, ny]);
        }
      }
      components.push({ area, touchesBorder, bounds });
    }
  }
  components.sort((left, right) => right.area - left.area);
  return {
    total: image.width * image.height,
    considered,
    width: image.width,
    height: image.height,
    modalColour,
    modalShare: considered === 0 ? 0 : modalCount / considered,
    surfaceShare: considered === 0 ? 0 : surfaceCount / considered,
    surfaceColours: nearModal.length,
    clearShare: clearChannels === null || considered === 0 ? null : clearPixels / considered,
    distinctColours: histogram.size,
    topColours: ranked.slice(0, 5).map(([colour, count]) => ({ colour, count })),
    nonSurfaceComponents: components.length,
    largestNonSurfaceArea: components[0]?.area ?? 0,
    /** Enclosed (not touching the border) non-surface regions — the definition of a "hole" used here. */
    interiorComponents: components.filter((component) => component.touchesBorder === false),
  };
}

/** The clear colour the frame actually used, as bytes, for the "the field is the surface" cross-check. */
function clearColourBytes(clearColours) {
  const first = (clearColours ?? []).find((colour) => Array.isArray(colour) && colour.length >= 3) ?? null;
  if (first === null) return null;
  const bytes = first.slice(0, 4).map((lane) => Math.round(Math.max(0, Math.min(1, Number(lane))) * 255));
  return `${bytes[0]},${bytes[1]},${bytes[2]},${bytes[3] ?? 255}`;
}

test("visual:terrain-geometry — seam cracks, holes and anomalous vertices are caught numerically", async () => {
  const inject = process.env.TERRAIN_GEOMETRY_INJECT ?? "";
  const query = inject.length === 0 ? {} : { inject };
  const run = await runContractSuite(SUITE, { viewport: VIEWPORT, captureCanvas: true, query });
  const label = `terrain-geometry[${run.backend}]${inject.length === 0 ? "" : ` inject=${inject}`}`;

  // -------------------------------------------------------------------------------------------
  // preconditions: if one of these fails, nothing below would mean anything
  // -------------------------------------------------------------------------------------------
  assertCleanRun(run, assert);
  assertOtherBackendUntouched(run, assert);
  const result = run.report.result["terrain-geometry"];
  assert.ok(result !== undefined, `${label}: the page MUST publish the terrain-geometry report`);
  assert.equal(result.injection.requested ?? "", inject, `${label}: the page MUST run the injection this suite asked for`);
  if (inject.length > 0) {
    assert.ok(result.injection.injectedReads.length > 0, `${label}: the injection MUST have intercepted at least one read (got ${JSON.stringify(result.injection)})`);
  }
  assert.equal(result.health.frameErrors.length, 0, `${label}: no frame may throw (${JSON.stringify(result.health.frameErrors)})`);
  assert.equal(result.health.renderErrors.length, 0, `${label}: the scene must not report render errors (${JSON.stringify(result.health.renderErrors.slice(0, 3))})`);
  assert.ok(result.probe.requested > 0, `${label}: at least one tile grid MUST be probed, or nothing is measured`);
  const shot = run.canvasScreenshot;
  assert.ok(shot !== undefined && shot.captured === true, `${label}: the harness MUST capture the canvas (${shot?.reason ?? "no capture"})`);
  const image = decodePng(fs.readFileSync(path.resolve(shot.path)));
      // T157: the viewport a suite *asks for* is not authoritative — the swapchain recomputes the
      // backing store from the client box. So the frame statistics are asserted against the backing
      // store the **page measured** (`presentation.canvas`), not against VIEWPORT, and that measurement
      // is written to criteria.json below.
      const backingStore = result.presentation.canvas;
      assert.equal(backingStore.width, image.width, `${label}: the screenshot MUST be the page's measured backing store (${JSON.stringify(backingStore)} vs ${image.width}x${image.height})`);
      assert.equal(backingStore.height, image.height, `${label}: the screenshot MUST be the page's measured backing store`);
      assert.ok(backingStore.width >= 64 && backingStore.height >= 64, `${label}: the measured backing store ${backingStore.width}x${backingStore.height} is too small to measure a frame`);
  const overlay = result.presentation.overlays.union;
  const overlayShare = overlay === null ? 0 : (overlay.width * overlay.height) / (image.width * image.height);
  assert.ok(overlayShare <= CRITERIA.frame.maxOverlayShare, `${label}: the measured DOM overlay covers ${(overlayShare * 100).toFixed(1)} % of the canvas, too much to measure around`);

  /** Every broken geometric invariant, collected so one run reports all of them. */
  const violations = [];
  const violate = (arm, message, detail = null) => violations.push({ arm, message, detail });

  // -------------------------------------------------------------------------------------------
  // arm A — the presented frame: a hole is "a contiguous region that is not the surface"
  // -------------------------------------------------------------------------------------------
  // The clear colour the frame actually used. On the WebGPU path the replacement Context records the
  // clear command, which gives this arm an *independent* definition of "background"; the WebGL2 path has
  // no such record, and the suite states that asymmetry instead of pretending the two are equal.
  const clearBytes = clearColourBytes(result.presentation.clearColours);
  const frame = analyseFrame(image, overlay, CRITERIA.frame.surfaceChannelTolerance, clearBytes);
  const interiorHoles = frame.interiorComponents.filter((component) => component.area >= CRITERIA.frame.interiorHoleMinPixels);
  if (interiorHoles.length > 0) {
    violate("A-holes", `${interiorHoles.length} enclosed region(s) of the presented frame are not the surface`, {
      areas: interiorHoles.slice(0, 5).map((hole) => hole.area),
      bounds: interiorHoles.slice(0, 5).map((hole) => hole.bounds),
      overlay,
    });
  }
  if (frame.surfaceShare < CRITERIA.frame.minSurfaceShare) {
    violate("A-holes", `the frame is not one uniform surface field: the surface colour covers ${(frame.surfaceShare * 100).toFixed(2)} % (need ${CRITERIA.frame.minSurfaceShare * 100} %)`, {
      modalColour: frame.modalColour,
      surfaceColours: frame.surfaceColours,
      distinctColours: frame.distinctColours,
      topColours: frame.topColours,
      largestNonSurfaceArea: frame.largestNonSurfaceArea,
    });
  }
  if (frame.clearShare !== null && frame.clearShare > CRITERIA.frame.maxClearShare) {
    violate("A-holes", `${(frame.clearShare * 100).toFixed(2)} % of the presented frame is the frame's own clear colour ${clearBytes}: the surface is missing there`, {
      clearBytes,
      modalColour: frame.modalColour,
      largestNonSurfaceArea: frame.largestNonSurfaceArea,
    });
  }
  // The uniform field has to be the *surface*, not the clear colour: if the frame's own clear command
  // used the very same colour, "no hole" would be unfalsifiable on this instrument and the suite says so.
  if (clearBytes !== null && clearBytes === frame.modalColour) {
    violate("A-holes", "the frame's clear colour equals its modal colour, so this pixel statistic could not distinguish a hole from the background", {
      clearBytes,
      clearShare: frame.clearShare,
      surfaceShare: frame.surfaceShare,
    });
  }

  // -------------------------------------------------------------------------------------------
  // arm B — seams: adjoining tiles MUST agree along their shared edge
  // -------------------------------------------------------------------------------------------
  const seams = result.seams.filter((seam) => seam.maxAbsDiffMetres !== null);
  const seamBroken = (seam) => {
    if (seam.localStepScale === null || seam.localStepScale === undefined || seam.localStepScale === 0) {
      return seam.maxAbsDiffMetres > CRITERIA.seam.flatEdgeFloorMetres;
    }
    return seam.stepInLocalCells > CRITERIA.seam.maxLocalCells || seam.maxAbsDiffMetres > CRITERIA.seam.absoluteCeilingMetres;
  };
  const cracked = seams.filter((seam) => seamBroken(seam));
  for (const seam of cracked.slice(0, 8)) {
    violate("B-seams", `the ${seam.axis} seam ${seam.left}|${seam.right} steps ${seam.maxAbsDiffMetres} m (${seam.stepInLocalCells} local cells, limit ${CRITERIA.seam.maxLocalCells})`, {
      sharedSamples: seam.sharedSamples,
      mismatchSamples: seam.mismatchSamples,
      meanAbsDiffMetres: seam.meanAbsDiffMetres,
      rendered: seam.rendered,
      injected: seam.injected,
    });
  }
  if (seams.length === 0) {
    violate("B-seams", "no same-level seam was measurable, so the seam arm asserted nothing", { probed: result.probe.requested, rendered: result.probe.rendered });
  }
  for (const corner of result.lodCorners.filter((corner) => corner.maxAbsDiffMetres > CRITERIA.seam.absoluteCeilingMetres)) {
    violate("B-seams", `the child tile ${corner.child} disagrees with its parent ${corner.parent} by ${corner.maxAbsDiffMetres} m at a shared corner`, {
      corners: corner.corners,
    });
  }

  // -------------------------------------------------------------------------------------------
  // arm C — vertices: the dataset's own per-level interval, finiteness, non-flatness, step scale
  // -------------------------------------------------------------------------------------------
  const tiles = result.tiles.filter((tile) => tile.ok === true);
  for (const tile of result.tiles.filter((tile) => tile.ok !== true)) {
    violate("C-vertices", `the tile ${tile.tile} could not be read at all: ${tile.reason}`, null);
  }
  if (tiles.length < 2) {
    violate("C-vertices", `only ${tiles.length} tile grid(s) were readable, too few to state anything`, { probed: result.probe.requested });
  }
  for (const tile of tiles.filter((entry) => entry.nonFinite > 0)) {
    violate("C-vertices", `the tile ${tile.tile} hands ${tile.nonFinite} NaN/Infinity sample(s) to the rasteriser`, null);
  }
  for (const tile of tiles.filter((entry) => entry.distinctSampleValues < CRITERIA.vertices.minDistinctSampleValues)) {
    violate("C-vertices", `the tile ${tile.tile} is a constant field (${tile.distinctSampleValues} distinct value(s), every sample ${tile.minimum} m) — a deleted/degraded tile`, {
      samples: tile.samples,
    });
  }
  if (CRITERIA.vertices.requireWithinDeclaredInterval === true) {
    for (const tile of tiles.filter((entry) => entry.withinDeclaredInterval === false)) {
      violate("C-vertices", `the tile ${tile.tile} spans ${tile.minimum} … ${tile.maximum} m, outside the interval its own level declares (${JSON.stringify(tile.declared)})`, {
        tile: tile.tile,
      });
    }
  }
  for (const tile of tiles.filter((entry) => entry.maxNeighbourStepMetres > CRITERIA.vertices.maxNeighbourStepMetres)) {
    violate("C-vertices", `the tile ${tile.tile} contains a ${tile.maxNeighbourStepMetres} m step between neighbouring samples (limit ${CRITERIA.vertices.maxNeighbourStepMetres} m)`, {
      samples: tile.samples,
    });
  }

  // -------------------------------------------------------------------------------------------
  // arm D — draw calls and triangles, per path, by that path's own instrument
  // -------------------------------------------------------------------------------------------
  const minimumIndices = CRITERIA.draws.minimumTrianglesPerTile * 3;
  const maximumIndices = CRITERIA.draws.maximumTrianglesPerTile * 3;
  if (run.backend === "webgpu") {
    const webgpu = result.draws.webgpu;
    if (webgpu.ok !== true) violate("D-draws", `the WebGPU draw instrument published nothing: ${webgpu.reason}`, null);
    if (webgpu.truncated === true) violate("D-draws", `the draw record hit the instrument's ${CRITERIA.draws.instrumentLimit}-draw limit, so the frame is only partly accounted for`, null);
    if (webgpu.drawCalls < 1) violate("D-draws", "the settled frame drew nothing", null);
    if (webgpu.distinctIndexCounts.length !== 1) {
      violate("D-draws", `the frame drew meshes of ${webgpu.distinctIndexCounts.length} different sizes (${JSON.stringify(webgpu.distinctIndexCounts)})`, null);
    } else {
      const [indexCount] = webgpu.distinctIndexCounts;
      if (indexCount % 3 !== 0) violate("D-draws", `an index count of ${indexCount} is not a whole number of triangles`, null);
      if (indexCount < minimumIndices) violate("D-draws", `a ${result.datasetFrame.sampleWidth}x${result.datasetFrame.sampleHeight} tile cannot be drawn with ${indexCount} indices (floor ${minimumIndices})`, null);
      if (indexCount > maximumIndices) violate("D-draws", `${indexCount} indices exceeds the grid plus one skirt ring (ceiling ${maximumIndices})`, null);
      if (webgpu.triangles !== (webgpu.drawCalls * indexCount) / 3) violate("D-draws", `the triangle total ${webgpu.triangles} does not equal drawCalls x indices / 3`, null);
    }
    // The tile-count consistency (FR-016's "三角数与 draw call 数异常"): the settled frame drew
    // `tilesRenderedForFrame` tiles — the same-frame snapshot of the globe's own tile list — and used
    // exactly that many dynamic uniform slots (one per tile). A tile that stopped being drawn, or drew
    // with another tile's slot, breaks the identity; the baseline is 6 slots / 6 tiles / 9 draws
    // (9 = 6 + 3 repeats of tiles drawn by the second shader variant).
    if (webgpu.distinctDynamicOffsets !== result.draws.tilesRenderedForFrame) {
      violate("D-draws", `the frame used ${webgpu.distinctDynamicOffsets} dynamic uniform slots for ${result.draws.tilesRenderedForFrame} rendered tiles`, {
        offsets: webgpu.dynamicOffsetsPerDraw,
        renderedKeys: result.probe.renderedKeys,
      });
    }
    if (webgpu.drawCalls < result.draws.tilesRenderedForFrame || webgpu.drawCalls > 2 * result.draws.tilesRenderedForFrame) {
      violate("D-draws", `${webgpu.drawCalls} draw calls for ${result.draws.tilesRenderedForFrame} rendered tiles is outside the measured [1x, 2x] band`, null);
    }
    if (result.draws.contextDrawOps < webgpu.drawCalls || result.draws.contextDrawOps > webgpu.drawCalls + CRITERIA.draws.maxUnaccountedDraws) {
      violate("D-draws", `the replacement Context's own pass records (${result.draws.contextDrawOps} draw ops) disagree with the pass-encoder records (${webgpu.drawCalls} indexed draws)`, {
        passes: result.draws.contextPasses,
      });
    }
  } else {
    const gl = result.draws.gl;
    if (gl === null || gl === undefined) {
      violate("D-draws", "the WebGL2 path published no GL draw counter at all", null);
    } else {
      if (gl.ok !== true) violate("D-draws", `the WebGL2 draw instrument is not installed: ${gl.reason}`, null);
      if (gl.drawCalls < 1) violate("D-draws", "the settled frame drew nothing through GL", null);
      if (gl.indexedDrawCalls < 1) violate("D-draws", "the terrain was not drawn from an index buffer", null);
      if (gl.triangles % 1 !== 0) violate("D-draws", `the GL triangle count ${gl.triangles} is not whole`, null);
      // The GL frame carries more draws than tiles and their meshes are not all one size (upstream's GL
      // path also draws the coarse ancestors and the LOD fallback's own meshes), so the per-draw floor is
      // asserted on the **histogram**: at least `tilesRenderedForFrame` draws must carry a full
      // grid-sized mesh, and the aggregate must still cover one grid per rendered tile.
      const wholeTileDraws = Object.entries(gl.indexCountHistogram ?? {})
        .filter(([indexCount]) => Number(indexCount) >= minimumIndices)
        .reduce((sum, [, draws]) => sum + Number(draws), 0);
      if (gl.indexedDrawCalls < result.draws.tilesRenderedForFrame) {
        violate("D-draws", `${gl.indexedDrawCalls} indexed draws for ${result.draws.tilesRenderedForFrame} rendered tiles: fewer draws than tiles`, {
          histogram: gl.indexCountHistogram,
        });
      }
      if (gl.largestIndexCount < minimumIndices) {
        violate("D-draws", `the largest GL mesh is ${gl.largestIndexCount} indices, below one ${result.datasetFrame.sampleWidth}x${result.datasetFrame.sampleHeight} grid (${minimumIndices})`, {
          histogram: gl.indexCountHistogram,
        });
      }
      if (wholeTileDraws < result.draws.tilesRenderedForFrame) {
        violate("D-draws", `only ${wholeTileDraws} GL draw(s) carry a full grid-sized mesh (>= ${minimumIndices} indices), fewer than the ${result.draws.tilesRenderedForFrame} rendered tiles`, {
          histogram: gl.indexCountHistogram,
          modes: gl.modes,
        });
      }
      if (gl.triangles < result.draws.tilesRenderedForFrame * CRITERIA.draws.minimumTrianglesPerTile) {
        violate("D-draws", `${gl.triangles} triangles for ${result.draws.tilesRenderedForFrame} rendered tiles is below the ${CRITERIA.draws.minimumTrianglesPerTile}-triangle floor per tile`, {
          modes: gl.modes,
        });
      }
    }
    // Stated, not implied: on this path the GPU-level instruments above do not exist (T088's asymmetry).
    if (result.draws.webgpu.ok !== false) {
      violate("D-draws", "the GPURenderPassEncoder instrument claims to be available on the WebGL2 path, so the two paths' evidence is no longer separable", {
        reason: result.draws.webgpu.reason,
      });
    }
  }
  if (result.draws.tilesRenderedForFrame < 1) violate("D-draws", "the globe reports no tile to render", null);

  // -------------------------------------------------------------------------------------------
  // the verdict: one failure listing every broken invariant
  // -------------------------------------------------------------------------------------------
  if (violations.length > 0) {
    console.log(`${label} VIOLATIONS ${JSON.stringify(violations)}`);
  }
  assert.deepEqual(
    violations,
    [],
    `${label}: ${violations.length} geometric invariant(s) violated — ${violations.map((violation) => `[${violation.arm}] ${violation.message}`).join(" | ")}`,
  );

  // -------------------------------------------------------------------------------------------
  // the criteria record: thresholds and the values this run measured, side by side
  // -------------------------------------------------------------------------------------------
  const directory = path.join(ARTIFACT_ROOT, artifactDirName(SUITE));
  fs.mkdirSync(directory, { recursive: true });
  const criteriaFile = path.join(directory, "criteria.json");
  const previous = fs.existsSync(criteriaFile) ? JSON.parse(fs.readFileSync(criteriaFile, "utf8")) : { suite: SUITE, criteria: CRITERIA, runs: {} };
  previous.criteria = CRITERIA;
  previous.runs[run.backend] = {
    runId: run.runId,
    recordedAt: new Date().toISOString(),
    injection: inject.length === 0 ? null : inject,
    artifact: path.relative(ARTIFACT_ROOT, path.join(directory, `${run.backend}.json`)).split(path.sep).join("/"),
    probe: {
      tilesProbed: tiles.length,
      renderedTiles: result.probe.renderedKeys,
      renderedForFrame: result.draws.tilesRenderedForFrame,
      renderedForPresentation: result.draws.tilesRendered,
      /** Rendered but not in the committed dataset: upstream upsamples these from their parent grid. */
      upsampledTiles: result.probe.upsampled,
    },
    measured: {
      frame: {
        modalColour: frame.modalColour,
        modalShare: Number(frame.modalShare.toFixed(6)),
        surfaceShare: Number(frame.surfaceShare.toFixed(6)),
        surfaceColours: frame.surfaceColours,
        considered: frame.considered,
        total: frame.total,
        distinctColours: frame.distinctColours,
        interiorHoles: interiorHoles.length,
        largestNonSurfaceArea: frame.largestNonSurfaceArea,
        clearColourBytes: clearBytes,
        clearShare: frame.clearShare === null ? null : Number(frame.clearShare.toFixed(6)),
        overlayShare: Number(overlayShare.toFixed(6)),
        /** T157: the backing store the page measured, not the viewport this suite asked for. */
        canvasBackingStore: `${backingStore.width}x${backingStore.height}`,
        screenshot: `${image.width}x${image.height}`,
      },
      seams: {
        count: seams.length,
        measured: result.seams.length,
        worstMetres: result.geometrySummary.worstSeamMetres,
        worstInLocalCells: result.geometrySummary.worstSeamInLocalCells,
        lodCornerPairs: result.lodCorners.length,
        worstLodCornerMetres: result.geometrySummary.worstLodCornerMetres,
      },
      vertices: {
        probedTiles: tiles.length,
        maxNeighbourStepMetres: result.geometrySummary.maxNeighbourStepMetres,
        distinctSampleValuesMinimum: Math.min(...tiles.map((tile) => tile.distinctSampleValues)),
        declaredGlobalInterval: [result.datasetFrame.globalMinimum, result.datasetFrame.globalMaximum],
      },
      draws:
        run.backend === "webgpu"
          ? {
              instrument: "GPURenderPassEncoder.drawIndexed + Context.draw + lastFramePasses",
              drawCalls: result.draws.webgpu.drawCalls,
              indexCount: result.draws.webgpu.distinctIndexCounts[0] ?? null,
              triangles: result.draws.webgpu.triangles,
              contextDrawOps: result.draws.contextDrawOps,
              distinctDynamicOffsets: result.draws.webgpu.distinctDynamicOffsets,
              pipelines: result.draws.webgpu.pipelines,
              tilesRendered: result.draws.tilesRendered,
              tilesRenderedForFrame: result.draws.tilesRenderedForFrame,
              upsampledTiles: result.probe.upsampled,
            }
          : {
              instrument: "WebGL2RenderingContext.drawElements/drawArrays",
              drawCalls: result.draws.gl?.drawCalls ?? null,
              indexedDrawCalls: result.draws.gl?.indexedDrawCalls ?? null,
              triangles: result.draws.gl?.triangles ?? null,
              modes: result.draws.gl?.modes ?? null,
              indexCountHistogram: result.draws.gl?.indexCountHistogram ?? null,
              largestIndexCount: result.draws.gl?.largestIndexCount ?? null,
              tilesRendered: result.draws.tilesRendered,
              tilesRenderedForFrame: result.draws.tilesRenderedForFrame,
              upsampledTiles: result.probe.upsampled,
              /** Stated, not implied: the WebGPU instruments do not exist on this path (T088's asymmetry). */
              webgpuInstruments: { ok: result.draws.webgpu.ok, reason: result.draws.webgpu.reason },
            },
    },
  };
  previous.notes = [
    "Canvas depth face read-back: NOT attempted — depth24plus-stencil8 cannot be copied on this machine (docs/gate-g7-conclusion.md §0), so 'pixel ratio at depth discontinuities' is unavailable by measurement, not by choice.",
    "Seam class is measured on the tile sample grids the rasteriser consumes (provider-level, both backends), not on pixels: the dataset samples at cell centres while HeightmapTessellator places samples edge-to-edge, so a residual of ~1 cell of local relief is the sampling convention and is reported per seam as stepInLocalCells.",
    "Holes: the MVP surface renders as a single colour (fade = 0, T094), so a hole shows up as a contiguous non-modal region; the credit display is a DOM overlay inside the canvas region and its measured box is excluded from every pixel statistic.",
    "The WebGL2 path has no GPU pass/vertex introspection (the asymmetry T088 reported); arm D therefore uses a different instrument there and the suite asserts each path's instrument separately instead of copying numbers across paths.",
    "LOD boundary: a rendered tile that is not in the committed dataset is upsampled by upstream from its parent grid (measured: 2 of 6 rendered tiles in the webgpu green run). The parent/child arm checks the *dataset* relationship between a child tile and its parent's samples; the upsample interpolation itself is NOT separately measured, because `provider.requestTileGeometry` for a non-dataset tile returns the documented flat degradation rather than the upsampled grid. Recorded here so the gap is visible instead of implied.",
    "Counter-example runs (no source file is edited for them; `TERRAIN_GEOMETRY_INJECT` is a query parameter): artifacts/terrain-geometry/counterexamples.log holds each case's exit code and full violation list, and counterexample-<case>.json holds the run's own report. Cases: fail-tile (a tile's reads reject -> the adapter degrades it to a flat floor tile), zeros-tile (a tile reads legal all-zero bytes = -32768 m), spike-tile (every 32nd sample moved to the coding floor), no-coverage (every tile answers 'not available').",
  ];
  fs.writeFileSync(criteriaFile, `${JSON.stringify(previous, null, 2)}\n`, "utf8");

  console.log(
    `${label} PASSED ${JSON.stringify({
      injection: inject.length === 0 ? null : inject,
      probedTiles: tiles.length,
      seams: seams.length,
      worstSeamMetres: result.geometrySummary.worstSeamMetres,
      worstSeamInLocalCells: result.geometrySummary.worstSeamInLocalCells,
      maxNeighbourStepMetres: result.geometrySummary.maxNeighbourStepMetres,
      uniformShare: Number(frame.surfaceShare.toFixed(4)),
      surfaceColours: frame.surfaceColours,
      clearShare: frame.clearShare === null ? null : Number(frame.clearShare.toFixed(4)),
      interiorHoles: interiorHoles.length,
      draws: run.backend === "webgpu" ? result.draws.webgpu.drawCalls : result.draws.gl?.drawCalls ?? null,
      triangles: run.backend === "webgpu" ? result.draws.webgpu.triangles : result.draws.gl?.triangles ?? null,
      tilesRendered: result.draws.tilesRenderedForFrame,
    })}`,
  );
});
