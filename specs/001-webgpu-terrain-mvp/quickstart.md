# Quickstart: 验证与复现指南

**Feature**: `001-webgpu-terrain-mvp` | **Plan**: [plan.md](./plan.md) | **Contracts**: [contracts/](./contracts/)

本文件是**可运行的验证/复现指南**：它说明如何证明"地形渲染跑通"以及如何复现 CI 的每一个判定。
它**不包含实现代码**；实现细节属于 `tasks.md` 与实现阶段。
所有命令均为**计划中的命令形态**（阶段 3/4 落地时按实际脚本名对齐，文档随实现同步更新）。

---

## 0. 与验收判据的对应关系

| 判据 | 复现命令（见下文编号） | 期望结果 |
|---|---|---|
| SC-001 两路径都渲染出地形并通过断言 | §3.2 + §4 | 两条路径用例全绿；`evidence.json` 结论 pass |
| SC-002 高程特征可观察（非空白/非单色） | §4 | `nonBackgroundRatio` 与 `uniqueColorCount` 落在声明区间 |
| SC-003 不支持新路径时 2 秒内回退 | §3.3 | 页面正常渲染；控制台/状态文案出现回退原因类别 |
| SC-004 交互无 >1s 卡顿、交互后断言仍通过 | §3.4 + §4 | 交互期间无超时中断；定格帧断言通过 |
| SC-005 从提交到结论 ≤ 20 分钟 | §5.1 | CI 总耗时打印 ≤ 20 min |
| SC-006 两路径各至少一份可比较基准记录 | §5.2 | `history.jsonl` 中两条路径各 ≥1 条记录 |
| SC-007 工期与消耗评估结论 | [mvp-estimate.md](./mvp-estimate.md) | 文档契约测试通过（schema + 7 条断言） |
| SC-008 时间区间与偏差说明 | [mvp-estimate.md](./mvp-estimate.md) §2 | 交付后回填 `actualsBackfill` |
| SC-009 合入前都有验证证据 | §6 变更检查表 | 抽查缺失证据比例为 0 |

---

## 1. 前置条件

```bash
node --version        # >= 22（本机实测 v22.20.0）
npm --version         # >= 10（本机实测 10.9.3）
```
- 浏览器：**真实 GPU 对照**需要支持 WebGPU 的桌面浏览器；**CI 等价复现**需要 Playwright 自带 Chromium。
- **无需任何访问令牌**：固定数据集随仓库提交，CI 与本地验证都不访问外部服务（FR-004）。
- 无需真实 GPU 即可完成全部自动化判定（降级方式见 §5.3）。

## 2. 安装与构建

```bash
npm ci                      # 使用仓库锁文件，安装 workspace 依赖
npm run build               # Rollup 构建主包（ESM + .d.ts）、验证脚手架、演示页
npm run typecheck           # tsc --noEmit（strict）
npm run lint
npm run test:unit           # node:test：探测决策/解码/状态机/截断规则/架构边界/评估文档契约
```

**期望**：构建产物 `packages/cesium-webgpu/dist/` 含 `index.js`、`index.d.ts`（**不得**出现 `GPU*`/`WebGL*` 后端符号）；
架构边界断言 A1–A5 全绿（见 [data-model.md](./data-model.md) §9）。

## 3. 运行演示与交互验证

### 3.1 启动（两条路径各一次）
```bash
npm run demo -- --preference=webgl2   # 兜底路径
npm run demo -- --preference=webgpu   # 新路径
```
**期望**：打开演示页后地形在固定相机下渲染出来；页面角落显示当前路径与（若回退）原因类别。
两个命令使用**同一个** `apps/demo` 入口文件——演示应用中不存在任何路径分支（FR-007 的活证据）。

### 3.2 就绪与多瓦片拼接
- 打开 DevTools 控制台，等待 `handle.whenTilesLoaded()` 报告 `loaded=true`（页面上也有加载进度）。
- **期望**：可见至少 **2×2** 瓦片拼接的表面；接缝处无可见裂缝/错位；无 NaN 顶点告警。

### 3.3 自动回退（FR-005 / FR-009 / SC-003）
```bash
npm run test:contract -- --grep "fallback"
```
**期望**：以 `--preference=webgpu` 启动但在页面注入"`navigator.gpu` 不存在 / `requestAdapter→null` /
`requestDevice→reject` / limits 低于下限 / 探测超时（2 秒）"五类条件下，页面**均**渲染出地形，
不出现未捕获错误，控制台给出回退原因类别，且探测耗时 ≤ 2000ms。

