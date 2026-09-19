/**
 * T075 — `Renderer/ShaderProgram` + `Renderer/ShaderCache` replacement (`层=单元`; tasks.md T075;
 * FR-030/FR-031; contract fork-patch-layer §5 rules **R2/R9**).
 *
 * What has to be true of the replacement, and how it is asserted here:
 *
 *   1. **`fromCache` depends on exactly four things** — `context` (the cache is per context),
 *      `vertexShaderSource`, `fragmentShaderSource` and `attributeLocations` (upstream
 *      `ShaderCache.js:98-104`). One assertion per key component, plus the two halves of "the key is
 *      content-based, not identity-based".
 *   2. **The logic layer's GLSL view survives** (R2 / rule A9): `program.vertexShaderSource` is the
 *      *same object* the caller passed (`===`, not deep-equal), `_attributeLocations` is the same
 *      object, and the assembled GLSL text is kept (`_vertexShaderText`).
 *   3. **The WGSL channel is real**: the program exposes the emitted module pair and structure, and a
 *      define set outside the MVP slice refuses program creation with a diagnostic instead of
 *      producing a program (the negative control).
 *   4. **The T081 boundary**: a `ShaderBuilder`-shaped assembly (the model family, using the real
 *      upstream model leaves) is refused with `category === "not-implemented"`; the terrain closure
 *      is not.
 *   5. **Device-free front end, lazy device half**: no `GPUShaderModule` exists after construction,
 *      `_bind()` creates exactly two, and a pipeline is created once per key through the W2 cache.
 *
 * The terrain sources are the production ones (`tools/shader-model.mjs`): the same base leaves
 * (`GlobeVS`/`GlobeFS`/`AtmosphereCommon`/`GroundAtmosphere`) and the same runtime-generated
 * fragments (`computeDayColor`, `getPosition`) the real globe path pushes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { contextLimitsStubSource, upstreamStubs } from "../support/upstream-stubs.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assertDiagnostic, createFakeDevice } from "../support/fake-gpu.mjs";
import { baseSources, loadProduction } from "../../tools/shader-model.mjs";

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

/** A real deep import (the three collaborators that decide the GLSL bytes must not be stubs). */
function realUpstream(specifier) {
  return `export { default } from ${JSON.stringify(new URL(`../../node_modules/${specifier}`, import.meta.url).href)};`;
}

/**
 * The kept `ContextLimits` stub with the two high-precision flags the replacement `Context` publishes
 * (`webgpu/capability.ts:348-349`: "WGSL float32 is highp"). The upstream module's own defaults are
 * `false` — they are set when a GL context is created — and a WebGPU program must NOT rewrite the
 * fragment shader's uniforms, so the capability the real context publishes is pinned here.
 */
function highpContextLimitsStub() {
  return `${contextLimitsStubSource()}\nContextLimits.highpFloatSupported = true;\nContextLimits.highpIntSupported = true;\n`;
}

function programExternals() {
  return {
    ...upstreamStubs({ "@cesium/engine/Source/Renderer/ContextLimits.js": highpContextLimitsStub() }),
    "@cesium/engine/Source/Renderer/AutomaticUniforms.js": realUpstream("@cesium/engine/Source/Renderer/AutomaticUniforms.js"),
    "@cesium/engine/Source/Shaders/Builtin/CzmBuiltins.js": realUpstream("@cesium/engine/Source/Shaders/Builtin/CzmBuiltins.js"),
    "@cesium/engine/Source/Renderer/demodernizeShader.js": realUpstream("@cesium/engine/Source/Renderer/demodernizeShader.js"),
    // The real `destroyObject` (the stub calls `destroy()` recursively and therefore cannot express
    // finalisation): `finalDestroy()` MUST leave the program reporting `isDestroyed() === true`, which
    // is exactly the upstream contract `destroyReleasedShaderPrograms` relies on.
    "@cesium/engine/Source/Core/destroyObject.js": realUpstream("@cesium/engine/Source/Core/destroyObject.js"),
  };
}

