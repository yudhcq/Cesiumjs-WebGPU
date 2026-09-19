/**
 * T089 — scene-composition inputs (`packages/cesium-webgpu/src/compose/scene-config.ts`).
 *
 * 这个模块只做一件事：把**入口参数没有给出的**那些构造输入补成确定值（默认相机、固定视口、
 * 固定场景时刻、fixture 基址），并校验调用方给出的值本身可用。它不构造任何上游对象。
 *
 * WHY IT HAS NO IMPORTS AT ALL（这不是风格问题，是刻意的）
 *   1. 它必须在**没有 GPU、没有 DOM、没有浏览器**的情况下可执行 —— `tests/unit/scene-config.test.mjs`
 *      直接用 Node 的类型擦除加载本模块并调用这些函数（纯函数级断言），而不是只对源码做正则匹配；
 *      一旦这里 import 了 `@cesium/engine` 或任何相对路径的 `.js` 模块，Node 侧就加载不了。
 *   2. 场景**配置**本身不在这里：MVP 集合的唯一冻结声明是 `../scene-options.ts`
 *      （`MVP_SCENE_CONFIGURATION` / `assertMvpSceneOptions`，架构规则 A6），T089 MUST 复用它，
 *      MUST NOT 在本文件里另写一份 `baseLayer/skyBox/skyAtmosphere`。
 */

/**
 * 已提交数据集的静态基址（相对仓库根）。
 *
 * 假设（必须成立，否则地形一个瓦片都取不到）：demo 页与契约页都由**仓库根**的静态服务器提供
 * （`apps/demo/index.html` 与 `tests/contract/page/**` 的加载基址都是仓库根），因此
 * `packages/cesium-webgpu/fixtures/<datasetId>/…` 在页面里就是 `/packages/cesium-webgpu/fixtures/<datasetId>/…`。
 * `createTerrainProvider` 会把 `<fixtureBaseUrl>/<datasetId>` 拼起来（`src/terrain/source.ts:210`），
 * 所以这里给的是 `<datasetId>` 的**父目录**，而不是数据集目录本身。
 */
export const FIXTURE_BASE_URL = "/packages/cesium-webgpu/fixtures";

/**
 * 固定的场景时刻（ISO-8601）。
 *
 * 为什么必须固定：太阳方向由场景时刻决定，而 `globe.enableLighting = true` 意味着光照结果参与像素比较。
 * 这个瞬间与 W5 terrain-probe（`tests/contract/page/probe.js` 的 `renderFrames`）用的是同一个值，
 * 于是产品入口渲染出的帧与已记录的参考帧/探针证据处于同一光照条件下，两次捕获才可比。
 */
export const SCENE_TIME_ISO = "2026-03-20T12:00:00Z";

/** 相机全量值：`TerrainCameraOptions` 的三个角度在这里已经是"已解析"的（不留 undefined）。 */
export interface ResolvedCamera {
  readonly longitude: number;
  readonly latitude: number;
  readonly height: number;
  readonly heading: number;
  readonly pitch: number;
  readonly roll: number;
}

/** 调用方可给出的相机子集（与 `TerrainCameraOptions` 结构相容，刻意不 import 它）。 */
export interface CameraInput {
  readonly longitude?: number | undefined;
  readonly latitude?: number | undefined;
  readonly height?: number | undefined;
  readonly heading?: number | undefined;
  readonly pitch?: number | undefined;
  readonly roll?: number | undefined;
}

/**
 * 默认相机：勃朗峰上空 24 km、俯角 50°。
 *
 * 为什么是这个点：`tools/scripts/check-fixture.mjs` 用 `MONT_BLANC = 6.8652 E / 45.8326 N` 校验数据集，
 * 且已提交数据集 `matterhorn-z0-12` 在 level 12 的覆盖矩形只有 6.68–7.34 E / 45.66–46.19 N ——
 * 勃朗峰在覆盖区内，而马特洪峰峰顶（7.6586 E）在覆盖区外，选它会让入口的默认视图落在空瓦片上。
 * 高度/俯角沿用 W5 terrain-probe 的默认相机（同一相机、同一时刻 ⇒ 同一张可比的帧）。
 */
export const DEFAULT_CAMERA: ResolvedCamera = {
  longitude: 6.8652,
  latitude: 45.8326,
  height: 24_000,
  heading: 0,
  pitch: -50,
  roll: 0,
};

