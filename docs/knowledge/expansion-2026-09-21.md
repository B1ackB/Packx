# 包装知识库扩充：官方 PCR 数据与资料入口

2026-09-21。本次沿用现有知识库、权限、不可变来源快照、持久导入队列、证据选择和固定模型，新增 **FDA 食品接触 PCR 表格 460 条完整记录**，以及 **8 个行业数据库入口、2 个供应商资料入口**。原有 5 篇研究/568 块和 6 条产品目录/6 块保持不变。

## 数据覆盖与授权

| 内容 | 数量 | 实际能帮助回答的问题 | 边界 |
| --- | --- | --- | --- |
| FDA PCR 工艺/NOL 表格 | 1 份文档，460 条完整记录/460 块 | 在快照中定位公司、聚合物、NOL 日期、回收工艺和完整使用限制 | US 食品接触 PCR 工艺数据；不是供应商 TDS、订单适用性或实时合规结论 |
| 行业数据库入口 | 8 份原创目录/8 块 | 找官方产品/认证/原材料信息查询位置，并明确核对字段 | 没有将入口计为技术参数覆盖，未复制相应原始数据库 |
| 供应商资料入口 | 2 份原创目录/2 块 | 定位 Goglio CO-FRES、TricorBraun Flex 的咖啡包装资料入口 | 精确型号、材料结构、阀、尺寸、价格等保持未知 |

FDA 数据从其官方页面提供的 Excel 下载取得，文件实际为 Windows-1252 CSV；原文件头部记录更新日 2026-09-04、下载日 2026-09-21。包含 1990-02-21 至 2026-08-14 的 NOL 日期；公司字段有 308 个不同字符串、聚合物字段有 42 个不同字符串，不能据此宣称覆盖 308 家独立供应商或 42 个规范材料类别。167 条记录没有聚合物缩写，原空值保留。[数据包、原始文件和许可凭据](../../data/knowledge/packaging-expansion-2026-09-21/README.md)

