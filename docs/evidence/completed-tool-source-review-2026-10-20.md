# 2026-10-20：完成后历史工具与文件来源复核验收

最新远端 main 重新 fetch，仍为 PR #55 合并提交 `42ff79c8a8e680ab436c170ca2d6f1aaab4e7b1d`。复用独立工作区 `/Users/black/Documents/Codex/2026-10-19/task/packx-readonly-result-validity`、分支 `codex/readonly-result-validity`。上一阶段 24 文件逐项核对并在本机备份后继续增量开发；原目录 179 个未提交文件受独立内容/权限/状态清单保护。

本次用户授权实现、验证通过后本地提交，包含所依赖的 ADR-0040/0041 本地成果；不推送、创建 PR、合并、部署或调用付费模型。当前设计见 [ADR-0042](../adr/0042-completed-tool-source-review.md)。

## 基于代码的缺口与实现

原完成读取只核对冻结 task-context；历史 file_read、context_read、外置工具结果与压缩依赖仅在 Runtime 执行/恢复时核对。基线用真实文件、Runtime、Queue、SQLite 和完成 Trace 复现，文件变化后实际仍返回 completed。

本轮抽取并复用同一递归来源/权限校验，绑定原规划者及 worker 的 Trace、Session 与不可变最终/中间输入快照、同任务暂停片和摘要来源。读取/轮询、直接导入、后续节点启动及结果持久化等待复核；只读 Runtime 最终响应后也再次复核。单节点新只读计划使用相同路径，旧无标记串行和含写入计划不迁移。比较及目录工具复用知识库已有引用可读性检查，不重新检索或比较。没有模型、工具执行或新文件授权。

成功校验不缓存永久有效性；明确来源变化只追加一次 stale，保留原结果和计数；存储/证据/资源故障阻断使用并显示原因，未知故障不伪造撤回。页面关闭期间不扫整台磁盘，首次读取或导入修复离线变化。

## 实际验证

以下为最终代码的本地实际执行结果，不以先前阶段或远端 CI 替代。Node 24.14.0，使用仓库 CI 环境过滤；未新增依赖、凭证或系统安全配置。

| 检查 | 实际结果 |
| --- | --- |
| 完整 core、类型与构建 | 1,335 通过、0 失败、50 个既有条件跳过，共 1,385 项；类型与构建通过 |
| 12 项离线 Eval | offline、context、recovery、loop-safety、memory、m1、m2、plan、plan-graph、plan-parallel、source-report、packaging-lifecycle 全通过 |
| 串行/并行固定对照 v2 | 同图、同 Provider、同来源内容与预算；实际读取两个本机文件，结果均 11、均 6 次 fixture 模型调用、4 个 Runtime 片；最多 1/2 个独立请求重叠；完成后修改候选或只修改文件均失效，复核无新模型/工具执行 |
| macOS native | 48/48 通过，0 跳过；包含异步调用迁移后的原生文档/沙箱回归 |
| 完整真实 Host HTTP | 通过；含真实文件读取、Host 真正重启、修改后先直接导入、重复读取、恢复原文不复活、零调用对账、旧幂等导入/字段确认/审批/导出、来源撤回、取消、单节点失败和 lease 恢复 |
| 完整浏览器 | 63/63 通过，0 失败/跳过/flaky；桌面中文、390px 中文、320px 英文；新增来源复核不可用提示、保留历史和导入阻断，旧过期/重新规划操作继续通过 |
| 故障及权限 | 当前/历史文件、备份撤权、外置结果、历史读回、压缩依赖、中间输入根、存储重开、重复读取、租户隔离、过时复核、缺失证据、深层异常、配额、读取上限及经过时间/取消边界通过；未放宽原断言或权限 |
| 安全与保护 | 工作流/路径/权限政策通过；凭证扫描负对照、跟踪树、完整 Git 历史和包含新文件的最终候选树无发现；依赖审计所有严重度均 0；文档相对链接、差异、精确暂存清单及原目录 179 项内容/权限/状态检查通过 |

core 的 50 项为既有 38 项 macOS 条件项和 12 项 Windows 条件项；macOS 正式 native 入口另执行全部 48 项。本轮没有 Windows runner。浏览器数据为固定 API，真实持久化与权限证据来自 Host HTTP；模型为本机固定 Provider，不是真实模型质量、费用或用户收益证据。

固定并行 Eval 升至 v2，加入真实 file_read 的两轮模型/工具循环；6 次是本版对照的实际 fixture 模型调用量，4 是 Runtime 片数。前阶段 v1 的 4 次模型调用是不同 fixture，不能据此声称真实费用或效率变化。

最终完整日志为 `core-delivery.log`、`native-delivery.log`、`browser-delivery.log`；关键中间回归在 `all-roots-final.log`，故障复现及修复记录继续保留。早期通过记录不能替代最终结果。

本轮官方额度读取已用 30%、剩余约 70%，高于至少保留 15%；没有购买、重置或请求真实模型 API。

## 应用级验收与演示

Node 24.14.0，使用仓库过滤后的环境与本机固定 Provider；真实 Host、HTTP、本地认证、Queue、Runtime、来源和持久存储，不连接模型厂商。

1. 执行 `parallel-fixture-completed-file`：两个独立 worker 真实只读本机固定文件，再由依赖节点汇总。确认前只规划，确认后至多两个请求重叠。
2. 等待完成，真正退出/重启 Host，核对原完成记录。修改 worker 实际读过的文件，保持对话、附件、报告选择与冻结 Fact 不变。
3. 修改后第一个请求直接调用需求单导入，不先 GET Plan。导入必须等待复核并返回 plan_source_stale；Plan 仅增加一次 revision，原结果、尝试、确认、使用量和预算保留，无新增模型调用。
4. 再次重启并恢复原文件字节；重复读取仍为 stale。显式重新规划并确认新版本才可继续；历史备份的可读性另外由原权限/版本适配器决定，不将“当前文件改动”与“备份撤权”混同。

