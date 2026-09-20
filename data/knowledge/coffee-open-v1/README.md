# Coffee open corpus v1 — 来源、许可与质量记录

检索用途：包装研究证据实验；不是供应商在售型号库。5 篇真实开放全文、4 个研究文档家族；另 1 篇 CC BY-NC-ND 排除，仅保存许可元数据。

每篇作者署名、完整文献条目、CC BY 4.0 链接与修改说明随解析清单、界面证据和需求单引用保留。原始 XML/PDF 未修改。衍生操作为 JATS 正文/表格结构解析、段落分块、未核验参数转录和本地模型向量化。全文快照取得时间及 SHA-256、发布者 MD5 见 acquisition.json；不声称资料此后持续保持最新。PMC/NLM 提供分发渠道，不代表对 Packx 或结论背书。

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)；[PMC 自动获取政策](https://pmc.ncbi.nlm.nih.gov/tools/textmining/)；[官方开放数据通道](https://pmc.ncbi.nlm.nih.gov/tools/pmcaws/)。遵守原文第三方材料例外，不将图像或商标单独作为可授权商品分发。未抓取普通网页、绕过下载保护、购买数据或请求商用私有资料。

| 文档 | 原文入口 | 类型与适用边界 | 许可 / 状态 |
| --- | --- | --- | --- |
| PMC11243642 | [A Recyclable Polypropylene Multilayer Film Maintaining the Quality and the Aroma of Coffee Pods during Their Shelf Life](https://pmc.ncbi.nlm.nih.gov/articles/PMC11243642/) | REC/STD 咖啡纸包研究；8.5 g 样品 | CC BY / downloaded |
| PMC10931445 | [The Lipidic and Volatile Components of Coffee Pods and Capsules Packaged in an Alternative Multilayer Film](https://pmc.ncbi.nlm.nih.gov/articles/PMC10931445/) | ALT/STD 纸包与胶囊研究；同作者家族 | CC BY / downloaded |
| PMC9563479 | [Lipid Oxidation Changes of Arabica Green Coffee Beans during Accelerated Storage with Different Packaging Types](https://pmc.ncbi.nlm.nih.gov/articles/PMC9563479/) | 250 g 生豆加速储存；空气透过性不是 OTR | CC BY / downloaded |
| PMC11031754 | [PMC11031754](https://pmc.ncbi.nlm.nih.gov/articles/PMC11031754/) | 不入库 | CC BY-NC-ND / excluded |
| PMC10670670 | [Potential Use of PLA-Based Films Loaded with Antioxidant Agents from Spent Coffee Grounds for Preservation of Refrigerated Foods](https://pmc.ncbi.nlm.nih.gov/articles/PMC10670670/) | 咖啡渣提取物 PLA 冷藏食品膜；相邻应用 | CC BY / downloaded |
| PMC11944891 | [Preparation and Characterization of Biocomposite Films with Enhanced Oxygen Barrier and Antioxidant Properties Based on Polylactide and Extracts from Coffee Silverskin](https://pmc.ncbi.nlm.nih.gov/articles/PMC11944891/) | 咖啡银皮 PLA 研究膜；复合单位需复核 | CC BY / downloaded |

每项负责人：Packx 数据负责人（当前为项目操作者）；更新方式：显式运行 `npm run knowledge:fetch` 复核固定候选 metadata。自动允许的只有 CC BY、非撤回、正式发表版本；身份/内容哈希变化需人工核查，不覆盖既有 PDF/XML。完成复核后点击研究导入，登记被排除的既有研究版本会撤回并触发任务复核。当前不是定时在线监控，也不声称覆盖全部 PMC 咖啡研究。

语料质量：JATS 正文/摘要与表格文本可解析；多行表头、rowspan/colspan、单位、误差、脚注保留。图像、参考文献和未下载的补充材料不索引。仅关键页与结构经 Agent 检查，无专业人工验证。生豆论文 PDF 存在重复的版面文字，采用正式 JATS 表结构作为文本读取来源；异常原值不修造。研究论文的 OTR 缺单位、原文单位歧义、表格统计脚注及适用范围均作为缺口保留。

`questions.v1.json` 为模型辅助编写、对照原文的实验题；0 道人工黄金标注。禁止根据这些原文将当前订单的尺寸、厚度、保质期、报价或合规状态确认为 verified。
