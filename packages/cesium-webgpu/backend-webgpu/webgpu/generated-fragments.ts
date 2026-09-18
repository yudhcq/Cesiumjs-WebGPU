/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * **Runtime fragment mirror generators** (tasks.md **T071**; contract fork-patch-layer §5 rule
 * **R6**; data-model §4.5 `GeneratedFragmentMirror`).
 *
 * Two fragments of the terrain shaders exist in **no** `.glsl` on disk and are built as strings by
 * `Scene/GlobeSurfaceShaderSet.js` at scene-construction time:
 *
 *   - `computeDayColor()`  (`:419-472`) — the per-texture blend chain, unrolled over
 *     `numberOfDayTextures` and parameterised by the `APPLY_*` flags;
 *   - `getPosition()` / `get2DYPositionFraction()` (`:474-475, 529-568`) — selected by scene mode
 *     and by whether the layer uses the Web-Mercator projection. Both exist in no `.glsl`, which is
 *     why the G-5 baseline found that the *upstream* assembled GLSL does not even compile in WebGL2
 *     without them (`Function getPosition() called by main() is undefined`).
 *
 * The GLSL builder and its WGSL mirror live in **one module on purpose**: the two emissions cannot
 * drift apart silently, and the emitter's `access` parameter is derived from the bind-layout table
 * so the module text and the CPU-side writer cannot disagree either.
 *
 * **Coverage is counted over reachable parameter combinations** (R6): `coverage()` enumerates
 * `textureUnits ∈ {0..3}` × the nine `APPLY_*` flags and reports, for every combination, whether the
 * mirror could be produced; an unreachable/unhandled combination is a failure, never a skip.
 *
 * Ported from the verified G-5 gate implementation
 * (`experiments/gates/g5-shader/mirror-generators.mjs`).
 *
 * Zero dependencies, cross-platform, no `node:` import.
 */
import type { DefineList } from "./glsl-preprocess.js";

/** The `APPLY_*` flags `computeDayColor()` is parameterised by (`GlobeSurfaceShaderSet.js:285-318`). */
export interface ApplyFlags {
  readonly alpha: boolean;
  readonly dayNightAlpha: boolean;
  readonly split: boolean;
  readonly brightness: boolean;
  readonly contrast: boolean;
  readonly hue: boolean;
  readonly saturation: boolean;
  readonly gamma: boolean;
  readonly colorToAlpha: boolean;
}

/** `data-model §4.5 GeneratedFragmentMirror.generator`. */
export type GeneratedFragmentKind = "computeDayColor" | "getPosition" | "get2DYPositionFraction";

/** `data-model §4.5 GeneratedFragmentMirror`. */
export interface GeneratedFragmentMirror {
  readonly generator: GeneratedFragmentKind;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  /** The upstream source of truth for this generator. */
  readonly upstream: string;
}

/** Upstream `GlobeSurfaceShaderSet.js:419-472` — the exact GLSL string builder, byte for byte. */
export function emitComputeDayColorGlsl({ textureUnits, apply }: { textureUnits: number; apply: Partial<ApplyFlags> }): string {
  let source = "      vec4 computeDayColor(vec4 initialColor, vec3 textureCoordinates, float nightBlend)\n{\n    vec4 color = initialColor;\n";
  for (let i = 0; i < textureUnits; i += 1) {
    source += "    color = sampleAndBlend(\n";
    source += `        color,\n        u_dayTextures[${i}],\n        u_dayTextureUseWebMercatorT[${i}] ? textureCoordinates.xz : textureCoordinates.xy,\n`;
    source += `        u_dayTextureTexCoordsRectangle[${i}],\n        u_dayTextureTranslationAndScale[${i}],\n`;
    source += `        ${apply.alpha === true ? `u_dayTextureAlpha[${i}]` : "1.0"},\n`;
    source += `        ${apply.dayNightAlpha === true ? `u_dayTextureNightAlpha[${i}]` : "1.0"},\n`;
    source += `        ${apply.dayNightAlpha === true ? `u_dayTextureDayAlpha[${i}]` : "1.0"},\n`;
    source += `        ${apply.brightness === true ? `u_dayTextureBrightness[${i}]` : "0.0"},\n`;
    source += `        ${apply.contrast === true ? `u_dayTextureContrast[${i}]` : "0.0"},\n`;
    source += `        ${apply.hue === true ? `u_dayTextureHue[${i}]` : "0.0"},\n`;
    source += `        ${apply.saturation === true ? `u_dayTextureSaturation[${i}]` : "0.0"},\n`;
    source += `        ${apply.gamma === true ? `u_dayTextureOneOverGamma[${i}]` : "0.0"},\n`;
    source += `        ${apply.split === true ? `u_dayTextureSplit[${i}]` : "0.0"},\n`;
    source += `        ${apply.colorToAlpha === true ? `u_colorsToAlpha[${i}]` : "vec4(0.0)"},\n`;
    source += "        nightBlend);\n";
  }
  source += "    return color;\n}";
  return source;
}

/** A uniform-array element access rendered from the bind-layout table (`u_dayTextureAlpha[i].x`). */
export type UniformElementAccess = (name: string, index: number) => string;

