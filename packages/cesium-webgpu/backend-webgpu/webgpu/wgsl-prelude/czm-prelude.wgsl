// ============================================================================================
// cesium-webgpu WebGPU backend layer — WGSL leaf library (tasks.md T068/T069, contract R3/R6).
//
// GLSL source of truth: node_modules/@cesium/engine/Source/Shaders/Builtin/**
// Ported from the verified leaf (webgpu/wgsl/leaves/prelude.wgsl);
// the port is 1:1 — every WGSL-forced construction is called out in place (W1..W7 / D1..D4).
//
// This file is a TEMPLATE: it uses the GLSL conditional-directive syntax (#if/#elif/#else/
// #endif/#ifdef) which WGSL does not have. The directives are resolved per variant by
// webgpu/glsl-preprocess.ts (contract R4) before the module text is produced; the emitted
// modules are what a device sees. Consequence for tooling: this file is NOT a standalone WGSL
// module, so 	ools/scripts/check-wgsl.mjs validates its **emitted** form.
// ============================================================================================

const czm_pi: f32 = 3.141592653589793;
const czm_twoPi: f32 = 6.283185307179586;
const czm_oneOverPi: f32 = 0.3183098861837907;
const czm_oneOverTwoPi: f32 = 0.15915494309189535;
const czm_infinity: f32 = 3.402823466e38;
const czm_epsilon2: f32 = 1e-2;
const czm_webMercatorMaxLatitude: f32 = 1.4844222297453324;
const czm_sceneMode2D: f32 = 2.0;
const czm_sceneMode3D: f32 = 3.0;
const czm_sceneModeColumbusView: f32 = 1.0;
const czm_sceneModeMorphing: f32 = 0.0;

// ============================================================================================
// Backend-layer helper pair — **not** an upstream `czm_` name (tasks.md T074).
//
// GL clip space has z in [-w, w]; the WebGPU NDC cube has z in [0, w], and a vertex position
// written outside it is **clipped**. `u_modifiedModelViewProjection` is the upstream GL matrix, so
// every `@builtin(position)` write is remapped here, and every consumer that reconstructs eye
// coordinates from a depth value has to undo the same remap — hence a **pair** of functions in one
// place. The GLSL side is left untouched (`Core/PerspectiveFrustum.js` and `Renderer/UniformState.js`
// are kept modules; changing them to emit a [0,1] projection would violate principle I):
//
//   clipToNdc:  z' = (z + w) / 2      ⇒  z_ndc = 0.5 * z_clip + 0.5 * w_clip
//   ndcToClip:  z  = 2 * z_ndc - w    ⇒  the inverse, used before `czm_inverseProjection`
//
// `w` is preserved, so perspective-correct interpolation and the `w`-divide stay exactly as GL
// performed them, and `@builtin(frag_depth)` (which is already [0,1] on both APIs) is not touched.
// ============================================================================================

fn czms_remapClipDepth(position: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(position.x, position.y, 0.5 * position.z + 0.5 * position.w, position.w);
}

fn czms_unprojectDepth(ndcDepth: f32) -> f32 {
  return 2.0 * ndcDepth - 1.0;
}

struct CzmsRay {
  origin: vec3<f32>,
  direction: vec3<f32>,
};

struct CzmsRaySegment {
  valid: bool,
  start: f32,
  stop: f32,
};

fn czms_emptyRaySegment() -> CzmsRaySegment { return CzmsRaySegment(false, 0.0, 0.0); }   // W3

fn czms_pointAlongRay(ray: CzmsRay, time: f32) -> vec3<f32> {
  return ray.origin + (time * ray.direction);
}

fn czms_raySphereIntersectionInterval(ray: CzmsRay, center: vec3<f32>, radius: f32) -> CzmsRaySegment {
  let o = ray.origin;
  let d = ray.direction;
  let oc = o - center;
  let a = dot(d, d);
  let b = 2.0 * dot(d, oc);
  let c = dot(oc, oc) - (radius * radius);
  let det = (b * b) - (4.0 * a * c);
  if (det < 0.0) { return czms_emptyRaySegment(); }
  let sqrtDet = sqrt(det);
  return CzmsRaySegment(true, (-b - sqrtDet) / (2.0 * a), (-b + sqrtDet) / (2.0 * a));
}

