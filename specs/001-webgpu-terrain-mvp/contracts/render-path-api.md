# Contract: 同构上层 API（Isomorphic Render Path API）

**Feature**: `001-webgpu-terrain-mvp` | **Status**: 设计基线 v1 | **Spec**: [../spec.md](../spec.md)

本契约定义**集成方唯一可见的接口**。核心不变量：**集成方代码中不出现渲染路径条件分支，也不引用任何具体后端类型**
（FR-007 / constitution 原则 II）。两条路径（WebGPU 新路径、WebGL2 兜底路径）在同一接口下必须可互换。

---

## 1. 入口

```ts
// packages/cesium-webgpu/src/index.ts —— 唯一公开入口（package.json "exports": { ".": ... }）
export { createTerrainScene } from "./api/createTerrainScene.js";
export { probeRenderPath } from "./api/probeRenderPath.js";
export { RenderPathUnavailableError, RenderPathInitError } from "./api/errors.js";
export { listDatasets, getDatasetManifest } from "./api/datasets.js";
export type {
  CreateTerrainSceneOptions, TerrainSceneHandle, PathInfo, RenderPathPreference,
  PathUnavailableReason, CapabilityProbeResult, FrameStats, FrameStatsSummary,
  FrameCapture, FrameStatistics, CameraSnapshot, RenderPathEventMap,
} from "./api/types.js";
```

**MUST NOT**（由 `tests/unit/architecture-boundary.test.ts` 断言）：
- 主入口的 `.d.ts` 中出现 `GPUBuffer|GPUDevice|GPUAdapter|GPUCanvasContext|WebGL2RenderingContext|WebGLRenderingContext` 等后端符号；
- 主入口导出任何 `src/backends/**` 的类型；
- 要求集成方 import `cesium` 的任何具体渲染器类型（`Viewer`/`CesiumWidget`/`Scene` 只在**可选逃生舱**
  `./escape-hatch` 子路径导出，且必须在文档中标注"引用即退出同构保证"）。

## 2. 创建场景

```ts
export type RenderPathPreference = "auto" | "webgpu" | "webgl2";

export interface CreateTerrainSceneOptions {
  /** 承载画布的容器元素。库自行创建并管理画布分层，集成方不得依赖画布数量/顺序。 */
  readonly container: HTMLElement;
  /** 路径偏好。默认 "auto"：先探测新路径，失败/超时/能力不足自动回退兜底路径。 */
  readonly preference?: RenderPathPreference;
  /** 固定地形数据集（CI 与验证默认使用 local-fixed）。 */
  readonly terrain:
    | { kind: "local-fixed"; datasetId: string }
    | { kind: "public"; datasetId: string };
  /** 固定相机（验证与基准必需；交互由场景内建控制器接管）。 */
  readonly camera: CameraSnapshot;
  /** 固定场景时间（验证必需，ISO-8601）。 */
  readonly sceneTime?: string;
  readonly rendering?: {
    /** 设备像素比。固定值以保证跨运行、跨路径可比（FR-012）。默认 1。 */
    readonly pixelRatio?: number;
    readonly msaaSamples?: 1 | 2 | 4;
    readonly requestRenderMode?: boolean;
  };
  readonly probe?: {
    /** 能力探测上限（毫秒）。MUST NOT 超过 2000（FR-005）。默认 2000。 */
    readonly timeoutMs?: number;
  };
  readonly diagnostics?: {
    readonly onPathChange?: (info: PathInfo, reason?: PathUnavailableReason) => void;
    readonly onError?: (error: TerrainSceneError) => void;
    readonly logLevel?: "silent" | "error" | "warn" | "info" | "debug";
  };
}

export function createTerrainScene(
  options: CreateTerrainSceneOptions,
): Promise<TerrainSceneHandle>;
```

**规范性要求**

| 编号 | 要求 | 追溯 |
|---|---|---|
| C-1 | `createTerrainScene` MUST 在探测失败、探测超时（≤2s）、能力下限不满足或设备丢失不可恢复时**成功返回**可用句柄，绝不 reject | FR-005 / FR-006 / FR-009 |
| C-2 | `preference: "webgl2"` 时 MUST NOT 执行任何新路径探测（不得触碰 `navigator.gpu`） | FR-005 / FR-007 |
| C-3 | `preference: "webgpu"` 且新路径不可用时 MUST 仍渲染地形，并通过 `handle.path.reason` 与 `diagnostics.onPathChange` 给出原因类别 | FR-006 / FR-009 |
| C-4 | 两条路径下 `handle` 的方法集、事件集与返回类型 MUST 完全一致（同构） | FR-007 / FR-008 |
| C-5 | 同一 `options`（含固定相机、时间、视口、像素比、数据集）在两条路径下 MUST 产生声明的视觉等价结果 | FR-008 |
| C-6 | 任何未捕获异常 MUST NOT 逃逸到 `window.onerror`；一律经 `diagnostics.onError` 上报 | FR-005 / FR-009 |

