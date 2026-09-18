# Specification Analysis Report — WebGPU 渲染后端替换（受控 fork / 补丁层）

**Feature**: `001-webgpu-terrain-mvp` | **分析日期**: 2026-09-19 | **阶段**: 3.5（speckit-analyze，**整体重生成**）
**分析对象（最新版）**：`spec.md`（FR-001~FR-033 / SC-001~SC-010）、`plan.md`（渲染后端替换版）、`tasks.md`（初检 147 任务 → 修复后 **149 任务** / 12 阶段）、
`research.md`、`data-model.md`、`contracts/**`（含新增 `fork-patch-layer.md`）、`mvp-estimate.md` + `.v1.json`、`quickstart.md`、
`experiments/shader-spike/REPORT.md`、`.specify/memory/constitution.md` **v2.0.0**
**基线命令**：`.specify/scripts/powershell/check-prerequisites.ps1 -Json -RequireSpec -RequireTasks -IncludeTasks` → `FEATURE_DIR` 解析成功，
`AVAILABLE_DOCS` = research.md / data-model.md / contracts/ / quickstart.md / tasks.md；`.specify/extensions.yml` 不存在 → 无 before/after_analyze 钩子。

> **本报告作废并覆盖上一版 `analysis.md`**：上一版针对已被用户否决的"双画布分层 + 隐藏上游绘制"架构，**整体失效**（spec Clarifications Q3/Q4）。
> 本版按 `speckit-analyze` 格式重新生成，**全部结论均给出文件 + 行号 + 原文片段**；不确定项标 **待确认**。

---

## 0. 结论摘要（Verdict）

| 项 | 结论（初检） | 结论（**修复后**，见 §9） |
|---|---|---|
| **是否建议进入实现** | ✅ **建议进入实现**（无 CRITICAL）；4 项 HIGH 须在对应阶段开工前修正 | ✅ **建议进入实现**——31 条发现**全部处置**（30 条已修 + `A3` 并入 T119 修复），无残留 CRITICAL/HIGH |
| **CRITICAL 计数** | **0** | **0** |
| **HIGH 计数** | **4**（`V1` FR-019 零覆盖、`D1` 帧缓冲实现重复、`I1` G-7 顺序不可满足、`I2` T098 前置链不完整） | **0**（`V1`→T148；`D1`→T061/T062 唯一 owner；`I1`/`I2`→拆 `T098a`/`T098b`） |
| **MEDIUM / LOW 计数** | 20 / 7（合计 31 条，未超 50 条上限） | 20 / 7 **均已处置**（编辑修复 + `A3` 并入 T119 + `D3`/`I14` 标注澄清） |
| **未覆盖 FR 数** | **1 条零覆盖（FR-019）**；**1 条仅隐式覆盖（FR-029）** | **0**——FR-019 由 **T148** 显式承接；FR-029 由 T128 新增断言 **(g)** 显式覆盖；FR-001~FR-033 **33/33** 有任务承接 |
| **未覆盖 SC 数** | **0**（SC-001~SC-010 全部有任务承接） | **0**（不变） |
| 修复轮次 | — | **2026-09-19 应用**：经入口 Agent 逐条裁定后修改 `tasks.md`（+`T098b`/`T148`）与 `plan.md`（C1/I9/I10）；`spec.md` 与 `constitution.md` **零改动**（证据见 §9.4） |
| 原则 I（受控 fork） | **未发现违规**；补丁层治理五件套（机器可审计边界 / `keptModulesHash` / 依赖完整性 / NOTICE 署名 / rebase 演练）**齐备** |
| 原则 II（二选一） | **未发现任何"同帧对比 / 两层合成 / 叠加校验 / 让上游绘制不可见"任务**，全部相关表述均为禁令；仅**标注一致性**有 1 处 MEDIUM 问题（`I11`） |
| 未测风险 H-6 / H-7 / H-10 | **全部有三件套式承接**（G-6 / T025 / T079；G-6 / T026 / T058；T035 + T036 + T133） |

**因不存在 CRITICAL，本报告不写"不建议进入实现"**。初检的 4 项 HIGH 已按入口 Agent 的逐条裁定全部修复：
`V1` 由新增 **T148**（`CONTRIBUTING.md` 硬规则 + PR 模板必填 + CI 断言）承接；
`D1` 明确 `Framebuffer` 系**唯一 owner = T061/T062**（T097 只消费，MUST NOT 重复实现）；
`I1`/`I2` 把切片 B 拆为 **`T098a`（Phase 7 功能翻转，不依赖 G-7、不依赖 Phase 9/10 资产）** 与 **`T098b`（Phase 10 全量验证闭环，紧随 G-7 结论 T127 之后）**，
使"G-7 早于切片 B 全量验证"在阶段序下**真实可满足**，并删除了原有"若顺序冲突，以 T098 优先处理"这类兜底文字。逐条改法与复核见 §9。

---

## 1. 逐项核对结论（对应派发清单检查项 1–12）

### 检查项 1：FR/SC 覆盖（**最关键**）

**实测计数**：`spec.md` 中 **FR-001…FR-033 共 33 条**、**SC-001…SC-010 共 10 条**（按 `**(FR-\d+)**` / `**(SC-\d+)**` 逐行实测：FR 33、SC 10，编号连续无缺号）。

- ✅ **SC 覆盖 10/10**：每条 SC 均可在 `tasks.md` 找到承接任务（见 §3 覆盖表）。
- ✅ **FR 覆盖 32/33**：31 条有显式任务 + FR-029 由 schema 校验隐式覆盖 + **FR-019 零覆盖**。
- ❌ **未被任何任务覆盖者：`FR-019`**（详见 `V1`）。`tasks.md` 全文 **0 次**命中字符串 `FR-019`，且全文 **0 次**出现"优化"二字
  （`Select-String -Pattern '优化'` → 0 hits），即"基线 vs 优化后对比"这一 FR 既无实现任务、也无规则/门禁任务。
- ⚠️ **仅隐式覆盖者：`FR-029`**（详见 `V2`）。

### 检查项 2：原则 I 对齐（受控 fork）

**结论：未发现违反"MUST NOT 改逻辑层语义"的任务；补丁层治理五项齐备。**

- 逐条检查涉及 `Scene` / `Globe` / `QuadtreePrimitive` / `Camera` / 图层 / `DrawCommand` 的任务：
  - `tasks.md:47-48`：「`Scene` / `Globe` / `QuadtreePrimitive` / `Camera` / 图层 / `DrawCommand` 的代码与语义**一行不改**（SC-010）」——禁令式。
  - `tasks.md:175`（T032）把 `DrawCommand.js`/`ClearCommand.js`/`Pass.js`/`PassState.js`/`UniformState.js`/`AutomaticUniforms.js`/`Sampler.js`/`PixelDatatype.js`/`BufferUsage.js`/`VertexArrayFacade.js` 列入**"保持不变"集合**（`keptModulesHash` 断言）。
  - `tasks.md:254`（T074）：「**MUST NOT** 通过改 `Core/PerspectiveFrustum.js` 或 `Renderer/UniformState.js`（保留文件）实现」。
  - `tasks.md:177`（T034）：反例断言"人为注入一个 `Scene/Scene.js` 覆盖 → 失败"。
  - `Scene.js` 的 2 处命中（`tasks.md:126`、`tasks.md:177`）分别是 G-1 断言"上游 `Scene.js` 对 `Context.js` 的相对导入被正确改写"与 T034 的反例，**均非修改逻辑层**。
- 治理五件套核对：
  | 治理项 | 任务 | 证据行 |
  |---|---|---|
  | 边界机器可审计 | T006（A1–A11 规则）/ T033（`PatchScopeAudit`）/ T034（构建产物审计）/ T140（总门禁） | 90 / 176 / 177 / 394 |
  | `keptModulesHash` | T032 生成 + T059 / T074 / T081 断言 | 175 / 226 / 254 / 261 |
  | 依赖完整性 | T003（钉版 + lock）/ T030（哈希校验 + 篡改反例）/ T141（终局证明） | 87 / 173 / 395 |
  | NOTICE 署名 | T040（NOTICE 清单 == manifest 集合）/ T133 / T138 | 183 / 377 / 382 |
  | rebase 演练 | T036（干跑，离线常跑）/ T133（两种模式 + 三项齐备判据）/ T141 | 179 / 377 / 395 |
- 仅 1 条 LOW 提示（`I15`）：T015/T017 读取 `scene._context` 断言属测试观测，不构成"借私有 API 绕过逻辑层"，但未写明该限定。

### 检查项 3：原则 II 对齐（二选一，不同时运行）

**结论：全清单不存在任何"同帧对比 / 两层合成 / 叠加校验 / 让上游绘制不可见"类任务。**

