# Packx Agent Runtime 集成边界

状态：M1 Durable Runtime Frozen
更新日期：2026-09-20

## 当前链路

```text
React UI → Conversation API / Background Task API / Proposal Worker
→ AgentRuntimePort
→ BlackxAgentRuntime
→ SkillRegistry + ContextEngine + AgentHooks
→ AgentLoop
   ├─ AgentModelProvider
   ├─ AgentModelProvider Token Count / Context Summarizer
	   └─ validated Tool → Approval Port → Audit Port → Tool Execution Store
→ ContextSnapshotStore（每次 Model 调用前）
→ AgentSessionStore（用户输入、完整 Tool batch checkpoint、Turn 完成）
→ RuntimeTraceStore（成功、暂停或失败后）
```

Web Conversation API 在模型调用前先把当前用户消息以稳定 ID 和 `pinned` 状态写入 Session，再以 `resume: true` 执行本轮。Session v2 的 `transcript` 追加保留原始用户消息和正式回复，`messages` 是允许压缩、重建的工作上下文；UI 只读取 transcript。内部摘要不会成为用户消息。Turn 成功后 Runtime 保存正式回复并解除临时 pin，完整 Tool batch 也保存恢复 checkpoint。迁移与不能补造的旧历史缺口见[上下文管理](context-management.md)。

Background Task 不会创建另一套 Agent：受限的 `conversation.message.v1` payload 写入现有 `StageJobQueue`，Scheduler 通过 `conversation-background` handler 调用同一个 `ConversationApiController`。消息 ID 同时是 Turn 幂等键；Worker Crash 后重投会继续未完成 Turn，而模型回复已落盘但 Queue 尚未 ACK 时会直接复用完成结果。普通发送仍走同步 Conversation API，以保留低延迟交互。

Agent 现在也可在普通 Loop 内自主调用 `background_task_*` 和 `cron_*` 工具。模型只负责选择工具与生成候选参数；服务端 Tool Schema、固定 allowlist、bounded-automation policy、持久 Audit 和 Tool Execution Ledger 是执行权威。Cron Store 持久化表达式、IANA timezone、有限 `maxRuns` 和下一次触发时间；Dispatcher 使用确定性 occurrence ID 先投递、后 ACK，保持 at-least-once。Cron 只能投递注册的会话任务，不能执行 shell。

默认 `FakeAgentRuntime` 使用确定性 Fake Model。Online 模式由 `AnthropicModelProvider` 直接调用 Anthropic Messages compatible endpoint，不使用 Codex SDK 或本机 Responses 网关。

## Core 节点

- Loop：单个 execution slice 默认最多 32 次 Model 调用和 64 次 Tool 执行；无 Tool Call 且存在文本时完成。达到 slice 边界后返回 `paused` 并保存 Session，直接调用方以同一 `sessionId + resume: true` 继续；leased scheduler 以确定性 Session 和 `resume: "if-present"` 覆盖首次执行与 Crash 恢复，两者都不会重复追加用户输入。
- Hook：`loop/model/tool/compact` 的 before/after 和 completed/failed 观察事件，按注册顺序执行，不允许覆盖权威状态。
- Context：稳定指令、选中的 Skill、Session 历史和当前输入显式编译。
- Skill：进程启动时注册名称、版本和指令，Turn 只传 Skill 名称；未知 Skill fail-closed，快照记录实际 Skill 版本。
- Compact：Provider Token Count 优先；默认在输入硬预算 70% 触发并以 45% 为压缩目标，字符预算只在 Provider 没有 Token Count 时回退。完整 Tool Batch、pinned 任务状态和未决执行状态必须保留；成功回执仅保留近期状态和执行账本查询入口。大正文先归档再清理，摘要按完整消息及显式预算处理，未覆盖部分保留来源引用。压缩后重新计数，超过硬预算拒绝；`context_window_exceeded` 只允许一次压缩重试。
- Tool：必须声明 Schema、风险、幂等、超时、结果上限和输入校验。read Tool 可直接执行；write/publish Tool 默认拒绝，必须同时获得 Runtime Policy、Approval、Audit 和 Tool Execution Store。Store 在副作用前原子占用业务幂等键，重复成功请求复用旧结果，未决执行返回 `tool_execution_unknown`，不得自动重放。
- Identity：`actorId` 标识用户、Worker 或 Service Actor，并贯穿 Approval、Tool Context、Audit 与 Execution Record；`toolCallId` 一对一配对 Tool Call/Result，`idempotencyKey` 一对多关联重试 attempt，但最多产生一次成功副作用。
- Session：按 `tenantId/workspaceId/runId/sessionId` 隔离，成功 Turn 使用 revision compare-and-swap 保存；冲突显式返回 `session_conflict`。
- ContextSnapshot：在每次 Model 调用前不可变保存最终消息、Skill 版本、字符估算和累计 Compact 删除量；即使 Provider 调用失败也保留该次模型输入证据。
- Task Context：Enterprise 共享构建当前事实/阶段/来源，Plan 与子任务保留确认时冻结的上下文；恢复检查 task binding 与来源权限/哈希。摘要与归档同样使用 ContextSnapshot，摘要生成及计数记录调用身份、来源范围、Token、耗时和失败。预算公式、默认值来源、续读工具和验证边界见[上下文管理](context-management.md)及 [ADR-0024](adr/0024-separated-dialogue-and-versioned-task-context.md)。
- RuntimeTrace：持久记录 `model.started/completed`、Tool、Compact、Usage、总耗时和结构化 Failure。Trace 不复制模型正文，`message.completed` 只保存 `[stored in session]`；正文仍由 Tenant/Workspace 隔离的 Session 管理。

