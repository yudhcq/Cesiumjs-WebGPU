/**
 * T001 — npm workspaces root skeleton and ignore rules.
 *
 * Asserts the root manifest carries the workspace layout, Node engine floor and
 * ESM mode, and that `.gitignore` covers the generated/ignored paths listed in
 * `tasks.md` T001.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readJson, readText } from "../support/repo.mjs";

const pkg = readJson("package.json");
const gitignore = readText(".gitignore");

test("root package.json declares a private ESM workspaces monorepo", () => {
  assert.equal(pkg.private, true, "root package.json MUST be private");
  assert.equal(pkg.type, "module", "root package.json MUST use ESM (type: module)");
  assert.deepEqual(pkg.workspaces, ["packages/*", "apps/*"], "workspaces MUST be packages/* and apps/*");
  assert.equal(pkg.engines?.node, ">=22", "engines.node MUST require Node >= 22");
});

test("root package.json exposes the documented script entry points", () => {
  const expected = [
    "build",
    "typecheck",
    "lint",
    "test:unit",
    "test:contract",
    "test:visual",
    "bench",
    "demo",
    "ci:local",
  ];
  for (const name of expected) {
    assert.ok(typeof pkg.scripts?.[name] === "string", `script "${name}" MUST exist`);
    assert.match(pkg.scripts[name], /^node tools\/scripts\/run\.mjs /, `script "${name}" MUST go through tools/scripts/run.mjs`);
  }
});

test(".gitignore covers node_modules/, dist/ and the generated artifact directories", () => {
  const lines = gitignore.split(/\r?\n/);
  const required = ["node_modules/", "dist/", "artifacts/", ".specify/feature.json"];
  for (const entry of required) {
    assert.ok(lines.includes(entry), `.gitignore MUST contain the exact ignore entry "${entry}"`);
  }

  // The gate outputs are ignored by CONTENTS, not by directory: a bare `experiments/gates/out/`
  // entry would exclude the directory itself and make the `!experiments/gates/out/g<N>.json`
  // allowlist ineffective (git cannot re-include a file inside an excluded directory — the reason
  // is written out in .gitignore itself). This assertion therefore pins the pattern form AND the
  // allowlist that keeps the machine-checkable verdicts in the repository. It replaces the
  // original `experiments/gates/out/` expectation, which the Phase-2 gate commit (b36e6a4)
  // invalidated on purpose; see the T041 deviation record.
  assert.ok(lines.includes("experiments/gates/out/*"), '.gitignore MUST ignore the gate output contents ("experiments/gates/out/*")');
  assert.ok(!lines.includes("experiments/gates/out/"), "a bare directory entry would defeat the verdict allowlist below it");
  for (const verdict of ["!experiments/gates/out/g[1-9].json", "!experiments/gates/out/g1-control-no-rewrite.json"]) {
    assert.ok(lines.includes(verdict), `.gitignore MUST keep the committed gate verdict "${verdict}"`);
  }
});
