/**
 * `terrain-ready` — T091 (US1's Independent Test; `→ FR-001, FR-011, FR-015, SC-001`).
 *
 * WHAT THIS SCENARIO DRIVES
 *   The **shipped entry point**, not a re-assembled scene: `bundle.terrainScene` is the namespace of
 *   `packages/cesium-webgpu/src/index.ts`, and every scene in this file is created by
 *   `createTerrainScene(options)`. That is what makes "the acceptance suite exercises the public API"
 *   a measurable statement instead of a claim (`ctx.buildTerrainScene` — the probe's own scene
 *   assembly — is deliberately NOT used here).
 *
 * FIXED CONDITIONS (T091: camera / time / seed / viewport / pixel ratio / dataset)
 *   Dataset     `matterhorn-z0-12` (the committed fixture, 13 levels / 286 tiles).
 *   Camera      Mont Blanc from 24 km at -50° — the same pose as `DEFAULT_CAMERA`
 *               (`src/compose/scene-config.ts:64-71`), passed explicitly so the run's fixed condition
 *               is visible in the artefact rather than implied by a default.
 *   Scene time  `2026-03-20T12:00:00Z` (`SCENE_TIME_ISO`). It is **not** an entry option, so it is
 *               recorded as a declared constant with its source and marked `measured: false` — the
 *               public handle exposes no way to read the scene clock back.
 *   Seed        none: this scenario constructs no random source, so "seed" is not applicable and is
 *               recorded as `null` with that reason (inventing a value would be worse than saying so).
 *   Viewport    320x200 CSS at `devicePixelRatio: 1`. 320x200 is the size of the page's
 *               `#contract-container`, so `#contract-canvas` exactly fills its container: a canvas that
 *               never received a frame shows the container's **black** background in the harness
 *               screenshot (measured as "not non-background") instead of masquerading as content — that
 *               is what gives the "not blank" assertion its discriminating power. DPR 1 is pinned
 *               **because it is the measured truth**, not by preference: on the WebGPU path the swap
 *               chain re-derives the drawing buffer from the canvas's CSS box × the page's DPR and writes
 *               the attributes back (`backend-webgpu/webgpu/swapchain.ts:60-72,181-197`), so a laid-out
 *               canvas renders at the page's ratio whatever `viewport.devicePixelRatio` asked for. The
 *               handle-contract arm measures the complementary case (no CSS layout) and shows the entry
 *               **does** honour the pinned ratio there — see `canvas.backingStore` in the result.
 *
 * ORDER OF THE TWO ARMS (and why it is not the obvious one)
 *   The handle-contract arm runs **first**, on a throwaway scene in an off-screen host, and is
 *   disposed before the acceptance scene is constructed. The replacement `Context`
 *   (`backend-webgpu/Renderer/Context.ts:343-344`) resets the pipeline cache and re-points the
 *   process-wide pipeline factory at the newest context, so two **live** contexts would disturb each
 *   other. Creating-then-disposing the throwaway first keeps exactly one live context at any time,
 *   and leaves the acceptance scene alive and presenting when the harness screenshots the canvas.
 *
 * WHY THE HOST INSTALLS THE DEVICE HAND-OFF
 *   The replacement `Context` takes its device from the hand-off slot; with an empty slot it performs
 *   a construction-time whole delegation to upstream WebGL2 (`Context.ts:30-35`, plan D2-a). The
 *   shipped entry cannot install it itself (`src/**` MUST NOT import the patch layer — rules A1/A2),
 *   so the integrator parks the probed device first: this scenario does exactly what
 *   `probe.js`'s own `buildTerrainScene` does and what research §3 prescribes. Without it this WebGPU
 *   run would silently be a WebGL2 run, and the `status.active` assertion below would say so.
 *
 * MODULE RULES
 *   This module imports **nothing** (`probe.js` runs `main()` on import). Every helper arrives through
 *   `ctx`; the default export is `(bundle, canvas, ctx) => result` and the page publishes the returned
 *   object under `report.result["terrain-ready"]`.
 */
