/**
 * T092 — 地形多瓦片视觉回归（`层=视觉`，FR-010/FR-013/FR-014；SC-002(rev)/SC-009）。
 *
 * ## 这个套件证明什么
 *
 * 固定数据集 / 相机 / 时刻 / 视口 / 像素比，跑出一帧地形画面，与**同一后端自己的参考帧**逐像素比较。
 * 每条后端各有**一份**参考帧（`reference-frames/terrain-multitile/<datasetId>/<caseId>.<backend>.png`），
 * 比较在**同一进程内只读一个 backend 的参考帧**：跨路径差异一律离线比较，MUST NOT 同帧对比
 * （原则 II；离线比较工具为 `tests/support/compare-offline.mjs`，本套件不启动第二条路径）。
 *
 * ## 两段式协议（参考帧由运行产生，不是手绘）
 *
 *   1. **生成基线**：`$env:VISUAL_TERRAIN_BASELINE="1"; node tests/support/backend-runner.mjs --backend=<b> --suite=visual:terrain`
 *      —— 把本次运行**合成器截图的实际字节**落盘为参考帧（不做重编码），并写 `ToleranceRecord`；
 *   2. **比对**：`node tests/support/backend-runner.mjs --backend=<b> --suite=visual:terrain`
 *      —— 参考帧/记录缺失即**失败**（绝不悄悄重建基线），条件或容差表不一致也失败并提示重新生成。
 *
 * ## 基线口径（重要，来自 tasks.md T092 原文 + T094 的实测结论）
 *
 * 参考帧记录的是**当前"起伏显式后置"状态**下的画面：近地相机下上游
 * `fade = clamp((far − near) / …, 0, 1) = 0` ⇒ `finalColor = color × lightColor`，地形为**无明暗调制的
 * 基础色**。因此：
 *   - 参考帧 **MUST NOT** 被读作"起伏/明暗调制已验证"；
 *   - 将来引入起伏增量时 **MUST 重新生成两条路径的参考帧**，并在 `ToleranceRecord` 里写明
 *     "因起伏增量而重生成"（`baselineState.regenerationPolicy` 里逐字写了这条要求）。
 * 本套件用可执行的方式守住这条口径：`frame-content` 判据要求画面**非空白/非纯单色**，而
 * `baseline-state-flat-surface` 判据要求主色仍是基础色家族（当前状态的事实），两者的实测值都落盘。
 *
 * ## 失败产出的证据
 *
 * 任何判据失败都会先把**差异图**（放大差异 + 标出被排除的抗锯齿带）与**统计 JSON**写到
 * `artifacts/terrain/`，然后才断言失败 —— 于是失败的运行也留下可看的证据。
 *
 * ## 反例自检（强制）
 *
 * `$env:VISUAL_TERRAIN_NEGATIVE_CONTROL="pixel"`：把容差强制为 0 后，把**实际帧**某一个位于比较区域
 * （确定不在排除带内）的像素某通道 +1 LSB。比较路径本身一个字节都不改，运行**必须失败**并产出差异图。
 * `="shift"`：把实际帧整体横移 4 px（> 轮廓判据的 4 px/行预算 … 逐行计数必然超预算），同样必须失败。
 * 一个不可能失败的视觉比较不是证据，所以这两种扰动是套件的组成部分。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { test } from "playwright/test";

import { REPO_ROOT } from "../support/backend-build.mjs";
import { ARTIFACT_ROOT, assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";
import { decodePng } from "../support/png-reader.mjs";

// One run builds the bundle, launches Chrome and loads the page; a cold build alone exceeds
// Playwright's 30 s default, so the budget is stated here.
test.setTimeout(300_000);

/** The case identity: changing any of these is a new case and MUST be re-baselined. */
const CASE = Object.freeze({
  caseId: "matterhorn-multitile",
  datasetId: "matterhorn-z0-12",
  /** The declared camera; the page echoes the camera it really used and this suite compares them. */
  camera: Object.freeze({ longitude: 6.8652, latitude: 45.8326, height: 24000, heading: 0, pitch: -50, roll: 0 }),
  dateIso: "2026-03-20T12:00:00Z",
  viewport: Object.freeze({ width: 320, height: 200, pixelRatio: 1 }),
});

const REFERENCE_DIR = path.join(REPO_ROOT, "reference-frames", "terrain-multitile", CASE.datasetId);
const referenceFramePath = (backend) => path.join(REFERENCE_DIR, `${CASE.caseId}.${backend}.png`);
const toleranceRecordPath = (backend) => path.join(REFERENCE_DIR, `${CASE.caseId}.${backend}.tolerance.json`);
const artifactDir = path.join(ARTIFACT_ROOT, "terrain");
const statsPath = (backend) => path.join(artifactDir, `multitile-${backend}-compare.json`);
const diffPath = (backend) => path.join(artifactDir, `multitile-${backend}-diff.png`);

/** `VISUAL_TERRAIN_BASELINE=1` writes a missing reference frame; `=regenerate` deliberately replaces one. */
const BASELINE_MODE = process.env.VISUAL_TERRAIN_BASELINE ?? null;
/** `VISUAL_TERRAIN_NEGATIVE_CONTROL=pixel|shift` runs the counter-example self-check (see the header). */
const NEGATIVE_CONTROL = process.env.VISUAL_TERRAIN_NEGATIVE_CONTROL ?? null;
/** `shift` arm displacement: larger than the 4 px/row silhouette budget, so the control MUST be caught. */
const SHIFT_PIXELS = 4;

/**
 * `ToleranceRecord` — 每一条差异来源、它的容差**值**与这个值的**依据**（FR-014：差异必须按来源声明，
 * 不允许"任意差异通过"）。这里的表就是唯一的事实来源：基线生成时写入记录，比对时**逐字段复核记录与
 * 代码一致**（不一致即失败并提示重新生成，绝不静默放宽）。
 */
