# 工作空间 Agent 首批升级：验证记录

日期：2026-10-18。设计：[架构与阶段 Gate](../workspace-agent-architecture.md)。决定：[ADR-0034](../adr/0034-workspace-agent-task-graph.md)。

## 范围与环境

在独立 `codex/workspace-task-graph` 分支实现最多四节点的串行依赖图，保留 ReAct worker、现有 Plan API、Queue/SQLite、审批与业务事实边界。原工作树的未跟踪 v27 评测及证据保留，未读取 `.env`、真实模型设置或私有业务数据。未调用付费模型、未 push 升级、未部署。

固定 Node 为仓库 `.nvmrc` 的 24.14.0，使用已有同锁依赖的独立副本。未新增依赖，`package-lock.json` 和 CI 工作流 YAML 未修改；`scripts/ci.ts` 保留原门槛并新增 graph Eval 与必需执行的两个套件。

机器可复现的摘要见 [JSON](workspace-agent-upgrade-2026-10-18.json)。本轮原始报告位于隔离目录的 `temp/ci-core.json`、`temp/ci-browser.json`、`temp/ci-native.json`，不跟踪大日志。

## 初始基线

基线 commit 为 `1326092260672164e52fbae685aa271f2ca4870a`。初始受限环境 `npm test`：1216 项，1160 通过、6 失败、50 平台条件跳过。失败集中在 egress proxy 的本地监听 `EPERM 127.0.0.1`；后续获准使用本地测试端口后，完整 core 无该失败。没有为通过而跳过这些测试或放宽断言。

## 本轮实际检查（集成 PR 前）

| 命令 | 结果 | 验证范围 |
| --- | --- | --- |
| `npm test -- src/enterprise/agentPlan.test.ts server/enterprise/agentPlanWorkflow.test.ts` | 46/46 通过 | 图/状态合同、依赖顺序、重启、隔离、上游失败、输入上限、暂停、完成 Trace 恢复/缺失停止；含原 Plan 回归 |
| `node --import tsx scripts/ci.ts core` | 1186 通过，0 失败，50 既有条件跳过；类型/构建通过 | 原测试 + 新增 20 项图回归；10 组 offline Eval（含 plan、plan-graph）全过 |
| `node --import tsx scripts/ci.ts browser` | 33/33 通过，无跳过、失败或 flaky | 桌面中文、窄屏中文/英文；其中新增 3 项确认前依赖展示 |
| `node --import tsx scripts/ci.ts native` | 48/48 原生通过，类型/构建及原 HTTP 产品 fixture 通过 | 真 macOS 文档/Seatbelt/出口约束、取消/资源上限、原功能 |
| `npm run eval:product`（新增图 HTTP 用例后） | 通过 | 真实 Host API→Queue→Runtime→Anthropic Adapter→本地固定 Provider→Plan receipts，前向依赖按 1→0，确认前零执行，依赖报告保持 unverified；原产品流程继续通过 |
| `npm run build`（新增 HTTP 用例后） | 通过 | 所有 TS 项目和前端产物 |
| `node --import tsx scripts/ci.ts policy`、`secrets` | 通过 | 原工作流策略、负向 secret 控制、索引文件与历史脱敏扫描 |

Core 的 50 项跳过是原有平台/原生条件，不是完整 Windows 验证；macOS 原生另行实际执行 48 项。浏览器使用拦截合成 API，HTTP 使用本机固定 Provider；都不代表真实模型或用户质量。

## 固定对照

`npm run eval:plan-graph`：相同固定 Provider、来源和每片限额，单 worker 1 次模型调用，规划+三节点图 4 次；两者固定输出均为 11。图顺序为 1→2→0，依赖报告有来源执行引用且保持 unverified。这里只证明调度/隔离/确认，显示多出的 3 次调用；不声称真实模型准确率、速度、费用或商业收益改善。

## 分离处理的既有 PR

唯一开放且冲突的 [PR #40](https://github.com/B1ackB/Packx/pull/40) 在另一个隔离目录处理。合并 main `1326092` 到原 source `13371c7`，冲突只有 `server/index.ts` 的关闭流程；保留 main 的 graceful shutdown，并关闭模板库。普通 merge commit `b1c92d7bf2142c0958904ea7db389f8915f1969c` 已按该 PR 的单独授权推送，无 force push，未合并 PR。

本地 PR 检查：core 1171 通过/50 既有跳过；browser 33/33；native 48/48 + HTTP 产品通过；工作流策略、secret 扫描和 npm audit（0 findings）通过。第一次将 core/native/browser 同时运行时自动任务套件 beforeAll 超过 30 秒，保留失败事实；其他进程结束后按原命令顺序复核通过，没有增大超时或关闭测试。

远端运行：[Actions 39147916304](https://github.com/B1ackB/Packx/actions/runs/39147916304)。提交后读回源 SHA 一致、mergeable=true；最终状态与本地集成结果在本记录下方补充。

## 限制与下一步

本轮没有部署或迁移用户状态；不包含通用工作空间 UI、网页 fetch、任意代码执行、并发写入、精确美元硬预算、完整 RBAC 或分布式调度。升级前排空正在规划的旧任务；新图不能由旧二进制混跑。下一阶段为“文件+受限网页来源→版本化报告 Artifact”纵向切片；并发/代码执行按架构 Gate 后置。

官方额度采样：2026-10-18 17:08:05 UTC，工具暴露的周窗口已用 10%、剩余 90%；短窗口未提供读数。保留至少 15% 的要求有效，未新增模型账单。

## PR 远端验收与本地集成

GitHub 最终读回：PR #40 仍为 `open`，`merged=false`，head 为 `b1c92d7bf2142c0958904ea7db389f8915f1969c`，`mergeable=true`、`mergeable_state=clean`。该 commit 的 [Actions 39147916304](https://github.com/B1ackB/Packx/actions/runs/39147916304) 已完成且 success；`core-offline`、`browser`、`native-product`、`windows-local-data`、`ci-required` 五项均 success。只推送了既有 PR 的冲突修复，没有把 Agent 升级送到远端。

本地升级分支以 merge `a2ea995ce2697f84c1d71845da29e34bfdf5b47f` 合入已修复的 PR #40，保留模板库/交付历史能力；原任务图增量为 `18f4a05`。这次本地集成不等于 GitHub 合并 PR。组合状态已顺序复核：core 1191 通过、0 失败、50 既有条件跳过，10 组 Eval、类型/构建全过；browser 36/36（包含模板库与依赖图，中英文三种视口），无跳过或 flaky。最终 native 结果追加如下。

最终组合 `node --import tsx scripts/ci.ts native` 已完整通过：48/48 原生检查，0 跳过；构建及 HTTP 产品 fixture 同时验证了模板库持久化、跨订单复用、交付历史、计划批准与前向依赖图、文件独立审批、取消和恢复。组合状态的 policy 和 secrets（目录与 Git 历史）再次通过。没有执行升级分支的远端 CI；Windows 远端通过证据属于独立 PR #40，不能冒称新任务图已在 Windows 真机验收。

结束前官方额度采样：**2026-10-18 17:13:15 UTC**，周窗口已用 10%、剩余 **90%**，高于 15% 下限；短窗口未提供读数。停止扩展本轮范围，下一阶段按 P2 的来源报告切片执行。
