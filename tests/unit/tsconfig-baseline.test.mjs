/**
 * T002 — TypeScript `strict` baseline.
 *
 * Reads the JSON directly (never requires an installed `tsc`) so the assertion
 * holds on a fresh checkout before `npm ci` has run.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readJson } from "../support/repo.mjs";

const base = readJson("tsconfig.base.json");
const packageConfig = readJson("packages/cesium-webgpu/tsconfig.json");
const demoConfig = readJson("apps/demo/tsconfig.json");

test("tsconfig.base.json enables the three mandatory strict switches", () => {
  assert.equal(base.compilerOptions.strict, true, "strict MUST be true");
  assert.equal(base.compilerOptions.exactOptionalPropertyTypes, true, "exactOptionalPropertyTypes MUST be true");
  assert.equal(base.compilerOptions.noUncheckedIndexedAccess, true, "noUncheckedIndexedAccess MUST be true");
});

test("tsconfig.base.json targets Node 22 + ESM output", () => {
  assert.equal(base.compilerOptions.module, "ESNext", "module MUST be ESM");
  assert.match(String(base.compilerOptions.target), /^ES20(22|23)$/, "target MUST be ES2022 or ES2023 (Node 22 baseline)");
  assert.equal(base.compilerOptions.moduleResolution, "Bundler", "moduleResolution MUST be Bundler (Rollup build chain)");
  assert.equal(base.compilerOptions.verbatimModuleSyntax, true, "verbatimModuleSyntax MUST be on for clean ESM emit");
});

test("both workspace packages extend the shared baseline", () => {
  assert.equal(packageConfig.extends, "../../tsconfig.base.json", "packages/cesium-webgpu/tsconfig.json MUST extend the baseline");
  assert.equal(demoConfig.extends, "../../tsconfig.base.json", "apps/demo/tsconfig.json MUST extend the baseline");
  assert.ok(Array.isArray(packageConfig.include) && packageConfig.include.length > 0, "package tsconfig MUST declare include patterns");
  assert.ok(Array.isArray(demoConfig.include) && demoConfig.include.length > 0, "demo tsconfig MUST declare include patterns");
});
