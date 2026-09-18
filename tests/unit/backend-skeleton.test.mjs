/**
 * T037 — patch-layer skeleton and fail-loud helper.
 *
 * The skeleton MUST be loadable and MUST fail diagnosably: a placeholder capability that returns
 * an empty value, `undefined` or a black frame would be silently wrong, which is exactly what
 * FR-033 forbids. These cases therefore execute the real modules (compiled + bundled in-process
 * by `tests/support/ts-module-loader.mjs`) and assert the thrown `DiagnosticError` category —
 * not the source text.
 *
 * Coverage:
 *   - `webgpu/errors.ts` builds and throws `not-implemented` diagnostics;
 *   - every `Renderer/**` replacement module that is STILL a placeholder fails loudly on construction /
 *     its factory entry;
 *   - every `webgpu/**` placeholder module that is STILL a placeholder fails loudly on its documented
 *     entry point;
 *   - the four-valued manifest `kind` matches the skeleton's intent (stubs included).
 *
 * T037's scope narrows as the implementation phases land: W2 (T042-T053) turned `device-handoff`,
 * `capability`, `pass-encoder`, `pipeline-cache`, `Renderer/Context` and `Renderer/RenderState` into
 * real implementations, so they are asserted by their own suites
 * (`tests/unit/{context-construction,context-dispatch,capability-composition,pass-encoder,pipeline-cache,render-state-mapping}.test.mjs`)
 * instead of by this placeholder scan. The lists below therefore name exactly the modules that MUST
 * still fail loudly, and `the W2 modules are implemented, not stubbed` pins the transition so a
 * regression back to a placeholder cannot slip through.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { readJson, repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { upstreamStubs } from "../support/upstream-stubs.mjs";

const BACKEND = "packages/cesium-webgpu/backend-webgpu";
const manifest = readJson(`${BACKEND}/manifest.json`);

/** Constructor-style replacements that are STILL placeholders: `new Module()` MUST fail loudly. */
const CLASS_MODULES = [
  "Texture",
  "ShaderProgram",
  "Buffer",
  "VertexArray",
  "Framebuffer",
  "Renderbuffer",
  "MultisampleFramebuffer",
  "ShaderSource",
  "SharedContext",
  "Texture3D",
  "CubeMap",
  "CubeMapFace",
  "TextureAtlas",
  "Sync",
];

/** Factory-style replacements: calling the default export MUST fail loudly. */
const FUNCTION_MODULES = ["createUniform", "createUniformArray", "loadCubeMap"];

/** Static factory entry points the upstream logic layer calls without constructing. */
const STATIC_ENTRIES = [
  ["Buffer", "createVertexBuffer"],
  ["Buffer", "createIndexBuffer"],
  ["Buffer", "createPixelBuffer"],
  ["Texture", "create"],
  ["Texture", "fromFramebuffer"],
  ["ShaderProgram", "fromCache"],
  ["VertexArray", "fromGeometry"],
];

/** Every `webgpu/**` module that is STILL a placeholder, with the entry point it MUST refuse. */
const WEBGPU_ENTRIES = [
  ["bind-layout.ts", "buildBindLayout", [""]],
  ["bind-layout.ts", "emitWgslStruct", [{}]],
  ["shader-emit.ts", "emitShader", [{}]],
  ["shader-emit.ts", "assertVaryingsPair", [{}, {}]],
  ["glsl-preprocess.ts", "evaluateConditionals", ["", {}]],
  ["glsl-preprocess.ts", "inlineCzmBuiltins", [""]],
  ["glsl-preprocess.ts", "textureUnitsDefine", [1]],
  ["wgsl-prelude/index.ts", "preludeFor", [[]]],
  ["wgsl-prelude/index.ts", "renderPrelude", [[]]],
  ["wgsl/index.ts", "loadShaderLibrary", []],
  ["wgsl/index.ts", "readWgslModule", ["GlobeVS"]],
];

/** Modules W2 implemented: they MUST be loadable and MUST NOT be placeholders any more. */
const W2_IMPLEMENTED_MODULES = [
  "webgpu/device-handoff.ts",
  "webgpu/capability.ts",
  "webgpu/pass-encoder.ts",
  "webgpu/pipeline-cache.ts",
  "webgpu/swapchain.ts",
  "webgpu/error-scope.ts",
  "webgpu/whole-switch.ts",
  "webgpu/not-implemented.ts",
  "webgpu/default-resources.ts",
  "Renderer/Context.ts",
  "Renderer/RenderState.ts",
  "Renderer/ShaderCache.ts",
  "Renderer/TextureCache.ts",
  "Renderer/ComputeEngine.ts",
  "Renderer/FramebufferManager.ts",
];

