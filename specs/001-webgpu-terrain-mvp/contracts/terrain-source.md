# Contract: 地形数据源（Terrain Source Adapter）

**Feature**: `001-webgpu-terrain-mvp` | **Spec**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

本契约定义本项目**如何取得地形瓦片**以及数据源必须满足的约束。设计结论（依据见 [../research.md](../research.md) §1/§4/§6）：

> 上游把地形数据交给四叉树调度的唯一**公开**扩展点是 `TerrainProvider` 子类化 +
> 返回公开的 `HeightmapTerrainData` / `QuantizedMeshTerrainData` 实例
> （上游 `TerrainData.createMesh`、`TerrainMesh`、`TerrainEncoding`、`GlobeSurfaceTileProvider`、
> `QuadtreePrimitive` 全部为 `@private`，**禁止依赖**——constitution 原则 I）。
> 因此：**瓦片调度 / LOD / 可用性 / 请求预算 / 内存管理 / 相机由上游负责；
> 瓦片的字节获取与解码、GPU 几何构建与绘制提交由本增量负责。**

---

## 1. 适配层接口（内部，不出现在公开入口）

```ts
// packages/cesium-webgpu/src/adapters/cesium/CesiumTerrainProviderAdapter.ts
export class CesiumTerrainProviderAdapter extends TerrainProvider {
  constructor(source: TerrainSource, hooks: TerrainSourceHooks);

  // —— 上游公开契约（必须实现）——
  get tilingScheme(): TilingScheme;                       // GeographicTilingScheme(WGS84)
  get availability(): TileAvailability | undefined;       // 由数据集清单构建（公开类 TileAvailability）
  get hasWaterMask(): boolean;                            // MVP 返回 false
  get hasVertexNormals(): boolean;                        // MVP 返回 false（不使用上游光照法线）
  get credit(): Credit;                                   // 数据源署名（FR-024）
  requestTileGeometry(x: number, y: number, level: number, request?: Request): Promise<TerrainData> | undefined;
  getTileDataAvailable(x: number, y: number, level: number): boolean | undefined;
  getLevelMaximumGeometricError(level: number): number;
  get errorEvent(): Event<TileProviderError>;
}

export interface TerrainSourceHooks {
  /** 请求开始（上游调度点击穿点）：瓦片进入 requested 状态 */
  onTileRequested(key: TileKey): void;
  /** 解码完成：交出唯一高程真值（HeightField）；上游数据对象由本层就地构造 */
  onTileDecoded(key: TileKey, field: HeightField, upstream: HeightmapTerrainData): void;
  /** 失败（区分 数据不可用 / 网络 / 解码） */
  onTileError(key: TileKey, error: TileError): void;
}
```

## 2. 规范性要求

| 编号 | 要求 | 追溯 |
|---|---|---|
| T-1 | MVP 数据源 MUST 免登录、免访问令牌；任何请求 URL MUST NOT 携带 token/key/签名参数 | FR-004 |
| T-2 | MUST 提供 `kind: "local-fixed"` 固定数据集实现，且该实现 MUST 能在**完全无网络**环境下完成加载、验证与基准 | FR-004 / FR-012 |
| T-3 | `getTileDataAvailable` MUST 仅依据数据集清单（打包了哪些层级与矩形）回答；MUST NOT 由本层另行设计空间索引或 LOD 决策 | spec Assumptions「上游能力边界」 |
| T-4 | 请求并发 MUST 有上限（默认 6）；MUST 在超预算时返回 `undefined` 交由上游稍后重试（上游契约允许的背压方式） | `TerrainProvider` 契约 |
| T-5 | 瓦片请求失败 MUST NOT 抛出未捕获错误；MUST 经 `errorEvent`（`TileProviderError`）上报，并保证其余瓦片继续渲染 | FR-004 / 边界用例 |
| T-6 | 空瓦片 / 无数据瓦片 MUST 按"无数据"处理，不产生三角形、不产生 NaN 顶点 | FR-016 / 边界用例 |
| T-7 | **单一几何真值**：同一瓦片的 (a) 交给上游的 `HeightmapTerrainData` 与 (b) 交给 WebGPU 的 `TileGeometry` MUST 由**同一份 `HeightField`** 派生，禁止两条独立解码/采样路径 | FR-008 |
| T-8 | 高程真值 MUST 逐点一致：WebGPU 顶点高度与上游从同一 buffer 计算出的高度 MUST 在所有网格采样点上相等（差异只允许出现在裙边几何的生成方式上） | FR-008 |
| T-9 | 数据源 MUST NOT 依赖 `TerrainData.createMesh` / `TerrainMesh` / `TerrainEncoding` / `GlobeSurfaceTileProvider` / `QuadtreePrimitive` / `GlobeSurfaceTile` / `Scene.context` / `Scene.pixelRatio` 等上游 `@private` 成员 | constitution 原则 I |
| T-10 | 每个数据集 MUST 附带 `attribution` 并以公开类 `Credit` 展示；`manifest.checksum` MUST 由 CI 校验 | FR-024 / FR-012 |
| T-11 | `"public"` 在线数据源 MUST NOT 参与 CI 判定；其不可用（网络/CORS/服务故障）MUST 表现为"数据不可用"的可观察状态，MUST NOT 导致整体渲染失败 | FR-004 / US1-AS1 边界用例 |

