# 实现前的验证门（Risk Gates G-1…G-7）— 产物规范与判定器

**Feature**: `001-webgpu-terrain-mvp` ｜ **阶段**: Phase 2（tasks.md T014–T029）
**上游规格**: [tasks.md](../../specs/001-webgpu-terrain-mvp/tasks.md) Phase 2、[plan.md](../../specs/001-webgpu-terrain-mvp/plan.md)「实现前的验证门」、
[research.md](../../specs/001-webgpu-terrain-mvp/research.md) §11（H-1…H-10）、
[contracts/fork-patch-layer.md](../../specs/001-webgpu-terrain-mvp/contracts/fork-patch-layer.md)、
constitution v2.0.0 原则 I / 原则 V。

本目录回答一个**唯一的问题**：plan 里的风险假设（H-1…H-10）在当前工程现实中是否成立。
门禁**不是**实现任务：原型代码一律放 `experiments/gates/**`，**MUST NOT** 进入 `packages/**`、
不参与 Rollup 主包构建；门禁的结论才是 Phase 3+ 实现任务的输入。

---

## 1. 目录布局与命名

| 路径 | 内容 | 是否入库 |
|---|---|---|
| `experiments/gates/<id>-<slug>/**` | 门禁实现（构建脚本、桩实现、页面、fixture） | **入库** |
| `experiments/gates/out/<id>.json` | 门禁**判定产物**（机器可判定；唯一被 `--all` 校验的一层） | 不入库（`.gitignore`：`experiments/gates/out/`），由 CI 作为产物存档 |
| `experiments/gates/out/<id>-<slug>.json` | 门禁**中间证据**（直方图、录制序列、构建改写日志…） | 不入库 |
| `experiments/gates/out/<id>-<slug>.*` | 其他证据（日志、截图、diff 图、构建产物…） | 不入库 |
| `docs/gate-<id>-conclusion.md` | 人类可读结论（依据、证据路径、pass/fail、对后续任务的影响） | **入库** |

- `<id>` 为小写 `g1`…`g7`（与 `plan.md` 表格、`tasks.md` 任务正文一致）；`<slug>` 为小写短横线短语。
- **中间证据 vs 判定产物**：示例 —— G-6 的直方图为 `out/g6-variants.json`、像素精度为 `out/g6-precision.json`，
  而该门的**判定**写在 `out/g6.json`（`check-gate.mjs --gate g6` 校验的是后者）。
- `experiments/gates/*.mjs|*.ts|*.html|fixtures/**`（无子目录）是 **2026-09 被否决的"双画布分层"架构的归档产物**
  （见 commit `05e5bbc` 与 plan「Complexity Tracking」），**MUST NOT** 复用、**MUST NOT** 作为任何门禁的证据。
  本规范下的门禁一律自成目录。

## 2. 判定产物字段规范（`experiments/gates/out/<id>.json`）

| 字段 | 必需 | 类型 | 规则 |
|---|---|---|---|
| `gate` | ✅ | string | 与文件名一致（`g1`/`G-1` 均归一化为 `g1`） |
| `verdict` | ✅ | string | `pass` \| `fail` \| `partial`；**只有 `pass` 才允许进入 Phase 3** |
| `recordedAt` | ✅ | string | **ISO-8601 且带时区偏移**（`2026-09-19T10:00:00.000Z` 或 `+08:00`）；`Date.parse` 可解析 |
| `notes` | ✅ | string | 非空；写明**测了什么、结论是什么、边界在哪**（不得写"见上"/占位符） |
| `evidence` | ✅ | array | **非空**。元素为仓库相对路径字符串，或 `{ "path": "…", "what": "…" }`。路径 MUST 正斜杠、MUST 在磁盘上**真实存在** |
| `checks` | `pass` 时必需 | array | `{ "id": "…", "ok": true, "detail": "…" }`；`note`：`verdict==="pass"` ⇒ 每项 `ok===true` 且**逐条列出**；`fail`/`partial` ⇒ 至少一项 `ok===false` |
| `environment` | 推荐 | object | `node`、`platform`、`browser{channel,version,headless,launchArgs}`；**涉及 GPU 时 MUST 含 `adapter.info`**（`vendor`/`architecture`/…）与 `preferredFormat` |
| `task` | 推荐 | string | 产出该门禁的 tasks.md 任务号（如 `T015`） |
| `measurements` / `summary` / `artifacts` / `declaredDifferences` / `gateCriteria` | 可选 | any | 门禁自有的证据载荷；判定器不解释其语义，只要求它真实可复现 |

**证据的真实性要求（不可协商）**：

1. **结论不得只写结论**：每个 `verdict` MUST 附带**可复现**的证据路径；路径不存在即判定失败。
2. 证据 MUST 由本次运行**真实产生**（`recordedAt` 为本次运行时间），MUST NOT 手工编造或复制历史运行的数字。
3. 环境相关的结论（GPU/浏览器/适配器）MUST 写明实测值；环境不具备时 MUST 显式记录为环境限制，
   **不得**用它掩盖失败，也**不得**因此放宽判据。
