/**
 * T012 — package entry and public type surface.
 *
 * The export set is asserted to be EXACTLY the symbol set listed in contract
 * render-path-api.md §1, and `src/api/types.ts` is checked field by field against that
 * contract plus data-model §2.2/§2.5/§7.1.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../support/repo.mjs";

const index = readText("packages/cesium-webgpu/src/index.ts");
const types = readText("packages/cesium-webgpu/src/api/types.ts");

/** Drop comments so prose in the doc block cannot satisfy (or break) a code-level assertion. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const indexCode = stripComments(index);

/** Names re-exported through `export type { … } from "…"` / `export { … } from "…"`. */
function reExportedNames(source) {
  const names = [];
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of match[1].split(",")) {
      const entry = raw.trim();
      if (entry.length === 0) continue;
      const alias = entry.split(/\s+as\s+/);
      names.push(alias[alias.length - 1].replace(/^type\s+/, "").trim());
    }
  }
  return names;
}

/** Names declared directly in the entry (`export function` / `export const` / …). */
function declaredNames(source) {
  return [...source.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(
    (match) => match[1],
  );
}

/** Member names of `export interface <name> { … }` (brace matched). */
function interfaceMembers(source, name) {
  const marker = `export interface ${name}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `src/api/types.ts MUST declare "export interface ${name}"`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        const body = source.slice(open + 1, i);
        return [...body.matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?:(]/gm)].map((match) => match[1]);
      }
    }
  }
  throw new Error(`unterminated interface ${name}`);
}

test("the entry exports exactly the contract symbol set", () => {
  const exported = [...reExportedNames(index), ...declaredNames(index)].sort();
  const expected = [
    "BackendKind",
    "DiagnosticError",
    "FrameCapture",
    "FrameStatistics",
    "RenderPathStatus",
    "TerrainSceneHandle",
    "TerrainSceneOptions",
    "createTerrainScene",
  ].sort();
  assert.deepEqual(exported, expected, "the public export set MUST match contract render-path-api.md §1");
  assert.equal(new Set(exported).size, exported.length, "no duplicate exports");
});

test("the entry exposes no concrete backend symbol", () => {
  for (const name of [...reExportedNames(index), ...declaredNames(index)]) {
    assert.doesNotMatch(name, /GPU|WebGL|Context|Buffer|Texture|Shader|Device/, `export "${name}" looks backend specific`);
  }
  assert.doesNotMatch(indexCode, /escape-hatch/, "the optional escape hatch MUST NOT be re-exported from the entry (contract C-6)");
});

test("BackendKind and RenderPathStatus match the data model", () => {
  assert.match(types, /export type BackendKind = "webgpu" \| "webgl2";/);
  assert.deepEqual(interfaceMembers(types, "RenderPathStatus").sort(), ["active", "degraded", "notes", "reason"]);
  for (const reason of [
    "ok",
    "no-navigator-gpu",
    "no-adapter",
    "device-request-failed",
    "missing-feature",
    "below-limit",
    "timeout",
  ]) {
    assert.ok(types.includes(`"${reason}"`), `RenderPathStatus.reason MUST include "${reason}" (data-model §2.2)`);
  }
});

test("TerrainSceneOptions and TerrainSceneHandle match contract §1", () => {
  assert.deepEqual(interfaceMembers(types, "TerrainSceneOptions").sort(), [
    "camera",
    "container",
    "datasetId",
    "onStatus",
    "preference",
    "viewport",
  ]);
  assert.deepEqual(interfaceMembers(types, "TerrainSceneHandle").sort(), [
    "captureFrame",
    "diagnostics",
    "dispose",
    "ready",
    "requestRender",
    "resetStats",
    "setView",
    "stats",
    "whenTilesLoaded",
  ]);
});

test("DiagnosticError, FrameCapture and FrameStatistics match the contracts", () => {
  assert.deepEqual(interfaceMembers(types, "DiagnosticError").sort(), ["backend", "category", "cause", "message"]);
  for (const category of ["not-implemented", "data-unavailable", "render-failed"]) {
    assert.ok(types.includes(`"${category}"`), `DiagnosticError.category MUST include "${category}"`);
  }
  assert.deepEqual(interfaceMembers(types, "FrameCapture").sort(), [
    "height",
    "origin",
    "pixelFormat",
    "pixels",
    "premultiplied",
    "width",
  ]);
  assert.deepEqual(interfaceMembers(types, "FrameStatistics").sort(), [
    "depthDiscontinuityRatio",
    "drawCallCount",
    "frameTimeMs",
    "nonBackgroundRatio",
    "tileCount",
    "triangleCount",
    "uniqueColorCount",
  ]);
});

test("createTerrainScene is declared with the contract signature", () => {
  assert.match(index, /export function createTerrainScene\(options: TerrainSceneOptions\): TerrainSceneHandle/);
  assert.match(index, /category: "not-implemented"/, "the Phase 1 skeleton MUST fail loudly instead of returning a dead handle");
});
