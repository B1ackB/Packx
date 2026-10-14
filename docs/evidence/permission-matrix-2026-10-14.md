# 本地权限、Secret 与沙箱边界矩阵（M3 G1 / G2 / G4 子集）

日期：2026-10-14
范围：单用户本机 Host。主体包括本机用户、Host 进程、模型输出、前端页面、Native Sandbox 子进程。
依据：[`milestone-3-production-hardening.md`](../milestone-3-production-hardening.md) §3–§9、[`ADR-0013`](../adr/0013-just-in-time-file-approval.md)、[`ADR-0006`](../adr/0006-agent-managed-background-and-cron.md)、D4（Secret 脱敏）、[`ADR-0030`](../adr/0030-host-egress-proxy-for-sandbox-allowlist.md)（提议中）。

## 1. 基线与本次变更

| 项目 | 结果 |
|---|---|
| 基线 | `main` 的 `d72e4d2`，单元测试 962 个用例 |
| 本次结果 | `npm run check`：103 个文件、973 个用例通过（新增 11 个），构建成功 |
| 原生测试 | `npm run test:native`：37 个用例通过，其中 Seatbelt 20 个（`BLACKX_RUN_SEATBELT_TESTS=1`） |
| 浏览器回归 | 上次 24/24 通过，本次未改动界面 |

本次变更：
- 修复上游错误中回显 Key 的问题（D4）。
- 把 `/api/runtime/turn` 的开关与策略覆盖抽成 `server/runtime/runtimeEvalPolicy.ts`，并补测试。
- 把审批决策抽成 `hostToolApproval`（`server/runtime/createRuntime.ts`），并补三种分支的测试。
- 新增对话轮次策略推导测试（`server/runtime/conversationPolicy.test.ts`）。
- 补充 Seatbelt 对抗回归（公网、私网、DNS、嵌套 shell、文件数量超限、FIFO），并修正 localhost 用例。

## 2. 权限矩阵

风险等级沿用 `AgentTool.risk`：`read`、`write`、`publish`。“Host 策略”指由 Host 决定、模型不能修改的输入。

