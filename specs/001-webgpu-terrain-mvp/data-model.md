# Data Model: WebGPU 渲染后端替换（受控 fork / 补丁层）

**Feature**: `001-webgpu-terrain-mvp` | **Date**: 2026-09-19 | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

本文件把 `spec.md` 的 Key Entities 落成可实现的类型与状态机，并把**新的架构约束**（受控 fork、二选一、
补丁范围审计、切片 A/B）建模为一等实体。**本文件是设计产物，不回写 spec**；spec 的 FR/SC 在每节以 `→ FR-0xx / SC-0xx` 追溯。

约定：

- 上层 API 与状态类型位于 `packages/cesium-webgpu/src/**`；补丁层实现位于 `packages/cesium-webgpu/backend-webgpu/**`。
- **`src/api/**` 与 `src/index.ts`（上层 API）中 MUST NOT 出现 `GPU*` / `WebGL*` / `navigator.gpu` / `@cesium/engine/Source/Renderer/**` 等后端符号**（→ FR-007、SC-010，见 §11 边界断言）。
- 补丁层（`backend-webgpu/**`）MUST NOT 被 `src/**` 反向 import 具体实现类型（→ 原则 II 的后端抽象条款）。
- 时间单位统一 `ms`（number）；内存单位统一字节（number，前缀 `bytes`）；货币 CNY（并附 USD 口径，见 `mvp-estimate.md`）。
- 所有枚举值以字符串字面量联合表示，便于写进 CI 产物 JSON。

---

## 1. 上游基线与补丁（受控 fork 的建模）

### 1.1 `UpstreamBaseline`（上游基线）

| 字段 | 类型 | 说明 / 校验 |
|---|---|---|
| `packageName` | `"@cesium/engine"` | 常量 |
| `version` | `string` | MUST 为精确版本（MVP：`"26.3.0"`），MUST NOT 使用 `^`/`~` 范围（→ FR-032） |
| `cesiumVersion` | `string` | 上游 `index.js` 的 `CESIUM_VERSION`（MVP：`"1.145.0"`，已核实） |
| `integrity` | `string` | 安装包完整性哈希（lockfile 中的 `sha512-…`）；CI MUST 断言安装后一致 |
| `license` | `"Apache-2.0"` | 与 `LICENSE.md` 一致 |
| `recordedAt` | `string` (date-time) | 基线登记时间 |
| `notes` | `string` | 基线说明（含"逻辑层不改动"的边界声明） |

**校验规则**：`version` 变更 MUST 触发 `UpgradeDrillRecord`（→ §1.4）与结论修订评估（→ FR-028）。

### 1.2 `PatchManifestEntry`（替换清单条目）

| 字段 | 类型 | 说明 / 校验 |
|---|---|---|
| `upstreamModule` | `string` | MUST 匹配 `^Renderer/[A-Za-z0-9_]+\.js$`（→ FR-031、SC-010） |
| `localFile` | `string` | 相对 `backend-webgpu/` 的路径；MUST 存在 |
| `kind` | `"replace" \| "adapt" \| "adapt-shader"` | `replace`=WebGL 调用点重实现；`adapt`=语义绑定 GL 资源需小改；`adapt-shader`=着色器编译目标参数化（`ShaderSource.js`），改动 MUST 限于"增加 WGSL 发射通道"且 GLSL 视图不变 |
| `requirementRef` | `string[]` | MUST 非空，元素形如 `"FR-030"` / `"FR-031"`（补丁最小性与可追溯，→ 原则 I） |
| `reason` | `string` | 该文件为何必须进入补丁层（一句话） |
| `glCallSites` | `number` | 上游该文件的 WebGL 调用点数（证据；`replace` 类 MUST > 0） |

**关系**：`PatchManifest` = `{ baseline: UpstreamBaseline, entries: PatchManifestEntry[], keptModulesHash: string }`；
`keptModulesHash` 覆盖 `Renderer/**` 中**未**进入清单的模块（31 个 GL-free 文件）的哈希集合 → 任一被保留模块发生变化即告警（→ §1.3 审计）。

