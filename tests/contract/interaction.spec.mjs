/**
 * `contract:interaction` — T095 (`层=契约`, SC-004 / FR-002): after the terrain is ready, **three
 * seconds of fixed-step camera interaction** (rotate → zoom → pan) must not produce a continuous stall
 * of more than 1000 ms, must not raise an uncaught error, must leave the settled frame's statistics in
 * the same interval as before the interaction, and must keep the frame counter growing.
 *
 * Run (one backend per run — constitution principle II):
 *   node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:interaction
 *   node tests/support/backend-runner.mjs --backend=webgl2 --suite=contract:interaction
 *
 * The page-side scenario (`tests/contract/page/scenarios/terrain-interaction.js`) drives the **product**
 * entry point (`bundle.terrainScene.createTerrainScene`) over the committed dataset
 * (`matterhorn-z0-12`, `mode: "fixture"`) and samples one raw frame time per animation frame inside the
 * page — `run.*` cannot see per-frame times across the process boundary, so the raw sample array and
 * its distribution are what this spec asserts on.
 *
 * ## Thresholds and where they come from
 *
 *   - `STALL_THRESHOLD_MS = 1000` — SC-004 / FR-002 ("单次交互无超过 1 秒的连续卡顿"), verbatim.
 *   - `COVERAGE_FLOOR = 0.10` — SC-002 ("非空白、非纯背景色"). A blank frame measures exactly 0, so the
 *     floor is the smallest non-vacuous statement; the measured values are published next to it.
 *   - `COVERAGE_RELATIVE_BAND = 0.25` — (c) "same interval as before the interaction". The camera moves
 *     (45° of heading, 2x zoom, ~3 km of pan) but the framing of a globe seen from 12–24 km at pitch −50
 *     does not change enough to halve the covered area; a broken frame lands at 0 and a frame with a
 *     hole in it drops far below 0.75x. Reference (not a threshold source): the W5 probe's compositor
 *     screenshots at this camera measured 110592/110592 covered pixels
 *     (`artifacts/terrain-probe/observation.default.*.json`).
 *   - `UNIQUE_COLOUR_FLOOR = 1` and the `[0.25x, 4x]` band — (c) compares the settled frame against the
 *     pre-interaction frame. It is deliberately **not** a "richness" floor: with
 *     `baseLayer/skyBox/skyAtmosphere: false` and the near-ground lighting fade, a whole frame of the
 *     unmodulated globe base colour is the correct behaviour of this increment (spec.md SC-002 says so
 *     explicitly, and `artifacts/terrain-ready/webgpu.json` — T090, same bundle and camera, independent
 *     run — measured `uniqueColorCount: 1` with `nonBackgroundRatio: 1`). A >1 floor would be a false
 *     constraint; the interval claim is carried by the band, the coverage floor, the tile counter and
 *     the draw-call counter.
 *   - `MIN_FRAMES_PER_PHASE = 5` — (d)'s "frame counter keeps growing" over a 1000 ms phase; at the
 *     60 Hz animation-frame cadence of the harness this floor is an order of magnitude below the
 *     expected count, i.e. it catches "the loop stopped", not "the loop is slow" (which (a) measures).
 *   - `MIN_FRAME_SAMPLES = 30` — non-vacuity of the sampler window itself.
 *
 * ## Known blockers of individual instruments (asserted in the strict direction anyway)
 *
 *   - `triangleCount` is structurally 0 in the current backend (the command tally never sees a TRIANGLES
 *     command; tracked as T156). It is recorded but is not used to carry a claim — `drawCallCount` (a
 *     working instrument, measured 9 in T090's run) carries "the frame really drew".
 *   - `depthDiscontinuityRatio` is `NaN` on both sides (the shipped `stats()` is assembled without depth
 *     samples: `src/compose/frame-statistics.ts` `UNMEASURED`), so it is excluded from the interval
 *     comparison while being asserted to be `NaN` rather than 0 — see `assertInteractionArm`.
 *
 * ## Counter-example (non-negotiable evidence that (a) can fail)
 *
 * The second test runs the same scenario with `?stall_ms=1200`, which injects one deliberate
 * main-thread busy wait inside the pan phase. It asserts that the **same** `findStallRuns()` used by the
 * measured arm flags the freeze, that the measured arm's exact assertion *fails* on those samples (the
 * thrown message is recorded), and that a 5000 ms threshold no longer flags it — so the assertion is
 * neither unconditionally true nor a constant.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "playwright/test";

import { ARTIFACT_ROOT, assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";

/** Repository root, derived from this file's own URL (the runner's cwd is not assumed). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Suite key in `SUITE_SCENARIOS`; the page-side scenario name is `terrain-interaction`. */
const SUITE = "contract:interaction";
const SCENARIO_RESULT_KEY = "terrain-interaction";
const EVIDENCE_DIR = path.join(ARTIFACT_ROOT, "interaction");

/** Fixed conditions of this contract, mirrored from the scenario (which publishes its own copy). */
const DATASET_ID = "matterhorn-z0-12";
const VIEWPORT = { width: 384, height: 288 };
/** The viewport the scenario must resolve to (`devicePixelRatio` is pinned to 1: fixed capture size). */
const VIEWPORT_DPR = { ...VIEWPORT, devicePixelRatio: 1 };
const INTERACTION_PHASES = ["rotate", "zoom", "pan"];

/** Thresholds — sources are in the file header. */
const STALL_THRESHOLD_MS = 1000;
const COVERAGE_FLOOR = 0.1;
const COVERAGE_RELATIVE_BAND = 0.25;
/**
 * A frame MUST carry at least one measured colour. This is deliberately **not** a "richness" floor:
 * with `baseLayer: false`, `skyBox/skyAtmosphere: false` and the near-ground lighting fade
 * (`fade = 0` ⇒ `finalColor = color x lightColor`), a whole frame of the unmodulated globe base colour
 * is the **correct** behaviour of this increment — spec.md SC-002 says so in as many words, and
 * `artifacts/terrain-ready/webgpu.json` (T090, same bundle, same camera, independent run) measured
 * `uniqueColorCount: 1` with `nonBackgroundRatio: 1` on both `stats()` and its own pixel reduction.
 * A >1 floor here would therefore be a false constraint, not a stricter contract. What (c) really
 * requires is that the settled frame is *in the same interval*: the relative band below plus the
 * coverage floor, the tile counter and the draw/triangle counts carry that claim.
 */
