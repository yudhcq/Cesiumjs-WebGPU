/**
 * `terrain-offline` — T087 (FR-012): the terrain acceptance case must complete with **zero external
 * requests**, and must still complete when every non-local request is refused.
 *
 * ## Why this scenario does not use the probe's default provider
 *
 * `buildTerrainScene`'s default provider is an **analytic** height field: its callback computes the
 * samples in the page (`ctx.analyticHeightmap`) and therefore can never issue a request, whatever the
 * network does. Asserting "zero external requests" against it would be true by construction — a
 * statement with no discriminating power. This scenario instead drives the **product** terrain adapter
 * (`packages/cesium-webgpu/src/terrain/source.ts`, `mode: "fixture"`, `datasetId: "matterhorn-z0-12"`)
 * over the committed dataset, so the tile data really is fetched over HTTP from this run's own static
 * server. Every request in the run is then a real one and "zero external requests" is a measurement of
 * traffic that could have left the machine.
 *
 * ## Module rules
 *
 * Scenario modules import **nothing** (`probe.js` calls `main()` on import), so every helper arrives
 * through `ctx`. The default export is `(bundle, canvas, ctx) => result`; the page publishes the
 * returned object under `report.result["terrain-offline"]`.
 */
export default async function terrainOfflineScenario(bundle, canvas, ctx) {
  const { backend, step, buildTerrainScene, renderUntilTilesLoaded } = ctx;

  const DATASET_ID = "matterhorn-z0-12";
  const DATASET_DIRECTORY = `/packages/cesium-webgpu/fixtures/${DATASET_ID}`;

  /**
   * The adapter resolves its dataset root as `joinPath(fixtureBaseUrl, datasetId)`, i.e. `fixtureBaseUrl`
   * names the directory the *datasets live in* (`.../fixtures`), not the dataset itself. The dispatch
   * note for this task quoted the dataset directory as the base, so both readings are tried and the one
   * the adapter actually accepts is recorded — a wrong base can then never be mistaken for "the dataset
   * is missing", and the run states which convention it used instead of assuming one.
   */
  const FIXTURE_BASE_CANDIDATES = [
    { convention: "fixture-root (base + datasetId)", baseUrl: "/packages/cesium-webgpu/fixtures" },
    { convention: "dataset-directory (base is the dataset)", baseUrl: DATASET_DIRECTORY },
  ];

  const fixtureBaseAttempts = [];
  let provider = null;
  let fixtureBaseUrl = null;
  let fixtureBaseConvention = null;
  for (const candidate of FIXTURE_BASE_CANDIDATES) {
    try {
      // No `readTile` is injected: the adapter's own default reader (plain `fetch`) is what issues the
      // tile requests, which is exactly what the network-level assertion has to observe.
      provider = await bundle.terrainSource.createTerrainProvider({
        mode: "fixture",
        datasetId: DATASET_ID,
        fixtureBaseUrl: candidate.baseUrl,
        credit: "Terrain Tiles (terrarium) by Mapzen/Joerd (AWS Open Data) — fixed dataset matterhorn-z0-12",
      });
      fixtureBaseUrl = candidate.baseUrl;
      fixtureBaseConvention = candidate.convention;
      fixtureBaseAttempts.push({ convention: candidate.convention, baseUrl: candidate.baseUrl, ok: true });
      break;
    } catch (error) {
      fixtureBaseAttempts.push({
        convention: candidate.convention,
        baseUrl: candidate.baseUrl,
        ok: false,
        name: error?.name ?? "Error",
        category: error?.category ?? null,
        message: String(error?.message ?? error).slice(0, 240),
      });
    }
  }
  if (provider === null) {
    throw new Error(`the committed fixture dataset could not be read through the product adapter: ${JSON.stringify(fixtureBaseAttempts)}`);
  }

  const providerIdentity = {
    constructorName: provider?.constructor?.name ?? null,
    isUpstreamHeightmapProvider: provider instanceof bundle.CustomHeightmapTerrainProvider,
    adapterModule: "packages/cesium-webgpu/src/terrain/source.ts",
    adapterFunction: "createTerrainProvider",
    mode: "fixture",
    datasetId: DATASET_ID,
    fixtureBaseUrl,
    fixtureBaseConvention,
    // Availability answered from the committed tile list (contract T-3) rather than invented.
    hasTileAvailability: typeof provider.getTileDataAvailable === "function",
    readTileInjected: false,
  };
  step("offline-provider", providerIdentity);

  /**
   * Count the tiles the globe asks the **product** provider for, through the upstream public
   * `requestTileGeometry(x, y, level, request)` method. `buildTerrainScene` only fills its own
   * `requestedTiles` for the analytic provider, so the count has to come from the injected one;
   * wrapping the public method leaves the data path itself untouched.
   */
  const requestedTiles = [];
  const originalRequestTileGeometry = provider.requestTileGeometry.bind(provider);
  provider.requestTileGeometry = (x, y, level, request) => {
    requestedTiles.push(`${level}/${x}/${y}`);
    return originalRequestTileGeometry(x, y, level, request);
  };

  const terrain = await buildTerrainScene(bundle, canvas, { provider });
  const load = await renderUntilTilesLoaded(terrain, 30000);
  step("tiles-loaded", load);
  // The compositor needs more than one frame on a WebGPU canvas, and the harness screenshots the canvas
  // right after the page reports ready, so settle on the last frame before publishing.
  await terrain.renderFrames(3, 16);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const distinctTiles = [...new Set(requestedTiles)];
  const requestedTilesByLevel = {};
  for (const tile of distinctTiles) {
    const level = tile.split("/")[0];
    requestedTilesByLevel[level] = (requestedTilesByLevel[level] ?? 0) + 1;
  }
  const surface = terrain.scene.globe._surface;
  const result = {
    scenario: "terrain-offline",
    backend,
    datasetId: DATASET_ID,
    datasetDirectory: DATASET_DIRECTORY,
    fixtureBaseUrl,
    fixtureBaseConvention,
    fixtureBaseAttempts,
    provider: providerIdentity,
    requestedTiles: requestedTiles.length,
    distinctRequestedTiles: distinctTiles.length,
    requestedTilesByLevel,
    requestedTileSample: distinctTiles.slice(0, 12),
    tilesLoaded: load.tilesLoaded,
    globeTilesLoaded: terrain.scene.globe.tilesLoaded === true,
    globeTerrainProviderIsInjected: terrain.scene.terrainProvider === provider,
    load,
    globeDiagnostics: {
      show: terrain.scene.globe.show,
      terrainProviderName: terrain.scene.globe.terrainProvider?.constructor?.name ?? null,
      numberOfTilesLoaded: surface?._statistics?.numberOfTilesLoaded ?? null,
      numberOfCommands: surface?._statistics?.numberOfCommands ?? null,
      tilesToRenderLength: surface?._tilesToRender?.length ?? null,
    },
    frameErrors: terrain.frameErrors,
    renderErrors: terrain.renderErrors,
    frameTimesMs: terrain.frameTimesMs.slice(-5),
  };
  step("offline-result", {
    requestedTiles: result.requestedTiles,
    distinctRequestedTiles: result.distinctRequestedTiles,
    tilesLoaded: result.tilesLoaded,
    renderErrors: result.renderErrors.length,
  });
  return result;
}
