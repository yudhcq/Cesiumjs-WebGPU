/**
 * T053 — slice-C stubs and explicit failure (`层=单元` + `层=架构边界`, tasks.md T053; FR-033).
 *
 * Every capability outside the MVP MUST fail with `category: "not-implemented"` and a message naming the
 * owning phase. A `Texture3D` that returns an empty texture, a `readPixels` that resolves with zero
 * bytes, or a `CubeMap` that renders black would all be indistinguishable from a working render — which
 * is exactly what FR-033 forbids. The manifest half of this test also pins T031's stub set, so the
 * declared boundary and the code cannot drift apart.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readJson, repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assertDiagnostic, createFakeAdapter, createFakeCanvas, installWebgpuGlobals } from "../support/fake-gpu.mjs";
import { upstreamStubs } from "../support/upstream-stubs.mjs";

installWebgpuGlobals();

const BACKEND = "packages/cesium-webgpu/backend-webgpu";
const manifest = readJson(`${BACKEND}/manifest.json`);

/** T031's `stub-not-implemented` set, spelled out so a silent removal fails here. */
const EXPECTED_STUB_MODULES = ["Renderer/Texture3D.js", "Renderer/CubeMap.js", "Renderer/CubeMapFace.js", "Renderer/TextureAtlas.js", "Renderer/Sync.js"];

async function loadSurface() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/not-implemented.ts`));
}

test("the registry enumerates exactly the slice-C capabilities", async () => {
  const surface = await loadSurface();
  const names = surface.SLICE_C_SURFACE.map((entry) => entry.capability);
  for (const capability of ["readPixels", "readPixelsToPBO", "Sync", "CubeMap", "Texture3D", "TextureAtlas", "ComputeEngine", "SharedContext"]) {
    assert.ok(names.includes(capability), `T053 names ${capability}; it MUST be in the registry`);
  }
  for (const entry of surface.SLICE_C_SURFACE) {
    assert.ok(entry.reason.length > 10, `${entry.capability} MUST state why it is out of scope`);
    assert.ok(entry.plannedPhase.length > 0, `${entry.capability} MUST name the phase that owns it`);
  }
  assert.throws(() => surface.sliceCEntry("NotACapability"), /not a known slice-C capability/, "the registry is closed");
});

test("every slice-C error is a not-implemented diagnostic naming its phase", async () => {
  const surface = await loadSurface();
  for (const entry of surface.SLICE_C_SURFACE) {
    const error = surface.sliceCNotImplemented(entry.capability);
    assertDiagnostic(error, "not-implemented", `sliceCNotImplemented(${entry.capability})`);
    assert.ok(error.message.includes(entry.capability), "the message MUST name the capability");
    assert.ok(error.details.plannedPhase === entry.plannedPhase);
    assert.equal(error.details.requirementRef, "FR-033");
    assert.match(error.message, /fail loudly|MUST NOT/, `the ${entry.capability} message MUST state the fail-loud discipline`);
  }
  const shared = surface.sharedContextNotImplemented();
  assertDiagnostic(shared, "not-implemented", "sharedContextNotImplemented");
  assert.match(shared.message, /SharedContext/);
});

test("the manifest's stub set is exactly T031's five modules", async () => {
  const surface = await loadSurface();
  const declared = manifest.entries.filter((entry) => entry.kind === "stub-not-implemented").map((entry) => entry.localFile);
  assert.deepEqual([...declared].sort(), [...EXPECTED_STUB_MODULES].sort(), "the manifest MUST declare exactly these five stubs");
  assert.deepEqual([...surface.stubManifestModules()].sort(), [...EXPECTED_STUB_MODULES].sort(), "the registry and the manifest MUST agree (T031/T053)");
  for (const entry of manifest.entries.filter((item) => item.kind === "stub-not-implemented")) {
    assert.ok(typeof entry.reason === "string" && entry.reason.length > 0, `${entry.localFile} MUST carry a reason`);
  }
});

test("every stub module fails loudly when it is reached (never an empty resource)", async () => {
  for (const module of EXPECTED_STUB_MODULES) {
    const file = `${BACKEND}/${module.replace(/\.js$/, ".ts")}`;
    const loaded = await loadTypeScriptModule(repoPath(file));
    assert.equal(typeof loaded.default, "function", `${module} MUST export the upstream default constructor`);
    assert.throws(() => new loaded.default({}), (error) => assertDiagnostic(error, "not-implemented", `new ${module}()`));
  }
});

test("the Context face rejects the slice-C entry points and leaves defaultFramebuffer undefined", async () => {
  const handoff = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/device-handoff.ts`));
  const { default: Context } = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/Context.ts`), { externals: upstreamStubs() });

  handoff.resetSlot();
  const adapter = createFakeAdapter();
  handoff.install({ adapter, device: adapter.device, limits: adapter.limits, features: adapter.features, source: "unit-test" });
  const context = new Context(createFakeCanvas(), {});

  for (const capability of ["createPickId", "getObjectByPickColor"]) {
    assert.throws(() => context[capability](), (error) => assertDiagnostic(error, "not-implemented", `Context#${capability}()`));
  }
  // W5: `defaultCubeMap` is a default **resource**, not the slice-C `CubeMap` class, and
  // `Renderer/UniformState.js:1558` reads it on every frame — so a context without it cannot render a
  // single frame (measured: every `Scene.render()` threw before the terrain work started). It is now a
  // real six-face 1x1 cube texture, which is why it no longer appears in this list; the slice-C
  // `CubeMap` class is still a stub.
  assert.notEqual(typeof context.defaultCubeMap, "function", "defaultCubeMap MUST be a resource, not a call");
  {
    const cubeMap = context.defaultCubeMap;
    assert.ok(cubeMap !== undefined && cubeMap !== null, "the default cube map MUST exist");
    assert.equal(cubeMap.faces, 6);
    assert.equal(cubeMap.size, 1);
  }
  await assert.rejects(context.readPixels(), (error) => assertDiagnostic(error, "not-implemented", "Context#readPixels()"));
  await assert.rejects(context.readPixelsToPBO(), (error) => assertDiagnostic(error, "not-implemented", "Context#readPixelsToPBO()"));

  // T056 landed the `Texture` replacement, so the two 1x1 placeholders are real textures now — the
  // registry entries that used to point at "W3 (T056)" are gone, and asking for them MUST return a
  // texture rather than fail. Asserted (not assumed) so the boundary cannot drift back.
  for (const property of ["defaultEmissiveTexture", "defaultNormalTexture"]) {
    const texture = context[property];
    assert.equal(texture.width, 1, `Context#${property} MUST be a real 1x1 Texture after T056`);
    assert.equal(texture.height, 1);
    assert.equal(texture.flipY, false);
    assert.equal(typeof texture.destroy, "function");
  }

  assert.equal(context.defaultFramebuffer, undefined, "the default framebuffer IS the canvas; upstream also yields undefined");
  context.destroy();
  handoff.resetSlot();
});

