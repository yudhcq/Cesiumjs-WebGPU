# Contract: 受控 fork / 补丁层（Controlled Fork — Patch Layer）

**Feature**: `001-webgpu-terrain-mvp` | **Status**: 设计基线 v2 | **Spec**: [../spec.md](../spec.md) | **Research**: [../research.md](../research.md) §1/§2/§6.3
**Constitution**: v2.0.0 原则 I（受控 fork，NON-NEGOTIABLE）与原则 V（CI 为唯一事实来源）

本契约定义本项目**如何承载对上游渲染后端的改动**，以及"改动只在渲染后端层、逻辑层字节不变"如何被**机器证明**。
它是 FR-031 / FR-032 / SC-010 的可执行落地形态。

---

## 1. 形态与基线

| 项 | 规定 |
|---|---|
| 上游载体 | `@cesium/engine`，**精确版本** `26.3.0`（= `cesium@1.145.0`；`index.js` 置 `CESIUM_VERSION="1.145.0"`） |
| 钉版方式 | lockfile 精确版本 + **integrity 哈希**；`upstream/engine-26.3.0.lock.json` 记录 `version`/`integrity`/`cesiumVersion`/`license`/`recordedAt`/`notes` |
| 改动形态 | **模块级替换补丁层（patch layer）**：上游包**原样安装、磁盘上零改动**；构建期由别名插件把清单内的模块替换为本仓库实现 |
| 为何不用整仓 fork | 逻辑层"字节不变"由依赖完整性天然保证，升级成本从 git 冲突变为**接口清单差异**（可提前量化）；整仓 fork 保留为 H-1 失败时的退路（形式与审计方式不变） |
| 交付形态 | 主交付为**预打包 ESM 产物**（`dist/` 内含经替换的上游引擎源码）；同时提供别名插件供消费方自行打包（等价形态） |

## 2. 替换清单（manifest）

`packages/cesium-webgpu/backend-webgpu/manifest.json`：

```json
{
  "baseline": { "packageName": "@cesium/engine", "version": "26.3.0", "cesiumVersion": "1.145.0", "integrity": "sha512-…" },
  "entries": [
    { "upstreamModule": "Renderer/Context.js", "localFile": "Renderer/Context.js", "kind": "replace",
      "requirementRef": ["FR-030", "FR-031"], "reason": "WebGPU 设备/交换链/能力/绘制分派", "glCallSites": 46 }
  ],
  "keptModulesHash": "sha256-…"
}
```

**硬性规则**：

1. 每个 `upstreamModule` MUST 匹配 `^Renderer/[A-Za-z0-9_]+\.js$`（**补丁边界**）。
2. 每个条目 MUST 有非空 `requirementRef` 与 `reason`（补丁最小性、可追溯到需求）。
3. `kind` 取值（四类，`kind` 字段必须存在且参与断言）：
   - `replace`（WebGL 调用点重实现）
   - `adapt`（GL 资源语义适配）
   - `adapt-shader`（着色器编译目标参数化）
   - `stub-not-implemented`（**显式失败桩**：本切片不实现，调用即抛出可诊断错误。
     本增量中 `Texture3D` / `CubeMap` / `CubeMapFace` / `TextureAtlas` / `Sync` 五者属此类，
     计入"16 个必替换"总数；**`glCallSites > 0` 的断言只适用于 `replace`**，MUST NOT 施加于本类）。
4. `keptModulesHash`：对 `Renderer/**` 中**未列入清单**的上游模块计算的内容哈希集合，用于发现"上游悄然改动我们仍依赖的文件"。
5. 清单**只增不改**：删除条目 MUST 在 PR 中给出理由（例如上游提供了公开接缝）。

## 3. 别名插件（构建期替换）

`tools/rollup-plugin-engine-patch.mjs`：在 `resolveId` 钩子中，把**解析后的绝对路径**
`<node_modules>/@cesium/engine/Source/Renderer/<X>.js` 改写为 `backend-webgpu/Renderer/<X>.…`（当且仅当 `<X>.js` 在清单内）。

- `@cesium/engine` **无 `exports` 映射**（实测），深路径可解析 → 规则简单；
- 改写依据是**解析后的路径**，因此对 `index.js` 的再导出、包内相对导入、消费方的裸导入一律生效；
- 插件 MUST 提供"白名单穷举"模式：喂入 `Source/**` 的全部模块路径，断言**被改写的集合恰好等于清单集合**（不遗漏、不额外）。

