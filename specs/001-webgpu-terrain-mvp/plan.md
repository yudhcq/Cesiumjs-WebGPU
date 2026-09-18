# Implementation Plan: WebGPU 地形渲染 MVP（CesiumJS 1.145.0 外部模块）

**Branch**: `001-webgpu-terrain-mvp` | **Date**: 2026-09-18 | **Spec**: [spec.md](./spec.md)
**Research**: [research.md](./research.md) | **Data model**: [data-model.md](./data-model.md) | **Quickstart**: [quickstart.md](./quickstart.md)
**Contracts**: [contracts/render-path-api.md](./contracts/render-path-api.md) · [contracts/terrain-source.md](./contracts/terrain-source.md) · [contracts/verification-and-benchmark.md](./contracts/verification-and-benchmark.md) · [contracts/mvp-estimate.schema.json](./contracts/mvp-estimate.schema.json)
**消耗评估（交付物）**: [mvp-estimate.md](./mvp-estimate.md) / [mvp-estimate.v1.json](./mvp-estimate.v1.json)

---

## Summary

在**不 fork、不 vendor、不 patch** CesiumJS 1.145.0 的前提下，以**外部 TypeScript 包**新增一条 WebGPU 渲染路径，
把地形渲染端到端跑通，并保证 WebGL2 兜底路径在任何时刻可用、两条路径共用同一上层 API。

技术路线（决策依据与证据见 [research.md](./research.md)）：

1. **双画布分层**：Cesium 自建 WebGL2 画布（在下，负责天空/背景与全部瓦片调度）+
   本库自建 WebGPU 画布（在上，`alphaMode: "premultiplied"`，负责地形绘制）。
   一个 canvas 只能有一种上下文类型，接管上游上下文在公开 API 下不可行（`Scene.context` 为 `@private`）。
2. **地形数据经公开扩展点注入**：实现 `TerrainProvider` 子类，`requestTileGeometry` 返回公开类
   `HeightmapTerrainData`（数据来自本层解码出的 `HeightField`，唯一高程真值）。上游四叉树继续负责
   瓦片调度、LOD、可用性、请求预算与内存管理；本层只新增"取数据 + 建 GPU 几何 + 提交绘制"。
3. **提交钩子 = `Scene.postRender`**：该事件在上游 `render()` 完成后、浏览器合成前触发，
   此时 `camera.viewMatrix` / `frustum.projectionMatrix` 已是本帧终值（已核实调用顺序）。
4. **悬空绘制规避**：`Globe.baseColor = Color.TRANSPARENT` + 画布 `alpha: true`（均为公开 API），
   使上游对地形的那一次绘制不可见（因为 `globe.show = false` 会同时停掉瓦片调度，已核实，
   故不能采用）。该次不可见绘制的开销由基准显式度量并标注，不得据此宣称性能收益。
5. **数据源**：免登录公开栅格高程源（`s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`，
   实测 200 + CORS `*` + z0–15，浏览器内解码）+ **同源字节的本地固定数据集**（约 3–6 MB，
   以勃朗峰区域 0.6°×0.5°、z0–12 为准，随仓库提交），CI 全程离线、无凭据。
   候选对比、端到端解码实测与署名结论见 research.md §6（H-5 已核实）。

---

## Technical Context

**Language/Version**：
- TypeScript 5.x（`strict: true`，`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess` 开启）
- WGSL（WebGPU 着色器语言，随包内联打包）
- Node.js >= 22（本机实测 v22.20.0 / npm 10.9.3；上游 `cesium@1.145.0` 的 `engines.node` 为 `>=22.0.0`）

**Primary Dependencies**：
- 运行时（peer）：`cesium@1.145.0`（`peerDependencies: ">=1.145.0 <2.0.0"`，CI 矩阵固定 1.145.0；
  不 import 上游 `Source/**` 深路径，只从包入口 `cesium` 导入公开符号）
- 构建：`rollup`（多入口：主包 / 可选逃生舱 / 演示页）+ `@rollup/plugin-typescript` + `rollup-plugin-dts`（生成 `.d.ts`）
  + 自研 20 行的 WGSL 内联插件（避免额外依赖）
- 类型：`@webgpu/types`（dev，提供 `navigator.gpu` / `GPU*` 类型）
- 测试：`node:test`（Node 22 内置，跑纯 CPU 逻辑与架构边界断言）+ `playwright`（dev，浏览器契约/视觉/基准）
- 无运行时第三方依赖（除 peer `cesium`）——降低供应链与许可证风险（FR-024）

**Storage**：
- 地形固定数据集：文件（`fixtures/<datasetId>/{manifest.json, layer.json, <level>/<x>/<y>.terrain}`），静态服务
- 验证资产：参考帧 PNG + 容差 JSON（版本化于仓库）
- CI 产物：`artifacts/<commit>/{visual,bench,evidence}/*`、`artifacts/bench/history.jsonl`（基准历史序列）
- 无数据库、无服务端持久化