test("a draw without backend inputs fails loudly and names the owning tasks", async () => {
  const handoff = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/device-handoff.ts`));
  const { default: Context } = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/Context.ts`), { externals: upstreamStubs() });
  handoff.resetSlot();
  const adapter = createFakeAdapter();
  handoff.install({ adapter, device: adapter.device, limits: adapter.limits, features: adapter.features, source: "unit-test" });
  const context = new Context(createFakeCanvas(), {});
  context.beginFrame();
  assert.throws(() => context.draw({}, {}), (error) => {
    assertDiagnostic(error, "not-implemented", "Context#draw without inputs");
    // W3 landed the geometry half (the replaced `VertexArray` publishes it), so what is still missing
    // is the pipeline itself — W4 / T073+T075. The attribution MUST follow the implementation.
    // W5: W4 landed the pipeline seam (`ShaderProgram#createPipeline`), so what is missing now is a
    // command that names neither a pipeline nor a replaced program — the message names the component
    // that could supply it instead of a phase.
    assert.match(error.message, /no replaced `ShaderProgram` that could build one/, "the failure MUST name what could supply the pipeline");
    assert.equal(error.details?.extra?.hasVertexBuffers, false, "the failure MUST report which half of the payload is missing");
    return true;
  });
  context.endFrame();
  context.destroy();
  handoff.resetSlot();
});
