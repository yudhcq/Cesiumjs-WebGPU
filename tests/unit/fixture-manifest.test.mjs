/**
 * T085 — the committed fixed dataset and its integrity checker (`tools/scripts/check-fixture.mjs`).
 *
 * The committed dataset is the offline substrate of the whole US1 acceptance path (FR-004/FR-015/
 * FR-024), so this suite asserts the contract clauses twice: once through the checker's public
 * `checkFixture()` API and once by recomputing the facts from the bytes on disk here. The negative
 * controls are the important half — a check that cannot fail proves nothing — and they run on
 * **temporary copies** (`os.tmpdir()`), never on the committed fixture.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, readJson, repoPath } from "../support/repo.mjs";
import { checkFixture, computeContentHash, decodeHeightGrid } from "../../tools/scripts/check-fixture.mjs";
import { computeDatasetContentHash, decodeHeightGrid as decodeFixtureGrid } from "../../tools/build-terrain-fixture.mjs";

const DATASET_ID = "matterhorn-z0-12";
const DATASET_DIR = `packages/cesium-webgpu/fixtures/${DATASET_ID}`;
const CHECKER = repoPath("tools/scripts/check-fixture.mjs");
const NO_DATA_VALUE = 65535;
const HEIGHT_OFFSET = 32768;
const MEBIBYTE = 1024 * 1024;

function fixturePath(relative) {
  return path.join(REPO_ROOT, ...`${DATASET_DIR}/${relative}`.split("/"));
}

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Copy the committed dataset (the only writable way to build a negative control). */
function copyDataset(t) {
  const root = temporaryDirectory(t, "fixture-copy-");
  fs.cpSync(fixturePath(""), path.join(root, DATASET_ID), { recursive: true });
  return root;
}