- `同帧`（4 hits）/`逐帧合成`（2 hits）全部为禁令或"不存在该入口"断言：`tasks.md:43`、`tasks.md:97`、`tasks.md:325`。
- `叠加`（6 hits）全部为否定式：`tasks.md:43`、`tasks.md:97`、`tasks.md:300`（"回退是销毁重建而非叠加"）、`tasks.md:308`（"MUST NOT 以 CSS/画布叠加掩盖旧路径"）。
- `不可见` → **0 hits**（"让上游绘制不可见"在最新 tasks 中已彻底消失）。
- `双画布`（2 hits）仅出现在 `tasks.md:17-18` 的**整体重新生成声明**里，用于声明旧方案作废。
- 跨后端比较一律"分别采集 + 离线比较"：`tasks.md:202`（T047）、`tasks.md:311`（T106）、`tasks.md:469-472`（并行示例）。
- ⚠️ `〖二选一〗` 标注**语义正确、覆盖不齐**（`I11`）：全文 23 处（任务级 18 处 + 阶段级 Independent Test 4 处 + 约定说明 1 处），
  但 **T093 / T098 / T107 / T117 声明"两路径…串行"却无标注**，而 **T058 仅运行单一后端却标注了**。

### 检查项 4：门禁顺序

- ✅ **G-1→G-2→G-4→G-3→G-5→G-6 全部早于对应实现任务**：全部位于 `Phase 2`（`tasks.md:103-161`），实现任务自 `Phase 3`（`tasks.md:164` 起）。顺序与 plan 一致（`plan.md:335`「G-1 → G-2 → G-4 → G-3 → G-5 → G-6 的门禁推进（G-7 与验证资产并行）」），
  阶段内标题顺序亦为 G-1(L124)→G-2(L128)→G-4(L133)→G-3(L138)→G-5(L143)→G-6(L149)→G-7(L155)。
- ✅ **每道门禁均有"未通过则 STOP"处置**：T015–T029 共 15 个门禁任务，**15/15 含 STOP 字样**
  （逐行实测；T014 为门禁产物判定器工具任务，非门禁本身，无 STOP 属正常），另有阶段级 ⛔ 块 `tasks.md:109-111`。
- ❌ **G-7 的例外有显式顺序约束，但该约束在阶段序下不可满足**（`I1`）：
  `tasks.md:116-117`「G-7 的任务（T028–T029）须与 Phase 9/10 的验证资产与 CI 配方（T108–T126）并行推进，但结论 **MUST 在切片 B 的 `depthTexture=true` 翻转（T098）之前落盘**」，
  而 T098 在 **Phase 7**（`tasks.md:291`）、T108–T126 在 **Phase 9/10**（`tasks.md:325-355`）、G-7 结论正式落盘点 T127 在 **Phase 10**（`tasks.md:356`）。

### 检查项 5：`[P]` 前提逐个复核

**实测：任务级 `[P]` 标注恰好 15 处** —— `T002,T005,T006,T007,T011,T012,T013,T037,T038,T039,T040,T140,T141,T142,T143`
（另有 T004/T010/T034/T044/T053/T098/T147 含"**不标 [P]**"字样，非标注本身）。

- ✅ **无同文件冲突**：逐对核对产出路径互斥（tsconfig 三份 / `types/engine-internal.d.ts` / `check-arch-boundaries.mjs` / `check-tools-portable.mjs` /
  `apps/demo/**` / `src/index.ts`+`api/types.ts` / `tests/support/backend-runner.mjs`+`src/verify/stats.mjs` / `backend-webgpu/**` /
  `src/status/**`+`src/api/errors.ts`+`diagnostics.ts` / `ci.yml` / `LICENSE`+`NOTICE`+`check-license-notice.mjs` /
  `docs/sc010-evidence.md`+`sc010-evidence.test.mjs` / `check-skips.mjs`+`check-skips.test.mjs`），且 15 个任务的自检测试文件互不重复。
- ✅ **与未完成依赖无冲突**：T037（补丁层骨架）与 T031 清单仅有"文件存在性"这一处前向依赖（见 `U5`，已单列）；T039（CI 骨架）与 T040（许可证）无文件交集。
- ⚠️ **阶段级并行分组与个体标注不自洽**（`I14`）+ **两处分组自相矛盾/与真实依赖冲突**（`I3`、`I5`）；T031 自检存在前向依赖（`U5`），T033 自检引用后置任务（`I12`）。

### 检查项 6：验证成对与分层

- ✅ **每个渲染特性与自动化验证成对**：W2 后端核心 → T047（契约）、W3 资源层 → T064（契约）、W4 着色器 → T078/T079/T080、W5 地形 → T091~T096，
  且配对为"紧邻排列"（`tasks.md:435`）。
- ✅ **不存在"仅凭肉眼确认"的任务**：`tasks.md:506`「本清单中**不存在**任何"仅凭肉眼确认"的任务」；唯一的手动记录（T107，`tasks.md:312`）被明文限定为
  「（**作为证据链接**，不作为判据）」。
- ⚠️ **分层标注不完整**（`U1`）：`tasks.md:23` 要求"验证任务 MUST 指明所在**层**"，但**30 个任务未标 `层=`**（含 4 个 US3 验证资产任务 T108/T109/T111/T113）。
- ⚠️ 4 个 `--suite=` 标识符没有对应产出文件（`U2`）。

### 检查项 7：未测风险的承接

| 风险 | 承接任务 | 验证方式 | 结论 |
|---|---|---|---|
| **H-6** 变体规模与编译缓存 | G-6（T025）、T079（SH-6 门禁） | 运行时 `ShaderProgram` 实例数 + 编译耗时直方图落盘，超阈值失败 | ✅ 有任务与验证方式（但阈值自证，见 `A1`） |
| **H-7** 精度与纹理 Y 翻转 | G-6（T026）、T058、T027（逐来源差异声明） | 两路径分别采集 + 离线像素 diff + 高程数值比对 + 四角纹素回读断言 | ✅ 齐备（`tasks.md:152/153/225`） |
| **H-10** 上游 Renderer 接口无公开契约 | **T035（接口清单）+ T036（升级演练）+ T133（`docs/rebase-runbook.md`）** | `InterfaceManifest` 漂移 → `--check` 失败；演练"补丁范围审计 + 接口一致性 + 全量验证"三项齐备 | ✅ **三件套齐备**（`tasks.md:178/179/377`，Notes 复述于 `tasks.md:509`） |

### 检查项 8：评估交付

- ✅ **各有任务**：CI 契约测试 = **T128**（`tasks.md:372`，断言 (a) `includesHumanCost === false`、(b) `statement` 含"人工成本不计入"、(c) `workflows` ≥5 且含 W1–W9、
  (d) `priceSources[].source` 匹配 `^https?://` 且 `consultedAt` 为日期、(e) CNY 主 + USD 副且含汇率来源与日期、(f) `actualsBackfill` 结构合法）；
  回填机制 = **T129**（版本递增 + 保留历史 + `--dry-run`）；偏差说明 = **T130**；schema 见 `contracts/mvp-estimate.schema.json`。
- ✅ **数字一致性核对（无自相矛盾）**：`20.0 – 41.5 工作日` 见 `mvp-estimate.md:43` 与 `plan.md:278`；`S1 ¥260 – ¥670（$38 – $99）` 见 `mvp-estimate.md:123/128` 与 `plan.md:281`；
  token `¥8.46 – ¥264.36` / 算力 `¥0 – ¥400` 见 `mvp-estimate.md:112/145/206-207` 与 `plan.md:279-280`。
  `tasks.md` **未复述**这组数字（`41.5`/`260`/`670` 命中 0 次），因此不存在数字冲突；唯一被引用的数字是 T082 的"**2–4 人月**"（`tasks.md:262`）与 T025 的"mvp-estimate §5 待确认项 1"，
  二者分别对应 `mvp-estimate.md:174`（`+2–4 人月（外推，未逐家族实测）`）与 `mvp-estimate.md:171`（待确认项 1 = 变体数量与编译缓存），**一致**。
- ⚠️ **版本号不一致**（`I9`）：`plan.md:274` 写"结论版本 **v2.0.0**"，而 `mvp-estimate.md:3` 为"结论版本 v2.1.0"、`mvp-estimate.v1.json:4` 为 `"version": "2.1.0"`、`tasks.md:369` 亦为"v2.1.0"。
- ⚠️ **FR-029 显式断言缺失**（`V2`）。

### 检查项 9：Out of Scope 泄漏

**结论：无泄漏。** 关键词命中全部落在禁令/边界/收尾核对语境：

