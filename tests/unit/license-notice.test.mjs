/**
 * T040 — license, attribution and derived-file header gate (`tools/scripts/check-license-notice.mjs`).
 *
 * The decisive assertions are falsifiable: the licence allow-list rejects GPL/AGPL/unknown, a
 * copyleft license is only tolerated for a build-time-only dependency, and the NOTICE file list
 * must equal the patch manifest one-to-one (a module added to the manifest without a NOTICE entry
 * fails here).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, readJson, readText, repoPath } from "../support/repo.mjs";
import { checkLicenseNotice, compareNoticeWithManifest, evaluateLicense, readInstalledLicenses } from "../../tools/scripts/check-license-notice.mjs";

const CHECKER = repoPath("tools/scripts/check-license-notice.mjs");
const manifest = readJson("packages/cesium-webgpu/backend-webgpu/manifest.json");
const baseline = readJson("upstream/engine-26.3.0.lock.json");

function runChecker(args = []) {
  const result = spawnSync(process.execPath, [CHECKER, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("the gate passes on the delivered tree and archives its conclusion", () => {
  const { code, stdout } = runChecker([]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /no violation/);
  const report = readJson("artifacts/license-notice.json");
  assert.equal(report.verdict, "pass");
  assert.ok(report.conclusion.length > 50, "the conclusion MUST be a real statement, not an empty field");
  assert.match(report.conclusion, /Apache-2\.0/);
  assert.equal(report.violations.length, 0);
});

test("LICENSE is Apache-2.0 and matches the root manifest", () => {
  const license = readText("LICENSE");
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0, January 2004/);
  assert.match(license, /Copyright \d{4} the cesium-webgpu contributors/);
  assert.match(license, /CesiumJS Contributors/, "the delivery MUST keep the upstream attribution");
  assert.equal(readJson("package.json").license, "Apache-2.0");
  assert.equal(readJson("packages/cesium-webgpu/package.json").license, "Apache-2.0");
});

test("NOTICE declares the upstream software, the pinned baseline and every module of the manifest", () => {
  const notice = readText("NOTICE");
  assert.match(notice, /This product includes software developed by CesiumJS Contributors/);
  assert.match(notice, /本产品包含 CesiumJS Contributors 开发的软件/);
  assert.ok(notice.includes(baseline.version), "NOTICE MUST state the upstream version");
  assert.ok(notice.includes(baseline.integrity), "NOTICE MUST state the recorded integrity hash");
  assert.ok(notice.includes("@cesium/engine"), "NOTICE MUST name the upstream package");

  const comparison = compareNoticeWithManifest(notice, manifest);
  assert.equal(comparison.listedCount, manifest.entries.length);
  assert.deepEqual(comparison.missing, [], "every manifest module MUST have a NOTICE entry");
  assert.deepEqual(comparison.extra, [], "NOTICE MUST NOT list a module the manifest does not declare");
  assert.deepEqual(comparison.kindMismatch, []);
  assert.equal(comparison.matches, true);
});

test("a module added to the manifest without a NOTICE entry is reported as a violation", () => {
  const notice = readText("NOTICE");
  const extended = structuredClone(manifest);
  extended.entries.push({
    upstreamModule: "Renderer/Sampler.js",
    localFile: "Renderer/Sampler.js",
    kind: "adapt",
    requirementRef: ["FR-030"],
    reason: "fixture: an unlisted manifest entry MUST be caught by the NOTICE check",
    glCallSites: 0,
  });
  const comparison = compareNoticeWithManifest(notice, extended);
  assert.equal(comparison.matches, false);
  assert.deepEqual(comparison.missing, ["Renderer/Sampler.js"]);
});

test("an extra NOTICE entry that the manifest does not declare is a violation too", () => {
  const notice = `${readText("NOTICE")}\n  Renderer/NotARealModule.js   [replace] FR-030\n`;
  const comparison = compareNoticeWithManifest(notice, manifest);
  assert.equal(comparison.matches, false);
  assert.deepEqual(comparison.extra, ["Renderer/NotARealModule.js"]);
});

test("the upstream LICENSE.md is retained verbatim with the deliverable", () => {
  const vendored = fs.readFileSync(repoPath("third_party/cesium-engine/LICENSE.md"));
  const upstream = fs.readFileSync(path.join(REPO_ROOT, "node_modules", "@cesium", "engine", "LICENSE.md"));
  assert.ok(vendored.equals(upstream), "the vendored copy MUST be byte-identical to the installed upstream licence");
  const provenance = readJson("third_party/cesium-engine/PROVENANCE.json");
  assert.equal(provenance.package, "@cesium/engine");
  assert.equal(provenance.version, baseline.version);
  assert.equal(provenance.license, "Apache-2.0");
  assert.match(provenance.sha256, /^sha256-[0-9a-f]{64}$/);
  assert.match(vendored.toString("utf8"), /Copyright 2011-2024 CesiumJS Contributors/);
});

test("every patch-layer file carries the derived-file header convention", () => {
  const report = checkLicenseNotice();
  assert.equal(report.headers.violations.length, 0, JSON.stringify(report.headers.violations));
  assert.equal(report.headers.replacementFiles, manifest.entries.length, "each replacement file MUST be checked");
  assert.ok(report.headers.newModules >= 10, "the new patch-layer modules MUST be checked");

  const replacement = readText("packages/cesium-webgpu/backend-webgpu/Renderer/Context.ts");
  assert.match(replacement, /Copyright 2011-2024 CesiumJS Contributors/);
  assert.match(replacement, /Modified for WebGPU backend/);
  assert.match(replacement, /SPDX-License-Identifier: Apache-2\.0/);
  const newModule = readText("packages/cesium-webgpu/backend-webgpu/webgpu/errors.ts");
  assert.match(newModule, /not derived from any upstream file/);
  assert.match(newModule, /SPDX-License-Identifier: Apache-2\.0/);
});

test("a replacement file stripped of its copyright header is reported", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "license-notice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "packages", "cesium-webgpu", "backend-webgpu", "Renderer", "Context.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export default class Context {}\n", "utf8");

  const report = checkLicenseNotice({ root });
  const messages = report.headers.violations.map((violation) => violation.detail);
  assert.ok(messages.some((message) => /original upstream copyright header/.test(message)));
  assert.ok(messages.some((message) => /Modified for WebGPU backend/.test(message)));
});

test("the license allow-list accepts the workspace's licenses and rejects the forbidden ones", () => {
  for (const license of ["MIT", "Apache-2.0", "ISC", "BSD-3-Clause", "0BSD", "Zlib"]) {
    assert.equal(evaluateLicense(license).accepted, true, `${license} MUST be accepted`);
  }
  assert.equal(evaluateLicense("GPL-3.0-only").accepted, false);
  assert.equal(evaluateLicense("AGPL-3.0-only").accepted, false);
  assert.equal(evaluateLicense("SSPL-1.0").accepted, false);
  assert.equal(evaluateLicense("").accepted, false, "an absent license MUST be rejected");
  assert.equal(evaluateLicense(undefined).accepted, false);
  assert.equal(evaluateLicense("Totally-Made-Up-1.0").accepted, false, "an unknown license MUST be rejected");

  // Compound expressions: at least one allowed branch satisfies an OR, AND requires all operands.
  assert.equal(evaluateLicense("(MPL-2.0 OR Apache-2.0)").accepted, true);
  assert.equal(evaluateLicense("(MIT AND Zlib)").accepted, true);
  assert.equal(evaluateLicense("(MIT AND GPL-3.0-only)").accepted, false);
  assert.equal(evaluateLicense("(GPL-3.0-only OR AGPL-3.0-only)").accepted, false);

  // A copyleft license is tolerated only for a build-time-only dependency.
  assert.equal(evaluateLicense("LGPL-3.0-only", { devDependency: true }).accepted, true);
  assert.equal(evaluateLicense("LGPL-3.0-only", { devDependency: false }).accepted, false);
  assert.equal(evaluateLicense("LGPL-3.0-only").accepted, false, "by default a copyleft license is not accepted");
});

test("every installed package was checked against the allow-list", () => {
  const installed = readInstalledLicenses(REPO_ROOT);
  assert.ok(installed.length >= 50, `expected the full installed tree, got ${installed.length} package(s)`);
  const report = checkLicenseNotice();
  assert.equal(report.dependencies.checked, installed.length);
  assert.equal(report.dependencies.allowed, installed.length);
  assert.equal(report.dependencies.violations.length, 0);

  // The three dependencies T040 names explicitly, read from node_modules rather than assumed.
  const byName = new Map(report.dependencies.table.map((row) => [row.name, row]));
  assert.equal(byName.get("@cesium/engine").license, "Apache-2.0");
  assert.equal(byName.get("@cesium/engine").version, "26.3.0");
  assert.equal(byName.get("@rollup/plugin-commonjs").license, "MIT");
  assert.equal(byName.get("@rollup/plugin-commonjs").version, "29.0.3");
  assert.equal(byName.get("@rollup/plugin-commonjs").buildTimeOnly, true);
  assert.equal(byName.get("yaml").license, "ISC");
  for (const name of ["rollup", "@rollup/plugin-typescript", "@rollup/plugin-node-resolve", "rollup-plugin-dts", "typescript", "@webgpu/types", "playwright"]) {
    assert.ok(byName.has(name), `the allow-list check MUST cover ${name}`);
    assert.ok(byName.get(name).accepted, `${name} MUST be accepted`);
  }
  assert.deepEqual(report.dependencies.buildTimeOnlyCopyleft, ["rollup-plugin-dts@6.5.1 (LGPL-3.0-only)"]);
});

test("the gate exits non-zero on an incomplete delivery", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "license-notice-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "packages", "cesium-webgpu", "backend-webgpu"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "fixture", license: "MIT" })}\n`, "utf8");

  const { code, stderr } = runChecker(["--root", root, "--out", path.join(root, "artifacts", "license-notice.json")]);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /violation/);
});
