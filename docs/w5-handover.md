# W5 交接说明：本轮次交付状态、开放缺陷与切片 B 的设计空间

**Feature**: `001-webgpu-terrain-mvp` ｜ **写入时机**: 2026-09-19（入口 Agent 本轮次收尾）
**本文件的作用**：把"哪些是**已核实的结论**、哪些**尚未收齐**、下一步该按什么顺序做什么"一次写清，
使下一个目标轮次不必重新侦查。**本文件不是验收结论**，逐条以 `tasks.md` 与 `artifacts/` 为准。

---

## 1. 任务进度

`tasks.md` 共 **164** 条任务行，已完成 **96**。
**US1 的六个验收套件 T091–T096 已全部完成**（每一份都经入口 Agent 至少一条臂独立复跑）：

| 任务 | 结论 | 关键证据 |
|---|---|---|
| **T091** Independent Test | 两臂各 exit 0 | webgpu `1 passed (45.8s)` / webgl2 `1 passed (41.0s)`；`probeSceneAssemblyUsed=false`；`nonBackground=64000` |
| **T092** 多瓦片视觉回归 | 两臂各 exit 0 | `pass 10/10`、`maxChannelDelta 0`；负例 `pixel`/`shift` 均变红；跨路径离线差 1 LSB/5830 px |
| **T093** 几何数值化断言 | 两臂各 exit 0 | "删瓦片必红"已实测（exit 1、7 条违规）；自算 172800 三角与 T091 一致 |
| **T094** 高程帧证据 | 两臂各 exit 0 | 数据集 286/286 片解码 ｜ 帧证据 lane 3 ｜ ECEF 反算，两路互差 mean 0.13 mm |
| **T095** 交互契约 | WebGL2 通过；**WebGPU 按实测判红** | webgl2 `2 passed/exit 0`（max 82.2 ms、0 卡顿）；webgpu `exit 1`（384 条 render-failed + 停绘）⇒ T158/T152 |
| **T096** 设备丢失恢复 | 套件 exit 0（入口 Agent 复跑 `1 passed (1.2m)`） | 覆盖率 64000→0(对照臂)→64000→64000；旧设备计数 3→0 |

**未启动**：切片 B（T097/T098a）与 MVP 收口 T098b。
另沉淀出 **11 条产品缺陷任务**：T152/T154/T155/T156/T157/T158/T159/T160/T161/T162/T163。
**最高优先两条**：**T158**（首次相机交互后约 60 ms 地形绘制停止）与 **T163**（uniform 环形缓冲装不下
多瓦片帧 → 1498 条渲染错误 + 近空白帧；细化超出数据集层数 ⇒ `tilesLoaded` 永不收敛）。

**快照纪律（本会话吃过一次亏）**：代理在飞时打快照，MUST 先确认它**不处于反例/变异注入状态**——
反例自检会临时改代码，我的"T094 收尾快照"就落在了那个窗口里（含 `HEIGHT_LANE = 0`），
已由后续提交更正。

## 2. 已核实（入口 Agent 自己跑过、可复现）

| 结论 | 证据 |
|---|---|
| **US1 的 Independent Test 两臂各 exit 0** | `contract:terrain-ready`：webgpu `1 passed (45.8s)`、webgl2 `1 passed (41.0s)`；两臂 `consoleErrors=0/pageErrors=0`、`nonBackground=64000`（320×200 满覆盖）、15 片真实瓦片覆盖 0–9 级、`tilesLoaded.loaded=true` |
| **走的是发货入口，不是页面自行拼装** | 产物 `probeSceneAssemblyUsed=false`、`exportedFromBundle=true`；`drivenIsTheScreenshotTarget=true` |
| **两条路径各自独立运行，且"另一条路径零占用"是实测的** | webgpu 臂 `webgl2.contextRequests=0 / webgpu.adapterRequests=2`；webgl2 臂 `webgpu.adapterRequests=0 / deviceRequests=0 / webgl2.contextRequests=4` |
| **受控 fork 的边界仍然成立** | `tools/audit-patch-scope.mjs`：`logicLayerOverrides=0`、`keptModulesUnchanged=true`、`integrityOk=true`、`aliasWhitelistExhaustive=true`；`check-arch-boundaries.mjs` 11 条规则干净；`check-gate --all` 6/6 |
| **构建与单测** | `npm run build` exit 0（含 demo）；`npm run typecheck` ok；`node --test "tests/unit/**/*.test.mjs"` **487/487** |
| **切片 B 的设计空间** | `docs/gate-g7-conclusion.md` §0 + `experiments/gates/out/g7-depth-msaa.json`（13 项测量 / 5 条结论全部带对照臂） |

