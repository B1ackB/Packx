# 上下文管理：实现、运行与验证

更新：2026-09-24。基础决策：[ADR-0024](adr/0024-separated-dialogue-and-versioned-task-context.md)；第一阶段任务整理与回读修复：[ADR-0027](adr/0027-confirmed-task-checkpoints-and-readback-validation.md)。下文标为 2026-09-20 的数字保留当时验证范围；真实 DeepSeek 阈值对照见 [第一阶段报告](evidence/context-phase1-report.md)，最新检索排序与状态评测见 [回读收敛报告](evidence/context-search-convergence.md)。

原始对话、工作上下文、业务事实、知识与跨会话偏好的范围、确认、失效和删除边界，以及当前实现导图，见 [记忆系统](memory-system.md)。2026-09-21 已实现同一工作区当前用户的显式确认个人偏好与笔记；组织／客户共享记忆和自动经验学习仍未实现，不能用上下文恢复机制代称。

2026-09-21 补齐的执行恢复见 [可靠性恢复](reliability-recovery.md)：模型调用前先用执行证据修复未决文件账本，再重建确定性回执；这与摘要或对话恢复是独立职责。文件补偿与检索降级也在该文档中记录，下面的上下文 Baseline 数字保留原验证日期。

## 实际调用链与职责

```text
UI → Conversation API → Session.transcript（原话与正式回复）
                    ↓
Session / Event Store / Fact / Artifact / 资料索引
  → Enterprise buildTaskContext（当前权威状态 + 非权威笔记）
  → AgentRuntimePort → Runtime Adapter
  → ContextEngine：策略、任务数据、近期消息、来源引用
  → AgentLoop：计数 → 外置/清理/压缩 → 重计数 → Provider
  → 完整 Tool batch checkpoint / 正式回复 → Session.messages
  → ContextSnapshot / 执行账本 / Runtime Trace / 数值遥测
```

普通会话的 `server/index.ts:conversationTaskContext` 读取当前 Session、关联需求单 Run 的事件投影、附件和已选知识。Plan 的 `readInput` 复用此函数，保留 revision 和完整 context 的确认检查；规划和子任务以确认版本中的 taskContext 执行，各自 Session 隔离。需求单 Worker 使用同一个 Enterprise 构建器及当前业务状态。包装字段、证据核对与审批规则继续位于 Domain Pack/原有业务工作流。

`buildTaskContext` 输出目标、按时间排序的完整用户原话、当前 Fact（值/单位/确认状态/版本/来源）、阶段、已完成事件、未确认事实与失效来源、待确认修改、Artifact 版本和审批、资料引用。新待确认值和旧已确认值分别呈现，不偷偷恢复旧值。基础构建器将最近两条正式回复作为 `unverified` 工作笔记，过长时只放 transcript 引用；当前 Host 接入个人记忆后，`PersonalMemoryService.context` 会清空这些 workingNotes，避免旧偏好经助手笔记重新注入。

原始用户消息是约束与请求来源，不能代替 Fact 的人工确认事件。自然语言冲突不会被自动判定为已解决：当前存储版本优先，用户原话保留顺序，显式后续更正优先，无法确定的矛盾需要澄清。2026-09-22 起，用户可在“个人记忆 → 整理当前任务的要求与进展”创建候选并确认：生效版本替代更早的对话要求，后续用户原话继续完整加入，原始 transcript 保留供回读。未确认前仍保留全部原要求。必须内容超过 64,000 字符（Plan 仍为 32,000）或模型输入硬预算时停止；读取 Plan 状态及暂停/取消/退出不再受模型上下文构建失败阻断。

## 原始历史、幂等与迁移

- `agent-session.v2.transcript` 追加保存有稳定 ID 的原始用户消息和正式助手回复；`messages` 可被压缩替换。原话明确标记 `kind=dialogue`，即使内容引用旧摘要标记也不被隐藏。内部 `summary/receipt/task_context` 不进入 UI。
- Session revision compare-and-swap、文件锁及原子替换同时保护 transcript、working messages 和 checkpoint。同一 ID 不同内容拒绝；完成 Turn 的相同请求复用结果，Runtime 还要求已有完成 Trace。原用户输入已失败而后续消息已完成时，旧请求不会被误报成功。
- 工具调用与结果按完整 batch 保存 checkpoint；未决副作用以既有执行账本为准，unknown 不自动重放。成功回执缩成近期状态和 `execution_ledger_read` 引用，不删除幂等键或完整执行记录。崩溃发生于副作用与 checkpoint 之间时仍依赖执行账本，不承诺只读工具在任何崩溃时点都不重读。
- 读取 v1 时只保留实际存在的原话/正式回复，确定性补足消息 ID，标记 `legacy_partial`，UI 显示缺失提示。旧摘要与没有来源校验元数据的工具正文不作为新工作上下文；完整 v1 JSON 数据首次 save 写 v2 前备份到对应 Run 的 `migrations/<sessionId>.v1.json`。已丢失的历史不能恢复或由模型补造。

