# Packx 工程交接文档（按优先级）

状态：Draft · 日期：2026-10-14
依据：`AGENTS.md`、[`roadmap.md`](../roadmap.md)（2026-09-13）、[`milestone-3-production-hardening.md`](../milestone-3-production-hardening.md)、2026-10-14 架构分析

## 0. 使用说明

- 优先级与 `AGENTS.md` 的 P0–P3 一致，并与 `roadmap.md` §5 近期队列对齐。
- 接手前先读：`AGENTS.md`、`roadmap.md`、M3 文档 §4–§8。
- 每项包含：目标、现状、落点、工作项、验收、停止条件、是否需要 ADR。
- 负责人统一为 GitHub 账号 `B1ackB`（2026-10-14 确认）。
- 路线图更新于 2026-09-13，之后已有大量提交（最近为 2026-10-12）。开工前先用 `git log` 核对状态，发现不一致时先更新路线图。

## 1. 对上一轮分析的修正

上一轮建议有三处与路线图冲突，以本文为准：

1. **Postgres / 对象存储 Adapter 不进入近期工作。** `roadmap.md` §7 规定托管云选型未定，本地 M3 不提前选择；§6 暂缓多主机分布式 Queue 与自研分布式存储。
2. **服务端压缩、MCP 企业集成不进入近期工作。** `roadmap.md` §6 暂缓"高级上下文压缩"；MCP 集成未在路线图中，需先立项并写 ADR。
3. **提示词缓存不在暂缓列表，但也不在近期队列。** 需产品负责人决定是否插队（见 §6 未决问题 2）。

## 2. 交接前提

- **工作区未收口**：`git status` 显示 35 个已修改未提交文件。任何新工作开始前先完成 H0。
- **ADR 编号**：最新为 0029，新 ADR 从 0030 开始。
- **基线命令**（在仓库根目录执行）：

```bash
npm run check                 # test + build
npm run test:native           # macOS：Seatbelt、资产解析、文档读取
npm run check:local           # 完整本地门禁（含 eval 与 product smoke）
BLACKX_RUN_SEATBELT_TESTS=1 npx vitest run server/runtime/macOsSeatbeltSandboxedToolExecutor.test.ts
```

## 3. 状态总览

| 序 | ID | 工作项 | 优先级 | 对齐 | 当前状态 | 需 ADR | 负责人 |
|---|---|---|---|---|---|---|---|
| 1 | H0 | 工作区收口与基线 | P0 | 路线图前置 | 已完成（三提交拆分，基线记录见证据文件） | 否 | B1ackB |
| 2 | H1 | 本地权限、审批与 Secret 边界 | P0 | 路线图 #2；M3 G1、G4 | 大部分完成（永久规则已决定保持现状；剩余：publish 工具、诊断脱敏测试） | 视情况 | B1ackB |
| 3 | H2 | Native Sandbox 对抗回归与域名 allowlist | P0 | 路线图 #1；M3 G2 | 大部分完成（域名 allowlist 与输出脱敏已实现；剩余：Fork Bomb 进程树、Host 侧 Supervisor 崩溃、代理决定入审计） | 是（ADR-0030 已接受） | B1ackB |
| 4 | H3 | 包装真实用户补验（与工程并行） | P0 | 路线图 #4；D10 | 未开始 | 否 | B1ackB（产品负责人） |
| 5 | H4 | 本地存储、迁移、备份恢复 | P0 | 路线图 #3；M3 G5 | 部分完成 | 视情况 | B1ackB |
| 6 | H5 | 工具契约单源 Schema 与字段级校验错误 | P1 | P2.2、P2.3；M3 Tool Contract | 未开始 | 否 | B1ackB |
| 7 | H6 | 本地运行指标与关联 ID | P1 | P2.6；M3 §11 | 部分完成 | 否 | B1ackB |
| 8 | H7 | 提示词缓存 | P1（待排期） | P3.3；成本 | 未开始 | 否 | B1ackB |
| 9 | H8 | 路由与前端渐进拆分 | P2 | P1.4、P3.1 | 未开始 | 否 | B1ackB |
| 10 | H9 | Skill 迁移为 SKILL.md | P2 | P1.9、P0.5 | 未开始 | 是 | B1ackB |
| 11 | H10 | 数据层 Postgres / 对象存储 Port | P3（暂缓） | D8；路线图 §7 | 暂缓 | 是 | — |
| 12 | H11 | 服务端压缩 / Context Editing | P3（暂缓） | 路线图 §6 | 暂缓 | 视 Eval | — |
| 13 | H12 | MCP 企业系统集成 | P3（暂缓） | P1.5 | 暂缓 | 是 | — |
| 14 | H13 | UI token 级流式 | P3 | 体验 | 未开始 | 否 | B1ackB |
| 15 | H14 | 命名兼容 `PACKX_*` 优先 | P3 | D13 | 未开始 | 是 | B1ackB |
| 16 | H15 | Eval 脚本收敛 | P3 | P3.3 | 未开始 | 否 | B1ackB |

