# Research: WebGPU 地形渲染 MVP（CesiumJS 1.145.0 外部模块）

**Feature**: `001-webgpu-terrain-mvp` | **Date**: 2026-09-18 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

本文件回答"怎么落地"，并对每个涉及上游 API 的结论给出**证据**。全文严格区分：

- **已核实**：直接读取 `@cesium/engine@26.3.0`（`cesium@1.145.0` 的依赖，实测 `cesium@1.145.0` 依赖 `@cesium/engine@^26.3.0`）解包源码 / 官方文档 / 官方计费页面得到，附文件与行号或 URL。
- **待验证假设（H-n）**：尚未被证据支持，给出**验证方法**与**失败时的退路**，集中在 §8。

## 0. 方法与证据标准

**公开性判据**（本文件统一使用）：
CesiumJS 官方参考文档（ref-doc）由源码 JSDoc 生成并**过滤 `@private` / `@experimental`**。因此本文件将
"类或成员带有 `@alias`/`@memberof X.prototype` 且无 `@private`/`@experimental`" 判定为**公开 API**，
其余判定为**非公开**。注意：`@cesium/engine` 的包入口会导出全部模块（含 `Context`、`DrawCommand` 等
`@private` 类），所以"能被 import" **不等于**"是公开 API"——本项目的允许清单以 JSDoc 标记为准。

**已执行的核实命令**（临时目录执行，未污染仓库；用后清理见 §11）：
```powershell
npm pack @cesium/engine@26.3.0   # → cesium-engine-26.3.0.tgz（含 Source/ 解包源码，1886 个文件）
npm pack cesium@1.145.0          # → cesium-1.145.0.tgz（Source/Cesium.d.ts 类型入口）
```
`cesium@1.145.0` 的 `package.json`：`engines.node >= 22.0.0`、`module: ./Source/Cesium.js`、
`types: ./Source/Cesium.d.ts`（已核实）。

---

## 1. 上游公开 API 证据表（本项目最硬的约束）

### 1.1 公开（允许使用）

| 类 / 成员 | 证据（文件:行） | 本项目用途 |
|---|---|---|
| `CesiumWidget`（`scene`/`canvas`/`resolutionScale`/`useBrowserRecommendedResolution`/`terrainProvider`/`resize`） | `Widget/CesiumWidget.js` 各成员 JSDoc 均无 `@private`；构造选项文档 148–175 行 | 创建上游场景（兜底路径与承载调度的宿主） |
| `CesiumWidget` 自建 canvas | `CesiumWidget.js:221` `container.appendChild(element)`、`:223` `document.createElement("canvas")` | **不接受外部 canvas** → 双画布分层必须在容器内追加第二个 canvas |
| `Scene.camera` / `globe` / `canvas` / `drawingBufferWidth` / `drawingBufferHeight` / `primitives` / `screenSpaceCameraController` | `Scene/Scene.js:1038`/`992`/`830`/`860`/`845`/`1012`/`1123` | 读相机、接管容器尺寸、单例场景控制 |
| `Scene.preRender` / `postRender` / `renderError` | `Scene.js:1344`/`1363`/`1324` | 渲染循环钩子（见 §3） |
| `Scene.requestRender()` / `requestRenderMode` | `Scene.js:4734`/`683` 文档 | 维持请求式渲染循环 |
| `Scene.backgroundColor` / `skyBox` / `skyAtmosphere` / `msaaSamples`（默认 4，文档 `CesiumWidget.js:175`） | `Scene.js` 各属性 JSDoc 无 `@private` | 画面构成与两路径一致性 |
| `Globe.show` / `baseColor` / `terrainProvider` / `tilesLoaded` / `tileLoadProgressEvent` / `translucency` / `ellipsoid` / `imageryLayers` / `enableLighting` / `maximumScreenSpaceError` / `tileCacheSize` / `depthTestAgainstTerrain` / `showSkirts` / `cartographicLimitRectangle` / `clippingPlanes` | `Scene/Globe.js:85-91`(show)、`439`(baseColor)、`518`(terrainProvider)、`422`(tilesLoaded)、`564`(tileLoadProgressEvent)、`651`(translucency)、`388`(ellipsoid)、`398`、`166`(enableLighting) | 抑制上游地形可见性、读取加载进度、驱动连通性 |
| `Camera.viewMatrix` / `frustum` / `positionWC` / `directionWC` / `upWC` / `rightWC` / `positionCartographic` / `setView` / `flyTo` | `Scene/Camera.js:891`(viewMatrix，getter 内调 `updateMembers`)、`:159-160`(frustum 文档)、`938`/`952`/`966`/`980` | 相机与矩阵来源 |
| `PerspectiveFrustum`（类 + `projectionMatrix` / `fov` / `aspectRatio` / `near` / `far`） | `Core/PerspectiveFrustum.js:14-15`(类)、`:237`(projectionMatrix) | 投影矩阵来源 |
| `TerrainProvider`（类）及成员 `errorEvent` / `credit` / `tilingScheme` / `hasWaterMask` / `hasVertexNormals` / `availability` / `requestTileGeometry` / `getLevelMaximumGeometricError` / `getTileDataAvailable` / `loadTileDataAvailability` | `Core/TerrainProvider.js:11-23`(类)、`25-86`(属性)、`:527-541`(requestTileGeometry)、`:547-551`、`:555-563`、`:567-575` | **自定义地形数据源的公开扩展点** |
| `HeightmapTerrainData`（类 + 构造选项，含文档示例） | `Core/HeightmapTerrainData.js:23-95` 全部公开；`createMesh` 之外的方法公开 | 由本层构造、交给上游渲染（兜底路径） |
| `QuantizedMeshTerrainData`（类 + 构造选项，含文档示例） | `Core/QuantizedMeshTerrainData.js:24-93` 全部公开 | 同上（若采用 quantized-mesh 数据源） |
| `TileProviderError` | `Core/TileProviderError.js:7-8` | 数据源错误上报（区分"数据不可用"与"渲染失败"） |
| `TileAvailability` / `GeographicTilingScheme` / `WebMercatorTilingScheme` / `EllipsoidTerrainProvider` / `Ellipsoid` / `Rectangle` / `Cartographic` / `Credit` / `Resource` / `BoundingSphere` / `Matrix4` / `Color` / `Event` | 各文件类级 JSDoc 无 `@private`；`cesium@1.145.0/Source/Cesium.d.ts` 均以 `export class` 导出（逐一核对通过） | 数据源与几何计算的基础类型 |
| `GlobeTranslucency` | `Scene/GlobeTranslucency.js:13-14` | 备选的地形隐藏手段（见 §2） |

### 1.2 非公开（**禁止使用**，已列入代码扫描黑名单）