升级操作：停止旧 Host/Worker，备份 `.blackx-data`（或实际配置的状态、Event Store、Artifact、队列目录），使用新版本正常读取并继续会话即可惰性迁移。迁移测试使用临时目录，本次未批量改写用户真实业务数据。回滚前停止新 Worker 并恢复一致的数据备份；旧程序不得继续写 v2。Session 已写入完成回复而完成 Trace 尚未写入的极小崩溃窗口会要求核查，不冒险重复执行。

## 压缩与继续读取

1. 大工具正文先保存为当前 Session 下的不可变 ContextSnapshot。超过工具结果上限时返回完整 JSON 引用封套，不切断 JSON；较早、可回读的完整工具组正文优先换成引用。
2. 稳定策略、当前任务数据、pinned 消息、未完成 Tool batch 和未决执行状态必须保留。工具调用与结果成组保留或移除。必留内容本身超限时返回 `budget_exceeded`。
3. 被移除的完整消息归档后，摘要按完整消息分批调用。工作历史裁剪保证工具调用／结果成组；摘要器不额外保证每个输入批次都含完整工具组。摘要有非权威标记、实际覆盖范围和原文引用；超大单消息、预算耗尽或超预算输出都明确为 `INCOMPLETE`，不使用截尾输入或截断输出假装覆盖成功。
4. `context_read` 在当前 tenant/workspace/run/session 读取原始 transcript 或快照，按完整消息/行分页。`messageIndex` 已选择消息正文；`jsonPointer` 只选择正文 JSON 内的字段，不要加包装层 `/content`。默认仍按完整单元分页，单条超过页预算返回 `single_unit_exceeds_budget`；显式提供 `characterOffset:0` 可读取有分片标记的精确文本，并沿 `nextCharacterOffset` 拼接，不能把半个值当完整证据。
5. 不知道原文位置时，用 `query` 在指定来源及其 Host 声明的归档依赖内搜索字面关键词，得到可直接读取的 `sourceRef/messageIndex` 和非权威片段。导航区分只含原话／正式回复的 `transcript` 与保存工具结果的 `archiveRoots`；后者来自当前 Session 的来源依赖，并逐个复查权限和历史绑定。正文自行声称的来源不进入导航或遍历。
6. 搜索命中附 `sourceKind`，按 Host 消息元数据区分对话、工具记录、摘要、回读、回执及任务上下文／指令；对话和工具记录优先，其余命中仍全部保留并可分页。缺少 `sourceTool` 时，只用同一来源内连续 assistant/tool batch 的调用 ID 判断回读或回执；无法配对的旧孤立工具记录仍为 `tool_result`。这些标签表示来源类型，不表示已核验、当前有效或事实优先级。

示例工具参数：

```json
{"sourceRef":"tool-result-<executionId>-1","messageIndex":0,"jsonPointer":"/rows","offset":0}
```

正文返回 `nextOffset` 时以同一 sourceRef/选择参数继续。文本分片返回 `nextCharacterOffset`，与完整单元分页独立；按 UTF-16 字符位置续读，避免切断合法代理对。`sourceRef=transcript` 可回看原始对话，其中不含工具结果。快照绑定和当前任务不同会标记 `stale`，不能覆盖当前确认状态。

关键词搜索每次最多扫描 32 个来源、2,000,000 字符或 10,000 条消息，超限明确返回 `searchComplete:false`。返回的 `searchedSourceRefs` 标明访问范围；只有 `searchComplete:true` 才能表示这些来源已完整扫描，同一关键词无需再逐个子来源重复搜索。`offset` 只翻命中页；当前没有单个归档内部的扫描续读游标。搜索命中页最多 8,000 字符，为来源列表留出结果封套空间。导航最多给出 8 个根并标记截断，也没有根列表下一页。该能力是有边界的本地定位，不能据空结果断定全历史没有证据。每次结果附本执行片在整批工具扣额后的剩余工具／迭代数；提示模型直接使用当前 Host 状态、保留已知待核验状态、证据足够后完成回答，硬预算和停止保护仍由 Host 执行。原文在压缩后可能需要再次读取，因此不按“曾读过”强制去重。

