struct czm_ray {
    origin: vec3<f32>,
    direction: vec3<f32>,
}

struct czm_raySegment {
    start: f32,
    stop: f32,
}

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

struct VertexOutput {
    @builtin(position) gl_Position: vec4<f32>,
    @location(3) member: vec3<f32>,
    @location(2) member_1: vec3<f32>,
    @location(4) member_2: vec3<f32>,
    @location(8) member_3: vec3<f32>,
    @location(9) member_4: vec3<f32>,
    @location(10) member_5: f32,
    @location(7) member_6: f32,
    @location(5) member_7: vec3<f32>,
    @location(6) member_8: vec3<f32>,
}

@group(0) @binding(0) 
var<uniform> czmUBO: CZM_UBO;
var<private> position3DAndHeight_1: vec4<f32>;
var<private> textureCoordAndEncodedNormals_1: vec4<f32>;
var<private> unnamed: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);
var<private> v_positionEC: vec3<f32>;
var<private> v_positionMC: vec3<f32>;
var<private> v_textureCoordinates: vec3<f32>;
var<private> v_atmosphereRayleighColor: vec3<f32>;
var<private> v_atmosphereMieColor: vec3<f32>;
var<private> v_atmosphereOpacity: f32;
var<private> v_distance: f32;
var<private> v_normalMC: vec3<f32>;
var<private> v_normalEC: vec3<f32>;

fn czm_approximateTanh_u0028_f1_u003b(x: ptr<function, f32>) -> f32 {
    var x2_: f32;

    let _e53 = (*x);
    let _e54 = (*x);
    x2_ = (_e53 * _e54);
    let _e56 = (*x);
    let _e57 = x2_;
    let _e60 = x2_;
    return max(-1f, min(1f, ((_e56 * (27f + _e57)) / (27f + (9f * _e60)))));
}

fn czm_raySphereIntersectionInterval_u0028_struct_u002d_czm_ray_u002d_vf3_u002d_vf31_u003b_vf3_u003b_f1_u003b(ray: ptr<function, czm_ray>, center: ptr<function, vec3<f32>>, radius: ptr<function, f32>) -> czm_raySegment {
    var o: vec3<f32>;
    var d: vec3<f32>;
    var oc: vec3<f32>;
    var a: f32;
    var b: f32;
    var c: f32;
    var det: f32;
    var sqrtDet: f32;
    var t0_: f32;
    var t1_: f32;
    var result: czm_raySegment;

    let _e66 = (*ray).origin;
    o = _e66;
    let _e68 = (*ray).direction;
    d = _e68;
    let _e69 = o;
    let _e70 = (*center);
    oc = (_e69 - _e70);
    let _e72 = d;
    let _e73 = d;
    a = dot(_e72, _e73);
    let _e75 = d;
    let _e76 = oc;
    b = (2f * dot(_e75, _e76));
    let _e79 = oc;
    let _e80 = oc;
    let _e82 = (*radius);
    let _e83 = (*radius);
    c = (dot(_e79, _e80) - (_e82 * _e83));
    let _e86 = b;
    let _e87 = b;
    let _e89 = a;
    let _e91 = c;
    det = ((_e86 * _e87) - ((4f * _e89) * _e91));
    let _e94 = det;
    if (_e94 < 0f) {
        return czm_raySegment(-5906376400000f, -5906376400000f);
    }
    let _e96 = det;
    sqrtDet = sqrt(_e96);
    let _e98 = b;
    let _e100 = sqrtDet;
    let _e102 = a;
    t0_ = ((-(_e98) - _e100) / (2f * _e102));
    let _e105 = b;
    let _e107 = sqrtDet;
    let _e109 = a;
    t1_ = ((-(_e105) + _e107) / (2f * _e109));
    let _e112 = t0_;
    let _e113 = t1_;
    result = czm_raySegment(_e112, _e113);
    let _e115 = result;
    return _e115;
}

