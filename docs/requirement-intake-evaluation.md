# 包装需求整理：任务级评测

本评测衡量从客户资料到可核对需求单的完整任务。固定输入见 [16 个案例与评分协议](../eval/fixtures/requirement-intake-v1/README.md)。首批使用 12 个开发案例；4 个预留案例留到改进确定后。合成案例和辅助评审不代表真实客户成功率。

没有人工评审时的后续协议、对照设计和可靠性证据缺口见 [自动任务评测计划](task-evaluation-plan.md)。`npm run eval:requirement-intake-audit -- --report <report.json 或 report.json.gz>` 只读统计旧报告中的确定性检查、复核依赖和缺失检查点；不会重判旧输出、绕过审批或发起模型请求。

## 执行范围

执行路径：按事件投递对话/文字附件 → 真实 `RequirementBriefWorker` → `BlackxAgentRuntime` 与项目来源读取工具 → 持久化 Fact/Artifact/Evaluation → 确认或审批 → 下一轮来源与版本核对。使用现有队列、Outbox、文件事件库、Artifact 库与 Session 库，每个案例独立作用域和数据目录。首轮基线冻结当时的生产 Skill、Prompt、复核器与 Core；后续修复使用独立 trial 和代码哈希，不改写旧结果。

模型只接触已到达的来源、共享任务、当前请求和实际 Host 状态；oracle、案例目的、未来事件和其他订单不能进入请求。初始只写入行业与原始客户资料，不能预填七个答案字段。模拟员工确认必须匹配已观测候选；措辞差异先留待复核，不能凭人工事件补出模型漏掉的值。模型没有发送、报价、生产提交或批准权限。

当前附件素材为独立编写的文字和元数据；走实际文字附件存储/读取入口，没有 PDF、图片、OCR、UI 或 HTTP 端到端证据。每个检查点由生产 Outbox 开启一个阶段 Session，连续性依赖持久化 Host 状态，不能称为一条不中断的长模型会话。首轮 RI-11 因缺少逐附件撤回入口而停止。修复后的 v3 接入实际附件撤回、字段版本失效和审批失效流程，原 blob 与旧交付版本保留。

## 运行

默认只展示计划，不联网：

```sh
npm run eval:requirement-intake
npm exec vitest run eval/requirementIntakeFixtures.test.ts eval/requirementIntake.test.ts
npm exec tsc -- --noEmit -p tsconfig.server.json
```

获得本批费用授权后，指定一个尚不存在的目录和费用预留上限：

```sh
npm run eval:requirement-intake -- --online --directory /private/tmp/packx-intake-baseline-v1 --usd-limit 20
```

`--cases RI-01,RI-02` 可用于预先确定的子集；它不是挑选通过样本的入口。预留案例必须同时显式传 `--include-holdout` 和案例列表。本轮费用表只验证了 DeepSeek 官方兼容端点的 Flash；其他模型需先增加其经核实的费用配置，不能套用低价估算。使用现有本地模型设置，不输出密钥。

报告保存固定输入哈希、代码与依赖文件哈希、Git commit、实际上下文设置、模型别名、每次请求/响应/usage、Artifact、版本断言、来源映射、运行事件和各项判定。模型别名不保证服务方权重永远不变。`report.json` 是主记录，案例目录保留实际持久化业务状态，`pending-reviews.json` 是待复核清单。

限制为每案例最多 32 次生成、160 次计数、每阶段每片 8 轮/16 次工具、最多 2 片、案例执行片段 10 分钟；生产阶段为 120 秒；基线和 v3 的复核为 60 秒，v4 起因实际复核超时增至 120 秒（属处理条件变化）。输入上限 100,000 Token，v2 评测的输出上限为 16,384 Token（仅修改评测配置）；总美元上限按每次实际计数与输出上限逐次预留，忽略缓存折扣，预留不退还。usage 费用是按公开峰值单价计算的估算，不是账单；reasoning Token 包含在输出内，不重复收费计算。

