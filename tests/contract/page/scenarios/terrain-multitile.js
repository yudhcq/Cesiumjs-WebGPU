/**
 * `terrain-multitile` — the **fixed visual case** of T092 (`层=视觉`).
 *
 * ## What this scenario is for
 *
 * T092 compares a **reference frame per backend** against a fresh frame of the *same* backend, offline
 * (never in one frame, never across backends). That comparison is only meaningful if the run it
 * compares *against a reference* is reproducible: the same dataset, camera, instant, viewport, pixel
 * ratio and settle procedure every time. This module produces exactly that run and publishes the
 * evidence the suite asserts on:
 *
 *   - the **rendered tiles** with their `level/x/y` and geographic rectangle (multi-tile evidence),
 *   - that every rendered tile is a **committed dataset tile** (answered by the product provider's own
 *     `getTileDataAvailable`, not by a second copy of the tile list),
 *   - the frame/context facts that make the case reproducible (camera echo, canvas backing size, device
 *     pixel ratio, MSAA sample count, measured frame errors),
 *   - the settled state the frame was captured in (`globe.tilesLoaded === true` after the extra settle
 *     frames, not only before them).
 *
 * ## Why the camera is *not* the probe default
 *
 * `buildTerrainScene`'s default camera ({6.8652, 45.8326, 24000 m, pitch −50°}) looks almost straight
 * down at a globe with `baseLayer: false`: with the elevation/lighting increment explicitly deferred,
 * the surface renders as the **unmodulated base colour**, so that view is a nearly uniform field
 * (measured on the committed `artifacts/terrain-offline/webgpu-canvas.png`: 97 % of the pixels are one
 * single colour). A uniform field cannot regress visibly. This case therefore stands *outside* the
 * massif looking at it, so the frame contains the one structure the current baseline state really has:
 * the **terrain silhouette against the background** — the geometry itself.
 *
 * ## Module rules
 *
 * Scenario modules import **nothing** (`probe.js` calls `main()` on import); every helper arrives
 * through `ctx`. The default export is `(bundle, canvas, ctx) => result`; the page publishes the
 * returned object under `report.result["terrain-multitile"]`.
 */

/** The committed dataset; also the directory the reference frames live under (T092's path rule). */
const DATASET_ID = "matterhorn-z0-12";
/** The directory the *datasets* live in — the adapter appends `<datasetId>` itself (measured, T087). */
const FIXTURE_BASE_URL = "/packages/cesium-webgpu/fixtures";

/**
 * Fixed camera: 24 km above the summit (6.8652 E / 45.8326 N), heading 0 (north), pitch −50° — the
 * geometry whose settled frame is **measured** to fit the frame budget and to load in a few frames
 * (`artifacts/terrain-offline`: `tilesToRenderLength: 6`, `tilesLoaded: true` after 476 ms, zero render
 * errors; the same camera at 5.2 km / pitch −6 drove refinement to level 13 — a level the committed
 * dataset does not contain — and overflowed the uniform ring buffer: 1498 render errors, blank frame).
 *
 * Consequence, stated up front so nobody reads more into the reference frames than they carry: with the
 * elevation/lighting increment explicitly deferred and no imagery layer, this frame is a nearly uniform
 * surface (measured: one colour covers ~97 % of it) plus the page's credit overlay. The reference frames
 * therefore record the *current* baseline state, not visible relief — see the suite's baseline note.
 *
 * Every number here is part of the case's identity: changing one MUST regenerate both backends'
 * reference frames (T092's baseline rule).
 */
const CAMERA = Object.freeze({ longitude: 6.8652, latitude: 45.8326, height: 24000, heading: 0, pitch: -50, roll: 0 });

/** `probe.js` renders every frame at this instant (verified in `renderFrames`); reported for the record. */
const DATE_ISO = "2026-03-20T12:00:00Z";

/** Extra frames after `tilesLoaded`, so the compared frame is a settled one and not a mid-refine one. */
const SETTLE_FRAMES = 4;
const SETTLE_MS = 16;

