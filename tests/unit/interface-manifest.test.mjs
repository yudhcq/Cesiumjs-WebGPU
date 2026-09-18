/**
 * T035 — interface-consistency manifest (`tools/gen-interface-manifest.mjs` → `upstream/interface-manifest.json`).
 *
 * The manifest quantifies "what would an upstream upgrade break": for every module the patch
 * layer replaces or adapts it records the exposed member surface the logic layer consumes and
 * the logic-layer files that consume it. The generator is re-run by the upgrade drill (T036).
 *
 * MEASURED COUNTS (recorded here, see the phase report for the deviation list):
 *   - `Context` exposed surface 122 members, 30 of them consumed by the logic layer (research §1.3
 *     says ">= 30 members" — reproduced);
 *   - `ContextLimits` upstream public surface **23** members (research §4 C-2), consumed by the
 *     logic layer through **9** of them (research §1.3), and the declaration surface in
 *     `types/engine-internal.d.ts` covers exactly those 23 — T035's task text still says
 *     "`ContextLimits` 10 个成员", which is the stale count C-2 corrects.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, readJson, repoPath } from "../support/repo.mjs";
import { listEngineModules } from "../../tools/lib/patch-layer.mjs";
import { buildInterfaceManifest, compareInterfaceManifests, listInterfaceModules, readMemberSurface } from "../../tools/gen-interface-manifest.mjs";

const GENERATOR = repoPath("tools/gen-interface-manifest.mjs");
const ENGINE_SOURCE = path.join(REPO_ROOT, "node_modules", "@cesium", "engine", "Source");
const RENDERER = path.join(ENGINE_SOURCE, "Renderer");
const manifest = readJson("upstream/interface-manifest.json");
const entryFor = (name) => manifest.entries.find((entry) => entry.module === `Renderer/${name}`);

function runGenerator(args) {
  const result = spawnSync(process.execPath, [GENERATOR, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The declaration surface of a `declare module` block, parsed exactly as T005's test does. */
