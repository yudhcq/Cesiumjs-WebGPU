# G-2 门禁结论：设备交接与同步构造（H-2）

**Feature**: `001-webgpu-terrain-mvp` ｜ **任务**: tasks.md **T016 / T017** ｜ **门禁**: plan.md「实现前的验证门」G-2
**判定产物**: `experiments/gates/out/g2.json`（机器可判定）｜ **规范**: [experiments/gates/README.md](../experiments/gates/README.md)
**重跑命令**:

```text
node experiments/gates/g2-handoff/run.mjs                       # 门禁本体（两次独立浏览器运行 + 构建 + 判定）
node experiments/gates/g2-handoff/run.mjs --control=no-handoff  # 阴性对照（预取设备但不安装交接槽）
node --test "tests/unit/capability-mapping.test.mjs"            # T017 能力映射一致性（无需 GPU）
node tools/scripts/check-gate.mjs --gate g2                     # 判定器校验
```

---

## 1. 结论

**verdict = `pass`（45/45 检查项通过）**，`recordedAt` 见 `g2.json`。plan 对 G-2 的三条判据全部成立：

| # | 判据（plan / T016） | 结论 | 证据（可复现） |
|---|---|---|---|
| a | 两种后端下都能构造场景 | ✅ | WebGPU 运行：`new Scene({canvas})` 成功，`scene.context` 是替换实现（`constructor="G2HandoffContext"`、`__g2GateStub=true`、`context.device === 预取的 device`、`context.adapter === 预取的 adapter`）；WebGL2 运行：**独立浏览器实例 + 独立页面**，空清单 bundle 下 `scene.context` 是上游原版 `Context`（`instanceof` 深路径导入 = true、`webgl2 = true`、绘制缓冲 300×150）。两次运行互不比较（原则 II）。 |
| b | `ContextLimits` 与能力标志在 `Scene` 构造期同步可读 | ✅ | `take()` 的**调用栈**为 `takeHandoff ← new G2HandoffContext ← new Scene`（`g2-webgpu.json → probes.takeStack`）：设备是在替换实现**构造函数内部**同步取出的，安装与构造之间没有 `await`。构造窗口内逻辑层读取到 `fragmentDepth`、`drawingBufferWidth/Height`、`depthTexture`（×10）、`uniformState`，**每个值都已等于最终发布值**；`ContextLimits` 的 23 个成员全部在构造窗口内被写入，逻辑层在构造期读到其中 7 次（`minimum/maximumAliasedLineWidth`、`maximumTextureSize`），读到的都是最终值。 |
| c | 记录被触发的逻辑层分支并与 research §4 表逐项一致 | ✅ | 26 个能力标志逐项与 research §4 采用值一致（`g2.json → measurements.webgpu.capabilities`）；分支断言：`fragmentDepth=true → scene.logarithmicDepthBuffer=true → camera near/far=0.1/1e10`（Scene.js:195 + :723-726）、`msaa=true → scene.msaaSupported=true`（Scene.js:1719-1721）、压缩纹理族 6 个全 `false`（Scene.js:1771-1781）、`ContextLimits.maximumTextureFilterAnisotropy=1`、`depthTexture=false`（切片 A）的后果见下。 |

**`depthTexture=false` 的后果被独立观测证实**：整段 `Scene` 构造期间
`HTMLCanvasElement.prototype.getContext` 的 `webgl2` 申请次数 = **0**（全部时间也是 0）。
替换实现以 **strict 模式**构造（不申请任何 GL 上下文），`View.js:46` 因 `depthTexture=false` 不创建 `GlobeDepth`，
于是构造期没有任何模块需要 GL —— 这正是 research §4 所声明的降级分支，且是**可观测的后果**而非转述。

**环境（写入 `g2.json.environment`）**：Node v22.20.0；Playwright `channel=chrome`，HeadlessChrome **153.0.8010.36**，启动参数 **0 个**；
`adapter.info = {vendor:"nvidia", architecture:"lovelace"}`（`isFallbackAdapter=null`），`requestDevice()` 调用 **1 次**；
实测设备 limits（节选）：`maxTextureDimension2D=16384`、`maxTextureDimension3D=2048`、`maxSampledTexturesPerShaderStage=48`、
`maxVertexAttributes=30`、`maxInterStageShaderVariables=28`、`maxColorAttachments=8`、`maxUniformBufferBindingSize=65536`；
features 含 `float32-filterable`、`float32-blendable`（因此 `colorBufferFloat`/`textureFloatLinear` 由**真实特性**推出为 true，
不是硬编码；无该特性时会退为 false 并登记降级分支 —— 见 `tests/unit/capability-mapping.test.mjs` 的两向断言）。

