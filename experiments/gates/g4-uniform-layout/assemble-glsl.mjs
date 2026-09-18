/**
 * G-4 gate — assemble the **real** terrain GLSL (tasks.md T018).
 *
 * The uniform layout must be generated from "**拼装后的真实 GLSL** 实际引用的 uniform 名集合"
 * (tasks.md T018), so this module drives the *upstream* shader assembler
 * (`@cesium/engine/Source/Renderer/ShaderSource.js`) with the real terrain sources and the real
 * define set — nothing here re-implements GLSL assembly:
 *
 *   1. base sources, exactly as `Scene/Globe.js:679-687` (`makeShadersDirty`) builds them:
 *      VS = `[AtmosphereCommon, GroundAtmosphere, GlobeVS]`, FS = `[AtmosphereCommon, GroundAtmosphere, GlobeFS]`,
 *      `defines = []` (MVP has no globe material ⇒ no `APPLY_MATERIAL`);
 *   2. the per-variant defines that `Scene/GlobeSurfaceShaderSet.js:278-377` pushes for a tile
 *      (`QUANTIZATION_BITS12` → VS, `TEXTURE_UNITS n` / `TILE_LIMIT_RECTANGLE` → FS, and the
 *      flag-derived ones). Every define this gate uses is traced to that source line range.
 *   3. `ShaderSource.createCombinedVertexShader(context)` / `…FragmentShader(context)` produce the
 *      exact text the GL driver would see (`#version 300 es` + `#define`s + built-in/automatic-uniform
 *      declarations + sources) — the automatic-uniform declarations come from the upstream
 *      `AutomaticUniforms` entries themselves (`getDeclaration`), which is also how the upstream
 *      assembler injects them (`ShaderSource.js:417-431`).
 *
 * Because the assembled text still contains `#ifdef`s, the *actually referenced* uniform set is
 * computed after evaluating the conditional directives for the variant's define set (a small
 * `#if/#ifdef/#ifndef/#elif/#else/#endif` evaluator that understands `defined(X)`, integers,
 * comparisons and boolean operators — the same subset Cesium's shaders use).
 *
 * Node-only, zero dependencies, cross-platform.
 */
import AutomaticUniforms from "@cesium/engine/Source/Renderer/AutomaticUniforms.js";
import ShaderSource from "@cesium/engine/Source/Renderer/ShaderSource.js";
import AtmosphereCommon from "@cesium/engine/Source/Shaders/AtmosphereCommon.js";
import GlobeFS from "@cesium/engine/Source/Shaders/GlobeFS.js";
import GlobeVS from "@cesium/engine/Source/Shaders/GlobeVS.js";
import GroundAtmosphere from "@cesium/engine/Source/Shaders/GroundAtmosphere.js";

/** The `Context` surface `ShaderSource.combineShader` reads (Context.js:86-140 equivalents). */
export const SHADER_CONTEXT_STUB = { webgl2: true, textureFloatLinear: false, floatingPointTexture: true, fragmentDepth: true };

/** Base sources exactly as `Scene/Globe.js:679-687` builds them for a material-less globe (MVP). */
export const BASE_SOURCES = {
  vertex: [AtmosphereCommon, GroundAtmosphere, GlobeVS],
  fragment: [AtmosphereCommon, GroundAtmosphere, GlobeFS],
  defines: [],
  source: "node_modules/@cesium/engine/Source/Scene/Globe.js:658-688 (makeShadersDirty, no material ⇒ defines=[])",
};

