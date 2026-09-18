/**
 * T033 — patch-scope audit (`tools/audit-patch-scope.mjs`).
 *
 * The audit is the machine proof of SC-010 ("zero logic-layer change"), so the important cases are
 * the counterexamples: a manifest that leaves `Renderer/**`, an alias whitelist that misses or
 * over-applies a rewrite, a kept module that drifted, and a bundle that carries a repository copy
 * of a logic-layer module. Each is built as a throwaway tree whose engine sources are real files,
 * so the audit's own hashing and whitelist logic does the deciding.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, readJson, repoPath } from "../support/repo.mjs";
import { computeKeptModules } from "../../tools/lib/patch-layer.mjs";
import { auditPatchScope } from "../../tools/audit-patch-scope.mjs";
import { makePatchFixture, makeProvenance } from "../support/patch-fixture.mjs";

const AUDIT = repoPath("tools/audit-patch-scope.mjs");

function runAudit(args) {
  const result = spawnSync(process.execPath, [AUDIT, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Record valid kept-module hashes into a fixture manifest (the generator does this for real). */
function withKeptHashes(fixture) {
  const manifestPath = path.join(fixture.backend, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const computed = computeKeptModules(fixture.engine, manifest);
  manifest.keptModulesHash = computed.aggregate;
  manifest.keptModules = computed.hashes;
  manifest.keptModulesCount = computed.modules.length;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return computed;
}

test("the committed repository passes the audit with logicLayerOverrides === 0", () => {
  const report = auditPatchScope();
  assert.deepEqual(report.evidence.manifestPaths.violations, []);
  assert.equal(report.verdict, "pass", JSON.stringify(report.evidence, null, 2));
  assert.equal(report.logicLayerOverrides, 0);
  assert.equal(report.baselineVersion, "26.3.0");
  for (const field of ["integrityOk", "manifestPathsValid", "aliasWhitelistExhaustive", "keptModulesUnchanged"]) {
    assert.equal(report[field], true, `${field} MUST be true`);
  }
});

test("the CLI prints the PatchScopeAudit fields and exits 0 on the repository", () => {
  const { code, stdout } = runAudit([]);
  assert.equal(code, 0, stdout);
  for (const line of ["baselineVersion: 26.3.0", "integrityOk: true", "manifestPathsValid: true", "aliasWhitelistExhaustive: true", "logicLayerOverrides: 0", "keptModulesUnchanged: true"]) {
    assert.ok(stdout.includes(line), `the audit MUST print "${line}"`);
  }
  const report = readJson("artifacts/patch-scope-audit.json");
  assert.equal(report.verdict, "pass");
  // The artifact carries exactly the data-model §1.3 fields.
  for (const field of ["baselineVersion", "integrityOk", "manifestPathsValid", "aliasWhitelistExhaustive", "logicLayerOverrides", "keptModulesUnchanged", "verdict"]) {
    assert.ok(field in report, `PatchScopeAudit MUST carry the field "${field}" (data-model §1.3)`);
  }
});

test("a clean fixture tree passes: all booleans true, overrides 0", (t) => {
  const fixture = makePatchFixture();
  t.after(fixture.cleanup);
  withKeptHashes(fixture);

  const report = auditPatchScope({ root: fixture.root });
  assert.equal(report.verdict, "pass", JSON.stringify(report.evidence, null, 2));
  assert.equal(report.logicLayerOverrides, 0);
  assert.equal(report.evidence.aliasWhitelist.missing.length, 0);
  assert.equal(report.evidence.aliasWhitelist.extra.length, 0);
});

test("a manifest entry outside Renderer/** fails the audit (counterexample 1)", (t) => {
  const fixture = makePatchFixture({
    entries: [
      {
        upstreamModule: "Scene/Scene.js",
        localFile: "Scene/Scene.js",
        kind: "replace",
        requirementRef: ["FR-030"],
        reason: "fixture: a logic-layer override MUST be caught",
        glCallSites: 1,
      },
      {
        upstreamModule: "Renderer/Context.js",
        localFile: "Renderer/Context.js",
        kind: "replace",
        requirementRef: ["FR-030"],
        reason: "fixture: a legitimate renderer replacement",
        glCallSites: 2,
      },
    ],
    localFiles: { "Scene/Scene.ts": "export default class Scene {}\n" },
  });
  t.after(fixture.cleanup);
  withKeptHashes(fixture);

  const report = auditPatchScope({ root: fixture.root });
  assert.equal(report.verdict, "fail");
  assert.equal(report.manifestPathsValid, false, "leaving Renderer/** MUST fail the boundary assertion");
  assert.ok(report.evidence.manifestPaths.boundaryViolations.length >= 1);
  assert.ok(report.evidence.manifestPaths.boundaryViolations.some((violation) => /patch boundary/.test(violation.detail)));

  const { code, stderr } = runAudit(["--root", fixture.root, "--out", path.join(fixture.root, "artifacts", "patch-scope-audit.json")]);
  assert.equal(code, 1, stderr);
  const written = JSON.parse(fs.readFileSync(path.join(fixture.root, "artifacts", "patch-scope-audit.json"), "utf8"));
  assert.equal(written.verdict, "fail");
  assert.equal(written.manifestPathsValid, false);
});

test("an unregistered local replacement module fails the whitelist check (counterexample 2a: over-application)", (t) => {
  const fixture = makePatchFixture({ localFiles: { "Renderer/Extra.ts": "export default class Extra {}\n" } });
  t.after(fixture.cleanup);
  withKeptHashes(fixture);

  const report = auditPatchScope({ root: fixture.root });
  assert.equal(report.aliasWhitelistExhaustive, false);
  assert.equal(report.verdict, "fail");
  assert.deepEqual(report.evidence.aliasWhitelist.extra, ["Renderer/Extra.js"]);
  assert.equal(runAudit(["--root", fixture.root]).code, 1);
});

test("a manifest entry the engine does not ship fails the whitelist check (counterexample 2b: missed rewrite)", (t) => {
  const fixture = makePatchFixture({
    entries: [
      {
        upstreamModule: "Renderer/Context.js",
        localFile: "Renderer/Context.js",
        kind: "replace",
        requirementRef: ["FR-030"],
        reason: "fixture: legitimate entry",
        glCallSites: 2,
      },
      {
        upstreamModule: "Renderer/NotShipped.js",
        localFile: "Renderer/NotShipped.js",
        kind: "adapt",
        requirementRef: ["FR-030"],
        reason: "fixture: an entry that can never be rewritten MUST be caught",
        glCallSites: 0,
      },
    ],
    localFiles: { "Renderer/NotShipped.ts": "export default function NotShipped() {}\n" },
  });
  t.after(fixture.cleanup);
  withKeptHashes(fixture);

  const report = auditPatchScope({ root: fixture.root });
  assert.equal(report.aliasWhitelistExhaustive, false);
  assert.equal(report.verdict, "fail");
  assert.deepEqual(report.evidence.aliasWhitelist.missing, ["Renderer/NotShipped.js"]);
});

test("a drifted kept module fails the audit (counterexample 3)", (t) => {
  const fixture = makePatchFixture();
  t.after(fixture.cleanup);
  const computed = withKeptHashes(fixture);

  // One byte changes in a module the patch layer still consumes straight from upstream.
  const target = "Source/Renderer/UniformState.js";
  const file = path.join(fixture.engine, ...target.split("/"));
  fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}// tampered\n`, "utf8");
  assert.notEqual(computeKeptModules(fixture.engine, JSON.parse(fs.readFileSync(path.join(fixture.backend, "manifest.json"), "utf8"))).hashes[target.replace("Source/", "")], computed.hashes[target.replace("Source/", "")]);

  const report = auditPatchScope({ root: fixture.root });
  assert.equal(report.keptModulesUnchanged, false);
  assert.equal(report.verdict, "fail");
  assert.ok(report.evidence.keptModules.drifted.includes("Renderer/UniformState.js"));
});

