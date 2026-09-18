---

description: "Task list for WebGPU Terrain MVP — 渲染后端替换（CesiumJS 1.145.0 受控 fork / 补丁层）"
---

# Tasks: WebGPU 渲染后端替换（受控 fork 补丁层）— MVP 地形端到端

**Feature**: `001-webgpu-terrain-mvp` | **Created**: 2026-09-19 | **Status**: 阶段 3 产物（整体重新生成）
**Input**: Design documents from `/specs/001-webgpu-terrain-mvp/`
**Prerequisites**: [plan.md](./plan.md)（**v2 渲染后端替换版**，必需）、[spec.md](./spec.md)（FR-001~FR-033 / SC-001~SC-010）、
[research.md](./research.md)（D1–D10 / H-1…H-10 / §12 被否决方案）、[data-model.md](./data-model.md)（§1–§11，含 A1–A11 边界断言）、
[contracts/](./contracts/)（fork-patch-layer、render-path-api、terrain-source、verification-and-benchmark、mvp-estimate.schema.json）、
[quickstart.md](./quickstart.md)、[mvp-estimate.md](./mvp-estimate.md) + [mvp-estimate.v1.json](./mvp-estimate.v1.json)、
[experiments/shader-spike/REPORT.md](../../experiments/shader-spike/REPORT.md)（着色器路线实测依据 + §7.4 风险表）
**Constitution**: `.specify/memory/constitution.md` **v2.0.0**（原则 I 受控 fork、原则 II 二选一不同时运行，均 NON-NEGOTIABLE）

> ⚠️ **整体重新生成声明**：上一版 `tasks.md` 与 `analysis.md` 建立在**已被用户否决**的"双画布分层 + 隐藏上游绘制"架构上
> （含自建瓦片几何、双画布合成、隐藏上游 canvas 等任务），**已整体失效**。本清单依据本版 plan / research / data-model / contracts
> **从零重写**，**MUST NOT** 在其之上做增量修补；`analysis.md` 不在本阶段修补，由后续 `/speckit-analyze` 重新生成。

**Tests**: **必需（非可选）**。constitution v2.0.0 原则 III（可验证渲染）与 FR-010/FR-011/SC-009 把自动化验证变成交付物：
本清单中**每一项渲染特性都与其自动化验证任务成对出现**（实现任务 + 紧邻的验证任务），
验证任务 MUST 指明所在**层**（`层=单元` / `层=契约` / `层=视觉` / `层=基准` / `层=架构边界`）；
**仅有肉眼确认的任务在本清单中不存在**。

**Organization**: 按 plan 的依赖序组织：
`Setup → 实现前的验证门（G-1 → G-2 → G-4 → G-3 → G-5 → G-6，G-7 并行）→ Foundational(W1) → [US1] W2 → [US1] W3 → [US1] W4 → [US1] W5 → [US2] W6 → [US3] W7 → [US4] W8 → [US5] W9 → Polish`。
工作流编号（W1–W9）与 [mvp-estimate.md](./mvp-estimate.md) §2 的工作流拆分一一对应。

## Format: `[ID] [P?] [Story] Description`

- **[P]**：可并行（不同文件、无未完成依赖）；并行前提在任务内注明。
- **[Story]**：该任务服务的 user story（US1…US5）；Setup / 门禁 / Foundational / Polish 阶段无 story 标签。
- 每个任务 MUST 给出：**明确产出文件路径** + **可执行自检命令** + **完成判据**（`自检`）+ **需求追溯**（`→`）。

## 全局约定（所有任务默认生效，正文不再重复）

1. **自检一律为 Node 跨平台命令**：`node --test tests/**/*.test.mjs`、`node tools/scripts/check-*.mjs`、`node tools/*.mjs`、
   `npx playwright test`。脚本 MUST NOT 依赖 `pwsh` / PowerShell 专有语法 / `grep` / shell 管道 / 本机绝对路径
   （CI 目标为 Linux + bash）；本机虽有 pwsh 7.6.6 与 Windows PowerShell 5.1，但**其存在不得成为任何自检的前提**。
2. **二选一语义（原则 II）贯穿所有验证任务**：任何验证 MUST 是**两次独立运行**（独立进程 + 独立页面加载，
   `RENDER_BACKEND=webgpu|webgl2`，每次只启用一条后端），跨后端比较**只能"分别采集 + 离线比较"**；
   **MUST NOT** 出现任何"同帧对比 / 两条后端叠加 / 逐帧合成 / 遮挡 / 同会话双路径"的用例或脚手架。
   本清单中以 `〖二选一〗` 标注该约束适用于该任务。
3. **补丁边界（原则 I）**：一切对上游的改动 MUST 落在 `Source/Renderer/**`；替换清单一律经
   `packages/cesium-webgpu/backend-webgpu/manifest.json` 登记（`requirementRef` + `reason` + `kind` + `glCallSites`），
   由 `node tools/audit-patch-scope.mjs` 机器审计。`Scene` / `Globe` / `QuadtreePrimitive` / `Camera` / 图层 / `DrawCommand`
   的代码与语义**一行不改**（SC-010）。
4. **环境事实（写入任务备注，避免踩坑）**：本机 Node **v22.20.0** / npm **10.9.3**；npm 直连通常可用，
   失败时用代理 `http://127.0.0.1:7890`（仅记入 `.env.example`，**不得**写入公开 README）；
   无头 Chrome **153** 零启动开关即可取得硬件 WebGPU 适配器（`vendor:"nvidia"`, `architecture:"lovelace"`）→ 真机验证的算力成本为 0；
   CI 工具链 = `glslang 16.6.0` **官方 Linux 预编译包** + `cargo install naga-cli --locked`
   （**naga 无预编译二进制**，MUST NOT 写"下载 naga 二进制"式步骤；缓存 `~/.cargo`）；
   `@webgpu/glslang 0.0.15` 若使用 MUST 显式引 `dist/web-devel-onefile`（默认 Node 入口实测挂死 >120 s）。
5. **CI 盲区（FR-023，MUST 显式记录）**：CI 无 GPU 时 WGSL **只能做 naga 模块级校验**（不覆盖 WebGPU 管线校验：
   varying 契约、绑定布局、格式兼容只在真机 `createRenderPipeline` 暴露）→ 管线级校验 MUST 靠本机真机 harness，
   盲区与本机复现步骤 MUST 写入 `docs/ci-degradation.md`。
6. **门禁语义**：Phase 2 的门禁未通过时 **STOP**，**MUST NOT** 开始任何实现任务；失败时
   **上报入口 Agent 请求修订 `plan.md`**（阶段子代理 MUST NOT 自行改 `plan.md` / `contracts/**` / `spec.md`）。
7. **Out of Scope（MUST NOT 出现在任何任务中）**：影像 / 模型 / 三维瓦片 / 大气与光照特效 / 阴影 / 后处理 / 粒子 /
   矢量与标注 / 移动端与低端设备适配 / 生产级流式调度 / 凭据类地形服务 / 通用计算加速 / 上游不存在的渲染特性 / 正式发版节奏。
   这些既有功能**随渲染后端替换自然接入**，但其**验收属后续增量**；MVP 中触达它们的代码路径 MUST 抛
   `category:"not-implemented"` 的可诊断错误（MUST NOT 静默失败）。
8. **提交纪律**：本清单不授权 `git commit` / `git push`；提交与合入由入口 Agent 决策。

## Path Conventions

- 主交付包：`packages/cesium-webgpu/src/**`（`index.ts`、`api/`、`render-path/`、`terrain/`、`verify/`、`status/`）
- **补丁层（唯一允许的上游改动面）**：`packages/cesium-webgpu/backend-webgpu/{manifest.json,Renderer/**,webgpu/**}`
- 固定数据集：`packages/cesium-webgpu/fixtures/<datasetId>/**`；上游类型声明：`packages/cesium-webgpu/types/engine-internal.d.ts`
- 基线元数据：`upstream/engine-26.3.0.lock.json`、`upstream/interface-manifest.json`
- 演示页：`apps/demo/**`；工具：`tools/**`；测试：`tests/{unit,contract,visual,benchmark,support}/**`
- CI：`.github/workflows/ci.yml`；文档：`docs/**`；产物：`artifacts/**`；参考帧：`reference-frames/<datasetId>/<caseId>.<backend>.png`
- **门禁实验**：`experiments/gates/**`（**不进入** `packages/**`，不参与 Rollup 主包构建）

---

## Phase 1: Setup（工程骨架与工具链；不含任何渲染实现）

**Purpose**: 建立可构建、可测试、可复现的多包骨架、构建链与**共享验证脚手架**。
**Goal**: `npm run build` + `node --test tests/unit` 在本机（Node 22）通过，且补丁边界/可移植性/公开 API 面均有可执行断言。
**Independent Test**: `node tools/scripts/run.mjs build` 与 `node --test tests/unit` 全绿；
`node tools/scripts/check-tools-portable.mjs` 以 0 退出。

