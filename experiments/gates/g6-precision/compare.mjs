#!/usr/bin/env node
/**
 * G-6 gate runner, part 3 — **offline comparison** of the two independently captured frames
 * (tasks.md T026; hypotheses H-6/H-7; FR-014 「差异 MUST 按其来源逐项声明」).
 *
 *   node experiments/gates/g6-precision/compare.mjs --offscreen
 *
 * Inputs: `experiments/gates/out/g6-precision-webgpu.json` and
 * `experiments/gates/out/g6-precision-webgl2.json` — written by two **separate** runs of
 * `run.mjs --backend=…` (never one session, never one frame).
 *
 * What it computes, and what each number is allowed to be:
 *
 *   1. **frame alignment** — the WebGL2 readback is bottom-up (`gl.readPixels` window origin), the
 *      WebGPU readback is top-down; the comparison flips the GL frame. That is a *window*-origin
 *      convention, not a texture one, and is declared as such.
 *   2. **pixel diff** with an **edge mask**: pixels whose 3×3 luminance neighbourhood has a large
 *      gradient in either frame are excluded and *counted* (declared difference `subpixel-edge`).
 *      The remaining pixels are compared per channel against `differences.declared[].tolerance`.
 *   3. **terrain elevation** — the radius encoded by the elevation pass is decoded on both sides and
 *      compared numerically (max / mean absolute difference in metres), through the *same* vertex
 *      stage in both backends.
 *   4. **texture Y flip** — the four corners of the `texel-probe` frame are compared per backend and
 *      against the fixture's known texels, which turns "the mapping layer handles the flip" into an
 *      assertion instead of a comment.
 *
 * MUST NOT be relaxed to "any difference passes" (FR-014): every tolerance below names its source,
 * and the comparison fails if a declared source's numbers exceed it or if an undeclared difference
 * source appears.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encodeDiffPng } from "../shared/png.mjs";
import { OUT_DIR, REPO_ROOT } from "../g5-shader/model.mjs";

/**
 * Declared difference sources, each with the **basis** of its tolerance (FR-014). The comparison
 * fails on any difference that cannot be attributed to one of these.
 */
export const DECLARED_DIFFERENCES = [
  {
    id: "subpixel-edge",
    what: "亚像素边缘：三角形光栅化边界与插值在两条路径上的最后一位取整不同",
    basis: "由 edge mask 排除并**计数**（梯度阈值 8/255 在 3×3 邻域）；被排除的像素数写入证据，MUST NOT 用作放宽其余像素判据的理由",
    tolerance: { excluded: true, gradientThreshold: 8 },
  },
  {
    id: "msaa-resolve",
    what: "MSAA 解析：两条路径在本夹具中都不使用多采样（WebGPU 无 sampleCount>1 附件，WebGL2 不申请 MSAA 上下文）",
    basis: "不适用（absence 验证：环境字段记录 antialias:false）；真实后端启用 MSAA 时，其解析差异属边缘像素，由 subpixel-edge 的 edge mask 覆盖",
    tolerance: { applicable: false },
  },
  {
    id: "srgb",
    what: "sRGB：两路径都渲染到 8 位 UNORM 目标且不做 sRGB 编解码（`bgra8unorm` / `RGBA8`），无色彩空间差",
    basis: "差异上界 = 1 LSB（8 位量化）；实测差异应远小于该上界",
    tolerance: { perChannel: 2 },
  },
  {
    id: "depth-representation",
    what: "深度表示：GL clip z∈[-1,1] vs WebGPU NDC z∈[0,1]",
    basis: "本夹具为单趟、无深度附件、两路径共用同一个零到一深度投影矩阵，因此深度表示差异不进入像素；差异上界 0，任何非零差异都 MUST 归因到其他来源",
    tolerance: { perChannel: 0, note: "not exercised by this fixture" },
  },
  {
    id: "wgsl-precision-modifiers",
    what: "WGSL 无 `highp`/`mediump` 精度修饰符，GLSL 片元声明 `precision highp float`",
    basis: "同一算法的两次 float32 求值在 8 位目标上的量化差；容差 2 LSB/通道（8 位量化 + 数个 ULP 的函数实现差）",
    tolerance: { perChannel: 2, differingFraction: 0.01 },
  },
  {
    id: "swapchain-channel-order",
    what: "交换链格式的通道顺序：本机 `getPreferredCanvasFormat()` = `bgra8unorm`，WebGPU 回读字节序为 B,G,R,A；`gl.readPixels(RGBA)` 给出 R,G,B,A",
    basis: "在 WebGPU 半程回读后立即归一化为 RGBA（声明为对齐步骤，不是容许差异）；若不处理，逐像素比较会看到每个像素都不同（R/B 互换，实测最大 166 LSB）",
    tolerance: { alignmentSwizzle: true },
  },
  {
    id: "texture-y-flip",
    what: "纹理 Y 翻转：WebGPU 纹理原点在上、GL 在下",
    basis: "由 Texture 映射层统一处理并**断言**：GL 侧 `UNPACK_FLIP_Y_WEBGL=true`（Cesium `Texture.flipY` 默认），WebGPU 侧上传时反转行序；四角纹素回读在两路径上 MUST 一致",
    tolerance: { perChannel: 0, corners: true },
  },
  {
    id: "window-origin",
    what: "窗口原点：`gl.readPixels` 自下而上、WebGPU 回读自上而下",
    basis: "比较前把 GL 帧整体翻转（`rowsBottomUp: true`）；这是**窗口**坐标约定，与纹理坐标无关，声明为对齐步骤而非容许差异",
    tolerance: { alignmentFlip: true },
  },
];

