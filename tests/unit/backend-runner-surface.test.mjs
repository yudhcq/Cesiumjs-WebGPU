/**
 * T013 — shared verification scaffolding.
 *
 * Two obligations:
 *   1. `tests/support/backend-runner.mjs` exposes NO same-session dual-path / same-frame
 *      comparison entry point and accepts exactly one backend per run (principle II);
 *   2. `packages/cesium-webgpu/src/verify/stats.mjs` computes the documented frame statistics
 *      with known values on synthetic inputs.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, readText } from "../support/repo.mjs";
import * as runner from "../support/backend-runner.mjs";
import {
  computeFrameStatistics,
  depthDiscontinuityRatio,
  frameTimeSummary,
  nonBackgroundRatio,
  percentile,
  uniqueColorCount,
} from "../../packages/cesium-webgpu/src/verify/stats.mjs";

// ---------------------------------------------------------------------------
// backend runner surface
// ---------------------------------------------------------------------------

test("the runner exposes no same-session dual-path entry point", () => {
  const exported = Object.keys(runner).filter((name) => name !== "default");
  for (const name of exported) {
    assert.doesNotMatch(
      name,
      /compar|both|dual|sameFrame|overlay|compose|merge|pair/i,
      `export "${name}" looks like a forbidden same-session comparison entry point (principle II)`,
    );
  }
  const source = readText("tests/support/backend-runner.mjs");
  assert.doesNotMatch(source, /--backends=/, "the runner MUST NOT accept more than one backend");
  assert.doesNotMatch(source, /\bsameFrame\b|\bdualPath\b|\bbothBackends\b|\bcompareBackends\b/, "no dual-path entry points");
  assert.match(source, /isolation: "separate-process"/, "every run MUST declare its isolation mode");
});

test("exactly one backend is accepted per run", () => {
  const parsed = runner.parseArgs(["--backend=webgpu", "--suite=contract:terrain"]);
  assert.equal(parsed.backend, "webgpu");
  assert.deepEqual(parsed.suites, ["contract:terrain"]);

  assert.throws(() => runner.parseArgs(["--backend=webgpu,webgl2", "--suite=contract:terrain"]), /exactly one backend/);
  assert.throws(() => runner.parseArgs(["--suite=contract:terrain"]), /--backend=<webgpu\|webgl2> is required/);
  assert.throws(() => runner.parseArgs(["--backend=vulkan", "--suite=contract:terrain"]), /unknown backend/);
  assert.throws(() => runner.parseArgs(["--backend=webgpu", "--suite=nope"]), /unknown suite/);
  assert.throws(() => runner.parseArgs(["--backend=webgpu"]), /at least one --suite/);
});

test("the --suite mapping table matches the documented file mapping", () => {
  const entries = Object.entries(runner.SUITE_MAP);
  assert.ok(entries.length >= 27, `expected the full suite table, got ${entries.length} entries`);
  for (const [suite, file] of entries) {
    assert.match(file, /^tests\/(contract|visual|benchmark)\/[\w-]+\.spec\.mjs$/, `suite "${suite}" maps to an invalid file`);
  }
  // Spot checks against tasks.md "Path Conventions".
  assert.equal(runner.SUITE_MAP["contract-backend-core"], "tests/contract/backend-core.spec.mjs");
  assert.equal(runner.SUITE_MAP["smoke:present"], "tests/contract/smoke-present.spec.mjs");
  assert.equal(runner.SUITE_MAP["visual:terrain"], "tests/visual/terrain-multitile.spec.mjs");
  assert.equal(runner.SUITE_MAP["stability:leak"], "tests/benchmark/stability-leak.spec.mjs");
  assert.equal(new Set(entries.map(([, file]) => file)).size, entries.length, "suite files MUST be unique");
});

test("a run descriptor carries one backend and its isolation mode", () => {
  const descriptor = runner.describeRun({ backend: "webgl2", suites: ["contract:terrain"] });
  assert.equal(descriptor.backend, "webgl2");
  assert.equal(descriptor.isolation, "separate-process");
  assert.deepEqual(descriptor.suiteFiles, ["tests/contract/terrain.spec.mjs"]);
  assert.deepEqual(descriptor.fixedConditions, {
    datasetId: "matterhorn-z0-12",
    baseLayer: false,
    skyBox: false,
    skyAtmosphere: false,
  });
  assert.ok(REPO_ROOT.length > 0);
});

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

/** Build an RGBA buffer from a list of rows of [r,g,b,a] pixels. */
function pixelsFromRows(rows) {
  return Uint8Array.from(rows.flat(2));
}

