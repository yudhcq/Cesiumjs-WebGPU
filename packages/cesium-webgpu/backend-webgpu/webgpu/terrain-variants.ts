/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * **The MVP-reachable terrain define space and the prewarm policy** (tasks.md T073/T079; G-5/G-6;
 * data-model §4.5 `VariantKey`; plan.md Complexity Tracking).
 *
 * Every dimension is traced to the upstream code that decides it
 * (`Scene/GlobeSurfaceShaderSet.js:278-412` in `@cesium/engine` 26.3.0) and to the MVP slice pinned by
 * `plan.md:268-269` / `spec.md`. Dimensions whose upstream values are **not** reachable in the MVP are
 * not enumerated; they are listed in `EXCLUDED_DEFINES` with the same traceability, so the
 * enumeration is auditable rather than merely declared.
 *
 * The enumeration is a pure cross product — nothing is sampled, nothing is skipped — and the emitter
 * is required to reject (not degrade) any define set outside the supported set, which is what makes
 * the cross product a *closed* claim.
 *
 * **Prewarm policy (G-6 rev3).** The first two G-6 budgets judged the cost of compiling *every*
 * reachable variant in sequence — a quantity the product never exposes. What the product exposes is a
 * **startup cost** and the **interaction stalls** of a running session, so the product prepares a
 * *bounded, configuration-derived* subset before the first frame and serves the session from it
 * (measured: 0 compilations during a documented 300-frame session). The plan is a pure function of the
 * application's configuration — no measurement, no randomness:
 *
 *   - **dynamic dimensions** are the ones a running MVP application can change without rebuilding the
 *     scene: the tile's imagery layer count, the ground-atmosphere mode (per-vertex/per-fragment is
 *     recomputed from the camera distance every frame, `GlobeSurfaceTileProvider.js:2600-2604`), fog
 *     (`Scene.fog.enabled`) and the lighting mode (`GlobeSurfaceShaderSet.js:327-335`);
 *   - **construction-fixed dimensions** come from the application's own configuration: the terrain
 *     encoding (quantization, geodetic normals, exaggeration) is a property of the terrain provider,
 *     and the imagery adjustments are properties of the imagery layers. Both are inputs of the plan:
 *     **when the application changes them it MUST recompute the plan** (adding an imagery layer,
 *     swapping the terrain provider, …) — that contract is what keeps the plan bounded while still
 *     covering the session.
 *
 * Plan size = 3 (imagery layers 1..3) × 3 (ground-atmosphere modes) × 2 (fog) × 2 (lighting) = **36**
 * variant identities. Registered budget (`experiments/gates/g6-variants/budget.json`, revision 3):
 * startup ≤ 5 s, runtime compiles = 0, single new variant p95 < 300 ms; the 768-variant full-space
 * prewarm is **reference only, never a criterion**.
 *
 * Ported from the verified gate implementations
 * (`experiments/gates/g5-shader/define-matrix.mjs`, `experiments/gates/g6-variants/prewarm-policy.mjs`).
 *
 * Zero dependencies, cross-platform, no `node:` import.
 */

/** Scene modes reachable in the MVP slice (plan.md:268-269 pins a single 3D globe). */
export const MVP_SCENE_MODE = "SCENE3D";

export const SCENE_MODES = { SCENE3D: "SCENE3D", SCENE2D: "SCENE2D", COLUMBUS_VIEW: "COLUMBUS_VIEW", MORPHING: "MORPHING" } as const;

