#!/usr/bin/env node
/**
 * T036 — upgrade (rebase) drill, dry-run mode (contract fork-patch-layer §6, principle I).
 *
 * An upgrade is accepted only when **three elements** hold together:
 *   1. the patch-scope audit still passes (the patch stayed inside the render backend layer);
 *   2. the interface manifest shows no drift against the committed baseline;
 *   3. the offline verification battery passes (dependency integrity, kept modules, license/NOTICE,
 *      architecture boundaries, build-layer provenance).
 *
 * The dry run is offline by construction: it re-reads the committed manifest, the committed
 * interface baseline and the installed tree — no network, no upstream tarball, no GPU suites. The
 * two-path contract/visual/benchmark runs cannot execute here; they are reported explicitly in
 * `deferredVerification` and, in `--dry-run`, they are not silently assumed to have passed: a
 * `pass` verdict requires every element to be *complete*, so a battery entry that could not run
 * (exit 2, e.g. the build has not produced provenance yet) fails the drill with a clear message.
 *
 * `--to=<version> --full` (fetch a new upstream tarball outside the repository, re-generate the
 * interface manifest, run the full two-path verification) belongs to the upgrade PR and is NOT
 * implemented in this increment: the flags are rejected loudly instead of being ignored.
 *
 * Usage:
 *   node tools/upgrade-drill.mjs --dry-run [--root <dir>] [--out <file>]
 *
 * Exit codes: 0 pass, 1 fail (a missing element or a failing verification), 2 misconfiguration.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, REPLACE_MODULES, toPosix } from "./lib/patch-layer.mjs";
import { auditPatchScope } from "./audit-patch-scope.mjs";
import { buildInterfaceManifest, compareInterfaceManifests } from "./gen-interface-manifest.mjs";
import { checkKeptModules } from "./scripts/gen-kept-hash.mjs";

/** Verification kinds of `UpgradeDrillRecord.verification[]`. */
export const VERIFICATION_KINDS = ["patch-scope", "interface-consistency", "full-verification"];

/** Suites that cannot run offline/without a device; reported, never assumed to have passed. */
export const DEFERRED_VERIFICATION = [
  { suite: "contract:webgpu", reason: "needs a real device (independent process, one backend per run)" },
  { suite: "contract:webgl2", reason: "needs a real browser context (independent process, one backend per run)" },
  { suite: "visual", reason: "pixel comparison needs both backends in separate runs" },
  { suite: "benchmark", reason: "frame-time sampling needs a real device" },
];

/**
 * The offline verification battery: commands that MUST run in every dry run.
 *
 * `node --test tests/unit/**` is deliberately absent — the drill is invoked from those very tests,
 * so spawning the suite would recurse. Its content is covered by CI's unit gate (already run
 * before the audit stage).
 */
export const OFFLINE_BATTERY = [
  { id: "upstream-integrity", command: ["tools/scripts/verify-upstream-integrity.mjs"], requirementRef: "FR-032 (AU-2)" },
  { id: "kept-modules", command: ["tools/scripts/gen-kept-hash.mjs", "--check"], requirementRef: "contract §2 rule 4 (AU-3)" },
  { id: "license-notice", command: ["tools/scripts/check-license-notice.mjs"], requirementRef: "FR-024 (AU-5)" },
  { id: "arch-boundaries", command: ["tools/scripts/check-arch-boundaries.mjs", "--rules", "A1,A2,A3,A4,A9"], requirementRef: "data-model §11" },
  { id: "build-layer-source", command: ["tools/scripts/check-build-layer-source.mjs"], requirementRef: "SC-010 (AU-4)" },
];

