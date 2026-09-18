# Specification Analysis Report — WebGPU 地形渲染 MVP（CesiumJS 1.145.0 外部模块）

**Feature**: `001-webgpu-terrain-mvp` | **阶段**: 3.5（`/speckit-analyze`，实现前最后一致性门禁）
**Date**: 2026-09-18 | **分析范围**: `spec.md` / `plan.md` / `tasks.md` + `research.md` / `data-model.md` / `contracts/`（4 份）/ `quickstart.md` / `mvp-estimate.md` / `mvp-estimate.v1.json` / `.specify/memory/constitution.md`
**只读声明**: 本阶段**未修改** `spec.md`、`plan.md`、`tasks.md` 或任何设计产物；本报告是唯一新增文件。
**Hook 检查**: `.specify/extensions.yml` 不存在 → 未注册 `before_analyze` / `after_analyze` 钩子（静默跳过）。
**前置命令**: `& '.specify\scripts\powershell\check-prerequisites.ps1' -Json -RequireSpec -RequireTasks -IncludeTasks`
→ `{"FEATURE_DIR":"E:\\work\\CesiumjsWebGpu\\specs\\001-webgpu-terrain-mvp","AVAILABLE_DOCS":["research.md","data-model.md","contracts/","quickstart.md","tasks.md"]}`
（`spec.md` / `plan.md` / `tasks.md` 三者齐备，前置条件满足；`git status --short` 为空、HEAD=`3ff57f7`。）

---

## 0. 结论摘要（先读这一段）

| 项 | 结论 |
|---|---|
| **是否建议进入实现** | **否 —— 不建议按当前 `tasks.md` 直接进入阶段 4**。存在 3 项 CRITICAL，其中 2 项会导致按 phase 顺序执行时**无法达成 Phase 4/5 Checkpoint**，1 项与 constitution 原则 I（NON-NEGOTIABLE）冲突。修正量都不大（见 §7 建议动作），但必须先修。 |
| CRITICAL / HIGH / MEDIUM / LOW | **3 / 7 / 15 / 7**（共 32 条，未超 50 条上限） |
| 未覆盖的 FR / SC | **0 / 0**（29 条 FR 与 9 条 SC 在 ID 级 100% 有任务承接） |
| 子句级覆盖缺口 | **3 处**（FR-004 第二子句、FR-029 第三子句、FR-019/FR-025 仅流程承接） |
| 契约级缺口 | **1 处**（契约 §1 公开导出 `listDatasets`/`getDatasetManifest` 无任务承接） |
| `[P]` 标注核对 | 30 个 `[P]` 中：**3 个硬违规**（T011/T013/T023）、**5 个前提可疑**（T020/T024/T027/T038/T068）、22 个成立 |
| Out of Scope 泄漏 | **无**（详见 §6） |
| CI 可执行性 | 可行，但有 4 处需修（pwsh 前提过时、YAML 自检不可行、缺 Playwright 安装步、CI 步骤 [3] 前置依赖未落地） |
| 建议下一步 | 先做 §7 的 3 项 CRITICAL 修正（建议以 `speckit-converge` 或人工编辑 `tasks.md` 追认），再进入 `/speckit-implement` |

---

## 1. CRITICAL 发现（阻塞项）

### C-01 [CRITICAL] `T005` / 退路 V2 依赖上游 `@private` 内部语义，与 constitution 原则 I（NON-NEGOTIABLE）冲突，且 plan 未按 Governance 要求论证例外

- **证据**
  - `constitution.md:5-9`：原则 I —— 「禁止依赖非公开（私有/下划线前缀）内部 API」「一切扩展必须通过 CesiumJS 公开 API、官方扩展点与外部模块适配层完成」。
  - `research.md:15-16`：本项目自定的公开性判据下，`DrawCommand` 明确属于 `@private` 类（原文：「`@cesium/engine` 的包入口会导出全部模块（含 `Context`、`DrawCommand` 等 `@private` 类）……"能被 import" **不等于**"是公开 API"」）。
  - `research.md:65`：`Scene.frameState` 为 `@private`（列在 §1.2 黑名单）。
  - `tasks.md:80`（T005）：要求「自实现 `Primitive` 放入 `scene.primitives`，在 `update(frameState)` 中扫描 `frameState.commandList`，按 `DrawCommand` 的**公开字段** … 反推本帧被绘制的瓦片集合；**先核实并记录** `DrawCommand.owner` 的实际语义」。
  - `plan.md:337`（G-2 失败退路）与 `research.md:432`（H-2 退路）：把 V2 作为既定备选方案。
  - `plan.md:314-325`（Complexity Tracking）：4 项取舍中**没有** V2 这一项，即未记录「违反原则的例外」。
  - `constitution.md:105`（Governance）：「违反原则的例外与额外复杂度必须在 plan 或 PR 中显式论证，并记录被否决的替代方案及理由」。
  - 防线缺口：A1–A5（`data-model.md:465-471`、`tasks.md:123`）只扫描 `src/**`、`apps/demo/src/**` 与 `dist/index.d.ts`；A4 的规则是「`from "cesium"` 后访问 `\._[a-zA-Z]`」——**不含下划线的 `DrawCommand` / `FrameState` 命名导入不会被 A4 捕获**；`research.md` §1.2 黑名单也未列 `DrawCommand`/`FrameState`，因此 `T024` 的 `public-api-allowlist.ts` 黑名单很可能同样漏掉它们。
- **影响**：G-2 若判定不等价（`tasks.md:81-82` 明确可能发生），W1 的"绘制集合"实现输入将依赖非公开内部语义；CI 的手段（A1–A5、T024、T072 的许可证/结构检查）都无法阻断，原则 I 的保护会在实现期静默失效。属**条件性 CRITICAL**：仅在 V2 被选中时激活，但 plan/tasks 已把它写成既定退路，故必须在实现前收敛。
- **建议动作（三选一，须在 T005 执行前定稿）**
  1. 在 `plan.md` Complexity Tracking 增列 V2 一行（按 Governance 要求给出例外论证 + 被否决的更简方案），并把 V2 限定为**诊断专用、不进入交付包、不 import 上游类型（仅结构化鸭子类型读取，且不依赖 `owner` 语义）**；
  2. 或把 `tasks.md` T005 改为「**仅评估** V2 可行性；结论为不可用时直接记录 `V2 不可用`，禁止以 `owner` 反推瓦片」，并把 `DrawCommand`/`FrameState` 写入 `research.md` §1.2 黑名单与 T024 数组；
  3. 或删除 V2，为 G-2 另定一条**不触碰非公开 API** 的退路（例如放宽"静止态等价"判据的取值范围，改由 `T006` 的统计区间与上游公开的 `globe.tileLoadProgressEvent`/`tilesLoaded` 组合判定），并在 `plan.md:336-338` 表格中同步更新。

