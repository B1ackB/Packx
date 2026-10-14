# 本地权限、Secret 与沙箱边界矩阵（M3 G1 / G2 / G4 子集）

日期：2026-10-14
范围：单用户本机 Host。主体包括本机用户、Host 进程、模型输出、前端页面、Native Sandbox 子进程。
依据：[`milestone-3-production-hardening.md`](../milestone-3-production-hardening.md) §3–§9、[`ADR-0013`](../adr/0013-just-in-time-file-approval.md)、[`ADR-0006`](../adr/0006-agent-managed-background-and-cron.md)、[`ADR-0030`](../adr/0030-host-egress-proxy-for-sandbox-allowlist.md)（已接受）、D4（Secret 脱敏）。

## 1. 基线与本次变更

| 项目 | 结果 |
|---|---|
| 基线 | `main` 的 `d38e9b3`：单元测试 973 个用例 |
| 本次结果 | `npm run check`：104 个文件、978 个用例通过，构建成功 |
| 原生测试 | `npm run test:native`：40 个用例通过（含 Seatbelt，`BLACKX_RUN_SEATBELT_TESTS=1`） |

本次变更：
- 域名 allowlist 通过 Host 出口代理实现（ADR-0030 已接受）。代理只允许 443 端口上的已声明域名，拒绝私网与回环地址。
- Seatbelt 只放行代理端口，子进程绕过代理的直连被拒绝。
- 沙箱 stdout、stderr 中的宿主路径替换为 `<workspace>`、`<tmp>`、`<home>`。
- 补充信号隔离用例：沙箱内无法向 Supervisor 或其他进程发送信号。

## 2. 权限矩阵

风险等级沿用 `AgentTool.risk`：`read`、`write`、`publish`。“Host 策略”指由 Host 决定、模型不能修改的输入。