const externals = programExternals();
const programModule = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/ShaderProgram.ts`), { externals });
const cacheModule = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/ShaderCache.ts`), { externals });
const renderStateModule = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/RenderState.ts`));

const ShaderProgram = programModule.default;
const ShaderCache = cacheModule.default;
const RenderState = renderStateModule.default;

const production = await loadProduction();
const base = await baseSources();

/** The first MVP-reachable variant that has day textures (the emitter needs `u_dayTextures`). */
const variant = production.variants
  .enumerateReachableVariants()
  .find((candidate) => candidate.defines.includes("TEXTURE_UNITS 1") && !candidate.defines.includes("FOG"));
assert.ok(variant !== undefined, "the MVP-reachable matrix MUST contain a variant with TEXTURE_UNITS 1 and no fog");

/** The attribute locations the real path hands over (`terrainEncoding.getAttributeLocations()`). */
const TERRAIN_ATTRIBUTE_LOCATIONS = { position3DAndHeight: 0, textureCoordAndEncodedNormals: 1 };

/**
 * Build the production source pair of one variant — the same pushes
 * `GlobeSurfaceShaderSet.js:472-481` performs (base sources, per-destination defines, the generated
 * `computeDayColor`/`getPosition` fragments).
 */
function terrainSources({ vertexComment = null, fragmentComment = null, extraDefines = [] } = {}) {
  const vertexShaderSource = new production.ShaderSource({ sources: [...base.vertex], defines: [...base.defines] });
  const fragmentShaderSource = new production.ShaderSource({ sources: [...base.fragment], defines: [...base.defines] });
  for (const define of variant.defines) {
    const destination = production.variants.destinationOf(define);
    if (destination === "vertex" || destination === "both") vertexShaderSource.defines.push(define);
    if (destination === "fragment" || destination === "both") fragmentShaderSource.defines.push(define);
  }
  for (const define of extraDefines) {
    vertexShaderSource.defines.push(define);
    fragmentShaderSource.defines.push(define);
  }
  vertexShaderSource.sources.push(production.fragments.emitPositionFunctionsGlsl({ sceneMode: variant.sceneMode ?? "SCENE3D", useWebMercatorProjection: true }));
  fragmentShaderSource.sources.push(
    production.fragments.emitComputeDayColorGlsl({
      textureUnits: production.fragments.textureUnitsFromDefines(variant.defines),
      apply: production.fragments.applyFlagsFromDefines(variant.defines),
    }),
  );
  // An extra *source* changes the cache key (`ShaderSource#getCacheKey` joins the raw sources) while
  // `combineShader` strips the comment again — so the emitted shader stays identical and the probe
  // isolates "the key includes this source" from "the assembled text differs".
  if (vertexComment !== null) vertexShaderSource.sources.push(vertexComment);
  if (fragmentComment !== null) fragmentShaderSource.sources.push(fragmentComment);
  return { vertexShaderSource, fragmentShaderSource };
}

/** A context stub with the surface this backend consumes (no GPU device: the front end is device-free). */
function makeContext(overrides = {}) {
  const context = {
    webgl2: true,
    textureFloatLinear: false,
    floatingPointTexture: true,
    logShaderCompilation: false,
    debugShaders: undefined,
    _gl: undefined,
    ...overrides,
  };
  context.shaderCache = new ShaderCache(context);
  return context;
}

function optionsFor(context, sources, attributeLocations = TERRAIN_ATTRIBUTE_LOCATIONS) {
  return { context, vertexShaderSource: sources.vertexShaderSource, fragmentShaderSource: sources.fragmentShaderSource, attributeLocations };
}

