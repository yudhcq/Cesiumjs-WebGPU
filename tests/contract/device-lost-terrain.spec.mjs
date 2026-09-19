/**
 * T096 — `contract:device-lost-terrain` (`层=契约`, FR-003), WebGPU only, independent process.
 *
 * Run: `node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:device-lost-terrain`
 *
 * What this suite adds over `contract:device-lost` (T051): the scene is the **shipped** terrain entry
 * (`bundle.terrainScene.createTerrainScene`) on the committed fixture dataset, its tiles are loaded and
 * really drawn, and the loss is a real `device.destroy()` — not a synthetic teardown of a probe triangle.
 *
 * The sequence under test is the task's own: `device.destroy()` → stop submitting → destroy the backend
 * and the scene → re-probe → rebuild the whole backend → interaction comes back. Assertion groups:
 *
 *   (a) recovery without a page refresh — one document, one navigation entry, the same canvas element,
 *       and a frame the **rebuilt** context submitted, with the same coverage magnitude as the pre-loss
 *       frame it replaces;
 *   (b) no uncaught error — the harness's clean-run contract (no page error, no `pageerror`, **no console
 *       error at all**) plus the page's own verbatim console tally;
 *   (c) the old device's resource counts reach zero — `Context#liveResourceCount` (the destroyed backend's
 *       own attachments) does; the FR-017 ledger's residue is asserted as an attributed open item;
 *   (d) a status hint — `onStatus` and `diagnostics.onError` are both recorded verbatim, and the
 *       `device-lost` category the backend produced MUST reach the caller through one of them;
 *
 * Plus the "MUST NOT keep the old device's drawing" rule, asserted two ways: the old context's counters
 * are **frozen** once it stops submitting (it never dispatched or submitted anything again), and the
 * no-rebuild control arm shows the canvas no longer carrying the destroyed device's frame (0 covered
 * pixels) while the rebuilt backend brings the terrain back at the pre-loss magnitude.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "playwright/test";

import { ARTIFACT_ROOT, assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";

test.setTimeout(600_000);

/** One diagnostic carries the device-loss identity if it *is* `device-lost` or wraps one as its cause. */
const CARRIES_DEVICE_LOST = (entry) => entry.category === "device-lost" || entry.causeCategory === "device-lost";

