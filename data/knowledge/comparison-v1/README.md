# 参数比对协议用例 v1

`cases.json` 在修复前固定；其哈希写入 `docs/evidence/knowledge-comparison-baseline.json`。评测脚本拒绝未同步版本的修改。

- 32 项 `synthetic_contract`：Packx 自编的规则契约及故障反例；6 个应允许比较、26 个应阻断。不是供应商数据或模型生成的工业黄金答案。
- 8 项 `real_source_pair`：取自 `coffee-open-v1` 的 5 篇 CC BY 研究语料中的 4 篇，包含原文值、单位及章节/表格位置；均因缺少可比依据而预期阻断。署名、许可证和原始文档见 [真实语料](../coffee-open-v1/README.md)。没有新的全文采集，也没有真实可比较正例。
- `labelStatus` 显式区分软件规则期望和对照原文但待专家审核的标签；不混入原 64 道检索问题，不称独立供应商评测集。

运行 `npm run eval:knowledge-compare` 可复现旧规则与新规则；加 `-- --real` 会使用既有本地 E5 索引，逐条检查真实参数引用并复跑原 64 题的混合排序。不会自动下载模型或调用付费 API。