### 1.3 `PatchScopeAudit`（补丁范围审计记录，CI 产物）

| 字段 | 类型 | 说明 |
|---|---|---|
| `baselineVersion` | `string` | 审计针对的上游版本 |
| `integrityOk` | `boolean` | 安装物完整性哈希与基线一致（字节级不变的机器证明之一） |
| `manifestPathsValid` | `boolean` | 全部 `upstreamModule` 匹配 `^Renderer/` |
| `aliasWhitelistExhaustive` | `boolean` | 喂入 `Source/**` 全部模块路径后，被改写的路径集合**恰好等于**清单集合 |
| `logicLayerOverrides` | `number` | 构建产物中来自本仓库的、`Renderer/**` 之外的模块数；MUST 为 `0`（→ SC-010） |
| `keptModulesUnchanged` | `boolean` | `keptModulesHash` 一致 |
| `verdict` | `"pass" \| "fail"` | 任一布尔为 false 或 `logicLayerOverrides > 0` 即 `fail`（阻断合入） |

### 1.4 `InterfaceManifest` 与 `InterfaceManifestDiff`（升级可维护性）

| 实体 | 字段 | 说明 |
|---|---|---|
| `InterfaceManifest` | `baselineVersion`, `generatedAt`, `entries: InterfaceEntry[]` | `InterfaceEntry = { module, exportedSymbols[], consumedMembers: {name, kind, arity?}[], consumedBy: string[] }`（`consumedBy` 为逻辑层文件列表，来自静态扫描） |
| `InterfaceManifestDiff` | `fromVersion`, `toVersion`, `changedRenderModules: string[]`, `driftedKeptModules: string[]`, `breakingConsumedMembers: InterfaceEntry[]`, `affectedReplacements: string[]`, `estimatedEffort: "none" \| "low" \| "medium" \| "high"` | 升级演练产物（→ FR-032） |
| `UpgradeDrillRecord` | `mode: "dry-run" \| "full"`, `ranAt`, `diff: InterfaceManifestDiff`, `verification: VerificationRun[]`, `verdict` | 三项齐备（补丁范围审计 + 接口一致性 + 全量验证）才可 `pass`（→ 原则 I 的升级演练条款） |

---

## 2. 渲染路径二选一（不同时运行）

### 2.1 `BackendKind`

`"webgpu" | "webgl2"`。**同一会话（同一次页面加载/进程）中只有一个取值生效**（→ FR-006、SC-001）。

### 2.2 `CapabilityProbeResult`（能力探测结果）

| 字段 | 类型 | 校验 |
|---|---|---|
| `navigatorGpuPresent` | `boolean` | `navigator.gpu` 存在性 |
| `adapterObtained` | `boolean` | `requestAdapter()` 是否返回适配器 |
| `deviceObtained` | `boolean` | `requestDevice()` 是否成功 |
| `adapterInfo` | `{vendor?, architecture?, device?, description?}` | 用于基准环境指纹；MUST NOT 进入公开 API 的类型签名（仅状态/日志） |
| `features` | `string[]` | 必需特性子集判定结果 |
| `limits` | `Record<string, number>` | 关键下限：`maxTextureDimension2D`、`maxVertexAttributes`、`maxSampledTexturesPerShaderStage`、`maxUniformBufferBindingSize` |
| `elapsedMs` | `number` | MUST ≤ 2000（→ FR-005；超时即判定不可用） |
| `reason` | `"ok" \| "no-navigator-gpu" \| "no-adapter" \| "device-request-failed" \| "missing-feature" \| "below-limit" \| "timeout"` | 原因类别（→ FR-009 可观察提示） |

### 2.3 `BackendSelection`（路径选择，初始化阶段一次性）