`document_read` 返回完整行、页码/行号、源哈希、截断状态与 `sha256:offset` 游标；每次读取重新检查附件或本地路径权限和哈希。Native parser 1.2.0 的提取结果进入既有 inspection Artifact cache；重启后可继续读取，缓存键含 parser 版本。目前每次续读仍重新运行源解析，缓存用于受控留存，尚未优化为直接分页读缓存。表格保留整行，DOCX 表格及 footnotes/endnotes 纳入提取。扫描件仍不提供 OCR；提取仍受 10 MiB 输入、1,000 页/表、1,000,000 Swift 字符限制，并显式标记 sourceTruncated。

`knowledge_search/knowledge_selected` 保留被省略证据的 ID、contentHash 和位置引用；`knowledge_read` 重新检查生命周期、有效期和权限，按完整文本/参数/表格行继续，表格行重复携带表头、单位、条件和脚注。图片先保留引用，只加载当前选择输入/恢复中 pinned 输入所需图片，加载时校验哈希；历史图片不会自动全部进入请求，尚无模型自主视觉相关性排序。

恢复及 `context_read` 会沿摘要的来源快照依赖重新调用源工具校验器。文档变化、证据撤回、权限失效、缺少校验器或缺少快照均停止；最多遍历 128 个不同快照，超过时要求重建。普通会话每次模型请求重新比较存储构建的 task binding；Plan/需求单由原工作流核对输入版本，并在 Session checkpoint 比较冻结绑定。摘要笔记永远不是事实或授权来源。

## 预算与可观测性

输入硬上限：

```text
min(应用输入上限, 模型上下文容量 - 输出预留 - 安全余量)
```

| 配置 | 默认值（Token） | 来源 |
| --- | ---: | --- |
| `PACKX_MODEL_CONTEXT_TOKENS` | 官方 DeepSeek Flash 端点：1,000,000；其他：131,072 | 已核实的 DeepSeek 容量或保守应用策略；显式配置优先 |
| `PACKX_MODEL_MAX_OUTPUT_TOKENS` | 4,096 | 应用输出预留，同时限制 Provider 输出 |
| `PACKX_CONTEXT_SAFETY_TOKENS` | 8,192 | 应用安全余量 |
| `PACKX_MAX_INPUT_TOKENS` | 100,000 | 应用主请求硬上限；任务可进一步收紧 |
| `PACKX_COMPACT_TRIGGER_TOKENS` | 有效输入上限的 70%，通常 70,000 | 可配置；启动校验不得超过有效输入上限 |
| `PACKX_COMPACT_TARGET_TOKENS` | 有效输入上限的 45%，通常 45,000 | 可配置；必须小于触发阈值，是目标而非精确保证 |

通用默认值来自 `src/agent/tokenBudget.ts` 的 `packx-application-policy.v1`，DeepSeek 官方端点识别及配置校验在 Host `createRuntime.ts`。这些环境变量用于在线 Runtime 装配；Fake 不联网。压缩后重计数，仍超限拒绝。窗口错误最多再压缩重试一次，不能绕过输入预算。`ContextEngine(24_000)` 的字符限制仅是没有 Provider token counter 时的后备触发器，不是已连接 DeepSeek 的正常压缩阈值。阶段整理的 16,000 字符提示也是独立的产品提示。

优先 Provider Token Count；不提供该能力时使用 UTF-8 字节/3、每消息协议余量、工具定义、输出 Schema 和每张已加载图片 4,096 Token 的回退估算。估算不是 tokenizer，没有已验证误差上界，多模态误差依模型变化，不能当真实计费数。

默认每执行片最多 4 次摘要生成、16 次摘要 Token Count；单次输入最多 6,000、输出最多 512，累计输入加预留输出分配不超过 26,048。摘要还受该任务更低的输入/输出预算约束；同一片内多次压缩不重置计数。预算不够保留引用并标记未覆盖。摘要失败返回可追踪的 `context_failure`，原始历史与归档仍存在。

2026-09-22 增加摘要 4／8／16／32 次调用的隔离对照，以及回读定位和完成行为的同起点实测。默认预算与 70k／45k 阈值没有随实验上调；覆盖范围、模型实际保留的信息、主任务答案分别评分，见[回读优化与摘要预算报告](evidence/context-readback-optimization.md)。

2026-09-24 的 `context-readback.v2` 固定新评测 Schema，区分待核验、已通过、已不通过和完全未知；原先含歧义的布尔字段只存在于评测脚本，本次没有改写生产业务事实。旧评分保留。新增小型同条件 Tool 对照和状态控制题，记录原文是否进入实际模型请求，范围与结果见[回读收敛报告](evidence/context-search-convergence.md)。

