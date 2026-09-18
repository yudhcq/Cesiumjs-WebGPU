/**
 * T049 — `RenderState` replacement and the GL → WebGPU mapping table (`层=单元`, tasks.md T049; research §5.3).
 *
 * Two contracts have to hold at once:
 *   - the **option shape stays identical** (95 construction/static-call sites in 43 logic-layer files
 *     build it with the same literal shape, and the logic layer reads `cull.enabled`, `cull.face`,
 *     `id`, `colorMask`, `depthMask`, `stencilTest.reference`, `blending.enabled`, `viewport.width`,
 *     `polygonOffset`, …): the defaults below are asserted field by field against upstream's own
 *     constructor, which is read from the installed package;
 *   - the state that WebGPU cannot express is **rejected**, never silently dropped.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";

const BACKEND = "packages/cesium-webgpu/backend-webgpu";
const UPSTREAM_RENDER_STATE = "node_modules/@cesium/engine/Source/Renderer/RenderState.js";

async function loadRenderState() {
  const module_ = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/RenderState.ts`));
  return module_;
}

/** The `this.<field> = …` assignments of upstream's constructor, with their default literals. */
function upstreamDefaults() {
  const source = fs.readFileSync(repoPath(UPSTREAM_RENDER_STATE), "utf8");
  const start = source.indexOf("function RenderState(renderState)");
  const body = source.slice(start, source.indexOf("\nlet nextRenderStateId", start));
  const defaults = {};
  for (const match of body.matchAll(/^\s{2}this\.([A-Za-z_][\w]*)\s*=\s*(.+?);\s*$/gm)) {
    defaults[match[1]] = match[2].trim();
  }
  return defaults;
}

test("the construction-time shape and defaults match upstream field by field", async () => {
  const { default: RenderState } = await loadRenderState();
  const defaults = upstreamDefaults();
  const state = new RenderState();

  // Every field upstream assigns in its constructor MUST exist on the replacement.
  for (const field of Object.keys(defaults)) {
    if (field === "id" || field === "_applyFunctions") continue;
    assert.ok(field in state, `the replacement MUST expose upstream's field "${field}"`);
  }
  // The literal defaults the logic layer relies on (upstream RenderState.js:110-187).
  assert.equal(state.frontFace, 0x0901, "WindingOrder.COUNTER_CLOCKWISE");
  assert.deepEqual(state.cull, { enabled: false, face: 0x0405 }, "cull.face defaults to WebGLConstants.BACK");
  assert.equal(state.lineWidth, 1.0);
  assert.deepEqual(state.polygonOffset, { enabled: false, factor: 0, units: 0 });
  assert.deepEqual(state.depthRange, { near: 0, far: 1 });
  assert.deepEqual(state.depthTest, { enabled: false, func: 0x0201 }, "DepthFunction.LESS");
  assert.deepEqual(state.colorMask, { red: true, green: true, blue: true, alpha: true });
  assert.equal(state.depthMask, true);
  assert.equal(state.stencilMask, ~0);
  assert.equal(state.blending.enabled, false);
  assert.deepEqual(state.blending.color, { red: 0, green: 0, blue: 0, alpha: 0 });
  assert.equal(state.blending.equationRgb, 0x8006, "BlendEquation.ADD");
  assert.equal(state.blending.functionSourceRgb, 1, "BlendFunction.ONE");
  assert.equal(state.blending.functionDestinationRgb, 0, "BlendFunction.ZERO");
  assert.equal(state.stencilTest.enabled, false);
  assert.equal(state.stencilTest.frontFunction, 0x0207, "StencilFunction.ALWAYS");
  assert.equal(state.stencilTest.reference, 0);
  assert.equal(state.stencilTest.mask, ~0);
  assert.deepEqual(state.stencilTest.frontOperation, { fail: 0x1e00, zFail: 0x1e00, zPass: 0x1e00 }, "StencilOperation.KEEP");
  assert.deepEqual(state.sampleCoverage, { enabled: false, value: 1.0, invert: false });
  assert.equal(state.viewport, undefined, "upstream keeps`viewport` optional");
  assert.equal(typeof state.id, "number");

  // The logic layer also reads `viewport.width/height` when a viewport is present.
  const withViewport = new RenderState({ viewport: { x: 1, y: 2, width: 30, height: 40 } });
  assert.deepEqual(withViewport.viewport, { x: 1, y: 2, width: 30, height: 40 });
});

