# Spike 报告：CesiumJS 1.145.0 GLSL → WGSL 可行性（实测）

- **日期**：2026-09-18
- **上游基线**：`cesium@1.145.0` / `@cesium/engine@26.3.0`（npm），仓库 `E:\work\CesiumjsWebGpu` HEAD `05e5bbc`
- **环境**：Windows，Node v22.20.0 / npm 10.9.3，pwsh 7.6.6，Chrome 153.0.8010.36（`--headless=new`，**无任何 WebGPU 开关**），GPU = NVIDIA `lovelace`（RTX 4080 SUPER）
- **纪律**：每条结论都对应本目录下的一条实际命令与原始输出（`logs/`）。未实测的内容一律标注"未验证"。
- **工具链位置**：`%TEMP%\shader-spike`（**仓库根未创建 `package.json`，未在仓库根 install**；`git status` 仅新增 `experiments/shader-spike/`）

---

## 0. 结论速览（TL;DR）

| 路径 | 实测结果 | 判定 |
|---|---|---|
| **A. glslang → SPIR-V → naga → WGSL**（离线） | 原始 GLSL **6/6 全部失败**；经 5 类机械修补后 **3/3 顶点着色器成功产出 WGSL 并被真机 GPU 接受（0 报错）**；**2/2 片元着色器在 naga 30.0.1 内部崩溃**（`invalid id %243`） | **顶点：可用（需修补层）**；**片元：当前被上游 bug 阻塞** |
| **B. 人工移植 WGSL** | 手写 `GlobeVS` 等价 WGSL（含 24 个 `czm_` 内建中的 10 个）→ 真机 **0 编译消息**、管线创建成功、绘制并回读 **4096/4096 非黑像素**，4 角取到 4 个影像纹素色 | **完全可行，是本项目的确定性路径** |
| **C. 运行时（浏览器内）转译** | glslang wasm 在页内加载 **30.8 ms**、编译 1 个真实 Cesium 着色器 **19.4 ms**；但**失败原因与离线完全相同**（`#version 300 es` + 松散 uniform）；且浏览器内**没有 SPIR-V→WGSL 的实现**（无 naga/tint wasm） | **不推荐**（继承了 A 的全部结构性问题，还需自带 WGSL 后端） |
| **D. 既有设施** | Cesium 只有 `demodernizeShader.js`（70 行，ES3.00→ES1.00，即 **GLSL→GLSL**），**零 WGSL 能力** | **不可用** |

**一句话回答**：
> CesiumJS 的 GLSL 只有约 **30–40%** 的转换量能"自动"完成（纯字符串级改写：版本号、`#line`、精度顺序、`in/out` location 补全、sampler binding）；**结构性语义 0% 可自动**（松散 uniform → std140 UBO + bind group、varying 名字→location 契约、变体→管线缓存），且**当前片元着色器的自动转译成功率为 0%**（naga 30.0.1 崩溃）。分子分母口径：以"顶点着色器 3/3 可产出被 GPU 接受的 WGSL、片元着色器 0/2"计，**按着色器计约 50% 可自动，按转换工作量计约 1/3 可自动，其余必须人工或改用专用 WGSL 发射器。**

**推荐路径**：**不转译**。改为**在 fork 层把 Cesium 的着色器组装层（`ShaderSource` / `ShaderBuilder`）改成 WGSL 发射器**（输入仍是同一套 defines + sources），并把 319 个静态 `.glsl` 叶子用路径 A 机器粗翻 + 路径 B 人工定稿，一次性转成 WGSL 源码入库。理由见 §7。

---

## 1. 工具链（全部实测可装，版本已锁定）

```powershell
# 1) Cesium 源码（只在临时目录，仓库根不动）
$tmp="$env:TEMP\shader-spike"; mkdir $tmp; cd $tmp
'{ "name":"shader-spike","private":true,"type":"module" }' | Set-Content package.json
npm install cesium@1.145.0            # -> @cesium/engine 26.3.0

# 2) glslang（Khronos 官方预编译 Windows 包，13.1 MB）
Invoke-WebRequest "https://github.com/KhronosGroup/glslang/releases/download/16.6.0/glslang-16.6.0-windows-x86_64-release.zip" -OutFile glslang.zip
Expand-Archive glslang.zip -DestinationPath glslang     # -> glslang\bin\glslang.exe（该发行包内只有 glslang.exe，无 glslangValidator.exe）

# 3) naga（无预编译二进制，必须 Rust 编译：本机 1m52s）
Invoke-WebRequest "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe" -OutFile rustup-init.exe
.\rustup-init.exe -y --profile minimal --default-toolchain stable --no-modify-path
cargo install naga-cli --locked        # -> naga-cli v30.0.1 -> %USERPROFILE%\.cargo\bin\naga.exe

# 4) glslang 的 wasm 版（离线/浏览器通用）
npm install @webgpu/glslang            # 0.0.15
```

