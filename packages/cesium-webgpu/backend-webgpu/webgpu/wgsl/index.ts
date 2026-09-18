/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * **Terrain WGSL leaf library** (tasks.md **T069**; contract fork-patch-layer §5 rule **R3**;
 * verification contract §4 SH-3).
 *
 * The terrain closure of the upstream shader tree — `GlobeVS`, `GlobeFS`, `AtmosphereCommon`,
 * `GroundAtmosphere` — translated once and kept here. The upstream `Source/Shaders/**` tree is
 * **never** modified and no WGSL is ever written into it (contract §9 MUST NOT); the association
 * with upstream is carried by `../shader-leaf-map.json` (leaf text hash → WGSL file, rule R3/R7).
 *
 * Two kinds of file live under `wgsl/`:
 *
 *   - `leaves/*.wgsl` — **templates** for the emitter. They use the GLSL conditional-directive syntax
 *     (`#if`/`#elif`/`#else`/`#endif`/`#ifdef`), which WGSL does not have; the directives are resolved
 *     per variant by `../glsl-preprocess.ts` before any device sees the text. A template is therefore
 *     **not** a standalone WGSL module and is validated in its *emitted* form.
 *   - `globe-vs.wgsl` / `globe-fs.wgsl` — the **frozen reference module pair** for the MVP golden
 *     configuration: complete, template-free modules, reviewed and kept as the human-readable
 *     path-B artefact T069 names. They are also what `tools/scripts/check-wgsl.mjs` can hand to
 *     `naga --input-kind wgsl` directly, and the pairing `-vs`/`-fs` is the static half of the
 *     varying contract (architecture rule A10).
 *
 * Coverage of this increment: the terrain closure plus the `czm_` built-ins it needs
 * (`../wgsl-prelude/**`). The remaining 319 `.glsl` files / 244 built-ins are outside this increment
 * (`docs/shader-coverage-scope.md`, T082).
 *
 * The **runtime** path never touches the filesystem: the leaf text is inlined into
 * `generated-library.ts` by `tools/scripts/gen-wgsl-library.mjs`. The `node:fs` loaders below are for
 * tools and tests only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { CZM_PRELUDE_TEXT, TERRAIN_FRAGMENT_LIBRARY_LEAF, TERRAIN_FRAGMENT_MAIN_LEAF, TERRAIN_VERTEX_LEAF, WGSL_LEAVES } from "./leaves.js";

export { CZM_PRELUDE_TEXT, TERRAIN_FRAGMENT_LIBRARY_LEAF, TERRAIN_FRAGMENT_MAIN_LEAF, TERRAIN_VERTEX_LEAF, WGSL_LEAVES };

/** One library entry: the WGSL module for one upstream shader leaf. */
export interface WgslLibraryEntry {
  readonly name: string;
  /** Path relative to `backend-webgpu/webgpu/`, e.g. `wgsl/leaves/globe-vertex.wgsl`. */
  readonly wgslFile: string;
  /** Hash of the upstream leaf text this module was translated from (drift detection, R7). */
  readonly leafHash: string;
  /** Set to `true` only after the real-device pipeline check passed (contract §5 R5). */
  readonly verifiedOnRealGpu: boolean;
  readonly convertedBy: string;
  readonly notes?: string;
}

/** The catalogue of the four shader families this increment covers (T069 acceptance). */
export const TERRAIN_SHADER_FAMILIES: readonly { readonly family: string; readonly upstreamLeaf: string; readonly wgslFile: string }[] = [
  { family: "GlobeVS", upstreamLeaf: "Source/Shaders/GlobeVS.js", wgslFile: "wgsl/leaves/globe-vertex.wgsl" },
  { family: "GlobeFS", upstreamLeaf: "Source/Shaders/GlobeFS.js", wgslFile: "wgsl/leaves/globe-fragment-main.wgsl" },
  { family: "AtmosphereCommon", upstreamLeaf: "Source/Shaders/AtmosphereCommon.js", wgslFile: "wgsl/leaves/globe-fragment-library.wgsl" },
  { family: "GroundAtmosphere", upstreamLeaf: "Source/Shaders/GroundAtmosphere.js", wgslFile: "wgsl/leaves/globe-fragment-library.wgsl" },
];

/** The frozen reference module pair (complete modules; A10 pairs `-vs` with `-fs`). */
export const REFERENCE_MODULE_PAIR: readonly { readonly stage: "vertex" | "fragment"; readonly wgslFile: string }[] = [
  { stage: "vertex", wgslFile: "wgsl/globe-vs.wgsl" },
  { stage: "fragment", wgslFile: "wgsl/globe-fs.wgsl" },
];

const HERE_DIR = ((): string => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();

/** `webgpu/` directory — the root the `wgslFile` paths are relative to. */
export function webgpuDir(): string {
  return path.resolve(HERE_DIR, "..");
}

/** Absolute path of the leaf map. */
export function shaderLeafMapPath(): string {
  return path.join(webgpuDir(), "shader-leaf-map.json");
}

function sha256(text: string): string {
  return `sha256-${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * Load the library index from `shader-leaf-map.json`.
 *
 * @throws when the map is missing or empty — an absent leaf map MUST fail (SH-3 / rule A11), never
 *   yield an empty library that silently emits nothing.
 */
export function loadShaderLibrary(mapPath: string = shaderLeafMapPath()): readonly WgslLibraryEntry[] {
  if (!fs.existsSync(mapPath)) throw new Error(`wgsl: shader leaf map not found at ${mapPath} — the acceptance path MUST have one (contract R3/A11)`);
  const parsed = JSON.parse(fs.readFileSync(mapPath, "utf8")) as { leaves?: WgslLibraryEntry[] } | WgslLibraryEntry[];
  const entries = Array.isArray(parsed) ? parsed : (parsed.leaves ?? []);
  if (entries.length === 0) throw new Error(`wgsl: ${mapPath} lists no leaves — an empty map would silently pass the SH-3 completeness check`);
  return entries;
}

/**
 * Read one WGSL module by its `wgslFile` (or by the upstream leaf name it was translated from).
 *
 * @throws when the file is missing: a mapped-but-absent file is exactly the drift R7 exists to catch.
 */
export function readWgslModule(leafName: string, mapPath: string = shaderLeafMapPath()): string {
  const library = loadShaderLibrary(mapPath);
  const entry = library.find((candidate) => candidate.wgslFile === leafName || candidate.name === leafName);
  if (entry === undefined) throw new Error(`wgsl: "${leafName}" is not in ${mapPath}`);
  const file = path.join(webgpuDir(), entry.wgslFile);
  if (!fs.existsSync(file)) throw new Error(`wgsl: "${entry.wgslFile}" is mapped but missing on disk (upgrade drift, contract R7)`);
  return fs.readFileSync(file, "utf8");
}

/** The library text the emitter prepends / appends, resolved without any filesystem access. */
export const RUNTIME_LIBRARY = WGSL_LEAVES;

/** Content hash of one library text, in the same encoding `shader-leaf-map.json` uses. */
export function leafTextHash(text: string): string {
  return sha256(text);
}
