// ============================================================================================
// G-5 gate — WGSL emission library for the terrain **fragment** stage: helper functions.
//
// Faithful port of the helper part of `node_modules/@cesium/engine/Source/Shaders/GlobeFS.js`
// plus the atmosphere helpers of `Shaders/AtmosphereCommon.js` (both inlined into the assembled
// GLSL by `ShaderSource.getBuiltinsAndAutomaticUniforms`).
//
// WGSL-forced signature differences (all declared, none silent):
//   D1 `gl_FragCoord.x` has no global equivalent → passed explicitly as `fragCoordX`
//      (`sampleAndBlend`, APPLY_SPLIT).
//   D2 GLSL `out` parameters (`computeScattering(..., out vec3, out vec3, out float)`) become a
//      returned struct.
//   D3 `sampler2D` function parameters become an explicit `(texture, sampler)` pair
//      (spike REPORT §6.4 ①).
//   D4 `texture(...)` → `textureSampleLevel(..., 0.0)` (uniformity; see `prelude.wgsl` W4).
// `terrain-fs-main.wgsl` holds the entry point; `computeDayColor()` — which upstream **generates
// at runtime** (`GlobeSurfaceShaderSet.js:419-472`) — is emitted between them by the mirror
// generator in `mirror-generators.mjs` (contract R6).
// ============================================================================================

// `AtmosphereScattering`, `computeScattering`, `computeAtmosphereScattering` and
// `computeAtmosphereColor` live in `prelude.wgsl`: the **vertex** stage also calls
// `computeAtmosphereScattering` when it precomputes the per-vertex scattering
// (`GlobeVS.glsl:212-235`), so they are shared module-scope declarations, not fragment-only helpers.

// GlobeFS.glsl:183-292 (`sampleAndBlend`) — every APPLY_* region of the upstream source.
fn sampleAndBlend(
  previousColor: vec4<f32>,
  textureToSample: texture_2d<f32>,
  textureSampler: sampler,
  tileTextureCoordinates: vec2<f32>,
  textureCoordinateRectangle: vec4<f32>,
  textureCoordinateTranslationAndScale: vec4<f32>,
  textureAlphaIn: f32,
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
  fragCoordX: f32,
) -> vec4<f32> {
  var textureAlpha = textureAlphaIn;
  var alphaMultiplier = step(textureCoordinateRectangle.xy, tileTextureCoordinates);
  textureAlpha = textureAlpha * alphaMultiplier.x * alphaMultiplier.y;
  alphaMultiplier = step(vec2<f32>(0.0, 0.0), textureCoordinateRectangle.zw - tileTextureCoordinates);
  textureAlpha = textureAlpha * alphaMultiplier.x * alphaMultiplier.y;

#if defined(APPLY_DAY_NIGHT_ALPHA) && defined(ENABLE_DAYNIGHT_SHADING)
  textureAlpha = textureAlpha * mix(textureDayAlpha, textureNightAlpha, nightBlend);
#endif

  let translation = textureCoordinateTranslationAndScale.xy;
  let scale = textureCoordinateTranslationAndScale.zw;
  let textureCoordinates = tileTextureCoordinates * scale + translation;
  let value = textureSampleLevel(textureToSample, textureSampler, textureCoordinates, 0.0);
  var color = value.rgb;
  var alpha = value.a;

#ifdef APPLY_COLOR_TO_ALPHA
  var colorDiff = abs(color - colorToAlpha.rgb);
  colorDiff.r = czms_maximumComponent3(colorDiff);
  alpha = czms_branchFreeTernary(colorDiff.r < colorToAlpha.a, 0.0, alpha);
#endif

#ifndef APPLY_GAMMA
  let tempColor = czms_gammaCorrect4(vec4<f32>(color, alpha));
  color = tempColor.rgb;
  alpha = tempColor.a;
#else
  color = pow(color, vec3<f32>(textureOneOverGamma));
#endif

#ifdef APPLY_SPLIT
  let splitPosition = czm.czm_splitPosition;
  // Split to the left
  if (split < 0.0 && fragCoordX > splitPosition) {
    alpha = 0.0;
  } else if (split > 0.0 && fragCoordX < splitPosition) {
    alpha = 0.0;
  }
#endif

#ifdef APPLY_BRIGHTNESS
  color = mix(vec3<f32>(0.0), color, textureBrightness);
#endif
#ifdef APPLY_CONTRAST
  color = mix(vec3<f32>(0.5), color, textureContrast);
#endif
#ifdef APPLY_HUE
  color = czms_hue(color, textureHue);
#endif
#ifdef APPLY_SATURATION
  color = czms_saturation(color, textureSaturation);
#endif

  let sourceAlpha = alpha * textureAlpha;
  var outAlpha = mix(previousColor.a, 1.0, sourceAlpha);
  outAlpha = outAlpha + (sign(outAlpha) - 1.0);
  let outColor = mix(previousColor.rgb * previousColor.a, color, sourceAlpha) / outAlpha;
  return vec4<f32>(outColor, max(outAlpha, 0.0));
}

