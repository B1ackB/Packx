# ADR-0018：包装证据检索的独立本地知识层

- 日期：2026-09-17
- 状态：采用本地最小切片；真实语料与真实模型质量待外部条件
- 范围：咖啡豆/咖啡粉包装袋的售前证据核对，不扩展品类或 Agent Core

## 背景与现状

当前仓库已有行业无关 Core/ContextEngine、受控 Tool、Fact 版本、Artifact/Approval、File Event Store、File/SQLite StageJobQueue、macOS 受限解析器、Plan 输入快照与需求单导出。缺口是跨任务的资料版本治理、结构化参数与条件、权限内检索、证据选择及来源失效传播。原生 PDF 解析器仅输出页文本，没有可靠的表格单元格/脚注抽取；不能把它视为结构化工业数据解析成功。

初次检查工作区干净，分支为 `codex/plan-subagents`，Node 为 24.14.0。本机有 Docker 客户端但没有可连接的 Docker 服务或 psql。未安装新数据库、下载模型或进行付费调用。

## 决定

1. 不改写业务存储，不扩展 Core。`src/enterprise/knowledge.ts` 定义行业无关证据契约；`server/knowledge` 负责授权、版本、生命周期、索引、队列适配、下载约束与本地 embedding Port。包装同义词、字段、换算、比较、来源登记放在 `src/manufacturing`，通过回调注入参数归一化。
2. 新增一个知识 SQLite 文件，使用已采用的 Node 内置 SQLite；原始结构化快照使用既有不可覆盖的 FileArtifactContentStore。业务 SQLite/文件存储完全保留。数据库中 `documents`、`chunks`、`selections`、`knowledge_events` 分职责；chunks 是可删除重建的派生数据。
3. 人工复核的结构化清单是首个可靠输入。现有附件解析器的输出进入 `needs_review/needs_ocr`，保留原附件和解析缓存；不得自行猜表格位置、单位、条件。复核后导入新内容版本，保留前一版本。
4. 检索提供关键词/精确型号、向量、RRF 三条路径。关键词是 NFKC、英文词项和中文双字片段的可解释重叠评分，**不是 BM25**。默认词项特征向量是 256 维固定哈希余弦基线，不是真实语义模型。Ollama 本地适配器要求模型名、内容 digest、维度、许可显式固定，逐次检查模型空间，禁止下载、混用或远程付费端点。
5. 默认关键词检索。首次固定合成评测没有证明混合更优，故不引入重排、查询改写、GraphRAG 或知识图谱。固定别名只是领域词表，不提供任何生产参数。
6. 证据由用户选择形成版本快照。新增 `knowledge_source` 来源 Fact 始终 `unverified`，不让模型修改。需求单候选字段的 `kb-*` 引用必须精确对应选中参数的字段、原文值和单位。确认与审批复用已有流程。检索命中本身不构成语义蕴含证明。
7. 在 Enterprise RunEngine 增加通用 `invalidateSource` 命令，复用既有 stale/superseded/revision_required 事件，允许已交付 Artifact 因外部来源失效进入复核。该命令不改写已批准版本；不是 Core 扩展。撤回和过期会清理索引，受影响任务在治理操作/读取/审批/导出边界重新核对，禁止继续导出失效证据。

## PostgreSQL + pgvector 评估

[pgvector 官方说明](https://github.com/pgvector/pgvector)支持精确向量距离、HNSW/IVFFlat，并可与 PostgreSQL 全文检索组合；它不把 PostgreSQL 内建排序变成 BM25。生产知识层优先迁移到 PostgreSQL，特别是在多进程写入、共享租户部署或本地全量扫描延迟超标时。

当前采用 SQLite 的实际收益是数据库部分零新增依赖、现有 Node 即可离线复现、无需运维服务；代价是同步 I/O、权限范围内全量扫描和单 Host 写入，**不能承诺大语料或生产多租户性能**。没有引入 SQLite 向量扩展、第二个向量数据库或自写 ANN。`postgres-reference.sql` 是待实库验证的迁移参考，不是已上线的 pgvector Adapter。

替代方案：立即安装 PostgreSQL 会增加当前演示的运行与供应链成本；云向量库引入费用与企业资料外传；自建搜索服务不符合首个闭环目标。选用 SQLite 不放宽 P0/P1 权限、版本或来源约束。

## 数据与权限

- 官方来源先登记元数据和链接。使用条款、robots、索引权与再分发权分别核对；未确定权限的来源不保存全文。来源登记不是已获授权的语料。
- 私有资料按 tenant/workspace 在 SQL 读取边界过滤，向量、融合和引用读取共用该边界；公共资料必须显式 public 且声明再分发许可。当前 Host 身份仍由 LocalAccess 固定，没有对外 SaaS 身份服务或生产 RBAC 声明。
- 不做结果缓存，避免隐含缓存权限键；语料、索引、模型空间和过滤条件进入审计。下载器独立存在但没有预设许可，未向 Agent 暴露任意 URL 抓取工具。
- 不可信正文仅作为 Tool 数据进入 ContextEngine。不会被转成权限、系统指令或已验证事实。

## 迁移与退出条件

当目标授权语料达到 30–50 份且得到真实业务反馈，再决定是否需要 PG。升级先备份停机数据、导出文档/来源/选择/审计，将原始内容哈希及稳定 evidenceId 保持不变；在同一冻结语料和标签上验证新 Adapter。双跑比较发生在离线评测环境，不在生产中维护两套真相。未达到等价性、RLS、撤回、恢复和性能门槛时继续本地适配器。

回退使用升级前代码与独立恢复副本；不让旧代码直接读取未来 Schema。没有假定旧审批可在新权限下自动恢复。

## 完成证据与限制

见 [运行说明](../knowledge/README.md)、[验证记录](../knowledge/evidence.md)与机器可读评测报告。合成语料与脚本 Provider 只证明流程及故障策略；不能证明真实工业参数抽取、语义检索、专家认可或企业落地。

后续真实语料及 ONNX 模型见 [ADR-0019](0019-licensed-coffee-corpus-and-local-embedding.md)。