## 4. 边界审计（CI 门禁，产出为 CI 产物）

`tools/audit-patch-scope.mjs` 输出 `PatchScopeAudit`（字段见 [../data-model.md](../data-model.md) §1.3）：

| 断言 | 内容 | 失败含义 |
|---|---|---|
| `integrityOk` | 安装物完整性哈希 == 基线记录 | 上游被意外改写（含 postinstall 篡改） |
| `manifestPathsValid` | 全部 `upstreamModule` 匹配 `^Renderer/` | 补丁越出渲染后端层（违反原则 I） |
| `aliasWhitelistExhaustive` | 被改写路径集合 == 清单集合 | 别名插件漏改/多改 |
| `logicLayerOverrides == 0` | 构建产物中来自本仓库的 `Renderer/**` 之外的上游模块数 | 逻辑层被覆盖（违反 SC-010） |
| `keptModulesUnchanged` | `keptModulesHash` 一致 | 上游漂移影响未评估 |

任一失败即**阻断合入**；审计 JSON MUST 作为 CI 产物存档（原则 V）。

## 5. 着色器编译前端（本契约新增的核心条款）

**背景（实测，见 [../../experiments/shader-spike/REPORT.md](../../experiments/shader-spike/REPORT.md)）**：
上游把 `#define/#ifdef/#if` 作为**文本**交给 GL 驱动求值（`Renderer/ShaderSource.js:250-258`），
WebGPU 侧没有驱动代劳；且 WGSL 的 varying 匹配是硬校验（片元输入无对应顶点输出 ⇒ `createRenderPipeline` 失败）。

**路线（已定案）**：不转译 GLSL，改为在 fork 层**换发射目标**——`ShaderSource` 参数化为
`emit: "glsl" | "wgsl"`（输入 `sources`+`defines` 与变体机制不变），WGSL 由本项目发射器产出。

| 规则 | 内容 |
|---|---|
| R1 | `ShaderSource.js` 进入清单，`kind: "adapt-shader"`；改动 MUST 限于"增加 WGSL 发射通道 + 导出装配所需内部件"，**GLSL 视图与预处理语义 MUST 不变** |
| R2 | **逻辑层可见性不变**：`shaderProgram.vertexShaderSource` / `fragmentShaderSource` 暴露的 MUST 仍是原始 GLSL（`Scene/Primitive.js:849,1011-1012,1018,1020` 用正则探测 GLSL 文本），`_attributeLocations` MUST 保留 |
| R3 | WGSL 库位于后端层（`backend-webgpu/webgpu/wgsl/**`、`wgsl-prelude/**`），**MUST NOT 写入 `Source/Shaders/**`**；与上游的关联由 `shader-leaf-map.json`（叶子文本哈希 → WGSL 文件）承担 |
| R4 | 条件编译求值（含 `&&`/`\|\|`/`!`/括号、`#elif` 链、算术条件如 `#if TEXTURE_UNITS > 0`）由本项目实现，MUST 与上游"先内联 `czm_`、后条件求值"的顺序语义一致 |
| R5 | varying 集合 MUST 按变体成对推导（VS 输出 = FS 输入），并以真机 `createRenderPipeline` 断言；不匹配即失败 |
| R6 | 运行时生成的着色器片段（如 `GlobeSurfaceShaderSet.js:419-472` 的 `computeDayColor()`，磁盘上不存在）由后端层**镜像生成器**按同参数产出 WGSL；覆盖度按"可达参数组合"计数验收 |
| R7 | 上游叶子哈希变化 ⇒ `shader-leaf-map.json` 失配 ⇒ CI 失败并输出"须重做转换"清单（升级漂移检测） |
| R8 | 转换工具链版本 MUST 锁定：`glslang 16.6.0`（官方预编译包）、`naga-cli 30.0.1`（`cargo install naga-cli --locked`，无预编译二进制）、`@webgpu/glslang 0.0.15`（MUST 用 `dist/web-devel-onefile`，默认 Node 入口实测挂死）。工具链**只用于一次性转换与 CI 校验**，不进入运行时 |
| R9 | `ShaderBuilder.js` 在 MVP **保持字节不变**（其 WGSL 化属切片 C）；模型/体素/高斯泼溅路径在 MVP 下 MUST 以显式可诊断错误失败 |

