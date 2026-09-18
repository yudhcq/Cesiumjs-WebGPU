/**
 * T003 — upstream pinning and baseline record.
 *
 * Runs after `npm ci`; asserts the installed engine is exactly the pinned baseline and
 * that the recorded integrity hash agrees with the lockfile, plus the locked shader
 * toolchain versions.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, readJson, readText } from "../support/repo.mjs";

const baseline = readJson("upstream/engine-26.3.0.lock.json");
const packageManifest = readJson("packages/cesium-webgpu/package.json");
const lockfile = readJson("package-lock.json");
const engineRoot = path.join(REPO_ROOT, "node_modules", "@cesium", "engine");

test("@cesium/engine is declared as an exact version (no ^ / ~ ranges)", () => {
  const declared = packageManifest.dependencies?.["@cesium/engine"];
  assert.equal(declared, "26.3.0", "packages/cesium-webgpu/package.json MUST pin @cesium/engine to 26.3.0");
  assert.doesNotMatch(declared, /[\^~><*]|\bx\b/, "the upstream dependency MUST NOT use a version range");
});

test("the installed upstream package matches the recorded baseline", () => {
  assert.ok(fs.existsSync(engineRoot), "node_modules/@cesium/engine MUST be installed (run npm ci)");
  const installed = JSON.parse(fs.readFileSync(path.join(engineRoot, "package.json"), "utf8"));
  assert.equal(installed.version, baseline.version, "installed version MUST equal the recorded baseline version");
  assert.equal(installed.version, "26.3.0", "installed version MUST be 26.3.0");
  assert.equal(installed.license, baseline.license, "license MUST match the baseline record");

  const entry = lockfile.packages?.["node_modules/@cesium/engine"];
  assert.ok(entry, "package-lock.json MUST contain the resolved @cesium/engine entry");
  assert.equal(entry.version, "26.3.0", "lockfile MUST resolve @cesium/engine to 26.3.0");
  assert.equal(entry.integrity, baseline.integrity, "lockfile integrity MUST equal the recorded baseline integrity");

  const indexSource = fs.readFileSync(path.join(engineRoot, "index.js"), "utf8");
  const versionMatch = indexSource.match(/CESIUM_VERSION\s*=\s*"([^"]+)"/);
  assert.ok(versionMatch, "upstream index.js MUST expose CESIUM_VERSION");
  assert.equal(versionMatch[1], baseline.cesiumVersion, "recorded cesiumVersion MUST equal the upstream CESIUM_VERSION");
  assert.equal(baseline.cesiumVersion, "1.145.0", "the 26.3.0 baseline MUST map to cesium 1.145.0");
});

test("the baseline record carries the required metadata", () => {
  assert.equal(baseline.packageName, "@cesium/engine");
  assert.match(baseline.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, "integrity MUST be a sha512 SRI hash");
  assert.equal(baseline.license, "Apache-2.0");
  assert.ok(!Number.isNaN(Date.parse(baseline.recordedAt)), "recordedAt MUST be a parseable date-time");
  assert.ok(typeof baseline.notes === "string" && baseline.notes.length > 20, "notes MUST document the baseline boundary");
  assert.match(baseline.notes, /Renderer/, "notes MUST state the patch boundary (Renderer/**)");
});

test("the baseline record locks the three shader toolchain versions", () => {
  assert.equal(baseline.toolchain?.glslang?.version, "16.6.0");
  assert.equal(baseline.toolchain?.["naga-cli"]?.version, "30.0.1");
  assert.match(
    baseline.toolchain?.["naga-cli"]?.installCommand ?? "",
    /cargo install naga-cli --version 30\.0\.1 --locked/,
    "naga MUST be installed with an explicit --version and --locked (no prebuilt binary exists)",
  );
  assert.equal(baseline.toolchain?.["@webgpu/glslang"]?.version, "0.0.15");
  assert.equal(
    baseline.toolchain?.["@webgpu/glslang"]?.entry,
    "dist/web-devel-onefile",
    "@webgpu/glslang MUST be pinned to dist/web-devel-onefile (default Node entry hangs > 120 s)",
  );
});

test("no upstream file is modified in this repository", () => {
  // The baseline package is consumed as-is; the patch layer replaces modules at build time only.
  const gitignore = readText(".gitignore");
  assert.ok(gitignore.includes("node_modules/"), "node_modules MUST stay ignored (upstream stays untouched on disk)");
});
