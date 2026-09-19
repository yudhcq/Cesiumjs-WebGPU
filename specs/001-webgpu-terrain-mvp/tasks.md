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
`Setup → 实现前的验证门（G-1 → G-2 → G-4 → G-3 → G-5 → G-6，G-7 并行且结论在 Phase 10 落盘）→ Foundational(W1) → [US1] W2 → [US1] W3 → [US1] W4 → [US1] W5（含切片 B 功能翻转 T098a）→ [US2] W6 → [US3] W7 → [US4] W8（含切片 B 全量验证闭环 T098b）→ [US5] W9 → Polish`。
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
   **标注规则（可机器核验）**：任务正文出现"两路径 / 两条后端…串行 / 分别运行 / 跨后端离线比较"者 **MUST** 标注；
   仅运行单一后端、且不涉及另一条后端比较的任务 **MUST NOT** 标注。
3. **补丁边界（原则 I）**：一切对上游的改动 MUST 落在 `Source/Renderer/**`；替换清单一律经
   `packages/cesium-webgpu/backend-webgpu/manifest.json` 登记（`requirementRef` + `reason` + `kind` + `glCallSites`），
   由 `node tools/audit-patch-scope.mjs` 机器审计。`Scene` / `Globe` / `QuadtreePrimitive` / `Camera` / 图层 / `DrawCommand`
   的代码与语义**一行不改**（SC-010）。
4. **环境事实（写入任务备注，避免踩坑）**：本机 Node **v22.20.0** / npm **10.9.3**；npm 直连通常可用，
   失败时用代理 `http://127.0.0.1:7890`（仅记入 `.env.example`，**不得**写入公开 README）；
   无头 Chrome **153** 零启动开关即可取得硬件 WebGPU 适配器（`vendor:"nvidia"`, `architecture:"lovelace"`）→ 真机验证的算力成本为 0；
   CI 工具链 = `glslang 16.6.0` **官方 Linux 预编译包** + `cargo install naga-cli --version 30.0.1 --locked`（`--locked` 只锁依赖图，版本 MUST 由 `--version 30.0.1` 显式锁定）
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
- **`--suite=` → 文件映射**（自检可执行性：任何 `--suite=X` MUST 在本表有条目）：
  `contract-backend-core`→`tests/contract/backend-core.spec.mjs`；
  `smoke:scene-construct`→`tests/contract/smoke-scene-construct.spec.mjs`；`smoke:draw-dispatch`→`tests/contract/smoke-draw-dispatch.spec.mjs`；`smoke:present`→`tests/contract/smoke-present.spec.mjs`；
  `contract:pass-sequence`→`tests/contract/pass-sequence.spec.mjs`；`contract:resources`→`tests/contract/resources.spec.mjs`；
  `contract:terrain`→`tests/contract/terrain.spec.mjs`；`contract:terrain-ready`→`tests/contract/terrain-ready.spec.mjs`；`contract:terrain-offline`→`tests/contract/terrain-offline.spec.mjs`；`contract:terrain-unavailable`→`tests/contract/terrain-unavailable.spec.mjs`；
  `contract:interaction`→`tests/contract/interaction.spec.mjs`；`contract:device-lost`→`tests/contract/device-lost.spec.mjs`；`contract:device-lost-terrain`→`tests/contract/device-lost-terrain.spec.mjs`；
  `contract:fallback`→`tests/contract/fallback.spec.mjs`；`contract:handle`→`tests/contract/handle.spec.mjs`；`contract:status`→`tests/contract/status.spec.mjs`；`contract:whole-switch`→`tests/contract/whole-switch.spec.mjs`；
  `contract:cross-equivalence`→`tests/contract/cross-equivalence.spec.mjs`；`contract:demo`→`tests/contract/demo.spec.mjs`；`contract:offscreen-depth`→`tests/contract/offscreen-depth.spec.mjs`；
  `visual:terrain`→`tests/visual/terrain-multitile.spec.mjs`；`visual:terrain-geometry`→`tests/visual/terrain-geometry.spec.mjs`；`visual:terrain-elevation`→`tests/visual/terrain-elevation.spec.mjs`；`visual:texture-origin`→`tests/visual/texture-origin.spec.mjs`；
  `bench:terrain`→`tests/benchmark/terrain.spec.mjs`；`bench:shader-variants`→`tests/benchmark/shader-variants.spec.mjs`；`stability:leak`→`tests/benchmark/stability-leak.spec.mjs`。
  新增 `--suite=` 时 MUST 同时补本表；映射完整性由 T145 的 `check-doc-links.mjs` 校验。

---

## Phase 1: Setup（工程骨架与工具链；不含任何渲染实现）

**Purpose**: 建立可构建、可测试、可复现的多包骨架、构建链与**共享验证脚手架**。
**Goal**: `npm run build` + `node --test "tests/unit/**/*.test.mjs"` 在本机（Node 22）通过，且补丁边界/可移植性/公开 API 面均有可执行断言。
**Independent Test**: `node tools/scripts/run.mjs build` 与 `node --test "tests/unit/**/*.test.mjs"` 全绿；
`node tools/scripts/check-tools-portable.mjs` 以 0 退出。

- [X] T001 创建 npm workspaces 根骨架与忽略规则：`package.json`（`private:true`、`workspaces:["packages/*","apps/*"]`、`engines.node>=22`、`type:"module"`、scripts 占位）与 `.gitignore`（`node_modules/`、`dist/`、`artifacts/`、`experiments/gates/out/`、`.specify/feature.json`）。`自检`：`node --test "tests/unit/**/*.test.mjs"/repo-layout.test.mjs`（断言 workspaces/engines/type 字段与忽略项齐备）。`→ plan「Project Structure」`
- [X] T002 [P] 建立 TypeScript `strict` 基线：`tsconfig.base.json`（`strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、target/module 适配 Node 22 + ESM）与 `packages/cesium-webgpu/tsconfig.json`、`apps/demo/tsconfig.json` 两份继承配置。`自检`：`node --test "tests/unit/**/*.test.mjs"/tsconfig-baseline.test.mjs`（**不依赖已安装 tsc**，直接读取 JSON 断言三个严格开关与 `extends` 指向）。`→ constitution 附加技术约束（TS strict）`
- [X] T003 上游钉版与基线记录：`packages/cesium-webgpu/package.json` 声明 `@cesium/engine` **精确 `26.3.0`**（MUST NOT 用 `^`/`~`）与 `upstream/engine-26.3.0.lock.json`（`packageName`/`version`/`cesiumVersion:"1.145.0"`/`integrity`/`license:"Apache-2.0"`/`recordedAt`/`notes` + **`toolchain` 段**：`glslang 16.6.0`、`naga-cli 30.0.1`、`@webgpu/glslang 0.0.15（dist/web-devel-onefile）`）。`自检`：`npm ci` 成功后 `node --test "tests/unit/**/*.test.mjs"/upstream-baseline.test.mjs`（断言安装版本 === 26.3.0、integrity 与 lock 一致、无版本范围符、toolchain 三版本齐备）。`→ FR-032, data-model §1.1, contracts/fork-patch-layer §1`
- [X] T004 安装并锁定构建/测试依赖：根 `devDependencies` 精确版本（`rollup`、`@rollup/plugin-typescript`、`@rollup/plugin-node-resolve`、`rollup-plugin-dts`、`typescript`、`@webgpu/types`、`playwright`、`yaml`）并生成 `package-lock.json`。`自检`（**不标 [P]**：与 T003 共享 npm install）：`node --test "tests/unit/**/*.test.mjs"/deps-locked.test.mjs`（断言全部 devDependencies 无 `^`/`~`、`playwright` 与 `yaml` 版本为精确固定值、lock 中 `@cesium/engine` 解析为 26.3.0）。选型理由：CI 工作流断言（T039/T118/T120/T126）需要可靠的 YAML 解析；自实现最小 YAML 子集对 GitHub Actions 的块/流式/多行标量不稳健，而 `yaml` 为 ISC 许可、零传递依赖，满足许可证门禁（T040）。`→ FR-024, contracts/verification-and-benchmark §3`
- [X] T005 [P] 自维护上游内部模块类型声明 `packages/cesium-webgpu/types/engine-internal.d.ts`：只声明本项目真正消费的上游内部符号（`Renderer/Context` 的**约 30 个成员**、资源类工厂/构造面约 20 个、`ContextLimits` 10 个成员、`RenderState` 选项形状、`ShaderProgram` 读取面**含 `_attributeLocations`**）。`自检`：`node --test "tests/unit/**/*.test.mjs"/engine-internal-types.test.mjs`（对 research §1.3 的消费面清单逐项断言"声明存在"，缺失即失败）；`npx tsc -p packages/cesium-webgpu/tsconfig.json --noEmit`。`→ research §2.5, plan Complexity Tracking`
- [X] T006 [P] 实现架构边界扫描器 `tools/scripts/check-arch-boundaries.mjs`（零依赖，实现 data-model §11 的 **A1–A11** 规则；支持 `--rules A1,A7`；输出 `artifacts/arch-boundaries.json`；**无命中时以 0 退出并打印 `no match`**，命中以 1 退出；扫描路径不存在 MUST 以非 0 退出）。`自检`：`node --test "tests/unit/**/*.test.mjs"/check-arch-boundaries.test.mjs`（正例/反例/"路径不存在"三类用例）。`→ SC-010, data-model §11, FR-007`
- [X] T007 [P] 工具可移植性检查 `tools/scripts/check-tools-portable.mjs`：扫描 `tools/**`、`.github/**`、`package.json` 的 scripts，断言不出现 `pwsh`/`powershell`/`2>$null`/`Get-ChildItem`/`grep -` 等专有语法与 Windows 绝对路径（`[A-Za-z]:\\`）。`自检`：`node --test "tests/unit/**/*.test.mjs"/check-tools-portable.test.mjs`；`node tools/scripts/check-tools-portable.mjs` 以 0 退出。`→ 全局约定 1（CI 目标 Linux + bash）`
- [X] T008 实现别名插件 `tools/rollup-plugin-engine-patch.mjs`：在 `resolveId` 中按**解析后的绝对路径**把 `<node_modules>/@cesium/engine/Source/Renderer/<X>.js` 改写为 `backend-webgpu/Renderer/<X>.…`（当且仅当 `<X>.js` 在清单内），并导出**白名单穷举**模式 `whitelistExhaustiveCheck(sourceFiles)`。`自检`：`node --test "tests/unit/**/*.test.mjs"/rollup-plugin-engine-patch.test.mjs`（覆盖"清单为空 → 零改写""被改写集合 == 清单集合（无遗漏、无额外）""对 `index.js` 再导出与包内相对导入同样生效"）。`→ contracts/fork-patch-layer §3, H-1`
- [X] T009 建立 Rollup 多入口构建 `rollup.config.mjs` 与包 `exports`：入口 `packages/cesium-webgpu/src/index.ts`、可选 `packages/cesium-webgpu/src/escape-hatch.ts`（**MUST NOT** 被主入口 re-export）、`apps/demo`；产出 ESM + `.d.ts`（`rollup-plugin-dts`）。`自检`（依赖 T002/T008）：`node tools/scripts/run.mjs build` 成功；`node tools/scripts/check-arch-boundaries.mjs --rules A1` 以 0 退出（`dist/index.d.ts` 不含 `GPU[A-Z]`/`WebGL`/`backend-webgpu`）。`→ contracts/render-path-api §1, 原则 II`
- [X] T010 统一脚本编排与静态服务：`tools/scripts/run.mjs`（统一入口）+ 根 `package.json` scripts（`build`/`typecheck`/`lint`/`test:unit`/`test:contract`/`test:visual`/`bench`/`demo`/`ci:local`）+ `tools/scripts/serve.mjs`（零依赖静态服务，供演示与 Playwright 使用）+ `.env.example`（代理等本机配置）。`自检`（**不标 [P]**：与 T001/T009 共享 `package.json`，串行）：`node --test "tests/unit/**/*.test.mjs"/scripts-map.test.mjs`；`node tools/scripts/run.mjs test:unit` 在无测试时打印 `no tests yet` 且以 0 退出。`→ quickstart §2/§3, 全局约定 1`
- [X] T011 [P] 演示页骨架 `apps/demo/index.html` + `apps/demo/src/main.ts`：**只 import 包入口**，含状态区/署名区/进度区容器与"模拟设备丢失"入口占位。`自检`：`node --test "tests/unit/**/*.test.mjs"/demo-no-branch.test.mjs`（A5：演示页源码 MUST NOT 出现 `preference ===` / `=== "webgpu"` / `=== "webgl2"`）。`→ FR-007, contracts/render-path-api §5 C-5`
- [X] T012 [P] 包入口与公开类型骨架：`packages/cesium-webgpu/src/index.ts` + `packages/cesium-webgpu/src/api/types.ts`（`BackendKind`、`TerrainSceneOptions`、`TerrainSceneHandle`、`RenderPathStatus`、`DiagnosticError`，逐字段对齐 [contracts/render-path-api.md](./contracts/render-path-api.md) §1 与 data-model §2.2/§2.5）。`自检`：`node --test "tests/unit/**/*.test.mjs"/public-api-surface.test.mjs`（断言导出面恰好为契约所列符号，**不含任何后端/GPU 类型**）。`→ FR-007, data-model §11 A1`
- [X] T013 [P] 共享验证脚手架（最小版；**增量边界**：本任务只定稿 API 面与最小实现，`tests/support/backend-runner.mjs` 的产品化归 T108、`src/verify/**` 的完整资产包归 T109，二者 MUST NOT 重写已定稿接口）：`tests/support/backend-runner.mjs`（**独立进程 + 独立页面加载**，`--backend=webgpu|webgl2`；API 表面**不存在**任何"同会话双路径/同帧对比/叠加"入口）与 `packages/cesium-webgpu/src/verify/stats.mjs`（`FrameStatistics` 计算：`nonBackgroundRatio`/`uniqueColorCount`/`depthDiscontinuityRatio`/`triangleCount`/`drawCallCount`/`tileCount`/`frameTimeMs{p50,p95}`）。`自检`：`node --test "tests/unit/**/*.test.mjs"/backend-runner-surface.test.mjs`（断言不存在同帧对比入口；对合成图像的统计值做已知值断言）。`→ FR-011, 原则 II, contracts/verification-and-benchmark §2`

**Checkpoint（Setup）**：`node tools/scripts/run.mjs build`、`node --test "tests/unit/**/*.test.mjs"`、`node tools/scripts/check-tools-portable.mjs` 三者全绿。

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
> 故 G-7 的任务（T028–T029）须与 Phase 9/10 的验证资产与 CI 配方（T108–T126）并行推进。
> **顺序（真实可满足）**：G-7 结论在 **T127**（Phase 10）落盘，其**唯一消费点**是 **T098b**（切片 B 全量验证，紧随 T127 之后）；
> 切片 B 的**功能翻转**是 **T098a**（Phase 7），只依赖本阶段已有的单元/契约套件，**既不依赖 G-7、也不依赖 Phase 9/10 的验证资产**。
> T098a + T098b 共同构成切片 B 阻断项；**MUST NOT** 用"以某任务优先"式兜底文字掩盖不可满足的依赖。
>
> ℹ️ **门禁原型代码一律放 `experiments/gates/**`**，**MUST NOT** 进入 `packages/**`、不参与 Rollup 主包构建；
> 门禁只回答"假设是否成立"，其结论是 Phase 3+ 实现任务的输入。

- [X] T014 建立门禁产物规范与判定器：`tools/scripts/check-gate.mjs`（校验 `experiments/gates/out/<G-id>.json` 存在且含 `verdict`/`evidence`/`recordedAt`/`notes`，支持 `--all` 与 `--gate g5`）+ `experiments/gates/README.md`（门禁产物字段规范与"结论不得只写结论、必须附证据路径"的要求）。`自检`：`node --test "tests/unit/**/*.test.mjs"/check-gate.test.mjs`（缺文件/缺字段/verdict=fail 三类反例必须非 0 退出）。`→ plan「实现前的验证门」, 原则 V`

### G-1 接缝可替换性（H-1）

- [X] T015 G-1 门禁执行（**私有成员限定**：`scene._context` 仅用于本门禁断言，MUST NOT 进入实现路径）：在 `experiments/gates/g1-alias/` 内用 T008 的别名插件在**真实构建链**中替换 `Renderer/Context.js`（桩实现），由 Playwright 打开页面构造上游 `Scene`，断言 (a) `scene._context` 由本仓库实现提供、(b) `Scene.js` 对 `Context.js` 的**相对导入**被正确改写、(c) 白名单穷举测试通过；产出 `experiments/gates/out/g1.json` 与 `docs/gate-g1-conclusion.md`（含依据、证据路径、pass/fail）。`自检`：`node experiments/gates/g1-alias/run.mjs` 以 0 退出并写出 `g1.json`；`node tools/scripts/check-gate.mjs --gate g1` 以 0 退出。`→ H-1, FR-032, contracts/fork-patch-layer §3` **（失败动作：切换整仓 fork F1，补丁清单与审计方式不变 → STOP 上报入口 Agent 修订 plan）**
  > **执行结论（2026-09-19）**：**verdict = pass（25/25 检查项）**，无需触发失败动作。证据：`experiments/gates/out/g1.json`、
  > `experiments/gates/out/g1-build.json`、`experiments/gates/out/g1-runtime.json`、`docs/gate-g1-conclusion.md`。
  > 阴性对照 `run.mjs --control=no-rewrite` 5/5 检出"未替换"。**实现发现 F-1（须 W1 处理）**：上游 `Source/**` 依赖
  > `mersenne-twister`/`urijs`/`grapheme-splitter`/`protobufjs` 等 **CommonJS-only** 包，而 T004 的依赖集无 CJS 互操作插件 →
  > T009 的 `dist`（内嵌经替换的上游源码）需等价能力（引入 `@rollup/plugin-commonjs` 或等价方案），属对 T004 依赖集的增量决策。
  > 偏离 D-1（门禁清单 vs T031 正式清单）、D-2（无 TS 插件）、D-3（桩以 WebGL2 承载上下文获取）见结论文档 §5。

### G-2 设备交接与同步构造（H-2）

- [x] T016 G-2 门禁执行：在 `experiments/gates/g2-handoff/` 内实现"预取 `adapter/device` → 写入后端层交接槽 → **同步**构造上游 `Scene`（桩 Context 从槽中取设备）"，断言 (a) 两种后端下都能构造场景、(b) `ContextLimits` 与能力标志在 `Scene` **构造期同步可读**、(c) 记录被触发的逻辑层分支并与 research §4 表逐项一致（不一致即 fail）；产出 `experiments/gates/out/g2.json`（含被触发分支清单）与 `docs/gate-g2-conclusion.md`。`自检`：`node experiments/gates/g2-handoff/run.mjs` 以 0 退出；`node tools/scripts/check-gate.mjs --gate g2` 以 0 退出。`→ H-2, research §3/§4, FR-005` **（失败动作：按 research §4 逐项修正能力表并补测试；某标志无法诚实回答则降为 `false` 并登记 → STOP 上报入口 Agent 修订 plan）**
- [x] T017 G-2 能力映射一致性验证（`层=单元`；**私有成员限定**：引用 `@private` 语义仅用于断言，MUST NOT 进入实现路径）：`tests/unit/capability-mapping.test.mjs` —— 对 research §4 的每个能力标志与 `ContextLimits` 成员断言"采用值来源"（如 `maximumTextureSize ← adapter.limits.maxTextureDimension2D`）、`maximumSamples >= 4`、**任何 `false` 能力 MUST 有对应的"未实现"分支与 `notes` 记录**（MUST NOT 虚报 `true`）。`自检`：`node --test "tests/unit/**/*.test.mjs"/capability-mapping.test.mjs` 全绿。`→ H-2, data-model §3.1/§3.2, FR-030` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**

### G-4 uniform 布局一致性（H-4）

- [x] T018 G-4 门禁执行（生成器原型）：`experiments/gates/g4-uniform-layout/` 内从"**拼装后的真实 GLSL** 实际引用的 uniform 名集合"生成 WGSL `struct` 与 CPU 侧布局表（含 `mat3` 列填充、数组元素 16 字节对齐、`vec3`→16 字节对齐、`size 9` 的 `czm_sphericalHarmonicCoefficients`），并对地形着色器全部 uniform（**G-4 实测更正**：上游 `Renderer/AutomaticUniforms.js` 实测 **93** 条自动 uniform；尖刺实测"拼装后 VS+FS 文本的 `^uniform` 声明数"为 **92**（`experiments/shader-spike/REPORT.md:74`，`default-3d` 配置，**与 93 不是同一量**）；默认配置**实际参与者 = 52 个数值 uniform + 2 个 sampler**。三者分列，原文的"92 个声明"MUST NOT 再被当作自动 uniform 条目数使用）产出逐字段偏移表；产出 `experiments/gates/out/g4.json`（含 `measurements.automaticUniformCount=93`）。`自检`：`node experiments/gates/g4-uniform-layout/run.mjs` 以 0 退出并写出 `g4.json`（含逐字段 `byteOffset`/`byteSize`/`arrayStride`）。`→ H-4, research §5.4, data-model §4.3` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**
- [x] T019 G-4 门禁验证（`层=单元` + 真机像素断言）：(a) 单元交叉校验"生成布局 ↔ WGSL 结构逐字段一致"；(b) 复用尖刺真机 harness 手法（identity 矩阵 + 已知纹素回读）断言**地形全部 uniform 生效**；产出 `docs/gate-g4-conclusion.md`。`自检`：`node --test experiments/gates/g4-uniform-layout/layout.test.mjs` 全绿 + `node experiments/gates/g4-uniform-layout/run-gpu.mjs` 以 0 退出。`→ H-4, contracts/verification-and-benchmark §4（SH-2 前置）` **（失败动作：退化为"每标量一个 vec4 槽"的保守布局 → STOP 上报入口 Agent 修订 plan；注：该保守布局自 W2 决策 **R-1** 起改为**默认采用**，见 `plan.md` Complexity Tracking 的 R-1 行与承接任务 **T149**）**
- [ ] T149（**追加编号**；承接 W2 决策 **R-1**，勿重排既有 ID）G-4 布局结论的**逐目标实现重跑义务**：布局正确性 MUST NOT 依赖"本机实现恰好宽松"——在**每个目标实现（浏览器版本 / 驱动 / Tint 版本）**上重跑并断言结论仍成立：`node experiments/gates/g4-uniform-layout/run.mjs`（生成 + 单元交叉校验 + 判定）、`node experiments/gates/g4-uniform-layout/run-gpu.mjs`（真机逐字段回读）、`node tools/scripts/check-gate.mjs --gate g4` 三者均以 0 退出；每次重跑 MUST 记录 **T121 定义的环境指纹 `EnvironmentFingerprint`（data-model §8.1）** 并归档到 `artifacts/`（含目标实现清单）。**背景**：`experiments/gates/out/g4.json → packed-scalar-arrays-declared` 标注 `portabilityRisk=true`（Chrome 153/Tint 对 `array<f32,N>` 采用 **4** 字节 stride，4 处命中）。**已定决策（保守/合规布局）**：布局生成器对**数组成员 step 向 16 取整**（16 既是 4 的倍数、也是 WGSL 合规值 → 在宽松实现与合规实现上都成立；等价于 G-4 失败动作里的"每标量一个 vec4 槽"手法提前采用），**CPU 侧写入器与 WGSL 结构体由同一生成器产出**以保证两侧逐字段一致；任一目标实现上重跑失败即按该保守布局收敛并**重新派发 G-4**。**关键顺序约束**：该保守布局是 G-4 生成器的**输出变更**（标量数组由 4 字节步长改为 16 字节步长），故 MUST 先以保守布局**重跑 G-4**（本机目标实现优先）再逐个其它目标实现重跑；在保守布局重跑通过之前，MUST NOT 引用 `docs/gate-g4-conclusion.md` 现有的 `pass`（其值为 4 字节步长下的结论）作为"保守布局已通过真机验证"的证据——该旧结论的**算法部分**（`layout.test.mjs` 的逐字段交叉校验方式、真机回读手法、阴性对照）仍然有效并被复用。`自检`（**不标 [P]**：真机门禁 + 环境相关）：上述三条命令在当前目标实现上以 0 退出且 `g4.json` 的 `verdict === "pass"`；`layout.test.mjs` 全绿（WGSL 结构与 CPU 表逐字段一致）；重跑记录（环境指纹 + 目标实现清单 + 逐字段表差异）落盘。`→ H-4, plan Complexity Tracking（R-1）, docs/gate-g4-conclusion.md §5/§6.4, contracts/verification-and-benchmark §4` **（失败动作：按 `plan.md` Complexity Tracking 的 R-1 行收敛为保守布局并重新派发 G-4；环境/目标实现的证伪 MUST NOT 被当作可忽略差异 → STOP 上报入口 Agent）**