fn computeScattering_u0028_struct_u002d_czm_ray_u002d_vf3_u002d_vf31_u003b_f1_u003b_vf3_u003b_f1_u003b_vf3_u003b_vf3_u003b_f1_u003b(primaryRay: ptr<function, czm_ray>, primaryRayLength: ptr<function, f32>, lightDirection: ptr<function, vec3<f32>>, atmosphereInnerRadius: ptr<function, f32>, rayleighColor: ptr<function, vec3<f32>>, mieColor: ptr<function, vec3<f32>>, opacity: ptr<function, f32>) {
    var atmosphereOuterRadius: f32;
    var origin: vec3<f32>;
    var primaryRayAtmosphereIntersect: czm_raySegment;
    var param: czm_ray;
    var param_1: vec3<f32>;
    var param_2: f32;
    var x_1: f32;
    var w_stop_gt_lprl: f32;
    var param_3: f32;
    var start_0_: f32;
    var x_o_a: f32;
    var w_inside_atmosphere: f32;
    var param_4: f32;
    var PRIMARY_STEPS: i32;
    var LIGHT_STEPS: i32;
    var rayPositionLength: f32;
    var totalRayLength: f32;
    var rayStepLengthIncrease: f32;
    var rayStepLength: f32;
    var rayleighAccumulation: vec3<f32>;
    var mieAccumulation: vec3<f32>;
    var opticalDepth: vec2<f32>;
    var heightScale: vec2<f32>;
    var i: i32;
    var samplePosition: vec3<f32>;
    var sampleHeight: f32;
    var sampleDensity: vec2<f32>;
    var lightRay: czm_ray;
    var lightRayAtmosphereIntersect: czm_raySegment;
    var param_5: czm_ray;
    var param_6: vec3<f32>;
    var param_7: f32;
    var lightStepLength: f32;
    var lightPositionLength: f32;
    var lightOpticalDepth: vec2<f32>;
    var j: i32;
    var lightPosition: vec3<f32>;
    var lightHeight: f32;
    var attenuation: vec3<f32>;

    (*rayleighColor) = vec3<f32>(0f, 0f, 0f);
    (*mieColor) = vec3<f32>(0f, 0f, 0f);
    (*opacity) = 0f;
    let _e97 = (*atmosphereInnerRadius);
    atmosphereOuterRadius = (_e97 + 111000f);
    origin = vec3<f32>(0f, 0f, 0f);
    let _e99 = (*primaryRay);
    param = _e99;
    let _e100 = origin;
    param_1 = _e100;
    let _e101 = atmosphereOuterRadius;
    param_2 = _e101;
    let _e102 = czm_raySphereIntersectionInterval_u0028_struct_u002d_czm_ray_u002d_vf3_u002d_vf31_u003b_vf3_u003b_f1_u003b((&param), (&param_1), (&param_2));
    primaryRayAtmosphereIntersect = _e102;
    let _e103 = primaryRayAtmosphereIntersect;
    if ((_e103.start == czm_raySegment(-5906376400000f, -5906376400000f).start) && (_e103.stop == czm_raySegment(-5906376400000f, -5906376400000f).stop)) {
        return;
    }
    let _e112 = primaryRayAtmosphereIntersect.stop;
    let _e114 = (*primaryRayLength);
    x_1 = ((0.0000001f * _e112) / length(_e114));
    let _e117 = x_1;
    param_3 = _e117;
    let _e118 = czm_approximateTanh_u0028_f1_u003b((&param_3));
    w_stop_gt_lprl = (0.5f * (1f + _e118));
    let _e122 = primaryRayAtmosphereIntersect.start;
    start_0_ = _e122;
    let _e124 = primaryRayAtmosphereIntersect.start;
    primaryRayAtmosphereIntersect.start = max(_e124, 0f);
    let _e128 = primaryRayAtmosphereIntersect.stop;
    let _e129 = (*primaryRayLength);
    primaryRayAtmosphereIntersect.stop = min(_e128, length(_e129));
    let _e133 = start_0_;
    x_o_a = (_e133 - 111000f);
    let _e135 = x_o_a;
    param_4 = _e135;
    let _e136 = czm_approximateTanh_u0028_f1_u003b((&param_4));
    w_inside_atmosphere = (1f - (0.5f * (1f + _e136)));
    let _e140 = w_inside_atmosphere;
    PRIMARY_STEPS = (16i - i32((_e140 * 12f)));
    let _e144 = w_inside_atmosphere;
    LIGHT_STEPS = (4i - i32((_e144 * 2f)));
    let _e149 = primaryRayAtmosphereIntersect.start;
    rayPositionLength = _e149;
    let _e151 = primaryRayAtmosphereIntersect.stop;
    let _e152 = rayPositionLength;
    totalRayLength = (_e151 - _e152);
    let _e154 = w_inside_atmosphere;
    let _e155 = w_stop_gt_lprl;
    let _e157 = totalRayLength;
    let _e159 = PRIMARY_STEPS;
    let _e160 = PRIMARY_STEPS;
    rayStepLengthIncrease = (_e154 * (((1f - _e155) * _e157) / (f32((_e159 * (_e160 + 1i))) / 2f)));
    let _e167 = w_inside_atmosphere;
    let _e169 = w_stop_gt_lprl;
    let _e171 = totalRayLength;
    let _e173 = w_inside_atmosphere;
    let _e175 = PRIMARY_STEPS;
    rayStepLength = ((max((1f - _e167), _e169) * _e171) / max((7f * _e173), f32(_e175)));
    rayleighAccumulation = vec3<f32>(0f, 0f, 0f);
    mieAccumulation = vec3<f32>(0f, 0f, 0f);
    opticalDepth = vec2<f32>(0f, 0f);
    let _e180 = czmUBO.u_atmosphereRayleighScaleHeight;
    let _e182 = czmUBO.u_atmosphereMieScaleHeight;
    heightScale = vec2<f32>(_e180, _e182);
    i = 0i;
    loop {
        let _e184 = i;
        if (_e184 < 16i) {
            let _e186 = i;
            let _e187 = PRIMARY_STEPS;
            if (_e186 >= _e187) {
                break;
            }
            let _e190 = (*primaryRay).origin;
            let _e192 = (*primaryRay).direction;
            let _e193 = rayPositionLength;
            let _e194 = rayStepLength;
            samplePosition = (_e190 + (_e192 * (_e193 + _e194)));
            let _e198 = samplePosition;
            let _e200 = (*atmosphereInnerRadius);
            sampleHeight = (length(_e198) - _e200);
            let _e202 = sampleHeight;
            let _e204 = heightScale;
            let _e208 = rayStepLength;
            sampleDensity = (exp((vec2(-(_e202)) / _e204)) * _e208);
            let _e210 = sampleDensity;
            let _e211 = opticalDepth;
            opticalDepth = (_e211 + _e210);
            let _e213 = samplePosition;
            let _e214 = (*lightDirection);
            lightRay = czm_ray(_e213, _e214);
            let _e216 = lightRay;
            param_5 = _e216;
            let _e217 = origin;
            param_6 = _e217;
            let _e218 = atmosphereOuterRadius;
            param_7 = _e218;
            let _e219 = czm_raySphereIntersectionInterval_u0028_struct_u002d_czm_ray_u002d_vf3_u002d_vf31_u003b_vf3_u003b_f1_u003b((&param_5), (&param_6), (&param_7));
            lightRayAtmosphereIntersect = _e219;
            let _e221 = lightRayAtmosphereIntersect.stop;
            let _e222 = LIGHT_STEPS;
            lightStepLength = (_e221 / f32(_e222));
            lightPositionLength = 0f;
            lightOpticalDepth = vec2<f32>(0f, 0f);
            j = 0i;
            loop {
                let _e225 = j;
                if (_e225 < 4i) {
                    let _e227 = j;
                    let _e228 = LIGHT_STEPS;
                    if (_e227 >= _e228) {
                        break;
                    }
                    let _e230 = samplePosition;
                    let _e231 = (*lightDirection);
                    let _e232 = lightPositionLength;
                    let _e233 = lightStepLength;
                    lightPosition = (_e230 + (_e231 * (_e232 + (_e233 * 0.5f))));
                    let _e238 = lightPosition;
                    let _e240 = (*atmosphereInnerRadius);
                    lightHeight = (length(_e238) - _e240);
                    let _e242 = lightHeight;
                    let _e244 = heightScale;
                    let _e248 = lightStepLength;
                    let _e250 = lightOpticalDepth;
                    lightOpticalDepth = (_e250 + (exp((vec2(-(_e242)) / _e244)) * _e248));
                    let _e252 = lightStepLength;
                    let _e253 = lightPositionLength;
                    lightPositionLength = (_e253 + _e252);
                    continue;
                } else {
                    break;
                }
                continuing {
                    let _e255 = j;
                    j = (_e255 + 1i);
                }
            }
            let _e258 = czmUBO.u_atmosphereMieCoefficient;
            let _e260 = opticalDepth[1u];
            let _e262 = lightOpticalDepth[1u];
            let _e266 = czmUBO.u_atmosphereRayleighCoefficient;
            let _e268 = opticalDepth[0u];
            let _e270 = lightOpticalDepth[0u];
            attenuation = exp(-(((_e258 * (_e260 + _e262)) + (_e266 * (_e268 + _e270)))));
            let _e277 = sampleDensity[0u];
            let _e278 = attenuation;
            let _e280 = rayleighAccumulation;
            rayleighAccumulation = (_e280 + (_e278 * _e277));
            let _e283 = sampleDensity[1u];
            let _e284 = attenuation;
            let _e286 = mieAccumulation;
            mieAccumulation = (_e286 + (_e284 * _e283));
            let _e288 = rayStepLengthIncrease;
            let _e289 = rayStepLength;
            let _e290 = (_e289 + _e288);
            rayStepLength = _e290;
            let _e291 = rayPositionLength;
            rayPositionLength = (_e291 + _e290);
            continue;
        } else {
            break;
        }
        continuing {
            let _e293 = i;
            i = (_e293 + 1i);
        }
    }
    let _e296 = czmUBO.u_atmosphereRayleighCoefficient;
    let _e297 = rayleighAccumulation;
    (*rayleighColor) = (_e296 * _e297);
    let _e300 = czmUBO.u_atmosphereMieCoefficient;
    let _e301 = mieAccumulation;
    (*mieColor) = (_e300 * _e301);
    let _e304 = czmUBO.u_atmosphereMieCoefficient;
    let _e306 = opticalDepth[1u];
    let _e309 = czmUBO.u_atmosphereRayleighCoefficient;
    let _e311 = opticalDepth[0u];
    (*opacity) = length(exp(-(((_e304 * _e306) + (_e309 * _e311)))));
    return;
}

