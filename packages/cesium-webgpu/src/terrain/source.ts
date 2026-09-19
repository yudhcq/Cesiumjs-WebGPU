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
 *
 * ## Data unavailability is an observable state, not a thrown error (T088, FR-004 / TS-5)
 *
 * A tile that is missing from the dataset, that the reader fails to deliver, or that never settles
 * within `tileTimeoutMs`, is classified and reported through `onTileDiagnostic` with
 * `category: "data-unavailable"`, and upstream still receives a usable flat buffer. The same holds for
 * a well-formed tile with no valid sample. A tile whose bytes *are* readable but not decodable is
 * reported with the **different** `"decode"` category — which is what keeps "data-unavailable" a
 * measurement rather than a constant, and keeps it distinct from a render failure (a data problem is
 * never thrown, so it can never surface on the scene's error channel).
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

/**
 * Which fault a tile diagnostic describes (T088; FR-004 / contract TS-5).
 *
 * `"missing" | "reader-error" | "timeout" | "empty"` are the four ways a tile's **data** can be
 * unavailable; `"decode-error"` is the one non-data fault this layer can classify, and it exists so
 * that "data unavailable" is a *measured* classification rather than a constant label.
 */
export type TerrainTileFailure = "missing" | "reader-error" | "timeout" | "empty" | "decode-error";

/**
 * One failed tile, reported through {@link CreateTerrainProviderOptions.onTileDiagnostic}.
 *
 * A tile that cannot be read MUST NOT throw out of the provider callback: upstream receives a flat
 * buffer at the dataset floor instead, so the remaining tiles keep rendering and no error geometry
 * (NaN, spike, self-intersection) can be built from it.
 */
export interface TerrainTileDiagnostic {
  readonly level: number;
  readonly x: number;
  readonly y: number;
  /** The exact path that was handed to the reader (dataset-relative when no base URL is configured). */
  readonly tilePath: string;
  /**
   * `"data-unavailable"` — the tile's data cannot be obtained (missing from the dataset, the reader
   * failed, the read timed out, or the tile carries no valid sample). This is the FR-004
   * "data unavailable" state, and it is deliberately NOT a render-failure category: rendering
   * continues with the neighbours, so nothing is dropped and nothing fails.
   * `"decode"` — the bytes *were* obtained but are not decodable. A different category, on purpose:
   * the classification is only evidence of "distinguishable" if it can take more than one value.
   */
  readonly category: "data-unavailable" | "decode";
  readonly failure: TerrainTileFailure;
  readonly reason: string;
}

export interface CreateTerrainProviderOptions {
  readonly mode: TerrainSourceMode;
  readonly datasetId: string;
  readonly tilingScheme?: GeographicTilingScheme;
  readonly credit?: Credit | string;
  /**
   * Where the fixture lives, as a URL prefix (browser) — joined with `<datasetId>/<level>/<x>/<y>.hgt`.
   * Ignored when `readTile` is supplied.
   */
  readonly fixtureBaseUrl?: string;
  /** Overrides the default reader. Tests inject a memory reader to assert zero network traffic. */
  readonly readTile?: TileReader;
  /**
   * How long a single tile read may take before it is classified `data-unavailable`
   * (`failure: "timeout"`). `0`, a negative number or a non-finite value disables the bound.
   */
  readonly tileTimeoutMs?: number;
  /**
   * Observability hook (FR-004 / TS-5): called once per failed tile with a classified diagnostic.
   *
   * Data problems are reported here and never thrown; a throwing observer MUST NOT break rendering
   * either (observing a failure may not cause one), so the call is guarded.
   */
  readonly onTileDiagnostic?: (diagnostic: TerrainTileDiagnostic) => void;
}

/**
 * A local fixture tile that needs longer than this is not slow, it is unreachable (T088).
 *
 * Bounded by default so a stalled read cannot leave a tile pending forever — which is exactly the
 * "page hangs" failure mode FR-004 forbids.
 */
export const DEFAULT_TILE_TIMEOUT_MS = 15_000;

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

/** Distinguishes "the read took too long" from "the read failed", without matching message text. */
class TileReadTimeoutError extends Error {
  constructor(tilePath: string, timeoutMs: number) {
    super(`reading ${tilePath} did not settle within ${timeoutMs} ms`);
    this.name = "TileReadTimeoutError";
  }
}

/**
 * Await one tile read, bounded by `timeoutMs` (`<= 0` or non-finite disables the bound).
 *
 * The read keeps a no-op rejection handler of its own: when the timeout wins the race the read may
 * still reject afterwards, and a late unhandled rejection surfaces as an uncaught page error in a
 * browser — i.e. a data problem would turn into exactly the "render failure" it must stay distinct
 * from. The timer is always cleared, so no run is kept alive by a settled tile.
 */
async function readTileWithin(readTile: TileReader, tilePath: string, timeoutMs: number): Promise<Uint8Array> {
  const read = Promise.resolve().then(() => readTile(tilePath));
  void read.catch(() => {});
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    return read;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TileReadTimeoutError(tilePath, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  const tileTimeoutMs = options.tileTimeoutMs ?? DEFAULT_TILE_TIMEOUT_MS;
  // The manifest goes through the same bounded read: a manifest request that never settles must not
  // turn "the dataset is unreachable" into a page that never becomes ready.
  const readText = async (path: string): Promise<string> => {
    const bytes = await readTileWithin(readTileBytes, path, tileTimeoutMs);
    return new TextDecoder().decode(bytes);
  };

  const datasetRoot = joinPath(fixtureBaseUrl, options.datasetId);
  const manifest = await readManifest(joinPath(datasetRoot, "manifest.json"), readText);

  // Availability is answered from the committed tile list, never invented (contract T-3).
  const availableTiles = new Set((manifest.tiles ?? []).map((tile) => `${tile.level}/${tile.x}/${tile.y}`));
  const hasExplicitTileList = availableTiles.size > 0;
  const floorHeight = manifest.levelSummary?.[0]?.minHeight ?? 0;
  const onTileDiagnostic = options.onTileDiagnostic;

  /**
   * Report one failed tile and hand upstream the only thing that is safe to render without data: a
   * flat buffer at the dataset floor. Finite, uniform, and identical in shape to a real tile, so it
   * can produce neither NaN vertices nor a spike (contract T-6) — and it keeps the *other* tiles
   * unaffected, because nothing here rejects.
   */
  const degrade = (
    x: number,
    y: number,
    level: number,
    tilePath: string,
    category: TerrainTileDiagnostic["category"],
    failure: TerrainTileFailure,
    reason: string,
  ): Float32Array => {
    if (onTileDiagnostic !== undefined) {
      try {
        onTileDiagnostic(Object.freeze({ level, x, y, tilePath, category, failure, reason }));
      } catch {
        // Observing a failure MUST NOT become one: a broken observer cannot break rendering.
      }
    }
    return new Float32Array(manifest.sampleWidth * manifest.sampleHeight).fill(floorHeight);
  };

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
    //
    // T088 / FR-004: every failure below is *classified and reported*, never thrown. A thrown
    // callback error is what makes a missing tile look like a rendering failure, and an unhandled
    // rejection is what makes it kill the frame — both are explicit non-goals here.
    callback: async (x: number, y: number, level: number): Promise<Float32Array> => {
      const key = `${level}/${x}/${y}`;
      const tilePath = joinPath(datasetRoot, `${key}.hgt`);

      // 1. The tile is not part of the committed dataset: known without reading anything, because the
      //    manifest's tile list is the authoritative answer (contract T-3).
      if (hasExplicitTileList && !availableTiles.has(key)) {
        return degrade(x, y, level, tilePath, "data-unavailable", "missing", `tile ${key} is not part of the committed dataset`);
      }

      // 2. The read failed, or never settled. Both are "data unavailable", and they are told apart by
      //    `failure` rather than by the message text.
      let bytes: Uint8Array;
      try {
        bytes = await readTileWithin(readTileBytes, tilePath, tileTimeoutMs);
      } catch (error) {
        const timedOut = error instanceof TileReadTimeoutError;
        return degrade(
          x,
          y,
          level,
          tilePath,
          "data-unavailable",
          timedOut ? "timeout" : "reader-error",
          timedOut ? `reading ${tilePath} did not settle within ${tileTimeoutMs} ms` : `reading ${tilePath} failed: ${String(error)}`,
        );
      }

      // 3. The bytes were read but cannot be decoded. Deliberately a *different* category: were this
      //    also "data-unavailable", the label would carry no information (contract TS-5).
      let heights: Float32Array | undefined;
      try {
        heights = decodeHeightmapTile(bytes, manifest);
      } catch (error) {
        return degrade(x, y, level, tilePath, "decode", "decode-error", error instanceof Error ? error.message : String(error));
      }

      // 4. Decodable and complete, but empty: every sample is `noDataValue`. There is no height to
      //    render, so it is a data problem — not a decode failure and not error geometry.
      if (heights === undefined) {
        return degrade(x, y, level, tilePath, "data-unavailable", "empty", `tile ${key} carries no valid sample (all ${manifest.noDataValue})`);
      }
      return heights;
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
