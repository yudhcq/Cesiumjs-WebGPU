# G-5 门禁结论：着色器编译前端（H-5 / H-6）

**Feature**: `001-webgpu-terrain-mvp` ｜ **任务**: tasks.md **T022–T024** ｜ **门禁**: plan.md「实现前的验证门」G-5
**判定产物**: `experiments/gates/out/g5.json`（机器可判定）｜ **规范**: [experiments/gates/README.md](../experiments/gates/README.md)
**重跑命令**:

```text
node experiments/gates/g5-shader/run.mjs                                  # 门禁本体（Node 侧 + 真机两半）
node experiments/gates/g5-shader/run.mjs --skip-device                    # 仅 Node 侧（无 GPU 环境）
node tools/shader-verify.mjs --family=globe --variants=mvp                # T022 harness（黄金配置）
node tools/shader-verify.mjs --family=globe --variants=all-reachable      # T023 harness（全枚举）
node tools/scripts/check-arch-boundaries.mjs --rules A9                   # T024
node tools/scripts/check-gate.mjs --gate g5                               # 判定器校验
```

---

## 1. 结论

**verdict = `pass`（22/22 检查项通过）**，`recordedAt` 见 `g5.json`。

plan 对 G-5 的命题是：**把 `ShaderSource`/`ShaderBuilder` 参数化以输出 WGSL，而 GLSL 视图与预处理语义不变**（`contracts/fork-patch-layer.md` R1）。本门禁把它拆成四条可证伪的断言，全部成立：

| # | 断言 | 结论 | 证据（值 / 路径） |
|---|---|---|---|
| a | **GLSL 视图逐字节不变** | ✅ | 枚举的 **768/768** 个 define 组合，经参数化接缝产出的 GLSL 与上游 `ShaderSource` 逐字节相同（`g5.json` → `measurements.glslByteIdentity`；接缝的两个 GLSL 入口**按引用委托**给上游原型，`emit` 默认 `"glsl"`） |
| b | **条件编译求值自建并正确** | ✅ | 上游只把 `#define/#ifdef` **写成文本**交给 GL 驱动（`ShaderSource.js:250-258`）；本层自建求值器，8/8 探针通过（`#if TEXTURE_UNITS > 0`、`defined()` 与 `&&`/`\|\|` 优先级、`#elif` 链、嵌套、算术条件、未定义标识符为 0），未终止的 `#if` 报诊断而非静默错判，普通文本中的对象宏替换生效 |
| c | **varying 成对推导自建并正确** | ✅ | 从**拼装后的真实 GLSL** 的「写点 ∩ 读点」推导（含 `out` 形参写入：`computeAtmosphereScattering(vec3, vec3, out vec3, out vec3, out float)`）。`ENABLE_DAYNIGHT_SHADING` 下 `v_normalMC/v_normalEC` **被声明但从不写入**（正是尖刺 E1 的陷阱：GL 会裁掉、WGSL 会硬失败），配对集合为 `v_positionMC@0 v_textureCoordinates@2`；切到 `ENABLE_VERTEX_LIGHTING` 时 `v_normalEC@4` 变为活跃 |
| d | **全枚举真机管线有效** | ✅ | **768 个 define 组合 → 128 个互异模块文本 × 各自的 pipeline-overridable constant 取值 → 768/768 条管线在硬件适配器上 `createShaderModule` + `createRenderPipeline` 0 校验错误**；`createShaderModule` 恰好 **256** 次（= 2×128，每个文本只解析一次）。**2026-09-19 G-6 修复轮更新**：`TEXTURE_UNITS` 与 `PER_FRAGMENT_GROUND_ATMOSPHERE` 已改为管线常量（不再进模块文本），且模块只发射入口点可达的声明（`g5-shader/wgsl-prune.mjs`，模块对 48 kB → 13 kB）；两项改动后重跑本门禁 **23/23 通过**（`artifacts/shader-verify/globe-all-reachable.json`、`globe-mvp.json`） |

**阴性对照（G-5 的判定器非空转）**：

1. 故意删掉 VS 的 `v_positionMC` 输出、保留 FS 的读取 → 真机报
   `The fragment input at location 0 doesn't have a corresponding vertex output.`
   —— **与尖刺 §4 E1 逐字同因**，证明 varying 断言确实能失败；
