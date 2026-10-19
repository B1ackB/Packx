# Packx 工作空间 Agent：本轮交付与架构覆盖

2026-10-20 后续本地切片：完成后历史工具/文件来源复核已接入原 Trace/快照及权限机制，读取与导入等待复核，下游启动和最终发布也复核。新单节点只读任务使用同一路径，旧串行不回填。比较/目录工具仅核对旧引用，不重新检索。见 [ADR-0042](adr/0042-completed-tool-source-review.md) 与[验收/演示](evidence/completed-tool-source-review-2026-10-20.md)。本批获准验证后本地提交；未推送、创建 PR 或部署。以下早期状态保留为历史记录。

2026-10-20 本地增量：冻结输入依赖清单已实现，覆盖新只读图规划时已有的全部 Fact（含候选）和 Artifact；确认前可查看版本，完成后按原集合复核。新增下游草稿不反向失效，原有候选被确认则需重新规划。见 [ADR-0041](adr/0041-frozen-plan-input-dependencies.md) 与[验收/演示](evidence/readonly-input-dependencies-2026-10-20.md)。历史工具文件依赖仍延期；本地检查不代表远端 CI。

当前基线（2026-10-19）：PR #55 已合并至 main `42ff79c8a8e680ab436c170ca2d6f1aaab4e7b1d`，合并后的[实际远端 CI](https://github.com/B1ackB/Packx/actions/runs/39275683303)五项通过，未部署。下一本地切片补齐已完成只读计划的结果过期、导入阻断及显式重新确认，见 [ADR-0040](adr/0040-completed-readonly-result-validity.md) 与[本地验收/演示](evidence/readonly-result-validity-2026-10-19.md)；本轮未提交、推送或创建 PR。以下原批次说明保留历史阶段的范围与证据。

2026-10-19：最多两个只读节点并行已随 PR #54 合入 main `8663797`，提交 `cf0b18c` 的五项实际远端 CI 通过；未部署。[ADR-0037](adr/0037-bounded-readonly-plan-waves.md) 与[原验收](evidence/readonly-parallel-2026-10-19.md)保留该阶段证据。当前在此最新 main 上增量补齐报告变更时的主动来源失效，见 [ADR-0038](adr/0038-readonly-source-invalidation.md) 与[当前本地验收](evidence/readonly-source-invalidation-2026-10-19.md)；后续已补齐只读来源持续复核、报告业务依赖和零调用结果对账，见 [ADR-0039](adr/0039-readonly-source-recovery-and-report-dependencies.md) 与[当前验收](evidence/readonly-recovery-completion-2026-10-19.md)。仅授权通过测试后本地提交，未推送、创建 PR、部署或调用付费模型。

初始交付：2026-10-18。2026-10-19 产品负责人明确授权将本批升级推送、创建 PR，并在必需检查全部通过且没有实质阻塞后合并。分支 `codex/workspace-task-graph` 已正常合入 PR #40 后的 main `243b691`，无冲突且应用代码树未改变。发布过程与最终检查见[发布验收记录](evidence/workspace-agent-publication-2026-10-19.md)；不包含部署或安全设置变更。

本轮完成了一个有边界的链路：用户上传文本/选择允许的网页来源 → Host 持久化不可变快照与资料报告 → 用户明确选择报告版本 → 确认有依赖的计划 → 两个独立 worker Session 只读消费选定资料及声明上游结果 → 展示带来源的未验证任务结果。既有需求单、模板库、原生文档和直接执行保留。仍是本地原型，不是完整通用平台。

[全面架构与阶段计划](workspace-agent-architecture.md)、[报告机制与演示](source-reports.md)、[最终实际证据](evidence/report-plan-bridge-2026-10-18.md)、[ADR-0036](adr/0036-selected-report-context-and-plan-dispatch-identity.md)。

## 可复现演示

使用 Node 24.14.0，在升级工作区运行：

```sh
# 固定两来源/哈希与不可信内容保留，网页传输为离线 Fake
npm run eval:source-report
# 完整真实 Host/HTTP/Queue/Runtime/Artifact 流程，模型为本机固定 fixture
npm run build:native
npm run eval:product
# 交互查看同一工作空间；退出时删除临时 fixture 数据
npm run dev:fixture
```

交互入口默认在终端显示的 `http://127.0.0.1:5178`。选择任务，上传 [客户文本示例](../examples/source-report-customer.txt)，在“资料报告”页签创建报告，查看后点击“将 v1 用于任务”。在对话处理方式选择“先规划”，输入：

