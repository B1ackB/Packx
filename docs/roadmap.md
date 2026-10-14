# Packx 产品路线图

状态：M0–M2 Engineering Baselines Frozen / M2 Real-user Validation Debt Open
更新日期：2026-09-13

项目现名 Packx（原 Blackx）。开发者展示与参与计划见[开发者参与指南](developer-community-guide.md)；该计划不改变以下产品 Gate，也不代表已完成外部贡献者或真实用户验证。

本文把 [`architecture/principles.md`](architecture/principles.md) 的架构方向转成可执行顺序。路线图以完成证据为准，不以代码量或模型能够演示为准。

## 1. 当前判断

Packx 已建立 M0 自研 Agent Core、M1 Durable Runtime 和 M2 需求澄清工程链路。当前产品收敛为包装行业，把包装客户 Brief 转成可确认、可版本化、可审批的 Requirement Brief；包装固定评测已替换旧跨行业基线，真实包装目标用户验证仍待完成。

2026-09-05 已落实一轮四项产品工作：执行与本机访问边界、真实附件 Sandbox Tool、会话/需求单 UI、来源与版本导出。正式 macOS PDF 链路和固定 HTTP 产品验收已通过；[证据与剩余边界](evidence/local-product-slice-2026-09-05.md)单独记录，不代表 M3 全部 Gate 或真实用户价值验证通过。

Print Proposal 已证明 Enterprise Kernel 可以承载一个领域纵向切片，并继续作为 Print Domain Pack 的参考实现和回归资产；它不再定义通用 M1/M2 的产品方向。新的具体产品想法在 M2 Scope Gate 冻结，在此之前不继续扩展包装功能，也不实现 RSI。

近期只解决两个问题：

1. 单 Agent 长任务能否在排队、分片、暂停、重试、崩溃和重复投递后保持唯一、可恢复的业务状态。
2. 在不把合成样例冒充用户证据的前提下，补全 M3 安全加固并取得真实用户价值证据。

## 2. 当前产品边界

Agent Core 和 M1 保持行业无关。M2 聚焦包装售前需求澄清，以 `requirement-brief.v1` 作为 Artifact；包装字段与能力通过 Print Domain Pack 接入，内部标识保留 `print`。范围决定见 [ADR-0010](adr/0010-packaging-product-focus.md)。

Print 保留为一个可选 Domain Pack。封口袋标准、Proposal、视觉和印前内容不删除，但不再阻塞通用 Runtime 或新产品里程碑。无论采用哪个领域，模型都不能创造权威事实、绕过审批或把生成内容直接标记为生产就绪。

## 3. 采用策略

Packx 应用层和 Agent Core 采用 TypeScript。Harness 基线是项目自研的最小 Agent Core，通过 `AgentRuntimePort` 与 Enterprise Layer 隔离；不使用 Codex SDK，也不复制外部 Harness 源码。Core 只实现已由固定 Contract/Eval 证明必要的行业无关能力。

Online Eval 使用 API Key。模型能力通过 `AgentModelProvider` 接入，首个 Online Adapter 直接调用 Anthropic Messages compatible endpoint。Packx 不对外暴露 Anthropic-compatible API，Provider DTO 不进入 Agent Loop 以外的业务层。

执行顺序：

```text
Packx AgentRuntimePort
→ Self-owned Agent Loop
→ AgentModelProvider
→ Anthropic Messages Adapter
→ 固定 Contract Test 与行业无关 Runtime Eval
→ 识别真实缺口
→ 必要时增加 Port/Hook/Context Provider
→ Core 关键扩展才进入 ADR
```

不得在 Agent Core 中为任何 Workflow、Artifact、审批、领域 Tool 或业务 Prompt 增加条件分支。

## 4. 里程碑

### M0：Packx Agent Core Baseline

目标：证明自研最小 Core 可以通过稳定 Port 重复执行、留证和恢复，而不是只完成一次模型 Demo。

主要交付物：

- `AgentRuntimePort`、顺序 Loop、观察型 Hook、Context、Skill、摘要 Compact，以及受 Approval/Audit 控制的强类型 Tool
- Session/ContextSnapshot Store Port、内存 Fake 与本地文件 Adapter
- Fake Model、Anthropic Model Provider 和统一错误/Usage/Event 映射
- Session 恢复、并发冲突、中断、超时、ContextSnapshot 和固定包装任务测试
- Baseline 报告与 Core 复杂度准入清单

