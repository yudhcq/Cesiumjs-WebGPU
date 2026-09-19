/**
 * T044 — `Context` command dispatch and frame lifecycle (`层=单元`, tasks.md T044; research §1.4/§5.1, SC-010).
 *
 * The dispatch path is a *recorder*, so the assertions are the recorded call sequence:
 * `setPipeline` → bind groups → vertex/index buffers → `setViewport`/`setScissorRect`/`setStencilReference`
 * → `drawIndexed`/`draw`, wrapped in a derived pass that opens lazily and is closed by `endFrame`
 * (the "no pass is left open at the end of the frame" rule of G-3 check (c)).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { createFakeAdapter, createFakeCanvas, installWebgpuGlobals } from "../support/fake-gpu.mjs";
import { upstreamStubs } from "../support/upstream-stubs.mjs";

installWebgpuGlobals();

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function loadContextModule() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/Context.ts`), { externals: upstreamStubs() });
}

async function makeContext(options = {}) {
  const handoff = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/device-handoff.ts`));
  handoff.resetSlot();
  const adapter = createFakeAdapter();
  handoff.install({ adapter, device: adapter.device, limits: adapter.limits, features: adapter.features, source: "unit-test" });
  const { default: Context } = await loadContextModule();
  const canvas = createFakeCanvas({ clientWidth: 300, clientHeight: 150 });
  const context = new Context(canvas, options);
  return { context, canvas, adapter, handoff };
}

/** Minimal backend draw payload: a pipeline plus the bindings the dispatch path records. */
function drawInputs(overrides = {}) {
  const buffer = { __buffer: true, size: 128, destroy() {} };
  return {
    shaderProgramId: "unit-program",
    pipeline: { __pipeline: true },
    bindGroups: [{ __group: 0 }],
    vertexBuffers: [{ slot: 0, buffer, offset: 0 }],
    indexBuffer: { buffer, format: "uint16", offset: 0 },
    topology: "triangle-list",
    indexed: true,
    indexCount: 6,
    vertexLayout: [{ index: 0, componentDatatype: 5126, componentsPerAttribute: 3, normalized: false, offsetInBytes: 0, strideInBytes: 12 }],
    ...overrides,
  };
}

function command(inputs) {
  return { __webgpu: inputs, count: 6 };
}

test("a frame opens, records one derived pass, submits and closes it", async () => {
  const { context, canvas, adapter, handoff } = await makeContext();
  context.beginFrame();
  const draw = command(drawInputs());
  context.draw(draw, {});
  context.draw(draw, {});
  context.endFrame();

  assert.equal(context.counters.frames, 1);
  assert.equal(context.counters.draws, 2);
  assert.equal(context.counters.submittedCommandBuffers, 1, "endFrame MUST submit exactly one command buffer");

  const encoder = adapter.device.__created.encoders[0];
  assert.equal(encoder.__passes.length, 1, "two draws on the same identity stay in ONE pass");
  const pass = encoder.__passes[0];
  const names = pass.__calls.map((call) => call.name);
  assert.deepEqual(names, [
    "setPipeline",
    "setBindGroup",
    "setVertexBuffer",
    "setIndexBuffer",
    "setViewport",
    "setStencilReference",
    "drawIndexed",
    "setPipeline",
    "setBindGroup",
    "setVertexBuffer",
    "setIndexBuffer",
    "setViewport",
    "setStencilReference",
    "drawIndexed",
    "end",
  ]);
  assert.equal(
    names.includes("setScissorRect"),
    false,
    "a disabled scissor MUST NOT be set: WebGPU already defaults it to the whole attachment (T049)",
  );
  assert.deepEqual(pass.__calls.find((call) => call.name === "setViewport").args, [0, 0, 300, 150, 0, 1], "the viewport defaults to the drawing buffer");
  assert.deepEqual(pass.__calls.find((call) => call.name === "drawIndexed").args, [6, 1, 0, 0, 0]);
  assert.equal(pass.__ended, true, "no pass may stay open after endFrame (G-3 check (c))");
  assert.equal(context.lastFramePasses().length, 1);
  assert.equal(context.lastFramePasses()[0].drawOps, 2);
  assert.equal(canvas.getContext("webgpu").__currentTextures.length, 1, "one swap-chain texture per frame");

  context.destroy();
  handoff.resetSlot();
});

test("the pipeline cache serves the second identical draw (miss once, hit after)", async () => {
  const { context, handoff } = await makeContext();
  const { pipelineCacheStats } = await loadContextModule();
  context.beginFrame();
  context.draw(command(drawInputs()), {});
  context.draw(command(drawInputs()), {});
  context.endFrame();
  const stats = pipelineCacheStats();
  assert.equal(stats.misses, 1, "the first draw builds the pipeline");
  assert.equal(stats.hits, 1, "the identical second draw MUST be a cache hit");
  assert.equal(context.counters.drawCalls, 0);
  assert.equal(context.counters.drawIndexedCalls, 2);
  context.destroy();
  handoff.resetSlot();
});

test("an enabled scissor is applied as command state", async () => {
  const { context, adapter, handoff } = await makeContext();
  context.beginFrame();
  context.draw(command(drawInputs({ renderState: { scissorTest: { enabled: true, rectangle: { x: 1, y: 2, width: 3, height: 4 } } } })), {});
  context.endFrame();
  const pass = adapter.device.__created.encoders[0].__passes[0];
  const scissor = pass.__calls.find((call) => call.name === "setScissorRect");
  assert.deepEqual(scissor?.args, [1, 2, 3, 4]);
  context.destroy();
  handoff.resetSlot();
});

