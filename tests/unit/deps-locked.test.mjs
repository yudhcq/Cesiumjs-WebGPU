/**
 * T004 — build/test dependencies are exactly locked.
 *
 * Every devDependency MUST be an exact version (no `^`, `~`, ranges or tags) and the
 * generated lockfile MUST resolve the pinned upstream baseline.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readJson } from "../support/repo.mjs";

const pkg = readJson("package.json");
const lockfile = readJson("package-lock.json");

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

test("every devDependency is an exact version", () => {
  const devDependencies = pkg.devDependencies ?? {};
  const names = Object.keys(devDependencies);
  assert.ok(names.length >= 8, `expected at least 8 locked devDependencies, got ${names.length}`);
  for (const [name, range] of Object.entries(devDependencies)) {
    assert.match(range, EXACT_VERSION, `devDependency "${name}" MUST be an exact version, got "${range}"`);
  }
});

test("the build and verification toolchain required by T004 is present", () => {
  const required = [
    "rollup",
    "@rollup/plugin-typescript",
    "@rollup/plugin-node-resolve",
    "rollup-plugin-dts",
    "typescript",
    "@webgpu/types",
    "playwright",
    "yaml",
  ];
  for (const name of required) {
    assert.ok(pkg.devDependencies?.[name], `devDependencies MUST include "${name}"`);
    assert.equal(
      lockfile.packages?.[`node_modules/${name}`]?.version,
      pkg.devDependencies[name],
      `lockfile MUST resolve "${name}" to the pinned version`,
    );
  }
});

test("playwright and yaml are pinned to explicit versions (no floating behaviour)", () => {
  for (const name of ["playwright", "yaml"]) {
    const pinned = pkg.devDependencies[name];
    assert.match(pinned, EXACT_VERSION, `${name} MUST be pinned exactly`);
    assert.equal(lockfile.packages?.[`node_modules/${name}`]?.version, pinned, `${name} lockfile entry MUST match`);
  }
});

test("typescript stays on the 5.x line required by plan.md", () => {
  assert.match(pkg.devDependencies.typescript, /^5\./, "plan Technical Context specifies TypeScript 5.x");
});

test("the lockfile is a committed v3 lockfile resolving the upstream baseline", () => {
  assert.equal(lockfile.lockfileVersion, 3, "package-lock.json MUST be lockfileVersion 3");
  assert.equal(lockfile.packages["node_modules/@cesium/engine"].version, "26.3.0", "lockfile MUST resolve @cesium/engine 26.3.0");
  assert.ok(lockfile.packages["node_modules/cesium-webgpu"], "the workspace package MUST be linked in the lockfile");
});
