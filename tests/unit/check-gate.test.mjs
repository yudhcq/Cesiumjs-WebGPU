/**
 * T014 — gate-artefact checker (`tools/scripts/check-gate.mjs`).
 *
 * The checker is the only machine judge of the Phase-2 risk gates, so its own failure modes
 * matter: tasks.md T014 names three negative cases that MUST exit non-zero —
 *   1. the artefact file is missing;
 *   2. a required field (`verdict`/`evidence`/`recordedAt`/`notes`) is missing;
 *   3. `verdict === "fail"`.
 * Beyond those, this suite pins the rules that make a gate verdict trustworthy:
 * evidence must exist on disk, `pass` must itemise its checks, and `pass`/`fail` must not
 * contradict the check list.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REQUIRED_FIELDS, normaliseGateId } from "../../tools/scripts/check-gate.mjs";
import { REPO_ROOT, repoPath } from "../support/repo.mjs";

const CHECKER = repoPath("tools/scripts/check-gate.mjs");
const GATE_DIR = "experiments/gates/out";

function runChecker(args) {
  const result = spawnSync(process.execPath, [CHECKER, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A gate artefact that satisfies every rule; `overrides` mutate/remove fields per case. */
function gateArtifact(overrides = {}) {
  return {
    gate: "g1",
    task: "T015",
    verdict: "pass",
    recordedAt: "2026-09-19T10:00:00.000Z",
    notes: "fixture gate: structure only",
    evidence: [{ path: "docs/gate-g1-conclusion.md", what: "conclusion document" }],
    checks: [{ id: "seam-rewritten", ok: true, detail: "fixture check" }],
    ...overrides,
  };
}

/**
 * Build a throw-away repository root: `<root>/experiments/gates/out/<id>.json` plus one real
 * evidence file per gate, so the checker's existence rule is exercised honestly.
 */
function makeRoot(gates = {}, extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-gate-"));
  const write = (relative, content) => {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`, "utf8");
  };
  for (const [id, artifact] of Object.entries(gates)) {
    write(`${GATE_DIR}/${id}.json`, artifact);
    write(`docs/gate-${id}-conclusion.md`, `# ${id}\n`);
  }
  for (const [relative, content] of Object.entries(extraFiles)) write(relative, content);
  return root;
}

function allRequirements() {
  const gates = {};
  for (const id of ["g1", "g2", "g3", "g4", "g5", "g6"]) {
    gates[id] = gateArtifact({ gate: id, evidence: [{ path: `docs/gate-${id}-conclusion.md`, what: "conclusion" }] });
  }
  return gates;
}

test("normaliseGateId accepts the spellings used across plan/tasks/README", () => {
  for (const input of ["g1", "G1", "G-1", "g-1", " G1 ", "G_1"]) {
    assert.equal(normaliseGateId(input), "g1");
  }
  assert.equal(normaliseGateId("G-6"), "g6");
  assert.equal(normaliseGateId("g6-variants"), "g6-variants");
});

test("a well-formed pass artefact exits 0", (t) => {
  const root = makeRoot({ g1: gateArtifact() });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout } = runChecker(["--gate", "g1", "--root", root]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /\[g1\] pass/);
  assert.match(stdout, /check-gate: 1\/1 gate\(s\) pass/);
});

test("negative case 1 — a missing artefact exits non-zero", (t) => {
  const root = makeRoot({});
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout } = runChecker(["--gate", "g1", "--root", root]);
  assert.notEqual(code, 0);
  assert.match(stdout, /FAIL/);
  assert.match(stdout, /artefact missing: experiments\/gates\/out\/g1\.json/);
});

test("negative case 2 — each required field is enforced", (t) => {
  for (const field of REQUIRED_FIELDS) {
    const artifact = gateArtifact();
    delete artifact[field];
    const root = makeRoot({ g1: artifact });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const { code, stdout } = runChecker(["--gate", "g1", "--root", root]);
    assert.notEqual(code, 0, `${field} MUST be required`);
    assert.match(stdout, new RegExp(`missing required field "${field}"`));
  }
  // The four fields named in tasks.md T014 are a subset of what the checker requires.
  for (const field of ["verdict", "evidence", "recordedAt", "notes"]) assert.ok(REQUIRED_FIELDS.includes(field));
});

test("negative case 3 — verdict=fail (and partial) exits non-zero", (t) => {
  const failed = makeRoot({
    g1: gateArtifact({ verdict: "fail", checks: [{ id: "seam-rewritten", ok: false, detail: "relative import not rewritten" }] }),
  });
  t.after(() => fs.rmSync(failed, { recursive: true, force: true }));
  const failRun = runChecker(["--gate", "g1", "--root", failed]);
  assert.notEqual(failRun.code, 0);
  assert.match(failRun.stdout, /verdict=fail/);
  assert.match(failRun.stderr, /STOP/);

  const partial = makeRoot({
    g1: gateArtifact({ verdict: "partial", checks: [{ id: "seam-rewritten", ok: false, detail: "runtime half unverified" }] }),
  });
  t.after(() => fs.rmSync(partial, { recursive: true, force: true }));
  const partialRun = runChecker(["--gate", "g1", "--root", partial]);
  assert.notEqual(partialRun.code, 0);
  assert.match(partialRun.stdout, /verdict=partial/);
});

test("an evidence path that does not exist is a failure (结论不得只写结论)", (t) => {
  const root = makeRoot({ g1: gateArtifact({ evidence: ["docs/gate-g1-conclusion.md", "docs/nowhere.md"] }) });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout } = runChecker(["--gate", "g1", "--root", root]);
  assert.notEqual(code, 0);
  assert.match(stdout, /docs\/nowhere\.md" does not exist/);
});

