/**
 * T050 self-check — `smoke:present` (`层=契约`).
 *
 * Run: `node tests/support/backend-runner.mjs --backend=webgpu --suite=smoke:present`
 *
 * Submission is not presentation. The harness screenshots the canvas region after the page leaves its
 * last frame on screen, so the assertion is about what the compositor shows — the strongest available
 * evidence that the resolved 4x MSAA image reached the canvas.
 */
import assert from "node:assert/strict";
import { test } from "playwright/test";

import { assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";

test("the rendered frame is presented on the canvas (compositor read-back)", async () => {
  const run = await runContractSuite("smoke:present");
  assertCleanRun(run, assert);
  assertOtherBackendUntouched(run, assert);

  const present = run.report.result.present;
  assert.ok(present !== undefined, "the scenario MUST publish its result");
  assert.deepEqual(present.frameErrors, []);
  assert.ok(present.lastFramePasses.some((pass) => pass.sampleCount === 4), "the swap-chain pass uses the 4x MSAA attachment");

  const shot = run.canvasScreenshot;
  assert.ok(shot !== undefined && shot.captured === true, `the canvas region MUST be captured (${shot?.reason ?? "none"})`);
  assert.ok(shot.nonBackground > shot.considered * 0.5, `the canvas MUST show the image (${shot.nonBackground}/${shot.considered} non-background pixels)`);
  const [red, green, blue] = shot.centre;
  assert.ok(blue > 120 && blue > red && green > red, `the centre pixel MUST be the drawn colour, got rgb(${shot.centre.slice(0, 3).join(", ")})`);
  assert.ok(shot.uniqueColours > 1, `the canvas MUST contain more than one colour (got ${shot.uniqueColours})`);

  const inPage = present.presented;
  if (inPage.readbackUnusable !== true) {
    assert.ok(inPage.nonBlackPixels > 0, "when the in-page read-back yields an image it MUST not be blank");
  } else {
    assert.ok(typeof inPage.reason === "string" && inPage.reason.length > 20, "the declared blind spot MUST state its reason");
  }
});
