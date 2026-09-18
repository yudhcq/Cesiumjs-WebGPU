/**
 * T017 — G-2 capability mapping consistency (`层=单元`, tasks.md T016/T017).
 *
 * Asserts, **without needing a GPU**, that the executable form of research.md §4
 * (`experiments/gates/g2-handoff/capability-map.mjs`) is honest and complete:
 *
 *   1. every capability flag and every `ContextLimits` member declares a **source** for its adopted
 *      value — `adapter.limits.<member>` sources MUST name real `GPUSupportedLimits` members and
 *      `adapter.features.has("<f>")` sources MUST name real `GPUFeatureName` values (both parsed from
 *      the pinned `@webgpu/types`), so a source can never be invented prose;
 *   2. the tables cover exactly the flag set of research §4 and exactly the public members of the
 *      installed upstream `Renderer/ContextLimits.js` (no flag, no limit silently missing);
 *   3. `maximumSamples >= 4`;
 *   4. **no capability may be over-claimed**: every flag answered `false` MUST carry non-empty `notes`
 *      *and* a declared unimplemented branch, and any flag whose `kind` is `unimplemented` MUST be
 *      `false` (MUST NOT 虚报 `true` — research §4);
 *   5. the derivation is exercised deterministically: `composeCapabilities()` is called with a
 *      synthetic `GPUSupportedLimits`/feature set and each value is checked against the formula;
 *   6. when the gate artefact `experiments/gates/out/g2.json` is present (it is gitignored, produced by
 *      `node experiments/gates/g2-handoff/run.mjs`), the recorded device values are cross-checked
 *      against the table; when it is absent the test says so explicitly instead of skipping silently.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { FLAG_TABLE, LIMIT_TABLE, composeCapabilities } from "../../experiments/gates/g2-handoff/capability-map.mjs";
import { readJson, readText, repoPath } from "../support/repo.mjs";

/**
 * research.md §4, first table — the machine encoding of the flag set and the adopted MVP values.
 * (`true`/`false` are the MVP adoption; `derived` entries are computed from adapter capabilities.)
 */
const RESEARCH_FLAGS = {
  webgl2: true,
  msaa: true,
  depthTexture: false,
  fragmentDepth: true,
  instancedArrays: true,
  drawBuffers: true,
  colorBufferFloat: "derived:features",
  colorBufferHalfFloat: true,
  floatingPointTexture: true,
  halfFloatingPointTexture: true,
  stencilBuffer: true,
  stencilBits: 8,
  elementIndexUint: true,
  textureFilterAnisotropic: false,
  s3tc: false,
  pvrtc: false,
  astc: false,
  etc: false,
  etc1: false,
  bc7: false,
  supportsBasis: false,
  standardDerivatives: true,
  blendMinmax: true,
  textureFloatLinear: "derived:features",
  textureHalfFloatLinear: true,
  vertexArrayObject: true,
};

/** Flags research §4 explicitly records as having no external consumer (may have empty `consumers`). */
const NO_EXTERNAL_CONSUMER = new Set(["standardDerivatives", "blendMinmax", "textureFloatLinear", "textureHalfFloatLinear", "vertexArrayObject"]);

/** `ContextLimits` members research §4's second table names explicitly (all others are internal-only). */
const RESEARCH_LIMIT_SOURCES = {
  maximumTextureSize: "adapter.limits.maxTextureDimension2D",
  maximumCubeMapSize: "adapter.limits.maxTextureDimension2D",
  maximum3DTextureSize: "adapter.limits.maxTextureDimension3D",
  maximumVertexTextureImageUnits: "adapter.limits.maxSampledTexturesPerShaderStage",
  maximumTextureImageUnits: "adapter.limits.maxSampledTexturesPerShaderStage",
  maximumCombinedTextureImageUnits: "adapter.limits.maxSampledTexturesPerShaderStage",
  maximumRenderbufferSize: "adapter.limits.maxTextureDimension2D",
  maximumSamples: "constant 4",
  maximumVertexAttributes: "adapter.limits.maxVertexAttributes",
  maximumVaryingVectors: "adapter.limits.maxInterStageShaderVariables",
  maximumAliasedLineWidth: "constant 1.0",
  minimumAliasedLineWidth: "constant 1.0",
  maximumAliasedPointSize: "constant 1.0",
  maximumViewportWidth: "adapter.limits.maxTextureDimension2D",
  maximumViewportHeight: "adapter.limits.maxTextureDimension2D",
  maximumTextureFilterAnisotropy: "constant 1.0",
};

const WEBGPU_TYPES = "node_modules/@webgpu/types/dist/index.d.ts";

