/**
 * T089 — `stats()` 的纯计算部分（`packages/cesium-webgpu/src/compose/frame-statistics.ts`）。
 *
 * 这里只有算术：帧时间分位数、像素统计、draw/三角形计数、以及"未测量"的表示。它**不 import 任何东西**
 * （包括 `@cesium/engine`），因此 `tests/unit/scene-config.test.mjs` 可以在 Node 里直接执行这些函数，
 * 用真实输入断言数值 —— 而不是只对源码做模式匹配。
 *
 * 契约来源：`contracts/render-path-api.md` §1 的 `FrameStatistics`（字段集合 MUST 与 `src/api/types.ts`
 * 的同名接口一致；`scene-runtime.ts` 把这里的快照赋给公开类型，字段不齐会在 `npm run typecheck` 处报错）。
 */

/**
 * 未测量值的唯一表示：`NaN`。
 *
 * 为什么不是 `0`：`0` 是**一个可断言的结论**（"没有任何非背景像素"/"没有 depth 不连续"/"没有 draw call"），
 * 而"这条路径上测不到"不是结论。上游 `Context#readPixels` 在本增量是 slice C 显式失败桩，
 * 且 `depth24plus-stencil8` 的 depth aspect 无法 `copyTextureToBuffer`（W5 实测，Chrome 153），
 * 所以 depth 统计在默认 4x MSAA 配置下**必然**测不到。返回 `NaN` 会让任何区间/等价断言当场失败，
 * 而不是静默通过（FR-033：MUST NOT 静默降级）。
 */
export const UNMEASURED = Number.NaN;

/** `FrameStatistics` 的结构快照（刻意不 import 公开接口，理由见文件头注释）。 */
export interface FrameStatisticsSnapshot {
  nonBackgroundRatio: number;
  uniqueColorCount: number;
  depthDiscontinuityRatio: number;
  triangleCount: number;
  drawCallCount: number;
  tileCount: number;
  frameTimeMs: { p50: number; p95: number };
}

/** 一个 RGBA8 背景色（0–255）。 */
export interface RgbaBytes {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** 一帧几何量的计数（由 `Scene#debugCommandFilter` 在**两条路径**上以同一口径统计）。 */
export interface CommandTally {
  drawCalls: number;
  triangles: number;
}

/** 像素级统计结果。 */
export interface PixelSummary {
  nonBackgroundRatio: number;
  uniqueColorCount: number;
}

/**
 * 像素与背景的容差（四个通道绝对差之和，满量程 1020）。
 *
 * 8 而不是 0：捕获路径会把画布内容经一次平台图像拷贝（`drawImage` + `getImageData`）取回，
 * 这一步在两条路径上都可能带来 1–2 个码值的色彩空间/舍入差。容忍到 8 仍然远小于任何真实地形像素
 * 与背景（默认黑色，且 `skyBox/skyAtmosphere` 都是 false）之间的差。
 */
export const PIXEL_BACKGROUND_TOLERANCE = 8;

/**
 * depth 不连续判定阈值（归一化 depth 的 1%）。
 *
 * 固定值、两条路径共用，才有跨路径可比性；只有真的能读到 depth 附件时这个阈值才会被用到
 * （见 `UNMEASURED` 的说明）。
 */
export const DEPTH_DISCONTINUITY_THRESHOLD = 0.01;

/**
 * 最近秩（nearest-rank）分位数：升序样本里第 `ceil(fraction * n)` 个观测值。
 *
 * 为什么不做线性插值：帧时间的 p95 MUST 是**真实观测到的一帧**，这样任何"某帧超阈值"的结论
 * 都能直接指回一次具体测量，而不是一个两边都没有的拟合值。
 */
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return UNMEASURED;
  if (!(fraction > 0 && fraction <= 1)) {
    throw new Error(`percentile fraction MUST be in (0, 1] (got ${String(fraction)})`);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] as number;
}

/** 定长帧时间窗口：`stats()` 的 `frameTimeMs` 只取最近 `capacity` 帧，`resetStats()` 清空。 */
export interface FrameTimeWindow {
  push(milliseconds: number): void;
  reset(): void;
  count(): number;
  summary(): { p50: number; p95: number };
}

/**
 * 建一个帧时间窗口。
 *
 * 有界是刻意的：帧时间是无界增长序列，长会话里若不设上限，`stats()` 的分位数会被会话最初的那几帧
 * 永久拖住，反映不出"现在"的帧时间。
 */
export function createFrameTimeWindow(capacity = 120): FrameTimeWindow {
  if (!(capacity > 0)) throw new Error(`frame-time window capacity MUST be positive (got ${String(capacity)})`);
  const samples: number[] = [];
  return {
    push(milliseconds: number) {
      if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) {
        throw new Error(`frame time MUST be a finite number of milliseconds (got ${String(milliseconds)})`);
      }
      samples.push(milliseconds);
      if (samples.length > capacity) samples.splice(0, samples.length - capacity);
    },
    reset() {
      samples.length = 0;
    },
    count() {
      return samples.length;
    },
    summary() {
      return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
    },
  };
}