const TOLERANCE = [
  {
    id: "anti-aliased-edge",
    what: "抗锯齿/亚像素边缘：光栅化边界在两次运行间落在像素内的不同位置（三角形覆盖率、MSAA 解析）",
    basis:
      "沿几何边缘**排除并计数**：3×3 亮度梯度 > 8/255（与仓库既有声明 `subpixel-edge` 同一判据与阈值，来源 experiments/gates/g6-precision/compare.mjs 的 DECLARED_DIFFERENCES[0]），" +
      "在参考帧与实际帧上分别计算后取**并集**（只在其中一帧上存在的梯度正是亚像素差异），再做半径 1 的膨胀：边界在像素内的位移不确定性 ≤ 1 px，故膨胀 1 px 覆盖边界两侧；" +
      "被排除的像素数与占比写入证据，MUST NOT 用作放宽其余像素判据的理由 —— 排除带内的几何由 silhouette-* 判据在整帧上独立约束。",
    tolerance: { excluded: true, gradientThreshold: 8, dilationRadius: 1, computedOn: "union(reference, actual)" },
  },
  {
    id: "unorm8-quantisation",
    what: "同一管线两次运行的 8 位 UNORM 量化：比较区域内每个像素每通道的最大允许差",
    basis:
      "上界 = 1 LSB：两次运行走同一条管线、同一台 GPU、同一浏览器与同一个合成器截图路径，像素值可表示的最小差就是 1 LSB；" +
      "每次比对实测的最大差、差异像素数与直方图写入 `artifacts/terrain/multitile-<backend>-compare.json` 的 `metrics.colour`；生成运行不比较任何东西，所以本记录的 `measurements.crossRun` 在生成时为 null，" +
      "实测为 0 时本上界仍是一个可表示量子，而不是放宽判据。",
    tolerance: { perChannelMaxDelta: 1 },
  },
  {
    id: "differing-pixel-budget",
    what: "允许落在 unorm8-quantisation 上界之内的像素比例",
    basis:
      "0.1 % 上限（320×200 → 最多 64 个像素）：吸收极少数恰好落在判据边界上的像素，同时不允许「整片都差 1 LSB」。仓库既有先例更宽（G-6 的 `wgsl-precision-modifiers`：2 LSB + 1 %），本案例取更紧的界。",
    tolerance: { maxDifferingFraction: 0.001 },
  },
  {
    id: "msaa-resolve",
    what: "MSAA 解析：两次运行对多采样附件的解析",
    basis:
      "解析是逐样本平均：边缘像素落在 anti-aliased-edge 的排除带内，其余像素的样本颜色相同因而解析结果相同。" +
      "多采样的实测状态写入 `record.fixedConditions.context`：WebGPU 臂给出数值 `sampleCount`，WebGL2 臂的上游 Context 不暴露该数值（记为 null，以 `context.msaa` 为据）；" +
      "该状态一变即为条件变更（MUST 重新生成参考帧），而不是靠加容差糊过去。",
    tolerance: { applicable: "edge-band-only" },
  },
  {
    id: "screencap-alignment",
    what: "sRGB / 交换链通道顺序 / 窗口原点：参考帧与实际帧都是**同一条路径**的 `page.screenshot()` PNG",
    basis:
      "两侧都取自同一个 `#contract-canvas` 区域的合成器截图（同一 backend、同一 canvas、同一 clip），编解码与通道顺序、Y 原点都是同一约定 → 属对齐性质而非容许差异，容差 0，" +
      "比较时不做任何翻转或通道重排；跨 backend 的差异一律离线比较（本套件在同一进程内只读一个 backend 的参考帧，MUST NOT 同帧对比）。",
    tolerance: { perChannel: 0, flip: false, swizzle: false },
  },
  {
    id: "silhouette-geometry",
    what: "轮廓几何：排除抗锯齿带之后，画面里承载地形几何的结构是地形轮廓（背景为清屏色）",
    basis:
      "若只做「排除边缘 + 比较颜色」，均匀表面上的几何变化（相机移动、瓦片缺失）会被排除带吞掉，比较就永不失真 —— 故轮廓另设独立判据：" +
      "前景覆盖率差 ≤ 0.5 个百分点、逐行前景像素计数差 ≤ 4 px（= 4 × 膨胀半径），两者都在**包含排除带**的整帧上计算。实测值写入统计 JSON。" +
      "口径披露：本基线的实测帧前景覆盖率为 100 %（相机俯视，画面内没有背景），所以这两条判据在当前基线上**不产生实质约束**，它们是几何变化的守卫" +
      "（相机改变或瓦片缺失会改变覆盖率与逐行计数），而不是对「起伏可见」的断言。",
    tolerance: { coverageDeltaMax: 0.005, rowCountDeltaMax: 4 },
  },
];

/**
 * 画面内容判据（"非空白/非纯背景色"的**数值**形式，T092(e)）。上界都取得比实测保守得多：这一条判据的
 * 职责是抓"空白/纯背景/整片单色"这一整类失败，而不是重新测量覆盖率（那是 T093/T094 的职责）。
 * 实测值（前景占比、颜色数、主色与主色占比）在生成基线与每次比对时都写进证据。
 */
const FRAME_CONTENT = {
  /** 前景 = 与 `png-reader.mjs` 的 `nonBackground` 同一判据（alpha > 8 且 r+g+b > 24）。 */
  foregroundRule: "alpha > 8 && r + g + b > 24 (same rule as png-reader.mjs regionStatistics.nonBackground)",
  minForegroundFraction: 0.15,
  minUniqueColours: 16,
  /** 排除带占比上限：它 MUST NOT 吞掉整帧，否则比较没有意义。 */
  maxExcludedFraction: 0.3,
  minComparedFraction: 0.5,
};

