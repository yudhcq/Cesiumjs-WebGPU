# G-4 门禁结论：uniform 布局一致性（H-4）

**Feature**: `001-webgpu-terrain-mvp` ｜ **任务**: tasks.md **T018 / T019** ｜ **门禁**: plan.md「实现前的验证门」G-4
**判定产物**: `experiments/gates/out/g4.json`（机器可判定）｜ **规范**: [experiments/gates/README.md](../experiments/gates/README.md)
**重跑命令**:

```text
node experiments/gates/g4-uniform-layout/run.mjs                        # 生成 + 单元交叉校验 + 真机断言 + 阴性对照 + 判定
node experiments/gates/g4-uniform-layout/run.mjs --skip-gpu             # 只做生成（无 GPU 环境）
node --test experiments/gates/g4-uniform-layout/layout.test.mjs         # T019(a) 单元交叉校验
node experiments/gates/g4-uniform-layout/run-gpu.mjs                    # T019(b) 真机像素断言
node experiments/gates/g4-uniform-layout/run-gpu.mjs --control=shift-offsets   # 阴性对照
node tools/scripts/check-gate.mjs --gate g4                             # 判定器校验
```

---

## 1. 结论

**verdict = `pass`（21/21 检查项通过）**，`recordedAt` 见 `g4.json`。

| # | 判据（plan / T018 / T019） | 结论 | 证据 |
|---|---|---|---|
| a | 布局由「**拼装后的真实 GLSL** 实际引用的 uniform 名集合」生成 | ✅ | 13 个 MVP define 变体全部由**上游 `ShaderSource`** 装配（源 = `[AtmosphereCommon, GroundAtmosphere, GlobeVS/GlobeFS]`，与 `Globe.js:679-687` 一致；define 逐条来自 `GlobeSurfaceShaderSet.js:278-377`），装配后按变体 define 求值 `#ifdef/#if/#else` 再取被引用的 uniform：默认配置 **52 个数值 uniform + 2 个 sampler**，矩阵并集 **61 个 uniform → 58 个 struct 成员 + 5 个 sampler 绑定**（`g4-layout.json`、`g4-glsl-variants.json`） |
| b | 逐字段偏移表（`byteOffset`/`byteSize`/`arrayStride`） | ✅ | `g4.json → measurements.defaultFieldTable`（默认配置 52 字段）+ `g4-layout.json`（并集 58 字段，含 `sizesByVariant`）；struct 大小 1120 B（默认）/ 1248 B（并集），逐段 padding 明细在 `unionConfig.padding` |
| c | 含 `mat3` 列填充、数组元素对齐、`vec3`→16 对齐、`size 9` 的 `czm_sphericalHarmonicCoefficients` | ✅ | `mat3`：`czm_normal3D` size **48**、`columnStride` **16**、16 字节对齐；`vec3`：12 字节 / 对齐 16（并集内 11 个）；数组：**元素 stride 一律 16、成员偏移一律 16 对齐**——紧凑元素（`array<f32,N>`/`array<u32,N>`/`array<vec2,N>`）**加宽为 `array<vec4<T>, N>`**（WGSL 的 stride 由元素类型决定、无 stride 属性，合规做法就是改元素类型），共 4 处（见 §3 第 3 行与 §5 R-1）；`size 9`：`array<vec3<f32>, 9>`、stride 16、**144 字节**，在**真实引用它的上游着色器**（`Shaders/Model/ImageBasedLightingStageFS.js`）上装配验证 |
| d | T019(a) 单元交叉校验「生成布局 ↔ WGSL 结构逐字段一致」 | ✅ | `layout.test.mjs` **9/9 全绿**：独立解析生成的 WGSL 文本、按 WGSL 规则**重新计算**偏移，与 CPU 表逐字段（`byteOffset`/`byteSize`/`align`/`arrayStride`/`columnStride`）及 struct 大小比对，`problems=[]` |
| e | T019(b) 真机断言「地形全部 uniform 生效」 | ✅ | 真机（Chrome 153 + nvidia/lovelace）：生成 WGSL **0 编译错误 / 0 管线校验错误**；按 CPU 布局表写入已知值 → 回读 **384/384 分量全部相等（0 mismatch）**；同计划重渲染 → **0 个 slot 变化**（对照）；**58/58 逐成员扰动**都只改变该成员自己的 slot（`g4-gpu.json`） |
| f | 阴性对照（判定器非空转） | ✅ | 见 §2 |

