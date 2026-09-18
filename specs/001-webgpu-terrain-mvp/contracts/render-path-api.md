# Contract: 上层 API 与渲染路径二选一（Render Path API）

**Feature**: `001-webgpu-terrain-mvp` | **Status**: 设计基线 v2 | **Spec**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)
**Constitution**: v2.0.0 原则 II（二选一，不同时运行，NON-NEGOTIABLE）

本契约定义**集成方唯一可见的接口**及其不变量。核心不变量：**集成方代码中不出现渲染路径条件分支，
也不引用任何具体后端类型**（FR-007）；**同一会话内只有一条后端路径在绘制**，回退是**整体切换**（销毁重建），
禁止任何形式的图层叠加、透明/半透明遮挡、逐帧合成或"使某一次绘制不可见"（FR-006）。

> **架构前提（本版）**：两条"路径"不再是我们自建的绘制链，而是**同一套上游逻辑层 + 两种渲染后端实现**：
> WebGPU 后端（受控 fork/补丁层，见 [fork-patch-layer.md](./fork-patch-layer.md)）与上游原版 WebGL2 后端。
> 上层 API 因此更薄：它负责**探测 → 选择 → 构造 →（必要时）整体切换**，以及状态可观察性。

---

## 1. 包入口（唯一公开面）

```ts
// packages/cesium-webgpu/src/index.ts —— 唯一入口；MUST NOT 导出任何 GPU/WebGL/后端类型
export type BackendKind = "webgpu" | "webgl2";

export interface TerrainSceneOptions {
  container: HTMLElement;
  datasetId: string;                      // 固定数据集（离线可复现）
  preference?: BackendKind | "auto";      // 默认 "auto"；仅作配置，调用方 MUST NOT 据此分支
  camera?: { longitude: number; latitude: number; height: number; heading?: number; pitch?: number; roll?: number };
  viewport?: { width: number; height: number; devicePixelRatio: number };
  onStatus?: (status: RenderPathStatus) => void;   // 可观察状态（FR-009）
}

export interface TerrainSceneHandle {     // 两条路径下**行为一致**，不含任何后端专属成员
  readonly ready: Promise<void>;          // 场景与地形就绪；MUST NOT reject（异常走 diagnostics）
  whenTilesLoaded(options?: { timeoutMs?: number }): Promise<{ loaded: boolean; pendingTiles: number }>;
  captureFrame(): Promise<FrameCapture>;  // RGBA8、左上原点、无预乘
  stats(): FrameStatistics;               // 非背景覆盖率、颜色/深度统计、draw call、三角形数、瓦片数、帧时间
  resetStats(): void;
  setView(camera: TerrainSceneOptions["camera"]): void;
  requestRender(): void;
  dispose(): void;                        // 销毁当前后端与其全部资源
  readonly diagnostics: { onError(cb: (e: DiagnosticError) => void): () => void };
}

export function createTerrainScene(options: TerrainSceneOptions): TerrainSceneHandle;
```

**规则**：

- 入口 MUST NOT 导出 `Context` / `Buffer` / `Texture` / `ShaderProgram` / `GPUBuffer` / `WebGL2RenderingContext` 等后端符号
  （构建后对 `dist/index.d.ts` 断言 `/GPU[A-Z]|WebGL|backend-webgpu/` 无命中）。
- `preference` 只是配置：包内部读取它完成选择；**调用方代码中的分支检测由架构测试禁止**（见 §5）。
- 场景构造 MUST 使用 MVP 场景配置：`baseLayer:false`、`skyBox:false`、`skyAtmosphere:false`、无后处理
  （保证零 `ComputeCommand` 派发；见 research §1.6）。

## 2. 路径选择（初始化阶段一次性）

```text
preference = "webgl2"                → 不探测，直接使用上游原版 WebGL2 后端
preference = "webgpu"                → 探测；成功用 WebGPU 后端；失败/超时（>2000ms）/低于下限 → 整体兜底到 WebGL2
preference = "auto"                  → 同 webgpu，但把"不支持"视为正常结果（不产生错误）
```

- 探测内容：`navigator.gpu` 存在性 → `requestAdapter()` → `requestDevice()` → 必需特性与下限
  （`maxTextureDimension2D`、`maxVertexAttributes`、`maxSampledTexturesPerShaderStage`、`maxUniformBufferBindingSize`）。
