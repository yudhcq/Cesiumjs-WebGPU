/**
 * `device-lost-terrain` — T096 (FR-003): a **terrain** scene survives `device.destroy()` without a page
 * refresh, by re-probing the adapter, rebuilding the whole backend, and rendering again.
 *
 * ## What makes this different from `device-lost` (T051)
 *
 * T051 swaps the backend on an **empty** scene: its "draw" is a probe-owned triangle, its teardown is
 * `Context#destroy()`, and it never destroys the `GPUDevice` itself. This scenario runs the shipped
 * entry (`bundle.terrainScene.createTerrainScene`, T089) on the committed fixture dataset, waits for the
 * tiles to be loaded and drawn, and then really calls `device.destroy()`. The evidence is therefore
 * about a scene that owns real GPU resources (terrain tile buffers), not about a synthetic triangle.
 *
 * ## Two modes, one page architecture (`?mode=`)
 *
 *   - `mode=device-loss` (default) — the task's sequence, in order:
 *     `device.destroy()` → `stopSubmitting()` → destroy the backend + scene → re-probe → rebuild →
 *     interact again, with the coverage/contract measurements.
 *   - `mode=interaction-only` — the **control page load**: the very same entry, camera change and
 *     fine-view diagnosis, but **no device loss anywhere**. It is what makes "this failure is not a
 *     consequence of the loss" a measurement instead of a claim: both pages run the same code paths and
 *     the suite compares them.
 *
 * Measured in both modes: the loss reason from `GPUDevice.lost`, the diagnostics/status actually
 * surfaced (verbatim), the backend's resource counts, what the canvas shows in the *no-rebuild* window
 * (the control arm for "MUST NOT keep the old device's drawing"), every console error, and the frame the
 * rebuilt backend presents once its tiles are loaded again.
 *
 * ## Module rules
 *
 * Scenario modules import **nothing** (`probe.js` calls `main()` on import), so every helper arrives
 * through `ctx`; the default export is `(bundle, canvas, ctx) => result`. `step()` is the page's progress
 * log; the returned object is published under `report.result["device-lost-terrain"]`.
 *
 * ## Instrumentation, and why it is allowed
 *
 * The public handle deliberately exposes no `Context`, no `GPUDevice` and no `stopSubmitting()` (FR-007
 * keeps the entry backend-agnostic). This scenario therefore wraps `Context.prototype.beginFrame` /
 * `draw` **before the scene exists** and keeps the live context instances the product creates — the same
 * technique the page's own `ctx.instrumentContextDraw` / `ctx.instrumentFramebufferManager` helpers use.
 * Every wrapper forwards unconditionally (and rethrows what it caught), so the measurement cannot change
 * the behaviour it measures: every number read back is the product's own (`Context#counters`,
 * `Context#liveResourceCount`, the FR-017 ledger).
 */
