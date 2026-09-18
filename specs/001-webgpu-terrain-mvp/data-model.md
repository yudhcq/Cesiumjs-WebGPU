# Data Model: WebGPU Terrain Rendering MVP

**Feature**: `001-webgpu-terrain-mvp` | **Date**: 2026-09-18 | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

本文件把 `spec.md` 的 Key Entities 落成可实现的类型与状态机。**本文件是设计产物，不回写 spec**；
spec 中的技术无关约束（FR-001…FR-029 / SC-001…SC-009）在每节以 `→ FR-0xx` 标注追溯。

约定：
- 所有类型位于 `packages/cesium-webgpu/src/**`，产物以 ESM + `.d.ts` 发布。
- **`src/api/**`（同构上层 API）中不得出现 `GPU*` / `WebGL*` / `navigator.gpu` 等后端符号**（FR-007，见 §9 边界断言）。
- 时间单位统一 `ms`（number），内存单位统一字节（number，前缀 `bytes`）。

---

## 1. 瓦片与几何（Terrain Tile）

`→ FR-001, FR-004, FR-016；spec Key Entities: 地形瓦片`

```ts
export interface TileKey {
  readonly level: number; // >= 0
  readonly x: number;     // 0 <= x < 2^level * (tilingScheme 宽度)
  readonly y: number;     // 0 <= y < 2^level * (tilingScheme 高度)
}

export type TileAvailability = "data" | "no-data" | "unknown";

export type TileState =
  | "absent"      // 尚未被上游调度器请求
  | "requested"   // 已向上游 TerrainProvider 返回 promise（或已排入本地并发队列）
  | "decoding"    // 字节已到手，正在解码为高程场与几何
  | "resident"    // 几何在 CPU 与 GPU 双端可用，可参与绘制
  | "failed";     // 终态（经重试耗尽），不可绘制

export interface TileRecord {
  readonly key: TileKey;
  /** 瓦片经纬度范围，来自 tilingScheme.tileXYToRectangle（上游公开 API 计算，本层不自行推导） */
  readonly rectangle: Rectangle;
  state: TileState;
  availability: TileAvailability;
  /** 本层唯一高程真值来源：解码后的规则高程场（FR-004 的“本地固定数据集”与“公开数据源”共用此结构） */
  heightField?: HeightField;
  /** 提交给上游 Cesium 的公开数据对象（QuantizedMeshTerrainData / HeightmapTerrainData） */
  upstreamData?: QuantizedMeshTerrainData | HeightmapTerrainData;
  geometry?: TileGeometry;
  error?: TileError;
  lastUsedFrame: number; // 用于 LRU 逐出
}

export interface HeightField {
  readonly width: number;  // 采样列数（经度方向）
  readonly height: number; // 采样行数（纬度方向）
  readonly heights: Float32Array; // 米，长度 = width*height，行主序，自北向南、自西向东
  readonly minimumHeight: number;
  readonly maximumHeight: number;
  readonly childTileMask: number; // bit0 SW, bit1 SE, bit2 NW, bit3 NE（上游语义，见 HeightmapTerrainData 文档）
  readonly skirtHeight: number;   // 米
  readonly vertexCountWithoutSkirts: number;
  readonly indexCountWithoutSkirts: number;
}

export interface TileGeometry {
  readonly key: TileKey;
  readonly positions: Float32Array;  // ECEF，3 分量/顶点
  readonly indices: Uint32Array;     // 与上游从同一 HeightField 建出的规则网格三角化一致（→ T-8）
  readonly boundingSphere: BoundingSphere;
  readonly gpu: GpuGeometryRef;
}

export interface TileError {
  category: "network" | "http-status" | "decode" | "cancelled";
  message: string;
  httpStatus?: number;
  retries: number;
}
```

**状态迁移**（`→ FR-004`：必须区分“数据不可用”与“渲染失败”）

