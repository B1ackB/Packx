# 2026-10-20：只读计划冻结输入依赖的本地验收

后续状态：历史工具/文件来源复核已在 [ADR-0042](../adr/0042-completed-tool-source-review.md) 本地切片接入；本记录保留此前阶段的范围、测试及当时未提交状态。本次用户另行授权全部必要变更验证后本地提交，仍不对远端发布。

远端 main 再次 fetch，仍为 `42ff79c8a8e680ab436c170ca2d6f1aaab4e7b1d`（PR #55）。沿用独立工作区 `/Users/black/Documents/Codex/2026-10-19/task/packx-readonly-result-validity`、分支 `codex/readonly-result-validity`；上一阶段 20 个未提交文件逐项校验并备份后继续增量开发。原目录 179 个未提交文件保留。没有提交、推送、创建 PR、合并、部署或调用付费模型。

## 代码事实与阶段选择

上一阶段已补齐完成结果 stale、导入阻断和显式新确认。本阶段补其明确遗漏：规划上下文含有未确认候选，但完成态只筛已确认 Fact；新增六项回归先实际失败，均收到 completed 而不是 stale。Runtime 内已有工具来源恢复校验，但其异步递归接口尚未接入完成态读取，所以本轮只实现冻结任务输入的依赖清单，不同时扩展 Runtime 或文件来源接口。

见 [ADR-0041](../adr/0041-frozen-plan-input-dependencies.md)。新只读提案在等待确认前持久记录 Fact/Artifact 身份、版本、摘要与其余输入摘要；包括已有 suggested/unverified/rejected，保留原状态。完成后按原身份集合复核，原输入变化过期；后续新增草稿/确认不是旧输入。旧计划不补造清单，维持原有校验。使用既有事件与 CAS，不增加执行预算或权限。

## 实际验证

以下均为本地实际执行结果；不是本轮远端 CI。Node 24.14.0，未新增依赖，执行环境通过仓库现有过滤器。

| 检查 | 实际结果 |
| --- | --- |
| 完整 core、类型及构建 | 1,308 通过、0 失败、50 个既有条件跳过，共 1,358 项；类型与构建通过 |
| 12 项离线 Eval | offline、context、recovery、loop-safety、memory、m1、m2、plan、plan-graph、plan-parallel、source-report、packaging-lifecycle 全部通过 |
| 固定串行/并行对照 | 同图、模型与预算，输出均为 11、均 4 次 fixture 调用；并行最多两项独立读取重叠；冻结候选变化后追加 stale，复核/重复读取无新调用 |
| 完整浏览器 | 60/60 通过，0 失败/跳过/flaky；桌面中文、390px 中文、320px 英文，覆盖确认前冻结版本及未验证提示，既有过期/重新规划流程继续通过 |
| macOS native 与真实 Host | 48/48 原生安全回归通过，0 跳过；完整真实 Host HTTP 应用流程通过，上限修正后再次完整运行应用流程通过 |
| 故障与恢复 | 六项基线缺陷全部修复；持久清单、Host 重启、重复读取、旧计划不回填、记录重排、拒绝无效/重复/超量清单、原始结果与计数保留通过；既有独立节点重叠、依赖等待、单节点失败、取消、重复派发、来源撤回与恢复通过 |
| 安全与保护 | 工作流语法/权限/路径政策通过；扫描负对照通过，跟踪树、完整 Git 历史和含全部新文件的候选树均无凭证发现；依赖审计所有严重度均 0；差异、相对文档链接和原目录 179 项内容/权限/状态检查通过 |

core 跳过的 50 项为 38 项 macOS 原生条件项、12 项 Windows 条件项；macOS 正式 native 入口另执行全部 48 项，本轮没有 Windows runner。浏览器使用固定 API 数据，真实持久化/确认/导入证据来自 Host HTTP；没有把截图或 fixture 数量当作模型质量证据。

