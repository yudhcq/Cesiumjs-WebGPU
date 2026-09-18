#!/usr/bin/env node
/**
 * Unified task runner — the single entry point behind every root npm script.
 *
 * Why a Node runner instead of shell pipelines: the CI target is Linux + bash while
 * development happens on Windows, so every step MUST be a Node-only, cross-platform
 * invocation (global convention 1 in tasks.md; enforced by
 * `tools/scripts/check-tools-portable.mjs`).
 *
 * Usage:
 *   node tools/scripts/run.mjs <command> [options]
 *
 * Commands:
 *   build          TypeScript declarations (tsc) + all Rollup bundles
 *   typecheck      tsc --noEmit for the delivery package and the demo
 *   lint           portability check + architecture boundary rules that have a target
 *   test:unit      node --test over tests/unit/**
 *   test:contract  Playwright contract suites for ONE backend (via tests/support/backend-runner.mjs)
 *   test:visual    Playwright visual suites for ONE backend
 *   bench          Playwright benchmark suites for ONE backend
 *   demo           serve the demo page over the zero-dependency static server
 *   ci:local       build -> typecheck -> lint -> test:unit (the local equivalent of CI)
 *
 * Options: --dir=<path> (test discovery root), --backend=<webgpu|webgl2>, plus the
 * pass-through options of the underlying tool.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const COMMANDS = [
  "build",
  "typecheck",
  "lint",
  "test:unit",
  "test:contract",
  "test:visual",
  "bench",
  "demo",
  "ci:local",
];

const TEST_ROOTS = {
  "test:unit": "tests/unit",
  "test:contract": "tests/contract",
  "test:visual": "tests/visual",
  bench: "tests/benchmark",
};

const TEST_FILE_PATTERN = /\.(test|spec)\.(mjs|cjs|js)$/;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

class CommandError extends Error {}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function runStep(label, args) {
  log(`\n> ${label}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: REPO_ROOT });
  if (result.error) throw new CommandError(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new CommandError(`${label} exited with code ${result.status}`);
}

function parseOptions(argv) {
  const options = { passthrough: [] };
  for (const arg of argv) {
    if (arg.startsWith("--dir=")) options.dir = arg.slice("--dir=".length);
    else if (arg.startsWith("--backend=")) options.backend = arg.slice("--backend=".length);
    else options.passthrough.push(arg);
  }
  return options;
}

/** Node binary path of a locally installed package (cross-platform: never a .cmd/.sh shim). */
function packageBin(packageName, binName) {
  const manifestPath = path.join(REPO_ROOT, "node_modules", packageName, "package.json");
  if (!fs.existsSync(manifestPath)) {
    throw new CommandError(`package "${packageName}" is not installed (run npm ci)`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const binField = manifest.bin;
  const relative = typeof binField === "string" ? binField : (binField?.[binName] ?? null);
  if (relative === null) throw new CommandError(`package "${packageName}" does not expose a "${binName}" binary`);
  return path.join(path.dirname(manifestPath), relative);
}

/** Collect test files below a repository-relative (or absolute) directory. */
function collectTestFiles(relativeDir) {
  const absolute = path.isAbsolute(relativeDir) ? relativeDir : path.join(REPO_ROOT, relativeDir);
  if (!fs.existsSync(absolute)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(path.join(dir, entry.name));
      } else if (TEST_FILE_PATTERN.test(entry.name)) {
        out.push(path.relative(REPO_ROOT, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    }
  };
  walk(absolute);
  return out.sort();
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function emitDeclarations() {
  const tsc = packageBin("typescript", "tsc");
  runStep("tsc --emitDeclarationOnly (packages/cesium-webgpu)", [
    tsc,
    "-p",
    "packages/cesium-webgpu/tsconfig.json",
    "--emitDeclarationOnly",
  ]);
}

function describeInput(input) {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input.join(", ");
  if (input !== null && typeof input === "object") return Object.keys(input).join(", ");
  return String(input);
}

async function runRollup() {
  const configPath = path.join(REPO_ROOT, "rollup.config.mjs");
  if (!fs.existsSync(configPath)) throw new CommandError("rollup.config.mjs is missing");
  const { rollup } = await import("rollup");
  const loaded = await import(pathToFileURL(configPath).href);
  const configs = Array.isArray(loaded.default) ? loaded.default : [loaded.default];
  for (const config of configs) {
    log(`\n> rollup ${describeInput(config.input)}`);
    const bundle = await rollup(config);
    try {
      await bundle.write(config.output);
    } finally {
      await bundle.close();
    }
  }
}

async function commandBuild() {
  await emitDeclarations();
  await runRollup();
  log("\nbuild: ok");
}

function commandTypecheck() {
  const tsc = packageBin("typescript", "tsc");
  runStep("tsc --noEmit (packages/cesium-webgpu)", [tsc, "-p", "packages/cesium-webgpu/tsconfig.json", "--noEmit"]);
  runStep("tsc --noEmit (apps/demo)", [tsc, "-p", "apps/demo/tsconfig.json", "--noEmit"]);
  log("\ntypecheck: ok");
}

function commandLint() {
  runStep("check-tools-portable", [path.join(HERE, "check-tools-portable.mjs")]);
  // `--rules auto` runs every architecture rule whose target exists and reports the rest as
  // skipped, so `lint` is meaningful while later phases are still landing artifacts. The
  // strict full run (`--rules all`, no skips allowed) is the CI audit gate.
  runStep("check-arch-boundaries (auto)", [path.join(HERE, "check-arch-boundaries.mjs"), "--rules", "auto"]);
  log("\nlint: ok");
}

function commandTest(command, options) {
  const root = options.dir ?? TEST_ROOTS[command];
  const passthrough = options.passthrough ?? [];
  const files = collectTestFiles(root);
  if (files.length === 0) {
    log(`no tests yet (looked for test files under ${root})`);
    return;
  }

  if (command === "test:unit") {
    runStep(`node --test (${files.length} file(s) under ${root})`, ["--test", ...files, ...passthrough]);
    return;
  }

  // Contract / visual / benchmark suites are Playwright driven and MUST run with exactly one
  // backend per run (principle II): the runner refuses to start without an explicit choice
  // and never accepts two values.
  if (options.backend !== "webgpu" && options.backend !== "webgl2") {
    throw new CommandError(`${command} requires --backend=<webgpu|webgl2>; one run enables exactly one backend`);
  }
  const runner = path.join(REPO_ROOT, "tests", "support", "backend-runner.mjs");
  if (!fs.existsSync(runner)) {
    throw new CommandError(`tests/support/backend-runner.mjs is missing; cannot run ${command}`);
  }
  runStep(`${command} --backend=${options.backend} (${files.length} file(s))`, [
    runner,
    `--backend=${options.backend}`,
    ...files.map((file) => `--suite-file=${file}`),
    ...passthrough,
  ]);
}

async function commandDemo(options) {
  const serve = path.join(HERE, "serve.mjs");
  log("demo: serving the repository root; open /apps/demo/ in a browser");
  log("      backend selection is a configuration value, e.g. /apps/demo/?preference=<value>");
  runStep("serve.mjs", [serve, ...(options.passthrough.length > 0 ? options.passthrough : [])]);
}

async function commandCiLocal() {
  await commandBuild();
  commandTypecheck();
  commandLint();
  commandTest("test:unit", {});
  log("\nci:local: all local gates passed");
}

function printUsage() {
  log(`usage: node tools/scripts/run.mjs <${COMMANDS.join("|")}> [options]`);
  log("options: --dir=<path> --backend=<webgpu|webgl2> [tool options…]");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "-h") {
    printUsage();
    return command === undefined ? 2 : 0;
  }
  if (!COMMANDS.includes(command)) {
    console.error(`run: unknown command "${command}"`);
    printUsage();
    return 2;
  }

  const options = parseOptions(rest);
  switch (command) {
    case "build":
      await commandBuild();
      break;
    case "typecheck":
      commandTypecheck();
      break;
    case "lint":
      commandLint();
      break;
    case "test:unit":
    case "test:contract":
    case "test:visual":
    case "bench":
      commandTest(command, options);
      break;
    case "demo":
      await commandDemo(options);
      break;
    case "ci:local":
      await commandCiLocal();
      break;
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof CommandError) {
    console.error(`\nrun: ${error.message}`);
  } else {
    console.error(`\nrun: unexpected failure: ${error?.stack ?? error}`);
  }
  process.exitCode = 1;
}