| 操作 | 风险 | 决定来源 | 强制位置 | 所需授权 | 失败码 | 覆盖测试 |
|---|---|---|---|---|---|---|
| 浏览本机目录、读取 UTF-8 文本 | read | Host 策略与身份 | `server/runtime/localFileAccess.ts`、`conversationFiles.ts` | 无（ADR-0013） | `file_path_denied` | `localFileAccess.test.ts`；`conversationFiles.test.ts`「isolates tenants, workspaces, sessions and approval ids…」 |
| 新建或修改文件 | write | 单次人工审批 | `src/agent/loop.ts` 审批分支；`conversationFiles.ts` 绑定路径、内容哈希与父目录身份 | 每次一次人工批准 | `tool_approval_required`、`tool_approval_denied` | `conversationFiles.test.ts`「creates a real immutable file, denies unapproved changes…」；`runtime.contract.test.ts`「denies write tools by default and executes them only with trusted approval and audit」 |
| 删除文件 | write | 单次人工审批 | 同上 | 每次一次人工批准；恢复历史也需批准 | 同上 | `conversationFiles.test.ts`「rejects deletion, then approves deletion…」 |
| 旧审批、过期或跨会话复用 | write | 审批绑定 | `conversationFiles.ts` | 拒绝执行 | `file_version_conflict` | `conversationFiles.test.ts`「rejects stale decisions and versions…」「cancels pending approvals on abort, expires after restart…」 |
| 发布类操作 | publish | 与 write 相同的审批闸门 | `src/agent/loop.ts`（`risk !== "read"`） | 人工审批 | 同 write | 当前无 `publish` 工具，无真实路径覆盖（见第 4 节） |
| 工具不在本轮白名单 | — | `allowedTools` | `src/agent/loop.ts` | 不适用 | `tool_not_allowed` | `runtime.contract.test.ts` 中 `tool_not_allowed` 用例；`agentPlanWorkflow.test.ts` |
| 工具输入不合法 | — | 工具 `validate` | `src/agent/loop.ts` | 不适用 | `tool_input_invalid` | `runtime.contract.test.ts`「classifies model-visible Tool validation…」 |
| 写入工具在 `approvalPolicy: never` 下执行 | write | Host 策略 | 运行时入口 | 拒绝执行 | `context_failure` | `personalMemory.test.ts`（`side_effect` + `never`） |
| 无审批端口时执行写入 | write | fail-closed | `server/runtime/createRuntime.ts` `hostToolApproval` | 不允许执行 | `tool_approval_denied` | `createRuntime.test.ts`「denies side effects when no approval port is configured」 |
| 自动批准（Host 配置） | write | 固定工具名单 | `server/index.ts` 的 `autonomouslyApprovedTools`；`createRuntime.ts` | 无人工批准；审批 ID 为 `policy:<tool>:v1` | — | `createRuntime.test.ts`「auto-approves only the configured automation tools」；`automationTools.test.ts`（bounded 后台任务与 Cron） |
| 对话轮次的 Tool 策略 | — | Host 推导 | `server/runtime/conversationApi.ts:350-351`：有工具 → `workspace-write` + `required`；无工具 → `read-only` + `never` | 由 Host 决定 | 不适用 | `conversationPolicy.test.ts` 三条用例（含「request-supplied tools or policy」） |
| 外部 `/api/runtime/turn` 调用 | — | Host 强制 | `server/runtime/runtimeEvalPolicy.ts`；`server/index.ts` 路由 | 不适用 | `runtime_eval_disabled` | `runtimeEvalPolicy.test.ts`（开关与强制策略）；路由接线本身无专门测试 |
| 沙箱读取（声明的 Workspace 输入） | read | Seatbelt Manifest | `macOsSeatbeltSandboxedToolExecutor.ts` | 无 | — | 「reads only declared Workspace inputs and receives only allowlisted environment values」 |
| 沙箱未声明读写 | read / write | Seatbelt Manifest | 同上 | 拒绝 | `tool_sandbox_policy_denied` / 失败 | 「denies undeclared reads and writes even when argv requests them」；「keeps Git and Packx control state denied…」 |
| 沙箱嵌套 shell 越权写入 | write | Seatbelt Manifest | 同上 | 拒绝；错误含 `Operation not permitted` | 失败（exit 1） | 「denies nested shell writes outside the declared scope」 |
| 沙箱输出超过文件数量 | write | Manifest 限制 | 执行器输出扫描 | 拒绝，不保留输出 | `resource_exhausted` / `output_limit_exceeded` | 「rejects staged outputs that exceed the declared file-count limit」 |
| 沙箱输出含 FIFO 等非普通文件 | write | Host 输出校验 | 执行器输出扫描 | 拒绝，不保留输出 | `policy_denied` / `output_validation_failed` | 「rejects FIFO and other non-regular files in staged output」 |
| 沙箱符号链接、硬链接、越界路径 | write | Host 校验 | 执行器 | 拒绝 | `policy_denied` | 「rejects symbolic links…」「rejects staged hard links…」「rejects manifest paths outside the configured Workspace…」 |
| 沙箱网络：localhost | — | 默认拒绝 | Seatbelt Profile | 无 | 失败（exit ≠ 0） | 「denies localhost network access before the request reaches the Host」：同一探测在沙箱外成功作为正向对照，沙箱内无连接 |
| 沙箱网络：公网、私网、DNS 名称 | — | 默认拒绝 | Seatbelt Profile | 无 | 失败（exit ≠ 0），无输出 | 「denies public, private and DNS network destinations」 |
| 沙箱网络：域名 allowlist | — | 未实现，fail-closed | 执行器 | 需 ADR-0030 | `sandbox_unavailable` | 「fails closed when domain allowlisting has no trusted Host proxy」 |
| 沙箱不可用时执行 | — | fail-closed | `macOsSeatbeltSandboxedToolExecutor.ts` | 不允许降级 | `tool_sandbox_unavailable` | 「fails closed instead of spawning without Seatbelt」 |
| 沙箱超时、取消、CPU/内存/进程数上限 | — | Host Watchdog | 执行器 | 不适用 | `tool_timeout`、`resource_exhausted` | 「enforces stdout and wall-clock limits…」「propagates user cancellation…」「enforces CPU, sampled RSS and process-count budgets」 |
| 宿主被强制退出后的孤儿进程与临时目录 | — | 清理 | 执行器 | 不适用 | 不适用 | 「kills parser descendants and removes temporary output when the Host is forcibly terminated」 |
| 本机 HTTP 访问 | — | 进程令牌 + Host/Origin 校验 | `server/localAccess.ts` | 无（本机会话） | `local_access_denied` | `localAccess.test.ts` 两项用例 |
| 请求中伪造 tenant、workspace、actor | — | Host 注入身份 | `server/index.ts` 覆盖 `x-blackx-*` 请求头 | 不适用 | `local_access_denied` | `localAccess.test.ts`「binds a per-process capability… rejects forged identity…」 |
| 模型配置持久化与展示 | — | 私有配置文件 | `server/modelSettings.ts`；配置路径必须位于业务数据目录之外（`server/index.ts`） | 不适用 | `invalid_model_settings`、`settings_file_unsafe`、`provider_key_required` 等 | `modelSettings.test.ts`「persists privately, masks credentials…」「rejects unsafe endpoints…」 |
| 上游错误中回显的 Key | — | D4 脱敏 | `server/anthropic/client.ts` | 不适用 | 上游错误类型 | `client.test.ts`「redacts the configured key from upstream error messages in …」「bounds upstream error messages…」 |
| 运行时诊断日志中的 Secret | — | 环境变量脱敏 | `server/index.ts` `safeRuntimeDiagnostic` | 不适用 | 不适用 | 无专门测试（见第 4 节） |

