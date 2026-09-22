# 06｜场景推演、连续追问与模拟面试

[返回总入口](README.md)。本篇是口头推演题，**场景中的业务名称／数量为说明用例，不是用户真实订单或生产事故记录**。回答应指回前五篇的现有机制；“建议”部分未实现。

## S01．客户连续改数量，期间生成了需求单，又点了旧审批，怎么办？

**题设：** 数量 v1=10,000 已确认；需求单 A1 依赖 v1。客户提出 12,000，形成待确认 v2；旧页面仍显示批准 A1。

**参考回答：** 先区分用户更正、Fact 新版本和批准命令。新 Fact 使依赖旧输入的 Artifact stale、旧审批失效；taskContext 展示当前 v2 待确认及旧 v1 已确认，不回退也不自行提升 v2。旧页提交时校验 expectedVersion／ArtifactVersion，拒绝过期批准。用户确认 v2 后生成新需求单版本，再评价和批准。

**连续追问：**

- 模型摘要仍写一万怎么办？当前 Host 状态优先，恢复绑定变化会阻止旧步骤继续，摘要不能改 Fact。
- 多标签页同时确认？commandId 负责重投去重，版本 CAS 防不同命令互相覆盖。
- 用户已导出旧 PDF？系统可标旧结果，但不能召回已下载／发出的副本；不能承诺全局回滚。

**证据入口：** A07–A11、C05、[RunEngine 测试](../../src/enterprise/proposalRunEngine.test.ts)。

## S02．十万字技术资料读到一半被压缩，如何证明没有瞎编剩下部分？

**参考回答：** 把“源文件提取是否完整”“工具分页是否读完”“摘要覆盖是否完整”“结论是否有证据”分开。解析器有硬上限和 sourceTruncated，工具有游标／nextOffset，摘要有 coverage／INCOMPLETE，最终每个关键参数应能回到带 hash、位置、单位和条件的原文。

**连续追问：**

- 只读到第一页能说全文无某认证吗？不能，未读部分仍未知。
- 一个 JSON 行超过页预算？使用 messageIndex／jsonPointer 或专用源工具；不能切半个值当完成。
- 为何不用模型“记住全部”？有限窗口与语义遗漏都存在，Host 保存证据、模型按需读取；保留不等于理解正确。

**证据入口：** C10–C18、[上下文集成测试](../../server/runtime/contextLifecycle.test.ts)、[文档测试](../../server/runtime/documentRead.test.ts)。

## S03．用户撤回“默认用英文”，旧聊天和摘要还写着它，怎么办？

**参考回答：** forget 撤回有效记忆并清空条目版本正文，recall 有效视图变化导致 historyBinding 改变。下次执行重建 messages，旧快照回读拒绝，Host 不再注入旧助手 workingNotes；完整 UI 对话保留，账本和当前业务 Fact 不清空。

**连续追问：**

- 当前任务原话里也说过“用英文”呢？它仍是当前任务输入；遗忘跨任务偏好不等于删除或否定用户本轮指令，冲突需澄清。
- 会删除备份吗？不会承诺，当前无全系统擦除。
- 为什么不只删数据库一行？旧摘要和快照是派生副本，仅删源条目不能消除继续使用的路径。

**证据入口：** M10–M15、[跨任务撤回与重启测试](../../server/enterprise/personalMemory.test.ts)。

## S04．Provider 返回 401，遥测磁盘又写满，后台会不会反复调用？

**参考回答：** Provider Adapter 先保留 401；telemetry finally 失败用 cause 留原因；Runtime 沿 cause 分类 authentication／不可重试，同时分别尝试 activity 和 Trace，次级错误保留在 AggregateError。API／后台 Worker 传递显式 retryable=false，队列不应把它当一般 502 暂时故障重试。

**连续追问：**

- 如果 error body 是字符串？unknown 形状验证不能覆盖原 HTTP 状态。
- 如果 Trace 也写不了？能保留内存因果链，但不能宣称审计已落盘，需要修复存储。
- 所有嵌套异常都能找出来吗？当前 Provider cause 检查深度为四层，不是无限错误图遍历。

**证据入口：** E03–E05、E19、[Provider 审计测试](../../server/anthropic/errorHandling.audit.test.ts)、[Runtime 审计测试](../../server/runtime/errorHandling.audit.test.ts)。

## S05．写文件的五个崩溃窗口分别怎么处理？

