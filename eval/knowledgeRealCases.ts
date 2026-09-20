import type { KnowledgeQuery } from "../src/enterprise/knowledge";
import { familyFor, splitFor } from "../server/manufacturing/coffeeOpenCorpus";

export interface RealCase { id: string; query: string; language: "zh" | "en"; category: string; split: "development" | "frozen"; family: string; expected: { documentId: string; block: number; quote: string }[]; filters?: Partial<KnowledgeQuery>; labelStatus: "agent_source_checked_pending_human_review" }
const cases: RealCase[] = [];
function pair(id: string, doc: string, block: number, quote: string, category: string, zh: string, en: string) {
	for (const [language, query] of [["zh", zh], ["en", en]] as const) cases.push({ id: `${id}-${language}`, query, language, category, split: splitFor(doc), family: familyFor(doc), expected: [{ documentId: doc, block, quote }], labelStatus: "agent_source_checked_pending_human_review" });
}
// Freeze queries and source spans before any ranking experiment. Relevance anchors are exact source checks, NOT expert gold answers.
pair("rec-pet", "PMC11243642", 36, "12 microns", "layer_thickness", "可回收聚丙烯咖啡纸包研究中，对照 STD 膜的 PET 层厚度是多少？", "In the recyclable polypropylene coffee pod study, what is the PET layer thickness of STD film?");
pair("rec-pe", "PMC11243642", 36, "60 microns", "layer_thickness", "REC 研究中标准 STD 膜的 PE 层厚度是多少？", "In the REC study, what thickness is the PE layer in STD film?");
pair("rec-structure", "PMC11243642", 37, "oriented polypropylene high performance", "structure", "REC 膜由哪些聚丙烯层组成？", "What polypropylene layers compose the REC film?");
pair("rec-opp", "PMC11243642", 37, "15 microns", "layer_thickness", "REC 膜的 OPPHP 层厚度是多少？", "What is the thickness of the OPPHP layer in REC film?");
pair("rec-barrier", "PMC11243642", 37, "<0.5", "raw_inequality", "论文为 REC 膜报告的 OTR 原始值是什么？", "What raw OTR value is reported for REC film?");
pair("rec-grammage", "PMC11243642", 37, "81 g/m2", "unit", "REC 膜的克重及单位是什么？", "What grammage and unit are given for REC film?");
pair("rec-fill", "PMC11243642", 35, "8.5 g", "applicability", "可回收聚丙烯膜研究里每个咖啡纸包实际装多少咖啡？", "How much coffee is inside each pod in the recyclable polypropylene film study?");
pair("rec-gas", "PMC11243642", 35, "100% nitrogen", "storage_condition", "REC 研究的咖啡纸包使用什么保护气体？", "What protective gas was used for the coffee pods in the REC study?");
pair("rec-store", "PMC11243642", 39, "12 months at 25 °C and at 40 °C", "storage_condition", "REC 咖啡纸包研究的储存温度和时长是什么？", "At what temperatures and for how long were REC coffee pods stored?");
pair("alt-pe", "PMC10931445", 18, "55 microns", "layer_thickness", "ALT 替代多层咖啡包装膜的 PE 层厚度是多少？", "How thick is the polyethylene layer of the ALT alternative multilayer coffee film?");
pair("alt-metallization", "PMC10931445", 18, "aluminum oxide < 1 micron", "structure", "ALT 膜的 MPET 层中氧化铝厚度如何描述？", "How is the aluminum oxide thickness in the MPET layer of ALT described?");
pair("alt-pack", "PMC10931445", 16, "packs of 10", "applicability", "ALT 研究的咖啡胶囊每包装几粒？", "How many capsules were packaged together in the ALT study?");
pair("alt-store", "PMC10931445", 21, "180 days", "storage_condition", "ALT 研究的储存试验持续多少天？", "How many days did the ALT film storage experiment last?");
pair("green-method", "PMC9563479", 12, "ASTM D737-04", "test_method", "生咖啡豆包装研究用什么标准测量空气透过性？", "Which standard was used to measure air permeability of green coffee bean packaging?");
pair("green-instrument", "PMC9563479", 12, "SMD-565J", "test_method", "生咖啡豆包装的厚度用什么仪器测量？", "Which instrument measured thickness of the green coffee packaging?");
pair("green-rh", "PMC9563479", 12, "relative humidity (RH) 50%", "storage_condition", "生咖啡豆加速储存实验的相对湿度是多少？", "What relative humidity was used in accelerated storage of green coffee beans?");
pair("green-fill", "PMC9563479", 12, "250 g", "applicability", "生咖啡豆加速储存研究中每袋装样多少？", "How much green coffee was packed per bag in the accelerated storage study?");
pair("green-gp-air", "PMC9563479", 52, "0.538 ± 0.04", "table_value", "生咖啡豆研究表 1 中 GP 袋的空气透过性原始值和单位是什么？", "What air permeability value and unit are given for GP bags in Table 1 of the green coffee study?");
pair("green-ldpe-thick", "PMC9563479", 51, "0.075 ± 0.00", "table_value", "生咖啡豆研究表 1 中 LDPE 包装的厚度原文值是什么？", "What is the original LDPE thickness value in Table 1 of the green coffee study?");
pair("scg-thick", "PMC10670670", 64, "40 and 50 μm", "range", "添加咖啡渣提取物的 PLA 薄膜厚度范围是多少？", "What is the thickness range of PLA films enriched with spent coffee grounds extracts?");
pair("scg-microscope", "PMC10670670", 31, "Olympus BX51", "test_method", "咖啡渣 PLA 薄膜用什么显微镜观察厚度？", "Which microscope was used for thickness observations of PLA films with spent coffee grounds extracts?");
pair("pla-otr-unit", "PMC11944891", 76, "cm3 mm/(m2·d·0.1 MPa)", "compound_unit", "咖啡银皮 PLA-C3 薄膜表 3 标为 OTR 的指标原始单位是什么？", "What original unit is printed for OTR of PLA-C3 in Table 3 of the coffee silverskin study?");
pair("pla-otr-value", "PMC11944891", 76, '"7"', "table_value", "咖啡银皮研究表 3 中 PLA-C3 的 OTR 数值是多少？", "What OTR value is listed for PLA-C3 in Table 3 of the coffee silverskin study?");
pair("pla-wvtr", "PMC11944891", 76, "2.61", "table_value", "咖啡银皮 PLA-C3 的 WVTR 数值是多少？", "What WVTR value is listed for PLA-C3 coffee silverskin composite film?");
pair("pla-oxygen-conditions", "PMC11944891", 51, "23 °C, 0% relative humidity", "test_condition", "咖啡银皮 PLA 薄膜氧气渗透测试的温度和湿度是什么？", "At what temperature and humidity was oxygen permeability tested for coffee silverskin PLA films?");
pair("pla-flow", "PMC11944891", 51, "10 mL/min", "test_condition", "咖啡银皮 PLA 薄膜氧气测试的气体流量是多少？", "What gas flow rate was used for oxygen testing of coffee silverskin PLA films?");
pair("pla-water-method", "PMC11944891", 52, "ASTM E96", "test_method", "咖啡银皮 PLA 薄膜水蒸气渗透实验采用哪个标准？", "Which standard was used for the water vapor permeability test of coffee silverskin PLA films?");
pair("pla-water-delta", "PMC11944891", 53, "2339 Pa", "test_condition", "咖啡银皮 PLA 薄膜 WVP 公式采用的水蒸气压差是多少？", "Which water vapor pressure difference is specified in the WVP equation for coffee silverskin PLA films?");
for (const [id, query, language] of [
	["size", "500 克烘焙咖啡豆袋应该用什么生产尺寸？", "zh"],
	["quote", "What is the executable price for 10000 REC coffee bags delivered to Hong Kong?", "en"],
	["certificate", "这批 ALT 咖啡袋的 FSC 证书编号是什么？", "zh"],
	["shelf", "Can the REC study guarantee 18 months shelf life for my 500 g roasted bean order?", "en"],
	["seal", "REC 材料在我方机器的封口温度应设为多少？", "zh"],
	["valve", "What pressure opens the one-way valve of the studied REC pouch?", "en"],
] as const) cases.push({ id: `absent-${id}`, query, language, category: "no_answer", split: "frozen", family: "absent-production-claims", expected: [], labelStatus: "agent_source_checked_pending_human_review" });
for (const [id, filters] of [["unknown-model", { model: "NONEXISTENT-500G" }], ["before-publication", { asOf: "2000-01-01T00:00:00.000Z" }]] as const) cases.push({ id, query: "coffee packaging oxygen", language: "en", category: "filter", split: "frozen", family: id, expected: [], filters, labelStatus: "agent_source_checked_pending_human_review" });
export const realKnowledgeCases = cases;
export const granularTasks = [
	{ id: "rec-study", broad: "介绍可回收咖啡包装膜的材料与应用", questions: ["REC 膜有哪些聚丙烯层？", "STD 膜的各层材料与厚度是什么？", "REC 研究每包咖啡装量和保护气体是什么？", "REC 咖啡纸包储存的温度和时长是什么？"], expected: ["PMC11243642:37", "PMC11243642:36", "PMC11243642:35", "PMC11243642:39"] },
	{ id: "pla-study", broad: "介绍咖啡银皮 PLA 薄膜的阻隔性能与实验", questions: ["PLA-C3 薄膜表 3 的 OTR 与 WVTR 数值？", "咖啡银皮 PLA 薄膜氧气渗透测试的温湿度和流量？", "咖啡银皮 PLA 薄膜水蒸气测试方法 ASTM 是什么？", "咖啡银皮 PLA 薄膜 WVP 公式的压差是什么？"], expected: ["PMC11944891:76", "PMC11944891:51", "PMC11944891:52", "PMC11944891:53"] },
];
