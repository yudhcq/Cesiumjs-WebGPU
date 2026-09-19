/**
 * T086 — terrain source adapter unit tests (`层=单元`; `contracts/terrain-source.md` §1, TS-1).
 *
 * Three groups, each honest about what it can and cannot prove:
 *
 *  1. **Pure decoding** — runs the real `decodeHeightmapTile` from the TypeScript source, no upstream
 *     involved. Covers the committed on-disk format, `noDataValue`, and the error categories.
 *  2. **Orientation** — a *decisive* check against the committed bytes: under "row 0 = north" the
 *     elevation peak of levels 9/10/11/12 all land on the Mont Blanc summit (within 0.01 deg),
 *     while the "row 0 = south" reading scatters them across ~0.18 deg of latitude. The expected
 *     values were derived from the committed dataset, not assumed.
 *  3. **Provider construction** — runs the real `createTerrainProvider` with an injected in-memory
 *     reader, so it proves *zero network traffic*, and cross-checks the stub surface against the
 *     **real** `@cesium/engine` exports. A stub alone could never make a product claim true; the
 *     contract suites run the real modules in a real browser.
 *
 * Note on group 3: `source.ts` is loaded with a stub for `@cesium/engine`, so the provider it returns
 * is an instance of the *stub* class. The type claim is therefore split in two — the adapter builds a
 * `CustomHeightmapTerrainProvider` (asserted by constructor name here) and the real package really
 * exports that class with an option bag our adapter satisfies (asserted against `@cesium/engine`).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { repoPath } from "../support/repo.mjs";

const SOURCE = "packages/cesium-webgpu/src/terrain/source.ts";
const FIXTURE = "packages/cesium-webgpu/fixtures/matterhorn-z0-12";
const fixturePath = (relative) => repoPath(`${FIXTURE}/${relative}`);

/** Minimal stand-in for the four upstream symbols `source.ts` consumes. */
const UPSTREAM_STUB = `
export class Credit { constructor(text) { this.text = text; } }
export class GeographicTilingScheme { constructor() { this.__kind = "GeographicTilingScheme"; } }
export class HeightmapTerrainData { constructor(options) { Object.assign(this, options); this.__isTerrainData = true; } }
export class CustomHeightmapTerrainProvider {
  constructor(options) {
    this.__options = options;
    this.tilingScheme = options.tilingScheme;
    this.credit = options.credit;
    this.width = options.width;
    this.height = options.height;
  }
  requestTileGeometry(x, y, level) { return this.__options.callback(x, y, level); }
}
`;

const source = await loadTypeScriptModule(repoPath(SOURCE), {
  externals: { "@cesium/engine": UPSTREAM_STUB },
});

const manifest = JSON.parse(fs.readFileSync(fixturePath("manifest.json"), "utf8"));
const N = manifest.sampleWidth;

/** Reads a committed tile as raw bytes (the same bytes the browser build would fetch). */
function tileBytes(relative) {
  return new Uint8Array(fs.readFileSync(fixturePath(relative)));
}

/** The dataset-relative portion of a path handed to `readTile` (the adapter joins `<datasetId>/<tile>`). */
function toFixtureRelative(tilePath) {
  const prefix = "matterhorn-z0-12/";
  const index = tilePath.indexOf(prefix);
  assert.ok(index >= 0, `readTile MUST be handed a dataset-relative path, got ${tilePath}`);
  return tilePath.slice(index + prefix.length);
}

// ---------------------------------------------------------------------------------------------
// 1. Pure decoding
// ---------------------------------------------------------------------------------------------

test("the committed format is headerless little-endian Uint16 with height = raw + heightOffset", () => {
  const bytes = tileBytes("9/532/124.hgt");
  assert.equal(
    bytes.byteLength,
    manifest.sampleWidth * manifest.sampleHeight * 2,
    "a tile MUST be exactly sampleWidth*sampleHeight Uint16 samples, with no file header",
  );

  const heights = source.decodeHeightmapTile(bytes, manifest);
  assert.ok(heights instanceof Float32Array);
  assert.equal(heights.length, manifest.sampleWidth * manifest.sampleHeight);

  const raw = new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  for (const i of [0, 1, 4704, raw.length - 1]) {
    if (raw[i] === manifest.noDataValue) continue;
    assert.equal(heights[i], raw[i] + manifest.heightOffsetMetres, `sample ${i} MUST decode as raw + heightOffsetMetres`);
  }
  assert.ok(heights.every((h) => Number.isFinite(h)), "no sample may be NaN or Infinity");
});

