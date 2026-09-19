/**
 * T050 — swap chain, presentation and 4x MSAA resolve (`层=单元`, tasks.md T050; research §5.1, data-model §4.1).
 *
 * Asserted on the **descriptors** (a real device cannot be inspected this way, and the contract suites
 * cover the real one):
 *   - `configure()` runs once per device/size with the measured format and `RENDER_ATTACHMENT` usage;
 *   - with `sampleCount: 4` the colour attachment is the multisampled texture and `resolveTarget` is the
 *     swap-chain view — the pair is produced together, so one can never be set without the other;
 *   - the drawing-buffer size follows `clientWidth x devicePixelRatio`, and a change rebuilds both the
 *     swap chain and the multisample attachment;
 *   - using the swap chain outside a frame, or after `destroy()`, fails loudly.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { createFakeCanvas, createFakeDevice, installWebgpuGlobals } from "../support/fake-gpu.mjs";

installWebgpuGlobals();

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function loadSwapchain() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/swapchain.ts`));
}

const fixedRatio = (value) => () => value;

test("configure() runs once per device/size, with the measured format and usage", async () => {
  const { Swapchain } = await loadSwapchain();
  const device = createFakeDevice();
  const canvas = createFakeCanvas({ clientWidth: 320, clientHeight: 200 });
  const swapchain = new Swapchain({ canvas, device, format: "bgra8unorm", devicePixelRatio: fixedRatio(1) });

  swapchain.configure();
  swapchain.configure();
  assert.equal(swapchain.configureCount, 1, "configure() MUST be idempotent (research §5.1 step 1)");
  const configureCall = canvas.getContext("webgpu").__configureCalls[0];
  assert.equal(configureCall.device, device);
  assert.equal(configureCall.format, "bgra8unorm", "the measured preferred format on the reference machine");
  assert.equal(configureCall.alphaMode, "opaque");
  // W5: `COPY_SRC` lets a suite read the presented frame back on the GPU (`copyTextureToBuffer`).
  assert.equal(configureCall.usage, globalThis.GPUTextureUsage.RENDER_ATTACHMENT | globalThis.GPUTextureUsage.COPY_SRC);
  assert.equal(swapchain.width, 320);
  assert.equal(swapchain.height, 200);
  assert.equal(swapchain.sizeSource, "client-size");
});

test("sampleCount 4 always produces the multisampled attachment AND its resolveTarget", async () => {
  const { Swapchain } = await loadSwapchain();
  const device = createFakeDevice();
  const canvas = createFakeCanvas({ clientWidth: 300, clientHeight: 150 });
  const swapchain = new Swapchain({ canvas, device, format: "bgra8unorm", sampleCount: 4, devicePixelRatio: fixedRatio(1) });
  swapchain.configure();
  swapchain.beginFrame();

  const target = swapchain.colorTarget();
  assert.equal(swapchain.sampleCount, 4);
  assert.ok(target.view !== undefined && target.resolveTarget !== undefined, "sampleCount 4 REQUIRES both view and resolveTarget");
  assert.notEqual(target.view, target.resolveTarget, "the multisampled attachment and the presentation view are different objects");

  const msaa = device.__created.textures.filter((texture) => texture.descriptor?.sampleCount === 4);
  assert.equal(msaa.length, 2, "one multisampled colour texture plus the canvas depth-stencil attachment (W5)");
  assert.equal(msaa[0].descriptor.format, "bgra8unorm");
  assert.deepEqual(msaa[0].descriptor.size, { width: 300, height: 150, depthOrArrayLayers: 1 });
  assert.equal(target.view, msaa[0].__views[0], "the attachment view comes from the multisampled texture");
  assert.equal(canvas.getContext("webgpu").__currentTextures.length, 1, "one swap-chain texture per frame");
  assert.notEqual(canvas.getContext("webgpu").__currentTextures[0], msaa[0], "the swap-chain texture is NOT the MSAA texture");
});

test("sampleCount 1 has no resolveTarget and creates no multisampled texture", async () => {
  const { Swapchain } = await loadSwapchain();
  const device = createFakeDevice();
  const canvas = createFakeCanvas();
  const swapchain = new Swapchain({ canvas, device, format: "bgra8unorm", sampleCount: 1, devicePixelRatio: fixedRatio(1) });
  swapchain.configure();
  swapchain.beginFrame();
  const target = swapchain.colorTarget();
  assert.equal(target.resolveTarget, undefined);
  assert.equal(device.__created.textures.filter((texture) => texture.descriptor?.sampleCount === 4).length, 0);
});

test("the drawing buffer follows devicePixelRatio and a change rebuilds the attachments", async () => {
  const { Swapchain } = await loadSwapchain();
  const device = createFakeDevice();
  const canvas = createFakeCanvas({ clientWidth: 300, clientHeight: 150 });
  let ratio = 1;
  const swapchain = new Swapchain({ canvas, device, format: "bgra8unorm", sampleCount: 4, devicePixelRatio: () => ratio });
  swapchain.configure();
  assert.deepEqual([swapchain.width, swapchain.height], [300, 150]);
  assert.equal(swapchain.rebuildCount, 0);

  ratio = 2;
  assert.equal(swapchain.resizeIfNeeded(), true, "a devicePixelRatio change MUST invalidate the attachments");
  assert.deepEqual([swapchain.width, swapchain.height], [600, 300]);
  assert.equal(swapchain.rebuildCount, 1);
  assert.equal(canvas.width, 600, "the canvas attributes stay in sync with the drawing buffer");
  assert.equal(device.__created.textures.filter((texture) => texture.descriptor?.sampleCount === 4).length, 4, "the multisample attachment was rebuilt");
  assert.equal(swapchain.resizeIfNeeded(), false, "a stable size MUST NOT rebuild on every frame");

  canvas.clientWidth = 400;
  assert.equal(swapchain.resizeIfNeeded(), true);
  assert.deepEqual([swapchain.width, swapchain.height], [800, 300]);
});

test("a canvas without a WebGPU context fails loudly (no GL fallback inside the replacement)", async () => {
  const { Swapchain } = await loadSwapchain();
  const device = createFakeDevice();
  const canvas = createFakeCanvas({ hasWebgpu: false });
  assert.throws(() => new Swapchain({ canvas, device }), (error) => {
    assert.equal(error.name, "DiagnosticError");
    assert.equal(error.category, "render-failed");
    assert.match(error.message, /getContext\("webgpu"\)/);
    return true;
  });
});

test("using the swap chain outside a frame, or after destroy(), fails loudly", async () => {
  const { Swapchain } = await loadSwapchain();
  const device = createFakeDevice();
  const canvas = createFakeCanvas();
  const swapchain = new Swapchain({ canvas, device, format: "bgra8unorm", devicePixelRatio: fixedRatio(1) });
  swapchain.configure();
  assert.throws(() => swapchain.colorTarget(), /no frame is open/);
  swapchain.beginFrame();
  swapchain.endFrame();
  assert.throws(() => swapchain.colorTarget(), /no frame is open/);
  swapchain.destroy();
  assert.equal(swapchain.isDestroyed(), true);
  assert.throws(() => swapchain.beginFrame(), /destroyed/);
});

test("resolveDrawingBufferSize falls back to the canvas attributes without layout", async () => {
  const { resolveDrawingBufferSize } = await loadSwapchain();
  assert.deepEqual(resolveDrawingBufferSize({ width: 640, height: 480, clientWidth: 0, clientHeight: 0 }, 2), { width: 640, height: 480, source: "canvas-attributes" });
  assert.deepEqual(resolveDrawingBufferSize({ width: 640, height: 480, clientWidth: 320, clientHeight: 240 }, 2), { width: 640, height: 480, source: "client-size" });
  assert.deepEqual(resolveDrawingBufferSize({ width: 0, height: 0, clientWidth: 0, clientHeight: 0 }, 1), { width: 1, height: 1, source: "canvas-attributes" }, "a degenerate canvas MUST NOT produce a zero-sized attachment");
});
