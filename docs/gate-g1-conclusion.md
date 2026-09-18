# G-1 门禁结论：接缝可替换性（H-1）

**Feature**: `001-webgpu-terrain-mvp` ｜ **任务**: tasks.md **T015** ｜ **门禁**: plan.md「实现前的验证门」G-1
**判定产物**: `experiments/gates/out/g1.json`（机器可判定）｜ **规范**: [experiments/gates/README.md](../experiments/gates/README.md)
**重跑命令**:

```text
node experiments/gates/g1-alias/run.mjs                 # 门禁本体（构建 + 真机浏览器 + 判定）
node experiments/gates/g1-alias/run.mjs --control=no-rewrite   # 阴性对照（空清单）
node tools/scripts/check-gate.mjs --gate g1             # 判定器校验
```

---

## 1. 结论

**verdict = `pass`（25/25 检查项通过）**，`recordedAt` 见 `g1.json`。

plan 对 G-1 的通过判据是："别名插件能在真实构建链中替换 `Renderer/Context.js`，且 `Scene` 的相对导入被正确改写；
冒烟：构造 `Scene`，断言其 `_context` 由我们的实现提供；白名单穷举测试通过"。四条判据全部成立，且都有可复现证据：

| # | 判据 | 结论 | 证据（路径 / 值） |
|---|---|---|---|
| a | 构建链确实改写该模块 | ✅ | `out/g1-build.json` → `rewriteRecords`：`{source:"../Renderer/Context.js", importer:"node_modules/@cesium/engine/Source/Scene/Scene.js", resolved:"experiments/gates/g1-alias/Renderer/Context.js"}`；模块图中 **无** 上游 `Renderer/Context.js`；包文本中上游 `Context.js` 专有字面量 `this._originalGLContext = glContext;` **不存在**，而本项目标记 `G1-ALIAS-CONTEXT-STUB-v1` **存在**（同一探针在 `Scene.js` 片段上命中，作为阳性对照） |
| b | `Scene.js` 的相对导入被正确改写 | ✅ | 同上（`Scene/Scene.js:40`）；同一记录在 `resolutionRecords` 中由真实 Rollup 运行产生 |
| c | 白名单穷举通过 | ✅ | `whitelistExhaustiveCheck` → `missing=[] extra=[]`；改写集合 = 清单集合 = {`Renderer/Context.js`} |
| d | 替换后的 `Context` 被真实上游 `Scene` 消费 | ✅ | 浏览器内 `new Scene({canvas})`（**不注入 context**）：`scene._context.constructor.name === "G1AliasContext"`、`scene._context instanceof 深路径导入的 Context` = true、`contextIdentity`（深路径导入 === 门禁实现） = true、`__g1GateStub` = true；`scene.drawingBufferWidth/Height`（上游公开 getter）= 320/200 = 被替换实现的取值 = GL 绘制缓冲 320/200 |

**上游磁盘零改动**：`node_modules/@cesium/engine` 1891 个文件（21 761 878 字节）在门禁前后聚合哈希一致
（`sha256-35a5dbbb1c5f964c9ef122762fd2a3e97b9aebfdbff0c6c78aa136b1a1124033`，三次独立运行结果相同）。
别名插件只在构建期改写解析结果，从不写回 `node_modules`。

**逻辑层零改动**：`logicLayerOverrides = 0`；模块图内 1296 个上游模块中，46 个 `Renderer/**` 模块保持上游原文件
（含 `ContextLimits.js`、`RenderState.js`、`ShaderProgram.js`…），仅 `Renderer/Context.js` 来自本仓库；
仓库本地模块入图者仅 `entry.js` 与 `Renderer/Context.js`。

## 2. 阴性对照（本结论可信的前提）

一个"只会 pass"的门禁等于没有门禁。`run.mjs --control=no-rewrite` 用**同一套断言、同一个页面**、
但**空清单**（零改写）重跑，结果写入 `experiments/gates/out/g1-control-no-rewrite.json`：
5/5 应当失败的检查项确实失败 —— 构建改写两项、模块图一项、白名单穷举一项、
以及运行时的**来源判定**一项（对照运行中 `scene._context.constructor.name === "Context"`、
`instanceof 门禁实现` = false、`contextIdentity` = false、桩读取计数为空 `{}`）。
即：判定器**能够区分"真替换"与"没替换"**。

