/**
 * T088 — "data unavailable" is a **classified, observable state**, not a thrown error (FR-004 / TS-5).
 *
 * The four ways a tile's data can fail to arrive are exercised one at a time, and each case asserts the
 * same three things:
 *
 *   (a) nothing is thrown out of the provider call — the promise resolves;
 *   (b) the diagnostic says exactly `category: "data-unavailable"`, with the fault named by `failure`
 *       (`missing` / `reader-error` / `timeout` / `empty`), *and* a deliberately different fault
 *       (undecodable bytes) says something else — otherwise the label proves nothing;
 *   (c) the heights handed upstream are finite, inside the dataset's own vertical range and free of
 *       spikes (a degraded tile is flat at the dataset floor, never a hole and never a NaN);
 *   (d) **the other tiles are unaffected**: concurrent requests for healthy tiles still return the
 *       real committed data while the failing ones degrade.
 *
 * The adapter is loaded with the real `@cesium/engine` **not** involved (a stub stands in for the four
 * symbols `source.ts` consumes), so this layer stays GPU-free and network-free. The contract suite
 * `contract:terrain-unavailable` runs the same code inside a real scene in a real browser.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { repoPath } from "../support/repo.mjs";

const SOURCE = "packages/cesium-webgpu/src/terrain/source.ts";
const FIXTURE = "packages/cesium-webgpu/fixtures/matterhorn-z0-12";
const DATASET_ID = "matterhorn-z0-12";
const fixturePath = (relative) => repoPath(`${FIXTURE}/${relative}`);

/** Minimal stand-in for the four upstream symbols `source.ts` consumes (same shape as T086's). */
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

const source = await loadTypeScriptModule(repoPath(SOURCE), { externals: { "@cesium/engine": UPSTREAM_STUB } });

const manifest = JSON.parse(fs.readFileSync(fixturePath("manifest.json"), "utf8"));
const SAMPLE_COUNT = manifest.sampleWidth * manifest.sampleHeight;

/** The vertical range the committed dataset itself covers; a legal tile cannot leave it. */
const DATASET_FLOOR = Math.min(...manifest.levelSummary.map((entry) => entry.minHeight));
const DATASET_CEILING = Math.max(...manifest.levelSummary.map((entry) => entry.maxHeight));

/** A committed tile that really exists, used as the "healthy neighbour" of every failing tile. */
const HEALTHY = { level: 9, x: 532, y: 124 };

function tileBytes(relative) {
  return new Uint8Array(fs.readFileSync(fixturePath(relative)));
}

/** The dataset-relative portion of a path handed to `readTile` (the adapter joins `<datasetId>/<tile>`). */
function toFixtureRelative(tilePath) {
  const prefix = `${DATASET_ID}/`;
  const index = tilePath.indexOf(prefix);
  assert.ok(index >= 0, `readTile MUST be handed a dataset-relative path, got ${tilePath}`);
  const relative = tilePath.slice(index + prefix.length);
  return relative === "manifest.json" ? null : relative;
}

/**
 * Build a provider whose reader serves the committed manifest plus a per-tile behaviour map.
 *
 * `behaviour(relative)` returns one of:
 *   `"serve"`  — the real committed bytes;
 *   `"throw"`  — the reader rejects (a 404/network failure, as far as this layer can tell);
 *   `"hang"`   — the reader never settles (a request that is neither answered nor refused);
 *   `"short"`  — bytes that cannot be decoded (a truncated/corrupt tile);
 *   `"empty"`  — a well-formed tile in which every sample is `noDataValue`.
 */
