# Quickstart: 验证与复现指南（渲染后端替换版）

**Feature**: `001-webgpu-terrain-mvp` | **Plan**: [plan.md](./plan.md) | **Contracts**: [contracts/](./contracts/) | **Research**: [research.md](./research.md)

本文件是**可运行的验证/复现指南**：说明如何证明"地形渲染在新渲染后端下端到端跑通"，以及如何复现 CI 的每一个判定。
它**不包含实现代码**；实现细节属 `tasks.md` 与实现阶段。命令为计划形态；阶段 3/4 落地后按实际脚本名同步。

> **本版前提（与上一版的关键差异）**：不存在"我们的画布"与"上游画布"的叠加——只有**一条**渲染后端在运行：
> 要么是受控 fork 的 WebGPU 后端（补丁层），要么是上游原版 WebGL2 后端；回退是**整体销毁重建**
> （constitution v2.0.0 原则 II）。

---

## 0. 与验收判据的对应关系

| 判据 | 本文件中的复现方式 |
|---|---|
| SC-001 地形在两路径各自通过断言 | §4 视觉回归（两次独立运行）+ §3 演示 |
| SC-002 高程特征可观察 | §4 的统计断言（覆盖率高差、明暗差） |
| SC-003 不支持 WebGPU 时整体兜底 ≤2s | §3.3 |
| SC-004 交互无 >1s 卡顿 | §3.4 |
| SC-005 流水线 ≤20 分钟、任一失败阻断 | §6 |
| SC-006 基准可比较（两路径独立会话） | §5 |
| SC-007 工期与消耗结论 | [mvp-estimate.md](./mvp-estimate.md) |
| SC-010 逻辑层零改动 + 绘制 100% 由 WebGPU 完成 | §2（补丁范围审计 + 依赖完整性 + 逻辑层零覆盖） |

## 1. 前置条件

- **Node.js ≥ 22**；包管理器使用仓库锁文件（`npm ci`）。
- **浏览器**：真实 GPU 验证需要支持 WebGPU 的桌面 Chrome（本机已实测 Chrome 153 零开关即得硬件适配器）；
  CI 等价复现使用 Playwright 自带 Chromium（**版本必须精确固定**）。
- **CI 系统包（Ubuntu/Debian，均免费）**：`mesa-vulkan-drivers xvfb libvulkan1`。
- **着色器转换工具链（仅一次性转换与 CI 校验，不进入运行时）**：
  - `glslang 16.6.0`：Khronos 官方预编译包（`glslang-16.6.0-linux-x86_64-release.zip`）；
  - `naga-cli 30.0.1`：**无预编译二进制** → `cargo install naga-cli --version 30.0.1 --locked`（CI 缓存 `~/.cargo`）；
    **版本 MUST 显式锁定**（缺 `--version 30.0.1` 即视为失败，与 `tasks.md` 的 CI 断言一致）；
  - `@webgpu/glslang 0.0.15`：若使用，MUST 显式引 `dist/web-devel-onefile`（默认 Node 入口实测挂死 >120 s）。
- **上游依赖**：`@cesium/engine@26.3.0`（= `cesium@1.145.0`），精确版本 + 完整性哈希（见 `upstream/engine-26.3.0.lock.json`）。

## 2. 安装、构建与**补丁边界自检**（先做这一步）

```bash
npm ci                                   # 锁定 @cesium/engine@26.3.0 与 integrity
npm run build                            # Rollup：别名插件把清单内模块替换为 backend-webgpu/Renderer/**
node tools/audit-patch-scope.mjs         # AU-1…AU-4：补丁范围 / 完整性 / 逻辑层零覆盖 / 接口一致性（干跑）
node tools/gen-interface-manifest.mjs --check   # 被依赖接口面未漂移（升级漂移的早期信号）
node --test tests/unit/rollup-plugin-engine-patch.test.mjs   # 别名白名单穷举：被改写集合 == 清单集合
```

**通过判据**：`PatchScopeAudit.verdict === "pass"`，且 `logicLayerOverrides === 0`。
这一组检查就是 SC-010 的"逻辑层代码改动为零 + 改动只在渲染后端层"的机器证明。

## 3. 运行演示（两条路径各一次，绝不并行）

