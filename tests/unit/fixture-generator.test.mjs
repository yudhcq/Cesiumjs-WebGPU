/**
 * T084 — the fixed-dataset generator (`tools/build-terrain-fixture.mjs`).
 *
 * Everything here runs **offline** on synthetic in-process inputs: the decode formula is asserted
 * against hand-computed bytes, the PNG path is cross-checked against the independent reader the
 * contract suites use (`tests/support/png-reader.mjs`), and the whole pipeline is exercised through
 * `generateFixture` with an injected source fetcher writing into a temporary directory. The one
 * real-world fact that is pinned down is the **source projection**: the AWS terrarium raster is
 * XYZ/Web-Mercator (a single tile at z0), so Mont Blanc's fixture tile must be resampled from the
 * Mercator tile at 12/2126/1459 — verified against the live endpoint when the generator was
 * written. Getting that wrong silently shifts every elevation by hundreds of metres.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { decodePng } from "../support/png-reader.mjs";
import {
  DEFAULT_RECTANGLE,
  HEIGHT_OFFSET,
  MERCATOR_MAX_LATITUDE,
  NO_DATA_VALUE,
  TILE_SIZE,
  computeDatasetContentHash,
  crc32,
  decodeHeightGrid,
  decodeTerrariumPixels,
  encodeHeightGrid,
  encodePng,
  encodeTerrariumRgb,
  generateFixture,
  latToMercatorPixelY,
  lonToMercatorPixelX,
  mercatorPixelToLonLat,
  parsePng,
  quantiseGrid,
  quantiseHeight,
  sourceTilesForDataset,
  sourceTilesForFixtureTile,
  tileRectangle,
  tilesForLevels,
} from "../../tools/build-terrain-fixture.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The height field the synthetic source paints, in metres, as a function of position. */
function syntheticHeight(longitude, latitude) {
  return 100 * ((longitude - 90) / 90) + (latitude - 45);
}

