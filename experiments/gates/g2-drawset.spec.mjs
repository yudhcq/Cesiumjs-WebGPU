/**
 * G-2 / T004 —— 可见瓦片集合规则的门禁单元测试
 *
 * 运行：`node --test experiments/gates/g2-drawset.spec.mjs`
 * 依赖：仅 Node 内建（`node:test` / `node:assert/strict`）+ 同目录 `g2-drawset.mjs`，零第三方依赖、零构建步骤。
 *
 * 必测三向量（tasks.md T004 自检）：
 *  1) 父被 4 个 resident 子瓦片替换 → 父进入 `supersededByChildren`、不在 `tiles`
 *  2) 子只到齐 3 个 → 父仍绘制
 *  3) 全部出视锥 → `tiles` 为空集
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  childrenOfKey,
  compareTileKey,
  computeDrawSet,
  createBoundsLookup,
  createFrustum,
  planesOfBox,
  sphereIntersectsPlanes,
  tileKeyToString,
} from "./g2-drawset.mjs";

/* ------------------------------------------------------------------------------------------------
 * 测试夹具：视锥 = 轴对齐盒 [0,10]^3；瓦片包围球由按键登记的「盒内球 / 盒外球」提供
 * ---------------------------------------------------------------------------------------------- */

const INSIDE = { center: { x: 5, y: 5, z: 5 }, radius: 1 };
const OUTSIDE = { center: { x: 100, y: 100, z: 100 }, radius: 1 };
/** 跨 x=10 平面但与视锥相交（球心到平面距离 -0.5 > -radius）→ 仍可见 */
const STRADDLING = { center: { x: 10.5, y: 5, z: 5 }, radius: 1 };

/** @param {Iterable<[object | string, object]>} entries */
function frustumOf(entries) {
  return createFrustum(planesOfBox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 }), createBoundsLookup(entries));
}

function keyString(key) {
  return tileKeyToString(key);
}

function sortedStrings(keys) {
  return keys.map(keyString).sort();
}

const ROOT = { level: 0, x: 0, y: 0 };
const CHILDREN = childrenOfKey(ROOT); // level 1: SW, SE, NW, NE
const [SW, SE, NW, NE] = CHILDREN;

/* ------------------------------------------------------------------------------------------------
 * 向量 1：父被 4 个 resident 子瓦片替换
 * ---------------------------------------------------------------------------------------------- */

test("向量1：4 个子瓦片全部 resident → 父进入 supersededByChildren 且不在 tiles", () => {
  const resident = [ROOT, SW, SE, NW, NE];
  const frustum = frustumOf(resident.map((k) => [k, INSIDE]));

  const result = computeDrawSet(resident, frustum, new Map([[ROOT, CHILDREN]]), 42);

  assert.deepEqual(result.tiles, [{ level: 1, x: 0, y: 0 }, { level: 1, x: 0, y: 1 }, { level: 1, x: 1, y: 0 }, { level: 1, x: 1, y: 1 }]);
  assert.ok(
    !result.tiles.some((k) => keyString(k) === keyString(ROOT)),
    "父瓦片不得出现在绘制集合中",
  );
  assert.deepEqual(result.supersededByChildren, [ROOT]);
  assert.deepEqual(result.culledOutOfFrustum, []);
  // data-model §1 的 FrameDrawSet 形状（此处两个字段是计数）
  assert.equal(result.frameDrawSet.frameNumber, 42);
  assert.equal(result.frameDrawSet.tiles.length, 4);
  assert.equal(result.frameDrawSet.supersededByChildren, 1);
  assert.equal(result.frameDrawSet.culledOutOfFrustum, 0);
  assert.equal(result.frameDrawSet.tiles, result.tiles);
});

/* ------------------------------------------------------------------------------------------------
 * 向量 2：子只到齐 3 个 → 父仍绘制
 * ---------------------------------------------------------------------------------------------- */

test("向量2：子瓦片只 resident 3 个 → 父仍绘制且不被替换", () => {
  const resident = [ROOT, SW, SE, NW]; // 缺 NE
  const frustum = frustumOf(resident.map((k) => [k, INSIDE]));

  const result = computeDrawSet(resident, frustum, new Map([[ROOT, CHILDREN]]));

  assert.ok(
    result.tiles.some((k) => keyString(k) === keyString(ROOT)),
    "子瓦片不齐时父瓦片必须绘制",
  );
  assert.equal(result.tiles.length, 4); // 父 + 3 个已就位子瓦片
  assert.deepEqual(result.supersededByChildren, []);
  assert.equal(result.frameDrawSet.supersededByChildren, 0);
  assert.equal(result.frameDrawSet.culledOutOfFrustum, 0);
});