function declaredMembers(moduleId) {
  const source = fs.readFileSync(repoPath("packages/cesium-webgpu/types/engine-internal.d.ts"), "utf8");
  const marker = `declare module "${moduleId}"`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `engine-internal.d.ts MUST declare ${moduleId}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > open, `unterminated declare module block for ${moduleId}`);
  return new Set(
    [...source.slice(open + 1, end).matchAll(/^ {4}(?:readonly\s+|static\s+readonly\s+|static\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[?:(]/gm)].map((match) => match[1]),
  );
}

test("the committed interface manifest is up to date with the installed 26.3.0 (--check)", () => {
  const { code, stdout } = runGenerator(["--check"]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /no drift/);
  assert.equal(manifest.baselineVersion, "26.3.0");
  assert.match(manifest.digest, /^sha256-[0-9a-f]{64}$/);
});

test("every entry matches the contract shape (module, exportedSymbols, consumedMembers, consumedBy)", () => {
  assert.ok(manifest.entries.length > 0);
  for (const entry of manifest.entries) {
    assert.match(entry.module, /^Renderer\/[A-Za-z0-9_]+\.js$/);
    assert.ok(Array.isArray(entry.exportedSymbols) && entry.exportedSymbols.length > 0, `${entry.module} MUST expose symbols`);
    assert.ok(Array.isArray(entry.consumedMembers), `${entry.module} MUST carry consumedMembers`);
    for (const member of entry.consumedMembers) {
      assert.equal(typeof member.name, "string");
      assert.ok(["method", "accessor", "property", "field", "static", "export", "factory"].includes(member.kind), `${entry.module}.${member.name} kind "${member.kind}"`);
      if (member.arity !== undefined) assert.ok(Number.isInteger(member.arity) && member.arity >= 0);
    }
    assert.ok(Array.isArray(entry.consumedBy), `${entry.module} MUST carry consumedBy`);
    for (const file of entry.consumedBy) assert.doesNotMatch(file, /^Renderer\//, "consumedBy MUST list logic-layer files only");
  }
});

test("the covered module set is the manifest surface plus the declared internal modules", () => {
  const modules = listInterfaceModules().map((descriptor) => descriptor.module);
  assert.deepEqual(
    manifest.entries.map((entry) => entry.module),
    modules,
    "the interface manifest MUST cover exactly the replaced/adapted modules and the declared internal ones",
  );
  const declared = [...declaredMembers("@cesium/engine/Source/Renderer/ContextLimits.js")];
  assert.ok(declared.length > 0);
  for (const entry of manifest.entries) {
    const absolute = path.join(RENDERER, entry.module.replace("Renderer/", ""));
    assert.ok(fs.existsSync(absolute), `${entry.module} MUST exist in the installed upstream package`);
  }
});

test("Context exposes >= 30 members and the logic layer consumes them through documented receivers", () => {
  const context = entryFor("Context.js");
  assert.ok(context.exportedSymbols.length >= 30, `Context surface MUST be >= 30 members, got ${context.exportedSymbols.length}`);
  assert.ok(context.consumedMembers.length >= 30, `expected >= 30 consumed Context members, got ${context.consumedMembers.length}`);
  assert.ok(context.consumedBy.length > 10, "Context is consumed from many logic-layer files");
  for (const name of ["drawingBufferWidth", "drawingBufferHeight", "defaultTexture", "createViewportQuadCommand", "uniformState", "shaderCache", "textureCache"]) {
    assert.ok(context.consumedMembers.some((member) => member.name === name), `Context MUST record the logic-layer consumer "${name}"`);
  }
  for (const name of ["draw", "clear", "beginFrame", "endFrame", "readPixels", "createPickId", "getViewportQuadVertexArray", "destroy", "isDestroyed", "canvas"]) {
    assert.ok(context.exportedSymbols.includes(name), `Context surface MUST include the command seam member "${name}"`);
  }
});

test("ContextLimits matches the measured upstream surface: 23 public members, 9 consumed", () => {
  const limits = entryFor("ContextLimits.js");
  const upstreamSource = fs.readFileSync(path.join(RENDERER, "ContextLimits.js"), "utf8");
  const upstreamPublic = [...upstreamSource.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*\{\s*$/gm)].map((match) => match[1]);

  assert.equal(upstreamPublic.length, 23, "the installed 26.3.0 exposes 23 public ContextLimits members (research §4 C-2)");
  assert.deepEqual(limits.exportedSymbols, [...upstreamPublic].sort(), "the recorded surface MUST equal the measured upstream surface");
  assert.equal(limits.consumedMembers.length, 9, "research §1.3 measures 9 ContextLimits members read by the logic layer");
  assert.deepEqual(
    limits.consumedMembers.map((member) => member.name).sort(),
    [
      "maximumAliasedLineWidth",
      "maximumAliasedPointSize",
      "maximumCubeMapSize",
      "maximumSamples",
      "maximumTextureFilterAnisotropy",
      "maximumTextureImageUnits",
      "maximumTextureSize",
      "maximumVertexTextureImageUnits",
      "minimumAliasedLineWidth",
    ].sort(),
    "the consumed set MUST equal the measured logic-layer consumption of research §1.3",
  );
  // The declaration surface covers exactly the upstream public members (no gap, no invention).
  const declared = declaredMembers("@cesium/engine/Source/Renderer/ContextLimits.js");
  assert.equal(declared.size, 23, `engine-internal.d.ts declares 23 ContextLimits members (T035's "10" and the file comment's "22" are both stale)`);
  for (const name of upstreamPublic) assert.ok(declared.has(name), `engine-internal.d.ts MUST declare "${name}"`);
});

test("ShaderProgram records the GLSL read surface including _attributeLocations", () => {
  const program = entryFor("ShaderProgram.js");
  for (const name of ["vertexShaderSource", "fragmentShaderSource", "_attributeLocations", "id", "vertexAttributes"]) {
    assert.ok(program.exportedSymbols.includes(name), `ShaderProgram surface MUST include "${name}"`);
    assert.ok(program.consumedMembers.some((member) => member.name === name), `ShaderProgram MUST record the logic-layer consumer of "${name}"`);
  }
  const source = fs.readFileSync(path.join(RENDERER, "ShaderProgram.js"), "utf8");
  assert.match(source, /this\._attributeLocations = options\.attributeLocations/, "upstream MUST still expose _attributeLocations");
});

test("every recorded member still exists in the installed upstream source (anti-drift)", () => {
  const engineModules = new Set(listEngineModules());
  for (const entry of manifest.entries) {
    const source = fs.readFileSync(path.join(RENDERER, entry.module.replace("Renderer/", "")), "utf8");
    const { members } = readMemberSurface(source);
    for (const name of entry.exportedSymbols) {
      assert.ok(members.has(name), `${entry.module}: recorded member "${name}" no longer exists upstream`);
    }
    for (const member of entry.consumedMembers) {
      assert.ok(members.has(member.name), `${entry.module}: consumed member "${member.name}" no longer exists upstream`);
    }
    for (const file of entry.consumedBy) {
      assert.ok(engineModules.has(file), `${entry.module}: consumedBy file "${file}" is not part of the installed upstream package`);
    }
  }
});

test("interface drift is detected: a changed member or consumer is reported as a changed module", () => {
  const generated = buildInterfaceManifest();
  const baseline = structuredClone(generated);
  baseline.entries.find((entry) => entry.module === "Renderer/Context.js").consumedMembers.push({ name: "madeUpMember", kind: "property" });
  const diff = compareInterfaceManifests(baseline, generated);
  assert.equal(diff.drifted, true);
  assert.ok(diff.changedRenderModules.includes("Renderer/Context.js"));
  assert.deepEqual(diff.breakingConsumedMembers.filter((item) => item.module === "Renderer/Context.js" && item.member === "madeUpMember"), []);
});

test("a new consumed member appears in the diff as upgrade work", () => {
  const generated = buildInterfaceManifest();
  const baseline = structuredClone(generated);
  const context = baseline.entries.find((entry) => entry.module === "Renderer/Context.js");
  context.consumedMembers = context.consumedMembers.filter((member) => member.name !== "drawingBufferWidth");
  const diff = compareInterfaceManifests(baseline, generated);
  assert.equal(diff.drifted, true);
  assert.ok(diff.breakingConsumedMembers.some((item) => item.module === "Renderer/Context.js" && item.member === "drawingBufferWidth"));
});

test("the CLI reports drift against a tampered baseline (counterexample)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "interface-manifest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tampered = structuredClone(manifest);
  const context = tampered.entries.find((entry) => entry.module === "Renderer/Context.js");
  context.consumedBy = context.consumedBy.slice(1); // one logic-layer consumer disappears from the baseline
  const target = path.join(dir, "interface-manifest.json");
  fs.writeFileSync(target, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

  const { code, stderr } = runGenerator(["--check", "--manifest", target]);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /interface drift detected/);
  assert.match(stderr, /Renderer\/Context\.js/);
});

test("the committed baseline is reproduced byte for byte by the generator (deterministic)", () => {
  const generated = buildInterfaceManifest();
  assert.equal(generated.digest, manifest.digest);
  assert.deepEqual(
    generated.entries.map((entry) => [entry.module, entry.digest]),
    manifest.entries.map((entry) => [entry.module, entry.digest]),
    "regenerating MUST NOT change any entry digest (method stable)",
  );
  assert.match(manifest.method, /consumedMembers/);
});
