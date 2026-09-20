# 真实数据源登记与覆盖矩阵

**2026-09-18 更新：** [业务产品目录](product-database.md) 已整理并接入 3 家供应商的 6 个产品系列，仅保存自编元数据和官方链接，不复制供应商全文。当前业务库是 5 篇原有研究 + 6 条目录；新增两篇许可研究仅用于隔离检索实验，不继续以论文数量扩库。可入库的供应商型号 TDS 仍为 0 份。最新可执行登记与覆盖矩阵见 [knowledgeSources.ts](../../src/manufacturing/knowledgeSources.ts)；以下 9 月 17 日记录作为来源发现历史保留。

检查日期：2026-09-17。供应商与标准入口仍仅作发现登记；另通过 PMC 明确允许的开放数据接口取得 5 篇 CC BY 4.0 全文。来源数量不证明市场份额或主流市场覆盖。

实际存量：获准并用于真实索引的研究全文 **5 篇**；供应商在售型号 TDS **0 份**；合成演示资料单独标记。原始取得记录、授权、质量及更新方式见 [开放语料登记](../../data/knowledge/coffee-open-v1/README.md)，实验见 [实测报告](real-experiment.md)。目标 30–50 份仍未达成。此前 0 份是首次许可调查进度，不能解释为所有公开资料都不可用。

## 来源登记

### Mondi · mondi-paper