主请求和摘要生成保存对应快照；摘要计数请求失败也保留输入快照。`context.summary`、`context.compacted`、RuntimeTrace 和 ModelTelemetry 记录调用/执行 ID、来源范围、快照、覆盖量、输入/输出 Token、计数结果、耗时和失败类别。Telemetry 只持久数值与标识，不保存 prompt、正文或原始错误；业务正文仅在受控 Session/Snapshot/Artifact 中。遥测最多保留最近 200 条并显式标记截断，完整长期趋势/存储归档尚未实现。缓存读取/写入统计沿用 Provider 响应，未知保持未知；没有实现新的 Prompt Cache 优化或缓存系统。

## 能力—代码入口—验证证据—剩余限制

本表保留截至 2026-09-20 的验证快照，表内“未测／未授权”指当时的状态。2026-09-22 和 2026-09-24 已在授权下完成有限合成在线评测，见上文链接；真实业务泛化仍未验证。

| 能力 | 代码入口 | 验证证据 | 剩余限制 |
| --- | --- | --- | --- |
| 原始历史与工作上下文分离、稳定 ID、v1 迁移 | `src/agent/state.ts`；`server/runtime/fileAgentStateStore.ts`；`conversationApi.ts`；`src/App.tsx` | `contextLifecycle.test.ts`：6 轮对话、重复压缩后 12 条原话/回复保持；重建 Store/Runtime 后一致；重试零新增模型调用；旧数据备份与缺口提示；字面摘要标记不误删 | 旧版本已经删除的原话不可恢复；未新增视觉截图验收，已验证 UI 使用的 API 投影和构建 |
| 当前任务、Fact 版本、阶段与来源 | `server/enterprise/taskContext.ts`；`server/index.ts`；`agentPlanWorkflow.ts`；`requirementBriefWorker.ts` | 早于最近 8 条的约束保留；当前待确认 v2 与旧确认 v1 分开；跨任务/租户 state/event 拒绝；原 Plan revision/context 确认回归通过 | 不自动判定任意自然语言约束的失效；来源“当前记录”不等于独立认证 |
| 成组压缩、摘要预算、可回读原文 | `src/agent/context.ts`、`loop.ts`、`summarizer.ts`；`server/runtime/contextRead.ts` | pinned/未决 batch 成组；完整 JSON 分页；单条过大显式错误；摘要输入/输出/总调用预算及失败测试；`eval:context` 固定对照 | 超大单消息未自动拆分语义片段；未覆盖部分明确 INCOMPLETE；真实语义质量未测 |
| 文档与知识继续读取 | `server/runtime/assetInspection.ts`；`native/AssetInspector.swift`、`OfficeReader.swift`；`server/knowledge/service.ts` | 本机文档 500 行逐段回读、服务重建、哈希变化拒绝；知识 30 行逐行续读保留单位/条件/脚注；撤回/跨租户/错哈希拒绝 | 解析硬上限、无 OCR；超大单行需专用处理，不能假称完整提取 |
| 暂停/恢复、未决副作用、成功去重 | `server/runtime/agentRuntime.ts`；`src/agent/loop.ts`；既有执行账本 | 完整工具组暂停重启后 execute 仅 1 次；绑定变化拒绝；摘要依赖的来源撤回时 Provider 调用为 0；原 runtime.contract 与 Loop Guard 回归 | checkpoint 前的只读重读仍可能发生；unknown 需核查；执行账本原语义不变 |
| 统一预算、摘要遥测、缓存统计 | `tokenBudget.ts`；`createRuntime.ts`；`modelTelemetry.ts`；`src/runtime/modelTelemetry.ts` | 必留超限生成调用为 0；Schema/多模态估算；摘要预算跟随任务；计数失败仍有快照；遥测无业务正文；HTTP SSE/缓存统计回归 | 回退估算误差未校准；本地数值延迟不代表模型延迟；缓存仅统计 |
| 回归与专项评测 | `eval/baselines/context-v1`；`eval/context.ts`；`docs/evidence/context-eval.json` | 冻结前 Baseline 420 通过；改后全量 441 通过；本机 30 通过；Plan/Loop/M1/M2/产品离线验收通过 | Fake 证明机制；未授权也未执行真实模型/付费评测 |

## 2026-09-20 验证结果