/** Terrain-unreachable-in-MVP flag defines (documented as excluded, so the matrix is auditable). */
export const EXCLUDED_DEFINES = [
  { define: "APPLY_MATERIAL", why: "MVP globe has no material (Globe.js:667-676)", source: "Globe.js:672" },
  { define: "HAS_VECTOR_LAYER", why: "vector tiles are out of scope (tasks.md Out of Scope)", source: "GlobeSurfaceShaderSet.js:396" },
  { define: "ENABLE_CLIPPING_PLANES", why: "clipping planes are out of scope", source: "GlobeSurfaceShaderSet.js:368" },
  { define: "ENABLE_CLIPPING_POLYGONS", why: "clipping polygons are out of scope", source: "GlobeSurfaceShaderSet.js:372" },
  { define: "APPLY_IMAGERY_CUTOUT", why: "MVP has no imagery layers at all", source: "GlobeSurfaceShaderSet.js:280" },
  { define: "HIGHLIGHT_FILL_TILE", why: "debug fill-tile path", source: "GlobeSurfaceShaderSet.js:384" },
  { define: "COLOR_CORRECT", why: "imagery colour correction (no imagery in MVP)", source: "GlobeSurfaceShaderSet.js:380" },
  { define: "DYNAMIC_ATMOSPHERE_LIGHTING", why: "atmosphere lighting effects are out of scope", source: "GlobeSurfaceShaderSet.js:338" },
  { define: "UNDERGROUND_COLOR", why: "underground colour is out of scope", source: "GlobeSurfaceShaderSet.js:320" },
  { define: "TRANSLUCENT", why: "translucency is out of scope for the MVP terrain slice", source: "GlobeSurfaceShaderSet.js:324" },
];

/**
 * MVP-reachable define matrix. Each `set` is a define list pushed by `GlobeSurfaceShaderSet` for a
 * real MVP configuration; the union of the referenced uniforms over the whole matrix is what the
 * generated layout MUST cover, so no reachable variant can reference an unlaid-out uniform.
 */
