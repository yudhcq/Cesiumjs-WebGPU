#!/usr/bin/env node
/**
 * `tools/scripts/gen-wgsl-catalog.mjs` — regenerate
 * `backend-webgpu/webgpu/wgsl-prelude/catalog.json` (tasks.md T068; data-model §4.5
 * `WgslPreludeEntry`).
 *
 * The catalog is the `czmName → wgslName` table of the terrain shader closure. It exists because
 * **WGSL has no function overloading**: upstream declares `czm_signNotZero(float|vec2|vec3|vec4)`
 * and WGSL needs four distinct names, so the mapping cannot be a rename — it is data.
 *
 *   node tools/scripts/gen-wgsl-catalog.mjs [--check]
 *
 * `--check` re-generates in memory and compares with the file on disk (exit 1 on drift), which is
 * what the unit suite runs; the default rewrites the file.
 *
 * Derivation (mechanical, no hand-editing):
 *   - `const czm_X : T = v`                      → `{ czmName: "czm_X", wgslName: "czm_X", kind: "constant" }`
 *   - `struct CzmsRay|CzmsRaySegment`            → upstream `czm_ray` / `czm_raySegment`, kind `struct`
 *   - `fn czms_<name>[2|3|4](params)`            → upstream `czm_<name>`, `overload` = the arity suffix
 *   - `fn <other>` (AtmosphereCommon helpers)    → same name, kind `function`
 *   - `czm.<name>` member reads in the leaves    → kind `builtin` (automatic uniform, lives in the
 *     uniform block struct, **not** in the prelude)
 *
 * Zero dependencies, Node-only, cross-platform.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const PRELUDE_DIR = path.join(REPO_ROOT, "packages", "cesium-webgpu", "backend-webgpu", "webgpu", "wgsl-prelude");
const PRELUDE_FILE = path.join(PRELUDE_DIR, "czm-prelude.wgsl");
const LEAF_FILES = [
  path.join(REPO_ROOT, "packages", "cesium-webgpu", "backend-webgpu", "webgpu", "wgsl", "leaves", "globe-vertex.wgsl"),
  path.join(REPO_ROOT, "packages", "cesium-webgpu", "backend-webgpu", "webgpu", "wgsl", "leaves", "globe-fragment-library.wgsl"),
  path.join(REPO_ROOT, "packages", "cesium-webgpu", "backend-webgpu", "webgpu", "wgsl", "leaves", "globe-fragment-main.wgsl"),
];
const CATALOG_FILE = path.join(PRELUDE_DIR, "catalog.json");
const CATALOG_TS_FILE = path.join(PRELUDE_DIR, "catalog.ts");

const STRUCT_UPSTREAM = { CzmsRay: "czm_ray", CzmsRaySegment: "czm_raySegment" };

/**
 * Split names that are **not** expressible by the trailing-arity convention.
 *
 * `czm_octDecode` is the case tasks.md T068 names explicitly: upstream overloads it as
 * `czm_octDecode(vec2)` (the packed form) and `czm_octDecode(float)` (the "float" form), and the port
 * splits them as `czms_octDecode` / `czms_octDecodeFloat` — the second carries no arity digit, so the
 * catalog needs the alias to keep "every overload has its own row" true.
 */
const SPLIT_ALIASES = {
  czms_octDecodeFloat: { czmName: "czm_octDecode", overload: 1, upstream: "Shaders/Builtin/Functions/octDecode.glsl (float overload)" },
  czms_octDecodeRange: { czmName: "czms_octDecodeRange", overload: null, upstream: "port-internal helper (range parameter folded out of the two overloads)" },
};

/**
 * Prelude declarations that are **not** ports of an upstream `czm_` name. They are catalogued like
 * everything else (a `czm_` reference has exactly one WGSL home), but their `upstream` field says so,
 * because pretending they came from `Source/Shaders/Builtin/**` would corrupt the R7 drift check.
 */
const BACKEND_HELPERS = new Set(["czms_remapClipDepth", "czms_unprojectDepth"]);

/** `czms_foo2` → `{ czmName: "czm_foo", overload: 2 }`; `czms_foo` → `{ czmName: "czm_foo", overload: null }`. */
function splitOverload(wgslName) {
  const alias = SPLIT_ALIASES[wgslName];
  if (alias !== undefined) return { czmName: alias.czmName, overload: alias.overload, upstream: alias.upstream };
  const match = /^czms_(.*?)([234])$/.exec(wgslName);
  if (match === null) return { czmName: `czm_${wgslName.replace(/^czms_/, "")}`, overload: null };
  return { czmName: `czm_${match[1]}`, overload: Number(match[2]) };
}