async function providerWith({ behaviour, timeoutMs = 250, diagnostics = [], reads = [] }) {
  const provider = await source.createTerrainProvider({
    mode: "fixture",
    datasetId: DATASET_ID,
    tileTimeoutMs: timeoutMs,
    onTileDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    readTile: (tilePath) => {
      const relative = toFixtureRelative(tilePath);
      if (relative === null) return tileBytes("manifest.json");
      reads.push(relative);
      const action = behaviour(relative);
      if (action === "throw") throw new Error(`ENOENT: simulated missing tile ${relative}`);
      if (action === "hang") return new Promise(() => {});
      if (action === "short") return new Uint8Array(16);
      if (action === "empty") {
        const samples = new Uint16Array(SAMPLE_COUNT).fill(manifest.noDataValue);
        return new Uint8Array(samples.buffer);
      }
      return tileBytes(relative);
    },
  });
  return provider;
}

/** Assertion shared by every failure class: no NaN, no spike, no out-of-range sample. */
function assertLegalHeights(heights, label) {
  assert.ok(heights instanceof Float32Array, `${label}: the provider MUST still hand upstream a Float32Array`);
  assert.equal(heights.length, SAMPLE_COUNT, `${label}: a degraded tile MUST keep the dataset's sample shape`);
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of heights) {
    assert.ok(Number.isFinite(value), `${label}: sample ${value} MUST NOT be NaN or Infinity — that is error geometry`);
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  assert.ok(minimum >= DATASET_FLOOR - 1, `${label}: minimum ${minimum} MUST stay inside the dataset floor ${DATASET_FLOOR}`);
  assert.ok(maximum <= DATASET_CEILING + 1, `${label}: maximum ${maximum} MUST stay inside the dataset ceiling ${DATASET_CEILING}`);
  return { minimum, maximum };
}

// ---------------------------------------------------------------------------------------------
// 1. Each of the three required faults: missing / reader error / timeout
// ---------------------------------------------------------------------------------------------

test("a tile missing from the committed dataset is classified data-unavailable/missing without reading anything", async () => {
  const diagnostics = [];
  const reads = [];
  // Every tile read would fail: if the adapter read first and classified afterwards, the diagnostic
  // would say `reader-error`. It must not read at all — the manifest is the authoritative answer.
  const provider = await providerWith({ behaviour: () => "throw", diagnostics, reads });

  const heights = await provider.requestTileGeometry(9999, 9999, 9);
  assert.equal(reads.length, 0, `a tile absent from the manifest MUST NOT be read (reads: ${reads.join(", ")})`);
  assert.equal(diagnostics.length, 1, "exactly one diagnostic MUST be reported");
  const [diagnostic] = diagnostics;
  assert.equal(diagnostic.category, "data-unavailable");
  assert.equal(diagnostic.failure, "missing");
  assert.deepEqual([diagnostic.level, diagnostic.x, diagnostic.y], [9, 9999, 9999], "the diagnostic MUST name the tile it is about");
  assertLegalHeights(heights, "missing tile");
  assert.equal(new Set(heights).size, 1, "a tile with no data MUST degrade to a flat buffer, not to error geometry");
});

test("a reader that rejects is classified data-unavailable/reader-error and does not throw out of the call", async () => {
  const diagnostics = [];
  const provider = await providerWith({ behaviour: () => "throw", diagnostics });
  const heights = await provider.requestTileGeometry(HEALTHY.x, HEALTHY.y, HEALTHY.level);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].category, "data-unavailable");
  assert.equal(diagnostics[0].failure, "reader-error");
  assert.match(diagnostics[0].reason, /simulated missing tile/);
  assertLegalHeights(heights, "reader error");
  assert.equal(new Set(heights).size, 1);
});

test("a reader that never settles times out into data-unavailable/timeout — the page cannot hang on it", async () => {
  const diagnostics = [];
  const provider = await providerWith({ behaviour: () => "hang", timeoutMs: 120, diagnostics });

  const started = Date.now();
  const heights = await provider.requestTileGeometry(HEALTHY.x, HEALTHY.y, HEALTHY.level);
  const elapsed = Date.now() - started;

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].category, "data-unavailable");
  assert.equal(diagnostics[0].failure, "timeout");
  assert.ok(elapsed >= 100, `the call MUST wait for the timeout before degrading (settled after ${elapsed} ms)`);
  assert.ok(elapsed < 5000, `the call MUST settle at the timeout, not hang (settled after ${elapsed} ms)`);
  assertLegalHeights(heights, "timeout");
  assert.equal(new Set(heights).size, 1);
});

