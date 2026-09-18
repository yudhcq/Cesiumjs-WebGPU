/**
 * T058 — texture origin (Y-flip) policy, fixed by a four-corner texel read-back
 * (`层=视觉`, tasks.md T058; H-7, research §6.3, spike §4).
 *
 * Run (**one backend only** — T058's scope is the WebGPU upload policy, so this suite carries no
 * "two backends" marker):
 *   node tests/support/backend-runner.mjs --backend=webgpu --suite=visual:texture-origin
 *
 * What it proves. The same 2x2 source is uploaded twice, once with `flipY: true` (upstream's default)
 * and once with `flipY: false`, and the two are drawn side by side. The harness samples the centre of
 * each texel on screen and the spec asserts the exact colour of every corner. Because WebGPU's `v` is
 * top-down while GL's `t` is bottom-up, only the **row-reversed upload** makes the flipped half match
 * GL's convention; without it the two halves would simply swap — which is the regression this suite
 * catches. The `flipY: false` half is the negative control: it MUST show the vertically mirrored
 * image, so the assertion cannot pass for the trivial reason that both halves look the same.
 */
import assert from "node:assert/strict";
import { test } from "playwright/test";

import { assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";

// One run builds the bundle, launches Chrome and loads the page; a cold build alone exceeds
// Playwright's 30 s default, so the budget is stated here.
test.setTimeout(300_000);

/** The four texels of the source, row 0 first (top row first — the upstream convention). */
const SOURCE = [
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 255, 255, 0, 255,
];
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];

/** Mid-texel sample points: 25 % / 75 % of each half (each half is one 2x2 image). */
const SAMPLE_POINTS = [
  { name: "left-top-left", x: 0.125, y: 0.25 },
  { name: "left-top-right", x: 0.375, y: 0.25 },
  { name: "left-bottom-left", x: 0.125, y: 0.75 },
  { name: "left-bottom-right", x: 0.375, y: 0.75 },
  { name: "right-top-left", x: 0.625, y: 0.25 },
  { name: "right-top-right", x: 0.875, y: 0.25 },
  { name: "right-bottom-left", x: 0.625, y: 0.75 },
  { name: "right-bottom-right", x: 0.875, y: 0.75 },
];

/** The colour each corner MUST show when the upload policy is right. */
const EXPECTED_FLIPPED = { "left-top-left": RED, "left-top-right": GREEN, "left-bottom-left": BLUE, "left-bottom-right": YELLOW };
const EXPECTED_UNFLIPPED = { "right-top-left": BLUE, "right-top-right": YELLOW, "right-bottom-left": RED, "right-bottom-right": GREEN };

function assertTexel(sample, expected, label) {
  assert.ok(sample !== undefined, `the harness MUST have sampled "${label}"`);
  const [r, g, b] = sample.rgba;
  const close = (value, target) => Math.abs(value - target) <= 24;
  assert.ok(
    close(r, expected[0]) && close(g, expected[1]) && close(b, expected[2]),
    `${label} MUST be rgb(${expected.join(", ")}), got rgb(${[r, g, b].join(", ")}) at (${sample.x}, ${sample.y})`,
  );
}

test("visual:texture-origin — the flipped upload reproduces GL's texture origin", async () => {
  const run = await runContractSuite("visual:texture-origin", { captureCanvas: true, samplePoints: SAMPLE_POINTS });
  assertCleanRun(run, assert);
  assertOtherBackendUntouched(run, assert);

  const origin = run.report.result["texture-origin"];
  assert.ok(origin !== undefined, "the page MUST publish the texture-origin report");
  assert.deepEqual(origin.source, SOURCE, "the page MUST upload exactly the 2x2 source this suite asserts on");
  assert.deepEqual(origin.counts.frameErrors, [], `the frame MUST produce no GPU error (got ${JSON.stringify(origin.counts.frameErrors)})`);
  assert.ok(origin.counts.draws >= 2, "both halves are drawn in one frame");

  // The upload plans are the mechanism: the flipped one reverses the rows, the control does not.
  assert.equal(origin.uploads.flipped.flipped, true, "flipY: true MUST reverse the row order on upload");
  assert.equal(origin.uploads.unflipped.flipped, false, "flipY: false MUST NOT reverse anything");
  assert.deepEqual(
    origin.uploads.flipped.bytes,
    [0, 0, 255, 255, 255, 255, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255],
    "the uploaded bytes start with the source's LAST row (blue|yellow)",
  );
  assert.deepEqual(origin.uploads.unflipped.bytes, SOURCE, "the control uploads the source unchanged");
  assert.equal(origin.uploads.flipped.bytesPerRow, 8);
  assert.notDeepEqual(origin.uploads.flipped.bytes, origin.uploads.unflipped.bytes, "the two uploads MUST differ, or the test proves nothing");

  const shot = run.canvasScreenshot;
  assert.ok(shot !== undefined && shot.captured === true, `the harness MUST capture the canvas (${shot?.reason ?? "no capture"})`);
  const samples = new Map((shot.samples ?? []).map((sample) => [sample.name, sample]));
  assert.deepEqual([...samples.keys()].sort(), SAMPLE_POINTS.map((point) => point.name).sort());

  // ---- the four corner texels of the flipped (renderable) half --------------------------------
  for (const [name, expected] of Object.entries(EXPECTED_FLIPPED)) {
    assertTexel(samples.get(name), expected, name);
  }
  // ---- the negative control: the unflipped half MUST be the vertical mirror --------------------
  for (const [name, expected] of Object.entries(EXPECTED_UNFLIPPED)) {
    assertTexel(samples.get(name), expected, name);
  }
  // Stated explicitly, so a future refactor cannot make both halves agree "by symmetry": the same
  // screen position shows different texels on the two halves, and that difference IS the policy.
  assert.notDeepEqual(samples.get("left-top-left").rgba.slice(0, 3), samples.get("right-top-left").rgba.slice(0, 3), "the two halves MUST show different texels at the same relative position");
  // The page's own expectation table agrees with this suite's (no drift between them).
  assert.deepEqual(origin.expected.flipped, { topLeft: RED, topRight: GREEN, bottomLeft: BLUE, bottomRight: YELLOW });
  assert.deepEqual(origin.expected.unflipped, { topLeft: BLUE, topRight: YELLOW, bottomLeft: RED, bottomRight: GREEN });
});
