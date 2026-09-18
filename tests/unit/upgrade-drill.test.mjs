/**
 * T036 — upgrade drill, dry-run mode (`tools/upgrade-drill.mjs`).
 *
 * The record is a `UpgradeDrillRecord` (data-model §1.4) and its verdict encodes the contract's
 * three-element rule: "补丁范围审计 + 接口一致性 + 全量验证" — one missing element is a fail.
 * The counterexamples drive that rule directly: a tree whose patch scope is broken, a tree whose
 * interface baseline is missing, and a tree without a build artifact.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, readJson, repoPath } from "../support/repo.mjs";
import { DEFERRED_VERIFICATION, OFFLINE_BATTERY, VERIFICATION_KINDS, estimateEffort, runUpgradeDrill } from "../../tools/upgrade-drill.mjs";
import { makePatchFixture } from "../support/patch-fixture.mjs";

const DRILL = repoPath("tools/upgrade-drill.mjs");

function runDrill(args = []) {
  const result = spawnSync(process.execPath, [DRILL, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("the dry run passes on this repository and archives an UpgradeDrillRecord", () => {
  const { code, stdout } = runDrill(["--dry-run"]);
  assert.equal(code, 0, `${stdout}`);
  assert.match(stdout, /upgrade-drill: pass \(dry-run\)/);

  const record = readJson("artifacts/upgrade-drill.json");
  assert.equal(record.mode, "dry-run");
  assert.equal(record.verdict, "pass");
  assert.ok(!Number.isNaN(Date.parse(record.ranAt)), "ranAt MUST be a date-time");
  assert.equal(record.baselineVersion, "26.3.0");
  assert.equal(record.targetVersion, "2.6.3".replace("2.6.3", "26.3.0"), "a dry run targets the pinned baseline");

  // `diff: InterfaceManifestDiff` (data-model §1.4).
  for (const field of ["fromVersion", "toVersion", "changedRenderModules", "driftedKeptModules", "breakingConsumedMembers", "affectedReplacements", "estimatedEffort"]) {
    assert.ok(field in record.diff, `InterfaceManifestDiff MUST carry "${field}"`);
  }
  assert.deepEqual(record.diff.changedRenderModules, []);
  assert.deepEqual(record.diff.driftedKeptModules, []);
  assert.deepEqual(record.diff.breakingConsumedMembers, []);
  assert.equal(record.diff.estimatedEffort, "none");

  // `verification: VerificationRun[]` with the three required kinds all present and passing.
  for (const kind of VERIFICATION_KINDS) {
    assert.ok(record.verification.some((entry) => entry.kind === kind), `the record MUST contain a "${kind}" verification`);
  }
  for (const entry of record.verification) {
    assert.ok(VERIFICATION_KINDS.includes(entry.kind), `unexpected verification kind "${entry.kind}"`);
    assert.equal(typeof entry.command, "string");
    assert.ok(["pass", "fail", "cannot-run"].includes(entry.status));
    assert.ok(entry.evidence !== undefined, "every verification MUST carry evidence");
    assert.equal(entry.status, "pass", `${entry.kind}/${entry.id} MUST pass: ${JSON.stringify(entry.evidence)}`);
  }
  for (const kind of VERIFICATION_KINDS) assert.equal(record.requirements[kind], true);

  // The GPU suites are reported as deferred, never as passed.
  assert.equal(record.deferredVerification.length, DEFERRED_VERIFICATION.length);
  assert.ok(record.deferredVerification.every((entry) => entry.suite && entry.reason));
  assert.match(record.notes, /Three elements complete in dry-run/);
});

test("the offline battery is declared, bounded and offline", () => {
  assert.ok(OFFLINE_BATTERY.length >= 4, "the battery MUST cover the offline verifications");
  for (const item of OFFLINE_BATTERY) {
    assert.equal(item.command[0].startsWith("tools/"), true, `${item.id} MUST run a repository tool`);
    assert.ok(item.requirementRef.length > 0, `${item.id} MUST trace to a requirement`);
    assert.ok(!item.command.join(" ").includes("--test"), "the battery MUST NOT spawn the unit suite (the drill runs inside it)");
  }
  const ids = OFFLINE_BATTERY.map((item) => item.id);
  assert.deepEqual([...new Set(ids)], ids, "battery ids MUST be unique");
  for (const required of ["upstream-integrity", "kept-modules", "license-notice", "arch-boundaries", "build-layer-source"]) {
    assert.ok(ids.includes(required), `the battery MUST include "${required}"`);
  }
});

test("a missing element fails the verdict: patch scope broken", (t) => {
  const fixture = makePatchFixture({
    entries: [
      {
        upstreamModule: "Scene/Scene.js",
        localFile: "Scene/Scene.js",
        kind: "replace",
        requirementRef: ["FR-030"],
        reason: "fixture: a logic-layer override breaks the patch scope audit",
        glCallSites: 1,
      },
    ],
    localFiles: { "Scene/Scene.ts": "export default class Scene {}\n" },
  });
  t.after(fixture.cleanup);

  const record = runUpgradeDrill({ root: fixture.root, mode: "dry-run", skipBattery: true });
  assert.equal(record.verdict, "fail");
  assert.equal(record.requirements["patch-scope"], false);
  assert.equal(record.verification.find((entry) => entry.kind === "patch-scope").status, "fail");
  assert.match(record.notes, /patch-scope/);
});

test("a missing element fails the verdict: interface baseline absent", (t) => {
  const fixture = makePatchFixture();
  t.after(fixture.cleanup);

  const record = runUpgradeDrill({ root: fixture.root, mode: "dry-run", skipBattery: true });
  assert.equal(record.requirements["interface-consistency"], false);
  assert.equal(record.verdict, "fail");
  const entry = record.verification.find((item) => item.id === "interface-manifest");
  assert.equal(entry.status, "fail");
  assert.match(entry.evidence.reason, /interface baseline missing/);
});

test("a missing element fails the verdict: no build artifact for the battery", (t) => {
  const fixture = makePatchFixture();
  t.after(fixture.cleanup);
  fs.mkdirSync(path.join(fixture.root, "upstream"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.root, "upstream", "interface-manifest.json"),
    `${JSON.stringify({ baselineVersion: "26.3.0", entries: [], digest: "sha256-" + "0".repeat(64), generatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );

  const record = runUpgradeDrill({ root: fixture.root, mode: "dry-run" });
  // The fixture has no `tools/` tree, so the battery cannot run at all: the element is incomplete.
  assert.equal(record.requirements["full-verification"], false);
  assert.equal(record.verdict, "fail");
  assert.ok(record.verification.some((entry) => entry.kind === "full-verification" && entry.status === "cannot-run"));
});

test("estimated effort grows with the size of the interface diff", () => {
  assert.equal(estimateEffort({ changedRenderModules: [], breakingConsumedMembers: [] }), "none");
  assert.equal(estimateEffort({ changedRenderModules: ["Renderer/Context.js"], breakingConsumedMembers: [] }), "low");
  assert.equal(estimateEffort({ changedRenderModules: ["Renderer/Context.js", "Renderer/Buffer.js", "Renderer/Texture.js"], breakingConsumedMembers: [] }), "medium");
  assert.equal(estimateEffort({ changedRenderModules: [], breakingConsumedMembers: [{ module: "Renderer/Context.js", member: "drawingBufferWidth" }] }), "medium");
  assert.equal(estimateEffort({ changedRenderModules: Array.from({ length: 9 }, (_, index) => `Renderer/M${index}.js`), breakingConsumedMembers: [] }), "high");
  assert.equal(
    estimateEffort({
      changedRenderModules: ["Renderer/Context.js"],
      breakingConsumedMembers: [1, 2, 3].map((index) => ({ module: "Renderer/Context.js", member: `m${index}` })),
    }),
    "high",
    "several breaking consumed members MUST raise the estimate",
  );
  assert.equal(estimateEffort({ changedRenderModules: [], driftedKeptModules: ["Renderer/Sampler.js"], breakingConsumedMembers: [] }), "low");
});

test("a mode is mandatory and --full is rejected loudly (not silently ignored)", () => {
  const noMode = runDrill([]);
  assert.equal(noMode.code, 2);
  assert.match(noMode.stderr, /a mode is required/);

  const full = runDrill(["--full", "--to=26.4.0"]);
  assert.equal(full.code, 2);
  assert.match(full.stderr, /--full is NOT implemented in this increment/);
  assert.match(full.stderr, /26\.4\.0/);

  const bad = runDrill(["--dry-run", "--nonsense"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown argument/);
});

test("the CLI writes the record where CI expects it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-drill-out-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, "upgrade-drill.json");
  const { code } = runDrill(["--dry-run", "--out", out]);
  assert.equal(code, 0);
  const record = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(record.verdict, "pass");
  assert.equal(record.mode, "dry-run");
  assert.ok(REPO_ROOT.length > 0);
});