**Testing**：
- 单元（`node:test`）：能力探测决策（5 类失败分支）、高程解码与几何构建、瓦片状态机、绘制集合截断规则、
  指标统计、评估文档契约（按 JSON Schema 校验 `mvp-estimate.v1.json`）
- 契约（Playwright，双路径参数化）：加载就绪、交互、自动回退、`preference:"webgl2"` 不触碰 `navigator.gpu`、
  设备丢失恢复提示、多瓦片拼接
- 视觉回归（Playwright + 自研 compare）：像素对比 + 差异图 + 统计断言（双路径）
- 基准（Playwright + 自研 bench）：帧时间 p50/p95、图形内存、绘制批次数，门槛判定 + 历史序列
- 架构边界（`node:test`，静态扫描）：断言 A1–A5（见 data-model.md §9）

**Target Platform**：
- 新路径：支持 WebGPU 的桌面浏览器；**不对浏览器版本号做硬编码判定**，只依赖能力探测（FR-005）。
  文档给出经验基线（Chrome/Edge ≥ 121、Firefox ≥ 141、Safari ≥ 26）作为参考，实际基线由 CI 实测确认（待验证 H-6）。
- 兜底路径：支持 WebGL2 的既有主流桌面浏览器
- 构建/CI：Node >= 22，Linux（GitHub Actions 托管 runner，无真实 GPU，按 FR-023 降级）

**Project Type**：library（外部 npm 包）+ demo web app + private 验证脚手架（单仓库多包，npm workspaces）

**Performance Goals**（不承诺绝对帧率，spec Assumptions「性能期望」：正确性与可验证性优先，其次相对兜底路径不劣化）：
- 交互：单次交互不出现 > 1 秒连续卡顿（SC-004）
- 基准三指标：帧时间 p50/p95、图形资源字节数、绘制批次数（FR-017）
- 回归门槛：帧时间劣化 > 10%、图形内存劣化 > 15%、绘制批次劣化 > 10% 即判定失败（初值，变更须记录理由）
- CI：从提交到结论 ≤ 20 分钟（SC-005）

**Constraints**：
- 禁止 fork / vendor / patch 上游；禁止依赖 `@private` / `@experimental` / 下划线内部成员（constitution 原则 I，NON-NEGOTIABLE）
- 一 canvas 一上下文类型；WebGPU 画布与上游 WebGL2 画布必须分层共存
- 能力探测上限 2 秒（FR-005）；回退必须无未捕获异常、不阻塞页面
- 地形数据源必须免登录（无令牌）；CI 必须可在**离线**环境完成验证与基准（FR-004 / FR-012）
- 验证必须确定性：固定相机/时间/视口/像素比/数据集/种子（FR-012）
- 集成方代码不得出现渲染路径分支、不得引用后端类型（FR-007）
- 单个 GPU 设备丢失后必须恢复交互，无需刷新页面（FR-003）

**Scale/Scope**：
- 1 个演示数据集 + 1 个验证数据集（多瓦片拼接，含显著高程起伏）
- 2 个后端（WebGPU / WebGL2 兜底）、1 套上层 API、1 个演示页
- 预估代码量 6,000 – 12,000 行 TS/WGSL/JS（含测试与工具）
- 不含：三维瓦片、glTF/模型、影像图层、大气与光照特效、阴影、后处理、粒子、矢量标注、移动端适配（spec Out of Scope）

---

## Constitution Check

*GATE: Phase 0 前检查；Phase 1 设计后复查（见本节末尾）。*

### 原则 I — 上游兼容优先（NON-NEGOTIABLE）

| 要求 | 本方案如何满足 | 证据/验证 |
|---|---|---|
| 不 patch / 不 fork / 不 vendor | 仅有的上游交互是：`import ... from "cesium"`（公开包入口）+ 子类化公开类 `TerrainProvider`；仓库不包含任何上游源码拷贝；CI 断言无 `patch-package`/`postinstall` 补丁、无 `vendor/` 目录 | CI 步骤 [8] 许可证与依赖检查 + 仓库结构断言 |
| 禁止非公开（私有/下划线）内部 API | 本阶段已逐条核实并将黑名单写入代码扫描规则：`TerrainData.createMesh`、`TerrainMesh`、`TerrainEncoding`、`GlobeSurfaceTileProvider`、`GlobeSurfaceTile`、`QuadtreePrimitive`、`QuadtreeTile`、`Scene.context`、`Scene.pixelRatio`、`Scene.frameState`、`Context` 均为 `@private` → **禁止出现**（research.md §1） | 断言 **A4**：静态扫描 `\._[a-zA-Z]` 与深路径 import |
| 耦合面收敛到 adapter 层 | 只有 `packages/cesium-webgpu/src/adapters/cesium/**` 允许 `from "cesium"`；上层 API、后端实现、验证脚手架均不直接 import 上游 | 断言 **A3**（import 图） |
| 基线版本以 peer dependency 引入 | `peerDependencies: { "cesium": ">=1.145.0 <2.0.0" }`；devDependency 固定 `1.145.0` 用于本地开发 | `package.json` + CI 矩阵 |
| 上游升级只改 adapter | 所有上游版本细节（构造参数、事件顺序、公开属性）封装在 `adapters/cesium/**`，升级只需改该目录；其它目录出现 `from "cesium"` 即构建失败 | 断言 A3 + 升级演练（quickstart §6） |

