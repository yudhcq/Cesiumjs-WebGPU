---

description: "Task list for WebGPU Terrain Rendering MVP (CesiumJS 1.145.0 external module)"
---

# Tasks: WebGPU 地形渲染 MVP（CesiumJS 1.145.0 外部模块）

**Feature**: `001-webgpu-terrain-mvp` | **Created**: 2026-09-18
**Input**: Design documents from `/specs/001-webgpu-terrain-mvp/`
**Prerequisites**: [plan.md](./plan.md)（必需）、[spec.md](./spec.md)（29 FR / 9 SC / Out of Scope）、
[research.md](./research.md)（D1–D8 / H-1…H-9 / 被否决方案）、[data-model.md](./data-model.md)（§1–§9，含 A1–A5）、
[contracts/](./contracts/)（C-1…C-10、T-1…T-11、验证与基准、`mvp-estimate.schema.json`）、[quickstart.md](./quickstart.md)

**Tests**: **必需**。constitution 原则 III「每项渲染特性必须附带自动化验证」与 FR-010/FR-011 把测试变成交付物而非可选项，
因此本清单中**每个渲染特性都与其自动化验证用例成对出现**（实现任务 + 紧邻的验证任务）。

**Organization**: 按 `plan.md` 的工作流依赖序组织（G-1 → G-2 → W1 → W2 → W3 → W4 → W5 → W6），
每个工作流为一个 phase；每个实现任务都必须能由**一个子代理在一轮内完成并自检**。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）。并行前提在该任务所在 phase 的「并行前提」小节逐条说明。
- **[Story]**: 该任务归属的 user story（US1…US5）；门禁与基建 phase 无 story 标签。
- 每个任务的描述都含**明确产出文件路径**与**完成判据**（`自检`）。

## Path Conventions

- 单仓库多包（npm workspaces，plan.md「Structure Decision」）；**仓库根即工作区根** `E:\work\CesiumjsWebGpu`。
- 主交付包：`packages/cesium-webgpu/src/**`、`packages/cesium-webgpu/fixtures/**`
- 验证脚手架（private）：`packages/verify-harness/**`
- 演示页：`apps/demo/**`；测试：`tests/{unit,contract,visual,bench}/**`；工具：`tools/**`；CI：`.github/workflows/**`
- **门禁实验**（G-1/G-2）代码**不带 story 标签**、放 `experiments/gates/**`，**不进入发布包**，验证通过后只在 `docs/` 留结论。

## 全局实现环境约束（所有任务默认生效，后续不再重复）

1. **本机无 `pwsh`（PowerShell 7）**：脚本与 CI 步骤 MUST NOT 假设 `pwsh` 存在。本机脚本用 **Windows PowerShell 5.1**
   （`powershell -NoProfile -ExecutionPolicy Bypass -File ...`）或**跨平台 Node 脚本**（`node tools/scripts/*.mjs`）；
   CI 步骤用 `bash` + `npm run`，不调用 `pwsh`。
2. **本机 Node v22.20.0 / npm 10.9.3**；npm 可直连，内网/代理端口 7890 为备用
   （`HTTPS_PROXY=http://127.0.0.1:7890`）。任何安装任务失败时先直连、再代理，**不得**因此静默跳过。
3. **CI 目标 = GitHub Actions 托管 runner（无真实 GPU）**：配方固定为 Xvfb（headed）+ Mesa lavapipe（WebGPU）
   与 ANGLE/SwiftShader（WebGL2），见 [contracts/verification-and-benchmark.md](./contracts/verification-and-benchmark.md) §7。
   无效/过时标志（`--disable-vulkan-surface`、把 `--enable-unsafe-swiftshader` 用于 WebGPU、`--headless=new`）**不得写入配置**。
4. **脚本一律用 Node/bundler API 而非 shell 拼串**（`node:fs`、Rollup JS API、Playwright API），保证 Windows/CI 行为一致。
5. **禁止项（写入任务即视为违约，由 A1–A5 与 CI 阻断）**：修改/fork/vendor/patch `cesium`；依赖 `@private`/`@experimental`/
   下划线成员；import 上游 `Source/**` 深路径；`src/api/**` 出现后端符号；`backends/webgl2` 与 `backends/webgpu` 互相 import。
6. **Out of Scope（不得出现在任何任务中）**：三维瓦片、glTF/模型、影像图层、大气与光照特效、阴影、后处理、粒子、
   矢量与标注、移动端与低端设备适配、生产级流式调度优化、凭据类地形服务、通用计算加速、上游不存在的渲染特性、正式发版节奏。

---

## Phase 1: Risk Gates G-1 / G-2（风险关闭门）

**Purpose**: 关闭 `plan.md`「实现前的验证门」中的 G-1（H-1）与 G-2（H-2）。两项结论会改变 W1+ 的实现细节，
因此 **MUST 排在所有 W1+ 实现任务之前**。

> ⛔ **门禁：未通过则回到 plan 修订**。G-1 或 G-2 任一未通过时，**STOP**，不得开始 Phase 4（W1）及之后的任何实现任务；
> 按 `research.md` §8 记录的两条退路之一修订 `plan.md`（G-1 退路：`Globe.translucency.frontFaceAlpha=0` 或允许 canvas A 正常绘制、
> 并在基准中标注额外开销；G-2 退路：改用备选 V2 观察 `frameState.commandList`），再重新派发本阶段。

> ℹ️ **门禁的阶段归属说明**：Phase 1/2 是 G-1/G-2 的最小实验与工程骨架，**是** `plan.md` 依赖序的第一段
> （`G-1 → G-2 → W1 → W2 → W3 → W4 → W5 → W6`），故排在 Setup/Foundational 之前；Phase 4 起的 user story phase
> 与 W1–W6 一一对应。为避免门禁实验代码污染交付物，实验代码放 `experiments/gates/**`，不参与 Rollup 主包构建。

**Goal**: 用 ≤0.5 工作日的最小闭环实验证明「双画布分层 + 透明上游地形 + 自定义 `TerrainProvider`」可工作（G-1），
并证明「resident ∩ 视锥 ∩ 父子截断」的可见瓦片集合与上游真实绘制集合在固定相机下等价（G-2）。

**Independent Test**: `node tools/scripts/run-gates.mjs` 在本机产出两份 JSON 结论
（`experiments/gates/out/g1.json`、`g2.json`），任一 `verdict !== "pass"` 即门禁未通过。

### G-1 最小闭环（H-1；预计 ≤0.5 工作日）

- [ ] T001 搭建门禁实验最小页面 `experiments/gates/g1-layering.html` + `experiments/gates/g1-layering.ts`：用**已发布的** `cesium@1.145.0` CDN/本地 tarball 创建 `CesiumWidget`（`contextOptions.webgl.alpha = true`），在同一容器内追加本库自建 `<canvas>`（`getContext("webgpu")`），canvas 绝对定位分层（Cesium 画布在下、WebGPU 画布在上、`pointer-events` 不阻断相机交互）；**禁止** import 本仓库任何 `src/**` 产物（门禁必须独立于尚未实现的代码）。`自检`：用 Windows PowerShell 5.1 起本地静态服务并打开页面，控制台打印两块画布的 `getContext` 类型分别为 `webgl2` 与 `webgpu`，页面无未捕获异常。`→ D1, FR-005`
- [ ] T002 在 T001 页面上完成 G-1 三件事并**采集证据**：(a) `Globe.baseColor = Color.TRANSPARENT` + 上游画布 `alpha: true`；(b) 自定义 `TerrainProvider` 子类返回 `new HeightmapTerrainData({ buffer, width, height, childTileMask, structure })`（数据来自本地固定 PNG/HGT 切片，硬编码 1–4 块瓦片即可）；(c) 用 `requestTileGeometry` 调用计数 + `globe.tileLoadProgressEvent` 证明**瓦片仍在被调度**。产出 `experiments/gates/out/g1.json`：`{layeringOk, terrainDrawnByUpstream:true, tilesRequested>0, upstreamTerrainVisible:false, screenshot:"g1.png"}` 与截图 `experiments/gates/out/g1.png`。`自检`：截图中**看不到**上游地形（只有背景/天空），但 `tilesRequested > 0`。`→ H-1, D1, D3, FR-004`
- [ ] T003 对 T001/T002 的门禁代码做**公开 API 合规扫描**并记录结论：产出 `experiments/gates/out/g1-api-usage.json`（列出用到的上游符号）与更新 `docs/gate-g1-conclusion.md`（含：用到的符号、是否全部公开、`globe.show=false` 未被采用的实测证据、`baseColor` 与 `translucency` 两条路线的实测对比、结论 pass/fail、失败时的退路选择）。扫描规则复用 A4（禁止 `._` 前缀访问与深路径 import）。`自检`：`g1-api-usage.json` 中所有符号都能在 `research.md` §1.1 的公开清单中命中，无 `@private` 符号。`→ 原则 I, A4, FR-015`

### G-2 可见瓦片集合等价性（H-2；含退路 V2）

- [ ] T004 [P] 在门禁目录内实现**可见瓦片集合规则**的可独立执行版本 `experiments/gates/g2-drawset.ts`：纯函数 `computeDrawSet(resident: TileKey[], frustum: Frustum, childrenOf: Map<TileKey, TileKey[]>) → {tiles, supersededByChildren, culledOutOfFrustum}`，规则严格按 `data-model.md` §1：**某瓦片 4 个子瓦片全部 resident 时父瓦片不绘制，否则绘制**；并输出 `FrameDrawSet`。`自检`：附带的 `g2-drawset.spec.mjs`（`node --test`）覆盖「父被 4 子替换」「子只到位 3 个 → 父绘制」「全出视锥 → 空集」三个用例，全绿。`→ H-2, data-model §1`
- [ ] T005 [P] 在门禁目录内实现**退路 V2 的观察器** `experiments/gates/g2-observer.ts`：自实现 `Primitive` 放入 `scene.primitives`，在 `update(frameState)` 中扫描 `frameState.commandList`，按 `DrawCommand` 的**公开字段**（`owner`/`boundingVolume`/`modelMatrix`/`pass`）反推本帧被绘制的瓦片集合；先核实并记录 `DrawCommand.owner` 的实际语义。`自检`：产出 `experiments/gates/out/g2-owner-semantics.md`，说明 `owner` 指向对象与被反推瓦片的一致性判据；若语义不可靠，明确记录「V2 不可用」而不是猜测。`→ H-2, V2, 被否决方案表`
- [ ] T006 执行 **G-2 等价性对比**：固定相机 + `globe.tilesLoaded === true` 后，采集 (a) T004 规则集合与 (b) T005/V2 观察集合，比较几何统计（三角形数、绘制批次数、覆盖瓦片数、经纬度范围、顶点数/索引数）与像素统计（`nonBackgroundRatio`、`uniqueColorCount`）；产出 `experiments/gates/out/g2.json`（两侧统计值、差值、声明的等价区间、`verdict`）。`自检`：两侧统计落在声明区间内 → `verdict:"pass"`；否则记录差异并明确选择退路 V2 作为 W1 的实现输入。`→ H-2, G-2, FR-008`
- [ ] T007 收敛门禁结论并**决定 W1 的绘制集合实现方式**：更新 `docs/gate-g2-conclusion.md`（规则集合 vs V2 的选择、声明的等价区间与来源、H-3 的初步观察：自建规则网格与上游网格在同高程场下是否存在接缝裂缝/z-fighting 的可见迹象），并更新 `plan.md` 中「实现前的验证门」表格的状态列（仅改状态与结论引用，不改方案）。`自检`：两份门禁结论文档均存在、均给出 pass/fail 与后续输入；若为 fail，则 `plan.md` 已按退路修订，且**尚未开始任何 W1+ 实现任务**。`→ 门禁, plan.md「实现前的验证门」`

