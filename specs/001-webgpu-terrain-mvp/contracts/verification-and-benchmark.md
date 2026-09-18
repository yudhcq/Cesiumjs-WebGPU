# Contract: 可验证渲染与基准（Verification & Benchmark）

**Feature**: `001-webgpu-terrain-mvp` | **Status**: 设计基线 v2 | **Spec**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)
**Constitution**: v2.0.0 原则 II（二选一）、原则 III（可验证渲染）、原则 IV（性能以数据驱动）、原则 V（CI 为唯一事实来源）

本契约定义"什么算通过"以及"性能如何被证明"。**本版新增**：着色器编译前端的验证门禁（真机管线校验是
唯一能捕获 varying/绑定布局错误的手段）与补丁范围审计作为渲染结论的**前置条件**。

---

## 1. 验证资产布局

```text
tests/
├── unit/                       # node --test：探测决策、manifest 规则、别名白名单、条件编译求值、
│                               #   uniform 布局生成、格式映射、shader-leaf-map 完整性、评估文档契约
├── contract/                   # Playwright：地形就绪、交互、回退、设备丢失（参数化 webgl2 / webgpu）
├── visual/                     # 视觉回归：每路径各自参考帧 + 差异图
└── benchmark/                  # 基准：两路径各自独立会话
reference-frames/<datasetId>/<caseId>.<backend>.png     # 每路径各自一份 + 元数据（路径/浏览器版本/是否软件光栅化）
artifacts/                                              # CI 产物：差异图、统计 JSON、基准 history.jsonl、审计 JSON
```

## 2. 双路径执行模型（FR-011 / 原则 II）

- 同一套用例**参数化**为两次**独立运行**：独立进程 + 独立页面加载（`RENDER_BACKEND=webgpu|webgl2`）；
- 每次运行 MUST 断言：**另一条后端的 GPU 对象创建数为 0**（"只启用一条路径"的可执行判据）；
- **MUST NOT** 存在任何"同一会话内两条路径同时绘制"的用例或脚手架（含画布叠加、遮挡、逐帧合成）；
- 任一路径未通过即判定该次提交失败（FR-011）。

## 3. 确定性与容差（FR-012 / FR-014）

- 固定：相机、场景时间、随机种子、视口尺寸、设备像素比、地形数据集、MVP 场景配置
  （`baseLayer:false`、`skyBox:false`、`skyAtmosphere:false`、无后处理）。
- **每路径各自参考帧**：跨路径逐点像素比较不可靠（不同光栅化器、不同着色器编译器、MSAA 解析与 sRGB 路径不同）。
- 路径内回归：像素对比（阻断）；比较区域**排除抗锯齿边缘**；容差写入测试代码并记录来源（`ToleranceRecord`）。
- 跨路径等价（FR-008）：用**统计断言**（非背景覆盖率、颜色/深度分布、几何与 draw call 统计落在声明区间）+
  `declaredDifferences` 显式声明无法消除的差异（亚像素边缘、MSAA 解析、sRGB、深度表示、
  **WGSL 无精度修饰符带来的精度差**、**纹理 Y 翻转处理差异**）。
- 禁止"任意像素差异均通过"式宽松判据；禁止用 `skip` 代替差异断言。

## 4. 着色器编译前端的验证（本版新增，对应 G-5/G-6）

| 门禁 | 内容 | 通过判据 |
|---|---|---|
| SH-1 视图不变 | 逻辑层对 GLSL 的读取行为不变 | `shaderProgram.vertexShaderSource`/`fragmentShaderSource` 仍含 GLSL 文本，`Scene/Primitive.js` 的正则探测仍命中；`_attributeLocations` 存在且一致 |
| SH-2 变体管线校验 | **真机** `createRenderPipeline` 对地形全部可达 define 组合通过 | 0 validation error；varying 集合 VS/FS 成对匹配（实测：不匹配即硬失败 `fragment input at location N doesn't have a corresponding vertex output`） |
| SH-3 叶子映射 | 验收路径用到的上游叶子均在 `shader-leaf-map.json` 中命中且 `verifiedOnRealGpu === true` | 哈希漂移即失败（升级漂移检测） |
| SH-4 条件编译求值 | 求值结果与上游一致（含 `#elif` 链、`&&`/`\|\|`/`!`、算术条件） | 单元用例 + `ConditionalCompilationTrace` 落盘 |
| SH-5 像素回归 | 精度差异与 Y 翻转不引入未声明差异 | 与 WebGL2 基线像素 diff（排除边缘）+ 四角纹素回读断言 + 地形高程数值比对 |
| SH-6 变体规模 | 运行时变体数量与编译耗时在预算内 | 运行时 `ShaderProgram` 实例数与耗时直方图落盘，超阈值失败 |
| SH-7 CI 校验（降级） | 无 GPU 环境用 `naga --input-kind wgsl` 做模块级校验 | 语法/模块校验通过；**盲区显式记录**：不覆盖 WebGPU 管线校验 |

