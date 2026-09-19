# 协作契约：Spec-Driven Development（Spec Kit）

本项目已完成 `specify init --integration dsh`（Spec Kit v1.0.8）。Spec Kit 命令以 DSH 技能形式存在于
`.dsh/skills/speckit-*/SKILL.md`，用户可用 `/speckit-*` 直接调用。**所有新增需求一律走 Spec Kit，不直接改代码。**

## 1. 角色

- **入口 Agent**（与用户对话的主 Agent）：澄清需求 → 路由阶段 → 派发子代理 → 审阅产物 → 汇报。
- **阶段子代理**：只执行一个阶段。子代理看不到主会话历史，派发提示词必须自包含。
- 子代理与入口 Agent 共享工作区、技能目录和本文件。

## 2. 工作流

| 阶段 | 技能 | 产物 |
|---|---|---|
| 0 原则 | `speckit-constitution` | `.specify/memory/constitution.md` |
| 1 规格 | `speckit-specify` | `specs/NNN-<name>/spec.md` |
| 1.5 澄清 | `speckit-clarify` | 更新 `spec.md` |
| 2 方案 | `speckit-plan` | `specs/NNN-<name>/plan.md` 等 |
| 2.5 清单 | `speckit-checklist` | `checklists/*.md`（按需） |
| 3 任务 | `speckit-tasks` | `specs/NNN-<name>/tasks.md` |
| 3.5 校验 | `speckit-analyze` | 一致性分析报告 |
| 4 实现 | `speckit-implement` | 代码 + 勾选 `tasks.md` |
| 补漏 | `speckit-converge` | 追加任务到 `tasks.md` |

默认顺序 `1 → 1.5 → 2 → 3 → 3.5 → 4`；阶段 0 仅首次或原则变更时执行。
每阶段产物由入口 Agent 审阅，不合格则退回重跑，不得进入下一阶段。**未经 `speckit-analyze` 通过，不进入实现。**

## 3. 派发子代理

`specify → plan → tasks` 强依赖，必须串行；无依赖的阶段可并行派发。

每次派发必须使用 `subagent`，并在提示词中给出：`SKILL`（技能名）、`ARGUMENTS`（该技能 `$ARGUMENTS` 的完整文本）、
`FEATURE_DIR`、上游产物路径、完成判据，并要求子代理先加载技能 `speckit-phase-runner` 遵守其执行与汇报契约。

## 4. 汇报格式（精简、准确）

≤10 行：`状态` / `产物`（相对路径）/ `决策`（≤3）/ `风险`（≤3）/ `待澄清`（≤3）/ `下一步`（一句话）。
禁止复述技能正文、粘贴文件全文、空话铺垫、未经验证的断言。每条结论须可追溯到文件路径或命令输出。

## 5. 审批授权

**入口 Agent 自行放行：** 文档产物（spec / plan / tasks / checklists / 分析报告）；用行业惯例或模板默认值
可解决的歧义（写入 Assumptions）；阶段内返工、任务排序、测试与构建修复循环；已批准计划内的实现细节。

**必须上报用户：**

- 修改 `.specify/memory/constitution.md`
- 需求范围变更：增删用户可见功能、修改成功判据
- 不可逆/破坏性操作：`git push --force`、改写历史、删除 `specs/` 外文件、删数据、覆盖未提交改动
- 影响范围/安全/体验且无合理默认的 `[NEEDS CLARIFICATION]`
- 阶段间重大偏差：plan 与 spec 冲突、implement 无法满足 plan
- 需要凭据、外部账号、付费资源或联网下载
- 同一阻塞连续 2 次修复失败

上报须给"结论 + 选项 + 建议"，不要只抛问题。

## 6. 环境

工作区 `E:\work\CesiumjsWebGpu`（git，分支 `main`）；脚本 `.specify/scripts/powershell/*.ps1`；
`specify` 在 PATH（1.0.8）；`.specify/feature.json` 记录当前 feature（本机状态，已 gitignore）。
自检：`specify integration status`、`git status`。测试环境：Chrome 153 + RTX 4080 SUPER，
headless 下零参数即拿到硬件 WebGPU 适配器；Node 22；单测必须用
`node --test "tests/unit/**/*.test.mjs"`（`node --test tests/unit` 裸目录在 Node 22.20 不可用）。

## 7. 并行与共享工作区（W5 起的硬规则）

- **同一时刻只允许一个"改产品代码"的代理在飞**：凡会改 `packages/cesium-webgpu/src/**`
  或 `backend-webgpu/**` 的任务 MUST 串行；只写测试文件的代理可以并行。
  原因：`tests/contract/page/entry.js` 把 `src/index.ts` 编进契约 bundle，于是**任何** `src/**` 的
  在飞状态（哪怕只是暂时的 TS 错误）都会让**所有**契约套件构建失败，白白烧掉其他代理的预算。
- **套件执行天然串行**：`tests/support/backend-runner.mjs` 用 `tests/support/suite-lock.mjs` 做跨进程锁
  （同一台机器同一时刻只跑一个套件）；等锁不是故障。`SUITE_LOCK_WAIT_MS` / `SUITE_LOCK_STALE_MS` 可调。
- **一场景一文件**：页面侧场景放 `tests/contract/page/scenarios/<scenario>.js`，default-export
  `(bundle, canvas, ctx)`，**不得 import 任何东西**（import `probe.js` 会重跑它的 `main()`）；
  helper 由 `ctx` 显式传入，套件→场景映射在 `tests/support/contract-harness.mjs` 的 `SUITE_SCENARIOS`。
- **别人的在飞状态导致的失败**：不要改别人的文件、不要放宽自己的断言；等 60–90 s 原样重试（≤3 次），
  并把"该臂未取得独立证据 + 原因"如实写进汇报，**不得**标成通过。

