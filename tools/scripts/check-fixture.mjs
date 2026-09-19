#!/usr/bin/env node
/**
 * `tools/scripts/check-fixture.mjs` — fixed-dataset integrity checker (tasks.md **T085**, FR-015,
 * FR-024; contract `terrain-source.md` §2 "TS-3").
 *
 *   node tools/scripts/check-fixture.mjs [--dataset=matterhorn-z0-12]
 *                                        [--fixtures-root=<dir>] [--out=<file>] [--quiet]
 *
 * Every clause of contract §2 is asserted explicitly and printed, one line per check, so a
 * reviewer can read the evidence without opening the dataset. Exit **0 only when every hard
 * check passes**:
 *
 *   1. `totalBytes <= 20 MiB` (hard) — and the value is reported; the 3–6 MB band is reported as
 *      `PASS`/`TARGET-MISS` but is **not** a hard failure (only the 20 MiB bound is);
 *   2. `levels` covers z0–z12 contiguously;
 *   3. the maximum level has at least a 2×2 block of covering tiles (multi-tile stitching, FR-015);
 *   4. the coverage rectangle is ≈ 0.6° × 0.5° (width 0.55–0.65°, height 0.45–0.55°) and contains
 *      Mont Blanc (6.8652 E / 45.8326 N);
 *   5. the elevation span measured **from the tile bytes on disk** is > 4000 m;
 *   6. every tile file's `sha256` matches its manifest entry, the recorded `totalBytes` is the sum
 *      of the tile lengths, and the manifest's own content `sha256` recomputes to the recorded
 *      value. The content hash is *re-implemented here* from the definition recorded in the
 *      manifest (`sha256` over the sorted `"<level>/<x>/<y>.hgt <sha256>\n"` lines) rather than
 *      imported from the generator, so a bug in the generator cannot mask a broken dataset;
 *   7. `attribution` is non-empty and `sources[]` is non-empty with a `license` and a `url` per
 *      source (FR-024);
 *   8. `tilingScheme === "geographic"`, and `encoding` / `noDataValue` / `sampleWidth` /
 *      `sampleHeight` are present;
 *   9. `rectangle` is present with numeric `west`/`south`/`east`/`north` in degrees.
 *
 * Offline by construction: the checker only reads files under the dataset directory, so CI can
 * run it with no network access (the download lives exclusively in `tools/build-terrain-fixture.mjs`).
 *
 * Exit codes: 0 all hard checks pass, 1 at least one hard check failed, 2 bad invocation or a
 * missing dataset directory. Cross-platform: Node only, no shell, no absolute machine paths.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (this tool lives in `tools/scripts/`). */
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Where the committed datasets live (contract `terrain-source.md` §2). */
export const FIXTURES_ROOT = path.join(REPO_ROOT, "packages", "cesium-webgpu", "fixtures");

export const DEFAULT_DATASET_ID = "matterhorn-z0-12";

/** The reserved "no data" sentinel of the `.hgt` payload. */
export const NO_DATA_VALUE = 65535;

/** The elevation offset of the `.hgt` payload. */
export const HEIGHT_OFFSET = 32768;

const MEBIBYTE = 1024 * 1024;
const HARD_BOUND_BYTES = 20 * MEBIBYTE;
const TARGET_BAND_BYTES = { min: 3 * 1000 * 1000, max: 6 * 1000 * 1000 };

/** Mont Blanc — the rectangle MUST contain it (contract §2: "以勃朗峰/大孔班山为中心"). */
export const MONT_BLANC = { longitude: 6.8652, latitude: 45.8326 };

/** Level 0 has 2 tiles in x and 1 in y, so a level-z tile spans 180 / 2^z degrees on both axes. */
export function tileRectangle(level, x, y) {
  const span = 180 / 2 ** level;
  return { west: x * span - 180, east: (x + 1) * span - 180, south: 90 - (y + 1) * span, north: 90 - y * span };
}

