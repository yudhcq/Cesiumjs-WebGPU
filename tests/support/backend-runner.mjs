#!/usr/bin/env node
/**
 * Backend runner for contract / visual / benchmark suites (T013, productised in T108).
 *
 * HARD INVARIANT (constitution v2.0.0, principle II — NON-NEGOTIABLE):
 * a run enables **exactly one** backend, in its own process, with its own page load. There is
 * deliberately NO entry point for "run both", "compare in the same session", "same frame
 * comparison" or "overlay" — cross-backend comparison is performed OFFLINE on artifacts
 * collected by two separate runs (`tests/support/compare-offline.mjs`, T109).
 *
 * Usage:
 *   node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain
 *   node tests/support/backend-runner.mjs --backend=webgl2 --suite-file=tests/contract/x.spec.mjs
 *
 * One run at a time **per machine**: the runner takes `tests/support/suite-lock.mjs` around its suite
 * loop. The invariant above is about a single run, but two runs sharing one GPU distort exactly what
 * the interaction and benchmark suites measure, and both would rebuild the same bundle path — so
 * concurrency is arbitrated rather than merely discouraged.
 *
 * Exit codes: 0 pass, 1 suite failure, 2 invalid invocation / missing suite file.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireSuiteLock } from "./suite-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Where the suite lock lives; inside `artifacts/` because it is runner state, not a source file. */
export function suiteLockPath(root = REPO_ROOT) {
  return path.join(root, "artifacts", ".suite-lock.json");
}

export const BACKENDS = ["webgpu", "webgl2"];

/** Documented `--suite=` -> file mapping (tasks.md "Path Conventions"); T145 keeps it in sync with the docs. */
export const SUITE_MAP = {
  "contract-backend-core": "tests/contract/backend-core.spec.mjs",
  "smoke:scene-construct": "tests/contract/smoke-scene-construct.spec.mjs",
  "smoke:draw-dispatch": "tests/contract/smoke-draw-dispatch.spec.mjs",
  "smoke:present": "tests/contract/smoke-present.spec.mjs",
  "contract:pass-sequence": "tests/contract/pass-sequence.spec.mjs",
  "contract:resources": "tests/contract/resources.spec.mjs",
  "contract:terrain": "tests/contract/terrain.spec.mjs",
  "contract:terrain-ready": "tests/contract/terrain-ready.spec.mjs",
  "contract:terrain-offline": "tests/contract/terrain-offline.spec.mjs",
  "contract:terrain-unavailable": "tests/contract/terrain-unavailable.spec.mjs",
  "contract:interaction": "tests/contract/interaction.spec.mjs",
  "contract:device-lost": "tests/contract/device-lost.spec.mjs",
  "contract:device-lost-terrain": "tests/contract/device-lost-terrain.spec.mjs",
  "contract:fallback": "tests/contract/fallback.spec.mjs",
  "contract:handle": "tests/contract/handle.spec.mjs",
  "contract:status": "tests/contract/status.spec.mjs",
  "contract:whole-switch": "tests/contract/whole-switch.spec.mjs",
  "contract:cross-equivalence": "tests/contract/cross-equivalence.spec.mjs",
  "contract:demo": "tests/contract/demo.spec.mjs",
  "contract:offscreen-depth": "tests/contract/offscreen-depth.spec.mjs",
  "visual:terrain": "tests/visual/terrain-multitile.spec.mjs",
  "visual:terrain-geometry": "tests/visual/terrain-geometry.spec.mjs",
  "visual:terrain-elevation": "tests/visual/terrain-elevation.spec.mjs",
  "visual:texture-origin": "tests/visual/texture-origin.spec.mjs",
  "terrain:probe": "tests/contract/terrain-probe.spec.mjs",
  "terrain:raster-probe": "tests/contract/terrain-raster-probe.spec.mjs",
  "terrain:canvas-depth-probe": "tests/contract/canvas-depth-probe.spec.mjs",
  "bench:terrain": "tests/benchmark/terrain.spec.mjs",
  "bench:shader-variants": "tests/benchmark/shader-variants.spec.mjs",
  "stability:leak": "tests/benchmark/stability-leak.spec.mjs",
};

/** Environment variable the browser side reads to enable one backend (never a caller-side branch). */
export const BACKEND_ENV_VAR = "RENDER_BACKEND";

export class RunnerError extends Error {}

/**
 * Parse and validate runner arguments. Fails loudly on anything that could enable two backends.
 *
 * @param {string[]} argv
 * @returns {{backend: string, suites: string[], suiteFiles: string[], passthrough: string[]}}
 */
