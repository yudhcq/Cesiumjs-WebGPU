/**
 * T006 — architecture boundary scanner (`tools/scripts/check-arch-boundaries.mjs`).
 *
 * Three families of cases are covered, as required by T006:
 *   positive (a violation is detected and reported), negative (a clean tree exits 0 and
 *   prints "no match"), and missing scan target (non-zero exit — never a silent pass).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, repoPath } from "../support/repo.mjs";

const SCANNER = repoPath("tools/scripts/check-arch-boundaries.mjs");

/** Create a throwaway repository tree from a `{ "relative/path": "content" }` map. */
function makeFixture(structure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arch-boundaries-"));
  for (const [relative, content] of Object.entries(structure)) {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  return root;
}

function runScanner(args) {
  const result = spawnSync(process.execPath, [SCANNER, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function readReport(root, fileName = "arch-boundaries.json") {
  return JSON.parse(fs.readFileSync(path.join(root, "artifacts", fileName), "utf8"));
}

const CLEAN_PUBLIC_API = {
  "packages/cesium-webgpu/src/index.ts": 'export type BackendKind = "webgpu" | "webgl2";\nexport const createTerrainScene = () => {};\n',
  "packages/cesium-webgpu/src/api/types.ts": "export interface TerrainSceneOptions { container: unknown }\n",
  "packages/cesium-webgpu/dist/index.d.ts": 'export type BackendKind = "webgpu" | "webgl2";\n',
};

test("A1: a backend symbol in the public surface is reported as a violation", (t) => {
  const root = makeFixture({
    ...CLEAN_PUBLIC_API,
    "packages/cesium-webgpu/src/api/types.ts": "export interface TerrainSceneOptions { device: GPUBuffer }\n",
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout } = runScanner(["--root", root, "--rules", "A1"]);
  assert.equal(code, 1, `expected exit 1 on a violation, got ${code}\n${stdout}`);
  assert.match(stdout, /\[A1\] match/);
  const report = readReport(root);
  assert.equal(report.verdict, "fail");
  assert.ok(report.results[0].violations.some((v) => /GPU/.test(v.detail)));
});

test("A1: a clean public surface exits 0 and prints 'no match'", (t) => {
  const root = makeFixture(CLEAN_PUBLIC_API);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout } = runScanner(["--root", root, "--rules", "A1"]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /no match/);
  assert.equal(readReport(root).verdict, "pass");
});

test("A3: a manifest entry outside Renderer/** fails; a Renderer-only manifest passes", (t) => {
  const violating = makeFixture({
    "packages/cesium-webgpu/backend-webgpu/manifest.json": JSON.stringify({
      baseline: { version: "26.3.0" },
      entries: [{ upstreamModule: "Scene/Scene.js", localFile: "Scene/Scene.js", kind: "replace" }],
    }),
  });
  const clean = makeFixture({
    "packages/cesium-webgpu/backend-webgpu/manifest.json": JSON.stringify({
      baseline: { version: "26.3.0" },
      entries: [{ upstreamModule: "Renderer/Context.js", localFile: "Renderer/Context.js", kind: "replace" }],
    }),
  });
  t.after(() => {
    fs.rmSync(violating, { recursive: true, force: true });
    fs.rmSync(clean, { recursive: true, force: true });
  });

  const bad = runScanner(["--root", violating, "--rules", "A3"]);
  assert.equal(bad.code, 1, bad.stdout);
  assert.match(bad.stdout, /Renderer/);

  const good = runScanner(["--root", clean, "--rules", "A3"]);
  assert.equal(good.code, 0, good.stdout);
  assert.match(good.stdout, /no match/);
});

test("A5: a caller-side backend branch is a violation", (t) => {
  const root = makeFixture({
    "apps/demo/index.html": "<!doctype html><title>demo</title>",
    "apps/demo/src/main.ts": 'const active = preference === "webgpu" ? 1 : 2;\n',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout } = runScanner(["--root", root, "--rules", "A5"]);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /main\.ts:1/);
});

test("a missing scan target exits non-zero instead of passing silently", (t) => {
  const root = makeFixture({ "README.md": "empty fixture\n" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const strict = runScanner(["--root", root, "--rules", "A3"]);
  assert.equal(strict.code, 2, `expected exit 2 for a missing target, got ${strict.code}\n${strict.stdout}${strict.stderr}`);
  assert.match(strict.stderr, /target does not exist/);
  assert.equal(readReport(root).verdict, "fail");

  const auto = runScanner(["--root", root, "--rules", "auto"]);
  assert.equal(auto.code, 0, auto.stdout + auto.stderr);
  assert.match(auto.stdout, /skipped-missing-target/);
});

test("--rules selects a subset of rules", (t) => {
  const root = makeFixture({
    ...CLEAN_PUBLIC_API,
    "apps/demo/index.html": "<!doctype html><title>demo</title>",
    "apps/demo/src/main.ts": "export const start = () => {};\n",
    // A3 would fail here, but it is not selected.
    "packages/cesium-webgpu/backend-webgpu/manifest.json": JSON.stringify({
      entries: [{ upstreamModule: "Scene/Scene.js", localFile: "Scene/Scene.js", kind: "replace" }],
    }),
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout } = runScanner(["--root", root, "--rules", "A1,A5"]);
  assert.equal(code, 0, stdout);
  const report = readReport(root);
  assert.deepEqual(report.results.map((r) => r.rule), ["A1", "A5"]);
});

test("an unknown rule id is rejected", () => {
  const { code, stderr } = runScanner(["--rules", "A99"]);
  assert.equal(code, 2);
  assert.match(stderr, /unknown rule/);
});

test("A9 runs against the pinned upstream probe in this repository", (t) => {
  const out = path.join(os.tmpdir(), `arch-boundaries-a9-${process.pid}.json`);
  t.after(() => fs.rmSync(out, { force: true }));

  const result = spawnSync(process.execPath, [SCANNER, "--root", REPO_ROOT, "--rules", "A9", "--out", out], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  const report = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.ok(report.results[0].summary.probes >= 1, "the upstream GLSL probe MUST still be present");
});