P0 为近期必须完成的路线图队列；P1 为与 M3 同期可做、需确认排期；P2 为 M3 完成后推进；P3 为暂缓或低优先级。

---

## P0：近期必须完成

### H0 工作区收口与基线

- **目标**：让后续每项工作都有可复现的起点。
- **工作项**
  1. 盘点 35 个修改文件，按主题拆分提交（如 requirement、knowledge、ui、docs、eval、server-runtime）。
  2. 在干净分支上运行 §2 的基线命令，把结果记录到 `docs/evidence/`。
  3. 核对 `git log` 与 M3 文档的 Slice 状态，有差异先更新路线图。
- **验收**：每个分支只包含一个主题；基线结果有证据文件。
- **停止条件**：`.packx-settings*`、`.blackx-data/`、`temp/` 或任何 Secret 出现在待提交文件中。虽然 `.gitignore` 已忽略它们，仍需逐项确认。

### H1 本地权限、审批与 Secret 边界（M3 G1、G4 子集）

- **目标**：模型与前端不能扩大 Workspace、Tool 权限或跳过审批；Secret 不进入模型消息、Tool 环境、Artifact 与普通日志。
- **现状**
  - `src/agent/loop.ts` 已检查 `allowedTools` 与 `validToolInput`。
  - `src/agent/sandbox.ts` 编译冻结的 `ToolExecutionManifest`。
  - Seatbelt 使用显式环境白名单。
  - `server/index.ts:73` 强制设置独立的 settings 路径，不得位于业务数据目录内。
  - Approval 绑定 Artifact Version（ADR-0013）。
  - **缺口**：read / write / publish 与 allow / ask / deny 的统一权限矩阵未集中定义；G1 要求的"一次授权与永久规则"测试未确认。
- **落点**：Local Host（Policy、`server/localAccess.ts` 身份）。Core 只提供 Hook，不增加业务分支（P1.9）。
- **工作项**
  1. 编写权限矩阵（风险等级 × sandboxMode × Approval 状态 → 决定），并做表驱动测试。
  2. 确认 Workspace 与 Actor 身份只由 Host 建立；请求体中的 `tenantId`、`workspaceId` 不被信任。
  3. Secret 盘点：Provider Key、模型设置中的 apiKey。补测试证明不出现在 Prompt、Artifact、日志。
  4. 异常路径 fail-closed：Approval 缺失、Policy 抛错一律拒绝。
- **验收**
  - 权限矩阵测试全部通过。
  - 越界 fixture（伪造 Workspace、扩大路径、跳过审批）全部被拒。
  - 日志脱敏测试覆盖 `ANTHROPIC_API_KEY` 与 Authorization 头。
- **停止条件**：发现模型或前端可以改变 sandboxMode、路径、网络或审批状态。此时暂停其他工作，先修复。
- **需 ADR**：仅当 Approval 语义或 Policy 位置改变时需要。

### H2 Native Sandbox 对抗回归与域名 allowlist（M3 G2）

- **现状**（M3 Slice 2）
  - 已覆盖：读写边界、默认断网、符号链接、硬链接、输出摘要、stdout 超限、超时、用户取消、子进程组清理。
  - **未完成**：域名 allowlist（当前返回 `sandbox_unavailable`）；脱离进程组的 Fork Bomb；Supervisor 自身故障；任意代码的通用资源隔离。
- **落点**：`server/runtime/macOsSeatbeltSandboxedToolExecutor.ts`、`native/ToolSupervisor.c`。
- **工作项**
  1. 固定测试 executable，逐条实现 M3 文档 §9 的十条攻击回归，并把每条映射到具体测试名。
  2. 脱离进程组的子进程：验证 Host 能通过进程组或 Supervisor 清理。
  3. 域名 allowlist：设计 Host 外部 egress 代理。代理落地前保持 fail-closed，不得开放 allowlist。
  4. Supervisor 崩溃：结果映射为 failed 或 unknown，不得提交输出。