**Checkpoint（门禁）**：G-1、G-2 均 `pass`（或已按退路修订 plan）——**此后才允许**开始 Phase 2 及之后。

---

## Phase 2: Setup（工程骨架与工具链）

**Purpose**: 建立可构建、可测试、可复现的多包骨架与工具链。门禁已给出结论，本阶段不再做实验性代码。

**⚠️ 关键**：本 phase 不含任何渲染实现；Phase 4 起的实现任务依赖本 phase 的构建与脚本约定。

- [ ] T008 [P] 创建 npm workspaces 根骨架：`package.json`（`private:true`、`workspaces:["packages/*","apps/*"]`、`engines.node >= 22`、`packageManager` 记录 npm 版本、仓库级 `scripts` 占位）与 `.gitignore`（`node_modules`、`dist`、`artifacts`、`experiments/gates/out`、`.specify/feature.json`）。`自检`：`npm ls --workspaces --depth=0` 在无子包时无错误退出；`git status` 未把 `dist`/`artifacts` 纳入跟踪。`→ 附加技术约束（Node >= 22）`
- [ ] T009 [P] 建立 TypeScript strict 基线：`tsconfig.base.json`（`strict:true`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`target/module` 适配 Node 22 与 ESM、`moduleResolution` 选 bundler/NodeNext 并在 README 记录）与 `packages/cesium-webgpu/tsconfig.json`、`packages/verify-harness/tsconfig.json`、`apps/demo/tsconfig.json` 三份继承配置。`自检`：`npx tsc -p tsconfig.base.json --noEmit` 不报配置错误。`→ 附加技术约束（TS strict）`
- [ ] T010 [P] 编写 WGSL 内联 Rollup 插件 `tools/rollup-plugin-wgsl.mjs`（把 `.wgsl` 以字符串常量导出，零第三方依赖）与其单元测试 `tests/unit/rollup-plugin-wgsl.test.mjs`（断言导入产物为字符串、多文件不串味、Windows 路径分隔符可用）。`自检`：`node --test tests/unit/rollup-plugin-wgsl.test.mjs` 全绿。`→ plan 构建链`
- [ ] T011 [P] 安装并锁定构建与测试依赖：根与子包 `devDependencies` 精确版本（`rollup`、`@rollup/plugin-typescript`、`rollup-plugin-dts`、`typescript`、`@webgpu/types`、`playwright`）与 `peerDependencies.cesium >=1.145.0 <2.0.0` + `devDependencies.cesium 1.145.0`；并**实测** Playwright 浏览器与 Chromium 版本后写入锁文件。`自检`：`npm install` 成功（直连失败则用 `HTTPS_PROXY=http://127.0.0.1:7890` 重试并在汇报中记录用了哪条路径），`package-lock.json` 存在且 `cesium` 为 1.145.0；`npx playwright --version` 可执行且版本为**精确固定值**。`→ FR-024, 契约 §3.1（Playwright 版本固定）`
- [ ] T012 编写 Rollup 多入口构建 `rollup.config.mjs`：入口为包主入口、可选逃生舱 `./escape-hatch`、演示页；产出 ESM + `.d.ts`（`rollup-plugin-dts`），构建后断言 `packages/cesium-webgpu/dist/index.d.ts` 不匹配 `/GPU[A-Z]|WebGL2RenderingContext|WebGLRenderingContext/`；`packages/cesium-webgpu/package.json` 声明 `exports`（`"."` 与 `"./escape-hatch"`，后者标注「引用即退出同构保证」）。`自检`：`npx rollup -c` 成功并在 `dist/` 生成 `index.js`、`index.d.ts`；上述正则不在 `.d.ts` 中出现。`→ 契约 render-path-api §1, 原则 II`
- [ ] T013 [P] 创建三个包的最小脚手架文件：`packages/cesium-webgpu/package.json`（`private:true` 暂缓发布、`type:"module"`、`sideEffects:false`）、`packages/verify-harness/package.json`（`private:true`）、`apps/demo/package.json`，各含 `name`/`version`/`type`/`scripts` 占位。`自检`：`npm ls --workspaces --depth=0` 列出三个包且无错误。`→ plan「Project Structure」`
- [ ] T014 建立**跨平台脚本编排**（替代 bash，规避无 `pwsh` 与本机 PowerShell 5.1 差异）：`tools/scripts/run.mjs` 统一入口 + `package.json` 中 `build`、`typecheck`、`lint`、`test:unit`、`test:contract`、`test:visual`、`bench`、`ci:local`、`demo` 脚本映射；`tools/scripts/serve.mjs`（零依赖静态服务，供演示与 Playwright 使用）。`自检`：在本机 Windows PowerShell 5.1 下 `npm run typecheck` 与 `npm run test:unit` 可执行（无测试时以 0 退出并打印 "no tests yet"）；`grep -r "pwsh" package.json tools/ .github/ 2>$null` 无命中。`→ 全局约束 1/4`
- [ ] T015 编写 CesiumJS 集成 smoke 测试 `tests/unit/cesium-public-api.test.mjs`：从 `cesium` 包入口 import 本 MVP 用到的公开符号（`CesiumWidget`、`Scene`、`Globe`、`Camera`、`PerspectiveFrustum`、`TerrainProvider`、`HeightmapTerrainData`、`TileAvailability`、`GeographicTilingScheme`、`Credit`、`TileProviderError`、`BoundingSphere`、`Matrix4`、`Color`、`Event`、`Rectangle`、`Cartographic`、`Ellipsoid`、`Resource`），断言全部为函数/类且**均从包入口导入**（无 `Source/**` 深路径）。`自检`：`node --test tests/unit/cesium-public-api.test.mjs` 全绿；该测试在无网络环境下也通过（`cesium` 已随 `npm install` 落地）。`→ 原则 I, A4, 契约 §1`

**Checkpoint**：`npm run build` + `npm run typecheck` 在本机（Windows PowerShell 5.1）与 Node 22 下均成功。

---

## Phase 3: Foundational（W1/W2 共同的阻塞前置）

**Purpose**: 后端无关核心抽象与架构边界断言。这些是被 US1 与 US2 **共同依赖**的最小基建，
不含任何地形绘制、探测或 Cesium 集成逻辑。

**⚠️ CRITICAL**: 本 phase 完成前，不得开始 Phase 4 的任何实现任务（A1–A5 断言必须先于实现存在，才能在实现过程中持续阻断违规）。