| 符号 | 证据（文件:行） | 影响 |
|---|---|---|
| `TerrainData.prototype.createMesh` | `Core/TerrainData.js:73`(`@private`)、`:87`(抛 `throwInstantiationError`) | **不能自行构建/实现网格**，网格构建必须由上游调用 `HeightmapTerrainData`/`QuantizedMeshTerrainData` 的实现完成 |
| `QuantizedMeshTerrainData.prototype.createMesh` | `Core/QuantizedMeshTerrainData.js:250`(`@private`)、`:264`（签名已改为 `options` 对象：`{tilingScheme,x,y,level,exaggeration,exaggerationRelativeHeight,throttle}`） | 同上；且不能调用上游实现把数据转成网格 |
| `HeightmapTerrainData.prototype.createMesh` / `_createMeshSync` | `Core/HeightmapTerrainData.js:182`/`:196`、`:313`/`:315` | 同上 |
| `TerrainMesh` | `Core/TerrainMesh.js:43`(`@private`)、`:45` | 无法构造上游网格对象 → **WebGPU 几何必须自建** |
| `TerrainEncoding` | `Core/TerrainEncoding.js:38`(`@private`)、`:40` | 无法复用上游顶点编码 → 自建顶点布局（WGSL 自定义） |
| `GlobeSurfaceTileProvider` | `Scene/GlobeSurfaceTileProvider.js:1391`(`@private`) | 无法取得瓦片提供者实例 |
| `GlobeSurfaceTile` | `Scene/GlobeSurfaceTile.js`（类级 `@private`） | 无法读取瓦片渲染态 |
| `QuadtreePrimitive` | `Scene/QuadtreePrimitive.js:42`(`@private`) | 无法取得四叉树（`globe._surface`） |
| `QuadtreeTile` | `Scene/QuadtreeTile.js`（类级 `@private`） | 无法枚举瓦片对象 |
| `Scene.context` | `Scene.js:1388`(`@private`) | 无法取得上游 WebGL2 上下文 → 无法把上游渲染结果交给外部合成 |
| `Scene.pixelRatio` | `Scene.js:1734`(`@private`) | 需自行用 `drawingBufferWidth/Height ÷ canvas.clientWidth/Height` 推导 |
| `Scene.frameState` | `Scene.js:1168`(`@private`) | 无法读取帧状态对象 |
| `Context`（`Renderer/Context.js`） | `Renderer/Context.js:36`(`@private`) | 无法直接操作上游 GL 上下文 |
| **`DrawCommand`**（`Renderer/DrawCommand.js`） | 类级 `@private`（ref-doc 不收录；`@cesium/engine` 包入口仍可 import —— "能被 import"不等于"公开"） | **无法**读取/反推本帧绘制命令；G-2 的旧退路 V2 因此被删除（§4.3） |
| **`FrameState`**（`Renderer/FrameState.js`） | 类级 `@private`（同上） | **无法**读取 `frameState.commandList`；任何"扫描命令列表"的方案均为违规 |

> **注（本轮新增）**：`DrawCommand` 与 `FrameState` 是**不带下划线前缀**的 `@private` 类。原 A4 规则（只匹配
> `from "cesium"` 之后的 `\._[a-zA-Z]`）**抓不到** `import { DrawCommand } from "cesium"` 这种命名导入，
> 因此 A4 已强化为「对 `from "cesium"` / `from "@cesium/*"` 的**所有命名导入**与**命名空间成员访问**逐一比对
> `public-api-allowlist.ts` 白名单，白名单外一律违规」（见 `data-model.md` §9 与 `tasks.md` T015/T024/T025）。

**结论（决定架构）**：上游没有任何公开的"渲染委托"扩展点；**WebGPU 几何必须由本项目自建**，
唯一合法的地形数据注入点是"子类化 `TerrainProvider` 并返回公开的 `HeightmapTerrainData` /
`QuantizedMeshTerrainData` 实例"。因此 spec Assumptions 中"复用上游地形加载与调度"的**收敛解释**是：
复用上游的四叉树调度、LOD 选择、可用性判定、请求预算、内存管理与相机模型，
而**瓦片的字节获取与解码、GPU 几何构建、绘制提交**属于本增量新增内容。

### 1.3 渲染循环的真实调用顺序（已核实，逐行）

`Scene.prototype.render`（`Scene.js:4621`）：

```text
4627  _preUpdate.raiseEvent()                     // 帧前
4677  prePassesUpdate()                           // 4499: scene.globe.update(frameState) → Globe.update
4691  _postUpdate.raiseEvent()
4694  _preRender.raiseEvent()      ← preRender 事件；此刻本帧帧状态尚未更新
4696  render(scene)
        4528  scene.updateFrameState()            // 更新 frameState
        4462  this.camera.update(this._mode)      // ← 相机/矩阵在这一步才更新
        4582  scene.updateEnvironment()
        4583  scene.updateAndExecuteCommands(...) // 3933: _primitives.update()；3951: _globe.render()
        4590  scene.globe.endFrame(frameState)    // → QuadtreePrimitive.endFrame → processTileLoadQueue（真正加载瓦片）
        4592  if (!scene.globe.tilesLoaded) scene._renderRequested = true   // 加载期间自动续帧
4708  callAfterRenderFunctions()
4711  _postRender.raiseEvent()     ← postRender 事件；本帧矩阵已是终值，且浏览器尚未合成
```

**结论**：读取"本帧"的 `camera.viewMatrix` / `frustum.projectionMatrix` **必须在 `postRender`**；
在 `preRender` 读到的是上一帧状态（本帧的 `updateFrameState`/`camera.update` 尚未发生）。
在 `postRender` 中提交 WebGPU 工作，与上游 WebGL2 绘制处于同一个 `requestAnimationFrame` 任务内，
浏览器在任务结束后统一合成两块画布 → **两画布天然同帧**。

### 1.4 `globe.show = false` 会同时停掉瓦片调度（已核实，直接否决了一条候选方案）

```text
Globe.js:979  Globe.prototype.update   = function (frameState) { if (!this.show) { return; } ... this._surface.update(frameState); }
Globe.js:1086 Globe.prototype.render   = function (frameState) { if (!this.show) { return; } ... this._surface.render(frameState); }
Globe.js:1101 Globe.prototype.endFrame = function (frameState) { if (!this.show) { return; } ... this._surface.endFrame(frameState); }
```
`QuadtreePrimitive.prototype.endFrame`（`QuadtreePrimitive.js:435`）才调用 `processTileLoadQueue`（进程瓦片加载队列）。
因此 `globe.show = false` ⇒ **瓦片永不加载** ⇒ 不能作为"只隐藏地形、保留调度"的手段。

---

## 2. 决策 D1：画布与上下文归属（全项目最大的架构风险点）

**问题**：CesiumJS 在 canvas 上创建 WebGL2 上下文，而一个 canvas 只能有一种上下文类型。
WebGPU 与 Cesium 的 WebGL2 如何共存？

### 候选方案对比

