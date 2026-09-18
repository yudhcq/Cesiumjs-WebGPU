/**
 * T043 — `Renderer/Context` replacement, construction phase (`层=单元`, tasks.md T043).
 *
 * The upstream `Scene` constructor reads the capability flags and `ContextLimits` **synchronously**, so
 * everything this test asserts has to be true by the time `new Context(canvas, options)` returns:
 * the device comes out of the hand-off slot inside the constructor, the canvas is configured, all 23
 * `ContextLimits` members are published into the **kept** upstream module, the default texture is the
 * upstream 1x1 white RGBA8 (`flipY:false`, clamp-to-edge/linear), and `id` is a stable unique GUID.
 *
 * The second half pins plan.md decision D2-a: an empty slot means a **one-shot, construction-time whole
 * delegation** to the preserved upstream WebGL2 implementation — never a mixture of the two backends,
 * and never a silent degradation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assertDiagnostic, createFakeAdapter, createFakeCanvas, installWebgpuGlobals } from "../support/fake-gpu.mjs";
import { CONTEXT_LIMITS_MEMBERS, upstreamStubs } from "../support/upstream-stubs.mjs";

installWebgpuGlobals();

const BACKEND = "packages/cesium-webgpu/backend-webgpu";
const VENDOR_SPECIFIER = "../vendor/upstream-webgl2/Context.js";

/** Load `Context.ts` together with recording stubs for the kept upstream modules. */
async function loadContext(overrides = {}) {
  const contextLimits = { writes: [] };
  const source = `${upstreamStubs()[`@cesium/engine/Source/Renderer/ContextLimits.js`]}`;
  void source;
  const module_ = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/Context.ts`), {
    externals: upstreamStubs({
      // A recording wrapper around the ContextLimits stub: the test can see exactly what was published.
      "@cesium/engine/Source/Renderer/ContextLimits.js": contextLimitsStubWithRecorder(contextLimits),
      ...overrides,
    }),
  });
  return { module_, contextLimits };
}

/** The ContextLimits stub plus a `__record` hook so writes are observable after the fact. */
function contextLimitsStubWithRecorder(recorder) {
  const fields = CONTEXT_LIMITS_MEMBERS.map((member) => `  _${member}: ${/highp/.test(member) ? "false" : "0"},`).join("\n");
  const accessors = CONTEXT_LIMITS_MEMBERS.map(
    (member) => `  ${member}: { get: function () { return this._${member}; } },`,
  ).join("\n");
  return (
    `const ContextLimits = {\n${fields}\n};\n` +
    `Object.defineProperties(ContextLimits, {\n${accessors}\n});\n` +
    `ContextLimits.__recorder = globalThis.__CONTEXT_LIMITS_RECORDER__;\n` +
    `export default ContextLimits;\n`
  );
}

async function installHandoff(source = "unit-test") {
  const handoff = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/device-handoff.ts`));
  handoff.resetSlot();
  const adapter = createFakeAdapter();
  handoff.install({ adapter, device: adapter.device, limits: adapter.limits, features: adapter.features, source });
  return { handoff, adapter };
}

