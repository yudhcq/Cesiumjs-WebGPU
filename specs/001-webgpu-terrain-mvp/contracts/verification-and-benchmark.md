# Contract: 可验证渲染与基准（Verification & Benchmark）

**Feature**: `001-webgpu-terrain-mvp` | **Spec**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

本契约定义"什么算通过"以及"性能如何被证明"。它是 CI 判定与 constitution 原则 III/IV 的落地形式。

---

## 1. 验证资产布局

```text
packages/verify-harness/          # 私有包（private: true），仅开发/CI 使用，不随主包发布
├── src/
│   ├── capture.ts                # Playwright 采集：固定视口/像素比/相机/时间，导出 RGBA8
│   ├── stats.ts                  # FrameStatistics 计算（与主包共享定义，避免口径漂移）
│   ├── compare.ts               # 像素对比 + 差异图 + 差异区域
│   ├── harness.ts                # 双路径参数化执行（同一测试体跑 webgl2 / webgpu）
│   ├── bench.ts                  # 帧时间/绘制批次/图形内存采集与门槛判定
│   └── instrumentation.ts        # 包装 WebGL2 平台 API（drawElements/drawArrays/bufferData/texImage2D）计数与计量
├── reference-frames/<datasetId>/<caseId>.<path>.png
└── tolerances/tol-v1.json
apps/demo/                        # 演示与验证宿主页（Rollup 构建的静态站点）
```

## 2. 参数化双路径执行（FR-011 / constitution 测试策略）

```ts
// 一个测试体，两条路径：禁止以 skip 代替断言
const paths = ["webgl2", "webgpu"] as const;
for (const preference of paths) {
  test.describe(`render path: ${preference}`, () => {
    test("multi-tile terrain matches reference within tolerance", async ({ page }) => {
      const result = await runCase(page, { caseId: "alps-fixed-view-01", preference });
      expect(result.verdict).toBe("pass");              // 失败即失败，不允许条件跳过
      expect(result.evidence.stats.nonBackgroundRatio).toBeGreaterThan(TOL.minNonBackgroundRatio);
      expect(result.evidence.stats.uniqueColorCount).toBeGreaterThan(TOL.minUniqueColors);
    });
  });
}
```
- 任一路径失败 → 该次提交判定失败（FR-011）。
- 无法消除的差异必须写成显式断言（如 `expect(webgpuEdgeRatio).toBeGreaterThanOrEqual(webgl2EdgeRatio * 0.9)`），
  而不是跳过或放宽阈值（constitution 原则 III）。

## 3. 确定性与容差（FR-012 / FR-014）

| 项 | 要求 |
|---|---|
| 相机 | `CameraSnapshot` 固定（经纬高/heading/pitch/roll），用例开始前 `setView` 并断言 `viewMatrix` 与快照一致（浮点容差 1e-9） |
| 场景时间 | 固定 ISO-8601，`shouldAnimate=false`，用例期间不得推进 |
| 视口与像素比 | 固定（默认 1280×720 @ pixelRatio 1）；断言 `scene.drawingBufferWidth/Height` 与之一致 |
| 随机性 | 固定种子；渲染路径中不得使用 `Math.random()`（静态扫描断言） |
| 数据集 | 固定 `local-fixed` 数据集；校验 `manifest.checksum`（防静默替换） |
| 等待条件 | `handle.whenTilesLoaded({timeoutMs})` 返回 `loaded=true` 后才采集；超时即判定失败并保留现场截图 |
| 非确定性来源 | 记录并量化（如首次采样丢弃帧数、GPU 计时抖动）；写入证据文件的 `notes` |
| 容差来源 | 每个 `ToleranceProfile` 必须带 `source`（推导说明 + 批准链接）；阈值写在 `tolerances/tol-v1.json` 并可追溯 |
| 抗锯齿边缘 | 按 `ignoreEdgePixels` 收缩后比较（对应 spec「不含抗锯齿边缘的区域内」的等价性定义） |

### 3.1 参考帧与比较设计（**每路径各自一份参考帧**）

**关键设计约束（已核实，research.md §7）**：**不得**把两条路径的画面互相当作参考帧做逐像素比较。
WebGL2 与 WebGPU 使用不同的光栅化器、不同的着色器编译器（ANGLE/GLSL vs Tint/SPIR-V）、
不同的 MSAA 解析与 sRGB 处理路径，跨路径逐像素比较会把"实现差异"误判为"回归"，
也会用放宽容差的方式掩盖真实缺陷。因此：

| 比较 | 方式 | 判据 |
|---|---|---|
| 路径内回归（阻断） | `webgpu` 帧 vs `webgpu` 参考帧；`webgl2` 帧 vs `webgl2` 参考帧 | 像素对比：每通道容差 + 差异像素比例上限 |
| 跨路径等价（阻断，但用统计量而非像素） | 两条路径在同一固定条件下的 `FrameStatistics`、几何统计与绘制批次数 | 落在**彼此声明的统计区间**内（FR-008 的"声明的容差"落在此处） |
| 跨路径像素差异（非阻断，仅真实 GPU 本地运行） | 同一台真实 GPU 上两条路径的帧 | 记录数值供参考；差异来源在契约中显式声明（FR-008 允许的"无法消除的差异"） |