/** Shader stage a define is pushed to, mirroring `GlobeSurfaceShaderSet.js:278-412`. */
export const DEFINE_DESTINATION: Readonly<Record<string, "vertex" | "fragment" | "both">> = {
  QUANTIZATION_BITS12: "vertex",
  GEODETIC_SURFACE_NORMALS: "vertex",
  EXAGGERATION: "vertex",
  TEXTURE_UNITS: "fragment",
  TILE_LIMIT_RECTANGLE: "fragment",
  APPLY_IMAGERY_CUTOUT: "fragment",
  APPLY_BRIGHTNESS: "fragment",
  APPLY_CONTRAST: "fragment",
  APPLY_HUE: "fragment",
  APPLY_SATURATION: "fragment",
  APPLY_GAMMA: "fragment",
  APPLY_ALPHA: "fragment",
  APPLY_DAY_NIGHT_ALPHA: "fragment",
  HAS_WATER_MASK: "fragment",
  SHOW_REFLECTIVE_OCEAN: "both",
  SHOW_OCEAN_WAVES: "fragment",
  APPLY_COLOR_TO_ALPHA: "fragment",
  UNDERGROUND_COLOR: "both",
  TRANSLUCENT: "both",
  ENABLE_VERTEX_LIGHTING: "both",
  ENABLE_DAYNIGHT_SHADING: "both",
  DYNAMIC_ATMOSPHERE_LIGHTING: "both",
  DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN: "both",
  GROUND_ATMOSPHERE: "both",
  PER_FRAGMENT_GROUND_ATMOSPHERE: "both",
  INCLUDE_WEB_MERCATOR_Y: "both",
  FOG: "both",
  APPLY_SPLIT: "fragment",
  ENABLE_CLIPPING_PLANES: "fragment",
  ENABLE_CLIPPING_POLYGONS: "fragment",
  CLIPPING_INVERSE: "fragment",
  COLOR_CORRECT: "fragment",
  HIGHLIGHT_FILL_TILE: "fragment",
  HAS_VECTOR_LAYER: "fragment",
  HAS_VECTOR_POLYLINES: "fragment",
  HAS_VECTOR_POLYGONS: "fragment",
  VECTOR_ANTIALIAS: "fragment",
  VECTOR_WIDTH_IN_METERS: "fragment",
  VECTOR_WIDTH_MIXED_UNITS: "fragment",
  APPLY_MATERIAL: "both",
};

/** A define the MVP path never pushes, with the upstream line that makes it unreachable. */
export interface ExcludedDefine {
  readonly define: string;
  readonly why: string;
  readonly source: string;
}

/**
 * Terrain-unreachable-in-MVP defines, each with the reason it is excluded. The emitter refuses every
 * one of them explicitly (`SUPPORTED_DEFINES` subtracts this set) — the first G-5 run silently
 * emitted `APPLY_MATERIAL` because the subtraction was missing, and the gate's own
 * `uncovered-define-sets-fail-explicitly-not-silently` check caught it.
 */
export const EXCLUDED_DEFINES: readonly ExcludedDefine[] = [
  { define: "APPLY_MATERIAL", why: "MVP globe has no material (Globe.js:667-676)", source: "Globe.js:672" },
  { define: "HAS_VECTOR_LAYER", why: "vector tiles are out of scope (spec 'Out of Scope')", source: "GlobeSurfaceShaderSet.js:395" },
  { define: "HAS_VECTOR_POLYLINES", why: "only pushed together with HAS_VECTOR_LAYER", source: "GlobeSurfaceShaderSet.js:397" },
  { define: "HAS_VECTOR_POLYGONS", why: "only pushed together with HAS_VECTOR_LAYER", source: "GlobeSurfaceShaderSet.js:400" },
  { define: "VECTOR_ANTIALIAS", why: "only pushed together with HAS_VECTOR_LAYER", source: "GlobeSurfaceShaderSet.js:403" },
  { define: "VECTOR_WIDTH_IN_METERS", why: "only pushed together with HAS_VECTOR_LAYER", source: "GlobeSurfaceShaderSet.js:406" },
  { define: "VECTOR_WIDTH_MIXED_UNITS", why: "only pushed together with HAS_VECTOR_LAYER", source: "GlobeSurfaceShaderSet.js:409" },
  { define: "ENABLE_CLIPPING_PLANES", why: "clipping planes are out of scope", source: "GlobeSurfaceShaderSet.js:367" },
  { define: "ENABLE_CLIPPING_POLYGONS", why: "clipping polygons are out of scope", source: "GlobeSurfaceShaderSet.js:371" },
  { define: "CLIPPING_INVERSE", why: "only pushed together with ENABLE_CLIPPING_POLYGONS", source: "GlobeSurfaceShaderSet.js:374" },
  { define: "APPLY_IMAGERY_CUTOUT", why: "MVP has no imagery cutouts", source: "GlobeSurfaceShaderSet.js:280" },
  { define: "HIGHLIGHT_FILL_TILE", why: "debug fill-tile path", source: "GlobeSurfaceShaderSet.js:383" },
  { define: "COLOR_CORRECT", why: "globe hue/saturation/brightness shift is out of scope", source: "GlobeSurfaceShaderSet.js:379" },
  { define: "DYNAMIC_ATMOSPHERE_LIGHTING", why: "atmosphere lighting effects are out of scope", source: "GlobeSurfaceShaderSet.js:337" },
  { define: "DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN", why: "only pushed together with DYNAMIC_ATMOSPHERE_LIGHTING", source: "GlobeSurfaceShaderSet.js:340" },
  { define: "UNDERGROUND_COLOR", why: "underground colour is out of scope", source: "GlobeSurfaceShaderSet.js:319" },
  { define: "TRANSLUCENT", why: "translucency is out of scope for the MVP terrain slice", source: "GlobeSurfaceShaderSet.js:323" },
  { define: "HDR", why: "the HDR path is reserved for the HDR pipeline (never pushed for the globe)", source: "no `HDR` push in GlobeSurfaceShaderSet.js" },
  { define: "SHOW_TILE_BOUNDARIES", why: "debug path, not pushed by the shader set", source: "no push in GlobeSurfaceShaderSet.js" },
  { define: "GENERATE_POSITION_AND_NORMAL", why: "only used by shading pipelines that need normals without lighting; not pushed by the globe shader set", source: "no push in GlobeSurfaceShaderSet.js" },
];