### C-02 [CRITICAL] Phase 3（声明为阻塞 phase）内 `T023 [P]` 的并行前提不成立：与 `T021` 同文件、与 `T022` 共享测试文件

- **证据**
  - `tasks.md:119`（T021）：创建 `packages/cesium-webgpu/src/core/tile-registry.ts`，**未标 `[P]`**。
  - `tasks.md:121`（T023）：开头即写「**在 T021 的模块内**实现绘制集合截断规则」，自检为「`node --test tests/unit/tile-registry.test.mjs` 中的 drawSet 用例……全绿」。
  - `tasks.md:120`（T022）：创建并拥有 `tests/unit/tile-registry.test.mjs`。
  - `tasks.md:304`（Parallel Opportunities）：「**Phase 3**：T016、T017、T018、T020、T023、T024 可并行（不同文件）」——与上面三条直接矛盾（T023 既非"不同文件"，也非"无未完成依赖"）。
  - `tasks.md:112`：Phase 3 被标注为「**⚠️ CRITICAL**：本 phase 完成前，不得开始 Phase 4 的任何实现任务」——即该 phase 本身是串行门禁，`[P]` 误标的风险被放大。
  - `tasks.md:22` / `:357`：`[P]` 的定义是「不同文件、无未完成依赖」。
- **影响**：若入口 Agent 按 `tasks.md:304/357` 并行派发 Phase 3 的 6 个 `[P]` 任务，T023 会在 `tile-registry.ts` 尚不存在时启动，并与 T022 并发写同一个测试文件 → 依赖倒置 + 同文件覆盖（工作丢失/相互冲突的实现）。这直接违反本 phase 的阻塞语义。
- **建议动作**：把 T023 的 `[P]` 去掉，并在描述中显式写「依赖 T021、T022（同文件：`core/tile-registry.ts` 与 `tests/unit/tile-registry.test.mjs`）」；同时从 `tasks.md:304` 的并行清单中移除 T023（改为「T023 依赖 T021/T022，串行」）。

### C-03 [CRITICAL] 阶段依赖倒置：Phase 4/5 的验证任务依赖 Phase 5/6 才产出的资产，与「Phase 4/5 Checkpoint 可独立验收」自相矛盾

- **证据**
  - `tasks.md:136`（Phase 4 Independent Test）：「`npm run test:contract …` 与 `npm run test:visual` 在 `webgpu` 路径下通过……不依赖 US2/US3 的探测与 CI 资产」；`tasks.md:167`：「**Checkpoint**：US1 可独立验收」。
  - `tasks.md:161`（T042）：测试流程要求「加载**演示页**」——而演示页由 `tasks.md:186`（T051，**Phase 5**）创建。
  - `tasks.md:162`（T043）：「逐像素比较（容差来自 `tolerances/tol-v1.json`）」+「失败时产出 `…/{capture,reference,diff}.png`、`stats.json`、`evidence.json`」——`tol-v1.json` 由 `tasks.md:208`（T059，**Phase 6**）创建、`tasks.md:211`（T062）标定；差异图/统计由 `tasks.md:206-207`（T057/T058，**Phase 6**）创建。
  - `tasks.md:163-164`（T044/T045）：断言依赖 `FrameStats` 序列与 `nonBackgroundRatio`/`uniqueColorCount`/深度统计 → `T057`（Phase 6）。
  - `tasks.md:190-191`（T052/T053，Phase 5）：断言 `nonBackgroundRatio>0.15`、`uniqueColorCount≥64`、以及**"声明区间"**（`T061`，**Phase 6**）。
  - `tasks.md:288`（Phase Dependencies）：仅声明「Phase 9 依赖全部前序 phase」，未声明 Phase 4 依赖 Phase 6。
- **影响**：按 `tasks.md` 的 phase 顺序执行时，Phase 4/5 的验证任务**无法在各自 phase 内通过**，`tasks.md:334`（"STOP and VALIDATE：US1 与 US2 的 Checkpoint 独立通过 → 这是最小可演示单元"）不可达；MVP 最小可演示单元实际被推迟到 W3 之后，与 `MVP First` 策略（`tasks.md:328-335`）冲突。
- **建议动作（二选一）**
  1. 把验证基建前移：将 T056–T059（`harness.ts`/`capture.ts`+`stats.ts`/`compare.ts`/`tolerances/tol-v1.json`）从 Phase 6 移入 Phase 3（Foundational）或 Phase 4 开头，并在 Phase Dependencies 中补一条「Phase 4 依赖 T056–T059」；
  2. 或保留现结构但在 `tasks.md` 的 Dependency 段显式登记跨 phase 前置（「T042 依赖 T051」「T043/T045 依赖 T057–T059」「T052/T053 依赖 T057/T061」），并把 Phase 4/5 的 Checkpoint 判据改为"仅契约就绪 + 统计内联实现"，把像素回归结论留给 Phase 6。

---

## 2. 发现清单（HIGH / MEDIUM / LOW）

