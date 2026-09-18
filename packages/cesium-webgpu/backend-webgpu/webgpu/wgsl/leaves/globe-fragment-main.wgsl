// ============================================================================================
// cesium-webgpu WebGPU backend layer — WGSL leaf library (tasks.md T068/T069, contract R3/R6).
//
// GLSL source of truth: node_modules/@cesium/engine/Source/Shaders/GlobeFS.js:325-595
// Ported from the verified leaf (webgpu/wgsl/leaves/terrain-fs-main.wgsl);
// the port is 1:1 — every WGSL-forced construction is called out in place (W1..W7 / D1..D4).
//
// This file is a TEMPLATE: it uses the GLSL conditional-directive syntax (#if/#elif/#else/
// #endif/#ifdef) which WGSL does not have. The directives are resolved per variant by
// webgpu/glsl-preprocess.ts (contract R4) before the module text is produced; the emitted
// modules are what a device sees. Consequence for tooling: this file is NOT a standalone WGSL
// module, so 	ools/scripts/check-wgsl.mjs validates its **emitted** form.
// ============================================================================================

@fragment
fn fs_main(input: FSIn) -> @location(0) vec4<f32> {
#ifdef TILE_LIMIT_RECTANGLE
  if (input.v_textureCoordinates.x < czm.u_cartographicLimitRectangle.x || czm.u_cartographicLimitRectangle.z < input.v_textureCoordinates.x ||
      input.v_textureCoordinates.y < czm.u_cartographicLimitRectangle.y || czm.u_cartographicLimitRectangle.w < input.v_textureCoordinates.y) {
    discard;
  }
#endif

#if defined(SHOW_REFLECTIVE_OCEAN) || defined(ENABLE_DAYNIGHT_SHADING) || defined(HDR)
  let normalMC = czms_geodeticSurfaceNormal(input.v_positionMC, vec3<f32>(0.0), vec3<f32>(1.0));
  let normalEC = czm.czm_normal3D * normalMC;
#endif

#if defined(APPLY_DAY_NIGHT_ALPHA) && defined(ENABLE_DAYNIGHT_SHADING)
  let nightBlend = 1.0 - clamp(czms_getLambertDiffuse(czm.czm_lightDirectionEC, normalEC) * 5.0, 0.0, 1.0);
#else
  let nightBlend = 0.0;
#endif

  // The clamp below works around an apparent bug in Chrome Canary v23.0.1241.0 (upstream comment).
  let clampedTexCoords = clamp(input.v_textureCoordinates, vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(1.0, 1.0, 1.0));
  var color = computeDayColor(czm.u_initialColor, clampedTexCoords, nightBlend, input.position.x);

#if defined(ENABLE_DAYNIGHT_SHADING) || defined(GROUND_ATMOSPHERE)
  var cameraDist: f32;
  if (czm.czm_sceneMode == czm_sceneMode2D) {
    cameraDist = max(czm.czm_frustumPlanes.x - czm.czm_frustumPlanes.y, czm.czm_frustumPlanes.w - czm.czm_frustumPlanes.z) * 0.5;
  } else if (czm.czm_sceneMode == czm_sceneModeColumbusView) {
    cameraDist = -czm.czm_view[3].z;
  } else {
    cameraDist = length(czm.czm_view[3].xyz);
  }
  var fadeOutDist = czm.u_lightingFadeDistance.x;
  var fadeInDist = czm.u_lightingFadeDistance.y;
  if (czm.czm_sceneMode != czm_sceneMode3D) {
    let radii = czm.czm_ellipsoidRadii;
    let maxRadii = max(radii.x, max(radii.y, radii.z));
    fadeOutDist = fadeOutDist - maxRadii;
    fadeInDist = fadeInDist - maxRadii;
  }
  let fade = clamp((cameraDist - fadeOutDist) / (fadeInDist - fadeOutDist), 0.0, 1.0);
#else
  let fade = 0.0;
#endif

#if defined(HAS_WATER_MASK) && (defined(SHOW_REFLECTIVE_OCEAN) || defined(APPLY_MATERIAL))
  let waterMaskTranslation = czm.u_waterMaskTranslationAndScale.xy;
  let waterMaskScale = czm.u_waterMaskTranslationAndScale.zw;
  var waterMaskTextureCoordinates = input.v_textureCoordinates.xy * waterMaskScale + waterMaskTranslation;
  waterMaskTextureCoordinates.y = 1.0 - waterMaskTextureCoordinates.y;
  let mask = textureSampleLevel(u_waterMask_texture, u_waterMask_sampler, waterMaskTextureCoordinates, 0.0).r;

#ifdef SHOW_REFLECTIVE_OCEAN
  if (mask > 0.0) {
    let enuToEye = czms_eastNorthUpToEyeCoordinates(input.v_positionMC, normalEC);
    let ellipsoidTextureCoordinates = czms_ellipsoidTextureCoordinates(normalMC);
    let ellipsoidFlippedTextureCoordinates = czms_ellipsoidTextureCoordinates(normalMC.zyx);
    let textureCoordinates = mix(ellipsoidTextureCoordinates, ellipsoidFlippedTextureCoordinates, czm.czm_morphTime * smoothstep(0.9, 0.95, normalMC.z));
    color = computeWaterColor(input.v_positionEC, textureCoordinates, enuToEye, color, mask, fade);
  }
#endif
#endif

#ifdef ENABLE_VERTEX_LIGHTING
  let diffuseIntensity = clamp(czms_getLambertDiffuse(czm.czm_lightDirectionEC, normalize(input.v_normalEC)) * czm.u_lambertDiffuseMultiplier + czm.u_vertexShadowDarkness, 0.0, 1.0);
  var finalColor = vec4<f32>(color.rgb * czm.czm_lightColor * diffuseIntensity, color.a);
#elif defined(ENABLE_DAYNIGHT_SHADING)
  let diffuseIntensity = clamp(czms_getLambertDiffuse(czm.czm_lightDirectionEC, normalEC) * 5.0 + 0.3, 0.0, 1.0);
  var finalColor = vec4<f32>(color.rgb * czm.czm_lightColor * mix(1.0, diffuseIntensity, fade), color.a);
#else
  var finalColor = color;
#endif

#if defined(DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN)
  let atmosphereLightDirection = czm.czm_sunDirectionWC;
#else
  let atmosphereLightDirection = czm.czm_lightDirectionWC;
#endif

#if defined(GROUND_ATMOSPHERE) || defined(FOG)
  if (!input.front_facing) {
    var atmosphericDynamicLighting = false;
#if defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_DAYNIGHT_SHADING) || defined(ENABLE_VERTEX_LIGHTING))
    atmosphericDynamicLighting = true;
#endif
    var positionWC: vec3<f32>;
    var lightDirection: vec3<f32>;
    var rayleighColor: vec3<f32>;
    var mieColor: vec3<f32>;
    var opacity: f32;

    // `PER_FRAGMENT_GROUND_ATMOSPHERE` is a pipeline-overridable constant (`perFragmentGroundAtmosphere`),
    // not a preprocessor define: both arms stay in this module and the constant selects at
    // pipeline-creation time. Upstream recomputes this mode from the camera distance **every frame**
    // (GlobeSurfaceTileProvider.js:2600-2604), so building it into the module text would recompile a
    // ~33 kB module whenever the camera crosses the fade distance (G-6/T025, measured 110.5 ms p50).
    if (perFragmentGroundAtmosphere != 0u) {
      positionWC = computeEllipsoidPosition(input.position.xy);
      lightDirection = czms_branchFreeTernary3(atmosphericDynamicLighting, atmosphereLightDirection, normalize(positionWC));
      let perFragmentScattering = computeAtmosphereScattering(positionWC, lightDirection);
      rayleighColor = perFragmentScattering.rayleighColor;
      mieColor = perFragmentScattering.mieColor;
      opacity = perFragmentScattering.opacity;
    } else {
      positionWC = input.v_positionMC;
      lightDirection = czms_branchFreeTernary3(atmosphericDynamicLighting, atmosphereLightDirection, normalize(positionWC));
      rayleighColor = input.v_atmosphereRayleighColor;
      mieColor = input.v_atmosphereMieColor;
      opacity = input.v_atmosphereOpacity;
    }

    let groundAtmosphereColor = computeAtmosphereColor(positionWC, lightDirection, rayleighColor, mieColor, opacity);

#ifdef FOG
    var fogColor = groundAtmosphereColor.rgb;
#if defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING))
    let darkenValue = clamp(dot(normalize(czm.czm_viewerPositionWC), atmosphereLightDirection), czm.u_minimumBrightness, 1.0);
    fogColor = fogColor * darkenValue;
#endif
#ifndef HDR
    fogColor = czms_inverseGamma(czms_pbrNeutralTonemapping(fogColor));
#endif
    finalColor = vec4<f32>(czms_fog4(input.v_distance, finalColor.rgb, fogColor, czm.czm_fogVisualDensityScalar), finalColor.a);
#else
    let transmittanceModifier = 0.5;
    let transmittance = transmittanceModifier + clamp(1.0 - groundAtmosphereColor.a, 0.0, 1.0);
    var finalAtmosphereColor = finalColor.rgb + groundAtmosphereColor.rgb * transmittance;
#if defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING))
    let nightFadeInDist = czm.u_nightFadeDistance.x;
    let nightFadeOutDist = czm.u_nightFadeDistance.y;
    let sunlitAtmosphereIntensity = clamp((cameraDist - nightFadeOutDist) / (nightFadeInDist - nightFadeOutDist), 0.05, 1.0);
    let darkenValue = clamp(dot(normalize(positionWC), atmosphereLightDirection), 0.0, 1.0);
    let darkenendGroundAtmosphereColor = mix(groundAtmosphereColor.rgb, finalAtmosphereColor.rgb, darkenValue);
    finalAtmosphereColor = mix(darkenendGroundAtmosphereColor, finalAtmosphereColor, sunlitAtmosphereIntensity);
#endif
#ifndef HDR
    let fExposure: f32 = 2.0;
    finalAtmosphereColor = vec3<f32>(1.0) - exp(-fExposure * finalAtmosphereColor);
#else
    finalAtmosphereColor = czms_saturation(finalAtmosphereColor, 1.6);
#endif
    finalColor = vec4<f32>(mix(finalColor.rgb, finalAtmosphereColor, fade), finalColor.a);
#endif
  }
#endif

  return finalColor;
}