/** The dataset content hash exactly as the manifest defines it. */
export function computeContentHash(tiles) {
  const ordered = [...tiles].sort((a, b) => a.level - b.level || a.x - b.x || a.y - b.y);
  const text = ordered.map((tile) => `${tile.level}/${tile.x}/${tile.y}.hgt ${tile.sha256}\n`).join("");
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** Decode a headerless little-endian `Uint16` payload. */
export function decodeHeightGrid(buffer) {
  if (buffer.length % 2 !== 0) throw new Error(`byte length ${buffer.length} is not a multiple of 2`);
  const samples = new Uint16Array(buffer.length / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = buffer.readUInt16LE(index * 2);
  return samples;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Run every check against one dataset.
 *
 * @param {{fixturesRoot?: string, datasetId?: string}} options
 * @returns {{datasetId: string, checks: {id: string, ok: boolean, hard: boolean, detail: string}[], metrics: object, verdict: string}}
 */
export function checkFixture({ fixturesRoot = FIXTURES_ROOT, datasetId = DEFAULT_DATASET_ID } = {}) {
  const checks = [];
  const add = (id, ok, detail, hard = true) => checks.push({ id, ok, hard, detail });
  const metrics = {};

  const datasetDir = path.join(fixturesRoot, datasetId);
  const manifestPath = path.join(datasetDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    add("manifest.present", false, `missing ${path.relative(REPO_ROOT, manifestPath).split(path.sep).join("/")}`);
    return { datasetId, checks, metrics, verdict: "fail" };
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
    add("manifest.readable", true, `parsed ${path.relative(REPO_ROOT, manifestPath).split(path.sep).join("/")}`);
  } catch (error) {
    add("manifest.readable", false, `manifest.json is not valid JSON: ${error.message}`);
    return { datasetId, checks, metrics, verdict: "fail" };
  }
  add("manifest.datasetId", manifest.datasetId === datasetId, `datasetId=${JSON.stringify(manifest.datasetId)} (requested "${datasetId}")`);

  // (8) encoding / tiling scheme / sample grid
  add("manifest.tilingScheme", manifest.tilingScheme === "geographic", `tilingScheme=${JSON.stringify(manifest.tilingScheme)} MUST be "geographic"`);
  add(
    "manifest.encoding",
    typeof manifest.encoding === "string" && manifest.encoding.length > 0,
    `encoding=${JSON.stringify(manifest.encoding)}`,
  );
  add(
    "manifest.noDataValue",
    Number.isInteger(manifest.noDataValue) && manifest.noDataValue === NO_DATA_VALUE,
    `noDataValue=${JSON.stringify(manifest.noDataValue)} (MUST be ${NO_DATA_VALUE})`,
  );
  const gridOk =
    Number.isInteger(manifest.sampleWidth) && manifest.sampleWidth > 0 && Number.isInteger(manifest.sampleHeight) && manifest.sampleHeight > 0;
  add(
    "manifest.sampleGrid",
    gridOk,
    `sampleWidth=${JSON.stringify(manifest.sampleWidth)} sampleHeight=${JSON.stringify(manifest.sampleHeight)}`,
  );
  metrics.sampleWidth = manifest.sampleWidth;
  metrics.sampleHeight = manifest.sampleHeight;

  // (9) rectangle in degrees
  const rectangle = manifest.rectangle;
  const rectangleShapeOk =
    rectangle !== undefined &&
    ["west", "south", "east", "north"].every((key) => typeof rectangle[key] === "number" && Number.isFinite(rectangle[key]));
  add(
    "manifest.rectangle",
    rectangleShapeOk && (rectangle.units === undefined || rectangle.units === "degrees"),
    rectangleShapeOk
      ? `west=${rectangle.west} south=${rectangle.south} east=${rectangle.east} north=${rectangle.north} units=${rectangle.units ?? "degrees (implied)"}`
      : `rectangle MUST carry numeric west/south/east/north, got ${JSON.stringify(rectangle)}`,
  );
  const rectangleInRange =
    rectangleShapeOk && rectangle.west < rectangle.east && rectangle.south < rectangle.north &&
    rectangle.west >= -180 && rectangle.east <= 180 && rectangle.south >= -90 && rectangle.north <= 90;
  add("manifest.rectangleRange", rectangleInRange, rectangleShapeOk ? `west<east and south<north within ±180/±90: ${rectangle.west}<${rectangle.east}, ${rectangle.south}<${rectangle.north}` : "rectangle is malformed");

  // (4) coverage rectangle: size and Mont Blanc
  if (rectangleShapeOk) {
    const width = rectangle.east - rectangle.west;
    const height = rectangle.north - rectangle.south;
    metrics.rectangleWidth = width;
    metrics.rectangleHeight = height;
    const sizeOk = width >= 0.55 && width <= 0.65 && height >= 0.45 && height <= 0.55;
    add("coverage.size", sizeOk, `width=${width.toFixed(4)}° (need 0.55–0.65) height=${height.toFixed(4)}° (need 0.45–0.55)`);
    const contains =
      rectangle.west <= MONT_BLANC.longitude &&
      rectangle.east >= MONT_BLANC.longitude &&
      rectangle.south <= MONT_BLANC.latitude &&
      rectangle.north >= MONT_BLANC.latitude;
    add(
      "coverage.containsMontBlanc",
      contains,
      `Mont Blanc ${MONT_BLANC.longitude}E/${MONT_BLANC.latitude}N inside [${rectangle.west},${rectangle.east}]x[${rectangle.south},${rectangle.north}]: ${contains}`,
    );
  } else {
    add("coverage.size", false, "rectangle is malformed");
    add("coverage.containsMontBlanc", false, "rectangle is malformed");
  }

  // (2) levels cover z0–z12 contiguously
  const levels = Array.isArray(manifest.levels) ? manifest.levels : null;
  const sortedLevels = levels === null ? [] : [...levels].sort((a, b) => a - b);
  metrics.levels = sortedLevels;
  const levelsOk =
    levels !== null &&
    levels.length > 0 &&
    sortedLevels.every((level, index) => Number.isInteger(level) && (index === 0 || level === sortedLevels[index - 1] + 1)) &&
    sortedLevels[0] === 0 &&
    sortedLevels[sortedLevels.length - 1] === 12;
  add("levels.contiguousZ0ToZ12", levelsOk, `levels=${JSON.stringify(sortedLevels)} (contiguous 0..12 required)`);

  // (3) the maximum level must stitch at least 2x2 tiles inside the coverage rectangle
  const tiles = Array.isArray(manifest.tiles) ? manifest.tiles : [];
  const maxLevel = sortedLevels.length > 0 ? sortedLevels[sortedLevels.length - 1] : null;
  const maxLevelTiles = tiles.filter((tile) => tile.level === maxLevel);
  const distinctX = new Set(maxLevelTiles.map((tile) => tile.x)).size;
  const distinctY = new Set(maxLevelTiles.map((tile) => tile.y)).size;
  const allInsideRectangle =
    rectangleShapeOk &&
    maxLevelTiles.every((tile) => {
      const bounds = tileRectangle(tile.level, tile.x, tile.y);
      return bounds.east > rectangle.west && bounds.west < rectangle.east && bounds.north > rectangle.south && bounds.south < rectangle.north;
    });
  metrics.maxLevel = maxLevel;
  metrics.maxLevelTiles = maxLevelTiles.length;
  metrics.maxLevelDistinctX = distinctX;
  metrics.maxLevelDistinctY = distinctY;
  add(
    "tiles.maxLevelMultiTile",
    maxLevelTiles.length >= 4 && distinctX >= 2 && distinctY >= 2 && allInsideRectangle,
    `level ${maxLevel}: ${maxLevelTiles.length} covering tile(s), ${distinctX} distinct x, ${distinctY} distinct y, all overlapping the coverage rectangle: ${allInsideRectangle}`,
  );

  // (1) bytes: hard bound and the reported target band
  const declaredTotalBytes = manifest.totalBytes;
  metrics.declaredTotalBytes = declaredTotalBytes;
  add(
    "bytes.hardBound",
    Number.isInteger(declaredTotalBytes) && declaredTotalBytes <= HARD_BOUND_BYTES,
    `totalBytes=${declaredTotalBytes} B (${(declaredTotalBytes / MEBIBYTE).toFixed(3)} MiB) MUST be <= ${HARD_BOUND_BYTES} B (20 MiB)`,
  );
  const withinTarget = Number.isInteger(declaredTotalBytes) && declaredTotalBytes >= TARGET_BAND_BYTES.min && declaredTotalBytes <= TARGET_BAND_BYTES.max;
  add(
    "bytes.targetBand",
    withinTarget,
    `totalBytes=${declaredTotalBytes} B within the 3–6 MB target band [${TARGET_BAND_BYTES.min}, ${TARGET_BAND_BYTES.max}]: ${withinTarget ? "PASS" : "TARGET-MISS (informational, not a hard failure)"}`,
    false,
  );

  // (6) per-tile integrity, coverage of the manifest, and the manifest's own content hash
  const datasetPrefix = path.relative(REPO_ROOT, path.join(fixturesRoot, datasetId)).split(path.sep).join("/");
  let missing = 0;
  let sizeMismatch = 0;
  let hashMismatch = 0;
  let measuredBytes = 0;
  let firstFailure = null;
  const elevation = { min: null, max: null, noDataSamples: 0, samples: 0 };
  const perLevelElevation = new Map();
  const manifestTilePaths = new Set();
  for (const tile of tiles) {
    const relative = `${tile.level}/${tile.x}/${tile.y}.hgt`;
    manifestTilePaths.add(relative);
    const file = path.join(fixturesRoot, datasetId, ...relative.split("/"));
    if (!fs.existsSync(file)) {
      missing += 1;
      firstFailure ??= `${relative} is missing`;
      continue;
    }
    const bytes = fs.readFileSync(file);
    measuredBytes += bytes.length;
    if (bytes.length !== tile.bytes) {
      sizeMismatch += 1;
      firstFailure ??= `${relative} has ${bytes.length} B, manifest says ${tile.bytes} B`;
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== tile.sha256) {
      hashMismatch += 1;
      firstFailure ??= `${relative} sha256 ${digest} != manifest ${tile.sha256}`;
    }
    // (5) elevation from the bytes on disk, not from the manifest's own numbers
    const samples = decodeHeightGrid(bytes);
    const levelStats = perLevelElevation.get(tile.level) ?? { min: null, max: null };
    for (const sample of samples) {
      if (sample === NO_DATA_VALUE) {
        elevation.noDataSamples += 1;
        continue;
      }
      const metres = sample - HEIGHT_OFFSET;
      if (elevation.min === null || metres < elevation.min) elevation.min = metres;
      if (elevation.max === null || metres > elevation.max) elevation.max = metres;
      if (levelStats.min === null || metres < levelStats.min) levelStats.min = metres;
      if (levelStats.max === null || metres > levelStats.max) levelStats.max = metres;
    }
    elevation.samples += samples.length;
    perLevelElevation.set(tile.level, levelStats);
  }
  metrics.tiles = tiles.length;
  metrics.measuredBytes = measuredBytes;
  add(
    "tiles.integrity",
    tiles.length > 0 && missing === 0 && sizeMismatch === 0 && hashMismatch === 0,
    `${tiles.length} tile(s): ${missing} missing, ${sizeMismatch} size mismatch, ${hashMismatch} sha256 mismatch${firstFailure === null ? "" : ` (first: ${firstFailure})`}`,
  );

  const onDisk = [];
  const walk = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith(".hgt")) onDisk.push(path.relative(path.join(fixturesRoot, datasetId), child).split(path.sep).join("/"));
    }
  };
  walk(path.join(fixturesRoot, datasetId));
  const orphans = onDisk.filter((file) => !manifestTilePaths.has(file));
  add(
    "tiles.noOrphans",
    orphans.length === 0 && onDisk.length === tiles.length,
    `${onDisk.length} .hgt file(s) on disk, ${tiles.length} listed in the manifest, ${orphans.length} orphan(s)${orphans.length === 0 ? "" : `: ${orphans.slice(0, 3).join(", ")}`}`,
  );

  add(
    "bytes.sumMatchesManifest",
    measuredBytes === declaredTotalBytes,
    `sum of tile bytes=${measuredBytes} B, manifest totalBytes=${declaredTotalBytes} B`,
  );

  const recomputedContentHash = computeContentHash(tiles);
  metrics.contentHash = recomputedContentHash;
  add(
    "manifest.contentHash",
    recomputedContentHash === manifest.contentHash?.value && recomputedContentHash === manifest.sha256,
    `recomputed ${recomputedContentHash} === contentHash.value ${manifest.contentHash?.value} === sha256 ${manifest.sha256}`,
  );
  add(
    "manifest.contentHashDefinition",
    typeof manifest.contentHash?.definition === "string" && /<level>\/<x>\/<y>\.hgt/.test(manifest.contentHash.definition) && /sha256/.test(manifest.contentHash.definition),
    `definition=${JSON.stringify(manifest.contentHash?.definition)}`,
  );

  // (5) elevation span
  const span = elevation.min === null ? 0 : elevation.max - elevation.min;
  metrics.elevation = { ...elevation, span };
  add(
    "elevation.span",
    elevation.min !== null && span > 4000,
    `measured from tile data: min=${elevation.min} m max=${elevation.max} m span=${span} m MUST be > 4000 m (no-data samples: ${elevation.noDataSamples}/${elevation.samples})`,
  );
  const maxLevelStats = maxLevel === null ? null : perLevelElevation.get(maxLevel);
  add(
    "elevation.maxLevelSpan",
    maxLevelStats !== undefined && maxLevelStats !== null && maxLevelStats.min !== null && maxLevelStats.max - maxLevelStats.min > 0,
    `level ${maxLevel} within the rectangle: min=${maxLevelStats?.min ?? "n/a"} m max=${maxLevelStats?.max ?? "n/a"} m span=${maxLevelStats === null || maxLevelStats.min === null ? "n/a" : maxLevelStats.max - maxLevelStats.min} m (informational)`,
    false,
  );

  // (7) attribution and per-source licence/URL
  const attribution = typeof manifest.attribution === "string" ? manifest.attribution.trim() : "";
  add("attribution.nonEmpty", attribution.length > 0, `${attribution.length} character(s): ${JSON.stringify(attribution.slice(0, 120))}${attribution.length > 120 ? "…" : ""}`);
  const sources = Array.isArray(manifest.sources) ? manifest.sources : [];
  const badSources = sources.filter((source) => typeof source?.license !== "string" || source.license.trim() === "" || typeof source?.url !== "string" || source.url.trim() === "");
  add(
    "sources.perSourceLicenceAndUrl",
    sources.length > 0 && badSources.length === 0,
    `${sources.length} source(s), ${badSources.length} without a licence and/or url${badSources.length === 0 ? "" : `: ${badSources.map((source) => source?.name ?? "?").slice(0, 3).join(", ")}`}`,
  );

  metrics.datasetPath = datasetPrefix;
  const verdict = checks.some((check) => check.hard && !check.ok) ? "fail" : "pass";
  return { datasetId, checks, metrics, verdict };
}