| 操作 | 风险 | 决定来源 | 强制位置 | 所需授权 | 失败码 | 覆盖测试 |
|---|---|---|---|---|---|---|
| 浏览本机目录、读取 UTF-8 文本 | read | Host 策略与身份 | `localFileAccess.ts`、`conversationFiles.ts` | 无（ADR-0013） | `file_path_denied` | `localFileAccess.test.ts`；`conversationFiles.test.ts`「isolates tenants, workspaces, sessions and approval ids…」 |
| 新建或修改文件 | write | 单次人工审批 | `src/agent/loop.ts` 审批分支；`conversationFiles.ts` 绑定路径、内容哈希与父目录身份 | 每次一次人工批准 | `tool_approval_required`、`tool_approval_denied` | `conversationFiles.test.ts`「creates a real immutable file, denies unapproved changes…」；`runtime.contract.test.ts`「denies write tools by default and executes them only with trusted approval and audit」 |
| 删除文件 | write | 单次人工审批 | 同上 | 每次一次人工批准；恢复历史也需批准 | 同上 | `conversationFiles.test.ts`「rejects deletion, then approves deletion…」 |
| 旧审批、过期或跨会话复用 | write | 审批绑定 | `conversationFiles.ts` | 拒绝执行 | `file_version_conflict` | `conversationFiles.test.ts`「rejects stale decisions and versions…」「cancels pending approvals on abort, expires after restart…」 |
| 发布类操作 | publish | 与 write 相同的审批闸门 | `src/agent/loop.ts`（`risk !== "read"`） | 人工审批 | 同 write | 当前无 `publish` 工具，无真实路径覆盖（见第 4 节） |
| 工具不在本轮白名单 | — | `allowedTools` | `src/agent/loop.ts` | 不适用 | `tool_not_allowed` | `runtime.contract.test.ts`；`agentPlanWorkflow.test.ts` |
| 工具输入不合法 | — | 工具 `validate` | `src/agent/loop.ts` | 不适用 | `tool_input_invalid` | `runtime.contract.test.ts`「classifies model-visible Tool validation…」 |
| 写入工具在 `approvalPolicy: never` 下执行 | write | Host 策略 | 运行时入口 | 拒绝执行 | `context_failure` | `personalMemory.test.ts`（`side_effect` + `never`） |
| 无审批端口时执行写入 | write | fail-closed | `createRuntime.ts` `hostToolApproval` | 不允许执行 | `tool_approval_denied` | `createRuntime.test.ts`「denies side effects when no approval port is configured」 |
| 自动批准（Host 配置） | write | 固定工具名单 | `index.ts` 的 `autonomouslyApprovedTools`；`createRuntime.ts` | 无人工批准；审批 ID 为 `policy:<tool>:v1` | — | `createRuntime.test.ts`「auto-approves only the configured automation tools」；`automationTools.test.ts`（bounded 后台任务与 Cron） |
| 对话轮次的 Tool 策略 | — | Host 推导 | `conversationApi.ts:350-351`：有工具 → `workspace-write` + `required`；无工具 → `read-only` + `never` | 由 Host 决定 | 不适用 | `conversationPolicy.test.ts` 三条用例（含「request-supplied tools or policy」） |
| 外部 `/api/runtime/turn` 调用 | — | Host 强制 | `runtimeEvalPolicy.ts`；`index.ts` 路由 | 不适用 | `runtime_eval_disabled` | `runtimeEvalPolicy.test.ts`（开关与强制策略）；路由接线本身无专门测试 |
| 沙箱读取（声明的 Workspace 输入） | read | Seatbelt Manifest | `macOsSeatbeltSandboxedToolExecutor.ts` | 无 | — | 「reads only declared Workspace inputs and receives only allowlisted environment values」 |
| 沙箱未声明读写 | read / write | Seatbelt Manifest | 同上 | 拒绝 | `tool_sandbox_policy_denied` / 失败 | 「denies undeclared reads and writes even when argv requests them」；「keeps Git and Packx control state denied…」 |
| 沙箱嵌套 shell 越权写入 | write | Seatbelt Manifest | 同上 | 拒绝；错误含 `Operation not permitted` | 失败（exit 1） | 「denies nested shell writes outside the declared scope」 |
| 沙箱向 Supervisor 或其他进程发送信号 | — | Seatbelt `(deny signal)` | 同上 | 拒绝 | 无（子进程内部错误） | 「denies signals to the supervisor and keeps the Host-side result intact」 |
| 沙箱输出超过文件数量 | write | Manifest 限制 | 执行器输出扫描 | 拒绝，不保留输出 | `resource_exhausted` / `output_limit_exceeded` | 「rejects staged outputs that exceed the declared file-count limit」 |
| 沙箱输出含 FIFO 等非普通文件 | write | Host 输出校验 | 执行器输出扫描 | 拒绝，不保留输出 | `policy_denied` / `output_validation_failed` | 「rejects FIFO and other non-regular files in staged output」 |
| 沙箱符号链接、硬链接、越界路径 | write | Host 校验 | 执行器 | 拒绝 | `policy_denied` | 「rejects symbolic links…」「rejects staged hard links…」「rejects manifest paths outside the configured Workspace…」 |
| 沙箱输出中的宿主路径 | — | Host 脱敏 | `redactHostPaths`（执行器） | 不适用 | 不适用 | 「redacts host workspace and temporary paths from returned output」 |
| 沙箱网络：默认拒绝（localhost、公网、私网、DNS） | — | `(deny network*)` | Seatbelt Profile | 无 | 失败（exit ≠ 0） | 「denies localhost network access before the request reaches the Host」（沙箱外正向对照）；「denies public, private and DNS network destinations」 |
| 沙箱网络：允许模式下绕过代理直连 | — | `(deny network*)` 只放行代理端口 | Seatbelt Profile | 无 | 失败（exit ≠ 0） | 「denies direct connections that bypass the proxy in allowlist mode」 |
| 沙箱网络：域名 allowlist | 网络 | Manifest 白名单 + Host 代理 | `egressProxy.ts`（ADR-0030） | 无（Manifest 声明） | 允许域名成功；拒绝时代理返回 403/502 | 「reaches only allowlisted domains through the Host proxy」；`egressProxy.test.ts` 五项：域名拒绝且不解析、IP 字面量与非 443 端口拒绝、私网与回环拒绝、DNS 失败、通过已验证地址建立隧道 |
| 代理启动失败 | — | fail-closed | 执行器 | 不允许降级 | `sandbox_unavailable`（`egress_proxy_unavailable`） | 无专门测试（见第 4 节） |
| 沙箱不可用时执行 | — | fail-closed | `macOsSeatbeltSandboxedToolExecutor.ts` | 不允许降级 | `tool_sandbox_unavailable` | 「fails closed instead of spawning without Seatbelt」 |
| 沙箱超时、取消、CPU/内存/进程数上限 | — | Host Watchdog | 执行器 | 不适用 | `tool_timeout`、`resource_exhausted` | 「enforces stdout and wall-clock limits…」「propagates user cancellation…」「enforces CPU, sampled RSS and process-count budgets」 |
| 宿主被强制退出后的孤儿进程与临时目录 | — | 清理 | 执行器 | 不适用 | 不适用 | 「kills parser descendants and removes temporary output when the Host is forcibly terminated」 |
| 本机 HTTP 访问 | — | 进程令牌 + Host/Origin 校验 | `localAccess.ts` | 无（本机会话） | `local_access_denied` | `localAccess.test.ts` 两项用例 |
| 请求中伪造 tenant、workspace、actor | — | Host 注入身份 | `index.ts` 覆盖 `x-blackx-*` 请求头 | 不适用 | `local_access_denied` | `localAccess.test.ts`「binds a per-process capability… rejects forged identity…」 |
| 模型配置持久化与展示 | — | 私有配置文件 | `modelSettings.ts`；配置路径必须位于业务数据目录之外（`index.ts`） | 不适用 | `invalid_model_settings`、`settings_file_unsafe`、`provider_key_required` 等 | `modelSettings.test.ts`「persists privately, masks credentials…」「rejects unsafe endpoints…」 |
| 上游错误中回显的 Key | — | D4 脱敏 | `server/anthropic/client.ts` | 不适用 | 上游错误类型 | `client.test.ts`「redacts the configured key from upstream error messages in …」「bounds upstream error messages…」 |
| 运行时诊断日志中的 Secret | — | 环境变量脱敏 | `index.ts` `safeRuntimeDiagnostic` | 不适用 | 不适用 | 无专门测试（见第 4 节） |