```text
absent ──request──▶ requested ──bytes ok──▶ decoding ──ok──▶ resident ──evict──▶ absent
   ▲                    │                      │
   │                    └──retry(<=N)──────────┴──fail──▶ failed  (availability="no-data" 时直接 resident 为空几何)
```

校验规则：
- `heightField.width * heightField.heights.length` 必须一致；任一 `NaN`/`±Infinity` 值必须被拒绝并归入 `TileError.category="decode"`（`→ FR-016`：不得产生尖刺/穿模）。
- `availability === "no-data"` 的瓦片以空几何进入 `resident`，不产生任何三角形（`→ 边界用例“地形服务返回空瓦片”`）。
- `skirtHeight > 0` 且四边裙边顶点必须由同一边界顶点沿椭球法线下压生成，保证接缝连续（`→ FR-016`）。
- `resident` 的瓦片必须同时持有 CPU 侧 `heightField`（用于设备丢失后重建，`→ FR-003`）。

**逐帧绘制集合**（`→ FR-001, FR-008`）：绘制集合 = `resident` 瓦片 ∩ 视锥 ∩ 截断规则。

```ts
export interface FrameDrawSet {
  readonly frameNumber: number;
  readonly tiles: readonly TileKey[];
  /** 被父级完全替换而剔除的瓦片数（诊断用，用于验证与上游 LOD 选择的一致性） */
  readonly supersededByChildren: number;
  readonly culledOutOfFrustum: number;
}
```
截断规则（**待验证假设 H-2**，见 research.md）：若某瓦片的 4 个子瓦片全部 `resident`，则父瓦片不绘制；
否则绘制。依据：上游四叉树只在判定父级精度不足时才请求子瓦片（`Globe.maximumScreenSpaceError`），
因此 `resident` 集合的“叶子”即上游的绘制截断，本层不重新实现 LOD 决策。
验证方法：固定相机、`globe.tilesLoaded === true` 后，两条路径的**几何统计**（顶点数、索引数、
绘制批次数、包围盒覆盖的经纬度范围）必须落在声明区间内（见 `contracts/verification-and-benchmark.md`）。

---

## 2. 地形数据源（Terrain Source）

`→ FR-004；spec Dependencies「地形数据源」「不依赖凭据」`

```ts
export type TerrainSourceConfig =
  | { kind: "local-fixed"; datasetId: string; baseUrl: string }  // 仓库内固定数据集，CI/离线默认
  | { kind: "public";      datasetId: string; baseUrl: string }; // 免登录公开服务，演示用

export interface TerrainDatasetManifest {
  readonly id: string;                 // 例："alps-fixed-v1"
  readonly format: "heightmap-u16-v1" | "quantized-mesh-1.0"; // 主路径为前者（见 contracts/terrain-source.md）
  readonly tilingScheme: "geographic" | "web-mercator";
  readonly levels: readonly number[];  // 实际打包的层级
  readonly rectangle: { west: number; south: number; east: number; north: number }; // 弧度
  readonly tileCount: number;
  readonly totalBytes: number;
  readonly checksum: string;           // 生成脚本写入，CI 校验（保证验证数据不可被静默替换，→ FR-012）
  readonly attribution: string;        // 许可要求的署名文本（→ FR-024）
  readonly sourceUrl: string;          // 生成该固定数据集所用的公开服务 URL（可追溯）
  readonly generatedAt: string;        // ISO-8601
  readonly structure: {                // 高程解码约定（与上游 HeightmapTerrainData.structure 同构）
    readonly heightScale: number; readonly heightOffset: number;
    readonly elementsPerHeight: number; readonly stride: number;
  };
}
```

- `layer.json`（Cesium Terrain 1.0 的标准清单）**原样透传**：`availability` 交给公开类 `TileAvailability`
  解析并挂到 `TerrainProvider.availability`，瓦片可用性判定由上游四叉树完成，本层不自行设计空间索引。
