/**
 * T056 + T058 — `Texture` → `GPUTexture` + `GPUSampler`, and the origin (Y-flip) policy
 * (`层=单元`, tasks.md T056/T058; research §6.1/§6.3, G-6).
 *
 * What is asserted on the descriptors and the uploaded bytes:
 *   - the constructor option bag and the read surface (`id` / `width` / `height` / `pixelFormat` /
 *     `pixelDatatype` / `flipY` / `preMultiplyAlpha` / `dimensions` / `sizeInBytes` / `_target`);
 *   - the **row-reversal** that makes WebGPU's `v` behave like GL's `t` when `flipY` is on, with the
 *     `flipY: false` negative control (T058's unit half — the four-corner texel assertion on a real
 *     device is `visual:texture-origin`);
 *   - `copyFrom`'s region overload (`xOffset`/`yOffset` → the copy `origin`), the component widening
 *     recorded by the format table, and `preMultiplyAlpha`;
 *   - the slice-B / slice-C boundaries: `copyFromFramebuffer`, `Texture.fromFramebuffer` and
 *     `generateMipmap` fail loudly instead of doing nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assertDiagnostic, createFakeGpuContext, installWebgpuGlobals } from "../support/fake-gpu.mjs";
import { upstreamStubs } from "../support/upstream-stubs.mjs";

installWebgpuGlobals();

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function loadTexture() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/Texture.ts`), { externals: upstreamStubs() });
}

async function upstreamEnums() {
  const { default: PixelFormat } = await import("@cesium/engine/Source/Core/PixelFormat.js");
  const { default: PixelDatatype } = await import("@cesium/engine/Source/Renderer/PixelDatatype.js");
  return { PixelFormat, PixelDatatype };
}

/** The last `queue.writeTexture` of a device double. */
function lastWrite(device) {
  return device.__calls.filter((call) => call.name === "queue.writeTexture").at(-1);
}

test("the constructor keeps the option bag and the read surface", async () => {
  const Texture = (await loadTexture()).default;
  const device = createFakeGpuContext().device;
  const context = createFakeGpuContext({ device });
  const { PixelFormat, PixelDatatype } = await upstreamEnums();

  const texture = new Texture({ context, width: 4, height: 2, pixelFormat: PixelFormat.RGBA, pixelDatatype: PixelDatatype.UNSIGNED_BYTE });
  assert.equal(texture.width, 4);
  assert.equal(texture.height, 2);
  assert.equal(texture.pixelFormat, PixelFormat.RGBA, "the upstream enum value is preserved");
  assert.equal(texture.pixelDatatype, PixelDatatype.UNSIGNED_BYTE);
  assert.equal(texture.flipY, true, "upstream's default is flipY: true (Texture.js:27)");
  assert.equal(texture.preMultiplyAlpha, false);
  assert.equal(texture.sizeInBytes, 4 * 2 * 4, "sizeInBytes keeps upstream's arithmetic");
  assert.deepEqual([texture.dimensions.x, texture.dimensions.y], [4, 2]);
  assert.equal(texture._target, 0x0de1, "TEXTURE_2D, for shape compatibility");
  assert.equal(typeof texture.id, "string");
  assert.equal(typeof texture.destroy, "function");
  assert.equal(texture.isDestroyed(), false);
  assert.equal(texture.initialized, true, "a blank texture is explicitly zeroed (never left undefined)");

  const descriptor = device.__created.textures[0].descriptor;
  assert.equal(descriptor.format, "rgba8unorm");
  assert.deepEqual(descriptor.size, { width: 4, height: 2, depthOrArrayLayers: 1 });
  assert.equal(descriptor.usage & GPUTextureUsage.TEXTURE_BINDING, GPUTextureUsage.TEXTURE_BINDING);
  assert.equal(descriptor.usage & GPUTextureUsage.RENDER_ATTACHMENT, GPUTextureUsage.RENDER_ATTACHMENT, "upstream declares no usage, so a texture stays attachable");
  assert.equal(device.__created.samplers.length, 1, "the default sampler is created once");

  texture.destroy();
  assert.equal(texture.isDestroyed(), true);
  assert.throws(() => texture.copyFrom({ source: { width: 1, height: 1, arrayBufferView: new Uint8Array(4) } }), (error) => assertDiagnostic(error, "render-failed", "copyFrom after destroy"));
});