### G-3 通道状态机正确性（H-3）

- [x] T020 G-3 门禁执行（录制）：`experiments/gates/g3-pass-trace/` 内录制上游**原版 WebGL2** 在一次完整帧中的 `clear`/`draw` 与目标切换序列——通过**包装平台 API**（`WebGL2RenderingContext.prototype.bindFramebuffer/drawElements/drawArrays/viewport/scissor` 等）采集，**MUST NOT** 修改上游实现、MUST NOT 依赖 `@private` 语义改写；产出 `experiments/gates/out/g3-trace.json`（序列号、目标 id、viewport、scissor、拓扑、count）。`自检`：`node experiments/gates/g3-pass-trace/run.mjs` 以 0 退出并写出 trace（含 `resolveFramebuffers` 引起的目标切换）。`→ H-3, research §1.5/§5.2` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**
- [x] T021 G-3 门禁判定（覆盖校验）：把 T020 的录制序列按派生式通道身份 `(colorTargets, depthStencilTarget, sampleCount, viewport, scissorRect)` 分区，断言 (a) **全部目标切换序列都被覆盖**（含多采样解析的目标切换）、(b) 分区边界与 `clear`/`draw` 序列一一对应、(c) `endFrame` 前无未闭合通道；产出 `experiments/gates/out/g3.json` 与 `docs/gate-g3-conclusion.md`。`自检`：`node --test experiments/gates/g3-pass-trace/partition.test.mjs` 全绿；`node tools/scripts/check-gate.mjs --gate g3` 以 0 退出。`→ H-3, data-model §4.1/§10③, FR-030` **（失败动作：在后端层内部引入显式通道提示（不改逻辑层），或在 `endFrame` 前强制拆通道 → STOP 上报入口 Agent 修订 plan）**

### G-5 着色器编译前端（H-5）

- [x] T022 G-5 门禁执行（真机管线校验 harness 产品化）：把尖刺的 `experiments/shader-spike/scripts/webgpu-harness.mjs` 与黄金样本 `experiments/shader-spike/port/globe-vs.wgsl`(181 行)、`globe-fs.wgsl`(151 行) 产品化为 `tools/shader-verify.mjs`（`--family=globe --variants=mvp`：真机 `createRenderPipeline` + 回读断言；本机无头 Chrome 153 零开关即得硬件适配器）；产物 `artifacts/shader-verify/globe-mvp.json`。`自检`：`node tools/shader-verify.mjs --family=globe --variants=mvp` 以 0 退出（0 validation error、回读非黑像素占满）。`→ H-5, research §6.3, 尖刺 §4` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**
- [x] T023 G-5 门禁判定（地形全部可达 define 组合）：枚举地形路径**可达的 define 组合**（`TEXTURE_UNITS` × `GlobeSurfaceShaderSet` 的 38 个 boolean 门控 × 场景模式中 MVP 实际可达子集），对每个组合跑真机 `createRenderPipeline`，断言 (a) 0 validation error、(b) **varying 集合 VS/FS 成对匹配**（尖刺 E1 实测：不匹配即硬失败 `fragment input at location N doesn't have a corresponding vertex output`）、(c) 未覆盖组合 MUST 显式失败而非静默降级；产出 `experiments/gates/out/g5.json` 与 `docs/gate-g5-conclusion.md`。`自检`：`node tools/shader-verify.mjs --family=globe --variants=all-reachable --report experiments/gates/out/g5.json` 以 0 退出；`node tools/scripts/check-gate.mjs --gate g5` 以 0 退出。`→ H-5/H-6, contracts/verification-and-benchmark §4（SH-2）` **（失败动作：启用尖刺 §7.5 退路三（WGSL 库与上游 `.glsl` 并存、只做"选哪一份"）并把可升级性损失写入 rebase 演练 → STOP 上报入口 Agent 修订 plan）**
- [x] T024 G-5 视图不变性门禁（`层=架构边界`）：`node tools/scripts/check-arch-boundaries.mjs --rules A9` —— 断言逻辑层读取的 `shaderProgram.vertexShaderSource`/`fragmentShaderSource` 仍为**原始 GLSL**（`Scene/Primitive.js:849,1011-1020` 的正则探测仍能命中）、`_attributeLocations` 存在且与 `attributeLocations` 一致。`自检`：`node tools/scripts/check-arch-boundaries.mjs --rules A9` 以 0 退出（在尖刺产物上先跑一次作为基线）。`→ H-5, contracts/fork-patch-layer R2, data-model §11 A9` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**

### G-6 变体规模与像素一致性（H-6 / H-7）

- [x] T025 G-6 门禁执行（H-6 变体规模与编译缓存）：在真机 harness 上统计**运行时 `ShaderProgram` 实例数与编译耗时直方图**，断言落在**测量前预先落盘**的预算内（预算 MUST 先写入 `experiments/gates/g6-variants/budget.json`，来源：`mvp-estimate.md` §5 待确认项 1 的 +1–3 工作日与编译耗时预算；判定脚本读取该文件，**MUST NOT 由本次测量结果反推阈值**）；产出 `experiments/gates/out/g6-variants.json`。`自检`：`experiments/gates/g6-variants/budget.json` 存在且 `recordedAt` 早于 `g6-variants.json`；`node experiments/gates/g6-variants/run.mjs` 以 0 退出并写出直方图；超预算时以非 0 退出。`→ H-6, 尖刺 §7.4（未测项）, mvp-estimate §5 待确认项 1` **（失败动作：收敛 MVP define 子集（只保留地形路径实际可达组合）→ STOP 上报入口 Agent 修订 plan）**
- [x] T026 G-6 门禁执行（H-7 精度差异与纹理 Y 翻转，`层=视觉`）：**分别采集、离线比较** —— (a) 在 WebGPU 路径采集一帧、(b) 在 WebGL2 路径**另一次独立运行**采集同一固定场景帧，离线做像素 diff（排除抗锯齿边缘）+ 地形高程数值比对；(c) 四角纹素回读断言（WebGPU 纹理原点在上，Y 翻转在 `Texture` 映射层统一处理）；产出 `experiments/gates/out/g6-precision.json` + 差异图。〖二选一〗`自检`：`node experiments/gates/g6-precision/run.mjs --backend=webgpu` 与 `--backend=webgl2` 各跑一次（**不得同时**），再 `node experiments/gates/g6-precision/compare.mjs --offscreen` 以 0 退出。`→ H-7, research §6.3, 尖刺 §4/§7.4` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**
- [x] T027 G-6 门禁判定与差异声明：产出 `docs/gate-g6-conclusion.md` —— 变体规模/编译耗时结论、精度差异与 Y 翻转的**逐来源差异量与容差依据**；差异 MUST 按其来源写入 `declaredDifferences`（亚像素边缘、MSAA 解析、sRGB、深度表示、WGSL 无精度修饰符、纹理 Y 翻转处理），**MUST NOT** 放宽为"任意差异均通过"（FR-014）。`自检`：`node tools/scripts/check-gate.mjs --gate g6` 以 0 退出；结论文档中不含"任意差异通过"式表述（`node --test "tests/unit/**/*.test.mjs"/tolerance-source.test.mjs`）。`→ H-6/H-7, FR-014, contracts/verification-and-benchmark §3` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**

### G-7 CI 两路径可运行性（H-8 / H-9）— 并行轨道

- [x] T028 G-7 门禁执行（无 GPU 两套配方实测）：在 Linux + Xvfb 环境实跑两套免费软件适配器配方（WebGPU：Mesa lavapipe + headed Xvfb + 固定标志；WebGL2：ANGLE/SwiftShader），记录每条路径各自的结论与耗时；产出初版 `docs/ci-degradation.md`（含**盲区**：软件光栅化≠GPU、无 GPU 时间戳、lavapipe 报错文本差异、浏览器版本漂移、**"naga WGSL 校验 ≠ WebGPU 管线校验"**，以及**本机真机复现步骤**）。`自检`：`node tools/scripts/check-degradation-doc.mjs`（断言五个盲区条目与本机复现步骤齐备）以 0 退出。`→ H-8, FR-023, contracts/verification-and-benchmark §8` **（未通过则 STOP：由入口 Agent 修订 `plan.md` 后重新派发本门禁；子代理 MUST NOT 自行改 plan）**
- [x] T029 G-7 门禁判定（预算与稳定性）：两次实跑同一提交，断言 (a) 两路径各自独立运行的结论**一致**、(b) 从提交到结论 **≤20 分钟**（含构建、单测、审计、着色器校验、两路径契约/视觉/基准 job）；产出 `experiments/gates/out/g7.json` 与 `docs/gate-g7-conclusion.md`。`自检`：`node tools/scripts/check-gate.mjs --gate g7` 以 0 退出。`→ H-9, SC-005, FR-021` **（失败动作：缩减采样帧数与用例分片，增加本机/自托管真机冒烟作业，绝对性能移交受门控作业 → STOP 上报入口 Agent 修订 plan）**

**Checkpoint（门禁）**：`node tools/scripts/check-gate.mjs --all` 以 0 退出（`g1,g2,g3,g4,g5,g6` 于本阶段结束前必须全 `pass`；`g7` 依 plan 与验证资产并行，其结论在 **T127**（Phase 10）落盘并被 **T098b** 消费——顺序真实可满足，见上文说明）——**此后才允许开始 Phase 3 及之后的实现任务**。

---

## Phase 3: Foundational — W1 后端基线与补丁层工程化（阻塞前置）

**Purpose**: 把"受控 fork 补丁层"从方案变成**可机器审计的工程事实**：替换清单枚举、边界审计、依赖完整性、
接口面清单化、升级演练干跑、许可证与署名合规。
**Goal**: `PatchScopeAudit.verdict === "pass"`、`logicLayerOverrides === 0`、接口清单可生成、升级演练干跑可离线执行。
**Independent Test**: `node tools/audit-patch-scope.mjs && node tools/upgrade-drill.mjs --dry-run && node --test "tests/unit/**/*.test.mjs"` 全部以 0 退出。

**⚠️ CRITICAL**: 本 phase 是 W2–W9 全部 user story 的阻塞前置；未完成不得开始 Phase 4。

- [x] T030 上游完整性校验：`tools/scripts/verify-upstream-integrity.mjs` —— 安装后断言 `@cesium/engine` 版本 === `26.3.0`、 `integrity` 与 `upstream/engine-26.3.0.lock.json` 一致、`Source/**` 目录内容哈希与记录一致（发现 postinstall 篡改即失败）、 并校验工具链段（`glslang 16.6.0` / `naga-cli 30.0.1` / `@webgpu/glslang 0.0.15` 显式 `dist/web-devel-onefile`）。`自检`：`node tools/scripts/verify-upstream-integrity.mjs` 以 0 退出；`node --test "tests/unit/**/*.test.mjs"/upstream-integrity.test.mjs` 全绿（含"篡改一个字节 → 失败"反例）。`→ FR-032, contracts/fork-patch-layer §4（AU-2）, research §2.4`
- [x] T031 建立替换清单 `packages/cesium-webgpu/backend-webgpu/manifest.json`：`baseline` 段 + `entries[]` （**16 个必替换 = 11 个 `kind:"replace"` + 5 个 `kind:"stub-not-implemented"`**（桩归属见 T053）：`Context.js`(46)、`Texture.js`(58)、`ShaderProgram.js`(42)、`Texture3D.js`(37)、`CubeMap.js`(33)、 `CubeMapFace.js`(27)、`RenderState.js`(22)、`Buffer.js`(18)、`createUniform.js`(16)、`createUniformArray.js`(14)、 `VertexArray.js`(10)、`Framebuffer.js`(9)、`Renderbuffer.js`(6)、`TextureAtlas.js`(4)、`MultisampleFramebuffer.js`(3)、`Sync.js`(3) —— 括号内为实测 WebGL 调用点数；其中 **`Texture3D.js`(37)、`CubeMap.js`(33)、`CubeMapFace.js`(27)、`TextureAtlas.js`(4)、`Sync.js`(3) 登记为 `kind:"stub-not-implemented"`**（切片 C 边界，只交付显式失败桩，见 T053），其余 **11 项为 `kind:"replace"`**（`Context`/`Texture`/`ShaderProgram`/`RenderState`/`Buffer`/`createUniform`/`createUniformArray`/`VertexArray`/`Framebuffer`/`Renderbuffer`/`MultisampleFramebuffer`）；`glCallSites>0` 断言仅适用于 `replace` 类，`stub-not-implemented` 类 MUST 有 `reason` 并被 T053 的桩清单覆盖）+ **约 7 个适配项**（`ShaderCache.js`、`ShaderSource.js` `kind:"adapt-shader"`、 `FramebufferManager.js`、`ComputeEngine.js`、`SharedContext.js`、`TextureCache.js`、`loadCubeMap.js`）， 每项 MUST 有非空 `requirementRef`（`FR-030`/`FR-031`/`FR-032`）与 `reason`，`replace` 类 MUST `glCallSites > 0`。`自检`：`node --test "tests/unit/**/*.test.mjs"/patch-manifest.test.mjs`（断言 `^Renderer/[A-Za-z0-9_]+\.js$`、`requirementRef` 非空、`kind ∈ {replace, adapt-shader, stub-not-implemented}`、`replace` 类 `glCallSites>0`、`stub-not-implemented` 类有非空 `reason` 且集合 === T053 的桩清单、16+7 条目齐备；`localFile` **存在性**不在本任务断言——由 T041 在 T037 落地后校验）。`→ FR-030/031/032, data-model §1.2, contracts/fork-patch-layer §2`
- [x] T032 `keptModulesHash` 生成器 `tools/scripts/gen-kept-hash.mjs`：对 `Renderer/**` 中**未列入清单**的 GL-free 模块（31 个）计算内容哈希集合并写回 manifest（发现"上游悄然改动我们仍依赖的文件"）。`自检`：`node --test "tests/unit/**/*.test.mjs"/kept-modules-hash.test.mjs`（断言未列入清单的文件集合与哈希齐备；`ShaderBuilder.js`/`Sampler.js`/`UniformState.js`/`AutomaticUniforms.js`/`DrawCommand.js`/`ClearCommand.js`/`PassState.js`/`Pass.js`/`PixelDatatype.js`/`BufferUsage.js`/`VertexArrayFacade.js` 等必须在"保持不变"集合中）。`→ 原则 I, research §2.2`
- [x] T033 补丁范围审计 `tools/audit-patch-scope.mjs`：输出 `PatchScopeAudit`（`baselineVersion`/`integrityOk`/`manifestPathsValid`/ `aliasWhitelistExhaustive`/`logicLayerOverrides`/`keptModulesUnchanged`/`verdict`，字段与 data-model §1.3 逐字段一致） 到 `artifacts/patch-scope-audit.json`；任一布尔为 false 或 `logicLayerOverrides > 0` 即 `fail` 并以非 0 退出。`自检`：`node --test "tests/unit/**/*.test.mjs"/audit-patch-scope.test.mjs`（含"清单越出 `Renderer/**` → fail""别名多改/漏改 → fail"两个反例）；`node tools/audit-patch-scope.mjs` 在 T031–T033 完成后以 0 退出（T034 是独立的构建产物审计，不参与本任务完成判据）。`→ SC-010, FR-032, contracts/fork-patch-layer §4`
- [x] T034 构建产物审计（逻辑层零覆盖）：把"构建产物中来自本仓库的、`Renderer/**` 之外的模块数 MUST 为 0" 接成构建后钩子（`node tools/scripts/check-build-layer-source.mjs`），断言逻辑层模块来源为 `node_modules/@cesium/engine/Source/**` 原文件。`自检`（**不标 [P]**：依赖 T009 构建配置与 T033 审计）：`node tools/scripts/check-build-layer-source.mjs` 以 0 退出且打印 `logicLayerOverrides: 0`；`node --test "tests/unit/**/*.test.mjs"/build-layer-source.test.mjs` 全绿（含"人为注入一个 `Scene/Scene.js` 覆盖 → 失败"反例）。`→ SC-010, 原则 V, research §2.4`
- [x] T035 接口一致性清单生成器 `tools/gen-interface-manifest.mjs` → `upstream/interface-manifest.json`： 逐模块输出 `InterfaceEntry = { module, exportedSymbols[], consumedMembers[{name,kind,arity?}], consumedBy[] }` （静态扫描逻辑层消费点；`consumedBy` 为逻辑层文件列表），并提供 `--check` 模式断言与基线无漂移。`自检`：`node --test "tests/unit/**/*.test.mjs"/interface-manifest.test.mjs`（断言 `Context` 成员面 ≥30、`ContextLimits` 10 个成员、`ShaderProgram` 读取面含 `_attributeLocations`）；`node tools/gen-interface-manifest.mjs --check` 以 0 退出。`→ FR-032, data-model §1.4, research §10`
- [x] T036 升级演练（干跑）`tools/upgrade-drill.mjs --dry-run`：离线用已提交清单校验漂移，产出 `UpgradeDrillRecord`（`mode`/`ranAt`/`diff:InterfaceManifestDiff`/`verification[]`/`verdict`）到 `artifacts/upgrade-drill.json`； `--to=<version> --full` 模式留待升级 PR（本增量只要求干跑常跑）。`自检`：`node --test "tests/unit/**/*.test.mjs"/upgrade-drill.test.mjs`（离线运行、断言 `verdict === "pass"` 需"补丁范围审计 + 接口一致性 + 全量验证"三项齐备；缺一项即 fail）；`node tools/upgrade-drill.mjs --dry-run` 以 0 退出。`→ 原则 I（升级演练）, contracts/fork-patch-layer §6`
- [x] T037 [P] 补丁层模块骨架与显式失败助手：`packages/cesium-webgpu/backend-webgpu/Renderer/**`（与上游同名的替换模块文件，先以显式失败骨架落地）与 `packages/cesium-webgpu/backend-webgpu/webgpu/**`（`device-handoff`/`pass-encoder`/`pipeline-cache`/`bind-layout`/`shader-emit`/`glsl-preprocess`/`capability`/`wgsl-prelude`/`wgsl`/`errors.ts`）， `errors.ts` 提供 `notImplemented(capability)` → `DiagnosticError{category:"not-implemented"}`。`自检`：`node --test "tests/unit/**/*.test.mjs"/backend-skeleton.test.mjs`（断言每个占位能力**抛可诊断错误**、MUST NOT 静默返回空值/黑屏）。`→ FR-033, contracts/render-path-api §6`
- [x] T038 [P] 状态与错误模型：`packages/cesium-webgpu/src/status/**`（`RenderPathStatus`、原因类别 `no-navigator-gpu`/`no-adapter`/`device-request-failed`/`missing-feature`/`below-limit`/`timeout`、降级与盲区 `notes`）、 `packages/cesium-webgpu/src/api/errors.ts`（`DiagnosticError{category,message,backend?,cause?}`）与 `src/api/diagnostics.ts`（`onError` 订阅）。`自检`：`node --test "tests/unit/**/*.test.mjs"/status-model.test.mjs`（断言 `degraded === true ⇒ notes` 非空、错误类别枚举与契约一致、错误 MUST NOT 被静默吞掉）。`→ FR-009, FR-023, data-model §2.5`
- [x] T039 [P] CI 骨架 `.github/workflows/ci.yml`（本阶段只含 `install → build → typecheck → unit → audit(AU-1…AU-5)` 串行门禁； 两路径 contract/visual/bench job 与着色器工具链在 W8 补齐）。`自检`：`node --test "tests/unit/**/*.test.mjs"/ci-workflow.test.mjs`（用 T004 锁定的 `yaml` 解析断言门禁顺序、断言尚无"两条路径同 job 并行渲染"的配置）。`→ FR-021/FR-022, contracts/verification-and-benchmark §7`
- [x] T040 [P] 许可证与署名（Apache-2.0）：`LICENSE`（Apache-2.0，与上游一致）、 `NOTICE`（MUST 声明"本产品包含 CesiumJS Contributors 开发的软件"，写明上游基线与版本，并**逐条列出被重实现的文件**——与 `manifest.json` 一致）、 派生文件版权头规范（保留原始版权头 + "Modified for WebGPU backend" 注记）、`tools/scripts/check-license-notice.mjs`。`自检`：`node --test "tests/unit/**/*.test.mjs"/license-notice.test.mjs`（断言 NOTICE 修改文件清单 == manifest 清单集合、上游 `LICENSE.md` 随交付保留、结论非空）；`node tools/scripts/check-license-notice.mjs` 以 0 退出。**许可证允许集合 MUST 覆盖本仓库实际依赖的全部许可证**，至少含：`@cesium/engine`（Apache-2.0，钉版 26.3.0）、`@rollup/plugin-commonjs`（**MIT**，`29.0.3`，**仅 devDependency**——G-2 门禁 F-1 实测接入的真实依赖，缺它则 `GoogleEarthEnterpriseImageryProvider` 的命名空间成员访问会在运行期取到 `undefined`）、`yaml`（ISC）、`rollup`/`@rollup/plugin-*`/`rollup-plugin-dts`/`typescript`/`@webgpu/types`/`playwright` 各自声明的许可证；断言方式为**逐包读取 `node_modules` 的 `license` 字段**并与允许集合比对（GPL/AGPL/未知许可证一律拒绝）。`→ FR-024, contracts/fork-patch-layer §7, contracts/verification-and-benchmark §5（AU-5）`
- [x] T041 **W1 Checkpoint**：`node tools/audit-patch-scope.mjs`（`verdict === "pass"`、`logicLayerOverrides === 0`） + `node tools/upgrade-drill.mjs --dry-run` + `node tools/scripts/check-license-notice.mjs` + `node --test "tests/unit/**/*.test.mjs"` 全绿； 并把 `artifacts/patch-scope-audit.json`、`artifacts/upgrade-drill.json` 作为 CI 产物路径登记进 `.github/workflows/ci.yml` 的上传段。`自检`：上述四条命令均以 0 退出。 `→ 原则 I, FR-032, SC-010`

