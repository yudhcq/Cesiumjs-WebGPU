/**
 * T045 — capability composition (`层=单元`, tasks.md T045; research §4, data-model §3.1/§3.2, FR-030/FR-023).
 *
 * Every published flag must name the WebGPU fact it came from, every `false` must carry the upstream
 * branch it selects (never a silent downgrade), and the slice-B consistency invariant must exist and
 * be enforced (`sliceBComplete === true ⇒ depthTexture === true`, data-model §11 A8).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { FAKE_LIMITS, createFakeAdapter } from "../support/fake-gpu.mjs";
import { CONTEXT_LIMITS_MEMBERS } from "../support/upstream-stubs.mjs";

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function loadCapability() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/capability.ts`));
}

test("slice A publishes every research §4 flag with a declared provenance", async () => {
  const capability = await loadCapability();
  const adapter = createFakeAdapter();
  const composed = capability.composeCapabilities(adapter, { slice: "A" });

  for (const [name, entry] of Object.entries(composed.provenance)) {
    assert.equal(typeof entry.source, "string", `${name} MUST declare where its value came from`);
    assert.ok(entry.source.length > 0, `${name} MUST have a non-empty source`);
    const published = composed.capabilities[name] ?? composed.limits[name];
    assert.equal(published, entry.value, `the published value of ${name} MUST equal its provenance entry`);
  }
  for (const flag of Object.keys(composed.capabilities)) {
    assert.ok(composed.provenance[flag] !== undefined, `published flag ${flag} MUST have a provenance entry`);
  }
  for (const member of CONTEXT_LIMITS_MEMBERS) {
    assert.ok(composed.provenance[member] !== undefined, `ContextLimits member ${member} MUST have a provenance entry`);
  }
  assert.equal(composed.slice, "A");
  assert.equal(composed.sliceBComplete, false);
  assert.equal(composed.capabilities.webgl2, true, "`webgl2` is true: modern pipeline capabilities are available");
  assert.equal(composed.capabilities.msaa, true);
  assert.equal(composed.capabilities.fragmentDepth, true);
  assert.equal(composed.capabilities.stencilBits, 8);
  assert.equal(composed.capabilities.elementIndexUint, true);
});

test("every false capability carries notes (FR-023) — no silent downgrade", async () => {
  const capability = await loadCapability();
  const composed = capability.composeCapabilities(createFakeAdapter(), { slice: "A" });
  assert.ok(composed.falseFlags.length > 0, "slice A deliberately ships false capabilities; the list MUST be enumerable");
  for (const flag of composed.falseFlags) {
    assert.ok(typeof composed.notes[flag] === "string" && composed.notes[flag].length > 10, `${flag} is false and MUST carry a branch note`);
  }
  assert.ok(composed.falseFlags.includes("depthTexture"), "depthTexture is the one temporary slice-A degradation");
  assert.ok(composed.falseFlags.includes("textureFilterAnisotropic"));
  for (const family of ["s3tc", "pvrtc", "astc", "etc", "etc1", "bc7"]) {
    assert.ok(composed.falseFlags.includes(family), `${family} MUST be false in this increment`);
  }
});

test("derived flags follow the adapter's optional features in both directions", async () => {
  const capability = await loadCapability();
  const withFeatures = capability.composeCapabilities(createFakeAdapter({ features: ["float32-filterable", "float32-blendable"] }));
  assert.equal(withFeatures.capabilities.colorBufferFloat, true, "float32-blendable ⇒ colorBufferFloat");
  assert.equal(withFeatures.capabilities.textureFloatLinear, true, "float32-filterable ⇒ textureFloatLinear");
  assert.equal(withFeatures.provenance.colorBufferFloat.source, 'adapter.features.has("float32-blendable")');

  const without = capability.composeCapabilities(createFakeAdapter({ features: [] }));
  assert.equal(without.capabilities.colorBufferFloat, false);
  assert.equal(without.capabilities.textureFloatLinear, false);
  assert.ok(without.notes.colorBufferFloat.length > 0, "a false derived flag MUST still declare its branch");
});

test("ContextLimits are derived from the measured adapter limits (not hard-coded)", async () => {
  const capability = await loadCapability();
  const composed = capability.composeCapabilities(createFakeAdapter({ limits: { ...FAKE_LIMITS, maxTextureDimension2D: 4096, maxColorAttachments: 4 } }));
  assert.equal(composed.limits.maximumTextureSize, 4096);
  assert.equal(composed.limits.maximumCubeMapSize, 4096, "cube faces are 2D textures");
  assert.equal(composed.limits.maximumDrawBuffers, 4);
  assert.equal(composed.limits.maximumColorAttachments, 4);
  assert.equal(composed.limits.maximumSamples, 4, "WebGPU guarantees 4x MSAA");
  assert.equal(composed.limits.maximumAliasedLineWidth, 1, "WebGPU has no wide lines (T049 relies on this)");
  assert.equal(composed.limits.maximumTextureFilterAnisotropy, 1);
  assert.equal(composed.limits.highpFloatSupported, true);
});

test("all 23 ContextLimits members are published, and publication refuses a drifted module", async () => {
  const capability = await loadCapability();
  const composed = capability.composeCapabilities(createFakeAdapter());
  const target = {};
  for (const member of CONTEXT_LIMITS_MEMBERS) target[`_${member}`] = 0;
  const written = capability.applyContextLimits(composed.limits, target);
  assert.equal(written.length, 23, "all 23 upstream members MUST be written during construction (G-2 check)");
  assert.equal(CONTEXT_LIMITS_MEMBERS.length, 23);
  assert.equal(target._maximumTextureSize, composed.limits.maximumTextureSize);
  assert.equal(target._highpIntSupported, true);

  const drifted = { ...target };
  delete drifted._maximumDrawBuffers;
  assert.throws(() => capability.applyContextLimits(composed.limits, drifted), /ContextLimits publication failed/);
});

test("slice B has no degradation, and the consistency invariant is enforced", async () => {
  const capability = await loadCapability();
  const sliceB = capability.composeCapabilities(createFakeAdapter(), { slice: "B" });
  assert.equal(sliceB.capabilities.depthTexture, true);
  assert.equal(sliceB.sliceBComplete, true);

  assert.throws(
    () => capability.assertSliceConsistency({ depthTexture: false }, true),
    /sliceBComplete === true requires depthTexture === true/,
    "the invariant MUST be a real predicate, not a comment",
  );
  assert.doesNotThrow(() => capability.assertSliceConsistency({ depthTexture: true }, true));
  assert.doesNotThrow(() => capability.assertSliceConsistency({ depthTexture: false }, false));
  assert.equal(capability.SLICE_PROFILES.sliceA.depthTexture, false);
  assert.ok(capability.SLICE_PROFILES.sliceA.notes.length > 0, "the switched-off capability MUST carry a note");
});

test("composing without an adapter fails loudly instead of guessing", async () => {
  const capability = await loadCapability();
  assert.throws(() => capability.composeCapabilities(null), (error) => {
    assert.equal(error.name, "DiagnosticError");
    assert.equal(error.category, "probe-failed");
    return true;
  });
});
