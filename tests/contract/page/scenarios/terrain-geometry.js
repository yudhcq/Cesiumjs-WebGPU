/**
 * `terrain-geometry` — T093 / FR-016: **geometric** defects (seam cracks, holes, wrong occlusion,
 * anomalous vertices) MUST be caught by **numerical** assertions, never by looking at a picture.
 *
 * ## What this scenario measures, and why each measurement is the one that can fail
 *
 * The page publishes measurements only; every threshold lives in `tests/visual/terrain-geometry.spec.mjs`
 * (and is recorded, with its source, in `artifacts/terrain-geometry/criteria.json`). Four independent
 * instruments are driven here:
 *
 * 1. **Mesh-level seam agreement** (`seams` / `lodCorners`). The fixture dataset's own sampling rule is
 *    `sampleGrid.filter = "bilinear-in-mercator-source-pixels-at-target-cell-centres"` and
 *    `orientation = "row-major; row 0 is the northernmost sample, column 0 the westernmost"`, so two
 *    tiles that share an edge sample **the same geographic points** along it. Any disagreement between
 *    the two edge profiles is, in metres, exactly the step (the crack) the rasteriser will show there.
 *    The same argument gives the parent/child corner agreement: a child tile's four corners are four of
 *    its parent's samples. This is the instrument that catches "人为删掉一块瓦片": the adapter's
 *    documented degradation for unreadable data is a **flat buffer at the dataset floor**
 *    (`src/terrain/source.ts` `degrade()`), i.e. a tile whose real geometry is gone.
 *
 * 2. **Per-tile geometry statistics** (`tiles[].samples`). Every probed tile's finite range is checked
 *    against the **dataset's own per-level declaration** (`manifest.levelSummary[level].minHeight/
 *    maxHeight` — an interval the committed data itself publishes, not a number invented here), plus
 *    finiteness, non-flatness and the largest neighbour-sample step.
 *
 * 3. **Draw / triangle accounting** (`draws`). Per frame: draw calls, index counts, triangles, and the
 *    number of distinct dynamic uniform slots (one slot per tile), from instruments that do not share
 *    code: the replacement `Context`'s own pass records (`context.lastFramePasses()`), the
 *    `GPURenderPassEncoder.drawIndexed` wrapper (`buildTerrainScene({pipelineLog:true})`), the
 *    `Context.draw` wrapper (`drawLog`), and — on the WebGL2 path — the real
 *    `WebGL2RenderingContext.drawElements/drawArrays` calls.
 *
 * 4. **Presentation statistics** (the harness screenshot; analysed by the spec). Needed because
 *    `docs/gate-g7-conclusion.md` §0 measured that this machine's canvas depth face is
 *    `depth24plus-stencil8` and **cannot be copied**, so "pixels at depth discontinuities" is not
 *    measurable here at all; the spec says so explicitly instead of pretending otherwise.
 *
 * ## Deliberate non-measurements (stated so that "absent" is never read as "passed")
 *
 * - The canvas depth read-back is **not** attempted: `readCanvasDepth` is a structured "not measurable"
 *   on this machine (G-7 §0) and a green run would only prove the instrument is absent.
 * - Brightness/height correlation is **not** asserted: the MVP renders the surface as
 *   `baseColor × lightColor` (`fade = 0`, T094) — the frame is a single-colour field, so a
 *   height-dependent pixel statistic would be meaningless.
 *
 * ## Injection (the counter-example arm)
 *
 * `?inject=` is read through `ctx.params` and lets **one and the same code path** be run with a
 * deliberately damaged dataset. Nothing in this file is edited to produce a counter-example:
 *
 *   `fail:<level>/<x>/<y>`   that tile's read rejects   → adapter degrades it to a flat floor tile
 *   `zeros:<level>/<x>/<y>`  that tile reads all-zero bytes → decodes to −32768 m **legal** samples
 *                            (`manifest.sampleGrid.noDataRule`: RGB(0,0,0) is legal, never no-data)
 *   `fail-level:<L>`         every tile of level `L` rejects
 *   `camera-edge`            the fixed camera is moved onto the dataset's western edge, so part of the
 *                            frame has no dataset coverage at all (a hole that really is a hole)
 *
 * The default (`inject` absent) is the green run the suite asserts on.
 *
 * ## Module rules
 *
 * Scenario modules import **nothing** (`probe.js` runs `main()` on import); every helper arrives
 * through `ctx`. Default export: `(bundle, canvas, ctx) => result`, published by the page as
 * `report.result["terrain-geometry"]`.
 */