**Checkpoint（Foundational）**：补丁边界、依赖完整性、接口清单、升级演练、许可证五项均有**可执行证据**——此后 user story 可以实现。

---

## Phase 4: User Story 1 - 地形渲染在新渲染路径下端到端跑通（P1）🎯 MVP ｜ W2 WebGPU 后端核心

**Goal**: `Context` 替换模块在**上游 `Scene` 构造期同步接管** WebGPU 设备与能力，命令执行以**派生式通道**完成，
绘制提交与呈现全部发生在 WebGPU 上；设备丢失按整体切换恢复。
**Independent Test**: `node tests/support/backend-runner.mjs --backend=webgpu --suite=contract-backend-core`
（**独立进程 + 独立页面加载**，只启用 WebGPU 一条路径）全绿，且该次运行中 WebGL2 的 GPU 对象创建数为 0。〖二选一〗

- [x] T042 [US1]（`层=单元`）设备交接槽 `packages/cesium-webgpu/backend-webgpu/webgpu/device-handoff.ts`：`install({adapter,device,limits,features})` / `take()` / `peek()` / `clear()`，仅允许**同一进程内、构造上游场景之前**调用一次；未安装时 `take()` 返回 `undefined` （= 走上游原版 WebGL2 链路，不存在中间态；**W2 决策注记（`plan.md` 决策 D2-a）**：静态清单下"上游原版 WebGL2 链路"由替换实现**内部整体委派**给补丁层保留的原版实现完成——单构建，同一时刻只有一个后端被实例化）。`自检`：`node --test "tests/unit/**/*.test.mjs"/device-handoff.test.mjs`（断言"未安装 → undefined"、"重复安装 → 报错"、"take 后清空"语义）。`→ FR-005, research §3, G-2`
- [x] T043 [US1]（`层=单元`）`Renderer/Context` 替换实现（构造期）：从交接槽取设备 → `configure()` 画布 → `ContextLimits` 合成 → 能力标志发布 → 默认纹理（1×1 RGBA8、`flipY:false`、默认 `Sampler` CLAMP_TO_EDGE）→ `id` 为每上下文稳定唯一 GUID （逻辑层用它做索引缓冲缓存键）。`自检`：`node --test "tests/unit/**/*.test.mjs"/context-construction.test.mjs`（断言构造期**同步可读** `ContextLimits` 与能力标志、`id` 稳定唯一、默认纹理尺寸/格式）；`node tests/support/backend-runner.mjs --backend=webgpu --suite=smoke:scene-construct`（用例文件 `tests/contract/smoke-scene-construct.spec.mjs`）。**（W2 决策注记，`plan.md` 决策 D2-a）**：交接槽为空/探测失败时，本替换实现 MUST 在**构造期一次性整体委派**给补丁层保留的上游原版 WebGL2 实现（单构建、同一时刻只有一个后端被实例化）；MUST NOT 按命令/按帧混合两条后端，MUST NOT 静默降级——无法委派时 MUST 抛可诊断错误（与 `docs/gate-g2-conclusion.md` §2 的 `device-handoff/missing` 同口径）。 `→ FR-030, research §1.3/§3, data-model §3`
- [x] T044 [US1]（`层=单元`）`Context` 命令分派与生命周期：`draw(command, passState, program, uniformMap)`（解析目标 → 通道身份变化则闭合旧通道并开新通道 → `setPipeline`/`setBindGroup`/`setVertexBuffer`/`setIndexBuffer`/`setViewport`/`setScissorRect` → `drawIndexed`/`draw`）、 `clear`（首次操作走 `loadOp:"clear"`，其余 `clearBuffer` 兜底）、`beginFrame`（取交换链纹理 + 新建 encoder + 初始化通道状态机）、 `endFrame`（闭合通道 → `finish()` → `queue.submit()`）、`drawingBufferWidth/Height`、`createViewportQuadCommand`、`destroy`/`isDestroyed`。`自检`（**不标 [P]**：与 T046 共享通道状态机接口）：`node --test "tests/unit/**/*.test.mjs"/context-dispatch.test.mjs`（含"帧末无未闭合通道"断言）；`node tests/support/backend-runner.mjs --backend=webgpu --suite=smoke:draw-dispatch`（用例文件 `tests/contract/smoke-draw-dispatch.spec.mjs`）。`→ FR-030, SC-010, research §1.4/§5.1`
- [x] T045 [US1] 能力合成 `backend-webgpu/webgpu/capability.ts`（`BackendCapabilities` + `ContextLimitsSnapshot`）： 逐项按 research §4 表取值（`webgl2:true` 语义为"现代渲染能力可用"并**在实现里注释该历史含义**；`msaa:true`； `depthTexture` 切片 A 暂 `false`；`fragmentDepth`/`instancedArrays`/`drawBuffers`/`elementIndexUint`/`stencilBuffer:true`； `textureFilterAnisotropic`/压缩纹理族/`supportsBasis` 一律 `false`）。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/capability-composition.test.mjs` （逐项断言取值来源、任何 `false` 有 `notes`、`sliceBComplete===true ⇒ depthTexture===true` 的一致性检查存在）。`自检`：该测试全绿。`→ FR-030, H-2, data-model §3.1/§11 A8`
- [x] T046 [US1]（`层=单元`）通道状态机 `backend-webgpu/webgpu/pass-encoder.ts`：`RenderPassKey = (colorTargets, depthStencilTarget, sampleCount, viewport, scissorRect)` 派生式；身份变化或 `endFrame` 即闭合；`Pass`/`PassState`/程序/顶点数组/uniform/`RenderState` 的变化**均不构成**通道边界； 多采样解析映射为 `colorAttachments[i].resolveTarget`。`自检`：`node --test "tests/unit/**/*.test.mjs"/pass-encoder.test.mjs`（**录制-回放**： 给定 G-3 的 trace 输入，断言通道数/附件/load-store 与 `clear`/`draw` 序列一致）。`→ FR-030, H-3, research §1.5/§5.2, data-model §4.1/§10③`
- [x] T047 [US1] 通道序列契约验证（`层=契约`）：`tests/contract/pass-sequence.spec.mjs` —— 在 `RENDER_BACKEND=webgpu` 与 `RENDER_BACKEND=webgl2` **两次独立运行**中各自采集帧级通道序列，与 G-3 结论做**离线比较**（MUST NOT 同会话对比）。〖二选一〗`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:pass-sequence` 与 `--backend=webgl2 --suite=contract:pass-sequence` 各以 0 退出（**串行执行，不得同时**）；`node tests/support/compare-offline.mjs --artifact=artifacts/pass-sequence` 以 0 退出。`→ FR-011, 原则 II, data-model §4.4`
- [x] T048 [US1]（`层=单元`）管线缓存 `backend-webgpu/webgpu/pipeline-cache.ts`：`PipelineCacheKey = (shaderProgramId, renderStateFingerprint, vertexLayoutFingerprint, topology, colorFormats[], depthFormat?, sampleCount)`、 `PipelineRecord{key,pipeline,createdAt,hits,misses}`；`renderStateFingerprint` MUST 覆盖 `RenderState` 全部字段； 未支持组合（`lineWidth !== 1`、`sampleCoverage.enabled === true`）MUST 抛可诊断错误而非静默忽略。`自检`：`node --test "tests/unit/**/*.test.mjs"/pipeline-cache.test.mjs`（命中/未命中计数、指纹覆盖度反例、未支持组合报错）。`→ research §5.3, data-model §4.2`
- [x] T049 [US1] `RenderState` 替换与映射表 `backend-webgpu/Renderer/RenderState.ts`：**选项形状 MUST 保持不变**（50+ 逻辑层文件按同一形状构造）， 实现 `fromCache`/`partialApply`（改为管线状态 diff）/`apply`；覆盖 `cull`/`frontFace`/`depthTest`/`depthMask`/`depthRange`（非默认值 MUST 断言为 (0,1) 并记录差异）/ `blending`（GL 常量 → `GPUBlendFactor` 逐项映射表）/`colorMask`/`stencilTest`（`reference` 走 `setStencilReference`）/`stencilMask`/`scissorTest`/`viewport`/`polygonOffset`/`lineWidth`。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/render-state-mapping.test.mjs` （逐字段映射断言 + "未支持项必须报错"反例）。`自检`：该测试全绿。`→ FR-030, research §5.3, data-model §4.2`
- [x] T050 [US1]（`层=单元`）交换链与画布呈现 + 4× MSAA 解析：`configure()` 与 `getCurrentTexture()` 的帧序、`sampleCount:4` 附件 + `resolveTarget`、 画布尺寸/像素比变化时的重建。`自检`：`node --test "tests/unit/**/*.test.mjs"/swapchain-msaa.test.mjs`（descriptor 断言：`sampleCount` 与 `resolveTarget` 成对出现、尺寸跟随 `devicePixelRatio`）；`node tests/support/backend-runner.mjs --backend=webgpu --suite=smoke:present`（用例文件 `tests/contract/smoke-present.spec.mjs`）。`→ FR-001, research §5.1, data-model §4.1`
- [x] T051 [US1] 设备丢失**整体切换**：订阅 `device.lost` → 停止提交 → **销毁** WebGPU 后端与上游场景 → 重新探测 → 按 §2 重建 （成功仍用 WebGPU，失败整体切 WebGL2）；产出 `WholeSwitchRecord{trigger,from,to,destroyedResources,rebuildMs,residualDraws}`， `destroyedResources > 0`、`residualDraws === 0`；**MUST NOT** 保留旧设备资源或绘制结果作为叠加层。`层=单元` + `层=契约`；`自检`：`node --test "tests/unit/**/*.test.mjs"/whole-switch.test.mjs` 全绿；`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:device-lost` 以 0 退出（独立进程）。〖二选一〗`→ FR-003, FR-006, data-model §2.4/§10④`
- [x] T052 [US1]（`层=单元`）错误采集与可诊断失败：用 `device.pushErrorScope`/`onuncapturederror` 在开发与测试模式下采集校验错误， 并在**帧末**抛出可诊断错误（保持上游"着色器编译失败即抛异常"的可观察语义，MUST NOT 静默丢失）。`自检`：`node --test "tests/unit/**/*.test.mjs"/error-scope.test.mjs`（人为写入非法 WGSL → 必须在帧末抛出且 `category` 可诊断）。`→ research §6.2, contracts/render-path-api §6`
- [x] T053 [US1]（`层=单元` + `层=架构边界`）切片 C 桩与显式失败（`Context` 面 + manifest 中 5 个 `stub-not-implemented` 模块；**`ShaderBuilder` 边界不属本任务，见 T081**）：`readPixels`/`readPixelsToPBO`/`Sync`/`CubeMap`/`Texture3D`/`TextureAtlas`/`ComputeEngine` 执行 → 一律 `category:"not-implemented"`（禁止空结果或黑屏）； `SharedContext` 在 WebGPU 路径下若被使用 MUST 显式报错。`自检`（**不标 [P]**：与 T044 同文件）：`node --test "tests/unit/**/*.test.mjs"/not-implemented-surface.test.mjs`（逐个断言抛错类别与文案；并断言 manifest 中 `Texture3D.js`/`CubeMap.js`/`CubeMapFace.js`/`TextureAtlas.js`/`Sync.js` 五项 `kind === "stub-not-implemented"`，其集合与 T031 清单一致）。`→ FR-033, research §6.1/§7, contracts/render-path-api §6`
- [x] T054 [US1]（`层=架构边界`）**W2 Checkpoint**：`node --test "tests/unit/**/*.test.mjs"` 全绿； `node tools/scripts/check-arch-boundaries.mjs --rules A1,A2,A6,A7` 以 0 退出（A7：同一 `VerificationRun` 只允许一个 `backend`， 同会话双路径用例 MUST 被判失败）；`node tools/audit-patch-scope.mjs` 仍为 `pass`（新增文件未越界）。`自检`：上述三条命令均以 0 退出。 `→ FR-030, 原则 II, SC-010`

**Checkpoint（US1 / W2）**：WebGPU 后端可在上游场景构造期接管并完成命令提交与呈现（尚未有地形内容）；补丁边界未被破坏。

---

## Phase 5: User Story 1（续）｜ W3 资源层

**Goal**: 把上游资源类（`Buffer`/`Texture`/`Sampler`/`VertexArray`/`Framebuffer`/`Renderbuffer`/`MultisampleFramebuffer`/
`FramebufferManager`）重实现为 WebGPU 资源，保持逻辑层可观察语义（工厂、构造选项、`copyFrom` 重载、`destroy`）不变。
**Independent Test**: `node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:resources`（独立进程）全绿，
且同一套用例在 `--backend=webgl2` 的**另一次独立运行**中同样全绿（离线比较，MUST NOT 同会话）。〖二选一〗

