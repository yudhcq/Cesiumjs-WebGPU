# G-6 门禁结论：变体规模与像素一致性（H-6 / H-7）

**Feature**: `001-webgpu-terrain-mvp` ｜ **任务**: tasks.md **T025–T027** ｜ **门禁**: plan.md「实现前的验证门」G-6
**判定产物**: `experiments/gates/out/g6.json`（机器可判定）｜ **规范**: [experiments/gates/README.md](../experiments/gates/README.md)
**重跑命令**:

```text
node experiments/gates/g5-shader/run.mjs                                  # G-5（提供枚举与发射产物，G-6 的输入）
node experiments/gates/g6-variants/run.mjs                                # T025 变体规模与编译缓存
node experiments/gates/g6-precision/run.mjs --backend=webgpu              # T026 之一（单独一次运行）
node experiments/gates/g6-precision/run.mjs --backend=webgl2              # T026 之二（单独一次运行，不得同时）
node experiments/gates/g6-precision/compare.mjs --offscreen               # T026 离线比较
node experiments/gates/g6-judgement/run.mjs                               # T027 汇总判定 -> out/g6.json
node tools/scripts/check-gate.mjs --gate g6                               # 判定器校验
```

---

## 0. 修复轮（2026-09-19）—— 本节是当前结论，§1–§6 是首轮记录

**verdict = `pass`（`budget.json` revision 3，判据由 SC-004 推导）**，`check-gate --all` = **6/6 (exit 0)**。
本节由 G-6 修复轮写入；首轮的叙述（§1–§6）保留原样作为审计轨迹，**其中"20 / 60 ms 预算"已被 revision 3 取代**，见 plan.md「G-6 修复轮」。
**revision 1 与 revision 2 的 fail 记录（阈值、实测值、失败原因）完整保存在 `budget.json` 的 `history` 中，不得删除。**

### 0.0 判据演进的三个版本（历史，保留）

| revision | 判据 | 实测 | verdict | 为何被取代 |
|---|---|---|---|---|
| 1 | 单项 p50/p95 **20 / 60 ms**、会话 ≤48 次编译 | p50 110.5 / p95 138.1 ms，全空间 81.4 s，会话 8 次编译 | **fail** | 阈值从未用 WebGPU 建管线校准（来源是 glslang 19.4 ms × 2–3 倍余量）；且它判的是**全空间顺序编译吞吐**，产品从不暴露这个量 |
| 2 | 相对失败基线至少快 2× / 2× / 1.5×（55 / 70 / 54000 ms），会话 0 次编译 | p50 104.0 / 特化 p95 127.1 ms，全空间 72.2 s | **fail** | 仍以**单项耗时**为运行期判据，判的还是"全空间顺序编译"这个非产品量 |
| **3（当前）** | 由 **FR-002 / SC-004** 推导：运行期编译 **0**、单次新变体 **p95 < 300 ms**、启动预热 **≤ 5 s**（记录变体数与耗时）；全空间 768 预热**仅供参考** | 运行期 **0** 次（300 帧 300 命中）、启动 **36 变体 / 2255 ms**、单次新变体 p95 **97.9 ms** | **pass** | — |

`spec.md` 与 SC-004 **一个字未改**；修订只在"如何判定 H-6"这一层，且运行期判据由 revision 1 的"≤48 次编译"**收紧为 0 次**。

### 0.1 修了什么（(a) override 常量 + (b) 模块瘦身 + (c) 初始化期预热）

