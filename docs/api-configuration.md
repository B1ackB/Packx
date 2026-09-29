# API 配置与 Online Eval 指南

当前产品仅支持包装需求。`POST /api/conversations/{conversationId}/requirement-brief` 使用 `{ requestId, industry: "print" }`；其他行业返回 `400 invalid_requirement_brief_request`。`print` 为兼容已有包装数据而保留，界面无需再选行业；新的行业 Fact 来自固定 Domain 配置（`enterprise_source` / `domain:print:packaging`），不伪装为一次人工选择。

历史非包装 Run 仍可读取，工作区响应增加 `readOnlyReason`。创建新版本、修改/确认 Fact 和审批均被拒绝；旧行业版本导出返回 `410 industry_retired`，原始数据保留在本地。旧队列任务以不可重试错误停止，允许用户取消历史任务或删除会话。跨 Run 包装指标排除这些历史 Run。详见 [ADR-0010](adr/0010-packaging-product-focus.md)。

状态：本地配置指南；历史在线验证范围见兼容性文档，当前改动未重新完成真实模型验收
更新日期：2026-09-07

## 会话文件 API

全部接口沿用本地会话 Token、Host/Origin 校验与 Host 注入身份；模型不能调用审批决定接口。会话已删除时统一返回 404。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/conversations/:id/files` | 返回文件 Artifact 版本元数据和当前未过期审批，含修改前后文本 |
| `GET /api/conversations/:id/files/content?path=...&version=1` | 按逻辑路径读取指定版本；省略版本读取当前文件，已删除则 404 |
| `POST /api/conversations/:id/files/approvals/:approvalId` | 请求体仅决定 `decision=approved/rejected`；Host 使用已保存的操作和内容，版本冲突/过期返回 409 |
| `POST /api/conversations/:id/files/directories` | 已停用，返回 `410 directory_grants_retired`，旧客户端应刷新 |
| `DELETE /api/conversations/:id/files/directories/:grantId` | 已停用，返回 `410 directory_grants_retired`，不再创建长期目录授权 |
| `GET /api/conversations/:id/files/directories?path=...` | 按 Host 策略浏览真实磁盘目录（最多 200 项）；省略 path 返回真实本机位置与历史文件 |
| `GET /api/conversations/:id/files/local-content?path=...` | 读取真实本地文本或受支持文档，返回绝对路径、SHA-256 和文本预览 |

模型通过 `file_list/read/write/delete` 发起文件操作。`file_list({})` 返回真实 homeDirectory/workingDirectory 等路径，供模型确定具体位置；`file_write/delete` 自动创建单次审批请求，UI 显示路径和内容、用户批准后继续执行。真实文件使用规范绝对路径，无需提前授权目录；写入/删除带 `expectedSha256`，首次新建为 `null`，其他操作必须与原文件哈希一致。**包括新建在内的所有写入、删除都需人工逐次审批**。原相对路径历史接口仍使用 `expectedVersion`。直接调用执行器也必须持有匹配授权记录；目录授权 API 已停用；模型不能调用用户审批接口。普通文本最多128 KiB，不能用文本内容冒充 PDF/Word/图片等二进制格式。

配置 `BLACKX_FILE_STORE_PATH`（默认 `.blackx-data/files`）保存备份和审批索引，与用户本地原文件、附件及已批准需求单分离。审批最多等待两分钟，停止任务会取消等待。本地删除会移除原路径文件，备份保留；恢复需重新审批写入。旧相对路径仍使用逻辑删除。即时审批与存储边界见 [ADR-0013](adr/0013-just-in-time-file-approval.md)。

## 模型调用监控与文件浏览

`GET /api/conversations/:id/model-calls` 返回当前会话模型请求记录，`?run=requirement` 切换为该会话的需求单工作流。沿用本机 Token、Host/Origin 和 Host 注入身份；删除的会话返回 404，身份不匹配拒绝。未创建需求单时返回空记录，读取失败返回 503 `model_metrics_unavailable`。

响应包含 `configuredModel`、`calls`、`retentionLimit=200`、`truncated`。记录包含独立调用 ID、executionId、请求模型、generate/count_tokens 类型、开始时间、耗时、running/succeeded/failed/cancelled/interrupted 状态；有效响应附带上游响应模型、终止原因与数值 Token 字段，失败仅暴露固定类别及可用的 HTTP 状态。每个 Provider 调用尝试单独计数（含重试和 Core 默认摘要），Token Count 单列，不冒充生成次数。统计不代表账单对账；无有效响应的请求不补造 Token 用量。

记录以 `model-calls.v1` 保存在 `BLACKX_AGENT_STATE_PATH/model-calls`，默认 `.blackx-data/agent/model-calls`，每个 tenant/workspace/run 独立索引，原子替换并 fsync。每个运行只保留最近 200 次请求，截断后 UI 明示保留窗口；只覆盖新功能启用后的请求。Host 重启后此前未结束请求显示 interrupted，禁止显示为仍在调用。删除会话后普通 API 不再访问记录，保留审计数据。

缓存命中率采用 Anthropic Messages 用量口径：`sum(cache_read_input_tokens) / sum(input_tokens + cache_read_input_tokens + cache_creation_input_tokens)`。仅纳入缓存读写字段都有效的响应，UI 显示覆盖响应数；字段缺失显示未提供，明确报告零时显示 0%。不启用缓存、不修改 Provider 缓存策略。口径依据：[Anthropic Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。

文件页复用已有受控 GET 接口。`files/directories` 无 path 返回 `locations` 和历史文件，工作目录遵循 `BLACKX_WORKSPACE_ROOT`；传 path 按需读取单层目录（最多 200 项）。`files/local-content` 打开真实 UTF-8 文本或通过隔离解析器预览 PDF、DOCX、XLSX；`files/content` 读取不可变历史快照。React 以纯文本呈现内容，不执行 HTML/脚本。目录树中的系统目录、隐藏路径、内部状态与链接继续按 Host 策略过滤。浏览操作不需要新增授权入口，写入/删除仍由单次审批控制。

## 1. 配置原则

Packx 当前支持两种 Runtime 模式：

| 模式 | 用途 | 所需 Secret |
| --- | --- | --- |
| `fake` | 常规离线测试与固定 Eval；Web Conversation API 会拒绝发送 | 无 |
| `anthropic` | Packx Agent Core 直连 Anthropic Messages 端点 | `ANTHROPIC_API_KEY` |

API Key 只能进入服务端进程环境或 Secret Manager，不应：

- 粘贴到聊天正文；
- 写入 `.env.example`；
- 提交到 Git；
- 放入前端代码、Prompt、Artifact、Event 或普通日志。

`npm run dev` 使用 Node 24 内置的 `--env-file-if-exists=.env` 读取项目根目录的本地配置，已有进程环境变量优先。复制 `.env.example` 为 `.env` 后填写配置；`.env` 已被 Git 忽略。此启动命令向服务端进程加载 `.env`；`dev:fixture` 使用本地固定 Provider 配置，在线 Eval 仍需通过终端环境注入配置。不要把密钥写入带 `VITE_` 前缀的变量。

## 2. Anthropic Messages 兼容端点要求

目标端点至少需要兼容：

- `POST /v1/messages`；
- `x-api-key` 请求头；
- `anthropic-version: 2023-06-01` 请求头；
- 非流式 Messages JSON 响应及 `stream: true` 的 Messages SSE 响应；
- Tool Use 与 `POST /v1/messages/count_tokens`（完整运行及 Contract Eval 会使用）；
- 你选择的模型 ID。

`ANTHROPIC_BASE_URL` 应填写服务根地址，不要以 `/v1` 结尾。Packx 会自行追加 `/v1/messages`。

例如官方端点的根地址形式为：

```text
https://api.anthropic.com
```

第三方兼容服务必须以其实际文档为准。如果鉴权头、路径或响应字段不同，不能仅靠改环境变量接入，需要增加对应 Adapter 配置和 Contract Test。

DeepSeek Anthropic 兼容端点示例：

```bash
export BLACKX_RUNTIME_MODE=anthropic
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