const UNIQUE_COLOUR_FLOOR = 1;
const UNIQUE_COLOUR_LOW_FACTOR = 0.25;
const UNIQUE_COLOUR_HIGH_FACTOR = 4;
const MIN_FRAMES_PER_PHASE = 5;
const MIN_FRAME_SAMPLES = 30;
const MIN_FRAME_DIFFERENCE_RATIO = 0.001;

/** Counter-example arm: the injected freeze and the tolerances used to recognise it. */
const INJECTED_STALL_MS = 1200;
const INJECTED_STALL_TOLERANCE_MS = 50;
const NEGATIVE_CONTROL_RELAXED_THRESHOLD_MS = 5000;
const NEGATIVE_CONTROL_STRICT_THRESHOLD_MS = 1;

test.setTimeout(600_000);

// ------------------------------------------------------------------------------------------------
// Pure measurement helpers — the measured arm and the counter-example arm share this code, which is
// what makes "this assertion can fail" a statement about the assertion that actually runs.
// ------------------------------------------------------------------------------------------------

/** Nearest-rank percentile over an ascending array (`frame-statistics.ts` uses the same convention). */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

/** Distribution of the raw inter-frame gaps, recomputed from the page's raw sample array. */
function summariseGaps(values) {
  const sorted = [...values].filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
  return {
    count: sorted.length,
    min: round(sorted[0]),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sorted.reduce((total, value) => total + value, 0) / sorted.length),
  };
}

