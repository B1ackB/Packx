# 04｜错误处理、幂等、取消与故障恢复

[返回总入口](README.md)。主依据：[当前错误处理](../reliability-recovery.md)、[40 节点审计](../failure-handling-audit.md)、[故障测试闭环](../harness-error-handling-tests.md)。实现入口为 [Runtime](../../server/runtime/agentRuntime.ts)、[Loop](../../src/agent/loop.ts)、[调度器](../../server/workers/stageJobScheduler.ts)、[队列](../../src/enterprise/stageJobQueue.ts)、[文件对账](../../server/runtime/conversationFiles.ts)。

## E01．项目的错误处理设计原则是什么？

**回答：** 先分类失败，再核对副作用与持久化状态，最后决定重试、续执行、降级或人工处理。不能统一 catch 后重新跑整个任务。未提交事务可 rollback，已成功操作需要重放回执或补偿，结果不明则保留 unknown。

**深挖：** 错误有至少三个维度：原因 code、是否允许上层重试 retryable、操作到底进行到哪一步。`retryable=true` 不说明副作用没发生；`HTTP 500` 也不说明所有写入都失败。业务安全要看账本、版本、来源和审批。

## E02．Provider、Core、Runtime 和 Tool 错误有什么不同？

**回答：** Provider Adapter 保留外部状态与协议异常；Core 用 AgentCoreError 表示轮次级失败，单次 Tool 失败通常返回结构化结果；Runtime 映射为 `RuntimeFailure(code, message, retryable)`，保留内部 cause；Worker 将明确属性传给 Scheduler。

**深挖：** Tool failureCode 与 RuntimeFailureCode 不是一套枚举。Tool 执行事件有 succeeded／failed／denied／unknown，但没有通用独立 retryable 字段。模型可以收到一个工具失败并调整策略；连续失败和循环由 Guard 截断。工具结果失败不必然立即结束整个 Turn。

## E03．为什么不能只看 HTTP 502 决定重试？

**回答：** 当前 Conversation API 中 context_failure、budget_exceeded、cancelled 等也可能映射为 502，且不可重试。Worker 必须优先保留响应体明确的 code／retryable，只有缺少属性才按兼容规则推导。

**深挖：** 同一个 invalid_output，输出被长度上限截断可能可重试，refusal 或无效身份输入却可能不可重试。接口码偏向传输表示，不能代替领域错误。历史修复就是后台曾丢失 Runtime 分类，使确定性错误被反复入队；现在有 16 种码 × 两种 retryable 的矩阵回归。

## E04．当前 Runtime 错误码怎样记，而不是死背？

| 类别 | 错误码 | 常见处置 |
| --- | --- | --- |
| Provider／模型 | authentication、rate_limit、model_failure、invalid_output | 修认证、限额内退避、检查协议／输出 |
| 执行控制 | timeout、cancelled、max_iterations | 读 checkpoint 与账本，区分暂停和终止 |
| 输入与状态 | context_failure、budget_exceeded、session_conflict | 修来源／存储、调整任务、重读版本 |
| 安全停止 | permission_denied、repeated_actions、consecutive_tool_failures | 解决权限或循环原因，不能盲重试 |
| 依赖与兜底 | infrastructure_failure、runtime_unavailable、execution_failed | 修依赖、检查内部因果链和原执行状态 |

**回答：** 当前共 16 个码，但可重试性仍由实际产生路径决定；已有 RuntimeFailure 优先保留，不用静态表重新覆盖其属性。

**深挖：** max_iterations 是契约保留码，正常 Loop 到迭代上限返回 slice_limit／paused。State Store unavailable 可形成可重试 context_failure，来源失效则通常不可重试。编码分类有价值，但不是一个 code 唯一决定所有恢复动作。

## E05．Provider 返回 JSON 字符串而非对象为什么危险？

**回答：** 外部 JSON 是 unknown，即使解析成功也可能是字符串、数组或 null。直接对 primitive 使用 `in` 会抛 TypeError，遮住原 HTTP 401，最后可能变成可重试模型异常。Adapter 先验证 object 形状，非 2xx 保留 providerStatus。

**深挖：** 2xx 返回错误形状同样必须拒绝，Token Count 要非负安全整数，text block 要真字符串。TypeScript 类型断言不验证网络响应。项目当前故障测试同时覆盖 Client → Provider → Runtime → Trace 的分类，避免只测一个私有函数。