## 3. 本次发现与修正

1. **上游错误回显 Key（已修复）。** `server/anthropic/client.ts` 把上游 `error.message` 原样放入异常，违反 D4。现在替换为 `[redacted]` 并限制长度。
2. **Seatbelt 原 localhost 用例不可信（已修正）。** 沙箱内 `curl --version` 也会因读取系统配置被拒而失败，因此原用例即使网络未隔离也会通过。现改用 `/usr/bin/nc`，并在沙箱外做正向对照，要求沙箱内连接数为零。
3. **`/bin/sh` 输出的 `Error opening /private/var/select/sh` 是无害警告。** 沙箱内 `sh` 可以正常执行，嵌套写入的拒绝原因以 `Operation not permitted` 的 stderr 为准。
4. **自动批准列表与 ADR-0006 的关系。** `index.ts` 中自动批准的 `background_task_create`、`background_task_cancel`、`cron_create`、`cron_pause`、`cron_resume` 与 `memory_propose` 不需要逐次批准。依据是 ADR-0006 对有界任务的允许，且 `maxRuns` 限制在 1–100，Cron 最短间隔为 5 分钟。`memory_propose` 只生成待确认提议，不直接成为有效记忆。`file_write` 和 `file_delete` 不在该列表中。

## 4. 剩余缺口

1. **“永久规则”未实现。** M3 G1 要求“一次授权和永久规则”，但 ADR-0013 只允许逐次审批。是否引入需要产品决定和新 ADR，目前尚未立项。
2. **`publish` 风险没有真实工具。** Core 对 publish 复用写入闸门，没有绑定 Artifact Version 或对外目标。引入第一个发布工具前，必须先补齐版本绑定与独立审批（P1.8、P0.2）。
3. **运行时诊断脱敏缺少专门测试。** `safeRuntimeDiagnostic` 只替换环境变量中的 Secret。需要确认模型设置保存的 Key 也会同步进入环境变量，或补测试。
4. **沙箱成功结果把 stdout、stderr 原样交给模型。** 内容只做长度截断，可能包含宿主绝对路径（例如错误信息中的临时目录路径）。M3 §9 第 10 条要求不暴露不必要的宿主路径，这一项尚未实现，也没有测试。
5. **H2 尚未覆盖的 §9 条目。**
   - 脱离进程组的 Fork Bomb、超量进程的通用隔离：未验证。
   - Supervisor 自身故障：未验证。
   - 域名 allowlist：未实现，需 ADR-0030 接受后实施。
6. **审批人身份只有本机单用户。** 多用户审批需要等待 Tenant 与 RBAC 设计。
