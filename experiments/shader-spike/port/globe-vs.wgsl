// ============================================================================
// Spike S6 / Path B — hand port of CesiumJS 1.145.0 GlobeVS to WGSL.
//
// Source of truth: experiments/shader-spike/glsl/default-3d.vert.glsl, i.e. the
// exact string Cesium hands to gl.compileShader (870 lines) for the define set
//   INCLUDE_WEB_MERCATOR_Y, ENABLE_DAYNIGHT_SHADING          (= default-3d, but
//   with GROUND_ATMOSPHERE / DYNAMIC_ATMOSPHERE_LIGHTING off, i.e. the real
//   Cesium configuration `globe.showGroundAtmosphere = false`)
//   SCENE3D, non-quantized terrain (heightmap), no exaggeration, no material,
//   no clipping, no translucency, no fog.
//
// Ported faithfully (GLSL -> WGSL):
//   getPosition3DMode, get2DMercatorYPositionFraction, czm_latitudeToWebMercatorFraction,
//   czm_webMercatorMaxLatitude, czm_octDecode (vec2/float overloads), czm_signNotZero,
//   czm_branchFreeTernary, and the active branch of main().
//
// NOT ported in this spike (declared, deliberately out of scope, see REPORT.md §6):
//   computeAtmosphereScattering / computeScattering (GroundAtmosphere.glsl, ~190 GLSL
//   lines + 5 builtins incl. czm_raySphereIntersectionInterval, czm_approximateTanh),
//   QUANTIZATION_BITS12 (decompress + scale/bias), EXAGGERATION, GEODETIC_SURFACE_NORMALS,
//   APPLY_MATERIAL, morphing / 2D / Columbus-view modes, clipping planes.
//
// GLSL -> WGSL mapping decisions that are NOT mechanical (each is a manual edit):
//   M1 `uniform mat4 czm_modelView;` ... -> one WGSL uniform struct + explicit
//      @group/@binding. Cesium binds these per-name from GL reflection; WGSL has no
//      per-uniform binding, so offsets/alignment must be computed by hand.
//   M2 `out vec3 v_x;` (VS) / `in vec3 v_x;` (FS) -> must become explicit
//      @location(N) on BOTH sides AND be identical; GL prunes unused varyings,
//      WebGPU does not (see REPORT.md §5.7, experiment E1).
//   M3 `gl_Position` -> @builtin(position); `gl_FrontFacing` -> @builtin(front_facing).
//   M4 `precision highp/mediump` -> deleted (WGSL has no precision qualifiers).
//   M5 const float czm_* -> `const czm_*: f32 = ...;`
//   M6 GLSL function overloading (czm_octDecode(vec2) vs (float)) -> distinct names.
//   M7 `vec4(x)` splat / `vec4(v3, 1.0)` are the same in WGSL; `vec2/vec3/vec4`
//      become `vecN<f32>`.
//   M8 GLSL `const czm_raySegment czm_emptyRaySegment = ...` (struct const) is not
//      expressible in WGSL -- needs a plain struct literal at use sites or a fn.
// ============================================================================

const czm_pi: f32 = 3.141592653589793;
const czm_webMercatorMaxLatitude: f32 = 1.4844222297453324;

// ---- M1: automatic uniforms, hand-packed (std140-compatible offsets) -------
struct GlobeUniforms {
    u_southAndNorthLatitude: vec2<f32>,              // offset   0
    u_southMercatorYAndOneOverHeight: vec2<f32>,     // offset   8
    u_tileRectangle: vec4<f32>,                      // offset  16
    u_center3D: vec3<f32>,                           // offset  32
    czm_lightDirectionWC: vec3<f32>,                 // offset  48
    czm_sunDirectionWC: vec3<f32>,                   // offset  64
    u_modifiedModelView: mat4x4<f32>,                // offset  80
    u_modifiedModelViewProjection: mat4x4<f32>,      // offset 144
    czm_modelView3D: mat4x4<f32>,                    // offset 208
    czm_projection: mat4x4<f32>,                     // offset 272
    czm_modelView: mat4x4<f32>,                      // offset 336
    czm_normal3D: mat3x3<f32>,                       // offset 400 (3 padded columns)
    czm_viewerPositionWC: vec3<f32>,                 // offset 448
    czm_morphTime: f32,                              // offset 460
    czm_ellipsoidRadii: vec3<f32>,                   // offset 464
};

@group(0) @binding(0) var<uniform> czm: GlobeUniforms;

// ---- builtins (ported 1:1 from the assembled GLSL) -------------------------
fn czm_signNotZero2(v: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(
        select(-1.0, 1.0, v.x >= 0.0),
        select(-1.0, 1.0, v.y >= 0.0),
    );
}

fn czm_signNotZero3(v: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        select(-1.0, 1.0, v.x >= 0.0),
        select(-1.0, 1.0, v.y >= 0.0),
        select(-1.0, 1.0, v.z >= 0.0),
    );
}