实测输出：

```
glslang: Glslang Version: 11:16.6.0
naga   : 30.0.1
```

**工具链获取难度的实测结论**：

- `naga` **没有官方预编译二进制**：`https://api.github.com/repos/gfx-rs/wgpu/releases?per_page=5` 返回的全部 release `"assets":[]`（v30.0.1 / v29.0.4 / v30.0.0 / v29.0.3 / v29.0.2 均无附件）。npm 上的 `naga-cli` 是 **404（不存在）**，`@webgpu/naga` 也是 **404**。⇒ 只能 `cargo install naga-cli`（Linux CI 上约 2–3 分钟编译，可缓存）。
- **Tint 无 CLI 发行版**：Dawn nightly release 只提供 `Dawn-*-windows/ubuntu-*.tar.gz` 与 `emdawnwebgpu_pkg-*.zip`（Emscripten 用 WebGPU 头），未提供 `tint` 可执行文件（未逐个解包验证）。
- `glslang` **有官方预编译包**（Linux `glslang-16.6.0-linux-x86_64-release.zip` 7.57 MB），CI 上零编译成本。

---

## 2. 证据 E1：拿到"真正送进 `gl.compileShader` 的那段 GLSL"

Cesium 的着色器是**运行时拼装**的，磁盘上的 `.glsl` 不是最终源码。实测办法：**在 Node 里直接跑 Cesium 自己的拼装代码**（`ShaderSource.createCombinedVertexShader/FragmentShader` 只依赖 `context.webgl2/textureFloatLinear/floatingPointTexture` 三个字段，不需要 GL 上下文与 DOM）。

脚本：`scripts/extract-cesium-glsl.mjs`（逐行复刻 `Globe.js:658-689 makeShadersDirty` 与 `GlobeSurfaceShaderSet.js:268-482 getShaderProgram`，每处 `defines.push` 都标注了源码行号）。

```powershell
node experiments/shader-spike/scripts/extract-cesium-glsl.mjs
```

实测输出：

```
default-3d:   vs  870 lines / fs 1886 lines
  vs defines: DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN ENABLE_DAYNIGHT_SHADING DYNAMIC_ATMOSPHERE_LIGHTING GROUND_ATMOSPHERE INCLUDE_WEB_MERCATOR_Y
  fs defines: TEXTURE_UNITS 1 DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN ENABLE_DAYNIGHT_SHADING DYNAMIC_ATMOSPHERE_LIGHTING GROUND_ATMOSPHERE INCLUDE_WEB_MERCATOR_Y
kitchen-sink: vs  877 lines / fs 1945 lines
  vs defines: QUANTIZATION_BITS12 TRANSLUCENT ... PER_FRAGMENT_GROUND_ATMOSPHERE GEODETIC_SURFACE_NORMALS EXAGGERATION SHOW_REFLECTIVE_OCEAN ENABLE_VERTEX_LIGHTING ... FOG
minimal-3d:   vs  865 lines / fs 1881 lines
  vs defines: (空)
  fs defines: TEXTURE_UNITS 1
```

产物：`glsl/*.vert.glsl` / `*.frag.glsl`（3 配置 × 2 阶段）+ `glsl/manifest.json`。**这段源码本身就是最重要的一手证据**：`minimal-3d` 空 defines 也有 865 行，因为 `ShaderSource` 会把 `czm_` 内建的依赖闭包整段内联。

### 面量统计（全部实测计数）

| 指标 | 数值 | 命令依据 |
|---|---|---|
| `.glsl` 文件 / 行数 | **319 / 13,825** | `Get-ChildItem Source/Shaders -Recurse -Filter *.glsl` |
| 出现过的 `czm_` 标识符（去重，全库） | **244** | `[regex]::Matches($txt,'\bczm_[A-Za-z0-9_]+')` |
| 拼装后的 default-3d 一对中 `czm_` 使用数 | **72**（其中 VS 24） | `Select-String ... \bczm_` |
| 拼装后 VS+FS 的 `uniform` 声明数 | **92**（default-3d） | `Select-String '^uniform'` |
| `GlobeVS.glsl` / `GlobeFS.glsl` 原始行数 | **254 / 698** | 直接读取 |
| 条件编译：VS `#if=19 #elif=4 #else=6`；FS `#if=70 #elif=1 #else=12` | | `[regex]::Matches` |
| `GlobeSurfaceShaderSet` 里 boolean 门控 if 位点 / `defines.push` 位点 | **38 / 48** | `Select-String` |
| 全库 `new ShaderSource(` 调用点 | **84**（分布在 40+ 文件） | `grep -r "new ShaderSource("` |
| 全库 `new ShaderBuilder()` 调用点 | **4**（Model / Voxels / GaussianSplat / 文档） | `grep -r` |
| `demodernizeShader.js` | 70 行，ES3.00→ES1.00，无 WGSL | 读取 |