| 字段 | 类型 | 校验 |
|---|---|---|
| `preference` | `"auto" \| "webgpu" \| "webgl2"` | 来自配置（构建期常量或运行时参数）；**调用方代码 MUST NOT 依据它分支**（→ FR-007） |
| `probe` | `CapabilityProbeResult \| undefined` | `preference === "webgl2"` 时 MAY 为 `undefined`（不探测） |
| `selected` | `BackendKind` | `preference==="webgl2"` → `webgl2`；`preference==="webgpu"` 且探测失败 → `webgl2`（整体兜底）；`auto` → 探测成功取 `webgpu`，否则 `webgl2` |
| `decidedAt` | `number` (ms) | 初始化阶段时间戳；**一经选定，本会话内 MUST NOT 变更**（→ FR-006） |
| `switches` | `WholeSwitchRecord[]` | 仅含"设备丢失后整体切换"记录（正常路径为空） |

**状态机（路径生命周期）**：

```text
[未开始] --探测(≤2s)--> [已选择 webgpu] --device.lost--> [整体销毁] --重建--> [已选择 webgpu | webgl2]
      \--探测失败/不满足下限--> [已选择 webgl2]（本会话内不再尝试 WebGPU）
约束：任一时刻至多一条路径在绘制；不存在"两条路径叠加/遮挡/逐帧合成"的状态（→ 原则 II）
```

### 2.4 `WholeSwitchRecord`（整体切换记录）

| 字段 | 类型 | 说明 |
|---|---|---|
| `trigger` | `"probe-failed" \| "device-lost" \| "startup-error"` | 触发原因类别 |
| `from` / `to` | `BackendKind` | 切换前后 |
| `destroyedResources` | `number` | 被销毁的后端资源计数（MUST > 0；证明"不保留旧路径资源"，→ FR-006） |
| `rebuildMs` | `number` | 重建耗时 |
| `residualDraws` | `number` | 切换后旧路径的绘制提交数；MUST 为 `0` |

### 2.5 `RenderPathStatus`（可观察状态，→ FR-009）

| 字段 | 类型 | 说明 |
|---|---|---|
| `active` | `BackendKind` | 当前生效路径；**只在状态面出现，不参与业务分支** |
| `reason` | `CapabilityProbeResult["reason"]` | 回退/选择原因类别 |
| `degraded` | `boolean` | 是否处于降级运行（如 CI 软件适配器、切片 A 的临时能力关闭） |
| `notes` | `string[]` | 降级与盲区标注（如"lavapipe 软件适配器""`depthTexture` 临时关闭（切片 A）"） |

**校验规则**：`degraded === true` 时 `notes` MUST 非空（→ FR-023）。

---

## 3. 后端能力与限制（逻辑层门控的事实来源）

### 3.1 `BackendCapabilities`

| 字段 | 类型 | 取值来源 | 关联 FR |
|---|---|---|---|
| `webgl2` | `boolean` | 语义="现代渲染能力可用"（MVP：`true`） | — |
| `msaa` | `boolean` | WebGPU 4× 支持 | — |
| `depthTexture` | `boolean` | **切片 A：`false`（临时降级）；切片 B：`true`** | FR-030（帧缓冲） |
| `fragmentDepth` | `boolean` | `@builtin(frag_depth)` | — |
| `instancedArrays` / `drawBuffers` / `elementIndexUint` | `boolean` | 原生支持 | — |
| `stencilBuffer` / `stencilBits` | `boolean` / `number` | `depth24plus-stencil8` | — |
| `colorBufferFloat` / `colorBufferHalfFloat` / `floatingPointTexture` / `halfFloatingPointTexture` | `boolean` | 由适配器特性与格式能力计算 | — |
| `textureFilterAnisotropic` / `s3tc` / `pvctc`*(sic，上游拼写为 `pvrtc`)* / `astc` / `etc` / `etc1` / `bc7` / `supportsBasis` | `boolean` | MVP 一律 `false`（未实现的能力 MUST 诚实上报） | FR-030 |
| `sliceBComplete` | `boolean` | 切片 B 是否已完成（`depthTexture` 翻转的前置） | FR-030 |

**校验规则**：任何 `false` 能力 MUST 有对应的"未实现"分支与显式记录；**MUST NOT** 虚报为 `true`；
`depthTexture === false && sliceBComplete === true` 为**不一致状态**，CI MUST 判失败（防止长期停留在降级态）。