test("percentiles use linear interpolation between closest ranks", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 0.5), 5.5);
  assert.ok(Math.abs(percentile(values, 0.95) - 9.55) < 1e-9, `expected ~9.55, got ${percentile(values, 0.95)}`);
  assert.equal(percentile([42], 0.5), 42);
  assert.ok(Number.isNaN(percentile([], 0.5)));
  assert.throws(() => percentile([1, 2], 1.5), /within \[0, 1\]/);
  // frameTimeSummary rounds to milliseconds with three decimals.
  assert.deepEqual(frameTimeSummary([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { p50: 5.5, p95: 9.55 });
});

test("nonBackgroundRatio counts pixels differing from the background", () => {
  const black = [0, 0, 0, 255];
  const white = [255, 255, 255, 255];
  const pixels = pixelsFromRows([
    [black, black, white, white],
    [black, black, white, white],
    [black, black, white, white],
    [black, black, white, white],
  ]);
  assert.equal(nonBackgroundRatio(pixels, { width: 4, height: 4 }), 0.5);
  assert.equal(nonBackgroundRatio(pixels, { width: 4, height: 4, background: white }), 0.5);
  assert.equal(nonBackgroundRatio(pixels, { width: 4, height: 4, background: [0, 0, 255, 255] }), 1);
  assert.throws(() => nonBackgroundRatio(pixels, { width: 3, height: 4 }), /expected 48 bytes/);
});

test("uniqueColorCount counts distinct RGBA tuples", () => {
  const a = [10, 20, 30, 255];
  const b = [10, 20, 31, 255];
  const c = [10, 20, 30, 254];
  const pixels = pixelsFromRows([
    [a, a, b],
    [b, c, c],
  ]);
  assert.equal(uniqueColorCount(pixels), 3);
  assert.equal(uniqueColorCount(pixelsFromRows([[a, a], [a, a]])), 1);
});

test("depthDiscontinuityRatio compares right/down neighbours against the threshold", () => {
  // 3x3 depth: a flat 0.5 plane with one far sample in the middle.
  const depth = Float32Array.from([0.5, 0.5, 0.5, 0.5, 0.9, 0.5, 0.5, 0.5, 0.5]);
  // Horizontal pairs: 6, vertical pairs: 6 -> 12 compared pairs.
  // The centre sample differs from all four neighbours -> 4 discontinuities.
  assert.equal(depthDiscontinuityRatio(depth, { width: 3, height: 3, threshold: 1e-4 }), 4 / 12);
  assert.equal(depthDiscontinuityRatio(depth, { width: 3, height: 3, threshold: 1 }), 0);
  assert.throws(() => depthDiscontinuityRatio(depth, { width: 2, height: 2, threshold: 0 }), /expected 4 samples/);
});

test("computeFrameStatistics returns the contract-shaped record on a synthetic frame", () => {
  const black = [0, 0, 0, 255];
  const grey = [128, 128, 128, 255];
  const pixels = pixelsFromRows([
    [black, black],
    [grey, grey],
  ]);
  const stats = computeFrameStatistics({
    pixels,
    width: 2,
    height: 2,
    depth: Float32Array.from([0, 0, 1, 1]),
    depthThreshold: 0.5,
    frameTimesMs: [4, 8, 12, 16],
    triangleCount: 1234,
    drawCallCount: 7,
    tileCount: 3,
  });
  assert.deepEqual(Object.keys(stats).sort(), [
    "depthDiscontinuityRatio",
    "drawCallCount",
    "frameTimeMs",
    "nonBackgroundRatio",
    "tileCount",
    "triangleCount",
    "uniqueColorCount",
  ]);
  assert.equal(stats.nonBackgroundRatio, 0.5);
  assert.equal(stats.uniqueColorCount, 2);
  // Depth samples laid out row-major as [[0, 0], [1, 1]]; four compared pairs:
  // (0,0)-(0,1) same row -> 0, (0,0)-(1,0) next row -> 1, (0,1)-(1,1) next row -> 1, (1,0)-(1,1) -> 0.
  // With threshold 0.5 exactly two pairs cross it -> 0.5.
  assert.equal(stats.depthDiscontinuityRatio, 0.5);
  assert.equal(stats.triangleCount, 1234);
  assert.equal(stats.drawCallCount, 7);
  assert.equal(stats.tileCount, 3);
  assert.deepEqual(stats.frameTimeMs, { p50: 10, p95: 15.4 });
});

test("statistics default the depth ratio when no depth buffer is supplied", () => {
  const stats = computeFrameStatistics({ pixels: Uint8Array.from([0, 0, 0, 255]), width: 1, height: 1 });
  assert.equal(stats.depthDiscontinuityRatio, 0);
  assert.equal(stats.nonBackgroundRatio, 0);
  assert.deepEqual(stats.frameTimeMs, { p50: 0, p95: 0 });
  assert.ok(path.isAbsolute(REPO_ROOT));
});