详细验收见 [`milestone-0-agent-core.md`](milestone-0-agent-core.md)。

### M1：Durable Single-Agent Runtime

目标：证明行业无关的单 Agent 长任务可以排队、分片执行、持久恢复、重试、取消和审计，且业务状态不依赖聊天历史或单次进程。

M1 使用单机持久化、SQLite Queue 和行业无关固定 Fixture。多主机分布式基础设施不是 M1 完成条件。

详细验收见 [`milestone-1-durable-runtime.md`](milestone-1-durable-runtime.md)。原 Print Proposal 实现证据保留在 [`milestone-1-proposal-slice.md`](milestone-1-proposal-slice.md)。

### M2：首个真实产品纵向闭环

目标：确定一个用户、一项真实任务、一组最小 Tool、一个可交付 Artifact 和一个可重复 Evaluator，并从 UI 贯通输入、执行、恢复、确认和交付。

工程状态：正式闭环采用 `Requirement Brief`；当前 10 个固定包装任务覆盖通过、缺失和待确认路径。此前 6 个跨行业合成售前样例保持历史证据，不能替代当前包装目标用户走查。真实用户可用性与价值仍为显式 Validation Debt。

详细验收见 [`milestone-2-product-slice.md`](milestone-2-product-slice.md)。

### M3：Local Product Hardening

目标：在 M2 工程基线冻结后，把 Packx 交付为 Claude Code/Codex 风格的本地 Agent：Agent Loop 在用户设备的受信 Host 中运行，外部 Tool/Command 子进程通过原生 OS Sandbox 隔离，并补全权限、Approval、Secret、备份恢复、迁移、监控和本地发行能力。M3 技术加固可以与真实用户补验并行，但在取得用户证据前不得把加固结果表述为产品价值证明。

M3 首个正式平台为 macOS，复用系统 Seatbelt，不要求 Docker 或额外机器；Linux/WSL2 后续通过同一 Port 接入 bubblewrap + seccomp。托管云、多租户 Runner、gVisor、Kubernetes 和 MicroVM 延后到出现明确云端需求后另立 ADR，不作为本地 M3 完成条件。

M3 的 G0–G6、安全边界、Native Tool Sandbox Contract 与完成证据见 [`milestone-3-production-hardening.md`](milestone-3-production-hardening.md)。当前 `sandboxMode` 仅是 Tool 权限条件，不代表 OS 隔离；目标是 Host 先完成 Policy/Approval，再以固定 executable、argv、路径、网络和环境白名单启动短生命周期 Sandbox 子进程。架构决定见 [`ADR-0008`](adr/0008-local-native-tool-sandbox.md)。

### M4：受控 RSI 实验

目标：允许上层 RSI Controller 提议候选改动，但只能在隔离环境中执行固定 Eval，并经过审批、Canary 和可回滚发布。

RSI 不得修改自己的权限、安全策略、预算、审批要求或基准 Eval；在 M3 未完成且 M2 真实用户验证债务未关闭前不进入实现。

## 5. 近期执行队列

2026-09-13：产品负责人授权本次会话按[本地产品补全工作单](local-product-completion.md)推进 Plan 到需求单、包装交接字段、模拟验收、首次使用和备份恢复。当前缺少真实员工、素材与企业环境，真实用户验证保持待补；模拟验收不能替代。以下安全工作仍按风险和相应 Gate 执行。

M0–M2 工程基线已经关闭，近期队列转向必要的本地产品安全与补验：

| 顺序 | 工作包 | 产出 | 完成证据 |
| --- | --- | --- | --- |
| 1 | M3 Native Tool Sandbox Gate | macOS Seatbelt Adapter、Tool Contract 与权限审批 | 路径、网络、环境、超时、子进程和逃逸回归通过 |
| 2 | Local Permission 与 Secret | Workspace 身份、Tool 权限、Approval 和 Secret 边界 | 权限矩阵、越界回归、fail-closed 和日志脱敏通过 |
| 3 | 本地存储与恢复 | Schema Migration、备份和恢复方案 | 升级、备份恢复和故障注入通过 |
| 4 | 包装真实用户补验 | 包装售前与跟单目标用户完成真实包装任务 | 明确记录可交付判断、错误、耗时和返工反馈 |
| 5 | Event Store 切换与队列崩溃注入 | 迁移到 SQLite 已验证（ADR-0031）；切换需确认；stage-jobs 队列的崩溃注入与恢复测试排期 2026-10-21 起 | 切换前明确是否接受单向切换；队列五类崩溃与重复投递测试通过 |