## 3. 本轮修正记录

1. **上游错误回显 Key（已修复）。** 之前的异常对象保留了未脱敏的上游消息，违反 D4。现在替换为 `[redacted]` 并限制长度。
2. **Seatbelt localhost 用例不可信（已修正）。** 沙箱内 `curl` 无法启动，原断言即使网络未隔离也会通过。改用 `nc`，并以沙箱外的正向对照验证。
3. **私网拒绝测试曾经是假阳性（已修正）。** 代理最初把 IPv4 与 IPv6 规则放在同一个 `BlockList` 中，导致所有 IPv4 地址都被拒绝；公网隧道用例失败后才发现。现在分为两个列表，并保留公网隧道用例作为正向对照。
4. **测试服务器误用 HTTP 模块（已修正）。** 代理测试的回显服务器误用了 `node:http`，`ping` 被当作 HTTP 请求返回 400。
5. **沙箱输出宿主路径（已修复）。** 成功与失败执行的 stdout、stderr 中，临时目录、工作区与家目录路径都替换为占位符。

## 4. 剩余缺口

1. **“永久规则”决定：保持现状。** 2026-10-14 由产品负责人决定：逐次审批，不引入永久规则。M3 G1 中“永久规则”的测试项因此标记为不适用，相应修改需要新 ADR。
2. **`publish` 风险没有真实工具。** 引入第一个发布工具前，必须先绑定 Artifact Version 并设置独立审批（P1.8、P0.2）。
3. **运行时诊断脱敏缺少专门测试。** `safeRuntimeDiagnostic` 只替换环境变量中的 Secret，需要确认模型设置保存的 Key 也进入环境变量，或补测试。
4. **代理决定尚未进入审计。** ADR-0030 实现记录中已注明：代理决定通过 `onDecision` 暴露，还需接入 Attempt 级审计记录。
5. **代理启动失败的 fail-closed 路径没有直接测试。** 需要模拟端口占用或监听失败。
6. **M3 §9 尚未覆盖的条目。**
   - 脱离进程组的 Fork Bomb：沙箱内向 Supervisor 发信号已被拒绝，但 Fork Bomb 的进程树清理仍未验证。
   - Host 侧 Supervisor 崩溃：需要从测试进程中结束 Supervisor，尚未实现。
7. **审批人身份只有本机单用户。** 多用户审批需要等待 Tenant 与 RBAC 设计。
