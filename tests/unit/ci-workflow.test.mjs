/**
 * T039 — CI skeleton (`.github/workflows/ci.yml`).
 *
 * Parsed with the pinned `yaml` dependency (T004) rather than pattern-matched: the assertions are
 * about the *gate order* the pipeline actually declares, and about the pipeline NOT containing a
 * job that renders the scene on both backends at once (principle II).
 */
import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";

import { readText } from "../support/repo.mjs";

const workflow = YAML.parse(readText(".github/workflows/ci.yml"));
const job = workflow.jobs?.gates;

/** The `run:` commands of the job's steps, in declaration order. */
function runCommands() {
  return (job?.steps ?? []).filter((step) => typeof step.run === "string").map((step) => step.run.trim());
}

test("the workflow parses and declares a single offline gate job", () => {
  assert.ok(workflow !== null && typeof workflow === "object", "ci.yml MUST be valid YAML");
  assert.ok(job, "ci.yml MUST declare the `gates` job");
  assert.match(job["runs-on"], /ubuntu/, "the pipeline runs on the Linux runner");
  assert.ok(Number(job["timeout-minutes"]) <= 20, "the gate job MUST stay inside the 20-minute budget (SC-005)");
});

test("the gates run in the constitution's order: install -> build -> typecheck -> unit -> audit", () => {
  const commands = runCommands();
  const indexOf = (needle) => {
    const index = commands.findIndex((command) => command.includes(needle));
    assert.ok(index >= 0, `ci.yml MUST run a step containing "${needle}"`);
    return index;
  };
  assert.ok(
    indexOf("npm ci") < indexOf("npm run build") &&
      indexOf("npm run build") < indexOf("npm run typecheck") &&
      indexOf("npm run typecheck") < indexOf("npm run test:unit") &&
      indexOf("npm run test:unit") < indexOf("audit-patch-scope"),
    `gate order violated: ${JSON.stringify(commands)}`,
  );
});

test("the audit stage covers AU-1…AU-5 of the patch-layer contract", () => {
  const commands = runCommands().join("\n");
  for (const required of [
    "tools/scripts/verify-upstream-integrity.mjs", // AU-2 integrity
    "tools/audit-patch-scope.mjs", // AU-1/AU-3/AU-4 patch scope
    "tools/scripts/check-build-layer-source.mjs", // AU-4 build product
    "tools/scripts/gen-kept-hash.mjs --check", // AU-3 kept modules
    "tools/gen-interface-manifest.mjs --check", // AU-1 interface surface
    "tools/scripts/check-license-notice.mjs", // AU-5 license and notice
    "tools/upgrade-drill.mjs --dry-run", // upgrade drill (dry run, principle I)
  ]) {
    assert.ok(commands.includes(required), `the audit stage MUST run "${required}"`);
  }
});

test("the audit stage runs after the unit gate and before the artifact upload", () => {
  const commands = runCommands();
  const unit = commands.findIndex((command) => command.includes("npm run test:unit"));
  const audit = commands.findIndex((command) => command.includes("tools/audit-patch-scope.mjs"));
  const uploadStep = (job?.steps ?? []).findIndex((step) => step.uses === "actions/upload-artifact@v4");
  assert.ok(unit < audit, "unit tests MUST fail fast before the audit stage");
  assert.ok(uploadStep >= 0, "the pipeline MUST archive the audit records (principle V)");
  assert.ok(uploadStep > audit, "the upload MUST come after the audit steps it archives");
});

test("the audit and drill records are registered as CI artifacts (T041)", () => {
  const upload = (job?.steps ?? []).find((step) => step.uses === "actions/upload-artifact@v4");
  const paths = String(upload.with.path);
  for (const artifact of [
    "artifacts/patch-scope-audit.json",
    "artifacts/upgrade-drill.json",
    "artifacts/upstream-integrity.json",
    "artifacts/build-layer-source.json",
    "artifacts/license-notice.json",
  ]) {
    assert.ok(paths.includes(artifact), `the upload step MUST archive ${artifact}`);
  }
  assert.equal(upload.with["if-no-files-found"], "error", "a missing audit record MUST fail the job, not be ignored");
});

test("no job renders the scene on both backends at once (principle II)", () => {
  const text = readText(".github/workflows/ci.yml");
  const forbidden = [
    /--backend=[^\s]*,[^\s]*/,
    /--backends=/,
    /RENDER_BACKEND[^\n]*webgpu[^\n]*webgl2/i,
    /RENDER_BACKEND[^\n]*webgl2[^\n]*webgpu/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(text, pattern, `ci.yml MUST NOT enable both backends in one run (${pattern})`);
  }
  // The two-path jobs are a W8 deliverable and MUST NOT exist yet.
  assert.ok(!/matrix[\s\S]*backend/i.test(text), "the two-path matrix belongs to W8, not to this skeleton");
  assert.ok(!/playwright/i.test(text), "contract/visual/benchmark jobs are added in W8 (tasks.md T131+)");
});

test("every step is a Node invocation (portability rule)", () => {
  for (const command of runCommands()) {
    assert.ok(/^npm (ci|run [a-z:]+)$/.test(command) || /^node tools\//.test(command), `unexpected step command: ${command}`);
  }
});