- [ ] T016 [P] 实现后端无关核心接口 `packages/cesium-webgpu/src/core/backend.ts`：定义 `RenderBackend`（资源创建、管线与管线缓存、命令编码与提交、帧生命周期）与其依赖的最小类型面；**禁止**在本文件出现任何 `GPU*`/`WebGL*`/`navigator.gpu` 具体后端符号（具体类型由 `backends/**` 提供并适配）。`自检`：`grep -nE "GPU[A-Z]|WebGL|navigator\.gpu" packages/cesium-webgpu/src/core/backend.ts` 无命中；`npm run typecheck` 通过。`→ A1/A2, 原则 II`
- [ ] T017 [P] 实现 `packages/cesium-webgpu/src/core/gpu-registry.ts`：`GpuResourceRegistry`（`createBuffer`/`createTexture`/`release`/`invalidateAll`/`stats`/`totalBytes`，按 `data-model.md` §5）；每个资源 `label` 形如 `"<kind>:<tileKey|purpose>"`；`invalidateAll()` 后所有句柄失效。附 `tests/unit/gpu-registry.test.mjs`：登记/释放后字节数守恒、`invalidateAll` 后 `stats()` 归零、重复 `release` 不产生负字节。`自检`：`node --test tests/unit/gpu-registry.test.mjs` 全绿。`→ FR-017, data-model §5`
- [ ] T018 [P] 实现 `packages/cesium-webgpu/src/core/frame-stats.ts`：按 `data-model.md` §4 的 `FrameStats`/`FrameStatsSummary` 与口径（`frameTimeMs` 取自相邻两次 `postRender` 的 `performance.now()` 差；`drawCalls`；`triangles`；`gpuResourceBytes`；p50/p95/min/max），附 `tests/unit/frame-stats.test.mjs`：固定样本序列的 p50/p95 期望值（含偶数/奇数样本、单样本、空样本）、预热帧数被排除、`resetStats()` 后清空。`自检`：`node --test tests/unit/frame-stats.test.mjs` 全绿，p50/p95 期望值在测试中**硬编码**（不由被测函数自算）。`→ FR-017, 原则 IV`
- [ ] T019 实现 `packages/cesium-webgpu/src/core/geometry.ts`：唯一几何生产者（两条路径共用，T-7）——由 `HeightField` 生成 `TileGeometry`（ECEF `positions`、`indices`、`boundingSphere`），并生成**四边裙边**（沿椭球法线下压 `skirtHeight`）；含拒绝规则：任一 `NaN`/`±Infinity` 高度、`|height| > 9000 m`、`width*height !== heights.length` 一律拒绝并按 `TileError.category="decode"` 上报，绝不产出异常顶点。`自检`：`npm run typecheck` 通过；函数签名只接受 `HeightField` + `TilingScheme` 元数据，**不接受**任何 UI/后端参数。`→ T-7, T-8, FR-016, H-3`
- [ ] T020 [P] 为 T019 的几何生产者写单元测试 `tests/unit/geometry.test.mjs`：2×2 采样小场的顶点/索引计数与手工推导值一致；**裙边顶点数 = 边界顶点数**且裙边朝向法线；注入 `NaN`、`Infinity`、`|h|=12000` 三例必须被拒绝且返回 `TileError`；边界高度突变不产生跨接缝的三角形（索引集合断言）。`自检`：`node --test tests/unit/geometry.test.mjs` 全绿；每个断言都对应一个明确数值而非"不抛异常"。`→ FR-016, FR-010（几何类缺陷数值化捕获）`
- [ ] T021 实现 `packages/cesium-webgpu/src/core/tile-registry.ts`：`TileRecord`/`TileState`/`TileAvailability` 状态机严格按 `data-model.md` §1（`absent → requested → decoding → resident → absent`，`retry(<=N)`，`fail → failed`，`availability==="no-data"` 直接以**空几何**进入 `resident`）、LRU 逐出（`lastUsedFrame`）、`resident` 必须同时保留 CPU 侧 `heightField`（供设备丢失重建）、逐帧上传预算（默认 ≤4 瓦片或 ≤8 MiB/帧）。`自检`：`npm run typecheck` 通过；状态迁移函数为纯函数、无 IO。`→ FR-003, FR-004, FR-002`
- [ ] T022 为 T021 写单元测试 `tests/unit/tile-registry.test.mjs`：合法迁移矩阵逐条断言；**非法迁移必须抛/被拒**（如 `absent → resident`）；重试耗尽 → `failed`；`no-data` 瓦片 `resident` 但三角形数为 0；LRU 逐出顺序按 `lastUsedFrame` 断言；上传预算每帧上限被强制（超出部分延后到下一帧）。`自检`：`node --test tests/unit/tile-registry.test.mjs` 全绿。`→ FR-004, FR-016, 边界用例「空瓦片」`
- [ ] T023 [P] 在 T021 的模块内实现**绘制集合截断规则**（与 T004 的门禁版本语义一致，作为生产版本并复用 T004 的测试向量）：`computeDrawSet(...)` 返回 `FrameDrawSet`（`tiles`、`supersededByChildren`、`culledOutOfFrustum`），规则：4 个子瓦片全部 `resident` → 父不绘制，否则绘制；视锥外剔除。`自检`：`node --test tests/unit/tile-registry.test.mjs` 中的 drawSet 用例（复用 T004 的三个向量 + 门禁实测结论作为第四个回合回归向量）全绿。`→ H-2/G-2 结论, FR-001, FR-008`
- [ ] T024 [P] 实现 `packages/cesium-webgpu/src/adapters/cesium/public-api-allowlist.ts`：把 `research.md` §1.1 的公开符号与 §1.2 的 `@private` 黑名单固化为两个数组 + 运行期断言函数 `assertPublicSymbol(name)`（命中黑名单即抛 `RenderPathInitError`，含符号名与依据行号），并导出注释说明来源。`自检`：`node --test` 中新增断言用例（黑名单任一符号触发异常、白名单符号不触发）全绿。`→ 原则 I, A4, research §11`
- [ ] T025 实现**架构边界断言 A1–A5** 于 `tests/unit/architecture-boundary.test.mjs`：A1 `src/api/**` 的 import 图不含 `src/backends/**`，且 `dist/index.d.ts` 不匹配 `/GPU[A-Z]|WebGL2RenderingContext|WebGLRenderingContext|navigator\.gpu/`；A2 `backends/webgl2/**` 与 `backends/webgpu/**` 的 import 图交集为空；A3 仅 `src/adapters/cesium/**` 允许 `from "cesium"`；A4 `src/**` 禁止 `from "cesium"` 后访问 `\._[a-zA-Z]`、禁止 `cesium/Source/**` 深路径；A5 `apps/demo/src/**` 只 import 包入口，`"webgpu"`/`"webgl2"` 只允许作为配置值出现。扫描器用 `node:fs` 自实现（零第三方依赖），**不使用** shell 命令。`自检`：`node --test tests/unit/architecture-boundary.test.mjs` 全绿；并为每条断言各写一个**反例 fixture**（放在 `tests/unit/__fixtures__/boundary-violations/`）证明扫描器能真的失败。`→ FR-007, A1–A5, 原则 I/II`

**Checkpoint**：基础设施就绪——`npm run build` + `npm run typecheck` + `npm run test:unit` 全绿，
且 A1–A5 已能阻断违规实现。

---

## Phase 4: User Story 1 - 地形渲染在新渲染路径下端到端跑通（P1）🎯 MVP（对应 W1）

**Goal**: 在同一上层 API `createTerrainScene` 下，WebGPU 新路径把固定数据集的多瓦片地形端到端渲染出来并可交互，
同时兜底路径仍可用（W1 交付 WebGL2 委托实现，路径选择在 US2 完善）。

**Independent Test**: `npm run test:contract -- --grep "terrain-ready"` 与 `npm run test:visual` 在 `webgpu` 路径下通过
（固定相机/时间/视口/像素比/数据集，多瓦片拼接），且 `webgl2` 路径在同一套用例下同样通过；不依赖 US2/US3 的探测与 CI 资产。

**Tests 前置说明**：本 phase 的验证任务与实现任务**成对出现**（FR-010/FR-011）；渲染行为类用例**一律 `["webgl2","webgpu"]` 参数化**。

### Implementation for User Story 1