## 3. 句柄

```ts
export interface TerrainSceneHandle {
  /** 当前路径信息（只读；路径选择变化经 events.pathChange 通知）。 */
  readonly path: PathInfo;
  /** 首帧包含地形的画面就绪。 */
  readonly ready: Promise<void>;
  /** 瓦片加载进度（0..1）与是否就绪；超时返回 timedOut 而不抛错。 */
  whenTilesLoaded(options?: { timeoutMs?: number }): Promise<TileLoadStatus>;
  /** 采集当前帧像素与统计（验证用；两路径同签名、同返回结构）。 */
  captureFrame(): Promise<FrameCapture>;
  /** 帧统计；resetStats() 后重新累积。 */
  stats(): FrameStatsSummary;
  resetStats(): void;
  /** 设定固定相机（验证用例使用）。 */
  setView(view: CameraSnapshot): void;
  /** 管线/GPU 资源/事件监听的完整释放；释放后调用任何方法 MUST 抛 RenderPathStateError。 */
  dispose(): void;
  readonly events: {
    readonly pathChange: EventSource<{ info: PathInfo; reason?: PathUnavailableReason }>;
    readonly error: EventSource<TerrainSceneError>;
    readonly tilesProgress: EventSource<{ remaining: number; total: number }>;
  };
}

export interface TileLoadStatus {
  readonly loaded: boolean;
  readonly timedOut: boolean;
  readonly remainingRequests: number;
  readonly elapsedMs: number;
}

export interface FrameCapture {
  readonly width: number; readonly height: number;
  readonly pixels: Uint8Array;      // RGBA8，行主序，左上原点（两路径一致，统一在采集层翻转）
  readonly stats: FrameStatistics;  // 见 data-model.md §6
  readonly path: RenderPathId;      // 仅用于证据标注；集成方不得据此分支
}
```

**规范性要求**

| 编号 | 要求 | 追溯 |
|---|---|---|
| C-7 | `captureFrame()` 在两条路径下 MUST 返回同样布局与色彩空间的像素（RGBA8、sRGB、左上原点、无预乘），使验证代码无需分支 | FR-010 / FR-011 |
| C-8 | `dispose()` MUST 释放 GPU 资源、移除 DOM、解绑事件；MUST NOT 影响同页其他 Cesium 实例 | FR-025 |
| C-9 | `setView()` MUST 使两条路径产生一致的相机姿态（同一 `CameraSnapshot` → 同一 `viewMatrix`） | FR-008 |
| C-10 | 设备丢失后 MUST 经 `events.pathChange` 或 `events.error` 给出可观察提示，且 `ready` 语义在该次会话内保持成立 | FR-003 / FR-009 |

## 4. 能力探测（独立可用，便于单测）

```ts
export interface ProbeOptions {
  readonly timeoutMs?: number;      // 默认 2000，硬上限 2000（超限即夹取并告警）
  readonly floor?: Partial<CapabilityFloor>; // 覆盖默认能力下限（仅测试使用）
}
export function probeRenderPath(options?: ProbeOptions): Promise<CapabilityProbeResult>;
```
- 探测函数 MUST 是纯函数式的：不得创建 DOM、不得修改全局状态、超时后 MUST 释放已获取的 device。
- 单元测试（Node + 伪 `navigator.gpu`）覆盖：无 `navigator.gpu`、`requestAdapter→null`、
  `requestDevice→reject`、limits 低于下限、超时（含"迟到 resolve"场景）。

## 5. 配置驱动的路径选择（构建期与运行期）

| 场景 | 配置方式 | 期望行为 |
|---|---|---|
| 默认（集成方无感知） | `preference: "auto"` | 支持时走新路径，否则同一句柄走兜底路径 |
| 强制对比/排障 | `preference: "webgpu"` / `"webgl2"` | 完全走指定路径；不可用时按 C-3 回退并提示 |
| 构建期裁剪 | 打包常量 `__RENDER_PATH_DEFAULT__`（Rollup `replace`） | 只保留选定路径的默认值；集成方代码不变 |

集成方**唯一允许**书写路径字面量的位置是"把它作为配置值传给库"；库自身也不得让该字面量扩散为行为分支以外的语义
（`src/api/**` 内允许读取 `preference` 与 `path`，但渲染调用点必须经 `RenderBackend` 抽象接口）。
