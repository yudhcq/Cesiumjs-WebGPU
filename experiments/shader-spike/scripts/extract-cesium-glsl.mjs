/**
 * Spike S1: recover the EXACT GLSL that CesiumJS 1.145.0 hands to gl.compileShader
 * for the globe terrain shader, by running Cesium's own assembly code
 * (ShaderSource + Globe.makeShadersDirty + GlobeSurfaceShaderSet.getShaderProgram)
 * in plain Node — no browser, no WebGL context required.
 *
 * Usage:
 *   node extract-cesium-glsl.mjs            (module root read from CZM_ROOT or $TEMP/shader-spike)
 *
 * Outputs into ../glsl/ : *.vert.glsl / *.frag.glsl plus a manifest JSON with stats.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "glsl");
const ENGINE =
  process.env.CZM_ROOT ??
  path.join(os.tmpdir(), "shader-spike", "node_modules", "@cesium", "engine");

const imp = (rel) => import(pathToFileURL(path.join(ENGINE, rel)).href);

const ShaderSource = (await imp("Source/Renderer/ShaderSource.js")).default;
const GlobeVS = (await imp("Source/Shaders/GlobeVS.js")).default;
const GlobeFS = (await imp("Source/Shaders/GlobeFS.js")).default;
const AtmosphereCommon = (
  await imp("Source/Shaders/AtmosphereCommon.js")
).default;
const GroundAtmosphere = (
  await imp("Source/Shaders/GroundAtmosphere.js")
).default;
const VectorCommon = (await imp("Source/Shaders/VectorCommon.js")).default;

// Simulated WebGL2 context capabilities; the only fields combineShader() reads.
// (ShaderSource.js:245,261,266,282,297)
const CTX = {
  webgl2: true,
  textureFloatLinear: true,
  floatingPointTexture: true,
};

/** Replicates Globe.js:658-689 makeShadersDirty() with no custom material. */
function baseSources() {
  return {
    vs: new ShaderSource({
      sources: [AtmosphereCommon, GroundAtmosphere, GlobeVS],
      defines: [],
    }),
    fs: new ShaderSource({
      sources: [AtmosphereCommon, GroundAtmosphere, GlobeFS],
      defines: [],
    }),
  };
}

/**
 * Replicates GlobeSurfaceShaderSet.prototype.getShaderProgram (lines 268-482)
 * for the given flag set. Every push is at the cited source line.
 */