---

## 3. 证据 E2：路径 A —— glslang → SPIR-V → naga → WGSL

驱动脚本：`scripts/run-path-a.ps1`＋`scripts/repair-preprocessed.mjs`。完整原始日志在 `logs/raw-*.glslang.txt`、`logs/repaired-*.txt`、`logs/path-a-summary.json`。

### 3.1 直接编译（不修补）：**6/6 失败**

```powershell
glslang -V default-3d.vert.glsl -o out.spv     # Vulkan SPIR-V
glslang -G default-3d.vert.glsl -o out.spv     # OpenGL SPIR-V
```

原始报错（`logs/raw-default-3d.vert-V.glslang.txt`，逐字）：

```
ERROR: #version: ES shaders for SPIR-V require version 310 or higher
ERROR: ...\default-3d.vert.glsl:95: 'non-opaque uniforms outside a block' : not allowed when using GLSL for Vulkan
ERROR: 2 compilation errors.  No code generated.
ERROR: Linking vertex stage: Missing entry point: Each stage requires one entry point
SPIR-V is not generated for failed compile or link
```

`-G` 变体：

```
ERROR: ...\default-3d.vert.glsl:95: 'czm_modelView3D' : non-opaque uniform variables need a layout(location=L)
```

片元同理，首条报错落在 `czm_fogDensity`（`logs/raw-*-frag-*.glslang.txt`）。**6 个用例（3 配置 × 2 阶段）× 2 种目标环境 = 12 次，全部 exit=2。**

### 3.2 机械修补链（R0–R4）——每一次修补都是**语义改动**，不是语法微调

真实流水线形态：`拼装 GLSL → glslang -E 预处理(defines) → 修补 → glslang -V → naga → WGSL`。

| 修补 | 内容 | 触发它的原始报错 |
|---|---|---|
| **R0** | 删除全部 `#line N`（含**行内**残留，如 `...}#line 0`） | `ERROR: '#' : preprocessor directive cannot be preceded by another token` |
| **R1** | `#version 300 es` → `310 es` | `ES shaders for SPIR-V require version 310 or higher` |
| **R2** | 把所有松散 `uniform T n;` 提升为**一个** `layout(std140,set=0,binding=0) uniform CZM_UBO {...} czmUBO;`，并把标识符改写为 `czmUBO.n`；opaque（sampler，含数组）改为 `layout(binding=16+k)` | `'non-opaque uniforms outside a block'` / `'czm_modelView3D' : non-opaque uniform variables need a layout(location=L)` / `'binding' : sampler/texture/image requires layout(binding=X)` |
| **R3** | 给所有全局 `in/out` 补 `layout(location = N)` | `'location' : SPIR-V requires location for user input/output` |
| **R4** | UBO 必须插在 `precision` 声明**之后** | `'float' : type requires declaration of default precision qualifier` |

两个真实踩坑（都已复现并修复，写进脚本注释）：
- 数组 sampler `uniform sampler2D u_dayTextures[1];` 若漏匹配，报 `sampler/texture/image requires layout(binding=X)`；
- R2 若丢掉成员的数组后缀，会静默产出 `czmUBO.u_dayTextureUseWebMercatorT[0]`（非数组被下标访问）→ `'expression' : left of '[' is not of type array, matrix, or vector`。**机械化改写会静默改变语义**，这是人力复核必须存在的直接证据。

### 3.3 修补后的结果矩阵（`logs/path-a-summary.json`）

```
================ default-3d.vert.glsl ================
  [repaired] uniforms->block=22  io locations=11  glslang exit=0  spv=True (17492 bytes)
  [naga   ] exit=0  wgsl=True (19519 bytes)
================ default-3d.frag.glsl ================
  [repaired] uniforms->block=38  io locations=9   glslang exit=0  spv=True (18552 bytes)
  [naga   ] exit=1  wgsl=False (0 bytes)
================ minimal-3d.vert.glsl ================
  [repaired] uniforms->block=22  io locations=7   glslang exit=0  spv=True (5012 bytes)
  [naga   ] exit=0  wgsl=True (4535 bytes)
================ minimal-3d.frag.glsl ================
  [repaired] uniforms->block=35  io locations=5   glslang exit=0  spv=True (9352 bytes)
  [naga   ] exit=1  wgsl=False (0 bytes)
================ kitchen-sink.vert.glsl ================
  [repaired] uniforms->block=25  io locations=12  glslang exit=0  spv=True (23468 bytes)
  [naga   ] exit=0  wgsl=True (25548 bytes)
================ kitchen-sink.frag.glsl ================
  [repaired] uniforms->block=49  io locations=9   glslang exit=2  spv=False (0 bytes)
      ERROR: ...kitchen-sink.frag.repaired.frag.glsl:1295: 'binding' : sampler/texture/image requires layout(binding=X)
```