| ID | 类别 | 严重度 | 位置 | 摘要 | 建议动作 |
|---|---|---|---|---|---|
| H-01 | `[P]`/依赖 | HIGH | `tasks.md:94,97,99,303`；`tasks.md:95` | **T011 `[P]` 与 T008/T013 `[P]` 同文件且依赖倒置**：T008 创建根 `package.json`、T013 创建三个子包 `package.json`，T011 却要"安装并锁定根与子包 devDependencies/peerDependencies"并生成 `package-lock.json` → 必须在这两个文件存在之后执行，且三者会互相覆盖 `package.json`。T009 `[P]` 的自检 `npx tsc -p tsconfig.base.json --noEmit` 同样需要 T011 先装 `typescript`。`tasks.md:303` 仍称「T008、T009、T010、T011、T013 可并行（不同文件）」 | 改为：T008 → T013 → T011 串行（或 T011 表述为"仅执行 `npm install` 并由 T008/T013 负责声明依赖"，并把 T009 自检改为 `node --test`/脚本化检查）。同步修 `tasks.md:303` |
| H-02 | 覆盖缺口（契约级） | HIGH | `contracts/render-path-api.md:17`；`plan.md:208`；`tasks.md:157` | 契约 §1 规定主入口导出 `listDatasets` / `getDatasetManifest`（来源 `./api/datasets.js`），`plan.md` 结构含 `src/api/datasets.ts`，但 **`tasks.md` 全文无 `datasets.ts`**；而 T041 的自检要求「`index.ts` 只导出契约 §1 列出的符号」→ T041 按字面无法达成 | 在 T041 的文件清单中加入 `src/api/datasets.ts` 并补单元测试；或从契约 §1 与 `plan.md` 结构中删除这两个导出（需同步改契约，属设计变更） |
| H-03 | 判据/产物矛盾 | HIGH | `tasks.md:264`；`mvp-estimate.md:54-58,83-89`；`mvp-estimate.v1.json:41-123` | T076 断言⑦「每个工作流的 `modelCost` 可由 `tokens × priceSources` 复算（**≤1% 舍入误差**）」。按 `mvp-estimate.md` §3.1 的记录模型（min=100% flash/空闲/命中 0.92；max=80% flash+20% v4-pro/高峰/命中 0.75）**本机实测复算**：W1–W6 的 max 全部吻合（偏差 ≤0.03%），min 端 **W5/W6 偏差 1.52%**（复算 ¥0.2538 vs 记录 ¥0.25），超过 1% 阈值 → 按字面实现该 CI 门禁必然失败 | 二选一并写进 tasks：① 阈值改为「绝对误差 ≤¥0.01 或相对 ≤2%（记录为 2 位小数舍入）」；② 在 T076 中固化复算模型常量（命中率/时段/模型配比），并把 W5/W6 记录值改为 0.26 或 0.2538（后者需同步改 `mvp-estimate.md` §3.3 并按 `revisionPolicy` 递增版本） |
| H-04 | `[P]` 前提 | HIGH | `tasks.md:118,143,117,305,318` | **T020/T027 `[P]` 无未完成依赖的前提不成立**：T020 是 T019 的测试、T027 是 T026 的测试，自检均要求"全绿"（即实现已存在）；`tasks.md:304` 自己承认「T019/T021 被同 phase 的测试与生产模块依赖，不标 `[P]`」——同一逻辑未施加于 T020/T027。另：**T027 `[P]` 未出现在 Phase 4 的并行清单**（`tasks.md:305` 与 `:318` 只列 T026/T033/T034/T036/T038/T040 六个），标注与清单互相不一致 | T020/T027 去掉 `[P]`（改为「依赖 T019/T026」）；或保留 `[P]` 但把定义改为"可并行编写、不可并行自检"并同步 `tasks.md:22/357` 的定义；同时把 T027 补入或明确排除于 Phase 4 并行清单 |
| H-05 | 交叉引用/阶段序 | HIGH | `tasks.md:162` vs `:208,211,165` | T043 显式引用 Phase 6 的 `tolerances/tol-v1.json`（T059/T062），并写「US3-IS 的前置：在 **T047** 正式做对照实验」——对照实验实际是 **T046**（缺陷注入）与 **T062**（容差标定），T047 是能力探测任务，交叉引用错误 | 修正为 T046/T062；把容差引用改为"Phase 4 使用内联初值，Phase 6 收敛到 `tol-v1.json`"或在 Dependency 段登记 T043→T059 |
| H-06 | CI/阶段序 | HIGH | `tasks.md:228` vs `:257` | T067 的 CI 步骤 `[3] unit（含 A1–A5 与**评估文档契约**）`引用 T076（**Phase 9**）的 `tests/unit/mvp-estimate-contract.test.mjs`：CI 自 T067 落地到 T076 完成之间不可能全绿，与 FR-021/FR-022/FR-025「每次提交三绿、主干始终可运行」冲突 | 在 T067 明确「评估文档契约测试于 T076 落地后并入步骤 [3]」，或把 T076 提前到 Phase 7 之前（其依赖仅 `mvp-estimate*.json` 与 schema，均已存在） |
| H-07 | 不可实现的断言（待确认） | HIGH | `tasks.md:161(b),191(b),192(a)`；`contracts/render-path-api.md:85-121` | T042 断言 `scene.drawingBufferWidth/Height`、T053 断言 `globe.show===true` 与 `baseColor`、T054 用 `device.destroy()` 触发 `GPUDevice.lost`——但契约 §3 的 `TerrainSceneHandle` **不暴露** `scene`/`globe`/`device`，而 A5（`tasks.md:123`）禁止演示页直接引用 `cesium` → 三条断言按字面不可实现 | 待确认设计意图后择一：① 在契约中新增**测试专用**诊断访问器（如 `handle.diagnostics.upstreamObjects`，标注非稳定 API）；② 改为经 `captureFrame().width/height`、`handle.path`、`handle.events.pathChange` 等等价公开断言；③ 明确允许 Playwright 通过 `./escape-hatch` 子路径注入脚本并写入契约 |
| M-01 | 术语漂移 | MEDIUM | `plan.md:105,130,137,147,151` vs `contracts/verification-and-benchmark.md:124-133`、`tasks.md:228` | plan 引用「CI 步骤 [8]」「[7]」「步骤 [1]–[8]」，而契约 §6 与 T067 只定义 **[1]–[6]**（许可证检查 = [6]） | 统一为 [1]–[6]；plan.md 的 5 处引用同步改号 |
| M-02 | 二义 | MEDIUM | `tasks.md:257`；`plan.md:49`；`tasks.md:244` | T076「自实现所需子集校验器，**或引入 `ajv`** 作为 devDependency 并在 PR 说明」是二选一，未定稿。（结论：**ajv 非必需**；若引入，devDependency **不违反** `plan.md:49`「无**运行时**第三方依赖」，且 MIT 在 T072 允许集合内） | 定稿为"自实现子集校验器"，并列出支持的 JSON Schema 关键字（type/required/const/enum/pattern/minItems/items/properties/additionalProperties/minimum/exclusiveMinimum + date/date-time 正则显式实现）；若要引入 ajv，则精确锁版本、只进 `devDependencies`、并在 T011 的清单与 T072 的允许集合中同步登记 |
| M-03 | 不可执行的完成判据 | MEDIUM | `tasks.md:147,149,151,153,155,156,157,182,210` | 多个自检把文件参数写成了中文占位符：`grep -nE "…" **该文件**`（T031/T033/T035/T039/T040/T041/T047）、`grep -n "declaredDifferences" **证据文件**`（T061）；T037 的「`grep` 断言数量匹配」无具体命令 | 把占位符替换为真实路径（如 `packages/cesium-webgpu/src/adapters/cesium/camera.ts`），T037 给出可执行命令；否则"完成判据"不可复现，且 `grep` 报 "No such file" 时非零退出会被误读为"无命中" |
| M-04 | 自检风格/可移植性 | MEDIUM | `tasks.md:100,191,228,229,230` vs `:123` | 自检混用 shell 与 PowerShell：T014 `grep -r "pwsh" package.json tools/ .github/ 2>$null`（`2>$null` 是 PowerShell 语法，`grep` 需宿主机 PATH；本机为 Git 版 grep，CI 为 GNU grep，二者皆非 Node）；而 T025 明确要求扫描器"零第三方依赖、**不使用** shell 命令" | 统一为 Node 脚本自检（`node tools/scripts/check-no-pwsh.mjs`）或在 tasks 中注明"需 Git Bash/GNU grep"；保持 T025 的零依赖风格一致 |
| M-05 | 环境前提过时 | MEDIUM | `tasks.md:36-38,100,229,246` | 全局约束 1 写「**本机无 `pwsh`（PowerShell 7）**」——**本机实测已安装 pwsh 7.6.6**（`C:\Users\Administrator\AppData\Local\Microsoft\WindowsApps\pwsh.exe`），Windows PowerShell 5.1 亦在；T014/T068/T074 与 README 的"禁止 `pwsh` 假设的说明"基于该错误前提 | 改写为「CI 步骤 MUST NOT 依赖 `pwsh`（ubuntu-latest 无 PowerShell）；本机 PowerShell 5.1/7 均可用，脚本优先 Node 以确保跨平台一致」；README 不必声明"禁止 pwsh"，改为"脚本不依赖 PowerShell 版本" |
| M-06 | 自检不可行 | MEDIUM | `tasks.md:228` | T067 自检「本地用 `actionlint`（若可用）或 `node -e` 的 YAML 解析校验语法」：本机实测 **PATH 中无 `actionlint`**；Node 22 无内置 YAML 解析器，而计划禁止第三方运行时依赖 → 该自检大概率空转（"若可用"使其可被跳过） | 改为：`npx --yes actionlint`（需联网，须注明）或新增一个精确版本的 YAML 解析 devDependency；否则把自检改为"由 GitHub Actions 实跑一次 workflow 作为语法证据"并明确记录 |
| M-07 | 缺步骤 | MEDIUM | `tasks.md:228` vs `contracts/verification-and-benchmark.md:144-150` | 契约 §7 的前置命令含 `npx playwright install --with-deps chromium`（第 147 行），T067 只列了系统包 `mesa-vulkan-drivers xvfb libvulkan1`，未列 Playwright 浏览器安装 → 步骤 [5] 两个 job 很可能因缺浏览器失败 | 在 T067 的步骤中补 `npx playwright install --with-deps chromium`（Playwright 版本已由 T011 固定） |
| M-08 | 构建依赖缺口（待确认） | MEDIUM | `tasks.md:97,98,186`；`plan.md:45-46` | T012/T051 需用 Rollup 打包**引用 `cesium`（bare specifier，peer dep）**的演示页，但 T011 的精确 devDependencies 清单与 `plan.md` 的构建依赖列表均**无 `@rollup/plugin-node-resolve`**（也未提 import map/CDN 方案）→ 演示页与主包产物可能无法解析 `cesium` | 待确认：在 T011 加入 `@rollup/plugin-node-resolve`（精确版本），或明确演示页使用 import map 指向 CDN/本地 vendor 的 `cesium`；两者都需在 `plan.md` 的构建链中同步 |
| M-09 | 子句级覆盖 | MEDIUM | `spec.md:131`（FR-004 第 2 句）；`tasks.md:144,147,148,120` | FR-004「MUST 以**可观察方式区分"数据不可用"与"渲染失败"**两种状态」只有实现（T028/T031/T032 上报 `TileError.category`）与 `no-data` 几何断言（T022），**没有任何任务断言两种状态在可观察层面可区分**（如 `events.error` 的类别、诊断文案或 `path/manifest` 层判定） | 在 T022 或 T032 的自检中增加断言：同一固定数据集下注入「瓦片缺失（no-data）」与「解码失败」两类输入，分别产出可区分的事件/类别（并写入 `docs/architecture.md` 的状态表） |
| M-10 | 子句级覆盖 | MEDIUM | `spec.md:171`（FR-029 第 3 句）；`tasks.md:257-265`；`contracts/mvp-estimate.schema.json:162`；`mvp-estimate.v1.json:210-216` | FR-029「凭据类地形服务已明确后置……**MUST NOT 作为本增量的消耗项计入**」在产物中已正确落地（`exclusions` 第 2 条），但 T076 的 7 条断言**不含 `exclusions`**，schema 也只要求 `exclusions` 非空数组 → 该约束无 CI 保护 | 在 T076 增加第 8 条断言：`exclusions` 中存在同时含「凭据/令牌」与「不计入」语义的条目（关键字匹配，与 ④ 的写法一致） |
| M-11 | 数据模型漂移 | MEDIUM | `data-model.md:419-446` vs `contracts/mvp-estimate.schema.json:29-131`、`mvp-estimate.v1.json:36-39,46,127` | `data-model.md` §8 的 `MvpEstimate` TS 接口缺 schema 中的必填/既有字段：`meteringBasis.selfHostedHardware`（schema:34 必填、:67-71 定义）、`workflows[].agentTurns`（schema:80）、`totals.agentTurns`（schema:108）、`scenarios`/`planningValue`/`baselineGapNote`/`actualsBackfill`（schema:132-182，JSON 中均存在） | 以 `mvp-estimate.schema.json` 为准回写 `data-model.md` §8 的接口（设计产物同步；不改 spec） |
| M-12 | 断言粒度 | MEDIUM | `tasks.md:123,125-126,112` | A1–A5 五项架构边界断言全部集中在**单个任务 T025**，而 Phase 3 Checkpoint 与 A1–A5「能阻断违规实现」完全依赖它；单点失败会导致五项保护同时缺失，也无法按断言独立验收 | 拆为 T025a–T025e（或至少在 T025 内列出五项分项自检与各自的反例 fixture 路径），使 Checkpoint 可按断言逐项核对 |
| M-13 | 跳过 vs 断言 | MEDIUM | `tasks.md:192` vs `:360`、`constitution.md:95` | T054 允许在某分支无法稳定注入时标 `test.fixme`（Playwright 记为 expected-failure/skip，**CI 呈绿**），而 `tasks.md:360` 与 constitution 测试策略要求「禁止以条件跳过代替断言」「跳过必须附理由、禁止长期无条件跳过」→ 形成"绿色但未断言 FR-003 分支"的缺口 | 保留 `test.fixme` 但附加**到期条件**（关联 issue + 复核日期 + `docs/ci-degradation.md` 中的盲区编号），并由 T081 在交付复核中逐条确认；或改为 `test.fail()` 使之必须真实失败才通过 |
| M-14 | 命令漂移 | MEDIUM | `quickstart.md:7,153` vs `tasks.md:100,267` | quickstart §5.4 的 `npm run verify:real-gpu` 无任何任务创建（T014 的脚本清单不含它，T078 也未新增该脚本）；quickstart 第 7 行自注"命令为计划形态"，故非阻塞，但 T081 的收尾复核需覆盖 | 在 T078 的产出中加入 `npm run verify:real-gpu` 的脚本映射（或把 quickstart §5.4 改为 `npm run test:visual`/`npm run bench` 的真实命令） |
| M-15 | 结构↔任务不一致 | MEDIUM | `plan.md:218,233,249` vs `tasks.md` 全文 | `plan.md` 的文件结构中，`terrain/terrarium.ts`（被 T026 并入 `heightmap.ts`）、`adapters/cesium/globe-surface.ts`、`tests/bench/**` 均**无任务承接**；反之 `verify-harness/src/cross-path.ts`（T061）、`regression.ts`（T065）不在 plan 结构中 | 以 tasks 为准回写 `plan.md` 的 Source Code 结构（或明确 `globe-surface.ts` 的职责并入 T035/T034）；`tests/bench/**` 若确实需要则在 T063 的产出中显式声明 |
| L-01 | 引用不全 | LOW | `tasks.md:11` vs `research.md:436` | tasks 前置说明写「H-1…H-9」，research 另含 **H-5b**（Re:Earth/Mapterhorn 许可待确认） | 改为「H-1…H-9 + H-5b」 |
| L-02 | 扩展名漂移 | LOW | `contracts/render-path-api.md:26` vs `tasks.md:123` | 契约写 `tests/unit/architecture-boundary.test.ts`，tasks 为 `.mjs` | 统一为 `.mjs`（Node 22 `node:test` 无 TS 运行时） |
| L-03 | 未定义类型 | LOW | `contracts/render-path-api.md:101-105,139` | 契约使用 `EventSource<T>`，但 `data-model.md` 与契约 §1 的导出清单均未定义该类型 | 在契约中给出 `EventSource<T>` 的最小定义（或改用 `Event<T>` 等既有类型） |
| L-04 | 入口无源文件 | LOW | `tasks.md:98` vs `plan.md:187-257` | T012 声明 `./escape-hatch` 入口，但 plan 结构无对应源文件、无专门任务描述其导出内容（契约 §1 要求导出 `Viewer`/`CesiumWidget`/`Scene`） | 在 T012 描述中补 `src/escape-hatch.ts` 的产出与导出清单 |
| L-05 | 字段清单不全 | LOW | `tasks.md:224` vs `data-model.md:370-371` | T063 的 `BenchmarkRecord` 字段清单未列 `warmupFrames`/`sampleFrames`（data-model §7 有此二字段，且 FR-017 要求"固定预热与采样次数"） | 在 T063 的字段清单中补上二者 |
| L-06 | 本机信息入产物 | LOW | `tasks.md:28,97,246` | `E:\work\CesiumjsWebGpu` 绝对路径写入 Path Conventions；本机代理 `HTTPS_PROXY=http://127.0.0.1:7890` 在 T011 与**公开 README**（T074）中出现 | 绝对路径改为"仓库根（工作区根）"；代理说明移入本地开发笔记/`.env.example`，不写入公开 README |
| L-07 | 外部依赖（须上报用户） | LOW | `tasks.md:231,267` | T070（G-3）需在 GitHub Actions 托管 runner 实跑（`origin` 已配置为 `git@github.com:yudhcq/Cesiumjs-WebGPU.git`，但需推送与 Actions 权限）；T078 夜间真实 GPU 作业需付费 runner 或自托管 GPU → 按 `AGENTS.md` §5 属"需要凭据/外部账号/付费资源"，须由用户授权 | 在进入 Phase 7 前向用户确认：仓库推送与 Actions 可用性、GPU 执行方案（`mvp-estimate.md` §5 待确认项 1 已列出价差） |

