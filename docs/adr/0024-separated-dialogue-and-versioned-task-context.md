# ADR-0024：原始对话、工作上下文与可回读来源

日期：2026-09-20。状态：接受。授权：本次上下文管理任务明确允许必要的 Core 状态契约调整。

## 背景

`Conversation API → Runtime → ContextEngine / AgentLoop → Session` 原来把压缩结果回写同一个 messages 数组，界面也读取该数组。ADR-0002 的 user-memory 摘要因此可能出现在聊天界面；其“原始 Session 可追溯”的前提并不成立。摘要输入保留末尾 24,000 字符、输出保留前 1,200 字符，还可能删除早期约束或切断条件。ADR-0003 的永久 durable 回执会持续增大上下文。

遵守 P0.1、P0.3、P1.1、P1.7、P1.8；本 ADR 修订 ADR-0001/0002/0003 的 Session、压缩、回执契约，以及 ADR-0014 的文档读取上限。既有 Plan 确认、自评、replan、Loop Guard 和工作流完成证据不被替换。

## 决定

1. **同一个受控 Session 存储，两种职责。** `agent-session.v2` 的 `transcript` 追加保存原始用户输入与正式助手回复；`messages` 是可替换的工作上下文。保存两者使用同一 revision、文件锁和原子替换。摘要、回执、任务上下文用显式 kind 标记，不进入 transcript。消息使用稳定 ID；内容冲突拒绝，同一已完成 Turn 重放要求完成 Trace，避免重复调用模型/工具。
2. **Enterprise 构建任务状态。** 共享 `buildTaskContext` 消费 Session、Event Store 投影、当前 Fact/Artifact/Approval 及来源引用。按时间保留用户原话，当前 Fact 带值、状态、版本、来源，旧已确认值与新待确认值分开显示。自然语言矛盾不由模型升级为权威结论。普通会话、Plan、子任务、需求单复用构建结果。Plan 仍检查原 conversationRevision 和完整 context；旧 Plan 不自动换来源。
3. **Core 只懂通用机制。** Core 保留消息分组、pinned、摘要预算、checkpoint、来源依赖及宿主校验回调；不增加包装条件、Fact 或业务状态机。任务上下文是带边界的 pinned 数据消息，当前 Host 指令仍是系统策略。
4. **原文先存储，摘要覆盖范围可核查。** 大工具结果和被压缩的完整消息保存到已有 ContextSnapshot。摘要按完整消息组批，超大单消息不切尾；预算不足的内容通过快照保留，并明确 INCOMPLETE。输出超预算不做硬切，不计为覆盖成功。默认每片最多 4 次摘要生成、16 次摘要计数，最多分配 26,048 输入加预留输出 Token；每次输入最多 6,000、输出最多 512。默认配置是应用策略，不是供应商规格。
5. **协议和恢复。** 按完整 Tool batch 判断必留，任何成员 pinned 或结果未齐均保留整组。旧可回读 Tool 正文优先替换为引用；完整 batch 后保存 Session checkpoint。未决副作用从既有执行账本重建，成功回执只保留近期内容和查询入口；账本占用、稳定幂等键与 unknown 禁止重放语义不变。
6. **按来源重新校验。** `context_read` 固定当前 tenant/workspace/run/session；`execution_ledger_read` 固定当前任务。两者是 Host 自动装配的内部只读工具，不赋予跨任务访问或写权限。摘要携带来源快照依赖；文档和知识工具提供 `validateContextResult`，恢复以及回读时重新检查哈希、权限和生命周期。最多遍历 128 个不同来源快照，超出时明确要求重建。历史快照与当前任务绑定不同会标记 stale；当前权威状态始终优先。校验失败停止，不把旧摘要当作可用证据。
7. **文档与证据续读。** 文档完整可提取内容进入已有 inspection Artifact cache；返回完整行及哈希绑定游标，每次重新读取来源检查权限/哈希。知识检索保留被省略证据的引用，`knowledge_read` 重新过实时权限和失效过滤，按完整参数/表格行分页，重复附带单位、表头、条件和脚注。单条内容大于页预算时返回明确错误，不截断字段。
8. **预算与观测。** 输入上限为 `min(applicationInput, contextWindow - outputReserve - safetyMargin)`。优先 Provider count，回退计入工具定义、Schema、UTF-8 和已加载图片，明确只是估算。压缩后重计数；Provider 窗口错误最多重试一次，重试也检查上限。主调用和摘要调用均有关联 ID、快照、来源范围、Token、耗时与失败记录。普通 Trace/遥测不写正文；原文只在受控存储。缓存仅记录已有 Provider 统计。

## 迁移

- v1 惰性读取；只迁移仍存在的原始用户/正式助手消息，确定性分配缺失 ID。旧摘要不展示为用户消息，`historyStatus=legacy_partial` 在 UI 明示；不能补造已丢历史。
- v1 的无来源校验元数据的工具消息/摘要不用于新模型上下文；重新从存储构建状态和来源。durable 执行信息保留并以执行账本重新核对。首次 save 写 v2 前，将完整 v1 JSON 数据保存到对应任务 `migrations/` 目录（保留字段内容，不承诺 JSON 空白排版逐字节一致）。
- v2 同时写 transcript/messages/checkpoint，旧 v2 可选字段缺失时仍可读。不要用旧版本程序写入 v2；回滚代码前先停 Worker，备份目录并做显式数据回滚。
- Native parser 升为 1.2.0，缓存键含版本，不覆盖 1.0/1.1 的历史 Artifact。完整提取仍有限：10 MiB 输入、1,000 页/表、1,000,000 Swift 字符；到达限制标记 sourceTruncated，单行过大明确拒读。ZIP/XML 防护和固定离线沙箱保持。

## 替代方案与风险

不新增聊天数据库，不替换 Runtime，不引入向量记忆、外部摘要框架或自建 Prompt Cache。使用现有 Session/Snapshot/Artifact 能得到最小可追溯闭环。原始对话及来源快照会增加本地存储占用，尚无自动归档/保留期管理；保持本机数据保护与现有删除墓碑。

完整保留用户原话是保守约束策略，不声称已经自动判断全部自然语言约束何时失效。任务上下文超过 64,000 字符（Plan 仍为 32,000）或必留 Token 超预算时停止；需要明确拆分任务/确认修改，不能静默删除。恶意来源保持数据角色与工具权限隔离；Fake 不证明真实模型对 prompt injection 的语义鲁棒性。

## 验证、迁移与退出条件

冻结 Baseline 位于 `eval/baselines/context-v1`，包含源文件摘要和已有改动清单；上下文专项 `npm run eval:context` 与回归测试对比。数字及命令见 `docs/context-management.md`。固定 Fake 只证明机制，真实模型语义评测独立、需付费调用授权。本次没有付费调用。

未来替换摘要策略或 Provider-native compact，须在相同任务/模型/预算的独立语义评测中证明收益，并保留原始对话、来源校验、版本绑定和执行账本。不能用更好的摘要分数替代权限或生产事实正确性。
