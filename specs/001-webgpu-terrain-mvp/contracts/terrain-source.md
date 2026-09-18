# Contract: 地形数据源（Terrain Source Adapter）

**Feature**: `001-webgpu-terrain-mvp` | **Status**: 设计基线 v2 | **Spec**: [../spec.md](../spec.md) | **Research**: [../research.md](../research.md) §8
**Constitution**: v2.0.0 原则 I（逻辑层语义一行不改）｜ **Data model**: [../data-model.md](../data-model.md) §6

本契约定义本项目**如何取得地形瓦片**，以及"数据源接入完全不触碰逻辑层"的边界。

> **本版关键变化（相对 v1）**：地形数据源改用上游**公开类** `CustomHeightmapTerrainProvider`
> （`Core/CustomHeightmapTerrainProvider.js:28-56`；公开导出 `package/index.js:263`、`index.d.ts:5324`），
> **几何构建与四叉树调度全部由上游逻辑层完成**（`HeightmapTerrainData.createMesh` → `TerrainEncoding` →
> `GlobeSurfaceTile` → `DrawCommand`）。本项目**不再**自定义 `TerrainProvider` 子类、**不再**自建顶点/索引/裙边。

---

## 1. 适配层接口（内部，不出现在公开入口）

```ts
// packages/cesium-webgpu/src/terrain/source.ts
export type TerrainSourceMode = "fixture" | "public";

export interface TerrainSourceOptions {
  mode: TerrainSourceMode;                  // 验收与 CI 一律 fixture（离线）
  datasetId: string;
  tilingScheme?: "geographic";              // MVP 固定 geographic（level 0 = 2 块瓦片）
  credit?: string;                          // 署名（MUST 非空）
}

// 返回上游公开类型实例；本项目不实现 TerrainProvider 接口
export function createTerrainProvider(options: TerrainSourceOptions): Promise<CustomHeightmapTerrainProvider>;
```

**规则**：

1. `createTerrainProvider` MUST 返回 **上游公开类** `CustomHeightmapTerrainProvider`
   （以 `callback(x, y, level)` 提供 `HeightmapTerrainData`；公开构造选项：`callback`、`width`、`height`、
   `tilingScheme`、`ellipsoid`、`credit`）；
2. 回调 MUST 返回**公开类** `HeightmapTerrainData` 实例；
3. MUST NOT 取用任何 `@private` 的地形内部类型（`TerrainData`、`TerrainMesh`、`TerrainEncoding`、
   `GlobeSurfaceTileProvider`、`QuadtreePrimitive`、`GlobeSurfaceTile` 等）——本项目**根本不接触**它们，
   它们只在上游逻辑层内部流转；
4. MUST NOT 引入任何需要凭据（访问令牌）的服务：MVP 只用免登录公开源 + 随仓库提交的固定数据集（FR-004）；
5. 数据不可用（瓦片缺失、网络失败、超时）MUST 表现为"数据不可用"的可观察状态，与"渲染失败"可区分。

## 2. 固定数据集（Verification Dataset）

| 项 | 规定 |
|---|---|
| 位置 | `packages/cesium-webgpu/fixtures/<datasetId>/`（随仓库提交） |
| 格式 | `manifest.json` + `<level>/<x>/<y>.hgt`（小端 Uint16 高程，米，含 `noDataValue`） |
| 体积 | `totalBytes` MUST ≤ 20 MiB（目标 3–6 MB） |
| 覆盖 | 以勃朗峰/大孔班山为中心约 **0.6° × 0.5°**，层级 **z0–z12**；最大层级在覆盖区内 MUST ≥ **2×2 瓦片**（多瓦片拼接，FR-015） |
| 高差 | MUST > 4000 m（保证 SC-002 的"高程特征可观察"） |
| 离线 | 验收与 CI MUST 在**零外部请求**下完成（由测试断言；`mode: "fixture"`） |
| 完整性 | `manifest.json.sha256` 为数据集内容哈希；CI MUST 断言一致 |
| 署名 | `manifest.json.attribution` MUST 非空，且 `sources[]` 逐来源给出许可与链接（FR-024） |

生成脚本：`tools/build-terrain-fixture.mjs`（一次性；Node 22，零第三方依赖或仅用仓库已锁定依赖）。

## 3. 公开在线数据源（`mode: "public"`，仅演示）

- 端点：`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
  （AWS Open Data "Terrain Tiles"，Mapzen/Joerd；**无需 AWS 账号**；CORS `*`；z0–15）。
- 解码：`height = R*256 + G + B/256 - 32768`（米）；瓦片为 XYZ 约定（y=0 在北）。
- 上游**没有**内置 Terrarium 解码器 → 本层自行解码（`createImageBitmap` + `OffscreenCanvas.getImageData`
  或 `ImageData` 路径），解码结果转成 Uint16 高程场后交给 `HeightmapTerrainData`。
- 在线源不可用时 MAY 静默降级为 `fixture`（MUST 记录状态：`degraded: true` + `notes`）。

## 4. 本增量不做的数据源工作

- quantized-mesh 端点接入（上一轮已核实：唯一免登录端点在多数据区返回退化瓦片，不可作为依赖）；
- 凭据类服务（Cesium ion / MapTiler / Mapbox 等）——**后置到后续增量**；
- 自定义空间索引、LOD 决策、瓦片预取与磁盘缓存策略调优——**全部沿用上游逻辑层**。

## 5. 验收判据（本契约相关）

| 判据 | 内容 |
|---|---|
| TS-1 | `createTerrainProvider` 返回的对象 `instanceof CustomHeightmapTerrainProvider`（或其公开类型断言成立） |
| TS-2 | 固定数据集在离线环境完成多瓦片地形渲染；测试断言运行期零外部请求 |
| TS-3 | `manifest.json` 的 `attribution`/`sources`/`sha256`/`levels`/`rectangle` 齐备且校验通过 |
| TS-4 | 强制断网后仍能完成验收用例（`mode: "fixture"`） |
| TS-5 | 数据不可用与渲染失败在状态/错误类别上可区分 |