fn czms_rayEllipsoidIntersectionInterval(ray: CzmsRay, ellipsoidCenter: vec3<f32>, ellipsoidInverseRadii: vec3<f32>) -> CzmsRaySegment {
  var q = ellipsoidInverseRadii * (czm.czm_inverseModelView * vec4<f32>(ray.origin, 1.0)).xyz;
  let w = ellipsoidInverseRadii * (czm.czm_inverseModelView * vec4<f32>(ray.direction, 0.0)).xyz;
  q = q - ellipsoidInverseRadii * (czm.czm_inverseModelView * vec4<f32>(ellipsoidCenter, 1.0)).xyz;
  let q2 = dot(q, q);
  let qw = dot(q, w);
  let w2 = dot(w, w);
  if (q2 > 1.0) {
    if (qw >= 0.0) { return czms_emptyRaySegment(); }
    let qw2 = qw * qw;
    let difference = q2 - 1.0;
    let product = w2 * difference;
    if (qw2 < product) { return czms_emptyRaySegment(); }
    if (qw2 > product) {
      let discriminant = qw * qw - product;
      let temp = -qw + sqrt(discriminant);
      let root0 = temp / w2;
      let root1 = difference / temp;
      // W3b: `select()` is not overloaded for structs, so the GLSL ordering choice becomes an if.
      if (root0 < root1) { return CzmsRaySegment(true, root0, root1); }
      return CzmsRaySegment(true, root1, root0);
    }
    let root = sqrt(difference / w2);
    return CzmsRaySegment(true, root, root);
  }
  if (q2 < 1.0) {
    let difference = q2 - 1.0;
    let product = w2 * difference;
    let discriminant = qw * qw - product;
    let temp = -qw + sqrt(discriminant);
    return CzmsRaySegment(true, 0.0, temp / w2);
  }
  if (qw < 0.0) { return CzmsRaySegment(true, 0.0, -qw / w2); }
  return czms_emptyRaySegment();
}

fn czms_approximateTanh(x: f32) -> f32 {
  let x2 = x * x;
  return max(-1.0, min(1.0, x * (27.0 + x2) / (27.0 + 9.0 * x2)));
}

fn czms_signNotZero(value: f32) -> f32 { return select(-1.0, 1.0, value >= 0.0); }              // W6
fn czms_signNotZero2(value: vec2<f32>) -> vec2<f32> { return vec2<f32>(czms_signNotZero(value.x), czms_signNotZero(value.y)); }
fn czms_signNotZero3(value: vec3<f32>) -> vec3<f32> { return vec3<f32>(czms_signNotZero(value.x), czms_signNotZero(value.y), czms_signNotZero(value.z)); }

fn czms_branchFreeTernary(comparison: bool, a: f32, b: f32) -> f32 {
  let useA = select(0.0, 1.0, comparison);
  return a * useA + b * (1.0 - useA);
}
fn czms_branchFreeTernary3(comparison: bool, a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
  let useA = select(0.0, 1.0, comparison);
  return a * useA + b * (1.0 - useA);
}
fn czms_branchFreeTernary4(comparison: bool, a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  let useA = select(0.0, 1.0, comparison);
  return a * useA + b * (1.0 - useA);
}

fn czms_decompressTextureCoordinates(encoded: f32) -> vec2<f32> {
  let temp = encoded / 4096.0;
  let xZeroTo4095 = floor(temp);
  let stx = xZeroTo4095 / 4095.0;
  let sty = (encoded - xZeroTo4095 * 4096.0) / 4095.0;
  return vec2<f32>(stx, sty);
}

// W1: `czm_octDecode(vec2, float)` / `(vec2)` / `(float)` become distinct names.
fn czms_octDecodeRange(encoded: vec2<f32>, range: f32) -> vec3<f32> {
  if (encoded.x == 0.0 && encoded.y == 0.0) { return vec3<f32>(0.0, 0.0, 0.0); }
  let e = encoded / range * 2.0 - 1.0;
  var v = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) {
    let xy = (vec2<f32>(1.0, 1.0) - abs(vec2<f32>(v.y, v.x))) * czms_signNotZero2(vec2<f32>(v.x, v.y));
    v = vec3<f32>(xy.x, xy.y, v.z);
  }
  return normalize(v);
}

fn czms_octDecode(encoded: vec2<f32>) -> vec3<f32> { return czms_octDecodeRange(encoded, 255.0); }