function assemble(cfg) {
  const { vs, fs } = baseSources();

  // vs.defines.push(quantizationDefine)  (L278); quantizationDefine comes from
  // terrainEncoding.getQuantizationDefine() -> '' unless quantized-mesh terrain.
  // QUANTIZATION_BITS12 also renames the vertex attributes (GlobeVS.glsl:1-7).
  if (cfg.quantization) {
    vs.defines.push("QUANTIZATION_BITS12");
  }
  // fs.defines.push(TEXTURE_UNITS n, cartographicLimitRectangleDefine, imageryCutoutDefine) L279-283
  fs.defines.push(`TEXTURE_UNITS ${cfg.textureUnits}`);
  if (cfg.hasImageryLayerCutout) {
    fs.defines.push("HAS_IMAGERY_LAYER_CUTOUT");
  }
  const pairs = [
    ["applyDayNightAlpha", "APPLY_DAY_NIGHT_ALPHA", "fs"],
    ["applyAlpha", "APPLY_ALPHA", "fs"],
    ["applySplit", "APPLY_SPLIT", "fs"],
    ["hasWaterMask", "HAS_WATER_MASK", "fs"],
    ["showOceanWaves", "SHOW_OCEAN_WAVES", "fs"],
    ["colorToAlpha", "APPLY_COLOR_TO_ALPHA", "fs"],
    ["showUndergroundColor", "UNDERGROUND_COLOR", "both"],
    ["translucent", "TRANSLUCENT", "both"],
    ["dynamicAtmosphereLightingFromSun", "DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN", "both"],
    ["perFragmentGroundAtmosphere", "PER_FRAGMENT_GROUND_ATMOSPHERE", "both"],
    ["enableClippingPlanes", "ENABLE_CLIPPING_PLANES", "fs"],
    ["clippingInverse", "CLIPPING_INVERSE", "fs"],
    ["colorCorrect", "COLOR_CORRECT", "fs"],
    ["highlightFillTile", "HIGHLIGHT_FILL_TILE", "fs"],
    ["hasGeodeticSurfaceNormals", "GEODETIC_SURFACE_NORMALS", "vs"],
    ["hasExaggeration", "EXAGGERATION", "vs"],
  ];
  for (const [key, define, where] of pairs) {
    if (!cfg[key]) continue;
    if (where === "vs" || where === "both") vs.defines.push(define);
    if (where === "fs" || where === "both") fs.defines.push(define);
  }
  if (cfg.showReflectiveOcean) {
    fs.defines.push("SHOW_REFLECTIVE_OCEAN");
    vs.defines.push("SHOW_REFLECTIVE_OCEAN");
  }
  if (cfg.enableLighting) {
    const d = cfg.hasVertexNormals ? "ENABLE_VERTEX_LIGHTING" : "ENABLE_DAYNIGHT_SHADING";
    vs.defines.push(d);
    fs.defines.push(d);
  }
  if (cfg.dynamicAtmosphereLighting) {
    vs.defines.push("DYNAMIC_ATMOSPHERE_LIGHTING");
    fs.defines.push("DYNAMIC_ATMOSPHERE_LIGHTING");
  }
  if (cfg.showGroundAtmosphere) {
    vs.defines.push("GROUND_ATMOSPHERE");
    fs.defines.push("GROUND_ATMOSPHERE");
  }
  // vs.defines.push("INCLUDE_WEB_MERCATOR_Y") L355
  if (cfg.useWebMercatorProjection) {
    vs.defines.push("INCLUDE_WEB_MERCATOR_Y");
    fs.defines.push("INCLUDE_WEB_MERCATOR_Y");
  }
  if (cfg.enableFog) {
    vs.defines.push("FOG");
    fs.defines.push("FOG");
  }
  if (cfg.hasVectorLayer || cfg.enableClippingPolygons) {
    fs.sources.unshift(VectorCommon); // L416
  }
  if (cfg.enableClippingPolygons) fs.defines.push("ENABLE_CLIPPING_POLYGONS");

  // L419-472: synthesised computeDayColor()
  let computeDayColor =
    "vec4 computeDayColor(vec4 initialColor, vec3 textureCoordinates, float nightBlend)\n{\n    vec4 color = initialColor;\n";
  for (let i = 0; i < cfg.textureUnits; ++i) {
    computeDayColor += cfg.hasImageryLayerCutout
      ? `    vec4 cutoutAndColorResult;\n    bool texelUnclipped;\n    cutoutAndColorResult = u_dayTextureCutoutRectangles[${i}];\n    texelUnclipped = v_textureCoordinates.x < cutoutAndColorResult.x || cutoutAndColorResult.z < v_textureCoordinates.x || v_textureCoordinates.y < cutoutAndColorResult.y || cutoutAndColorResult.w < v_textureCoordinates.y;\n    cutoutAndColorResult = sampleAndBlend(\n`
      : "    color = sampleAndBlend(\n";
    computeDayColor += `        color,\n        u_dayTextures[${i}],\n        u_dayTextureUseWebMercatorT[${i}] ? textureCoordinates.xz : textureCoordinates.xy,\n        u_dayTextureTexCoordsRectangle[${i}],\n        u_dayTextureTranslationAndScale[${i}],\n        ${cfg.applyAlpha ? `u_dayTextureAlpha[${i}]` : "1.0"},\n        ${cfg.applyDayNightAlpha ? `u_dayTextureNightAlpha[${i}]` : "1.0"},\n        ${cfg.applyDayNightAlpha ? `u_dayTextureDayAlpha[${i}]` : "1.0"},\n        ${cfg.applyBrightness ? `u_dayTextureBrightness[${i}]` : "0.0"},\n        ${cfg.applyContrast ? `u_dayTextureContrast[${i}]` : "0.0"},\n        ${cfg.applyHue ? `u_dayTextureHue[${i}]` : "0.0"},\n        ${cfg.applySaturation ? `u_dayTextureSaturation[${i}]` : "0.0"},\n        ${cfg.applyGamma ? `u_dayTextureOneOverGamma[${i}]` : "0.0"},\n        ${cfg.applySplit ? `u_dayTextureSplit[${i}]` : "0.0"},\n        ${cfg.colorToAlpha ? `u_colorsToAlpha[${i}]` : "vec4(0.0)"},\n        nightBlend);\n`;
    if (cfg.hasImageryLayerCutout) {
      computeDayColor +=
        "    color = czm_branchFreeTernary(texelUnclipped, cutoutAndColorResult, color);\n";
    }
  }
  computeDayColor += "    return color;\n}";
  fs.sources.push(computeDayColor); // L472

  // vs.sources.push(getPositionMode(sceneMode)); vs.sources.push(get2DYPositionFraction(...)) L474-475
  const positionModes = {
    SCENE3D:
      "vec4 getPosition(vec3 position, float height, vec2 textureCoordinates) { return getPosition3DMode(position, height, textureCoordinates); }",
    COLUMBUS_VIEW:
      "vec4 getPosition(vec3 position, float height, vec2 textureCoordinates) { return getPositionColumbusViewMode(position, height, textureCoordinates); }",
  };
  vs.sources.push(positionModes[cfg.sceneMode ?? "SCENE3D"]);
  vs.sources.push(
    cfg.useWebMercatorProjection
      ? "float get2DYPositionFraction(vec2 textureCoordinates) { return get2DMercatorYPositionFraction(textureCoordinates); }"
      : "float get2DYPositionFraction(vec2 textureCoordinates) { return get2DGeographicYPositionFraction(textureCoordinates); }",
  );

  const attributeLocations = cfg.quantization
    ? { compressed0: 0, compressed1: 1 }
    : { position3DAndHeight: 0, textureCoordAndEncodedNormals: 1 };

  return {
    glsl: {
      vertex: vs.createCombinedVertexShader(CTX),
      fragment: fs.createCombinedFragmentShader(CTX),
    },
    defines: { vertex: vs.defines.slice(), fragment: fs.defines.slice() },
    sources: {
      vertex: vs.sources.map((s) => s.slice(0, 40)),
      fragment: fs.sources.map((s) => s.slice(0, 40)),
    },
    attributeLocations,
  };
}

