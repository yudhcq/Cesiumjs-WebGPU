#!/usr/bin/env node
/**
 * T034 — build-product audit: the logic layer still comes from upstream (SC-010, principle V).
 *
 * This is the post-build half of the patch-scope proof. It consumes the provenance artifacts
 * written by `tools/rollup-plugin-build-provenance.mjs` during `node tools/scripts/run.mjs build`
 * and asserts:
 *
 *   - the bundle's upstream modules are the installed `node_modules/@cesium/engine/Source/**`
 *     originals (recorded as `engine-source` provenance, never a repository copy);
 *   - `logicLayerOverrides === 0`: no repository-owned module in the delivered graph shadows an
 *     upstream module outside `Renderer/**` (an injected `Scene/Scene.js` fails here);
 *   - every manifest `localFile` exists and stays under `Renderer/` (T037 + T041).
 *
 * Usage:
 *   node tools/scripts/check-build-layer-source.mjs [--root <dir>] [--engine-root <dir>] [--out <file>]
 *
 * Exit codes: 0 clean (prints `logicLayerOverrides: 0`), 1 a violation, 2 no build artifact yet.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  MANIFEST_PATH,
  REPO_ROOT,
  listEngineModules,
  readPatchManifest,
  resolveLocalFile,
  toPosix,
} from "../lib/patch-layer.mjs";
import { findLogicLayerOverrides, readBuildProvenance } from "../audit-patch-scope.mjs";

function parseArgv(argv) {
  const options = { root: REPO_ROOT, engineRoot: null, out: null, quiet: false };
  const takesValue = new Set(["--root", "--engine-root", "--out"]);
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
    else if (key === "--engine-root") options.engineRoot = path.resolve(value);
    else options.out = value;
  }
  return options;
}

/**
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {string} [options.engineRoot]
 * @param {boolean} [options.requireProvenance] fail when no bundle provenance artifact exists
 */
export function checkBuildLayerSource(options = {}) {
  const root = options.root ? path.resolve(options.root) : REPO_ROOT;
  const engineRoot = options.engineRoot ?? path.join(root, "node_modules", "@cesium", "engine");
  const manifestPath = options.manifestPath ? path.resolve(options.manifestPath) : path.join(root, ...MANIFEST_PATH.split("/"));
  const manifest = readPatchManifest(root, manifestPath);
  const localRoot = path.dirname(manifestPath);
  const provenance = readBuildProvenance(root);

  const report = {
    tool: "check-build-layer-source",
    generatedAt: new Date().toISOString(),
    root: toPosix(root),
    manifestPath: toPosix(path.relative(root, manifestPath)) || toPosix(manifestPath),
    provenance: {
      artifacts: provenance.map((entry) => entry.file),
      moduleCounts: Object.fromEntries(provenance.map((entry) => [entry.file, entry.report.counts ?? {}])),
      engineModulesEmbedded: provenance.reduce((sum, entry) => sum + (entry.report.engineModuleCount ?? 0), 0),
    },
    manifestLocalFiles: { declared: 0, missing: [], outsideRenderer: [] },
    logicLayerOverrides: 0,
    verdict: "fail",
    violations: [],
  };

  if (manifest === null) {
    report.violations.push(`replacement manifest not found: ${report.manifestPath}`);
    return report;
  }
  for (const entry of manifest.entries ?? []) {
    const resolved = resolveLocalFile(entry, localRoot);
    report.manifestLocalFiles.declared += 1;
    if (resolved === null) {
      report.manifestLocalFiles.missing.push(entry.localFile);
      continue;
    }
    const relative = toPosix(path.relative(localRoot, resolved));
    if (!relative.startsWith("Renderer/")) report.manifestLocalFiles.outsideRenderer.push(relative);
  }

  const overrides = findLogicLayerOverrides({ root, manifest, engineRoot, provenance });
  report.logicLayerOverrides = overrides.length;
  report.overrides = overrides;

  for (const localFile of report.manifestLocalFiles.missing) report.violations.push(`manifest localFile does not exist yet: ${localFile}`);
  for (const localFile of report.manifestLocalFiles.outsideRenderer) report.violations.push(`manifest localFile lives outside Renderer/: ${localFile}`);
  for (const override of overrides) report.violations.push(`logicLayerOverride (${override.source}): ${override.module}${override.artifact ? ` in ${override.artifact}` : ""}`);
  if (provenance.length === 0 && options.requireProvenance !== false) {
    report.violations.push("no bundle provenance artifact: run `node tools/scripts/run.mjs build` first (the audit MUST NOT pass vacuously)");
  }
  // The patch layer may only ever shadow modules the upstream package actually ships under
  // Renderer/**; a stale entry (module gone upstream) is reported instead of being ignored.
  const engineModules = new Set(listEngineModules(engineRoot));
  for (const entry of manifest.entries ?? []) {
    if (!engineModules.has(entry.upstreamModule)) report.violations.push(`manifest entry ${entry.upstreamModule} does not exist in the installed upstream package`);
  }

  report.verdict = report.violations.length === 0 ? "pass" : "fail";
  return report;
}

function main() {
  let options;
  try {
    options = parseArgv(process.argv.slice(2));
  } catch (error) {
    console.error(`check-build-layer-source: ${error.message}`);
    return 2;
  }

  const report = checkBuildLayerSource({
    root: options.root,
    ...(options.engineRoot ? { engineRoot: options.engineRoot } : {}),
  });

  const outPath = options.out ? path.resolve(options.out) : path.join(options.root, "artifacts", "build-layer-source.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!options.quiet) {
    console.log(`provenance artifacts: ${report.provenance.artifacts.length}`);
    console.log(`upstream modules in bundles: ${report.provenance.engineModulesEmbedded}`);
    console.log(`manifest local files: ${report.manifestLocalFiles.declared}`);
    console.log(`logicLayerOverrides: ${report.logicLayerOverrides}`);
  }

  if (report.verdict === "pass") {
    console.log(`build-layer-source: pass -> ${toPosix(path.relative(options.root, outPath))}`);
    return 0;
  }
  const missingProvenance = report.violations.some((violation) => violation.startsWith("no bundle provenance artifact"));
  for (const violation of report.violations) console.error(`  - ${violation}`);
  if (missingProvenance) {
    console.error(`build-layer-source: cannot run yet (no build artifact) -> ${toPosix(path.relative(options.root, outPath))}`);
    return 2;
  }
  console.error(`build-layer-source: ${report.violations.length} violation(s) -> ${toPosix(path.relative(options.root, outPath))}`);
  return 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = main();
}

export { main };