⇒ **顶点着色器 3/3 通过 glslang 与 naga；片元着色器 glslang 2/3 通过，但通过的两例都被 naga 拒绝。**

### 3.4 naga 崩溃（片元着色器，**上游 bug**）

```
$ naga --input-kind spv default-3d.frag.spv out.wgsl
[WARN  naga::front::spv] Unknown decoration RelaxedPrecision
[WARN  naga::front::spv] Unknown decoration RelaxedPrecision
[WARN  naga::front::spv] Unknown decoration RelaxedPrecision
[WARN  naga::front::spv] Unknown decoration RelaxedPrecision
invalid id %243
```

`minimal-3d.frag` 同样失败（`invalid id %243`，`logs/repaired-minimal-3d.frag.naga.txt`）⇒ **不是个例，是系统性**。

已排除的假设（实测）：`RelaxedPrecision` 并非因走 mediump 分支而来——用 `glslang -E` 预处理后确认片元走的是 `precision highp float; precision highp int;`；且 `-DGL_FRAGMENT_PRECISION_HIGH` 会被 glslang 报 `'#define' : Macro redefined`（说明它本来就已定义）。⇒ **这是 naga 30.0.1 SPIR-V 前端自身的问题，不是可用 define 绕开的。**

### 3.5 关键正面结果：naga 产出的 WGSL **被真机 GPU 接受**

把 naga 生成的 3 个 WGSL 喂给 Chrome 153 的真实 WebGPU device（`scripts/harness-page.html` 第 7 步）：

```json
"A2_nagaWgslOnGpu": [
  { "file": "minimal-3d.vert.wgsl",   "ok": true, "bytes": 4535,  "msgs": 0 },
  { "file": "default-3d.vert.wgsl",   "ok": true, "bytes": 19519, "msgs": 0 },
  { "file": "kitchen-sink.vert.wgsl", "ok": true, "bytes": 25548, "msgs": 0 }
]
```

即：**顶点着色器这条链路是真的通的**（`glslang → SPIR-V → naga → WGSL → GPU`，0 validation error）。

### 3.6 但：SPIR-V 路线**丢掉了 varying 的名字**

naga 对 SPIR-V 里的接口变量产出匿名成员与自动 location（`wgsl/default-3d.vert.wgsl`）：

```wgsl
struct VertexOutput {
    @builtin(position) gl_Position: vec4<f32>,
    @location(3) member: vec3<f32>,
    @location(2) member_1: vec3<f32>,
    @location(4) member_2: vec3<f32>,
    @location(8) member_3: vec3<f32>,
    ...
```

GLSL 里 varying 按**名字**匹配（`v_positionMC` 等），WGSL 按 **location** 匹配，而每个阶段**独立**转译会各自分配 location ⇒ **无法保证顶点/片元接口对齐**。要修必须"成对转译 + 共享 location 表"，或从带 `OpName` 的 SPIR-V（`glslang -g`）反查名字。**这是路径 A 的第二个结构性缺陷，实测可复现。**

---

## 4. 证据 E3：路径 B —— 人工移植（**本 spike 唯一完全跑通并在真机渲染的路径**）

产物：`port/globe-vs.wgsl`、`port/globe-fs.wgsl`。移植对象是 §2 拼装出来的**真实源码**（`glsl/default-3d.vert.glsl`、`glsl/minimal-3d.frag.glsl`），不是磁盘上的 `.glsl`。

移植范围（报告中如实声明，见文件头注释）：
- **VS**：`getPosition3DMode`、`get2DMercatorYPositionFraction`、`czm_latitudeToWebMercatorFraction`、`czm_webMercatorMaxLatitude`、`czm_octDecode(vec2/float)`、`czm_signNotZero`、`czm_branchFreeTernary` + `main()` 的活跃分支（3D 场景模式、非量化、`INCLUDE_WEB_MERCATOR_Y`、`ENABLE_DAYNIGHT_SHADING`、关闭 `GROUND_ATMOSPHERE`，即 `globe.showGroundAtmosphere = false` 的真实配置）。
- **未移植**（已在文件头列名）：`computeAtmosphereScattering`/`computeScattering`（`GroundAtmosphere.glsl`，约 190 行 GLSL + 5 个内建，是最大单块）、`QUANTIZATION_BITS12` 解压、`EXAGGERATION`、`GEODETIC_SURFACE_NORMALS`、`APPLY_MATERIAL`、morphing/2D/Columbus 模式、裁剪面。
- **FS**：忠实移植**运行时生成**的 `computeDayColor()`（`GlobeSurfaceShaderSet.js:419-472`，**磁盘上不存在此函数**）+ `sampleAndBlend()` 的最小 define 分支 + `czm_gammaCorrect` + `czm_maximumComponent`；裁剪掉水面/大气/矢量/半透明等特性。