export function buildCatalog() {
  const prelude = fs.readFileSync(PRELUDE_FILE, "utf8");
  const leaves = LEAF_FILES.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const entries = [];

  for (const line of prelude.split("\n")) {
    let match = /^const\s+([A-Za-z_]\w*)\s*:/.exec(line);
    if (match !== null) {
      entries.push({ czmName: match[1], wgslName: match[1], kind: "constant", overload: null, upstream: "Shaders/Builtin/**" });
      continue;
    }
    match = /^struct\s+([A-Za-z_]\w*)\s*\{/.exec(line);
    if (match !== null) {
      const upstream = STRUCT_UPSTREAM[match[1]] ?? null;
      entries.push({
        czmName: upstream ?? match[1],
        wgslName: match[1],
        kind: "struct",
        overload: null,
        upstream: upstream === null ? "Shaders/AtmosphereCommon.js (port-internal return struct)" : `Shaders/Builtin/Constants/${upstream === "czm_ray" ? "ray" : "raySegment"}.glsl`,
      });
      continue;
    }
    match = /^fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(line);
    if (match !== null) {
      const wgslName = match[1];
      const parameters = (match[2] ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      const { czmName, overload, upstream } = splitOverload(wgslName);
      entries.push({
        czmName,
        wgslName,
        kind: "function",
        overload,
        parameters: parameters.length,
        upstream: upstream ?? (BACKEND_HELPERS.has(wgslName) ? "backend layer helper (tasks.md T074 depth-range remap; not an upstream czm_ name)" : "Shaders/Builtin/**"),
      });
    }
  }

  // Automatic uniforms are read as `czm.<name>` members of the uniform block struct. They are part of
  // the same name table (a `czm_` reference has exactly one WGSL home) but not of the prelude text.
  const members = new Set([...leaves.matchAll(/\bczm\.([A-Za-z_]\w*)/g)].map((entry) => entry[1]));
  for (const name of [...members].sort()) entries.push({ czmName: name, wgslName: `czm.${name}`, kind: "builtin", overload: null, upstream: "Renderer/AutomaticUniforms.js" });

  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    const key = `${entry.czmName}|${entry.wgslName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  unique.sort((left, right) => left.czmName.localeCompare(right.czmName) || left.wgslName.localeCompare(right.wgslName));

  return {
    schemaVersion: 1,
    note:
      "czmName -> wgslName mapping of the terrain shader closure (tasks.md T068; data-model §4.5 WgslPreludeEntry). " +
      "WGSL has no function overloading, so upstream overloads are split into distinct names (the trailing arity digit). " +
      "Struct constants become functions (`czm_emptyRaySegment`). `kind: builtin` entries are automatic uniforms: they live in " +
      "the uniform block struct, not in the prelude. Regenerate with `node tools/scripts/gen-wgsl-catalog.mjs`.",
    entries: unique,
  };
}

/**
 * The same catalog as a TypeScript module, because the runtime emitter lives in the browser bundle
 * and importing JSON would need an extra rollup plugin (the workspace has none, and adding one would
 * change the build chain for a purely mechanical reason). One generator writes both files, so they
 * cannot drift; `--check` compares both.
 */
export function renderTypeScript(catalog) {
  const rows = catalog.entries
    .map((entry) => `  { czmName: ${JSON.stringify(entry.czmName)}, wgslName: ${JSON.stringify(entry.wgslName)}, kind: ${JSON.stringify(entry.kind)}, overload: ${entry.overload === null ? "null" : String(entry.overload)}, upstream: ${JSON.stringify(entry.upstream)} },`)
    .join("\n");
  return `/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * GENERATED FILE — do not edit.
 *
 * Regenerate with \`node tools/scripts/gen-wgsl-catalog.mjs\`.
 * Source of truth: \`wgsl-prelude/czm-prelude.wgsl\` + the terrain WGSL leaves + \`catalog.json\`.
 * The unit suite runs \`gen-wgsl-catalog.mjs --check\`, so staleness fails the build.
 */
import type { WgslPreludeEntry } from "./index.js";

export const PRELUDE_CATALOG_ENTRIES: readonly WgslPreludeEntry[] = [
${rows}
];
`;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.slice(2).includes("--check");
  const catalog = buildCatalog();
  const text = `${JSON.stringify(catalog, null, 2)}\n`;
  const tsText = renderTypeScript(catalog);
  if (check) {
    const onDisk = fs.existsSync(CATALOG_FILE) ? fs.readFileSync(CATALOG_FILE, "utf8") : "";
    const onDiskTs = fs.existsSync(CATALOG_TS_FILE) ? fs.readFileSync(CATALOG_TS_FILE, "utf8") : "";
    if (onDisk !== text) {
      process.stderr.write("gen-wgsl-catalog: catalog.json is stale — run `node tools/scripts/gen-wgsl-catalog.mjs`\n");
      process.exitCode = 1;
    } else if (onDiskTs !== tsText) {
      process.stderr.write("gen-wgsl-catalog: catalog.ts is stale — run `node tools/scripts/gen-wgsl-catalog.mjs`\n");
      process.exitCode = 1;
    } else {
      process.stdout.write(`gen-wgsl-catalog: catalog.json + catalog.ts are up to date (${catalog.entries.length} entries)\n`);
    }
  } else {
    fs.mkdirSync(PRELUDE_DIR, { recursive: true });
    fs.writeFileSync(CATALOG_FILE, text, "utf8");
    fs.writeFileSync(CATALOG_TS_FILE, tsText, "utf8");
    const kinds = {};
    for (const entry of catalog.entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
    process.stdout.write(`gen-wgsl-catalog: wrote wgsl-prelude/catalog.{json,ts} (${catalog.entries.length} entries: ${JSON.stringify(kinds)})\n`);
  }
}
