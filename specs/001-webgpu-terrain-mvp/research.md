# Research: 以 WebGPU 替换 CesiumJS 渲染后端（受控 fork / 补丁层，上游基线 1.145.0）

**Feature**: `001-webgpu-terrain-mvp` | **Date**: 2026-09-19 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)
**Constitution**: [.specify/memory/constitution.md](../../.specify/memory/constitution.md) **v2.0.0**

本文件回答"怎么落地"。**架构方向已按用户 2026-09-19 的纠偏重做**：把上游渲染后端层（`Source/Renderer/**`）
重实现为 WebGPU，逻辑层一行不改。上一轮 `research.md` 中关于"双画布分层"的全部决策（D1 画布归属、
D2 渲染循环接管点、D3 地形自建几何、§2 候选方案 A/C/D 的取舍）**作废**；其中关于上游 API 事实、
地形数据源、CI 配方、指标口径的部分经复核后沿用（§0.3）。

全文严格区分：

- **已核实**：本轮解包 `@cesium/engine@26.3.0`（`cesium@1.145.0` 的依赖）逐文件读取源码得到，附 `文件:行`。
- **待验证假设（H-n）**：尚未被证据支持，集中在 §12，均给出验证方法与失败时的退路。

---

## 0. 方法与证据标准

### 0.1 本轮核实方式（可复现）

```powershell
# 仓库外临时目录，只读分析，不污染仓库（E:\cesium-plan-src）
npm pack @cesium/engine@26.3.0      # → 7,021,716 B；解包后 package/Source/**（含 Renderer/ 47 个 .js、Shaders/ 319 .glsl + 320 .js）
```

- `package/index.js:1` → `globalThis.CESIUM_VERSION = "1.145.0"`；`package/package.json` → `name:"@cesium/engine"`, `version:"26.3.0"`,
  `main/module:"index.js"`, `types:"index.d.ts"`, **无 `exports` 映射**（深路径 `@cesium/engine/Source/...` 可解析），
  `files` 白名单包含 `Source` 与 `Build/**`（实测 `Build/` 仅含 `ThirdParty/`、`Workers/`）。
- `Source/**` 下仅 **2 个 `.d.ts`**（即**没有**逐模块类型声明）；`Source/Renderer/**` 无 `.d.ts` → 深路径消费需要
  自备模块声明（见 §2.5）。
- 本轮新增两类自动化取证脚本（产物在仓库外，结论已固化到本文件）：
  1. **WebGL 触碰面普查**：扫描 `Source/**/*.js` 中形如 `gl.*(` / `context._gl.*(` 的真实调用（排除注释行），输出"含 GL 调用的文件表"与"GL API 频次表"。
  2. **后端消费面统计**：统计 `Source/Renderer/**` 之外对 `context.<member>` / `frameState.context.<member>` 的引用（方法调用与属性读取）与对 Renderer 类型的直接构造/静态工厂调用。

### 0.2 上游可见性判据（按 constitution v2.0.0 更新）

- v1.0.0 的"禁止依赖 `@private`"已随原则 I 修订而失效。v2.0.0 的要求是：
  **公开 API 与官方扩展点仍是首选接缝；只有在公开接缝确实不存在时才允许进入 fork 层，且每次进入 MUST 说明"为何公开接缝不可用"**。
- 因此本文件的判据变为：*先证明公开接缝不存在*（§1.7），再证明补丁**严格落在渲染后端层内**（§1.1），并给出边界审计方式（§2.4）。
- `@private` 标注仍被使用，但用途变了：它现在用来回答"**重设计该成员会不会改变逻辑层可观察行为**"
  —— 有外部消费者的成员必须保持语义（§1.3），只有 Renderer 内部消费者的成员可自由重设计（§1.3 表末）。

### 0.3 上一轮产物中经复核仍然有效的事实（继续引用）

| 事实 | 状态 |
|---|---|
| `cesium@1.145.0` 依赖 `@cesium/engine@^26.3.0`；`engines.node >= 22` | 已核实（本轮再次解包确认） |
| 免登录公开地形源：AWS Open Data Terrain Tiles（`elevation-tiles-prod`，terrarium PNG，CORS `*`，z0–15，无需 AWS 账号）及逐来源强制署名 | 2026-09-18 实测（原 research §6.1/§6.2/§6.4），本轮未复测，按"已核实（此前实测）"引用 |
| 无 GPU 的 CI 上跑 WebGPU：Xvfb（headed）+ Mesa lavapipe；WebGL2：ANGLE + SwiftShader；headless 下 WebGPU 画布呈现不可靠 | 已核实（Chromium 源码与同类项目生产 CI 配方） |
| 跨路径逐点像素比较不可靠（不同光栅化器/着色器编译器/MSAA 解析/sRGB 路径）→ 路径内像素回归 + 跨路径统计等价 | 已核实（同类项目实践） |
| 指标口径：帧时间 p50/p95、图形显存（代理指标）、绘制批次数；两路径各自独立会话采集 | 沿用（constitution 原则 IV 未变） |
| 无头 Chrome 153 零开关即可取得硬件 WebGPU 适配器（`vendor:"nvidia"`,`architecture:"lovelace"`） | 已实测（`experiments/README.md`） |
| 一个 canvas 只能有一种上下文类型；`GeographicTilingScheme` level 0 为 2 块瓦片；`TerrainProvider` 不可直接实例化 | 已实测/已核实（`experiments/README.md`） |

**已失效、MUST NOT 再用**：双画布分层、把上游那次地形绘制"藏起来"、自建瓦片几何与裙边、
跨两条管线合成对比的任何结论（见 spec Clarifications Q3/Q4 与 constitution v2.0.0 原则 II）。

---

## 1. 渲染接缝在哪里（问题 1）

### 1.1 已核实：全部 WebGL 触碰面位于 `Source/Renderer/**`

普查结果（真实调用点，已排除注释行）：

| 项 | 数值 |
|---|---|
| `Source/Renderer/**` 文件数 / 行数 | **47 个 / 19,691 行** |
| 其中**直接调用 WebGL** 的文件 | **16 个** |
| 直接 WebGL 调用点总数 | **348** |
| `Source/Renderer/**` **之外**的 WebGL 触达 | **仅 2 处命中，且均非真实渲染调用**：`Core/destroyObject.js:28`（JSDoc 示例文本 `_gl.deleteTexture(...)`）、`Shaders/Model/PointCloudStylingStageVS.js:3`（GLSL 预处理文本 `#ifdef GL_...`） |

高频 GL 调用（决定重实现工作量）：`pixelStorei` 56、`bindTexture` 38、`activeTexture` 20、`getParameter` 19、
`texParameteri` 16、`bindBuffer` 15、`bindFramebuffer` 8、`texImage2D` 8、`useProgram` 4、`texSubImage2D` 4、
`copyTexSubImage2D/copyTexImage2D` 5、`framebufferTexture2D/framebufferRenderbuffer/blitFramebuffer` 3、
`drawElements/drawArrays/drawElementsInstanced/drawArraysInstanced` 4、`readPixels` 2、`fenceSync` 1。

**结论**：渲染后端层的边界在**文件系统层面是可判定的**——补丁必须且只能落在 `Source/Renderer/**`；
这使 SC-010（逻辑层代码与语义改动为零）从"评审承诺"变成**可机器审计的不变量**（§2.4）。

### 1.2 已核实：`Context` 不是资源工厂（决定补丁集不能只改 `Context.js`）

`Context.js`（1732 行）只有 **12 个原型方法**（`Context.js:1249,1405,1427,1431,1475,1538,1587,1625,1659,1686,1704,1708`）
与 43 个 `Object.defineProperties` 访问器（`Context.js:578-1163`）；**不存在** `createBuffer/createTexture/createVertexArray/createFramebuffer/createShaderProgram`。
工厂位于资源类自身：

| 工厂 | 定义处 |
|---|---|
| `Buffer.createPixelBuffer` / `createVertexBuffer` / `createIndexBuffer` | `Renderer/Buffer.js:75` / `:135` / `:194` |
| `VertexArray.fromGeometry` | `Renderer/VertexArray.js:575` |
| `ShaderProgram.fromCache` | `Renderer/ShaderProgram.js:65` |
| `RenderState.fromCache` | `Renderer/RenderState.js:461` |
| `Texture.create` / `fromFramebuffer` | `Renderer/Texture.js:582` / `:619` |
| `Sync.create` | `Renderer/Sync.js:39` |

→ **补丁集必须覆盖资源类**；`Context.js` 本体主要是"状态 + clear/draw 分派 + 能力查询"。

### 1.3 已核实：逻辑层实际消费的后端表面（必须保持语义的部分）

统计方法：`Source/Renderer/**` 之外（1,306 个文件）对 `context.<member>` / `frameState.context.<member>` 的引用，
剔除同名的非 Cesium `Context`（canvas 2D、`BufferPointRenderContext` 等）。下表为**直接引用数下界**：

| 成员 | 形态 | 外部引用 | 例（`file:line`） | 定义处 |
|---|---|---|---|---|
| `uniformState` | getter | 57 | `Scene/GlobeSurfaceTileProvider.js:1951`、`Scene/GlobeDepth.js:301`、`Scene/Scene.js:877` | `Context.js:604` |
| `defaultTexture` | 惰性 getter | 43 | `Scene/GlobeSurfaceTileProvider.js:2049`、`Scene/BatchTexture.js:503` | `Context.js:1018` |
| `shaderCache` | getter | 32 | `Scene/Scene.js:4427`、`Scene/ClassificationPrimitive.js:549` | `Context.js:594` |
| `drawingBufferHeight` / `drawingBufferWidth` | getter | 29 / 23 | `Scene/Scene.js:4567-4568`、`Scene/QuadtreePrimitive.js:1285-1286` | `Context.js:1133` / `:1145` |
| `depthTexture` | getter | 27 | `Scene/View.js:46`、`Scene/GlobeTranslucencyState.js:222` | `Context.js:721` |
| `createViewportQuadCommand` | 方法 | 26 | `Scene/GlobeDepth.js:178,196,212,229,247` | `Context.js:1625` |
| `cache` | 普通对象 | 22 | `Scene/GlobeSurfaceTile.js:1063,1093`、`Scene/BillboardCollection.js:712` | `Context.js:386` |
| `webgl2` | getter | 17（**本轮复核为 18 / 15 个文件，口径差异见 §4 末 C-5**） | `Core/FeatureDetection.js:392`、`Core/PixelFormat.js:518` | `Context.js:584` |
| `createPickId` | 方法 | 11 | `Scene/BatchTexture.js:466`、`Scene/Billboard.js:1106` | `Context.js:1686` |
| `halfFloatingPointTexture` | getter | 9 | `Scene/GlobeDepth.js:281`、`Scene/AutoExposure.js:133` | `Context.js:747` |
| `stencilBuffer` | getter | 8 | `Scene/Scene.js:2870,3064,3075` | `Context.js:628` |
| `fragmentDepth` | getter | 7 | `Scene/Scene.js:195`、`Scene/EllipsoidPrimitive.js:282` | `Context.js:927` |
| `colorBufferFloat` | getter | 7 | `Scene/OIT.js:31`、`Scene/Scene.js:1661` | `Context.js:954` |
| `endFrame` | 方法 | 6 | `Scene/Scene.js:4597`、`Scene/Picking.js:352` | `Context.js:1431` |
| `readPixels` / `readPixelsToPBO` | 方法 | 5 / 1 | `Scene/PickFramebuffer.js:203,153` | `Context.js:1538` / `:1475` |
| `id` | getter（GUID） | 5 | `Scene/GlobeSurfaceTile.js:495,507`（每 context 的索引缓冲缓存） | `Context.js:579` |
| `floatingPointTexture` | getter | 5 | `Scene/BatchTable.js:90` | `Context.js:734` |
| `colorBufferHalfFloat` | getter | 3 | `Scene/Scene.js:1661,1679` | `Context.js:968` |
| `instancedArrays` | getter | 3 | `Scene/CloudCollection.js:955` | `Context.js:940` |
| `textureCache` | getter | 3 | `Scene/Scene.js:4428` | `Context.js:599` |
| `drawBuffers` | getter | 2 | `Scene/OIT.js:32` | `Context.js:987` |
| `elementIndexUint` | getter | 2 | `Scene/Primitive.js:1263` | `Context.js:708` |
| `getObjectByPickColor` | 方法 | 2 | `Scene/PickFramebuffer.js:78` | `Context.js:1659` |
| `destroy` / `beginFrame` / `msaa` / `floatBlend` / `supportsTextureLod` / `supportsBasis` / `defaultCubeMap` / `s3tc,pvrtc,astc,etc,etc1,bc7` | 各 1 | 1 | `Scene/Scene.js:5545` / `:4576` / `:1721` / `Scene/OIT.js:31` / `Scene/SpecularEnvironmentCubeMap.js:100` / `GltfLoader.js:586` / `Material.js:1089` / `Scene/Scene.js:1771-1781` | `Context.js:1708/1427/652/680/789/891/1100/815-880` |

**渲染器内部专用（外部零引用 → 可自由重设计）**：`stencilBits`(`:616`)、`textureFloatLinear`(`:760`)、
`textureHalfFloatLinear`(`:773`)、`blendMinmax`(`:694`)、`standardDerivatives`(`:667`)、`vertexArrayObject`(`:912`)、
`debugShaders`(`:993`)、`throwOnWebGLError`(`:999`)、`defaultEmissiveTexture`(`:1048`)、`defaultNormalTexture`(`:1074`)、
`defaultFramebuffer`(`:1158`)、`options`(`:370`)、`validateFramebuffer`(`:75`)、`validateShaderProgram`(`:76`)、
`logShaderCompilation`(`:77`) 以及构造期绑定的 GL 薄封装（`glCreateVertexArray` 等，`Context.js:310-318`）。