export default async function terrainGeometryScenario(bundle, canvas, ctx) {
  const { backend, params, step, buildTerrainScene, renderUntilTilesLoaded, heightmapTileRectangle } = ctx;

  const DATASET_ID = "matterhorn-z0-12";
  const FIXTURE_BASE_URL = "/packages/cesium-webgpu/fixtures";
  const DATASET_DIRECTORY = `${FIXTURE_BASE_URL}/${DATASET_ID}`;
  /** The value the dataset uses for "no sample" (one of the two documented sentinels). */
  const NODATA = 65535;
  /** Probe budget: how many tile grids are read back through the provider in one run. */
  const PROBE_LIMIT = Number(params.get("probes") ?? 40);
  /** Rendering budget while waiting for the tile tree to settle. */
  const LOAD_BUDGET_MS = Number(params.get("budget") ?? 30000);
  /** The fixed viewpoint of every other terrain suite (T087/T088): inside the dataset, near the summit. */
  const FIXED_CAMERA = { longitude: 6.8652, latitude: 45.8326, height: 24000, heading: 0, pitch: -50, roll: 0 };

  // ------------------------------------------------------------------------------------------
  // the dataset's own declarations — the external source of every geometry interval
  // ------------------------------------------------------------------------------------------

  const manifest = await (await fetch(`${DATASET_DIRECTORY}/manifest.json`)).json();
  const availableTiles = new Set((manifest.tiles ?? []).map((tile) => `${tile.level}/${tile.x}/${tile.y}`));
  const levelBounds = new Map(
    (manifest.levelSummary ?? []).map((summary) => [summary.level, { level: summary.level, minimum: summary.minHeight, maximum: summary.maxHeight, tiles: summary.tiles }]),
  );
  const grid = { width: manifest.sampleWidth, height: manifest.sampleHeight };
  const datasetFrame = {
    datasetId: DATASET_ID,
    datasetDirectory: DATASET_DIRECTORY,
    rectangle: manifest.rectangle ?? null,
    sampleWidth: grid.width,
    sampleHeight: grid.height,
    orientation: manifest.sampleGrid?.orientation ?? null,
    filter: manifest.sampleGrid?.filter ?? null,
    noDataValue: manifest.noDataValue ?? NODATA,
    heightOffsetMetres: manifest.heightOffsetMetres ?? null,
    tileCount: manifest.tileCount ?? availableTiles.size,
    levels: manifest.levels ?? null,
    levelSummary: (manifest.levelSummary ?? []).map((summary) => ({ level: summary.level, tiles: summary.tiles, minimum: summary.minHeight, maximum: summary.maxHeight })),
    /** The dataset-wide interval, used as the outer bound of the per-tile assertion. */
    globalMinimum: Math.min(...(manifest.levelSummary ?? [{ minHeight: 0 }]).map((summary) => summary.minHeight)),
    globalMaximum: Math.max(...(manifest.levelSummary ?? [{ maxHeight: 0 }]).map((summary) => summary.maxHeight)),
  };
  step("dataset-frame", { datasetId: DATASET_ID, tiles: availableTiles.size, grid: `${grid.width}x${grid.height}` });

  // ------------------------------------------------------------------------------------------
  // the injection plan (counter-example arm) — a value of the run, never an edit of this file
  // ------------------------------------------------------------------------------------------

  const injectionOf = (spec) => {
    const text = String(spec ?? "").trim();
    if (text.length === 0) return { kind: "none", effect: null, key: null, level: null, describes: "green run: the committed dataset is served unchanged" };
    const [kind, argument = ""] = text.split(":");
    if (kind === "fail" || kind === "zeros" || kind === "spike") {
      if (!/^\d+\/\d+\/\d+$/.test(argument)) throw new Error(`inject=${text}: expected ${kind}:<level>/<x>/<y>`);
      const describes = {
        fail: `the reads of tile ${argument} reject, so the adapter degrades it to a flat floor tile (its real geometry is deleted)`,
        zeros: `tile ${argument} reads all-zero bytes, which are *legal* samples at -32768 m (never no-data)`,
        spike: `every 32nd sample of tile ${argument} is moved to the coding floor, i.e. a spike field with legal-looking values`,
      }[kind];
      return { kind, effect: kind, key: argument, level: Number(argument.split("/")[0]), describes };
    }
    if (kind === "fail-level") {
      return { kind, effect: "fail", key: null, level: Number(argument), describes: `every read of level ${argument} rejects` };
    }
    if (kind === "camera-edge") return { kind, effect: null, key: null, level: null, describes: "the camera is moved onto the dataset's western edge (part of the frame has no coverage)" };
    if (kind === "no-coverage") {
      return {
        kind,
        effect: null,
        key: null,
        level: null,
        describes:
          "every tile answers 'not available', i.e. the dataset is removed entirely: with no tile at any level upstream has no geometry to draw, which is the only way this product can present a hole in the frame (missing data degrades to a flat tile instead — FR-004)",
      };
    }
    throw new Error(`inject=${text}: unknown injection (fail:KEY | zeros:KEY | spike:KEY | fail-level:L | camera-edge | no-coverage)`);
  };
  const injection = injectionOf(params.get("inject"));
  const interprets = (key) => {
    if (injection.effect === null || key === null) return false;
    if (injection.key !== null) return key === injection.key;
    return Number(key.split("/")[0]) === injection.level;
  };
  /** The camera for this run: the fixed viewpoint, or the edge ablation. */
  const camera =
    injection.kind === "camera-edge"
      ? { ...FIXED_CAMERA, longitude: (manifest.rectangle?.west ?? FIXED_CAMERA.longitude) + 0.02 }
      : FIXED_CAMERA;

  // ------------------------------------------------------------------------------------------
  // the provider: the product adapter with an injected reader (T087/T088's method)
  // ------------------------------------------------------------------------------------------

  const tileKeyOf = (tilePath) => {
    const match = /(\d+)\/(\d+)\/(\d+)\.hgt$/.exec(String(tilePath));
    return match === null ? null : `${match[1]}/${match[2]}/${match[3]}`;
  };
  const fetchBytes = async (tilePath) => {
    const response = await fetch(tilePath);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${tilePath}`);
    return new Uint8Array(await response.arrayBuffer());
  };

  const reads = [];
  const injectedReads = [];
  const diagnostics = [];
  const provider = await bundle.terrainSource.createTerrainProvider({
    mode: "fixture",
    datasetId: DATASET_ID,
    fixtureBaseUrl: FIXTURE_BASE_URL,
    credit: "Terrain Tiles (terrarium) by Mapzen/Joerd (AWS Open Data) — fixed dataset matterhorn-z0-12",
    onTileDiagnostic: (diagnostic) => diagnostics.push({ ...diagnostic }),
    readTile: (tilePath) => {
      const key = tileKeyOf(tilePath);
      if (key === null) {
        reads.push("<manifest>");
        return fetchBytes(tilePath);
      }
      reads.push(key);
      if (!interprets(key)) return fetchBytes(tilePath);
      injectedReads.push(key);
      if (injection.effect === "fail") return Promise.reject(new Error(`T093 counter-example: the geometry of tile ${key} was deleted`));
      if (injection.effect === "spike") {
        return fetchBytes(tilePath).then((bytes) => {
          const samples = new Uint16Array(bytes.buffer.slice(0, grid.width * grid.height * 2));
          for (let index = 0; index < samples.length; index += 32) samples[index] = 0;
          return new Uint8Array(samples.buffer);
        });
      }
      // All-zero bytes: a legal sample per the dataset's own `noDataRule`, decoding to the floor of the
      // coding range (-32768 m + 0). Deliberately *not* the no-data sentinel, so the adapter cannot
      // classify it as unavailable and MUST hand it to the rasteriser as if it were terrain.
      return new Uint8Array(grid.width * grid.height * 2);
    },
  });

  /** Every tile the **globe** asked the product provider for (direct probes are excluded). */
  const globeRequests = [];
  // `no-coverage` removes the dataset at the availability level too: the quadtree then has nothing to
  // load anywhere, which is the one input under which this product draws no surface at all.
  if (injection.kind === "no-coverage") provider.getTileDataAvailable = () => false;
  const originalRequestTileGeometry = provider.requestTileGeometry.bind(provider);
  let probing = false;
  provider.requestTileGeometry = (x, y, level, request) => {
    if (!probing) globeRequests.push(`${level}/${x}/${y}`);
    return originalRequestTileGeometry(x, y, level, request);
  };
  step("provider-ready", { injection: injection.describes, availableTiles: availableTiles.size });

  // ------------------------------------------------------------------------------------------
  // the WebGL2 draw instrument: the real GL calls (the WebGPU instruments do not exist here)
  // ------------------------------------------------------------------------------------------

  const instrumentGlDraws = (scene) => {
    const gl = scene?.context?._gl ?? null;
    if (gl === null || typeof gl.drawElements !== "function" || typeof gl.drawArrays !== "function") {
      return { installed: false, reason: "the GL context is not reachable as scene.context._gl on this path", snapshot: () => null };
    }
    const counts = { drawElements: 0, drawArrays: 0, drawElementsInstanced: 0, drawArraysInstanced: 0, indexCount: 0, vertexCount: 0, triangles: 0, modes: {}, indexCountHistogram: {} };
    const modeName = (mode) => ({ 0: "POINTS", 1: "LINES", 3: "LINE_STRIP", 4: "TRIANGLES", 5: "TRIANGLE_STRIP", 6: "TRIANGLE_FAN" }[mode] ?? `0x${Number(mode).toString(16)}`);
    const count = (name, mode, size) => {
      counts[name] += 1;
      const label = modeName(mode);
      counts.modes[label] = (counts.modes[label] ?? 0) + 1;
      if (size !== null) {
        if (name.startsWith("drawElements")) {
          counts.indexCount += size;
          // Per-draw mesh sizes: the aggregate alone cannot tell a full tile mesh from a partial one.
          const key = String(size);
          counts.indexCountHistogram[key] = (counts.indexCountHistogram[key] ?? 0) + 1;
        } else counts.vertexCount += size;
        if (label === "TRIANGLES") counts.triangles += size / 3;
      }
    };
    const patch = (name, sizeIndex) => {
      const original = gl[name];
      if (typeof original !== "function") return false;
      gl[name] = function instrumented(...args) {
        count(name, args[0], typeof args[sizeIndex] === "number" ? args[sizeIndex] : null);
        return original.apply(this, args);
      };
      return true;
    };
    const patched = {
      drawElements: patch("drawElements", 1),
      drawArrays: patch("drawArrays", 2),
      drawElementsInstanced: patch("drawElementsInstanced", 1),
      drawArraysInstanced: patch("drawArraysInstanced", 2),
    };
    const snapshot = () => ({
      ok: true,
      source: "WebGL2RenderingContext.drawElements/drawArrays (wrapped before the first frame)",
      patched,
      drawCalls: counts.drawElements + counts.drawArrays + counts.drawElementsInstanced + counts.drawArraysInstanced,
      indexedDrawCalls: counts.drawElements + counts.drawElementsInstanced,
      triangles: counts.triangles,
      indexCount: counts.indexCount,
      vertexCount: counts.vertexCount,
      modes: { ...counts.modes },
      /** indexCount → how many draws used it: the per-draw mesh sizes, not just their sum. */
      indexCountHistogram: { ...counts.indexCountHistogram },
      largestIndexCount: Math.max(0, ...Object.keys(counts.indexCountHistogram).map(Number)),
    });
    const reset = () => {
      for (const name of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]) counts[name] = 0;
      counts.indexCount = 0;
      counts.vertexCount = 0;
      counts.triangles = 0;
      counts.modes = {};
      counts.indexCountHistogram = {};
    };
    return { installed: true, reason: null, snapshot, reset, patched };
  };

  // ------------------------------------------------------------------------------------------
  // scene + settle
  // ------------------------------------------------------------------------------------------

  const terrain = await buildTerrainScene(bundle, canvas, {
    provider,
    camera,
    pipelineLog: true,
    recordFrames: 40,
  });
  const glInstrument = backend === "webgl2" ? instrumentGlDraws(terrain.scene) : { installed: false, reason: "not the WebGL2 path", snapshot: () => null, reset: () => {} };
  // With the dataset removed there is nothing to converge to; waiting out the full budget would only
  // spend the suite's time on a known-empty tile tree.
  const load = await renderUntilTilesLoaded(terrain, injection.kind === "no-coverage" ? 8000 : LOAD_BUDGET_MS);
  step("tiles-loaded", load);

  // The settled frame is the one every draw assertion reads: forget the opening frames' draws (they
  // draw coarse ancestors whose tiles are a different set — see `resetDrawLog`'s note), then render
  // **one** frame so the logs hold that frame and not a mixture of two.
  const surface = terrain.scene.globe?._surface ?? null;
  /** The tiles the globe says it is rendering, snapshotted from the frame that just finished. */
  const snapshotRenderedTiles = () =>
    [...new Set((surface?._tilesToRender ?? []).map((tile) => `${tile.level ?? tile._level}/${tile.x ?? tile._x}/${tile.y ?? tile._y}`))];
  terrain.resetDrawLog();
  glInstrument.reset?.();
  await terrain.renderFrames(1, 24);
  const renderedKeysForFrame = snapshotRenderedTiles();
  const context = terrain.scene.context;
  const passes = typeof context.lastFramePasses === "function" ? context.lastFramePasses().map((pass) => ({ index: pass.index, keyText: pass.keyText, gpuPassCount: pass.gpuPassCount, clearOps: pass.clearOps, drawOps: pass.drawOps })) : null;
  const drawBindings = (terrain.drawBindings ?? []).map((entry) => ({
    indexCount: entry.indexCount,
    instanceCount: entry.instanceCount,
    pipelineLabel: entry.pipelineLabel,
    vertexBufferCount: (entry.vertexBuffers ?? []).filter(Boolean).length,
    hasIndexBuffer: entry.indexBuffer !== null,
    dynamicOffsets: (entry.bindGroups ?? []).filter(Boolean).map((group) => (group.offsets === null ? null : [...group.offsets])),
  }));
  const drawLog = (terrain.drawLog ?? []).map((entry) => ({
    commandName: entry.commandName,
    count: entry.count,
    topology: entry.renderState?.topology ?? null,
    numberOfVertices: entry.vertexArray?.numberOfVertices ?? null,
    vertexBuffers: (entry.rawVertexBuffers ?? []).length,
    indexBuffer: entry.rawIndexBuffer === null || entry.rawIndexBuffer === undefined ? null : true,
    tileRectangle: entry.uniformValues?.u_tileRectangle ?? null,
    minMaxHeight: entry.uniformValues?.u_minMaxHeight ?? null,
    center3D: entry.uniformValues?.u_center3D ?? null,
    frame: entry.frame,
  }));
  const glFrame = glInstrument.snapshot?.() ?? null;

  // Leave a presented frame on the canvas: the harness screenshots it right after `ready`.
  await terrain.renderFrames(2, 16);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const renderedKeysForPresentation = snapshotRenderedTiles();

  // ------------------------------------------------------------------------------------------
  // mesh-level probes: the tile grids the draw consumes, read back through the product provider
  // ------------------------------------------------------------------------------------------

  const renderedKeys = [...new Set([...renderedKeysForFrame, ...renderedKeysForPresentation])];
  /**
   * Rendered tiles that are **not** part of the committed dataset. Upstream upsamples such a tile from
   * its parent (that is why the surface has no holes even where the dataset has none), so the data
   * behind it is the parent's grid — which is why every rendered tile's parent is probed below.
   */
  const upsampledKeys = renderedKeys.filter((key) => !availableTiles.has(key));

  /** The probe set: every rendered tile, plus the neighbours/parents that make its seams checkable. */
  const parentKeyOf = (key) => {
    const [level, x, y] = key.split("/").map(Number);
    if (level === 0) return null;
    return `${level - 1}/${x >> 1}/${y >> 1}`;
  };
  const neighboursOf = (key) => {
    const [level, x, y] = key.split("/").map(Number);
    return [`${level}/${x + 1}/${y}`, `${level}/${x}/${y + 1}`];
  };
  const wanted = new Set(renderedKeys);
  for (const key of renderedKeys) {
    for (const candidate of [...neighboursOf(key), parentKeyOf(key)]) {
      if (candidate !== null && availableTiles.has(candidate)) wanted.add(candidate);
    }
  }
  const probeKeys = [...wanted].filter((key) => availableTiles.has(key)).slice(0, PROBE_LIMIT).sort((a, b) => {
    const left = a.split("/").map(Number);
    const right = b.split("/").map(Number);
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  });
  /** Tiles dropped by the probe cap. `upsampledKeys` is the other reason a rendered tile is not probed. */
  const omittedByCap = wanted.size - probeKeys.length;

  /**
   * One tile's samples, summarised. `edges` keeps the four profiles the seam comparison needs; the
   * grids themselves stay in the page (the report carries numbers, not megabytes).
   */
  const grids = new Map();
  const summarise = (key, value) => {
    const heights = ArrayBuffer.isView(value) ? value : value?._buffer;
    if (!ArrayBuffer.isView(heights)) return { tile: key, ok: false, reason: `no sample buffer (${typeof value})` };
    if (heights.length !== grid.width * grid.height) {
      return { tile: key, ok: false, reason: `sample count ${heights.length} does not match the dataset's ${grid.width}x${grid.height} grid` };
    }
    grids.set(key, heights);
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let nonFinite = 0;
    let maxStep = 0;
    const seen = new Set();
    for (let index = 0; index < heights.length; index += 1) {
      const value_ = heights[index];
      if (!Number.isFinite(value_)) {
        nonFinite += 1;
        continue;
      }
      if (value_ < minimum) minimum = value_;
      if (value_ > maximum) maximum = value_;
      sum += value_;
      if (seen.size < 8) seen.add(value_);
      const row = Math.floor(index / grid.width);
      const column = index % grid.width;
      if (column > 0) maxStep = Math.max(maxStep, Math.abs(value_ - heights[index - 1]));
      if (row > 0) maxStep = Math.max(maxStep, Math.abs(value_ - heights[index - grid.width]));
    }
    const bounds = levelBounds.get(Number(key.split("/")[0])) ?? null;
    return {
      tile: key,
      ok: true,
      samples: heights.length,
      nonFinite,
      minimum: nonFinite === heights.length ? null : minimum,
      maximum: nonFinite === heights.length ? null : maximum,
      mean: nonFinite === heights.length ? null : Number((sum / (heights.length - nonFinite)).toFixed(4)),
      distinctSampleValues: seen.size,
      flat: seen.size === 1,
      maxNeighbourStepMetres: Number(maxStep.toFixed(4)),
      declared: bounds === null ? null : { minimum: bounds.minimum, maximum: bounds.maximum },
      withinDeclaredInterval: bounds === null || nonFinite === heights.length ? null : minimum >= bounds.minimum && maximum <= bounds.maximum,
    };
  };

  probing = true;
  const tiles = [];
  for (const key of probeKeys) {
    const [level, x, y] = key.split("/").map(Number);
    let data;
    try {
      data = await provider.requestTileGeometry(x, y, level);
    } catch (error) {
      tiles.push({ tile: key, ok: false, reason: `requestTileGeometry rejected: ${String(error?.message ?? error).slice(0, 160)}` });
      continue;
    }
    tiles.push({ ...summarise(key, data), rendered: renderedKeys.includes(key), rectangle: heightmapTileRectangle(x, y, level) });
  }
  probing = false;
  step("tiles-probed", { probed: tiles.length, omittedByCap, upsampled: upsampledKeys.length });

  // ------------------------------------------------------------------------------------------
  // seams: shared edges of same-level neighbours, and corners shared with the parent level
  // ------------------------------------------------------------------------------------------

  const edgeProfile = (key, side) => {
    const heights = grids.get(key);
    if (heights === undefined) return null;
    const width = grid.width;
    const height = grid.height;
    const row = (index) => heights.subarray(index * width, (index + 1) * width);
    const column = (index) => {
      const out = new Float32Array(height);
      for (let r = 0; r < height; r += 1) out[r] = heights[r * width + index];
      return out;
    };
    if (side === "east") return column(width - 1);
    if (side === "west") return column(0);
    if (side === "north") return row(0);
    if (side === "south") return row(height - 1);
    return null;
  };
  const difference = (left, right) => {
    let maximum = 0;
    let sum = 0;
    let mismatch = 0;
    for (let index = 0; index < left.length; index += 1) {
      const delta = Math.abs(left[index] - right[index]);
      if (!Number.isFinite(delta)) return { sharedSamples: left.length, maxAbsDiffMetres: null, meanAbsDiffMetres: null, mismatchSamples: null, nonFinite: true };
      if (delta > maximum) maximum = delta;
      sum += delta;
      if (delta > 0) mismatch += 1;
    }
    return {
      sharedSamples: left.length,
      maxAbsDiffMetres: Number(maximum.toFixed(4)),
      meanAbsDiffMetres: Number((sum / left.length).toFixed(4)),
      mismatchSamples: mismatch,
    };
  };

  /**
   * The local scale the seam step has to be read against: the largest sample-to-sample step **within the
   * last cell** of a compared edge, on either side. The dataset samples at cell centres
   * (`tools/build-terrain-fixture.mjs:605-607`), so adjoining tiles' edge profiles are one cell apart
   * geographically; a step of that order is the sampling convention, while a step orders of magnitude
   * larger is a crack.
   */
  const edgeStepScale = (key, side) => {
    const heights = grids.get(key);
    if (heights === undefined) return null;
    const width = grid.width;
    const height = grid.height;
    if (side === "north" || side === "south") {
      const row = side === "north" ? 0 : height - 1;
      let maximum = 0;
      for (let column = 1; column < width; column += 1) maximum = Math.max(maximum, Math.abs(heights[row * width + column] - heights[row * width + column - 1]));
      return Number(maximum.toFixed(4));
    }
    const column = side === "west" ? 0 : width - 1;
    let maximum = 0;
    for (let row = 1; row < height; row += 1) maximum = Math.max(maximum, Math.abs(heights[row * width + column] - heights[(row - 1) * width + column]));
    return Number(maximum.toFixed(4));
  };

  const seams = [];
  const probed = new Set(probeKeys.filter((key) => grids.has(key)));
  for (const key of probed) {
    const [level, x, y] = key.split("/").map(Number);
    const east = `${level}/${x + 1}/${y}`;
    if (probed.has(east)) {
      seams.push({
        axis: "east-west",
        left: key,
        right: east,
        ...difference(edgeProfile(key, "east"), edgeProfile(east, "west")),
        localStepScale: Math.max(edgeStepScale(key, "east") ?? 0, edgeStepScale(east, "west") ?? 0),
      });
    }
    const south = `${level}/${x}/${y + 1}`;
    if (probed.has(south)) {
      seams.push({
        axis: "north-south",
        left: key,
        right: south,
        ...difference(edgeProfile(key, "south"), edgeProfile(south, "north")),
        localStepScale: Math.max(edgeStepScale(key, "south") ?? 0, edgeStepScale(south, "north") ?? 0),
      });
    }
  }
  for (const seam of seams) {
    seam.rendered = renderedKeys.includes(seam.left) && renderedKeys.includes(seam.right);
    seam.injected = interprets(seam.left) || interprets(seam.right);
    // How many cells of local relief the step is worth: 1 means "the sampling convention", ≫1 means crack.
    seam.stepInLocalCells = seam.localStepScale === 0 || seam.maxAbsDiffMetres === null ? null : Number((seam.maxAbsDiffMetres / seam.localStepScale).toFixed(3));
  }

  /**
   * Parent/child corner agreement. A child tile's corner is one of its parent's samples: child
   * `(2x + cx, 2y + cy)` maps its row `r ∈ {0, last}` to the parent's row `cy * mid + (r === 0 ? 0 : mid)`
   * and its column `c` the same way, with `mid = (grid.width - 1) / 2`. The corner is the same
   * geographic point in both grids, so the two samples must agree.
   */
  const mid = (grid.width - 1) / 2;
  const lodCorners = [];
  for (const key of probed) {
    const parent = parentKeyOf(key);
    if (parent === null || !grids.has(parent)) continue;
    const [level, x, y] = key.split("/").map(Number);
    const cx = x & 1;
    const cy = y & 1;
    const child = grids.get(key);
    const parentGrid = grids.get(parent);
    const corners = [];
    for (const r of [0, grid.height - 1]) {
      for (const c of [0, grid.width - 1]) {
        const parentRow = cy * mid + (r === 0 ? 0 : mid);
        const parentColumn = cx * mid + (c === 0 ? 0 : mid);
        const childValue = child[r * grid.width + c];
        const parentValue = parentGrid[parentRow * grid.width + parentColumn];
        corners.push({
          corner: `${r === 0 ? "north" : "south"}-${c === 0 ? "west" : "east"}`,
          child: Number(childValue.toFixed(4)),
          parent: Number(parentValue.toFixed(4)),
          differenceMetres: Number(Math.abs(childValue - parentValue).toFixed(4)),
        });
      }
    }
    lodCorners.push({
      child: key,
      parent,
      childOffset: { cx, cy },
      corners,
      maxAbsDiffMetres: Math.max(...corners.map((corner) => corner.differenceMetres)),
      rendered: renderedKeys.includes(key),
      injected: interprets(key) || interprets(parent),
    });
  }
  step("seams-measured", { seams: seams.length, lodCorners: lodCorners.length, worst: Math.max(0, ...seams.map((seam) => seam.maxAbsDiffMetres ?? 0)) });

  // ------------------------------------------------------------------------------------------
  // the frame's own clear command: an independent definition of "background"
  // ------------------------------------------------------------------------------------------

  const clearColours = (terrain.clearLog ?? []).map((entry) => {
    const colour = entry.color ?? entry.clearColor ?? null;
    if (colour === null || colour === undefined) return null;
    if (Array.isArray(colour)) return colour.slice(0, 4).map(Number);
    const lanes = ["red", "green", "blue", "alpha"].map((lane) => colour[lane]);
    if (lanes.every((lane) => typeof lane === "number")) return lanes;
    const xyz = ["x", "y", "z", "w"].map((lane) => colour[lane]).filter((lane) => typeof lane === "number");
    return xyz.length >= 3 ? xyz : null;
  });

  // ------------------------------------------------------------------------------------------
  // the DOM overlay the harness screenshot also captures (measured so the spec can exclude it)
  // ------------------------------------------------------------------------------------------

  const measureOverlays = () => {
    const parent = canvas.parentNode;
    if (parent === null) return { present: false, reason: "the canvas has no parent node", elements: [], union: null };
    const canvasRect = canvas.getBoundingClientRect();
    const elements = [];
    for (const child of parent.children) {
      if (child === canvas) continue;
      const rect = child.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      elements.push({
        tag: child.tagName,
        className: typeof child.className === "string" ? child.className : null,
        text: String(child.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
        rect: {
          x: Number((rect.left - canvasRect.left).toFixed(2)),
          y: Number((rect.top - canvasRect.top).toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
        },
      });
    }
    const union =
      elements.length === 0
        ? null
        : elements.reduce(
            (accumulator, element) => ({
              x: Math.min(accumulator.x, element.rect.x),
              y: Math.min(accumulator.y, element.rect.y),
              right: Math.max(accumulator.right, element.rect.x + element.rect.width),
              bottom: Math.max(accumulator.bottom, element.rect.y + element.rect.height),
            }),
            { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, right: Number.NEGATIVE_INFINITY, bottom: Number.NEGATIVE_INFINITY },
          );
    return {
      present: elements.length > 0,
      elements,
      union:
        union === null
          ? null
          : { x: union.x, y: union.y, width: Number((union.right - union.x).toFixed(2)), height: Number((union.bottom - union.y).toFixed(2)) },
      canvasBox: { width: Number(canvasRect.width.toFixed(2)), height: Number(canvasRect.height.toFixed(2)) },
    };
  };
  const overlays = measureOverlays();

  // ------------------------------------------------------------------------------------------
  // result
  // ------------------------------------------------------------------------------------------

  const geometryTiles = tiles.filter((tile) => tile.ok === true);
  const result = {
    scenario: "terrain-geometry",
    backend,
    task: "T093",
    injection: { requested: params.get("inject") ?? null, ...injection, injectedReads: [...new Set(injectedReads)], globeRequestCount: globeRequests.length },
    camera,
    datasetFrame,
    load,
    probe: {
      requested: probeKeys.length,
      omittedByCap,
      rendered: renderedKeys.length,
      renderedForFrame: renderedKeysForFrame.length,
      renderedForPresentation: renderedKeysForPresentation.length,
      /** Rendered but absent from the committed dataset: upstream upsamples these from their parent. */
      upsampled: upsampledKeys,
      renderedKeys: renderedKeys.slice(0, 40),
      requestedByGlobe: [...new Set(globeRequests)].length,
      requestedByGlobeSample: [...new Set(globeRequests)].slice(0, 24),
    },
    tiles,
    seams,
    lodCorners,
    draws: {
      webgpu: {
        ok: drawBindings.length > 0,
        reason: drawBindings.length > 0 ? null : "the GPURenderPassEncoder.drawIndexed wrapper (buildTerrainScene({pipelineLog:true})) recorded no draw",
        instrumented: terrain.drawBindingsInstrumented ?? null,
        truncated: drawBindings.length >= 40,
        drawCalls: drawBindings.length,
        indexCounts: drawBindings.map((entry) => entry.indexCount),
        distinctIndexCounts: [...new Set(drawBindings.map((entry) => entry.indexCount))],
        triangles: Number((drawBindings.reduce((sum, entry) => sum + (entry.indexCount ?? 0), 0) / 3).toFixed(4)),
        pipelines: [...new Set(drawBindings.map((entry) => entry.pipelineLabel))],
        dynamicOffsetsPerDraw: drawBindings.map((entry) => entry.dynamicOffsets[0]?.[0] ?? null),
        distinctDynamicOffsets: [...new Set(drawBindings.map((entry) => entry.dynamicOffsets[0]?.[0] ?? null))].length,
      },
      gl: glFrame,
      contextPasses: passes,
      contextDrawOps: passes === null ? null : passes.reduce((sum, pass) => sum + pass.drawOps, 0),
      framePassLog: (terrain.framePassLog ?? []).slice(-3),
      drawLogFirstDraws: drawLog,
      tilesRendered: renderedKeysForPresentation.length,
      /** The count from the very frame the draw records above belong to (same-frame comparison). */
      tilesRenderedForFrame: renderedKeysForFrame.length,
    },
    presentation: {
      clearColours,
      clearLogEntries: (terrain.clearLog ?? []).length,
      overlays,
      canvas: { width: canvas.width, height: canvas.height },
      /** Not measured on purpose: G-7 §0 — the canvas depth face is `depth24plus-stencil8` and cannot be copied. */
      canvasDepthReadback: {
        attempted: false,
        reason:
          "docs/gate-g7-conclusion.md §0 (13 measurements, 5 conclusions): depth24plus/depth24plus-stencil8 cannot be copied on this machine, so `readCanvasDepth` returns a structured 'not measurable' record; a depth-discontinuity pixel ratio is therefore not available and is not faked here",
      },
    },
    health: {
      tilesLoaded: load.tilesLoaded,
      globeTilesLoaded: terrain.scene.globe?.tilesLoaded === true,
      surfaceStatistics: {
        numberOfTilesLoaded: surface?._statistics?.numberOfTilesLoaded ?? null,
        numberOfCommands: surface?._statistics?.numberOfCommands ?? null,
        tilesToRenderLength: surface?._tilesToRender?.length ?? null,
      },
      frameErrors: terrain.frameErrors,
      renderErrors: terrain.renderErrors.slice(0, 8),
      renderErrorCount: terrain.renderErrors.length,
      diagnostics,
      frameTimesMs: terrain.frameTimesMs.slice(-8),
    },
    geometrySummary: {
      probedTiles: geometryTiles.length,
      unreadableTiles: tiles.length - geometryTiles.length,
      flatTiles: geometryTiles.filter((tile) => tile.flat === true).map((tile) => tile.tile),
      outsideDeclaredInterval: geometryTiles.filter((tile) => tile.withinDeclaredInterval === false).map((tile) => tile.tile),
      nonFiniteTiles: geometryTiles.filter((tile) => tile.nonFinite > 0).map((tile) => ({ tile: tile.tile, nonFinite: tile.nonFinite })),
      worstSeamMetres: seams.length === 0 ? null : Math.max(...seams.map((seam) => seam.maxAbsDiffMetres ?? Number.POSITIVE_INFINITY)),
      worstSeamInLocalCells: seams.length === 0 ? null : Math.max(...seams.map((seam) => seam.stepInLocalCells ?? Number.POSITIVE_INFINITY)),
      worstLodCornerMetres: lodCorners.length === 0 ? null : Math.max(...lodCorners.map((corner) => corner.maxAbsDiffMetres)),
      maxNeighbourStepMetres: geometryTiles.length === 0 ? null : Math.max(...geometryTiles.map((tile) => tile.maxNeighbourStepMetres)),
    },
  };
  step("geometry-result", {
    injection: injection.kind,
    tiles: result.geometrySummary.probedTiles,
    seams: seams.length,
    worstSeamMetres: result.geometrySummary.worstSeamMetres,
    draws: result.draws.webgpu.drawCalls,
    triangles: result.draws.webgpu.triangles,
    glDrawCalls: glFrame === null ? null : glFrame.drawCalls,
  });
  return result;
}