test("an identity change splits the pass; a redundant re-bind does not", async () => {
  const { context, adapter, handoff } = await makeContext();
  const target = {
    id: "fb-offscreen",
    colorAttachments: [{ id: "color-0", view: { __view: "offscreen" } }],
    depthStencilAttachment: { view: { __view: "depth" }, depthLoadOp: "clear", depthStoreOp: "store" },
    sampleCount: 1,
  };
  context.registerTarget(target);
  context.beginFrame();
  context.draw(command(drawInputs()), {});
  context.draw(command(drawInputs()), { framebuffer: target });
  context.draw(command(drawInputs()), { framebuffer: target });
  context.endFrame();

  const passes = context.lastFramePasses();
  assert.equal(passes.length, 2, "the target switch MUST open a new pass");
  assert.equal(passes[0].drawOps, 1);
  assert.equal(passes[1].drawOps, 2);
  assert.equal(passes[1].key.colorTargets[0], "fb-offscreen");
  assert.equal(passes[1].key.depthStencilTarget, "fb-offscreen:depth", "an offscreen pass names its depth attachment");
  assert.equal(adapter.device.__created.encoders[0].__passes.length, 2);
  context.destroy();
  handoff.resetSlot();
});

test("the first clear of a pass uses loadOp; the next one uses the fallback", async () => {
  const { context, adapter, handoff } = await makeContext();
  context.beginFrame();
  const first = context.clear({ color: { red: 0.1, green: 0.2, blue: 0.3, alpha: 1 } }, {});
  const second = context.clear({ color: { red: 0, green: 0, blue: 0, alpha: 1 } }, {});
  context.draw(command(drawInputs()), {});
  context.endFrame();

  assert.equal(first, "loadOp");
  assert.notEqual(second, "loadOp", "a clear inside a pass MUST NOT silently reuse loadOp (research §5.1)");
  const pass = adapter.device.__created.encoders[0].__passes[0];
  assert.equal(pass.__descriptor.colorAttachments[0].loadOp, "clear", "the pass opens with loadOp:clear");
  assert.deepEqual(pass.__descriptor.colorAttachments[0].clearValue, { r: 0.1, g: 0.2, b: 0.3, a: 1 });
  assert.equal(context.counters.clearsByLoadOp, 1);
  assert.equal(context.counters.clearsByClearBuffer, 1);
  assert.equal(context.lastFramePasses()[0].clearOps, 2);
  assert.equal(context.lastFramePasses()[0].drawOps, 1);
  context.destroy();
  handoff.resetSlot();
});

test("4x MSAA passes resolve into the swap chain", async () => {
  const { context, adapter, handoff } = await makeContext();
  assert.equal(context.sampleCount, 4, "msaa=true means the 4x attachment is in use");
  context.beginFrame();
  context.clear({}, {});
  context.endFrame();
  const descriptor = adapter.device.__created.encoders[0].__passes[0].__descriptor;
  const attachment = descriptor.colorAttachments[0];
  assert.ok(attachment.view !== undefined);
  assert.ok(attachment.resolveTarget !== undefined, "sampleCount 4 REQUIRES a resolveTarget (T050)");
  // W5: the canvas pass also carries the depth-stencil attachment (the terrain's depth test needs it, and
  // upstream's GL default framebuffer always had one), so two 4x textures are created — colour + depth.
  assert.equal(adapter.device.__created.textures.filter((texture) => texture.descriptor?.sampleCount === 4).length, 2);
  context.destroy();
  handoff.resetSlot();
});

test("a draw outside a frame fails loudly", async () => {
  const { context, handoff } = await makeContext();
  const pipelineCache = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/pipeline-cache.ts`));
  void pipelineCache;
  assert.throws(() => context.draw(command(drawInputs()), {}), /outside a frame/);
  context.destroy();
  handoff.resetSlot();
});

test("a destroyed context refuses work instead of drawing into a dead device", async () => {
  const { context, handoff } = await makeContext();
  context.destroy();
  assert.equal(context.isDestroyed(), true);
  assert.throws(() => context.beginFrame(), (error) => {
    assert.equal(error.name, "DiagnosticError");
    assert.equal(error.category, "render-failed");
    return true;
  });
  assert.throws(() => context.draw(command(drawInputs()), {}), /destroyed/);
  handoff.resetSlot();
});

test("stopSubmitting blocks draws and counts the residual attempt (whole-switch evidence)", async () => {
  const { context, handoff } = await makeContext();
  context.beginFrame();
  context.draw(command(drawInputs()), {});
  context.stopSubmitting();
  assert.throws(() => context.draw(command(drawInputs()), {}), (error) => {
    assert.equal(error.name, "DiagnosticError");
    assert.equal(error.category, "device-lost");
    return true;
  });
  assert.equal(context.residualDraws, 1, "the attempt is counted so a whole switch can prove `residualDraws === 0`");
  context.destroy();
  handoff.resetSlot();
});

test("createViewportQuadCommand assembles the upstream command shape", async () => {
  const { context, handoff } = await makeContext();
  const uniformMap = { u_test: () => 1 };
  const quad = context.createViewportQuadCommand("void main() { outColor = vec4(1.0); }", { uniformMap, owner: "unit-test" });
  assert.ok(quad.vertexArray !== undefined, "the command MUST carry its viewport-quad vertex array");
  assert.ok(quad.shaderProgram !== undefined, "the command MUST carry a shader program");
  assert.equal(quad.uniformMap, uniformMap, "the caller's uniform map is passed through unchanged");
  assert.equal(quad.owner, "unit-test");
  assert.equal(quad.pass, 0, "the viewport quad is drawn in the first pass (upstream default)");
  assert.ok(quad.renderState !== undefined);
  assert.equal(context.getViewportQuadVertexArray(), quad.vertexArray, "the vertex array is cached per context");
  context.destroy();
  handoff.resetSlot();
});