| 候选 | 可行性 | 代价 | 结论 |
|---|---|---|---|
| **A. 独立画布分层**（上游 WebGL2 画布在下、本库 WebGPU 画布在上） | ✔ 可行：`CesiumWidget` 自建 canvas 并 append 到容器（`CesiumWidget.js:221-223`），我们在同一容器追加第二个 canvas 即可；两块画布互不感知 | 每帧多一次全屏合成；两块画布各自有独立深度缓冲（本项目只需地形深度，无跨画布深度互操作需求） | **选定** |
| **B. `context.configure()` 接管上游画布** | ✗ 不可行：WebGPU 规范规定同一 canvas 已用其它类型初始化时 `getContext("webgpu")` 返回 `null`；且上游不允许外部替换其上下文（`Scene.context` 为 `@private`，`Scene.js:1388`） | — | 否决 |
| **C. 离屏渲染后合成**（WebGPU 渲染到纹理/离屏画布，再拷进上游画布的合成链） | ✗ 需取得上游 GL 上下文或帧缓冲（`Scene.context` `@private`） | 每帧全画面回读/上传，延迟与带宽代价高；且依赖非公开 API（违反原则 I） | 否决 |
| **D. `OffscreenCanvas` 反向合成**（上游渲染到离屏，我们再合成） | ✗ 上游不支持把 canvas 注入 `CesiumWidget`（自建 canvas，无该选项）；且 `CesiumWidget` 每帧用 `canvas.clientWidth/clientHeight` 重设尺寸（`CesiumWidget.js:103-116`） | — | 否决 |

### 选定方案：双画布分层（并附带解决"上游地形仍会被绘制"的问题）

```text
容器 (container, position: relative)
├── canvas A  ← CesiumWidget 自建；WebGL2；contextOptions.webgl.alpha = true；在下层
└── canvas B  ← 本库自建；WebGPU；alphaMode: "premultiplied"；透明处露出 canvas A 的天空/背景；在上层
```

**关键点 1：让上游的地形绘制不可见，但保留全部调度**
`Globe.baseColor = Color.TRANSPARENT`（`Globe.js:439` 公开属性）+ canvas A 的 `alpha: true`
（`Renderer/Context.js:55` 默认 `alpha=false`；`Context.js:448-451` 明确写明"要与其它 HTML 元素做
alpha 合成，把 alpha 设为 true"）。此时上游仍照常调度、构建网格、提交绘制，但地形片元输出 alpha=0，
在画布预乘合成下不可见，画面只剩天空/背景，由 canvas B 的地形覆盖其上。

**关键点 2：必须度量的代价**
上游对地形的那一次绘制**依然发生**（顶点处理 + 填充），这是本方案的已知代价。
处理方式（不允许掩盖）：基准中用一次"`globe.show=false` 的诊断运行"做差分归因，把该开销单独量化并写入基准报告；
MVP **不得**据此宣称性能收益（符合 spec Assumptions「性能期望」）。
后续增量可向上游提议一个公开的"地形渲染委托"扩展点来消除该开销。

**被否决的替代手段**：
- `globe.show = false` → 会停掉瓦片加载（§1.4，已核实）。
- `globe.translucency`（`Globe.js:651` 公开）设 `frontFaceAlpha = 0`：可行但会把 globe 移入半透明通道、
  改变渲染状态与排序语义，代价高于 `baseColor` 方案；**保留为 fallback**（若 `baseColor` 方案在 H-1 验证中失败）。
- 让 canvas B 不透明并完全覆盖 canvas A：会丢失上游渲染的天空/大气（MVP 不需要自制天空），不可接受。

---

## 3. 决策 D2：渲染循环接管点

**问题**：如何在不改上游的前提下，让 WebGPU 提交发生在 Cesium 的渲染循环中？

| 候选 | 评估 |
|---|---|
| **`scene.postRender` 订阅（选定）** | 公开事件（`Scene.js:1363`）；在本帧 `render()` 完成之后、浏览器合成之前触发（§1.3 已核实顺序）；此时相机矩阵为本帧终值；不需要 `requestAnimationFrame` 自建循环 |
| `scene.preRender` | 公开，但**本帧帧状态尚未更新**（`updateFrameState`/`camera.update` 在 `render()` 内、`preRender` 之后执行）→ 只能拿到上一帧矩阵，会导致相机与地形错位一帧 |
| monkey-patch `Scene.prototype.render` | 技术上可行但**改变上游运行时行为**、与原则 I 精神冲突，且上游升级极易失效 → 否决 |
| 自建 `requestAnimationFrame` 循环 | 与上游帧不同步（双重渲染、相机滞后、基准不可比）→ 否决 |
| 自实现 `Primitive` 并放入 `scene.primitives`（`Primitive.prototype.update(frameState)` 作为钩子） | **已否决**：钩子本身公开，但其唯一价值是读取 `frameState.commandList`（`FrameState` 为 `@private`，§1.2）并按 `DrawCommand.owner` 反推瓦片 —— 属原则 I 禁止的非公开依赖。曾作为"备选观察手段 V2"保留，**本轮已删除**（见 §4.3 与 §8 的 H-2） |

**请求式渲染**：`requestRenderMode` 下除 `scene.requestRender()`（公开）外，上游在 `!globe.tilesLoaded`
时自动置 `_renderRequested = true`（`Scene.js:4592`），因此加载期间循环自保持；MVP 默认
`requestRenderMode = false`（连续渲染）以便基准采集，同时支持开启以验证该路径。

---

## 4. 决策 D3：地形瓦片的获取与复用

**问题**：如何复用上游 `TerrainProvider` / `Globe` / 瓦片调度取得地形数据，而不重新实现空间索引？

### 4.1 唯一合法的注入点（已核实）

`TerrainProvider` 是公开类，且 `requestTileGeometry(x, y, level, request)`、`getTileDataAvailable`、
`availability`、`tilingScheme`、`errorEvent`、`ready`、`hasVertexNormals`、`getLevelMaximumGeometricError`
全部公开（§1.1）。上游消费我们返回的对象：

```text
GlobeSurfaceTile.js:996-1027 (transform)
  const tilingScheme = terrainProvider.tilingScheme;
  createMeshOptions = { tilingScheme, x, y, level, exaggeration, exaggerationRelativeHeight, throttle: true };
  const meshPromise = terrainData.createMesh(createMeshOptions);   // ← 由上游调用；实现属于上游
```

即：**我们只提供公开数据对象，网格构建由上游完成**（兜底路径），而 WebGPU 端从**同一份输入数据**
自建顶点/索引（因为 `TerrainMesh`/`TerrainEncoding` 是 `@private`，见 §1.2）。

### 4.2 数据流（两条路径共用同一份数据，保证 FR-008 的等价性）