/** 视口全量值；`width/height` 是 CSS 像素，`devicePixelRatio` > 0。 */
export interface ResolvedViewport {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

/** 调用方可给出的视口子集（与 `TerrainViewportOptions` 结构相容）。 */
export interface ViewportInput {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly devicePixelRatio?: number | undefined;
}

/**
 * 默认视口 384x288 @1。
 *
 * 为什么与契约页探针一致：这是 `tests/contract/page/probe.js` 用来采集全部 W5 证据与参考帧的画布尺寸，
 * 入口默认值取同一尺寸，捕获结果才能逐像素对照；`devicePixelRatio` 固定为 1 也是出于同一原因
 * （跟随宿主 DPR 会让"同一场景"在不同机器上产生不同像素数）。
 */
export const DEFAULT_VIEWPORT: ResolvedViewport = { width: 384, height: 288, devicePixelRatio: 1 };

/** 校验一个"必须是有限数"的构造输入；失败即抛，由调用方转成 `internal` 诊断（永不静默用 NaN 相机）。 */
function requireFinite(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`camera.${field} MUST be a finite number when given (got ${String(value)})`);
  }
  return value;
}

/**
 * 补齐相机的缺省角度。
 *
 * 只补缺省、只做有限性校验：任何更"聪明"的处理（例如把越界纬度折断到 ±90）都会让调用方以为
 * 自己的输入被接受了，而实际看到的是另一个位置。
 */
export function resolveCamera(camera?: CameraInput): ResolvedCamera {
  if (camera === undefined) return DEFAULT_CAMERA;
  return {
    longitude: requireFinite(camera.longitude, DEFAULT_CAMERA.longitude, "longitude"),
    latitude: requireFinite(camera.latitude, DEFAULT_CAMERA.latitude, "latitude"),
    height: requireFinite(camera.height, DEFAULT_CAMERA.height, "height"),
    heading: requireFinite(camera.heading, DEFAULT_CAMERA.heading, "heading"),
    pitch: requireFinite(camera.pitch, DEFAULT_CAMERA.pitch, "pitch"),
    roll: requireFinite(camera.roll, DEFAULT_CAMERA.roll, "roll"),
  };
}

/** 容器在**没有**给出 `viewport` 时可提供的宿主尺寸（`HTMLElement` 的实测值）。 */
export interface ContainerSize {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

/** 把一个像素尺寸折成 ≥1 的整数：0 宽/高的画布在两条路径上都是"什么都不会画"的静默失败。 */
function requirePositiveSize(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} MUST be a positive finite number (got ${String(value)})`);
  }
  return Math.max(1, Math.round(value));
}

/**
 * 解析视口：显式给出的值**原样固定**（可复现捕获的前提），缺省时才量取容器。
 *
 * 注意这里不做"跟随容器"的监听：视口一旦确定就是本次会话的固定条件，窗口缩放 MUST NOT
 * 悄悄改变捕获尺寸（否则同一用例两次运行会得到不同像素数）。
 *
 * 两种"取不到尺寸"的处理刻意不同：**容器**量不出尺寸（尚未布局/隐藏）只是没给出提示，
 * 调用方可以只在 `viewport` 缺省时才把容器传进来，因此退回固定默认视口；而**显式**给出的
 * 0 宽/0 高/非有限值是调用方的契约错误，必须响亮失败 —— 悄悄换成默认视口会让调用方以为
 * 自己给的尺寸被接受了。
 */
export function resolveViewport(viewport?: ViewportInput, container?: ContainerSize): ResolvedViewport {
  const width = viewport?.width ?? container?.width ?? DEFAULT_VIEWPORT.width;
  const height = viewport?.height ?? container?.height ?? DEFAULT_VIEWPORT.height;
  const devicePixelRatio = viewport?.devicePixelRatio ?? container?.devicePixelRatio ?? DEFAULT_VIEWPORT.devicePixelRatio;
  if (typeof devicePixelRatio !== "number" || !Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new Error(`viewport.devicePixelRatio MUST be positive (got ${String(devicePixelRatio)})`);
  }
  return {
    width: requirePositiveSize(width, "viewport.width"),
    height: requirePositiveSize(height, "viewport.height"),
    devicePixelRatio,
  };
}

/** 画布的**后备存储**尺寸（物理像素）：宿主 DPR 只在这里参与，不下传到任何渲染配置。 */
export function backingStoreSize(viewport: ResolvedViewport): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(viewport.width * viewport.devicePixelRatio)),
    height: Math.max(1, Math.round(viewport.height * viewport.devicePixelRatio)),
  };
}

/**
 * 把 `Renderer` 需要知道的上游 `Scene` 构造选项整理出来。
 *
 * 只透传 `scene-options.ts` 里已经冻结的那些键（`scene3DOnly` / `requestRenderMode` / `contextOptions`），
 * 并把 `logarithmicDepthBuffer` 单独返回 —— 上游 `Scene` 的构造函数**不接受**它（它从静态
 * `Scene.defaultLogDepthBuffer` 起步，`scene-options.ts:57-65` 记录了为什么必须压回 false），
 * 所以它只能通过 setter 应用，且必须在第一帧之前应用完。
 */
export function describeLogDepthPin(configuration: {
  readonly sceneOptions: { readonly logarithmicDepthBuffer: boolean };
}): boolean {
  return configuration.sceneOptions.logarithmicDepthBuffer;
}
