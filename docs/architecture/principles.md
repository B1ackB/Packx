# Packx 架构原则

本文解释根目录 [`AGENTS.md`](../../AGENTS.md) 中优先级约束的设计目的，并作为架构评审和里程碑验收依据。

## 1. 产品边界

Packx 不是通用聊天机器人，也不是外部 Harness 的印刷换皮。它是一个拥有自研 Agent Core、面向企业交付物的多模态长任务系统。

```text
Packx Product
├── Business UI / API
├── Durable Workflow
├── Artifact Graph
├── Approval
├── Evaluation
├── Event Store
├── Policy / Tenant / Audit
├── Context Providers
├── Runtime Ports
└── Domain Packs
    └── Packx Print

Packx Agent Core
├── Session / Turn / Agent Loop
├── Model Client / Streaming
├── Hook / Tool Protocol
├── Context / Compact
├── Session Store
└── Skill / Configuration
```

M2 当前产品闭环收敛为包装售前需求澄清：面向包装企业的售前/跟单人员，把客户 Brief 转为可确认、可版本化、可审批的 `RequirementBrief`。Packx Print 承载包装 Domain Pack，内部保留 `industry=print` 以兼容已有包装数据；家具行业已退出当前产品范围。见 [ADR-0010](../adr/0010-packaging-product-focus.md)。

Agent Core 保持行业无关：它只执行一次受限 Agent Turn，不拥有企业 Workflow，也不包含印刷业务条件分支。

外部参考：