对照运行还暴露一个必须说清的边界：`logic-layer-capability-branch-followed-replacement`（`fragmentDepth → _logDepthBuffer →`
相机 near/far）在**对照运行里同样成立**，因为上游 `Context` 在本环境（WebGL2）下也给出 `fragmentDepth = true`。
因此该检查证明的是"**上游逻辑层的消费语义完好**"，**不是**"我们的实现被装上"；
区分替换与否的是**来源类**检查（模块身份 / 标记 / 构建改写记录）。两类检查都在 `g1.json` 的 `checks` 中逐条列出。

## 3. 被替换实现实际被消费到了什么程度

替换实现（`experiments/gates/g1-alias/Renderer/Context.js`，**门禁桩**）在浏览器中记录到上游逻辑层的读取：

| 读取项 | 次数 | 上游消费点 |
|---|---|---|
| `fragmentDepth` | 4 | `Scene/Scene.js:195`（→ `_logDepthBuffer`） |
| `drawingBufferWidth` / `drawingBufferHeight` | 9 / 9 | `Scene/Scene.js:715-720`、`Scene.prototype` getter |
| `depthTexture` | 10 | `Scene/View.js:46`、`GlobeTranslucencyState` 等 |
| `colorBufferFloat` / `floatBlend` / `drawBuffers` | 2 / 2 / 2 | 上游构造期能力查询 |
| `uniformState` | 1 | 由上游 `Context.js:335` 构造、逻辑层读取（research §1 表：57 处消费） |

能力值写入**未列入清单的上游模块** `Renderer/ContextLimits.js` 并与之比对：
`maximumTextureSize=16384`（gl 同值）、`maximumSamples=8`（gl 同值）、`maximumVertexAttributes=16`、`maximum3DTextureSize=2048`。
上游逻辑层分支按我们的能力值走：`_logDepthBuffer = true` → `camera.near/far = 0.1 / 1e10`（`Scene.js:723-726`）。

**未实现面**（W2/T042+ 才拥有）：`draw` / `clear` / `beginFrame` / `endFrame` / `readPixels*` /
`createViewportQuadCommand` / `createPickId` / `getObjectByPickColor` / `defaultTexture` / `defaultCubeMap` —— 一律抛
`category = "not-implemented"` 的可诊断错误（实测两项探针均如此，见 `g1-runtime.json` → `notImplementedProbes`），
**MUST NOT** 静默返回空值（与 Phase 3 的 T037 同一纪律）。
`scene.destroy()`（信息性记录）在本门禁中正常完成并把 `Scene._context` 置空。

## 4. 环境（写入 `g1.json.environment`）

| 项 | 值 |
|---|---|
| Node | v22.20.0（win32 x64） |
| 浏览器 | Playwright `channel=chrome`，HeadlessChrome **153.0.0.0**，启动参数 **0 个** |
| WebGL2 | 可用（替换实现据此取得真实绘制缓冲 320×200） |
| WebGPU | `adapter.info = {vendor:"nvidia", architecture:"lovelace", subgroupMinSize:32, subgroupMaxSize:32}`，`isFallbackAdapter=null`，`preferredFormat="bgra8unorm"`，`requestDevice()` 成功 |
| 上游 | `@cesium/engine` **26.3.0**（= cesium 1.145.0），`upstream/engine-26.3.0.lock.json` |

WebGPU 适配器信息**只作为环境记录**：本门禁不建立 WebGPU 设备交接、不渲染任何一帧，也**不涉及两条后端路径的比较**
（设备交接与能力映射是 G-2 / T016–T017 的主题；原则 II 的"二选一"在本门禁中不适用，因为不存在渲染路径）。

## 5. 实现发现与偏离（如实记录，未静默改需求）

### F-1｜上游依赖含 CommonJS-only 包，而批准的依赖集没有 CJS 互操作插件（**需 W1 处理**）
`@cesium/engine` 的 `Source/**` 直接 `import` 了 `mersenne-twister`、`urijs`、`grapheme-splitter`、`bitmap-sdf`、
`lerc`、`protobufjs`（browserify 产物）等 **CommonJS** 包。缺少 `@rollup/plugin-commonjs`（T004 的依赖集中没有）时，
Rollup 在绑定默认导入阶段直接失败：
`RollupError: "default" is not exported by "node_modules/mersenne-twister/src/mersenne-twister.js"`。
本门禁以 `experiments/gates/g1-alias/cjs-interop.mjs` 在**构建期**包裹这些模块（原始代码逐字执行、不写回磁盘、
真实运行），并把包裹清单写入证据。**产物化影响**：契约 §1 的"预打包 ESM 产物（`dist/` 内含经替换的上游引擎源码）"
在 W1/T009 落地时 MUST 具备等价能力（引入 CJS 插件或等价方案），否则 `dist` 无法生成。
附带限制：`protobufjs` 的具名导入（`Reader`）在本门禁包中为 `undefined`（Rollup 报 1 条 `MISSING_EXPORT`，
已单独记账），该符号只位于门禁未触及的代码路径（GE Earth 影像解析）；门禁运行期 0 未捕获异常、0 控制台错误。

