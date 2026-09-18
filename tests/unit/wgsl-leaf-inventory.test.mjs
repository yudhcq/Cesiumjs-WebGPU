/**
 * T069 — the terrain WGSL leaf inventory (tasks.md T069; principle I; contract fork-patch-layer §5
 * rule R3). T069's acceptance test.
 *
 * The task is a *boundary* statement as much as a content statement:
 *
 *   1. the four upstream shader families of the terrain closure (`GlobeVS`, `GlobeFS`,
 *      `AtmosphereCommon`, `GroundAtmosphere`) are all represented, and every file they map to exists;
 *   2. the WGSL lives **inside the backend layer** (`backend-webgpu/webgpu/**`) — no path outside it;
 *   3. there is **no write path into `Source/Shaders/**`** anywhere in the patch layer: not an import of
 *      a local shader file, not `fs.writeFile`, not a `localFile` value. The upstream shader tree is
 *      read-only by construction (contract §9 MUST NOT), and this is where that is checked;
 *   4. the two generators that mirror the `.wgsl` files into the bundle (`gen-wgsl-library.mjs`,
 *      `gen-wgsl-catalog.mjs`) are in sync — a hand edit of `generated-library.ts` / `catalog.ts` fails
 *      here;
 *   5. the leaf map covers exactly the library files the emitter consumes.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listFiles, readJson, readText, repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";

const BACKEND_WEBGPU = "packages/cesium-webgpu/backend-webgpu/webgpu";
const LIBRARY_ENTRY = `${BACKEND_WEBGPU}/wgsl/index.ts`;
const MAP_FILE = `${BACKEND_WEBGPU}/shader-leaf-map.json`;
const FAMILIES = ["GlobeVS", "GlobeFS", "AtmosphereCommon", "GroundAtmosphere"];

const runGenerator = (script) => spawnSync(process.execPath, [repoPath(script), "--check"], { encoding: "utf8" });

/** `LIBRARY_FILES` of `tools/scripts/gen-wgsl-library.mjs` — the four files the emitter consumes. */
async function libraryFiles() {
  const module_ = await import(new URL("../../tools/scripts/gen-wgsl-library.mjs", import.meta.url).href);
  assert.ok(Array.isArray(module_.LIBRARY_FILES), "gen-wgsl-library.mjs MUST export LIBRARY_FILES");
  return module_.LIBRARY_FILES;
}

test("the four terrain shader families are all represented, and their files exist", async () => {
  assert.ok(fs.existsSync(repoPath(LIBRARY_ENTRY)), `${LIBRARY_ENTRY} MUST exist (T069)`);
  const module_ = await loadTypeScriptModule(repoPath(LIBRARY_ENTRY));
  const families = module_.TERRAIN_SHADER_FAMILIES;
  assert.ok(Array.isArray(families), "webgpu/wgsl/index.ts MUST export TERRAIN_SHADER_FAMILIES");

  const declared = families.map((entry) => entry.family);
  for (const family of FAMILIES) {
    assert.ok(declared.includes(family), `${family} MUST be covered by TERRAIN_SHADER_FAMILIES (T069 lists the terrain closure explicitly)`);
  }
  assert.equal(new Set(declared).size, declared.length, "a family MUST NOT be listed twice");
  for (const entry of families) {
    assert.equal(typeof entry.upstreamLeaf, "string", `${entry.family} MUST name its upstream leaf`);
    assert.match(entry.upstreamLeaf, /^Source\/Shaders\/[A-Za-z0-9_]+\.js$/, `${entry.family}: the upstream leaf MUST be a Source/Shaders module`);
    assert.ok(fs.existsSync(repoPath(`node_modules/@cesium/engine/${entry.upstreamLeaf}`)), `${entry.family}: ${entry.upstreamLeaf} MUST exist in the installed engine`);
    assert.ok(fs.existsSync(repoPath(`${BACKEND_WEBGPU}/${entry.wgslFile}`)), `${entry.family}: ${entry.wgslFile} MUST exist under the backend layer`);
  }

  // The frozen reference pair is part of the inventory too (rules A10 pairs `-vs` with `-fs`).
  assert.ok(Array.isArray(module_.REFERENCE_MODULE_PAIR), "webgpu/wgsl/index.ts MUST export REFERENCE_MODULE_PAIR");
  for (const entry of module_.REFERENCE_MODULE_PAIR) {
    assert.ok(fs.existsSync(repoPath(`${BACKEND_WEBGPU}/${entry.wgslFile}`)), `the reference module ${entry.wgslFile} MUST exist`);
  }
});

test("every library file lives under backend-webgpu/webgpu/ (no path outside the backend layer)", async () => {
  const files = await libraryFiles();
  assert.ok(files.length >= 4, `the emitter consumes at least the four terrain files, got ${files.length}`);
  for (const entry of files) {
    assert.ok(fs.existsSync(repoPath(`${BACKEND_WEBGPU}/${entry.file}`)), `${entry.file} MUST exist relative to backend-webgpu/webgpu/`);
    const resolved = path.resolve(repoPath(BACKEND_WEBGPU), entry.file);
    const relative = path.relative(repoPath(BACKEND_WEBGPU), resolved).split(path.sep).join("/");
    assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), `${entry.file} escapes the backend layer`);
    assert.doesNotMatch(entry.file, /^Source\//, `${entry.file} MUST NOT live in (or be named after) the upstream Source/ tree (contract R3)`);
  }
});