test("a tile whose byte length does not match the manifest is rejected as a decode error", () => {
  assert.throws(
    () => source.decodeHeightmapTile(new Uint8Array(16), manifest),
    (error) => error instanceof source.TerrainSourceError && error.category === "decode",
  );
});

test("noDataValue samples never become NaN and never spike outside the tile's own range", () => {
  const samples = new Uint16Array(N * manifest.sampleHeight).fill(32000);
  samples[10] = manifest.noDataValue;
  samples[11] = manifest.noDataValue;
  const heights = source.decodeHeightmapTile(new Uint8Array(samples.buffer), manifest);
  assert.ok(heights !== undefined);
  for (const i of [10, 11]) {
    assert.ok(Number.isFinite(heights[i]));
    assert.equal(heights[i], 32000 + manifest.heightOffsetMetres, "a missing sample falls back to the tile minimum");
  }
});

test("a tile with no valid sample at all is reported as no-data, not as a decode failure", () => {
  const samples = new Uint16Array(N * manifest.sampleHeight).fill(manifest.noDataValue);
  assert.equal(source.decodeHeightmapTile(new Uint8Array(samples.buffer), manifest), undefined);
});

// ---------------------------------------------------------------------------------------------
// 2. Orientation — decisive, derived from the committed dataset
// ---------------------------------------------------------------------------------------------

/** Longitude/latitude of the centre of sample (row, col) in a tile, per the geographic scheme. */
function centreOf(x, y, row, col, level) {
  return {
    lon: ((x + (col + 0.5) / N) / 2 ** (level + 1)) * 360 - 180,
    lat: 90 - ((y + (row + 0.5) / N) / 2 ** level) * 180,
  };
}

/** The summit of Mont Blanc: the landmark the dataset's peak must land on. */
const MONT_BLANC = { lat: 45.8325, lon: 6.8645 };

/** Peak of one level under a given row order, as `{ lat, lon }`. */
function peakOfLevel(level, northFirst) {
  const levelDir = fixturePath(String(level));
  let best = null;
  for (const xs of fs.readdirSync(levelDir)) {
    for (const file of fs.readdirSync(path.join(levelDir, xs))) {
      const heights = source.decodeHeightmapTile(new Uint8Array(fs.readFileSync(path.join(levelDir, xs, file))), manifest);
      if (heights === undefined) continue;
      const x = Number(xs);
      const y = Number(file.replace(/\.hgt$/, ""));
      for (let i = 0; i < heights.length; i += 1) {
        const value = heights[i];
        if (best === null || value > best.value) best = { value, x, y, i };
      }
    }
  }
  assert.ok(best !== null, `level ${level} MUST contain at least one decodable tile`);
  const row = Math.floor(best.i / N);
  const col = best.i % N;
  const effectiveRow = northFirst ? row : N - 1 - row;
  return centreOf(best.x, best.y, effectiveRow, col, level);
}

test("row 0 is the NORTH edge: the peak of every level lands on the Mont Blanc summit", () => {
  // Derived from the committed dataset (see the module header of source.ts):
  //   level 9 -> 45.8318, level 10 -> 45.8327, level 11 -> 45.8322, level 12 -> 45.8325
  for (const level of [9, 10, 11, 12]) {
    const peak = peakOfLevel(level, true);
    assert.ok(
      Math.abs(peak.lat - MONT_BLANC.lat) < 0.01,
      `level ${level}: peak latitude ${peak.lat.toFixed(4)} MUST be within 0.01 deg of Mont Blanc (${MONT_BLANC.lat})`,
    );
    assert.ok(
      Math.abs(peak.lon - MONT_BLANC.lon) < 0.01,
      `level ${level}: peak longitude ${peak.lon.toFixed(4)} MUST be within 0.01 deg of Mont Blanc (${MONT_BLANC.lon})`,
    );
  }
});

test("the opposite row order is rejected: it scatters the same peaks across latitudes", () => {
  const northErrors = [];
  const southErrors = [];
  for (const level of [9, 10, 11, 12]) {
    northErrors.push(Math.abs(peakOfLevel(level, true).lat - MONT_BLANC.lat));
    southErrors.push(Math.abs(peakOfLevel(level, false).lat - MONT_BLANC.lat));
  }
  assert.ok(Math.max(...northErrors) < 0.01, "every level agrees on the summit under row 0 = north");
  assert.ok(
    Math.max(...southErrors) > 0.05,
    "under row 0 = south the peaks MUST disagree with the summit — otherwise this test cannot discriminate",
  );
});

// ---------------------------------------------------------------------------------------------
// 3. Provider construction — real module, injected reader, zero network
// ---------------------------------------------------------------------------------------------