fn computeAtmosphereScattering_u0028_vf3_u003b_vf3_u003b_vf3_u003b_vf3_u003b_f1_u003b(positionWC: ptr<function, vec3<f32>>, lightDirection_1: ptr<function, vec3<f32>>, rayleighColor_1: ptr<function, vec3<f32>>, mieColor_1: ptr<function, vec3<f32>>, opacity_1: ptr<function, f32>) {
    var cameraToPositionWC: vec3<f32>;
    var cameraToPositionWCDirection: vec3<f32>;
    var primaryRay_1: czm_ray;
    var atmosphereInnerRadius_1: f32;
    var param_8: czm_ray;
    var param_9: f32;
    var param_10: vec3<f32>;
    var param_11: f32;
    var param_12: vec3<f32>;
    var param_13: vec3<f32>;
    var param_14: f32;

    let _e67 = (*positionWC);
    let _e69 = czmUBO.czm_viewerPositionWC;
    cameraToPositionWC = (_e67 - _e69);
    let _e71 = cameraToPositionWC;
    cameraToPositionWCDirection = normalize(_e71);
    let _e74 = czmUBO.czm_viewerPositionWC;
    let _e75 = cameraToPositionWCDirection;
    primaryRay_1 = czm_ray(_e74, _e75);
    let _e77 = (*positionWC);
    atmosphereInnerRadius_1 = length(_e77);
    let _e79 = cameraToPositionWC;
    let _e81 = primaryRay_1;
    param_8 = _e81;
    param_9 = length(_e79);
    let _e82 = (*lightDirection_1);
    param_10 = _e82;
    let _e83 = atmosphereInnerRadius_1;
    param_11 = _e83;
    computeScattering_u0028_struct_u002d_czm_ray_u002d_vf3_u002d_vf31_u003b_f1_u003b_vf3_u003b_f1_u003b_vf3_u003b_vf3_u003b_f1_u003b((&param_8), (&param_9), (&param_10), (&param_11), (&param_12), (&param_13), (&param_14));
    let _e84 = param_12;
    (*rayleighColor_1) = _e84;
    let _e85 = param_13;
    (*mieColor_1) = _e85;
    let _e86 = param_14;
    (*opacity_1) = _e86;
    return;
}