test("an undecodable tile is a DIFFERENT category — the classification is not a constant label", async () => {
  const diagnostics = [];
  const provider = await providerWith({ behaviour: () => "short", diagnostics });
  const heights = await provider.requestTileGeometry(HEALTHY.x, HEALTHY.y, HEALTHY.level);

  assert.equal(diagnostics.length, 1, "the undecodable tile MUST be reported rather than thrown");
  assert.equal(diagnostics[0].failure, "decode-error");
  assert.notEqual(
    diagnostics[0].category,
    "data-unavailable",
    "an undecodable tile is a decode fault, not missing data — if both were labelled the same, the label could not distinguish anything",
  );
  assert.equal(diagnostics[0].category, "decode");
  // A different classification MUST NOT mean different geometry safety: no NaN here either.
  assertLegalHeights(heights, "decode error");
  assert.equal(new Set(heights).size, 1);
});

test("a well-formed but empty tile is data-unavailable/empty, not a decode failure", async () => {
  const diagnostics = [];
  const provider = await providerWith({ behaviour: () => "empty", diagnostics });
  const heights = await provider.requestTileGeometry(HEALTHY.x, HEALTHY.y, HEALTHY.level);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].category, "data-unavailable");
  assert.equal(diagnostics[0].failure, "empty", "an all-noDataValue tile carries no data; it is not a decode error");
  assertLegalHeights(heights, "empty tile");
});

test("a dataset whose manifest cannot be decoded fails as a classified error, not as a raw exception", async () => {
  // The reverse-direction control at the provider level: a *non-data* fault (unparseable manifest)
  // MUST NOT be reported as "data-unavailable", or the two states would be indistinguishable.
  await assert.rejects(
    () =>
      source.createTerrainProvider({
        mode: "fixture",
        datasetId: DATASET_ID,
        readTile: (tilePath) => (toFixtureRelative(tilePath) === null ? new TextEncoder().encode("{ not json") : tileBytes("9/532/124.hgt")),
      }),
    (error) => error instanceof source.TerrainSourceError && error.category === "decode",
    "an unparseable manifest MUST be classified as `decode`, never as `data-unavailable`",
  );

  // …and the missing-dataset case really is `data-unavailable`, so the two categories are both live.
  await assert.rejects(
    () =>
      source.createTerrainProvider({
        mode: "fixture",
        datasetId: DATASET_ID,
        readTile: () => {
          throw new Error("ENOENT: no such dataset");
        },
      }),
    (error) => error instanceof source.TerrainSourceError && error.category === "data-unavailable",
  );
});

// ---------------------------------------------------------------------------------------------
// 2. The other tiles are unaffected — the point of "degrade, never reject"
// ---------------------------------------------------------------------------------------------