/** An excluded *value* of a dimension that is itself reachable. */
export interface ExcludedValue {
  readonly value: string;
  readonly why: string;
  readonly source: string;
}

export interface ReachableDimension {
  readonly id: string;
  readonly values: readonly string[];
  readonly excludedValues: readonly ExcludedValue[];
  readonly defines: (value: string) => readonly string[];
  readonly justification: string;
  readonly source: string;
}

/**
 * The dimensions of the MVP-reachable cross product: `4 × 2 × 2 × 3 × 2 × 1 × 2 × 1 × 4 = 768`.
 *
 * `values` is the reachable value list; `excludedValues` records the values deliberately left out
 * **together with the upstream line that makes them unreachable**, so the narrowing is auditable.
 */
export const REACHABLE_DIMENSIONS: readonly ReachableDimension[] = [
  {
    id: "textureUnits",
    values: ["0", "1", "2", "3"],
    excludedValues: [],
    defines: (value) => [`TEXTURE_UNITS ${value}`],
    justification: "numberOfDayTextures = the tile's imagery layer count (GlobeSurfaceTileProvider.js:3035,3177). 0..3 matches G-4's MVP matrix; a further layer only appends another unrolled sampleAndBlend call.",
    source: "GlobeSurfaceShaderSet.js:280",
  },
  {
    id: "quantization",
    values: ["float", "QUANTIZATION_BITS12"],
    excludedValues: [],
    defines: (value) => (value === "float" ? [] : [value]),
    justification: "quantizationDefine comes from the tile's terrain encoding: HeightmapTerrainData with quantization on ⇒ BITS12, otherwise a float per element.",
    source: "GlobeSurfaceShaderSet.js:278",
  },
  {
    id: "lighting",
    values: ["daynight", "vertex"],
    excludedValues: [{ value: "none", why: "plan.md:269 pins globe.enableLighting=true for the MVP scene, so the lighting branch is always taken", source: "plan.md:269 / GlobeSurfaceShaderSet.js:327" }],
    defines: (value) => [value === "daynight" ? "ENABLE_DAYNIGHT_SHADING" : "ENABLE_VERTEX_LIGHTING"],
    justification: "GlobeSurfaceShaderSet.js:327-335 — `enableLighting && hasVertexNormals ? ENABLE_VERTEX_LIGHTING : ENABLE_DAYNIGHT_SHADING`. Both values are reachable at runtime: hasVertexNormals follows the terrain provider, and the two differ in which varyings exist (exactly the E1 trap).",
    source: "GlobeSurfaceShaderSet.js:327",
  },
  {
    id: "groundAtmosphere",
    values: ["per-vertex", "per-fragment", "none"],
    excludedValues: [],
    defines: (value) => (value === "none" ? [] : value === "per-vertex" ? ["GROUND_ATMOSPHERE"] : ["GROUND_ATMOSPHERE", "PER_FRAGMENT_GROUND_ATMOSPHERE"]),
    justification: "GlobeSurfaceShaderSet.js:346-353 — `showGroundAtmosphere` (true by default for WGS84) × `perFragmentGroundAtmosphere`, recomputed per frame as `cameraDistance > fadeOutDistance` (GlobeSurfaceTileProvider.js:2600-2604) — so this dimension really does vary inside one session (see G-6/T025).",
    source: "GlobeSurfaceShaderSet.js:346",
  },
  {
    id: "fog",
    values: ["FOG", "none"],
    excludedValues: [],
    defines: (value) => (value === "none" ? [] : [value]),
    justification: "GlobeSurfaceShaderSet.js:358-361 — `enableFog` (Scene.fog.enabled, true by default, togglable from the MVP API).",
    source: "GlobeSurfaceShaderSet.js:358",
  },
  {
    id: "ocean",
    values: ["none"],
    excludedValues: [
      { value: "mask", why: "`hasWaterMask = tileProvider.hasWaterMask && defined(waterMaskTexture)` and `tileProvider.hasWaterMask` defaults to false; the MVP terrain (CustomHeightmapTerrainProvider / HeightmapTerrainData) supplies no water mask", source: "GlobeSurfaceTileProvider.js:102,2571" },
      { value: "reflective", why: "`showReflectiveOcean = hasWaterMask && tileProvider.showWaterEffect` — needs the water mask", source: "GlobeSurfaceTileProvider.js:2572" },
      { value: "waves", why: "`showOceanWaves = showReflectiveOcean && defined(oceanNormalMap)` — needs both", source: "GlobeSurfaceTileProvider.js:2574" },
    ],
    defines: () => [],
    justification: "Ocean shading is only reachable with a water mask (GlobeSurfaceShaderSet.js:306-315); the MVP terrain has none, so the whole dimension collapses to `none`.",
    source: "GlobeSurfaceShaderSet.js:306",
  },
  {
    id: "imageryOps",
    values: ["none", "alpha"],
    excludedValues: [
      { value: "all", why: "brightness/contrast/hue/saturation/gamma/day-night-alpha/split/color-to-alpha are derived from `ImageryLayer` hue/saturation/brightnessShift/colorToAlpha — none of them is exposed by the MVP API (spec 'Out of Scope': imagery layer management)", source: "GlobeSurfaceTileProvider.js:2988-3158,3246-3262" },
    ],
    defines: (value) => (value === "none" ? [] : ["APPLY_ALPHA"]),
    justification: "GlobeSurfaceShaderSet.js:285-302,316-318,363-365 / GlobeSurfaceTileProvider.js:2988-3158 — `applyAlpha` is the one adjustment a plain `ImageryLayer` can carry (alpha < 1); the rest require the layer colour-correction settings the MVP does not expose.",
    source: "GlobeSurfaceShaderSet.js:285",
  },
  {
    id: "tileLimitRectangle",
    values: ["none"],
    excludedValues: [{ value: "TILE_LIMIT_RECTANGLE", why: "`cartographicLimitRectangleDefine` is only defined when the tile provider has a cartographic limit rectangle; the MVP scene sets none", source: "GlobeSurfaceShaderSet.js:281" }],
    defines: () => [],
    justification: "The MVP scene does not limit the globe to a cartographic rectangle, so the define is never pushed.",
    source: "GlobeSurfaceShaderSet.js:281",
  },
  {
    id: "geodetic",
    values: ["none", "geodetic", "exaggeration", "both"],
    excludedValues: [],
    defines: (value) => (value === "none" ? [] : value === "geodetic" ? ["GEODETIC_SURFACE_NORMALS"] : value === "exaggeration" ? ["EXAGGERATION"] : ["GEODETIC_SURFACE_NORMALS", "EXAGGERATION"]),
    justification: "GlobeSurfaceShaderSet.js:387-393 — `hasGeodeticSurfaceNormals = encoding.hasGeodeticSurfaceNormals` and `hasExaggeration = exaggeration !== 1.0` (GlobeSurfaceTileProvider.js:2645-2646) are independent, so all four combinations are reachable; EXAGGERATION alone has no effect in the shader, which the emitter reproduces.",
    source: "GlobeSurfaceShaderSet.js:387",
  },
];