### 3.4 交互与设备丢失（FR-002 / FR-003 / SC-004）
- 手动：拖拽旋转、滚轮缩放、右键平移；**期望**画面连续更新且几何正确，无 >1 秒连续卡顿。
- 自动化设备丢失：
```bash
npm run test:contract -- --grep "device-lost"
```
**期望**：模拟设备丢失后场景在无需刷新页面的前提下恢复到可交互状态，并给出可观察提示；
若恢复失败则按 FR-009 回退到兜底路径并提示（两种结果都必须有明确状态，不允许静默黑屏）。

## 4. 视觉回归（双路径，FR-010 ~ FR-016）

```bash
npm run test:visual              # 两条路径都跑；任一路径失败即失败
npm run test:visual -- --update  # 仅在有意变更视觉时更新参考帧（必须在 PR 说明原因）
```
产物：`artifacts/<commit>/visual/<caseId>/<path>/{capture,reference,diff}.png` + `stats.json` + `evidence.json`。

**比较设计（重要，勿误用）**：
- **路径内回归（阻断）**：`webgpu` 帧对 `webgpu` 参考帧、`webgl2` 帧对 `webgl2` 参考帧，逐像素比较。
  **不要**把另一条路径的画面当参考帧——两条路径的光栅化器、着色器编译器（ANGLE/GLSL vs Tint/SPIR-V）、
  MSAA 解析与 sRGB 处理路径都不同，跨路径逐像素比较会误判。
- **跨路径等价（阻断）**：用 `FrameStatistics`（非背景覆盖率、唯一色数、亮度分布）与几何统计
  （绘制批次数、三角形数、覆盖瓦片数）落在彼此声明的区间内判定（契约
  [contracts/verification-and-benchmark.md](./contracts/verification-and-benchmark.md) §3.1）。
- **跨路径像素差异**：仅在真实 GPU 本地运行并记录数值，非阻断。

**期望**：
- 每条路径的 `evidence.json.verdict === "pass"`，且 `tolerance.source` 非空；
- 差异图被生成（失败时用于定位），差异区域给出包围盒；
- **自我校验**：注入一处已知渲染缺陷（如强制某个瓦片不绘制）后，本命令**必须失败**并指出差异区域（US3-IS）；
- 重复运行两次（同一提交）结论一致，不出现随机通过/失败（FR-012）。

## 5. CI 等价复现

### 5.1 全量门禁（与 CI 同序）
```bash
npm run ci:local        # 构建 → 单测 → 数据集校验 → 契约 → 视觉 → 基准 → 许可证
```
**期望**：与 `.github/workflows/ci.yml` 相同的顺序与结论；打印的总耗时 ≤ 20 分钟（SC-005）。

### 5.2 基准（FR-017 ~ FR-020 / SC-006）
```bash
npm run bench                       # 两条路径各采集一次
npm run bench -- --check-regression # 与同环境指纹的基线比较并判定门槛
```
**期望**：输出帧时间 p50/p95、图形资源字节数、绘制批次数并标注环境；
记录追加到 `artifacts/bench/history.jsonl`；劣化超过 `frameTime +10% / gpuBytes +15% / drawCalls +10%` 即失败，
并在输出中给出与基线的差值。

### 5.3 无真实 GPU 的降级复现（FR-023，方案已核实）

CI 与本地降级环境使用**同一份**浏览器标志配置（脚本内集中定义，禁止各写一份）。已核实的配方：

```bash
# 系统依赖（Ubuntu/Debian；三项均免费）
sudo apt-get install -y mesa-vulkan-drivers xvfb libvulkan1
npm ci && npm run build
npx playwright install --with-deps chromium     # Playwright 版本在仓库中固定

# WebGPU（新路径）：Xvfb + Mesa lavapipe；必须 headed，headless 下 WebGPU 画布呈现不可靠（截图会全黑）
VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json \
CI=1 xvfb-run -a npm run test:visual -- --path=webgpu
# 标志：--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist
#       --disable-gpu-driver-bug-workarounds --disable-gpu-watchdog --no-sandbox --hide-scrollbars

# WebGL2（兜底路径）：ANGLE + SwiftShader
LIBGL_ALWAYS_SOFTWARE=1 CI=1 xvfb-run -a npm run test:visual -- --path=webgl2
# 标志：--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --no-sandbox --hide-scrollbars
```
**注意**：`--enable-unsafe-swiftshader` **只对 WebGL 生效**，对 WebGPU 无任何作用；
`--disable-vulkan-surface` 会彻底关掉 WebGPU 画布呈现，**不得**使用（其余无效/过时标志见
[research.md](./research.md) §7）。

