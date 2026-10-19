# 2026-10-19：只读来源、报告业务依赖与结果恢复补齐

基线：实际远端 main `866379759e2113fd7948cf671e7c17a48f995660`（PR #54）。独立工作区：`/Users/black/Documents/Codex/2026-10-19/task/packx-readonly-parallel`，分支 `codex/readonly-source-invalidation`。用户追加要求“把还没有的补齐，测试没问题提交”：仅授权本地提交，不推送、创建 PR、合并、部署或调用付费模型。

## 范围与可核验行为

本次连同[第一轮来源主动失效](readonly-source-invalidation-2026-10-19.md)一并交付。三项补齐与设计取舍见 [ADR-0039](../adr/0039-readonly-source-recovery-and-report-dependencies.md)：

- 活动只读批次与 Provider 等待每秒复用既有来源校验；附件撤回、普通文件替换/删除、权限或归档来源变化可在请求尚未返回时中断。合法不可变历史备份保持原可读合同；不保证远端停止计费。
- 报告绑定 Plan 可显式导入未验证需求单，保留受保护 `report_source` 依赖；报告变化使已有 Artifact stale、Approval superseded，旧浏览器审批和目标历史版本导出被拒绝。已确认业务 Fact、历史内容和审批记录不被模型改写。覆盖生成及独立复核等待，不宣称任意业务对象的通用依赖图。
- 独立 `reconcile` 动作仅校验和取回已持久化 Session/完成 Trace，在单版或跨版额度耗尽时不调用 Runtime/模型、不增加调用计数、不派发新节点；部分结果保留，不造假完成。任务键、Session、最终消息和对话记录、工具状态、自评、Schema 和来源均须匹配。
- 原生退出 fixture 先确认部分输出及 PID，再强杀进程组，finally 清理。非超时 fixture 的执行上限改为 5 秒，测试总时限仍是原 5 秒，生产执行器及专用 50ms/1s 超时回归不变。

## 检查记录

本机使用 Node 24.14.0。以下为本地实际检查输出；这不是远端 CI 或真实模型验收。测试环境使用仓库 `testEnvironment` 剥离真实模型凭证，应用使用本机确定性 Provider。

| 检查 | 当前结果 |
| --- | --- |
| 类型检查与定向回归 | 类型通过；文件监控 11/11、计划并行与业务 API 74/74 通过；新增完成证据故障矩阵与收据身份检查 31/31 通过 |
| 完整 core、构建与 12 项离线 Eval | 1,284 通过、0 失败、50 个既有平台条件跳过，共 1,334；类型、构建和全部 12 项离线 Eval 通过 |
| 三种尺寸/语言浏览器 | 正式 browser 入口 54/54 通过，0 跳过、失败或 flaky；桌面中文、390px 中文、320px 英文均覆盖 |
| 完整 native 与真实 Host HTTP 流程 | 正式 native 入口通过：48/48 原生安全回归及全部真实 Host HTTP 流程，包含挂起独立复核在 Provider 返回前停止 |
| supervisor 退出 fixture 稳定性 | 固定三次独立运行均通过，其他 29 项因定向过滤未执行；完整原生套件随后 48/48 通过 |
| 策略、凭证、依赖、差异和原目录保护 | 工作流/路径策略通过；凭证负对照、包含全部 39 个候选文件的跟踪树与完整 Git 历史均无发现；依赖审计各严重度均 0；差异检查通过，原目录 179 个文件内容/权限/状态一致 |

## 新增应用验收路径

真实 Host HTTP、队列、Runtime、Adapter、事件及 Artifact，模型仍为本机固定 fixture：

1. 来源报告→只读 DAG→未验证需求单→显式字段确认→审批→可导出；清除选择后交付过期、审批失效，旧请求和旧导出被拒绝。
2. 两节点的 Provider 请求保持挂起，通过附件撤回入口移除底层来源，不调用报告选择 API；在放行响应前计划已失败，迟到结果不能入库。
3. SIGKILL 丢失租约后按既有死 PID 锁恢复；没有完成记录时 `reconcile` 返回明确错误，模型计数不变，再由用户显式 resume。
4. 已完成的两个真实 Runtime Session/Trace 保存后停机；fixture 向计划追加“协调器丢失收据”的故障事件，预填 16 片上限并标记中断；重启后 `reconcile` 取回原收据且重复命令幂等，真实 Provider 计数不变。预填不是实际消耗 16 次调用，更不是精确费用测量。
5. 需求单独立复核 Provider 保持挂起时撤回报告；在放行前应已有 context_failure Trace、过期草稿和停止 job，无新审批。