### 真机结果（`logs/webgpu-verify.json`，Chrome 153 + RTX 4080 SUPER）

```
[step] adapter OK {"vendor":"nvidia","architecture":"lovelace","features":20,
                   "maxTextureDimension2D":16384,"maxUniformBufferBindingSize":65536,"maxBindGroups":4}
[step] compile globe-vs.wgsl OK 0 messages
[step] compile globe-fs.wgsl OK 0 messages
[step] createRenderPipeline OK pipeline created
[step] bindGroups OK group0=VS UBO, group1=FS UBO+texture+sampler
[step] draw+readback OK {"topLeft":[0,0,255,255],"topRight":[255,255,255,255],
                         "bottomLeft":[255,0,0,255],"bottomRight":[0,255,0,255],
                         "center":[0,255,0,255],
                         "nonBlackPixels":4096,"totalPixels":4096}
```

- 顶点布局用**真实的 Cesium 属性位置**：`{position3DAndHeight:0, textureCoordAndEncodedNormals:1}`（来自 `terrainEncoding.getAttributeLocations()`），stride 32 B，`float32x4 × 2`。
- uniform 用**手工计算的 std140 布局**（VS 480 B / FS 48 B），identity 矩阵 + 真实椭球半径。
- 回读四角取到 2×2 影像纹理的四个纹素色 ⇒ **uniform 布局、varying、纹理采样、bind group 全链路正确**。
- **顺带发现**：`bottomLeft` 拿到纹素 (0,0)、`topLeft` 拿到 (0,1)，即 **WebGPU 纹理原点在上、GL 在下**，Y 翻转必须显式处理（Cesium 现在是在纹理上传处翻转）。

### 工时估算（以实测产物为锚）

- 本次 VS 端口 = **181 行 WGSL**（`port/globe-vs.wgsl`，含注释与映射说明），覆盖 1 个配置；FS 端口 = **151 行 WGSL**（`port/globe-fs.wgsl`，裁剪版）。带源码对照、一次写成、随即真机通过。
- 折算**可在评审+测试约束下**的工程工时：**GlobeVS+GlobeFS 一对（含 MVP 所需全部 define 变体与 ~40 个 `czm_` 内建）≈ 3–5 人日**；地形 MVP 的着色器层（含 uniform/bind group 规划、变体缓存）≈ **1–2 周**。
- 外推到全库：**319 个 `.glsl` / 84 个组装点 / 13,825 行**，按同样的"每家族 1–2 人日"外推 ≈ **2–4 人月**（**这是外推，未逐家族实测**）。

### E1 附加实验：GL 会裁剪的 varying，WebGPU 直接拒绝

在 FS 里加一个 VS 不输出的 `@location(7)`（GL 里这是良性的：链接器会裁掉未用 varying）：

```json
"E1_missingVarying": {
  "fsCompileMessages": [],
  "pipelineError": null,
  "validationError": "The fragment input at location 7 doesn't have a corresponding vertex output.\n - While calling [Device].CreateRenderPipeline([RenderPipelineDescriptor])."
}
```

⇒ 实测证明：**驱动 setter（如把 `czm_sceneMode` 之类的 uniform 从某分支里去掉）导致的 varying 消失，在 WebGPU 是硬失败。**而 Cesium 现在正是靠 GL 链接器宽松匹配 + 编译期 `#ifdef` 决定 varying 集合的（`GlobeFS.glsl:130-134` 无条件声明 `v_normalMC/v_normalEC`，而 `ENABLE_DAYNIGHT_SHADING` 配置下 `GlobeVS` **不写**它们）。

---

## 5. 证据 E4：路径 C —— 运行时（浏览器内）转译

`scripts/harness-page.html` 第 6 步，页内 `import` glslang 的 `web-devel-onefile` 构建：

```json
"C1_runtimeGlslang": {
  "wasmLoadMs": 30.8,
  "attempts": [
    { "label": "cesium minimal-3d.vert (raw ES 300)", "ok": false, "ms": 131,
      "error": "GLSL compilation failed" },
    { "label": "cesium default-3d.vert (repaired, ES 310 + UBO)", "ok": true,
      "spvBytes": 4373, "ms": 19.4 }
  ]
}
```

页内控制台原始输出：