复现命令：

```sh
node --import tsx scripts/ci.ts core
node --import tsx scripts/ci.ts native
node --import tsx scripts/ci.ts browser
npm run dev:fixture
```

交互 fixture 在“先规划”中输入 `parallel-fixture-completed-file`，仍需先创建并选择资料报告；输入/输出明确是固定模拟。本流程不证明真实模型语义、生产能力、用户收益或精确费用。

## 失败历史与本机证据

原始记录位于 `/private/tmp/packx-completed-tool-sources-2026-10-20/`，不提交本机日志、用户数据或凭证。

- `baseline.log`：真实完成后文件变化仍为 completed，预期 stale，先实际复现。
- `build-first.log`、`build-second.log`：异步入口迁移暴露了未等待调用方、测试夹具返回 Promise 和 Session 类型问题；修正调用点和类型，没有放宽类型检查。
- `completion-expanded.log`：历史备份夹具缺 actorId，原权限机制正确拒绝；补齐夹具身份，生产权限未修改。
- `eval-parallel-diagnostic.log`：加入异步检查后，双就绪节点持有旧 revision 导致 CAS 冲突；改为复核后重新读取持久状态，并让新增真实 Runtime 回归使用双就绪图。
- `earlier-root-proven.log`：三轮真实 Runtime 已完成后，故障注入移除最终上下文中的较早读取协议组，中间原始快照仍存在；仅检查最终快照实际漏判为 completed。补齐同一任务记录的全部输入根；夹具早期失败是工具白名单/调用身份检查正常拒绝，未放宽生产策略。
- `core.log`：既有同步来源校验审计期望两次，新增最终发布前校验后实际三次；保留单模型调用断言，将校验次数明确加强为三次。
- 其余定向、完整 core、native、browser、policy、secrets、audit 和候选范围记录与本表对应；最终分类还覆盖深层/循环原因链和存储配额，避免将未知存储问题标为来源撤回。

## 延期与未验证

旧无标记串行计划不自动迁移；没有全盘 watcher、负向检索重新执行、节点独立 lease、跨图并发、公平性、并发写入、任意代码或精确费用预算。公网读取仍默认关闭，正向公网未验收。本轮无实际远端 CI、Windows runner、真实付费模型或真实用户验证；所有模型行为为固定 fixture。


## 本地提交范围

累计 51 个文件，包含此前 24 文件的未提交成果；本轮相对前阶段快照增量涉及 42 项，其中 27 项是新进入变更范围的既有/新增路径。实际新增仓库文件为本轮两个来源模块、一项回归、ADR 和本记录；其余主要是原入口复用、异步等待迁移、已有 Eval/测试及文档更新，没有从零重写。

仅以下精确范围获准本地提交；路径/内容摘要/权限清单保存在本机 `scope.json`，本地提交哈希以 Git 记录为准。没有推送、创建 PR、合并或部署。

```text
README.md
README.zh-CN.md
docs/README.md
docs/adr/0040-completed-readonly-result-validity.md
docs/adr/0041-frozen-plan-input-dependencies.md
docs/adr/0042-completed-tool-source-review.md
docs/evidence/completed-tool-source-review-2026-10-20.md
docs/evidence/readonly-input-dependencies-2026-10-20.md
docs/evidence/readonly-result-validity-2026-10-19.md
docs/evidence/readonly-result-validity-2026-10-19/narrow-results-stale-en.png
docs/plan-mode.md
docs/workspace-agent-architecture.md
docs/workspace-agent-delivery.md
eval/knowledgeDemo.ts
eval/planParallel.ts
eval/productSmoke.ts
scripts/ci.ts
server/enterprise/agentPlanWorkflow.test.ts
server/enterprise/agentPlanWorkflow.ts
server/enterprise/completedPlanSources.test.ts
server/enterprise/parallelPlanWorkflow.test.ts
server/enterprise/planInputDependencies.ts
server/enterprise/proposalWorkspaceApi.test.ts
server/enterprise/proposalWorkspaceApi.ts
server/eval/packagingLifecycle.ts
server/index.ts
server/knowledge/service.ts
server/knowledge/store.ts
server/manufacturing/coffeeProductDirectory.test.ts
server/manufacturing/coffeeProductDirectory.ts
server/manufacturing/knowledgeApi.test.ts
server/manufacturing/knowledgeComparison.test.ts
server/manufacturing/knowledgeComparison.ts
server/manufacturing/planRequirementSource.test.ts
server/manufacturing/planRequirementSource.ts
server/manufacturing/requirementBriefApi.test.ts
server/manufacturing/requirementBriefApi.ts
server/runtime/agentRuntime.ts
server/runtime/assetInspection.test.ts
server/runtime/completedPlanSources.ts
server/runtime/contextSources.ts
server/runtime/errorHandling.audit.test.ts
server/runtime/fileContextPermissions.test.ts
server/runtime/recoverCompletedTurn.ts
server/runtime/requirementTools.ts
server/runtime/windowsTextSandboxedToolExecutor.test.ts
src/components/PlanPanel.tsx
src/enterprise/agentPlan.test.ts
src/enterprise/agentPlan.ts
src/i18n.ts
tests/browser/planParallel.spec.ts
```