## 复现和演示

```sh
node --import tsx scripts/ci.ts core
node --import tsx scripts/ci.ts browser
node --import tsx scripts/ci.ts native
npm run dev:fixture
```

在演示任务上传文本并创建、明确选择报告后，使用 `parallel-fixture-success` 规划；确认图后可观察两个只读节点重叠。撤回附件或清除报告，应无需等待模型返回就停止。重选有效来源后重新规划、重新确认；完成后可点击“将结果转为需求单草稿”，逐字段核对并单独审批。撤回报告后，旧需求单和审批不再有效。

预算耗尽后的正向恢复需已有可信完成 Session/Trace；使用上面的自动故障注入流程重现，不能为人工演示随意编辑真实用户数据库。界面中的“核对已保存结果 · 不发起模型请求”与恢复执行各自独立。

## 失败历史和剩余边界

第一轮完整检查的既有初始化超时与原生 fixture 波动保留在[原记录](readonly-source-invalidation-2026-10-19.md)。本次新增文件监控测试最初误用了已审批保存的历史备份，等待取消而超时；改用普通当前文件并保留历史备份可读回归后通过。报告链回归也实际发现 `report_source` 被投影为业务字段而挡住审批，已将其与其他来源容器一起排除，确认门槛仍覆盖真实业务字段。首次完整 core 发现已有复核输入测试仍固定 v2.7，当前策略已加入报告来源元数据边界并升为 v2.8；同步其精确版本断言后重新运行完整门槛。完成收据的首次定向检查误以为 Trace 保存最终文本；现有 Trace 按设计脱敏，修正为任务键、规范消息 ID 和原有对话记录的一致性核对，未向日志新增正文。收尾审查另发现报告读取的原 catch-all 会把存储异常投影为 unavailable；已收紧为有明确证据的撤回/变更/完整性或政策失败，其余错误上报且保留绑定，增加真实 SourceReportWorkflow 的三项回归。测试编写期间的越界变量与 HTTP 202 断言已修正；生产限制、CI 门槛及超时专用回归时限未放宽；非超时 fixture 的执行时限调整已如实列出。

本地提交时尚无实际远端 CI、真实 Windows runner、付费模型调用、正向公网网页验收或真实包装用户收益证据。节点独立租约、跨图并发、公平性、并发写入、任意代码和任意业务依赖图继续延期。网页默认关闭；执行片/调用次数不等于精确费用上限。未新增依赖、凭证或系统安全设置。


## 本地原始证据

正式入口日志保留在本机：`/private/tmp/packx-completion-core-verified.log`、`/private/tmp/packx-completion-browser-verified.log`、`/private/tmp/packx-completion-native.log`；安全检查见 `packx-completion-{policy-final,secrets,audit}.log`，最终构建见 `packx-completion-build-final.log`。首次 core 失败为 `/private/tmp/packx-completion-core.log` 与 `packx-completion-core-failed.json`。定向诊断另在 `packx-{source-file-watch,report-chain,reconcile-evidence,receipt-watch,source-store-error,native-stability,completion-product}.log`。不把带完整本机路径的运行日志或真实用户数据加入仓库。

core 的 50 项条件跳过为 38 项 macOS 原生条件项与 12 项 Windows 条件项；macOS 正式 native 入口另外完整执行了 48 项，未跳过。离线 Eval 为 offline、context、recovery、loop-safety、memory、m1、m2、plan、plan-graph、plan-parallel、source-report、packaging-lifecycle。此前 PR #54 的远端绿色不替代本次本地检查，也不代表本次已触发远端 CI。

## PR #55 发布后的流式验收修正

