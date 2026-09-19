#!/usr/bin/env node
/**
 * `tools/build-terrain-fixture.mjs` — one-shot generator for the fixed terrain dataset
 * (tasks.md **T084**, FR-004; contract `terrain-source.md` §2).
 *
 *   node tools/build-terrain-fixture.mjs --dataset=matterhorn-z0-12 [--force] [--concurrency=8]
 *
 * What it produces
 * ----------------
 * `packages/cesium-webgpu/fixtures/<datasetId>/manifest.json` plus one binary
 * `<level>/<x>/<y>.hgt` per covering tile: a **row-major, north-to-south** grid of
 * `sampleWidth * sampleHeight` **little-endian `Uint16` metres** with offset −32768
 * (`stored = clamp(round(height) + 32768, 0, 65534)`), and `65535` reserved for **no data**.
 *
 * Two different tiling schemes (the reason this file is longer than it looks)
 * --------------------------------------------------------------------------
 * The fixture is cut in **Cesium's geographic scheme** (contract §2: `tilingScheme: "geographic"`):
 * 2 tiles at level 0 in x and 1 in y, so `x ∈ [0, 2^(z+1))`, `y ∈ [0, 2^z)`, and a tile spans
 * `180 / 2^z` degrees on **both** axes. The covering rectangle is covered by ≈ 1 (z0) … 195 (z12)
 * tiles, ≈ 290 tiles over z0–z12 — hence the 97 × 97 sample grid, which puts `totalBytes` at
 * ≈ 5.1 MiB, inside the 3–6 MB target band of contract §2 (hard bound 20 MiB).
 *
 * The **source** (AWS Open Data "Terrain Tiles", Mapzen/Joerd) is *not* geographic: it is a
 * standard **XYZ / Web-Mercator** raster with **one** tile at z0 (`x, y ∈ [0, 2^z)`), which was
 * verified against the live endpoint before this generator was written — `0/1/0` and `4/16/3`
 * return HTTP 404 while `12/2126/1459` contains Mont Blanc (max 4789.8 m). The geographic reading
 * of the same coordinate (`12/4252/1005`) does not exist. The generator therefore samples the
 * Mercator raster in Mercator space: every fixture tile is resampled from the source tiles **of
 * the same zoom** that overlap its geographic rectangle — the resolution is a natural match,
 * because a geographic tile of width `180/2^z` is exactly half a Mercator tile wide.
 *
 * Decode and no-data
 * ------------------
 *   height(metres) = R * 256 + G + B / 256 - 32768
 *
 * A source pixel **carries no data** iff its alpha is 0 (colour types 4/6, or a `tRNS` colour
 * key): a resampled sample is `65535` iff every contributing source pixel carries no data.
 * `RGB(0,0,0)` decodes to exactly −32768 m and is a **legal** sample — it is never treated as
 * no data. Samples whose latitude falls outside the source projection's valid band
 * (±85.05112877980659) have no source pixel at all; they are resolved by **edge replication**
 * (clamping to the outermost source row), which keeps the polar cap smooth instead of
 * manufacturing a 65 km spike for whoever consumes the dataset.
 *
 * Determinism and idempotency
 * ---------------------------
 * - Filter: **bilinear in source pixel space, sampled at the target cell centres** — the exact
 *   geographic position of each output sample is `west + (i + 0.5) * width_deg / width`
 *   (same for latitude), mapped through the Mercator transform. No randomness, no tolerance.
 * - No timestamps or machine-specific values are recorded, so a regeneration is byte-identical.
 * - Re-running **without** `--force` is a **no-op** when the manifest matches the requested
 *   parameters and every tile still hashes to its recorded `sha256`: nothing is downloaded and
 *   the process exits 0. Downloaded PNGs are cached under `artifacts/terrain-tile-cache/`
 *   (git-ignored), so even `--force` does not re-download, and `--tile-dir=<dir>` regenerates
 *   fully offline from a pre-fetched source-tile directory.
 * - A failing tile **fails loudly** with its `z/x/y` coordinate; nothing is zero-filled, and no
 *   manifest is written for a partial dataset.
 *
 * Exit codes: 0 success (including the up-to-date no-op), 1 generation/fetch failure, 2 bad
 * invocation.
 *
 * Cross-platform: Node 22 only, zero third-party dependencies, no shell, no absolute machine
 * paths. The pure helpers are exported for `tests/unit/fixture-generator.test.mjs`, which
 * exercises the decode formula and the file layout on a synthetic in-process source with no
 * network.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (this tool lives in `tools/`). */
export const REPO_ROOT = path.resolve(HERE, "..");

/** Where the committed datasets live (contract §2). */
export const FIXTURES_ROOT = path.join(REPO_ROOT, "packages", "cesium-webgpu", "fixtures");

/** Default dataset id, i.e. `packages/cesium-webgpu/fixtures/matterhorn-z0-12/`. */
export const DEFAULT_DATASET_ID = "matterhorn-z0-12";

/**
 * The covering rectangle: ≈ 0.6° × 0.5° around Mont Blanc (6.8652 E / 45.8326 N) and Grand
 * Combin, wide enough to force multi-tile stitching at every high level (FR-015).
 */
export const DEFAULT_RECTANGLE = Object.freeze({ west: 6.7, south: 45.65, east: 7.3, north: 46.15 });

/** z0–z12 inclusive. */
export const DEFAULT_LEVELS = Object.freeze(Array.from({ length: 13 }, (_, index) => index));

/**
 * 97 × 97 samples per tile. 286 tiles × 97 × 97 × 2 B = 5 381 948 B ≈ 5.1 MiB: the smallest grid
 * that keeps the dataset inside the 3–6 MB target band of contract §2.
 */
export const DEFAULT_SAMPLE_WIDTH = 97;
export const DEFAULT_SAMPLE_HEIGHT = 97;

/** Reserved "no data" sentinel (the highest representable `Uint16`). */
export const NO_DATA_VALUE = 65535;

/** Elevation offset: `stored = round(metres) + HEIGHT_OFFSET`. */
export const HEIGHT_OFFSET = 32768;

/** Both the source tiles and the fixture sample grid work on 256-pixel tiles. */
export const TILE_SIZE = 256;

/** Spherical-Mercator (EPSG:3857) latitude limit: beyond it an XYZ tile has no source pixel. */
export const MERCATOR_MAX_LATITUDE = 85.05112877980659;

/** The public, login-free source endpoint (XYZ / Web-Mercator). */
export const TILE_URL_TEMPLATE = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";

