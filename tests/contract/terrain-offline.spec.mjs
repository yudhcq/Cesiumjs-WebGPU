/**
 * `contract:terrain-offline` — T087 (FR-012): the terrain acceptance case runs with **zero external
 * requests** in `mode: "fixture"`, and still completes when every non-local request is forcibly refused.
 *
 * Run (one backend per run — principle II):
 *   node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain-offline
 *   node tests/support/backend-runner.mjs --backend=webgl2 --suite=contract:terrain-offline
 *
 * The page-side scenario (`tests/contract/page/scenarios/terrain-offline.js`) drives the **product**
 * terrain adapter over the committed dataset, so this run's requests are real ones: the fixture's
 * `manifest.json` and `.hgt` tiles are fetched over HTTP from this run's own static server. That is
 * what gives the "external requests === 0" assertion its discriminating power — the probe's default
 * analytic height field would make it true by construction.
 *
 * Two arms, one backend, two isolated runs:
 *   1. `requests` arm  — every request the page makes is inspected; none may reach a non-loopback host;
 *   2. `blockExternal` arm — the same case with the browser context refusing **every** non-loopback
 *      request (`run.blockedExternalRequests` is the refusal log). If the list is non-empty, something
 *      outside this machine was needed, and the arm says so instead of passing quietly.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "playwright/test";

import { ARTIFACT_ROOT, assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";

/** Repository root, derived from this file's own URL (the runner's cwd is not assumed). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Suite key in `SUITE_SCENARIOS`; the page-side scenario name is `terrain-offline`. */
const SUITE = "contract:terrain-offline";
const SCENARIO_RESULT_KEY = "terrain-offline";
const EVIDENCE_DIR = path.join(ARTIFACT_ROOT, "terrain-offline");

/** The committed dataset this contract is measured against (`packages/cesium-webgpu/fixtures`). */
const DATASET_ID = "matterhorn-z0-12";
const DATASET_MANIFEST = path.join("packages", "cesium-webgpu", "fixtures", DATASET_ID, "manifest.json");
const FIXTURE_PATH_PREFIX = `/packages/cesium-webgpu/fixtures/${DATASET_ID}/`;

/**
 * Hostnames that mean "this machine". The static server listens on 127.0.0.1, so that is what a local
 * request is expected to name; the aliases are accepted because they are the same interface, and the
 * evidence records the exact origin list rather than relying on that acceptance.
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]", ""]);

test.setTimeout(600_000);

/** Split the page's request log into the shapes this contract asserts on. */
function classifyRequests(requests) {
  const http = [];
  const otherSchemes = [];
  const unparseable = [];
  for (const entry of requests) {
    let url;
    try {
      url = new URL(entry.url);
    } catch {
      unparseable.push({ url: entry.url, resourceType: entry.resourceType });
      continue;
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      http.push({ url: url.href, protocol: url.protocol, hostname: url.hostname, origin: url.origin, pathname: url.pathname, resourceType: entry.resourceType });
    } else {
      // `blob:` / `data:` carry no network hop of their own; a `blob:` URL derived from an http origin
      // reports that origin, so it can still be checked for "derived from this machine".
      otherSchemes.push({ url: url.href, protocol: url.protocol, origin: url.origin === "null" ? null : url.origin, resourceType: entry.resourceType });
    }
  }
  const external = http.filter((entry) => !LOOPBACK_HOSTNAMES.has(entry.hostname));
  const origins = [...new Set(http.map((entry) => entry.origin))].sort();
  const hostnames = [...new Set(http.map((entry) => entry.hostname))].sort();
  const fixtureTiles = http.filter((entry) => entry.pathname.endsWith(".hgt"));
  const fixtureRequests = http.filter((entry) => entry.pathname.startsWith(FIXTURE_PATH_PREFIX));
  const foreignFixtureRequests = fixtureTiles.filter((entry) => !entry.pathname.startsWith(FIXTURE_PATH_PREFIX));
  const derivedFromExternal = otherSchemes.filter((entry) => {
    if (entry.origin === null) return entry.protocol !== "data:"; // `data:` is in-memory by definition
    try {
      return !LOOPBACK_HOSTNAMES.has(new URL(entry.origin).hostname);
    } catch {
      return true;
    }
  });
  return {
    total: requests.length,
    http,
    hostnames,
    origins,
    external,
    otherSchemes,
    derivedFromExternal,
    unparseable,
    fixtureTiles,
    fixtureRequests,
    foreignFixtureRequests,
    fixtureManifestRequests: http.filter((entry) => entry.pathname === `${FIXTURE_PATH_PREFIX}manifest.json`),
    byResourceType: requests.reduce((accumulator, entry) => {
      accumulator[entry.resourceType] = (accumulator[entry.resourceType] ?? 0) + 1;
      return accumulator;
    }, {}),
  };
}

