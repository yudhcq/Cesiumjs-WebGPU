/**
 * T059 — `Sampler` semantics (`层=单元`, tasks.md T059; research §6.1, FR-030).
 *
 * `Renderer/Sampler.js` is a **kept** upstream module (byte-identical, asserted through
 * `manifest.json → keptModules`), so the backend does not replace it — it *reads* it. This suite
 * therefore asserts two separate things:
 *
 *   1. the mapping table covers **every** upstream enum member (a missing entry would silently fall
 *      back to a default filter and change every sampled image), and the GL mipmap enum is split
 *      correctly into WebGPU's `(minFilter, mipmapFilter)` pair;
 *   2. the one upstream member WebGPU cannot honour — `maximumAnisotropy > 1` — is **recorded** and
 *      surfaced (`samplerMappingNotes()`), never dropped (FR-023); and `Sampler.js` really is in the
 *      kept set, so "the backend reads it instead of replacing it" is a checked claim.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readJson, repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assertDiagnostic, installWebgpuGlobals } from "../support/fake-gpu.mjs";
import { upstreamStubs } from "../support/upstream-stubs.mjs";

installWebgpuGlobals();

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function loadSamplerMap() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/sampler-map.ts`), { externals: upstreamStubs() });
}

test("the mapping covers every upstream Wrap / Filter member", async () => {
  const samplerMap = await loadSamplerMap();
  const { TextureWrap } = await import("@cesium/engine/Source/Renderer/TextureWrap.js").then((module_) => ({ TextureWrap: module_.default }));
  const { default: TextureMinificationFilter } = await import("@cesium/engine/Source/Renderer/TextureMinificationFilter.js");
  const { default: TextureMagnificationFilter } = await import("@cesium/engine/Source/Renderer/TextureMagnificationFilter.js");

  const wraps = [TextureWrap.CLAMP_TO_EDGE, TextureWrap.REPEAT, TextureWrap.MIRRORED_REPEAT];
  assert.equal(Object.keys(samplerMap.WRAP_TO_ADDRESS_MODE).length, wraps.length, "all three TextureWrap members MUST be mapped");
  assert.deepEqual(
    wraps.map((wrap) => samplerMap.WRAP_TO_ADDRESS_MODE[wrap]),
    ["clamp-to-edge", "repeat", "mirror-repeat"],
  );

  const minFilters = [
    TextureMinificationFilter.NEAREST,
    TextureMinificationFilter.LINEAR,
    TextureMinificationFilter.NEAREST_MIPMAP_NEAREST,
    TextureMinificationFilter.LINEAR_MIPMAP_NEAREST,
    TextureMinificationFilter.NEAREST_MIPMAP_LINEAR,
    TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
  ];
  assert.equal(Object.keys(samplerMap.MINIFICATION_TO_FILTERS).length, minFilters.length, "all six TextureMinificationFilter members MUST be mapped");
  // GL folds "filter inside a level" and "pick between levels" into one enum; WebGPU splits them.
  assert.deepEqual(samplerMap.MINIFICATION_TO_FILTERS[TextureMinificationFilter.NEAREST_MIPMAP_LINEAR], { minFilter: "nearest", mipmapFilter: "linear" });
  assert.deepEqual(samplerMap.MINIFICATION_TO_FILTERS[TextureMinificationFilter.LINEAR_MIPMAP_NEAREST], { minFilter: "linear", mipmapFilter: "nearest" });
  assert.deepEqual(samplerMap.MINIFICATION_TO_FILTERS[TextureMinificationFilter.LINEAR], { minFilter: "linear", mipmapFilter: "nearest" });

  const magFilters = [TextureMagnificationFilter.NEAREST, TextureMagnificationFilter.LINEAR];
  assert.equal(Object.keys(samplerMap.MAGNIFICATION_TO_FILTER).length, magFilters.length);
  assert.deepEqual(magFilters.map((filter) => samplerMap.MAGNIFICATION_TO_FILTER[filter]), ["nearest", "linear"]);

  for (const member of Object.values(samplerMap.SAMPLER_ENUM_MEMBERS).flat()) {
    assert.ok(member !== undefined, "the exported member list MUST cover the upstream enums");
  }
});

test("a real upstream Sampler maps field-for-field", async () => {
  const samplerMap = await loadSamplerMap();
  const { default: Sampler } = await import("@cesium/engine/Source/Renderer/Sampler.js");
  const { default: TextureWrap } = await import("@cesium/engine/Source/Renderer/TextureWrap.js");
  const { default: TextureMinificationFilter } = await import("@cesium/engine/Source/Renderer/TextureMinificationFilter.js");
  const { default: TextureMagnificationFilter } = await import("@cesium/engine/Source/Renderer/TextureMagnificationFilter.js");

  const defaultMapping = samplerMap.mapSampler(new Sampler());
  assert.deepEqual(
    { ...defaultMapping.descriptor },
    {
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "nearest",
    },
    "upstream's defaults (CLAMP_TO_EDGE x3, LINEAR/LINEAR) MUST survive the mapping unchanged",
  );
  assert.equal(defaultMapping.exact, true);
  assert.deepEqual([...defaultMapping.notes], [], "an exact mapping MUST NOT claim a degradation");

  const nearest = samplerMap.mapSampler(Sampler.NEAREST);
  assert.equal(nearest.descriptor.magFilter, "nearest");
  assert.equal(nearest.descriptor.minFilter, "nearest");
  assert.equal(nearest.exact, true);

  const mipmapped = samplerMap.mapSampler(
    new Sampler({
      wrapS: TextureWrap.MIRRORED_REPEAT,
      wrapT: TextureWrap.REPEAT,
      minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
      magnificationFilter: TextureMagnificationFilter.NEAREST,
    }),
  );
  assert.equal(mipmapped.descriptor.addressModeU, "mirror-repeat");
  assert.equal(mipmapped.descriptor.addressModeV, "repeat");
  assert.equal(mipmapped.descriptor.minFilter, "linear");
  assert.equal(mipmapped.descriptor.mipmapFilter, "linear");
  assert.equal(mipmapped.descriptor.magFilter, "nearest");

  // The descriptor MUST NOT invent members upstream's Sampler has no counterpart for.
  for (const absent of ["lodMinClamp", "lodMaxClamp", "compare", "maxAnisotropy"]) {
    assert.equal(absent in mipmapped.descriptor, false, `${absent} is not an upstream Sampler member and MUST NOT be set`);
  }
});

test("anisotropy > 1 is recorded and surfaced, never silently dropped", async () => {
  const samplerMap = await loadSamplerMap();
  samplerMap.resetSamplerMappingRecords();
  assert.deepEqual([...samplerMap.samplerMappingNotes()], [], "nothing is recorded before a request arrives");

  const mapping = samplerMap.mapSampler({ maximumAnisotropy: 8 });
  assert.equal(mapping.exact, false, "an unhonoured request MUST mark the mapping as inexact");
  assert.ok(mapping.notes.length > 0);
  const records = samplerMap.anisotropyRecords();
  assert.equal(records.length, 1);
  assert.deepEqual({ requested: records[0].requested, applied: records[0].applied, count: records[0].count }, { requested: 8, applied: 1, count: 1 });
  assert.match(records[0].reason, /isotrop/i);

  samplerMap.mapSampler({ maximumAnisotropy: 8 });
  assert.equal(samplerMap.anisotropyRecords()[0].count, 2, "repeated requests are counted, not duplicated");
  assert.equal(samplerMap.samplerMappingNotes().length, 1);
  assert.match(samplerMap.samplerMappingNotes()[0], /maximumAnisotropy=8/);

  samplerMap.resetSamplerMappingRecords();
  assert.deepEqual([...samplerMap.samplerMappingNotes()], []);
});

test("an invalid upstream enum member fails loudly instead of falling back to a default", async () => {
  const samplerMap = await loadSamplerMap();
  for (const [member, patch] of [
    ["wrapS", { wrapS: 0x1234 }],
    ["wrapT", { wrapT: 0x1234 }],
    ["wrapR", { wrapR: 0x1234 }],
    ["minificationFilter", { minificationFilter: 0x9999 }],
    ["magnificationFilter", { magnificationFilter: 0x2703 }],
  ]) {
    assert.throws(() => samplerMap.mapSampler(patch), (error) => {
      assertDiagnostic(error, "internal", member);
      assert.match(error.message, new RegExp(member));
      return true;
    });
  }
});

test("Sampler.js is a KEPT module: the backend reads it, it never replaces it", () => {
  const manifest = readJson(`${BACKEND}/manifest.json`);
  const replaced = manifest.entries.map((entry) => entry.upstreamModule);
  assert.equal(replaced.includes("Renderer/Sampler.js"), false, "T059 MUST NOT add Sampler.js to the replacement manifest");
  assert.ok("Renderer/Sampler.js" in manifest.keptModules, "Sampler.js MUST be in the byte-identical kept set");
  assert.equal(manifest.keptModules["Renderer/Sampler.js"].startsWith("sha256-"), true, "the kept record is a content hash");
  assert.ok(manifest.keptModulesHash.startsWith("sha256-"), "the aggregate hash is recorded for `gen-kept-hash --check`");
});