| # | 改动 | 落地位置 |
|---|---|---|
| (a) | `TEXTURE_UNITS` 与 `PER_FRAGMENT_GROUND_ATMOSPHERE` 从**模块文本**搬到 **WGSL pipeline-overridable constant**（两个 `override` 在两个 stage 都声明；`createRenderPipeline` 的 `constants` 按 stage 传入，因为 WebGPU 的 `constants` 是 per-stage 且键必须在**该 stage 的模块**里声明） | `g5-shader/wgsl-emitter.mjs`、`wgsl/terrain-{vs,fs-main,fs-lib}.wgsl`、`g5-shader/mirror-generators.mjs` |
| (b) | **只发射入口点可达的声明**（保守死声明消除）：整份 `czm_` prelude 原本被内联进两个 stage，实测把模块对 48 kB → **13 kB**（黄金配置） | `g5-shader/wgsl-prune.mjs` |
| | ⚠️ **体积口径澄清（W4 落地后补记）**：13 kB 是**淘汰路径的瘦身实验结果**，**不是发货体积**。该实验证明"模块大小不是耗时主因"（48→13 kB 耗时 107.4→104.0 ms），故瘦身**未被采纳**。W4 生产发射器的模块对文本为 **33 101 B**（门禁原型 32 672 B，+1.3%，差额来自 T074 的深度重映射助手）。读者请勿把 13 kB 当作产品模块体积。 | W4 生产实测（`artifacts/shader-variants.json`，可再生） |
| (c) | **可达子集预热（产品默认行为）**：应用在首帧前按 `prewarm-policy.mjs` 的**纯函数计划**（该配置下 36 个变体身份 = 影像层数 1–3 × 地面大气 3 × 雾 2 × 光照 2）建好管线池，运行期只查表 | `g6-variants/prewarm-policy.mjs`、`g6-variants/driver.js`、`g6-variants/run.mjs` |

配套：varying 配对改取**每顶点见证变体**（per-fragment 是它的真子集，否则 per-vertex/per-fragment 的 `VSOut`/`FSIn` 不同、模块文本仍会分叉）；
G-4 布局改为**合规保守布局**（见 `docs/gate-g4-conclusion.md`），因此发射的元素读取后缀由布局表推导（`uniformElementAccess`）。

### 0.2 实测（`experiments/gates/out/g6-variants.json`，revision 3 判据）

| 项 | 首轮（rev 1） | 修复轮（rev 2） | 本轮（**rev 3，当前**） | 判定 |
|---|---|---|---|---|
| 可达 define 组合 | 768 | 768 | 768 | — |
| **互异模块文本** | 768 | **128** | **128** ✅ | 结构项 |
| `createShaderModule` 调用 | 1536 | **256**（=2×128） | **256** ✅ | 结构项 |
| 重复解析 | 0 | 0 | 0 ✅ | 结构项 |
| 会话运行期编译数 | 8 | 0 | **0** ✅（300 帧 300 命中，wall 0.0 s） | 判据 = 0 |
| 会话命中率 | 97.3% | 100% | **100%** ✅ | 判据 ≥ 1.0 |
| 启动预热 | 全空间 81.4 s | 全空间 72.2 s | **36 个变体 / 2255 ms** ✅（限 5000 ms） | 判据 ≤ 5 s |
| 单次新变体建管线 p95 | 141.2 ms | 127.1 ms | **97.9 ms** ✅（限 300 ms） | 判据 < 300 ms |
| 全空间预热（仅供参考） | 81.4 s | 72.2 s | **732 个变体 / 71.8 s**，p50 104.8 ms | **不作判据** |
| 像素一致性（对照上游 GLSL） | 0/16384 | 0/16384 | **0/16384** ✅ | H-7 成立 |

### 0.3 主方案的前提被实测否证，以及一处**自我纠正**（本节最重要的结果）

真机对照：

| 对照 | p50 |
|---|---|
| 6 行着色器、新模块 + 新管线（平台下限，`g6-override-probe.json`） | **8.6 ms** |
| 已解析模块 + **新 override 取值**（rev 2 的 656 个样本） | **107.2 ms** |
| **新模块文本**（rev 2 的 128 个样本） | 107.9 ms |
| 同模块同常量、模块 48 kB（瘦身前） | 107.4 ms |
| 同模块同常量、模块 **13 kB**（瘦身后） | **104.0 ms** |
| `layout:"auto"`：rev 1/2 中**跑在最前** | 63.2 ms |
| 显式 union 布局：rev 1/2 的**长扫描**中 | 104.0 ms |
| `layout:"auto"`：rev 3 中**跑在最后** | **90.8 ms** |
| 显式 union 布局：rev 3 的**启动段（最前）** | **65.6 ms** |

结论：**在本机（Chrome 153 / Dawn / NVIDIA Lovelace）上，"每多一个变体 ≈ 0.1 s" 是带绑定管线的固定代价**——
它与"模块是否已解析"无关（override 不提供廉价特化），与"模块多大"也几乎无关（48→13 kB 无变化）。
**自我纠正**：先前记录的"管线布局杠杆（auto 63 vs 显式 104，~40%）"**不成立**——把 auto 样本从最前移到最尾后方向反转（90.8 vs 65.6），
说明那 40% 是**测量顺序/压力效应**（同一页面生命周期内早期建的管线更便宜），不是布局差异。该杠杆在 plan.md 中登记为"**需受控 A/B 才能判定**"，不得当作已确立结论。