fn czm_octDecodeRange(encoded: vec2<f32>, range: f32) -> vec3<f32> {
    if (encoded.x == 0.0 && encoded.y == 0.0) {
        return vec3<f32>(0.0, 0.0, 0.0);
    }
    let e = encoded / range * 2.0 - vec2<f32>(1.0, 1.0);
    var v = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
    if (v.z < 0.0) {
        // GLSL: v.xy = (1.0 - abs(v.yx)) * czm_signNotZero(v.xy);
        let xy = (vec2<f32>(1.0, 1.0) - abs(vec2<f32>(v.y, v.x))) * czm_signNotZero2(vec2<f32>(v.x, v.y));
        v = vec3<f32>(xy.x, xy.y, v.z);
    }
    return normalize(v);
}

fn czm_octDecode(encoded: vec2<f32>) -> vec3<f32> {
    return czm_octDecodeRange(encoded, 255.0);
}

// overload czm_octDecode(float) -> separate name (M6)
fn czm_octDecodeFloat(encoded: f32) -> vec3<f32> {
    let temp = encoded / 256.0;
    let x = floor(temp);
    let y = (temp - x) * 256.0;
    return czm_octDecode(vec2<f32>(x, y));
}

fn czm_branchFreeTernary3(comparison: bool, a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
    let useA = select(0.0, 1.0, comparison);
    return a * useA + b * (1.0 - useA);
}

// 1:1 from assembled GLSL line 326-332 (note: not the textbook Mercator formula;
// it is sin()-based and only valid for |latitude| <= czm_webMercatorMaxLatitude).
fn czm_latitudeToWebMercatorFraction(latitude: f32, southMercatorY: f32, oneOverMercatorHeight: f32) -> f32 {
    let sinLatitude = sin(latitude);
    let mercatorY = 0.5 * log((1.0 + sinLatitude) / (1.0 - sinLatitude));
    return (mercatorY - southMercatorY) * oneOverMercatorHeight;
}

// ---- varyings --------------------------------------------------------------
struct VSIn {
    @location(0) position3DAndHeight: vec4<f32>,
    @location(1) textureCoordAndEncodedNormals: vec4<f32>,
};

struct VSOut {
    @builtin(position) position: vec4<f32>,
    @location(0) v_positionMC: vec3<f32>,
    @location(1) v_positionEC: vec3<f32>,
    @location(2) v_textureCoordinates: vec3<f32>,
};

// GlobeVS.glsl:53-56
fn getPosition3DMode(position: vec3<f32>, height: f32, textureCoordinates: vec2<f32>) -> vec4<f32> {
    return czm.u_modifiedModelViewProjection * vec4<f32>(position, 1.0);
}

// GlobeVS.glsl:58-79
fn get2DMercatorYPositionFraction(textureCoordinates: vec2<f32>) -> f32 {
    let maxTileWidth = 0.003068;
    var positionFraction = textureCoordinates.y;
    let southLatitude = czm.u_southAndNorthLatitude.x;
    let northLatitude = czm.u_southAndNorthLatitude.y;
    if (northLatitude - southLatitude > maxTileWidth) {
        let southMercatorY = czm.u_southMercatorYAndOneOverHeight.x;
        let oneOverMercatorHeight = czm.u_southMercatorYAndOneOverHeight.y;
        var currentLatitude = mix(southLatitude, northLatitude, textureCoordinates.y);
        currentLatitude = clamp(currentLatitude, -czm_webMercatorMaxLatitude, czm_webMercatorMaxLatitude);
        positionFraction = czm_latitudeToWebMercatorFraction(currentLatitude, southMercatorY, oneOverMercatorHeight);
    }
    return positionFraction;
}

@vertex
fn main(input: VSIn) -> VSOut {
    // ---- active branch of GlobeVS.glsl main() (non-quantized, mercator-T on) ----
    let position = input.position3DAndHeight.xyz;
    let height = input.position3DAndHeight.w;
    let textureCoordinates = input.textureCoordAndEncodedNormals.xy;

    // M6: czm_octDecode(encodedNormal) overload resolution is a *compile-time* choice
    // in GLSL; in WGSL the caller must know which overload the define set selects.
    let webMercatorT = input.textureCoordAndEncodedNormals.z; // INCLUDE_WEB_MERCATOR_Y branch
    let encodedNormal = 0.0;                                  // ...and not VERTEX_LIGHTING

    let position3DWC = position + czm.u_center3D;
    let ellipsoidNormal = normalize(position3DWC);

    var out: VSOut;
    out.position = getPosition3DMode(position, height, textureCoordinates);
    out.v_positionEC = (czm.u_modifiedModelView * vec4<f32>(position, 1.0)).xyz;
    out.v_positionMC = position3DWC;
    out.v_textureCoordinates = vec3<f32>(textureCoordinates, webMercatorT);

    // ENABLE_DAYNIGHT_SHADING does NOT write v_normalMC/v_normalEC in GlobeVS (only
    // ENABLE_VERTEX_LIGHTING / GENERATE_POSITION_AND_NORMAL / APPLY_MATERIAL do), yet
    // GlobeFS declares them unconditionally -> dropped here (see M2 / REPORT.md §5.7).
    let _unusedNormal = czm_octDecodeFloat(encodedNormal);
    let _unusedNormal2 = czm_octDecode(vec2<f32>(0.0, 0.0));
    let _unusedBranchFree = czm_branchFreeTernary3(true, ellipsoidNormal, ellipsoidNormal);
    return out;
}