// ---------------------------------------------------------------------------------------------
// image helpers (dependency-free; the reader comes from tests/support/png-reader.mjs)
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Minimal 8-bit RGBA PNG encoder (filter 0) — the same dependency-free discipline as the reader. */
function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + row * width * 4, width * 4).copy(raw, row * (width * 4 + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function readFrame(file) {
  return decodePng(fs.readFileSync(file));
}

const luminanceAt = (image, x, y) => {
  const offset = (y * image.width + x) * 4;
  return 0.2126 * image.rgba[offset] + 0.7152 * image.rgba[offset + 1] + 0.0722 * image.rgba[offset + 2];
};

/** 3×3 luminance-gradient edge mask — the repository's declared `subpixel-edge` rule. */
function gradientMask(image, threshold) {
  const mask = new Uint8Array(image.width * image.height);
  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      const centre = luminanceAt(image, x, y);
      const gradient = Math.max(
        Math.abs(luminanceAt(image, x - 1, y) - centre),
        Math.abs(luminanceAt(image, x + 1, y) - centre),
        Math.abs(luminanceAt(image, x, y - 1) - centre),
        Math.abs(luminanceAt(image, x, y + 1) - centre),
      );
      if (gradient > threshold) mask[y * image.width + x] = 1;
    }
  }
  return mask;
}

/** Binary box dilation (Chebyshev radius) — the AA band grows by `radius` pixels on every side. */
function dilate(mask, width, height, radius) {
  if (radius <= 0) return Uint8Array.from(mask);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] !== 1) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          out[ny * width + nx] = 1;
        }
      }
    }
  }
  return out;
}

/** The foreground rule above, applied per pixel. */
const isForeground = (image, x, y) => {
  const offset = (y * image.width + x) * 4;
  return image.rgba[offset + 3] > 8 && image.rgba[offset] + image.rgba[offset + 1] + image.rgba[offset + 2] > 24;
};

/** Exact colour statistics of one frame (the reader's `uniqueColours` saturates at 256 by design). */
function frameStatistics(image) {
  const colours = new Map();
  let foreground = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const key = (image.rgba[offset] << 16) | (image.rgba[offset + 1] << 8) | image.rgba[offset + 2];
      colours.set(key, (colours.get(key) ?? 0) + 1);
      if (isForeground(image, x, y)) foreground += 1;
    }
  }
  let dominantKey = 0;
  let dominantCount = 0;
  for (const [key, count] of colours) {
    if (count > dominantCount) {
      dominantKey = key;
      dominantCount = count;
    }
  }
  const total = image.width * image.height;
  return {
    width: image.width,
    height: image.height,
    pixels: total,
    foregroundPixels: foreground,
    foregroundFraction: foreground / total,
    uniqueColours: colours.size,
    dominantColour: [(dominantKey >> 16) & 0xff, (dominantKey >> 8) & 0xff, dominantKey & 0xff],
    dominantFraction: dominantCount / total,
  };
}

/**
 * The comparison itself: colour judgement on the non-AA pixels + silhouette judgement over the whole
 * frame. Pure function of two decoded frames and the declared tolerance table (no I/O), so the negative
 * control exercises *this* code and nothing else.
 */
