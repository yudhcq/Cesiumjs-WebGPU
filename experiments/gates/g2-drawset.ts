/**
 * G-2 / T004 —— 可见瓦片集合规则：**TypeScript 契约**（tasks.md 中登记的产物路径 `experiments/gates/g2-drawset.ts`）
 *
 * 本文件是**类型门面**：只声明与 `specs/001-webgpu-terrain-mvp/data-model.md` §1 对齐的类型，
 * 并把运行时实现（同目录 `g2-drawset.mjs`）再导出，**不含第二份逻辑**，因此不会与实现分叉。
 *
 * 为什么运行时放在 `.mjs`：
 * - 门禁自检必须"零构建步骤"直接跑：`.mjs` 在任意 Node >= 18 上可直接执行与 `import`；
 * - 本机 Node v22.20.0 **确实**能直接运行 `.ts`（22.18+ 内建类型擦除，已实测本文件可被 import），
 *   但该能力是实验性的、且要求"仅可擦除语法"，把它当作 CI/他人机器的前提不划算；
 * - 因此：**实现 = `g2-drawset.mjs`**，本文件 = 类型契约（T023 生产版 `core/tile-registry.ts` 照此逐字段移植）。
 *
 * 若将来用 `tsc --noEmit` 扫描 `experiments/**`，需要 `allowJs: true`（或按 T023 说明在门禁结论落档后删除本原型）；
 * `experiments/**` 不参与主包 Rollup 构建（tasks.md「Path Conventions」）。
 *
 * 纯函数、零第三方依赖、不 import 上游任何模块（constitution 原则 I：不得依赖上游私有成员）。
 */

/** 地形瓦片键（data-model.md §1 `TileKey`）。 */
export interface TileKey {
  readonly level: number; // >= 0
  readonly x: number; // 0 <= x < 2^level * 宽度
  readonly y: number; // 0 <= y < 2^level * 高度
}

/** 三维向量（ECEF 或任意右手直角坐标）。 */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 视锥平面：`dot(normal, p) + distance >= 0` 为内侧；normal 非零，构造时归一化。 */
export interface Plane {
  readonly normal: Vec3;
  readonly distance: number;
}

/** 包围球。 */
export interface BoundingSphere {
  readonly center: Vec3;
  readonly radius: number;
}

/** 视锥 = 内侧平面集合 + 纯函数式「瓦片键 → 包围球」解析器。 */
export interface Frustum {
  readonly planes: readonly Plane[];
  readonly boundsOf: (key: TileKey) => BoundingSphere;
}

/** 逐帧绘制集合（data-model.md §1 `FrameDrawSet`；两个字段为**诊断计数**）。 */
export interface FrameDrawSet {
  readonly frameNumber: number;
  readonly tiles: readonly TileKey[];
  readonly supersededByChildren: number;
  readonly culledOutOfFrustum: number;
}

/** T004 返回值：三个互斥、按 `compareTileKey` 升序的键数组 + data-model §1 形状的 `frameDrawSet`。 */
export interface DrawSetResult {
  readonly tiles: readonly TileKey[];
  readonly supersededByChildren: readonly TileKey[];
  readonly culledOutOfFrustum: readonly TileKey[];
  readonly frameDrawSet: FrameDrawSet;
}

/** T004 规定的纯函数签名。 */
export type ComputeDrawSet = (
  resident: readonly TileKey[],
  frustum: Frustum,
  childrenOf: ReadonlyMap<TileKey | string, readonly TileKey[]>,
  frameNumber?: number,
) => DrawSetResult;

export {
  tileKeyToString,
  compareTileKey,
  childrenOfKey,
  normalizePlane,
  createFrustum,
  planesOfBox,
  sphereIntersectsPlanes,
  isTileVisible,
  createBoundsLookup,
  computeDrawSet,
} from "./g2-drawset.mjs";
