# G-7 门禁（前导实测）：切片 B 的深度纹理 × MSAA 设计空间

**Feature**: `001-webgpu-terrain-mvp` ｜ **本文件当前只含 §0 前导实测** ｜ **门禁**: plan.md「实现前的验证门」G-7
**证据产物**: `experiments/gates/out/g7-depth-msaa.json`（机器可判定，`kind: "evidence"`）｜ **规范**: [experiments/gates/README.md](../experiments/gates/README.md)
**重跑命令**:

```text
node experiments/gates/g7-slice-b/run-gpu.mjs      # 实测（真实设备，headless，零浏览器参数）
node tools/scripts/check-gate.mjs --all            # 判定器校验：6/6（本证据文件按 slug 被排除在"判定发现"之外）
```

**校验命令的准确口径（勘误）**：本文件原先写的 `check-gate.mjs --gate g7` **不成立**——它现在必然 FAIL
（`experiments/gates/out/g7.json` 尚不存在，因为 G-7 的**判定**属 T127）。同理
`--gate g7-depth-msaa` 也会 FAIL：`check-gate.mjs` 按 `JUDGEMENT_FILE` 正则发现判定文档，slug 证据文件
被排除在**发现**之外；一旦被**显式点名**，它就会被当成判定文档校验，因缺 `verdict`/`notes` 而报错。
**这两条都不是缺陷**，而是"证据 ≠ 判定"的正确表现：证据文件不能替代 T127 的 G-7 判定
（本文件的立场正是不宣告 G-7 通过）。正确的通用校验是 `--all`（6/6，exit 0）。

> **本文件不宣告 G-7 通过。** G-7 的**判定**属于 tasks.md **T127**，须在切片 B（T097/T098a/T098b）落地、
> 并消费本文件的实测结论之后由 T127 写入。此处只记录"切片 B 能怎么建"这一件事的**实测**答案，
> 以免 T097 依据 WebGL 惯例去实现一个在 WebGPU 上根本不存在的机制。

---

## 0. 为什么必须先测，而不是读规范

切片 A 的补丁层里写着拒绝原因（`backend-webgpu/Renderer/FramebufferManager.ts:262-286`）：
"Every attachment of a WebGPU render pass shares one sample count"。这句话**是**一条硬约束（本文件 F1 已复现），
但它**不足以**回答切片 B 的真正问题：

- 上游 `GlobeDepth` 需要一张**可被着色器采样的、单采样的深度纹理**；
- WebGL 里的做法是"多采样深度 **renderbuffer** 作附件 + 单采样深度 **texture** 作 resolve 目标"；
- WebGPU 是否有对应的 resolve 机制，属**实现相关**，规范文字给不出本机答案。

更要紧的是：**没有错误不等于机制可用**。`GPURenderPassDepthStencilAttachment` 是 WebIDL 字典，
未识别的 `resolveTarget` 成员会被**静默忽略** —— 只看"没报错"就会得出"支持深度 resolve"的错误结论。
本门禁首次运行时正是如此：`depth-resolve-target` 被判为 LEGAL，直到补上**回读**才发现 resolve 目标里
什么都没有（`[0,0,0,0,0]`，而清除值是 `0.5`）。这条弯路保留在此，因为它就是本仓库反复出现的失效模式
（"0 错误 + 健康计数 + 黑帧"）：**没有判别力的观测不能作为结论**。

## 1. 判定

`node experiments/gates/g7-slice-b/run-gpu.mjs` → **exit 0**，13 项测量，5 条结论全部 `established`。

| 编号 | 结论 | 反例/对照臂 | 对切片 B 的后果 |
|---|---|---|---|
| **F1** | 一个 render pass 的**所有附件必须同采样数** | 混采样被拒（`sample count (1) does not match ... (4)`）；**同采样对照 LEGAL** | 证明补丁层所引的那条约束成立；WebGL 的"多采样深度附件 + 单采样深度纹理"**不能照搬** |
| **F2** | 本机 Chrome **没有可用的深度 resolve** | ① pass 的 `resolveTarget` 被**静默忽略**（回读得 `[0,0,0,0,0]`，期望 `0.5`）；② `copyTextureToTexture` 4x→1x 被拒 | 不能指望硬件把多采样深度解析成单采样纹理 |
| **F3** | 片元着色器**可以**在 4 采样 pass 里写深度（`@builtin(frag_depth)`） | 管线以 `multisample: {count: 4}` 声明后 LEGAL | 存在"全屏四边形把深度写进目标"的无 resolve 路径 |
| **F5** | 多采样深度纹理**可以**通过 `texture_depth_multisampled_2d` + `textureLoad` 读取 | 朴素绑定 `texture_depth_2d` 被拒（`Sample count (4) ... doesn't match expectation (multisampled: 0)`）；多采样绑定 LEGAL | **深度 resolve 可以在着色器里自己做**（逐采样 `textureLoad` 后求平均） |
| **F4** | 深度面能否拷贝是**格式属性**，不是画布纹理的属性 | `depth32float`、`depth16unorm` **LEGAL**；`depth24plus`、`depth24plus-stencil8` **被拒** | 任何需要离开 pass（回读/拷贝）的深度纹理 MUST 用 `depth32float`（或 `depth16unorm`），**不得**用画布那种 `depth24plus-stencil8` |

**结论：`msaaTradeOffIsReal = false`** —— 切片 B **不必牺牲 MSAA**。F3 与 F5 各给出一条合法路线，
T097 可在原型里择一并实测其正确性；plan 中"离屏深度纹理 + 深度拷贝"的写法因此是**可实现的**，
不需要把它降级成"MSAA 与深度纹理二选一"的范围变更。

## 2. 对既有事实的补充解释

- W5 期间"画布深度无法回读"（`tests/contract/page/probe.js` 的实测记录）现在有了**格式级**解释：
  画布深度是 `depth24plus-stencil8`，F4 证明该格式的深度面在本机 Chrome 不可拷贝 —— 换成 `depth32float`
  就可以。这条同时**收窄**了原先的表述：不是"深度都不能拷"，而是"这两种格式不能拷"。
- 切片 A 的临时降级（`capability.ts` 的 `depthTexture: false`）**只**该由 T098a 翻转；
  本实测不改变能力表，只把 T098a 之后要实现的机制确定下来。
- 本门禁**不**触碰补丁层、产品代码与契约 bundle；它只新增 `experiments/gates/g7-slice-b/**` 与证据文件。

## 3. 待 T127 补写

G-7 判定文档仍需（由 T127 在切片 B 落地后写入）：切片 B 的实现选择与其正确性证据、
`depthTexture` 翻转后的全量回归（单元 + 契约 + 视觉 + 基准）、以及 G-7 的最终 verdict。