任何工作包若没有完成证据，不得仅以“已有界面”或“模型跑通”标记完成。

## 6. 暂缓事项

2026-09-13：产品负责人要求优先实现 Plan 与确认后的有界子 Agent。当前仅开放 1–4 个独立任务的顺序派发、版本确认和恢复，见 [ADR-0015](adr/0015-confirmed-plans-and-bounded-subagents.md)。该例外不开放下面的通用多 Agent/Reviewer/并行能力；固定评测只证明确认和隔离行为，真实模型收益仍待验证。

以下内容在 M3 本地权限、隔离与恢复 Gate 完成且 M2 真实用户验证债务关闭前不进入实现队列：

- 多 Provider 路由与外部 Harness Fork
- 通用多 Agent 编排、嵌套子 Agent、并行执行和 Reviewer Agent
- 通用插件市场
- 多主机分布式 Queue 和自研分布式存储
- 自动发布高风险外部副作用
- 高级上下文压缩、模型路由和并行优化
- RSI、自我修改和自动发布候选代码

## 7. 关键决策点

已确认：

1. Packx 应用层采用 TypeScript。
2. M0 Harness 基线为 Packx 自研最小 Agent Core，不采用 Codex SDK。
3. Online Runtime 使用 API Key，并支持 Anthropic Messages 协议兼容路径。
4. M1/M2 采用行业无关 Runtime 和首个真实产品闭环；Print 保留为 Domain Pack 和回归资产。
5. RSI 位于 Harness 上层，必须晚于稳定产品 Baseline 和不可由候选修改的安全控制面。
6. Node.js 24.14.0 和 npm 已在 `.nvmrc`、`package.json`、`package-lock.json` 固定运行基线；构建依赖以 lockfile 为准。

仍需确认：

1. 未来托管云的 PostgreSQL、对象存储、Queue 与 Sandbox Runner 组合；本地 M3 不提前选择。
2. DeepSeek Online Eval 的固定模型、预算和基准保存格式。

技术栈、持久化和部署选择一旦影响 P1 分层或形成长期锁定，应新增 ADR；普通可逆实现选择记录在对应里程碑 Decision Log。

## 8. 风险与退出条件

| 风险 | 近期控制 | 退出/升级条件 |
| --- | --- | --- |
| 自研 Core 对长任务支撑不足 | 固定 Runtime Contract、行业无关 Eval 与 Crash 回归 | 达不到门槛时保留 Port，替换具体 Core 或模型，不污染产品层 |
| Agent Session 被误当作 Workflow 状态 | Run/Stage/Event 独立持久化 | 恢复测试无法仅靠业务事件完成时停止 M1 |
| 模型创造产品事实 | Fact 状态与来源校验 | 未验证事实进入已审批交付物即阻断 Stage |
| 过早扩展 Core | Provider-first Gate 与 Ponytail/YAGNI Review | 只有可复现的行业无关缺口和固定 Eval 收益才允许 ADR |
| Anthropic 协议差异 | 独立 Provider Adapter 与 Contract Test | 关键 Tool/Usage 语义无法保真时停止接入并评估替代 Provider |
| 先建分布式平台、没有产品闭环 | M1/M2 单机持久化，真实用户验证独立补验 | 没有多主机或容量证据时停止基础设施扩张 |
| RSI 优化自身评分而非真实能力 | 固定不可变 Eval、隔离执行、人工审批和回滚 | M3 未完成、真实用户验证债务未关闭或无 Baseline 时禁止启用 RSI |

## 9. 路线图更新规则

- 每个里程碑完成时更新状态、证据链接、未解决风险和实际成本。
- 新复杂度必须附 Baseline 对比或明确的合规/可靠性必要性。
- 需求改变首个品类、审批责任、发布权限或生产边界时，先更新路线图和相关 ADR，再进入实现。

## 10. 协议参考

Anthropic Messages 的具体版本、Tool、认证和错误语义以目标 Provider 的官方协议文档为准；接入时必须固定版本并保存 Online Contract 证据。外部 Harness 只用于行为与失败场景研究，不进入生产源码。
