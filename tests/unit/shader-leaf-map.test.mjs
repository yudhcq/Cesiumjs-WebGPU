/**
 * T070 / **SH-3** — the shader leaf map and the upgrade drift detector
 * (`tools/shader-leaf-map.mjs`, `packages/cesium-webgpu/backend-webgpu/webgpu/shader-leaf-map.json`;
 * tasks.md T070; contract fork-patch-layer §5 rules R3/R7; data-model §11 rule A11;
 * verification contract §4 SH-3).
 *
 * What this suite is really about: the map is the *only* thing that ties the WGSL this backend layer
 * ships to the upstream GLSL it was translated from (R3), and R7 says an upstream upgrade that changes
 * a leaf MUST fail CI with a "must be re-converted" list. So the cases below are written as falsifiable
 * drift experiments — a mutated hash, a hand-edited `.wgsl`, an upstream leaf whose text no longer
 * matches — rather than as shape assertions on a JSON file that could be green while the port is stale.
 *
 * The last case is the one the acceptance path depends on: `verifiedOnRealGpu !== true` leaves MUST NOT
 * enter it (SH-3/FR-011). It currently reports the honest state — the real-device reports on disk were
 * produced by the spike-side seam, not by `backend-webgpu/webgpu/wgsl-emitter.ts` — and asserts that the
 * map says so rather than claiming a device verdict it does not have.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import {
  acceptancePathLeaves,
  acceptancePathLeavesFromDisk,
  buildLeafMap,
  checkLeafMap,
  collectDeviceEvidence,
  DEFAULT_MAP_PATH,
  REPO_ROOT,
  readUpstreamLeafText,
  renderLeafMap,
  sha256,
} from "../../tools/shader-leaf-map.mjs";

const MAP_PATH = DEFAULT_MAP_PATH;
const MAP_DIR = path.dirname(MAP_PATH);
const API_BOUNDARIES = repoPath("tools/scripts/check-arch-boundaries.mjs");
/** The directory `wgslFile` is relative to, resolved from the repository root rather than the map. */
const WEBGPU_DIR = path.join(REPO_ROOT, "packages", "cesium-webgpu", "backend-webgpu", "webgpu");

const readMap = () => JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
const readEntries = () => {
  const map = readMap();
  return Array.isArray(map) ? map : (map.leaves ?? []);
};

function readRuleA11Source() {
  const text = fs.readFileSync(API_BOUNDARIES, "utf8");
  const start = text.indexOf("function ruleA11(");
  assert.ok(start > 0, "check-arch-boundaries.mjs MUST still expose `function ruleA11(`");
  const end = text.indexOf("\nconst RULES", start);
  return text.slice(start, end > 0 ? end : undefined);
}

test("the map on disk is in sync with `--check` (no drift)", async () => {
  const result = await checkLeafMap({ mapPath: MAP_PATH });
  assert.equal(
    result.ok,
    true,
    `shader-leaf-map.json drifted: ${result.drifted.map((drift) => `${drift.name}:${drift.reason}`).join(", ")}`,
  );
  assert.equal(result.drifted.length, 0);
  assert.ok(result.entries.length > 0, "the map MUST not be empty (an empty map would make SH-3 vacuous)");
});

test("hash drift makes the check fail and names exactly the drifted leaf", async () => {
  const original = readMap();
  const entries = Array.isArray(original) ? original : (original.leaves ?? []);
  assert.ok(entries.length >= 2, "the drift case needs at least two entries to prove it is specific");
  const target = entries.find((entry) => entry.name === "GlobeVS") ?? entries[1];

  const mutated = {
    ...original,
    leaves: entries.map((entry) => (entry === target ? { ...entry, upstreamLeafHash: sha256("this is not the upstream leaf text") } : entry)),
  };

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leaf-map-drift-"));
  const tempMap = path.join(tempRoot, "shader-leaf-map.json");
  fs.writeFileSync(tempMap, renderLeafMap(mutated), "utf8");

  const result = await checkLeafMap({ mapPath: tempMap });
  assert.equal(result.ok, false, "a mutated upstreamLeafHash MUST make the check fail (R7)");
  const drift = result.drifted.filter((entry) => entry.reason === "upstream-leaf-hash-drift");
  assert.equal(drift.length, 1, `exactly the mutated entry MUST drift, got ${JSON.stringify(result.drifted.map((entry) => `${entry.name}:${entry.reason}`))}`);
  assert.equal(drift[0].name, target.name);
  assert.equal(drift[0].wgslFile, target.wgslFile);
  // "must be re-converted" is the wording R7 asks for; it is printed by the CLI for every drifted row.
  const cli = fs.readFileSync(repoPath("tools/shader-leaf-map.mjs"), "utf8");
  assert.match(cli, /MUST BE RE-CONVERTED/, "the CLI MUST print the \"must be re-converted\" list R7 requires");
});