## 3. 未核实（**不得**当作结论）

- T092–T096 五套件的**最终汇报与反例自检结论**未收齐；其文件已提交（`932b459`、`4dab80b`），
  但提交说明明确标注为"快照、未收敛"。
- 新增套件的 **webgl2 臂**未逐条独立复跑。
- `interaction` 与 `device-lost-terrain` 的最终覆盖率（当前近黑，成因见 T158）。
- `captureFrame()` 读回通道纯色 vs 合成器截图 256 色（T159）**未判定**。

## 4. 七条开放缺陷（建议修复序：**T158 → T152 → T156/T157 → T154/T155 → T159**）

| ID | 缺陷 | 根因/锚点（已定位的部分） |
|---|---|---|
| **T158** | `Buffer._getGpuIndexFormat: this buffer is not an index buffer (it carries no indexDatatype)` ⇒ 帧失败 ⇒ 停绘 | 触发签名：`indexCount:null`（**非索引绘制**）、`vertexArrayVertices:6`、`primitiveType:4` ⇒ 一个四边形，**与地形网格无关**。锚点 `Renderer/Buffer.ts:283-292`（守卫）、`:269`（只有 `createIndexBuffer` 挂 `indexDatatype`）、`Renderer/VertexArray.ts:242`。**不得给缺失的 `indexDatatype` 补默认值** |
| **T152** | `error-scope: beginFrame() … scopes still open` 刷屏、`tilesLoaded` 不收敛 | 已由 T158 触发复现 ⇒ 归因应为"**任何帧错误的后续效应**"。只读假设：`src/compose/scene-runtime.ts:330-335` 用 `void awaited.catch(...)` **不等待**帧内错误作用域排空，而 `error-scope.endFrame()` 需 `await` 三次 `popErrorScope()`（先弹出、后抛出） |
| **T156** | `stats().triangleCount` 结构恒 0 | `src/compose/scene-runtime.ts:416-418` 乘了 `DrawCommand.instanceCount`，而 Cesium 对非实例化绘制默认 **0**（`DrawCommand.js:89`、`Context.js:1367`）。建议 `instanceCount > 0 ? instanceCount : 1`。**与 W5 黑帧根因同类语义陷阱** |
| **T157** | 请求的 `viewport.devicePixelRatio` 被吞 | 入口确实写了 640×400，但交换链立刻改回：`webgpu/swapchain.ts:181-197` + `resolveDrawingBufferSize`（`:60-72`）用 `clientWidth × #dpr()`，而 `#dpr()` 取**页面** DPR。判别对照：`display:none` 宿主请求 `200×150@2` → 实测 **400×300** |
| **T154** | D2-a"整体委派 WebGL2"兜底路线**一用就崩** | `vendor/upstream-webgl2/Context.js:409` 的 GL 三参 `RenderState.apply(gl, rs, ps)` 打到补丁层两参 `Renderer/RenderState.ts:501`（无 `typeof` 守卫）⇒ `gl` 被当 `renderState`。**这条兜底路线是 W6 自动兜底的前提** |
| **T155** | `report.errors` 不携带内层 `cause`/`stack` | 根因定位被迫依赖 console 文本（入口 Agent 曾因此误归因一次，见 T153 勘误） |
| **T159** | `captureFrame()` 读回纯色 vs 合成器 256 色 | 待判定：GPU 回读仪器特性（`uniqueColoursGpuReadback`）还是**读回通道丢信息**（后者会使所有基于 `captureFrame().pixels` 的公开统计建立在盲通道上） |
| **T160** | 设备丢失的**顶层**诊断分类失真（顶层 `render-failed`，`device-lost` 只在 `cause.category`） | `src/compose/scene-runtime.ts#reportRenderFailure` 把所有非地形 cause 一律归 `render-failed`。调用方按顶层 `category` 分支就会把"设备丢失"当普通渲染失败 |
| **T161** | FR-017 资源账本销毁/重建后**不归零** | 实测 `ledgerBefore.live=18 → afterDispose.live=18(released=0) → afterRebuild.live=**36**`；T096 用 `_tileReplacementQueue.trimTiles(0)` **否证**了"只是没 trim"（36→36）。修法：W6 装新设备时 `GpuResourceRegistry.reset()`，或 `scene.destroy()` 前释放瓦片资源 |
| **T162** | **"数据不可用"在画面上真的留洞** | T093 的 `fail:<level>/<x>/<y>` 反例实测：删掉一块瓦片后画面 **5.08% 变清屏色**（`surfaceShare` 94.58%）。`degrade()` 给的 −6883 m 平地**没有入帧**。FR-004 的"其余瓦片继续渲染"成立，但"**不出现空洞**"不成立 |
| **T163** | `DEFAULT_COMMAND_SLOTS=8` 装不下多瓦片帧；近地细化超出数据集层数 | `backend-webgpu/webgpu/uniform-writer.ts:395`：`uniform ring buffer is full: 9216 bytes hold 9 slot(s)` → **1498 条 render error** + 合成器帧近空白（前景仅 1461 px = credit 覆盖层）；且近地细化到 **level 13** 而固定数据集只有 **0–12** ⇒ `tilesLoaded` 30 s 内**永不为真**。**修好后 MUST 按 `regenerationPolicy` 重生成两路参考帧** |