test("flipY reverses the uploaded rows (the WebGPU counterpart of UNPACK_FLIP_Y_WEBGL)", async () => {
  const Texture = (await loadTexture()).default;
  const { PixelFormat, PixelDatatype } = await upstreamEnums();

  // A 2x2 image whose rows are distinguishable: row 0 = red/green, row 1 = blue/white.
  const source = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);

  const flippedDevice = createFakeGpuContext().device;
  const flipped = new Texture({ context: createFakeGpuContext({ device: flippedDevice }), width: 2, height: 2, pixelFormat: PixelFormat.RGBA, pixelDatatype: PixelDatatype.UNSIGNED_BYTE, source: { width: 2, height: 2, arrayBufferView: source } });
  assert.equal(flipped.flipY, true);
  const flippedWrite = lastWrite(flippedDevice);
  assert.deepEqual(
    [...flippedWrite.args[1]],
    [0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255],
    "with flipY the source's LAST row is uploaded first, so v=0 samples what GL's t=0 sampled",
  );
  assert.equal(flippedWrite.args[2].bytesPerRow, 8);
  assert.equal(flippedWrite.args[2].rowsPerImage, 2);

  // Negative control: without flipY the rows keep their order — the assertion above discriminates.
  const plainDevice = createFakeGpuContext().device;
  const plain = new Texture({ context: createFakeGpuContext({ device: plainDevice }), width: 2, height: 2, pixelFormat: PixelFormat.RGBA, pixelDatatype: PixelDatatype.UNSIGNED_BYTE, flipY: false, source: { width: 2, height: 2, arrayBufferView: source } });
  assert.equal(plain.flipY, false);
  assert.deepEqual([...lastWrite(plainDevice).args[1]], [...source], "flipY: false uploads the rows in source order");
});

test("image sources go through copyExternalImageToTexture with flipY and premultipliedAlpha", async () => {
  const Texture = (await loadTexture()).default;
  const device = createFakeGpuContext().device;
  const context = createFakeGpuContext({ device });
  const { PixelFormat, PixelDatatype } = await upstreamEnums();

  const image = { width: 8, height: 4, naturalWidth: 8, naturalHeight: 4 };
  const texture = new Texture({ context, source: image, pixelFormat: PixelFormat.RGBA, pixelDatatype: PixelDatatype.UNSIGNED_BYTE });
  assert.equal(texture.width, 8, "the intrinsic size is taken from the source");
  assert.equal(texture.height, 4);

  const copy = device.__calls.filter((call) => call.name === "queue.copyExternalImageToTexture").at(-1);
  assert.ok(copy !== undefined, "an image source MUST use copyExternalImageToTexture");
  assert.equal(copy.args[0].source, image);
  assert.equal(copy.args[0].flipY, true, "GPUImageCopyTextureTagged.flipY carries upstream's flipY");
  assert.equal(copy.args[1].premultipliedAlpha, false);
  assert.deepEqual(copy.args[2], { width: 8, height: 4, depthOrArrayLayers: 1 });

  // webMercatorT-style video sources use the video's intrinsic size (upstream's precedence).
  const video = { videoWidth: 16, videoHeight: 9 };
  const videoTexture = new Texture({ context, source: video, flipY: false });
  assert.deepEqual([videoTexture.width, videoTexture.height], [16, 9]);
  assert.equal(device.__calls.filter((call) => call.name === "queue.copyExternalImageToTexture").at(-1).args[0].flipY, false);
});

test("copyFrom keeps the region overload and widens/records what the format table says", async () => {
  const Texture = (await loadTexture()).default;
  const device = createFakeGpuContext().device;
  const context = createFakeGpuContext({ device });
  const { PixelFormat, PixelDatatype } = await upstreamEnums();

  const texture = new Texture({ context, width: 4, height: 4, pixelFormat: PixelFormat.RGBA, pixelDatatype: PixelDatatype.UNSIGNED_BYTE, flipY: false });
  texture.copyFrom({ source: { width: 2, height: 2, arrayBufferView: new Uint8Array(16) }, xOffset: 1, yOffset: 2 });
  const regionWrite = lastWrite(device);
  assert.deepEqual(regionWrite.args[0].origin, { x: 1, y: 2, z: 0 }, "xOffset/yOffset become the copy origin");
  assert.deepEqual(regionWrite.args[3], { width: 2, height: 2, depthOrArrayLayers: 1 });
  assert.equal(texture.initialized, true);

  assert.throws(() => texture.copyFrom({ source: { width: 4, height: 4, arrayBufferView: new Uint8Array(64) }, xOffset: 1 }), (error) => assertDiagnostic(error, "internal", "region out of range"));

  // RGB8 has no WebGPU counterpart: the uploader widens to RGBA and fills alpha.
  const rgbDevice = createFakeGpuContext().device;
  const rgb = new Texture({ context: createFakeGpuContext({ device: rgbDevice }), width: 1, height: 1, pixelFormat: PixelFormat.RGB, pixelDatatype: PixelDatatype.UNSIGNED_BYTE, flipY: false, source: { width: 1, height: 1, arrayBufferView: new Uint8Array([10, 20, 30]) } });
  assert.equal(rgb.formatMapping.format, "rgba8unorm");
  assert.equal(rgb.preMultiplyAlpha, true, "upstream forces preMultiplyAlpha for RGB (Texture.js:78-81)");
  const widened = lastWrite(rgbDevice);
  assert.deepEqual([...widened.args[1]], [10, 20, 30, 255], "the widened alpha is opaque");
  assert.equal(widened.args[2].bytesPerRow, 4);

  // LUMINANCE widens by replication; the recorded note names the equivalence.
  const lumDevice = createFakeGpuContext().device;
  const luminance = new Texture({ context: createFakeGpuContext({ device: lumDevice }), width: 1, height: 1, pixelFormat: PixelFormat.LUMINANCE, pixelDatatype: PixelDatatype.UNSIGNED_BYTE, flipY: false, source: { width: 1, height: 1, arrayBufferView: new Uint8Array([77]) } });
  assert.deepEqual([...lastWrite(lumDevice).args[1]], [77, 77, 77, 255]);
  assert.ok(luminance.formatMapping.notes.some((note) => /LUMINANCE/.test(note)));
});

