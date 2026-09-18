#!/usr/bin/env node
/**
 * T040 — license, notice and derived-file header gate (contract fork-patch-layer §7, AU-5).
 *
 * Five assertions, all machine-checked against the installed tree:
 *
 *   1. `LICENSE` is Apache-2.0 and agrees with the root manifest;
 *   2. `NOTICE` states the upstream attribution, the pinned baseline and lists **exactly** the
 *      modules of `backend-webgpu/manifest.json` (one line per module, kind included);
 *   3. the upstream `LICENSE.md` is retained verbatim with the deliverable
 *      (`third_party/cesium-engine/LICENSE.md`, hash-equal to the installed file);
 *   4. every patch-layer file carries the derived-file header convention (upstream copyright +
 *      "Modified for WebGPU backend" for replacements, "not derived from any upstream file" for
 *      new modules);
 *   5. every installed dependency declares a license the allow-list accepts; GPL/AGPL, unknown
 *      and absent licenses are rejected, and a copyleft license is only tolerated for a
 *      build-time-only dependency with a written justification.
 *
 * Usage:
 *   node tools/scripts/check-license-notice.mjs [--root <dir>] [--out <file>]
 *
 * Exit codes: 0 clean ("no violation"), 1 violation, 2 missing required input.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, toPosix, walkFiles } from "../lib/patch-layer.mjs";

/** Licenses accepted without further justification. */
const ALLOWED_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Zlib",
  "MPL-2.0",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
]);

/**
 * Copyleft licenses tolerated for **build-time-only** dependencies, with the reason.
 * `rollup-plugin-dts` is the only such dependency in this workspace: it bundles the emitted
 * declaration files during `npm run build` and is never part of the shipped product.
 */
const DEV_ONLY_COPYLEFT = new Map([["LGPL-3.0-only", "build-time only: it bundles the emitted .d.ts files and is never shipped in the deliverable"]]);

/** License families that are rejected outright (contract §7 / T040). */
const DENIED_PATTERNS = [/^GPL-/i, /^AGPL-/i, /^SSPL/i, /^BUSL/i, /^UNLICENSED$/i, /^SEE LICENSE IN/i, /^NOASSERTION$/i];

/** Packages whose license T040 requires the allow-list to cover, with their pinned versions. */
const REQUIRED_PACKAGES = [
  { name: "@cesium/engine", license: "Apache-2.0", version: "26.3.0" },
  { name: "@rollup/plugin-commonjs", license: "MIT", version: "29.0.3" },
  { name: "@rollup/plugin-node-resolve", license: "MIT" },
  { name: "@rollup/plugin-typescript", license: "MIT" },
  { name: "yaml", license: "ISC" },
  { name: "rollup", license: "MIT" },
  { name: "rollup-plugin-dts", license: "LGPL-3.0-only" },
  { name: "typescript", license: "Apache-2.0" },
  { name: "@webgpu/types", license: "BSD-3-Clause" },
  { name: "playwright", license: "Apache-2.0" },
];

