/**
 * T089 — 公开句柄的实现（`packages/cesium-webgpu/src/compose/handle.ts`）。
 *
 * `TerrainSceneHandle` 的 9 个成员在这里**全部**被实现：`ready` / `whenTilesLoaded` / `captureFrame` /
 * `stats` / `resetStats` / `setView` / `requestRender` / `dispose` / `diagnostics`。
 * 句柄本身只做四件事：把调用转给场景控制器、保证 `dispose()` 幂等、拒绝"已经销毁之后"的语义化调用、
 * 把销毁后的调用记成 `internal` 诊断（MUST NOT 静默返回过期结果）。
 *
 * WHY THIS FILE HAS NO VALUE IMPORTS
 *   场景控制器是一个窄接口（`SceneController`），真正的 GPU/DOM 实现在 `scene-runtime.ts`。
 *   于是这个文件不 import 任何**值**，`tests/unit/scene-config.test.mjs` 能用 Node 直接加载它，
 *   用一个假控制器把 9 个成员逐个跑一遍 —— "句柄真的实现了"因此是可执行的断言，而不是源码正则。
 *   （`import type` 在运行时被类型擦除，不产生模块解析。）
 */
import type {
  DiagnosticError,
  FrameCapture,
  FrameStatistics,
  TerrainSceneHandle,
  TerrainSceneOptions,
} from "../api/types.js";

/** 句柄需要的诊断面（`src/api/diagnostics.ts` 的 `Diagnostics` 满足它，这里只声明用到的那两个成员）。 */
export interface SceneDiagnosticSink {
  onError(callback: (error: DiagnosticError) => void): () => void;
  report(error: DiagnosticError): void;
}

/**
 * 场景控制器：句柄驱动的活场景。
 *
 * 它是"后端无关"的：接口里没有任何 GPU 句柄、没有 backend 字段、没有 `preference`，
 * 所以同一个句柄实现在两条路径上行为一致（契约 §5 C-1 / C-3）。
 */
export interface SceneController {
  whenTilesLoaded(options?: { timeoutMs?: number }): Promise<{ loaded: boolean; pendingTiles: number }>;
  captureFrame(): Promise<FrameCapture>;
  stats(): FrameStatistics;
  resetStats(): void;
  setView(camera: TerrainSceneOptions["camera"]): void;
  requestRender(): void;
  dispose(): void;
}

/** 组装句柄需要的三件东西：`ready`（由构造流程给出）、控制器、诊断总线。 */
export interface TerrainSceneHandleParts {
  /** 场景与地形就绪；实现在 `scene-runtime.ts`，且该 promise **永不 reject**（失败只走 diagnostics）。 */
  readonly ready: Promise<void>;
  readonly controller: SceneController;
  readonly diagnostics: SceneDiagnosticSink;
}

/** 把诊断对象变成可抛出的 `Error`（保留 `category` 等字段，便于 `catch` 侧按类别分流）。 */
function toThrowable(diagnostic: DiagnosticError): Error & DiagnosticError {
  return Object.assign(new Error(diagnostic.message), diagnostic);
}

/**
 * 由控制器组装公开句柄。
 *
 * `dispose()` 幂等：第二次调用 MUST NOT 再销毁一遍（销毁不可逆，重复销毁会把已经归还的资源再还一次）。
 * 销毁之后 `captureFrame()` **reject**（绝不给出一张空帧——FR-033 明令禁止用空结果代替失败），
 * `whenTilesLoaded()` 返回 `loaded:false`，两者都会先记一条 `internal` 诊断。
 */
export function createTerrainSceneHandle(parts: TerrainSceneHandleParts): TerrainSceneHandle {
  let disposed = false;

  /** 统一的"销毁后调用"处理：上报 `internal` 诊断并把它作为失败原因交给调用方。 */
  const afterDispose = (operation: string): DiagnosticError => {
    const diagnostic: DiagnosticError = {
      category: "internal",
      message: `${operation} was called after dispose(): the scene and every resource it owned are gone, so the call cannot be honoured.`,
    };
    parts.diagnostics.report(diagnostic);
    return diagnostic;
  };

  return {
    ready: parts.ready,

    whenTilesLoaded(options) {
      if (disposed) {
        afterDispose("whenTilesLoaded");
        // 已销毁的场景里没有任何瓦片在加载，`loaded:false` 是事实而不是降级。
        return Promise.resolve({ loaded: false, pendingTiles: 0 });
      }
      return parts.controller.whenTilesLoaded(options);
    },

    captureFrame() {
      if (disposed) return Promise.reject(toThrowable(afterDispose("captureFrame")));
      return parts.controller.captureFrame();
    },

    stats() {
      // 只读观测：销毁后仍返回"最后一次测量到的值"（`stats()` 的语义就是最近一次测量，不是"现在"）。
      return parts.controller.stats();
    },

    resetStats() {
      if (disposed) {
        afterDispose("resetStats");
        return;
      }
      parts.controller.resetStats();
    },

    setView(camera) {
      if (disposed) {
        afterDispose("setView");
        return;
      }
      parts.controller.setView(camera);
    },

    requestRender() {
      if (disposed) {
        afterDispose("requestRender");
        return;
      }
      parts.controller.requestRender();
    },

    dispose() {
      // 幂等：第二次（及以后）调用直接返回，不再触碰控制器。
      if (disposed) return;
      disposed = true;
      parts.controller.dispose();
    },

    diagnostics: {
      onError(callback) {
        return parts.diagnostics.onError(callback);
      },
    },
  };
}