---

## 3. `[P]` 标注逐组核对（对应派发提示第 1、2 项）

**总数核对**：`tasks.md` 中 `^- \[ \] T\d+ \[P\]` 命中 **30** 条（与派发提示一致）。

| Phase | `[P]` 任务 | 核对结论（文件 / 依赖） |
|---|---|---|
| 1 门禁 | T004, T005 | ✅ 不同文件（`g2-drawset.ts` vs `g2-observer.ts`）；但 T005 内容触发 **C-01**（原则 I） |
| 2 Setup | T008, T009, T010, T011, T013 | ❌ **T011 与 T008/T013 同文件且依赖倒置**（H-01）；T009 自检依赖 T011 安装的 `typescript`（H-01）；T010/T013/T008 相互独立 ✅。`tasks.md:303` 的"不同文件"表述不成立 |
| 3 Foundational | T016, T017, T018, T020, T023, T024 | ❌ **T023 与 T021 同文件、与 T022 同测试文件**（C-02）；⚠️ T020 是 T019 的测试而 T019 明确不标 `[P]`（H-04）；⚠️ T024 只写"`node --test` 中新增断言用例"未指明测试文件，可能与 T025 的 `architecture-boundary.test.mjs` 或其它文件冲突（待确认）。T016/T017/T018 ✅ |
| 4 US1 | T026, T027, T033, T034, T036, T038, T040 | ⚠️ T027 是 T026 的测试（H-04，且未列入 `tasks.md:305/318` 的并行清单）；⚠️ T038 的实质断言被推迟到 T042（`tasks.md:154`），本任务自检仅 `tsc`（LOW 级欠验证）；T026/T033/T034/T036/T040 ✅ 不同文件且无未完成依赖 |
| 5 US2 | T051 | ✅（依赖 Phase 4 的 T041/T012，phase 顺序满足） |
| 6 US3 | T057, T058 | ✅ 不同文件（`capture.ts`+`stats.ts` vs `compare.ts`），各自带单元测试 |
| 7 US4 | T064, T068 | ⚠️ T068 创建 `tools/ci-flags.mjs` 作为"CI 与本地共用"的标志真值源，而 T067（未标 `[P]`）写 `ci.yml`、T069 要求"三处一致" → 二者并行时配置归属不清（中风险，建议 T068 先于或与 T067 串行）。T064 ✅ |
| 8 US5 | T073, T074, T075 | ✅ 不同文件（`CONTRIBUTING.md` / `README.md`+`docs/architecture.md` / `.github/pull_request_template.md`） |
| 9 Polish | T078, T079 | ✅ 不同文件 |

