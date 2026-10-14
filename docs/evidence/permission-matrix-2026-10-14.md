# 本地权限与 Secret 边界矩阵（M3 G1 / G4 子集）

日期：2026-10-14
范围：单用户本机 Host。主体包括本机用户、Host 进程、模型输出、前端页面、Native Sandbox 子进程。
依据：[`milestone-3-production-hardening.md`](../milestone-3-production-hardening.md) §3–§8、[`ADR-0013`](../adr/0013-just-in-time-file-approval.md)、D4（Secret 脱敏）。

## 1. 基线

| 项目 | 结果 |
|---|---|
| 分支与基线 | `feat/h1-upstream-error-redaction`，基于 `main`（`d72e4d2`） |
| 单元测试 | `npm run check` 通过（修复前 101 个文件 / 962 用例） |
| 类型检查与生产构建 | 通过 |
| 浏览器回归 | `npm run test:browser` 24/24 通过 |

## 2. 权限矩阵

风险等级沿用 `AgentTool.risk`：`read`、`write`、`publish`。“Host 策略”指由 Host 决定、模型不能修改的输入。

| 操作 | 风险 | 决定来源 | 强制位置 | 所需授权 | 失败码 | 覆盖测试 |
|---|---|---|---|---|---|---|
| 浏览本机目录、读取 UTF-8 文本 | read | Host 策略与身份 | `server/runtime/localFileAccess.ts`、`conversationFiles.ts` | 无（ADR-0013） | `file_path_denied` 等 | `localFileAccess.test.ts`；`conversationFiles.test.ts`「isolates tenants, workspaces, sessions and approval ids…」 |
| 新建或修改文件 | write | 单次人工审批 | `src/agent/loop.ts` 审批分支；`conversationFiles.ts` 绑定路径、内容哈希与父目录身份 | 每次一次人工批准 | `tool_approval_required`、`tool_approval_denied` | `conversationFiles.test.ts`「creates a real immutable file, denies unapproved changes…」；`runtime.contract.test.ts`「denies write tools by default and executes them only with trusted approval and audit」 |
| 删除文件 | write | 单次人工审批 | 同上 | 每次一次人工批准；恢复历史也需批准 | 同上 | `conversationFiles.test.ts`「rejects deletion, then approves deletion…」 |
| 旧审批、过期或跨会话复用 | write | 审批绑定 | `conversationFiles.ts` | 拒绝执行 | `file_version_conflict` 等 | `conversationFiles.test.ts`「rejects stale decisions and versions…」「cancels pending approvals on abort, expires after restart…」 |
| 发布类操作 | publish | 与 write 相同的审批闸门 | `src/agent/loop.ts`（`risk !== "read"`） | 人工审批 | 同 write | 当前仓库没有 `publish` 工具，无真实路径覆盖（见第 4 节） |
| 工具不在本轮白名单 | — | `allowedTools` | `src/agent/loop.ts` | 不适用 | `tool_not_allowed` | `runtime.contract.test.ts` 中 `tool_not_allowed` 用例；`agentPlanWorkflow.test.ts` |
| 工具输入不合法 | — | 工具 `validate` | `src/agent/loop.ts` | 不适用 | `tool_input_invalid` | `runtime.contract.test.ts`「classifies model-visible Tool validation…」 |
| 外部解析器（沙箱） | read | Seatbelt Manifest | `macOsSeatbeltSandboxedToolExecutor.ts`；`src/agent/sandbox.ts` | 读取无；写出仅限声明目录 | `tool_sandbox_policy_denied`（越权写出） | `macOsSeatbeltSandboxedToolExecutor.test.ts`：声明之外读写被拒、符号链接与硬链接、环境白名单、Git/Packx 控制状态 |
| 沙箱网络 | — | 默认拒绝 | Seatbelt Profile | 无 | 沙箱结果 `sandbox_unavailable` | 「denies localhost network access before the request reaches the Host」；「fails closed when domain allowlisting has no trusted Host proxy」 |
| 沙箱不可用时执行 | — | fail-closed | `macOsSeatbeltSandboxedToolExecutor.ts` | 不允许降级 | `tool_sandbox_unavailable` | 「fails closed instead of spawning without Seatbelt」；`sandboxedToolExecutor.contract.test.ts` |
| 写入工具在 `approvalPolicy: never` 下执行 | write | Host 策略 | `server/runtime/conversationApi.ts` 与运行时入口 | 拒绝执行 | `context_failure` | `personalMemory.test.ts`「…allowedTools: side_effect, approvalPolicy: never」 |
| 无审批端口时执行写入 | write | fail-closed | `server/runtime/createRuntime.ts`（默认 `{ approved: false }`） | 不允许执行 | `tool_approval_denied` | **无专门测试（缺口，见第 4 节）** |
| 对话轮次的 Tool 策略 | — | Host 推导 | `server/runtime/conversationApi.ts:350-351`：有工具 → `workspace-write` + `required`；无工具 → `read-only` + `never` | 由 Host 决定 | 不适用 | **无直接测试（缺口，见第 4 节）**；`executionRecovery.test.ts` 间接覆盖 `workspace-write` 路径 |
| 外部 `/api/runtime/turn` 调用 | — | Host 强制 | `server/index.ts:497-513`：需 `BLACKX_ENABLE_RUNTIME_EVAL=1`；强制 `allowedTools: []`、`read-only`、`required` | 不适用 | `runtime_eval_disabled` | **无专门测试（缺口，见第 4 节）** |
| 本机 HTTP 访问 | — | 进程令牌 + Host/Origin 校验 | `server/localAccess.ts` | 无（本机会话） | `local_access_denied` | `localAccess.test.ts` 两项用例 |
| 请求中伪造 tenant、workspace、actor | — | Host 注入身份 | `server/index.ts`：覆盖 `x-blackx-*` 请求头 | 不适用 | `local_access_denied` | `localAccess.test.ts`「binds a per-process capability… rejects forged identity…」 |
| 模型配置持久化与展示 | — | 私有配置文件 | `server/modelSettings.ts`；配置路径必须位于业务数据目录之外（`server/index.ts`） | 不适用 | `invalid_model_settings`、`settings_file_unsafe`、`provider_key_required` 等 | `modelSettings.test.ts`「persists privately, masks credentials…」「rejects unsafe endpoints…」 |
| 上游错误中回显的 Key | — | D4 脱敏 | `server/anthropic/client.ts`（本次修复） | 不适用 | 上游错误类型 | `client.test.ts`「redacts the configured key…」「bounds upstream error messages…」 |
| 运行时诊断日志中的 Secret | — | 环境变量脱敏 | `server/index.ts` `safeRuntimeDiagnostic` | 不适用 | 不适用 | 尚无专门测试（见第 4 节） |