### 3.2 `ContextLimitsSnapshot`

由 `adapter.limits` 合成（映射表见 research §4），含 `maximumTextureSize`、`maximumCubeMapSize`、`maximum3DTextureSize`、
`maximumTextureImageUnits`、`maximumVertexTextureImageUnits`、`maximumCombinedTextureImageUnits`、`maximumRenderbufferSize`、
`maximumSamples`、`maximumVertexAttributes`、`maximumVaryingVectors`、`maximumVertexUniformVectors`、`maximumFragmentUniformVectors`、
`maximumAliasedLineWidth`、`minimumAliasedLineWidth`、`maximumAliasedPointSize`、`maximumTextureFilterAnisotropy`、
`maximumViewportWidth`、`maximumViewportHeight`。

**校验规则**：每个字段 MUST 在构造期同步可读（`Scene` 构造期逻辑层即读取；→ research §3）；
`maximumSamples` MUST ≥ 4；单元测试断言映射表与 adapter limits 的对应关系。

---

## 4. 通道、管线与绑定（命令执行映射）

### 4.1 `RenderPassKey`（通道身份，派生式）

| 字段 | 类型 | 来源 |
|---|---|---|
| `colorTargets` | `ColorTargetRef[]`（`{id, format, loadOp, resolveRef?}`） | `drawCommand._framebuffer ?? passState.framebuffer`（research §1.5） |
| `depthStencilTarget` | `DepthTargetRef \| undefined`（`{id, format, depthLoadOp, stencilLoadOp}`） | 帧缓冲附件描述 |
| `sampleCount` | `1 \| 4` | `scene.msaaSamples` 与目标能力 |
| `viewport` | `{x,y,width,height}` | `renderState.viewport ?? passState.viewport ?? drawingBuffer` |
| `scissorRect` | `{x,y,width,height} \| undefined` | `passState.scissorTest ?? renderState.scissorTest` |

**校验规则**：`RenderPassKey` 变化 → 结束当前 pass 并开启新 pass；`endFrame` MUST 关闭当前 pass（→ FR-030）。
不得要求逻辑层提供 pass 回调（上游无该 API，research §1.5）。

### 4.2 `PipelineCacheKey` 与 `PipelineRecord`

`PipelineCacheKey = (shaderProgramId, renderStateFingerprint, vertexLayoutFingerprint, topology, colorFormats[], depthFormat?, sampleCount)`；
`PipelineRecord = { key, pipeline: GPURenderPipeline, createdAt, hits, misses }`。

**校验规则**：`renderStateFingerprint` MUST 覆盖 `RenderState` 的全部字段（research §5.3 映射表）；
未支持的字段组合（如 `lineWidth !== 1`、`sampleCoverage.enabled === true`）MUST 抛出可诊断错误而非静默忽略。

### 4.3 `UniformBlockLayout` 与 `BindingPlan`

| 实体 | 字段 | 说明 |
|---|---|---|
| `UniformBlockLayout` | `uniformNames: string[]`, `fields: {name, kind, byteOffset, byteSize, arrayStride?}[]`, `blockSize`, `wgslStruct: string` | 由"着色器实际引用的 uniform 名集合"生成；与 WGSL 结构 MUST 逐字段一致（→ H-4/G-4） |
| `BindingPlan` | `groups: {groupIndex, entries: {binding, kind: "uniform" \| "texture" \| "sampler" \| "storage", name, slot}[]}[]`, `textureCount`, `samplerCount` | 纹理/采样器进独立 bind group（便于按纹理集合变化切换） |
| `UniformRingBuffer` | `buffer`, `frameCapacityBytes`, `writeOffset`, `dynamicOffsetsUsed: number[]` | 自动 uniform 块每帧写一次；手工 uniform 命令级写（动态偏移） |

**校验规则**：`UniformBlockLayout.blockSize` MUST ≤ `limits.maxUniformBufferBindingSize`；
`BindingPlan` 的 `entries` 数 MUST ≤ `maxBindingsPerBindGroup`；布局生成器的输出 MUST 由单元测试与 WGSL 源码交叉校验。

