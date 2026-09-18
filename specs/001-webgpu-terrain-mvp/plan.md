# Implementation Plan: WebGPU 渲染后端替换（CesiumJS 1.145.0 受控 fork / 补丁层）

**Branch**: `001-webgpu-terrain-mvp` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-webgpu-terrain-mvp/spec.md`（含 2026-09-19 需求纠偏：`FR-030`~`FR-033`、`SC-010`）
**Research**: [research.md](./research.md)（全部上游结论附 `文件:行`）｜ **Constitution**: [v2.0.0](../../.specify/memory/constitution.md)

> **本版是整体重写**：上一版 plan 建立在"双画布分层 + 把上游绘制藏起来"的旁路架构上，
> 该架构已被用户明确否决（spec Clarifications Q3/Q4），其架构部分全部作废。
> 本版方向为**用 WebGPU 替换渲染后端**：改动严格局限在上游 `Source/Renderer/**`（渲染后端层），
> `Scene` / `Globe` / 四叉树调度 / `Camera` / 图层 / 命令系统的代码与语义**一行不改**（SC-010）。

## Summary

把 CesiumJS 的**渲染后端层**（GPU 上下文/设备与资源、着色器编译、管线与绑定状态、纹理与缓冲区、帧缓冲、绘制执行）
重实现为 WebGPU，使既有逻辑层（`Scene.render` → 命令构造/排序 → `DrawCommand.execute` → `Context.draw`）**零改动**
地跑在新后端上；因此影像、模型、大气等既有功能**随后端替换自然接入**（FR-033），无需逐功能重写。

技术路径（详见 [research.md](./research.md)）：

1. **接缝**：WebGL 触碰面 100% 位于 `Source/Renderer/**`（16 个文件 / 348 个调用点；`Renderer/` 之外仅 2 处命中且都不是真实渲染调用）
   → 补丁范围在**文件系统层面可判定**，SC-010 变成 CI 可机器审计的不变量。
2. **形态**：**模块级替换补丁层（patch layer）**——`@cesium/engine@26.3.0`（= `cesium@1.145.0`）作为钉版依赖原样安装，
   本仓库只提供"后端实现 + 替换清单 + 别名插件"，逻辑层是上游发布物本身 → "字节级不变"由依赖完整性天然保证。
3. **执行流**：上游**不存在** `beginPass/endPass`（`Source/**` 命中数 0）→ WebGPU 的 render pass 必须由后端
   在命令流上**派生**（通道身份 = framebuffer + viewport + scissor + draw buffers）。
4. **同步构造**：GPU 设备在构造上游场景**之前**预取，经后端层交接槽同步交给 `Context` 替换模块；
   `ContextLimits` 与能力标志在 `Scene` 构造期即可读（逻辑层在构造期就依赖它们）。
5. **数据源**：地形使用上游公开 `CustomHeightmapTerrainProvider`（免登录公开数据 + 本地固定数据集），
   几何构建与四叉树调度**全部由上游逻辑层完成**——本项目不再自建瓦片几何。
6. **着色器**：**已由实测尖刺定案**（`experiments/shader-spike/REPORT.md`）：**不转译 GLSL**，改为在 fork 层把着色器组装层
   （`ShaderSource`，MVP 阶段暂不含 `ShaderBuilder`）**参数化为 WGSL 发射器**，并把地形着色器闭包转换为 WGSL 入库
   （路径 A 出草稿 + 路径 B 人工定稿）。纯转译路线（`glslang→SPIR-V→naga→WGSL`）实测**不可交付**
   （原始 GLSL 6/6 失败、修补后片元 2/2 因 naga 30.0.1 崩溃、varying 名字丢失）；手工 WGSL 已在真机跑通
   （181+151 行、0 编译消息、回读 4096/4096 非黑像素）。该扩展属原则 I 明列的"着色器编译"，**仍在渲染后端层内**（见 Constitution Check 原则 I）。

## Technical Context

**Language/Version**: TypeScript 5.x（`strict` 开启）实现本项目自有包与后端替换模块；上游 `@cesium/engine` 以 ESM 源码（`Source/**`）消费；脚本一律用 Node.js（`node:fs` / Rollup JS API / Playwright API），不使用 shell 专有语法。

**Primary Dependencies**: `@cesium/engine@26.3.0`（= `cesium@1.145.0`，**精确版本 + integrity 哈希钉版**，Apache-2.0）；构建 `rollup` + `@rollup/plugin-typescript` + `@rollup/plugin-node-resolve` + `rollup-plugin-dts`；测试 `node --test`（单元/契约）+ `playwright`（**版本精确固定**，浏览器像素回归与基准）；类型 `@webgpu/types`；上游内部模块类型由本项目自维护声明（上游 `Source/**` 仅 2 个 `.d.ts`，实测）。

**Storage**: 本地固定地形数据集（`packages/cesium-webgpu/fixtures/<datasetId>/manifest.json` + `<level>/<x>/<y>.hgt`，约 3–6 MB，随仓库提交，CI 全程离线）；CI 产物（构建日志、测试报告、差异图、基准 `history.jsonl`、补丁审计与一致性清单）作为归档；无数据库。

**Testing**: `node --test` 单元测试（探测决策、补丁范围审计、别名插件白名单、uniform 布局生成、格式映射表、评估文档契约）；`node --test` + Playwright 契约测试（**同一套用例参数化两条路径，各自独立进程/独立页面加载**）；Playwright 视觉回归（**每路径各自参考帧**）；Playwright 基准（帧时间 p50/p95、图形显存代理指标、draw call 数）。

**Target Platform**: 桌面浏览器。WebGPU 路径要求 `navigator.gpu` + 可用适配器（本机已实测无头 Chrome 153 零开关取得硬件适配器）；WebGL2 兜底路径面向既有主流浏览器。CI：GitHub Actions 公共仓标准 runner（Ubuntu），两套免费软件适配器配方（WebGPU：Xvfb + Mesa lavapipe；WebGL2：ANGLE + SwiftShader）。

**Project Type**: 单仓库多目录（library + demo app + tools）：`packages/cesium-webgpu/`（交付包，内含后端补丁层与验证/基准基建）、`apps/demo/`（演示页，只 import 包入口）、`tools/`（别名插件、审计、清单生成、升级演练、数据集生成、静态服务）、`tests/`。

**Performance Goals**: MVP 首要目标是**正确性与可验证性**，其次是相对兜底路径**不劣化**；基准口径固定为帧时间 p50/p95、图形显存（代理指标：本项目登记的 GPU 对象字节数）、draw call 数（统计真实 `drawIndexed/draw` 调用）；两条路径在各自独立会话采集；绝对性能与 GPU 时间戳只在受门控的真实 GPU 作业采集（默认不执行，需预算批准）。

**Constraints**: ①改动 MUST 全落在 `Source/Renderer/**`（replace-file-set fork；由 CI 审计）；②`Scene` / `Globe` / `QuadtreePrimitive` / `Camera` / 图层 / `DrawCommand` 的代码与语义零改动（SC-010）；③**两条后端路径 MUST NOT 同时绘制同一场景**，回退是整体销毁重建（原则 II）；④路径选择在初始化阶段完成，探测上限 2 秒；⑤CI 单次提交到结论 ≤20 分钟；⑥无 GPU 环境必须能跑两条路径；⑦不得引入任何需要凭据的地形服务；⑧交付为开源形态（Apache-2.0 + NOTICE + 可复现构建说明）。

**Scale/Scope**: 后端替换面 = `Renderer/**` 47 个文件 / 19,691 行中的 **16 个必替换文件（348 个 WebGL 调用点）+ 约 7 个适配文件（含 `ShaderSource.js`）**，其余 GL-free 文件字节不变（`ShaderSource.js` 除外）；逻辑层消费的后端面 = `Context` 约 30 个成员（`uniformState` 57 处引用为最高）+ 约 20 个资源类工厂/构造面；**着色器面** = 上游 320 个 `.js` 着色器模块 / 319 个 `.glsl`（13,825 行）/ 244 个 `czm_` 标识符，**MVP 只需地形闭包**（`GlobeVS`/`GlobeFS`/`AtmosphereCommon`/`GroundAtmosphere` + 约 40 个内建，实测默认配置拼装后 VS 870 行 / FS 1,886 行、92 个 uniform 声明）；MVP 场景 = 单地球 + 地形（`baseLayer:false`、`skyBox:false`、`skyAtmosphere:false`、无后处理）。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*（依据 [.specify/memory/constitution.md](../../.specify/memory/constitution.md) **v2.0.0**）

### 原则 I — 受控 fork（NON-NEGOTIABLE）

| 条款 | 本方案的合规方式 | 证据 |
|---|---|---|
| 允许 fork 或以可 rebase 补丁层承载改动，**MUST 记录形态选择依据** | 选**模块级替换补丁层**；依据：逻辑层"字节不变"可由依赖完整性机器证明，升级成本从 git 冲突变为接口清单差异 | [research.md](./research.md) §2.1 |
| **MUST 局限在渲染后端层** | 替换清单 MUST 全部匹配 `^Renderer/[A-Za-z0-9_]+\.js$`；CI 白名单穷举测试 + 构建产物审计 | §2.2/§2.4 |
| **MUST NOT 改逻辑层语义**（`Scene`/`Globe`/`QuadtreePrimitive` 调度/`Camera`/图层/`DrawCommand` 一行不改） | 逻辑层不在本仓库（是钉版依赖的发布物）；本仓库不存、不改这些文件 | §2.4 |
| **MUST 保持可升级**：记录基线版本、补丁范围、补丁理由；提供 rebase 演练 | `upstream/engine-26.3.0.lock.json`（版本 + integrity + 基线说明）、`vendor/engine-patch/manifest.json`（路径 + 每个文件的存在理由）、`docs/rebase-runbook.md` + `tools/upgrade-drill.mjs`（干跑/完整两模式） | §2.6/§2.7/§10 |
| 公开 API 与官方扩展点**首选**；仅当公开接缝不存在时进入 fork 层，且 MUST 说明"为何不可用" | 已逐条评估并给出结论：`Scene.context` `@private`；`CesiumWidget` 自建 canvas 且一个 canvas 只能有一种上下文类型；`SharedContext` `@private`、不在 `index.d.ts`、内部仍构造 WebGL `Context`；资源类无替换扩展点 | §1.7（含 `Scene.js:1388`、`CesiumWidget.js:221-223`、`SharedContext.js:12,37`、`Scene.js:146-152`） |
| 补丁 MUST 最小，单个改动可追溯到一条需求；禁止顺手重构 | 每个替换文件在 `manifest.json` 中带 `requirementRef`（FR-030/FR-031）与理由；GL-free 文件**不进入清单**（即字节不变）；`ShaderSource.js` 的改动被限定为"增加 WGSL 发射通道" | §2.2/§2.4 |
| **fork 足迹扩到"着色器编译前端"是否越界？——不越界（显式论证）** | `ShaderSource.js`/`ShaderBuilder.js`（以及本项目新增的 WGSL 发射器与 WGSL 库）都位于 `Source/Renderer/**`，属原则 I 允许范围里**明列的"着色器编译"**；它们不是逻辑层文件，也不改变 `Scene`/`Globe`/`QuadtreePrimitive`/`Camera`/图层/`DrawCommand` 的语义与公开行为。**强约束**：`shaderProgram.vertexShaderSource`/`fragmentShaderSource` 暴露给逻辑层的**仍是原始 GLSL**（`Scene/Primitive.js:849,1011-1020` 会对 GLSL 文本做正则探测），WGSL 发射只发生在内部副本通道上；WGSL 转换产物存于后端层目录（不写入 `Source/Shaders/**`），以**叶子文本哈希映射**与上游关联 | §6.3（含尖刺 §7.1/§7.4 证据） |
| **否决的替代方案（记录）** | 尖刺退路三"双层 WGSL 源码库、fork 层只做'选哪一份'"：**未被采用**，仅当参数化发射目标被判越界时启用；代价是可升级性显著变差 | §12 |

**Gate 结论：PASS**（进入 fork 层的理由已书面给出；边界可机器审计）。

### 原则 II — 二选一，不同时运行（NON-NEGOTIABLE）

| 条款 | 本方案的合规方式 | 证据 |
|---|---|---|
| 后端在初始化时选定，同一场景 MUST NOT 被两条路径同时绘制 | 探测 → 选择 → 构造：探测失败时**根本不安装**设备交接 → 用上游原版 WebGL2 `Context` 构造；不存在"两条路径各画一半"的中间态 | §3 |
| MUST NOT 图层叠加/透明遮挡/逐帧合成/使其中一次绘制不可见 | 方案中**不存在**第二个画布、合成器或遮挡手段；被否决方案清单明确记录双画布、隐藏上游 canvas、CSS 遮挡、逐帧合成四种形态一律禁止 | §12（被否决方案） |
| WebGL2 为兜底，MUST NOT 成为唯一路径；WebGPU 必经能力探测 | 兜底=上游原版后端（始终可用）；WebGPU 需 `navigator.gpu` + adapter/device + 必需能力项与下限 | §3/§4 |
| 回退 MUST 是整体切换（销毁并以其对端重建） | `device.lost` / 探测失败 → 销毁 `CesiumWidget`/`Scene`/后端 → 重建；MUST NOT 保留旧设备资源或绘制结果 | §3 |
| 上层 API 唯一；调用方 MUST NOT 出现后端分支，MUST NOT 引用具体后端类型 | 包入口只导出后端无关的 `TerrainSceneHandle`；构建后断言 `dist/index.d.ts` 不含 `/GPU[A-Z]|WebGPU|WebGL/`；调用方分支由架构边界测试禁止 | 契约 [render-path-api.md](./contracts/render-path-api.md) §1/§4 |
| 渲染后端抽象：上层只依赖抽象接口，后端实现不得被上层反向 import | 抽象层在 `src/render-path/`；WebGPU 实现位于 `backend-webgpu/`，其类型不出现在包入口的公开类型中 | 契约 §1 |

**Gate 结论：PASS**。

### 原则 III — 可验证渲染

- 每项渲染特性附自动化验证：像素/截图对比（含容差）+ 数值化帧统计（非背景覆盖率、颜色/深度分布、几何与 draw call 统计）。
- 两条后端路径的用例**各自独立运行**（独立进程 + 独立页面加载），任一路径失败即判定该次提交失败；
  **每路径各自参考帧**（跨路径逐点像素比较不可靠——不同光栅化器/着色器编译器/MSAA 解析/sRGB 路径）；
  跨路径等价用统计断言与几何统计判定，无法消除的差异在契约中显式声明（亚像素边缘、MSAA 解析、sRGB、深度表示）。
- 固定相机/时间/随机种子/视口/像素比/数据集；非确定性来源量化记录。
- 容差阈值写在测试代码中且可追溯来源；禁止"任意差异均通过"。
- 视觉回归输出差异图作为 CI 产物。
- **Gate 结论：PASS**（契约见 [verification-and-benchmark.md](./contracts/verification-and-benchmark.md)）。

### 原则 IV — 性能以数据驱动

- 先基线后优化；基准记录帧时间 p50/p95、图形显存（代理指标）、draw call 数，固定场景/数据集/预热/采样帧数与环境指纹；量化回归门槛（超阈值即失败），阈值变更记录理由。
- 两条路径的基准在**各自独立的运行会话**采集，MUST NOT 以"两条路径同时运行"的会话作对比口径。
- **Gate 结论：PASS**（同契约 §5）。

### 原则 V — CI 为唯一事实来源

- 每次提交（含 PR）在 CI 完成构建、测试、基准，任一未通过不得合入；主干始终可构建/可运行/可回退。
- 判定"完成"的权威依据是 CI 产物（构建日志、测试报告、基准数据、视觉差异图）。
- **新增（v2.0.0 要求）**：fork 层改动纳入 CI 校验——**补丁范围审计**（替换清单全部落在渲染后端层）与**升级演练验证结果** MUST 作为 CI 产物存档；本次另加"依赖完整性哈希"与"别名插件白名单穷举"两项断言。
- 无 GPU 环境的降级策略与盲区显式记录（`docs/ci-degradation.md`：软件适配器≠GPU、Xvfb headed、无 `timestamp-query`、浏览器版本漂移改变像素等），并给出本地复现步骤。
- 依赖与许可证检查纳入 CI（Apache-2.0、NOTICE、修改文件清单、地形数据署名非空）。
- **Gate 结论：PASS**。

### 附加技术约束

TypeScript `strict` + Rollup + ESM 与类型声明；Node.js ≥22；集成形态为**受控 fork（模块级替换补丁层）**，改动隔离于渲染后端层，本项目自有代码以独立包交付且 MUST NOT 与上游脱钩（基线版本与完整性哈希可追溯）；开源交付含 LICENSE / NOTICE（派生作品与修改文件清单）/ CONTRIBUTING / 可复现构建说明；持续集成模式（无长期分支）；MVP 判据见 spec SC-001~SC-010。

### 设计后复检（Post-Design Re-check）

Phase 1 产物（data-model / contracts / quickstart）落实后复检：**五项原则结论不变，无违规项**；
新增的两处复杂度（uniform 布局生成器、切片 A 的临时能力降级）已登记在 Complexity Tracking 并附退出条件。

## Project Structure

### Documentation (this feature)

```text
specs/001-webgpu-terrain-mvp/
├── plan.md              # 本文件
├── research.md          # Phase 0：决策 D1–D10 + 上游证据（文件:行）
├── data-model.md        # Phase 1：实体与状态机（后端替换语义）
├── quickstart.md        # Phase 1：可运行验证指南（两条路径各自独立运行）
├── contracts/           # Phase 1：契约
│   ├── render-path-api.md            # 上层 API、路径二选一、可观察状态、无分支约束
│   ├── fork-patch-layer.md           # 补丁层形态、替换清单、审计、升级演练、许可证
│   ├── terrain-source.md             # CustomHeightmapTerrainProvider 适配 + 固定数据集 + 署名
│   ├── verification-and-benchmark.md # 双路径独立运行、容差、差异证据、基准与 CI 门禁
│   └── mvp-estimate.schema.json      # 评估结论的机器可校验 schema（沿用，未改）
├── mvp-estimate.md      # FR-026~029 / SC-007：工期与 AI/Agent 消耗（v2.0.0）
├── mvp-estimate.v1.json # 同上的机器可校验副本
└── tasks.md             # ⚠️ 阶段 3 产物：上一版基于被否决架构，**已失效，必须由 /speckit-tasks 重新生成**
```

### Source Code (repository root)

```text
packages/cesium-webgpu/                 # 本项目交付包（包入口后端无关）
├── src/
│   ├── index.ts                        # 唯一上层 API（MUST NOT 导出任何后端/GPU 类型）
│   ├── api/                            # createTerrainScene、句柄、错误与状态类型、数据集清单
│   ├── render-path/                    # 能力探测 → 后端二选一 → 整体回退（销毁重建）→ 可观察状态
│   ├── terrain/                        # CustomHeightmapTerrainProvider 适配 + 固定数据集读取 + 署名
│   ├── verify/                         # 像素/统计断言、差异图、基准采集（被 tests 与 CI 复用）
│   └── status/                         # 路径、原因类别、降级与盲区标注
├── backend-webgpu/                     # 补丁层：渲染后端层的替换实现（唯一允许的改动面）
│   ├── manifest.json                   # 替换清单：module path → 本地文件 + requirementRef + 理由
│   ├── Renderer/                       # 与上游同名的替换模块（Context/Texture/ShaderProgram/ShaderSource/…）
│   └── webgpu/                         # 设备交接、通道状态机、管线缓存、能力合成
│       ├── glsl-preprocess.*           # 上游缺失的 GLSL 条件编译求值（含 #elif 链与算术条件）
│       ├── wgsl-emitter.*              # WGSL 发射器（变体生成、varying 成对推导、UBO/bind group 布局）
│       ├── wgsl-prelude/               # czm_ 内建的 WGSL 库（地形闭包）
│       ├── wgsl/                       # 由上游着色器叶子转换而来的 WGSL（不写入 Source/Shaders/**）
│       ├── shader-leaf-map.json        # 上游叶子文本哈希 → WGSL 文件（升级漂移检测用）
│       └── generated-fragments.*       # 运行时片段的镜像生成器（computeDayColor 等）
├── fixtures/<datasetId>/               # 本地固定地形数据集（manifest.json + <level>/<x>/<y>.hgt）
├── types/engine-internal.d.ts          # 自维护的上游内部模块类型声明（消费面即接口清单的人工可读部分）
└── dist/                               # 构建产物：ESM + .d.ts（**内含经替换的上游引擎源码**）
apps/demo/                              # 演示页：只 import 包入口；展示当前路径/回退原因/署名/进度
tools/                                  # 别名插件、补丁范围审计、接口清单生成、升级演练、数据集生成、静态服务
├── rollup-plugin-engine-patch.mjs      # 按解析后的绝对路径改写 node_modules/@cesium/engine/Source/Renderer/<X>.js
├── audit-patch-scope.mjs               # 清单 ⊆ Renderer/** 审计 + 别名白名单穷举
├── gen-interface-manifest.mjs          # 上游内部接口面清单（升级 diff 用）
├── upgrade-drill.mjs                   # 升级演练：干跑 / 完整（含全量验证）
└── build-terrain-fixture.mjs           # 固定数据集生成（公开源 → 本地格式，一次性）
tests/
├── unit/                               # node --test：探测决策、审计、别名白名单、布局生成、格式映射、评估契约
├── contract/                           # Playwright：契约用例（参数化 webgl2 / webgpu，各自独立运行）
├── visual/                             # 视觉回归（每路径各自参考帧 + 差异图产物）
└── benchmark/                          # 基准（两路径各自独立会话）
docs/                                   # ci-degradation.md、fork-notice.md、rebase-runbook.md
upstream/                               # engine-26.3.0.lock.json、interface-manifest.json（基线元数据）
.github/workflows/ci.yml                # 单工作流串行门禁 + 两条路径的独立 job
```

**Structure Decision**：采用"交付包（`packages/cesium-webgpu/`）+ 演示页（`apps/demo/`）+ 工具（`tools/`）+ 测试（`tests/`）"
的单仓库多目录结构。**关键点**：渲染后端层的替换实现集中在 `packages/cesium-webgpu/backend-webgpu/`，
其边界既是**目录约定**也是 **CI 断言对象**（所有被替换的上游模块路径 MUST 匹配 `^Renderer/`），
使"改动只落在渲染后端层"同时具备目录可见性与机器可验证性；上游逻辑层不存在于本仓库（钉版依赖），
因此 SC-010 不依赖评审纪律。交付形态为**预打包 ESM 产物**（`dist/` 内含经替换的上游引擎源码），
消费方无需自建别名插件即可使用；别名插件作为仓库内部构建工具（`tools/rollup-plugin-engine-patch.mjs`），
同时以"可选的插件形态"对外提供，供希望自行打包的消费方使用。

## 架构图

```text
┌──────────────────────────────── 应用 / 演示页（无后端分支）─────────────────────────────────┐
│  只 import 包入口：createTerrainScene({ container, dataset, preference }) → TerrainSceneHandle │
└───────────────────────────────────────────┬────────────────────────────────────────────────┘
                                            │  上层 API 唯一（原则 II）
┌───────────────────────────────────────────▼────────────────────────────────────────────────┐
│ packages/cesium-webgpu/src/                                                                │
│  render-path/  能力探测（≤2s）→ 后端二选一（webgpu | webgl2，整体切换）→ 可观察状态            │
│  terrain/      CustomHeightmapTerrainProvider 适配 + 固定数据集 + 署名                       │
│  verify/       像素/统计断言、差异图、基准采集                                                │
└───────┬─────────────────────────────────────────────────────────────────┬──────────────────┘
        │ 预取 GPUDevice（异步）→ 写入后端层交接槽                          │ 不安装交接槽 = 走兜底
        ▼                                                                 ▼
┌───────────────────────────── 受控 fork 层（唯一允许改动面）─────────────────────────────────┐
│ packages/cesium-webgpu/backend-webgpu/  （替换清单 MUST ⊆ Source/Renderer/**）              │
│                                                                                            │
│  Renderer/Context            ← WebGPU 设备/交换链/能力合成/ContextLimits/clear/draw 分派      │
│  Renderer/Buffer/Texture/    ← GPUBuffer / GPUTexture / GPUSampler / 顶点布局                 │
│           Sampler/VertexArray                                                              │
│  Renderer/Framebuffer/       ← render pass 附件 + MSAA(4×) resolve（无 FBO 对象）             │
│           Renderbuffer/MultisampleFramebuffer/FramebufferManager                            │
│  Renderer/ShaderProgram/     ← GPURenderPipeline + 绑定布局（**转译层可替换**：路径由          │
│           ShaderCache          experiments/shader-spike/REPORT.md 确定）                      │
│  Renderer/createUniform*/    ← 自动 uniform 块 + 动态偏移环形缓冲 + 纹理 bind group            │
│  Renderer/RenderState        ← RenderState 选项形状不变 → GPURenderPipelineDescriptor 映射     │
│  webgpu/{device-handoff,pass-encoder,pipeline-cache,bind-layout,shader-translate,capability} │
│                                                                                            │
│  【字节不变】其余 31 个 GL-free 模块：DrawCommand / ClearCommand / ComputeCommand / Pass /     │
│  PassState / UniformState / AutomaticUniforms / ShaderSource / ShaderBuilder / Sampler /     │
│  PixelDatatype / BufferUsage / ContextLimits / 纹理枚举 …                                    │
└───────────────────────────────────────────┬────────────────────────────────────────────────┘
                                            │ 逻辑层调用面保持不变（context.* 约 30 个成员 + 资源类工厂）