## 5. 补丁与前端的审计门禁（渲染结论的前置条件）

| 门禁 | 内容 | 通过判据 |
|---|---|---|
| AU-1 补丁范围 | 见 [fork-patch-layer.md](./fork-patch-layer.md) §4 | `PatchScopeAudit.verdict === "pass"` |
| AU-2 依赖完整性 | 上游包完整性哈希与基线一致 | 一致；否则失败 |
| AU-3 逻辑层零覆盖 | 构建产物中来自本仓库的 `Renderer/**` 之外的上游模块数 = 0（SC-010） | `logicLayerOverrides === 0` |
| AU-4 接口一致性 | 干跑模式校验被依赖接口面未漂移 | 无 `breakingConsumedMembers` |
| AU-5 许可证 | LICENSE/NOTICE/修改文件清单/地形署名 | 齐备且与 manifest 一致 |

**渲染类结论（像素、统计、基准）只有在 AU-1…AU-5 全部通过时才被认定为"对该次提交成立"。**

## 6. 基准（FR-017 ~ FR-020 / 原则 IV）

| 指标 | 采集方式 | 备注 |
|---|---|---|
| 帧时间 p50 / p95 | `Scene` 相邻两帧 `performance.now()` 差；固定预热（默认 120 帧）与采样帧数（默认 600 帧，CI 缩减） | 两路径同口径 |
| 图形显存（代理指标） | 后端登记的 GPU 对象字节数（`GpuResourceRecord.bytes` 汇总） | 浏览器不暴露真实 VRAM → 必须与 `degraded`/适配器类型一起解读 |
| 绘制批次数 | 统计真实 `drawIndexed`/`draw` 调用数 | WebGL2 侧通过包装平台 API `drawElements/drawArrays` 计数（包装平台 API 不是改上游实现） |
| GPU 时间戳 | 真实 GPU 作业（`timestamp-query`） | CI 软件适配器下不可用；默认不执行，需预算批准 |

- 两条路径 MUST 在**各自独立会话**采集（MUST NOT 以"两条路径同时运行"作对比口径）；
- 量化回归门槛（帧时间/显存劣化超阈值即失败），阈值变更记录理由；记录 `EnvironmentFingerprint`；
- 结果写入 `artifacts/history.jsonl` 形成历史序列。

## 7. CI 层级与门禁顺序（FR-021 / FR-022 / FR-025）

```text
[1] install + build（钉版与完整性校验；别名插件生效）
[2] lint + typecheck
[3] unit（探测决策 / manifest 与白名单 / 条件编译 / uniform 布局 / 格式映射 / 评估契约 / 架构边界 A1–A11）
[4] audit（AU-1…AU-5：补丁范围、完整性、逻辑层零覆盖、接口一致性干跑、许可证）
[5] shader（SH-3/SH-4/SH-7：叶子映射、条件编译、WGSL 模块校验）
[6] contract + visual + bench（两个并行 job：webgl2 与 webgpu，各自独立进程；job 内顺序 contract → visual → bench）
[7] 汇总：任一失败阻断合入；全部门禁耗时目标 ≤ 20 分钟
```

- CI 产物 MUST 上传：构建日志、测试报告、差异图、统计 JSON、`history.jsonl`、审计 JSON、升级演练记录；
- 本地通过不等于通过（FR-022）；主干必须始终可构建、可运行、可回退（FR-025）；
- 跳过测试必须附理由并在 PR 说明，禁止长期无条件跳过。

## 8. 降级运行与盲区（FR-023）

| 降级项 | 配方 | 盲区 |
|---|---|---|
| WebGPU 路径（无 GPU CI） | Xvfb（headed）+ Mesa lavapipe；`--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --disable-gpu-watchdog --no-sandbox`；`VK_DRIVER_FILES=…/lvp_icd.x86_64.json` | 软件光栅化 ≠ GPU；无 GPU 时间戳；画布呈现路径与真实桌面不同；lavapipe 报错文本可能与真实驱动不同 |
| WebGL2 路径 | Xvfb + ANGLE/SwiftShader；`LIBGL_ALWAYS_SOFTWARE=1`；`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` | 同上；Chrome 139 起需显式开启 SwiftShader 回退 |
| WGSL 校验 | `naga --input-kind wgsl <file>` | **不覆盖 WebGPU 管线校验**（varying 契约、绑定布局、格式兼容）→ 依赖本机/自托管真机 harness |
| 绝对性能 | 受门控的真实 GPU 作业（默认不执行，需预算批准） | 无批准时只提供**相对**回归结论，绝对性能标记 `degraded:true`，不得据此宣称性能收益 |

降级策略、盲区与**本机复现步骤** MUST 写入 `docs/ci-degradation.md`。