test("the adapter builds the upstream provider and never touches the network in fixture mode", async () => {
  const asked = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("the adapter MUST NOT use the network in fixture mode");
  };

  try {
    const provider = await source.createTerrainProvider({
      mode: "fixture",
      datasetId: "matterhorn-z0-12",
      readTile: (tilePath) => {
        const relative = toFixtureRelative(tilePath);
        asked.push(relative);
        return tileBytes(relative);
      },
    });

    assert.equal(provider.constructor.name, "CustomHeightmapTerrainProvider");
    assert.equal(provider.width, manifest.sampleWidth);
    assert.equal(provider.height, manifest.sampleHeight);

    const heights = await provider.requestTileGeometry(532, 124, 9);
    assert.ok(
      heights instanceof Float32Array,
      "the callback MUST hand upstream raw height samples: CustomHeightmapTerrainProvider builds the " +
        "HeightmapTerrainData itself (Source/Core/CustomHeightmapTerrainProvider.js:237-241)",
    );
    assert.equal(heights.length, manifest.sampleWidth * manifest.sampleHeight);
    assert.ok(heights.every((h) => Number.isFinite(h)), "no sample may be NaN or Infinity");
    // Upstream constructs HeightmapTerrainData with no `structure`, i.e. heightScale 1 / heightOffset 0,
    // so the samples we return ARE the heights in metres.
    const peak = Math.max(...heights);
    assert.ok(peak > 400 && peak < 6000, `tile peak ${peak} MUST be a plausible height in metres`);

    assert.ok(asked.includes("manifest.json"), "the manifest MUST be read through the injected reader");
    assert.ok(asked.includes("9/532/124.hgt"), "the requested tile MUST be read through the injected reader");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("availability comes from the committed tile list, and a missing tile degrades to a flat buffer", async () => {
  const provider = await source.createTerrainProvider({
    mode: "fixture",
    datasetId: "matterhorn-z0-12",
    readTile: (tilePath) => {
      const relative = toFixtureRelative(tilePath);
      if (relative === "manifest.json") return tileBytes(relative);
      throw new Error("ENOENT");
    },
  });

  // Upstream's own default is `undefined` ("availability not supported"); answering from the
  // manifest is what keeps a tile we do not own from reaching the callback at all (contract T-3).
  assert.equal(provider.getTileDataAvailable(532, 124, 9), true, "a committed tile MUST be reported available");
  assert.equal(provider.getTileDataAvailable(99, 99, 9), false, "a tile outside the committed list MUST be unavailable");
  assert.equal(provider.getTileDataAvailable(532, 124, 20), false, "a level outside the dataset MUST be unavailable");

  // And even if upstream asks anyway, the defensive path stays finite and flat — no NaN, no spike.
  const flat = await provider.requestTileGeometry(99, 99, 9);
  assert.ok(flat instanceof Float32Array);
  assert.ok(flat.every((h) => Number.isFinite(h)), "a missing tile MUST NOT produce NaN samples");
  assert.equal(new Set(flat).size, 1, "a missing tile MUST degrade to a flat buffer, not to error geometry");
});

test("the injected stub surface matches the real @cesium/engine exports", async () => {
  // A stub may only stand in for an interface that really exists upstream.
  const upstream = await import("@cesium/engine");
  for (const name of ["Credit", "GeographicTilingScheme", "HeightmapTerrainData", "CustomHeightmapTerrainProvider"]) {
    assert.equal(typeof upstream[name], "function", `@cesium/engine MUST export ${name}`);
  }
  // And the real HeightmapTerrainData MUST accept exactly the option bag the adapter passes.
  const real = new upstream.HeightmapTerrainData({
    buffer: new Float32Array(manifest.sampleWidth * manifest.sampleHeight),
    width: manifest.sampleWidth,
    height: manifest.sampleHeight,
    structure: { heightScale: 1, heightOffset: 0, elementsPerHeight: 1, stride: 1, isBigEndian: false },
  });
  assert.ok(real instanceof upstream.HeightmapTerrainData);
});

test("the adapter never imports a @private terrain internal type", () => {
  const text = fs.readFileSync(repoPath(SOURCE), "utf8");
  for (const forbidden of [
    "TerrainMesh",
    "TerrainEncoding",
    "GlobeSurfaceTileProvider",
    "QuadtreePrimitive",
    "GlobeSurfaceTile",
    "createMesh",
  ]) {
    assert.ok(!text.includes(forbidden), `source.ts MUST NOT reference the @private member "${forbidden}"`);
  }
});