## Host 防循环策略

`BlackxAgentRuntime` 通过现有 `tool.before/after` Hook 安装确定性 Guard：同工具/规范化参数的短动作序列第三轮重复前拦截，连续工具失败 3 次后停止；返回不可重试错误并记录 `loop.guard.stopped`。Guard 状态保存在 Runtime Trace，按同一租户、会话、阶段及 Turn 幂等键恢复，不受 Compact 影响。后台 Worker 不会把该停止转换为自动重试。

Plan 另有限制：每任务最多 4 个版本、累计 32 个 Runtime 执行片、连续 3 次计划失败，单版本 16 片限制保留。次数是资源额度，不是货币费用。崩溃窗口、迁移和保守重复检测边界见 [ADR-0023](adr/0023-loop-guards-and-task-plan-budgets.md)。

## Enterprise 边界

Agent Session ID 只是 Runtime Resume Handle。Run、Stage、Fact、Artifact、Approval、Evaluation 和恢复继续由 Event Store、Artifact Store 与 Runtime Checkpoint 决定。模型完成一个 Turn 不等于业务 Stage 完成。

默认服务端使用 `FileAgentStateStore`，路径为 `.blackx-data/agent`，可由 `BLACKX_AGENT_STATE_PATH` 覆盖。Proposal Worker 的跨进程恢复仍以 Event Store、Artifact 和 `proposal-runtime-checkpoint.v2` 为业务权威；Checkpoint 同时保存最终 `contextSnapshotId`，Artifact Version 记录该引用。Agent Session 不能替代 Run/Stage 状态。

RunEngine 在同一次 Event Store append 中写入 `stage.execution_requested` 和 Outbox。Dispatcher 以 at-least-once 语义把确定性 Job 投递给 `StageJobQueue`；Scheduler 每次只执行一个 slice，期间续租，`paused` 后保存 continuation 并释放 Worker。默认文件 Queue 面向本地开发；显式 SQLite Adapter 支持单主机多 Worker 事务 claim。Worker 并发不是 Sub-agent：当前仍只有一个 Proposal Agent Session，没有独立 Agent 目标、消息总线或聚合协议。

## Provider 和 Secret

- `ANTHROPIC_API_KEY` 只由服务端 `AnthropicMessagesClient` 读取。
- `AnthropicModelProvider` 同时调用 Messages 与 `/v1/messages/count_tokens`，Provider DTO 不进入 Core Contract。
- Provider DTO 不进入 Enterprise Layer 或 Print Domain。
- 默认 Fake 不读取 Secret。
- Online 模式缺少 Base URL、Model 或 Key 时启动失败。

## Plan 与子 Agent（2026-09-13）

在既有单 Agent Runtime 上新增应用层 Plan 工作流：用户确认版本后，Host 通过同一 Port 顺序执行独立子 Session。详细边界与恢复策略见 [ADR-0015](adr/0015-confirmed-plans-and-bounded-subagents.md)。上文关于 M1 Worker 不等于子 Agent 的描述仍适用于原 Proposal 链路。

## M1 之后

- 流式 Token、并行 Tool、跨主机生产 Queue/Schedule Adapter、任意脚本任务、嵌套/并行 Sub-agent 与 Agent Teams。当前 Agent-managed Background Task、有限 Cron、Outbox、租约心跳、单主机 SQLite Queue、指标和 DLQ 运维接口已实现。
- 固定 M1 DeepSeek Online Gate 已通过；更多 Provider、长期延迟/成本趋势属于后续产品运维。
- Approval/Audit/Tool Execution Store 的生产数据库 Adapter；当前持久化基线是租户隔离的本地文件。
- 生产数据库/对象存储 Adapter、跨主机 Session 租约和本地残留锁回收。

详细决策见 [`ADR-0001`](adr/0001-self-owned-agent-core.md)、[`ADR-0002`](adr/0002-m0-write-tools-summary-compact.md)、[`ADR-0003`](adr/0003-durable-context-and-execution-slices.md)、[`ADR-0004`](adr/0004-leased-stage-job-scheduler.md)、[`ADR-0005`](adr/0005-transactional-outbox-and-queue-operations.md) 与 [`ADR-0006`](adr/0006-agent-managed-background-and-cron.md)。