**非 `context` 的后端消费面**（同样必须保持）：逻辑层直接 `import` 并构造/静态调用 Renderer 类型
——`RenderState`（95 处构造/静态调用，43 个外部文件）、`ShaderSource`（79）、`Buffer`（97）、`PixelDatatype`（89）、
`Texture`（51）、`Sampler`（47）、`DrawCommand`（37）、`FramebufferManager`（29）、`ClearCommand`（22）、
`ShaderProgram`（22，其中 `fromCache` 22）、`VertexArray`（16）、`PassState`（7）、`CubeMap`（6）、`ComputeCommand`（6）、
`Framebuffer`（6）、`Renderbuffer`（3）、`VertexArrayFacade`（3）、`TextureAtlas`（3）、`ContextLimits`（19 个文件 / 10 个成员，主要为 `maximumTextureSize` 16、`maximumCubeMapSize` 5、`maximumVertexTextureImageUnits` 5）。
**（实测更正，依据 G-2 门禁 D-3）**：上游模块 `Renderer/ContextLimits.js` 的公开成员实为 **23 个**（后备字段 `:7-29` 23 个 / `Object.defineProperties` 访问器 `:32-330` 23 个）；**逻辑层实际消费 9 个成员**（`maximumTextureSize` 16、`maximumVertexTextureImageUnits` 5、`maximumCubeMapSize` 5、`maximumAliasedLineWidth` 2，以及 `maximumTextureImageUnits` / `maximumTextureFilterAnisotropy`（`Scene/ImageryLayer.js:1302`）/ `maximumAliasedPointSize`（`Scene/PointPrimitiveCollection.js:850`）/ `minimumAliasedLineWidth` / `maximumSamples` 各 1）。原文的"10 个成员"来源已定位：对逻辑层做 `ContextLimits\.(\w+)` 扫描会把模块路径片段 `ContextLimits.js` 的 `js` 计为成员名（同一扫描排除该片段即得 9）。完整计数与并集见 §4 末「§4 事实更正记录」C-2。

### 1.4 已核实：逐帧调用链（渲染后端在哪里被执行）

| # | 跳 | `file:line` |
|---|---|---|
| 1 | `CesiumWidget` 渲染循环 → `scene.render(time)` | `Widget/CesiumWidget.js:1079` |
| 2 | `Scene.prototype.render`（公开）→ 模块函数 `render(scene)` | `Scene/Scene.js:4621` → `:4696`；函数体 `:4519` |
| 3 | `context.beginFrame()` | `Scene/Scene.js:4576`（基类实现为 **no-op**：`Renderer/Context.js:1427-1429`） |
| 4 | `scene.updateAndExecuteCommands(passState, backgroundColor)` | `Scene/Scene.js:4583` → `:3366` |
| 5 | `updateAndClearFramebuffers` → `clear.execute(context, passState)` | `Scene/Scene.js:3955` → `:3989` |
| 6 | `executeCommandsInViewport` → `view.createPotentiallyVisibleSet` → `executeComputeCommands` → `executeCommands` | `Scene/Scene.js:3640` → `:3650/:3653/:3659` |
| 7 | `executeCommands` → `performPass(Pass.GLOBE)` | `Scene/Scene.js:2777` → `:2884` |
| 8 | `executeCommand` → `command.execute(context, passState)` | `Scene/Scene.js:2274` → `:2366` |
| 9 | `DrawCommand.prototype.execute` → `context.draw(this, passState)` | `Renderer/DrawCommand.js:669-671` |
| 10 | `ClearCommand.prototype.execute` → `context.clear(this, passState)` | `Renderer/ClearCommand.js:99-101` |
| 11 | `Context.prototype.draw`：解析 framebuffer/renderState/program/uniformMap | `Renderer/Context.js:1405-1425`（`:1418-1421`） |
| 12 | `beginDraw` → `bindFramebuffer:1311`、`applyRenderState:1312`、`shaderProgram._bind():1313` | `Renderer/Context.js:1294-1319` |
| 13 | `ShaderProgram._bind` → `gl.useProgram` | `Renderer/ShaderProgram.js:541-544`（GL `:543`） |
| 14 | `continueDraw` → `_setUniforms:1351`、`va._bind():1357` | `Renderer/Context.js:1321-1403` |
| 15 | `ShaderProgram._setUniforms` → 逐 uniform `uniform.set()` | `Renderer/ShaderProgram.js:546-604`；GL 在 `Renderer/createUniform.js:86…517`（纹理绑定 `:256,259`） |
| 16 | `VertexArray._bind` → VAO 绑定 + 属性指针 | `Renderer/VertexArray.js:884-896` → `bind` `:166-180`（`gl.vertexAttribPointer:113`、`gl.enableVertexAttribArray:121`） |
| 17 | **真正的绘制** | `gl.drawElements` `Renderer/Context.js:1368`；`glDrawElementsInstanced` `:1375`；`gl.drawArrays` `:1391`；`glDrawArraysInstanced` `:1393` |
| 18 | `va._unBind()` → `context.endFrame()`（解绑程序/帧缓冲/纹理单元） | `Renderer/Context.js:1402` → `Scene/Scene.js:4597` → `Renderer/Context.js:1431-1451` |

### 1.5 已核实：通道（pass）边界必须由后端**派生**，不能依赖上游的 pass 回调

- `Source/**` 中 **`beginPass`/`endPass` 命中数为 0**；`applyRenderState`（`Context.js:1204`）与 `beginDraw`（`Context.js:1294`）
  都是**模块内私有函数**，不存在 `endDraw`（解绑由 `continueDraw` 末尾的 `va._unBind()` `:1402` 完成）。
- 每条命令实际重绑定的状态（`Context.draw` 内）：framebuffer（`:1418` → `bindFramebuffer:1225`，**值不变时提前返回** `:1226`）、
  renderState（`:1419` → `RenderState.partialApply` `RenderState.js:829`，带逐转换缓存 `:844-848`）、
  viewport（`RenderState.js:710-720`，`renderState.viewport ?? passState.viewport`，回退 `passState.context.drawingBufferWidth/Height`）、
  scissor（`RenderState.js:583-597`，`passState.scissorTest` 覆盖命令级 `:859-861`）、程序（每命令无条件 `useProgram` `:543`）、
  uniform 值（含自动 uniform 重读 `ShaderProgram.js:570-575`）、顶点数组与索引缓冲（`Context.js:1357-1366`）、实例数（`:1326`）。
- `PassState` 只有 4 个字段：`context`(`PassState.js:14`)、`framebuffer`(`:24`)、`blendingEnabled`(`:36`)、
  `scissorTest`(`:48`)、`viewport`(`:55`)；每视图创建一次（`Scene/View.js:55-56`），每帧重置（`Scene/Scene.js:4570-4574`）。
- `Pass` 只是 CPU 侧排序枚举与一个 uniform（`Renderer/Pass.js:9-33`；`uniformState.updatePass` `UniformState.js:1472`），
  **改变 `Pass` 不构成通道边界**。

**结论（决定 WebGPU 后端结构）**：WebGPU 的 render pass 必须由后端在命令流上**懒开启**：
以 `(framebuffer, viewport, scissor, drawBuffers)` 作为"通道身份"，身份变化或 `endFrame` 时结束当前 pass；
`clear` 落在当前 pass 的 `loadOp`/`clearBuffer` 上。**不得**要求逻辑层提供 pass 回调（那将改动逻辑层）。

### 1.6 已核实：地形绘制的最小集合（MVP 切片的事实依据）

**命令**（全部地形表面命令由 `addDrawCommandsForTile` `Scene/GlobeSurfaceTileProvider.js:2504` 创建）：

| 命令 | 创建处 | Pass | 关键字段 |
|---|---|---|---|
| `new DrawCommand()`（每瓦片每 pass 一个，池化） | `GlobeSurfaceTileProvider.js:2798` | `command.pass = Pass.GLOBE`（`:3286`） | `shaderProgram` `:3271`、`renderState` `:3280`、`primitiveType = TRIANGLES` `:3281`、`vertexArray` `:3282-3283`、`count` `:3284`、`uniformMap` `:3285` |
| 线框变体 | `:3288-3295` | `Pass.GLOBE` | `primitiveType = LINES` `:3292` |
| 填充网格（`TerrainFillMesh`） | `GlobeSurfaceTile.js:513-517` | — | 复用同一命令槽 |

**RenderState**（`GlobeSurfaceTileProvider.js:502-531`）：`_renderState`（`cull.enabled=true`, `depthTest{enabled,func:LESS}`）、
`_blendRenderState`（+`func:LESS_OR_EQUAL`,`blending:ALPHA_BLEND`）、`_disableCulling*`（两份 cull 关闭的克隆）；
选择逻辑 `:2760-2768`。

**着色器**：`GlobeSurfaceShaderSet.getShaderProgram`（`Scene/GlobeSurfaceShaderSet.js:106`，调用点 `GlobeSurfaceTileProvider.js:3271`）
按 `numberOfDayTextures` + 标志位取缓存（`:243-267`），未命中时用 `baseVertexShaderSource/baseFragmentShaderSource`（`:268-269`，压入处 `:474-475`）
组装 `ShaderSource`，并调用
`ShaderProgram.fromCache({context, vertexShaderSource, fragmentShaderSource, attributeLocations: terrainEncoding.getAttributeLocations()})`（`:477-482`）。
基础源在 `Scene/Globe.js:666-688` 组装：片元 = `[AtmosphereCommon, GroundAtmosphere, (material?), GlobeFS]`，
顶点 = `new ShaderSource({sources: [AtmosphereCommon, GroundAtmosphere, GlobeVS], defines})`。
GLSL 文本来自**上游 `.js` 模块**（`Scene/Globe.js:19-22` import `../Shaders/GlobeFS.js` 等）——
`Source/Shaders/**` 同时存在 `.glsl`（319 个，构建输入）与 `.js`（320 个，运行时字符串模块），
**`Source/**` 中没有任何 `.js` import `.glsl`**（命中数 0）→ 补丁层无需触碰任何着色器文件。

**顶点布局**（`Core/TerrainEncoding.js:666-726`）：全部属性 **FLOAT、非归一化**，共用同一交错顶点缓冲：

| 量化模式 | 属性（location） | componentsPerAttribute | offsetInBytes |
|---|---|---|---|
| `NONE` | `position3DAndHeight`(0) | 4 | 0 |
| | `textureCoordAndEncodedNormals`(1) | 2 + (hasWebMercatorT?1:0) + (hasVertexNormals?1:0) | 16 |
| | `geodeticSurfaceNormal`(2)（若 `hasGeodeticSurfaceNormals`） | 3 | 16 + comps₁·4 |
| `BITS12` | `compressed0`(0) | 4（若 hasWebMercatorT‖hasVertexNormals）否则 3 | 0 |
| | `compressed1`(1)（两者皆有） | 1 | comps₀·4 |
| | `geodeticSurfaceNormal`(2)（若有） | 3 | 依次 |

location 表：`Core/TerrainEncoding.js:649-653`（NONE）/ `:654-658`（BITS12），由 `getAttributeLocations()`（`:733-738`）返回并交给 `ShaderProgram.fromCache`。
构造：`Buffer.createVertexBuffer({context, typedArray: mesh.vertices, usage: STATIC_DRAW})`（`Scene/GlobeSurfaceTile.js:486-491`）、
`mesh.encoding.getAttributes(buffer)`（`:492`）、
`Buffer.createIndexBuffer({..., indexDatatype: IndexDatatype.fromSizeInBytes(indices.BYTES_PER_ELEMENT)})`（`:498-504`）、
索引缓冲按 `context.id` 共享缓存（`:494-511`）、
`new VertexArray({context, attributes, indexBuffer})`（`:513-517`，无 `usage`/`interleave`）。
索引类型不固定（`Uint16Array` 或 `Uint32Array`：`Core/TerrainProvider.js:123,127,215`）。

**不需要的组件（已核实）**：`VertexArrayFacade`（仅 `BillboardCollection.js:857`、`CloudCollection.js:597`、`PointPrimitiveCollection.js:454`）、
`TextureAtlas`（仅 billboards/labels）、`Texture3D`（仅 `Megatexture.js`）、`CubeMap`（天空盒/材质/阴影/环境贴图）、
**`ComputeCommand`**：`scene._computeCommandList` 只由 `Pass.COMPUTE` 命令填充（`Scene/View.js:337-338`），
地形永远是 `Pass.GLOBE`；`skyBox:false` 会同时移除 skyBox/Sun/Moon（`Widget/CesiumWidget.js:348-359`，文档 `:151`），
`skyAtmosphere:false` 同样被尊重（`:362-369`）→ **MVP 场景零 `ComputeCommand`**（`ComputeEngine` 仍会在 `Scene.js:182` 被构造，
但它只在真正执行 compute 命令时才分配 GPU 对象）。

> **重要补充（已核实，影响 MVP 场景配置）**：影像重投影会**瞬时**产生真实 `ComputeCommand`
> （`Scene/ImageryLayer.js:1388,1428`，经 `GlobeSurfaceTileProvider.js:402` ← `QuadtreePrimitive.js:342` ← `Globe.js:1079`），
> 而默认 `CesiumWidget` 会加一层世界影像（`Widget/CesiumWidget.js:373-378`）。
> 因此 MVP 场景 MUST 显式配置 `baseLayer:false`（配置项，非代码改动）以保证零 compute 命令派发。
> 另：上游的 `ComputeCommand`/`ComputeEngine` **不是 GPU compute shader**，而是"全屏视口四边形 + 片元着色器写入纹理"的
> GPGPU 绘制（`Renderer/ComputeEngine.js:30-63,83-121`）→ WebGPU 侧只需一条**渲染通道**（视口四边形 + 离屏目标），
> **不需要** `GPUComputePassEncoder`，也不需要 WGSL 的 compute 入口（这是相对"compute 管线"的显著简化）。

**帧缓冲/多目标（MVP 的关键分支）**：`GlobeDepth` 的创建**只取决于 `context.depthTexture`**（`Scene/View.js:45-48`，守卫原文 `:46`），
与 `pickTranslucentDepth`/`useDepthPicking`/`depthTestAgainstTerrain`/`msaaSamples`/`requestRenderMode` 无关；
一旦创建，`GlobeDepth.update()`/`.clear()` **每帧都跑**（`Scene/Scene.js:3993-4004`）。
默认 `scene.msaaSamples = 4`（`Scene.js:253`，getter `:1703-1709`）→ 该路径必然涉及
`FramebufferManager`（`Renderer/FramebufferManager.js:143,238,249`）与多采样解析（`Renderer/MultisampleFramebuffer.js:96`）。
相反 `SceneFramebuffer`/OIT 是真条件创建（`Scene.js:4024-4030`，默认 `highDynamicRange=false` `Scene.js:748`）。

### 1.7 公开接缝评估（为何必须进入 fork 层）

