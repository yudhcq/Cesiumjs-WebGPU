/**
 * T089 — 场景构造与句柄的运行时实现（`packages/cesium-webgpu/src/compose/scene-runtime.ts`）。
 *
 * 入口 `createTerrainScene` 的**唯一**实现体：解析构造输入 → 断言冻结的 MVP 场景配置 → 建画布 →
 * 直接构造上游 `Scene`（不是 `CesiumWidget`）→ 装上 `Globe` 与 T086 的地形 provider → 固定相机 →
 * 起逐帧循环 → 交出 `TerrainSceneHandle`。
 *
 * 三条硬约束决定了这里的形状：
 *
 *   1. **A1/A2（架构规则）**：`src/index.ts` 与 `src/api/**` MUST NOT 出现后端字面量，
 *      `src/**` MUST NOT import `backend-webgpu/**`。所以这里**只 import 生产 specifier**
 *      （`@cesium/engine` 公开入口），构建期由 `tools/rollup-plugin-engine-patch.mjs` 按 manifest
 *      把 `Renderer/**` 换成补丁层实现（与 `src/terrain/source.ts`、`tests/contract/page/entry.js` 同一机制）。
 *      补丁层在 `Context` 上发布、而公开 `.d.ts` 不声明的那几个成员（`context.device`、
 *      `context.awaitFrameErrors`、`scene.initializeFrame`）只能经下面的**结构化 seam**读取 ——
 *      这是本文件唯一触碰"未声明表面"的地方，且每个成员都做了存在性判断。
 *
 *   2. **不走 `CesiumWidget`**：widget 会额外构造 `Sun` 与 `Moon`，而 `Moon` 构造期会去取
 *      `Assets/Textures/moonSmall.jpg` —— 离线契约（T087：`mode:"fixture"` ⇒ 零外部请求）不允许，
 *      且该失败表现为未捕获的 `RequestErrorEvent`（W5 实测）。`baseLayer`/`skyBox`/`skyAtmosphere`
 *      三个 `false` 因此不是"设成 false"，而是"根本不构造这些对象"；三个标志仍由
 *      `scene-options.ts` 的冻结声明给出并在构造前断言（A6）。
 *
 *   3. **`ready` MUST NOT reject**：构造期的一切失败都经 `diagnostics.onError` 上报，并且保持
 *      `data-unavailable`（地形数据取不到）与 `render-failed`（渲染/构造失败）可区分（FR-004）。
 */
import { Cartesian3, Globe, JulianDate, Math as CesiumMath, Scene } from "@cesium/engine";

import { createDiagnostics, type Diagnostics } from "../api/diagnostics.js";
import { assertMvpSceneOptions, MVP_GLOBE_OPTIONS, MVP_SCENE_CONFIGURATION } from "../scene-options.js";
import { createStatusEmitter } from "../status/render-path-status.js";
import { createTerrainProvider, TerrainSourceError, type TileReader } from "../terrain/source.js";
import {
  assembleFrameStatistics,
  createFrameTimeWindow,
  unmeasuredFrameStatistics,
  type CommandTally,
  type FrameStatisticsSnapshot,
  type RgbaBytes,
} from "./frame-statistics.js";
import { createTerrainSceneHandle, type SceneController, type SceneDiagnosticSink } from "./handle.js";
import {
  FIXTURE_BASE_URL,
  SCENE_TIME_ISO,
  backingStoreSize,
  resolveCamera,
  resolveViewport,
  type ResolvedCamera,
  type ResolvedViewport,
} from "./scene-config.js";
import type {
  BackendKind,
  DiagnosticError as DiagnosticErrorShape,
  FrameCapture,
  FrameStatistics,
  TerrainSceneHandle,
  TerrainSceneOptions,
} from "../api/types.js";

/** 默认的"等地形加载完"预算，与契约页探针的 30 s 预算一致。 */
const DEFAULT_TILES_TIMEOUT_MS = 30_000;