DeepSeek 默认返回 thinking block。Packx 将完整 assistant content 作为 Provider opaque state 保存，并在同一模型的 Tool Loop 下一轮原样回传；不会把 thinking 内容提升为权威事实或暴露到 `model.after`、Runtime 响应和 Artifact。用于 ContextSnapshot 的内部 `model.before` 事件包含该状态，日志型 Hook 必须丢弃它。

## 3. 在本机安全注入 Anthropic 配置

安装 Node 24.14.0 和依赖后，可直接 `cp .env.example .env`，编辑模式及三个 Provider 变量，再执行 `npm run dev`。免密钥固定交互使用 `npm run dev:fixture`，详见 [中文 README](../README.zh-CN.md)。

也可以在项目目录打开一个新的 `zsh` 终端，通过环境变量注入（在线 Eval 同样可用）：

```bash
export BLACKX_RUNTIME_MODE=anthropic
export ANTHROPIC_BASE_URL="你的服务根地址"
export ANTHROPIC_MODEL="端点实际支持的模型 ID"
read -s "ANTHROPIC_API_KEY?Anthropic API Key: "
export ANTHROPIC_API_KEY
npm run dev
```

`read -s` 输入时终端不会显示 Key。服务启动后，预期看到类似：

```text
Packx listening on http://127.0.0.1:5173 (blackx-agent)
```

