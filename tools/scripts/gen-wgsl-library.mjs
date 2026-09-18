#!/usr/bin/env node
/**
 * `tools/scripts/gen-wgsl-library.mjs` — inline the WGSL library `.wgsl` files into a TypeScript
 * module the **browser bundle** can import (tasks.md T069; contract fork-patch-layer §5 rule R3).
 *
 *   node tools/scripts/gen-wgsl-library.mjs [--check]
 *
 * Why a generated module and not a rollup asset plugin: the runtime emitter lives in the browser
 * bundle, where `node:fs` does not exist, and the workspace deliberately carries no extra rollup
 * plugin. The `.wgsl` files stay the single reviewable source of truth; this generator mirrors them
 * into `webgpu/wgsl/generated-library.ts`, and `--check` (run by the unit suite) fails on drift.
 * `shader-leaf-map.json` records the hash of every `.wgsl` file, so the mirror can never diverge
 * unnoticed.
 *
 * Zero dependencies, Node-only, cross-platform.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const WEBGPU = path.join(REPO_ROOT, "packages", "cesium-webgpu", "backend-webgpu", "webgpu");
const OUT_FILE = path.join(WEBGPU, "wgsl", "generated-library.ts");

/** The library files the emitter consumes, in emission order. */
export const LIBRARY_FILES = [
  { exportName: "CZM_PRELUDE_TEXT", file: "wgsl-prelude/czm-prelude.wgsl", what: "the terrain `czm_` prelude (T068)" },
  { exportName: "TERRAIN_VERTEX_LEAF", file: "wgsl/leaves/globe-vertex.wgsl", what: "the terrain vertex stage leaf (T069)" },
  { exportName: "TERRAIN_FRAGMENT_LIBRARY_LEAF", file: "wgsl/leaves/globe-fragment-library.wgsl", what: "the terrain fragment helper leaf (T069)" },
  { exportName: "TERRAIN_FRAGMENT_MAIN_LEAF", file: "wgsl/leaves/globe-fragment-main.wgsl", what: "the terrain fragment entry-point leaf (T069)" },
];

export function buildLibraryModule() {
  const parts = [
    "/**",
    " * SPDX-License-Identifier: Apache-2.0",
    " *",
    " * New module of the cesium-webgpu render backend layer (not derived from any upstream file).",
    " *",
    " * GENERATED FILE — do not edit.",
    " *",
    " * Regenerate with `node tools/scripts/gen-wgsl-library.mjs`.",
    " * Source of truth: the `.wgsl` files under `webgpu/wgsl-prelude/` and `webgpu/wgsl/leaves/`.",
    " * The unit suite runs `gen-wgsl-library.mjs --check`, so staleness fails the build.",
    " *",
    " * Why this mirror exists: the emitted WGSL is produced at runtime inside the browser bundle,",
    " * where `node:fs` is unavailable, and the workspace carries no rollup asset plugin. The `.wgsl`",
    " * files remain the reviewable artefact; `shader-leaf-map.json` carries their hashes.",
    " */",
    "",
  ];
  const hashes = {};
  for (const entry of LIBRARY_FILES) {
    const text = fs.readFileSync(path.join(WEBGPU, entry.file), "utf8");
    hashes[entry.file] = text;
    parts.push(`/** ${entry.what} — \`${entry.file}\`. */`);
    parts.push(`export const ${entry.exportName} = ${JSON.stringify(text)};`);
    parts.push("");
  }
  return { text: parts.join("\n"), hashes };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.slice(2).includes("--check");
  const { text } = buildLibraryModule();
  if (check) {
    const onDisk = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : "";
    if (onDisk !== text) {
      process.stderr.write("gen-wgsl-library: generated-library.ts is stale — run `node tools/scripts/gen-wgsl-library.mjs`\n");
      process.exitCode = 1;
    } else {
      process.stdout.write(`gen-wgsl-library: generated-library.ts is up to date (${LIBRARY_FILES.length} files)\n`);
    }
  } else {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, text, "utf8");
    process.stdout.write(`gen-wgsl-library: wrote ${path.relative(REPO_ROOT, OUT_FILE).split(path.sep).join("/")} (${text.length} bytes)\n`);
  }
}