## 3. 固定数据集（Verification Dataset）格式与生成

```text
packages/cesium-webgpu/fixtures/<datasetId>/
├── manifest.json          # TerrainDatasetManifest（见 data-model.md §2）
└── <level>/<x>/<y>.hgt    # 本项目紧凑高程格式：8 字节头（magic "CHF1" + width + height，Uint16 LE）
                           # + width*height 个 Uint16 LE 高程样本（行主序，自北向南、自西向东）
```

- 高程解码约定（写入 `manifest.json` 的 `structure` 字段，与上游 `HeightmapTerrainData.structure`
  同构）：`height(m) = sample * heightScale + heightOffset`；默认 `heightScale = 1, heightOffset = 0`，
  生成脚本按数据源范围选择 `heightScale/heightOffset` 以保留精度（例如 `heightScale = 0.25` 覆盖 ±8192 m）。
- 生成脚本 `tools/build-terrain-fixture.mjs`：
  - `--from-public`：按 `manifest.rectangle` / `levels` 从**免登录公开栅格高程源**下载瓦片 → 本地解码
    （PNG 解析 + `zlib.inflate` + 反滤波 + Terrarium 解码，零第三方依赖）→ 写出 `.hgt`，
    并写入 `checksum` / `attribution` / `sourceUrl` / `generatedAt`；
  - `--from-local <dir>`：从已下载的原始瓦片离线重建（用于复现与审计，无需网络）；
  - `--verify-only`：CI 使用，校验文件清单与 `checksum`，任何静默替换即失败。
- 目标体积：**约 3–6 MB**（上限 20 MiB）；层级与范围以"固定相机下形成**多瓦片拼接**且高程起伏显著"为准（FR-015 / SC-002）。
  建议取值（已按实测瓦片体积估算，见 [../research.md](../research.md) §6.2）：
  **勃朗峰/大孔班山区域，约 0.6° × 0.5° 矩形，z0 – z12**（z12 约 38 m/像素，6×6 以上瓦片 → 满足多瓦片拼接）。
- 数据集的选择标准：存在显著高差（已实测：单块 z10 瓦片高程极差 **4217 m**，556–4773 m），
  以保证明暗或遮挡差异在统计断言上可观测（SC-002）。

## 4. 公开在线数据源（`kind: "public"`）

- **已核实端点（2026-09-18 实测）**：`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
  （XYZ，y=0 在北；z0–15；响应头 `Access-Control-Allow-Origin: *`；无需任何令牌）。
  数据来源为 AWS Open Data "Terrain Tiles"（Mapzen/Joerd），许可与必需署名见
  [../research.md](../research.md) §6.4（**已核实**）。
- 运行期直接取该 PNG，用 `createImageBitmap` + `OffscreenCanvas.getImageData` 解码为
  `height = R*256 + G + B/256 - 32768`（米），之后走**与固定数据集完全相同**的
  `HeightField → 几何 → 绘制` 链路（T-7）。
- 演示页使用 `kind: "public"` 时必须展示署名；CI 与验收一律使用 `kind: "local-fixed"`（T-11）。
- 已核实存在第二个免登录 quantized-mesh 端点（`https://terrain.reearth.land/cesium-mesh/ellipsoid`，
  200 + CORS `*`），但其**覆盖质量可疑且许可条款待确认（H-5b）**，默认不启用。

## 5. 备选：quantized-mesh 数据源（仅在 H-5 核实到免登录端点时启用）

- 若存在免登录、CORS 可用的 quantized-mesh（Cesium Terrain 1.0：`layer.json` + `.terrain`）端点，
  可将其作为第二个数据源实现：固定数据集改为 `.terrain` 字节拷贝，上游注入对象改为公开类
  `QuantizedMeshTerrainData`（构造选项含 `quantizedVertices`/`indices`/边索引/裙边高度，已核实公开）。
- 启用条件与代价：需要新增二进制解码（zigzag 编解码的 u/v/h 与索引）；§2 的 T-7/T-8 随之变为
  "上游 `QuantizedMeshTerrainData.indices` 与本层 `TileGeometry.indices` 逐元素一致"的更强形式。
- **本契约的主路径仍是 `HeightmapTerrainData`**：它不需要解码 Cesium 自有二进制格式，
  且两种数据源共用同一份高程真值，几何等价性更容易证明。切换不改变上层 API、验证方式与工期量级。
