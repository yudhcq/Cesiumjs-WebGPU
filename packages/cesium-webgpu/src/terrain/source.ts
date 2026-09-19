/**
 * T086 — terrain source adapter (`tasks.md` T086; `contracts/terrain-source.md` §1).
 *
 * Returns the **upstream public class** `CustomHeightmapTerrainProvider`, whose `callback(x, y, level)`
 * supplies upstream `HeightmapTerrainData`. Nothing here touches a `@private` terrain type, and no
 * credential-bearing service is involved (FR-004 / FR-031).
 *
 * Two modes:
 *   - `"fixture"` — the dataset committed under `packages/cesium-webgpu/fixtures/<datasetId>/`.
 *                   This is the ONLY mode CI and verification use, and it must work with **zero**
 *                   external requests (T087 asserts that).
 *   - `"public"`  — reserved for a login-free public raster source; never used by CI.
 *
 * ## Fixed-dataset on-disk format (verified against the committed dataset)
 *
 * `<fixtureRoot>/<datasetId>/<level>/<x>/<y>.hgt`, and `manifest.json` beside it:
 *   - each `.hgt` is **headerless little-endian `Uint16` samples**, `sampleWidth * sampleHeight` of them
 *     (the committed dataset is 97x97 => 9409 samples => 18818 bytes);
 *   - `height_metres = raw + manifest.heightOffsetMetres`;
 *   - `manifest.noDataValue` marks a missing sample;
 *   - **row 0 is the NORTH edge, column 0 is the WEST edge**.
 *
 * The row order was not assumed: under "row 0 = north" the elevation peak of *every* level of the
 * committed dataset lands on the same summit (Mont Blanc, 6.864 E / 45.8325 N — levels 9/10/11/12
 * agree within 10 m), whereas the south-first reading scatters the peak across four different
 * latitudes. `tests/unit/terrain-source.test.mjs` re-derives that from the committed bytes so the
 * orientation cannot silently regress.
 */

import {
  Credit,
  CustomHeightmapTerrainProvider,
  GeographicTilingScheme,
} from "@cesium/engine";

/** Which dataset backs the provider. `"public"` is never exercised by CI (contract TS-11). */
export type TerrainSourceMode = "fixture" | "public";

/** One committed tile, as listed by `manifest.json`. */
export interface TerrainDatasetTile {
  readonly level: number;
  readonly x: number;
  readonly y: number;
  readonly path: string;
}

/** The subset of `manifest.json` this adapter relies on. Extra fields are ignored. */
export interface TerrainDatasetManifest {
  readonly datasetId: string;
  readonly encoding: string;
  readonly byteOrder: string;
  readonly sampleType: string;
  readonly noDataValue: number;
  readonly heightOffsetMetres: number;
  readonly sampleWidth: number;
  readonly sampleHeight: number;
  readonly levels: readonly number[];
  /** The exact set of committed tiles; the only authoritative answer for availability (contract T-3). */
  readonly tiles?: readonly TerrainDatasetTile[];
  readonly levelSummary?: readonly { level: number; minHeight: number; maxHeight: number }[];
  readonly tileCount?: number;
  readonly totalBytes?: number;
  readonly attribution?: string;
}

/** Reads one tile's raw bytes. Injectable so unit tests can serve memory and prove zero I/O. */
export type TileReader = (tilePath: string) => Promise<Uint8Array> | Uint8Array;

export interface CreateTerrainProviderOptions {
  readonly mode: TerrainSourceMode;
  readonly datasetId: string;
  readonly tilingScheme?: GeographicTilingScheme;
  readonly credit?: Credit | string;
  /**
   * Where the fixture lives, as a URL prefix (browser) — joined with `<level>/<x>/<y>.hgt`.
   * Ignored when `readTile` is supplied.
   */
  readonly fixtureBaseUrl?: string;
  /** Overrides the default reader. Tests inject a memory reader to assert zero network traffic. */
  readonly readTile?: TileReader;
}

/** Raised when the dataset or a tile cannot be read. Carries the upstream-compatible category. */
export class TerrainSourceError extends Error {
  readonly category: "data-unavailable" | "decode";

  constructor(category: "data-unavailable" | "decode", message: string) {
    super(message);
    this.name = "TerrainSourceError";
    this.category = category;
  }
}

/** Joins a base URL (or directory) and a relative tile path without doubling or dropping separators. */
function joinPath(base: string, relative: string): string {
  if (base.length === 0) {
    return relative;
  }
  const left = base.endsWith("/") ? base.slice(0, -1) : base;
  const right = relative.startsWith("/") ? relative.slice(1) : relative;
  return `${left}/${right}`;
}