function parseArgv(argv) {
  const options = { root: REPO_ROOT, out: null, quiet: false };
  const takesValue = new Set(["--root", "--out"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    let value = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (key === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (!takesValue.has(key)) throw new Error(`unknown argument "${arg}"`);
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for "${key}"`);
      i += 1;
    }
    if (key === "--root") options.root = path.resolve(value);
    else options.out = value;
  }
  return options;
}

/**
 * Evaluate one SPDX license expression against the allow-list.
 *
 * `A OR B` is satisfied when one operand is allowed (the consumer may choose);
 * `A AND B` requires every operand to be allowed.
 */
export function evaluateLicense(expression, { devDependency = false } = {}) {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    return { accepted: false, reason: "no license declared" };
  }
  const normalised = expression.replace(/[()]/g, " ").trim();

  const evaluate = (value) => {
    const orParts = value.split(/\s+OR\s+/i).map((part) => part.trim()).filter(Boolean);
    const results = orParts.map((orPart) => {
      const andParts = orPart.split(/\s+AND\s+/i).map((part) => part.trim()).filter(Boolean);
      const andResults = andParts.map((license) => singleLicense(license, devDependency));
      return { license: orPart, accepted: andResults.every((result) => result.accepted), reasons: andResults.filter((result) => !result.accepted).map((result) => result.reason) };
    });
    const accepted = results.some((result) => result.accepted);
    return { accepted, reason: accepted ? "allowed" : results.map((result) => `${result.license}: ${result.reasons.join("; ")}`).join(" | ") };
  };
  return evaluate(normalised);
}

function singleLicense(license, devDependency) {
  if (ALLOWED_LICENSES.has(license)) return { accepted: true, reason: "allowed" };
  if (DEV_ONLY_COPYLEFT.has(license)) {
    return devDependency
      ? { accepted: true, reason: `allowed as a build-time-only dependency (${DEV_ONLY_COPYLEFT.get(license)})` }
      : { accepted: false, reason: `${license} is only tolerated for build-time-only dependencies` };
  }
  if (DENIED_PATTERNS.some((pattern) => pattern.test(license))) return { accepted: false, reason: `denied license family: ${license}` };
  return { accepted: false, reason: `license not in the allow-list: ${license}` };
}

/** Every installed package with its declared license (`node_modules`, scoped and nested). */
export function readInstalledLicenses(root, { nodeModules = "node_modules" } = {}) {
  const packagesRoot = path.join(root, nodeModules);
  const out = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        visit(child);
        continue;
      }
      if (entry.name === ".bin") continue;
      const manifestPath = path.join(child, "package.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          out.push({
            path: toPosix(path.relative(packagesRoot, child)),
            name: manifest.name ?? toPosix(path.relative(packagesRoot, child)),
            version: manifest.version ?? "0.0.0",
            license: manifest.license ?? null,
          });
        } catch {
          out.push({ path: toPosix(path.relative(packagesRoot, child)), name: toPosix(path.relative(packagesRoot, child)), version: "?", license: null });
        }
      }
      visit(path.join(child, "node_modules"));
    }
  };
  visit(packagesRoot);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Header convention of the patch layer (contract §7 "派生文件版权头规范"). */
function checkHeaderConvention(root) {
  const backendRoot = path.join(root, "packages", "cesium-webgpu", "backend-webgpu");
  const violations = [];
  const replacementFiles = walkFiles(path.join(backendRoot, "Renderer"), { extensions: [".ts", ".js", ".mts", ".cts"], base: backendRoot });
  for (const relative of replacementFiles) {
    const text = fs.readFileSync(path.join(backendRoot, relative), "utf8");
    const file = toPosix(path.join("packages", "cesium-webgpu", "backend-webgpu", relative));
    if (!/Copyright 2011-2024 CesiumJS Contributors/.test(text)) violations.push({ file, detail: "derived file MUST keep the original upstream copyright header" });
    if (!/Modified for WebGPU backend/.test(text)) violations.push({ file, detail: 'derived file MUST carry the "Modified for WebGPU backend" note' });
    if (!/SPDX-License-Identifier:\s*Apache-2\.0/.test(text)) violations.push({ file, detail: "derived file MUST declare SPDX-License-Identifier: Apache-2.0" });
  }
  const newModules = walkFiles(path.join(backendRoot, "webgpu"), { extensions: [".ts", ".js", ".mts", ".cts"], base: backendRoot });
  for (const relative of newModules) {
    const text = fs.readFileSync(path.join(backendRoot, relative), "utf8");
    const file = toPosix(path.join("packages", "cesium-webgpu", "backend-webgpu", relative));
    if (!/SPDX-License-Identifier:\s*Apache-2\.0/.test(text)) violations.push({ file, detail: "patch-layer file MUST declare SPDX-License-Identifier: Apache-2.0" });
    if (!/not derived from any upstream file/i.test(text)) violations.push({ file, detail: "a new module MUST state that it is not derived from an upstream file" });
  }
  return { violations, replacementFiles: replacementFiles.length, newModules: newModules.length };
}

/** NOTICE file list vs the replacement manifest. */
export function compareNoticeWithManifest(noticeText, manifest) {
  const listed = [...noticeText.matchAll(/^\s{2}(Renderer\/[A-Za-z0-9_]+\.js)\s+\[([a-z-]+)\]/gm)].map((match) => ({ module: match[1], kind: match[2] }));
  const declared = manifest.entries.map((entry) => ({ module: entry.upstreamModule, kind: entry.kind }));
  const listedSet = new Set(listed.map((item) => item.module));
  const declaredSet = new Set(declared.map((item) => item.module));
  return {
    listedCount: listed.length,
    declaredCount: declared.length,
    missing: declared.filter((item) => !listedSet.has(item.module)).map((item) => item.module),
    extra: listed.filter((item) => !declaredSet.has(item.module)).map((item) => item.module),
    kindMismatch: listed.filter((item) => declaredSet.has(item.module) && declared.find((entry) => entry.module === item.module).kind !== item.kind).map((item) => item.module),
    matches: listed.length === declared.length && listedSet.size === declaredSet.size && [...listedSet].every((module_) => declaredSet.has(module_)),
  };
}

/**
 * Run the license/NOTICE gate.
 *
 * @param {object} [options]
 * @param {string} [options.root] repository root
 */
export function checkLicenseNotice(options = {}) {
  const root = options.root ? path.resolve(options.root) : REPO_ROOT;
  const report = {
    tool: "check-license-notice",
    generatedAt: new Date().toISOString(),
    root: toPosix(root),
    license: { present: false, spdx: null, manifestField: null, violations: [] },
    notice: { present: false, attribution: false, baseline: false, fileListMatches: false, listedCount: 0, declaredCount: 0, missing: [], extra: [], kindMismatch: [] },
    upstreamLicense: { vendored: false, identicalToUpstream: false, sha256: null },
    headers: { replacementFiles: 0, newModules: 0, violations: [] },
    dependencies: { checked: 0, allowed: 0, violations: [], table: [] },
    violations: [],
    conclusion: "",
    verdict: "fail",
  };

  // 1) project license
  const licensePath = path.join(root, "LICENSE");
  if (!fs.existsSync(licensePath)) {
    report.license.violations.push("LICENSE is missing");
  } else {
    report.license.present = true;
    const text = fs.readFileSync(licensePath, "utf8");
    report.license.spdx = /Apache License/.test(text) && /Version 2\.0/.test(text) ? "Apache-2.0" : null;
    if (report.license.spdx !== "Apache-2.0") report.license.violations.push("LICENSE MUST contain the Apache-2.0 text");
    if (!/Copyright \d{4} the cesium-webgpu contributors/.test(text)) report.license.violations.push("LICENSE MUST carry this project's copyright line");
    if (!/CesiumJS Contributors/.test(text)) report.license.violations.push("LICENSE MUST retain the upstream attribution note");
  }
  const rootManifest = fs.existsSync(path.join(root, "package.json")) ? JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) : null;
  report.license.manifestField = rootManifest?.license ?? null;
  if (rootManifest !== null && rootManifest.license !== "Apache-2.0") report.license.violations.push("package.json license MUST be Apache-2.0 (same as upstream)");

  // 2) NOTICE
  const manifestPath = path.join(root, "packages", "cesium-webgpu", "backend-webgpu", "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    report.violations.push("replacement manifest is missing: cannot check the NOTICE file list");
  }
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  const noticePath = path.join(root, "NOTICE");
  if (!fs.existsSync(noticePath)) {
    report.violations.push("NOTICE is missing");
  } else {
    report.notice.present = true;
    const text = fs.readFileSync(noticePath, "utf8");
    report.notice.attribution = /CesiumJS Contributors/.test(text);
    report.notice.baseline = text.includes(manifest?.baseline?.version ?? "\u0000") && text.includes(manifest?.baseline?.integrity ?? "\u0000");
    if (!report.notice.attribution) report.violations.push('NOTICE MUST state that this product includes software developed by CesiumJS Contributors');
    if (!report.notice.baseline) report.violations.push("NOTICE MUST state the upstream baseline version and integrity hash");
    if (manifest !== null) {
      const comparison = compareNoticeWithManifest(text, manifest);
      report.notice.fileListMatches = comparison.matches;
      report.notice.listedCount = comparison.listedCount;
      report.notice.declaredCount = comparison.declaredCount;
      report.notice.missing = comparison.missing;
      report.notice.extra = comparison.extra;
      report.notice.kindMismatch = comparison.kindMismatch;
      if (!comparison.matches) {
        report.violations.push(
          `NOTICE module list MUST equal the manifest set (missing: ${comparison.missing.join(", ") || "none"}; extra: ${comparison.extra.join(", ") || "none"})`,
        );
      }
      if (comparison.kindMismatch.length > 0) report.violations.push(`NOTICE kind annotations MUST match the manifest: ${comparison.kindMismatch.join(", ")}`);
    }
  }

  // 3) upstream licence retained
  const provenancePath = path.join(root, "third_party", "cesium-engine", "PROVENANCE.json");
  const vendoredPath = path.join(root, "third_party", "cesium-engine", "LICENSE.md");
  const upstreamPath = path.join(root, "node_modules", "@cesium", "engine", "LICENSE.md");
  if (!fs.existsSync(vendoredPath) || !fs.existsSync(provenancePath)) {
    report.violations.push("the upstream LICENSE.md MUST be retained with the deliverable (third_party/cesium-engine/LICENSE.md + PROVENANCE.json)");
  } else {
    report.upstreamLicense.vendored = true;
    const vendored = fs.readFileSync(vendoredPath);
    const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
    report.upstreamLicense.sha256 = provenance.sha256 ?? null;
    if (fs.existsSync(upstreamPath)) {
      report.upstreamLicense.identicalToUpstream = vendored.equals(fs.readFileSync(upstreamPath));
      if (!report.upstreamLicense.identicalToUpstream) report.violations.push("the vendored upstream LICENSE.md MUST be byte-identical to the installed upstream file");
    } else {
      report.violations.push("the installed upstream package is missing; run npm ci before the license gate");
    }
  }

  // 4) derived-file headers
  const headers = checkHeaderConvention(root);
  report.headers = headers;
  if (headers.violations.length > 0) {
    report.violations.push(...headers.violations.map((violation) => `${violation.file}: ${violation.detail}`));
  }

  // 5) dependency licenses
  const installed = readInstalledLicenses(root);
  const rootDevDependencies = new Set(Object.keys(rootManifest?.devDependencies ?? {}));
  const rootRuntimeDependencies = new Set([
    ...Object.keys(rootManifest?.dependencies ?? {}),
    ...Object.keys(rootManifest?.optionalDependencies ?? {}),
  ]);
  const workspaceRuntimeDependencies = new Set();
  const packagesRoot = path.join(root, "packages");
  if (fs.existsSync(packagesRoot)) {
    for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageManifest = path.join(packagesRoot, entry.name, "package.json");
      if (!fs.existsSync(packageManifest)) continue;
      const parsed = JSON.parse(fs.readFileSync(packageManifest, "utf8"));
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        for (const name of Object.keys(parsed[field] ?? {})) workspaceRuntimeDependencies.add(name);
      }
    }
  }
  /** A package is build-time only when it is a root devDependency and no shipped package depends on it. */
  const isBuildTimeOnly = (name) => rootDevDependencies.has(name) && !rootRuntimeDependencies.has(name) && !workspaceRuntimeDependencies.has(name);
  for (const pkg of installed) {
    const evaluation = evaluateLicense(pkg.license, { devDependency: isBuildTimeOnly(pkg.name) });
    report.dependencies.table.push({
      path: pkg.path,
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      buildTimeOnly: isBuildTimeOnly(pkg.name),
      accepted: evaluation.accepted,
      reason: evaluation.reason,
    });
    if (!evaluation.accepted) report.dependencies.violations.push(`${pkg.name}@${pkg.version}: ${evaluation.reason}`);
  }
  report.dependencies.checked = installed.length;
  report.dependencies.allowed = report.dependencies.table.filter((row) => row.accepted).length;
  report.dependencies.buildTimeOnlyCopyleft = report.dependencies.table.filter((row) => row.accepted && DEV_ONLY_COPYLEFT.has(row.license)).map((row) => `${row.name}@${row.version} (${row.license})`);
  report.violations.push(...report.dependencies.violations);

  for (const required of REQUIRED_PACKAGES) {
    const installedPackage = installed.find((pkg) => pkg.name === required.name && pkg.path === required.name);
    if (installedPackage === undefined) {
      report.violations.push(`required dependency "${required.name}" is not installed`);
      continue;
    }
    if (installedPackage.license !== required.license) {
      report.violations.push(`${required.name} declares "${installedPackage.license}", the allow-list expects "${required.license}"`);
    }
    if (required.version !== undefined && installedPackage.version !== required.version) {
      report.violations.push(`${required.name} is installed at ${installedPackage.version}, expected the pinned ${required.version}`);
    }
  }
  // The CJS interop plugin is authorised for build-time use only (G-1 finding F-1, condition 2).
  const cjs = installed.find((pkg) => pkg.name === "@rollup/plugin-commonjs");
  if (cjs === undefined) {
    report.violations.push("@rollup/plugin-commonjs MUST be installed (G-1 finding F-1)");
  } else if (Object.keys(rootManifest?.dependencies ?? {}).includes("@rollup/plugin-commonjs")) {
    report.violations.push("@rollup/plugin-commonjs MUST stay a devDependency (never a runtime dependency)");
  }

  report.verdict = report.violations.length === 0 ? "pass" : "fail";
  report.conclusion =
    report.verdict === "pass"
      ? `Apache-2.0 delivery is complete: LICENSE + NOTICE (${report.notice.listedCount} modules, one-to-one with the patch manifest), upstream LICENSE.md retained verbatim (${report.upstreamLicense.sha256}), ` +
        `${report.headers.replacementFiles} derived file(s) and ${report.headers.newModules} new patch-layer file(s) carry the header convention, and all ${report.dependencies.checked} installed package(s) declare a license the allow-list accepts ` +
        `(denied outright: GPL/AGPL/SSPL/unknown; LGPL-3.0-only tolerated for the build-time-only rollup-plugin-dts).`
      : `${report.violations.length} license/NOTICE violation(s) MUST be fixed before the delivery is Apache-2.0 compliant.`;
  return report;
}

function main() {
  let options;
  try {
    options = parseArgv(process.argv.slice(2));
  } catch (error) {
    console.error(`check-license-notice: ${error.message}`);
    return 2;
  }

  const report = checkLicenseNotice({ root: options.root });
  const outPath = options.out ? path.resolve(options.out) : path.join(options.root, "artifacts", "license-notice.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!options.quiet) {
    console.log(`LICENSE: ${report.license.spdx ?? "(none)"} (package.json: ${report.license.manifestField ?? "(none)"})`);
    console.log(`NOTICE: ${report.notice.listedCount} module(s) listed, manifest declares ${report.notice.declaredCount}, match=${report.notice.fileListMatches}`);
    console.log(`upstream LICENSE.md retained verbatim: ${report.upstreamLicense.identicalToUpstream}`);
    console.log(`patch-layer headers: ${report.headers.replacementFiles} derived, ${report.headers.newModules} new`);
    console.log(`dependency licenses: ${report.dependencies.allowed}/${report.dependencies.checked} accepted`);
  }
  if (report.verdict === "pass") {
    console.log("no violation");
    console.log(`license-notice: pass -> ${toPosix(path.relative(options.root, outPath))}`);
    return 0;
  }
  for (const violation of report.violations) console.error(`  - ${violation}`);
  console.error(`license-notice: ${report.violations.length} violation(s) -> ${toPosix(path.relative(options.root, outPath))}`);
  return 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = main();
}

export { main };