Baseline 在实现前冻结：HEAD `362561197c1429269529d73a10765754fa5a22e3`，含当时未提交工作；原 ContextEngine/摘要器源文件及哈希清单在 `eval/baselines/context-v1`。基线 67 个测试文件、420 通过、20 跳过。已有 37 个未提交文件的哈希全部保留在清单中，共用文件只作增量修改。

| 命令 | 实际结果 |
| --- | --- |
| `npm run check` | 69 文件，441 通过、21 按条件跳过；TypeScript 与 Vite 构建通过；测试阶段 6.76 秒 |
| `npm run build:native` | 本机 Swift 工具构建成功 |
| `npm run test:native` | 3 文件，30 通过；与普通测试存在重叠，不能相加称为 471 个独立测试 |
| `npm run eval:offline`、`eval:m1`、`eval:m2` | 离线契约、可恢复研究链、需求单固定场景通过 |
| `npm run eval:plan`、`eval:loop-safety` | 确认、自评/replan 检查点、独立上下文、重复动作停止与正常进展固定对照通过 |
| `npm run eval:product` | 本地 HTTP 固定 Provider：知识权限/撤回/恶意值、Plan、SSE、遥测、审批写入、原文备份、历史隔离、Native PDF、需求审批导出与删除审计通过 |
| `npm run eval:context -- --write` | 固定对照通过，报告写入 `docs/evidence/context-eval.json`；`check:local` 已纳入 `eval:context` |

专项使用同一个确定性“标记抽取”Fake Provider、相同 12,000 字符压缩目标、110 组工具输出及 3 轮压缩；输入含 4 条关键约束、2 个来源引用和一次 Fact 版本修改。候选额外携带当前结构化任务状态，故初始 Token 不同。UI 原话完整性在专项中是独立存储设计的对照断言，真实 Session/API 持久化证据来自集成测试，不把该断言当 UI 浏览器实测。

| 指标 | 冻结 Baseline | 改进方案 |
| --- | ---: | ---: |
| 关键约束文本保留 | 0/4 | 4/4 |
| 当前 Fact v2 正确 | 否 | 是 |
| 来源引用保留 | 0/2 | 2/2 |
| 调用/结果配对 | 通过 | 通过 |
| 原始对话保留 | 否 | 是 |
| 初始上下文估算 Token | 31,470 | 34,313 |
| 最终上下文估算 Token | 4,057 | 4,355 |
| 摘要输入估算 Token 累计 | 24,717 | 22,878 |
| 摘要输出估算 Token 累计 | 45 | 77 |
| 额外摘要生成调用 | 3 | 4 |
| 额外摘要计数调用 | 0 | 4 |
| 本机 Fake 耗时 | 1.106 ms | 3.038 ms |

这些结果只证明该固定样例中的确定性保留/来源/预算机制；不是总体正确率，也不是模型真实 Token、成本、网络延迟或摘要语义提升。最终工作上下文比旧方案略大，保留了旧方案丢失的必要状态。原始完整报告为 [context-eval.json](evidence/context-eval.json)，命令结果与已有改动保留清单见 [context-validation.json](evidence/context-validation.json)；复跑耗时会变化。

## 独立真实模型评测与后续

2026-09-20 基线的真实模型语义质量为 **NOT_EVALUATED**，付费调用为 **0**。原 `eval:context --online` 继续拒绝执行。2026-09-22 在用户明确授权下，新增独立 `eval:context-thresholds -- --online`，使用合成数据、费用上限、同模型同任务的三档阈值对照，并保留原始失败账本。小样本结果与限制见 [第一阶段报告](evidence/context-phase1-report.md)，不能视为生产总体正确率或完整摘要保真证明。

后续包括更细的超大内容语义片段读取、显式约束变更确认界面、长期存储保留期、真实语义评测与回退估算校准。Prompt Cache 仅在语义正确性与恢复链路稳定后评估 Provider 能力；当前只准确展示已有缓存统计。

上述后续中的“显式约束变更确认界面”在 2026-09-22 完成第一阶段人工整理闭环，真实语义评测完成小规模合成对照；自动候选生成、广泛真实任务评测和长期存储治理仍未完成。

## 2026-09-21：个人记忆依赖

[ADR-0026](adr/0026-confirmed-personal-memory-and-context-dependency.md) 增加可选 `historyBinding`，由 Host 传入，Core 只处理通用工作历史失效。个人记忆修订/撤回/到期/来源失效后重建工作上下文，旧派生快照不可回读；原始对话保留。有效期、确认和主体治理由 Enterprise 负责，详见 [记忆系统](memory-system.md)。新增 `context.rebuilt` 元数据事件，不改变执行账本的成功去重或未知副作用语义。