| 候选公开接缝 | 证据 | 判定 |
|---|---|---|
| `Scene.context` | `Scene/Scene.js:1388` **`@private`**；只读 getter，无 setter | 不可用 |
| 向 `CesiumWidget` 注入外部 canvas | `Widget/CesiumWidget.js:221-223` 自建 canvas 并 append | 不存在该选项；且一个 canvas 只能有一种上下文类型（已实测）→ 也无法"接管"画布 |
| `SharedContext`（`contextOptions` 的 `instanceof` 分支） | 运行期确实可用：`Scene/Scene.js:146-152`；`SharedContext.prototype.createSceneContext` `SharedContext.js:47`；唯一调用点 `Scene.js:148`。**但**：`SharedContext` 标注 **`@private`**（`SharedContext.js:12`），`package/index.d.ts` 中 **0 命中**（未出现在公开类型里）；其内部仍 `new Context(...)`（`SharedContext.js:37`），`endFrame` 覆写还会调用 `sharedContext._context.endFrame()`（`:110`）→ 只复用 GL 上下文，**不解除 WebGL 依赖**；且参数必须 `instanceof SharedContext`，无法直接传入任意上下文对象 | **不是公开接缝**；作为注入点会得到"上游 GL 资源 + 我们的上下文"的混合体，不可用 |
| `contextOptions.getWebGLStub` | `Context.js:48,60-62`（测试用 stub），仅替换 GL 对象 | 测试专用，不构成后端替换 |
| 资源类（`Buffer`/`Texture`/`VertexArray`/`ShaderProgram`/`RenderState`/`Sampler`/…）由逻辑层直接 `import` 并构造 | §1.3 非 `context` 消费面（`Buffer` 97、`RenderState` 95、`ShaderSource` 79…） | 没有"替换实现"的官方扩展点 |

**结论**：渲染后端的公开接缝**不存在**（上游既不支持注入外部画布/上下文，也不支持替换资源类实现），
按 constitution v2.0.0 原则 I，此时允许进入 fork 层，且改动**可以**被严格限制在 `Source/Renderer/**`（§1.1 已证）。
本文档即原则 I 要求的"为何公开接缝不可用"说明。

---

## 2. 决策 D1：fork 形态（问题 2）

### 2.1 候选对比

| 候选 | 形态 | 优点 | 缺点 | 判定 |
|---|---|---|---|---|
| **F1 整仓 fork** | 拷贝/子模块上游仓库到本仓库，改 `Source/Renderer/**` | 单一构建；`git diff` 天然证明范围；可改构建配置 | 需自带上游构建链（Rollup + glsl 处理 + workers）；仓库体积与 CI 时间显著上升；与上游的对应关系靠手工维护 | 备选 |
| **F2 模块级替换补丁层（选定）** | 仓库只存"后端实现 + 别名插件 + 清单"；`@cesium/engine` 作为**钉版依赖**原样安装 | 逻辑层**根本不在本仓库**（是上游发布物）→ "字节级不变"由依赖完整性天然保证；补丁范围由清单枚举；升级 = 换版本 + 跑一致性门禁；仓库小、CI 快 | 需自备上游内部模块的 TS 声明；别名解析依赖消费方构建链；上游内部接口漂移靠"接口一致性门禁"发现 | **选定** |
| **F3 npm 别名/运行期 patch** | 发布自有包名或在运行期改写 `prototype` | 消费方零构建改动 | 运行期改写无法替换 `Scene.js` 内部**相对导入**的模块绑定（`Scene.js:40` `import Context from "../Renderer/Context.js"`），且不可静态审计 → 违背原则 I 的"补丁范围可审计" | 否决 |

**F2 的依据**：constitution v2.0.0 明确"fork `@cesium/engine`，或以可 rebase 的补丁层（patch layer）形式承载上游改动；
两种形态等价，选择依据是**可升级性与评审成本**"。F2 在两点上决定性更优：
（a）**逻辑层字节级不变是可机器证明的**（§2.4），而不是靠评审；
（b）升级成本从"逐文件 git rebase 冲突"变成"接口一致性清单差异"，可提前量化（§11）。

### 2.2 补丁集的范围（文件清单，来自 §1.1 普查）

| 类别 | 文件 | 处置 |
|---|---|---|
| **必须重实现**（直接调用 WebGL，16 个 / 348 调用点） | `Context.js`(46)、`Texture.js`(58)、`ShaderProgram.js`(42)、`Texture3D.js`(37)、`CubeMap.js`(33)、`CubeMapFace.js`(27)、`RenderState.js`(22)、`Buffer.js`(18)、`createUniform.js`(16)、`createUniformArray.js`(14)、`VertexArray.js`(10)、`Framebuffer.js`(9)、`Renderbuffer.js`(6)、`TextureAtlas.js`(4)、`MultisampleFramebuffer.js`(3)、`Sync.js`(3) | 以 WebGPU 重实现（保留同名导出、同名方法、同语义） |
| **必须改造/适配**（本身无 GL 调用，但语义绑定 GL 资源或着色器编译目标） | `ShaderCache.js`（程序缓存键与生命周期）、`ShaderSource.js`（**参数化为双发射目标：GLSL/WGSL**；保留 `sources`/`defines`/公共方法的可观察行为不变）、`FramebufferManager.js`（多采样/解析编排）、`ComputeEngine.js`（用 `Context` + `Framebuffer` + `ShaderProgram` 实现 GPGPU 绘制）、`SharedContext.js`（GL 上下文多路复用 + 2D blit，退化为"仅 WebGL2 路径使用"）、`TextureCache.js`、`loadCubeMap.js` | 按需小改；
`ShaderSource` 的改动 MUST 只到"增加 WGSL 发射通道"为止（不得改动 GLSL 视图与预处理语义）；
`SharedContext` 在 WebGPU 路径下 MUST NOT 被使用（若被使用 MUST 显式报错）；`ShaderBuilder.md` 见下行 |
| **原样保留**（GL-free 文件） | `AutomaticUniforms.js`、`UniformState.js`、**`ShaderBuilder.js`（MVP 保留；其 WGSL 化属切片 C）**、`ShaderDestination/Struct/Function.js`、`demodernizeShader.js`、`DrawCommand.js`、`ClearCommand.js`、`ComputeCommand.js`、`Pass.js`、`PassState.js`、`PickId.js`、`Sampler.js`、`PixelDatatype.js`、`BufferUsage.js`、`TextureWrap/MagnificationFilter/MinificationFilter.js`、`RenderbufferFormat.js`、`MipmapHint.js`、`ContextLimits.js`、`freezeRenderState.js`、`VertexArrayFacade.js` 等（**31 个 GL-free 文件中除 `ShaderSource.js` 外全部保留**） | **字节不变**（补丁清单里不出现即不变） |
| **本项目新增（后端层内）** | 设备交接、通道状态机/管线缓存、**WGSL 发射器 + GLSL 条件编译求值 + `czm_` WGSL prelude + `shader-leaf-map.json` + 运行时片段镜像生成器**、绑定布局生成、能力合成 | 新增文件，路径仍在 `Renderer/**` 之下（**含 `Renderer/webgpu/wgsl/**` 的 WGSL 库**） |

> 注：`ShaderSource.js`/`AutomaticUniforms.js`/`UniformState.js` **零 GL 调用**（普查结果）→ 可直接复用上游实现；
> `ShaderBuilder.js` 是 GLSL 代码生成器（模型/体素/高斯泼溅路径使用，地形不用），MVP 原样保留。

### 2.3 目录结构（仓库）

```text
upstream/                       # 上游基线元数据（不是源码副本）
  engine-26.3.0.lock.json       # 版本 + npm integrity(sha512) + 基线提交信息
  interface-manifest.json       # 被依赖的上游内部接口面（由脚本生成，见 §11）
vendor/engine-patch/            # 补丁层：仅渲染后端层的模块级替换
  manifest.json                 # 替换清单（module path → 本地文件），MUST 全部匹配 ^Renderer/.+\.js$
  Renderer/                     # 与上游同名的替换模块（Context.js、Texture.js、…）
  webgpu/                       # 后端内部新增模块（device-handoff / pass-encoder / pipeline-cache / bind-layout / shader-translate / capability）
src/                            # 本项目交付包（能力探测、路径选择、验证与基准基建、地形数据集适配）
  render-path/                  # 二选一与整体回退
  terrain/                      # CustomHeightmapTerrainProvider 适配 + 固定数据集
  verify/                       # 像素/统计断言、差异图、基准
tools/                          # 补丁范围审计、接口一致性清单、升级演练、数据集生成
tests/                          # unit / contract / visual / benchmark（见 contracts/）
```

### 2.4 逻辑层"字节级不变"的证明机制（三重）

1. **依赖完整性**：`@cesium/engine` 以精确版本 + `integrity` 哈希锁定（lockfile），CI 断言安装后
   `package.json.version === "26.3.0"` 且完整性哈希与 `upstream/engine-26.3.0.lock.json` 一致；
   任何 `postinstall` 改写上游文件的行为都会被"安装后目录哈希"断言的失败抓住。
2. **替换清单审计**：`vendor/engine-patch/manifest.json` 的每个键 MUST 匹配 `^Renderer/[A-Za-z0-9_]+\.js$`；
   CI 用一个单元测试对别名插件做**白名单穷举**（喂入全部 `Source/**` 模块路径，断言只有清单内的路径被改写）。
3. **构建产物审计**：构建后对 bundle 做"逻辑层符号来源"检查（逻辑层模块来自 `node_modules/@cesium/engine/Source/**`
   原始文件，而非本地副本）；对 `Source/Renderer/**` 之外的模块断言零本地覆盖。

> 这一机制直接兑现 SC-010 的"逻辑层代码改动为零（由流水线产物判定）"。

### 2.5 已知工程成本（必须处理，不可忽略）

- **无逐模块类型声明**：`@cesium/engine` 仅提供 `index.d.ts`（`Source/**` 只有 2 个 `.d.ts`）。
  → 补丁层用 TypeScript 编写时，需要一份**自维护的模块声明**（`types/engine-internal.d.ts`，
  只声明我们真正消费的上游内部符号，含签名与语义注释）。这份声明同时就是 §11 接口一致性清单的人工可读部分。
- **别名解析发生在消费方构建链**：本项目以 Rollup 插件形式提供别名（`resolveId` 钩子按**解析后的绝对路径**
  改写 `node_modules/@cesium/engine/Source/Renderer/<X>.js`）。`@cesium/engine` **无 `exports` 映射**，
  深路径可用（已核实），因此规则简单、可测。消费方若改用其他打包器，需要等价插件（属交付契约内容）。
- **上游 `Build/` 无 ESM 包**：实测 `Build/` 只有 `ThirdParty/`、`Workers/`，`main/module` 指向 `Source/index.js`
  → 消费方本来就必须打包源码树，我们的别名插件不需要与"预打包产物"打架。
- **着色器转换工具链（仅用于一次性转换与 CI 校验，不进入运行时）**（尖刺实测）：
  `glslang 16.6.0` 有 Khronos 官方预编译包（Linux 7.57 MB，零编译成本）；`naga-cli 30.0.1`
  **无预编译二进制**（wgpu release assets 全为空；npm 上 `naga-cli`/`@webgpu/naga` 均 404）→ MUST `cargo install naga-cli --locked`，
  CI 缓存 `~/.cargo`；`@webgpu/glslang 0.0.15` 若要用 MUST 显式引 `dist/web-devel-onefile`
  （默认 Node 入口实测 >120 s 挂死）。版本 MUST 锁定并写入 `upstream/engine-26.3.0.lock.json` 同级的工具链清单。
- **`ShaderSource.js` 进入补丁集**（双发射目标）：其改动是"增加 WGSL 发射通道"，属 §6.3 论证的"着色器编译"范围；
  `ShaderBuilder.js` 在 MVP 保持字节不变（其 WGSL 化属切片 C）。

### 2.6 许可证与署名（Apache-2.0）

- 上游：`@cesium/engine@26.3.0` 的 `LICENSE.md` = Apache-2.0，"Copyright 2011-2024 CesiumJS Contributors"。
- 本项目许可证选 **Apache-2.0**（与上游一致，避免条款冲突；spec 的"具体选型在方案阶段确定"据此关闭）。
- 交付 MUST 包含：①上游 `LICENSE.md` 原样保留；②`NOTICE`：声明本产品包含 CesiumJS Contributors 开发的软件、
  写明上游基线与版本、**逐条列出被重实现的文件**（Apache-2.0 §4(b) 的"modified files"要求）；
  ③每个从上游移植/改写的文件保留原始版权头并加"Modified for WebGPU backend"注记；
  ④`CONTRIBUTING.md` 说明补丁边界规则（改动只能落在 `Source/Renderer/**`）；⑤许可证检查纳入 CI。
- 地形数据署名沿用上一轮结论（Mapzen/Joerd Terrain Tiles + 逐来源署名清单，见 `contracts/terrain-source.md`）。

### 2.7 升级（rebase）演练形态

对 F2 而言"rebase"= 上游版本替换 + 接口收敛，演练脚本 `tools/upgrade-drill.mjs`：

1. 取上游旧版与新版 tarball（仓库外临时目录），**只比较 `Source/Renderer/**` 与 `Source/Shaders/**` 的哈希**；
2. 由新版重新生成 `interface-manifest.json`（被依赖符号 + 签名 + 结构），与基线清单 **diff** → 输出"适配清单"；
3. 对被保留的 31 个 GL-free 文件与 `Shaders/**` 做哈希对比 → 输出"上游漂移清单"（是否影响我们）；
4. 演练验收 = **补丁范围审计 + 接口一致性 + 既有全量验证（两条后端路径）**三项齐备（原则 I 要求）。
   演练结果作为 CI 产物存档；无网络环境用已提交的清单离线跑"干跑"模式。

---

## 3. 决策 D2：设备获取与同步构造（问题 1/2 的接口后果）

**问题**：WebGPU 的设备获取是异步的（`navigator.gpu.requestAdapter()` → `adapter.requestDevice()`），
而上游 `Scene` 在构造期**同步**创建 `Context` 并立刻读取能力值：

- `new Context(canvas, contextOptions)`：`Scene/Scene.js:151`（同步）；
- 构造期同步读取 GL 参数并写入全局 `ContextLimits`：`Renderer/Context.js:86-140`（`gl.getParameter(...)` 19 处）；
- 逻辑层在**同一构造过程中**读取能力标志：`Scene/View.js:46`（`context.depthTexture` → 是否创建 `GlobeDepth`）、
  `Scene/Scene.js:195`（`context.fragmentDepth` → log depth）、`Scene/Scene.js:1721`（`context.msaa`）；