function round(value, digits = 3) {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** How many samples in `window` show a gap greater than `threshold` (the raw, un-collapsed count). */
function countFlagged(samples, threshold, window) {
  return samples.filter(
    (sample) =>
      typeof sample.gapMs === "number" &&
      Number.isFinite(sample.gapMs) &&
      sample.gapMs > threshold &&
      sample.t >= window.fromMs &&
      sample.t <= window.toMs,
  ).length;
}

/**
 * Maximal runs of **consecutive** inter-frame gaps greater than `threshold`: one run = one continuous
 * freeze (`durationMs` is the observed freeze length). `window` restricts the samples considered, which
 * is how the measured arm scopes (a) to SC-004's 3 s interaction (plus its settle) instead of to the
 * whole scenario. `phases` names the segment the freeze **started** in (`gapStartedInPhase`), so a
 * freeze that begins inside the interaction and unblocks after it is still attributed to the segment
 * that caused it; `endedInPhases` keeps the straddle visible.
 */
function findStallRuns(samples, threshold, window = null) {
  const ordered = [...samples].filter((sample) => typeof sample?.t === "number").sort((left, right) => left.t - right.t);
  const considered = ordered.filter(
    (sample) => typeof sample.gapMs === "number" && Number.isFinite(sample.gapMs) && (window === null || (sample.t >= window.fromMs && sample.t <= window.toMs)),
  );
  const runs = [];
  let current = null;
  for (const sample of considered) {
    if (sample.gapMs > threshold) {
      if (current === null) {
        current = {
          firstSampleTMs: round(sample.t - sample.gapMs),
          lastSampleTMs: sample.t,
          gapCount: 0,
          durationMs: 0,
          peakGapMs: 0,
          phases: [],
          endedInPhases: [],
          stepIndexes: [],
        };
        runs.push(current);
      }
      current.gapCount += 1;
      current.durationMs += sample.gapMs;
      current.peakGapMs = Math.max(current.peakGapMs, sample.gapMs);
      const startedIn = sample.gapStartedInPhase ?? sample.phase;
      if (!current.phases.includes(startedIn)) current.phases.push(startedIn);
      if (!current.endedInPhases.includes(sample.phase)) current.endedInPhases.push(sample.phase);
      const step = sample.gapStartedAtStepIndex ?? sample.stepIndex;
      if (step !== null && step !== undefined && !current.stepIndexes.includes(step)) current.stepIndexes.push(step);
    } else {
      current = null;
    }
  }
  return runs.map((run) => ({ ...run, durationMs: round(run.durationMs), peakGapMs: round(run.peakGapMs) }));
}

/** The scenario's own result, or a loud failure naming what was missing. */
function scenarioResult(run, label) {
  const result = run.report?.["result"]?.[SCENARIO_RESULT_KEY];
  assert.ok(result !== undefined && result !== null, `${label}: the scenario MUST publish its result (got ${JSON.stringify(result)})`);
  assert.equal(result.scenario, SCENARIO_RESULT_KEY, `${label}: unexpected scenario key`);
  assert.ok(Array.isArray(result.frameSamplesRaw) && result.frameSamplesRaw.length > 0, `${label}: the raw frame samples MUST be published`);
  assert.ok(Array.isArray(result.interaction?.stepLog), `${label}: the step log MUST be published`);
  return result;
}

/**
 * Every assertion this contract makes about one **measured** arm.
 *
 * `label` names the arm in failure messages so a red run says which one failed. The failure messages
 * carry the measured distribution, so a red run is diagnosable without re-running it.
 */
function assertInteractionArm(run, label) {
  // (b) no uncaught error — the harness channels: page errors, console errors, the page's own report.
  assertCleanRun(run, assert);

  const result = scenarioResult(run, label);
  const samples = result.frameSamplesRaw;
  const window = { fromMs: result.interaction.startMs, toMs: result.interaction.settleEndMs };

  // Fixed conditions really were fixed.
  assert.equal(result.setup.datasetId, DATASET_ID, `${label}: the committed dataset MUST be the one under test`);
  assert.deepEqual(
    { width: result.setup.viewport.width, height: result.setup.viewport.height, devicePixelRatio: result.setup.viewport.devicePixelRatio },
    VIEWPORT_DPR,
    `${label}: the viewport MUST be the pinned one`,
  );
  assert.equal(result.setup.preferencePassed, false, `${label}: no backend preference may be passed before W6 lands`);
  assert.equal(result.setup.canvasIsTheHarnessScreenshotTarget, true, `${label}: the scenario MUST render into the canvas the harness screenshots`);
  assert.equal(result.setup.canvasReusedByEntry, true, `${label}: createTerrainScene MUST reuse the container's canvas (src/compose/scene-runtime.ts)`);

  // THE PATH THAT ACTUALLY RAN. With an empty device hand-off slot the replacement `Context` whole-
  // delegates to upstream WebGL2 (`Context.ts:30-35`, plan D2-a), which then dies on the patched
  // `RenderState.apply` — measured. So both the parked device and the reported active path are asserted:
  // a WebGPU arm that silently became a WebGL2 arm MUST NOT pass as a WebGPU measurement.
  assert.ok(Array.isArray(result.setup.statuses) && result.setup.statuses.length > 0, `${label}: onStatus MUST report the active path (FR-009)`);
  assert.equal(
    result.setup.activeBackend,
    run.backend,
    `${label}: the scene reported active="${result.setup.activeBackend}" but this run enables "${run.backend}" (statuses: ${JSON.stringify(result.setup.statuses)})`,
  );
  if (run.backend === "webgpu") {
    assert.equal(result.setup.handoff.installed, true, `${label}: the probed device MUST be parked in the hand-off slot before createTerrainScene`);
  } else {
    assert.equal(result.setup.handoff.installed, false, `${label}: a WebGL2 run MUST NOT park a WebGPU device (${JSON.stringify(result.setup.handoff)})`);
  }

  // The terrain really was ready before the interaction started.
  assert.equal(result.tiles.loaded, true, `${label}: the tiles MUST be loaded before the interaction (${JSON.stringify(result.tiles)})`);

  // (a) NO CONTINUOUS STALL > 1000 ms inside the interaction window. The assertion is never relaxed:
  // the measured distribution is part of the failure message.
  const windowSamples = samples.filter((sample) => typeof sample.gapMs === "number" && sample.t >= window.fromMs && sample.t <= window.toMs);
  const distribution = summariseGaps(windowSamples.map((sample) => sample.gapMs));
  const stalls = findStallRuns(samples, STALL_THRESHOLD_MS, window);
  assert.equal(
    stalls.length,
    0,
    `${label}: the interaction produced ${stalls.length} continuous stall(s) longer than ${STALL_THRESHOLD_MS} ms. ` +
      `Measured inter-frame gap distribution in [${window.fromMs}, ${window.toMs}] ms (count/min/p50/p95/p99/max/mean): ${JSON.stringify(distribution)}; ` +
      `run(s): ${JSON.stringify(stalls)}; per-phase: ${JSON.stringify(result.distributions.perPhase)}`,
  );
  assert.ok(
    distribution.count >= MIN_FRAME_SAMPLES,
    `${label}: only ${distribution.count} frame samples were taken in the interaction window, so the stall assertion would be vacuous (distribution: ${JSON.stringify(distribution)})`,
  );
  assert.ok(distribution.max <= STALL_THRESHOLD_MS, `${label}: worst inter-frame gap ${distribution.max} ms exceeds the ${STALL_THRESHOLD_MS} ms budget`);

  // The 3.0 s interaction really happened: 60 fixed steps, 20 per phase, and the window is ~3 s long.
  assert.equal(result.interaction.stepsApplied, 60, `${label}: 3 phases x 20 steps of 50 ms MUST be applied (got ${result.interaction.stepsApplied})`);
  for (const phase of INTERACTION_PHASES) {
    assert.equal(result.interaction.stepsPerPhaseApplied[phase], 20, `${label}: phase "${phase}" MUST apply 20 steps (got ${result.interaction.stepsPerPhaseApplied[phase]})`);
  }
  assert.ok(
    result.interaction.realizedDurationMs >= 3000 && result.interaction.realizedDurationMs <= 3600,
    `${label}: the interaction window MUST last ~3000 ms (measured ${result.interaction.realizedDurationMs} ms)`,
  );

  // (d) THE FRAME COUNTER KEEPS GROWING.
  const framesByPhase = result.frameCounts.byPhase;
  for (const phase of INTERACTION_PHASES) {
    assert.ok(
      framesByPhase[phase] >= MIN_FRAMES_PER_PHASE,
      `${label}: phase "${phase}" produced ${framesByPhase[phase]} animation frames in 1000 ms (floor ${MIN_FRAMES_PER_PHASE}); frames by phase: ${JSON.stringify(framesByPhase)}`,
    );
    assert.ok(
      result.frameCounts.nonScenarioRafCallbacksByPhase[phase] > 0,
      `${label}: the product's frame loop scheduled no requestAnimationFrame callback during "${phase}": ${JSON.stringify(result.frameCounts.nonScenarioRafCallbacksByPhase)}`,
    );
    assert.equal(
      result.frameCounts.capturesByPhase[phase],
      1,
      `${label}: exactly one captureFrame() MUST resolve during "${phase}" (a resolved capture is a freshly rendered product frame): ${JSON.stringify(result.frameCounts.capturesByPhase)}`,
    );
  }
  let previous = 0;
  for (const phase of INTERACTION_PHASES) {
    assert.ok(result.frameCounts.cumulative[phase] > previous, `${label}: the frame count MUST grow through "${phase}" (${JSON.stringify(result.frameCounts.cumulative)})`);
    previous = result.frameCounts.cumulative[phase];
  }
  const firstSample = result.frameCounts.window.firstSample;
  const lastSample = result.frameCounts.window.lastSample;
  assert.ok(firstSample !== null && lastSample !== null, `${label}: the interaction window MUST contain frame samples (${JSON.stringify(result.frameCounts.window)})`);
  assert.ok(
    lastSample.rafInvokedTotal > firstSample.rafInvokedTotal,
    `${label}: the requestAnimationFrame counter did not grow across the interaction window (${firstSample.rafInvokedTotal} -> ${lastSample.rafInvokedTotal})`,
  );

  // The interaction really moved the camera: every probe frame differs from the pre-interaction frame.
  assert.ok(
    result.captures.differencePreToPost > MIN_FRAME_DIFFERENCE_RATIO,
    `${label}: the settled frame is indistinguishable from the pre-interaction frame (difference ratio ${result.captures.differencePreToPost}), so the interaction never reached the renderer`,
  );
  for (const probe of result.captures.probes) {
    assert.equal(probe.skipped, undefined, `${label}: the capture at the end of "${probe.phase}" was skipped: ${probe.skipped}`);
    assert.equal(probe.error, null, `${label}: the capture at the end of "${probe.phase}" failed: ${probe.error}`);
    assert.ok(
      probe.differenceFromPreCapture > MIN_FRAME_DIFFERENCE_RATIO,
      `${label}: the frame at the end of "${probe.phase}" is indistinguishable from the pre-interaction frame (difference ratio ${probe.differenceFromPreCapture})`,
    );
  }

  // (c) THE SETTLED FRAME IS IN THE SAME INTERVAL AS THE PRE-INTERACTION FRAME.
  const pre = result.captures.pre.stats;
  const post = result.captures.post.stats;
  const preOwn = result.captures.pre.own;
  const postOwn = result.captures.post.own;
  // Independent recomputation of the same pixels must agree with stats() (two code paths, one truth).
  assert.equal(preOwn.uniqueColorCount, pre.uniqueColorCount, `${label}: uniqueColorCount disagrees between stats() and the in-page reduction`);
  assert.equal(postOwn.uniqueColorCount, post.uniqueColorCount, `${label}: uniqueColorCount disagrees between stats() and the in-page reduction`);
  assert.ok(Math.abs(preOwn.nonBackgroundRatio - pre.nonBackgroundRatio) < 1e-6, `${label}: nonBackgroundRatio disagrees between stats() and the in-page reduction`);
  assert.ok(Math.abs(postOwn.nonBackgroundRatio - post.nonBackgroundRatio) < 1e-6, `${label}: nonBackgroundRatio disagrees between stats() and the in-page reduction`);

  // NaN is a measurement result, not a number to compare: depth is unmeasured on both sides.
  assert.ok(Number.isNaN(pre.depthDiscontinuityRatio), `${label}: depthDiscontinuityRatio MUST be NaN when unmeasured (got ${String(pre.depthDiscontinuityRatio)}) — 0 would be a fabricated measurement`);
  assert.ok(Number.isNaN(post.depthDiscontinuityRatio), `${label}: depthDiscontinuityRatio MUST be NaN when unmeasured (got ${String(post.depthDiscontinuityRatio)})`);
  assert.equal(result.comparison.depthDiscontinuityRatioIsNaN.pre, true, `${label}: the artifact MUST record that depth was excluded as unmeasured`);
  assert.equal(result.comparison.depthDiscontinuityRatioIsNaN.post, true, `${label}: the artifact MUST record that depth was excluded as unmeasured`);
  assert.equal(result.comparison.statsAfterResetIsNaN.nonBackgroundRatio, true, `${label}: after resetStats() the pixel statistics MUST be unmeasured (NaN), never 0`);

  assert.ok(Number.isFinite(pre.nonBackgroundRatio) && pre.nonBackgroundRatio >= COVERAGE_FLOOR, `${label}: the pre-interaction frame covers ${pre.nonBackgroundRatio} of the canvas (< ${COVERAGE_FLOOR}); the frame is blank`);
  assert.ok(Number.isFinite(post.nonBackgroundRatio) && post.nonBackgroundRatio >= COVERAGE_FLOOR, `${label}: the settled frame covers ${post.nonBackgroundRatio} of the canvas (< ${COVERAGE_FLOOR}); the interaction left a blank frame`);
  assert.ok(post.nonBackgroundRatio <= 1 && pre.nonBackgroundRatio <= 1, `${label}: a coverage ratio cannot exceed 1 (${pre.nonBackgroundRatio} -> ${post.nonBackgroundRatio})`);
  assert.ok(
    post.nonBackgroundRatio >= pre.nonBackgroundRatio * (1 - COVERAGE_RELATIVE_BAND),
    `${label}: (c) coverage left the pre-interaction interval: ${pre.nonBackgroundRatio} -> ${post.nonBackgroundRatio} (band ${(1 - COVERAGE_RELATIVE_BAND).toFixed(2)}x..1.00x)`,
  );
  assert.ok(pre.uniqueColorCount >= UNIQUE_COLOUR_FLOOR, `${label}: the pre-interaction frame holds only ${pre.uniqueColorCount} distinct colours (< ${UNIQUE_COLOUR_FLOOR}); it is a flat frame`);
  assert.ok(post.uniqueColorCount >= UNIQUE_COLOUR_FLOOR, `${label}: the settled frame holds only ${post.uniqueColorCount} distinct colours (< ${UNIQUE_COLOUR_FLOOR}); the interaction flattened it`);
  assert.ok(
    post.uniqueColorCount >= pre.uniqueColorCount * UNIQUE_COLOUR_LOW_FACTOR && post.uniqueColorCount <= pre.uniqueColorCount * UNIQUE_COLOUR_HIGH_FACTOR,
    `${label}: (c) colour richness left the pre-interaction interval: ${pre.uniqueColorCount} -> ${post.uniqueColorCount} (band ${UNIQUE_COLOUR_LOW_FACTOR}x..${UNIQUE_COLOUR_HIGH_FACTOR}x)`,
  );
  for (const [name, stats] of [["pre", pre], ["post", post]]) {
    // The "terrain is still being drawn" claim is carried by `drawCallCount`, the instrument that
    // actually reports draws on both sides (measured 9 in `artifacts/terrain-ready/webgpu.json` too).
    // `triangleCount` is structurally 0 in the current backend (tracked as T156: the tally never sees a
    // command whose `primitiveType` is TRIANGLES), so asserting `> 0` on it would be red for a known
    // instrumentation defect rather than for this contract; it is asserted to be *measured* instead.
    assert.ok(stats.drawCallCount > 0, `${label}: the ${name}-interaction frame issued no draw call (drawCallCount ${stats.drawCallCount}) — nothing was drawn`);
    assert.ok(
      Number.isFinite(stats.triangleCount) && stats.triangleCount >= 0,
      `${label}: ${name}.triangleCount is ${String(stats.triangleCount)} — not a measurement (see T156: the counter is structurally 0 until the command tally is fixed)`,
    );
    assert.ok(stats.tileCount >= 1, `${label}: the ${name}-interaction frame renders ${stats.tileCount} terrain tiles`);
    assert.ok(Number.isFinite(stats.frameTimeMs.p50) && stats.frameTimeMs.p50 > 0, `${label}: ${name}.frameTimeMs.p50 is ${String(stats.frameTimeMs.p50)} — not a measurement`);
    assert.ok(Number.isFinite(stats.frameTimeMs.p95) && stats.frameTimeMs.p95 > 0, `${label}: ${name}.frameTimeMs.p95 is ${String(stats.frameTimeMs.p95)} — not a measurement`);
  }
  assert.ok(post.tileCount >= pre.tileCount, `${label}: the cumulative terrain tile counter went backwards: ${pre.tileCount} -> ${post.tileCount}`);
  assert.ok(post.frameTimeMs.p95 <= STALL_THRESHOLD_MS, `${label}: the product's own p95 frame time after the interaction is ${post.frameTimeMs.p95} ms (> ${STALL_THRESHOLD_MS} ms)`);

  // The compositor sees the settled frame: the harness screenshot is the authoritative presentation
  // evidence and an independent channel from captureFrame().
  assert.equal(result.captures.post.presented.error, undefined, `${label}: readPresentedCanvas failed: ${result.captures.post.presented.error}`);
  assert.ok(
    result.captures.post.presented.nonBlackPixels > 0,
    `${label}: the presented canvas holds no non-black pixel (${JSON.stringify(result.captures.post.presented)})`,
  );
  assert.equal(run.canvasScreenshot?.captured, true, `${label}: the harness did not capture the canvas (${JSON.stringify(run.canvasScreenshot)})`);
  assert.equal(run.canvasScreenshot.width, VIEWPORT.width, `${label}: the screenshot MUST be the pinned viewport width`);
  assert.equal(run.canvasScreenshot.height, VIEWPORT.height, `${label}: the screenshot MUST be the pinned viewport height`);
  assert.ok(run.canvasScreenshot.nonBackground > 0, `${label}: the settled frame on screen is blank (${JSON.stringify(run.canvasScreenshot)})`);
  // The composited settled frame is the authoritative presentation evidence, and SC-004(c) says it must
  // still satisfy SC-001/SC-002 — so the *same* coverage floor the capture-based statistics use applies
  // to it. A frame that is 1% covered means the interaction left the canvas (nearly) empty.
  assert.ok(
    run.canvasScreenshot.nonBackground / run.canvasScreenshot.considered >= COVERAGE_FLOOR,
    `${label}: the settled frame on screen covers only ${run.canvasScreenshot.nonBackground}/${run.canvasScreenshot.considered} pixels ` +
      `(${(run.canvasScreenshot.nonBackground / run.canvasScreenshot.considered).toFixed(4)} < ${COVERAGE_FLOOR}); centre pixel ${JSON.stringify(run.canvasScreenshot.centre)}`,
  );

  // One run, one backend: the other backend created zero GPU objects.
  assertOtherBackendUntouched(run, assert);

  // (b) THE PRODUCT'S OWN ERROR SURFACE — asserted **last** on purpose. A red run must still show
  // whether (a), (c) and (d) held, and a failure here (a `render-failed` diagnostic is the product
  // reporting that a frame failed, so an interaction that produces them is not a clean interaction:
  // this is the strict form of SC-004's "no uncaught error") must not mask the timing and frame claims.
  assert.deepEqual(
    result.diagnostics,
    [],
    `${label}: the handle reported ${result.diagnostics.length} diagnostic(s) during the run — first: ${JSON.stringify(result.diagnostics[0] ?? null)}; by category: ${JSON.stringify(
      result.diagnostics.reduce((counts, entry) => ({ ...counts, [entry.category]: (counts[entry.category] ?? 0) + 1 }), {}),
    )}`,
  );
  assert.deepEqual(result.uncaught, [], `${label}: in-page uncaught error(s): ${JSON.stringify(result.uncaught)}`);
  assert.deepEqual(run.requestFailures, [], `${label}: failed request(s): ${JSON.stringify(run.requestFailures)}`);
  assert.deepEqual(
    run.badResponses.filter((response) => response.url.includes("packages/cesium-webgpu/fixtures")),
    [],
    `${label}: the local server refused a fixture request: ${JSON.stringify(run.badResponses)}`,
  );

  return { result, distribution, stalls };
}

/**
 * Gather one arm's measurements **without asserting anything**, so the evidence file can be written
 * before the assertions run: a red arm must still leave its raw samples, distribution and verdicts on
 * disk (the harness overwrites `artifacts/interaction/<backend>.json` for every `runContractSuite`
 * call, so the last arm of the suite would otherwise erase the earlier arm's measurements).
 */
function gatherArm(run) {
  const result = run.report?.["result"]?.[SCENARIO_RESULT_KEY] ?? null;
  if (result === null || !Array.isArray(result.frameSamplesRaw) || result.frameSamplesRaw.length === 0) {
    return { result, distribution: { count: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null }, stalls: [], window: null };
  }
  const window = { fromMs: result.interaction.startMs, toMs: result.interaction.settleEndMs };
  const samples = result.frameSamplesRaw;
  const distribution = summariseGaps(
    samples.filter((sample) => typeof sample.gapMs === "number" && sample.t >= window.fromMs && sample.t <= window.toMs).map((sample) => sample.gapMs),
  );
  return { result, distribution, stalls: findStallRuns(samples, STALL_THRESHOLD_MS, window), window };
}

/**
 * The four SC-004 claims as booleans, computed **without throwing**, so one red assertion cannot hide
 * the state of the other three. These verdicts are written into the evidence file for every run.
 */
function armVerdicts(run, result, distribution, stalls) {
  if (result === null) {
    return { published: false, reason: "the scenario never published a result (the page failed before returning)" };
  }
  const pre = result.captures.pre.stats;
  const post = result.captures.post.stats;
  const framesByPhase = result.frameCounts.byPhase;
  const firstSample = result.frameCounts.window.firstSample;
  const lastSample = result.frameCounts.window.lastSample;
  const coverage =
    run.canvasScreenshot !== undefined && run.canvasScreenshot.captured === true && run.canvasScreenshot.considered > 0
      ? run.canvasScreenshot.nonBackground / run.canvasScreenshot.considered
      : null;
  const consoleErrors = run.consoleMessages.filter((message) => message.type === "error").length;
  return {
    published: true,
    "a_noContinuousStallOver1000ms": stalls.length === 0,
    "a_frameSamplesInWindow": distribution.count,
    "a_gapDistributionMs": distribution,
    "a_stalls": stalls,
    "b_noUncaughtError": run.pageErrors.length === 0 && run.report.errors.length === 0 && result.uncaught.length === 0 && consoleErrors === 0,
    "b_noProductDiagnostic": result.diagnostics.length === 0,
    "b_productDiagnosticCount": result.diagnostics.length,
    "c_settledFrameInSameInterval":
      post.nonBackgroundRatio >= pre.nonBackgroundRatio * (1 - COVERAGE_RELATIVE_BAND) &&
      post.nonBackgroundRatio >= COVERAGE_FLOOR &&
      post.uniqueColorCount >= UNIQUE_COLOUR_FLOOR &&
      post.tileCount >= pre.tileCount &&
      post.frameTimeMs.p95 <= STALL_THRESHOLD_MS,
    "c_settledFrameStillDrawing": post.drawCallCount > 0,
    "c_coveragePreToPost": [pre.nonBackgroundRatio, post.nonBackgroundRatio],
    "c_compositorCoverage": coverage,
    "c_compositorCoverageAtOrAboveFloor": coverage !== null && coverage >= COVERAGE_FLOOR,
    "d_frameCounterGrowing":
      INTERACTION_PHASES.every((phase) => framesByPhase[phase] >= MIN_FRAMES_PER_PHASE && result.frameCounts.capturesByPhase[phase] === 1) &&
      firstSample !== null &&
      lastSample !== null &&
      lastSample.rafInvokedTotal > firstSample.rafInvokedTotal,
    "d_framesByPhase": framesByPhase,
    "d_capturesByPhase": result.frameCounts.capturesByPhase,
  };
}

/** Distilled evidence for one arm; the harness artifact holds the raw report and sample array. */
function armEvidence(run, label, result, distribution, stalls, extra = {}) {
  if (result === null) {
    return {
      suite: SUITE,
      arm: label,
      backend: run.backend,
      runId: run.runId,
      url: run.url,
      pageError: run.error,
      published: false,
      pageErrors: run.pageErrors,
      consoleErrors: run.consoleMessages.filter((message) => message.type === "error"),
      reason: "the scenario never published a result, so no measurement exists for this arm",
      ...extra,
    };
  }
  return {
    suite: SUITE,
    arm: label,
    backend: run.backend,
    scenario: run.scenario,
    runId: run.runId,
    url: run.url,
    browserVersion: run.browserVersion,
    pageError: run.error,
    published: true,
    verdicts: armVerdicts(run, result, distribution, stalls),
    harnessArtifact: path.relative(REPO_ROOT, path.join(ARTIFACT_ROOT, "interaction", `${run.backend}.json`)).split(path.sep).join("/"),
    harnessArtifactNote:
      "the harness writes artifacts/interaction/<backend>.json at the end of *every* runContractSuite call, so the last arm of the file overwrites the earlier one — this distilled file is the record that survives, and it carries the raw frame samples it was computed from",
    conclusion: {
      stallThresholdMs: STALL_THRESHOLD_MS,
      stallsInInteractionWindow: stalls.length,
      frameSamplesInWindow: distribution.count,
      gapDistributionMs: distribution,
      framesByPhase: result.frameCounts.byPhase,
      nonScenarioRafCallbacksByPhase: result.frameCounts.nonScenarioRafCallbacksByPhase,
      capturesByPhase: result.frameCounts.capturesByPhase,
      interactionRealizedMs: result.interaction.realizedDurationMs,
      stepsApplied: result.interaction.stepsApplied,
      tilesLoaded: result.tiles.loaded,
      diagnostics: result.diagnostics.length,
      uncaught: result.uncaught.length,
      consoleErrors: run.consoleMessages.filter((message) => message.type === "error").length,
      pageErrors: run.pageErrors.length,
      canvasScreenshot: run.canvasScreenshot === undefined ? null : {
        captured: run.canvasScreenshot.captured,
        width: run.canvasScreenshot.width,
        height: run.canvasScreenshot.height,
        considered: run.canvasScreenshot.considered,
        nonBackground: run.canvasScreenshot.nonBackground,
        coverage: run.canvasScreenshot.considered === 0 ? null : run.canvasScreenshot.nonBackground / run.canvasScreenshot.considered,
        uniqueColours: run.canvasScreenshot.uniqueColours,
        centre: run.canvasScreenshot.centre,
      },
    },
    perPhaseDistribution: result.distributions.perPhase,
    thresholdSegmentation: result.distributions.overThresholdSegmentation,
    marks: result.distributions.marks,
    comparison: result.comparison,
    diagnosticsSummary: {
      count: result.diagnostics.length,
      byCategory: result.diagnostics.reduce((counts, entry) => ({ ...counts, [entry.category]: (counts[entry.category] ?? 0) + 1 }), {}),
      firstAtMs: result.diagnostics.length === 0 ? null : result.diagnostics[0].atMs,
      lastAtMs: result.diagnostics.length === 0 ? null : result.diagnostics[result.diagnostics.length - 1].atMs,
      distinctMessages: [...new Set(result.diagnostics.map((entry) => entry.message))].slice(0, 5),
    },
    uncaught: result.uncaught,
    frameSamplesRaw: result.frameSamplesRaw,
    captures: {
      pre: { atMs: result.captures.pre.atMs, stats: result.captures.pre.stats, own: result.captures.pre.own, presented: result.captures.pre.presented },
      probes: result.captures.probes.map((probe) => ({
        phase: probe.phase,
        stepIndex: probe.stepIndex,
        requestedAtMs: probe.requestedAtMs,
        resolvedAtMs: probe.resolvedAtMs,
        own: probe.own,
        differenceFromPreCapture: probe.differenceFromPreCapture,
        error: probe.error ?? null,
      })),
      post: { atMs: result.captures.post.atMs, stats: result.captures.post.stats, own: result.captures.post.own, presented: result.captures.post.presented },
      differencePreToPost: result.captures.differencePreToPost,
    },
    canvasScreenshot: run.canvasScreenshot ?? null,
    stepLog: result.interaction.stepLog,
    injectedStall: result.interaction.injectedStall,
    ...extra,
  };
}

function writeEvidence(fileName, payload) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, fileName);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

