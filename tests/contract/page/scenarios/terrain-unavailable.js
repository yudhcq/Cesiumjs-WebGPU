/**
 * T088 page scenario — "data unavailable" is an **observable, classified state**, and the rest of the
 * terrain keeps rendering while it happens (FR-004 / contract TS-5).
 *
 * Contract of a scenario module (see `probe.js`'s `SCENARIO_MODULES`): it default-exports
 * `(bundle, canvas, ctx) => result` and **imports nothing** — `probe.js` re-runs `main()` if anything
 * imports it back, so every helper arrives through `ctx`.
 *
 * The scenario runs three groups of measurements in one page load (one backend — principle II):
 *
 *  1. **Classification, one fault at a time** (`classification`): the product adapter
 *     (`bundle.terrainSource`) is built with an injected `readTile`, so a failure is simulated without
 *     a broken server. Missing tile / rejecting reader / never-settling reader are each asserted to
 *     report `category: "data-unavailable"`, with the fault named by `failure`. Undecodable bytes and
 *     an unparseable manifest are the **reverse controls**: they must be classified as `"decode"`,
 *     i.e. the label is a measurement and not a constant.
 *  2. **A mixed scene** (`mixed`): a real `Scene` + `Globe` on that provider, where a deterministic
 *     subset of the tiles fails (some reject, some hang) and the rest are served by the real static
 *     server. The remaining tiles must keep loading and rendering, the frame loop must keep running
 *     with no stall, and every buffer handed upstream must be finite and inside the dataset's own
 *     vertical range (no NaN, no spike) — whether it carries data or was degraded.
 *  3. **Geometry evidence** (`geometry`, `vertexBuffer`, `frame`): statistics of every delivered
 *     buffer, plus — on the WebGPU path — the floats actually copied back out of the vertex buffer the
 *     terrain draw named, and the canvas-texture readback of the settled frame. The screenshot the
 *     harness takes after the page reports ready is the presentation evidence for both paths.
 *
 * The three failure classes are deliberately exercised through `provider.requestTileGeometry`, which
 * is the same entry point upstream's tile queue uses — `requestTileGeometry` is what
 * `CustomHeightmapTerrainProvider` exposes upstream.
 */