```
[warning] ERROR: #version: ES shaders for SPIR-V require version 310 or higher
[warning] ERROR: 0:95: 'non-opaque uniforms outside a block' : not allowed when using GLSL for Vulkan
[warning] ERROR: 2 compilation errors.  No code generated.
```

**结论**：
1. glslang wasm 在浏览器里**能跑**，加载 30.8 ms、单着色器 19.4 ms —— 性能不是问题；
2. 但它**继承了离线路径的全部结构性问题**（同样是 Vulkan SPIR-V 目标，同样要求 ≥310 es 与 uniform block）⇒ 运行时转译并不能"绕过修补"；
3. 浏览器内**没有 SPIR-V→WGSL 的实现**（naga 无官方 wasm npm 包；Tint 无 CLI/JS 发行），所以路径 C 还得自带一个 WGSL 后端；
4. 即便有，naga 的片元崩溃（§3.4）会 100% 复现，因为那是 SPIR-V 前端问题。

另一条实测记录（工具链细节）：`@webgpu/glslang` 的**默认 Node 入口会挂死**——`require('@webgpu/glslang')`（`dist/node-devel`）后 `await mod()` 在 Node 22 上 **>120 s 不返回**（`ERROR` 之前无任何输出；复现脚本 `scripts/glslang-to-spirv.mjs`，**注意它会挂住，请自行加超时**）；而 `dist/web-devel-onefile/glslang.js` 在 **Node 里 9 ms 加载、160 ms 编译**，在 **Chrome 里 30.8 ms 加载**。⇒ 若要用 glslang wasm 做构建期转译，**必须显式使用 `web-devel-onefile` 构建，不要用包默认入口**。

---

## 6. 难点逐条点名（附证据）

| # | 难点 | 实测证据 | 影响 |
|---|---|---|---|
| 6.1 | **`czm_` 内建映射** | 全库 **244** 个 `czm_` 标识符（`Sources/Shaders/**` 去重计数）；拼装后 default-3d 一对用到 **72** 个；其中含**结构体**（`czm_material`、`czm_materialInput`、`czm_ray`、`czm_raySegment`）、**重载函数**（`czm_octDecode(vec2)`/`(float)`、`czm_signNotZero(float/vec2/vec3/vec4)`）、**常量**（`czm_pi`、`czm_infinity`、`czm_webMercatorMaxLatitude`）。WGSL **无重载、无结构体常量** | 需要一份 WGSL prelude 库，把重载拆成不同名字（见 `port/globe-vs.wgsl` 的 `czm_octDecodeFloat`）、把结构体常量换成函数或字面量 |
| 6.2 | **uniform 反射（GL reflection → bind group）** | 拼装后一对出现 **92** 个 `uniform` 声明；Cesium 用 `gl.getActiveUniform` 自动按名字绑定（`AutomaticUniforms`）。SPIR-V 路线必须 R2 把所有松散 uniform 塞进 **1 个 std140 block**（实测：VS 22–25 个、FS 35–49 个），并手工计算偏移（`port/globe-vs.wgsl` 的 480 B 布局是手算的） | 这是**结构性语义变化**：不能再"按名字逐 uniform 绑定"，必须做 UBO 打包 + 动态偏移 + 变体级 layout |
| 6.3 | **精度修饰符 / `gl_` 内建** | 全库 `highp` 27 处、`mediump` 1 处；`gl_*` 145 处；`discard` 61 处；`textureCube` 10 处。**好消息**：`Source/Shaders/**` 里 `varying`/`attribute` 各 3/4 处**全部在注释里**（实测逐条确认）⇒ Cesium 的着色器是**纯 ES 3.00**，没有 ES 1.00 遗留语法；`varying/attribute` 只由 `demodernizeShader` 在 WebGL1 回退时运行时生成。naga 对片元 SPIR-V 报 `Unknown decoration RelaxedPrecision` 后崩溃 | 精度 → WGSL **无对应**（删除）；`gl_Position`→`@builtin(position)`、`gl_FrontFacing`→`@builtin(front_facing)`（Cesium 封装为 `czm_backFacing()`）；`texture2D/textureCube`→`textureSample`；`discard` 语义相同 |
| 6.4 | **`#define` 变体爆炸** | `GlobeSurfaceShaderSet` 里 **38 个 boolean 门控位点 / 48 处 `defines.push`**；`TEXTURE_UNITS n` × 3 种场景模式 × 裁剪状态；缓存键是 `numberOfDayTextures` + 位打包 `flags`（`_shadersByTexturesFlags`）。全库 **84 个 `new ShaderSource(`** 组装点 | 转译/缓存必须**按变体**做（不能只按文件）：WGSL 里 `#ifdef` 不存在 → 要么整段变体各自生成一份 WGSL（数量爆炸），要么用 WGSL `override`/pipeline-overridable constants 或运行时分支。**注意**：GLSL 的 `czm_sceneMode == czm_sceneMode2D` 这类"uniform 参与编译期常量折叠"的写法在 WGSL 无等价契约 |
| 6.5 | **varying 契约丢失** | naga 输出匿名成员 `member`/`member_1`… 与自动 location 2/3/4/8/9/10（`wgsl/default-3d.vert.wgsl`）；GL 按名字匹配。另实测：FS 多一个 `@location(7)` 输入 → `CreateRenderPipeline` 校验失败（§4 E1） | **必须成对转译**并共享 location 表，或从 `OpName` 恢复名字；单阶段独立转译产不出可用的管线 |
| 6.6 | **纹理坐标原点** | 回读四角颜色与 2×2 纹理对应关系显示 Y 方向相反（§4） | 影响所有影像/法线/水面纹理，属**像素级可验证**风险 |
| 6.7 | **既有转换设施** | `Renderer/demodernizeShader.js`（70 行）只做 ES3.00→ES1.00（`out_FragColor→gl_FragColor`、`in→varying/attribute`、`texture→texture2D`、加 `#version 100`），**零 WGSL** | 路径 D **不存在** |