```text
                     ┌──────────────────────── 数据源适配层（本层）────────────────────────┐
公开 Terrarium/高程瓦片 ──解码──▶ HeightField（Uint16 高程网格 + 元数据，唯一真值）
本地固定数据集（同源字节）──┘                    │
                                                ├─▶ 上游：new HeightmapTerrainData({buffer,...})  → 上游四叉树调度/建网格/绘制（兜底路径）
                                                └─▶ WebGPU：自建顶点/索引/裙边（core/geometry.ts）→ WebGPU 管线绘制（新路径）
```
**规则**：`HeightField` 是唯一几何来源，两条路径不得各自解码一次（contracts/terrain-source.md T-7）。

### 4.3 逐帧"可见瓦片集合"如何取得（**待验证假设 H-2**）

上游**不公开**当前帧的绘制瓦片集合（唯一使用点是 `Globe.js:746` 的 `@private` 方法
`pickWorldCoordinates`，访问 `_surface._tilesRenderedThisFrame`）。本层方案：

1. **resident 集合**：本层知道上游向自己要过哪些瓦片（`requestTileGeometry` 的调用即调度信号）；
2. **视锥裁剪**：用瓦片的 `rectangle` + `BoundingSphere` 与本帧视锥求交（本层计算，几何数据本层已有）；
3. **截断规则**：若某瓦片 4 个子瓦片全部 `resident`，则不绘制该父瓦片（上游只在判定父级精度不足时才请求子瓦片，
   因此 resident 集合的"叶子"即上游的绘制截断）；否则绘制父瓦片（对应上游在子瓦片加载期间的父级回退绘制）；
4. **静止态等价**：`globe.tilesLoaded === true` 时，resident 集合即上游的理想截断 → 验证用例在此时采集（FR-012 要求固定条件）。

**验证方法（G-2，**仅用公开 API**）**：固定相机 + `globe.tilesLoaded === true` 后，比较
(a) 本层规则集合（`computeDrawSet`）与 (b) 上游可观察信号：(1) `globe.tileLoadProgressEvent` 的请求/加载计数序列、
(2) `Scene.globe.tilesLoaded`、(3) `Scene.postRender` 帧计数、(4) 经**平台 API 包装**（`WebGL2RenderingContext.prototype.drawElements/drawArrays`，§5.3）
得到的本帧绘制批次数与顶点数、(5) 像素统计（`nonBackgroundRatio`、`uniqueColorCount`、帧间像素稳定性）；
两侧统计必须落在**声明的等价区间**内。**若差异超出声明区间 → 判定为不等价 → 回到 `plan.md` 修订**，
给出仅用公开 API 的新方案（不得改判据范围来"凑通过"）。

**退路 V2 已删除（本轮变更）**：原退路为「在 `scene.primitives` 中加入自实现 `Primitive`，在 `update(frameState)` 中扫描
`frameState.commandList`，按 `DrawCommand` 的公开字段反推瓦片」。该退路依赖 `FrameState` / `DrawCommand` —— 二者均为上游
**`@private`**（§1.2），违反 constitution 原则 I（NON-NEGOTIABLE），且原 A4 扫描规则无法捕获不带下划线的命名导入。
**因此 V2 从本项目的退路清单中移除**；`DrawCommand`/`FrameState` 已列入 §1.2 黑名单与 `public-api-allowlist.ts` 数组，
A4 亦已强化为"逐一比对白名单"。删除的代价是 G-2 的交叉验证手段变弱（无法直接读上游绘制集合），
由**统计区间断言**（几何 ±10% / 覆盖率 ±5%，T061）与该门禁"不等价即回到 plan 修订"的语义补偿（登记于 `plan.md` Complexity Tracking 第 5 行）。

**被否决的替代**：
- 直接使用上游 `CesiumTerrainProvider`：其返回的 `QuantizedMeshTerrainData` 几何无法通过公开 API 取出
  （`createMesh`/`TerrainMesh`/`TerrainEncoding` 均 `@private`）→ 新路径将没有几何来源；
- 调用 `@private` 的 `createMesh` 或访问 `globe._surface`：违反 constitution 原则 I（NON-NEGOTIABLE）；
- 扫描 `frameState.commandList` / 依赖 `DrawCommand.owner`（原退路 V2）：同为 `@private` 依赖，**本轮显式删除**；
- 自研空间索引/LOD：违反 spec Assumptions。

---

## 5. 决策 D4 / D7：相机、矩阵、深度范围与指标口径

### 5.1 相机与矩阵（已核实）

- `camera.viewMatrix`（`Camera.js:891`）是公开 getter，内部调用 `updateMembers(this)`，取到的是与当前
  相机状态一致的世界→视图矩阵；`camera.frustum`（`:159-160`）公开，3D 模式下是 `PerspectiveFrustum`。
- `PerspectiveFrustum.projectionMatrix`（`PerspectiveFrustum.js:237`）公开，委托给 `_offCenterFrustum`。
- **不得**读 `scene.pixelRatio`（`@private`）：改用 `scene.drawingBufferWidth / drawingBufferHeight`
  （公开）与 `scene.canvas.clientWidth / clientHeight` 推导像素比，并在验证中与实际视口断言一致。

### 5.2 深度范围差异（GL → WebGPU）

Cesium 的投影矩阵沿用 OpenGL 约定（裁剪空间 z ∈ [-1, 1]），WebGPU 的 NDC z ∈ [0, 1]。
因此 WebGPU 端必须先乘一个深度范围修正矩阵（`z' = 0.5·z + 0.5·w`，等价于 `z_ndc` 的仿射重映射），
再使用 Cesium 的 `projectionMatrix`。除深度外不需要 y 翻转（WebGPU 的 NDC y 向上与 GL 一致），
视口按整块画布显式设置。**几何正确性由视觉/统计断言复核**（H-3 的一部分）。

### 5.3 性能指标口径（constitution 原则 IV / FR-017）

| 指标 | 定义与采集方式 | 备注 |
|---|---|---|
| 帧时间 p50 / p95 | `Scene.postRender` 相邻两次回调的 `performance.now()` 差；固定预热（默认 120 帧）与采样帧数（默认 600 帧，CI 缩减） | 两路径同口径 |
| 绘制批次数 | WebGPU：统计 `GPURenderPassEncoder.drawIndexed()`；WebGL2：验证脚手架包装**平台 API** `WebGL2RenderingContext.prototype.drawElements/drawArrays` 计数 | 包装平台 API 不是修改上游实现，不违反原则 I |
| 图形资源字节数 | 共享 `GpuResourceRegistry`；WebGPU 登记 `createBuffer/createTexture` 字节；WebGL2 包装 `bufferData/texImage2D` 统计上传字节 | **声明为代理指标**（浏览器不暴露真实 VRAM），必须与 `adapterType`/`degraded` 一起解读 |

**不可用**：GPU 时间戳（`timestamp-query`）在软件适配器下不可用，且会使浏览器 Profiler 崩溃（§7），
因此 CI 中不做 GPU 级剖析；绝对性能只在真实 GPU 作业采集。

---

## 6. 决策 D5：免登录地形数据源与离线可复现