| 中断位置 | 已知状态 | 正确处置 |
| --- | --- | --- |
| 审批／claim 前 | 无执行授权或无持久执行意图 | 不执行；修好后走原校验 |
| claim 后、执行前 | started，但恢复方未必能证明没执行 | 保守保留未决；不可简单重新写 |
| 写盘后、文件 applied 回执前 | 磁盘可能已改变 | 核对事前计划、审批、原文备份、目录身份和后置条件，证据齐才补结果 |
| applied 后、通用账本 complete 前 | 有可核查文件结果 | 绑定身份／输入／历史版本对账，不修改用户文件 |
| 账本 succeeded 后、Session checkpoint 前 | 工具成功记录存在 | 重放确定性回执，继续未完成执行 |

**参考回答：** 关键不是统一重试，而是判断证据能否说明操作结果。即使物理上确实尚未执行，如果恢复证据不足，也不能由模型猜测。

**连续追问：** 文件后来被合法改过怎么办？已保存 applied 历史可用于核查原成功，不能把旧内容重新覆盖当前文件。证据被篡改怎么办？停止而非重算 hash 掩盖。撤销呢？新的 sourceVersion 补偿和新审批。

**证据入口：** E09–E13、[执行恢复测试](../../server/runtime/executionRecovery.test.ts)。

## S06．Worker A 卡住，租约到期被 B 接手，A 又返回了结果？

**参考回答：** B 具有新的 lease。A 的晚提交必须在业务持久化与队列提交边界被旧 lease／generation 检查拒绝；如果取消信号已经到达，Host 也不应继续消费晚返回结果。B 根据 checkpoint 和账本继续，不能仅凭 A 失联就重做所有写工具。

**连续追问：**

- 心跳尚未执行但实际 lease 已过期？提交前必须再检查，不能只依赖定时心跳。
- A 已向外部系统发出请求？租约无法撤销它，仍需外部幂等／结果查询；当前泛化外部系统恢复未实现。
- B 再崩溃呢？继续用同一持久身份和预算，不重置全部历史。

**证据入口：** E14–E18、[Scheduler 测试](../../server/workers/stageJobScheduler.test.ts)。

## S07．Plan 第一个子任务完成，第二个发现来源不匹配，第三个是否继续？

**参考回答：** 第二个报告 replan 后，Host 保存失败原因和执行结果，转 plan_replan_required，第三个不执行。用户生成新版本时携带前版结果节选和引用，预算跨版本累计，新版本必须再确认。

**连续追问：**

- 第一个写过文件是否回滚？不会自动撤销，结果保留；新计划要核查是否意外重复。
- 能自动让规划器一直改到成功吗？当前没有，该路径会绕确认且增加成本。
- 第二个说继续但证据空？Host 同样阻断；有非空证据仍不代表语义通过。

**证据入口：** P05–P07、[Plan 固定评测](../../eval/planSubagents.ts)。

## S08．RAG 命中“更低 OTR”，另一份温湿度不同，客户问哪种更好？

**参考回答：** 先核对型号、单位、测试方法、温湿度、材料范围及原文位置。条件不一致或缺失时不能直接按数值排序并推荐，返回不可比较项／证据缺口。检索得分不是产品性能分，论文样品也不能当供应商在售型号。

**连续追问：**

- Reranker 高分有用吗？有助排序相关性，不能填补实验条件。
- embedding 不可用？hybrid 可显式关键词降级，但仍核查条件／权限，不自动选更便宜或更优产品。
- 当前 source 被撤回？不能因缓存里还在就继续使用，读取／交付门槛重新校验。

**证据入口：** P13–P16、E22、[证据比较实现](../../server/manufacturing/knowledgeComparison.ts)。

## S09．必留任务数据已超模型预算，项目还能如何“聪明地处理”？

**参考回答：** 当前明确 budget_exceeded，不能私自删除约束。可以向用户提出拆分独立任务、明确哪些旧要求已失效，或在确认适当模型能力后调整配置。任务改变必须形成明确的新输入，而不是内部静默改变目标。

**连续追问：** 为什么不把全部硬规则摘要化？摘要可能丢否定／单位且无确认权。为什么不直接加大 max_tokens？输出额度不等于输入窗口，应用配置不能改变模型容量。以后怎么改进？显式约束生命周期和更细原文读取，先用固定任务评价保留率与成本。

**证据入口：** C07–C14、C24。

## S10．面试官让你白板写一个安全的 Agent Loop，重点是什么？

下面是**教学伪代码**，不是当前源文件逐行复制；当前实际错误分支、快照和钩子以 AgentLoop 为准。