/** Default reader: plain `fetch`, available in the browser and in Node >= 18. */
function fetchTileReader(): TileReader {
  return async (tilePath: string): Promise<Uint8Array> => {
    const response = await fetch(tilePath);
    if (!response.ok) {
      throw new TerrainSourceError(
        "data-unavailable",
        `terrain tile request failed: ${response.status} ${response.statusText} for ${tilePath}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

/**
 * Decodes headerless little-endian `Uint16` samples into heights in metres.
 *
 * `noDataValue` samples are replaced by the tile's own minimum valid height so that no `NaN`,
 * `Infinity` or out-of-range spike can reach the vertex stage (contract T-6). A tile with **no**
 * valid sample is not decodable and yields `undefined`, which the provider reports as "no data"
 * rather than as a rendering failure.
 */
export function decodeHeightmapTile(
  bytes: Uint8Array,
  manifest: Pick<TerrainDatasetManifest, "sampleWidth" | "sampleHeight" | "noDataValue" | "heightOffsetMetres">,
): Float32Array | undefined {
  const expected = manifest.sampleWidth * manifest.sampleHeight;
  if (bytes.byteLength !== expected * 2) {
    throw new TerrainSourceError(
      "decode",
      `terrain tile is ${bytes.byteLength} bytes; expected ${expected * 2} for ${manifest.sampleWidth}x${manifest.sampleHeight} Uint16 samples`,
    );
  }

  // Copy into an aligned buffer: the incoming view may start at an odd byte offset.
  const samples = new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

  let minimumValid = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    if (value !== undefined && value !== manifest.noDataValue && value < minimumValid) {
      minimumValid = value;
    }
  }
  if (!Number.isFinite(minimumValid)) {
    return undefined;
  }

  const heights = new Float32Array(expected);
  for (let i = 0; i < expected; i += 1) {
    const value = samples[i];
    const raw = value === undefined || value === manifest.noDataValue ? minimumValid : value;
    heights[i] = raw + manifest.heightOffsetMetres;
  }
  return heights;
}

/** Reads and parses the dataset manifest through the same reader (so tests stay offline). */
async function readManifest(
  manifestPath: string,
  readText: (path: string) => Promise<string>,
): Promise<TerrainDatasetManifest> {
  let text: string;
  try {
    text = await readText(manifestPath);
  } catch (cause) {
    throw new TerrainSourceError("data-unavailable", `cannot read terrain manifest ${manifestPath}: ${String(cause)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new TerrainSourceError("decode", `terrain manifest ${manifestPath} is not valid JSON: ${String(cause)}`);
  }
  const manifest = parsed as Partial<TerrainDatasetManifest>;
  for (const key of ["sampleWidth", "sampleHeight", "noDataValue", "heightOffsetMetres", "levels"] as const) {
    if (manifest[key] === undefined) {
      throw new TerrainSourceError("decode", `terrain manifest ${manifestPath} is missing "${key}"`);
    }
  }
  return manifest as TerrainDatasetManifest;
}

/**
 * Builds the terrain provider.
 *
 * The returned object is an upstream `CustomHeightmapTerrainProvider`; callers never see a
 * `@private` terrain type, and no request is issued until upstream asks for a tile.
 */
export async function createTerrainProvider(
  options: CreateTerrainProviderOptions,
): Promise<CustomHeightmapTerrainProvider> {
  const tilingScheme = options.tilingScheme ?? new GeographicTilingScheme();
  const credit = options.credit ?? new Credit("Terrain Tiles (terrarium) by Mapzen/Joerd (AWS Open Data)");

  if (options.mode === "public" && options.datasetId.trim().length === 0) {
    throw new TerrainSourceError("data-unavailable", 'mode "public" requires a datasetId naming the public dataset');
  }

  const fixtureBaseUrl = options.fixtureBaseUrl ?? "";
  const readTileBytes: TileReader = options.readTile ?? fetchTileReader();
  const readText = async (path: string): Promise<string> => {
    const bytes = await readTileBytes(path);
    return new TextDecoder().decode(bytes);
  };

  const datasetRoot = joinPath(fixtureBaseUrl, options.datasetId);
  const manifest = await readManifest(joinPath(datasetRoot, "manifest.json"), readText);

  // Availability is answered from the committed tile list, never invented (contract T-3).
  const availableTiles = new Set((manifest.tiles ?? []).map((tile) => `${tile.level}/${tile.x}/${tile.y}`));
  const hasExplicitTileList = availableTiles.size > 0;
  const floorHeight = manifest.levelSummary?.[0]?.minHeight ?? 0;

  const provider = new CustomHeightmapTerrainProvider({
    tilingScheme,
    credit,
    width: manifest.sampleWidth,
    height: manifest.sampleHeight,
    // NOTE (verified against upstream; a correction to the `tasks.md` T086 wording):
    // `CustomHeightmapTerrainProvider`'s callback returns the **raw height samples**, not a
    // `HeightmapTerrainData`. The provider builds that object itself — and it does so with no
    // `structure`, i.e. `heightScale: 1` / `heightOffset: 0`
    // (`Source/Core/CustomHeightmapTerrainProvider.js:237-241`). The values we return are therefore
    // the heights **in metres**, row-major, row 0 = north (`manifest.sampleGrid.orientation`).
    callback: async (x: number, y: number, level: number): Promise<Float32Array> => {
      const tilePath = joinPath(datasetRoot, `${level}/${x}/${y}.hgt`);
      let bytes: Uint8Array;
      try {
        bytes = await readTileBytes(tilePath);
      } catch {
        // Defensive only: `getTileDataAvailable` below means upstream should not ask for a tile we
        // do not have. A flat buffer at the dataset floor still yields no NaN and no error geometry
        // (contract T-6), and never a silent spike.
        return new Float32Array(manifest.sampleWidth * manifest.sampleHeight).fill(floorHeight);
      }

      return decodeHeightmapTile(bytes, manifest) ?? new Float32Array(manifest.sampleWidth * manifest.sampleHeight).fill(floorHeight);
    },
  });

  // Upstream's default returns `undefined`, i.e. "availability not supported". Answering instead from
  // the committed manifest is what keeps a tile we do not own from ever reaching the callback.
  provider.getTileDataAvailable = (x: number, y: number, level: number): boolean | undefined => {
    if (hasExplicitTileList) {
      return availableTiles.has(`${level}/${x}/${y}`);
    }
    return manifest.levels.includes(level) ? undefined : false;
  };

  return provider;
}
