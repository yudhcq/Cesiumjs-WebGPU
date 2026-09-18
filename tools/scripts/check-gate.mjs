#!/usr/bin/env node
/**
 * Gate-artefact checker (tasks.md T014 / plan "实现前的验证门" / constitution 原则 V).
 *
 * Every Phase-2 risk gate (G-1…G-7) MUST publish a machine-judgeable verdict at
 *   experiments/gates/out/<id>.json          (id = g1 … g7, lower case)
 * with the fields `gate` / `verdict` / `evidence` / `recordedAt` / `notes` (field spec:
 * experiments/gates/README.md). This tool validates that structure AND the judgement:
 *
 *   - a missing artefact, a missing field, a malformed field or a non-existent evidence
 *     path is a failure (an artefact that only states a conclusion is not evidence);
 *   - `verdict === "pass"` requires an itemised `checks` list whose entries are all `ok`;
 *     a `fail`/`partial` verdict requires at least one `ok: false` entry;
 *   - `verdict !== "pass"` exits non-zero: Phase 2 says STOP until the gate passes and the
 *     entry-point agent revises plan.md.
 *
 * Usage:
 *   node tools/scripts/check-gate.mjs --all
 *   node tools/scripts/check-gate.mjs --gate g1
 *   node tools/scripts/check-gate.mjs --gate g1,G-5 --json
 *   node tools/scripts/check-gate.mjs --all --dir <dir> --root <dir> --require g1,g2
 *
 * Options:
 *   --all              validate every judgement artefact in the gate directory AND require
 *                      the Phase-2 set (g1…g6) to be present. g7 is deliberately NOT required:
 *                      its conclusion lands in T127 (Phase 10) and is consumed by T098b.
 *   --gate <ids>       validate exactly these gates (comma separated; `g1`, `G-1`, `G1` all
 *                      normalise to `g1`; `g6-variants` style evidence files are allowed).
 *   --require <ids>    extra gate ids that must be present alongside `--all`.
 *   --dir <dir>        gate directory (default experiments/gates/out, relative to --root).
 *   --root <dir>       repository root used to resolve evidence paths (default: repo root).
 *   --json             print the machine-readable report instead of the human summary.
 *   --out <file>       also write the machine-readable report to this path.
 *
 * Exit codes: 0 every requested gate is present, structurally valid and `pass`;
 *             1 any gate missing / malformed / not `pass`;
 *             2 invalid invocation.
 *
 * Zero runtime dependencies, Node-only, cross-platform (CI target is Linux + bash).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..", "..");

/** Judgement artefacts live at `<gateDir>/<id>.json`; this is the default gate directory. */
export const DEFAULT_GATE_DIR = path.join("experiments", "gates", "out");

/** Required top-level fields of a gate artefact (tasks.md T014). */
export const REQUIRED_FIELDS = ["gate", "verdict", "evidence", "recordedAt", "notes"];

/** Allowed verdicts. Anything other than "pass" blocks Phase 3 and later. */
export const VERDICTS = ["pass", "fail", "partial"];

/** The Phase-2 set that `--all` requires (G-7 lands in T127 / Phase 10 and is optional here). */
export const REQUIRED_GATES = ["g1", "g2", "g3", "g4", "g5", "g6"];

/** `<id>.json` = the judgement artefact of a gate; `<id>-<slug>.json` = supporting evidence. */
const JUDGEMENT_FILE = /^g\d+\.json$/;

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const DRIVE_LETTER = /^[A-Za-z]:/;

const USAGE = `usage:
  node tools/scripts/check-gate.mjs --all
  node tools/scripts/check-gate.mjs --gate g1[,g5]
options: --all --gate <ids> --require <ids> --dir <dir> --root <dir> --json --out <file>`;

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