export function parseArgs(argv) {
  const parsed = { backend: null, suites: [], suiteFiles: [], passthrough: [] };
  for (const arg of argv) {
    if (arg.startsWith("--backend=")) {
      const value = arg.slice("--backend=".length);
      if (value.includes(",")) {
        throw new RunnerError(
          `--backend accepts exactly one backend (got "${value}"): one run = one backend (principle II). ` +
            "Cross-backend comparison is done offline over two separate runs.",
        );
      }
      if (parsed.backend !== null && parsed.backend !== value) {
        throw new RunnerError(`--backend given twice with different values ("${parsed.backend}" and "${value}")`);
      }
      parsed.backend = value;
    } else if (arg.startsWith("--suite=")) {
      parsed.suites.push(arg.slice("--suite=".length));
    } else if (arg.startsWith("--suite-file=")) {
      parsed.suiteFiles.push(arg.slice("--suite-file=".length));
    } else {
      parsed.passthrough.push(arg);
    }
  }

  if (parsed.backend === null) {
    throw new RunnerError(`--backend=<${BACKENDS.join("|")}> is required; one run enables exactly one backend`);
  }
  if (!BACKENDS.includes(parsed.backend)) {
    throw new RunnerError(`unknown backend "${parsed.backend}"; expected one of ${BACKENDS.join(", ")}`);
  }
  for (const suite of parsed.suites) {
    if (!(suite in SUITE_MAP)) {
      throw new RunnerError(`unknown suite "${suite}"; known suites: ${Object.keys(SUITE_MAP).join(", ")}`);
    }
  }
  if (parsed.suites.length === 0 && parsed.suiteFiles.length === 0) {
    throw new RunnerError("at least one --suite=<name> or --suite-file=<path> is required");
  }
  return parsed;
}

/** Repository-relative spec files selected by the parsed arguments. */
export function resolveSuiteFiles({ suites = [], suiteFiles = [] }) {
  return [...suites.map((suite) => SUITE_MAP[suite]), ...suiteFiles];
}

/**
 * Descriptor of one verification run — mirrors the `VerificationRun` entity (data-model §7.1)
 * and records the isolation mode so a same-session dual-backend run can never be represented.
 */
export function describeRun({ backend, suites = [], suiteFiles = [] }) {
  return {
    runId: `${backend}-${process.pid}-${Date.now()}`,
    backend,
    isolation: "separate-process",
    suiteFiles: resolveSuiteFiles({ suites, suiteFiles }),
    fixedConditions: {
      datasetId: "matterhorn-z0-12",
      baseLayer: false,
      skyBox: false,
      skyAtmosphere: false,
    },
  };
}

function playwrightCli() {
  const cli = path.join(REPO_ROOT, "node_modules", "playwright", "cli.js");
  if (!fs.existsSync(cli)) throw new RunnerError("playwright is not installed (run npm ci)");
  return cli;
}

function runOneSuite(descriptor, suiteFile, passthrough) {
  const absolute = path.isAbsolute(suiteFile) ? suiteFile : path.join(REPO_ROOT, suiteFile);
  if (!fs.existsSync(absolute)) {
    throw new RunnerError(
      `suite file not found: ${suiteFile}. It is registered in SUITE_MAP but not implemented yet ` +
        "(see tasks.md for the task that lands it).",
    );
  }
  // Playwright treats a positional argument as a regex matched against the **test-dir-relative** path,
  // so the suite MUST be passed in that form: an absolute path (and, on Windows, a backslash path)
  // silently matches nothing and the run reports "No tests found".
  const suiteArgument = path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
  const result = spawnSync(process.execPath, [playwrightCli(), "test", suiteArgument, "--reporter=line", ...passthrough], {
    stdio: "inherit",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      [BACKEND_ENV_VAR]: descriptor.backend,
      VERIFICATION_RUN_ID: descriptor.runId,
    },
  });
  if (result.error) throw new RunnerError(`failed to start the suite: ${result.error.message}`);
  return result.status ?? 1;
}

function main(argv) {
  const parsed = parseArgs(argv);
  const descriptor = describeRun(parsed);
  console.log(
    `backend-runner: backend=${descriptor.backend} isolation=${descriptor.isolation} ` +
      `suite(s)=${descriptor.suiteFiles.length}`,
  );
  for (const suiteFile of descriptor.suiteFiles) {
    console.log(`  - ${suiteFile}`);
  }
  let status = 0;
  const lock = acquireSuiteLock({
    file: suiteLockPath(),
    label: `${descriptor.backend} ${descriptor.suiteFiles.join(" ")}`,
  });
  try {
    if (lock.waitedMs > 0) console.log(`backend-runner: waited ${lock.waitedMs} ms for another suite run to finish`);
    for (const suiteFile of descriptor.suiteFiles) {
      const code = runOneSuite(descriptor, suiteFile, parsed.passthrough);
      if (code !== 0 && status === 0) status = code;
    }
  } finally {
    lock.release();
  }
  return status;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof RunnerError) {
      console.error(`backend-runner: ${error.message}`);
      process.exitCode = 2;
    } else {
      console.error(`backend-runner: unexpected failure: ${error?.stack ?? error}`);
      process.exitCode = 1;
    }
  }
}