// ------------------------------------------------------------------------------------------------
// Arm 1 — the measured contract
// ------------------------------------------------------------------------------------------------

test("measured arm: 3 s of fixed-step rotate/zoom/pan holds (a) no >1000 ms stall, (b) no uncaught error, (c) the settled frame in the same interval, (d) a growing frame counter", async () => {
  const label = "measured arm";
  const run = await runContractSuite(SUITE, { viewport: { ...VIEWPORT }, timeoutMs: 420_000, captureCanvas: true });
  const { result, distribution, stalls } = assertInteractionArm(run, label);
  const evidence = armEvidence(run, label, result, distribution, stalls);
  const file = writeEvidence(`${run.backend}-interaction.json`, evidence);
  console.log(
    `${SUITE}[${run.backend}] ${label}: steps=${result.interaction.stepsApplied} duration=${result.interaction.realizedDurationMs}ms ` +
      `frames/window=${distribution.count} gap(min/p50/p95/p99/max)=${distribution.min}/${distribution.p50}/${distribution.p95}/${distribution.p99}/${distribution.max}ms ` +
      `stalls>${STALL_THRESHOLD_MS}ms=${stalls.length} coverage=${result.captures.pre.stats.nonBackgroundRatio}->${result.captures.post.stats.nonBackgroundRatio} ` +
      `colours=${result.captures.pre.stats.uniqueColorCount}->${result.captures.post.stats.uniqueColorCount} ` +
      `tiles=${result.captures.pre.stats.tileCount}->${result.captures.post.stats.tileCount} ` +
      `diagnostics=${result.diagnostics.length} uncaught=${result.uncaught.length} screenshotNonBackground=${run.canvasScreenshot?.nonBackground ?? null} ` +
      `evidence=${path.relative(REPO_ROOT, file).split(path.sep).join("/")}`,
  );
});