- [x] T055 [US1] `Renderer/Buffer` 替换：三种工厂（`createPixelBuffer`/`createVertexBuffer`/`createIndexBuffer`）、 `usage` 映射（顶点/索引/pixel → `GPUBufferUsage` 组合）、`copyFrom` → `queue.writeBuffer`、`sizeInBytes`、`destroy`/`isDestroyed`。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/buffer-mapping.test.mjs`（usage 组合与工厂语义断言）。`自检`：该测试全绿。`→ FR-030, research §6.1`
- [x] T056 [US1] `Renderer/Texture` 替换：构造（`width`/`height`/`pixelFormat`/`pixelDatatype`/`sampler`/`source`）、 `source` 类型集合（`ImageData`/`HTMLImageElement`/`HTMLCanvasElement`/`Video`/`OffscreenCanvas`/`ImageBitmap`）、 `copyFrom` 重载（含 region 与 mipmap）、`flipY`、`preMultiplyAlpha`、`destroy`。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/texture-mapping.test.mjs`。`自检`：该测试全绿。`→ FR-030, research §6.1`
- [x] T057 [US1] 格式与类型映射表 `backend-webgpu/webgpu/format-map.ts`：`PixelFormat`/`PixelDatatype` → `GPUTextureFormat` （含 sRGB 目标、`LUMINANCE`/`RED`/`ALPHA` 的等价处理、depth/stencil 格式、`RenderbufferFormat` 映射）； 未支持格式 MUST 抛可诊断错误。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/format-map.test.mjs`（枚举全覆盖断言 + 未支持项报错）。`自检`：该测试全绿。`→ FR-030, research §6.1, data-model §5.2`
- [x] T058 [US1] 纹理 Y 翻转与上传语义固化（`层=视觉`）：在 `Texture` 映射层统一处理原点差异（WebGPU 纹理原点在上、GL 在下）， 并用**四角纹素回读断言**固化（尖刺实测手法：四角取到 2×2 纹理的四个纹素色）。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=visual:texture-origin` 以 0 退出（独立进程；四角断言全中；用例文件 `tests/visual/texture-origin.spec.mjs`）——**本任务只运行单一后端，按全局约定 2 的标注规则不使用"两条后端"标记**`→ H-7, research §6.3, 尖刺 §4`
- [x] T059 [US1] `Sampler` 语义保持与映射：`Sampler.js` 为 GL-free **保留文件**（MUST 字节不变，由 `keptModulesHash` 断言）， 后端侧提供 `Wrap`/`Filter` 全枚举 → `GPUSamplerDescriptor` 映射表；不支持的项（各向异性）显式记录。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/sampler-mapping.test.mjs`。`自检`：该测试全绿；`node tools/scripts/gen-kept-hash.mjs --check` 断言 `Sampler.js` 在保持不变集合中。`→ FR-030, research §6.1`
- [x] T060 [US1] `Renderer/VertexArray` 替换：`attributes[]` 全字段（`index`/`vertexBuffer`/`componentDatatype`/`componentsPerAttribute`/`normalized`/ `offsetInBytes`/`strideInBytes`/`instanced`/`divisor`）、`indexBuffer`、`numberOfVertices`、`_bind`/`_unBind`、 `instanced/divisor` → `stepMode:"instance"`；VAO 概念不存在（每次 draw 设置）。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/vertex-array-mapping.test.mjs`（含上游地形 `TerrainEncoding` 两种量化模式的布局断言）。`自检`：该测试全绿。`→ FR-030, research §6.1, §1.6`
- [x] T061 [US1] `Renderer/Framebuffer` / `Renderbuffer` / `MultisampleFramebuffer`（**唯一 owner**：`Framebuffer`/`Renderbuffer`/`MultisampleFramebuffer` 的附件化实现由 T061 交付，T062 交付 `FramebufferManager` 编排；**T097 只消费，MUST NOT 重复实现**）：帧缓冲**无对象对应**（降级为附件描述集合， `destroy()` 为空操作但保留 `isDestroyed()` 语义）、`hasDepthAttachment`、深度/模板 `Renderbuffer` → `GPUTexture`、 多采样 `sampleCount:4` + `resolveTarget`、`blitFramebuffers` 语义改为"确保解析已完成"。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/framebuffer-attachments.test.mjs`。`自检`：该测试全绿。`→ FR-030（帧缓冲）, research §6.1, data-model §5.2`
- [x] T062 [US1] `Renderer/FramebufferManager` 小改（编排保留；**唯一 owner 续**：`FramebufferManager` 归本任务，T097 只消费）：颜色/深度纹理与多采样配对的生命周期、 与新的 `Framebuffer`/`Texture`/`MultisampleFramebuffer` 对接。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/framebuffer-manager.test.mjs`（生命周期与配对断言）。`自检`：该测试全绿。`→ FR-030, research §6.1`
- [x] T063 [US1] GPU 资源登记 `GpuResourceRecord`（`id`/`kind`/`bytes`/`upstreamClass`/`createdFrame`/`destroyedFrame`）： `destroy()` 后 MUST 从登记表移除；`bytes` 汇总即 FR-017 的图形显存代理指标。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/gpu-resource-registry.test.mjs` （**泄漏断言**：帧 N 与帧 N+K 的活跃资源集合在稳态下不增长）。`自检`：该测试全绿。`→ FR-017, data-model §5.1`
- [x] T064 [US1] 资源层契约测试（`层=契约`）：`tests/contract/resources.spec.mjs` —— 同一套用例参数化两条路径、 **各自独立进程 + 独立页面加载**，离线比较两路径的资源行为统计（纹理格式支持、MSAA 解析结果、缓冲上传保序）。〖二选一〗`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:resources` 与 `--backend=webgl2 --suite=contract:resources` 串行各以 0 退出。`→ FR-011, FR-008, 原则 II`
- [x] T065 [US1]（`层=单元` + `层=架构边界`）**W3 Checkpoint**：`node --test "tests/unit/**/*.test.mjs"` 全绿；`node tools/audit-patch-scope.mjs` 为 `pass`（`keptModulesHash` 中 `Sampler.js`/`PixelDatatype.js`/`BufferUsage.js` 等仍字节不变）；`node tools/shader-verify.mjs --check-leaf-map` 不适用（未进入 W4），改用占位断言 `node tools/scripts/check-gate.mjs --gate g4` 仍为 `pass`。`自检`：`node tools/audit-patch-scope.mjs` 以 0 退出。 `→ FR-030, 原则 I`

**Checkpoint（US1 / W3）**：资源层可用，帧缓冲具备附件化实现与 MSAA 解析能力（切片 A 仍以 `depthTexture=false` 运行）。

---

## Phase 6: User Story 1（续）｜ W4 着色器编译前端（独立工作流，据尖刺定案）

**Goal**: **不转译 GLSL**，在 fork 层把着色器组装层参数化为 **WGSL 发射器**：`ShaderSource` 双发射目标（GLSL 视图不变）+
上游缺失的 GLSL 条件编译求值 + `czm_` WGSL prelude + 地形着色器闭包的 WGSL 库 + 运行时片段镜像 + varying 成对推导 +
变体级管线缓存；**全库 319 个 `.glsl` 叶子的一次性转译明确属本增量之外**（T082）。
**Independent Test**: `node tools/shader-verify.mjs --family=globe --variants=mvp` 真机 0 validation error +
`node --test "tests/unit/**/*.test.mjs"/glsl-preprocess.test.mjs` 全绿 + `node tools/shader-verify.mjs --check-leaf-map` 以 0 退出。

- [x] T066 [US1] GLSL 条件编译求值 `backend-webgpu/webgpu/glsl-preprocess.ts`：实现 GLSL ES 3.00 的 `#define/#ifdef/#ifndef/#if/#elif/#else/#endif` 求值（`defined()`、`&&`/`||`/`!`/括号、`#elif` 链、**算术条件**如 `#if TEXTURE_UNITS > 0`），并保持上游顺序语义 **"先内联 `czm_`、后条件求值"**；产出 `ConditionalCompilationTrace{variantKey,blocksEvaluated,branchesTaken,warnings}`。`层=单元`（即 **SH-4 门禁**）：`node --test "tests/unit/**/*.test.mjs"/glsl-preprocess.test.mjs` （含 `#elif` 链、算术条件、未激活分支仍参与 `czm_` 依赖收集三组用例）。`自检`：该测试全绿。`→ FR-030, research §6.4, contracts/fork-patch-layer R4`
- [x] T067 [US1] `ShaderSource` 参数化为双发射目标（`manifest.json` 中 `kind:"adapt-shader"`）：新增 `emit: "glsl" | "wgsl"`， **输入 `sources`+`defines` 与变体机制不变**，**GLSL 视图与预处理语义 MUST 不变**；改动 MUST 限于"增加 WGSL 发射通道 + 导出装配所需内部件"。`层=单元` + `层=架构边界`： `node --test "tests/unit/**/*.test.mjs"/shader-source-dual-emit.test.mjs`（断言 `emit:"glsl"` 输出与上游逐字节一致）；`node tools/scripts/check-arch-boundaries.mjs --rules A9` 以 0 退出（**SH-1 门禁**：逻辑层读到的仍是原始 GLSL、`_attributeLocations` 保留且一致）。`自检`：两条命令均以 0 退出。`→ FR-030/FR-031, H-5, contracts/fork-patch-layer R1/R2`
- [x] T068 [US1] `czm_` WGSL prelude 库 `backend-webgpu/webgpu/wgsl-prelude/**`：覆盖地形闭包所需**约 40 个** `czm_` 内建 （默认地形一对实测引用 72 个 `czm_` 中的地形子集；含 `czm_octDecode(vec2/float)`、`czm_signNotZero(float/vec2/vec3/vec4)` 等重载 → **MUST 拆名**；`czm_material`/`czm_ray` 等结构体；常量 → 函数或字面量）；每条目录含 `czmName`→`wgslName` 映射。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/wgsl-prelude.test.mjs` （断言每个内建有映射条目、重载已拆名、每个内建样例可被 naga 模块校验通过）。`自检`：该测试全绿。`→ FR-030, 尖刺 §6.1, data-model §4.5`
- [x] T069 [US1]（`层=单元`）地形着色器叶子 WGSL 入库：`backend-webgpu/webgpu/wgsl/**` 收录 `GlobeVS`/`GlobeFS`/`AtmosphereCommon`/`GroundAtmosphere` 闭包的 WGSL 产物（路径 A 出草稿 → 路径 B 人工定稿；以尖刺黄金样本 `port/globe-vs.wgsl`、`port/globe-fs.wgsl` 为起始基线）； **MUST NOT 写入 `Source/Shaders/**`**（补丁边界），MUST NOT 复用 `Source/Shaders/**` 路径。`自检`：`node --test "tests/unit/**/*.test.mjs"/wgsl-leaf-inventory.test.mjs` （断言四个家族齐备、文件位于后端层目录、不存在对 `Source/Shaders/**` 的写路径）；`node tools/scripts/check-wgsl.mjs` 以 0 退出。`→ 原则 I, contracts/fork-patch-layer R3`
- [x] T070 [US1] 叶子映射与升级漂移检测：`backend-webgpu/webgpu/shader-leaf-map.json`（`upstreamLeafHash` → `wgslFile`、 `convertedBy:"path-a-draft+path-b-final"`、`verifiedOnRealGpu`、`notes`）+ `tools/shader-leaf-map.mjs --update`； 上游叶子哈希变化 ⇒ 映射失配 ⇒ CI 失败并输出"须重做转换"清单。`层=单元`（即 **SH-3 门禁**）：`node --test "tests/unit/**/*.test.mjs"/shader-leaf-map.test.mjs` （断言哈希漂移使检查失败、`verifiedOnRealGpu !== true` 的叶子不得进入验收路径）。`自检`：`node tools/shader-verify.mjs --check-leaf-map` 以 0 退出。`→ H-10, contracts/fork-patch-layer R7, data-model §11 A11`
- [x] T071 [US1] 运行时片段镜像生成器 `backend-webgpu/webgpu/generated-fragments.ts`：按与上游**同一参数**（`{textureUnits, flags}`） 产出运行时生成的着色器片段（`GlobeSurfaceShaderSet.js:419-472` 的 `computeDayColor()`，**磁盘上不存在**）的 WGSL； 覆盖度以"**可达参数组合**"计数验收，未覆盖组合 MUST 显式失败。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/generated-fragments.test.mjs`。`自检`：该测试全绿。`→ FR-030, contracts/fork-patch-layer R6, data-model §4.5`
- [x] T072 [US1] varying 成对推导与契约：`VaryingContract{variantKey,varyingSet,vsOutputs,fsInputs}` —— VS 输出 MUST 与 FS 输入**逐项匹配** （WGSL 硬校验）；不匹配即判失败并出具差异报告。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/varying-contract.test.mjs` （含"故意多一个 `@location(7)` 输入 → 判定失败"的反例，对应尖刺 E1 实测）。`自检`：该测试全绿。`→ H-5, contracts/verification-and-benchmark §4（SH-2）, data-model §11 A10`
- [x] T073 [US1] WGSL 发射器 `backend-webgpu/webgpu/wgsl-emitter.ts`：实现内部接口 `WgslEmission.emit({vertexSources,fragmentSources,defines,destination,attributeLocations,textureUnits,flags}) → {vertexModule,fragmentModule,varyingSet,bindLayout,attributeBindings,diagnostics}` （与 research §6.3 的接口签名一致；`attributeBindings` 原样透传上游名称→location）。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/wgsl-emitter.test.mjs`。`自检`：该测试全绿。`→ FR-030, research §6.3`
- [x] T074 [US1] 深度范围修正（GL clip z∈[-1,1] → WebGPU NDC z∈[0,1]）在发射器内**成对处理** `@builtin(position)` 写入与 `czm_inverseProjection` 语义； **MUST NOT** 通过改 `Core/PerspectiveFrustum.js` 或 `Renderer/UniformState.js`（保留文件）实现。`层=单元` + `层=架构边界`： `node --test "tests/unit/**/*.test.mjs"/depth-range-remap.test.mjs`（生成文本断言：所有 `gl_Position`/`gl_FragDepth` 写入点均被重映射）； `node tools/scripts/gen-kept-hash.mjs --check` 断言 `UniformState.js` 字节不变。`自检`：两条命令均以 0 退出。`→ research §5.4/§6.3, 原则 I`
- [x] T075 [US1] `Renderer/ShaderProgram` + `Renderer/ShaderCache` 替换：`fromCache` **只依赖 4 个键**（`context`/`vertexShaderSource`/`fragmentShaderSource`/`attributeLocations`）； 变体级缓存键语义与上游 `[numberOfDayTextures][flags]` 一致；`_bind`/`_setUniforms`/`maximumTextureUnitIndex`/`destroy`/`releaseShaderProgram`； 逻辑层读取面（`vertexShaderSource`/`fragmentShaderSource`/`vertexAttributes`/`id`/`_attributeLocations`）MUST 全部保留。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/shader-program-cache.test.mjs`。`自检`：该测试全绿。`→ FR-030/FR-031, research §6.3/§6.4`
- [x] T076 [US1] `createUniform`/`createUniformArray` 替换 + uniform 环形缓冲：保留"惰性 set + 自 diff"语义（值未变不写）； 自动 uniform 块**每帧写一次**、手工 uniform（`command.uniformMap`）命令级写入并走动态偏移； `UniformBlockLayout` 与 WGSL 结构逐字段一致（G-4 结论为输入）。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/uniform-writer.test.mjs`（含 `mat3`/数组/`vec3` 对齐边界用例）。`自检`：该测试全绿。`→ FR-030, research §5.4, data-model §4.3`
- [x] T077 [US1] 绑定布局规划器 `backend-webgpu/webgpu/bind-layout.ts`：`BindingPlan{groups[{groupIndex,entries[{binding,kind,name,slot}]}],textureCount,samplerCount}`； 纹理/采样器进**独立 bind group**（便于按纹理集合变化切换）；`entries` 数 ≤ `maxBindingsPerBindGroup`、 `blockSize` ≤ `maxUniformBufferBindingSize`。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/bind-layout.test.mjs`。`自检`：该测试全绿。`→ FR-030, data-model §4.3`
- [x] T078 [US1] **SH-2 真机变体管线校验**（`层=视觉`，真机门禁）：`node tools/shader-verify.mjs --family=globe --variants=mvp --emit-report artifacts/shader-verify/globe-mvp.json` —— 对**地形全部可达 define 组合**跑真机 `createRenderPipeline`，断言 0 validation error、varying 成对匹配、 `verifiedOnRealGpu` 在叶子映射中被置真。`自检`：该命令以 0 退出并写出报告（本机无头 Chrome 153 零开关即可用；CI 无 GPU 时按 T080 降级并标注盲区）。`→ FR-010/FR-011, contracts/verification-and-benchmark §4, 尖刺 §4`
- [x] T079 [US1] **SH-6 变体规模与编译耗时门禁**（`层=基准`）：运行时 `ShaderProgram` 实例数与编译耗时直方图落盘 （`artifacts/shader-variants.json`），超阈值即失败；阈值来源与理由写入测试代码（`ToleranceRecord`）。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=bench:shader-variants` 以 0 退出（用例文件 `tests/benchmark/shader-variants.spec.mjs`）。`→ H-6, contracts/verification-and-benchmark §4`
- [x] T080 [US1] **SH-7 CI 降级校验**（`层=单元`）：`tools/scripts/check-wgsl.mjs` —— 用 `naga --input-kind wgsl <file>` 做模块级校验； 无 `naga` 可执行文件时 MUST 打印降级说明并在 CI 配置下判定失败（**MUST NOT 静默通过**），盲区（不覆盖 WebGPU 管线校验）在输出与 `docs/ci-degradation.md` 中显式标注。`自检`：`node tools/scripts/check-wgsl.mjs` 以 0 退出；`node --test "tests/unit/**/*.test.mjs"/check-wgsl.test.mjs` 全绿（含"naga 缺失 → 非 0"反例）。`→ FR-023, contract §4（SH-7）`
- [x] T081 [US1] `ShaderBuilder` 边界：`Renderer/ShaderBuilder.js` 在 MVP **保持字节不变**；模型/体素/高斯泼溅路径 MUST 以 `category:"not-implemented"` 显式失败（其 WGSL 化属后续增量）。`层=单元` + `层=架构边界`：`node --test "tests/unit/**/*.test.mjs"/shader-builder-boundary.test.mjs`； `node tools/scripts/gen-kept-hash.mjs --check` 以 0 退出。`自检`：两条命令均以 0 退出。`→ 原则 I, contracts/fork-patch-layer R9`
- [x] T082 [US1]（`层=单元`）**本增量范围声明**：`docs/shader-coverage-scope.md` —— 明确写出本增量只覆盖**地形着色器闭包** （`GlobeVS`/`GlobeFS`/`AtmosphereCommon`/`GroundAtmosphere` + 约 40 个 `czm_` 内建）， 而**全库 319 个 `.glsl` 叶子 / 244 个 `czm_` 内建 / 40+ 组装点**的一次性转译为 **2–4 人月外推（未逐家族实测），不计入本增量**； 后续增量按家族推进，每家族一个真机编译用例作为门禁。`自检`：`node --test "tests/unit/**/*.test.mjs"/shader-scope-doc.test.mjs`（断言文档含"不计入本增量""2–4 人月""未逐家族实测"三项声明，且**任务清单中不存在**把 319 叶子纳入本增量的任务）。`→ FR-026（工作流拆分：着色器覆盖范围）+ FR-027（口径声明）, mvp-estimate §1/§2, 尖刺 §9`
- [x] T083 [US1]（`层=单元` + `层=视觉`）**W4 Checkpoint**：`node --test "tests/unit/**/*.test.mjs"/glsl-preprocess.test.mjs` + `node tools/scripts/check-arch-boundaries.mjs --rules A9,A10,A11` + `node tools/shader-verify.mjs --check-leaf-map` + `node tools/shader-verify.mjs --family=globe --variants=mvp` 四者全绿； `node tools/audit-patch-scope.mjs` 仍 `pass`（`ShaderSource.js` 属 `adapt-shader`，其余着色器模块字节不变）。`自检`：上述四条命令均以 0 退出。 `→ FR-030, H-5/H-6/H-10`

**Checkpoint（US1 / W4）**：地形着色器可在 WebGPU 上编译并成对匹配 varying；全库着色器覆盖范围已书面界定为增量之外。

---

## Phase 7: User Story 1（续）｜ W5 地形端到端跑通（MVP 验收主体）

**Goal**: 用上游公开类 `CustomHeightmapTerrainProvider` + 本地固定数据集，把地形端到端跑在 WebGPU 后端上：
几何构建与四叉树调度**全部由上游逻辑层完成**，本项目不自建瓦片几何；多瓦片拼接、接缝、深度、交互、设备丢失全部通过自动化断言；
完成**切片 B**（帧缓冲 + `depthTexture=true` 翻转）这一 FR-030 的阻断项。
**Independent Test**: `node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain` 与
`--backend=webgl2 --suite=contract:terrain`（**两次独立运行，串行**）各自全绿。〖二选一〗

- [x] T084 [US1]（`层=单元`）固定数据集生成器 `tools/build-terrain-fixture.mjs`（一次性，Node 22，零第三方依赖或仅用已锁定依赖）： 从公开免登录 Terrarium 源（`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`，无需账号，CORS `*`） 解码 `height = R*256 + G + B/256 - 32768` → 生成 `packages/cesium-webgpu/fixtures/<datasetId>/manifest.json` + `<level>/<x>/<y>.hgt`（小端 Uint16 高程，含 `noDataValue`）。`自检`：`node tools/build-terrain-fixture.mjs --dataset=matterhorn-z0-12` 以 0 退出； `node --test "tests/unit/**/*.test.mjs"/fixture-generator.test.mjs`（对合成小输入断言解码公式与文件布局）。`→ FR-004, contracts/terrain-source §2`
- [x] T085 [US1] 数据集落盘与完整性校验（`层=单元`）：`tools/scripts/check-fixture.mjs` 断言 `totalBytes ≤ 20 MiB`（目标 3–6 MB）、 `levels` 覆盖 z0–z12 且最大层在覆盖区内 **≥2×2 瓦片**、覆盖区约 0.6°×0.5°（勃朗峰/大孔班山）、高差 **>4000 m**、 `sha256` 一致、`attribution` 非空且 `sources[]` 逐来源给出许可与链接、`tilingScheme: "geographic"`。`自检`：`node tools/scripts/check-fixture.mjs` 以 0 退出； `node --test "tests/unit/**/*.test.mjs"/fixture-manifest.test.mjs` 全绿（含"篡改一个瓦片 → sha256 失败"反例）。`→ FR-015（多瓦片）, FR-024（署名）, contracts/terrain-source §2（TS-3）`
- [x] T086 [US1] 地形数据源适配 `packages/cesium-webgpu/src/terrain/source.ts`：`createTerrainProvider({mode,datasetId,tilingScheme,credit})` 返回**上游公开类** `CustomHeightmapTerrainProvider`；`callback(x,y,level)` 返回**原始高度采样** `Float32Array`（**勘误**：`HeightmapTerrainData` 由上游 provider 自行构造，`CustomHeightmapTerrainProvider.js:237-241` 传入时无 `structure`，故值即米；本适配层 MUST NOT 构造该类型，原措辞"提供公开类 `HeightmapTerrainData`"不成立）； `mode: "fixture" | "public"`；MUST NOT 取用任何 `@private` 地形内部类型，MUST NOT 引入需要凭据的服务。`层=单元`： `node --test "tests/unit/**/*.test.mjs"/terrain-source.test.mjs`（TS-1：返回对象类型断言成立；断言不引用内部地形类型）。`自检`：该测试全绿（实测 10/10）。`→ FR-004, FR-031, contracts/terrain-source §1`
- [x] T087 [US1] 离线零外部请求断言（`层=契约`）：在验收用例运行期拦截并统计外部请求，断言 **=== 0**（`mode:"fixture"`）， 强制断网后仍能完成地形验收用例。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain-offline` 与 `--backend=webgl2 --suite=contract:terrain-offline` 串行各以 0 退出。〖二选一〗`→ FR-012, contracts/terrain-source §5（TS-2/TS-4）` —— **实测（2026-09-19，两后端各 2 passed / exit 0；入口 Agent 独立复跑 webgpu 臂 2 passed 6.1s）**：`totalRequests=56`、`hostnames=["127.0.0.1"]`、`external=0`、`fixtureTileRequests=15`（manifest + 15 片 .hgt，均为本机静态服务）、`tilesLoaded=true`、`canvasNonBackground=110592`。两条臂 = "联网可达下测量" 与 "强制拒绝一切非本机请求"（`blockExternal`）。**防空洞真命题守卫**：断言 http 请求 ≥10 且必须出现本机 manifest/.hgt 请求，否则"外部请求为 0"在空集上恒真。**反例自检**：临时 `sendBeacon("https://example.com/…")` → `2 failed / exit 1`，报错指名外部主机与 `resourceType: "ping"`，该次 artifact 记录 `requests=57`、`blockedExternalRequests` 非空；已还原并重跑绿。场景经**产品适配层** `bundle.terrainSource.createTerrainProvider({mode:"fixture"})` 取数（探针默认的解析式高度场结构上不可能联网，用它测"零外部请求"没有判别力）。
- [x] T088 [US1] 数据不可用与渲染失败**可区分**（FR-004/TS-5）：瓦片缺失/获取失败/超时 → "数据不可用"可观察状态， 其余瓦片继续渲染（不得整帧丢弃或页面卡死）；空瓦片/无效瓦片 → 无错误几何（不出现尖刺、穿模、NaN 顶点）。`层=单元` + `层=契约`；`自检`：`node --test "tests/unit/**/*.test.mjs"/terrain-unavailable.test.mjs` 全绿；`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain-unavailable` 以 0 退出。`→ FR-004, 边界情形（瓦片获取失败/空瓦片）` —— **实测（2026-09-19，单测 10/10；两后端契约各 exit 0；入口 Agent 独立复跑 webgpu 臂 1 passed 4.5s）**：`source.ts` 最小新增 `onTileDiagnostic` / `tileTimeoutMs`（默认 `DEFAULT_TILE_TIMEOUT_MS = 15_000`）；`missing | reader-error | timeout | empty → category:"data-unavailable"`，字节取到但不可解码 `→ category:"decode"`（**该分类是"可区分"的对照臂**：provider 级 `unparseableManifest=decode` vs `unreachableManifest=data-unavailable`）。分类臂实测 `{missing,readerError,timeout,empty} → data-unavailable`、`decode → decode`；交付 `real 8 / degraded 7`、`nonFiniteSamples 0`、顶点缓冲 `nonFinite 0`、`tilesLoaded true`、画布 `nonBackground 110592`。**反例自检**：① 把数据臂断言改成 `render-failed` → `1 failed`；② 让全部瓦片抛错/挂起 → `1 failed` 且当时 `realTiles 0/degraded 15`（"其余瓦片继续渲染"同样有能力失败）；均已还原重跑绿。**勘误（入口 Agent 的 brief 写错、由本任务实测纠正）**：`createFetchTileReader(baseUrl)` 在该文件并不存在（全仓库零命中）；`fixtureBaseUrl` 是 **fixtures 根**（适配层内部再拼 `datasetId`），传 `…/fixtures/<datasetId>` 会 404。**由本任务暴露的新缺陷见追加任务 T152。**
- [x] T089 [US1] 场景构造与句柄实现：`packages/cesium-webgpu/src/index.ts` 的 `createTerrainScene(options)` 返回 `TerrainSceneHandle` （`ready` MUST NOT reject、`whenTilesLoaded`、`captureFrame`、`stats`/`resetStats`、`setView`、`requestRender`、`dispose`、`diagnostics`）； 场景配置 MUST 为 MVP 集合：`baseLayer:false`、`skyBox:false`、`skyAtmosphere:false`、无后处理、`globe.enableLighting=true`。`层=单元` + `层=架构边界`： `node --test "tests/unit/**/*.test.mjs"/scene-config.test.mjs`（含 **A6**：构造参数必含三个 `false`，保证零 `ComputeCommand` 派发）。`自检`：该测试全绿。`→ FR-001, FR-007, data-model §11 A6, research §1.6` —— **实测（2026-09-19）**：`typecheck` ok、单测 486/486、`check-arch-boundaries` 11/11 干净；句柄为**薄适配器**，真控制器在 `src/compose/scene-runtime.ts`（`frame-statistics`/`scene-config`/`handle` 共 4 模块）；`dispose` 幂等、销毁后 `captureFrame` reject 并报 `internal`（**不返空帧**）、`stats()` 未测量字段一律 `NaN`（**不用 0 冒充结论**）；`compose/scene-config.ts` **未**另写 A6 配置，而是复用 `MVP_SCENE_CONFIGURATION`/`assertMvpSceneOptions`；按硬约束**复用容器内已有 `<canvas>`**（只对自建画布在 `dispose` 时 `remove()`，有单测断言）。**由本任务暴露的构建回归已修复（见提交记录）**：`src/**` 首次 import `@cesium/engine` 后 `npm run build` 失败——`rollup.config.mjs` 缺 `@rollup/plugin-commonjs`（引擎经 `mersenne-twister` 走 CJS），且 demo 的 TS 插件因 tsconfig `include` 不含补丁层而不转译被别名指向的 `.ts`；修法已落地（`commonjs()` + `apps/demo/tsconfig.build.json`），`npm run build` 现 exit 0。
- [x] T090 [US1] 上游地形顶点布局消费：属性**名称 → location** 映射 MUST 沿用上游 `TerrainEncoding.getAttributeLocations()` （`position3DAndHeight`(0)、`textureCoordAndEncodedNormals`(1)、`geodeticSurfaceNormal`(2)；`NONE` 与 `BITS12` 两种量化模式的 `componentsPerAttribute`/`offsetInBytes`/stride），全部属性 FLOAT 非归一化，共用同一交错顶点缓冲；索引类型（Uint16/Uint32）不固定。 `层=单元`：`node --test "tests/unit/**/*.test.mjs"/terrain-vertex-layout.test.mjs`（两种量化模式的字段级断言）。`自检`：该测试全绿。`→ FR-030, research §1.6` —— **实测（2026-09-19）**：`@cesium/engine@26.3.0` 下 `getAttributeLocations()` 恒含三个属性（`TerrainEncoding.js:649-653`）；`NONE` 三属性齐备时 stride = **44 B**（非 32）；索引规则由 `IndexDatatype.createTypedArray` 决定（65535→Uint16、65536→Uint32）。索引维度因 `VertexArray.fromGeometry` 需真实 GPU context 而改测 `IndexDatatype`，另加一条标注"结构核对（非行为）"的源码断言挂回 `fromGeometry`。**该实测暴露产品代码缺陷 → 见追加任务 T151。**
- [x] T091 [US1] **地形就绪端到端契约测试**（`层=契约`，US1 的 Independent Test）：`tests/contract/terrain-ready.spec.mjs`（**已完成；入口 Agent 两臂各自独立复跑通过**） —— 固定相机/时间/种子/视口/像素比/数据集；`whenTilesLoaded()` 返回 `loaded:true`；画面非空白、非纯背景色； 零未捕获错误；**多瓦片拼接**场景成立；每次运行断言**另一条后端的 GPU 对象创建数为 0**。〖二选一〗`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain-ready` 与 `--backend=webgl2 --suite=contract:terrain-ready` 串行各以 0 退出。`→ FR-001, FR-011, FR-015, SC-001`
- [x] T092 [US1] 地形多瓦片视觉回归（`层=视觉`）：（**已完成**（两臂各 exit 0：`visual:terrain` webgpu `pass 10/10`、`compared 60738 px`、`excluded 5.10%`、**`maxChannelDelta 0`、`differing 0`**；webgl2 同数字。**每条路径各自一份参考帧**已齐备（`reference-frames/terrain-multitile/matterhorn-z0-12/*.{webgpu,webgl2}.{png,tolerance.json}`），基线为该次运行合成器截图的**原始字节**（`copyFileSync`，不重编码），两段式协议（`VISUAL_TERRAIN_BASELINE=1` 生成 / 无 flag 比对 / 缺失即失败、**绝不自动重建**）。**负例自检两项均变红**：`pixel` → exit 1（`colour-max-channel-delta: 1 LSB (bound 0) at (2, 2)`，并产出差异图）；`shift`（整体横移 4 px）→ exit 1（`maxDelta 2 / differing 70`）；去掉变量重跑 → 0。抗锯齿带按 G-6 `subpixel-edge` 判据、排除像素**计数并封顶 30%**（实测 5.10%），带内几何由 silhouette 独立约束。**跨路径差异离线实测**：两路参考帧在排除带外 5830/61611 像素差 **1 LSB**（远高于单路 0.1% 预算）——这正是"每路径各一份参考帧"必要性的实测证据。**新缺陷见 T163**（uniform 环形缓冲容量 / level 13 细化）。）`tests/visual/terrain-multitile.spec.mjs` —— **每条路径各自一份参考帧** （`reference-frames/<datasetId>/<caseId>.<backend>.png`），比较区域排除抗锯齿边缘，容差写入测试代码并记录来源（`ToleranceRecord`）， 失败产出差异图与统计 JSON 到 `artifacts/`；跨路径差异一律**离线比较**，MUST NOT 同帧对比。〖二选一〗**注意基线口径**：参考帧记录的是**当前"起伏显式后置"状态**（`fade = 0`，地形为无明暗调制的基础色）下的画面，故参考帧**不得**被读作"起伏已验证"；将来引入起伏增量时 MUST 重新生成两条路径的参考帧，并在 `ToleranceRecord` 里记录"因起伏增量而重生成"。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=visual:terrain` 与 `--backend=webgl2 --suite=visual:terrain` 串行各以 0 退出。`→ FR-010/FR-013/FR-014, SC-002（rev）/SC-009`
- [x] T093 [US1] 几何类缺陷的**数值化**断言（`层=视觉`，FR-016）：（**已完成**：两臂各 exit 0——webgpu `1 passed (4.6s)`、webgl2 `1 passed (52.1s)`；四臂判据均带校准来源并落盘 `artifacts/terrain-geometry/criteria.json`；**"删掉一块瓦片 → 断言必须变红"已实测**：`TERRAIN_GEOMETRY_INJECT=fail:9/531/124` → exit 1、7 条违规，被判定的那条量确实变红；反例全部经查询参数注入、**零文件改动**。其三角数按 `drawIndexed` 索引数自算得 **172800**，与 T091 独立测得值**完全一致**——互为佐证，且它**未使用** `stats().triangleCount`（T156）。衍生缺陷见 T162。）接缝裂缝、空洞、错误遮挡、异常顶点由数值断言捕获 （覆盖率突变、深度不连续处像素比例、几何统计区间、三角数与 draw call 数异常），**MUST NOT** 依赖人工目视。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=visual:terrain-geometry` 与 `--backend=webgl2 --suite=visual:terrain-geometry` 串行各以 0 退出（含"人为删掉一块瓦片 → 断言必须失败"的自检用例）。〖二选一〗`→ FR-016, FR-010`
- [ ] T094 [US1] 高程特征的**帧证据数值化**断言（`层=视觉`/统计，**对齐修订后 SC-002**）：（a）**覆盖率**：非背景色像素占比 ≥ 阈值（阈值落盘并记录来源）；（b）**几何↔数据集自洽**：从帧证据（顶点/深度/矩阵）读出的高程量级与固定数据集一致（区间与来源一并落盘）；（c）不出现空白/纯背景色/整片单色（`uniqueColorCount`；仪器名 MUST 用 `uniqueColoursGpuReadback`，**不得**与 `uniqueColoursComposite` 混用，两者口径不同）。**起伏/明暗调制显式后置**：近地相机下上游 `fade = clamp((far − near)/(…), 0, 1) = 0` ⇒ `finalColor = color × lightColor`（实测，非推测；见 plan 的起伏决策与 A1/A2 证据），两条路径行为一致，故本任务 **MUST NOT** 断言高度-亮度相关性、阴影或遮挡差异。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=visual:terrain-elevation` 与 `--backend=webgl2 --suite=visual:terrain-elevation` 串行各以 0 退出。〖二选一〗`→ SC-002（rev）, FR-001`
- [x] T095 [US1] 相机交互契约测试（`层=契约`，SC-004）：（**已完成**（**WebGL2 臂通过；WebGPU 臂按实测判红且未放宽任何断言**）：webgl2 `2 passed / exit 0`——388 帧、帧间隔 `2.8/10/10.3/13.6/**82.2** ms`、0 次 >1000 ms 卡顿、0 诊断、draws 9→14、tiles 16→28、合成器覆盖 **1.00**；webgpu `1 failed / 1 passed / exit 1`——387 帧、max **97.1** ms、0 卡顿、(d) 60 步全施加，但 (b) **384 条 `render-failed`**（uncaught/console 仍 0）与 (c) 定格帧 `drawCallCount=0`、覆盖 1.32% ⇒ **归因 T158+T152**，首条诊断在首次相机变更后约 60 ms。反例自检两后端均变红（注入 1200 ms busy-wait：`flagged(1000ms)=1`、`flagged(1ms)=287/335`、`measuredArmAssertionFailed=true`）。**该场景自行修正了两条伪判据**（`uniqueColorCount≥16` 与"逐像素差"）并写明来源，**未放宽卡顿阈值**；集成者 hand-off 前置条件与 `onStatus.active===backend` 断言均已补上。）瓦片就绪后连续 3 秒执行旋转/缩放/平移（固定步长与时长）， 断言 (a) 无 **>1000 ms** 的连续卡顿、(b) 无未捕获错误、(c) 交互结束并稳定后定格帧的统计量与交互前同区间、(d) 帧计数持续增长。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:interaction` 与 `--backend=webgl2 --suite=contract:interaction` 串行各以 0 退出（帧时间超阈值时 MUST NOT 放宽断言，须记录实测分布）。〖二选一〗`→ FR-002, SC-004`
- [x] T096 [US1] 设备丢失恢复契约测试（`层=契约`，FR-003）：（**已完成**（套件 exit 0；**入口 Agent 独立复跑 `1 passed (1.2m)` / exit 0**）：免刷新（`navigationEntries=1`、同一 canvas）；`assertCleanRun` 严格通过、console error **0**；覆盖率 `64000→0`（不重建对照臂）`→64000→64000`；旧设备计数 3→0 且 `destroyed=true`；状态提示原文落盘；stop 后 draws/passes/submitted 冻结且 `residualDraws` 等式成立；新旧 `GPUDevice` 不同、handoff cycle=1、瓦片重新 fetch 16→32。反例自检：反相"损失窗对照臂" → exit 1，还原后复跑绿。**两条臂如实标为"未取得独立证据"并给出所需 packages 改动**：FR-017 账本不归零 → **T161**；设备丢失顶层分类失真 → **T160**；另有 out-of-scope 的 `setView()` 触发缺陷 → 并入 **T158**。）`device.destroy()` → 停止提交 → 销毁后端与场景 → 重新探测 → 整体重建 → 恢复交互；断言免刷新恢复、无未捕获错误、旧设备资源计数归零、给出状态提示；MUST NOT 保留旧设备绘制结果。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:device-lost-terrain` 以 0 退出（独立进程）。〖二选一〗`→ FR-003, SC-004, data-model §10④`
- [ ] T150（**追加编号**；承接 W2↔W4 接缝，原任务清单无人认领）**uniform 运行期装配的显式归属与验证**：`packages/cesium-webgpu/backend-webgpu/webgpu/uniform-gpu-staging.ts`（GPU ring buffer + bind group 0 装配）已在 W5 中期实现，但**没有任何任务声明它归谁**，因此其行为没有验收锚点。本任务补齐：(a) 在 plan/tasks 登记该模块的所有权与契约（谁写入、何时重建、帧间可见性）；(b) `层=单元`：`node --test "tests/unit/**/*.test.mjs"/uniform-gpu-staging.test.mjs` 断言 ring buffer 的写入偏移与 `minUniformBufferOffsetAlignment` 对齐、bind group 0 的绑定范围；(c) 断言"同一帧内同一 uniform 段只装配一次"（重复装配即 CI 失败）。`→ data-model §5（uniform 装配）, research §4, W2 决策`
- [ ] T151（**追加编号**；由 T090 实测发现，**产品代码缺陷**）**地形顶点属性表与上游布局对齐**：`packages/cesium-webgpu/backend-webgpu/webgpu/varying-contract.ts:63-67` 的 `TERRAIN_ATTRIBUTE_LOCATIONS` **漏 `geodeticSurfaceNormal: 2`**，且 `:308-309` 的注释断言"`geodeticSurfaceNormal` 不属于 `TerrainEncoding`"——实测 `@cesium/engine@26.3.0` `Source/Core/TerrainEncoding.js:649-653` 的 `getAttributeLocations()` **恒含**该属性，故该"deviation"是假的；`:320-326` 又把 `compressed1` 的偏移硬编码为 16、步长硬编码为 32 B，而实测 NONE 模式下三属性齐备时步长是 **44 B**。修复 MUST 以 `tests/unit/terrain-vertex-layout.test.mjs` 的实测值为准，并删除或更正该处注释（**MUST NOT** 反向修改测试去迁就实现）。`层=单元` + 回归：`node --test "tests/unit/**/*.test.mjs"` 全绿 + `node tests/support/backend-runner.mjs --backend=webgpu --suite=terrain:probe` 以 0 退出（确认改表后地形仍出像素）。`→ FR-030, research §1.6, T090 实测`
- [ ] T152（**追加编号**；由 T088 的反例自检暴露，**产品代码缺陷候选**）**全量瓦片失败时的帧循环不收敛与错误作用域泄漏**：当**所有**瓦片都读不到时（T088 的反例臂：`realTiles 0 / degraded 15`），WebGPU 侧 `renderErrors` 爆出大量 `error-scope: beginFrame() … scopes still open`（`category: "internal"`）、`tilesLoaded` **不收敛**、帧循环跑满 20 s 预算；部分失败（正常验收场景）不出现该现象。要求：(a) 先**测量并定位**（是 `error-scope` 收集器在帧末未闭合、还是"全平铺"路径反复触发校验错误，抑或 `tilesLoaded` 的收敛条件依赖至少一片真实瓦片），**MUST NOT** 在未定位前调参掩盖；(b) 修复后断言"全量瓦片失败"这一极端输入下仍满足 SC-004 的**无 >1000 ms 连续卡顿**与"无未捕获错误"，且 `whenTilesLoaded` 在超时后**如实返回** `{loaded:false, pendingTiles:n}` 而不是永不返回或抛未捕获异常；(c) 反例自检：把收敛条件改回依赖真实瓦片，测试必须变红。`层=单元` + `层=契约`（`contract:terrain-unavailable` 的全量失败臂）。`→ FR-002/FR-003/FR-004, SC-004, T088 反例自检实测` —— **入口 Agent 只读定位（**待验证假设，未实测，MUST NOT 据此直接改**）**：① `src/compose/scene-runtime.ts:330-335` 对帧内错误作用域的排空是 `void awaited.catch(...)`，即**不等待** `awaitFrameErrors()`；而 `backend-webgpu/webgpu/error-scope.ts:109-151` 的 `endFrame()` 需要 `await` 三次 `popErrorScope()`（且**先**弹出、**后**抛出），`beginFrame()`（`:89-99`）正是"上一帧作用域仍开着"这条守卫。`renderOnce()`（`:320-346`）是同步返回的，因此"下一帧的 `beginFrame` 早于上一帧 `endFrame` 的异步排空"在原理上可发生——但按事件循环顺序（rAF 是宏任务、pop 是微任务）正常情况下不应发生，故**必须先用时序证据证伪或证实**，不要先改代码。② `whenTilesLoaded`（`:512-545`）在 `deadline` 后**会**如实返回 `{loaded:false,pendingTiles}`（不是永久挂起）——"不收敛"指的是 `scene.globe.tilesLoaded` 始终不为真，而不是 Promise 不返回；两者 MUST 分开断言。③ 只读分析**未**覆盖 `Scene.render` 内部在"全平铺"几何下是否抛错；若 hypothesis ① 被证伪，优先排查这条。 —— **已在新场景复现（2026-09-19，`contract:interaction`）**：该运行里出现 `error-scope: beginFrame() was called while the scopes of the previous frame were still open`，且**紧跟在一条真实帧错误之后**（`Buffer._getGpuIndexFormat …`，见 T158）。这支持"帧内出错 ⇒ 该帧作用域生命周期走坏 ⇒ 下一帧 `beginFrame` 看到未关闭作用域"这条链，并说明 T152 **并非"全量瓦片失败"路径专有**，而是**任何帧错误的后续效应**——修 T158 时应同时验证 T152 的症状是否随之消失（若消失，则 T152 按"帧错误路径的作用域生命周期"归因，而不是"全平铺几何"）。
- [ ] T153（**追加编号**；**入口 Agent 首次登记时归因错误，已按实测更正——勘误见下方**）**宿主页缺少"设备 hand-off 安装"这一集成步骤 → WebGPU 运行静默整体委派成上游 WebGL2，并在构造期崩溃**。**已核实的根因链**（入口 Agent 逐项独立复验，四项全部为真）：
  1. `artifacts/interaction/webgpu.json`：`report.webgl2.contextRequests === 1`（`contextRequestTypes: ["webgl2"]`）而 `report.webgpu.adapterRequests === 0 / deviceRequests === 0` —— 该"WebGPU"运行**从未申请 WebGPU 适配器**，而是申请了 WebGL2 上下文；
  2. `backend-webgpu/Renderer/Context.ts:30-35`（plan D2-a）：hand-off 槽为空时，替换版 `Context` 在**构造期做一次性整体委派**给 `vendor/upstream-webgl2/Context.js`；
  3. 该委派实例在 `vendor/upstream-webgl2/Context.js:409` 调用 GL **三参**签名 `RenderState.apply(gl, rs, ps)`，打到补丁层**两参** `Renderer/RenderState.ts:501 static apply(renderState, passState)`（无 `typeof` 守卫），于是 `gl` 被当成 `renderState` ⇒ `renderState.toPipelineState is not a function`，抛点在 `new Scene()` 构造期；`captureFrame` 只是把已存的 `failure` 原样 reject，故外层栈看似在 captureFrame；
  4. `scenarios/terrain-ready.js` 在 `createTerrainScene` 前执行 `prefetchDevice()` + `deviceHandoff.install(...)`（`:339-341`），故 T091 通过；`scenarios/terrain-interaction.js` 只做 `resetCycle()/resetSlot()` 而**没有 `install()`**（`:475-480`），槽为空 ⇒ 委派 ⇒ 崩。**这是该场景自身文件的集成缺口，不是产品缺陷。**

  **要求**：(a) 安装 hand-off 前 `MUST` 断言槽的状态、安装后 `MUST` 断言 `onStatus` 的 `active === backend`——"静默变成 WebGL2 运行"这类失败再也无法蒙混过关（本轮正是靠 `webgl2.contextRequests=1` 才识破）；(b) 每个使用替换版 `Context` 的宿主页场景都要有这一步，建议在 `AGENTS.md`/场景模板中固化为前置条件；(c) 该场景补齐后重跑 webgpu×2 + webgl2×1，并区分"确定性用法缺口"与"间歇性缺陷"。
  **勘误（必须留痕）**：入口 Agent 首次登记 T153 时据外层栈判定为"`captureFrame` 路径的产品缺陷"，并据此写入了"误标为场景未能建立"等要求——**该归因是错的**，由其自身丢失内层 `cause` 所致（见 T155）。真正需要的产品侧修复是 T154 与 T155。
  `层=契约`（`contract:interaction`）。`→ FR-001/FR-006/FR-011（二选一不得被静默绕过）, SC-001, T095 实测`