fn czms_octDecodeFloat(encoded: f32) -> vec3<f32> {
  let temp = encoded / 256.0;
  let x = floor(temp);
  let y = (temp - x) * 256.0;
  return czms_octDecode(vec2<f32>(x, y));
}

fn czms_latitudeToWebMercatorFraction(latitude: f32, southMercatorY: f32, oneOverMercatorHeight: f32) -> f32 {
  let sinLatitude = sin(latitude);
  let mercatorY = 0.5 * log((1.0 + sinLatitude) / (1.0 - sinLatitude));
  return (mercatorY - southMercatorY) * oneOverMercatorHeight;
}

fn czms_maximumComponent3(v: vec3<f32>) -> f32 { return max(max(v.x, v.y), v.z); }
fn czms_maximumComponent4(v: vec4<f32>) -> f32 { return max(max(max(v.x, v.y), v.z), v.w); }

// W7: WGSL swizzles are limited to the `xyzw` / `rgba` sets, so the GLSL `.st` / `.pq` halves of a
// `vec4` become explicit helpers (used by `getPositionPlanarEarth`).
fn czms_st(v: vec4<f32>) -> vec2<f32> { return vec2<f32>(v.x, v.y); }
fn czms_pq(v: vec4<f32>) -> vec2<f32> { return vec2<f32>(v.z, v.w); }

fn czms_gammaCorrect3(color: vec3<f32>) -> vec3<f32> {
#ifdef HDR
  return pow(color, vec3<f32>(czm.czm_gamma));
#else
  return color;
#endif
}
fn czms_gammaCorrect4(color: vec4<f32>) -> vec4<f32> {
#ifdef HDR
  return vec4<f32>(pow(color.rgb, vec3<f32>(czm.czm_gamma)), color.a);
#else
  return color;
#endif
}

fn czms_inverseGamma(color: vec3<f32>) -> vec3<f32> { return pow(color, vec3<f32>(1.0 / czm.czm_gamma)); }

fn czms_hue(rgb: vec3<f32>, adjustment: f32) -> vec3<f32> {
  let toYIQ = mat3x3<f32>(0.299, 0.587, 0.114, 0.595716, -0.274453, -0.321263, 0.211456, -0.522591, 0.311135);
  let toRGB = mat3x3<f32>(1.0, 0.9563, 0.6210, 1.0, -0.2721, -0.6474, 1.0, -1.107, 1.7046);
  let yiq = toYIQ * rgb;
  let hue = atan2(yiq.z, yiq.y) + adjustment;                                                   // W2
  let chroma = sqrt(yiq.z * yiq.z + yiq.y * yiq.y);
  let color = vec3<f32>(yiq.x, chroma * cos(hue), chroma * sin(hue));
  return toRGB * color;
}

fn czms_saturation(rgb: vec3<f32>, adjustment: f32) -> vec3<f32> {
  let W = vec3<f32>(0.2125, 0.7154, 0.0721);
  let intensity = vec3<f32>(dot(rgb, W));
  return mix(intensity, rgb, adjustment);
}

fn czms_getLambertDiffuse(lightDirectionEC: vec3<f32>, normalEC: vec3<f32>) -> f32 {
  return max(dot(lightDirectionEC, normalEC), 0.0);
}

fn czms_getSpecular(lightDirectionEC: vec3<f32>, toEyeEC: vec3<f32>, normalEC: vec3<f32>, shininess: f32) -> f32 {
  let toReflectedLight = reflect(-lightDirectionEC, normalEC);
  let specular = max(dot(toReflectedLight, toEyeEC), 0.0);
  return pow(specular, max(shininess, czm_epsilon2));
}

fn czms_geodeticSurfaceNormal(positionOnEllipsoid: vec3<f32>, ellipsoidCenter: vec3<f32>, oneOverEllipsoidRadiiSquared: vec3<f32>) -> vec3<f32> {
  return normalize((positionOnEllipsoid - ellipsoidCenter) * oneOverEllipsoidRadiiSquared);
}

fn czms_eastNorthUpToEyeCoordinates(positionMC: vec3<f32>, normalEC: vec3<f32>) -> mat3x3<f32> {
  let tangentMC = normalize(vec3<f32>(-positionMC.y, positionMC.x, 0.0));
  let tangentEC = normalize(czm.czm_normal3D * tangentMC);
  let bitangentEC = normalize(cross(normalEC, tangentEC));
  return mat3x3<f32>(
    tangentEC.x, tangentEC.y, tangentEC.z,
    bitangentEC.x, bitangentEC.y, bitangentEC.z,
    normalEC.x, normalEC.y, normalEC.z);
}