```text
report-bridge-fixture: 请先读取所选报告，再汇总待核对的来源说法，保留未验证状态和引用。
```

这是固定 fixture 的触发词，输出不是模型实际分析。确认前可以看到所绑定报告 v1、所需工具及任务依赖；确认后显示读取与汇总两个节点的结构化结果。可暂停/恢复或取消；关闭页面不取消已确认任务。创建新报告不会改变选定版本。更换/取消选择后旧计划需要重新生成并确认。

自动 HTTP 验收额外执行了读取节点完成后暂停、Host 真正退出/重启、刷新本地 token、恢复汇总节点；断言已完成读取节点只执行一次。另一固定模型模拟遵从来源中的写入诱导，Host 拒绝未列入节点白名单的 file_write，无文件或审批产生。这证明执行边界，不证明真实模型会忽略提示注入。

生产网页读取仍由 `PACKX_SOURCE_WEB_DOMAINS` 的精确域名控制、默认关闭。本次 example.com 的 DNS 被公共地址规则拒绝，正向公网验证没有通过，不为演示改 DNS、开启私网或换路径。离线网页 Fake、浏览器请求拦截、真实 Host 文件链路及公网拒绝分别记录。

## 全面覆盖检查

| 关注点 | 已实现与本轮证据 | 设计但延期/实际限制 |
| --- | --- | --- |
| 协调器与图 | Enterprise 校验最多 4 节点 DAG，显式版本确认、确定性就绪顺序 | 不做任意递归、动态图中途变更或 Swarm |
| ReAct/角色 | 现有 Runtime/Provider/内部 ReAct 继续；不同节点使用独立 Session、目标与工具集 | 不为每个业务角色拆 Agent；角色路由无收益评测不扩展 |
| 动态分工 | worker 可报告 replan，Host 停止并生成新版本，需新确认，跨版本预算保留 | 没有自动无监督派生或无限重规划 |
| Agent/Tool 协议 | 复用 RuntimeTurnRequest/Result；新增严格只读 source_report_read，版本/摘要/选择修订号精确匹配 | 未接入 MCP/A2A 或远程 Agent 总线 |
| 上下文隔离 | 独立消息历史；只共享确认来源索引与声明的直接上游报告；工具按需读回 | 选定报告内部资料为共享范围；不是字段级权限或 OS 隔离 |
| 来源与 Artifact | source-snapshot.v1/source-report.v1 不可变、有 hash、时间、请求/最终来源及截断标记 | 摘录不是权威事实；HTML 不保证布局、实体或动态页面完整性 |
| 选择/撤回/失效 | 选择与清除均持久化修订号；新报告不替代选择；撤回、重选、政策收紧阻断读回和旧计划继续 | 已发往模型的数据不能收回；历史结果保留但不作为当前业务权威 |
| 持久化/检查点 | SQLite CAS/命令去重、现有 Queue lease、快照及子任务收据；跨进程停止恢复、Host 重启验收 | 单机，不是分布式数据库/HA |
| 幂等/超时对账 | 不重复已提交快照/节点；Artifact/事件窗口恢复；缺完成 Trace 停止；沿用文件副作用账本 | GET/模型响应不明窗口不承诺 exactly-once；副作用未知不盲重放 |
| 取消/重试 | 持久取消 + AbortSignal/lease fence；Provider/网络分类；剩余来源最多三次显式尝试 | 外部已发生操作不承诺回滚 |
| 派发身份 | 修复 scope actor/字段顺序导致的非规范 Plan job；取消过时 queued/leased job，保留规范意图 | 当前按本地队列扫描；规模增大再做作用域索引 |
| 并发与文件冲突 | 后续本地只读图每批至多两项，父图 lease + 持久节点尝试 + CAS 执行槽，依赖在后续批次汇合；含写入/旧图串行 | 没有跨图并发、节点独立 lease、公平性服务、并发写入、工作树自动合并或节点私有 staging |
| 权限/sandbox | 同 tenant/workspace/run/owner，工具白名单只能收紧；保护 Host 状态；网页公共地址固定、正常 TLS | 本机 owner 不是企业 RBAC；任意代码 sandbox 未实现 |
| 预算 | Plan 片数/迭代/Tool/输入 Token/版本/失败上限；并行调用前原子扣槽，未知/失败不退款，最后一槽不超卖；报告来源/字节/超时/重试上限 | 没有精确美元预留和全平台硬账单上限；无付费模型调用 |
| 人工确认/业务权威 | 报告选择≠计划确认≠文件批准≠Fact 验证；报告绑定 Plan 可显式导入未验证需求单，来源变化使 Artifact/Approval 失效，历史导出检查原依赖 | 仅接入已有需求单链路；没有任意业务对象的通用依赖图 |
| 流式 UI/观测 | 保留聊天 SSE；报告/Plan 持久状态轮询；可同时展示两个节点、等待上游、失败原因与恢复动作；追加事件关联节点尝试/父 lease/Session/Execution/来源 | 没有新 DAG cursor 重放协议、遥测后端或完整跨进程 tracing 服务 |
| 评测 | 同固定 Provider 的单 worker/图基线、来源 Eval、真实 Host 模拟模型闭环、权限/恢复攻击测试 | 不证明真实模型质量、速度、商业价值或真实用户成功 |
| 渐进迁移 | 原直接执行、旧无报告计划、需求单/模板库保留；新增选择字段可选 | 新工具/绑定不能与旧二进制混跑；回退先停止新任务并保留数据 |
| 环境/交付边界 | PR #40 已合并；本批升级另行按 draft PR → 全部 CI → ready → merge 流程发布，实际结果单独记录 | 公网正向读取仍未验收；远端 Windows CI 与员工真机不同；未部署 |

