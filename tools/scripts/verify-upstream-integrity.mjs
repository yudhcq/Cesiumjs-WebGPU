#!/usr/bin/env node
/**
 * T030 — upstream integrity check (`@cesium/engine` is consumed exactly as installed).
 *
 * Contract fork-patch-layer.md §1/§4 (AU-2), research §2.4 (mechanism 1/3). The check is the
 * machine proof that "the logic layer is byte-identical by dependency integrity":
 *
 *   1. the installed package version is exactly the pinned baseline version;
 *   2. the recorded npm `integrity` (sha512 SRI) agrees with the committed lockfile;
 *   3. the content hash of `Source/**` agrees with the recorded snapshot — a postinstall
 *      script (or any other byte-level tampering) that rewrites one upstream file fails here;
 *   4. the shader toolchain record is complete and the toolchain never becomes a runtime
 *      dependency (contract §5 rule R8).
 *
 * Nothing is ever written to `node_modules`.
 *
 * Usage:
 *   node tools/scripts/verify-upstream-integrity.mjs [--engine-root <dir>] [--baseline <file>] [--out <file>]
 *   node tools/scripts/verify-upstream-integrity.mjs --record    # (re)pin the Source/** snapshot
 *
 * Exit codes: 0 pass ("no mismatch"), 1 a check failed, 2 misconfiguration / missing input.
 * The report is archived as a CI artifact: `artifacts/upstream-integrity.json`.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BASELINE_PATH,
  REPO_ROOT,
  readJsonFile,
  resolveEngineRoot,
  snapshotEngineSource,
  toPosix,
} from "../lib/patch-layer.mjs";

const TOOLCHAIN_PACKAGES = ["glslang", "naga-cli", "@webgpu/glslang"];

function parseArgv(argv) {
  const options = { root: REPO_ROOT, engineRoot: null, baseline: null, out: null, quiet: false, record: false };
  const takesValue = new Set(["--root", "--engine-root", "--baseline", "--out"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    let value = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (key === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (key === "--record") {
      options.record = true;
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
    else if (key === "--baseline") options.baseline = path.resolve(value);
    else options.out = value;
  }
  return options;
}

/**
 * Record the content snapshot of the installed `Source/**` into the baseline record.
 *
 * This is the only write this tool performs and it never touches `node_modules`: it is the
 * pinning step of T030 ("`Source/**` 目录内容哈希与记录一致"), re-run whenever the pinned
 * upstream version is upgraded.
 */
function recordSourceSnapshot(baselinePath, engineRoot) {
  const baseline = readJsonFile(baselinePath);
  const computed = snapshotEngineSource(engineRoot);
  baseline.sourceSnapshot = {
    algorithm: computed.algorithm,
    aggregate: computed.aggregate,
    fileCount: computed.fileCount,
    totalBytes: computed.totalBytes,
    recordedAt: new Date().toISOString(),
    notes:
      "Aggregate sha256 over `Source/**` (one line per module: POSIX relative path, NUL, per-file sha256). " +
      "Verified by tools/scripts/verify-upstream-integrity.mjs; a single changed byte anywhere under Source/** fails the check. " +
      "Recorded from the unmodified registry install of the pinned release.",
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  return baseline.sourceSnapshot;
}

function check(report, id, ok, detail, evidence) {
  report.checks.push({ id, ok, ...(detail === undefined ? {} : { detail }), ...(evidence === undefined ? {} : { evidence }) });
  return ok;
}

/** Workspace package manifests under `packages/<name>/package.json` — the runtime dependency surface. */
function workspacePackages(root) {
  const packagesRoot = path.join(root, "packages");
  if (!fs.existsSync(packagesRoot)) return [];
  return fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesRoot, entry.name, "package.json"))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file: toPosix(path.relative(root, file)), manifest: readJsonFile(file) }));
}

/**
 * Verify the installed upstream package against the recorded baseline.
 *
 * @param {object} [options]
 * @param {string} [options.root] repository root (fixtures pass their own)
 * @param {string} [options.engineRoot] installed `@cesium/engine` root
 * @param {string} [options.baselinePath] baseline record (default `upstream/engine-26.3.0.lock.json`)
 * @param {Map<string, Buffer>} [options.sourceOverrides] in-memory byte overrides (counterexample)
 * @param {object} [options.lockfile] pre-loaded root lockfile (fixtures)
 */
