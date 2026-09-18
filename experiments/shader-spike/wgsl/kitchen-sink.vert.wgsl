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
    u_verticalExaggerationAndRelativeHeight: vec2<f32>,
    u_center3D: vec3<f32>,
    u_modifiedModelView: mat4x4<f32>,
    u_modifiedModelViewProjection: mat4x4<f32>,
    u_tileRectangle: vec4<f32>,
    u_southAndNorthLatitude: vec2<f32>,
    u_southMercatorYAndOneOverHeight: vec2<f32>,
    u_minMaxHeight: vec2<f32>,
    u_scaleAndBias: mat4x4<f32>,
}

struct gl_PerVertex {
    @builtin(position) gl_Position: vec4<f32>,
    gl_PointSize: f32,
}

struct VertexOutput {
    @builtin(position) gl_Position: vec4<f32>,
    @location(4) member: vec3<f32>,
    @location(3) member_1: vec3<f32>,
    @location(5) member_2: vec3<f32>,
    @location(6) member_3: vec3<f32>,
    @location(7) member_4: vec3<f32>,
    @location(9) member_5: vec3<f32>,
    @location(10) member_6: vec3<f32>,
    @location(11) member_7: f32,
    @location(8) member_8: f32,
}

@group(0) @binding(0) 
var<uniform> czmUBO: CZM_UBO;
var<private> compressed0_1: vec4<f32>;
var<private> compressed1_1: f32;
var<private> geodeticSurfaceNormal_1: vec3<f32>;
var<private> unnamed: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);
var<private> v_positionEC: vec3<f32>;
var<private> v_positionMC: vec3<f32>;
var<private> v_textureCoordinates: vec3<f32>;
var<private> v_normalMC: vec3<f32>;
var<private> v_normalEC: vec3<f32>;
var<private> v_atmosphereRayleighColor: vec3<f32>;
var<private> v_atmosphereMieColor: vec3<f32>;
var<private> v_atmosphereOpacity: f32;
var<private> v_distance: f32;

