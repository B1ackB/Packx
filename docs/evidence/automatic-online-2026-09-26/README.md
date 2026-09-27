# 在线证据归档

本目录保存 2026-09-26 真实模型实验的原始请求、响应、状态检查、费用账本与冻结代码。阅读结论请从[实验报告](../automatic-online-2026-09-26.md)开始。数据来自合成开发案例；不含真实客户订单，也不等于全部语义或生产质量认证。

全轮费用见[费用链汇总](budget-summary.json)，最终工作区检查见[验证记录](verification.json)。

## 归档顺序

| 索引 | 内容 |
| --- | --- |
| [initial.manifest.json](initial.manifest.json) | 最初 4 次任务尝试，收到输出截断后停止；原记录保持不变 |
| [matrix.manifest.json](matrix.manifest.json) | 第一次继续运行，累计至 81 次；连接中断请求仍为未知 |
| [final.manifest.json](final.manifest.json) | 审查唯一断线请求后，仅继续原计划未开始的尝试；最终矩阵与分析 |
| [context.manifest.json](context.manifest.json) | 同一 Session 连续资料输入、两种压缩阈值及全部波次 |
| [repair.manifest.json](repair.manifest.json) | 待确认变更修复后新运行的定向开发回归；不替换原矩阵 |

后一个报告以 SHA-256 绑定前一个报告，并带入全部费用预留。矩阵的累计 results 已包含前序结果，分析时不可再把旧报告的 results 加一遍；每份 calls 仅记录该批自己的新请求，原请求正文从对应批次的单次尝试文件读取。上下文与修复报告分别记录自己的调用。`priorReservedUsd` 已包含前序费用，禁止重复相加或清零。

`output_limit` 表示已收到截断终止信号，但适配器没有保留用量；业务尝试停止、费用仍未知。`terminated` 表示连接中断且远端结果未知。两者都保留请求身份与完整费用上限，不自动重放。继续规则的两次调整分别保存在 continuation-review 文件和冻结计划中。没有成功对账的请求不会因后续批次完成而变成成功。

## 源码与复核

基线生产代码为[Trial C 源码](../requirement-intake-repairs-2026-09-25/trial-c.source.tar.gz)，候选生产代码为[联网前候选源码](../automatic-eval-2026-09-26/candidate.source.tar.gz)。本目录的 `*-evaluation.source.tar.gz` 保存实际执行时的共享执行器与评分代码；`context.source.tar.gz` 和 `repair.source.tar.gz` 保存各专项绑定源码。计划中的文件哈希是版本依据，当前工作区可能已经应用后续修复。

每个 manifest 记录压缩文件 SHA-256；新归档另记解压正文哈希。`*.json.gz` 使用普通 gzip，可离线读取。分析脚本一并归档；分析只汇总冻结结果，不能重写 verdict。工具对账依据 Host execution ID、toolCallId 和 Host 元数据补证缺失 Trace，原始计数、补证数和未知数分列，缺失耗时保持未知。

复核优先使用归档响应和离线脚本。再次运行联网入口是新的付费实验，需要独立记录授权额度、全新尝试身份与冻结计划；本次已使用的报告路径和身份不可复用。
