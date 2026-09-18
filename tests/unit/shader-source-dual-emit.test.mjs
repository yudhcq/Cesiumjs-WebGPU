/**
 * T067 — `ShaderSource` parameterised as a dual-emission target (`层=单元` + `层=架构边界`;
 * tasks.md T067; SH-1; contract fork-patch-layer §5 rules **R1/R2**, architecture rule A9).
 *
 * The whole point of the seam is that the **GLSL view does not change**. Asserting that by reading
 * the replacement's source would be circular, so this suite assembles every one of the
 * **768 MVP-reachable define combinations** twice — once through the **installed upstream
 * `ShaderSource`**, once through the replacement — and compares the two texts byte for byte. That is
 * the G-5 assertion (768/768, `docs/gate-g5-conclusion.md` §D(a)) re-run against the production seam.
 *
 * The second half asserts what the *addition* is allowed to be: `emit` defaults to `"glsl"`, an
 * unknown target is refused, the WGSL channel never writes into the GLSL view, and the logic layer's
 * read surface (`getCacheKey`, `createCombined*`, `ShaderSource._czmBuiltinsAndUniforms`) is intact.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { upstreamStubs } from "../support/upstream-stubs.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assembleGlslForVariant, baseSources, compareGlslChannels, loadProduction, SHADER_CONTEXT_STUB, upstreamShaderSourceClass } from "../../tools/shader-model.mjs";

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

/** The build resolves these three to the **installed** package; the test must do the same. */
function realUpstreamExternals() {
  const real = (specifier) => `export { default } from ${JSON.stringify(new URL(`../../node_modules/${specifier}`, import.meta.url).href)};`;
  return {
    ...upstreamStubs(),
    "@cesium/engine/Source/Shaders/Builtin/CzmBuiltins.js": real("@cesium/engine/Source/Shaders/Builtin/CzmBuiltins.js"),
    "@cesium/engine/Source/Renderer/AutomaticUniforms.js": real("@cesium/engine/Source/Renderer/AutomaticUniforms.js"),
    "@cesium/engine/Source/Renderer/demodernizeShader.js": real("@cesium/engine/Source/Renderer/demodernizeShader.js"),
  };
}

async function loadReplacement() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/ShaderSource.ts`), { externals: realUpstreamExternals() });
}

test("emit defaults to \"glsl\" and an unknown target is refused (the GLSL view stays the default)", async () => {
  const replacement = await loadReplacement();
  const source = new replacement.default({ sources: ["void main() {}"], defines: ["FOG"] });
  assert.equal(source.emit, "glsl", "the parameterisation MUST NOT change default behaviour");

  const { assertEmitTarget } = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/shader-emit.ts`));
  assert.equal(assertEmitTarget(undefined), "glsl");
  assert.equal(assertEmitTarget(null), "glsl");
  assert.equal(assertEmitTarget("wgsl"), "wgsl");
  assert.throws(() => assertEmitTarget("WGSL"), /unknown emit target/, "a typo MUST be refused rather than silently coerced to glsl");
});

test("the replacement keeps the upstream GLSL entry points and the builtin table", async () => {
  const replacement = await loadReplacement();
  const upstream = await upstreamShaderSourceClass();

  for (const member of ["replaceMain", "createPickVertexShaderSource", "createPickFragmentShaderSource", "findNormalVarying", "findPositionVarying"]) {
    assert.equal(typeof replacement.default[member], "function", `ShaderSource.${member} MUST survive the replacement`);
  }
  for (const member of ["clone", "getCacheKey", "createCombinedVertexShader", "createCombinedFragmentShader"]) {
    assert.equal(typeof replacement.default.prototype[member], "function", `ShaderSource.prototype.${member} MUST survive the replacement`);
  }

  const upstreamBuiltins = Object.keys(upstream._czmBuiltinsAndUniforms).length;
  const replacementBuiltins = Object.keys(replacement.default._czmBuiltinsAndUniforms).length;
  assert.equal(replacementBuiltins, upstreamBuiltins, "the czm_ builtin + automatic-uniform table MUST be the same size as upstream's");
  assert.ok(replacementBuiltins > 200, `the table MUST be populated from CzmBuiltins + AutomaticUniforms (got ${replacementBuiltins})`);

  // `getCacheKey` is the ShaderCache key the variant-level cache semantics ride on.
  const a = new replacement.default({ sources: ["x"], defines: ["B", "A"] });
  const b = new replacement.default({ sources: ["x"], defines: ["A", "B"] });
  assert.equal(a.getCacheKey(), b.getCacheKey(), "defines are sorted into the cache key, exactly like upstream");
});

test("createPickFragmentShaderSource reproduces upstream byte for byte", async () => {
  const replacement = await loadReplacement();
  const upstream = await upstreamShaderSourceClass();
  const body = "#version 300 es\nvoid main() { out_FragColor = vec4(1.0); }\n";
  for (const qualifier of ["uniform", "in"]) {
    assert.equal(replacement.default.createPickFragmentShaderSource(body, qualifier), upstream.createPickFragmentShaderSource(body, qualifier), `pick fragment source MUST be identical for qualifier "${qualifier}"`);
  }
  assert.equal(replacement.default.createPickVertexShaderSource(body), upstream.createPickVertexShaderSource(body));
  assert.equal(replacement.default.replaceMain(body, "czm_old_main"), upstream.replaceMain(body, "czm_old_main"));
});