fn czms_ellipsoidTextureCoordinates(normal: vec3<f32>) -> vec2<f32> {
  return vec2<f32>(atan2(normal.y, normal.x) * czm_oneOverTwoPi + 0.5, asin(normal.z) * czm_oneOverPi + 0.5);
}

// W4: `texture(sampler2D, uv)` with implicit LOD → explicit level 0 (no mip levels in this path, and
// `textureSample` is not allowed in non-uniform control flow, which the water path needs).
fn czms_getWaterNoise(normalMap: texture_2d<f32>, normalMapSampler: sampler, uv: vec2<f32>, time: f32, angleInRadians: f32) -> vec4<f32> {
  let cosAngle = cos(angleInRadians);
  let sinAngle = sin(angleInRadians);
  var s0 = vec2<f32>(1.0 / 17.0, 0.0);
  var s1 = vec2<f32>(-1.0 / 29.0, 0.0);
  var s2 = vec2<f32>(1.0 / 101.0, 1.0 / 59.0);
  var s3 = vec2<f32>(-1.0 / 109.0, -1.0 / 57.0);
  s0 = vec2<f32>((cosAngle * s0.x) - (sinAngle * s0.y), (sinAngle * s0.x) + (cosAngle * s0.y));
  s1 = vec2<f32>((cosAngle * s1.x) - (sinAngle * s1.y), (sinAngle * s1.x) + (cosAngle * s1.y));
  s2 = vec2<f32>((cosAngle * s2.x) - (sinAngle * s2.y), (sinAngle * s2.x) + (cosAngle * s2.y));
  s3 = vec2<f32>((cosAngle * s3.x) - (sinAngle * s3.y), (sinAngle * s3.x) + (cosAngle * s3.y));
  let uv0 = fract((uv / 103.0) + (time * s0));
  let uv1 = fract(uv / 107.0 + (time * s1) + vec2<f32>(0.23));
  let uv2 = fract(uv / vec2<f32>(897.0, 983.0) + (time * s2) + vec2<f32>(0.51));
  let uv3 = fract(uv / vec2<f32>(991.0, 877.0) + (time * s3) + vec2<f32>(0.71));
  let noise = textureSampleLevel(normalMap, normalMapSampler, uv0, 0.0)
    + textureSampleLevel(normalMap, normalMapSampler, uv1, 0.0)
    + textureSampleLevel(normalMap, normalMapSampler, uv2, 0.0)
    + textureSampleLevel(normalMap, normalMapSampler, uv3, 0.0);
  return ((noise / 4.0) - vec4<f32>(0.5)) * 2.0;
}

fn czms_fog3(distanceToCamera: f32, color: vec3<f32>, fogColor: vec3<f32>) -> vec3<f32> {
  let scalar = distanceToCamera * czm.czm_fogDensity;
  let fog = 1.0 - exp(-(scalar * scalar));
  return mix(color, fogColor, fog);
}

fn czms_fog4(distanceToCamera: f32, color: vec3<f32>, fogColor: vec3<f32>, fogModifierConstant: f32) -> vec3<f32> {
  let scalar = distanceToCamera * czm.czm_fogDensity;
  let fog = 1.0 - exp(-((fogModifierConstant * scalar + fogModifierConstant) * (scalar * (1.0 + fogModifierConstant))));
  return mix(color, fogColor, fog);
}

fn czms_pbrNeutralTonemapping(color: vec3<f32>) -> vec3<f32> {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  let x = min(color.r, min(color.g, color.b));
  let offset = czms_branchFreeTernary(x < 0.08, x - 6.25 * x * x, 0.04);
  var c = color - vec3<f32>(offset);
  let peak = max(c.r, max(c.g, c.b));
  if (peak < startCompression) { return c; }
  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  c = c * (newPeak / peak);
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(c, newPeak * vec3<f32>(1.0, 1.0, 1.0), g);
}

// ------------------------------------------------------------------------------------------------
// AtmosphereCommon.glsl — shared by BOTH stages: GlobeVS.glsl:212-235 precomputes the per-vertex
// scattering for the `GROUND_ATMOSPHERE && !PER_FRAGMENT_GROUND_ATMOSPHERE` configuration, while
// GlobeFS.glsl:494-510 either reuses those varyings or recomputes per fragment. (Placing these in
// the fragment-only library was the first version of this gate's emitter and the real device caught
// it immediately: `unresolved call target 'computeAtmosphereScattering'` in the vertex module.)
// ------------------------------------------------------------------------------------------------