/** Defines upstream pushes unconditionally for every globe tile (`GlobeSurfaceShaderSet.js:355-356`). */
export const ALWAYS_DEFINES: readonly string[] = ["INCLUDE_WEB_MERCATOR_Y"];

/** One enumerated variant: its canonical id, the dimension selection and the define list. */
export interface TerrainVariant {
  readonly id: string;
  readonly selection: readonly { readonly id: string; readonly value: string }[];
  readonly defines: readonly string[];
  readonly sceneMode: string;
}

/** Which stage each define goes to (`ShaderSource` keeps separate define lists per stage). */
export function destinationOf(define: string): "vertex" | "fragment" | "both" {
  return DEFINE_DESTINATION[define.split(/\s+/)[0] ?? ""] ?? "both";
}

/** Enumerate the MVP-reachable define sets (the full cross product — no sampling, no skipping). */
export function enumerateReachableVariants(): TerrainVariant[] {
  let combinations: { dimension: ReachableDimension; value: string }[][] = [[]];
  for (const dimension of REACHABLE_DIMENSIONS) {
    const next: { dimension: ReachableDimension; value: string }[][] = [];
    for (const prefix of combinations) for (const value of dimension.values) next.push([...prefix, { dimension, value }]);
    combinations = next;
  }
  return combinations.map((combination) => {
    const selection = combination.map((entry) => ({ id: entry.dimension.id, value: entry.value }));
    const defines: string[] = [...ALWAYS_DEFINES];
    for (const entry of combination) defines.push(...entry.dimension.defines(entry.value));
    return { id: selection.map((entry) => `${entry.id}=${entry.value}`).join("|"), selection, defines, sceneMode: MVP_SCENE_MODE };
  });
}