**真机环境**：Playwright `channel=chrome`、HeadlessChrome **153.0.8010.36**、0 启动参数、
`adapter.info={vendor:"nvidia",architecture:"lovelace"}`、`preferredFormat="bgra8unorm"`、
`maxUniformBufferBindingSize=65536`、`maxBindingsPerBindGroup=1000`。渲染目标 `rgba8unorm`（96×1 像素 = 96 个 uniform slot），
每个像素回读 4 个分量，共 384 个断言点。

**验证方式（与尖刺手法的关系）**：T019 要求复用尖刺的「identity 矩阵 + 已知纹素回读」。本门禁保留该手法（真机 pipeline + 已知纹素回读），
并把范围从一个 identity 矩阵**扩展为全部 uniform**：每个 (成员, 数组元素, 矩阵列) 占一个像素，值由 Node 侧按 CPU 布局表生成的**字节写计划**写入
（浏览器端不重新推导任何偏移）；再做**逐成员扰动矩阵**（改动某成员只允许改变该成员的 slot）。这既覆盖了「全部 uniform 生效」，也能逐字段定位错误。

## 2. 阴性对照（本结论可信的前提）

`node experiments/gates/g4-uniform-layout/run-gpu.mjs --control=shift-offsets` 用**同一套断言、同一个页面、同一个生成程序**，
但把 CPU 布局表中首成员（`czm_currentFrustum`）的标量偏移**故意后移 4 字节**，同时保留未污染版本的期望值：

| 检查项 | 结论 |
|---|---|
| `control-detects-shifted-byte-offset` | ✅ 真机回读与 CPU 期望**不一致**（2 个分量：期望 `[1,38]`、实测 `[0,1]`） |
| `control-localises-the-error-to-the-shifted-member` | ✅ 不一致的 slot **恰好是该成员的 slot**（`[0]`），说明回读比对能定位到具体字段，而不是整体失败 |
| `control-render-is-deterministic` | ✅ 同一（被污染的）计划重写两次 → 0 个 slot 变化（比对本身不抖动） |
| `control-probe-ran` | ✅ 同一份生成 WGSL 编译 0 错误 |

即：判定器**能够区分「布局正确」与「偏移写错」**。该对照的结论以检查项 `gpu-negative-control-detects-shifted-layout` 进入 `g4.json`；
对照产物：`experiments/gates/out/g4-control-shift.json`、`experiments/gates/out/g4-control-shift-input.json`。

## 3. 真机断言抓到的三个错误假设（本门禁价值的直接证据）

生成器最初按"教科书式"的 uniform 规则实现，三处都被真机读数推翻；**这正是 H-4 的风险所在**：

| # | 错误假设 | 真机实测 | 现状 |
|---|---|---|---|
| 1 | `vec3<f32>` 在 uniform 地址空间按 12 字节对齐 | 实测按 **16** 字节对齐（否则后续字段全部偏移 4 字节） | 已修正为 16，并由 `layout.test.mjs` + 真机双边锁定 |
| 2 | 数组自身按其元素对齐，但**成员偏移**需向 16 取整 | 实测数组自身只按其元素对齐（如 `array<f32,2>` 放在 4 字节对齐位置） | 已修正（数组 align = 元素 align） |
| 3 | 数组元素 stride 一律 16 字节 | 实测首轮：`array<f32,2>` 的 stride = **4**（`roundUp(SizeOf, AlignOf)`），且成员落在 4 字节对齐偏移（748 = 16×46+12）也被接受 | **已改为合规保守布局（2026-09-19）**：见 §5 R-1 —— 规范要求 uniform 地址空间的元素 stride 为 16 的倍数，紧凑元素一律加宽为 `array<vec4<T>, N>`；重跑 G-4 真机 21/21 通过 |