- 数据源实现必须满足：无任何访问令牌参数；离线（`kind="local-fixed"`）时不得发起任何外部网络请求
  （由验证用例断言：`response` 拦截器记录到的外部主机名集合必须为空，`→ FR-012` / 边界用例“无网络或离线运行”）。
- 两个数据集的**字节内容同源**（固定数据集是公开服务同层级同坐标瓦片的拷贝），只是 URL 不同，
  以保证“CI 离线可复现”与“演示用公开数据源”两条链路在几何上等价（`→ FR-008`）。

---

## 3. 渲染路径与能力探测（Render Path / Capability Probe）

`→ FR-005, FR-006, FR-007, FR-009；spec Key Entities: 渲染路径、能力探测结果`

```ts
export type RenderPathId = "webgl2" | "webgpu";

export type PathUnavailableReason =
  | "no-navigator-gpu"        // navigator.gpu 不存在
  | "adapter-unavailable"     // requestAdapter 返回 null
  | "device-request-failed"   // requestDevice 抛错/拒绝
  | "probe-timeout"           // 超过 2000ms 上限
  | "limits-below-floor"      // 能力下限不满足
  | "device-lost"             // 会话中途设备丢失且恢复失败
  | "init-error";             // 其他初始化异常

export interface CapabilityFloor {
  readonly maxTextureDimension2D: number; // >= 4096
  readonly maxBufferSize: number;         // >= 256 * 1024 * 1024
  readonly maxVertexBuffers: number;      // >= 2
  readonly maxBindGroups: number;         // >= 2
  readonly requiredFeatures: readonly string[]; // MVP 为空集（只使用 WebGPU 核心里程碑能力）
}

export interface CapabilityProbeResult {
  readonly available: boolean;
  readonly deviceAcquired: boolean;
  readonly elapsedMs: number;                 // 必须 <= probe.timeoutMs（→ FR-005：上限 2s）
  readonly limits?: Readonly<Record<string, number>>;
  readonly adapterInfo?: { vendor: string; architecture: string; device: string; description: string };
  readonly reasons: readonly PathUnavailableReason[]; // 空数组表示可用
}

export interface PathInfo {
  readonly active: RenderPathId;
  readonly degraded: boolean;                 // 是否“非首选路径”（用于状态提示，→ FR-009）
  readonly reason?: PathUnavailableReason;    // 回退原因类别
  readonly probeDurationMs?: number;
}
```

状态机（`→ FR-006`：兜底路径任何时刻可用；`→ FR-003`：设备丢失恢复）：

```text
           ┌──────────── probe(<=2s) ───────────┐
           ▼                                    │
  [webgl2-active] ◀──fail/timeout/limits/low── [probing] ──ok──▶ [webgpu-active]
        ▲                                                             │
        │                                                      device.lost
        └────────── restore 失败（可观察提示，→ FR-003/FR-009）◀───────┤
                                                                      │
                        restore 成功（重建 device + 重传 resident 几何）┘
```

不变式：
- `webgl2` 无需任何探测即可启用：探测失败不得阻塞 `CesiumWidget` 构造，也不得抛出未捕获错误（`→ FR-005`）。
- 探测超时后即使 promise 迟到 resolve，也**不得**切换路径，且必须释放已获取的 device（`device.destroy()`）。
- 选择逻辑只依赖 `RenderPathPreference` 与 `CapabilityProbeResult`；后端实现之间互不 import（`→ FR-007`）。

---

## 4. 帧与统计（Frame / FrameStats）

`→ FR-002, FR-017；constitution 原则 IV`

```ts
export interface FrameStats {
  readonly frameNumber: number;
  readonly frameTimeMs: number;      // 两次 postRender 之间的墙钟时间
  readonly cpuEncodeMs: number;      // 本帧 WebGPU 编码耗时（对照指标）
  readonly drawCalls: number;        // 本帧提交给图形接口的绘制请求数
  readonly triangles: number;
  readonly gpuResourceBytes: number; // 由统一资源登记表统计（见 §5）
}

export interface FrameStatsSummary {
  readonly samples: number;
  readonly warmupFrames: number;
  readonly p50: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}
```