test("fromCache depends on exactly the four upstream keys", () => {
  const contextA = makeContext();
  const contextB = makeContext();
  const sources = terrainSources();

  const first = ShaderProgram.fromCache(optionsFor(contextA, sources));
  const same = ShaderProgram.fromCache(optionsFor(contextA, sources));
  assert.equal(same, first, "the same (context, vertexShaderSource, fragmentShaderSource, attributeLocations) MUST return the same instance");

  // A different source *object* with identical content is still the same cache entry (content key).
  const equivalent = terrainSources();
  assert.equal(ShaderProgram.fromCache(optionsFor(contextA, equivalent)), first, "the key MUST be content-based, not object-identity-based");

  // (1) context — each context owns its cache (upstream `ShaderCache` is constructed per context).
  const otherContext = ShaderProgram.fromCache(optionsFor(contextB, sources));
  assert.notEqual(otherContext, first, "a different context MUST NOT share a program");

  // (2) vertexShaderSource — the cache key is `vertexShaderKey:fragmentShaderKey:attributeLocations`.
  const otherVertex = ShaderProgram.fromCache(optionsFor(contextA, { ...sources, vertexShaderSource: terrainSources({ vertexComment: "// probe: vertex source differs" }).vertexShaderSource }));
  assert.notEqual(otherVertex, first, "a different vertexShaderSource MUST NOT reuse the program");

  // (3) fragmentShaderSource
  const otherFragment = ShaderProgram.fromCache(optionsFor(contextA, { ...sources, fragmentShaderSource: terrainSources({ fragmentComment: "// probe: fragment source differs" }).fragmentShaderSource }));
  assert.notEqual(otherFragment, first, "a different fragmentShaderSource MUST NOT reuse the program");

  // (4) attributeLocations
  const otherAttributes = ShaderProgram.fromCache(optionsFor(contextA, sources, { ...TERRAIN_ATTRIBUTE_LOCATIONS, geodeticSurfaceNormal: 7 }));
  assert.notEqual(otherAttributes, first, "different attributeLocations MUST NOT reuse the program");

  // A different *variant* — the `[numberOfDayTextures][flags]` dimension `GlobeSurfaceShaderSet` keys
  // on — is a different program as well, because `ShaderSource#getCacheKey` folds the define list in.
  const otherVariant = ShaderProgram.fromCache(optionsFor(contextA, terrainSources({ extraDefines: ["FOG"] })));
  assert.notEqual(otherVariant, first, "a different define set (a different variant) MUST NOT reuse the program");

  assert.equal(contextA.shaderCache.numberOfShaders, 5, "the cache MUST hold one entry per distinct key");
});