## 4. 覆盖的 define 矩阵（13 个变体）

| 变体 | 引用 uniform 数 | 变体 | 引用 uniform 数 |
|---|---|---|---|
| `default-1-texture`（MVP 默认） | 54 | `vertex-lighting` | 53 |
| `texture-units-0` | 47 | `daynight-shading` | 51 |
| `texture-units-2` | 54 | `no-fog-no-atmosphere` | 48 |
| `texture-units-3` | 54 | `per-fragment-atmosphere` | 51 |
| `no-quantization` | 49 | `apply-alpha`（imagery alpha/brightness/contrast） | 51 |
| `ocean-waves` | 55 | `geodetic-normals-exaggeration` | 49 |
| | | `scene2d`（无 web-mercator 定义） | 51 |

明确**排除**且在 artefact 中逐条记录的 define（`excludedDefines`）：`APPLY_MATERIAL`（MVP 无材质）、`HAS_VECTOR_LAYER`、
`ENABLE_CLIPPING_PLANES/POLYGONS`、`APPLY_IMAGERY_CUTOUT`、`HIGHLIGHT_FILL_TILE`、`COLOR_CORRECT`、
`DYNAMIC_ATMOSPHERE_LIGHTING`、`UNDERGROUND_COLOR`、`TRANSLUCENT`（均属 Out of Scope 或 MVP 不可达）。

## 5. 风险与实现发现（如实记录）

### R-1｜紧凑标量数组的元素 stride（**已按合规保守布局修复并重跑**，2026-09-19）
`array<f32, N>` / `array<bool→u32, N>` 的**紧凑布局**（stride = 4，成员偏移仅 4 字节对齐，实测命中 `u_dayTextureAlpha[2]`@748、
`u_dayTextureBrightness[2]`、`u_dayTextureContrast[2]`、`u_dayTextureUseWebMercatorT[3]` 四处）**不是规范默认允许的布局**：
W3C WGSL（2026-09-15 CR 草案）§"Address Space Layout Constraints" 要求 uniform 地址空间的元素 stride 满足
`StrideOf(array<T,N>) = 16 × k'`，且 `RequiredAlignOf(array<T,N>, uniform) = roundUp(16, AlignOf(T))`；该布局只有在实现声明
`uniform_buffer_standard_layout` 语言扩展时才合法（放宽条款：gpuweb PR #5347 / issue #4973，2025-10-24）。
**本机 Chrome 153 确实声明了该扩展**（`GPU.wgslLanguageFeatures` 含 `uniform_buffer_standard_layout`，记录在 `g6-variants.json` 的
`environment.wgslLanguageFeatures`）—— 这正是首轮"4 字节布局能通过真机断言"的原因，也说明**当时的 pass 依赖实现宽松，而不是布局合规**。

**修复**：WGSL 的数组 stride 由元素类型决定且没有 stride 属性，因此唯一的合规做法是**改元素类型**（规范给出的补救即如此）：
紧凑元素一律发射为 `array<vec4<T>, N>`（align/size 16 → stride 16），数组成员偏移向 16 取整，CPU 侧写入器只写每个元素的前
`components` 个 lane，`wgsl-emitter` 的读取后缀（`.x`/`.xy`）由布局表推导。struct 大小 1120 → **1344 字节**（并集布局），代价可接受。

**重跑结果**：保守布局下真机 **21/21 通过**（`g4.json`：逐字段偏移表、`array-element-stride-16`、
`packed-arrays-widened-to-a-conforming-element`、逐 slot 回读 384/384、58/58 逐成员扰动、阴性对照）。**有效性问题**：
**首轮 G-4 的 `pass` 只对"4 字节紧凑布局"有效，MUST NOT 被当作保守布局的证据**；本节的 21/21 才是保守布局的有效 pass。
**逐目标实现重跑义务（MUST）**：每个浏览器/驱动/Tint 版本都要重跑本门禁（plan.md 的 R-1 行；承接 `tasks.md` T149）。