- [ ] T154（**追加编号**；由 T153 的根因链暴露，**产品代码缺陷**）**D2-a 的"整体委派 WebGL2"兜底路线一用就崩，而不是可用降级**：`vendor/upstream-webgl2/Context.js:409` 用 GL 三参 `RenderState.apply(gl, rs, ps)` 调用被别名替换为补丁层的 `Renderer/RenderState.ts:501 static apply(renderState, passState)`——补丁层保留了两参签名但**没有** `ShaderProgram.ts:988` 那样的 `typeof … === "function"` 守卫，于是把 `gl` 当 `renderState` 直接抛裸 `TypeError`。要求：(a) 实测复现（宿主页不安装 hand-off 即可，成本极低）；(b) 修法 MUST 使该兜底路线**真正可用**（对齐上游 GL 调用约定，或让静态 `apply` 兼容两种签名），**MUST NOT** 只把裸 `TypeError` 换成一条更漂亮的诊断就收工；(c) 断言"槽为空 ⇒ 委派 ⇒ 该次运行仍能出像素"，并断言委派发生时**显式可见**（状态/诊断里能看出 `active` 已不是 `webgpu`），不得静默；(d) 与 W6（T100/T101）的运行时兜底接线对齐，避免两处各写一套。`层=单元` + `层=契约`。`→ FR-006/FR-011, plan D2-a, T153 根因链`
- [ ] T155（**追加编号**；由 T153 的排查代价暴露，**诊断质量缺陷**）**`report.errors` 不携带内层 `cause`，根因定位被迫依赖 console 文本**：同一次失败里，产物 `report.errors` 只有外层 `message`/`stack`（"could not bring up the scene: …"），而能定位根因的**内层栈**（`RenderState.apply ← new Context$2 ← new Scene ← startTerrainScene`）只出现在 console sink 里。后果是实测的：入口 Agent 正是据此把 T153 归因错了（见其勘误）。要求：(a) 诊断在包装底层错误时 MUST 保留 `cause`（含其 `stack`），并可序列化进产物；(b) 断言"从产物 JSON 单独就能还原根因调用链"，不需要读 console；(c) 反例自检：把 `cause` 去掉后该断言必须变红。`层=单元` + `层=契约`。`→ FR-004/FR-009/FR-033（不得静默、须可诊断）, T153 实测`
- [ ] T156（**追加编号**；由 T091 在通过套件的同时上报的**产品发现**，产品代码缺陷）**`stats().triangleCount` 结构性恒为 0**：实测同一次运行 `drawCallCount=9`、`triangleCount=0`，而按索引数实测的三角数为 **172,800**（9 次绘制）。`FrameStatistics`（`api/types.ts`）是公开类型，且 T093 的几何类数值断言明确要用"三角数与 draw call 数异常"作为判据——**用一个人为恒 0 的字段做断言等于没有断言**。要求：(a) 修 `src/compose/**` 的统计来源，使 `triangleCount` 反映真实绘制量（与索引数口径一致，并写明口径）；(b) `层=单元` 断言"triangleCount 与索引数口径一致"，并给出"故意把索引计数清零 ⇒ 断言必红"的反例；(c) 若某条路径确实无法测量，MUST 用 `NaN` 而不是 `0`（沿用仓库既有约定：未测量不得冒充结论）。`→ FR-001, data-model §7.1, T091 上报` —— **根因已由 T091 精确定位（含建议修法）**：`src/compose/scene-runtime.ts:416-418` 的 tally **乘了 `command.instanceCount`**，而 Cesium 的 `DrawCommand` 对**非实例化**绘制默认 `instanceCount = 0`（`@cesium/engine` `Scene/DrawCommand.js:89`；`Renderer/Context.js:1367` 把 `0` 当"非实例化"处理）。同帧在补丁层 `Context#draw` 实测 **9 draws / 172,800 三角形 / 9 个互不相同的 index buffer**，与 tally 的 0 直接矛盾。建议修法：`instanceCount > 0 ? instanceCount : 1`。**注意这与 W5 黑帧根因是同一类陷阱**（WebGL 语义里 `instanceCount === 0` 表示 **1 个实例**，而 WebGPU 下 0 表示什么都不画）——本仓库已在这条语义上栽过一次，故修复 MUST 附带一条"非实例化绘制也要计入"的单元断言，并为 `instanceCount > 0` 的实例化路径各留一条。
- [ ] T157（**追加编号**；由 T091 上报的**产品发现**，产品代码缺陷）**`viewport.devicePixelRatio` 仅在画布"尚未布局"时生效，被交换链按客户端盒子覆盖**：实测两组对照——① 请求 `{320×200, dpr 2}` 且画布**已布局** → 实测后备存储 **320×200**（DPR 被忽略）；② 请求 `{200×150, dpr 2}` 且画布**未布局** → 实测后备存储 **400×300**（DPR 被遵守）。即**入口算得对、分歧发生在交换链**（T091 的现场定位，非我的推测）。后果：钉住视口是"可复现捕获"的前提（SC 可复现性），DPR 被吞掉会让同一用例在不同布局时机得到不同像素数。要求：(a) 交换链 MUST NOT 用"客户端盒子 × 浏览器全局 DPR"重算后备存储而覆盖调用方设定的尺寸；要么尊重调用方设定，要么接受显式尺寸参数；(b) `层=单元` + `层=契约`：两组对照（已布局/未布局）都断言后备存储 = CSS × 请求 DPR；(c) 反例自检：把交换链改回"按客户端盒子重算"，该断言必须变红。`→ FR-001（固定视口/可复现捕获）, SC-001, T091 上报` —— **机制已由 T091 精确定位，且我上一轮给的"选项 (a)"经实测不可行**：入口**确实**照请求写了 640×400（`scene-runtime.ts:665-670`），但**替换版 Context 的交换链立刻改回去**——`webgpu/swapchain.ts:181-197`（`resizeIfNeeded` / `#buildAttachments`）与 `resolveDrawingBufferSize`（`swapchain.ts:60-72`）在 `client-size` 分支用 `clientWidth × #dpr()`，而 `#dpr()` 默认取**页面**的 `devicePixelRatio`（=1），随后把 `canvas.width/height` 写回 320×200。⇒ **已布局的画布必然得到 客户端尺寸×页面DPR**，请求的 DPR 被吞。触发条件的判别性证据（T091 的对照实验）：宿主改为 `display:none`（无 CSS 布局 ⇒ 交换链回落到 canvas 属性）后请求 `200×150@2`，实测 **400×300** ⇒ 入口在无人覆盖时**确实**落实 DPR。两条实测均落盘为 `productFindings[1]`。修法二选一：把入口视口接进交换链（尊重调用方尺寸），或把该选项**如实**记为"仅对无 CSS 布局的画布有效"并让调用方可查询实际生效值——**MUST NOT** 只改文档措辞而让调用方以为它生效。
- [ ] T158（**追加编号**；由 T095 的运行暴露，**产品代码缺陷，且此前被诊断缺陷掩盖**）**索引缓冲区不带 `indexDatatype` ⇒ `_getGpuIndexFormat()` 抛错 ⇒ 帧失败、连带触发 T152 的作用域泄漏与一次 >1000 ms 卡顿**。实测（`artifacts/interaction/webgpu.json`，11:01:34）：
  - 诊断原文：`render-failed: the scene reported a render error: Buffer._getGpuIndexFormat: this buffer is not an index buffer (it carries no indexDatatype). WebGPU selects the index format per draw, so the caller MUST name an index buffer.`（`atMs=1675.9`）；
  - 紧接其后是 `error-scope: beginFrame() was called while the scopes of the previous frame were still open`（T152 的症状）；
  - 交互窗口帧时间 `p50=10 ms / p95=10.2 ms / p99=15.4 ms / **max=1201.3 ms**`，那一次 **1201.3 ms 连续卡顿**落在 `pan` 阶段第 10 步 ⇒ **SC-004（无 >1000 ms 连续卡顿）被违反**；
  - 结束帧几乎全黑（harness 截图 `nonBackground=1461/110592`，中心 `[0,0,0,255]`），而交互前捕获帧是 100% 覆盖（`nonBackgroundRatio=1`）⇒ **场景在交互过程中停止出像素**。
  - **勘误（入口 Agent 自纠）**：我曾据同目录产物写出"交互窗口 `max=1201.3 ms` ⇒ SC-004 被违反"。**该数值出自 T095 自己注入的 1200 ms busy-wait 反例臂**，不是自然卡顿——harness 每次 `runContractSuite` 都**覆写同名产物**，而反例是同一 spec 的第二个 `test`，于是它覆盖了测量臂的文件。测量臂的真实值（`artifacts/interaction/<backend>-interaction.json`）：**WebGL2 臂 `max=82.2 ms`、0 次 >1000 ms 卡顿、2 passed / exit 0**；**WebGPU 臂 `max=97.1 ms`、0 次卡顿，但 `1 failed / 1 passed、exit 1`**，失败点是 (b) **384 条 `render-failed` 诊断**（uncaught/console 仍 0）与 (c) 定格帧 `drawCallCount=0`（交互前 9）、覆盖率 1.32%。⇒ **SC-004 的卡顿条款在两臂都成立；WebGPU 的失败是 T158+T152**，且新证据把触发条件钉得更死：首条诊断 `atMs=1512.6`，而 `interaction-start=1452.7`、`pre-capture-done=1452.7`（此刻 draws=9、coverage=1）⇒ **第一次相机变更后约 60 ms 地形绘制即停止**。
  - **流程教训（复核时必须先问"这份产物属于哪条臂"）**：多 `test`/多臂的 spec 会互相覆写 `artifacts/<suite>/<backend>.json`；单看文件名无法判断臂别。建议后续把臂别写进产物文件名或 `runId`（例如 `<suite>/<backend>-<arm>.json`），并在复核清单里加一步"确认产物臂别"。

  - **因果留痕**：这条错误在上一轮诊断缺陷修复前会显示为不可读的 `internal … [object Object]`，正是被掩盖的；修好诊断通道后才显形。定位锚点：`Renderer/Buffer.ts:283-292`（`_getGpuIndexFormat()` 的守卫）与 `:269`（只有 `createIndexBuffer` 会挂上 `indexDatatype` 自有属性）、调用点 `Renderer/VertexArray.ts:242`、以及 `:434` 的 `fromGeometry` 路径。
  要求：(a) **先定位**是哪个绘制/哪条路径拿到"非索引缓冲区"当索引用（把诊断的 `extra`/`entryPoint` 与绘制日志对上），**MUST NOT** 先加默认值掩盖；(b) 修好后重跑并断言：无该诊断、无 `scopes still open`、交互窗口 `max` 不超阈值、结束帧覆盖率与交互前同量级；(c) 反例自检：让某个索引缓冲区不带 `indexDatatype`，该断言必须变红。`层=单元` + `层=契约`（`contract:interaction`）。`→ FR-030, SC-004, T152/T158 同源验证` —— **触发绘制的精确签名（由 T096 的仪表捕获，`artifacts/device-lost-terrain/webgpu.json` 的 `drawFailures`，把搜索面从"地形网格"缩到"非索引绘制"）**：
  ```
  drawFailures = { contextIndex: 0, frame: 33, category: "internal",
    message: "Buffer._getGpuIndexFormat: this buffer is not an index buffer (it carries no indexDatatype)…",
    command: { commandName: "DrawCommand", count: 15, indexCount: null,
               vertexArrayVertices: 6, primitiveType: 4, framebuffer: null } }
  ```
  **`indexCount: null` ⇒ 这是一次非索引绘制（`draw`，不是 `drawIndexed`）；6 个顶点 + `primitiveType: 4`(TRIANGLES) = 一个四边形——不可能是地形网格（每片上万顶点）。** 而 `VertexArray.toGpuIndexBuffer()`（`Renderer/VertexArray.ts:238-243`）对 `_indexBuffer === undefined` 是**正确返回 `null`** 的，所以现场必然是"`_indexBuffer` 有值、但那个 `Buffer` 不带 `indexDatatype`"。据此优先排查：① 由**探针/场景侧 helper**（如 `probe.js` 的 `createTriangleResources`/`createDepthIndicatorResources` 一类手工几何）构造的 VAO，是否把**普通 `Buffer`** 当 `indexBuffer` 传；② 逻辑层是否有"先 `Buffer.create` 再当索引缓冲用"的路径（只有 `Buffer.createIndexBuffer` 会在 `Buffer.ts:269` 挂上 `indexDatatype` 自有属性）。**修法必须让"非索引绘制"与"带索引缓冲的 VAO"这两件事不再互相矛盾，而不是给缺失的 `indexDatatype` 补一个默认值。** —— **触发条件已由 T096 大幅收窄（关键）**：`setView()` **本身**即可触发该缺陷，**与设备丢失无关**——在**全程无任何 device loss** 的对照页上，两次 `setView`（一次同距离的轻微旋视、一次细 LOD）都导致 `tiles.loaded=false`、覆盖率 **0**，并随后每帧刷 `error-scope: beginFrame() … scopes still open`。失败命令同为 **6 顶点 / 15 索引的 `DrawCommand`、`framebuffer:null`**。⇒ 这解释了 T095 的交互失败（旋转/缩放/平移 ⇒ 相机/LOD 变化）与那次 1201.3 ms 卡顿；**所以 T158 不是"某条罕见路径"，而是任何相机/LOD 变化都会踩到的路径**，必须按最高优先级修。T096 已把 setView 臂标为"未取得独立证据"，并在对照页断言"**失败必须是这个具名缺陷**"（若将来修好，套件会变红并提示把该臂提回断言路径）——这是正确的处置。