指标口径（**必须与基准文档一致，变更需记录理由**，`→ FR-017/FR-018`、constitution 原则 IV）：
- `frameTimeMs`：`Scene.postRender` 相邻两次回调的 `performance.now()` 差值；采样前固定预热帧数
  （默认 120 帧），采样帧数固定（默认 600 帧），样本在报告中完整存档（用于复核 p50/p95）。
- `drawCalls`：两条路径同口径统计——WebGPU 侧统计 `GPURenderPassEncoder.drawIndexed()` 调用次数；
  WebGL2 侧由**验证脚手架**包装平台 API `WebGL2RenderingContext.prototype.drawElements/drawArrays`
  计数（包装的是浏览器平台 API，不是 Cesium 内部实现，不违反 constitution 原则 I）。
- `gpuResourceBytes`：定义为“经图形 API 分配的资源字节数”，由共享的 `GpuResourceRegistry`
  统一登记：WebGPU 侧登记 `createBuffer/createTexture` 的字节数；WebGL2 侧由同一脚手架包装
  `bufferData/texImage2D` 统计上传字节数。**这是一个声明过的代理指标**，不等于驱动层真实显存占用
  （浏览器不暴露真实 VRAM），必须与 `adapterInfo`、`degraded` 标注一起解读。

---

## 5. GPU 资源登记表（GpuResourceRegistry）

`→ FR-003（设备丢失重建）, FR-017（显存指标）`

```ts
export interface GpuResourceRegistry {
  readonly totalBytes: number;
  createBuffer(desc: { size: number; usage: number; label: string }): GpuBufferHandle;
  createTexture(desc: { bytes: number; label: string }): GpuTextureHandle;
  release(handle: GpuBufferHandle | GpuTextureHandle): void;
  /** 设备丢失后：所有句柄失效，registry 必须在同一 device 生命周期内保持一致 */
  invalidateAll(): void;
  stats(): { buffers: number; textures: number; bytes: number };
}
```
规则：
- 每个 GPU 资源必须携带 `label = "<kind>:<tileKey|purpose>"`，使基准报告中的显存占用可按用途分解。
- 设备丢失（`GPUDevice.lost`）后，`invalidatedAll()` 置空登记表；随后由 `TileRegistry` 中仍处于
  `resident` 的 `heightField` 逐帧限量重建（`→ FR-003`：恢复过程不需要刷新页面）。
- 逐帧上传预算：默认 ≤ 4 个瓦片或 ≤ 8 MiB/帧，避免恢复/加载造成的长帧（`→ FR-002`：单次交互不出现 >1s 卡顿）。

---

## 6. 视觉验证证据（Visual Verification Evidence）

`→ FR-010…FR-016, FR-022；spec Key Entities: 视觉验证证据、验证数据集`

