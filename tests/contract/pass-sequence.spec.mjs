/**
 * T047 self-check — `contract:pass-sequence` (`层=契约`, `〖二选一〗`).
 *
 * Run (two independent runs, serial — never one session):
 *   node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:pass-sequence
 *   node tests/support/backend-runner.mjs --backend=webgl2 --suite=contract:pass-sequence
 *   node tests/support/compare-offline.mjs --artifact=artifacts/pass-sequence
 *
 * Each run records **its own** frame-level pass sequence: the WebGPU run from the derived pass state
 * machine, the WebGL2 run from a platform-level trace of the upstream path (G-3's technique). This spec
 * asserts the sequence of the run it belongs to; the cross-backend comparison happens offline in
 * `compare-offline.mjs`, because principle II forbids comparing two backends inside one session.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "playwright/test";

import { assertCleanRun, assertOtherBackendUntouched, artifactPath, runContractSuite } from "../support/contract-harness.mjs";

/** G-3's rule: a pass is defined by work operations, so every pass MUST contain at least one. */
function assertDerivedPassInvariants(passes) {
  assert.ok(passes.length >= 3, `the scripted workload MUST produce at least three passes (got ${passes.length})`);
  for (const pass of passes) {
    assert.ok(pass.clearOps + pass.drawOps > 0, `pass #${pass.index} MUST contain work (G-3: no empty pass)`);
    assert.ok(pass.drawOps >= 0 && pass.clearOps >= 0);
  }
  const last = passes.at(-1);
  assert.ok(last.drawOps > 0 || last.clearOps > 0, "the last pass MUST contain work");
  assert.equal(last.closedBy ?? "endFrame", "endFrame", "the frame ends by closing the last pass (G-3 check (c))");
}

test("this run records a well-formed frame-level pass sequence", async () => {
  const run = await runContractSuite("contract:pass-sequence");
  assertCleanRun(run, assert);
  assertOtherBackendUntouched(run, assert);

  const sequence = run.report.result["pass-sequence"];
  assert.ok(sequence !== undefined, "the scenario MUST publish its sequence");
  assert.ok(sequence.passes.length >= 3, "the workload switches targets, so several passes are expected");
  assertDerivedPassInvariants(sequence.passes);

  // The presentation target is the last thing the frame touches in both recordings.
  const last = sequence.passes.at(-1);
  if (run.backend === "webgpu") {
    assert.equal(last.keyText.includes("color=[swapchain]"), true, "the WebGPU frame ends on the swap chain");
    assert.equal(sequence.frameErrors.length, 0, "no GPU error on the recorded frame");
  } else {
    assert.equal(last.keyText.includes("colorTargets=[canvas]"), true, "the WebGL2 frame ends on the default framebuffer");
  }

  // The artefact the offline comparator consumes MUST exist for this backend.
  assert.equal(fs.existsSync(artifactPath("contract:pass-sequence", run.backend)), true, "the run artefact MUST be written");
});