- [ ] T160（**追加编号**；由 T096 上报，**产品代码缺陷**）**设备丢失的顶层诊断分类失真**：`device-lost` 只出现在 `cause.category`，而**顶层**分类是 `render-failed`（T096 实测 `deliveredDiagnostics.topLevelCategories=["render-failed"]`、`deviceLostIdentityIn:"cause"`）。根因：`src/compose/scene-runtime.ts#reportRenderFailure` 把所有非地形 cause 一律归为 `render-failed`。影响：FR-004/FR-009 要求的"可区分"在**公开通道的顶层**失效——调用方按 `category` 分支就会把"设备丢失"当成普通渲染失败。要求：(a) 按 `cause.category` 分流（或保留 cause 但令顶层反映最具体者可归类者）；(b) 单元断言"设备丢失时顶层 category === `device-lost`"，并为"普通渲染失败仍为 `render-failed`"各留一条；(c) 反例自检：把分流改回一律 `render-failed`，断言必红。`→ FR-004/FR-009, T096 实测`
- [ ] T161（**追加编号**；由 T096 上报，**产品代码缺陷**）**FR-017 的资源账本在销毁/重建后不归零**：实测 `ledgerBefore.live=18 → ledgerAfterDispose.live=18, released=0 → ledgerAfterRebuild.live=**36**`，即旧设备的 18 条 Buffer **从未 release**（release 仅由 `Buffer`/`Texture`/`Renderbuffer#destroy` 调用）。T096 还做了**归因实验并否证**了"只是没 trim"：对已销毁 scene 调用 `_tileReplacementQueue.trimTiles(0)` 一条也没释放（36→36，`queue.count` 已落盘）。文档化修法二选一：W6 探测在装入 post-loss 设备时执行 `GpuResourceRegistry.reset()`（其注释本就写着"a new device means a new ledger"），或在 `scene.destroy()` 前释放地形瓦片资源。要求：(a) 修后断言"销毁+重建后旧设备 live 归零且 released 等于销毁前 live"；(b) 同时断言**新设备**的账本独立（不与旧账本混算）；(c) 反例自检：去掉释放路径，断言必红。`→ FR-017, T096 实测，与 W6（T099–T101）接线对齐`
- [ ] T162（**追加编号**；由 T093 的反例自检暴露，**产品代码缺陷**）**"数据不可用"会在画面上真的留洞**：T093 的 `fail:9/531/124` 反例（指定瓦片读取失败，即"删掉一块瓦片"）实测画面 **5.08% 变成清屏色 `0,0,0`**、`surfaceShare` 降到 94.58%；根因是 `src/terrain/source.ts` 的 `degrade()` 把失败瓦片降级为 **−6883 m 平地**，而在该固定相机下这片几何**没有出现在帧里**。⇒ FR-004 的"**其余瓦片继续渲染**"成立，但"**不出现空洞**"**不成立**，正是 FR-016 要抓的那类缺陷。要求：(a) 定位"降级平地为何不入帧"（几何被剔除？被深度遮挡？还是根本没提交——T093 的 `draws×索引数` 统计可用于对照）；(b) 修后断言：单瓦片失败时清屏色占比 ≈ 0 且该区域仍由**邻片或父级**覆盖；(c) 反例自检沿用 T093 的注入方式（`TERRAIN_GEOMETRY_INJECT=fail:<level>/<x>/<y>`，**零文件改动**）；(d) 与 T088 的"不给错误几何"要求一并复核——"不给尖刺"不等于"可以留洞"。`层=视觉` + `层=契约`。`→ FR-004/FR-016, T093 反例实测`
- [ ] T163（**追加编号**；由 T092 上报，**产品代码缺陷，优先级高**）**uniform 环形缓冲容量装不下多瓦片帧 ⇒ 整帧渲染失败 + 近空白帧；且近地细化到数据集不存在的层 ⇒ `tilesLoaded` 永不收敛**。实测（T092，两例相机：5.2 km / pitch −6 与 24 km / pitch −20）：`DEFAULT_COMMAND_SLOTS=8`（`backend-webgpu/webgpu/uniform-writer.ts:395`）在 `uniform ring buffer is full: 9216 bytes hold 9 slot(s)` 处失败 → **1498 条 render error**、合成器帧基本空白（前景仅 **1461 px**，即 credit 覆盖层）；另一条：近地细化到 **level 13**（固定数据集只有 **0–12** 层）⇒ `tilesLoaded` 在 30 s 内**永不为真**（1500 帧空转）。要求：(a) 环形缓冲 MUST 按帧内命令数扩容或提供**明确的降级策略**（例如"超容量即按可渲染子集绘制并给出可诊断提示"），**MUST NOT** 静默丢命令或整帧空白；(b) 细化请求超出数据集层数时 MUST 停在该数据集的**最大层**而不是无限请求不存在的层，并使 `tilesLoaded` 能收敛（或如实返回 `{loaded:false}` 并给出原因）；(c) 两条各配单元/契约断言与反例自检；(d) 修好后 MUST 按 `reference-frames/**/*.tolerance.json` 的 `baselineState.regenerationPolicy` **重新生成两条路径的参考帧**（相机可渲染范围会随之扩大，参考帧条件变了）。`层=单元` + `层=契约` + `层=视觉`。`→ FR-030/FR-015, SC-001/SC-002(rev), T092 实测`
- **给下一轮次的两条口径裁定（T095 提出的问题，入口 Agent 已定，勿再问）**：① T158/T152 修好后，**原样重跑** `--backend=webgpu --suite=contract:interaction` 复验四条判定，**不得**修改断言或阈值；② (c)"交互前后同区间"**接受** T095 的实现口径——`coverage 区间 + 色数相对带 + drawCall > 0`，理由是纯色场景下"逐像素差"本恒为 0（WebGL2 实测 45° 旋转 + 2× 缩放后 `differencePreToPost = 0`），故以"60 步轨迹在案 + 四个渲染侧仪器至少一个响应"作为"交互确实到达渲染器"的证据，其来源已写入文件头。


- [ ] T159（**追加编号**；由 T091 落盘但未断言的观察，**待判定是仪器口径还是捕获通道缺陷**）**`captureFrame()` 的读回通道与合成器截图不一致：前者纯色、后者 256 色**。实测（T091 的两条路径都如此）：页面内 `captureFrame()` 返回的像素 `uniqueColours=1`、`nonBackgroundRatio=1.0`，而**同一帧**的 harness 合成器截图为 256 色（中心 `[0,0,127,255]`）。两者"非背景占比"交叉检查（1.0 vs 1.0）通过，故 T091 只落盘、未断言——这是**正确**的处置（不确定口径时不拿它当判据）。要求：(a) 先判定成因：是"GPU 回读仪器的量化特性"（仓库既有教训：`uniqueColoursGpuReadback` 与 `uniqueColoursComposite` 口径不同，前者为 1 属仪器特性），还是 `captureFrame` 的读回通道**真的丢了信息**（若如此，凡以 `captureFrame().pixels` 为基础统计的公开 API 断言都建立在一条盲通道上）；(b) 判定 MUST 用**交叉判据**（例如同一帧里两通道的逐像素差、或在已知图案上比较两通道的直方图），**MUST NOT** 仅凭"两条通道占比都是 1.0"就下结论；(c) 若确为仪器特性，把它写进仪器口径文档并让 `FrameCapture` 的消费者可见；若确为缺陷，按 `render-failed` 立项修复。`层=单元` + `层=契约`。`→ FR-009/FR-033（可信读数）, data-model §7.1, T091 观察`







- [ ] T097 [US1] **切片 B 实现**（**范围收窄**：本任务只交付离屏深度纹理与深度拷贝路径；`Framebuffer`/`Renderbuffer`/`MultisampleFramebuffer`/`FramebufferManager` 的附件化实现归 T061/T062，`createViewportQuadCommand` 的 API 归 T044——本任务**只消费，MUST NOT 重复实现**）：离屏深度纹理 + 深度拷贝所需的 `createViewportQuadCommand` 消费路径（`GlobeDepth` 接线）。`层=单元` + `层=契约`；`自检`：`node --test "tests/unit/**/*.test.mjs"/offscreen-depth.test.mjs` 全绿；`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:offscreen-depth` 以 0 退出。`→ FR-030（帧缓冲）, research §7 切片 B` —— **开工前必读的实测（`docs/gate-g7-conclusion.md` §0，证据 `experiments/gates/out/g7-depth-msaa.json`，13 项测量 / 5 条结论全部确立）**：① 一个 pass 的所有附件**必须同采样数**（混采样被拒，同采样对照 LEGAL）；② 本机 Chrome **没有可用深度 resolve**（pass 的 `resolveTarget` 被 WebIDL **静默忽略**——回读得 `[0,0,0,0,0]` 而清除值是 `0.5`；`copyTextureToTexture` 4x→1x 被拒）；③ 片元着色器**可以**在 4 采样 pass 里写 `@builtin(frag_depth)`；④ 多采样深度纹理**可以**用 `texture_depth_multisampled_2d` + `textureLoad` 读取（朴素 `texture_depth_2d` 绑定被拒，报 `multisampled: 0`）⇒ **深度 resolve 可以在着色器里自己做**；⑤ 深度面能否拷贝是**格式属性**：`depth32float`/`depth16unorm` **可**拷，`depth24plus`/`depth24plus-stencil8` **不可**。**结论：切片 B 不必牺牲 MSAA**（③④ 各给一条合法路线），且任何需要离开 pass 的深度纹理 MUST 用 `depth32float`/`depth16unorm`。**MUST NOT** 依据 WebGL 惯例（多采样深度附件 + 单采样深度纹理作 resolve 目标）直接实现——该形态在本机无对应机制。
- [ ] T098a [US1]（`层=单元` + `层=契约`）**切片 B 阻断项（前半：功能翻转）**：把 `depthTexture` 翻转为 `true`，并重跑**本阶段已有的单元 + 契约套件**（两条路径各自独立运行）；断言 `sliceBComplete === true ⇒ depthTexture === true`（不一致即 CI 失败）。**全量验证（视觉 + 基准）重跑见 T098b**（Phase 10，位于 G-7 结论 T127 之后）；T098a + T098b 共同构成阻断项，**未同时完成不得宣告 FR-030 达成**。〖二选一〗`自检`（**不标 [P]**：改动能力表并触发回归）：`node --test "tests/unit/**/*.test.mjs"/capability-composition.test.mjs` 全绿 + 两路径契约套件（`contract:terrain-ready`/`contract:interaction`/`contract:device-lost-terrain`/`contract:offscreen-depth`）串行各以 0 退出 + `node tools/scripts/check-arch-boundaries.mjs --rules A8` 以 0 退出。`→ FR-030, plan Complexity Tracking（长期停留在降级态即视为 FR-030 未兑现）` ⛔ **阻断项（前半）**

**Checkpoint（US1 / W5）**：SC-001 / SC-002 / SC-004 在**两次独立运行**下各自通过；切片 B 已完成**功能翻转（T098a）**，**全量验证闭环（T098b）在 Phase 10 末尾、G-7 结论（T127）之后完成——T098b 通过后 US1 才完整达成 MVP**。

---

## Phase 8: User Story 2 - 新路径不可用时旧路径整体兜底（P1）｜ W6 双路径能力探测与整体兜底

**Goal**: 初始化阶段一次性完成"探测 → 选择 → 构造"；探测失败/超时（≤2 s）/低于下限时**整体**以 WebGL2 构造；
回退是销毁重建而非叠加；状态可观察；集成方代码零分支。
**Independent Test**: `node tests/support/backend-runner.mjs --backend=webgl2 --suite=contract:fallback`
（**独立进程**，强制 `navigator.gpu = undefined`）全绿，且该次运行中 WebGPU 的 GPU 对象创建数为 0。〖二选一〗

