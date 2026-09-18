# experiments/ —— 已废弃（superseded）

本目录是 **Phase 1 门禁（G-1/G-2）** 的实验产物。它验证的架构是**「双画布分层 + 隐藏上游地形」**，
该架构已于 2026-09-19 被用户明确否决（见 `specs/001-webgpu-terrain-mvp/spec.md` 的 Clarifications Q3/Q4
与 `.specify/memory/constitution.md` v2.0.0 的 Governance）。

**保留原因**：审计痕迹——记录"为什么没有走双画布路线"，以及两条仍然有效的实测结论：

1. **无头 Chrome 153 零启动开关即可取得硬件 WebGPU 适配器**
   （`adapter.info = {vendor:"nvidia", architecture:"lovelace"}`，`requestDevice()` 成功）。
   此结论与架构无关，后续 CI 设计可直接复用。
2. **`TerrainProvider` 不允许直接实例化**：官方 JSDoc 明写 "This type describes an interface and is
   not intended to be instantiated directly."，`new` 即抛 `DeveloperError`；Cesium 自身用
   `Object.create(TerrainProvider.prototype)` + own properties 实现。
3. **`GeographicTilingScheme` 的 level 0 是 2 块瓦片**（x=0/1），只提供 1 块会渲染成半个地球。
4. **一个 canvas 只能有一种上下文类型**：在 canvas 上先调 `getContext("webgl2")` 会永久剥夺其 WebGPU 上下文。

**注意**：`g1-*.ts` / `collect-g1.mjs` 等代码实现的是被否决的架构，**不要作为新方案的参考基线**。
`out/` 下的截图与 JSON 是当时的原始证据，未做修饰。

当前有效方向见 `specs/001-webgpu-terrain-mvp/`（受控 fork：以 WebGPU 替换渲染后端，逻辑层不改）。

---

## `shader-spike/` —— 有效（2026-09-18，技术可行性尖刺）

与上面的 G-1/G-2 无关，是**当前方向**下的着色器转换可行性实测（GLSL → WGSL）。
主报告：`shader-spike/REPORT.md`；结论摘要见该文件 §0。

- 关键结论：路径 A（glslang→SPIR-V→naga→WGSL）顶点着色器 3/3 通过且被真机 GPU 接受，
  片元着色器 0/2（naga 30.0.1 崩在 `invalid id %243`）；路径 B（人工移植 WGSL）真机跑通
  （0 编译消息 + 4096/4096 非黑像素）。
- 复现：`node shader-spike/scripts/extract-cesium-glsl.mjs`、
  `pwsh -File shader-spike/scripts/run-path-a.ps1`、`node shader-spike/scripts/webgpu-harness.mjs`。
- 工具链装在 `%TEMP%\shader-spike`，**仓库根没有 `package.json`**。
