# 代码索引、证据口径与本次验证

[返回总入口](README.md)。核查日期：2026-09-22，Node v24.14.0。当前 HEAD `4df7f4d0b86fdd047cb051d76cc35db84b1e07f8`，但工作树开始时已经存在后台／Provider／Runtime／知识索引等未提交改动及四个 audit 测试文件。本次答案基于**整个当前工作树**，不是该 HEAD 单独检出的结果。

## 本次实际执行

| 命令 | 本次结果 | 能证明什么 |
| --- | --- | --- |
| `npm run check` | exit 0；77 文件，572 通过、21 条件跳过；TypeScript 与 Vite 构建通过 | 现有本地单元／集成及编译范围 |
| `npm run eval:context` | exit 0 | 固定 110 组工具输出、多轮压缩场景的约束／引用／版本保留 |
| `npm run eval:memory` | exit 0 | 真实 SQLite／Session／Runtime 配合 Fake 的确认／修订／撤回／重启机制 |
| `npm run eval:recovery` | exit 0 | 两种文件未决状态对账及两种检索降级行为 |
| `npm run eval:plan` | exit 0 | 确认前零子任务执行、独立上下文、阻塞检查点与重新确认 |
| `npm run eval:loop-safety` | exit 0 | 重复动作、短周期、连续失败停止与正常场景保留 |

原始五组 Eval 输出以及检查摘要保存在 [validation-2026-09-22.json](validation-2026-09-22.json)。该文件是本次复跑记录；未用 `--write` 覆盖以前的专题报告。

本次没有跑 `check:local` 整条命令，没有重跑原生专项、HTTP product smoke、浏览器验收、真实 RAG benchmark、付费模型或 Online Eval；未读当前用户业务库来确认实时库存或配置，没有重启日常 Host。历史文档里的上述结果仍按原日期引用，不能移到本次执行栏。所有本次模型评测是确定性 Fake，付费模型调用为 0。

## 专题指标的正确解读

| 机制 | 本次固定结果 | 不可推出的结论 |
| --- | --- | --- |
| Context | 4 条指定约束、2 个来源引用、当前 Fact v2 保留；候选估算 34,313 → 4,355 Token；旧方案最终 4,057 但丢指定信息 | 真实模型摘要准确率 100%、总体 token 或费用降低相同比例 |
| Context 额外成本 | 基线 3 次摘要生成；候选 4 次生成＋4 次 Count | 摘要“免费”或主请求变短就总成本更低 |
| Memory | 无记忆召回 0；确认后召回 1；修订正确、撤回后派生输入移除；UI 8 条消息；四轮各保留四条约束 | 模型提炼和遵循偏好已达到业务标准 |
| Memory 调用 | 主生成 4 次；额外记忆提炼／embedding 0 次 | 记忆不增加输入 Token 或存储成本 |
| Recovery | started 与 unknown 两类样例未决数各 1 → 0；每个样例物理写入仍 1、重复写入 0 | 任意工具、副作用或故障窗口都能自动恢复 |
| Retrieval degradation | 每个单条语料故障场景候选 0 → 1，并标降级 | 真实召回率或答案质量提高 |
| Plan | 基线 1 次模型调用；Plan 3 次，两个独立子上下文；确认前执行 0；阻塞后后续执行 0 | 多 Agent 更快、更省或语义更好 |
| Loop Guard | 相同动作工具数 12 → 2；AB 周期 12 → 5；连续失败 12 → 3；正常场景仍 4 次 | 一般真实任务都降低相同比例费用、所有循环都能识别 |

Context 基线是冻结实现／固定 Provider 的对照；恢复评测基线是同样输入关闭恢复器或用 strict 检索，**不是检出旧提交重跑**。各基线定义必须单独解释，不能统称同一项 A/B 实验。

## 从面试问题定位到代码和测试