`blackx-agent` 表示 Agent Loop、Hook、Context、Skill 和 Compact 由 Packx 自研 Core 驱动；模型请求由 Anthropic Provider Adapter 发出。

## 4. 健康检查

打开本机页面后查看侧栏状态：`模型已配置 · 待验证` 只表示配置已加载，`最近请求成功/失败` 表示最近一次实际执行结果。未携带本地会话凭据的请求会被拒绝：

```bash
curl http://127.0.0.1:5173/api/runtime/health # 预期 403
```

健康接口只证明服务端 Runtime Adapter 已启动，不证明目标模型、结构化输出、Tool 或恢复链路已经验证。

Web UI 先同源调用 `GET /api/local-session`，再携带进程级 `x-blackx-session-token`。Tenant、Workspace、Actor 由 Host 固定绑定；客户端身份不匹配、跨站来源和嵌入页面均被拒绝。Host 重启后刷新页面。可信本机 CLI 的握手示例见 `eval/productSmoke.ts`；这不是面向多用户的登录系统。

```text
GET  /api/conversations
POST /api/conversations
GET  /api/conversations/{conversationId}
DELETE /api/conversations/{conversationId}
GET  /api/conversations/{conversationId}/traces
GET  /api/conversations/{conversationId}/activity
POST /api/conversations/{conversationId}/stop
POST /api/conversations/{conversationId}/retry
POST /api/conversations/{conversationId}/messages
GET  /api/conversations/{conversationId}/attachments
POST /api/conversations/{conversationId}/attachments?requestId={requestId}&name={fileName}
GET  /api/conversations/{conversationId}/attachments/{attachmentId}/content
POST /api/conversations/{conversationId}/background-tasks
GET  /api/conversations/{conversationId}/background-tasks
GET  /api/background-tasks/{taskId}
GET  /api/conversations/{conversationId}/cron-schedules
GET  /api/conversations/{conversationId}/requirement-brief/versions/{version}?format=md|html|json
```

会话删除不依赖模型配置。`DELETE` 无请求体，会话 ID 是幂等目标；首次及重复删除返回 `200 { conversationId, deletedAt }`，保留首次操作人和时间。不存在或属于其他 Tenant/Workspace 的目标返回 `404`，身份校验仍使用本地会话凭据。删除先在原子 Session 文件中持久化 `deletion`，再停止活动 Turn、取消关联 Background/Proposal/Requirement Job、暂停 Cron，并取消未完成 Workflow（同时失效其审批）。已通过的交付和审批不改写。清理失败返回 `503 conversation_cleanup_pending`，重复 DELETE 可重试；Scheduler 每次派发前后重放删除意图，因此重启和迟到 Outbox 不会恢复该会话的任务。

这是工作台删除，**不是文件物理擦除**：历史消息、附件、Context、Trace、Artifact 和审计事件保留在本地供追溯。删除后的会话不再列出，普通会话及附件、任务状态、需求单和版本导出接口拒绝访问，Session 存储拒绝继续读取或保存执行状态。界面确认框明确说明此保留范围；删除最后一个会话后保持空列表，用户可主动新建。

