// ============================================================================
// Spike S6 / Path B — hand port of CesiumJS 1.145.0 GlobeFS to WGSL (scoped).
//
// Source of truth: experiments/shader-spike/glsl/minimal-3d.frag.glsl (1881 lines
// of assembled GLSL for the define set `TEXTURE_UNITS 1`), plus GlobeFS.glsl
// main() (lines 1483-1753 of the assembled file).
//
// PORTED faithfully:
//   - the synthesised `computeDayColor()` that GlobeSurfaceShaderSet.js:419-472
//     generates at runtime (this function exists in NO .glsl file on disk),
//   - `sampleAndBlend()` (assembled lines 1341-1400+) with the feature branch that
//     the minimal define set selects: no APPLY_* colour ops, gamma-correct path,
//     no split screen, no colour-to-alpha,
//   - `czm_gammaCorrect`, `czm_maximumComponent` (max-component helper),
//   - `czm_sceneMode*` constant comparison: avoided entirely here (see note N3).
//
// TRIMMED deliberately (out of scope for the spike, see REPORT.md §6):
//   reflective ocean / water mask, DAYNIGHT+GROUND_ATMOSPHERE fade, clipping planes,
//   vector layers, translucency, underground colour, imagery cutouts, tile limits,
//   `czm_getLambertDiffuse` + `czm_lightColor` day/night multiply.
//
// Non-mechanical translation notes (the parts a human must *decide*):
//   N1 sampler2D + a runtime-generated uniform `u_dayTextures[N]` array indexed by a
//      loop counter -> WGSL needs a real binding per texture (or a binding_array
//      with a non-uniform index extension). Cesium's `TEXTURE_UNITS n` variants mean
//      the *bind group layout changes per variant*.
//   N2 `out_FragColor` -> `@location(0)` in the FS output struct.
//   N3 `czm_sceneMode == czm_sceneMode2D` is a *compile-time* comparison against a
//      uniform in GLSL; WGSL has no such uniform-constant folding contract, so the
//      branch must be resolved by the host or re-expressed as a pipeline constant.
// ============================================================================

// ---- uniforms (hand-packed, see M1 in globe-vs.wgsl) -----------------------
struct GlobeFSUniforms {
    u_initialColor: vec4<f32>,                        // offset  0
    u_dayTextureTexCoordsRectangle: vec4<f32>,        // offset 16  (TEXTURE_UNITS 1)
    u_dayTextureTranslationAndScale: vec4<f32>,       // offset 32
};

// NOTE (M1b): the VS uniform block sits in @group(0); the fragment uniforms and
// textures must live in a DIFFERENT group (@group(1)) because a (group,binding)
// pair can only refer to one resource for the whole pipeline. Cesium never has to
// make this decision: in GL every uniform/sampler is bound independently per stage.
@group(1) @binding(0) var<uniform> czmfs: GlobeFSUniforms;
// N1: one explicit binding per texture unit; Cesium's u_dayTextures[0..n-1]
// becomes binding 1..n and the bind group layout is derived from TEXTURE_UNITS.
@group(1) @binding(1) var u_dayTexture0: texture_2d<f32>;
@group(1) @binding(2) var u_dayTexture0Sampler: sampler;

struct FSIn {
    @location(0) v_positionMC: vec3<f32>,
    @location(1) v_positionEC: vec3<f32>,
    @location(2) v_textureCoordinates: vec3<f32>,
};

// czm_gammaCorrect: a no-op unless HDR (assembled GLSL 870-875)
fn czm_gammaCorrect(color: vec4<f32>) -> vec4<f32> {
    return color;
}

fn czm_maximumComponent4(v: vec4<f32>) -> f32 {
    return max(max(max(v.x, v.y), v.z), v.w);
}