export default async function terrainUnavailableScenario(bundle, canvas, ctx) {
  const { backend, step, buildTerrainScene, renderUntilTilesLoaded } = ctx;

  /** Same origin as the page: the harness serves the repository root (T087's offline rule). */
  const FIXTURE_BASE_URL = "/packages/cesium-webgpu/fixtures";
  const DATASET_ID = "matterhorn-z0-12";
  /** Short enough that the whole scenario stays inside the suite budget, long enough to be a real bound. */
  const TILE_TIMEOUT_MS = 250;
  const NODATA = 65535;

  // ------------------------------------------------------------------------------------------
  // shared plumbing
  // ------------------------------------------------------------------------------------------

  /** `…/matterhorn-z0-12/9/532/124.hgt` → `"9/532/124"`; `null` for anything else (the manifest). */
  const tileKeyOf = (tilePath) => {
    const match = /(\d+)\/(\d+)\/(\d+)\.hgt$/.exec(String(tilePath));
    return match === null ? null : `${match[1]}/${match[2]}/${match[3]}`;
  };

  const fetchBytes = async (tilePath) => {
    const response = await fetch(tilePath);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${tilePath}`);
    return new Uint8Array(await response.arrayBuffer());
  };

  /**
   * The deterministic failure plan of the mixed arm.
   *
   * A stable hash of the tile coordinates (not a random draw, and not a wall-clock choice) means the
   * same tiles fail on every run and on **both** backends, so "the rest keeps rendering" is a
   * reproducible statement rather than a lucky one. Levels below 4 are always served: the coarse
   * ancestors of the whole view are what the camera's ground plane is built from, and breaking them
   * would test "does a broken base LOD render", which is not this task's question.
   */
  const fateOf = (key) => {
    const [level, x, y] = key.split("/").map(Number);
    if (level < 4) return "serve";
    const hash = Math.abs(((level * 73856093) ^ (x * 19349663) ^ (y * 83492791)) | 0) % 4;
    return ["serve", "throw", "hang", "serve"][hash];
  };

  /** Counts + summaries of the samples the adapter handed upstream. */
  const summarise = (value) => {
    // Upstream wraps the adapter's output in a `HeightmapTerrainData` (whose samples live in the
    // `_buffer` it was constructed with), so this is called with either shape. Anything else is
    // reported as an instrument failure instead of throwing the page away.
    const heights = ArrayBuffer.isView(value) ? value : value?._buffer;
    if (!ArrayBuffer.isView(heights)) {
      return { samples: 0, nonFinite: 0, minimum: null, maximum: null, distinctSampleValues: 0, flat: null, instrumentError: `no sample buffer: ${typeof value}` };
    }
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let nonFinite = 0;
    for (const value of heights) {
      if (!Number.isFinite(value)) nonFinite += 1;
      else {
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
      }
    }
    let distinct = 0;
    const seen = new Set();
    for (const value of heights) {
      if (seen.size >= 4) break;
      if (!seen.has(value)) {
        seen.add(value);
        distinct += 1;
      }
    }
    return {
      samples: heights.length,
      nonFinite,
      minimum: nonFinite === heights.length ? null : minimum,
      maximum: nonFinite === heights.length ? null : maximum,
      distinctSampleValues: seen.size,
      flat: seen.size === 1,
    };
  };

  /**
   * Build the product provider with an injected reader, recording every diagnostic and every read.
   *
   * `fates` is consulted per tile; the manifest always comes from the real static server unless the
   * arm deliberately breaks it.
   */
  const buildProvider = async ({ fates = () => "serve", manifestResponse = "real", diagnostics = [], reads = [] }) => {
    const provider = await bundle.terrainSource.createTerrainProvider({
      mode: "fixture",
      datasetId: DATASET_ID,
      fixtureBaseUrl: FIXTURE_BASE_URL,
      tileTimeoutMs: TILE_TIMEOUT_MS,
      onTileDiagnostic: (diagnostic) => diagnostics.push({ ...diagnostic }),
      readTile: (tilePath) => {
        const key = tileKeyOf(tilePath);
        if (key === null) {
          reads.push("<manifest>");
          if (manifestResponse === "throw") throw new Error("simulated manifest fetch failure");
          if (manifestResponse === "garbage") return new TextEncoder().encode("{ this is not json");
          return fetchBytes(tilePath);
        }
        reads.push(key);
        const fate = fates(key);
        if (fate === "throw") return Promise.reject(new Error(`simulated tile fetch failure for ${key}`));
        if (fate === "hang") return new Promise(() => {});
        if (fate === "empty") {
          const samples = new Uint16Array(9409).fill(NODATA);
          return new Uint8Array(samples.buffer);
        }
        if (fate === "short") return new Uint8Array(16);
        return fetchBytes(tilePath);
      },
    });
    return provider;
  };

  /**
   * One tile asked for directly through the provider's own entry point (`requestTileGeometry` — what
   * upstream's tile queue calls). Upstream wraps the adapter's samples in a `HeightmapTerrainData`,
   * which `summarise` unwraps; nothing else ever consumes this one, so the buffer is still there.
   */
  const ask = async (provider, x, y, level) => {
    const data = await provider.requestTileGeometry(x, y, level);
    return { tile: `${level}/${x}/${y}`, ...summarise(data) };
  };

  /** A construction that is expected to be refused: report the *classification*, never the raw error. */
  const refused = async (options) => {
    try {
      await buildProvider(options);
      return { rejected: false, category: null, name: null, message: null };
    } catch (error) {
      return {
        rejected: true,
        category: error?.category ?? null,
        name: error?.name ?? null,
        message: String(error?.message ?? error).slice(0, 200),
      };
    }
  };

  // ------------------------------------------------------------------------------------------
  // 1. classification, one fault at a time — through the product adapter
  // ------------------------------------------------------------------------------------------

  const classification = {};

  {
    // Missing tile. The reader refuses **everything**: if the adapter read first and classified
    // afterwards, this would be `reader-error`. It must not read at all — and it MUST NOT throw.
    const diagnostics = [];
    const reads = [];
    const provider = await buildProvider({ fates: () => "throw", diagnostics, reads });
    const before = reads.length;
    const sample = await ask(provider, 9999, 9999, 9);
    classification.missing = {
      diagnostics,
      readsForTheMissingTile: reads.length - before,
      categories: [...new Set(diagnostics.map((diagnostic) => diagnostic.category))],
      failures: [...new Set(diagnostics.map((diagnostic) => diagnostic.failure))],
      ...sample,
    };
    step("classification-missing", { readsForTheMissingTile: classification.missing.readsForTheMissingTile });
  }

  {
    // A reader that rejects, on a tile that really is committed (so the missing-tile short-circuit
    // cannot be what produced the diagnostic).
    const diagnostics = [];
    const provider = await buildProvider({ fates: () => "throw", diagnostics });
    const sample = await ask(provider, 532, 124, 9);
    classification.readerError = {
      diagnostics,
      categories: [...new Set(diagnostics.map((diagnostic) => diagnostic.category))],
      failures: [...new Set(diagnostics.map((diagnostic) => diagnostic.failure))],
      ...sample,
    };
    step("classification-reader-error", { failures: classification.readerError.failures });
  }

  {
    // A reader that never settles: the timeout is the only thing that can end it, and it MUST end in
    // a classified degradation rather than in a page that waits forever.
    const diagnostics = [];
    const provider = await buildProvider({ fates: () => "hang", diagnostics });
    const started = performance.now();
    const sample = await ask(provider, 532, 124, 9);
    classification.timeout = {
      diagnostics,
      elapsedMs: Math.round(performance.now() - started),
      categories: [...new Set(diagnostics.map((diagnostic) => diagnostic.category))],
      failures: [...new Set(diagnostics.map((diagnostic) => diagnostic.failure))],
      ...sample,
    };
    step("classification-timeout", { elapsedMs: classification.timeout.elapsedMs });
  }

  {
    // A well-formed tile with no valid sample at all ("empty"): readable, decodable, and still "no data".
    const diagnostics = [];
    const provider = await buildProvider({ fates: () => "empty", diagnostics });
    const sample = await ask(provider, 532, 124, 9);
    classification.empty = {
      diagnostics,
      categories: [...new Set(diagnostics.map((diagnostic) => diagnostic.category))],
      failures: [...new Set(diagnostics.map((diagnostic) => diagnostic.failure))],
      ...sample,
    };
  }

  {
    // REVERSE CONTROL (1/2): bytes that were read but cannot be decoded. If this came back as
    // "data-unavailable" too, then "data-unavailable" would carry no information.
    const diagnostics = [];
    const provider = await buildProvider({ fates: () => "short", diagnostics });
    const sample = await ask(provider, 532, 124, 9);
    classification.decode = {
      diagnostics,
      categories: [...new Set(diagnostics.map((diagnostic) => diagnostic.category))],
      failures: [...new Set(diagnostics.map((diagnostic) => diagnostic.failure))],
      ...sample,
    };
    step("classification-decode", { categories: classification.decode.categories });
  }

  // REVERSE CONTROL (2/2): the two provider-level refusals, which must be classified differently from
  // each other — an unreachable dataset is "data unavailable", an unparseable one is a decode fault.
  classification.refused = {
    unparseableManifest: await refused({ manifestResponse: "garbage" }),
    unreachableManifest: await refused({ manifestResponse: "throw" }),
  };
  step("classification-refused", {
    unparseableManifest: classification.refused.unparseableManifest.category,
    unreachableManifest: classification.refused.unreachableManifest.category,
  });

  let dataset = null;
  try {
    dataset = JSON.parse(new TextDecoder().decode(await fetchBytes(`${FIXTURE_BASE_URL}/${DATASET_ID}/manifest.json`)));
  } catch (error) {
    dataset = { error: String(error?.message ?? error).slice(0, 200) };
  }

  // ------------------------------------------------------------------------------------------
  // 2. the mixed scene: part of the tiles fail, the rest keep rendering
  // ------------------------------------------------------------------------------------------

  const mixedDiagnostics = [];
  const mixedReads = [];
  const delivered = [];
  const mixedFates = { serve: 0, throw: 0, hang: 0 };
  const plans = new Map();
  const fates = (key) => {
    if (!plans.has(key)) {
      const fate = fateOf(key);
      plans.set(key, fate);
      mixedFates[fate] += 1;
    }
    return plans.get(key);
  };

  const provider = await buildProvider({
    fates,
    diagnostics: mixedDiagnostics,
    reads: mixedReads,
  });

  // The adapter's own callback is wrapped so that *what upstream received* is measured at the moment
  // it was produced: the degraded flat buffers and the real committed buffers are counted apart, and
  // the measurement cannot race with the tile pipeline releasing a consumed buffer.
  const innerCallback = provider._callback;
  const deliveredFrom = innerCallback === undefined ? provider.requestTileGeometry.bind(provider) : innerCallback;
  const wrapped = async (x, y, level, ...rest) => {
    const heights = await deliveredFrom(x, y, level, ...rest);
    delivered.push({ tile: `${level}/${x}/${y}`, ...summarise(heights) });
    return heights;
  };
  if (innerCallback === undefined) {
    provider.requestTileGeometry = wrapped;
  } else {
    provider._callback = wrapped;
  }

  const terrain = await buildTerrainScene(bundle, canvas, {
    provider,
    readback: true,
    bufferReadback: true,
  });

  // Frames rendered **while the failures are still happening**: the loop must keep advancing and the
  // pipeline must keep delivering tiles.
  const early = [];
  for (let frame = 0; frame < 6; frame += 1) {
    await terrain.renderFrames(1, 16);
    early.push({
      frames: terrain.frameTimesMs.length,
      diagnostics: mixedDiagnostics.length,
      delivered: delivered.length,
      reads: mixedReads.length,
    });
  }
  step("early-frames", early[early.length - 1]);

  const load = await renderUntilTilesLoaded(terrain, 20000);
  step("tiles-loaded", load);

  terrain.resetDrawLog();
  await terrain.renderFrames(4, 16);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const late = {
    frames: terrain.frameTimesMs.length,
    diagnostics: mixedDiagnostics.length,
    delivered: delivered.length,
    reads: mixedReads.length,
  };

  // ------------------------------------------------------------------------------------------
  // 3. geometry evidence: provider-level statistics + the GPU's own vertex buffer
  // ------------------------------------------------------------------------------------------

  const realTiles = delivered.filter((entry) => entry.flat !== true);
  const degradedTiles = delivered.filter((entry) => entry.flat === true);
  const geometry = {
    delivered: delivered.length,
    realTiles: realTiles.length,
    degradedTiles: degradedTiles.length,
    nonFiniteSamples: delivered.reduce((total, entry) => total + entry.nonFinite, 0),
    minimum: delivered.length === 0 ? null : Math.min(...delivered.filter((entry) => entry.minimum !== null).map((entry) => entry.minimum)),
    maximum: delivered.length === 0 ? null : Math.max(...delivered.filter((entry) => entry.maximum !== null).map((entry) => entry.maximum)),
    // The outliers a spike/hole would produce: how far a delivered tile's own range reaches.
    widestDegradedRange: degradedTiles.length === 0 ? 0 : Math.max(...degradedTiles.map((entry) => entry.maximum - entry.minimum)),
    sample: delivered.slice(0, 6),
  };

  let vertexBuffer = null;
  const firstDraw = terrain.drawLog.find((entry) => (entry.rawVertexBuffers ?? []).length > 0);
  if (terrain.bufferReadback !== null && firstDraw !== undefined) {
    try {
      const stride = firstDraw.rawGpuVertexBuffers?.[0]?.arrayStride ?? 28;
      // 1024 floats is a whole tile row of a 44 B vertex; reading the whole buffer would prove nothing
      // more about NaN than this sample does, and the sample is what the draw actually uses.
      const floats = await terrain.bufferReadback.readFloats(firstDraw.rawVertexBuffers[0].buffer, 1024);
      const finite = floats.filter((value) => Number.isFinite(value));
      vertexBuffer = {
        ok: true,
        arrayStride: stride,
        floatsRead: floats.length,
        nonFinite: floats.length - finite.length,
        minimum: finite.length === 0 ? null : Math.min(...finite),
        maximum: finite.length === 0 ? null : Math.max(...finite),
        head: floats.slice(0, 8).map((value) => Number(value.toFixed(4))),
      };
    } catch (error) {
      vertexBuffer = { ok: false, reason: String(error?.message ?? error).slice(0, 240) };
    }
  } else {
    vertexBuffer = {
      ok: false,
      reason:
        terrain.bufferReadback === null
          ? "the buffer readback is a WebGPU-path instrument, so the WebGL2 run has no GPU vertex copy"
          : "no terrain draw with a vertex buffer was recorded after the tiles settled",
    };
  }

  let frame = null;
  if (terrain.readback !== null) {
    terrain.readback.arm();
    await terrain.renderFrames(1, 16);
    frame = await terrain.readback.read();
  }

  const result = {
    datasetId: DATASET_ID,
    tileTimeoutMs: TILE_TIMEOUT_MS,
    tileTimeoutDefaultMs: bundle.terrainSource.DEFAULT_TILE_TIMEOUT_MS,
    dataset: dataset === null ? null : { tileCount: dataset.tiles?.length ?? null, noDataValue: dataset.noDataValue ?? null, levels: dataset.levels ?? null },
    classification,
    mixed: {
      plan: { ...mixedFates, tilesAsked: mixedReads.length },
      diagnostics: mixedDiagnostics,
      categories: [...new Set(mixedDiagnostics.map((diagnostic) => diagnostic.category))],
      failures: [...new Set(mixedDiagnostics.map((diagnostic) => diagnostic.failure))],
      failureCounts: mixedDiagnostics.reduce((counts, diagnostic) => ({ ...counts, [diagnostic.failure]: (counts[diagnostic.failure] ?? 0) + 1 }), {}),
      unclassifiedDiagnostics: mixedDiagnostics.filter((diagnostic) => typeof diagnostic.category !== "string" || typeof diagnostic.failure !== "string" || diagnostic.level === undefined).length,
    },
    progress: { early, late, framesRendered: terrain.frameTimesMs.length },
    scene: {
      tilesLoaded: terrain.scene.globe.tilesLoaded === true,
      load,
      frameErrors: terrain.frameErrors,
      renderErrors: terrain.renderErrors,
      frameTimes: {
        count: terrain.frameTimesMs.length,
        maximumMs: terrain.frameTimesMs.length === 0 ? null : Number(Math.max(...terrain.frameTimesMs).toFixed(2)),
        p95Ms: terrain.frameTimesMs.length === 0 ? null : Number([...terrain.frameTimesMs].sort((a, b) => a - b)[Math.floor(terrain.frameTimesMs.length * 0.95)].toFixed(2)),
        totalMs: Number(terrain.frameTimesMs.reduce((total, value) => total + value, 0).toFixed(2)),
      },
      terrainProviderName: terrain.scene.terrainProvider?.constructor?.name ?? null,
    },
    geometry,
    vertexBuffer,
    frame,
    backend,
  };
  step("summary", {
    categories: result.mixed.categories,
    failures: result.mixed.failures,
    delivery: { real: geometry.realTiles, degraded: geometry.degradedTiles },
    nonFiniteSamples: geometry.nonFiniteSamples,
    tilesLoaded: result.scene.tilesLoaded,
  });
  return result;
}