消息接口只接受 `blackx-agent` Runtime；Fake 模式返回 `real_provider_required`。请求体为 `{ messageId, content, attachmentIds? }`，其中 `attachmentIds` 最多选择 8 个当前会话内、可供模型读取的图片或文档；有可读附件时允许 `content` 为空。服务端会先把用户消息和图片/文档引用写入 Agent Session，再调用模型，因此页面可以立即乐观显示消息，失败或刷新时也不会依赖浏览器 `localStorage`。同一会话只允许一个进行中的 Turn。

附件上传使用原始二进制请求体，单个文件上限 10 MB、每个会话最多 20 个附件和 50 MB，并以 `requestId` 保证幂等。文件内容、元数据和读取接口受 Tenant、Workspace、Conversation 与 SHA-256 校验约束。不超过 5 MB 的 PNG、JPEG、WebP 和 GIF 可作为模型图片输入；Base64 不持久化到 Agent Session、ContextSnapshot 或 Trace。

生成 Requirement Brief 时，正式 `asset_metadata_inspect` 在 macOS Seatbelt 中解析冻结的附件集合：文字 PDF / UTF-8 文本返回有页码的文字，图片返回像素元数据，无文字 PDF 显示 `needs_ocr`。最大 100 页、8,000 个 Swift 字符；截断状态随 Artifact 与导出保留。资料内容是非权威来源，不会自动确认 Fact。没有成功解析的附件不能满足来源完成门槛，非 macOS 不能自动无沙箱降级。`npm run dev` 会先编译自写原生程序，需要 Apple Command Line Tools。普通会话通过 `document_read` 按需读取已选文档或安全的本地绝对路径：PDF 提取文字，DOCX 提取段落和表格，XLSX 提取工作表和单元格值。DOCX/XLSX 最多返回 24,000 个 Swift 字符；Excel 最多 20 个工作表、每表 500 行，不计算公式。无 OCR，不支持旧 `.doc`/`.xls`，不会写回 Office 文件。流式正文通过当前会话 Activity SSE 发送，只有完整响应才保存为完成消息；停止或断流不会把部分正文记成成功。详见 [ADR-0014](adr/0014-streaming-and-document-sources.md)。

Background Task POST 接受与普通消息相同的 `{ messageId, content }`，返回 `202`。公开状态不回传消息正文，只包含 Task、Conversation、Message ID、Queue 状态、投递/失败计数和脱敏失败分类。任务 payload 受 64 KiB 上限约束并纳入 jobId 幂等冲突判断；Scheduler 以 at-least-once 语义执行，同一个 `messageId` 保证 Crash 重放不会重复追加用户消息或重复已完成的模型 Turn。当前 UI 对同一会话一次只提交一个后台消息，但其他会话可以继续交互。

普通 Conversation Turn 还会向实际模型暴露受控的 `background_task_create/status/cancel` 和 `cron_create/list/pause/resume`。写 Tool 必须通过服务端预授权 Policy、Audit 与 Execution Ledger；模型文本本身不构成授权。Cron 必须使用 IANA timezone、至少间隔 5 分钟并明确 `maxRuns`（1–100）。默认文件为 `.blackx-data/cron-schedules.json`，可用 `BLACKX_CRON_SCHEDULE_PATH` 覆盖。

## 5. 运行固定 Online Eval

旧版 HTTP Online Eval 需先使用 `BLACKX_ENABLE_RUNTIME_EVAL=1 BLACKX_RUNTIME_MODE=anthropic npm run dev` 启动本机 Host；Eval CLI 自动完成本机会话握手。此端点仍禁用 Tools 并固定身份，日常启动不应启用。直接调用 Provider 的 Contract/M1 Eval 不依赖此开关。在第二个终端执行：

```bash
BLACKX_EVAL_BASE_URL=http://127.0.0.1:5173 npm run eval:online

# 直接验证自研 Core 的 Anthropic Token Count、摘要 Compact 和 Tool Loop
npm run eval:anthropic-contract

# 行业无关 M1 Tool Loop、Evidence Artifact 和 Fact Lineage
npm run eval:m1
npm run eval:m1-online
```