fn czm_approximateTanh_u0028_f1_u003b(x: ptr<function, f32>) -> f32 {
    var x2_: f32;

    let _e62 = (*x);
    let _e63 = (*x);
    x2_ = (_e62 * _e63);
    let _e65 = (*x);
    let _e66 = x2_;
    let _e69 = x2_;
    return max(-1f, min(1f, ((_e65 * (27f + _e66)) / (27f + (9f * _e69)))));
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

    let _e75 = (*ray).origin;
    o = _e75;
    let _e77 = (*ray).direction;
    d = _e77;
    let _e78 = o;
    let _e79 = (*center);
    oc = (_e78 - _e79);
    let _e81 = d;
    let _e82 = d;
    a = dot(_e81, _e82);
    let _e84 = d;
    let _e85 = oc;
    b = (2f * dot(_e84, _e85));
    let _e88 = oc;
    let _e89 = oc;
    let _e91 = (*radius);
    let _e92 = (*radius);
    c = (dot(_e88, _e89) - (_e91 * _e92));
    let _e95 = b;
    let _e96 = b;
    let _e98 = a;
    let _e100 = c;
    det = ((_e95 * _e96) - ((4f * _e98) * _e100));
    let _e103 = det;
    if (_e103 < 0f) {
        return czm_raySegment(-5906376400000f, -5906376400000f);
    }
    let _e105 = det;
    sqrtDet = sqrt(_e105);
    let _e107 = b;
    let _e109 = sqrtDet;
    let _e111 = a;
    t0_ = ((-(_e107) - _e109) / (2f * _e111));
    let _e114 = b;
    let _e116 = sqrtDet;
    let _e118 = a;
    t1_ = ((-(_e114) + _e116) / (2f * _e118));
    let _e121 = t0_;
    let _e122 = t1_;
    result = czm_raySegment(_e121, _e122);
    let _e124 = result;
    return _e124;
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
    let _e106 = (*atmosphereInnerRadius);
    atmosphereOuterRadius = (_e106 + 111000f);
    origin = vec3<f32>(0f, 0f, 0f);
    let _e108 = (*primaryRay);
    param = _e108;
    let _e109 = origin;
    param_1 = _e109;
    let _e110 = atmosphereOuterRadius;
    param_2 = _e110;
    let _e111 = czm_raySphereIntersectionInterval_u0028_struct_u002d_czm_ray_u002d_vf3_u002d_vf31_u003b_vf3_u003b_f1_u003b((&param), (&param_1), (&param_2));
    primaryRayAtmosphereIntersect = _e111;
    let _e112 = primaryRayAtmosphereIntersect;
    if ((_e112.start == czm_raySegment(-5906376400000f, -5906376400000f).start) && (_e112.stop == czm_raySegment(-5906376400000f, -5906376400000f).stop)) {
        return;
    }
    let _e121 = primaryRayAtmosphereIntersect.stop;
    let _e123 = (*primaryRayLength);
    x_1 = ((0.0000001f * _e121) / length(_e123));
    let _e126 = x_1;
    param_3 = _e126;
    let _e127 = czm_approximateTanh_u0028_f1_u003b((&param_3));
    w_stop_gt_lprl = (0.5f * (1f + _e127));
    let _e131 = primaryRayAtmosphereIntersect.start;
    start_0_ = _e131;
    let _e133 = primaryRayAtmosphereIntersect.start;
    primaryRayAtmosphereIntersect.start = max(_e133, 0f);
    let _e137 = primaryRayAtmosphereIntersect.stop;
    let _e138 = (*primaryRayLength);
    primaryRayAtmosphereIntersect.stop = min(_e137, length(_e138));
    let _e142 = start_0_;
    x_o_a = (_e142 - 111000f);
    let _e144 = x_o_a;
    param_4 = _e144;
    let _e145 = czm_approximateTanh_u0028_f1_u003b((&param_4));
    w_inside_atmosphere = (1f - (0.5f * (1f + _e145)));
    let _e149 = w_inside_atmosphere;
    PRIMARY_STEPS = (16i - i32((_e149 * 12f)));
    let _e153 = w_inside_atmosphere;
    LIGHT_STEPS = (4i - i32((_e153 * 2f)));
    let _e158 = primaryRayAtmosphereIntersect.start;
    rayPositionLength = _e158;
    let _e160 = primaryRayAtmosphereIntersect.stop;
    let _e161 = rayPositionLength;
    totalRayLength = (_e160 - _e161);
    let _e163 = w_inside_atmosphere;
    let _e164 = w_stop_gt_lprl;
    let _e166 = totalRayLength;
    let _e168 = PRIMARY_STEPS;
    let _e169 = PRIMARY_STEPS;
    rayStepLengthIncrease = (_e163 * (((1f - _e164) * _e166) / (f32((_e168 * (_e169 + 1i))) / 2f)));
    let _e176 = w_inside_atmosphere;
    let _e178 = w_stop_gt_lprl;
    let _e180 = totalRayLength;
    let _e182 = w_inside_atmosphere;
    let _e184 = PRIMARY_STEPS;
    rayStepLength = ((max((1f - _e176), _e178) * _e180) / max((7f * _e182), f32(_e184)));
    rayleighAccumulation = vec3<f32>(0f, 0f, 0f);
    mieAccumulation = vec3<f32>(0f, 0f, 0f);
    opticalDepth = vec2<f32>(0f, 0f);
    let _e189 = czmUBO.u_atmosphereRayleighScaleHeight;
    let _e191 = czmUBO.u_atmosphereMieScaleHeight;
    heightScale = vec2<f32>(_e189, _e191);
    i = 0i;
    loop {
        let _e193 = i;
        if (_e193 < 16i) {
            let _e195 = i;
            let _e196 = PRIMARY_STEPS;
            if (_e195 >= _e196) {
                break;
            }
            let _e199 = (*primaryRay).origin;
            let _e201 = (*primaryRay).direction;
            let _e202 = rayPositionLength;
            let _e203 = rayStepLength;
            samplePosition = (_e199 + (_e201 * (_e202 + _e203)));
            let _e207 = samplePosition;
            let _e209 = (*atmosphereInnerRadius);
            sampleHeight = (length(_e207) - _e209);
            let _e211 = sampleHeight;
            let _e213 = heightScale;
            let _e217 = rayStepLength;
            sampleDensity = (exp((vec2(-(_e211)) / _e213)) * _e217);
            let _e219 = sampleDensity;
            let _e220 = opticalDepth;
            opticalDepth = (_e220 + _e219);
            let _e222 = samplePosition;
            let _e223 = (*lightDirection);
            lightRay = czm_ray(_e222, _e223);
            let _e225 = lightRay;
            param_5 = _e225;
            let _e226 = origin;
            param_6 = _e226;
            let _e227 = atmosphereOuterRadius;
            param_7 = _e227;
            let _e228 = czm_raySphereIntersectionInterval_u0028_struct_u002d_czm_ray_u002d_vf3_u002d_vf31_u003b_vf3_u003b_f1_u003b((&param_5), (&param_6), (&param_7));
            lightRayAtmosphereIntersect = _e228;
            let _e230 = lightRayAtmosphereIntersect.stop;
            let _e231 = LIGHT_STEPS;
            lightStepLength = (_e230 / f32(_e231));
            lightPositionLength = 0f;
            lightOpticalDepth = vec2<f32>(0f, 0f);
            j = 0i;
            loop {
                let _e234 = j;
                if (_e234 < 4i) {
                    let _e236 = j;
                    let _e237 = LIGHT_STEPS;
                    if (_e236 >= _e237) {
                        break;
                    }
                    let _e239 = samplePosition;
                    let _e240 = (*lightDirection);
                    let _e241 = lightPositionLength;
                    let _e242 = lightStepLength;
                    lightPosition = (_e239 + (_e240 * (_e241 + (_e242 * 0.5f))));
                    let _e247 = lightPosition;
                    let _e249 = (*atmosphereInnerRadius);
                    lightHeight = (length(_e247) - _e249);
                    let _e251 = lightHeight;
                    let _e253 = heightScale;
                    let _e257 = lightStepLength;
                    let _e259 = lightOpticalDepth;
                    lightOpticalDepth = (_e259 + (exp((vec2(-(_e251)) / _e253)) * _e257));
                    let _e261 = lightStepLength;
                    let _e262 = lightPositionLength;
                    lightPositionLength = (_e262 + _e261);
                    continue;
                } else {
                    break;
                }
                continuing {
                    let _e264 = j;
                    j = (_e264 + 1i);
                }
            }
            let _e267 = czmUBO.u_atmosphereMieCoefficient;
            let _e269 = opticalDepth[1u];
            let _e271 = lightOpticalDepth[1u];
            let _e275 = czmUBO.u_atmosphereRayleighCoefficient;
            let _e277 = opticalDepth[0u];
            let _e279 = lightOpticalDepth[0u];
            attenuation = exp(-(((_e267 * (_e269 + _e271)) + (_e275 * (_e277 + _e279)))));
            let _e286 = sampleDensity[0u];
            let _e287 = attenuation;
            let _e289 = rayleighAccumulation;
            rayleighAccumulation = (_e289 + (_e287 * _e286));
            let _e292 = sampleDensity[1u];
            let _e293 = attenuation;
            let _e295 = mieAccumulation;
            mieAccumulation = (_e295 + (_e293 * _e292));
            let _e297 = rayStepLengthIncrease;
            let _e298 = rayStepLength;
            let _e299 = (_e298 + _e297);
            rayStepLength = _e299;
            let _e300 = rayPositionLength;
            rayPositionLength = (_e300 + _e299);
            continue;
        } else {
            break;
        }
        continuing {
            let _e302 = i;
            i = (_e302 + 1i);
        }
    }
    let _e305 = czmUBO.u_atmosphereRayleighCoefficient;
    let _e306 = rayleighAccumulation;
    (*rayleighColor) = (_e305 * _e306);
    let _e309 = czmUBO.u_atmosphereMieCoefficient;
    let _e310 = mieAccumulation;
    (*mieColor) = (_e309 * _e310);
    let _e313 = czmUBO.u_atmosphereMieCoefficient;
    let _e315 = opticalDepth[1u];
    let _e318 = czmUBO.u_atmosphereRayleighCoefficient;
    let _e320 = opticalDepth[0u];
    (*opacity) = length(exp(-(((_e313 * _e315) + (_e318 * _e320)))));
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

    let _e76 = (*positionWC);
    let _e78 = czmUBO.czm_viewerPositionWC;
    cameraToPositionWC = (_e76 - _e78);
    let _e80 = cameraToPositionWC;
    cameraToPositionWCDirection = normalize(_e80);
    let _e83 = czmUBO.czm_viewerPositionWC;
    let _e84 = cameraToPositionWCDirection;
    primaryRay_1 = czm_ray(_e83, _e84);
    let _e86 = (*positionWC);
    atmosphereInnerRadius_1 = length(_e86);
    let _e88 = cameraToPositionWC;
    let _e90 = primaryRay_1;
    param_8 = _e90;
    param_9 = length(_e88);
    let _e91 = (*lightDirection_1);
    param_10 = _e91;
    let _e92 = atmosphereInnerRadius_1;
    param_11 = _e92;
    computeScattering_u0028_struct_u002d_czm_ray_u002d_vf3_u002d_vf31_u003b_f1_u003b_vf3_u003b_f1_u003b_vf3_u003b_vf3_u003b_f1_u003b((&param_8), (&param_9), (&param_10), (&param_11), (&param_12), (&param_13), (&param_14));
    let _e93 = param_12;
    (*rayleighColor_1) = _e93;
    let _e94 = param_13;
    (*mieColor_1) = _e94;
    let _e95 = param_14;
    (*opacity_1) = _e95;
    return;
}