**MVP 覆盖范围**：`GlobeVS` / `GlobeFS` / `AtmosphereCommon` / `GroundAtmosphere` + 约 40 个 `czm_` 内建（地形闭包）。
**全库 319 个 `.glsl` / 244 个 `czm_` 内建**的完整覆盖 ≈2–4 人月（尖刺外推，未逐家族实测），**不在本增量**。

## 6. 升级（rebase）演练

`tools/upgrade-drill.mjs`，两种模式（CI 中"干跑"默认执行，"完整"仅升级 PR）：

| 步骤 | 内容 | 产物 |
|---|---|---|
| 1 | 取上游新版 tarball（仓库外临时目录），与基线比较 `Renderer/**`、`Shaders/**` 的哈希 | 上游漂移清单 |
| 2 | 由新版重新生成 `InterfaceManifest`（被依赖符号 + 签名 + 逻辑层消费点）并与基线 diff | `InterfaceManifestDiff`（**= 改造清单**） |
| 3 | 重算 `keptModulesHash` 与 `shader-leaf-map.json` 的叶子哈希 | 失配清单（须重做转换的叶子） |
| 4 | 跑全量验证：两条后端路径的契约/视觉/基准 | `VerificationRun[]` |
| 5 | 判定 | `UpgradeDrillRecord`：**补丁范围审计 + 接口一致性 + 全量验证三项齐备**才可 `pass`（原则 I 要求） |

**升级验收判据**：`UpgradeDrillRecord.verdict === "pass"`，且产物随 PR 存档。
**干跑模式**（无网络）用已提交清单离线校验，保证 CI 每次提交都能发现清单内漂移。

## 7. 许可证与署名（Apache-2.0）

| 项 | 规定 |
|---|---|
| 本项目许可证 | **Apache-2.0**（与上游一致，避免条款冲突） |
| 上游许可 | `LICENSE.md`（Copyright 2011-2024 CesiumJS Contributors）随交付物保留 |
| NOTICE | MUST 声明"本产品包含 CesiumJS Contributors 开发的软件"，写明上游基线与版本，并**逐条列出被重实现的文件**（Apache-2.0 §4(b)） |
| 派生文件 | 从上游移植/改写的文件 MUST 保留原始版权头，并加"Modified for WebGPU backend"注记 |
| CONTRIBUTING | MUST 写明补丁边界规则（改动只能落在 `Source/Renderer/**`、清单需 `requirementRef`、上游内部改动须走升级演练） |
| CI | 许可证与依赖检查、NOTICE 完整性、修改文件清单与 manifest 一致性 MUST 纳入 CI（FR-024、原则 V） |

## 8. CI 门禁顺序（本契约相关部分）

```text
1) install（锁定版本 + 完整性校验）
2) build（别名插件生效；断言产物中逻辑层模块来源为上游原文件）
3) unit：别名白名单穷举、manifest 规则、shader-leaf-map 完整性、条件编译求值用例
4) audit：PatchScopeAudit（§4）+ 许可证/NOTICE
5) shader：WGSL 语法/模块校验（CI 无 GPU 时用 naga --input-kind wgsl；**盲区：不覆盖 WebGPU 管线校验**）
6) contract/visual/bench：两条路径各自独立运行（见 verification-and-benchmark 契约）
7) upgrade-drill（干跑）
```

**盲区 MUST 显式记录**（FR-023）：CI 无 GPU 时 WGSL 只做模块级校验，**varying 契约、绑定布局、管线兼容性只在真机
`createRenderPipeline` 暴露** → 本机/自托管真机 harness 为必需补充手段，`docs/ci-degradation.md` 给出复现步骤。

## 9. 违反本契约的典型形态（MUST NOT）

- 直接修改 `node_modules/@cesium/engine/**`（含 postinstall 脚本改写）；
- 在 `Source/Shaders/**` 放置转换后的 WGSL 或替换上游着色器模块；
- 让逻辑层 `import` 到 `backend-webgpu/**` 的具体实现（须经抽象接口）；
- 把 WGSL 发射写进逻辑层可见的对象（改写 `shaderProgram.vertexShaderSource` 的内容）；
- 在清单之外新增替换条目而不更新 `requirementRef`/`reason`/审计断言。