```ts
export interface VerificationDataset {
  readonly id: string;                        // 例："vd-alps-01"
  readonly terrain: TerrainSourceConfig;      // 固定数据集
  readonly camera: CameraSnapshot;            // 固定相机（位置/朝向/视场角/近远平面）
  readonly viewport: { width: number; height: number; pixelRatio: number };
  readonly sceneTime: string;                 // ISO-8601，固定场景时间
  readonly seed: number;                      // 固定随机种子
  readonly multiTile: boolean;                // 必须为 true（→ FR-015：覆盖多瓦片拼接）
}

export interface CameraSnapshot {
  readonly longitude: number; readonly latitude: number; readonly height: number; // 弧度/米
  readonly heading: number; readonly pitch: number; readonly roll: number;        // 弧度
  readonly fov?: number; readonly near?: number; readonly far?: number;
}

export interface ToleranceProfile {
  readonly id: string;              // 例："tol-v1"
  readonly maxMismatchRatio: number;   // 例 0.02（2% 像素）
  readonly maxMeanAbsDiff: number;     // 例 1.5（0-255）
  readonly perChannelTolerance: number;// 例 8
  readonly ignoreEdgePixels: number;   // 抗锯齿边缘收缩像素数（例 1）
  readonly source: string;             // 可追溯来源：推导过程 + 批准记录链接（→ FR-014）
}

export interface VisualVerificationEvidence {
  readonly id: string;                 // 稳定 id（dataset + path + case）
  readonly path: RenderPathId;
  readonly datasetId: string;
  readonly fixedConditions: VerificationDataset;
  readonly capturePngPath: string;
  readonly referencePngPath: string;
  readonly diffPngPath: string;
  readonly stats: FrameStatistics;
  readonly tolerance: ToleranceProfile;
  readonly verdict: "pass" | "fail";
  readonly metrics: {
    mismatchRatio: number; meanAbsDiff: number; maxAbsDiff: number;
    diffRegions: readonly { x: number; y: number; width: number; height: number }[];
  };
}

export interface FrameStatistics {
  readonly width: number; readonly height: number;
  readonly nonBackgroundRatio: number;     // 非背景色像素占比（→ SC-002：不得近似 0，不得为 1 的单色）
  readonly uniqueColorCount: number;       // 唯一颜色数（→ SC-002：避免“整片单色”假通过）
  readonly luminanceMean: number;
  readonly luminanceStdDev: number;
  readonly colorHistogram: readonly number[]; // 16 bins × 3 通道，归一化
  readonly skylineRatio: number;           // 背景（天空/纯背景色）像素占比
}
```
export interface CrossPathEquivalenceRecord {
  readonly id: string;                 // dataset + case
  readonly datasetId: string;
  readonly fixedConditions: VerificationDataset;
  readonly perPath: Readonly<Record<RenderPathId, {
    readonly stats: FrameStatistics;
    readonly geometry: { triangles: number; tilesDrawn: number; drawCalls: number };
  }>>;
  /** 声明的跨路径统计等价区间（FR-008 的"声明的容差"落在这里） */
  readonly declaredBands: Readonly<Record<string, { min: number; max: number }>>;
  /** 无法消除的差异（亚像素边缘、MSAA 解析、sRGB 处理、深度表示）——必须显式列出 */
  readonly declaredDifferences: readonly string[];
  readonly verdict: "pass" | "fail";
}

规则：
- **每个路径各自一份参考帧**（`reference-frames/<datasetId>/<caseId>.<path>.png`）：
  路径内回归用像素对比（阻断）。**禁止**把另一条路径的画面当作参考帧做逐像素比较——
  两条路径的光栅化器、着色器编译器（ANGLE/GLSL vs Tint/SPIR-V）、MSAA 解析与 sRGB 处理路径均不同
  （已核实，见 research.md §7）；跨路径等价改用 `CrossPathEquivalenceRecord` 的**统计量**判定。
- 参考帧**必须**由固定数据集在固定条件下生成，并记录生成时的路径、后端、浏览器版本与 GPU 标注
  （软件光栅化下生成的参考帧必须显式标注 `degraded: true`，`→ FR-023`）；Playwright/Chromium 版本升级
  必须重新生成参考帧并在提交信息中说明（`→ US3-AS3`）。
- 几何类缺陷断言（`→ FR-016`）：
  - 覆盖率突变：相邻两帧 `nonBackgroundRatio` 变化 > 5% 且相机未变 → 失败；
  - 深度不连续处像素比例：`depthStats` 中相邻像素深度差 > 阈值的像素占比超出区间 → 失败；
  - 异常顶点：`TileGeometry` 中 `|height| > 9_000m` 或非有限值计数必须为 0。

---