test("healthy tiles keep returning real data while a failing neighbour degrades (concurrently)", async () => {
  const diagnostics = [];
  // The healthy neighbours are the *served* ones; only the exact failing coordinates are broken, and
  // the failures are asked for **at the same time** as the healthy reads, so a sequential
  // "everything after the first failure is broken" implementation would be caught.
  // (All four coordinates are committed tiles — level 9 holds exactly 531..532 x 124..126 — so a
  // failure here can only come from the reader, never from the missing-tile short-circuit.)
  const failing = new Set(["9/532/125", "9/531/125"]);
  const provider = await providerWith({
    behaviour: (relative) => (failing.has(relative.replace(/\.hgt$/, "")) ? "throw" : "serve"),
    diagnostics,
  });

  const requests = [
    provider.requestTileGeometry(532, 124, 9),
    provider.requestTileGeometry(532, 125, 9),
    provider.requestTileGeometry(531, 125, 9),
    provider.requestTileGeometry(532, 126, 9),
  ];
  const [healthy, firstFailure, secondFailure, healthyToo] = await Promise.all(requests);

  assert.equal(diagnostics.length, 2, "both failing tiles MUST be reported");
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.category, "data-unavailable");
    assert.equal(diagnostic.failure, "reader-error");
  }

  // The healthy tiles carry the committed data: their range must match the committed bytes exactly.
  for (const [heights, label] of [
    [healthy, "9/532/124"],
    [healthyToo, "9/532/126"],
  ]) {
    const expected = source.decodeHeightmapTile(tileBytes(`${label}.hgt`), manifest);
    assert.ok(expected !== undefined, `${label} MUST be a decodable committed tile`);
    assert.deepEqual(Array.from(heights), Array.from(expected), `${label} MUST return the committed heights unchanged`);
    assert.ok(new Set(heights).size > 1, `${label} MUST NOT be flat — real terrain was returned`);
  }
  // The failing tiles are flat at the dataset floor, i.e. present but data-free — no hole, no spike.
  for (const [heights, label] of [
    [firstFailure, "9/532/125"],
    [secondFailure, "9/531/125"],
  ]) {
    assertLegalHeights(heights, label);
    assert.equal(new Set(heights).size, 1, `${label} MUST degrade to a flat buffer`);
  }
});

test("availability is still answered from the manifest, so upstream is not asked to render what we do not have", async () => {
  const provider = await providerWith({ behaviour: () => "serve", diagnostics: [] });
  assert.equal(provider.getTileDataAvailable(HEALTHY.x, HEALTHY.y, HEALTHY.level), true);
  assert.equal(provider.getTileDataAvailable(9999, 9999, 9), false);
});

// ---------------------------------------------------------------------------------------------
// 3. The observer itself cannot become the failure
// ---------------------------------------------------------------------------------------------

test("a throwing observer is contained: the tile still degrades and the other tiles still render", async () => {
  const seen = [];
  const provider = await source.createTerrainProvider({
    mode: "fixture",
    datasetId: DATASET_ID,
    tileTimeoutMs: 120,
    onTileDiagnostic: (diagnostic) => {
      seen.push(diagnostic.category);
      throw new Error("the observer is broken on purpose");
    },
    readTile: (tilePath) => {
      const relative = toFixtureRelative(tilePath);
      if (relative === null) return tileBytes("manifest.json");
      if (relative === "9/532/125.hgt") throw new Error("ENOENT");
      return tileBytes(relative);
    },
  });

  const [degraded, healthy] = await Promise.all([
    provider.requestTileGeometry(532, 125, 9),
    provider.requestTileGeometry(532, 124, 9),
  ]);
  assert.deepEqual(seen, ["data-unavailable"], "the diagnostic was delivered before the observer threw");
  assertLegalHeights(degraded, "throwing observer");
  assert.ok(new Set(healthy).size > 1, "an observer that throws MUST NOT stop the healthy tiles from loading");
});

test("no timeout is armed when tileTimeoutMs disables the bound (0), and it never leaks a pending timer", async () => {
  const diagnostics = [];
  const provider = await source.createTerrainProvider({
    mode: "fixture",
    datasetId: DATASET_ID,
    tileTimeoutMs: 0,
    onTileDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    readTile: (tilePath) => {
      const relative = toFixtureRelative(tilePath);
      return relative === null ? tileBytes("manifest.json") : tileBytes(relative);
    },
  });
  const heights = await provider.requestTileGeometry(HEALTHY.x, HEALTHY.y, HEALTHY.level);
  assert.equal(diagnostics.length, 0, "a healthy read MUST NOT produce a diagnostic");
  assert.ok(new Set(heights).size > 1);
});