/** Member names of `interface GPUSupportedLimits` in the pinned `@webgpu/types`. */
function parseSupportedLimitsMembers() {
  const text = readText(WEBGPU_TYPES);
  const start = text.indexOf("interface GPUSupportedLimits {");
  assert.ok(start >= 0, `@webgpu/types MUST declare GPUSupportedLimits (${WEBGPU_TYPES})`);
  const body = text.slice(start, text.indexOf("}", start));
  return new Set([...body.matchAll(/readonly\s+(\w+)\s*:/g)].map((match) => match[1]));
}

/** Members of the `GPUFeatureName` union in the pinned `@webgpu/types`. */
function parseFeatureNames() {
  const text = readText(WEBGPU_TYPES);
  const start = text.indexOf("type GPUFeatureName =");
  assert.ok(start >= 0, `@webgpu/types MUST declare GPUFeatureName (${WEBGPU_TYPES})`);
  const body = text.slice(start, text.indexOf(";", start));
  return new Set([...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
}

/** Public getter names of the installed upstream `Renderer/ContextLimits.js`. */
function parseUpstreamContextLimitsMembers() {
  const text = readText("node_modules/@cesium/engine/Source/Renderer/ContextLimits.js");
  const declaration = text.slice(text.indexOf("Object.defineProperties(ContextLimits, {"));
  return [...declaration.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((match) => match[1]);
}

function sourcesFromTable() {
  return [...FLAG_TABLE.map((entry) => ({ owner: entry.name, source: entry.source })), ...LIMIT_TABLE.map((entry) => ({ owner: entry.member, source: entry.source }))];
}

/** A synthetic `GPUSupportedLimits` with distinctive values (so a wrong mapping is visible). */
const SYNTHETIC_LIMITS = {
  maxTextureDimension1D: 8192,
  maxTextureDimension2D: 4096,
  maxTextureDimension3D: 1024,
  maxTextureArrayLayers: 256,
  maxBindGroups: 4,
  maxSampledTexturesPerShaderStage: 12,
  maxSamplersPerShaderStage: 10,
  maxStorageBuffersPerShaderStage: 8,
  maxUniformBufferBindingSize: 65536,
  maxVertexAttributes: 17,
  maxInterStageShaderVariables: 21,
  maxColorAttachments: 6,
};

test("every capability flag and ContextLimits member declares where its value comes from", () => {
  const limitMembers = parseSupportedLimitsMembers();
  const featureNames = parseFeatureNames();
  assert.ok(limitMembers.size > 20, `GPUSupportedLimits parsing produced ${limitMembers.size} members`);
  assert.ok(featureNames.size > 5, `GPUFeatureName parsing produced ${featureNames.size} names`);

  for (const { owner, source } of sourcesFromTable()) {
    assert.equal(typeof source, "string", `${owner} MUST declare a non-empty source string`);
    assert.ok(source.trim().length > 0, `${owner} MUST declare a non-empty source string`);
    for (const match of source.matchAll(/adapter\.limits\.(\w+)/g)) {
      assert.ok(limitMembers.has(match[1]), `${owner}: "${match[1]}" is not a GPUSupportedLimits member of @webgpu/types`);
    }
    for (const match of source.matchAll(/adapter\.features\.has\("([^"]+)"\)/g)) {
      assert.ok(featureNames.has(match[1]), `${owner}: "${match[1]}" is not a GPUFeatureName of @webgpu/types`);
    }
  }
});

test("the flag table is exactly the research §4 flag set (no flag missing, none invented)", () => {
  const declared = FLAG_TABLE.map((entry) => entry.name).sort();
  assert.deepEqual(declared, Object.keys(RESEARCH_FLAGS).sort(), "FLAG_TABLE MUST cover research §4's flag set exactly");
  for (const entry of FLAG_TABLE) {
    const expected = RESEARCH_FLAGS[entry.name];
    if (expected === "derived:features") {
      assert.equal(entry.kind, "derived-features", `${entry.name} is derived from adapter capabilities in research §4`);
      assert.equal(typeof entry.derive, "function", `${entry.name} MUST provide a derivation function`);
      assert.match(entry.source, /adapter\.features\.has\(/, `${entry.name} MUST name the feature it derives from`);
    } else {
      assert.equal(entry.value, expected, `${entry.name} adopted value MUST match research §4 (${expected})`);
    }
    if (!NO_EXTERNAL_CONSUMER.has(entry.name)) {
      assert.ok(Array.isArray(entry.consumers) && entry.consumers.length > 0, `${entry.name} MUST list its logic-layer consumption points`);
    }
    assert.ok(typeof entry.researchRef === "string" && entry.researchRef.length > 0, `${entry.name} MUST cite the research §4 row it comes from`);
  }
});

test("the ContextLimits table covers exactly the upstream module's public members", () => {
  const upstreamMembers = parseUpstreamContextLimitsMembers();
  assert.ok(upstreamMembers.length >= 20, `upstream ContextLimits parsing produced ${upstreamMembers.length} members`);
  assert.deepEqual(
    LIMIT_TABLE.map((entry) => entry.member).sort(),
    [...upstreamMembers].sort(),
    "LIMIT_TABLE MUST cover every public member of the installed Renderer/ContextLimits.js",
  );
  for (const entry of LIMIT_TABLE) {
    assert.equal(entry.backing, `_${entry.member}`, `${entry.member} MUST name the upstream backing field it writes`);
    assert.equal(typeof entry.consumers, "number", `${entry.member} MUST record its logic-layer consumer count`);
    assert.ok(typeof entry.note === "string" && entry.note.length > 0, `${entry.member} MUST explain its provenance`);
  }
  for (const [member, expectedSource] of Object.entries(RESEARCH_LIMIT_SOURCES)) {
    const entry = LIMIT_TABLE.find((candidate) => candidate.member === member);
    assert.ok(entry, `research §4 names ${member}`);
    assert.ok(
      entry.source === expectedSource || entry.source.startsWith(`${expectedSource} `) || entry.source.startsWith(`${expectedSource}(`),
      `${member} source MUST match research §4 ("${expectedSource}"), got "${entry.source}"`,
    );
  }
});

test("maximumSamples is at least 4 and derived limits match their formulas", () => {
  const maximumSamples = LIMIT_TABLE.find((entry) => entry.member === "maximumSamples");
  assert.ok(maximumSamples.value >= 4, `maximumSamples MUST be >= 4, got ${maximumSamples.value}`);

  const composed = composeCapabilities({ limits: SYNTHETIC_LIMITS, features: [] });
  assert.equal(composed.limits.maximumTextureSize, SYNTHETIC_LIMITS.maxTextureDimension2D);
  assert.equal(composed.limits.maximumCubeMapSize, SYNTHETIC_LIMITS.maxTextureDimension2D);
  assert.equal(composed.limits.maximum3DTextureSize, SYNTHETIC_LIMITS.maxTextureDimension3D);
  assert.equal(composed.limits.maximumRenderbufferSize, SYNTHETIC_LIMITS.maxTextureDimension2D);
  assert.equal(composed.limits.maximumVertexTextureImageUnits, SYNTHETIC_LIMITS.maxSampledTexturesPerShaderStage);
  assert.equal(composed.limits.maximumTextureImageUnits, SYNTHETIC_LIMITS.maxSampledTexturesPerShaderStage);
  assert.equal(composed.limits.maximumCombinedTextureImageUnits, SYNTHETIC_LIMITS.maxSampledTexturesPerShaderStage);
  assert.equal(composed.limits.maximumVertexAttributes, SYNTHETIC_LIMITS.maxVertexAttributes);
  assert.equal(composed.limits.maximumVaryingVectors, SYNTHETIC_LIMITS.maxInterStageShaderVariables);
  assert.equal(composed.limits.maximumDrawBuffers, SYNTHETIC_LIMITS.maxColorAttachments);
  assert.equal(composed.limits.maximumColorAttachments, SYNTHETIC_LIMITS.maxColorAttachments);
  assert.equal(composed.limits.maximumViewportWidth, SYNTHETIC_LIMITS.maxTextureDimension2D);
  assert.equal(composed.limits.maximumViewportHeight, SYNTHETIC_LIMITS.maxTextureDimension2D);
  assert.equal(composed.limits.maximumVertexUniformVectors, Math.min(Math.floor(SYNTHETIC_LIMITS.maxUniformBufferBindingSize / 16), 4096));
  assert.equal(composed.limits.maximumFragmentUniformVectors, Math.min(Math.floor(SYNTHETIC_LIMITS.maxUniformBufferBindingSize / 16), 4096));
  assert.ok(composed.limits.maximumSamples >= 4, "the composed maximumSamples MUST be >= 4");
  assert.equal(composed.limits.maximumTextureFilterAnisotropy, 1);
  assert.equal(composed.limits.maximumAliasedLineWidth, 1);
});

test("no capability is over-claimed: every false flag has notes and an unimplemented branch", () => {
  const composed = composeCapabilities({ limits: SYNTHETIC_LIMITS, features: [] });
  for (const entry of FLAG_TABLE) {
    const value = composed.flags[entry.name];
    assert.ok(typeof entry.notes === "string" && entry.notes.trim().length > 0, `${entry.name} MUST carry notes explaining the adopted value`);
    if (value === false) {
      const branch = composed.unimplementedBranches[entry.name] ?? entry.unimplementedBranch ?? entry.falseBranch ?? "";
      assert.ok(branch.trim().length > 0, `${entry.name} is false and MUST declare the unimplemented branch the logic layer takes`);
    }
    if (entry.kind === "unimplemented") {
      assert.equal(value, false, `${entry.name} is declared unimplemented and MUST NOT be reported as available (MUST NOT 虚报 true)`);
    }
    if (value === true) {
      assert.doesNotMatch(
        entry.source,
        /not implemented|unimplemented|no anisotropic/i,
        `${entry.name} is answered true but its source says it is not implemented — that would be over-claiming`,
      );
    }
  }
  assert.ok(composed.falseFlags.includes("depthTexture"), "slice A records depthTexture as false (temporary; flips in slice B / T098a)");
  const depthTexture = FLAG_TABLE.find((entry) => entry.name === "depthTexture");
  assert.match(depthTexture.notes, /slice[- ]?A/i, "the depthTexture note MUST state that the false value belongs to slice A");
  assert.match(depthTexture.notes, /T098a|slice B/i, "the depthTexture note MUST register the slice-B flip (T098a)");
});

test("feature-derived capabilities follow the adapter feature set", () => {
  const withFeature = composeCapabilities({ limits: SYNTHETIC_LIMITS, features: ["float32-blendable", "float32-filterable"] });
  assert.equal(withFeature.flags.colorBufferFloat, true);
  assert.equal(withFeature.flags.textureFloatLinear, true);
  const withoutFeature = composeCapabilities({ limits: SYNTHETIC_LIMITS, features: [] });
  assert.equal(withoutFeature.flags.colorBufferFloat, false);
  assert.equal(withoutFeature.flags.textureFloatLinear, false);
  assert.ok(withoutFeature.falseFlags.includes("colorBufferFloat"));
  assert.ok(withoutFeature.unimplementedBranches.colorBufferFloat.length > 0, "a false derived capability MUST still declare its branch");
});

test("the recorded gate artefact (when present) agrees with the mapping table", (t) => {
  const artifactPath = repoPath("experiments/gates/out/g2.json");
  if (!fs.existsSync(artifactPath)) {
    t.diagnostic(
      "experiments/gates/out/g2.json is absent (gate artefacts are gitignored and produced by " +
        "`node experiments/gates/g2-handoff/run.mjs`): the static mapping assertions above still ran, " +
        "but the measured cross-check was not performed in this environment.",
    );
    return;
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.equal(artifact.gate, "g2");
  assert.equal(artifact.verdict, "pass", "the recorded G-2 verdict MUST be pass for the cross-check to mean anything");
  const webgpu = artifact.measurements?.webgpu;
  assert.ok(webgpu, "the artefact MUST carry the WebGPU probe report");
  const recorded = webgpu.capabilities?.stubSnapshot ?? {};
  const recordedLimits = webgpu.capabilities?.stubLimitsSnapshot ?? {};
  const recomposed = composeCapabilities({ limits: webgpu.prefetch?.limits ?? SYNTHETIC_LIMITS, features: webgpu.prefetch?.features ?? [], slice: "A" });
  for (const entry of FLAG_TABLE) {
    assert.equal(recorded[entry.name], recomposed.flags[entry.name], `recorded flag ${entry.name} MUST equal the recomposed value`);
  }
  for (const entry of LIMIT_TABLE) {
    assert.equal(recordedLimits[entry.member], recomposed.limits[entry.member], `recorded ${entry.member} MUST equal the recomposed value`);
  }
  assert.ok(recordedLimits.maximumSamples >= 4, `recorded maximumSamples MUST be >= 4, got ${recordedLimits.maximumSamples}`);
  assert.equal(recordedLimits.maximumTextureSize, webgpu.prefetch.limits.maxTextureDimension2D, "maximumTextureSize MUST come from the device limits");
  for (const name of recomposed.falseFlags) {
    assert.equal(recorded[name], false, `recorded ${name} MUST be false`);
    assert.ok((recomposed.unimplementedBranches[name] ?? "").length > 0, `${name} MUST declare its unimplemented branch`);
  }
  const writes = webgpu.contextLimits?.writesDuringConstruction ?? [];
  assert.equal(writes.length, LIMIT_TABLE.length, "the replacement MUST publish every ContextLimits member during construction");
  assert.deepEqual(
    [...new Set(writes.map((entry) => entry.member))].sort(),
    LIMIT_TABLE.map((entry) => entry.backing).sort(),
    "the published ContextLimits members MUST be exactly the table's backing fields",
  );
  for (const entry of writes) {
    assert.equal(entry.phase, "construction", `${entry.member} MUST be published during Scene construction (synchronous publication)`);
  }
});
