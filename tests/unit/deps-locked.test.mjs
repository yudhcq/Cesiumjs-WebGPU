/**
 * T004 — build/test dependencies are exactly locked.
 *
 * Every devDependency MUST be an exact version (no `^`, `~`, ranges or tags) and the
 * generated lockfile MUST resolve the pinned upstream baseline.
 *
 * **F-1 increment (G-1 finding, authorised for G-2)**: `@rollup/plugin-commonjs` was added as a
 * pinned **devDependency** because `@cesium/engine`'s `Source/**` imports CommonJS-only packages
 * (`mersenne-twister`, `urijs`, `protobufjs`, …) and the product `dist` (which embeds the replaced
 * upstream sources) needs real CJS interop. The three conditions of that authorisation are asserted
 * here: exact version, build-time only (never a runtime dependency of any workspace package), and a
 * permissive license (MIT) that the license gate (T040) must allow.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { listFiles, readJson } from "../support/repo.mjs";

const pkg = readJson("package.json");
const lockfile = readJson("package-lock.json");

/** Added by F-1: the CJS interop plugin the upstream engine's dependencies require. */
const CJS_INTEROP_PLUGIN = "@rollup/plugin-commonjs";

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
    CJS_INTEROP_PLUGIN,
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

test("the CJS interop plugin is build-time only (never a runtime dependency)", () => {
  // Condition 2 of the F-1 authorisation: it may only ever appear in the root devDependencies.
  assert.ok(pkg.devDependencies?.[CJS_INTEROP_PLUGIN], `${CJS_INTEROP_PLUGIN} MUST be a root devDependency`);
  assert.equal(pkg.dependencies?.[CJS_INTEROP_PLUGIN], undefined, `${CJS_INTEROP_PLUGIN} MUST NOT be a runtime dependency of the root package`);
  for (const workspace of listFiles("packages", { extensions: ["package.json"] })) {
    const manifest = readJson(workspace);
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      assert.equal(
        manifest[field]?.[CJS_INTEROP_PLUGIN],
        undefined,
        `${workspace} MUST NOT list ${CJS_INTEROP_PLUGIN} in ${field} (build-time tool only, F-1 condition 2)`,
      );
    }
  }
});

test("the CJS interop plugin carries a permissive license the license gate must allow", () => {
  // Condition 3 of the F-1 authorisation: the license gate (tasks.md T040, licence allow-list)
  // MUST include MIT. The declared license is read from the installed package so the fact is
  // machine-checked rather than asserted in prose.
  const installed = readJson(`node_modules/${CJS_INTEROP_PLUGIN}/package.json`);
  assert.equal(installed.license, "MIT", `${CJS_INTEROP_PLUGIN} is expected to declare the MIT license (F-1 condition 3)`);
  assert.equal(installed.version, pkg.devDependencies[CJS_INTEROP_PLUGIN], "the installed version MUST be the pinned one");
});