**上游磁盘零改动**：`node_modules/@cesium/engine` 1891 个文件（21 761 878 字节）在两次构建前后聚合哈希一致
（`sha256-35a5dbbb1c5f964c9ef122762fd2a3e97b9aebfdbff0c6c78aa136b1a1124033`）。逻辑层零覆盖（`logicLayerOverrides=0`，
两个 bundle 各有 3 / 0 条改写记录，替换面仅 `Renderer/Context.js`）。

## 2. 阴性对照（本结论可信的前提）

`run.mjs --control=no-handoff` 用**同一 bundle、同一页面**，但预取设备后**不安装**交接槽：

- 替换实现抛出 `category = "device-handoff/missing"` 的可诊断错误（**不静默**，也不在替换实现内部偷偷回退 GL）；
- 门禁的 8 个依赖交接的检查项（构造、同步性、构造期可读、能力表一致、false 分支登记、逻辑层分支、ContextLimits 写入、不渲染帧）
  **全部转为 `ok=false`** —— 对照判定 `detected 9/9`，写入 `experiments/gates/out/g2-control-no-handoff.json`（`verdict=pass`）。

即：判定器**能够区分「设备交接成功」与「交接槽为空」**，G-2 的正向结论不是空转。

## 3. 被替换实现实际被消费到了什么程度

上游逻辑层（真实 `Scene` 构造函数）在替换实现上产生的读取（`g2-webgpu.json → reads`）：

| 读取项 | 构造期内 | 总计 | 上游消费点 |
|---|---|---|---|
| `depthTexture` | 10 | 10 | `Scene/View.js:46`、GlobeTranslucency/ GroundPrimitive 等 |
| `drawingBufferWidth` / `drawingBufferHeight` | 9 / 9 | 9 / 9 | `Scene.js:715-720`（viewport） |
| `fragmentDepth` | 1 | 3 | `Scene.js:195` |
| `uniformState` | 1 | 1 | 上游 `Context` 构造期建立、逻辑层读取 |
| `msaa` | 0 | 3 | `Scene.js:1719-1721`（getter，非构造期） |
| `webgl2` | 0 | 1 | 构造后探测读取 |

`ContextLimits`（**未列入清单的上游模块** `Renderer/ContextLimits.js`）：23 个成员在构造窗口内被替换实现写入，
逻辑层在构造期读回 7 次；构造后用公开 getter 复读，值为 `maximumTextureSize=16384`、`maximumSamples=4`、
`maximumVertexAttributes=30`、`maximum3DTextureSize=2048`、`maximumDrawBuffers=8`、`maximumColorAttachments=8`、
`maximumTextureFilterAnisotropy=1`、`highpFloatSupported/highpIntSupported=true`。
WebGL2 运行的同名值由 GL 派生并与**独立查询**一致（`maximumSamples=8`、`maximumTextureFilterAnisotropy=16`、`maximumVertexAttributes=16`），
两套值不同，故两次运行不可能被混淆。

**未实现面**（W2/T042+ 才拥有）：`draw` / `clear` / `beginFrame` / `endFrame` / `defaultTexture` / `defaultCubeMap` /
`createViewportQuadCommand` / `createPickId` / `getObjectByPickColor` / `readPixels*` —— 6 个探针全部抛
`category = "not-implemented"` 的可诊断错误；**构造期未触达任何未实现分支**（`notImplementedAfterConstruction = []`）。
本门禁**不渲染任何一帧**，也不建立渲染管线。

## 4. T017：能力映射一致性（`层=单元`，无需 GPU）

`tests/unit/capability-mapping.test.mjs`（7/7 全绿）把 research §4 变成**可机器判定**的契约：

1. 每个能力标志与 `ContextLimits` 成员的「采用值来源」都必须声明，且 `adapter.limits.<X>` 中的 `<X>` MUST 是
   `@webgpu/types` 里 `GPUSupportedLimits` 的**真实成员**、`adapter.features.has("<f>")` 中的 `<f>` MUST 是真实的
   `GPUFeatureName`（两者均由测试**解析 d.ts** 得到，来源字符串无法编造）；