- `影像/模型/三维瓦片/大气/阴影/后处理/粒子/矢量/移动端` → `tasks.md:60-61`（全局约定 7 的 MUST NOT 清单）、`tasks.md:261`（T081：模型/体素/高斯泼溅 **以 `category:"not-implemented"` 显式失败**）、`tasks.md:401`（T147 收尾核对）。
- `319` / `244` → 仅 `tasks.md:242`（W4 Goal"**明确属本增量之外**"）、`tasks.md:262`（T082 范围声明）、`tasks.md:510`（Notes"**明确不计入本增量**"）——**"319 个 `.glsl` 全库转译"未被错误纳入本增量**。
- `后处理` 的另 2 处命中（`tasks.md:282`、`tasks.md:333`）为 MVP 场景配置约束（"无后处理"），属范围收窄而非扩张。

### 检查项 10：CI 可执行性

- ✅ **无 `pwsh` / PowerShell 语法 / `grep` / 本机绝对路径进入自检**：`tasks.md:38-40` 明文禁止，`tasks.md:91`（T007）机器校验；
  全文 grep `pwsh|powershell|actionlint|[A-Za-z]:\\` 仅 3 处命中，全部是**禁令文本本身**（L39/L40/L91）；**无 actionlint 依赖**。
- ✅ **着色器工具链写法正确**：`tasks.md:52-53` 与 `tasks.md:349`（T120）= `glslang 16.6.0` **官方 Linux 预编译包** + `cargo install naga-cli --locked`（**naga 无预编译二进制**，
  且 MUST NOT 写"下载 naga 二进制"），`naga --input-kind wgsl <file>`（`tasks.md:260`）与尖刺实测命令一致（`experiments/shader-spike/REPORT.md:355`）。
- ⚠️ **YAML 解析器未登记依赖**（`U3`）：T039/T118/T126 要求"用 YAML 解析断言"，但 T004 的 `devDependencies` 锁定清单（`tasks.md:88`）不含任何 YAML 库。
- ⚠️ **naga 版本未真正锁定**（`I8`）。
- ⚠️ **CI 缺 Playwright 浏览器安装步骤**（`U4`）。
- ⚠️ **一次性转换流程依赖 `pwsh`**（`U6`）：`quickstart.md:147` 使用 `pwsh -File …run-path-a.ps1`，而 T007 只扫 `tools/**`、`.github/**`、`package.json`（`tasks.md:91`），不扫 `quickstart.md`/`docs/**`。
- ⏳ **待确认**（`A3`）：CI 用 Playwright 自带 Chromium（`quickstart.md:30-31`），尖刺真机基线为 Chrome ≥153（`REPORT.md:358`），该 Chromium 是否满足 lavapipe 配方未在任务中断言（G-7/T028 会实测）。

### 检查项 11：交叉引用完整性

- ✅ **无悬空引用**（对以下标识符逐一定位到定义处）：
  `A1–A11` → `data-model.md:378-388`（11 条齐全）；`C-1–C-7` → `contracts/render-path-api.md:91-97`；`TS-1–TS-5` → `contracts/terrain-source.md:78-82`；
  `SH-1–SH-7` → `contracts/verification-and-benchmark.md:46-52`；`R1–R9` → `contracts/fork-patch-layer.md:78-86`；`AU-1–AU-5` → `contracts/verification-and-benchmark.md:58-62`；
  `data-model §1.1–§11` 全部存在（`data-model.md:20-374`）；§10 的 ①–④ 状态机条目存在（`data-model.md:356/361/365/369`，对应 T046 引用的"§10③"、T051 引用的"§10④"）。
- ⚠️ 两处引用不精确/重叠：`I13`（T040 追溯指向 `fork-patch-layer §7（AU-5）`，AU-5 实际定义在 verification-and-benchmark §5）、`I6`（T053/T081 对 ShaderBuilder 职责重叠）。
- ⚠️ 依赖引用的顺序问题：`I1`、`I2`、`I3`、`I4`、`I5`、`I12`、`U5`。

### 检查项 12：阻断项

- ✅ **T098 已正确标注为阻断项**：`tasks.md:291` 末尾 `⛔ **阻断项**`，Notes 复述于 `tasks.md:511`「未完成不得宣告 FR-030 达成」，并在 plan `Complexity Tracking` 的退出条件中复述（`plan.md:298`）。
- ✅ **T053 / T081 未被标为阻断项——这是正确的**（二者是"切片 C 显式 `not-implemented`"边界任务，不是阻断项）；但二者存在**前置链缺口**：
  `I7`（manifest 无 `kind:"stub-not-implemented"`，`CubeMap`/`CubeMapFace`/`Texture3D`/`TextureAtlas`/`Sync` 被归入"16 个必替换"却只交付失败桩）。
- ❌ **T098 的前置依赖链不完整**（`I2`）：其"全量验证（单元 + 契约 + 视觉 + 基准）"引用了 Phase 9/10 才建立的资产。

---

## 2. 发现汇总表

> **处置状态见 §9（修复记录）**：本表为**初检结论**的忠实记录；每条发现的修复位置与改法在 §9.1 逐条列出，复核结论在 §9.2/§9.3。
> 除 `A3`（并入 T119 修复）外，其余 30 条均经文本编辑修复；`spec.md` 与 `constitution.md` 未被修改。

