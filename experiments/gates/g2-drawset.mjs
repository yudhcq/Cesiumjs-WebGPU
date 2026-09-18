/**
 * G-2 / T004 —— 可见瓦片集合规则（门禁实验版，**可独立执行**）
 *
 * 对应 tasks.md Phase 1 / G-2 中登记的 `experiments/gates/g2-drawset.ts`：本文件是它的**运行时实现**，
 * 以 ESM + JSDoc 类型书写 —— 零第三方依赖、零构建步骤，任何 Node >= 18 可直接执行
 * （同目录 `g2-drawset.ts` 提供 TypeScript 类型门面，只声明类型并再导出，不含第二份逻辑）。
 *
 * 规则来源：`specs/001-webgpu-terrain-mvp/data-model.md` §1「逐帧绘制集合」（→ FR-001, FR-008；待验证假设 H-2）
 *
 *   绘制集合 = resident ∩ 视锥 ∩ 截断规则
 *   截断规则：某瓦片的 4 个子瓦片全部 resident 时，父瓦片不绘制；否则绘制。
 *   视锥外剔除：包围球与视锥任一平面完全分离（球心到平面距离 < -radius）即剔除。
 *
 * 分类口径（三类互斥且合并后恰好等于去重后的 resident 集合）：
 *   1) 视锥外           → `culledOutOfFrustum`（**优先级最高**：与父级是否被替换无关）
 *   2) 视锥内但 4 子齐全 → `supersededByChildren`
 *   3) 其余（含视锥内的非叶节点）→ `tiles`
 *   注：子瓦片包围盒是父瓦片包围盒的子集，故"父可见 ⇒ 至少一个子可见"，上述优先级不会产生空洞。
 *
 * 与上游运行时完全无关：本文件不 import 任何模块、不访问任何全局状态、不依赖上游私有成员
 * （constitution 原则 I）；纯几何/集合运算，所有导出函数均为纯函数（不修改入参，无 IO，结果只由入参决定）。
 *
 * 复用约定：T023（生产版 `core/tile-registry.ts`）以本文件为规格，**不得语义分叉**；
 * 门禁结论落档后本原型可删除。
 */

/* ------------------------------------------------------------------------------------------------
 * 类型（与 data-model.md §1 对齐；用 JSDoc 表达，运行时零成本）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 地形瓦片键（data-model.md §1 `TileKey`）。
 * @typedef {{ readonly level: number, readonly x: number, readonly y: number }} TileKey
 */

/**
 * 三维向量（ECEF 或任意右手直角坐标）。
 * @typedef {{ readonly x: number, readonly y: number, readonly z: number }} Vec3
 */

/**
 * 视锥平面：满足 `dot(normal, p) + distance >= 0` 的点在半空间内侧。
 * 与上游 `Plane`（`normal` + `distance`）同一约定，normal 必须为非零向量（构造时会归一化）。
 * @typedef {{ readonly normal: Vec3, readonly distance: number }} Plane
 */

/**
 * 包围球。
 * @typedef {{ readonly center: Vec3, readonly radius: number }} BoundingSphere
 */

/**
 * 视锥：平面集合 + 瓦片键 → 包围球的**纯**解析函数（生产环境由 tilingScheme + 高程范围算出，
 * 本门禁实验中由测试向量直接提供）。
 * @typedef {{ readonly planes: readonly Plane[], readonly boundsOf: (key: TileKey) => BoundingSphere }} Frustum
 */

/**
 * 逐帧绘制集合（data-model.md §1 `FrameDrawSet`；此处两个字段是**诊断计数**）。
 * @typedef {{ readonly frameNumber: number, readonly tiles: readonly TileKey[],
 *             readonly supersededByChildren: number, readonly culledOutOfFrustum: number }} FrameDrawSet
 */

/**
 * T004 规定的返回值：三个瓦片键数组（互斥、各自按 `compareTileKey` 升序排列、无重复）
 * 外加 data-model §1 形状的 `frameDrawSet`。
 * @typedef {{ readonly tiles: readonly TileKey[],
 *             readonly supersededByChildren: readonly TileKey[],
 *             readonly culledOutOfFrustum: readonly TileKey[],
 *             readonly frameDrawSet: FrameDrawSet }} DrawSetResult
 */

/* ------------------------------------------------------------------------------------------------
 * 瓦片键工具
 * ---------------------------------------------------------------------------------------------- */

/**
 * 规范键字符串，形如 `"level/x/y"`。
 * 内部一律用规范字符串做集合/映射索引，因此 `childrenOf` 的键**不要求**与 `resident` 中的对象是同一引用
 * （瓦片键按值相等，而非按对象身份）。已是字符串的输入原样透传。
 * @param {TileKey | string} key
 * @returns {string}
 */
export function tileKeyToString(key) {
  if (typeof key === "string") {
    return key;
  }
  if (
    key === null ||
    typeof key !== "object" ||
    !Number.isInteger(key.level) ||
    !Number.isInteger(key.x) ||
    !Number.isInteger(key.y)
  ) {
    throw new TypeError(`非法瓦片键：${JSON.stringify(key)}（要求整数 level/x/y）`);
  }
  return `${key.level}/${key.x}/${key.y}`;
}

