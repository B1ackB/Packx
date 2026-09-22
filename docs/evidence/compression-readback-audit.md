# 压缩与回读独立审计

日期：2026-09-22。初始代码：`da4fcd15524d4880f2940fa2b23200dcaebd99b2`。测试由独立审计子任务编写，生产修复由主任务完成。本报告只使用合成数据、确定性 Fake Provider、临时文件目录；未访问用户业务资料、未调用真实模型，付费调用为 0。

审计代码：[compressionReadback.audit.test.ts](../../server/runtime/compressionReadback.audit.test.ts)。生产范围：`ContextEngine`、`ModelContextSummarizer`、`AgentLoop`、Runtime Session/Snapshot 来源校验及 `context_read`。断言对照固定原文、完整协议组、权限变化和调用次数，未复制被测实现作为正确性标准。

## 实际发现

### 1. 回读后没有保留来源校验链

初始版本的 `context_read` 会在读取当下校验来源，但没有声明 `validateContextResult`。Core 因而没有为它的成功结果保存 `sourceTool`；回读文字留在工作历史或者再次被摘要后，恢复检查无法找到最初来源。

复现步骤：

1. 存入带 `source_read` 校验器的合成资料归档。
2. 仅允许模型调用内置 `context_read`，读到原始资料。
3. 分别经过 0、1、3 次压缩，关闭并重新构建 Store/Runtime。
4. 撤回原始资料，继续任务。

初始版本三个场景均继续完成，并调用了 Provider；要求是 `context_failure` 且 Provider 调用为 0。新增回归在原有 41 项相关测试全通过的情况下复现此缺口。

修复后，回读结果通过现有 `validateContextResult`/`sourceTool` 合约保持来源；Host 沿原始归档和后续压缩归档继续校验。`transcript` 由当前 Session 读取，不被误当作 Snapshot。

### 2. 已持久化的旧版回读记录需要兼容校验

只为新调用增加元数据，不能修复旧 `agent-session.v2` 中已经存在的回读结果。独立测试保留初始版本的完整 `assistant.toolCalls`/`toolCallId` 组，但没有 `sourceTool`，分别放入工作历史和压缩归档。第一版修复下，这两个场景在来源撤回后仍继续调用模型。

兼容路径使用原始调用与结果的对应关系补足来源验证，并继续遍历其归档；不凭摘要文本判断资料有效，也无需覆盖既有 Session 或原始归档。

后续修复审查追加了两个兼容边界：不同工具调用组可以复用同一个 call ID，关联必须限定在原始组内，不能用整段历史的最后值覆盖前面的来源；失败的回读只包含标准工具错误，不应被当成成功资料触发来源恢复。两条均有独立回归，避免安全修复同时破坏正常失败处理。

### 3. 同一执行片中来源变化需要在下一次调用前重验

独立测试在 `context_read` 成功后的工具完成事件处撤回资料，保持 task binding 不变，代表不在当前已选资料索引里的搜索结果或其他受管来源。初始版本及第一版修复只在恢复和回读时校验来源；随后直接把撤回内容发给下一次主模型调用。强制压缩的分支还会先把撤回内容发给摘要模型。

修复在发起下一次主模型、摘要和 Token Count 调用之前重验来源，并保留既有恢复证据。新增断言也覆盖 Token Count 合法完成后、生成前发生的撤回，确认之前的校验结果不会被复用。已确认的来源撤回返回 `context_failure`、`retryable=false`，不被包装成可重试摘要故障。

## 已验证的机制

