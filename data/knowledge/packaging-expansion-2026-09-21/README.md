# 包装行业资料扩充快照（2026-09-21）

本数据包包含 FDA 官方食品接触再生塑料工艺表的完整公开导出，并由 Packx 原创目录补充行业资料查找入口。供应商全文未获授权的资料仍仅保留目录；没有下载厂商 TDS、证书原件或客户门户文件。

## 官方表格与复用依据

- 来源：[FDA Recycled Plastics in Food Packaging](https://www.fda.gov/food/packaging-food-contact-substances-fcs/recycled-plastics-food-packaging)；[可查询数据库](https://www.hfpappexternal.fda.gov/scripts/fdcc/index.cfm?set=RecycledPlastics)。
- 采集路径：数据库页面的 Download data，固定 HTTPS 官方导出，一次下载，未批量爬站。确切 URL、日期、字节数和 SHA-256 见 [acquisition.json](acquisition.json)。
- [FDA 网站政策](https://www.fda.gov/about-fda/about-website/website-policies)声明，未另行标注的内容属于公共领域。已核对该官方表格没有单独版权例外；本包不含第三方附件、图片、商标或标识。对应政策段落保存在 [fda-reuse-policy.txt](fda-reuse-policy.txt)。
- 官方下载头部标记：更新于 **2026-09-04**、下载于 **2026-09-21**。这是固定快照，不是实时数据库，也不代表 FDA 对 Packx 的认可。
- NOL 涉及特定回收工艺和使用条件，不构成某个产品、所有供应商或当前订单的通用批准。食品类型/条件代码应回读 [FDA 定义表](https://www.fda.gov/food/packaging-food-contact-substances-fcs/food-types-conditions-use-food-contact-substances)，具体订单继续经现有事实确认与审批。

## 文件及变换

| 文件 | 用途 |
| --- | --- |
| `fda-recycled-plastics.xls` | 官方原始字节。虽然后缀为 `.xls`，内容实际是 Windows-1252 CSV，不运行表格公式。 |
| `fda-recycled-plastics.json` | 对应的 460 条完整记录，7 个原字段，保留原行顺序。 |
| `prepare.py` | 仅用 Python 标准库重放转换，无联网。解析 CSV、HTML 实体和编号列表，将 NOL 日期规范为 ISO；不翻译、不补值、不截断。 |
| `acquisition.json` | 来源、许可范围、原始/派生/政策文件哈希。 |
| `cases.json` | 在首次本地模型评测前冻结的 14 条工程探针；Agent 标注，未获专家或独立盲测验证。 |

重放转换：

```bash
python3 data/knowledge/packaging-expansion-2026-09-21/prepare.py
```

仅识别记录号字段中来源使用的 `=T("数字")` 包装，不使用 `eval` 或执行公式。未知 HTML 标签/属性、不完整 CSV、缺失字段、重复记录号或行数变化会报错，需要重新核对。原 CSV 的记录 282 位于第 286 数据行，保留此行序；定位使用独立的 `row` 和 `fda-pcr-282` 锚点。

## 分块与模型契约

复用旧业务策略：**表格整行作为一个证据块，0 overlap**；现有研究论文仍使用原 JATS 段落约 1,000 字符/表格整行策略，既有 568 块不变。FDA 表格最长字段为 843 字符，超过现有通用表格单元格 500 字符的上限，因此每行的完整字段名和字段值保存在 `EvidenceBlock.text`，定位仍保留原表、行和记录锚点。没有拆散条件，也没有放宽通用 Schema。10 条原创目录各自完整一块。

仍通过 `KnowledgeStore.process()` 使用固定 `Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78`，q8、384 维、mean pooling、L2、query/passage 前缀及既有 `windows-480-v1`。不混用向量空间，不采用 500 字符完整句子的实验分块。可选重排沿用已有本地 mMARCO 和模型锁。

本包 **11 份知识文档 / 470 块**，其中只有 1 份/460 块是获准保存的官方表格正文，另 10 份是目录（8 个行业数据库入口、2 个供应商入口）。供应商技术全文增量仍为 **0**。所有 `parameters` 为空；数字和限制保留在来源正文中，不直接抽成已确认 Fact。90 天后到期待复核是 Packx 的维护期限，不是 FDA 通知或供应商文件的法律有效期。

业务接入、验证和限制见 [扩充报告](../../../docs/knowledge/expansion-2026-09-21.md)。