┌───────────────────────────────────────────▼────────────────────────────────────────────────┐
│ 上游逻辑层（@cesium/engine@26.3.0，钉版依赖，**字节级不变**）                                 │
│ Scene.render → updateAndExecuteCommands → performPass(Pass.GLOBE) → executeCommand            │
│   → DrawCommand.execute(context, passState) → Context.draw → beginDraw/continueDraw           │
│ Globe / QuadtreePrimitive 调度 / Camera / 图层 / 命令构造与排序：零改动                        │
└────────────────────────────────────────────────────────────────────────────────────────────┘

兜底路径（同一上层 API，另一次独立运行）：交接槽为空 → 上游原版 WebGL2 Context/Renderer 全链
```

## 关键设计决策（完整论证见 research.md）

| # | 决策 | 结论 | 依据 |
|---|---|---|---|
| D1 | 渲染接缝与 fork 形态 | 替换 `Source/Renderer/**`；形态=模块级替换补丁层（钉版依赖 + 替换清单 + 别名插件） | §1.1/§1.2/§2.1 |
| D2 | 设备获取与同步构造 | 预取 `adapter/device` → 后端层交接槽 → 同步构造 `Context`；探测失败则不安装（整体兜底） | §3 |
| D3 | 能力标志与 `ContextLimits` | 用真实 WebGPU 能力回答逻辑层门控；做不了的报 false 走既有降级分支；`ContextLimits` 由 `adapter.limits` 合成 | §4 |
| D4 | 命令执行映射 | 命令→通道**派生式**；`RenderState`→`GPURenderPipelineDescriptor` 映射表；uniform→自动块 + 动态偏移环形缓冲 + 纹理 bind group；深度范围修正归着色器侧 | §5 |
| D5 | 资源层映射 | 逐类映射表；无 FBO/VAO 对象；MSAA→`sampleCount`+`resolveTarget`；回读切片化 | §6.1/§6.2 |
| D6 | 着色器路径 | **已定案：不转译，改"换发射目标"**——`ShaderSource` 参数化双发射（GLSL/WGSL，GLSL 视图不变）+ 地形闭包 WGSL 库（叶子哈希映射）+ 条件编译求值 + varying 成对推导；`ShaderBuilder` 留在切片 C | §6.3（尖刺实测支撑） |
| D7 | MVP 切片 | 切片 A（画布通道 + 地形绘制）/ 切片 B（离屏帧缓冲 + MSAA + `GlobeDepth`，FR-030 明列"帧缓冲"故属验收要求）/ 切片 C（picking 回读、CubeMap、Texture3D、TextureAtlas、影像重投影：骨架 + 显式失败） | §7 |
| D8 | 地形数据源 | 上游公开 `CustomHeightmapTerrainProvider` + 本地固定数据集 + 公开 Terrarium 源；几何/调度全由上游逻辑层完成 | §8 |
| D9 | 验证与 CI | 两条路径**各自独立运行**；路径内像素回归 + 跨路径统计等价；CI 新增补丁范围审计/依赖完整性/一致性门禁；两套免费软件适配器 | §9 |
| D10 | 升级可维护性 | 接口清单化 + 门禁化 + 钉版 + 干跑模式；升级成本 = 清单差异驱动 | §10 |

## MVP 切片（实现范围）

- **切片 A（必须先跑通）**：
  **后端核心**：`Context`（设备/交换链/能力/`clear`/`draw`/`beginFrame`/`endFrame`）、`Buffer`、`VertexArray`、
  `Texture`+`Sampler`（含 `defaultTexture`）、`RenderState`（映射到管线描述符）、通道状态机 + 管线缓存 + 4× MSAA 解析；
  **着色器编译前端**：`ShaderSource` 双发射目标（**GLSL 视图不变**）、上游缺失的 **GLSL 条件编译求值**、
  `czm_` WGSL prelude、地形闭包的 WGSL 库（`GlobeVS`/`GlobeFS`/`AtmosphereCommon`/`GroundAtmosphere` + 约 40 个内建）、
  **运行时片段镜像生成器**（`GlobeSurfaceShaderSet.js:419-472` 的 `computeDayColor()`）、**varying 集合成对推导**、
  `ShaderProgram`+`ShaderCache`（变体级缓存）+`createUniform*` + uniform/绑定布局规划器；
  场景配置：`skyBox:false`、`skyAtmosphere:false`、**`baseLayer:false`**（影像重投影会派发真实 `ComputeCommand`）、
  无后处理、`globe.enableLighting=true`、地形来自 `CustomHeightmapTerrainProvider`；
  临时降级：`depthTexture=false`（于是 `GlobeDepth`/OIT 不创建）。
- **切片 B（MVP 验收要求）**：`Framebuffer`/`Renderbuffer`/`MultisampleFramebuffer`/`FramebufferManager` 的附件化实现、
  离屏深度纹理与深度拷贝用的视口四边形命令、`depthTexture=true` 翻转并重跑全量验证（FR-030 明列"帧缓冲"）。
- **切片 C（后续增量）**：picking/回读（`readPixels`/`readPixelsToPBO`/`Sync`）、`CubeMap`/`Texture3D`/`TextureAtlas`、
  `ShaderBuilder` 的 WGSL 化（模型/体素/高斯泼溅）与**全库 319 个着色器叶子 / 244 个 `czm_` 内建**的 WGSL 覆盖
  （尖刺外推 **2–4 人月**，**不计入本增量**）、影像重投影 GPGPU（上游此路径实为全屏四边形渲染通道，非 GPU compute）。
  这三个切片**MUST** 以显式可诊断错误暴露"未实现"，禁止静默失败。

## MVP 工期与 AI/Agent 消耗评估（FR-026~FR-029 / SC-007）

完整结论见 [mvp-estimate.md](./mvp-estimate.md) 与机器可校验副本 [mvp-estimate.v1.json](./mvp-estimate.v1.json)
（**结论版本 v2.0.0**；上一版 v1.0.0 对应被否决架构，**已失效**）。

| 项 | 结论 | 与 v1.0.0（已失效）的差异 |
|---|---|---|
| 工期（净 AI 工作量） | **20.0 – 41.5 工作日**（日历 2.6 – 6.5 周） | ×2.1（v1.0.0：9.5 – 19.5；v2.0.0：16.5 – 35.5） |
| token 消耗 | **¥8.46 – ¥264.36**（$1.27 – $39.21），输入 26.88–160.15 M / 输出 1.46–9.93 M | ×2.3（回合数 380–970 → 845–2,030） |
| 算力消耗 | **¥0 – ¥400**（本机硬件 GPU 可用时下界为 0） | 下降（不再需要双画布同帧合成校验；本机 GPU 承担真实硬件对照） |
| **计划值（S1 推荐）** | **¥260 – ¥670**（$38 – $99） | v1.0.0：¥150 – ¥450；v2.0.0：¥190 – ¥650 |
| 条件场景 S-V | 变体规模/精度与 Y 翻转回归返工：工期 **+1 – 4 工作日**、token **+¥15 – ¥60** | 取代 v2.0.0 的 S-M（着色器路线已定案，不再需要"手工 WGSL 回退"这一条件场景） |
| 着色器层（独立工作流 W4） | **5.0 – 10.0 工作日**（实测锚点：地形 MVP 着色器层 ≈1–2 周；`GlobeVS`+`GlobeFS` 一对 ≈3–5 人日） | 新增为独立工作流；**全库覆盖 2–4 人月为外推且不计入本增量** |

**计量口径（与 spec 一致，未变）**：只计 AI/Agent 消耗（模型 token 输入/输出分别计量、缓存命中/未命中分别计价 + 算力费用）；
**人工成本不计入并显式声明**；货币人民币并同时给出美元口径（1 USD = 6.7580 CNY，PBOC/CFETS 2026-09-17）；
区分已确认项与待确认项（含影响方向与量级）；单价来源可追溯（DeepSeek 价目表、GitHub Actions 费率、云 GPU 报价，均 2026-09-18 读取）。

## Complexity Tracking

> 本方案无 constitution 违规项；下表登记**必须论证的额外复杂度**（原则 I/Governance 要求"违反原则的例外与额外复杂度必须显式论证"）。

| 额外复杂度 | 为何必需 | 更简单的替代被否决的原因 | 退出条件 |
|---|---|---|---|
| **进入 fork 层**（模块级替换上游文件，取代纯公开 API 集成） | 公开接缝确实不存在：`Scene.context` `@private`；无法向 `CesiumWidget` 注入外部 canvas（且一个 canvas 只能有一种上下文类型）；`SharedContext` `@private`、不在 `index.d.ts`、内部仍构造 WebGL `Context`；资源类没有被替换的扩展点 | "双画布分层 + 遮住上游绘制"曾是最简单的替代——**被用户明确否决**，且违反原则 II（两条管线同时绘制同一场景、既有功能永远无法接入新后端） | 上游若出现官方渲染后端扩展点（如官方 WebGPU 后端或上下文注入接口），MUST 立即评估改走公开接缝并退役对应补丁 |
| **fork 足迹扩到"着色器编译前端"**（`ShaderSource` 双发射目标 + 本项目新增的 WGSL 发射器/条件编译求值/WGSL 库/运行时片段镜像） | 上游把 `#define/#ifdef` 当文本交给 GL 驱动求值，**WebGPU 侧没有驱动代劳**；WGSL 也没有 GLSL 的宽松 varying 匹配（不匹配即管线创建硬失败）。要"只替换管线而不改逻辑层"，着色器编译这一环必须由后端自己完成 | **否决：纯转译路线**（`glslang→SPIR-V→naga→WGSL`）——实测原始 GLSL 6/6 失败、修补后片元 2/2 因 naga 崩溃、varying 名字丢失，**不可交付**；**否决：运行时浏览器内转译**（继承同样问题且无 SPIR-V→WGSL 后端）；**否决：为地形单独写 WGSL 旁路**（等于在逻辑层之外再挂一条绘制链，与"只替换管线"相悖） | ①WGSL 发射器与条件编译求值有真机样例（尖刺已提供 181+151 行 WGSL 与 harness）与逐变体管线校验；②若 `ShaderSource` 参数化被判定越界，启用尖刺退路三（WGSL 库与 `.glsl` 并存）并把可升级性损失写入 rebase 演练 |
| **自建 WGSL uniform 布局生成器 + 绑定布局表** | WebGPU 没有 GL 驱动代劳的 uniform 反射；逻辑层通过 `command.uniformMap` 与 `AutomaticUniforms` 按**名字**提供值，必须在后端建立"名字 → 偏移/槽位"的一致映射 | "每个 uniform 一个 buffer/bind group"：绑定数与描述符数量爆炸（上游单个程序可用 uniform 上百个），且每命令多次 `setBindGroup` 显著抬高 CPU 开销 | `H-4` 通过后（布局生成器 + 单元测试 + 像素断言稳定），可评估进一步压缩为共享块 |
| **切片 A 的临时能力降级 `depthTexture=false`** | 让"画布通道 + 地形绘制"先独立跑通，把离屏帧缓冲/MSAA 解析的风险与画布通道风险解耦，缩短首次可运行时间 | 一开始就实现全部帧缓冲路径：把两类失败模式（画布呈现 vs 离屏目标/解析）混在一起，首次可运行时间与定位成本显著上升 | **切片 B 完成后 MUST 翻转为 `true` 并重跑全量验证**；长期停留在降级态即视为 FR-030 未兑现（在 tasks.md 中登记为阻断项） |
| **双软件适配器的 CI 矩阵（Xvfb+lavapipe / ANGLE+SwiftShader）** | 原则 III/V 要求两条后端路径各自独立验证，而默认 CI 无 GPU | 只跑一条路径或跳过 WebGPU：直接违反 SC-001/FR-011；用付费 GPU runner 替代：公共仓也始终计费（¥21.08/小时），成本不可接受 | 若出现免费的 CI GPU 环境，可简化为单环境两路径独立运行 |
| **自维护上游内部模块类型声明**（`types/engine-internal.d.ts`） | 上游 `Source/**` 只有 2 个 `.d.ts`，而补丁层必须以 TS `strict` 消费上游内部模块 | 把补丁层降级为 JS（放弃 strict 与类型即文档）；或整仓 fork 并手写声明（成本更高） | 上游若发布逐模块类型声明，MUST 删除该文件并改为直接引用 |

## 实现前的验证门（Risk Gates）

每个门都有**明确的失败动作**；未通过不得进入依赖它的实现阶段（详见 [research.md](./research.md) §11）。

| 门 | 内容 | 通过判据 | 失败动作 |
|---|---|---|---|
| **G-1 接缝可替换性**（H-1） | 别名插件能在真实构建链中替换 `Renderer/Context.js`，且 `Scene` 的相对导入被正确改写 | 冒烟：构造 `Scene`，断言其 `_context` 由我们的实现提供；白名单穷举测试通过 | 切换到整仓 fork（F1），补丁清单与审计方式不变 |
| **G-2 设备交接与同步构造**（H-2） | 预取设备后同步构造 `Scene`，能力标志与 `ContextLimits` 在构造期可读且不触发未实现分支 | 两种后端下都能构造场景；记录被触发的分支并断言与 research §4 表一致 | 逐项修正能力表并补测试；若某标志无法诚实回答，降到 false 并登记 |
| **G-3 通道状态机正确性**（H-3） | 派生式通道划分覆盖 `Scene` 的全部目标切换序列（含 `resolveFramebuffers`） | 帧级录制-回放断言：通道数/附件/load-store 与上游 `clear`/`draw` 序列一致 | 在后端层内部引入显式通道提示（不改逻辑层），或在 `endFrame` 前强制拆通道 |
| **G-4 uniform 布局一致性**（H-4） | 生成器产出的布局与 WGSL 结构逐字段一致（含 `mat3`/数组/`vec3` 对齐） | 单元测试 + 像素断言（地形着色器全部 uniform 生效） | 退化为"每标量一个 vec4 槽"的保守布局 |
| **G-5 着色器编译前端**（H-5/H-6） | ①`ShaderSource` 双发射目标保持 GLSL 视图不变；②WGSL 发射器产出可编译 WGSL；③变体级缓存与 varying 成对推导正确 | 尖刺的真机 harness（`createRenderPipeline` + 回读断言）对**地形全部可达 define 组合**通过；逻辑层对 `vertexShaderSource` 的读取行为不变（正则探测断言） | 按尖刺退路三（WGSL 库与 `.glsl` 并存）降级实现，并把可升级性损失写入 rebase 演练 |
| **G-6 变体规模与像素一致性**（H-6/H-7） | 运行时变体数量与编译耗时在预算内；精度差异与纹理 Y 翻转不引入未声明差异 | 运行时 `ShaderProgram` 实例数与编译耗时直方图落盘；与 WebGL2 基线像素 diff + 高程数值比对；四角纹素回读断言 | 收敛 MVP define 子集；差异按其来源在契约中显式声明（禁止放宽成"任意差异通过"） |
| **G-7 CI 两路径可运行性**（H-8/H-9） | 无 GPU 环境下两条路径各自独立跑通视觉与基准，单次提交到结论 ≤20 分钟；WGSL 在 CI 的校验盲区被显式记录 | CI 实跑两次结论一致；耗时达标；`docs/ci-degradation.md` 含"naga WGSL 校验 ≠ WebGPU 管线校验"的盲区条目与本机复现步骤 | 缩减采样帧数与用例分片；增加本机/自托管真机冒烟作业；绝对性能移交受门控作业 |

## Phase 0 / Phase 1 产物与下一步

**Phase 0（research）完成**：[research.md](./research.md) —— 决策 D1–D10、上游证据（`文件:行`）、
待验证假设 H-1~H-10、被否决方案清单、结论摘要；Technical Context 中**无 `NEEDS CLARIFICATION` 残留**。

**Phase 1（design & contracts）完成**：
[data-model.md](./data-model.md)（后端替换语义的实体与状态机）、
[contracts/render-path-api.md](./contracts/render-path-api.md)（上层 API 与二选一/整体回退）、
[contracts/fork-patch-layer.md](./contracts/fork-patch-layer.md)（补丁层形态、替换清单、审计、升级演练、许可证）、
[contracts/terrain-source.md](./contracts/terrain-source.md)（`CustomHeightmapTerrainProvider` 适配 + 固定数据集 + 署名）、
[contracts/verification-and-benchmark.md](./contracts/verification-and-benchmark.md)（双路径独立运行、容差、差异证据、基准与门禁）、
[quickstart.md](./quickstart.md)（可运行验证指南）、
[mvp-estimate.md](./mvp-estimate.md) + [mvp-estimate.v1.json](./mvp-estimate.v1.json)。

**下一步（阶段 3 及以后）**：

1. **⚠️ `tasks.md` 与 `analysis.md` 已失效**：二者基于被否决的"双画布分层"架构（其任务包含自建瓦片几何、
   双画布合成、隐藏上游绘制等），MUST 由 `/speckit-tasks` 依据本版 plan 与 contracts **整体重新生成**，
   再走 `/speckit-analyze`；**不得**在被否决的任务清单上做增量修补。
2. 实现顺序按 G-1 → G-2 → G-4 → G-3 → G-5 → G-6 的门禁推进（G-7 与验证资产并行）；
   切片 B 的 `depthTexture=true` 翻转是阻断项，未完成不得宣告 FR-030 达成。
3. **着色器尖刺已定案**（`experiments/shader-spike/REPORT.md`）：本版 plan/research/estimate 已按其结论更新
   （WGSL 发射器路线、W4 独立工作流 5–10 工作日、条件场景 S-V）。实施时 MUST 复用尖刺的真机 harness
   与 `port/globe-vs.wgsl`、`port/globe-fs.wgsl` 作为黄金样本；上游叶子转换的工具链版本
   （`glslang 16.6.0`、`naga-cli 30.0.1`、`@webgpu/glslang 0.0.15` 的 `web-devel-onefile` 构建）MUST 锁定。