/* ------------------------------------------------------------------------------------------------
 * 向量 3：全部出视锥 → 空集
 * ---------------------------------------------------------------------------------------------- */

test("向量3：全部瓦片出视锥 → tiles 为空集，且全部计入 culledOutOfFrustum", () => {
  const resident = [ROOT, SW, SE, NW, NE];
  const frustum = frustumOf(resident.map((k) => [k, OUTSIDE]));

  const result = computeDrawSet(resident, frustum, new Map([[ROOT, CHILDREN]]));

  assert.deepEqual(result.tiles, []);
  assert.equal(result.frameDrawSet.tiles.length, 0);
  assert.deepEqual(sortedStrings(result.culledOutOfFrustum), sortedStrings(resident));
  assert.deepEqual(result.supersededByChildren, []);
  assert.equal(result.frameDrawSet.culledOutOfFrustum, 5);
});

/* ------------------------------------------------------------------------------------------------
 * 补充向量：口径、纯度与确定性
 * ---------------------------------------------------------------------------------------------- */

test("补充：视锥剔除优先于父级替换，三类结果互斥且恰好覆盖去重后的 resident", () => {
  const resident = [ROOT, SW, SE, NW, NE];
  const bounds = [
    [ROOT, INSIDE],
    [SW, INSIDE],
    [SE, STRADDLING], // 与视锥相交 → 可见
    [NW, INSIDE],
    [NE, OUTSIDE], // 出视锥
  ];
  const frustum = frustumOf(bounds);

  const result = computeDrawSet(resident, frustum, new Map([[ROOT, CHILDREN]]));

  // 替换判定只依据"子瓦片是否 resident"（data-model §1 原文），与子瓦片自身是否可见无关。
  assert.deepEqual(result.supersededByChildren, [ROOT]);
  assert.deepEqual(sortedStrings(result.culledOutOfFrustum), [keyString(NE)]);
  assert.deepEqual(sortedStrings(result.tiles), sortedStrings([SW, SE, NW]));

  const classified = [...result.tiles, ...result.supersededByChildren, ...result.culledOutOfFrustum].map(keyString);
  assert.equal(new Set(classified).size, classified.length, "三类结果必须互斥");
  assert.deepEqual(sortedStrings(classified), sortedStrings(resident), "三类结果合并后必须等于 resident");
});

test("补充：纯函数 —— 不修改入参，输出每次新建", () => {
  const resident = [ROOT, SW, SE, NW, NE];
  const childrenOf = new Map([[ROOT, CHILDREN]]);
  const frustum = frustumOf(resident.map((k) => [k, INSIDE]));
  const residentBefore = JSON.stringify(resident);
  const childrenBefore = JSON.stringify([...childrenOf].map(([k, v]) => [k, v]));
  const planesBefore = JSON.stringify(frustum.planes);

  const first = computeDrawSet(resident, frustum, childrenOf);
  const second = computeDrawSet(resident, frustum, childrenOf);

  assert.equal(JSON.stringify(resident), residentBefore, "resident 不得被修改");
  assert.equal(JSON.stringify([...childrenOf].map(([k, v]) => [k, v])), childrenBefore, "childrenOf 不得被修改");
  assert.equal(JSON.stringify(frustum.planes), planesBefore, "frustum.planes 不得被修改");
  assert.deepEqual(first, second, "同输入必得同输出");
  assert.notEqual(first.tiles, second.tiles, "输出数组必须是新对象");
});

test("补充：重复键去重，输出按 level→x→y 确定性升序", () => {
  const resident = [NE, ROOT, SW, ROOT, SE, NW, SW];
  const frustum = frustumOf([ROOT, SW, SE, NW, NE].map((k) => [k, INSIDE]));

  const result = computeDrawSet(resident, frustum, new Map([[ROOT, CHILDREN]]));

  assert.deepEqual(result.tiles.map(keyString), ["1/0/0", "1/0/1", "1/1/0", "1/1/1"]);
  assert.deepEqual(result.supersededByChildren.map(keyString), ["0/0/0"]);
  assert.equal(result.tiles.length, 4, "重复键必须去重");
});