- [ ] T099 [US2] 能力探测 `packages/cesium-webgpu/src/render-path/probe.ts`：`navigator.gpu` 存在性 → `requestAdapter()` → `requestDevice()` → 必需特性与下限（`maxTextureDimension2D`/`maxVertexAttributes`/`maxSampledTexturesPerShaderStage`/`maxUniformBufferBindingSize`）； 产出 `CapabilityProbeResult`（`navigatorGpuPresent`/`adapterObtained`/`deviceObtained`/`adapterInfo`/`features`/`limits`/`elapsedMs`/`reason`）， `elapsedMs` MUST ≤ **2000**（超时即判不可用，`reason:"timeout"`）。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/probe-decision.test.mjs` （决策表逐条：不支持/无适配器/设备请求失败/缺特性/低于下限/超时，含注入假时钟的超时用例）。`自检`：该测试全绿。`→ FR-005, data-model §2.2`
- [ ] T100 [US2] 路径选择与整体切换 `packages/cesium-webgpu/src/render-path/select.ts`：`preference` 三态 （`webgl2` 不探测直接用上游原版后端；`webgpu` 探测失败 → 整体兜底；`auto` 把"不支持"视为正常结果）； 探测成功才安装设备交接槽；失败**不安装**（→ 上游原版 WebGL2 链路）；`decidedAt` 一经选定本会话内 MUST NOT 变更； `WholeSwitchRecord` 记录。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/path-selection.test.mjs`（三态决策 + 交接槽安装/不安装断言 + 无中间态）。`自检`：该测试全绿。`→ FR-005/FR-006, data-model §2.3`
- [ ] T101 [US2] C-1 / C-3 契约测试（`层=契约`）：`createTerrainScene` 在两条路径下都返回可用句柄且 `ready` MUST NOT reject； 强制 WebGPU 不可用后页面仍渲染地形、**2 秒内完成整体回退**、无未捕获错误、无空白画面。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:handle` 与 `--backend=webgl2 --suite=contract:handle --force-no-webgpu` 串行各以 0 退出。〖二选一〗`→ FR-005, SC-003, contracts/render-path-api §5（C-1/C-3）`
- [ ] T102 [US2] "本次只启用一条路径"的**可执行判据**（`层=契约`）：每次运行 MUST 断言**另一条后端的 GPU 对象创建数为 0**； 同会话双路径的用例 MUST 被判失败（A7）。`自检`：`node --test "tests/unit/**/*.test.mjs"/single-backend-invariant.test.mjs`（含"人为构造同会话双路径 fixture → 判定失败"反例）； `node tools/scripts/check-arch-boundaries.mjs --rules A7` 以 0 退出。`→ FR-006/FR-011, 原则 II, contracts/verification-and-benchmark §2`
- [ ] T103 [US2] C-4 整体切换契约测试（`层=契约`）：设备丢失后整体重建成功；`WholeSwitchRecord.destroyedResources > 0`、 `residualDraws === 0`；切换期 MUST NOT 同时提交两条路径的绘制；MUST NOT 以 CSS/画布叠加掩盖旧路径。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:whole-switch` 以 0 退出（独立进程）。〖二选一〗`→ FR-003/FR-006, contracts/render-path-api §3`
- [ ] T104 [US2] 可观察性（FR-009）：`onStatus` 回调与演示页状态区 MUST 展示当前生效路径、原因类别、是否降级、盲区备注； `degraded === true ⇒ notes` 非空；状态信息**仅供观察与排障**，业务代码 MUST NOT 依据 `status.active` 分支。`层=单元` + `层=契约`；`自检`：`node --test "tests/unit/**/*.test.mjs"/status-observability.test.mjs` 全绿；`node tests/support/backend-runner.mjs --backend=webgl2 --suite=contract:status` 以 0 退出。`→ FR-009, FR-023, data-model §2.5`
- [ ] T105 [US2] C-5 / C-6 架构边界断言（`层=架构边界`）：`node tools/scripts/check-arch-boundaries.mjs --rules A1,A2,A5` —— 调用方（演示页）源码无路径分支、`dist/index.d.ts` 无后端/GPU 符号、包入口不 re-export `./escape-hatch`、 `src/**` 不 import `backend-webgpu/**` 具体实现。`自检`：该命令以 0 退出。`→ FR-007, 原则 II, contracts/render-path-api §5（C-5/C-6）`
- [ ] T106 [US2] C-7 跨后端统计等价（`层=契约`）：`CrossBackendEquivalence{metric,webgpuRange,webgl2Range,overlapRatio,declaredDifferences}` —— 用**统计断言**（非背景覆盖率、颜色/深度分布、几何与 draw call 统计落在声明区间）判定等价； `declaredDifferences` MUST 显式声明无法消除的差异（亚像素边缘、MSAA 解析、sRGB、深度表示、WGSL 无精度修饰符的精度差、纹理 Y 翻转处理差异）； 两路径数据**分别采集、离线比较**。〖二选一〗`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:cross-equivalence` 与 `--backend=webgl2 --suite=contract:cross-equivalence` 串行各以 0 退出，再 `node tests/support/compare-offline.mjs --artifact=artifacts/cross-equivalence` 以 0 退出。`→ FR-008, SC-001, contracts/verification-and-benchmark §3`
- [ ] T107 [US2]（`层=契约` + `层=架构边界`）**W6 Checkpoint**：`node --test "tests/unit/**/*.test.mjs"` 全绿；两路径 contract 套件串行各自通过； `node tools/scripts/check-arch-boundaries.mjs --rules A1,A2,A5,A7` 以 0 退出；演示页手动打开两条路径各一次并记录状态区文案（**作为证据链接**，不作为判据）。`自检`：上述命令均以 0 退出。 〖二选一〗`→ FR-005/FR-006/FR-009, SC-003`

**Checkpoint（US2 / W6）**：SC-003 达成；US1 与 US2 均可独立运行并通过各自断言。

---

## Phase 9: User Story 3 - 渲染结果可自动化验证（P2）｜ W7 验证资产与测试基建

**Goal**: 让"地形渲染是否正确"完全由流水线判定：双路径独立运行脚手架、每路径各自参考帧、像素回归 + 统计断言、
差异图产物、容差来源可追溯、真机 WGSL 管线校验 harness、确定性冻结。
**Independent Test**: 人为引入一处渲染缺陷（如删掉一块瓦片 / 改错一个 uniform）后，
`node tests/support/backend-runner.mjs --backend=webgpu --suite=visual:terrain` 必须**失败**并产出差异图与差异区域。

- [ ] T108 [US3]（`层=契约` + `层=架构边界`）双路径独立运行脚手架产品化 `tests/support/backend-runner.mjs`：统一 `--backend`、`--suite`、`--seed`、`--viewport`、 `--output artifacts/`；**MUST NOT** 提供任何"同会话双路径 / 同帧对比 / 叠加 / 逐帧合成"入口（API 表面断言）。 `自检`：`node --test "tests/unit/**/*.test.mjs"/backend-runner-surface.test.mjs`（断言不存在同帧对比入口 + 每次运行只接受一个 `--backend`）。`→ FR-011, 原则 II, contracts/verification-and-benchmark §2`
- [ ] T109 [US3]（`层=单元`）验证资产包 `packages/cesium-webgpu/src/verify/**`：像素/统计断言、差异图生成、基准采集， **被 tests 与 CI 复用**（不得在 `tests/**` 里重复实现同一逻辑）。`自检`：`node --test "tests/unit/**/*.test.mjs"/verify-package.test.mjs` （断言断言器 API 与差异图生成器可独立调用、`tests/**` 未重复实现统计逻辑）。`→ FR-010/FR-013, plan「Project Structure」`
- [ ] T110 [US3] 统计量实现与 `FrameStatistics`：`nonBackgroundRatio`/`uniqueColorCount`/`depthDiscontinuityRatio`/`triangleCount`/ `drawCallCount`/`tileCount`/`frameTimeMs{p50,p95}`；`drawCallCount` 统计**真实** `drawIndexed`/`draw` 调用（WebGL2 侧通过包装平台 API `drawElements`/`drawArrays` 计数——包装平台 API 不是改上游实现）。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/frame-statistics.test.mjs` （对合成图像的已知统计值断言，含 p50/p95 计算正确性）。`自检`：该测试全绿。`→ FR-010/FR-016, FR-017, data-model §7.1`
- [ ] T111 [US3]（`层=契约`）参考帧机制：`reference-frames/<datasetId>/<caseId>.<backend>.png`（**每路径各自一份**）+ 元数据 （路径/浏览器版本/是否软件光栅化/相机与时间快照）；更新流程 MUST 经评审并在提交信息中说明原因，旧参考帧变更历史可追溯。`自检`：`node --test "tests/unit/**/*.test.mjs"/reference-frame-contract.test.mjs` （断言"同一 caseId 两条后端各自一份"、元数据字段齐备、缺少评审说明的更新被判失败）。`→ FR-010/FR-015, SC-009, contracts/verification-and-benchmark §1/§3`
- [ ] T112 [US3] 容差标定与 `ToleranceRecord{metric,threshold,unit,rationale,source,recordedAt}`：阈值写在测试代码中且**来源可追溯**； **MUST NOT** 采用"任意像素差异均通过"式判据；diff 比较区域排除抗锯齿边缘。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/tolerance-record.test.mjs` （含"`source`/`rationale` 为空 → 判定失败""阈值放宽但无变更理由 → 判定失败"两组反例）。`自检`：该测试全绿。`→ FR-014, data-model §7.3`
- [ ] T113 [US3]（`层=单元`）差异证据产物（FR-013）：验证失败时 MUST 产出**差异图 + 统计数值 JSON** 到 `artifacts/` 并作为 CI 产物保存；`VisualEvidence{runId,backend,referenceFrameId,diffImagePath,mismatchRatio,tolerance,regions[]}` 字段齐备。`自检`：`node --test "tests/unit/**/*.test.mjs"/visual-evidence.test.mjs` （含"人为注入缺陷 → 差异图与 regions 必须非空"的用例）。`→ FR-013, SC-009, data-model §7.2`
- [ ] T114 [US3] 真机 WGSL 管线校验 harness 集成（`层=视觉`）：`tools/shader-verify.mjs` 在有 GPU 环境跑真机 `createRenderPipeline`；无 GPU 环境 MUST 自动降级为 `naga --input-kind wgsl` 模块校验**并在产物中标注盲区** （不覆盖 varying 契约/绑定布局/格式兼容），保留本机复现步骤。`自检`：`node --test "tests/unit/**/*.test.mjs"/shader-verify-degradation.test.mjs` （断言降级时产物含 `degraded:true` 与盲区说明、MUST NOT 静默把降级结果当作真机通过）。`→ FR-023, contracts/verification-and-benchmark §4（SH-7）/§8`
- [ ] T115 [US3] 测试运行隔离断言（`层=架构边界`）：`VerificationRun.backend` 每次运行**只有一个**； `isolation ∈ {"separate-process","separate-page-load"}`，**MUST NOT** 为"同会话双路径"；`fixedConditions` 全字段必填。`自检`：`node --test "tests/unit/**/*.test.mjs"/verification-run-isolation.test.mjs`； `node tools/scripts/check-arch-boundaries.mjs --rules A7` 以 0 退出。`→ FR-011/FR-012, 原则 II, data-model §7.1`
- [ ] T116 [US3] 确定性冻结（`层=单元`，FR-012）：相机、场景时间、随机种子、视口尺寸、设备像素比、地形数据集、 MVP 场景配置（`baseLayer:false`/`skyBox:false`/`skyAtmosphere:false`/无后处理）全部固定；**重复运行结论一致** （同一提交重复运行不出现随机通过/失败）；无法消除的非确定性来源被**量化并记录**。`自检`：`node --test "tests/unit/**/*.test.mjs"/determinism-freeze.test.mjs` （断言固定条件对象逐字段存在；重复运行两次的统计差异在记录区间内）。`→ FR-012, SC-001④, 边界情形（重复运行的确定性）`
- [ ] T117 [US3]（`层=视觉` + `层=架构边界`）**W7 Checkpoint**：`node --test "tests/unit/**/*.test.mjs"` 全绿；两路径 visual 套件串行各以 0 退出且产出参考帧与差异图（失败用例）； `node tools/scripts/check-arch-boundaries.mjs --rules A7` 以 0 退出。`自检`：上述命令均以 0 退出。 〖二选一〗`→ FR-010~FR-016, SC-009`

**Checkpoint（US3 / W7）**：SC-009 达成；渲染结论不再依赖肉眼，且两条路径各有独立可复现的证据链。

---

## Phase 10: User Story 4 - 性能结论由数据支撑（P2）｜ W8 持续集成与基准基建

**Goal**: CI 上无 GPU 也能跑通两条路径的验证与基准；基准产出帧时间 p50/p95、图形显存代理指标、draw call 数并形成历史序列；
劣化超阈值即失败；单项提交到结论 ≤20 分钟；盲区显式记录。
**Independent Test**: 在 CI 上跑一次完整流水线（两路径各自独立运行）并产出 `history.jsonl`；
人为引入一处性能劣化后，基准门槛判定失败。

> ℹ️ **本阶段另承接 US1 的阻断项后半 `T098b`**：切片 B 的全量验证重跑 MUST 在 G-7 结论（T127）与验证资产
> （T111/T112/T121/T123）之后执行，故其位置在 Phase 10 末尾而非 Phase 7；这是使"G-7 早于切片 B 全量验证"
> **真实可满足**的唯一排布（详见 Phase 2 的 G-7 顺序说明与 T098b 正文）。

- [ ] T118 [US4] CI 工作流完成 `.github/workflows/ci.yml`：`install（`npm ci` + **`npx playwright install --with-deps chromium`** 浏览器安装）→ build → typecheck → unit（含 A1–A11）→ audit（AU-1…AU-5）→ shader（SH-3/SH-4/SH-7）→ contract+visual+bench（**两个并行 job：webgl2 与 webgpu，各自独立进程**，job 内顺序 contract → visual → bench） → 汇总（任一失败阻断合入）`；全部门禁 ≤20 分钟。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/ci-workflow.test.mjs` （用 T004 锁定的 `yaml` 解析断言门禁顺序、断言 `npx playwright install --with-deps chromium` 步骤存在、**两条路径分属不同 job 且不共享页面/进程**、汇总 job 依赖全部前置 job）。`自检`：该测试全绿。`→ FR-021/FR-022, SC-005, contracts/verification-and-benchmark §7`
- [ ] T119 [US4] 无 GPU 两套降级配方固化到 CI：WebGPU 路径 = Xvfb（**必须 headed**）+ Mesa lavapipe + 固定标志 （`--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --disable-gpu-watchdog --no-sandbox`）； WebGL2 路径 = ANGLE/SwiftShader（`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`）； **MUST NOT** 写入无效/过时标志。**浏览器版本（A3）**：CI 用 Playwright 自带 Chromium，任务 MUST 记录其主版本并断言 **≥ 尖刺真机基线 Chrome 153**；不满足即 STOP 上报入口 Agent，**MUST NOT** 静默降级配方。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/ci-degradation-flags.test.mjs`（标志白名单 + 两路径配方互斥断言 + 浏览器主版本被记录且 ≥153 断言）。`自检`：该测试全绿。`→ FR-023, contracts/verification-and-benchmark §8`
- [ ] T120 [US4] 着色器转换工具链安装（仅一次性转换与 CI 校验，**不进入运行时**）：`glslang 16.6.0` **官方 Linux 预编译包**（零编译成本） + `cargo install naga-cli --version 30.0.1 --locked`（**naga 无预编译二进制**；`--locked` 只锁依赖图，**版本 MUST 由 `--version 30.0.1` 显式锁定**，CI MUST 缓存 `~/.cargo`；MUST NOT 出现"下载 naga 二进制"式步骤） + `@webgpu/glslang 0.0.15` 若使用 MUST 显式引 `dist/web-devel-onefile`；三个版本与锁定值写入 workflow 注释与 `upstream/engine-26.3.0.lock.json` 的 `toolchain` 段一致。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/ci-shader-toolchain.test.mjs` （用 `yaml` 解析断言：存在 `cargo install naga-cli --version 30.0.1 --locked`（**缺 `--version 30.0.1` 即失败**）、存在 cargo 缓存步骤、**不存在**任何 naga 二进制下载步骤）。`自检`：该测试全绿。`→ contracts/fork-patch-layer R8, quickstart §1, 尖刺 §1/§7.3`
- [ ] T121 [US4] 基准采集（`层=基准`）：帧时间 p50/p95（固定预热 120 帧、采样 600 帧，CI 缩减并记录缩减方式）、 图形显存**代理指标**（`GpuResourceRecord.bytes` 汇总）、draw call 数（真实 `drawIndexed`/`draw` 计数）； 记录 `EnvironmentFingerprint{os,cpu,gpu{vendor,architecture,type},browser,browserVersion,playwrightVersion,backend,degraded,timestampMode}`； 两条路径 MUST 在**各自独立会话**采集。〖二选一〗`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=bench:terrain` 与 `--backend=webgl2 --suite=bench:terrain` **串行**各以 0 退出并写出 `BenchmarkRecord`。`→ FR-017, SC-006, data-model §8.1/§8.2`
- [ ] T122 [US4] 基准存档与历史序列（FR-020）：结果追加写入 `artifacts/history.jsonl`，形成可比较的历史序列 （含 commit、环境指纹、三项指标、是否降级）。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/benchmark-history.test.mjs` （追加语义、不得覆盖历史、字段齐备）。`自检`：该测试全绿。`→ FR-020, SC-006`
- [ ] T123 [US4] 量化回归门槛（`层=基准`，FR-018）：帧时间/显存劣化超阈值即**判定失败**并输出与基线的差值； 门槛变更 MUST 记录理由与影响（`ToleranceRecord.threshold` + `rationale`）。`自检`：`node --test "tests/unit/**/*.test.mjs"/benchmark-gate.test.mjs` （**人造劣化必须使判定失败**、无基线时给出明确提示而非静默通过）。`→ FR-018, SC-006, 原则 IV`
- [ ] T124 [US4] 降级运行的结论口径（FR-023）：`degraded === true` 时基准结论 MUST 标注为**相对**回归意义， 并在记录中显式写出降级方式与盲区；MUST NOT 据此宣称性能收益。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/benchmark-degradation.test.mjs`。`自检`：该测试全绿。`→ FR-023, US4④, data-model §8.1`
- [ ] T125 [US4] 受门控的真实 GPU 作业：`.github/workflows/` 中新增 `gpu:absolute`（真实 GPU 的绝对性能与 `timestamp-query` 剖析）， **默认不执行**，必须由入口 Agent 上报用户批准预算后才可手动触发；未批准时绝对性能标记 `degraded:true`。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/gpu-job-gating.test.mjs` （断言该 job 不在默认触发路径上、需显式手动触发、文件内含"需预算批准"说明）。`自检`：该测试全绿。`→ 原则 IV, mvp-estimate §5「执行门禁」`
- [ ] T126 [US4] CI 产物上传（原则 V）：构建日志、测试报告、差异图、统计 JSON、`history.jsonl`、 `artifacts/patch-scope-audit.json`、`artifacts/upgrade-drill.json`、`artifacts/shader-verify/**`、**`experiments/gates/out/*.json`（G-1…G-7 门禁结论）**、`artifacts/slice-b-full-validation.json` MUST 上传归档（**证据口径**：真机门禁结论由**本机真机**产生并随仓库入库，CI 负责归档与一致性断言；CI 无 GPU 时其 WGSL 校验为降级形态，盲区见 T134）。`层=单元`：`node --test "tests/unit/**/*.test.mjs"/ci-artifacts.test.mjs` （用 `yaml` 解析断言产物路径覆盖上述九类（含门禁 JSON），且失败时仍上传 `if: always()`）。`自检`：该测试全绿。`→ 原则 V, FR-022, contracts/verification-and-benchmark §7`
- [ ] T127 [US4]（`层=基准` + `层=单元`）**W8 Checkpoint**：CI 完整跑通一次（两路径各自独立运行）并产出全部产物；`node tools/scripts/check-gate.mjs --gate g7` 以 0 退出（**G-7 门禁结论在此正式落盘**；其唯一消费点是 **T098b**（切片 B 全量验证，紧随本任务之后），二者顺序在阶段序下**真实可满足**——不再要求 G-7 早于 Phase 7 的 T098a）； 单次提交到结论耗时 ≤20 分钟（记录实测值）。`自检`：CI 运行记录 + `node tools/scripts/check-gate.mjs --gate g7` 以 0 退出。 `→ FR-017~FR-025, SC-005/SC-006`

- [ ] T098b [US1]（`层=视觉` + `层=基准`）**切片 B 阻断项（后半：全量验证闭环 + G-7 消费）**：在 **G-7 结论（T127）**与验证资产（T111 参考帧机制、T112 容差记录、T121 基准采集、T123 回归门槛）**均已落盘之后**，重跑**全量验证**（单元 + 契约 + 视觉 + 基准，两条路径各自独立运行）并把产物归档。**顺序说明**：本任务置于 Phase 10 末尾，使"G-7 结论早于切片 B 全量验证"在阶段序下**真实可满足**（原先要求 G-7 早于 Phase 7 的 T098，与 G-7 自身依赖 Phase 9/10 资产相矛盾）。〖二选一〗`自检`（**不标 [P]**：跨阶段全量回归）：两路径全量套件串行各以 0 退出 + `node tools/scripts/check-gate.mjs --gate g7` 以 0 退出 + `artifacts/slice-b-full-validation.json` 落盘。`→ FR-030, SC-001/SC-006, plan Complexity Tracking（阻断项后半）` ⛔ **阻断项（后半）**

**Checkpoint（US4 / W8）**：SC-005 / SC-006 达成；CI 成为唯一事实来源，本地通过不再等价于通过——**并须待 T098b 通过后方可宣告 W8 整体收口**。

---

## Phase 11: User Story 5 - 拿到 MVP 的工期与 AI/Agent 消耗结论（P2）｜ W9 开源交付、文档与评估交付

**Goal**: 交付开源形态（LICENSE / NOTICE / CONTRIBUTING / 可复现构建说明 / fork 基线与补丁范围说明 / rebase 演练手册 /
降级与盲区说明）并让评估结论（FR-026~FR-029 / SC-007）成为**受 CI 契约测试保护、可回填、可版本化**的交付物。
**Independent Test**: `node --test "tests/unit/**/*.test.mjs"/mvp-estimate-contract.test.mjs` 全绿（schema 校验 + 口径断言 + 工作流齐备 + 单价来源可追溯）；
`node tools/backfill-actuals.mjs --dry-run` 以 0 退出。

> **本阶段不重新撰写评估结论**：`mvp-estimate.md` 与 `mvp-estimate.v1.json` 已存在且为 v2.1.0，
> 本阶段的交付是**评估结论的 CI 契约测试、回填机制与版本化机制**，外加 **T148 承接的 FR-019 治理规则**（优化提交的基线强制）。