fn czm_branchFreeTernary_u0028_b1_u003b_vf3_u003b_vf3_u003b(comparison: ptr<function, bool>, a_1: ptr<function, vec3<f32>>, b_1: ptr<function, vec3<f32>>) -> vec3<f32> {
    var useA: f32;

    let _e64 = (*comparison);
    useA = select(0f, 1f, _e64);
    let _e66 = (*a_1);
    let _e67 = useA;
    let _e69 = (*b_1);
    let _e70 = useA;
    return ((_e66 * _e67) + (_e69 * (1f - _e70)));
}

fn czm_signNotZero_u0028_f1_u003b(value: ptr<function, f32>) -> f32 {
    let _e61 = (*value);
    return select(-1f, 1f, (_e61 >= 0f));
}

fn czm_signNotZero_u0028_vf2_u003b(value_1: ptr<function, vec2<f32>>) -> vec2<f32> {
    var param_15: f32;
    var param_16: f32;

    let _e64 = (*value_1)[0u];
    param_15 = _e64;
    let _e65 = czm_signNotZero_u0028_f1_u003b((&param_15));
    let _e67 = (*value_1)[1u];
    param_16 = _e67;
    let _e68 = czm_signNotZero_u0028_f1_u003b((&param_16));
    return vec2<f32>(_e65, _e68);
}

