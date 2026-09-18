/**
 * T030 — upstream integrity (`tools/scripts/verify-upstream-integrity.mjs`).
 *
 * The decisive property is falsifiability: besides asserting the real tree is intact, these
 * cases prove the check FAILS when one byte of an upstream module changes, when the recorded
 * integrity hash stops matching the lockfile, and when the package is not installed at all.
 * The tamper counterexample runs through the real CLI on a throwaway tree; the real-scale
 * sensitivity case perturbs an installed upstream module **in memory** (nothing under
 * `node_modules` is ever written).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, readJson, repoPath } from "../support/repo.mjs";
import { snapshotEngineSource } from "../../tools/lib/patch-layer.mjs";
import { verifyUpstreamIntegrity } from "../../tools/scripts/verify-upstream-integrity.mjs";

const SCRIPT = repoPath("tools/scripts/verify-upstream-integrity.mjs");
const ENGINE_ROOT = path.join(REPO_ROOT, "node_modules", "@cesium", "engine");
const BASELINE = readJson("upstream/engine-26.3.0.lock.json");

/** Build a throwaway tree: a fake installed engine, a baseline record and a lockfile. */
function makeEngineFixture({ tamperSource = false, tamperIntegrity = false, install = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-integrity-"));
  const engine = path.join(root, "node_modules", "@cesium", "engine");
  const write = (relative, content) => {
    const file = path.join(engine, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  };
  if (install) {
    write("package.json", `${JSON.stringify({ name: "@cesium/engine", version: "26.3.0", license: "Apache-2.0" }, null, 2)}\n`);
    write("index.js", 'const CESIUM_VERSION = "1.145.0";\nexport { CESIUM_VERSION };\n');
    write("Source/Renderer/Context.js", "export default class Context {}\n");
    write("Source/Scene/Scene.js", "export default class Scene {}\n");
  }

  const snapshot = install ? snapshotEngineSource(engine) : null;
  const record = {
    packageName: "@cesium/engine",
    version: "26.3.0",
    cesiumVersion: "1.145.0",
    integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    license: "Apache-2.0",
    recordedAt: "2026-09-19T01:34:07+08:00",
    notes: "fixture baseline: only Source/Renderer/** modules are replaced at build time by the alias plugin",
    ...(snapshot === null ? {} : { sourceSnapshot: { ...snapshot, recordedAt: "2026-09-19T01:34:07+08:00", notes: "fixture" } }),
    toolchain: {
      glslang: { version: "16.6.0" },
      "naga-cli": { version: "30.0.1", installCommand: "cargo install naga-cli --version 30.0.1 --locked" },
      "@webgpu/glslang": { version: "0.0.15", entry: "dist/web-devel-onefile" },
    },
  };
  fs.mkdirSync(path.join(root, "upstream"), { recursive: true });
  fs.writeFileSync(path.join(root, "upstream", "engine-26.3.0.lock.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "node_modules/@cesium/engine": {
            version: "26.3.0",
            integrity: tamperIntegrity ? "sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==" : record.integrity,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const workspace = path.join(root, "packages", "cesium-webgpu");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ name: "cesium-webgpu", dependencies: { "@cesium/engine": "26.3.0" } }, null, 2)}\n`,
    "utf8",
  );

  if (tamperSource) {
    // One flipped byte, same file size: only a content hash can see this.
    const file = path.join(engine, "Source", "Scene", "Scene.js");
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 2] = bytes[bytes.length - 2] === 0x20 ? 0x21 : 0x20;
    fs.writeFileSync(file, bytes);
  }
  return root;
}

function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("the installed upstream package passes every integrity check", () => {
  const report = verifyUpstreamIntegrity();
  const failed = report.checks.filter((entry) => !entry.ok);
  assert.deepEqual(failed, [], `failing checks: ${failed.map((entry) => `${entry.id}: ${entry.detail}`).join("; ")}`);
  assert.equal(report.verdict, "pass");
  assert.equal(report.baseline.version, "26.3.0");
  assert.equal(report.source.recorded.aggregate, report.source.computed.aggregate);
  assert.ok(report.source.computed.fileCount > 1000, "Source/** MUST cover the whole engine source tree");
});

test("the CLI exits 0 and prints 'no mismatch' on the real tree", () => {
  const { code, stdout } = runCli([]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /no mismatch/);
  assert.match(stdout, /upstream-integrity: @cesium\/engine@26\.3\.0 intact/);
  const report = readJson("artifacts/upstream-integrity.json");
  assert.equal(report.verdict, "pass");
});

test("a single tampered byte in an installed Source module fails the check (CLI counterexample)", (t) => {
  const root = makeEngineFixture({ tamperSource: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout, stderr } = runCli(["--root", root, "--out", path.join(root, "artifacts", "upstream-integrity.json")]);
  assert.equal(code, 1, `expected a failing exit code\n${stdout}${stderr}`);
  assert.match(stderr, /source-unchanged/);
  const report = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "upstream-integrity.json"), "utf8"));
  assert.equal(report.verdict, "fail");
  assert.equal(report.checks.find((entry) => entry.id === "source-unchanged").ok, false);
  // The tamper changed neither the file count nor the byte total: only the content hash can see it.
  assert.equal(report.source.computed.fileCount, report.source.recorded.fileCount);
  assert.equal(report.source.computed.totalBytes, report.source.recorded.totalBytes);
});

test("an untampered fixture of the same shape passes end to end", (t) => {
  const root = makeEngineFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout } = runCli(["--root", root, "--out", path.join(root, "artifacts", "upstream-integrity.json")]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /no mismatch/);
});

test("a lockfile integrity that no longer matches the record fails", (t) => {
  const root = makeEngineFixture({ tamperIntegrity: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const report = verifyUpstreamIntegrity({ root });
  assert.equal(report.verdict, "fail");
  assert.equal(report.checks.find((entry) => entry.id === "integrity-matches-lockfile").ok, false);
});

test("a missing installation is reported instead of passing silently", (t) => {
  const root = makeEngineFixture({ install: false });
  const baselinePath = path.join(root, "upstream", "engine-26.3.0.lock.json");
  const record = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  delete record.sourceSnapshot;
  fs.writeFileSync(baselinePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const report = verifyUpstreamIntegrity({ root });
  assert.equal(report.verdict, "fail");
  assert.equal(report.checks.find((entry) => entry.id === "engine-installed").ok, false);
  assert.equal(runCli(["--root", root]).code, 1);
});

test("a missing source snapshot in the record fails loudly (never a silent pass)", (t) => {
  const root = makeEngineFixture();
  const baselinePath = path.join(root, "upstream", "engine-26.3.0.lock.json");
  const record = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  delete record.sourceSnapshot;
  fs.writeFileSync(baselinePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const report = verifyUpstreamIntegrity({ root });
  assert.equal(report.verdict, "fail");
  assert.equal(report.checks.find((entry) => entry.id === "source-snapshot-recorded").ok, false);
});

test("the recorded snapshot is sensitive to one flipped byte at the real tree's scale", () => {
  const clean = snapshotEngineSource(ENGINE_ROOT);
  const target = "Source/Renderer/Context.js";
  const bytes = Buffer.from(fs.readFileSync(path.join(ENGINE_ROOT, ...target.split("/"))));
  bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0x01;
  const tampered = snapshotEngineSource(ENGINE_ROOT, { overrides: new Map([[target, bytes]]) });

  assert.equal(clean.fileCount, tampered.fileCount, "the override MUST NOT change the file set");
  assert.equal(clean.totalBytes, tampered.totalBytes, "the override MUST NOT change the byte total");
  assert.notEqual(clean.aggregate, tampered.aggregate, "a one-byte change MUST change the aggregate hash");

  const report = verifyUpstreamIntegrity({ sourceOverrides: new Map([[target, bytes]]) });
  assert.equal(report.verdict, "fail");
  assert.equal(report.checks.find((entry) => entry.id === "source-unchanged").ok, false);
});

test("the recorded baseline still documents the pinned version, integrity and toolchain", () => {
  assert.equal(BASELINE.version, "26.3.0");
  assert.equal(BASELINE.cesiumVersion, "1.145.0");
  assert.match(BASELINE.integrity, /^sha512-/);
  assert.ok(BASELINE.sourceSnapshot, "the baseline record MUST carry the Source/** snapshot (T030)");
  assert.match(BASELINE.sourceSnapshot.aggregate, /^sha256-[0-9a-f]{64}$/);
  assert.equal(BASELINE.sourceSnapshot.algorithm, "sha256");
  assert.ok(!Number.isNaN(Date.parse(BASELINE.sourceSnapshot.recordedAt)), "the snapshot MUST record when it was taken");
});
