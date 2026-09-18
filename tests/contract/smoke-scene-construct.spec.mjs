/**
 * T043 self-check — `smoke:scene-construct` (`层=契约`).
 *
 * Run: `node tests/support/backend-runner.mjs --backend=webgpu --suite=smoke:scene-construct`
 *
 * The upstream `Scene` constructor must complete on the replacement `Context`, with the device taken
 * from the hand-off slot **inside** the constructor and the capabilities/`ContextLimits` already final
 * by the time it returns (the H-2 claim G-2 measured, now on the real patch layer).
 */
import assert from "node:assert/strict";
import { test } from "playwright/test";

import { assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";

test("the upstream Scene constructs on the replacement Context and takes the device synchronously", async () => {
  const run = await runContractSuite("smoke:scene-construct");
  assertCleanRun(run, assert);
  assertOtherBackendUntouched(run, assert);

  const construction = run.report.result["scene-construct"];
  assert.ok(construction !== undefined, "the scenario MUST publish its result");
  assert.equal(construction.handoffPendingBeforeConstruction, true);
  assert.equal(construction.handoffPendingAfterConstruction, false);
  assert.match(String(construction.takeStack ?? ""), /Context/, "take() happens inside the replacement constructor");
  assert.match(String(construction.takeStack ?? ""), /Scene/, "…which the upstream Scene constructor calls (no await in between)");
  assert.equal(construction.context.isReplacement, true);
  assert.equal(construction.deviceIdentity, true);
  assert.equal(construction.adapterIdentity, true);
  assert.equal(construction.context.hasId, true);
  assert.equal(construction.contextLimitsWritten.length, 23);
  assert.equal(construction.context.webgl2, true);
  assert.equal(construction.context.msaa, true);
  assert.equal(construction.context.depthTexture, false, "slice A");
  assert.equal(construction.context.fragmentDepth, true);
  assert.ok(construction.upstreamContextLimits.maximumTextureSize > 0);
  assert.equal(construction.context.defaultTexture.width, 1);
  assert.equal(construction.context.defaultTexture.height, 1);
  assert.equal(construction.context.defaultTexture.flipY, false);
});
