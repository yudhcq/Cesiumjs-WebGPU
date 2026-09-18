/**
 * Shared gate fixture — the **fixed terrain scene** used by G-5 (T022 golden-variant readback) and
 * by G-6 (T025 variant/cache histogram, T026 WebGPU↔WebGL2 pixel + elevation diff).
 *
 * One deterministic definition, consumed by both backends, so a difference between the two paths can
 * only come from the shader code / compiler, never from the inputs:
 *
 *   - a 16×16-vertex ellipsoid terrain patch (WGS84 ECEF, heightmap from a fixed formula),
 *     attribute layout exactly as `Core/TerrainEncoding.js:650-656` (`position3DAndHeight:0`,
 *     `textureCoordAndEncodedNormals:1`, 32-byte stride, two `vec4`s — or the BITS12 encoding
 *     `compressed0:0` / `compressed1:1` when the variant is quantized);
 *   - a flat WebGPU-style projection matrix (identical in both backends) and a real perspective
 *     view of the patch;
 *   - a deterministic `N×N` RGBA8 imagery texture whose texels are distinct per corner, so the
 *     four-corner readback assertion can prove the texture-origin (Y flip) handling;
 *   - every automatic uniform the terrain shaders reference, with a value that makes the frame
 *     non-degenerate (the G-5 MVP readback asserts "no black pixels").
 *
 * Node-only, zero dependencies, cross-platform.
 */

export const ELLIPSOID_RADII = { x: 6378137.0, y: 6378137.0, z: 6356752.3142451793 };

export const SCENE_ID = "g5g6-fixed-terrain-16x16";
export const SCENE_CONFIG = {
  id: SCENE_ID,
  viewport: { width: 128, height: 128 },
  grid: 16, // 16×16 vertices ⇒ 15×15 quads
  tileRectangle: [0.0, 0.0, 1.0, 1.0],
  longitudeRange: [0.35, 0.45], // degrees
  latitudeRange: [0.35, 0.45],
  imagerySize: 4,
  pointSizeMeters: 6.0,
};

// ------------------------------------------------------------------------------------------------
// minimal column-major mat4 helpers (same convention as GLSL/WGSL)
// ------------------------------------------------------------------------------------------------

export function mat4Identity() {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function mat4Multiply(a, b) {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

export function mat4LookAt(eye, target, up) {
  const z = normalize(subtract(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float64Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

/** Translation matrix (column-major), used to lift RTC model coordinates back to world coordinates. */
export function mat4FromTranslation(t) {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1]);
}

/**
 * WebGPU/zero-to-one depth-range perspective projection.
 *
 * Both backends are handed the **same** matrix on purpose: the comparison must isolate the shader
 * code, and the MVP slice renders a single un-depth-tested pass, so the clip-space z convention
 * cannot leak into the comparison. (The GL→WebGPU depth-range correction is a property of the
 * emitter — research §6.3 — not of this fixture.)
 */
export function mat4PerspectiveZeroToOne(fovY, aspect, near, far) {
  const f = 1.0 / Math.tan(fovY / 2);
  return new Float64Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (near * far) / (near - far), 0,
  ]);
}

export function mat4Invert(m) {
  const inv = new Float64Array(16);
  const a = m;
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (det === 0) throw new Error("g5/g6 scene: singular matrix");
  det = 1.0 / det;
  return inv.map((value) => value * det);
}

/** Column-major 3×3 from the upper-left of a mat4 (as GLSL/WGSL matrices are column-major). */
export function mat3FromMat4(m) {
  return new Float64Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
}

function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function normalize(v) { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; }

// ------------------------------------------------------------------------------------------------
// the scene
// ------------------------------------------------------------------------------------------------

/** Deterministic terrain height in metres (fixed formula — no RNG, reproducible across runs). */
export function heightAt(u, v) {
  return 900.0 + 700.0 * Math.sin(3.0 * u * Math.PI) * Math.cos(2.0 * v * Math.PI) + 400.0 * Math.sin(7.0 * v * Math.PI);
}

/** WGS84 geodetic → ECEF. */
export function ecef(lonDegrees, latDegrees, height) {
  const { x: a, z: c } = ELLIPSOID_RADII;
  const e2 = 1.0 - (c * c) / (a * a);
  const lon = (lonDegrees * Math.PI) / 180;
  const lat = (latDegrees * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = a / Math.sqrt(1.0 - e2 * sinLat * sinLat);
  return [(n + height) * cosLat * Math.cos(lon), (n + height) * cosLat * Math.sin(lon), (n * (1.0 - e2) + height) * sinLat];
}

/** Deterministic imagery texture: distinct per texel so a Y flip is detectable at the corners. */
export function buildImagery(size = SCENE_CONFIG.imagerySize) {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      rgba[index + 0] = Math.round(((x + 1) / (size + 1)) * 255); // red grows with x
      rgba[index + 1] = Math.round(((y + 1) / (size + 1)) * 255); // green grows with y
      rgba[index + 2] = Math.round((((x * size + y) % size) + 1) / (size + 1) * 255) + 40; // blue: mixed
      rgba[index + 3] = 255;
    }
  }
  return { width: size, height: size, rgba };
}