- **验收**：`BLACKX_RUN_SEATBELT_TESTS=1` 下，M3 §9 十条全部有测试并通过；未授权域名、localhost、私网被拒。
- **停止条件**：任何路径降级为非沙箱执行。
- **需 ADR**：是。egress 代理是新的网络边界，建议编号 ADR-0030。
- **注意**：资源采样不等于内核配额，文档中不得表述为内存硬限制（M3 Slice 2 已有此约束）。

### H3 包装真实用户补验（路线图 Gate 4，与工程并行）

- **目标**：补全 D10 的 Validation Debt。工程测试不能替代这项证据。
- **工作项**
  1. 使用 [`user-validation-template.md`](../user-validation-template.md)。
  2. 招募 2–3 名包装售前或跟单人员，在其授权资料上完成一个高频任务：需求单 → 证据复核 → 审批 → 交付。
  3. 记录可交付判断、错误、耗时、返工次数，并脱敏保存。
- **验收**：有原始记录和结论；合成样例不得写成用户证据。
- **停止条件**：使用的资料包含未授权客户机密。
- **后续**：若反馈否定交付价值，按 D10 重开 M2 Product Validation，并更新路线图。

### H4 本地存储、迁移与备份恢复（M3 G5）

- **现状**
  - 事件存储为整文件 JSON：`server/enterprise/fileEventStore.ts`，`schemaVersion: 3`。
  - 多个独立 SQLite：personal-memory、task-checkpoints、plans、task-names；stage-jobs 可选 SQLite。
  - 已有备份（`server/localBackup.ts`）、进程锁（`server/localData.ts`、`server/fileWriteLock.ts`）与版本检查（`ensureLocalDataVersion`）。
- **工作项**
  1. 建立迁移框架：按版本逐步迁移，失败时回滚，有测试。
  2. 对 `events.json` 做崩溃注入：临时文件写入中断、rename 前后中断，验证恢复。
  3. 补充备份测试：SQLite 文件一致性与 `.packx-incomplete` 标记。
  4. 记录 `events.json` 的大小与单次写入耗时基线。这是判断何时需要改存储的依据。
- **验收**：崩溃注入、迁移、备份恢复均有可重放测试；耗时基线进入 `docs/evidence/`。
- **停止条件**：任何 Artifact 或 Approval 可被原地覆盖。
- **需 ADR**：若决定把 `events.json` 迁入单机 SQLite，需要 ADR。这是本地存储边界变化，不是分布式改造。本项先做基线与测试，不直接迁移。

---

## P1：与 M3 同期推进，需确认排期

### H5 工具契约单源 Schema 与字段级校验错误（P2.2、P2.3）

- **现状**：`src/agent/contracts.ts` 的 `AgentToolBase` 同时要求 `inputSchema`（JSON Schema）和 `validate(input): boolean`。两者各自手写，例如 `server/knowledge/service.ts`、`server/manufacturing/knowledgeComparison.ts`、`server/manufacturing/coffeeProductDirectory.ts`、`server/runtime/researchTools.ts`。布尔返回值无法说明出错字段。
- **落点**：Tool 定义内部。**不修改 `AgentTool` 公共接口**，从而避免 Core 扩展（P1.9）。
- **工作项**
  1. 依赖登记：选定 schema 库（候选 Zod、TypeBox），按 P0.5 记录版本、许可证和 integrity，写入 `docs/dependencies.md`。
  2. 在 Tool 定义内用同一 schema 同时派生 JSON Schema 和 `validate`；校验失败返回 `tool_input_invalid` 及字段级 issues。
  3. 样板迁移两个 Tool（建议 knowledge search 与 `packaging_find_products`），其余随修改逐步迁移。
  4. 测试：同一组 fixture 对 JSON Schema 与运行时校验结果一致。
- **验收**：样板 Tool 对非法输入返回字段级错误；模型侧 schema 与运行时校验来自同一源，并有快照测试。
- **停止条件**：引入的依赖存在未通过审计的传递依赖。
- **需 ADR**：否（前提是不改 `AgentTool` 形状）。

### H6 本地运行指标与关联 ID（P2.6、M3 §11）