/** A thrown error that is a diagnosable `not-implemented` diagnostic. */
function assertNotImplemented(error, where) {
  assert.ok(error instanceof Error, `${where} MUST throw an Error, got ${String(error)}`);
  assert.equal(error.name, "DiagnosticError", `${where} MUST throw a DiagnosticError (${error.message})`);
  assert.equal(error.category, "not-implemented", `${where} MUST use category "not-implemented"`);
  assert.ok(typeof error.message === "string" && error.message.length > 20, `${where} MUST carry an explanatory message`);
  assert.ok(error.details?.plannedPhase, `${where} MUST name the phase that implements the capability`);
  assert.ok(error.details?.requirementRef ?? error.details?.upstreamModule, `${where} MUST trace to a requirement or an upstream module`);
  return true;
}

test("errors.ts exposes the fail-loud helper and the six contract categories", async () => {
  const errors = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/errors.ts`));
  assert.deepEqual(
    [...errors.DIAGNOSTIC_CATEGORIES],
    ["not-implemented", "data-unavailable", "render-failed", "probe-failed", "device-lost", "internal"],
  );

  const diagnostic = errors.notImplemented("a placeholder capability", { entryPoint: "test", plannedPhase: "W2", requirementRef: "FR-033" });
  assert.equal(diagnostic.category, "not-implemented");
  assert.equal(diagnostic.name, "DiagnosticError");
  assert.ok(diagnostic instanceof Error);
  assert.equal(diagnostic.backend, undefined, "the backend is optional and stays undefined unless known");

  assert.throws(
    () => errors.throwNotImplemented("a placeholder capability", { plannedPhase: "W2", requirementRef: "FR-033" }),
    (error) => assertNotImplemented(error, "throwNotImplemented"),
  );
  assert.equal(errors.isDiagnosticError(diagnostic), true);
  assert.equal(errors.isDiagnosticError(new Error("plain")), false);

  const withCause = new errors.DiagnosticError("render-failed", "boom", { backend: "webgpu", cause: new Error("root") });
  assert.equal(withCause.category, "render-failed");
  assert.equal(withCause.backend, "webgpu");
  assert.equal(withCause.cause.message, "root");
});

test("every Renderer replacement module exists as a real file for its manifest entry", () => {
  for (const entry of manifest.entries) {
    const expected = `${BACKEND}/${entry.localFile.replace(/\.js$/, ".ts")}`;
    assert.ok(fs.existsSync(repoPath(expected)), `${entry.upstreamModule} MUST have a skeleton at ${expected}`);
  }
  const localFiles = fs.readdirSync(repoPath(`${BACKEND}/Renderer`)).sort();
  assert.equal(localFiles.length, manifest.entries.length, "the local replacement set MUST equal the manifest set (rule A4)");
});

test("every constructor-style replacement fails loudly when constructed", async () => {
  for (const name of CLASS_MODULES) {
    const module_ = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/${name}.ts`));
    assert.equal(typeof module_.default, "function", `${name} MUST export the upstream default constructor`);
    assert.throws(() => new module_.default({}), (error) => assertNotImplemented(error, `new ${name}()`));
  }
});

test("every factory-style replacement fails loudly when called", async () => {
  for (const name of FUNCTION_MODULES) {
    const module_ = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/${name}.ts`));
    assert.equal(typeof module_.default, "function", `${name} MUST export a callable default`);
    assert.throws(() => module_.default(), (error) => assertNotImplemented(error, `${name}()`));
  }
});

test("static factory entry points fail loudly instead of returning empty resources", async () => {
  for (const [name, method] of STATIC_ENTRIES) {
    const module_ = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/${name}.ts`));
    assert.equal(typeof module_.default[method], "function", `${name}.${method} MUST exist on the replacement export`);
    assert.throws(() => module_.default[method](), (error) => assertNotImplemented(error, `${name}.${method}()`));
  }
});