```bash
node tools/scripts/serve.mjs &            # 零依赖静态服务
# 只启用 WebGPU（新后端）
RENDER_BACKEND=webgpu  npm run demo -- --dataset=matterhorn-z0-12
# 只启用 WebGL2（兜底后端，上游原版）
RENDER_BACKEND=webgl2 npm run demo -- --dataset=matterhorn-z0-12
```

### 3.1 就绪与多瓦片拼接（SC-001/SC-002）

演示页状态区应显示：当前路径、是否降级、瓦片加载进度、数据源署名。
等待 `whenTilesLoaded()` 返回 `loaded: true`；画面应为连续地形表面（非空白/非纯背景色），且可见高程起伏。

### 3.2 交互（SC-004）

旋转/缩放/平移 3 秒：画面持续更新、无 >1 s 连续卡顿、无撕裂/空洞/错误遮挡；定格帧仍满足统计断言。

### 3.3 整体回退（FR-005 / FR-009 / SC-003）

```bash
RENDER_BACKEND=webgpu FORCE_NO_WEBGPU=1 npm run demo -- --dataset=matterhorn-z0-12
```
期望：2 秒内完成探测失败判定 → **整体**以 WebGL2 构造；状态区给出原因类别（如 `no-adapter` / `device-request-failed`）；
无未捕获错误、无空白画面、**不存在**两条路径叠加的中间态。

### 3.4 设备丢失恢复（FR-003）

演示页提供"模拟设备丢失"入口（`device.destroy()`）：期望停止提交 → 销毁后端与场景 → 重新探测 → 整体重建 →
恢复交互；状态区给出提示；旧设备资源计数归零。

## 4. 视觉回归（双路径各自独立运行，FR-010 ~ FR-016 / SC-009）

```bash
npm run test:visual -- --backend=webgpu     # 独立进程 + 独立页面加载
npm run test:visual -- --backend=webgl2     # 另一次独立运行
```

- 参考帧：`reference-frames/<datasetId>/<caseId>.<backend>.png`（**每路径各自一份**），
  元数据记录路径/浏览器版本/是否软件光栅化；
- 比较：排除抗锯齿边缘；容差写在测试代码中（`ToleranceRecord` 可追溯来源）；
- 失败时产出差异图与统计 JSON 到 `artifacts/`；
- 断言另一条后端的 GPU 对象创建数为 0（"只启用一条路径"）。

**着色器前端相关断言**（本版新增，见 [contracts/verification-and-benchmark.md](./contracts/verification-and-benchmark.md) §4）：

```bash
node tools/shader-verify.mjs --family=globe --variants=mvp   # SH-2：真机 createRenderPipeline（需 GPU）
naga --input-kind wgsl backend-webgpu/webgpu/wgsl/*.wgsl     # SH-7：CI 无 GPU 时的模块级校验（盲区已记录）
node tools/shader-verify.mjs --check-leaf-map                # SH-3：叶子哈希映射完整性
node --test tests/unit/glsl-preprocess.test.mjs              # SH-4：条件编译求值（含 #elif 与算术条件）
```

## 5. 基准（FR-017 ~ FR-020 / SC-006）

```bash
npm run bench -- --backend=webgpu   # 独立会话
npm run bench -- --backend=webgl2   # 另一次独立会话（不得与上一条同时运行）
```

产出：帧时间 p50/p95、图形显存代理指标、draw call 数、`EnvironmentFingerprint`；写入 `artifacts/history.jsonl`；
超阈值即失败并给出与基线的差值（`degraded: true` 时只作**相对**结论，且必须标注）。

## 6. CI 等价复现（无 GPU 环境，SC-005 / FR-023）

```bash
# 系统依赖
sudo apt-get install -y mesa-vulkan-drivers xvfb libvulkan1
npx playwright install --with-deps chromium

# WebGPU 路径（必须 headed + Xvfb）
VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json CI=1 RENDER_BACKEND=webgpu \
  xvfb-run -a npm run test:visual -- --backend=webgpu
# 标志：--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist
#       --disable-gpu-driver-bug-workarounds --disable-gpu-watchdog --no-sandbox --hide-scrollbars

# WebGL2 路径
LIBGL_ALWAYS_SOFTWARE=1 CI=1 RENDER_BACKEND=webgl2 \
  xvfb-run -a npm run test:visual -- --backend=webgl2
# 标志：--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --no-sandbox --hide-scrollbars
```