| 场景 | 独立验证内容 | 结果 |
| --- | --- | --- |
| 回读后恢复 | 0/1/3 次压缩后仍验证原始资料 | 初始失败，修复后通过 |
| 旧数据兼容 | 没有 sourceTool 的旧完整调用结果组，工作历史与后续压缩归档都重新检查来源 | 初始修复遗漏，补齐后通过 |
| 兼容关联准确性 | 跨组相同 call ID 不覆盖旧来源；普通失败回读允许模型收到错误并继续 | 修复审查发现并补齐后通过 |
| 调用前撤回 | 直接继续、先压缩、先 Token Count 三种路径都在下一次请求前拒绝，失败不可重试 | 初始失败，修复后通过 |
| 计数后撤回 | Token Count 完成后来源变化，生成请求仍被阻止 | 通过 |
| 原始对话回读 | 配置 history binding 时能读用户原话，恢复不寻找名为 transcript 的快照 | 通过 |
| 完整工具调用组 | 0、100、500、1,000、3,000、10,000 字符预算下，已完成组整体保留或移除，未完成组完整保留 | 通过 |
| JSON 定向分页 | 160 条合成资料逐页回读后与输入逐条完全一致，单位、条件和脚注均保留，每页有明确后续位置 | 通过 |
| Scope 隔离 | tenant、workspace、run、session 任一维变化均不能读原归档 | 通过 |
| 旧记忆依赖 | history binding 变化后，即使只选择某一 JSON 字段也不能读取旧归档 | 通过 |
| 循环依赖 | 两个快照相互引用时只读取两个快照，仍检验同档中的撤回来源 | 修复后通过 |
| 依赖遍历上限 | 129 层链在读取 128 个快照后停止，未调用 Provider | 修复后通过 |
| 摘要累计预算 | 同一个摘要器前 4 次调用使用完预算，第 5 次不调用 Provider，明确标为 INCOMPLETE | 通过 |

循环、上限测试验证受控终止，不表示任意长度的历史都能继续恢复。超出上限需要重建任务。

## 仍存在的设计限制

- **无换行超大单消息无法通用回读。** 32,030 字符的合成单行超过摘要输入预算，摘要器保留原文引用并标为 `INCOMPLETE`；默认整条消息回读和 `messageIndex` 行回读都返回 `single_unit_exceeds_budget`、`nextOffset: 0`。原文没有被删除，但当前通用工具不能把这段文字完整读出来。JSON 数组或多行文本可以分页；普通单行需要未来增加显式片段读取或专用源工具。
- **覆盖完整表示处理过所有消息。** 它不证明摘要保留了每个否定条件、单位、确认状态或未解决事项。本审计的 Fake 摘要不能支持任何真实语义质量结论。
- **4 次摘要预算覆盖一个执行片。** 多次压缩共用预算；预算耗尽后的新增遗漏只有引用和不完整标记。此限制能控制额外调用，但任务能否通过回读补齐仍依赖任务质量评测。
- **来源校验采用整档粒度。** 选择一个字段也先校验整个归档。一个来源撤回可能阻止读取同档其他内容；这是保守边界，当前没有记录级依赖拆分。
- **字符数与 Token 不等价。** 当前缺少真实 tokenizer 时还有字符触发路径，不能把某个字符常量直接视为 DeepSeek 容量。本审计不决定在线阈值；主任务的隔离模型对照另行记录实际 usage 与任务结果。

## 验证记录

初始 18 项新增测试：15 通过、3 失败。另复跑原有 `contextLifecycle.test.ts` 与 `runtime.contract.test.ts`：41 通过。

第一版来源链修复后，原 18 项加 41 项既有测试共 59 项通过；继续增加旧数据兼容、循环、上限、执行片中撤回场景后，共 24 项新增测试，20 通过、4 失败。失败项为旧数据兼容 2 项及执行片中撤回 2 项，均已提供主任务修复。

最终独立复测：2026-09-22 17:17（Asia/Hong_Kong），新增审计 28 项全部通过；与原有两个相关文件合跑共 **3 个文件、69 项通过、0 失败**。服务端 TypeScript 检查及工作区 `git diff --check` 通过。

此次独立复测确认已修复上述来源链、旧数据兼容和调用前重验问题；不扩大为全部项目、真实模型语义或生产可靠性结论。

复测命令：

```sh
npm test -- --run server/runtime/compressionReadback.audit.test.ts server/runtime/contextLifecycle.test.ts server/runtime/runtime.contract.test.ts
node_modules/.bin/tsc -p tsconfig.server.json --noEmit
git diff --check
```

本报告的真实摘要语义质量为 **NOT_EVALUATED**。离线 Fake 延迟、估算 Token 和覆盖消息数量不能当作线上成本、模型理解能力或生产完成率。