struct AtmosphereScattering {
  rayleighColor: vec3<f32>,
  mieColor: vec3<f32>,
  opacity: f32,
};

// AtmosphereCommon.glsl:27-157 (`computeScattering`)
fn computeScattering(primaryRay: CzmsRay, primaryRayLength: f32, lightDirection: vec3<f32>, atmosphereInnerRadius: f32) -> AtmosphereScattering {
  let ATMOSPHERE_THICKNESS: f32 = 111e3;
  let PRIMARY_STEPS_MAX: i32 = 16;
  let LIGHT_STEPS_MAX: i32 = 4;

  var rayleighColor = vec3<f32>(0.0);
  var mieColor = vec3<f32>(0.0);
  var opacity = 0.0;
  let atmosphereOuterRadius = atmosphereInnerRadius + ATMOSPHERE_THICKNESS;
  let origin = vec3<f32>(0.0);

  var primaryRayAtmosphereIntersect = czms_raySphereIntersectionInterval(primaryRay, origin, atmosphereOuterRadius);
  if (!primaryRayAtmosphereIntersect.valid) {
    return AtmosphereScattering(rayleighColor, mieColor, opacity);
  }

  let x = 1e-7 * primaryRayAtmosphereIntersect.stop / length(primaryRayLength);
  let w_stop_gt_lprl = 0.5 * (1.0 + czms_approximateTanh(x));
  let start_0 = primaryRayAtmosphereIntersect.start;
  primaryRayAtmosphereIntersect.start = max(primaryRayAtmosphereIntersect.start, 0.0);
  primaryRayAtmosphereIntersect.stop = min(primaryRayAtmosphereIntersect.stop, length(primaryRayLength));

  let x_o_a = start_0 - ATMOSPHERE_THICKNESS;
  let w_inside_atmosphere = 1.0 - 0.5 * (1.0 + czms_approximateTanh(x_o_a));
  let PRIMARY_STEPS = PRIMARY_STEPS_MAX - i32(w_inside_atmosphere * 12.0);
  let LIGHT_STEPS = LIGHT_STEPS_MAX - i32(w_inside_atmosphere * 2.0);

  var rayPositionLength = primaryRayAtmosphereIntersect.start;
  let totalRayLength = primaryRayAtmosphereIntersect.stop - rayPositionLength;
  let rayStepLengthIncrease = w_inside_atmosphere * ((1.0 - w_stop_gt_lprl) * totalRayLength / (f32(PRIMARY_STEPS * (PRIMARY_STEPS + 1)) / 2.0));
  var rayStepLength = max(1.0 - w_inside_atmosphere, w_stop_gt_lprl) * totalRayLength / max(7.0 * w_inside_atmosphere, f32(PRIMARY_STEPS));

  var rayleighAccumulation = vec3<f32>(0.0);
  var mieAccumulation = vec3<f32>(0.0);
  var opticalDepth = vec2<f32>(0.0);
  let heightScale = vec2<f32>(czm.u_atmosphereRayleighScaleHeight, czm.u_atmosphereMieScaleHeight);

  for (var i: i32 = 0; i < PRIMARY_STEPS_MAX; i = i + 1) {
    if (i >= PRIMARY_STEPS) { break; }
    let samplePosition = primaryRay.origin + primaryRay.direction * (rayPositionLength + rayStepLength);
    let sampleHeight = length(samplePosition) - atmosphereInnerRadius;
    let sampleDensity = exp(-sampleHeight / heightScale) * rayStepLength;
    opticalDepth = opticalDepth + sampleDensity;

    let lightRay = CzmsRay(samplePosition, lightDirection);
    let lightRayAtmosphereIntersect = czms_raySphereIntersectionInterval(lightRay, origin, atmosphereOuterRadius);
    let lightStepLength = lightRayAtmosphereIntersect.stop / f32(LIGHT_STEPS);
    var lightPositionLength = 0.0;
    var lightOpticalDepth = vec2<f32>(0.0);

    for (var j: i32 = 0; j < LIGHT_STEPS_MAX; j = j + 1) {
      if (j >= LIGHT_STEPS) { break; }
      let lightPosition = samplePosition + lightDirection * (lightPositionLength + lightStepLength * 0.5);
      let lightHeight = length(lightPosition) - atmosphereInnerRadius;
      lightOpticalDepth = lightOpticalDepth + exp(-lightHeight / heightScale) * lightStepLength;
      lightPositionLength = lightPositionLength + lightStepLength;
    }

    let attenuation = exp(-((czm.u_atmosphereMieCoefficient * (opticalDepth.y + lightOpticalDepth.y)) + (czm.u_atmosphereRayleighCoefficient * (opticalDepth.x + lightOpticalDepth.x))));
    rayleighAccumulation = rayleighAccumulation + sampleDensity.x * attenuation;
    mieAccumulation = mieAccumulation + sampleDensity.y * attenuation;
    rayStepLength = rayStepLength + rayStepLengthIncrease;
    rayPositionLength = rayPositionLength + rayStepLength;
  }

  rayleighColor = czm.u_atmosphereRayleighCoefficient * rayleighAccumulation;
  mieColor = czm.u_atmosphereMieCoefficient * mieAccumulation;
  opacity = length(exp(-((czm.u_atmosphereMieCoefficient * opticalDepth.y) + (czm.u_atmosphereRayleighCoefficient * opticalDepth.x))));
  return AtmosphereScattering(rayleighColor, mieColor, opacity);
}