### F-1｜`size 9` 的 `czm_sphericalHarmonicCoefficients` 不在**地形**着色器里
地形路径（GlobeVS/GlobeFS）不引用它；它被 `Shaders/Model/ImageBasedLightingStageFS.js`（glTF image-based lighting）引用。
门禁**不虚构 uniform**，改用该真实上游着色器经同一 `ShaderSource` 装配后验证 size 9（`array<vec3<f32>,9>`、stride 16、144 字节）。

### F-2｜sampler 不能进 uniform struct
GLSL 的 `sampler2D`（含 `u_dayTextures[TEXTURE_UNITS]`）不出现在 struct 中，而按元素展开为独立的 texture+sampler 绑定
（固定长度纹理数组需 `binding_array`，未作为核心保证）：并集共 5 个纹理绑定（`u_dayTextures_0..2`、`u_oceanNormalMap`、`u_waterMask`）
+ 5 个 sampler 绑定 + 1 个 uniform buffer = 11 个 binding。

### F-3｜`bool` 在 uniform 地址空间不可用
`Shaders/GlobeFS.js` 真的声明了 `uniform bool u_dayTextureUseWebMercatorT[TEXTURE_UNITS];` → 生成器映射为 `u32`/`array<u32, N>`
并记录（uniform 地址空间不允许 bool；WGSL 侧读取需 `!= 0u`）。

### F-4｜验证程序的边界
真机上编译/回读的 WGSL 是**生成器为验证目的发射的**（struct + 逐 slot switch），不是地形着色器的 WGSL 移植产物（后者属 G-5/T022–T024）。
因此本门禁的结论边界是：**布局生成器与 WGSL 结构逐字段一致，且每个字段在真机上确实按该偏移被读取**；不主张着色器发射正确。

### 实现偏离（与 tasks.md 描述的关系，均不改需求）

| ID | 偏离 | 处理 |
|---|---|---|
| D-1 | T018 提到「默认配置 **92** 个声明」，实测上游 `AutomaticUniforms` 声明 **93** 个 | 以实测为准（`automaticUniformCount=93`），记入 artefact 与 measurements；不修改 research/tasks |
| D-2 | T018 把 `size 9` 的 `czm_sphericalHarmonicCoefficients` 列为地形必覆盖用例，但地形着色器不引用它 | 见 F-1：改用真实引用它的上游着色器验证，而不是编造字段 |
| D-3 | 不同 `TEXTURE_UNITS` 下同名数组长度不同 | 同时产出「默认配置逐字段表」与「矩阵并集布局」（数组长度取矩阵最大），`sizesByVariant` 逐条记录 |
| D-4 | `sampler2D x[N]` 无法作为固定长度纹理数组核心保证 | 见 F-2：按元素展开为独立 binding |
| D-5 | T019(b) 的「identity 矩阵 + 已知纹素回读」 | 见 §1 末段：手法保留、范围扩展到全部 uniform 并加扰动矩阵（更强而非更弱） |

## 6. 对后续任务的影响

1. **G-4 通过 ⇒ H-4 成立**：由真实 GLSL 生成的布局与 WGSL 结构逐字段一致，并在真机上逐字段验证；
   **无需**触发 G-4 的失败动作（退化为「每标量一个 vec4 槽」的保守布局）。
2. **T044/T046/T048 可直接消费 `uniform-layout.mjs`**：`layoutUniforms()` 产出的表即 CPU 侧暂存缓冲的写入契约，
   `emitVerificationWgsl()` 展示了如何从同一张表发射 WGSL；`slotPlan` 给出了「每个字段/元素/列」的可寻址分解。
3. **T045 的绑定布局**：sampler 展开规则（每个 sampler 占 2 个 binding）与 buffer binding 0 的约定需与 `bind-layout`（T037 的 `webgpu/bind-layout`）一致。
4. **风险 R-1 的处置义务**：G-4 必须在每个目标实现上重跑；若目标实现强制 16 字节数组 stride，则按 plan 的失败动作切换到保守布局，并重新派发本门禁。
5. 本门禁**不覆盖**：着色器编译前端（G-5）、通道状态机（G-3）、设备交接（G-2）、变体规模与像素一致性（G-6）、CI 两路径可运行性（G-7）。
