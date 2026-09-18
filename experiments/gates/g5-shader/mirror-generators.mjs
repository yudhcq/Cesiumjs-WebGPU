/**
 * G-5 gate — **mirror generators** for the shader fragments upstream produces at runtime
 * (contract R6 of `specs/001-webgpu-terrain-mvp/contracts/fork-patch-layer.md`).
 *
 * Two fragments of the terrain shaders exist in **no** `.glsl` on disk and are built as strings by
 * `Scene/GlobeSurfaceShaderSet.js`:
 *
 *   - `computeDayColor()`  (`:419-472`) — the per-texture blend chain, unrolled over
 *     `numberOfDayTextures` and parameterised by the `APPLY_*` flags;
 *   - `getPosition()` / `get2DYPositionFraction()` (`:474-475, 529-568`) — selected by scene mode
 *     and by whether the layer uses the Web-Mercator projection. (`getPosition` is reproduced in
 *     `wgsl/terrain-vs.wgsl` by the same three-way choice, driven by the `POSITION_MODE_*` /
 *     `Y_FRACTION_*` defines this module emits.)
 *
 * `emitComputeDayColorGlsl` is a byte-faithful reproduction of the upstream string builder, used to
 * assemble the *real* GLSL the driver would see; `emitComputeDayColorWgsl` is its WGSL mirror.
 * Keeping both in one module is the point: the two emissions cannot drift apart silently.
 */

/** Upstream `GlobeSurfaceShaderSet.js:419-472` — the exact GLSL string builder. */
export function emitComputeDayColorGlsl({ textureUnits, apply = {} }) {
  let source = "      vec4 computeDayColor(vec4 initialColor, vec3 textureCoordinates, float nightBlend)\n{\n    vec4 color = initialColor;\n";
  for (let i = 0; i < textureUnits; i += 1) {
    source += "    color = sampleAndBlend(\n";
    source += `        color,\n        u_dayTextures[${i}],\n        u_dayTextureUseWebMercatorT[${i}] ? textureCoordinates.xz : textureCoordinates.xy,\n`;
    source += `        u_dayTextureTexCoordsRectangle[${i}],\n        u_dayTextureTranslationAndScale[${i}],\n`;
    source += `        ${apply.alpha ? `u_dayTextureAlpha[${i}]` : "1.0"},\n`;
    source += `        ${apply.dayNightAlpha ? `u_dayTextureNightAlpha[${i}]` : "1.0"},\n`;
    source += `        ${apply.dayNightAlpha ? `u_dayTextureDayAlpha[${i}]` : "1.0"},\n`;
    source += `        ${apply.brightness ? `u_dayTextureBrightness[${i}]` : "0.0"},\n`;
    source += `        ${apply.contrast ? `u_dayTextureContrast[${i}]` : "0.0"},\n`;
    source += `        ${apply.hue ? `u_dayTextureHue[${i}]` : "0.0"},\n`;
    source += `        ${apply.saturation ? `u_dayTextureSaturation[${i}]` : "0.0"},\n`;
    source += `        ${apply.gamma ? `u_dayTextureOneOverGamma[${i}]` : "0.0"},\n`;
    source += `        ${apply.split ? `u_dayTextureSplit[${i}]` : "0.0"},\n`;
    source += `        ${apply.colorToAlpha ? `u_colorsToAlpha[${i}]` : "vec4(0.0)"},\n`;
    source += "        nightBlend);\n";
  }
  source += "    return color;\n}";
  return source;
}

/**
 * WGSL mirror of the same fragment.
 *
 * WGSL-forced differences (declared, no silent change):
 *   - `u_dayTextures[i]` (a `sampler2D[]` indexed at runtime) becomes the explicit
 *     `(u_dayTextures_<i>_texture, u_dayTextures_<i>_sampler)` pair per element
 *     (spike REPORT §6.4 ① / contract R2 of G-4's layout generator);
 *   - the GLSL `bool` uniform `u_dayTextureUseWebMercatorT[i]` is stored as `u32` (H-4), so the
 *     ternary becomes `select(xy, xz, … != 0u)`;
 *   - `gl_FragCoord.x` (used by `APPLY_SPLIT` inside `sampleAndBlend`) is passed in explicitly.
 *
 * **`TEXTURE_UNITS` is not a define here** (G-6/T025 fix). The tile's imagery layer count changes
 * *inside one session* (a layer streams in), so building it into the module text means recompiling a
 * ~33 kB module every time it changes — measured at 110.5 ms p50 per variant (G-6 first run).
 * `numberOfDayTextures` is therefore a **pipeline-overridable constant** and the chain is emitted
 * once at its maximum length with one guard per step: the module text is the same for 0, 1, 2 and 3
 * layers, and a new layer count is a `createRenderPipeline` on the already-parsed module instead of a
 * new module. The guards are pipeline constants, so the unreachable steps are eliminated at
 * pipeline-creation time and cost nothing at runtime — the observable behaviour is identical to the
 * unrolled builder above (steps 0..n-1 execute, exactly like the GLSL loop).
 *
 * @param {{maxTextureUnits: number, apply?: object, access: (name: string, index: number) => string}} input
 *   `maxTextureUnits` = the number of `u_dayTextures` bindings the union layout declares; the chain can
 *   never exceed it. `access` renders one uniform read **through the H-4 layout table** — a padded
 *   (16-byte widened) array element is a `vec4<T>` whose only meaningful lane is `.x`, and the emitter
 *   derives that suffix from the table instead of hard-coding it here.
 */