export const MVP_DEFINE_MATRIX = [
  {
    id: "default-1-texture",
    config: "MVP terrain default: 3D, geographic, BITS12-quantized heightmap tile, 1 texture unit, fog + ground atmosphere on, reflective ocean on",
    defines: ["QUANTIZATION_BITS12", "TEXTURE_UNITS 1", "INCLUDE_WEB_MERCATOR_Y", "TILE_LIMIT_RECTANGLE", "FOG", "GROUND_ATMOSPHERE", "HAS_WATER_MASK", "SHOW_REFLECTIVE_OCEAN"],
  },
  { id: "texture-units-0", config: "no imagery layer at all (TEXTURE_UNITS 0)", defines: ["QUANTIZATION_BITS12", "TEXTURE_UNITS 0", "INCLUDE_WEB_MERCATOR_Y", "TILE_LIMIT_RECTANGLE", "FOG", "GROUND_ATMOSPHERE"] },
  { id: "texture-units-2", config: "two imagery layers", defines: ["QUANTIZATION_BITS12", "TEXTURE_UNITS 2", "INCLUDE_WEB_MERCATOR_Y", "TILE_LIMIT_RECTANGLE", "FOG", "GROUND_ATMOSPHERE", "HAS_WATER_MASK", "SHOW_REFLECTIVE_OCEAN"] },
  { id: "texture-units-3", config: "three imagery layers", defines: ["QUANTIZATION_BITS12", "TEXTURE_UNITS 3", "INCLUDE_WEB_MERCATOR_Y", "TILE_LIMIT_RECTANGLE", "FOG", "GROUND_ATMOSPHERE", "HAS_WATER_MASK", "SHOW_REFLECTIVE_OCEAN"] },
  { id: "no-quantization", config: "non-quantized (float) terrain encoding, 1 texture unit", defines: ["TEXTURE_UNITS 1", "INCLUDE_WEB_MERCATOR_Y", "TILE_LIMIT_RECTANGLE", "FOG", "GROUND_ATMOSPHERE"] },
  { id: "ocean-waves", config: "ocean waves on (HAS_WATER_MASK + SHOW_OCEAN_WAVES)", defines: ["QUANTIZATION_BITS12", "TEXTURE_UNITS 1", "INCLUDE_WEB_MERCATOR_Y", "TILE_LIMIT_RECTANGLE", "FOG", "GROUND_ATMOSPHERE", "HAS_WATER_MASK", "SHOW_REFLECTIVE_OCEAN", "SHOW_OCEAN_WAVES"] },
  { id: "vertex-lighting", config: "globe.enableLighting with vertex normals", defines: ["QUANTIZATION_BITS12", "TEXTURE_UNITS 1", "INCLUDE_WEB_MERCATOR_Y", "TILE_LIMIT_RECTANGLE", "FOG", "GROUND_ATMOSPHERE", "ENABLE_VERTEX_LIGHTING"] },
  { id: "daynight-shading", config: "globe.enableLighting without vertex normals", defines: ["QUANTIZATION_BITS12", "TEXTURE_UNITS 1", "INCLUDE_WEB_MERCATOR_Y", "TILE_LIMIT_RECTANGLE", "FOG", "GROUND_ATMOSPHERE", "ENABLE_DAYNIGHT_SHADING"] },
  { id: "no-fog-no-atmosphere", config: "fog and ground atmosphere disabled", defines: ["QUANTIZATION_BITS12", "TEXTURE_UNITS 1", "INCLUDE_WEB_MERCATOR_Y", "TILE_LIMIT_RECTANGLE"] },
  { id: "per-fragment-atmosphere", config: "per-fragment ground atmosphere", defines: ["QUANTIZATION_BITS12", "TEXTURE_UNITS 1", "INCLUDE_WEB_MERCATOR_Y", "TILE_LIMIT_RECTANGLE", "GROUND_ATMOSPHERE", "PER_FRAGMENT_GROUND_ATMOSPHERE"] },
  { id: "apply-alpha", config: "imagery layer alpha blending", defines: ["QUANTIZATION_BITS12", "TEXTURE_UNITS 2", "INCLUDE_WEB_MERCATOR_Y", "TILE_LIMIT_RECTANGLE", "APPLY_ALPHA", "APPLY_BRIGHTNESS", "APPLY_CONTRAST"] },
  { id: "geodetic-normals-exaggeration", config: "geodetic surface normals + terrain exaggeration", defines: ["QUANTIZATION_BITS12", "TEXTURE_UNITS 1", "INCLUDE_WEB_MERCATOR_Y", "TILE_LIMIT_RECTANGLE", "GEODETIC_SURFACE_NORMALS", "EXAGGERATION"] },
  { id: "scene2d", config: "2D / Columbus-view projection (mercator y from the layer)", defines: ["QUANTIZATION_BITS12", "TEXTURE_UNITS 1", "TILE_LIMIT_RECTANGLE", "FOG", "GROUND_ATMOSPHERE"] },
];

/** Count of automatic uniforms declared by the upstream module (T018 mentions 92). */
export function automaticUniformCount() {
  return Object.keys(AutomaticUniforms).length;
}

// ------------------------------------------------------------------------------------------------
// conditional-directive evaluator (#ifdef / #ifndef / #if / #elif / #else / endif)
// ------------------------------------------------------------------------------------------------

function defineMap(defines) {
  const map = new Map();
  for (const define of defines) {
    const [name, ...rest] = String(define).trim().split(/\s+/);
    map.set(name, rest.join(" "));
  }
  return map;
}

function evaluateCondition(expression, defines) {
  const js = String(expression)
    // defined(X) / defined X
    .replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_all, name) => (defines.has(name) ? "1" : "0"))
    .replace(/defined\s+([A-Za-z_]\w*)/g, (_all, name) => (defines.has(name) ? "1" : "0"))
    // identifiers that are not defined macros evaluate to 0 (GLSL preprocessor behaviour)
    .replace(/\b([A-Za-z_]\w*)\b/g, (all, name) => (defines.has(name) ? `(${defines.get(name) || "1"})` : "0"))
    .replace(/&&/g, "&&")
    .replace(/\|\|/g, "||");
  try {
    // eslint-disable-next-line no-new-func -- sandboxed: the expression only contains digits/operators
    return new Function(`"use strict"; return (${js}) ? 1 : 0;`)() === 1;
  } catch {
    return false;
  }
}

