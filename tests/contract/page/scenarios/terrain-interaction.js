/**
 * `terrain-interaction` — T095 (`层=契约`, SC-004 / FR-002): three seconds of **fixed-step** camera
 * interaction (rotate → zoom → pan) after the terrain is ready, measured frame by frame *inside the
 * page*, plus the settled frame's statistics before/after.
 *
 * ## Why this scenario drives the **public entry** and not `ctx.buildTerrainScene`
 *
 * `ctx.buildTerrainScene` (probe.js) assembles a scene by hand and exposes `renderFrames(count, settle)`
 * / `frameTimesMs`. That surface has no `stats()` and no `captureFrame()`, so it cannot express
 * SC-004's "(c) the settled frame's statistics are in the same interval as before the interaction",
 * which is a statement about `TerrainSceneHandle.stats()` / `FrameStatistics` (T089). The interaction
 * contract is therefore measured on the **shipped entry point**
 * (`bundle.terrainScene.createTerrainScene`) — the same object `apps/demo` consumes.
 *
 * Consequences that are deliberate:
 *   - the scenario does **not** call `ctx.createCanvas`: `createTerrainScene` reuses the container's
 *     existing `<canvas>` (`src/compose/scene-runtime.ts` `resolveSceneCanvas`), i.e. exactly the
 *     `#contract-canvas` element the harness screenshots. The identity is recorded below;
 *   - `preference` is deliberaded **not** passed — W6's probe cannot honour it yet, so passing one would
 *     emit a `not-implemented` diagnostic by design;
 *   - the scenario **does** install the device hand-off first, on the WebGPU arm only, exactly like
 *     `probe.js`'s `buildTerrainScene` and `scenarios/terrain-ready.js`: the replacement `Context` takes
 *     its device from that slot and, with an empty slot, whole-delegates to upstream WebGL2
 *     (`Context.ts:30-35`, plan D2-a). The shipped entry cannot install it (`src/**` MUST NOT import the
 *     patch layer, rules A1/A2), so parking the probed device is the integrator's step. Measured: without
 *     it a WebGPU run silently becomes a WebGL2 run, whose vendored upstream `Context` calls
 *     `RenderState.apply(gl, rs, ps)` against the patched class and dies with
 *     `TypeError: renderState.toPipelineState is not a function` — which is why `onStatus` below is
 *     recorded and asserted rather than assumed.
 *
 * ## Input timeline vs. frame timeline (two independent clocks)
 *
 * The interaction **input** is a fixed rule: step `k` of phase `p` is the camera `poseAt(p, k)`, applied
 * at wall-clock `p * 1000 ms + (k - 1) * 50 ms` by a pre-scheduled timer — fixed step size, fixed total
 * duration, independent of how fast the page renders (a real input device does not wait for the frame
 * loop either). The **frames** are what a `requestAnimationFrame` sampler measures. Keeping the two
 * apart is what makes "the input was fixed" and "the render kept up" separately checkable: a slow frame
 * cannot silently change the trajectory, and a delayed step cannot silently shrink the measured window.
 *
 * ## How the four SC-004 claims are measured
 *
 *   (a) "no continuous stall > 1000 ms" — a page-side `requestAnimationFrame` sampler records one raw
 *       sample per animation frame for the *whole* scenario (construction, tile loading, the 3 s
 *       interaction, the settle). A stall is a maximal run of **consecutive inter-frame gaps** each
 *       > 1000 ms; the raw samples and their distribution (`min/p50/p95/p99/max` + the >1000 ms
 *       segmentation) are published, so the assertion is never a black box.
 *   (b) "no uncaught error" — three channels: `report.errors` (probe), the harness's
 *       `pageerror`/console collectors, and this scenario's own `error` + `unhandledrejection`
 *       listeners plus `handle.diagnostics.onError` (the product's own error surface).
 *   (c) "settled frame in the same interval" — `captureFrame()` + `stats()` before the interaction and
 *       after it. Fields that are **not** measured (`depthDiscontinuityRatio`, always `NaN`:
 *       `assembleFrameStatistics` is called without depth samples) are excluded explicitly instead of
 *       being silently compared.
 *   (d) "the frame counter keeps growing" — per-phase animation-frame counts from the raw samples, the
 *       per-phase growth of the `requestAnimationFrame` callbacks that are *not* this scenario's (the
 *       product loop's frame count), and one `captureFrame()` per phase: a capture resolves **inside**
 *       `renderOnce()`, so a resolved capture *is* a freshly rendered product frame.
 *
 * ## Fixed conditions (all published in the artifact)
 *
 * dataset `matterhorn-z0-12`, viewport 384x288 @ dpr 1, camera base = the entry's `DEFAULT_CAMERA`
 * (Mont Blanc 6.8652 E / 45.8326 N, 24 km, pitch -50 — inside the committed dataset's coverage),
 * scene time pinned by the entry (`2026-03-20T12:00:00Z`), 20 steps x 50 ms per phase x 3 phases
 * = 3.000 s, then a 750 ms settle. The trajectory is a pure function of `(phaseIndex, stepIndex)`.
 *
 * ## Counter-example arm (`?stall_ms=`)
 *
 * With `?stall_ms=N` (N > 0) the scenario injects **one** deliberate main-thread busy wait of N ms in
 * the middle of a named phase (`?stall_phase=`, default `pan`). That is the arm
 * `tests/contract/interaction.spec.mjs` uses to prove the "no stall > 1000 ms" assertion is able to
 * fail; the measured arm runs with `stall_ms=0` and is unaffected.
 *
 * Module rules: scenario modules import **nothing** (`probe.js` runs `main()` on import), so every
 * helper arrives through `ctx`. Default export is `(bundle, canvas, ctx) => result`.
 */