基线六项失败留在 `/private/tmp/packx-source-dependencies-2026-10-20/baseline.log`，期望 stale、实际 completed。首轮实现通过后，审查发现 128 项上限不应约束后来新增的无关记录；将上限限定到冻结集合，并补 128 项新增下游记录不使旧结果过期的回归，再重跑完整 core、浏览器、类型/构建、12 项 Eval 和应用流程。没有放宽断言、CI、来源权限、网络地址校验或 TLS。

同目录保留 `targeted*.log`、`core.log`、`core-final.log`、`browser-final.log`、`native.log`、`product-final.log`、`policy.log`、`secrets.log`、`audit.log`、候选扫描报告与清单；`previous-stage/`、`previous-stage.diff` 和 `previous-stage-scope.json` 保留继续开发前的 20 文件快照。日志与备份只在本机，不纳入仓库。

官方额度本轮读取为已用 28%、剩余约 72%，高于至少保留 15% 的要求；未购买、重置或调用付费模型。

## 应用级验收与演示

使用 Node 24.14.0 及仓库 CI 环境过滤，真实 Host、HTTP、本地认证、Queue、Runtime、Artifact 和持久存储；模型为本机固定 Provider。

1. 两项独立只读任务及依赖汇总完成；撤回报告使旧结果过期，重启/重选不能复活，重新规划并确认新图。
2. 将完成的新图导入未验证需求单；等待候选草稿生成。新增草稿不反向使该图过期。
3. 再生成计划，确认前检查界面的“冻结输入版本”和 API 中的 key/version/hash 清单；清单包含此时已有的候选与 Artifact。明确确认后执行，等待完成。
4. 真正退出并重启 Host，确认清单与结果保持。人工确认冻结候选中的一个字段；该 Fact 新版本使最新 Plan 持久过期。旧结果及清单保留，重复读取不重复事件，导入被拒绝，全程无新模型调用。

可复现命令：

```sh
node --import tsx scripts/ci.ts core
node --import tsx scripts/ci.ts browser
node --import tsx scripts/ci.ts native
npm run dev:fixture
```

交互用 `parallel-fixture-success` 的固定图并选择资料报告；需求单候选进入下一次计划的上下文后才成为该计划的依赖。此流程不证明真实模型推理质量或员工使用收益。

## 延期及未验证

完成后的历史工具/文件来源持续复核、节点独立 lease、跨图并发、公平性、任意业务依赖、并发写入、代码执行和精确费用预算均未实现。公网读取仍默认关闭且正向未验收。本轮无实际远端 CI、Windows runner、真实模型或真实用户验证。上一阶段记录和 PR #55 的既有 CI 只是基线证据。


## 变更范围

本工作区累计 24 个未暂存、未提交文件（包含上一阶段结果过期闭环）。本轮相对上阶段快照增量修改 19 项，其中新增依赖记录模块与 ADR/本记录，并扩展既有离线验收；架构、README、演示、状态 Schema、UI 和回归同步。`eval/planParallel.ts` 是既有文件，本轮扩展，不是新增评测框架。

```text
README.md
README.zh-CN.md
docs/README.md
docs/adr/0040-completed-readonly-result-validity.md
docs/adr/0041-frozen-plan-input-dependencies.md
docs/evidence/readonly-input-dependencies-2026-10-20.md
docs/plan-mode.md
docs/workspace-agent-architecture.md
docs/workspace-agent-delivery.md
eval/planParallel.ts
eval/productSmoke.ts
server/enterprise/agentPlanWorkflow.ts
server/enterprise/parallelPlanWorkflow.test.ts
server/enterprise/planInputDependencies.ts
src/components/PlanPanel.tsx
src/enterprise/agentPlan.test.ts
src/enterprise/agentPlan.ts
src/i18n.ts
tests/browser/planParallel.spec.ts
```

其余五项前阶段文件完整保留：`server/index.ts`、`server/manufacturing/planRequirementSource.ts`、对应测试、2026-10-19 结果过期验收及其截图。完整累计范围由本机 `scope.json` 的 24 项路径/摘要/权限清单约束；没有暂存、提交、远端写入或部署。