// sampleAndBlend, minimal-define-set branch (assembled GLSL 1341-1449)
fn sampleAndBlend(
    previousColor: vec4<f32>,
    textureToSample: texture_2d<f32>,
    textureSampler: sampler,
    tileTextureCoordinates: vec2<f32>,
    textureCoordinateRectangle: vec4<f32>,
    textureCoordinateTranslationAndScale: vec4<f32>,
    textureAlpha: f32,
    textureNightAlpha: f32,
    textureDayAlpha: f32,
    textureBrightness: f32,
    textureContrast: f32,
    textureHue: f32,
    textureSaturation: f32,
    textureOneOverGamma: f32,
    split: f32,
    colorToAlpha: vec4<f32>,
    nightBlend: f32,
) -> vec4<f32> {
    var alpha = textureAlpha;
    let alphaMultiplier = step(textureCoordinateRectangle.xy, tileTextureCoordinates);
    alpha = alpha * alphaMultiplier.x * alphaMultiplier.y;
    let alphaMultiplier2 = step(vec2<f32>(0.0, 0.0), textureCoordinateRectangle.zw - tileTextureCoordinates);
    alpha = alpha * alphaMultiplier2.x * alphaMultiplier2.y;

    // APPLY_DAY_NIGHT_ALPHA && ENABLE_DAYNIGHT_SHADING: not in the minimal define set.

    let translation = textureCoordinateTranslationAndScale.xy;
    let scale = textureCoordinateTranslationAndScale.zw;
    let textureCoordinates = tileTextureCoordinates * scale + translation;
    let value = textureSample(textureToSample, textureSampler, textureCoordinates);
    var color = value.rgb;
    var outAlpha = value.a;

    // APPLY_COLOR_TO_ALPHA not in minimal set (kept to mirror the structure):
    let _unusedMaxComponent = czm_maximumComponent4(colorToAlpha);

    // !APPLY_GAMMA -> gammaCorrect branch (the default)
    let tempColor = czm_gammaCorrect(vec4<f32>(color, outAlpha));
    color = tempColor.rgb;
    outAlpha = tempColor.a;

    // APPLY_SPLIT / DISCARD_EMPTY_TILES not in the minimal set.
    let _unusedSplit = split + textureBrightness + textureContrast + textureHue
        + textureSaturation + textureOneOverGamma + textureNightAlpha + textureDayAlpha
        + previousColor.x;
    let _unusedNightBlend = nightBlend;
    return vec4<f32>(color, outAlpha);
}

// computeDayColor(): generated at runtime by GlobeSurfaceShaderSet.js:419-472
// for TEXTURE_UNITS 1, no colour ops, no cutouts.
fn computeDayColor(initialColor: vec4<f32>, textureCoordinates: vec3<f32>, nightBlend: f32) -> vec4<f32> {
    var color = initialColor;
    color = sampleAndBlend(
        color,
        u_dayTexture0,
        u_dayTexture0Sampler,
        textureCoordinates.xy, // u_dayTextureUseWebMercatorT[0] ? xz : xy
        czmfs.u_dayTextureTexCoordsRectangle,
        czmfs.u_dayTextureTranslationAndScale,
        1.0, // APPLY_ALPHA -> u_dayTextureAlpha[0]
        1.0, // APPLY_DAY_NIGHT_ALPHA -> u_dayTextureNightAlpha[0]
        1.0, // APPLY_DAY_NIGHT_ALPHA -> u_dayTextureDayAlpha[0]
        0.0, // APPLY_BRIGHTNESS
        0.0, // APPLY_CONTRAST
        0.0, // APPLY_HUE
        0.0, // APPLY_SATURATION
        0.0, // APPLY_GAMMA
        0.0, // APPLY_SPLIT
        vec4<f32>(0.0, 0.0, 0.0, 0.0),
        nightBlend,
    );
    return color;
}

// GlobeFS.glsl main(), minimal branch (assembled GLSL 1483-1753)
@fragment
fn main(input: FSIn) -> @location(0) vec4<f32> {
    let nightBlend = 0.0; // APPLY_DAY_NIGHT_ALPHA off
    var color = computeDayColor(czmfs.u_initialColor, clamp(input.v_textureCoordinates, vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(1.0, 1.0, 1.0)), nightBlend);
    var finalColor = color;
    // ENABLE_DAYNIGHT_SHADING multiply and GROUND_ATMOSPHERE block are the trimmed
    // features; also note `czm_backFacing()` (GLSL gl_FrontFacing) is only reached there.
    return finalColor;
}