| ID | 类别 | 严重度 | 位置 | 摘要 | 建议动作 |
|----|------|--------|------|------|----------|
| **V1** | Coverage | **HIGH** | `spec.md:180` vs `tasks.md`（全文 0 命中） | `FR-019`（优化必须先有基线并附对比、无对比不得合入）**无任何任务承接** | 二选一：①在 T132 `CONTRIBUTING.md` 增加"优化提交必须附基线 vs 优化后实测对比 + CI 断言"；②若本增量确定不含优化任务，在 spec/plan 显式标注"N/A 及理由"（涉及需求解释，须入口 Agent 决策） |
| **D1** | Duplication | **HIGH** | `tasks.md:228-229`、`tasks.md:234` vs `tasks.md:290` | 帧缓冲附件化实现（`Framebuffer`/`Renderbuffer`/`MultisampleFramebuffer`/`FramebufferManager`）在 W3（T061/T062）与切片 B（T097）**重复归属** | 明确 T061/T062 = W3 实现（Phase 5 检查点已宣告完成），T097 收敛为"离屏深度纹理 + 视口四边形 + 翻转前置"，删除重复表述 |
| **I1** | Inconsistency | **HIGH** | `tasks.md:116-117`、`:160`、`:356` vs `:291` | G-7 结论 MUST 早于 T098，但其落盘点 T127 在 Phase 10、T098 在 Phase 7 → **顺序不可满足** | 把 G-7 结论落盘拆为独立任务并置于 Phase 7 之前；或把 T098 移到 Phase 10 之后（与 `I2` 一并处置） |
| **I2** | Inconsistency | **HIGH** | `tasks.md:291` vs `:328/:329/:350/:352` | T098 要求重跑"单元+契约+视觉+基准"，但参考帧机制 T111、容差记录 T112、基准采集 T121、回归门槛 T123 均在其后 → **阻断项前置链不完整** | 拆 T098 为 T098a（Phase 7：翻转 + 单元/契约回归）与 T098b（Phase 10 后：全量验证 + 产物归档），或整体后移 T098 |
| V2 | Coverage | MEDIUM | `tasks.md:372` vs `contracts/mvp-estimate.schema.json:147-161` | `FR-029` 仅经"整体 schema 校验"隐式覆盖，T128 显式断言 (a)–(f) **不含** `confirmedItems`/`unconfirmedItems` 的存在性、`impactDirection`、`impactMagnitude` | T128 增加断言 (g)：`unconfirmedItems[].{item,impactDirection∈{up,down,both},impactMagnitude,note}` 齐备且 `confirmedItems` 非空 |
| C1 | Constitution | MEDIUM（**待确认**，严格解读可升 CRITICAL） | `constitution.md:153-154` vs `tasks.md:347`、`contracts/verification-and-benchmark.md:81-88` | 章程门禁顺序为"…视觉回归→基准→**补丁范围审计→依赖与许可证**"，实现产物把 audit 前移到 contract/visual/bench **之前**（plan/contracts/tasks 三者自洽但与章程字面顺序不同，且 plan 的 Constitution Check 未记录该偏离理由） | 在 `plan.md` 原则 V 的 Constitution Check 显式记录排序理由（快速确定性门禁前置 + AU-1…AU-5 为渲染结论的前置条件，见 verification 契约 L64），或逐字改为章程顺序；**严重度待入口 Agent 裁定**（章程该句未使用 MUST/NON-NEGOTIABLE 措辞，且不改变"任一失败阻断合入"的判定语义） |
| C2 | Constitution | MEDIUM | `tasks.md:145-153`、`:437` vs `constitution.md:114-121` | G-5/G-6 的通过判据只能在本机真机产生（`T022`"本机无头 Chrome 153"、`T078`"CI 无 GPU 时按 T080 降级"），与 `tasks.md:437`"证据**只认 CI 产物**：本地通过不等于通过"存在张力；盲区与降级已记录，但**门禁结论如何作为 CI 产物存证/复现未规定** | 在 T126 的 CI 上传清单中补 `experiments/gates/out/*.json`（当前只列 `artifacts/shader-verify/**`），并要求门禁结果均带本机复现步骤（T134 已部分覆盖） |
| D2 | Duplication | MEDIUM | `tasks.md:199` vs `tasks.md:290` | `createViewportQuadCommand` 同时归属 T044（`Context` 命令分派）与 T097（切片 B） | 指定唯一归属：T044 提供 API，T097 只消费 |
| D3 | Duplication | LOW | `tasks.md:97` vs `:325/:326` | T013（脚手架"最小版"+`src/verify/stats.mjs`）与 T108/T109（脚手架"产品化"+`src/verify/**`）对同一文件存在两段所有权 | 在 T013/T108/T109 之间显式标注"增量边界"（T013 只建 API 面，T108/T109 只做产品化），避免同一文件被两次"定稿" |
| A1 | Ambiguity | MEDIUM | `tasks.md:151` | T025 的判定阈值自证：「断言落在声明预算内（预算值与依据写入结论）」——阈值由被判定对象自己定义，**判定前不可机器判定** | 在 plan/research 中先给出变体数与编译耗时的量化预算（可由 `mvp-estimate.md:171` 的 +1–3 工作日推导），T025 只引用该值 |
| A2 | Ambiguity | LOW | `tasks.md:262` | T082 追溯写作「`→ FR-026/FR-027 附近范围界定`」，"附近"使追溯不可机器校验 | 改为精确需求键（如 `→ FR-026（工作流拆分：着色器覆盖范围声明）`） |
| A3 | Ambiguity | LOW（**待确认**） | `quickstart.md:30-31` vs `REPORT.md:358` | CI 使用 Playwright 自带 Chromium，尖刺真机基线为 Chrome ≥153；该 Chromium 是否满足 `--enable-unsafe-webgpu` + lavapipe 配方**未在任务中断言** | 在 T028/T119 增加"记录并断言 Chromium 主版本 ≥ 尖刺基线"的步骤；结论以 G-7 实测为准 |
| U1 | Underspecification | MEDIUM | `tasks.md:23` vs `:325/:326/:328/:330`（另 26 处） | 约定"验证任务 MUST 指明所在层"，但 **30 个任务未标 `层=`**，其中 4 个是 US3 验证资产任务（T108/T109/T111/T113） | 为 T108/T109/T111/T113 补 `层=单元`/`层=契约`；T146 验收矩阵增加"层字段非空"断言 |
| U2 | Underspecification | MEDIUM | `tasks.md:396`（`stability:leak`）、`:259`（`bench:shader-variants`）、`:225`（`visual:texture-origin`）、`:198/:199/:205`（`smoke:*`） | 4 组 `--suite=` 标识符在**任何任务中都没有对应 spec 文件产出**，自检命令无从执行 | 在对应任务中写明产出文件（`tests/benchmark/…`、`tests/visual/…`、`tests/contract/…`） |
| U3 | Underspecification | MEDIUM | `tasks.md:88` vs `:182/:347/:355` | 4 处自检要求"用 YAML 解析断言"，但 T004 的 devDependencies 锁定清单**无任何 YAML 解析器**（且 T128 明示倾向零新增依赖） | 显式登记 YAML 解析依赖，或自实现最小 YAML 子集读取器并在 T039/T118/T126 自检中引用 |
| U4 | Underspecification | MEDIUM | `tasks.md:347-348` vs `quickstart.md:121` | CI 工作流任务（T118/T119）**未列出** `npx playwright install --with-deps chromium`（仅 quickstart §6 出现，靠 T136 实跑才发现） | 把浏览器安装步骤纳入 T118/T119 的 `ci.yml` 与其 YAML 断言 |
| U5 | Underspecification | MEDIUM | `tasks.md:174`（T031 自检）vs `tasks.md:180`（T037） | T031 自检断言"`localFile` **存在**"，但清单指向的替换文件由**后置**任务 T037 创建 → 自检前向依赖 | T031 只断言清单结构（路径形态、`requirementRef` 非空、`glCallSites>0`），文件存在性断言移交 T041 或 T037 之后 |
| U6 | Underspecification | MEDIUM | `quickstart.md:147` vs `tasks.md:91` | 一次性转换流程使用 `pwsh -File …run-path-a.ps1`（Windows-only），而 T007 可移植性检查**不扫** `quickstart.md`/`docs/**`（T136 的实跑范围为 §2–§6，不含 §7，故未直接阻塞） | 补 Node 等价脚本，或在 quickstart §7 显式标注 Windows-only + Linux 等价命令；把 `quickstart.md`/`docs/**` 纳入 T007 扫描面 |
| I3 | Inconsistency | MEDIUM | `tasks.md:446` | Phase 5 并行分组**自相矛盾**：`T059` 同时出现在"可并行"列表与"`T057/T059` 与 `T061/T062` 串行"两处 | 修正为"T055/T056/T059/T060 可并行；T057 与 T061/T062 串行" |
| I4 | Inconsistency | MEDIUM | `tasks.md:447` vs `:249-254` | Phase 6 依赖链 `T069→T070→T074→T073` 与任务正文顺序及真实依赖不符（T074 的深度范围修正在发射器 T073 之内进行） | 改为 `T069→T070→T073→T074` |
| I5 | Inconsistency | MEDIUM | `tasks.md:448` vs `:279/:282` | Phase 7 声明"T086–T090 可并行"，但 T089（`createTerrainScene`）消费 T086 的适配层（`src/terrain/source.ts`） | 改为 `T086 →（T087,T088,T090）并行 → T089`，或补注"接口先定稿" |
| I6 | Inconsistency | MEDIUM | `tasks.md:208`（T053）vs `:261`（T081） | 两者都声明"`ShaderBuilder` → `not-implemented`"，**职责重叠** | 由 T081 独占 ShaderBuilder 边界；T053 收敛为 `Context` 面（`readPixels`/`Sync`/`CubeMap`/`Texture3D`/`TextureAtlas`/`ComputeEngine`） |
| I7 | Inconsistency | MEDIUM | `tasks.md:174`（T031）vs `:208`（T053） | manifest 把 `CubeMap`/`CubeMapFace`/`Texture3D`/`TextureAtlas`/`Sync` 归入"**16 个必替换**（`replace`，需 `glCallSites>0`）"，而 T053 只交付**显式失败桩** → "必替换"与实际交付语义不一致，且 manifest 无 `kind` 区分 | manifest 增加 `kind:"stub-not-implemented"`，把 16 项拆为"功能实现"与"显式失败桩"两组，审计脚本按 `kind` 断言 |
| I8 | Inconsistency | MEDIUM | `tasks.md:52-53`/`:87`/`:349` vs `contracts/fork-patch-layer.md:85` | 声明 `naga-cli **30.0.1**` 锁定，但安装命令 `cargo install naga-cli --locked` **不带 `--version`**（`--locked` 只锁依赖图，不锁自身版本）→ CI 无法保证版本 | 改为 `cargo install naga-cli --version 30.0.1 --locked`，并在 T120 的 YAML 断言中断言版本号 |
| I9 | Inconsistency | MEDIUM | `plan.md:274` vs `mvp-estimate.md:3`、`mvp-estimate.v1.json:4`、`tasks.md:369` | plan 称评估"结论版本 **v2.0.0**"，实际为 **v2.1.0** | 由入口 Agent 同步 `plan.md:274`（阶段子代理只读） |
| I10 | Inconsistency | MEDIUM | `plan.md:141`、`:332-334` vs `tasks.md:8` | plan 仍声明"`tasks.md` … ⚠️ 上一版基于被否决架构，**已失效，必须重新生成**"，而 `tasks.md` 已是 147 任务的重生成版 | 由入口 Agent 同步 `plan.md`（同 I9 一并处理） |
| I11 | Inconsistency | MEDIUM | `tasks.md:286`/`:291`/`:312`/`:334`（漏标）；`:225`（过度标注） | `〖二选一〗` 标注不一致：T093（明确两条后端串行）、T098（"两路径全量套件串行"）、T107、T117（"两路径 … 套件串行"）**无标注**；而 T058 仅运行 `--backend=webgpu` 一条路径却标注 | 为 T093/T098/T107/T117 补 `〖二选一〗`；T058 或改为两路径、或移除标注，使标注规则可机器校验 |
| I12 | Inconsistency | LOW | `tasks.md:176`（T033 自检） | 自检写"在 `T031–T034` 完成后以 0 退出"，引用了**后置**任务 T034 | 改为"T031–T033 完成后"，T034 作为独立门禁单独判定 |
| I13 | Inconsistency | LOW | `tasks.md:183`（T040 追溯）vs `contracts/verification-and-benchmark.md:58-62` | 追溯写作"`contracts/fork-patch-layer §7（AU-5）`"，而 AU-5 定义在 verification-and-benchmark §5（AU 表），fork-patch-layer §7 只讲许可证与署名 | 修正 T040 追溯目标为 `contracts/verification-and-benchmark §5（AU-5）+ fork-patch-layer §7` |
| I14 | Inconsistency | LOW | `tasks.md:443-451` vs 15 处 `[P]` | 阶段级"可并行"声明多数**未落到** `[P]` 标注（Phase 5/6/7/9/10/11 的并行任务无 `[P]`），两类标注口径不统一 | 统一口径：要么为阶段级并行任务补 `[P]`，要么删除阶段级并行声明（保留"无文件交集"说明） |
| I15 | Inconsistency | LOW | `tasks.md:126`、`:131` | T015 断言 `scene._context`、T017 引用 `@private` 语义，未声明"仅用于门禁断言、**不得进入实现路径**"（当前写法本身不构成原则 I 违规） | 在两任务中补一句限定语，避免实现阶段误用私有成员 |