### 0.4 残留风险与后续（已按入口 Agent 裁定登记进 plan.md）

1. **命中计划之外变体时约 0.1 s 卡顿**（本轮实测计划外变体冷建管线 p50 104.8 ms）。量级：相对 SC-004 的 1 s 界有 10× 余量，**不违反成功判据**，但会表现为一次可感知掉帧。处置：扩大预热计划的动态维度 / 懒编译调度（`createRenderPipelineAsync` 放到空闲期）/ 应用层记录该事件。
2. **W2 候选优化（登记，未实施）**：① 每变体 binding 集合收敛——**须先做同位置交错的受控 A/B**；② 懒编译调度（工作量最小、不改判据）；③ 计划范围按应用配置进一步收敛。
3. **已登记但 MUST NOT 实施**：收敛 MVP define 子集（768 → 128 或更少）——属**需求范围变更**，须用户批准，本轮未实施。
4. **口径风险**：本门禁测的是"连续建 768 条管线、每条都等 `popErrorScope`"的墙钟时间；应用侧用 `createRenderPipelineAsync` 且每次只建少量时，用户可感知的卡顿会低于该数字。SC-004 的产品级界（交互中无 >1 s 连续卡顿）在本机配置下**即使按 0.1 s/变体也仍然满足**——本门禁失败的是**自设的、按"比失败基线快 2×"重新登记的门槛**，不是产品成功判据。

---

# 首轮记录（2026-09-19，revision 1 预算）—— 以下为原始结论文本

## 1. 结论

**verdict = `fail`（部分通过）** —— 这不是"没做"，而是**预先登记的预算被实测突破**，且另一维（像素一致性）以很强的形式通过：

## 1. 结论（**首轮**记录，当前结论见 §0）

> **本节是 revision 1 的历史记录，已被 §0 取代。** 保留原文以便审计首轮 fail 的依据；其中的预算阈值（20 / 60 ms）与"768 个互异发射产物"等数字属于**当时**的口径。

| 维度 | 结论 | 关键数字 |
|---|---|---|
| **变体规模与缓存（H-6，结构性）** | ✅ **可控** | MVP 可达 define 空间 **768** 个组合 → **768** 个互异发射产物 → 运行时 **768** 个 `ShaderProgram` 实例；**同一模块对被编译两次的次数 = 0**；文档化 300 帧会话只产生 **8** 个实例、缓存命中率 **97.3%** |
| **变体编译耗时（H-6，预算）** | ❌ **超预算** | 最坏情形 p50 **109.9 ms** / p95 **141.2 ms**（预算 20 / 60 ms，**超出约 5×**）；会话内 p50 **78.6 ms** / p95 **81.3 ms**（预算 20 / 60 ms） |
| **精度与纹理 Y 翻转（H-7）** | ✅ **通过，且比要求更强** | 同一固定场景、同一 define 集：**发射 WGSL 帧 vs 上游真实 GLSL 帧逐像素完全相同（0/16384 差异，最大通道差 0 LSB）**；高程数值 max \|Δ\| = **1 LSB**（0 个像素超过 1 LSB）；四角纹素两路径一致且符合声明的翻转约定 |

`check-gate.mjs --gate g6` 因此**以 1 退出**：Phase 2 尚未全部通过，按 plan 与 tasks.md 的门禁语义应 **STOP**，由入口 Agent 修订 `plan.md`。

---

## 2. H-6（变体规模与编译缓存）—— 实测口径

变体空间不是"任意组合"，而是**从上游代码逐行追溯出的 MVP 可达子集**（`experiments/gates/g5-shader/define-matrix.mjs`，每个维度带来源行号，被排除的取值同样带理由与来源）：

`TEXTURE_UNITS(4) × quantization(2) × lighting(2) × groundAtmosphere(3) × fog(2) × ocean(1) × imageryOps(2) × tileLimitRectangle(1) × geodetic(4) = 768`