test("a bundle carrying a repository copy of a logic-layer module fails the audit (counterexample 4)", (t) => {
  const fixture = makePatchFixture({
    provenance: makeProvenance({
      repoModules: ["packages/cesium-webgpu/src/index.ts"],
      patchLayerModules: ["packages/cesium-webgpu/backend-webgpu/Renderer/Context.ts", "packages/cesium-webgpu/backend-webgpu/Scene/Scene.ts"],
    }),
    files: { "packages/cesium-webgpu/backend-webgpu/Scene/Scene.ts": "export default class Scene {}\n" },
  });
  t.after(fixture.cleanup);
  withKeptHashes(fixture);

  const report = auditPatchScope({ root: fixture.root });
  assert.equal(report.logicLayerOverrides, 1, JSON.stringify(report.evidence.logicLayerOverrides));
  assert.equal(report.verdict, "fail");
  assert.equal(report.evidence.logicLayerOverrides.overrides[0].module, "Scene/Scene.js");
  assert.equal(report.evidence.logicLayerOverrides.overrides[0].source, "bundle");
});

test("the audit reports the provenance artifacts it consumed and never hides a missing baseline", (t) => {
  const fixture = makePatchFixture({ provenance: makeProvenance({ patchLayerModules: ["packages/cesium-webgpu/backend-webgpu/Renderer/Context.ts"] }) });
  t.after(fixture.cleanup);
  withKeptHashes(fixture);

  const withProvenance = auditPatchScope({ root: fixture.root });
  assert.deepEqual(withProvenance.evidence.logicLayerOverrides.provenanceArtifacts, ["artifacts/build-provenance.fixture.json"]);
  assert.match(withProvenance.evidence.logicLayerOverrides.note, /manifest substitution set \+ bundle module graph/);

  fs.rmSync(path.join(fixture.root, "upstream", "engine-26.3.0.lock.json"));
  const withoutBaseline = auditPatchScope({ root: fixture.root });
  assert.equal(withoutBaseline.integrityOk, false, "a missing baseline record MUST NOT count as intact");
  assert.equal(withoutBaseline.verdict, "fail");
});

test("the CLI writes the audit record next to the fixture root and rejects unknown arguments", (t) => {
  const fixture = makePatchFixture();
  t.after(fixture.cleanup);
  withKeptHashes(fixture);

  const out = path.join(fixture.root, "artifacts", "custom-audit.json");
  const { code, stdout } = runAudit(["--root", fixture.root, "--out", out]);
  assert.equal(code, 0, stdout);
  assert.ok(fs.existsSync(out), "the audit record MUST be archived at the requested path");
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).verdict, "pass");

  const bad = runAudit(["--nonsense"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown argument/);

  assert.ok(REPO_ROOT.length > 0);
});
