/**
 * T044 self-check — `smoke:draw-dispatch` (`层=契约`).
 *
 * Run: `node tests/support/backend-runner.mjs --backend=webgpu --suite=smoke:draw-dispatch`
 *
 * A real frame goes through the replacement `Context`: clear, draws on the swap chain, a switch to an
 * offscreen target and back, submitted once and closed at `endFrame` — with the derived pass sequence
 * and the pipeline-cache counters as evidence.
 */
import assert from "node:assert/strict";
import { test } from "playwright/test";

import { assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";

test("commands are dispatched on derived passes and the frame closes cleanly", async () => {
  const run = await runContractSuite("smoke:draw-dispatch");
  assertCleanRun(run, assert);
  assertOtherBackendUntouched(run, assert);

  const dispatch = run.report.result["draw-dispatch"];
  assert.ok(dispatch !== undefined, "the scenario MUST publish its result");
  assert.deepEqual(dispatch.frameErrors, [], "the frame boundary MUST see no GPU error");
  assert.ok(dispatch.counters.frames >= 3);
  assert.ok(dispatch.counters.draws >= 9);
  assert.equal(dispatch.counters.submittedCommandBuffers, dispatch.counters.frames, "exactly one submission per frame");
  assert.ok(dispatch.counters.drawIndexedCalls >= 9, "the indexed draws used drawIndexed");
  assert.equal(dispatch.counters.drawCalls, 0, "no non-indexed draw was issued");
  assert.ok(dispatch.pipelineCache.misses >= 2, "the two structurally different draws build two pipelines");
  assert.ok(dispatch.pipelineCache.hits >= 2, "the repeated draws hit the cache (T048)");
  assert.ok(dispatch.lastFramePasses.length >= 2, "the target switch divides the frame into passes");
  assert.equal(dispatch.lastFramePasses.at(-1).closedBy, "endFrame", "the last pass is closed by endFrame");
  assert.ok(dispatch.lastFramePasses.every((pass) => pass.gpuPassCount === 1), "a first-clear pass needs exactly one GPU pass");
  assert.equal(dispatch.contextLimitsWritten.length, 23);
});