/** Build a Terrarium RGBA tile whose every pixel is `painter(longitude, latitude)`. */
function syntheticTerrariumTile(level, { width = TILE_SIZE, height = TILE_SIZE, painter = syntheticHeight, alpha = () => 255 } = {}) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { longitude, latitude } = mercatorPixelToLonLat(x + 0.5, y + 0.5, level);
      const [r, g, b] = encodeTerrariumRgb(painter(longitude, latitude));
      const offset = (y * width + x) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = alpha(longitude, latitude);
    }
  }
  return encodePng({ width, height, rgba });
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** A colour-type-3 (palette) PNG, the one PNG shape `tests/support/png-reader.mjs` cannot read. */
function palettePng(width, height, indices, palette) {
  const stride = 1 + width;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) raw[y * stride + 1 + x] = indices[y * width + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("PLTE", Buffer.from(palette.flat())),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("the Terrarium decode is exactly R * 256 + G + B / 256 - 32768", () => {
  const rgba = Buffer.from([
    0, 0, 0, 255, // 0 - 32768
    128, 0, 0, 255, // 128 * 256 - 32768 = 0
    255, 255, 255, 255, // 255 * 256 + 255 + 255/256 - 32768
    1, 2, 3, 255, // 256 + 2 + 3/256 - 32768
    0, 0, 1, 255, // 1/256 - 32768
  ]);
  const decoded = decodeTerrariumPixels(rgba, 5, 1);
  assert.equal(decoded.width, 5);
  assert.equal(decoded.height, 1);
  assert.equal(decoded.heights[0], -32768, "RGB(0,0,0) decodes to exactly -32768 m");
  assert.equal(decoded.heights[1], 0);
  assert.ok(Math.abs(decoded.heights[2] - (255 * 256 + 255 + 255 / 256 - 32768)) < 1e-9);
  assert.ok(Math.abs(decoded.heights[3] - (256 + 2 + 3 / 256 - 32768)) < 1e-9);
  assert.ok(Math.abs(decoded.heights[4] - (1 / 256 - 32768)) < 1e-9);
  assert.deepEqual([...decoded.valid], [1, 1, 1, 1, 1], "RGB(0,0,0) is a legal sample, never no data");
});

test("a source pixel with alpha 0 carries no data", () => {
  const decoded = decodeTerrariumPixels(Buffer.from([10, 0, 0, 255, 10, 0, 0, 0]), 2, 1);
  assert.deepEqual([...decoded.valid], [1, 0]);
  const quantised = quantiseGrid(decoded);
  assert.equal(quantised[0], quantiseHeight(decoded.heights[0]));
  assert.equal(quantised[1], NO_DATA_VALUE, "an invalid sample MUST be written as 65535");
});

test("quantisation is clamp(round(metres) + 32768, 0, 65534)", () => {
  assert.equal(quantiseHeight(-32768), 0, "the lowest representable height stores as 0");
  assert.equal(quantiseHeight(0), 32768);
  assert.equal(quantiseHeight(100.4), 32868, "rounds to the nearest metre");
  assert.equal(quantiseHeight(100.5), 32869);
  assert.equal(quantiseHeight(4808), 37576, "Mont Blanc");
  assert.equal(quantiseHeight(40000), 65534, "clamped below the no-data sentinel");
  assert.equal(quantiseHeight(-40000), 0);
  assert.equal(quantiseHeight(65535 - 32768), 65534, "65535 stays reserved for no data");
});

test("the .hgt payload is little-endian Uint16 with no header", () => {
  const buffer = encodeHeightGrid([0x1234, 0x00ff, 0xffff]);
  assert.deepEqual([...buffer], [0x34, 0x12, 0xff, 0x00, 0xff, 0xff]);
  assert.deepEqual([...decodeHeightGrid(buffer)], [0x1234, 0x00ff, 0xffff]);
  assert.equal(buffer.length, 6);
  assert.throws(() => decodeHeightGrid(Buffer.alloc(3)), /not a multiple of 2/);
});

test("parsePng agrees with the shared repository PNG reader on a synthetic tile", () => {
  const png = syntheticTerrariumTile(0);
  const mine = parsePng(png);
  const theirs = decodePng(png);
  assert.equal(mine.colorType, 6, "encodePng writes colour type 6 (RGBA)");
  assert.equal(mine.bitDepth, 8);
  assert.equal(mine.width, TILE_SIZE);
  assert.equal(mine.height, TILE_SIZE);
  assert.equal(theirs.width, TILE_SIZE);
  assert.equal(theirs.height, TILE_SIZE);
  assert.deepEqual(Buffer.from(mine.rgba), Buffer.from(theirs.rgba), "the two decoders MUST agree byte for byte");
  // ... and the same pixels decode to the same heights through the Terrarium formula.
  assert.deepEqual([...decodeTerrariumPixels(mine.rgba, mine.width, mine.height).heights], [
    ...decodeTerrariumPixels(theirs.rgba, theirs.width, theirs.height).heights,
  ]);
});

test("parsePng resolves palette tiles (colour type 3), which the shared reader cannot", () => {
  const palette = [
    [10, 20, 30],
    [200, 100, 50],
  ];
  const image = parsePng(palettePng(2, 2, [0, 1, 1, 0], palette));
  assert.equal(image.colorType, 3);
  assert.deepEqual([...image.rgba], [10, 20, 30, 255, 200, 100, 50, 255, 200, 100, 50, 255, 10, 20, 30, 255]);
});

test("parsePng fails loudly instead of guessing", () => {
  assert.throws(() => parsePng(Buffer.from("not a png at all")), /bad signature/);
  const png = syntheticTerrariumTile(1, { width: 4, height: 4 });
  const corrupted = Buffer.from(png);
  corrupted[corrupted.length - 20] ^= 0xff;
  assert.throws(() => parsePng(corrupted), /CRC mismatch|truncated|unsupported/);
});

test("the source raster is XYZ/Web-Mercator: one tile at z0, and Mont Blanc comes from 12/2126/1459", () => {
  // Web-Mercator has a single tile at z0, while a geographic scheme would have two (x = 0 and 1).
  // Fetching x = 1 at z0 is exactly the 404 the live endpoint returns, so this pins the convention.
  assert.deepEqual(sourceTilesForDataset(DEFAULT_RECTANGLE, [0]), [{ level: 0, x: 0, y: 0 }]);
  assert.ok(lonToMercatorPixelX(180, 0) / TILE_SIZE === 1, "the world is exactly one tile wide at z0");

  const level = 12;
  const span = 180 / 2 ** level;
  const montBlanc = { longitude: 6.8652, latitude: 45.8326 };
  const fixtureTile = { x: Math.floor((montBlanc.longitude + 180) / span), y: Math.floor((90 - montBlanc.latitude) / span) };
  assert.deepEqual(fixtureTile, { x: 4252, y: 1005 }, "Mont Blanc sits in geographic fixture tile 12/4252/1005");
  const expectedSource = {
    x: Math.floor(lonToMercatorPixelX(montBlanc.longitude, level) / TILE_SIZE),
    y: Math.floor(latToMercatorPixelY(montBlanc.latitude, level) / TILE_SIZE),
  };
  assert.deepEqual(expectedSource, { x: 2126, y: 1459 }, "the Mercator tile holding Mont Blanc (measured max 4789.8 m)");
  const sources = sourceTilesForFixtureTile(level, fixtureTile.x, fixtureTile.y);
  assert.ok(
    sources.some((tile) => tile.x === expectedSource.x && tile.y === expectedSource.y),
    `fixture tile 12/${fixtureTile.x}/${fixtureTile.y} MUST be resampled from Mercator tile 12/${expectedSource.x}/${expectedSource.y}, got ${JSON.stringify(sources)}`,
  );
});

test("generateFixture writes <level>/<x>/<y>.hgt plus a manifest from a synthetic source", async (t) => {
  const outDir = temporaryDirectory(t, "fixture-layout-");
  const requested = [];
  const png = syntheticTerrariumTile(0);
  const result = await generateFixture({
    datasetId: "synthetic-z0",
    outDir,
    levels: [0],
    sampleWidth: 4,
    sampleHeight: 4,
    fetchTile: async (level, x, y) => {
      requested.push(`${level}/${x}/${y}`);
      return png;
    },
  });

  assert.deepEqual(requested, ["0/0/0"], "only the covering Mercator source tile is fetched");
  assert.equal(result.upToDate, false);
  assert.deepEqual(result.colorTypes, [6]);

  const expectedTiles = tilesForLevels(DEFAULT_RECTANGLE, [0]);
  assert.deepEqual(expectedTiles, [{ level: 0, x: 1, y: 0 }]);
  const file = path.join(outDir, "0", "1", "0.hgt");
  assert.ok(fs.existsSync(file), "the file layout MUST be <level>/<x>/<y>.hgt");
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, 4 * 4 * 2, "each tile holds sampleWidth * sampleHeight little-endian Uint16 samples");

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  assert.equal(manifest.datasetId, "synthetic-z0");
  assert.equal(manifest.tilingScheme, "geographic");
  assert.equal(manifest.encoding, "le-uint16-metres-offset-32768");
  assert.equal(manifest.noDataValue, NO_DATA_VALUE);
  assert.equal(manifest.sampleWidth, 4);
  assert.equal(manifest.sampleHeight, 4);
  assert.deepEqual(manifest.levels, [0]);
  assert.deepEqual(
    { west: manifest.rectangle.west, south: manifest.rectangle.south, east: manifest.rectangle.east, north: manifest.rectangle.north },
    DEFAULT_RECTANGLE,
  );
  assert.equal(manifest.tileCount, 1);
  assert.deepEqual(manifest.tiles, [
    { level: 0, x: 1, y: 0, path: "0/1/0.hgt", bytes: 32, sha256: manifest.tiles[0].sha256 },
  ]);
  assert.equal(manifest.totalBytes, 32);
  assert.equal(manifest.contentHash.value, computeDatasetContentHash(manifest.tiles));
  assert.equal(manifest.sha256, manifest.contentHash.value);
  assert.match(manifest.contentHash.definition, /<level>\/<x>\/<y>\.hgt <sha256-hex>/);
  assert.ok(typeof manifest.attribution === "string" && manifest.attribution.length > 0);
  assert.ok(Array.isArray(manifest.sources) && manifest.sources.every((source) => source.license && source.url));
});

