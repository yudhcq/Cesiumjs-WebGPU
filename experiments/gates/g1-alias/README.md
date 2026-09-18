# G-1 门禁实现：别名接缝可替换性（H-1）

**任务**: tasks.md **T015** ｜ **判定产物**: `experiments/gates/out/g1.json` ｜ **结论文档**: [docs/gate-g1-conclusion.md](../../../docs/gate-g1-conclusion.md)
**产物规范**: [experiments/gates/README.md](../README.md)

```text
node experiments/gates/g1-alias/run.mjs                        # 门禁本体（构建 + 真机浏览器 + 判定），exit 0 ⇔ verdict=pass
node experiments/gates/g1-alias/run.mjs --control=no-rewrite    # 阴性对照：空清单，必须被判定器识别为“未替换”
node experiments/gates/g1-alias/build.mjs                       # 只跑构建链（调试用）
node tools/scripts/check-gate.mjs --gate g1                     # 判定器校验产物
```

## 文件

| 文件 | 作用 |
|---|---|
| `manifest.gate.json` | **门禁专用**替换清单（唯一条目 `Renderer/Context.js`，`kind:"replace"`，`glCallSites:46`）。正式清单由 T031 落在 `packages/cesium-webgpu/backend-webgpu/manifest.json`，本文件 MUST NOT 当作交付清单 |
| `Renderer/Context.js` | 被替换的实现（门禁桩）：覆盖上游 `Scene` **构造期**读取面 + 上游 `Context` 构造期自建的三件套（`shaderCache`/`textureCache`/`uniformState`，均为未列入清单的上游模块）；其余成员一律抛 `category:"not-implemented"` |
| `entry.js` | bundle 入口：上游深路径导入（触发别名改写）+ 门禁实现的本地导入（用于模块身份断言） |
| `build.mjs` | 真实构建链：Rollup + `tools/rollup-plugin-engine-patch.mjs`（T008）+ `@rollup/plugin-node-resolve` + `cjs-interop.mjs`；产出改写轨迹、模块图分类、白名单穷举、包文本探针 |
| `cjs-interop.mjs` | 构建期 CommonJS/UMD 包裹（发现 F-1：T004 依赖集无 CJS 插件）；原始代码逐字执行，不写回磁盘 |
| `upstream-integrity.mjs` | `node_modules/@cesium/engine` 全量内容哈希快照/比对（构建前后零改动断言） |
| `page.html` / `probe.js` | 门禁页面与页内断言（模块身份、消费计数、能力链路、显式失败、WebGPU `adapter.info`） |
| `run.mjs` | 编排：快照 → 构建 → 快照 → 静态检查 → 起服务 → Playwright → 判定 → 写产物；含阴性对照模式 |

## 关键设计（为什么这样才是证据）

1. **改写必须发生在真实构建链里**：`Scene/Scene.js:40` 的**相对导入**只有在构建期按"解析后的绝对路径"改写才可能被替换
   （运行期 import map / prototype patch 都做不到，见 research §1 对方案 F3 的否决）。
2. **来源判定而不是行为判定**：页面断言 `scene._context instanceof <门禁文件导出的类>` 且
   `深路径导入的 Context === 门禁文件导出的类`，因此"上游 Context 恰好行为相同"骗不过判定器。
3. **阴性对照**：空清单重跑同一套断言，5/5 应失败的检查项确实失败；否则本门的 pass 不可信。
4. **边界显式**：本门禁不渲染任何一帧、不做设备交接、不做两路径比较；W2 才拥有的能力必须以
   `category:"not-implemented"` 显式失败（`MUST NOT` 静默）。
5. **产物布局模式化**：门禁与对照写不同的产物路径，对照永远不会覆盖 `out/g1.json` 及其证据。

## 已记录的偏离

D-1 门禁清单 vs 正式清单（T031）、D-2 无 TS 插件、D-3 桩以 WebGL2 承载上下文获取 —— 逐条见
[docs/gate-g1-conclusion.md](../../../docs/gate-g1-conclusion.md) §5 与 `out/g1.json` 的 `taskDeviations`。
