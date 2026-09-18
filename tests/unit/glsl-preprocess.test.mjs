/**
 * T066 — GLSL conditional-compilation evaluation (`层=单元`, tasks.md T066; SH-4;
 * contract fork-patch-layer §5 rule R4; research §6.4 items 1–2).
 *
 * The evaluator exists because upstream Cesium has **no** preprocessor: `ShaderSource.js:250-258`
 * writes `#define` lines into the text and lets the GL driver evaluate them, and WGSL has no driver
 * to do that. So the assertions here are about *equivalence with the driver's behaviour*, not about
 * "the function runs": `#elif` chains, arithmetic conditions, `defined()` precedence, C integer
 * semantics, object-like macro substitution, and the upstream **ordering** rule R4 — the `czm_`
 * built-ins are inlined *before* the conditionals are evaluated, which is why an inactive branch
 * still contributes its `czm_` dependencies.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";

async function load() {
  return loadTypeScriptModule(repoPath("packages/cesium-webgpu/backend-webgpu/webgpu/glsl-preprocess.ts"));
}

/** The live lines, as a compact string, for readability of the expectations. */
function live(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("|");
}

test("#ifdef / #ifndef / #else / #endif follow the define set", async () => {
  const { preprocess } = await load();
  const source = ["#ifdef FOG", "fogged", "#else", "clear", "#endif", "tail"].join("\n");

  assert.equal(live(preprocess(source, ["FOG"]).activeText), "fogged|tail");
  assert.equal(live(preprocess(source, []).activeText), "clear|tail");
  assert.equal(live(preprocess(source, ["OTHER"]).activeText), "clear|tail", "an unrelated define MUST NOT activate the branch");
});

test("#elif chains take exactly one branch and stop", async () => {
  const { preprocess } = await load();
  const source = ["#if defined(A)", "a", "#elif defined(B)", "b", "#elif defined(C)", "c", "#else", "d", "#endif"].join("\n");

  assert.equal(live(preprocess(source, ["A", "B", "C"]).activeText), "a", "the FIRST satisfied branch wins");
  assert.equal(live(preprocess(source, ["B", "C"]).activeText), "b");
  assert.equal(live(preprocess(source, ["C"]).activeText), "c");
  assert.equal(live(preprocess(source, []).activeText), "d");
  // The `#else` is only reachable when no arm was taken — an `#elif` after a taken arm is dead.
  assert.equal(live(preprocess(source, ["A"]).activeText), "a");
});

test("#elif inside a false outer block stays inactive even when its own condition is true", async () => {
  const { preprocess } = await load();
  const source = ["#ifdef OUTER", "#ifdef INNER", "inner", "#elif defined(OTHER)", "other", "#endif", "#endif", "tail"].join("\n");

  const result = preprocess(source, ["OTHER"]);
  assert.equal(live(result.activeText), "tail", "a nested chain inside an inactive region MUST NOT emit anything");
  assert.equal(result.diagnostics.length, 0, `an unclosed/inactive chain is not an error: ${JSON.stringify(result.diagnostics)}`);
});

test("arithmetic conditions: #if TEXTURE_UNITS > 0 and the full integer operator set", async () => {
  const { preprocess } = await load();
  const source = ["#if TEXTURE_UNITS > 0", "textured", "#else", "plain", "#endif"].join("\n");

  assert.equal(live(preprocess(source, ["TEXTURE_UNITS 3"]).activeText), "textured");
  assert.equal(live(preprocess(source, ["TEXTURE_UNITS 0"]).activeText), "plain");
  assert.equal(live(preprocess(source, []).activeText), "plain", "an undefined identifier evaluates to 0, as in C");

  const { evaluateCondition } = await load();
  const macros = new Map([
    ["TEXTURE_UNITS", "3"],
    ["A", "1"],
    ["B", "0"],
  ]);
  const cases = [
    ["TEXTURE_UNITS > 0", true],
    ["TEXTURE_UNITS == 3", true],
    ["TEXTURE_UNITS != 3", false],
    ["TEXTURE_UNITS >= 3 && TEXTURE_UNITS <= 4", true],
    ["A || B", true],
    ["A && B", false],
    ["!B", true],
    ["(A || B) && !B", true],
    ["1 << 3", true],
    ["16 >> 3", true],
    ["7 % 4", true],
    ["2 * 3 + 1 == 7", true],
    ["(A ? TEXTURE_UNITS : 0) == 3", true],
    ["~0 == -1", true],
    ["UNDEFINED_THING", false],
    ["defined(TEXTURE_UNITS) && !defined(NOPE)", true],
    ["defined TEXTURE_UNITS", true],
  ];
  for (const [expression, expected] of cases) {
    const evaluated = evaluateCondition(expression, macros);
    assert.equal(evaluated.error, null, `"${expression}" MUST evaluate without error (${evaluated.error})`);
    assert.equal(evaluated.value, expected, `"${expression}" MUST evaluate to ${expected}`);
  }
});