### 4.4 `CommandTraceEntry`（用于 G-3 的录制-回放断言）

`{ frameIndex, seq, kind: "clear" | "draw" | "compute" | "beginFrame" | "endFrame", targetId, viewport?, scissor?, topology?, indexCount?, instanceCount?, passKeyHash }`。

**校验规则**：录制（后端）与回放（测试）序列 MUST 与逻辑层 `clear`/`draw` 调用序列一一对应；
`passKeyHash` 的变化点 MUST 与 `RenderPassKey` 状态机的通道边界一致。

### 4.5 着色器编译前端（WGSL 发射路线，已由尖刺定案）

| 实体 | 字段 | 校验 / 说明 |
|---|---|---|
| `ShaderEmissionTarget` | `"glsl" \| "wgsl"` | `ShaderSource` 的发射目标；**默认仍为 `glsl`**，`wgsl` 仅供后端内部使用 |
| `ShaderLeafMapping` | `upstreamLeafHash: string`, `wgslFile: string`, `convertedBy: "path-a-draft+path-b-final"`, `verifiedOnRealGpu: boolean`, `notes?: string` | 上游叶子文本的内容哈希 → 转换后的 WGSL 文件（存于后端层目录，**不写入 `Source/Shaders/**`**）；`verifiedOnRealGpu` MUST 为 true 才可进入验收路径 |
| `WgslPreludeEntry` | `czmName: string`, `wgslName: string`（重载拆分为不同名字）, `kind: "constant" \| "function" \| "struct" \| "builtin"` | `czm_` 内建在 WGSL 侧的等价物；重载 MUST 拆名（WGSL 无重载），结构体常量 MUST 转为函数或字面量 |
| `VariantKey` | `shaderFamily: string`, `defines: Record<string, string \| number>`, `textureUnits: number`, `flags: number`（上游 39 位打包值） | 与上游缓存键语义一致（`[numberOfDayTextures][flags]`，`GlobeSurfaceShaderSet.js:243-267`） |
| `VaryingContract` | `variantKey`, `varyingSet: {name, wgslLocation, type}[]`, `vsOutputs`, `fsInputs` | **`vsOutputs` MUST 与 `fsInputs` 逐项匹配**（实测：不匹配时 `createRenderPipeline` 硬失败）；不匹配即判失败并出具差异报告 |
| `GeneratedFragmentMirror` | `generator: "computeDayColor" \| …`, `params: {textureUnits, flags}`, `wgslFile` | 镜像上游运行时生成的 GLSL 片段（如 `GlobeSurfaceShaderSet.js:419-472` 的 `computeDayColor()`，磁盘上不存在）；覆盖度以"可达参数组合"计数验收 |
| `ConditionalCompilationTrace` | `variantKey`, `blocksEvaluated: number`, `branchesTaken: number[]`, `warnings: string[]` | 上游把 `#define/#ifdef` 交给 GL 驱动求值，WebGPU 侧由本项目实现 → 该记录用于审计"求值结果与上游一致"（含 `#elif` 链与算术条件） |

---

## 5. GPU 资源（映射与登记）

### 5.1 `GpuResourceRecord`（登记表项）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 稳定标识 |
| `kind` | `"buffer" \| "texture" \| "sampler" \| "pipeline" \| "bindGroup" \| "shaderModule"` | — |
| `bytes` | `number` | `buffer`/`texture` 的估算字节数（图形显存代理指标，→ FR-017） |
| `upstreamClass` | `"Buffer" \| "Texture" \| "Sampler" \| …` | 对应上游类（便于按类统计） |
| `createdFrame` / `destroyedFrame` | `number \| undefined` | 生命周期（用于泄漏断言） |

**校验规则**：`destroy()` 后 MUST 从登记表移除；测试断言"帧 N 与帧 N+K 的活跃资源集合在稳态下不增长"（泄漏断言）。

### 5.2 资源类映射（类型层面的契约）

