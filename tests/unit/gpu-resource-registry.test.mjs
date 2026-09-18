/**
 * T063 — `GpuResourceRecord` registry (`层=单元`, tasks.md T063; data-model §5.1, FR-017).
 *
 * The ledger is the **graphics-memory proxy metric** of FR-017, so the three invariants that make it
 * trustworthy are asserted directly:
 *   1. `destroy()` removes the record from the live set (data-model §5.1's validation rule) while
 *      keeping its `destroyedFrame`;
 *   2. a repeated `release()` is a no-op, so `totalBytes` can never go negative however many teardown
 *      paths run (`Framebuffer#destroy`, `FramebufferManager#destroy`, `VertexArray#destroy`, …);
 *   3. the **leak assertion**: in steady state the live set does not grow between frame N and frame
 *      N+K — the same comparison the contract suites make on real resources.
 *
 * The module-level ledger is shared through `globalThis` (see the module doc): the patch layer is
 * imported by more than one bundle in one session, and two ledgers would each report half the memory.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assertDiagnostic } from "../support/fake-gpu.mjs";

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function loadRegistryModule() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/gpu-resource-registry.ts`));
}

test("register/release keep the ledger a set and the totals honest", async () => {
  const { GpuResourceRegistry } = await loadRegistryModule();
  const registry = new GpuResourceRegistry();
  registry.setFrame(3);

  const record = registry.register({ id: "Buffer:1", kind: "buffer", bytes: 1024, upstreamClass: "Buffer" });
  assert.deepEqual({ ...record }, { id: "Buffer:1", kind: "buffer", bytes: 1024, upstreamClass: "Buffer", createdFrame: 3 }, "the record carries the data-model §5.1 fields");
  assert.equal(registry.totalBytes, 1024);
  assert.equal(registry.has("Buffer:1"), true);

  registry.register({ id: "Texture:1", kind: "texture", bytes: 4096, upstreamClass: "Texture" });
  registry.setFrame(4);
  registry.register({ id: "Sampler:1", kind: "sampler", upstreamClass: "Sampler" });
  const stats = registry.stats();
  assert.equal(stats.live, 3);
  assert.equal(stats.totalBytes, 5120);
  assert.equal(stats.created, 3);
  assert.deepEqual(stats.byKind.buffer, { count: 1, bytes: 1024 });
  assert.deepEqual(stats.byKind.sampler, { count: 1, bytes: 0 }, "a sampler owns no storage and is registered with bytes: 0");
  assert.deepEqual(stats.byUpstreamClass.Texture, { count: 1, bytes: 4096 });
  assert.equal(stats.peakBytes, 5120);
  assert.equal(stats.frame, 4);

  assert.throws(() => registry.register({ id: "Buffer:1", kind: "buffer", bytes: 1, upstreamClass: "Buffer" }), (error) => {
    assertDiagnostic(error, "internal", "duplicate register");
    assert.match(error.message, /double-count/);
    return true;
  });
  assert.throws(() => registry.register({ id: "", kind: "buffer", upstreamClass: "Buffer" }), (error) => assertDiagnostic(error, "internal", "empty id"));
  assert.throws(() => registry.register({ id: "Buffer:2", kind: "buffer", bytes: -1, upstreamClass: "Buffer" }), (error) => assertDiagnostic(error, "internal", "negative bytes"));
});

test("destroy() removes the record from the live set; a repeated release is a no-op", async () => {
  const { GpuResourceRegistry } = await loadRegistryModule();
  const registry = new GpuResourceRegistry();
  registry.setFrame(7);
  registry.register({ id: "Texture:9", kind: "texture", bytes: 2048, upstreamClass: "Texture" });
  assert.equal(registry.totalBytes, 2048);

  registry.setFrame(9);
  assert.equal(registry.release("Texture:9"), true);
  assert.equal(registry.has("Texture:9"), false, "a released record MUST leave the live set immediately");
  assert.equal(registry.totalBytes, 0);
  assert.deepEqual(registry.activeIds(), []);

  const history = registry.history();
  assert.equal(history.length, 1, "the history keeps the record so `destroyedFrame` stays auditable");
  assert.equal(history[0].destroyedFrame, 9);

  assert.equal(registry.release("Texture:9"), false, "a repeated release MUST NOT change anything");
  assert.equal(registry.release("never-registered"), false);
  assert.equal(registry.totalBytes, 0, "the total can never go negative");
  assert.equal(registry.stats().released, 1, "the ledger counts real releases only");

  registry.reset();
  assert.deepEqual(registry.stats(), {
    live: 0,
    totalBytes: 0,
    byKind: registry.stats().byKind,
    byUpstreamClass: {},
    created: 0,
    released: 0,
    peakBytes: 0,
    frame: -1,
  });
  assert.equal(registry.frame, -1);
});

test("the leak assertion: the live set does not grow between frame N and frame N+K in steady state", async () => {
  const { GpuResourceRegistry } = await loadRegistryModule();
  const registry = new GpuResourceRegistry();

  // A persistent resource (the swap-chain attachment, say) that lives for the whole session.
  registry.setFrame(0);
  registry.register({ id: "Texture:swapchain", kind: "texture", bytes: 1024, upstreamClass: "Texture" });

  /** One steady-state frame: a transient buffer and texture are created and released again. */
  const runFrame = (frame) => {
    registry.setFrame(frame);
    registry.register({ id: `Buffer:frame-${frame}`, kind: "buffer", bytes: 256, upstreamClass: "Buffer" });
    registry.register({ id: `Texture:frame-${frame}`, kind: "texture", bytes: 512, upstreamClass: "Texture" });
    registry.release(`Buffer:frame-${frame}`);
    registry.release(`Texture:frame-${frame}`);
  };

  for (let frame = 0; frame < 5; frame += 1) runFrame(frame);
  const atFrame5 = registry.activeIds();
  const bytesAtFrame5 = registry.totalBytes;
  for (let frame = 5; frame < 10; frame += 1) runFrame(frame);
  const atFrame10 = registry.activeIds();

  assert.deepEqual(atFrame5, ["Texture:swapchain"], "the transient resources are gone again after each frame");
  assert.deepEqual(atFrame10, atFrame5, "the live set is IDENTICAL after 5 more frames (LEAK ASSERTION)");
  assert.equal(registry.totalBytes, bytesAtFrame5, "and so is the FR-017 byte total");
  assert.equal(registry.stats().peakBytes, 1024 + 256 + 512, "the peak is bounded by one frame's resources, not by the frame count");
  assert.equal(registry.stats().created, 21, "one persistent resource plus two per frame over ten frames");
  assert.equal(registry.stats().released, 20, "every transient resource was released exactly once");
});