被排除的取值都是 **MVP 场景不会进入的配置**，不是发射器缺能力，例如：`ocean` 维度塌缩为 `none`（`hasWaterMask = tileProvider.hasWaterMask && defined(waterMaskTexture)`，`GlobeSurfaceTileProvider.js:102,2571`，MVP 地形无水面掩码）；`tileLimitRectangle` 同理；`imageryOps` 只保留 `{none, alpha}`（其余来自 `ImageryLayer` 的色相/饱和度/亮度设置，MVP API 不暴露）。

### 2.1 缓存身份 = 发射产物文本

上游缓存键是 `[numberOfDayTextures][flags]`（`GlobeSurfaceShaderSet.js:243-267`）。本门禁的测量把**发射产物文本**当作程序身份：768 个 define 组合 → 768 个互异 (VS,FS) 文本对 → 768 个实例，**重复编译数 = 0**。也就是说：只要发射按文本去重、缓存按上游键复用，**增量成本只发生在真正新增一个发射产物时**——768 个组合里没有一个"白编译"。

会话工作负载（`SESSION_PLAN`，9 段共 300 帧）覆盖影像层数 1→3、地面大气 per-vertex↔per-fragment（上游按相机距离逐帧切换，`GlobeSurfaceTileProvider.js:2600-2604`）、雾开关、光照 daynight↔vertex、层 alpha、geodetic/exaggeration：**8 个实例、292 次命中、8 次编译、总编译 1.5 ms、整段会话 0.6 s**。

### 2.2 超预算的是"每个新变体的编译代价"

| 项 | 预算（预先登记） | 实测（最坏情形） | 实测（会话） |
|---|---|---|---|
| p50 编译耗时 | ≤ 20 ms | **109.9 ms** | **78.6 ms** |
| p95 编译耗时 | ≤ 60 ms | **141.2 ms** | **81.3 ms** |
| 总编译耗时 | ≤ 900 s | 81.4 s ✅ | 1.5 ms ✅ |
| 实例数 / 管线数 | ≤ 13824 | 768 ✅ | 8 ✅ |
| 重复编译 | 0 | 0 ✅ | 0 ✅ |

预算写在 `experiments/gates/g6-variants/budget.json`（`recordedAt = 2026-09-19T04:00:42+08:00`），**早于** `g6-variants.json` 的任何测量；判定脚本只读该文件，不存在回写路径。

预算里 p50/p95 的来源是**尖刺的间接量级**（"glslang wasm 单着色器 19.4 ms，按同量级留 2–3 倍余量"）——尖刺明确未测 WebGPU 建管线。实测表明该假设偏乐观约 5×：把一个 ~20 kB 顶点 + ~33 kB 片元的 WGSL 模块对编译到可用，在 Chrome 153 / RTX 4080 SUPER 上约 **0.1 s**。

**方法学核对（避免把测量误差当成结论）**：

- 同步部分（`createShaderModule` 两次 + `createRenderPipeline` 一次）实测 p50 仅 **0.2–0.3 ms**，其余 ~110 ms 是编译完成所需的时间（`popErrorScope` 只有在模块/管线校验完成、即 Tint 编译完成后才 resolve）。预算判定用的是**总耗时**，因为那才是"多一个变体"的真实代价；同步耗时同时记录在证据里。
- 换用**显式 pipeline layout**（H-4 的 union 布局，产品实际会用）后 p50 仍是 109.9 ms → 差异**不是** `layout: "auto"` 的推导开销；另测 24 个样本的 `layout: "auto"` p50 = 58.5 ms（更早、更冷），说明量级稳定在数十至上百毫秒。
- 768 条管线的**总**耗时 81.4 s 在总预算内，说明这不是"变体爆炸"（数量可控），而是**单个变体的编译代价**问题。

### 2.3 需要回到 plan 的点（失败动作）

按 plan G-6 行的失败动作（"收敛 MVP define 子集（只保留地形路径实际可达组合）"）**本门禁已经先做过一次收敛**（13824 → 768，逐条给出上游依据）。因此正确的修订方向不是继续砍 define，而是下面三选一（或组合），属于 plan 层面的决策：