test("the mapping table covers every field research §5.3 names", async () => {
  const { default: RenderState, BLEND_FACTOR_MAP, BLEND_EQUATION_MAP, COMPARE_FUNCTION_MAP, STENCIL_OPERATION_MAP, FRONT_FACE_MAP, CULL_MODE_MAP } = await loadRenderState();
  const state = new RenderState({
    frontFace: 0x0900,
    cull: { enabled: true, face: 0x0404 },
    polygonOffset: { enabled: true, factor: 2, units: 3 },
    scissorTest: { enabled: true, rectangle: { x: 1, y: 2, width: 3, height: 4 } },
    depthTest: { enabled: true, func: 0x0203 },
    depthMask: false,
    colorMask: { red: true, green: false, blue: true, alpha: false },
    stencilTest: { enabled: true, frontFunction: 0x0202, backFunction: 0x0205, reference: 7, mask: 0x0f, frontOperation: { fail: 0x1e01, zFail: 0x1e02, zPass: 0x1e03 }, backOperation: { fail: 0x150a, zFail: 0x8507, zPass: 0x8508 } },
    stencilMask: 0xff,
    blending: { enabled: true, equationRgb: 0x800a, equationAlpha: 0x800b, functionSourceRgb: 0x0302, functionSourceAlpha: 0x0303, functionDestinationRgb: 0x0304, functionDestinationAlpha: 0x0305, color: { red: 0.1, green: 0.2, blue: 0.3, alpha: 0.4 } },
  });
  const mapped = state.toPipelineState();

  assert.equal(mapped.primitive.frontFace, "cw", "frontFace 0x0900 → cw");
  assert.equal(mapped.primitive.cullMode, "front", "cull.face 0x0404 → front");
  assert.equal(mapped.primitive.topology, "triangle-list");
  assert.equal(mapped.depthStencil.depthCompare, "less-equal", "depthTest.func 0x0203");
  assert.equal(mapped.depthStencil.depthWriteEnabled, false, "depthMask=false wins over depthTest.enabled");
  assert.equal(mapped.depthStencil.depthBias, 3, "polygonOffset.units → depthBias");
  assert.equal(mapped.depthStencil.depthBiasSlopeScale, 2, "polygonOffset.factor → depthBiasSlopeScale");
  assert.equal(mapped.targets[0].writeMask, 1 | 4, "colorMask r+b → bits 1|4");
  assert.equal(mapped.depthStencil.stencilFront.compare, "equal");
  assert.equal(mapped.depthStencil.stencilBack.compare, "not-equal");
  assert.equal(mapped.depthStencil.stencilFront.failOp, "replace");
  assert.equal(mapped.depthStencil.stencilFront.depthFailOp, "increment-clamp");
  assert.equal(mapped.depthStencil.stencilFront.passOp, "decrement-clamp");
  assert.equal(mapped.depthStencil.stencilBack.failOp, "invert");
  assert.equal(mapped.depthStencil.stencilBack.depthFailOp, "increment-wrap");
  assert.equal(mapped.depthStencil.stencilBack.passOp, "decrement-wrap");
  assert.equal(mapped.depthStencil.stencilReadMask, 0x0f);
  assert.equal(mapped.depthStencil.stencilWriteMask, 0xff);
  assert.equal(mapped.command.stencilReference, 7, "`reference` is command state, not pipeline state (setStencilReference)");
  assert.deepEqual(mapped.command.scissorRect, [1, 2, 3, 4]);
  assert.equal(mapped.targets[0].blend.color.operation, "subtract", "equationRgb 0x800a");
  assert.equal(mapped.targets[0].blend.alpha.operation, "reverse-subtract", "equationAlpha 0x800b");
  assert.equal(mapped.targets[0].blend.color.srcFactor, "src-alpha");
  assert.equal(mapped.targets[0].blend.color.dstFactor, "dst-alpha");
  assert.deepEqual(mapped.command.blendConstant, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(mapped.targets[0].blend !== undefined, true);

  // The exported tables ARE the mapping (a missing entry throws instead of defaulting).
  assert.equal(BLEND_FACTOR_MAP[0x0308], "src-alpha-saturated");
  assert.equal(BLEND_FACTOR_MAP[0x88f9], "src1");
  assert.equal(BLEND_EQUATION_MAP[0x8007], "min");
  assert.equal(COMPARE_FUNCTION_MAP[0x0200], "never");
  assert.equal(STENCIL_OPERATION_MAP[0x0000], "zero");
  assert.equal(FRONT_FACE_MAP[0x0901], "ccw");
  assert.equal(CULL_MODE_MAP[0x0408], "none");
});

test("culling off maps to cullMode none; the default state is a permissive pipeline", async () => {
  const { default: RenderState } = await loadRenderState();
  const off = new RenderState().toPipelineState();
  assert.equal(off.primitive.cullMode, "none");
  assert.equal(off.depthStencil.depthCompare, "always", "depthTest disabled ⇒ always");
  assert.equal(off.depthStencil.depthWriteEnabled, false);
  assert.equal(off.targets[0].blend, undefined, "blending disabled ⇒ no blend state");
  assert.equal(off.targets[0].writeMask, 0b1111);
  assert.equal(off.command.scissorRect, null, "scissorTest disabled ⇒ the whole target");
});

test("an unmapped GL enum is a diagnosable error, never a silent default", async () => {
  const { default: RenderState } = await loadRenderState();
  assert.throws(() => new RenderState({ depthTest: { enabled: true, func: 0x9999 } }).toPipelineState(), (error) => {
    assert.equal(error.name, "DiagnosticError");
    assert.equal(error.category, "not-implemented");
    assert.match(error.message, /depthTest\.func value 39321/);
    return true;
  });
  assert.throws(() => new RenderState({ blending: { enabled: true, functionSourceRgb: 0x1234 } }).toPipelineState(), /blending\.functionSourceRgb/);
});

test("viewport falls back through passState and defaults to the drawing buffer", async () => {
  const { default: RenderState } = await loadRenderState();
  const withViewport = new RenderState({ viewport: { x: 1, y: 1, width: 4, height: 4 } });
  assert.deepEqual(withViewport.toPipelineState({ viewport: { x: 9, y: 9, width: 9, height: 9 } }).command.viewport, [1, 1, 4, 4], "the command viewport wins");
  const without = new RenderState();
  assert.deepEqual(without.toPipelineState({ viewport: { x: 2, y: 2, width: 6, height: 6 } }).command.viewport, [2, 2, 6, 6]);
  assert.equal(without.toPipelineState({}).command.viewport, null, "no viewport anywhere ⇒ the backend uses the swap chain size");
});

test("passState.scissorTest overrides the command-level scissor (upstream RenderState.js:859-861)", async () => {
  const { default: RenderState } = await loadRenderState();
  const state = new RenderState({ scissorTest: { enabled: true, rectangle: { x: 0, y: 0, width: 5, height: 5 } } });
  assert.deepEqual(state.toPipelineState({}).command.scissorRect, [0, 0, 5, 5]);
  assert.equal(state.toPipelineState({ scissorTest: false }).command.scissorRect, null, "passState disables the scissor");
  const noScissor = new RenderState();
  assert.deepEqual(noScissor.toPipelineState({ scissorTest: true }).command.scissorRect, [0, 0, 0, 0], "passState enables it with the command rectangle");
});

test("fromCache reuses immutable states; removeFromCache releases them", async () => {
  const { default: RenderState } = await loadRenderState();
  RenderState.clearCache();
  const options = { cull: { enabled: true }, depthTest: { enabled: true } };
  const first = RenderState.fromCache(options);
  const second = RenderState.fromCache({ cull: { enabled: true }, depthTest: { enabled: true } });
  assert.equal(first, second, "a structurally identical request MUST return the cached instance");
  assert.equal(RenderState.getCache()[JSON.stringify(options)].referenceCount, 2);
  RenderState.removeFromCache(options);
  RenderState.removeFromCache(options);
  assert.equal(RenderState.getCache()[JSON.stringify(options)], undefined, "the cache entry MUST disappear at zero references");
  RenderState.clearCache();
});

test("partialApply reports a pipeline-state diff instead of issuing GL calls", async () => {
  const { default: RenderState } = await loadRenderState();
  const depthOnly = new RenderState({ depthTest: { enabled: true }, depthMask: true });
  const blending = new RenderState({ depthTest: { enabled: true }, depthMask: true, blending: { enabled: true } });
  const first = RenderState.partialApply(undefined, depthOnly);
  assert.equal(first.requiresNewPipeline, true, "the first state of a frame always needs a pipeline");
  assert.deepEqual(first.changed, ["<first-state>"]);

  const diff = RenderState.partialApply(depthOnly, blending);
  assert.ok(diff.changed.includes("targets"), `a blend change MUST show up in the diff (got ${diff.changed.join(", ")})`);
  assert.equal(diff.requiresNewPipeline, true, "a blend change is baked into the pipeline");

  const viewportOnly = new RenderState({ depthTest: { enabled: true }, depthMask: true, viewport: { x: 0, y: 0, width: 8, height: 8 } });
  const viewportDiff = RenderState.partialApply(depthOnly, viewportOnly);
  assert.ok(viewportDiff.changed.includes("viewport"));
  assert.equal(viewportDiff.requiresNewPipeline, false, "the viewport is command state — it MUST NOT force a new pipeline");
  assert.equal(RenderState.partialApply(depthOnly, depthOnly).changed.length, 0, "no change MUST yield an empty diff (the lazy set + self diff semantics)");
});

test("clone / removeViewport / getState keep the upstream read surface", async () => {
  const { default: RenderState } = await loadRenderState();
  const original = new RenderState({ viewport: { x: 0, y: 0, width: 10, height: 10 }, cull: { enabled: true } });
  const clone = RenderState.clone(original);
  assert.notEqual(clone, original);
  assert.deepEqual(clone.cull, original.cull);
  assert.equal(clone.id, original.id, "a clone keeps the id so the pipeline cache key stays stable");
  const withoutViewport = RenderState.removeViewport(original);
  assert.equal(withoutViewport.viewport, undefined);
  assert.deepEqual(withoutViewport.cull, original.cull, "everything else is preserved");
  const plain = RenderState.getState(original);
  assert.equal(plain.viewport.width, 10);
  assert.equal(plain.cull.enabled, true);
  assert.equal(typeof plain.blending.color.red, "number");
});
