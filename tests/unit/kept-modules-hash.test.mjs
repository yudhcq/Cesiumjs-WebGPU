/**
 * T032 — `keptModulesHash` (`tools/scripts/gen-kept-hash.mjs`).
 *
 * The recorded set is the "upstream files we still depend on byte-identically" inventory. These
 * cases assert completeness (every non-listed `Renderer/**` module has a hash), the presence of
 * the GL-free modules the contract calls out, idempotence of the generator, and — decisively —
 * that a changed byte in a kept module is detected.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, readJson, repoPath } from "../support/repo.mjs";
import { compareKeptModules, computeKeptModules, listRendererModules } from "../../tools/lib/patch-layer.mjs";
import { checkKeptModules } from "../../tools/scripts/gen-kept-hash.mjs";

const GENERATOR = repoPath("tools/scripts/gen-kept-hash.mjs");
const manifest = readJson("packages/cesium-webgpu/backend-webgpu/manifest.json");

function runGenerator(args) {
  const result = spawnSync(process.execPath, [GENERATOR, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("every Renderer module that is not listed in the manifest carries a recorded hash", () => {
  const listed = new Set(manifest.entries.map((entry) => entry.upstreamModule));
  const rendererModules = listRendererModules();
  const kept = rendererModules.filter((module_) => !listed.has(module_));

  assert.deepEqual(
    Object.keys(manifest.keptModules).sort(),
    kept,
    "the recorded kept set MUST be exactly Renderer/** minus the manifest entries",
  );
  assert.equal(manifest.keptModulesCount, kept.length);
  for (const [module_, hash] of Object.entries(manifest.keptModules)) {
    assert.match(hash, /^sha256-[0-9a-f]{64}$/, `${module_} MUST carry a sha256 content hash`);
  }
  for (const entry of manifest.entries) {
    assert.equal(manifest.keptModules[entry.upstreamModule], undefined, `${entry.upstreamModule} is replaced, so it MUST NOT be a kept module`);
  }
  assert.ok(kept.length > 0, "there MUST be kept modules (the patch must stay minimal)");
});

test("the recorded hashes match the installed upstream package byte for byte", () => {
  const result = checkKeptModules();
  assert.equal(result.ok, true, JSON.stringify(result.comparison));
  assert.equal(result.comparison.drifted.length, 0);
  assert.equal(result.comparison.recordedAggregate, result.comparison.computedAggregate);
  assert.equal(manifest.keptModulesHash, result.computed.aggregate);
  assert.equal(manifest.keptModulesAlgorithm, "sha256");
});

test("the GL-free modules the contract keeps byte-identical are in the kept set", () => {
  const required = [
    "Renderer/ShaderBuilder.js",
    "Renderer/Sampler.js",
    "Renderer/UniformState.js",
    "Renderer/AutomaticUniforms.js",
    "Renderer/DrawCommand.js",
    "Renderer/ClearCommand.js",
    "Renderer/PassState.js",
    "Renderer/Pass.js",
    "Renderer/PixelDatatype.js",
    "Renderer/BufferUsage.js",
    "Renderer/VertexArrayFacade.js",
  ];
  for (const module_ of required) {
    assert.ok(manifest.keptModules[module_] !== undefined, `${module_} MUST be recorded as kept (contract §5 R9: ShaderBuilder stays upstream)`);
  }
});

test("the generator is idempotent and CI-checkable", () => {
  const before = fs.readFileSync(repoPath("packages/cesium-webgpu/backend-webgpu/manifest.json"), "utf8");
  const check = runGenerator(["--check"]);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /no drift/);
  const print = runGenerator(["--print"]);
  assert.equal(print.code, 0, print.stdout + print.stderr);
  const after = fs.readFileSync(repoPath("packages/cesium-webgpu/backend-webgpu/manifest.json"), "utf8");
  assert.equal(after, before, "--check/--print MUST NOT rewrite the manifest");
});

test("an unknown argument is rejected instead of being ignored", () => {
  const { code, stderr } = runGenerator(["--nonsense"]);
  assert.equal(code, 2);
  assert.match(stderr, /unknown argument/);
});

test("a changed byte in a kept module is detected (drift counterexample)", () => {
  const computed = computeKeptModules(undefined, manifest);
  const target = "Renderer/ShaderBuilder.js";
  const tampered = { ...computed, hashes: { ...computed.hashes, [target]: "sha256-" + "0".repeat(64) } };
  const comparison = compareKeptModules(manifest, tampered);
  assert.equal(comparison.unchanged, false);
  assert.deepEqual(comparison.drifted, [target]);

  // Same file set and same byte totals — only the content hash differs.
  assert.deepEqual(tampered.modules, computed.modules);
  assert.notEqual(comparison.recordedAggregate, comparison.computedAggregate);
});

test("an added manifest entry removes that module from the kept set (kept set follows the manifest)", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kept-modules-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "packages", "cesium-webgpu", "backend-webgpu");
  fs.mkdirSync(dir, { recursive: true });

  const extended = structuredClone(manifest);
  extended.entries.push({
    upstreamModule: "Renderer/Sampler.js",
    localFile: "Renderer/Sampler.js",
    kind: "adapt",
    requirementRef: ["FR-030"],
    reason: "fixture: listing a previously kept module must drop it from the kept set",
    glCallSites: 0,
  });
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(extended, null, 2)}\n`, "utf8");

  const result = checkKeptModules({ root });
  assert.equal(result.ok, false, "the recorded set no longer matches the (extended) manifest");
  assert.ok(result.comparison.modulesRemoved.includes("Renderer/Sampler.js"));
  assert.ok(result.comparison.recordedAggregate !== result.comparison.computedAggregate);
});

test("a missing manifest is reported instead of passing silently", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kept-modules-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = checkKeptModules({ root });
  assert.equal(result.ok, false);
  assert.match(result.reason, /manifest not found/);
  assert.equal(result.computed, null);
});

test("the recorded kept set is stable across repeated computations", () => {
  const first = computeKeptModules(undefined, manifest);
  const second = computeKeptModules(undefined, manifest);
  assert.equal(first.aggregate, second.aggregate);
  assert.deepEqual(first.modules, second.modules);
  assert.ok(REPO_ROOT.length > 0);
});