- [ ] T001 创建 npm workspaces 根骨架与忽略规则：`package.json`（`private:true`、`workspaces:["packages/*","apps/*"]`、`engines.node>=22`、`type:"module"`、scripts 占位）与 `.gitignore`（`node_modules/`、`dist/`、`artifacts/`、`experiments/gates/out/`、`.specify/feature.json`）。`自检`：`node --test tests/unit/repo-layout.test.mjs`（断言 workspaces/engines/type 字段与忽略项齐备）。`→ plan「Project Structure」`
- [ ] T002 [P] 建立 TypeScript `strict` 基线：`tsconfig.base.json`（`strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、target/module 适配 Node 22 + ESM）与 `packages/cesium-webgpu/tsconfig.json`、`apps/demo/tsconfig.json` 两份继承配置。`自检`：`node --test tests/unit/tsconfig-baseline.test.mjs`（**不依赖已安装 tsc**，直接读取 JSON 断言三个严格开关与 `extends` 指向）。`→ constitution 附加技术约束（TS strict）`
- [ ] T003 上游钉版与基线记录：`packages/cesium-webgpu/package.json` 声明 `@cesium/engine` **精确 `26.3.0`**（MUST NOT 用 `^`/`~`）与 `upstream/engine-26.3.0.lock.json`（`packageName`/`version`/`cesiumVersion:"1.145.0"`/`integrity`/`license:"Apache-2.0"`/`recordedAt`/`notes` + **`toolchain` 段**：`glslang 16.6.0`、`naga-cli 30.0.1`、`@webgpu/glslang 0.0.15（dist/web-devel-onefile）`）。`自检`：`npm ci` 成功后 `node --test tests/unit/upstream-baseline.test.mjs`（断言安装版本 === 26.3.0、integrity 与 lock 一致、无版本范围符、toolchain 三版本齐备）。`→ FR-032, data-model §1.1, contracts/fork-patch-layer §1`
- [ ] T004 安装并锁定构建/测试依赖：根 `devDependencies` 精确版本（`rollup`、`@rollup/plugin-typescript`、`@rollup/plugin-node-resolve`、`rollup-plugin-dts`、`typescript`、`@webgpu/types`、`playwright`）并生成 `package-lock.json`。`自检`（**不标 [P]**：与 T003 共享 npm install）：`node --test tests/unit/deps-locked.test.mjs`（断言全部 devDependencies 无 `^`/`~`、`playwright` 版本为精确固定值、lock 中 `@cesium/engine` 解析为 26.3.0）。`→ FR-024, contracts/verification-and-benchmark §3`
- [ ] T005 [P] 自维护上游内部模块类型声明 `packages/cesium-webgpu/types/engine-internal.d.ts`：只声明本项目真正消费的上游内部符号（`Renderer/Context` 的**约 30 个成员**、资源类工厂/构造面约 20 个、`ContextLimits` 10 个成员、`RenderState` 选项形状、`ShaderProgram` 读取面**含 `_attributeLocations`**）。`自检`：`node --test tests/unit/engine-internal-types.test.mjs`（对 research §1.3 的消费面清单逐项断言"声明存在"，缺失即失败）；`npx tsc -p packages/cesium-webgpu/tsconfig.json --noEmit`。`→ research §2.5, plan Complexity Tracking`
- [ ] T006 [P] 实现架构边界扫描器 `tools/scripts/check-arch-boundaries.mjs`（零依赖，实现 data-model §11 的 **A1–A11** 规则；支持 `--rules A1,A7`；输出 `artifacts/arch-boundaries.json`；**无命中时以 0 退出并打印 `no match`**，命中以 1 退出；扫描路径不存在 MUST 以非 0 退出）。`自检`：`node --test tests/unit/check-arch-boundaries.test.mjs`（正例/反例/"路径不存在"三类用例）。`→ SC-010, data-model §11, FR-007`
- [ ] T007 [P] 工具可移植性检查 `tools/scripts/check-tools-portable.mjs`：扫描 `tools/**`、`.github/**`、`package.json` 的 scripts，断言不出现 `pwsh`/`powershell`/`2>$null`/`Get-ChildItem`/`grep -` 等专有语法与 Windows 绝对路径（`[A-Za-z]:\\`）。`自检`：`node --test tests/unit/check-tools-portable.test.mjs`；`node tools/scripts/check-tools-portable.mjs` 以 0 退出。`→ 全局约定 1（CI 目标 Linux + bash）`
- [ ] T008 实现别名插件 `tools/rollup-plugin-engine-patch.mjs`：在 `resolveId` 中按**解析后的绝对路径**把 `<node_modules>/@cesium/engine/Source/Renderer/<X>.js` 改写为 `backend-webgpu/Renderer/<X>.…`（当且仅当 `<X>.js` 在清单内），并导出**白名单穷举**模式 `whitelistExhaustiveCheck(sourceFiles)`。`自检`：`node --test tests/unit/rollup-plugin-engine-patch.test.mjs`（覆盖"清单为空 → 零改写""被改写集合 == 清单集合（无遗漏、无额外）""对 `index.js` 再导出与包内相对导入同样生效"）。`→ contracts/fork-patch-layer §3, H-1`
- [ ] T009 建立 Rollup 多入口构建 `rollup.config.mjs` 与包 `exports`：入口 `packages/cesium-webgpu/src/index.ts`、可选 `packages/cesium-webgpu/src/escape-hatch.ts`（**MUST NOT** 被主入口 re-export）、`apps/demo`；产出 ESM + `.d.ts`（`rollup-plugin-dts`）。`自检`（依赖 T002/T008）：`node tools/scripts/run.mjs build` 成功；`node tools/scripts/check-arch-boundaries.mjs --rules A1` 以 0 退出（`dist/index.d.ts` 不含 `GPU[A-Z]`/`WebGL`/`backend-webgpu`）。`→ contracts/render-path-api §1, 原则 II`
- [ ] T010 统一脚本编排与静态服务：`tools/scripts/run.mjs`（统一入口）+ 根 `package.json` scripts（`build`/`typecheck`/`lint`/`test:unit`/`test:contract`/`test:visual`/`bench`/`demo`/`ci:local`）+ `tools/scripts/serve.mjs`（零依赖静态服务，供演示与 Playwright 使用）+ `.env.example`（代理等本机配置）。`自检`（**不标 [P]**：与 T001/T009 共享 `package.json`，串行）：`node --test tests/unit/scripts-map.test.mjs`；`node tools/scripts/run.mjs test:unit` 在无测试时打印 `no tests yet` 且以 0 退出。`→ quickstart §2/§3, 全局约定 1`
- [ ] T011 [P] 演示页骨架 `apps/demo/index.html` + `apps/demo/src/main.ts`：**只 import 包入口**，含状态区/署名区/进度区容器与"模拟设备丢失"入口占位。`自检`：`node --test tests/unit/demo-no-branch.test.mjs`（A5：演示页源码 MUST NOT 出现 `preference ===` / `=== "webgpu"` / `=== "webgl2"`）。`→ FR-007, contracts/render-path-api §5 C-5`
- [ ] T012 [P] 包入口与公开类型骨架：`packages/cesium-webgpu/src/index.ts` + `packages/cesium-webgpu/src/api/types.ts`（`BackendKind`、`TerrainSceneOptions`、`TerrainSceneHandle`、`RenderPathStatus`、`DiagnosticError`，逐字段对齐 [contracts/render-path-api.md](./contracts/render-path-api.md) §1 与 data-model §2.2/§2.5）。`自检`：`node --test tests/unit/public-api-surface.test.mjs`（断言导出面恰好为契约所列符号，**不含任何后端/GPU 类型**）。`→ FR-007, data-model §11 A1`
- [ ] T013 [P] 共享验证脚手架（最小版）：`tests/support/backend-runner.mjs`（**独立进程 + 独立页面加载**，`--backend=webgpu|webgl2`；API 表面**不存在**任何"同会话双路径/同帧对比/叠加"入口）与 `packages/cesium-webgpu/src/verify/stats.mjs`（`FrameStatistics` 计算：`nonBackgroundRatio`/`uniqueColorCount`/`depthDiscontinuityRatio`/`triangleCount`/`drawCallCount`/`tileCount`/`frameTimeMs{p50,p95}`）。`自检`：`node --test tests/unit/backend-runner-surface.test.mjs`（断言不存在同帧对比入口；对合成图像的统计值做已知值断言）。`→ FR-011, 原则 II, contracts/verification-and-benchmark §2`

**Checkpoint（Setup）**：`node tools/scripts/run.mjs build`、`node --test tests/unit`、`node tools/scripts/check-tools-portable.mjs` 三者全绿。

---

## Phase 2: 实现前的验证门（Risk Gates G-1…G-7）

**Purpose**: 关闭 plan「实现前的验证门」表中的 G-1…G-7（对应 research §11 的 H-1…H-10）。
**Goal**: 每个门禁产出一份**机器可判定的结论**（`experiments/gates/out/<id>.json`）+ 一份人类可读结论（`docs/gate-<id>-conclusion.md`）。
**Independent Test**: `node tools/scripts/check-gate.mjs --all` 断言全部门禁产物存在且 `verdict === "pass"`。

> ⛔ **门禁：未通过则回到 plan 修订**。任何门禁 `verdict !== "pass"` 时：**STOP**，**MUST NOT** 开始 Phase 3 及之后的任何实现任务；
> 由**入口 Agent** 依据该门的"失败动作"修订 `plan.md`（阶段子代理 MUST NOT 自行修改 `plan.md` / `contracts/**` / `spec.md`），
> 修订后再重新派发受影响的门禁与实现任务。
>
> ℹ️ **排布依据**：plan 的实现顺序为 `G-1 → G-2 → G-4 → G-3 → G-5 → G-6`（G-7 与验证资产并行）；
> 因此本阶段的门禁任务按此序排列，并**全部排在 Phase 3 起的实现任务之前**。
> **G-7 是唯一例外**：plan 明示"G-7 与验证资产并行"，其判定依赖 Phase 9/10 的验证资产与 CI 配方，
> 故 G-7 的任务（T028–T029）须与 Phase 9/10 的验证资产与 CI 配方（T108–T126）并行推进，
> 但结论 **MUST 在切片 B 的 `depthTexture=true` 翻转（T098）之前落盘**；T127 是 G-7 结论的正式消费点。
>
> ℹ️ **门禁原型代码一律放 `experiments/gates/**`**，**MUST NOT** 进入 `packages/**`、不参与 Rollup 主包构建；
> 门禁只回答"假设是否成立"，其结论是 Phase 3+ 实现任务的输入。

- [ ] T014 建立门禁产物规范与判定器：`tools/scripts/check-gate.mjs`（校验 `experiments/gates/out/<G-id>.json` 存在且含 `verdict`/`evidence`/`recordedAt`/`notes`，支持 `--all` 与 `--gate g5`）+ `experiments/gates/README.md`（门禁产物字段规范与"结论不得只写结论、必须附证据路径"的要求）。`自检`：`node --test tests/unit/check-gate.test.mjs`（缺文件/缺字段/verdict=fail 三类反例必须非 0 退出）。`→ plan「实现前的验证门」, 原则 V`

### G-1 接缝可替换性（H-1）

- [ ] T015 G-1 门禁执行：在 `experiments/gates/g1-alias/` 内用 T008 的别名插件在**真实构建链**中替换 `Renderer/Context.js`（桩实现），由 Playwright 打开页面构造上游 `Scene`，断言 (a) `scene._context` 由本仓库实现提供、(b) `Scene.js` 对 `Context.js` 的**相对导入**被正确改写、(c) 白名单穷举测试通过；产出 `experiments/gates/out/g1.json` 与 `docs/gate-g1-conclusion.md`（含依据、证据路径、pass/fail）。`自检`：`node experiments/gates/g1-alias/run.mjs` 以 0 退出并写出 `g1.json`；`node tools/scripts/check-gate.mjs --gate g1` 以 0 退出。`→ H-1, FR-032, contracts/fork-patch-layer §3` **（失败动作：切换整仓 fork F1，补丁清单与审计方式不变 → STOP 上报入口 Agent 修订 plan）**

### G-2 设备交接与同步构造（H-2）

- [ ] T016 G-2 门禁执行：在 `experiments/gates/g2-handoff/` 内实现"预取 `adapter/device` → 写入后端层交接槽 → **同步**构造上游 `Scene`（桩 Context 从槽中取设备）"，断言 (a) 两种后端下都能构造场景、(b) `ContextLimits` 与能力标志在 `Scene` **构造期同步可读**、(c) 记录被触发的逻辑层分支并与 research §4 表逐项一致（不一致即 fail）；产出 `experiments/gates/out/g2.json`（含被触发分支清单）与 `docs/gate-g2-conclusion.md`。`自检`：`node experiments/gates/g2-handoff/run.mjs` 以 0 退出；`node tools/scripts/check-gate.mjs --gate g2` 以 0 退出。`→ H-2, research §3/§4, FR-005` **（失败动作：按 research §4 逐项修正能力表并补测试；某标志无法诚实回答则降为 `false` 并登记 → STOP 上报入口 Agent 修订 plan）**
- [ ] T017 G-2 能力映射一致性验证（`层=单元`）：`tests/unit/capability-mapping.test.mjs` —— 对 research §4 的每个能力标志与 `ContextLimits` 成员断言"采用值来源"（如 `maximumTextureSize ← adapter.limits.maxTextureDimension2D`）、`maximumSamples >= 4`、**任何 `false` 能力 MUST 有对应的"未实现"分支与 `notes` 记录**（MUST NOT 虚报 `true`）。`自检`：`node --test tests/unit/capability-mapping.test.mjs` 全绿。`→ H-2, data-model §3.1/§3.2, FR-030` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**

### G-4 uniform 布局一致性（H-4）

- [ ] T018 G-4 门禁执行（生成器原型）：`experiments/gates/g4-uniform-layout/` 内从"**拼装后的真实 GLSL** 实际引用的 uniform 名集合"生成 WGSL `struct` 与 CPU 侧布局表（含 `mat3` 列填充、数组元素 16 字节对齐、`vec3`→16 字节对齐、`size 9` 的 `czm_sphericalHarmonicCoefficients`），并对地形着色器全部 uniform（默认配置 **92** 个声明中实际参与者）产出逐字段偏移表；产出 `experiments/gates/out/g4.json`。`自检`：`node experiments/gates/g4-uniform-layout/run.mjs` 以 0 退出并写出 `g4.json`（含逐字段 `byteOffset`/`byteSize`/`arrayStride`）。`→ H-4, research §5.4, data-model §4.3` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**
- [ ] T019 G-4 门禁验证（`层=单元` + 真机像素断言）：(a) 单元交叉校验"生成布局 ↔ WGSL 结构逐字段一致"；(b) 复用尖刺真机 harness 手法（identity 矩阵 + 已知纹素回读）断言**地形全部 uniform 生效**；产出 `docs/gate-g4-conclusion.md`。`自检`：`node --test experiments/gates/g4-uniform-layout/layout.test.mjs` 全绿 + `node experiments/gates/g4-uniform-layout/run-gpu.mjs` 以 0 退出。`→ H-4, contracts/verification-and-benchmark §4（SH-2 前置）` **（失败动作：退化为"每标量一个 vec4 槽"的保守布局 → STOP 上报入口 Agent 修订 plan）**

### G-3 通道状态机正确性（H-3）

- [ ] T020 G-3 门禁执行（录制）：`experiments/gates/g3-pass-trace/` 内录制上游**原版 WebGL2** 在一次完整帧中的 `clear`/`draw` 与目标切换序列——通过**包装平台 API**（`WebGL2RenderingContext.prototype.bindFramebuffer/drawElements/drawArrays/viewport/scissor` 等）采集，**MUST NOT** 修改上游实现、MUST NOT 依赖 `@private` 语义改写；产出 `experiments/gates/out/g3-trace.json`（序列号、目标 id、viewport、scissor、拓扑、count）。`自检`：`node experiments/gates/g3-pass-trace/run.mjs` 以 0 退出并写出 trace（含 `resolveFramebuffers` 引起的目标切换）。`→ H-3, research §1.5/§5.2` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**
- [ ] T021 G-3 门禁判定（覆盖校验）：把 T020 的录制序列按派生式通道身份 `(colorTargets, depthStencilTarget, sampleCount, viewport, scissorRect)` 分区，断言 (a) **全部目标切换序列都被覆盖**（含多采样解析的目标切换）、(b) 分区边界与 `clear`/`draw` 序列一一对应、(c) `endFrame` 前无未闭合通道；产出 `experiments/gates/out/g3.json` 与 `docs/gate-g3-conclusion.md`。`自检`：`node --test experiments/gates/g3-pass-trace/partition.test.mjs` 全绿；`node tools/scripts/check-gate.mjs --gate g3` 以 0 退出。`→ H-3, data-model §4.1/§10③, FR-030` **（失败动作：在后端层内部引入显式通道提示（不改逻辑层），或在 `endFrame` 前强制拆通道 → STOP 上报入口 Agent 修订 plan）**

### G-5 着色器编译前端（H-5）

- [ ] T022 G-5 门禁执行（真机管线校验 harness 产品化）：把尖刺的 `experiments/shader-spike/scripts/webgpu-harness.mjs` 与黄金样本 `experiments/shader-spike/port/globe-vs.wgsl`(181 行)、`globe-fs.wgsl`(151 行) 产品化为 `tools/shader-verify.mjs`（`--family=globe --variants=mvp`：真机 `createRenderPipeline` + 回读断言；本机无头 Chrome 153 零开关即得硬件适配器）；产物 `artifacts/shader-verify/globe-mvp.json`。`自检`：`node tools/shader-verify.mjs --family=globe --variants=mvp` 以 0 退出（0 validation error、回读非黑像素占满）。`→ H-5, research §6.3, 尖刺 §4` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**
- [ ] T023 G-5 门禁判定（地形全部可达 define 组合）：枚举地形路径**可达的 define 组合**（`TEXTURE_UNITS` × `GlobeSurfaceShaderSet` 的 38 个 boolean 门控 × 场景模式中 MVP 实际可达子集），对每个组合跑真机 `createRenderPipeline`，断言 (a) 0 validation error、(b) **varying 集合 VS/FS 成对匹配**（尖刺 E1 实测：不匹配即硬失败 `fragment input at location N doesn't have a corresponding vertex output`）、(c) 未覆盖组合 MUST 显式失败而非静默降级；产出 `experiments/gates/out/g5.json` 与 `docs/gate-g5-conclusion.md`。`自检`：`node tools/shader-verify.mjs --family=globe --variants=all-reachable --report experiments/gates/out/g5.json` 以 0 退出；`node tools/scripts/check-gate.mjs --gate g5` 以 0 退出。`→ H-5/H-6, contracts/verification-and-benchmark §4（SH-2）` **（失败动作：启用尖刺 §7.5 退路三（WGSL 库与上游 `.glsl` 并存、只做"选哪一份"）并把可升级性损失写入 rebase 演练 → STOP 上报入口 Agent 修订 plan）**
- [ ] T024 G-5 视图不变性门禁（`层=架构边界`）：`node tools/scripts/check-arch-boundaries.mjs --rules A9` —— 断言逻辑层读取的 `shaderProgram.vertexShaderSource`/`fragmentShaderSource` 仍为**原始 GLSL**（`Scene/Primitive.js:849,1011-1020` 的正则探测仍能命中）、`_attributeLocations` 存在且与 `attributeLocations` 一致。`自检`：`node tools/scripts/check-arch-boundaries.mjs --rules A9` 以 0 退出（在尖刺产物上先跑一次作为基线）。`→ H-5, contracts/fork-patch-layer R2, data-model §11 A9` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**

### G-6 变体规模与像素一致性（H-6 / H-7）

- [ ] T025 G-6 门禁执行（H-6 变体规模与编译缓存）：在真机 harness 上统计**运行时 `ShaderProgram` 实例数与编译耗时直方图**，断言落在声明预算内（预算值与依据写入结论）；产出 `experiments/gates/out/g6-variants.json`。`自检`：`node experiments/gates/g6-variants/run.mjs` 以 0 退出并写出直方图；超预算时以非 0 退出。`→ H-6, 尖刺 §7.4（未测项）, mvp-estimate §5 待确认项 1` **（失败动作：收敛 MVP define 子集（只保留地形路径实际可达组合）→ STOP 上报入口 Agent 修订 plan）**
- [ ] T026 G-6 门禁执行（H-7 精度差异与纹理 Y 翻转，`层=视觉`）：**分别采集、离线比较** —— (a) 在 WebGPU 路径采集一帧、(b) 在 WebGL2 路径**另一次独立运行**采集同一固定场景帧，离线做像素 diff（排除抗锯齿边缘）+ 地形高程数值比对；(c) 四角纹素回读断言（WebGPU 纹理原点在上，Y 翻转在 `Texture` 映射层统一处理）；产出 `experiments/gates/out/g6-precision.json` + 差异图。〖二选一〗`自检`：`node experiments/gates/g6-precision/run.mjs --backend=webgpu` 与 `--backend=webgl2` 各跑一次（**不得同时**），再 `node experiments/gates/g6-precision/compare.mjs --offscreen` 以 0 退出。`→ H-7, research §6.3, 尖刺 §4/§7.4` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**
- [ ] T027 G-6 门禁判定与差异声明：产出 `docs/gate-g6-conclusion.md` —— 变体规模/编译耗时结论、精度差异与 Y 翻转的**逐来源差异量与容差依据**；差异 MUST 按其来源写入 `declaredDifferences`（亚像素边缘、MSAA 解析、sRGB、深度表示、WGSL 无精度修饰符、纹理 Y 翻转处理），**MUST NOT** 放宽为"任意差异均通过"（FR-014）。`自检`：`node tools/scripts/check-gate.mjs --gate g6` 以 0 退出；结论文档中不含"任意差异通过"式表述（`node --test tests/unit/tolerance-source.test.mjs`）。`→ H-6/H-7, FR-014, contracts/verification-and-benchmark §3` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**

### G-7 CI 两路径可运行性（H-8 / H-9）— 并行轨道

- [ ] T028 G-7 门禁执行（无 GPU 两套配方实测）：在 Linux + Xvfb 环境实跑两套免费软件适配器配方（WebGPU：Mesa lavapipe + headed Xvfb + 固定标志；WebGL2：ANGLE/SwiftShader），记录每条路径各自的结论与耗时；产出初版 `docs/ci-degradation.md`（含**盲区**：软件光栅化≠GPU、无 GPU 时间戳、lavapipe 报错文本差异、浏览器版本漂移、**"naga WGSL 校验 ≠ WebGPU 管线校验"**，以及**本机真机复现步骤**）。`自检`：`node tools/scripts/check-degradation-doc.mjs`（断言五个盲区条目与本机复现步骤齐备）以 0 退出。`→ H-8, FR-023, contracts/verification-and-benchmark §8` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**
- [ ] T029 G-7 门禁判定（预算与稳定性）：两次实跑同一提交，断言 (a) 两路径各自独立运行的结论**一致**、(b) 从提交到结论 **≤20 分钟**（含构建、单测、审计、着色器校验、两路径契约/视觉/基准 job）；产出 `experiments/gates/out/g7.json` 与 `docs/gate-g7-conclusion.md`。`自检`：`node tools/scripts/check-gate.mjs --gate g7` 以 0 退出。`→ H-9, SC-005, FR-021` **（失败动作：缩减采样帧数与用例分片，增加本机/自托管真机冒烟作业，绝对性能移交受门控作业 → STOP 上报入口 Agent 修订 plan）**

**Checkpoint（门禁）**：`node tools/scripts/check-gate.mjs --all` 以 0 退出（`g1,g2,g3,g4,g5,g6` 于本阶段结束前必须全 `pass`；`g7` 依 plan 与验证资产并行，最迟在 T098 之前落盘）——**此后才允许开始 Phase 3 及之后的实现任务**。

---

## Phase 3: Foundational — W1 后端基线与补丁层工程化（阻塞前置）

**Purpose**: 把"受控 fork 补丁层"从方案变成**可机器审计的工程事实**：替换清单枚举、边界审计、依赖完整性、
接口面清单化、升级演练干跑、许可证与署名合规。
**Goal**: `PatchScopeAudit.verdict === "pass"`、`logicLayerOverrides === 0`、接口清单可生成、升级演练干跑可离线执行。
**Independent Test**: `node tools/audit-patch-scope.mjs && node tools/upgrade-drill.mjs --dry-run && node --test tests/unit` 全部以 0 退出。

**⚠️ CRITICAL**: 本 phase 是 W2–W9 全部 user story 的阻塞前置；未完成不得开始 Phase 4。

- [ ] T030 上游完整性校验：`tools/scripts/verify-upstream-integrity.mjs` —— 安装后断言 `@cesium/engine` 版本 === `26.3.0`、 `integrity` 与 `upstream/engine-26.3.0.lock.json` 一致、`Source/**` 目录内容哈希与记录一致（发现 postinstall 篡改即失败）、 并校验工具链段（`glslang 16.6.0` / `naga-cli 30.0.1` / `@webgpu/glslang 0.0.15` 显式 `dist/web-devel-onefile`）。`自检`：`node tools/scripts/verify-upstream-integrity.mjs` 以 0 退出；`node --test tests/unit/upstream-integrity.test.mjs` 全绿（含"篡改一个字节 → 失败"反例）。`→ FR-032, contracts/fork-patch-layer §4（AU-2）, research §2.4`
- [ ] T031 建立替换清单 `packages/cesium-webgpu/backend-webgpu/manifest.json`：`baseline` 段 + `entries[]` （**16 个必替换**：`Context.js`(46)、`Texture.js`(58)、`ShaderProgram.js`(42)、`Texture3D.js`(37)、`CubeMap.js`(33)、 `CubeMapFace.js`(27)、`RenderState.js`(22)、`Buffer.js`(18)、`createUniform.js`(16)、`createUniformArray.js`(14)、 `VertexArray.js`(10)、`Framebuffer.js`(9)、`Renderbuffer.js`(6)、`TextureAtlas.js`(4)、`MultisampleFramebuffer.js`(3)、`Sync.js`(3) —— 括号内为实测 WebGL 调用点数）+ **约 7 个适配项**（`ShaderCache.js`、`ShaderSource.js` `kind:"adapt-shader"`、 `FramebufferManager.js`、`ComputeEngine.js`、`SharedContext.js`、`TextureCache.js`、`loadCubeMap.js`）， 每项 MUST 有非空 `requirementRef`（`FR-030`/`FR-031`/`FR-032`）与 `reason`，`replace` 类 MUST `glCallSites > 0`。`自检`：`node --test tests/unit/patch-manifest.test.mjs`（断言 `^Renderer/[A-Za-z0-9_]+\.js$`、`requirementRef` 非空、`localFile` 存在、`replace` 类 `glCallSites>0`、16+7 条目齐备）。`→ FR-030/031/032, data-model §1.2, contracts/fork-patch-layer §2`
- [ ] T032 `keptModulesHash` 生成器 `tools/scripts/gen-kept-hash.mjs`：对 `Renderer/**` 中**未列入清单**的 GL-free 模块（31 个）计算内容哈希集合并写回 manifest（发现"上游悄然改动我们仍依赖的文件"）。`自检`：`node --test tests/unit/kept-modules-hash.test.mjs`（断言未列入清单的文件集合与哈希齐备；`ShaderBuilder.js`/`Sampler.js`/`UniformState.js`/`AutomaticUniforms.js`/`DrawCommand.js`/`ClearCommand.js`/`PassState.js`/`Pass.js`/`PixelDatatype.js`/`BufferUsage.js`/`VertexArrayFacade.js` 等必须在"保持不变"集合中）。`→ 原则 I, research §2.2`
- [ ] T033 补丁范围审计 `tools/audit-patch-scope.mjs`：输出 `PatchScopeAudit`（`baselineVersion`/`integrityOk`/`manifestPathsValid`/ `aliasWhitelistExhaustive`/`logicLayerOverrides`/`keptModulesUnchanged`/`verdict`，字段与 data-model §1.3 逐字段一致） 到 `artifacts/patch-scope-audit.json`；任一布尔为 false 或 `logicLayerOverrides > 0` 即 `fail` 并以非 0 退出。`自检`：`node --test tests/unit/audit-patch-scope.test.mjs`（含"清单越出 `Renderer/**` → fail""别名多改/漏改 → fail"两个反例）；`node tools/audit-patch-scope.mjs` 在 T031–T034 完成后以 0 退出。`→ SC-010, FR-032, contracts/fork-patch-layer §4`
- [ ] T034 构建产物审计（逻辑层零覆盖）：把"构建产物中来自本仓库的、`Renderer/**` 之外的模块数 MUST 为 0" 接成构建后钩子（`node tools/scripts/check-build-layer-source.mjs`），断言逻辑层模块来源为 `node_modules/@cesium/engine/Source/**` 原文件。`自检`（**不标 [P]**：依赖 T009 构建配置与 T033 审计）：`node tools/scripts/check-build-layer-source.mjs` 以 0 退出且打印 `logicLayerOverrides: 0`；`node --test tests/unit/build-layer-source.test.mjs` 全绿（含"人为注入一个 `Scene/Scene.js` 覆盖 → 失败"反例）。`→ SC-010, 原则 V, research §2.4`
- [ ] T035 接口一致性清单生成器 `tools/gen-interface-manifest.mjs` → `upstream/interface-manifest.json`： 逐模块输出 `InterfaceEntry = { module, exportedSymbols[], consumedMembers[{name,kind,arity?}], consumedBy[] }` （静态扫描逻辑层消费点；`consumedBy` 为逻辑层文件列表），并提供 `--check` 模式断言与基线无漂移。`自检`：`node --test tests/unit/interface-manifest.test.mjs`（断言 `Context` 成员面 ≥30、`ContextLimits` 10 个成员、`ShaderProgram` 读取面含 `_attributeLocations`）；`node tools/gen-interface-manifest.mjs --check` 以 0 退出。`→ FR-032, data-model §1.4, research §10`
- [ ] T036 升级演练（干跑）`tools/upgrade-drill.mjs --dry-run`：离线用已提交清单校验漂移，产出 `UpgradeDrillRecord`（`mode`/`ranAt`/`diff:InterfaceManifestDiff`/`verification[]`/`verdict`）到 `artifacts/upgrade-drill.json`； `--to=<version> --full` 模式留待升级 PR（本增量只要求干跑常跑）。`自检`：`node --test tests/unit/upgrade-drill.test.mjs`（离线运行、断言 `verdict === "pass"` 需"补丁范围审计 + 接口一致性 + 全量验证"三项齐备；缺一项即 fail）；`node tools/upgrade-drill.mjs --dry-run` 以 0 退出。`→ 原则 I（升级演练）, contracts/fork-patch-layer §6`
- [ ] T037 [P] 补丁层模块骨架与显式失败助手：`packages/cesium-webgpu/backend-webgpu/Renderer/**`（与上游同名的替换模块文件，先以显式失败骨架落地）与 `packages/cesium-webgpu/backend-webgpu/webgpu/**`（`device-handoff`/`pass-encoder`/`pipeline-cache`/`bind-layout`/`shader-emit`/`glsl-preprocess`/`capability`/`wgsl-prelude`/`wgsl`/`errors.ts`）， `errors.ts` 提供 `notImplemented(capability)` → `DiagnosticError{category:"not-implemented"}`。`自检`：`node --test tests/unit/backend-skeleton.test.mjs`（断言每个占位能力**抛可诊断错误**、MUST NOT 静默返回空值/黑屏）。`→ FR-033, contracts/render-path-api §6`
- [ ] T038 [P] 状态与错误模型：`packages/cesium-webgpu/src/status/**`（`RenderPathStatus`、原因类别 `no-navigator-gpu`/`no-adapter`/`device-request-failed`/`missing-feature`/`below-limit`/`timeout`、降级与盲区 `notes`）、 `packages/cesium-webgpu/src/api/errors.ts`（`DiagnosticError{category,message,backend?,cause?}`）与 `src/api/diagnostics.ts`（`onError` 订阅）。`自检`：`node --test tests/unit/status-model.test.mjs`（断言 `degraded === true ⇒ notes` 非空、错误类别枚举与契约一致、错误 MUST NOT 被静默吞掉）。`→ FR-009, FR-023, data-model §2.5`
- [ ] T039 [P] CI 骨架 `.github/workflows/ci.yml`（本阶段只含 `install → build → typecheck → unit → audit(AU-1…AU-5)` 串行门禁； 两路径 contract/visual/bench job 与着色器工具链在 W8 补齐）。`自检`：`node --test tests/unit/ci-workflow.test.mjs`（用 YAML 解析断言门禁顺序、断言尚无"两条路径同 job 并行渲染"的配置）。`→ FR-021/FR-022, contracts/verification-and-benchmark §7`
- [ ] T040 [P] 许可证与署名（Apache-2.0）：`LICENSE`（Apache-2.0，与上游一致）、 `NOTICE`（MUST 声明"本产品包含 CesiumJS Contributors 开发的软件"，写明上游基线与版本，并**逐条列出被重实现的文件**——与 `manifest.json` 一致）、 派生文件版权头规范（保留原始版权头 + "Modified for WebGPU backend" 注记）、`tools/scripts/check-license-notice.mjs`。`自检`：`node --test tests/unit/license-notice.test.mjs`（断言 NOTICE 修改文件清单 == manifest 清单集合、上游 `LICENSE.md` 随交付保留、结论非空）；`node tools/scripts/check-license-notice.mjs` 以 0 退出。`→ FR-024, contracts/fork-patch-layer §7（AU-5）`
- [ ] T041 **W1 Checkpoint**：`node tools/audit-patch-scope.mjs`（`verdict === "pass"`、`logicLayerOverrides === 0`） + `node tools/upgrade-drill.mjs --dry-run` + `node tools/scripts/check-license-notice.mjs` + `node --test tests/unit` 全绿； 并把 `artifacts/patch-scope-audit.json`、`artifacts/upgrade-drill.json` 作为 CI 产物路径登记进 `.github/workflows/ci.yml` 的上传段。`自检`：上述四条命令均以 0 退出。 `→ 原则 I, FR-032, SC-010`

**Checkpoint（Foundational）**：补丁边界、依赖完整性、接口清单、升级演练、许可证五项均有**可执行证据**——此后 user story 可以实现。

---

## Phase 4: User Story 1 - 地形渲染在新渲染路径下端到端跑通（P1）🎯 MVP ｜ W2 WebGPU 后端核心

**Goal**: `Context` 替换模块在**上游 `Scene` 构造期同步接管** WebGPU 设备与能力，命令执行以**派生式通道**完成，
绘制提交与呈现全部发生在 WebGPU 上；设备丢失按整体切换恢复。
**Independent Test**: `node tests/support/backend-runner.mjs --backend=webgpu --suite=contract-backend-core`
（**独立进程 + 独立页面加载**，只启用 WebGPU 一条路径）全绿，且该次运行中 WebGL2 的 GPU 对象创建数为 0。〖二选一〗

- [ ] T042 [US1] 设备交接槽 `packages/cesium-webgpu/backend-webgpu/webgpu/device-handoff.ts`：`install({adapter,device,limits,features})` / `take()` / `peek()` / `clear()`，仅允许**同一进程内、构造上游场景之前**调用一次；未安装时 `take()` 返回 `undefined` （= 走上游原版 WebGL2 链路，不存在中间态）。`自检`：`node --test tests/unit/device-handoff.test.mjs`（断言"未安装 → undefined"、"重复安装 → 报错"、"take 后清空"语义）。`→ FR-005, research §3, G-2`
- [ ] T043 [US1] `Renderer/Context` 替换实现（构造期）：从交接槽取设备 → `configure()` 画布 → `ContextLimits` 合成 → 能力标志发布 → 默认纹理（1×1 RGBA8、`flipY:false`、默认 `Sampler` CLAMP_TO_EDGE）→ `id` 为每上下文稳定唯一 GUID （逻辑层用它做索引缓冲缓存键）。`自检`：`node --test tests/unit/context-construction.test.mjs`（断言构造期**同步可读** `ContextLimits` 与能力标志、`id` 稳定唯一、默认纹理尺寸/格式）；`node tests/support/backend-runner.mjs --backend=webgpu --suite=smoke:scene-construct`。`→ FR-030, research §1.3/§3, data-model §3`
- [ ] T044 [US1] `Context` 命令分派与生命周期：`draw(command, passState, program, uniformMap)`（解析目标 → 通道身份变化则闭合旧通道并开新通道 → `setPipeline`/`setBindGroup`/`setVertexBuffer`/`setIndexBuffer`/`setViewport`/`setScissorRect` → `drawIndexed`/`draw`）、 `clear`（首次操作走 `loadOp:"clear"`，其余 `clearBuffer` 兜底）、`beginFrame`（取交换链纹理 + 新建 encoder + 初始化通道状态机）、 `endFrame`（闭合通道 → `finish()` → `queue.submit()`）、`drawingBufferWidth/Height`、`createViewportQuadCommand`、`destroy`/`isDestroyed`。`自检`（**不标 [P]**：与 T046 共享通道状态机接口）：`node --test tests/unit/context-dispatch.test.mjs`（含"帧末无未闭合通道"断言）；`node tests/support/backend-runner.mjs --backend=webgpu --suite=smoke:draw-dispatch`。`→ FR-030, SC-010, research §1.4/§5.1`
- [ ] T045 [US1] 能力合成 `backend-webgpu/webgpu/capability.ts`（`BackendCapabilities` + `ContextLimitsSnapshot`）： 逐项按 research §4 表取值（`webgl2:true` 语义为"现代渲染能力可用"并**在实现里注释该历史含义**；`msaa:true`； `depthTexture` 切片 A 暂 `false`；`fragmentDepth`/`instancedArrays`/`drawBuffers`/`elementIndexUint`/`stencilBuffer:true`； `textureFilterAnisotropic`/压缩纹理族/`supportsBasis` 一律 `false`）。`层=单元`：`node --test tests/unit/capability-composition.test.mjs` （逐项断言取值来源、任何 `false` 有 `notes`、`sliceBComplete===true ⇒ depthTexture===true` 的一致性检查存在）。`自检`：该测试全绿。`→ FR-030, H-2, data-model §3.1/§11 A8`
- [ ] T046 [US1] 通道状态机 `backend-webgpu/webgpu/pass-encoder.ts`：`RenderPassKey = (colorTargets, depthStencilTarget, sampleCount, viewport, scissorRect)` 派生式；身份变化或 `endFrame` 即闭合；`Pass`/`PassState`/程序/顶点数组/uniform/`RenderState` 的变化**均不构成**通道边界； 多采样解析映射为 `colorAttachments[i].resolveTarget`。`自检`：`node --test tests/unit/pass-encoder.test.mjs`（**录制-回放**： 给定 G-3 的 trace 输入，断言通道数/附件/load-store 与 `clear`/`draw` 序列一致）。`→ FR-030, H-3, research §1.5/§5.2, data-model §4.1/§10③`
- [ ] T047 [US1] 通道序列契约验证（`层=契约`）：`tests/contract/pass-sequence.spec.mjs` —— 在 `RENDER_BACKEND=webgpu` 与 `RENDER_BACKEND=webgl2` **两次独立运行**中各自采集帧级通道序列，与 G-3 结论做**离线比较**（MUST NOT 同会话对比）。〖二选一〗`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:pass-sequence` 与 `--backend=webgl2 --suite=contract:pass-sequence` 各以 0 退出（**串行执行，不得同时**）；`node tests/support/compare-offline.mjs --artifact=artifacts/pass-sequence` 以 0 退出。`→ FR-011, 原则 II, data-model §4.4`
- [ ] T048 [US1] 管线缓存 `backend-webgpu/webgpu/pipeline-cache.ts`：`PipelineCacheKey = (shaderProgramId, renderStateFingerprint, vertexLayoutFingerprint, topology, colorFormats[], depthFormat?, sampleCount)`、 `PipelineRecord{key,pipeline,createdAt,hits,misses}`；`renderStateFingerprint` MUST 覆盖 `RenderState` 全部字段； 未支持组合（`lineWidth !== 1`、`sampleCoverage.enabled === true`）MUST 抛可诊断错误而非静默忽略。`自检`：`node --test tests/unit/pipeline-cache.test.mjs`（命中/未命中计数、指纹覆盖度反例、未支持组合报错）。`→ research §5.3, data-model §4.2`
- [ ] T049 [US1] `RenderState` 替换与映射表 `backend-webgpu/Renderer/RenderState.ts`：**选项形状 MUST 保持不变**（50+ 逻辑层文件按同一形状构造）， 实现 `fromCache`/`partialApply`（改为管线状态 diff）/`apply`；覆盖 `cull`/`frontFace`/`depthTest`/`depthMask`/`depthRange`（非默认值 MUST 断言为 (0,1) 并记录差异）/ `blending`（GL 常量 → `GPUBlendFactor` 逐项映射表）/`colorMask`/`stencilTest`（`reference` 走 `setStencilReference`）/`stencilMask`/`scissorTest`/`viewport`/`polygonOffset`/`lineWidth`。`层=单元`：`node --test tests/unit/render-state-mapping.test.mjs` （逐字段映射断言 + "未支持项必须报错"反例）。`自检`：该测试全绿。`→ FR-030, research §5.3, data-model §4.2`
- [ ] T050 [US1] 交换链与画布呈现 + 4× MSAA 解析：`configure()` 与 `getCurrentTexture()` 的帧序、`sampleCount:4` 附件 + `resolveTarget`、 画布尺寸/像素比变化时的重建。`自检`：`node --test tests/unit/swapchain-msaa.test.mjs`（descriptor 断言：`sampleCount` 与 `resolveTarget` 成对出现、尺寸跟随 `devicePixelRatio`）；`node tests/support/backend-runner.mjs --backend=webgpu --suite=smoke:present`。`→ FR-001, research §5.1, data-model §4.1`
- [ ] T051 [US1] 设备丢失**整体切换**：订阅 `device.lost` → 停止提交 → **销毁** WebGPU 后端与上游场景 → 重新探测 → 按 §2 重建 （成功仍用 WebGPU，失败整体切 WebGL2）；产出 `WholeSwitchRecord{trigger,from,to,destroyedResources,rebuildMs,residualDraws}`， `destroyedResources > 0`、`residualDraws === 0`；**MUST NOT** 保留旧设备资源或绘制结果作为叠加层。`层=单元` + `层=契约`；`自检`：`node --test tests/unit/whole-switch.test.mjs` 全绿；`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:device-lost` 以 0 退出（独立进程）。〖二选一〗`→ FR-003, FR-006, data-model §2.4/§10④`
- [ ] T052 [US1] 错误采集与可诊断失败：用 `device.pushErrorScope`/`onuncapturederror` 在开发与测试模式下采集校验错误， 并在**帧末**抛出可诊断错误（保持上游"着色器编译失败即抛异常"的可观察语义，MUST NOT 静默丢失）。`自检`：`node --test tests/unit/error-scope.test.mjs`（人为写入非法 WGSL → 必须在帧末抛出且 `category` 可诊断）。`→ research §6.2, contracts/render-path-api §6`
- [ ] T053 [US1] 切片 C 桩与显式失败（`Context` 面）：`readPixels`/`readPixelsToPBO`/`Sync`/`CubeMap`/`Texture3D`/`TextureAtlas`/ `ComputeEngine` 执行/`ShaderBuilder` WGSL 变体 → 一律 `category:"not-implemented"`（禁止空结果或黑屏）； `SharedContext` 在 WebGPU 路径下若被使用 MUST 显式报错。`自检`（**不标 [P]**：与 T044 同文件）：`node --test tests/unit/not-implemented-surface.test.mjs`（逐个断言抛错类别与文案）。`→ FR-033, research §6.1/§7, contracts/render-path-api §6`
- [ ] T054 [US1] **W2 Checkpoint**：`node --test tests/unit` 全绿； `node tools/scripts/check-arch-boundaries.mjs --rules A1,A2,A6,A7` 以 0 退出（A7：同一 `VerificationRun` 只允许一个 `backend`， 同会话双路径用例 MUST 被判失败）；`node tools/audit-patch-scope.mjs` 仍为 `pass`（新增文件未越界）。`自检`：上述三条命令均以 0 退出。 `→ FR-030, 原则 II, SC-010`

**Checkpoint（US1 / W2）**：WebGPU 后端可在上游场景构造期接管并完成命令提交与呈现（尚未有地形内容）；补丁边界未被破坏。

---

## Phase 5: User Story 1（续）｜ W3 资源层

**Goal**: 把上游资源类（`Buffer`/`Texture`/`Sampler`/`VertexArray`/`Framebuffer`/`Renderbuffer`/`MultisampleFramebuffer`/
`FramebufferManager`）重实现为 WebGPU 资源，保持逻辑层可观察语义（工厂、构造选项、`copyFrom` 重载、`destroy`）不变。
**Independent Test**: `node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:resources`（独立进程）全绿，
且同一套用例在 `--backend=webgl2` 的**另一次独立运行**中同样全绿（离线比较，MUST NOT 同会话）。〖二选一〗

- [ ] T055 [US1] `Renderer/Buffer` 替换：三种工厂（`createPixelBuffer`/`createVertexBuffer`/`createIndexBuffer`）、 `usage` 映射（顶点/索引/pixel → `GPUBufferUsage` 组合）、`copyFrom` → `queue.writeBuffer`、`sizeInBytes`、`destroy`/`isDestroyed`。`层=单元`：`node --test tests/unit/buffer-mapping.test.mjs`（usage 组合与工厂语义断言）。`自检`：该测试全绿。`→ FR-030, research §6.1`
- [ ] T056 [US1] `Renderer/Texture` 替换：构造（`width`/`height`/`pixelFormat`/`pixelDatatype`/`sampler`/`source`）、 `source` 类型集合（`ImageData`/`HTMLImageElement`/`HTMLCanvasElement`/`Video`/`OffscreenCanvas`/`ImageBitmap`）、 `copyFrom` 重载（含 region 与 mipmap）、`flipY`、`preMultiplyAlpha`、`destroy`。`层=单元`：`node --test tests/unit/texture-mapping.test.mjs`。`自检`：该测试全绿。`→ FR-030, research §6.1`
- [ ] T057 [US1] 格式与类型映射表 `backend-webgpu/webgpu/format-map.ts`：`PixelFormat`/`PixelDatatype` → `GPUTextureFormat` （含 sRGB 目标、`LUMINANCE`/`RED`/`ALPHA` 的等价处理、depth/stencil 格式、`RenderbufferFormat` 映射）； 未支持格式 MUST 抛可诊断错误。`层=单元`：`node --test tests/unit/format-map.test.mjs`（枚举全覆盖断言 + 未支持项报错）。`自检`：该测试全绿。`→ FR-030, research §6.1, data-model §5.2`
- [ ] T058 [US1] 纹理 Y 翻转与上传语义固化（`层=视觉`）：在 `Texture` 映射层统一处理原点差异（WebGPU 纹理原点在上、GL 在下）， 并用**四角纹素回读断言**固化（尖刺实测手法：四角取到 2×2 纹理的四个纹素色）。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=visual:texture-origin` 以 0 退出（独立进程；四角断言全中）。〖二选一〗`→ H-7, research §6.3, 尖刺 §4`
- [ ] T059 [US1] `Sampler` 语义保持与映射：`Sampler.js` 为 GL-free **保留文件**（MUST 字节不变，由 `keptModulesHash` 断言）， 后端侧提供 `Wrap`/`Filter` 全枚举 → `GPUSamplerDescriptor` 映射表；不支持的项（各向异性）显式记录。`层=单元`：`node --test tests/unit/sampler-mapping.test.mjs`。`自检`：该测试全绿；`node tools/scripts/gen-kept-hash.mjs --check` 断言 `Sampler.js` 在保持不变集合中。`→ FR-030, research §6.1`
- [ ] T060 [US1] `Renderer/VertexArray` 替换：`attributes[]` 全字段（`index`/`vertexBuffer`/`componentDatatype`/`componentsPerAttribute`/`normalized`/ `offsetInBytes`/`strideInBytes`/`instanced`/`divisor`）、`indexBuffer`、`numberOfVertices`、`_bind`/`_unBind`、 `instanced/divisor` → `stepMode:"instance"`；VAO 概念不存在（每次 draw 设置）。`层=单元`：`node --test tests/unit/vertex-array-mapping.test.mjs`（含上游地形 `TerrainEncoding` 两种量化模式的布局断言）。`自检`：该测试全绿。`→ FR-030, research §6.1, §1.6`
- [ ] T061 [US1] `Renderer/Framebuffer` / `Renderbuffer` / `MultisampleFramebuffer`：帧缓冲**无对象对应**（降级为附件描述集合， `destroy()` 为空操作但保留 `isDestroyed()` 语义）、`hasDepthAttachment`、深度/模板 `Renderbuffer` → `GPUTexture`、 多采样 `sampleCount:4` + `resolveTarget`、`blitFramebuffers` 语义改为"确保解析已完成"。`层=单元`：`node --test tests/unit/framebuffer-attachments.test.mjs`。`自检`：该测试全绿。`→ FR-030（帧缓冲）, research §6.1, data-model §5.2`
- [ ] T062 [US1] `Renderer/FramebufferManager` 小改（编排保留）：颜色/深度纹理与多采样配对的生命周期、 与新的 `Framebuffer`/`Texture`/`MultisampleFramebuffer` 对接。`层=单元`：`node --test tests/unit/framebuffer-manager.test.mjs`（生命周期与配对断言）。`自检`：该测试全绿。`→ FR-030, research §6.1`
- [ ] T063 [US1] GPU 资源登记 `GpuResourceRecord`（`id`/`kind`/`bytes`/`upstreamClass`/`createdFrame`/`destroyedFrame`）： `destroy()` 后 MUST 从登记表移除；`bytes` 汇总即 FR-017 的图形显存代理指标。`层=单元`：`node --test tests/unit/gpu-resource-registry.test.mjs` （**泄漏断言**：帧 N 与帧 N+K 的活跃资源集合在稳态下不增长）。`自检`：该测试全绿。`→ FR-017, data-model §5.1`
- [ ] T064 [US1] 资源层契约测试（`层=契约`）：`tests/contract/resources.spec.mjs` —— 同一套用例参数化两条路径、 **各自独立进程 + 独立页面加载**，离线比较两路径的资源行为统计（纹理格式支持、MSAA 解析结果、缓冲上传保序）。〖二选一〗`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:resources` 与 `--backend=webgl2 --suite=contract:resources` 串行各以 0 退出。`→ FR-011, FR-008, 原则 II`
- [ ] T065 [US1] **W3 Checkpoint**：`node --test tests/unit` 全绿；`node tools/audit-patch-scope.mjs` 为 `pass`（`keptModulesHash` 中 `Sampler.js`/`PixelDatatype.js`/`BufferUsage.js` 等仍字节不变）；`node tools/shader-verify.mjs --check-leaf-map` 不适用（未进入 W4），改用占位断言 `node tools/scripts/check-gate.mjs --gate g4` 仍为 `pass`。`自检`：`node tools/audit-patch-scope.mjs` 以 0 退出。 `→ FR-030, 原则 I`

**Checkpoint（US1 / W3）**：资源层可用，帧缓冲具备附件化实现与 MSAA 解析能力（切片 A 仍以 `depthTexture=false` 运行）。

---

## Phase 6: User Story 1（续）｜ W4 着色器编译前端（独立工作流，据尖刺定案）

**Goal**: **不转译 GLSL**，在 fork 层把着色器组装层参数化为 **WGSL 发射器**：`ShaderSource` 双发射目标（GLSL 视图不变）+
上游缺失的 GLSL 条件编译求值 + `czm_` WGSL prelude + 地形着色器闭包的 WGSL 库 + 运行时片段镜像 + varying 成对推导 +
变体级管线缓存；**全库 319 个 `.glsl` 叶子的一次性转译明确属本增量之外**（T082）。
**Independent Test**: `node tools/shader-verify.mjs --family=globe --variants=mvp` 真机 0 validation error +
`node --test tests/unit/glsl-preprocess.test.mjs` 全绿 + `node tools/shader-verify.mjs --check-leaf-map` 以 0 退出。

- [ ] T066 [US1] GLSL 条件编译求值 `backend-webgpu/webgpu/glsl-preprocess.ts`：实现 GLSL ES 3.00 的 `#define/#ifdef/#ifndef/#if/#elif/#else/#endif` 求值（`defined()`、`&&`/`||`/`!`/括号、`#elif` 链、**算术条件**如 `#if TEXTURE_UNITS > 0`），并保持上游顺序语义 **"先内联 `czm_`、后条件求值"**；产出 `ConditionalCompilationTrace{variantKey,blocksEvaluated,branchesTaken,warnings}`。`层=单元`（即 **SH-4 门禁**）：`node --test tests/unit/glsl-preprocess.test.mjs` （含 `#elif` 链、算术条件、未激活分支仍参与 `czm_` 依赖收集三组用例）。`自检`：该测试全绿。`→ FR-030, research §6.4, contracts/fork-patch-layer R4`
- [ ] T067 [US1] `ShaderSource` 参数化为双发射目标（`manifest.json` 中 `kind:"adapt-shader"`）：新增 `emit: "glsl" | "wgsl"`， **输入 `sources`+`defines` 与变体机制不变**，**GLSL 视图与预处理语义 MUST 不变**；改动 MUST 限于"增加 WGSL 发射通道 + 导出装配所需内部件"。`层=单元` + `层=架构边界`： `node --test tests/unit/shader-source-dual-emit.test.mjs`（断言 `emit:"glsl"` 输出与上游逐字节一致）；`node tools/scripts/check-arch-boundaries.mjs --rules A9` 以 0 退出（**SH-1 门禁**：逻辑层读到的仍是原始 GLSL、`_attributeLocations` 保留且一致）。`自检`：两条命令均以 0 退出。`→ FR-030/FR-031, H-5, contracts/fork-patch-layer R1/R2`
- [ ] T068 [US1] `czm_` WGSL prelude 库 `backend-webgpu/webgpu/wgsl-prelude/**`：覆盖地形闭包所需**约 40 个** `czm_` 内建 （默认地形一对实测引用 72 个 `czm_` 中的地形子集；含 `czm_octDecode(vec2/float)`、`czm_signNotZero(float/vec2/vec3/vec4)` 等重载 → **MUST 拆名**；`czm_material`/`czm_ray` 等结构体；常量 → 函数或字面量）；每条目录含 `czmName`→`wgslName` 映射。`层=单元`：`node --test tests/unit/wgsl-prelude.test.mjs` （断言每个内建有映射条目、重载已拆名、每个内建样例可被 naga 模块校验通过）。`自检`：该测试全绿。`→ FR-030, 尖刺 §6.1, data-model §4.5`
- [ ] T069 [US1] 地形着色器叶子 WGSL 入库：`backend-webgpu/webgpu/wgsl/**` 收录 `GlobeVS`/`GlobeFS`/`AtmosphereCommon`/`GroundAtmosphere` 闭包的 WGSL 产物（路径 A 出草稿 → 路径 B 人工定稿；以尖刺黄金样本 `port/globe-vs.wgsl`、`port/globe-fs.wgsl` 为起始基线）； **MUST NOT 写入 `Source/Shaders/**`**（补丁边界），MUST NOT 复用 `Source/Shaders/**` 路径。`自检`：`node --test tests/unit/wgsl-leaf-inventory.test.mjs` （断言四个家族齐备、文件位于后端层目录、不存在对 `Source/Shaders/**` 的写路径）；`node tools/scripts/check-wgsl.mjs` 以 0 退出。`→ 原则 I, contracts/fork-patch-layer R3`
- [ ] T070 [US1] 叶子映射与升级漂移检测：`backend-webgpu/webgpu/shader-leaf-map.json`（`upstreamLeafHash` → `wgslFile`、 `convertedBy:"path-a-draft+path-b-final"`、`verifiedOnRealGpu`、`notes`）+ `tools/shader-leaf-map.mjs --update`； 上游叶子哈希变化 ⇒ 映射失配 ⇒ CI 失败并输出"须重做转换"清单。`层=单元`（即 **SH-3 门禁**）：`node --test tests/unit/shader-leaf-map.test.mjs` （断言哈希漂移使检查失败、`verifiedOnRealGpu !== true` 的叶子不得进入验收路径）。`自检`：`node tools/shader-verify.mjs --check-leaf-map` 以 0 退出。`→ H-10, contracts/fork-patch-layer R7, data-model §11 A11`
- [ ] T071 [US1] 运行时片段镜像生成器 `backend-webgpu/webgpu/generated-fragments.ts`：按与上游**同一参数**（`{textureUnits, flags}`） 产出运行时生成的着色器片段（`GlobeSurfaceShaderSet.js:419-472` 的 `computeDayColor()`，**磁盘上不存在**）的 WGSL； 覆盖度以"**可达参数组合**"计数验收，未覆盖组合 MUST 显式失败。`层=单元`：`node --test tests/unit/generated-fragments.test.mjs`。`自检`：该测试全绿。`→ FR-030, contracts/fork-patch-layer R6, data-model §4.5`
- [ ] T072 [US1] varying 成对推导与契约：`VaryingContract{variantKey,varyingSet,vsOutputs,fsInputs}` —— VS 输出 MUST 与 FS 输入**逐项匹配** （WGSL 硬校验）；不匹配即判失败并出具差异报告。`层=单元`：`node --test tests/unit/varying-contract.test.mjs` （含"故意多一个 `@location(7)` 输入 → 判定失败"的反例，对应尖刺 E1 实测）。`自检`：该测试全绿。`→ H-5, contracts/verification-and-benchmark §4（SH-2）, data-model §11 A10`
- [ ] T073 [US1] WGSL 发射器 `backend-webgpu/webgpu/wgsl-emitter.ts`：实现内部接口 `WgslEmission.emit({vertexSources,fragmentSources,defines,destination,attributeLocations,textureUnits,flags}) → {vertexModule,fragmentModule,varyingSet,bindLayout,attributeBindings,diagnostics}` （与 research §6.3 的接口签名一致；`attributeBindings` 原样透传上游名称→location）。`层=单元`：`node --test tests/unit/wgsl-emitter.test.mjs`。`自检`：该测试全绿。`→ FR-030, research §6.3`
- [ ] T074 [US1] 深度范围修正（GL clip z∈[-1,1] → WebGPU NDC z∈[0,1]）在发射器内**成对处理** `@builtin(position)` 写入与 `czm_inverseProjection` 语义； **MUST NOT** 通过改 `Core/PerspectiveFrustum.js` 或 `Renderer/UniformState.js`（保留文件）实现。`层=单元` + `层=架构边界`： `node --test tests/unit/depth-range-remap.test.mjs`（生成文本断言：所有 `gl_Position`/`gl_FragDepth` 写入点均被重映射）； `node tools/scripts/gen-kept-hash.mjs --check` 断言 `UniformState.js` 字节不变。`自检`：两条命令均以 0 退出。`→ research §5.4/§6.3, 原则 I`
- [ ] T075 [US1] `Renderer/ShaderProgram` + `Renderer/ShaderCache` 替换：`fromCache` **只依赖 4 个键**（`context`/`vertexShaderSource`/`fragmentShaderSource`/`attributeLocations`）； 变体级缓存键语义与上游 `[numberOfDayTextures][flags]` 一致；`_bind`/`_setUniforms`/`maximumTextureUnitIndex`/`destroy`/`releaseShaderProgram`； 逻辑层读取面（`vertexShaderSource`/`fragmentShaderSource`/`vertexAttributes`/`id`/`_attributeLocations`）MUST 全部保留。`层=单元`：`node --test tests/unit/shader-program-cache.test.mjs`。`自检`：该测试全绿。`→ FR-030/FR-031, research §6.3/§6.4`
- [ ] T076 [US1] `createUniform`/`createUniformArray` 替换 + uniform 环形缓冲：保留"惰性 set + 自 diff"语义（值未变不写）； 自动 uniform 块**每帧写一次**、手工 uniform（`command.uniformMap`）命令级写入并走动态偏移； `UniformBlockLayout` 与 WGSL 结构逐字段一致（G-4 结论为输入）。`层=单元`：`node --test tests/unit/uniform-writer.test.mjs`（含 `mat3`/数组/`vec3` 对齐边界用例）。`自检`：该测试全绿。`→ FR-030, research §5.4, data-model §4.3`
- [ ] T077 [US1] 绑定布局规划器 `backend-webgpu/webgpu/bind-layout.ts`：`BindingPlan{groups[{groupIndex,entries[{binding,kind,name,slot}]}],textureCount,samplerCount}`； 纹理/采样器进**独立 bind group**（便于按纹理集合变化切换）；`entries` 数 ≤ `maxBindingsPerBindGroup`、 `blockSize` ≤ `maxUniformBufferBindingSize`。`层=单元`：`node --test tests/unit/bind-layout.test.mjs`。`自检`：该测试全绿。`→ FR-030, data-model §4.3`
- [ ] T078 [US1] **SH-2 真机变体管线校验**（`层=视觉`，真机门禁）：`node tools/shader-verify.mjs --family=globe --variants=mvp --emit-report artifacts/shader-verify/globe-mvp.json` —— 对**地形全部可达 define 组合**跑真机 `createRenderPipeline`，断言 0 validation error、varying 成对匹配、 `verifiedOnRealGpu` 在叶子映射中被置真。`自检`：该命令以 0 退出并写出报告（本机无头 Chrome 153 零开关即可用；CI 无 GPU 时按 T080 降级并标注盲区）。`→ FR-010/FR-011, contracts/verification-and-benchmark §4, 尖刺 §4`
- [ ] T079 [US1] **SH-6 变体规模与编译耗时门禁**（`层=基准`）：运行时 `ShaderProgram` 实例数与编译耗时直方图落盘 （`artifacts/shader-variants.json`），超阈值即失败；阈值来源与理由写入测试代码（`ToleranceRecord`）。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=bench:shader-variants` 以 0 退出。`→ H-6, contracts/verification-and-benchmark §4`
- [ ] T080 [US1] **SH-7 CI 降级校验**（`层=单元`）：`tools/scripts/check-wgsl.mjs` —— 用 `naga --input-kind wgsl <file>` 做模块级校验； 无 `naga` 可执行文件时 MUST 打印降级说明并在 CI 配置下判定失败（**MUST NOT 静默通过**），盲区（不覆盖 WebGPU 管线校验）在输出与 `docs/ci-degradation.md` 中显式标注。`自检`：`node tools/scripts/check-wgsl.mjs` 以 0 退出；`node --test tests/unit/check-wgsl.test.mjs` 全绿（含"naga 缺失 → 非 0"反例）。`→ FR-023, contract §4（SH-7）`
- [ ] T081 [US1] `ShaderBuilder` 边界：`Renderer/ShaderBuilder.js` 在 MVP **保持字节不变**；模型/体素/高斯泼溅路径 MUST 以 `category:"not-implemented"` 显式失败（其 WGSL 化属后续增量）。`层=单元` + `层=架构边界`：`node --test tests/unit/shader-builder-boundary.test.mjs`； `node tools/scripts/gen-kept-hash.mjs --check` 以 0 退出。`自检`：两条命令均以 0 退出。`→ 原则 I, contracts/fork-patch-layer R9`
- [ ] T082 [US1] **本增量范围声明**：`docs/shader-coverage-scope.md` —— 明确写出本增量只覆盖**地形着色器闭包** （`GlobeVS`/`GlobeFS`/`AtmosphereCommon`/`GroundAtmosphere` + 约 40 个 `czm_` 内建）， 而**全库 319 个 `.glsl` 叶子 / 244 个 `czm_` 内建 / 40+ 组装点**的一次性转译为 **2–4 人月外推（未逐家族实测），不计入本增量**； 后续增量按家族推进，每家族一个真机编译用例作为门禁。`自检`：`node --test tests/unit/shader-scope-doc.test.mjs`（断言文档含"不计入本增量""2–4 人月""未逐家族实测"三项声明，且**任务清单中不存在**把 319 叶子纳入本增量的任务）。`→ FR-026/FR-027 附近范围界定, mvp-estimate §1/§2, 尖刺 §9`
- [ ] T083 [US1] **W4 Checkpoint**：`node --test tests/unit/glsl-preprocess.test.mjs` + `node tools/scripts/check-arch-boundaries.mjs --rules A9,A10,A11` + `node tools/shader-verify.mjs --check-leaf-map` + `node tools/shader-verify.mjs --family=globe --variants=mvp` 四者全绿； `node tools/audit-patch-scope.mjs` 仍 `pass`（`ShaderSource.js` 属 `adapt-shader`，其余着色器模块字节不变）。`自检`：上述四条命令均以 0 退出。 `→ FR-030, H-5/H-6/H-10`

**Checkpoint（US1 / W4）**：地形着色器可在 WebGPU 上编译并成对匹配 varying；全库着色器覆盖范围已书面界定为增量之外。

---

## Phase 7: User Story 1（续）｜ W5 地形端到端跑通（MVP 验收主体）

**Goal**: 用上游公开类 `CustomHeightmapTerrainProvider` + 本地固定数据集，把地形端到端跑在 WebGPU 后端上：
几何构建与四叉树调度**全部由上游逻辑层完成**，本项目不自建瓦片几何；多瓦片拼接、接缝、深度、交互、设备丢失全部通过自动化断言；
完成**切片 B**（帧缓冲 + `depthTexture=true` 翻转）这一 FR-030 的阻断项。
**Independent Test**: `node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain` 与
`--backend=webgl2 --suite=contract:terrain`（**两次独立运行，串行**）各自全绿。〖二选一〗

- [ ] T084 [US1] 固定数据集生成器 `tools/build-terrain-fixture.mjs`（一次性，Node 22，零第三方依赖或仅用已锁定依赖）： 从公开免登录 Terrarium 源（`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`，无需账号，CORS `*`） 解码 `height = R*256 + G + B/256 - 32768` → 生成 `packages/cesium-webgpu/fixtures/<datasetId>/manifest.json` + `<level>/<x>/<y>.hgt`（小端 Uint16 高程，含 `noDataValue`）。`自检`：`node tools/build-terrain-fixture.mjs --dataset=matterhorn-z0-12` 以 0 退出； `node --test tests/unit/fixture-generator.test.mjs`（对合成小输入断言解码公式与文件布局）。`→ FR-004, contracts/terrain-source §2`
- [ ] T085 [US1] 数据集落盘与完整性校验（`层=单元`）：`tools/scripts/check-fixture.mjs` 断言 `totalBytes ≤ 20 MiB`（目标 3–6 MB）、 `levels` 覆盖 z0–z12 且最大层在覆盖区内 **≥2×2 瓦片**、覆盖区约 0.6°×0.5°（勃朗峰/大孔班山）、高差 **>4000 m**、 `sha256` 一致、`attribution` 非空且 `sources[]` 逐来源给出许可与链接、`tilingScheme: "geographic"`。`自检`：`node tools/scripts/check-fixture.mjs` 以 0 退出； `node --test tests/unit/fixture-manifest.test.mjs` 全绿（含"篡改一个瓦片 → sha256 失败"反例）。`→ FR-015（多瓦片）, FR-024（署名）, contracts/terrain-source §2（TS-3）`
- [ ] T086 [US1] 地形数据源适配 `packages/cesium-webgpu/src/terrain/source.ts`：`createTerrainProvider({mode,datasetId,tilingScheme,credit})` 返回**上游公开类** `CustomHeightmapTerrainProvider`（以 `callback(x,y,level)` 提供公开类 `HeightmapTerrainData`）； `mode: "fixture" | "public"`；MUST NOT 取用任何 `@private` 地形内部类型，MUST NOT 引入需要凭据的服务。`层=单元`： `node --test tests/unit/terrain-source.test.mjs`（TS-1：返回对象类型断言成立；断言不引用内部地形类型）。`自检`：该测试全绿。`→ FR-004, FR-031, contracts/terrain-source §1`
- [ ] T087 [US1] 离线零外部请求断言（`层=契约`）：在验收用例运行期拦截并统计外部请求，断言 **=== 0**（`mode:"fixture"`）， 强制断网后仍能完成地形验收用例。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain-offline` 与 `--backend=webgl2 --suite=contract:terrain-offline` 串行各以 0 退出。〖二选一〗`→ FR-012, contracts/terrain-source §5（TS-2/TS-4）`
- [ ] T088 [US1] 数据不可用与渲染失败**可区分**（FR-004/TS-5）：瓦片缺失/获取失败/超时 → "数据不可用"可观察状态， 其余瓦片继续渲染（不得整帧丢弃或页面卡死）；空瓦片/无效瓦片 → 无错误几何（不出现尖刺、穿模、NaN 顶点）。`层=单元` + `层=契约`；`自检`：`node --test tests/unit/terrain-unavailable.test.mjs` 全绿；`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain-unavailable` 以 0 退出。`→ FR-004, 边界情形（瓦片获取失败/空瓦片）`
- [ ] T089 [US1] 场景构造与句柄实现：`packages/cesium-webgpu/src/index.ts` 的 `createTerrainScene(options)` 返回 `TerrainSceneHandle` （`ready` MUST NOT reject、`whenTilesLoaded`、`captureFrame`、`stats`/`resetStats`、`setView`、`requestRender`、`dispose`、`diagnostics`）； 场景配置 MUST 为 MVP 集合：`baseLayer:false`、`skyBox:false`、`skyAtmosphere:false`、无后处理、`globe.enableLighting=true`。`层=单元` + `层=架构边界`： `node --test tests/unit/scene-config.test.mjs`（含 **A6**：构造参数必含三个 `false`，保证零 `ComputeCommand` 派发）。`自检`：该测试全绿。`→ FR-001, FR-007, data-model §11 A6, research §1.6`
- [ ] T090 [US1] 上游地形顶点布局消费：属性**名称 → location** 映射 MUST 沿用上游 `TerrainEncoding.getAttributeLocations()` （`position3DAndHeight`(0)、`textureCoordAndEncodedNormals`(1)、`geodeticSurfaceNormal`(2)；`NONE` 与 `BITS12` 两种量化模式的 `componentsPerAttribute`/`offsetInBytes`/stride），全部属性 FLOAT 非归一化，共用同一交错顶点缓冲；索引类型（Uint16/Uint32）不固定。 `层=单元`：`node --test tests/unit/terrain-vertex-layout.test.mjs`（两种量化模式的字段级断言）。`自检`：该测试全绿。`→ FR-030, research §1.6`
- [ ] T091 [US1] **地形就绪端到端契约测试**（`层=契约`，US1 的 Independent Test）：`tests/contract/terrain-ready.spec.mjs` —— 固定相机/时间/种子/视口/像素比/数据集；`whenTilesLoaded()` 返回 `loaded:true`；画面非空白、非纯背景色； 零未捕获错误；**多瓦片拼接**场景成立；每次运行断言**另一条后端的 GPU 对象创建数为 0**。〖二选一〗`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain-ready` 与 `--backend=webgl2 --suite=contract:terrain-ready` 串行各以 0 退出。`→ FR-001, FR-011, FR-015, SC-001`
- [ ] T092 [US1] 地形多瓦片视觉回归（`层=视觉`）：`tests/visual/terrain-multitile.spec.mjs` —— **每条路径各自一份参考帧** （`reference-frames/<datasetId>/<caseId>.<backend>.png`），比较区域排除抗锯齿边缘，容差写入测试代码并记录来源（`ToleranceRecord`）， 失败产出差异图与统计 JSON 到 `artifacts/`；跨路径差异一律**离线比较**，MUST NOT 同帧对比。〖二选一〗`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=visual:terrain` 与 `--backend=webgl2 --suite=visual:terrain` 串行各以 0 退出。`→ FR-010/FR-013/FR-014, SC-002/SC-009`
- [ ] T093 [US1] 几何类缺陷的**数值化**断言（`层=视觉`，FR-016）：接缝裂缝、空洞、错误遮挡、异常顶点由数值断言捕获 （覆盖率突变、深度不连续处像素比例、几何统计区间、三角数与 draw call 数异常），**MUST NOT** 依赖人工目视。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=visual:terrain-geometry` 与 `--backend=webgl2 --suite=visual:terrain-geometry` 串行各以 0 退出（含"人为删掉一块瓦片 → 断言必须失败"的自检用例）。`→ FR-016, FR-010`
- [ ] T094 [US1] 高程特征可观察断言（`层=视觉`/统计）：地形最高与最低处的可观察表现差异明显（明暗或遮挡差异）， 不出现空白/纯背景色/整片单色（`uniqueColorCount`），并与数据集高程数值比对（区间与来源落盘）。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=visual:terrain-elevation` 与 `--backend=webgl2 --suite=visual:terrain-elevation` 串行各以 0 退出。〖二选一〗`→ SC-002, FR-001`
- [ ] T095 [US1] 相机交互契约测试（`层=契约`，SC-004）：瓦片就绪后连续 3 秒执行旋转/缩放/平移（固定步长与时长）， 断言 (a) 无 **>1000 ms** 的连续卡顿、(b) 无未捕获错误、(c) 交互结束并稳定后定格帧的统计量与交互前同区间、(d) 帧计数持续增长。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:interaction` 与 `--backend=webgl2 --suite=contract:interaction` 串行各以 0 退出（帧时间超阈值时 MUST NOT 放宽断言，须记录实测分布）。〖二选一〗`→ FR-002, SC-004`
- [ ] T096 [US1] 设备丢失恢复契约测试（`层=契约`，FR-003）：`device.destroy()` → 停止提交 → 销毁后端与场景 → 重新探测 → 整体重建 → 恢复交互；断言免刷新恢复、无未捕获错误、旧设备资源计数归零、给出状态提示；MUST NOT 保留旧设备绘制结果。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:device-lost-terrain` 以 0 退出（独立进程）。〖二选一〗`→ FR-003, SC-004, data-model §10④`
- [ ] T097 [US1] **切片 B 实现**：`Framebuffer`/`Renderbuffer`/`MultisampleFramebuffer`/`FramebufferManager` 的附件化实现 + 离屏深度纹理 + 深度拷贝用的**视口四边形命令**（`createViewportQuadCommand` 与 `GlobeDepth` 所需路径）。`层=单元` + `层=契约`；`自检`：`node --test tests/unit/offscreen-depth.test.mjs` 全绿；`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:offscreen-depth` 以 0 退出。`→ FR-030（帧缓冲）, research §7 切片 B`
- [ ] T098 [US1] **切片 B 阻断项**：把 `depthTexture` 翻转为 `true` 并重跑**全量验证**（单元 + 契约 + 视觉 + 基准，两条路径各自独立运行）； 断言 `sliceBComplete === true ⇒ depthTexture === true`（不一致即 CI 失败）。`自检`（**不标 [P]**：改动能力表并触发全量回归）：`node --test tests/unit/capability-composition.test.mjs` 全绿 + 两路径全量套件串行各以 0 退出 + `node tools/scripts/check-arch-boundaries.mjs --rules A8` 以 0 退出。`→ FR-030, plan Complexity Tracking（长期停留在降级态即视为 FR-030 未兑现）` ⛔ **阻断项**

**Checkpoint（US1 / W5）**：SC-001 / SC-002 / SC-004 在**两次独立运行**下各自通过；切片 B 已完成翻转——US1 达成 MVP。

---

## Phase 8: User Story 2 - 新路径不可用时旧路径整体兜底（P1）｜ W6 双路径能力探测与整体兜底

**Goal**: 初始化阶段一次性完成"探测 → 选择 → 构造"；探测失败/超时（≤2 s）/低于下限时**整体**以 WebGL2 构造；
回退是销毁重建而非叠加；状态可观察；集成方代码零分支。
**Independent Test**: `node tests/support/backend-runner.mjs --backend=webgl2 --suite=contract:fallback`
（**独立进程**，强制 `navigator.gpu = undefined`）全绿，且该次运行中 WebGPU 的 GPU 对象创建数为 0。〖二选一〗

- [ ] T099 [US2] 能力探测 `packages/cesium-webgpu/src/render-path/probe.ts`：`navigator.gpu` 存在性 → `requestAdapter()` → `requestDevice()` → 必需特性与下限（`maxTextureDimension2D`/`maxVertexAttributes`/`maxSampledTexturesPerShaderStage`/`maxUniformBufferBindingSize`）； 产出 `CapabilityProbeResult`（`navigatorGpuPresent`/`adapterObtained`/`deviceObtained`/`adapterInfo`/`features`/`limits`/`elapsedMs`/`reason`）， `elapsedMs` MUST ≤ **2000**（超时即判不可用，`reason:"timeout"`）。`层=单元`：`node --test tests/unit/probe-decision.test.mjs` （决策表逐条：不支持/无适配器/设备请求失败/缺特性/低于下限/超时，含注入假时钟的超时用例）。`自检`：该测试全绿。`→ FR-005, data-model §2.2`
- [ ] T100 [US2] 路径选择与整体切换 `packages/cesium-webgpu/src/render-path/select.ts`：`preference` 三态 （`webgl2` 不探测直接用上游原版后端；`webgpu` 探测失败 → 整体兜底；`auto` 把"不支持"视为正常结果）； 探测成功才安装设备交接槽；失败**不安装**（→ 上游原版 WebGL2 链路）；`decidedAt` 一经选定本会话内 MUST NOT 变更； `WholeSwitchRecord` 记录。`层=单元`：`node --test tests/unit/path-selection.test.mjs`（三态决策 + 交接槽安装/不安装断言 + 无中间态）。`自检`：该测试全绿。`→ FR-005/FR-006, data-model §2.3`
- [ ] T101 [US2] C-1 / C-3 契约测试（`层=契约`）：`createTerrainScene` 在两条路径下都返回可用句柄且 `ready` MUST NOT reject； 强制 WebGPU 不可用后页面仍渲染地形、**2 秒内完成整体回退**、无未捕获错误、无空白画面。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:handle` 与 `--backend=webgl2 --suite=contract:handle --force-no-webgpu` 串行各以 0 退出。〖二选一〗`→ FR-005, SC-003, contracts/render-path-api §5（C-1/C-3）`
- [ ] T102 [US2] "本次只启用一条路径"的**可执行判据**（`层=契约`）：每次运行 MUST 断言**另一条后端的 GPU 对象创建数为 0**； 同会话双路径的用例 MUST 被判失败（A7）。`自检`：`node --test tests/unit/single-backend-invariant.test.mjs`（含"人为构造同会话双路径 fixture → 判定失败"反例）； `node tools/scripts/check-arch-boundaries.mjs --rules A7` 以 0 退出。`→ FR-006/FR-011, 原则 II, contracts/verification-and-benchmark §2`
- [ ] T103 [US2] C-4 整体切换契约测试（`层=契约`）：设备丢失后整体重建成功；`WholeSwitchRecord.destroyedResources > 0`、 `residualDraws === 0`；切换期 MUST NOT 同时提交两条路径的绘制；MUST NOT 以 CSS/画布叠加掩盖旧路径。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:whole-switch` 以 0 退出（独立进程）。〖二选一〗`→ FR-003/FR-006, contracts/render-path-api §3`
- [ ] T104 [US2] 可观察性（FR-009）：`onStatus` 回调与演示页状态区 MUST 展示当前生效路径、原因类别、是否降级、盲区备注； `degraded === true ⇒ notes` 非空；状态信息**仅供观察与排障**，业务代码 MUST NOT 依据 `status.active` 分支。`层=单元` + `层=契约`；`自检`：`node --test tests/unit/status-observability.test.mjs` 全绿；`node tests/support/backend-runner.mjs --backend=webgl2 --suite=contract:status` 以 0 退出。`→ FR-009, FR-023, data-model §2.5`
- [ ] T105 [US2] C-5 / C-6 架构边界断言（`层=架构边界`）：`node tools/scripts/check-arch-boundaries.mjs --rules A1,A2,A5` —— 调用方（演示页）源码无路径分支、`dist/index.d.ts` 无后端/GPU 符号、包入口不 re-export `./escape-hatch`、 `src/**` 不 import `backend-webgpu/**` 具体实现。`自检`：该命令以 0 退出。`→ FR-007, 原则 II, contracts/render-path-api §5（C-5/C-6）`
- [ ] T106 [US2] C-7 跨后端统计等价（`层=契约`）：`CrossBackendEquivalence{metric,webgpuRange,webgl2Range,overlapRatio,declaredDifferences}` —— 用**统计断言**（非背景覆盖率、颜色/深度分布、几何与 draw call 统计落在声明区间）判定等价； `declaredDifferences` MUST 显式声明无法消除的差异（亚像素边缘、MSAA 解析、sRGB、深度表示、WGSL 无精度修饰符的精度差、纹理 Y 翻转处理差异）； 两路径数据**分别采集、离线比较**。〖二选一〗`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:cross-equivalence` 与 `--backend=webgl2 --suite=contract:cross-equivalence` 串行各以 0 退出，再 `node tests/support/compare-offline.mjs --artifact=artifacts/cross-equivalence` 以 0 退出。`→ FR-008, SC-001, contracts/verification-and-benchmark §3`
- [ ] T107 [US2] **W6 Checkpoint**：`node --test tests/unit` 全绿；两路径 contract 套件串行各自通过； `node tools/scripts/check-arch-boundaries.mjs --rules A1,A2,A5,A7` 以 0 退出；演示页手动打开两条路径各一次并记录状态区文案（**作为证据链接**，不作为判据）。`自检`：上述命令均以 0 退出。 `→ FR-005/FR-006/FR-009, SC-003`

**Checkpoint（US2 / W6）**：SC-003 达成；US1 与 US2 均可独立运行并通过各自断言。

---

## Phase 9: User Story 3 - 渲染结果可自动化验证（P2）｜ W7 验证资产与测试基建

**Goal**: 让"地形渲染是否正确"完全由流水线判定：双路径独立运行脚手架、每路径各自参考帧、像素回归 + 统计断言、
差异图产物、容差来源可追溯、真机 WGSL 管线校验 harness、确定性冻结。
**Independent Test**: 人为引入一处渲染缺陷（如删掉一块瓦片 / 改错一个 uniform）后，
`node tests/support/backend-runner.mjs --backend=webgpu --suite=visual:terrain` 必须**失败**并产出差异图与差异区域。

- [ ] T108 [US3] 双路径独立运行脚手架产品化 `tests/support/backend-runner.mjs`：统一 `--backend`、`--suite`、`--seed`、`--viewport`、 `--output artifacts/`；**MUST NOT** 提供任何"同会话双路径 / 同帧对比 / 叠加 / 逐帧合成"入口（API 表面断言）。 `自检`：`node --test tests/unit/backend-runner-surface.test.mjs`（断言不存在同帧对比入口 + 每次运行只接受一个 `--backend`）。`→ FR-011, 原则 II, contracts/verification-and-benchmark §2`
- [ ] T109 [US3] 验证资产包 `packages/cesium-webgpu/src/verify/**`：像素/统计断言、差异图生成、基准采集， **被 tests 与 CI 复用**（不得在 `tests/**` 里重复实现同一逻辑）。`自检`：`node --test tests/unit/verify-package.test.mjs` （断言断言器 API 与差异图生成器可独立调用、`tests/**` 未重复实现统计逻辑）。`→ FR-010/FR-013, plan「Project Structure」`
- [ ] T110 [US3] 统计量实现与 `FrameStatistics`：`nonBackgroundRatio`/`uniqueColorCount`/`depthDiscontinuityRatio`/`triangleCount`/ `drawCallCount`/`tileCount`/`frameTimeMs{p50,p95}`；`drawCallCount` 统计**真实** `drawIndexed`/`draw` 调用（WebGL2 侧通过包装平台 API `drawElements`/`drawArrays` 计数——包装平台 API 不是改上游实现）。`层=单元`：`node --test tests/unit/frame-statistics.test.mjs` （对合成图像的已知统计值断言，含 p50/p95 计算正确性）。`自检`：该测试全绿。`→ FR-010/FR-016, FR-017, data-model §7.1`
- [ ] T111 [US3] 参考帧机制：`reference-frames/<datasetId>/<caseId>.<backend>.png`（**每路径各自一份**）+ 元数据 （路径/浏览器版本/是否软件光栅化/相机与时间快照）；更新流程 MUST 经评审并在提交信息中说明原因，旧参考帧变更历史可追溯。`自检`：`node --test tests/unit/reference-frame-contract.test.mjs` （断言"同一 caseId 两条后端各自一份"、元数据字段齐备、缺少评审说明的更新被判失败）。`→ FR-010/FR-015, SC-009, contracts/verification-and-benchmark §1/§3`
- [ ] T112 [US3] 容差标定与 `ToleranceRecord{metric,threshold,unit,rationale,source,recordedAt}`：阈值写在测试代码中且**来源可追溯**； **MUST NOT** 采用"任意像素差异均通过"式判据；diff 比较区域排除抗锯齿边缘。`层=单元`：`node --test tests/unit/tolerance-record.test.mjs` （含"`source`/`rationale` 为空 → 判定失败""阈值放宽但无变更理由 → 判定失败"两组反例）。`自检`：该测试全绿。`→ FR-014, data-model §7.3`
- [ ] T113 [US3] 差异证据产物（FR-013）：验证失败时 MUST 产出**差异图 + 统计数值 JSON** 到 `artifacts/` 并作为 CI 产物保存；`VisualEvidence{runId,backend,referenceFrameId,diffImagePath,mismatchRatio,tolerance,regions[]}` 字段齐备。`自检`：`node --test tests/unit/visual-evidence.test.mjs` （含"人为注入缺陷 → 差异图与 regions 必须非空"的用例）。`→ FR-013, SC-009, data-model §7.2`
- [ ] T114 [US3] 真机 WGSL 管线校验 harness 集成（`层=视觉`）：`tools/shader-verify.mjs` 在有 GPU 环境跑真机 `createRenderPipeline`；无 GPU 环境 MUST 自动降级为 `naga --input-kind wgsl` 模块校验**并在产物中标注盲区** （不覆盖 varying 契约/绑定布局/格式兼容），保留本机复现步骤。`自检`：`node --test tests/unit/shader-verify-degradation.test.mjs` （断言降级时产物含 `degraded:true` 与盲区说明、MUST NOT 静默把降级结果当作真机通过）。`→ FR-023, contracts/verification-and-benchmark §4（SH-7）/§8`
- [ ] T115 [US3] 测试运行隔离断言（`层=架构边界`）：`VerificationRun.backend` 每次运行**只有一个**； `isolation ∈ {"separate-process","separate-page-load"}`，**MUST NOT** 为"同会话双路径"；`fixedConditions` 全字段必填。`自检`：`node --test tests/unit/verification-run-isolation.test.mjs`； `node tools/scripts/check-arch-boundaries.mjs --rules A7` 以 0 退出。`→ FR-011/FR-012, 原则 II, data-model §7.1`
- [ ] T116 [US3] 确定性冻结（`层=单元`，FR-012）：相机、场景时间、随机种子、视口尺寸、设备像素比、地形数据集、 MVP 场景配置（`baseLayer:false`/`skyBox:false`/`skyAtmosphere:false`/无后处理）全部固定；**重复运行结论一致** （同一提交重复运行不出现随机通过/失败）；无法消除的非确定性来源被**量化并记录**。`自检`：`node --test tests/unit/determinism-freeze.test.mjs` （断言固定条件对象逐字段存在；重复运行两次的统计差异在记录区间内）。`→ FR-012, SC-001④, 边界情形（重复运行的确定性）`
- [ ] T117 [US3] **W7 Checkpoint**：`node --test tests/unit` 全绿；两路径 visual 套件串行各以 0 退出且产出参考帧与差异图（失败用例）； `node tools/scripts/check-arch-boundaries.mjs --rules A7` 以 0 退出。`自检`：上述命令均以 0 退出。 `→ FR-010~FR-016, SC-009`

**Checkpoint（US3 / W7）**：SC-009 达成；渲染结论不再依赖肉眼，且两条路径各有独立可复现的证据链。

---

## Phase 10: User Story 4 - 性能结论由数据支撑（P2）｜ W8 持续集成与基准基建

**Goal**: CI 上无 GPU 也能跑通两条路径的验证与基准；基准产出帧时间 p50/p95、图形显存代理指标、draw call 数并形成历史序列；
劣化超阈值即失败；单项提交到结论 ≤20 分钟；盲区显式记录。
**Independent Test**: 在 CI 上跑一次完整流水线（两路径各自独立运行）并产出 `history.jsonl`；
人为引入一处性能劣化后，基准门槛判定失败。

- [ ] T118 [US4] CI 工作流完成 `.github/workflows/ci.yml`：`install+build → lint+typecheck → unit（含 A1–A11）→ audit（AU-1…AU-5）→ shader（SH-3/SH-4/SH-7）→ contract+visual+bench（**两个并行 job：webgl2 与 webgpu，各自独立进程**，job 内顺序 contract → visual → bench） → 汇总（任一失败阻断合入）`；全部门禁 ≤20 分钟。`层=单元`：`node --test tests/unit/ci-workflow.test.mjs` （YAML 解析断言门禁顺序、**两条路径分属不同 job 且不共享页面/进程**、汇总 job 依赖全部前置 job）。`自检`：该测试全绿。`→ FR-021/FR-022, SC-005, contracts/verification-and-benchmark §7`
- [ ] T119 [US4] 无 GPU 两套降级配方固化到 CI：WebGPU 路径 = Xvfb（**必须 headed**）+ Mesa lavapipe + 固定标志 （`--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --disable-gpu-watchdog --no-sandbox`）； WebGL2 路径 = ANGLE/SwiftShader（`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`）； **MUST NOT** 写入无效/过时标志。`层=单元`：`node --test tests/unit/ci-degradation-flags.test.mjs`（标志白名单 + 两路径配方互斥断言）。`自检`：该测试全绿。`→ FR-023, contracts/verification-and-benchmark §8`
- [ ] T120 [US4] 着色器转换工具链安装（仅一次性转换与 CI 校验，**不进入运行时**）：`glslang 16.6.0` **官方 Linux 预编译包**（零编译成本） + `cargo install naga-cli --locked`（**naga 无预编译二进制**，CI MUST 缓存 `~/.cargo`；MUST NOT 出现"下载 naga 二进制"式步骤） + `@webgpu/glslang 0.0.15` 若使用 MUST 显式引 `dist/web-devel-onefile`；三个版本与锁定值写入 workflow 注释与 `upstream/engine-26.3.0.lock.json` 的 `toolchain` 段一致。`层=单元`：`node --test tests/unit/ci-shader-toolchain.test.mjs` （YAML 断言：存在 `cargo install naga-cli --locked`、存在 cargo 缓存步骤、**不存在**任何 naga 二进制下载步骤）。`自检`：该测试全绿。`→ contracts/fork-patch-layer R8, quickstart §1, 尖刺 §1/§7.3`
- [ ] T121 [US4] 基准采集（`层=基准`）：帧时间 p50/p95（固定预热 120 帧、采样 600 帧，CI 缩减并记录缩减方式）、 图形显存**代理指标**（`GpuResourceRecord.bytes` 汇总）、draw call 数（真实 `drawIndexed`/`draw` 计数）； 记录 `EnvironmentFingerprint{os,cpu,gpu{vendor,architecture,type},browser,browserVersion,playwrightVersion,backend,degraded,timestampMode}`； 两条路径 MUST 在**各自独立会话**采集。〖二选一〗`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=bench:terrain` 与 `--backend=webgl2 --suite=bench:terrain` **串行**各以 0 退出并写出 `BenchmarkRecord`。`→ FR-017, SC-006, data-model §8.1/§8.2`
- [ ] T122 [US4] 基准存档与历史序列（FR-020）：结果追加写入 `artifacts/history.jsonl`，形成可比较的历史序列 （含 commit、环境指纹、三项指标、是否降级）。`层=单元`：`node --test tests/unit/benchmark-history.test.mjs` （追加语义、不得覆盖历史、字段齐备）。`自检`：该测试全绿。`→ FR-020, SC-006`
- [ ] T123 [US4] 量化回归门槛（`层=基准`，FR-018）：帧时间/显存劣化超阈值即**判定失败**并输出与基线的差值； 门槛变更 MUST 记录理由与影响（`ToleranceRecord.threshold` + `rationale`）。`自检`：`node --test tests/unit/benchmark-gate.test.mjs` （**人造劣化必须使判定失败**、无基线时给出明确提示而非静默通过）。`→ FR-018, SC-006, 原则 IV`
- [ ] T124 [US4] 降级运行的结论口径（FR-023）：`degraded === true` 时基准结论 MUST 标注为**相对**回归意义， 并在记录中显式写出降级方式与盲区；MUST NOT 据此宣称性能收益。`层=单元`：`node --test tests/unit/benchmark-degradation.test.mjs`。`自检`：该测试全绿。`→ FR-023, US4④, data-model §8.1`
- [ ] T125 [US4] 受门控的真实 GPU 作业：`.github/workflows/` 中新增 `gpu:absolute`（真实 GPU 的绝对性能与 `timestamp-query` 剖析）， **默认不执行**，必须由入口 Agent 上报用户批准预算后才可手动触发；未批准时绝对性能标记 `degraded:true`。`层=单元`：`node --test tests/unit/gpu-job-gating.test.mjs` （断言该 job 不在默认触发路径上、需显式手动触发、文件内含"需预算批准"说明）。`自检`：该测试全绿。`→ 原则 IV, mvp-estimate §5「执行门禁」`
- [ ] T126 [US4] CI 产物上传（原则 V）：构建日志、测试报告、差异图、统计 JSON、`history.jsonl`、 `artifacts/patch-scope-audit.json`、`artifacts/upgrade-drill.json`、`artifacts/shader-verify/**` MUST 上传归档。`层=单元`：`node --test tests/unit/ci-artifacts.test.mjs` （YAML 解析断言产物路径覆盖上述七类，且失败时仍上传 `if: always()`）。`自检`：该测试全绿。`→ 原则 V, FR-022, contracts/verification-and-benchmark §7`
- [ ] T127 [US4] **W8 Checkpoint**：CI 完整跑通一次（两路径各自独立运行）并产出全部产物；`node tools/scripts/check-gate.mjs --gate g7` 以 0 退出（**G-7 门禁结论在此正式落盘**，且 MUST 早于 T098 的切片 B 翻转完成——若顺序冲突，以 T098 为阻断项优先处理并上报入口 Agent）； 单次提交到结论耗时 ≤20 分钟（记录实测值）。`自检`：CI 运行记录 + `node tools/scripts/check-gate.mjs --gate g7` 以 0 退出。 `→ FR-017~FR-025, SC-005/SC-006`

**Checkpoint（US4 / W8）**：SC-005 / SC-006 达成；CI 成为唯一事实来源，本地通过不再等价于通过。

---

## Phase 11: User Story 5 - 拿到 MVP 的工期与 AI/Agent 消耗结论（P2）｜ W9 开源交付、文档与评估交付

**Goal**: 交付开源形态（LICENSE / NOTICE / CONTRIBUTING / 可复现构建说明 / fork 基线与补丁范围说明 / rebase 演练手册 /
降级与盲区说明）并让评估结论（FR-026~FR-029 / SC-007）成为**受 CI 契约测试保护、可回填、可版本化**的交付物。
**Independent Test**: `node --test tests/unit/mvp-estimate-contract.test.mjs` 全绿（schema 校验 + 口径断言 + 工作流齐备 + 单价来源可追溯）；
`node tools/backfill-actuals.mjs --dry-run` 以 0 退出。

> **本阶段不重新撰写评估结论**：`mvp-estimate.md` 与 `mvp-estimate.v1.json` 已存在且为 v2.1.0，
> 本阶段的交付是**评估结论的 CI 契约测试、回填机制与版本化机制**。

- [ ] T128 [US5] 评估结论的 CI 契约测试（`层=单元`）：`tests/unit/mvp-estimate-contract.test.mjs` + `tools/scripts/lib/json-schema-lite.mjs`（仓库内自实现的**最小 JSON Schema 子集校验器**，避免新增依赖）—— 按 [contracts/mvp-estimate.schema.json](./contracts/mvp-estimate.schema.json) 校验 `mvp-estimate.v1.json`，并断言： (a) `meteringBasis.includesHumanCost === false`；(b) `meteringBasis.statement` 含"**人工成本不计入**"； (c) `workflows` 齐备（≥5 且含 W1–W9，每项有 `timeDays`/`agentTurns`/`tokens`/`modelCost`/`computeCost`/`assumptions`）； (d) `priceSources[]` 的 `source` 匹配 `^https?://` 且 `consultedAt` 为日期（**单价来源可追溯**）；(e) 币种为 CNY 主 + USD 副且含汇率来源与日期； (f) `actualsBackfill` 结构合法（未交付时可为 `null`）。`自检`：`node --test tests/unit/mvp-estimate-contract.test.mjs` 全绿 （含"把 `includesHumanCost` 改成 true → 失败""删掉 statement 中的口径字样 → 失败"两组反例）。`→ FR-027, FR-028, SC-007`
- [ ] T129 [US5] `actualsBackfill` 回填机制（FR-028）：`tools/backfill-actuals.mjs` —— 首个增量实际交付后回填 实际工作日、实际输入/输出 token（含缓存命中/未命中拆分）、实际算力费用、与估算区间的偏差说明， 并作为后续增量的估算基线；回填 MUST 递增结论版本并按 `revisionPolicy` 保留历史版本。`自检`：`node --test tests/unit/actuals-backfill.test.mjs` （schema 校验回填结果、断言版本必须递增、未交付时 `actualsBackfill: null` 合法）；`node tools/backfill-actuals.mjs --dry-run` 以 0 退出。`→ FR-028, mvp-estimate §8`
- [ ] T130 [US5] 偏差说明机制（SC-008）：`docs/delivery-deviation.md`（**不设硬性交付期限**；交付时给出可追溯的时间区间； 实际用时超出区间时 MUST 书面说明偏差原因与新预期）+ `tools/check-deviation.mjs`（断言存在区间声明与偏差说明章节）。`自检`：`node tools/check-deviation.mjs` 以 0 退出； `node --test tests/unit/deviation-doc.test.mjs` 全绿。`→ SC-008, FR-028`
- [ ] T131 [US5] `README.md`：项目定位（**用 WebGPU 渲染后端替换上游 WebGL2 渲染后端**）、快速开始（`npm ci` → `npm run build` → 两条路径**分别**运行）、 补丁层边界声明（改动只落 `Source/Renderer/**`）、上游基线与版本、许可证与署名、指向 `docs/**` 的索引； **MUST NOT** 写入代理地址或本机绝对路径。`自检`：`node --test tests/unit/readme-contract.test.mjs`（断言关键章节齐备、无本机绝对路径、无代理地址、命令均为 Node/npm 跨平台形式）。`→ FR-024, 全局约定 4`
- [ ] T132 [US5] `CONTRIBUTING.md` 完成：写入**补丁边界规则**（改动只能落在 `Source/Renderer/**`；清单条目 MUST 有 `requirementRef` 与 `reason`； 上游内部改动 MUST 走升级演练；跳过测试 MUST 附理由并在 PR 说明，禁止长期无条件跳过）、评审须给出原则 I–V 合规说明与证据路径。`自检`：`node --test tests/unit/contributing-contract.test.mjs`（断言五条规则与"证据路径"要求齐备）。`→ FR-024, 原则 I/II/V, constitution 测试与验证策略`
- [ ] T133 [US5] `docs/rebase-runbook.md` + `docs/fork-notice.md`：补丁形态选择依据、上游基线版本与完整性哈希、 **逐条列出被重实现的文件与理由**（与 `manifest.json` 一致）、升级演练两种模式（干跑 / 完整）的执行步骤与"三项齐备才可合入"判据、 失败处置路径。`自检`：`node --test tests/unit/rebase-runbook.test.mjs`（断言清单与 manifest 一致、两种模式与三项判据齐备）；`node tools/scripts/check-license-notice.mjs` 以 0 退出。`→ FR-032, 原则 I, contracts/fork-patch-layer §6/§7`
- [ ] T134 [US5] `docs/ci-degradation.md` **定稿**：两套软件适配器配方、降级运行的判定与标注方式、 **全部盲区**（软件光栅化 ≠ GPU；无 GPU 时间戳；headless 下 WebGPU 画布呈现不可靠故 MUST headed； lavapipe 报错文本与真实驱动可能不同；浏览器版本漂移改变像素；**naga WGSL 校验不覆盖 WebGPU 管线校验**） 与**本机真机复现步骤**。`自检`：`node tools/scripts/check-degradation-doc.mjs` 以 0 退出（断言五个盲区条目与本机复现步骤齐备）。`→ FR-023, 原则 V, contracts/verification-and-benchmark §8`
- [ ] T135 [US5] `docs/reproducible-build.md`：Node ≥22 前提、`npm ci` 锁定（精确版本 + integrity）、 着色器工具链版本锁定（`glslang 16.6.0` / `naga-cli 30.0.1` / `@webgpu/glslang 0.0.15` 显式 `dist/web-devel-onefile`）、 构建产物校验（`dist/index.d.ts` 无后端符号、逻辑层零覆盖）与"如何验证构建可复现"。`自检`：`node --test tests/unit/reproducible-build-doc.test.mjs` 全绿。`→ FR-024, 附加技术约束`
- [ ] T136 [US5] quickstart 复现验证（`层=契约`）：按 [quickstart.md](./quickstart.md) §2→§6 逐步实跑 （补丁边界自检 → 两条路径**分别**运行演示 → 视觉回归 → 基准 → CI 等价复现），把每条命令的实跑结论与产物路径记入 `docs/quickstart-validation.md`；发现与实际不符处 MUST 以"实现偏离"条目上报入口 Agent（**不得**由本阶段自行改 `quickstart.md`）。〖二选一〗`自检`：`node --test tests/unit/quickstart-validation.test.mjs`（断言 §2–§6 每节均有实跑结论与产物路径）。`→ SC-001/SC-003/SC-010, quickstart §0`
- [ ] T137 [US5] 演示页完善：状态区（当前路径 / 原因类别 / 是否降级 / 盲区备注）、地形数据**署名可见**（`Attribution.shownInDemo === true`）、 瓦片加载进度、"模拟设备丢失"入口（`device.destroy()`）、数据集选择；**MUST NOT** 出现后端分支代码。`层=契约`；`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:demo` 与 `--backend=webgl2 --suite=contract:demo` 串行各以 0 退出； `node --test tests/unit/demo-attribution.test.mjs`（断言署名非空且展示位存在）。〖二选一〗`→ FR-009, FR-024, data-model §6.4`
- [ ] T138 [US5] **W9 Checkpoint**：`node --test tests/unit/mvp-estimate-contract.test.mjs` + `node tools/backfill-actuals.mjs --dry-run` + `node tools/check-deviation.mjs` + `node tools/scripts/check-license-notice.mjs` + `node tools/scripts/check-degradation-doc.mjs` 全部以 0 退出。`自检`：上述五条命令均以 0 退出。 `→ FR-024, FR-026~FR-029, SC-007/SC-008`

**Checkpoint（US5 / W9）**：SC-007 / SC-008 达成；开源交付形态齐备，评估结论受 CI 保护且可回填。

---

## Phase 12: Polish & Cross-Cutting Concerns

**Purpose**: 跨切面收尾、终局证明与验收映射。
**⚠️**：本阶段依赖全部前序阶段；其中 T141 是 SC-010 的**终局证明**，MUST NOT 以任何单点证据替代。

- [ ] T139 全量回归：`node tools/scripts/run.mjs ci:local`（构建 → 类型检查 → 单元 → 审计 → 着色器校验 → 两路径契约/视觉/基准**串行各自独立运行**）全部以 0 退出；记录总耗时。`自检`：该命令以 0 退出且耗时记录落盘 `artifacts/ci-local.json`。`→ FR-021/FR-022, SC-005`
- [ ] T140 [P] 架构边界总门禁（`层=架构边界`）：`node tools/scripts/check-arch-boundaries.mjs --rules A1,A2,A3,A4,A5,A6,A7,A8,A9,A10,A11` 以 0 退出，产物 `artifacts/arch-boundaries.json` 归档为 CI 产物。`自检`：该命令以 0 退出。`→ SC-010, FR-007, data-model §11`
- [ ] T141 [P] **SC-010 终局证明**：`PatchScopeAudit.verdict === "pass"` + `logicLayerOverrides === 0`（补丁范围审计）+ 依赖完整性哈希一致 + `UpgradeDrillRecord.verdict === "pass"`（升级演练，三项齐备）三者同时成立， 证据路径写入 `docs/sc010-evidence.md`。`自检`：`node tools/audit-patch-scope.mjs && node tools/scripts/verify-upstream-integrity.mjs && node tools/upgrade-drill.mjs --dry-run` 全部以 0 退出；`node --test tests/unit/sc010-evidence.test.mjs` 全绿。`→ SC-010, FR-031/FR-032, 原则 I/V`
- [ ] T142 [P] 稳定性与泄漏复核（`层=单元`）：长时运行下帧 N 与帧 N+K 的活跃 GPU 资源集合在稳态不增长； 重复运行结论一致；`dispose()` 后后端资源计数归零。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=stability:leak` 与 `--backend=webgl2 --suite=stability:leak` 串行各以 0 退出。〖二选一〗`→ FR-025, data-model §5.1`
- [ ] T143 [P] 跳过测试治理：`node tools/scripts/check-skips.mjs` —— 断言 `tests/**` 中不存在长期无条件 `skip` （存在即要求 `reason` 字段并在 PR 说明）；MUST NOT 用 `skip` 代替差异断言。`自检`：`node tools/scripts/check-skips.mjs` 以 0 退出；`node --test tests/unit/check-skips.test.mjs` 全绿。`→ 原则 III, contracts/verification-and-benchmark §3/§7`
- [ ] T144 主干可构建 / 可运行 / 可回退（FR-025）：在干净检出上 `npm ci && npm run build && node --test tests/unit` 通过； 回退演练（切到上一提交后仍可构建与运行）记录到 `docs/reproducible-build.md` 的"可回退"小节。`自检`：上述命令以 0 退出且文档小节存在。`→ FR-025, 原则 V`
- [ ] T145 文档与清单一致性核对：`docs/**` 中引用的文件路径与命令均存在（`node tools/scripts/check-doc-links.mjs`）； `tasks.md` 勾选状态与实际产物一致；产物路径与 `.github/workflows/ci.yml` 上传段一致。`自检`：`node tools/scripts/check-doc-links.mjs` 以 0 退出。`→ 原则 V, FR-022`
- [ ] T146 验收映射表 `docs/acceptance-matrix.md`：逐条把 **SC-001…SC-010** 与 **FR-030~FR-033** 映射到 任务 ID + 验证层 + CI 产物路径（无产物路径的判据视为未达成）。`自检`：`node --test tests/unit/acceptance-matrix.test.mjs` （断言 SC-001…SC-010 与 FR-030~FR-033 全部有映射且每条含产物路径）。`→ SC-001…SC-010, FR-030~FR-033`
- [ ] T147 收尾：确认本清单**未**新增 Out of Scope 任务（影像/模型/大气/阴影/后处理/粒子/矢量标注/移动端一律无实现任务， 仅有"显式 `not-implemented` 失败"边界任务）；确认 `specs/001-webgpu-terrain-mvp/analysis.md` **由后续 `/speckit-analyze` 重新生成** （本阶段 MUST NOT 修补旧的 `analysis.md`）。`自检`：`node --test tests/unit/out-of-scope-boundary.test.mjs`（断言任务清单中不存在上述功能的实现任务）。`→ spec「Out of Scope」, plan 阶段 3 说明`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**：无依赖，可立即开始。
- **Phase 2 验证门（G-1…G-6）**：依赖 Phase 1（工具链与骨架）；**阻塞 Phase 3 及之后的一切实现任务**。
  - `G-1 → G-2 → G-4 → G-3 → G-5 → G-6` 按 plan 的实现顺序推进；任一失败 → STOP + 上报入口 Agent 修订 `plan.md`。
  - **G-7（T028–T029）为例外**：plan 明示"G-7 与验证资产并行"；其判定依赖 Phase 9/10 的验证资产与 CI 配方（T108–T126），
    因此 T028/T029 的执行与 Phase 9/10 对应的资产建设**并行**，但结论 **MUST 在 T098（切片 B 翻转）之前落盘**。
- **Phase 3 Foundational（W1）**：依赖 Phase 2 门禁通过；**阻塞 Phase 4 起的全部 user story**。
- **Phase 4–7（US1 = W2 → W3 → W4 → W5）**：严格串行（每一段是下一段的输入）；W4 与 W3 之间仅共享 `manifest.json` 与
  `format-map`/`bind-layout` 的接口，可小范围并行，但**验收顺序不变**。
- **Phase 8（US2 = W6）**：依赖 Phase 4 的 `device-handoff` 与 Phase 3 的 `src/status/**`；与 US1 的 W5 有接口交集（场景构造），
  故建议在 W5 之后立即执行；US2 的契约测试必须在 W5 的地形用例可运行后才有意义。
- **Phase 9（US3 = W7）**：依赖 US1 与 US2 的契约用例存在（参考帧、统计、容差）；`src/verify/**` 可与 US2 并行开发。
- **Phase 10（US4 = W8）**：依赖 US3 的基准采集与容差资产；`gpu:absolute` 需预算批准（默认不执行）。
- **Phase 11（US5 = W9）**：文档与评估契约测试可在 US1–US4 期间并行起草，但**结论文档 MUST 在对应阶段完成后定稿**。
- **Phase 12 Polish**：依赖全部前序阶段；T141（SC-010 终局证明）依赖 Phase 3 与 Phase 10 的产物。

### User Story Dependencies

- **US1（P1）**：无跨 story 依赖；是 MVP 主体（W2–W5）。
- **US2（P1）**：与 US1 同级；依赖 US1 的 `device-handoff` 与场景构造接口（共享文件），**兜底路径本身 MUST 有独立测试覆盖**。
- **US3（P2）**：依赖 US1/US2 的可运行场景（用于产出参考帧与统计基线）。
- **US4（P2）**：依赖 US3（复用 harness、容差与统计）。
- **US5（P2）**：评估结论的 CI 契约测试与 `actualsBackfill` 机制可与实现并行；文档定稿在最后。

### Within Each Phase（铁律）

- 门禁未通过不得进入其门控的实现任务。
- 每个渲染特性任务之后**紧邻**其验证任务（本清单已按此成对排列）；验证层 MUST 在任务中标注。
- 契约/视觉/基准类验证 MUST 为两次独立运行（独立进程 + 独立页面加载），跨后端比较 MUST 离线。
- 证据**只认 CI 产物**（原则 V）：本地通过不等于通过。

---

## Parallel Opportunities

- **Phase 1**：T002、T005、T006、T007、T011、T012、T013 之间无文件交集，可并行（T003→T004 串行；T001→T009→T010 因共享 `package.json` 串行）。
- **Phase 2**：G-1/G-2 与 G-4/G-3 之间在**不同 `experiments/gates/<id>/` 目录**内，可两两并行；G-5/G-6 依赖尖刺 harness，可与 G-3/G-4 并行；G-7 与 Phase 9/10 并行。
- **Phase 3**：T037/T038/T039/T040 相互独立可并行（T031→T032→T033→T036 串行）。
- **Phase 5**：T055/T056/T059/T060 可并行（不同资源类文件）；T057/T059 与 T061/T062 串行。
- **Phase 6**：T066/T068 可并行；T069→T070→T074→T073 串行；T075/T076/T077 可并行（不同文件，但都依赖 T073 的内部接口）。
- **Phase 7**：T084→T085 串行；T086–T090 可并行（不同文件）；T092/T093/T094 可并行（不同 spec 文件，但**不得同时运行**——串行执行以免违反"每次只启用一条路径"）。
- **Phase 9/10**：`tests/support/**` 与 `tools/**` 的任务可并行；CI 相关任务在 `.github/workflows/ci.yml` 单文件上**串行**修改。
- **Phase 11**：T131–T135 文档任务可并行；T128/T129/T130 相互独立可并行。
- **Phase 12**：T140–T143 可并行；T139/T144/T145/T146/T147 串行收尾。

> ⚠️ **并行不得破坏二选一语义**：任何两条验证任务即使并行开发，其**执行**也 MUST 分属独立进程/独立页面加载，
> MUST NOT 在同一会话内并发渲染同一场景。

### Parallel Example: Phase 5（W3 资源层）

```bash
# 可并行的三个资源类实现任务（不同文件、无相互依赖）：
node --test tests/unit/buffer-mapping.test.mjs      # T055
node --test tests/unit/texture-mapping.test.mjs     # T056
node --test tests/unit/vertex-array-mapping.test.mjs # T060
```

### Parallel Example: 双路径验证（串行执行、分别采集）

```bash
# 正确：两次独立运行，各自独立进程 + 独立页面加载
node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain-ready
node tests/support/backend-runner.mjs --backend=webgl2 --suite=contract:terrain-ready
# 之后才是离线比较（绝不并发渲染同一场景）
node tests/support/compare-offline.mjs --artifact=artifacts/cross-equivalence
```

---

## Implementation Strategy

### MVP First（US1 / W2–W5）

1. 完成 Phase 1（骨架）→ Phase 2（门禁 G-1…G-6）→ Phase 3（W1 补丁层工程化）。
2. 依次完成 Phase 4（W2 后端核心）→ Phase 5（W3 资源层）→ Phase 6（W4 着色器前端）→ Phase 7（W5 地形端到端 + 切片 B 翻转）。
3. **STOP and VALIDATE**：US1 的 Independent Test 在两条路径**两次独立运行**下各自通过；CLI/演示页可演示地形。
4. 此时 MVP 的"地形在新后端跑通"已达成；US2 完成后 SC-003 才闭环。

### Incremental Delivery

1. Phase 3 结束 → 补丁边界与升级演练可审计（可独立评审）。
2. Phase 4 结束 → WebGPU 后端可接管场景构造与命令提交。
3. Phase 7 结束 → 地形端到端通过（MVP 核心）。
4. Phase 8 结束 → 二选一与整体兜底闭环（SC-003）。
5. Phase 9/10 结束 → CI 成为唯一事实来源（SC-005/SC-006/SC-009）。
6. Phase 11 结束 → 开源交付与评估结论齐备（SC-007/SC-008）。

### 单子代理执行粒度

每个任务 MUST 能由**一个子代理在一轮内完成并自检**：产出文件明确、自检命令可执行、完成判据可机器判定。
任务之间 MUST NOT 共享"半成品文件"；跨任务共享的接口（`manifest.json`、`format-map`、`bind-layout`、
`WgslEmission.emit`）MUST 在其任务内先定稿再被下游任务消费。

---

## Notes

- `[P]` 仅表示"不同文件、无未完成依赖"，**不**表示可以违反二选一语义或跳过硬性顺序（门禁 → Foundational → US1…）。
- 本清单中**不存在**任何"仅凭肉眼确认"的任务；每个渲染特性都有 `层=单元/契约/视觉/基准/架构边界` 的自动化验证与之成对。
- 门禁失败的唯一合法动作是：**STOP + 上报入口 Agent 修订 `plan.md`**（阶段子代理 MUST NOT 自行改 `plan.md`/`contracts/**`/`spec.md`）。
- 三条未测风险已作为门禁或专门任务覆盖：**H-6 变体规模与编译缓存**（G-6 / T025 / T079）、
  **H-7 精度差异与纹理 Y 翻转**（G-6 / T026 / T058）、**H-10 上游内部接口无公开契约**（W1 的接口一致性清单 T035 + 升级演练 T036 + `docs/rebase-runbook.md` T133，三件套）。
- 着色器范围：本增量**只**覆盖地形着色器闭包；全库 319 个 `.glsl` / 244 个 `czm_` 内建的转译（2–4 人月外推）**明确不计入本增量**（T082）。
- 切片 B 的 `depthTexture=true` 翻转（T098）是**阻断项**：未完成不得宣告 FR-030 达成。
- 评估交付（FR-026~FR-029 / SC-007）在本清单中只做**契约测试 + 回填机制 + 版本化机制**（T128–T130），**不重新撰写评估**。
- `analysis.md` 不在本阶段产物内：它由后续 `/speckit-analyze` 依据本清单重新生成（T147）。