fn czm_octDecode_u0028_vf2_u003b_f1_u003b(encoded: ptr<function, vec2<f32>>, range: ptr<function, f32>) -> vec3<f32> {
    var v: vec3<f32>;
    var param_17: vec2<f32>;
    var phi_130_: bool;

    let _e65 = (*encoded)[0u];
    let _e66 = (_e65 == 0f);
    phi_130_ = _e66;
    if _e66 {
        let _e68 = (*encoded)[1u];
        phi_130_ = (_e68 == 0f);
    }
    let _e71 = phi_130_;
    if _e71 {
        return vec3<f32>(0f, 0f, 0f);
    }
    let _e72 = (*encoded);
    let _e73 = (*range);
    (*encoded) = (((_e72 / vec2(_e73)) * 2f) - vec2(1f));
    let _e80 = (*encoded)[0u];
    let _e82 = (*encoded)[1u];
    let _e84 = (*encoded)[0u];
    let _e88 = (*encoded)[1u];
    v = vec3<f32>(_e80, _e82, ((1f - abs(_e84)) - abs(_e88)));
    let _e93 = v[2u];
    if (_e93 < 0f) {
        let _e95 = v;
        let _e100 = v;
        param_17 = _e100.xy;
        let _e102 = czm_signNotZero_u0028_vf2_u003b((&param_17));
        let _e103 = ((vec2(1f) - abs(_e95.yx)) * _e102);
        v[0u] = _e103.x;
        v[1u] = _e103.y;
    }
    let _e108 = v;
    return normalize(_e108);
}

