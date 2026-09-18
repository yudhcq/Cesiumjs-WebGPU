// ============================================================================================
// G-5 gate — WGSL emission library for the terrain **vertex** stage.
//
// Faithful port of `node_modules/@cesium/engine/Source/Shaders/GlobeVS.js` (source of truth),
// including the `#if` structure of `main()`: the *same* conditions select the *same* regions, so
// the varying set this module writes is exactly what `varying-pairing.mjs` derives from the real
// assembled GLSL for the same define set.
//
// Varying writes are guarded by the emitter-supplied `PAIR_<name>` defines: the varying set is an
// **input** to emission (`WgslEmission.emit(...) → varyingSet`, research §6.3), derived from the
// real GLSL — the vertex stage MUST NOT write a varying the fragment stage does not read, because
// the generated `VSOut` struct only carries the paired set (mirroring the GL linker's pruning).
//
// `getPosition` / `get2DYPositionFraction` are **runtime-generated** upstream
// (`GlobeSurfaceShaderSet.js:474-475, 529-568` — they exist in no `.glsl` on disk). They are
// reproduced here by the same three-way / two-way choice, driven by the `POSITION_MODE_*` and
// `Y_FRACTION_*` defines the emitter adds (contract R6 "mirror generator").
// ============================================================================================

const g5_maxTileWidth: f32 = 0.003068;

// GlobeVS.glsl:54-57
fn getPosition3DMode(position: vec3<f32>, height: f32, textureCoordinates: vec2<f32>) -> vec4<f32> {
  return czm.u_modifiedModelViewProjection * vec4<f32>(position, 1.0);
}

// GlobeVS.glsl:59-80
fn get2DMercatorYPositionFraction(textureCoordinates: vec2<f32>) -> f32 {
  var positionFraction = textureCoordinates.y;
  let southLatitude = czm.u_southAndNorthLatitude.x;
  let northLatitude = czm.u_southAndNorthLatitude.y;
  if (northLatitude - southLatitude > g5_maxTileWidth) {
    let southMercatorY = czm.u_southMercatorYAndOneOverHeight.x;
    let oneOverMercatorHeight = czm.u_southMercatorYAndOneOverHeight.y;
    var currentLatitude = mix(southLatitude, northLatitude, textureCoordinates.y);
    currentLatitude = clamp(currentLatitude, -czm_webMercatorMaxLatitude, czm_webMercatorMaxLatitude);
    positionFraction = czms_latitudeToWebMercatorFraction(currentLatitude, southMercatorY, oneOverMercatorHeight);
  }
  return positionFraction;
}

// GlobeVS.glsl:82-85
fn get2DGeographicYPositionFraction(textureCoordinates: vec2<f32>) -> f32 {
  return textureCoordinates.y;
}

// Mirror of `GlobeSurfaceShaderSet.js:560-568` (`get2DYPositionFraction`).
#ifdef Y_FRACTION_MERCATOR
fn get2DYPositionFraction(textureCoordinates: vec2<f32>) -> f32 { return get2DMercatorYPositionFraction(textureCoordinates); }
#else
fn get2DYPositionFraction(textureCoordinates: vec2<f32>) -> f32 { return get2DGeographicYPositionFraction(textureCoordinates); }
#endif

// GlobeVS.glsl:87-92
fn getPositionPlanarEarth(position: vec3<f32>, height: f32, textureCoordinates: vec2<f32>) -> vec4<f32> {
  let yPositionFraction = get2DYPositionFraction(textureCoordinates);
  let rtcPosition2D = vec4<f32>(height, mix(czms_st(czm.u_tileRectangle), czms_pq(czm.u_tileRectangle), vec2<f32>(textureCoordinates.x, yPositionFraction)), 1.0);
  return czm.u_modifiedModelViewProjection * rtcPosition2D;
}