### F-2｜上游 `index.js` 桶文件被 5 处自引用引入（**信息性**）
`Source/Scene/{DerivedCommand,PropertyTable,StructuralMetadata,VoxelContent}.js` 与 `LabelCollection.js` 以
`import { x } from "@cesium/engine"` 自引用桶文件，Rollup 必须解析 `index.js` 的全部再导出 ⇒ 门禁包覆盖
1296 个上游模块（约 7.6 MB）。对 G-1 而言这是**更强**的证据（几乎整仓上游图都参与断言），
但产品打包若需控制体积，MUST 在 W1 明确桶文件处理策略（T009/T033 范围）。

### 实现偏离（与 tasks.md 描述的关系，均不改需求）
| ID | 偏离 | 处理 |
|---|---|---|
| D-1 | T015 要求"用 T008 的别名插件在真实构建链中替换 `Renderer/Context.js`"，而正式清单 `packages/cesium-webgpu/backend-webgpu/manifest.json` 属 Phase 3（T031），门禁不得抢先落地 | 使用**同 schema** 的门禁清单 `experiments/gates/g1-alias/manifest.gate.json`（唯一条目 `Renderer/Context.js`，`kind:"replace"`，`glCallSites:46`），经插件选项 `manifestPath`/`localRoot` 指向；插件与解析逻辑与生产完全一致（未修改 `tools/rollup-plugin-engine-patch.mjs` 一行） |
| D-2 | 生产 `rollup.config.mjs` 另有 `@rollup/plugin-typescript`；门禁替换实现为 `.js` | 门禁只运行与"模块级替换"直接相关的插件次序（别名插件 → node-resolve → CJS 互操作）；TS 插件不参与 `.js` 替换文件解析，不影响接缝结论 |
| D-3 | T015 要求"桩实现"；本门禁的桩以 **WebGL2** 承载上下文获取（真实绘制缓冲/能力值），draw/clear/资源类未实现 | 桩覆盖上游 `Scene` 构造期读取面 + 上游 `Context` 构造期自建的三件套（`shaderCache`/`textureCache`/`uniformState`，均为**未列入清单的上游模块**，与 W2 做法一致）；其余一律显式失败。本门禁**不主张** WebGPU 后端可用（W2/T042+） |

另外：归档的"双画布分层"门禁产物（`experiments/gates/collect-g1.mjs` 等，commit `05e5bbc`）已移入
`experiments/gates/out/archive-dual-canvas/`，其旧 `g1.json` 一并归档，**MUST NOT** 与本门禁证据混用。

## 6. 对后续任务的影响

1. **G-1 通过 ⇒ H-1 成立，plan 的"模块级替换补丁层"路线（原则 I）在真实构建链与真实运行时得到验证**；
   **无需**触发 G-1 的失败动作（切换整仓 fork F1），Phase 3 的 T031–T041 可按 plan 原样推进。
2. **T031 可直接以本门禁的清单条目为模板**（`Renderer/Context.js`：`kind:"replace"`、`glCallSites:46`、
   `requirementRef:[FR-030,FR-032]`），并按 plan 补齐其余 15 个必替换项与约 7 个适配项。
3. **W1/T009 必须消化 F-1**：`dist` 若要内嵌上游源码，需要 CJS 互操作能力（引入 `@rollup/plugin-commonjs`
   或等价方案）。这属于对 T004 依赖集的**增量决策**，建议由入口 Agent 在 Phase 3 派发时显式授权。
4. **G-2（T016/T017）可安全采用同一手法**：门禁页面 + 真实构建链 + 来源标记断言 + 阴性对照。
   本门禁的 `run.mjs`（模式化产物布局）与 `cjs-interop.mjs` 可直接复用。
5. **私有成员纪律已被机器断言**：`packages/cesium-webgpu/{src,backend-webgpu}` 中 `_context` 出现 0 次
   （`.d.ts` 除外）；`scene._context` 仅出现在门禁断言（`probe.js`）中。
6. 本门禁**不覆盖**：WebGPU 设备交接与同步构造（G-2）、通道状态机（G-3）、uniform 布局（G-4）、
   着色器编译前端（G-5）、变体规模与像素一致性（G-6）、CI 两路径可运行性（G-7）、
   以及任何渲染结果（本门禁不渲染一帧）。