/** Print one line per check; the target-band line is reported but never fails the run. */
export function formatCheck(check) {
  if (check.hard) return `[${check.ok ? "PASS" : "FAIL"}] ${check.id}: ${check.detail}`;
  return `[${check.ok ? "PASS" : "TARGET-MISS"}] ${check.id}: ${check.detail}`;
}

export function parseArgv(argv) {
  const options = { datasetId: DEFAULT_DATASET_ID, fixturesRoot: FIXTURES_ROOT, out: path.join(REPO_ROOT, "artifacts", "fixture-check.json"), quiet: false };
  const valueFlags = new Set(["--dataset", "--fixtures-root", "--out"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf("=");
    const key = equals >= 0 ? argument.slice(0, equals) : argument;
    let value = equals >= 0 ? argument.slice(equals + 1) : undefined;
    if (key === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (!valueFlags.has(key)) throw new Error(`unknown argument "${argument}"`);
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined) throw new Error(`missing value for "${key}"`);
      index += 1;
    }
    if (key === "--dataset") options.datasetId = value;
    else if (key === "--fixtures-root") options.fixturesRoot = path.resolve(value);
    else options.out = path.resolve(value);
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    console.error(`check-fixture: ${error.message}`);
    console.error("usage: node tools/scripts/check-fixture.mjs [--dataset=<id>] [--fixtures-root=<dir>] [--out=<file>] [--quiet]");
    return 2;
  }

  const datasetDir = path.join(options.fixturesRoot, options.datasetId);
  if (!fs.existsSync(datasetDir)) {
    console.error(`check-fixture: dataset directory not found: ${path.relative(REPO_ROOT, datasetDir).split(path.sep).join("/")}`);
    return 2;
  }

  const report = checkFixture({ fixturesRoot: options.fixturesRoot, datasetId: options.datasetId });
  const lines = report.checks.map(formatCheck);
  if (!options.quiet) for (const line of lines) console.log(line);

  const failed = report.checks.filter((check) => check.hard && !check.ok);
  const targetMisses = report.checks.filter((check) => !check.hard && !check.ok);
  const payload = {
    tool: "check-fixture",
    dataset: report.datasetId,
    datasetPath: report.metrics.datasetPath,
    generatedAt: new Date().toISOString(),
    metrics: report.metrics,
    checks: report.checks,
    failedHardChecks: failed.map((check) => check.id),
    informationalMisses: targetMisses.map((check) => check.id),
    verdict: report.verdict,
  };
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(
    `check-fixture: ${report.verdict} (${report.checks.filter((check) => check.ok).length}/${report.checks.length} check(s) passing, ${failed.length} hard failure(s), ${targetMisses.length} informational miss(es)) -> ${path.relative(REPO_ROOT, options.out).split(path.sep).join("/")}`,
  );
  return failed.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
