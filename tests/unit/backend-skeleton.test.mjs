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
 *   - every `Renderer/**` replacement module fails loudly on construction / its factory entry;
 *   - every `webgpu/**` placeholder module fails loudly on its documented entry point;
 *   - the four-valued manifest `kind` matches the skeleton's intent (stubs included).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { readJson, repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";

const BACKEND = "packages/cesium-webgpu/backend-webgpu";
const manifest = readJson(`${BACKEND}/manifest.json`);

/** Constructor-style replacements: `new Module()` MUST fail loudly. */
const CLASS_MODULES = [
  "Context",
  "Texture",
  "ShaderProgram",
  "RenderState",
  "Buffer",
  "VertexArray",
  "Framebuffer",
  "Renderbuffer",
  "MultisampleFramebuffer",
  "ShaderSource",
  "ShaderCache",
  "FramebufferManager",
  "ComputeEngine",
  "SharedContext",
  "TextureCache",
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
  ["RenderState", "fromCache"],
  ["RenderState", "partialApply"],
  ["RenderState", "apply"],
  ["VertexArray", "fromGeometry"],
];

/** Every `webgpu/**` module with the placeholder entry point it MUST refuse. */
const WEBGPU_ENTRIES = [
  ["device-handoff.ts", "install", []],
  ["device-handoff.ts", "take", []],
  ["device-handoff.ts", "peek", []],
  ["device-handoff.ts", "clear", []],
  ["pass-encoder.ts", "beginPass", [{}]],
  ["pass-encoder.ts", "closePass", []],
  ["pass-encoder.ts", "isPassOpen", []],
  ["pipeline-cache.ts", "getOrCreate", [{}]],
  ["pipeline-cache.ts", "stats", []],
  ["pipeline-cache.ts", "clear", []],
  ["bind-layout.ts", "buildBindLayout", [""]],
  ["bind-layout.ts", "emitWgslStruct", [{}]],
  ["shader-emit.ts", "emitShader", [{}]],
  ["shader-emit.ts", "assertVaryingsPair", [{}, {}]],
  ["glsl-preprocess.ts", "evaluateConditionals", ["", {}]],
  ["glsl-preprocess.ts", "inlineCzmBuiltins", [""]],
  ["glsl-preprocess.ts", "textureUnitsDefine", [1]],
  ["capability.ts", "composeCapabilities", [{}]],
  ["wgsl-prelude/index.ts", "preludeFor", [[]]],
  ["wgsl-prelude/index.ts", "renderPrelude", [[]]],
  ["wgsl/index.ts", "loadShaderLibrary", []],
  ["wgsl/index.ts", "readWgslModule", ["GlobeVS"]],
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

test("the webgpu module set is complete (10 modules of T037)", () => {
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