- [ ] T026 [P] [US1] 实现 `packages/cesium-webgpu/src/terrain/heightmap.ts`：`.hgt` 紧凑格式读写（8 字节头 `"CHF1"` + `width`/`height` Uint16 LE + `width*height` 个 Uint16 LE 高程样本，行主序自北向南、自西向东）与高程解码 `height(m) = sample * heightScale + heightOffset`（`structure` 与上游 `HeightmapTerrainData.structure` 同构）；同时实现 **Terrarium 解码**（`height = R*256 + G + B/256 - 32768`，输入为已解压的 RGBA 字节，PNG 反滤波在 Node 与浏览器各由调用方完成）。`自检`：`npm run typecheck` 通过；导出的解码函数为纯函数、无 IO、无第三方依赖。`→ D5, T-7, 契约 terrain-source §3`
- [ ] T027 [P] [US1] 为 T026 写单元测试 `tests/unit/heightmap.test.mjs`：`.hgt` 往返（写→读→逐点相等）；`heightScale=0.25, heightOffset=-8192` 的精度用例；Terrarium 三条**已知向量**（`(0,0,0)` → −32768 m、`(128,0,0)` → 0 m、`(134,252,x)` 属于勃朗峰瓦片 `10/531/364` 的极值区间）与 `research.md` §6.2 的实测一致；截断/越界输入被拒。`自检`：`node --test tests/unit/heightmap.test.mjs` 全绿；期望值来自 `research.md` §6.2 的实测记录（在测试中注明来源）。`→ FR-004, T-7`
- [ ] T028 [US1] 实现 `packages/cesium-webgpu/src/terrain/source.ts`：`TerrainSource` 抽象与两种实现 —— `local-fixed`（读 `packages/cesium-webgpu/fixtures/<datasetId>/`，**离线时零外部请求**）与 `public`（`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`，免令牌、XYZ、z0–15，浏览器用 `createImageBitmap` + `OffscreenCanvas.getImageData` 解码后走**同一** Terrarium 解码函数）；两类实现都产出同一 `HeightField` 结构；请求并发上限默认 6 且超预算返回 `undefined` 交由上游重试；失败经回调上报而非抛出。`自检`：`npm run typecheck` 通过；`grep -nE "token|key=|signature" packages/cesium-webgpu/src/terrain/source.ts` 无命中（T-1）。`→ FR-004, T-1, T-2, T-4, T-5, T-11`
- [ ] T029 [US1] 实现固定数据集生成脚本 `tools/build-terrain-fixture.mjs`：`--from-public`（按 `manifest.rectangle`/`levels` 下载公开 Terrarium 瓦片 → 本地解码，**PNG 解析 + `node:zlib.inflateSync` + 反滤波 + Terrarium 解码全部自实现、零第三方依赖** → 写出 `.hgt`，并写入 `checksum`（对所有 `.hgt` 字节的稳定摘要）、`attribution`（`research.md` §6.4 的必需署名文本）、`sourceUrl`、`generatedAt`、`structure`）、`--from-local <dir>`（离线重建）、`--verify-only`（校验文件清单与 `checksum`，任何静默替换即失败）。目标：勃朗峰/大孔班山区域约 0.6°×0.5°、z0–z12，`totalBytes` 实测写入且 ≤20 MiB。`自检`：`node tools/build-terrain-fixture.mjs --verify-only` 与 `--from-public` 均以 0 退出；产出 `manifest.json` 的 `checksum` 与 `attribution` 非空；`totalBytes` 实测值打印并在 README 记录。`→ FR-004, T-10, 契约 terrain-source §3`
- [ ] T030 [US1] 生成并提交固定数据集本体到 `packages/cesium-webgpu/fixtures/<datasetId>/`（`manifest.json` + `<level>/<x>/<y>.hgt`），层级覆盖使固定相机下形成 **≥2×2 多瓦片拼接**且高程极差 >4000 m。`自检`：`node tools/build-terrain-fixture.mjs --verify-only` 通过；提交体积 ≤20 MiB（在汇报中给出实测 MiB 值）。`→ FR-012, FR-015, SC-002`
- [ ] T031 [US1] 实现上游数据注入与调度打通 `packages/cesium-webgpu/src/adapters/cesium/terrain-provider.ts`：`CesiumTerrainProviderAdapter extends TerrainProvider`，实现 `requestTileGeometry(x,y,level,request)`（返回 `Promise<HeightmapTerrainData>`，由 `source` 拿字节 → 解码 `HeightField` → **同一份** `HeightField` 既构 `new HeightmapTerrainData({buffer,width,height,childTileMask,structure})` 又交给 hooks）、`availability`（由数据集清单构建，用公开类 `TileAvailability`）、`getTileDataAvailable`（**仅**依清单回答）、`getLevelMaximumGeometricError`、`hasWaterMask=false`、`hasVertexNormals=false`、`credit`、`errorEvent`；实现 `TerrainSourceHooks`（`onTileRequested`/`onTileDecoded`/`onTileError`）。`自检`：`npm run typecheck` 通过；文件内**不出现**任何 `@private` 符号（`grep -nE "createMesh|TerrainMesh|TerrainEncoding|_surface|_tiles" 该文件` 无命中）。`→ D3, T-3, T-7, T-9, FR-004`
- [ ] T032 [US1] 实现 `packages/cesium-webgpu/src/adapters/cesium/terrain-bytes.ts`：以数据集清单为输入，用公开 `GeographicTilingScheme.tileXYToRectangle`/`rectangleToTileXY` 计算瓦片矩形（**不自行推导投影数学**），带并发队列（上限 6）与失败重试（`<=N`，耗尽 → `failed`），并把解码结果写入 `TileRegistry`（`requested → decoding → resident / failed`）。`自检`：`npm run typecheck` 通过；无上游私有符号；并发上限与重试次数可由测试注入。`→ T-3, T-4, FR-004, FR-016`
- [ ] T033 [P] [US1] 实现 `packages/cesium-webgpu/src/adapters/cesium/camera.ts`：从公开 `scene.camera.viewMatrix` 与 `camera.frustum.projectionMatrix` 构造本帧相机，并乘 GL→WebGPU 深度范围修正矩阵（`z' = 0.5z + 0.5w`，NDC z ∈ [-1,1] → [0,1]），视图口取 `scene.drawingBufferWidth/Height`（**禁用** `scene.pixelRatio`/`scene.frameState`）；导出像素比推导 `drawingBufferWidth / canvas.clientWidth`。`自检`：`npx tsc --noEmit` 通过；文件内 `grep -nE "pixelRatio|frameState|Scene\.context"` 无命中。`→ D4, 原则 I, research §5.1/§5.2`
- [ ] T034 [P] [US1] 实现双画布分层 `packages/cesium-webgpu/src/adapters/cesium/widget.ts`：容器 `position:relative`；`CesiumWidget` 构造（`contextOptions.webgl.alpha = true`、`resolutionScale`/`useBrowserRecommendedResolution` 使 `drawingBufferWidth/Height` 可预测）；在本库 canvas 上设置绝对定位分层与 `pointer-events` 策略（视觉在顶层、交互事件交给上游 canvas）；`dispose()` 移除两块 canvas 与容器内新增 DOM。`自检`：`npm run typecheck` 通过；仅使用 `research.md` §1.1 白名单符号。`→ D1, C-8, FR-025`
- [ ] T035 [US1] 实现渲染钩子 `packages/cesium-webgpu/src/adapters/cesium/render-hook.ts`：订阅公开事件 `scene.postRender`（本帧矩阵已为终值、浏览器尚未合成），在其中驱动后端"逐帧提交"回调；`requestRenderMode` 下用公开 `scene.requestRender()` 维持循环；卸载时解绑；`globe.show` **保持为 true**（保持瓦片调度），并设置 `Globe.baseColor = Color.TRANSPARENT` 使上游那次绘制不可见。`自检`：`npm run typecheck` 通过；`grep -nE "prototype\.|monkey|requestAnimationFrame\(" 该文件` 无命中（不得 monkey-patch、不得自建 rAF 循环）。`→ D2, D1, research §1.3/§1.4`
- [ ] T036 [P] [US1] 实现 WGSL 着色器 `packages/cesium-webgpu/src/backends/webgpu/shaders/terrain.wgsl`（顶点：`position` + `viewProjection` uniform + 深度修正；片元：基于高程/法线的高度着色或固定色带）+ `depth.wgsl`（如需要）；着色器**不接收**任何与具体数据源相关的参数。`自检`：`npm run build` 可把 `.wgsl` 内联进产物（T010 插件）；着色器文本中 `grep -n "Math.random"` 无命中。`→ FR-001, 契约 §3（不得使用随机源）`
- [ ] T037 [US1] 实现 WebGPU 后端 `packages/cesium-webgpu/src/backends/webgpu/backend.ts`：`navigator.gpu.requestAdapter`/`requestDevice` → `canvas.getContext("webgpu")` → `configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "premultiplied" })`；设备/队列/帧生命周期（begin/end frame、`commandEncoder`、`queue.submit`）；所有资源经 `GpuResourceRegistry` 登记。`自检`：`npm run typecheck` 通过；`createBuffer`/`createTexture` 调用点均伴随 registry 登记（`grep` 断言数量匹配）。`→ D1, FR-001, FR-017`
- [ ] T038 [P] [US1] 实现管线与管线缓存 `packages/cesium-webgpu/src/backends/webgpu/pipelines.ts`：按顶点布局/深度格式/目标格式缓存 `GPURenderPipeline`；缓存键稳定且可枚举（供基准报告）。`自检`：`npm run typecheck` 通过；同一配置两次请求返回同一对象（`Object.is` 断言可在 T042 的用例中断言）。`→ FR-001, FR-017`
- [ ] T039 [US1] 实现地形绘制通道 `packages/cesium-webgpu/src/backends/webgpu/terrain-pass.ts`：逐瓦片 `drawIndexed`（**不得**用 draw call 数换取实现方便而不记录：每次 `drawIndexed` 必须计入 `FrameStats.drawCalls`）；本帧绘制集合来自 `computeDrawSet`（resident ∩ 视锥 ∩ 父子截断）；瓦片几何按需上传且受逐帧上传预算约束。`自检`：`npm run typecheck` 通过；`grep -n "computeDrawSet" 该文件` 命中（必须复用核心规则，不得在 backend 内重写截断逻辑）。`→ FR-001, H-2, A2`
- [ ] T040 [P] [US1] 实现兜底后端 `packages/cesium-webgpu/src/backends/webgl2/backend.ts`：`preference:"webgl2"` 下**完全不触碰** `navigator.gpu`，把资源层实现为显式空实现（`createBuffer`/`createTexture` 为 no-op 并保持字节计数为 0 或由脚手架包装平台 API 提供），绘制 100% 由上游 Cesium 完成；`globals.baseColor` 在兜底路径下恢复为上游默认（地形必须**可见**）。`自检`：`grep -nE "navigator\.gpu|GPU[A-Z]" 该文件` 无命中。`→ C-2, FR-006, 原则 II`
- [ ] T041 [US1] 实现同构上层 API `packages/cesium-webgpu/src/api/createTerrainScene.ts` + `src/api/types.ts` + `src/api/errors.ts` + `src/index.ts`：`createTerrainScene(options)` 返回 `TerrainSceneHandle`（`path`/`ready`/`whenTilesLoaded`/`captureFrame`/`stats`/`resetStats`/`setView`/`dispose`/`events`），**契约 C-1：永不 reject**，任何异常经 `diagnostics.onError` 上报（C-6）；`preference` 只作为配置值读取、渲染调用点必须经 `RenderBackend`；`index.ts` 只导出契约 §1 列出的符号（不导出任何后端类型）。`自检`：`npx rollup -c` 后 `dist/index.d.ts` 无后端符号（A1）；`grep -nE "preference ===|=== \"webgpu\"|=== \"webgl2\"" packages/cesium-webgpu/src/api/*.ts` 的命中只出现在路径选择与事件构造处（在 PR 说明中逐条解释）。`→ C-1…C-6, FR-007, FR-008`

### Tests for User Story 1（与上面实现成对；先写、先失败）

- [ ] T042 [US1] 契约测试 `tests/contract/terrain-ready.spec.mjs`（Playwright，**参数化 `["webgl2","webgpu"]`**）：固定数据集 + 固定相机 + 固定场景时间 + 视口 1280×720 @ pixelRatio 1 加载演示页 → `handle.whenTilesLoaded({timeoutMs})` 返回 `loaded===true` → 断言 (a) 零未捕获错误（`page.on("pageerror")` 计数为 0）、(b) `scene.drawingBufferWidth/Height` 与快照一致、(c) 三角形数 >0 且绘制瓦片数 ≥4（多瓦片）、(d) `captureFrame()` 返回 RGBA8、左上原点、无预乘（用已知背景像素点验证布局）。`自检`：两条路径均 pass；把任一断言改为必然为假（临时）时用例**确实失败**（在 PR 中记录该对照）。`→ FR-001, FR-011, FR-012, FR-015, C-7, SC-001`
- [ ] T043 [US1] 视觉回归用例 `tests/visual/terrain-reference.spec.mjs`（参数化双路径）：每路径**各自**参考帧 `packages/verify-harness/reference-frames/<datasetId>/terrain-fixed-view-01.<path>.png`，逐像素比较（容差来自 `tolerances/tol-v1.json`）+ 统计断言：`nonBackgroundRatio` 在声明区间内且 **> 0.15**（非空白）、`uniqueColorCount ≥ 64`（非整片单色）、`luminanceStdDev > 阈值`（高程起伏可观察，SC-002）、`skylineRatio` 在区间内；失败时产出 `artifacts/<commit>/visual/<caseId>/<path>/{capture,reference,diff}.png`、`stats.json`、`evidence.json`。`自检`：双路径 pass；`--update` 生成参考帧后**理由与批准记录**写入 `tolerances` 的 `source` 与 PR 说明；人为让某瓦片不绘制时本用例必须失败并给出差异区域（US3-IS 的前置：在 T047 正式做对照实验）。`→ FR-010, FR-013, FR-014, FR-015, SC-002, SC-009`
- [ ] T044 [US1] 交互契约测试 `tests/contract/terrain-interaction.spec.mjs`（参数化双路径）：瓦片就绪后连续 3 秒执行旋转/缩放/平移（Playwright `mouse` 序列，固定步长与时长），断言 (a) 交互期间无 >1000 ms 的连续卡顿（用 `FrameStats.frameTimeMs` 序列判定）、(b) 无未捕获错误、(c) 交互结束并稳定后，定格帧的 `nonBackgroundRatio`/`uniqueColorCount` 与交互前同区间（几何未被破坏）、(d) 帧号持续增长（画面在更新）。`自检`：双路径 pass；若某路径帧时间超阈值，**不得**放宽断言了事——必须记录实测分布并作为 W4 基准的输入。`→ FR-002, SC-004`
- [ ] T045 [US1] 多瓦片拼接与接缝验证 `tests/visual/terrain-multitile-seam.spec.mjs`（参数化双路径）：固定相机使画面覆盖 **≥2×2** 瓦片并跨越至少一条接缝；断言 (a) 深度不连续处像素比例落在声明区间（接缝处不出现裂缝对应的背景色条带）、(b) 覆盖率突变检测：相邻两帧（相机未变）`nonBackgroundRatio` 变化 ≤5%、(c) 异常顶点计数为 0（`|height| > 9000` 或非有限值）、(d) 接缝带区域（沿瓦片边界 ±2 px）内无背景色像素连成的连通带。`自检`：双路径 pass；用例中**不允许**出现 `test.skip`（对照 constitution 测试策略：禁止以条件跳过代替断言）。`→ FR-001, FR-015, FR-016, SC-001, H-3`
- [ ] T046 [US1] 缺陷注入对照实验（验证器自证）`tests/visual/defect-injection.spec.mjs`：通过**测试专用注入开关**（环境变量/查询参数，默认关闭）依次注入 4 类缺陷：① 强制某瓦片不绘制；② 把某瓦片高程整体抬升 500 m；③ 破坏裙边（`skirtHeight=0`）；④ 在顶点数组中注入 `NaN`。断言 T043/T045 的断言在每种注入下**必须失败**，且失败信息包含差异区域或异常顶点计数。`自检`：4/4 注入均被捕获；任一注入未被捕获即视为验证资产不合格（FR-010 的"仅凭肉眼确认不得完成"的直接反面证明）。`→ FR-010, FR-014, FR-016, US3-IS`