2. 标志集合 === research §4 的标志集合；`ContextLimits` 表 === **已装上游模块** `Renderer/ContextLimits.js` 的 23 个公开成员（同样由测试解析上游文件得到）；
3. `maximumSamples >= 4`（声明值与用合成 limits 组合出的值都断言）；
4. **不得虚报**：任何 `false` 能力 MUST 有非空 `notes` **与**已声明的未实现分支；`kind === "unimplemented"` 的能力 MUST 为 `false`；
   被答为 `true` 的能力，其来源文本不得含 "not implemented" 式表述；`depthTexture` 的 notes MUST 指明切片 A 与切片 B（T098a）翻转义务；
5. 用合成 `GPUSupportedLimits` 逐条验证派生公式（如 `maximumTextureSize ← maxTextureDimension2D`、
   `maximumVaryingVectors ← maxInterStageShaderVariables`、`maximumDrawBuffers ← maxColorAttachments`），
   并用「有/无 `float32-blendable`」两种特性集验证派生能力的两向行为；
6. 门禁产物存在时，把 `g2.json` 记录的实测值与上表逐项交叉校验（含"23 个 ContextLimits 成员均在构造期写入"）。

> 注：`experiments/gates/out/**` 按规范不入库（CI 作为产物存档），因此第 6 条在无产物时会**打印诊断**而不是静默跳过；
> 前 5 条不含 GPU/产物依赖，可在任何环境运行。

## 5. 实现发现与偏离（如实记录，未静默改需求）

### F-1｜CommonJS 互操作：已按授权以真实依赖接入并验证（含 `protobufjs Reader` 根因）
`@rollup/plugin-commonjs` **29.0.3**（精确锁版、**仅 devDependency**）已接入本门禁的真实构建链。根因：
上游 `Source/Scene/GoogleEarthEnterpriseImageryProvider.js:1` 是 `import * as protobuf from "protobufjs/dist/minimal/protobuf.js"`，
第 482 行用**命名空间成员访问** `protobuf.Reader.create(data)`；G-1 的门禁内包裹（`cjs-interop.mjs`）只导出 `default`，
Rollup 无法静态绑定该成员，于是把它降级为一次具名导入，在 `:482:26` 报 1 条 `MISSING_EXPORT`，运行期取到 `undefined` —— **不会自愈**。
接入真实插件后：两个 bundle 的 `MISSING_EXPORT` 均为 **0**，且页面运行期探测 `typeof protobuf.Reader.create === "function"` 为 **true**、
`keys=[default,build,Writer,BufferWriter,Reader,BufferReader,util,rpc,roots,configure]`（`g2-*.json → probes.protobufReaderProbe`）。
- **对本组门禁的影响**：无（GE 影像解析不在 MVP 路径上，且该成员访问只在函数体内，模块求值不受影响）。
- **对 W1 产品打包的影响与处置**：`dist` 内嵌经替换的上游源码后同样需要具名导出合成，MUST 继续使用该插件（或等价方案）；
  否则 `GoogleEarthEnterpriseImageryProvider` 一旦被触达即 `TypeError`。T004 的依赖集断言已更新（`tests/unit/deps-locked.test.mjs`：
  精确版本、**仅 devDependency**（并断言任何 workspace 包的 `dependencies/peerDependencies/optionalDependencies` 均不含它）、
  已安装包声明 `license === "MIT"`）。

### F-2｜research §4 的行号与已装 26.3.0 不一致
research §4 记 `Scene/Scene.js:3905` 消费 `context.webgl2`，但 26.3.0 中 `Scene.js` 全文**没有** `context.webgl2` 读取（3905 行是 shadowState 代码）；
`context.msaa` 实际只在 `Scene#msaaSupported` getter（`:1719-1721`）中读取，**不在构造函数内**。
本门禁因此以**实测读取日志**（`g2-webgpu.json → reads.duringConstruction`）作为「构造期消费面」的证据，而不是照抄行号；
`capability-map.mjs` 的 `consumers` 字段保留 research 原文并在该条目标注不可复现。

### F-3｜提示词中的「T072 许可证允许集合」在本 tasks.md 中不存在 —— 许可证任务是 T040
本 tasks.md 中 **T040** 是「许可证与署名（Apache-2.0）… `tools/scripts/check-license-notice.mjs`」，**T072** 是「varying 成对推导与契约」。
F-1 条件 3（MIT 纳入允许集合）已按 **T040** 登记（`tests/unit/deps-locked.test.mjs` 已断言该包的许可证声明为 MIT），
T040 实现时 MUST 把 MIT 写进允许集合；编号差异已上报入口 Agent。