用户随后明确授权推送 `1b2a872`、创建 PR 并等待远端检查，不合并或部署。推送前重新获取并核对 main，仍为 `8663797`，已包含在提交历史中；原提交未重写。发布入口为 [PR #55](https://github.com/B1ackB/Packx/pull/55)。

[第一次远端检查](https://github.com/B1ackB/Packx/actions/runs/39269350655)的 core-offline、browser、windows-local-data 通过；native-product 的 48 项原生回归通过，但应用级流程在只读并行场景后以未处理的 SSE `terminated` 失败，聚合门槛因此失败。本地相同完整应用流程通过，不能用该结果覆盖远端失败记录。

流式验收存在两个可直接核验的缺口：用 Provider 的 150ms 延迟假设客户端一定先看到文本；断言提前失败时，后台读流未在关闭 Host 前清理，可能掩盖原始原因。远端原日志没有保留清理前的首个错误，不能仅从 `terminated` 断言具体业务故障。本次仅修正测试服务与验收脚本：固定服务发出部分文本后等待真实 HTTP 客户端确认，再结束响应；同时观察读流、消息请求和超时的失败，并在 finally 中中断、等待两条后台操作。10 秒超时、首段文本先于消息完成的断言及所有生产权限和 CI 门槛保持原样。若生产路径只在完成后一次返回，确认不会发生，验收仍应失败。

本地复核使用 Node 24.14.0：类型/构建、完整应用流程通过；临时故障注入在收到部分文本后强制断言失败，应以原始 AssertionError 退出、清理所有后台操作，不能再被 `terminated` 覆盖。完整正式 native 门槛重跑通过：48/48 原生安全回归及全部真实 Host HTTP 流程均成功。日志保留为本机 `packx-pr55-stream-{build,product,failure-probe}.log` 和 `packx-pr55-native-fixed.log`。最终远端结论以 PR 当前 head 对应的实际 Checks 为准；旧提交的绿色和本地结果不替代当前 head 的远端验收。

## 变更清单与原目录保护

本地提交包含 39 个明确列出的文件：14 个实现文件、10 个测试/应用评测文件、15 个文档与已有演示 PNG。原目录 main 保持 `8663797`，原有 179 个未跟踪文件的路径、内容 SHA-256、权限和状态均与保护清单一致，未暂存或提交其中任何文件。

```text
README.md
README.zh-CN.md
docs/README.md
docs/adr/0037-bounded-readonly-plan-waves.md
docs/adr/0038-readonly-source-invalidation.md
docs/adr/0039-readonly-source-recovery-and-report-dependencies.md
docs/evidence/readonly-parallel-2026-10-19.md
docs/evidence/readonly-recovery-completion-2026-10-19.md
docs/evidence/readonly-source-invalidation-2026-10-19.md
docs/evidence/readonly-source-invalidation-2026-10-19/narrow-source-invalidated-en.png
docs/plan-mode.md
docs/requirement-evidence-review.md
docs/source-reports.md
docs/workspace-agent-architecture.md
docs/workspace-agent-delivery.md
eval/productSmoke.ts
server/enterprise/agentPlanWorkflow.ts
server/enterprise/evidenceReviewWorkflow.test.ts
server/enterprise/parallelPlanWorkflow.test.ts
server/enterprise/sourceReportWorkflow.test.ts
server/enterprise/sourceReportWorkflow.ts
server/index.ts
server/manufacturing/planRequirementSource.test.ts
server/manufacturing/planRequirementSource.ts
server/manufacturing/requirementBriefApi.test.ts
server/manufacturing/requirementBriefApi.ts
server/manufacturing/requirementBriefWorker.ts
server/manufacturing/requirementEvidencePolicy.ts
server/manufacturing/requirementReportSource.ts
server/runtime/agentRuntime.ts
server/runtime/fileContextPermissions.test.ts
server/runtime/macOsSeatbeltSandboxedToolExecutor.test.ts
server/runtime/recoverCompletedTurn.test.ts
server/runtime/recoverCompletedTurn.ts
src/components/PlanPanel.tsx
src/enterprise/agentPlan.ts
src/i18n.ts
src/manufacturing/skills.ts
tests/browser/planParallel.spec.ts
```