test("the logic layer's GLSL view and _attributeLocations survive unchanged (R2 / rule A9)", () => {
  const context = makeContext();
  const sources = terrainSources();
  const attributeLocations = { ...TERRAIN_ATTRIBUTE_LOCATIONS };
  const program = ShaderProgram.fromCache(optionsFor(context, sources, attributeLocations));

  assert.equal(program.vertexShaderSource, sources.vertexShaderSource, "vertexShaderSource MUST be the object the caller supplied (identity)");
  assert.equal(program.fragmentShaderSource, sources.fragmentShaderSource, "fragmentShaderSource MUST be the object the caller supplied (identity)");
  assert.equal(program._attributeLocations, attributeLocations, "_attributeLocations MUST be the same object, not a copy");
  assert.deepEqual(program._attributeLocations, attributeLocations);

  // The assembled GLSL the upstream `ShaderCache` produced is kept (upstream's `_vertexShaderText`).
  assert.match(program._vertexShaderText, /#version 300 es/, "the assembled GLSL MUST be the upstream-shaped text");
  assert.ok(program._vertexShaderText.includes("GlobeVS") || program._vertexShaderText.includes("getPosition"), "the combined vertex shader MUST carry the globe leaf");

  // Reflection is device-free here: the attributes come from the emission contract.
  assert.ok(program.numberOfVertexAttributes >= 2, `the terrain vertex stage MUST expose its attributes (got ${program.numberOfVertexAttributes})`);
  assert.ok(Object.keys(program.vertexAttributes).length >= 2);
  // `maximumTextureUnitIndex` is upstream's post-`reinitialize` value, so it is still unset here —
  // the uniform surface is a separate, explicitly injected concern (see the T076 seam test below).
  assert.equal(program.maximumTextureUnitIndex, undefined);
});

test("the uniform surface is built from the layout through an injected factory (the T076 seam)", () => {
  const sources = terrainSources();
  const created = [];
  /** A recording stand-in for the parallel T076 replacement, so this suite never waits on it. */
  const uniformFactory = {
    createUniform: (gl, activeUniform, name) => {
      created.push({ kind: "uniform", name, glslType: activeUniform.glslType, size: activeUniform.size });
      return { name, value: undefined, set() {}, _setSampler(index) { return index + 1; } };
    },
    createUniformArray: (gl, activeUniform, name, locations) => {
      created.push({ kind: "array", name, glslType: activeUniform.glslType, locations });
      return { name, value: [], set() {}, _setSampler(index) { return index + locations; } };
    },
  };

  const program = new ShaderProgram({
    context: makeContext(),
    vertexShaderSource: sources.vertexShaderSource,
    vertexShaderText: sources.vertexShaderSource.createCombinedVertexShader({ webgl2: true, textureFloatLinear: false, floatingPointTexture: true }),
    fragmentShaderSource: sources.fragmentShaderSource,
    fragmentShaderText: sources.fragmentShaderSource.createCombinedFragmentShader({ webgl2: true, textureFloatLinear: false, floatingPointTexture: true }),
    attributeLocations: TERRAIN_ATTRIBUTE_LOCATIONS,
    uniformFactory,
  });

  const uniforms = program.allUniforms;
  assert.ok(Object.keys(uniforms).length > 0, "the uniform surface MUST be built from the layout");
  assert.ok(created.some((entry) => entry.kind === "uniform" && entry.name.startsWith("u_dayTextures")), "the sampler uniforms MUST come from the layout's sampler table");
  assert.ok(created.some((entry) => entry.glslType === "sampler2D"), "the GLSL type of a sampler MUST be forwarded");
  assert.equal(program.maximumTextureUnitIndex, 1, "one day-texture sampler occupies texture unit 0 (upstream `setSamplerUniforms`)");
});

test("the WGSL module pair is produced by the emitter and exposed", () => {
  const context = makeContext();
  const program = ShaderProgram.fromCache(optionsFor(context, terrainSources()));

  assert.match(program.wgsl.vertexModule, /@vertex\s+fn\s+vs_main/, "the vertex module MUST be the emitted WGSL text");
  assert.match(program.wgsl.fragmentModule, /@fragment\s+fn\s+fs_main/, "the fragment module MUST be the emitted WGSL text");
  assert.ok(program.wgsl.structure.paired.length > 0, "the emission structure MUST record the derived varying pairing");
  assert.equal(program.wgsl.layout.structName, program.layout.structName);
  assert.equal(program.wgsl.family, "terrain");
  assert.equal(program.variantKey, program.wgsl.variantKey);
});

test("id increments per program (upstream nextShaderProgramId)", () => {
  const context = makeContext();
  const first = ShaderProgram.fromCache(optionsFor(context, terrainSources({ vertexComment: "// id probe 1" })));
  const second = ShaderProgram.fromCache(optionsFor(context, terrainSources({ vertexComment: "// id probe 2" })));
  assert.ok(Number.isInteger(first.id) && Number.isInteger(second.id));
  assert.equal(second.id, first.id + 1, "each program MUST get a fresh incrementing id");
});

test("releaseShaderProgram / numberOfShaders / destroyReleasedShaderPrograms behave like upstream", () => {
  const context = makeContext();
  const sources = terrainSources({ vertexComment: "// release probe" });
  const cache = context.shaderCache;

  const first = cache.getShaderProgram(optionsFor(context, sources));
  assert.equal(cache.numberOfShaders, 1);
  const second = cache.getShaderProgram(optionsFor(context, sources));
  assert.equal(second, first, "a second reference MUST return the cached program");
  assert.equal(cache.numberOfShaders, 1, "a second reference MUST NOT add a cache entry");

  first.destroy(); // count 2 -> 1: still referenced
  assert.equal(cache.numberOfShaders, 1, "a still-referenced program MUST NOT be released");
  assert.equal(first.isDestroyed(), false);

  second.destroy(); // count 1 -> 0: scheduled for release
  assert.equal(cache.numberOfShaders, 1, "the release is deferred to destroyReleasedShaderPrograms");
  cache.destroyReleasedShaderPrograms();
  assert.equal(cache.numberOfShaders, 0, "destroyReleasedShaderPrograms MUST drop the released program");
  assert.equal(Object.keys(cache._shaders).length, 0, "the cache entry MUST be gone");
  assert.equal(first.isDestroyed(), true, "the released program MUST be finalised");
});

test("replaceCache delegates to the cache and releases the program it replaces", () => {
  const context = makeContext();
  const cache = context.shaderCache;
  const first = ShaderProgram.fromCache(optionsFor(context, terrainSources({ vertexComment: "// replace probe" })));
  assert.equal(first._cachedShader.count, 1);

  // `replaceShaderProgram` destroys the previous reference first (upstream `ShaderCache.js:51-57`).
  const replacement = ShaderProgram.replaceCache({
    ...optionsFor(context, terrainSources({ fragmentComment: "// replace probe (new variant)" })),
    shaderProgram: first,
  });
  assert.notEqual(replacement, first, "replacing with a different key MUST produce a different program");
  assert.equal(first._cachedShader.count, 0, "the replaced program's reference MUST have been released");
  assert.equal(cache.numberOfShaders, 2, "the released program is dropped by destroyReleasedShaderPrograms, not immediately");

  cache.destroyReleasedShaderPrograms();
  assert.equal(cache.numberOfShaders, 1);
  assert.equal(cache.getDerivedShaderProgram(replacement, "no-such-keyword"), undefined, "derived lookups follow upstream's keyword scheme");
});

test("negative control: a define set outside the MVP slice refuses program creation with a diagnostic", () => {
  const context = makeContext();
  const cache = context.shaderCache;
  const before = cache.numberOfShaders;
  const sources = terrainSources({ extraDefines: ["APPLY_MATERIAL"] });

  assert.throws(
    () => cache.getShaderProgram(optionsFor(context, sources)),
    (error) => {
      assertDiagnostic(error, "not-implemented", "a define outside the MVP slice");
      assert.match(error.message, /APPLY_MATERIAL/, "the diagnostic MUST name the define that was refused");
      assert.match(error.message, /no program was constructed/);
      return true;
    },
    "APPLY_MATERIAL is outside the MVP slice and MUST NOT produce a program",
  );
  assert.equal(cache.numberOfShaders, before, "a rejected emission MUST NOT be cached");
});

test("T081: a ShaderBuilder-shaped (model) source is refused, the terrain closure is not", async () => {
  const { assertShaderFamilySupported, shaderFamilyOf, SHADER_FAMILY_BOUNDARY } = programModule;

  // The terrain closure — the MVP slice — is accepted by the guard itself and by the program path.
  const terrainAssembly = { sources: [...base.vertex, ...base.fragment], defines: [...variant.defines], vertexText: "", fragmentText: "" };
  assert.equal(shaderFamilyOf(terrainAssembly), "terrain");
  assert.doesNotThrow(() => assertShaderFamilySupported(terrainAssembly));

  // The real upstream model leaves `ShaderBuilder` assembles (not a hand-written look-alike).
  const [GeometryStageVS, MaterialStageFS] = await Promise.all([
    import("@cesium/engine/Source/Shaders/Model/GeometryStageVS.js"),
    import("@cesium/engine/Source/Shaders/Model/MaterialStageFS.js"),
  ]);
  const modelAssembly = { sources: [GeometryStageVS.default, MaterialStageFS.default], defines: ["HAS_NORMALS", "LIGHTING_PBR"] };
  assert.equal(shaderFamilyOf(modelAssembly), "model", "the model family MUST be recognisable from the assembled GLSL/defines");
  assert.throws(
    () => assertShaderFamilySupported(modelAssembly),
    (error) => {
      assertDiagnostic(error, "not-implemented", "the T081 model boundary");
      assert.match(error.message, /model shader family/);
      assert.match(error.message, /ShaderBuilder/);
      return true;
    },
  );

  // …and the same refusal through the real program path (the guard runs before any emission).
  const context = makeContext();
  const modelSources = {
    vertexShaderSource: new production.ShaderSource({ sources: [GeometryStageVS.default], defines: ["HAS_NORMALS"] }),
    fragmentShaderSource: new production.ShaderSource({ sources: [MaterialStageFS.default], defines: ["HAS_NORMALS"] }),
  };
  assert.throws(
    () => context.shaderCache.getShaderProgram(optionsFor(context, modelSources)),
    (error) => {
      assertDiagnostic(error, "not-implemented", "the T081 model boundary through ShaderCache");
      assert.match(error.message, /model shader family/);
      return true;
    },
  );
  assert.equal(context.shaderCache.numberOfShaders, 0, "a refused family MUST NOT be cached");

  // The boundary is data, not prose: every rule carries the upstream line it was derived from.
  assert.equal(SHADER_FAMILY_BOUNDARY.length, 3, "model / voxel / Gaussian-splat MUST all be covered");
  for (const rule of SHADER_FAMILY_BOUNDARY) {
    assert.match(rule.upstreamSource, /Source\//, `the "${rule.family}" criterion MUST cite its upstream source`);
    assert.ok(rule.defineMarkers.length > 0 && rule.textMarkers.length > 0, `the "${rule.family}" rule MUST have both kinds of marker`);
  }
});

test("the shader front end is device-free, and the device half is lazy", () => {
  const context = makeContext();
  const program = ShaderProgram.fromCache(optionsFor(context, terrainSources({ vertexComment: "// laziness probe" })));

  // Nothing device-side happened at construction.
  assert.equal(program.initialized, false, "no GPUShaderModule/GPURenderPipeline may be created in the constructor");
  assert.equal(program.hasDevice, false);
  assert.equal(program.pipeline, undefined);
  assert.throws(
    () => program._bind(),
    (error) => {
      assertDiagnostic(error, "not-implemented", "a device-free context reached through _bind");
      assert.match(error.message, /no WebGPU device/);
      return true;
    },
    "without a device the device half MUST fail loudly rather than silently no-op",
  );

  // With a device double, `_bind` creates exactly the two modules and the pipeline layout.
  const device = createFakeDevice();
  const created = { modules: [], bindGroupLayouts: [], pipelineLayouts: [] };
  device.createShaderModule = (descriptor) => {
    created.modules.push(descriptor);
    return { label: descriptor.label };
  };
  device.createBindGroupLayout = (descriptor) => {
    created.bindGroupLayouts.push(descriptor);
    return { label: descriptor.label };
  };
  // W5: the replaced `Context.draw` now assembles the program's uniform bind group, so the device
  // double has to cover the buffer/bind-group calls that path makes.
  device.createBuffer = (descriptor) => ({ ...descriptor, destroy() {} });
  device.createBindGroup = (descriptor) => ({ label: descriptor.label, layout: descriptor.layout });
  device.queue = { writeBuffer() {}, submit() {} };

  device.createPipelineLayout = (descriptor) => {
    created.pipelineLayouts.push(descriptor);
    return { label: descriptor.label };
  };
  const renderState = new RenderState({ topology: "triangle-list", colorFormats: ["bgra8unorm"], depthFormat: null, sampleCount: 1 });
  const gpuContext = makeContext({ device });
  const gpuProgram = ShaderProgram.fromCache(optionsFor(gpuContext, terrainSources({ vertexComment: "// laziness probe (device)" })));

  assert.equal(gpuProgram.deviceState().vertexModule.label, `cesium-webgpu:program-${gpuProgram.id}:vs`);
  assert.equal(created.modules.length, 2, "exactly two createShaderModule calls per program (G-6 rev3)");
  assert.equal(created.bindGroupLayouts.length, 2, "group 0 (uniform) + group 1 (samplers)");
  assert.equal(created.pipelineLayouts.length, 1);

  // Pipelines go through the W2 cache: two identical calls create one pipeline.
  const first = gpuProgram.createPipeline({ renderState, vertexLayout: [] });
  const second = gpuProgram.createPipeline({ renderState, vertexLayout: [] });
  assert.equal(second, first, "an identical pipeline request MUST be served by the pipeline cache");
  assert.equal(device.__created.pipelines.length, 1, "the pipeline cache MUST build exactly one pipeline for one key");
  assert.equal(gpuProgram.pipeline, first);
  assert.ok(gpuProgram.lastPipelineKey !== undefined && gpuProgram.lastPipelineKey.shaderProgramId === String(gpuProgram.id));
});