test("a hand edit of a .wgsl file is caught by wgslFileHash", async () => {
  const original = readMap();
  const entries = Array.isArray(original) ? original : (original.leaves ?? []);
  const target = entries[0];
  const mutated = {
    ...original,
    leaves: entries.map((entry) => (entry === target ? { ...entry, wgslFileHash: sha256("// hand-edited") } : entry)),
  };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leaf-map-wgsl-"));
  const tempMap = path.join(tempRoot, "shader-leaf-map.json");
  fs.writeFileSync(tempMap, renderLeafMap(mutated), "utf8");

  const result = await checkLeafMap({ mapPath: tempMap });
  assert.equal(result.ok, false);
  const drift = result.drifted.filter((entry) => entry.reason === "wgsl-file-hash-drift");
  assert.equal(drift.length, 1);
  assert.equal(drift[0].name, target.name);
});

test("a missing map file fails the check instead of passing silently", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leaf-map-missing-"));
  const result = await checkLeafMap({ mapPath: path.join(tempRoot, "shader-leaf-map.json") });
  assert.equal(result.ok, false);
  assert.ok(typeof result.missing === "string" && result.missing.length > 0, "a missing map MUST be reported, not skipped (SH-3)");
});

test("every wgslFile exists on disk, under the backend layer, and its recorded hash matches", () => {
  const entries = readEntries();
  for (const entry of entries) {
    assert.equal(typeof entry.wgslFile, "string", `entry ${entry.name} MUST carry a wgslFile`);
    const absolute = path.join(MAP_DIR, entry.wgslFile);
    assert.ok(fs.existsSync(absolute), `${entry.wgslFile} is mapped but missing on disk (rule A11)`);
    const relativeToPackage = path.relative(repoPath("packages/cesium-webgpu/backend-webgpu/webgpu"), absolute).split(path.sep).join("/");
    assert.ok(!relativeToPackage.startsWith(".."), `${entry.wgslFile} MUST live under backend-webgpu/webgpu/ (contract R3)`);
    const text = fs.readFileSync(absolute, "utf8");
    assert.equal(sha256(text), entry.wgslFileHash, `${entry.wgslFile} changed since the map was written — re-run \`node tools/shader-leaf-map.mjs --update\``);
  }
});

test("every upstreamLeafHash matches the sha256 of the installed upstream GLSL text", async () => {
  const entries = readEntries();
  const recomputed = await buildLeafMap();
  assert.equal(recomputed.leaves.length, entries.length, "the tool's declaration table and the map MUST cover the same number of leaves");
  for (const entry of entries) {
    const declaration = recomputed.leaves.find((candidate) => candidate.name === entry.name);
    assert.ok(declaration !== undefined, `entry ${entry.name} is in the map but not in the tool's declaration table`);
    assert.deepEqual(entry.upstreamLeaves, declaration.upstreamLeaves, `${entry.name}: the recorded upstream leaf list changed`);
    // The real drift detector: recompute the hash of the installed leaf text(s), then compare.
    assert.equal(entry.upstreamLeafHash, declaration.upstreamLeafHash, `${entry.name}: the upstream leaf text drifted — the WGSL port MUST be re-converted (R7)`);
  }
  // And one leaf is re-hashed straight from the tree, end to end, so the assertion above is not just
  // "the tool agrees with itself".
  const globeVs = entries.find((entry) => entry.name === "GlobeVS");
  assert.ok(globeVs !== undefined, "GlobeVS MUST be mapped (T069's four families)");
  const text = await readUpstreamLeafText(REPO_ROOT, globeVs.upstreamLeaves[0]);
  assert.equal(sha256(text), globeVs.upstreamLeafHash, "the installed GlobeVS GLSL text no longer matches the recorded hash (R7)");
  assert.ok(text.includes("#ifdef QUANTIZATION_BITS12"), "the upstream leaf text MUST be the GLSL, not the module's JavaScript wrapper");
});