## E06．Runtime timeout、Tool timeout、Queue lease 有何不同？

**回答：** Runtime timeout 是执行片总时限；Tool timeout 限制一次工具等待；lease 是 Worker 当前拥有 Job 提交权的有效期。租约可续，不是任务的最终 deadline。

**深挖：** 心跳一直成功时，不返回的操作仍可能卡住，所以必须有独立总时限。当前知识索引响应取消，但还缺统一自动索引 deadline；检索查询的有界等待不能被描述成索引任务也已有相同保证。

## E07．传 AbortSignal 就一定能取消吗？

**回答：** 不一定。合作实现会响应 signal；不合作 Promise 需要 `abortable` 让 Host 停止等待，并在继续提交前检查 signal。Runtime 初始化账本读取、图片加载、来源校验和恢复写入等待都补了该边界。

**深挖：** abortable 不能强杀底层 I/O，也不能抢占堵住事件循环的同步 CPU。迟到结果不能继续写索引／回复，但已开始的外部写操作仍可能发生。原生子进程另有 supervisor 和进程组终止；不能把取消 Promise 等同撤销现实副作用。

## E08．用户点击停止后，应该向他承诺什么？

**回答：** 停止后续推进，并保留可核查状态。不能承诺已成功文件被自动撤销、Provider 不收费或所有数据回到任务前。被取消的 Job 不自动恢复，未知副作用应先核查。

**深挖：** SSE 断线只说明客户端不再收到进度，不是业务取消。进程退出也可能来不及 drain。当前 SIGTERM 发送 abort 后直接退出，没有完整有界关停流程；下一次启动必须依赖账本、租约和 tombstone 恢复检查。

## E09．一个写工具从调用到完成有哪些安全关口？

**回答：** Host 检查工具注册／allowlist、输入合同、风险／策略、审批和稳定幂等身份，再 claim 持久账本；claim 成功后执行，结果完成后写账本并审计。相同 key 不同 inputDigest 拒绝，已成功同输入重放结果，started／unknown 阻止重做。

**深挖：** 账本状态是 started／succeeded／unknown；Tool 事件还会有 failed／denied，不能混为一个状态机。审批与业务证据绑定具体 scope 和输入，不允许文档指令或模型自称“用户同意”代替。claim 持久化失败必须在副作用之前停止。

## E10．文件写成功，但账本 complete 失败，下一次如何处理？

**回答：** 不能再写一次。保留 started／unknown，Runtime 在下一执行片模型调用前让 Host 对账：核对原作用域、actor、工具、幂等键、输入摘要、批准记录、不可变版本和文件操作证据；能够证明成功才补账本并给确定性回执。

**深挖：** 两种窗口不同：已保存文件 applied 结果但通用账本未完成，可按历史结果核查；磁盘已改变但文件回执未保存，则还要检查预先记录的计划结果、原文备份、目录身份、磁盘后置条件和版本顺序。仅“文件现在内容一样”证据不够。测试验证恢复前后实际物理写入仍为一次。

## E11．unknown 为什么不能当 failed？

**回答：** failed 容易让调用方理解为没有成功；unknown 表示可能成功、尚无法确定。例如超时的写请求可能已经写盘，只是响应丢了。将其当失败重试会造成重复副作用。

**深挖：** unknown 不是程序“懒得处理”，而是外部操作不可原子观察的现实状态。外围 Runtime 可允许恢复，但 Tool 身份仍必须保留。删除账本、换 key 或重新建任务都不能成为绕过未决操作的通用恢复方案。

## E12．为什么不能宣称 exactly-once？

**回答：** 本地状态事务、去重与结果重放只能覆盖其边界。Provider 已返回但 checkpoint 未落盘时可能重复付费；外部操作成功与本地账本完成也不是一笔事务。项目通过幂等键、证据对账和安全停止降低重复风险，未建立全链路 exactly-once。

**深挖：** exactly-once 必须问“对什么观察者、什么资源、哪个失败模型”。本地同一个命令事件只提交一次，不意味着文件、模型计费和业务状态全部只发生一次。测试中 duplicateWrites=0 只证明列出的注入窗口。

## E13．文件补偿、事务回滚、重试和对账分别是什么？

**回答：** 回滚撤销未提交的同一事务；重试重新尝试一个已证明可重试的操作；续执行从 checkpoint 往后走；对账只用证据补内部结果而不重复外部操作；补偿是一项新的反向业务操作。