CI 顺序见 [contracts/verification-and-benchmark.md](./contracts/verification-and-benchmark.md) §7；
盲区（软件光栅化 ≠ GPU、无 GPU 时间戳、**naga WGSL 校验不覆盖 WebGPU 管线校验**）见同文件 §8 与 `docs/ci-degradation.md`。

**真实 GPU 对照（可选、非阻断、需预算批准，默认不执行）**：在本机/自托管 GPU 或按秒计费的现货云 GPU 上，
跑同一套 harness（含 `tools/shader-verify.mjs` 的真机管线校验与 timestamp 剖析），记录环境指纹后归档。

## 7. 着色器叶子的转换流程（一次性，需评审）

```bash
# 1) 取"真正送进编译器的 GLSL"（跑上游拼装逻辑；尖刺脚本已可复用）
node experiments/shader-spike/scripts/extract-cesium-glsl.mjs
# 2) 路径 A 出草稿（glslang → SPIR-V → naga → WGSL）
#    ⚠️ `run-path-a.ps1` 是**尖刺期的 Windows-only 编排脚本**，仅用于一次性转换草稿；
#    它 MUST NOT 成为 CI 或任何自检的前提（CI 目标为 Linux + bash）。
#    Windows（尖刺留存）：
pwsh -File experiments/shader-spike/scripts/run-path-a.ps1      # 结果落 logs/
#    跨平台等价编排 MUST 由 Node 脚本承担（复用同目录的 glslang-to-spirv.mjs /
#    prepare-spirv-able.mjs / repair-preprocessed.mjs），缺口在 W4 工作流中补齐。
# 3) 人工/发射器定稿 → 入库 backend-webgpu/webgpu/wgsl/**（MUST NOT 写入 Source/Shaders/**）
# 4) 更新映射表并做真机校验
node tools/shader-leaf-map.mjs --update && node tools/shader-verify.mjs --family=globe
```

**规则**：每个叶子 MUST 有 `verifiedOnRealGpu: true` 才允许进入验收路径；上游叶子哈希变化时该叶子 MUST 重做转换
（CI 会失败并输出清单）。

## 8. 上游升级演练（constitution 原则 I）

```bash
node tools/upgrade-drill.mjs --dry-run                 # 离线：用已提交清单校验漂移（每次提交都跑）
node tools/upgrade-drill.mjs --to=26.4.0 --full        # 升级 PR：拉取新版 tarball 做完整演练
```

完整模式产出 `UpgradeDrillRecord`：上游漂移清单 + 接口一致性差异（= 改造清单）+ 需要重做转换的着色器叶子 +
全量验证结果；**三项齐备才可合入**。

## 9. 常见失败与定位

| 症状 | 首先检查 |
|---|---|
| 黑屏但无报错 | 通道状态机是否正确闭合（`endFrame` 前无未闭合 pass）；纹理 Y 翻转是否处理；`clear` 的 `loadOp` |
| 管线创建失败 / 绘制消失 | 真机 `createRenderPipeline` 校验信息（varying 不匹配、绑定布局、目标格式、`sampleCount`） |
| uniform 值不生效 | uniform 块布局与 WGSL 结构是否逐字段一致（G-4）；动态偏移是否正确 |
| 地形位置/深度不对 | 深度范围修正（GL z∈[-1,1] → WebGPU z∈[0,1]）是否在发射器内成对处理 |
| 补丁审计失败 | 是否改了 `Renderer/**` 之外的文件；别名白名单是否与清单一致 |
| 着色器映射失败 | `shader-leaf-map.json` 是否命中；上游版本是否变化（哈希漂移） |
| WebGPU 用例在 CI 上画布全黑 | 是否误用 headless（MUST headed + Xvfb）；是否漏了 `--enable-unsafe-webgpu`/`--enable-features=Vulkan` |
| 两条路径结论不一致 | 是否在**同一次运行**里跑了两条路径（违反原则 II；必须拆成两次独立运行） |