test("construction takes the device synchronously and publishes everything before it returns", async () => {
  const recorder = [];
  globalThis.__CONTEXT_LIMITS_RECORDER__ = recorder;
  const { module_ } = await loadContext();
  const { handoff, adapter } = await installHandoff();

  const canvas = createFakeCanvas({ clientWidth: 300, clientHeight: 150 });
  const context = new module_.default(canvas, {});

  // (a) identity and device
  assert.equal(context.device, adapter.device, "the device MUST be the one parked in the slot");
  assert.equal(context.adapter, adapter);
  assert.equal(typeof context.id, "string");
  assert.ok(context.id.length > 8, "`id` is used as an index-buffer cache key, so it MUST be a real GUID");
  assert.equal(handoff.audit().pending, false, "the slot MUST be empty after construction (a device is consumed once)");
  const takeEntry = handoff.audit().entries.find((entry) => entry.op === "take");
  assert.match(String(takeEntry?.stack ?? ""), /Context/, "take() MUST happen inside the Context constructor (the H-2 claim)");

  // (b) capability flags are synchronously readable and already final
  assert.equal(context.webgl2, true);
  assert.equal(context.msaa, true);
  assert.equal(context.depthTexture, false, "slice A keeps the declared degradation");
  assert.equal(context.fragmentDepth, true);
  assert.equal(context.stencilBits, 8);
  assert.equal(context.drawBuffers, true);
  assert.equal(context.s3tc, false);
  assert.equal(context.drawingBufferWidth, 300);
  assert.equal(context.drawingBufferHeight, 150);

  // (c) ContextLimits are published into the kept upstream module
  assert.equal(context.contextLimitsWritten.length, 23, "all 23 members MUST be written during construction");
  assert.deepEqual(context.contextLimitsWritten, CONTEXT_LIMITS_MEMBERS.map((member) => `_${member}`));
  assert.equal(recorder.length, 0, "the recorder is a passive hook; no writes are invented");

  // (d) the default texture is the upstream one
  assert.equal(context.defaultTexture.width, 1);
  assert.equal(context.defaultTexture.height, 1);
  assert.equal(context.defaultTexture.flipY, false);
  assert.equal(context.defaultTexture.pixelFormat, 0x1908, "PixelFormat.RGBA");
  assert.equal(context.defaultTexture.pixelDatatype, 0x1401, "PixelDatatype.UNSIGNED_BYTE");
  assert.deepEqual([...context.defaultTexture.rgba8], [255, 255, 255, 255], "Texture.defaultColor is Color.WHITE");
  assert.equal(context.defaultTexture.samplerDescriptor.addressModeU, "clamp-to-edge");
  assert.equal(context.defaultTexture.samplerDescriptor.magFilter, "linear");
  assert.equal(context.defaultTexture.texture.descriptor.format, "rgba8unorm");

  // (e) the canvas was configured for this device
  const configureCalls = canvas.getContext("webgpu").__configureCalls;
  assert.equal(configureCalls.length, 1);
  assert.equal(configureCalls[0].device, adapter.device);
  assert.equal(configureCalls[0].usage, globalThis.GPUTextureUsage.RENDER_ATTACHMENT);

  // (f) the upstream collaborators exist (kept modules)
  assert.ok(context.uniformState !== undefined && context.shaderCache !== undefined && context.textureCache !== undefined);
  assert.equal(context.isDestroyed(), false);

  context.destroy();
  assert.equal(context.isDestroyed(), true);
  handoff.resetSlot();
  delete globalThis.__CONTEXT_LIMITS_RECORDER__;
});

test("ids are unique per context and stable for the instance's life", async () => {
  const { module_ } = await loadContext();
  const { handoff } = await installHandoff();
  const first = new module_.default(createFakeCanvas(), {});
  const id = first.id;
  assert.equal(first.id, id, "the id MUST NOT change");
  first.destroy();
  handoff.resetSlot();

  const { handoff: second } = await installHandoff();
  const other = new module_.default(createFakeCanvas(), {});
  assert.notEqual(other.id, id, "two contexts MUST NOT share an id");
  other.destroy();
  second.resetSlot();
});

test("a missing canvas is rejected before anything is consumed", async () => {
  const { module_ } = await loadContext();
  const { handoff } = await installHandoff();
  assert.throws(() => new module_.default(undefined, {}), (error) => assertDiagnostic(error, "internal", "Context without a canvas"));
  assert.equal(handoff.audit().pending, true, "a rejected construction MUST NOT consume the device");
  handoff.resetSlot();
});

test("an empty hand-off slot delegates the whole construction to the preserved upstream WebGL2 context", async () => {
  const delegated = [];
  const sentinel = { __upstreamWebGL2: true };
  const standIn = `export default function UpstreamContext(canvas, options) {\n  globalThis.__DELEGATION_CALLS__.push({ canvas, options });\n  return globalThis.__DELEGATION_SENTINEL__;\n}\n`;
  globalThis.__DELEGATION_CALLS__ = delegated;
  globalThis.__DELEGATION_SENTINEL__ = sentinel;

  const { module_ } = await loadContext({ [VENDOR_SPECIFIER]: standIn });
  const handoff = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/device-handoff.ts`));
  handoff.resetSlot();

  const canvas = createFakeCanvas();
  const options = { webgl: { alpha: false } };
  const result = new module_.default(canvas, options);
  assert.equal(result, sentinel, "the constructor MUST return the delegated upstream instance");
  assert.equal(delegated.length, 1, "the upstream WebGL2 implementation MUST be constructed exactly once");
  assert.equal(delegated[0].canvas, canvas);
  assert.deepEqual(delegated[0].options, options, "the upstream option bag MUST be passed through unchanged");
  assert.equal(result.__delegatedFrom, "cesium-webgpu:Renderer/Context.ts", "the delegated object carries its provenance");
  assert.equal(result.device, undefined, "no WebGPU device was involved");

  delete globalThis.__DELEGATION_CALLS__;
  delete globalThis.__DELEGATION_SENTINEL__;
});

test("a delegation that cannot complete propagates a diagnosable failure (never a silent fallback)", async () => {
  const standIn = `export default function UpstreamContext() {\n  const error = new Error("the delegated WebGL2 context could not be created: no WebGL2 context available");\n  error.name = "RuntimeError";\n  throw error;\n}\n`;
  const { module_ } = await loadContext({ [VENDOR_SPECIFIER]: standIn });
  const handoff = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/device-handoff.ts`));
  handoff.resetSlot();
  assert.throws(() => new module_.default(createFakeCanvas(), {}), /could not be created/);
});