fn czm_branchFreeTernary_u0028_b1_u003b_vf3_u003b_vf3_u003b(comparison: ptr<function, bool>, a_1: ptr<function, vec3<f32>>, b_1: ptr<function, vec3<f32>>) -> vec3<f32> {
    var useA: f32;

    let _e55 = (*comparison);
    useA = select(0f, 1f, _e55);
    let _e57 = (*a_1);
    let _e58 = useA;
    let _e60 = (*b_1);
    let _e61 = useA;
    return ((_e57 * _e58) + (_e60 * (1f - _e61)));
}

fn getPosition3DMode_u0028_vf3_u003b_f1_u003b_vf2_u003b(position: ptr<function, vec3<f32>>, height: ptr<function, f32>, textureCoordinates: ptr<function, vec2<f32>>) -> vec4<f32> {
    let _e55 = czmUBO.u_modifiedModelViewProjection;
    let _e56 = (*position);
    return (_e55 * vec4<f32>(_e56.x, _e56.y, _e56.z, 1f));
}

fn getPosition_u0028_vf3_u003b_f1_u003b_vf2_u003b(position_1: ptr<function, vec3<f32>>, height_1: ptr<function, f32>, textureCoordinates_1: ptr<function, vec2<f32>>) -> vec4<f32> {
    var param_15: vec3<f32>;
    var param_16: f32;
    var param_17: vec2<f32>;

    let _e57 = (*position_1);
    param_15 = _e57;
    let _e58 = (*height_1);
    param_16 = _e58;
    let _e59 = (*textureCoordinates_1);
    param_17 = _e59;
    let _e60 = getPosition3DMode_u0028_vf3_u003b_f1_u003b_vf2_u003b((&param_15), (&param_16), (&param_17));
    return _e60;
}