**第 2 项（Phase 4 内 T031–T041 串行链 vs plan 依赖序）结论**：
- 该区间内的 `[P]` 为 T033/T034/T036/T038/T040，**均为不同文件且不依赖 T031/T032/T035/T037/T039/T041** → **无被误标 `[P]`**（唯一保留意见是 T038 的断言落在 T042，见上表）。
- 串行链本身与 `tasks.md:305` 的依赖声明一致：`T026/T028 → T031`、`T034 → T035`、`T036/T038 → T037`、`T023/T037 → T039`、`T031–T040 → T041`。
- 但 `tasks.md:321` 的"串行链"写成 `T026/T028 → T029 → T030 → T031 → T032 → T035 → T037 → T039 → T041`，**漏掉了 T034（T035 的前置）与 T036/T038（T037 的前置）**，且把无依赖关系的 T031→T032 写成串行（过度串行，无害）。
- `tasks.md:292` 的 **Critical Path 漏掉 T004/T005**，而 T006 明确依赖二者（`tasks.md:81`）；亦跳过 T065（T067 的前置，`tasks.md:308`）。属文档级依赖序错误，建议修正以免评审与排期误用。

---

## 4. 覆盖率逐条核对（对应派发提示第 4 项）

**方法**：以 `spec.md` 中的显式 ID 为主键（实测 `spec.md` 中 `FR-###` = **29** 条、`SC-###` = **9** 条），对 `tasks.md` 全文做 ID 引用 + 语义映射双重核对。