- **现状**：遥测为自定义结构（`src/runtime/modelTelemetry.ts`、`server/runtime/modelTelemetry.ts`）。`anthropicModelProvider.ts` 已记录 `cacheReadTokens` 与 `cacheWriteTokens`，但没有 trace 或 span 关联。
- **工作项**
  1. 为 Run、Stage、Turn、ModelCall、ToolCall、Sandbox Attempt 统一关联 ID，字段与 M3 §11 对齐。
  2. 定义 Telemetry Port，默认写本地脱敏 JSONL；提供离线 Fake。
  3. 字段命名参考 OpenTelemetry GenAI 语义约定（`gen_ai.*`），本阶段不接外部导出器。
  4. 指标：P50/P95 延迟、缓存读取比例、重试次数、沙箱终止类型、孤儿进程清理数。
- **验收**：一次 M2 Requirement Brief 运行可用关联 ID 串起完整链路；日志中无 Prompt 正文，无 Secret。
- **停止条件**：日志包含 Prompt 正文或 Key。
- **需 ADR**：否。引入 OTel SDK 时需要先按 P0.5 登记依赖。

### H7 提示词缓存（待产品负责人排期）

- **现状**
  - `server/runtime/anthropicModelProvider.ts` 的 `toAnthropicRequest`（约第 89–170 行）未设置 `cache_control`，全仓库无此字段。
  - `tools` 每次按 `request.tools` 组装，并设置 `strict: true`。
  - 工具集合由 `src/agent/loop.ts` 中的 `allowedTools` 决定。
- **依据**：Anthropic 官方文档（2026-10 抓取）。缓存前缀顺序为 `tools → system → messages`，任何 tool 定义改动都会使全部缓存失效。Haiku 5.5 的最小可缓存长度为 512 tokens。
- **工作项**
  1. 确认同一 Stage 内 `allowedTools` 稳定、排序固定。测试：同一 Stage 多轮请求的 `tools` 数组逐字节相同。
  2. 在 system 与 tools 之后加入稳定块的 `cache_control`。
  3. Contract Test：请求体含预期的 `cache_control`；Stage 切换时缓存失效被记录。
  4. 成本对照：比较有无缓存的 input、cacheRead、cacheWrite 与延迟。依赖真实 Key，放入 Online Eval，不进入离线测试（P2.4）。
- **验收**：离线 Contract Test 通过；Online 对照报告存入 `docs/evidence/`。
- **停止条件**：缓存导致 Tool 权限或 Stage 边界发生变化。缓存只能优化成本，不能改变业务语义。
- **需 ADR**：否（属于 Adapter 内部改动）。

---

## P2：M3 完成后推进

### H8 路由与前端渐进拆分（P1.4、P3.1）

- **现状**：`server/index.ts` 1273 行，路由为手写 `url.pathname` 分支；`src/App.tsx` 1295 行；前端没有路由库或服务端状态库。
- **工作项**
  1. 随修改逐组拆分：每修改一个路由组，就迁入 `server/routes/<context>.ts`。`index.ts` 只保留组合根。
  2. 前端随修改拆分面板到 `src/features/<name>/`。不引入新状态库，除非有 ADR。
  3. 每次迁移前后保持 HTTP 行为不变，为被迁移路由补合同测试。
- **验收**：以 1273 行为基线，`index.ts` 行数逐步下降；每次提交后 `npm run check` 通过。
- **停止条件**：出现一次性大规模重写。
- **需 ADR**：否。

### H9 Skill 迁移为 SKILL.md（P1.9）

- **现状**：`src/agent/skills.ts` 的 `SkillRegistry` 保存内存对象（name、version、instructions）。Print 与 Manufacturing 的 Skill 分别在 `src/print/skills.ts`、`src/manufacturing/skills.ts`。
- **前置**：核对 Agent Skills 规范的许可证并登记（P0.5）。
- **工作项**
  1. 编写 ADR，定义 frontmatter 字段，以及 Packx 的治理字段（风险、权限、版本）如何表达。
  2. 实现只读的 SKILL.md 解析器，用 fixture 比对旧注册表中的 instructions。
  3. 迁移一个 Skill（建议 requirement brief）。
  4. 用固定评测比较迁移前后的结果，证明无回归（P3.3）。
- **验收**：迁移前后指令内容一致；评测无回归。
- **停止条件**：Skill 能够改变状态或权限。需要用 Policy 拦截测试证明无法做到。
- **需 ADR**：是。

---

## P3：暂缓或低优先级