/**
 * The **witness variant** for the union varying pairing (G-6/T025 fix).
 *
 * `PER_FRAGMENT_GROUND_ATMOSPHERE` is emitted as a pipeline-overridable constant, so the module text
 * must be the same for per-vertex and per-fragment. The varying set is *derived from the real
 * assembled GLSL* and the two modes differ there — in per-fragment mode the vertex stage does not
 * compute the atmosphere scattering (`GlobeVS.js:212`) and the fragment stage does not read it
 * (`GlobeFS.js:494-509`) — so the per-fragment pairing is a strict subset of the per-vertex one. The
 * module therefore uses the **per-vertex (witness) pairing**, which is the union: both arms of the
 * override stay satisfiable, the interpolated values keep their locations, and the per-fragment
 * specialisation simply never writes or reads them (identical to the GLSL `#ifdef` behaviour).
 */
export function perVertexWitnessVariant(variant: TerrainVariant): TerrainVariant | null {
  if (!variant.defines.includes("PER_FRAGMENT_GROUND_ATMOSPHERE")) return null;
  return { ...variant, defines: variant.defines.filter((define) => define !== "PER_FRAGMENT_GROUND_ATMOSPHERE") };
}

/** Find one enumerated variant by its canonical id. Throws when the id is not reachable. */
export function variantById(id: string): TerrainVariant {
  const variant = enumerateReachableVariants().find((candidate) => candidate.id === id);
  if (variant === undefined) throw new Error(`terrain-variants: "${id}" is not an MVP-reachable variant`);
  return variant;
}

// ------------------------------------------------------------------------------------------------
// prewarm policy (G-6 rev3)
// ------------------------------------------------------------------------------------------------