**显式声明无法消除的跨路径差异**（FR-008 要求）：亚像素边缘覆盖、MSAA 解析、sRGB/色彩空间处理、
深度表示（WebGPU `depth32float` vs 上游 WebGL2 对数深度）。这些差异**必须**在契约中声明并附断言
（断言落在统计量与几何统计上），而不是靠放宽容差来掩盖。

**容差初值与其来源**（`tol-v1`，实现阶段允许调整但必须重新记录来源与批准）：
- `perChannelTolerance = 25`（0-255，单路径内比较）：全软件光栅化环境下同一路径的重复运行仍存在
  极小抖动，初值留出余量。
- `maxMismatchRatio = 0.001`（0.1% 像素，单路径内比较）：参照同类项目在生产 CI 中的取值
  （three.js E2E：每通道 0.1、差异像素 0.1%），本项目按 8bit sRGB 与 MSAA 差异留出更宽的单通道容差。
- `ignoreEdgePixels = 1`：1 像素边缘收缩，来源为抗锯齿与光栅化规则差异。
- 跨路径统计等价区间（`nonBackgroundRatio`、`uniqueColorCount`、`luminanceStdDev`、`drawCalls`、
  `triangles`）在实现阶段用实测标定，初值取两路径实测值的 ±10%（几何统计）与 ±5%（覆盖率统计）。
- **这些初值不是判据来源，判据来源是实现阶段用"人为注入缺陷 → 必须失败"的对照实验标定后的记录**（FR-014 / US3-IS）。
- 参考帧与浏览器版本绑定：Chromium 版本变更（Playwright 升级）会改变像素，**必须**在升级时重新生成参考帧
  并在提交信息中说明；Playwright 版本在仓库中固定（`devDependencies` 精确版本 + 锁文件）。

## 4. 差异证据（FR-013）

每次运行必须产出并上传为 CI 产物：
```text
artifacts/<commit>/<caseId>/<path>/
├── capture.png          # 本次采集
├── reference.png        # 参考帧（含生成环境标注）
├── diff.png             # 差异图（红=超容差，黄=边缘忽略区外的轻微差异）
├── stats.json           # FrameStatistics
├── evidence.json        # VisualVerificationEvidence（含容差、结论、差异区域）
└── console.log          # 页面控制台（含路径选择与回退原因提示）
```
失败时必须在 summary 中直接给出：差异像素比例、平均绝对差、差异区域包围盒（至少 1 个，最多 10 个）。
"人为引入一处渲染缺陷后验证必须失败并指出差异区域"作为**验证器自身的验收用例**（US3-IS）。

## 5. 基准（FR-017…FR-020）

```ts
export interface BenchCase {
  readonly caseId: string;             // 固定：dataset + camera + viewport + pixelRatio
  readonly warmupFrames: number;       // 固定 120
  readonly sampleFrames: number;       // 固定 600
  readonly paths: readonly RenderPathId[];
}
```
- 指标定义与口径见 [../data-model.md](../data-model.md) §4（帧时间 p50/p95、`drawCalls`、`gpuResourceBytes`）。
- 采集必须标注环境：OS、浏览器与版本、`adapterInfo`（vendor/architecture/device）、是否软件光栅化、
  是否 headless（FR-017 / FR-023）。
- **软件光栅化环境下的基准只作为"相对回归序列"使用**（已核实：软件适配器不提供真实 GPU 时间戳，
  其耗时由 CPU 光栅化速度与 runner 争用决定）。绝对性能数值只在受门控的真实 GPU 作业中采集，
  且**不得**与软件序列混入同一条比较链（环境指纹不同即重建基线）。
- 门槛判定：与**同一环境指纹**下最近一次通过记录比较；`frameTimeRegressionPct=10`、
  `gpuBytesRegressionPct=15`、`drawCallsRegressionPct=10` 为初值，变更必须记录理由与影响（FR-018）。
- 记录以 JSON 追加存档：`artifacts/bench/history.jsonl`（每行一条 `BenchmarkRecord`，形成历史序列，FR-020）。
- 优化提交必须附"基线 vs 优化后"实测对比（FR-019 / constitution 原则 IV）；无基线对比的优化不予合入。

## 6. CI 层级与门禁顺序（FR-021 / FR-022 / FR-025）