test("preMultiplyAlpha multiplies the colour channels on the CPU for buffer sources", async () => {
  const Texture = (await loadTexture()).default;
  const device = createFakeGpuContext().device;
  const context = createFakeGpuContext({ device });
  const texture = new Texture({
    context,
    width: 1,
    height: 1,
    flipY: false,
    preMultiplyAlpha: true,
    source: { width: 1, height: 1, arrayBufferView: new Uint8Array([100, 200, 255, 128]) },
  });
  assert.equal(texture.preMultiplyAlpha, true);
  const bytes = [...lastWrite(device).args[1]];
  assert.deepEqual(bytes, [50, 100, 128, 128], "each colour channel is scaled by alpha/255 and rounded");
});

test("the depth-texture capability gates depth formats, and slice B entry points fail loudly", async () => {
  const Texture = (await loadTexture()).default;
  const { PixelFormat, PixelDatatype } = await upstreamEnums();
  const context = createFakeGpuContext();
  assert.equal(context.depthTexture, false, "slice A keeps depthTexture false");

  assert.throws(
    () => new Texture({ context, width: 2, height: 2, pixelFormat: PixelFormat.DEPTH_COMPONENT, pixelDatatype: PixelDatatype.UNSIGNED_SHORT }),
    (error) => {
      assertDiagnostic(error, "internal", "depth texture without the capability");
      assert.match(error.message, /depthTexture/);
      return true;
    },
  );
  assert.throws(
    () => new Texture({ context: createFakeGpuContext({ capabilities: { depthTexture: true } }), width: 2, height: 2, pixelFormat: PixelFormat.DEPTH_COMPONENT, pixelDatatype: PixelDatatype.UNSIGNED_SHORT, source: { width: 1, height: 1, arrayBufferView: new Uint8Array(2) } }),
    (error) => assertDiagnostic(error, "internal", "depth texture with a source"),
  );

  const texture = new Texture({ context, width: 2, height: 2 });
  for (const [name, call] of [
    ["generateMipmap", () => texture.generateMipmap()],
    ["copyFromFramebuffer", () => texture.copyFromFramebuffer(0, 0, 0, 0, 2, 2)],
    ["Texture.fromFramebuffer", () => Texture.fromFramebuffer({ context })],
    ["source.framebuffer", () => new Texture({ context, width: 2, height: 2, source: { framebuffer: {}, width: 2, height: 2 } })],
  ]) {
    assert.throws(call, (error) => {
      assertDiagnostic(error, "not-implemented", name);
      assert.match(error.message, /T097|slice B|mipmap/i);
      return true;
    });
  }
});

test("the sampler setter re-creates the GPU sampler; a partial image copy fails loudly", async () => {
  const Texture = (await loadTexture()).default;
  const device = createFakeGpuContext().device;
  const context = createFakeGpuContext({ device });
  const { default: Sampler } = await import("@cesium/engine/Source/Renderer/Sampler.js");

  const texture = new Texture({ context, width: 2, height: 2 });
  assert.equal(device.__created.samplers.length, 1);
  texture.sampler = Sampler.NEAREST;
  assert.equal(device.__created.samplers.length, 2, "assigning a sampler MUST produce a new GPUSampler");
  assert.equal(device.__created.samplers[1].descriptor.magFilter, "nearest");
  assert.equal(texture.gpuSampler, device.__created.samplers[1]);

  assert.throws(() => texture.copyFrom({ source: { width: 1, height: 1 }, xOffset: 1 }), (error) => {
    assertDiagnostic(error, "not-implemented", "partial image copy");
    assert.match(error.message, /copyExternalImageToTexture/);
    return true;
  });
});