export default async function deviceLostTerrainScenario(bundle, canvas, ctx) {
  const { backend, step, prefetchDevice, readPresentedCanvas } = ctx;

  // `device.destroy()` has no counterpart on the WebGL2 path (the task scopes this suite to WebGPU).
  if (backend !== "webgpu") {
    return { scenario: "device-lost-terrain", backend, skipped: "this suite only runs on the webgpu backend" };
  }

  const mode = typeof ctx.params?.get === "function" ? ctx.params.get("mode") ?? "device-loss" : "device-loss";
  const DATASET_ID = "matterhorn-z0-12";
  /** The frozen MVP camera (`scene-config.ts` `DEFAULT_CAMERA`), passed explicitly so the view is fixed. */
  const CAMERA = { longitude: 6.8652, latitude: 45.8326, height: 24000, heading: 0, pitch: -50, roll: 0 };
  /**
   * The two camera changes the **control page** applies (neither is asserted to work — they exist to show
   * whether a failure depends on the device loss at all). `INTERACTION_CAMERA` is a rotation plus a small
   * zoom at the initial view's distance; `FINE_CAMERA` is close enough to need tiles finer than the
   * committed dataset (level > 12), i.e. upstream's up-sample/fill path.
   */
  const INTERACTION_CAMERA = { longitude: 6.8652, latitude: 45.8326, height: 22000, heading: 40, pitch: -48, roll: 0 };
  const FINE_CAMERA = { longitude: 6.8152, latitude: 45.8926, height: 9000, heading: 35, pitch: -35, roll: 0 };
  /** The contract page's viewport, so the reused `#contract-canvas` keeps the size the harness screenshots. */
  const VIEWPORT = { width: 320, height: 200, devicePixelRatio: 1 };
  const TILE_BUDGET_MS = 30000;
  const LEDGER = bundle.gpuResourceRegistry?.gpuResourceRegistry;
  if (LEDGER === undefined) throw new Error("gpuResourceRegistry is not exported by the contract bundle");
  const container = canvas.parentElement;
  if (container === null) throw new Error("the contract canvas MUST live in a container element");

  // ---- helpers (no imports allowed, so they live here) --------------------------------------------
  const raf = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  /** Let the backend's own rAF loop run `frames` frames. */
  const settle = async (frames = 4) => {
    for (let index = 0; index < frames; index += 1) await raf();
  };
  const safe = async (fn) => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return {
        ok: false,
        name: error?.name ?? "Error",
        category: error?.category ?? null,
        message: String(error?.message ?? error).slice(0, 300),
      };
    }
  };
  const summarise = (image) => ({
    width: image.width,
    height: image.height,
    nonBlackPixels: image.nonBlackPixels,
    uniqueColours: image.uniqueColours,
    centre: image.centre,
  });
  /** The same pixel summary for a `FrameCapture` (`captureFrame()` — RGBA8, top-left origin). */
  const summariseCapture = (capture) => {
    const data = capture.pixels;
    let nonBlackPixels = 0;
    const colours = new Set();
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] + data[index + 1] + data[index + 2] > 12) nonBlackPixels += 1;
      if (colours.size < 512) colours.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
    }
    const x = Math.floor(capture.width / 2);
    const y = Math.floor(capture.height / 2);
    const offset = (y * capture.width + x) * 4;
    return {
      width: capture.width,
      height: capture.height,
      pixelFormat: capture.pixelFormat,
      origin: capture.origin,
      nonBlackPixels,
      uniqueColours: colours.size,
      centre: [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]],
    };
  };
  const ledgerStats = () => {
    const stats = LEDGER.stats();
    return {
      live: stats.live,
      totalBytes: stats.totalBytes,
      created: stats.created,
      released: stats.released,
      frame: stats.frame,
      byKind: stats.byKind,
      byUpstreamClass: stats.byUpstreamClass,
      liveIds: LEDGER.activeIds().slice(0, 24),
    };
  };
  const describeDiagnostic = (error) => ({
    category: error?.category ?? null,
    message: String(error?.message ?? error).slice(0, 240),
    backend: error?.backend ?? null,
    // `cause` is where a wrapped identity travels: `scene-runtime` reports a failed frame as
    // `render-failed` and keeps the original error as the cause. Recorded verbatim so the suite can say
    // which channel carried the `device-lost` category.
    causeCategory: error?.cause?.category ?? null,
    causeName: error?.cause?.name ?? null,
    causeMessage: error?.cause === undefined ? null : String(error.cause?.message ?? error.cause).slice(0, 200),
  });
  /** Fixture tile requests so far — the rebuild MUST fetch the dataset again, not reuse a device cache. */
  const fixtureRequestCount = () =>
    performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/fixtures/")).length;

  /**
   * Count the page's console errors verbatim, forwarding every call to the real `console.error`.
   *
   * The entry's diagnostic sink writes there when nobody is subscribed (`src/api/diagnostics.ts`), so this
   * tally is the page's own record of "what did the console receive, word for word". Nothing is hidden:
   * the harness still receives every message.
   */
  const consoleErrors = [];
  const originalConsoleError = console.error.bind(console);
  const consoleErrorTotal = () => consoleErrors.reduce((sum, entry) => sum + entry.count, 0);
  console.error = (...args) => {
    const text = args.map((value) => (typeof value === "string" ? value : String(value))).join(" ");
    const existing = consoleErrors.find((entry) => entry.text === text);
    if (existing === undefined) consoleErrors.push({ text, count: 1, firstAtMs: Math.round(performance.now()) });
    else existing.count += 1;
    return originalConsoleError(...args);
  };

  // ---- live-context capture ----------------------------------------------------------------------
  const contexts = [];
  const prototype = bundle.contextModule?.default?.prototype;
  if (prototype === undefined || typeof prototype.beginFrame !== "function") {
    throw new Error("the replacement Context#beginFrame is not reachable, so the live contexts cannot be observed");
  }
  const originalBeginFrame = prototype.beginFrame;
  prototype.beginFrame = function captureLiveContext(...args) {
    if (!contexts.includes(this)) contexts.push(this);
    return originalBeginFrame.apply(this, args);
  };
  /**
   * The refusal evidence: `Context#draw` throws `category: "device-lost"` once the loss has been noticed
   * (`Context.ts` L578-588). The wrapper records the category, the frame and the command it was asked to
   * draw, then rethrows the error untouched.
   */
  const drawFailures = [];
  const describeCommand = (command, passState) => ({
    commandName: command?.constructor?.name ?? null,
    count: command?.count ?? null,
    indexCount: command?.indexCount ?? null,
    vertexArrayVertices: command?.vertexArray?.numberOfVertices ?? null,
    primitiveType: command?.primitiveType ?? null,
    framebuffer:
      passState?.framebuffer === undefined || passState?.framebuffer === null
        ? null
        : String(passState.framebuffer?.id ?? typeof passState.framebuffer),
  });
  const originalDraw = prototype.draw;
  prototype.draw = function instrumentedDraw(command, passState, program, uniformMap) {
    try {
      return originalDraw.call(this, command, passState, program, uniformMap);
    } catch (error) {
      if (drawFailures.length < 32) {
        drawFailures.push({
          contextIndex: contexts.indexOf(this),
          frame: this.frameNumber ?? null,
          category: error?.category ?? null,
          name: error?.name ?? null,
          message: String(error?.message ?? error).slice(0, 200),
          command: describeCommand(command, passState),
        });
      }
      throw error;
    }
  };
  /**
   * Refused **clears**: `Context#clear` counts a submission-stopped clear in the same `residualDraws`
   * counter but does not throw (it returns the `loadOp` mechanism instead, `Context.ts` L670-676).
   * Detected by watching that counter across the call, so `refused draws + refused clears` MUST equal the
   * context's own `residualDraws` — the identity is what makes "nothing reached the device" countable.
   */
  const clearRefusals = [];
  const originalClear = prototype.clear;
  if (typeof originalClear === "function") {
    prototype.clear = function instrumentedClear(command, passState) {
      const before = this.residualDraws ?? 0;
      const mechanism = originalClear.call(this, command, passState);
      if ((this.residualDraws ?? 0) > before && clearRefusals.length < 32) {
        clearRefusals.push({ contextIndex: contexts.indexOf(this), frame: this.frameNumber ?? null, mechanism: mechanism ?? null });
      }
      return mechanism;
    };
  }
  /**
   * Capture each scene's globe **and its quadtree surface** *before* `scene.destroy()` runs.
   *
   * Upstream nulls `scene.globe` and then `globe._surface` while destroying, so the tile replacement queue
   * (the only handle on the lazily freed terrain tiles) has to be taken here, not afterwards.
   */
  const globes = [];
  const surfaces = [];
  const scenePrototype = bundle.Scene?.prototype;
  if (scenePrototype !== undefined && typeof scenePrototype.destroy === "function") {
    const originalSceneDestroy = scenePrototype.destroy;
    scenePrototype.destroy = function captureGlobe(...args) {
      if (this.globe !== undefined && this.globe !== null) {
        globes.push(this.globe);
        if (this.globe._surface !== undefined && this.globe._surface !== null) surfaces.push(this.globe._surface);
      }
      return originalSceneDestroy.apply(this, args);
    };
  }
  /** The product's own per-context observations (`Context#counters`, `#liveResourceCount`, …). */
  const snapshotContext = (context) => {
    if (context === undefined || context === null) return null;
    return {
      index: contexts.indexOf(context),
      destroyed: context.isDestroyed?.() ?? null,
      liveResourceCount: context.liveResourceCount ?? null,
      deviceLostReason: context.deviceLostReason ?? null,
      residualDraws: context.residualDraws ?? null,
      sampleCount: context.sampleCount ?? null,
      swapchainFormat: context.swapchainFormat ?? null,
      counters: { ...(context.counters ?? {}) },
    };
  };

  // ---- scene factory + measurements ----------------------------------------------------------------
  step("scenario-start", { mode, container: container.id ?? null, canvas: canvas.id ?? null, fixtureRequests: fixtureRequestCount() });
  const ledgerBeforeScene = ledgerStats();

  /** Install a device into the hand-off slot the replacement `Context` reads at construction. */
  const installProbe = async (label, source) => {
    const probe = await prefetchDevice();
    // Slot state asserted **before** the install: an already-pending payload would make `install()` throw,
    // and an empty slot at construction time silently delegates the whole session to upstream WebGL2
    // (plan D2-a), which would turn this WebGPU arm into a WebGL2 run behind the suite's back.
    const before = bundle.deviceHandoff.audit();
    if (before.pending === true) throw new Error(`the hand-off slot MUST be empty before the probe installs a device (pending at ${label})`);
    bundle.deviceHandoff.resetSlot();
    bundle.deviceHandoff.install({
      adapter: probe.adapter,
      device: probe.device,
      limits: probe.adapter.limits,
      features: probe.adapter.features,
      source,
    });
    const after = bundle.deviceHandoff.audit();
    if (after.pending !== true) throw new Error(`the probe MUST have parked its device in the hand-off slot (not pending at ${label})`);
    step(label, { cycle: after.cycle, pendingBefore: before.pending, pendingAfter: after.pending });
    return probe;
  };

  /** Create a scene through the **shipped entry** and wait until its tiles are loaded. */
  const createHandle = async (label) => {
    const statuses = [];
    const diagnostics = [];
    const handle = bundle.terrainScene.createTerrainScene({
      container,
      datasetId: DATASET_ID,
      camera: CAMERA,
      viewport: VIEWPORT,
      onStatus: (status) =>
        statuses.push({ label, active: status.active, reason: status.reason, degraded: status.degraded, notes: [...(status.notes ?? [])] }),
    });
    const unsubscribe = handle.diagnostics.onError((error) => diagnostics.push({ label, ...describeDiagnostic(error) }));
    await handle.ready;
    step(`${label}-ready`, { contexts: contexts.length });
    const tiles = await handle.whenTilesLoaded({ timeoutMs: TILE_BUDGET_MS });
    step(`${label}-tiles`, tiles);
    return { handle, unsubscribe, statuses, diagnostics, tiles };
  };

  /** Everything one settled scene is measured with (the same readings for every arm). */
  const measureScene = async (scene) => {
    await settle(4);
    const captured = await safe(() => scene.handle.captureFrame());
    const presented = await safe(() => readPresentedCanvas(canvas));
    return {
      stats: scene.handle.stats(),
      capture: captured.ok ? summariseCapture(captured.value) : captured,
      presented: presented.ok ? summarise(presented.value) : presented,
      ledger: ledgerStats(),
      fixtureRequests: fixtureRequestCount(),
      consoleErrors: consoleErrorTotal(),
      context: snapshotContext(contexts[contexts.length - 1]),
    };
  };

  /**
   * Apply a camera and wait until the new view's tiles are loaded and a non-empty frame is captured.
   *
   * `setView` has to load the tiles of the new view before it can draw them, so the capture is retried
   * (bounded, every attempt recorded) — "the handle came back" is not the claim under test, "the scene
   * renders again" is.
   */
  const applyViewAndRender = async (scene, camera, { tileBudgetMs = TILE_BUDGET_MS, attempts = 6 } = {}) => {
    scene.handle.setView(camera);
    scene.handle.requestRender();
    await settle(3);
    const tiles = await scene.handle.whenTilesLoaded({ timeoutMs: tileBudgetMs });
    const recorded = [];
    let frame = null;
    for (let attempt = 0; attempt < attempts && frame === null; attempt += 1) {
      await settle(3);
      const captured = await safe(() => scene.handle.captureFrame());
      const summary = captured.ok ? summariseCapture(captured.value) : captured;
      recorded.push({
        attempt,
        ok: captured.ok,
        nonBlackPixels: captured.ok ? summary.nonBlackPixels : null,
        category: captured.ok ? null : captured.category,
      });
      if (captured.ok && summary.nonBlackPixels > 0) frame = summary;
    }
    return { camera, tiles, attempts: recorded, frame };
  };

  // ================================================================================================
  // mode=interaction-only — the control page load: same entry, same camera changes, **no device loss**
  // ================================================================================================
  if (mode === "interaction-only") {
    await installProbe("probe-installed", "device-lost-terrain/control (no loss in this page)");
    const scene = await createHandle("control");
    const baseline = await measureScene(scene);
    // Two camera changes, both recorded and neither asserted to work: the modest one (same distance, a
    // rotation) and one that needs finer-than-dataset tiles. They exist to answer "is this failure a
    // consequence of the device loss?" — a question only a page that never loses a device can answer.
    const modestView = await applyViewAndRender(scene, INTERACTION_CAMERA, { tileBudgetMs: 10000, attempts: 3 });
    const fineView = await applyViewAndRender(scene, FINE_CAMERA, { tileBudgetMs: 10000, attempts: 3 });
    step("control-end", {
      baselineNonBlack: baseline.capture.nonBlackPixels,
      modestTiles: modestView.tiles,
      modestNonBlack: modestView.frame?.nonBlackPixels ?? null,
      fineTiles: fineView.tiles,
      fineNonBlack: fineView.frame?.nonBlackPixels ?? null,
      drawFailures: drawFailures.length,
    });
    return {
      scenario: "device-lost-terrain",
      mode,
      backend,
      datasetId: DATASET_ID,
      lossOccurred: false,
      camera: CAMERA,
      interactionCamera: INTERACTION_CAMERA,
      fineCamera: FINE_CAMERA,
      contextCount: contexts.length,
      statuses: scene.statuses,
      diagnostics: scene.diagnostics,
      drawFailures,
      consoleErrors: { entries: consoleErrors.map((entry) => ({ ...entry })), total: consoleErrorTotal() },
      resources: { ledgerBeforeScene, ledgerBaseline: baseline.ledger, contextBaseline: baseline.context },
      baseline,
      interaction: modestView,
      fineView,
      setViewDiagnosis: { modest: modestView, fine: fineView },
      deviceRequests: ctx.report?.webgpu ?? null,
    };
  }

  // ================================================================================================
  // mode=device-loss — the task's sequence
  // ================================================================================================
  const ledgerBeforeProbe = ledgerStats();
  const consoleErrorsBeforeProbe = consoleErrorTotal();
  const first = await installProbe("probe-installed", "device-lost-terrain/initial-probe");
  const firstScene = await createHandle("first");
  const firstBaseline = await measureScene(firstScene);
  step("first-baseline", {
    ledgerLive: firstBaseline.ledger.live,
    draws: firstBaseline.context?.counters?.draws ?? null,
    frames: firstBaseline.context?.counters?.frames ?? null,
    nonBlack: firstBaseline.capture.nonBlackPixels ?? null,
    nonBackgroundRatio: firstBaseline.stats?.nonBackgroundRatio ?? null,
    consoleErrors: firstBaseline.consoleErrors,
  });

  // ---- step 1: `device.destroy()` -----------------------------------------------------------------
  const deviceLost = first.device.lost.then((info) => ({ reason: info?.reason ?? null, message: String(info?.message ?? "").slice(0, 200) }));
  first.device.destroy();
  const lostInfo = await Promise.race([deviceLost, new Promise((resolve) => setTimeout(() => resolve({ reason: "timeout" }), 3000))]);
  step("device-destroyed", lostInfo);
  const consoleErrorsAfterDestroy = consoleErrorTotal();

  const oldContext = contexts[contexts.length - 1];
  // ---- step 2: stop submitting --------------------------------------------------------------------
  oldContext.stopSubmitting();
  const stopped = snapshotContext(oldContext);
  step("stop-submitting", { residualDraws: oldContext.residualDraws, counters: stopped?.counters ?? null });

  // ---- control arm: the loss window, with NO rebuild ----------------------------------------------
  // While the old device is gone and no new backend exists, the canvas MUST NOT go on showing what the
  // destroyed device drew. `requestRender()` deliberately asks for one more frame: every draw it issues
  // MUST be refused instead of submitted (that is what `Context#residualDraws` counts), so the arm also
  // proves the guard is live rather than merely unexercised.
  firstScene.handle.requestRender();
  await settle(2);
  const canvasInLossWindow = await safe(() => readPresentedCanvas(canvas));
  const captureInLossWindow = await safe(() => firstScene.handle.captureFrame());
  const lossWindow = {
    presented: canvasInLossWindow.ok ? summarise(canvasInLossWindow.value) : canvasInLossWindow,
    capture: captureInLossWindow.ok ? summariseCapture(captureInLossWindow.value) : captureInLossWindow,
    context: snapshotContext(oldContext),
    diagnostics: firstScene.diagnostics.map((entry) => ({ ...entry })),
    statuses: firstScene.statuses.map((entry) => ({ ...entry })),
    consoleErrors: consoleErrorTotal(),
  };
  step("loss-window", {
    presentedNonBlack: lossWindow.presented?.nonBlackPixels ?? null,
    captureOk: captureInLossWindow.ok,
    captureError: captureInLossWindow.ok ? null : captureInLossWindow.category,
    draws: lossWindow.context?.counters?.draws ?? null,
    residualDraws: lossWindow.context?.residualDraws ?? null,
    consoleErrors: lossWindow.consoleErrors,
  });

  // ---- step 3: destroy the backend and the scene ---------------------------------------------------
  // The observer stays subscribed **through** `dispose()` on purpose: a diagnostic raised while the
  // backend is torn down must be delivered (and measured) instead of falling through to the entry's
  // default console sink.
  firstScene.handle.dispose();
  firstScene.unsubscribe();
  const afterDispose = {
    ledger: ledgerStats(),
    context: snapshotContext(oldContext),
    fixtureRequests: fixtureRequestCount(),
    consoleErrors: consoleErrorTotal(),
  };
  step("disposed", {
    ledgerLive: afterDispose.ledger.live,
    ledgerReleased: afterDispose.ledger.released,
    contextLiveResources: afterDispose.context?.liveResourceCount ?? null,
    destroyed: afterDispose.context?.destroyed ?? null,
  });

  // ---- step 4: re-probe ----------------------------------------------------------------------------
  const second = await prefetchDevice();
  bundle.deviceHandoff.resetCycle("device-lost-terrain/rebuild-after-device-loss");
  bundle.deviceHandoff.install({
    adapter: second.adapter,
    device: second.device,
    limits: second.adapter.limits,
    features: second.adapter.features,
    source: "device-lost-terrain/re-probe",
  });
  const handoffAudit = bundle.deviceHandoff.audit();
  const probes = {
    newDeviceIsDistinct: first.device !== second.device,
    handoffCycle: handoffAudit.cycle,
    handoffPending: handoffAudit.pending,
    handoffOps: handoffAudit.entries.map((entry) => `${entry.op}@${entry.cycle}:${entry.source ?? "-"}`),
  };
  step("re-probed", probes);

  // ---- step 5: rebuild the whole backend -----------------------------------------------------------
  const fixtureRequestsBeforeRebuild = fixtureRequestCount();
  const secondScene = await createHandle("second");
  const afterRebuild = await measureScene(secondScene);
  afterRebuild.fixtureRequestsBeforeRebuild = fixtureRequestsBeforeRebuild;
  afterRebuild.diagnostics = secondScene.diagnostics.map((entry) => ({ ...entry }));
  afterRebuild.statuses = secondScene.statuses.map((entry) => ({ ...entry }));
  step("rebuilt", {
    ledgerLive: afterRebuild.ledger.live,
    draws: afterRebuild.context?.counters?.draws ?? null,
    frames: afterRebuild.context?.counters?.frames ?? null,
    nonBlack: afterRebuild.capture.ok === false ? null : afterRebuild.capture.nonBlackPixels,
    tilesLoaded: secondScene.tiles.loaded,
  });

  // ---- step 6: the rebuilt scene is alive ----------------------------------------------------------
  // `requestRender()` is the interaction call the rebuilt backend can be asked for without changing the
  // view: the frame counter MUST keep advancing and the presented frame MUST keep the pre-loss coverage.
  // (A `setView` arm cannot be asserted here: the control page load shows that a camera change kills
  // rendering **with no device loss at all** — see `unmetContractArms` in the suite's observation file.)
  const statsBeforeLifecycle = secondScene.handle.stats();
  const framesBeforeLifecycle = snapshotContext(contexts[contexts.length - 1])?.counters?.frames ?? null;
  secondScene.handle.requestRender();
  await settle(6);
  const aliveCapture = await safe(() => secondScene.handle.captureFrame());
  const lifecycle = {
    statsBefore: statsBeforeLifecycle,
    stats: secondScene.handle.stats(),
    framesBefore: framesBeforeLifecycle,
    frame: aliveCapture.ok ? summariseCapture(aliveCapture.value) : aliveCapture,
    context: snapshotContext(contexts[contexts.length - 1]),
  };
  step("lifecycle", {
    framesBefore: framesBeforeLifecycle,
    framesAfter: lifecycle.context?.counters?.frames ?? null,
    nonBlackPixels: aliveCapture.ok ? lifecycle.frame.nonBlackPixels : null,
    drawCalls: lifecycle.stats?.drawCallCount ?? null,
  });

  // Leave the recovered frame presented for the harness screenshot (the compositor evidence that no
  // refresh was needed), then publish. The rebuilt handle is deliberately NOT disposed.
  await settle(4);

  // ---- post-hoc attribution experiment (runs last; cannot affect any measurement above) -----------
  // The FR-017 ledger still lists the destroyed device's tile buffers after `dispose()`. This experiment
  // attributes them to upstream's **lazy** tile free: resources are released during
  // `QuadtreePrimitive#update` → `_tileReplacementQueue.trimTiles()` → `GlobeSurfaceTile#freeResources`,
  // while `QuadtreePrimitive#destroy` only destroys the tile provider. Forcing one trim on the (already
  // destroyed) surface is therefore a *measurement of the mechanism*, not a fix: it is taken after every
  // assertion input above.
  const ledgerBeforeForcedTrim = ledgerStats();
  const queueCounts = { before: null, after: null };
  const forcedTrim = await safe(async () => {
    const surface = surfaces[0];
    const queue = surface?._tileReplacementQueue;
    if (queue === undefined || typeof queue.trimTiles !== "function") {
      throw new Error(`no tile replacement queue is reachable (surfaces captured: ${surfaces.length}, queue: ${queue === undefined ? "none" : typeof queue})`);
    }
    queueCounts.before = queue.count ?? null;
    queue.trimTiles(0);
    queueCounts.after = queue.count ?? null;
    return { surface: true };
  });
  const attribution = {
    mechanism:
      "hypothesis under test: the ledger's residue is upstream's lazily freed terrain tiles (`QuadtreePrimitive#update` → `TileReplacementQueue#trimTiles` → `GlobeSurfaceTile#freeResources`), which a destroyed scene never reaches because `QuadtreePrimitive#destroy` destroys only the tile provider",
    globesCaptured: globes.length,
    surfacesCaptured: surfaces.length,
    ledgerBeforeForcedTrim,
    forcedTrim: forcedTrim.ok ? { ok: true } : forcedTrim,
    queueCounts,
    ledgerAfterForcedTrim: ledgerStats(),
  };
  step("attribution", { before: ledgerBeforeForcedTrim.live, after: attribution.ledgerAfterForcedTrim.live, trimOk: forcedTrim.ok });

  const result = {
    scenario: "device-lost-terrain",
    mode,
    backend,
    lossOccurred: true,
    datasetId: DATASET_ID,
    camera: CAMERA,
    interactionCamera: INTERACTION_CAMERA,
    fineCamera: FINE_CAMERA,
    viewport: VIEWPORT,
    canvas: { id: canvas.id ?? null, width: canvas.width, height: canvas.height, connected: canvas.isConnected === true },
    /** (a) no-refresh evidence: one page load, one navigation entry, the same canvas element throughout. */
    noRefresh: {
      navigationEntries: performance.getEntriesByType("navigation").length,
      navigationStartMs: Math.round(performance.timeOrigin),
      elapsedMs: Math.round(performance.now()),
      canvasIsSameElement: canvas === document.getElementById("contract-canvas"),
      canvasConnectedAtEnd: canvas.isConnected === true,
      canvasesInDocument: document.querySelectorAll("canvas").length,
    },
    /** (d) the status/diagnostic channels, exactly as they were received. */
    statuses: [...firstScene.statuses, ...secondScene.statuses],
    diagnostics: {
      first: firstScene.diagnostics.map((entry) => ({ ...entry })),
      second: secondScene.diagnostics.map((entry) => ({ ...entry })),
      lossWindow: lossWindow.diagnostics,
    },
    /** The `device-lost` category as the backend itself produced it, captured at `Context#draw`. */
    drawFailures: drawFailures.slice(0, 32),
    /** Every console error the page produced, verbatim, with its count and when the first one appeared. */
    consoleErrors: { entries: consoleErrors.map((entry) => ({ ...entry })), total: consoleErrorTotal(), beforeProbe: consoleErrorsBeforeProbe, afterDestroy: consoleErrorsAfterDestroy },
    deviceLoss: {
      reported: lostInfo,
      deviceLostReason: afterDispose.context?.deviceLostReason ?? null,
      residualDrawsAfterStop: lossWindow.context?.residualDraws ?? null,
      countersAtStop: stopped?.counters ?? null,
    },
    /** (c) resource accounting: the FR-017 ledger (upstream Buffer/Texture/Renderbuffer records) + the context's own attachments. */
    resources: {
      ledgerBeforeScene,
      ledgerBeforeProbe,
      ledgerBefore: firstBaseline.ledger,
      ledgerAfterDispose: afterDispose.ledger,
      ledgerAfterRebuild: afterRebuild.ledger,
      contextBefore: firstBaseline.context,
      contextAfterDispose: afterDispose.context,
      contextAfterRebuild: afterRebuild.context,
    },
    /** (a) the five steps, each with its own measurement. */
    steps: {
      first: { tiles: firstScene.tiles, context: firstBaseline.context },
      lossWindow,
      afterDispose: { context: afterDispose.context },
      probes,
      rebuild: { tiles: secondScene.tiles },
    },
    contextCount: contexts.length,
    firstBaseline,
    lossWindow: { presented: lossWindow.presented, capture: lossWindow.capture, context: lossWindow.context },
    afterRebuild,
    lifecycle,
    attribution,
    /** "MUST NOT keep the old device's drawing": the old context's counters at each stage, plus the new one's. */
    deviceIdentity: {
      firstDeviceDistinctFromSecond: probes.newDeviceIsDistinct,
      oldContextCountersAtBaseline: firstBaseline.context?.counters ?? null,
      oldContextCountersAtStop: stopped?.counters ?? null,
      oldContextCountersAfterDispose: afterDispose.context?.counters ?? null,
      oldContextCountersAtEnd: snapshotContext(oldContext)?.counters ?? null,
      newContextCountersAfterRebuild: afterRebuild.context?.counters ?? null,
      newContextCountersAfterLifecycle: lifecycle.context?.counters ?? null,
    },
    pageErrors: [],
  };
  step("scenario-end", {
    statuses: result.statuses.length,
    diagnostics: result.diagnostics.first.length + result.diagnostics.second.length,
    contextCount: result.contextCount,
    consoleErrors: result.consoleErrors.total,
    drawFailures: result.drawFailures.length,
  });
  return result;
}