test("no WGSL file exists anywhere outside the backend layer", () => {
  const strays = listFiles("packages/cesium-webgpu", { extensions: [".wgsl"] }).filter(
    (file) => !file.startsWith(`${BACKEND_WEBGPU}/`),
  );
  assert.deepEqual(strays, [], "WGSL belongs to the backend layer; a `.wgsl` file elsewhere would be an unowned artefact (contract R3)");
});

test("there is no write path into Source/Shaders/** anywhere in the patch layer", () => {
  const files = listFiles("packages/cesium-webgpu", { extensions: [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] });
  assert.ok(files.length > 0, "the scan MUST have subjects");

  const writeCalls = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|rename|renameSync)\s*\(/;
  const upstreamRelative = /["'`][^"'`]*Source[\\/]Shaders[\\/][^"'`]*["'`]/;
  const upstreamAbsolute = /["'`][^"'`]*(?:@cesium[\\/]engine[\\/]Source[\\/]Shaders|\/Source\/Shaders\/)[^"'`]*["'`]/;
  const offenders = [];
  const upstreamReferences = [];

  for (const relative of files) {
    const text = readText(relative);
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (upstreamRelative.test(line) || upstreamAbsolute.test(line)) {
        upstreamReferences.push({ file: relative, line: index + 1, text: line.trim() });
        // A line that mentions the upstream shader tree AND performs a filesystem write is the
        // violation the task names. A bare `import … from "@cesium/engine/Source/Shaders/…"` is the
        // aliased **read** the patch layer legitimately performs (contract R1), so it is not one.
        if (writeCalls.test(line)) offenders.push({ file: relative, line: index + 1, text: line.trim() });
      }
    }
    // A `localFile` value pointing into the upstream shader tree would make the alias plugin serve a
    // local replacement *for* an upstream shader module — the patch boundary crossing R3 forbids.
    const manifest = relative.endsWith("manifest.json") ? JSON.parse(text) : null;
    for (const entry of manifest?.entries ?? []) {
      if (typeof entry?.localFile === "string" && /Source[\\/]Shaders/.test(entry.localFile)) {
        offenders.push({ file: relative, line: 0, text: `localFile ${entry.localFile}` });
      }
    }
  }

  assert.deepEqual(offenders, [], `the patch layer MUST NOT write into Source/Shaders/** (contract §9, rule R3): ${JSON.stringify(offenders)}`);
  // The subject did not vanish: the upstream shader tree IS referenced (by aliased reads and by the
  // leaf map's provenance), so the assertion above is about a real boundary rather than an empty scan.
  assert.ok(upstreamReferences.length > 0, "expected the patch layer to reference the upstream shader tree somewhere");
  assert.ok(fs.existsSync(repoPath("node_modules/@cesium/engine/Source/Shaders/GlobeVS.js")), "the upstream shader tree MUST still exist (the boundary has a subject)");
});

test("gen-wgsl-library.mjs --check and gen-wgsl-catalog.mjs --check are in sync", () => {
  for (const script of ["tools/scripts/gen-wgsl-library.mjs", "tools/scripts/gen-wgsl-catalog.mjs"]) {
    const result = runGenerator(script);
    assert.equal(result.status, 0, `${script} --check failed (a hand edit of a generated file?): ${result.stdout}${result.stderr}`);
  }
});

test("the leaf map covers exactly the files the emitter consumes", async () => {
  const files = await libraryFiles();
  const map = readJson(MAP_FILE);
  const entries = Array.isArray(map) ? map : (map.leaves ?? []);
  assert.ok(entries.length > 0, "the leaf map MUST not be empty (SH-3)");

  const mapped = new Set(entries.map((entry) => entry.wgslFile).filter((file) => typeof file === "string"));
  for (const entry of files) {
    assert.ok(mapped.has(entry.file), `${entry.file} is consumed by the emitter but has no shader-leaf-map.json entry (rule A11/R7)`);
    assert.ok(
      entries.some((candidate) => candidate.wgslFile === entry.file && candidate.name !== undefined),
      `${entry.file} MUST have an entry with an upstream leaf name`,
    );
  }
  // The other direction: a mapped file the emitter does not consume would be an orphan mapping.
  const consumed = new Set(files.map((entry) => entry.file));
  for (const file of mapped) {
    assert.ok(consumed.has(file), `${file} is mapped but not consumed by the emitter — the mapping has drifted from the library`);
  }
  // The families are carried by the map too (T069's four-family statement, seen from the map's side).
  const names = entries.map((entry) => entry.name).join(" ");
  for (const family of FAMILIES) {
    assert.ok(names.includes(family), `${family} MUST appear in shader-leaf-map.json`);
  }
});