/**
 * 确定性排序：先 level，再 x，再 y（升序）。输出顺序稳定，便于两侧统计与快照对比。
 * @param {TileKey} a
 * @param {TileKey} b
 * @returns {number}
 */
export function compareTileKey(a, b) {
  return a.level - b.level || a.x - b.x || a.y - b.y;
}

/**
 * 某瓦片的 4 个子瓦片键。
 * 顺序按 `childTileMask` 位序：bit0 SW、bit1 SE、bit2 NW、bit3 NE（data-model.md §1 `HeightField.childTileMask`）。
 * 坐标约定：x 向东递增、y 向南递增（上游地理瓦片方案），故 SW=(2x, 2y+1)、SE=(2x+1, 2y+1)、
 * NW=(2x, 2y)、NE=(2x+1, 2y)。**该顺序仅为标注方便，不影响"4 子齐全"的判定**（判定与顺序无关）。
 * @param {TileKey} key
 * @returns {TileKey[]} 长度恒为 4，按位序排列
 */
export function childrenOfKey(key) {
  if (key === null || typeof key !== "object" || !Number.isInteger(key.level) || key.level < 0) {
    throw new TypeError(`非法瓦片键：${JSON.stringify(key)}（要求 level >= 0 的整数）`);
  }
  const level = key.level + 1;
  const x = key.x * 2;
  const y = key.y * 2;
  return [
    { level, x, y: y + 1 }, // bit0 SW
    { level, x: x + 1, y: y + 1 }, // bit1 SE
    { level, x, y }, // bit2 NW
    { level, x: x + 1, y }, // bit3 NE
  ];
}

/* ------------------------------------------------------------------------------------------------
 * 视锥
 * ---------------------------------------------------------------------------------------------- */

/**
 * 归一化平面（法线为单位向量），使 `distance` 具有长度量纲。
 * @param {Plane} plane
 * @returns {Plane}
 */
export function normalizePlane(plane) {
  const { x, y, z } = plane.normal;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length === 0) {
    throw new RangeError(`平面法线必须是非零有限向量：${JSON.stringify(plane.normal)}`);
  }
  return { normal: { x: x / length, y: y / length, z: z / length }, distance: plane.distance / length };
}

/**
 * 构造视锥（平面一律归一化）。
 * @param {readonly Plane[]} planes 内侧半空间平面（`dot(n, p) + d >= 0` 为内侧）
 * @param {(key: TileKey) => BoundingSphere} boundsOf 瓦片键 → 包围球，必须是纯函数
 * @returns {Frustum}
 */
export function createFrustum(planes, boundsOf) {
  if (!Array.isArray(planes) || planes.length === 0) {
    throw new TypeError("planes 必须是非空数组");
  }
  if (typeof boundsOf !== "function") {
    throw new TypeError("boundsOf 必须是函数");
  }
  return { planes: planes.map(normalizePlane), boundsOf };
}

/**
 * 轴对齐盒（`[min, max]`）→ 6 个内侧平面，便于构造测试视锥。
 * @param {Vec3} min
 * @param {Vec3} max
 * @returns {Plane[]}
 */
export function planesOfBox(min, max) {
  return [
    { normal: { x: 1, y: 0, z: 0 }, distance: -min.x },
    { normal: { x: -1, y: 0, z: 0 }, distance: max.x },
    { normal: { x: 0, y: 1, z: 0 }, distance: -min.y },
    { normal: { x: 0, y: -1, z: 0 }, distance: max.y },
    { normal: { x: 0, y: 0, z: 1 }, distance: -min.z },
    { normal: { x: 0, y: 0, z: -1 }, distance: max.z },
  ];
}

/**
 * 包围球是否与全部平面相交（相切算可见，与上游"保守不剔除"一致）。
 * @param {readonly Plane[]} planes 已归一化的内侧平面集合
 * @param {BoundingSphere} sphere
 * @returns {boolean} false 表示完全落在某个平面外侧 → 剔除
 */
export function sphereIntersectsPlanes(planes, sphere) {
  const cx = sphere.center.x;
  const cy = sphere.center.y;
  const cz = sphere.center.z;
  const radius = sphere.radius;
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz) || !Number.isFinite(radius) || radius < 0) {
    throw new RangeError(`非法包围球：${JSON.stringify(sphere)}（中心必须有限，半径必须为 >= 0 的有限数）`);
  }
  for (const plane of planes) {
    const signedDistance = plane.normal.x * cx + plane.normal.y * cy + plane.normal.z * cz + plane.distance;
    if (signedDistance < -radius) {
      return false;
    }
  }
  return true;
}

/**
 * 瓦片是否通过视锥剔除。
 * @param {Frustum} frustum
 * @param {TileKey} key
 * @returns {boolean}
 */
export function isTileVisible(frustum, key) {
  return sphereIntersectsPlanes(frustum.planes, frustum.boundsOf(key));
}