/** `PrimitiveType.TRIANGLES`：地形闭包只发射三角形列表，条带/扇面不在本增量的口径内。 */
const TRIANGLES = 4;

/**
 * 补丁层 `Context` 上本文件用到、而公开类型未声明的成员。
 *
 * 全部按"存在才用"处理：上游若改名，退化的是观测能力（少一条诊断），而不是整个入口崩溃。
 */
interface ContextSeam {
  /** 只有替换版（新后端路径）的 `Context` 带设备；委派给上游实现的旧路径上下文没有。 */
  readonly device?: unknown;
  /** T052：帧级 GPU 错误只在 `await` 这个 promise 时才会重新抛出（不 await 就等于静默）。 */
  awaitFrameErrors?: () => Promise<void>;
}

/** 上游 `Scene` 上本文件用到的、公开 `.d.ts` 未声明的成员。 */
interface SceneSeam {
  readonly context?: ContextSeam | undefined;
  /** `CesiumWidget` 的渲染循环每帧都调它；本入口自己驱动循环，所以必须自己补上这一次调用。 */
  initializeFrame?: () => void;
}

/** `Scene#debugCommandFilter` 收到的命令对象里本文件用到的字段（`DrawCommand` 的形状）。 */
interface CommandShape {
  readonly count?: unknown;
  readonly instanceCount?: unknown;
  readonly primitiveType?: unknown;
}