/**
 * WGSL mirror of `computeDayColor()`.
 *
 * WGSL-forced differences (declared, no silent change):
 *   - `u_dayTextures[i]` (a `sampler2D[]` indexed at runtime) becomes an explicit
 *     `(u_dayTextures_<i>_texture, u_dayTextures_<i>_sampler)` pair per element (spike §6.4 ①);
 *   - the GLSL `bool` uniform `u_dayTextureUseWebMercatorT[i]` is stored as `u32` (H-4), so the
 *     ternary becomes `select(xy, xz, … != 0u)`;
 *   - `gl_FragCoord.x` (used by `APPLY_SPLIT` inside `sampleAndBlend`) is passed in explicitly.
 *
 * `TEXTURE_UNITS` is **not** a define here (G-6/T025 fix): the tile's imagery layer count changes
 * inside one session, so building it into the module text would recompile a ~13 kB module every
 * time. `numberOfDayTextures` is a **pipeline-overridable constant** and the chain is emitted once at
 * its maximum length with one guard per step, so a new layer count is a `createRenderPipeline` on the
 * already-parsed module. The guards are pipeline constants, eliminated at pipeline-creation time, so
 * the observable behaviour is identical to the unrolled builder above.
 *
 * @param maxTextureUnits the number of `u_dayTextures` bindings the union layout declares.
 * @param access renders one uniform read **through the bind-layout table**, so a padded (16-byte
 *   widened) array element is read as `.x`/`.xy` without hard-coding the suffix here.
 */
