/**
 * W2 independent test — `contract-backend-core` (`层=契约`, tasks.md Phase 4 Independent Test).
 *
 * Run (one backend per process, one page load):
 *   node tests/support/backend-runner.mjs --backend=webgpu --suite=contract-backend-core
 *
 * What it asserts, in one independent run:
 *   - the replacement `Context` takes the pre-fetched device **inside the upstream `Scene` constructor**
 *     and publishes the capabilities and all 23 `ContextLimits` before the constructor returns (T043);
 *   - commands are executed on **derived passes** and a real frame is submitted and presented (T044/T050);
 *   - `device.destroy()` is recovered by a whole switch that destroys resources and rebuilds (T051);
 *   - **in this run the WebGL2 backend created 0 GPU objects** (FR-006/FR-011, principle II).
 */
import assert from "node:assert/strict";
import { test } from "playwright/test";

import { assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";

// Three scenarios in one page plus a real bundle build no longer fit Playwright's 30 s default
// (measured in W5, after the terrain work grew the bundle and the page instrumentation); every other
// contract spec pins the same cap.
test.setTimeout(300_000);

test("backend core: construct, dispatch, present and whole-switch, with zero GL objects", async () => {
  const run = await runContractSuite("contract-backend-core");
  assertCleanRun(run, assert);
  assertOtherBackendUntouched(run, assert);
  assert.equal(run.isolation, "separate-process", "one run = one process + one page load (principle II)");

  const result = run.report.result;
  const construction = result.sceneConstruct;
  assert.ok(construction !== undefined, "the composite MUST include the construction phase");

  // ---- T043: construction-time takeover ---------------------------------------------------------
  assert.equal(construction.handoffPendingBeforeConstruction, true, "the device MUST be parked in the slot before the scene exists");
  assert.equal(construction.handoffPendingAfterConstruction, false, "the constructor consumes the device exactly once");
  assert.match(String(construction.takeStack ?? ""), /Context/, "take() MUST happen inside the replacement Context constructor");
  assert.equal(construction.context.isReplacement, true, "`scene.context` MUST be the patch-layer replacement");
  assert.equal(construction.deviceIdentity, true, "the context MUST hold the very device that was handed over");
  assert.equal(construction.adapterIdentity, true);
  assert.equal(construction.context.webgl2, true, "modern-pipeline capability (historical name)");
  assert.equal(construction.context.msaa, true);
  assert.equal(construction.context.depthTexture, false, "slice A keeps the declared depth-texture degradation");
  assert.equal(construction.context.fragmentDepth, true);
  assert.equal(construction.context.stencilBits, 8);
  assert.equal(construction.context.textureFilterAnisotropic, false);
  assert.equal(construction.context.supportsBasis, false);
  assert.ok(construction.context.drawingBufferWidth > 0 && construction.context.drawingBufferHeight > 0, "the drawing buffer is sized from the canvas");
  assert.equal(construction.context.hasId, true, "the context MUST publish a GUID id (index-buffer cache key)");
  assert.equal(construction.context.uniformStatePresent, true, "the kept upstream UniformState MUST be constructed");

  assert.equal(construction.contextLimitsWritten.length, 23, "every ContextLimits member MUST be published during construction");
  assert.ok(construction.contextLimitsWritten.every((member) => member.startsWith("_")), "the backing fields are what upstream getters read");
  assert.ok(construction.upstreamContextLimits.maximumTextureSize > 0, "the kept upstream module MUST hold the composed values");
  assert.ok(construction.upstreamContextLimits.maximumSamples >= 4, "WebGPU guarantees 4x MSAA");
  assert.equal(construction.upstreamContextLimits.maximumTextureFilterAnisotropy, 1, "no anisotropic filtering in WebGPU");

  assert.equal(construction.context.defaultTexture.width, 1, "the default texture is 1x1 (upstream contract)");
  assert.equal(construction.context.defaultTexture.height, 1);
  assert.equal(construction.context.defaultTexture.flipY, false);
  assert.equal(construction.context.defaultTexture.pixelFormat, 0x1908, "PixelFormat.RGBA");
  assert.equal(construction.context.defaultTexture.pixelDatatype, 0x1401, "PixelDatatype.UNSIGNED_BYTE");
  assert.equal(construction.context.defaultTexture.sampler.addressModeU, "clamp-to-edge", "the default sampler is CLAMP_TO_EDGE");
  assert.equal(construction.context.defaultTexture.sampler.magFilter, "linear");

  // ---- T044/T050: dispatch, derived passes, submission and presentation --------------------------
  const present = result.present;
  assert.ok(present !== undefined, "the composite MUST include the dispatch/present phase");
  assert.equal(present.frameErrors.length, 0, "no GPU validation error may reach the frame boundary");
  assert.ok(present.counters.frames >= 3, `at least three frames were rendered (got ${present.counters.frames})`);
  assert.ok(present.counters.draws >= 9, `every scripted draw reached the encoder (got ${present.counters.draws})`);
  assert.ok(present.counters.submittedCommandBuffers >= 3, "every frame MUST submit exactly one command buffer");
  assert.ok(present.counters.clearsByLoadOp >= 3, "the first clear of a pass uses loadOp");
  assert.ok(present.pipelineCache.misses >= 1, "the pipeline cache MUST build the first pipeline (T048)");
  assert.ok(present.pipelineCache.hits >= 1, "an identical draw MUST hit the pipeline cache (T048)");
  assert.ok(present.lastFramePasses.length >= 2, "the scripted target switch MUST produce more than one derived pass");
  assert.ok(
    present.lastFramePasses.every((pass) => pass.closedBy === "identity-change" || pass.closedBy === "endFrame"),
    "every derived pass is closed by an identity change or by endFrame (G-3 check (c))",
  );
  assert.ok(present.lastFramePasses.every((pass) => pass.clearOps + pass.drawOps > 0), "no empty pass may be derived");
  assert.ok(present.lastFramePasses.some((pass) => pass.sampleCount === 4), "the swap-chain passes use the 4x MSAA attachment");

  const presented = present.presented;
  const shot = run.canvasScreenshot;
  assert.ok(shot !== undefined && shot.captured === true, `the harness MUST capture the presented canvas (${shot?.reason ?? "no capture"})`);
  assert.equal(shot.width > 0 && shot.height > 0, true, "the captured canvas region MUST have a size");
  assert.ok(
    shot.nonBackground > shot.considered * 0.5,
    `the presented canvas MUST show the rendered image (non-background ${shot.nonBackground}/${shot.considered})`,
  );
  const [red, green, blue] = shot.centre;
  assert.ok(blue > 120 && blue > red && green > red, `the presented centre pixel MUST be the drawn colour, got rgb(${shot.centre.slice(0, 3).join(", ")})`);
  // The in-page read-back is best-effort and, on this browser build, unusable for a WebGPU canvas;
  // the screenshot above is the presentation evidence. Assert the blind spot is *declared* rather than
  // silently ignored, and that whenever the read-back did produce an image it agrees with the shot.
  if (presented.readbackUnusable !== true) {
    assert.ok(presented.nonBlackPixels > 0, "when the in-page read-back yields an image it MUST not be blank");
  } else {
    assert.ok(typeof presented.reason === "string" && presented.reason.length > 20, "an unusable read-back MUST state its reason (FR-023)");
  }

  // ---- T051: device loss → whole switch ----------------------------------------------------------
  const lost = result.deviceLost;
  assert.ok(lost !== undefined, "the composite MUST include the device-loss phase");
  assert.ok(lost.record.destroyedResources > 0, "the teardown MUST have released resources (data-model §2.4)");
  assert.equal(lost.record.residualDraws, 0, "no draw may reach either backend while the switch runs");
  assert.equal(lost.record.trigger, "device-lost");
  assert.equal(lost.record.to, "webgpu", "the rebuild re-probed successfully and stayed on WebGPU");
  assert.equal(lost.rebuiltUsable, true, "the rebuilt backend MUST be usable without a page refresh");
  assert.deepEqual(lost.frameErrors, [], "the rebuilt backend produced no GPU error");

  // ---- the single-backend invariant, re-stated on the collected evidence -------------------------
  assert.equal(run.report.webgl2.objectsCreated, 0);
  assert.equal(run.report.webgl2.contextRequests, 0);
});