2. 故意删掉 `uncovered-define-sets-fail-explicitly-not-silently` 的判据 → 门禁自己抓到发射器把
   G-4 登记的 out-of-scope define（如 `APPLY_MATERIAL`）当作"支持"而**静默发射**（见 §4 F-2）；
3. harness 自检：全屏常数三角 MUST 得到非黑帧（否则"地形帧是黑的"什么也证明不了），实测 16384/16384；
   另用**常数色片元阶段 + 发射的顶点阶段**分离"几何/布局"与"带纹理的片元阶段"。

**T022 黄金配置真机回读**（`artifacts/shader-verify/globe-mvp.json`）：0 编译消息、`createRenderPipeline` 成功、
**16384/16384 非黑像素**、12815 个不同颜色，四角取到 4×4 影像的四个不同纹素
（`topLeft=[222,182,76]`、`topRight=[223,183,179]`、`bottomLeft=[105,65,64]`、`bottomRight=[105,65,191]`）
—— 与尖刺 path B 的结论（0 报错 + 回读非黑 + 四角取到四个纹素色）在同一量级上复现。

**上游磁盘零改动**：`node_modules/@cesium/engine` 1891 个文件 / 21 761 878 字节，门禁前后聚合哈希一致
（`sha256-35a5dbbb1c5f964c9ef122762fd2a3e97b9aebfdbff0c6c78aa136b1a1124033`），与 G-1 记录的值相同。

---

## 2. MVP 可达 define 空间（T023 的枚举口径）

枚举**不是抽样**，而是 9 个维度的完整笛卡尔积，每个维度的取值与被排除的取值**都带上游行号**（`experiments/gates/g5-shader/define-matrix.mjs`）：

```
TEXTURE_UNITS(4) × quantization(2) × lighting(2) × groundAtmosphere(3) × fog(2)
  × ocean(1) × imageryOps(2) × tileLimitRectangle(1) × geodetic(4) = 768
```

被排除取值的依据（摘要，完整表在源码里）：`ocean` 塌缩为 `none`
（`hasWaterMask = tileProvider.hasWaterMask && defined(waterMaskTexture)`，`GlobeSurfaceTileProvider.js:102,2571`）；
`tileLimitRectangle` 塌缩（MVP 场景不设 cartographic limit rectangle）；
`imageryOps` 只留 `{none, alpha}`（其余来自 `ImageryLayer` 的色相/饱和度/亮度设置，MVP API 不暴露）；
`lighting` 去掉 `none`（`plan.md:269` 固定 `globe.enableLighting=true`）。
被排除的是**配置**，不是发射器的能力——`define-matrix.mjs` 的 `EXCLUDED_DEFINES` 另有 20 项逐条理由。

**覆盖方式**：768 个组合**逐条**发射并做配对推导；真机对 **768 个组合逐个**建管线（各自带自己的管线常量取值），模块文本按**逐字节同一性**去重后只解析 **128** 次；
组合→模块文本→管线身份是 `g5-model.json` 里的**逐字节同一性**映射，因此"每个可达组合都对应一个已验证管线"是精确结论而非外推。
（本门禁最初按 13824 个组合设计，实测互异产物与组合数一一对应，规模不可控，故按可达性收敛到 768；
收敛过程与理由见 `docs/gate-g6-conclusion.md` §5 D-4。）

**统一 uniform 结构**：跨全部 768 变体取并集 = **54 个 uniform → 53 个 struct 成员 + 3 个 sampler 绑定**（`structSize = 1248` 字节，
2026-09-19 起为合规保守布局：紧凑标量数组加宽为 `array<vec4<T>,N>`，见 `docs/gate-g4-conclusion.md` §5 R-1），
`structSize` 由 H-4 的布局生成器产出（G-4 已真机验证过该生成器）。
`--variants=mvp` 走的"边际扫描"并集与全笛卡尔积并集**逐个 uniform 相同**（门禁内的
`uniform-union-of-the-marginal-sweep-equals-the-full-cross-product` 断言这一点，防止快捷路径悄悄少覆盖）。

---

## 3. 自建的三个必需件（上游没有的）

