# ADR-0036：选定报告版本进入 worker，上下文撤回与 Plan 派发身份

日期：2026-10-18。状态：Accepted，已实现；证据为离线模型/本机 fixture，不代表真实模型质量。

发布更新（2026-10-19）：本批已获独立推送与条件合并授权，纳入 [PR #53](https://github.com/B1ackB/Packx/pull/53)；历史授权描述按原日期保留，现行验证/迁移边界见[发布记录](../evidence/workspace-agent-publication-2026-10-19.md)。

## 背景

来源报告已形成不可变 Artifact，但与 Agent 仍是分离功能。产品负责人要求本轮最终贯通明确用户选择、DAG worker 读回与结果，处理撤回、恢复和权限；不扩展并行、任意代码或交互浏览器，不绕过公网地址拒绝。

## 决定

1. 用户以 CAS 命令明确选择一个已完成、可访问的报告版本。选择与取消都追加 `selectionRevision`；新报告不会自动替换选择。取消再选回相同版本也使旧任务绑定失效。
2. ContextEngine 只放 `source-report-binding.v1` 索引：同 scope 下的 Artifact 引用、不可变版本、报告摘要、选择修订号及来源指纹/快照引用，不内联全部正文。Plan 确认冻结该上下文，UI 显示所绑定报告版本。
3. `source_report_read` 是唯一新增 Agent 工具，属于 Host 只读能力。输入必须匹配当前选择的 version/reportDigest/selectionRevision；不能选别的任务或版本，也不接受路径/URL。报告摘录按需读取；保存原文每次最多 4,000 字符，带明确范围及 nextOffset。只读存储，不再次访问网页。
4. 工具执行、归档读回、每次模型请求、工具调用前与结果提交都检查 live 选择和来源。SourceSnapshot/Report 始终是数据，不是权限、指令、Fact 或审批。底层 ReAct 与 Runtime Port 不替换；只使用已有 Context callback、Tool validator 与 Hook。
5. 结果沿用 PlanVersion.children 的结构化、版本化记录及来源引用。现有需求单没有报告依赖的完整 Fact/Approval stale 传播，因此报告绑定的 Plan 暂时拒绝直接导入需求单，UI 隐藏该动作，服务端也拒绝。普通旧 Plan 的导入保持可用。
6. 联调发现既有 Plan job hash 直接使用 scope 对象；API scope 含 actorId 或字段次序不同会产生多份 job。改为显式 tenant/workspace/run + version/generation 的规范身份；reconcile 取消同 scope 下过时的 Plan queued/leased job 后补投规范 job。Session/key 不变，已完成节点/Trace 仍可恢复；不明副作用继续停在既有对账边界。

## 并行评估

以下为首批判断。后续产品授权下已按 [ADR-0037](0037-bounded-readonly-plan-waves.md)完成本地只读批次切片：父图 lease 保护最多两个运行节点，新增持久尝试和共享执行槽；独立节点 lease、跨图公平调度与精确费用预算继续延期。

本轮示例为“读取选定报告 → 汇总该节点结果”，存在真实依赖，不能靠并行缩短关键路径。独立只读并行还需要节点级 lease/状态投影、公平资源上限、共享预算预留、独立取消与固定串行对照，现有 activeTask/单计划 job 不是并行调度器。没有真实任务收益或延迟证据，因此保持 maxConcurrency=1，不宣称并行 Multi-Agent 已实现。

## 替代、迁移与退出

不自动选择最新报告，不把整份报告放入系统指令，不把版本号当权限，不用模型请求修改选择。没有增加新 Agent、队列、依赖或存储。旧报告状态缺少选择字段时保持未选择，旧无报告上下文行为不变。新绑定和工具不能与旧程序混跑；回退前停止新增任务并保留数据库/Artifact，不能删除选择修订号来恢复旧审批。

报告内来源是用户明确选择的共享资料范围，并不是每节点细粒度保密或 OS 隔离。已发送给 Provider 的内容不能因后续撤回而收回；正在外部执行的操作也不承诺回滚。撤回后停止后续读取/工具/提交，保留历史结果但不将它作为当前业务权威。

如收益不足可取消报告选择并使用原单 Agent/Plan；历史及来源保留。完整权威业务 Artifact 的依赖失效传播、跨用户 RBAC、并行和精确费用预算继续按独立 Gate 实施。

## 验证

实际测试与范围见 [最终交付与覆盖表](../workspace-agent-delivery.md) 和 [最终验收证据](../evidence/report-plan-bridge-2026-10-18.md)。完整 Host fixture 覆盖显式选择→模型模拟规划→工具读取→依赖节点→暂停/重启/恢复→结果，以及重选失效、未授权写入和需求单导入拒绝。正向公网仍未验证，保留 `web_private_address` 的先前拒绝，不更换路径规避。