## 7. 基准记录（Benchmark Record）

`→ FR-017…FR-020；constitution 原则 IV`

```ts
export interface BenchmarkRecord {
  readonly schemaVersion: 1;
  readonly commit: string;
  readonly timestamp: string;
  readonly path: RenderPathId;
  readonly datasetId: string;
  readonly cameraId: string;
  readonly scene: { viewport: [number, number]; pixelRatio: number; requestRenderMode: boolean; msaaSamples: number };
  readonly environment: BenchmarkEnvironment;
  readonly warmupFrames: number;
  readonly sampleFrames: number;
  readonly frameTimeMs: { p50: number; p95: number; min: number; max: number };
  readonly drawCalls: number;
  readonly gpuResourceBytes: number;
  readonly triangles: number;
  readonly degraded: boolean;
  readonly degradationNotes?: string;   // → FR-023：降级方式与盲区
  readonly thresholds: BenchmarkThresholds;
  readonly passed: boolean;
}

export interface BenchmarkEnvironment {
  readonly os: string; readonly browser: string; readonly browserVersion: string;
  readonly gpuVendor: string; readonly gpuDevice: string; readonly gpuArchitecture: string;
  readonly adapterType: "cpu" | "integrated-gpu" | "discrete-gpu" | "unknown"; // 软件适配器为 "cpu"
  readonly backend: string;      // 例 "vulkan" / "opengl"（Dawn 后端类型）
  readonly software: boolean;    // 是否软件光栅化（lavapipe / SwiftShader 等）
  readonly headless: boolean;    // CI 中为 false（headed + Xvfb，见 research.md §7）
  readonly browserFlags: readonly string[]; // 完整标志列表，随记录归档
}

export interface BenchmarkThresholds {
  readonly frameTimeRegressionPct: number;   // 例 10（超过即失败）
  readonly gpuBytesRegressionPct: number;    // 例 15
  readonly drawCallsRegressionPct: number;   // 例 10
  readonly source: string;                   // 阈值来源与批准记录（→ FR-018：变更需记录理由与影响）
}
```
- 基线取同一 `environment` 指纹下的最近一次通过记录；环境指纹变化（换 GPU、换浏览器大版本、
  切换软件光栅化）必须重新建立基线并在记录中标注，避免跨环境误判（`→ FR-018/FR-023`）。
- 记录以 JSON 数组追加存档为 CI 产物，形成历史序列（`→ FR-020`）。

---

## 8. MVP 评估结论（MVP Estimate）

`→ FR-026…FR-029, SC-007；spec Key Entities: MVP 评估结论`

机器可校验的 schema 见 [`contracts/mvp-estimate.schema.json`](./contracts/mvp-estimate.schema.json)，
人类可读结论见 [`mvp-estimate.md`](./mvp-estimate.md)。