fn czm_octDecode_u0028_vf2_u003b(encoded_1: ptr<function, vec2<f32>>) -> vec3<f32> {
    var param_18: vec2<f32>;
    var param_19: f32;

    let _e63 = (*encoded_1);
    param_18 = _e63;
    param_19 = 255f;
    let _e64 = czm_octDecode_u0028_vf2_u003b_f1_u003b((&param_18), (&param_19));
    return _e64;
}

fn czm_octDecode_u0028_f1_u003b(encoded_2: ptr<function, f32>) -> vec3<f32> {
    var temp: f32;
    var x_2: f32;
    var y: f32;
    var param_20: vec2<f32>;

    let _e65 = (*encoded_2);
    temp = (_e65 / 256f);
    let _e67 = temp;
    x_2 = floor(_e67);
    let _e69 = temp;
    let _e70 = x_2;
    y = ((_e69 - _e70) * 256f);
    let _e73 = x_2;
    let _e74 = y;
    param_20 = vec2<f32>(_e73, _e74);
    let _e76 = czm_octDecode_u0028_vf2_u003b((&param_20));
    return _e76;
}

fn getPosition3DMode_u0028_vf3_u003b_f1_u003b_vf2_u003b(position: ptr<function, vec3<f32>>, height: ptr<function, f32>, textureCoordinates: ptr<function, vec2<f32>>) -> vec4<f32> {
    let _e64 = czmUBO.u_modifiedModelViewProjection;
    let _e65 = (*position);
    return (_e64 * vec4<f32>(_e65.x, _e65.y, _e65.z, 1f));
}

fn getPosition_u0028_vf3_u003b_f1_u003b_vf2_u003b(position_1: ptr<function, vec3<f32>>, height_1: ptr<function, f32>, textureCoordinates_1: ptr<function, vec2<f32>>) -> vec4<f32> {
    var param_21: vec3<f32>;
    var param_22: f32;
    var param_23: vec2<f32>;

    let _e66 = (*position_1);
    param_21 = _e66;
    let _e67 = (*height_1);
    param_22 = _e67;
    let _e68 = (*textureCoordinates_1);
    param_23 = _e68;
    let _e69 = getPosition3DMode_u0028_vf3_u003b_f1_u003b_vf2_u003b((&param_21), (&param_22), (&param_23));
    return _e69;
}

fn czm_decompressTextureCoordinates_u0028_f1_u003b(encoded_3: ptr<function, f32>) -> vec2<f32> {
    var temp_1: f32;
    var xZeroTo4095_: f32;
    var stx: f32;
    var sty: f32;

    let _e65 = (*encoded_3);
    temp_1 = (_e65 / 4096f);
    let _e67 = temp_1;
    xZeroTo4095_ = floor(_e67);
    let _e69 = xZeroTo4095_;
    stx = (_e69 / 4095f);
    let _e71 = (*encoded_3);
    let _e72 = xZeroTo4095_;
    sty = ((_e71 - (_e72 * 4096f)) / 4095f);
    let _e76 = stx;
    let _e77 = sty;
    return vec2<f32>(_e76, _e77);
}