/** The committed dataset's own facts, read from disk (Node side) so the evidence names what was served. */
function readDatasetFacts() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, DATASET_MANIFEST), "utf8"));
    return {
      manifest: DATASET_MANIFEST.split(path.sep).join("/"),
      datasetId: manifest.datasetId ?? null,
      encoding: manifest.encoding ?? null,
      sampleWidth: manifest.sampleWidth ?? null,
      sampleHeight: manifest.sampleHeight ?? null,
      levels: Array.isArray(manifest.levels) ? manifest.levels.length : null,
      tileCount: manifest.tileCount ?? (Array.isArray(manifest.tiles) ? manifest.tiles.length : null),
      totalBytes: manifest.totalBytes ?? null,
      hasAttribution: typeof manifest.attribution === "string" && manifest.attribution.length > 0,
      sources: Array.isArray(manifest.sources) ? manifest.sources.length : null,
      sha256: typeof manifest.sha256 === "string" ? manifest.sha256.slice(0, 16) : null,
    };
  } catch (error) {
    return { manifest: DATASET_MANIFEST.split(path.sep).join("/"), error: String(error?.message ?? error).slice(0, 200) };
  }
}

/**
 * Every assertion this contract makes about one arm.
 *
 * `label` names the arm in failure messages so a red run says which of the two failed.
 */
function assertOfflineArm(run, label) {
  assertCleanRun(run, assert);

  const result = run.report.result[SCENARIO_RESULT_KEY];
  assert.ok(result !== undefined && result !== null, `${label}: the scenario MUST publish its result (got ${JSON.stringify(result)})`);
  const classified = classifyRequests(run.requests);

  // (b) ZERO EXTERNAL REQUESTS — every hostname the page talked to is this machine. The evidence list is
  // printed by the caller; the assertion is on the *complete* request log, collected from the first
  // request of the page load on (the harness installs the listener before navigating).
  assert.deepEqual(classified.external, [], `${label}: external request(s) reached a non-loopback host: ${JSON.stringify(classified.external)}`);
  assert.deepEqual(
    classified.foreignFixtureRequests,
    [],
    `${label}: tile request(s) outside the committed dataset: ${JSON.stringify(classified.foreignFixtureRequests)}`,
  );
  assert.deepEqual(classified.derivedFromExternal, [], `${label}: request(s) derived from a non-loopback origin: ${JSON.stringify(classified.derivedFromExternal)}`);
  assert.deepEqual(classified.unparseable, [], `${label}: unparsable request URL(s): ${JSON.stringify(classified.unparseable)}`);
  assert.deepEqual(
    classified.hostnames.filter((hostname) => !LOOPBACK_HOSTNAMES.has(hostname)),
    [],
    `${label}: hostname(s) outside this machine: ${JSON.stringify(classified.hostnames)}`,
  );

  // NON-VACUITY. "Zero external requests" is worthless if the page made no requests at all, or if the
  // terrain data arrived some other way. This run must show real fixture traffic over the local server.
  assert.ok(classified.http.length >= 10, `${label}: only ${classified.http.length} HTTP request(s) were recorded; the assertion would be vacuous`);
  assert.ok(classified.fixtureManifestRequests.length > 0, `${label}: the dataset manifest was never fetched (${JSON.stringify(classified.fixtureRequests.map((entry) => entry.pathname))})`);
  assert.ok(classified.fixtureTiles.length > 0, `${label}: no fixture tile was fetched, so "offline terrain" was never exercised`);
  assert.deepEqual(
    run.badResponses.filter((response) => response.url.includes(FIXTURE_PATH_PREFIX)),
    [],
    `${label}: the local server refused a fixture request: ${JSON.stringify(run.badResponses)}`,
  );

  // (c) FORCED OFFLINE arm: the refusals the harness recorded. A non-empty list means the case needed
  // something outside this machine and only passed because the network was up — which is exactly the
  // failure mode this arm exists to catch, so it is an assertion rather than a note.
  assert.deepEqual(
    run.blockedExternalRequests,
    [],
    `${label}: the run depended on non-local request(s) that were refused: ${JSON.stringify(run.blockedExternalRequests)}`,
  );
  assert.deepEqual(run.requestFailures, [], `${label}: failed request(s): ${JSON.stringify(run.requestFailures)}`);

  // (d) THE TERRAIN REALLY RENDERED — from the committed dataset, through the product adapter.
  assert.equal(result.provider.adapterModule, "packages/cesium-webgpu/src/terrain/source.ts", `${label}: the scenario MUST use the product terrain adapter`);
  assert.equal(result.provider.mode, "fixture", `${label}: the acceptance case MUST run in fixture mode`);
  assert.equal(result.provider.constructorName, "CustomHeightmapTerrainProvider", `${label}: the adapter MUST return the upstream public provider class`);
  assert.equal(result.provider.isUpstreamHeightmapProvider, true, `${label}: the returned provider is not an instanceof the upstream public class`);
  assert.ok(result.requestedTiles > 0, `${label}: the globe requested ${result.requestedTiles} tiles; the terrain was never asked for data`);
  assert.equal(result.tilesLoaded, true, `${label}: the globe never reported its visible tiles as loaded (${JSON.stringify(result.load)})`);
  assert.deepEqual(result.frameErrors, [], `${label}: render frame error(s): ${JSON.stringify(result.frameErrors)}`);
  assert.equal(run.canvasScreenshot?.captured, true, `${label}: the canvas was not captured (${JSON.stringify(run.canvasScreenshot)})`);
  assert.ok(run.canvasScreenshot.nonBackground > 0, `${label}: the presented canvas holds no pixel (${JSON.stringify(run.canvasScreenshot)})`);

  // (e) One run, one backend: the other backend created zero GPU objects.
  assertOtherBackendUntouched(run, assert);

  return { result, classified };
}