---

## 7. 建议（明确、可执行）

### 7.1 推荐：**不要"转译 GLSL"，改为"换发射目标"——在 fork 层把着色器组装层改成 WGSL 发射器**

理由（全部有实测支撑）：

1. **Cesium 的 GLSL 本来就是字符串拼装产物**（§2 实测：磁盘 `.glsl` ≠ 最终源码），组装逻辑集中在 **84 个 `ShaderSource` 调用点 + 4 个 `ShaderBuilder` 调用点**，是纯字符串操作，正好落在章程原则 I 允许的"渲染后端层"（着色器编译）。
2. **转译器的全部成本都花在"撤销 Cesium 的 GLSL 约定"上**：R0–R4 五类修补（`#line`、`#version`、松散 uniform→UBO、I/O location、精度顺序）**在 WGSL 发射器里根本不会发生**——发射器可以一开始就产出 `@group/@binding`、`@location`、WGSL 结构体。实测 R2 是最贵的一环（每个变体 22–49 个成员 + 手算布局）。
3. **路径 A 的产物只适合当"第一稿"**：顶点着色器确实能被 GPU 接受（3/3，0 报错），但 varying 名字丢失、片元被 naga 阻塞，无法直接作为交付物。
4. **路径 B 已被证明在真机上完整跑通**（0 编译消息 + 4096/4096 像素），是唯一"确定能出结果"的路径，适合作为发射器输出的**黄金样本**与人工定稿手段。

**落地形态（分三步，每步都可独立验证）**：

- **S1（本周）**：fork `@cesium/engine`，把 `ShaderSource`/`ShaderBuilder` 的输出目标参数化（`emit: "glsl" | "wgsl"`），保留全部 defines 与 sources 输入不变；先只支持 Globe 家族（`GlobeVS`/`GlobeFS`）与 MVP 所需 define 子集。
- **S2**：把 319 个 `.glsl` 叶子做一次性翻译：**路径 A 出草稿**（`scripts/run-path-a.ps1` 已可复用）→ **路径 B 人工定稿** → WGSL 入库（`shaders/wgsl/**`），并配"每家族一个真机编译用例"（本 harness 已能自动做）。
- **S3**：`czm_` WGSL prelude 库 + uniform/bind group 规划器（把 `AutomaticUniforms` 的按名绑定改造成"按变体生成 UBO + 动态偏移"），用 §4 的 harness 做像素级回归。

### 7.2 其余路径为何不推荐

- **路径 C（运行时转译）**：实测继承 A 的全部结构性问题（同样报 `ES shaders for SPIR-V require version 310`、`non-opaque uniforms outside a block`），且**浏览器内没有 SPIR-V→WGSL 后端**；每变体 ~20 ms 转译 + wasm 30 ms 启动，还要在每次上游升级后重新验证 244 个内建。**成本高于收益。**
- **纯路径 A（离线转译直接交付）**：片元 0/2 通过（naga 崩溃），varying 契约丢失，且修补层本身就是一个"需要维护的编译器"。**当前不可交付。**
- **路径 D**：不存在（§6.7）。

### 7.3 推荐路径的具体工具链与 CI（Linux）安装