- 探测成功时，设备经**后端层交接槽**同步交付给 `Context` 替换模块（见 research §3）；
  探测失败时**不安装交接槽** → 上游原版 WebGL2 链路（不存在"两条路径各画一半"的中间态）。
- **被保留的上游原版实现（决策 D2-a，见 plan.md）**：补丁层在替换 `Renderer/Context.js` 的同时，
  **保留一份上游原版 WebGL2 实现于补丁层私有路径**；替换模块在"交接槽为空"时**整体委派**给它，
  而不是抛出错误。**同一时刻只有一份实现被实例化**（另一份从不构造、不持设备、不绘制，属休眠代码），
  因此不构成原则 II 所禁止的"两条管线同时绘制同一场景"。
  > 注：Phase 2 的 G-2 门禁桩在槽为空时抛 `device-handoff/missing`，那是**门禁局部偏离**（为让失败可观察），
  > 不是产品语义；产品语义以本条为准。
- `RenderPathStatus`：`{ active, reason, degraded, notes }`（原因类别见 data-model §2.2/§2.5）；
  `degraded === true` 时 `notes` MUST 非空（FR-023）。

## 3. 整体切换（回退与设备丢失）

| 场景 | 行为 |
|---|---|
| 探测失败/超时/能力不足 | 初始化阶段直接以 WebGL2 构造；**MUST NOT** 抛未捕获错误、MUST NOT 阻塞页面其余部分 |
| 会话中途 `device.lost` | 停止提交 → **销毁** WebGPU 后端与上游场景 → 重新探测 → 按 §2 重建（成功仍用 WebGPU；失败整体切 WebGL2）；恢复后场景可继续交互并给出状态提示（FR-003） |
| 切换记录 | `WholeSwitchRecord`（`destroyedResources > 0`、`residualDraws === 0`）MUST 可观察（data-model §2.4） |

**禁止**：保留旧设备的资源或绘制结果作为叠加层；以 CSS/画布叠加掩盖旧路径；在切换期同时提交两条路径的绘制。

## 4. 可观察性（FR-009）

- `onStatus` 与演示页状态区 MUST 展示：当前生效路径、原因类别（`no-navigator-gpu` / `no-adapter` /
  `device-request-failed` / `missing-feature` / `below-limit` / `timeout`）、是否降级、盲区备注。
- 状态信息**仅供观察与排障**；业务代码 MUST NOT 依据 `status.active` 分支（架构测试断言）。
- 测试专用出口（`./escape-hatch` 子路径，可选交付）：允许测试读取上游对象做诊断，
  **引用即退出"同构保证"**，MUST NOT 被主入口 re-export。

## 5. 契约测试（CI 必过）

| 断言 | 内容 |
|---|---|
| C-1 | `createTerrainScene` 在两条路径下都 MUST 返回可用句柄；`ready` MUST NOT reject |
| C-2 | 同一套用例参数化两条路径，**各自独立进程 + 独立页面加载**；断言该次运行中另一条后端的 GPU 对象创建数为 0 |
| C-3 | 强制 WebGPU 不可用（如 `navigator.gpu = undefined`）后，页面仍渲染地形、2 秒内完成回退、无未捕获错误、无空白画面 |
| C-4 | 设备丢失（`device.destroy()`）后免刷新恢复，且旧设备资源计数归零 |
| C-5 | 调用方（演示页）源码 MUST NOT 出现 `=== "webgpu"` / `=== "webgl2"` / `preference ===` 之类分支（唯一例外：包内部 `src/render-path/**`） |
| C-6 | `dist/index.d.ts` MUST NOT 出现后端/GPU 符号；包入口 MUST NOT re-export `./escape-hatch` |
| C-7 | 两条路径的 `stats()` 与统计断言落在声明区间内（视觉等价按统计判定，见 [verification-and-benchmark.md](./verification-and-benchmark.md)） |

## 6. 错误模型

- 上层可见错误经 `diagnostics.onError` 上报（`{ category, message, backend?, cause? }`），**不得**静默吞掉；
- 未实现的后端能力（切片 C：picking 回读、`CubeMap`、`Texture3D`、`TextureAtlas`、模型/体素着色器、影像重投影）
  MUST 以**显式可诊断错误**暴露（`category: "not-implemented"`），MUST NOT 静默返回空结果或黑屏；
- 数据不可用（瓦片缺失/网络失败）与渲染失败 MUST 可区分（FR-004）。