- 官方入口：[纸基复合软包装；不等于咖啡袋型号 TDS](https://www.mondigroup.com/products-and-solutions/flexible-packaging/paper-laminates/)；域名：www.mondigroup.com。
- 类型：product_information；当前版本线索：网页未标版本。
- 获取：manual_link；[条款核验入口](https://www.mondigroup.com/legal-notice/)；已检查 https://www.mondigroup.com/robots.txt；授权另审。
- 权限：metadata_only；允许用途：保存自编的来源登记元数据和链接；再分发：不分发原文。
- 更新：发布者未承诺；拟每月人工检查，法规/证书在使用前重查；最近检查：2026-09-17。
- 可信度：官方发布入口；仍需核对具体文档、版本和范围；局限：版权保留；网页提供阻隔选项，不能推出具体厚度或 OTR。
- 负责人：Packx 数据负责人（真实企业接入时指定）；接入状态：permission_review_required。

### Huhtamaki · huhtamaki-coffee

- 官方入口：[咖啡软包装；PE、PET/PE、PO 与纸基产品家族](https://www.huhtamaki.com/en/flexible-packaging/market-segments/beverages/coffee/ground-coffee/)；域名：www.huhtamaki.com。
- 类型：product_information；当前版本线索：网页未标版本。
- 获取：manual_link；[条款核验入口](https://www.huhtamaki.com/)；未核实；禁止自动采集。
- 权限：metadata_only；允许用途：保存自编的来源登记元数据和链接；再分发：不分发原文。
- 更新：发布者未承诺；拟每月人工检查，法规/证书在使用前重查；最近检查：2026-09-17。
- 可信度：官方发布入口；仍需核对具体文档、版本和范围；局限：家族介绍不是逐型号测试报告；全文索引授权待确认。
- 负责人：Packx 数据负责人（真实企业接入时指定）；接入状态：permission_review_required。

### Amcor · amcor-coffee

- 官方入口：[EMEA 咖啡包装、AmPrima 产品家族](https://www.amcor.com/products/beverages/coffee/emea)；域名：www.amcor.com。
- 类型：product_information；当前版本线索：网页未标版本。
- 获取：manual_link；[条款核验入口](https://www.amcor.com/)；未核实；禁止自动采集。
- 权限：metadata_only；允许用途：保存自编的来源登记元数据和链接；再分发：不分发原文。
- 更新：发布者未承诺；拟每月人工检查，法规/证书在使用前重查；最近检查：2026-09-17。
- 可信度：官方发布入口；仍需核对具体文档、版本和范围；局限：宣传与认证、订单适用性分开；需索取型号数据和许可。
- 负责人：Packx 数据负责人（真实企业接入时指定）；接入状态：permission_review_required。

### Constantia Flexibles · constantia-coffee

- 官方入口：[咖啡复合材料与袋型](https://consumer.cflex.com/products/coffee-packaging/)；域名：consumer.cflex.com。
- 类型：product_information；当前版本线索：网页未标版本。
- 获取：manual_link；[条款核验入口](https://consumer.cflex.com/)；未核实；禁止自动采集。
- 权限：metadata_only；允许用途：保存自编的来源登记元数据和链接；再分发：不分发原文。
- 更新：发布者未承诺；拟每月人工检查，法规/证书在使用前重查；最近检查：2026-09-17。
- 可信度：官方发布入口；仍需核对具体文档、版本和范围；局限：下载入口已发现；批量获取与嵌入许可待核实。
- 负责人：Packx 数据负责人（真实企业接入时指定）；接入状态：permission_review_required。

### Avery Dennison · avery-78838

- 官方入口：[78838 软包装产品，3 页 PDF](https://label.averydennison.asia/content/dam/averydennison/lpm/na/en/product%20families/Data%20Sheets/Flexible%20Packaging/78838-PDS-en.pdf)；域名：label.averydennison.asia。
- 类型：technical_datasheet；当前版本线索：须人工核对原文修订标记。
- 获取：manual_link；[条款核验入口](https://label.averydennison.asia/)；未核实；禁止自动采集。
- 权限：metadata_only；允许用途：保存自编的来源登记元数据和链接；再分发：不分发原文。
- 更新：发布者未承诺；拟每月人工检查，法规/证书在使用前重查；最近检查：2026-09-17。
- 可信度：官方发布入口；仍需核对具体文档、版本和范围；局限：真实型号 TDS 入口；未获得全文持久化和公开再分发许可。
- 负责人：Packx 数据负责人（真实企业接入时指定）；接入状态：permission_review_required。

### FEFCO · fefco

- 官方入口：[瓦楞箱结构；后续扩展，不进入咖啡袋参数库](https://www.fefco.org/technical-information/fefco-code)；域名：www.fefco.org。
- 类型：classification；当前版本线索：12th edition。
- 获取：manual_link；[条款核验入口](https://www.fefco.org/terms-of-use)；未核实；禁止自动采集。
- 权限：metadata_only；允许用途：保存自编的来源登记元数据和链接；再分发：不分发原文。
- 更新：发布者未承诺；拟每月人工检查，法规/证书在使用前重查；最近检查：2026-09-17。
- 可信度：官方发布入口；仍需核对具体文档、版本和范围；局限：允许条件下阅读/研究，不代表可公开再分发或制作衍生数据库。
- 负责人：Packx 数据负责人（真实企业接入时指定）；接入状态：permission_review_required。

### GS1 · gs1-ppm

- 官方入口：[产品与包装层级测量字段定义](https://ref.gs1.org/standards/ppm/)；域名：ref.gs1.org。
- 类型：normative_document；当前版本线索：3.3 / Aug 2026 / 78 页。
- 获取：manual_link；[条款核验入口](https://www.gs1.org/standards/ip)；未核实；禁止自动采集。
- 权限：metadata_only；允许用途：保存自编的来源登记元数据和链接；再分发：不分发原文。
- 更新：发布者未承诺；拟每月人工检查，法规/证书在使用前重查；最近检查：2026-09-17。
- 可信度：官方发布入口；仍需核对具体文档、版本和范围；局限：标准实施许可不自动等于全文索引/再分发许可；PDF 正式版为准。
- 负责人：Packx 数据负责人（真实企业接入时指定）；接入状态：permission_review_required。

### FSC · fsc-search

- 官方入口：[机构证书、许可及范围查询](https://search.fsc.org/en/)；域名：search.fsc.org。
- 类型：certificate_record；当前版本线索：动态查询，保存时间戳才有版本意义。
- 获取：manual_link；[条款核验入口](https://search.fsc.org/en/)；未核实；禁止自动采集。
- 权限：metadata_only；允许用途：保存自编的来源登记元数据和链接；再分发：不分发原文。
- 更新：发布者未承诺；拟每月人工检查，法规/证书在使用前重查；最近检查：2026-09-17。
- 可信度：官方发布入口；仍需核对具体文档、版本和范围；局限：人工查询入口；未确认批量 API 权限。机构证书不证明某订单或产品认证。
- 负责人：Packx 数据负责人（真实企业接入时指定）；接入状态：permission_review_required。

### European Commission · eu-ppwr

- 官方入口：[欧盟包装法规发现入口](https://environment.ec.europa.eu/topics/waste-and-recycling/packaging-waste/packaging-packaging-waste-regulation_en)；域名：environment.ec.europa.eu。
- 类型：regulatory_discovery；当前版本线索：专题网页；正式法律文本另行核对。
- 获取：manual_link；[条款核验入口](https://commission.europa.eu/legal-notice_en)；未核实；禁止自动采集。
- 权限：metadata_only；允许用途：保存自编的来源登记元数据和链接；再分发：不分发原文。
- 更新：发布者未承诺；拟每月人工检查，法规/证书在使用前重查；最近检查：2026-09-17。
- 可信度：官方发布入口；仍需核对具体文档、版本和范围；局限：复用政策须逐项核对第三方例外；具体要求须追溯 EUR-Lex、适用日期和地区。
- 负责人：Packx 数据负责人（真实企业接入时指定）；接入状态：permission_review_required。

### European Union · eurlex-2025-40

- 官方入口：[Regulation (EU) 2025/40 正式入口](https://eur-lex.europa.eu/eli/reg/2025/40/oj/eng)；域名：eur-lex.europa.eu。
- 类型：normative_document；当前版本线索：OJ 原始版本入口，修订与合并版本须另查。
- 获取：manual_link；[条款核验入口](https://eur-lex.europa.eu/content/legal-notice/legal-notice.html)；未核实；禁止自动采集。
- 权限：metadata_only；允许用途：保存自编的来源登记元数据和链接；再分发：不分发原文。
- 更新：发布者未承诺；拟每月人工检查，法规/证书在使用前重查；最近检查：2026-09-17。
- 可信度：官方发布入口；仍需核对具体文档、版本和范围；局限：本次入口返回内容有限，未完成法律条文核验，不给合规结论。
- 负责人：Packx 数据负责人（真实企业接入时指定）；接入状态：permission_review_required。

### 中国质量认证中心 · cqc-food-contact

- 官方入口：[食品接触材料相关认证标准换版通知，中文](https://www.cqc.com.cn/www/col68/596454.html)；域名：www.cqc.com.cn。
- 类型：certification_notice；当前版本线索：页面通知版本；国家标准全文另查。
- 获取：manual_link；[条款核验入口](https://www.cqc.com.cn/)；未核实；禁止自动采集。
- 权限：metadata_only；允许用途：保存自编的来源登记元数据和链接；再分发：不分发原文。
- 更新：发布者未承诺；拟每月人工检查，法规/证书在使用前重查；最近检查：2026-09-17。
- 可信度：官方发布入口；仍需核对具体文档、版本和范围；局限：认证机构官方通知不能替代国家标准，也不能证明订单符合要求。
- 负责人：Packx 数据负责人（真实企业接入时指定）；接入状态：permission_review_required。

## 覆盖矩阵

| 包装品类 | 材料/结构 | 工艺 | 应用 | 地区 | 发布机构 | 当前状态与缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| 咖啡豆/咖啡粉包装袋 | PE / PET-PE / PO / 纸基复合 | 复合/制袋/封口/阀 | 咖啡 | 供应商页面范围，订单待核对 | Mondi、Huhtamaki、Amcor、Constantia Flexibles、Avery Dennison | discovery_only；逐型号结构、厚度、OTR/WVTR 测试条件、许可、适用日期 |
| 咖啡袋 | 食品接触塑料 | 测试/认证 | 食品接触 | CN | 中国质量认证中心 | discovery_only；正式标准版本与授权、具体型号测试报告 |
| 包装层级 | 不指定 | 测量 | 产品数据交换 | global | GS1 | definition_candidate；许可复核；不用于自动推算生产尺寸 |
| 瓦楞箱 | 瓦楞纸板 | 结构分类 | 运输包装 | global | FEFCO | deferred；首个咖啡袋闭环通过后再扩展 |
| 纸基包装 | 森林来源材料 | 证书查询 | 供应链核查 | 证书范围 | FSC | discovery_only；订单关联、批量授权、有效期与范围核验 |
| 包装 | 跨材料 | 法规核查 | 上市地区规则 | EU | European Commission、European Union | discovery_only；条款版本、生效/适用日期、专业审查 |

## 可检查的进入标准

每个进入语料的格子须至少有：具体厂商/型号和版本、存储/索引/展示权限凭据、质量检查、实际页码/表格坐标、测试方法/条件/单位、适用地区与日期。至少两家独立发布机构且逐型号字段完整，才可标记该格子“具备候选比较证据”；这仍不是“覆盖主流市场”。

目前供应商产品与规范资料格子均未达到该标准；研究全文不能替代市场覆盖标准。没有对真实市场占比作推断。市场信息与可执行报价另建类型和时间/币种/数量/贸易条款字段，当前没有接入。

## 许可处理记录

Mondi 法律页保留版权，FEFCO 对研究/私人阅读与再分发、衍生使用作区分；GS1 实施相关 IP 许可不能直接当作原文再分发许可。FSC 先人工查询，不猜测批量 API 授权。欧盟委员会复用政策需核对第三方例外；EUR-Lex 本次返回内容有限，未用其建立合规结论。中文官方 CQC 通知是认证换版线索，国家标准全文、正式版本和使用权仍需独立核实。

供应商与企业授权由用户另行取得。不得绕过下载保护、登录、验证码或付费墙，也不得为满足数量目标降低门槛。
