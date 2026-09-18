# 本增量着色器覆盖范围声明（Shader Coverage Scope）

> **任务**：`tasks.md` T082（`层=单元`）｜ **契约**：[`contracts/fork-patch-layer.md`](../specs/001-webgpu-terrain-mvp/contracts/fork-patch-layer.md) §5 R3/R8、§6；
> **门禁结论**：[`gate-g5-conclusion.md`](./gate-g5-conclusion.md)、[`gate-g6-conclusion.md`](./gate-g6-conclusion.md)；
> **尖刺**：[`experiments/shader-spike/REPORT.md`](../experiments/shader-spike/REPORT.md) §9。
> 本文件是 **口径声明**，不是路线论证；路线（不转译、换发射目标）已由尖刺定案并由 G-5/G-6 实证。

---

## 1. 本增量**覆盖**什么（W4 = T066–T083）

本增量只覆盖**地形着色器闭包**——即地形瓦片绘制路径真正装配并编译的那一组着色器：

| 家族 | 上游来源 | 本增量的 WGSL 落点 |
|---|---|---|
| `GlobeVS` | `Source/Shaders/GlobeVS.js` | `backend-webgpu/webgpu/wgsl/leaves/globe-vertex.wgsl` |
| `GlobeFS` | `Source/Shaders/GlobeFS.js` | `backend-webgpu/webgpu/wgsl/leaves/globe-fragment-main.wgsl` |
| `AtmosphereCommon` | `Source/Shaders/AtmosphereCommon.js` | `backend-webgpu/webgpu/wgsl/leaves/globe-fragment-library.wgsl` |
| `GroundAtmosphere` | `Source/Shaders/GroundAtmosphere.js` | `backend-webgpu/webgpu/wgsl/leaves/globe-fragment-library.wgsl` |

**`czm_` 内建**：本增量只交付地形闭包用到的那一批——目录共 **92** 条映射
（`backend-webgpu/webgpu/wgsl-prelude/catalog.json`：11 个常量 + 40 个函数（含 11 条重载拆名）
+ 3 个结构体 + 38 个自动 uniform 成员），其中 2 个函数是 **T074 的后端层自建件**
（`czms_remapClipDepth` / `czms_unprojectDepth`，非上游 `czm_` 名）。
上游全库 244 个 `czm_` 内建的其余部分**本增量不覆盖**。

**运行期生成片段**：`GlobeSurfaceShaderSet.js:419-472` 的 `computeDayColor()` 与
`:474-475` 的 `getPosition()` / `get2DYPositionFraction()` 在磁盘上不存在，由
`backend-webgpu/webgpu/generated-fragments.ts` 按**同一参数**（`{textureUnits, flags}`）镜像生成；
覆盖度按**可达参数组合**计数验收（`coverage()`：`textureUnits ∈ {1..3}` × `2^9` 组 `APPLY_*` 旗标）。

**`ShaderBuilder` 家族**：`Renderer/ShaderBuilder.js` 在 MVP **保持字节不变**（契约 R9），
其模型 / 体素 / 高斯泼溅路径在本增量下以 `category:"not-implemented"` **显式失败**，不做 WGSL 化。

---

## 2. 本增量**不覆盖**什么（明确不计入）

**全库 319 个 `.glsl` 叶子、244 个 `czm_` 内建、40+ 个着色器组装点的一次性转译，明确不计入本增量。**

- 规模口径（尖刺 §9 实测）：全库 **319 个 `.glsl` / 244 个 `czm_` 内建 / 13,825 行**；
  上游共 **84 个 `new ShaderSource(` 组装点**与 **4 个 `ShaderBuilder` 调用点**。
- 工时外推：**2–4 人月**。该外推**基于尖刺的自动转换比例（按着色器计约 50%、按转换工作量计约 1/3）
  推算，未逐家族实测**——本增量没有为它做任何家族级的实测锚点。
- 因此，本增量的任何门禁结论（G-5 真机 768 组合、G-6 变体预算、W4 Checkpoint）**只对地形闭包成立**，
  MUST NOT 被引用为"全库着色器已可运行"的证据。

后续增量按**家族**推进，每家族交付时必须附一个**真机编译用例**作为门禁；单家族不做家族级用例即视为未完成。

---

## 3. 为什么这条边界是必须写下来的（风险与后果）

1. **没有这条声明，门禁会被误读**：G-5 的"768/768 组合真机 0 校验错误"是**地形 define 空间**的
   结论，不是"319 个叶子都转好了"。两者相差一个量级以上的工作量。
2. **上游戏逻辑层会给出不符合的事实**：`ShaderSource` 是 84 个组装点的公共入口。发射器现在**只认地形
   define 子集**：任何落到 `SUPPORTED_DEFINES` 之外的 define 都被**拒绝并给出诊断**
   （`backend-webgpu/webgpu/wgsl-emitter.ts`），不静默降级。也就是说，模型 / 体素 / 高斯泼溅 / 矢量瓦片
   路径在 WebGPU 上会**安静地失败是不允许的**——它会**响亮地失败**，这正是当前交付的边界形态。
3. **CI 盲区**：CI 无 GPU 时只能做 WGSL 模块级校验（`naga --input-kind wgsl`），**不覆盖 WebGPU 管线校验**
   （varying 契约、绑定布局、格式兼容）。本增量的管线级结论全部来自**本机真机** harness
   （`tools/shader-verify.mjs`），按 FR-023 记为盲区。

---

## 4. 与任务清单的一致性

本声明与 `specs/001-webgpu-terrain-mvp/tasks.md` **一致**：该清单中**不存在**任何把
"全库 319 个 `.glsl` 叶子纳入本增量"的任务。地形闭包之外的着色器在本清单里只以两种形式出现：

- **显式 `not-implemented` 失败边界**（`Renderer/ShaderBuilder.js` 的保持 + 模型/体素/高斯泼溅的显式失败，T081）；
- **Out of Scope 条目**（模型、大气、阴影、后处理、粒子、矢量标注、移动端）。

`tests/unit/shader-scope-doc.test.mjs` 对以上三点做机器断言（含"本文件必须写明三项声明"与
"任务清单中不存在把 319 叶子纳入本增量的任务"）。