- [OpenAI Codex 官方仓库](https://github.com/openai/codex)：仅用于公开行为、测试和失败场景对照，不作为运行时依赖。
- `temp/claude-code-best/`：只作为 Claude Code 机制对照和失败场景参考，不作为生产代码来源。

## 2. 核心设计原则

### 2.1 Artifact-first

用户购买的是结果和流程可信度，而不是聊天轮数。所有重要输出都必须形成 Artifact。以下是已有 Print Domain Pack 的示例，不限制其他产品 Artifact：

```text
CustomerBrief
PrintSpec
SolutionProposal
CreativeBrief
Artwork
Mockup
PrintReadyPDF
PreflightReport
ProposalWebpage
```

Artifact 必须版本化，并记录输入事实、上游 Artifact、生成模型、执行工具、审批和评测。

### 2.2 Truth before generation

事实层与生成层严格分离：

```text
权威层：Verified Facts、Policies、Approvals、Production Layout Template、Output Profile
生成层：Proposal、Copy、Creative、Image、Page
```

生成内容只能引用权威层，不能反向覆盖权威层。

### 2.3 Deterministic enterprise shell around Agent Core

业务流程由确定性状态机包围自主 Agent：

```text
确定性 Intake
→ 自主 Proposal Agent
→ 确定性 Schema/Evaluation
→ 人工审批
→ 自主 Creative Agent
→ 确定性 Layout/Preflight
→ 人工审批
→ 确定性 Export/Publish
```

这种结构允许 Agent Core 和模型处理阶段内的开放问题，同时确保企业流程、权限和生产标准不漂移。

### 2.4 Durable by default

长任务必须假设进程、网络和供应商会失败。Run 的真实状态由持久化事件和 Artifact 构成：

```text
RunCreated
StageStarted
ModelRequested
ToolRequested
ToolCompleted
ArtifactCreated
EvaluationCompleted
ApprovalRequested
ApprovalResolved
StageCompleted
RunCompleted
```

Checkpoint 是事件流的性能优化，不替代 Event Store。

### 2.5 Context is a compiled view

Context 不是数据库，也不是完整历史；它是 ContextEngine 针对某次模型调用编译出的有限视图。

```text
系统策略
+ 当前 Domain Pack
+ 权威事实引用
+ 当前 Workflow Stage
+ 相关 Artifact 摘要
+ 工作记忆
+ 当前允许的 Tool
= 本轮模型上下文
```

权威事实从数据源重新加载，大文件通过 Artifact 引用，历史过程通过 Snapshot 压缩。

工作记忆、原始对话、权威业务状态和跨任务知识具有不同的作用范围与确认边界。存入摘要或向量索引不会改变其权限、事实状态或适用范围；当前个人跨会话记忆实现及经验的后续边界见 [记忆系统](../memory-system.md)。

## 3. 关键运行边界

### 3.1 RunEngine

负责：

- Run 和 Stage 状态机
- Workflow 推进
- 审批暂停和恢复
- 全局预算
- 完成证据
- 事件持久化

不负责：

- 具体模型协议
- Tool 业务实现
- Prompt 内容拼装
- Artifact 二进制存储

### 3.2 AgentRuntimePort

负责：

- 向 RunEngine 暴露稳定、厂商中立的阶段执行接口
- 映射 Packx Agent Session、Turn、事件和终止原因
- 映射 Tool Call、权限请求、使用量和错误
- 支持启动、继续、恢复、中断和取消
- 隔离 Model Provider 协议与厂商消息类型
- 提供用于离线测试的 Fake Runtime

Packx Agent Core 负责 Agent Loop、模型调用、Hook、Tool 协议和基础上下文管理，但不负责判断整个商品项目是否完成，也不拥有 Packx 的业务状态。

Agent Session ID 只是 Runtime Resume Handle。Run、Stage、Approval、Artifact 和 Event Store 仍由 Enterprise Layer 持久化；恢复任务时必须先恢复业务状态，再决定是否恢复或新建 Agent Session。

### 3.3 ContextEngine

负责：

- Token 预算
- 稳定与动态上下文排序
- Tool Schema 选择
- 大结果外置
- 旧结果清理
- Stage/Run Snapshot
- 压缩记录与质量评测

Enterprise Layer 从 Session、Event Store 投影、Fact、Artifact 和来源存储构建任务上下文，经 AgentRuntimePort 传给 Runtime。Core ContextEngine 只负责通用上下文编排与压缩，不拥有业务状态或租户授权；持久化、来源校验和业务快照由 Enterprise / Host Adapter 配合完成。Compact 只能优化模型上下文，不能成为 Fact、Artifact、Approval 或 Workflow 状态的唯一存储。

### 3.4 Fact lifecycle

Enterprise Layer 将 Fact 保存为字段级、版本化状态：每个 Fact 必须具有稳定 Key、标量 Value、可选 Unit、`suggested | unverified | verified | rejected` 状态、来源引用、记录 Actor 与时间。模型输出和普通用户输入只能形成候选；只有企业权威来源或显式人工确认可以产生 `verified`，拒绝也必须形成新的 Fact Version，而不是覆盖旧值。

Artifact 精确记录所消费的 Fact Version。Fact 新增、改值或确认状态变化后，只使依赖旧输入的 Artifact 变为 `stale`，并使绑定该 Artifact Version 的 Approval 失效。Fact 写入与 Worker 执行互斥，避免模型在不一致输入上提交 Artifact。

具体产品负责定义允许的 Fact Key、类型、必填规则和自动抽取 Schema；在产品 Schema 确定前，Enterprise Layer 不允许模型自由创造 `verified` 字段。

### 3.5 ToolRunner

负责：

- Schema 校验
- Policy 与 Approval
- 幂等查询
- 超时、取消和重试
- 并发控制
- 大结果外置
- Tool Event 与 Trace

这里的 ToolRunner 是 Packx 的企业 Tool Gateway。Agent Core 产生 Tool Call，Gateway 再执行 Domain Tool、企业权限、审批、幂等和审计；不得让通用 Shell Tool 绕过 Gateway 完成主要业务副作用。

### 3.6 ArtifactService

负责：

- Artifact 与 Version
- 二进制和元数据
- Lineage 与 Dependency Graph
- `stale` 传播
- Approval 失效
- Signed URL 和访问控制

## 4. Enterprise Layer 与 Print Domain Pack 的边界

### Enterprise Layer 可以知道

- Fact 具有状态和来源
- Artifact 具有类型、版本和依赖
- Workflow 具有 Stage 和 Gate
- Evaluator 可以产生问题和证据
- Tool 具有风险、Schema 和副作用

### Enterprise Layer 不得知道

- 何为 PDF/X-4
- 何为局部 UV
- 何为刀线或压痕线
- 应使用哪个 ICC Profile
- 包装报价如何计算

### Print Domain Pack 负责

- `PrintProductSpec`
- 印刷材料和工艺 Schema
- 权威结构/生产版式模板 Artifact
- 包装 Workflow
- PDF、色彩和 Preflight Tool
- 印刷规则 Evaluator
- 报价输入与企业系统 Adapter

Agent Core 比 Packx Enterprise Layer 的边界更低：它只需要知道 Session、Turn、Message、Hook、Tool、Permission 和 Context，不应知道 Project、PrintProductSpec、Approval Gate 或 Artifact Lineage。

## 5. 自研 Agent Core 演进策略

### 5.1 采用阶梯

任何需求按以下顺序寻找落点：

```text
删除需求或标准库
→ Instructions / Skill / Tool
→ Packx Port / Adapter / Hook / Context Policy
→ 固定版本的 Model Provider 协议
→ 带 ADR 的通用 Agent Core 扩展
```

前一层能够满足需求时，不进入后一层。印刷 Tool、企业 API、Workflow Stage、Artifact 和审批逻辑都应在 Enterprise Layer 或 Domain Pack 中完成。

### 5.2 Core 验证阶段

自研 Core 必须用固定离线测试验证：

- Session 启动、继续和恢复
- Agent Loop 终止与最大轮次
- Hook 顺序和失败传播
- Tool Schema、权限和超时
- 中断、取消和超时
- Skill 装载、Context 构建与 Compact

“模型返回文本”不是 Agent Core 完成。必须用固定任务评测事实遵循、Tool 选择、Hook 顺序、Compact 完整性、Artifact 输出、恢复和成本。

### 5.3 Core 扩展准入条件

只有同时满足以下条件才能扩展 Agent Core：

1. 需求是行业无关的 Harness 能力，而不是印刷业务逻辑。
2. 配置、Skill、Tool、Hook 和外部 Adapter 均无法满足。
3. 已通过 ADR 记录缺口、替代方案、风险和退出条件。
4. 变更可以独立测试，并且不破坏 AgentRuntimePort Contract。
5. 已定义迁移和移除该扩展的方法。

适合成为 Core 扩展的候选包括通用 Context Hook、Tool Policy Hook、Checkpoint Adapter、审计 Event Sink 和恢复协议。改变商品流程、增加印刷规则、修改业务 Prompt 不属于 Core 扩展理由。

### 5.4 Core 维护

- Core 版本与 Provider Adapter 版本进入依赖和运行证据。
- Core 变更与 Domain Pack 功能分开评审。
- 每次变更运行 Runtime Contract、权限、恢复、Context 和固定 Harness Eval。
- 持续记录 Loop、Hook、Compact 和 Tool Policy 的行为变化。

## 6. AI 与确定性程序的边界

| 能力 | AI | 确定性程序 | 人工 |
| --- | ---: | ---: | ---: |
| 需求理解 | 主 | 辅助校验 | 确认 |
| 创意方向 | 主 | 结构化 | 选择 |
| 文案 | 主 | 事实与禁用词检查 | 审批 |
| 背景视觉 | 主 | 尺寸和文件处理 | 选择 |
| Logo/条码/法定文字 | 否 | 主 | 审批 |
| 权威刀模/生产版式模板 | 否 | 读取和校验 | 专业人员或权威系统提供 |
| PDF/X 与出血 | 否 | 主 | 复核 |
| Preflight | 辅助解释 | 主 | 最终确认 |
| 提交生产 | 否 | 受控执行 | 必须审批 |

## 7. 首个 Workflow

```text
Intake
  → 结构化客户需求与缺失项

Proposal
  → 材料、工艺、定位和风险方案

Approval A
  → 员工确认事实与方案

Creative Production
  → 文案、视觉方向、Artwork、Mockup

Print Layout
  → 基于权威刀模或生产版式模板确定性排版

Preflight
  → PDF/X、尺寸、出血、字体、分辨率、色彩和专色检查

Repair Loop
  → 有限次数修复；不可自动修复的问题转人工

Approval B
  → 确认电子样和生产文件版本

Delivery
  → 输出生产包、报告和客户提案网页
```

## 8. 质量门槛

每个 Stage 必须声明：

- 输入 Artifact 类型
- 输出 Artifact 类型
- 权威 Fact 要求
- 允许 Tool
- Token、费用和轮数预算
- Deterministic Evaluator
- Model Evaluator（如需要）
- 最大 Repair 次数
- 人工审批要求
- 完成证据

一个 Stage 只有在输出存在、Schema 通过、必需评测通过且审批完成后才能进入 `passed`。

包装需求单的最小证据复核与单次修订流程见 [需求单证据复核](../requirement-evidence-review.md)。

## 9. 评测原则

评测优先级：

```text
确定性检查
> 业务规则
> 人工评审
> 校准后的模型 Judge
> 模型自评
```

Harness 改动采用固定任务、固定模型和固定预算进行对照。至少记录：

- 任务成功率
- 权威事实冲突数
- Artifact 一致性
- 中断恢复率
- 重复 Tool 调用率
- Token 与成本
- P50/P95 延迟
- 人工修改次数
- 首次审批通过率
- Agent Core 行为回归数
- Provider Adapter Contract 失败数

## 10. 实施顺序

按纵向切片推进：

1. 固定 AgentRuntimePort、ModelProviderPort 和 Runtime Baseline Test。
2. 实现最小 Agent Loop、Hook、Context、Skill、Compact 和 Fake Runtime。
3. 打通 Session 启动、继续、恢复、Tool 和事件映射。
4. 实现 Event Store、状态机和可恢复 RunEngine。
5. 实现 ContextEngine、Fact、Artifact、Version 和 Approval。
6. 用行业无关 Fixture 完成 Durable Single-Agent Runtime Gate。
7. 冻结首个真实用户任务、最小 Tool、Fact、Artifact 和 Evaluator。
8. 打通 M2 的 UI → Runtime → Tool → Artifact → Evaluation → Approval/Delivery。
9. 完成 Tenant、RBAC、Audit、生产存储与部署能力。
10. 仅在稳定 Baseline 上以隔离 Eval、审批和回滚方式实验 RSI。

每个阶段都应产生一个可运行、可测试、可观察的端到端切片。

## 11. 架构评审问题

任何重要设计必须回答：

1. 它解决哪个企业工作环节？
2. 它属于 Agent Core、Packx Enterprise Layer 还是 Domain Pack？
3. 权威事实来自哪里？
4. 模型失败、进程崩溃或任务重复投递后如何恢复？
5. 外部副作用如何幂等和审批？
6. 交付物如何版本化、追溯和失效？
7. 如何测试和评测收益？
8. 是否造成模型、厂商、行业或基础设施锁定？
9. 如何观察成本、延迟和失败？
10. 企业为什么可以相信最终结果？
11. 是否能通过配置、Skill、MCP、SDK、App Server 或 Adapter 完成？
12. 如果扩展 Agent Core，如何测试、迁移和退出该扩展？


### 个人跨会话记忆边界（ADR-0026）

当前仅实现同工作区当前用户明确确认的个人偏好/笔记；Enterprise 管主体、来源、版本、确认、有效期和撤回，Core 只接收通用 `historyBinding` 做上下文失效。记忆不提升 Fact、不授予权限；客户/组织共享和自动经验学习未实现。参见 [ADR-0026](../adr/0026-confirmed-personal-memory-and-context-dependency.md) 和 [完整导图](../memory-system.md)。
