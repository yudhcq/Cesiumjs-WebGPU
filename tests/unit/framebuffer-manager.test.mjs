/**
 * T062 — `FramebufferManager` orchestration (`层=单元`, tasks.md T062; research §6.1, FR-030).
 *
 * The manager is the W3 module that was a **constructible placeholder** in W2 (the upstream `Scene`
 * builds one during construction through `InvertClassification`), with five entry points that failed
 * loudly and named this task. This suite pins the transition: `update` / `prepareTextures` / `clear` /
 * `destroyFramebuffer` / `status` are real now, and they orchestrate the replaced
 * `Framebuffer`/`Renderbuffer`/`Texture`/`MultisampleFramebuffer` — including the W3-specific rule
 * that the multisample pairing (attach + resolve target) is produced together.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assertDiagnostic, createFakeGpuContext, installWebgpuGlobals } from "../support/fake-gpu.mjs";
import { upstreamStubs } from "../support/upstream-stubs.mjs";

installWebgpuGlobals();

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function loadManager() {
  const { default: FramebufferManager } = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/FramebufferManager.ts`), { externals: upstreamStubs() });
  return FramebufferManager;
}

test("the constructor keeps upstream's option bag and its two caller errors", async () => {
  const FramebufferManager = await loadManager();
  assert.throws(() => new FramebufferManager({ color: false }), /Must enable at least one type of framebuffer attachment/);
  assert.throws(() => new FramebufferManager({ depth: true, depthStencil: true }), /Cannot have both a depth and depth-stencil attachment/);

  const manager = new FramebufferManager({ color: true, colorAttachmentsLength: 2, numSamples: 4 });
  assert.equal(manager.numSamples, 4);
  assert.equal(manager.framebuffer, undefined, "no framebuffer exists before update()");
  assert.equal(manager.isDirty(300, 150, 4), true, "a manager without a framebuffer is dirty");
  assert.equal(manager.isDestroyed(), false);
  assert.throws(() => manager.status, (error) => {
    assertDiagnostic(error, "internal", "status before update");
    assert.match(error.message, /no framebuffer yet/);
    return true;
  });
});

test("update() allocates the colour texture plus the multisample pairing (4x MSAA)", async () => {
  const FramebufferManager = await loadManager();
  const context = createFakeGpuContext();
  const manager = new FramebufferManager({ color: true, depth: true, numSamples: 4 });

  manager.update(context, 300, 150, 4);
  assert.equal(manager.isDirty(300, 150, 4), false, "a freshly updated manager is not dirty");
  assert.ok(manager.getColorTexture(0) !== undefined, "the colour texture is created");
  assert.ok(manager.getColorRenderbuffer(0) !== undefined, "the multisampled colour attachment is created");
  const render = manager.framebuffer;
  assert.ok(render !== undefined && render.sampleCount === 4, "the render framebuffer is the MSAA one");
  assert.ok(render.colorAttachments[0].resolveTarget !== undefined, "the resolve target is part of the pairing (T061)");
  assert.equal(render.colorAttachments[0].resolveTarget, manager.getColorTexture(0).view);
  assert.ok(manager.getDepthRenderbuffer() !== undefined, "depthTexture is false, so depth uses a Renderbuffer");
  assert.equal(manager.status, 0x8cd5);

  const resolve = manager.prepareTextures(context, false);
  assert.equal(resolve.mechanism, "resolveTarget");
  assert.equal(resolve.sampleCount, 4);
  assert.equal(manager.lastResolve, resolve);
  assert.equal(manager.prepareTextures(context, false).verifiedCount, 2);

  // A second update with identical parameters MUST NOT rebuild anything.
  const textureBefore = manager.getColorTexture(0);
  manager.update(context, 300, 150, 4);
  assert.equal(manager.getColorTexture(0), textureBefore, "an unchanged update is a no-op");

  // A dimension change rebuilds, and the old attachments are released (no leak).
  const old = manager.getColorTexture(0);
  manager.update(context, 320, 160, 4);
  assert.notEqual(manager.getColorTexture(0), old, "a dimension change MUST rebuild the attachments");
  assert.equal(old.isDestroyed(), true, "the previous pairing is released, not leaked");

  manager.destroy();
  assert.equal(manager.isDestroyed(), true);
  assert.ok(manager.getColorTexture(0) === undefined || manager.getColorTexture(0).isDestroyed(), "destroy() releases the attachments");
});

test("update() with numSamples 1 (context.msaa false) produces a plain framebuffer", async () => {
  const FramebufferManager = await loadManager();
  const context = createFakeGpuContext({ capabilities: { msaa: false } });
  const manager = new FramebufferManager({ color: true, colorAttachmentsLength: 1, numSamples: 4 });
  manager.update(context, 64, 64, 4);
  assert.equal(manager.numSamples, 1, "upstream: `numSamples = context.msaa ? (numSamples ?? 1) : 1`");
  assert.equal(manager.framebuffer.sampleCount, 1);
  assert.equal(manager.framebuffer.colorAttachments[0].resolveTarget, undefined);
  assert.equal(manager.getColorRenderbuffer(0), undefined, "no multisampled attachment without MSAA");
  assert.equal(manager.prepareTextures(context, false), null, "nothing to resolve on a single-sampled pairing");
  manager.destroy();
});

test("update() honours the caller error, the depth-stencil path and the setter conditions", async () => {
  const FramebufferManager = await loadManager();
  const context = createFakeGpuContext();
  const manager = new FramebufferManager({ color: true, numSamples: 1 });

  assert.throws(() => manager.update(context), /width and height must be defined/);
  assert.throws(() => manager.update(undefined, 10, 10), /a context is required/);

  // `createColorAttachments: false` is the only configuration in which the setters are legal — the
  // same condition upstream enforces, so a caller that swapped attachments earlier still works.
  const manual = new FramebufferManager({ color: true, createColorAttachments: false, numSamples: 1 });
  assert.throws(() => manager.setColorTexture(undefined), /createColorAttachments must be false if setColorTexture is called/);
  manual.setColorTexture(undefined, 0);
  assert.equal(manual.getColorTexture(0), undefined);
  assert.throws(() => manager.setColorRenderbuffer(undefined), /createColorAttachments must be false/);
  assert.throws(() => manager.getColorTexture(5), /index must be smaller than total number of color attachments/);

  const depthStencil = new FramebufferManager({ depthStencil: true, supportsDepthTexture: true, numSamples: 1 });
  depthStencil.update(context, 32, 32, 1);
  assert.ok(depthStencil.getDepthStencilRenderbuffer() !== undefined, "slice A (depthTexture false) falls back to a depth-stencil Renderbuffer");
  assert.equal(depthStencil.getDepthStencilTexture(), undefined, "no depth-stencil texture while the capability is off");
  assert.equal(depthStencil.framebuffer.hasDepthAttachment, true);
  assert.throws(() => depthStencil.setDepthStencilTexture(undefined), /createDepthAttachments must be false/);

  const withDepthTexture = new FramebufferManager({ depth: true, supportsDepthTexture: true, numSamples: 1 });
  withDepthTexture.update(createFakeGpuContext({ capabilities: { depthTexture: true } }), 32, 32, 1);
  assert.ok(withDepthTexture.getDepthTexture() !== undefined, "with the capability on, the depth attachment is a Texture (slice B's prerequisite)");

  manager.destroy();
  manual.destroy();
  depthStencil.destroy();
  withDepthTexture.destroy();
});

test("prepareTextures() forwards blitStencil; clear() swaps the command's framebuffer", async () => {
  const FramebufferManager = await loadManager();
  const context = createFakeGpuContext();
  const manager = new FramebufferManager({ color: true, depth: true, numSamples: 4 });
  manager.update(context, 32, 32, 4);

  const resolved = manager.prepareTextures(context, false);
  assert.equal(resolved.mechanism, "resolveTarget");
  assert.equal(resolved.sampleCount, 4);

  // Slice A blocker, made explicit: a multisampled pass with a depth-stencil attachment needs a
  // depth-stencil texture (`context.depthTexture`), and every attachment of a WebGPU pass shares one
  // sample count. Upstream fails here too — with a less specific message.
  const depthStencilManager = new FramebufferManager({ color: true, depthStencil: true, supportsDepthTexture: true, numSamples: 4 });
  assert.throws(() => depthStencilManager.update(context, 32, 32, 4), (error) => {
    assertDiagnostic(error, "not-implemented", "MSAA + depthStencil in slice A");
    assert.match(error.message, /T097\/T098a/);
    assert.match(error.message, /sample count/);
    return true;
  });

  const seen = [];
  const clearCommand = {
    framebuffer: "sentinel",
    execute(_context, _passState) {
      seen.push(this.framebuffer);
    },
  };
  manager.clear(context, clearCommand, {});
  assert.equal(seen.length, 1, "the clear command MUST have executed exactly once");
  assert.equal(seen[0], manager.framebuffer, "the manager swaps in its own framebuffer for the call");
  assert.equal(clearCommand.framebuffer, "sentinel", "...and restores the caller's value afterwards (upstream's contract)");

  const framebufferBefore = manager.framebuffer;
  manager.destroyFramebuffer();
  assert.notEqual(manager.framebuffer, framebufferBefore, "destroyFramebuffer() releases the pairing");
  assert.equal(manager.framebuffer, undefined);
  assert.equal(manager.lastResolve, null);
  manager.destroy();
});
