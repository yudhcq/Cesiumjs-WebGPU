#!/usr/bin/env node
/**
 * Tool portability checker (global convention 1 in tasks.md).
 *
 * CI targets Linux + bash. Every self-check in this repository MUST run through Node and
 * MUST NOT depend on the Windows shell tooling, shell-specific syntax, the Unix text-search
 * utility, or absolute machine paths — the availability of such tools on a developer machine
 * is never a precondition for any check.
 *
 * Scanned surfaces:
 *   - `tools/**` (scripts, plugin, generators)
 *   - `.github/**` (CI workflow recipes; optional until T039 lands)
 *   - the `scripts` block of the root `package.json`
 *
 * Usage:
 *   node tools/scripts/check-tools-portable.mjs [--root <dir>] [--out <file>]
 *
 * Exit codes: 0 clean ("no match"), 1 violations, 2 missing required path / bad invocation.
 *
 * NOTE ON SELF-SCANNING: this file is part of `tools/**`, so it must not contain the literal
 * tokens it forbids. Every forbidden pattern is therefore assembled from fragments below;
 * `tests/unit/check-tools-portable.test.mjs` asserts the file scans itself clean.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..", "..");

const TEXT_EXTENSIONS = [".mjs", ".cjs", ".js", ".ts", ".mts", ".cts", ".json", ".yml", ".yaml", ".md", ".txt", ".html", ".css", ".ps1", ".sh", ".toml"];

/**
 * Forbidden patterns, assembled from fragments so this file can scan itself. Labels are
 * deliberately token-free for the same reason — a label containing the literal it describes
 * would be flagged during self-scan.
 */
const FORBIDDEN = [
  { label: "windows shell host executable (short name)", regex: new RegExp(`\\b${"p"}${"wsh"}\\b`, "i") },
  { label: "windows shell host executable (long name)", regex: new RegExp(`${"power"}${"shell"}`, "i") },
  { label: "windows shell null redirection", regex: new RegExp(`${"2>"}\\s*\\${"$"}${"null"}`) },
  { label: "windows shell cmdlet: directory enumeration", regex: new RegExp(`${"Get"}-${"Child"}${"Item"}`, "i") },
  { label: "windows shell cmdlet: console output", regex: new RegExp(`${"Write"}-${"Host"}`, "i") },
  { label: "windows shell cmdlet: text search", regex: new RegExp(`${"Select"}-${"String"}`, "i") },
  { label: "windows shell cmdlet: filtering", regex: new RegExp(`${"Where"}-${"Object"}`, "i") },
  { label: "windows shell cmdlet: path existence test", regex: new RegExp(`${"Test"}-${"Path"}`, "i") },
  { label: "windows shell cmdlet: path join", regex: new RegExp(`${"Join"}-${"Path"}`, "i") },
  { label: "windows shell cmdlet: item creation / removal", regex: new RegExp(`${"New"}-${"Item"}|${"Remove"}-${"Item"}`, "i") },
  { label: "windows shell error-handling parameter", regex: new RegExp(`${"-"}${"Error"}${"Action"}\\b`) },
  { label: "windows shell execution-policy call", regex: new RegExp(`${"Set"}-${"Execution"}${"Policy"}`, "i") },
  { label: "windows shell environment variable syntax", regex: new RegExp(`\\${"$"}${"env"}:`) },
  { label: "unix text-search utility invocation", regex: new RegExp(`\\b${"gr"}${"ep"}\\s+-`) },
  // A drive-letter path: a single letter, a colon, then a slash or backslash. The leading
  // boundary keeps URL schemes (letter, colon, slash) from matching.
  { label: "windows absolute path", regex: /(?:^|[^\w])[A-Za-z]:[\\/]/ },
];

function parseArgv(argv) {
  const options = { root: DEFAULT_ROOT, out: null };
  const takesValue = new Set(["--root", "--out"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    let value = eq >= 0 ? arg.slice(eq + 1) : undefined;
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

function walkFiles(target, out = []) {
  if (!fs.existsSync(target)) return out;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) walkFiles(child, out);
    else if (entry.isFile() && TEXT_EXTENSIONS.some((ext) => child.endsWith(ext))) out.push(child);
  }
  return out;
}

function scanText(root, file, violations) {
  const relative = path.relative(root, file).split(path.sep).join("/") || path.basename(file);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { label, regex } of FORBIDDEN) {
      if (regex.test(line)) {
        violations.push({ file: relative, line: index + 1, pattern: label, snippet: line.trim().slice(0, 160) });
      }
    }
  });
}

function main() {
  let options;
  try {
    options = parseArgv(process.argv.slice(2));
  } catch (error) {
    console.error(`check-tools-portable: ${error.message}`);
    return 2;
  }

  const toolsDir = path.join(options.root, "tools");
  const packageJsonPath = path.join(options.root, "package.json");
  for (const required of [toolsDir, packageJsonPath]) {
    if (!fs.existsSync(required)) {
      console.error(`check-tools-portable: required scan target missing: ${path.relative(options.root, required) || required}`);
      return 2;
    }
  }

  const violations = [];
  const files = [...walkFiles(toolsDir), ...walkFiles(path.join(options.root, ".github"))];
  for (const file of files) scanText(options.root, file, violations);

  // package.json: only the `scripts` block is an execution surface.
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const scripts = manifest.scripts ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") continue;
    for (const { label, regex } of FORBIDDEN) {
      if (regex.test(command)) {
        violations.push({ file: "package.json", line: 0, pattern: label, snippet: `scripts.${name}: ${command}` });
      }
    }
  }

  const scanned = { tools: files.filter((f) => f.startsWith(toolsDir)).length, github: files.length - files.filter((f) => f.startsWith(toolsDir)).length, scripts: Object.keys(scripts).length };

  const report = {
    tool: "check-tools-portable",
    generatedAt: new Date().toISOString(),
    root: options.root,
    scanned,
    violationCount: violations.length,
    violations,
    verdict: violations.length === 0 ? "pass" : "fail",
  };

  const outPath = options.out ? path.resolve(options.out) : path.join(options.root, "artifacts", "tools-portable.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (violations.length === 0) {
    console.log(
      `no match (scanned ${scanned.tools} file(s) under tools/, ${scanned.github} under .github/, ${scanned.scripts} root script(s))`,
    );
    console.log(`tools-portable: clean -> ${path.relative(options.root, outPath)}`);
    return 0;
  }

  for (const violation of violations) {
    const where = violation.line ? `${violation.file}:${violation.line}` : violation.file;
    console.log(`${where}: ${violation.pattern} -> ${violation.snippet}`);
  }
  console.error(`tools-portable: ${violations.length} violation(s) -> ${path.relative(options.root, outPath)}`);
  return 1;
}

process.exitCode = main();
