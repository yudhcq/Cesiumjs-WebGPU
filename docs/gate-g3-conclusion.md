# G-3 门禁结论：通道状态机正确性（H-3）

**Feature**: `001-webgpu-terrain-mvp` ｜ **任务**: tasks.md **T020 / T021** ｜ **门禁**: plan.md「实现前的验证门」G-3
**判定产物**: `experiments/gates/out/g3.json`（机器可判定）｜ **录制产物**: `experiments/gates/out/g3-trace.json`（T020）
**规范**: [experiments/gates/README.md](../experiments/gates/README.md)
**重跑命令**:

```text
node experiments/gates/g3-pass-trace/run.mjs                       # 录制（T020）+ 分区判定（T021）
node --test experiments/gates/g3-pass-trace/partition.test.mjs     # T021 单元测试（含阴性对照）
node tools/scripts/check-gate.mjs --gate g3                        # 判定器校验
```

---

## 1. 结论

**verdict = `pass`（23/23 检查项通过）**，`recordedAt` 见 `g3.json`。

### T020：单帧录制（上游原版 WebGL2，包装平台 API）

**83 个平台调用**被录制：**9 次绘制 / 8 次清除 / 3 次 blit（解析）/ 21 次 `bindFramebuffer` / 8 次 `viewport` / 0 次 `scissor`，
共 2290 个三角形，7 个渲染目标**。录制方式是包装 `WebGL2RenderingContext.prototype`（本门禁**未修改上游一行**，
也**未读取任何上游 `@private` 成员** —— 由 `tracer-uses-platform-apis-only` 检查项扫描录制代码机器断言）。
目标身份（颜色/深度附件、采样数）由同一批平台调用（`createFramebuffer`/`framebufferTexture2D`/
`framebufferRenderbuffer`/`renderbufferStorage[Multisample]`）建立的**影子登记表**推导。

场景：真实上游 `CesiumWidget` + 默认 `EllipsoidTerrainProvider`，`baseLayer:false`/`skyBox:false`/`skyAtmosphere:false`、
`scene3DOnly:true`、sun/moon 隐藏；相机对准 2°×2° 地表矩形；先跑 15 帧预热直到 `globe.tilesLoaded === true`，
再录制**恰好一帧**（`tracer.start()` → `widget.render()` → `tracer.stop()`，帧耗时 1.5 ms）。

### T021：派生式身份分区

派生式身份 = `(colorTargets, depthStencilTarget, sampleCount, viewport, scissorRect)`（**只用平台可见状态**；
`Pass`/`PassState`/程序/uniform/`RenderState` 不参与，与 research §5.2 一致）。该帧被分成 **9 个通道**：

| 通道 | 目标 | 性质 | clear | draw | 三角形 | 备注 |
|---|---|---|---|---|---|---|
| 0 | `default`（canvas） | 呈现目标 | 1 | 0 | 0 | 帧首清屏 |
| 1 | `fb-3`（renderbuffer 颜色 + 深度） | 离屏 | 2 | 0 | 0 | GlobeDepth 准备 |
| 2 | `fb-6`（2 张颜色纹理 + 深度） | 离屏 MRT | 1 | 0 | 0 | scene framebuffer（颜色 + id） |
| 3 | `fb-3` | 离屏 | 3 | **4** | **2280** | **地形瓦片绘制（同一通道内多瓦片）** |
| 4 | `fb-5`（1 张纹理） | 离屏 | 0 | 1 | 2 | 深度/颜色拷贝 |
| 5 | `fb-3` | 离屏 | 1 | 1 | 2 | |
| 6 | `fb-7`（2 张纹理） | 离屏 MRT | 0 | 1 | 2 | 后处理输入 |
| 7 | `fb-8`（1 张纹理） | 离屏 | 0 | 1 | 2 | |
| 8 | `default`（canvas） | **呈现目标** | 0 | 1 | 2 | **帧末落在呈现目标上** |

| # | 判据（T021） | 结论 | 证据 |
|---|---|---|---|
| a | 全部目标切换序列都被覆盖（含多采样解析的目标切换） | ✅ | 24 次目标切换（21 `bindFramebuffer` + 3 `blitFramebuffer`）；其中 20 次**实际改变**了绑定，**全部恰好落在通道边界上**（`atPassBoundary=true`）；另外 4 次是对当前目标的**冗余重绑定**（`changed=false`，不构成通道边界，单独计数）。3 次 blit 都是**跨目标**的解析（`fb-3 → fb-4`，即 `Scene.resolveFramebuffers` → `globeDepth.executeCopyColor`，Scene.js:4177-4180），全部在通道边界上 |
| b | 分区边界与 `clear`/`draw` 序列一一对应 | ✅ | 17 个 clear/draw 操作 → 9 个通道、8 个边界；每个边界都位于两个**身份不同**的连续工作操作之间，并且都有可记录的**状态变更作为依据**（目标切换 / viewport / enable / disable）；无空通道、无未归属操作。**不产生工作的状态变更不构成通道**（后端把通道开启推迟到首个绘制）——这正是 (c) 可实现的前提 |
| c | `endFrame` 前无未闭合通道 | ✅ | 最后一个通道（#8）落在**呈现目标** `default`（canvas）上，其后只有 2 次冗余重绑定与 `trace-stop`；每个更早的通道都被"下一个通道起始"关闭，因此 `endFrame` 只需关闭一个通道 |

