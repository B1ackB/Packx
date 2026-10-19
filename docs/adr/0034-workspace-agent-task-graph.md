# ADR-0034：以现有 Plan 升级工作空间 Agent，先实现串行依赖图

日期：2026-10-18。状态：Accepted（首批实现）；后续能力为 Proposed。

发布更新（2026-10-19）：本批已获独立推送与条件合并授权，纳入 [PR #53](https://github.com/B1ackB/Packx/pull/53)；历史授权描述按原日期保留，现行验证/迁移边界见[发布记录](../evidence/workspace-agent-publication-2026-10-19.md)。

后续更新（2026-10-19）：[ADR-0037](0037-bounded-readonly-plan-waves.md)将新只读图扩为父图 lease 下至多两个节点并行；本文串行决策保留为首批历史与旧图/写入图行为。本批已获提交、推送和 PR 授权；合并与部署未授权。

## 背景和授权

产品负责人要求从偏需求单的产品升级为有工作空间、能逐步处理文件/网页/代码的 Agent，并全面考虑多 Agent 工程问题；授权本地设计、代码、测试和相关 CI 调整。保留原成果，不授权本次升级 push/PR/部署或付费模型调用。

AGENTS P3.2/P3.3/P3.4 要求先有单 Agent 基线、收益评测和闭环。ADR-0015 已引入有界、确认后顺序子任务，但明确不做依赖图。本次根据新的产品请求，缩小例外为“最多四节点、确认后、串行 DAG”，不启动 Swarm、不替换 Core。完整收益仍需真实任务评测，不能拿本轮固定 Provider 结果冒充。

## 决定

1. ReAct 留在现有 worker；Enterprise 的 AgentPlanWorkflow 负责图校验、版本确认、派发、依赖传递、预算与完成门槛。Core 和 Provider 合同不变。
2. `PlanTask.dependsOn?: number[]` 引用本版本内索引；拒绝非法边/环。Host 选择第一个就绪节点，继续复用单计划 Queue job、SQLite 事件、lease/fence、Session/key 与 recoverCompletedTurn。
3. 下游只收到已声明直接依赖的结构化报告与执行引用，不收到兄弟 Session。报告保持 unverified，非空 evidence 与 continue assessment 只是推进门槛；权威 Fact/Approval 仍由既有 Host 管理。
4. 依赖输入上限 24,000 字符，超限明确停止且不消耗下一调用预算；不截断来源。上游报告参与 taskContext binding。
5. 计划确认前中英文 UI 展示依赖。修改图生成新版本且需重新确认。所有写入仍走既有文件审批，模型/上游报告不增加权限。
6. 单 Agent 与 DAG 固定离线对照进入原有 core CI。保留全部原检查与平台门槛，无新依赖。
7. 包装工作流继续可用。通用工作空间、网页/代码能力、并发和费用预留分阶段推进；此 ADR 不开放新的执行权限。

## 替代方案

- 只写 Prompt：不能校验环、限制报告路由或恢复已完成节点。
- 直接换成 LangGraph/通用 Multi-Agent 框架：重复既有 Runtime/Queue/Store，迁移成本和可靠性收益没有证据。
- 每任务都拆多个 Agent：固定对照中多出调用，简单任务应保持单 worker。
- 首批建设并行通用图引擎：缺少资源冲突、共享费用预留和真实收益数据，后置。

## 影响、迁移和退出

旧计划可读且行为不变；持久结果不再假设 children 的数组位置等于 taskIndex，需要按 taskIndex 查找并验证依赖先完成。PlanRequirementSource 已保留每条结果的 taskIndex，继续显式导入未验证来源。新字段会被旧二进制拒绝，禁止混跑；回退先停新任务并保留兼容读取器/历史数据，不删除边或结果。

风险：额外模型调用、上游错误传播、依赖上下文变大、模型忽略依赖或错误引用、旧版本程序不能读新图。缓解：四节点/串行、显式确认/来源绑定、输入上限、保留完整旧结果、业务 Evaluator 与人工核对；不声称结构检查解决语义正确性。

如果真实任务显示拆分成本高于收益，保留读历史与已确认图执行，停止新图生成，直接执行仍是默认入口。扩展并发、任意代码或远程 Agent 前必须有独立评测和安全 Gate。

## 验证

见 [设计与阶段 Gate](../workspace-agent-architecture.md) 和 [本轮实际验证证据](../evidence/workspace-agent-upgrade-2026-10-18.md)。本轮只证明机制与回归，不证明真实模型、用户价值或生产多租户可靠性。
