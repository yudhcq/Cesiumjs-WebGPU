/**
 * T080 / **SH-7** — the CI degradation check (`tools/scripts/check-wgsl.mjs`; tasks.md T080;
 * verification contract §4 SH-7 and §8; contract fork-patch-layer §5 rule R8).
 *
 * SH-7's subject is not "WGSL is valid" — it is **"a GPU-free CI run must not pass silently"**. The
 * cases below therefore pin the degradation protocol exactly as T080 words it: with no `naga`
 * executable the tool MUST print the degradation notice, and under a CI configuration it MUST fail
 * (MUST NOT silently pass). The counter-example — `CI=true` plus a non-existent `--naga` path → a
 * non-zero exit whose output still carries the notice and the blind-spot sentence — is the case the
 * task's own self-check names.
 *
 * The tool is exercised as a **child process** (`spawnSync(process.execPath, [...])`) so the exit code
 * under test is a real process exit code, and with `shell: false` + an argument array, which is also
 * what the "never executes a shell" case asserts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { BLIND_SPOT, ciIsTruthy, nagaCandidates, parseArgv, resolveNaga, runNaga, templateFiles } from "../../tools/scripts/check-wgsl.mjs";

const TOOL = repoPath("tools/scripts/check-wgsl.mjs");
const MISSING_NAGA = path.join(os.tmpdir(), "cesium-webgpu-no-such-dir", process.platform === "win32" ? "naga.exe" : "naga");
const DEGRADATION = /DEGRADED — no naga executable was found/;

/** Run the tool as a child process with a controlled environment (never inheriting the caller's CI). */
function runTool(args, env = {}) {
  const childEnv = { ...process.env, ...env };
  if (!("CI" in env)) delete childEnv.CI;
  if (!("PATH" in env)) delete childEnv.PATH;
  delete childEnv.NAGA_PATH;
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", shell: false, env: childEnv, timeout: 900_000 });
  return { code: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ------------------------------------------------------------------------------------------------
// the degradation protocol (the SH-7 counter-examples)
// ------------------------------------------------------------------------------------------------

test("naga missing + CI=true ⇒ a non-zero exit that still prints the degradation notice", () => {
  const { code, stdout, stderr } = runTool(["--no-naga-discovery", "--naga", MISSING_NAGA], { CI: "true" });
  const output = `${stdout}${stderr}`;
  assert.notEqual(code, 0, `T080: under CI the tool MUST NOT pass silently. Output:\n${output}`);
  assert.match(output, DEGRADATION, "the degradation notice MUST be printed on stdout");
  assert.ok(output.includes("inputs that could NOT be checked"), "the notice MUST name the inputs it could not check");
  assert.ok(output.includes(BLIND_SPOT), `the blind spot MUST be stated verbatim: ${BLIND_SPOT}`);
  assert.match(output, /MUST fail rather than pass silently/);
});

test("naga missing + CI unset ⇒ exit 0, and the degradation is still visible (never silent)", () => {
  const { code, stdout, stderr } = runTool(["--no-naga-discovery", "--naga", MISSING_NAGA]);
  const output = `${stdout}${stderr}`;
  assert.equal(code, 0, `without CI a degradation is reported, not treated as a failure. Output:\n${output}`);
  assert.match(output, DEGRADATION);
  assert.ok(output.includes("inputs that could NOT be checked"));
  assert.ok(output.includes(BLIND_SPOT), `the blind spot MUST be stated verbatim: ${BLIND_SPOT}`);
  assert.match(output, /CI is not configured/);
  // The inputs are named as repository-relative paths (cross-platform, no absolute machine paths).
  assert.ok(output.includes("packages/cesium-webgpu/backend-webgpu/webgpu/wgsl/"), "the notice MUST list the emitted modules it could not check");
});

test("--require-naga forces the strict path on a machine without naga", () => {
  const { code, stdout, stderr } = runTool(["--no-naga-discovery", "--naga", MISSING_NAGA, "--require-naga"]);
  const output = `${stdout}${stderr}`;
  assert.equal(code, 1, `--require-naga MUST fail rather than degrade. Output:\n${output}`);
  assert.match(output, DEGRADATION);
});

test("the templates are never handed to naga: they are listed as validated in emitted form", () => {
  // The listing does not depend on naga being present, which is exactly the point: the distinction
  // between a template and a complete module must hold on every machine.
  const { stdout, stderr } = runTool(["--no-naga-discovery", "--naga", MISSING_NAGA]);
  const output = `${stdout}${stderr}`;
  assert.match(output, /template file\(s\) validated in emitted form/);
  const templates = templateFiles();
  assert.ok(templates.length >= 4, `the four terrain library files MUST be recognised as templates, got ${JSON.stringify(templates)}`);
  for (const template of templates) assert.ok(output.includes(template), `${template} MUST be named in the report`);
  assert.ok(templates.every((template) => template.includes("/leaves/") || template.includes("/wgsl-prelude/")));
});

// ------------------------------------------------------------------------------------------------
// CLI contract
// ------------------------------------------------------------------------------------------------

test("an unknown argument exits 2 and is named", () => {
  const { code, stderr } = runTool(["--definitely-not-an-option"]);
  assert.equal(code, 2, stderr);
  assert.match(stderr, /unknown argument "--definitely-not-an-option"/);
});

test("a missing value for a value-taking argument exits 2", () => {
  const { code, stderr } = runTool(["--naga"]);
  assert.equal(code, 2, stderr);
  assert.match(stderr, /missing value for "--naga"/);
});

test("the CLI parses the documented options", () => {
  const options = parseArgv(["--dir", "out/wgsl", "--naga", "C:/tools/naga.exe", "--require-naga"]);
  assert.equal(options.requireNaga, true);
  assert.ok(options.dir.endsWith(path.join("out", "wgsl")));
  assert.equal(options.naga, "C:/tools/naga.exe");
  assert.throws(() => parseArgv(["--nope"]), /unknown argument/);
});

test("CI truthiness follows the values CI systems actually set", () => {
  assert.equal(ciIsTruthy(undefined), false);
  assert.equal(ciIsTruthy(""), false);
  assert.equal(ciIsTruthy("false"), false);
  assert.equal(ciIsTruthy("0"), false);
  assert.equal(ciIsTruthy("true"), true);
  assert.equal(ciIsTruthy("1"), true);
});

// ------------------------------------------------------------------------------------------------
// naga resolution + invocation
// ------------------------------------------------------------------------------------------------

test("--naga and NAGA_PATH are honoured, and discovery can be turned off", () => {
  assert.deepEqual(nagaCandidates({ explicit: "X:/naga", env: {}, discover: false }), ["X:/naga"]);
  assert.deepEqual(nagaCandidates({ explicit: null, env: { NAGA_PATH: "X:/naga" }, discover: false }), ["X:/naga"]);
  const discovered = nagaCandidates({ explicit: null, env: { CARGO_HOME: "X:/cargo" }, discover: true });
  assert.ok(discovered.includes("naga"), "PATH discovery MUST be attempted by default");
  assert.ok(discovered.some((candidate) => candidate.includes("cargo")), "the cargo bin directory MUST be a candidate (contract R8 pins naga-cli 30.0.1)");
  assert.ok(!nagaCandidates({ explicit: null, env: { CARGO_HOME: "X:/cargo" }, discover: false }).includes("naga"));
});

test("a non-existent --naga path is reported, not thrown", () => {
  const resolved = resolveNaga({ explicit: MISSING_NAGA, env: {}, discover: false });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.command, null);
  assert.match(resolved.detail, /not found/);
});

test("naga is invoked with an argument array and shell: false (never through a shell)", () => {
  const source = fs.readFileSync(TOOL, "utf8");
  // Every spawnSync call site carries `shell: false` and an array argument list.
  const calls = [...source.matchAll(/spawnSync\([^;]*?\);/gs)].map((match) => match[0]);
  assert.ok(calls.length >= 2, `expected at least the resolve/probe and the naga call sites, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /shell:\s*false/, `every spawnSync MUST pin shell: false — offending call:\n${call}`);
    assert.doesNotMatch(call, /shell:\s*true/, "shell: true is forbidden (contract: no shell pipelines)");
  }
  assert.doesNotMatch(source, /\bexecSync\b/, "the tool MUST NOT use execSync (shell interpolation)");
  // The comment at the top of the tool names PowerShell to say it is *not* used, so the check looks for
  // an actual invocation (`pwsh`/`powershell` as a word outside a comment line) rather than the word.
  const shellInvocations = source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .filter((line) => /\b(pwsh|powershell)\b/i.test(line) || /\.ps1\b/i.test(line));
  assert.deepEqual(shellInvocations, [], "the tool MUST NOT depend on PowerShell");
  assert.doesNotMatch(source, /[A-Za-z]:[\\/]+work[\\/]/i, "the tool MUST NOT carry an absolute machine path");
  // The naga command line itself: `--input-kind wgsl <file>`, as T080 specifies.
  assert.match(source, /\["--input-kind", "wgsl", file\]/, "naga MUST be invoked as `naga --input-kind wgsl <file>` (T080)");
  // Behavioural half: spawnSync must fail as a value when the executable is absent.
  const result = runNaga(MISSING_NAGA, "whatever.wgsl");
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.ok(typeof result.error === "string" && result.error.length > 0, "ENOENT MUST be handled as a value");
});