export function parseArgv(argv) {
  const options = { mode: null, gates: [], require: [], dir: DEFAULT_GATE_DIR, root: DEFAULT_ROOT, json: false, out: null };
  const takesValue = new Set(["--gate", "--require", "--dir", "--root", "--out"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    let value = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (key === "--all") {
      options.mode = "all";
      continue;
    }
    if (key === "--json") {
      options.json = true;
      continue;
    }
    if (key === "--help" || key === "-h") {
      options.mode = "help";
      continue;
    }
    if (!takesValue.has(key)) throw new Error(`unknown argument "${arg}"\n${USAGE}`);
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for "${key}"\n${USAGE}`);
      i += 1;
    }
    if (key === "--gate") {
      options.gates.push(...splitIds(value));
      options.mode ??= "gate";
    } else if (key === "--require") options.require.push(...splitIds(value));
    else if (key === "--dir") options.dir = value;
    else if (key === "--root") options.root = path.resolve(value);
    else if (key === "--out") options.out = value;
  }
  if (options.mode === "all" && options.gates.length > 0) throw new Error(`--all and --gate are mutually exclusive\n${USAGE}`);
  if (options.mode === null) options.mode = "all";
  return options;
}

function splitIds(value) {
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** `G-1` / `G1` / `g_1` / ` g1 ` -> `g1`; slugs (`g6-variants`) are preserved. */
export function normaliseGateId(id) {
  return String(id)
    .trim()
    .toLowerCase()
    .replace(/^g[-_\s]*(\d+)/, "g$1")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Normalise an evidence entry to `{ path, what }`; `null` when the shape is invalid. */
function normaliseEvidenceEntry(entry) {
  if (typeof entry === "string") return isNonEmptyString(entry) ? { path: entry.trim(), what: "" } : null;
  if (entry !== null && typeof entry === "object" && isNonEmptyString(entry.path)) {
    return { path: entry.path.trim(), what: isNonEmptyString(entry.what) ? entry.what.trim() : "" };
  }
  return null;
}

/**
 * Validate one gate artefact document.
 *
 * @param {unknown} document parsed JSON of `experiments/gates/out/<id>.json`
 * @param {object} context
 * @param {string} context.gateId normalised id of the file being validated
 * @param {string} context.root   repository root (evidence paths resolve against it)
 * @returns {{ errors: string[], warnings: string[], gate: string|null, verdict: string|null }}
 */
export function validateGateArtifact(document, { gateId, root }) {
  const errors = [];
  const warnings = [];
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { errors: ["artefact MUST be a JSON object"], warnings, gate: null, verdict: null };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in document)) errors.push(`missing required field "${field}"`);
  }

  const gate = isNonEmptyString(document.gate) ? normaliseGateId(document.gate) : null;
  if (document.gate !== undefined && gate === null) errors.push('field "gate" MUST be a non-empty string');
  if (gate !== null && gate !== gateId) errors.push(`field "gate" is "${gate}" but the artefact is "${gateId}"`);

  const verdict = document.verdict;
  if (!VERDICTS.includes(verdict)) {
    errors.push(`field "verdict" MUST be one of ${VERDICTS.join("|")} (got ${JSON.stringify(verdict)})`);
  }

  if (!isNonEmptyString(document.notes)) errors.push('field "notes" MUST be a non-empty string (state what was measured and what it means)');

  if (isNonEmptyString(document.recordedAt)) {
    if (!ISO_8601.test(document.recordedAt)) {
      errors.push(`field "recordedAt" MUST be an ISO-8601 timestamp with an explicit offset (got ${JSON.stringify(document.recordedAt)})`);
    } else {
      const recorded = Date.parse(document.recordedAt);
      if (!Number.isFinite(recorded)) errors.push(`field "recordedAt" is not a parseable timestamp (${document.recordedAt})`);
      else if (recorded - Date.now() > 24 * 3600 * 1000) warnings.push(`"recordedAt" is more than a day in the future (${document.recordedAt})`);
    }
  } else if (document.recordedAt !== undefined) {
    errors.push('field "recordedAt" MUST be an ISO-8601 timestamp string');
  }

  const evidence = document.evidence;
  if (evidence !== undefined && !Array.isArray(evidence)) {
    errors.push('field "evidence" MUST be an array of paths (strings) or { path, what } objects');
  } else if (Array.isArray(evidence)) {
    if (evidence.length === 0) {
      errors.push('field "evidence" MUST NOT be empty: a gate conclusion MUST cite artefacts, not only prose');
    }
    const seen = new Set();
    evidence.forEach((entry, index) => {
      const normalised = normaliseEvidenceEntry(entry);
      if (normalised === null) {
        errors.push(`evidence[${index}] MUST be a non-empty path string or a { path, what } object`);
        return;
      }
      const { path: evidencePath } = normalised;
      if (evidencePath.startsWith("/") || DRIVE_LETTER.test(evidencePath) || path.isAbsolute(evidencePath)) {
        errors.push(`evidence[${index}] "${evidencePath}" MUST be a repository-relative path`);
        return;
      }
      if (evidencePath.includes("\\")) {
        errors.push(`evidence[${index}] "${evidencePath}" MUST use forward slashes (cross-platform evidence)`);
        return;
      }
      if (seen.has(evidencePath)) warnings.push(`evidence path "${evidencePath}" is listed more than once`);
      seen.add(evidencePath);
      if (!fs.existsSync(path.resolve(root, evidencePath))) {
        errors.push(`evidence[${index}] "${evidencePath}" does not exist under the repository root (evidence MUST be a real artefact)`);
      }
    });
  }

  const checks = document.checks;
  if (checks !== undefined && !Array.isArray(checks)) {
    errors.push('field "checks" MUST be an array of { id, ok, detail } objects');
  } else if (Array.isArray(checks)) {
    const ids = new Set();
    let failed = 0;
    checks.forEach((check, index) => {
      if (check === null || typeof check !== "object" || Array.isArray(check)) {
        errors.push(`checks[${index}] MUST be an object with { id, ok, detail }`);
        return;
      }
      if (!isNonEmptyString(check.id)) errors.push(`checks[${index}].id MUST be a non-empty string`);
      else if (ids.has(check.id)) errors.push(`checks[${index}].id "${check.id}" is duplicated`);
      else ids.add(check.id);
      if (typeof check.ok !== "boolean") errors.push(`checks[${index}].ok MUST be a boolean`);
      else if (check.ok === false) failed += 1;
      if (!isNonEmptyString(check.detail)) errors.push(`checks[${index}].detail MUST be a non-empty string (每项检查 MUST 附结论依据)`);
    });
    if (checks.length === 0) errors.push('field "checks" MUST NOT be empty when present');
    if (verdict === "pass" && failed > 0) errors.push(`verdict is "pass" but ${failed} check(s) are not ok (结论与检查项不一致)`);
    if ((verdict === "fail" || verdict === "partial") && checks.length > 0 && failed === 0) {
      errors.push(`verdict is "${verdict}" but every check is ok (结论与检查项不一致)`);
    }
  }

  if (verdict === "pass" && !Array.isArray(checks)) {
    errors.push('a "pass" verdict MUST itemise its checks (field "checks") — 结论不得只写结论');
  }
  if ((verdict === "fail" || verdict === "partial") && !Array.isArray(checks)) {
    warnings.push("no itemised \"checks\" list: list each check and its outcome so the failure is reproducible");
  }

  return { errors, warnings, gate, verdict: VERDICTS.includes(verdict) ? verdict : null };
}

/** Validate one gate id against the gate directory. A missing file is a failure, never a skip. */
export function checkGate(gateId, { root, dir }) {
  const id = normaliseGateId(gateId);
  const absolute = path.resolve(root, dir, `${id}.json`);
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (!fs.existsSync(absolute)) {
    return { gate: id, path: relative, present: false, ok: false, verdict: null, errors: [`artefact missing: ${relative}`], warnings: [], checks: null, evidence: null, recordedAt: null };
  }
  let document;
  try {
    document = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    return { gate: id, path: relative, present: true, ok: false, verdict: null, errors: [`${relative} is not valid JSON: ${error.message}`], warnings: [], checks: null, evidence: null, recordedAt: null };
  }
  const { errors, warnings, verdict } = validateGateArtifact(document, { gateId: id, root });
  return {
    gate: id,
    path: relative,
    present: true,
    ok: errors.length === 0 && verdict === "pass",
    verdict,
    errors,
    warnings,
    checks: Array.isArray(document.checks) ? document.checks.length : null,
    evidence: Array.isArray(document.evidence) ? document.evidence.length : null,
    recordedAt: isNonEmptyString(document.recordedAt) ? document.recordedAt : null,
  };
}

/** Judgement artefacts present in the gate directory (evidence files like `g6-variants.json` excluded). */
export function discoverGates({ root, dir }) {
  const absolute = path.resolve(root, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs
    .readdirSync(absolute)
    .filter((name) => JUDGEMENT_FILE.test(name))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function printReport(report, useJson) {
  if (useJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const result of report.gates) {
    const bits = [];
    if (result.verdict !== null) bits.push(`verdict=${result.verdict}`);
    if (result.checks != null) bits.push(`${result.checks} check(s)`);
    if (result.evidence != null) bits.push(`${result.evidence} evidence path(s)`);
    if (result.recordedAt !== null) bits.push(`recordedAt=${result.recordedAt}`);
    console.log(`[${result.gate}] ${result.ok ? "pass" : "FAIL"}${bits.length > 0 ? ` (${bits.join(", ")})` : ""} -> ${result.path}`);
    for (const error of result.errors) console.log(`    error: ${error}`);
    for (const warning of result.warnings) console.log(`    warning: ${warning}`);
  }
  if (report.missing.length > 0) console.log(`missing gate artefact(s): ${report.missing.join(", ")}`);
  console.log(`check-gate: ${report.passed}/${report.gates.length} gate(s) pass -> ${report.gateDir}`);
}

export function run(argv) {
  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    console.error(`check-gate: ${error.message}`);
    return { code: 2, report: null };
  }
  if (options.mode === "help") {
    console.log(USAGE);
    return { code: 0, report: null };
  }

  let gateIds;
  let missing = [];
  if (options.mode === "gate") {
    gateIds = [...new Set(options.gates.map(normaliseGateId))];
    if (gateIds.length === 0) {
      console.error(`check-gate: --gate requires at least one gate id\n${USAGE}`);
      return { code: 2, report: null };
    }
  } else {
    const discovered = discoverGates(options);
    const required = [...new Set([...REQUIRED_GATES, ...options.require.map(normaliseGateId)])];
    missing = required.filter((id) => !discovered.includes(id));
    gateIds = [...new Set([...discovered, ...required])].sort();
  }

  const gates = gateIds.map((id) => checkGate(id, options));
  const failed = gates.filter((result) => !result.ok);
  const report = {
    tool: "check-gate",
    generatedAt: new Date().toISOString(),
    root: options.root,
    gateDir: path.relative(options.root, path.resolve(options.root, options.dir)).split(path.sep).join("/"),
    mode: options.mode,
    requiredGates: options.mode === "gate" ? gateIds : [...REQUIRED_GATES, ...options.require.map(normaliseGateId)],
    gates,
    missing,
    passed: gates.filter((result) => result.ok).length,
    failed: failed.length,
    verdict: failed.length === 0 && missing.length === 0 ? "pass" : "fail",
  };

  if (options.out) {
    const outPath = path.resolve(options.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  printReport(report, options.json);
  if (report.verdict === "pass") return { code: 0, report };
  console.error(
    "check-gate: STOP — Phase 2 门禁未全部通过；MUST NOT 开始 Phase 3 及之后的实现任务，" +
      "由入口 Agent 依据该门的失败动作修订 plan.md (tasks.md Phase 2 门禁总则)",
  );
  return { code: 1, report };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exitCode = run(process.argv.slice(2)).code;
}
