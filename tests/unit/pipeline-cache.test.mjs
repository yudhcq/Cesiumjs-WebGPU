/**
 * T048 — pipeline cache (`层=单元`, tasks.md T048; research §5.3, data-model §4.2).
 *
 * The cache key exists to prevent *reusing the wrong pipeline*, so the assertions are about coverage,
 * not about hashing: the fingerprint MUST change for **every** field upstream `RenderState` carries
 * (the field list is read from the installed upstream module, not copied by hand), the hit/miss
 * counters MUST be exact, and the three combinations WebGPU cannot express MUST raise a diagnosable
 * error rather than be silently dropped.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";

const BACKEND = "packages/cesium-webgpu/backend-webgpu";
const UPSTREAM_RENDER_STATE = "node_modules/@cesium/engine/Source/Renderer/RenderState.js";

async function loadCache() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/pipeline-cache.ts`));
}

/** The `this.<field> = …` assignments of upstream's `RenderState` constructor. */
function upstreamRenderStateFields() {
  const source = fs.readFileSync(repoPath(UPSTREAM_RENDER_STATE), "utf8");
  const constructorStart = source.indexOf("function RenderState(renderState)");
  assert.ok(constructorStart > 0, "the upstream RenderState constructor MUST be locatable");
  const constructorBody = source.slice(constructorStart, source.indexOf("\nlet nextRenderStateId", constructorStart));
  const fields = new Set();
  for (const match of constructorBody.matchAll(/^\s{2}this\.([A-Za-z_][\w]*)\s*=/gm)) fields.add(match[1]);
  return [...fields].sort();
}

const KEY = {
  shaderProgramId: "program-1",
  renderStateFingerprint: "rs",
  vertexLayoutFingerprint: "vl",
  topology: "triangle-list",
  colorFormats: ["bgra8unorm"],
  depthFormat: null,
  sampleCount: 1,
};

test("the fingerprint covers every field upstream RenderState carries", async () => {
  const cache = await loadCache();
  const upstream = upstreamRenderStateFields();
  assert.ok(upstream.length >= 14, `upstream RenderState MUST expose its field list (got ${upstream.length})`);
  const declared = new Set(cache.RENDER_STATE_FIELDS);
  const missing = upstream.filter((field) => !declared.has(field) && field !== "id" && field !== "_applyFunctions");
  assert.deepEqual(missing, [], `every upstream RenderState field MUST be in RENDER_STATE_FIELDS (missing: ${missing.join(", ")})`);

  // A real counter-example: change one field at a time and require a different fingerprint.
  const base = { frontFace: 0x0901, cull: { enabled: true, face: 0x0405 }, lineWidth: 1, polygonOffset: { enabled: false, factor: 0, units: 0 }, scissorTest: { enabled: false, rectangle: { x: 0, y: 0, width: 10, height: 10 } }, depthRange: { near: 0, far: 1 }, depthTest: { enabled: true, func: 0x0201 }, colorMask: { red: true, green: true, blue: true, alpha: true }, depthMask: true, stencilMask: 0xffffffff, blending: { enabled: false }, stencilTest: { enabled: false }, sampleCoverage: { enabled: false, value: 1, invert: false }, viewport: { x: 0, y: 0, width: 10, height: 10 } };
  const baseFingerprint = cache.renderStateFingerprint(base);
  const mutations = {
    frontFace: { ...base, frontFace: 0x0900 },
    "cull.enabled": { ...base, cull: { enabled: false, face: 0x0405 } },
    "cull.face": { ...base, cull: { enabled: true, face: 0x0404 } },
    "polygonOffset.enabled": { ...base, polygonOffset: { enabled: true, factor: 0, units: 0 } },
    "polygonOffset.factor": { ...base, polygonOffset: { enabled: false, factor: 1, units: 0 } },
    "polygonOffset.units": { ...base, polygonOffset: { enabled: false, factor: 0, units: 2 } },
    "scissorTest.enabled": { ...base, scissorTest: { enabled: true, rectangle: { x: 0, y: 0, width: 10, height: 10 } } },
    "scissorTest.rectangle": { ...base, scissorTest: { enabled: false, rectangle: { x: 1, y: 0, width: 10, height: 10 } } },
    "depthTest.enabled": { ...base, depthTest: { enabled: false, func: 0x0201 } },
    "depthTest.func": { ...base, depthTest: { enabled: true, func: 0x0203 } },
    colorMask: { ...base, colorMask: { red: false, green: true, blue: true, alpha: true } },
    depthMask: { ...base, depthMask: false },
    stencilMask: { ...base, stencilMask: 0x00ff },
    "blending.enabled": { ...base, blending: { enabled: true } },
    "stencilTest.enabled": { ...base, stencilTest: { enabled: true } },
    "sampleCoverage.value": { ...base, sampleCoverage: { enabled: false, value: 0.5, invert: false } },
    viewport: { ...base, viewport: { x: 0, y: 0, width: 11, height: 10 } },
  };
  for (const [field, mutated] of Object.entries(mutations)) {
    assert.notEqual(cache.renderStateFingerprint(mutated), baseFingerprint, `changing ${field} MUST change the fingerprint`);
  }
});