```ts
export interface MvpEstimate {
  readonly schemaVersion: 1;
  readonly milestone: string;            // "地形渲染跑通（WebGPU 路径 + 兜底路径 + 可验证 + 基准）"
  readonly version: string;              // 语义化版本，随仓库版本化发布（→ FR-028）
  readonly createdAt: string;
  readonly currency: { primary: "CNY"; secondary: "USD"; fxRate: number; fxSource: string; fxDate: string };
  readonly meteringBasis: {
    readonly includesHumanCost: false;   // MUST 为 false，且结论中显式声明（→ FR-027）
    readonly statement: string;          // "仅计 AI/Agent 消耗：模型 token（输入/输出分别计量）+ 算力费用；人工成本不计入"
    readonly tokenMetering: "input-output-separate";
    readonly priceSources: readonly { item: string; unitPrice: number; unit: string; currency: string; source: string; consultedAt: string }[];
    readonly includesCiCompute: boolean;
    readonly includesCloudGpu: boolean;
    readonly executionEnvironment: string;  // 执行方式与并行度假设（→ spec Assumptions）
  };
  readonly workflows: readonly {
    readonly id: string; readonly name: string;
    readonly timeDays: { min: number; max: number };
    readonly tokens: { inputM: { min: number; max: number }; outputM: { min: number; max: number } };
    readonly modelCost: { cny: { min: number; max: number }; usd: { min: number; max: number } };
    readonly computeCost: { cny: { min: number; max: number }; usd: { min: number; max: number } };
    readonly assumptions: readonly string[];
  }[];
  readonly totals: {
    readonly timeDays: { min: number; max: number };
    readonly tokens: { inputM: { min: number; max: number }; outputM: { min: number; max: number } };
    readonly cost: { cny: { min: number; max: number }; usd: { min: number; max: number } };
  };
  readonly confirmedItems: readonly string[];   // → FR-029
  readonly unconfirmedItems: readonly { item: string; impactDirection: "up" | "down" | "both"; impactMagnitude: string; note: string }[];
  readonly exclusions: readonly string[];       // 例：凭据类地形服务（已后置，MUST NOT 计入，→ FR-029）
  readonly revisionPolicy: string;              // 触发修订的条件（→ spec Assumptions「估算结论的时效」）
}
```

**机器可校验断言**（对应 SC-007，作为 CI 的文档契约测试）：
1. `meteringBasis.includesHumanCost === false` 且 `statement` 含"人工成本不计入"字样；
2. `currency.primary === "CNY"` 且同时存在 `usd` 数值；
3. `totals.timeDays.min > 0 && totals.timeDays.max >= min`；
4. `workflows` 至少覆盖 5 个工作流：渲染管线与地形绘制 / 双路径能力探测与兜底 / 验证资产与测试基建 /
   CI 与基准基建 / 开源交付与文档（`→ FR-026`）；
5. 每个 `priceSources` 条目必须有 `source`（URL）与 `consultedAt`（`→ FR-027`：单价来源必须写明）；
6. `unconfirmedItems` 非空时，每项必须给出 `impactDirection` 与 `impactMagnitude`（`→ FR-029`）；
7. 每个工作流的 `modelCost` 必须能由 `tokens` × `priceSources` 复算（允许 ≤ 1% 舍入误差）——
   保证"结论数字可追溯"，避免出现无来源的金额。

---

## 9. 边界断言（架构测试用）

`→ FR-007, constitution 原则 I/II`

| 断言 | 检查方式 | 违反后果 |
|---|---|---|
| A1 上层 API 不引用后端类型 | `src/api/**` 的 import 图不得包含 `src/backends/**`；`api` 的 `.d.ts` 文本不得匹配 `/GPU[A-Z]|WebGL2RenderingContext|navigator\.gpu/` | 构建失败 |
| A2 后端之间互不引用 | `src/backends/webgl2/**` 与 `src/backends/webgpu/**` 的 import 图交集为空 | 构建失败 |
| A3 上游耦合收敛于 adapter 层 | 仅 `src/adapters/cesium/**` 允许 `from "cesium"`；其他目录出现即失败 | 构建失败 |
| A4 不使用非公开 API | 对 `src/**` 静态扫描：禁止 `from "cesium"` 后访问 `\._[a-zA-Z]`；禁止 import 上游 `Source/**` 深路径（只允许包入口 `cesium`） | 构建失败 |
| A5 演示应用无路径分支 | 演示应用 `apps/demo/src/**` 只 import 包入口；不得出现 `"webgpu"`/`"webgl2"` 字面量作为行为分支（只允许作为配置值传入） | 构建失败 |

A4 的依据：本阶段已核实 `TerrainData.createMesh` / `TerrainMesh` / `TerrainEncoding` /
`GlobeSurfaceTileProvider` / `QuadtreePrimitive` / `Scene.context` / `Scene.pixelRatio` 均为上游 `@private`
（详见 research.md §1 证据表），因此这些符号在代码中**出现即视为违规**。