- `ContextLimits` 被 **19 个逻辑层文件**消费（`maximumTextureSize` 16 处等）。

**选定方案：预取设备 + 同步交接（device handoff）**

1. 本项目自有包（`src/render-path/`）在构造任何上游对象**之前**完成：`navigator.gpu` 存在性 →
   `requestAdapter()` → 必需特性/下限判定 → `requestDevice()` → `device.lost` 订阅；
2. 成功则把 `{adapter, device, limits, features}` 写入**后端层新增的交接槽**（`vendor/engine-patch/webgpu/device-handoff.*`，
   仅在同一进程内、构造上游场景前调用一次）；
3. 随后同步构造上游 `CesiumWidget`/`Scene` → 我们的 `Context` 替换模块在构造期从交接槽取出设备，
   同步完成 `configure()`、`ContextLimits` 合成、默认纹理创建、能力标志发布；
4. 探测失败/超时（≤2s）时**不写入交接槽** → 用上游原版 WebGL2 `Context` 构造（整体二选一，见原则 II）。

**为何不选"异步 Context + 资源排队"**：`ContextLimits` 与能力标志必须在 `Scene` 构造期可读（上述证据），
异步方案会在构造期暴露**假值**，导致逻辑层选择错误的代码路径（例如在 `depthTexture=false` 时创建/不创建 `GlobeDepth`），
这属于"逻辑层可观察行为改变"→ 违反原则 I。

**设备丢失（FR-003）**：`device.lost` → 通知本项目包 → **整体切换**：销毁上游 `CesiumWidget`/`Scene` 与我们的后端，
重新探测后按同一流程重建（WebGPU 重建成功则仍走 WebGPU；失败则整体切到 WebGL2）。禁止保留任何旧设备的资源或绘制结果。

---

## 4. 决策 D3：能力标志与 `ContextLimits` 合成（问题 4 的前置）

WebGPU 后端 MUST 用**真实能力**回答逻辑层的特性门控（§1.3、§1.6 已给出消费点），映射原则：
**能真做的报 true，做不了的报 false 并走逻辑层既有的降级分支**——不得虚报（虚报会导致运行时失败），
也不得为省事把能力压到"老设备"，那会让逻辑层走已经不需要维护的旧路径。

| 逻辑层读取的标志 | 证据（消费点） | WebGPU 事实 | 采用值（MVP） |
|---|---|---|---|
| `webgl2` | ~~`Scene/Scene.js:3905`~~ → **`Scene/Cesium3DTileset.js:3905`**（**实测更正，依据 G-2 门禁 F-2**：`Scene/Scene.js` 全文没有 `context.webgl2` 读取，该行是 shadowState 代码；`:3905` 命中属 `Scene/Cesium3DTileset.js`。逻辑层实测共 **18 处 / 15 个文件**，代表见 `Core/FeatureDetection.js:392`、`Core/PixelFormat.js:518`、`Scene/Picking.js:386`、`Scene/GltfLoader.js:1382,1464,1521`；清单见 §4 末 C-1）、`Scene/Scene.js:1721`（**`msaa`**，逻辑层唯一消费点，见本表下一行） | WebGPU 等价于"现代管线"（整数纹理、实例化、MRT、VAO 语义、sRGB 目标） | **true**（语义为"现代渲染能力可用"，实现里 MUST 注释说明该标志的历史含义；该标志是**能力**不是**路径开关**，MUST NOT 用于决定走哪条后端） |
| `msaa` | `Scene/Scene.js:1721` | WebGPU 保证 4× MSAA（`sampleCount` 1/4） | true |
| `depthTexture` | `Scene/View.js:46`、`GlobeTranslucencyState.js:222`、`GroundPrimitive.js:983` | 取决于我们是否已实现离屏深度纹理与深度拷贝（§8 切片 B） | 切片 A：**false（临时）**；切片 B：true |
| `fragmentDepth` | `Scene/Scene.js:195`、`EllipsoidPrimitive.js:282` | WGSL `@builtin(frag_depth)` | true |
| `instancedArrays` | `CloudCollection.js:955`、`GltfLoader.js:1462` | 原生支持 | true |
| `drawBuffers` | `Scene/OIT.js:32` | 原生 MRT | true |
| `colorBufferFloat` / `colorBufferHalfFloat` | `Scene/Scene.js:1661`、`OIT.js:31` | 取决于浮点/半浮点可渲染格式能力（`rgba16float` 可渲染；`rgba32float` 需 `float32-blendable` 特性） | 按 `adapter.features` 计算 |
| `floatingPointTexture` / `halfFloatingPointTexture` | `Scene/BatchTable.js:90`、`GlobeDepth.js:281` | 纹理格式能力 | 按能力计算 |
| `stencilBuffer` / `stencilBits` | `Scene/Scene.js:2870,3064,3075` | `depth24plus-stencil8` → 8 bit | true / 8 |
| `elementIndexUint` | `Scene/Primitive.js:1263` | 原生 `uint32` 索引 | true |
| `textureFilterAnisotropic` | ~~`Scene/Scene.js`（`maximumTextureFilterAnisotropy` 1 处）~~ → **`Scene/ImageryLayer.js:1302`**（`ContextLimits.maximumTextureFilterAnisotropy`；**实测更正，依据 G-2 门禁 T017 复核**：`Scene/Scene.js` 仅在 JSDoc 提及 `allowTextureFilterAnisotropic`（`:130`），没有该成员读取；`context.textureFilterAnisotropic`（`Context.js:802`）无逻辑层读取） | 无各向异性过滤 | **false**（逻辑层走无各向异性路径） |
| `s3tc/pvrtc/astc/etc/etc1/bc7` | `Scene/Scene.js:1771-1781` | 未实现压缩纹理上传 | 全 **false** |
| `supportsBasis` | `GltfLoader.js:586`（另有 `Core/FeatureDetection.js:298`，实测补注） | 未实现（依赖压缩纹理） | false |
| `standardDerivatives` / `blendMinmax` / `textureFloatLinear` / `textureHalfFloatLinear` / `vertexArrayObject` | 无外部消费者（§1.3 表末） | — | 内部实现自由 |

`ContextLimits`（`Renderer/ContextLimits.js`，19 个逻辑层文件消费）映射：
**（实测更正，依据 G-2 门禁 D-3）** 该模块公开成员实为 **23 个**：逻辑层消费 **9 个**，补丁层**需重实现**的模块再消费 **8 个**
（`RenderState`→`maximumViewportWidth`/`maximumViewportHeight`/`maximumAliasedLineWidth`/`minimumAliasedLineWidth`；
`ShaderProgram`→`highpFloatSupported`/`highpIntSupported`；`Framebuffer`→`maximumColorAttachments`；`Renderbuffer`→`maximumRenderbufferSize`；
`Texture3D`→`maximum3DTextureSize`；`Texture`→`maximumTextureSize`；`VertexArray`→`maximumVertexAttributes`；`CubeMap`→`maximumCubeMapSize`），
**并集 17 个**（T005 的 `packages/cesium-webgpu/types/engine-internal.d.ts:27-54` 已按实测声明 **17 个声明面**；其成员集合与实测并集有 5 项差异，见 C-2）。
下表**补齐至全部 23 个成员**（含原表遗漏的 5 个）：

| `ContextLimits` 成员 | 外部消费 | WebGPU 来源 |
|---|---|---|
| `maximumTextureSize` | 16 | `adapter.limits.maxTextureDimension2D` |
| `maximumCubeMapSize` | 5 | `maxTextureDimension2D` |
| `maximum3DTextureSize` | 0（内部） | `maxTextureDimension3D` |
| `maximumVertexTextureImageUnits` / `maximumTextureImageUnits` / `maximumCombinedTextureImageUnits` | 5 / 1 / 0 | `maxSampledTexturesPerShaderStage`（组合值取同一值） |
| `maximumRenderbufferSize` | 0 | `maxTextureDimension2D` |
| `maximumSamples` | 1 | `4`（WebGPU 保证） |
| `maximumVertexAttributes` | 0（内部） | `maxVertexAttributes`（16） |
| `maximumVaryingVectors` / `maximumVertexUniformVectors` / `maximumFragmentUniformVectors` | 0（内部） | 由 `maxInterStageShaderVariables`、`maxUniformBufferBindingSize` 折算的保守值（MUST 注释来源） |
| `maximumAliasedLineWidth` / `minimumAliasedLineWidth` | 2 / 1 | `1.0`（WebGPU 无宽线；逻辑层据此走 1px 线） |
| `maximumAliasedPointSize` | 1 | `1.0` |
| `maximumTextureFilterAnisotropy` | 1 | `1.0` |
| `maximumViewportWidth/Height` | 0 | `maxTextureDimension2D` |
| `minimumAliasedPointSize`（原表遗漏，实测补入） | 0（内部） | `1.0`（WebGPU 无点大小；与 `maximumAliasedPointSize` 对称） |
| `maximumDrawBuffers`（原表遗漏，实测补入） | 0（内部；G-2 实测经公开 getter 读回 8） | `maxColorAttachments`（本机 Chrome 153 实测 8；WebGPU 保证 ≥ 8） |
| `maximumColorAttachments`（原表遗漏，实测补入） | 0（内部；`Framebuffer.js` 消费） | `maxColorAttachments` |
| `highpFloatSupported` / `highpIntSupported`（原表遗漏，实测补入） | 0（内部；`ShaderProgram.js:153` 消费） | 均 **true**（WGSL 无精度限定符，highp 语义恒可用；由此产生的精度差异属 §6.3 / H-7 已声明范围） |

> **临时降级开关的纪律**：`depthTexture=false`（切片 A）是**过渡**，MUST 在切片 B 完成后翻转为 true 并重跑全量验证；
> 该翻转必须在 `plan.md` 的复杂度追踪与 `tasks.md` 中显式登记，禁止长期停留在降级态。

### §4 事实更正记录（实测更正，依据 G-2 / G-4 门禁）

> 2026-09-19 复核**已装** `node_modules/@cesium/engine`（`version = 26.3.0`，即 `cesium@1.145.0` 的依赖）的 `Source/**` 后对本节表格的更正。
> 上文原文一律保留（删除线或引号标出），更正在其后就地给出，使漂移可追溯。本节只更正**事实**，不改任何采用值。

**C-1｜`webgl2` 的消费点行号（文件归属错误，非"标志不存在"）** —— 原文 `Scene/Scene.js:3905` 不成立：
- `Scene/Scene.js` 全文**没有** `context.webgl2` 读取；`:3905` 是 shadowState 代码（`shadowState.lightShadowMaps.length = 0;`）；
- 该 `:3905` 命中实为 **`Scene/Cesium3DTileset.js:3905`**（`if (!frameState.context.webgl2 && !this._enablePick)`）；
- **但 MUST NOT 推广为"全文没有读取"**：`context.webgl2` 在 26.3.0 中共 **25 处** = 逻辑层 **18 处 / 15 个文件** + `Renderer/**` **7 处**。
  逻辑层全部命中：`Core/FeatureDetection.js:392`、`Core/PixelFormat.js:518`、`Scene/Cesium3DTileset.js:3905`、`Scene/ClippingPolygonCollection.js:745`、
  `Scene/createElevationBandMaterial.js:492`、`Scene/GltfLoader.js:1382,1464,1521`、`Scene/GltfTextureLoader.js:304`、`Scene/Picking.js:386`、
  `Scene/Vector3DTilePrimitive.js:234,735`、`Scene/Model/GeometryPipelineStage.js:181`、`Scene/Model/InstancingPipelineStage.js:77`、
  `Scene/Model/MetadataPipelineStage.js:90`、`Scene/Model/ModelRuntimePrimitive.js:203`、`Scene/Model/TextureManager.js:84`、`Scene/Model/WireframePipelineStage.js:82`；
  Renderer 内部：`PixelDatatype.js:35`、`ShaderSource.js:245,282,297`、`Texture.js:806,1090`、`Texture3D.js:72`。
  （`docs/gate-g2-conclusion.md` F-2 的表述限定在 **`Scene.js` 单文件**，与本条一致；本行据此更正为"归属错误"而非"该标志无消费"。）
- 与 `webgl2` 最接近的能力标志确为 `msaa`（`Context.js:652`）：其**逻辑层唯一**消费点是 `Scene#msaaSupported` getter（`Scene/Scene.js:1719-1721`，读 `this._context.msaa`，**构造期不读**）；`Renderer/FramebufferManager.js:143` 另有一处（补丁层内部）。
- **对 WebGL2 回退设计依据的影响**：`webgl2` 是**真实被逻辑层读取的能力标志**（18 处，跨 `Core`/`Scene`/`Scene/Model`），因此 (i) 替换实现 MUST 如实发布该标志；(ii) 它是**能力**而非**路径开关**，决定走哪条后端的职责仍属 `src/render-path/` 的探测 + 交接槽，MUST NOT 用该标志做路径分支；(iii) **静态清单下的回退**由"补丁层保留一份上游原版 WebGL2 实现、替换实现一次性探测后整体委派"承担（**单构建**，同一时刻只有一个后端被实例化）——该决策见 `plan.md` 决策 **D2-a** 与原则 II 合规论证。

**C-2｜`ContextLimits` 计数（`10` → 模块 23 个公开成员）** —— 原文"10 个成员"不成立，实测：
- **模块公开成员 23 个**（`Renderer/ContextLimits.js:7-29` 后备字段 23 个；`:32-330` 访问器 23 个；除 `highpFloatSupported`/`highpIntSupported` 为 boolean 外均为 number）；
- **逻辑层消费 9 个**（19 个文件，明细见 §1.3 行内更正）；
- **补丁层需重实现的模块再消费 8 个**（清单见本节上方 `ContextLimits` 映射表引言）→ **并集 17 个**；
- 原记"10"的来源：`ContextLimits\.(\w+)` 扫描把模块路径片段 `ContextLimits.js` 的 `js` 计为成员名（排除该片段即得 9）；
- **T005 的 `packages/cesium-webgpu/types/engine-internal.d.ts` 已按实测声明 17 个成员声明面**（`:27-54`）。**W2 同步提示**：该 17 项与实测并集**基数相同但集合有 5 项差异** —— 已声明而实测无人消费：`maximumCombinedTextureImageUnits`、`maximumVaryingVectors`、`maximumVertexUniformVectors`、`maximumFragmentUniformVectors`、`maximumDrawBuffers`；实测被消费而未声明：`maximumAliasedPointSize`（`Scene/PointPrimitiveCollection.js:850`）、`maximumViewportWidth`/`maximumViewportHeight`（`RenderState.js:321-328`）、`highpFloatSupported`/`highpIntSupported`（`ShaderProgram.js:153`）。若 W2/T045 需要后者，T005 的声明面 MUST 同步；不影响本节的计数结论与 §4 的采用值。