test("the byte estimate states its rule (mips, array layers, sample count)", async () => {
  const { estimateTextureBytes } = await loadRegistryModule();
  assert.equal(estimateTextureBytes({ width: 4, height: 4, bytesPerTexel: 4 }), 64);
  assert.equal(estimateTextureBytes({ width: 4, height: 4, bytesPerTexel: 4, sampleCount: 4 }), 256, "MSAA multiply");
  assert.equal(estimateTextureBytes({ width: 4, height: 4, bytesPerTexel: 4, depthOrArrayLayers: 6 }), 384, "a cube map's six faces");
  // 4x4 + 2x2 + 1x1 = 21 texels * 4 bytes
  assert.equal(estimateTextureBytes({ width: 4, height: 4, bytesPerTexel: 4, mipLevelCount: 3 }), 84, "every mip level is allocated");
  assert.equal(estimateTextureBytes({ width: 0, height: 0, bytesPerTexel: 4 }), 4, "a degenerate size still estimates one texel");
});

test("the module-level ledger is shared through globalThis (one device, one ledger)", async () => {
  const first = await loadRegistryModule();
  const second = await loadRegistryModule();
  first.gpuResourceRegistry.reset();
  first.gpuResourceRegistry.setFrame(1);
  const record = first.gpuResourceRegistry.register({ id: "shared:1", kind: "buffer", bytes: 8, upstreamClass: "Buffer" });
  assert.equal(second.gpuResourceRegistry.has(record.id), true, "a second module instance MUST see the same ledger");
  assert.equal(second.gpuResourceRegistry.totalBytes, 8);
  second.gpuResourceRegistry.reset();
  assert.equal(first.gpuResourceRegistry.stats().live, 0);
});

test("setFrame rejects anything that is not a frame number", async () => {
  const { GpuResourceRegistry } = await loadRegistryModule();
  const registry = new GpuResourceRegistry();
  assert.throws(() => registry.setFrame(-1), (error) => assertDiagnostic(error, "internal", "negative frame"));
  assert.throws(() => registry.setFrame(1.5), (error) => assertDiagnostic(error, "internal", "fractional frame"));
});