test("the map satisfies rule A11's three conditions (asserted here directly, not only via the scanner)", () => {
  const source = readRuleA11Source();
  // The scanner is the authority; assert it still checks what this test checks.
  assert.match(source, /entry\?\.leafHash \?\? entry\?\.hash/, "rule A11 MUST read `leafHash` (or `hash`)");
  assert.match(source, /path\.join\(path\.dirname\(mapPath\), entry\.wgslFile\)/, "rule A11 MUST resolve `wgslFile` relative to the directory containing the map");
  assert.match(source, /entry\.verifiedOnRealGpu !== true/, "rule A11 MUST require `verifiedOnRealGpu === true`");

  const entries = readEntries();
  assert.ok(entries.length > 0, "rule A11: the leaf map MUST not be empty");
  for (const entry of entries) {
    const hash = entry.leafHash ?? entry.hash;
    assert.ok(typeof hash === "string" && hash.length > 0, `rule A11: entry ${entry.name} MUST carry a non-empty leaf text hash`);
    const absolute = path.join(path.dirname(MAP_PATH), entry.wgslFile);
    assert.ok(fs.existsSync(absolute), `rule A11: entry ${hash} points at missing WGSL file "${entry.wgslFile}"`);
    assert.equal(entry.verifiedOnRealGpu, true, `rule A11: entry ${hash} MUST set verifiedOnRealGpu === true for acceptance-path leaves (FR-011)`);
  }
});

test("leaves that are not verified on a real GPU MUST NOT enter the acceptance path", () => {
  const entries = readEntries();
  const acceptance = acceptancePathLeaves({ leaves: entries });
  const unverified = entries.filter((entry) => entry.verifiedOnRealGpu !== true);

  assert.equal(acceptance.rejected.length, unverified.length, "the predicate MUST list every unverified leaf, not just a count");
  for (const entry of unverified) {
    assert.ok(
      acceptance.rejected.some((rejected) => rejected.label.includes(entry.name)),
      `${entry.name} is unverified and MUST be reported as excluded from the acceptance path (SH-3)`,
    );
  }
  if (unverified.length > 0) {
    assert.equal(acceptance.ok, false, "an unverified leaf MUST make the acceptance-path predicate fail");
    assert.deepEqual(acceptance.accepted, [], "no leaf may be accepted while a mapped leaf is unverified");
  }
});

test("the recorded verifiedOnRealGpu value is backed by the evidence the tool can read", () => {
  const entries = readEntries();
  const map = readMap();
  const device = collectDeviceEvidence();
  assert.equal(typeof map.deviceEvidence, "object", "the map MUST record the evidence behind verifiedOnRealGpu");
  assert.deepEqual(
    map.deviceEvidence.reportsExamined.map((report) => report.path),
    device.reportsExamined.map((report) => report.path),
    "the recorded evidence MUST name the same reports the tool reads now",
  );

  const claimed = entries.filter((entry) => entry.verifiedOnRealGpu === true);
  if (claimed.length > 0) {
    assert.equal(device.verifiedOnRealGpu, true, `verifiedOnRealGpu === true is claimed for ${claimed.length} leaf/leaf(ves) but no passing report names the production emitter`);
    assert.match(map.deviceEvidence.verdictReason, /names the production emitter/);
    assert.ok(device.evidenceForProductionLibrary.length > 0, "the evidence section MUST name the passing production-emitter report");
  } else {
    assert.equal(device.verifiedOnRealGpu, false);
    assert.match(map.deviceEvidence.verdictReason, /NOT been verified on a real device/, "an all-false map MUST say why, in the file itself");
    // The honest state may still have examined reports (from any emitter) — that is what makes the
    // "not for this library" reason checkable rather than a bare claim.
    assert.ok(Array.isArray(device.reportsExamined) && device.reportsExamined.length > 0, "the evidence section MUST record the reports it examined");
  }
  for (const entry of entries) {
    assert.equal(typeof entry.verifiedOnRealGpu, "boolean", `entry ${entry.name} MUST carry an explicit boolean verifiedOnRealGpu`);
  }
});

test("acceptancePathLeavesFromDisk reads the same map the architecture scanner reads", () => {
  const acceptance = acceptancePathLeavesFromDisk();
  assert.equal(acceptance.accepted.length + acceptance.rejected.length, readEntries().length);
  assert.ok(fs.existsSync(repoPath("packages/cesium-webgpu/backend-webgpu/webgpu/shader-leaf-map.json")), "the scanner's fixed map path MUST exist (rule A11)");
});