### 原则 II — 渐进式接管

| 要求 | 本方案如何满足 | 证据/验证 |
|---|---|---|
| WebGL2 任何时刻为可用默认后端 | `preference: "webgl2"` 分支完全不触碰 `navigator.gpu`（契约 C-2），渲染 100% 由上游完成；回退不需要任何代码改动 | 契约测试：`preference:"webgl2"` 下 `navigator.gpu` 被 stub 为抛异常仍通过（FR-015 覆盖兜底路径） |
| 新后端必须先经能力探测 | `probeRenderPath()` 检查 `navigator.gpu` → `requestAdapter` → `requestDevice` → 能力下限（maxTextureDimension2D ≥ 4096、maxBufferSize ≥ 256 MiB、maxVertexBuffers ≥ 2、maxBindGroups ≥ 2），全程受 2 秒超时约束 | 单元测试 5 类失败分支 + 超时（含迟到 resolve） |
| 探测失败必须无异常回退，且回退路径被测试覆盖 | 探测函数不抛异常，只返回 `CapabilityProbeResult`；`createTerrainScene` 永不 reject（契约 C-1） | 契约测试：强制 `requestAdapter→null` 时页面仍渲染地形 |
| 上层 API 唯一、两后端行为一致 | 单一句柄 `TerrainSceneHandle` 覆盖两路径（契约 C-4）；双路径参数化跑同一测试体，差异必须显式断言而非跳过 | 契约测试 + 视觉回归（FR-008 / FR-011） |
| 后端切换可在配置层/运行时完成，调用方无分支 | `preference` 配置 + `events.pathChange` 运行时通知；演示应用只 import 包入口（断言 A5） | 断言 A5 + 演示应用源码审查 |
| 渲染后端抽象，后端实现不得被上层反向 import | `core/backend.ts` 定义 `RenderBackend`（资源创建、管线与管线缓存、命令编码与提交、帧生命周期）；上层只依赖该接口 | 断言 **A1**/**A2** |

### 原则 III — 可验证渲染

| 要求 | 本方案如何满足 | 证据/验证 |
|---|---|---|
| 每项渲染特性附自动化验证 | 每个地形特性（多瓦片拼接、接缝、视锥裁剪、深度、设备丢失恢复、回退）在 `tests/visual` 与 `tests/contract` 中有对应用例；仅肉眼确认不得标记完成 | 用例清单与 tasks.md 一一对应 |
| 像素对比 + 显式容差 / 数值帧统计 | 参考帧像素对比（`ToleranceProfile`，含 `source` 字段）+ `FrameStatistics`（非背景覆盖率、唯一色数、亮度分布、直方图） | contracts/verification-and-benchmark.md §3/§4 |
| 固定相机/时间/种子/视口/像素比 | `VerificationDataset` 固化并写入证据文件；断言 `scene.drawingBufferWidth/Height` 与快照一致 | 契约测试前置断言 |
| 容差可追溯，禁止宽松判据 | 容差写入 `tolerances/tol-v1.json`，每项带 `source`（推导 + 批准记录）；以"人为注入缺陷必须失败"的对照实验标定 | US3-IS 用例 + 容差标定实验 |
| 双后端覆盖 | 同一测试体参数化跑 `webgl2` 与 `webgpu`，任一失败即提交失败 | CI 步骤 [5][6] |
| 几何缺陷数值化断言 | 覆盖率突变、深度不连续像素比例、异常顶点计数（NaN/超范围）由断言捕获 | data-model.md §6 规则 |

### 原则 IV — 性能以数据驱动

| 要求 | 本方案如何满足 | 证据/验证 |
|---|---|---|
| 优化必须由基准支撑，无基线不合入 | 基线先于任何优化提交；CI 门槛判定与历史序列强制 | CI 步骤 [7] + FR-019 |
| 记录 p50/p95、显存、draw call，口径版本化 | `FrameStatsSummary`/`BenchmarkRecord` 固化口径；口径变更需记录理由 | data-model.md §4/§7 |
| 基准可复现（固定场景/预热/采样/环境标注） | 固定数据集 + 固定相机 + 预热 120 帧 + 采样 600 帧 + 环境指纹 | contracts §5 |
| 回归门槛量化，阈值变更记录理由 | 10%/15%/10% 初值 + `thresholds.source` 必填 | data-model.md §7 |
| 优化附"基线 vs 优化后"对比 | PR 模板强制要求，缺失即不评审通过 | CONTRIBUTING.md + CI 检查项 |

### 原则 V — CI 为唯一事实来源

| 要求 | 本方案如何满足 | 证据/验证 |
|---|---|---|
| 每次提交完成构建+测试+基准 | 单工作流串行门禁（步骤 [1]–[8]），任一失败阻断合入 | `.github/workflows/ci.yml` |
| 主干始终可构建可运行可回退 | 无长期分支；每个变更请求合入前必须全绿；回退 = revert 单个变更 | 分支策略 + PR 检查 |
| CI 产物为唯一判定依据 | 视觉差异图、基准数据、测试报告、构建日志全部作为 artifact 上传；本地通过不作为依据 | FR-022 + CONTRIBUTING |
| 降级运行必须显式记录盲区 + 本地复现步骤 | CI 采用 **Xvfb（headed）+ Mesa lavapipe** 运行 WebGPU、**ANGLE/SwiftShader** 运行 WebGL2（已核实可用，见 research.md §7）；`docs/ci-degradation.md` 记录标志、10 条盲区清单与本地复现命令；基准记录 `degraded`/`degradationNotes`/`adapterType`/`browserFlags` 必填 | research.md §7 + quickstart §5 |
| 依赖与许可证检查入 CI | 步骤 [8]：依赖树与许可证清单校验（含 `cesium` Apache-2.0 与数据集署名） | FR-024 |

### 附加技术约束

TypeScript `strict` + Rollup + ESM（含 `.d.ts`）✔（构建配置）；Node >= 22 ✔（`engines`）；外部模块形态 ✔；
开源交付含 LICENSE/CONTRIBUTING/可复现构建说明 ✔（W5）；持续集成模式无长期分支 ✔。

**Phase 1 设计后复查结论**：设计产物（data-model / contracts / quickstart）未引入新的原则违规。
两项**需要论证的复杂度**已登记在 Complexity Tracking（自定义 TerrainProvider、保留上游不可见绘制）。
`Scene.postRender` 钩子、`Globe.baseColor`、画布 `alpha` 均为公开 API，复查通过。

---

## Project Structure

### Documentation (this feature)

```text
specs/001-webgpu-terrain-mvp/
├── spec.md                      # 输入（阶段 1 产物，本阶段不改写）
├── plan.md                      # 本文件（阶段 2 产物）
├── research.md                  # 阶段 0：技术决策 + 证据表 + 待验证假设
├── data-model.md                # 阶段 1：实体/类型/状态机/边界断言
├── quickstart.md                # 阶段 1：可运行的验证与复现指南
├── mvp-estimate.md              # FR-026~029 交付物（人类可读）
├── mvp-estimate.v1.json         # 同上的机器可校验版本（CI 校验）
├── contracts/
│   ├── render-path-api.md       # 上层同构 API（FR-007 的落地形式）
│   ├── terrain-source.md        # TerrainProvider 适配层与数据集格式
│   ├── verification-and-benchmark.md  # 验证/基准契约与门禁
│   └── mvp-estimate.schema.json # 评估结论 JSON Schema
└── checklists/                  # 阶段 2.5 清单（按需）
```

### Source Code (repository root)

```text
cesium-webgpu/                       # 仓库根
├── package.json                     # npm workspaces 根；engines.node >= 22
├── tsconfig.base.json               # strict 基线
├── rollup.config.mjs                # 多入口构建（主包 / 逃生舱 / 演示页）
├── LICENSE                          # Apache-2.0（与上游生态一致，避免许可证冲突）
├── CONTRIBUTING.md                  # 含"优化必须附基线对比""容差变更须记录来源"等硬规则
├── README.md
├── docs/
│   ├── architecture.md              # 双画布分层与数据流图
│   ├── ci-degradation.md            # FR-023：降级方式、盲区清单、本地复现步骤
│   └── upstream-api-allowlist.md    # 允许使用的上游公开 API 清单（与 research.md §1 同源）
├── packages/
│   ├── cesium-webgpu/               # 主交付包（外部模块）
│   │   ├── package.json             # peerDependencies: cesium；exports: "." 与 "./escape-hatch"
│   │   ├── src/
│   │   │   ├── index.ts             # 唯一公开入口（不导出任何后端类型）
│   │   │   ├── api/                 # 同构上层 API（FR-007）
│   │   │   │   ├── createTerrainScene.ts
│   │   │   │   ├── probeRenderPath.ts
│   │   │   │   ├── types.ts
│   │   │   │   ├── datasets.ts
│   │   │   │   └── errors.ts
│   │   │   ├── core/                # 后端无关抽象（不得 import 上游）
│   │   │   │   ├── backend.ts       # RenderBackend 接口（资源/管线/命令/帧生命周期）
│   │   │   │   ├── tile-registry.ts # 瓦片状态机 + 绘制集合截断规则
│   │   │   │   ├── gpu-registry.ts  # GpuResourceRegistry（字节计量 + 设备丢失失效）
│   │   │   │   ├── frame-stats.ts   # p50/p95、drawCalls、字节统计
│   │   │   │   └── geometry.ts      # 高程场 → 顶点/索引/裙边（两条路径共用的唯一几何生产者）
│   │   │   ├── terrain/
│   │   │   │   ├── heightmap.ts         # .hgt 读写 + 高程解码（structure → 米）
│   │   │   │   ├── terrarium.ts         # 公开栅格高程源解码（PNG → 高程场；浏览器与 Node 共用）
│   │   │   │   ├── source.ts            # TerrainSource 抽象（local-fixed / public）
│   │   │   ├── backends/
│   │   │   │   ├── webgl2/backend.ts    # 兜底后端：委托上游渲染 + 空实现资源层
│   │   │   │   └── webgpu/
│   │   │   │       ├── backend.ts       # 设备/队列/画布配置/帧生命周期
│   │   │   │       ├── pipelines.ts     # 管线与管线缓存
│   │   │   │       ├── terrain-pass.ts  # 逐瓦片 drawIndexed + 视锥裁剪
│   │   │   │       ├── recovery.ts      # device.lost → 重建或回退
│   │   │   │       └── shaders/*.wgsl   # 地形顶点/片元、深度修正
│   │   │   ├── adapters/cesium/         # 唯一允许 import "cesium" 的目录
│   │   │   │   ├── widget.ts            # CesiumWidget 构造 + 双画布 DOM 分层
│   │   │   │   ├── render-hook.ts       # Scene.postRender 订阅、requestRender 维持
│   │   │   │   ├── camera.ts            # viewMatrix/projectionMatrix + GL→WebGPU 深度修正
│   │   │   │   ├── terrain-provider.ts  # TerrainProvider 子类（公开扩展点）
│   │   │   │   ├── globe-surface.ts     # baseColor 透明 + globe.show 保持 + 瓦片事件
│   │   │   │   └── public-api-allowlist.ts # 运行期断言：只使用白名单符号
│   │   │   └── diagnostics/             # 路径状态提示、日志、错误分类
│   │   └── fixtures/<datasetId>/        # 固定地形数据集（≤20 MiB，含 manifest/layer.json/.terrain）
│   └── verify-harness/                  # private 包：采集/对比/基准/插桩
│       ├── src/{capture,stats,compare,harness,bench,instrumentation}.ts
│       ├── reference-frames/<datasetId>/
│       └── tolerances/tol-v1.json
├── apps/
│   └── demo/                        # 演示页（只 import 包入口；无路径分支；可配置 preference）
│       ├── index.html
│       └── src/main.ts
├── tests/
│   ├── unit/                        # node:test：探测决策/解码/状态机/截断规则/架构边界 A1–A5/评估文档契约
│   ├── contract/                    # Playwright：双路径参数化加载、交互、回退、设备丢失
│   ├── visual/                      # Playwright：像素对比 + 差异图 + 统计断言
│   └── bench/                       # Playwright：基准采集 + 门槛判定
├── tools/
│   ├── build-terrain-fixture.mjs    # 一次性生成固定数据集（--from-public / --from-local / --verify-only）
│   ├── license-check.mjs
│   └── rollup-plugin-wgsl.mjs
└── .github/workflows/
    ├── ci.yml                       # 构建 → 单测 → 契约 → 视觉 → 基准 → 许可证（门禁顺序）
    └── nightly-real-gpu.yml         # 可选：真实 GPU 对照（云 GPU runner 或自托管）
```

**Structure Decision**：采用"单仓库多包（npm workspaces）"：
- `packages/cesium-webgpu` 是唯一对外交付物（外部模块形态，`cesium` 为 peer dependency），
  内部按"公开 API / 后端无关核心 / 地形 / 后端实现 / Cesium 适配层 / 诊断"分层，
  **层间依赖方向单向**：`api → core ← backends`，`adapters` 仅被 `api` 的组合根引用，`backends` 之间零耦合。
- `packages/verify-harness` 为 private，验证与基准代码不进入发布产物（保证发布包无测试期依赖）。
- `apps/demo` 只依赖包入口，是 FR-007（集成方无分支）的活证据。
- 选择 npm workspaces 而非额外包管理器：本机已具备 npm 10.9.3，Node 22 内置 workspace 支持，减少工具链依赖。

---

## 关键设计决策（摘要，完整证据见 research.md）

| # | 问题 | 决策 | 主要被否决方案 |
|---|---|---|---|
| D1 | 画布与上下文归属 | **双画布分层**：上游 WebGL2 画布在下（天空/背景），本库 WebGPU 画布在上（地形，premultiplied alpha） | ① 同画布 `getContext("webgpu")` 接管（规范禁止，且 `Scene.context` 为 `@private`）；② 离屏渲染后逐帧合成（需全画面回读/拷贝，代价高且需私有 context）；③ OffscreenCanvas 反向合成（上游不支持注入外部画布） |
| D2 | 渲染循环接管点 | **`Scene.postRender`** 订阅（公开事件）+ `requestRenderMode` 下调用公开 `scene.requestRender()` 维持循环 | ① monkey-patch `Scene.prototype.render`（改上游运行时行为，原则 I 精神不符）；② 自建 `requestAnimationFrame` 循环（与上游帧不同步，易出现相机滞后与双重渲染） |
| D3 | 地形瓦片获取与复用 | **`TerrainProvider` 子类 + 公开 `HeightmapTerrainData`**（同一份 `HeightField` 既交给上游建网格、又用于 WebGPU 自建几何）；上游四叉树负责调度/LOD/可用性/预算/内存 | ① 直接用上游 `CesiumTerrainProvider`（其几何无法取出：`createMesh`/`TerrainMesh`/`TerrainEncoding` 为 `@private`）；② 用私有 API 读上游网格（违反原则 I）；③ 自研空间索引（违反 spec Assumptions）；④ 用公开 `interpolateHeight` 逐点采样重建（精度与复杂度均不可接受，见 H-4） |
| D4 | 相机与矩阵 | 读公开 `scene.camera.viewMatrix`、`camera.frustum.projectionMatrix`，乘一个深度范围修正矩阵（GL 裁剪空间 z∈[-1,1] → WebGPU z∈[0,1]）；视口取 `scene.drawingBufferWidth/Height` | ① 读 `scene.pixelRatio` / `scene.frameState`（均为 `@private`）；② 自建相机（放弃上游相机模型，违反 Assumptions） |
| D5 | 免登录地形数据源 | 公开免登录**栅格高程源**（AWS Open Data Terrarium：实测 200 + CORS `*` + z0–15 + XYZ 约定，浏览器内解码为高程场）+ **同源字节的本地固定数据集**（勃朗峰区域 0.6°×0.5°、z0–12，约 3–6 MB；CI 离线）；上游注入格式用公开类 `HeightmapTerrainData`。核实证据见 research.md §6 | ① 需要令牌的服务（Cesium ion / MapTiler / Mapbox / Nextzen）——spec 明确后置，且实测不存在可用的免登录 Cesium 官方端点；② 仅本地数据集（无法满足 FR-004 的"公开可访问数据源"）；③ `ArcGISTiledElevationTerrainProvider`（构造函数为 `@private`，原则 I 禁止）；④ quantized-mesh 首选（唯一免登录端点 Re:Earth 的覆盖质量可疑，见 research.md §6.1/§6.3） |
| D6 | CI 无真实 GPU | 托管 runner + **Xvfb（headed）** + **Mesa lavapipe 作为 WebGPU 软件适配器**：两个并行 job 分别跑两路径；CI 中的基准只作**相对回归序列**（软件适配器无真实 GPU 时间戳）；真实 GPU 绝对数值走受门控的夜间作业（GPU larger runner 或自托管/现货云 GPU） | ① 完全不做新路径 CI（违反原则 V）；② headless + `--disable-vulkan-surface`（会彻底关掉 WebGPU 画布呈现，截图全黑）；③ `--enable-unsafe-swiftshader`（**只对 WebGL 生效**，对 WebGPU 无效）；④ 把 GPU larger runner 作为唯一手段（始终计费且单价约为现货云 GPU 的 7–23×） |
| D7 | 性能指标口径 | 帧时间 p50/p95（`postRender` 相邻时间差）+ 绘制批次数（WebGPU 计数；WebGL2 由脚手架包装**平台 API** 计数）+ 图形资源字节数（统一登记表 / 平台 API 上传字节） | ① 依赖真实 VRAM 读数（浏览器不暴露）；② 只测 FPS（无尾部信息）；③ 依赖 GPU 时间戳（软件适配器下不可用，且会使浏览器 Profiler 崩溃） |
| D8 | 视觉等价如何度量 | **每路径各自一份参考帧**做像素回归（阻断）+ **跨路径用统计量**（覆盖率、颜色分布、几何与绘制批次）判定等价（阻断）+ 跨路径像素差异仅在真实 GPU 本地运行记录（非阻断） | ① 跨路径逐像素比较（两条路径的光栅化器/着色器编译器/MSAA 解析/sRGB 路径均不同，会把实现差异误判为回归，或用放宽容差掩盖真实缺陷）；② 只做路径内回归（无法满足 FR-008 的两路径一致性要求） |

---

## MVP 工期与 AI/Agent 消耗评估（FR-026 ~ FR-029 / SC-007）

完整结论见 [mvp-estimate.md](./mvp-estimate.md) 与机器可校验的 [mvp-estimate.v1.json](./mvp-estimate.v1.json)（CI 按 schema 校验）。

**计量口径（显式声明）**：只计 **AI/Agent 消耗** = 模型 token（**输入/输出分别计量**，缓存命中/未命中分层计价）+ 算力费用
（CI runner 与可选云 GPU）；**人工成本不计入**，本机硬件电力与折旧不计入；货币人民币为主并同时给出美元口径
（1 USD = 6.7580 CNY，PBOC 2026-09-17）。单价全部带来源与读取日期。

| 工作流 | 时间（工作日） | token 输入 (M) | token 输出 (M) | token 成本（CNY） | 算力成本（CNY） |
|---|---|---|---|---|---|
| W1 渲染管线与地形绘制 | 3.0 – 6.0 | 3.6 – 21.0 | 0.24 – 1.50 | ¥1.31 – ¥37.00 | ¥0 – ¥120 |
| W2 双路径能力探测与兜底 | 1.0 – 2.0 | 1.0 – 5.4 | 0.06 – 0.36 | ¥0.34 – ¥9.21 | ¥0 – ¥60 |
| W3 验证资产与测试基建 | 2.5 – 5.0 | 3.0 – 19.5 | 0.20 – 1.30 | ¥1.10 – ¥33.26 | ¥0 – ¥260 |
| W4 持续集成与基准基建 | 1.5 – 3.0 | 1.8 – 10.5 | 0.09 – 0.68 | ¥0.54 – ¥17.67 | ¥0 – ¥330 |
| W5 开源交付与文档 | 1.0 – 2.0 | 0.75 – 4.8 | 0.045 – 0.32 | ¥0.25 – ¥8.19 | ¥0 – ¥20 |
| W6 治理、评审与结论收尾 | 0.5 – 1.5 | 0.75 – 5.4 | 0.045 – 0.36 | ¥0.25 – ¥9.21 | ¥0 – ¥61 |
| **合计** | **9.5 – 19.5**（日历 2 – 4 周） | **10.9 – 66.6** | **0.68 – 4.52** | **¥3.79 – ¥114.54** | **¥0 – ¥851** |

**结论区间**：总量 **¥4 – ¥966（$0.6 – $143）**；**建议计划值 ¥150 – ¥450（$22 – $67）**。
关键洞察：MVP 的 AI/Agent 消耗**主要由算力项决定**（token 项 ≤ ¥115），
因此控制成本优先做三件事：① 公共仓标准 runner 免费承担尽量多流水线环节；
② 真实 GPU 验证用按秒计费的现货云 GPU（¥0.92–¥2.97/小时）而非 GPU larger runner（¥21.1/小时）；
③ 任务调度在空闲时段并控制重试退避（token 项 2× 摆动）。

**已确认 / 待确认**：8 项待确认项（真实 GPU 基准的执行方案选择、云 GPU 实际成交价、模型单价变动、缓存命中率、
执行时段、本机 GPU 可用性、返工回合数）逐项列在 mvp-estimate.md §5，含影响方向与量级；
**无历史基线**（空仓，无既往消耗记录）是区间偏宽的主因，已如实说明；交付后按 FR-028 回填实际值。

---

## Complexity Tracking

> 本方案有 4 项需要显式论证的复杂度/取舍（无原则违规，但均需记录被否决的更简方案）。

| # | 复杂度 / 取舍 | 为何需要 | 被否决的更简方案及否决原因 |
|---|---|---|---|
| 1 | **自定义 `TerrainProvider` + 自建高程数据源适配与几何构建**（而非直接使用上游 `CesiumTerrainProvider`） | 上游网格构建链 `TerrainData.createMesh` / `TerrainMesh` / `TerrainEncoding` 全部 `@private`（research.md §1 已核实），WebGPU 端**无法**从上游的 terrain data 对象取得顶点坐标；若直接用上游 provider，新路径将没有任何几何来源 | ① 通过 `@private` API 读取上游网格 → 违反原则 I（NON-NEGOTIABLE），直接否决；② 用公开 `interpolateHeight` 逐点采样重建高程场 → 每个采样点需在三角形集合中查找，量级不可接受且仍无法还原顶点拓扑（H-4 给出实测方法）；③ 自研空间索引/LOD → 违反 spec Assumptions「不在本增量重新设计空间索引」。**同时**：该复杂度被严格限制在 `terrain/` 目录（字节获取、解码与几何构建），上游仍承担调度、LOD、可用性、请求预算与内存管理，符合 Assumptions 的收敛解释 |
| 2 | **双画布分层 + 保留上游一次"不可见"地形绘制** | 一个 canvas 只能有一种上下文类型；`globe.show = false` 会**同时关闭瓦片调度**（`Globe.update/render/endFrame` 在 `!show` 时直接 return，已核实，research.md §2），因此不能靠它抑制绘制；上游没有公开的"关闭地形绘制但保留调度"开关 | ① `globe.show=false` + 自研调度 → 失去与兜底路径的 LOD 等价性，违反 Assumptions；② 逐帧回读上游画布再合成 → 需要 `Scene.context`（`@private`）且每帧全画面拷贝，代价与延迟都不可接受。**代价处理**：该次不可见绘制的开销由基准显式度量（用 `globe.show=false` 的诊断运行做差分归因），并在基准报告中标注；MVP 不得据此宣称性能收益（符合 spec「性能期望」）；后续增量可向上游提公开渲染委托扩展点 |
| 3 | **`GpuResourceRegistry` 自建显存计量 + 用平台 API 包装统计 WebGL2 绘制批次** | 浏览器不暴露真实 VRAM；两路径必须同口径可比（原则 IV） | ① 只报 FPS → 无尾部与批次信息；② 只在新路径计量 → 无法与兜底路径对比。包装的是 `WebGL2RenderingContext` 平台方法，**不是**上游内部实现，不违反原则 I；该指标被明确声明为"经图形 API 分配的资源字节数"代理指标 |
| 4 | **评估结论作为版本化交付物 + CI 文档契约测试** | FR-026 ~ FR-029 的硬性要求（用户明确要求的交付价值） | 仅写一份 Markdown 而不机器校验 → 无法保证"口径显式声明"与"单价可追溯"长期不被破坏（SC-007 要求可核对）。已通过 JSON Schema + 7 条断言把要求变成 CI 可判定项 |

**无原则违规**，因此 Constitution Check 的 ERROR 门禁未触发；上表为透明化记录的取舍。

---

## 实现前的验证门（Risk Gates）

下列 3 项为**待验证假设**（research.md §8 给出完整清单与验证方法），必须在对应工作流开始前用最小实验关闭；
未通过则按 research.md 记录的替代方案调整（不改变上层 API 与验收判据）：

| 门 | 待验证内容 | 关闭方式 | 失败的退路 |
|---|---|---|---|
| G-1 | 双画布分层 + 上游不可见绘制 + 自定义 provider 的最小闭环可工作 | 渲染 1 个瓦片并截图（≤0.5 工作日） | 改用"保留上游地形绘制 + WebGPU 画布改到上层并设不透明背景"并在基准中标注额外开销 |
| G-2 | 绘制集合截断规则（resident ∩ frustum ∩ 父子替换）与上游真实绘制集合在固定相机下等价 | 固定相机 + `tilesLoaded` 后对比两路径几何统计与像素差异 | 改用备选方案 V2：以自实现 `Primitive` 的 `update(frameState)` 观察 `commandList`（需先验证 `DrawCommand.owner` 语义，见 H-2） |
| G-3 | CI 中 lavapipe 下的参考帧**跨运行稳定**（重复采集两次的差异在容差内），且两路径作业合计 ≤ 20 分钟 | 在托管 runner 跑两次采集并比对（组合可用性已由 research.md §7 核实） | 视觉回归在 CI 降级为"数值统计断言 + 本机真实 GPU 像素对比"（盲区按 FR-023 记录）；20 分钟超时则缩减采样帧数并在 PR 说明 |

## Phase 0 / Phase 1 产物与下一步

- **Phase 0（研究）**：[research.md](./research.md) — 已核实证据表、7 项技术决策、待验证假设 H-1…H-8、被否决方案汇总。
- **Phase 1（设计）**：[data-model.md](./data-model.md)、`contracts/`（4 份）、[quickstart.md](./quickstart.md)、
  [mvp-estimate.md](./mvp-estimate.md) / [mvp-estimate.v1.json](./mvp-estimate.v1.json)。
- **下一步**：`/speckit-tasks` 生成依赖序任务清单（按 G-1 → G-2 → W1 → W2 → W3 → W4 → W5 → W6 排序，
  每个渲染特性与对应的验证用例成对出现），随后 `/speckit-analyze` 做一致性校验。