test("every sample sits at its cell centre, mapped through the Mercator transform", async (t) => {
  const outDir = temporaryDirectory(t, "fixture-values-");
  // 20 rows over the z0 tile's 180° of latitude puts the outermost row centres at ±85.5° — beyond
  // the Web-Mercator limit — so this single run also exercises the edge-replication rule.
  const size = 20;
  await generateFixture({
    datasetId: "synthetic-centres",
    outDir,
    levels: [0],
    sampleWidth: size,
    sampleHeight: size,
    fetchTile: async (level) => syntheticTerrariumTile(level),
  });

  // A geographic level-0 tile covers half the world in longitude and the whole latitude range.
  const rectangle = tileRectangle(0, 1, 0);
  assert.deepEqual(rectangle, { west: 0, east: 180, south: -90, north: 90 });
  const samples = decodeHeightGrid(fs.readFileSync(path.join(outDir, "0", "1", "0.hgt")));
  assert.equal(samples.length, size * size);
  let replicated = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const longitude = rectangle.west + ((column + 0.5) * (rectangle.east - rectangle.west)) / size;
      const latitude = rectangle.north - ((row + 0.5) * (rectangle.north - rectangle.south)) / size;
      // Above / below the Web-Mercator limit there is no source pixel: the generator edge-replicates
      // the outermost source row (documented in the manifest as outOfProjectionRule).
      const beyond = Math.abs(latitude) > MERCATOR_MAX_LATITUDE;
      if (beyond) replicated += 1;
      const expected = syntheticHeight(longitude, beyond ? Math.sign(latitude) * MERCATOR_MAX_LATITUDE : latitude);
      const actual = samples[row * size + column] - HEIGHT_OFFSET;
      assert.ok(
        Math.abs(actual - expected) <= 2,
        `sample (${row},${column}) at ${longitude.toFixed(3)}E/${latitude.toFixed(3)}N: stored ${actual} m, expected ${expected.toFixed(3)} m`,
      );
    }
  }
  assert.equal(replicated, 2 * size, "the two polar rows MUST have exercised edge replication");
});