### H10 数据层 Postgres / 对象存储 Port（暂缓）

- **不进入当前实现。** 前置条件：M3 完成（路线图 §4）、托管云选型 ADR。
- **允许的预备动作**（不改运行时代码）：梳理 Enterprise Store 的读写接口，检查是否能由 Port 表达，形成文档。

### H11 服务端压缩 / Context Editing（暂缓）

- 路线图 §6 暂缓"高级上下文压缩"。
- 若将来推进，先用 `eval:context-*` 建立 Baseline，再做对照。ContextSnapshot 必须记录服务端返回的压缩块，保证可追溯（P1.7）。

### H12 MCP 企业系统集成（暂缓）

- **前置**：M3 完成；选定一个只读企业系统（ERP 或报价系统）；ADR 说明边界。
- **边界**：经 Tool Gateway 接入，不把内部 Tool 直接暴露为 MCP 服务。固定协议版本（规范 2026-07-28）。工具描述按不可信内容处理（P0.3）。

### H13 UI token 级流式

- **现状**：模型侧已使用 `stream: true` 并解析 SSE。前端 SSE 目前只传 activity（`src/runtime/conversationClient.ts:109`），未找到把 text_delta 推送给界面的路径。
- **工作项**：流式内容仅作草稿展示并标记为未验证，不得成为 Fact（P0.1）。

### H14 命名兼容（`PACKX_*` 优先）

- 依据 D13：保留 `BLACKX_*` 的行为，新增 `PACKX_*` 优先读取，`BLACKX_*` 作为回退。不改 `.blackx-data/` 路径。
- **需 ADR**：是，记录配置语义。`server/index.ts:70` 已有 `PACKX_SETTINGS_PATH`，说明混用已经存在。

### H15 Eval 脚本收敛

- `package.json` 中有数十个 eval 与 knowledge 脚本。
- **工作项**：建立 case manifest、统一 runner 和报告 schema。先保留旧脚本，并提供映射表，不直接删除。

---

## 4. 禁止事项

- 不引入通用 Shell Tool 或模型可指定的任意 executable（M3 §2）。
- 不引入 Postgres、分布式 Queue、多 Agent 或 RSI（路线图 §4、§6）。
- 不把合成样例当作用户证据（D10）。
- 不在离线测试中调用真实模型（P2.4）。
- 不把沙箱资源采样表述为内核配额（M3 Slice 2）。
- 不提交本地数据与配置文件（`.packx-settings*`、`.blackx-data/`、`temp/`、`releases/`）。

## 5. 交接检查清单

- [ ] `git status` 干净，或改动已按主题分支
- [ ] `npm run check` 通过
- [ ] `npm run test:native` 通过（macOS）
- [ ] 本文档与路线图状态一致，有差异已先更新路线图
- [ ] 每项完成记录：证据链接、ADR 编号（如有）、路线图勾选
- [x] 负责人已确认为 B1ackB；其余 §6 问题仍待回复

## 6. 未决问题（需产品负责人）

1. ~~工作区 35 个改动的拆分与合并方式。~~ 已于 2026-10-14 拆分为三个提交并合并（PR #33）。
2. H7 提示词缓存是否插入近期队列。
3. H5 工具单源 Schema 是否并入 M3 Tool Contract（建议并入）。
4. H4 是否把 `events.json` 迁入单机 SQLite（需 ADR）。
5. H3 真实用户招募对象与可用资料范围。
6. ~~各工作项的负责人。~~ 已于 2026-10-14 确认为 `B1ackB`。
7. ~~永久审批规则是否实现。~~ 2026-10-14 决定保持逐次审批（见权限矩阵第 4 节）。

## 7. 参考

- 规则：[`AGENTS.md`](../../AGENTS.md)、[`architecture/principles.md`](../architecture/principles.md)
- 路线图与里程碑：[`roadmap.md`](../roadmap.md)、[`milestone-3-production-hardening.md`](../milestone-3-production-hardening.md)
- 决策：[`project-decisions.md`](../project-decisions.md)（D8、D10、D13）
- ADR：[`0008`](../adr/0008-local-native-tool-sandbox.md)、[`0009`](../adr/0009-local-document-delivery-slice.md)、[`0013`](../adr/0013-just-in-time-file-approval.md)、[`0017`](../adr/0017-local-release-settings-and-native-supervision.md)
- 依赖记录：[`dependencies.md`](../dependencies.md)