### 4.1 功能需求（FR）

| 需求 | 有任务？ | 承接任务 | 备注 |
|---|---|---|---|
| FR-001 新路径渲染地形 | ✅ | T023, T036, T037, T039, T042, T043, T045 | |
| FR-002 相机交互 / 无 >1s 卡顿 | ✅ | T021, T039, T044 | |
| FR-003 设备丢失恢复 | ✅ | T021, T050, T054 | T054 的分支覆盖见 M-13 |
| FR-004 加载瓦片 + 区分两态 + 免登录 + 本地固定数据集 | ⚠️ 部分 | T026, T027, T028, T029, T030, T031, T032, T022 | 第二子句（可观察区分）无断言 → **M-09** |
| FR-005 能力探测 ≤2s + 自动回退 | ✅ | T001, T047, T048, T049, T052 | |
| FR-006 兜底路径恒可用 | ✅ | T040, T049, T053 | |
| FR-007 配置选择路径 / 集成方无分支 | ✅ | T025(A5), T041, T051, T055 | |
| FR-008 双路径一致 + 声明差异 + 断言 | ✅ | T006, T023, T053, T055, T061 | |
| FR-009 回退可观察提示 | ✅ | T049, T051, T052 | |
| FR-010 每特性附自动化验证 | ✅ | T042–T046, T056–T058, T060, T062 | |
| FR-011 双路径分别执行 | ✅ | T042, T052, T056, T061 | |
| FR-012 固定相机/时间/种子/视口/像素比/数据集 | ✅ | T030, T042, T056, T059, T060 | |
| FR-013 差异证据归档 | ✅ | T043, T058, T067 | |
| FR-014 容差可追溯、禁止宽松判据 | ✅ | T043, T058, T059, T062 | |
| FR-015 多瓦片 + 兜底路径覆盖 | ✅ | T030, T042, T045, T053 | |
| FR-016 几何缺陷数值化断言 | ✅ | T019, T020, T022, T045, T046 | |
| FR-017 基准三指标 + 环境标注 | ✅ | T017, T018, T037, T063, T064 | |
| FR-018 量化回归门槛 | ✅ | T059, T065 | |
| FR-019 优化先基线 + 对比 | ⚠️ 流程承接 | T073①, T075 | 无自动化检查（PR 模板 + CONTRIBUTING 承载），可接受但应承认其为流程门禁 |
| FR-020 基准历史序列存档 | ✅ | T063, T066, T067, T078 | |
| FR-021 每次提交 CI 三绿 | ✅ | T067 | 与 H-06 相关 |
| FR-022 产物为权威依据 | ✅ | T067, T068, T075 | |
| FR-023 降级策略与盲区 + 本地复现 | ✅ | T069, T070, T078 | |
| FR-024 开源形态 + 许可证检查入 CI | ✅ | T011, T067[6], T071, T072, T073, T074 | |
| FR-025 主干可构建/可运行/可回退 | ⚠️ 流程承接 | T067, T073⑧, T034(C-8) | 无"revert 可运行"的自动化证据；建议在 T081 中补一条复核项 |
| FR-026 评估结论按工作流拆分 | ✅ | T076（产物已存在：`mvp-estimate.md`/`.v1.json`） | |
| FR-027 区间 + 口径 + 人工成本不计入 | ✅ | T076①②⑤⑦ | 判据阈值问题见 H-03 |
| FR-028 版本化 + 基线复用 + 实际值回填 | ✅ | T073⑦, T077, T078, T081(e) | |
| FR-029 已确认/待确认 + 凭据类不计入 | ⚠️ 部分 | T076⑥（+③） | 第三子句无断言 → **M-10** |

### 4.2 成功判据（SC）

| 判据 | 有任务？ | 承接任务 | 备注 |
|---|---|---|---|
| SC-001 双路径 + 多瓦片断言 | ✅ | T042, T045 | |
| SC-002 高程特征可观察（统计断言） | ✅ | T030, T043, T057 | |
| SC-003 ≤2s 回退且无错误 | ✅ | T052, T047, T048 | |
| SC-004 交互 3s 无卡顿 + 定格帧断言 | ✅ | T044, T054 | |
| SC-005 CI ≤20 分钟且双路径 | ✅ | T067, T068, T070 | |
| SC-006 两路径各 ≥1 条可比基准 | ✅ | T066 | |
| SC-007 交付工期与 AI/Agent 消耗结论 | ✅ | T076 | H-03 影响其 CI 可判定性 |
| SC-008 无硬期限 + 偏差说明 | ✅ | T077, T081(e) | |
| SC-009 合入前均有可追溯证据 | ✅ | T043, T060, T073②, T081 | |

**结论**：**未被任何任务覆盖的 FR = 0，SC = 0**；另有 **3 处子句级缺口**（FR-004 第二子句 / FR-029 第三子句 / FR-019·FR-025 仅流程承接）与 **1 处契约级缺口**（`listDatasets`/`getDatasetManifest`，H-02）。

---

## 5. Constitution 对齐（对应派发提示第 5 项）

| 原则 | 任务承接 | 断言 | 结论 |
|---|---|---|---|
| I 上游兼容优先（NON-NEGOTIABLE） | T003, T015, T024, T031, T032, T072, T079, T080 | A3, A4（T025）；`public-api-allowlist`（T024） | ⚠️ 承接充分，但 **C-01**：V2 观察器引入 `DrawCommand`/`FrameState` 依赖，A4 无法捕获（不含下划线），plan 未按 `constitution.md:105` 论证例外 |
| II 渐进式接管 | T016, T040, T041, T047–T055 | A1, A2, A5（T025） | ✅ 承接充分（含"兜底路径本身必须有测试覆盖"→ T053） |
| III 可验证渲染 | T042–T046, T056–T062 | 双路径参数化（T042/T043/T045/T052/T055/T061）；禁止 skip（T045/T056） | ⚠️ M-13：T054 的 `test.fixme` 与"禁止以条件跳过代替断言"存在张力；其余充分 |
| IV 性能以数据驱动 | T018, T059, T063–T066, T073①, T075 | 门槛 `thresholds.source` 必填（T059/T065）；无基线不合入（T073/T075） | ✅ 承接充分（门槛为流程 + CI 双重） |
| V CI 为唯一事实来源 | T067–T070, T072, T075, T078 | 单工作流串行门禁（T067）；降级盲区 10 条（T069） | ⚠️ M-01（步骤编号不一致）、H-06（步骤 [3] 前置未落地）、M-07（缺浏览器安装） |
| 附加技术约束（TS strict / Rollup / ESM+.d.ts / Node≥22 / 外部模块 / LICENSE+CONTRIBUTING+README） | T008–T014, T071, T073, T074 | T009/T012 自检；T011 peerDependencies | ✅ 承接充分（M-08 的 Rollup 解析依赖缺口） |
| 测试与质量门禁顺序（构建→单元与契约→视觉→基准→许可证） | T067 | —— | ⚠️ 步骤 [5] 把 contract+visual+bench 合并为"两个并行 job（按路径）"，**未写明 job 内三者的先后顺序**；建议在 T067 中显式写 `contract → visual → bench` 以满足章程的顺序要求（LOW–MEDIUM） |
| 门禁顺序 / 跳过测试规则 | T067, T045, T056, T054 | —— | 见 M-13 |