// GroundAtmosphere.glsl:2-19 (`computeAtmosphereScattering`)
fn computeAtmosphereScattering(positionWC: vec3<f32>, lightDirection: vec3<f32>) -> AtmosphereScattering {
  let cameraToPositionWC = positionWC - czm.czm_viewerPositionWC;
  let cameraToPositionWCDirection = normalize(cameraToPositionWC);
  let primaryRay = CzmsRay(czm.czm_viewerPositionWC, cameraToPositionWCDirection);
  let atmosphereInnerRadius = length(positionWC);
  return computeScattering(primaryRay, length(cameraToPositionWC), lightDirection, atmosphereInnerRadius);
}

// AtmosphereCommon.glsl:159-188 (`computeAtmosphereColor`)
fn computeAtmosphereColor(positionWC: vec3<f32>, lightDirection: vec3<f32>, rayleighColor: vec3<f32>, mieColor: vec3<f32>, opacity: f32) -> vec4<f32> {
  let cameraToPositionWC = positionWC - czm.czm_viewerPositionWC;
  let cameraToPositionWCDirection = normalize(cameraToPositionWC);
  let cosAngle = dot(cameraToPositionWCDirection, lightDirection);
  let cosAngleSq = cosAngle * cosAngle;
  let G = czm.u_atmosphereMieAnisotropy;
  let GSq = G * G;
  let rayleighPhase = 3.0 / (50.2654824574) * (1.0 + cosAngleSq);
  let miePhase = 3.0 / (25.1327412287) * ((1.0 - GSq) * (cosAngleSq + 1.0)) / (pow(1.0 + GSq - 2.0 * cosAngle * G, 1.5) * (2.0 + GSq));
  let rayleigh = rayleighPhase * rayleighColor;
  let mie = miePhase * mieColor;
  let color = (rayleigh + mie) * czm.u_atmosphereLightIntensity;
  return vec4<f32>(color, opacity);
}

fn czms_metersPerPixel(positionEC: vec4<f32>, pixelRatio: f32) -> f32 {  let width = czm.czm_viewport.z;
  let height = czm.czm_viewport.w;
  var pixelWidth: f32;
  var pixelHeight: f32;
  let top = czm.czm_frustumPlanes.x;
  let bottom = czm.czm_frustumPlanes.y;
  let left = czm.czm_frustumPlanes.z;
  let right = czm.czm_frustumPlanes.w;
  if (czm.czm_sceneMode == czm_sceneMode2D || czm.czm_orthographicIn3D == 1.0) {
    pixelWidth = (right - left) / width;
    pixelHeight = (top - bottom) / height;
  } else {
    let distanceToPixel = -positionEC.z;
    let inverseNear = 1.0 / czm.czm_currentFrustum.x;
    pixelHeight = 2.0 * distanceToPixel * (top * inverseNear) / height;
    pixelWidth = 2.0 * distanceToPixel * (right * inverseNear) / width;
  }
  return max(pixelWidth, pixelHeight) * pixelRatio;
}