// ------------------------------------------------------------------------------------------------
// Arm 2 — the counter-example: proof that (a) is able to fail
// ------------------------------------------------------------------------------------------------

test("counter-example arm: an injected 1200 ms main-thread freeze MUST be flagged by the same stall assertion (so (a) is not unfalsifiable)", async () => {
  const label = "counter-example arm (injected 1200 ms freeze in the pan phase)";
  const run = await runContractSuite(SUITE, {
    viewport: { ...VIEWPORT },
    timeoutMs: 420_000,
    captureCanvas: true,
    query: { stall_ms: INJECTED_STALL_MS, stall_phase: "pan", stall_at_step: 10 },
  });
  // The freeze is injected on purpose: it must not corrupt the run, only the timing. `assertCleanRun`
  // covers uncaught page errors and console errors; the product's *diagnostic* channel is asserted by
  // the measured arm (this arm exists to prove the stall detector can fail, and the diagnostics it
  // observes are recorded in its evidence rather than asserted here).
  assertCleanRun(run, assert);

  const result = scenarioResult(run, label);
  const samples = result.frameSamplesRaw;
  const window = { fromMs: result.interaction.startMs, toMs: result.interaction.settleEndMs };

  const injected = result.interaction.injectedStall;
  assert.ok(injected !== null && injected !== undefined, `${label}: the page MUST record the injected freeze (got ${JSON.stringify(injected)})`);
  assert.equal(injected.requestedMs, INJECTED_STALL_MS, `${label}: the injected freeze MUST be the requested one`);
  assert.equal(injected.phase, "pan", `${label}: the freeze MUST land in the pan phase (the page reported "${injected.phase}")`);
  // The freeze delays the input timeline with it, so the tail of the interaction may be cut off by the
  // 3 s window (measured: 55 of 60 steps). What MUST hold is that every step *before* the freeze was
  // applied — the injection must not silently rewrite the trajectory it is injected into.
  assert.ok(
    result.interaction.stepsApplied >= 50 && result.interaction.stepsApplied <= 60,
    `${label}: the interaction applied ${result.interaction.stepsApplied} of 60 steps; steps up to the injected one (30 + ${injected.stepIndex} = ${30 + injected.stepIndex}) MUST all be applied`,
  );

  const stalls = findStallRuns(samples, STALL_THRESHOLD_MS, window);
  const distribution = summariseGaps(samples.filter((sample) => typeof sample.gapMs === "number" && sample.t >= window.fromMs && sample.t <= window.toMs).map((sample) => sample.gapMs));
  assert.ok(
    stalls.length >= 1,
    `${label}: the injected ${INJECTED_STALL_MS} ms freeze was NOT flagged as a stall > ${STALL_THRESHOLD_MS} ms — the measured arm's assertion would be unfalsifiable. ` +
      `Distribution: ${JSON.stringify(distribution)}; samples around the freeze: ${JSON.stringify(samples.filter((sample) => sample.injectedStall === true).slice(0, 3))}`,
  );
  const panStalls = stalls.filter((run_) => run_.phases.includes("pan"));
  assert.ok(panStalls.length >= 1, `${label}: no stall was attributed to the pan phase: ${JSON.stringify(stalls)}`);
  const peakGapMs = Math.max(...panStalls.map((entry) => entry.peakGapMs));
  assert.ok(
    peakGapMs >= INJECTED_STALL_MS - INJECTED_STALL_TOLERANCE_MS,
    `${label}: the detected stall peaks at ${peakGapMs} ms, below the injected ${INJECTED_STALL_MS} ms (−${INJECTED_STALL_TOLERANCE_MS} ms)`,
  );

  // THE ACTUAL ASSERTION OF ARM 1, RUN AGAINST THESE SAMPLES. It MUST throw; the message is the
  // "failure output summary" that proves the red state is reachable.
  const assertionMessage = `${label}: the interaction produced ${stalls.length} continuous stall(s) longer than ${STALL_THRESHOLD_MS} ms. Measured inter-frame gap distribution in [${window.fromMs}, ${window.toMs}] ms: ${JSON.stringify(distribution)}`;
  let failure = null;
  try {
    assert.equal(findStallRuns(samples, STALL_THRESHOLD_MS, window).length, 0, assertionMessage);
  } catch (error) {
    failure = String(error?.message ?? error);
  }
  assert.ok(failure !== null, `${label}: the measured arm's stall assertion PASSED on a run with an injected ${INJECTED_STALL_MS} ms freeze, i.e. it cannot fail`);

  // Threshold sensitivity: the detector follows the threshold it is given, so "flagged" is not a
  // constant. Runs are *maximal consecutive* over-threshold gaps, which is why the sensitivity is
  // measured on the raw flagged-sample counts (a 1 ms threshold would collapse into a single run).
  const relaxedRuns = findStallRuns(samples, NEGATIVE_CONTROL_RELAXED_THRESHOLD_MS, window);
  const flaggedAtContractThreshold = countFlagged(samples, STALL_THRESHOLD_MS, window);
  const flaggedAtRelaxedThreshold = countFlagged(samples, NEGATIVE_CONTROL_RELAXED_THRESHOLD_MS, window);
  const flaggedAtStrictThreshold = countFlagged(samples, NEGATIVE_CONTROL_STRICT_THRESHOLD_MS, window);
  assert.equal(relaxedRuns.length, 0, `${label}: no gap should exceed ${NEGATIVE_CONTROL_RELAXED_THRESHOLD_MS} ms (got ${JSON.stringify(relaxedRuns)})`);
  assert.equal(flaggedAtRelaxedThreshold, 0, `${label}: no sample should be flagged at ${NEGATIVE_CONTROL_RELAXED_THRESHOLD_MS} ms`);
  assert.ok(
    flaggedAtStrictThreshold >= 100 && flaggedAtStrictThreshold > flaggedAtContractThreshold * 10,
    `${label}: a ${NEGATIVE_CONTROL_STRICT_THRESHOLD_MS} ms threshold flagged ${flaggedAtStrictThreshold} samples and the contract threshold flagged ${flaggedAtContractThreshold}; the sampler does not resolve individual frames`,
  );

  const evidence = armEvidence(run, label, result, distribution, stalls, {
    injectedStall: injected,
    detector: {
      thresholdMs: STALL_THRESHOLD_MS,
      runsAtContractThreshold: stalls,
      flaggedSamplesAtContractThreshold: flaggedAtContractThreshold,
      relaxedThresholdMs: NEGATIVE_CONTROL_RELAXED_THRESHOLD_MS,
      runsAtRelaxedThreshold: relaxedRuns.length,
      flaggedSamplesAtRelaxedThreshold: flaggedAtRelaxedThreshold,
      strictThresholdMs: NEGATIVE_CONTROL_STRICT_THRESHOLD_MS,
      flaggedSamplesAtStrictThreshold: flaggedAtStrictThreshold,
    },
    measuredArmAssertionFailureSummary: failure,
  });
  evidence.comparison = result.comparison;
  const file = writeEvidence(`${run.backend}-negative-control.json`, evidence);
  console.log(
    `${SUITE}[${run.backend}] ${label}: injected=${injected.requestedMs}ms@${injected.phase} detectedRuns=${stalls.length} peakGap=${peakGapMs}ms ` +
      `flagged(5000ms)=${flaggedAtRelaxedThreshold} flagged(1000ms)=${flaggedAtContractThreshold} flagged(1ms)=${flaggedAtStrictThreshold} ` +
      `measuredArmAssertionFailed=${failure !== null} evidence=${path.relative(REPO_ROOT, file).split(path.sep).join("/")}`,
  );
  console.log(`${SUITE}[${run.backend}] failure summary of the measured arm's assertion on this run: ${failure}`);
});