**需求**（FR-004 / 依赖段）：MVP 数据源 MUST 免登录、公开可访问，并 MUST 附带本地固定数据集以保证离线与确定性；
CI MUST 在无任何凭据前提下可运行。

### 6.1 候选与核实结果（2026-09-18 实测）

| 候选 | 是否需要令牌 | 结论 | 证据 |
|---|---|---|---|
| **AWS Open Data "Terrain Tiles"**（`elevation-tiles-prod`，Mapzen/Joerd，Linux Foundation 项目） | **不需要**（官方："No AWS account required"） | **选定为公开数据源** | `GET https://s3.amazonaws.com/elevation-tiles-prod/terrarium/0/0/0.png` → **200**，`image/png`，106274 B；`terrarium/10/545/355.png` → **200**，115930 B；`geotiff/*.tif`、`normal/*.png` 同样 200；响应头 **`Access-Control-Allow-Origin: *`**、`Access-Control-Allow-Methods: GET`、`Access-Control-Max-Age: 3000`（带 `Origin` 头发起 GET 与 OPTIONS 预检均实测通过）→ 浏览器可直接取；层级：`0…15` 可用（`15/17441/11377.png` → 200），`z16` → 404；S3 存储桶 ARN `arn:aws:s3:::elevation-tiles-prod`（us-east-1），许可与署名指向 [joerd attribution.md](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) |
| **Re:Earth Terrain**（`terrain.reearth.land/cesium-mesh/ellipsoid`，公开 quantized-mesh） | 不需要 | **端点已核实存在（HTTP/CORS 层面）；但**数据覆盖质量可疑 → 记为"已核实的备选"，MVP 不启用为默认 | 端点：`12/2048/2047.terrain` → **200**，`Content-Type: application/vnd.quantized-mesh`；`layer.json` → **200**，`application/json`，1410 B；响应头 `Access-Control-Allow-Origin: *`、`access-control-allow-methods: GET, HEAD, OPTIONS`（2026-09-18 实测）→ 浏览器可直接取用。**但**区域网格抽样（Matterhorn/Jungfrau/Zugspitze/Everest/Fuji/Colorado，z9–z12）多次只返回 164–782 B 的退化瓦片（`vertexCount=4`、高度≈−25 m），仅 Kilimanjaro 返回真实数据（60–68 KB）→ 覆盖质量**未核实且可疑**，不得作为 MVP 依赖。**许可条款与可再分发范围待确认（H-5b）** |
| Mapterhorn（`tiles.mapterhorn.com/{z}/{x}/{y}.webp`，Terrarium） | 不需要 | 存活、CORS `*`、数据丰富（Matterhorn z9–z14 均 200，150–240 KB），但欧洲以外深层级 404 | 仅记为可选后备；许可为 BSD-3（代码）+ 数据集署名页 |
| ArcGIS World Elevation 3D（`elevation3d.arcgis.com/.../Terrain3D/ImageServer`） | 服务层不需要令牌（`?f=json` → 200；`tile/10/358/537` → 200，CORS `*`，LERC/256px/level 0–16） | **不可用** | Cesium 的 `ArcGISTiledElevationTerrainProvider` 构造函数为 `@private`（`Core/ArcGISTiledElevationTerrainProvider.js:43`，已核实）→ 原则 I 禁止；且 Esri 高程服务条款不构成可再分发许可 |
| Cesium 自建 / 历史 quantized-mesh 端点 | — | **不存在可用端点** | `cesium.com/terrain/1.0/layer.json` → 404；`storage.googleapis.com/cesium-dev/terrain/layer.json` → 404；`assets.agi.com/stk-terrain/...` → 超时；`cesiumjs.org/stk-terrain/...` 与 `/smallterrain/layer.json` → 200 但是 SPA 的 `text/html` 兜底页；`assets.cesium.com` → DNS 不存在；`tiles.stadiamaps.com/terrain/layer.json` → 超时。Cesium 官方示例的全球地形全部需要 ion 令牌 → **spec 的"凭据类服务后置"结论得到验证** |
| Cesium ion / MapTiler / Mapbox / Nextzen | **需要令牌或 key** | spec 明确后置，MUST NOT 成为本增量依赖 | — |

### 6.2 端到端实测（本项目自行解码验证，非文档转述）

用临时脚本（Node 22，`zlib.inflateSync` + PNG 反滤波，**零第三方依赖**）解码真实瓦片，
验证"字节 → 高程"链路与坐标约定：

| 瓦片 | 解码结果 | 判定 |
|---|---|---|
| `10/531/364`（阿尔卑斯，勃朗峰所在瓦片） | 高程 **556.5 – 4773.2 m**，均值 2055.2 m，**极差 4216.7 m**，无 NaN；最高点在像素 (134, 252) → 经度 6.864°E | 经度与**勃朗峰（6.865°E，4808 m）**一致 → 解码公式 `height = R*256 + G + B/256 - 32768` 与 **XYZ（y=0 在北）** 约定均被证实；单瓦片极差 4217 m → 满足 SC-002 的"高程特征可观察"要求 |
| `10/532/364`（相邻瓦片） | 高程 593.4 – 4250.8 m，最高点在像素 (195, 141) → 经度 7.299°E | 与**大孔班山（Grand Combin，4314 m，7.299°E）**一致 → 再次证实坐标与公式 |

结论：公开源**可用、免登录、CORS 开放、坐标系为 XYZ、最大层级 15**；
高程解码需本项目自实现（已核实 `HeightmapEncoding` 仅含 `NONE` 与 `LERC`，
**上游没有内置的 Terrarium 解码器**，因此不存在"上游已能解码"的捷径）。

### 6.3 选定方案

采用**"公开栅格高程源 + 本地固定数据集"**组合，并用上游公开类 `HeightmapTerrainData` 作为注入格式：

- **本地固定数据集（CI 与验收的默认数据源）**：`tools/build-terrain-fixture.mjs` 一次性下载目标区域瓦片并
  解码为 **Uint16 高程场**，落盘为本项目紧凑格式（`manifest.json` + `<level>/<x>/<y>.hgt`，见
  `contracts/terrain-source.md` §3）。**区域与层级**：以勃朗峰/大孔班山为中心、约 **0.6° × 0.5°** 的矩形，
  **z0 – z12**（z12 约 38 m/像素）；按实测瓦片体积（z8 约 66 KB、z10 约 100–116 KB、z11 约 146 KB）估算
  总量 **约 3–6 MB**，远低于 20 MiB 上限，且保证**多瓦片拼接**（z12 下 6×6 以上）与显著高差（>4000 m）。
  随仓库提交 → **CI 全程离线、零外部请求**（由测试断言）。