**深挖：** Packx 文件恢复用 `sourceVersion` 读取不可变旧内容，经新的审批后写出新版本，校验当前 expectedVersion／expectedSha256 并记录 restoredFromVersion。旧版本和历史批准保留。它不是修改历史，也不是跨全部工具的自动 Saga rollback。

## E14．Worker 租约过期后旧 Worker 迟到，如何防晚提交？

**回答：** Job claim 生成 leaseId／owner／expiresAt；心跳续租，提交边界重新验证拥有权。新 Worker 接手后，旧 lease 的 ACK／checkpoint／失败写入被拒绝；Worker 在持久化业务产物前也检查 active 状态。Plan 另有 generation／version fencing。

**深挖：** fencing 保护当前存储提交权，不能撤回此前已经发生的外部文件操作。外部副作用仍需 Tool 账本和审批。也不能把单 Host 租约合同测试说成多机时钟、网络分区和任意共享存储都验证过。

## E15．paused 为什么必须单独处理？

**回答：** paused 表示执行片工作已保存，还需继续，并不等于完成。Worker 返回 Session／snapshot，Queue 保存 continuation 后释放当前租约，下一片继续。若只按 HTTP 200 ACK，会把长任务停在半途却显示完成。

**深挖：** 项目最近修复过这个具体错误，也移除了新后台任务 maxSlices=1 的覆盖，使用默认 32 片。旧 Job 持久化预算不被偷偷改写；曾误标 completed 的旧任务也不能自动全部翻回 queued，要核对原消息和当前状态。

## E16．重试退避、失败额度和 slices 如何配合？

**回答：** Scheduler 使用 `min(30000, 250 × 2^failureCount)` 毫秒退避。Queue 将连续 failureCount 加一，只有 retryable 且新计数小于 maxFailures 才重新入队。默认 maxFailures=5、maxSlices=32，具体工作流可收紧或覆盖。

**深挖：** checkpoint 暂停会增加 sliceCount 并重置连续失败；累计失败仍应单独观察。用户／Cron 后台默认 5 次失败额度，Agent 请求后台 10 次，知识 3 次，Plan 使用自身预算且 Job maxFailures=1；不能统一讲成“失败重试三次”。反复 redrive 是操作方新增机会，不是原预算的一部分。

## E17．Outbox ACK 失败怎样恢复？是否有无限重试？

**回答：** enqueue 成功、Outbox ACK 失败时，记录仍待投递；下次用确定性 Job ID 重投，Queue 幂等去重，然后再 ACK。业务不会因 ACK 丢失生成第二个等价 Job。

**深挖：** 当前 Outbox 只有退避间隔上限，没有总尝试上限和独立 DLQ；Cron 每次派发独立 Job，业务连续失败也不自动暂停日程。所以“Job 有界”不能扩展成“所有调度都有限重试”。持续异常要监控并显式暂停／处置。

## E18．死信 redrive 为什么需要 expectedUpdatedAt 和 additionalSlices？

**回答：** expectedUpdatedAt 避免操作员对旧状态进行重放；reason 保留操作理由；若 slice 额度已耗尽，必须显式增加有限 additionalSlices，否则 job_conflict，状态保持 dead_letter。当前单次可增加 1–32 片。

**深挖：** 之前只重置失败计数就能越过 slice 上限，现在内存／文件／SQLite 三种队列都有合同回归。redrive 不增加工具权限，不改变来源版本，不清除 unknown 和 Loop Guard；不可恢复 Plan 应重新规划确认，不能拿队列操作绕审批。

## E19．模型报认证失败，写日志又失败，最后应该返回哪个？

**回答：** 原 authentication／不可重试必须保留，次级 activity／Trace／telemetry 失败进入内部因果链。Runtime 分别尝试报告出口，使用 AggregateError 留主因与次因，避免 finally 的磁盘错误把认证失败改成可重试异常。

**深挖：** “保留 cause”不意味着审计已持久化；存储坏时仍可能只剩内存错误。当前 Provider 分类沿 cause 最多查看四层，并不是任意错误图遍历。也不能把这一修复推广成所有 Hook 都绝不会遮蔽异常。

## E20．模型成功了，但遥测／Trace 保存失败，算成功吗？

**回答：** 当前选择失败关闭，不能假装完成证据已保存。模型成功后 telemetry 持久化失败仍向外报错；正式 Session 回复保存后 completed Trace 失败，回复可能已存在，但 Runtime 原轮重放会因缺证据停止，不再次调用模型。