test("malformed fields are rejected: empty evidence, bad timestamp, wrong gate id, prose-only notes", (t) => {
  const cases = [
    { overrides: { evidence: [] }, pattern: /evidence" MUST NOT be empty/ },
    { overrides: { recordedAt: "2026-09-19 10:00" }, pattern: /ISO-8601 timestamp with an explicit offset/ },
    { overrides: { gate: "g2" }, pattern: /field "gate" is "g2" but the artefact is "g1"/ },
    { overrides: { notes: "   " }, pattern: /notes" MUST be a non-empty string/ },
    { overrides: { verdict: "maybe" }, pattern: /verdict" MUST be one of pass\|fail\|partial/ },
    { overrides: { evidence: ["/abs/path.md"] }, pattern: /MUST be a repository-relative path/ },
    { overrides: { evidence: ["docs\\gate-g1-conclusion.md"] }, pattern: /MUST use forward slashes/ },
  ];
  for (const { overrides, pattern } of cases) {
    const root = makeRoot({ g1: gateArtifact(overrides) });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { code, stdout } = runChecker(["--gate", "g1", "--root", root]);
    assert.notEqual(code, 0, JSON.stringify(overrides));
    assert.match(stdout, pattern);
  }
});

test("verdict and checks must agree (a pass with a failing check is rejected)", (t) => {
  const root = makeRoot({ g1: gateArtifact({ checks: [{ id: "seam-rewritten", ok: false, detail: "not rewritten" }] }) });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout } = runChecker(["--gate", "g1", "--root", root]);
  assert.notEqual(code, 0);
  assert.match(stdout, /verdict is "pass" but 1 check\(s\) are not ok/);
});

test("a pass verdict must itemise its checks", (t) => {
  const artifact = gateArtifact();
  delete artifact.checks;
  const root = makeRoot({ g1: artifact });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { code, stdout } = runChecker(["--gate", "g1", "--root", root]);
  assert.notEqual(code, 0);
  assert.match(stdout, /a "pass" verdict MUST itemise its checks/);
});

test("--all requires the Phase-2 set g1…g6 and tolerates intermediate evidence files", (t) => {
  const complete = makeRoot(allRequirements(), { [`${GATE_DIR}/g6-variants.json`]: { note: "histogram evidence, not a judgement artefact" } });
  t.after(() => fs.rmSync(complete, { recursive: true, force: true }));
  const okRun = runChecker(["--all", "--root", complete]);
  assert.equal(okRun.code, 0, okRun.stdout);
  assert.match(okRun.stdout, /check-gate: 6\/6 gate\(s\) pass/);

  const incomplete = makeRoot({ g1: gateArtifact() });
  t.after(() => fs.rmSync(incomplete, { recursive: true, force: true }));
  const missingRun = runChecker(["--all", "--root", incomplete]);
  assert.notEqual(missingRun.code, 0, missingRun.stdout);
  assert.match(missingRun.stdout, /missing gate artefact\(s\): g2, g3, g4, g5, g6/);
});

test("an intermediate evidence file is validated only when asked for explicitly", (t) => {
  const root = makeRoot(allRequirements(), { [`${GATE_DIR}/g1-build.json`]: { verdict: "pass", tool: "rollup" } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // `--all` ignores it (it is not a judgement artefact)…
  const allRun = runChecker(["--all", "--json", "--root", root]);
  assert.equal(allRun.code, 0, allRun.stdout);
  assert.deepEqual(
    JSON.parse(allRun.stdout).gates.map((entry) => entry.gate),
    ["g1", "g2", "g3", "g4", "g5", "g6"],
  );

  // …but `--gate` reads it and reports its missing fields.
  const explicit = runChecker(["--gate", "g1-build", "--root", root]);
  assert.notEqual(explicit.code, 0);
  assert.match(explicit.stdout, /missing required field "gate"/);
});

test("invalid invocations exit 2", () => {
  assert.equal(runChecker(["--nope"]).code, 2);
  assert.match(runChecker(["--nope"]).stderr, /unknown argument/);
  assert.equal(runChecker(["--all", "--gate", "g1"]).code, 2);
  assert.match(runChecker(["--all", "--gate", "g1"]).stderr, /mutually exclusive/);
  assert.equal(runChecker(["--gate"]).code, 2);
});

test("--json prints the machine-readable report and --out writes it", (t) => {
  const root = makeRoot({ g1: gateArtifact() });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outFile = path.join(root, "report.json");

  const { code, stdout } = runChecker(["--gate", "g1", "--root", root, "--json", "--out", outFile]);
  assert.equal(code, 0, stdout);
  const report = JSON.parse(stdout);
  assert.equal(report.verdict, "pass");
  assert.equal(report.gates[0].gate, "g1");
  assert.deepEqual(JSON.parse(fs.readFileSync(outFile, "utf8")), report);
});

test("the repository's own gate directory is checked with the committed gate sources", (t) => {
  // Scans whatever the developer has produced so far; the assertion is about the checker
  // working against the real layout (REPO_ROOT), never about how many gates exist yet.
  const { code, stdout } = runChecker(["--gate", "g9", "--root", REPO_ROOT, "--json"]);
  assert.notEqual(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.gateDir, GATE_DIR);
  assert.equal(report.gates[0].path, `${GATE_DIR}/g9.json`);
});