| 上游类（补丁层替换） | WebGPU 承载 | 保留的上游语义（必须一致） |
|---|---|---|
| `Buffer` | `GPUBuffer` | 三种工厂、`usage`、`copyFrom`、`sizeInBytes` |
| `Texture` | `GPUTexture` + `GPUTextureView` | `source` 类型集合、`flipY`、`preMultiplyAlpha`、`sampler`、`copyFrom` 重载 |
| `Sampler`（保留上游文件） | `GPUSamplerDescriptor` | wrap/filter 枚举语义 |
| `VertexArray` | `GPUVertexBufferLayout[]` + `GPUBuffer` | `attributes[]` 的 `index/componentDatatype/componentsPerAttribute/normalized/offsetInBytes/strideInBytes/instanced/divisor`、`indexBuffer`、`numberOfVertices` |
| `Framebuffer` | 附件描述集合（无对象） | 颜色附件数组、深度/模板附件、`hasDepthAttachment` |
| `Renderbuffer` | `GPUTexture`（depth/stencil 格式） | 格式枚举语义 |
| `MultisampleFramebuffer` | `sampleCount:4` 附件 + `resolveTarget` | `getRenderFramebuffer`/`getColorFramebuffer`/`blitFramebuffers` |
| `FramebufferManager`（小改） | 编排保留 | 颜色/深度纹理与多采样配对的生命周期 |
| `CubeMap` / `Texture3D` / `TextureAtlas`（切片 C） | `viewDimension:"cube"` / `dimension:"3d"` / 区域拷贝 | 骨架 + 显式失败 |

**校验规则**：`Context.id`（每上下文 GUID）MUST 保持唯一且稳定（逻辑层用它做索引缓冲缓存键，research §1.3）。

---

## 6. 地形与数据源

### 6.1 `TerrainDataset`（固定数据集）

| 字段 | 类型 | 校验 |
|---|---|---|
| `datasetId` | `string` | 目录名，MUST 在包的 `fixtures/` 中存在 |
| `manifest` | `DatasetManifest` | 见下 |
| `totalBytes` | `number` | MUST ≤ 20 MiB（仓库可承载） |
| `offline` | `true` | 固定数据集 MUST 可在离线环境完成验证（→ FR-004、FR-012） |

### 6.2 `DatasetManifest`

| 字段 | 类型 | 校验 |
|---|---|---|
| `tilingScheme` | `"geographic" \| "webMercator"` | MVP：`geographic`（level 0 = 2 块瓦片，已实测） |
| `levels` | `number[]` | 连续区间；MUST 覆盖至少 2 个层级且 z 最大层在覆盖区内 ≥ 2×2 瓦片（多瓦片拼接，→ FR-015） |
| `rectangle` | `{west, south, east, north}` | 覆盖区（度） |
| `tileSize` | `number` | 高程场边长（如 65/256） |
| `encoding` | `"uint16-height"` | 本地格式：`<level>/<x>/<y>.hgt` 为小端 Uint16 高程（米，含 `noDataValue`） |
| `noDataValue` | `number` | 无数据哨兵值 |
| `attribution` | `string` | **MUST 非空**（强制署名，→ FR-024） |
| `sources` | `{name, url, license}[]` | 逐来源许可与链接（可追溯） |
| `sha256` | `string` | 数据集内容哈希（CI 断言固定数据集未被意外改动） |

### 6.3 `TerrainSourceAdapter`（数据源适配，公开接缝）

| 字段/方法 | 说明 |
|---|---|
| `createProvider(dataset, mode)` | 返回**上游公开类** `CustomHeightmapTerrainProvider` 实例（MVP：`mode` 为 `"fixture"` 或 `"public"`；→ FR-004） |
| `callback(x, y, level)` | 读固定数据集或公开 Terrarium 源 → 构造 `HeightmapTerrainData`（公开类）|
| 几何与调度 | **不由本层实现**：由上游 `HeightmapTerrainData.createMesh` / `TerrainEncoding` / 四叉树调度完成（→ FR-031） |

**校验规则**：`createProvider` MUST NOT 使用任何需要凭据的服务；数据不可用 MUST 以"数据不可用"状态呈现（与"渲染失败"区分，→ FR-004）。

