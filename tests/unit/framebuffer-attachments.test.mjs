/**
 * T061 — `Framebuffer` / `Renderbuffer` / `MultisampleFramebuffer` attachment-ification
 * (`层=单元`, tasks.md T061; research §6.1, data-model §5.2, FR-030).
 *
 * A WebGL framebuffer is an object you bind; a WebGPU render pass takes its attachments in the
 * descriptor. The assertions therefore look at **what a pass would receive**:
 *   - `colorAttachments[i].view` points at the attachment's texture view, and a multisampled colour
 *     attachment carries its `resolveTarget` **as a pair** (one can never appear without the other);
 *   - a depth/stencil `Renderbuffer` becomes a `GPUTexture` (there is no renderbuffer object);
 *   - `MultisampleFramebuffer.blitFramebuffers` is "ensure the resolve has happened": it verifies the
 *     pairing and records it, and a **stencil** resolve — which WebGPU cannot express — fails loudly
 *     naming the slice-B task that owns that path;
 *   - upstream's option validation and `destroyAttachments`/`isDestroyed()` semantics survive.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assertDiagnostic, createFakeGpuContext, installWebgpuGlobals } from "../support/fake-gpu.mjs";
import { upstreamStubs } from "../support/upstream-stubs.mjs";

installWebgpuGlobals();

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function loadModules() {
  const { default: Texture } = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/Texture.ts`), { externals: upstreamStubs() });
  const { default: Renderbuffer } = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/Renderbuffer.ts`), { externals: upstreamStubs() });
  const { default: Framebuffer } = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/Framebuffer.ts`), { externals: upstreamStubs() });
  const { default: MultisampleFramebuffer } = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/MultisampleFramebuffer.ts`), { externals: upstreamStubs() });
  return { Texture, Renderbuffer, Framebuffer, MultisampleFramebuffer };
}

async function upstreamEnums() {
  const { default: PixelFormat } = await import("@cesium/engine/Source/Core/PixelFormat.js");
  const { default: PixelDatatype } = await import("@cesium/engine/Source/Renderer/PixelDatatype.js");
  const { default: RenderbufferFormat } = await import("@cesium/engine/Source/Renderer/RenderbufferFormat.js");
  return { PixelFormat, PixelDatatype, RenderbufferFormat };
}

test("a depth/stencil Renderbuffer is a GPUTexture with the mapped format and sample count", async () => {
  const { Renderbuffer } = await loadModules();
  const { RenderbufferFormat } = await upstreamEnums();
  const device = createFakeGpuContext().device;
  const context = createFakeGpuContext({ device });

  const depth = new Renderbuffer({ context, format: RenderbufferFormat.DEPTH_STENCIL, width: 64, height: 32 });
  assert.equal(depth.format, RenderbufferFormat.DEPTH_STENCIL, "the upstream enum value is what the logic layer reads");
  assert.deepEqual([depth.width, depth.height], [64, 32]);
  assert.equal(depth.numSamples, 1);
  assert.equal(depth.gpuFormat, "depth24plus-stencil8");
  assert.equal(depth.kind, "depth-stencil");
  assert.equal(device.__created.textures.at(-1).descriptor.format, "depth24plus-stencil8");
  assert.equal(device.__created.textures.at(-1).descriptor.usage & GPUTextureUsage.RENDER_ATTACHMENT, GPUTextureUsage.RENDER_ATTACHMENT);
  assert.equal(device.__created.textures.at(-1).descriptor.sampleCount, undefined, "a single-sampled attachment MUST NOT declare sampleCount");
  assert.equal(depth._getRenderbuffer(), depth.gpuTexture, "`_getRenderbuffer()` yields the platform handle (a GPUTexture)");

  const msaa = new Renderbuffer({ context, format: RenderbufferFormat.RGBA8, width: 64, height: 32, numSamples: 4 });
  assert.equal(msaa.numSamples, 4);
  assert.equal(device.__created.textures.at(-1).descriptor.sampleCount, 4, "numSamples 4 becomes GPUTextureDescriptor.sampleCount");
  assert.equal(device.__created.textures.at(-1).descriptor.format, "rgba8unorm");

  assert.throws(() => new Renderbuffer({ context, format: RenderbufferFormat.RGBA8, width: 64, height: 32, numSamples: 8 }), (error) => {
    assertDiagnostic(error, "not-implemented", "numSamples 8");
    assert.match(error.message, /sampleCount/);
    return true;
  });
  assert.throws(() => new Renderbuffer({ context, format: 0x1234, width: 4, height: 4 }), (error) => assertDiagnostic(error, "internal", "invalid format"));
  assert.throws(() => new Renderbuffer({ context, format: RenderbufferFormat.RGBA8, width: 0, height: 4 }), (error) => assertDiagnostic(error, "internal", "width zero"));

  depth.destroy();
  assert.equal(depth.isDestroyed(), true);
  msaa.destroy();
});

test("Framebuffer builds the attachment set a pass receives and registers it with the context", async () => {
  const { Texture, Renderbuffer, Framebuffer } = await loadModules();
  const { PixelFormat, PixelDatatype, RenderbufferFormat } = await upstreamEnums();
  const context = createFakeGpuContext();

  const color = new Texture({ context, width: 32, height: 16, pixelFormat: PixelFormat.RGBA, pixelDatatype: PixelDatatype.UNSIGNED_BYTE });
  const depth = new Renderbuffer({ context, format: RenderbufferFormat.DEPTH_COMPONENT16, width: 32, height: 16 });
  const framebuffer = new Framebuffer({ context, colorTextures: [color], depthRenderbuffer: depth, destroyAttachments: false });

  assert.equal(framebuffer.numberOfColorAttachments, 1);
  assert.equal(framebuffer.colorAttachments.length, 1);
  assert.equal(framebuffer.colorAttachments[0].view, color.view, "the attachment view comes from the texture");
  assert.equal(framebuffer.colorAttachments[0].resolveTarget, undefined, "a single-sampled attachment has no resolve target");
  assert.equal(framebuffer.depthStencilAttachment.view, depth.view);
  assert.equal(framebuffer.hasDepthAttachment, true);
  assert.equal(framebuffer.sampleCount, 1);
  assert.equal(framebuffer.depthRenderbuffer, depth);
  assert.equal(framebuffer.getColorTexture(0), color);
  assert.deepEqual([...framebuffer._getActiveColorAttachments()], [0x8ce0], "GL's COLOR_ATTACHMENT0 is preserved for shape compatibility");
  assert.equal(framebuffer.status, 0x8cd5, "a well-formed attachment set reports FRAMEBUFFER_COMPLETE");

  // The WebGPU counterpart of `glBindFramebuffer`: the set is reachable by id, which is how a
  // command's `_framebuffer` names its target.
  assert.equal(context.__registeredTargets.get(framebuffer.id), framebuffer);

  framebuffer.destroy();
  assert.equal(framebuffer.isDestroyed(), true);
  assert.equal(context.__registeredTargets.has(framebuffer.id), false, "destroy() MUST unregister the target");
  assert.equal(color.isDestroyed(), false, "destroyAttachments: false means the manager keeps ownership");

  const owning = new Framebuffer({ context, colorTextures: [new Texture({ context, width: 4, height: 4 })], destroyAttachments: true });
  const ownedTexture = owning.getColorTexture(0);
  owning.destroy();
  assert.equal(ownedTexture.isDestroyed(), true, "destroyAttachments: true means the framebuffer owns its attachments (upstream's default)");
});

test("a multisampled colour attachment ALWAYS carries its resolveTarget", async () => {
  const { Texture, Renderbuffer, Framebuffer } = await loadModules();
  const { RenderbufferFormat } = await upstreamEnums();
  const context = createFakeGpuContext();

  const resolveTexture = new Texture({ context, width: 32, height: 16 });
  const msaaRenderbuffer = new Renderbuffer({ context, format: RenderbufferFormat.RGBA8, width: 32, height: 16, numSamples: 4 });
  const framebuffer = new Framebuffer({ context, colorRenderbuffers: [msaaRenderbuffer], resolveTextures: [resolveTexture], destroyAttachments: false });

  const attachments = framebuffer.colorAttachments;
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].view, msaaRenderbuffer.view, "the pass renders into the multisampled attachment");
  assert.equal(attachments[0].resolveTarget, resolveTexture.view, "...and resolves into the texture: the pair is produced together");
  assert.equal(framebuffer.sampleCount, 4, "the pass key's sampleCount follows the attachment");

  // A multisampled attachment without a resolve target is a silently lost frame, not a warning.
  assert.throws(
    () => new Framebuffer({ context, colorRenderbuffers: [new Renderbuffer({ context, format: RenderbufferFormat.RGBA8, width: 4, height: 4, numSamples: 4 })] }),
    (error) => {
      assertDiagnostic(error, "internal", "MSAA without resolve");
      assert.match(error.message, /resolveTarget/);
      return true;
    },
  );

  // Two colour attachments with different sample counts cannot share one pass.
  assert.throws(
    () =>
      new Framebuffer({
        context,
        colorRenderbuffers: [
          new Renderbuffer({ context, format: RenderbufferFormat.RGBA8, width: 4, height: 4, numSamples: 4 }),
          new Renderbuffer({ context, format: RenderbufferFormat.RGBA8, width: 4, height: 4, numSamples: 1 }),
        ],
        resolveTextures: [new Texture({ context, width: 4, height: 4 }), undefined],
      }),
    (error) => assertDiagnostic(error, "internal", "mixed sample counts"),
  );
});

test("Framebuffer keeps upstream's option validation and its no-op bind methods", async () => {
  const { Texture, Renderbuffer, Framebuffer } = await loadModules();
  const { PixelFormat, PixelDatatype, RenderbufferFormat } = await upstreamEnums();
  const context = createFakeGpuContext();
  const color = new Texture({ context, width: 4, height: 4 });
  const colorRenderbuffer = new Renderbuffer({ context, format: RenderbufferFormat.RGBA8, width: 4, height: 4 });
  const depthRenderbuffer = new Renderbuffer({ context, format: RenderbufferFormat.DEPTH_COMPONENT16, width: 4, height: 4 });
  const depthTexture = new Texture({ context: createFakeGpuContext({ capabilities: { depthTexture: true } }), width: 4, height: 4, pixelFormat: PixelFormat.DEPTH_COMPONENT, pixelDatatype: PixelDatatype.UNSIGNED_SHORT });

  assert.throws(() => new Framebuffer({ context, colorTextures: [color], colorRenderbuffers: [colorRenderbuffer] }), /both color texture and color renderbuffer/);
  assert.throws(() => new Framebuffer({ context, depthTexture, depthRenderbuffer }), /both a depth texture and depth renderbuffer/);
  assert.throws(() => new Framebuffer({ context, depthRenderbuffer, stencilRenderbuffer: depthRenderbuffer }), /both a depth and stencil attachment/);
  assert.throws(() => new Framebuffer({}), (error) => assertDiagnostic(error, "internal", "no context"));
  assert.throws(() => new Framebuffer({ context, colorTextures: [depthTexture] }), /color-texture pixel-format must be a color format/);
  assert.throws(() => new Framebuffer({ context, colorTextures: [color], depthTexture: color }), /depth-texture pixel-format must be DEPTH_COMPONENT/);
  assert.throws(() => new Framebuffer({ context, colorTextures: [] }).getColorTexture(3), /must be less than the number of color attachments/);
  // An attachment set with no colour attachments is legal upstream (the status is what reports it),
  // so it MUST NOT be turned into a caller error here either.
  assert.equal(new Framebuffer({ context, destroyAttachments: false }).numberOfColorAttachments, 0);

  const framebuffer = new Framebuffer({ context, colorTextures: [color], destroyAttachments: false });
  // `_bind`/`_unBind`/`bindDraw`/`bindRead` have no WebGPU counterpart: they are documented no-ops,
  // never a silent capability loss (the pass descriptor carries the target instead).
  framebuffer._bind();
  framebuffer._unBind();
  framebuffer.bindDraw();
  framebuffer.bindRead();
  assert.equal(framebuffer.hasDepthAttachment, false);
});

test("MultisampleFramebuffer pairs the two framebuffers and makes blitFramebuffers an implicit resolve", async () => {
  const { Texture, Renderbuffer, MultisampleFramebuffer } = await loadModules();
  const { RenderbufferFormat } = await upstreamEnums();
  const context = createFakeGpuContext();

  const colorTextures = [new Texture({ context, width: 32, height: 16 })];
  const colorRenderbuffers = [new Renderbuffer({ context, format: RenderbufferFormat.RGBA8, width: 32, height: 16, numSamples: 4 })];
  const multisample = new MultisampleFramebuffer({ context, width: 32, height: 16, colorTextures, colorRenderbuffers, destroyAttachments: false });

  const render = multisample.getRenderFramebuffer();
  const color = multisample.getColorFramebuffer();
  assert.equal(render.colorAttachments[0].view, colorRenderbuffers[0].view);
  assert.equal(render.colorAttachments[0].resolveTarget, colorTextures[0].view, "the pairing IS the resolve target");
  assert.equal(render.sampleCount, 4);
  assert.equal(color.colorAttachments[0].view, colorTextures[0].view);
  assert.equal(color.sampleCount, 1, "the colour framebuffer is the single-sampled destination");
  assert.equal(multisample.sampleCount, 4);

  const record = multisample.blitFramebuffers(context, false);
  assert.deepEqual(
    { mechanism: record.mechanism, resolvedAt: record.resolvedAt, sampleCount: record.sampleCount, colorAttachments: record.colorAttachments },
    { mechanism: "resolveTarget", resolvedAt: "pass-end", sampleCount: 4, colorAttachments: 1 },
    "the GL blit is replaced by the pass-end resolve; the call verifies the pairing instead of copying",
  );
  assert.equal(multisample.verifiedCount, 1);
  assert.equal(multisample.blitFramebuffers(context, false).verifiedCount, 2);

  assert.throws(() => new MultisampleFramebuffer({ context, width: 4, height: 4, colorTextures: [] }), /both color renderbuffer and texture attachments/);
  assert.throws(() => new MultisampleFramebuffer({ width: 4, height: 4 }), (error) => assertDiagnostic(error, "internal", "no context"));
  assert.throws(() => new MultisampleFramebuffer({ context, width: 4, height: 4, depthStencilRenderbuffer: new Renderbuffer({ context, format: RenderbufferFormat.DEPTH24_STENCIL8, width: 4, height: 4 }) }), /both depth-stencil renderbuffer and texture attachments/);

  multisample.destroy();
  assert.equal(multisample.isDestroyed(), true);
  assert.throws(() => multisample.blitFramebuffers(context, false), (error) => assertDiagnostic(error, "render-failed", "blit after destroy"));
});

test("a stencil resolve fails loudly: WebGPU resolves colour attachments only (slice B / T097)", async () => {
  const { Texture, Renderbuffer, MultisampleFramebuffer } = await loadModules();
  const { PixelFormat, PixelDatatype, RenderbufferFormat } = await upstreamEnums();
  const context = createFakeGpuContext();
  const depthContext = createFakeGpuContext({ capabilities: { depthTexture: true } });

  const multisample = new MultisampleFramebuffer({
    context,
    width: 16,
    height: 16,
    colorTextures: [new Texture({ context, width: 16, height: 16 })],
    colorRenderbuffers: [new Renderbuffer({ context, format: RenderbufferFormat.RGBA8, width: 16, height: 16, numSamples: 4 })],
    depthStencilTexture: new Texture({ context: depthContext, width: 16, height: 16, pixelFormat: PixelFormat.DEPTH_STENCIL, pixelDatatype: PixelDatatype.UNSIGNED_INT_24_8 }),
    depthStencilRenderbuffer: new Renderbuffer({ context, format: RenderbufferFormat.DEPTH24_STENCIL8, width: 16, height: 16, numSamples: 4 }),
    destroyAttachments: false,
  });

  assert.throws(() => multisample.blitFramebuffers(context, true), (error) => {
    assertDiagnostic(error, "not-implemented", "stencil resolve");
    assert.match(error.message, /T097/);
    assert.match(error.message, /colour attachments only/);
    return true;
  });
  // Without the stencil request the colour resolve is still verified (upstream's `blitStencil` is a
  // parameter, and `GlobeDepth` passes the value it needs).
  assert.equal(multisample.blitFramebuffers(context, false).stencilRequested, false);
});