1. **变体预热/池化**：把"下一批可能出现的变体"在空闲时段预编译（`numberOfDayTextures` 与 `perFragmentGroundAtmosphere` 是仅有的两个会在一帧内跳变的维度），把 0.1 s 的编译从关键路径上移走；
2. **重新登记编译耗时预算**：在 plan 中写明"单个新变体 ≈0.1 s（实测，Chrome 153/RTX 4080 SUPER）"，并给出可接受的卡顿预算（例如每帧最多一个新变体、或允许一次性 100 ms 卡顿）；
3. **降低单次编译成本**：缩小模块（当前每变体把整个 `czm_` prelude 内联进来，VS ~20 kB / FS ~33 kB），或改用 WGSL `override`/管线可覆盖常量把部分 define 维度从"编译期"搬到"管线期"。

> 本门禁**不**放宽判据：`budget.json` 保持原值，`verdict` 保持 `fail`。

---

## 3. H-7（精度差异与纹理 Y 翻转）—— 实测口径

两次**独立运行**（不同进程、不同页面、各自一个 backend，绝不同帧）渲染同一个固定场景（`experiments/gates/shared/terrain-scene.mjs`：16×16 WGS84 椭球面片、确定性高度场、4×4 确定性影像、128×128 视口）：

- **webgpu 半程**：本仓库发射的 WGSL（`g5-shader/wgsl-emitter.mjs`）；
- **webgl2 半程**：**上游真实拼装 GLSL**（`assembleGlslForVariant`，即 `ShaderSource` 交给 GL 驱动的文本），在真实 WebGL2 上下文里编译链接，属性位置按 `terrainEncoding.getAttributeLocations()` 在链接前绑定（与上游 `ShaderProgram` 同做法）。

### 3.1 逐像素差异：**0**

`0/16384` 个像素不同，最大通道差 **0 LSB**，18368 个像素全部参与比较（边缘掩码排除 0 个）。即：**在 MVP 黄金配置下，发射出的 WGSL 与上游 GLSL 在真机上产生逐字节相同的帧**。这比"误差在容差内"强得多，也直接关闭了 H-7 的"精度不可收敛"风险。

三维高程对比（同一顶点阶段 + 高程编码片元阶段）：max \|Δ\| = **1 LSB = 91.918 m**（半径 6.38×10⁶ m 的量级上），**0 个像素超过 1 LSB**，均值 0.31 m。这里 1 LSB 来自高程编码器本身（范围 / 255），不是精度损失。第一次写这份容差时只按 float32 ULP（≈0.38 m）推导、漏掉了编码量化项，是**测量暴露出推导错误后补上量化项**，而不是把已满足的界放宽。

### 3.2 纹理 Y 翻转：由映射层统一处理，并被断言

| 路径 | 策略 | 依据 |
|---|---|---|
| WebGL2 | `UNPACK_FLIP_Y_WEBGL = true` | Cesium `Texture.flipY` 默认（`Renderer/Texture.js:27`） |
| WebGPU | 上传时**反转行序** | WebGPU 无 unpack 开关且纹理原点在左上，`v=0` 取图像首行；反转后与 GL 的 flip 等价 |

texel-probe（全屏四边形采样影像纹理，两侧用**屏幕一致**的 uv：`gl_FragCoord.y` 自下而上、WGSL `position.y` 自上而下）四角回读：两路径四角完全一致，且与夹具纹素在声明的翻转约定下一致。**这条断言是必要的**：本门禁实现过程中它两次抓到真实错误 —— 一次是 WebGPU 侧漏了反转（地形贴图上下颠倒），一次是探针自身 uv 约定不一致（探针看起来"反了"而地形是对的）。

### 3.3 逐来源差异声明（`declaredDifferences`，7 条）

| # | 来源 | 容差与其依据 | 本夹具实测 |
|---|---|---|---|
| 1 | 亚像素边缘 | 由 edge mask 排除并计数（梯度阈值 8/255） | 排除 0 个像素 |
| 2 | MSAA 解析 | 不适用（两路径都无多采样，环境字段记录 `antialias:false`） | — |
| 3 | sRGB | ≤2 LSB/通道（都渲染到 8 位 UNORM，无 sRGB 编解码） | 0 LSB |
| 4 | 深度表示 | 0（单趟、无深度附件、两路径共用同一个零到一深度投影矩阵） | 0 LSB |
| 5 | WGSL 无精度修饰符 | ≤2 LSB/通道、差异像素占比 ≤1% | 0 LSB / 0% |
| 6 | 纹理 Y 翻转 | 0（映射层统一处理 + 四角断言） | 四角一致 |
| 7 | 交换链通道顺序 | 对齐步骤：`bgra8unorm` 回读为 B,G,R,A，归一化为 RGBA | 处理前 166 LSB / 99.4% 像素"不同"，处理后 0 |