fn main_1() {
    var xy: vec2<f32>;
    var param_24: f32;
    var zh: vec2<f32>;
    var param_25: f32;
    var position_2: vec3<f32>;
    var height_2: f32;
    var textureCoordinates_2: vec2<f32>;
    var param_26: f32;
    var webMercatorT: f32;
    var param_27: f32;
    var encodedNormal: f32;
    var position3DWC: vec3<f32>;
    var ellipsoidNormal: vec3<f32>;
    var exaggeration: f32;
    var relativeHeight: f32;
    var newHeight: f32;
    var minRadius: f32;
    var offset: vec3<f32>;
    var param_28: vec3<f32>;
    var param_29: f32;
    var param_30: vec2<f32>;
    var normalMC: vec3<f32>;
    var param_31: f32;
    var projection: vec3<f32>;
    var rejection: vec3<f32>;
    var dynamicLighting: bool;
    var atmosphereLightDirection: vec3<f32>;
    var lightDirection_2: vec3<f32>;
    var param_32: bool;
    var param_33: vec3<f32>;
    var param_34: vec3<f32>;
    var param_35: vec3<f32>;
    var param_36: vec3<f32>;
    var param_37: vec3<f32>;
    var param_38: vec3<f32>;
    var param_39: f32;

    let _e97 = compressed0_1[0u];
    param_24 = _e97;
    let _e98 = czm_decompressTextureCoordinates_u0028_f1_u003b((&param_24));
    xy = _e98;
    let _e100 = compressed0_1[1u];
    param_25 = _e100;
    let _e101 = czm_decompressTextureCoordinates_u0028_f1_u003b((&param_25));
    zh = _e101;
    let _e102 = xy;
    let _e104 = zh[0u];
    position_2 = vec3<f32>(_e102.x, _e102.y, _e104);
    let _e109 = zh[1u];
    height_2 = _e109;
    let _e111 = compressed0_1[2u];
    param_26 = _e111;
    let _e112 = czm_decompressTextureCoordinates_u0028_f1_u003b((&param_26));
    textureCoordinates_2 = _e112;
    let _e113 = height_2;
    let _e116 = czmUBO.u_minMaxHeight[1u];
    let _e119 = czmUBO.u_minMaxHeight[0u];
    let _e124 = czmUBO.u_minMaxHeight[0u];
    height_2 = ((_e113 * (_e116 - _e119)) + _e124);
    let _e127 = czmUBO.u_scaleAndBias;
    let _e128 = position_2;
    position_2 = (_e127 * vec4<f32>(_e128.x, _e128.y, _e128.z, 1f)).xyz;
    let _e136 = compressed0_1[3u];
    param_27 = _e136;
    let _e137 = czm_decompressTextureCoordinates_u0028_f1_u003b((&param_27));
    webMercatorT = _e137.x;
    let _e139 = compressed1_1;
    encodedNormal = _e139;
    let _e140 = position_2;
    let _e142 = czmUBO.u_center3D;
    position3DWC = (_e140 + _e142);
    let _e144 = geodeticSurfaceNormal_1;
    ellipsoidNormal = _e144;
    let _e147 = czmUBO.u_verticalExaggerationAndRelativeHeight[0u];
    exaggeration = _e147;
    let _e150 = czmUBO.u_verticalExaggerationAndRelativeHeight[1u];
    relativeHeight = _e150;
    let _e151 = height_2;
    let _e152 = relativeHeight;
    let _e154 = exaggeration;
    let _e156 = relativeHeight;
    newHeight = (((_e151 - _e152) * _e154) + _e156);
    let _e160 = czmUBO.czm_ellipsoidRadii[0u];
    let _e163 = czmUBO.czm_ellipsoidRadii[1u];
    let _e167 = czmUBO.czm_ellipsoidRadii[2u];
    minRadius = min(min(_e160, _e163), _e167);
    let _e169 = newHeight;
    let _e170 = minRadius;
    newHeight = max(_e169, -(_e170));
    let _e173 = ellipsoidNormal;
    let _e174 = newHeight;
    let _e175 = height_2;
    offset = (_e173 * (_e174 - _e175));
    let _e178 = offset;
    let _e179 = position_2;
    position_2 = (_e179 + _e178);
    let _e181 = offset;
    let _e182 = position3DWC;
    position3DWC = (_e182 + _e181);
    let _e184 = newHeight;
    height_2 = _e184;
    let _e185 = position_2;
    param_28 = _e185;
    let _e186 = height_2;
    param_29 = _e186;
    let _e187 = textureCoordinates_2;
    param_30 = _e187;
    let _e188 = getPosition_u0028_vf3_u003b_f1_u003b_vf2_u003b((&param_28), (&param_29), (&param_30));
    unnamed.gl_Position = _e188;
    let _e191 = czmUBO.u_modifiedModelView;
    let _e192 = position_2;
    v_positionEC = (_e191 * vec4<f32>(_e192.x, _e192.y, _e192.z, 1f)).xyz;
    let _e199 = position3DWC;
    v_positionMC = _e199;
    let _e200 = textureCoordinates_2;
    let _e201 = webMercatorT;
    v_textureCoordinates = vec3<f32>(_e200.x, _e200.y, _e201);
    let _e205 = encodedNormal;
    param_31 = _e205;
    let _e206 = czm_octDecode_u0028_f1_u003b((&param_31));
    normalMC = _e206;
    let _e207 = normalMC;
    let _e208 = ellipsoidNormal;
    let _e210 = ellipsoidNormal;
    projection = (_e210 * dot(_e207, _e208));
    let _e212 = normalMC;
    let _e213 = projection;
    rejection = (_e212 - _e213);
    let _e215 = projection;
    let _e216 = rejection;
    let _e217 = exaggeration;
    normalMC = normalize((_e215 + (_e216 * _e217)));
    let _e221 = normalMC;
    v_normalMC = _e221;
    let _e223 = czmUBO.czm_normal3D;
    let _e224 = v_normalMC;
    v_normalEC = (_e223 * _e224);
    dynamicLighting = false;
    dynamicLighting = true;
    let _e227 = czmUBO.czm_sunDirectionWC;
    atmosphereLightDirection = _e227;
    let _e228 = position3DWC;
    let _e230 = dynamicLighting;
    param_32 = _e230;
    let _e231 = atmosphereLightDirection;
    param_33 = _e231;
    param_34 = normalize(_e228);
    let _e232 = czm_branchFreeTernary_u0028_b1_u003b_vf3_u003b_vf3_u003b((&param_32), (&param_33), (&param_34));
    lightDirection_2 = _e232;
    let _e233 = position3DWC;
    param_35 = _e233;
    let _e234 = lightDirection_2;
    param_36 = _e234;
    computeAtmosphereScattering_u0028_vf3_u003b_vf3_u003b_vf3_u003b_vf3_u003b_f1_u003b((&param_35), (&param_36), (&param_37), (&param_38), (&param_39));
    let _e235 = param_37;
    v_atmosphereRayleighColor = _e235;
    let _e236 = param_38;
    v_atmosphereMieColor = _e236;
    let _e237 = param_39;
    v_atmosphereOpacity = _e237;
    let _e239 = czmUBO.czm_modelView3D;
    let _e240 = position3DWC;
    v_distance = length((_e239 * vec4<f32>(_e240.x, _e240.y, _e240.z, 1f)).xyz);
    return;
}

@vertex 
fn main(@location(0) compressed0_: vec4<f32>, @location(1) compressed1_: f32, @location(2) geodeticSurfaceNormal: vec3<f32>) -> VertexOutput {
    compressed0_1 = compressed0_;
    compressed1_1 = compressed1_;
    geodeticSurfaceNormal_1 = geodeticSurfaceNormal;
    main_1();
    let _e18 = unnamed.gl_Position.y;
    unnamed.gl_Position.y = -(_e18);
    let _e20 = unnamed.gl_Position;
    let _e21 = v_positionEC;
    let _e22 = v_positionMC;
    let _e23 = v_textureCoordinates;
    let _e24 = v_normalMC;
    let _e25 = v_normalEC;
    let _e26 = v_atmosphereRayleighColor;
    let _e27 = v_atmosphereMieColor;
    let _e28 = v_atmosphereOpacity;
    let _e29 = v_distance;
    return VertexOutput(_e20, _e21, _e22, _e23, _e24, _e25, _e26, _e27, _e28, _e29);
}
