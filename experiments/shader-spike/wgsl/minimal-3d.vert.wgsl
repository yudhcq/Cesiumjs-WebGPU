struct CZM_UBO {
    czm_modelView3D: mat4x4<f32>,
    czm_lightDirectionWC: vec3<f32>,
    czm_sunDirectionWC: vec3<f32>,
    czm_normal3D: mat3x3<f32>,
    czm_ellipsoidRadii: vec3<f32>,
    czm_projection: mat4x4<f32>,
    czm_modelView: mat4x4<f32>,
    czm_morphTime: f32,
    czm_viewerPositionWC: vec3<f32>,
    u_radiiAndDynamicAtmosphereColor: vec3<f32>,
    u_atmosphereLightIntensity: f32,
    u_atmosphereRayleighScaleHeight: f32,
    u_atmosphereMieScaleHeight: f32,
    u_atmosphereMieAnisotropy: f32,
    u_atmosphereRayleighCoefficient: vec3<f32>,
    u_atmosphereMieCoefficient: vec3<f32>,
    u_center3D: vec3<f32>,
    u_modifiedModelView: mat4x4<f32>,
    u_modifiedModelViewProjection: mat4x4<f32>,
    u_tileRectangle: vec4<f32>,
    u_southAndNorthLatitude: vec2<f32>,
    u_southMercatorYAndOneOverHeight: vec2<f32>,
}

struct gl_PerVertex {
    @builtin(position) gl_Position: vec4<f32>,
    gl_PointSize: f32,
}

struct czm_raySegment {
    start: f32,
    stop: f32,
}

struct VertexOutput {
    @builtin(position) gl_Position: vec4<f32>,
    @location(3) member: vec3<f32>,
    @location(2) member_1: vec3<f32>,
    @location(4) member_2: vec3<f32>,
    @location(5) member_3: vec3<f32>,
    @location(6) member_4: vec3<f32>,
}

@group(0) @binding(0) 
var<uniform> czmUBO: CZM_UBO;
var<private> position3DAndHeight_1: vec4<f32>;
var<private> textureCoordAndEncodedNormals_1: vec4<f32>;
var<private> unnamed: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);
var<private> v_positionEC: vec3<f32>;
var<private> v_positionMC: vec3<f32>;
var<private> v_textureCoordinates: vec3<f32>;
var<private> v_normalMC: vec3<f32>;
var<private> v_normalEC: vec3<f32>;

fn getPosition3DMode_u0028_vf3_u003b_f1_u003b_vf2_u003b(position: ptr<function, vec3<f32>>, height: ptr<function, f32>, textureCoordinates: ptr<function, vec2<f32>>) -> vec4<f32> {
    let _e29 = czmUBO.u_modifiedModelViewProjection;
    let _e30 = (*position);
    return (_e29 * vec4<f32>(_e30.x, _e30.y, _e30.z, 1f));
}

fn getPosition_u0028_vf3_u003b_f1_u003b_vf2_u003b(position_1: ptr<function, vec3<f32>>, height_1: ptr<function, f32>, textureCoordinates_1: ptr<function, vec2<f32>>) -> vec4<f32> {
    var param: vec3<f32>;
    var param_1: f32;
    var param_2: vec2<f32>;

    let _e31 = (*position_1);
    param = _e31;
    let _e32 = (*height_1);
    param_1 = _e32;
    let _e33 = (*textureCoordinates_1);
    param_2 = _e33;
    let _e34 = getPosition3DMode_u0028_vf3_u003b_f1_u003b_vf2_u003b((&param), (&param_1), (&param_2));
    return _e34;
}

fn main_1() {
    var position_2: vec3<f32>;
    var height_2: f32;
    var textureCoordinates_2: vec2<f32>;
    var webMercatorT: f32;
    var encodedNormal: f32;
    var position3DWC: vec3<f32>;
    var ellipsoidNormal: vec3<f32>;
    var param_3: vec3<f32>;
    var param_4: f32;
    var param_5: vec2<f32>;

    let _e35 = position3DAndHeight_1;
    position_2 = _e35.xyz;
    let _e38 = position3DAndHeight_1[3u];
    height_2 = _e38;
    let _e39 = textureCoordAndEncodedNormals_1;
    textureCoordinates_2 = _e39.xy;
    let _e42 = textureCoordinates_2[1u];
    webMercatorT = _e42;
    encodedNormal = 0f;
    let _e43 = position_2;
    let _e45 = czmUBO.u_center3D;
    position3DWC = (_e43 + _e45);
    let _e47 = position3DWC;
    ellipsoidNormal = normalize(_e47);
    let _e49 = position_2;
    param_3 = _e49;
    let _e50 = height_2;
    param_4 = _e50;
    let _e51 = textureCoordinates_2;
    param_5 = _e51;
    let _e52 = getPosition_u0028_vf3_u003b_f1_u003b_vf2_u003b((&param_3), (&param_4), (&param_5));
    unnamed.gl_Position = _e52;
    let _e55 = czmUBO.u_modifiedModelView;
    let _e56 = position_2;
    v_positionEC = (_e55 * vec4<f32>(_e56.x, _e56.y, _e56.z, 1f)).xyz;
    let _e63 = position3DWC;
    v_positionMC = _e63;
    let _e64 = textureCoordinates_2;
    let _e65 = webMercatorT;
    v_textureCoordinates = vec3<f32>(_e64.x, _e64.y, _e65);
    return;
}

@vertex 
fn main(@location(0) position3DAndHeight: vec4<f32>, @location(1) textureCoordAndEncodedNormals: vec4<f32>) -> VertexOutput {
    position3DAndHeight_1 = position3DAndHeight;
    textureCoordAndEncodedNormals_1 = textureCoordAndEncodedNormals;
    main_1();
    let _e12 = unnamed.gl_Position.y;
    unnamed.gl_Position.y = -(_e12);
    let _e14 = unnamed.gl_Position;
    let _e15 = v_positionEC;
    let _e16 = v_positionMC;
    let _e17 = v_textureCoordinates;
    let _e18 = v_normalMC;
    let _e19 = v_normalEC;
    return VertexOutput(_e14, _e15, _e16, _e17, _e18, _e19);
}