/** Evidence for one arm: the summary plus the raw request log this conclusion was drawn from. */
function armEvidence(run, label, classified, result) {
  return {
    arm: label,
    backend: run.backend,
    scenario: run.scenario,
    runId: run.runId,
    url: run.url,
    browserVersion: run.browserVersion,
    pageError: run.error,
    conclusion: {
      externalRequests: classified.external.length,
      hostnames: classified.hostnames,
      origins: classified.origins,
      totalRequests: classified.total,
      requestsByResourceType: classified.byResourceType,
      fixtureManifestRequests: classified.fixtureManifestRequests.length,
      fixtureTileRequests: classified.fixtureTiles.length,
      blockedExternalRequests: run.blockedExternalRequests.length,
    },
    blockedExternalRequests: run.blockedExternalRequests,
    requestFailures: run.requestFailures,
    badResponses: run.badResponses,
    pageErrors: run.pageErrors,
    pageReportedErrors: run.report.errors,
    consoleErrors: run.consoleMessages.filter((message) => message.type === "error"),
    canvasScreenshot: run.canvasScreenshot ?? null,
    result,
    requests: run.requests,
  };
}

/**
 * Run one arm and write its evidence. Returns the arm's summary for the suite-level evidence file.
 */
async function runOfflineArm(blockExternal) {
  const label = blockExternal ? "forced-offline (all non-local requests refused)" : "requests (network reachable, measured)";
  const run = await runContractSuite(SUITE, { viewport: { width: 384, height: 288 }, timeoutMs: 420_000, blockExternal });
  const { result, classified } = assertOfflineArm(run, label);
  const evidence = armEvidence(run, label, classified, result);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `${run.backend}-${blockExternal ? "blocked" : "measured"}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(
    `${SUITE}[${run.backend}] ${label}: totalRequests=${classified.total} hostnames=${JSON.stringify(classified.hostnames)} ` +
      `origins=${JSON.stringify(classified.origins)} external=${classified.external.length} ` +
      `fixtureTileRequests=${classified.fixtureTiles.length} blockedExternalRequests=${run.blockedExternalRequests.length} ` +
      `requestedTiles=${result.requestedTiles} tilesLoaded=${result.tilesLoaded} ` +
      `canvasNonBackground=${run.canvasScreenshot?.nonBackground ?? null} uniqueColours=${run.canvasScreenshot?.uniqueColours ?? null} ` +
      `consoleErrors=${evidence.consoleErrors.length} requestFailures=${run.requestFailures.length} badResponses=${run.badResponses.length}`,
  );
  return { label, blockExternal, evidence, file: path.relative(REPO_ROOT, file).split(path.sep).join("/"), result, classified };
}

/**
 * Suite-level evidence: both arms side by side, plus the committed dataset's facts.
 *
 * The two arms are separate playwright tests, so each one merges its own arm into the file rather than
 * overwriting the other's (and a re-run of one arm cannot silently erase the other's record).
 */
function writeSuiteEvidence(arm) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `${arm.evidence.backend}-offline-contract.json`);
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    previous = null;
  }
  const armEntry = (source) => ({
    label: source.label,
    blockExternal: source.blockExternal,
    evidence: source.file,
    conclusion: source.evidence.conclusion,
    blockedExternalRequests: source.evidence.blockedExternalRequests,
    provider: source.result.provider,
    requestedTiles: source.result.requestedTiles,
    distinctRequestedTiles: source.result.distinctRequestedTiles,
    requestedTilesByLevel: source.result.requestedTilesByLevel,
    requestedTileSample: source.result.requestedTileSample,
    tilesLoaded: source.result.tilesLoaded,
    load: source.result.load,
    globeDiagnostics: source.result.globeDiagnostics,
    canvasScreenshot: source.evidence.canvasScreenshot,
  });
  const removed = arm.blockExternal ? "forced-offline (all non-local requests refused)" : "requests (network reachable, measured)";
  const keptArms = (previous?.arms ?? []).filter((entry) => entry.label !== removed && entry.label !== arm.label);
  const payload = {
    suite: SUITE,
    backend: arm.evidence.backend,
    dataset: readDatasetFacts(),
    arms: [...keptArms, armEntry(arm)],
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

test("zero external requests: the terrain acceptance case completes in fixture mode without leaving this machine", async () => {
  writeSuiteEvidence(await runOfflineArm(false));
});

test("forced offline: the same case completes with every non-local request refused by the browser context", async () => {
  writeSuiteEvidence(await runOfflineArm(true));
});