**Checkpoint**：US1 可独立验收——双路径在固定条件下渲染出多瓦片地形，交互正常，且所有断言为自动化。

---

## Phase 5: User Story 2 - 新路径不可用时旧路径必须兜底（P1，对应 W2）

**Goal**: 能力探测（≤2s）与自动回退无异常、可观察、可配置；回退路径本身有测试覆盖；设备丢失可恢复或降级。

**Independent Test**: `npm run test:contract -- --grep "fallback|device-lost|path-selection"` 全绿；
在五类故障注入下页面仍渲染出通过断言的地形，调用方代码零分支。

**Tests 前置说明**：`preference:"webgl2"` 的用例是本 phase 的**必测项**（FR-015：兜底路径本身必须有测试覆盖）。

### Implementation for User Story 2

- [ ] T047 [US2] 实现能力探测 `packages/cesium-webgpu/src/api/probeRenderPath.ts`：检查 `navigator.gpu` 存在性 → `requestAdapter` → `requestDevice` → 能力下限（`maxTextureDimension2D ≥ 4096`、`maxBufferSize ≥ 256*1024*1024`、`maxVertexBuffers ≥ 2`、`maxBindGroups ≥ 2`、`requiredFeatures` 为空集），全程硬超时 **2000 ms**（`timeoutMs` 超限即夹取并告警）；返回 `CapabilityProbeResult`（`available`/`deviceAcquired`/`elapsedMs`/`limits`/`adapterInfo`/`reasons`），**不抛异常**、不创建 DOM、不改全局状态；超时后即使 promise 迟到 resolve 也不得切换路径且必须 `device.destroy()` 释放已获取设备。`自检`：`npm run typecheck` 通过；`grep -nE "document\.|window\.[a-z]" 该文件` 无命中（纯函数式）。`→ FR-005, C-1, C-2, 契约 §4`
- [ ] T048 [US2] 单元测试 `tests/unit/probe-render-path.test.mjs`：**5 类失败分支 + 超时（含迟到 resolve）**逐条断言 —— 无 `navigator.gpu` → `reasons=["no-navigator-gpu"]`；`requestAdapter→null` → `adapter-unavailable`；`requestDevice→reject` → `device-request-failed`；limits 低于下限（四项下限各一例）→ `limits-below-floor`；探测耗时 >2000 ms → `probe-timeout` 且 `elapsedMs ≤ 2000`；迟到 resolve 用例断言 `available===false` 且 `device.destroy()` 被调用（用 fake device 记录调用）。`自检`：`node --test tests/unit/probe-render-path.test.mjs` 全绿；fake `navigator.gpu` 由测试注入，**不依赖真实浏览器**。`→ FR-005, C-4, 契约 §4`
- [ ] T049 [US2] 实现路径选择与回退提示 `packages/cesium-webgpu/src/diagnostics/path-notice.ts` + `src/api/createTerrainScene.ts` 中的选择逻辑：`auto` 先探测、失败/超时/能力不足 → `webgl2`；`webgpu` 且不可用 → 仍渲染地形并经 `handle.path.reason` 与 `diagnostics.onPathChange` 给出原因类别（C-3）；`webgl2` → 零探测（C-2）；自动回退时产出可观察提示（页面状态文案 + `console` 日志，说明"已使用兜底路径"及原因类别）；`webgl2` 无需探测即可启用且探测失败不得阻塞 `CesiumWidget` 构造（不变式）。`自检`：`npm run typecheck` 通过；选择逻辑只读 `RenderPathPreference` 与 `CapabilityProbeResult`，不引用后端类型。`→ FR-005, FR-006, FR-009, C-2, C-3, 不变式`
- [ ] T050 [US2] 实现设备丢失恢复 `packages/cesium-webgpu/src/backends/webgpu/recovery.ts`：监听 `device.lost` → 尝试重建 device 并从 `TileRegistry` 中仍为 `resident` 的 CPU 侧 `heightField` **逐帧限量重建**（受 ≤4 瓦片或 ≤8 MiB/帧预算约束）→ 成功则 `events.pathChange` 报告恢复；失败则按 FR-009 降级到 `webgl2` 并给出可观察提示；`GpuResourceRegistry.invalidateAll()` 在丢失时立即调用。`自检`：`npm run typecheck` 通过；恢复路径不刷新页面、不影响同页其它 Cesium 实例。`→ FR-003, C-10, data-model §3/§5`
- [ ] T051 [P] [US2] 演示应用 `apps/demo/index.html` + `apps/demo/src/main.ts`：**只 import 包入口**，`preference` 与数据集通过 URL 参数/构建期常量传入（`__RENDER_PATH_DEFAULT__` 由 Rollup `replace` 裁剪），页面角落展示当前路径与（若回退）原因类别与加载进度，展示数据源署名（`Credit` 或等价文本）；源码中**不得**出现路径条件分支。`自检`：`node --test tests/unit/architecture-boundary.test.mjs`（A5）通过；`npm run demo -- --preference=webgl2` 与 `--preference=webgpu` 使用**同一个**入口文件。`→ FR-007, FR-009, A5, FR-024`

### Tests for User Story 2（与上面实现成对）

- [ ] T052 [US2] 契约测试 `tests/contract/fallback.spec.mjs`：以 `--preference=webgpu` 启动，分别注入 **5 类条件**（`navigator.gpu` 不存在 / `requestAdapter→null` / `requestDevice→reject` / limits 低于下限 / 探测超时 2000 ms），每条断言 (a) 页面仍渲染出地形并通过 `nonBackgroundRatio>0.15` 与 `uniqueColorCount≥64`、(b) `page.on("pageerror")` 计数为 0、(c) 控制台/状态文案中出现回退原因类别、(d) 探测耗时 ≤2000 ms（用例内计时）。`自检`：5 类注入全部 pass；每类都**必须**以断言（不是 skip）表达。`→ FR-005, FR-009, SC-003, quickstart §3.3`
- [ ] T053 [US2] 契约测试 `tests/contract/fallback-path-coverage.spec.mjs`：把 `navigator.gpu` 定义为**抛异常的 getter**，以 `preference:"webgl2"` 加载并断言 (a) 用例仍 pass（从未触碰 `navigator.gpu`，H-9）、(b) 渲染完全由上游完成（`globe.show===true` 且地形**可见**、`baseColor` 为上游客度）、(c) 绘制瓦片数与 `webgpu` 路径在同一固定条件下的统计落在声明区间内。`自检`：本用例即为 FR-015「兜底路径本身必须有测试覆盖」的落地证据；`grep -c "test.skip" tests/contract/fallback-path-coverage.spec.mjs` 为 0。`→ FR-006, FR-008, FR-015, H-9`
- [ ] T054 [US2] 契约测试 `tests/contract/device-lost.spec.mjs`：用 `device.destroy()`（或等价故障注入）触发 `GPUDevice.lost`，断言 (a) 在无需刷新页面的前提下场景恢复可交互（`events.pathChange` 或 `events.error` 给出可观察提示）、(b) 若重建成功则 `handle.path.active === "webgpu"` 且地形断言通过、(c) 若重建失败则 `path.active === "webgl2"`、`path.reason === "device-lost"` 且地形断言**仍**通过、(d) 全过程中无未捕获错误与永久黑屏。`自检`：两条分支（恢复成功 / 降级）都必须被真实断言覆盖；若某分支无法稳定注入，则**不得静默跳过**——按 H-7 记录该边界到 `docs/ci-degradation.md` 并在用例中显式标注 `test.fixme` + 原因（CI 中该标注即为可见的缺口，而非绿色）。`→ FR-003, C-10, H-7, SC-004`
- [ ] T055 [US2] 契约测试 `tests/contract/path-selection-isomorphic.spec.mjs`：(a) `preference:"webgl2"` 与 `"webgpu"` 下 `handle` 的**方法集与事件集**逐一相等（用 `Object.getOwnPropertyNames` 快照比较，C-4）；(b) 同一 `setView(CameraSnapshot)` 在两条路径下产生相同 `viewMatrix`（浮点容差 1e-9，C-9）；(c) `dispose()` 后可调用方法抛 `RenderPathStateError`，且页面其它 Cesium 实例不受影响（C-8）；(d) 演示应用源码中无路径分支（A5 的运行期对照）。`自检`：双路径 pass；快照差异会直接让用例失败（不允许"大致相同"）。`→ C-4, C-8, C-9, FR-007, FR-008`

**Checkpoint**：US1 与 US2 均已独立可验收——两条路径都渲染地形，回退与设备丢失均有自动化证据。

---

## Phase 6: User Story 3 - 渲染结果可自动化验证（P2，对应 W3）

**Goal**: 把验证从「用例存在」提升为「**验证器本身可信**」：双路径参数化框架、容差可追溯、差异证据、跨路径统计等价、容差由对照实验标定。

**Independent Test**: `npm run test:visual` 双路径 pass 并产出差异证据；人为注入缺陷时必须失败并指出差异区域。