**C-3｜`AutomaticUniforms` 计数（93，非 92；两个"92"是另一个量）** —— 实测上游 `Renderer/AutomaticUniforms.js` 顶层 `czm_*` 条目 **93 条**（全部 `czm_` 前缀，仅 `czm_sphericalHarmonicCoefficients` 为数组 size 9），与 §5.4 表所记"共 93 条"一致 → **§4 本身无需更正**。需要消歧的是另两处"92"：
- `tasks.md` T018 与 `plan.md`「Scale/Scope」的 **92** = 尖刺对"**拼装后 VS+FS 文本中 `^uniform` 声明数**"（`experiments/shader-spike/REPORT.md:74`，`default-3d` 配置）的实测值，**与 `AutomaticUniforms` 的 93 条不是同一个量**（前者是文本声明数，后者是上游模块条目数，且后者还受"记号未出现则不注入"影响）；
- G-4 门禁实测**默认配置实际参与者**为 **52 个数值 uniform + 2 个 sampler**（矩阵并集 58 个 struct 成员 + 5 个 sampler），`g4.json → measurements.automaticUniformCount = 93`；`docs/gate-g4-conclusion.md` D-1 已登记该偏离。
- 处置：`tasks.md` T018 的文字已消歧（92/93/54 三者分列），`plan.md` 的 92 保持原样（它引用的正是尖刺实测的文本声明数）。

**C-4｜`textureFilterAnisotropic` 的消费点行号** —— 原文"`Scene/Scene.js`（`maximumTextureFilterAnisotropy` 1 处）"不成立：实测该 `ContextLimits` 成员的**逻辑层唯一**消费点是 **`Scene/ImageryLayer.js:1302`**；`Scene/Scene.js` 中只有一处 JSDoc 提及 `allowTextureFilterAnisotropic`（`:130`），**没有**该成员读取；`context.textureFilterAnisotropic`（`Context.js:802`）**无逻辑层读取**（仅 `Texture.js:225/822`、`CubeMap.js:192/545`、`Texture3D.js:214/677` 经 `_textureFilterAnisotropic` 在补丁层内部使用扩展对象）。本行采用值 `false` 不变。

**C-5｜其余行号的逐条复核结果（顺带扫描）** —— §4 表内以下证据行**逐条与已装 26.3.0 一致，无漂移**：`msaa`(`Scene/Scene.js:1721`)、`depthTexture`(`View.js:46`/`GlobeTranslucencyState.js:222`/`GroundPrimitive.js:983`)、`fragmentDepth`(`Scene.js:195`/`EllipsoidPrimitive.js:282`)、`instancedArrays`(`CloudCollection.js:955`/`GltfLoader.js:1462`)、`drawBuffers`(`OIT.js:32`)、`colorBufferFloat`(`OIT.js:31`)/`colorBufferHalfFloat`(`Scene.js:1661`)、`floatingPointTexture`(`BatchTable.js:90`)/`halfFloatingPointTexture`(`GlobeDepth.js:281`)、`stencilBuffer`(`Scene.js:2870,3064,3075`)、`elementIndexUint`(`Primitive.js:1263`)、压缩纹理族(`Scene.js:1771-1781`)、`supportsBasis`(`GltfLoader.js:586` + `Core/FeatureDetection.js:298`)、以及"无外部消费者"组（`standardDerivatives`/`blendMinmax`/`textureFloatLinear`/`textureHalfFloatLinear`/`vertexArrayObject`/`debugShaders`/`throwOnWebGLError`/`defaultEmissiveTexture`/`defaultNormalTexture`/`defaultFramebuffer`/`stencilBits` 均实测 **0 处**）。
§1.3 的**引用计数是下界且随扫描口径浮动**：本轮独立复核（仅计 `context.<member>` / `frameState.context.<member>` 形态、未剔注释）得 `uniformState` 55（原 57）、`shaderCache` 31（32）、`drawingBufferHeight` 28（29）、`drawingBufferWidth` 22（23）、`depthTexture` 24（27）、`fragmentDepth` 6（7）、`textureCache` 2（3）、`webgl2` 18（17，差异最可能来自可选链 `scene?.context.webgl2` 的匹配口径）、`defaultTexture` 43（一致）、`createViewportQuadCommand` 26（一致）、`cache` 22（一致）。差异均在 ±3 内且**不改变"谁被消费"的任何结论**（所有被记成员在两种口径下都被消费、被记为 0 的成员在两种口径下都为 0），故正文计数保持原样、差异在此登记。

---

## 5. 决策 D4：命令执行路径映射（问题 3）

### 5.1 命令 → WebGPU 通道

| 上游命令/入口 | 证据 | WebGPU 实现 |
|---|---|---|
| `Context.prototype.beginFrame`（`Context.js:1427`，基类 no-op） | `Scene/Scene.js:4576` | 取当前交换链纹理（`context.configure()` + `getCurrentTexture()`）、新建 `GPUCommandEncoder`、初始化通道状态机 |
| `Context.prototype.draw(command, passState, program, uniformMap)` | `Context.js:1405`，全程同步 | 解析目标（`command._framebuffer ?? passState.framebuffer`，`:1418`）→ 若与当前通道身份不同则结束旧通道并开启新通道 → `setPipeline`（管线缓存）→ `setBindGroup` → `setVertexBuffer`/`setIndexBuffer` → `setViewport`/`setScissorRect` → `drawIndexed`/`draw` |
| `Context.prototype.clear` | `Context.js:1249`（`:1288` framebuffer 优先级、`:1291` `gl.clear`） | 在当前通道上：若该目标是本通道的**首次**操作则用 `loadOp:"clear"`；否则用 `clearBuffer`/显式清除子通道（MVP：每个目标是"先 clear 后 draw"的既有顺序，故以 `loadOp` 为主，`clearBuffer` 兜底） |
| `ClearCommand.execute` / `DrawCommand.execute` | `ClearCommand.js:99`、`DrawCommand.js:669` | **不改语义**（原样保留上游文件）——它们只调用 `context.clear/draw` |
| `ComputeCommand.execute(computeEngine)` | `ComputeCommand.js:116`，`Scene/Scene.js:182` 构造 `ComputeEngine` | **不是 GPU compute**：上游 `ComputeEngine` 用"全屏视口四边形 + 片元着色器写纹理"实现 GPGPU（`Renderer/ComputeEngine.js:30-63,83-121`）→ WebGPU 侧就是**一条渲染通道 + 离屏目标**，复用资源层即可。MVP 场景用 `baseLayer:false` + `skyBox:false` 保证零派发（§1.6）；命令确实到达时先抛出可诊断错误，随后按上述渲染通道实现（属 FR-030 的"绘制执行"范围） |
| `Context.prototype.endFrame` | `Context.js:1431` | 结束当前通道 → `commandEncoder.finish()` → `queue.submit()` → 呈现（WebGPU 自动呈现，无需 `present()`） |

### 5.2 通道状态机（pass state machine）

**通道身份** = `(colorTarget, depthStencilTarget, sampleCount, viewport, scissorRect, drawBufferSet)`；
身份变化即"结束当前 pass + 开启新 pass"。`Pass` 枚举、`PassState` 实例、程序、顶点数组、uniform、`RenderState`
的变化**都不**构成通道边界（§1.5 已证）。`endFrame`（`Scene.js:4597`）保证帧末通道关闭。
`resolveFramebuffers`（`Scene.js:4124-4181`）引起的目标切换自然产生新通道；
多采样解析映射为 `colorAttachments[i].resolveTarget`（对应 `MultisampleFramebuffer.blitFramebuffers` `MultisampleFramebuffer.js:96`）。

### 5.3 `RenderState` → `GPURenderPipelineDescriptor` 映射表

`RenderState` 的字段与默认值见 `Renderer/RenderState.js:110-187`（该文件必须重实现，但**选项形状 MUST 保持不变**：
50+ 个逻辑层文件用同一形状构造它）：

| Cesium 字段（默认值） | 定义处 | WebGPU 目标字段 | 说明 |
|---|---|---|---|
| `cull.enabled`/`cull.face`（false/BACK） | `:111-114` | `primitive.cullMode`（`none`/`front`/`back`）+ `primitive.frontFace` | `cull.face` 是"要剔除的面"，`frontFace` 来自 `rs.frontFace`（`:110`） |
| `frontFace`（CCW） | `:110` | `primitive.frontFace`（`ccw`/`cw`） | 直接映射 |
| `depthTest.enabled`/`func`（false/LESS） | `:129-132` | `depthStencil.depthCompare`（`always`/`less`/`less-equal`…）+ `depthWriteEnabled` | `enabled=false` → `depthCompare:"always"` 且不写深度 |
| `depthMask`（true） | `:139` | `depthStencil.depthWriteEnabled` | 与 `depthTest.enabled` 联合判定 |
| `depthRange.near/far`（0/1） | `:125-128` | **无直接对应**（WebGPU 无 `gl.depthRange`） | 深度范围修正已在着色器侧统一处理（§6.3）；非默认值在 MVP 中 MUST 断言为 (0,1) 并记录差异 |
| `blending.enabled` + `equationRgb/Alpha` + `functionSource/Destination*` + `blending.color` | `:141-157` | `fragment.targets[0].blend`（`color`/`alpha` 的 `operation`、`srcFactor`、`dstFactor`）+ `blendConstant` | GL 常量→GPUBlendFactor 逐项映射表随实现提交（`FUNC_ADD/ONE/ZERO/SRC_ALPHA/ONE_MINUS_SRC_ALPHA/…`）；`blendConstant` 无对应时用 `constant` 因子并记录差异 |
| `colorMask.red/green/blue/alpha` | `:133-138` | `fragment.targets[i].writeMask` | 位掩码 |
| `stencilTest.*`（front/back function、reference、mask、front/backOperation） | `:158-174` | `depthStencil.stencilFront/stencilBack`（`compare`/`failOp`/`depthFailOp`/`passOp`）+ `stencilReadMask`/`stencilWriteMask` | `reference` 不是管线状态 → 通过 `setStencilReference()` 在通道内设置 |
| `stencilMask`（`~0`） | `:140` | `stencilWriteMask` | — |
| `scissorTest.enabled`/`rectangle` | `:121-124` | `setScissorRect()`（命令级；`enabled=false` 时设为全目标） | `passState.scissorTest` 覆盖命令级（`RenderState.js:859-861`） |
| `viewport`（可选） | `:180-187` | `setViewport()`（命令级） | 回退 `passState.viewport` → `drawingBufferWidth/Height`（`RenderState.js:710-720`） |
| `lineWidth`（1.0） | `:115` | **无对应** | WebGPU 线宽恒为 1；非 1 值 MUST 报错或降级并记录 |
| `polygonOffset.enabled/factor/units` | `:116-120` | `depthStencil.depthBias`/`depthBiasSlopeScale`/`depthBiasClamp` | factor→`depthBiasSlopeScale`，units→`depthBias`（常数因子与实现相关，MUST 用测试标定） |
| `sampleCoverage.enabled/value/invert` | `:175-179` | **无对应**（WebGPU 无 sample coverage） | MVP MUST 显式记录为"不支持"，出现非默认值时抛出可诊断错误 |
| 顶点布局 | `TerrainEncoding` 属性描述（§1.6） | `vertex.buffers[].attributes[]`（`shaderLocation` 来自上游 `attributeLocations`）+ `arrayStride`/`stepMode` | 属性**名称→location** 必须沿用上游映射（WGSL 用 `@location(n)`） |
| 图元拓扑 | `drawCommand._primitiveType`（`Context.js:1322`） | `primitive.topology`（`triangle-list`/`line-list`/`point-list`） | 由 `PrimitiveType` 映射；`strip`/`fan` 需转换或报错 |

**管线缓存键** = `(shaderProgram, renderState 规范化指纹, 顶点布局指纹, 拓扑, 目标格式集合, sampleCount, 深度/模板格式)`；
`RenderState` 的逐转换缓存（`RenderState.js:844-848`）语义在 WebGPU 侧由"管线缓存 + 通道内状态跟踪"承担。

### 5.4 `UniformState` / `AutomaticUniforms` / `createUniform*` → uniform buffer + bind group

| 环节 | 上游证据 | WebGPU 方案 |
|---|---|---|
| 自动 uniform 定义与取值 | `Renderer/AutomaticUniforms.js`（1923 行，**零 GL 调用** → 原样保留）；`UniformState.js`（2002 行，零 GL 调用 → 原样保留） | 不变：`UniformState` 仍是 CPU 侧状态容器；`AutomaticUniforms` 仍按名字提供取值 |
| uniform 上传 | `createUniform.js`（16 处 GL 调用，`:86,120,155,204,254,299,332,366,400,437,477,517`）、`createUniformArray.js`（14 处）→ `ShaderProgram._setUniforms`（`ShaderProgram.js:546-604`，自动 uniform 重读 `:570-575`） | 重实现为**写入 CPU 侧暂存缓冲**：按"着色器实际使用的 uniform 名集合"生成 WGSL `struct` 与 CPU 布局表；`createUniform*` 返回的对象保留"惰性 set + 自 diff"语义（缓存上次值，值未变不写） |
| 数据上传时机 | 每命令 `_setUniforms` | 命令级：把暂存区写入**动态偏移的 uniform 环形缓冲**（`writeBuffer` + `setBindGroup(..., dynamicOffsets)`）；每帧一次性写入"自动 uniform 块"，命令级只写手工 uniform（`command.uniformMap`） |
| 纹理/采样器 uniform | `createUniform.js:254-259`（`activeTexture`+`bindTexture`）；`DrawCommand.uniformMap` 里的 `Texture`/`Sampler` 对象 | 映射为 `GPUTextureView` + `GPUSampler`，进 bind group（纹理组与 uniform 组分属不同 bind group，便于按"纹理集合是否变化"切换） |
| 布局生成 | 无（GL 由驱动完成） | **必须自建**：WGSL 的 `uniform` 地址空间有对齐规则（`vec3`→16 字节对齐、数组元素 16 字节对齐、`mat3` 列填充），CPU 侧布局表 MUST 与 WGSL 结构逐字段一致，并由单元测试（写入后回读/校验）+ 像素断言双重覆盖。**这是本方案的技术风险点之一（H-4）** |
| 深度范围修正 | GL: clip z∈[-1,1]；WebGPU NDC z∈[0,1]（上一轮已核实，§0.3） | 归属**着色器转译层**（§6.3）：对 `gl_Position`/`gl_FragDepth` 的写入点做统一重映射，并成对修正 `czm_inverseProjection` 语义；**MUST NOT** 通过改 `Core/PerspectiveFrustum.js`/`Renderer/UniformState.js`（后者是保留文件）实现 |

