/**
 * T055 — `Buffer` → `GPUBuffer` (`层=单元`, tasks.md T055; research §6.1, data-model §5.2).
 *
 * The three factories, the `usage` mapping, `copyFrom → queue.writeBuffer`, `sizeInBytes`, the
 * index-buffer extras and `destroy()`/`isDestroyed()` are asserted on the **descriptors the backend
 * hands to the device** (a real device cannot be inspected that way, and `contract:resources` covers
 * the real one).
 *
 * WebGPU's 4-byte rule is asserted from both sides: an aligned write goes straight through, a write
 * whose length is not a multiple of 4 is zero-padded **and recorded** (never silently truncated), and
 * a misaligned *offset* — which WebGPU cannot express at all — fails loudly.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assertDiagnostic, createFakeAdapter, createFakeCanvas, installWebgpuGlobals } from "../support/fake-gpu.mjs";
import { upstreamStubs } from "../support/upstream-stubs.mjs";

installWebgpuGlobals();

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

/** A WebGPU context double: exactly what the resource classes read (`device` + the capability flags). */
function createContext(device = createFakeAdapter().device) {
  return {
    device,
    id: "unit-context",
    msaa: true,
    depthTexture: false,
    elementIndexUint: true,
    drawingBufferWidth: 300,
    drawingBufferHeight: 150,
    contextLimits: { maximumTextureSize: 16384, maximumRenderbufferSize: 16384, maximumColorAttachments: 8 },
    registerTarget() {},
    unregisterTarget() {},
    isDestroyed: () => false,
  };
}

async function loadBufferModule() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/Buffer.ts`), { externals: upstreamStubs() });
}

async function loadRegistry() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/gpu-resource-registry.ts`));
}

test("the three factories map to the three GPUBufferUsage roles", async () => {
  const Buffer = (await loadBufferModule()).default;
  const { BufferUsage } = upstreamStubs();
  void BufferUsage;
  const { default: BufferUsageEnum } = await import("@cesium/engine/Source/Renderer/BufferUsage.js");
  const { default: IndexDatatype } = await import("@cesium/engine/Source/Core/IndexDatatype.js").catch(() => ({ default: { UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405 } }));
  const device = createFakeAdapter().device;
  const context = createContext(device);

  const vertex = Buffer.createVertexBuffer({ context, typedArray: new Float32Array([0, 0, 0]), usage: BufferUsageEnum.STATIC_DRAW });
  const index = Buffer.createIndexBuffer({ context, typedArray: new Uint16Array([0, 1, 2]), usage: BufferUsageEnum.STATIC_DRAW, indexDatatype: IndexDatatype.UNSIGNED_SHORT });
  const pixel = Buffer.createPixelBuffer({ context, sizeInBytes: 64, usage: BufferUsageEnum.DYNAMIC_READ });

  const descriptors = device.__created.buffers.map((buffer) => buffer.descriptor);
  assert.equal(descriptors.length, 3, "one GPUBuffer per factory call");
  const [vertexDescriptor, indexDescriptor, pixelDescriptor] = descriptors;
  assert.equal(vertexDescriptor.usage & GPUBufferUsage.VERTEX, GPUBufferUsage.VERTEX);
  assert.equal(vertexDescriptor.usage & GPUBufferUsage.COPY_DST, GPUBufferUsage.COPY_DST);
  assert.equal(indexDescriptor.usage & GPUBufferUsage.INDEX, GPUBufferUsage.INDEX);
  assert.equal(indexDescriptor.usage & GPUBufferUsage.VERTEX, 0);
  assert.equal(pixelDescriptor.usage & GPUBufferUsage.MAP_READ, GPUBufferUsage.MAP_READ);
  assert.equal(pixelDescriptor.usage & GPUBufferUsage.INDEX, 0);

  assert.equal(vertex.sizeInBytes, 12, "sizeInBytes comes from the typed array");
  assert.equal(vertex.usage, BufferUsageEnum.STATIC_DRAW, "the upstream usage value is preserved");
  assert.equal(index.sizeInBytes, 6);
  assert.equal(index.indexDatatype, IndexDatatype.UNSIGNED_SHORT);
  assert.equal(index.bytesPerIndex, 2);
  assert.equal(index.numberOfIndices, 3);
  assert.equal(pixel.sizeInBytes, 64);

  // WebGPU requires 4-byte-aligned buffer sizes: the allocation is rounded up, the value upstream
  // reads is not (the tail lies outside every range the logic layer can name).
  assert.equal(indexDescriptor.size, 8, "6 bytes are allocated as 8: WebGPU sizes are 4-byte granular");
  assert.equal(vertexDescriptor.size, 12);

  vertex.destroy();
  index.destroy();
  pixel.destroy();
});