| 题目／机制 | 实现入口与关键符号 | 验证入口 |
| --- | --- | --- |
| A02–A05 分层与装配 | [Host](../../server/index.ts)：conversationTaskContext／readTaskContext；[Runtime 装配](../../server/runtime/createRuntime.ts) | [Runtime 合同](../../server/runtime/runtime.contract.test.ts) |
| A07–A11 Fact／Artifact／事件 | [ProposalRunEngine](../../src/enterprise/proposalRunEngine.ts)；[contracts](../../src/enterprise/contracts.ts) | [RunEngine 测试](../../src/enterprise/proposalRunEngine.test.ts) |
| A05／A09 需求单闭环 | [RequirementBriefWorker](../../server/manufacturing/requirementBriefWorker.ts)；[API](../../server/manufacturing/requirementBriefApi.ts) | [M2 工作流](../../server/eval/m2RequirementWorkflow.test.ts) |
| C02／C19–C20 历史与 checkpoint | [state](../../src/agent/state.ts)；[FileAgentStateStore](../../server/runtime/fileAgentStateStore.ts) | [contextLifecycle](../../server/runtime/contextLifecycle.test.ts)；[Store 测试](../../server/runtime/fileAgentStateStore.test.ts) |
| C03–C06 当前任务输入 | [buildTaskContext](../../server/enterprise/taskContext.ts)；[Runtime.executeTurn](../../server/runtime/agentRuntime.ts) | contextLifecycle 的早期约束、待确认版本、旧绑定恢复用例 |
| C07–C12 请求计数与成组压缩 | [tokenBudget](../../src/agent/tokenBudget.ts)；[ContextEngine](../../src/agent/context.ts)：units／compile／compact；[AgentLoop](../../src/agent/loop.ts)：countTokens／compact | contextLifecycle 的 required budget、tool group、Unicode／图片／Schema 用例 |
| C13–C15 摘要预算与覆盖 | [ModelContextSummarizer](../../src/agent/summarizer.ts)：summarize | contextLifecycle 的 oversized messages／summary／count failure 用例；[context Eval](../../eval/context.ts) |
| C16–C18 分页与来源验证 | [contextReadTool／pageUnits](../../server/runtime/contextRead.ts)；[Runtime validateSources](../../server/runtime/agentRuntime.ts) | contextLifecycle 的大 JSON、单元超限、撤回来源用例 |
| C17／P12 文档读取 | [assetInspection](../../server/runtime/assetInspection.ts)；[AssetInspector](../../native/AssetInspector.swift)；[OfficeReader](../../native/OfficeReader.swift) | [documentRead](../../server/runtime/documentRead.test.ts)；[assetInspection 测试](../../server/runtime/assetInspection.test.ts) |
| M03–M09 个人记忆治理 | [Store](../../server/enterprise/personalMemoryStore.ts)：change／propose／decide／recall；[Service](../../server/enterprise/personalMemoryService.ts)：context／tool | [personalMemory](../../server/enterprise/personalMemory.test.ts) |
| M10–M14 依赖失效 | Service.context；Runtime 的 historyBinding／rebuild；contextReadTool | personalMemory 的跨任务／重启、调用中变化、暂停绑定、Plan 确认用例；[memory Eval](../../eval/memory.ts) |
| E02–E05 错误映射 | [Provider Client](../../server/anthropic/client.ts)；[Runtime classifyFailure](../../server/runtime/agentRuntime.ts)；[后台 Worker](../../server/workers/backgroundConversationWorker.ts) | [Provider audit](../../server/anthropic/errorHandling.audit.test.ts)；[Worker audit](../../server/workers/errorHandling.audit.test.ts) |
| E06–E08 取消与超时 | [abortable](../../src/agent/loop.ts)；Runtime executeTurn | [Runtime audit](../../server/runtime/errorHandling.audit.test.ts) |
| E09–E13 工具账本／文件恢复 | Loop 的 claim／complete；[文件 reconcile](../../server/runtime/conversationFiles.ts)；Runtime recoverToolExecution | [executionRecovery](../../server/runtime/executionRecovery.test.ts)；Runtime audit 的 committed side effect／unknown 用例 |
| E14–E18 Queue／Lease／Outbox | [Scheduler](../../server/workers/stageJobScheduler.ts)；[Queue](../../src/enterprise/stageJobQueue.ts)；[Outbox](../../server/workers/stageJobOutbox.ts) | [Scheduler](../../server/workers/stageJobScheduler.test.ts)；[Queue 合同](../../server/enterprise/stageJobQueue.contract.test.ts)；Worker audit |
| E19–E20 双重故障／完成证据 | [Telemetry.wrap](../../server/runtime/modelTelemetry.ts)；Runtime catch／putTrace；[recoverCompletedTurn](../../server/runtime/recoverCompletedTurn.ts) | Runtime audit；[Telemetry 测试](../../server/runtime/modelTelemetry.test.ts) |
| E22–E23 检索降级／索引取消 | [KnowledgeStore](../../server/knowledge/store.ts)；[Service](../../server/knowledge/service.ts) | [recovery](../../server/knowledge/recovery.test.ts)；[Knowledge audit](../../server/knowledge/errorHandling.audit.test.ts) |
| E24 删除／备份 | [conversationDeletion](../../server/runtime/conversationDeletion.ts)；[localBackup](../../server/localBackup.ts) | [删除测试](../../server/runtime/conversationDeletion.test.ts)；[备份测试](../../server/localBackup.test.ts) |
| P03–P04 防循环 | [RuntimeLoopGuard](../../server/runtime/loopGuard.ts)：before／after／attach | [Guard 测试](../../server/runtime/loopGuard.test.ts)；[loopSafety Eval](../../eval/loopSafety.ts) |
| P02／P05–P07 Plan | [PLAN_LIMITS／结果解析](../../src/enterprise/agentPlan.ts)；[Workflow](../../server/enterprise/agentPlanWorkflow.ts)；[Store](../../server/enterprise/agentPlanStore.ts) | [Plan 测试](../../server/enterprise/agentPlanWorkflow.test.ts)；[Plan Eval](../../eval/planSubagents.ts) |
| P08–P10 Reviewer | [EvidenceReviewWorkflow](../../server/enterprise/evidenceReviewWorkflow.ts)；[领域 revision policy](../../server/manufacturing/requirementEvidencePolicy.ts) | [EvidenceReview 测试](../../server/enterprise/evidenceReviewWorkflow.test.ts) |
| P13–P16 知识检索与适用性 | [KnowledgeStore](../../server/knowledge/store.ts)；[参数比较](../../server/manufacturing/knowledgeComparison.ts) | [Knowledge 测试](../../server/knowledge/knowledge.test.ts)；[比较测试](../../server/manufacturing/knowledgeComparison.test.ts)；[历史重排报告](../knowledge/overlap-rerank.md) |

