/**
 * G-6 gate — **reachable-subset prewarm plan** (the product's default variant-preparation policy).
 *
 * The gate's first two budgets judged the cost of compiling *every* reachable variant in sequence — a
 * quantity the product never exposes (revision 3 of `budget.json`, `plan.md`「G-6 修复轮」). What the
 * product exposes is a **startup cost** and the **interaction stalls** of a running session, so the
 * product prepares a *bounded, configuration-derived* subset before the first frame and serves the
 * session from it (measured: 0 compilations during a documented 300-frame session).
 *
 * The plan is a pure function of the application's configuration — no measurement, no randomness:
 *
 *   - **dynamic dimensions** are the ones a running MVP application can change without rebuilding the
 *     scene: the tile's imagery layer count, the ground-atmosphere mode (per-vertex/per-fragment is
 *     recomputed from the camera distance every frame,
 *     `GlobeSurfaceTileProvider.js:2600-2604`), fog (`Scene.fog.enabled`) and the lighting mode
 *     (whether the terrain tile carries vertex normals, `GlobeSurfaceShaderSet.js:327-335`);
 *   - **construction-fixed dimensions** come from the application's own configuration: the terrain
 *     encoding (quantization, geodetic normals, exaggeration) is a property of the terrain provider,
 *     and the imagery adjustments (`APPLY_ALPHA`, …) are properties of the imagery layers. Both are
 *     inputs of this function: **when the application changes them it MUST recompute the plan**
 *     (adding an imagery layer, swapping the terrain provider, …) — that contract is what keeps the
 *     plan bounded while still covering the session.
 *
 * Plan size = 3 (imagery layers 1..3, `GlobeSurfaceTileProvider.js:3035,3177`) × 3 (ground-atmosphere
 * modes) × 2 (fog) × 2 (lighting) = **36** variant identities. At the measured per-variant cost of a
 * pipeline with its bindings (~0.1 s on the gate device) that is ~3.5 s of startup work, which the
 * registered budget bounds at 5 s.
 *
 * Node-only, zero dependencies, cross-platform.
 */
import { REACHABLE_DIMENSIONS, enumerateReachableVariants } from "../g5-shader/define-matrix.mjs";

/** The dimensions a running application can change, with the values the MVP API exposes. */
export const PREWARM_DYNAMIC_DIMENSIONS = [
  { id: "textureUnits", values: [1, 2, 3], why: "imagery layer count: the MVP API adds/removes imagery layers while running (GlobeSurfaceTileProvider.js:3035,3177); 0 layers is not a rendering configuration" },
  { id: "groundAtmosphere", values: ["per-vertex", "per-fragment", "none"], why: "ground atmosphere mode is recomputed from the camera distance every frame (GlobeSurfaceTileProvider.js:2600-2604); `none` is reachable through the MVP scene options" },
  { id: "fog", values: ["FOG", "none"], why: "Scene.fog.enabled is a documented public toggle" },
  { id: "lighting", values: ["daynight", "vertex"], why: "depends on whether the terrain tile carries vertex normals (GlobeSurfaceShaderSet.js:327-335), i.e. per tile" },
];

/** The dimensions taken from the application's configuration (inputs of the plan, not swept). */
export const PREWARM_FIXED_DIMENSIONS = [
  { id: "quantization", why: "terrain encoding of the configured provider (HeightmapTerrainData quantization)" },
  { id: "imageryOps", why: "imagery layer adjustments: APPLY_ALPHA follows the layer's alpha, set when the layer is added" },
  { id: "geodetic", why: "geodetic surface normals / exaggeration are properties of the terrain encoding" },
  { id: "ocean", why: "water mask availability belongs to the terrain provider" },
  { id: "tileLimitRectangle", why: "cartographic limit rectangle belongs to the tile provider" },
];

/** The MVP application configuration the gate documents (the same one `tools/shader-verify.mjs` uses). */
export const DEFAULT_APP_CONFIGURATION = {
  quantization: "QUANTIZATION_BITS12",
  imageryOps: "alpha",
  geodetic: "both",
  ocean: "none",
  tileLimitRectangle: "none",
};

/** The analytically computed plan size (registered in `budget.json` as `maxPrewarmVariants`). */
export const PREWARM_PLAN_SIZE = PREWARM_DYNAMIC_DIMENSIONS.reduce((product, dimension) => product * dimension.values.length, 1);

/**
 * The variant selections the plan prepares, for one application configuration.
 *
 * @param {object} [configuration] values for every `PREWARM_FIXED_DIMENSIONS` entry
 * @returns {Array<{id: string, value: unknown}>[]} one selection per planned variant
 */
export function prewarmSelections(configuration = DEFAULT_APP_CONFIGURATION) {
  let selections = [[]];
  for (const dimension of PREWARM_DYNAMIC_DIMENSIONS) {
    const next = [];
    for (const prefix of selections) {
      for (const value of dimension.values) next.push([...prefix, { id: dimension.id, value }]);
    }
    selections = next;
  }
  return selections.map((selection) => [...selection, ...Object.entries(configuration).map(([id, value]) => ({ id, value }))]);
}

/**
 * Stable key of one selection, in the canonical dimension order of `define-matrix.mjs` — the ids the
 * reachable enumeration uses (`enumerateReachableVariants`), so a planned selection can be resolved
 * against it directly.
 */
export function selectionKey(selection) {
  const order = new Map(REACHABLE_DIMENSIONS.map((dimension, index) => [dimension.id, index]));
  return [...selection]
    .sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER))
    .map((entry) => `${entry.id}=${entry.value}`)
    .join("|");
}

/**
 * The planned variants (and the complement) for one configuration, resolved against the reachable
 * define matrix. Throws when a planned selection is not a reachable variant — the plan MUST NOT
 * invent a variant the emitter cannot produce.
 *
 * @returns {{planned: object[], remaining: object[], configuration: object, size: number}}
 */
export function prewarmPlan(configuration = DEFAULT_APP_CONFIGURATION) {
  const variants = enumerateReachableVariants();
  const byId = new Map(variants.map((variant) => [variant.id, variant]));
  const plannedIds = [];
  for (const selection of prewarmSelections(configuration)) {
    const key = selectionKey(selection);
    const variant = byId.get(key);
    if (variant === undefined) throw new Error(`g6: the prewarm plan names ${key}, which is not a reachable variant`);
    plannedIds.push(key);
  }
  const unique = [...new Set(plannedIds)];
  const planned = unique.map((id) => byId.get(id));
  const plannedSet = new Set(unique);
  return {
    configuration,
    size: planned.length,
    planned,
    remaining: variants.filter((variant) => !plannedSet.has(variant.id)),
  };
}