// GlobeFS.glsl:600-697 (`waveFade` / `linearFade` / `computeWaterColor`)
#ifdef SHOW_REFLECTIVE_OCEAN
fn waveFade(edge0: f32, edge1: f32, x: f32) -> f32 {
  let y = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return pow(1.0 - y, 5.0);
}

fn linearFade(edge0: f32, edge1: f32, x: f32) -> f32 {
  return clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
}

fn computeWaterColor(
  positionEyeCoordinates: vec3<f32>,
  textureCoordinates: vec2<f32>,
  enuToEye: mat3x3<f32>,
  imageryColor: vec4<f32>,
  maskValue: f32,
  fade: f32,
) -> vec4<f32> {
  let oceanFrequencyLowAltitude: f32 = 825000.0;
  let oceanAnimationSpeedLowAltitude: f32 = 0.004;
  let oceanOneOverAmplitudeLowAltitude: f32 = 1.0 / 2.0;
  let oceanSpecularIntensity: f32 = 0.5;
  let oceanFrequencyHighAltitude: f32 = 125000.0;
  let oceanAnimationSpeedHighAltitude: f32 = 0.008;
  let oceanOneOverAmplitudeHighAltitude: f32 = 1.0 / 2.0;

  let positionToEyeEC = -positionEyeCoordinates;
  let positionToEyeECLength = length(positionToEyeEC);
  let normalizedPositionToEyeEC = normalize(normalize(positionToEyeEC));
  let waveIntensity = waveFade(70000.0, 1000000.0, positionToEyeECLength);

  var normalTangentSpace = vec3<f32>(0.0, 0.0, 1.0);
#ifdef SHOW_OCEAN_WAVES
  var time = czm.czm_frameNumber * oceanAnimationSpeedHighAltitude;
  var noise = czms_getWaterNoise(u_oceanNormalMap_texture, u_oceanNormalMap_sampler, textureCoordinates * oceanFrequencyHighAltitude, time, 0.0);
  let normalTangentSpaceHighAltitude = vec3<f32>(noise.xy, noise.z * oceanOneOverAmplitudeHighAltitude);
  time = czm.czm_frameNumber * oceanAnimationSpeedLowAltitude;
  noise = czms_getWaterNoise(u_oceanNormalMap_texture, u_oceanNormalMap_sampler, textureCoordinates * oceanFrequencyLowAltitude, time, 0.0);
  let normalTangentSpaceLowAltitude = vec3<f32>(noise.xy, noise.z * oceanOneOverAmplitudeLowAltitude);
  let highAltitudeFade = linearFade(0.0, 60000.0, positionToEyeECLength);
  let lowAltitudeFade = 1.0 - linearFade(20000.0, 60000.0, positionToEyeECLength);
  normalTangentSpace = (highAltitudeFade * normalTangentSpaceHighAltitude) + (lowAltitudeFade * normalTangentSpaceLowAltitude);
  normalTangentSpace = normalize(normalTangentSpace);
  normalTangentSpace = vec3<f32>(normalTangentSpace.xy * waveIntensity, normalTangentSpace.z);
  normalTangentSpace = normalize(normalTangentSpace);
#endif

  let normalEC = enuToEye * normalTangentSpace;
  let waveHighlightColor = vec3<f32>(0.3, 0.45, 0.6);
  let diffuseIntensity = czms_getLambertDiffuse(czm.czm_lightDirectionEC, normalEC) * maskValue;
  let diffuseHighlight = waveHighlightColor * diffuseIntensity * (1.0 - fade);

  var nonDiffuseHighlight = vec3<f32>(0.0);
#ifdef SHOW_OCEAN_WAVES
  let tsPerturbationRatio = normalTangentSpace.z;
  nonDiffuseHighlight = mix(waveHighlightColor * 5.0 * (1.0 - tsPerturbationRatio), vec3<f32>(0.0), vec3<f32>(diffuseIntensity));
#endif

  let specularIntensity = czms_getSpecular(czm.czm_lightDirectionEC, normalizedPositionToEyeEC, normalEC, 10.0);
  let surfaceReflectance = mix(0.0, mix(czm.u_zoomedOutOceanSpecularIntensity, oceanSpecularIntensity, waveIntensity), maskValue);
  let specular = specularIntensity * surfaceReflectance;
#ifdef HDR
  let hdrSpecular = specular * 1.4;
  let e = 0.2;
  let d = 3.3;
  let c = 1.7;
  let color = imageryColor.rgb + (c * (vec3<f32>(e) + imageryColor.rgb * d) * (diffuseHighlight + nonDiffuseHighlight + vec3<f32>(hdrSpecular)));
#else
  let color = imageryColor.rgb + diffuseHighlight + nonDiffuseHighlight + vec3<f32>(specular);
#endif
  return vec4<f32>(color, imageryColor.a);
}
#endif