const CASES = {
  // Cesium Sandcastle default-ish: 3D, one imagery layer, lighting, ground atmosphere.
  "default-3d": {
    textureUnits: 1, quantization: false, sceneMode: "SCENE3D",
    enableLighting: true, hasVertexNormals: false,
    showGroundAtmosphere: true, perFragmentGroundAtmosphere: false,
    useWebMercatorProjection: true, enableFog: false,
    dynamicAtmosphereLighting: true, dynamicAtmosphereLightingFromSun: true,
  },
  // The heavier real-world terrain config: quantized-mesh terrain, vertex lighting,
  // fog, geeodetic normals, exaggeration, translucency, clipping planes.
  "kitchen-sink": {
    textureUnits: 4, quantization: true, sceneMode: "SCENE3D",
    enableLighting: true, hasVertexNormals: true,
    showGroundAtmosphere: true, perFragmentGroundAtmosphere: true,
    useWebMercatorProjection: true, enableFog: true,
    dynamicAtmosphereLighting: true, dynamicAtmosphereLightingFromSun: true,
    hasGeodeticSurfaceNormals: true, hasExaggeration: true,
    translucent: true, enableClippingPlanes: true, applyAlpha: true,
    showReflectiveOcean: true, hasWaterMask: true, colorToAlpha: true,
  },
  // Smallest realistic vertex shader: no atmosphere, no mercator, heightmap terrain.
  "minimal-3d": {
    textureUnits: 1, quantization: false, sceneMode: "SCENE3D",
    enableLighting: false, useWebMercatorProjection: false,
  },
};

fs.mkdirSync(OUT, { recursive: true });
const manifest = {};
for (const [name, cfg] of Object.entries(CASES)) {
  const r = assemble(cfg);
  for (const stage of ["vertex", "fragment"]) {
    const file = `${name}.${stage === "vertex" ? "vert" : "frag"}.glsl`;
    fs.writeFileSync(path.join(OUT, file), r.glsl[stage], "utf8");
  }
  manifest[name] = {
    cfg,
    defines: r.defines,
    lines: {
      vertex: r.glsl.vertex.split("\n").length,
      fragment: r.glsl.fragment.split("\n").length,
    },
    bytes: {
      vertex: Buffer.byteLength(r.glsl.vertex),
      fragment: Buffer.byteLength(r.glsl.fragment),
    },
    attributeLocations: r.attributeLocations,
  };
  console.log(
    `${name}: vs ${r.glsl.vertex.split("\n").length} lines / fs ${r.glsl.fragment.split("\n").length} lines`,
  );
  console.log(`  vs defines: ${r.defines.vertex.join(" ")}`);
  console.log(`  fs defines: ${r.defines.fragment.join(" ")}`);
}
fs.writeFileSync(
  path.join(OUT, "manifest.json"),
  JSON.stringify(
    { engine: ENGINE, cesiumVersion: "1.145.0", ctx: CTX, cases: manifest },
    null,
    2,
  ),
);
console.log(`\nwrote ${OUT}`);
