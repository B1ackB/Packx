# 将真实资料接入正在使用的 Packx

2026-09-17：本机已将 5 篇获准使用的研究全文、568 个片段导入默认业务数据根目录 `.blackx-data/knowledge/knowledge.sqlite`。租户/工作区为 Host 自己的 `local-user/default-workspace`，不是 `research-eval/coffee` 的评测库。原始资料、署名和许可仍见 [研究语料](../../data/knowledge/coffee-open-v1/README.md)。

本机 `.env` 已设置 `PACKX_KNOWLEDGE_MODEL=local-e5`，普通 `npm run dev` 会使用固定本地 E5。该文件属于本机配置，不提交到 Git；没有改动对话生成模型、API Key 或模型地址。换电脑后需要按 [模型准备说明](real-experiment.md)准备权重，并显式设置同一变量。检索模型空间不能与旧词项向量混用。

## 现在怎样使用

启动正常 Packx 后，在任务列表打开「知识库连通验证（真实资料 / 本地测试回复）」即可查看已保存的证据及测试结果。该任务的回答明确标注为本地测试 Provider 整理；数值、引用和原文来自实际检索。也可以新建普通包装任务，让已配置的对话 Agent 调用检索工具：

> 请调用 knowledge_search，在 study:PMC11243642 中查找 REC 膜的克重和单位，给出资料版本及页码；测试条件未说明时保留缺口，不推导订单规格。

`knowledge_search` 从服务器业务库返回有限证据，经过 ContextEngine 进入 Agent 下一轮调用；`knowledge_selected` 读取当前任务保存的引用。用户选择仍不等于确认 Fact。不同任务可搜索相同的公开库，选择集合按任务分别保存。

## 可重复的导入和连通检查

停止正常 Host 后执行：

```bash
npm run knowledge:connect
```

该命令会操作当前 `BLACKX_DATA_ROOT`（默认 `.blackx-data`），不是临时评测库。它复用现有 `open-research` API 和持久队列，依次执行：

1. 校验已有本地原文哈希和许可；经现有导入队列使用本地 E5 建索引。
2. 重复导入并检查文档版本不变。
3. 在正常会话路径调用 `knowledge_search`，验证原值、版本及位置确实进入下一轮模型上下文。
4. 保存一条引用，调用 `knowledge_selected` 验证任务来源可读。
5. 停止并重启 Host，再验证检索和已选证据均可读取。
6. 将本机结果写入 `.blackx-data/knowledge/connection.json`，保留明确标注的演示任务。

为了不调用付费服务，命令临时启动仅监听本机的脚本 Provider，并只接受连通测试消息；退出后恢复原有启动环境，原有模型配置文件不修改。临时 Provider 的 token 数是测试值，不作为真实生成成本或质量证据。既有 Host 锁、活跃的无关队列任务或启用中的定时任务会阻止执行，不能偷偷接管现有业务。此检查命令当前支持文件队列；SQLite 队列继续使用界面/API 导入。

取消后已完成的资料仍在业务库，未完成任务留在现有持久队列；下次可继续。部分完成的连通记录为 `verifying`，全部通过才为 `ready`。重复执行复用记录中的验证任务，导入版本和索引保持幂等；若任务已经删除则新建。正常运行不需要重复执行此检查。

## 已验证的内容与限制

- 实际业务库：5 份已索引文档、568 个片段，固定 E5，未复制评测数据库文件。
- 普通会话：真实 HTTP → Runtime → 知识工具 → 本地检索 → ContextEngine → 本地测试回复；重启前后均通过。
- 示例来源：PMC11243642.1，第 13 页，`3. Materials and Methods / 3.2. Samples`，REC 克重原值 `81 g/m2`，状态 `unverified`。这不是供应商产品规格或订单选材建议。
- 未调用付费生成模型，未将本地测试回复宣传为真实 LLM 质量；资料仍是研究全文，供应商 TDS 为 0。

当前连通记录与代码哈希见 [验证证据](../evidence/knowledge-connection-verification.json)。之后的正常提问使用用户自己配置的对话 Provider；是否付费取决于其配置，和本次免费本地连通检查分开。