// GlobeVS.glsl:94-102
fn getPositionColumbusViewMode(position: vec3<f32>, height: f32, textureCoordinates: vec2<f32>) -> vec4<f32> {
  return getPositionPlanarEarth(position, height, textureCoordinates);
}

// Mirror of `GlobeSurfaceShaderSet.js:529-553` (`getPositionMode`).
#ifdef POSITION_MODE_3D
fn getPosition(position: vec3<f32>, height: f32, textureCoordinates: vec2<f32>) -> vec4<f32> { return getPosition3DMode(position, height, textureCoordinates); }
#elif defined(POSITION_MODE_COLUMBUS_2D)
fn getPosition(position: vec3<f32>, height: f32, textureCoordinates: vec2<f32>) -> vec4<f32> { return getPositionColumbusViewMode(position, height, textureCoordinates); }
#endif

// GlobeVS.glsl:121-255
@vertex
fn vs_main(input: VSIn) -> VSOut {
  var position: vec3<f32>;
  var height: f32;
  var textureCoordinates: vec2<f32>;
  var webMercatorT: f32;
  var encodedNormal: f32;

#ifdef QUANTIZATION_BITS12
  let xy = czms_decompressTextureCoordinates(input.compressed0.x);
  let zh = czms_decompressTextureCoordinates(input.compressed0.y);
  position = vec3<f32>(xy, zh.x);
  height = zh.y;
  textureCoordinates = czms_decompressTextureCoordinates(input.compressed0.z);
  height = height * (czm.u_minMaxHeight.y - czm.u_minMaxHeight.x) + czm.u_minMaxHeight.x;
  position = (czm.u_scaleAndBias * vec4<f32>(position, 1.0)).xyz;

#if (defined(ENABLE_VERTEX_LIGHTING) || defined(GENERATE_POSITION_AND_NORMAL)) && defined(INCLUDE_WEB_MERCATOR_Y) || defined(APPLY_MATERIAL)
  webMercatorT = czms_decompressTextureCoordinates(input.compressed0.w).x;
  encodedNormal = input.compressed1;
#elif defined(INCLUDE_WEB_MERCATOR_Y)
  webMercatorT = czms_decompressTextureCoordinates(input.compressed0.w).x;
  encodedNormal = 0.0;
#elif defined(ENABLE_VERTEX_LIGHTING) || defined(GENERATE_POSITION_AND_NORMAL) || defined(APPLY_MATERIAL)
  webMercatorT = textureCoordinates.y;
  encodedNormal = input.compressed0.w;
#else
  webMercatorT = textureCoordinates.y;
  encodedNormal = 0.0;
#endif

#else
  // A single float per element
  position = input.position3DAndHeight.xyz;
  height = input.position3DAndHeight.w;
  textureCoordinates = input.textureCoordAndEncodedNormals.xy;

#if (defined(ENABLE_VERTEX_LIGHTING) || defined(GENERATE_POSITION_AND_NORMAL) || defined(APPLY_MATERIAL)) && defined(INCLUDE_WEB_MERCATOR_Y)
  webMercatorT = input.textureCoordAndEncodedNormals.z;
  encodedNormal = input.textureCoordAndEncodedNormals.w;
#elif defined(ENABLE_VERTEX_LIGHTING) || defined(GENERATE_POSITION_AND_NORMAL) || defined(APPLY_MATERIAL)
  webMercatorT = textureCoordinates.y;
  encodedNormal = input.textureCoordAndEncodedNormals.z;
#elif defined(INCLUDE_WEB_MERCATOR_Y)
  webMercatorT = input.textureCoordAndEncodedNormals.z;
  encodedNormal = 0.0;
#else
  webMercatorT = textureCoordinates.y;
  encodedNormal = 0.0;
#endif

#endif

  var position3DWC = position + czm.u_center3D;

#ifdef GEODETIC_SURFACE_NORMALS
  let ellipsoidNormal = input.geodeticSurfaceNormal;
#else
  let ellipsoidNormal = normalize(position3DWC);
#endif

#if defined(EXAGGERATION) && defined(GEODETIC_SURFACE_NORMALS)
  let exaggeration = czm.u_verticalExaggerationAndRelativeHeight.x;
  let relativeHeight = czm.u_verticalExaggerationAndRelativeHeight.y;
  var newHeight = (height - relativeHeight) * exaggeration + relativeHeight;
  let minRadius = min(min(czm.czm_ellipsoidRadii.x, czm.czm_ellipsoidRadii.y), czm.czm_ellipsoidRadii.z);
  newHeight = max(newHeight, -minRadius);
  let offset = ellipsoidNormal * (newHeight - height);
  position = position + offset;
  position3DWC = position3DWC + offset;
  height = newHeight;
#endif

  var out: VSOut;
  out.position = getPosition(position, height, textureCoordinates);

#ifdef PAIR_v_positionEC
  out.v_positionEC = (czm.u_modifiedModelView * vec4<f32>(position, 1.0)).xyz;
#endif
#ifdef PAIR_v_positionMC
  out.v_positionMC = position3DWC; // position in model coordinates
#endif

#ifdef PAIR_v_textureCoordinates
  out.v_textureCoordinates = vec3<f32>(textureCoordinates, webMercatorT);
#endif

#if defined(ENABLE_VERTEX_LIGHTING) || defined(GENERATE_POSITION_AND_NORMAL) || defined(APPLY_MATERIAL)
  var normalMC = czms_octDecodeFloat(encodedNormal);

#if defined(EXAGGERATION) && defined(GEODETIC_SURFACE_NORMALS)
  let projection = dot(normalMC, ellipsoidNormal) * ellipsoidNormal;
  let rejection = normalMC - projection;
  normalMC = normalize(projection + rejection * exaggeration);
#endif

#ifdef PAIR_v_normalMC
  out.v_normalMC = normalMC;
#endif
#ifdef PAIR_v_normalEC
  out.v_normalEC = czm.czm_normal3D * normalMC;
#endif
#endif

#if defined(PAIR_v_atmosphereRayleighColor) || defined(PAIR_v_atmosphereMieColor) || defined(PAIR_v_atmosphereOpacity)
  // GlobeVS.glsl:212 (`!defined(PER_FRAGMENT_GROUND_ATMOSPHERE)`): the vertex stage only computes the
  // atmosphere scattering for the per-vertex mode. That mode is a pipeline override here, so the block
  // is present in every module and skipped by the per-fragment specialisation — the interpolated
  // values keep their declared locations but are never written (the fragment stage computes the
  // position itself in that mode, exactly like the GLSL `#ifdef`).
  if (perFragmentGroundAtmosphere == 0u) {
    var dynamicLighting = false;
#if defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_DAYNIGHT_SHADING) || defined(ENABLE_VERTEX_LIGHTING))
    dynamicLighting = true;
#endif
#if defined(DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN)
    let atmosphereLightDirection = czm.czm_sunDirectionWC;
#else
    let atmosphereLightDirection = czm.czm_lightDirectionWC;
#endif
    let lightDirection = czms_branchFreeTernary3(dynamicLighting, atmosphereLightDirection, normalize(position3DWC));
    let scattering = computeAtmosphereScattering(position3DWC, lightDirection);
#ifdef PAIR_v_atmosphereRayleighColor
    out.v_atmosphereRayleighColor = scattering.rayleighColor;
#endif
#ifdef PAIR_v_atmosphereMieColor
    out.v_atmosphereMieColor = scattering.mieColor;
#endif
#ifdef PAIR_v_atmosphereOpacity
    out.v_atmosphereOpacity = scattering.opacity;
#endif
  }
#endif

#ifdef PAIR_v_distance
  out.v_distance = length((czm.czm_modelView3D * vec4<f32>(position3DWC, 1.0)).xyz);
#endif

  return out;
}