---

## 3. Coverage 汇总表

图例：`✔` 有任务承接；`△` 仅隐式覆盖；`✘` 零覆盖。

| Requirement | Has Task? | Task IDs（`tasks.md` 行号） | Notes |
|---|---|---|---|
| FR-001 地形连续表面 | ✔ | T050(205), T089(282), T091(284), T094(287) | 契约 + 视觉成对 |
| FR-002 相机交互无 >1s 卡顿 | ✔ | T095(288) | 契约，双路径串行 |
| FR-003 设备丢失恢复 | ✔ | T051(206), T096(289), T103(308) | 整体切换语义 |
| FR-004 数据源（免登录 + 本地固定集） | ✔ | T084(277), T086(279), T088(281) | TS-1…TS-5 契约对应 |
| FR-005 初始化期探测/≤2s/整体回退 | ✔ | T016(130), T042(197), T099(304), T100(305), T101(306), T107(312) | G-2 门禁前置 |
| FR-006 兜底 + 不同时运行 | ✔ | T051(206), T100(305), T102(307), T103(308), T107(312) | A7 可执行判据 |
| FR-007 配置选择 + 调用方无分支 | ✔ | T006(90), T011(95), T012(96), T089(282), T105(310), T140(394) | A1/A2/A5 |
| FR-008 两路径一致行为 | ✔ | T064(231), T106(311) | `declaredDifferences` |
| FR-009 可观察提示 | ✔ | T038(181), T104(309), T107(312), T137(381) | |
| FR-010 每特性自动化验证 | ✔ | T078(258), T092(285), T093(286), T109(326), T110(327), T111(328), T117(334) | 无"肉眼确认"任务 |
| FR-011 两路径分别执行 | ✔ | T013(97), T047(202), T064(231), T078(258), T091(284), T102(307), T108(325), T115(332) | A7 + 脚手架面断言 |
| FR-012 固定条件 | ✔ | T087(280), T115(332), T116(333) | |
| FR-013 差异证据 | ✔ | T092(285), T109(326), T113(330) | |
| FR-014 容差可追溯 | ✔ | T027(153), T092(285), T112(329) | 反例：阈值放宽无理由 → 失败 |
| FR-015 多瓦片 + 兜底覆盖 | ✔ | T085(278), T091(284), T111(328) | |
| FR-016 几何缺陷数值化 | ✔ | T093(286), T110(327), T117(334) | |
| FR-017 基准三指标 | ✔ | T063(230), T110(327), T121(350), T127(356) | |
| FR-018 量化回归门槛 | ✔ | T123(352) | 人造劣化必失败 |
| **FR-019 优化先基线 + 对比** | **✔（修复后）** | **T148**（`CONTRIBUTING.md` 硬规则 + `.github/PULL_REQUEST_TEMPLATE.md` 必填项 + `tools/scripts/check-optimization-baseline.mjs` CI 断言）；T132 同节协同、T138 自检、T146 验收映射 | 初检为 ✘ 零覆盖（见 V1）；修复后**显式承接** |
| FR-020 基准存档为历史序列 | ✔ | T122(351) | |
| FR-021 每次提交 CI 三件套 | ✔ | T029(158), T039(182), T118(347), T139(393) | |
| FR-022 CI 产物为权威依据 | ✔ | T039(182), T118(347), T126(355), T139(393), T145(399) | |
| FR-023 降级策略与盲区 | ✔ | T028(157), T038(181), T080(260), T104(309), T114(331), T119(348), T124(353), T134(378) | |
| FR-024 开源交付 + 许可证检查 | ✔ | T004(88), T040(183), T085(278), T131(375), T132(376), T135(379), T137(381), T138(382) | |
| FR-025 主干可构建/可运行/可回退 | ✔ | T127(356), T142(396), T144(398) | |
| FR-026 评估按工作流拆分 | ✔ | T128(372, 断言 c：`workflows` ≥5 且含 W1–W9), T082(262) | 与 `mvp-estimate.md:34-42` 的 W1–W9 对应 |
| FR-027 区间 + 口径 + 人工成本不计入 | ✔ | T128(372, 断言 a/b/d/e) | |
| FR-028 版本化 + 回填 + 复用为基线 | ✔ | T128(372), T129(373), T130(374) | |
| **FR-029 已确认/待确认项区分** | **✔（修复后）** | T128 新增显式断言 **(g)**（`confirmedItems` 非空 + `unconfirmedItems[].{item,impactDirection,impactMagnitude,note}` 齐备） | 初检仅靠整体 schema 校验隐式覆盖（见 V2） |
| FR-030 后端由 WebGPU 实现 | ✔ | T017(131), T021(141), T031(174), T043(198), T044(199), T045(200), T046(201), T049(204), T054(209), T055–T063(222–230), T098(291), T146(400) | 阻断项 T098 |
| FR-031 逻辑层语义不变 | ✔ | T031(174), T067(247), T075(255), T086(279), T141(395) | A9 + `keptModulesHash` |
| FR-032 受控 fork / 可 rebase | ✔ | T003(87), T015(126), T030(173), T031(174), T033(176), T035(178), T041(184), T133(377), T141(395) | |
| FR-033 既有功能不需逐功能重写 | ✔ | T037(180), T053(208), T146(400) | `not-implemented` 边界 |
| SC-001 双路径各自通过断言（多瓦片） | ✔ | T091(284), T098(291), T106(311), T116(333), T136(380), T146(400) | |
| SC-002 高程特征一致 | ✔ | T092(285), T094(287) | |
| SC-003 不支持时 ≤2s 整体回退 | ✔ | T101(306), T107(312), T136(380) | |
| SC-004 交互 3s 无 >1s 卡顿 | ✔ | T095(288), T096(289) | |
| SC-005 流水线 ≤20 分钟 | ✔ | T029(158), T118(347), T127(356), T139(393) | |
| SC-006 基准各自独立运行 | ✔ | T121(350), T122(351), T123(352), T127(356) | |
| SC-007 评估结论交付 | ✔ | T128(372), T138(382) | |
| SC-008 无硬性期限 + 偏差说明 | ✔ | T130(374), T138(382) | |
| SC-009 证据可追溯 | ✔ | T092(285), T111(328), T113(330), T117(334) | |
| SC-010 绘制 100% WebGPU + 逻辑层零改动 | ✔ | T006(90), T033(176), T034(177), T041(184), T044(199), T054(209), T136(380), T140(394), T141(395), T146(400) | **终局证明 T141** |

---

## 4. Constitution 对齐问题