/** Encode a float in [0,1] to a byte (used by the elevation-encode pass of G-6). */
export function encodeByte(value) {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

/**
 * Build the fixed scene.
 *
 * @param {{quantized?: boolean, imagerySize?: number}} [options]
 */
export function buildScene(options = {}) {
  const { grid, tileRectangle, longitudeRange, latitudeRange, viewport } = SCENE_CONFIG;
  const quantized = options.quantized === true;
  const count = grid * grid;
  const positionsMC = new Float64Array(count * 3);
  const heights = new Float64Array(count);
  const textureCoordinates = new Float64Array(count * 2);
  const webMercatorT = new Float64Array(count);

  const [lon0, lon1] = longitudeRange;
  const [lat0, lat1] = latitudeRange;
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  const ecefPoints = new Float64Array(count * 3);

  for (let j = 0; j < grid; j += 1) {
    for (let i = 0; i < grid; i += 1) {
      const index = j * grid + i;
      const u = i / (grid - 1);
      const v = j / (grid - 1);
      const height = heightAt(u, v);
      const point = ecef(lon0 + (lon1 - lon0) * u, lat0 + (lat1 - lat0) * v, height);
      ecefPoints[index * 3 + 0] = point[0];
      ecefPoints[index * 3 + 1] = point[1];
      ecefPoints[index * 3 + 2] = point[2];
      heights[index] = height;
      textureCoordinates[index * 2 + 0] = u;
      textureCoordinates[index * 2 + 1] = v;
      webMercatorT[index] = v; // geographic projection: the Web-Mercator T equals the tile T
      if (height < minHeight) minHeight = height;
      if (height > maxHeight) maxHeight = height;
    }
  }

  // RTC: `u_center3D` is the tile origin, so the model-space positions are the ECEF offsets.
  const centerIndex = Math.floor(grid / 2) * grid + Math.floor(grid / 2);
  const center = [ecefPoints[centerIndex * 3], ecefPoints[centerIndex * 3 + 1], ecefPoints[centerIndex * 3 + 2]];
  const heightCenter = heights[centerIndex];
  const center3D = ecef(
    lon0 + (lon1 - lon0) * 0.5,
    lat0 + (lat1 - lat0) * 0.5,
    heights[Math.floor(grid / 2) * grid + Math.floor(grid / 2)],
  );
  for (let index = 0; index < count; index += 1) {
    positionsMC[index * 3 + 0] = ecefPoints[index * 3 + 0] - center3D[0];
    positionsMC[index * 3 + 1] = ecefPoints[index * 3 + 1] - center3D[1];
    positionsMC[index * 3 + 2] = ecefPoints[index * 3 + 2] - center3D[2];
  }

  // Camera: 6 km above the tile centre along the geodetic normal, tilted slightly north so the view
  // is non-degenerate, looking at the centre. The patch then overfills the 128x128 frame, which is
  // what makes "every pixel non-black" a meaningful assertion.
  const surface = ecef(lon0 + (lon1 - lon0) * 0.5, lat0 + (lat1 - lat0) * 0.5, 0);
  const up = normalize(surface);
  const east = normalize(cross([0, 0, 1], up));
  const north = cross(up, east);
  const eyeWC = [surface[0] + up[0] * 6000 + north[0] * 1200, surface[1] + up[1] * 6000 + north[1] * 1200, surface[2] + up[2] * 6000 + north[2] * 1200];
  const view = mat4LookAt(eyeWC, surface, north);
  const projection = mat4PerspectiveZeroToOne(Math.PI / 3, viewport.width / viewport.height, 10.0, 1.0e6);
  // The vertex positions are relative-to-centre (RTC) model coordinates, so the model matrix is the
  // translation that lifts them back to world coordinates (`u_center3D`) — exactly what Cesium's
  // `u_modifiedModelView` carries.
  const model = mat4FromTranslation(center3D);
  const modelView = mat4Multiply(view, model);
  const modelViewProjection = mat4Multiply(projection, modelView);
  const inverseView = mat4Invert(view);
  const normal3D = mat3FromMat4(modelView);

  const imagery = buildImagery(options.imagerySize ?? SCENE_CONFIG.imagerySize);

  // Attributes travel in the same two-vec4 layout for both encodings; the BITS12 variant is written
  // in the quantized packing of `Core/TerrainEncoding.js:246-258` in a separate buffer.
  const stride = 32;
  const interleaved = new Float32Array(count * 8);
  for (let index = 0; index < count; index += 1) {
    interleaved[index * 8 + 0] = positionsMC[index * 3 + 0];
    interleaved[index * 8 + 1] = positionsMC[index * 3 + 1];
    interleaved[index * 8 + 2] = positionsMC[index * 3 + 2];
    interleaved[index * 8 + 3] = heights[index];
    interleaved[index * 8 + 4] = textureCoordinates[index * 2 + 0];
    interleaved[index * 8 + 5] = textureCoordinates[index * 2 + 1];
    interleaved[index * 8 + 6] = webMercatorT[index];
    interleaved[index * 8 + 7] = 0.0; // encoded normal: zero ⇒ czm_octDecode(0.0) = (0,0,0)
  }

  const indices = new Uint32Array((grid - 1) * (grid - 1) * 6);
  let cursor = 0;
  for (let j = 0; j < grid - 1; j += 1) {
    for (let i = 0; i < grid - 1; i += 1) {
      const a = j * grid + i;
      const b = a + 1;
      const c = a + grid;
      const d = c + 1;
      indices[cursor++] = a; indices[cursor++] = c; indices[cursor++] = b;
      indices[cursor++] = b; indices[cursor++] = c; indices[cursor++] = d;
    }
  }

  const viewportFrustum = [1.0, 1.0, 1.0, 1.0]; // (near, far, left, right) placeholder — see uniforms
  const halfHeight = Math.tan(Math.PI / 6) * 1.0;
  void viewportFrustum;

  /** Uniform values, by GLSL name. Anything the union layout carries but this map omits is zeroed. */
  const uniforms = {
    u_center3D: { type: "vec3", value: [center3D[0], center3D[1], center3D[2]] },
    u_modifiedModelView: { type: "mat4", value: modelView },
    u_modifiedModelViewProjection: { type: "mat4", value: modelViewProjection },
    u_tileRectangle: { type: "vec4", value: tileRectangle },
    u_southAndNorthLatitude: { type: "vec2", value: [(lat0 * Math.PI) / 180, (lat1 * Math.PI) / 180] },
    u_southMercatorYAndOneOverHeight: { type: "vec2", value: [mercatorY(lat0), 1.0 / Math.max(1e-9, mercatorY(lat1) - mercatorY(lat0))] },
    u_minMaxHeight: { type: "vec2", value: [minHeight, maxHeight] },
    u_scaleAndBias: { type: "mat4", value: mat4Identity() },
    u_initialColor: { type: "vec4", value: [0.85, 0.78, 0.7, 1.0] },
    // `TEXTURE_UNITS`-sized arrays: the union layout sizes them for the largest reachable variant
    // (3), so every element is given explicitly — element 0 is the layer this fixture renders.
    u_dayTextureTranslationAndScale: { type: "vec4", value: [0.0, 0.0, 1.0, 1.0], elements: [[0.0, 0.0, 1.0, 1.0], [0.0, 0.0, 1.0, 1.0], [0.0, 0.0, 1.0, 1.0]] },
    u_dayTextureUseWebMercatorT: { type: "bool", value: false, elements: [false, false, false] },
    u_dayTextureTexCoordsRectangle: { type: "vec4", value: [0.0, 0.0, 1.0, 1.0], elements: [[0.0, 0.0, 1.0, 1.0], [0.0, 0.0, 1.0, 1.0], [0.0, 0.0, 1.0, 1.0]] },
    u_dayTextureAlpha: { type: "float", value: 1.0, elements: [1.0, 1.0, 1.0] },
    u_dayTextureNightAlpha: { type: "float", value: 1.0, elements: [1.0, 1.0, 1.0] },
    u_dayTextureDayAlpha: { type: "float", value: 1.0, elements: [1.0, 1.0, 1.0] },
    u_dayTextureBrightness: { type: "float", value: 1.0, elements: [1.0, 1.0, 1.0] },
    u_dayTextureContrast: { type: "float", value: 1.0, elements: [1.0, 1.0, 1.0] },
    u_dayTextureHue: { type: "float", value: 0.0, elements: [0.0, 0.0, 0.0] },
    u_dayTextureSaturation: { type: "float", value: 1.0, elements: [1.0, 1.0, 1.0] },
    u_dayTextureOneOverGamma: { type: "float", value: 1.0, elements: [1.0, 1.0, 1.0] },
    u_dayTextureSplit: { type: "float", value: 0.0, elements: [0.0, 0.0, 0.0] },
    u_colorsToAlpha: { type: "vec4", value: [0.0, 0.0, 0.0, 0.0], elements: [[0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0]] },
    u_lightingFadeDistance: { type: "vec2", value: [1.0e7, 2.0e7] },
    u_nightFadeDistance: { type: "vec2", value: [3.0e7, 4.0e7] },
    u_minimumBrightness: { type: "float", value: 0.15 },
    u_cartographicLimitRectangle: { type: "vec4", value: [0.0, 0.0, 1.0, 1.0] },
    u_radiiAndDynamicAtmosphereColor: { type: "vec3", value: [ELLIPSOID_RADII.x, ELLIPSOID_RADII.y, 0.0] },
    u_atmosphereLightIntensity: { type: "float", value: 12.0 },
    u_atmosphereRayleighScaleHeight: { type: "float", value: 10000.0 },
    u_atmosphereMieScaleHeight: { type: "float", value: 3200.0 },
    u_atmosphereMieAnisotropy: { type: "float", value: 0.9 },
    u_atmosphereRayleighCoefficient: { type: "vec3", value: [5.5e-6, 13.0e-6, 28.4e-6] },
    u_atmosphereMieCoefficient: { type: "vec3", value: [21.0e-6, 21.0e-6, 21.0e-6] },
    u_waterMaskTranslationAndScale: { type: "vec4", value: [0.0, 0.0, 1.0, 1.0] },
    u_zoomedOutOceanSpecularIntensity: { type: "float", value: 0.5 },
    u_lambertDiffuseMultiplier: { type: "float", value: 1.0 },
    u_vertexShadowDarkness: { type: "float", value: 0.3 },
    u_verticalExaggerationAndRelativeHeight: { type: "vec2", value: [2.0, 0.0] },
    czm_modelView3D: { type: "mat4", value: modelView },
    czm_projection: { type: "mat4", value: projection },
    czm_modelView: { type: "mat4", value: modelView },
    czm_inverseModelView: { type: "mat4", value: mat4Invert(modelView) },
    czm_view: { type: "mat4", value: view },
    czm_inverseView: { type: "mat4", value: inverseView },
    czm_normal3D: { type: "mat3", value: normal3D },
    czm_viewport: { type: "vec4", value: [0.0, 0.0, viewport.width, viewport.height] },
    czm_currentFrustum: { type: "vec2", value: [1.0, 1.0e7] },
    czm_frustumPlanes: { type: "vec4", value: [halfHeight, -halfHeight, halfHeight, halfHeight] },
    czm_orthographicIn3D: { type: "float", value: 0.0 },
    czm_sceneMode: { type: "float", value: 3.0 }, // SceneMode.SCENE3D
    czm_morphTime: { type: "float", value: 1.0 },
    czm_pixelRatio: { type: "float", value: 1.0 },
    czm_frameNumber: { type: "float", value: 1.0 },
    czm_eyeHeight: { type: "float", value: 30000.0 },
    czm_gamma: { type: "float", value: 2.2 },
    czm_fogDensity: { type: "float", value: 0.0002 },
    czm_fogVisualDensityScalar: { type: "float", value: 1.0 },
    czm_splitPosition: { type: "float", value: 0.5 },
    czm_lightColor: { type: "vec3", value: [1.0, 1.0, 1.0] },
    czm_lightDirectionWC: { type: "vec3", value: up },
    czm_sunDirectionWC: { type: "vec3", value: up },
    czm_lightDirectionEC: { type: "vec3", value: [0.0, 0.0, 1.0] },
    czm_ellipsoidRadii: { type: "vec3", value: [ELLIPSOID_RADII.x, ELLIPSOID_RADII.y, ELLIPSOID_RADII.z] },
    czm_ellipsoidInverseRadii: { type: "vec3", value: [1 / ELLIPSOID_RADII.x, 1 / ELLIPSOID_RADII.y, 1 / ELLIPSOID_RADII.z] },
    czm_viewerPositionWC: { type: "vec3", value: eyeWC },
  };

  return {
    id: SCENE_ID,
    config: SCENE_CONFIG,
    quantized,
    vertexCount: count,
    indexCount: indices.length,
    stride,
    interleaved,
    indices,
    positionsMC,
    ecefPoints,
    heights,
    heightRange: [minHeight, maxHeight],
    center3D,
    surface,
    eyeWC,
    view,
    projection,
    modelViewProjection,
    imagery,
    uniforms,
    /** Attribute locations exactly as `Core/TerrainEncoding.js:650-656`. */
    attributeLayout: quantized
      ? [
          { name: "compressed0", location: 0, format: "float32x4", offset: 0, stride },
          { name: "compressed1", location: 1, format: "float32", offset: 16, stride },
        ]
      : [
          { name: "position3DAndHeight", location: 0, format: "float32x4", offset: 0, stride },
          { name: "textureCoordAndEncodedNormals", location: 1, format: "float32x4", offset: 16, stride },
        ],
  };
}

/** Web-Mercator Y of a latitude in degrees (matches the shader's `czm_latitudeToWebMercatorFraction`). */
export function mercatorY(latitudeDegrees) {
  const sinLatitude = Math.sin((latitudeDegrees * Math.PI) / 180);
  return 0.5 * Math.log((1 + sinLatitude) / (1 - sinLatitude));
}

/** Elevation of a model-space point relative to the WGS84 ellipsoid surface (the T026 numeric check). */
export function elevationOf(positionWC) {
  const { x: a, y: b, z: c } = ELLIPSOID_RADII;
  const k = Math.sqrt((positionWC[0] / a) ** 2 + (positionWC[1] / b) ** 2 + (positionWC[2] / c) ** 2);
  // Scale to the ellipsoid, then measure the distance back to the surface point.
  const surface = [positionWC[0] / k, positionWC[1] / k, positionWC[2] / k];
  return Math.hypot(positionWC[0] - surface[0], positionWC[1] - surface[1], positionWC[2] - surface[2]);
}
