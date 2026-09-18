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
 * real implementations, and W3 (T055-T065) turned the **resource classes** (`Buffer`, `Texture`,
 * `VertexArray`, `Framebuffer`, `Renderbuffer`, `MultisampleFramebuffer`, `FramebufferManager`) into
 * real implementations. Each is asserted by its own suite
 * (`tests/unit/{context-construction,context-dispatch,capability-composition,pass-encoder,pipeline-cache,render-state-mapping,buffer-mapping,texture-mapping,format-map,sampler-mapping,vertex-array-mapping,framebuffer-attachments,framebuffer-manager,gpu-resource-registry}.test.mjs`)
 * instead of by this placeholder scan. The lists below therefore name exactly the modules that MUST
 * still fail loudly, and the `the W2/W3 modules are implemented, not stubbed` tests pin the
 * transitions so a regression back to a placeholder cannot slip through.
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
  "SharedContext",
  "Texture3D",
  "CubeMap",
  "CubeMapFace",
  "TextureAtlas",
  "Sync",
];

/** Factory-style replacements: calling the default export MUST fail loudly. */
const FUNCTION_MODULES = ["loadCubeMap"];

/** Static factory entry points the upstream logic layer calls without constructing. */
const STATIC_ENTRIES = [];

/**
 * Every `webgpu/**` module that is STILL a placeholder, with the entry point it MUST refuse.
 * W4 (tasks T066–T077) delivered all of them; the list is kept (empty) so a future placeholder has a
 * place to be registered and the "no silent skeleton" discipline stays explicit.
 */
const WEBGPU_ENTRIES = [];

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
];

/**
 * Modules W3 implemented (T055-T065): the resource layer. They MUST be loadable and MUST NOT be the
 * T037 placeholder any more; their behaviour is asserted by their own unit suites.
 */
const W3_IMPLEMENTED_MODULES = [
  "webgpu/format-map.ts",
  "webgpu/sampler-map.ts",
  "webgpu/gpu-resource-registry.ts",
  "webgpu/texture-upload.ts",
  "webgpu/context-device.ts",
  "Renderer/Buffer.ts",
  "Renderer/Texture.ts",
  "Renderer/VertexArray.ts",
  "Renderer/Framebuffer.ts",
  "Renderer/Renderbuffer.ts",
  "Renderer/MultisampleFramebuffer.ts",
  "Renderer/FramebufferManager.ts",
];

/**
 * Modules W4 implemented (T066–T077): the shader compilation front end. They MUST be loadable and MUST
 * NOT be the T037 placeholder any more; their behaviour is asserted by their own unit suites.
 */