**基线/环境**：Node v22.20.0；Playwright `channel=chrome`，HeadlessChrome **153.0.8010.36**，0 启动参数；
`WebGL 2.0 (OpenGL ES 3.0 Chromium)`，绘制缓冲 300×150，`MAX_SAMPLES=8`、`MAX_DRAW_BUFFERS=8`、`MAX_COLOR_ATTACHMENTS=8`，
`scene.msaaSupported=true`、`msaaSamples=4`、`depthTexture=true`、`logarithmicDepthBuffer=true`；
上游 `@cesium/engine` **26.3.0**；构建前后 `node_modules/@cesium/engine` 1891 文件逐字节未变。

### T021 单元测试（含阴性对照）

`partition.test.mjs` **8/8 全绿**：一个良构合成帧通过全部检查；四个**阴性对照**都被判定器捕获 ——
① 通道中途切走再切回（工作操作身份不变）→ `all-target-switches-covered` 判 fail；
② 帧末停在离屏目标 → `no-unclosed-pass-before-endframe` 判 fail；
③ 同一通道内 clear 出现在绘制之后 → `clears-are-first-in-their-pass` 判 fail；
④ 只有自我 blit（没有跨目标解析）→ `multisample-resolve-switch-covered` 判 fail。
另有合成用例证明 `sampleCount` 维度确实参与分区（`4 → 1` 的解析过渡被记录且构成边界）。
产物存在时，同一组断言会在**真实录制的 trace** 上重跑并与 `g3.json` 的通道数交叉校验。

## 2. 对 W2 的直接结论（research §5.1/§5.2 的实测依据）

1. **派生式身份足够**：上游帧内的每一次目标切换都必然伴随身份变化，因此后端无需向逻辑层索要任何通道提示（plan 的 G-3 失败动作**不必**触发）。
2. **`loadOp:"clear"` 的适用范围**：本帧中每个含 clear 的通道，**clear 都是该通道的首个工作操作**（`clears-are-first-in-their-pass` 通过）
   → research §5.1 的"首次操作走 `loadOp:"clear"`"是主路径；但 T021 的判据只保证"分区成立"，后端仍 MUST 保留 `clearBuffer` 兜底
   （合成对照 ③ 表明该情形可被检出，一旦出现即需要兜底）。
3. **冗余重绑定很常见**（24 次切换中 4 次）：后端 MUST 把"绑定到当前目标"当作 no-op，否则会产生空通道。
4. **同一通道内多瓦片绘制已被实测覆盖**：通道 #3 内 4 次绘制共 2280 个三角形（地形瓦片共用同一组目标）。
5. **`resolveFramebuffers` 的目标切换已覆盖**：3 次跨目标 blit；映射到 WebGPU 即 `colorAttachments[i].resolveTarget`
   （本帧采样数过渡为 `1 → 1`，见 §3 F-3）。

## 3. 实现发现与偏离（如实记录）

### F-1｜录制使用上游默认 `EllipsoidTerrainProvider`（零网络），真实瓦片数据集属 W5/T085
MVP 的固定地形数据集（T085）尚未落盘，门禁 MUST NOT 依赖网络。本门禁因此使用上游默认的 `EllipsoidTerrainProvider`：
它走**同一条** `Globe → QuadtreePrimitive → GlobeSurfaceTile → GlobeSurfaceShaderSet → GlobeVS/GlobeFS` 路径，
但瓦片树只有一层。**覆盖边界**：通道身份只由平台可见的五个字段决定，因此"同一目标的额外瓦片"只会落在同一通道内 ——
这一点已被实测支持（通道 #3 内 4 次绘制）。真实瓦片树的通道覆盖仍 SHOULD 在 T085 之后重跑本门禁（已列入 F-1 的 followUp）。