/** Manifest encoding tag: little-endian `Uint16` metres with the −32768 offset. */
export const ENCODING = "le-uint16-metres-offset-32768";

/** The resampling filter, stated exactly as the manifest states it. */
export const RESAMPLE_FILTER = "bilinear-in-mercator-source-pixels-at-target-cell-centres";

export const GENERATOR_VERSION = "1.1.0";

/** Definition of `manifest.contentHash`, stored verbatim in the manifest. */
export const CONTENT_HASH_DEFINITION =
  'sha256 over the UTF-8 concatenation of the lines "<level>/<x>/<y>.hgt <sha256-hex>\\n" for every tile, ordered by (level, x, y) ascending';

/** The no-data rule, stored verbatim in the manifest. */
export const NO_DATA_RULE =
  "a source pixel carries no data iff its alpha is 0; a resampled sample is no data (65535) iff every source pixel contributing to it carries no data. RGB(0,0,0) decodes to exactly -32768 m and is a LEGAL sample, never no data.";

/** How samples outside the source projection's latitude band are resolved. */
export const OUT_OF_PROJECTION_RULE =
  "samples above / below +/-85.05112877980659 degrees have no source pixel; they are resolved by edge replication (clamping to the outermost source row) so the polar cap stays finite";

/* ------------------------------------------------------------------------------------------------
 * PNG decoding (self-contained: node:zlib only)
 * ---------------------------------------------------------------------------------------------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

let crcTable = null;

/** CRC-32 (PNG polynomial), implemented here so the tool needs no `zlib.crc32` (Node ≥ 22.1). */
export function crc32(buffer, seed = 0) {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG (bad signature)");
  }
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    if (offset + 12 + length > buffer.length) throw new Error(`truncated PNG (chunk "${type}")`);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const declared = buffer.readUInt32BE(offset + 8 + length);
    const actual = crc32(buffer.subarray(offset + 4, offset + 8 + length));
    if (declared !== actual) throw new Error(`CRC mismatch in the "${type}" chunk`);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

function unfilterRow(filterType, raw, previous, channels) {
  for (let index = 0; index < raw.length; index += 1) {
    const left = index >= channels ? raw[index - channels] : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= channels ? previous[index - channels] ?? 0 : 0;
    switch (filterType) {
      case 0:
        break;
      case 1:
        raw[index] = (raw[index] + left) & 0xff;
        break;
      case 2:
        raw[index] = (raw[index] + up) & 0xff;
        break;
      case 3:
        raw[index] = (raw[index] + ((left + up) >> 1)) & 0xff;
        break;
      case 4: {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        raw[index] = (raw[index] + predictor) & 0xff;
        break;
      }
      default:
        throw new Error(`unknown PNG filter type ${filterType}`);
    }
  }
}

/**
 * Decode a PNG to 8-bit RGBA.
 *
 * Accepted: colour types 0 (grey), 2 (RGB), 3 (palette via `PLTE`, optional `tRNS` alpha table),
 * 4 (grey+alpha), 6 (RGBA); bit depth 8; no interlace. Anything else — and any chunk whose CRC
 * does not match — throws, so a malformed tile can never be silently zero-filled. The palette
 * lookup is implemented here because `tests/support/png-reader.mjs` deliberately does not do it
 * and must stay untouched (it is shared with the contract suites).
 *
 * @param {Buffer} buffer PNG bytes
 * @returns {{width: number, height: number, bitDepth: number, colorType: number, rgba: Buffer}}
 */
