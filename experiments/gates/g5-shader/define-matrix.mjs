/**
 * G-5 gate — the **MVP-reachable define matrix** and the real GLSL assembly for each variant
 * (tasks.md T023: "枚举地形路径可达的 define 组合（`TEXTURE_UNITS` × `GlobeSurfaceShaderSet` 的
 * 38 个 boolean 门控 × 场景模式中 MVP 实际可达子集）").
 *
 * Every dimension below is traced to the upstream code that decides it
 * (`Scene/GlobeSurfaceShaderSet.js:278-412` in `@cesium/engine` 26.3.0) and to the MVP slice pinned
 * by `plan.md:268-269` / `spec.md`. Dimensions whose upstream values are **not** reachable in the
 * MVP are not enumerated here; they are listed in `EXCLUDED_DEFINES` with the same traceability, so
 * the enumeration is auditable rather than merely declared.
 *
 * The enumeration is a pure cross product — nothing is sampled, nothing is skipped — and the
 * emitter is required to reject (not degrade) any define set outside the supported set, which is
 * what makes the cross product a *closed* claim (T023 (c)).
 */
import ShaderSource from "@cesium/engine/Source/Renderer/ShaderSource.js";
import AtmosphereCommon from "@cesium/engine/Source/Shaders/AtmosphereCommon.js";
import GlobeFS from "@cesium/engine/Source/Shaders/GlobeFS.js";
import GlobeVS from "@cesium/engine/Source/Shaders/GlobeVS.js";
import GroundAtmosphere from "@cesium/engine/Source/Shaders/GroundAtmosphere.js";

import { applyFlagsFromDefines, emitComputeDayColorGlsl, emitGetPositionGlsl, textureUnitsFromDefines } from "./mirror-generators.mjs";

/** The `Context` surface `ShaderSource.combineShader` reads (same stub as G-4, `Context.js:86-140`). */
export const SHADER_CONTEXT_STUB = { webgl2: true, textureFloatLinear: false, floatingPointTexture: true, fragmentDepth: true };

/** Base sources exactly as `Scene/Globe.js:679-687` (`makeShadersDirty`) builds them for MVP (no material). */
export const BASE_SOURCES = {
  vertex: [AtmosphereCommon, GroundAtmosphere, GlobeVS],
  fragment: [AtmosphereCommon, GroundAtmosphere, GlobeFS],
  defines: [],
  source: "node_modules/@cesium/engine/Source/Scene/Globe.js:658-688 (makeShadersDirty, no material ⇒ defines=[])",
};