test("a malformed expression is diagnosed, never silently false", async () => {
  const { preprocess } = await load();
  const result = preprocess(["#if TEXTURE_UNITS >", "body", "#endif"].join("\n"), ["TEXTURE_UNITS 1"]);
  assert.ok(result.diagnostics.length > 0, "an unparsable #if MUST produce a diagnostic (the branch is inactive, not guessed)");
  assert.match(result.diagnostics[0].message, /#if|unexpected|expected/i);
});

test("unterminated conditional and stray directives produce diagnostics", async () => {
  const { preprocess } = await load();
  assert.ok(preprocess("#ifdef FOG\nbody", ["FOG"]).diagnostics.some((entry) => /unterminated/.test(entry.message)));
  assert.ok(preprocess("#endif\nbody", []).diagnostics.some((entry) => /#endif without #if/.test(entry.message)));
  assert.ok(preprocess("#unknown thing\nbody", []).diagnostics.some((entry) => /unsupported preprocessor directive/.test(entry.message)));
});

test("object-like macros substituted in text; empty-bodied macros are left alone", async () => {
  const { preprocess } = await load();
  const source = ["#if TEXTURE_UNITS > 0", "uniform vec4 u_dayTextureAlpha[TEXTURE_UNITS];", "#endif", "#ifdef FOG", "float f = FOG;", "#endif"].join("\n");
  const result = preprocess(source, ["TEXTURE_UNITS 3", "FOG"]);
  assert.match(result.activeText, /u_dayTextureAlpha\[3\]/, "the array size MUST be substituted, which is how the uniform collector sees the real length");
  assert.match(result.activeText, /float f = FOG;/, "a macro defined without a value MUST be left alone rather than substituted with nothing");

  const substituted = preprocess("float x = SCALE;", ["SCALE 2.5"]).activeText;
  assert.equal(substituted, "float x = 2.5;");
});

test("ConditionalCompilationTrace records the block count, the taken branches and the warnings", async () => {
  const { preprocess } = await load();
  const source = ["#ifdef A", "a", "#elif defined(B)", "b", "#else", "c", "#endif"].join("\n");
  const result = preprocess(source, ["B"], { variantKey: "lighting=vertex" });

  assert.equal(result.trace.variantKey, "lighting=vertex");
  assert.equal(result.trace.blocksEvaluated, 3, "three conditional directives were evaluated (#if, #elif, #else)");
  assert.deepEqual(result.trace.branchesTaken, [1], "directive index 1 (#elif) is the branch that was taken");
  assert.deepEqual([...result.trace.warnings], []);

  const warned = preprocess("#if 1 +\n#endif", [], { variantKey: "v" });
  assert.ok(warned.trace.warnings.length > 0, "a diagnostic MUST surface in the trace SH-4 requires to be persisted");
});

test("R4 ordering: czm_ built-ins are inlined BEFORE the conditionals are evaluated", async () => {
  const { inlineCzmBuiltins, referencedCzmBuiltins, evaluateShaderSource } = await load();

  // A stand-in for `ShaderSource._czmBuiltinsAndUniforms`: only the two names below exist.
  const builtins = {
    czm_helperA: "float czm_helperA() { return czm_helperB(); }",
    czm_helperB: "float czm_helperB() { return 1.0; }",
  };
  const resolver = (name) => builtins[name];
  const source = ["#ifdef NEVER_DEFINED", "float unused = czm_helperA();", "#endif", "void main() { }"].join("\n");

  // (a) the inactive branch STILL contributes its czm_ dependency — that is the upstream behaviour:
  // `getBuiltinsAndAutomaticUniforms` matches the combined text before the driver evaluates anything.
  assert.deepEqual(referencedCzmBuiltins(source, resolver), ["czm_helperA"], "the DIRECT reference scan MUST see through the inactive #ifdef");
  const inlined = inlineCzmBuiltins(source, resolver);
  assert.ok(inlined.includes("czm_helperA") && inlined.includes("czm_helperB"), "the inactive branch MUST pull in both the referenced built-in and its own (transitive) dependency");
  assert.ok(inlined.indexOf("float czm_helperB()") < inlined.indexOf("float czm_helperA()"), "a dependency MUST be declared before its dependent (topological order)");
  assert.ok(inlined.endsWith(source), "the inlined built-ins MUST be prepended to the unmodified source");

  // (b) and only THEN are the conditionals evaluated: the dead branch disappears from the live text.
  const evaluated = evaluateShaderSource({ source, defines: [], resolver, variantKey: "v" });
  assert.doesNotMatch(evaluated.text, /unused/, "the inactive region MUST be gone from the live text");
  assert.match(evaluated.text, /void main\(\)/, "the active region MUST survive");
  assert.equal(evaluated.trace.variantKey, "v");

  // (c) a circular built-in graph is an error, not a silent reordering.
  assert.throws(() => inlineCzmBuiltins("czm_a();", (name) => (name === "czm_a" ? "float czm_a() { return czm_b(); }" : name === "czm_b" ? "float czm_b() { return czm_a(); }" : undefined)), /circular dependency/);
});

test("textureUnitsDefine and evaluateConditionals are the delivered T066 entry points", async () => {
  const { textureUnitsDefine, evaluateConditionals } = await load();
  assert.deepEqual({ ...textureUnitsDefine(3) }, { TEXTURE_UNITS: 3 });
  assert.throws(() => textureUnitsDefine(-1), /non-negative integer/);

  const source = ["#if TEXTURE_UNITS > 1", "many", "#else", "few", "#endif"].join("\n");
  assert.match(evaluateConditionals(source, textureUnitsDefine(3)), /many/);
  assert.match(evaluateConditionals(source, textureUnitsDefine(1)), /few/);
});