| 件 | 为什么必须自建 | 交付物 |
|---|---|---|
| **条件编译求值** | 上游把 `#define/#ifdef` 当文本写进 shader，由 GL 驱动求值（`ShaderSource.js:250-258`）；WebGPU 侧没有驱动代劳 | `glsl-preprocess.mjs`：完整表达式文法（`defined()`、`&&`/`\|\|`/`!`、括号、比较、算术、位运算、`?:`）+ C 整数语义 + 对象宏替换 + 未支持构造的诊断 |
| **varying 成对推导** | GLSL 按名字匹配且链接器会裁掉未用 varying；WGSL 按 `@location` 匹配且**片元输入无对应顶点输出即硬失败** | `varying-pairing.mjs`：声明 + 赋值点 + `out`/`inout` 形参写入点分析、共享 location 表、未配对/类型不匹配显式报告 |
| **运行时生成片段的镜像** | `computeDayColor()` 与 `getPosition()`/`get2DYPositionFraction()` **磁盘上不存在**，由 `GlobeSurfaceShaderSet.js:419-475` 在运行时拼字符串 | `mirror-generators.mjs`：GLSL 与 WGSL **两个通道由同一个模块生成**，参数（`TEXTURE_UNITS`、`APPLY_*`、场景模式）同源，不可能各自漂移 |

此外 `wgsl/` 下是地形闭包的 WGSL 库（prelude + VS + FS 库 + FS 入口），
每个 `czm_` 内建都是上游 `Source/Shaders/Builtin/**` 的 1:1 移植，WGSL 强制的表达差异逐条登记
（重载拆名、`atan2`、无结构体常量改 `valid` 标志、`textureSampleLevel(...,0.0)` 的 uniformity 约束、
`gl_FragCoord` 显式传参、GLSL `bool` uniform → `u32`、`.st`/`.pq` 无对应 swizzle 改辅助函数）。

---

## 4. 实现发现（真机抓到的真实缺陷，逐条留证）

| ID | 现象 | 根因 | 处理 |
|---|---|---|---|
| F-1 | VS 模块报 `unresolved call target 'computeAtmosphereScattering'`（64 个组合失败） | 大气散射函数被放在**片元专用**库里，而 `GlobeVS.glsl:212-235` 在 `GROUND_ATMOSPHERE && !PER_FRAGMENT_GROUND_ATMOSPHERE` 时也会调用它 | 移入共享 prelude；**真机是唯一的 oracle**——Node 侧静态检查不会发现跨阶段缺函数 |
| F-2 | 门禁自己的检查抓到发射器把 `APPLY_MATERIAL` 等 out-of-scope define 当作"支持"并**静默发射** | `SUPPORTED_DEFINES` 忘了减掉 `EXCLUDED_DEFINES`（`DEFINE_DESTINATION` 表里它们有目的地登记） | 从支持集合中排除 → 未覆盖组合一律显式失败（T023 (c)） |
| F-3 | 顶点管线校验失败：`Attribute offset (32) + format size (12) <= arrayStride (32)` | `geodeticSurfaceNormal` 是门禁分配的 location（不属 `TerrainEncoding`），偏移落在 stride 之外 | `attributeLayoutFromDerivation` 让 stride 覆盖全部属性（该配置下 48 字节） |
| F-4 | 黄金配置首帧全黑 | 相机/模型矩阵把 RTC 坐标当作世界坐标（缺 `u_center3D` 平移），且场景相机太远、地形片只占 8.7% 画面 | 加 `mat4FromTranslation` 模型矩阵；相机移到 6 km 且略向北倾斜，使面片覆盖整帧（"非黑像素占满"才有意义） |
| F-5 | 黄金配置帧为单一颜色 | **数组 uniform 写入错误**：union 布局把 `u_dayTexture*` 数组按最大变体（3）定长，而场景只给了一个 vec4 → 逐元素写入取到标量 0，`step()` 把 alpha 判成 0 | 场景为数组 uniform 显式给出逐元素值（`elements`），并加断言"struct 每个成员都有场景值" |
| F-6 | WGSL 文本里同时出现 `#ifdef` 两个分支（`redeclaration of …`） | 发射器用了预处理结果的 `text`（**未过滤**的全文）而非 `activeText` | 改用 `activeText`；注释说明为什么不能用 `text` |
| F-7 | 上游拼装 GLSL 在 WebGL2 里链接失败：`Function getPosition() … is undefined` | `getPosition`/`get2DYPositionFraction` 由 `GlobeSurfaceShaderSet.js:474-475` 在运行时 push，`assembleGlslForVariant` 最初漏了 | 补 `emitGetPositionGlsl`（G-6 的 WebGL2 基线因此才可能建立） |