**结论**：5 条原则均有任务与断言承接，无"某原则完全无承接"的情形；原则 I 的冲突是**局部机制级**（C-01），不是整体缺失。

---

## 6. Out of Scope 泄漏核对（对应派发提示第 6 项）

**结论：无泄漏。**

- 被排除项（三维瓦片、glTF/模型、影像图层、大气与光照特效、阴影、后处理、粒子、矢量与标注、移动端/低端设备适配、生产级流式调度、凭据类地形服务、通用计算加速、上游不存在的特性、正式发版节奏）在 `tasks.md` 中仅出现于两处**合规语境**：
  - `tasks.md:47-48`：全局约束 6 的**禁止清单本身**；
  - `tasks.md:247`：T075 的 PR 模板要求勾选"**未引入**三维瓦片/模型/影像/大气/阴影/后处理/粒子/矢量标注/移动端"。
- 边界项判读：`tasks.md:74`（T002）出现"只有背景/**天空**"，语义是"证明上游地形不可见、只剩上游画布的天空/背景"，不是实现大气/天空特性；`tasks.md:144`（T028）的 `grep -nE "token|key=|signature"` 是**反向**断言（证明 URL 不含令牌），与"凭据类服务后置"一致；`tasks.md:267`（T078）出现"真实 GPU/费用"属 FR-017/FR-023/FR-028 范围内。
- 另注：`mvp-estimate.v1.json:215` 的 `exclusions` 把"后续增量（三维瓦片、模型、影像、大气、阴影、后处理等）"列为**排除项**，语义正确（不计入本增量消耗），非泄漏。

---

## 7. CI 可执行性核对（对应派发提示第 7 项）

| 检查项 | 结论 | 证据 |
|---|---|---|
| 是否依赖 `pwsh` | ✅ 不依赖（CI 侧正确）；❌ 但**前提描述过时** | `tasks.md:36-38`（禁止 pwsh）、`tasks.md:228`（T067 不得调用 pwsh）；本机实测 **pwsh 7.6.6 已安装** → M-05 |
| Windows 专有路径 | ⚠️ 仅文档级 | `tasks.md:28` 的 `E:\work\CesiumjsWebGpu`（无命令使用它）；无其它 `C:\`/盘符引用 → L-06 |
| 本机绝对路径 / 代理 | ⚠️ | `tasks.md:97` 的 `HTTPS_PROXY=http://127.0.0.1:7890`（本机自检用）、`tasks.md:246`（要求写入公开 README）→ L-06 |
| 命令可在 ubuntu-latest 运行 | ✅ 主体可行 | T067 使用 `xvfb-run -a` + Mesa lavapipe/ANGLE-SwiftShader 标志，与 `contracts/verification-and-benchmark.md:152-160` 的已核实配方逐项一致；禁用标志（`--disable-vulkan-surface`、WebGPU 下的 `--enable-unsafe-swiftshader`、`--headless=new`）均已显式禁止 |
| 缺少必要步骤 | ⚠️ | 契约 §7 前置含 `npx playwright install --with-deps chromium`（`contracts/verification-and-benchmark.md:147`），T067 未列 → M-07 |
| 自检可执行性 | ❌ 部分不可执行 | actionlint 未安装（实测 PATH 无）+ `node -e` 无 YAML 解析 → M-06；中文占位符 `该文件`/`证据文件` → M-03；`grep` 依赖宿主机 PATH 与 shell 语法混用 → M-04 |
| 前置产物时间序 | ❌ | CI 步骤 [3] 引用 Phase 9 才创建的评估文档契约测试 → H-06 |
| 外部账号/付费资源 | ⚠️ 须用户授权 | T070 需 Actions 实跑（`origin` 已配置）；T078 需付费 GPU runner/自托管 → L-07（`AGENTS.md` §5 须上报） |
| 耗时目标可验证性 | ✅ | T070 实测两次 + 总耗时写入 `docs/ci-degradation.md`，对应 SC-005 |

---

## 8. 其他检测（重复 / 二义 / 欠定义 / 术语漂移 / 未映射任务）

- **重复（2 处，均为有意分阶段但需标注）**：
  1. `computeDrawSet` 在 T004（门禁原型，`experiments/gates/g2-drawset.ts`）与 T023（生产版本，`core/tile-registry.ts`）各实现一次——tasks 已声明"语义一致 + 复用测试向量"，建议在 T023 中显式标注"**以 T004 为规格、不得语义分叉**"，并把 T004 的原型标记为可删除。
  2. `tests/visual/terrain-reference.spec.mjs` 与 `terrain-multitile-seam.spec.mjs` 在 T043/T045 与 T060 各出现一次（T060 声明"在 T043/T045 基础上收敛"）——建议把 T060 标注为**重构/收敛任务**（不新增覆盖），以免被统计为"两次实现"。
- **二义（5 处）**：M-02（T076 校验器二选一）、M-03（占位符命令）、M-06（"若可用"式自检）、H-03（⑦ 的误差口径未定义相对/绝对）、M-08（演示页 `cesium` 解析方式未定）。
- **欠定义（4 处）**：H-07（测试如何访问 `scene`/`globe`/`device`）、M-09（FR-004 的第二态如何"可观察"）、H-04（[P] 是否允许"并行编写、串行自检"）、T038 的缓存断言被推迟到 T042（`tasks.md:154`）。
- **术语/编号漂移（4 处）**：M-01（plan 的 CI 步骤 [7]/[8]）、M-11（data-model §8 vs schema）、M-15（plan 结构 vs tasks 文件）、L-02（`.ts` vs `.mjs`）。
- **未映射到 FR/SC 的任务（3 个，可接受）**：T010（WGSL 内联插件，构建链）、T014（跨平台脚本编排，全局约束 1/4）、T080（上游升级演练，原则 I）。三者都映射到 constitution 的附加技术约束或原则，不是"无主任务"。
- **Ambiguity Count = 5｜Duplication Count = 2｜Critical = 3**。