[FDA 使用政策](https://www.fda.gov/about-fda/about-website/website-policies)明确未另行标注的内容为公共领域；已核对本次官方表格无单独版权标注，未纳入第三方附件或标识。所有快照带出处、日期、SHA-256、变换说明。供应商/认证机构页面没有确认全文索引权的只保存 Packx 原创事实性目录，不授予原文许可。

## 已登记的官方入口

| 入口 | 使用目的 | 本次保存内容 |
| --- | --- | --- |
| [FDA FCN](https://www.fda.gov/food/packaging-food-contact-substances-fcs/inventory-effective-food-contact-substance-fcs-notifications) | 按通知号、物质、制造商找用途与限制；不能将其他制造商的通知直接套给本订单 | 目录，未复制 FCN 个案 |
| [FDA PCR](https://www.fda.gov/food/packaging-food-contact-substances-fcs/recycled-plastics-food-packaging) | 按工艺、聚合物、公司和 NOL 日期查限制 | 目录及独立的 460 行公开快照 |
| [BPI](https://bpiworld.org/find-certified-products) | 按 SKU/产品/公司核对堆肥认证，区分商业与家庭堆肥 | 目录，无证书全文 |
| [RecyClass](https://recyclass.eu/certifications/recyclability/recyclability-certificates/) | 按证书码、产品、材料与到期日查可回收性证书 | 目录，无动态证书库副本 |
| [FSC Search](https://search.fsc.org/en/) | 按许可码、证书码、组织核对 FM/CoC 记录 | 目录，无证书库副本 |
| [Siegwerk Finder](https://www.siegwerk.com/en/inks-coatings/printing-inks.html) | 油墨用途与工艺筛选，再向客户门户索取 TDS/成分声明 | 目录，未登录或下载客户文件 |
| [Metsä Board](https://www.metsagroup.com/metsaboard/products-and-services/products/product-portfolio/) | FBB/FSB/WKL 纸板具体产品表入口 | 目录，无产品表全文 |
| [UPM](https://www.upmspecialtymaterials.com/products/paper-catalogue/) | 包装纸/标签纸和地区化目录入口 | 目录，无技术数据复制 |
| [Goglio CO-FRES](https://www.goglio.it/en/prodotti/co-fres/) | 咖啡包装系统/阀/包装线资料线索 | 原创供应商目录 |
| [TricorBraun Flex](https://www.tricorbraunflex.com/markets) | 咖啡袋型、SKU、定制和阀资料线索 | 原创供应商目录 |

Mondi 页面也经过调查，但其网站条款对再利用及外链有明确限制，本次没有将其产品资料纳入数据包。没有通过询价或外部联系取得额外授权，也没有抓取登录后资料。

## 调用链及策略一致性

`packagingExpansionManifests()` → 现有知识导入 → `KnowledgeStore.process()` → 固定 E5 索引 → `knowledge_search` → ContextEngine → `knowledge_selected`/`knowledge_read`。新入口通过普通知识检索发现；`packaging_find_products` 继续负责旧有咖啡产品目录，不将行业入口伪装为可生产型号。

- 数据定义：[packagingExpansion.ts](../../src/manufacturing/packagingExpansion.ts)；服务器变换：[packagingExpansion.ts](../../server/manufacturing/packagingExpansion.ts)。
- FDA 每个完整表格行一块，保留全部 7 个字段和编号列表。通用表格单元格上限为 500 字符，而最长字段为 843 字符，因此整行以带字段名的完整文本保存，并保留表/行/记录号定位，不截断也不扩展 Core/通用 Schema。
- 原有 JATS 约 1,000 字符正文/整行表格策略保持，0 overlap；新目录每条完整一块；未采用隔离实验中的 500 字符句子策略。
- Embedding 沿用 `Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78`，q8、384 维、mean-L2、query/passage 前缀、`windows-480-v1`、`transformers@4.3.0`。本地模型和重排权重仍由原模型锁校验，不下载新权重。
- FDA 数值只存在于有日期/来源的完整文本，`parameters` 为空，未创建 verified Fact。数据明确为 US；按其他地区筛选会排除该来源。公共数据按明确许可共享，私有副本、任务选择和治理写入仍按租户/工作区隔离。
- 2026-12-20 是 Packx 维护复核截止日，非 FDA NOL 或供应商资料的法定失效日。没有新增自动在线同步；使用来源前需核对官方更新，撤回继续使选择及依赖失效。

## 可重复验证

```bash
npx vitest run server/manufacturing/packagingExpansion.test.ts
node --import tsx eval/knowledgeEnrich.ts --write
node --import tsx eval/knowledgeEnrich.ts --local-model --write
```

默认评测只用 Fake；`--local-model` 显式使用已经存在的固定本地 E5 和 mMARCO，不联网下载、不发生成或付费模型调用。两种评测均使用临时 SQLite，退出删除临时目录，不直接写正在使用的业务库。14 条冻结工程探针包含 12 条新增出处问题和 2 条原库控制问题；所有标签由 Agent 对照来源构造，未做专家盲审。它们检验新增数据是否可被检索，不是广泛的语义质量基准。

专项测试覆盖完整字段/条件保留、哈希损坏拒绝、幂等导入、重启后引用、任务选择隔离、私有副本跨租户/工作区拒绝、US 地区边界、撤回/维护到期及未获索引许可拒绝。评测额外逐字回读全部 460 行，并保留旧 manifest 哈希与同模型对照。

本地结果见 [Fake 机制报告](../evidence/knowledge-expansion-2026-09-21-fake.json)和[本地模型报告](../evidence/knowledge-expansion-2026-09-21-local.json)。新增出处从原库缺失到可以检索，收益来自资料覆盖增加；不能描述成检索算法变好了或整个 Agent 的准确率提升。真实生成质量、订单选材效果、企业员工验收、独立人工标签均未评测，新增供应商技术全文仍为 0。

2026-09-21 实际运行结果：

| 固定本地 E5 + 既有 mMARCO | 原库 | 扩充后 |
| --- | --- | --- |
| 文档/块数 | 11 / 574 | 22 / 1,044 |
| 新出处工程探针 Top 5 命中 | 0 / 12 | 12 / 12（均为 Top 1） |
| 原有来源控制探针 Top 5 命中 | 2 / 2 | 2 / 2 |
| 命中内容与完整存储文本一致 | 2 / 2 | 14 / 14 |
| 查询 embedding 次数/输入 Token | 14 / 270 | 14 / 270 |
| 重排次数/输入 Token | 14 / 99,312 | 14 / 78,668 |
| 14 次检索平均耗时 | 735.1 ms | 618.9 ms |
| 生成模型/付费调用 | 0 / 0 | 0 / 0 |

这些问题包含来源/公司等强定位词，结果体现资料可发现性；旧库从未包含相应新出处，0/12 是预期覆盖缺口。单次串行对照受候选内容长度、冷启动与本机负载影响，较低平均耗时不是“扩库使检索更快”的结论。Fake 的命中数字不作为语义质量证据。额外已运行 `npx tsc -b` 和三组相关测试，共 7 项通过，其中新增专项测试 4 项。


## 实际业务库接入（主任务完成）

已运行 `npm run knowledge:connect-products` 的构建及正常 Host 导入流程。本机业务库现有 **22 份已索引文档 / 1,044 块**，全部块使用同一固定 E5 signature；原 5 篇研究和 6 条产品目录保留。导入命令本次返回 17 份/476 块，是原 6 条目录加新增 11 份/470 块，不是新增 476 块。重复导入返回相同版本，Host 重启、已选引用续读与原咖啡目录工具到 ContextEngine 链路通过，生成使用本地 Fixture，付费调用 0。业务导入回执在本机 `.blackx-data/knowledge/product-connection.json`；脱敏交付核对见 [validation](../evidence/personal-memory-delivery-validation.json)。发布构建已明确包含本数据包，并在发布目录下验证可加载全部 11 个新增 manifest / 470 块。