test("unsupported RenderState combinations raise a diagnosable error", async () => {
  const cache = await loadCache();
  assert.throws(() => cache.assertPipelineSupported({ lineWidth: 2 }), (error) => {
    assert.equal(error.name, "DiagnosticError");
    assert.equal(error.category, "not-implemented");
    assert.match(error.message, /lineWidth=2/);
    return true;
  });
  assert.throws(() => cache.assertPipelineSupported({ lineWidth: 1, sampleCoverage: { enabled: true } }), /sampleCoverage\.enabled=true/);
  assert.throws(() => cache.assertPipelineSupported({ lineWidth: 1, depthRange: { near: 0.1, far: 1 } }), /depthRange=\(0\.1, 1\)/);
  assert.doesNotThrow(() => cache.assertPipelineSupported({ lineWidth: 1, sampleCoverage: { enabled: false }, depthRange: { near: 0, far: 1 } }));
  assert.throws(() => cache.renderStateFingerprint({ lineWidth: 3 }), /lineWidth=3/, "the fingerprint MUST reject unsupported states too");
});

test("hit/miss counters are exact and a factory is required to build", async () => {
  const cache = await loadCache();
  cache.clear();
  let built = 0;
  const factory = (key) => {
    built += 1;
    return { __key: key };
  };
  const first = cache.getOrCreate(KEY, factory);
  assert.equal(built, 1);
  assert.equal(first.misses, 1);
  assert.equal(first.hits, 0);
  const second = cache.getOrCreate(KEY, factory);
  assert.equal(built, 1, "the identical key MUST NOT rebuild the pipeline");
  assert.equal(second.pipeline, first.pipeline);
  assert.equal(second.hits, 1);

  cache.getOrCreate({ ...KEY, colorFormats: ["rgba8unorm"] }, factory);
  assert.equal(built, 2, "a different colour-format set MUST build a different pipeline (the pass format is baked in)");
  const stats = cache.stats();
  assert.deepEqual({ size: stats.size, hits: stats.hits, misses: stats.misses }, { size: 2, hits: 1, misses: 2 });

  assert.throws(() => cache.getOrCreate({ ...KEY, shaderProgramId: "program-2" }, null), (error) => {
    assert.equal(error.name, "DiagnosticError");
    assert.match(error.message, /no pipeline factory/);
    return true;
  });
  cache.clear();
  assert.deepEqual(cache.stats(), { size: 0, hits: 0, misses: 0 });
});

test("key equality and key text are canonical", async () => {
  const cache = await loadCache();
  assert.equal(cache.pipelineKeyEquals(KEY, { ...KEY }), true);
  assert.equal(cache.pipelineKeyEquals(KEY, { ...KEY, sampleCount: 4 }), false);
  assert.equal(cache.pipelineKeyEquals(KEY, { ...KEY, depthFormat: "depth24plus-stencil8" }), false);
  assert.equal(cache.pipelineKeyEquals(KEY, { ...KEY, colorFormats: ["bgra8unorm", "r8unorm"] }), false);
  const text = cache.pipelineKeyToString(KEY);
  for (const fragment of ["program=program-1", "topology=triangle-list", "depth=none", "samples=1"]) {
    assert.ok(text.includes(fragment), `the key text MUST name ${fragment} (evidence artefacts depend on it)`);
  }
});

test("the vertex-layout fingerprint ignores buffer identity but keeps every attribute field", async () => {
  const cache = await loadCache();
  const layout = [
    { index: 0, componentDatatype: 5126, componentsPerAttribute: 3, normalized: false, offsetInBytes: 0, strideInBytes: 24 },
    { index: 1, componentDatatype: 5126, componentsPerAttribute: 3, normalized: false, offsetInBytes: 12, strideInBytes: 24 },
  ];
  const base = cache.vertexLayoutFingerprint(layout);
  assert.equal(cache.vertexLayoutFingerprint([...layout].reverse()), base, "attribute order MUST NOT change the layout identity");
  assert.notEqual(cache.vertexLayoutFingerprint([{ ...layout[0], strideInBytes: 32 }, layout[1]]), base);
  assert.notEqual(cache.vertexLayoutFingerprint([{ ...layout[0], normalized: true }, layout[1]]), base);
  assert.notEqual(cache.vertexLayoutFingerprint([{ ...layout[0], instanced: true }, layout[1]]), base, "instancing is part of the pipeline layout");
});