## 3. 本次修复（D4 缺口）

问题：`server/anthropic/client.ts` 把上游 JSON 错误中的 `error.message` 原样放入异常，未替换配置的 Key，也没有长度限制。D4 要求对 Key 和上游响应中的敏感字段脱敏。

处理：
- 上游错误消息中的 Key 替换为 `[redacted]`。
- 错误消息最长 500 字符。
- 新增 4 个测试：`createMessage` 与 `countMessageTokens` 各一次脱敏用例，以及长度上限用例。修复前这些用例失败，修复后通过。

流式错误使用固定文案 `Model stream failed`，不受影响。模型失败只记录固定分类（`server/runtime/modelFailure.ts`），也不受影响。

## 4. 剩余缺口与待决定事项

1. **“永久规则”未实现。** M3 G1 要求“一次授权和永久规则”测试通过，但 ADR-0013 只允许逐次审批。是否引入永久规则是产品决定，需要新 ADR 说明范围、撤销方式和审计要求。本项不实现。
2. **`publish` 风险没有真实工具。** Core 对 publish 复用写入闸门，但没有绑定 Artifact Version 或对外发布的目标。引入第一个发布工具前，必须先补齐版本绑定与独立审批（P1.8、P0.2）。
3. **运行时诊断脱敏缺少专门测试。** `safeRuntimeDiagnostic` 只替换环境变量中的 Secret，未覆盖从模型设置保存的 Key。需要补测试，或确认该路径已经同步写入环境变量。
4. **审批人身份只有本机单用户。** 当前 Host 只有一个身份，多用户审批需等待 M3 之后的 Tenant/RBAC 设计。
5. **两处 Host 策略缺少直接测试。** 一是 `conversationApi.ts:350-351` 根据 `allowedTools` 推导 `workspace-write` 与 `approvalPolicy`；二是 `/api/runtime/turn` 的环境开关和强制只读。两者的错误方向都会扩大权限，应补回归测试。
6. **无审批端口时的 fail-closed 行为没有直接测试。** `createRuntime.ts` 的默认拒绝逻辑需要单独的用例。