### 6.4 `Attribution`（署名）

`{ text: string, url?: string, shownInDemo: boolean, ciChecked: boolean }`。
**校验规则**：`text` MUST 非空且包含逐来源署名（CI 断言）；`shownInDemo` MUST 为 `true`（演示页展示）。

---

## 7. 验证证据

### 7.1 `VerificationRun`

| 字段 | 类型 | 校验 |
|---|---|---|
| `runId` | `string` | — |
| `backend` | `BackendKind` | **每次运行只有一个**（→ FR-011、原则 II） |
| `isolation` | `"separate-process" \| "separate-page-load"` | MUST NOT 为"同会话双路径" |
| `fixedConditions` | `{camera, sceneTime, rngSeed, viewport, devicePixelRatio, datasetId, baseLayer:false, skyBox:false, skyAtmosphere:false}` | 全字段必填（→ FR-012） |
| `frames` | `FrameCapture[]` | 每帧含像素数据引用与统计 |
| `stats` | `FrameStatistics` | `nonBackgroundRatio`、`uniqueColorCount`、`depthDiscontinuityRatio`、`triangleCount`、`drawCallCount`、`tileCount`、`frameTimeMs{p50,p95}` |
| `verdict` | `"pass" \| "fail"` | 断言结果 |
| `degraded` / `degradationNotes` | `boolean` / `string[]` | 降级运行标注（→ FR-023） |

### 7.2 `VisualEvidence`

`{ runId, backend, referenceFrameId, diffImagePath, mismatchRatio, tolerance: ToleranceRecord, regions: {label, statistic, observed, expectedRange}[] }`。

**校验规则**：MUST 产出差异图（→ FR-013）；`mismatchRatio` 与 `tolerance` 的比较 MUST 使用代码中固定的阈值（→ FR-014）。

### 7.3 `ToleranceRecord`

`{ metric, threshold, unit, rationale, source, recordedAt }`。**校验规则**：`rationale` 与 `source` MUST 非空（禁止"任意差异均通过"，→ FR-014）。

### 7.4 `CrossBackendEquivalence`

`{ metric, webgpuRange, webgl2Range, overlapRatio, declaredDifferences: string[] }`。
用于 FR-008 的**统计等价**（不做逐点像素比较；无法消除的差异 MUST 在 `declaredDifferences` 中显式声明）。

---

## 8. 基准记录

### 8.1 `EnvironmentFingerprint`

`{ os, cpu, gpu: {adapterVendor?, adapterArchitecture?, adapterType: "hardware" | "software"}, browser, browserVersion, playwrightVersion, backend, degraded: boolean, timestampMode: "none" | "timestamp-query" }`。
**校验规则**：`degraded === true` 时基准结论 MUST 标注为"相对回归意义"（→ FR-017/FR-023）。

### 8.2 `BenchmarkRecord`

`{ commit, fingerprint, backend, samples: {frameTimeMs{p50,p95}, gpuBytes, drawCalls}, warmupFrames, sampleFrames, verdict: {regressed: boolean, thresholds: ToleranceRecord[]} }`。
**校验规则**：两条路径的记录 MUST 来自**各自独立的会话**（→ 原则 IV）；结果作为 `history.jsonl` 存档（→ FR-020）。

---

## 9. MVP 评估结论（沿用并升级）

`MvpEstimate` 的结构由 [contracts/mvp-estimate.schema.json](./contracts/mvp-estimate.schema.json) 定义（schemaVersion 1，未改动）：

