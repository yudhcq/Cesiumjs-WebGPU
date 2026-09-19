/**
 * T089 — 公开入口的场景构造与句柄（`tests/unit/scene-config.test.mjs`）。
 *
 * 三个必查项：
 *   (a) **A6**：MVP 场景配置把 `baseLayer` / `skyBox` / `skyAtmosphere` 三个 `false` 钉死 ——
 *       这是"零 `ComputeCommand` 派发"（research §1.6）能被论证的前提；
 *   (b) `globe.enableLighting === true`；
 *   (c) `TerrainSceneHandle` 的 9 个成员**真的实现了**。
 *
 * 断言分两层，都不需要 GPU / DOM / 浏览器：
 *   - **纯函数级**：`src/compose/scene-config.ts`、`src/compose/frame-statistics.ts`、
 *     `src/compose/handle.ts` 不 import 任何值，因此可以被 Node 的类型擦除直接加载（Node 22.18+ 默认开启），
 *     用真实输入驱动 —— 句柄那 9 个成员是靠一个假控制器逐个跑出来的，不是靠源码里出现过某个字符串；
 *   - **源码级**：`src/index.ts` 与 `src/compose/scene-runtime.ts` 会 import `@cesium/engine`
 *     （Node 侧不加载它们），所以对它们的约束（直接构造上游 `Scene`、不构造 `CesiumWidget`、
 *     复用冻结配置、地形走 T086 适配层、失败分类可区分）用源码断言。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readJson, readText } from "../support/repo.mjs";

if (process.features?.typescript === false) {
  throw new Error(
    "this file executes the pure compose modules through Node's TypeScript type stripping; " +
      "run Node >= 22.18 (or start node with --experimental-strip-types)",
  );
}

const sceneOptions = await import("../../packages/cesium-webgpu/src/scene-options.ts");
const sceneConfig = await import("../../packages/cesium-webgpu/src/compose/scene-config.ts");
const frameStatistics = await import("../../packages/cesium-webgpu/src/compose/frame-statistics.ts");
const handleModule = await import("../../packages/cesium-webgpu/src/compose/handle.ts");

const indexSource = readText("packages/cesium-webgpu/src/index.ts");
const runtimeSource = readText("packages/cesium-webgpu/src/compose/scene-runtime.ts");
const sceneConfigSource = readText("packages/cesium-webgpu/src/compose/scene-config.ts");
const typesSource = readText("packages/cesium-webgpu/src/api/types.ts");

/** 公开接口里声明的成员名（括号配对取值，与 `public-api-surface.test.mjs` 同一手法）。 */
function interfaceMembers(source, name) {
  const marker = `export interface ${name}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `src/api/types.ts MUST declare "${marker}"`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        const body = source.slice(open + 1, i);
        return [...body.matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?:(]/gm)].map((match) => match[1]);
      }
    }
  }
  throw new Error(`unterminated interface ${name}`);
}

/** 假控制器：记录每一次转发，返回值由调用方指定（用来证明句柄**转发**了而不是自己编了值）。 */
function fakeController(overrides = {}) {
  const calls = [];
  const controller = {
    calls,
    whenTilesLoaded: (options) => {
      calls.push(["whenTilesLoaded", options]);
      return Promise.resolve({ loaded: true, pendingTiles: 0 });
    },
    captureFrame: () => {
      calls.push(["captureFrame"]);
      return Promise.resolve(FRAME);
    },
    stats: () => {
      calls.push(["stats"]);
      return STATISTICS;
    },
    resetStats: () => calls.push(["resetStats"]),
    setView: (camera) => calls.push(["setView", camera]),
    requestRender: () => calls.push(["requestRender"]),
    dispose: () => calls.push(["dispose"]),
    ...overrides,
  };
  return controller;
}

const FRAME = {
  width: 2,
  height: 2,
  pixelFormat: "rgba8",
  origin: "top-left",
  premultiplied: false,
  pixels: new Uint8Array(16),
};
const STATISTICS = {
  nonBackgroundRatio: 0.5,
  uniqueColorCount: 3,
  depthDiscontinuityRatio: Number.NaN,
  triangleCount: 12,
  drawCallCount: 2,
  tileCount: 4,
  frameTimeMs: { p50: 16, p95: 33 },
};

/** 组装一个句柄 + 一个可断言的诊断记录器。 */
function makeHandle(overrides = {}) {
  const reported = [];
  const listeners = new Set();
  const diagnostics = {
    report(error) {
      reported.push(error);
      for (const listener of [...listeners]) listener(error);
    },
    onError(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const controller = fakeController(overrides);
  const ready = Promise.resolve();
  const handle = handleModule.createTerrainSceneHandle({ ready, controller, diagnostics });
  return { handle, controller, diagnostics, reported, ready };
}

// ------------------------------------------------------------------------------------------------
// (a) A6 —— MVP 场景配置的三个 false
// ------------------------------------------------------------------------------------------------

test("(a) A6：MVP 场景配置把三个 false 钉死，且断言函数真的会因漂移失败", () => {
  const configuration = sceneOptions.MVP_SCENE_CONFIGURATION;
  assert.doesNotThrow(() => sceneOptions.assertMvpSceneOptions(), "冻结声明本身 MUST 满足 A6");
  for (const flag of ["baseLayer", "skyBox", "skyAtmosphere"]) {
    assert.equal(configuration.widgetOptions[flag], false, `widgetOptions.${flag} MUST be false (A6)`);
    // 反例：把标志改成 true，断言必须失败 —— 否则"钉死"只是文字。
    const drifted = {
      ...configuration,
      widgetOptions: { ...configuration.widgetOptions, [flag]: true },
    };
    assert.throws(() => sceneOptions.assertMvpSceneOptions(drifted), new RegExp(flag), `漂移的 ${flag} MUST 被拒绝`);
  }
  assert.equal(configuration.widgetOptions.postProcessStages, false, "MVP 无后处理（后处理会派发 compute 工作）");
  assert.deepEqual(sceneOptions.mvpFixedConditions(), {
    baseLayer: false,
    skyBox: false,
    skyAtmosphere: false,
  });
});

test("(a) A6：入口在构造任何对象之前断言冻结配置，且直接构造上游 Scene（不建 CesiumWidget）", () => {
  const asserted = runtimeSource.indexOf("assertMvpSceneOptions()");
  const constructed = runtimeSource.indexOf("new Scene({");
  assert.ok(asserted >= 0, "组合层 MUST 复用 scene-options.ts 的 assertMvpSceneOptions()");
  assert.ok(constructed >= 0, "组合层 MUST 直接构造上游 Scene");
  assert.ok(asserted < constructed, "配置断言 MUST 早于场景构造");
  assert.doesNotMatch(runtimeSource, /new\s+(?:CesiumWidget|Viewer)\s*\(/, "MUST NOT 构造 widget（Sun/Moon 与月面贴图会破坏离线契约）");
  assert.match(runtimeSource, /scene\.logarithmicDepthBuffer = configuration\.sceneOptions\.logarithmicDepthBuffer/);
});

// ------------------------------------------------------------------------------------------------
// (b) globe.enableLighting === true
// ------------------------------------------------------------------------------------------------

test("(b) globe.enableLighting 为 true，且组合层应用的是冻结声明里的值", () => {
  assert.equal(sceneOptions.MVP_SCENE_CONFIGURATION.globeOptions.enableLighting, true);
  assert.equal(sceneOptions.MVP_SCENE_CONFIGURATION.deterministicConditions.enableLighting, true);
  assert.equal(sceneOptions.MVP_GLOBE_OPTIONS.enableLighting, true);
  assert.match(runtimeSource, /globe\.enableLighting = MVP_GLOBE_OPTIONS\.enableLighting/);
  assert.match(runtimeSource, /globe\.depthTestAgainstTerrain = MVP_GLOBE_OPTIONS\.depthTestAgainstTerrain/);
  assert.equal(sceneOptions.MVP_SCENE_CONFIGURATION.globeOptions.depthTestAgainstTerrain, true);
});

// ------------------------------------------------------------------------------------------------
// (c) 句柄 9 个成员
// ------------------------------------------------------------------------------------------------

test("(c) 句柄实现了 TerrainSceneHandle 的全部成员，成员集合与公开接口一字不差", () => {
  const { handle } = makeHandle();
  const implemented = Object.keys(handle).sort();
  const declared = interfaceMembers(typesSource, "TerrainSceneHandle").sort();
  assert.deepEqual(declared, [
    "captureFrame",
    "diagnostics",
    "dispose",
    "ready",
    "requestRender",
    "resetStats",
    "setView",
    "stats",
    "whenTilesLoaded",
  ]);
  assert.deepEqual(implemented, declared, "句柄的成员集合 MUST 与 TerrainSceneHandle 声明一致（不多不少）");
  for (const member of declared) {
    assert.notEqual(handle[member], undefined, `handle.${member} MUST be implemented`);
  }
});

test("(c) ready 原样透出给调用方（构造方保证它不 reject）", async () => {
  const { handle, ready } = makeHandle();
  assert.equal(handle.ready, ready, "句柄 MUST NOT 包一层会改变 ready 语义的 promise");
  await handle.ready;
});

test("(c) whenTilesLoaded 转发 timeoutMs 并返回控制器给出的结果", async () => {
  const { handle, controller } = makeHandle();
  const result = await handle.whenTilesLoaded({ timeoutMs: 1234 });
  assert.deepEqual(result, { loaded: true, pendingTiles: 0 });
  assert.deepEqual(controller.calls.at(-1), ["whenTilesLoaded", { timeoutMs: 1234 }]);

  const withoutOptions = makeHandle();
  await withoutOptions.handle.whenTilesLoaded();
  assert.deepEqual(withoutOptions.controller.calls.at(-1), ["whenTilesLoaded", undefined]);
});

test("(c) captureFrame 返回控制器给出的帧，不做任何改写", async () => {
  const { handle } = makeHandle();
  const frame = await handle.captureFrame();
  assert.equal(frame, FRAME, "帧对象 MUST 原样透出（RGBA8 / 左上原点 / 非预乘由实现方负责）");
});

test("(c) stats 与 resetStats 转发到控制器", () => {
  const { handle, controller } = makeHandle();
  assert.equal(handle.stats(), STATISTICS);
  handle.resetStats();
  assert.deepEqual(controller.calls.at(-1), ["resetStats"]);
});

test("(c) setView 把相机交给控制器；requestRender 请求一帧", () => {
  const { handle, controller } = makeHandle();
  const camera = { longitude: 6.8652, latitude: 45.8326, height: 24_000 };
  handle.setView(camera);
  assert.deepEqual(controller.calls.at(-1), ["setView", camera]);
  handle.requestRender();
  assert.deepEqual(controller.calls.at(-1), ["requestRender"]);
});

test("(c) dispose 幂等：销毁只发生一次，且之后 MUST NOT 再触碰控制器", async () => {
  const { handle, controller, reported } = makeHandle();
  handle.dispose();
  handle.dispose();
  handle.dispose();
  assert.equal(controller.calls.filter(([name]) => name === "dispose").length, 1, "第二次 dispose MUST NOT 再销毁一遍");

  handle.setView({ longitude: 0, latitude: 0, height: 1 });
  handle.requestRender();
  handle.resetStats();
  assert.equal(controller.calls.filter(([name]) => name !== "dispose").length, 0, "销毁后 MUST NOT 把调用转给控制器");
  assert.ok(reported.length >= 3, "销毁后的调用 MUST 各上报一条诊断（MUST NOT 静默）");
  for (const diagnostic of reported) assert.equal(diagnostic.category, "internal");

  const tiles = await handle.whenTilesLoaded();
  assert.deepEqual(tiles, { loaded: false, pendingTiles: 0 }, "已销毁的场景里没有瓦片在加载");
  await assert.rejects(() => handle.captureFrame(), /dispose/, "销毁后 MUST 拒绝给出帧，而不是给一张空帧");
});

test("(c) diagnostics.onError 可订阅、可退订，并且能收到上报的诊断", () => {
  const { handle, diagnostics } = makeHandle();
  const seen = [];
  const unsubscribe = handle.diagnostics.onError((error) => seen.push(error));
  const diagnostic = { category: "data-unavailable", message: "tile 12/4252/1005.hgt could not be read" };
  diagnostics.report(diagnostic);
  assert.deepEqual(seen, [diagnostic]);
  unsubscribe();
  diagnostics.report({ category: "render-failed", message: "after unsubscribe" });
  assert.equal(seen.length, 1, "退订之后 MUST NOT 再收到诊断");
});

// ------------------------------------------------------------------------------------------------
// 场景构造的源码级约束（入口 + 组合层）
// ------------------------------------------------------------------------------------------------

test("入口保持契约签名，并把组合交给 compose 层（导出符号集不变）", () => {
  assert.match(indexSource, /export function createTerrainScene\(options: TerrainSceneOptions\): TerrainSceneHandle/);
  assert.match(indexSource, /createTerrainSceneComposition\(options, entryDiagnostics\(options\)\)/);
  assert.doesNotMatch(indexSource, /export\s+(?:const|function|class)\s+(?!createTerrainScene)/, "入口 MUST NOT 新增导出符号");
});

test("入口对无法兑现的能力上报 not-implemented（FR-033：能力缺失必须响亮失败）", () => {
  assert.match(indexSource, /category: "not-implemented"/);
  assert.match(indexSource, /preference/, "被上报的能力就是显式 preference（能力探测与整体切换属 W6）");
});

test("容器里已存在的 canvas 被复用（验收 harness 只对预置画布截图），只有新建的才追加", () => {
  assert.match(runtimeSource, /container\.querySelector\("canvas"\)/, "MUST 先找容器里已有的画布");
  assert.match(runtimeSource, /const owned = existing === null/, "复用与新建 MUST 被区分开");
  assert.match(runtimeSource, /container\.appendChild\(canvas\)/, "只有没有可用画布时才新建并追加");
  assert.match(runtimeSource, /if \(ownedCanvas\) canvas\?\.remove\(\)/, "复用来的画布属于调用方，MUST NOT 在 dispose 时删掉");
});

test("地形数据源走 T086 适配层，默认是离线 fixture，基址是仓库根下的已提交目录", () => {
  assert.match(runtimeSource, /createTerrainProvider\(\{[\s\S]{0,200}?mode: "fixture"/);
  assert.match(runtimeSource, /fixtureBaseUrl: FIXTURE_BASE_URL/);
  assert.equal(sceneConfig.FIXTURE_BASE_URL, "/packages/cesium-webgpu/fixtures");
  assert.match(sceneConfigSource, /\/packages\/cesium-webgpu\/fixtures/, "基址假设 MUST 写在代码注释/常量旁边");
  // 基址是 `<datasetId>` 的父目录：适配层负责拼 `<fixtureBaseUrl>/<datasetId>`。
  assert.match(
    readText("packages/cesium-webgpu/src/terrain/source.ts"),
    /joinPath\(fixtureBaseUrl, options\.datasetId\)/,
    "T086 适配层的拼接方式变了，基址常量就必须跟着改",
  );
  assert.match(runtimeSource, /scene\.terrainProvider = provider/);
});

test("失败分类可区分：地形数据问题走 data-unavailable，渲染/构造问题走 render-failed", () => {
  assert.match(runtimeSource, /diagnosticOf\(\s*"data-unavailable"/);
  assert.match(runtimeSource, /diagnosticOf\("data-unavailable", `terrain data unavailable/);
  assert.match(runtimeSource, /diagnosticOf\("render-failed"/);
  assert.match(runtimeSource, /ready = \(async \(\): Promise<void> => \{/, "构造流程本身 MUST 不 reject");
  assert.match(runtimeSource, /scene\.renderError\.addEventListener/);
  assert.match(runtimeSource, /awaitFrameErrors\?\.\(\)/, "帧级 GPU 错误 MUST 被 await，否则等于静默");
});

test("默认相机落在已提交数据集的 level-12 覆盖区内（否则默认视图一片空瓦片）", () => {
  const manifest = readJson("packages/cesium-webgpu/fixtures/matterhorn-z0-12/manifest.json");
  const span = 180 / 2 ** 12;
  const x = Math.floor((sceneConfig.DEFAULT_CAMERA.longitude + 180) / span);
  const y = Math.floor((90 - sceneConfig.DEFAULT_CAMERA.latitude) / span);
  const tiles = new Set(manifest.tiles.map((tile) => `${tile.level}/${tile.x}/${tile.y}`));
  assert.ok(
    tiles.has(`12/${x}/${y}`),
    `default camera ${sceneConfig.DEFAULT_CAMERA.latitude},${sceneConfig.DEFAULT_CAMERA.longitude} MUST fall inside the committed dataset (tile 12/${x}/${y} missing)`,
  );
});

// ------------------------------------------------------------------------------------------------
// 纯函数：构造输入解析
// ------------------------------------------------------------------------------------------------

test("resolveCamera 补齐缺省角度，并拒绝非有限值（MUST NOT 静默用 NaN 相机）", () => {
  assert.deepEqual(sceneConfig.resolveCamera(), sceneConfig.DEFAULT_CAMERA);
  const partial = sceneConfig.resolveCamera({ longitude: 1, latitude: 2, height: 3 });
  assert.deepEqual(partial, { longitude: 1, latitude: 2, height: 3, heading: 0, pitch: -50, roll: 0 });
  assert.throws(() => sceneConfig.resolveCamera({ longitude: Number.NaN, latitude: 2, height: 3 }), /longitude/);
  assert.throws(() => sceneConfig.resolveCamera({ longitude: 1, latitude: 2, height: Number.POSITIVE_INFINITY }), /height/);
});

test("resolveViewport 固定显式视口；缺省时量取容器；都拿不到时退回固定默认值", () => {
  assert.deepEqual(sceneConfig.resolveViewport({ width: 800, height: 600, devicePixelRatio: 2 }), {
    width: 800,
    height: 600,
    devicePixelRatio: 2,
  });
  assert.deepEqual(sceneConfig.resolveViewport(undefined, { width: 500, height: 400, devicePixelRatio: 1.5 }), {
    width: 500,
    height: 400,
    devicePixelRatio: 1.5,
  });
  assert.deepEqual(sceneConfig.resolveViewport(), sceneConfig.DEFAULT_VIEWPORT);
  // 显式给出的退化尺寸是调用方的契约错误：响亮失败，MUST NOT 悄悄换成一个 1 像素画布。
  assert.throws(() => sceneConfig.resolveViewport({ width: 0, height: 10, devicePixelRatio: 1 }), /viewport\.width/);
  assert.throws(() => sceneConfig.resolveViewport({ width: 10, height: 10, devicePixelRatio: 0 }), /devicePixelRatio/);
  assert.deepEqual(sceneConfig.backingStoreSize({ width: 384, height: 288, devicePixelRatio: 2 }), {
    width: 768,
    height: 576,
  });
});

// ------------------------------------------------------------------------------------------------
// 纯函数：帧统计
// ------------------------------------------------------------------------------------------------

test("percentile 用最近秩：p95 一定是真实观测到的一帧", () => {
  const samples = Array.from({ length: 100 }, (_value, index) => index + 1);
  assert.equal(frameStatistics.percentile(samples, 0.5), 50);
  assert.equal(frameStatistics.percentile(samples, 0.95), 95);
  assert.equal(frameStatistics.percentile([7], 0.95), 7);
  assert.ok(Number.isNaN(frameStatistics.percentile([], 0.5)), "没有样本时是未测量（NaN），不是 0");
  assert.throws(() => frameStatistics.percentile([1, 2], 0), /fraction/);
});

test("summarisePixels 数出非背景覆盖率与去重颜色数；背景是配置里的确定值", () => {
  const black = { r: 0, g: 0, b: 0, a: 255 };
  // 2x2：一个背景像素 + 三个不同颜色。
  const pixels = Uint8Array.from([
    0, 0, 0, 255, 10, 20, 30, 255,
    40, 50, 60, 255, 40, 50, 60, 255,
  ]);
  const summary = frameStatistics.summarisePixels(pixels, 2, 2, black);
  assert.equal(summary.nonBackgroundRatio, 0.75);
  assert.equal(summary.uniqueColorCount, 3);
  // 容差之内的差异不算非背景（画布拷贝的舍入差），超出容差才算。
  const withinTolerance = frameStatistics.summarisePixels(pixels, 2, 2, { r: 1, g: 1, b: 1, a: 255 });
  assert.equal(withinTolerance.nonBackgroundRatio, 0.75);
  assert.throws(() => frameStatistics.summarisePixels(new Uint8Array(15), 2, 2, black), /expected 16/);
});

test("depth 不可读时 depthDiscontinuityRatio 是 NaN —— MUST NOT 用 0 冒充\"没有不连续\"", () => {
  assert.ok(Number.isNaN(frameStatistics.depthDiscontinuityRatio(undefined, 4, 4)));
  const flat = new Float32Array(16).fill(0.5);
  assert.equal(frameStatistics.depthDiscontinuityRatio(flat, 4, 4), 0, "真的读到 depth 时 0 是一个可断言的结论");
  const stepped = Float32Array.from({ length: 16 }, (_value, index) => (index % 4 < 2 ? 0.1 : 0.9));
  assert.ok(frameStatistics.depthDiscontinuityRatio(stepped, 4, 4) > 0);
});

test("assembleFrameStatistics：没捕获过帧时像素类统计是未测量，几何计数照实报", () => {
  const frameTimes = frameStatistics.createFrameTimeWindow(2);
  for (const sample of [10, 20, 30]) frameTimes.push(sample);
  const snapshot = frameStatistics.assembleFrameStatistics({
    frameTimes,
    commands: { drawCalls: 7, triangles: 42 },
    tileCount: 3,
  });
  assert.equal(snapshot.drawCallCount, 7);
  assert.equal(snapshot.triangleCount, 42);
  assert.equal(snapshot.tileCount, 3);
  assert.deepEqual(snapshot.frameTimeMs, { p50: 20, p95: 30 }, "窗口只保留最近 2 帧");
  assert.ok(Number.isNaN(snapshot.nonBackgroundRatio));
  assert.ok(Number.isNaN(snapshot.uniqueColorCount));
  assert.ok(Number.isNaN(snapshot.depthDiscontinuityRatio));
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "depthDiscontinuityRatio",
    "drawCallCount",
    "frameTimeMs",
    "nonBackgroundRatio",
    "tileCount",
    "triangleCount",
    "uniqueColorCount",
  ]);
});
