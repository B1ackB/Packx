# 2026-10-20：完成来源复核接续收尾

## 交接与范围

通过本机会话工具确认「实现有界并行只读任务」的轮次 `01a154fe-7c21-7643-9587-1d8ee6355ec2` 已 completed，并保存提交 `730588ea64de4e51e28fff17ac30c6042a57cfe5`、干净工作区后才开始修改。原开发目录保持不动；本轮独立 clone 位于 `/Users/black/Documents/Codex/2026-10-20/task/packx`，分支 `codex/completed-source-review-followup`。接续时远端 main 仍为 `42ff79c8a8e680ab436c170ca2d6f1aaab4e7b1d`，没有打开的 PR。

本轮授权为有界修复、测试、本地提交、正常推送及 draft PR；不合并、部署或调用付费模型。不新增依赖、权限、凭证、网络例外或后台 watcher。上轮 51 文件提交作为交接基线保留。

## 缺陷证据与修复

`validateContextSources` 对外置工具正文直接取 `snapshot.messages[0]`，未核对该存档是否恰为一条 tool 消息。真实 Runtime、文件服务、Queue、SQLite Plan 和完成 Trace 的既有夹具完成后，注入三种读取故障：

- 空存档：原实现抛 TypeError，API 误报 `plan_source_review_unavailable`，提示临时重试。
- 角色错误：原实现接受 user 消息作为工具正文，仍返回 completed。
- 多条消息：原实现静默只用第一条，仍返回 completed。

三项新回归在基线全部失败。共享来源校验现在先验证正文形状，不符合就用既有状态存储缺失证据错误终止。完成读取返回 `plan_completion_evidence_missing`；原 Plan revision、状态、结果、模型调用数及工具执行数均保持不变。正常外置正文的原验证、字节预算、当前权限和来源变化检查继续执行；不将坏存档伪造为来源撤回。

## 本轮验证

执行环境使用仓库固定 Node 24.14.0。以下仅记录本轮实跑结果，不以交接轮次的通过记录替代。

- 三种故障基线：3 项失败，修复后通过。
- 定向完成来源、压缩读回、文件权限：70/70 通过。
- 完整 core：1,338 通过、0 失败、50 项既有平台条件跳过，共 1,388 项；类型、构建及 12 项离线评测全部通过。
- macOS native：48/48 通过、0 跳过；完整真实 Host HTTP 流程通过，包括完成后文件修改、重启、直接导入阻断、恢复原文不复活、取消、失败和零调用对账。
- 浏览器：63/63 通过，0 失败、跳过或 flaky；覆盖桌面中文、390px 中文、320px 英文。
- 安全：policy、凭证扫描负对照、候选树与完整 Git 历史扫描通过；npm 审计所有严重度均 0。
- 原目录：179 项未提交文件的内容、权限和 Git 状态检查通过，main 仍为 `42ff79c`；交接工作区 `730588e` 保持干净。
- 远端交付单独记录。GitHub CLI 认证返回 401；已通过正常 Chrome 用户菜单确认现有登录为 B1ackB，未提取 cookie/token 或修改凭证。最终远端门禁以 PR 最新提交的实际检查为准。

首轮完整 core 在常规沙箱中因本机 fixture 监听端口被拒（listen EPERM）失败；未修改测试、网络规则或断言，改用获准的执行环境后完整 core 通过。50 项 core 跳过为 38 项 macOS 条件项和 12 项 Windows 条件项；macOS 项由专用 native 入口实际执行，Windows 本地 runner 未运行。

本机日志为 `/tmp/packx-followup-baseline.log`、`/tmp/packx-followup-targeted.log`、`/tmp/packx-followup-core.log`（首轮环境失败）、`/tmp/packx-followup-core-full.log`、`/tmp/packx-followup-native.log`、`/tmp/packx-followup-browser.log`、`/tmp/packx-followup-policy.log`、`/tmp/packx-followup-secrets.log`、`/tmp/packx-followup-audit.log`。不纳入用户数据、凭证或本机临时日志。常规测试没有单独 lint 脚本，以仓库 core 的类型/构建及 policy 门禁为准。

本轮开始官方额度剩余 70%，本地验证完成时剩余 69%，至少保留 15%。未运行真实模型、公网正向抓取或 Windows 本机 runner，后者以实际远端 CI 为准。