function parseArgv(argv) {
  const options = { mode: null, root: REPO_ROOT, out: null, to: null, quiet: false };
  const takesValue = new Set(["--root", "--out", "--to"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    let value = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (key === "--dry-run") {
      options.mode = "dry-run";
      continue;
    }
    if (key === "--full") {
      options.mode = "full";
      continue;
    }
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
    else if (key === "--to") options.to = value;
    else options.out = value;
  }
  return options;
}

/** Estimated adaptation effort of an upgrade, from the size of the interface diff. */
export function estimateEffort(diff) {
  const changes =
    (diff?.changedRenderModules?.length ?? 0) + (diff?.addedModules?.length ?? 0) + (diff?.removedModules?.length ?? 0) + (diff?.driftedKeptModules?.length ?? 0);
  const breaking = diff?.breakingConsumedMembers?.length ?? 0;
  if (changes === 0 && breaking === 0) return "none";
  if (changes <= 2 && breaking === 0) return "low";
  if (changes <= 5 && breaking <= 2) return "medium";
  return "high";
}

/** Run one command in a child process and normalise its outcome. */
function runCommand(command, { root }) {
  // Only the script path is resolved against the (possibly fixture) root; flags and values pass through.
  const args = command.map((part) => (part.endsWith(".mjs") || part.startsWith("tools/") ? path.join(root, ...part.split("/")) : part));
  const result = spawnSync(process.execPath, args, { encoding: "utf8", cwd: root });
  return {
    exitCode: result.status ?? -1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

/**
 * Run the drill.
 *
 * @param {object} [options]
 * @param {"dry-run"|"full"} [options.mode]
 * @param {string} [options.root]
 * @param {string} [options.to] target version (full mode only)
 * @param {boolean} [options.skipBattery] test hook: run only the two non-spawning elements
 */
export function runUpgradeDrill(options = {}) {
  const root = options.root ? path.resolve(options.root) : REPO_ROOT;
  const mode = options.mode ?? "dry-run";
  const record = {
    tool: "upgrade-drill",
    mode,
    ranAt: new Date().toISOString(),
    root: toPosix(root),
    baselineVersion: null,
    targetVersion: null,
    diff: null,
    verification: [],
    deferredVerification: [...DEFERRED_VERIFICATION],
    requirements: { "patch-scope": false, "interface-consistency": false, "full-verification": false },
    verdict: "fail",
    notes: "",
  };

  // ---- element 1: patch scope -------------------------------------------------------------
  const scope = auditPatchScope({ root });
  record.baselineVersion = scope.baselineVersion;
  record.targetVersion = options.to ?? scope.baselineVersion;
  record.verification.push({
    kind: "patch-scope",
    id: "audit-patch-scope",
    command: "node tools/audit-patch-scope.mjs",
    status: scope.verdict === "pass" ? "pass" : "fail",
    evidence: {
      verdict: scope.verdict,
      logicLayerOverrides: scope.logicLayerOverrides,
      integrityOk: scope.integrityOk,
      manifestPathsValid: scope.manifestPathsValid,
      aliasWhitelistExhaustive: scope.aliasWhitelistExhaustive,
      keptModulesUnchanged: scope.keptModulesUnchanged,
    },
  });
  record.requirements["patch-scope"] = scope.verdict === "pass";

  // ---- element 2: interface consistency ---------------------------------------------------
  const interfacePath = path.join(root, "upstream", "interface-manifest.json");
  let interfaceDiff = {
    fromVersion: record.baselineVersion,
    toVersion: record.targetVersion,
    changedRenderModules: [],
    addedModules: [],
    removedModules: [],
    breakingConsumedMembers: [],
    affectedReplacements: [],
    estimatedEffort: "none",
  };
  if (!fs.existsSync(interfacePath)) {
    record.verification.push({
      kind: "interface-consistency",
      id: "interface-manifest",
      command: "node tools/gen-interface-manifest.mjs --check",
      status: "fail",
      evidence: { reason: `committed interface baseline missing: ${toPosix(path.relative(root, interfacePath))}` },
    });
  } else {
    const baseline = JSON.parse(fs.readFileSync(interfacePath, "utf8"));
    const generated = buildInterfaceManifest({ root });
    const diff = compareInterfaceManifests(baseline, generated);
    const affectedReplacements = [...new Set(diff.changedRenderModules.filter((module_) => REPLACE_MODULES.includes(module_)))];
    interfaceDiff = {
      fromVersion: baseline.baselineVersion ?? record.baselineVersion,
      toVersion: generated.baselineVersion,
      changedRenderModules: diff.changedRenderModules,
      addedModules: diff.addedModules,
      removedModules: diff.removedModules,
      breakingConsumedMembers: diff.breakingConsumedMembers,
      affectedReplacements,
      estimatedEffort: estimateEffort(diff),
    };
    record.verification.push({
      kind: "interface-consistency",
      id: "interface-manifest",
      command: "node tools/gen-interface-manifest.mjs --check",
      status: diff.drifted ? "fail" : "pass",
      evidence: { digest: generated.digest, baselineDigest: baseline.digest, changedRenderModules: diff.changedRenderModules, breakingConsumedMembers: diff.breakingConsumedMembers.length },
    });
    record.requirements["interface-consistency"] = !diff.drifted;
  }

  // Kept-module drift is part of the upgrade diff (upstream changed a file we still depend on).
  const kept = checkKeptModules({ root });
  const driftedKeptModules = kept.comparison?.drifted ?? [];
  interfaceDiff.driftedKeptModules = driftedKeptModules;
  interfaceDiff.affectedReplacements = [...new Set([...interfaceDiff.affectedReplacements, ...(kept.comparison?.modulesRemoved ?? [])])];
  interfaceDiff.estimatedEffort = estimateEffort({ ...interfaceDiff, driftedKeptModules });
  record.diff = interfaceDiff;
  if (driftedKeptModules.length > 0) {
    record.requirements["interface-consistency"] = false;
    record.verification.push({
      kind: "interface-consistency",
      id: "kept-modules",
      command: "node tools/scripts/gen-kept-hash.mjs --check",
      status: "fail",
      evidence: { drifted: driftedKeptModules },
    });
  }

  // ---- element 3: offline verification battery --------------------------------------------
  if (options.skipBattery !== true) {
    for (const item of OFFLINE_BATTERY) {
      const scriptPath = path.join(root, ...item.command[0].split("/"));
      if (!fs.existsSync(scriptPath)) {
        record.verification.push({
          kind: "full-verification",
          id: item.id,
          command: `node ${item.command.join(" ")}`,
          requirementRef: item.requirementRef,
          status: "cannot-run",
          evidence: { reason: `tool not present in this tree: ${toPosix(path.relative(root, scriptPath))}` },
        });
        record.requirements["full-verification"] = false;
        continue;
      }
      const outcome = runCommand(item.command, { root });
      const status = outcome.exitCode === 0 ? "pass" : outcome.exitCode === 2 ? "cannot-run" : "fail";
      record.verification.push({
        kind: "full-verification",
        id: item.id,
        command: `node ${item.command.join(" ")}`,
        requirementRef: item.requirementRef,
        status,
        exitCode: outcome.exitCode,
        evidence: { stdout: outcome.stdout.split(/\r?\n/).slice(-3).join(" | "), stderr: outcome.stderr.split(/\r?\n/).slice(-2).join(" | ") },
      });
      if (status !== "pass") record.requirements["full-verification"] = false;
    }
    const batteryEntries = record.verification.filter((entry) => entry.kind === "full-verification");
    record.requirements["full-verification"] = batteryEntries.length > 0 && batteryEntries.every((entry) => entry.status === "pass");
  } else {
    record.requirements["full-verification"] = true;
  }

  const missing = VERIFICATION_KINDS.filter((kind) => record.requirements[kind] !== true);
  record.verdict = missing.length === 0 ? "pass" : "fail";
  record.notes =
    record.verdict === "pass"
      ? `Three elements complete in ${mode}: patch-scope audit, interface consistency (${record.diff.changedRenderModules.length} changed renderer module(s), effort "${record.diff.estimatedEffort}") and the offline verification battery ` +
        `(${record.verification.filter((entry) => entry.kind === "full-verification").length} command(s)). ${DEFERRED_VERIFICATION.length} GPU-dependent suite(s) are deferred and MUST run in the upgrade PR (--full).`
      : `Element(s) missing or failing: ${missing.join(", ")}. A drill verdict requires the patch-scope audit, the interface consistency check and the full offline verification battery to be complete (contract §6 step 5).`;
  return record;
}

function main() {
  let options;
  try {
    options = parseArgv(process.argv.slice(2));
  } catch (error) {
    console.error(`upgrade-drill: ${error.message}`);
    return 2;
  }
  if (options.mode === null) {
    console.error("upgrade-drill: a mode is required: --dry-run (offline, every commit) or --full (upgrade PR)");
    return 2;
  }
  if (options.mode === "full") {
    console.error(
      "upgrade-drill: --full is NOT implemented in this increment (tasks.md T036: only the dry run is required; the full drill belongs to the upgrade PR). " +
        `Requested target: ${options.to ?? "(none)"}`,
    );
    return 2;
  }

  const record = runUpgradeDrill({ mode: options.mode, root: options.root, ...(options.to === null ? {} : { to: options.to }) });
  const outPath = options.out ? path.resolve(options.out) : path.join(options.root, "artifacts", "upgrade-drill.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  if (!options.quiet) {
    console.log(`mode: ${record.mode}`);
    console.log(`baselineVersion: ${record.baselineVersion} -> targetVersion: ${record.targetVersion}`);
    console.log(`diff: ${record.diff.changedRenderModules.length} changed renderer module(s), ${record.diff.driftedKeptModules.length} drifted kept module(s), effort "${record.diff.estimatedEffort}"`);
    for (const entry of record.verification) console.log(`[${entry.status}] ${entry.kind}/${entry.id}${entry.exitCode === undefined ? "" : ` (exit ${entry.exitCode})`}`);
    for (const entry of record.deferredVerification) console.log(`[deferred] ${entry.suite}: ${entry.reason}`);
  }
  if (record.verdict === "pass") {
    console.log(`upgrade-drill: pass (${record.mode}) -> ${toPosix(path.relative(options.root, outPath))}`);
    return 0;
  }
  console.error(`upgrade-drill: fail (${record.mode}) -> ${toPosix(path.relative(options.root, outPath))}`);
  console.error(record.notes);
  return 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = main();
}

export { main };