- [ ] T056 [US3] 实现双路径参数化执行框架 `packages/verify-harness/src/harness.ts`：同一测试体在 `["webgl2","webgpu"]` 上运行（`runCase(page, {caseId, preference})`），**禁止**用条件跳过代替断言；框架负责：固定视口/像素比（1280×720 @ 1）、注入种子化 `Math.random`、冻结 `Date.now`/`performance.now`（**基准采集不得冻结时间**，仅冻结场景时间与随机源）、`CDP Input.setIgnoreInputEvents`、失败时保留现场截图。`自检`：`npm run typecheck` 通过；`grep -nc "test.skip" packages/verify-harness/src/harness.ts` 为 0。`→ FR-011, FR-012, 契约 §2/§3`
- [ ] T057 [P] [US3] 实现采集与统计 `packages/verify-harness/src/capture.ts` + `src/stats.ts`：`capture.ts` 通过**公开 API** `handle.captureFrame()` 取 RGBA8（与主包共享定义，避免口径漂移），`stats.ts` 计算 `FrameStatistics`（`nonBackgroundRatio`/`uniqueColorCount`/`luminanceMean`/`luminanceStdDev`/16 bins×3 通道归一化直方图/`skylineRatio`）。`自检`：附 `tests/unit/frame-statistics.test.mjs`（对合成图逐项断言：全底色图的 `uniqueColorCount===1`、渐变图的 `luminanceStdDev` 期望值、半屏地形图的 `nonBackgroundRatio≈0.5`）全绿。`→ FR-010, SC-002, 契约 §3`
- [ ] T058 [P] [US3] 实现像素对比与差异图 `packages/verify-harness/src/compare.ts`：按 `ToleranceProfile`（`perChannelTolerance`/`maxMismatchRatio`/`ignoreEdgePixels`）比较；输出差异图（红=超容差、黄=边缘忽略区外的轻微差异）、`mismatchRatio`、`meanAbsDiff`、`maxAbsDiff` 与差异区域包围盒（≥1 且 ≤10 个）；**禁止**任何"任意差异均通过"的判据（无容差缺省、`source` 为空即报错）。`自检`：附 `tests/unit/compare.test.mjs`（全同图 → pass；单像素超容差 → fail 且给出 1 个包围盒；1 像素边缘差异且 `ignoreEdgePixels=1` → pass；`source` 缺失 → 抛错）全绿。`→ FR-013, FR-014, 契约 §4`
- [ ] T059 [US3] 建立容差档案 `packages/verify-harness/tolerances/tol-v1.json`：`ToleranceProfile` 结构与**初值**（`perChannelTolerance=25`、`maxMismatchRatio=0.001`、`ignoreEdgePixels=1`、门槛 `frameTimeRegressionPct=10`/`gpuBytesRegressionPct=15`/`drawCallsRegressionPct=10`），每项带 `source`（推导说明 + 批准记录链接；初值来源标注为"同类项目生产 CI 取值 + 本项目 8bit sRGB/MSAA 余量"，并明确标注"标定前为初值"）；同一文件被 visual 与 bench 共用（**禁止**各写一份阈值）。`自检`：JSON 可解析；所有阈值字段的 `source` 非空且含 URL 或文档路径；后续 T062 标定后更新此文件并保留历史版本。`→ FR-014, FR-018, 契约 §3/§5`
- [ ] T060 [US3] 视觉回归正式化 `tests/visual/terrain-reference.spec.mjs` + `terrain-multitile-seam.spec.mjs`（在 T043/T045 基础上收敛）：接入 `harness.ts` 与 `compare.ts`，**每路径各自参考帧**（`reference-frames/<datasetId>/<caseId>.<path>.png`），参考帧元数据记录生成时的路径/后端/浏览器版本/是否软件光栅化；Chromium/Playwright 升级后必须重生成参考帧并在提交信息说明；重复运行两次结论一致。`自检`：`npm run test:visual` 双路径 pass；重复运行两次的 `verdict` 与 `mismatchRatio` 在同一区间内（在 PR 记录两次数值）。`→ FR-010, FR-012, FR-014, SC-009, US3-AS3/AS4`
- [ ] T061 [US3] 跨路径统计等价记录 `packages/verify-harness/src/cross-path.ts` + `tests/visual/cross-path-equivalence.spec.mjs`：产出 `CrossPathEquivalenceRecord` —— 两条路径在同一固定条件下的 `FrameStatistics`、几何统计（`triangles`/`tilesDrawn`/`drawCalls`）落入**彼此声明的区间**（初值：几何指标 ±10%、覆盖率统计 ±5%），并显式声明无法消除的差异清单（亚像素边缘覆盖、MSAA 解析、sRGB/色彩空间处理、深度表示），每条差异**附一个显式断言**（如 `expect(webgpuEdgeRatio).toBeGreaterThanOrEqual(webgl2EdgeRatio * 0.9)`）。`自检`：用例双路径 pass；`grep -n "declaredDifferences" 证据文件` 至少 4 条且每条有对应断言；**不得**用跨路径逐像素比较（D8/§7.3）。`→ FR-008, FR-011, D8, 契约 §3.1`
- [ ] T062 [US3] 容差标定对照实验与来源记录 `tests/visual/tolerance-calibration.spec.mjs` + `packages/verify-harness/tolerances/CALIBRATION.md`：以 T046 的 4 类缺陷注入为实验组、以正常渲染为对照组，记录每组在初值容差下的判定结果，据此**标定** `tol-v1.json` 的四个数值（能在缺陷注入下失败、且正常渲染下稳定通过的可行区间），把推导过程、实测数值、批准记录写入 `CALIBRATION.md` 并更新 `tol-v1.json` 的 `source` 指向该文件（含修订日期）。`自检`：标定后重跑 T046 → 4/4 注入仍被捕获；重跑 T060 两次 → 稳定通过；`CALIBRATION.md` 含"初值 → 标定值 → 理由"。`→ FR-014, US3-IS, 契约 §3`

**Checkpoint**：验证资产可信——双路径、可追溯容差、差异证据、跨路径等价、容差经对照实验标定。

---

## Phase 7: User Story 4 - 性能结论由数据支撑（P2，对应 W4）

**Goal**: 基准可复现、有环境标注、有历史序列、有量化门槛；无 GPU 的 CI 降级方式与 10 条盲区显式记录并附本地复现步骤；
CI 单工作流串行门禁与双路径并行 job 落地。

**Independent Test**: `npm run bench -- --check-regression` 产出双路径基准记录并追加历史序列；人为制造劣化后门槛判定失败。

- [ ] T063 [US4] 实现基准采集 `packages/verify-harness/src/bench.ts`：固定 `warmupFrames=120`、`sampleFrames=600`（CI 用缩减值但口径不变）、固定数据集与相机；产出 `BenchmarkRecord`（`schemaVersion:1`、`commit`、`timestamp`、`path`、`datasetId`、`cameraId`、`scene`、`environment`、`frameTimeMs{p50,p95,min,max}`、`drawCalls`、`gpuResourceBytes`、`triangles`、`degraded`、`degradationNotes`、`thresholds`、`passed`）。`自检`：单次运行产出 `artifacts/<commit>/bench/<path>.json`；记录中 `environment.adapterType`、`backend`、`software`、`headless`、`browserFlags` 全部非空。`→ FR-017, FR-020, 契约 §5`
- [ ] T064 [P] [US4] 实现 WebGL2 平台 API 计量 `packages/verify-harness/src/instrumentation.ts`：包装 **`WebGL2RenderingContext.prototype`** 的 `drawElements`/`drawArrays`（绘制批次数）与 `bufferData`/`texImage2D`（上传字节数）计数；**只包装浏览器平台 API**，不触碰 Cesium 内部实现；与 WebGPU 侧 `GpuResourceRegistry` 同口径。`自检`：附 `tests/unit/instrumentation.test.mjs`（fake GL 上下文：调用 3 次 `drawElements` → 计数为 3；`texImage2D` 字节累加正确；`uninstall()` 后原型被还原，`toString` 与原始函数一致）。`→ FR-017, D7, 原则 I`
- [ ] T065 [US4] 实现环境指纹与门槛判定 `packages/verify-harness/src/regression.ts`：以 `environment` 指纹（OS/浏览器与版本/GPU vendor+device+architecture/adapterType/backend/software/headless/浏览器标志哈希）匹配基线——**同环境指纹下最近一次通过记录**；比对 `frameTimeRegressionPct=10`、`gpuBytesRegressionPct=15`、`drawCallsRegressionPct=10`，超出即 `passed=false` 并输出与基线的差值与百分比；环境指纹变化必须重建基线并标注（**禁止**跨"软件光栅化 / 真实 GPU"比较）。`自检`：附 `tests/unit/regression.test.mjs`（构造两份记录：劣化 11%/16%/11% 各一例 → 判定失败且差值正确；环境指纹不同 → 跳过比较并标记需重建基线）全绿。`→ FR-018, FR-020, 契约 §5`
- [ ] T066 [US4] 建立**初始基线**：在无真实 GPU 的降级环境（Xvfb + lavapipe / ANGLE+SwiftShader）对新路径与兜底路径**各采集至少一次**基准并追加到 `artifacts/bench/history.jsonl`，记录 `degraded:true`、`adapterType:"cpu"`、完整浏览器标志与 `degradationNotes`。`自检`：`history.jsonl` 中两条路径各 ≥1 条记录，且同一环境指纹；在汇报中给出 p50/p95、`gpuResourceBytes`、`drawCalls` 的实测数值。`→ SC-006, FR-020`
- [ ] T067 [US4] 编写 CI 主工作流 `.github/workflows/ci.yml`：**单工作流串行门禁**，步骤顺序为 `[1] install+build → [2] lint+typecheck → [3] unit（含 A1–A5 与评估文档契约）→ [4] fixture integrity（--verify-only，离线）→ [5] contract+visual+bench（两个并行 job：webgl2 与 webgpu）→ [6] license & dependency check`；步骤 [5] 的两个 job 均为 `xvfb-run -a` + `headless:false`，环境变量与标志**严格**取契约 §7 表（WebGL2：`LIBGL_ALWAYS_SOFTWARE=1` + `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`；WebGPU：`VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json` + `--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --disable-gpu-watchdog`），系统包 `mesa-vulkan-drivers xvfb libvulkan1`，**不得**出现 `--disable-vulkan-surface`、WebGPU job 中不得出现 `--enable-unsafe-swiftshader`、不得出现 `--headless=new`，**不得**调用 `pwsh`；全部 CI 产物（构建日志、测试报告、`artifacts/**`、`history.jsonl`、差异图）`upload-artifact`；打印从提交到结论的总耗时。`自检`：本地用 `actionlint`（若可用）或 `node -e` 的 YAML 解析校验语法；在工作流文件中 `grep -c "pwsh\|disable-vulkan-surface\|headless=new"` 为 0；总耗时目标 ≤20 分钟（若实测超时，按契约 §6 缩减采样帧数并在 PR 说明）。`→ FR-021, FR-022, SC-005, 契约 §6/§7`
- [ ] T068 [P] [US4] 实现本地 CI 等价复现 `tools/scripts/ci-local.mjs` + `npm run ci:local`：在**同一份**标志配置（集中定义于 `tools/ci-flags.mjs`，CI 与本地共用，**禁止**各写一份）下按 CI 顺序执行六步并打印各步耗时与总耗时；Windows 下（本机 PowerShell 5.1 / Node 22）可直接运行不需要 `pwsh`，需要 Xvfb 的步骤在 Windows 上以"跳过并打印 CI-only 提示"的方式降级（**该降级必须打印明确原因**，不得静默）。`自检`：本机 `npm run ci:local` 可跑完除 Xvfb 步骤外的全部步骤并以 0 退出；`grep -rn "pwsh" tools/ .github/` 无命中。`→ FR-022, SC-005, quickstart §5.1, 全局约束 1`
- [ ] T069 [US4] 编写 `docs/ci-degradation.md`：逐条写入 **10 条盲区**（直接取自 `research.md` §7.2，逐条可引用）、两路径的**完整标志与环境变量表**（与 `tools/ci-flags.mjs`、`ci.yml` 三处一致）、**本地复现步骤**（`sudo apt-get install -y mesa-vulkan-drivers xvfb libvulkan1` → `npm ci && npm run build` → `npx playwright install --with-deps chromium` → `VK_DRIVER_FILES=... CI=1 xvfb-run -a npm run test:visual -- --path=webgpu` 等，取自 quickstart §5.3）、以及"CI 中关闭 `timestamp-query`"的明确说明。`自检`：10 条盲区逐条编号存在（`grep -c "^[0-9]\\+\." docs/ci-degradation.md` ≥10）；复现命令中的标志与 `ci-flags.mjs` 逐字一致（人工比对并在 PR 记录）。`→ FR-023, 原则 V`
- [ ] T070 [US4] CI 降级**可运行性门禁（G-3）**：在 GitHub Actions 托管 runner 上连续跑两次视觉采集并比对，验证 (a) lavapipe 下参考帧**跨运行稳定**（两次差异在容差内）、(b) 两路径作业合计耗时 ≤20 分钟；把两次实测数值与总耗时写入 `docs/ci-degradation.md` 的"实测记录"节。`自检`：`verdict` 两次均 pass 且差异数值记录在案；若不稳定或超时，**STOP** 并按 G-3 退路处理（视觉回归在 CI 降级为"数值统计断言 + 本机真实 GPU 像素对比"，盲区按 FR-023 记录；超时则缩减采样帧数并在 PR 说明），同时**必须回到 plan 修订**该门禁结论。`→ G-3, FR-023, SC-005, 门禁`

