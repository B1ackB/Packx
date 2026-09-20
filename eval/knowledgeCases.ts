import type { KnowledgeQuery } from "../src/enterprise/knowledge";

export interface KnowledgeCase {
	id: string;
	question: string;
	family: string;
	split: "development" | "frozen_synthetic";
	labelStatus: "synthetic_assertion";
	category: string;
	query: Omit<KnowledgeQuery, "mode">;
	expected: string[];
	foreignTenant?: boolean;
}

// Versioned authored cases, not model-generated or human-reviewed real-world golden answers.
const questions = [
	["型号", "model", 0], ["材料结构", "structure", 1], ["thickness", "table", 2],
	["厚度", "bilingual", 2], ["oxygen transmission", "semantic", 2], ["OTR", "acronym", 2],
	["测试条件", "conditions", 2], ["mm µm", "units", 2], ["咖啡包装袋", "application", 1],
	["structure", "bilingual", 1],
] as const;
export const knowledgeCases: KnowledgeCase[] = [
	...["DEMO-PE-A", "DEMO-PET-B", "HOLDOUT-PAPER-C", "HOLDOUT-PE-D"].flatMap((model, index) => questions.map(([suffix, category, block], i): KnowledgeCase => ({
		id: `retrieval-${index}-${i}`, question: `${model} ${suffix}有哪些来源说明？`, family: index < 2 ? `development-${index}` : `holdout-${index}`, split: index < 2 ? "development" : "frozen_synthetic", labelStatus: "synthetic_assertion", category,
		query: { query: suffix === "型号" ? model : suffix, model, region: "HK", asOf: "2026-09-17T10:00:00.000Z", limit: 5 },
		expected: block ? [`${model.toLowerCase()}:${block}`] : [`${model.toLowerCase()}:1`, `${model.toLowerCase()}:2`],
	}))),
	...[
		"WVTR", "保质期 18 个月", "报价 单价", "生产尺寸", "FSC 订单认证", "食品接触合规", "总迁移量", "封口温度", "印刷 ICC", "刀模版本",
	].map((question, i): KnowledgeCase => ({ id: `absent-${i}`, question, family: "no-answer", split: "frozen_synthetic", labelStatus: "synthetic_assertion", category: "no_answer", query: { query: question, region: "HK", limit: 5 }, expected: [] })),
	...["keyword-model", "thickness", "OTR", "coffee", "材料"].map((question, i): KnowledgeCase => ({ id: `permission-${i}`, question, family: "tenant-isolation", split: "frozen_synthetic", labelStatus: "synthetic_assertion", category: "permission", query: { query: question, region: "HK" }, expected: [], foreignTenant: true })),
	...["型号", "厚度", "结构", "OTR", "coffee"].map((question, i): KnowledgeCase => ({ id: `expired-${i}`, question, family: "expired-source", split: "frozen_synthetic", labelStatus: "synthetic_assertion", category: "expired", query: { query: question, model: "EXPIRED-X", region: "HK" }, expected: [] })),
	{ id: "conflicting-revisions", question: "同型号两版厚度是否冲突", family: "conflict-versions", split: "frozen_synthetic", labelStatus: "synthetic_assertion", category: "conflict", query: { query: "thickness", model: "CONFLICT-Z", region: "HK" }, expected: ["conflict-z@fixture-v1:2", "conflict-z@fixture-v2:2"] },
	{ id: "conflict-source", question: "冲突参数来自哪一版哪一页", family: "conflict-versions", split: "frozen_synthetic", labelStatus: "synthetic_assertion", category: "citation", query: { query: "OTR", model: "CONFLICT-Z", region: "HK" }, expected: ["conflict-z@fixture-v1:2", "conflict-z@fixture-v2:2"] },
	{ id: "region-cn", question: "中国订单可用证据", family: "applicability", split: "frozen_synthetic", labelStatus: "synthetic_assertion", category: "region", query: { query: "coffee", region: "CN" }, expected: [] },
	{ id: "before-publication", question: "旧日期订单", family: "applicability", split: "frozen_synthetic", labelStatus: "synthetic_assertion", category: "date", query: { query: "coffee", asOf: "2020-01-01T00:00:00.000Z" }, expected: [] },
	{ id: "compare-thickness", question: "比较两个开发集候选厚度", family: "development-comparison", split: "development", labelStatus: "synthetic_assertion", category: "comparison", query: { query: "thickness", region: "HK" }, expected: ["demo-pe-a:2", "demo-pet-b:2"] },
	{ id: "compare-conditions", question: "两个 OTR 候选的测试条件", family: "development-comparison", split: "development", labelStatus: "synthetic_assertion", category: "conditions", query: { query: "OTR", region: "HK" }, expected: ["demo-pe-a:2", "demo-pet-b:2"] },
];

// Quarantined discovery questions: no downloaded corpus or reviewed answer labels, not scored.
export const publicDiscoveryQuestions = [
	{ source: "avery-78838", question: "78838 的原文厚度、单位和测试条件是什么？需要逐页审核。" },
	{ source: "huhtamaki-coffee", question: "哪些咖啡包装产品家族在官方页面被列出？是否存在逐型号参数？" },
	{ source: "mondi-paper", question: "纸基复合包装页面是否给出带测试条件的数值阻隔数据？" },
	{ source: "amcor-coffee", question: "AmPrima 的咖啡应用范围与具体订单适用性有何区别？" },
	{ source: "constantia-coffee", question: "下载资料对应哪个型号、修订日期和使用许可？" },
	{ source: "fsc-search", question: "证书查询的范围、状态、查询时间和订单关联还缺什么？" },
	{ source: "gs1-ppm", question: "测量标准 3.3 的定义应定位到哪一节？" },
	{ source: "cqc-food-contact", question: "换版通知引用的标准与当前正式文本是否一致？" },
].map((q) => ({ ...q, labelStatus: "model_assisted_unreviewed", expectedAnswer: null, scoreEligible: false }));
