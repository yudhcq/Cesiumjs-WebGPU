#!/usr/bin/env node
/**
 * T033 — patch-scope audit (`PatchScopeAudit`, data-model.md §1.3 / contract §4).
 *
 * Machine proof that the controlled fork stayed inside the render backend layer:
 *
 *   baselineVersion           upstream release the audit is about
 *   integrityOk               the installed package is byte-identical to the recorded baseline
 *   manifestPathsValid        every `upstreamModule` matches `^Renderer/[A-Za-z0-9_]+\.js$`
 *   aliasWhitelistExhaustive  rewritten set == manifest set (no miss, no extra)
 *   logicLayerOverrides       repo-owned modules substituting upstream modules OUTSIDE Renderer/**
 *                             (MUST be 0 — SC-010)
 *   keptModulesUnchanged      every non-listed Renderer module still has the recorded hash
 *   verdict                   `pass` only when every boolean holds and logicLayerOverrides === 0
 *
 * Usage:
 *   node tools/audit-patch-scope.mjs [--root <dir>] [--manifest <file>] [--engine-root <dir>] [--out <file>]
 *
 * Exit codes: 0 pass, 1 fail (any boolean false or logicLayerOverrides > 0), 2 misconfiguration.
 * The audit JSON MUST be archived as a CI artifact (principle V).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  MANIFEST_PATH,
  REPO_ROOT,
  listEngineModules,
  readPatchManifest,
  toPosix,
  validatePatchManifest,
} from "./lib/patch-layer.mjs";
import { verifyUpstreamIntegrity } from "./scripts/verify-upstream-integrity.mjs";
import { checkKeptModules } from "./scripts/gen-kept-hash.mjs";
import { whitelistExhaustiveCheck } from "./rollup-plugin-engine-patch.mjs";

function parseArgv(argv) {
  const options = { root: REPO_ROOT, manifest: null, engineRoot: null, out: null, quiet: false };
  const takesValue = new Set(["--root", "--manifest", "--engine-root", "--out"]);
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
    else if (key === "--manifest") options.manifest = path.resolve(value);
    else if (key === "--engine-root") options.engineRoot = path.resolve(value);
    else options.out = value;
  }
  return options;
}

/** Bundle provenance artifacts written by `tools/rollup-plugin-build-provenance.mjs`. */
export function readBuildProvenance(root) {
  const dir = path.join(root, "artifacts");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("build-provenance.") && name.endsWith(".json"))
    .sort()
    .map((name) => ({ file: toPosix(path.relative(root, path.join(dir, name))), report: JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) }));
}

/**
 * Repository-owned modules that shadow an upstream module OUTSIDE `Renderer/**`.
 *
 * Two sources feed this count, and both are reported:
 *   - the manifest: a `localFile` outside `Renderer/` that maps onto an existing upstream module;
 *   - the bundles: a repository module in the module graph (recorded by the provenance plugin)
 *     whose path resolves to an upstream module outside `Renderer/**`.
 */
export function findLogicLayerOverrides({ root, manifest, engineRoot, provenance }) {
  const localRoot = path.join(root, "packages", "cesium-webgpu", "backend-webgpu");
  const engineModules = new Set(listEngineModules(engineRoot));
  const overrides = [];

  for (const entry of manifest?.entries ?? []) {
    const localFile = entry?.localFile;
    if (typeof localFile !== "string" || localFile.startsWith("Renderer/")) continue;
    if (engineModules.has(localFile)) {
      overrides.push({ source: "manifest", module: entry.upstreamModule, localFile, detail: "manifest replacement outside Renderer/**" });
    }
  }

  for (const { file, report } of provenance) {
    for (const module_ of [...(report.repoModules ?? []), ...(report.patchLayerModules ?? [])]) {
      const normalised = toPosix(module_);
      const marker = "/backend-webgpu/";
      const index = normalised.indexOf(marker);
      const raw = index >= 0 ? normalised.slice(index + marker.length) : normalised;
      // Replacements are TypeScript/JavaScript modules with the upstream module's basename, so the
      // candidate is normalised to the upstream addressing (`X.ts` → `X.js`) before the lookup.
      const candidate = raw.replace(/\.(ts|mts|cts|js|mjs|cjs)$/, ".js");
      if (candidate.startsWith("Renderer/")) continue;
      if (!engineModules.has(candidate)) continue;
      overrides.push({ source: "bundle", module: candidate, artifact: file, detail: "bundle contains a repository module shadowing an upstream module outside Renderer/**" });
    }
  }

  const unique = new Map(overrides.map((entry) => [`${entry.module}|${entry.source}|${entry.artifact ?? ""}`, entry]));
  return [...unique.values()];
}

/**
 * Run the full patch-scope audit.
 *
 * @param {object} [options]
 * @param {string} [options.root] repository root (fixtures pass their own)
 * @param {string} [options.manifestPath] absolute replacement-manifest path
 * @param {string} [options.engineRoot] installed `@cesium/engine` root
 */