---

## 6. 决策 D5/D6：资源层映射与着色器编译前端（问题 4；着色器路径**已定案**）

### 6.1 资源类 → WebGPU 对象

| 上游类（必须重实现） | 上游关键语义（证据） | WebGPU 映射 |
|---|---|---|
| `Buffer`（`Buffer.js:14`，工厂 `:75/:135/:194`） | `typedArray`/`sizeInBytes`、`usage`（`BufferUsage`）、`bufferTarget`、`copyFrom`/`getBufferSubData` | `GPUBuffer`（`usage` 映射：`STATIC_DRAW`→`VERTEX|COPY_DST`、`DYNAMIC_DRAW`→`VERTEX|COPY_DST`、索引→`INDEX|COPY_DST`、pixel→`COPY_SRC|MAP_READ`）；`copyFrom` → `queue.writeBuffer` |
| `Texture`（`Texture.js:45`） | `source`（`ImageData/HTMLImageElement/Canvas/Video/OffscreenCanvas/ImageBitmap`，`:22`）、`pixelFormat`/`pixelDatatype`、`flipY=true`（`:27`）、`preMultiplyAlpha`、`sampler`、`width/height` | `GPUTexture`；`copyFrom` → `queue.copyExternalImageToTexture`（`flipY` 语义在 WebGPU 侧需自行翻转或改用 `copyExternalImageToTexture` 的 `origin`/`flipY` 支持，MUST 用像素测试标定）；`PixelFormat`/`PixelDatatype` → `GPUTextureFormat` 映射表随实现提交（含 `LUMINANCE/RED/ALPHA` 的等价处理与 sRGB 目标） |
| `Sampler`（`Sampler.js`，零 GL → 可保留） | `wrapS/T`、`magnificationFilter`、`minificationFilter`、`maximumAnisotropy` | `GPUSamplerDescriptor`；映射表覆盖 `Wrap`/`Filter` 的全部枚举；不支持的项（各向异性）显式记录 |
| `VertexArray`（`VertexArray.js:291`，工厂 `fromGeometry:575`） | `attributes[]`（`index/vertexBuffer/componentDatatype/componentsPerAttribute/normalized/offsetInBytes/strideInBytes/instanced/divisor`）、`indexBuffer`、`usage`/`interleave` | `GPUBuffer` + `GPUVertexBufferLayout`；`instanced`/`divisor` → `stepMode:"instance"`；VAO 概念不存在（每次 draw 设置） |
| `Framebuffer`（`Framebuffer.js:84`） | 颜色附件数组、深度/模板附件、`hasDepthAttachment`、`_bind`/`_getActiveColorAttachments` | **无对象对应**：降级为"附件描述集合"，由通道状态机在开启 pass 时使用；保留 `destroy()`/`isDestroyed()` 语义为空操作 |
| `Renderbuffer`/`RenderbufferFormat`（`Renderbuffer.js:12`） | 深度/模板渲染缓冲 | 映射为 `GPUTexture`（`depth24plus-stencil8` 等）；`RenderbufferFormat` 枚举→格式表 |
| `MultisampleFramebuffer`（`MultisampleFramebuffer.js:31`） | 多采样渲染帧缓冲 + 解析帧缓冲（`blitFramebuffers:96`） | `sampleCount:4` 的附件 + `resolveTarget`；`blitFramebuffers` → 由 pass 结束时的隐式解析代替（保留方法签名，语义为"确保解析已完成"） |
| `FramebufferManager`（`FramebufferManager.js`，零 GL → 小改） | 颜色/深度纹理与多采样配对的生命周期编排（`:143,238,249,401`） | 保留编排逻辑，改由新的 `Framebuffer`/`Texture`/`MultisampleFramebuffer` 提供对象 |
| `CubeMap`/`CubeMapFace`（`CubeMap.js:71`） | 6 面 + 采样器、`copyFrom` 各面 | `GPUTexture`（`dimension:"2d"`, 6 layers, `viewDimension:"cube"`）；非 MVP（天空盒关闭），切片 B 后 |
| `Texture3D`（`Texture3D.js:54`） | 3D 纹理（体素/Megatexture） | `dimension:"3d"`；非 MVP |
| `TextureAtlas`（`TextureAtlas.js:39`） | 动态图集（billboards/labels） | `GPUTexture` + 区域拷贝；非 MVP |
| `Sync`（`Sync.js:19`） | `gl.fenceSync` 异步回读同步点 | 无对应（WebGPU 用 `mapAsync` promise）；MVP 保留类与 `create()` 签名，`Sync` 的等待语义以 `mapAsync` 实现（切片 B） |
| `readPixels`/`readPixelsToPBO`（`Context.js:1538/1475`） | 同步读回（pick/深度） | `copyTextureToBuffer` + `mapAsync`：**MVP 显式不支持**（抛出可诊断错误），切片 B 实现"帧末批量回读 + 下次使用前解析"；picking 属后续增量验收范围 |

### 6.2 同步/异步语义差异（MUST 显式设计的部分）

- WebGL 的 `texImage2D`/`bufferData` 是同步上传；WebGPU 只有 `queue.writeBuffer`（同步排入队列）与
  `copyExternalImageToTexture`（排入队列）。→ **上传顺序天然保序**（同一 `GPUQueue` 的写入按提交顺序生效），
  因此逻辑层"创建资源后立即绘制"的顺序语义可以由"入队即生效"满足，**不需要**改逻辑层；
- 但 `getBufferSubData`（同步回读）与 `readPixels`（同步回读）**没有同步等价物** →
  必须走 §6.1 的显式失败/切片 B 方案，**禁止**用忙等阻塞主线程（会破坏 SC-004 的交互流畅性）；
- 着色器编译：`createShaderModule`/`createRenderPipeline` 是同步调用，但**校验错误异步上报**
  （`device.pushErrorScope`/`onuncapturederror`）→ 后端 MUST 在开发/测试模式下用 error scope 采集并
  在帧末抛出可诊断错误（否则逻辑层"编译失败即抛异常"的既有语义会静默丢失）。
- `device.lost` → FR-003 的整体恢复路径（§3）。

### 6.3 决策 D6：着色器路径 —— **已由实测尖刺定案：不转译，改"换发射目标"**

**决策状态**：**已定案**（此前"待定"状态随 `experiments/shader-spike/REPORT.md` 的产出而终结）。
本节结论全部来自该报告的实测；本方案据此设计，**不再保留"待定"表述**。

**尖刺实测结论（可直接采信，逐条见 `experiments/shader-spike/REPORT.md`）**：

| 路线 | 实测结果 | 判定 |
|---|---|---|
| 纯转译：`glslang → SPIR-V → naga → WGSL` | 原始 GLSL **6/6 失败**（`ES shaders for SPIR-V require version 310 or higher`、`non-opaque uniforms outside a block`）；经 R0–R4 五类**语义修补**后顶点 **3/3** 成功且被真机 GPU 接受（0 validation error），片元 **2/2 在 naga 30.0.1 内部崩溃**（`invalid id %243`，前有 `Unknown decoration RelaxedPrecision`）；且 SPIR-V 路线**丢失 varying 名字**（`member`/`member_1` + 自动 location） | **不可交付** |
| 运行时（浏览器内）转译 | glslang wasm 加载 30.8 ms、编译 19.4 ms（性能不是问题），但**失败原因与离线完全相同**；浏览器内**没有 SPIR-V→WGSL 实现** | 否决（继承 A 的全部结构性问题，还需自带 WGSL 后端） |
| 既有设施 | `demodernizeShader.js` 只做 ES3.00→ES1.00（**GLSL→GLSL**），零 WGSL 能力 | 不存在 |
| **人工/发射器产出 WGSL** | 手写 `globe-vs.wgsl`(181 行) + `globe-fs.wgsl`(151 行) → 真机 **0 编译消息**、`createRenderPipeline` 成功、绘制回读 **4096/4096 非黑像素**、四角取到 2×2 影像四个纹素色 | **完全可行，唯一确定性路径** |

**选定路线（= 本方案基线）**：

> **不转译 GLSL，改为"换发射目标"**：在 fork 的渲染后端层内把着色器组装层（`ShaderSource`，以及后续的 `ShaderBuilder`）
> **参数化输出 WGSL**（`emit: "glsl" | "wgsl"`；**输入仍是同一套 `sources` + `defines`，变体机制不变**），
> 并把地形着色器闭包所需的静态着色器叶子以"路径 A 出草稿 + 路径 B 人工定稿"转换为 WGSL 入库。

理由（尖刺实测支撑）：转译器的**全部成本都花在"撤销 Cesium 的 GLSL 约定"**上——R0–R4 五类修补
（`#line`、`#version 300es→310es`、松散 uniform→std140 UBO、`in/out` location 补全、精度语句顺序）
**在 WGSL 发射器里根本不会出现**：发射器一开始就产出 `@group/@binding`、`@location`、WGSL 结构体与原生精度语义。

**落地形态（三步，每步可独立验证；与尖刺 §7.1 的 S1–S3 对应）**：

1. **S1**：`ShaderSource` 参数化为双目标（GLSL/WGSL），**先只支持 Globe 家族与 MVP 所需 define 子集**；
2. **S2**：地形着色器闭包（`GlobeVS`/`GlobeFS`/`AtmosphereCommon`/`GroundAtmosphere` + 约 40 个 `czm_` 内建）
   的 WGSL 库入库，配套"每家族一个真机编译用例"（尖刺 harness 已可自动执行）；
3. **S3**：`czm_` WGSL prelude + uniform/绑定布局规划器（按变体生成 UBO 与动态偏移），用像素级回归验收。

**边界归属（原则 I 的显式论证）**：`ShaderSource.js`/`ShaderBuilder.js` 位于 `Source/Renderer/**`，
属于原则 I 允许范围中明列的"**着色器编译**"；它们不是逻辑层文件，也不改变
`Scene`/`Globe`/`QuadtreePrimitive`/`Camera`/图层/`DrawCommand` 的语义与公开行为。
**因此该扩展仍在渲染后端层内**，补丁范围审计（§2.4）不变。
**退路（记录但未采用）**：尖刺 §7.5 的"退路三"——把 WGSL 源码库与上游 `.glsl` 并存、fork 层只做"选哪一份"
（代价：可升级性变差，上游着色器改动无法自动传递），仅当"参数化发射目标"被判定越界时启用。

**必须同时满足的约束（否则会静默改变逻辑层行为）**：

- `shaderProgram.vertexShaderSource` / `fragmentShaderSource` 暴露给逻辑层的**仍是原始 GLSL**
  （`Scene/Primitive.js:849,1011,1012,1018,1020` 会对 GLSL 文本做正则探测来决定属性集合；
  `DerivedCommand.js`/`ShadowMap.js`/`OIT.js` 等还会读 `_attributeLocations`）→ **WGSL 发射必须发生在副本/内部通道上**；
- 条件编译求值（§6.4 第 1 条）、varying 成对推导（尖刺 §4 E1 实测：不匹配即管线创建硬失败）、
  UBO 打包与变体级缓存语义必须与上游"按变体缓存程序"一致（`GlobeSurfaceShaderSet.js:243-267` 的
  `[numberOfDayTextures][flags]` 缓存键语义不变）；
- 深度范围修正（GL clip z∈[-1,1] → WebGPU NDC z∈[0,1]）在发射器内成对处理
  `@builtin(position)` 写入与 `czm_inverseProjection` 语义；**MUST NOT** 通过改
  `Core/PerspectiveFrustum.js` 或 `Renderer/UniformState.js`（保留文件）实现。

**着色器叶子的存放与漂移检测**：转换后的 WGSL **不写入 `Source/Shaders/**`**（那超出补丁边界），
而是存放在后端层新目录（`backend-webgpu/webgpu/wgsl/**`），并以
**"上游叶子文本的内容哈希 → WGSL 文件"** 的映射表（`shader-leaf-map.json`）关联；
上游升级时重新计算叶子哈希 → 哈希变化即"必须重做该叶子的转换"，纳入接口一致性清单与升级演练（§2.7）。
运行时生成的着色器片段（`GlobeSurfaceShaderSet.js:419-472` 生成的 `computeDayColor()`，**磁盘上不存在**）
由后端层的**镜像生成器**按同一参数（`TEXTURE_UNITS` 等）产出 WGSL——这是尖刺发现的、**必须显式设计**的一项。

**发射器与后端其余部分之间的内部接口**（实现形态，供绑定布局/资源层消费）：

```text
WgslEmission.emit({
  vertexSources, fragmentSources,    // 上游 ShaderSource 的 sources（GLSL 文本，按上游顺序）
  defines,                           // 上游注入的 #define 集合（条件编译由本层求值）
  destination,                       // 上游 ShaderDestination（顶点/片元）
  attributeLocations,                // 上游 attributeLocations（名称→location）
  textureUnits, flags                // 生成 computeDayColor() 等运行时片段的参数
}) → {
  vertexModule, fragmentModule,      // WGSL 模块源码（或已创建的 GPUShaderModule）
  varyingSet,                        // 该变体的 varying 集合（VS/FS 必须成对一致）
  bindLayout,                        // 绑定布局：UBO 字段偏移 + 纹理/采样器槽位
  attributeBindings,                 // 名称→location（原样透传）
  diagnostics                        // 未支持构造/降级项的诊断信息
}
```

