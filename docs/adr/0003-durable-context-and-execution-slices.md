# ADR-0003：可续跑 Execution Slice 与持久化 Tool 幂等账本

> 后续修订：[ADR-0025](0025-evidence-bound-recovery-and-explicit-degradation.md) 允许 Host 根据权威执行证据修复 started/unknown；证据不足仍禁止重放。

状态：Accepted
日期：2026-09-02
决策者：产品负责人

## 背景

M0 的八轮硬上限不足以承载工具密集型任务；字符阈值也会在真实 Token 预算前过早压缩。更重要的是，Tool Call/Result 消息即使成对压缩，也不能承担副作用去重和 Crash Recovery 的权威状态。

## 决定

- 单个 Agent Runtime execution slice 默认最多 32 次 Model 调用和 64 次 Tool 执行。到达轮次边界时保存 Session 与最终 ContextSnapshot，返回 `paused + turn.checkpointed`，不把 slice 边界当作失败。
- 调用方使用同一 `sessionId` 和 `resume: true` 继续；Runtime 不重复追加原始用户输入。
- 有真实 Token Count 时按 Token 水位触发 Compact：默认在硬预算的 70% 触发，压缩到 45%；字符阈值只作为没有 Token Count 时的保守回退。
- Provider 返回 `context_window_exceeded` 时只允许一次更激进的 Compact 与重试，并为重试前上下文保存独立快照。
- 未闭合 Tool Batch、稳定策略、当前输入与 durable execution receipt 不得进入模型摘要或被 Compact 删除。
- write/publish Tool 在副作用前必须通过 `AgentToolExecutionStore` 原子占用 `(tenantId, workspaceId, tool, idempotencyKey)`。成功记录复用既有结果；`started/unknown` 记录禁止自动重放并返回 `tool_execution_unknown`。
- `actorId` 与 `executionId` 贯穿 Runtime Request、Approval、Tool Execution Context、Audit 和 Tool Execution Record。`toolCallId` 只配对一次调用与结果，不充当业务幂等键。
- Tool Execution Record 和确定性 receipt 保存 Tool、Tool Call ID、幂等键、审批 ID、输入/结果摘要及状态；LLM 摘要不得改写这些字段。

## 替代方案

1. 只把八轮改为更大的硬上限：不能提供 durable continuation，拒绝采用。
2. 取消轮数上限：无法约束失控循环、成本和 Worker 占用，拒绝采用。
3. 把幂等字段永久留在原始聊天记录：Prompt 会持续膨胀，且聊天记录不是权威状态，拒绝采用。
4. 依赖 Claude/OpenAI Provider-native Compact：当前 DeepSeek Anthropic-compatible Gate 不保证支持，暂不采用。

## 影响与风险

- Runtime Contract 新增 `actorId`、`status`、`resume`、`turn.checkpointed` 和 Tool `replayed/unknown` 状态。
- 本地生产基线使用 `FileAgentStateStore` 持久化幂等记录；跨主机部署仍需数据库唯一约束和租约。
- Tool Result 当前仍受 `maxResultChars` 限制并保存在租户隔离账本；大结果的 Artifact/Object Store 外置由具体 Tool Adapter 实现。
- durable receipt 会增加少量 Context；账本始终是权威来源，未来可在不改变幂等语义的前提下对 receipt 建立分页索引。

## 迁移与退出条件

- 所有 Runtime 调用方必须提供可信 `actorId`。
- 暂停后的直接调用必须携带原 `sessionId + resume: true`；leased scheduler 可为确定性 Session 使用 `resume: "if-present"`，以覆盖 Worker 在首次 Session 写入前后 Crash 的两种恢复路径。普通新 Turn 不得设置 `resume`。
- 固定回归必须覆盖 32 轮 checkpoint、恢复不重复用户输入、成功副作用去重、未决副作用 fail-closed、receipt 抗压缩、开放 Tool Batch 抗压缩和 context-window 单次重试。
- 若 Provider-native Compact 通过独立 Contract 与固定 Eval，可新增 Adapter 优化，但不得替换 Blackx Tool Execution Ledger、Artifact 或 Event Store 的权威状态。