test("ShaderProgram keeps the _attributeLocations read surface (contract §5 R2 / rule A9)", async () => {
  const module_ = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/ShaderProgram.ts`));
  // Declared as a field even though the skeleton cannot populate it yet: the invariant the logic
  // layer depends on MUST stay visible in the replacement.
  assert.match(module_.default.prototype.constructor.toString() + Object.getOwnPropertyNames(Object.getPrototypeOf(module_.default)), /.*/);
  const source = fs.readFileSync(repoPath(`${BACKEND}/Renderer/ShaderProgram.ts`), "utf8");
  assert.match(source, /_attributeLocations/, "the replacement MUST carry the attribute-location read surface");
  assert.doesNotMatch(source, /(?:^|[^.\w])vertexShaderSource\s*=(?!=)/, "the replacement MUST NOT overwrite the GLSL view");
  assert.doesNotMatch(source, /(?:^|[^.\w])fragmentShaderSource\s*=(?!=)/, "the replacement MUST NOT overwrite the GLSL view");
});

test("every webgpu placeholder module fails loudly on its documented entry point", async () => {
  for (const [file, entryPoint, args] of WEBGPU_ENTRIES) {
    const module_ = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/${file}`));
    assert.equal(typeof module_[entryPoint], "function", `${file} MUST export ${entryPoint}`);
    assert.throws(
      () => module_[entryPoint](...args),
      (error) => assertNotImplemented(error, `${file}#${entryPoint}`),
    );
  }
});

test("the webgpu module set is complete (10 modules of T037 plus the W2 additions)", () => {
  const expected = [
    "webgpu/device-handoff.ts",
    "webgpu/pass-encoder.ts",
    "webgpu/pipeline-cache.ts",
    "webgpu/bind-layout.ts",
    "webgpu/shader-emit.ts",
    "webgpu/glsl-preprocess.ts",
    "webgpu/capability.ts",
    "webgpu/wgsl-prelude/index.ts",
    "webgpu/wgsl/index.ts",
    "webgpu/errors.ts",
  ];
  for (const file of expected) assert.ok(fs.existsSync(repoPath(`${BACKEND}/${file}`)), `${file} MUST exist`);
  for (const file of W2_IMPLEMENTED_MODULES) {
    assert.ok(fs.existsSync(repoPath(`${BACKEND}/${file}`)), `${file} MUST exist (implemented in W2)`);
  }
});