### F-2｜ESM 包不随附 `Assets/**` 与 `Workers/**`（两条工程事实，均已显式登记）
1. **Workers**：`@cesium/engine` 的 npm 包只随附 `Source/`，没有构建好的 `Workers/**`；而 `TaskProcessor` 用
   `new Worker(url, {type:"module"})` 加载 `CESIUM_BASE_URL + "Workers/<name>.js"`。门禁的解法：用**同一套 Rollup + CJS 互操作**
   把上游 `Source/Workers/{createVerticesFromHeightmap,incrementallyBuildTerrainPicker,transferTypedArrayTest}.js` 打成
   **模块 worker**，输出到门禁自己的 `experiments/gates/out/g3-base/Workers/**` 并据此设置 `CESIUM_BASE_URL`（上游磁盘零改动）。
   未构建的 worker 会让请求 404，`worker-requests-all-served` 检查项会**硬失败**（不静默降级地形路径）。
2. **Assets**：包内同样没有 `Assets/**`，因此 `Assets/Images/ion-credit.png`、`Assets/approximateTerrainHeights.json`、
   `Assets/IAU2006_XYS/IAU2006_XYS_18.json` 三个 URL 在任何浏览器运行中都会 404（本帧 3 次）。
   门禁的处置：`no-unexpected-http-errors` / `no-uncaught-page-errors` / `no-console-errors` 以**显式白名单**
   （仅这三个上游资产路径）容忍这 3 次 404 —— 白名单外的任何 HTTP 错误、任何其它未捕获异常一律**硬失败**。
   这三个资产与本帧的渲染路径无关（无影像、无 GroundPrimitive、sun/moon 已隐藏），Cesium 自身也将其视为非致命。

### F-3｜本帧没有多采样离屏帧缓冲（采样数过渡为 1→1）
`scene.msaaSupported=true`、`msaaSamples=4`，但本帧中所有离屏帧缓冲的附件都是**单采样**（`renderbufferStorage`，
无 `renderbufferStorageMultisample`），因此 3 次解析 blit 的采样数过渡都是 `1 → 1`（解析/拷贝而非降采样）。
**处置**：门禁断言"存在**跨目标**的解析切换"（T020/T021 的要求）并把采样数过渡逐条记录；`sampleCount` 作为身份维度
由合成单元用例（`4 → 1`）单独验证。**MUST 在切片 B / T098b 重跑本门禁**，届时若启用多采样离屏目标，采样数过渡会出现在证据里。

### 实现偏离（与 tasks.md 描述的关系，均不改需求）

| ID | 偏离 | 处理 |
|---|---|---|
| D-1 | T020 的通过判据以"地形（terrain）"为对象，而可用的地形数据集尚未落盘（T085） | 使用上游默认 `EllipsoidTerrainProvider`（零网络、确定性），覆盖边界与重跑义务记入 F-1；不修改 tasks/plan |
| D-2 | T020 明确"MUST NOT 修改上游实现" | 本门禁的构建**不应用替换清单**（不使用 T008 别名插件），bundle 内是上游原版 `Context`/`Scene`（`g3-build.json` 逐项断言）；`entry.js` 里没有门禁本地 `Renderer/**` 替换 |
| D-3 | T020 要求"通过包装平台 API 采集" | 采用 `WebGL2RenderingContext.prototype` 包装 + 影子目标登记表；`tracer-uses-platform-apis-only` 扫描录制代码，禁止上游 `@private` 风格访问 |
| D-4 | T021 要求"分区边界与 clear/draw 序列一一对应" | 通道按**工作操作**（clear/draw）的身份连续段定义，而非按状态变更定义 —— 这样不产生工作的状态变更不会制造空通道（对应后端"首个绘制才开启通道"）。阴性对照 ①③ 证明该定义仍能失败 |

## 4. 对后续任务的影响

1. **G-3 通过 ⇒ H-3 成立**：派生式通道划分覆盖上游 `Scene` 的全部目标切换序列（含 `resolveFramebuffers`），
   **无需**触发 G-3 的失败动作（在后端层引入显式通道提示或 `endFrame` 前强制拆通道）。Phase 4 的 T044/T046 可按 plan 推进。
2. **T046 可直接以 `out/g3-trace.json` 做录制-回放**：trace 是 83 条平台调用的完整序列，含目标切换、冗余重绑定、
   解析 blit、每通道的 clear/draw 顺序，正是 T046 自检所需的输入。
3. **T044 的两条实测约束**：① 首个工作操作前不得开启通道（否则产生空通道）；② 绑定到当前目标必须视为 no-op。
4. **T048 的管线缓存键**需覆盖本帧出现的 7 个目标形态（颜色附件数 1–2、有无深度附件、采样数 1）。
5. 本门禁**不覆盖**：我们的后端实现本身（G-3 只刻画上游原始路径）、跨后端像素一致性（G-6）、CI 两路径可运行性（G-7）。