F-1/F-3/F-4/F-5 全部是**只有真机能抓到**的问题类别，与 plan 的 H-5 风险描述一致
（"WebGPU 校验错误只在运行时暴露"）。

---

## 5. 边界（本门禁**不**主张的事）

1. **像素保真度**：除黄金配置外，其余 767 个变体只主张"管线有效 + varying 成对 + uniform 布局覆盖"，
   **不主张渲染结果正确**（那是 G-6/T026 的像素 diff 的范围，且只在黄金配置上与 WebGL2 逐像素比对）。
2. **BITS12 量化**不做像素用例：需要复刻 `TerrainEncoding` 的量化打包器（`toScaledENU` +
   `AttributeCompression.compressTextureCoordinates`），属**夹具**而非发射器问题；该变体仍由 768 组合的
   真机管线覆盖（G-5），并在 G-6 的枚举里占一半组合。
3. **非地形族**（Model/Voxels/GaussianSplat/后处理/阴影等）不覆盖：`--family` 只接受 `globe`，
   其它值**显式报错**而不是静默通过（`shader-verify.mjs` 的参数校验）。
4. **逻辑层可见性**由 A9 静态断言 + `_attributeLocations` 保留要求覆盖（T024，A9 扫描 0 违规）；
   但 Phase 3 尚未落地 `backend-webgpu/**`，因此 A9 当前的 `patchLayerFiles = 0`
   —— 这正是"在尖刺产物上先跑一次作为基线"的含义（`g5-arch-boundaries.json`）。

---

## 6. 环境（写入 `g5.json.environment`）

| 项 | 值 |
|---|---|
| Node | v22.20.0（win32 x64） |
| 浏览器 | Playwright `channel=chrome`，HeadlessChrome **153.0.8010.36**，启动参数 **0 个** |
| WebGPU 适配器 | `adapter.info = {vendor:"nvidia", architecture:"lovelace", subgroupMinSize:32, subgroupMaxSize:32}`，`preferredFormat="bgra8unorm"` |
| 设备限制 | `maxTextureDimension2D=8192`、`maxUniformBufferBindingSize=65536`、`maxBindGroups=4`、`maxVertexAttributes=16` |
| 上游 | `@cesium/engine` **26.3.0**；门禁前后聚合哈希一致 |

---

## 7. 对后续任务的影响

1. **H-5 关闭**：`ShaderSource` 的"换发射目标"路线在真机上成立，且 GLSL 视图逐字节不变 →
   Phase 3 的 T037 可以按 `contracts/fork-patch-layer.md` R1 落地 `ShaderSource.js` 的 `kind:"adapt-shader"` 条目，
   改动面就是本门禁验证过的那两处（新增 `emit` 通道 + 导出装配所需内部件）。
2. **T022 的 harness 可直接复用**：`tools/shader-verify.mjs` 是**产品化**脚本（不是门禁私有脚本），
   T108/T118 的着色器校验作业与 T079 的 `bench:shader-variants` 都能直接调用；新增语言族时
   `--family` 必须显式失败，不得静默跳过。
3. **给 T079/G-6 的输入**：768 个组合 → **128** 个互异模块文本（× 各自的管线常量取值 = 768 条管线身份）；uniform 并集 54 项 / 53 成员 / 3 sampler 绑定。
4. **CI 盲区照旧**：无 GPU 时只能做 naga 模块级校验，varying 契约与绑定布局**只在真机暴露**
   （本门禁的 F-1/F-3 就是实例）→ 按 FR-023 写入 `docs/ci-degradation.md`（T028）。
5. 本门禁**不覆盖**：变体规模与编译缓存的预算判定、与 WebGL2 基线的像素/数值 diff（G-6/T025–T027），
   以及任何非地形着色器族。