阅读建议：先找公开入口／调用方，再看状态读写点，最后读失败测试。表中按符号而非固定行号定位，减少后续代码插入造成引用漂移；本次已检查链接目标存在。

## 旧文档口径的处理

- 2026-09-20 导读保留历史 441 项数字，本次新入口使用重新运行的 572 项；新增四个故障 audit 文件属于开始前已有工作，不能说是这次写资料时实现。
- 上下文文档“跨会话偏好待实现”改为个人偏好已实现、组织／客户共享记忆和自动经验学习仍待实现。
- 摘要分批准确写成完整消息，工作历史裁剪才是完整工具组；基础构建器的 workingNotes 与启用个人记忆后的清空行为分别说明。
- Reviewer 的空业务工具白名单与 Runtime 自动附加两个只读恢复工具分开说明；复核工作流拒绝带工具执行事件的结果。
- 中英文 README 的原生解析旧容量同步当前源码；历史 dated evidence 保留原测试条件。
- 历史 RAG 报告中的资料数量、配置、无降级行为保留当时含义，当前服务降级口径见 reliability-recovery；未重新验证运行中业务库数量。

## 后续更新这套资料时

改上下文策略后复查 C02／C06／C10–C18；改个人记忆后复查 M04／M08–M15；改错误／调度后复查 E03／E10／E14–E20；改 Plan 或 Reviewer 后复查 P05–P10。测试数字写日期和工作树范围，新的结果另存；禁止把历史样例的质量和性能结论自动扩大到新模型、新语料或真实生产。