```text
load current task state, session and execution ledger
validate identity, current bindings and source access
reconcile supported unknown operations from authoritative evidence
compile bounded context
for each permitted iteration:
	count full request including tool schemas
	if needed: externalize/prune/archive/summarize, then recount
	if required input cannot fit: stop with budget error
	call model under timeout and cancellation
	if final text: return Runtime result, not business approval
	for each tool call:
		check loop guard, allowlist, input, policy and approval
		for side effects: claim ledger or replay known result
		if unknown: block duplicate operation
		execute under tool bounds; persist result and audit
	checkpoint only a complete tool batch
persist continuation and return paused
```

**参考回答：** 最常被漏掉的是模型之外的持久化、消息配对、未知副作用、晚提交和业务完成门槛。先画权责再写循环，比仅展示 while(true) 和 tool.execute 更能说明工程能力。

**连续追问：** 单次 Tool 失败是否立即 throw？不一定，可结构化返回模型；Infrastructure 失败、Guard 或权限相关轮次错误另行处理。强杀后从哪恢复？Session／checkpoint／ledger，不能靠摘要推测。

## S11．“你亲自做了什么、最难的 bug 是什么”，怎样回答可信？

**参考回答结构：** 明确自己实际负责的范围 → 展示一个具体失败 → 根因 → 修改所在层 → 一条反例回归 → 留下的限制。不要把本资料或仓库所有代码自动当成个人独立贡献；使用 AI 辅助开发时，可以如实说明自己如何定义边界、审查代码、组织验证和判断结果。

可选择已理解且确实参与过的案例：

| 案例 | 有说服力的技术重点 | 不能编造的部分 |
| --- | --- | --- |
| paused 被后台误判 completed | HTTP 与 Runtime 状态分离、continuation、旧预算处理 | 真实客户损失、线上事故次数 |
| finally 覆盖认证异常 | 主因与次因、cause、code／retryable 跨层传播 | 没有测过的故障覆盖率 |
| 记忆删除后旧摘要回流 | 派生数据依赖失效、多入口检查、UI／模型历史分离 | 所有隐私数据彻底擦除 |
| 文件已写而账本未知 | 不确定状态、证据对账、不可变版本和新审批补偿 | 通用 exactly-once 或任意工具自动恢复 |

**连续追问：** 为什么在这个层修？能复用什么？没改哪条核心契约？测试是否真的抵达故障点？为什么不选择更简单／更复杂方案？回答时以实际记录为准。

## S12．如果给你两周继续做，怎么排优先级？

**参考回答：** 我会先选一个真实售前任务与可授权资料，冻结验收标准并记录失败；优先补高风险恢复缺口，例如非文件工具结果查询、索引总时限或完成证据补写中最常发生的一项。同时跑真实模型对照，测遗漏／误确认／人工时间／成本，再决定是否需要更复杂检索或并发。

**深挖：** 这只是未来计划，不能说两周一定达到生产级。每个迭代应有输入、输出、状态转换、失败场景、离线回归与业务验证。没有用户／质量证据时，增加 Agent 数量或切到微服务不能自动解决问题。

## 三轮模拟面试安排

| 轮次 | 时间 | 面试官问题顺序 | 通过标准 |
| --- | --- | --- | --- |
| 项目与架构 | 30 分钟 | 两分钟介绍 → A03 → A05 → A08 → A11 → S01 → A16 | 能完整讲一条链路，区分三种完成状态，不靠目录名堆砌 |
| Agent 专项 | 45 分钟 | C02 → C07 → C11 → C14 → C18 → M10 → P03 → P09 → P17 | 能给输入／输出、失败与证据；分清机制正确与语义正确 |
| 后端故障深挖 | 45 分钟 | E03 → E07 → S05 → S06 → E17 → E20 → E21 → S11 | 能按提交顺序推演；不通过换 ID、删账本或放权解决错误 |

每次先闭卷口述，再查代码纠正。每题按五项各 0–2 分自评：业务问题明确、机制准确、失败推演、验证依据、限制与取舍。满分 10 分；说出未实现能力或把 Fake 指标当生产质量时，该题先重练，不用流畅度补分。

## 复习顺序

第一遍只练总入口的 12 题和两分钟介绍；第二遍读 C／M／E 三篇并画一张存储与依赖图；第三遍按本篇场景做连续追问；最后从代码索引随机找实现和测试，确认能解释“为什么这里必须阻止继续”。时间允许再展开 Plan、RAG、原生权限和历史评测。

可以向面试官反问团队如何定义 Agent 完成、怎样处理未知副作用、真实任务评测与人工验收由谁维护、模型权限和业务审批由哪一层负责。这些问题应服务于理解岗位，避免变成对对方架构的审问。
