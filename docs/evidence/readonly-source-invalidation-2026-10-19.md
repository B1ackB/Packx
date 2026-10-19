# 2026-10-19：只读计划来源主动失效，本地验收

本页保留第一轮来源主动失效的本地验收快照，当时不提交。用户后续要求“把还没有的补齐，测试没问题提交”，新增工作与当前结果见[补齐验收](readonly-recovery-completion-2026-10-19.md)；仅授权本地提交，未授权推送、PR、部署或付费模型。基线为实际 fetch 的 main `866379759e2113fd7948cf671e7c17a48f995660`，不是沿用旧远端引用；在原独立工作区新建 `codex/readonly-source-invalidation` 分支。原目录 179 个未跟踪文件的内容、权限和状态在收尾再次对比。

## 根据代码选择的小阶段

原实现保证结果提交前核对来源，但 dispatch 未比较最新输入与冻结快照，报告 API 未通知活动计划。原撤回应用 fixture 随后放行模型请求，只证明结果不会提交。新回归先实际失败：两个 Adapter 挂起时，来源变化且 reconcile 后，状态仍为 running。

本阶段在 Enterprise Layer 复用派发入口、SQLite 事件、scope、整图取消和原 Runtime，先持久化来源失效，再取消已确认只读图的 job/worker；不新增调度器、工具或权限。成功结果仅保留为历史，需结合当前资料重新规划并确认。设计、异常窗口和回退见 [ADR-0038](../adr/0038-readonly-source-invalidation.md)。

## 检查结果

最终顺序复验结果如下；首次失败与诊断结果另列，不能只据最终绿色声称没有波动。本机使用 Node 24.14.0；模型为确定性本机 Provider，测试环境不载入真实模型凭证。当前阶段没有实际远端 CI，新结果不能沿用 PR #54 的远端通过状态。

| 检查 | 结果 |
| --- | --- |
| core：测试、类型、构建及 12 项离线 Eval | 1,263 通过、0 失败、50 既有条件跳过，共 1,313；类型检查、构建及全部 12 项离线 Eval 通过 |
| 浏览器：桌面中文、390px 中文、320px 英文 | 48 通过、0 失败/跳过/flaky；新失效界面三种尺寸均通过 |
| native：原生工具、完整真实 Host HTTP 产品流程 | 最终完整入口通过：48/48 原生安全测试 + 全部真实 Host HTTP 固定 Provider 流程；此前有一次 47/48，见下文 |
| 工作流/路径策略、凭证扫描、依赖审计 | 策略通过；凭证扫描负对照、全部跟踪文件/完整 Git 历史及本阶段全部 15 个修改/新增文件快照扫描均通过，无发现；依赖审计 info/low/moderate/high/critical 均 0 |
| diff 空白、修改范围和原目录保护 | 空白检查通过；原目录 main 及 179 个未跟踪文件的内容、权限、状态均与保护清单一致；最终范围清单见下文 |

core 的 50 个条件跳过仍是 38 个 macOS 原生条件项及 12 个 Windows 条件项；macOS 原生入口另启用并完整通过 48 项。没有本地运行真实 Windows runner，没有为本阶段触发远端 Actions。12 项离线 Eval 为 offline、context、recovery、loop-safety、memory、m1、m2、plan、plan-graph、plan-parallel、source-report、packaging-lifecycle。并行故障套件从 14 项增至 19 项，原串行套件及其全部权限/恢复回归保留。

## 实际失败、诊断与复验

1. 预期红测：新增“两个 Adapter 保持挂起、来源变更后对账”回归先在旧实现失败，实际状态为 running。最初临时复现使用系统 Node 25.8.1；正式负对照另用 Node 24.14.0 从 HEAD 的原始 workflow 构造独立临时模块，再次得到同样失败，未覆盖候选源文件。正式验收全部使用 Node 24.14.0。
2. 新作用域隔离 fixture 最初因两个图在同一 Fake Clock 时刻入队，被既有 jobId 排序选到另一图而超时。修正测试为明确错开入队时间，保持生产队列规则和原测试超时；完整 core 已通过此回归。
3. 一次完整 core 复验的既有 `requirementAutomatic.test.ts` beforeAll 超过 30 秒，导致套件失败及 13 项未执行。该套件单独复验 13/13 通过；最终原入口顺序复验恢复 1,263/1,313、50 个既有条件跳过。未修改该套件、时限或并行参数。
4. 首次 native 为 47/48：既有 `never imports output when the supervisor dies after the Tool wrote it` 预期 failed，实际 timed_out；隔离运行也曾失败。独立临时诊断在相同 1 秒上限观察到 timed_out/failed 的时序波动，输出均未导入；根因未确定，没有修改执行器、断言或安全策略。最终整个 native 入口 48/48 且完整产品流程通过。该原生 fixture 波动仍是明确的后续风险，不声称已修复。