**Checkpoint**：基准与 CI 基建就绪——数据驱动、门禁可比、降级透明。

---

## Phase 8: User Story 5 - 开源交付与文档（P2，对应 W5）

**Goal**: 开源形态齐备（LICENSE/CONTRIBUTING/可复现构建说明/署名）、许可证与依赖检查、PR 模板强制"基线 vs 优化后"数据。

**Independent Test**: 全新环境按 README 可复现构建；`npm run license:check` 通过；PR 模板含必填的性能对比与证据项。

- [ ] T071 [US5] 选定并落地许可证 `LICENSE`（**Apache-2.0**，与上游生态一致、避免许可证冲突，依据 spec Assumptions「许可证与合规」）+ `NOTICE`（数据源与上游署名）；同步在 `packages/cesium-webgpu/package.json` 填写 `license`、`repository`、`engines`、`files`、`exports`。`自检`：`LICENSE` 为完整 Apache-2.0 文本；`NOTICE` 含上游 `cesium` 与地形数据集的署名；`npm run license:check`（T072）可通过。`→ FR-024, spec Assumptions`
- [ ] T072 [US5] 实现 `tools/license-check.mjs` + `npm run license:check`：零第三方依赖地读取 `package-lock.json` 生成依赖清单与许可证清单，断言 (a) 全部依赖的许可证在允许集合内（MIT/ISC/Apache-2.0/BSD-2/BSD-3/0BSD）、(b) `cesium` 为 Apache-2.0 且版本以 peer 引入、(c) 仓库无 `vendor/` 目录、无 `patch-package`/`postinstall` 补丁脚本（原则 I 的 CI 证据）、(d) 数据源与上游署名在 `NOTICE` 中出现。输出 `THIRD-PARTY-NOTICES.md`（生成物）。`自检`：`npm run license:check` 以 0 退出；把 `LICENSE` 临时改坏时失败（对照实验在 PR 记录）。`→ FR-024, 原则 I, 原则 V`
- [ ] T073 [P] [US5] 编写 `CONTRIBUTING.md`：含硬规则 —— ① 任何优化提交**必须**附"基线 vs 优化后"实测数据，无基线对比不予合入（FR-019/原则 IV）；② 改动渲染行为必须附 `capture/diff` 与统计数值（SC-009）；③ 更新参考帧必须在提交信息说明原因（US3-AS3）；④ 调整容差或回归门槛必须更新 `source` 并说明理由与影响（FR-014/FR-018）；⑤ 跳过测试必须附理由且禁止长期无条件跳过（constitution 测试策略）；⑥ 新增上游 API 依赖必须同步更新 `docs/upstream-api-allowlist.md` 且必须为公开 API（原则 I）；⑦ 改动口径或单价必须更新 `mvp-estimate` 并递增版本（FR-028）；⑧ **无长期分支**：短生命周期 PR 合入 `main`，回退 = revert 单个变更（FR-025）。`自检`：8 条硬规则逐条存在且每条给出对应的检查项或脚本名。`→ FR-019, FR-024, FR-025, SC-009`
- [ ] T074 [P] [US5] 编写 `README.md` + `docs/architecture.md`：README 含项目定位、外部模块形态与 peer 依赖、**可复现构建说明**（Node ≥22 版本要求、`npm ci` → `npm run build` → `npm run test:unit` → `npm run demo` 的完整命令、Windows 与 Linux 差异、代理端口 7890 的备用说明、禁止 `pwsh` 假设的说明）、快速上手（`createTerrainScene` 最小示例，无路径分支）、数据源署名、验证与基准入口、以及指向 `docs/ci-degradation.md` 与 `mvp-estimate.md` 的链接；`docs/architecture.md` 含双画布分层与数据流图（数据源 → `HeightField` → 上游 `HeightmapTerrainData` / WebGPU `TileGeometry` → 绘制）、层间依赖方向（`api → core ← backends`）、以及"哪些归上游、哪些归本层"的边界表。`自检`：README 中的每条命令在本机（Windows PowerShell 5.1 + Node 22）逐条执行成功（在 PR 记录执行输出摘要）；架构图与 `plan.md` 的 Structure Decision 一致。`→ FR-024, 附加技术约束`
- [ ] T075 [P] [US5] 编写 `.github/pull_request_template.md`：必填项 —— 对应原则 I–V 的合规说明、变更类型（渲染行为/性能/文档/基建）、**性能类变更必须填写"基线 vs 优化后"实测数据表**（帧时间 p50/p95、`gpuResourceBytes`、`drawCalls`，缺数据即不通过）、渲染行为变更必须附 `artifacts/**` 证据链接（差异图或统计数值）、参考帧/容差/门槛变更必须说明理由与影响、上游 API 新增必须列出符号与公开性依据、Out of Scope 自检（勾选"未引入三维瓦片/模型/影像/大气/阴影/后处理/粒子/矢量标注/移动端"）、以及 CI 全绿确认（本地通过不作为依据，FR-022）。`自检`：模板含"基线 vs 优化后"表格与"缺数据即不通过"字样；含 Out of Scope 勾选项；含证据链接必填项。`→ FR-019, FR-022, 原则 IV/V`

**Checkpoint**：仓库具备开源交付形态，且协作规则把 constitution 原则 IV/V 变成可检查的门禁。

---

## Phase 9: Polish & Cross-Cutting Concerns（对应 W6 治理与收尾）

**Purpose**: 治理收尾、评估结论的机器可校验落地、实际值回填机制、真实 GPU 夜间作业、最终一致性复核。