4. 重跑命令 MUST 能在仓库中直接执行（Node 跨平台；`MUST NOT` 依赖 `pwsh` / Unix 文本工具 / 本机绝对路径）。
5. **不得为通过门禁而放宽判据**（阈值、容差、白名单 MUST 与 plan/contracts 一致；差异 MUST 按其来源逐项声明）。
6. 涉及私有成员（如上游 `@private` 的 `scene._context`）时，其引用**仅允许出现在门禁断言**里，
   **MUST NOT** 进入实现路径（`packages/**`）。
7. 涉及构建链的门禁 MUST 断言**上游磁盘零改动**（`node_modules/@cesium/engine/**` 的文件哈希在门禁前后一致）。
8. 与 `tasks.md` 描述不符的现实 MUST 如实记录为**实现偏离**（写入 `checks` 与结论文档），
   **MUST NOT** 静默改需求或改判据。

## 3. 判定器

```text
node tools/scripts/check-gate.mjs --all            # 校验 out/ 全部判定产物，并要求 g1…g6 存在
node tools/scripts/check-gate.mjs --gate g1        # 校验单个门（G-1 / g-1 / g1 等价）
node tools/scripts/check-gate.mjs --gate g1,g5 --json
node tools/scripts/check-gate.mjs --all --dir <dir> --root <dir>   # 测试/自定义位置
```

- 退出码：`0` 全部存在、结构合法且 `verdict === "pass"`；`1` 任一缺失/不合法/非 `pass`；`2` 调用方式错误。
- `--all` **要求 Phase 2 的 `g1`…`g6` 齐备**；`g7` 不在必需集合内（其结论按 plan 在 **T127**（Phase 10）落盘，
  由 **T098b** 消费，见 tasks.md Phase 2 说明）。
- 判定器**不判断科学正确性**（那是各门禁自己的事），只强制：结构、结论与检查项一致、证据真实存在。
- 任一门禁 `verdict !== "pass"` ⇒ **STOP**：MUST NOT 开始 Phase 3 及之后的实现任务；
  由**入口 Agent** 依据该门的失败动作修订 `plan.md`（阶段子代理 MUST NOT 自行修改
  `plan.md` / `contracts/**` / `spec.md`）。

## 4. 门禁清单

| 门 | 假设 | 任务 | 实现目录 | 判定产物 | 结论文档 | 失败动作（plan） |
|---|---|---|---|---|---|---|
| G-1 接缝可替换性 | H-1 | T014, T015 | `experiments/gates/g1-alias/` | `out/g1.json` | `docs/gate-g1-conclusion.md` | 切换整仓 fork（F1），补丁清单与审计方式不变 |
| G-2 设备交接与同步构造 | H-2 | T016, T017 | `experiments/gates/g2-handoff/` | `out/g2.json` | `docs/gate-g2-conclusion.md` | 逐项修正能力表并补测试；无法诚实回答的标志降为 `false` 并登记 |
| G-4 uniform 布局一致性 | H-4 | T018, T019 | `experiments/gates/g4-uniform-layout/` | `out/g4.json` | `docs/gate-g4-conclusion.md` | 退化为"每标量一个 vec4 槽"的保守布局 |
| G-3 通道状态机正确性 | H-3 | T020, T021 | `experiments/gates/g3-pass-trace/` | `out/g3.json` | `docs/gate-g3-conclusion.md` | 后端层内部引入显式通道提示，或 `endFrame` 前强制拆通道 |
| G-5 着色器编译前端 | H-5/H-6 | T022–T024 | `experiments/gates/g5-shader/`（+ `tools/shader-verify.mjs`） | `out/g5.json` | `docs/gate-g5-conclusion.md` | 启用尖刺退路三（WGSL 库与 `.glsl` 并存）并写入 rebase 演练 |
| G-6 变体规模与像素一致性 | H-6/H-7 | T025–T027 | `experiments/gates/g6-variants/`、`g6-precision/` | `out/g6.json`（+ `g6-variants.json`/`g6-precision.json`） | `docs/gate-g6-conclusion.md` | 收敛 MVP define 子集；差异按来源显式声明（禁止"任意差异通过"） |
| G-7 CI 两路径可运行性 | H-8/H-9 | T028, T029（结论 T127） | `.github/workflows/ci.yml` 等 | `out/g7.json` | `docs/ci-degradation.md`、`docs/gate-g7-conclusion.md` | 缩减采样与分片；增加真机冒烟作业；绝对性能移交受门控作业 |

## 5. 自检

```text
node --test "tests/unit/**/*.test.mjs"     # 含 tests/unit/check-gate.test.mjs（判定器正/反例）
node tools/scripts/check-gate.mjs --all    # Phase 2 Checkpoint（g1…g6 全 pass）
```