**期望**：与 CI 相同结论；基准记录带 `degraded: true`、`adapterType: "cpu"`、完整标志列表与 `degradationNotes`。
**盲区必须同时记录（10 条，逐条见 [research.md](./research.md) §7 与 `docs/ci-degradation.md`）**，其中对本项目影响最大的三条：
① 软件适配器**没有真实 GPU 时间戳**，CI 中的帧时间只具备相对回归意义，绝对性能必须在真实 GPU 采集；
② CPU 适配器被 Chromium 标注为"未完全测试/不保证符合规范"，CI 的符合性证据是弱证据；
③ 亚像素边缘覆盖差异会随光栅化器变化，阈值调参可能掩盖真实回归。

### 5.4 真实 GPU 对照（可选，非阻断）
```bash
npm run verify:real-gpu            # 在本机或云 GPU 上跑同一套视觉与基准用例
```
**期望**：产出带真实 `adapterInfo` 的基准记录；与 CI 的软件光栅化记录**分别归档**，用于评估降级偏差。
（云 GPU 的计费口径与成本见 [mvp-estimate.md](./mvp-estimate.md) §3。）

## 6. 变更检查表（每个变更请求必须满足）

1. 单元/契约/视觉/基准四项在 CI 全绿（本地通过不作为依据，FR-022）。
2. 若改动了渲染行为：附 `capture/diff` 与统计数值；若更新了参考帧，在提交信息中说明原因（SC-009）。
3. 若声称性能优化：附"基线 vs 优化后"实测对比，否则不予合入（FR-019 / 原则 IV）。
4. 若调整容差或回归门槛：在 `tolerances/tol-v1.json` 或门槛文件中更新 `source` 字段并说明理由与影响（FR-014 / FR-018）。
5. 若新增上游 API 依赖：同步更新 `docs/upstream-api-allowlist.md`，且必须是公开（非 `@private`/`@experimental`）API（原则 I）。
6. 若改动口径或单价相关项：更新 [mvp-estimate.md](./mvp-estimate.md) 与 `mvp-estimate.v1.json` 并递增版本（FR-028）。

## 7. 上游升级演练（验证 adapter 收敛，constitution 原则 I）

```bash
npm run upgrade:check -- --cesium=<next-version>
```
**期望**：仅在 `packages/cesium-webgpu/src/adapters/cesium/**` 需要改动时，全量验证通过；
若需要改动该目录以外的代码，则该升级按 constitution 视为**破坏性变更**，必须先修订计划并给出迁移方案。
演练步骤：升级 devDependency → `npm run ci:local` → 对比 `git diff --stat` 的改动范围是否收敛于 adapter 层。

## 8. 常见失败与定位

| 现象 | 优先排查 |
|---|---|
| 画面全背景色/空白 | `whenTilesLoaded` 是否 `loaded=true`；地形 provider 是否就绪；WebGPU 画布是否被其他元素遮挡 |
| 只有兜底路径能出图 | 探测原因类别（`path.reason`）；`navigator.gpu` 可用性；能力下限（`maxTextureDimension2D`/`maxBufferSize`） |
| 接缝有裂缝/尖刺 | 裙边高度与边界顶点生成；解码后的高程是否出现 NaN（`TileError.category === "decode"`） |
| 验证结论随机波动 | 固定条件是否齐全（相机/时间/视口/像素比/数据集 checksum）；预热与采样帧数；是否有未固定的随机源 |
| 基准数值与本地差异大 | 环境指纹（软件光栅化 vs 真实 GPU）；是否跨环境比较（禁止） |
| CI 中 WebGPU 不可用 | `docs/ci-degradation.md` 的标志组合；浏览器版本；降级为数值断言 + 本机像素对比 |