- **必须保持的上游语义**（不因发射目标改变而改变）：`ShaderCache` 的缓存键与释放语义
  （`shaderCache` 被 32 处外部引用、`Scene/Scene.js:4427` 每帧释放未用程序）、
  `#define` 变体数量与组合（地形变体由 `GlobeSurfaceShaderSet.js:243-267` 的
  `[numberOfDayTextures][flags]` 决定）、`ShaderDestination`（顶点/片元）、
  uniform 名称集合（`AutomaticUniforms` 按名取值）、`attributeLocations` 的名称→location 映射（§1.6）、
  以及逻辑层对 `vertexShaderSource`/`fragmentShaderSource`/`_attributeLocations` 的读取（§6.4）。
- **深度范围修正归属**（见 §5.4 末行）：由转译层统一处理 `gl_Position`/`gl_FragDepth` 写入并成对修正
  `czm_inverseProjection`；若尖刺证明该做法不可行，退路是在**后端**的 uniform 上传钩子里做成对修正
  （`createUniform*` 属补丁集，仍在后端层内），**不允许**改逻辑层或半逻辑层文件。

### 6.4 已核实：转译层必须交付的能力（与"选哪条转译路径"无关）

本轮对上游着色器链路的取证给出三条**决定性事实**，它们是 WGSL 发射器路线的**必需前置件**（不是可选项）：

| 事实 | 证据 | 对本项目的后果 |
|---|---|---|
| **上游没有 GLSL 预处理器**：`#define`/`#ifdef`/`#if` 只是**被写进文本**，由 GL 驱动求值 | `Renderer/ShaderSource.js:250-258`（`#define` 文本生成）；地形片元程序含 69 个条件块（48 `#ifdef`、2 `#ifndef`、19 `#if`、1 `#elif`、69 `#endif`），顶点 19 个，另加内建库引入的约 9 个 | WebGPU 后端**必须自己实现 GLSL ES 3.00 条件编译**（含 `defined()` 与 `&&`/`\|\|`/`!`/括号、`#elif` 链、以及算术条件 `#if TEXTURE_UNITS > 0`）——**这是两种转译路径共用的前置件**，MUST 作为独立可测模块交付 |
| **`czm_` 内联发生在条件求值之前**（对内联器而言，未激活分支里的引用同样产生依赖边） | `Renderer/ShaderSource.js:273`（内联入口）、`:157-166`（依赖收集） | 预处理器与内联器的**顺序语义必须与上游一致**（先内联、后条件求值），否则会漏掉内建函数/常量的依赖；变体展开后仍需保持内联结果 |
| 文本装配有固定顺序合同 | `Renderer/ShaderSource.js:155-304`：`#extension` 提升 → 片元精度块 → `precision highp sampler3D` → `#define`（跳过空串）→ 浮点纹理扩展 define → `#line 0` → 片元 `layout(location=0) out vec4 out_FragColor;` → 拓扑序内联的 `czm_` 内建 + 自动 uniform 声明 → 源体 → 前置 `#version 300 es`；首个 `precision` 语句被**非全局**正则剥离（`:207-210`） | 转译层的输入 MUST 是该合同产出的文本（而不是原始 `.glsl`）；`demodernizeShader.js` 对本 fork 是 WebGL1 死代码，可忽略 |

**其余必须保持的上游语义**（取证结论）：

| 项 | 证据 | 要求 |
|---|---|---|
| `ShaderProgram.fromCache` 的外部选项面**极小** | 逻辑层只用 4 个键：`context`、`vertexShaderSource`、`fragmentShaderSource`、`attributeLocations`（18 个 Scene 文件、26 个活调用点；`shaderId`/`glslVersion`/`spectorName` 在 26.3.0 **不存在**，0 命中） | 替换实现 MUST 只依赖这 4 个键；地形调用点 `Scene/GlobeSurfaceShaderSet.js:477-482` |
| 逻辑层还会读 `shaderProgram` 的这些成员 | `vertexShaderSource`/`fragmentShaderSource`（克隆 + `.sources` + `.defines`）、`vertexAttributes`、`id`、`destroy()`，以及**私有 `_attributeLocations`**（`Scene/DerivedCommand.js`、`Scene/ShadowMap.js`、`Scene/OIT.js`、`Scene/GlobeTranslucencyState.js`、`Scene/PointCloudEyeDomeLighting.js`、`Scene/Cesium3DTileBatchTable.js`） | 这些成员 MUST 全部保留（含 `_attributeLocations`）；→ 它们是"必须保持语义"的一部分，出现在 `types/engine-internal.d.ts` 与接口一致性清单中 |
| **逻辑层会对 GLSL 文本做正则探测** | `Scene/Primitive.js:849,1011,1012,1018,1020` 按 `/in\s+vec3\s+normal;/` 等模式判断属性是否存在 | 转译 MUST 在**副本**上进行；`shaderProgram.vertexShaderSource/fragmentShaderSource` 暴露给逻辑层的**仍是原始 GLSL**（MUST NOT 被就地改写），否则会静默改变逻辑层行为 |
| 自动 uniform 是**扁平声明**而非 UBO/struct | `Renderer/AutomaticUniforms.js:32-43`（`uniform <type> czm_x;` 合成），仅当文本出现该 `czm_` 记号时注入（`ShaderSource.js:414-431`）；共 93 条，仅 `czm_sphericalHarmonicCoefficients` 为数组（size 9） | 绑定布局 MUST 由"着色器实际引用的名字集合"生成（我们仍可把它们打包进一个 WGSL `struct`，但**名字→字段**的映射必须与上游一致） |
| `UniformState.update(frameState)` 由逻辑层驱动 | `Scene/Scene.js:4545`（在 `function render(scene)` 内），另有 `Scene.js:2856,3540…` 与 `Scene/Picking.js` 多处；`Context.js` **从不**调用它（0 命中） | 后端 MUST NOT 假设自己能控制 uniform 更新时机；`UniformState`（保留文件）仍是唯一事实来源 |
| 地形所需的自动 uniform 数量有限 | 地形直接引用 23 个，经内联内建再引入 4 个（`czm_fogDensity`、`czm_gamma`、`czm_inverseModelView`、`czm_pixelRatio`），启用裁切面时为 30 个 | MVP 的 uniform 块规模可控（→ H-4 的验证范围明确） |
| 纹理/采样器绑定点集中 | 绘制期绑定只在 `createUniform.js:256,259`（标量采样器）与 `createUniformArray.js:361,362`（采样器数组）；单元号在链接时由 `setSamplerUniforms` 分配（`ShaderProgram.js:444-456`）；`Context.defaultTexture` = 1×1 RGBA8、`flipY:false`、默认 `Sampler`（CLAMP_TO_EDGE，`Context.js:1018-1040`）；`u_dayTextures` 是 `sampler2D[TEXTURE_UNITS]` 数组（`GlobeSurfaceTileProvider.js:3035,3177`） | bind group 的纹理/采样器分组方案可直接照此建模；MVP 不需要 `TextureAtlas`/`Texture3D` |
| 地形**默认**片元/顶点着色器与内建闭包的 GLSL 风险面很窄 | `GlobeVS/GlobeFS` + 42 个内建成员（10 常量 / 28 函数 / 4 结构体，约 16.7 kB）中：`dFdx/dFdy/fwidth` 0、`textureLod/texelFetch/textureProj` 0、`gl_FragDepth` 0、整数/位运算 0、循环 0、`flat/noperspective` 0 | 默认地形路径的转译难度**集中在少量构造**（见下行） |
| 风险集中在 3 处（默认路径） | ① `sampler2D` 作为**函数参数**（`GlobeFS.js:185`，用于 `:221`）→ WGSL 需显式传递 texture+sampler；② `uniform bool u_dayTextureUseWebMercatorT[TEXTURE_UNITS]`（`GlobeFS.js:7`）参与纹理坐标三元选择；③ **可选变体**（MVP 不启用）：`Shaders/VectorCommon.js`（2 `dFdx`+2 `dFdy`、14 `texelFetch`、24 `ivec`/30 `int`、3 处**非恒定上界**循环）、裁切函数注入（`Scene/getClippingFunction.js` 注入 `discard`/`break`/常量界循环）、`AtmosphereCommon.js`（**始终存在**：2 个 `const int` 界循环 + 早退 `break`，`:91,:119,:96,:124`）、3 处 `mat3`（`eastNorthUpToEyeCoordinates.js:30`、`hue.js:18,21`） | MVP 只需覆盖"默认地形 + AtmosphereCommon + 内建闭包"；**MUST NOT** 依赖 `gl_FragDepth`/derivative/整数纹理等在 MVP 未被使用的能力；可选变体（矢量图层、裁切面）列为切片 C |
| `ShaderBuilder` 是第二条着色器装配路径 | `Renderer/ShaderBuilder.js`（597 行，零 GL 调用 → 保留）+ `ShaderDestination`/`ShaderStruct`/`ShaderFunction`；由 `Scene/Model/ModelRenderResources.js`、`Scene/VoxelRenderResources.js`、`Scene/GaussianSplatRenderResources.js` 使用，最终仍走 `ShaderProgram.fromCache`（`:512-517`） | MVP 由"未实现即显式失败"覆盖（切片 C）；保留文件不得改 |

---

## 7. 决策 D7（原问题 5）：MVP 切片

**MVP 定义**（与 spec 一致）：地形在**新后端**上端到端跑通 + 兜底后端独立运行同样通过 + 逻辑层零改动 + 首份基准。
MVP 的最小实现集（"必须实现"= 缺了就跑不出地形；"允许桩"= 可先显式失败，但 MUST NOT 静默失败）：

| 后端组件 | 必须实现的方法/成员（依据 §1.6 的地形路径） | 切片 |
|---|---|---|
| `Context`（重实现） | 构造（设备交接、`configure`、`ContextLimits`、能力标志、默认纹理）、`beginFrame`/`endFrame`、`draw`、`clear`、`id`、`canvas`、`drawingBufferWidth/Height`、`uniformState`、`shaderCache`、`textureCache`、`cache`、`defaultTexture`、`createViewportQuadCommand`、`createPickId`/`getObjectByPickColor`、`destroy`/`isDestroyed` | A |
| `Buffer` | `createVertexBuffer`、`createIndexBuffer`、`copyFrom`、`destroy` | A |
| `VertexArray` | `new VertexArray({context, attributes, indexBuffer})`、`_bind`/`_unBind`、`indexBuffer`、`numberOfVertices`、`destroy` | A |
| `Texture` + `Sampler` | `new Texture({context, width, height, pixelFormat, pixelDatatype, sampler, source})`、`copyFrom`、`destroy`；`Context.defaultTexture`（1×1） | A |
| `ShaderProgram` + `ShaderCache` | `fromCache`（含 `attributeLocations`）、`_bind`、`_setUniforms`、`maximumTextureUnitIndex`、`destroy`/`releaseShaderProgram` | A |
| `createUniform`/`createUniformArray` | 全部标量/向量/矩阵/纹理分支（地形需要矩阵、float、vec2/3/4、采样器） | A |
| `RenderState` | `fromCache`（保持选项形状）、`partialApply`（改为管线状态 diff）、`apply` | A |
| `ClearCommand`/`DrawCommand`/`PassState`/`Pass`/`PixelDatatype`/`BufferUsage`/`Sampler` 枚举与命令类 | **原样保留上游文件**（零 GL 调用） | A |
| 通道状态机 + 管线缓存 + 绑定布局生成 + 交换链呈现 + MSAA(4×) resolve | 新增后端内部模块 | A |
| `Framebuffer`/`Renderbuffer`/`MultisampleFramebuffer`/`FramebufferManager` | 附件描述、`hasDepthAttachment`、深度/模板纹理、多采样解析、`destroy` | **B（MVP 验收要求，FR-030 明列"帧缓冲"）** |
| `GlobeDepth` 相关：`createViewportQuadCommand`（`:1625`）、深度拷贝/更新用的视口四边形命令（`Scene/GlobeDepth.js:178,196,211,229`）、`depthTexture=true` | 依赖 B | **B** |
| `readPixels`/`readPixelsToPBO`/`Sync`/`CubeMap`/`Texture3D`/`TextureAtlas`/`ComputeEngine`(执行)/`ShaderBuilder`(WGSL 变体) | 骨架 + 显式失败（抛可诊断错误），不进入 MVP 验收 | **桩（切片 C，后续增量）** |
| 场景配置（无需改代码） | `skyBox:false`、`skyAtmosphere:false`（→ 无 `Sun`/`Moon`/`ComputeCommand`，§1.6）、**`baseLayer:false`（影像重投影会派发真实 `ComputeCommand`，§1.6 补充）**、无 post-process、`globe.enableLighting=true`、`globe.baseColor` 可见、地形来自 `CustomHeightmapTerrainProvider` | A |

**切片 A 的临时降级**：`depthTexture=false`（于是 `GlobeDepth`/OIT/`TranslucentTileClassification` 都不创建，
`Scene/View.js:46`、`:51`、`TranslucentTileClassification.js:61`）→ 用最小工作面先把"画布通道 + 地形绘制"跑通；
**切片 B MUST 翻转 `depthTexture=true` 并重跑全量验证**，否则 FR-030 的"帧缓冲"要求未兑现。

**禁止的"省事"做法**（原则 II）：任何"让上游继续用 WebGL2 画、我们的 WebGPU 画布叠上去/遮住它"的实现，
包括让上游绘制到不可见目标、把上游 canvas 隐藏、用 CSS 遮挡、逐帧合成两条管线产物——**全部被否决**（spec Q3/Q4）。

---

## 8. 决策 D8：地形数据源（沿用并升级上一轮结论）

- **公开接缝**：使用上游公开类 `CustomHeightmapTerrainProvider`（`Core/CustomHeightmapTerrainProvider.js:28-56`；
  公开导出：`package/index.js:263`、`index.d.ts:5324`）——通过 `callback(x,y,level)` 返回 `HeightmapTerrainData`，
  **不需要**自定义 `TerrainProvider` 子类、不需要 `Object.create` 绕过构造检查（上一轮的做法在 `TerrainProvider` 不允许
  直接实例化这一点上是必要的绕行，本架构下不再需要）。
- **固定数据集**：沿用上一轮的"公开栅格高程源 + 本地固定数据集"（AWS Open Data terrain-tiles，Terrarium PNG，
  免登录/CORS `*`；解码 `height = R*256 + G + B/256 - 32768`，XYZ 约定；目标区域勃朗峰/大孔班山约 0.6°×0.5°，z0–z12，
  约 3–6 MB，随仓库提交 → CI 全程离线）。