export default async function terrainReadyScenario(bundle, canvas, ctx) {
  const { backend, step, prefetchDevice } = ctx;

  // ---- fixed conditions -------------------------------------------------------------------------
  const DATASET_ID = "matterhorn-z0-12";
  const CAMERA = { longitude: 6.8652, latitude: 45.8326, height: 24000, heading: 0, pitch: -50, roll: 0 };
  /**
   * `devicePixelRatio: 1` on purpose. The entry accepts a viewport DPR, but on the WebGPU path the
   * swap chain re-derives the drawing buffer from the canvas's **CSS box × the page's DPR**
   * (`backend-webgpu/webgpu/swapchain.ts:181-197` → `resolveDrawingBufferSize`, and
   * `#buildAttachments()` writes the attributes back), so a laid-out canvas is rendered at the page's
   * ratio (1 here) whatever the entry was asked for. Pinning 1 makes every channel agree — canvas CSS
   * box, backing store, `captureFrame()` and the harness screenshot are all 320x200 — instead of
   * recording a number nothing downstream uses.
   */
  const VIEWPORT = { width: 320, height: 200, devicePixelRatio: 1 };
  const TILES_TIMEOUT_MS = 45_000;
  const SETTLE_FRAMES = 4;
  const CONTAINER_ID = "contract-container";
  const CANVAS_ID = "contract-canvas";
  const FIXTURE_PREFIX = `/packages/cesium-webgpu/fixtures/${DATASET_ID}/`;
  const FIXED = {
    backend,
    datasetId: DATASET_ID,
    fixturePrefix: FIXTURE_PREFIX,
    camera: CAMERA,
    cameraSource: "passed explicitly; equals DEFAULT_CAMERA in packages/cesium-webgpu/src/compose/scene-config.ts:64-71",
    viewport: VIEWPORT,
    backingStore: { width: VIEWPORT.width * VIEWPORT.devicePixelRatio, height: VIEWPORT.height * VIEWPORT.devicePixelRatio },
    pixelRatioNote:
      "the page's own DPR is 1 (harness browser context). The pinned viewport DPR is 1 as well: the swap chain " +
      "derives the drawing buffer from the canvas CSS box × the page DPR (swapchain.ts:181-197), so a different " +
      "requested DPR would be silently replaced — recorded here rather than asserted as honoured.",
    sceneTimeIso: {
      value: "2026-03-20T12:00:00Z",
      source: "packages/cesium-webgpu/src/compose/scene-config.ts:34 (SCENE_TIME_ISO)",
      measured: false,
      note: "not an entry option and not readable back from the public handle, so it is recorded as a declared constant",
    },
    seed: {
      value: null,
      note: "this scenario constructs no random source; there is no seed to fix and none is invented",
    },
    tilesTimeoutMs: TILES_TIMEOUT_MS,
    settleFrames: SETTLE_FRAMES,
    harness: {
      screenshotTarget: `#${CANVAS_ID} inside #${CONTAINER_ID} (tests/support/contract-harness.mjs captureCanvasRegion → locator("#contract-canvas"))`,
      criterion: "a > 8 && r + g + b > 24 (tests/support/png-reader.mjs regionStatistics)",
    },
  };

  if (canvas.id !== CANVAS_ID) {
    throw new Error(`the page MUST hand this scenario the pre-placed #${CANVAS_ID} element (got #${canvas.id === "" ? "<no id>" : canvas.id})`);
  }
  const container = document.getElementById(CONTAINER_ID);
  if (container === null) {
    throw new Error(`the page MUST pre-place #${CONTAINER_ID}: the harness screenshots #${CANVAS_ID} inside it`);
  }

  // ---- request-level evidence: which tiles were really fetched, in which arm ---------------------
  // The entry's fixture reader is a plain `fetch` (`src/terrain/source.ts:170-181` via the counting
  // wrapper in `src/compose/scene-runtime.ts:232-258`), so wrapping `fetch` attributes every tile read
  // to the arm that caused it. The spec cross-checks these paths against Playwright's own request log,
  // so a page that invented coordinates would be caught.
  let fetchPhase = "init";
  const fetchLog = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function terrainReadyFetch(input, init) {
    let url;
    try {
      if (typeof input === "string") url = input;
      else if (input !== null && typeof input === "object" && typeof input.url === "string") url = input.url;
      else url = String(input);
    } catch {
      url = "<unreadable>";
    }
    fetchLog.push({ url, phase: fetchPhase });
    return originalFetch.call(this, input, init);
  };
  const pathsIn = (phase) => [...new Set(fetchLog.filter((entry) => entry.phase === phase).map((entry) => entry.url))];
  const tileEvidenceFor = (phase) => {
    const paths = pathsIn(phase);
    const tiles = paths
      .filter((url) => url.endsWith(".hgt"))
      .map((url) => {
        const match = /(\d+)\/(\d+)\/(\d+)\.hgt$/.exec(url);
        return match === null
          ? { path: url, level: null, x: null, y: null, tile: null }
          : { path: url, level: Number(match[1]), x: Number(match[2]), y: Number(match[3]), tile: `${match[1]}/${match[2]}/${match[3]}` };
      })
      .sort((left, right) => String(left.tile).localeCompare(String(right.tile)));
    return {
      phase,
      requests: paths.length,
      tileRequests: tiles.length,
      manifestRequests: paths.filter((url) => url.endsWith("manifest.json")).length,
      tiles,
      tileCoordinates: tiles.map((tile) => tile.tile),
      distinctLevels: [...new Set(tiles.map((tile) => tile.level))].sort((left, right) => left - right),
      allUnderFixturePrefix: tiles.every((tile) => tile.path.startsWith(FIXTURE_PREFIX)),
      paths,
    };
  };

  // ---- small recorders --------------------------------------------------------------------------
  const describeNumber = (value) => {
    if (typeof value !== "number") return { kind: "missing", label: String(value) };
    if (Number.isNaN(value)) return { kind: "nan", label: "NaN" };
    if (!Number.isFinite(value)) return { kind: "infinite", label: String(value) };
    return { kind: "finite", label: value, value };
  };
  const statsOf = (handle) => {
    try {
      const stats = handle.stats() ?? {};
      const frameTimeMs = stats.frameTimeMs ?? {};
      return {
        nonBackgroundRatio: describeNumber(stats.nonBackgroundRatio),
        uniqueColorCount: describeNumber(stats.uniqueColorCount),
        depthDiscontinuityRatio: describeNumber(stats.depthDiscontinuityRatio),
        triangleCount: describeNumber(stats.triangleCount),
        drawCallCount: describeNumber(stats.drawCallCount),
        tileCount: describeNumber(stats.tileCount),
        frameTimeMs: { p50: describeNumber(frameTimeMs.p50), p95: describeNumber(frameTimeMs.p95) },
      };
    } catch (error) {
      return { error: String(error?.message ?? error), unreadable: true };
    }
  };
  const frameShape = (frame) => ({
    width: frame?.width ?? null,
    height: frame?.height ?? null,
    pixelFormat: frame?.pixelFormat ?? null,
    origin: frame?.origin ?? null,
    premultiplied: frame?.premultiplied ?? null,
    pixelsIsUint8Array: frame?.pixels instanceof Uint8Array,
    pixelLength: frame?.pixels?.length ?? null,
    pixelCount: frame?.pixels === undefined ? null : Math.floor(frame.pixels.length / 4),
  });
  /**
   * An independent, page-side measurement of a captured frame, using **the same criterion** the
   * harness applies to the compositor screenshot. Two different capture channels agreeing on
   * "how much of the frame is not background" is the strongest form of the "not blank" statement this
   * page can produce on its own.
   */
  const measureFrame = (frame) => {
    const pixels = frame?.pixels;
    if (!(pixels instanceof Uint8Array)) return { available: false, reason: "captureFrame did not return a Uint8Array" };
    let nonBackground = 0;
    const colours = new Set();
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      const a = pixels[index + 3];
      if (a > 8 && r + g + b > 24) nonBackground += 1;
      if (colours.size < 256) colours.add((r << 24) | (g << 16) | (b << 8) | a);
    }
    const considered = Math.floor(pixels.length / 4);
    return {
      available: true,
      width: frame.width,
      height: frame.height,
      considered,
      nonBackground,
      nonBackgroundRatio: considered === 0 ? null : nonBackground / considered,
      uniqueColours: colours.size,
      criterion: "a > 8 && r + g + b > 24 — identical to tests/support/png-reader.mjs regionStatistics",
    };
  };
  const reasonOf = (error) => ({
    name: error?.name ?? "Error",
    category: error?.category ?? null,
    message: String(error?.message ?? error),
    isFrameCapture: error?.pixelFormat !== undefined || error?.pixels !== undefined,
  });

  /**
   * Identity of a GPU buffer, as a small integer. `String(gpuBuffer)` is "[object GPUBuffer]" for every
   * buffer, so distinctness has to be measured by object identity — which also makes the count a real
   * answer to "how many different tile geometries were in this frame".
   */
  const bufferIdentities = new WeakMap();
  let nextBufferIdentity = 1;
  const identityOf = (value) => {
    if (value === null || value === undefined || typeof value !== "object") return null;
    if (!bufferIdentities.has(value)) {
      bufferIdentities.set(value, nextBufferIdentity);
      nextBufferIdentity += 1;
    }
    return bufferIdentities.get(value);
  };
  /**
   * Reduce the raw `Context#draw` log of **one frame** to a serialisable summary.
   *
   * The raw entries hold live GPU objects and uniform callbacks, so they MUST NOT reach the report
   * (the page report is JSON-serialised); only counts, ids and layout facts are returned.
   */
  const summariseDraws = (entries) => {
    const frames = [...new Set(entries.map((entry) => entry.frame).filter((frame) => frame !== null && frame !== undefined))];
    const lastFrame = frames.length === 0 ? null : Math.max(...frames);
    const inFrame = lastFrame === null ? entries : entries.filter((entry) => entry.frame === lastFrame);
    const indexCounts = inFrame.map((entry) => (typeof entry.count === "number" ? entry.count : null));
    const triangles = indexCounts.reduce((total, count) => total + (typeof count === "number" ? Math.floor(count / 3) : 0), 0);
    const indexBufferIds = inFrame.map((entry) => identityOf(entry.rawIndexBuffer)).filter((id) => id !== null);
    const vertexBufferIds = inFrame.flatMap((entry) => (entry.rawVertexBuffers ?? []).map((binding) => identityOf(binding.buffer))).filter((id) => id !== null);
    return {
      available: inFrame.length > 0,
      frame: lastFrame,
      draws: inFrame.length,
      indexCounts,
      trianglesFromIndices: triangles,
      indexedDraws: inFrame.filter((entry) => entry.vertexArray?.indexed === true).length,
      distinctIndexBuffers: new Set(indexBufferIds).size,
      distinctVertexBuffers: new Set(vertexBufferIds).size,
      distinctVertexArrayShapes: new Set(
        inFrame.map((entry) => `${entry.vertexArray?.numberOfVertices ?? "?"}|${entry.vertexArray?.indexed ?? "?"}|${entry.rawVertexBuffers?.length ?? 0}`),
      ).size,
      topologies: [...new Set(inFrame.map((entry) => entry.renderState?.topology ?? null))],
      sampleCounts: [...new Set(inFrame.map((entry) => entry.renderState?.sampleCount ?? null))],
      shaderProgramVariants: [...new Set(inFrame.map((entry) => entry.shaderProgramVariant ?? null))],
      vertexBufferSlots: [...new Set(inFrame.flatMap((entry) => (entry.rawVertexBuffers ?? []).map((binding) => binding.slot)))].sort((left, right) => left - right),
      sample: inFrame[0] === undefined
        ? null
        : {
            count: inFrame[0].count ?? null,
            indexed: inFrame[0].vertexArray?.indexed ?? null,
            numberOfVertices: inFrame[0].vertexArray?.numberOfVertices ?? null,
            attributeLayout: inFrame[0].vertexArray?.layout ?? null,
            topology: inFrame[0].renderState?.topology ?? null,
          },
      instrumentedVia: "ctx.instrumentContextDraw → patch-layer Context.prototype.draw (the same instrumentation the W5 probes use)",
    };
  };
  const trackReady = (handle) => {
    const outcome = { state: "pending", elapsedMs: null, error: null };
    const started = performance.now();
    const promise = handle.ready.then(
      () => {
        outcome.state = "fulfilled";
        outcome.elapsedMs = performance.now() - started;
      },
      (error) => {
        outcome.state = "rejected";
        outcome.error = reasonOf(error);
        outcome.elapsedMs = performance.now() - started;
      },
    );
    return { outcome, promise };
  };
  const createRecorder = () => {
    const errors = [];
    const statuses = [];
    return {
      errors,
      statuses,
      subscribe(handle) {
        return handle.diagnostics.onError((error) => {
          errors.push({
            category: error?.category ?? null,
            message: String(error?.message ?? error),
            causeName: error?.cause?.name ?? null,
          });
        });
      },
      onStatus(status) {
        statuses.push({
          active: status?.active ?? null,
          reason: status?.reason ?? null,
          degraded: status?.degraded ?? null,
          notes: status?.notes ?? [],
        });
      },
    };
  };

  // ---- device hand-off (the integrator's step; see the file header) -------------------------------
  const handoffLog = [];
  const installDevice = async (reason) => {
    // The slot state is read on **both** paths: it is page-level module state, not a GPU object, so
    // inspecting it cannot touch `navigator.gpu` (which a WebGL2 run must leave alone).
    const auditBefore = bundle.deviceHandoff.audit();
    const entriesBefore = auditBefore.entries.length;
    // The slot MUST be empty before a new cycle is begun: a parked device would mean another context
    // is about to consume it, and `resetCycle()` refuses in that state (plan D2-a / AGENTS.md §7).
    const slotPendingBefore = auditBefore.pending;
    if (slotPendingBefore) {
      throw new Error("device handoff: a device is still parked in the slot before this scene was created");
    }
    if (backend === "webgl2") {
      // A WebGL2 run MUST NOT touch `navigator.gpu` at all: `assertOtherBackendUntouched` requires
      // `adapterRequests === 0`, which is exactly the "one backend per run" invariant (FR-006/FR-011).
      const record = {
        installed: false,
        reason,
        slotPendingBefore,
        slotCycleBefore: auditBefore.cycle,
        why: "a WebGL2 run MUST NOT request a WebGPU adapter, so no device is probed or parked",
      };
      handoffLog.push(record);
      return record;
    }
    // A fresh hand-off cycle: `take()` emptied the slot when the previous context was constructed, so
    // the slot is free and `resetCycle` is the documented way to begin the next one.
    bundle.deviceHandoff.resetCycle(reason);
    const { adapter, device } = await prefetchDevice();
    bundle.deviceHandoff.install({ adapter, device, limits: adapter.limits, features: adapter.features, source: reason });
    const auditAfter = bundle.deviceHandoff.audit();
    const added = auditAfter.entries.slice(entriesBefore);
    const record = {
      installed: true,
      reason,
      cycle: auditAfter.cycle,
      pending: auditAfter.pending,
      slotPendingBefore,
      slotCycleBefore: auditBefore.cycle,
      auditOps: added.map((entry) => entry.op),
      auditSources: added.map((entry) => entry.source),
    };
    handoffLog.push(record);
    return record;
  };

  // ---- DOM observations -------------------------------------------------------------------------
  const liveContextFacts = (element) => {
    // Only the **active** backend's own context type is asked for: calling `getContext("webgl2")` on a
    // WebGPU run would create the very WebGL2 context the single-backend assertion forbids.
    const type = backend === "webgl2" ? "webgl2" : "webgpu";
    let first = null;
    let second = null;
    let error = null;
    try {
      first = element.getContext(type);
      second = element.getContext(type);
    } catch (cause) {
      error = String(cause?.message ?? cause);
    }
    return {
      type,
      present: first !== null && first !== undefined,
      sameObjectOnSecondCall: first !== null && first === second,
      checkedVia: `canvas.getContext("${type}")`,
      error,
    };
  };
  const snapshotCanvas = () => {
    const canvases = [...container.querySelectorAll("canvas")];
    const driven = canvases[0] ?? null;
    const box = driven === null ? null : driven.getBoundingClientRect();
    return {
      canvasesInContainer: canvases.length,
      canvasIds: canvases.map((element) => element.id || null),
      // The harness screenshots `#contract-canvas`; if the driven canvas were a *different* element,
      // the screenshot would show a canvas nothing ever drew into (T089's reuse rule).
      drivenIsTheScreenshotTarget:
        driven !== null && driven === canvas && driven === document.getElementById(CANVAS_ID) && driven.id === CANVAS_ID,
      drivenIsTheElementHandedToTheScenario: driven === canvas,
      backingStore: driven === null ? null : { width: driven.width, height: driven.height },
      cssSize: driven === null ? null : { width: driven.style.width, height: driven.style.height },
      boundingBox: box === null ? null : { x: box.x, y: box.y, width: box.width, height: box.height },
      activeContext: driven === null ? null : liveContextFacts(driven),
      page: {
        innerWidth: globalThis.innerWidth,
        innerHeight: globalThis.innerHeight,
        devicePixelRatio: globalThis.devicePixelRatio ?? null,
        note: "the page's own DPR (1, set by the harness browser context) is NOT the render viewport DPR (2, pinned by this scenario)",
      },
    };
  };

  // ---- arm 1: the handle contract on a throwaway scene (see the header for the ordering) ---------
  const handleContractArm = async () => {
    fetchPhase = "handle-contract";
    const host = document.createElement("div");
    host.id = "contract-handle-host";
    // `display: none` on purpose, and it is what makes "the entry honours the pinned viewport" a
    // measurement instead of a claim: with no CSS layout the swap chain cannot derive a drawing buffer
    // from a client box and falls back to the canvas attributes (`swapchain.ts:60-72` `canvas-attributes`),
    // so the DPR the entry was asked for survives here. The acceptance arm measures the other half of the
    // pair — a **laid-out** canvas, where the swap chain re-derives the size and the requested DPR is
    // replaced (recorded as a product observation, not worked around). The host is also out of the
    // screenshot's way, which the off-screen position guarantees in both cases.
    host.style.cssText = "display:none";
    document.body.appendChild(host);
    const contractViewport = { width: 200, height: 150, devicePixelRatio: 2 };
    const observation = { hostId: host.id, camera: CAMERA, viewport: contractViewport };
    try {
      observation.handoff = await installDevice("terrain-ready:handle-contract");
      const recorder = createRecorder();
      const handle = bundle.terrainScene.createTerrainScene({
        container: host,
        datasetId: DATASET_ID,
        camera: CAMERA,
        viewport: contractViewport,
        onStatus: (status) => recorder.onStatus(status),
      });
      const unsubscribe = recorder.subscribe(handle);
      observation.members = ["ready", "whenTilesLoaded", "captureFrame", "stats", "resetStats", "setView", "requestRender", "dispose", "diagnostics"].map(
        (name) => ({ name, present: handle[name] !== undefined }),
      );
      const ready = trackReady(handle);
      await ready.promise;
      observation.ready = ready.outcome;

      const ownedCanvas = host.querySelector("canvas");
      observation.canvas = {
        createdByEntry: ownedCanvas !== null,
        id: ownedCanvas === null ? null : ownedCanvas.id || null,
        // The pair-mate of the acceptance arm's measurement: no CSS layout ⇒ the swap chain uses the
        // canvas attributes ⇒ the entry's requested viewport (200x150 @2 = 400x300) is what remains.
        backingStore: ownedCanvas === null ? null : { width: ownedCanvas.width, height: ownedCanvas.height },
        expectedBackingStore: {
          width: contractViewport.width * contractViewport.devicePixelRatio,
          height: contractViewport.height * contractViewport.devicePixelRatio,
        },
        clientBox: ownedCanvas === null ? null : { width: ownedCanvas.clientWidth, height: ownedCanvas.clientHeight },
      };
      let removeCalls = 0;
      if (ownedCanvas !== null) {
        const originalRemove = ownedCanvas.remove.bind(ownedCanvas);
        ownedCanvas.remove = () => {
          removeCalls += 1;
          return originalRemove();
        };
      }

      // A frame BEFORE dispose: the contrast this contract is about is "a real frame, then a loud
      // failure" — never "a frame, then a silently empty frame".
      observation.captureBeforeDispose = await handle.captureFrame().then(
        (frame) => ({ settled: "fulfilled", shape: frameShape(frame), inPage: measureFrame(frame), stats: statsOf(handle) }),
        (error) => ({ settled: "rejected", ...reasonOf(error) }),
      );

      const diagnosticsBeforeDispose = recorder.errors.length;
      const disposals = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const entry = { attempt, threw: null, diagnosticsAdded: null, removeCalls: null, canvasInHost: null };
        try {
          handle.dispose();
        } catch (error) {
          entry.threw = reasonOf(error);
        }
        entry.diagnosticsAdded = recorder.errors.length - diagnosticsBeforeDispose;
        entry.removeCalls = removeCalls;
        entry.canvasInHost = host.querySelector("canvas") !== null;
        disposals.push(entry);
      }
      observation.diagnosticsBeforeDispose = diagnosticsBeforeDispose;
      observation.disposals = disposals;
      observation.removeCallsAcrossThreeDisposals = removeCalls;

      // The two refusals below are what the handle contract is measured on: the refusal MUST be
      // reported through `diagnostics.onError` with its true category (FR-004/FR-033) **and** the
      // promise MUST reject. Both are recorded; neither is worked around.
      observation.postDispose = {
        whenTilesLoaded: await handle.whenTilesLoaded({ timeoutMs: 1000 }).then(
          (value) => ({ settled: "fulfilled", loaded: value?.loaded ?? null, pendingTiles: value?.pendingTiles ?? null }),
          (error) => ({ settled: "rejected", ...reasonOf(error) }),
        ),
        captureFrame: await handle.captureFrame().then(
          (frame) => ({ settled: "fulfilled", returnedFrame: true, shape: frameShape(frame) }),
          (error) => ({ settled: "rejected", returnedFrame: false, ...reasonOf(error) }),
        ),
        statsStillReportTheLastMeasurement: statsOf(handle),
        canvasRemovedFromHost: host.querySelector("canvas") === null,
      };
      observation.diagnostics = recorder.errors.slice();
      // The refusals MUST have reached `diagnostics.onError` — the rejection alone is not enough, and
      // this is a separate measurement from it.
      observation.diagnosticsDeliveredAfterDispose = observation.diagnostics.length - diagnosticsBeforeDispose;
      observation.statuses = recorder.statuses.slice();
      unsubscribe();
      step("terrain-ready:handle-contract", {
        ready: observation.ready.state,
        disposals: observation.disposals.map((entry) => ({ attempt: entry.attempt, threw: entry.threw === null ? null : entry.threw.name, diagnosticsAdded: entry.diagnosticsAdded })),
        postDisposeCapture: observation.postDispose.captureFrame.settled,
        postDisposeCategory: observation.postDispose.captureFrame.category ?? null,
        diagnosticsDeliveredAfterDispose: observation.diagnosticsDeliveredAfterDispose,
      });
      return observation;
    } finally {
      host.remove();
    }
  };

  // ---- arm 2: the acceptance scene, left alive for the harness screenshot ------------------------
  const acceptanceArm = async () => {
    fetchPhase = "acceptance";
    const observation = { containerId: container.id };
    observation.domBefore = {
      canvasesInContainer: container.querySelectorAll("canvas").length,
      backingStore: { width: canvas.width, height: canvas.height },
      cssSize: { width: canvas.style.width, height: canvas.style.height },
    };
    observation.handoff = await installDevice("terrain-ready:acceptance");
    // Real per-draw geometry of one settled frame, through the patch layer's own `draw` entry point.
    // It only exists on the WebGPU path: a WebGL2 run executes upstream's `Context`, which this patch
    // does not touch (`contextModule` is the patch layer's class either way), so `available` records
    // which path could be measured instead of pretending both were.
    const drawLog = [];
    const drawInstrumented = ctx.instrumentContextDraw(bundle, drawLog, [], null, 512);
    const recorder = createRecorder();
    const handle = bundle.terrainScene.createTerrainScene({
      container,
      datasetId: DATASET_ID,
      camera: CAMERA,
      viewport: VIEWPORT,
      onStatus: (status) => recorder.onStatus(status),
    });
    const unsubscribe = recorder.subscribe(handle);
    const ready = trackReady(handle);
    await ready.promise;
    observation.ready = ready.outcome;
    observation.domAfterCreate = snapshotCanvas();
    step("terrain-ready:scene-created", { ready: observation.ready.state, canvases: observation.domAfterCreate.canvasesInContainer, backingStore: observation.domAfterCreate.backingStore });

    const tilesStarted = performance.now();
    const load = await handle.whenTilesLoaded({ timeoutMs: TILES_TIMEOUT_MS });
    observation.tilesLoaded = {
      loaded: load?.loaded ?? null,
      pendingTiles: load?.pendingTiles ?? null,
      elapsedMs: performance.now() - tilesStarted,
      timeoutMs: TILES_TIMEOUT_MS,
    };
    step("terrain-ready:tiles-loaded", observation.tilesLoaded);

    const settle = async (frames) => {
      const shapes = [];
      for (let index = 0; index < frames; index += 1) {
        handle.requestRender();
        shapes.push(frameShape(await handle.captureFrame()));
      }
      return shapes;
    };
    observation.settleFrames = await settle(SETTLE_FRAMES);
    observation.statsAtLoad = statsOf(handle);

    // "unmeasured MUST be NaN, never 0" (T089 / FR-033): right after `resetStats()` nothing has been
    // measured, so every measured-only field has to say so instead of reporting a zero that reads
    // like a conclusion.
    handle.resetStats();
    observation.statsAfterReset = statsOf(handle);

    const frame = await handle.captureFrame();
    observation.capturedFrame = { shape: frameShape(frame), inPage: measureFrame(frame) };
    observation.statsOneFrame = statsOf(handle);

    // One settled frame's draws, measured from the empty log so the accounting is exactly one frame.
    drawLog.length = 0;
    handle.requestRender();
    await handle.captureFrame();
    observation.settledFrameGeometry = { instrumented: drawInstrumented, ...summariseDraws(drawLog) };

    observation.settleFramesAfterCapture = await settle(2);
    observation.statsSettled = statsOf(handle);
    observation.diagnostics = recorder.errors.slice();
    observation.statuses = recorder.statuses.slice();
    unsubscribe();
    step("terrain-ready:acceptance", {
      tilesLoaded: observation.tilesLoaded.loaded,
      tileCount: observation.statsAtLoad.tileCount?.label ?? null,
      oneFrameDraws: observation.statsOneFrame.drawCallCount?.label ?? null,
      oneFrameTrianglesByProductTally: observation.statsOneFrame.triangleCount?.label ?? null,
      measuredFrameDraws: observation.settledFrameGeometry.draws,
      measuredFrameTriangles: observation.settledFrameGeometry.trianglesFromIndices,
      distinctIndexBuffers: observation.settledFrameGeometry.distinctIndexBuffers,
      diagnostics: observation.diagnostics.length,
      statuses: observation.statuses.map((status) => status.active),
    });
    return observation;
  };

  const handleContract = await handleContractArm();
  const acceptance = await acceptanceArm();
  fetchPhase = "settled";
  const fetchEvidence = {
    "handle-contract": tileEvidenceFor("handle-contract"),
    acceptance: tileEvidenceFor("acceptance"),
    note: "attributed in-page by wrapping `fetch`; the spec cross-checks the acceptance coordinates against Playwright's own request log and against the committed manifest",
  };
  globalThis.fetch = originalFetch;
  fetchPhase = "restored";

  const result = {
    scenario: "terrain-ready",
    backend,
    fixed: FIXED,
    entry: {
      module: "packages/cesium-webgpu/src/index.ts",
      function: "createTerrainScene",
      exportedFromBundle: typeof bundle.terrainScene?.createTerrainScene === "function",
      bundleNamespaceKeys: Object.keys(bundle.terrainScene ?? {}).sort(),
      probeSceneAssemblyUsed: false,
      note: "every scene in this scenario comes from the shipped entry point; ctx.buildTerrainScene was not called",
    },
    handoffLog,
    handleContract,
    acceptance,
    fetchEvidence,
    fetchLogSize: fetchLog.length,
    fetchWrapperRestored: globalThis.fetch === originalFetch,
  };
  return result;
}
