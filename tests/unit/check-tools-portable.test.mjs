/**
 * T007 — tool portability checker (`tools/scripts/check-tools-portable.mjs`).
 *
 * The important case is the last one: the real repository (which contains the checker
 * itself) MUST scan clean, so the checker cannot be "passing" by accident.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, repoPath } from "../support/repo.mjs";

const CHECKER = repoPath("tools/scripts/check-tools-portable.mjs");

function makeFixture(structure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tools-portable-"));
  for (const [relative, content] of Object.entries(structure)) {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  return root;
}

function runChecker(args) {
  const result = spawnSync(process.execPath, [CHECKER, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const CLEAN_PACKAGE_JSON = JSON.stringify({ name: "fixture", scripts: { build: "node tools/build.mjs", test: "node --test tests/unit" } }, null, 2);

test("the repository scans clean (the checker is itself part of tools/**)", () => {
  const { code, stdout } = runChecker(["--root", REPO_ROOT]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /no match/);
});

test("a Windows-shell invocation inside tools/ is reported with file and line", (t) => {
  const root = makeFixture({
    "package.json": CLEAN_PACKAGE_JSON,
    "tools/scripts/broken.mjs": ["// fixture", 'const child = spawnSync("pwsh", ["-File", "x.ps1"]);', "export default child;"].join("\n"),
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout } = runChecker(["--root", root]);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /tools\/scripts\/broken\.mjs:2/);
});

test("a Windows absolute path and shell redirection are both detected", (t) => {
  const root = makeFixture({
    "package.json": JSON.stringify({ name: "fixture", scripts: { build: "node C:\\work\\build.mjs" } }),
    "tools/build.mjs": "export const suppress = () => run('node build.mjs 2>$null');\n",
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout } = runChecker(["--root", root]);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /package\.json: windows absolute path/);
  assert.match(stdout, /broken|build\.mjs:1: windows shell null redirection/);
});

test("a shell-specific CI recipe under .github/ is detected", (t) => {
  const root = makeFixture({
    "package.json": CLEAN_PACKAGE_JSON,
    "tools/build.mjs": "export const build = () => {};\n",
    ".github/workflows/ci.yml": "jobs:\n  unit:\n    steps:\n      - run: pwsh ./build.ps1\n",
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout } = runChecker(["--root", root]);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /\.github\/workflows\/ci\.yml:4/);
});

test("a missing required scan target exits non-zero", (t) => {
  const root = makeFixture({ "package.json": CLEAN_PACKAGE_JSON });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stderr } = runChecker(["--root", root]);
  assert.equal(code, 2, stderr);
  assert.match(stderr, /required scan target missing/);
});

test("an unknown argument is rejected", () => {
  const { code, stderr } = runChecker(["--nope"]);
  assert.equal(code, 2);
  assert.match(stderr, /unknown argument/);
});