**复核纪律（本会话已因此失误三次，务必照做）**：harness 每次 `runContractSuite` 都**覆写同名产物**
`artifacts/<suite>/<backend>.json`；**一个 spec 里的多个 `test`（多臂）会互相覆盖**。因此
**看产物前 MUST 先确认它属于哪条臂**（对照该次运行的 `url`/`runId`/`scenario` 或套件自报的臂别），
否则会把反例臂的数值当成测量结果——本会话就是这样把 T095 注入的 1200 ms busy-wait 误读成
"SC-004 被违反"。建议把臂别写进产物文件名。

**约束提醒**：修 T154/T156/T157/T158 都会改 `backend-webgpu/**` 或 `src/compose/**`，即会进入契约
bundle 的依赖图。按 `AGENTS.md` §7，**同一时刻只允许一个"改产品代码"的代理在飞**，且在其编译通过
之前不要并行跑契约套件（否则所有套件都会因半成品构建而红）。

## 5. 切片 B（T097/T098a）的实现路线（由实测确定，不必再侦查）

本机实测（`docs/gate-g7-conclusion.md` §0）：

1. 一个 pass 的**所有附件必须同采样数**；
2. **没有可用的硬件深度 resolve**（pass 的 `resolveTarget` 被 WebIDL 静默忽略——回读得 `[0,0,0,0,0]`
   而清除值是 `0.5`；`copyTextureToTexture` 4x→1x 被拒）；
3. 片元着色器**可以**在 4 采样 pass 里写 `@builtin(frag_depth)`；
4. 多采样深度纹理**可以**用 `texture_depth_multisampled_2d` + `textureLoad` 读取（朴素
   `texture_depth_2d` 绑定被拒，报 `multisampled: 0`）⇒ **深度 resolve 可以在着色器里自己做**；
5. 深度面能否拷贝是**格式属性**：`depth32float`/`depth16unorm` 可拷，`depth24plus(-stencil8)` **不可**。

⇒ **切片 B 不必牺牲 MSAA**（3、4 各给一条合法路线），且任何需要离开 pass 的深度纹理 MUST 用
`depth32float`/`depth16unorm`。**MUST NOT** 依据 WebGL 惯例（多采样深度附件 + 单采样深度纹理作
resolve 目标）直接实现——该形态在本机无对应机制。

## 6. 复现命令（全部为 Node，跨平台）

```text
node tools/audit-patch-scope.mjs                          # 受控 fork 边界
node tools/scripts/check-arch-boundaries.mjs              # 架构规则 A1–A11
node tools/scripts/check-gate.mjs --all                   # 6/6 门禁
node --test "tests/unit/**/*.test.mjs"                    # 单测（Node 22 下裸目录不可用，必须用 glob）
npm run build && npm run typecheck
node experiments/gates/g7-slice-b/run-gpu.mjs             # 切片 B 设计空间实测
node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:terrain-ready
node tests/support/backend-runner.mjs --backend=webgl2 --suite=contract:terrain-ready
```

套件执行**天然串行**（`tests/support/suite-lock.mjs`）；看到 `suite-lock: another suite run is in flight`
是正常等待。`SUITE_LOCK_WAIT_MS` / `SUITE_LOCK_STALE_MS` 可调。

## 7. 临时实际消耗观测（**非** FR-028 的 `actualsBackfill` 产物，仅供 T129 参考）

- 口径：`mvp-estimate.md` v2.1.0（结论版本），S1 计划值 ¥260–670；工期 20.0–41.5 工作日。
- 本轮次观测：从"地形零片元/全黑"到"US1 Independent Test 两臂通过 + 五套件落盘 + 7 条缺陷登记"，
  走完 `tasks.md` 的 **91/160** 条任务行。
- **不做成本换算**：本机无法读取真实 token 计费与算力账单，任何折算都将是编造。
  真实回填 MUST 由 T129 的 `tools/backfill-actuals.mjs` 用可追溯的计费数据完成。