test("the constructor keeps upstream's option validation", async () => {
  const Buffer = (await loadBufferModule()).default;
  const { default: BufferUsage } = await import("@cesium/engine/Source/Renderer/BufferUsage.js");
  const context = createContext();

  assert.throws(() => new Buffer({ context, usage: BufferUsage.STATIC_DRAW }), /either options.sizeInBytes or options.typedArray is required/);
  assert.throws(
    () => new Buffer({ context, typedArray: new Uint8Array(4), sizeInBytes: 4, usage: BufferUsage.STATIC_DRAW }),
    /cannot pass in both/,
  );
  assert.throws(() => new Buffer({ context, sizeInBytes: 0, usage: BufferUsage.STATIC_DRAW }), /must be greater than zero/);
  assert.throws(() => new Buffer({ context, sizeInBytes: 4, usage: 0x1234 }), /usage .* is invalid/);
  assert.throws(() => Buffer.createVertexBuffer({ usage: BufferUsage.STATIC_DRAW, sizeInBytes: 4 }), /options.context/);
  assert.throws(() => Buffer.createIndexBuffer({ context, typedArray: new Uint16Array(3), usage: BufferUsage.STATIC_DRAW, indexDatatype: 0x1234 }), /invalid indexDatatype/);
  assert.throws(
    () => Buffer.createIndexBuffer({ context: { ...createContext(), elementIndexUint: false }, typedArray: new Uint32Array(3), usage: BufferUsage.STATIC_DRAW, indexDatatype: 0x1405 }),
    /OES_element_index_uint/,
  );
});

test("copyFromArrayView writes through queue.writeBuffer, padding and recording the 4-byte rule", async () => {
  const Buffer = (await loadBufferModule()).default;
  const { resetBufferWriteNotes, bufferWriteNotes } = await loadBufferModule();
  const { default: BufferUsage } = await import("@cesium/engine/Source/Renderer/BufferUsage.js");
  resetBufferWriteNotes();
  const device = createFakeAdapter().device;
  const context = createContext(device);

  const buffer = Buffer.createVertexBuffer({ context, sizeInBytes: 16, usage: BufferUsage.DYNAMIC_DRAW });
  const writesBefore = device.__calls.filter((call) => call.name === "queue.writeBuffer").length;
  buffer.copyFromArrayView(new Float32Array([1, 2, 3, 4]), 0);
  const alignedWrites = device.__calls.filter((call) => call.name === "queue.writeBuffer");
  assert.equal(alignedWrites.length, writesBefore + 1, "an aligned write MUST go straight to the queue");
  assert.equal(alignedWrites.at(-1).args[1], 0, "the offset is passed through");
  assert.equal(alignedWrites.at(-1).args[2].byteLength, 16);
  assert.deepEqual([...bufferWriteNotes()], [], "an aligned write MUST NOT record a padding");

  // 6 bytes at offset 4: the length is not a multiple of 4, so the write is zero-padded to 8 and the
  // padding is *recorded* (FR-023) — the terrain path never reaches this, and a future reader can see
  // that it happened.
  buffer.copyFromArrayView(new Uint8Array([1, 2, 3, 4, 5, 6]), 4);
  const paddedWrite = alignedWrites.length === 0 ? null : device.__calls.filter((call) => call.name === "queue.writeBuffer").at(-1);
  assert.equal(paddedWrite.args[2].byteLength, 8, "a 6-byte write is padded to 8 bytes");
  assert.deepEqual([...paddedWrite.args[2]], [1, 2, 3, 4, 5, 6, 0, 0], "the padding bytes are zero");
  assert.deepEqual([...bufferWriteNotes()], [{ bytes: 2, count: 1 }], "the padding MUST be recorded, not silent");

  assert.throws(() => buffer.copyFromArrayView(new Uint8Array(4), 2), (error) => {
    assertDiagnostic(error, "not-implemented", "misaligned offset");
    assert.match(error.message, /4-byte-aligned offset/);
    return true;
  });
  assert.throws(() => buffer.copyFromArrayView(new Float32Array(8), 0), (error) => assertDiagnostic(error, "internal", "write past the end"));

  buffer.destroy();
  assert.equal(buffer.isDestroyed(), true);
  assert.throws(() => buffer.copyFromArrayView(new Uint8Array(4), 0), (error) => assertDiagnostic(error, "render-failed", "write after destroy"));
});