export function auditPatchScope(options = {}) {
  const root = options.root ? path.resolve(options.root) : REPO_ROOT;
  const manifestPath = options.manifestPath
    ? path.resolve(options.manifestPath)
    : path.join(root, ...MANIFEST_PATH.split("/"));
  const manifest = readPatchManifest(root, manifestPath);
  const localRoot = path.dirname(manifestPath);
  const engineRoot = options.engineRoot ?? path.join(root, "node_modules", "@cesium", "engine");

  const report = {
    tool: "audit-patch-scope",
    generatedAt: new Date().toISOString(),
    root: toPosix(root),
    manifestPath: toPosix(path.relative(root, manifestPath)) || toPosix(manifestPath),
    baselineVersion: manifest?.baseline?.version ?? null,
    integrityOk: false,
    manifestPathsValid: false,
    aliasWhitelistExhaustive: false,
    logicLayerOverrides: 0,
    keptModulesUnchanged: false,
    verdict: "fail",
    evidence: {},
  };

  if (manifest === null) {
    report.evidence.manifest = `replacement manifest not found: ${report.manifestPath}`;
    return report;
  }

  // 1) integrity: installed package vs recorded baseline (T030). A required check that never ran
  //    counts as failing — a missing baseline record MUST NOT look like "nothing wrong".
  const integrity = verifyUpstreamIntegrity({ root, engineRoot });
  const requiredChecks = ["engine-installed", "installed-version", "installed-license", "integrity-matches-lockfile", "source-unchanged"];
  const failing = requiredChecks.filter((id) => integrity.checks.find((entry) => entry.id === id)?.ok !== true);
  report.integrityOk = failing.length === 0;
  report.evidence.integrity = { verdict: integrity.verdict, required: requiredChecks, failing, sourceAggregate: integrity.source?.computed?.aggregate ?? null };

  // 2) patch boundary: `upstreamModule` values (and local replacements) stay under Renderer/**.
  const validation = validatePatchManifest(manifest, { engineRoot, localRoot, enforceStubSet: true });
  const boundaryViolations = validation.violations.filter((violation) => violation.rule === "boundary" || violation.rule === "localFile");
  report.manifestPathsValid = boundaryViolations.length === 0;
  report.evidence.manifestPaths = {
    entries: manifest.entries.length,
    violations: validation.violations,
    boundaryViolations,
  };

  // 3) alias whitelist: rewritten set == manifest set (no miss, no extra).
  try {
    const whitelist = whitelistExhaustiveCheck(listEngineModules(engineRoot), { manifestPath, localRoot, engineRoot, quiet: true });
    report.aliasWhitelistExhaustive = whitelist.ok;
    report.evidence.aliasWhitelist = {
      manifestModules: whitelist.manifestModules.length,
      rewritten: whitelist.rewritten.length,
      missing: whitelist.missing,
      extra: whitelist.extra,
    };
  } catch (error) {
    // A manifest that leaves the boundary is rejected by the alias plugin at load time: that is
    // a whitelist failure, never a reason to skip the audit.
    report.aliasWhitelistExhaustive = false;
    report.evidence.aliasWhitelist = { error: error.message };
  }

  // 4) logic-layer overrides: repository modules shadowing upstream modules outside Renderer/**.
  const provenance = readBuildProvenance(root);
  const overrides = findLogicLayerOverrides({ root, manifest, engineRoot, provenance });
  report.logicLayerOverrides = overrides.length;
  report.evidence.logicLayerOverrides = {
    overrides,
    provenanceArtifacts: provenance.map((entry) => entry.file),
    note:
      provenance.length === 0
        ? "no bundle provenance artifact present yet; the count comes from the manifest substitution set (run the build to add the bundle-side half, see tools/scripts/check-build-layer-source.mjs)"
        : "manifest substitution set + bundle module graph",
  };

  // 5) kept modules: everything not listed is still byte-identical upstream.
  const kept = checkKeptModules({ root, manifestPath, engineRoot });
  report.keptModulesUnchanged = kept.ok;
  report.evidence.keptModules = kept.comparison
    ? { count: kept.computed.modules.length, recorded: kept.comparison.recordedAggregate, computed: kept.comparison.computedAggregate, drifted: kept.comparison.drifted, modulesAdded: kept.comparison.modulesAdded, modulesRemoved: kept.comparison.modulesRemoved }
    : { reason: kept.reason };

  const booleans = [report.integrityOk, report.manifestPathsValid, report.aliasWhitelistExhaustive, report.keptModulesUnchanged];
  report.verdict = booleans.every(Boolean) && report.logicLayerOverrides === 0 ? "pass" : "fail";
  return report;
}

function main() {
  let options;
  try {
    options = parseArgv(process.argv.slice(2));
  } catch (error) {
    console.error(`audit-patch-scope: ${error.message}`);
    return 2;
  }

  const report = auditPatchScope({
    root: options.root,
    ...(options.manifest ? { manifestPath: options.manifest } : {}),
    ...(options.engineRoot ? { engineRoot: options.engineRoot } : {}),
  });

  const outPath = options.out ? path.resolve(options.out) : path.join(options.root, "artifacts", "patch-scope-audit.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!options.quiet) {
    console.log(`baselineVersion: ${report.baselineVersion}`);
    console.log(`integrityOk: ${report.integrityOk}`);
    console.log(`manifestPathsValid: ${report.manifestPathsValid}`);
    console.log(`aliasWhitelistExhaustive: ${report.aliasWhitelistExhaustive}`);
    console.log(`logicLayerOverrides: ${report.logicLayerOverrides}`);
    console.log(`keptModulesUnchanged: ${report.keptModulesUnchanged}`);
  }
  if (report.verdict === "pass") {
    console.log(`patch-scope-audit: pass -> ${toPosix(path.relative(options.root, outPath))}`);
    return 0;
  }
  console.error(`patch-scope-audit: fail (logicLayerOverrides=${report.logicLayerOverrides}) -> ${toPosix(path.relative(options.root, outPath))}`);
  return 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = main();
}

export { main };