模型或计数请求发送前先持久化 `started`。无确定结果时保存 `unknown` 并停止本批，不自动重发。进程崩溃留下 `runner.lock`、`running` 或 `started` 时普通续跑会拒绝；必须先核查原记录，不得删除后伪装成未调用。费用预留是客户端上界控制，不能替代服务商账单和硬限额。

## 评分与续跑

确定性检查覆盖结构、当前字段、单位、确认状态、有效来源、缺失集合、版本增长、旧内容不可变、旧 Artifact 失效及审批绑定。Schema 的 `approvalEligible` 与当前业务允许审批分别评分。候选引用被生产 Worker 改写为 `runtime:...` 时，仅通过已持久化的原候选及当时来源映射回溯，不从答案反推来源。

措辞等价、澄清主题、限制保留、额外字段与禁止声明保持 `needs_review`。复核者须阅读该检查点完整来源、需求单和必要轨迹，逐项填写 `caseId/checkpointId/captureSha256/checkId/decision/reviewer/method/reason/evidence`。只支持 `human` 或明确披露的 `codex_assisted`；后者不能当作人工专家、独立 Judge 或盲测。无法确定就保持待复核。模型自己生成的证据复核属于被测工作流，不能代替外部评分。

```sh
# 只导入评审；没有模型调用
npm run eval:requirement-intake -- --review-only --directory /private/tmp/packx-intake-baseline-v1 --reviews /private/tmp/intake-reviews.json

# 仅从已知的评审等待点继续；仍使用原批次费用上限
npm run eval:requirement-intake -- --online --resume --directory /private/tmp/packx-intake-baseline-v1 --usd-limit 20
```

评审记录不可覆盖确定性失败，也不能改写已保存输出。输入、运行代码、模型、案例选择、上下文参数或费用上限变化会拒绝普通续跑。已失败/中断案例不会自动重试；新 trial 必须使用新目录并与原结果并列。

任务通过率以已开始的全部案例为分母，必须全部检查点与转换通过；待评审、失败、超时、未知都不能从分母排除。检查点通过率、字段准确性、交接就绪率仅作补充。延迟排除人工等待、包含工具与生产复核；同时记录模型、工具、压缩、模拟人工动作和 Token。没有实际压缩事件不能宣称 Compact 有效；单一当前版本的结果也不能宣称 Harness 改进带来收益，之后需固定条件对照。

## 当前验证状态

首轮真实模型评测已完成，见 [2026-09-25 基线报告](evidence/requirement-intake-baseline-2026-09-25.md) 和 [原始证据清单](evidence/requirement-intake-2026-09-25/manifest.json)。12 个开发案例严格通过 0/12；31 个计划检查点实际到达 24 个、其中 8 个通过。报告披露 RI-10 的评分器假阴性、提前阻塞的阶段、3 个本批未知请求与 1 个初始未知请求。4 个预留案例未运行。重复候选评分问题已通过 [v3 协议](../eval/fixtures/requirement-intake-v1/scoring-v3.md) 修正；[旧结果重算记录](evidence/requirement-intake-repairs-2026-09-25/baseline-rescored.json) 只改变 RI-10 的一个来源检查，得到 0/12 任务、9/24 已到达检查点通过。这是测量修正，不是产品收益。

执行器和评分逻辑的离线联调及相关现有回归共 63 项通过，服务端类型检查通过。离线 Fake Provider 只用于验证防答案注入、版本、确认、评分和费用失败边界；不能记作真实模型任务成功。真实模型报告单独归档，不写回固定案例答案。

2026-09-25 首批已获得真实模型调用及提高额度授权。本批采用 20 美元预留上限；12 个案例各 32 次生成、每次 100,000 输入 / 4,096 输出 Token 全部用满的理论预留为 13.4074368 美元。20 美元不是预计账单，也不意味着需要用完。4 个预留案例不在本批中。