- [ ] T128 [US5] 评估结论的 CI 契约测试（`层=单元`）：`tests/unit/mvp-estimate-contract.test.mjs` + `tools/scripts/lib/json-schema-lite.mjs`（仓库内自实现的**最小 JSON Schema 子集校验器**，避免新增依赖）—— 按 [contracts/mvp-estimate.schema.json](./contracts/mvp-estimate.schema.json) 校验 `mvp-estimate.v1.json`，并断言： (a) `meteringBasis.includesHumanCost === false`；(b) `meteringBasis.statement` 含"**人工成本不计入**"； (c) `workflows` 齐备（≥5 且含 W1–W9，每项有 `timeDays`/`agentTurns`/`tokens`/`modelCost`/`computeCost`/`assumptions`）； (d) `priceSources[]` 的 `source` 匹配 `^https?://` 且 `consultedAt` 为日期（**单价来源可追溯**）；(e) 币种为 CNY 主 + USD 副且含汇率来源与日期； (f) `actualsBackfill` 结构合法（未交付时可为 `null`）；**(g) FR-029 显式断言（不得只依赖整体 schema 校验）**：`confirmedItems` 为非空数组且每项为非空字符串；`unconfirmedItems` 每项含 `item`（非空）、`impactDirection`（∈{`up`,`down`,`both`}）、`impactMagnitude`（非空）、`note`（非空）。`自检`：`node --test "tests/unit/**/*.test.mjs"/mvp-estimate-contract.test.mjs` 全绿 （含"把 `includesHumanCost` 改成 true → 失败""删掉 statement 中的口径字样 → 失败"两组反例）。`→ FR-027, FR-028, SC-007`
- [ ] T129 [US5]（`层=单元`）`actualsBackfill` 回填机制（FR-028）：`tools/backfill-actuals.mjs` —— 首个增量实际交付后回填 实际工作日、实际输入/输出 token（含缓存命中/未命中拆分）、实际算力费用、与估算区间的偏差说明， 并作为后续增量的估算基线；回填 MUST 递增结论版本并按 `revisionPolicy` 保留历史版本。`自检`：`node --test "tests/unit/**/*.test.mjs"/actuals-backfill.test.mjs` （schema 校验回填结果、断言版本必须递增、未交付时 `actualsBackfill: null` 合法）；`node tools/backfill-actuals.mjs --dry-run` 以 0 退出。`→ FR-028, mvp-estimate §8`
- [ ] T130 [US5]（`层=单元`）偏差说明机制（SC-008）：`docs/delivery-deviation.md`（**不设硬性交付期限**；交付时给出可追溯的时间区间； 实际用时超出区间时 MUST 书面说明偏差原因与新预期）+ `tools/check-deviation.mjs`（断言存在区间声明与偏差说明章节）。`自检`：`node tools/check-deviation.mjs` 以 0 退出； `node --test "tests/unit/**/*.test.mjs"/deviation-doc.test.mjs` 全绿。`→ SC-008, FR-028`
- [ ] T131 [US5]（`层=单元`）`README.md`：项目定位（**用 WebGPU 渲染后端替换上游 WebGL2 渲染后端**）、快速开始（`npm ci` → `npm run build` → 两条路径**分别**运行）、 补丁层边界声明（改动只落 `Source/Renderer/**`）、上游基线与版本、许可证与署名、指向 `docs/**` 的索引； **MUST NOT** 写入代理地址或本机绝对路径。`自检`：`node --test "tests/unit/**/*.test.mjs"/readme-contract.test.mjs`（断言关键章节齐备、无本机绝对路径、无代理地址、命令均为 Node/npm 跨平台形式）。`→ FR-024, 全局约定 4`
- [ ] T132 [US5]（`层=单元`）`CONTRIBUTING.md` 完成：写入**补丁边界规则**（改动只能落在 `Source/Renderer/**`；清单条目 MUST 有 `requirementRef` 与 `reason`； 上游内部改动 MUST 走升级演练；跳过测试 MUST 附理由并在 PR 说明，禁止长期无条件跳过）、评审须给出原则 I–V 合规说明与证据路径。`自检`：`node --test "tests/unit/**/*.test.mjs"/contributing-contract.test.mjs`（断言五条规则与"证据路径"要求齐备）。`→ FR-024, FR-019（协同 T148）, 原则 I/II/V, constitution 测试与验证策略`（FR-019 的硬规则由 **T148** 紧邻追加到本文件同一节，不得另起文件）
- [ ] T148 [US5]（`层=单元`）**FR-019 治理承接：优化提交的基线强制**：把"任何性能优化 MUST 先提供基线数据，并在提交中附『基线 vs 优化后』实测对比；无基线对比的优化 MUST NOT 合入"落成三处硬约束，并与 T132 **同一文件同一节**：(a) `CONTRIBUTING.md` 新增"性能优化提交规则"小节；(b) `.github/PULL_REQUEST_TEMPLATE.md` 必填项"性能优化基线对比"（`baseline-ref`、`after-ref`、指标口径、差值）；(c) `tools/scripts/check-optimization-baseline.mjs` + CI 门禁——提交/PR 命中优化特征（diff 触及渲染热路径或提交信息含 `perf:`）却缺基线对比数据时 **拒绝合入**（非 0 退出）。`自检`：`node --test "tests/unit/**/*.test.mjs"/optimization-baseline-rule.test.mjs`（含"带 `perf:` 但无对比 → 失败""带完整对比 → 通过""非优化提交 → 免检"三组用例）；`node tools/scripts/check-optimization-baseline.mjs --self-test` 以 0 退出。`→ FR-019, FR-021, contracts/verification-and-benchmark §5/§7`
- [ ] T133 [US5]（`层=单元`）`docs/rebase-runbook.md` + `docs/fork-notice.md`：补丁形态选择依据、上游基线版本与完整性哈希、 **逐条列出被重实现的文件与理由**（与 `manifest.json` 一致）、升级演练两种模式（干跑 / 完整）的执行步骤与"三项齐备才可合入"判据、 失败处置路径。`自检`：`node --test "tests/unit/**/*.test.mjs"/rebase-runbook.test.mjs`（断言清单与 manifest 一致、两种模式与三项判据齐备）；`node tools/scripts/check-license-notice.mjs` 以 0 退出。`→ FR-032, 原则 I, contracts/fork-patch-layer §6/§7`
- [ ] T134 [US5]（`层=单元`）`docs/ci-degradation.md` **定稿**：两套软件适配器配方、降级运行的判定与标注方式、 **全部盲区**（软件光栅化 ≠ GPU；无 GPU 时间戳；headless 下 WebGPU 画布呈现不可靠故 MUST headed； lavapipe 报错文本与真实驱动可能不同；浏览器版本漂移改变像素；**naga WGSL 校验不覆盖 WebGPU 管线校验**） 与**本机真机复现步骤**，并 MUST 复述**证据口径**（C2 约定：真机门禁证据由本机产生并入库、CI 负责归档与一致性断言；渲染与基准结论仍只认 CI 产物）。`自检`：`node tools/scripts/check-degradation-doc.mjs` 以 0 退出（断言五个盲区条目、**证据口径**与本机复现步骤齐备）。`→ FR-023, 原则 V, contracts/verification-and-benchmark §8`
- [ ] T135 [US5]（`层=单元`）`docs/reproducible-build.md`：Node ≥22 前提、`npm ci` 锁定（精确版本 + integrity）、 着色器工具链版本锁定（`glslang 16.6.0` / `naga-cli 30.0.1` / `@webgpu/glslang 0.0.15` 显式 `dist/web-devel-onefile`）、 构建产物校验（`dist/index.d.ts` 无后端符号、逻辑层零覆盖）与"如何验证构建可复现"。`自检`：`node --test "tests/unit/**/*.test.mjs"/reproducible-build-doc.test.mjs` 全绿。`→ FR-024, 附加技术约束`
- [ ] T136 [US5] quickstart 复现验证（`层=契约`）：按 [quickstart.md](./quickstart.md) §2→§6 逐步实跑 （补丁边界自检 → 两条路径**分别**运行演示 → 视觉回归 → 基准 → CI 等价复现），把每条命令的实跑结论与产物路径记入 `docs/quickstart-validation.md`；发现与实际不符处 MUST 以"实现偏离"条目上报入口 Agent（**不得**由本阶段自行改 `quickstart.md`）。〖二选一〗`自检`：`node --test "tests/unit/**/*.test.mjs"/quickstart-validation.test.mjs`（断言 §2–§6 每节均有实跑结论与产物路径）。`→ SC-001/SC-003/SC-010, quickstart §0`
- [ ] T137 [US5] 演示页完善：状态区（当前路径 / 原因类别 / 是否降级 / 盲区备注）、地形数据**署名可见**（`Attribution.shownInDemo === true`）、 瓦片加载进度、"模拟设备丢失"入口（`device.destroy()`）、数据集选择；**MUST NOT** 出现后端分支代码。`层=契约`；`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:demo` 与 `--backend=webgl2 --suite=contract:demo` 串行各以 0 退出； `node --test "tests/unit/**/*.test.mjs"/demo-attribution.test.mjs`（断言署名非空且展示位存在）。〖二选一〗`→ FR-009, FR-024, data-model §6.4`
- [ ] T138 [US5]（`层=单元`）**W9 Checkpoint**：`node --test "tests/unit/**/*.test.mjs"/mvp-estimate-contract.test.mjs` + `node tools/backfill-actuals.mjs --dry-run` + `node tools/check-deviation.mjs` + `node tools/scripts/check-license-notice.mjs` + `node tools/scripts/check-degradation-doc.mjs` + `node tools/scripts/check-optimization-baseline.mjs --self-test` 全部以 0 退出。`自检`：上述六条命令均以 0 退出。 `→ FR-019, FR-024, FR-026~FR-029, SC-007/SC-008`

**Checkpoint（US5 / W9）**：SC-007 / SC-008 达成；开源交付形态齐备，评估结论受 CI 保护且可回填。

---

## Phase 12: Polish & Cross-Cutting Concerns

**Purpose**: 跨切面收尾、终局证明与验收映射。
**⚠️**：本阶段依赖全部前序阶段；其中 T141 是 SC-010 的**终局证明**，MUST NOT 以任何单点证据替代。

- [ ] T139 全量回归：`node tools/scripts/run.mjs ci:local`（构建 → 类型检查 → 单元 → 审计 → 着色器校验 → 两路径契约/视觉/基准**串行各自独立运行**）全部以 0 退出；记录总耗时。`自检`：该命令以 0 退出且耗时记录落盘 `artifacts/ci-local.json`。`→ FR-021/FR-022, SC-005`
- [ ] T140 [P] 架构边界总门禁（`层=架构边界`）：`node tools/scripts/check-arch-boundaries.mjs --rules A1,A2,A3,A4,A5,A6,A7,A8,A9,A10,A11` 以 0 退出，产物 `artifacts/arch-boundaries.json` 归档为 CI 产物。`自检`：该命令以 0 退出。`→ SC-010, FR-007, data-model §11`
- [ ] T141 [P] **SC-010 终局证明**：`PatchScopeAudit.verdict === "pass"` + `logicLayerOverrides === 0`（补丁范围审计）+ 依赖完整性哈希一致 + `UpgradeDrillRecord.verdict === "pass"`（升级演练，三项齐备）三者同时成立， 证据路径写入 `docs/sc010-evidence.md`。`自检`：`node tools/audit-patch-scope.mjs && node tools/scripts/verify-upstream-integrity.mjs && node tools/upgrade-drill.mjs --dry-run` 全部以 0 退出；`node --test "tests/unit/**/*.test.mjs"/sc010-evidence.test.mjs` 全绿。`→ SC-010, FR-031/FR-032, 原则 I/V`
- [ ] T142 [P] 稳定性与泄漏复核（`层=单元`）：长时运行下帧 N 与帧 N+K 的活跃 GPU 资源集合在稳态不增长； 重复运行结论一致；`dispose()` 后后端资源计数归零。`自检`：`node tests/support/backend-runner.mjs --backend=webgpu --suite=stability:leak` 与 `--backend=webgl2 --suite=stability:leak` 串行各以 0 退出（用例文件 `tests/benchmark/stability-leak.spec.mjs`）。〖二选一〗`→ FR-025, data-model §5.1`
- [ ] T143 [P] 跳过测试治理：`node tools/scripts/check-skips.mjs` —— 断言 `tests/**` 中不存在长期无条件 `skip` （存在即要求 `reason` 字段并在 PR 说明）；MUST NOT 用 `skip` 代替差异断言。`自检`：`node tools/scripts/check-skips.mjs` 以 0 退出；`node --test "tests/unit/**/*.test.mjs"/check-skips.test.mjs` 全绿。`→ 原则 III, contracts/verification-and-benchmark §3/§7`
- [ ] T144 主干可构建 / 可运行 / 可回退（FR-025）：在干净检出上 `npm ci && npm run build && node --test "tests/unit/**/*.test.mjs"` 通过； 回退演练（切到上一提交后仍可构建与运行）记录到 `docs/reproducible-build.md` 的"可回退"小节。`自检`：上述命令以 0 退出且文档小节存在。`→ FR-025, 原则 V`
- [ ] T145 文档与清单一致性核对：`docs/**` 中引用的文件路径与命令均存在（`node tools/scripts/check-doc-links.mjs`）； `tasks.md` 勾选状态与实际产物一致；产物路径与 `.github/workflows/ci.yml` 上传段一致。`自检`：`node tools/scripts/check-doc-links.mjs` 以 0 退出。`→ 原则 V, FR-022`
- [ ] T146 验收映射表 `docs/acceptance-matrix.md`：逐条把 **SC-001…SC-010** 与 **FR-019**（治理工件承接，见 T148）、**FR-030~FR-033** 映射到 任务 ID + 验证层 + CI 产物路径（无产物路径的判据视为未达成）。`自检`：`node --test "tests/unit/**/*.test.mjs"/acceptance-matrix.test.mjs` （断言 SC-001…SC-010、FR-019 与 FR-030~FR-033 全部有映射且每条含产物路径或规则文件路径）。`→ SC-001…SC-010, FR-019, FR-030~FR-033`
- [ ] T147 收尾：确认本清单**未**新增 Out of Scope 任务（影像/模型/大气/阴影/后处理/粒子/矢量标注/移动端一律无实现任务， 仅有"显式 `not-implemented` 失败"边界任务）；确认 `specs/001-webgpu-terrain-mvp/analysis.md` **已由 `/speckit-analyze` 整体重新生成**（含本清单的修复记录与复核结论），本任务 MUST NOT 改写该报告的历史发现记录；如需重跑分析，走 `/speckit-analyze`。`自检`：`node --test "tests/unit/**/*.test.mjs"/out-of-scope-boundary.test.mjs`（断言任务清单中不存在上述功能的实现任务）。`→ spec「Out of Scope」, plan 阶段 3 说明`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**：无依赖，可立即开始。
- **Phase 2 验证门（G-1…G-6）**：依赖 Phase 1（工具链与骨架）；**阻塞 Phase 3 及之后的一切实现任务**。
  - `G-1 → G-2 → G-4 → G-3 → G-5 → G-6` 按 plan 的实现顺序推进；任一失败 → STOP + 上报入口 Agent 修订 `plan.md`。
  - **G-7（T028–T029）为例外**：plan 明示"G-7 与验证资产并行"；其判定依赖 Phase 9/10 的验证资产与 CI 配方（T108–T126），
    因此 T028/T029 的执行与 Phase 9/10 对应的资产建设**并行**；**结论在 T127（Phase 10）落盘，由紧随其后的 T098b 消费**。
    顺序约束落到 **T098b**（而非 Phase 7 的 T098a）——这是唯一在阶段序下真实可满足的排布（见 Phase 2 的 G-7 顺序说明）。
- **Phase 3 Foundational（W1）**：依赖 Phase 2 门禁通过；**阻塞 Phase 4 起的全部 user story**。
- **Phase 4–7（US1 = W2 → W3 → W4 → W5）**：严格串行（每一段是下一段的输入）；W4 与 W3 之间仅共享 `manifest.json` 与
  `format-map`/`bind-layout` 的接口，可小范围并行，但**验收顺序不变**。
- **Phase 8（US2 = W6）**：依赖 Phase 4 的 `device-handoff` 与 Phase 3 的 `src/status/**`；与 US1 的 W5 有接口交集（场景构造），
  故建议在 W5 之后立即执行；US2 的契约测试必须在 W5 的地形用例可运行后才有意义。
- **Phase 9（US3 = W7）**：依赖 US1 与 US2 的契约用例存在；**参考帧机制（T111）与容差记录（T112）由本阶段建立**，其后被 T098b 与 CI 消费（不存在"本阶段依赖自己产物"的循环）。`src/verify/**` 可与 US2 并行开发。
- **Phase 10（US4 = W8）**：依赖 US3 的基准采集与容差资产；`gpu:absolute` 需预算批准（默认不执行）；**并承接 US1 的阻断项后半 T098b**（切片 B 全量验证闭环，位于 T127 之后）。
- **Phase 11（US5 = W9）**：文档与评估契约测试可在 US1–US4 期间并行起草，但**结论文档 MUST 在对应阶段完成后定稿**。
- **Phase 12 Polish**：依赖全部前序阶段；T141（SC-010 终局证明）依赖 Phase 3 与 Phase 10 的产物。

### User Story Dependencies

- **US1（P1）**：无跨 story 依赖；是 MVP 主体（W2–W5 + Phase 10 的 T098b 闭环）。
- **US2（P1）**：与 US1 同级；依赖 US1 的 `device-handoff` 与场景构造接口（共享文件），**兜底路径本身 MUST 有独立测试覆盖**。
- **US3（P2）**：依赖 US1/US2 的可运行场景（用于产出参考帧与统计基线）。
- **US4（P2）**：依赖 US3（复用 harness、容差与统计）。
- **US5（P2）**：评估结论的 CI 契约测试与 `actualsBackfill` 机制可与实现并行；文档定稿在最后。

### Within Each Phase（铁律）

- 门禁未通过不得进入其门控的实现任务。
- 每个渲染特性任务之后**紧邻**其验证任务（本清单已按此成对排列）；验证层 MUST 在任务中标注。
- 契约/视觉/基准类验证 MUST 为两次独立运行（独立进程 + 独立页面加载），跨后端比较 MUST 离线。
- **证据口径（原则 V + plan「实现前的验证门」）**：**真机门禁证据（G-5/G-6 的 `experiments/gates/out/*.json` 与 `artifacts/shader-verify/**`）由本机真机产生并随仓库入库**，
  CI 承担其可承担的校验（无 GPU 时 = `naga` WGSL 模块级校验 + 门禁 JSON 的存在性/一致性断言，盲区见 T134）；
  **渲染与基准结论仍只认 CI 产物**——CI 未跑通或未归档即视为未通过（本地通过不等于通过，FR-022）。

---

### Parallel Opportunities

> **标注口径（I14 澄清）**：以下阶段级"可并行"仅为**文件交集层面的建议**；**权威标注是个体任务的 `[P]`**。
> 未标 `[P]` 的任务即使出现在下方清单中，也 MUST 满足其正文注明的依赖与"串行执行"要求；二者冲突时以任务正文与 `[P]` 为准。

- **Phase 1**：T002、T005、T006、T007、T011、T012、T013 之间无文件交集，可并行（T003→T004 串行；T001→T009→T010 因共享 `package.json` 串行）。
- **Phase 2**：G-1/G-2 与 G-4/G-3 之间在**不同 `experiments/gates/<id>/` 目录**内，可两两并行；G-5/G-6 依赖尖刺 harness，可与 G-3/G-4 并行；G-7 与 Phase 9/10 并行。**T149（G-4 逐目标实现重跑，W2 决策 R-1 承接）依赖 G-4 本体（T018/T019），MUST 在其通过后于每个目标实现上执行，且需真机环境（不标 `[P]`）**。
- **Phase 3**：T037/T038/T039/T040 相互独立可并行（T031→T032→T033 串行；T035 先于 T036；T041 收口，其 `localFile` 存在性校验在 T037 之后执行）。
- **Phase 5**：T055/T056/T059/T060 可并行（不同资源类文件）；T057 与 T061/T062 串行（`format-map` → 附件化实现）。
- **Phase 6**：T066/T068 可并行；`T069→T070→T073→T074` 串行（T074 的深度范围修正在发射器 T073 之内进行）；T075/T076/T077 可并行（不同文件，但都依赖 T073 的内部接口）。
- **Phase 7**：T084→T085 串行；`T086 →（T087,T088,T090）可并行 → T089`（T089 的 `createTerrainScene` 消费 T086 的地形适配层，故 MUST 在 T086 之后）；T092/T093/T094 可并行（不同 spec 文件，但**不得同时运行**——串行执行以免违反"每次只启用一条路径"）。
- **Phase 9/10**：`tests/support/**` 与 `tools/**` 的任务可并行；CI 相关任务在 `.github/workflows/ci.yml` 单文件上**串行**修改；**T098b（阻断项后半）MUST 在 T127 之后执行，且不得与 T127 并行**。
- **Phase 11**：T131–T135 与 **T148** 文档/治理任务可并行（T132 与 T148 同文件但不同小节，MUST 串行落地或由同一子代理一次完成）；T128/T129/T130 相互独立可并行。
- **Phase 12**：T140–T143 可并行；T139/T144/T145/T146/T147 串行收尾。

> ⚠️ **并行不得破坏二选一语义**：任何两条验证任务即使并行开发，其**执行**也 MUST 分属独立进程/独立页面加载，
> MUST NOT 在同一会话内并发渲染同一场景。

### Parallel Example: Phase 5（W3 资源层）

```bash
# 可并行的三个资源类实现任务（不同文件、无相互依赖）：
node --test "tests/unit/**/*.test.mjs"/buffer-mapping.test.mjs      # T055
node --test "tests/unit/**/*.test.mjs"/texture-mapping.test.mjs     # T056
node --test "tests/unit/**/*.test.mjs"/vertex-array-mapping.test.mjs # T060
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

### MVP First（US1 / W2–W5 + Phase 10 的 T098b）

1. 完成 Phase 1（骨架）→ Phase 2（门禁 G-1…G-6）→ Phase 3（W1 补丁层工程化）。
2. 依次完成 Phase 4（W2 后端核心）→ Phase 5（W3 资源层）→ Phase 6（W4 着色器前端）→ Phase 7（W5 地形端到端 + 切片 B **功能翻转 T098a**）。
3. **STOP and VALIDATE**：US1 的 Independent Test 在两条路径**两次独立运行**下各自通过；CLI/演示页可演示地形。
4. Phase 8–10 完成后执行 **T098b**（全量验证闭环，消费 G-7 结论）；**T098b 通过后** MVP 的"地形在新后端跑通 + 全量验证闭环"才算完整达成；US2 完成后 SC-003 才闭环。

### Incremental Delivery

1. Phase 3 结束 → 补丁边界与升级演练可审计（可独立评审）。
2. Phase 4 结束 → WebGPU 后端可接管场景构造与命令提交。
3. Phase 7 结束 → 地形端到端通过（MVP 核心，含切片 B 功能翻转）。
4. Phase 8 结束 → 二选一与整体兜底闭环（SC-003）。
5. Phase 9/10 结束 → CI 成为唯一事实来源（SC-005/SC-006/SC-009），**且 T098b 闭环切片 B 全量验证**。
6. Phase 11 结束 → 开源交付与评估结论齐备（SC-007/SC-008），**且 FR-019 治理规则（T148）随 CONTRIBUTING 生效**。

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
- 切片 B 的 `depthTexture=true` 翻转（**T098a**）与其**全量验证闭环（T098b）**共同构成**阻断项**：未同时完成不得宣告 FR-030 达成。
- **FR-019（优化提交的基线强制）由 T148 承接**（`CONTRIBUTING.md` 硬规则 + PR 模板必填 + CI 断言），与 T132 同一文件同一节；本清单因此对 FR-001~FR-033 全部有任务承接。
- **G-7 顺序**：G-7 结论在 T127 落盘、由 T098b 消费；MUST NOT 用"以某任务优先"式文字掩盖不可满足的依赖（见 Phase 2 与 T098b 正文）。
- 评估交付（FR-026~FR-029 / SC-007）在本清单中只做**契约测试 + 回填机制 + 版本化机制**（T128–T130），**不重新撰写评估**。
- `analysis.md` 已由 `/speckit-analyze` 依据本清单整体重新生成（含 31 条发现的处置记录与修复后复核）；如需重跑，走 `/speckit-analyze`（T147）。