`eval:m1` 和 `eval:m1-online` 都会贯通 Queue → Worker → Artifact Version → Evaluation → Approval → Stage Gate；前者使用固定离线模型，后者直接使用当前 Shell 中的 Anthropic-compatible 配置，不要求先启动 Web 服务。设置 `BLACKX_EVAL_REPORT_PATH` 可以把不含 Secret 的 JSON 报告写入指定路径。

`eval:anthropic-contract` 在未配置时默认使用官方 `https://api.anthropic.com` 与 `claude-haiku-4-5-20251001`，但生产或长期回归应显式固定 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL`。失败报告只保留标准化 Runtime/Provider code 和状态，不输出 API Key 或 Provider 原始正文。`providerStatus` 表示真实上游 HTTP 状态，`adapterStatus` 表示 Adapter 在 HTTP 成功后产生的本地 Contract 状态。

当前固定封口袋 Fixture 检查：

- 返回值符合 `assistantMessage` JSON Schema；
- 没有把待确认参数升级为“已验证”或“生产就绪”；
- 回复保留明确的待确认边界；
- 存在 Session、Message 和 Turn 完成证据；
- 报告包含标准化 Usage，但不包含 API Key。

只有报告中的 `passed` 为 `true`，才能把该 Fixture 记为通过。一次文本返回成功不等于整个兼容路径通过。

## 6. 结束后清除当前终端变量

停止服务后执行：

```bash
unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_MODEL
unset BLACKX_RUNTIME_MODE
```

这只会清除当前终端会话中的变量，不会撤销或轮换服务商侧的 Key。若 Key 曾经出现在聊天、Shell 历史、日志或 Git 中，应立即在服务商后台吊销并重新生成。

## 7. 启动 Online Eval

完成环境配置后，只需告诉开发 Agent：

```text
Anthropic API 环境变量已配置完成，请执行 Packx Agent Core Online Eval。
```

不要在消息中附带 Key。执行时只验证变量是否存在，只报告“已设置/未设置”，不得打印变量值。

## 8. 当前能力边界

已完成：

- Agent Core 与 Anthropic Messages 的离线协议映射测试；
- 服务端 Key 边界；
- 文本、Function Tool、Tool Result、JSON Schema、Usage 映射；
- Agent Loop、Hook、Context、Skill 和 Compact 离线测试；
- 固定离线 Print Eval。

DeepSeek `deepseek-v4-flash` 已具备真实 API 证据：

- Token Count；
- 摘要 Compact；
- thinking block 跨 Tool Call/Result 原样回传；
- Session Context Snapshot 与 Usage。

仍需真实 API 证据：

- Session start / continue / resume；
- 限流、超时、中断和错误映射；
- 原生逐 Token 流；
- Token、成本与 P50/P95 延迟。

M0 Anthropic-compatible Online Contract 已通过；在上述证据完成前，生产可用性仍保持 `Unverified`。

## 9. Proposal Run 命令 API

新的 Enterprise Kernel API 默认关闭。启用本地命令和查询时，应分别注入普通命令 Token 与 Worker Token：

```bash
read -s "BLACKX_COMMAND_API_TOKEN?Command API Token: "
export BLACKX_COMMAND_API_TOKEN
read -s "BLACKX_WORKER_API_TOKEN?Worker API Token: "
export BLACKX_WORKER_API_TOKEN
read -s "BLACKX_OPERATOR_API_TOKEN?Operator API Token: "
export BLACKX_OPERATOR_API_TOKEN
export BLACKX_EVENT_STORE_PATH=".blackx-data/events.json"
export BLACKX_ARTIFACT_STORE_PATH=".blackx-data/artifacts"
export BLACKX_ATTACHMENT_STORE_PATH=".blackx-data/attachments"
export BLACKX_STAGE_JOB_QUEUE_PATH=".blackx-data/stage-jobs.json"
export BLACKX_STAGE_JOB_QUEUE_DRIVER="file"
npm run dev
```

- `BLACKX_COMMAND_API_TOKEN`：创建 Run、启动/重启 Stage、记录 Fact Version、处理 Approval 和查询状态。
- `BLACKX_WORKER_API_TOKEN`：仅供受信服务调用服务端 Proposal Worker，或提交 Runtime、Artifact 与确定性 Evaluation 证据。
- `BLACKX_OPERATOR_API_TOKEN`：仅供受信运维服务查询 Queue 指标、检查 DLQ 和执行带审计信息的 redrive。
- Worker 与 Operator Token 必须不同且至少为 32 字节；配置相同或过短时服务拒绝启动。Command Token 也应独立配置。
- 每个请求都必须携带 `x-blackx-tenant-id` 和 `x-blackx-workspace-id`；普通命令与查询还必须携带 `x-blackx-actor-id`。
- Worker 命令的事件 Actor 固定为 `blackx-worker`，不能通过请求头冒充其他 Actor。
- Token 只进入 `Authorization: Bearer ...`，不会写入 Event、Artifact、日志或 Model Provider 请求。
- 默认事件文件为 `.blackx-data/events.json`，Artifact 内容目录为 `.blackx-data/artifacts`，Stage Job Queue 为 `.blackx-data/stage-jobs.json`，均已被 Git 忽略。它们用于本地开发和跨进程恢复验证，不是生产数据库、对象存储或分布式队列。
- 当前 Event Store 文档 Schema 为 v3，在同一原子文件中保存 Event 与 Outbox；读取兼容 v2 并在下一次写入升级。早期 v1 本地试验文件没有足够数据可自动补齐，读取时会 fail-closed。需要保留旧试验数据时应先备份，再显式迁移或改用新的本地路径。
- 当前普通命令仍使用共享服务 Token，`x-blackx-actor-id` 是受信调用方声明，不等于完整用户身份认证或 RBAC。

推荐的最小调用顺序是：

```text
Command Token: create_run → start_proposal → record_fact_version
Worker Token:  POST /api/proposal-runs/{runId}/execute-proposal
Worker Token:  GET /api/stage-jobs/{jobId} → 等待 completed 或 dead_letter
Command Token: GET 状态 → resolve_approval
Worker Token:  POST /api/proposal-runs/{runId}/execute-proposal（确认 Stage Gate）
```

`record_fact_version` 请求必须携带 `factKey`、递增的 `factVersion`、`value`、可选 `unit` 和 `sourceRef`。普通命令入口会把它固定记录为 `status=unverified`、`sourceType=user_input`；客户端不能通过该入口自封为 `verified`。

Proposal Worker 请求体只接受执行信封：

```json
{
	"commandId": "execute-proposal-v1",
	"correlationId": "trace-001",
	"expectedVersion": 3
}
```

该 POST 先把 `stage.execution_requested` Event 与 Outbox 原子提交，再尽力立即投递，并返回 `202`。若 Queue 暂时不可用，响应会标记 `outbox_pending`，后台 Dispatcher 会重试；Queue enqueue 使用确定性 Job ID 去重。该调度 Event 会占用一个 Aggregate Version，因此 Job 内部的 `expectedVersion` 比请求值大一。后台 scheduler 通过租约领取 Job并在长 slice 中续租；每次 delivery 只执行一个 Runtime slice。Agent Core 返回 `paused` 时，Queue 保存同一 `sessionId` 与最后一个 `contextSnapshotId`、清除租约并排回队列，Worker 槽位立即释放；下一次领取用 `resume: "if-present"` 续跑。Runtime 最终完成后，Worker 保存 `proposal-runtime-checkpoint.v2`，再用三个幂等命令依次追加 Runtime、Artifact、Evaluation/Approval 事件。评测失败时保留候选与报告，Stage 进入 `retryable_failed`，不会创建 Approval。

Job 状态可通过同一 Tenant/Workspace 与 Worker Token 查询。`queued` 表示等待或退避，`leased` 表示某个 Worker 正在执行一个 slice，`completed` 表示本次 Worker 命令已提交，`dead_letter` 表示不可重试、连续失败或总 slice 预算耗尽。调用方随后仍需查询 Proposal Run 的业务状态；Job 完成不等于审批完成。

Operator API 使用相同 Tenant/Workspace Header、独立 Operator Token，并为 redrive 额外要求 `x-blackx-actor-id`：

```text
GET  /api/stage-jobs/metrics
GET  /api/stage-jobs/dead-letter
POST /api/stage-jobs/{jobId}/redrive
```

Requirement Brief 产品指标使用普通租户/Workspace 身份读取，不需要 Worker 或 Operator Token：

```text
GET /api/requirement-brief/metrics
```

响应为 `requirement-brief-metrics-series.v1`，包含按 Run 开始时间排序的时间点，以及 Evaluation/Approval/Stage 比率、候选确认准确率、来源覆盖率、澄清问题、Artifact 版本、Queue 和 Tool 失败/恢复率、Token 与耗时汇总。该接口只扫描当前 Tenant/Workspace 下 Conversation 对应的 Requirement Run；未配置 Provider 价格时返回 `costUsd=null`、`costStatus=unconfigured`。

redrive 请求体必须包含当前 Job 的 `expectedUpdatedAt` 和人工原因 `reason`，可选 `additionalSlices` 为 1–32。它只允许重放当前租户/工作区中的 `dead_letter` Job，复用原 Job、Command 和 Session 身份，并记录 Actor、原因、时间与 redrive 次数。租约过期恢复另外记录 `recoveryCount`、前任 Worker、过期时间、恢复时间和检测延迟；metrics 汇总 `recoveries` 与 `recoveryDetectionDelayMs`。

`BLACKX_STAGE_JOB_QUEUE_DRIVER=file` 是默认本地 Adapter。设置为 `sqlite` 时，`BLACKX_STAGE_JOB_QUEUE_PATH` 应指向 `.sqlite` 文件；该实现支持单主机多 Worker 的事务 claim，但仍不是多主机分布式 Queue。当前 Node 的 `node:sqlite` 仍可能显示 experimental warning。

Approval `approved` 只表示人工决定已经持久化，Run 仍保持 `waiting_approval`。调用方读取最新 `aggregateVersion` 后，以新的 Worker `commandId` 再次调用同一路径；Worker 验证当前 Artifact 仍为 `fresh` 且审批绑定正确，追加 `stage.completed` 后才进入 `completed / passed`。

停止服务后清理当前终端中的权限变量：

```bash
unset BLACKX_COMMAND_API_TOKEN BLACKX_WORKER_API_TOKEN BLACKX_OPERATOR_API_TOKEN
unset BLACKX_EVENT_STORE_PATH BLACKX_ARTIFACT_STORE_PATH BLACKX_ATTACHMENT_STORE_PATH BLACKX_AGENT_STATE_PATH BLACKX_STAGE_JOB_QUEUE_PATH BLACKX_STAGE_JOB_QUEUE_DRIVER
```

## 图形配置入口

运行 Packx 后点击侧栏“配置模型”，填写兼容 Anthropic Messages 的地址、模型 ID 和 API Key，保存后停止并重新启动。保存与诊断不调用模型。设置保存在本机私密文件 `.packx-settings.json`，优先于 `.env` 中对应的 Provider 项；留空 Key 保留已有凭据，显式清除会同时屏蔽环境变量中的 Key。文件不进入业务备份，也不会返回给浏览器。完整说明见[本地操作](local-operations.md)。

## 复核专用输出预算（2026-09-29）

可选 `PACKX_REVIEW_MAX_OUTPUT_TOKENS` 只作用于需求单的证据复核和允许的一次叙述修订。它必须是正整数，且不超过 `PACKX_MODEL_MAX_OUTPUT_TOKENS`。不设置时保留原预算；配置保存不代表授权执行付费实验。

例如模型上限已被操作者设为 16384 时，可以显式使用同样的复核预算。模型上限也约束其他 Turn，修改前应考虑整体费用。16384 已完成[限定在线对照](evidence/review-output-budget-2026-09-29.md)，虽减少了本批截断，但未达到控制质量与动作边界门槛，不能作为已验证推荐值。它不能保证不再截断。

收到 `output_limit` 后，当前草稿保留且不能审批，不会自动扩大预算或重试。调整预算后须发起新执行，旧调用意图、报告及未知费用保留。详见[复核说明](requirement-evidence-review.md)。