function runChecker(args) {
  const result = spawnSync(process.execPath, [CHECKER, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("the committed dataset satisfies every contract clause (checker API)", () => {
  const report = checkFixture({ datasetId: DATASET_ID });
  const failures = report.checks.filter((check) => check.hard && !check.ok);
  assert.equal(report.verdict, "pass", `failing checks: ${failures.map((check) => `${check.id} (${check.detail})`).join("; ")}`);
  assert.ok(report.checks.length >= 20, `expected the full check list, got ${report.checks.length}`);

  const metrics = report.metrics;
  assert.ok(metrics.declaredTotalBytes <= 20 * MEBIBYTE, "contract §2: totalBytes MUST be <= 20 MiB");
  assert.ok(metrics.declaredTotalBytes >= 3_000_000 && metrics.declaredTotalBytes <= 6_000_000, "the 3–6 MB target band of contract §2");
  assert.deepEqual(metrics.levels, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "levels MUST cover z0–z12 contiguously");
  assert.equal(metrics.maxLevel, 12);
  assert.ok(metrics.maxLevelTiles >= 4 && metrics.maxLevelDistinctX >= 2 && metrics.maxLevelDistinctY >= 2, "FR-015: the maximum level MUST stitch at least 2x2 tiles");
  assert.equal(metrics.elevation.span > 4000, true, `elevation span ${metrics.elevation.span} m MUST exceed 4000 m`);
  assert.equal(metrics.elevation.noDataSamples, 0, "this dataset has no no-data samples (the source is truecolour)");
});

test("the manifest carries the documented shape (TS-3)", () => {
  const manifest = readJson(`${DATASET_DIR}/manifest.json`);
  assert.equal(manifest.datasetId, DATASET_ID);
  assert.equal(manifest.tilingScheme, "geographic");
  assert.equal(manifest.encoding, "le-uint16-metres-offset-32768");
  assert.equal(manifest.noDataValue, NO_DATA_VALUE);
  assert.equal(manifest.byteOrder, "little-endian");
  assert.equal(manifest.sampleType, "uint16");
  assert.equal(manifest.sampleWidth, 97, "the 97x97 grid is what keeps totalBytes inside the 3–6 MB band");
  assert.equal(manifest.sampleHeight, 97);
  assert.deepEqual(manifest.rectangle, { west: 6.7, south: 45.65, east: 7.3, north: 46.15, units: "degrees" });
  assert.ok(Math.abs(manifest.rectangle.east - manifest.rectangle.west - 0.6) < 1e-9, "the rectangle MUST be 0.6 degrees wide");
  assert.ok(Math.abs(manifest.rectangle.north - manifest.rectangle.south - 0.5) < 1e-9, "and 0.5 degrees tall");

  assert.equal(typeof manifest.attribution, "string");
  assert.ok(manifest.attribution.trim().length > 0, "FR-024: attribution MUST be non-empty");
  assert.ok(Array.isArray(manifest.sources) && manifest.sources.length > 0, "FR-024: sources[] MUST be non-empty");
  for (const source of manifest.sources) {
    assert.ok(typeof source.license === "string" && source.license.trim().length > 0, `source "${source.name}" MUST carry a license`);
    assert.ok(typeof source.url === "string" && /^https?:\/\//.test(source.url), `source "${source.name}" MUST carry a url`);
  }

  assert.equal(typeof manifest.contentHash?.definition, "string");
  assert.match(manifest.contentHash.definition, /<level>\/<x>\/<y>\.hgt <sha256-hex>/);
  assert.equal(manifest.sha256, manifest.contentHash.value, "contract §2: manifest.sha256 IS the dataset content hash");

  assert.equal(manifest.tileCount, manifest.tiles.length);
  assert.equal(manifest.totalBytes, manifest.tiles.reduce((total, tile) => total + tile.bytes, 0));
  assert.equal(manifest.elevation.span, manifest.elevation.maxHeight - manifest.elevation.minHeight);

  // The source raster is XYZ/Web-Mercator while the fixture is geographic: that mismatch is the
  // single most surprising fact about this dataset, so it MUST be recorded rather than implied.
  assert.equal(manifest.source.scheme, "xyz-web-mercator");
  assert.deepEqual(manifest.source.observedColorTypes, [2], "the AWS tiles are 8-bit truecolour (colour type 2)");
  assert.equal(manifest.source.tileSize, 256);
  assert.match(manifest.source.decode, /R \* 256 \+ G \+ B \/ 256 - 32768/);
  assert.ok(manifest.source.sourceTileCount > 0);
  assert.match(manifest.sampleGrid.filter, /bilinear/);
  assert.ok(manifest.sampleGrid.noDataRule.includes("alpha"));
});

test("every tile matches its recorded sha256 and both content-hash implementations agree", () => {
  const manifest = readJson(`${DATASET_DIR}/manifest.json`);
  let measuredBytes = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const tile of manifest.tiles) {
    const bytes = fs.readFileSync(fixturePath(tile.path));
    measuredBytes += bytes.length;
    assert.equal(bytes.length, tile.bytes, `${tile.path} byte length`);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), tile.sha256, `${tile.path} sha256`);
    for (const sample of decodeHeightGrid(bytes)) {
      if (sample === NO_DATA_VALUE) continue;
      const metres = sample - HEIGHT_OFFSET;
      if (metres < minimum) minimum = metres;
      if (metres > maximum) maximum = metres;
    }
  }
  assert.equal(measuredBytes, manifest.totalBytes);
  assert.equal(maximum - minimum, manifest.elevation.span, "the manifest's span MUST be what the bytes say");

  const independent = crypto
    .createHash("sha256")
    .update(
      Buffer.from(
        [...manifest.tiles]
          .sort((a, b) => a.level - b.level || a.x - b.x || a.y - b.y)
          .map((tile) => `${tile.level}/${tile.x}/${tile.y}.hgt ${tile.sha256}\n`)
          .join(""),
        "utf8",
      ),
    )
    .digest("hex");
  assert.equal(independent, manifest.contentHash.value, "the checker's recomputation MUST reproduce the recorded content hash");
  assert.equal(computeContentHash(manifest.tiles), independent, "checksum rule implemented identically by the checker and here");
  assert.equal(computeDatasetContentHash(manifest.tiles), independent, "checksum rule implemented identically by the generator and here");

  // The generator writes little-endian Uint16 with the -32768 offset; read one tile back both ways.
  const sampleTile = manifest.tiles.find((tile) => tile.level === 12);
  assert.deepEqual(
    [...decodeFixtureGrid(fs.readFileSync(fixturePath(sampleTile.path)))],
    [...decodeHeightGrid(fs.readFileSync(fixturePath(sampleTile.path)))],
  );
});

test("the dataset carries real terrain: multi-tile stitching and a >4000 m span from the bytes", () => {
  const manifest = readJson(`${DATASET_DIR}/manifest.json`);
  const level12 = manifest.tiles.filter((tile) => tile.level === 12);
  assert.ok(level12.length >= 4, "the maximum level MUST have at least a 2x2 block");
  assert.ok(new Set(level12.map((tile) => tile.x)).size >= 2);
  assert.ok(new Set(level12.map((tile) => tile.y)).size >= 2);

  // Mont Blanc 6.8652 E / 45.8326 N: geographic tile 12/4252/1005, whose highest sample must be the
  // summit (4808 m in reality; the 97x97 grid of the 256 px source reads 4789 m).
  const span = 180 / 2 ** 12;
  const x = Math.floor((6.8652 + 180) / span);
  const y = Math.floor((90 - 45.8326) / span);
  const samples = decodeHeightGrid(fs.readFileSync(fixturePath(`12/${x}/${y}.hgt`)));
  let localMax = -Infinity;
  let localMin = Infinity;
  for (const sample of samples) {
    assert.notEqual(sample, NO_DATA_VALUE, `12/${x}/${y}.hgt` + " MUST be fully populated");
    localMax = Math.max(localMax, sample - HEIGHT_OFFSET);
    localMin = Math.min(localMin, sample - HEIGHT_OFFSET);
  }
  // That 256 px tile covers the massif itself (6.855–6.899 E, 45.792–45.836 N), so its floor is the
  // high glacial basin (~1670 m), not the Chamonix valley: a finite, plausible value either way.
  assert.ok(localMax >= 4700 && localMax <= 4900, `the tile holding Mont Blanc MUST peak near the summit, got ${localMax} m`);
  assert.ok(localMin >= 1200 && localMin <= 2500, `its lowest sample MUST stay a plausible alpine floor, got ${localMin} m`);
});

test("the checker CLI passes on the committed dataset and writes a report", (t) => {
  const out = path.join(temporaryDirectory(t, "fixture-report-"), "fixture-check.json");
  const { code, stdout } = runChecker([`--dataset=${DATASET_ID}`, `--out=${out}`]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /\[PASS\] bytes\.hardBound/);
  assert.match(stdout, /\[PASS\] elevation\.span/);
  assert.match(stdout, /check-fixture: pass/);
  const report = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(report.verdict, "pass");
  assert.deepEqual(report.failedHardChecks, []);
});

test("negative control: tampering one tile byte fails the sha256 check", (t) => {
  const root = copyDataset(t);
  const manifest = readJson(`${DATASET_DIR}/manifest.json`);
  const victim = manifest.tiles.find((tile) => tile.level === 12 && tile.path.endsWith(".hgt"));
  const target = path.join(root, DATASET_ID, ...victim.path.split("/"));

  const original = fs.readFileSync(target);
  const tampered = Buffer.from(original);
  tampered[Math.floor(tampered.length / 2)] ^= 0x01;
  assert.notDeepEqual(tampered, original, "the control MUST actually change the file");
  fs.writeFileSync(target, tampered);

  const tamperedDigest = crypto.createHash("sha256").update(tampered).digest("hex");
  assert.notEqual(tamperedDigest, victim.sha256, "one flipped byte MUST change the digest");

  const report = checkFixture({ fixturesRoot: root, datasetId: DATASET_ID });
  assert.equal(report.verdict, "fail");
  const integrity = report.checks.find((check) => check.id === "tiles.integrity");
  assert.equal(integrity.ok, false, "tiles.integrity MUST fail on a tampered tile");
  assert.match(integrity.detail, /1 sha256 mismatch/);
  assert.match(integrity.detail, new RegExp(victim.path.replace(/[.\\/]/g, "\\$&")));
  // The two layers are deliberately independent: the content hash covers the manifest's own
  // "<path> <sha256>" lines (so it stays valid here — the manifest was not edited), while
  // tiles.integrity is what binds the files on disk to those lines.
  assert.equal(report.checks.find((check) => check.id === "manifest.contentHash").ok, true, "the untouched manifest still hashes to its recorded value");
  assert.equal(report.checks.find((check) => check.id === "bytes.sumMatchesManifest").ok, true, "tampering keeps the byte length");

  const { code, stdout } = runChecker([`--dataset=${DATASET_ID}`, `--fixtures-root=${root}`, `--out=${path.join(root, "report.json")}`]);
  assert.equal(code, 1, "the CLI MUST exit non-zero on a tampered dataset");
  assert.match(stdout, /\[FAIL\] tiles\.integrity/);
  assert.match(stdout, /check-fixture: fail/);
});

test("negative control: a missing tile, a wrong totalBytes and a wrong content hash each fail", (t) => {
  const root = copyDataset(t);
  const manifestPath = path.join(root, DATASET_ID, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  // 1) delete one tile file
  const victim = manifest.tiles[0];
  fs.rmSync(path.join(root, DATASET_ID, ...victim.path.split("/")));
  let report = checkFixture({ fixturesRoot: root, datasetId: DATASET_ID });
  assert.equal(report.verdict, "fail");
  assert.equal(report.checks.find((check) => check.id === "tiles.integrity").ok, false, "a missing tile MUST fail tiles.integrity");

  // 2) shrink the recorded size so the 20 MiB bound / sum check fails
  const restored = readJson(`${DATASET_DIR}/manifest.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...restored, totalBytes: 40 * MEBIBYTE }, null, 2)}\n`, "utf8");
  report = checkFixture({ fixturesRoot: root, datasetId: DATASET_ID });
  assert.equal(report.verdict, "fail");
  assert.equal(report.checks.find((check) => check.id === "bytes.hardBound").ok, false, "40 MiB MUST breach the hard bound");
  assert.equal(report.checks.find((check) => check.id === "bytes.sumMatchesManifest").ok, false);

  // 3) corrupt the recorded content hash
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...restored, contentHash: { ...restored.contentHash, value: "0".repeat(64) }, sha256: "0".repeat(64) }, null, 2)}\n`,
    "utf8",
  );
  report = checkFixture({ fixturesRoot: root, datasetId: DATASET_ID });
  assert.equal(report.verdict, "fail");
  assert.equal(report.checks.find((check) => check.id === "manifest.contentHash").ok, false, "a wrong content hash MUST fail");

  // The committed dataset must be untouched by all of the above.
  const committed = readJson(`${DATASET_DIR}/manifest.json`);
  assert.equal(committed.sha256, restored.sha256, "the negative controls MUST NOT touch the committed fixture");
});