---

## 9. Metrics

| 指标 | 值 |
|---|---|
| Total Functional Requirements | **29**（`spec.md` 实测） |
| Total Success Criteria | **9**（`spec.md` 实测） |
| Total Tasks | **81**（`tasks.md` 实测；`[P]` = 30） |
| Coverage %（ID 级） | **100%**（FR 29/29，SC 9/9） |
| 完全未覆盖 FR/SC | **0** |
| 子句级覆盖缺口 | **3**（FR-004、FR-029、FR-019/FR-025） |
| 契约级覆盖缺口 | **1**（H-02） |
| CRITICAL | **3**（C-01、C-02、C-03） |
| HIGH | **7**（H-01…H-07） |
| MEDIUM | **15**（M-01…M-15） |
| LOW | **7**（L-01…L-07） |
| 发现总数 | **32**（未超 50 条上限，无溢出汇总项） |
| `[P]` 硬违规 | **3**（T011、T013、T023） |
| `[P]` 前提可疑 | **5**（T020、T024、T027、T038、T068） |
| 需用户授权的外部依赖 | **2**（T070 GitHub Actions 实跑、T078 付费/自托管 GPU；L-07） |

---

## 10. 下一步（Next Actions）

**必须先做（阻塞实现）**

1. **C-01**：在 `plan.md` Complexity Tracking 增列 V2 的例外论证 **或** 修改 `tasks.md` T005 使其不依赖 `DrawCommand`/`FrameState` 语义（并同步 `research.md` §1.2 黑名单与 T024 数组）。
2. **C-02**：删除 T023 的 `[P]` 并修正 `tasks.md:304` 的 Phase 3 并行清单（T023 串行于 T021/T022）。
3. **C-03**：二选一 —— 把 T056–T059 前移到 Phase 3/Phase 4 开头；**或**在 `tasks.md` 的 Dependencies 段显式登记 `T042→T051`、`T043/T045→T057–T059`、`T052/T053→T057/T061` 并把 Phase 4/5 Checkpoint 判据改为"契约就绪 + 内联统计"。

**随后做（不阻塞但影响首轮执行效率）**

4. H-01（Phase 2 串行序 `T008 → T013 → T011`）、H-02（补 `api/datasets.ts` 任务）、H-03（定稿 T076⑦ 的误差口径）、H-04（T020/T027 去 `[P]` 并统一 Phase 4 并行清单）、H-06（CI 步骤 [3] 与 T076 的时序）、H-07（测试访问路径的契约决定，需用户/入口 Agent 决策）。
5. M-01/M-05/M-06/M-07（CI 文档与自检可执行性）、M-09/M-10（补两条 FR 子句断言）。
6. L-07：进入 Phase 7 前向用户确认 GitHub Actions 可用性与 GPU 执行方案（属 `AGENTS.md` §5 的上报事项）。

**推荐命令（本阶段无法与用户对话，故只给建议、不执行）**

- 任务清单修订：`/speckit-converge`（追加/改写任务与依赖标注，最适合 C-02/C-03/H-01/H-04）
- 若需改动设计（契约/数据模型/plan）：`/speckit-plan`
- 若需改动成功判据或范围：`/speckit-specify`（本轮**未发现**需要改 spec 的情形）
- 复核通过后：`/speckit-implement`

---

## 11. 修复建议（Remediation，供审批后执行；本阶段未应用任何改动）

> 按 `speckit-analyze` 的规定，以下仅为**建议清单**，需用户/入口 Agent 明确批准后才会执行。

1. `tasks.md:121`：`- [ ] T023 [P] [US1]` → `- [ ] T023 [US1]`，并在描述末尾追加「依赖 T021/T022（同文件：`core/tile-registry.ts`、`tests/unit/tile-registry.test.mjs`）」。
2. `tasks.md:304`：「T016、T017、T018、T020、T023、T024 可并行」→「T016、T017、T018 可并行；T020 依赖 T019；T023 依赖 T021/T022；T024 独立（需指定测试文件）」。
3. `tasks.md:303`：「T008、T009、T010、T011、T013 可并行」→「T008 → T013 → T011 串行；T009、T010 可与 T008 并行（T009 自检需 T011 已安装 `typescript`，可改为脚本检查）」。
4. `tasks.md:264`：断言⑦ → 「每个工作流的 `modelCost` 可由 `tokens × priceSources` 按其声明的计价模型（记录于 `mvp-estimate.md` §3.1：低端=flash/空闲/命中 0.92；高端=80% flash+20% v4-pro/高峰/命中 0.75）复算，**绝对误差 ≤ ¥0.01 或相对误差 ≤ 2%**」。
5. `tasks.md:80`（T005）：追加「结论为 V2 不可用时 MUST 记录并停止；**禁止** import 上游 `@private` 类型（`DrawCommand`/`FrameState`）或依赖其字段语义」，并把 `DrawCommand`/`FrameState` 加入 `tasks.md:122`（T024）的黑名单来源与 `research.md` §1.2。
6. `tasks.md:157`（T041）：文件清单加入 `src/api/datasets.ts`（导出 `listDatasets`/`getDatasetManifest`），并在 T042 或新增单元测试中断言其可用。
7. `tasks.md:228`（T067）：补 `npx playwright install --with-deps chromium`；步骤 [5] 写明 job 内顺序 `contract → visual → bench`；步骤 [3] 注明"评估文档契约测试于 T076 落地后并入"；自检改为可执行命令（`npx --yes actionlint` 或 YAML 断言脚本）。
8. `tasks.md:36-38`（全局约束 1）：改为「CI（ubuntu-latest）MUST NOT 依赖 `pwsh`；本机 PowerShell 5.1 与 7 均可用，脚本优先 Node 以保证 Windows/CI 行为一致」，并同步 T014/T068/T074 的措辞。
9. `data-model.md` §8：按 `contracts/mvp-estimate.schema.json` 补齐 `selfHostedHardware`、`agentTurns`、`scenarios`、`planningValue`、`baselineGapNote`、`actualsBackfill`。
10. `plan.md:105/130/137/147/151`：CI 步骤编号统一为 `[1]–[6]`；`plan.md` 的 Source Code 结构与 tasks 的实际文件清单对齐（`terrarium.ts`/`globe-surface.ts`/`tests/bench/**` vs `cross-path.ts`/`regression.ts`）。

---

*本报告由阶段 3.5（`speckit-analyze`，只读）生成。所有结论均标注文件与行号，未经验证的事项标注为"待确认"。*