| 字段 | 本次取值要点 |
|---|---|
| `version` | `"2.1.0"`（结论版本；v1.0.0 对应被否决架构，v2.0.0 为着色器路径待定版，均已失效） |
| `milestone` | "地形渲染在新渲染后端下端到端跑通 + 兜底路径独立运行通过 + 逻辑层零改动由补丁范围审计证明" |
| `meteringBasis.includesHumanCost` | `false`，且 `statement` 显式声明"人工成本不计入"（→ FR-027） |
| `totals` | 时间 20.0–41.5 工作日；token ¥8.46–264.36；算力 ¥127.30–400.00（本机 GPU 可用时下界 0） |
| `planningValue` | ¥260–670（$38–99） |
| `unconfirmedItems` | 9 项，含 **变体规模（+1–3 工作日）**、**精度/纹理 Y 翻转（+1–2 工作日，场景 S-V）**、**全库着色器覆盖 2–4 人月（外推，不计入本增量）** |
| `exclusions` | 凭据类地形服务、全库着色器转换与后续增量、订阅套餐、本机折旧、**人工成本**（→ FR-029） |

---

## 10. 状态机汇总

```text
① 路径生命周期（§2.3）
   未开始 →[探测 ≤2s]→ 已选择(webgpu) →[device.lost]→ 整体销毁 →[重建]→ 已选择(webgpu|webgl2)
                       ↘ 探测失败/低于下限 → 已选择(webgl2)
   不变量：任一时刻至多一条路径绘制（原则 II）

② 切片状态（backend capability）
   切片A(depthTexture=false) →[切片B 完成]→ 切片B(depthTexture=true, sliceBComplete=true)
   不变量：sliceBComplete=true 时 depthTexture MUST 为 true；否则 CI 失败

③ 通道生命周期（每帧）
   beginFrame →[首个 clear/draw]→ pass#1 →[RenderPassKey 变化]→ pass#2 → … →[endFrame]→ 提交/呈现
   不变量：passKey 变化必须闭合当前 pass；帧末无未闭合 pass

④ 设备丢失恢复
   正常渲染 →[device.lost]→ 停止提交 → 销毁后端与上游场景 → 重新探测 → 整体重建 → 恢复渲染
   不变量：恢复后旧设备资源计数为 0，且无未捕获错误（FR-003）
```

## 11. 边界断言（架构测试用，→ SC-010 / FR-007 / 原则 II）

| 断言 | 对象 | 判定 |
|---|---|---|
| A1 | `src/api/**`、`src/index.ts`、`dist/index.d.ts` | MUST NOT 出现 `GPU[A-Z]`、`WebGL`、`navigator.gpu`、`backend-webgpu` 等后端符号 |
| A2 | `src/**` 的 import 图 | MUST NOT import `backend-webgpu/**` 的具体实现（只允许经抽象接口） |
| A3 | `backend-webgpu/manifest.json` | 全部 `upstreamModule` MUST 匹配 `^Renderer/[A-Za-z0-9_]+\.js$` |
| A4 | 别名插件 | 白名单穷举：被改写路径集合 == 清单集合（无遗漏、无额外） |
| A5 | 演示页源码 | MUST NOT 出现 `preference ===` / `=== "webgpu"` / `=== "webgl2"` 等路径分支（唯一例外：包内部的 `render-path/`） |
| A6 | 场景构造参数 | MUST 含 `baseLayer:false`、`skyBox:false`、`skyAtmosphere:false`（保证 MVP 零 `ComputeCommand`，research §1.6） |
| A7 | 测试运行 | 每次 `VerificationRun` 只允许一个 `backend`；同会话双路径的用例 MUST 被判失败 |
| A8 | 能力一致性 | `sliceBComplete === true ⇒ depthTexture === true`；任何 `false` 能力 MUST 有 `notes` 记录 |
| A9 | 着色器视图不变 | 逻辑层读取的 `shaderProgram.vertexShaderSource`/`fragmentShaderSource` MUST 仍为 GLSL（`Scene/Primitive.js:849,1011-1020` 的正则探测 MUST 仍能命中），`_attributeLocations` MUST 存在且与 `attributeLocations` 一致 |
| A10 | 变体一致性 | 每个可达 `VariantKey` 的 `VaryingContract` MUST 匹配；未覆盖的 `VariantKey` MUST 显式失败而非静默降级 |
| A11 | 叶子映射完整性 | 验收路径用到的每个上游着色器叶子 MUST 在 `shader-leaf-map.json` 中命中且 `verifiedOnRealGpu === true`；哈希漂移 MUST 使 CI 失败 |