```text
[1] install + build          （Rollup 构建主包与演示页；生成 .d.ts）
[2] lint + typecheck         （tsc --noEmit，strict）
[3] unit                     （Node：能力探测决策、几何解码、状态机、架构边界断言 A1–A5）
[4] fixture integrity        （数据集 checksum 与清单校验，离线）
[5] contract + visual + bench（**两个并行 job**：webgl2 与 webgpu 各一个，均 headed + Xvfb，见 §7）
[6] license & dependency check（FR-024）
```
- 任一环节失败 → 阻断合入（FR-021）。判定依据只能是 CI 产物（FR-022）；本地通过不作为依据。
- 主干始终可构建、可运行、可回退（FR-025）：每个变更请求必须可在合并前回退（revert 即恢复）。
- 从提交到结论总耗时目标 ≤ 20 分钟（SC-005）。**风险与对策**：软件光栅化较慢，且 Free 计划并发上限为 20 个作业；
  因此基准在每提交作业中采用缩减采样帧数（仍满足"固定预热与采样次数"的口径要求，只是数值较小），
  绝对性能采集放到夜间受门控作业；超出 20 分钟时必须在 PR 中说明并给出分片或缓存方案。

## 7. 降级运行与盲区（FR-023）

CI 无真实 GPU，两路径均在软件光栅化下运行。**已核实的可用配方**（证据见 [../research.md](../research.md) §7）：

```yaml
# 每个 job 的前置（ubuntu-latest）
- run: sudo apt-get update && sudo apt-get install -y mesa-vulkan-drivers xvfb libvulkan1
- run: npx playwright install --with-deps chromium   # Playwright 版本在仓库中固定
- run: npm ci && npm run build
# 两个并行 job，均以 headed 模式跑在 Xvfb 下（headless 下 WebGPU 画布呈现不可靠，截图会全黑）
```

| | WebGL2（兜底路径）job | WebGPU（新路径）job |
|---|---|---|
| 环境变量 | `LIBGL_ALWAYS_SOFTWARE=1` | `VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json` |
| 启动 | `xvfb-run -a` + `headless: false` | `xvfb-run -a` + `headless: false` |
| 浏览器标志 | `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --no-sandbox --hide-scrollbars` | `--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --disable-gpu-watchdog --no-sandbox --hide-scrollbars` |

**已知的无效/过时标志（不得写入配置）**：`--enable-features=...,UseSkiaRenderer`（已废弃）、
`--disable-vulkan-surface`（会彻底关掉 WebGPU 画布呈现）、`--enable-unsafe-swiftshader`（**只对 WebGL 生效**，
对 WebGPU 无任何作用）、`--headless=new`（Puppeteer/Playwright 默认已带）。

**必须写入 `docs/ci-degradation.md` 的盲区清单**（逐条，来自已核实证据）：
1. 软件光栅化 ≠ GPU：无真实并行、**无真实 GPU 时间戳**（CI 中必须关闭 `timestamp-query`，否则会使
   Chrome Inspector/Profiler 崩溃）；性能数值**只具备相对回归意义**。
2. headless 下 WebGPU 画布呈现不可靠 → CI 以 headed + Xvfb 运行；该路径与真实桌面合成器不同。
3. Chromium 官方将 CPU 适配器标注为"未完全测试/不保证符合规范"；因此 CI 给出的符合性证据是弱证据。
4. 软件适配器下画布走 CPU 上传/回读路径，与真实 GPU 的呈现路径不同，一整类缺陷在 CI 中不可见。
5. 不同光栅化器的**亚像素边缘覆盖**存在差异，参考帧与阈值调参可能掩盖真实回归。
6. 设备丢失/GPU 进程卡死会导致浏览器进程需要被强制结束并重启（测试框架必须容忍并记录重试）。
7. Chromium 版本漂移会改变像素：Playwright 版本必须固定，升级浏览器版本时必须重新生成参考帧。
8. 无 GPU 时间戳 → CI 中**完全无法做 GPU 管线级性能剖析**。
9. 浮点精度与纹理格式上限在软件适配器与真实 GPU 之间**未验证等价**：`adapter.features` 必须在运行时枚举，
   测试据此门控，不得假设。
10. 公共仓的 **larger runner（含 GPU runner）始终计费**（即便公开仓），且 Free 计划并发上限为 20 个作业，
    "每次提交都跑两路径 × 视觉 + 基准"存在排队风险 → 必须分片并控制采样帧数。

**本地复现（与 CI 完全一致，使用同一份标志配置，禁止各写一份）**：
```bash
sudo apt-get install -y mesa-vulkan-drivers xvfb libvulkan1
npm ci && npm run build
CI=1 xvfb-run -a npm run test:visual -- --path=webgpu --make   # 生成参考帧（需人工批准）
CI=1 xvfb-run -a npm run test:visual -- --path=webgpu          # 校验
CI=1 xvfb-run -a npm run bench -- --path=webgpu --out=bench.json
```

**真实 GPU 数值**：仅在受门控的夜间作业（GPU larger runner，或自托管 runner）采集，且必须
与软件序列分开归档（环境指纹不同即重建基线，FR-018）。基准记录中 `degraded=true` 与
`degradationNotes` 为必填；跨"降级/真实 GPU"环境的数值**不得**直接比较。
