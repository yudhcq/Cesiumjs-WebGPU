/**
 * `terrain-elevation` — T094: the elevation of the **rendered** terrain, as numbers (`层=视觉`, SC-002
 * as revised).
 *
 * ## What this scenario measures — and what it deliberately does NOT
 *
 * The revised SC-002 asks for one thing: the terrain is really rendered **and its geometry agrees with
 * the dataset** — the canvas is covered by terrain, and the elevation magnitude read out of the frame
 * evidence (vertex buffer / per-draw uniforms / depth test) matches the committed `matterhorn-z0-12`
 * dataset.
 *
 * **Relief / shading modulation is explicitly deferred.** With a near-ground camera the upstream
 * day/night fade is `clamp((cameraDist − fadeOutDistance) / (fadeInDistance − fadeOutDistance), 0, 1)`,
 * which is **0** at this camera distance, so the terrain colour is the unmodulated
 * `u_initialColor * czm_lightColor`: two different elevations are *supposed* to share one colour, and a
 * single-colour frame is upstream's behaviour for this camera. This scenario therefore asserts nothing
 * about height↔brightness correlation, shadows, occlusion or "the highest and the lowest point differ
 * in brightness" — those would report designed upstream behaviour as a defect. The frame's colour count
 * is **published** (`uniqueColoursGpuReadback`, the canvas-texture instrument), never used as a
 * pass/fail criterion.
 *
 * ## The evidence, and where every number comes from
 *
 *  1. **The dataset** is read here, in the page, over the same HTTP path the adapter uses: the
 *     committed manifest plus **every tile it lists**, decoded as `raw + heightOffsetMetres` (Uint16,
 *     little-endian, headerless — the codec T086 ships). The manifest's own `elevation` block is
 *     published *beside* the range recomputed from the bytes.
 *  2. **The frame evidence** is the settled frame's terrain draws: every drawn vertex buffer is copied
 *     back out of the GPU (`ctx.enableBufferReadback`), and each vertex row yields
 *     `position3DAndHeight = vec4(shader floats 0..3)` — the RTC position plus the **height in metres**
 *     (`TerrainEncoding.js:268-273` writes exactly `x, y, z, height`; the slot is emitted as a `vec4` at
 *     `TerrainEncoding.js:713-717`). A second, independent arithmetic path recovers the same height:
 *     `world = position + u_center3D`, then the WGS84 closed-form inverse of that world point
 *     (`inverseWgs84`, Bowring). `heightLane − heightEcef` is therefore a numeric self-check of the
 *     frame evidence, not an assumption about the layout.
 *  3. **Agreement** is a per-vertex residual against the dataset: each vertex is mapped to its dataset
 *     texel inside the tile it sits in, and compared with that texel's decoded height (the nearest
 *     sample, the bilinear interpolation, and the best match in a 5×5 neighbourhood are all reported, so
 *     a grid-registration offset is distinguishable from wrong geometry).
 *  4. **The depth test** is the only depth evidence this platform has: the depth aspect of the canvas
 *     `depth24plus-stencil8` texture cannot be copied on Chrome 153 (`probe.js:1989-2010`), so
 *     `ctx.readCanvasDepth` is called **without** `{ attempt: true }` and its "not measurable" record is
 *     published as the honest answer instead of being provoked into an uncaptured GPU error. Presence is
 *     corroborated through the depth test (`ctx.createDepthIndicatorResources` /
 *     `ctx.depthIndicatorInputs`), and that measurement is taken **before** the final coverage reading so
 *     the presented frame is the terrain's own.
 *
 * ## Module rules
 *
 * This file imports **nothing** (importing `probe.js` would re-run its `main()`): every helper arrives
 * through `ctx`, the default export is `(bundle, canvas, ctx) => result`, and the page publishes the
 * returned object under `report.result["terrain-elevation"]`.
 */