export function emitComputeDayColorWgsl({ maxTextureUnits, apply = {}, access = (name: string, index: number) => `czm.${name}[${index}]` }: { maxTextureUnits: number; apply?: Partial<ApplyFlags>; access?: UniformElementAccess }): string {
  if (!Number.isInteger(maxTextureUnits) || maxTextureUnits < 1) throw new Error(`generated-fragments: maxTextureUnits must be a positive integer (got ${String(maxTextureUnits)}) — the bind layout declares no u_dayTextures binding`);
  const lines = [
    "// Mirror of `GlobeSurfaceShaderSet.js:419-472` (`computeDayColor`), emitted by",
    "// packages/cesium-webgpu/backend-webgpu/webgpu/generated-fragments.ts.",
    "//",
    "// `TEXTURE_UNITS` is a pipeline-overridable constant (`numberOfDayTextures`) here, not a",
    "// preprocessor define: the chain is emitted once at its maximum length and every step is guarded,",
    "// so the module text does not depend on the tile's imagery layer count (G-6/T025).",
    "fn computeDayColor(initialColor: vec4<f32>, textureCoordinates: vec3<f32>, nightBlend: f32, fragCoordX: f32) -> vec4<f32> {",
    "  var color = initialColor;",
  ];
  const step = (body: readonly string[]): string[] => body.map((line) => (line.length === 0 ? line : `  ${line}`));
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
        `  ${apply.alpha === true ? access("u_dayTextureAlpha", i) : "1.0"},`,
        `  ${apply.dayNightAlpha === true ? access("u_dayTextureNightAlpha", i) : "1.0"},`,
        `  ${apply.dayNightAlpha === true ? access("u_dayTextureDayAlpha", i) : "1.0"},`,
        `  ${apply.brightness === true ? access("u_dayTextureBrightness", i) : "0.0"},`,
        `  ${apply.contrast === true ? access("u_dayTextureContrast", i) : "0.0"},`,
        `  ${apply.hue === true ? access("u_dayTextureHue", i) : "0.0"},`,
        `  ${apply.saturation === true ? access("u_dayTextureSaturation", i) : "0.0"},`,
        `  ${apply.gamma === true ? access("u_dayTextureOneOverGamma", i) : "0.0"},`,
        `  ${apply.split === true ? access("u_dayTextureSplit", i) : "0.0"},`,
        `  ${apply.colorToAlpha === true ? access("u_colorsToAlpha", i) : "vec4<f32>(0.0)"},`,
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
 * Upstream `GlobeSurfaceShaderSet.js:474-475, 529-568` — the runtime-generated position functions,
 * selected by scene mode and by whether the layer uses the Web-Mercator projection.
 */
export function emitGetPositionGlsl({ sceneMode = "SCENE3D" }: { sceneMode?: string; useWebMercatorProjection?: boolean } = {}): string {
  const position =
    sceneMode === "SCENE3D"
      ? "vec4 getPosition(vec3 position, float height, vec2 textureCoordinates) { return getPosition3DMode(position, height, textureCoordinates); }"
      : sceneMode === "MORPHING"
        ? "vec4 getPosition(vec3 position, float height, vec2 textureCoordinates) { return getPositionMorphingMode(position, height, textureCoordinates); }"
        : "vec4 getPosition(vec3 position, float height, vec2 textureCoordinates) { return getPositionColumbusViewMode(position, height, textureCoordinates); }";
  return `${position}\n`;
}

/** The GLSL mirror of `get2DYPositionFraction()` (the WGSL side lives in `wgsl/leaves/**`). */
export function emitGet2DYPositionFractionGlsl({ useWebMercatorProjection = true }: { useWebMercatorProjection?: boolean } = {}): string {
  return useWebMercatorProjection
    ? "float get2DYPositionFraction(vec2 textureCoordinates) { return get2DMercatorYPositionFraction(textureCoordinates); }"
    : "float get2DYPositionFraction(vec2 textureCoordinates) { return get2DGeographicYPositionFraction(textureCoordinates); }";
}

/** Both runtime position functions, as upstream pushes them (`GlobeSurfaceShaderSet.js:474-475`). */
export function emitPositionFunctionsGlsl(options: { sceneMode?: string; useWebMercatorProjection?: boolean } = {}): string {
  return `${emitGetPositionGlsl(options)}\n${emitGet2DYPositionFractionGlsl(options)}`;
}

/** The WGSL mirror of the same two-way / three-way choice, driven by the emitter's `POSITION_MODE_*`. */
export function positionModeDefines({ sceneMode = "SCENE3D", useWebMercatorProjection = true }: { sceneMode?: string; useWebMercatorProjection?: boolean } = {}): string[] {
  return [sceneMode === "SCENE3D" ? "POSITION_MODE_3D" : "POSITION_MODE_COLUMBUS_2D", useWebMercatorProjection ? "Y_FRACTION_MERCATOR" : "Y_FRACTION_GEOGRAPHIC"];
}

/** The `APPLY_*` flags derived from a define list — one source of truth for both emissions. */
export function applyFlagsFromDefines(defines: DefineList): ApplyFlags {
  const has = (name: string): boolean => defines.some((define) => define === name || define.startsWith(`${name} `));
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
export function textureUnitsFromDefines(defines: DefineList): number {
  for (const define of defines) {
    const match = /^TEXTURE_UNITS\s+(\d+)$/.exec(define);
    if (match !== null) return Number(match[1]);
  }
  return 0;
}

/** The `APPLY_*` define names, in a stable order (the mirror's coverage axes). */
export const APPLY_FLAG_DEFINES: readonly (keyof ApplyFlags)[] = ["alpha", "dayNightAlpha", "split", "brightness", "contrast", "hue", "saturation", "gamma", "colorToAlpha"];

/** The `APPLY_*` define name behind each flag. */
export const APPLY_FLAG_NAMES: Readonly<Record<keyof ApplyFlags, string>> = {
  alpha: "APPLY_ALPHA",
  dayNightAlpha: "APPLY_DAY_NIGHT_ALPHA",
  split: "APPLY_SPLIT",
  brightness: "APPLY_BRIGHTNESS",
  contrast: "APPLY_CONTRAST",
  hue: "APPLY_HUE",
  saturation: "APPLY_SATURATION",
  gamma: "APPLY_GAMMA",
  colorToAlpha: "APPLY_COLOR_TO_ALPHA",
};

export interface GeneratedFragmentCoverage {
  /** Every reachable `{ textureUnits, flags }` combination, as a bit-mask id. */
  readonly combinations: number;
  /** Combinations whose WGSL mirror was produced and is non-empty. */
  readonly covered: number;
  /** Combinations the mirror refused — with the reason. MUST be empty for a passing coverage run. */
  readonly uncovered: readonly { readonly id: string; readonly reason: string }[];
  /** The flags actually exercised (bit positions of `APPLY_FLAG_DEFINES`), one bitmask per value. */
  readonly flagMasks: readonly number[];
}

/**
 * Count coverage over the **reachable parameter combinations** (R6 acceptance criterion).
 *
 * `textureUnits ∈ {1..maxTextureUnits}` (0 is not a rendering configuration — `GlobeSurfaceShaderSet`
 * only builds the chain for a tile that has imagery) × every one of the `2^9` `APPLY_*` flag subsets.
 * A combination whose mirror cannot be produced is reported in `uncovered` **with its reason**; the
 * caller MUST treat a non-empty `uncovered` as a failure rather than as a skip.
 */
export function coverage({ maxTextureUnits = 3 }: { maxTextureUnits?: number } = {}): GeneratedFragmentCoverage {
  const uncovered: { id: string; reason: string }[] = [];
  let combinations = 0;
  let covered = 0;
  const flagMasks: number[] = [];
  for (let textureUnits = 1; textureUnits <= maxTextureUnits; textureUnits += 1) {
    for (let mask = 0; mask < 2 ** APPLY_FLAG_DEFINES.length; mask += 1) {
      combinations += 1;
      const apply: Record<string, boolean> = {};
      APPLY_FLAG_DEFINES.forEach((flag, bit) => {
        apply[flag] = (mask & (1 << bit)) !== 0;
      });
      flagMasks.push(mask);
      try {
        const wgsl = emitComputeDayColorWgsl({ maxTextureUnits, apply: apply as unknown as ApplyFlags, access: (name, index) => `u.${name}[${index}]` });
        if (wgsl.length === 0) throw new Error("empty mirror");
        covered += 1;
      } catch (error) {
        uncovered.push({ id: `textureUnits=${textureUnits}|flags=${mask}`, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { combinations, covered, uncovered, flagMasks };
}