**深挖：** Conversation API 对已存在回复的 duplicate 去重只检查会话，并不等于 Runtime 的 completed Trace 核验。两条入口要区分。当前没有统一自动补写服务，也没有把回复、Trace、遥测和计费合成事务。改成非关键遥测异步化是设计选项，必须补明确审计／恢复政策后才能采用。

## E21．为什么原子 rename 不是事务，也不等于断电安全？

**回答：** rename 可以让读者看到旧文件或新文件，但不能把两个文件及数据库同时提交；rename 后的 chmod、解锁或另一个写入仍可能失败。断电持久性还涉及文件和父目录 fsync，当前各存储并不统一。

**深挖：** API 报错后要读回原身份状态，不能断言没有提交。进程崩溃测试不等同硬断电测试。残留目录锁、文件队列陈旧锁策略和根锁恢复各有范围，不能批量删除锁后重跑副作用。

## E22．哪些事情允许降级，哪些必须停止？

**回答：** 可选重排暂时失败可回原候选并标 `rerank_unavailable`；hybrid 的 embedding 暂时失败可退关键词并标 `embedding_unavailable`，且不再调用重排。显式 vector 查询、权限拒绝、来源撤回、维度／模型完整性错误不能随意换标准后称成功。

**深挖：** 降级仍要重查来源和权限，用量未知保留 null，不自动换付费 Provider。检索候选存在只代表服务可继续提供可核查资料，不证明降级召回质量够用。当前检索总等待／embedding／重排上限分别为 35／30／25 秒，并服从剩余预算；不要套用到导入索引总时限。

## E23．知识索引取消后，迟到 embedding 为什么不能落盘？

**回答：** KnowledgeStore.process 对等待使用 abortable，取消释放 Host／Worker 等待，之后不沿旧调用提交 chunks 和 indexed 事件。现有集成测试让 embedding 故意不响应 signal，再释放迟到结果，确认后续独立 Job 可继续且旧索引没晚提交。

**深挖：** 本地事务内 chunks、索引状态和事件一同提交，最终事件 INSERT 失败可回滚至 parsed。raw 文件和数据库仍非一笔事务。统一自动索引 deadline、同步 CPU 强制中止和全局 reconcile 故障隔离依然是缺口。

## E24．删除会话失败了一半怎么办？备份能回滚外部文件吗？

**回答：** 删除先写 tombstone，拒绝后续普通读写，再清理 Cron／Job／阶段；失败返回 cleanup_pending，重复相同删除或调度 reconcile 继续清理。备份恢复是停机协调后的文件清单／hash／SQLite 校验，恢复到新目录并用 incomplete 标记阻止半成品启动。

**深挖：** 没有 undelete 或全系统物理擦除承诺。备份不能撤销数据根之外的文件、Provider 计算和已发出去的内容；恢复旧队列前必须核查备份之后的副作用。实际 RPO／RTO、异地容灾和在线跨存储快照尚未建立。

## E25．怎样设计有价值的故障测试？

**回答：** 按真实提交顺序选择窗口，而不是随便抛异常：claim 前失败验证工具零执行；副作用后 complete 失败验证不重复写；Session 后 Trace 失败验证无自动模型重放；取消后释放迟到响应验证无后续提交；SQLite 最后一笔审计失败验证状态一起回滚。

**深挖：** Fake Timer 控制租约／超时，可控 Promise 制造不合作请求，临时 SQLite trigger 验证实际事务，重开 Store 验证持久状态；需要正例证明测试抵达目标路径。现有新增 86 项覆盖七类缺陷，不意味着每个语句和设备故障都已注入。

## E26．还有哪些故障不能自动恢复？面试怎样回答不足？

**回答：** 当前非文件工具的 unknown 没有通用对账器；正式回复与 Trace／计费非原子；文件 fsync／残留锁策略不统一；Outbox 总重试与 Cron 失败熔断不完整；索引总 deadline 和关停 drain 仍缺；跨存储孤儿内容也无统一修复器。

**深挖：** 回答不足应补优先级和验收：先为高风险工具增加权威结果查询，注入“业务成功／账本失败”验证零重复；再补有界关停与提交窗口恢复。不要为了面试把建议写成已完成，也不需要直接引入一个全局 Saga 框架。具体 G1–G7 和人工处置见原故障审计。