export function parsePng(buffer) {
  const chunks = readChunks(buffer);
  const byType = new Map();
  for (const chunk of chunks) if (!byType.has(chunk.type)) byType.set(chunk.type, chunk.data);
  const ihdr = byType.get("IHDR");
  if (ihdr === undefined) throw new Error("missing IHDR");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  const channels = PNG_CHANNELS[colorType];
  if (channels === undefined) throw new Error(`unsupported colour type ${colorType}`);
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth} (only 8-bit samples are supported)`);
  if (interlace !== 0) throw new Error("interlaced PNGs are not supported");

  const idat = chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data);
  if (idat.length === 0) throw new Error("missing IDAT");
  const inflated = zlib.inflateSync(Buffer.concat(idat));

  const palette = byType.get("PLTE") ?? null;
  const transparency = byType.get("tRNS") ?? null;
  const paletteAlpha = new Uint8Array(palette === null ? 0 : palette.length / 3).fill(255);
  let greyKey = -1;
  let rgbKey = null;
  if (transparency !== null) {
    if (colorType === 3 && palette !== null) {
      for (let index = 0; index < transparency.length && index < paletteAlpha.length; index += 1) paletteAlpha[index] = transparency[index];
    } else if (colorType === 0) {
      greyKey = transparency.readUInt16BE(0);
    } else if (colorType === 2) {
      rgbKey = [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)];
    }
  }

  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[cursor];
    cursor += 1;
    const raw = Buffer.from(inflated.subarray(cursor, cursor + stride));
    cursor += stride;
    if (raw.length !== stride) throw new Error("truncated PNG image data");
    unfilterRow(filterType, raw, previous, channels);
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      let r;
      let g;
      let b;
      let a = 255;
      if (colorType === 3) {
        const index = raw[source];
        r = palette[index * 3];
        g = palette[index * 3 + 1];
        b = palette[index * 3 + 2];
        a = paletteAlpha[index];
      } else if (channels === 1) {
        r = raw[source];
        g = r;
        b = r;
        if (greyKey >= 0 && r === greyKey) a = 0;
      } else if (channels === 2) {
        r = raw[source];
        g = r;
        b = r;
        a = raw[source + 1];
      } else if (channels === 3) {
        r = raw[source];
        g = raw[source + 1];
        b = raw[source + 2];
        if (rgbKey !== null && r === rgbKey[0] && g === rgbKey[1] && b === rgbKey[2]) a = 0;
      } else {
        r = raw[source];
        g = raw[source + 1];
        b = raw[source + 2];
        a = raw[source + 3];
      }
      rgba[target] = r;
      rgba[target + 1] = g;
      rgba[target + 2] = b;
      rgba[target + 3] = a;
    }
    previous = raw;
  }
  return { width, height, bitDepth, colorType, rgba };
}

/**
 * Minimal PNG *encoder* (colour type 6, bit depth 8, filter 0), used by the unit test to
 * synthesise a Terrarium source tile in-process so the generator can be exercised without
 * network. The test cross-checks the result against `tests/support/png-reader.mjs`.
 *
 * @param {{width: number, height: number, rgba: Buffer}} image
 * @returns {Buffer}
 */
export function encodePng({ width, height, rgba }) {
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Encode one Terrarium height (metres) into its RGB bytes, the inverse of the decode formula. */
export function encodeTerrariumRgb(metres) {
  const value = Math.round((metres + 32768) * 256);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/* ------------------------------------------------------------------------------------------------
 * Terrarium decode, quantisation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Decode a Terrarium RGBA buffer into metres.
 *
 * `height = R * 256 + G + B / 256 - 32768`; `valid[i] === 0` exactly when `alpha === 0`.
 * RGB(0,0,0) yields exactly −32768 m and stays valid (see `NO_DATA_RULE`).
 *
 * @param {Buffer|Uint8Array} rgba 4 bytes per pixel, row-major
 * @param {number} width
 * @param {number} height
 * @returns {{width: number, height: number, heights: Float64Array, valid: Uint8Array}}
 */
export function decodeTerrariumPixels(rgba, width, height) {
  const pixels = width * height;
  if (rgba.length < pixels * 4) throw new Error(`decodeTerrariumPixels: expected ${pixels * 4} RGBA bytes, got ${rgba.length}`);
  const heights = new Float64Array(pixels);
  const valid = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    heights[index] = rgba[offset] * 256 + rgba[offset + 1] + rgba[offset + 2] / 256 - 32768;
    valid[index] = rgba[offset + 3] === 0 ? 0 : 1;
  }
  return { width, height, heights, valid };
}

/**
 * Quantise metres to the stored `Uint16`: `clamp(round(height) + 32768, 0, 65534)`.
 *
 * @param {number} metres
 * @returns {number} 0..65534
 */
export function quantiseHeight(metres) {
  return Math.min(65534, Math.max(0, Math.round(metres) + HEIGHT_OFFSET));
}

/**
 * Quantise a resampled grid to `Uint16` samples, writing `NO_DATA_VALUE` where invalid.
 *
 * @param {{heights: Float64Array, valid: Uint8Array}} grid
 * @returns {Uint16Array}
 */
export function quantiseGrid(grid) {
  const samples = new Uint16Array(grid.heights.length);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = grid.valid[index] === 0 ? NO_DATA_VALUE : quantiseHeight(grid.heights[index]);
  }
  return samples;
}

/**
 * Encode `Uint16` samples as little-endian bytes (`.hgt` payload, headerless).
 *
 * @param {Uint16Array|number[]} samples
 * @returns {Buffer}
 */
export function encodeHeightGrid(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeUInt16LE(samples[index], index * 2);
  return buffer;
}

/**
 * Read a `.hgt` payload back into `Uint16` samples (the inverse of `encodeHeightGrid`).
 *
 * @param {Buffer} buffer
 * @returns {Uint16Array}
 */
export function decodeHeightGrid(buffer) {
  if (buffer.length % 2 !== 0) throw new Error(`decodeHeightGrid: byte length ${buffer.length} is not a multiple of 2`);
  const samples = new Uint16Array(buffer.length / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = buffer.readUInt16LE(index * 2);
  return samples;
}

/* ------------------------------------------------------------------------------------------------
 * Projections and tiling-scheme geometry
 * ---------------------------------------------------------------------------------------------- */

/** Degrees of longitude per fixture (geographic) tile at `level`; also its height in degrees. */
export function tileSpanDegrees(level) {
  return 180 / 2 ** level;
}

/** The degrees rectangle covered by geographic fixture tile (level, x, y). */
export function tileRectangle(level, x, y) {
  const span = tileSpanDegrees(level);
  return { west: x * span - 180, east: (x + 1) * span - 180, south: 90 - (y + 1) * span, north: 90 - y * span };
}

/** Every geographic tile at `level` that overlaps `rectangle` (strict overlap; touching edges do not count). */
export function tilesForRectangle(rectangle, level) {
  const span = tileSpanDegrees(level);
  const maxX = 2 ** (level + 1) - 1;
  const maxY = 2 ** level - 1;
  const clamp = (value, max) => Math.min(max, Math.max(0, value));
  const xStart = clamp(Math.floor((rectangle.west + 180) / span) - 1, maxX);
  const xEnd = clamp(Math.ceil((rectangle.east + 180) / span) + 1, maxX);
  const yStart = clamp(Math.floor((90 - rectangle.north) / span) - 1, maxY);
  const yEnd = clamp(Math.ceil((90 - rectangle.south) / span) + 1, maxY);
  const tiles = [];
  for (let y = yStart; y <= yEnd; y += 1) {
    for (let x = xStart; x <= xEnd; x += 1) {
      const bounds = tileRectangle(level, x, y);
      const overlaps =
        bounds.east > rectangle.west && bounds.west < rectangle.east && bounds.north > rectangle.south && bounds.south < rectangle.north;
      if (overlaps) tiles.push({ level, x, y });
    }
  }
  return tiles;
}

/** Every covering geographic tile over `levels`, ordered by (level, x, y). */
export function tilesForLevels(rectangle, levels) {
  return levels.flatMap((level) => tilesForRectangle(rectangle, level));
}

/** POSIX-style fixture tile path inside the dataset directory. */
export function tilePath(level, x, y) {
  return `${level}/${x}/${y}.hgt`;
}

/** POSIX-style source tile path inside the cache directory. */
export function sourceTilePath(level, x, y) {
  return `${level}/${x}/${y}.png`;
}

/** Continuous global Mercator pixel coordinate of a longitude (0 = west edge of tile 0). */
export function lonToMercatorPixelX(longitude, level) {
  return ((longitude + 180) / 360) * TILE_SIZE * 2 ** level;
}

/** Continuous global Mercator pixel coordinate of a latitude (0 = north edge of the world). */
export function latToMercatorPixelY(latitude, level) {
  const clamped = Math.min(MERCATOR_MAX_LATITUDE, Math.max(-MERCATOR_MAX_LATITUDE, latitude));
  const mercator = Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
  return ((1 - mercator / Math.PI) / 2) * TILE_SIZE * 2 ** level;
}

/** Inverse of the two functions above (used by tests and diagnostics). */
export function mercatorPixelToLonLat(x, y, level) {
  const size = TILE_SIZE * 2 ** level;
  const longitude = (x / size) * 360 - 180;
  const mercator = Math.PI * (1 - (2 * y) / size);
  const latitude = (Math.atan(Math.sinh(mercator)) * 180) / Math.PI;
  return { longitude, latitude };
}

/**
 * The XYZ / Web-Mercator source tiles at `level` overlapping a degrees rectangle.
 *
 * Returns `null` when the rectangle lies entirely outside the source projection's latitude band.
 */
export function mercatorTileRangeForRectangle(rectangle, level) {
  const south = Math.max(rectangle.south, -MERCATOR_MAX_LATITUDE);
  const north = Math.min(rectangle.north, MERCATOR_MAX_LATITUDE);
  if (!(north > south)) return null;
  const maxIndex = 2 ** level - 1;
  const clamp = (value) => Math.min(maxIndex, Math.max(0, value));
  const xStart = clamp(Math.floor(lonToMercatorPixelX(rectangle.west, level) / TILE_SIZE));
  const xEnd = clamp(Math.ceil(lonToMercatorPixelX(rectangle.east, level) / TILE_SIZE) - 1);
  const yStart = clamp(Math.floor(latToMercatorPixelY(north, level) / TILE_SIZE));
  const yEnd = clamp(Math.ceil(latToMercatorPixelY(south, level) / TILE_SIZE) - 1);
  if (xStart > xEnd || yStart > yEnd) return null;
  return { level, xStart, xEnd, yStart, yEnd };
}

/** The Mercator source tiles needed to fill one geographic fixture tile. */
export function sourceTilesForFixtureTile(level, x, y) {
  const range = mercatorTileRangeForRectangle(tileRectangle(level, x, y), level);
  if (range === null) return [];
  const tiles = [];
  for (let sourceY = range.yStart; sourceY <= range.yEnd; sourceY += 1) {
    for (let sourceX = range.xStart; sourceX <= range.xEnd; sourceX += 1) tiles.push({ level, x: sourceX, y: sourceY });
  }
  return tiles;
}

/** Every distinct Mercator source tile needed for a whole dataset, ordered by (level, x, y). */
export function sourceTilesForDataset(rectangle, levels) {
  const keys = new Map();
  for (const tile of tilesForLevels(rectangle, levels)) {
    for (const source of sourceTilesForFixtureTile(tile.level, tile.x, tile.y)) {
      keys.set(`${source.level}/${source.x}/${source.y}`, source);
    }
  }
  return [...keys.values()].sort((a, b) => a.level - b.level || a.x - b.x || a.y - b.y);
}

/* ------------------------------------------------------------------------------------------------
 * Resampling: Mercator source mosaic -> geographic fixture grid
 * ---------------------------------------------------------------------------------------------- */

/**
 * Build a source mosaic from decoded Mercator tiles.
 *
 * @param {number} level
 * @param {Map<string, {heights: Float64Array, valid: Uint8Array}>} tiles keyed by `"x/y"`
 */
export function createMercatorSource(level, tiles) {
  return { level, tiles, size: TILE_SIZE * 2 ** level };
}

/** One source pixel by **global** pixel index, or an invalid sample when it has no tile. */
function readSourcePixel(source, pixelX, pixelY) {
  if (pixelX < 0 || pixelY < 0 || pixelX >= source.size || pixelY >= source.size) return null;
  const tileX = Math.floor(pixelX / TILE_SIZE);
  const tileY = Math.floor(pixelY / TILE_SIZE);
  const tile = source.tiles.get(`${tileX}/${tileY}`);
  if (tile === undefined) return null;
  const localX = pixelX - tileX * TILE_SIZE;
  const localY = pixelY - tileY * TILE_SIZE;
  const index = localY * TILE_SIZE + localX;
  if (tile.valid[index] === 0) return null;
  return tile.heights[index];
}

/**
 * Bilinear sample in source pixel space.
 *
 * `pixelX` / `pixelY` are **continuous** global Mercator pixel coordinates (pixel `i` covers
 * `[i, i + 1)`, its centre sitting at `i + 0.5`). Contributing pixels that carry no data are
 * dropped and the remaining weights renormalised; a point whose four neighbours all carry no
 * data is itself no data.
 */
export function sampleMercatorBilinear(source, pixelX, pixelY) {
  const x = Math.max(0, Math.min(source.size - 1e-9, pixelX) - 0.5);
  const y = Math.max(0, Math.min(source.size - 1e-9, pixelY) - 0.5);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
  const positions = [
    [x0, y0],
    [x0 + 1, y0],
    [x0, y0 + 1],
    [x0 + 1, y0 + 1],
  ];
  let total = 0;
  let sum = 0;
  for (let corner = 0; corner < 4; corner += 1) {
    if (weights[corner] === 0) continue;
    const value = readSourcePixel(source, positions[corner][0], positions[corner][1]);
    if (value === null) continue;
    total += weights[corner];
    sum += weights[corner] * value;
  }
  return total === 0 ? null : sum / total;
}

/**
 * Resample one geographic fixture tile from its Mercator source mosaic.
 *
 * Sample `(i, j)` sits at the exact centre of its cell — longitude `west + (i + 0.5) * widthDeg /
 * width`, latitude `north - (j + 0.5) * heightDeg / height` — mapped through the Mercator
 * transform and bilinearly sampled. Rows above / below the projection limit (±85.0511) are edge
 * replicated; see `OUT_OF_PROJECTION_RULE`.
 *
 * @returns {{width: number, height: number, heights: Float64Array, valid: Uint8Array}}
 */
export function resampleFixtureTile({ rectangle, width, height, source }) {
  const heights = new Float64Array(width * height);
  const valid = new Uint8Array(width * height);
  const widthDegrees = rectangle.east - rectangle.west;
  const heightDegrees = rectangle.north - rectangle.south;
  for (let row = 0; row < height; row += 1) {
    const latitudeAtCentre = rectangle.north - ((row + 0.5) * heightDegrees) / height;
    const beyondProjection = Math.abs(latitudeAtCentre) > MERCATOR_MAX_LATITUDE;
    for (let column = 0; column < width; column += 1) {
      const longitude = rectangle.west + ((column + 0.5) * widthDegrees) / width;
      const pixelX = lonToMercatorPixelX(longitude, source.level);
      // Past the projection limit there is no source pixel: clamp to the outermost row instead of
      // emitting a hole (see the header note on edge replication).
      const pixelY = latToMercatorPixelY(
        beyondProjection ? Math.sign(latitudeAtCentre) * MERCATOR_MAX_LATITUDE : latitudeAtCentre,
        source.level,
      );
      const value = sampleMercatorBilinear(source, pixelX, pixelY);
      const target = row * width + column;
      if (value === null) {
        valid[target] = 0;
        heights[target] = 0;
      } else {
        valid[target] = 1;
        heights[target] = value;
      }
    }
  }
  return { width, height, heights, valid };
}

/* ------------------------------------------------------------------------------------------------
 * Hashing
 * ---------------------------------------------------------------------------------------------- */

/** `sha256` of a buffer, lowercase hex. */
export function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * The dataset content hash: `sha256` over the sorted `"<level>/<x>/<y>.hgt <sha256>\n"` lines
 * (see `CONTENT_HASH_DEFINITION`). Recorded in the manifest as `contentHash.value` **and**
 * `sha256`, which contract §2 calls "the dataset content hash".
 *
 * @param {{level: number, x: number, y: number, sha256: string}[]} tiles
 */
export function computeDatasetContentHash(tiles) {
  const ordered = [...tiles].sort((a, b) => a.level - b.level || a.x - b.x || a.y - b.y);
  const text = ordered.map((tile) => `${tilePath(tile.level, tile.x, tile.y)} ${tile.sha256}\n`).join("");
  return sha256Hex(Buffer.from(text, "utf8"));
}

/** Elevation statistics of one `Uint16` sample grid (no-data samples excluded). */
export function gridElevationStatistics(samples) {
  let min = Infinity;
  let max = -Infinity;
  let noData = 0;
  for (const sample of samples) {
    if (sample === NO_DATA_VALUE) {
      noData += 1;
      continue;
    }
    const metres = sample - HEIGHT_OFFSET;
    if (metres < min) min = metres;
    if (metres > max) max = metres;
  }
  return { min: min === Infinity ? null : min, max: max === -Infinity ? null : max, noData, samples: samples.length };
}

/* ------------------------------------------------------------------------------------------------
 * Source metadata / attribution (FR-024)
 * ---------------------------------------------------------------------------------------------- */

/** The verbatim attribution Joerd requires for the terrain tiles it distributes. */
export const REQUIRED_ATTRIBUTION = [
  "Terrain Tiles (terrarium) by Mapzen/Joerd, distributed through the AWS Open Data registry.",
  "ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736;",
  "Australia terrain data (c) Commonwealth of Australia (Geoscience Australia) 2017;",
  "Austria terrain data (c) offene Daten Oesterreichs - Digitales Gelaendemodell (DGM) Oesterreich;",
  "Canada terrain data contains information licensed under the Open Government Licence - Canada;",
  "Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers;",
  "Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration;",
  "Mexico terrain data source: INEGI, Continental relief, 2016;",
  "New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved);",
  "Norway terrain data (c) Kartverket;",
  "United Kingdom terrain data (c) Environment Agency copyright and/or database right 2015. All rights reserved;",
  "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.",
].join("\n");

/** Per-source licence and link (FR-024: every entry carries a licence and a URL). */
export const DATA_SOURCES = [
  {
    name: "Mapzen/Joerd Terrain Tiles (AWS Open Data, bucket elevation-tiles-prod)",
    url: "https://registry.opendata.aws/terrain-tiles/",
    license: "Open data aggregated by Mapzen/Joerd; per-source licences listed in the attribution document",
    licenseUrl: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
  },
  {
    name: "Copernicus EU-DEM (European Environment Agency)",
    url: "https://www.eea.europa.eu/data-and-maps/data/eu-dem",
    license: "Copernicus data and information funded by the European Union (free, attribution required)",
    licenseUrl: "https://www.eea.europa.eu/en/legal-notice",
  },
  {
    name: "NASA/USGS SRTM (Shuttle Radar Topography Mission)",
    url: "https://www2.jpl.nasa.gov/srtm/",
    license: "Public domain (U.S. Government), credit requested",
    licenseUrl: "https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-shuttle-radar-topography-mission-srtm-1",
  },
  {
    name: "USGS GMTED2010",
    url: "https://www.usgs.gov/landsat-missions/global-multi-resolution-terrain-elevation-data",
    license: "Public domain (U.S. Government), credit requested",
    licenseUrl: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
  },
  {
    name: "NOAA ETOPO1 global relief model",
    url: "https://www.ncei.noaa.gov/products/etopo-global-relief-model",
    license: "Public domain (U.S. Government), not subject to copyright protection within the United States",
    licenseUrl: "https://www.noaa.gov/information-technology/open-data-dissemination",
  },
  {
    name: "USGS 3DEP (formerly NED) bare-earth elevation",
    url: "https://www.usgs.gov/3d-elevation-program",
    license: "Public domain (U.S. Government), credit requested",
    licenseUrl: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
  },
  {
    name: "LINZ New Zealand 8 m Digital Elevation Model",
    url: "https://data.linz.govt.nz/layer/1768-nz-8m-digital-elevation-model-2012/",
    license: "Creative Commons Attribution 3.0 New Zealand (CC BY 3.0 NZ)",
    licenseUrl: "https://data.linz.govt.nz/license/attribution-3-0-new-zealand/",
  },
  {
    name: "UK Environment Agency LIDAR Composite Digital Terrain Model",
    url: "https://www.data.gov.uk/dataset/lidar-composite-digital-terrain-model-dtm",
    license: "Open Government Licence v3.0",
    licenseUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  },
  {
    name: "Austria Digitales Gelaendemodell (DGM), data.gv.at",
    url: "https://www.data.gv.at/katalog/dataset/b5de6975-417b-4320-afdb-eb2a9e2a1dbf",
    license: "Creative Commons Attribution 3.0 Austria (CC BY 3.0 AT)",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/at/deed.en",
  },
  {
    name: "Kartverket Norway Digital terrengmodell",
    url: "https://www.kartverket.no/en/data",
    license: "Creative Commons Attribution 4.0 International (CC BY 4.0)",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
  {
    name: "ArcticDEM (Polar Geospatial Center / National Geospatial-Intelligence Agency)",
    url: "https://www.pgc.umn.edu/data/arcticdem/",
    license: "Unlicensed product; may be used, distributed and modified without permission",
    licenseUrl: "https://www.pgc.umn.edu/data/arcticdem/",
  },
  {
    name: "Natural Resources Canada Canadian Digital Elevation Model (CDEM)",
    url: "https://open.canada.ca/data/en/dataset/3b8c1f2e-1f5e-4c02-9c07-0d2a5e6e2f11",
    license: "Open Government Licence - Canada",
    licenseUrl: "https://open.canada.ca/en/open-government-licence-canada",
  },
  {
    name: "INEGI Mexico continental relief",
    url: "https://en.www.inegi.org.mx/temas/mapas/relieve/continental/",
    license: "Free use of information (Mexico), attribution required",
    licenseUrl: "https://en.www.inegi.org.mx/inegi/terminos.html",
  },
  {
    name: "Geoscience Australia 5 m LiDAR DEM",
    url: "https://ecat.ga.gov.au/geonetwork/srv/eng/catalog.search#/metadata/22be4b55-2465-4320-e053-10a3070a5236",
    license: "Creative Commons Attribution 4.0 International (CC BY 4.0)",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
];

/* ------------------------------------------------------------------------------------------------
 * Generation
 * ---------------------------------------------------------------------------------------------- */

function sameRectangle(a, b) {
  return ["west", "south", "east", "north"].every((key) => Math.abs(a[key] - b[key]) < 1e-9);
}

function sameNumbers(a, b) {
  return a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) < 1e-9);
}

function readManifest(outDir) {
  const manifestPath = path.join(outDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return { manifestPath, manifest: null };
  try {
    return { manifestPath, manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")) };
  } catch {
    return { manifestPath, manifest: null };
  }
}

/**
 * Is the dataset already generated for exactly these parameters?
 *
 * True only when the manifest exists, matches every generation parameter, lists the same tiles,
 * and every tile file is present with the recorded byte length **and** `sha256`. This is what
 * makes a re-run without `--force` a genuine no-op: a matching dataset is never downloaded again.
 */
export function datasetIsUpToDate({ outDir, datasetId, rectangle, levels, sampleWidth, sampleHeight }) {
  const { manifest } = readManifest(outDir);
  if (manifest === null) return { upToDate: false, reason: "no readable manifest.json" };
  if (manifest.datasetId !== datasetId) return { upToDate: false, reason: `manifest datasetId is "${manifest.datasetId}"` };
  if (manifest.sampleWidth !== sampleWidth || manifest.sampleHeight !== sampleHeight) {
    return { upToDate: false, reason: `manifest sample grid is ${manifest.sampleWidth}x${manifest.sampleHeight}` };
  }
  if (manifest.encoding !== ENCODING || manifest.noDataValue !== NO_DATA_VALUE) {
    return { upToDate: false, reason: "manifest encoding/noDataValue differ from the generator" };
  }
  if (manifest.rectangle === undefined || !sameRectangle(manifest.rectangle, rectangle)) {
    return { upToDate: false, reason: "manifest rectangle differs from the requested one" };
  }
  if (!Array.isArray(manifest.levels) || !sameNumbers(manifest.levels, levels)) {
    return { upToDate: false, reason: "manifest level list differs from the requested one" };
  }
  const expected = tilesForLevels(rectangle, levels);
  if (!Array.isArray(manifest.tiles) || manifest.tiles.length !== expected.length) {
    return { upToDate: false, reason: `manifest lists ${manifest.tiles?.length ?? 0} tiles, expected ${expected.length}` };
  }
  for (const tile of manifest.tiles) {
    const file = path.join(outDir, ...tilePath(tile.level, tile.x, tile.y).split("/"));
    if (!fs.existsSync(file)) return { upToDate: false, reason: `tile file ${tile.path} is missing` };
    const bytes = fs.readFileSync(file);
    if (bytes.length !== tile.bytes) return { upToDate: false, reason: `tile ${tile.path} has ${bytes.length} bytes, expected ${tile.bytes}` };
    if (sha256Hex(bytes) !== tile.sha256) return { upToDate: false, reason: `tile ${tile.path} does not match its recorded sha256` };
  }
  return { upToDate: true, manifest, reason: "manifest and every tile hash match" };
}

/** Run `worker` over `items` with a fixed-size pool, preserving input order. */
export async function mapConcurrent(items, concurrency, worker, onProgress) {
  const results = new Array(items.length);
  const width = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;
  let completed = 0;
  const runner = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      completed += 1;
      onProgress?.(completed, items.length);
    }
  };
  await Promise.all(Array.from({ length: width }, runner));
  return results;
}

/**
 * Build the dataset into `outDir`.
 *
 * `fetchTile(level, x, y)` MUST resolve to the PNG bytes of that **Mercator source** tile and MUST
 * reject with the tile coordinate in the message on failure — a missing tile aborts the whole run
 * (no partial manifest, no zero-fill).
 *
 * @returns {Promise<{manifest: object, manifestPath: string, upToDate: boolean, tileCount: number, totalBytes: number, colorTypes: number[], sourceTiles: number}>}
 */
export async function generateFixture({
  datasetId = DEFAULT_DATASET_ID,
  outDir,
  rectangle = DEFAULT_RECTANGLE,
  levels = DEFAULT_LEVELS,
  sampleWidth = DEFAULT_SAMPLE_WIDTH,
  sampleHeight = DEFAULT_SAMPLE_HEIGHT,
  force = false,
  concurrency = 8,
  fetchTile,
  log = () => {},
} = {}) {
  if (typeof outDir !== "string" || outDir.length === 0) throw new Error("generateFixture: outDir is required");
  if (typeof fetchTile !== "function") throw new Error("generateFixture: fetchTile is required");
  if (!Number.isInteger(sampleWidth) || sampleWidth < 1 || !Number.isInteger(sampleHeight) || sampleHeight < 1) {
    throw new Error(`generateFixture: invalid sample grid ${sampleWidth}x${sampleHeight}`);
  }

  if (!force) {
    const state = datasetIsUpToDate({ outDir, datasetId, rectangle, levels, sampleWidth, sampleHeight });
    if (state.upToDate) {
      return {
        manifest: state.manifest,
        manifestPath: path.join(outDir, "manifest.json"),
        upToDate: true,
        tileCount: state.manifest.tiles.length,
        totalBytes: state.manifest.totalBytes,
        colorTypes: state.manifest.source?.observedColorTypes ?? [],
        sourceTiles: state.manifest.source?.sourceTileCount ?? 0,
      };
    }
    log(`regenerating: ${state.reason}`);
  }

  const fixtureTiles = tilesForLevels(rectangle, levels);
  const sourceTiles = sourceTilesForDataset(rectangle, levels);
  log(`${fixtureTiles.length} fixture tile(s) over z${levels[0]}-z${levels[levels.length - 1]}, sample grid ${sampleWidth}x${sampleHeight}`);
  log(`${sourceTiles.length} Mercator source tile(s) required (same zoom level as each fixture tile)`);

  const colorTypes = new Set();
  const entries = [];
  const levelSummary = new Map();
  let totalBytes = 0;
  let noDataSamples = 0;
  let minHeight = Infinity;
  let maxHeight = -Infinity;

  for (const level of levels) {
    const levelSourceTiles = sourceTiles.filter((tile) => tile.level === level);
    const levelFixtureTiles = fixtureTiles.filter((tile) => tile.level === level);
    log(`z${level}: fetching ${levelSourceTiles.length} source tile(s) for ${levelFixtureTiles.length} fixture tile(s)`);

    const decodedTiles = await mapConcurrent(
      levelSourceTiles,
      concurrency,
      async (tile) => {
        let png;
        try {
          png = await fetchTile(tile.level, tile.x, tile.y);
        } catch (error) {
          throw new Error(`tile ${tile.level}/${tile.x}/${tile.y}: ${error.message}`);
        }
        let image;
        try {
          image = parsePng(png);
        } catch (error) {
          throw new Error(`tile ${tile.level}/${tile.x}/${tile.y}: ${error.message}`);
        }
        if (image.width !== TILE_SIZE || image.height !== TILE_SIZE) {
          throw new Error(`tile ${tile.level}/${tile.x}/${tile.y}: expected ${TILE_SIZE}x${TILE_SIZE} pixels, got ${image.width}x${image.height}`);
        }
        colorTypes.add(image.colorType);
        return { key: `${tile.x}/${tile.y}`, ...decodeTerrariumPixels(image.rgba, image.width, image.height) };
      },
      (completed, total) => {
        if (completed === total && total > 1) log(`z${level}: ${completed}/${total} source tile(s) decoded`);
      },
    );

    const source = createMercatorSource(level, new Map(decodedTiles.map((tile) => [tile.key, tile])));
    for (const tile of levelFixtureTiles) {
      const rectangleOfTile = tileRectangle(tile.level, tile.x, tile.y);
      const grid = resampleFixtureTile({ rectangle: rectangleOfTile, width: sampleWidth, height: sampleHeight, source });
      const samples = quantiseGrid(grid);
      const bytes = encodeHeightGrid(samples);
      const relative = tilePath(tile.level, tile.x, tile.y);
      const file = path.join(outDir, ...relative.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      entries.push({ level: tile.level, x: tile.x, y: tile.y, path: relative, bytes: bytes.length, sha256: sha256Hex(bytes) });
      totalBytes += bytes.length;
      const stats = gridElevationStatistics(samples);
      noDataSamples += stats.noData;
      if (stats.min !== null && stats.min < minHeight) minHeight = stats.min;
      if (stats.max !== null && stats.max > maxHeight) maxHeight = stats.max;
      const summary = levelSummary.get(tile.level) ?? { level: tile.level, tiles: 0, bytes: 0, minHeight: null, maxHeight: null };
      summary.tiles += 1;
      summary.bytes += bytes.length;
      if (stats.min !== null) summary.minHeight = summary.minHeight === null ? stats.min : Math.min(summary.minHeight, stats.min);
      if (stats.max !== null) summary.maxHeight = summary.maxHeight === null ? stats.max : Math.max(summary.maxHeight, stats.max);
      levelSummary.set(tile.level, summary);
    }
  }
  entries.sort((a, b) => a.level - b.level || a.x - b.x || a.y - b.y);

  const contentHash = computeDatasetContentHash(entries);
  const manifest = {
    datasetId,
    generator: {
      tool: "tools/build-terrain-fixture.mjs",
      version: GENERATOR_VERSION,
      runtime: "Node >=22, zero third-party dependencies",
    },
    tilingScheme: "geographic",
    encoding: ENCODING,
    byteOrder: "little-endian",
    sampleType: "uint16",
    noDataValue: NO_DATA_VALUE,
    heightOffsetMetres: -HEIGHT_OFFSET,
    sampleWidth,
    sampleHeight,
    sampleGrid: {
      filter: RESAMPLE_FILTER,
      alignment: "target-cell-centres within each tile rectangle",
      orientation: "row-major; row 0 is the northernmost sample, column 0 the westernmost",
      noDataRule: NO_DATA_RULE,
      outOfProjectionRule: OUT_OF_PROJECTION_RULE,
    },
    rectangle: { west: rectangle.west, south: rectangle.south, east: rectangle.east, north: rectangle.north, units: "degrees" },
    levels: [...levels],
    levelSummary: [...levelSummary.values()].sort((a, b) => a.level - b.level),
    tileCount: entries.length,
    totalBytes,
    elevation: {
      minHeight: minHeight === Infinity ? null : minHeight,
      maxHeight: maxHeight === -Infinity ? null : maxHeight,
      span: minHeight === Infinity ? null : maxHeight - minHeight,
      units: "metres",
      noDataSamples,
      sampleCount: entries.length * sampleWidth * sampleHeight,
    },
    tiles: entries,
    source: {
      name: "AWS Open Data - Terrain Tiles (Mapzen/Joerd, terrarium encoding)",
      urlTemplate: TILE_URL_TEMPLATE,
      scheme: "xyz-web-mercator",
      projection: "EPSG:3857 spherical Mercator",
      maxLatitude: MERCATOR_MAX_LATITUDE,
      tilesPerZoom: "2^z x 2^z (a single tile at z0)",
      decode: "height = R * 256 + G + B / 256 - 32768",
      tileSize: TILE_SIZE,
      observedColorTypes: [...colorTypes].sort((a, b) => a - b),
      sourceTileCount: sourceTiles.length,
      zoomMatchesFixtureLevel: true,
      registryUrl: "https://registry.opendata.aws/terrain-tiles/",
      note: "The source raster is cut in the XYZ/Web-Mercator scheme (1 tile at z0) while this fixture is cut in Cesium's geographic scheme (2 tiles at z0 in x, 1 in y); each fixture tile is resampled from the same-zoom Mercator tiles overlapping its geographic rectangle.",
    },
    attribution: REQUIRED_ATTRIBUTION,
    sources: DATA_SOURCES,
    contentHash: { algorithm: "sha256", definition: CONTENT_HASH_DEFINITION, value: contentHash },
    sha256: contentHash,
    notes: [
      "Deterministic: no timestamps or machine-specific fields are recorded, so a regeneration is byte-identical.",
      "Samples are integer metres after quantisation (round(height)); the file is a headerless little-endian Uint16 grid.",
      NO_DATA_RULE,
      OUT_OF_PROJECTION_RULE,
    ],
  };
  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  log(`wrote ${entries.length} tile(s), ${totalBytes} B -> ${manifestPath}`);
  return { manifest, manifestPath, upToDate: false, tileCount: entries.length, totalBytes, colorTypes: [...colorTypes].sort((a, b) => a - b), sourceTiles: sourceTiles.length };
}

/* ------------------------------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------------------------- */

const USAGE = [
  "usage: node tools/build-terrain-fixture.mjs --dataset=<id> [--force] [--concurrency=<n>]",
  "",
  "  --dataset=<id>        dataset id (default matterhorn-z0-12)",
  "  --force               regenerate even when the dataset is already up to date",
  "  --concurrency=<n>     parallel source-tile fetches (default 8)",
  "  --out-dir=<dir>       explicit dataset directory (default packages/cesium-webgpu/fixtures/<id>)",
  "  --fixtures-root=<dir> fixtures root used with --dataset (default packages/cesium-webgpu/fixtures)",
  "  --cache-dir=<dir>     downloaded PNG cache (default artifacts/terrain-tile-cache/terrarium)",
  "  --tile-dir=<dir>      read source tiles from <dir>/<z>/<x>/<y>.png instead of the network (offline)",
  "  --sample-width=<n>, --sample-height=<n>  sample grid (default 97x97)",
  "  --help                print this message",
].join("\n");

export function parseArgv(argv) {
  const options = {
    datasetId: DEFAULT_DATASET_ID,
    force: false,
    concurrency: 8,
    fixturesRoot: FIXTURES_ROOT,
    outDir: null,
    cacheDir: path.join(REPO_ROOT, "artifacts", "terrain-tile-cache", "terrarium"),
    tileDir: null,
    sampleWidth: DEFAULT_SAMPLE_WIDTH,
    sampleHeight: DEFAULT_SAMPLE_HEIGHT,
    help: false,
  };
  const valueFlags = new Set(["--dataset", "--concurrency", "--out-dir", "--fixtures-root", "--cache-dir", "--tile-dir", "--sample-width", "--sample-height"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf("=");
    const key = equals >= 0 ? argument.slice(0, equals) : argument;
    let value = equals >= 0 ? argument.slice(equals + 1) : undefined;
    if (key === "--help") {
      options.help = true;
      continue;
    }
    if (key === "--force") {
      options.force = true;
      continue;
    }
    if (!valueFlags.has(key)) throw new Error(`unknown argument "${argument}"`);
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined) throw new Error(`missing value for "${key}"`);
      index += 1;
    }
    if (key === "--dataset") options.datasetId = value;
    else if (key === "--concurrency") options.concurrency = Number.parseInt(value, 10);
    else if (key === "--out-dir") options.outDir = path.resolve(value);
    else if (key === "--fixtures-root") options.fixturesRoot = path.resolve(value);
    else if (key === "--cache-dir") options.cacheDir = path.resolve(value);
    else if (key === "--tile-dir") options.tileDir = path.resolve(value);
    else if (key === "--sample-width") options.sampleWidth = Number.parseInt(value, 10);
    else options.sampleHeight = Number.parseInt(value, 10);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency MUST be a positive integer");
  if (!Number.isInteger(options.sampleWidth) || options.sampleWidth < 1) throw new Error("--sample-width MUST be a positive integer");
  if (!Number.isInteger(options.sampleHeight) || options.sampleHeight < 1) throw new Error("--sample-height MUST be a positive integer");
  return options;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Fetch one source tile over HTTPS with retries; the thrown message names the tile coordinate. */
async function fetchTileFromNetwork(level, x, y, { attempts = 3, timeoutMs = 30000 } = {}) {
  const url = TILE_URL_TEMPLATE.replace("{z}", String(level)).replace("{x}", String(x)).replace("{y}", String(y));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) throw new Error("empty response body");
      return buffer;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(250 * 3 ** (attempt - 1));
    }
  }
  throw new Error(`${lastError.message} (source ${url}, ${attempts} attempt(s))`);
}

/** A `fetchTile` that serves the AWS terrarium endpoint through a per-tile PNG cache. */
export function createNetworkTileFetcher({ cacheDir, log = () => {} }) {
  const inFlight = new Map();
  return async (level, x, y) => {
    const cached = path.join(cacheDir, ...sourceTilePath(level, x, y).split("/"));
    if (fs.existsSync(cached)) {
      const buffer = fs.readFileSync(cached);
      if (buffer.length > 0) return buffer;
    }
    const key = `${level}/${x}/${y}`;
    if (!inFlight.has(key)) {
      inFlight.set(
        key,
        (async () => {
          const buffer = await fetchTileFromNetwork(level, x, y);
          fs.mkdirSync(path.dirname(cached), { recursive: true });
          fs.writeFileSync(cached, buffer);
          return buffer;
        })(),
      );
    }
    return inFlight.get(key);
  };
}

/** A `fetchTile` that reads `<tileDir>/<z>/<x>/<y>.png` — the fully offline path. */
export function createDirectoryTileFetcher({ tileDir }) {
  return async (level, x, y) => {
    const file = path.join(tileDir, ...sourceTilePath(level, x, y).split("/"));
    if (!fs.existsSync(file)) throw new Error(`missing source tile file ${file}`);
    return fs.readFileSync(file);
  };
}

async function main(argv) {
  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    console.error(`build-terrain-fixture: ${error.message}`);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const outDir = options.outDir ?? path.join(options.fixturesRoot, options.datasetId);
  const fetchTile =
    options.tileDir === null
      ? createNetworkTileFetcher({ cacheDir: options.cacheDir })
      : createDirectoryTileFetcher({ tileDir: options.tileDir });

  const result = await generateFixture({
    datasetId: options.datasetId,
    outDir,
    sampleWidth: options.sampleWidth,
    sampleHeight: options.sampleHeight,
    force: options.force,
    concurrency: options.concurrency,
    fetchTile,
    log: (message) => console.log(message),
  });

  const mebibytes = result.totalBytes / (1024 * 1024);
  console.log(
    `${result.upToDate ? "up to date" : "generated"}: ${result.tileCount} fixture tile(s) from ${result.sourceTiles} source tile(s), totalBytes=${result.totalBytes} B (${mebibytes.toFixed(2)} MiB), sample grid ${options.sampleWidth}x${options.sampleHeight}`,
  );
  console.log(`source colour type(s): ${result.colorTypes.join(", ")}`);
  console.log(`elevation: min=${result.manifest.elevation.minHeight} m max=${result.manifest.elevation.maxHeight} m span=${result.manifest.elevation.span} m`);
  console.log(`content sha256: ${result.manifest.sha256}`);
  console.log(`dataset -> ${path.relative(REPO_ROOT, result.manifestPath).split(path.sep).join("/")}`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`build-terrain-fixture: ${error.message}`);
      process.exitCode = 1;
    });
}