export default async function terrainElevationScenario(bundle, canvas, ctx) {
  const {
    backend,
    step,
    createDepthIndicatorResources,
    depthIndicatorInputs,
    heightmapTileRectangle,
    readCanvasDepth,
    readPresentedCanvas,
    renderUntilTilesLoaded,
    decodeBlock,
    buildTerrainScene,
  } = ctx;

  const DATASET_ID = "matterhorn-z0-12";
  const FIXTURE_BASE_URL = "/packages/cesium-webgpu/fixtures";
  const DATASET_ROOT = `${FIXTURE_BASE_URL}/${DATASET_ID}`;
  const isWebgpu = backend !== "webgl2";
  const EXPECTED_RECTANGLE = { west: 6.7, south: 45.65, east: 7.3, north: 46.15 };
  /**
   * Agreement thresholds, in metres.
   *
   * A terrain mesh is built **at** the dataset's own sample positions, so a vertex that lands exactly on
   * a sample reproduces it bit-for-bit and one that lands between four samples is the bilinear blend of
   * them: `TIGHT` is the band that means "this vertex is the dataset", while `WIDE` bounds the tail that
   * the tile skirts and the grid registration produce. Both are ~10–1000× the float32 rounding of a
   * height (≈ 2·10⁻⁴ m at 4 km), which is what makes them a test of the geometry rather than of noise.
   */
  const TIGHT_AGREEMENT_METRES = 5;
  const WIDE_AGREEMENT_METRES = 250;

  // ----------------------------------------------------------------------------------------------
  // 1. the dataset — read over the same HTTP path the product adapter uses
  // ----------------------------------------------------------------------------------------------
  const manifestResponse = await fetch(`${DATASET_ROOT}/manifest.json`);
  if (manifestResponse.ok !== true) {
    throw new Error(`the committed dataset manifest is not served (${manifestResponse.status} for ${DATASET_ROOT}/manifest.json)`);
  }
  const manifest = await manifestResponse.json();
  const sampleWidth = manifest.sampleWidth;
  const sampleHeight = manifest.sampleHeight;
  const sampleCount = sampleWidth * sampleHeight;
  const noDataValue = manifest.noDataValue;
  const heightOffsetMetres = manifest.heightOffsetMetres;

  const decodedCache = new Map();
  /** Decode one tile through the shipped codec: `height_metres = raw + heightOffsetMetres`. */
  const decodedTileOf = async (tile) => {
    const key = `${tile.level}/${tile.x}/${tile.y}`;
    const cached = decodedCache.get(key);
    if (cached !== undefined) return cached;
    const decoded = { key, level: tile.level, x: tile.x, y: tile.y, bytes: null, heights: null, minimum: null, maximum: null, distinctSamples: 0 };
    decodedCache.set(key, decoded);
    try {
      const response = await fetch(`${DATASET_ROOT}/${key}.hgt`);
      if (response.ok !== true) throw new Error(`listed in the manifest but served as ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      decoded.bytes = bytes.byteLength;
      if (bytes.byteLength !== sampleCount * 2) throw new Error(`${bytes.byteLength} bytes, expected ${sampleCount * 2}`);
      // The adapter's own missing-sample rule (`source.ts:226-258`): a `noDataValue` sample is replaced
      // by the tile's minimum valid height, so it can never become a spike.
      let minimumValid = null;
      for (let index = 0; index < sampleCount; index += 1) {
        const raw = bytes[2 * index] | (bytes[2 * index + 1] << 8);
        if (raw !== noDataValue && (minimumValid === null || raw < minimumValid)) minimumValid = raw;
      }
      const heights = new Float32Array(sampleCount);
      const distinct = new Set();
      let minimum = null;
      let maximum = null;
      for (let index = 0; index < sampleCount; index += 1) {
        const raw = bytes[2 * index] | (bytes[2 * index + 1] << 8);
        if (distinct.size < 64) distinct.add(raw);
        const value = (raw === noDataValue ? (minimumValid ?? 0) : raw) + heightOffsetMetres;
        heights[index] = value;
        if (raw === noDataValue) continue;
        if (minimum === null || value < minimum) minimum = value;
        if (maximum === null || value > maximum) maximum = value;
      }
      decoded.heights = heights;
      decoded.minimum = minimum;
      decoded.maximum = maximum;
      decoded.distinctSamples = distinct.size;
    } catch (error) {
      decoded.error = String(error?.message ?? error).slice(0, 200);
    }
    return decoded;
  };

  const tiles = manifest.tiles ?? [];
  let cursor = 0;
  const decodedTiles = new Array(tiles.length);
  const workers = new Array(Math.min(12, Math.max(1, tiles.length))).fill(null).map(async () => {
    while (cursor < tiles.length) {
      const index = cursor;
      cursor += 1;
      decodedTiles[index] = await decodedTileOf(tiles[index]);
    }
  });
  await Promise.all(workers);

  const readable = decodedTiles.filter((tile) => tile.heights !== null);
  const failed = decodedTiles.filter((tile) => tile.heights === null);
  const datasetMinimum = readable.length === 0 ? null : Math.min(...readable.map((tile) => tile.minimum));
  const datasetMaximum = readable.length === 0 ? null : Math.max(...readable.map((tile) => tile.maximum));
  const tilesByLevelCount = {};
  for (const tile of readable) tilesByLevelCount[tile.level] = (tilesByLevelCount[tile.level] ?? 0) + 1;
  const datasetInterval = {
    instrument: "page fetch of every tile listed by manifest.json, decoded as raw + heightOffsetMetres (headerless Uint16 LE)",
    source: `${DATASET_ROOT}/manifest.json + ${readable.length}/${tiles.length} .hgt files`,
    floor: datasetMinimum,
    ceiling: datasetMaximum,
    span: datasetMinimum === null ? null : Number((datasetMaximum - datasetMinimum).toFixed(3)),
    fromBytes: { tiles: readable.length, failed: failed.length, failures: failed.slice(0, 5).map((tile) => ({ key: tile.key, error: tile.error })), tilesByLevel: tilesByLevelCount },
    fromManifest: {
      field: "manifest.elevation",
      floor: manifest.elevation?.minHeight ?? null,
      ceiling: manifest.elevation?.maxHeight ?? null,
      span: manifest.elevation?.span ?? null,
      sampleCount: manifest.elevation?.sampleCount ?? null,
      noDataSamples: manifest.elevation?.noDataSamples ?? null,
    },
    bytesAgreeWithManifest: manifest.elevation === undefined ? null : manifest.elevation.minHeight === datasetMinimum && manifest.elevation.maxHeight === datasetMaximum,
    sampleGrid: { width: sampleWidth, height: sampleHeight, samplesPerTile: sampleCount, noDataValue, heightOffsetMetres, orientation: manifest.sampleGrid?.orientation ?? null },
    rectangle: manifest.rectangle ?? null,
    rectangleAgrees: ["west", "south", "east", "north"].every((edge) => Math.abs(manifest.rectangle?.[edge] - EXPECTED_RECTANGLE[edge]) < 1e-9),
  };
  step("dataset", { tiles: readable.length, floor: datasetInterval.floor, ceiling: datasetInterval.ceiling, manifest: datasetInterval.fromManifest });

  /** A vertex sits in exactly one dataset tile; the finest level wins when several contain it. */
  const tilesByLevelDescending = [...readable].sort((a, b) => b.level - a.level);

  /**
   * The dataset height a frame-evidence vertex claims.
   *
   * A `HeightmapTerrainData` sample of a geographic tile sits at the **centre** of its cell, so a
   * terrain vertex of that tile can be read off the sample grid at its **exact fractional cell
   * position**: `column = (longitude − west) / cellWidth − 0.5`. The bilinear reading below uses that
   * fraction, so a mesh that is registered to the dataset to a fraction of a cell still compares
   * correctly; the nearest-texel reading (rounded) is reported beside it, because the difference between
   * the two is exactly the registration offset.
   *
   * `null` means "no dataset tile contains this vertex at a usable grid position" — either the vertex is
   * outside every tile of the dataset, or it sits in the outermost half-cell of one, where the grid
   * position leaves the sample array. Those are reported as `verticesUnmatchable`: a statement about
   * where the mesh is, not about what it contains.
   */
  const datasetSampleAt = (longitude, latitude) => {
    for (const tile of tilesByLevelDescending) {
      const rectangle = heightmapTileRectangle(tile.x, tile.y, tile.level);
      if (longitude < rectangle.west || longitude > rectangle.east || latitude < rectangle.south || latitude > rectangle.north) continue;
      const cellLongitude = (rectangle.east - rectangle.west) / (sampleWidth - 1);
      const cellLatitude = (rectangle.north - rectangle.south) / (sampleHeight - 1);
      const cellLongitudePosition = (longitude - rectangle.west) / cellLongitude - 0.5;
      const cellLatitudePosition = (rectangle.north - latitude) / cellLatitude - 0.5;
      const column = Math.round(cellLongitudePosition);
      const row = Math.round(cellLatitudePosition);
      if (column < 0 || column > sampleWidth - 1 || row < 0 || row > sampleHeight - 1) return null;
      const at = (column_, row_) => tile.heights[row_ * sampleWidth + column_];
      const c0 = Math.max(0, Math.min(sampleWidth - 2, Math.floor(cellLongitudePosition)));
      const r0 = Math.max(0, Math.min(sampleHeight - 2, Math.floor(cellLatitudePosition)));
      const tu = Math.max(0, Math.min(1, cellLongitudePosition - c0));
      const tv = Math.max(0, Math.min(1, cellLatitudePosition - r0));
      const interpolated = (1 - tv) * ((1 - tu) * at(c0, r0) + tu * at(c0 + 1, r0)) + tv * ((1 - tu) * at(c0, r0 + 1) + tu * at(c0 + 1, r0 + 1));
      return {
        tile: tile.key,
        level: tile.level,
        row,
        column,
        nearest: at(column, row),
        interpolated: Number(interpolated.toFixed(3)),
        withinGrid: Math.abs(cellLongitudePosition - column) < 0.1 && Math.abs(cellLatitudePosition - row) < 0.1,
        offsetCells: { longitude: Number((cellLongitudePosition - column).toFixed(4)), latitude: Number((cellLatitudePosition - row).toFixed(4)) },
        heights: tile.heights,
        minimum: tile.minimum,
        maximum: tile.maximum,
      };
    }
    return null;
  };

  // ----------------------------------------------------------------------------------------------
  // 2. the scene — driven by the **product** adapter over the committed dataset
  // ----------------------------------------------------------------------------------------------
  const provider = await bundle.terrainSource.createTerrainProvider({
    mode: "fixture",
    datasetId: DATASET_ID,
    fixtureBaseUrl: FIXTURE_BASE_URL,
    credit: "Terrain Tiles (terrarium) by Mapzen/Joerd (AWS Open Data) — fixed dataset matterhorn-z0-12",
  });
  // Which tiles the globe asked for, through the upstream public method (the data path is untouched).
  const requestedTiles = [];
  const originalRequestTileGeometry = provider.requestTileGeometry.bind(provider);
  provider.requestTileGeometry = (x, y, level, request) => {
    requestedTiles.push(`${level}/${x}/${y}`);
    return originalRequestTileGeometry(x, y, level, request);
  };

  const terrain = await buildTerrainScene(bundle, canvas, { provider, readback: true, bufferReadback: true, pipelineLog: true });
  const load = await renderUntilTilesLoaded(terrain, 30000);
  step("tiles-loaded", load);
  // The compositor needs more than one frame on this canvas, and the harness screenshots the canvas
  // right after the page reports ready: settle on the frame whose tiles are the ones measured below.
  await terrain.renderFrames(3, 16);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const context = terrain.scene.context;
  const readback = terrain.readback;
  // Forget the opening frames' draws: the frame read back below is the settled one.
  terrain.resetDrawLog();
  if (readback !== null) readback.arm();
  await terrain.renderFrames(1, 16);
  const gpuFrame = readback === null ? null : await readback.read();
  step("settled-frame", gpuFrame === null ? { skipped: "the canvas-texture read-back is a WebGPU-path instrument" } : { nonBlackPixels: gpuFrame.nonBlackPixels, nonTransparentPixels: gpuFrame.nonTransparentPixels, uniqueColoursGpuReadback: gpuFrame.uniqueColoursGpuReadback, uniqueColoursInstrument: gpuFrame.colourCountInstrument });

  // ----------------------------------------------------------------------------------------------
  // 3. the frame evidence: the drawn vertex buffers + the uniforms of those very draws
  // ----------------------------------------------------------------------------------------------
  const uniformTarget = terrain.uniformTargets[0] ?? null;
  const drawUniforms = [];
  for (const draw of terrain.drawLog) {
    if (uniformTarget === null || terrain.bufferReadback === null) {
      drawUniforms.push(null);
      continue;
    }
    const offset = draw.programDynamicOffsetAfter ?? draw.programDynamicOffset;
    if (offset === null || offset === undefined) {
      drawUniforms.push(null);
      continue;
    }
    try {
      const floats = await terrain.bufferReadback.readFloats(uniformTarget.buffer, Math.floor((uniformTarget.structSize ?? 0) / 4), offset);
      drawUniforms.push(decodeBlock(floats, uniformTarget.members ?? []).named);
    } catch (error) {
      drawUniforms.push({ error: String(error?.message ?? error).slice(0, 160) });
    }
  }

  const heightValues = [];
  const residualsNearest = [];
  const residualsBilinear = [];
  const residualsBest = [];
  const residualsByLevel = new Map();
  const matchedTiles = new Set();
  const bestOffsets = new Map();
  const worstResiduals = [];
  const centreSources = { perDrawUniformMap: 0, decodedUniformSlot: 0, none: 0 };
  const residualSigns = { frameLower: 0, equal: 0, frameHigher: 0 };
  const offsetCellsExtremes = { maximumLongitude: 0, maximumLatitude: 0 };
  const perDraw = [];
  let floatsRead = 0;
  let verticesRead = 0;
  let nonFiniteFloats = 0;
  let outsideClipVolume = 0;
  let clipEvaluated = 0;
  let ecefSamples = 0;
  let ecefResidualSum = 0;
  let ecefResidualMaximum = 0;
  let ecefHeightMinimum = null;
  let ecefHeightMaximum = null;
  let ecefOutsidePlausibleRange = 0;
  let verticesUnmatchable = 0;
  let verticesOffGrid = 0;
  let tightAgreement = 0;
  let wideResiduals = 0;
  let residualOverLocalRange = { compared: 0, above: 0 };
  const extent = { longitude: { minimum: null, maximum: null }, latitude: { minimum: null, maximum: null }, height: { minimum: null, maximum: null } };
  const note = (value, axis) => {
    if (value === null || !Number.isFinite(value)) return;
    if (extent[axis].minimum === null || value < extent[axis].minimum) extent[axis].minimum = value;
    if (extent[axis].maximum === null || value > extent[axis].maximum) extent[axis].maximum = value;
  };
  const vertexFloatBudget = 600_000;

  for (let index = 0; index < terrain.drawLog.length; index += 1) {
    const draw = terrain.drawLog[index];
    const gpuBuffers = draw.rawGpuVertexBuffers ?? [];
    const buffers = draw.rawVertexBuffers ?? [];
    if (gpuBuffers.length === 0 || buffers.length === 0 || (draw.count ?? 0) <= 0) continue;
    const stride = gpuBuffers[0].arrayStride ?? null;
    const rows = draw.vertexArray?.numberOfVertices ?? null;
    if (stride === null || rows === null || rows <= 0 || stride % 4 !== 0 || stride < 16) continue;
    const floatsPerRow = stride / 4;
    if (floatsRead + rows * floatsPerRow > vertexFloatBudget) break;
    try {
      const floats = await terrain.bufferReadback.readFloats(buffers[0].buffer, rows * floatsPerRow);
      floatsRead += floats.length;
      const positions = new Float32Array(rows * 3);
      const heights = new Float32Array(rows);
      let drawNonFinite = 0;
      for (let row = 0; row < rows; row += 1) {
        const base = row * floatsPerRow;
        for (let lane = 0; lane < 4; lane += 1) if (!Number.isFinite(floats[base + lane])) drawNonFinite += 1;
        positions[row * 3] = floats[base];
        positions[row * 3 + 1] = floats[base + 1];
        positions[row * 3 + 2] = floats[base + 2];
        heights[row] = floats[base + 3];
      }
      nonFiniteFloats += drawNonFinite;

      const decodedSlot = drawUniforms[index];
      const fromUniformMap = Array.isArray(draw.uniformValues?.u_center3D) && draw.uniformValues.u_center3D.length >= 3 ? draw.uniformValues.u_center3D : null;
      const fromSlot = Array.isArray(decodedSlot?.u_center3D) && decodedSlot.u_center3D.length >= 3 ? decodedSlot.u_center3D : null;
      const centre = fromUniformMap ?? fromSlot;
      if (fromUniformMap !== null) centreSources.perDrawUniformMap += 1;
      else if (fromSlot !== null) centreSources.decodedUniformSlot += 1;
      else centreSources.none += 1;

      // The matrix of **this** draw, read from the ring slot the draw itself selected.
      const matrix = Array.isArray(decodedSlot?.u_modifiedModelViewProjection) && decodedSlot.u_modifiedModelViewProjection.length >= 16 ? decodedSlot.u_modifiedModelViewProjection : null;
      const boundRectangle = Array.isArray(draw.uniformValues?.u_tileRectangle) && draw.uniformValues.u_tileRectangle.length >= 4 ? draw.uniformValues.u_tileRectangle.slice(0, 4) : null;
      const boundMinMaxHeight = Array.isArray(draw.uniformValues?.u_minMaxHeight) && draw.uniformValues.u_minMaxHeight.length >= 2 ? draw.uniformValues.u_minMaxHeight.slice(0, 2) : null;

      let drawMatchedVertices = 0;
      let drawOffGridVertices = 0;
      let drawUnmatchableVertices = 0;
      const drawMatchedTileKeys = new Set();
      for (let row = 0; row < rows; row += 1) {
        const heightMetres = heights[row];
        if (!Number.isFinite(heightMetres)) continue;
        verticesRead += 1;
        heightValues.push(heightMetres);

        // (a) the matrix path: this draw's own MVP, evaluated exactly as the emitted WGSL does.
        if (matrix !== null && clipEvaluated < 4096) {
          const clip = ctx.remapClipDepth(ctx.multiplyMatrix4Vector(matrix, [positions[row * 3], positions[row * 3 + 1], positions[row * 3 + 2], 1]));
          clipEvaluated += 1;
          const w = clip[3];
          if (!(w > 0) || Math.abs(clip[0]) > w || Math.abs(clip[1]) > w || clip[2] < 0 || clip[2] > w) outsideClipVolume += 1;
        }

        if (centre === null) continue;
        const world = [positions[row * 3] + centre[0], positions[row * 3 + 1] + centre[1], positions[row * 3 + 2] + centre[2]];
        const geodetic = inverseWgs84(world);
        if (geodetic === null) continue;
        ecefSamples += 1;
        const residual = Math.abs(geodetic.height - heightMetres);
        ecefResidualSum += residual;
        if (residual > ecefResidualMaximum) ecefResidualMaximum = residual;
        if (ecefHeightMinimum === null || geodetic.height < ecefHeightMinimum) ecefHeightMinimum = geodetic.height;
        if (ecefHeightMaximum === null || geodetic.height > ecefHeightMaximum) ecefHeightMaximum = geodetic.height;
        // A mispaired tile centre moves a vertex by kilometres: the plausibility gate keeps such a
        // vertex out of the verdict instead of letting it masquerade as a geometry error.
        if (datasetMinimum !== null && (geodetic.height < datasetMinimum - 20_000 || geodetic.height > datasetMaximum + 20_000)) {
          ecefOutsidePlausibleRange += 1;
          continue;
        }
        note(geodetic.longitude, "longitude");
        note(geodetic.latitude, "latitude");
        note(geodetic.height, "height");

        const sample = datasetSampleAt(geodetic.longitude, geodetic.latitude);
        if (sample === null) {
          verticesUnmatchable += 1;
          drawUnmatchableVertices += 1;
          continue;
        }
        drawMatchedVertices += 1;
        matchedTiles.add(sample.tile);
        drawMatchedTileKeys.add(sample.tile);
        if (Math.abs(sample.offsetCells.longitude) > offsetCellsExtremes.maximumLongitude) offsetCellsExtremes.maximumLongitude = Math.abs(sample.offsetCells.longitude);
        if (Math.abs(sample.offsetCells.latitude) > offsetCellsExtremes.maximumLatitude) offsetCellsExtremes.maximumLatitude = Math.abs(sample.offsetCells.latitude);
        if (!sample.withinGrid) {
          verticesOffGrid += 1;
          drawOffGridVertices += 1;
          continue;
        }
        // The 5×5 neighbourhood around the rounded cell: the residual's size can then be attributed to
        // grid registration (`byRowOffset`) rather than guessed at.
        let best = null;
        for (let rowOffset = -2; rowOffset <= 2; rowOffset += 1) {
          for (let columnOffset = -2; columnOffset <= 2; columnOffset += 1) {
            const candidateRow = sample.row + rowOffset;
            const candidateColumn = sample.column + columnOffset;
            if (candidateRow < 0 || candidateRow > sampleHeight - 1 || candidateColumn < 0 || candidateColumn > sampleWidth - 1) continue;
            const candidate = sample.heights[candidateRow * sampleWidth + candidateColumn];
            const error = Math.abs(heightMetres - candidate);
            if (best === null || error < best.error) best = { error, rowOffset, columnOffset, value: candidate };
          }
        }
        const nearest = Math.abs(heightMetres - sample.nearest);
        const bilinear = Math.abs(heightMetres - sample.interpolated);
        residualsNearest.push(nearest);
        residualsBilinear.push(bilinear);
        if (bilinear <= TIGHT_AGREEMENT_METRES) tightAgreement += 1;
        if (bilinear > WIDE_AGREEMENT_METRES) wideResiduals += 1;
        if (best !== null) {
          residualsBest.push(best.error);
          const key = `${best.rowOffset},${best.columnOffset}`;
          bestOffsets.set(key, (bestOffsets.get(key) ?? 0) + 1);
        }
        residualsByLevel.set(sample.level, [...(residualsByLevel.get(sample.level) ?? []), bilinear]);
        const localRange = Math.abs(sample.maximum - sample.minimum);
        if (localRange > 1) {
          residualOverLocalRange.compared += 1;
          if (bilinear > localRange) residualOverLocalRange.above += 1;
        }
        if (heightMetres < sample.nearest) residualSigns.frameLower += 1;
        else if (heightMetres > sample.nearest) residualSigns.frameHigher += 1;
        else residualSigns.equal += 1;
        const entry = {
          residualBilinear: Number(bilinear.toFixed(3)),
          residualNearest: Number(nearest.toFixed(3)),
          tile: sample.tile,
          level: sample.level,
          row: sample.row,
          column: sample.column,
          frameHeight: Number(heightMetres.toFixed(3)),
          datasetBilinear: sample.interpolated,
          datasetNearest: sample.nearest,
          offsetCells: sample.offsetCells,
          best: best === null ? null : { error: Number(best.error.toFixed(3)), rowOffset: best.rowOffset, columnOffset: best.columnOffset, value: best.value },
          localRange: Number(localRange.toFixed(3)),
          longitude: Number(geodetic.longitude.toFixed(9)),
          latitude: Number(geodetic.latitude.toFixed(9)),
        };
        if (worstResiduals.length < 12) worstResiduals.push(entry);
        else {
          let worst = 0;
          for (let position = 1; position < worstResiduals.length; position += 1) if (worstResiduals[position].residualBilinear > worstResiduals[worst].residualBilinear) worst = position;
          if (entry.residualBilinear > worstResiduals[worst].residualBilinear) worstResiduals[worst] = entry;
        }
      }

      perDraw.push({
        frame: draw.frame ?? null,
        pipelineId: draw.pipelineId ?? null,
        stride,
        floatsPerRow,
        vertices: rows,
        indexFormat: draw.rawIndexBuffer?.format ?? null,
        vertexLayout: draw.vertexArray?.layout ?? null,
        uniformSlotOffset: draw.programDynamicOffsetAfter ?? draw.programDynamicOffset ?? null,
        centreSource: fromUniformMap !== null ? "per-draw uniformMap u_center3D" : fromSlot !== null ? "decoded uniform slot u_center3D" : null,
        centre: centre === null ? null : centre.map((value) => Number(Number(value).toPrecision(12))),
        boundTileRectangle: boundRectangle,
        boundMinMaxHeight,
        matchedTiles: drawMatchedTileKeys.size,
        matchedVertices: drawMatchedVertices,
        offGridVertices: drawOffGridVertices,
        unmatchableVertices: drawUnmatchableVertices,
        nonFiniteFloats: drawNonFinite,
      });
    } catch (error) {
      perDraw.push({ frame: draw.frame ?? null, rows, stride, error: String(error?.message ?? error).slice(0, 300) });
      break;
    }
  }

  const summarise = (values) => {
    if (values.length === 0) return null;
    const sorted = Float64Array.from(values);
    sorted.sort();
    const at = (quantile) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(quantile * (sorted.length - 1))))];
    return {
      count: sorted.length,
      minimum: Number(sorted[0].toFixed(4)),
      p50: Number(at(0.5).toFixed(4)),
      p90: Number(at(0.9).toFixed(4)),
      p99: Number(at(0.99).toFixed(4)),
      maximum: Number(sorted[sorted.length - 1].toFixed(4)),
      mean: Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(4)),
    };
  };
  const heightSummary = summarise(heightValues);
  const frameEvidence = {
    instrument: "GPU copy-back of the drawn terrain vertex buffers (ctx.enableBufferReadback): lane 3 of each vertex row, plus the per-draw uniform slot the same draw selected",
    heightLane: { offsetFloats: 3, offsetBytes: 12, sources: ["TerrainEncoding.js:268-273 (encode writes `x, y, z, height`)", "TerrainEncoding.js:713-717 (the slot is emitted as a vec4)"] },
    drawsRead: perDraw.length,
    drawsWithError: perDraw.filter((entry) => entry.error !== undefined).length,
    verticesRead,
    floatsRead,
    arrayStrides: [...new Set(perDraw.filter((entry) => entry.stride !== undefined).map((entry) => entry.stride))],
    nonFiniteFloats,
    interval: heightSummary === null ? null : { floor: heightSummary.minimum, ceiling: heightSummary.maximum, p50: heightSummary.p50, p90: heightSummary.p90, p99: heightSummary.p99, span: Number((heightSummary.maximum - heightSummary.minimum).toFixed(3)) },
    perDraw,
    tileRectangles: perDraw.filter((entry) => Array.isArray(entry.boundTileRectangle)).map((entry) => entry.boundTileRectangle),
    clip: { evaluated: clipEvaluated, outsideClipVolume, source: "ctx.multiplyMatrix4Vector + ctx.remapClipDepth on the same draw's u_modifiedModelViewProjection" },
    ecef: {
      method: "world = position + u_center3D of the same draw, then the WGS84 closed-form inverse (Bowring) in this file",
      samples: ecefSamples,
      interval: ecefHeightMinimum === null ? null : { floor: Number(ecefHeightMinimum.toFixed(3)), ceiling: Number(ecefHeightMaximum.toFixed(3)) },
      outsidePlausibleRange: ecefOutsidePlausibleRange,
      extent,
      versusVertexLane: ecefSamples === 0 ? null : { samples: ecefSamples, meanAbsMetres: Number((ecefResidualSum / ecefSamples).toFixed(6)), maximumAbsMetres: Number(ecefResidualMaximum.toFixed(6)) },
    },
    centreSources,
  };

  const consistency = {
    instrument: "per-vertex residual: frame-evidence height minus the dataset sample read at that vertex's own geodetic longitude/latitude",
    agreementThresholdsMetres: { tight: TIGHT_AGREEMENT_METRES, wide: WIDE_AGREEMENT_METRES },
    matchedTiles: matchedTiles.size,
    matchedTileSample: [...matchedTiles].slice(0, 12),
    verticesOnGrid: residualsBilinear.length,
    verticesOffGrid,
    verticesUnmatchable,
    // The headline number: how many matched vertices reproduce the dataset to within `tight`.
    withinTightAgreement: tightAgreement,
    withinTightShare: residualsBilinear.length === 0 ? null : Number((tightAgreement / residualsBilinear.length).toFixed(6)),
    beyondWideAgreement: wideResiduals,
    offsetCellsExtremes,
    residualSigns,
    residualOverLocalRange,
    bilinearTexel: summarise(residualsBilinear),
    nearestTexel: summarise(residualsNearest),
    bestIn5x5Neighbourhood: summarise(residualsBest),
    bestOffsets: Object.fromEntries([...bestOffsets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9)),
    byLevel: Object.fromEntries([...residualsByLevel.entries()].sort((a, b) => a[0] - b[0]).map(([level, values]) => [level, summarise(values)])),
    worst: [...worstResiduals].sort((a, b) => b.residualBilinear - a.residualBilinear),
  };

  // ----------------------------------------------------------------------------------------------
  // 4. depth corroboration — measured BEFORE the presented frame is captured
  // ----------------------------------------------------------------------------------------------
  const canvasDepth = await readCanvasDepth(context, canvas, terrain.bufferReadbackStaging);
  let depthIndicator = { skipped: "the depth-test indicator is a WebGPU-path instrument" };
  if (isWebgpu && readback !== null) {
    const resources = createDepthIndicatorResources(context.device, context.swapchainFormat, context.sampleCount);
    const state = { depthTest: { enabled: false }, depthMask: false, cull: { enabled: false } };
    const indicatorFrame = async (depthCompare, options = {}) => {
      const inputs = depthIndicatorInputs(resources, { depthCompare, sampleCount: context.sampleCount, format: context.swapchainFormat });
      readback.arm();
      context.beginFrame();
      if (options.clearOnly === true) {
        // A frame that only clears (colour and depth), so the attachment holds exactly its clear value:
        // the `greater` marker over it should paint nothing if the indicator really tests stored depth.
        context.clear({ color: { red: 0, green: 0, blue: 0, alpha: 1 }, depth: 1, stencil: 0 }, {});
      } else {
        context.draw({ __webgpu: inputs, count: 3, renderState: state }, {});
      }
      context.endFrame();
      await context.awaitFrameErrors().catch((error) => ({ error: String(error?.message ?? error).slice(0, 200) }));
      const pixels = await readback.read();
      return pixels === null ? null : { width: pixels.width, height: pixels.height, viewportPixels: pixels.width * pixels.height, markerPixels: pixels.nonTransparentPixels, centre: pixels.centre };
    };
    const always = await indicatorFrame("always");
    const greaterOverTerrain = await indicatorFrame("greater");
    // The discriminating control. The terrain's own depth is in the attachment in this frame (the marker
    // frames are `depthWriteEnabled: false`), so a `less` marker at clip depth 1.0 MUST paint **nothing**:
    // if it painted, the attachment would be holding the clear value rather than rendered depth and the
    // `greater` count above would mean nothing. (The clear-only arm is reported separately: on this
    // platform it paints the full viewport, which is why the control is taken against the terrain's depth
    // instead of against a cleared buffer.)
    const lessOverTerrain = await indicatorFrame("less");
    const clearOnlyGreater = await indicatorFrame("greater", { clearOnly: true });
    depthIndicator = {
      instrument: "full-viewport triangle at clip depth 1.0 drawn through the same Context, counted in the canvas-texture read-back (probe.js:2407-2474)",
      always: always === null ? null : { markerPixels: always.markerPixels, viewportPixels: always.viewportPixels },
      greaterOverTerrain: greaterOverTerrain === null ? null : { markerPixels: greaterOverTerrain.markerPixels, viewportPixels: greaterOverTerrain.viewportPixels },
      lessOverTerrain: lessOverTerrain === null ? null : { markerPixels: lessOverTerrain.markerPixels, viewportPixels: lessOverTerrain.viewportPixels },
      clearOnlyGreater: clearOnlyGreater === null ? null : { markerPixels: clearOnlyGreater.markerPixels, viewportPixels: clearOnlyGreater.viewportPixels },
      // `less` paints zero over rendered depth and everything over the clear value: that difference is
      // what makes the depth presence measurable here.
      controlPaintsNothing: lessOverTerrain === null ? null : lessOverTerrain.markerPixels === 0,
      controlNote: "the clear-only frame is reported, not asserted: it painted the whole viewport here, so this platform does not expose the depth clear value to the marker the way the probe's `greater` over a cleared buffer would need",
      depthWrittenShare: greaterOverTerrain === null || always === null ? null : Number((greaterOverTerrain.markerPixels / always.viewportPixels).toFixed(6)),
      verdict: greaterOverTerrain === null ? "the indicator did not run" : `${greaterOverTerrain.markerPixels} of ${always?.viewportPixels ?? 0} viewport pixels hold depth written below the clear value`,
    };
    // The indicator frames replaced what was presented; put the terrain's own frame back, because the
    // coverage reading and the harness screenshot are both taken after this point.
    readback.arm();
    await terrain.renderFrames(2, 16);
    await readback.read();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  // ----------------------------------------------------------------------------------------------
  // 5. the presented frame: coverage
  // ----------------------------------------------------------------------------------------------
  const presentedAfter = await readPresentedCanvas(canvas);
  const restoredFrame = readback === null ? null : await (async () => {
    readback.arm();
    await terrain.renderFrames(1, 16);
    return readback.read();
  })();
  const measuredFrame = restoredFrame ?? gpuFrame;
  const viewportPixels = canvas.width * canvas.height;
  /**
   * Coverage is taken from the **canvas texture** (`copyTextureToBuffer` of the very texture the frame
   * rendered into) rather than from `createImageBitmap(canvas)`: on this platform the bitmap route of a
   * WebGPU canvas can come back empty for a frame the GPU copy shows fully covered (measured: this
   * scenario's first run read `nonBlackPixels = 0` through the bitmap while the GPU copy of the same
   * canvas held 153 600 of 153 600 non-black pixels). Both readings are published, and the difference is
   * reported rather than hidden.
   */
  const coverage = {
    instrument: "gpu-readback:copyTextureToBuffer(canvas texture) — the frame the GPU really produced, taken after the depth indicator was restored",
    ...(measuredFrame === null
      ? { skipped: "the canvas-texture read-back is a WebGPU-path instrument" }
      : {
          width: measuredFrame.width,
          height: measuredFrame.height,
          canvasPixels: measuredFrame.width * measuredFrame.height,
          nonBlackPixels: measuredFrame.nonBlackPixels,
          nonBlackShare: Number((measuredFrame.nonBlackPixels / (measuredFrame.width * measuredFrame.height)).toFixed(6)),
          nonTransparentPixels: measuredFrame.nonTransparentPixels,
          maxChannel: measuredFrame.maxChannel,
          colourCountInstrument: measuredFrame.colourCountInstrument,
          colourCountCap: measuredFrame.colourCountCap,
          colourCountSaturated: measuredFrame.colourCountSaturated,
          uniqueColoursGpuReadback: measuredFrame.uniqueColoursGpuReadback,
          centre: measuredFrame.centre,
          nonBlackBoundingBox: measuredFrame.nonBlackBoundingBox,
          coverageCells: measuredFrame.coverageCells,
          coverageCellsShape: measuredFrame.coverageCellsShape,
        }),
    imageBitmapOfPresentedCanvas: {
      instrument: "createImageBitmap(canvas) → OffscreenCanvas → getImageData (ctx.readPresentedCanvas)",
      width: presentedAfter.width,
      height: presentedAfter.height,
      nonBlackPixels: presentedAfter.nonBlackPixels,
      uniqueColours: presentedAfter.uniqueColours,
      centre: presentedAfter.centre,
      note: "this route is best-effort on a WebGPU canvas (W2 measured the platform blind spot); it is published for the record and is not the coverage measurement",
    },
    canvasBackingStorePixels: viewportPixels,
  };
  step("coverage-and-depth", {
    coverage: coverage.nonBlackShare ?? coverage.skipped,
    boundingBox: coverage.nonBlackBoundingBox ?? null,
    uniqueColoursGpuReadback: coverage.uniqueColoursGpuReadback ?? null,
    imageBitmapNonBlackPixels: presentedAfter.nonBlackPixels,
    canvasDepth: canvasDepth?.measurable ?? null,
    indicator: depthIndicator.verdict ?? depthIndicator.skipped,
  });
  step("elevation-result", {
    dataset: [datasetInterval.floor, datasetInterval.ceiling],
    evidence: frameEvidence.interval === null ? null : [frameEvidence.interval.floor, frameEvidence.interval.ceiling],
    vertices: frameEvidence.verticesRead,
    extent: frameEvidence.ecef.extent,
    matchedTiles: consistency.matchedTiles,
    onGrid: consistency.verticesOnGrid,
    offGrid: consistency.verticesOffGrid,
    unmatched: consistency.verticesUnmatchable,
    withinTightAgreement: consistency.withinTightAgreement,
    withinTightShare: consistency.withinTightShare,
    beyondWideAgreement: consistency.beyondWideAgreement,
    bilinearMedianMetres: consistency.bilinearTexel?.p50 ?? null,
    nearestMedianMetres: consistency.nearestTexel?.p50 ?? null,
    bestMedianMetres: consistency.bestIn5x5Neighbourhood?.p50 ?? null,
    bestOffsets: consistency.bestOffsets,
    residualSigns: consistency.residualSigns,
    overLocalRange: consistency.residualOverLocalRange,
    perDrawLevels: consistency.byLevel,
    worst: consistency.worst.slice(0, 4),
  });

  return {
    scenario: "terrain-elevation",
    backend,
    datasetId: DATASET_ID,
    datasetRoot: DATASET_ROOT,
    camera: {
      fixed: "buildTerrainScene default (Mont Blanc, 24 km) — the MVP camera of the terrain probe",
      longitude: terrain.scene.camera.positionCartographic?.longitude ?? null,
      latitude: terrain.scene.camera.positionCartographic?.latitude ?? null,
      height: terrain.scene.camera.positionCartographic?.height ?? null,
    },
    canvas: { width: canvas.width, height: canvas.height },
    sceneBackgroundColor: { red: terrain.scene.backgroundColor?.red ?? null, green: terrain.scene.backgroundColor?.green ?? null, blue: terrain.scene.backgroundColor?.blue ?? null, alpha: terrain.scene.backgroundColor?.alpha ?? null },
    datasetInterval,
    frameEvidence,
    consistency,
    coverage,
    depth: { canvasDepth, indicator: depthIndicator },
    requestedTiles: { count: requestedTiles.length, distinct: [...new Set(requestedTiles)].length, sample: [...new Set(requestedTiles)].slice(0, 16) },
    load,
    globe: {
      tilesLoaded: terrain.scene.globe.tilesLoaded === true,
      terrainProviderName: terrain.scene.globe.terrainProvider?.constructor?.name ?? null,
      terrainProviderIsInjected: terrain.scene.globe.terrainProvider === provider,
      show: terrain.scene.globe.show,
      enableLighting: terrain.scene.globe.enableLighting,
      numberOfTilesLoaded: terrain.scene.globe._surface?._statistics?.numberOfTilesLoaded ?? null,
      numberOfCommands: terrain.scene.globe._surface?._statistics?.numberOfCommands ?? null,
      tilesToRender: terrain.scene.globe._surface?._tilesToRender?.length ?? null,
    },
    frameCounters: {
      draws: context.counters?.draws ?? null,
      drawIndexedCalls: context.counters?.drawIndexedCalls ?? null,
      passes: context.counters?.passes ?? null,
      frameErrors: typeof context.frameErrors === "function" ? context.frameErrors().length : null,
    },
    frameErrors: terrain.frameErrors,
    renderErrors: terrain.renderErrors,
    frameTimesMs: terrain.frameTimesMs.slice(-5),
    /**
     * The frozen preamble of the revised SC-002, recorded so a later reader cannot mistake this suite's
     * silence about relief for an oversight.
     */
    lightingPreamble: {
      statement: "relief / shading modulation is explicitly deferred: with fade = 0 the terrain colour is `u_initialColor * czm_lightColor`, i.e. identical at two different elevations — a single-colour terrain frame is upstream's behaviour for this camera",
      expected: "finalColor = color × lightColor (fade = 0)",
      sources: ["probe.js scenarioTerrainRasterProbe `lightingModel` step", "node_modules/@cesium/engine/Source/Shaders/GlobeFS.glsl (ENABLE_DAYNIGHT_SHADING)", "packages/cesium-webgpu/backend-webgpu/webgpu/wgsl/leaves/globe-fragment-main.wgsl"],
      assertedByThisSuite: false,
    },
  };
}

/**
 * The geodetic coordinates of an ECEF point (closed-form WGS84 inverse, Bowring).
 *
 * Deliberately written here rather than taken from `Cartesian3`/`Cartographic`: it has to be a
 * **second** arithmetic path, so a mistake in the frame evidence cannot be mirrored by the conversion
 * meant to check it.
 */
function inverseWgs84(world) {
  const a = 6378137;
  const b = 6356752.3142451793;
  const [x, y, z] = world;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const p = Math.hypot(x, y);
  const longitude = Math.atan2(y, x);
  const e2 = 1 - (b * b) / (a * a);
  const ep2 = (a * a) / (b * b) - 1;
  const theta = Math.atan2(z * a, p * b);
  const latitude = Math.atan2(z + ep2 * b * Math.sin(theta) ** 3, p - e2 * a * Math.cos(theta) ** 3);
  const sinLatitude = Math.sin(latitude);
  const normalRadius = a / Math.sqrt(1 - e2 * sinLatitude * sinLatitude);
  const degrees = (radians) => (radians * 180) / Math.PI;
  return { longitude: degrees(longitude), latitude: degrees(latitude), height: p / Math.cos(latitude) - normalRadius };
}