export function verifyUpstreamIntegrity(options = {}) {
  const root = options.root ? path.resolve(options.root) : REPO_ROOT;
  const baselinePath = options.baselinePath ? path.resolve(options.baselinePath) : path.join(root, ...BASELINE_PATH.split("/"));
  const engineRoot = resolveEngineRoot(options.engineRoot ?? path.join(root, "node_modules", "@cesium", "engine"));

  const report = {
    tool: "verify-upstream-integrity",
    generatedAt: new Date().toISOString(),
    root: toPosix(root),
    engineRoot: toPosix(engineRoot),
    baselinePath: toPosix(path.relative(root, baselinePath)) || toPosix(baselinePath),
    checks: [],
    source: null,
    toolchain: null,
    verdict: "fail",
  };

  if (!fs.existsSync(baselinePath)) {
    check(report, "baseline-record-present", false, `baseline record missing: ${report.baselinePath}`);
    return report;
  }
  const baseline = options.baseline ?? readJsonFile(baselinePath);
  report.baseline = {
    packageName: baseline.packageName,
    version: baseline.version,
    cesiumVersion: baseline.cesiumVersion,
    integrity: baseline.integrity,
    license: baseline.license,
  };
  check(report, "baseline-record-present", true, `${baseline.packageName}@${baseline.version}`);

  const installedManifestPath = path.join(engineRoot, "package.json");
  if (!fs.existsSync(installedManifestPath)) {
    check(report, "engine-installed", false, `@cesium/engine is not installed at ${report.engineRoot} (run npm ci)`);
    return report;
  }
  const installed = readJsonFile(installedManifestPath);
  report.installed = { version: installed.version, license: installed.license };
  check(report, "engine-installed", true, `installed at ${report.engineRoot}`);

  // 1) exact version pin, declared without a range, and the installed copy agrees.
  const packageManifests = workspacePackages(root).filter((entry) => entry.manifest.dependencies?.["@cesium/engine"] !== undefined);
  const declared = packageManifests.map((entry) => entry.manifest.dependencies["@cesium/engine"]);
  const exactPins = declared.filter((value) => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value));
  check(
    report,
    "version-pinned-exact",
    declared.length > 0 && exactPins.length === declared.length && exactPins.every((value) => value === baseline.version),
    `declared ${JSON.stringify(declared)} in ${packageManifests.map((entry) => entry.file).join(", ") || "(no workspace depends on it)"}`,
  );
  check(
    report,
    "installed-version",
    installed.version === baseline.version,
    `installed ${installed.version} vs recorded ${baseline.version}`,
  );
  check(report, "installed-license", installed.license === baseline.license, `installed ${installed.license} vs recorded ${baseline.license}`);

  // 2) the recorded npm integrity hash still resolves to the recorded version.
  const lockfile = options.lockfile ?? (fs.existsSync(path.join(root, "package-lock.json")) ? readJsonFile(path.join(root, "package-lock.json")) : null);
  const locked = lockfile?.packages?.["node_modules/@cesium/engine"];
  check(
    report,
    "integrity-matches-lockfile",
    Boolean(locked) && locked.version === baseline.version && locked.integrity === baseline.integrity,
    locked ? `lockfile integrity ${locked.integrity === baseline.integrity ? "matches" : "differs from"} the record` : "package-lock.json has no @cesium/engine entry",
    locked ? { version: locked.version, integrity: locked.integrity } : undefined,
  );
  check(
    report,
    "integrity-is-sri",
    typeof baseline.integrity === "string" && /^sha512-[A-Za-z0-9+/]+=*$/.test(baseline.integrity),
    "the baseline integrity MUST be a sha512 SRI hash of the published tarball",
  );

  // 3) content hash of Source/** (byte-level tamper detection).
  const computed = snapshotEngineSource(engineRoot, options.sourceOverrides ? { overrides: options.sourceOverrides } : {});
  const recordedSnapshot = baseline.sourceSnapshot ?? null;
  report.source = { recorded: recordedSnapshot, computed };
  if (recordedSnapshot === null) {
    check(report, "source-snapshot-recorded", false, `baseline record has no sourceSnapshot; record it with: node tools/scripts/verify-upstream-integrity.mjs --record`);
  } else {
    check(
      report,
      "source-snapshot-recorded",
      true,
      `${recordedSnapshot.fileCount} file(s), ${recordedSnapshot.totalBytes} byte(s), ${recordedSnapshot.aggregate}`,
    );
    const matches = recordedSnapshot.aggregate === computed.aggregate;
    check(
      report,
      "source-unchanged",
      matches && recordedSnapshot.fileCount === computed.fileCount && recordedSnapshot.totalBytes === computed.totalBytes,
      matches
        ? `Source/** is byte-identical to the record (${computed.aggregate})`
        : `Source/** hash ${computed.aggregate} != recorded ${recordedSnapshot.aggregate}`,
    );
  }

  // 4) shader toolchain record (contract §5 rule R8) + it MUST stay out of the runtime.
  const toolchain = baseline.toolchain ?? {};
  const toolchainOk =
    toolchain.glslang?.version === "16.6.0" &&
    toolchain["naga-cli"]?.version === "30.0.1" &&
    /cargo install naga-cli --version 30\.0\.1 --locked/.test(toolchain["naga-cli"]?.installCommand ?? "") &&
    toolchain["@webgpu/glslang"]?.version === "0.0.15" &&
    toolchain["@webgpu/glslang"]?.entry === "dist/web-devel-onefile";
  check(report, "toolchain-pinned", toolchainOk, `glslang ${toolchain.glslang?.version}, naga-cli ${toolchain["naga-cli"]?.version}, @webgpu/glslang ${toolchain["@webgpu/glslang"]?.version} (${toolchain["@webgpu/glslang"]?.entry})`);
  check(
    report,
    "toolchain-recorded-packages",
    TOOLCHAIN_PACKAGES.every((name) => toolchain[name] !== undefined),
    `recorded: ${TOOLCHAIN_PACKAGES.filter((name) => toolchain[name] !== undefined).join(", ")}`,
  );

  const runtimeViolations = [];
  for (const { file, manifest } of workspacePackages(root)) {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of TOOLCHAIN_PACKAGES) {
        if (manifest[field]?.[name] !== undefined) runtimeViolations.push(`${file}: ${field}.${name}`);
      }
    }
  }
  report.toolchain = { recorded: toolchain, runtimeViolations, installedLocally: TOOLCHAIN_PACKAGES.filter((name) => fs.existsSync(path.join(root, "node_modules", name))) };
  check(
    report,
    "toolchain-not-a-runtime-dependency",
    runtimeViolations.length === 0,
    runtimeViolations.length === 0 ? "the shader toolchain is conversion/CI only (never imported at runtime)" : runtimeViolations.join("; "),
  );

  report.verdict = report.checks.every((entry) => entry.ok) ? "pass" : "fail";
  return report;
}