原始日志保留本机 `/private/tmp/packx-source-{baseline-node24,core-final,core-diagnostic,core-sequential,browser-final,native,native-diagnostic,native-sequential,product,policy,audit}.log`。首次 core/native 失败 JSON 另保留 `/private/tmp/packx-source-{core,native}-failed.json`，最终报告在工作区忽略目录 `temp/ci-*.json`。不将完整含本机路径的大日志提交进仓库。

## 故障与验收矩阵

| 场景 | 必须观察的后置条件 |
| --- | --- |
| 两个模型请求保持挂起，清除或重选报告 | 在放行请求前计划即 failed / plan_sources_changed，不可 resume，调用槽仍为 3，无汇总 |
| A 已完成，B 挂起时清除报告 | A 的未验证结果保留，B interrupted，旧回复不能改变历史或新版本 |
| 非规范重复 job | 同一图的旧重复 job 与规范 job 一起取消，其他 scope 不变 |
| 报告变更已保存但计划仍为旧快照 | 对账在派发前识别变化，零新增 Runtime 调用 |
| 计划失效落盘后取消抛错，重开存储 | 重复对账完成取消，不增加计划事件、失败计数或执行槽 |
| context store 暂时不可用 | 上报原错误，计划和队列不伪装成来源撤回 |
| 结合历史重新规划 | 新版本使用新快照，无继承 approval，等待用户确认 |
| 迟到请求、取消、超时、重启及来源边界 | 原并行矩阵和整应用回归继续通过；不放宽权限、TLS 或网络地址检查 |

浏览器使用固定状态验证双语原因、保留结果、停止节点、没有 resume 和存在 replan，并检查窄屏无横向溢出。此界面检查不替代真实 API/调度路径；后者由完整 eval:product 覆盖。 窄屏英文截图见[失效与重新规划提示](readonly-source-invalidation-2026-10-19/narrow-source-invalidated-en.png)。

## 复现与演示

使用 Node 24.14.0：

```sh
node --import tsx scripts/ci.ts core
node --import tsx scripts/ci.ts browser
node --import tsx scripts/ci.ts native
npm run dev:fixture
```

1. 在本机固定演示上传 [客户文本](../../examples/source-report-customer.txt)，创建并明确选择报告 v1，切换“先规划”。
2. 输入 `parallel-fixture-success: 分别核对资料，再汇总未验证结论`，核对并确认三节点图。
3. 两项读取显示执行中时，在资料报告中清除选择，或重新选择同一版本。应立即看到“任务资料或所选报告已变化”，两项停止；不可直接恢复，旧结果仅供核对。
4. 选择有效资料或报告版本，再使用“结合当前结果重新规划”，核对新资料和方案后重新确认。不要把保留历史或模型自评视为业务 Fact/交付批准。
5. 自动流程额外把固定 Provider 请求保持挂起，在放行它们之前断言状态已失效；包含一项已完成的部分结果场景。人工 3 秒演示窗口不能替代这项断言。

## 修改范围

共 15 个文件，仅本阶段变更，不暂存或提交：

| 用途 | 文件 |
| --- | --- |
| Host 主动通知、持久失效、双语说明 | `server/index.ts`、`server/enterprise/agentPlanWorkflow.ts`、`src/i18n.ts` |
| 调度/故障、应用、界面回归 | `server/enterprise/parallelPlanWorkflow.test.ts`、`eval/productSmoke.ts`、`tests/browser/planParallel.spec.ts` |
| 新决策与验收 | `docs/adr/0038-readonly-source-invalidation.md`、本页及上述 PNG |
| 机制、导航、历史发布状态同步 | `docs/README.md`、`docs/adr/0037-bounded-readonly-plan-waves.md`、`docs/evidence/readonly-parallel-2026-10-19.md`、`docs/plan-mode.md`、`docs/workspace-agent-architecture.md`、`docs/workspace-agent-delivery.md` |

原有 Runtime、Provider、权限、工具、网络/TLS 检查、依赖和 CI 文件均无改动；没有提高调用量或并发上限，执行槽仍不等于精确费用上限。

## 剩余缺口与未验证项

- 本 Host 报告变更 API 外的来源/权限变动仍受原 Runtime/提交前复核及下次对账保护，没有通用实时来源 watcher 或跨业务 Artifact/Approval stale 链。
- 预算达到上限后，现有 resume 门槛可能阻止零新增调用地对账已完成 Trace；后续独立切片处理，不放宽本阶段预算。
- 批次仍等待最慢节点；节点独立租约、跨图并发、公平性服务、并发写文件和任意代码继续延期。
- 网页默认关闭；公网正向读取、真实模型语义质量/费用及实际包装用户核对成本未验证。本次不以人工等待或测试数量声称生产收益。