首轮在 RI-01 复核调用触及输出上限后停止，完整保留为初始试运行。随后制定 [v2 执行与评分补充协议](../eval/fixtures/requirement-intake-v1/scoring-v2.md)：单位差异均转为显式语义复核，输出额度增至 16,384 Token，再从独立状态运行统一配置的完整开发集。案例输入、oracle 和原 manifest 均保持不变。v2 理论最大预留与旧批次全部预留合计 19.0865397 美元，仍在累计 20 美元内。v1/v2 不可用来宣称生产 Harness 改进收益。

这次新的完整运行使用 `--reviewed-output-stop /private/tmp/packx-intake-baseline-20260925/report.json` 记录旧报告哈希和费用；后续评审续跑不再次添加该参数。它仅接受已核查的输出上限错误，不接受网络未知等任意失败；不会清除旧 unknown 或重放其原请求。

正式运行遇到复核超时后，普通续跑仍被拒绝。操作员使用已归档的一次性脚本，仅继续其他没有未知调用的独立案例，保留所有父报告哈希、未知调用、预留和排除列表；这不是公开 CLI 的自动恢复功能。12 个案例均已终结评分，但账本仍保留 `stopped_unknown`，因为费用和响应尚未核对。详细限制见基线报告。


## 修复后的独立 trial

v3 使用同一组 12 个开发案例与 v2 的模型、额度和超时；v4/v5 保持任务、模型与额度，复核超时改为 120 秒。每轮记录独立代码哈希；以下为 v3 历史启动示例：

```sh
npm run eval:requirement-intake -- --online --directory /private/tmp/packx-intake-repairs-v3-20260925 --usd-limit 20 --prior-report /private/tmp/packx-intake-baseline-v2-finish3-20260925/report.json
```

`--prior-report` 仅接受已终结的 v2/v3/v4/v5 trial，继承全部旧预留与未知调用，不重放旧请求。新 trial 的语义评分仍逐项绑定新输出哈希，不能沿用旧输出的评审结论。执行器、测试中的 Fake、在线业务复核和外部辅助评分分别记录。

附件撤回是员工操作，绑定租户、会话、附件哈希、请求 ID、操作者和原因。先落盘不可变撤回记录，再失效 Fact/Artifact/Approval；中断后下一次读取、启动或交付检查完成剩余同步。当前正在执行时要求先停止；迟到 Worker 在写入前核对附件摘要。旧版本仅保存 `runtime:` 来源而无法识别具体附件时，保守要求这些字段重新核对。历史资料保留但不能作为当前有效证据。

历史 `context-long-readback` 评测默认继续拒绝 Runtime 源码变化。若显式使用 `--allow-runtime-change`，报告声明比较整个 Runtime 与工具，不能当成只改工具的消融实验；该选项用于当前离线 CLI 失败路径测试，未重跑或改写其历史付费结果。


2026-09-25 的逐项修复、试跑失败、最终代码验证与真实模型结果见 [修复报告](evidence/requirement-intake-repairs-2026-09-25.md)。最终候选严格通过 9/12（基线更正后为 0/12），27/29 个已到达检查点通过；剩余失败及全部中间轮次均保留。当前执行器采用 [v5 协议](../eval/fixtures/requirement-intake-v1/scoring-v5.md)。原任务集和 oracle 不变；数值字符串与数值严格等价时改为显式复核，不能自动通过单位、来源或确认检查。旧输出重算另存 [评分更正记录](evidence/requirement-intake-repairs-2026-09-25/scoring-v5-corrections.json)，不改写历史执行或补造未到达检查点。

当前缺失必填字段的基本追问由包装规则生成；模型仍负责原文限制、冲突细节和补充问题。叙述修订不能删除必要追问。新数量提议作为结构化未确认候选交给 Host，旧 verified 值继续保留；正式修改必须绑定新人工确认。客户明确未定的可选规格只作限制说明，未提供的可选规格不新增必填门槛。
