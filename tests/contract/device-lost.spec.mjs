/**
 * T051 self-check — `contract:device-lost` (`层=契约`, independent process).
 *
 * Run: `node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:device-lost`
 *
 * The switch is a **teardown**, so the evidence is: the old backend's resources were destroyed, no draw
 * reached either backend while it ran, the rebuild produced a usable backend without a page refresh, and
 * nothing of the old frame is kept as an overlay (FR-003/FR-006).
 */
import assert from "node:assert/strict";
import { test } from "playwright/test";

import { assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";

test("device loss is recovered by a whole switch, with no residual draws and no overlay", async () => {
  const run = await runContractSuite("contract:device-lost");
  assertCleanRun(run, assert);
  assertOtherBackendUntouched(run, assert);
  assert.equal(run.isolation, "separate-process");

  const lost = run.report.result["device-lost"];
  assert.ok(lost !== undefined, "the scenario MUST publish its result");
  assert.ok(lost.liveResourcesBefore > 0, "the first backend owned GPU resources before the loss");
  assert.ok(lost.record.destroyedResources > 0, "the teardown MUST have released resources (data-model §2.4)");
  assert.equal(lost.record.residualDraws, 0, "`residualDraws === 0`: no draw reaches either backend during the switch");
  assert.equal(lost.record.trigger, "device-lost");
  assert.equal(lost.record.to, "webgpu", "the re-probe succeeded, so the session stayed on WebGPU");
  assert.ok(lost.record.rebuildMs >= 0);
  assert.equal(lost.rebuiltUsable, true, "the rebuilt backend renders without a refresh");
  assert.ok(lost.rebuiltCounters.submittedCommandBuffers >= 1, "the rebuilt backend actually submitted a frame");
  assert.deepEqual(lost.frameErrors, [], "the rebuilt backend produced no GPU error");
  assert.equal(lost.overlayEvidence.stopSubmittingDraws, 0, "no draw slipped through during the switch");
});