- **几何构建与调度**：**全部由上游逻辑层完成**（`HeightmapTerrainData.createMesh` → `TerrainEncoding` → `GlobeSurfaceTile`
  → `DrawCommand`），本项目不再自建顶点/索引/裙边（与上一版的**关键差异**，直接削减 W5 的工作量）。
- **署名**：沿用上一轮的强制署名文本与 `manifest.json` 的 `attribution` 字段 + CI 非空校验。

---

## 9. 决策 D9（原问题 6）：验证与 CI

### 9.1 二选一语义下的验证设计

| 目标 | 做法（依据） |
|---|---|
| 同一场景在两条路径下各自正确 | 同一套用例**参数化两次独立运行**（独立进程 + 独立页面加载）：`RENDER_BACKEND=webgpu` / `=webgl2`；每次运行断言"本次只启用一条路径"（我们的包暴露可观察状态，且测试断言另一条后端的 GPU 对象创建数 = 0） |
| 视觉回归 | **每路径各自一份参考帧**（跨路径逐点比较不可靠，§0.3）；比较区域排除抗锯齿边缘；容差写在测试代码中并记录来源 |
| 跨路径等价（FR-008） | 用**统计断言**：非背景像素覆盖率、颜色/深度分布、几何统计、draw call 数落在声明区间；无法消除的差异（亚像素边缘、MSAA 解析、sRGB、深度表示）在契约中显式声明 |
| 逻辑层零改动（SC-010） | 补丁范围审计（替换清单全部匹配 `^Renderer/`）+ 依赖完整性哈希 + 别名插件白名单测试（§2.4） |
| 地形几何正确性 | 多瓦片拼接场景（≥2×2 瓦片，覆盖 z12）；接缝/裙边：覆盖率与深度不连续处的数值断言；高程特征：最高/最低处明暗差（`globe.enableLighting`） |
| 设备丢失（FR-003） | CDP/`WEBGL_lose_context` 的 WebGPU 等价手段（`device.destroy()` 触发 `device.lost`）→ 断言整体重建完成、无未捕获错误、无旧设备资源残留 |
| 基准（FR-017~020） | 帧时间 p50/p95（`postRender` 相邻两次 `performance.now()`）、显存代理指标（我们登记的 GPU 对象字节数）、draw call 数（统计 `drawIndexed/draw` 调用）；两路径各自独立会话采集；预热与采样帧数固定 |

### 9.2 CI（FR-021~025）

| 作业 | 内容 | 成本 |
|---|---|---|
| `build+unit` | 构建、类型检查、别名插件白名单测试、清单审计、依赖完整性、许可证检查 | 免费（标准 runner） |
| `visual:webgl2` | Xvfb + ANGLE/SwiftShader，独立进程跑 WebGL2 路径用例 | 免费 |
| `visual:webgpu` | Xvfb + Mesa lavapipe（**必须 headed**），`--enable-unsafe-webgpu --enable-features=Vulkan`，独立进程跑 WebGPU 路径用例 | 免费 |
| `benchmark` | 两条路径各自独立采集相对基准（与基线比），产出 JSON 产物 | 免费（采样帧数受限） |
| `upgrade-drill`（干跑） | 用已提交的接口清单离线校验；仅在升级 PR 上跑完整模式 | 免费 |
| `shader` | WGSL 语法/校验（CI 无 GPU 时用 `naga --input-kind wgsl` 降级）、叶子哈希映射完整性、着色器库覆盖率（地形闭包） | 免费（`naga` 需 `cargo install`，缓存 `~/.cargo`） |
| `gpu:absolute`（受门控） | 真实 GPU 绝对性能与 timestamp 剖析 | **付费，默认不执行，需预算批准** |

**盲区**（FR-023，沿用上一轮并补充）：软件光栅化≠GPU；headless 下 WebGPU 画布呈现不可靠（故用 Xvfb headed）；
CI 的符合性证据是弱证据；`timestamp-query` 在软件适配器下不可用；浏览器版本漂移会改变像素（固定 Playwright 版本）；
**新增**：①lavapipe 下 WebGPU 校验错误的报错文本与真实驱动可能不同；
②**CI 无 GPU 时 WGSL 只做语法/模块校验（naga），不覆盖 WebGPU 管线校验**
（varying 不匹配、绑定布局错误等只在 `createRenderPipeline` 暴露 → 本机真机 harness 为必需补充手段）。

---

## 10. 决策 D10（原问题 7）：升级可维护性

**成本量化模型**：升级成本 ≈ `(被替换文件数 × 内部接口变更比例) × 单位适配成本 + 验证成本`。

| 量 | 现状（1.145.0 基线） | 说明 |
|---|---|---|
| 被替换文件 | 16（必替换）+ ~6（适配） | §2.2 |
| 被保留的 GL-free 文件 | 31 | 变更时只需看是否触及我们消费的接口 |
| 直接 GL 调用点 | 348 | 重实现工作量的原始度量 |
| 外部消费的后端成员 | `Context` ≥ 30 个成员 + ~20 类工厂/构造面 | §1.3 |
| 接口一致性清单 | 机器生成（符号 + 签名） | 升级时清单 diff = 改造清单 |

**控制手段**：①清单化（升级差异**提前可见**，而不是末期爆炸）；②门禁化（补丁范围 + 一致性 + 全量验证三项缺一不可）；
③依赖钉版（避免非预期漂移）；④"干跑"模式（无网络也能在 CI 校验）。

---

## 11. 待验证假设（H-n）与验证方法

| 编号 | 假设 | 验证方法 | 失败时的退路 |
|---|---|---|---|
| **H-1** | 模块级替换补丁层在当前消费方构建链（Rollup/Vite）下能稳定解析并覆盖 `Scene.js` 的相对导入 | 最小复现：只用别名插件替换 `Context.js`，跑通"构造 Scene 并输出类型"的冒烟测试 | 退到 F1（整仓 fork）；补丁清单与审计方式不变 |
| **H-2** | `ContextLimits`/能力标志的合成值足以让逻辑层在地形路径上选择"现代路径"且不触发未实现分支 | 在 CI 的两条路径用例中记录被触发的分支（覆盖率/日志断言） | 对具体标志按 §4 表逐项修正并补测试 |
| **H-3** | 通道状态机（framebuffer/viewport/scissor 身份 + `loadOp` 清屏）能覆盖 `Scene` 的全部通道切换序列 | 帧级断言：通道数、每通道附件与 load/store 操作、与上游 `clear`/`draw` 序列的一致性（录制-回放） | 引入"显式通道提示"只在后端层内部生效（不改逻辑层），或在 `endFrame` 前强制拆通道 |
| **H-4** | WGSL uniform 结构布局与 CPU 侧布局表可由生成器保证一致（含 `mat3`/数组/`vec3` 对齐） | 单元测试（生成布局 → 校验偏移与 WGSL 一致性）+ 像素断言 | 全部改为"每标量一个 vec4 槽"的保守布局（浪费带宽但零风险） |
| **H-5** | ~~转译层能在不改 `Source/Shaders/**` 与逻辑层的前提下产出可编译 WGSL~~ → **已由尖刺定案并部分实测**：路线 = WGSL 发射器 + 着色器库一次性转换；地形闭包的手工 WGSL 已在真机跑通（4096/4096 非黑像素） | 剩余验证：`ShaderSource` 双发射目标的接口测试 + 变体全组合的真机管线校验 + 像素断言 | 若"参数化发射目标"被判越界：启用尖刺 §7.5 退路三（WGSL 库与上游 `.glsl` 并存、只做"选哪一份"），可升级性下降须记入 rebase 演练 |
| **H-6** | 运行时**变体数量与编译缓存规模**在预算内（38 个 boolean 门控 × `TEXTURE_UNITS` × 场景模式；尖刺仅静态计数，未测运行时） | 统计运行时 `ShaderProgram` 实例数与编译耗时直方图；CI 设上限阈值 | 收敛 MVP define 子集（只保留地形路径实际可达的组合） |
| **H-7** | **精度变化**（WGSL 无 `highp/mediump`）与**纹理 Y 翻转**（已观察到，未与 WebGL2 基线 diff）不改变像素结论 | 与 WebGL2 基线做像素 diff + 地形高程数值比对；四角纹素回读断言 | 容差按差异来源分别记录并显式声明；Y 翻转在 `Texture` 映射层统一修正 |
| **H-8** | MSAA 4×（画布 + 离屏解析）在 lavapipe 与真实 GPU 上像素结果落在同一容差内 | 双环境采集参考帧与统计对比 | 容差按环境标注分别记录；路径内回归仍阻断 |
| **H-9** | lavapipe 下 WebGPU 一帧整场景的耗时能满足 ≤20 分钟流水线预算；CI 无 GPU 时以 `naga --input-kind wgsl` 代替管线校验的盲区可接受 | CI 实测（分片与采样帧数可调）；盲区写入 `docs/ci-degradation.md` | 缩减采样帧数/用例分片；必要时增加本机/自托管真机冒烟作业 |
| **H-10** | 上游下一次发布的 `Renderer/**`（含 `Shaders/**` 叶子文本哈希）变更幅度处于"可 rebase"范围 | 升级演练（§2.7）在真实新版本上跑一次；叶子哈希漂移生成"必须重做转换"清单 | 若变更越界（例如上游自己引入 WebGPU 后端），评审后改为"与上游对齐/复用其接缝"的新方案 |

---

## 12. 被否决方案（含否决理由）

| 方案 | 否决理由 |
|---|---|
| **双画布分层**（上游 WebGL2 画布 + 我们的 WebGPU 画布 + 遮挡/透明） | **用户明确否决**；违反 constitution v2.0.0 原则 II（二选一，不同时运行）；双份开销且既有功能永远无法接入新后端 |
| 让上游绘制到不可见目标 / 隐藏上游 canvas / CSS 遮挡 / 逐帧合成两管线产物 | 同属"两条管线同时绘制同一场景"，原则 II 明文禁止的四种形态 |
| 通过 `SharedContext` 注入自研上下文 | 该接缝 `@private`（`SharedContext.js:12`）且不在 `index.d.ts`，内部仍构造 WebGL `Context`（`:37`）；会得到"上游 GL 资源 + 我们的上下文"的混合后端（§1.7） |
| 运行期 patch `prototype`（不落盘、不改构建） | 无法替换 `Scene.js` 的相对导入模块绑定；补丁范围不可静态审计（原则 I 要求可审计、可 rebase） |
| 整仓 fork 作为首选（F1） | 与补丁层等价但升级与评审成本更高（需自带上游构建链、仓库与 CI 体积上升）；保留为 H-1 失败时的退路 |
| 异步 `Context` + 资源排队 | `ContextLimits`/能力标志必须在 `Scene` 构造期可读（§3 证据），异步方案会暴露假值 → 改变逻辑层可观察行为 |
| 为地形单独写一条兼容渲染旁路（上一版 W1 的做法） | 与"只替换管线，其他逻辑不变"相悖；且与 §1.1 的证据矛盾（不需要自建几何，全部由上游逻辑层完成） |
| **纯转译：`glslang → SPIR-V → naga → WGSL`** | **实测不可交付**（尖刺）：原始 GLSL 6/6 失败；修补后片元 2/2 因 naga 30.0.1 崩溃；SPIR-V 路线丢失 varying 名字；且 R0–R4 修补层本身是一个需要长期维护的编译器 |
| **运行时（浏览器内）转译** | 实测继承纯转译的全部结构性问题（同样要求 ≥310 es 与 uniform block），且浏览器内没有 SPIR-V→WGSL 实现，还需自带 WGSL 后端；每变体 ~20 ms 转译 + 30 ms wasm 启动，且上游每次升级都要重新验证 244 个内建 |
| **双层 WGSL 源码库（尖刺退路三：WGSL 库与上游 `.glsl` 并存，fork 层只做"选哪一份"）** | **未被采用**，仅作为"若参数化发射目标被判越界"的退路记录：代价是可升级性显著变差（上游着色器改动无法自动传递，需人工重做转换映射） |
| 依赖 `@private` 上游内部语义（作为"绕过逻辑层"的手段） | v2.0.0 已允许进入 fork 层，但**边界是渲染后端层**；用私有语义旁路逻辑层的做法仍被原则 I 的"逻辑层语义一行不改"禁止 |

---

## 13. 结论摘要

1. **渲染接缝是文件系统级的**：WebGL 触碰面 100% 位于 `Source/Renderer/**`（16 文件 / 348 调用点），
   → 补丁可以严格限制在该目录，SC-010 可由 CI 机器判定。
2. **公开接缝不存在**（`Scene.context` `@private`；无法注入外部 canvas；`SharedContext` `@private` 且内部仍是 WebGL）
   → 按原则 I 进入 fork 层，形态选 **F2 模块级替换补丁层**（逻辑层字节级不变由依赖完整性天然保证）。
3. **数据流不改**：地形数据源用公开 `CustomHeightmapTerrainProvider`；几何/调度/命令构造全部由上游逻辑层完成。
4. **执行流需重写**：命令 → 通道由后端**派生**（上游没有 `beginPass/endPass`）；`RenderState` → 管线描述符映射表已列出；
   uniform 走"自动 uniform 块 + 动态偏移环形缓冲 + 纹理 bind group"。
5. **着色器路径已定案（不再待定）**：**不转译**，改为在 fork 层把着色器组装层参数化为 **WGSL 发射器** +
   地形着色器闭包的一次性转换（路径 A 出草稿、路径 B 人工定稿）；转换产物放在后端层目录并以
   **叶子文本哈希映射**关联上游，保持 `Source/Shaders/**` 字节不变。
   该扩展属原则 I 明列的"**着色器编译**"，仍在渲染后端层内（§6.3 给出完整论证）。
6. **三项关键技术风险**：WGSL uniform/绑定布局一致性（H-4）、运行时变体规模（H-6）、
   精度与纹理 Y 翻转的像素影响（H-7）。三者都在后端层内闭合，不影响逻辑层与外部契约；
   其余（H-5 的路线选择）已由尖刺实测消除。
7. **验证按"两次独立运行"组织**：路径内像素回归 + 跨路径统计等价 + 补丁范围/依赖完整性审计；
   CI 两条路径均可用免费软件适配器跑，但 **WGSL 的管线级校验在无 GPU 的 CI 中不可得**（盲区须显式记录，本机真机 harness 为补充）。