const W4_IMPLEMENTED_MODULES = [
  "webgpu/glsl-preprocess.ts",
  "webgpu/varying-contract.ts",
  "webgpu/wgsl-prune.ts",
  "webgpu/generated-fragments.ts",
  "webgpu/wgsl-emitter.ts",
  "webgpu/terrain-variants.ts",
  "webgpu/bind-layout.ts",
  "webgpu/shader-emit.ts",
  "webgpu/wgsl-prelude/index.ts",
  "webgpu/wgsl/index.ts",
  "webgpu/wgsl/leaves.ts",
  "webgpu/wgsl/generated-library.ts",
  "webgpu/wgsl-prelude/catalog.ts",
  "Renderer/ShaderSource.ts",
  "Renderer/ShaderProgram.ts",
  "Renderer/createUniform.ts",
  "Renderer/createUniformArray.ts",
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
  const module_ = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/ShaderProgram.ts`), { externals: upstreamStubs() });
  // Declared as a field even though the skeleton cannot populate it yet: the invariant the logic
  // layer depends on MUST stay visible in the replacement.
  assert.equal(typeof module_.default, "function", "the replacement MUST export the upstream default constructor");
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
  for (const file of W3_IMPLEMENTED_MODULES) {
    assert.ok(fs.existsSync(repoPath(`${BACKEND}/${file}`)), `${file} MUST exist (implemented in W3)`);
  }
  for (const file of W4_IMPLEMENTED_MODULES) {
    assert.ok(fs.existsSync(repoPath(`${BACKEND}/${file}`)), `${file} MUST exist (implemented in W4)`);
  }
});

test("the W4 shader front end is implemented, not stubbed (a placeholder regression fails here)", async () => {
  // Each of these has its own suite for behaviour; this test only pins that they are no longer the
  // T037 placeholder — a regression would otherwise hide behind the narrowed WEBGPU_ENTRIES list above.
  const preprocess = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/glsl-preprocess.ts`));
  assert.equal(preprocess.preprocess("#ifdef FOG\nyes\n#endif", ["FOG"]).activeText.trim(), "yes", "glsl-preprocess MUST evaluate conditionals");
  assert.ok(preprocess.inlineCzmBuiltins("float x = czm_pi;", (name) => (name === "czm_pi" ? "const float czm_pi = 3.14;" : undefined)).includes("czm_pi"));

  const emitter = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/wgsl-emitter.ts`));
  assert.equal(emitter.emitTerrainWgsl({ variantKey: "x", vertexGlsl: "", fragmentGlsl: "", defines: ["APPLY_MATERIAL"], textureUnits: 0, flags: 0, layout: null }).ok, false, "an unsupported define MUST be refused with diagnostics, never emitted");

  const bindLayout = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/bind-layout.ts`));
  const layout = bindLayout.layoutUniforms([{ name: "u_x", glslType: "vec3" }], { structName: "T" });
  assert.equal(layout.structSize, 16, "a vec3 member occupies 12 bytes but is 16-aligned (uniform address space)");
  assert.match(layout.wgslStruct, /struct T \{/);

  const purge = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/wgsl-prune.ts`));
  assert.deepEqual(purge.pruneWgsl("fn used() {}\nfn unused() {}\n@vertex\nfn vs_main() { used(); }", { roots: ["vs_main"] }).dropped, ["unused"]);

  const fragments = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/generated-fragments.ts`));
  assert.match(fragments.emitComputeDayColorWgsl({ maxTextureUnits: 1, access: (name, index) => `u.${name}[${index}]` }), /fn computeDayColor/);

  const varying = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/varying-contract.ts`));
  assert.equal(typeof varying.deriveVaryingContract, "function");
  assert.equal(varying.assertVaryingContract("@fragment\nfn fs_main(input: FSIn) -> @location(0) vec4<f32> { return vec4<f32>(0.0); }", "struct FSIn {\n  @location(7) v_extra : vec3<f32>,\n}").ok, false, "the E1 trap (a fragment input without a vertex output) MUST be reported as a failure");

  const variants = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/terrain-variants.ts`));
  assert.equal(variants.enumerateReachableVariants().length, 768, "the MVP-reachable cross product MUST enumerate 768 combinations");
  assert.equal(variants.prewarmPlan().size, 36, "the prewarm plan MUST be the 36-variant configuration-derived subset (G-6 rev3)");

  const wgsl = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/wgsl/index.ts`));
  assert.ok(wgsl.WGSL_LEAVES.prelude.length > 1000, "the runtime leaf library MUST be inlined for the browser bundle");
  assert.ok(wgsl.WGSL_LEAVES.vertex.includes("vs_main"), "the runtime vertex leaf MUST be the terrain vertex stage");
  assert.throws(() => wgsl.readWgslModule("not-a-leaf-name"), /not in|missing|not found/, "an unmapped leaf MUST be refused, never silently resolved");

  const prelude = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/wgsl-prelude/index.ts`));
  assert.ok(prelude.PRELUDE_CATALOG.length > 50, "the czm_ prelude catalog MUST be populated");

  const shaderEmit = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/shader-emit.ts`));
  assert.equal(shaderEmit.assertEmitTarget(undefined), "glsl");
  assert.throws(() => shaderEmit.assertEmitTarget("nope"), /unknown emit target/);

  // `Renderer/ShaderSource.ts` needs the real upstream `CzmBuiltins`/`AutomaticUniforms` modules
  // (the stub map does not carry them), so its behaviour is asserted by
  // `tests/unit/shader-source-dual-emit.test.mjs`, which supplies them. Here we only pin that the
  // placeholder banner is gone.
  const shaderSourceText = fs.readFileSync(repoPath(`${BACKEND}/Renderer/ShaderSource.ts`), "utf8");
  assert.doesNotMatch(shaderSourceText, /PHASE 3 \(W1\) SKELETON|throwNotImplemented/, "the ShaderSource replacement MUST NOT be the W1 placeholder any more");
  assert.match(shaderSourceText, /combineShader/, "the replacement MUST carry the upstream assembly algorithm");
});

test("the W3 resource modules are implemented, not stubbed (a placeholder regression fails here)", async () => {
  // Same purpose as the W2 pin below: the narrowed CLASS_MODULES/STATIC_ENTRIES lists must not be
  // able to hide a regression of a W3 module back to the T037 placeholder.
  const formatMap = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/format-map.ts`), { externals: upstreamStubs() });
  assert.equal(formatMap.mapTextureFormat(0x1908, 0x1401).format, "rgba8unorm", "format-map MUST map a real pair");
  assert.equal(typeof formatMap.bufferUsageToGpu, "function");

  const samplerMap = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/sampler-map.ts`), { externals: upstreamStubs() });
  assert.equal(samplerMap.mapSampler({}).descriptor.addressModeU, "clamp-to-edge", "sampler-map MUST return a real descriptor");

  const registry = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/gpu-resource-registry.ts`));
  registry.gpuResourceRegistry.reset();
  assert.equal(registry.gpuResourceRegistry.totalBytes, 0, "the ledger MUST start empty");
  assert.equal(typeof registry.gpuResourceRegistry.register, "function");

  const upload = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/texture-upload.ts`));
  assert.equal(typeof upload.planTextureUpload, "function");

  const contextDevice = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/context-device.ts`));
  assert.equal(contextDevice.hasGpuDevice({}), false, "context-device MUST tell a GPU context from a delegated one");
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
  // construction, so it MUST be constructible. T062 landed the orchestration, so `update()` is real
  // now — with a WebGPU context it allocates the attachments; without width/height it reports the
  // same caller error upstream does instead of the W2 placeholder failure.
  const framebufferManager = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/FramebufferManager.ts`), { externals: upstreamStubs() });
  const manager = new framebufferManager.default({ color: true, depth: true, numSamples: 4 });
  assert.equal(manager.numSamples, 4);
  assert.equal(manager.isDirty(300, 150, 4), true, "a manager without a framebuffer is dirty");
  assert.throws(
    () => manager.update(),
    (error) => {
      assert.equal(error.name, "DiagnosticError");
      assert.equal(error.category, "internal", "T062 replaced the placeholder with upstream's caller error");
      assert.match(error.message, /width and height must be defined/);
      return true;
    },
  );
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
