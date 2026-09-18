/**
 * T034 — build-product audit (`tools/scripts/check-build-layer-source.mjs`).
 *
 * The delivered bundles are the last place where a logic-layer override could hide. The audit
 * consumes the provenance artifacts the build writes and asserts `logicLayerOverrides === 0`; the
 * decisive counterexample is an injected `Scene/Scene.js` copy in the module graph, which MUST be
 * reported (this is exactly the SC-010 violation the rule exists for).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, readJson, repoPath } from "../support/repo.mjs";
import { checkBuildLayerSource } from "../../tools/scripts/check-build-layer-source.mjs";
import { makePatchFixture, makeProvenance } from "../support/patch-fixture.mjs";

const CHECKER = repoPath("tools/scripts/check-build-layer-source.mjs");

function runChecker(args = []) {
  const result = spawnSync(process.execPath, [CHECKER, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("the repository passes and prints logicLayerOverrides: 0", () => {
  const { code, stdout } = runChecker([]);
  assert.equal(code, 0, `${stdout}`);
  assert.match(stdout, /logicLayerOverrides: 0/);
  const report = readJson("artifacts/build-layer-source.json");
  assert.equal(report.verdict, "pass");
  assert.equal(report.logicLayerOverrides, 0);
  assert.ok(report.provenance.artifacts.length >= 1, "the audit MUST have consumed real bundle provenance");
  assert.equal(report.manifestLocalFiles.missing.length, 0, "every manifest localFile MUST exist (T037)");
  assert.equal(report.manifestLocalFiles.outsideRenderer.length, 0);
});

test("every manifest entry still exists in the installed upstream package", () => {
  const report = checkBuildLayerSource();
  assert.deepEqual(
    report.violations.filter((violation) => /does not exist in the installed upstream package/.test(violation)),
    [],
  );
  assert.equal(report.manifestLocalFiles.declared, readJson("packages/cesium-webgpu/backend-webgpu/manifest.json").entries.length);
});

test("a repository copy of Scene/Scene.js in the bundle fails the audit (counterexample)", (t) => {
  const fixture = makePatchFixture({
    provenance: makeProvenance({
      repoModules: ["packages/cesium-webgpu/src/index.ts"],
      patchLayerModules: [
        "packages/cesium-webgpu/backend-webgpu/Renderer/Context.ts",
        "packages/cesium-webgpu/backend-webgpu/Scene/Scene.js",
      ],
    }),
  });
  t.after(fixture.cleanup);

  const report = checkBuildLayerSource({ root: fixture.root });
  assert.equal(report.logicLayerOverrides, 1, JSON.stringify(report.overrides));
  assert.equal(report.overrides[0].module, "Scene/Scene.js");
  assert.equal(report.verdict, "fail");
  assert.ok(report.violations.some((violation) => /logicLayerOverride \(bundle\): Scene\/Scene\.js/.test(violation)));

  const { code, stderr } = runChecker(["--root", fixture.root, "--out", path.join(fixture.root, "artifacts", "build-layer-source.json")]);
  assert.equal(code, 1, stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.root, "artifacts", "build-layer-source.json"), "utf8")).verdict, "fail");
});

test("a renderer replacement in the bundle is NOT an override", (t) => {
  const fixture = makePatchFixture({
    provenance: makeProvenance({ patchLayerModules: ["packages/cesium-webgpu/backend-webgpu/Renderer/Context.ts"] }),
  });
  t.after(fixture.cleanup);

  const report = checkBuildLayerSource({ root: fixture.root });
  assert.equal(report.logicLayerOverrides, 0, JSON.stringify(report.overrides));
  assert.equal(report.verdict, "pass");
});

test("without a build artifact the check refuses to pass vacuously", (t) => {
  const fixture = makePatchFixture();
  t.after(fixture.cleanup);

  const report = checkBuildLayerSource({ root: fixture.root });
  assert.equal(report.verdict, "fail");
  assert.ok(report.violations.some((violation) => /no bundle provenance artifact/.test(violation)));

  const { code, stderr } = runChecker(["--root", fixture.root]);
  assert.equal(code, 2, "a missing build artifact MUST exit 2 (cannot run), never 0");
  assert.match(stderr, /cannot run yet/);
});

test("a manifest localFile that does not exist yet is reported", (t) => {
  const fixture = makePatchFixture({ removeLocalFiles: ["Renderer/Sampler.ts"] });
  t.after(fixture.cleanup);

  const report = checkBuildLayerSource({ root: fixture.root });
  assert.equal(report.verdict, "fail");
  assert.deepEqual(report.manifestLocalFiles.missing, ["Renderer/Sampler.js"]);
});

test("a manifest entry whose upstream module disappeared is reported (upgrade drift)", (t) => {
  const fixture = makePatchFixture({
    entries: [
      {
        upstreamModule: "Renderer/Context.js",
        localFile: "Renderer/Context.js",
        kind: "replace",
        requirementRef: ["FR-030"],
        reason: "fixture: legitimate entry",
        glCallSites: 2,
      },
      {
        upstreamModule: "Renderer/Vanished.js",
        localFile: "Renderer/Vanished.js",
        kind: "adapt",
        requirementRef: ["FR-030"],
        reason: "fixture: the upstream module is gone in this tree",
        glCallSites: 0,
      },
    ],
    localFiles: { "Renderer/Vanished.ts": "export default function Vanished() {}\n" },
    provenance: makeProvenance({ patchLayerModules: ["packages/cesium-webgpu/backend-webgpu/Renderer/Context.ts"] }),
  });
  t.after(fixture.cleanup);

  const report = checkBuildLayerSource({ root: fixture.root });
  assert.ok(report.violations.some((violation) => /Renderer\/Vanished\.js does not exist in the installed upstream package/.test(violation)));
  assert.equal(report.verdict, "fail");
});

test("the provenance counts and the audit record are written for CI", (t) => {
  const fixture = makePatchFixture({ provenance: makeProvenance({ engineModuleCount: 12 }) });
  t.after(fixture.cleanup);

  const out = path.join(fixture.root, "artifacts", "custom-build-layer.json");
  const { code, stdout } = runChecker(["--root", fixture.root, "--out", out]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /upstream modules in bundles: 12/);
  const written = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(written.provenance.engineModulesEmbedded, 12);

  const bad = runChecker(["--nonsense"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown argument/);
  assert.ok(REPO_ROOT.length > 0);
});