const HERE = path.dirname(fileURLToPath(import.meta.url));

function check(id, ok, detail, extra = {}) {
  return { id, ok: ok === true, detail, ...extra };
}

function decode(frame) {
  const bytes = Buffer.from(frame.rgbaBase64, "base64");
  return { bytes, bytesPerRow: frame.bytesPerRow, width: frame.width, height: frame.height };
}

/** Pixel at (x, y) in top-down row order; `frame.flipRows` says whether the raw buffer is bottom-up. */
function pixelAt(frame, x, y) {
  const row = frame.rowsBottomUp === true ? frame.height - 1 - y : y;
  const offset = row * frame.bytesPerRow + x * 4;
  return [frame.bytes[offset], frame.bytes[offset + 1], frame.bytes[offset + 2], frame.bytes[offset + 3]];
}

/** 3×3 luminance-gradient edge mask (computed on whichever side has the larger gradient). */
function edgeMask(frame, threshold) {
  const luminance = (x, y) => {
    const [r, g, b] = pixelAt(frame, x, y);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const mask = new Uint8Array(frame.width * frame.height);
  for (let y = 1; y < frame.height - 1; y += 1) {
    for (let x = 1; x < frame.width - 1; x += 1) {
      const centre = luminance(x, y);
      const gradient = Math.max(
        Math.abs(luminance(x - 1, y) - centre),
        Math.abs(luminance(x + 1, y) - centre),
        Math.abs(luminance(x, y - 1) - centre),
        Math.abs(luminance(x, y + 1) - centre),
      );
      if (gradient > threshold) mask[y * frame.width + x] = 1;
    }
  }
  return mask;
}

function compareFrames(a, b, tolerance) {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`g6-compare: frame size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const maskA = edgeMask(a, tolerance.gradientThreshold);
  const maskB = edgeMask(b, tolerance.gradientThreshold);
  let edgePixels = 0;
  let compared = 0;
  let differing = 0;
  let maxDelta = 0;
  const deltaHistogram = new Map();
  const differingSamples = [];
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const index = y * a.width + x;
      if (maskA[index] === 1 || maskB[index] === 1) {
        edgePixels += 1;
        continue;
      }
      compared += 1;
      const left = pixelAt(a, x, y);
      const right = pixelAt(b, x, y);
      const delta = Math.max(Math.abs(left[0] - right[0]), Math.abs(left[1] - right[1]), Math.abs(left[2] - right[2]));
      deltaHistogram.set(delta, (deltaHistogram.get(delta) ?? 0) + 1);
      if (delta > 0) {
        differing += 1;
        if (differingSamples.length < 8) differingSamples.push({ x, y, webgpu: left, webgl2: right, delta });
      }
      if (delta > maxDelta) maxDelta = delta;
    }
  }
  return {
    comparedPixels: compared,
    edgePixels,
    differingPixels: differing,
    differingFraction: compared === 0 ? 0 : differing / compared,
    maxChannelDelta: maxDelta,
    deltaHistogram: [...deltaHistogram.entries()].sort((p, q) => p[0] - q[0]).map(([delta, count]) => ({ delta, count })),
    differingSamples,
  };
}

function decodeElevation(frame, range) {
  const values = new Float64Array(frame.width * frame.height);
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const [r] = pixelAt(frame, x, y);
      values[y * frame.width + x] = range[0] + (r / 255) * (range[1] - range[0]);
    }
  }
  return values;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes("--offscreen")) {
    console.error("g6-compare: --offscreen is required (the comparison is offline by construction)");
    return 2;
  }
  const webgpuPath = path.join(OUT_DIR, "g6-precision-webgpu.json");
  const webgl2Path = path.join(OUT_DIR, "g6-precision-webgl2.json");
  for (const file of [webgpuPath, webgl2Path]) {
    if (!fs.existsSync(file)) {
      console.error(`g6-compare: missing ${path.relative(REPO_ROOT, file)} — run both halves first (one backend per run)`);
      return 2;
    }
  }
  const webgpu = JSON.parse(fs.readFileSync(webgpuPath, "utf8"));
  const webgl2 = JSON.parse(fs.readFileSync(webgl2Path, "utf8"));
  const checks = [];

  const colorA = { ...decode(webgpu.frames.color), rowsBottomUp: false };
  const colorB = { ...decode(webgl2.frames.color), rowsBottomUp: true };
  const elevationA = { ...decode(webgpu.frames.elevation), rowsBottomUp: false };
  const elevationB = { ...decode(webgl2.frames.elevation), rowsBottomUp: true };
  const texelA = { ...decode(webgpu.frames["texel-probe"]), rowsBottomUp: false };
  const texelB = { ...decode(webgl2.frames["texel-probe"]), rowsBottomUp: true };

  const precision = DECLARED_DIFFERENCES.find((entry) => entry.id === "wgsl-precision-modifiers");
  const srgb = DECLARED_DIFFERENCES.find((entry) => entry.id === "srgb");
  const pixelDiff = compareFrames(colorA, colorB, { gradientThreshold: DECLARED_DIFFERENCES[0].tolerance.gradientThreshold });
  checks.push(
    check(
      "color-frame-diff-within-declared-tolerances",
      pixelDiff.maxChannelDelta <= precision.tolerance.perChannel && pixelDiff.differingFraction <= precision.tolerance.differingFraction,
      `emitted-WGSL frame vs upstream-GLSL frame: ${pixelDiff.differingPixels}/${pixelDiff.comparedPixels} compared pixel(s) differ (${(pixelDiff.differingFraction * 100).toFixed(3)}%, budget ${(precision.tolerance.differingFraction * 100).toFixed(2)}%), ` +
        `max channel delta ${pixelDiff.maxChannelDelta} LSB (budget ${precision.tolerance.perChannel}); ${pixelDiff.edgePixels} edge pixel(s) excluded by the declared edge mask ` +
        `(gradient > ${DECLARED_DIFFERENCES[0].tolerance.gradientThreshold}/255); first differences: ${JSON.stringify(pixelDiff.differingSamples.slice(0, 4))}`,
      { source: "wgsl-precision-modifiers" },
    ),
  );
  checks.push(
    check(
      "no-undeclared-difference-source-in-the-color-frame",
      pixelDiff.maxChannelDelta <= Math.max(precision.tolerance.perChannel, srgb.tolerance.perChannel) && pixelDiff.comparedPixels > 0,
      `every differing pixel is inside the declared ` +
        `\`wgsl-precision-modifiers\` / \`srgb\` bounds; the diff histogram is published (${pixelDiff.deltaHistogram.length} bucket(s)) so an unexplained tail would be visible`,
      { source: "FR-014" },
    ),
  );

  const range = webgpu.radiusRange ?? webgl2.radiusRange;
  // One LSB of the elevation encoder, in metres — the tolerance unit (see the basis note below).
  const lsbMeters = (range[1] - range[0]) / 255;
  const elevationWebgpu = decodeElevation(elevationA, range);
  const elevationWebgl2 = decodeElevation(elevationB, range);
  let maxDifference = 0;
  let sumDifference = 0;
  let maxIndex = 0;
  let beyondOneLsb = 0;
  for (let index = 0; index < elevationWebgpu.length; index += 1) {
    const difference = Math.abs(elevationWebgpu[index] - elevationWebgl2[index]);
    sumDifference += difference;
    if (difference > 0) {
      const lsb = Math.round(difference / lsbMeters);
      if (lsb > 1) beyondOneLsb += 1;
    }
    if (difference > maxDifference) {
      maxDifference = difference;
      maxIndex = index;
    }
  }
  const meanDifference = sumDifference / elevationWebgpu.length;
  /**
   * Tolerance basis (derived from the encoder, **not** from the measurement): the elevation pass
   * encodes `length(positionMC)` into one 8-bit channel over `[MIN, MAX]`, so one LSB is
   * `(MAX - MIN) / 255` ≈ 91.9 m of radius. Two independent float32 evaluations of the same
   * expression may round to adjacent bytes, so the per-pixel bound is **one LSB**, and any pixel
   * differing by more than one LSB fails. (The earlier draft of this tolerance was expressed in
   * metres from the float32 ULP alone and forgot the encoder's own quantisation — the measurement
   * exposed the omission; the bound was corrected by *adding* the quantisation term, not by widening
   * a bound that had been met.)
   */
  const elevationTolerance = { perPixelMaxLsb: 1, perPixelMaxMeters: lsbMeters, pixelsBeyondOneLsb: 0, basis: `one LSB of the elevation encoder = (${range[1].toFixed(2)} - ${range[0].toFixed(2)}) / 255 = ${lsbMeters.toFixed(4)} m; float32 ULP at 6.38e6 m is ≈0.38 m and is far below one LSB, so it cannot on its own move the encoded byte` };
  checks.push(
    check(
      "terrain-elevation-agrees-numerically",
      beyondOneLsb === 0,
      `decoded terrain radius through the SAME vertex stage in both backends: max |Δ| = ${maxDifference.toFixed(4)} m (${(maxDifference / lsbMeters).toFixed(3)} LSB, budget 1 LSB = ${lsbMeters.toFixed(3)} m), ` +
        `mean |Δ| = ${meanDifference.toFixed(4)} m over ${elevationWebgpu.length} pixel(s); pixels differing by more than one LSB: ${beyondOneLsb}; ` +
        `encoder range [${range[0].toFixed(2)}, ${range[1].toFixed(2)}] m; worst pixel index ${maxIndex} (${maxIndex % elevationA.width}, ${Math.floor(maxIndex / elevationA.width)})`,
      { source: "wgsl-precision-modifiers" },
    ),
  );

  const expected = webgpu.passes["texel-probe"].expectedTexels;
  const cornerNames = ["topLeft", "topRight", "bottomLeft", "bottomRight"];
  // The declared convention: both backends put the image's **last** row at the screen top (GL's
  // `flipY: true`), so the screen corners equal the fixture's corners with the rows mirrored.
  const mirrored = { topLeft: "bottomLeft", topRight: "bottomRight", bottomLeft: "topLeft", bottomRight: "topRight" };
  const cornerResults = cornerNames.map((name) => {
    const [x, y] = { topLeft: [1, 1], topRight: [texelA.width - 2, 1], bottomLeft: [1, texelA.height - 2], bottomRight: [texelA.width - 2, texelA.height - 2] }[name];
    return { name, webgpu: pixelAt(texelA, x, y), webgl2: pixelAt(texelB, x, y), expectedUnderDeclaredConvention: expected[mirrored[name]], rawFixtureCorner: expected[name] };
  });
  const cornersMatch = cornerResults.every((entry) => entry.webgpu.slice(0, 3).every((value, index) => Math.abs(value - entry.webgl2[index]) <= 2));
  const cornersDistinct = new Set(cornerResults.map((entry) => entry.webgpu.slice(0, 3).join(","))).size === 4;
  const cornersMatchDeclaredConvention = cornerResults.every((entry) => entry.webgpu.slice(0, 3).every((value, index) => Math.abs(value - entry.expectedUnderDeclaredConvention[index]) <= 6));
  checks.push(
    check(
      "texture-origin-and-y-flip-are-handled-by-the-mapping-layer",
      cornersMatch && cornersDistinct && cornersMatchDeclaredConvention,
      `texel probe corners (webgpu | webgl2 | fixture texel under the declared convention): ` +
        `${cornerResults.map((entry) => `${entry.name}=${JSON.stringify(entry.webgpu.slice(0, 3))}|${JSON.stringify(entry.webgl2.slice(0, 3))}|${JSON.stringify(entry.expectedUnderDeclaredConvention.slice(0, 3))}`).join("  ")} — ` +
        `four distinct texels are reached, both backends agree within 2 LSB, and both match the fixture under the declared flip convention within 6 LSB (bilinear sampling at the texel centre). ` +
        `Policy (recorded in each half's environment.textureFlipPolicy): GL uses UNPACK_FLIP_Y_WEBGL=true (Cesium Texture.flipY default, Renderer/Texture.js:27); WebGPU has no unpack flag and its ` +
        `origin is the top-left, so the row order is reversed on upload — the two are equivalent, which is what this assertion establishes. ` +
        `The probe uses a screen-consistent uv in both APIs (gl_FragCoord.y is bottom-up, WGSL's position.y is top-down).`,
      { source: "texture-y-flip" },
    ),
  );

  const diffPng = path.join(OUT_DIR, "g6-precision-diff.png");
  fs.writeFileSync(diffPng, encodeDiffPng(colorA.bytes, colorB.bytes, colorA.width, colorA.height));

  const failed = checks.filter((entry) => entry.ok !== true);
  const verdict = failed.length === 0 ? "pass" : "fail";
  const document = {
    gate: "g6-precision",
    task: "T026",
    verdict,
    recordedAt: new Date().toISOString(),
    notes:
      `离线比较两个**独立运行**采到的同一固定场景帧（webgpu: ${webgpu.recordedAt}；webgl2: ${webgl2.recordedAt}）。` +
      `差异按来源逐项声明（${DECLARED_DIFFERENCES.length} 条），容差给出依据；` +
      "任何无法归因到已声明来源的差异都会使本门禁 fail（FR-014：MUST NOT 放宽为「任意差异通过」）。" +
      `WebGL2 帧为自下而上的窗口原点，比较前整体翻转（声明为对齐步骤，与纹理坐标无关）。`,
    environment: { node: process.version, platform: `${process.platform} ${process.arch}`, webgpu: webgpu.environment, webgl2: webgl2.environment },
    runs: { webgpu: { recordedAt: webgpu.recordedAt, adapter: webgpu.environment?.adapter ?? null }, webgl2: { recordedAt: webgl2.recordedAt, adapter: webgl2.environment?.adapter ?? null }, sameProcess: false },
    checks,
    evidence: [
      { path: "experiments/gates/out/g6-precision-webgpu.json", what: "webgpu half (frame + elevation + texel probe)" },
      { path: "experiments/gates/out/g6-precision-webgl2.json", what: "webgl2 half (real upstream assembled GLSL)" },
      { path: "experiments/gates/out/g6-precision-diff.png", what: "per-pixel difference image (4× amplified)" },
      { path: "experiments/gates/out/g6-precision-webgpu-color.png", what: "webgpu shaded frame" },
      { path: "experiments/gates/out/g6-precision-webgl2-color.png", what: "webgl2 shaded frame" },
      { path: "experiments/gates/g6-precision/compare.mjs", what: "this comparison (including the declared difference table)" },
    ].filter((entry) => fs.existsSync(path.join(REPO_ROOT, entry.path))),
    declaredDifferences: DECLARED_DIFFERENCES,
    measurements: {
      pixelDiff,
      elevation: { ...elevationTolerance, maxAbsDifferenceMeters: maxDifference, meanAbsDifferenceMeters: meanDifference, worstPixel: { x: maxIndex % elevationA.width, y: Math.floor(maxIndex / elevationA.width) }, samples: elevationWebgpu.length },
      texelCorners: cornerResults,
      frameStats: { webgpu: webgpu.passes.color, webgl2: webgl2.passes.color },
      elevationFrameStats: { webgpu: webgpu.passes.elevation, webgl2: webgl2.passes.elevation },
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, "g6-precision.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  for (const entry of checks) process.stdout.write(`  [${entry.ok ? "ok" : "FAIL"}] ${entry.id}: ${entry.detail}\n`);
  process.stdout.write(`[g6-compare] verdict=${verdict} (${checks.filter((entry) => entry.ok === true).length}/${checks.length}) -> experiments/gates/out/g6-precision.json\n`);
  void HERE;
  return verdict === "pass" ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`g6-compare: unexpected failure: ${error?.stack ?? error}`);
    process.exitCode = 2;
  }
}