第 7 条是本门禁实测发现的**真实陷阱**：不做通道顺序归一化，两个后端看起来"每个像素都不同"（R/B 互换）。它被登记为**对齐步骤**而非容许差异——归一化在比较之前完成，比较本身仍要求 0 差异。

**MUST NOT 放宽为"任意差异通过"（FR-014）**：`compare.mjs` 的每条容差都写明来源与依据；任何无法归因到已声明来源的差异都会 fail，差异直方图（167→1 个桶）与差异图 `out/g6-precision-diff.png` 一并留证。

---

## 4. 环境（写入 `g6-variants.json` / `g6-precision.json` 的 `environment`）

| 项 | 值 |
|---|---|
| Node | v22.20.0（win32 x64） |
| 浏览器 | Playwright `channel=chrome`，HeadlessChrome **153.0.8010.36**，启动参数 **0 个** |
| WebGPU 适配器 | `adapter.info = {vendor:"nvidia", architecture:"lovelace", subgroupMinSize:32, subgroupMaxSize:32}`，`preferredFormat="bgra8unorm"` |
| WebGL2 | `gl.getParameter(RENDERER/VENDOR/VERSION)` 记录在 webgl2 半程产物中 |
| 上游 | `@cesium/engine` **26.3.0**；G-5 与 G-6 前后聚合哈希一致（零改动） |

---

## 5. 与 tasks.md 描述不符之处（实现偏离）

| ID | 偏离 | 处理 |
|---|---|---|
| D-1 | T026 自检写成两条 `run.mjs --backend=…` 加一条 `compare.mjs --offscreen`，本门禁照做；此外新增 `experiments/gates/shared/{terrain-scene,page-runner,png}.mjs` 供 G-5/G-6 共用（README 的目录规范按"每门禁自成目录"描述） | 共享夹具随门禁入库并在 `evidence` 中列出；不进入 `packages/**` |
| D-2 | tasks.md 把 T027 的判定产物写成 `out/g6.json`，未指定由哪个脚本写 | 新增 `experiments/gates/g6-judgement/run.mjs` 汇总两份半程产物并写 `out/g6.json` |
| D-3 | T025 要求"统计运行时 `ShaderProgram` 实例数" | Phase 3 尚未实现后端，故门禁自建**与上游同键语义**的变体驱动器（`g6-variants/driver.js`），键与 `GlobeSurfaceShaderSet.js:243-267` 一致；实现本身的这一面由 T079 验收 |
| D-4 | 变体枚举从 13824 收敛到 768 | 依据逐条写入 `define-matrix.mjs`（每个被排除取值给出上游行号）；**这不是为通过门禁而放宽**——收敛后编译耗时**仍然超预算并被判 fail** |
| D-5 | 黄金配置沿用尖刺实测配置（非量化 + TEXTURE_UNITS 1 + daynight，无地面大气） | BITS12 量化变体不做**像素**用例（需要复刻 `TerrainEncoding` 的 BITS12 打包器，属夹具而非发射器问题），但仍由 G-5 的 768 组合真机管线覆盖 |

---

## 6. 对后续任务的影响

1. **H-7 关闭**：像素一致性得到**逐字节相同**的证据，Y 翻转策略（GL `flipY` / WebGPU 上传反转行序）已被断言固定，可直接作为 T058（`visual:texture-origin`）与 T026 后续增量的基线。
2. **H-6 部分关闭**：变体**数量**与缓存语义可控（768 个组合、0 次重复编译、会话 8 个实例），但**单个新变体的编译代价（≈0.1 s）超出预先登记的预算** → 需在 plan 层面决定预热/预算修订/缩小模块三选一。
3. **Phase 2 状态**：G-1/G-2/G-3/G-4/G-5 通过、**G-6 fail** → 按门禁语义 **STOP**，`MUST NOT` 开始 Phase 3 实现任务。修订 `plan.md` 后应重新派发 T025 并重跑 `check-gate --all`。
4. **给 T079（`bench:shader-variants`）的输入**：变体规模基线 = 768 个 emit 产物 / 会话 8 个实例 / 缓存命中率 97.3% / 单次编译 ≈0.1 s，与 `budget.json` 同源，可直接作为该任务的验收数值。