- [ ] T076 [US5] 实现**评估文档 CI 契约测试** `tests/unit/mvp-estimate-contract.test.mjs`：零第三方依赖地读取 `specs/001-webgpu-terrain-mvp/mvp-estimate.v1.json`，按 `specs/001-webgpu-terrain-mvp/contracts/mvp-estimate.schema.json` 校验（自实现所需子集校验器，或引入 `ajv` 作为 devDependency 并在 PR 说明），并断言 `data-model.md` §8 的 **7 条**：
① `meteringBasis.includesHumanCost === false` 且 `statement` 含"人工成本不计入"字样；
② `currency.primary === "CNY"` 且 `usd` 数值齐备（`fxRate`/`fxSource`/`fxDate` 非空）；
③ `totals.timeDays.min > 0 && max >= min`（`tokens`/`cost`/`agentTurns` 同理）；
④ `workflows` **≥5 项**且**齐备五类工作流**（渲染管线与地形绘制 / 双路径能力探测与兜底 / 验证资产与测试基建 / CI 与基准基建 / 开源交付与文档 —— 按 `id` 与 `name` 关键字双重匹配）；
⑤ 每个 `priceSources` 条目有 `source`（`^https?://`）与 `consultedAt`（`date`），逐条可追溯；
⑥ `unconfirmedItems` 每项含 `impactDirection`（`up|down|both`）与 `impactMagnitude` 非空；
⑦ 每个工作流的 `modelCost` 可由 `tokens × priceSources` 复算（≤1% 舍入误差）。
并断言人类可读版 `mvp-estimate.md` 与 JSON 的合计与工作流名称一致（口径不分叉）。`自检`：`node --test tests/unit/mvp-estimate-contract.test.mjs` 全绿；把 `includesHumanCost` 改成 `true`、或删掉一个工作流、或把某 `priceSources.source` 改成非 URL 时，用例**必须分别失败**（三次对照实验记录在 PR）。`→ FR-026, FR-027, FR-029, SC-007, US5-AS1/AS2/AS4`
- [ ] T077 [US5] 建立**实际值回填机制** `actualsBackfill`：在 `mvp-estimate.schema.json` 已有结构基础上固化回填流程 —— (a) 新增 `tools/scripts/backfill-actuals.mjs`（**填空模板 + 校验**：读取 `actualsBackfill`，校验 `recordedAt` 为 `date-time`、`timeDays ≥ 0`、`tokens.inputM/outputM ≥ 0`、`cost.cny/usd` 齐备、`deviationNote` 非空），(b) 在 `tests/unit/mvp-estimate-contract.test.mjs` 增加断言：`actualsBackfill` 存在时上述字段齐备（不存在时为 `null` 且不报错），(c) 在 `mvp-estimate.md` §7 写明回填步骤与"偏差必须书面说明原因与新预期"（SC-008），(d) 在 `CONTRIBUTING.md` 增补对应检查项。`自检`：`node tools/scripts/backfill-actuals.mjs --check` 在 `actualsBackfill: null` 时以 0 退出；手工填入一份**故意缺字段**的样本时 `--check` 以非 0 退出。`→ FR-028, SC-008, US5-AS3`
- [ ] T078 [P] [US5] 编写夜间真实 GPU 作业 `.github/workflows/nightly-real-gpu.yml`：`workflow_dispatch` + `schedule`（夜间）、受**环境门控**（需显式批准/权限）以免被误触发计费；在真实 GPU 环境（GPU larger runner 或自托管 runner，选择依据与价差见 `mvp-estimate.md` §5 待确认项 1）跑同一套视觉与基准用例；产物与软件序列**分开归档**（环境指纹不同即重建基线，禁止混入同一条比较链）；记录实际机时与费用用于回填 `actualsBackfill`。`自检`：工作流默认不在每次提交上运行；`degraded:false` 与真实 `adapterInfo` 写入记录；文件中不出现 `pwsh`。`→ FR-017, FR-020, FR-023, FR-028, 契约 §5`
- [ ] T079 [P] [US5] 编写 `docs/upstream-api-allowlist.md`：把 `research.md` §1.1 的公开符号清单与 §1.2 的 `@private` 黑名单**逐条固化**（含证据文件:行号与用途列），并写明与 `packages/cesium-webgpu/src/adapters/cesium/public-api-allowlist.ts` 的同源关系、以及 A3/A4 断言的检查方式。`自检`：清单条数与 `research.md` §1.1/§1.2 一致（逐条比对并在 PR 记录）；`public-api-allowlist.ts` 中的数组与本文档逐项对应。`→ 原则 I, research §11`
- [ ] T080 [US5] 实现上游升级演练 `tools/scripts/upgrade-check.mjs` + `npm run upgrade:check -- --cesium=<next-version>`：升级 devDependency 的 `cesium` → 跑 `npm run ci:local` → 输出 `git diff --stat` 的改动范围并**断言改动仅收敛于 `packages/cesium-webgpu/src/adapters/cesium/**`**；若触及该目录以外的源码，以非 0 退出并打印"视为破坏性变更，须先修订计划并给出迁移方案"（原则 I）。附 `tests/unit/upgrade-scope.test.mjs`（对脚本的判定函数做单测：只改 adapter → pass；改了 `src/core/**` → fail）。`自检`：`npm run upgrade:check -- --cesium=1.145.0`（同版本）以 0 退出且 diff 为空时 pass；`node --test tests/unit/upgrade-scope.test.mjs` 全绿。`→ 原则 I, quickstart §7`
- [ ] T081 [US5] 交付收尾一致性复核 `docs/delivery-review-w6.md`：逐项核对并留痕 —— (a) spec 的 29 条 FR 与 9 条 SC 各自对应的任务 ID 与证据路径（差异图 / 统计数值 / 基准记录 / CI 运行链接）；(b) **无"仅凭肉眼确认"的完成项**（逐条检查任务的验证证据类型）；(c) **无 Out of Scope 内容**（按全局约束 6 的清单逐项确认未引入）；(d) 所有门禁（G-1/G-2/G-3）结论与 plan.md「实现前的验证门」表状态一致；(e) 按 SC-008 给出可追溯的时间区间与偏差说明（若无偏差则写明"未超出区间"），并在交付时把实际值按 T077 的机制回填 `actualsBackfill`。`自检`：复核文档中每条 FR/SC 都有任务 ID 与证据路径（无空项、无 "TBD"）；抽查 3 条渲染类任务，其证据均为自动化产物而非人眼截图描述。`→ SC-008, SC-009, 原则 III, spec Out of Scope`

**Checkpoint**：交付物齐备且每条结论可追溯到 CI 产物或实测记录。

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1（G-1/G-2 门禁）**：无依赖，可立即开始；**⛔ 未通过则回到 plan 修订，不得进入 Phase 4+**。
- **Phase 2（Setup）**：依赖 Phase 1 的门禁结论（决定 W1 的实现输入）；不含渲染实现。
- **Phase 3（Foundational）**：依赖 Phase 2 —— **BLOCKS 所有 user story 实现**（A1–A5 必须先于实现存在）。
- **Phase 4（US1 / W1）**：依赖 Phase 3；是 MVP 主体。
- **Phase 5（US2 / W2）**：依赖 Phase 3；与 US1 有接口交集（`api/**`、`probeRenderPath`），T049 修改 `createTerrainScene.ts` → 必须在 T041 之后。
- **Phase 6（US3 / W3）**：依赖 US1（需要可渲染的场景做参考帧）与 US2（双路径参数化）；可部分与 US2 并行（`verify-harness` 与 `probeRenderPath.ts` 无文件交集）。
- **Phase 7（US4 / W4）**：依赖 US3（基准复用 harness 与容差文件）与 T067 依赖 US1/US2 的测试脚本就位；门禁 **G-3（T070）** 需在 CI 可运行后执行，未通过则回到 plan 修订。
- **Phase 8（US5 / W5）**：依赖 T072 依赖构建与 `package-lock.json`（Phase 2），其余文档任务与 US1–US4 可并行推进。
- **Phase 9（Polish / W6）**：依赖全部前序 phase（T081 是最终收尾）。

### Critical Path

`T001 → T002 → T003 → T006 → T007 → T012 → T025 → T026 → T028 → T029 → T030 → T031 → T037 → T039 → T041 → T042 → T043 → T047 → T049 → T050 → T052 → T056 → T060 → T062 → T063 → T067 → T069 → T070 → T076 → T077 → T081`

### Within Each User Story

- 测试任务与其实现任务**成对**且相邻；渲染特性类用例先写、先失败，再实现（FR-010/FR-011）。
- 模型/纯函数 → 服务 → 集成 → 端到端；核心实现先于跨路径集成。
- 一个 user story 完成（Checkpoint 通过）后再进入下一个优先级。

### Parallel Opportunities

- **Phase 1**：T004 与 T005 可并行（不同文件：`g2-drawset.ts` vs `g2-observer.ts`）；T001/T002 串行（同一实验的递进），T003/T006/T007 依赖前者。
- **Phase 2**：T008、T009、T010、T011、T013 可并行（不同文件）；T012 依赖 T009/T011/T013（同一 `package.json` 与构建入口）。
- **Phase 3**：T016、T017、T018、T020、T023、T024 可并行（不同文件）；T019/T021 被同 phase 的测试与生产模块依赖，不标 [P]；T025 依赖 T024 与冻结的目录结构。
- **Phase 4**：T026、T033、T034、T036、T038、T040 可并行（不同文件）；T031 依赖 T026/T028、T035 依赖 T034、T037 依赖 T036/T038、T039 依赖 T023/T037、T041 依赖 T031–T040。
- **Phase 5**：T047 → T048 串行（同模块与其测试）；T051 可与 T047–T050 并行（不同文件）。
- **Phase 6**：T057、T058 可并行（不同文件）；T056 → T060 → T061 → T062 串行（同一套用例与容差文件的递进收敛）。
- **Phase 7**：T064、T068 可并行；T066 依赖 T063/T065；T067 依赖 T063–T065；T069 依赖 T067；T070 依赖 T067/T069（需 CI 可运行）。
- **Phase 8**：T073、T074、T075 可并行（不同文件）；T072 依赖 T071。
- **Phase 9**：T078、T079 可并行；T076 → T077 串行（同一测试文件与同一文档机制）；T080、T081 收尾。

### Parallel Example: Phase 4（US1）

```text
并行组 A（无共享文件）：
  T026 heightmap.ts + 解码        T033 camera.ts（矩阵与深度修正）
  T034 widget.ts（双画布分层）     T036 terrain.wgsl（着色器）
  T038 pipelines.ts（管线缓存）    T040 webgl2/backend.ts（兜底后端）

串行链（有真实依赖）：
  T026/T028 → T029 → T030（数据集） → T031 → T032 → T035 → T037 → T039 → T041 → T042/T043
```

---

## Implementation Strategy

### MVP First（US1 + US2 均为 P1）

1. **Phase 1**：关闭 G-1/G-2 门禁（唯一允许"实验性代码"的阶段；≤0.5 工作日 + 1 工作日）。
2. **Phase 2 + Phase 3**：骨架与后端无关核心 + A1–A5 断言（阻塞式）。
3. **Phase 4（US1）**：固定数据集 → 上游注入 → WebGPU 绘制 → 双路径就绪与视觉断言。
4. **Phase 5（US2）**：探测、回退、设备丢失、双路径同构。
5. **STOP and VALIDATE**：US1 与 US2 的 Checkpoint 独立通过 → 这是"地形渲染跑通"的最小可演示单元（spec US1/US2 均为 P1）。
6. **Phase 6 + Phase 7**：验证资产可信化与基准/CI（US3/US4，P2），含 G-3 门禁。

### Incremental Delivery

1. G-1/G-2 + Setup + Foundational → 骨架可构建、违规可阻断。
2. US1 → 双路径渲染出多瓦片地形（可演示）→ 独立验收。
3. US2 → 回退与设备丢失可自动化证明（可交付给集成方）→ 独立验收。
4. US3 → 验证器可信（容差经标定）→ 独立验收。
5. US4 → 基准与 CI 门禁 + G-3 → 独立验收。
6. US5 + Phase 9 → 开源交付形态 + 评估结论契约 + 实际值回填机制（里程碑 SC-001…SC-008 齐备）。

### 任务粒度与执行约定

- 每个任务由一个子代理在一轮内完成并自检；任务描述中的 `自检` 即为**完成判据**，必须真实执行（命令 + 输出摘要）。
- 每个任务完成后立即勾选 `tasks.md` 中的复选框，并在提交信息中带任务 ID（`T0xx: ...`）。
- 一个任务若要改动超过 3 个文件或跨越两个 phase 的职责，视为粒度不合格，应拆分后再执行。
- 遇到**同一阻塞连续 2 次修复失败**，按 `AGENTS.md` §5 上报（结论 + 选项 + 建议），不要静默绕过。

---

## Notes

- `[P]` = 不同文件、无未完成依赖；同一 phase 内的 `[P]` 任务可并行派发（并行前提见「Parallel Opportunities」）。
- `[Story]` 标签把任务映射到 spec 的 user story，便于追溯与独立验收；门禁与基建 phase 不带标签。
- 渲染行为类验证任务一律**双路径参数化**（含 `preference:"webgl2"` 的兜底路径覆盖，FR-015）。
- 禁止：`test.skip` 代替断言、无 `source` 的容差、跨路径逐像素比较、无基线对比的优化、`pwsh` 假设、
  任何 Out of Scope 内容（全局约束 5/6）。
- 门禁未通过时**不得**继续实现：G-1/G-2 在 Phase 1，G-3 在 T070；三者均要求回到 `plan.md` 修订。