- **公开在线数据源（演示用，`kind: "public"`）**：浏览器取
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`（XYZ，z0–15，CORS `*`），
  用 `createImageBitmap` + `OffscreenCanvas.getImageData` 解码为高程场，走**同一条** `HeightField → 几何 → 绘制`链路。
- **上游注入**：两种数据源都经本层 `TerrainProvider` 子类返回
  `new HeightmapTerrainData({ buffer, width, height, childTileMask, structure })`（公开类 + 公开构造选项，
  官方文档自带示例，见 `HeightmapTerrainData.js:23-95`）→ 兜底路径由上游完成网格构建与绘制；
  新路径由本层从同一份 `HeightField` 自建顶点/索引/裙边。
- **可用性**：由固定数据集清单决定（打包了哪些层级与矩形），`getTileDataAvailable` 据此回答；
  本层不设计空间索引、不做 LOD 决策（LOD 仍由上游 `Globe.maximumScreenSpaceError` 驱动）。

**为何不用 quantized-mesh 作为首选（已用实测证据定案）**：唯一核实到的免登录 quantized-mesh 端点
（Re:Earth Terrain）在绝大多数据区域返回退化瓦片，**不能作为 MVP 依赖**；其余候选全部 404/超时或需要令牌。
而 `HeightmapTerrainData` 路线不需要解码 Cesium 自有二进制格式、不需要免登录 quantized-mesh 端点，
且两种数据源共用同一份高程真值，几何等价性更容易证明（T-7/T-8）。若后续出现可靠的免登录 quantized-mesh 端点，
可按 `contracts/terrain-source.md` §5 升级为首选，**不改变**上层 API、验证方式与工期量级。

### 6.4 署名与许可（FR-024）

必须随仓库与页面上展示（`Credit`）的署名文本（依据 joerd attribution.md 的"必需署名"清单，
按固定数据集实际包含的数据来源裁剪）：

> Terrain data: Mapzen/Joerd Terrain Tiles（AWS Open Data，`elevation-tiles-prod`）。Contains:
> Europe terrain data produced using Copernicus data and information funded by the European Union – EU-DEM layers;
> Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich;
> United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.
> Attribution requirements: https://github.com/tilezen/joerd/blob/master/docs/attribution.md

要点：该数据集是多个开放数据源的合并（SRTM/3DEP 属公有领域；EU-DEM 为 Copernicus 资助产物；
奥地利 DGM 为 CC BY 3.0 AT；挪威 Kartverket 为 CC BY 4.0），**署名是强制要求**；
`manifest.json` 的 `attribution` 字段与 CI 校验（非空 + 展示到位）实现该要求。

**署名/许可的核实状态**：
- **AWS Open Data Terrain Tiles：已核实**。数据集主页（[registry.opendata.aws/terrain-tiles](https://registry.opendata.aws/terrain-tiles/)，
  2026-09-18 读取）的 `License` 字段指向 [joerd attribution.md](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)，
   [joerd attribution.md](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) 给出了逐来源的必需署名清单与许可证说明（EU-DEM/Copernicus、奥地利 DGM CC BY 3.0 AT、
  Kartverket CC BY 4.0、USGS 3DEP/SRTM/GMTED2010 公有领域、NOAA ETOPO1 等）；
  同时瓦片自带 `x-amz-meta-x-imagery-sources` 头（实测值 `eudem/eudem_dem_5deg_n45e010.tif`）可追溯具体来源文件。
  页面明确："No AWS account required"。→ **可直接用于本项目，条件是附带上述署名**。
- **Re:Earth Terrain：待确认（H-5b）**。其 `layer.json` 内嵌 attribution 字符串
  （`Re:Earth Terrain, Mapterhorn, EGM2008 (NGA), Protomaps, OpenStreetMap`），worker 代码为 MIT，
  但**合并后地形数据的许可条款与可再分发范围尚未核实** → 只作为"已核实的备选端点"记录，
  MVP 默认不启用；若要启用，必须先完成 H-5b 核实并原样附带其署名串。
- **Mapterhorn：部分未核实**（代码 BSD-3；地形数据署名页 `https://mapterhorn.com/attribution` 未读取）。

### 6.5 残余不确定性（不影响方案成立）

| 项 | 状态 | 影响与处置 |
|---|---|---|
| EU 镜像桶（`elevation-tiles-prod-eu`，eu-central-1）的公开 URL 形式 | `https://elevation-tiles-prod-eu.s3.eu-central-1.amazonaws.com/...` → 403（**未核实**） | 只影响演示源的延迟，不影响 CI（CI 用本地数据集）；默认使用 us-east-1 端点 |
| Re:Earth / Mapterhorn 的地形数据许可与覆盖质量 | 见 H-5b（**待确认**） | 二者均**不启用为默认**；默认在线源为 AWS Terrarium（许可已核实） |
| 数据源长期可用性（第三方 S3 桶，数据自 2017 年静态） | 无法核实 SLA；实测偶发传输超时 | 固定数据集已随仓库提交，**CI 不依赖该服务**；在线源不可用时表现为"数据不可用"的可观察状态（T-5/T-11） |
| 固定数据集的字节级精确体积 | 由抽样瓦片体积估算（3–6 MB） | 生成脚本产出后以实际值写入 `manifest.totalBytes`；上限 20 MiB 有充分余量 |

---

## 7. 决策 D6 / D8：CI 降级、跨路径可比较性与验证设计

### 7.1 无 GPU 的托管 CI 上如何跑 WebGPU（已核实的配方）

**结论：headless 下 WebGPU 可以渲染，但画布呈现不可靠（截图全黑）；必须改用 Xvfb + headed 浏览器。**
Chromium 的适配器选择逻辑（`gpu/command_buffer/service/webgpu_decoder_impl.cc`）给出硬性要求：

- `--enable-unsafe-webgpu` **必需**：CPU 适配器（SwiftShader/lavapipe）只有在 safety level 为 unsafe 时才允许加载
  （源码注释原文："The fallback adapter is SwiftShader, which is only allowed with `--enable-unsafe-webgpu`."），
  且 `gpu/config/webgpu_blocklist_impl.cc` 会无条件屏蔽所有 `AdapterType::CPU` 适配器。
- `--enable-features=Vulkan` 在 Linux **必需**：否则 GPU 进程的 `backend_types = {Null}`，`requestAdapter()` 返回 `null`。
- `--disable-vulkan-surface` **必须不用**：它会让 WebGPU 画布呈现彻底失效（官方配方原话：只在不向画布绘制时可用）。
- `--enable-unsafe-swiftshader` 与 `--use-angle=swiftshader` **只对 WebGL 生效**，对 WebGPU 无作用（常见误解）。
- `--enable-features=...,UseSkiaRenderer` 已废弃；`--headless=new` 是 Playwright/Puppeteer 默认值，重复传入无益。
- `--use-vulkan=swiftshader` 依赖构建开关 `enable_swiftshader_vulkan`，官方 Chrome 是否随附该 ICD **未能确证** → 改用 lavapipe 规避。

**选定配方**（与 three.js 生产 CI 一致；证据：three.js `.github/workflows/ci.yml`、`test/e2e/puppeteer.js`、
PR #33346 "E2E: Replace SwiftShader with software Dawn (Lavapipe)"）：