/** Milliseconds since the scenario started — readable, comparable timestamps in the artifact. */
const round = (value, digits = 3) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export default async function terrainInteractionScenario(bundle, canvas, ctx) {
  const { backend, params, step, readPresentedCanvas } = ctx;
  const startedAt = performance.now();
  const rel = (value) => round(value - startedAt);

  // ---------------------------------------------------------------------------------------------
  // Fixed conditions
  // ---------------------------------------------------------------------------------------------

  const DATASET_ID = "matterhorn-z0-12";
  /** The entry's own `DEFAULT_CAMERA` (`src/compose/scene-config.ts`) — pinned, not invented here. */
  const BASE_CAMERA = { longitude: 6.8652, latitude: 45.8326, height: 24000, heading: 0, pitch: -50, roll: 0 };
  const VIEWPORT = {
    width: Number(params.get("width") ?? 384),
    height: Number(params.get("height") ?? 288),
    devicePixelRatio: 1,
  };

  /** Mirrors `frame-statistics.ts`: the scene's default background is `Color.BLACK`, tolerance 8. */
  const BACKGROUND = { r: 0, g: 0, b: 0, a: 255 };
  const BACKGROUND_TOLERANCE = 8;
  const DIFFERENCE_TOLERANCE = 8;

  const STEP_MS = 50;
  const STEPS_PER_PHASE = 20;
  const PHASE_MS = STEP_MS * STEPS_PER_PHASE; // 1000
  const TOTAL_MS = PHASE_MS * 3; // 3000 — SC-004's "continuous 3 seconds"
  const PRE_SETTLE_MS = 600;
  const SETTLE_MS = 750;
  const MIN_SETTLE_FRAMES = 10;
  const TILES_TIMEOUT_MS = 30000;
  const FRAME_TIMEOUT_MS = 20000;

  const STALL_MS = Math.max(0, Number(params.get("stall_ms") ?? 0) || 0);
  const STALL_PHASE = params.get("stall_phase") ?? "pan";
  const STALL_AT_STEP = Number(params.get("stall_at_step") ?? 10);

  /**
   * The three interaction segments. Each sweeps **one** control from the pose the previous segment
   * ended at, in 20 equal steps of 50 ms — the whole trajectory is a fixed function of
   * `(phaseIndex, stepIndex)` with no jump at the boundaries.
   */
  const PHASES = [
    { name: "rotate", axis: "heading", from: BASE_CAMERA.heading, to: 45, unit: "deg", perStep: (45 - BASE_CAMERA.heading) / STEPS_PER_PHASE },
    { name: "zoom", axis: "height", from: BASE_CAMERA.height, to: 12000, unit: "m", perStep: (12000 - BASE_CAMERA.height) / STEPS_PER_PHASE },
    {
      name: "pan",
      axis: "longitude+latitude",
      from: { longitude: BASE_CAMERA.longitude, latitude: BASE_CAMERA.latitude },
      to: { longitude: 6.8952, latitude: 45.8126 },
      unit: "deg",
      perStep: {
        longitude: (6.8952 - BASE_CAMERA.longitude) / STEPS_PER_PHASE,
        latitude: (45.8126 - BASE_CAMERA.latitude) / STEPS_PER_PHASE,
      },
    },
  ];

  const lerp = (from, to, fraction) => from + (to - from) * fraction;

  /** The camera of step `k` (1..20) of phase `phaseIndex`, with every earlier phase at its last step. */
  function poseAt(phaseIndex, k) {
    const camera = { ...BASE_CAMERA };
    for (let index = 0; index <= phaseIndex; index += 1) {
      const phase = PHASES[index];
      const steps = index === phaseIndex ? k : STEPS_PER_PHASE;
      const fraction = steps / STEPS_PER_PHASE;
      if (phase.axis === "heading") camera.heading = lerp(phase.from, phase.to, fraction);
      else if (phase.axis === "height") camera.height = lerp(phase.from, phase.to, fraction);
      else {
        camera.longitude = lerp(phase.from.longitude, phase.to.longitude, fraction);
        camera.latitude = lerp(phase.from.latitude, phase.to.latitude, fraction);
      }
    }
    return camera;
  }

  // ---------------------------------------------------------------------------------------------
  // Page-side instrumentation
  // ---------------------------------------------------------------------------------------------

  /**
   * Wrap `requestAnimationFrame` so the product's own frame loop is countable: the runtime schedules
   * exactly one callback per rendered frame (`ensureLoop()` after `renderOnce()`), so "callbacks that
   * are not this scenario's" is the product loop's frame count. Every callback this scenario registers
   * goes through `ownRaf`, so the subtraction is exact on this side.
   */
  const raf = { scheduledTotal: 0, invokedTotal: 0, ownScheduled: 0, ownInvoked: 0 };
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = function instrumentedRequestAnimationFrame(callback, ...rest) {
    raf.scheduledTotal += 1;
    return originalRequestAnimationFrame.call(globalThis, (timestamp) => {
      raf.invokedTotal += 1;
      return callback(timestamp);
    }, ...rest);
  };
  const ownRaf = (callback) => {
    raf.ownScheduled += 1;
    return globalThis.requestAnimationFrame((timestamp) => {
      raf.ownInvoked += 1;
      return callback(timestamp);
    });
  };

  const samples = [];
  const stepLog = [];
  const marks = [];
  const probes = [];
  const pendingProbes = [];
  let samplePhase = "create";
  let running = false;
  let driverDone = false;
  let interactionStart = null;
  let interactionEnd = null;
  let settleEnd = null;
  let resolveInteraction = null;
  let lastPhaseIndex = -1;
  let lastStepIndex = -1;
  let captureInFlight = false;
  let injectedStall = null;
  let tilesLoadedAtMs = null;
  let prePixels = null;
  let lastSampleRawT = null;

  const mark = (name) => marks.push({ name, atMs: rel(performance.now()) });
  const markAt = (name) => marks.find((entry) => entry.name === name)?.atMs ?? null;

  /** A real main-thread freeze: the counter-example arm's only mechanism. */
  function busyWait(milliseconds) {
    const end = performance.now() + milliseconds;
    let sink = 0;
    while (performance.now() < end) sink += Math.sqrt(performance.now() % 1024);
    return sink;
  }

  /**
   * One sample per animation frame. A gap is attributed to the phase it **started** in
   * (`gapStartedInPhase`, the phase of the previous sample) as well as to the phase it ended in: a
   * freeze that begins inside the interaction and ends after it must not be re-labelled as "after the
   * interaction", which would make a stall in the pan phase disappear from the attribution.
   */
  function onAnimationFrame() {
    const now = performance.now();
    let stallTriggeredNow = false;
    if (running) {
      const elapsed = now - interactionStart;
      if (elapsed >= TOTAL_MS) {
        interactionEnd = now;
        running = false;
        samplePhase = "post-settle";
        mark("interaction-end");
        const resolve = resolveInteraction;
        resolveInteraction = null;
        if (resolve !== null) resolve();
      } else if (lastPhaseIndex >= 0) {
        // Attribution only: the label names the interaction segment the *input* was in when this frame
        // rendered (the input's own timestamps are in `stepLog`).
        samplePhase = PHASES[lastPhaseIndex].name;
        // The injected counter-example: one busy wait in the middle of the named phase, after the
        // sample below has been pushed — so it shows up as the *next* sample's gap.
        if (STALL_MS > 0 && injectedStall === null && samplePhase === STALL_PHASE && lastStepIndex >= STALL_AT_STEP) {
          injectedStall = { requestedMs: STALL_MS, phase: samplePhase, stepIndex: lastStepIndex, startedAtMs: rel(now) };
          busyWait(STALL_MS);
          injectedStall.finishedAtMs = rel(performance.now());
          stallTriggeredNow = true;
        }
      }
    }
    const rawT = now - startedAt;
    const previousSample = samples.length === 0 ? null : samples[samples.length - 1];
    samples.push({
      t: round(rawT),
      phase: samplePhase,
      phaseIndex: running ? lastPhaseIndex : null,
      stepIndex: running ? lastStepIndex : null,
      gapMs: lastSampleRawT === null ? null : round(rawT - lastSampleRawT),
      gapStartedInPhase: previousSample === null ? null : previousSample.phase,
      gapStartedAtStepIndex: previousSample === null ? null : previousSample.stepIndex,
      rafInvokedTotal: raf.invokedTotal,
      ownInvokedTotal: raf.ownInvoked,
      injectedStall: stallTriggeredNow,
    });
    lastSampleRawT = rawT;
    if (!driverDone) ownRaf(onAnimationFrame);
  }

  function scheduleProbe(phase, phaseIndex, stepIndex) {
    const requestedAtMs = rel(performance.now());
    if (captureInFlight === true) {
      probes.push({ phase: phase.name, stepIndex, requestedAtMs, skipped: "another captureFrame() was still in flight" });
      return;
    }
    captureInFlight = true;
    const promise = handle
      .captureFrame()
      .then((frame) => {
        const entry = {
          phase: phase.name,
          phaseIndex,
          stepIndex,
          requestedAtMs,
          resolvedAtMs: rel(performance.now()),
          camera: poseAt(phaseIndex, stepIndex),
          frame: { width: frame.width, height: frame.height, pixelFormat: frame.pixelFormat, origin: frame.origin, premultiplied: frame.premultiplied },
          own: pixelStats(frame.pixels, frame.width, frame.height),
          differenceFromPreCapture: prePixels === null ? null : differenceRatio(prePixels, frame.pixels),
          stats: handle.stats(),
          error: null,
        };
        probes.push(entry);
        return entry;
      })
      .catch((error) => {
        const entry = { phase: phase.name, phaseIndex, stepIndex, requestedAtMs, error: String(error?.message ?? error), own: null, stats: null };
        probes.push(entry);
        return entry;
      })
      .finally(() => {
        captureInFlight = false;
      });
    pendingProbes.push(promise);
  }

  /**
   * Apply one fixed input step. Called by a pre-scheduled timer, i.e. on the input's own clock: the
   * trajectory is exactly `poseAt(phaseIndex, stepIndex)` whatever the renderer is doing. If the main
   * thread is frozen for longer than the step interval, the overdue timers fire back to back when it
   * unblocks (the step log records the realised timestamps), so the input timeline stays complete.
   */
  function applyStep(phaseIndex, stepIndex) {
    const phase = PHASES[phaseIndex];
    const camera = poseAt(phaseIndex, stepIndex);
    handle.setView(camera); // setView() also calls requestRender()
    stepLog.push({ index: stepLog.length + 1, phase: phase.name, stepIndex, atMs: rel(performance.now()), camera: { ...camera } });
    lastPhaseIndex = phaseIndex;
    lastStepIndex = stepIndex;
    // One probe capture per phase, fired at that phase's last (extreme) step: a capture resolves inside
    // `renderOnce()`, so a resolved probe is a *fresh product frame* at that pose.
    if (stepIndex === STEPS_PER_PHASE) scheduleProbe(phase, phaseIndex, stepIndex);
  }

  const waitMs = (milliseconds) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
  const waitFrames = (count) =>
    new Promise((resolve) => {
      let remaining = count;
      const tick = () => {
        remaining -= 1;
        if (remaining <= 0) resolve();
        else ownRaf(tick);
      };
      ownRaf(tick);
    });

  /** Wait for at least `minFrames` animation frames **and** at least `milliseconds` of wall clock. */
  async function settle(milliseconds, minFrames) {
    await waitFrames(minFrames);
    const until = performance.now() + milliseconds;
    while (performance.now() < until) await waitMs(Math.min(50, Math.max(1, until - performance.now())));
  }

  function withTimeout(promise, milliseconds, label) {
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(new Error(`${label} did not settle within ${milliseconds} ms`)), milliseconds);
      promise.then(
        (value) => {
          globalThis.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          globalThis.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** Pixel statistics of one capture, computed here (same口径 as `frame-statistics.ts`). */
  function pixelStats(pixels, width, height) {
    let nonBackground = 0;
    const colours = new Set();
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      const a = pixels[index + 3];
      colours.add(((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
      const difference =
        Math.abs(r - BACKGROUND.r) + Math.abs(g - BACKGROUND.g) + Math.abs(b - BACKGROUND.b) + Math.abs(a - BACKGROUND.a);
      if (difference > BACKGROUND_TOLERANCE) nonBackground += 1;
    }
    const total = pixels.length / 4;
    return {
      width,
      height,
      considered: total,
      nonBackground,
      nonBackgroundRatio: total === 0 ? null : round(nonBackground / total, 6),
      uniqueColorCount: colours.size,
    };
  }

  /** Share of pixels differing by more than `DIFFERENCE_TOLERANCE` in any channel — interaction evidence. */
  function differenceRatio(first, second) {
    if (first === null || second === null || first.length !== second.length) return null;
    let different = 0;
    for (let index = 0; index < first.length; index += 4) {
      if (
        Math.abs(first[index] - second[index]) > DIFFERENCE_TOLERANCE ||
        Math.abs(first[index + 1] - second[index + 1]) > DIFFERENCE_TOLERANCE ||
        Math.abs(first[index + 2] - second[index + 2]) > DIFFERENCE_TOLERANCE ||
        Math.abs(first[index + 3] - second[index + 3]) > DIFFERENCE_TOLERANCE
      ) {
        different += 1;
      }
    }
    return round(different / (first.length / 4), 6);
  }

  function summarise(values) {
    const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).slice().sort((left, right) => left - right);
    if (sorted.length === 0) return { count: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
    const at = (fraction) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
    return {
      count: sorted.length,
      min: round(sorted[0]),
      p50: round(at(0.5)),
      p95: round(at(0.95)),
      p99: round(at(0.99)),
      max: round(sorted[sorted.length - 1]),
      mean: round(sorted.reduce((total, value) => total + value, 0) / sorted.length),
    };
  }

  /**
   * Maximal runs of consecutive gaps > `threshold` (a continuous freeze).
   *
   * `phases` names the segment the freeze **began** in (`gapStartedInPhase`), `endedInPhases` the one it
   * ended in; a freeze that straddles the end of the interaction is therefore still attributed to the
   * interaction segment that caused it, and the straddle stays visible in the record.
   */
  function stallRuns(entries, threshold) {
    const runs = [];
    let current = null;
    for (const entry of entries) {
      if (typeof entry.gapMs === "number" && entry.gapMs > threshold) {
        if (current === null) {
          current = {
            firstSampleTMs: round(entry.t - entry.gapMs),
            lastSampleTMs: entry.t,
            gapCount: 0,
            durationMs: 0,
            peakGapMs: 0,
            phases: [],
            endedInPhases: [],
            stepIndexes: [],
          };
          runs.push(current);
        }
        current.gapCount += 1;
        current.durationMs += entry.gapMs;
        current.peakGapMs = Math.max(current.peakGapMs, entry.gapMs);
        const startedIn = entry.gapStartedInPhase ?? entry.phase;
        if (!current.phases.includes(startedIn)) current.phases.push(startedIn);
        if (!current.endedInPhases.includes(entry.phase)) current.endedInPhases.push(entry.phase);
        const step = entry.gapStartedAtStepIndex ?? entry.stepIndex;
        if (step !== null && step !== undefined && !current.stepIndexes.includes(step)) current.stepIndexes.push(step);
      } else {
        current = null;
      }
    }
    return runs.map((run) => ({ ...run, durationMs: round(run.durationMs), peakGapMs: round(run.peakGapMs) }));
  }

  // ---------------------------------------------------------------------------------------------
  // Scene construction through the shipped entry point
  // ---------------------------------------------------------------------------------------------

  const container = document.getElementById("contract-container");
  if (container === null) throw new Error("the contract page MUST provide #contract-container");
  const canvasElement = container.querySelector("canvas");
  if (canvasElement === null) throw new Error("#contract-container MUST hold the canvas the harness screenshots");

  ownRaf(onAnimationFrame); // sampling starts before anything is constructed

  // ---- device hand-off: the integrator's step, BEFORE the scene exists (see the file header) -------
  //
  // The replacement `Context` is constructed synchronously inside `createTerrainScene` and takes its
  // device from the hand-off slot; with an empty slot it whole-delegates to upstream WebGL2, which then
  // crashes on the patched `RenderState.apply` (measured — see the header). A WebGL2 run MUST NOT touch
  // `navigator.gpu` (that is what `assertOtherBackendUntouched` measures), so nothing is parked there.
  const handoff = { backend, installed: false, source: "terrain-interaction", reset: null, adapterInfo: null, reason: null };
  if (backend !== "webgl2") {
    const { adapter, device } = await ctx.prefetchDevice();
    if (typeof bundle.deviceHandoff.resetCycle === "function") {
      bundle.deviceHandoff.resetCycle(handoff.source);
      handoff.reset = "resetCycle";
    } else if (typeof bundle.deviceHandoff.resetSlot === "function") {
      bundle.deviceHandoff.resetSlot();
      handoff.reset = "resetSlot";
    } else {
      handoff.reset = "none";
    }
    bundle.deviceHandoff.install({ adapter, device, limits: adapter.limits, features: adapter.features, source: handoff.source });
    handoff.installed = true;
    handoff.adapterInfo = adapter.info ?? null;
    handoff.audit = typeof bundle.deviceHandoff.audit === "function" ? bundle.deviceHandoff.audit() : null;
  } else {
    handoff.reason = "a WebGL2 run MUST NOT request a WebGPU adapter (FR-006/FR-011)";
  }
  step("handoff", handoff);

  mark("create-start");
  const statuses = [];
  const handle = bundle.terrainScene.createTerrainScene({
    container,
    datasetId: DATASET_ID,
    camera: { ...BASE_CAMERA },
    viewport: { ...VIEWPORT },
    // `preference` is deliberately omitted — see the file header.
    onStatus: (status) => {
      // Observation only (FR-009): the reported active path is what turns "the WebGPU run silently
      // became a WebGL2 run" from an invisible failure into a recorded fact.
      statuses.push({ active: status?.active ?? null, reason: status?.reason ?? null, degraded: status?.degraded ?? null, notes: status?.notes ?? [], atMs: rel(performance.now()) });
    },
  });
  mark("create-returned");
  const activeBackend = statuses.length === 0 ? null : statuses[statuses.length - 1].active;

  const diagnostics = [];
  handle.diagnostics.onError((error) => {
    diagnostics.push({ category: error?.category ?? null, message: String(error?.message ?? error), atMs: rel(performance.now()) });
  });

  const uncaught = [];
  const onWindowError = (event) => uncaught.push({ kind: "error", message: String(event?.message ?? ""), atMs: rel(performance.now()) });
  const onUnhandledRejection = (event) =>
    uncaught.push({ kind: "unhandledrejection", message: String(event?.reason?.message ?? event?.reason ?? ""), atMs: rel(performance.now()) });
  globalThis.addEventListener("error", onWindowError);
  globalThis.addEventListener("unhandledrejection", onUnhandledRejection);

  const setup = {
    datasetId: DATASET_ID,
    baseCamera: { ...BASE_CAMERA },
    viewport: { ...VIEWPORT },
    preferencePassed: false,
    containerId: container.id,
    canvasId: canvasElement.id ?? null,
    canvasIsTheHarnessScreenshotTarget: canvas === canvasElement,
    canvasReusedByEntry: canvasElement.getAttribute("data-cesium-webgpu-scene") === null,
    backendFromPage: backend,
    handoff,
    statuses,
    activeBackend,
    fixedConditions: {
      sceneTimeIso: "2026-03-20T12:00:00Z (pinned inside the entry: src/compose/scene-config.ts)",
      interaction: { stepMs: STEP_MS, stepsPerPhase: STEPS_PER_PHASE, phaseMs: PHASE_MS, phases: PHASES.length, totalMs: TOTAL_MS, preSettleMs: PRE_SETTLE_MS, settleMs: SETTLE_MS },
      trajectory: PHASES.map((phase) => ({ name: phase.name, axis: phase.axis, from: phase.from, to: phase.to, unit: phase.unit, perStep: phase.perStep, steps: STEPS_PER_PHASE })),
      injectedStall: STALL_MS > 0 ? { requestedMs: STALL_MS, phase: STALL_PHASE, atStep: STALL_AT_STEP } : null,
    },
  };
  step("interaction-setup", setup);

  samplePhase = "tiles";
  mark("ready-await-start");
  const readyAtMs = rel(await withTimeout(handle.ready.then(() => performance.now()), FRAME_TIMEOUT_MS, "ready"));
  mark("ready-resolved");
  const tiles = await withTimeout(handle.whenTilesLoaded({ timeoutMs: TILES_TIMEOUT_MS }), TILES_TIMEOUT_MS + FRAME_TIMEOUT_MS, "whenTilesLoaded");
  tilesLoadedAtMs = rel(performance.now());
  step("tiles-loaded", { ...tiles, readyAtMs, tilesLoadedAtMs });

  samplePhase = "pre-settle";
  mark("pre-settle-start");
  await settle(PRE_SETTLE_MS, MIN_SETTLE_FRAMES);

  mark("pre-capture-start");
  const preCapture = await withTimeout(handle.captureFrame(), FRAME_TIMEOUT_MS, "pre-interaction captureFrame");
  const preCaptureAtMs = rel(performance.now());
  const preStats = handle.stats(); // computed from the frame just captured
  prePixels = preCapture.pixels;
  const preOwn = pixelStats(preCapture.pixels, preCapture.width, preCapture.height);
  const presentedPre = await readPresentedCanvas(canvas).catch((error) => ({ error: String(error?.message ?? error) }));
  mark("pre-capture-done");

  // ---- the 3.0 s interaction -----------------------------------------------------------------
  mark("interaction-start");
  const interactionDone = new Promise((resolve) => {
    resolveInteraction = resolve;
  });
  interactionStart = performance.now();
  running = true;
  // All 60 input steps are scheduled up front, on the fixed 50 ms grid: step k of phase p at
  // p * 1000 ms + (k - 1) * 50 ms after the start. Nothing in the sampling path can re-time them.
  const timers = [];
  for (let phaseIndex = 0; phaseIndex < PHASES.length; phaseIndex += 1) {
    for (let stepIndex = 1; stepIndex <= STEPS_PER_PHASE; stepIndex += 1) {
      timers.push(globalThis.setTimeout(() => applyStep(phaseIndex, stepIndex), phaseIndex * PHASE_MS + (stepIndex - 1) * STEP_MS));
    }
  }
  await withTimeout(interactionDone, TOTAL_MS + FRAME_TIMEOUT_MS, "the interaction window");
  const interactionRealizedMs = round(performance.now() - interactionStart);
  for (const timer of timers) globalThis.clearTimeout(timer);

  // ---- settle after the interaction ----------------------------------------------------------
  samplePhase = "post-settle";
  mark("post-settle-start");
  await settle(SETTLE_MS, MIN_SETTLE_FRAMES);
  await Promise.allSettled(pendingProbes);
  const postCapture = await withTimeout(handle.captureFrame(), FRAME_TIMEOUT_MS, "post-interaction captureFrame");
  const postCaptureAtMs = rel(performance.now());
  const postStats = handle.stats();
  const postOwn = pixelStats(postCapture.pixels, postCapture.width, postCapture.height);
  const presentedPost = await readPresentedCanvas(canvas).catch((error) => ({ error: String(error?.message ?? error) }));
  settleEnd = performance.now();
  mark("post-capture-done");

  driverDone = true;
  await waitFrames(2); // the compositor needs more than one frame before the harness screenshots
  const statsAfterReset = (() => {
    // Documents the "unmeasured is NaN, never 0" rule on the live handle. The comparison below uses
    // the values captured before this call, so the reset cannot influence it.
    handle.resetStats();
    return handle.stats();
  })();
  mark("scenario-end");

  globalThis.removeEventListener("error", onWindowError);
  globalThis.removeEventListener("unhandledrejection", onUnhandledRejection);
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;

  // ---------------------------------------------------------------------------------------------
  // Derived measurements (every derived number is published next to the raw samples it came from)
  // ---------------------------------------------------------------------------------------------

  const phaseOrder = ["create", "tiles", "pre-settle", "rotate", "zoom", "pan", "post-settle"];
  const gapsOf = (entries) => entries.map((entry) => entry.gapMs).filter((gap) => typeof gap === "number" && Number.isFinite(gap));
  const byPhase = {};
  for (const name of phaseOrder) {
    const entries = samples.filter((sample) => sample.phase === name);
    const nonScenario = (entry) => entry.rafInvokedTotal - entry.ownInvokedTotal;
    byPhase[name] = {
      frames: entries.length,
      firstAtMs: entries.length === 0 ? null : entries[0].t,
      lastAtMs: entries.length === 0 ? null : entries[entries.length - 1].t,
      gapMs: summarise(gapsOf(entries)),
      stallsOverThreshold: stallRuns(entries.filter((sample) => typeof sample.gapMs === "number"), 1000),
      nonScenarioRafCallbacks: entries.length === 0 ? 0 : nonScenario(entries[entries.length - 1]) - nonScenario(entries[0]),
      steps: stepLog.filter((entry) => entry.phase === name).length,
      captures: probes.filter((probe) => probe.phase === name && probe.error == null && probe.skipped === undefined).length,
    };
  }

  const interactionStartMs = interactionStart === null ? 0 : rel(interactionStart);
  const settleEndMs = settleEnd === null ? Number.MAX_SAFE_INTEGER : rel(settleEnd);
  const interactionWindow = samples.filter((sample) => sample.t >= interactionStartMs && sample.t <= settleEndMs);
  const interactionGaps = interactionWindow.filter((sample) => typeof sample.gapMs === "number");
  const gaps = gapsOf(samples);
  const windowGaps = gapsOf(interactionGaps);
  const OVER_THRESHOLD_MS = 1000;
  const stallsInWindow = stallRuns(interactionGaps, OVER_THRESHOLD_MS);
  const stallsBeforeInteraction = stallRuns(
    samples.filter((sample) => typeof sample.gapMs === "number" && sample.t < interactionStartMs),
    OVER_THRESHOLD_MS,
  );

  const bucket = (label, predicate) => ({ label, count: gaps.filter(predicate).length });
  const distributions = {
    thresholdMs: OVER_THRESHOLD_MS,
    allPhases: summarise(gaps),
    interactionWindowOnly: summarise(windowGaps),
    perPhase: Object.fromEntries(phaseOrder.map((name) => [name, byPhase[name].gapMs])),
    overThresholdSegmentation: {
      thresholdMs: OVER_THRESHOLD_MS,
      overThresholdSamplesAllPhases: gaps.filter((gap) => gap > OVER_THRESHOLD_MS).length,
      overThresholdSamplesInWindow: windowGaps.filter((gap) => gap > OVER_THRESHOLD_MS).length,
      maxGapMsAllPhases: gaps.length === 0 ? null : round(Math.max(...gaps)),
      maxGapMsInWindow: windowGaps.length === 0 ? null : round(Math.max(...windowGaps)),
      runsAllPhases: stallRuns(samples.filter((sample) => typeof sample.gapMs === "number"), OVER_THRESHOLD_MS),
      bucketsMs: [
        bucket("<=8.4 (>=120 fps)", (gap) => gap <= 8.4),
        bucket("8.4-16.7 (60-120 fps)", (gap) => gap > 8.4 && gap <= 16.7),
        bucket("16.7-33.4 (30-60 fps)", (gap) => gap > 16.7 && gap <= 33.4),
        bucket("33.4-100", (gap) => gap > 33.4 && gap <= 100),
        bucket("100-1000", (gap) => gap > 100 && gap <= 1000),
        bucket(">1000", (gap) => gap > 1000),
      ],
    },
    // The sampler's own view of the boundaries: a stall during construction / first draw / tile
    // loading shows up here, not as an inter-frame gap inside the window.
    marks,
    constructionMs: round((markAt("create-returned") ?? 0) - (markAt("create-start") ?? 0)),
    constructionToFirstSampleMs: samples.length === 0 ? null : round(samples[0].t - (markAt("create-returned") ?? 0)),
    readinessMs: readyAtMs,
    tilesLoadedAtMs,
    tilesWaitMs: tilesLoadedAtMs === null ? null : round(tilesLoadedAtMs - readyAtMs),
    preSettleMs: round((markAt("pre-capture-start") ?? 0) - (markAt("pre-settle-start") ?? 0)),
    settleMs: round((markAt("post-capture-done") ?? 0) - (markAt("post-settle-start") ?? 0)),
  };

  const frameCounts = (() => {
    let total = 0;
    const cumulative = {};
    for (const name of phaseOrder) {
      total += byPhase[name].frames;
      cumulative[name] = total;
    }
    return {
      byPhase: Object.fromEntries(phaseOrder.map((name) => [name, byPhase[name].frames])),
      cumulative,
      capturesByPhase: Object.fromEntries(phaseOrder.map((name) => [name, byPhase[name].captures])),
      nonScenarioRafCallbacksByPhase: Object.fromEntries(phaseOrder.map((name) => [name, byPhase[name].nonScenarioRafCallbacks])),
      note:
        "frames = animation frames sampled by this scenario; nonScenarioRafCallbacks = requestAnimationFrame callbacks in that phase NOT registered by this scenario (the product loop schedules one per rendered frame); captures = resolved captureFrame() calls in that phase (a capture resolves inside renderOnce(), i.e. it is a freshly rendered product frame).",
      window: {
        firstSample: interactionWindow[0] ?? null,
        lastSample: interactionWindow[interactionWindow.length - 1] ?? null,
        frameSamples: interactionGaps.length,
      },
    };
  })();

  const comparisonFields = [
    {
      name: "nonBackgroundRatio",
      pre: preStats.nonBackgroundRatio,
      post: postStats.nonBackgroundRatio,
      compared: true,
      band: "post in [0.75 x pre, 1.0]",
    },
    {
      name: "uniqueColorCount",
      pre: preStats.uniqueColorCount,
      post: postStats.uniqueColorCount,
      compared: true,
      band: "post in [0.25 x pre, 4 x pre]",
      note:
        "a whole frame of the unmodulated globe base colour is the CORRECT behaviour of this increment (spec.md SC-002: baseLayer/skyBox/skyAtmosphere false + near-ground lighting fade = 0), and T090 measured uniqueColorCount = 1 with nonBackgroundRatio = 1 on the same bundle/camera. The band is therefore about 'the same interval', not about richness.",
    },
    {
      name: "triangleCount",
      pre: preStats.triangleCount,
      post: postStats.triangleCount,
      compared: false,
      note:
        "reported only: the command tally never sees a TRIANGLES command in this backend, so the counter is structurally 0 (T156) and can carry no claim in either direction. The 'the frame really drew' claim is carried by drawCallCount, and 'not blank' by the compositor screenshot.",
    },
    {
      name: "drawCallCount",
      pre: preStats.drawCallCount,
      post: postStats.drawCallCount,
      compared: false,
      note: "same as triangleCount",
    },
    {
      name: "tileCount",
      pre: preStats.tileCount,
      post: postStats.tileCount,
      compared: true,
      band: "post >= pre (cumulative counter since construction; resetStats() is not called before the comparison)",
    },
    {
      name: "frameTimeMs.p50",
      pre: preStats.frameTimeMs.p50,
      post: postStats.frameTimeMs.p50,
      compared: true,
      band: "finite and > 0 on both sides; post <= 1000 (the same budget as (a), applied to the product's own per-frame measurement)",
    },
    {
      name: "frameTimeMs.p95",
      pre: preStats.frameTimeMs.p95,
      post: postStats.frameTimeMs.p95,
      compared: true,
      band: "finite and > 0 on both sides; post <= 1000 (the same budget as (a))",
    },
    {
      name: "depthDiscontinuityRatio",
      pre: Number.isNaN(preStats.depthDiscontinuityRatio) ? null : preStats.depthDiscontinuityRatio,
      post: Number.isNaN(postStats.depthDiscontinuityRatio) ? null : postStats.depthDiscontinuityRatio,
      compared: false,
      note:
        "EXCLUDED: unmeasured on both sides (NaN). `assembleFrameStatistics` is called without depth samples, so 0 would be a fabricated measurement (frame-statistics.ts UNMEASURED)",
    },
  ];

  const result = {
    scenario: "terrain-interaction",
    backend,
    setup,
    tiles: { ...tiles, readyAtMs, tilesLoadedAtMs, framesWhileLoading: byPhase["tiles"].frames, gapMs: byPhase["tiles"].gapMs },
    interaction: {
      stepMs: STEP_MS,
      stepsPerPhase: STEPS_PER_PHASE,
      phaseMs: PHASE_MS,
      totalMs: TOTAL_MS,
      settleMs: SETTLE_MS,
      startMs: interactionStartMs,
      endMs: interactionEnd === null ? null : rel(interactionEnd),
      settleEndMs: settleEnd === null ? null : rel(settleEnd),
      realizedDurationMs: interactionRealizedMs,
      stepsApplied: stepLog.length,
      stepsPerPhaseApplied: Object.fromEntries(PHASES.map((phase) => [phase.name, stepLog.filter((entry) => entry.phase === phase.name).length])),
      trajectory: PHASES.map((phase) => ({ name: phase.name, axis: phase.axis, from: phase.from, to: phase.to, unit: phase.unit, perStep: phase.perStep })),
      stepLog,
      injectedStall,
    },
    frameSamplesRaw: samples,
    distributions,
    stalls: {
      thresholdMs: OVER_THRESHOLD_MS,
      inInteractionWindow: stallsInWindow,
      beforeInteraction: stallsBeforeInteraction,
      assertionScope:
        "inInteractionWindow = samples with t in [interaction.startMs, interaction.settleEndMs] (SC-004's 3 s claim, including the settle); beforeInteraction is REPORTED for attribution (construction / tile loading / first draw) and is not part of that claim",
    },
    frameCounts,
    raf: {
      ...raf,
      nonScenarioInvokedTotal: raf.invokedTotal - raf.ownInvoked,
      scheduleDerivation:
        "the runtime calls ensureLoop() after every renderOnce(), i.e. one requestAnimationFrame per rendered frame plus one after the first frame in ready",
    },
    captures: {
      pre: {
        atMs: preCaptureAtMs,
        stats: preStats,
        own: preOwn,
        presented: presentedPre,
        frame: { width: preCapture.width, height: preCapture.height, pixelFormat: preCapture.pixelFormat, origin: preCapture.origin, premultiplied: preCapture.premultiplied },
      },
      probes,
      post: {
        atMs: postCaptureAtMs,
        stats: postStats,
        own: postOwn,
        presented: presentedPost,
        frame: { width: postCapture.width, height: postCapture.height, pixelFormat: postCapture.pixelFormat, origin: postCapture.origin, premultiplied: postCapture.premultiplied },
      },
      differencePreToPost: differenceRatio(preCapture.pixels, postCapture.pixels),
      note: "stats = TerrainSceneHandle.stats() (the contract surface, computed from the frame just captured); own = the same pixels reduced here with the same background/tolerance; presented = ctx.readPresentedCanvas(canvas) (createImageBitmap path, independent of captureFrame)",
    },
    comparison: {
      fields: comparisonFields,
      excluded: comparisonFields.filter((field) => field.compared === false).map((field) => ({ name: field.name, reason: field.note })),
      depthDiscontinuityRatioIsNaN: {
        pre: Number.isNaN(preStats.depthDiscontinuityRatio),
        post: Number.isNaN(postStats.depthDiscontinuityRatio),
      },
      statsAfterReset: { ...statsAfterReset, note: "after resetStats(): pixel statistics are unmeasured, never 0" },
      statsAfterResetIsNaN: {
        nonBackgroundRatio: Number.isNaN(statsAfterReset.nonBackgroundRatio),
        depthDiscontinuityRatio: Number.isNaN(statsAfterReset.depthDiscontinuityRatio),
      },
    },
    diagnostics,
    uncaught,
    closeOut: { harnessScreenshotIsPostInteractionFrame: true, sceneLeftAlive: true },
  };

  step("interaction-done", {
    realizedDurationMs: interactionRealizedMs,
    stepsApplied: stepLog.length,
    frameSamplesInWindow: interactionGaps.length,
    stallsInWindow: stallsInWindow.length,
    maxGapMsInWindow: distributions.overThresholdSegmentation.maxGapMsInWindow,
    preNonBackgroundRatio: preStats.nonBackgroundRatio,
    postNonBackgroundRatio: postStats.nonBackgroundRatio,
    preUniqueColorCount: preStats.uniqueColorCount,
    postUniqueColorCount: postStats.uniqueColorCount,
    diagnostics: diagnostics.length,
    uncaught: uncaught.length,
  });
  return result;
}