test("补充：childrenOf 的键可以是规范字符串（不要求与 resident 元素同一对象引用）", () => {
  const resident = [ROOT, SW, SE, NW, NE];
  const frustum = frustumOf(resident.map((k) => [k, INSIDE]));

  const byObject = computeDrawSet(resident, frustum, new Map([[ROOT, CHILDREN]]));
  const byString = computeDrawSet(resident, frustum, new Map([[keyString(ROOT), CHILDREN]]));

  assert.deepEqual(byString, byObject);
});

test("补充：childrenOf 给出的子键个数不是 4（畸形/部分四叉树）→ 保守地保留父瓦片", () => {
  const resident = [ROOT, SW, SE, NW, NE];
  const frustum = frustumOf(resident.map((k) => [k, INSIDE]));

  const fiveChildren = [...CHILDREN, { level: 1, x: 2, y: 0 }];
  const result = computeDrawSet(resident, frustum, new Map([[ROOT, fiveChildren]]));

  assert.ok(result.tiles.some((k) => keyString(k) === keyString(ROOT)));
  assert.deepEqual(result.supersededByChildren, []);
});

test("补充：未登记 childrenOf 的瓦片一律绘制（叶子）", () => {
  const resident = [ROOT, SW];
  const frustum = frustumOf(resident.map((k) => [k, INSIDE]));

  const result = computeDrawSet(resident, frustum, new Map());

  assert.deepEqual(result.tiles.map(keyString), ["0/0/0", "1/0/1"]);
  assert.deepEqual(result.supersededByChildren, []);
});

test("补充：多级 LOD —— 逐级被替换，最终只绘制最深层瓦片", () => {
  const level1 = childrenOfKey(ROOT);
  const level2 = level1.flatMap((k) => childrenOfKey(k));
  const resident = [ROOT, ...level1, ...level2];
  const frustum = frustumOf(resident.map((k) => [k, INSIDE]));
  const childrenOf = new Map([[ROOT, level1], ...level1.map((k) => [k, childrenOfKey(k)])]);

  const result = computeDrawSet(resident, frustum, childrenOf);

  assert.deepEqual(sortedStrings(result.tiles), sortedStrings(level2));
  assert.deepEqual(sortedStrings(result.supersededByChildren), sortedStrings([ROOT, ...level1]));
  assert.equal(result.tiles.length, 16);
  assert.equal(result.frameDrawSet.supersededByChildren, 5);
  assert.equal(result.culledOutOfFrustum.length, 0);
});

test("补充：空 resident → 三个集合均为空，FrameDrawSet 计数为 0", () => {
  const frustum = frustumOf([]);

  const result = computeDrawSet([], frustum, new Map(), 7);

  assert.deepEqual(result.tiles, []);
  assert.deepEqual(result.supersededByChildren, []);
  assert.deepEqual(result.culledOutOfFrustum, []);
  assert.deepEqual(result.frameDrawSet, { frameNumber: 7, tiles: [], supersededByChildren: 0, culledOutOfFrustum: 0 });
});

/* ------------------------------------------------------------------------------------------------
 * 补充：几何/工具函数的直接断言
 * ---------------------------------------------------------------------------------------------- */

test("补充：childrenOfKey 返回 4 个 level+1 的规范子键；包围球测试为保守（相切可见）", () => {
  const children = childrenOfKey({ level: 3, x: 5, y: 7 });

  assert.equal(children.length, 4);
  assert.deepEqual(children.map(keyString).sort(), ["4/10/14", "4/10/15", "4/11/14", "4/11/15"]);
  assert.equal(new Set(children.map(keyString)).size, 4, "4 个子键互不相同");
  assert.ok(children.every((k) => k.level === 4));
  assert.deepEqual([...children].sort(compareTileKey).map(keyString), ["4/10/14", "4/10/15", "4/11/14", "4/11/15"]);

  const planes = createFrustum(planesOfBox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 }), () => INSIDE).planes;
  assert.equal(sphereIntersectsPlanes(planes, { center: { x: 11, y: 5, z: 5 }, radius: 1 }), true, "相切算可见");
  assert.equal(sphereIntersectsPlanes(planes, { center: { x: 11.01, y: 5, z: 5 }, radius: 1 }), false);
  assert.throws(() => createBoundsLookup([])(ROOT), /缺少瓦片包围球/);
});