test("a wgslOnly source has no GLSL view — the logic layer can never see one (contract §9)", async () => {
  const replacement = await loadReplacement();
  const source = new replacement.default({ sources: ["void main() {}"], emit: "wgsl", wgslOnly: true });
  assert.throws(() => source.createCombinedVertexShader(SHADER_CONTEXT_STUB), /no GLSL view/);
  assert.throws(() => source.createCombinedFragmentShader(SHADER_CONTEXT_STUB), /no GLSL view/);
  // …and `clone()` carries the channel identity, so a cloned WGSL source does not silently become GLSL.
  const copy = source.clone();
  assert.equal(copy.emit, "wgsl");
  assert.equal(copy.wgslOnly, true);
});

test("the replacement's GLSL is byte-identical to the installed upstream module over all 768 variants", async () => {
  const production = await loadProduction();
  const base = await baseSources();
  const variants = production.variants.enumerateReachableVariants();
  assert.equal(variants.length, 768, "the MVP-reachable cross product MUST enumerate 768 combinations (G-5's enumeration)");

  const comparison = await compareGlslChannels({ variants, production, base });
  const witness = comparison.differences.slice(0, 3).map((entry) => `${entry.variant}: ${JSON.stringify(entry.firstDivergence)}`).join("\n");
  assert.equal(comparison.differences.length, 0, `every variant's GLSL MUST be byte-identical to upstream; first divergences:\n${witness}`);
  assert.equal(comparison.identical, 768, `768/768 byte-identical GLSL (got ${comparison.identical}/${comparison.total})`);
});

test("the GLSL channel is unaffected by `emit: \"glsl\"` being set explicitly, and by the WGSL channel existing", async () => {
  const production = await loadProduction();
  const base = await baseSources();
  const upstream = await upstreamShaderSourceClass();
  const variant = production.variants.enumerateReachableVariants().find((candidate) => candidate.defines.includes("TEXTURE_UNITS 3"));
  assert.ok(variant !== undefined);

  const reference = assembleGlslForVariant(variant, { ShaderSourceClass: upstream, base, fragments: production.fragments, destinationOf: production.variants.destinationOf });
  const explicit = assembleGlslForVariant(variant, { ShaderSourceClass: production.ShaderSource, base, fragments: production.fragments, destinationOf: production.variants.destinationOf, emit: "glsl" });
  assert.equal(explicit.vertexSource, reference.vertexSource);
  assert.equal(explicit.fragmentSource, reference.fragmentSource);

  // The WGSL channel consumes the *same* inputs; it must not mutate them.
  const source = new production.ShaderSource({ sources: [...base.fragment], defines: [...variant.defines] });
  const before = JSON.stringify({ sources: source.sources, defines: source.defines, includeBuiltIns: source.includeBuiltIns });
  const { assemblyInputsOf } = production.shaderEmit;
  const inputs = assemblyInputsOf(source);
  assert.equal(inputs.sources, source.sources, "assembly inputs MUST be forwarded by reference, not copied");
  assert.equal(inputs.defines, source.defines);
  assert.equal(JSON.stringify({ sources: source.sources, defines: source.defines, includeBuiltIns: source.includeBuiltIns }), before, "reading the assembly inputs MUST NOT mutate the source");
});

test("rule A9: the patch layer never assigns the GLSL view and keeps _attributeLocations", async () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|mts|js|mjs)$/.test(entry.name)) files.push(full);
    }
  };
  walk(repoPath(BACKEND));
  assert.ok(files.length > 30, `the patch layer MUST have been scanned (got ${files.length} files)`);

  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const [pattern, message] of [
      [/(?:^|[^.\w])vertexShaderSource\s*=(?!=)/, "MUST NOT overwrite the GLSL view (contract R2)"],
      [/(?:^|[^.\w])fragmentShaderSource\s*=(?!=)/, "MUST NOT overwrite the GLSL view (contract R2)"],
    ]) {
      text.split(/\r?\n/).forEach((line, index) => {
        if (pattern.test(line)) offenders.push(`${file}:${index + 1} ${message}: ${line.trim().slice(0, 120)}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `the logic layer's GLSL view MUST stay untouched:\n${offenders.join("\n")}`);

  const program = fs.readFileSync(repoPath(`${BACKEND}/Renderer/ShaderProgram.ts`), "utf8");
  assert.match(program, /_attributeLocations/, "the replacement ShaderProgram MUST keep the attribute-location read surface");
});

test("the replacement never writes WGSL into Source/Shaders/** (contract R3 / §9)", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|mts|js|mjs|json)$/.test(entry.name)) files.push(full);
    }
  };
  walk(repoPath(BACKEND));
  const writeAttempts = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:writeFileSync|writeFile|createWriteStream|localFile)\s*\(?\s*[`"']([^`"']*Source\/Shaders[^`"']*)[`"']/g)) {
      writeAttempts.push(`${file}: ${match[0].slice(0, 120)}`);
    }
  }
  assert.deepEqual(writeAttempts, [], `nothing in the patch layer may write into Source/Shaders/** (found: ${writeAttempts.join(", ")})`);
});