| 原则 | 核对结论 | 证据 |
|---|---|---|
| **I 受控 fork（NON-NEGOTIABLE）** | ✅ 无违规。改动面被限制为 `Source/Renderer/**`（`data-model.md:380` A3 规则 + `tasks.md:176` T033 审计 + `tasks.md:177` T034 构建产物审计）；逻辑层零覆盖有反例测试；`ShaderSource` 双发射被显式论证为"着色器编译"（`plan.md:70`）且 GLSL 视图不变由 A9 断言（`data-model.md:386` + `tasks.md:247` T067） | 见 §1 检查项 2；`plan.md:62-73` 的逐条合规表 |
| **II 二选一，不同时运行（NON-NEGOTIABLE）** | ✅ 无违规。无第二个画布/合成器/遮挡手段；A7 使"同会话双路径"用例必须失败（`tasks.md:307` T102 / `tasks.md:332` T115）；回退为整体销毁重建（`tasks.md:206` T051 / `tasks.md:308` T103） | 见 §1 检查项 3 |
| **III 可验证渲染** | ✅ 满足。每特性成对验证 + 层标注（30 处缺标注见 `U1`，属标注完整性而非缺验证）；无"肉眼确认"任务 | `tasks.md:21-24`、`:506` |
| **IV 性能以数据驱动** | ✅ 满足基本条款（基线先行、门槛量化、两路径独立会话）；**`FR-019` 的"优化提交必须附对比"无任务承接**（`V1`） | `tasks.md:350-353`、`:121` |
| **V CI 为唯一事实来源** | ⚠️ 两处张力：①CI 门禁顺序与章程字面顺序不同（`C1`，待裁定）；②G-5/G-6 真机门禁证据只能本地产生、CI 仅降级为 naga 模块校验，缺"结论如何作为 CI 产物存证"的规定（`C2`）；其余（产物上传、补丁审计与演练归档、降级盲区记录、许可证检查）齐备 | `constitution.md:112-124`、`:153-155`；`tasks.md:347`、`:355`、`:437`；`contracts/verification-and-benchmark.md:81-94` |
| 附加技术约束 | ✅ TS strict（T002）/ Rollup（T009）/ ESM + `.d.ts`（T009）/ Node ≥22（T001）/ 受控 fork 形态 + 可追溯基线（T003、T030）/ 开源交付（T040、T131、T132、T135） | `tasks.md:86/93/87/173/183` |
| 测试与验证策略 | ✅ 分层（单元/契约/视觉/基准 + 架构边界）/ 双后端参数化且各自独立运行 / 视觉差异图产物 / 基准存档 / 跳过测试治理（T143）/ 逻辑层不改由审计与演练支撑 | `tasks.md:325-355`、`:397`、`:176-179` |

**Constitution 违规（CRITICAL）**：**无**。`C1` 按"章程该句未使用 MUST/NON-NEGOTIABLE 措辞、且不改变合入判定语义"判为 MEDIUM，**严重度待确认**（若入口 Agent 认定该句为强制顺序，则应升级为 CRITICAL 并在实现前修正 CI 顺序）。

---

## 5. Unmapped Tasks（无需求映射的任务）

**无完全无映射的任务**：初检的 147 个任务（修复后 149）中，除检查点/收尾类（T041、T054、T065、T083、T107、T117、T127、T138、T139、T145、T147）外，
均带 `→` 需求追溯或明确的契约/数据模型锚点（如 `→ data-model §4.2`、`→ contracts/fork-patch-layer §3`）。
检查点类任务的追溯指向阶段 Goal/Independent Test，属正常形态。

**弱映射（追溯不精确）**：T082（`→ FR-026/FR-027 附近范围界定`，见 `A2`）、T040（追溯目标错位，见 `I13`）。

---

## 6. Metrics

| 指标 | 值 | 说明 |
|---|---|---|
| Total Functional Requirements | **33**（FR-001…FR-033） | 实测计数（含新增 FR-030~FR-033） |
| Total Success Criteria | **10**（SC-001…SC-010） | 实测计数（含新增 SC-010） |
| 需 buildable work 的 SC | 10/10 | SC-007 需评估契约与回填机制，SC-008 需偏差说明机制，均有任务 |
| Total Tasks | 初检 **147** → 修复后 **149**（12 阶段） | 实测 `- [ ] T###` 计数；新增 `T098b`（切片 B 全量验证）与 `T148`（FR-019 治理），`T098` 拆分为 `T098a` |
| FR 覆盖率（显式任务） | 初检 **31/33 = 93.9%** → 修复后 **33/33 = 100%** | FR-019 由 T148 承接、FR-029 由 T128 断言 (g) 承接 |
| FR 覆盖率（含隐式） | 初检 **32/33 = 97.0%** → 修复后 **33/33 = 100%** | — |
| SC 覆盖率 | **10/10 = 100%** | 修复前后一致 |
| 未覆盖 FR | 初检 **1**（FR-019） → 修复后 **0** | `V1` |
| 未覆盖 SC | **0** | |
| Ambiguity Count | **3**（A1、A2、A3） | 其中 A3 标"待确认" |
| Duplication Count | **3**（D1、D2、D3） | |
| Constitution Alignment Issues | **2**（C1、C2），**0 CRITICAL** | C1 严重度待裁定 |
| Critical Issues Count | 初检 **0** → 修复后 **0** | 无 |
| High Issues Count | 初检 **4** → 修复后 **0** | V1、D1、I1、I2（均已修复，见 §9） |
| Medium / Low | **20 / 7**（31 条全部已处置） | 30 条编辑修复 + `A3` 并入 T119 |
| `[P]` 标注数 | **15**（修复后仍 15，集合不变） | 逐个复核无同文件冲突 |
| `〖二选一〗` 标注 | 初检 23 处 token（任务级 18）→ 修复后 **27 处 token = 任务级 22 + 阶段级 4 + 规则说明 1** | 补标 T093/T098a/T098b/T107/T117；去除 T058 的过度标注（I11） |
| 缺 `层=` 标注的任务数 | 初检 **30** → 修复后 **0** | 含 4 个 US3 验证资产任务（U1） |

---

## 7. Next Actions

1. **必须先修（HIGH，进入实现前或对应阶段开工前）**
   - `V1`：为 `FR-019` 补承接任务（T132 增加"优化提交必须附基线对比"规则 + 断言），或在 spec/plan 显式声明 N/A 及理由（需入口 Agent 决策，因涉及需求解释）。
   - `I1` + `I2`（**Phase 7 之前必须解决**）：拆分/后移 `T098`，并让 G-7 结论落盘早于切片 B 翻转；否则"阻断项"在门禁语义上无法闭环。
   - `D1`：明确 `Framebuffer`/`Renderbuffer`/`MultisampleFramebuffer`/`FramebufferManager` 的唯一归属（T061/T062 vs T097）。
2. **建议同批修（MEDIUM，成本低、可机器判定）**
   - `V2`（T128 增断言 g）、`I8`（naga 版本 `--version 30.0.1`）、`U3`（YAML 解析依赖）、`U4`（CI 装浏览器）、`U2`（补 4 组 suite 文件路径）、`U1`（补 4 个 US3 任务层标注）、`I11`（补齐/去除 `〖二选一〗`）、`I3`/`I4`/`I5`（并行分组与依赖链文字）、`I6`/`I7`（manifest `kind` + T053/T081 分工）、`U5`（T031 自检收敛）、`A1`（T025 预算先量化）。
3. **需入口 Agent 执行的文档同步（本阶段只读，不得改）**
   - `I9`（`plan.md:274` → v2.1.0）、`I10`（`plan.md:141`/`:332-334` 删除"tasks.md 已失效"表述）、`C1`（在 plan 的原则 V Constitution Check 记录 CI 门禁排序理由或调整顺序）、`C2`（T126 上传清单补 `experiments/gates/out/*.json`）。
4. **命令建议**
   - 修 `tasks.md` 文本类问题：手工编辑对应行（`speckit-converge` 仅用于补漏任务，本报告的问题多为措辞/依赖不适用）。
   - 若 `I1`/`I2` 通过"后移 T098 + 新增 T098b"解决，属任务增补 → 走 `/speckit-converge`（或由 `speckit-tasks` 重新生成受影响 phase）。
   - 修改范围/成功判据（`V1` 的 N/A 判定）→ 需上报用户，走 `/speckit-specify` 或 `/speckit-clarify`。

---

## 8. Remediation（可选，需显式批准）

如需，我可以为**前 4 项 HIGH + 前 8 项 MEDIUM** 逐条给出可复制的替换文本（含 `tasks.md` 精确行号与改写后的整段），
**但不会自动应用**（`speckit-analyze` 为只读阶段；`analysis.md` 是本阶段唯一可写文件）。
请指明要修的范围与目标文件，或授权在下一轮由 `/speckit-converge` 追加/修订任务。

---

## 9. 修复记录与修复后复核（Remediation Log & Post-Fix Re-check）

**修复轮次**：2026-09-19，经入口 Agent 逐条裁定后应用。**写入面**：`tasks.md`、`plan.md`、`analysis.md`；
`spec.md` 与 `constitution.md` **零改动**（证据见 §9.4）。未执行 `git commit`。

### 9.1 逐条修复（文件 / 行号 / 改成了什么）

> 行号为**修复后**的 `tasks.md` / `plan.md` 行号（用 `Select-String` 实测）。