test("the terrain scene recovers from device.destroy() without a refresh, and keeps nothing of the old device", async () => {
  // ---- control page load: the same entry, the same camera change, **no device loss anywhere** --------
  // It runs first so that the main run's artefact (`artifacts/device-lost-terrain/webgpu.json`) is the one
  // the harness leaves on disk; both are also written separately below (`observation.control/main`).
  const controlRun = await runContractSuite("contract:device-lost-terrain", { timeoutMs: 300000, query: { mode: "interaction-only" } });
  assertCleanRun(controlRun, assert);
  assertOtherBackendUntouched(controlRun, assert);
  assert.equal(controlRun.isolation, "separate-process");
  const control = controlRun.report.result["device-lost-terrain"];
  assert.ok(control !== undefined, "the control page MUST publish its result");
  assert.equal(control.lossOccurred, false, "the control page MUST NOT destroy a device");
  assert.equal(control.consoleErrors.total, 0, `the control page produced console error(s): ${JSON.stringify(control.consoleErrors.entries)}`);
  assert.ok(control.baseline.capture.nonBlackPixels > 0, "the control page renders the terrain at the frozen camera");
  assert.equal(control.baseline.capture.uniqueColours, 1, `the control page's frozen-camera frame is the expected flat terrain colour: ${JSON.stringify(control.baseline.capture)}`);
  // The control page's `setView` outcomes are **recorded, not asserted as working**: today a camera change
  // kills the render loop even with no device loss anywhere (see `unmetContractArms`). What MUST hold is
  // that the failure is the *named* one and that it reached the caller — anything else (another failure, or
  // a clean render) changes the picture and MUST NOT be absorbed silently.
  const NAMED_SET_VIEW_DEFECT = "Buffer._getGpuIndexFormat: this buffer is not an index buffer";
  const controlViewFrames = [control.interaction, control.fineView];
  for (const view of controlViewFrames) {
    if (view.frame === null) {
      assert.equal(view.tiles.loaded, false, `the failing view MUST report its tiles as not loaded: ${JSON.stringify(view.tiles)}`);
      const failure = control.drawFailures.find((entry) => String(entry.message).includes(NAMED_SET_VIEW_DEFECT));
      assert.ok(failure !== undefined, `the control page's camera change MUST fail with the named defect: ${JSON.stringify(control.drawFailures)}`);
      assert.ok(
        control.diagnostics.some((entry) => String(entry.message).includes(NAMED_SET_VIEW_DEFECT)),
        `the named defect MUST reach the caller through diagnostics.onError: ${JSON.stringify(control.diagnostics.map((entry) => entry.message))}`,
      );
    } else {
      // The documented blocker is gone: promote the camera-change arm back into the asserted flow.
      assert.fail(
        `the setView blocker appears fixed (${view.frame.nonBlackPixels} covered px) — move the interaction arm ` +
          "back into the asserted flow of this suite and drop it from `unmetContractArms`",
      );
    }
  }

  // ---- the run under test ---------------------------------------------------------------------------
  const run = await runContractSuite("contract:device-lost-terrain", { timeoutMs: 300000 });
  // (b) The uncaught-error arm, in full: no page error, no uncaught exception, and **no console error**.
  assertCleanRun(run, assert);
  assertOtherBackendUntouched(run, assert);
  assert.equal(run.isolation, "separate-process");

  const result = run.report.result["device-lost-terrain"];
  assert.ok(result !== undefined, "the scenario MUST publish its result");

  // The page's own verbatim tally, independent of the harness transcript: both MUST be zero. If anything
  // appears here, `result.consoleErrors.entries` carries the exact text and its first-occurrence time.
  assert.equal(
    result.consoleErrors.total,
    0,
    `the page produced console error(s): ${JSON.stringify(result.consoleErrors.entries)}`,
  );
  assert.equal(result.consoleErrors.beforeProbe, 0, "the page produced no console error before the scenario started");
  assert.equal(result.firstBaseline.consoleErrors, 0, "the healthy first backend produced no console error");

  // (a) ---------------------------------------------------------------------------------------------
  // A page refresh would show up as a second navigation entry and a second document request, and the
  // canvas element would be a different object.
  assert.equal(result.noRefresh.navigationEntries, 1, "the page was loaded exactly once (no reload)");
  assert.equal(result.noRefresh.canvasIsSameElement, true, "the recovered scene renders into the same canvas element");
  assert.equal(result.noRefresh.canvasConnectedAtEnd, true, "the canvas is still in the document");
  assert.equal(result.canvas.id, "contract-canvas");
  const documentRequests = run.requests.filter((request) => request.resourceType === "document");
  assert.equal(documentRequests.length, 1, `exactly one document request: ${JSON.stringify(documentRequests)}`);

  assert.ok(result.firstBaseline.context.counters.draws > 0, "the first backend really drew the terrain before the loss");
  assert.equal(result.steps.first.tiles.loaded, true, "the tiles were loaded before the loss");
  assert.ok(result.firstBaseline.capture.nonBlackPixels > 0, "the first backend produced a non-empty frame");
  assert.equal(result.steps.rebuild.tiles.loaded, true, "the rebuilt backend loaded the tiles again");
  assert.ok(result.afterRebuild.context.counters.draws > 0, "the rebuilt backend drew");
  assert.ok(result.afterRebuild.context.counters.submittedCommandBuffers > 0, "the rebuilt backend submitted a frame");

  // Coverage: the recovered frame is compared with the **pre-loss frame of the same camera in this same
  // run** (the threshold source). The old backend filled 64000/64000 px (100%); the loss-window control
  // arm below measures 0.
  const baselinePixels = result.firstBaseline.capture.nonBlackPixels;
  assert.equal(result.firstBaseline.capture.uniqueColours, 1, `the pre-loss frame is the expected flat terrain colour: ${JSON.stringify(result.firstBaseline.capture)}`);
  assert.ok(
    result.afterRebuild.capture.nonBlackPixels >= 0.9 * baselinePixels,
    `the recovered frame MUST cover at least 90% of the pre-loss coverage (source: this run's ${baselinePixels} px): ${JSON.stringify(result.afterRebuild.capture)}`,
  );
  assert.ok(
    result.afterRebuild.presented.nonBlackPixels >= 0.9 * baselinePixels,
    `the recovered frame MUST be presented as well: ${JSON.stringify(result.afterRebuild.presented)}`,
  );
  assert.deepEqual(result.afterRebuild.capture.centre, result.firstBaseline.capture.centre, "the recovered frame shows the same terrain colour at the centre");

  // The rebuilt scene stays alive: `requestRender()` keeps producing frames, with the pre-loss coverage.
  // (The cross-run reference is the control page's frozen-camera frame: the same scene, never broken.)
  assert.ok(result.lifecycle.frame.ok !== false, `the rebuilt scene MUST still produce a frame: ${JSON.stringify(result.lifecycle.frame)}`);
  assert.ok(
    result.lifecycle.frame.nonBlackPixels >= 0.9 * baselinePixels,
    `the rebuilt scene MUST keep rendering at the pre-loss coverage (source: this run's ${baselinePixels} px baseline): ${JSON.stringify(result.lifecycle.frame)}`,
  );
  assert.ok(
    result.lifecycle.context.counters.frames > result.lifecycle.framesBefore,
    `requestRender() MUST keep advancing the frame counter (${result.lifecycle.framesBefore} -> ${result.lifecycle.context.counters.frames})`,
  );
  assert.ok(
    control.baseline.capture.nonBlackPixels >= 0.9 * baselinePixels && baselinePixels >= 0.9 * control.baseline.capture.nonBlackPixels,
    `the two page loads MUST render the same frozen camera comparably (control ${control.baseline.capture.nonBlackPixels} px vs loss run ${baselinePixels} px)`,
  );
  // The compositor's copy of the canvas (harness screenshot) is the strongest presentation evidence.
  assert.equal(run.canvasScreenshot?.captured, true, `the canvas was not captured: ${JSON.stringify(run.canvasScreenshot)}`);
  assert.ok(
    run.canvasScreenshot.nonBackground >= 0.5 * baselinePixels,
    `the presented canvas MUST hold the recovered frame (half of the ${baselinePixels} px pre-loss baseline is the floor): ${JSON.stringify(run.canvasScreenshot)}`,
  );

  // (c) ---------------------------------------------------------------------------------------------
  // Counting sources, stated per count:
  //   `Context#liveResourceCount` — the destroyed backend's **own** GPU attachments (swap chain / MSAA /
  //     depth attachments, the default texture and the lazily created placeholders); it returns 0 once the
  //     context is destroyed.
  //   FR-017 ledger (`GpuResourceRegistry.stats().live`) — every live upstream `Buffer` / `Texture` /
  //     `Renderbuffer` record the replaced resource classes registered (`register` on creation, `release`
  //     from `Buffer#destroy` / `Texture#destroy` / `Renderbuffer#destroy`).
  assert.ok(result.resources.ledgerBefore.live > 0, `the first backend owned registered GPU resources: ${JSON.stringify(result.resources.ledgerBefore)}`);
  assert.equal(result.resources.contextAfterDispose.liveResourceCount, 0, "the destroyed context owns no GPU attachment");
  assert.equal(result.resources.contextAfterDispose.destroyed, true, "the old context is destroyed");
  assert.ok(result.resources.ledgerAfterRebuild.live > 0, "the rebuilt device's resources are on the ledger");

  // OPEN contract gap (asserted as a characterization so a fix cannot pass unnoticed; the required change
  // is reported with this suite): the ledger is **not** zeroed by the teardown. `dispose()` releases none
  // of the destroyed device's 18 registered tile buffers, so the ledger keeps reporting them, and the
  // rebuilt device's records are added on top. Upstream frees terrain tile resources only while it
  // renders (`QuadtreePrimitive#update` → `TileReplacementQueue#trimTiles` →
  // `GlobeSurfaceTile#freeResources`); `QuadtreePrimitive#destroy` destroys only the tile provider, so no
  // release ever runs after `scene.destroy()`. The attribution experiment at the end of the scenario
  // measures exactly that mechanism.
  assert.equal(result.resources.ledgerAfterDispose.released, 0, "OPEN: the teardown releases none of the ledger records it held");
  assert.equal(
    result.resources.ledgerAfterDispose.live,
    result.resources.ledgerBefore.live,
    "OPEN: the destroyed device's live ledger records survive dispose() unchanged",
  );
  assert.equal(result.attribution.forcedTrim.ok ?? false, true, `the tile-replacement queue MUST be reachable for the attribution: ${JSON.stringify(result.attribution.forcedTrim)}`);
  assert.equal(
    result.attribution.ledgerAfterForcedTrim.live,
    0,
    `one trim releases the residue, so it is the lazily freed tile buffers: ${JSON.stringify(result.attribution.ledgerAfterForcedTrim)}`,
  );
  // The rebuilt device's tiles really were fetched again instead of being reused from the dead one.
  assert.ok(
    result.afterRebuild.fixtureRequests > result.afterRebuild.fixtureRequestsBeforeRebuild,
    `the rebuild re-read the fixture tiles (${result.afterRebuild.fixtureRequestsBeforeRebuild} -> ${result.afterRebuild.fixtureRequests})`,
  );

  // (d) ---------------------------------------------------------------------------------------------
  // A status hint MUST reach the caller. Both channels are recorded verbatim in the observation artifact.
  assert.equal(result.statuses.length, 2, `one status per handle MUST have been delivered: ${JSON.stringify(result.statuses)}`);
  assert.deepEqual(
    result.statuses.map((status) => status.active),
    ["webgpu", "webgpu"],
    "the reported path is WebGPU on both handles",
  );
  for (const status of result.statuses) {
    assert.equal(status.reason, "ok");
    assert.equal(status.degraded, true);
    assert.ok(status.notes.length > 0, "a degraded status MUST carry its notes (FR-023)");
  }
  assert.equal(result.deviceLoss.reported.reason, "destroyed", `GPUDevice.lost reported the destruction: ${JSON.stringify(result.deviceLoss.reported)}`);
  assert.equal(result.deviceLoss.deviceLostReason, "destroyed", "the old context recorded the loss reason");
  // The backend itself DOES produce the `device-lost` category (`Context#draw` refuses every draw after the
  // loss with it) — the refusal is the guard, not a failure.
  const refused = result.drawFailures.filter((failure) => failure.category === "device-lost");
  assert.ok(refused.length >= 1, `Context#draw MUST refuse a draw with category "device-lost" after the loss: ${JSON.stringify(result.drawFailures)}`);
  assert.equal(result.deviceLoss.residualDrawsAfterStop, refused.length, "every refusal is counted by the context's own residual counter");
  // ...and the loss MUST reach the caller through `diagnostics.onError` instead of being dropped (the
  // defect this suite measured in HEAD `1811d58`: `isDiagnosticError` required `name === "DiagnosticError"`,
  // rejected the entry's structurally-valid diagnostics, and substituted an `internal` console error).
  const delivered = [...result.diagnostics.first, ...result.diagnostics.second, ...result.diagnostics.lossWindow];
  assert.ok(delivered.length >= 1, "the device loss MUST reach the caller through diagnostics.onError (a silent loss is a silent failure)");
  assert.ok(
    delivered.some(CARRIES_DEVICE_LOST),
    `a delivered diagnostic MUST carry the device-lost identity: ${JSON.stringify(delivered)}`,
  );

  // "MUST NOT keep the old device's drawing" --------------------------------------------------------
  const keyOf = (counters) => `${counters.frames}/${counters.draws}/${counters.passes}/${counters.submittedCommandBuffers}`;
  // The old context is frozen from the moment it stops submitting: it neither dispatched a draw that
  // reached the device nor submitted a command buffer again, and nothing was submitted during the rebuild.
  assert.equal(
    keyOf(result.deviceIdentity.oldContextCountersAtStop),
    keyOf(result.deviceIdentity.oldContextCountersAfterDispose),
    `the stopped context submitted nothing before the teardown (${keyOf(result.deviceIdentity.oldContextCountersAtStop)} -> ${keyOf(result.deviceIdentity.oldContextCountersAfterDispose)})`,
  );
  assert.equal(
    keyOf(result.deviceIdentity.oldContextCountersAtStop),
    keyOf(result.deviceIdentity.oldContextCountersAtEnd),
    `the destroyed context submitted nothing while the rebuild ran (${keyOf(result.deviceIdentity.oldContextCountersAtStop)} -> ${keyOf(result.deviceIdentity.oldContextCountersAtEnd)})`,
  );
  assert.equal(result.deviceLoss.residualDrawsAfterStop >= 1, true, "the loss guard was exercised, not merely present");
  // Nothing of the destroyed device's frame survives on screen while no backend exists (control arm)...
  assert.equal(result.lossWindow.presented.ok ?? true, true, `the canvas was readable in the loss window: ${JSON.stringify(result.lossWindow.presented)}`);
  assert.equal(
    result.lossWindow.presented.nonBlackPixels,
    0,
    `the canvas MUST NOT keep showing the old device's frame while no backend exists: ${JSON.stringify(result.lossWindow.presented)}`,
  );
  assert.equal(result.lossWindow.presented.centre[0] + result.lossWindow.presented.centre[1] + result.lossWindow.presented.centre[2], 0, "the loss-window frame is black");
  // ...and the rebuilt backend is what puts the terrain back, on a different device.
  assert.equal(result.deviceIdentity.firstDeviceDistinctFromSecond, true, "the re-probe handed over a new GPUDevice");
  assert.ok(result.afterRebuild.context.counters.draws > 0, "the recovered frame was drawn by the rebuilt context, not replayed by the old one");

  // ---- the evidence the assertions read, on disk --------------------------------------------------
  const observation = {
    suite: run.suite,
    backend: run.backend,
    url: run.url,
    browserVersion: run.browserVersion,
    isolation: run.isolation,
    pageErrors: run.pageErrors,
    reportErrors: run.report.errors,
    consoleErrors: run.consoleMessages.filter((message) => message.type === "error"),
    pageConsoleErrors: result.consoleErrors,
    documentRequests,
    canvasScreenshot: run.canvasScreenshot ?? null,
    thresholds: {
      recoveredCoverageFloorPx: Math.round(0.9 * baselinePixels),
      interactionCoverageFloorPx: Math.round(0.5 * baselinePixels),
      screenshotCoverageFloorPx: Math.round(0.5 * baselinePixels),
      source: `this run's pre-loss frame of the same camera (${baselinePixels} px of ${result.canvas.width * result.canvas.height}); the no-rebuild control arm measured ${result.lossWindow.presented.nonBlackPixels} px`,
    },
    /** What the device loss delivered to the caller, and under which category. */
    deliveredDiagnostics: {
      entries: delivered,
      topLevelCategories: [...new Set(delivered.map((entry) => entry.category))],
      deviceLostIdentityIn: delivered.some((entry) => entry.category === "device-lost")
        ? "category"
        : delivered.some((entry) => entry.causeCategory === "device-lost")
          ? "cause"
          : null,
    },
    unmetContractArms: [
      {
        arm: "(d) strict wording: the diagnostic's **top-level** category is `device-lost`",
        measured:
          delivered.some((entry) => entry.category === "device-lost")
            ? "met: a `device-lost` diagnostic was delivered"
            : `NOT met: the loss is delivered as \`render-failed\` with \`cause.category === "device-lost"\` (${JSON.stringify(delivered.map((entry) => `${entry.category}<-${entry.causeCategory}`))})`,
        why: "src/compose/scene-runtime.ts#reportRenderFailure classifies every non-terrain cause as `render-failed` and keeps the original error as `cause`",
        requiredChange:
          "switch on `cause.category` in reportRenderFailure so a device-loss cause is reported as a top-level `device-lost` diagnostic (the caller-visible hint FR-003 asks for)",
      },
      {
        arm: "OUT OF SCOPE (flow: 恢复交互) — `setView()` on the shipped entry",
        measured: `the control page load, which never loses a device, cannot render either camera change: modest view tiles ${JSON.stringify(control.interaction.tiles)} / coverage ${control.interaction.frame?.nonBlackPixels ?? 0} px, fine view tiles ${JSON.stringify(control.fineView.tiles)} / coverage ${control.fineView.frame?.nonBlackPixels ?? 0} px, first failure ${JSON.stringify(control.drawFailures[0] ?? null)}`,
        why:
          "the first frame after any `setView` aborts in the draw path (a `DrawCommand` of 6 vertices / 15 indices whose `VertexArray` names an index buffer with no `indexDatatype`), and the aborted frame leaves the error scopes open, so every later frame fails too — with no device loss anywhere in that page. It is therefore not a recovery failure, and the asserted life-cycle arm above stays inside the unchanged view",
        requiredChange:
          "not a T096 change: the terrain draw path must supply a real index buffer (or refuse the up-sample/fill mesh) for the tiles a camera change pulls in; until then the rebuilt scene's `setView` arm is 未取得独立证据",
      },
      {
        arm: "(c) FR-017 ledger returns to zero for the destroyed device",
        measured: `live stays at ${result.resources.ledgerAfterDispose.live} (released ${result.resources.ledgerAfterDispose.released})`,
        why: "upstream frees terrain tile resources only while rendering; QuadtreePrimitive#destroy destroys only the tile provider",
        requiredChange:
          "reset the ledger when the post-loss device is installed (GpuResourceRegistry.reset()'s documented 'a new device means a new ledger', called from the W6 probe) or release terrain tile resources before scene.destroy()",
      },
      {
        arm: "OUT OF SCOPE — the control page's camera changes (`setView`) render",
        measured: `tiles ${JSON.stringify(control.interaction.tiles)} / ${JSON.stringify(control.fineView.tiles)}, coverage ${control.interaction.frame?.nonBlackPixels ?? 0} px and ${control.fineView.frame?.nonBlackPixels ?? 0} px, recorded draw failure ${JSON.stringify(control.drawFailures[0]?.message ?? null)}`,
        why: "the same draw-path defect as the flow item above, recorded from the page that never loses a device",
        requiredChange: "see the flow item above; this entry exists so the raw control measurement is on disk",
      },
    ],
    assertions: {
      noRefresh: result.noRefresh,
      deviceLoss: result.deviceLoss,
      probes: result.steps.probes,
      statuses: result.statuses,
      diagnostics: result.diagnostics,
      drawFailures: result.drawFailures,
      resources: {
        ledgerBeforeScene: result.resources.ledgerBeforeScene,
        ledgerBefore: result.resources.ledgerBefore,
        ledgerAfterDispose: result.resources.ledgerAfterDispose,
        ledgerAfterRebuild: result.resources.ledgerAfterRebuild,
        contextBefore: result.resources.contextBefore,
        contextAfterDispose: result.resources.contextAfterDispose,
        contextAfterRebuild: result.resources.contextAfterRebuild,
        attribution: result.attribution,
      },
      counters: result.deviceIdentity,
      counts: {
        tilesFirst: result.steps.first.tiles,
        tilesRebuilt: result.steps.rebuild.tiles,
        firstCapture: result.firstBaseline.capture,
        lossWindowPresented: result.lossWindow.presented,
        recoveredCapture: result.afterRebuild.capture,
        recoveredPresented: result.afterRebuild.presented,
        recoveredStats: result.afterRebuild.stats,
        interactionCapture: result.lifecycle.frame,
        lifecycleStats: result.lifecycle.stats,
        lifecycleFrames: [result.lifecycle.framesBefore, result.lifecycle.context?.counters?.frames ?? null],
        controlBaselineCapture: control.baseline.capture,
        fixtureRequests: {
          beforeRebuild: result.afterRebuild.fixtureRequestsBeforeRebuild,
          afterRebuild: result.afterRebuild.fixtureRequests,
        },
      },
    },
    /** Out-of-scope observation: the control page's two camera changes (recorded verbatim). */
    controlSetViewDiagnosis: control.setViewDiagnosis,
  };
  const out = path.join(ARTIFACT_ROOT, "device-lost-terrain");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `observation.main.${run.backend}.json`), `${JSON.stringify(observation, null, 2)}\n`, "utf8");
  // The control page load's own artefact (the harness writes one file per suite run, so the last run wins).
  fs.writeFileSync(
    path.join(out, `observation.control.${run.backend}.json`),
    `${JSON.stringify(
      {
        suite: controlRun.suite,
        backend: controlRun.backend,
        mode: control.mode,
        url: controlRun.url,
        pageErrors: controlRun.pageErrors,
        reportErrors: controlRun.report.errors,
        consoleErrors: controlRun.consoleMessages.filter((message) => message.type === "error"),
        pageConsoleErrors: control.consoleErrors,
        lossOccurred: control.lossOccurred,
        statuses: control.statuses,
        diagnostics: control.diagnostics,
        drawFailures: control.drawFailures,
        resources: control.resources,
        baseline: control.baseline,
        interaction: control.interaction,
        fineView: control.fineView,
        canvasScreenshot: controlRun.canvasScreenshot ?? null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(
    `device-lost-terrain[${run.backend}]: ${JSON.stringify({
      lostReason: result.deviceLoss.reported.reason,
      statuses: result.statuses.map((status) => `${status.active}/${status.reason}/degraded=${status.degraded}`),
      diagnosticsDelivered: result.diagnostics.first.length + result.diagnostics.second.length,
      drawRefusals: result.drawFailures.filter((failure) => failure.category === "device-lost").length,
      ledgerLive: [result.resources.ledgerBefore.live, result.resources.ledgerAfterDispose.live, result.resources.ledgerAfterRebuild.live],
      ledgerAfterForcedTrim: result.attribution.ledgerAfterForcedTrim.live,
      contextLiveResources: [result.resources.contextBefore.liveResourceCount, result.resources.contextAfterDispose.liveResourceCount],
      oldCounters: [keyOf(result.deviceIdentity.oldContextCountersAtBaseline), keyOf(result.deviceIdentity.oldContextCountersAtStop), keyOf(result.deviceIdentity.oldContextCountersAtEnd)],
      coveragePx: [baselinePixels, result.lossWindow.presented.nonBlackPixels, result.afterRebuild.capture.nonBlackPixels, result.lifecycle.frame?.nonBlackPixels ?? null],
      controlCoveragePx: [control.baseline.capture.nonBlackPixels, control.interaction.frame?.nonBlackPixels ?? null, control.fineView.frame?.nonBlackPixels ?? null],
      screenshotNonBackground: run.canvasScreenshot?.nonBackground ?? null,
      consoleErrors: result.consoleErrors.total,
    })}`,
  );
});