export default async function terrainMultitileScenario(bundle, canvas, ctx) {
  const { backend, step, report, buildTerrainScene, renderUntilTilesLoaded } = ctx;

  // The product terrain adapter over the committed dataset (mode "fixture"), with the same default
  // reader (`fetch`) the shipped path uses — so every tile really is fetched over HTTP from this run's
  // own static server.
  const tileDiagnostics = [];
  const provider = await bundle.terrainSource.createTerrainProvider({
    mode: "fixture",
    datasetId: DATASET_ID,
    fixtureBaseUrl: FIXTURE_BASE_URL,
    onTileDiagnostic: (diagnostic) => tileDiagnostics.push(diagnostic),
  });

  /**
   * Record what the globe asks the product provider for, through the upstream public
   * `requestTileGeometry(x, y, level, request)` method — the data path itself is untouched.
   */
  const requestedTiles = [];
  const originalRequestTileGeometry = provider.requestTileGeometry.bind(provider);
  provider.requestTileGeometry = (x, y, level, request) => {
    requestedTiles.push(`${level}/${x}/${y}`);
    return originalRequestTileGeometry(x, y, level, request);
  };

  const terrain = await buildTerrainScene(bundle, canvas, { provider, camera: CAMERA });
  /**
   * Silent-path guard (workspace rule, measured lesson): the replacement `Context` takes its device
   * from the hand-off slot, and an **empty** slot makes it delegate the whole run to upstream WebGL2 —
   * without any error, until `new Scene()` throws. `buildTerrainScene` installs the slot, so the active
   * path is verified here instead of assumed: the WebGPU arm MUST have published adapter info (only the
   * WebGPU branch does) and the context MUST report a sample count, while the WebGL2 arm MUST NOT have
   * one. The suite's `assertOtherBackendUntouched` complements this from the platform counters.
   */
  const environment = report.environment ?? {};
  if (backend === "webgl2") {
    if (environment.adapterInfo !== null) throw new Error("this WebGL2 run published a WebGPU adapter — the run switched paths");
  } else if (environment.adapterInfo === null || environment.adapterInfo === undefined) {
    throw new Error("this WebGPU run has no adapter info: the hand-off slot was empty and the run silently delegated (see the plan's D2-a)");
  }
  const load = await renderUntilTilesLoaded(terrain, 30000);
  step("tiles-loaded", load);
  // The compositor needs more than one frame on a WebGPU canvas (W2's measurement), and the harness
  // screenshots the canvas right after the page reports ready — so settle the *last* frame before
  // publishing, and re-check that the globe is still settled at that point.
  await terrain.renderFrames(SETTLE_FRAMES, SETTLE_MS);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const scene = terrain.scene;
  const surface = scene.globe._surface;
  const context = scene.context;

  /** The tiles the last rendered frame selected, deduplicated by `level/x/y`. */
  const renderedByKey = new Map();
  for (const tile of surface?._tilesToRender ?? []) {
    if (tile === undefined || tile === null) continue;
    const key = `${tile.level}/${tile.x}/${tile.y}`;
    if (renderedByKey.has(key)) continue;
    const rectangle = tile.rectangle;
    const terrainState = tile.data?.terrainState ?? null;
    renderedByKey.set(key, {
      key,
      level: tile.level,
      x: tile.x,
      y: tile.y,
      // The product provider's own answer to "is this a committed dataset tile?" (contract T-3).
      availableInDataset: provider.getTileDataAvailable(tile.x, tile.y, tile.level) === true,
      hasTerrainData: tile.data !== undefined && tile.data !== null,
      /**
       * `GlobeSurfaceTile.TerrainState.READY === 6` (upstream `Source/Scene/TerrainState.js`:
       * `FAILED:0, UNLOADED:1, RECEIVING:2, RECEIVED:3, TRANSFORMING:4, TRANSFORMED:5, READY:6`): the
       * tile's geometry is built and it is what the tile provider draws. Selected-but-unloadable tiles
       * (e.g. a refinement level the dataset does not contain) also appear in `_tilesToRender`, so the
       * "participating tiles" evidence is taken from this state rather than from the raw selection.
       */
      terrainState,
      drawable: terrainState === 6,
      rectangle:
        rectangle === undefined || rectangle === null
          ? null
          : {
              // `Rectangle` is in **radians**; the case is documented in degrees, so it is converted here
              // (the suite re-derives the same numbers from `level/x/y` and the geographic grid).
              west: Number(((rectangle.west * 180) / Math.PI).toFixed(6)),
              south: Number(((rectangle.south * 180) / Math.PI).toFixed(6)),
              east: Number(((rectangle.east * 180) / Math.PI).toFixed(6)),
              north: Number(((rectangle.north * 180) / Math.PI).toFixed(6)),
            },
    });
  }
  const renderedTiles = [...renderedByKey.values()];
  const requestedSet = new Set(requestedTiles);
  for (const tile of renderedTiles) tile.requestedFromProvider = requestedSet.has(tile.key);
  /** The tiles that really took part in the frame: selected *and* geometry-ready (`TerrainState.READY`). */
  const participating = renderedTiles.filter((tile) => tile.drawable === true);

  const requestedTilesByLevel = {};
  for (const key of new Set(requestedTiles)) {
    const level = key.split("/")[0];
    requestedTilesByLevel[level] = (requestedTilesByLevel[level] ?? 0) + 1;
  }

  const result = {
    scenario: "terrain-multitile",
    backend,
    caseId: "matterhorn-multitile",
    datasetId: DATASET_ID,
    fixtureBaseUrl: FIXTURE_BASE_URL,
    dateIso: DATE_ISO,
    camera: { ...CAMERA },
    // The frame's fixed raster conditions. `pixelRatio` is asserted to be 1 by the suite: the harness
    // screenshots the canvas region at 1x, so a device pixel ratio ≠ 1 would silently rescale the
    // comparison; the canvas backing size and the CSS size are both reported so that is checkable.
    viewport: {
      width: canvas.width,
      height: canvas.height,
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
      devicePixelRatio: globalThis.devicePixelRatio,
    },
    settle: { frames: SETTLE_FRAMES, settleMs: SETTLE_MS, tilesLoadedAfterSettle: scene.globe.tilesLoaded === true },
    context: {
      constructorName: context?.constructor?.name ?? null,
      sampleCount: context?.sampleCount ?? null,
      msaa: context?.msaa ?? null,
      swapchainFormat: context?.swapchainFormat ?? null,
      logarithmicDepthBuffer: scene.logarithmicDepthBuffer === true,
    },
    sceneConfiguration: {
      baseLayer: false,
      skyBoxPresent: scene.skyBox !== undefined && scene.skyBox !== null,
      skyAtmospherePresent: scene.skyAtmosphere !== undefined && scene.skyAtmosphere !== null,
      imageryLayerCount: scene.imageryLayers?.length ?? null,
      globeShow: scene.globe.show === true,
      globeEnableLighting: scene.globe.enableLighting === true,
      globeDepthTestAgainstTerrain: scene.globe.depthTestAgainstTerrain === true,
      backgroundColor: scene.backgroundColor
        ? { red: scene.backgroundColor.red, green: scene.backgroundColor.green, blue: scene.backgroundColor.blue, alpha: scene.backgroundColor.alpha }
        : null,
      terrainProviderIsProduct: scene.terrainProvider === provider,
      terrainProviderName: scene.terrainProvider?.constructor?.name ?? null,
    },
    tiles: {
      renderedCount: renderedTiles.length,
      renderedKeys: renderedTiles.map((tile) => tile.key),
      renderedTiles: renderedTiles.slice(0, 24),
      renderedByLevel: renderedTiles.reduce((accumulator, tile) => {
        accumulator[tile.level] = (accumulator[tile.level] ?? 0) + 1;
        return accumulator;
      }, {}),
      allRenderedTilesAvailable: renderedTiles.every((tile) => tile.availableInDataset === true),
      allRenderedTilesRequested: renderedTiles.every((tile) => tile.requestedFromProvider === true),
      allRenderedTilesHaveData: renderedTiles.every((tile) => tile.hasTerrainData === true),
      // The **participating** tiles: selected AND geometry-ready. These are the tiles the multi-tile
      // claim is made about; the raw selection is kept above so nothing is hidden by the filter.
      participatingCount: participating.length,
      participatingKeys: participating.map((tile) => tile.key),
      participatingTiles: participating,
      participatingByLevel: participating.reduce((accumulator, tile) => {
        accumulator[tile.level] = (accumulator[tile.level] ?? 0) + 1;
        return accumulator;
      }, {}),
      /**
       * The subset that really is a **committed dataset tile** fetched over HTTP. The rest of the
       * participating tiles are the upsampled edge of the dataset (upstream draws them from an available
       * ancestor), which is why the two are reported separately instead of being asserted as one thing.
       */
      realTileKeys: participating.filter((tile) => tile.availableInDataset === true && tile.requestedFromProvider === true).map((tile) => tile.key),
      realTileCount: participating.filter((tile) => tile.availableInDataset === true && tile.requestedFromProvider === true).length,
      upsampledTileKeys: participating.filter((tile) => tile.availableInDataset !== true || tile.requestedFromProvider !== true).map((tile) => tile.key),
      allParticipatingHaveData: participating.length > 0 && participating.every((tile) => tile.hasTerrainData === true),
      terrainStateDistribution: renderedTiles.reduce((accumulator, tile) => {
        accumulator[String(tile.terrainState)] = (accumulator[String(tile.terrainState)] ?? 0) + 1;
        return accumulator;
      }, {}),
      requestedDistinct: requestedSet.size,
      requestedTilesByLevel,
      requestedSample: [...requestedSet].slice(0, 24),
      numberOfTilesLoaded: surface?._statistics?.numberOfTilesLoaded ?? null,
      numberOfCommands: surface?._statistics?.numberOfCommands ?? null,
      tileDiagnostics: tileDiagnostics.slice(0, 12),
      tileDiagnosticCount: tileDiagnostics.length,
    },
    load,
    frameErrors: terrain.frameErrors,
    renderErrors: terrain.renderErrors,
    frameTimesMs: terrain.frameTimesMs.slice(-5),
    probe: {
      bbox: { x: 0, y: 0, width: canvas.clientWidth, height: canvas.clientHeight },
      // The screenshot is a **page** screenshot clipped to the canvas, so DOM overlays inside the
      // container (upstream's credit display) are part of the compared frame. Their text is part of the
      // case's identity: the suite records it in the fixed conditions, so a credit change is a
      // condition change that MUST be re-baselined rather than a silent pixel difference.
      pageOverlayText: (canvas.parentElement?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      cameraEcho: {
        longitude: scene.camera.positionCartographic
          ? (scene.camera.positionCartographic.longitude * 180) / Math.PI
          : null,
        latitude: scene.camera.positionCartographic
          ? (scene.camera.positionCartographic.latitude * 180) / Math.PI
          : null,
        height: scene.camera.positionCartographic?.height ?? null,
        headingDegrees: scene.camera.heading !== undefined ? (scene.camera.heading * 180) / Math.PI : null,
        pitchDegrees: scene.camera.pitch !== undefined ? (scene.camera.pitch * 180) / Math.PI : null,
      },
    },
  };
  step("multitile-result", {
    renderedTiles: result.tiles.renderedCount,
    renderedByLevel: result.tiles.renderedByLevel,
    available: result.tiles.allRenderedTilesAvailable,
    tilesLoaded: result.settle.tilesLoadedAfterSettle,
    renderErrors: result.renderErrors.length,
  });
  return result;
}