```yaml
# .github/workflows/shader-transpile.yml (节选) — 只需用于"把 GLSL 翻译成 WGSL"的离线步骤
- uses: dtolnay/rust-toolchain@stable          # naga 无预编译包，必须 cargo
- run: cargo install naga-cli --locked          # naga-cli v30.0.1（实测本机编译 1m52s；CI 请用 actions/cache 缓存 ~/.cargo）
- run: |
    curl -sSL -o glslang.zip https://github.com/KhronosGroup/glslang/releases/download/16.6.0/glslang-16.6.0-linux-x86_64-release.zip
    unzip -q glslang.zip -d /opt/glslang        # 官方预编译，7.57 MB，无编译成本
- run: npm ci && node experiments/shader-spike/scripts/run-path-a.ps1   # 逻辑需改写为 bash/pwsh core
# 真机 WGSL 编译验证（§4 的 harness）需要 Chrome + GPU runner；CI 无 GPU 时降级为
#   naga --input-kind wgsl <file>  # WGSL 语法/校验（盲区：不覆盖 WebGPU 管线校验，须显式记录）
```

版本锁定（实测基线）：`glslang 16.6.0`、`naga-cli 30.0.1`、`@webgpu/glslang 0.0.15`（**必须用 `dist/web-devel-onefile`**）、`cesium 1.145.0` / `@cesium/engine 26.3.0`、Node ≥ 22、Chrome ≥ 153（真机验证）。

### 7.4 剩余风险清单与验证方式

| 风险 | 验证方式 | 现状 |
|---|---|---|
| naga 片元崩溃（`invalid id %243`） | 升级 naga 后重跑 `run-path-a.ps1`；或给上游提 issue 附 `spirv/default-3d.frag.spv` | **已复现，阻塞纯 A** |
| varying location 契约 | 成对转译后跑 §4 harness 的 `createRenderPipeline`（E1 已验证能精确捕获） | 已知必现 |
| UBO 布局/对齐错误 | 用 identity 矩阵 + 已知纹素做回读（§4 已建立该手法） | 手法已验证 |
| 纹理 Y 翻转 | §4 回读四角颜色断言（已观察到差异） | 已观察到 |
| 变体缓存爆炸（38 门控 × TEXTURE_UNITS × 模式） | 统计运行时 `ShaderProgram` 实例数 + 编译耗时直方图 | 未测 |
| 精度变化（highp/mediump 消失、`RelaxedPrecision`） | 与 WebGL2 基线做像素 diff + 地形高程数值比对 | 未测 |
| 全库 319 着色器 / 244 内建覆盖度 | 逐家族移植 + 每家族 1 个真机编译用例，覆盖率作为 CI 门禁 | 仅覆盖 Globe 家族 |
| CI 无 GPU 时的验证盲区 | 记录降级策略（naga WGSL 校验代替管线校验）并保留本地复现步骤（章程原则 V 要求） | 需在 plan 中显式记录 |

### 7.5 若"某条路径不可行"的退路

- **纯路径 A 不可行**（片元被 naga 阻塞）⇒ 退路一：**A 出草稿 + B 定稿**（§7.1 S2）；退路二：把片元着色器**整段改用 WGSL 重写**（本次实测 FS 裁剪版 ~150 行 WGSL 即跑通），只对顶点着色器保留 A。
- **若连"发射目标参数化"都被判定越出渲染后端层** ⇒ 退路三：**双层 WGSL 源码库**（`shaders/wgsl/**` 与上游 `.glsl` 并存，fork 层只做"选哪一份"），代价是可升级性变差，需在 plan 中论证并纳入 rebase 演练。

---

## 8. 复现命令（全部在本目录）

```powershell
$S = "E:\work\CesiumjsWebGpu\experiments\shader-spike"

# E1 取真实拼装 GLSL（Node 跑 Cesium 自己的拼装逻辑）
node "$S\scripts\extract-cesium-glsl.mjs"

# E2 路径 A 全矩阵（glslang→SPIR-V→naga→WGSL，含原始报错落盘到 logs/）
pwsh -NoProfile -File "$S\scripts\run-path-a.ps1"

# E3/E4 真机 WebGPU：编译手写 WGSL + 绘制回读 + naga WGSL 校验 + 页内 glslang
node "$S\scripts\webgpu-harness.mjs"        # 结果 -> logs/webgpu-verify.json
```

## 9. 本次未做（局限，避免过度解读）

- 未测 `czm_` 全量 244 个内建的移植；未覆盖 Model/Voxels/GaussianSplat（`ShaderBuilder`）与后处理/阴影/大气等 40+ 组装点。
- 未测性能（帧时间/显存/draw call），本 spike 不涉及章程原则 IV。
- 未测变体数量与编译缓存的真实规模（仅静态计数）。
- 未对 `kitchen-sink.frag` 的最后一个 glslang 报错（`binding : sampler/texture/image requires layout(binding=X)`）继续修补——该配置已超出 MVP 范围，且片元链路当前被 naga 阻塞。
- Tint/Dawn 是否随 `Dawn-*-Release.tar.gz` 提供 `tint` CLI：**未验证**（包 118 MB，超出时间盒）。