test("the W2 modules are implemented, not stubbed (a placeholder regression fails here)", async () => {
  // Each of these has its own suite for behaviour; this test only pins that they are no longer the
  // T037 placeholder — a regression would otherwise hide behind the narrowed CLASS_MODULES list above.
  const handoff = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/device-handoff.ts`));
  handoff.resetSlot();
  assert.equal(handoff.take(), undefined, "device-handoff.take() MUST be a real implementation");
  assert.equal(typeof handoff.install, "function");
  assert.equal(typeof handoff.resetCycle, "function");

  const capability = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/capability.ts`));
  assert.equal(typeof capability.composeCapabilities, "function");
  assert.equal(typeof capability.applyContextLimits, "function", "the ContextLimits publication helper MUST exist");

  const passEncoder = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/pass-encoder.ts`));
  assert.equal(typeof passEncoder.PassStateMachine, "function", "the derived pass state machine MUST be a real class");

  const pipelineCache = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/pipeline-cache.ts`));
  assert.deepEqual(pipelineCache.stats(), { size: 0, hits: 0, misses: 0 }, "pipeline-cache.stats() MUST answer without throwing");

  const renderState = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/RenderState.ts`));
  const state = renderState.default.fromCache({ cull: { enabled: true } });
  assert.equal(typeof state.id, "number", "RenderState.fromCache MUST return a real state");
  assert.equal(state.cull.enabled, true);
  assert.ok(state.toPipelineState().primitive.cullMode === "back");

  const swapchain = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/swapchain.ts`));
  assert.equal(typeof swapchain.Swapchain, "function");
  assert.equal(typeof swapchain.resolveDrawingBufferSize, "function");

  const errorScope = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/error-scope.ts`));
  assert.equal(typeof errorScope.ErrorScopeCollector, "function");

  const wholeSwitch = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/whole-switch.ts`));
  assert.equal(typeof wholeSwitch.performWholeSwitch, "function");

  const surface = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/not-implemented.ts`));
  assert.ok(surface.SLICE_C_SURFACE.length >= 7, "the slice-C registry MUST enumerate the boundary");

  const defaultResources = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/default-resources.ts`));
  assert.equal(typeof defaultResources.createDefaultTexture, "function");

  // T043 finding: the upstream `Scene` constructor builds these two through the replacement `Context`,
  // so an unusable placeholder here would make construct-time takeover impossible. They are real caches
  // whose shader-program side still fails loudly until W4.
  const shaderCache = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/ShaderCache.ts`), { externals: upstreamStubs() });
  const cache = new shaderCache.default({});
  assert.equal(cache.numberOfShaders, 0, "ShaderCache MUST be constructible (Context.js:81)");
  assert.equal(typeof cache.getShaderProgram, "function");
  assert.equal(typeof cache.releaseShaderProgram, "function");

  const textureCache = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/TextureCache.ts`), { externals: upstreamStubs() });
  const textures = new textureCache.default();
  assert.equal(textures.numberOfTextures, 0, "TextureCache MUST be constructible (Context.js:82)");
  assert.equal(textures.getTexture("missing"), undefined, "a cache miss returns undefined, exactly like upstream");

  // T053 draws the ComputeEngine boundary at the execution, because `Scene.js:182` constructs it.
  const computeEngine = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/ComputeEngine.ts`), { externals: upstreamStubs() });
  const engine = new computeEngine.default({});
  assert.equal(engine.execute !== undefined, true, "ComputeEngine MUST be constructible; only execute() fails");
  assert.throws(() => engine.execute({}), (error) => {
    assert.equal(error.name, "DiagnosticError");
    assert.equal(error.category, "not-implemented");
    return true;
  });

  // T043 finding: `Scene` → `InvertClassification` constructs a FramebufferManager during
  // construction, so it MUST be constructible; allocating render targets stays W3's job.
  const framebufferManager = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/FramebufferManager.ts`), { externals: upstreamStubs() });
  const manager = new framebufferManager.default({ color: true, depth: true, numSamples: 4 });
  assert.equal(manager.numSamples, 4);
  assert.equal(manager.isDirty(300, 150, 4), true, "a manager without a framebuffer is dirty");
  assert.throws(() => manager.update(), (error) => {
    assert.equal(error.name, "DiagnosticError");
    assert.equal(error.category, "not-implemented");
    assert.match(error.message, /T061|T062|W3/);
    return true;
  });
  assert.throws(() => new framebufferManager.default({ color: false }), /at least one type of framebuffer attachment/);
  assert.throws(() => new framebufferManager.default({ depth: true, depthStencil: true }), /Cannot have both a depth and depth-stencil/);
});

test("the stub modules of the manifest fail loudly too (never an empty texture)", async () => {
  for (const entry of manifest.entries.filter((item) => item.kind === "stub-not-implemented")) {
    const name = entry.localFile.replace(/^Renderer\//, "").replace(/\.js$/, "");
    const module_ = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/${name}.ts`));
    assert.throws(() => new module_.default({}), (error) => assertNotImplemented(error, `${name} (stub)`));
  }
});

test("pure helpers that can be honest without a device are implemented, not stubbed", async () => {
  const passEncoder = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/pass-encoder.ts`));
  const key = { colorTargets: ["a"], depthStencilTarget: null, sampleCount: 1, viewport: [0, 0, 1, 1], scissorRect: [0, 0, 1, 1] };
  assert.equal(passEncoder.passKeyEquals(key, { ...key, colorTargets: ["a"] }), true);
  assert.equal(passEncoder.passKeyEquals(key, { ...key, sampleCount: 4 }), false);
  assert.equal(passEncoder.passKeyEquals(key, { ...key, viewport: [0, 0, 2, 2] }), false);

  const capability = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/capability.ts`));
  assert.doesNotThrow(() => capability.assertSliceConsistency({ depthTexture: true }, true));
  assert.throws(() => capability.assertSliceConsistency({ depthTexture: false }, true), /sliceBComplete === true requires depthTexture === true/);
  assert.equal(capability.SLICE_PROFILES.sliceB.depthTexture, true);
  assert.equal(capability.SLICE_PROFILES.sliceA.depthTexture, false);
  assert.ok(capability.SLICE_PROFILES.sliceA.notes.length > 0, "a switched-off capability MUST carry a note (FR-023)");
});