function compareFrames(reference, actual, options) {
  const gradientThreshold = options.gradientThreshold;
  const dilationRadius = options.dilationRadius;
  const width = reference.width;
  const height = reference.height;
  const checks = [];
  const check = (id, ok, detail, extra = {}) => checks.push({ id, ok: ok === true, detail, ...extra });

  check(
    "frame-size-matches",
    actual.width === width && actual.height === height,
    `reference ${width}x${height} vs actual ${actual.width}x${actual.height}`,
  );
  if (actual.width !== width || actual.height !== height) return { checks, metrics: { sizeMismatch: true } };

  // ---- the AA/edge exclusion, computed on both frames and dilated -----------------------------
  const maskReference = gradientMask(reference, gradientThreshold);
  const maskActual = gradientMask(actual, gradientThreshold);
  const union = new Uint8Array(width * height);
  let gradientPixels = 0;
  for (let index = 0; index < union.length; index += 1) {
    union[index] = maskReference[index] === 1 || maskActual[index] === 1 ? 1 : 0;
    if (maskReference[index] === 1) gradientPixels += 1;
  }
  let gradientPixelsActual = 0;
  for (let index = 0; index < maskActual.length; index += 1) if (maskActual[index] === 1) gradientPixelsActual += 1;
  const excluded = dilate(union, width, height, dilationRadius);

  // ---- colour judgement on the compared pixels -------------------------------------------------
  const histogram = new Map();
  const worstSamples = [];
  let excludedPixels = 0;
  let comparedPixels = 0;
  let differingPixels = 0;
  let maxDelta = 0;
  let worst = null;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (excluded[index] === 1) {
        excludedPixels += 1;
        continue;
      }
      comparedPixels += 1;
      const offset = index * 4;
      const delta = Math.max(
        Math.abs(reference.rgba[offset] - actual.rgba[offset]),
        Math.abs(reference.rgba[offset + 1] - actual.rgba[offset + 1]),
        Math.abs(reference.rgba[offset + 2] - actual.rgba[offset + 2]),
      );
      histogram.set(delta, (histogram.get(delta) ?? 0) + 1);
      if (delta > 0) {
        differingPixels += 1;
        if (delta > maxDelta) {
          maxDelta = delta;
          worst = { x, y, delta };
        }
        if (worstSamples.length < 8) {
          worstSamples.push({
            x,
            y,
            delta,
            reference: [reference.rgba[offset], reference.rgba[offset + 1], reference.rgba[offset + 2]],
            actual: [actual.rgba[offset], actual.rgba[offset + 1], actual.rgba[offset + 2]],
          });
        }
      }
    }
  }
  const differingFraction = differingPixels / Math.max(1, comparedPixels);
  const excludedFraction = excludedPixels / (width * height);

  // ---- silhouette judgement, over the whole frame (the excluded band included) ------------------
  const rowCounts = { reference: [], actual: [] };
  let maxRowDelta = 0;
  let rowsBeyondBudget = 0;
  let worstRow = null;
  for (let y = 0; y < height; y += 1) {
    let left = 0;
    let right = 0;
    for (let x = 0; x < width; x += 1) {
      if (isForeground(reference, x, y)) left += 1;
      if (isForeground(actual, x, y)) right += 1;
    }
    rowCounts.reference.push(left);
    rowCounts.actual.push(right);
    const delta = Math.abs(left - right);
    if (delta > maxRowDelta) {
      maxRowDelta = delta;
      worstRow = { y, reference: left, actual: right };
    }
    if (delta > options.rowCountDeltaMax) rowsBeyondBudget += 1;
  }
  const statisticsReference = frameStatistics(reference);
  const statisticsActual = frameStatistics(actual);
  const coverageDelta = Math.abs(statisticsReference.foregroundFraction - statisticsActual.foregroundFraction);

  // ---- judgements ------------------------------------------------------------------------------
  check(
    "excluded-fraction-bounded",
    excludedFraction <= options.maxExcludedFraction,
    `the anti-aliased band covers ${(excludedFraction * 100).toFixed(2)} % of the frame (bound ${(options.maxExcludedFraction * 100).toFixed(0)} %); ` +
      `gradient pixels: reference ${gradientPixels}, actual ${gradientPixelsActual}, union before dilation ${[...union].filter((v) => v === 1).length}`,
  );
  check(
    "compared-fraction",
    comparedPixels / (width * height) >= options.minComparedFraction,
    `${comparedPixels} of ${width * height} pixels (${((comparedPixels / (width * height)) * 100).toFixed(2)} %) are compared after excluding the anti-aliased band`,
  );
  check(
    "colour-max-channel-delta",
    maxDelta <= options.perChannelMaxDelta,
    `largest per-channel difference on a compared pixel: ${maxDelta} LSB (bound ${options.perChannelMaxDelta})` +
      (worst === null ? "" : ` at (${worst.x}, ${worst.y})`),
    { maxDelta, worst },
  );
  check(
    "colour-differing-fraction",
    differingFraction <= options.maxDifferingFraction,
    `${differingPixels} of ${comparedPixels} compared pixels differ (${(differingFraction * 100).toFixed(3)} %; bound ${(options.maxDifferingFraction * 100).toFixed(1)} %)`,
  );
  check(
    "silhouette-coverage",
    coverageDelta <= options.coverageDeltaMax,
    `foreground coverage: reference ${(statisticsReference.foregroundFraction * 100).toFixed(3)} % vs actual ${(statisticsActual.foregroundFraction * 100).toFixed(3)} % ` +
      `(delta ${(coverageDelta * 100).toFixed(3)} pp; bound ${(options.coverageDeltaMax * 100).toFixed(1)} pp)`,
  );
  check(
    "silhouette-row-profile",
    maxRowDelta <= options.rowCountDeltaMax,
    `largest per-row foreground-count difference: ${maxRowDelta} px (bound ${options.rowCountDeltaMax}); rows beyond the bound: ${rowsBeyondBudget}` +
      (worstRow === null ? "" : `; worst row ${worstRow.y}: reference ${worstRow.reference} vs actual ${worstRow.actual}`),
  );
  check(
    "frame-not-blank",
    statisticsActual.foregroundFraction >= options.minForegroundFraction && statisticsActual.uniqueColours >= options.minUniqueColours,
    `actual frame: foreground ${(statisticsActual.foregroundFraction * 100).toFixed(3)} % (min ${(options.minForegroundFraction * 100).toFixed(0)} %), ` +
      `${statisticsActual.uniqueColours} distinct colours (min ${options.minUniqueColours}), dominant colour rgb(${statisticsActual.dominantColour.join(", ")}) at ${(statisticsActual.dominantFraction * 100).toFixed(2)} %`,
  );
  check(
    "reference-frame-not-blank",
    statisticsReference.foregroundFraction >= options.minForegroundFraction && statisticsReference.uniqueColours >= options.minUniqueColours,
    `reference frame: foreground ${(statisticsReference.foregroundFraction * 100).toFixed(3)} %, ${statisticsReference.uniqueColours} distinct colours`,
  );
  // The baseline口径 as an executable fact: the surface still renders as the unmodulated base colour.
  // Blue-dominant, near-zero red/green — a shading-modulated frame would spread over many colours and
  // lift the dominant fraction; the assertion is a *lower* bound on that flatness, i.e. it can only fail
  // if the frame stops looking like the deferred-elevation baseline.
  const dominant = statisticsActual.dominantColour;
  check(
    "baseline-state-flat-surface",
    dominant[0] <= 16 && dominant[1] <= 16 && dominant[2] >= 96 && statisticsActual.dominantFraction >= 0.2,
    `dominant colour rgb(${dominant.join(", ")}) covers ${(statisticsActual.dominantFraction * 100).toFixed(2)} % of the frame — the deferred-elevation baseline ` +
      "(base colour blue 0.5 = 8-bit 127, unmodulated); this is NOT evidence that relief/elevation shading works",
  );

  return {
    checks,
    metrics: {
      size: { width, height },
      mask: {
        gradientThreshold,
        dilationRadius,
        computedOn: "union(reference, actual)",
        gradientPixelsReference: gradientPixels,
        gradientPixelsActual,
        unionPixels: [...union].filter((value) => value === 1).length,
        excludedPixels,
        excludedFraction,
        comparedPixels,
        comparedFraction: comparedPixels / (width * height),
      },
      colour: {
        perChannelMaxDelta: options.perChannelMaxDelta,
        maxDelta,
        worst,
        differingPixels,
        differingFraction,
        histogram: Object.fromEntries([...histogram.entries()].sort((a, b) => a[0] - b[0])),
        worstSamples,
      },
      silhouette: {
        coverageDelta,
        coverageReference: statisticsReference.foregroundFraction,
        coverageActual: statisticsActual.foregroundFraction,
        maxRowDelta,
        rowsBeyondBudget,
        worstRow,
      },
      frames: { reference: statisticsReference, actual: statisticsActual },
    },
  };
}

/** The difference image: black = compared and equal, amplified colour = compared and different, grey = excluded. */
function encodeDiffImage(reference, actual, excluded) {
  const out = new Uint8Array(reference.width * reference.height * 4);
  for (let index = 0; index < reference.width * reference.height; index += 1) {
    const offset = index * 4;
    if (excluded[index] === 1) {
      out[offset] = 48;
      out[offset + 1] = 48;
      out[offset + 2] = 64;
      out[offset + 3] = 255;
      continue;
    }
    const dr = Math.abs(reference.rgba[offset] - actual.rgba[offset]);
    const dg = Math.abs(reference.rgba[offset + 1] - actual.rgba[offset + 1]);
    const db = Math.abs(reference.rgba[offset + 2] - actual.rgba[offset + 2]);
    out[offset] = Math.min(255, dr * 16);
    out[offset + 1] = Math.min(255, dg * 16);
    out[offset + 2] = Math.min(255, db * 16);
    out[offset + 3] = 255;
  }
  return encodePng(out, reference.width, reference.height);
}