## 从串行到有界只读并行

原演示的汇总依赖读取，不会因提高并发缩短关键路径。后续本地阶段另用两个独立来源读取后汇总的固定图验收，复用单图排他 lease，新增持久 taskRuns 和调用前原子执行槽；每批至多两个独立 Session，批次后 checkpoint，现有队列继续调度。含写入和旧图不并行。取消/失败中断同批，完成收据保留，迟到结果不能绕过 lease、代次、尝试和来源检查。

SIGKILL 后遵循现有 recover-lock 的旧 PID 核验和审计；丢失 Queue lease 的计划等待用户恢复和完成记录对账。固定同图/同预算对照证明两个独立请求重叠，输出与 fixture 调用量一致；不证明真实模型速度、质量、用户价值或精确费用。独立节点 lease、跨图并发、公平性服务和并发写入仍为后续，见 ADR-0037。

## 只读来源变更后的主动停止

旧验收在撤回选择后放行了挂起 Provider，因此只证明迟到结果被拒绝。新切片要求两个请求保持挂起时，清除或重新选择报告就使旧计划失败并取消 worker；另覆盖一项完成、一项挂起时保留历史结果。事件先于取消落盘，重启或重放不会重复失效或继续扣槽。界面提示来源/报告已变，保留结果需核对，提供重新规划并重新确认；不显示直接恢复入口。未知存储错误保留原状态并报错，不伪造撤回证据。

## 差异收尾审查

按“权限/事实 → 持久状态 → 派发/取消 → 上下文/读回 → UI/证据”检查本轮新增差异，发现并修复了 Plan 非规范 job ID，以及模型响应后、工具执行前缺少 live context 检查两个可靠性缺口；都留有回归。后续补齐报告绑定计划到未验证需求单的来源依赖，并复用已有 Artifact stale/Approval superseded 事件；权限、字段确认和最终审批继续由 Host 分别控制。保留所有 CI 门槛，无新依赖、凭证或系统安全更改。

早期测试、条件跳过、未运行项和环境阻塞在[原证据](evidence/report-plan-bridge-2026-10-18.md)中分别列出；后续只读并行的实际检查、失败修复、演示与限制在[当前证据](evidence/readonly-parallel-2026-10-19.md)。下一步优先验证真实用户是否需要两项独立读取，以及结果来源与核对成本；公网正向读取、任意业务类型依赖扩展和模型语义评测继续保留独立 Gate。费用、权限或部署范围变化另行决定。

## 本地可靠性补齐

活动只读批次与 Provider 等待每秒核对实际已读来源；报告 API 外的附件撤回和普通文件变化也可中断。报告绑定计划可导入未验证草稿，后续来源失效传播至已有需求单 Artifact、审批与导出。预算耗尽的已停止只读图可单独核对已保存结果，零新增 Runtime/模型调用；部分结果保留，不启动缺失节点。原生故障 fixture 用写出后强杀替代启动速度假设，生产执行器与专用超时门槛保留。实际检查、首次失败及限制见[补齐验收](evidence/readonly-recovery-completion-2026-10-19.md)。
