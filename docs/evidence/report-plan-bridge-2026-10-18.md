# 2026-10-18：明确选择资料报告到 DAG worker 的最终验收

工作区：`/Users/black/Documents/Codex/2026-10-19/task/packx`，分支 `codex/workspace-task-graph`。本增量基于报告切片提交 `acf40b9`；整合基线是保留模板库的 `b1c92d7`。本轮升级未推送、未部署，未调用付费模型或新增依赖/凭证。

[交付、演示与全面覆盖](../workspace-agent-delivery.md)、[ADR-0036](../adr/0036-selected-report-context-and-plan-dispatch-identity.md)、[机器可读结果与源码/原始测试报告哈希](report-plan-bridge-2026-10-18.json)。早先的[依赖图证据](workspace-agent-upgrade-2026-10-18.md)与[来源报告证据](source-report-slice-2026-10-18.md)是各自阶段的采样，不用旧计数代替本次结果。

## 最终实际执行

固定 Node `24.14.0`，macOS arm64。使用原有 CI 脚本与门槛，没有把失败用例改成跳过。

| 命令/检查 | 最终结果 | 范围 |
| --- | --- | --- |
| 定向四文件 Vitest | 106 通过、0 失败 | Report/Plan workflow、Runtime contract/context lifecycle |
| `node --import tsx scripts/ci.ts core` | 1,242 通过、0 失败、50 条件跳过，共 1,292 | build 与全部 11 个固定离线 Eval 也通过 |
| `node --import tsx scripts/ci.ts browser` | 39 通过、0 跳过、0 flaky | desktop-zh、narrow-zh、narrow-en；报告选择/清除、历史不替换、Plan 版本提示及原工作空间回归 |
| `node --import tsx scripts/ci.ts native` | 48 通过、0 失败、0 跳过 | 真 macOS Seatbelt/文档/egress 回归，build/native build；随后完整 `eval:product` 通过 |
| `scripts/ci.ts policy`、`scripts/ci.ts secrets` | 通过 | 固定工作流/跟踪路径检查，凭证扫描负对照、全部跟踪文件及 Git 历史无发现 |
| `eval:product` 新增闭环 | 通过 | 真实 Host/HTTP/Queue/Runtime/SQLite/Artifact；模型仅本机固定 HTTP fixture |

50 条 core 跳过来自既有运行条件：Windows build 4、Windows settings 1、Windows protected text 7、assetInspection 原生 4、documentRead 原生 7、macOS Seatbelt 原生 27。macOS 的 38 项随后在 native suite 中连同其余 10 项全部执行通过；其余 12 个 Windows 条件测试本机未运行。没有将 macOS 通过冒充 Windows 验收。

原始运行日志在本机 `/tmp/packx-report-bridge-{core,browser,native,product}.log`；JSON 原始测试报告在工作区 `temp/ci-{core,browser,native}.json`（临时、未入库，摘要与 SHA-256 入库）。

## 新闭环验收细节

1. 用真实 HTTP 上传含 `90 um` 和恶意写入指令的文本。Host 保存报告与原文，报告生成期间模型请求计数不变；明确选择 v1，并记录选择修订号。
2. 固定本机 Provider 提出两个节点：读取选定报告，再依赖读取结果汇总。用户确认后通过真正 Runtime 执行 `source_report_read`。输入绑定 scope、版本、摘要与选择修订号，不接受其他任务、路径、URL 或别的版本。
3. 读取 worker 提交后暂停；Host 真正退出/重启，刷新本地 token，再恢复。读取模型工具请求仅一次，汇总 attempt 为两次；完成节点没有重跑，未完成节点重新执行。两个 Session 独立，结果保留 `unverified` 和 Artifact/来源引用。
4. 另一固定模型模拟被来源指令诱导发出 `file_write`；Host 因节点工具白名单拒绝，无文件或审批产生。这个攻击样例证明 Host 边界，不能据此宣称真实模型会识别提示注入。
5. 报告绑定结果直接导入需求单被服务端拒绝。缺失完整报告→Fact/Approval stale 链路时不发布业务权威结果；旧无报告 Plan 导入仍由完整产品回归覆盖。
6. 清除并重选同版后，旧计划确认返回 `409 plan_sources_changed`；定向测试另覆盖执行前撤回、恢复前重选、来源变化、别 owner、归档结果篡改和分段原文。
7. Plan job 身份现在显式规范 scope。API 的 actor 额外字段或字段次序不会生成第二份 job；过时 queued/leased job 被取消并保留规范派发意图。

## 区分验证边界

- **本机真实生产组件**：认证、HTTP、队列、持久化、Runtime 工具约束、取消、Host 重启、恢复及原生 sandbox 已运行。
- **模拟模型**：所有新增 Agent 验收使用本机固定响应，不访问模型厂商、不计付费调用；不证明真实模型质量、延迟收益或用户成功。
- **网页离线验证**：Fake transport 覆盖两来源报告、不同说法和恶意内容保留；浏览器请求拦截验证 UI。它们不能替代公网正向抓取。
- **真实公网阻塞**：生产 `RestrictedWebSource.read` 对 `https://example.com/` 的一次请求在 DNS 公共地址检查时以 `web_private_address` 被拒绝，未连接目标网站。没有重试、修改 DNS/TLS/私网规则或换路径规避。正向公网抓取仍未验收，需正常公共 DNS 环境再验证。
- **未运行**：本轮升级远端 CI、Windows 真机、本轮真实模型和真实用户走查。PR #40 先前独立冲突修复的远端绿色 CI 不是本升级的远端证据。
- **未实现**：并行 Multi-Agent、任意代码执行、全业务依赖失效传播、企业 RBAC、精确费用预留。当前有界串行 DAG 是可验证首批实现。

额度最新官方采样：2026-10-18 18:02:57 UTC，周窗口已用 12%、剩余 **88%**；短窗口数据未提供。最低保留 15%，本次无需接近该边界。