test("a transparent source produces no-data samples, not zeroes", async (t) => {
  const outDir = temporaryDirectory(t, "fixture-nodata-");
  const result = await generateFixture({
    datasetId: "synthetic-transparent",
    outDir,
    levels: [0],
    sampleWidth: 4,
    sampleHeight: 4,
    fetchTile: async (level) => syntheticTerrariumTile(level, { alpha: () => 0 }),
  });
  const samples = decodeHeightGrid(fs.readFileSync(path.join(outDir, "0", "1", "0.hgt")));
  assert.ok([...samples].every((sample) => sample === NO_DATA_VALUE), "a fully transparent source MUST yield 65535 everywhere");
  assert.equal(result.manifest.elevation.noDataSamples, 16);
  assert.equal(result.manifest.elevation.minHeight, null);
  assert.equal(result.manifest.elevation.maxHeight, null);
});

test("a matching dataset makes a re-run a no-op, while --force regenerates", async (t) => {
  const outDir = temporaryDirectory(t, "fixture-idempotent-");
  const png = syntheticTerrariumTile(0);
  let fetches = 0;
  const parameters = { datasetId: "synthetic-idempotent", outDir, levels: [0], sampleWidth: 4, sampleHeight: 4 };

  const first = await generateFixture({ ...parameters, fetchTile: async (level) => (fetches += 1, syntheticTerrariumTile(level)) });
  assert.equal(first.upToDate, false);
  assert.equal(fetches, 1);
  const committed = fs.readFileSync(path.join(outDir, "0", "1", "0.hgt"));

  const second = await generateFixture({
    ...parameters,
    fetchTile: async () => {
      throw new Error("a matching dataset MUST NOT be re-downloaded");
    },
  });
  assert.equal(second.upToDate, true, "the re-run MUST be a no-op");
  assert.equal(second.totalBytes, first.totalBytes);

  const forced = await generateFixture({ ...parameters, force: true, fetchTile: async (level) => (fetches += 1, syntheticTerrariumTile(level)) });
  assert.equal(forced.upToDate, false, "--force MUST regenerate");
  assert.equal(fetches, 2);
  assert.deepEqual(fs.readFileSync(path.join(outDir, "0", "1", "0.hgt")), committed, "regeneration MUST be byte-identical");

  const changed = await generateFixture({ ...parameters, sampleWidth: 8, fetchTile: async (level) => (fetches += 1, syntheticTerrariumTile(level)) });
  assert.equal(changed.upToDate, false, "a different sample grid MUST regenerate");
  assert.equal(fs.readFileSync(path.join(outDir, "0", "1", "0.hgt")).length, 8 * 4 * 2);
  assert.ok(fetches >= 3);
  assert.ok(png.length > 0);
});
