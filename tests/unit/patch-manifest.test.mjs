/**
 * T031 — replacement manifest (`packages/cesium-webgpu/backend-webgpu/manifest.json`).
 *
 * The manifest is the machine-readable patch boundary: 16 modules that MUST be replaced
 * (11 `replace` + 5 `stub-not-implemented`, tasks.md T031/T053) plus 7 adaptation entries.
 * Every assertion here is derived from the installed upstream source and the contract rules
 * (contract fork-patch-layer.md §2), never from a hand-copied list:
 *   - `^Renderer/[A-Za-z0-9_]+\.js$` boundary, non-empty `requirementRef`/`reason`;
 *   - four-valued `kind` (replace / adapt / adapt-shader / stub-not-implemented);
 *   - `glCallSites > 0` **for `replace` only**, and equal to the freshly measured count;
 *   - the stub set is exactly the slice-C stub list of T053, each with a reason.
 *
 * `localFile` existence is deliberately NOT asserted here: the replacement modules land in
 * T037 and the build/audit tasks (T033/T034/T041) validate them.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { REPO_ROOT, readJson } from "../support/repo.mjs";
import {
  ADAPT_MODULES,
  KINDS,
  REPLACE_MODULES,
  STUB_MODULES,
  UPSTREAM_MODULE_PATTERN,
  listRendererModules,
  readGlCallSites,
  validatePatchManifest,
} from "../../tools/lib/patch-layer.mjs";

const manifest = readJson("packages/cesium-webgpu/backend-webgpu/manifest.json");
const entries = manifest.entries;
const byModule = new Map(entries.map((entry) => [entry.upstreamModule, entry]));

const REQUIRED_REPLACEMENTS = [
  "Renderer/Context.js",
  "Renderer/Texture.js",
  "Renderer/ShaderProgram.js",
  "Renderer/Texture3D.js",
  "Renderer/CubeMap.js",
  "Renderer/CubeMapFace.js",
  "Renderer/RenderState.js",
  "Renderer/Buffer.js",
  "Renderer/createUniform.js",
  "Renderer/createUniformArray.js",
  "Renderer/VertexArray.js",
  "Renderer/Framebuffer.js",
  "Renderer/Renderbuffer.js",
  "Renderer/TextureAtlas.js",
  "Renderer/MultisampleFramebuffer.js",
  "Renderer/Sync.js",
];

const REQUIRED_ADAPTATIONS = [
  "Renderer/ShaderCache.js",
  "Renderer/ShaderSource.js",
  "Renderer/FramebufferManager.js",
  "Renderer/ComputeEngine.js",
  "Renderer/SharedContext.js",
  "Renderer/TextureCache.js",
  "Renderer/loadCubeMap.js",
];

test("every entry stays inside the Renderer/** patch boundary and carries a traceable reason", () => {
  assert.ok(entries.length > 0, "the manifest MUST not be empty");
  for (const entry of entries) {
    assert.match(entry.upstreamModule, UPSTREAM_MODULE_PATTERN, `${entry.upstreamModule} violates the patch boundary`);
    assert.ok(Array.isArray(entry.requirementRef) && entry.requirementRef.length > 0, `${entry.upstreamModule} MUST carry requirementRef`);
    for (const ref of entry.requirementRef) assert.match(ref, /^FR-\d{3}$/, `${entry.upstreamModule} requirementRef "${ref}" MUST be an FR id`);
    assert.ok(typeof entry.reason === "string" && entry.reason.trim().length > 10, `${entry.upstreamModule} MUST explain why it is patched`);
    assert.equal(typeof entry.localFile, "string", `${entry.upstreamModule} MUST declare a localFile`);
    assert.match(entry.localFile, /^Renderer\/[A-Za-z0-9_]+\.(ts|js|mts|cts)$/, `${entry.upstreamModule} localFile MUST stay under Renderer/`);
  }
  assert.equal(byModule.size, entries.length, "no duplicate upstreamModule entries");
});

test("kind uses the four contract values only", () => {
  for (const entry of entries) {
    assert.ok(KINDS.includes(entry.kind), `${entry.upstreamModule} kind "${entry.kind}" MUST be one of ${KINDS.join(" / ")}`);
  }
});

test("the 16 mandatory replacements are present: 11 replace + 5 stub-not-implemented", () => {
  for (const module_ of REQUIRED_REPLACEMENTS) {
    assert.ok(byModule.has(module_), `${module_} MUST be listed in the replacement manifest`);
  }
  const replaceEntries = entries.filter((entry) => entry.kind === "replace");
  assert.deepEqual(
    replaceEntries.map((entry) => entry.upstreamModule).sort(),
    [...REPLACE_MODULES].sort(),
    "the replace set MUST be the 11 modules that touch WebGL and are reimplemented",
  );
  assert.equal(replaceEntries.length, 11);
  const stubEntries = entries.filter((entry) => entry.kind === "stub-not-implemented");
  assert.equal(stubEntries.length, 5, "five modules are delivered as explicit-failure stubs");
});

test("stub-not-implemented entries equal the slice-C stub list of T053 and each carries a reason", () => {
  const stubs = entries.filter((entry) => entry.kind === "stub-not-implemented").map((entry) => entry.upstreamModule).sort();
  assert.deepEqual(stubs, [...STUB_MODULES].sort());
  for (const entry of entries.filter((item) => item.kind === "stub-not-implemented")) {
    assert.ok(typeof entry.reason === "string" && entry.reason.trim().length > 0, `${entry.upstreamModule} MUST state why it stops at a stub`);
    assert.ok(entry.requirementRef.includes("FR-033"), `${entry.upstreamModule} MUST trace to FR-033 (explicit, diagnosable failure)`);
    assert.ok(/桩/.test(entry.reason), `${entry.upstreamModule} MUST say that only an explicit-failure stub is delivered`);
  }
  // `glCallSites > 0` MUST NOT be asserted for this kind (contract §2 rule 3) — the assertion is
  // inverted here on purpose: these modules DO have GL call sites, and that is not a violation.
  for (const entry of entries.filter((item) => item.kind === "stub-not-implemented")) {
    assert.ok(entry.glCallSites > 0, `${entry.upstreamModule} is a GL-touching module (evidence), yet is allowed to be a stub`);
  }
});

test("replace entries carry a glCallSites count larger than zero", () => {
  for (const entry of entries.filter((item) => item.kind === "replace")) {
    assert.ok(Number.isInteger(entry.glCallSites) && entry.glCallSites > 0, `${entry.upstreamModule} MUST record glCallSites > 0`);
  }
});

test("recorded glCallSites reproduce the measured WebGL call-site count of the installed 26.3.0", () => {
  let total = 0;
  for (const entry of entries) {
    const measured = readGlCallSites(undefined, entry.upstreamModule);
    assert.notEqual(measured, null, `${entry.upstreamModule} MUST exist in the installed upstream package`);
    assert.equal(entry.glCallSites, measured, `${entry.upstreamModule} glCallSites ${entry.glCallSites} != measured ${measured}`);
    total += measured;
  }
  const mandatory = entries.filter((entry) => REQUIRED_REPLACEMENTS.includes(entry.upstreamModule));
  assert.equal(
    mandatory.reduce((sum, entry) => sum + entry.glCallSites, 0),
    348,
    "the 16 mandatory replacements MUST account for the 348 WebGL call sites of research.md §1.1",
  );
  assert.equal(total, 348, "the adaptation entries add no WebGL call sites");
});

test("the 7 adaptation entries are present with the documented kinds", () => {
  for (const module_ of REQUIRED_ADAPTATIONS) {
    assert.ok(byModule.has(module_), `${module_} MUST be listed as an adaptation entry`);
  }
  assert.equal(byModule.get("Renderer/ShaderSource.js").kind, "adapt-shader", "the shader compile target is parameterised, not reimplemented");
  for (const module_ of REQUIRED_ADAPTATIONS.filter((name) => name !== "Renderer/ShaderSource.js")) {
    assert.equal(byModule.get(module_).kind, "adapt", `${module_} is a semantic adaptation entry`);
  }
  assert.deepEqual([...ADAPT_MODULES].sort(), [...REQUIRED_ADAPTATIONS].sort());
});

test("the manifest covers exactly 16 + 7 upstream modules and no other Renderer module", () => {
  const rendererModules = listRendererModules();
  assert.ok(rendererModules.length > 40, "the installed upstream Renderer directory MUST be present");
  for (const entry of entries) {
    assert.ok(rendererModules.includes(entry.upstreamModule), `${entry.upstreamModule} MUST exist in the installed upstream package`);
  }
  assert.equal(entries.length, 23, "16 mandatory replacements + 7 adaptations");
  const kept = rendererModules.filter((module_) => !byModule.has(module_));
  assert.ok(kept.includes("Renderer/ShaderBuilder.js"), "ShaderBuilder.js MUST stay upstream (contract §5 R9)");
  assert.ok(kept.includes("Renderer/UniformState.js") && kept.includes("Renderer/AutomaticUniforms.js"));
});

test("the baseline block repeats the pinned upstream release", () => {
  const baseline = readJson("upstream/engine-26.3.0.lock.json");
  assert.equal(manifest.baseline.packageName, baseline.packageName);
  assert.equal(manifest.baseline.version, baseline.version);
  assert.equal(manifest.baseline.cesiumVersion, baseline.cesiumVersion);
  assert.equal(manifest.baseline.integrity, baseline.integrity, "the manifest MUST repeat the recorded integrity hash");
  assert.equal(manifest.baseline.license, baseline.license);
});

test("the shared validator accepts the committed manifest (and reports what it checks)", () => {
  // `localFile` existence is checked once the replacement modules land (T037/T041), so the
  // manifest-level validation here is deliberately root-agnostic.
  const result = validatePatchManifest(manifest, { enforceStubSet: true });
  assert.deepEqual(result.violations, [], "the committed manifest MUST satisfy the contract rules");
  assert.equal(result.ok, true);
});

test("the shared validator rejects a manifest that leaves the renderer boundary", () => {
  const result = validatePatchManifest(
    {
      entries: [
        {
          upstreamModule: "Scene/Scene.js",
          localFile: "Scene/Scene.js",
          kind: "replace",
          requirementRef: ["FR-030"],
          reason: "a logic-layer override would violate principle I",
          glCallSites: 1,
        },
      ],
    },
    { enforceStubSet: false },
  );
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => /patch boundary/.test(violation.detail)));
});

test("the shared validator rejects a replace entry without measured GL call sites", () => {
  const result = validatePatchManifest(
    {
      entries: [
        {
          upstreamModule: "Renderer/ShaderSource.js",
          localFile: "Renderer/ShaderSource.js",
          kind: "replace",
          requirementRef: ["FR-030"],
          reason: "wrong kind on purpose",
          glCallSites: 0,
        },
      ],
    },
    { enforceStubSet: false },
  );
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => /glCallSites > 0/.test(violation.detail)));
});