### F-4｜切片 A 的 `depthTexture=false` 是本门禁唯一的能力降级，其后果被独立证实
（见 §1 末段）。切片 B（T098a）翻转为 `true` 后 MUST 重跑本门禁；该义务同时写进 `capability-map.mjs` 的 `notes` 并被 T017 断言。

### F-5｜替换实现以 strict 模式构造成功 ⇒ W2 的 `Context` 替换不必携带 WebGL 上下文
G-1 的桩以 WebGL2 承载上下文获取（其 D-3 偏离）；G-2 的桩**不申请任何 GL 上下文**仍完成整个上游 `Scene` 构造，
说明构造期没有走到需要 GL 的资源类。若 W2 在其它配置（切片 B 的 `depthTexture=true`、开启 globe depth）下需要资源类，
替换清单必须同时覆盖 `Texture`/`Framebuffer`/`Renderbuffer` 等（T031 的 11 项 `replace` 已含这些）。

### 实现偏离（与 tasks.md 描述的关系，均不改需求）

| ID | 偏离 | 处理 |
|---|---|---|
| D-1 | T016 要求「桩 Context 从槽中取设备」并断言两种后端都能构造场景；正式清单与 W2 的资源类替换属 Phase 3/4 | 门禁使用**同 schema** 的 `g2-handoff/manifest.gate.json`（唯一条目 `Renderer/Context.js`，未修改插件一行）；「WebGL2 后端」用**空清单**构建的第二个 bundle 承载（即上游原版 `Renderer/Context.js`） |
| D-2 | research §3 步骤 4 的「探测失败 → 用上游原版 WebGL2 Context」在**静态清单**下需要一个产品级决定（两次构建？内部委派？） | 门禁桩在槽为空时抛 `category="device-handoff/missing"`（阴性对照据此成立）；产品语义 MUST 由入口 Agent 在 W2（T042/T043）定案，本门禁不预设 |
| D-3 | research §4 的 `webgl2` 消费点行号不可复现（F-2）；research §4 记 `ContextLimits` 10 个成员，实测上游模块有 **23** 个公开成员 | 门禁以实测为准：`capability-map.mjs` 覆盖全部 23 个成员，行号漂移记入 F-2；**不修改** research/plan |
| D-4 | T017 要求「单元」测试，而门禁产物不入库 | 判据全部来自静态映射表 + 解析 `@webgpu/types` 与上游 `ContextLimits.js` 的真实成员名（无 GPU 可运行）；产物存在时追加实测交叉校验，缺失时打印诊断而非静默跳过 |

私有成员纪律：`packages/cesium-webgpu/{src,backend-webgpu}` 中 `_context` 出现 **0** 次（构建期断言，`.d.ts` 除外）；
本门禁的断言不读取上游 `@private` 成员（改用平台级观测：`getContext` 计数、`ContextLimits` 后备字段的观察式包装（值不变、结束即还原））。

## 6. 对后续任务的影响

1. **G-2 通过 ⇒ H-2 成立**：`ContextLimits` 与能力标志可在 `Scene` 构造期同步给出最终值，research §3 的「预取设备 + 同步交接」
   路线不需要异步化，**无需**触发 G-2 的失败动作（逐项修正能力表 / 标志降级）。Phase 4 的 T042–T045 可按 plan 推进。
2. **T042 可直接以 `device-handoff.mjs` 为契约蓝本**（install/take/peek/clear + 单次安装 + take 清空 + 审计日志），
   T045 可直接以 `capability-map.mjs` 的 `FLAG_TABLE`/`LIMIT_TABLE`/`composeCapabilities` 为实现蓝本。
3. **T044 的命令路径**：本门禁不覆盖（draw/clear 一律显式失败）；`depthTexture=false`（切片 A）意味着 W2 初期不需要离屏深度纹理，
   但切片 B（T098a）翻转后 MUST 重跑 G-2 与 G-3。
4. **W1/T009（F-1）**：`dist` 生成 MUST 引入 `@rollup/plugin-commonjs`（或等价具名导出合成），
   并把它纳入 T040 的许可证允许集合（MIT）。
5. 本门禁**不覆盖**：通道状态机（G-3）、uniform 布局（G-4）、着色器编译前端（G-5）、变体规模与像素一致性（G-6）、CI 两路径可运行性（G-7），
   以及任何渲染结果。
