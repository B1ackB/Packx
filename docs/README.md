# Packx 文档导航

整理日期：2026-09-22。文档按用途组织；机制文档说明当前行为，ADR 记录决策，日期报告保留当时证据。历史报告的测试数量、产品范围和待办不自动代表当前实现。

## 按问题找文档

| 想解决的问题 | 主文档 | 决策／证据 |
| --- | --- | --- |
| 产品到底做什么、分层怎么划分 | [产品交互](product-interaction-model.md)、[架构原则](architecture/principles.md) | [仓库约束](../AGENTS.md)、[包装范围 ADR-0010](adr/0010-packaging-product-focus.md) |
| 模型如何执行一轮、接入哪些能力 | [Runtime 接入](runtime-integration.md)、[Provider 兼容](anthropic-compatibility.md) | [最小 Core ADR-0001](adr/0001-self-owned-agent-core.md)、[依赖清单](dependencies.md) |
| 历史太长、摘要丢信息、恢复读到旧资料 | [上下文管理](context-management.md) | [分离对话与任务上下文 ADR-0024](adr/0024-separated-dialogue-and-versioned-task-context.md) |
| 长期偏好怎么确认、修改与遗忘 | [记忆系统](memory-system.md) | [个人记忆 ADR-0026](adr/0026-confirmed-personal-memory-and-context-dependency.md) |
| 报错后谁重试、哪些操作不能重做 | [错误处理与恢复](reliability-recovery.md) | [恢复 ADR-0025](adr/0025-evidence-bound-recovery-and-explicit-degradation.md) |
| 哪些节点可以回滚、哪里仍有缺口 | [40 节点故障审计](failure-handling-audit.md) | [Harness 故障测试记录](harness-error-handling-tests.md) |
| Plan、子任务、重规划怎样受控 | [Plan 模式](plan-mode.md) | [ADR-0015](adr/0015-confirmed-plans-and-bounded-subagents.md)、[停止与预算 ADR-0023](adr/0023-loop-guards-and-task-plan-budgets.md) |
| Reviewer 能改什么、如何防止无限反思 | [需求单证据复核](requirement-evidence-review.md) | [业务完成原则](architecture/principles.md) |
| 如何衡量完整需求澄清任务是否完成 | [任务集与评分协议](../eval/fixtures/requirement-intake-v1/README.md)、[执行与评分](requirement-intake-evaluation.md) | [16 个独立合成案例](../eval/fixtures/requirement-intake-v1/CASEBOOK.md)、[首轮真实模型基线](evidence/requirement-intake-baseline-2026-09-25.md)、[逐项修复与复测](evidence/requirement-intake-repairs-2026-09-25.md) |
| 暂无人工评审时如何评测，哪些证据仍缺失 | [自动任务评测与可靠性计划](task-evaluation-plan.md)、[自动任务协议](../eval/fixtures/requirement-automatic-v1/README.md) | [真实模型任务对照](evidence/automatic-online-2026-09-26.md)、[复核输出与费用](evidence/review-output-2026-09-26.md)、[位置与动作边界](evidence/review-boundary-2026-09-26.md)、[精简指令与传输停止](evidence/review-concise-2026-09-26.md)、[联网前验证](evidence/automatic-eval-2026-09-26.md)、[历史结果审计](evidence/requirement-intake-automatic-audit-2026-09-26.json) |
| 资料如何检索、来源是否适用 | [知识系统入口](knowledge/README.md)、[证据规则](knowledge/evidence.md) | [RAG ADR-0018](adr/0018-packaging-evidence-retrieval.md)、[重排对照](knowledge/overlap-rerank.md) |
| 如何运行、备份、排障、发布本地包 | [本地运维](local-operations.md)、[启动与发布](release-start.md)、[配置](api-configuration.md) | [本地交付工作单](local-product-completion.md) |
| 下一步优先做什么 | [路线图](roadmap.md)、[用户验证模板](user-validation-template.md) | [项目决策](project-decisions.md) |
| 如何核对原文、记录人工试用与复现进程中断 | [试用协议与记录入口](user-validation-template.md) | [本轮产品验证](evidence/requirement-review-2026-09-26.md)、[进程终止原始记录](evidence/process-recovery-2026-09-26.json) |

## 阅读优先级与维护方式

发生描述冲突时，先看当前代码／测试确定已实现行为，再看 AGENTS 和 ADR 判断是否符合设计约束；约束不是实现证明。发现偏差应记录，不把原则描述当成代码已经保证。

- `milestone-*`、`evidence/` 及带日期实验：阶段／实验快照，保留原日期和原数字。
- `adr/`：为什么做出这个决定、替代方案和边界；不用于承诺所有规划已完成。
- 主题机制文档：实现、入口、运维与限制的主要解释。

这次通过统一导航和专题归纳整理文档，保留原文件路径与历史证据，避免移动文档使已有引用失效。