/**
 * 一帧 RGBA8 像素的统计。
 *
 * `nonBackgroundRatio` 的分母是**全部像素**（`width * height`），分子是"与背景色差异超过容差"的像素数；
 * 背景色由调用方给出（`scene.backgroundColor`，默认黑），因此"背景"是场景配置里的一个确定值，
 * 而不是从画面里猜出来的众数 —— 否则一块占满画面的地形会把"背景"猜成地形色，覆盖率恒等于 0。
 *
 * `uniqueColorCount` 数的是去重后的 RGBA 值个数（`uniqueColorCount === 1` 即整片单色，是"空帧/纯色帧"
 * 的直接判据）。
 */
export function summarisePixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  background: RgbaBytes,
  tolerance: number = PIXEL_BACKGROUND_TOLERANCE,
): PixelSummary {
  const expected = width * height * 4;
  if (pixels.length !== expected) {
    throw new Error(`frame buffer is ${pixels.length} bytes; expected ${expected} for ${width}x${height} RGBA8`);
  }
  const colours = new Set<number>();
  let nonBackground = 0;
  for (let index = 0; index < expected; index += 4) {
    const r = pixels[index] as number;
    const g = pixels[index + 1] as number;
    const b = pixels[index + 2] as number;
    const a = pixels[index + 3] as number;
    colours.add(((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
    const difference =
      Math.abs(r - background.r) + Math.abs(g - background.g) + Math.abs(b - background.b) + Math.abs(a - background.a);
    if (difference > tolerance) nonBackground += 1;
  }
  const total = width * height;
  return { nonBackgroundRatio: total === 0 ? UNMEASURED : nonBackground / total, uniqueColorCount: colours.size };
}

/**
 * depth 不连续比例的统计口径（**目前恒为未测量**）。
 *
 * 传入 depth 采样（归一化 0–1，行优先）时，统计"水平/垂直相邻采样之差超过阈值"的比例；**没有** depth
 * 时返回 `UNMEASURED`。默认 4x MSAA 下画布的 depth 附件是多采样纹理，无法拷贝，因此本增量在两条路径上
 * 都没有可用的 depth 读回 —— 这是被记录下来的盲区，不是 0。
 */
export function depthDiscontinuityRatio(
  depth: ArrayLike<number> | undefined,
  width: number,
  height: number,
  threshold: number = DEPTH_DISCONTINUITY_THRESHOLD,
): number {
  if (depth === undefined) return UNMEASURED;
  if (depth.length !== width * height) {
    throw new Error(`depth buffer has ${depth.length} samples; expected ${width * height} for ${width}x${height}`);
  }
  if (width < 2 && height < 2) return UNMEASURED;
  let pairs = 0;
  let discontinuous = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = depth[y * width + x] as number;
      if (x + 1 < width) {
        pairs += 1;
        if (Math.abs(value - (depth[y * width + x + 1] as number)) > threshold) discontinuous += 1;
      }
      if (y + 1 < height) {
        pairs += 1;
        if (Math.abs(value - (depth[(y + 1) * width + x] as number)) > threshold) discontinuous += 1;
      }
    }
  }
  return pairs === 0 ? UNMEASURED : discontinuous / pairs;
}

/** 组装一次 `stats()` 的输入。 */
export interface FrameStatisticsInput {
  readonly frameTimes: FrameTimeWindow;
  readonly commands: CommandTally;
  /** 自上次 `resetStats()` 以来，适配层成功读取并解码的瓦片数（terrain/source.ts 的读取包装器计数）。 */
  readonly tileCount: number;
  /** 最近一次捕获的像素与其背景色；尚未捕获过时为 `undefined` ⇒ 像素类统计为未测量。 */
  readonly pixels?: { readonly pixels: Uint8Array; readonly width: number; readonly height: number; readonly background: RgbaBytes } | undefined;
  /** 最近一次成功读回的 depth 采样；不可读时为 `undefined`。 */
  readonly depth?: { readonly samples: ArrayLike<number>; readonly width: number; readonly height: number } | undefined;
}

/**
 * 把已测量的各部分拼成 `FrameStatistics`。
 *
 * 只做"取值或未测量"的选择，不做任何补齐：每个字段要么来自一次真实测量，要么是 `UNMEASURED`。
 */
export function assembleFrameStatistics(input: FrameStatisticsInput): FrameStatisticsSnapshot {
  const pixelSummary =
    input.pixels === undefined
      ? undefined
      : summarisePixels(input.pixels.pixels, input.pixels.width, input.pixels.height, input.pixels.background);
  return {
    nonBackgroundRatio: pixelSummary?.nonBackgroundRatio ?? UNMEASURED,
    uniqueColorCount: pixelSummary?.uniqueColorCount ?? UNMEASURED,
    depthDiscontinuityRatio:
      input.depth === undefined
        ? UNMEASURED
        : depthDiscontinuityRatio(input.depth.samples, input.depth.width, input.depth.height),
    triangleCount: input.commands.triangles,
    drawCallCount: input.commands.drawCalls,
    tileCount: input.tileCount,
    frameTimeMs: input.frameTimes.summary(),
  };
}

/** 全未测量的统计快照：构造失败时 `stats()` 的返回值（MUST NOT 用 0 冒充"测量结果"）。 */
export function unmeasuredFrameStatistics(): FrameStatisticsSnapshot {
  return {
    nonBackgroundRatio: UNMEASURED,
    uniqueColorCount: UNMEASURED,
    depthDiscontinuityRatio: UNMEASURED,
    triangleCount: 0,
    drawCallCount: 0,
    tileCount: 0,
    frameTimeMs: { p50: UNMEASURED, p95: UNMEASURED },
  };
}