| ID | 文件 | 行号（修复后） | 改成了什么 |
|---|---|---|---|
| **V1** | `tasks.md` | **L398**（新增任务行，紧邻 T132=L397）；联动 L404(T138)、L422(T146)、L540(Notes)、L521(Implementation Strategy) | 新增 **`T148 [US5]（层=单元）FR-019 治理承接：优化提交的基线强制`**——(a) `CONTRIBUTING.md` 新增"性能优化提交规则"小节（与 T132 同文件同节）；(b) `.github/PULL_REQUEST_TEMPLATE.md` 必填"性能优化基线对比"（`baseline-ref`/`after-ref`/指标口径/差值）；(c) `tools/scripts/check-optimization-baseline.mjs` + CI 断言：命中优化特征却缺对比数据 → **拒绝合入**；自检 `tests/unit/optimization-baseline-rule.test.mjs`（3 组用例）+ `--self-test`。T132 追溯补 `FR-019（协同 T148）`；T138 自检命令增至六条；T146 验收映射加入 FR-019 |
| **D1** | `tasks.md` | **L243(T061)**、**L244(T062)**、**L305(T097)** | T061 增"**唯一 owner**：`Framebuffer`/`Renderbuffer`/`MultisampleFramebuffer` 附件化实现由 T061 交付，T062 交付 `FramebufferManager` 编排；**T097 只消费，MUST NOT 重复实现**"；T097 改为"**范围收窄**：只交付离屏深度纹理 + 深度拷贝路径（`GlobeDepth` 接线）" |
| **I1** | `tasks.md` | **L128–L133**（Phase 2 G-7 说明）、**L175**（Phase 2 Checkpoint）、**L375**(T127)、**L442–L443**（Dependencies）、**L539/L541**（Notes） | G-7 顺序改为"结论在 **T127**（Phase 10）落盘，**唯一消费点 = T098b**（紧随其后）"；删除原"若顺序冲突，以 T098 优先处理"兜底文字；Phase 2 Checkpoint 同步。**理由（二选一：调整 T098 依赖）**：把"全量验证 + G-7 消费"从 Phase 7 移出——前移 G-7 到 Phase 7 会让其判定缺少 CI 配方输入，故只能通过拆分切片 B 使顺序可满足 |
| **I2** | `tasks.md` | **L306(T098a)**、**L377（新增 T098b）**、**L308**（Phase 7 Checkpoint）、**L362–L364**（Phase 10 说明）、**L379**（W8 Checkpoint）、**L474–L477**（Parallel）、**L507/L512/L520** | `T098` → **`T098a`（前半：功能翻转，只重跑本阶段单元+契约套件，不依赖 G-7 与 Phase 9/10 资产）**；新增 **`T098b`（后半：全量验证闭环 + G-7 消费，置于 Phase 10 末尾）**，标注 T098a+T098b 共同构成阻断项。**理由（二选一：拆 T098a/T098b）**：`T111/T112/T121/T123` 产物必须先行，整体后移会使 Phase 7 缺少可验证的翻转节点 |
| **D2** | `tasks.md` | **L214(T044)**、**L305(T097)** | T097 收敛为"`createViewportQuadCommand` **消费路径**（API 归 T044）" |
| **V2** | `tasks.md` | **L393(T128)** | 断言清单新增 **(g)**：`confirmedItems` 非空且每项非空字符串；`unconfirmedItems[].{item, impactDirection∈{up,down,both}, impactMagnitude, note}` 齐备——**不得只依赖整体 schema 校验** |
| **C1** | `plan.md` | **L112** | 在「原则 V — CI 为唯一事实来源」的 Constitution Check 中新增"**CI 门禁顺序的偏离记录**"：记录本方案把 `audit(AU-1…AU-5)` 前移到 `contract/visual/bench` 之前，并给出三条理由（确定性静态门禁前置可最快阻断越界改动；`contracts/verification-and-benchmark.md` §5 本就规定渲染类结论以 AU-1…AU-5 全通过为前提；章程该句未用 MUST/NON-NEGOTIABLE 且"任一失败阻断合入"语义不变），并声明若章程改为强制则 MUST 按章程调整 |
| **C2** | `tasks.md` | **L374(T126)**、**L460**（Within Each Phase 铁律） | 原"证据**只认 CI 产物**"改为**证据口径**：真机门禁证据（`experiments/gates/out/*.json`、`artifacts/shader-verify/**`）**由本机真机产生并随仓库入库**，CI 负责归档与一致性断言（无 GPU 时 = naga 模块级校验，盲区见 T134）；渲染/基准结论仍只认 CI 产物。T126 上传清单新增 `experiments/gates/out/*.json` 与 `artifacts/slice-b-full-validation.json`（七类 → 九类） |
| **U1** | `tasks.md` | 30 处：L212/L213/L214/L216/L218/L220/L222/L223/L224/L247/L264/L277/L278/L292/L306/L327/L340/L341/L343/L345/L349/L375/L394/L395/L396/L397/L399/L400/L401/L404 | 为 30 个 US 任务补 `层=`：T042/T043/T044/T046/T048/T050/T052=单元；T053=单元+架构边界；T054=架构边界；T065=单元+架构边界；T069=单元；T082=单元；T083=单元+视觉；T084=单元；T098a=单元+契约；T098b=视觉+基准；T107=契约+架构边界；T108=契约+架构边界；T109=单元；T111=契约；T113=单元；T117=视觉+架构边界；T127=基准+单元；T129/T130/T131/T132/T133/T134/T135/T138=单元 |
| **U2** | `tasks.md` | **L76–L97**（Path Conventions 新增映射表）；**L240**(T058)、**L274**(T079)、**L418**(T142)、L212–L220(smoke) | 新增 **`--suite=` → 文件映射表**（27 个 suite 全覆盖，含 `stability:leak`→`tests/benchmark/stability-leak.spec.mjs`、`bench:shader-variants`→`tests/benchmark/shader-variants.spec.mjs`、`visual:texture-origin`→`tests/visual/texture-origin.spec.mjs`、`smoke:*`→`tests/contract/smoke-*.spec.mjs`），并要求新增 suite 时同步补表、由 T145 校验 |
| **U3** | `tasks.md` | **L101**(T004)、**L197**(T039)、**L366**(T118)、**L368**(T120)、**L374**(T126) | 选型：**补 devDependency `yaml`**（而非自实现解析器）——理由：CI 工作流断言需可靠 YAML 解析，自实现子集对 GitHub Actions 的块/流式/多行标量不稳健；`yaml` 为 ISC 许可、零传递依赖，满足许可证门禁。T004 锁定清单加入 `yaml` 并要求精确版本；T039/T118/T120/T126 的"YAML 解析"改为"用 T004 锁定的 `yaml` 解析" |
| **U4** | `tasks.md` | **L366**(T118) | CI 步骤链改为 `install（npm ci + npx playwright install --with-deps chromium）→ build → typecheck → …`，并在 T118 的 YAML 断言中要求"该步骤存在" |
| **U5** | `tasks.md` | **L189**(T031 自检) | 删除 T031 自检中的 `localFile` **存在性**断言（前向依赖 T037），改由 T041 在 T037 落地后校验；T031 只断言清单结构（路径正则、`requirementRef` 非空、`kind` 取值、`replace` 类 `glCallSites>0`） |
| **U6** | `tasks.md`（复核）/`quickstart.md`（**未授权，未改**） | `tasks.md` L39–L40、L104（T007 扫描面） | 复核：T007 只扫 `tools/**`、`.github/**`、`package.json`，`quickstart.md:147` 的 `pwsh -File …run-path-a.ps1` **不在扫描面内**且 T136 实跑范围为 §2–§6（不含 §7）→ 不阻塞。**残留**：`quickstart.md:147` 仍为 Windows-only、`:35` 仍为未锁版本的 `cargo install naga-cli --locked`（该文件不在本轮授权写入面，见 §9.4 待办） |
| **I3** | `tasks.md` | **L474** | Phase 5 分组改为"T055/T056/T059/T060 可并行；**T057 与 T061/T062 串行**"（T059 不再同时出现在并行与串行两处） |
| **I4** | `tasks.md` | **L475** | Phase 6 链路改为 **`T069→T070→T073→T074`**（T074 的深度范围修正在发射器 T073 之内进行） |
| **I5** | `tasks.md` | **L476** | Phase 7 改为 **`T086 →（T087,T088,T090）可并行 → T089`**（T089 消费 T086 的适配层） |
| **I6** | `tasks.md` | **L223**(T053)、**L276**(T081) | T053 标题改为"切片 C 桩与显式失败（`Context` 面 + manifest 中 5 个 `stub-not-implemented` 模块；**`ShaderBuilder` 边界不属本任务，见 T081**）"，`ShaderBuilder` 从 T053 的清单移除，由 T081 独占 |
| **I7** | `tasks.md` | **L189**(T031 标题与自检)、**L223**(T053 自检) | manifest 语义明确化：**16 = 11 个 `kind:"replace"`（功能实现）+ 5 个 `kind:"stub-not-implemented"`**（`Texture3D`/`CubeMap`/`CubeMapFace`/`TextureAtlas`/`Sync`，切片 C 边界，只交付显式失败桩）；`kind ∈ {replace, adapt-shader, stub-not-implemented}` 进入断言，`glCallSites>0` 仅适用于 `replace` 类；T053 自检断言五项桩的 `kind` 与 T031 清单一致 |
| **I8** | `tasks.md` | **L54**（全局约定 4）、**L368**(T120) | 安装命令改为 **`cargo install naga-cli --version 30.0.1 --locked`**，并注明"`--locked` 只锁依赖图，版本 MUST 由 `--version` 显式锁定"；T120 的 YAML 断言改为"缺 `--version 30.0.1` 即失败" |
| **I9** | `plan.md` | **L145**、**L281** | `mvp-estimate.md` 行标注改为"**结论版本 v2.1.0**"、json 行补 `"version": "2.1.0"`；正文行改为"结论版本 **v2.1.0**，与 `mvp-estimate.md:3` 及 `mvp-estimate.v1.json` 一致；v1.0.0 对应已被否决的架构、v2.0.0 为其后的中间版本，两者均已失效" |
| **I10** | `plan.md` | **L141–L147**（Project Structure）、**L339–L346**（下一步） | 文件清单改为"`tasks.md`：**已由 /speckit-tasks 依据本版 plan/contracts 整体重新生成**（147 任务 / 12 阶段）"，并新增 `analysis.md` 条目；"下一步"第 1 条改为"**`tasks.md` 与 `analysis.md` 已整体重新生成**…（CRITICAL = 0；4 项 HIGH 已按裁定修复）"；第 2 条补 G-7 顺序与 `T098a`/`T098b` 阻断项定义；第 3 条补 naga 锁版命令 |
| **I11** | `tasks.md` | **L46**（标注规则）、**L240**(T058)、**L301**(T093)、**L306**(T098a)、**L327**(T107)、**L349**(T117)、**L377**(T098b) | 全局约定 2 新增**可机器核验的标注规则**（两路径相关 MUST 标、单后端 MUST NOT 标）；补标 **T093/T098a/T098b/T107/T117**；**去除 T058 的过度标注**（改为"本任务只运行单一后端…不使用标记"） |
| **I12** | `tasks.md` | **L191**(T033) | 自检改为"在 **T031–T033** 完成后以 0 退出（T034 是独立的构建产物审计，不参与本任务完成判据）" |
| **I13** | `tasks.md` | **L198**(T040) | 追溯改为 `→ FR-024, contracts/fork-patch-layer §7, contracts/verification-and-benchmark §5（AU-5）` |
| **I14** | `tasks.md` | **L468** | Parallel Opportunities 增"**标注口径（I14 澄清）**：阶段级'可并行'仅为文件交集建议；**权威标注是个体任务的 `[P]`**；冲突时以任务正文与 `[P]` 为准"；并在 Phase 3/9-10/11 三条中补 T035→T036、T098b 串行、T132/T148 同文件约束 |
| **I15** | `tasks.md` | **L141**(T015)、**L146**(T017) | 两任务补"**私有成员限定**：`scene._context` / `@private` 语义仅用于门禁断言，**MUST NOT 进入实现路径**" |
| **A1** | `tasks.md` | **L166**(T025) | 预算改为**测量前预先落盘** `experiments/gates/g6-variants/budget.json`（来源：`mvp-estimate.md` §5 待确认项 1），判定脚本读取该文件、**MUST NOT 由本次测量反推阈值**；自检增"`budget.json` 存在且 `recordedAt` 早于 `g6-variants.json`" |
| **A2** | `tasks.md` | **L277**(T082) | 追溯由"`FR-026/FR-027 附近范围界定`"改为精确键"`→ FR-026（工作流拆分：着色器覆盖范围）+ FR-027（口径声明）`" |
| **A3** | `tasks.md` | **L367**(T119) | 并入 **U4** 修复：T119 增"**浏览器版本（A3）**：CI 用 Playwright 自带 Chromium，MUST 记录其主版本并断言 **≥ 尖刺真机基线 Chrome 153**；不满足即 STOP 上报，MUST NOT 静默降级配方"，并进入该任务自检断言 |
| **D3** | `tasks.md` | **L110**(T013) | T013 增"**增量边界**：只定稿 API 面与最小实现；`backend-runner.mjs` 产品化归 T108、`src/verify/**` 完整资产包归 T109，二者 MUST NOT 重写已定稿接口" |