| | WebGL2（兜底路径） | WebGPU（新路径） |
|---|---|---|
| 系统包 | `mesa-vulkan-drivers xvfb libvulkan1`（免费） | 同左 |
| 运行方式 | `xvfb-run -a` + `headless: false` | 同左 |
| 环境变量 | `LIBGL_ALWAYS_SOFTWARE=1` | `VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json` |
| 浏览器标志 | `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --no-sandbox --hide-scrollbars` | `--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --disable-gpu-watchdog --no-sandbox --hide-scrollbars` |

补充事实：Chrome 139 起移除了 WebGL 的自动 SwiftShader 回退，不传 `--enable-unsafe-swiftshader` 会导致
WebGL 上下文创建**直接失败**；软件 WebGL 会打印一条警告，日志断言需过滤。

### 7.2 盲区（FR-023 要求显式记录，逐条可引用）

1. 软件光栅化 ≠ GPU：无真实并行、**无真实 GPU 时间戳**（`timestamp-query` 在软件模式下不可用，且会使
   Inspector/Profiler 崩溃，同类项目在 CI 中直接关闭它）→ 性能数值**只有相对回归意义**。
2. headless 下 WebGPU 画布呈现不可靠 → CI 用 headed + Xvfb，该合成路径与真实桌面不同。
3. Chromium 官方把 CPU 适配器标注为"未完全测试或不保证符合规范"→ CI 的符合性证据是弱证据。
4. 软件适配器下画布走 CPU 上传/回读路径，与真实 GPU 的呈现路径不同，一类缺陷在 CI 中不可见。
5. 不同光栅化器的**亚像素边缘覆盖**不同（上游同类项目因此排除特定用例）→ 阈值调参可能掩盖真实回归。
6. 设备丢失/GPU 进程卡死会导致浏览器进程需要被强制结束再重启（`browser.close()` 可能挂起），
   测试框架必须容忍并记录重试，避免把"重试成功"误当作"恢复成功"。
7. Chromium 版本漂移会改变像素 → Playwright 版本必须固定；升级浏览器必须重新生成参考帧。
8. CI 中**完全没有 GPU 管线级剖析能力**。
9. 浮点精度与纹理格式上限在软件适配器与真实 GPU 之间**未验证等价**：运行时枚举 `adapter.features` 并据此门控测试。
10. 公共仓的 larger runner（含 GPU runner）**始终计费**（即便公开仓），且 Free 计划并发上限 20 个作业
    → "每次提交都跑两路径 × 视觉 + 基准"存在排队风险，必须分片并控制采样帧数。

### 7.3 跨路径像素比较不可靠（决定 D8）

WebGL2 与 WebGPU 使用不同的光栅化器、不同的着色器编译器（ANGLE/GLSL vs Tint/SPIR-V）、
不同的 MSAA 解析与 sRGB 处理路径；上游同类项目因此**为每条渲染路径各自维护一套参考帧**
（逐路径生成、逐路径比较，容差为每通道 0.1、差异像素 ≤ 0.1%）。
因此本项目：
- **路径内回归**：像素对比（阻断），每路径各自参考帧；
- **跨路径等价**（FR-008）：用 `FrameStatistics` 与几何统计落在声明区间内判定（阻断），
  并在契约中显式声明无法消除的差异（亚像素边缘、MSAA 解析、sRGB 处理、深度表示）；
- **跨路径像素差异**：仅在真实 GPU 本地运行记录数值（非阻断）。

### 7.4 确定性注入与设备丢失

- 视觉采集：注入种子化 `Math.random`、冻结 `Date.now`/`performance.now`、`requestAnimationFrame` 单次触发、
  CDP `Input.setIgnoreInputEvents`（同类项目在生产 CI 中已验证）。**注意**：基准采集**不得**冻结时间
  （帧时间就是被测量），只冻结场景时间与随机源。
- 设备丢失：测试需能容忍 GPU 进程卡死并重启浏览器进程（SIGKILL 进程树），并把"重启后恢复"与
  "FR-003 要求的免刷新恢复"分开断言，避免用重启掩盖缺陷。

### 7.5 付费 GPU 选项（已核实）

- GitHub Actions GPU larger runner **已 GA（2024-07-08）**：4 vCPU / 1× Tesla T4 / 16 GB VRAM；
  Linux `$0.052/min`、Windows `$0.102/min`；需 Team 或 Enterprise Cloud 计划 + 信用卡 + 消费上限 > 0；
  **公共仓也始终计费**；GPU 并发上限 100；larger runner 冷启动有预热池（约 5 分钟后释放）。
- 现货云 GPU（RTX 4090 级）按秒计费：Vast.ai `$0.136–$0.382/h`、RunPod `$0.34/h` → 约为 GPU larger runner 的 1/7–1/23。
- 因此：每提交作业用免费标准 runner（软件适配器），绝对性能与 GPU 时间戳放到夜间受门控作业（按需租用现货云 GPU）。

---

## 8. 待验证假设（H-n）与验证方法