function main() {
  let options;
  try {
    options = parseArgv(process.argv.slice(2));
  } catch (error) {
    console.error(`verify-upstream-integrity: ${error.message}`);
    return 2;
  }

  let report = verifyUpstreamIntegrity({
    root: options.root,
    ...(options.engineRoot ? { engineRoot: options.engineRoot } : {}),
    ...(options.baseline ? { baselinePath: options.baseline } : {}),
  });

  if (options.record) {
    const baselinePath = options.baseline ?? path.join(options.root, ...BASELINE_PATH.split("/"));
    if (!report.installed) {
      console.error(`verify-upstream-integrity: cannot record a snapshot, @cesium/engine is not installed at ${report.engineRoot}`);
      return 2;
    }
    const snapshot = recordSourceSnapshot(baselinePath, report.engineRoot);
    console.log(
      `upstream-integrity: recorded Source/** snapshot (${snapshot.fileCount} file(s), ${snapshot.totalBytes} byte(s), ${snapshot.aggregate}) in ` +
        `${toPosix(path.relative(options.root, baselinePath))}`,
    );
    // Re-verify against the freshly recorded snapshot so the exit code describes the committed state.
    report = verifyUpstreamIntegrity({
      root: options.root,
      ...(options.engineRoot ? { engineRoot: options.engineRoot } : {}),
      ...(options.baseline ? { baselinePath: options.baseline } : {}),
    });
  }

  const outPath = options.out ? path.resolve(options.out) : path.join(options.root, "artifacts", "upstream-integrity.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!options.quiet) {
    for (const entry of report.checks) console.log(`[${entry.ok ? "ok" : "FAIL"}] ${entry.id}${entry.detail ? ` - ${entry.detail}` : ""}`);
  }
  if (report.verdict === "pass") {
    console.log("no mismatch");
    console.log(
      `upstream-integrity: ${report.baseline.packageName}@${report.baseline.version} intact ` +
        `(${report.source?.computed?.fileCount ?? 0} source file(s)) -> ${toPosix(path.relative(options.root, outPath))}`,
    );
    return 0;
  }
  const failed = report.checks.filter((entry) => !entry.ok).map((entry) => entry.id);
  console.error(`upstream-integrity: ${failed.length} check(s) failed: ${failed.join(", ")} -> ${toPosix(path.relative(options.root, outPath))}`);
  return 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = main();
}

export { main };