/** The dimensions a running application can change, with the values the MVP API exposes. */
export const PREWARM_DYNAMIC_DIMENSIONS: readonly { readonly id: string; readonly values: readonly string[]; readonly why: string }[] = [
  { id: "textureUnits", values: ["1", "2", "3"], why: "imagery layer count: the MVP API adds/removes imagery layers while running (GlobeSurfaceTileProvider.js:3035,3177); 0 layers is not a rendering configuration" },
  { id: "groundAtmosphere", values: ["per-vertex", "per-fragment", "none"], why: "ground atmosphere mode is recomputed from the camera distance every frame (GlobeSurfaceTileProvider.js:2600-2604); `none` is reachable through the MVP scene options" },
  { id: "fog", values: ["FOG", "none"], why: "Scene.fog.enabled is a documented public toggle" },
  { id: "lighting", values: ["daynight", "vertex"], why: "depends on whether the terrain tile carries vertex normals (GlobeSurfaceShaderSet.js:327-335), i.e. per tile" },
];

/** The dimensions taken from the application's configuration (inputs of the plan, not swept). */
export const PREWARM_FIXED_DIMENSIONS: readonly { readonly id: string; readonly why: string }[] = [
  { id: "quantization", why: "terrain encoding of the configured provider (HeightmapTerrainData quantization)" },
  { id: "imageryOps", why: "imagery layer adjustments: APPLY_ALPHA follows the layer's alpha, set when the layer is added" },
  { id: "geodetic", why: "geodetic surface normals / exaggeration are properties of the terrain encoding" },
  { id: "ocean", why: "water mask availability belongs to the terrain provider" },
  { id: "tileLimitRectangle", why: "cartographic limit rectangle belongs to the tile provider" },
];

/** The MVP application configuration the verification assets document (the same one the harness uses). */
export const DEFAULT_APP_CONFIGURATION: Readonly<Record<string, string>> = {
  quantization: "QUANTIZATION_BITS12",
  imageryOps: "alpha",
  geodetic: "both",
  ocean: "none",
  tileLimitRectangle: "none",
};

/** The analytically computed plan size (registered in `budget.json` as `maxPrewarmVariants`). */
export const PREWARM_PLAN_SIZE = PREWARM_DYNAMIC_DIMENSIONS.reduce((product, dimension) => product * dimension.values.length, 1);

/** Stable key of one selection, in the canonical dimension order of `REACHABLE_DIMENSIONS`. */
export function selectionKey(selection: readonly { readonly id: string; readonly value: string }[]): string {
  const order = new Map(REACHABLE_DIMENSIONS.map((dimension, index) => [dimension.id, index]));
  return [...selection]
    .sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER))
    .map((entry) => `${entry.id}=${entry.value}`)
    .join("|");
}

export interface PrewarmPlan {
  readonly configuration: Readonly<Record<string, string>>;
  readonly size: number;
  readonly planned: readonly TerrainVariant[];
  readonly remaining: readonly TerrainVariant[];
}

/**
 * The planned variants (and the complement) for one configuration, resolved against the reachable
 * define matrix.
 *
 * @throws when a planned selection is not a reachable variant — the plan MUST NOT invent a variant
 *   the emitter cannot produce.
 */
export function prewarmPlan(configuration: Readonly<Record<string, string>> = DEFAULT_APP_CONFIGURATION): PrewarmPlan {
  const variants = enumerateReachableVariants();
  const byId = new Map(variants.map((variant) => [variant.id, variant]));
  const selections: { id: string; value: string }[][] = [[]];
  for (const dimension of PREWARM_DYNAMIC_DIMENSIONS) {
    const next: { id: string; value: string }[][] = [];
    for (const prefix of selections) for (const value of dimension.values) next.push([...prefix, { id: dimension.id, value }]);
    selections.length = 0;
    selections.push(...next);
  }
  const plannedIds = new Set<string>();
  for (const selection of selections) {
    const withFixed = [...selection, ...Object.entries(configuration).map(([id, value]) => ({ id, value }))];
    const key = selectionKey(withFixed);
    if (!byId.has(key)) throw new Error(`terrain-variants: the prewarm plan names ${key}, which is not a reachable variant`);
    plannedIds.add(key);
  }
  const planned = [...plannedIds].map((id) => byId.get(id) as TerrainVariant);
  return { configuration, size: planned.length, planned, remaining: variants.filter((variant) => !plannedIds.has(variant.id)) };
}