### 9.2 修复后自检结论

| 复核项 | 命令/方法 | 结果 |
|---|---|---|
| **FR-019 是否已有覆盖** | `Select-String -Pattern 'FR-019'` → **7 处命中**（L391 T148、L397 T148 自检、L398 T148 追溯、L404 T138、L422 T146、L521 Notes、L540 T132）；`-Pattern '优化'` 命中 T148 正文 | ✅ **有显式任务承接（T148）**，初检的"0 命中"已消除 |
| **FR 覆盖** | 逐 FR 扫描 `tasks.md` | ✅ **33/33**（FR-029 由 T128 (g) 显式断言） |
| **SC 覆盖** | 同上 | ✅ **10/10** |
| **CRITICAL / HIGH 计数** | 按 §2 表逐条核对修复 | ✅ **CRITICAL = 0 / HIGH = 0**（4 项 HIGH 全部落地；MEDIUM 20 + LOW 7 全部处置） |
| **`[P]` 复核** | 正则 `^\s*-\s\[\s\]\sT\d{3}[ab]?\s+(\[US\d\]\s+)?\[P\]` | ✅ **15 处，集合与修复前一致**（T002,T005,T006,T007,T011,T012,T013,T037,T038,T039,T040,T140,T141,T142,T143）；无同文件冲突，且 `T148` 与 `T132` 标注为**同文件串行**而非并行 |
| **`〖二选一〗` 复核** | 同上正则 + 逐任务语义核对 | ✅ 任务级 **22 处**（T026,T047,T051,T064,T087,T091,T092,T093,T094,T095,T096,T098a,T098b,T101,T103,T106,T107,T117,T121,T136,T137,T142），阶段级 4 处 + 规则说明 1 处 = 全文 27 处 token；**漏标 4 处已补、过度标注 1 处已去除**；标注规则已写入全局约定 2 供机器核验 |
| **任务编号纪律** | 逐行提取任务 ID | ✅ **149 个唯一 ID**；既有 ID 未重排，新增为 `T098b`（拆分）与 `T148`（追加） |
| **节点引用完整性** | `Select-String -Pattern 'T098a|T098b|T148'` | ✅ `T098a` 9 处、`T098b` 22 处、`T148` 7 处，均在 `tasks.md` / `plan.md` 内自洽（Phase 2 说明、检查点、Dependencies、Parallel、Implementation Strategy、Notes 全部同步） |
| **CI 可执行性复检** | `Select-String -Pattern 'pwsh|powershell'` | ✅ `tasks.md` 仅 L39/L40（禁令文本）与 L104（T007 扫描器自身）命中，**无自检依赖 `pwsh`**；`grep`/绝对路径 0 命中；无 `actionlint` 依赖 |

### 9.3 修复后仍存在的残留（**需入口 Agent 决策或另行授权**）

| 项 | 位置 | 说明 |
|---|---|---|
| R1 | `quickstart.md:35` | 仍写 `cargo install naga-cli --locked`（未带 `--version 30.0.1`），与 `tasks.md:54/368` 及 `contracts/fork-patch-layer.md:85` 的锁版要求不一致；`quickstart.md` 不在本轮授权写入面 |
| R2 | `quickstart.md:147` | 一次性转换流程仍为 `pwsh -File experiments/shader-spike/scripts/run-path-a.ps1`（Windows-only），且 `tasks.md` 的 T007 可移植性检查不扫 `quickstart.md`/`docs/**` |
| R3 | `contracts/fork-patch-layer.md:22-43`（§2 替换清单） | manifest 的 `kind` 语义（`replace` / `adapt-shader` / `stub-not-implemented`）已在 `tasks.md:189/223` 明确，但契约 §2 的 kind 枚举未同步；契约不在本轮授权写入面 |
| R4 | `docs/ci-degradation.md`（尚未创建） | C2 的证据口径需在该文档（T134）中同步复述；T134 已在其范围内 |

### 9.4 零改动证据

```
$ git diff --stat
 specs/001-webgpu-terrain-mvp/analysis.md | 544 ++++++++++++++++---------------
 specs/001-webgpu-terrain-mvp/plan.md     |  32 +-
 specs/001-webgpu-terrain-mvp/tasks.md    | 194 ++++++-----
 3 files changed, 419 insertions(+), 351 deletions(-)
```

- ✅ `spec.md`、`.specify/memory/constitution.md`**均未出现在 diff 中**（零改动）；
  `research.md`、`data-model.md`、`contracts/**`、`mvp-estimate.*`、`quickstart.md` 同样零改动。
- ✅ 未执行 `git commit` / `git push`（工作区保持未提交状态）。

---

*本报告由阶段 3.5（`speckit-analyze`）重新生成，并在入口 Agent 逐条裁定后完成同批修复的复核记录（§9）。
`spec.md` 与 `constitution.md` 全程未被修改；未执行 `git commit`。*