/**
 * 由 `[瓦片键, 包围球]` 条目构造 `boundsOf` 查询函数（测试/离线工具用）。
 * 键按规范字符串匹配；命中不到且未给 fallback 时**抛错**（宁可显式失败，也不静默剔除导致地形消失）。
 * @param {Iterable<[TileKey | string, BoundingSphere]>} entries
 * @param {(key: TileKey) => BoundingSphere} [fallback]
 * @returns {(key: TileKey) => BoundingSphere}
 */
export function createBoundsLookup(entries, fallback) {
  const byKey = new Map();
  for (const [key, sphere] of entries) {
    byKey.set(tileKeyToString(key), sphere);
  }
  return (key) => {
    const hit = byKey.get(tileKeyToString(key));
    if (hit !== undefined) {
      return hit;
    }
    if (fallback !== undefined) {
      return fallback(key);
    }
    throw new RangeError(`缺少瓦片包围球：${tileKeyToString(key)}`);
  };
}

/* ------------------------------------------------------------------------------------------------
 * 主规则
 * ---------------------------------------------------------------------------------------------- */

/**
 * 计算本帧可见瓦片集合。
 *
 * 严格按 data-model.md §1：
 * - 只考虑 `resident` 中的瓦片（绘制集合 = resident ∩ 视锥 ∩ 截断规则）；
 * - 视锥外（包围球与某平面完全分离）→ `culledOutOfFrustum`；
 * - 视锥内且 `childrenOf` 给出的子瓦片**恰好 4 个**且**全部 resident** → 父不绘制，进 `supersededByChildren`；
 * - 其余进 `tiles`。
 *
 * 纯函数：不修改 `resident` / `childrenOf` / `frustum`，无 IO，无模块级可变状态，同样输入必得同样输出
 * （输出数组每次新建，调用方可自由修改，不影响本模块）。
 *
 * @param {readonly TileKey[]} resident 本帧处于 resident 状态的瓦片（可含重复项，按规范键去重）
 * @param {Frustum} frustum 视锥（见 `createFrustum`）
 * @param {ReadonlyMap<TileKey | string, readonly TileKey[]>} childrenOf 瓦片 → 其子瓦片列表
 *        （键可按对象或规范字符串给出；生产环境由四叉树邻接表提供）
 * @param {number} [frameNumber] 帧号，写入 `frameDrawSet.frameNumber`，默认 0
 * @returns {DrawSetResult} 三个互斥数组 + data-model §1 形状的 `frameDrawSet`
 */
export function computeDrawSet(resident, frustum, childrenOf, frameNumber = 0) {
  if (resident === null || typeof resident !== "object" || typeof resident[Symbol.iterator] !== "function") {
    throw new TypeError("resident 必须是可迭代的瓦片键集合");
  }
  if (frustum === null || typeof frustum !== "object" || typeof frustum.boundsOf !== "function" || !Array.isArray(frustum.planes)) {
    throw new TypeError("frustum 必须是 createFrustum(...) 的返回值");
  }
  if (childrenOf !== undefined && childrenOf !== null && typeof childrenOf[Symbol.iterator] !== "function") {
    throw new TypeError("childrenOf 必须是 Map 或可迭代的 [key, children] 条目集合");
  }
  if (!Number.isInteger(frameNumber)) {
    throw new TypeError("frameNumber 必须是整数");
  }

  // 去重（保持首次出现顺序），并建立只读的 resident 成员索引。
  const residents = [];
  const residentKeys = new Set();
  for (const key of resident) {
    const id = tileKeyToString(key);
    if (residentKeys.has(id)) {
      continue;
    }
    residentKeys.add(id);
    residents.push(key);
  }

  // childrenOf 归一化为以规范键字符串为索引的只读映射（不要求与 resident 共享对象引用）。
  const childIndex = new Map();
  if (childrenOf !== undefined && childrenOf !== null) {
    for (const [key, children] of childrenOf) {
      childIndex.set(tileKeyToString(key), children ?? []);
    }
  }

  /** @type {TileKey[]} */
  const tiles = [];
  /** @type {TileKey[]} */
  const supersededByChildren = [];
  /** @type {TileKey[]} */
  const culledOutOfFrustum = [];

  for (const key of residents) {
    if (!isTileVisible(frustum, key)) {
      culledOutOfFrustum.push(key);
      continue;
    }
    const children = childIndex.get(tileKeyToString(key));
    const replacedByChildren =
      Array.isArray(children) &&
      children.length === 4 &&
      children.every((child) => residentKeys.has(tileKeyToString(child)));
    if (replacedByChildren) {
      supersededByChildren.push(key);
      continue;
    }
    tiles.push(key);
  }

  tiles.sort(compareTileKey);
  supersededByChildren.sort(compareTileKey);
  culledOutOfFrustum.sort(compareTileKey);

  return {
    tiles,
    supersededByChildren,
    culledOutOfFrustum,
    frameDrawSet: {
      frameNumber,
      tiles,
      supersededByChildren: supersededByChildren.length,
      culledOutOfFrustum: culledOutOfFrustum.length,
    },
  };
}