export function emitComputeDayColorWgsl({ maxTextureUnits, apply = {}, access = (name, index) => `czm.${name}[${index}]` }) {
  const lines = [
    "// Mirror of `GlobeSurfaceShaderSet.js:419-472` (`computeDayColor`), emitted by",
    "// experiments/gates/g5-shader/mirror-generators.mjs.",
    "//",
    "// `TEXTURE_UNITS` is a pipeline-overridable constant (`numberOfDayTextures`) here, not a",
    "// preprocessor define: the chain is emitted once at its maximum length and every step is guarded,",
    "// so the module text does not depend on the tile's imagery layer count. A new layer count is a",
    "// pipeline specialisation on the same parsed module, never a new module (G-6/T025).",
    "fn computeDayColor(initialColor: vec4<f32>, textureCoordinates: vec3<f32>, nightBlend: f32, fragCoordX: f32) -> vec4<f32> {",
    "  var color = initialColor;",
  ];
  const step = (body) => body.map((line) => (line.length === 0 ? line : `  ${line}`));
  for (let i = 0; i < maxTextureUnits; i += 1) {
    lines.push(`  if (numberOfDayTextures > ${i}u) {`);
    lines.push(
      ...step([
        "color = sampleAndBlend(",
        "  color,",
        `  u_dayTextures_${i}_texture,`,
        `  u_dayTextures_${i}_sampler,`,
        `  select(textureCoordinates.xy, textureCoordinates.xz, ${access("u_dayTextureUseWebMercatorT", i)} != 0u),`,
        `  ${access("u_dayTextureTexCoordsRectangle", i)},`,
        `  ${access("u_dayTextureTranslationAndScale", i)},`,
        `  ${apply.alpha ? access("u_dayTextureAlpha", i) : "1.0"},`,
        `  ${apply.dayNightAlpha ? access("u_dayTextureNightAlpha", i) : "1.0"},`,
        `  ${apply.dayNightAlpha ? access("u_dayTextureDayAlpha", i) : "1.0"},`,
        `  ${apply.brightness ? access("u_dayTextureBrightness", i) : "0.0"},`,
        `  ${apply.contrast ? access("u_dayTextureContrast", i) : "0.0"},`,
        `  ${apply.hue ? access("u_dayTextureHue", i) : "0.0"},`,
        `  ${apply.saturation ? access("u_dayTextureSaturation", i) : "0.0"},`,
        `  ${apply.gamma ? access("u_dayTextureOneOverGamma", i) : "0.0"},`,
        `  ${apply.split ? access("u_dayTextureSplit", i) : "0.0"},`,
        `  ${apply.colorToAlpha ? access("u_colorsToAlpha", i) : "vec4<f32>(0.0)"},`,
        "  nightBlend,",
        "  fragCoordX,",
        ");",
      ]),
    );
    lines.push("  }");
  }
  lines.push("  return color;", "}");
  return lines.join("\n");
}

/**
 * Upstream `GlobeSurfaceShaderSet.js:474-475,529-568` — `getPosition()` and `get2DYPositionFraction()`
 * are pushed onto the **vertex** sources at runtime, selected by scene mode and by whether the layer
 * uses the Web-Mercator projection. They exist in no `.glsl` on disk, so both the GLSL assembly used
 * by the gate and the WGSL emission have to reproduce them.
 */
export function emitGetPositionGlsl({ sceneMode = "SCENE3D", useWebMercatorProjection = true } = {}) {
  const position =
    sceneMode === "SCENE3D"
      ? "vec4 getPosition(vec3 position, float height, vec2 textureCoordinates) { return getPosition3DMode(position, height, textureCoordinates); }"
      : sceneMode === "MORPHING"
        ? "vec4 getPosition(vec3 position, float height, vec2 textureCoordinates) { return getPositionMorphingMode(position, height, textureCoordinates); }"
        : "vec4 getPosition(vec3 position, float height, vec2 textureCoordinates) { return getPositionColumbusViewMode(position, height, textureCoordinates); }";
  const fraction = useWebMercatorProjection
    ? "float get2DYPositionFraction(vec2 textureCoordinates) { return get2DMercatorYPositionFraction(textureCoordinates); }"
    : "float get2DYPositionFraction(vec2 textureCoordinates) { return get2DGeographicYPositionFraction(textureCoordinates); }";
  return `${position}\n${fraction}`;
}

/** The `APPLY_*` flags derived from a define list — one source of truth for both emissions. */
export function applyFlagsFromDefines(defines) {
  const has = (name) => defines.some((define) => define === name || define.startsWith(`${name} `));
  return {
    alpha: has("APPLY_ALPHA"),
    dayNightAlpha: has("APPLY_DAY_NIGHT_ALPHA"),
    split: has("APPLY_SPLIT"),
    brightness: has("APPLY_BRIGHTNESS"),
    contrast: has("APPLY_CONTRAST"),
    hue: has("APPLY_HUE"),
    saturation: has("APPLY_SATURATION"),
    gamma: has("APPLY_GAMMA"),
    colorToAlpha: has("APPLY_COLOR_TO_ALPHA"),
  };
}

/** `TEXTURE_UNITS n` → n (0 when the define is absent, which is what upstream's `#if` does). */
export function textureUnitsFromDefines(defines) {
  for (const define of defines) {
    const match = /^TEXTURE_UNITS\s+(\d+)$/.exec(define);
    if (match !== null) return Number(match[1]);
  }
  return 0;
}
