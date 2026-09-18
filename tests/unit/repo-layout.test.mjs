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
  const required = ["node_modules/", "dist/", "artifacts/", "experiments/gates/out/", ".specify/feature.json"];
  for (const entry of required) {
    assert.ok(
      gitignore.split(/\r?\n/).includes(entry),
      `.gitignore MUST contain the exact ignore entry "${entry}"`,
    );
  }
});