test("copyFromBuffer uses a one-shot submit; getBufferData fails loudly (slice C)", async () => {
  const Buffer = (await loadBufferModule()).default;
  const { default: BufferUsage } = await import("@cesium/engine/Source/Renderer/BufferUsage.js");
  const device = createFakeAdapter().device;
  const context = createContext(device);

  const source = Buffer.createVertexBuffer({ context, typedArray: new Float32Array([1, 2, 3, 4]), usage: BufferUsage.STATIC_DRAW });
  const target = Buffer.createVertexBuffer({ context, sizeInBytes: 16, usage: BufferUsage.DYNAMIC_DRAW });
  const submitsBefore = device.queue.submitted.length;
  target.copyFromBuffer(source, 0, 0, 16);
  assert.equal(device.queue.submitted.length, submitsBefore + 1, "the copy is submitted immediately, preserving GL's ordering");
  const encoder = device.__created.encoders.at(-1);
  assert.deepEqual(encoder.__calls.map((call) => call.name), ["copyBufferToBuffer", "finish"]);

  assert.throws(() => target.copyFromBuffer(source, 2, 0, 8), (error) => assertDiagnostic(error, "not-implemented", "misaligned copy"));
  assert.throws(() => target.copyFromBuffer(source, 0, 0, 99), (error) => assertDiagnostic(error, "internal", "copy past the end"));
  assert.throws(() => target.getBufferData(new Float32Array(4)), (error) => {
    assertDiagnostic(error, "not-implemented", "getBufferData");
    assert.match(error.message, /mapAsync|slice C/);
    return true;
  });

  source.destroy();
  target.destroy();
});

test("destroy() releases the ledger entry exactly once (never a negative total)", async () => {
  const Buffer = (await loadBufferModule()).default;
  const { default: BufferUsage } = await import("@cesium/engine/Source/Renderer/BufferUsage.js");
  const { gpuResourceRegistry } = await loadRegistry();
  gpuResourceRegistry.reset();
  const context = createContext();

  const buffer = Buffer.createVertexBuffer({ context, typedArray: new Float32Array(4), usage: BufferUsage.STATIC_DRAW });
  assert.equal(gpuResourceRegistry.stats().live, 1);
  assert.equal(gpuResourceRegistry.totalBytes, 16);
  assert.equal(gpuResourceRegistry.stats().byUpstreamClass.Buffer.count, 1);

  buffer.destroy();
  buffer.destroy();
  assert.equal(gpuResourceRegistry.stats().live, 0);
  assert.equal(gpuResourceRegistry.totalBytes, 0, "a repeated destroy MUST NOT drive the total anywhere");
  assert.equal(gpuResourceRegistry.stats().released, 1, "the second destroy is a no-op");
  assert.equal(gpuResourceRegistry.history()[0].destroyedFrame >= -1, true, "the record keeps its destroyedFrame");
});

test("a context without a WebGPU device fails loudly (the delegated WebGL2 path is W6)", async () => {
  const Buffer = (await loadBufferModule()).default;
  const { default: BufferUsage } = await import("@cesium/engine/Source/Renderer/BufferUsage.js");
  const canvas = createFakeCanvas();
  void canvas;
  assert.throws(() => Buffer.createVertexBuffer({ context: { _gl: {} }, typedArray: new Float32Array(3), usage: BufferUsage.STATIC_DRAW }), (error) => {
    assertDiagnostic(error, "not-implemented", "delegated WebGL2 context");
    assert.match(error.message, /W6 \(T100\/T101/);
    return true;
  });
  assert.throws(() => Buffer.createVertexBuffer({ typedArray: new Float32Array(3), usage: BufferUsage.STATIC_DRAW }), (error) => assertDiagnostic(error, "internal", "missing context"));
});
