# 2026-10-19：有界只读并行，本地验收与演示

本页记录提交前的本地实现与验收快照。2026-10-19 发布阶段，产品负责人明确授权本批 24 个文件提交、推送、创建 PR，并要求等待实际远端 CI 全部通过；不授权合并或部署。本地结果不替代对应 PR 的远端检查。无付费模型调用、无新凭证、无新依赖或系统安全设置修改。

后续发布记录：上述 24 个文件已随 [PR #54](https://github.com/B1ackB/Packx/pull/54) 合入 main `8663797`。提交 `cf0b18c` 的[实际远端 CI](https://github.com/B1ackB/Packx/actions/runs/39228487023) 五项全部通过；合并后本地同步完成，179 个原有未跟踪文件保持不变，未部署。本页其余内容保留提交前快照。新的来源失效工作单独记录在[后续本地验收](readonly-source-invalidation-2026-10-19.md)，不扩展当时的测试结论。

## 基线和保护

- 通过实际 Git fetch 和最终 ls-remote 核验 `B1ackB/Packx` main，均为 PR #53 合并提交 `972266e4bdcef83f7d054afdcbd98ae18a4c21b0`，不是沿用旧 origin/main。
- 原仓库 `/Users/black/Documents/VSCodeProject/SmallBlack` 保持原 main/未提交评测成果。开始时记录 179 个未跟踪文件的状态与 SHA-256，收尾逐文件复核；清单仅保留在本机，不加入本批变更。
- 此前升级工作区 `/Users/black/Documents/Codex/2026-10-19/task/packx` 保持原分支及干净状态；它的 remote 指向原本地目录，不用它代替远端核验。
- 从最新 main 创建独立仓库与 `codex/workspace-readonly-parallel` 分支。永久目录：`/Users/black/Documents/Codex/2026-10-19/task/packx-readonly-parallel`；初轮验证在隔离临时目录进行，收尾检查在永久目录复验。
- `gh` 的 GraphQL 请求因现有认证返回 401，没有创建凭证或修改认证；基线依据直接远端 Git、合并提交及本地提交图。本地验收阶段未运行远端 CI，发布阶段独立核对对应 PR 的检查。

## 本阶段交付和边界

实现位于 Enterprise Layer，复用原 Runtime、Provider、Plan API、SQLite 计划事件、Queue lease、来源报告与权限。Host 在提出全只读计划时保存 readConcurrency=2，确认前可见；每批最多两项就绪节点，结束后 checkpoint，依赖在后续批次启动。含任一写工具和旧无并发字段计划继续串行。

新增 taskRuns 保存节点尝试、代次、父 job/lease、独立 Session/key、状态和失败；每次实际 Runtime 调用前原子扣除共享执行槽。提交检查租约、代次、尝试及来源，取消/失败中断同批，已完成节点保留。超时、重复派发、迟到结果和恢复均有回归。图租约丢失后不自动重发未知模型请求，等待用户恢复并先对账完成记录。

这是父图租约覆盖的有界批次执行，**没有节点独立队列/续租、跨图并发、公平性服务、并发写入、任意代码或精确货币预算**。每批等待最慢节点；只有实测吞吐/延迟证据需要时才改为动态补位。普通聊天等其他入口保留原有资源合同，不能将图内两项上限宣传为全应用统一模型配额。

[ADR-0037](../adr/0037-bounded-readonly-plan-waves.md)、[架构](../workspace-agent-architecture.md)、[Plan 使用说明](../plan-mode.md)、[交付覆盖](../workspace-agent-delivery.md)同步描述迁移、回退和未验证项。旧二进制不得忽略新字段混跑；回退先停止新增任务、暂停/排空并保留兼容读取能力，不删除历史或来源绑定。

本批暂存清单共 24 个文件：

| 范围 | 文件 |
| --- | --- |
| 执行与状态 | `server/enterprise/agentPlanWorkflow.ts`、`src/enterprise/agentPlan.ts`、`server/index.ts` |
| 界面 | `src/components/PlanPanel.tsx`、`src/i18n.ts` |
| 测试与评测 | `server/enterprise/parallelPlanWorkflow.test.ts`、`src/enterprise/agentPlan.test.ts`、`eval/planParallel.ts`、`eval/productSmoke.ts`、`tests/browser/planParallel.spec.ts` |
| 本地/CI 入口 | `package.json`、`scripts/ci.ts` |
| 架构与使用文档 | `README.md`、`docs/README.md`、`docs/adr/0034-workspace-agent-task-graph.md`、`docs/adr/0036-selected-report-context-and-plan-dispatch-identity.md`、`docs/adr/0037-bounded-readonly-plan-waves.md`、`docs/plan-mode.md`、`docs/workspace-agent-architecture.md`、`docs/workspace-agent-delivery.md` |
| 本阶段证据 | 本页及 `readonly-parallel-2026-10-19/` 中的 `comparison.json`、`desktop-running.png`、`narrow-recovery-en.png` |

## 实际检查

Node **24.14.0**，macOS；模型为固定 Provider/本机 HTTP fixture。以下为真实执行结果，CI 入口和门槛未关闭或放宽。

| 检查 | 实际结果 |
| --- | --- |
| `node --import tsx scripts/ci.ts core` | 1,258 通过、0 失败、50 既有条件跳过，共 1,308；类型检查和前端构建通过 |
| core 内 12 个离线 Eval | offline、context、recovery、loop-safety、memory、m1、m2、plan、plan-graph、plan-parallel、source-report、packaging-lifecycle 全通过 |
| `node --import tsx scripts/ci.ts browser` | 45 通过，0 失败/跳过/flaky；桌面中文、390px 中文、320px 英文；包括两个活动节点、依赖等待、失败原因及恢复按钮 |
| `node --import tsx scripts/ci.ts native` | 类型/构建、native build、48/48 原生测试及完整真实 Host HTTP 产品流程通过 |
| 新并行故障套件 | 14/14，通过实际持久队列/调度器与可控等待点验证，不以 mock 调用次数替代重叠证明 |
| 工作流/路径策略 | 原 workflow syntax、权限、步骤和跟踪路径策略通过；仅向原 core 增加必需回归套件与离线 Eval |
| 凭证扫描 | 负对照通过；跟踪文件与完整 Git 历史无发现 |
| 依赖审计 | info/low/moderate/high/critical 均 0；锁文件无改动 |
| 范围与空白 | 精确暂存清单、diff whitespace、原工作区保护复核通过 |

core 的 50 个条件跳过为：38 个原生条件测试（assetInspection 4、documentRead 7、Seatbelt 27），以及当前 macOS 不执行的 Windows 条件 12（Windows build 4、model settings 1、LPAC text 7）。原生入口另以启用条件运行完整 48 项并通过，不能把 Windows 条件项算作通过。本地阶段没有运行真实 Windows runner 或远端 Actions，发布阶段分别核对；真实模型、公网正向读取、真实用户价值仍未验证。

## 同图、同预算固定对照

原 `eval:plan-graph` 的单 worker 对 DAG 对照保留。新增 `eval:plan-parallel` 冻结同一三节点图、来源、固定 Provider 与执行片预算，仅改变 Host 并发 1/2。

| 项目 | 串行 | 只读并行 |
| --- | --- | --- |
| 来源调用最大重叠 | 1 | 2 |
| 实际 fixture 模型调用 | 4 | 4 |
| 预留 Runtime 执行片 | 4 | 4 |
| 汇总输出 | 11 | 11 |
| 本次人工等待耗时 | 175 ms | 88 ms |

原始结构化结果见 [comparison.json](readonly-parallel-2026-10-19/comparison.json)。80 ms 等待由 fixture 人工设置，不是模型推理速度、生产吞吐、成本改善或用户收益。执行片内仍可能有多次模型迭代、计数/重试；执行槽不是精确模型调用上限或费用上限。失败、取消、响应不明都不退还消耗。

## 调度与故障证据

| 情形 | 证据与实际后置条件 |
| --- | --- |
| 独立节点重叠与依赖等待 | 队列持有一个图 lease，两个独立 Runtime 请求同时被阻塞时 taskRuns 有两项 running；先放行 B，A 未完成时汇总仍未派发；完成顺序 2→1→0，汇总输入仍按声明 1、2 路由 |
| 并发上限、隔离 | 三个独立节点只准入前两项；直接依赖以外的报告不进入下游；Session 不共享，并行请求强制 read-only/never；白名单收紧执行前拒绝 |
| 单节点失败、部分结果 | A 成功后 B 失败，保留 A、阻止汇总；可重试错误需显式 resume，只重跑剩余工作；真实 HTTP fixture 的无效 B 输出同样留下 A 并阻止汇总 |
| 暂停、取消与迟到结果 | 两项一起收到中断；不可合作 Adapter 的响应可迟到但不写入 child；暂停恢复用新尝试，旧回复不能覆盖新结果；真实 HTTP 取消保留 cancelled 状态且无汇总 |
| 超时、最后预算槽 | 60 秒节点截止时间能结束不响应 Adapter；迟到结果不提交；仅剩一槽时只启动一项，失败/未知消耗不退款 |
| 重启、checkpoint、完成窗口 | 持久队列和计划重开后，已提交兄弟不重复；主动 paused 节点以同 Session/key 继续；完成 Trace 可零新增调用接回，无结果的只读尝试重新扣槽，最终 Session 缺 Trace 停止 |
| 真实进程强杀 | 两项 HTTP 模型请求同时未返回时 SIGKILL Host；沿用 recover-lock 的死 PID 检查与审计，重启后 lease 过期进入可恢复失败；用户 resume 后两项 attempt=2、最终 calls=6，旧 HTTP 回复不追加结果 |
| 重复派发与租约 fence | 多次 reconcile 只保留规范 job；同 lease 重复处理不接管 reservation；旧代次/过期 lease 不提交结果 |
| 来源撤回和不可信数据 | 调度前和执行中撤回都停止；真实 HTTP 取消选定报告后两个 worker 不交付当前结果；source_report_read 保留 untrusted/unverified 合同；原注入写入、跨 scope、版本与审批回归仍通过 |

应用级流程使用真实 Host/API/Queue/Runtime/Provider Adapter/报告存储；固定 Provider 的两项任务只读同一明确选定报告，不声称资料逐字段隔离。测试没有访问付费模型、公网网页或绕过工具/网络检查。

## 失败尝试和修正

1. 初次在受限执行环境运行 HTTP fixture，loopback listen 被 `EPERM` 拒绝；没有把它计为应用通过。获得本地执行能力后按原测试复验，没有改端口检查或系统安全设置。
2. 第一次新增 SIGKILL 场景在重启时得到 `local_data_busy`。这是已有根目录锁按设计拒绝异常退出现场；fixture 当时漏掉文档要求的维护步骤。修正为调用生产 `recoverLocalLock`，核对被杀 Host PID、要求进程明确不存在并写恢复审计，再重启。没有直接删除锁、自动抢占锁或放宽 Host 检查；随后完整产品与 native 入口复验通过。
3. 原生构建保留已有 Vision `usesCPUOnly` 弃用警告，未关闭警告或降低测试门槛。

原始日志保留本机 `/private/tmp/packx-parallel-{core-final,browser-final,native-final,policy,secrets,audit}.log`。第一次产品失败日志为 `/private/tmp/packx-parallel-product.log`；修正后独立完整产品日志为 `/private/tmp/packx-parallel-product-final.log`。最终 core/browser/native JSON 位于工作区 `temp/ci-*.json`，不提交含完整本机路径的大报告。

## 可复现演示

在本阶段独立工作区，使用 Node 24.14.0：

```sh
npm run eval:plan-parallel
npm run build:native
npm run eval:product
npm run dev:fixture
```

前三项可自动复现对照与完整应用故障矩阵。最后一项启动固定演示，默认 `http://127.0.0.1:5178`；退出按原 fixture 清理临时业务数据。

1. 选择一个任务，上传 [客户文本示例](../../examples/source-report-customer.txt)。在“资料报告”创建报告，核对来源，点击“将 v1 用于任务”。
2. 将处理方式改为“先规划”，发送以下固定触发词：

```text
parallel-fixture-success: 分别核对所选资料，再汇总待确认事项；保留未验证状态和来源引用。
```

3. 确认前核对三项任务及汇总依赖，并查看“只读任务最多两项同时处理”的说明。点击“确认 v1 并执行”。固定演示给两个读回任务各设置 3 秒可视等待，可以观察两项执行中、汇总等待上游。
4. 可以暂停/恢复或取消；恢复只继续未完成任务。结果保持未验证。费用提示明确处理次数不代表价格上限；报告绑定计划仍不能直接导入需求单。
5. 自动强杀流程由 eval:product 执行，包含现有 recover-lock 审计与显式恢复。不要在真实用户数据上直接照搬强杀演示；正常停止与备份恢复见[本地操作](../local-operations.md)。

截图为本次固定浏览器数据，不是生产或真实模型： [桌面并行状态](readonly-parallel-2026-10-19/desktop-running.png)、[窄屏英文恢复](readonly-parallel-2026-10-19/narrow-recovery-en.png)。

## 延期和下一步

网页默认仍关闭，正常公共 DNS 环境的正向读取未验收；未修改地址校验、TLS 或权限。真实模型语义质量/价格与真实用户效果没有本轮证据；完整报告→业务 Fact/Artifact/Approval stale 链路、企业 RBAC、跨图并发、公平调度、代码与写协作继续延期。

下一步先用一组实际包装售前资料走查这个闭环，核对是否需要拆分、引用是否足够、人工核对成本是否下降；真实模型费用、后续合并和部署分别等待明确授权。本轮不为更大平台增加框架。
