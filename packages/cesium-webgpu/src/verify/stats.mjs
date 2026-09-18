/**
 * Frame statistics (contract verification-and-benchmark §2, data-model §7.1).
 *
 * Pure CPU, dependency-free ESM so that unit tests, Playwright runs and CI tooling all share
 * one implementation of the numbers that every visual/statistical assertion compares against.
 *
 * Conventions (fixed, so thresholds stay meaningful):
 *   - pixel buffers are RGBA8, top-left origin, row-major, `width * height * 4` bytes;
 *   - a pixel counts as "background" when it matches the background colour exactly, or within
 *     `colourTolerance` per channel (default 0 = exact match);
 *   - `uniqueColorCount` counts distinct RGBA tuples;
 *   - `depthDiscontinuityRatio` counts neighbouring samples (right/down) whose absolute
 *     difference exceeds `threshold`, divided by the number of compared pairs;
 *   - percentiles use linear interpolation between closest ranks (R-7 / PERCENTILE.INC).
 */

/** Linear-interpolated percentile of an unsorted numeric array; returns NaN for an empty input. */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return Number.NaN;
  if (!(p >= 0 && p <= 1)) throw new RangeError(`percentile: p MUST be within [0, 1], got ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

/** `{ p50, p95 }` frame-time summary in milliseconds. */
export function frameTimeSummary(durations) {
  return {
    p50: round(percentile(durations, 0.5)),
    p95: round(percentile(durations, 0.95)),
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function assertPixelBuffer(pixels, width, height, label) {
  if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray || Array.isArray(pixels))) {
    throw new TypeError(`${label}: expected a Uint8Array/Uint8ClampedArray/Array of RGBA bytes`);
  }
  const expected = width * height * 4;
  if (pixels.length !== expected) {
    throw new RangeError(`${label}: expected ${expected} bytes for ${width}x${height} RGBA, got ${pixels.length}`);
  }
}

/** Share of pixels that differ from the background colour, in [0, 1]. */
export function nonBackgroundRatio(pixels, { width, height, background = [0, 0, 0, 255], colourTolerance = 0 }) {
  assertPixelBuffer(pixels, width, height, "nonBackgroundRatio");
  const total = width * height;
  let count = 0;
  for (let i = 0; i < total; i += 1) {
    const offset = i * 4;
    const matches =
      Math.abs(pixels[offset] - background[0]) <= colourTolerance &&
      Math.abs(pixels[offset + 1] - background[1]) <= colourTolerance &&
      Math.abs(pixels[offset + 2] - background[2]) <= colourTolerance &&
      Math.abs(pixels[offset + 3] - background[3]) <= colourTolerance;
    if (!matches) count += 1;
  }
  return count / total;
}

/** Number of distinct RGBA tuples in the frame. */
export function uniqueColorCount(pixels) {
  const seen = new Set();
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    seen.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]},${pixels[offset + 3]}`);
  }
  return seen.size;
}

/**
 * Share of neighbouring depth samples whose absolute difference exceeds `threshold`,
 * compared right/down over a row-major float array of `width * height` samples.
 */
export function depthDiscontinuityRatio(depth, { width, height, threshold }) {
  if (!(depth instanceof Float32Array || depth instanceof Float64Array || Array.isArray(depth))) {
    throw new TypeError("depthDiscontinuityRatio: expected a Float32Array/Float64Array/Array of depth samples");
  }
  if (depth.length !== width * height) {
    throw new RangeError(`depthDiscontinuityRatio: expected ${width * height} samples, got ${depth.length}`);
  }
  let pairs = 0;
  let discontinuities = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (x + 1 < width) {
        pairs += 1;
        if (Math.abs(depth[index] - depth[index + 1]) > threshold) discontinuities += 1;
      }
      if (y + 1 < height) {
        pairs += 1;
        if (Math.abs(depth[index] - depth[index + width]) > threshold) discontinuities += 1;
      }
    }
  }
  return pairs === 0 ? 0 : discontinuities / pairs;
}

/**
 * Assemble the `FrameStatistics` record used by every verification run.
 *
 * @param {object} input
 * @param {Uint8Array} input.pixels RGBA8 frame
 * @param {number} input.width
 * @param {number} input.height
 * @param {number[]} [input.background] background colour (default opaque black)
 * @param {ArrayLike<number>} [input.depth] depth samples (optional; then the ratio is 0)
 * @param {number} [input.depthThreshold] absolute depth difference that counts as a discontinuity
 * @param {number[]} [input.frameTimesMs] measured frame durations for the p50/p95 summary
 * @param {number} [input.triangleCount]
 * @param {number} [input.drawCallCount]
 * @param {number} [input.tileCount]
 */
export function computeFrameStatistics(input) {
  const {
    pixels,
    width,
    height,
    background = [0, 0, 0, 255],
    colourTolerance = 0,
    depth = null,
    depthThreshold = 1e-4,
    frameTimesMs = [],
    triangleCount = 0,
    drawCallCount = 0,
    tileCount = 0,
  } = input;

  assertPixelBuffer(pixels, width, height, "computeFrameStatistics");

  return {
    nonBackgroundRatio: round(nonBackgroundRatio(pixels, { width, height, background, colourTolerance })),
    uniqueColorCount: uniqueColorCount(pixels),
    depthDiscontinuityRatio: depth === null ? 0 : round(depthDiscontinuityRatio(depth, { width, height, threshold: depthThreshold })),
    triangleCount,
    drawCallCount,
    tileCount,
    frameTimeMs: frameTimeSummary(frameTimesMs.length > 0 ? frameTimesMs : [0]),
  };
}