/**
 * Mark which lines of an assembled shader are active for a define set.
 * @returns {boolean[]} `active[i] === true` when line `i` survives preprocessing
 */
export function activeLines(source, defines) {
  const defineValues = defineMap(defines);
  // `#define` directives inside the shader itself also take part (there are none in these sources,
  // but the evaluator stays honest about it).
  const active = new Array(source.split("\n").length).fill(true);
  const stack = [];
  let current = true;
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    const match = /^\s*#\s*(ifdef|ifndef|if|elif|else|endif)\b(.*)$/.exec(line);
    if (match === null) {
      active[index] = current;
      return;
    }
    const [, directive, rest] = match;
    if (directive === "ifdef" || directive === "ifndef" || directive === "if") {
      const parent = current;
      let condition;
      if (directive === "ifdef") condition = defineValues.has(rest.trim());
      else if (directive === "ifndef") condition = !defineValues.has(rest.trim());
      else condition = evaluateCondition(rest, defineValues);
      stack.push({ parent, taken: condition, any: condition });
      current = parent && condition;
      active[index] = false;
      return;
    }
    if (directive === "elif") {
      const frame = stack[stack.length - 1];
      const condition = !frame.any && evaluateCondition(rest, defineValues);
      frame.taken = condition;
      frame.any = frame.any || condition;
      current = frame.parent && condition;
      active[index] = false;
      return;
    }
    if (directive === "else") {
      const frame = stack[stack.length - 1];
      const condition = !frame.any;
      frame.taken = condition;
      frame.any = true;
      current = frame.parent && condition;
      active[index] = false;
      return;
    }
    // endif
    const frame = stack.pop();
    current = frame === undefined ? current : frame.parent;
    active[index] = false;
    if (defineValues.size >= 0) {
      const definition = /^\s*#\s*define\s+([A-Za-z_]\w*)\s*(.*)$/.exec(line);
      if (definition !== null && current) defineValues.set(definition[1], definition[2]);
    }
  });
  return active;
}

// ------------------------------------------------------------------------------------------------
// uniform collection
// ------------------------------------------------------------------------------------------------

const DECLARATION = /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[\s*([A-Za-z_0-9\s+*/-]+?)\s*\])?\s*;/;

function arraySize(expression, defines) {
  if (expression === undefined) return 1;
  const trimmed = expression.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const defineValues = defineMap(defines);
  const substituted = trimmed.replace(/\b([A-Za-z_]\w*)\b/g, (all, name) => (defineValues.has(name) ? defineValues.get(name) || "0" : all));
  const value = Number(substituted);
  return Number.isFinite(value) ? value : null;
}

/**
 * Collect the uniforms a single assembled shader stage actually declares (with its conditionals
 * evaluated) — this is the set the GL driver would receive declarations for.
 */
export function collectDeclaredUniforms(source, defines) {
  const active = activeLines(source, defines);
  const lines = source.split("\n");
  const found = new Map();
  lines.forEach((line, index) => {
    if (active[index] !== true) return;
    const match = DECLARATION.exec(line);
    if (match === null) return;
    const [, glslType, name, sizeExpression] = match;
    const size = arraySize(sizeExpression, defines);
    found.set(name, { name, glslType, size, declaration: line.trim(), origin: AutomaticUniforms[name] !== undefined ? "automatic" : "shader" });
  });
  return found;
}

/** Identifiers the *active* code references (used to check that a declared uniform is really used). */
export function collectReferencedIdentifiers(source, defines) {
  const active = activeLines(source, defines);
  const lines = source.split("\n");
  const referenced = new Set();
  lines.forEach((line, index) => {
    if (active[index] !== true) return;
    for (const match of line.matchAll(/\b([A-Za-z_]\w*)\b/g)) referenced.add(match[1]);
  });
  return referenced;
}