fn main_1() {
    var position_2: vec3<f32>;
    var height_2: f32;
    var textureCoordinates_2: vec2<f32>;
    var webMercatorT: f32;
    var encodedNormal: f32;
    var position3DWC: vec3<f32>;
    var ellipsoidNormal: vec3<f32>;
    var param_18: vec3<f32>;
    var param_19: f32;
    var param_20: vec2<f32>;
    var dynamicLighting: bool;
    var atmosphereLightDirection: vec3<f32>;
    var lightDirection_2: vec3<f32>;
    var param_21: bool;
    var param_22: vec3<f32>;
    var param_23: vec3<f32>;
    var param_24: vec3<f32>;
    var param_25: vec3<f32>;
    var param_26: vec3<f32>;
    var param_27: vec3<f32>;
    var param_28: f32;

    let _e72 = position3DAndHeight_1;
    position_2 = _e72.xyz;
    let _e75 = position3DAndHeight_1[3u];
    height_2 = _e75;
    let _e76 = textureCoordAndEncodedNormals_1;
    textureCoordinates_2 = _e76.xy;
    let _e79 = textureCoordAndEncodedNormals_1[2u];
    webMercatorT = _e79;
    encodedNormal = 0f;
    let _e80 = position_2;
    let _e82 = czmUBO.u_center3D;
    position3DWC = (_e80 + _e82);
    let _e84 = position3DWC;
    ellipsoidNormal = normalize(_e84);
    let _e86 = position_2;
    param_18 = _e86;
    let _e87 = height_2;
    param_19 = _e87;
    let _e88 = textureCoordinates_2;
    param_20 = _e88;
    let _e89 = getPosition_u0028_vf3_u003b_f1_u003b_vf2_u003b((&param_18), (&param_19), (&param_20));
    unnamed.gl_Position = _e89;
    let _e92 = czmUBO.u_modifiedModelView;
    let _e93 = position_2;
    v_positionEC = (_e92 * vec4<f32>(_e93.x, _e93.y, _e93.z, 1f)).xyz;
    let _e100 = position3DWC;
    v_positionMC = _e100;
    let _e101 = textureCoordinates_2;
    let _e102 = webMercatorT;
    v_textureCoordinates = vec3<f32>(_e101.x, _e101.y, _e102);
    dynamicLighting = false;
    dynamicLighting = true;
    let _e107 = czmUBO.czm_sunDirectionWC;
    atmosphereLightDirection = _e107;
    let _e108 = position3DWC;
    let _e110 = dynamicLighting;
    param_21 = _e110;
    let _e111 = atmosphereLightDirection;
    param_22 = _e111;
    param_23 = normalize(_e108);
    let _e112 = czm_branchFreeTernary_u0028_b1_u003b_vf3_u003b_vf3_u003b((&param_21), (&param_22), (&param_23));
    lightDirection_2 = _e112;
    let _e113 = position3DWC;
    param_24 = _e113;
    let _e114 = lightDirection_2;
    param_25 = _e114;
    computeAtmosphereScattering_u0028_vf3_u003b_vf3_u003b_vf3_u003b_vf3_u003b_f1_u003b((&param_24), (&param_25), (&param_26), (&param_27), (&param_28));
    let _e115 = param_26;
    v_atmosphereRayleighColor = _e115;
    let _e116 = param_27;
    v_atmosphereMieColor = _e116;
    let _e117 = param_28;
    v_atmosphereOpacity = _e117;
    let _e119 = czmUBO.czm_modelView3D;
    let _e120 = position3DWC;
    v_distance = length((_e119 * vec4<f32>(_e120.x, _e120.y, _e120.z, 1f)).xyz);
    return;
}

@vertex 
fn main(@location(0) position3DAndHeight: vec4<f32>, @location(1) textureCoordAndEncodedNormals: vec4<f32>) -> VertexOutput {
    position3DAndHeight_1 = position3DAndHeight;
    textureCoordAndEncodedNormals_1 = textureCoordAndEncodedNormals;
    main_1();
    let _e16 = unnamed.gl_Position.y;
    unnamed.gl_Position.y = -(_e16);
    let _e18 = unnamed.gl_Position;
    let _e19 = v_positionEC;
    let _e20 = v_positionMC;
    let _e21 = v_textureCoordinates;
    let _e22 = v_atmosphereRayleighColor;
    let _e23 = v_atmosphereMieColor;
    let _e24 = v_atmosphereOpacity;
    let _e25 = v_distance;
    let _e26 = v_normalMC;
    let _e27 = v_normalEC;
    return VertexOutput(_e18, _e19, _e20, _e21, _e22, _e23, _e24, _e25, _e26, _e27);
}
