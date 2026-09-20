# 需求单证据复核

需求单候选版本在请求审批前，由 Host 依次运行包装规则校验和独立模型复核。编排位于 `server/enterprise/evidenceReviewWorkflow.ts`，包装语义和可修订字段位于 `server/manufacturing/requirementEvidencePolicy.ts`；复用现有 AgentRuntimePort、ContextEngine、ArtifactContentStore、ProposalRunEngine 和 StageJobScheduler，不修改 Agent Core。

## 当前闭环

1. 原生成 Worker 保留模型输出 checkpoint，写入候选 Fact（仍未确认）和不可变 RequirementBrief 版本。
2. 包装规则校验检查 Schema、Fact 权威状态、必填项和 nextAction。结果与用户要求、候选版本、原始 Brief、人工字段、已选证据及附件解析快照一起交给独立 Reviewer。原始计划快照中的模型结果仍是未验证报告。
3. Reviewer 只能输出 `issues`，每项包含 `kind`、JSON 路径 `location`、`evidenceRefs`、`reason` 和 `suggestedAction`。引用必须属于此次输入；只有 `insufficient_evidence` 可以没有引用，并必须说明缺少什么。
4. Host 决定 `continue`、`revise`、`request_input` 或 `reconfirm_plan`。规则通过且复核完成、问题为空，才继续原有事实确认/审批流程。
5. 仅遗漏/无依据的文字表述问题，且全部位于 title、customerGoal、assumptions，才允许一次自动修订。修订模型只能返回这三个字段，Host 只接受问题定位覆盖的字段/数组项变化；额外字段、无关位置修改、Fact 修改或无效输出直接拒绝。Host 生成新 Artifact 版本，再次执行规则校验和独立复核。第二次仍有问题则停止。
6. Fact 问题、来源冲突、证据不足转 `needs_input`，Evaluation 保持 `passed=false`。范围变化转人工重新规划和确认后再次导入，Reviewer 不执行计划或写入计划确认。任何通过都不代替人工 Fact 确认和具体版本审批。

## 持久化、恢复及预算

- 每个候选版本保存 review-input（实际输入快照）、review-call（Runtime 结果）、review（结构化报告）和原有 evaluation；报告绑定 Artifact ID/版本、全部输入 Fact 版本、证据版本和输入摘要。
- 单次自动修订另存 revision-call，新版本通过现有 runtime.execution.linked、artifact.version_created、evaluation.completed 和 stage/approval 事件审计。原版本及报告不覆盖。
- 所有读写使用原租户、工作区、Run 边界。每次异步返回和持久化之前复查租约、取消状态、Fact 版本、知识证据有效性和附件摘要。
- 每次 Runtime Turn 先写不可变调用意图，最多两个复核 Turn 和一个修订 Turn；每 Turn 一个 Agent iteration、24,000 输入 Token、60 秒超时。工具白名单为空（现有 Runtime 的数值型工具上限最小为 1，但不授权任何工具）。沿用 Runtime 的模型重试与预算检查，不新增工具重试或副作用执行。
- 已保存结果直接复用。若进程在发起模型调用后、结果持久化前崩溃，恢复报告 `interrupted_review` 并请求人工处理，不自动重复购买不确定的调用。租约丢失或取消后的迟到响应不能推进审批。基础设施写入失败保留原队列恢复行为。
- 每个失败报告保留分类；模型失败、超时、预算失败、暂停结果、无快照、无效 JSON/引用、降级 Adapter 或工具调用均不能放行。复核/修订用量和延迟计入需求单指标，成本仍遵守原有未配置价格时显示未知的规则。

## 固定离线对照

运行 `npx vitest run server/enterprise/evidenceReviewWorkflow.test.ts`。

固定候选覆盖要求遗漏、无依据认证、数量矛盾、正确表述以及 Reviewer 漏检。两组均使用同一候选、原始要求和规则：Baseline 只运行确定性校验；候选流程加入固定脚本 Reviewer。该对照展示旧规则会接受结构正确的语义问题，而新流程能阻止脚本报告的问题；同时明确验证 Reviewer 漏报时 Host 无法可靠推断语义遗漏。另有误改 Fact/权限、无效引用、失败/预算、二次复核停止、取消、租户隔离、来源失效、持久化及事件边界恢复测试。

这些是**离线编排与权限边界证据**，不是模型准确率、召回率或业务质量收益。FakeAgentRuntime、M2、知识库和产品 Smoke 的空问题输出是显式 fixture，生产 fallback 仍为无效输出 `{}`，不会按通过处理。真实模型对照尚未运行，也没有付费调用；后续需经授权在同模型、同任务及可比预算下评估漏检、误报、误改和 Token/延迟增量。

## 有意保留的限制

- 本次自动修订只改三个文字字段；即使是未确认 Fact 的修改也交给用户，保留原有事实来源链。
- 文本附件提供有长度标记的摘录；PDF/Office 使用已有解析页。图片、未 OCR 扫描件和缺失全文只有元数据可用，不能据此声称已经核对内容，应请求原始证据或人工补充。本次没有新增视觉/OCR 工具。
- 来源引用存在和版本绑定不证明语义蕴含。真实模型仍可能漏检、误报，或在文字里作出错误修订；二次复核和人工审批仍必需。
- 不增加常驻监督 Agent、多轮反思、长期反思记忆、自动重新规划或新依赖。