// GlobeFS.glsl:299-323 (`computeEllipsoidPosition`).
//
// Emitted **unconditionally**: `PER_FRAGMENT_GROUND_ATMOSPHERE` is a pipeline-overridable constant
// here (`perFragmentGroundAtmosphere`), not a preprocessor define, so both arms of the choice stay in
// one module (see `terrain-fs-main.wgsl`). The function is only *called* from the per-fragment arm, so
// the per-vertex specialisation eliminates it; keeping both arms in one module is what stops a change
// of ground-atmosphere mode from recompiling a ~33 kB module mid-frame (G-6/T025).
fn computeEllipsoidPosition(fragCoordXY: vec2<f32>) -> vec3<f32> {
  let mpp = czms_metersPerPixel(vec4<f32>(0.0, 0.0, -czm.czm_currentFrustum.x, 1.0), 1.0);
  var xy = fragCoordXY / czm.czm_viewport.zw * 2.0 - vec2<f32>(1.0);
  xy = xy * czm.czm_viewport.zw * mpp * 0.5;
  var direction: vec3<f32>;
  if (czm.czm_orthographicIn3D == 1.0) {
    direction = vec3<f32>(0.0, 0.0, -1.0);
  } else {
    direction = normalize(vec3<f32>(xy, -czm.czm_currentFrustum.x));
  }
  let ray = CzmsRay(vec3<f32>(0.0), direction);
  let ellipsoid_center = czm.czm_view[3].xyz;
  let intersection = czms_rayEllipsoidIntersectionInterval(ray, ellipsoid_center, czm.czm_ellipsoidInverseRadii);
  let ellipsoidPosition = czms_pointAlongRay(ray, intersection.start);
  return (czm.czm_inverseView * vec4<f32>(ellipsoidPosition, 1.0)).xyz;
}

#ifdef TRANSLUCENT
fn interpolateByDistance(nearFarScalar: vec4<f32>, distance: f32) -> f32 {
  let startDistance = nearFarScalar.x;
  let startValue = nearFarScalar.y;
  let endDistance = nearFarScalar.z;
  let endValue = nearFarScalar.w;
  let t = clamp((distance - startDistance) / (endDistance - startDistance), 0.0, 1.0);
  return mix(startValue, endValue, t);
}
#endif