/** 场景生命周期结束（销毁/构造失败）后，仍在等待的调用需要被唤醒，否则 `whenTilesLoaded` 会永久挂住。 */
interface PendingCapture {
  resolve(frame: FrameCapture): void;
  reject(cause: unknown): void;
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

/**
 * 构造一条**公开接口形状**的诊断。
 *
 * 为什么不直接复用 `api/errors.ts` 的类：该类的 `backend` 是 `BackendKind | undefined`，
 * 而公开接口在 `exactOptionalPropertyTypes` 下要求"缺省时这个键不存在"，两者不可互赋。
 * 这里显式省略缺省键，异常值仍然原样保留在 `cause` 里（MUST NOT 丢掉任何 thrown value）。
 */
function diagnosticOf(
  category: DiagnosticErrorShape["category"],
  message: string,
  cause?: unknown,
): DiagnosticErrorShape {
  return cause === undefined ? { category, message } : { category, message, cause };
}

/**
 * 建立入口句柄。
 *
 * @param options 公开入口参数（原样传递，不做后端分支）。
 * @param entryDiagnostics 入口层已经判定"本增量无法兑现"的能力诊断（例如显式的 `preference`），
 *   由 `src/index.ts` 构造并在此**第一条 await 之后**上报 —— 调用方在 `createTerrainScene` 返回后
 *   才 `onError` 订阅，同步上报会被漏掉。
 */
export function createTerrainSceneComposition(
  options: TerrainSceneOptions,
  entryDiagnostics: readonly DiagnosticErrorShape[] = [],
): TerrainSceneHandle {
  const diagnostics = createDiagnostics();
  const runtime = startTerrainScene(options, diagnostics, entryDiagnostics);
  return createTerrainSceneHandle({ ready: runtime.ready, controller: runtime.controller, diagnostics });
}

interface TerrainSceneRuntime {
  readonly ready: Promise<void>;
  readonly controller: SceneController;
}

/** 构造失败时交给句柄的控制器：所有操作都**上报同一个失败**，绝不返回过期或空的结果。 */
function createFailedSceneController(diagnostics: SceneDiagnosticSink, failure: DiagnosticErrorShape): SceneController {
  const tell = (operation: string): DiagnosticErrorShape => {
    const diagnostic = diagnosticOf(
      failure.category,
      `${operation}: the scene could not be created — ${failure.message}`,
      failure.cause,
    );
    diagnostics.report(diagnostic);
    return diagnostic;
  };
  return {
    whenTilesLoaded: () => {
      tell("whenTilesLoaded");
      return Promise.resolve({ loaded: false, pendingTiles: 0 });
    },
    captureFrame: () => Promise.reject(Object.assign(new Error(tell("captureFrame").message), failure)),
    stats: () => unmeasuredFrameStatistics(),
    resetStats: () => undefined,
    setView: () => {
      tell("setView");
    },
    requestRender: () => {
      tell("requestRender");
    },
    dispose: () => undefined,
  };
}

/** 建立运行时：同步完成输入解析与画布/场景构造，异步部分（地形数据）挂在 `ready` 上。 */
function startTerrainScene(
  options: TerrainSceneOptions,
  diagnostics: Diagnostics,
  entryDiagnostics: readonly DiagnosticErrorShape[],
): TerrainSceneRuntime {
  // ---- 同步前置：构造输入。失败即"没有可用的场景"，交给惰性控制器（ready 仍然 resolve）。 --------
  let defaultCamera: ResolvedCamera;
  let viewport: ResolvedViewport;
  let canvas: HTMLCanvasElement | null = null;
  /** 画布是不是本入口建的：只有自己建的才允许在 `dispose()` 时从容器里摘掉。 */
  let ownedCanvas = false;
  try {
    if (typeof (options.container as { appendChild?: unknown } | undefined)?.appendChild !== "function") {
      throw new Error("options.container MUST be an element the scene canvas can be mounted into (terrain-scene option)");
    }
    defaultCamera = resolveCamera(options.camera);
    viewport = resolveViewport(options.viewport, containerSize(options.container));
    const resolved = resolveSceneCanvas(options.container, viewport);
    canvas = resolved.canvas;
    ownedCanvas = resolved.owned;
  } catch (cause) {
    const failure = diagnosticOf("internal", `createTerrainScene could not start: ${messageOf(cause)}`, cause);
    diagnostics.report(failure);
    return { ready: Promise.resolve(), controller: createFailedSceneController(diagnostics, failure) };
  }

  // MVP 场景配置的冻结断言：配置一旦漂移，零 `ComputeCommand` 派发的论据（research §1.6）就不再成立，
  // 所以 MUST 在构造任何东西之前失败，而不是带着漂移的配置继续跑出一张"看起来还行"的帧。
  try {
    assertMvpSceneOptions();
  } catch (cause) {
    const failure = diagnosticOf(
      "internal",
      `createTerrainScene refuses to compose a scene with a drifted MVP configuration: ${messageOf(cause)}`,
      cause,
    );
    diagnostics.report(failure);
    return { ready: Promise.resolve(), controller: createFailedSceneController(diagnostics, failure) };
  }

  const configuration = MVP_SCENE_CONFIGURATION;
  /** 正在累加的那一帧；`debugCommandFilter` 写它。 */
  let frameCommands: CommandTally = { drawCalls: 0, triangles: 0 };
  /** 最近一帧完成的几何量；`stats()` 读它。 */
  const commands: CommandTally = { drawCalls: 0, triangles: 0 };
  const frameTimes = createFrameTimeWindow();
  const servedTiles = new Set<string>();
  let tileReadsServed = 0;
  let tileReadsPending = 0;
  let tileReadFailures = 0;
  let lastPixels: { pixels: Uint8Array; width: number; height: number; background: RgbaBytes } | undefined;
  let pendingCapture: PendingCapture | null = null;
  const frameWaiters: Array<() => void> = [];
  let scheduledFrame: number | null = null;
  let activeScene: Scene | null = null;
  let seam: SceneSeam | null = null;
  let disposed = false;
  let failure: DiagnosticErrorShape | null = null;

  const sceneTime = JulianDate.fromIso8601(SCENE_TIME_ISO);

  /** 地形读取包装器：只为**计数**与"读失败"的可观察性存在（数据面统计与 `pendingTiles` 都来自它）。 */
  const readTile: TileReader = async (tilePath: string): Promise<Uint8Array> => {
    tileReadsPending += 1;
    try {
      const response = await fetch(tilePath);
      if (!response.ok) {
        throw new TerrainSourceError(
          "data-unavailable",
          `terrain request failed: ${response.status} ${response.statusText} for ${tilePath}`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!servedTiles.has(tilePath)) {
        servedTiles.add(tilePath);
        tileReadsServed += 1;
      }
      return bytes;
    } catch (cause) {
      // 取不到数据是**数据问题**，MUST 与渲染失败区分开（FR-004）。在这里上报是因为
      // `src/terrain/source.ts` 的 callback 会把这个失败吞成"数据集底面高度的平地"
      // （contract T-6：不给错误几何），不在这里报就没人报得出来。
      tileReadFailures += 1;
      diagnostics.report(diagnosticOf("data-unavailable", `terrain data unavailable: ${messageOf(cause)}`, cause));
      throw cause;
    } finally {
      tileReadsPending -= 1;
    }
  };

  /** 上报一次渲染期失败（构造失败、渲染抛错、GPU 校验错误都走这里），并返回规范化后的诊断。 */
  function reportRenderFailure(context: string, cause: unknown): DiagnosticErrorShape {
    const diagnostic =
      cause instanceof TerrainSourceError
        ? diagnosticOf("data-unavailable", `${context}: ${cause.message}`, cause)
        : diagnosticOf("render-failed", `${context}: ${messageOf(cause)}`, cause);
    diagnostics.report(diagnostic);
    return diagnostic;
  }

  /** 唤醒所有等帧的调用（销毁/致命失败时必须调用，否则等待者永远醒不过来）。 */
  function drainFrameWaiters(): void {
    while (frameWaiters.length > 0) {
      const waiter = frameWaiters.shift();
      if (waiter !== undefined) waiter();
    }
  }

  function failPendingCapture(diagnostic: DiagnosticErrorShape): void {
    const capture = pendingCapture;
    pendingCapture = null;
    if (capture !== null) capture.reject(Object.assign(new Error(diagnostic.message), diagnostic));
  }

  /** 停止循环（销毁或致命失败）。 */
  function stopLoop(): void {
    if (scheduledFrame === null) return;
    const cancel = globalThis.cancelAnimationFrame;
    if (cancel !== undefined) cancel(scheduledFrame);
    else globalThis.clearTimeout(scheduledFrame);
    scheduledFrame = null;
  }

  /** 确保循环在跑：销毁之后 MUST NOT 再起（否则已归还的资源会被再次使用）。 */
  function ensureLoop(): void {
    if (disposed || scheduledFrame !== null) return;
    const run = (): void => {
      scheduledFrame = null;
      try {
        renderOnce();
      } catch (cause) {
        // 致命渲染错误 MUST 失败得响亮，但**不要**变成每帧一条的错误洪水：报一次、停循环；
        // 之后的 `requestRender()` 可以重新起循环，再失败就再报一次。
        failure = reportRenderFailure("scene.render() failed", cause);
        failPendingCapture(failure);
        drainFrameWaiters();
        return;
      }
      ensureLoop();
    };
    const request = globalThis.requestAnimationFrame;
    scheduledFrame = request !== undefined ? request(run) : globalThis.setTimeout(run, 16);
  }

  /**
   * 渲染一帧，并把这一帧的观测结果落进统计里。
   *
   * 捕获（`captureFrame`）刻意**在帧内、渲染调用返回之后**立刻做：两条路径都不保证绘制缓冲在帧结束后
   * 仍然可读（旧路径的默认帧缓冲会被清掉，新路径的交换链纹理会呈现出去），帧内拷贝是唯一两条路径都成立的位置。
   */
  function renderOnce(): void {
    const scene = activeScene;
    if (scene === null) return;
    const started = performance.now();
    frameCommands = { drawCalls: 0, triangles: 0 };
    seam?.initializeFrame?.();
    scene.render(sceneTime);
    frameTimes.push(performance.now() - started);
    commands.drawCalls = frameCommands.drawCalls;
    commands.triangles = frameCommands.triangles;
    const awaited = seam?.context?.awaitFrameErrors?.();
    if (awaited !== undefined) {
      void awaited.catch((cause: unknown) => {
        reportRenderFailure("the active frame produced GPU errors", cause);
      });
    }
    if (pendingCapture !== null) {
      const capture = pendingCapture;
      pendingCapture = null;
      try {
        capture.resolve(grabFrame());
      } catch (cause) {
        capture.reject(Object.assign(new Error(messageOf(cause)), reportRenderFailure("captureFrame failed", cause)));
      }
    }
    drainFrameWaiters();
  }

  /**
   * 从画布取回这一帧的像素。
   *
   * 为什么走画布而不是 `Context#readPixels`：本增量里 `readPixels` 是 slice C 的显式失败桩，
   * 而画布 → 2D 画布 → `getImageData` 是**两条路径共用**的一条读回通道（同一段代码、同一像素语义：
   * RGBA8、左上原点、非预乘），跨路径比较才谈得上同口径。
   */
  function grabFrame(): FrameCapture {
    const scene = activeScene;
    if (scene === null) throw new Error("the scene is not available");
    const source = canvas as HTMLCanvasElement;
    const width = source.width;
    const height = source.height;
    if (!(width > 0 && height > 0)) throw new Error(`the scene canvas has no drawing buffer (${width}x${height})`);
    const copy = document.createElement("canvas");
    copy.width = width;
    copy.height = height;
    const context2d = copy.getContext("2d", { willReadFrequently: true });
    if (context2d === null) {
      throw new Error("a 2D canvas context is required to read the frame back (the frame MUST NOT be reported as empty)");
    }
    context2d.drawImage(source, 0, 0);
    const image = context2d.getImageData(0, 0, width, height);
    const pixels = Uint8Array.from(image.data);
    lastPixels = { pixels, width, height, background: backgroundBytes(scene) };
    return { width, height, pixelFormat: "rgba8", origin: "top-left", premultiplied: false, pixels };
  }

  /** 等下一帧渲染完成。循环停了会重新起（否则调用方会一直等到超时）。 */
  function nextFrame(): Promise<void> {
    if (disposed || failure !== null) return Promise.resolve();
    ensureLoop();
    return new Promise<void>((resolve) => {
      frameWaiters.push(resolve);
    });
  }

  /** 把解析后的相机应用到场景；这是初始视图与 `setView` 的唯一入口。 */
  function applyCamera(scene: Scene, camera: ResolvedCamera): void {
    const destination = Cartesian3.fromDegrees(camera.longitude, camera.latitude, camera.height);
    if (destination === undefined) {
      throw new Error(
        `Cartesian3.fromDegrees(${camera.longitude}, ${camera.latitude}, ${camera.height}) produced no position`,
      );
    }
    scene.camera.setView({
      destination,
      orientation: {
        heading: CesiumMath.toRadians(camera.heading),
        pitch: CesiumMath.toRadians(camera.pitch),
        roll: CesiumMath.toRadians(camera.roll),
      },
    });
  }

  /**
   * 用**公开属性** `Scene#debugCommandFilter` 统计每帧的 draw call 与三角形数。
   *
   * 为什么是它：上游在 `executeCommand`（`Scene.js:2278`）里对**每一个**命令都会问一次这个过滤器，
   * 所以它同时看得见地形绘制与清屏，而且两条路径走的是同一段逻辑层代码 —— 跨路径统计因此同口径。
   * 它只被用来观测：回调恒返回 `true`，MUST NOT 过滤掉任何命令（过滤会改变渲染结果）。
   */
  function installCommandTally(scene: Scene): void {
    scene.debugCommandFilter = (command: unknown): boolean => {
      const shape = command as CommandShape;
      const count = shape.count;
      if (typeof count === "number" && count > 0 && (shape.primitiveType === undefined || shape.primitiveType === TRIANGLES)) {
        frameCommands.drawCalls += 1;
        frameCommands.triangles +=
          Math.floor(count / 3) * (typeof shape.instanceCount === "number" ? shape.instanceCount : 1);
      }
      return true;
    };
  }

  /** 上报 `onStatus`（FR-009）。本增量没有能力探测，所以只报"观察到的事实"并把这一点写成降级备注。 */
  function publishStatus(scene: Scene): void {
    if (options.onStatus === undefined) return;
    const active: BackendKind = (scene as unknown as SceneSeam).context?.device === undefined ? "webgl2" : "webgpu";
    const emitter = createStatusEmitter({
      onStatus: options.onStatus,
      onObserverError: (cause: unknown) => {
        diagnostics.report(diagnosticOf("internal", `onStatus threw: ${messageOf(cause)}`, cause));
      },
    });
    emitter.emit({
      active,
      reason: "ok",
      degraded: true,
      notes: [
        "the active path is observed from the live context rather than chosen by a capability probe: the probe and the " +
          "whole-backend switch are W6 (T099–T101), so this status reports what runs, not why it was picked",
      ],
    });
  }

  // ---- 异步部分：地形数据 + 逐帧循环。任何失败都上报，`ready` 永不 reject。 ------------------------
  const ready = (async (): Promise<void> => {
    try {
      for (const diagnostic of entryDiagnostics) diagnostics.report(diagnostic);

      const scene = new Scene({
        canvas: canvas as HTMLCanvasElement,
        contextOptions: configuration.sceneOptions.contextOptions,
        scene3DOnly: configuration.sceneOptions.scene3DOnly,
        requestRenderMode: configuration.sceneOptions.requestRenderMode,
      });
      activeScene = scene;
      seam = scene as unknown as SceneSeam;
      // 上游 `Scene` 的构造函数不接受 `logarithmicDepthBuffer`，只能经 setter 压回冻结值；
      // 它若被打开，WGSL 闭包会拒绝 `LOG_DEPTH` 变体（`scene-options.ts:57-65`），所以这里 MUST 复核。
      scene.logarithmicDepthBuffer = configuration.sceneOptions.logarithmicDepthBuffer;
      if (scene.logarithmicDepthBuffer !== false) {
        throw new Error("the scene turned the logarithmic depth buffer back on; the WGSL closure has no LOG_DEPTH region");
      }

      // 三个 `false` 的实现方式是"不构造这些对象"（见文件头注释），`Globe` 是场景里唯一的内容。
      const globe = new Globe();
      scene.globe = globe;
      globe.enableLighting = MVP_GLOBE_OPTIONS.enableLighting;
      globe.depthTestAgainstTerrain = MVP_GLOBE_OPTIONS.depthTestAgainstTerrain;

      applyCamera(scene, defaultCamera);
      installCommandTally(scene);
      scene.renderError.addEventListener((_scene: unknown, error: unknown) => {
        // 上游 `Scene.render` 会捕获渲染异常并只发事件（默认不重抛），不订阅就等于把失败丢掉。
        reportRenderFailure("the scene reported a render error", error);
      });
      publishStatus(scene);

      const provider = await createTerrainProvider({
        mode: "fixture",
        datasetId: options.datasetId,
        fixtureBaseUrl: FIXTURE_BASE_URL,
        readTile,
      });
      if (disposed) {
        // 构造期间被销毁：MUST NOT 把场景留活（否则句柄已经关掉、资源却还在）。
        // 销毁是幂等的：`dispose()` 可能已经销毁过它，重复销毁会抛 DeveloperError。
        if (!scene.isDestroyed()) scene.destroy();
        activeScene = null;
        return;
      }
      scene.terrainProvider = provider;

      renderOnce();
      ensureLoop();
    } catch (cause) {
      const alreadyReported =
        cause instanceof TerrainSourceError && cause.category === "data-unavailable" && tileReadFailures > 0;
      failure =
        cause instanceof TerrainSourceError
          ? diagnosticOf("data-unavailable", `terrain source failed: ${cause.message}`, cause)
          : reportRenderFailure("createTerrainScene could not bring up the scene", cause);
      // 读失败已经在 `readTile` 里报过一次，这里不重复上报同一次失败；但 `failure` MUST 落下 ——
      // 否则句柄会带着半构造的场景继续接受 `captureFrame`/`whenTilesLoaded`（静默降级）。
      if (!alreadyReported) diagnostics.report(failure);
      failPendingCapture(failure);
      drainFrameWaiters();
      stopLoop();
    }
  })();

  const controller: SceneController = {
    async whenTilesLoaded(whenOptions) {
      if (disposed) return { loaded: false, pendingTiles: 0 };
      // 先等构造结束：构造还没完成就按超时判定会误报"数据不可用"。
      await ready;
      const scene = activeScene;
      if (scene === null) return { loaded: false, pendingTiles: 0 };
      const requested = whenOptions?.timeoutMs;
      const timeoutMs =
        requested === undefined || (typeof requested === "number" && Number.isFinite(requested) && requested >= 0)
          ? (requested ?? DEFAULT_TILES_TIMEOUT_MS)
          : DEFAULT_TILES_TIMEOUT_MS;
      if (requested !== undefined && timeoutMs !== requested) {
        diagnostics.report(
          diagnosticOf(
            "internal",
            `whenTilesLoaded: timeoutMs MUST be a finite non-negative number (got ${String(requested)}); using ${DEFAULT_TILES_TIMEOUT_MS} ms`,
          ),
        );
      }
      const deadline = performance.now() + timeoutMs;
      while (!disposed && scene.globe.tilesLoaded !== true && performance.now() < deadline) {
        await nextFrame();
      }
      const loaded = !disposed && scene.globe.tilesLoaded === true;
      if (!loaded) {
        // 超时/未加载完 MUST 作为"数据不可用"可观察，而不是一个静默的 false（FR-004 / T088）。
        diagnostics.report(
          diagnosticOf(
            "data-unavailable",
            `terrain tiles were still loading after ${timeoutMs} ms (tile reads in flight: ${tileReadsPending})`,
          ),
        );
      }
      return { loaded, pendingTiles: loaded ? 0 : tileReadsPending };
    },

    captureFrame() {
      if (disposed) {
        const diagnostic = diagnosticOf("internal", "captureFrame: the scene has been disposed");
        diagnostics.report(diagnostic);
        return Promise.reject(Object.assign(new Error(diagnostic.message), diagnostic));
      }
      if (failure !== null) return Promise.reject(Object.assign(new Error(failure.message), failure));
      if (pendingCapture !== null) {
        const diagnostic = diagnosticOf(
          "internal",
          "captureFrame: another capture is already in flight (one frame produces one capture)",
        );
        diagnostics.report(diagnostic);
        return Promise.reject(Object.assign(new Error(diagnostic.message), diagnostic));
      }
      return new Promise<FrameCapture>((resolve, reject) => {
        pendingCapture = { resolve, reject };
        ensureLoop();
      });
    },

    stats(): FrameStatistics {
      if (failure !== null) return unmeasuredFrameStatistics();
      const snapshot: FrameStatisticsSnapshot = assembleFrameStatistics({
        frameTimes,
        commands,
        tileCount: tileReadsServed,
        ...(lastPixels === undefined ? {} : { pixels: lastPixels }),
      });
      return snapshot;
    },

    resetStats() {
      frameTimes.reset();
      commands.drawCalls = 0;
      commands.triangles = 0;
      frameCommands = { drawCalls: 0, triangles: 0 };
      // 瓦片计数也在统计口径内：不一起清掉的话 `tileCount` 会跨 reset 累加，与帧时间窗口对不上。
      servedTiles.clear();
      tileReadsServed = 0;
      lastPixels = undefined;
    },

    setView(camera) {
      const scene = activeScene;
      if (scene === null) {
        diagnostics.report(diagnosticOf("internal", "setView: the scene is not available"));
        return;
      }
      try {
        applyCamera(scene, camera === undefined ? defaultCamera : resolveCamera(camera));
      } catch (cause) {
        diagnostics.report(diagnosticOf("internal", `setView: ${messageOf(cause)}`, cause));
        return;
      }
      // 视图变了就必须有一帧来兑现它（循环是连续的，但"至少再渲染一帧"由这里保证）。
      controller.requestRender();
    },

    requestRender() {
      const scene = activeScene;
      if (scene === null) {
        diagnostics.report(diagnosticOf("internal", "requestRender: the scene is not available"));
        return;
      }
      // `requestRenderMode` 是冻结的 false（连续渲染），所以这一句本身不改变"是否会渲染"；
      // 真正兑现"现在渲染"的是 `ensureLoop()` —— 循环因致命帧错误停下时由它重新起。
      scene.requestRender();
      ensureLoop();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopLoop();
      failPendingCapture(diagnosticOf("internal", "dispose(): the frame capture in flight could not be completed"));
      drainFrameWaiters();
      const scene = activeScene;
      activeScene = null;
      if (scene !== null) {
        try {
          scene.destroy();
        } catch (cause) {
          diagnostics.report(diagnosticOf("render-failed", `scene.destroy() failed: ${messageOf(cause)}`, cause));
        }
      }
      // 只摘自己建的那张画布：复用来的画布属于调用方（验收 harness 还要对它截图），MUST NOT 删掉。
      if (ownedCanvas) canvas?.remove();
    },
  };

  return { ready, controller };
}

/** 实测容器尺寸；取不到（尚未布局、隐藏）时返回 `undefined`，由 `resolveViewport` 退回固定默认视口。 */
function containerSize(
  container: HTMLElement,
): { width: number; height: number; devicePixelRatio: number } | undefined {
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (!(width > 0) || !(height > 0)) return undefined;
  return { width, height, devicePixelRatio: globalThis.devicePixelRatio ?? 1 };
}

/**
 * 决定渲染目标画布：**优先复用容器里已经存在的 `<canvas>`**，没有才新建一个并追加进容器。
 *
 * 为什么必须复用（不是可选优化）：验收 harness 固定只对**页面里预置的**那个画布元素截图
 * （`tests/support/contract-harness.mjs` 的 `captureCanvasRegion` → `locator("#contract-canvas")`），
 * 而契约页 `tests/contract/page/index.html` 预置了 `#contract-container > canvas#contract-canvas`。
 * 若入口无视它、总是新建一张画布，渲染就落在截图取不到的新元素上 —— 验收臂只会看到一张永远黑的截图，
 * 并把"接不到像素"误判成实现缺陷。
 *
 * 尺寸仍然按解析出的**固定视口**设置（复用调用方的画布也一样）：视口是本次会话的固定条件，
 * 容器里预先存在的画布尺寸 MUST NOT 悄悄改变捕获尺寸。
 */
function resolveSceneCanvas(container: HTMLElement, viewport: ResolvedViewport): { canvas: HTMLCanvasElement; owned: boolean } {
  const existing = container.querySelector("canvas");
  const owned = existing === null;
  const canvas = existing ?? document.createElement("canvas");
  const backing = backingStoreSize(viewport);
  canvas.width = backing.width;
  canvas.height = backing.height;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  if (owned) {
    canvas.setAttribute("data-cesium-webgpu-scene", "");
    container.appendChild(canvas);
  }
  return { canvas, owned };
}

/**
 * 场景背景色对应的 RGBA8 字节。
 *
 * `nonBackgroundRatio` 的"背景"因此是**配置里的确定值**（默认 `Color.BLACK`），不是从画面里猜的众数；
 * 拷贝通道的舍入差由 `frame-statistics.ts` 的容差吸收。
 */
function backgroundBytes(scene: Scene): RgbaBytes {
  const background = scene.backgroundColor;
  const toByte = (value: number): number => Math.min(255, Math.max(0, Math.round(value * 255)));
  return {
    r: toByte(background.red),
    g: toByte(background.green),
    b: toByte(background.blue),
    a: toByte(background.alpha),
  };
}
