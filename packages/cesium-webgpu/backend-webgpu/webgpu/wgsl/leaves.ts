/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * The **runtime** view of the terrain WGSL leaf library (tasks.md T069): the four leaf texts the
 * emitter assembles, resolved without any filesystem access so the module can live in the browser
 * bundle.
 *
 * The text itself is generated from the reviewable `.wgsl` files by
 * `tools/scripts/gen-wgsl-library.mjs` (see `generated-library.ts`); the `node:fs`-based loaders and
 * the `shader-leaf-map.json` index live in `index.ts`, which only tools and tests import.
 */
import { CZM_PRELUDE_TEXT, TERRAIN_FRAGMENT_LIBRARY_LEAF, TERRAIN_FRAGMENT_MAIN_LEAF, TERRAIN_VERTEX_LEAF } from "./generated-library.js";

export { CZM_PRELUDE_TEXT, TERRAIN_FRAGMENT_LIBRARY_LEAF, TERRAIN_FRAGMENT_MAIN_LEAF, TERRAIN_VERTEX_LEAF };

/** The library text the emitter prepends / appends, resolved without any filesystem access. */
export const WGSL_LEAVES = {
  prelude: CZM_PRELUDE_TEXT,
  vertex: TERRAIN_VERTEX_LEAF,
  fragmentLibrary: TERRAIN_FRAGMENT_LIBRARY_LEAF,
  fragmentMain: TERRAIN_FRAGMENT_MAIN_LEAF,
} as const;