/** Shader stage a define is pushed to, mirroring `GlobeSurfaceShaderSet.js:278-412`. */
export const DEFINE_DESTINATION = {
  QUANTIZATION_BITS12: "vertex",
  GEODETIC_SURFACE_NORMALS: "vertex",
  EXAGGERATION: "vertex",
  "TEXTURE_UNITS": "fragment",
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

/**
 * Terrain-unreachable-in-MVP defines, each with the reason it is excluded. (Superset of G-4's
 * `EXCLUDED_DEFINES`; the four additions are the shader-side defines G-4 did not enumerate.)
 */
export const EXCLUDED_DEFINES = [
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
  { define: "GENERATE_POSITION_AND_NORMAL", why: "only used by the shading pipelines that need normals without lighting; not pushed by the globe shader set", source: "no push in GlobeSurfaceShaderSet.js" },
];

/**
 * Scene modes reachable in the MVP slice. `plan.md:268-269` pins the MVP to a single globe with
 * 3D terrain; 2D/Columbus/morphing are **out of the MVP slice** (not a capability gap: the emitter
 * reproduces upstream's `getPositionMode`/`get2DYPositionFraction` choice, `POSITION_MODE_*`).
 */
export const MVP_SCENE_MODE = "SCENE3D";

export const SCENE_MODES = { SCENE3D: "SCENE3D", SCENE2D: "SCENE2D", COLUMBUS_VIEW: "COLUMBUS_VIEW", MORPHING: "MORPHING" };

/**
 * The dimensions of the MVP-reachable cross product.
 *
 * `values` is the reachable value list; `excludedValues` records the values this gate deliberately
 * leaves out **together with the upstream line that makes them unreachable for the MVP slice**, so
 * the narrowing is auditable rather than asserted. (Every excluded value is a *configuration* the
 * MVP scene never enters — none of them is a capability the emitter lacks.)
 */
export const REACHABLE_DIMENSIONS = [
  {
    id: "textureUnits",
    values: [0, 1, 2, 3],
    excludedValues: [],
    defines: (value) => [`TEXTURE_UNITS ${value}`],
    justification:
      "numberOfDayTextures = the tile's imagery layer count (GlobeSurfaceTileProvider.js:3035,3177). 0..3 matches G-4's MVP matrix; a further layer only appends another unrolled sampleAndBlend call.",
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
    excludedValues: [
      { value: "none", why: "plan.md:269 pins globe.enableLighting=true for the MVP scene, so the lighting branch is always taken", source: "plan.md:269 / GlobeSurfaceShaderSet.js:327" },
    ],
    defines: (value) => [value === "daynight" ? "ENABLE_DAYNIGHT_SHADING" : "ENABLE_VERTEX_LIGHTING"],
    justification:
      "GlobeSurfaceShaderSet.js:327-335 — `enableLighting && hasVertexNormals ? ENABLE_VERTEX_LIGHTING : ENABLE_DAYNIGHT_SHADING`. Both values are reachable at runtime: hasVertexNormals follows the terrain provider, and the two differ in which varyings exist (exactly the E1 trap).",
    source: "GlobeSurfaceShaderSet.js:327",
  },
  {
    id: "groundAtmosphere",
    values: ["per-vertex", "per-fragment", "none"],
    excludedValues: [],
    defines: (value) => (value === "none" ? [] : value === "per-vertex" ? ["GROUND_ATMOSPHERE"] : ["GROUND_ATMOSPHERE", "PER_FRAGMENT_GROUND_ATMOSPHERE"]),
    justification:
      "GlobeSurfaceShaderSet.js:346-353 — `showGroundAtmosphere` (true by default for WGS84) × `perFragmentGroundAtmosphere`, which is recomputed per frame as `cameraDistance > fadeOutDistance` (GlobeSurfaceTileProvider.js:2600-2604) — so this dimension really does vary inside one session (see G-6/T025).",
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
    defines: (value) => {
      if (value === "none") return [];
      if (value === "mask") return ["HAS_WATER_MASK"];
      if (value === "reflective") return ["HAS_WATER_MASK", "SHOW_REFLECTIVE_OCEAN"];
      return ["HAS_WATER_MASK", "SHOW_REFLECTIVE_OCEAN", "SHOW_OCEAN_WAVES"];
    },
    justification: "Ocean shading is only reachable with a water mask (GlobeSurfaceShaderSet.js:306-315); the MVP terrain has none, so the whole dimension collapses to `none`.",
    source: "GlobeSurfaceShaderSet.js:306",
  },
  {
    id: "imageryOps",
    values: ["none", "alpha"],
    excludedValues: [
      { value: "all", why: "brightness/contrast/hue/saturation/gamma/day-night-alpha/split/color-to-alpha are derived from `ImageryLayer` hue/saturation/brightnessShift/colorToAlpha — none of them is exposed by the MVP API (spec 'Out of Scope': imagery layer management)", source: "GlobeSurfaceTileProvider.js:2988-3158,3246-3262" },
    ],
    defines: (value) => {
      if (value === "none") return [];
      if (value === "alpha") return ["APPLY_ALPHA"];
      return ["APPLY_ALPHA", "APPLY_BRIGHTNESS", "APPLY_CONTRAST", "APPLY_HUE", "APPLY_SATURATION", "APPLY_GAMMA", "APPLY_DAY_NIGHT_ALPHA", "APPLY_SPLIT", "APPLY_COLOR_TO_ALPHA"];
    },
    justification:
      "GlobeSurfaceShaderSet.js:285-302,316-318,363-365 / GlobeSurfaceTileProvider.js:2988-3158 — `applyAlpha` is the one adjustment a plain `ImageryLayer` can carry (alpha < 1); the rest require the layer colour-correction settings the MVP does not expose.",
    source: "GlobeSurfaceShaderSet.js:285",
  },
  {
    id: "tileLimitRectangle",
    values: ["none"],
    excludedValues: [
      { value: "TILE_LIMIT_RECTANGLE", why: "`cartographicLimitRectangleDefine` is only defined when the tile provider has a cartographic limit rectangle; the MVP scene sets none", source: "GlobeSurfaceShaderSet.js:281 (option passed from GlobeSurfaceTileProvider)" },
    ],
    defines: (value) => (value === "none" ? [] : [value]),
    justification: "The MVP scene does not limit the globe to a cartographic rectangle, so the define is never pushed.",
    source: "GlobeSurfaceShaderSet.js:281",
  },
  {
    id: "geodetic",
    values: ["none", "geodetic", "exaggeration", "both"],
    excludedValues: [],
    defines: (value) => {
      if (value === "none") return [];
      if (value === "geodetic") return ["GEODETIC_SURFACE_NORMALS"];
      if (value === "exaggeration") return ["EXAGGERATION"];
      return ["GEODETIC_SURFACE_NORMALS", "EXAGGERATION"];
    },
    justification:
      "GlobeSurfaceShaderSet.js:387-393 — `hasGeodeticSurfaceNormals = encoding.hasGeodeticSurfaceNormals` and `hasExaggeration = exaggeration !== 1.0` (GlobeSurfaceTileProvider.js:2645-2646) are independent, so all four combinations are reachable; EXAGGERATION alone has no effect in the shader, which the emitter reproduces.",
    source: "GlobeSurfaceShaderSet.js:387",
  },
];

/** Defines upstream pushes unconditionally for every globe tile (`GlobeSurfaceShaderSet.js:355-356`). */
export const ALWAYS_DEFINES = ["INCLUDE_WEB_MERCATOR_Y"];

function cartesian(dimensions) {
  let combinations = [[]];
  for (const dimension of dimensions) {
    const next = [];
    for (const prefix of combinations) {
      for (const value of dimension.values) next.push([...prefix, { dimension, value }]);
    }
    combinations = next;
  }
  return combinations;
}

/** Enumerate the MVP-reachable define sets (the full cross product — no sampling, no skipping). */
export function enumerateReachableVariants() {
  const variants = [];
  for (const combination of cartesian(REACHABLE_DIMENSIONS)) {
    const selection = combination.map((entry) => ({ id: entry.dimension.id, value: entry.value }));
    const defines = [...ALWAYS_DEFINES];
    for (const entry of combination) defines.push(...entry.dimension.defines(entry.value));
    const id = selection.map((entry) => `${entry.id}=${entry.value}`).join("|");
    variants.push({ id, selection, defines, sceneMode: MVP_SCENE_MODE });
  }
  return variants;
}

/** Which stage each define goes to (`ShaderSource` keeps separate define lists per stage). */
function destinationOf(define) {
  const name = define.split(/\s+/)[0];
  return DEFINE_DESTINATION[name] ?? "both";
}

/**
 * The **witness variant** for the union varying pairing (G-6/T025 fix).
 *
 * `PER_FRAGMENT_GROUND_ATMOSPHERE` is emitted as a pipeline-overridable constant, so the module text
 * must be the same for per-vertex and per-fragment. The varying set is *derived from the real
 * assembled GLSL* and the two modes differ there — in per-fragment mode the vertex stage does not
 * compute the atmosphere scattering (`GlobeVS.js:212`) and the fragment stage does not read it
 * (`GlobeFS.js:494-509`) — so the per-fragment pairing is a strict subset of the per-vertex one.
 * The module therefore uses the **per-vertex (witness) pairing**, which is the union: both arms of the
 * override stay satisfiable, the interpolated values keep their locations, and the per-fragment
 * specialisation simply never writes or reads them (identical to the GLSL `#ifdef` behaviour).
 *
 * @returns {object|null} the same variant with that one define dropped, or `null` when it is absent.
 */
export function perVertexWitnessVariant(variant) {
  if (!variant.defines.includes("PER_FRAGMENT_GROUND_ATMOSPHERE")) return null;
  return { ...variant, defines: variant.defines.filter((define) => define !== "PER_FRAGMENT_GROUND_ATMOSPHERE") };
}

/**
 * Assemble the real GLSL for one variant through the **upstream** `ShaderSource`, including the
 * runtime-generated `computeDayColor()` (`GlobeSurfaceShaderSet.js:472` pushes it onto the
 * fragment sources) — so the assembly is a faithful superset of what the driver receives.
 *
 * @param {object} variant
 * @param {{context?: object, ShaderSourceClass?: Function, emit?: string}} [options]
 *   `ShaderSourceClass` lets the byte-identity check drive the *parameterised* class through the
 *   exact same define pushes and compare the GLSL it produces with the upstream class's text.
 */
export function assembleGlslForVariant(variant, { context = SHADER_CONTEXT_STUB, ShaderSourceClass = ShaderSource, emit = "glsl" } = {}) {
  const vertexSource = new ShaderSourceClass({ sources: BASE_SOURCES.vertex, defines: [...BASE_SOURCES.defines] }).clone();
  const fragmentSource = new ShaderSourceClass({ sources: BASE_SOURCES.fragment, defines: [...BASE_SOURCES.defines] }).clone();
  vertexSource.emit = emit;
  fragmentSource.emit = emit;
  for (const define of variant.defines) {
    const destination = destinationOf(define);
    if (destination === "vertex" || destination === "both") vertexSource.defines.push(define);
    if (destination === "fragment" || destination === "both") fragmentSource.defines.push(define);
  }
  fragmentSource.sources.push(
    emitComputeDayColorGlsl({ textureUnits: textureUnitsFromDefines(variant.defines), apply: applyFlagsFromDefines(variant.defines) }),
  );
  // `GlobeSurfaceShaderSet.js:474-475` pushes the runtime-generated position functions onto the
  // vertex sources as well; without them the assembled GLSL does not even compile in WebGL2
  // (`Function getPosition() called by main() is undefined` — found by the G-6 precision baseline).
  vertexSource.sources.push(emitGetPositionGlsl({ sceneMode: variant.sceneMode ?? "SCENE3D", useWebMercatorProjection: true }));
  return {
    vertexSource: vertexSource.createCombinedVertexShader(context),
    fragmentSource: fragmentSource.createCombinedFragmentShader(context),
  };
}