// ---------------------------------------------------------------------------------------------
// fixed-condition bookkeeping
// ---------------------------------------------------------------------------------------------

/** Stable stringify (sorted keys) so a condition hash cannot drift because of key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const hashOf = (value) => crypto.createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);

/**
 * The fixed conditions of the case, taken from the **run** (not from the constants): a page that quietly
 * used another camera, another canvas size or another sample count would change this object, and the
 * comparison would refuse to compare incomparable frames.
 */
function fixedConditions(result, backend) {
  return {
    caseId: CASE.caseId,
    datasetId: result.datasetId,
    backend,
    cameraEcho: result.probe.cameraEcho,
    cameraDeclared: CASE.camera,
    dateIso: result.dateIso,
    viewport: result.viewport,
    settle: result.settle,
    context: result.context,
    sceneConfiguration: result.sceneConfiguration,
    // The screenshot is a page screenshot clipped to the canvas, so the credit overlay inside the
    // container is part of the compared frame — and its text is therefore part of the case's identity.
    pageOverlayText: result.probe?.pageOverlayText ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------------------------

test("visual:terrain — the multi-tile frame matches its own backend's reference frame", async () => {
  const run = await runContractSuite("visual:terrain", { captureCanvas: true });
  const backend = run.backend;
  assertCleanRun(run, assert);
  assertOtherBackendUntouched(run, assert);

  const result = run.report.result["terrain-multitile"];
  assert.ok(result !== undefined, "the page MUST publish the terrain-multitile report");

  // ---- the run's own invariants ---------------------------------------------------------------
  assert.deepEqual(result.frameErrors, [], `the page reported frame error(s): ${JSON.stringify(result.frameErrors)}`);
  assert.deepEqual(result.renderErrors, [], `the page reported render error(s): ${JSON.stringify(result.renderErrors)}`);
  assert.equal(result.settle.tilesLoadedAfterSettle, true, "the frame MUST be captured with the globe settled (tilesLoaded after the settle frames)");
  assert.equal(result.viewport.devicePixelRatio, CASE.viewport.pixelRatio, "the case fixes the device pixel ratio at 1 (the screen capture is a 1x copy of the canvas)");
  assert.equal(result.viewport.width, CASE.viewport.width, "the canvas backing width MUST be the case's fixed viewport");
  assert.equal(result.viewport.height, CASE.viewport.height, "the canvas backing height MUST be the case's fixed viewport");
  assert.equal(result.dateIso, CASE.dateIso, "the rendered instant MUST be the case's fixed instant");

  // the camera the page really used (echoed through the public Cartesian3 → Cartographic path)
  const echo = result.probe.cameraEcho;
  /** Heading/pitch are angles: upstream reports heading in [0, 360), so 0 comes back as 360. */
  const angleDelta = (left, right) => {
    const delta = Math.abs(left - right) % 360;
    return Math.min(delta, 360 - delta);
  };
  for (const [name, key] of [["longitude", "longitude"], ["latitude", "latitude"]]) {
    assert.ok(
      angleDelta(echo[key], CASE.camera[name]) < 1e-6,
      `${name}: the page used ${echo[key]}, the case fixes ${CASE.camera[name]}`,
    );
  }
  assert.ok(Math.abs(echo.height - CASE.camera.height) < 1e-3, `height: the page used ${echo.height} m, the case fixes ${CASE.camera.height} m`);
  assert.ok(angleDelta(echo.headingDegrees, CASE.camera.heading) < 1e-6, `heading: the page used ${echo.headingDegrees}°, the case fixes ${CASE.camera.heading}°`);
  assert.ok(angleDelta(echo.pitchDegrees, CASE.camera.pitch) < 1e-6, `pitch: the page used ${echo.pitchDegrees}°, the case fixes ${CASE.camera.pitch}°`);

  // ---- multi-tile evidence (T092(e)) ----------------------------------------------------------
  // "Participating" = selected by the globe **and** geometry-ready (`GlobeSurfaceTile.TerrainState`
  // READY === 6, upstream `Source/Scene/TerrainState.js`). The raw selection can also name refinement
  // levels the dataset does not contain (that is how the level-13 thrash shows up), so the claim is made
  // about the tiles that really took part — and the raw selection is reported next to it.
  const tiles = result.tiles;
  assert.ok(
    tiles.participatingCount >= 2,
    `at least two tiles MUST take part in the frame (got ${tiles.participatingCount} ready of ${tiles.renderedCount} selected: ${JSON.stringify(tiles.participatingKeys)}; ` +
      `terrain states ${JSON.stringify(tiles.terrainStateDistribution)})`,
  );
  assert.equal(
    tiles.allParticipatingHaveData,
    true,
    `every participating tile MUST carry terrain data (real or upsampled from an available ancestor): ${JSON.stringify(tiles.participatingTiles)}`,
  );
  // At least two of them MUST be **committed dataset tiles fetched over HTTP** — the rest may be the
  // upsampled edge of the dataset, which is reported rather than asserted away.
  assert.ok(
    tiles.realTileCount >= 2,
    `at least two participating tiles MUST be committed dataset tiles requested from the product provider ` +
      `(got ${tiles.realTileCount} real of ${tiles.participatingCount}: ${JSON.stringify(tiles.realTileKeys)}; upsampled: ${JSON.stringify(tiles.upsampledTileKeys)})`,
  );
  for (const tile of tiles.participatingTiles) {
    assert.ok(tile.rectangle !== null, `tile ${tile.key} MUST report its geographic rectangle`);
    // Independent re-derivation of the geographic tiling scheme's grid (probe.js's
    // `heightmapTileRectangle`: 2·2^level columns of 360/(2·2^level)°, 2^level rows of 180/2^level°):
    // the reported level/x/y MUST be the rectangle it claims to be. Tile coordinates are the evidence
    // here, so they are checked rather than taken on trust.
    const spanX = 360 / (2 * 2 ** tile.level);
    const spanY = 180 / 2 ** tile.level;
    const expected = { west: -180 + tile.x * spanX, south: 90 - (tile.y + 1) * spanY, east: -180 + (tile.x + 1) * spanX, north: 90 - tile.y * spanY };
    for (const side of ["west", "south", "east", "north"]) {
      assert.ok(
        Math.abs(tile.rectangle[side] - expected[side]) < 1e-5,
        `tile ${tile.key}: ${side} = ${tile.rectangle[side]} does not match the geographic grid's ${expected[side]}`,
      );
    }
  }
  // The dominant level's tiles MUST form a connected patch (a mosaic, not unrelated LOD fragments).
  const byLevel = new Map();
  for (const tile of tiles.participatingTiles) {
    if (!byLevel.has(tile.level)) byLevel.set(tile.level, []);
    byLevel.get(tile.level).push(tile);
  }
  const dominantLevel = [...byLevel.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  assert.ok(dominantLevel !== undefined && dominantLevel[1].length >= 2, `some level MUST contribute at least two tiles (levels participating: ${JSON.stringify(tiles.participatingByLevel)})`);
  const [level, patch] = dominantLevel;
  const keys = new Set(patch.map((tile) => `${tile.x}/${tile.y}`));
  const seen = new Set();
  const queue = [`${patch[0].x}/${patch[0].y}`];
  while (queue.length > 0) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const [x, y] = key.split("/").map(Number);
    for (const neighbour of [`${x - 1}/${y}`, `${x + 1}/${y}`, `${x}/${y - 1}`, `${x}/${y + 1}`]) {
      if (keys.has(neighbour) && !seen.has(neighbour)) queue.push(neighbour);
    }
  }
  assert.equal(
    seen.size,
    keys.size,
    `the ${patch.length} tiles of level ${level} MUST be 4-connected (one patch, not scattered fragments): ${JSON.stringify(patch.map((tile) => tile.key))}`,
  );
  assert.equal(
    tiles.tileDiagnosticCount,
    0,
    `no tile of this case MAY be degraded as data-unavailable: ${JSON.stringify(tiles.tileDiagnostics)}`,
  );
  // Reported, not asserted: whether the patch fills its own bounding box (a perfectly stitched rectangle
  // is what this baseline measured; a non-rectangular but connected patch is still a valid mosaic).
  const xs = patch.map((tile) => tile.x);
  const ys = patch.map((tile) => tile.y);
  const boundingBoxTiles = (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1);
  const patchFillsBoundingBox = boundingBoxTiles === patch.length;

  // ---- the captured frame ---------------------------------------------------------------------
  const shot = run.canvasScreenshot;
  assert.ok(shot !== undefined && shot.captured === true, `the harness MUST capture the canvas region (${shot?.reason ?? "no capture"})`);
  assert.equal(shot.width, CASE.viewport.width, "the captured frame MUST be the canvas region at 1x");
  assert.equal(shot.height, CASE.viewport.height, "the captured frame MUST be the canvas region at 1x");
  const actual = readFrame(path.join(REPO_ROOT, shot.path));
  assert.equal(actual.width, shot.width, "the decoded frame MUST have the captured size");
  assert.equal(actual.height, shot.height, "the decoded frame MUST have the captured size");

  const actualStatistics = frameStatistics(actual);
  // The suite's own foreground rule MUST agree with the harness's `nonBackground` (same predicate, two
  // implementations) — otherwise one of the two is measuring something else.
  assert.equal(
    actualStatistics.foregroundPixels,
    shot.nonBackground,
    `the suite's foreground count (${actualStatistics.foregroundPixels}) MUST equal the harness's nonBackground (${shot.nonBackground}): both use the same rule`,
  );
  assert.ok(
    actualStatistics.foregroundFraction >= FRAME_CONTENT.minForegroundFraction,
    `the frame MUST NOT be blank or background-only: foreground ${(actualStatistics.foregroundFraction * 100).toFixed(3)} % (min ${(FRAME_CONTENT.minForegroundFraction * 100).toFixed(0)} %)`,
  );
  assert.ok(
    actualStatistics.uniqueColours >= FRAME_CONTENT.minUniqueColours,
    `the frame MUST NOT be a single flat colour: ${actualStatistics.uniqueColours} distinct colours (min ${FRAME_CONTENT.minUniqueColours})`,
  );

  const conditions = fixedConditions(result, backend);
  const conditionsHash = hashOf(conditions);
  const frameFile = referenceFramePath(backend);
  const recordFile = toleranceRecordPath(backend);

  const toleranceOf = (entry) => entry.tolerance;

  // ---- stage 1: baseline generation -----------------------------------------------------------
  if (BASELINE_MODE !== null) {
    const exists = fs.existsSync(frameFile);
    if (exists && BASELINE_MODE !== "regenerate") {
      throw new Error(
        `a reference frame already exists at ${path.relative(REPO_ROOT, frameFile)}; refusing to overwrite it silently. ` +
          'Delete it deliberately (or run with VISUAL_TERRAIN_BASELINE="regenerate") if the case really changed.',
      );
    }
    fs.mkdirSync(REFERENCE_DIR, { recursive: true });
    // The reference IS the run's own screenshot bytes — never a re-encode, never a hand-made image.
    fs.copyFileSync(path.join(REPO_ROOT, shot.path), frameFile);
    const record = {
      tool: "tests/visual/terrain-multitile.spec.mjs",
      caseId: CASE.caseId,
      datasetId: CASE.datasetId,
      backend,
      referenceFrame: path.relative(REPO_ROOT, frameFile).split(path.sep).join("/"),
      generatedAt: new Date().toISOString(),
      generatedBy: `node tests/support/backend-runner.mjs --backend=${backend} --suite=visual:terrain (VISUAL_TERRAIN_BASELINE=${BASELINE_MODE})`,
      overwrotePrevious: exists,
      runId: run.runId,
      sourceScreenshot: shot.path,
      fixedConditions: { ...conditions, hash: conditionsHash },
      tolerance: TOLERANCE.map((entry) => ({ id: entry.id, what: entry.what, basis: entry.basis, tolerance: toleranceOf(entry) })),
      frameContentBounds: FRAME_CONTENT,
      measurements: {
        actualFrame: actualStatistics,
        crossRun: null,
        note: "the generation run compares nothing (two-stage protocol); each comparison run records its measured deltas in artifacts/terrain/multitile-<backend>-compare.json (metrics.colour / metrics.silhouette / metrics.mask)",
      },
      baselineState: {
        elevationShading: "explicitly deferred (起伏显式后置): upstream fade = clamp((far - near)/(...), 0, 1) = 0 at this camera, so finalColor = color * lightColor and the terrain renders as the unmodulated base colour",
        sourceOfBaselineReading: "tasks.md T092 baseline note + T094 note (plan 的起伏决策与实测)",
        mayBeReadAs: "MUST NOT be read as 'relief/elevation shading verified'",
        measuredConsistency: `dominant colour rgb(${actualStatistics.dominantColour.join(", ")}) covers ${(actualStatistics.dominantFraction * 100).toFixed(2)} % of the frame — consistent with the deferred-elevation state (base colour blue 0.5 = 8-bit 127)`,
        regenerationPolicy: {
          triggers: [
            "introducing the relief/elevation-shading increment (fade != 0 or any lighting modulation of the base colour)",
            "any change of dataset, camera, instant, viewport, pixel ratio, sample count or scene configuration",
            "any change of the tolerance table below (the comparison refuses to run against a stale record)",
          ],
          requiredAction:
            "regenerate BOTH backends' reference frames (VISUAL_TERRAIN_BASELINE=regenerate) and write '因起伏增量而重生成' (regenerated because of the relief increment) into this record's regenerationReason",
          regenerationReason: null,
        },
      },
    };
    fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    process.stdout.write(
      `visual:terrain baseline [${backend}]: wrote ${path.relative(REPO_ROOT, frameFile)} ` +
        `(foreground ${(actualStatistics.foregroundFraction * 100).toFixed(2)} %, ${actualStatistics.uniqueColours} colours, ${tiles.renderedCount} tiles) ` +
        `and ${path.relative(REPO_ROOT, recordFile)}; re-run without VISUAL_TERRAIN_BASELINE to compare.\n`,
    );
    return;
  }

  // ---- stage 2: comparison --------------------------------------------------------------------
  if (!fs.existsSync(frameFile) || !fs.existsSync(recordFile)) {
    throw new Error(
      `missing reference frame or ToleranceRecord (${path.relative(REPO_ROOT, frameFile)}, ${path.relative(REPO_ROOT, recordFile)}). ` +
        'The baseline is a deliberate act: run once with VISUAL_TERRAIN_BASELINE="1" and commit the result.',
    );
  }
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  assert.equal(record.fixedConditions.hash, conditionsHash, `the case's fixed conditions changed since the reference frame was generated (record ${record.fixedConditions.hash} vs run ${conditionsHash}) — the frames are not comparable; regenerate them`);
  assert.deepEqual(
    record.fixedConditions,
    { ...conditions, hash: conditionsHash },
    "the recorded fixed conditions MUST be field-for-field the conditions of this run",
  );
  assert.deepEqual(
    record.tolerance,
    TOLERANCE.map((entry) => ({ id: entry.id, what: entry.what, basis: entry.basis, tolerance: toleranceOf(entry) })),
    "the tolerance table in the reference record MUST be the table in this code — if it changed, regenerate the baseline deliberately instead of comparing against a stale record",
  );

  const reference = readFrame(frameFile);

  // ---- the counter-example self-check ---------------------------------------------------------
  // The comparison path below is the production path; the negative control only changes its *input*
  // (the actual frame) and forces the colour tolerance to 0, so a failure here proves the comparison can
  // fail at all. `pixel`: one interior compared pixel, +1 LSB on one channel. `shift`: the whole frame
  // moved 4 px sideways, which the silhouette row-profile budget (4 px/row) cannot absorb everywhere.
  let judgedActual = actual;
  let toleranceOverride = null;
  let control = null;
  if (NEGATIVE_CONTROL !== null) {
    const arm = NEGATIVE_CONTROL === "1" ? "pixel" : NEGATIVE_CONTROL;
    const copy = { width: actual.width, height: actual.height, rgba: Uint8Array.from(actual.rgba) };
    if (arm === "pixel") {
      // Pick a pixel the *reference* judges as interior (no gradient in its 3x3 neighbourhood, and not
      // inside the dilated band): the perturbation is therefore inside the compared region by
      // construction, and it is reported with its coordinates.
      const mask = dilate(
        gradientMask(reference, TOLERANCE.find((entry) => entry.id === "anti-aliased-edge").tolerance.gradientThreshold),
        reference.width,
        reference.height,
        TOLERANCE.find((entry) => entry.id === "anti-aliased-edge").tolerance.dilationRadius,
      );
      let chosen = null;
      for (let y = 2; y < reference.height - 2 && chosen === null; y += 1) {
        for (let x = 2; x < reference.width - 2 && chosen === null; x += 1) {
          if (mask[y * reference.width + x] === 1) continue;
          if (!isForeground(reference, x, y)) continue;
          chosen = { x, y };
        }
      }
      assert.ok(chosen !== null, "the negative control MUST find an interior compared pixel to perturb");
      const offset = (chosen.y * copy.width + chosen.x) * 4;
      copy.rgba[offset] = Math.min(255, copy.rgba[offset] + 1);
      judgedActual = copy;
      toleranceOverride = { perChannelMaxDelta: 0 };
      control = { arm, pixel: chosen, channel: "r", deltaLsb: 1, forcedTolerance: 0 };
    } else if (arm === "shift") {
      const shift = SHIFT_PIXELS;
      for (let y = 0; y < copy.height; y += 1) {
        for (let x = 0; x < copy.width; x += 1) {
          const from = (y * copy.width + Math.min(copy.width - 1, x + shift)) * 4;
          const to = (y * copy.width + x) * 4;
          copy.rgba[to] = actual.rgba[from];
          copy.rgba[to + 1] = actual.rgba[from + 1];
          copy.rgba[to + 2] = actual.rgba[from + 2];
          copy.rgba[to + 3] = actual.rgba[from + 3];
        }
      }
      judgedActual = copy;
      control = { arm, shiftPixels: shift };
    } else {
      throw new Error(`unknown VISUAL_TERRAIN_NEGATIVE_CONTROL arm "${arm}"; use "pixel" or "shift"`);
    }
  }

  const options = {
    gradientThreshold: TOLERANCE.find((entry) => entry.id === "anti-aliased-edge").tolerance.gradientThreshold,
    dilationRadius: TOLERANCE.find((entry) => entry.id === "anti-aliased-edge").tolerance.dilationRadius,
    perChannelMaxDelta: toleranceOverride?.perChannelMaxDelta ?? TOLERANCE.find((entry) => entry.id === "unorm8-quantisation").tolerance.perChannelMaxDelta,
    maxDifferingFraction: TOLERANCE.find((entry) => entry.id === "differing-pixel-budget").tolerance.maxDifferingFraction,
    coverageDeltaMax: TOLERANCE.find((entry) => entry.id === "silhouette-geometry").tolerance.coverageDeltaMax,
    rowCountDeltaMax: TOLERANCE.find((entry) => entry.id === "silhouette-geometry").tolerance.rowCountDeltaMax,
    maxExcludedFraction: FRAME_CONTENT.maxExcludedFraction,
    minComparedFraction: FRAME_CONTENT.minComparedFraction,
    minForegroundFraction: FRAME_CONTENT.minForegroundFraction,
    minUniqueColours: FRAME_CONTENT.minUniqueColours,
  };

  const { checks, metrics } = compareFrames(reference, judgedActual, options);
  const failed = checks.filter((entry) => entry.ok !== true);
  const verdict = failed.length === 0 ? "pass" : "fail";
  const stats = {
    tool: "tests/visual/terrain-multitile.spec.mjs",
    suite: "visual:terrain",
    caseId: CASE.caseId,
    datasetId: CASE.datasetId,
    backend,
    stage: control === null ? "compare" : "negative-control",
    verdict,
    comparedAt: new Date().toISOString(),
    runId: run.runId,
    isolation: "one backend per run; the reference frame of THIS backend only (principle II)",
    reference: { file: path.relative(REPO_ROOT, frameFile).split(path.sep).join("/"), sha256: crypto.createHash("sha256").update(fs.readFileSync(frameFile)).digest("hex"), generatedAt: record.generatedAt },
    actual: { file: shot.path, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(REPO_ROOT, shot.path))).digest("hex"), capturedAt: run.finishedAt },
    fixedConditionsHash: conditionsHash,
    tileEvidence: {
      participatingCount: tiles.participatingCount,
      participatingKeys: tiles.participatingKeys,
      participatingTiles: tiles.participatingTiles,
      participatingByLevel: tiles.participatingByLevel,
      realTileCount: tiles.realTileCount,
      realTileKeys: tiles.realTileKeys,
      upsampledTileKeys: tiles.upsampledTileKeys,
      dominantLevel: level,
      dominantLevelFillsBoundingBox: patchFillsBoundingBox,
      selectedCount: tiles.renderedCount,
      selectedKeys: tiles.renderedKeys,
      terrainStateDistribution: tiles.terrainStateDistribution,
      requestedDistinct: tiles.requestedDistinct,
      requestedTilesByLevel: tiles.requestedTilesByLevel,
    },
    tolerance: TOLERANCE.map((entry) => ({ id: entry.id, tolerance: toleranceOf(entry) })),
    negativeControl: control,
    checks,
    metrics,
  };
  fs.mkdirSync(artifactDir, { recursive: true });
  if (verdict === "fail") {
    const excluded = dilate(
      (() => {
        const union = new Uint8Array(reference.width * reference.height);
        const left = gradientMask(reference, options.gradientThreshold);
        const right = gradientMask(judgedActual, options.gradientThreshold);
        for (let index = 0; index < union.length; index += 1) union[index] = left[index] === 1 || right[index] === 1 ? 1 : 0;
        return union;
      })(),
      reference.width,
      reference.height,
      options.dilationRadius,
    );
    fs.writeFileSync(diffPath(backend), encodeDiffImage(reference, judgedActual, excluded));
    stats.diffImage = path.relative(REPO_ROOT, diffPath(backend)).split(path.sep).join("/");
  }
  fs.writeFileSync(statsPath(backend), `${JSON.stringify(stats, null, 2)}\n`, "utf8");

  const summary =
    `visual:terrain [${backend}${control === null ? "" : ` negative-control=${control.arm}`}]: ${verdict} ` +
    `(${checks.length - failed.length}/${checks.length} checks); compared ${metrics.mask?.comparedPixels ?? 0} px, excluded ${((metrics.mask?.excludedFraction ?? 0) * 100).toFixed(2)} %, ` +
    `maxChannelDelta ${metrics.colour?.maxDelta ?? "n/a"}, differing ${metrics.colour?.differingPixels ?? "n/a"}, ` +
    `silhouette coverage delta ${((metrics.silhouette?.coverageDelta ?? 0) * 100).toFixed(3)} pp / max row delta ${metrics.silhouette?.maxRowDelta ?? "n/a"} px; ` +
    `tiles ${tiles.renderedCount} (${tiles.renderedKeys.join(" ")}); stats -> ${path.relative(REPO_ROOT, statsPath(backend))}` +
    (verdict === "fail" ? `; diff -> ${path.relative(REPO_ROOT, diffPath(backend))}` : "");
  process.stdout.write(`${summary}\n`);

  assert.deepEqual(
    failed.map((entry) => entry.id),
    [],
    `visual comparison failed (${verdict}):\n${failed.map((entry) => `  - ${entry.id}: ${entry.detail}`).join("\n")}\n` +
      `reference: ${path.relative(REPO_ROOT, frameFile)}\nactual:    ${shot.path}\ndiff:      ${path.relative(REPO_ROOT, diffPath(backend))}\nstats:     ${path.relative(REPO_ROOT, statsPath(backend))}`,
  );
});