/** Assemble one variant through the upstream `ShaderSource`. */
export function assembleVariant(variant, { context = SHADER_CONTEXT_STUB, sources = null } = {}) {
  const base = sources ?? BASE_SOURCES;
  const vertexSource = new ShaderSource({ sources: base.vertex, defines: [...(base.defines ?? [])] }).clone();
  const fragmentSource = new ShaderSource({ sources: base.fragment, defines: [...(base.defines ?? [])] }).clone();
  // GlobeSurfaceShaderSet.js:278-369 pushes the per-tile defines onto the cloned sources.
  for (const define of variant.defines) {
    if (define === "QUANTIZATION_BITS12" || define === "GEODETIC_SURFACE_NORMALS" || define === "EXAGGERATION" || define === "ENABLE_VERTEX_LIGHTING" || define === "ENABLE_DAYNIGHT_SHADING" || define === "SHOW_REFLECTIVE_OCEAN" || define === "GROUND_ATMOSPHERE" || define === "PER_FRAGMENT_GROUND_ATMOSPHERE" || define === "FOG" || define === "INCLUDE_WEB_MERCATOR_Y") {
      vertexSource.defines.push(define);
    }
    fragmentSource.defines.push(define);
  }
  const vertex = vertexSource.createCombinedVertexShader(context);
  const fragment = fragmentSource.createCombinedFragmentShader(context);

  const declared = new Map();
  for (const stage of [vertex, fragment]) {
    for (const [name, entry] of collectDeclaredUniforms(stage, variant.defines)) {
      const existing = declared.get(name);
      if (existing === undefined) declared.set(name, entry);
      else if (existing.glslType !== entry.glslType || existing.size !== entry.size) {
        throw new Error(`g4: uniform "${name}" is declared with conflicting types (${existing.glslType}[${existing.size}] vs ${entry.glslType}[${entry.size}])`);
      }
    }
  }
  const referenced = new Set([...collectReferencedIdentifiers(vertex, variant.defines), ...collectReferencedIdentifiers(fragment, variant.defines)]);
  const uniforms = [...declared.values()].filter((entry) => referenced.has(entry.name));

  return {
    id: variant.id,
    config: variant.config,
    defines: variant.defines,
    vertexBytes: vertex.length,
    fragmentBytes: fragment.length,
    declaredCount: declared.size,
    referencedCount: uniforms.length,
    uniforms,
    // A declared-but-unreferenced uniform needs no layout slot; keep it visible as evidence.
    declaredButUnreferenced: [...declared.values()].filter((entry) => !referenced.has(entry.name)).map((entry) => entry.name).sort(),
    samplerNames: uniforms.filter((entry) => /^sampler/.test(entry.glslType)).map((entry) => entry.name).sort(),
  };
}

/** Assemble every variant of the MVP matrix and compute the union of the referenced uniforms. */
export function assembleMatrix({ context = SHADER_CONTEXT_STUB } = {}) {
  const variants = MVP_DEFINE_MATRIX.map((variant) => assembleVariant(variant, { context }));
  const union = new Map();
  const inconsistencies = [];
  for (const variant of variants) {
    for (const entry of variant.uniforms) {
      const existing = union.get(entry.name);
      if (existing === undefined) union.set(entry.name, { ...entry, variants: [variant.id] });
      else {
        existing.variants.push(variant.id);
        if (existing.glslType !== entry.glslType || existing.size !== entry.size) inconsistencies.push({ name: entry.name, variant: variant.id, expected: `${existing.glslType}[${existing.size}]`, actual: `${entry.glslType}[${entry.size}]` });
      }
    }
  }
  const defaultVariant = variants.find((variant) => variant.id === MVP_DEFINE_MATRIX[0].id);
  return {
    automaticUniformCount: automaticUniformCount(),
    baseSources: BASE_SOURCES,
    context,
    variants,
    union: [...union.values()].sort((a, b) => a.name.localeCompare(b.name)),
    inconsistencies,
    defaultVariant,
  };
}