## 第一阶段确认闭环追加审查

追加范围为 TaskCheckpoint Schema/Store、任务上下文构建、个人记忆组合、ConversationApi、Host 路由和 UI 代码。UI 完成代码审查，未进行浏览器视觉验收。生产 Plan 修复由本审计子任务在明确授权的 `agentPlanWorkflow.ts` 及其测试内实施，其余生产修复由主任务完成。

按风险分类的发现及处理：

| 级别 | 发现 | 处理与验证 |
| --- | --- | --- |
| P1 | 旧外置回读 singleton 没有成组调用信息或 sourceTool，原始来源撤回时仍可能继续送给模型 | 已补充对 Host 回读封套的兼容识别，沿 sourceRef 重验原始来源；撤回后返回不可重试 context_failure，Provider 调用为 0；独立回归通过 |
| P1 | Plan 上下文超限或来源暂不可读时，查看/暂停/取消/退出也依赖模型上下文构建；checkpoint 又要求先退出 Plan，形成恢复死路 | 已加入轻量 assertAvailable，只查主体与会话存在；停止和非活跃 dispatch 不构建上下文，活跃 dispatch/执行/确认仍检查当前输入；5 项回归通过 |
| P2 | checkpoint POST 在等待请求正文之前读取 Session 和 Plan 状态，慢请求可能使用过期来源确认 | Host 已将正文读取移到状态检查前，后续读取与 command 同步执行；代码复核通过 |
| P2 | 阶段整理确认后旧 objective/最后旧用户消息可能重新带入被替代要求；简单清空全部历史又会丢失本轮新图片 | Host 使用 checkpoint 目标，只保留精确匹配当前 turn 的待处理输入；新增 resume 图片回归通过，旧用户消息不再进入工作请求 |

独立追加验证：

- 真实 `ConversationApi.send` 路径下，80 条合成原话超过 64,000 字符时拒绝且 Provider 调用为 0；明确确认阶段整理后再次 send 成功，上下文低于 5,000 字符，原始 transcript 逐条相等。此处没有绕过 Controller 直接调用构建器。
- 确认前候选不生效；两个 Store 实例对同一记录的过期 revision 被拒绝，相同命令可幂等回放；同一句用户原话的附件 hash 变化仍使确认失败。
- 当前 Fact/版本/审批继续由原 Host 状态提供；检查点不会把进展文字变成 Stage 完成证据。
- 个人记忆与检查点的 historyBinding 组合可重复构建，Plan 冻结输入重新装配后得到同一绑定；来源变化仍由 Plan 原版本检查拒绝。
- Plan 停止操作在 40,000 字符上下文和上下文服务故障两种情况下均可完成；不新增模型调用，队列被取消，退出后可读取工作区。跨 tenant/workspace/run 和会话删除仍拒绝操作，删除协调仍取消原计划。

追加复测命令：

```sh
npm test -- --run server/runtime/compressionReadback.audit.test.ts server/enterprise/agentPlanWorkflow.test.ts server/enterprise/taskCheckpoint.test.ts server/enterprise/personalMemory.test.ts server/runtime/contextLifecycle.test.ts server/runtime/runtime.contract.test.ts
npm run eval:plan
```

17:31 的追加结果为 6 个文件、120 通过、1 失败；唯一失败是旧外置 singleton 来源校验。主任务补齐旧来源封套兼容校验后，17:35 的独立复测为 **6 个文件、121 通过、0 失败**，其中本审计新增 32 项。两个 Plan 离线固定场景通过；此前服务端类型检查通过，但最终并行收尾时新增 `eval/productSmoke.ts:236:60` 的 TS2571，已交主任务修正并待最终重验。上述审计发现均已闭环；本节没有把离线通过扩大为真实模型语义质量或 UI 视觉验收结论。

主任务收尾补记：上述 TS2571 已修正，最终 TypeScript 检查、Vite 构建及完整 HTTP 产品回归均通过；独立浏览器 fixture 的验收结果和全量验证边界见[第一阶段报告](context-phase1-report.md#工程验证)。本节保留独立审计完成时的原始记录。