| # | 假设 | 验证方法 | 失败时的退路 |
|---|---|---|---|
| **H-1** | 双画布分层 + `Globe.baseColor = Color.TRANSPARENT` + canvas `alpha: true` 能让上游地形不可见而保留全部调度 | 最小闭环实验（渲染 1 个瓦片并截图，≤0.5 工作日） | 改用 `Globe.translucency`（`frontFaceAlpha = 0`）或允许 canvas A 正常绘制但由 canvas B 不透明覆盖（并在基准中标注额外开销） |
| **H-2** | "resident ∩ 视锥 ∩ 父子截断"规则与上游真实绘制截断在固定相机下等价 | G-2：`tilesLoaded` 后**只用公开 API**比较——自建规则集合 vs `globe.tileLoadProgressEvent`/`tilesLoaded`/`Scene.postRender` 帧计数 + 平台 API 包装得到的几何统计 + 像素统计区间 | **备选 V2 已删除**（`frameState.commandList`/`DrawCommand.owner` 为 `@private`，违反原则 I）。判定不等价时 **MUST 回到 `plan.md` 修订**并给出仅用公开 API 的新方案；交叉验证能力变弱由统计区间断言补偿（见 §4.3 与 plan.md Complexity Tracking 第 5 行） |
| **H-3** | 自建规则网格 + 裙边几何与上游基于同一高程场的网格在视觉上等价（接缝无裂缝、无 z-fighting） | 多瓦片拼接用例的像素与深度统计断言；接缝处专项用例 | 调整裙边高度/边界顶点生成规则；必要时改用与上游相同的裙边高度公式（由 `getLevelMaximumGeometricError` 推导，公开 API） |
| **H-4** | 通过公开 `interpolateHeight` 逐点采样重建高程场不可行（用于回击"为何要自建几何"的质疑） | 实测单瓦片 65×65 采样的耗时与精度（量化数据） | 若实测可接受（预期不可接受：三角查找为线性扫描量级），可作为 quantized-mesh 数据源的补充手段 |
| **H-5** | 存在免登录、CORS 可用的公开地形数据源 | **已核实（2026-09-18）**：AWS Open Data Terrarium `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` → 200 + `Access-Control-Allow-Origin: *`（z0–15，XYZ 约定，见 §6.1/§6.2 实测）；Re:Earth `https://terrain.reearth.land/cesium-mesh/ellipsoid/layer.json` 与 `/12/2048/2047.terrain` → 200 + CORS `*`（但覆盖质量可疑） | 已在 §6.1/§6.2 完成；继续以本地固定数据集为 CI 数据源 | 若 AWS 源失效：本地固定数据集仍保证 CI 与验收可运行；在线演示源降级为"数据不可用"的可观察状态（T-11） |
| **H-5b** | Re:Earth Terrain / Mapterhorn 的地形数据许可条款与可再分发范围 | 读取其数据集主页与 `layer.json` 的 attribution/license 元数据；确认是否允许在开源仓库中提交子集 | 未核实**不阻塞** MVP：默认数据源为 AWS Terrarium（许可已核实），CI 只用随仓库提交的本地固定数据集；若要在后续增量启用这两个备选源，必须先完成核实并附带其署名串 |
| **H-6** | 新路径的浏览器基线（经验值 Chrome/Edge ≥ 121、Firefox ≥ 141、Safari ≥ 26） | 在 CI 与本地真实设备上跑能力探测与最小用例，记录实测通过的版本 | 文档只声明"由能力探测决定"，基线表加注"实测确认前仅供参考" |
| **H-7** | 设备丢失（`GPUDevice.lost`）在测试中可被可靠模拟与观测 | 用 `device.destroy()` 触发 lost，或在页面注入故障；断言恢复或回退的可观察提示 | 若无法稳定模拟，则降级为"注入 device 获取失败 + 记录该用例跳过原因"，并在文档中记录不可测边界（不得静默跳过） |
| **H-8** | 两路径（软件适配器）的契约 + 视觉 + 相对基准合计 ≤ 20 分钟 | 在托管 runner 实测并记录各阶段耗时 | 缩减基准采样帧数、分片并行、或把绝对基准移到夜间作业（契约测试与视觉回归仍必须每提交运行） |
| **H-9** | `preference: "webgl2"` 时完全不触碰 `navigator.gpu` | 单元/契约测试中把 `navigator.gpu` 定义为抛异常的 getter，断言用例仍通过 | 若上游或第三方在初始化时触碰 `navigator.gpu`，则在文档中声明该边界并调整断言粒度 |

---

## 9. 被否决方案汇总（含否决理由）

| 方案 | 否决理由 |
|---|---|
| `canvas.getContext("webgpu")` 接管上游画布 | WebGPU 规范禁止同一 canvas 双上下文类型；上游 `Scene.context` 为 `@private`（原则 I） |
| 读上游帧缓冲/纹理做合成 | 需要 `@private` 的上下文与帧缓冲（原则 I）；每帧全画面回读代价高 |
| `globe.show = false` 隐藏地形 | 同时停掉瓦片加载（`Globe.update/render/endFrame` 的 `!show` 早退，已核实） |
| monkey-patch `Scene.prototype.render` | 改变上游运行时行为，违反原则 I 的精神，升级即碎 |
| 直接使用上游 `CesiumTerrainProvider` | 其几何（`createMesh`/`TerrainMesh`/`TerrainEncoding`）为 `@private`，新路径取不到顶点 |
| 调用 `@private` 的 `createMesh` / 访问 `globe._surface` | 直接违反 constitution 原则 I（NON-NEGOTIABLE） |
| 自实现 `Primitive` 扫描 `frameState.commandList` 并按 `DrawCommand.owner` 反推瓦片（原退路 V2） | `FrameState`/`DrawCommand` 均为上游 `@private`（§1.2）；违反原则 I，且原 A4 规则无法捕获无下划线前缀的命名导入 → **本轮显式删除该退路** |
| 自研空间索引与 LOD 选择 | 违反 spec Assumptions「不在本增量重新设计地形数据格式或空间索引」，且失去与兜底路径的 LOD 等价性 |
| 使用 `ArcGISTiledElevationTerrainProvider` | 该类构造函数标注 `@private`（已核实 `Core/ArcGISTiledElevationTerrainProvider.js:43`） |
| 使用任何需要令牌的地形服务 | spec 明确后置到后续增量（FR-004 / 依赖段） |
| 跨路径逐像素比较 | 不同光栅化器/编译器/MSAA 解析/sRGB 路径 → 误判与掩盖缺陷（§7.3） |
| headless + `--disable-vulkan-surface` 跑 WebGPU | 画布呈现失效，截图全黑（§7.1） |
| `--enable-unsafe-swiftshader` 启用 WebGPU | 该标志只对 WebGL 生效（§7.1） |
| 在软件适配器上做绝对性能基准 | 无真实 GPU 时间戳，数值只具相对意义（§7.2） |
| GPU larger runner 作为每提交基准环境 | 公共仓也始终计费，单价约为现货云 GPU 的 7–23×（§7.5） |

---

## 10. 结论摘要

1. **架构可行且全部落在公开 API 内**：双画布分层（D1）+ `postRender` 提交钩子（D2）+
   `TerrainProvider` 数据注入（D3）+ 自建 WebGPU 几何。约束的根源是 §1.2 的 `@private` 黑名单——
   它同时排除了"用上游渲染器"与"读上游网格"两条捷径。
2. **最大的两个风险**已明确并给出验证门：H-1（分层与隐藏是否成立）与 H-2（可见瓦片集合是否等价）。
3. **CI 可行且零 GPU 成本**：Xvfb + lavapipe 已被同类项目在生产 CI 中验证；但 CI 只能给出**相对**性能结论，
   绝对性能必须另租真实 GPU，且该降级方式的 10 条盲区必须写入仓库文档（FR-023）。
4. **数据源可满足"免登录 + 离线确定性"**：公开栅格高程源 + 同源固定数据集 + 上游公开 `HeightmapTerrainData`；
   具体端点的可用性与许可待 H-5 核实。
5. 所有"优化"都以帧时间 p50/p95、图形资源字节数、绘制批次数三项可测指标表述（constitution 原则 IV）。

---

## 11. 核实工作的收尾

- 解包源码位于系统临时目录（`%TEMP%\cesium-probe`），**未写入仓库、未安装到仓库根目录**；
  核实完成后删除该临时目录，并在 `docs/upstream-api-allowlist.md` 中固化 §1.1 的允许清单与 §1.2 的黑名单。
- 允许清单的实现形式：`packages/cesium-webgpu/src/adapters/cesium/public-api-allowlist.ts`（运行期断言）
  + 断言 A4（静态扫描，见 data-model.md §9），二者共同保证原则 I 在后续提交中不被侵蚀。
