import type { EvidenceAssessment, EvidenceHit, KnowledgeRetrievalPolicy } from "../enterprise/knowledge";

// Bilingual vocabulary only: no document IDs, expected answers, source selection or numerical facts.
const glossary: Array<[RegExp, string]> = [
	[/厚度|多厚/, "thickness"], [/层/, "layer"], [/结构|组成|构成/, "composition structure composed consisted"],
	[/克重/, "grammage"], [/阻隔/, "barrier"], [/氧气|氧透|透氧/, "oxygen"], [/水蒸气|水汽/, "water vapor"],
	[/透过率|透过性|渗透/, "permeability transmission"], [/空气/, "air"], [/咖啡/, "coffee"],
	[/纸包/, "pods"], [/胶囊/, "capsules"], [/聚丙烯/, "polypropylene"], [/聚乙烯/, "polyethylene"],
	[/聚酯/, "polyester"], [/氧化铝/, "aluminum oxide"], [/铝/, "aluminium aluminum"],
	[/可回收/, "recyclable"], [/标准|对照/, "standard"], [/替代/, "alternative"],
	[/生豆|生咖啡/, "green beans"], [/烘焙/, "roasted"], [/咖啡渣/, "spent grounds"], [/银皮/, "silverskin"],
	[/保护气体|气氛/, "protective atmosphere gas"], [/装量|装多少|装样|多少咖啡/, "contained packed coffee"],
	[/每包|每袋|几粒/, "each packs"], [/温度/, "temperature"], [/湿度/, "humidity"],
	[/储存|贮存/, "storage stored"], [/时长|持续|多少天|多久/, "duration months days"],
	[/方法|测量|测定|测试/, "measurement measured test"], [/仪器|设备/, "instrument"], [/显微镜/, "microscope"],
	[/流量/, "flow rate"], [/压差/, "pressure differential"], [/公式/, "equation"], [/范围|区间/, "range between"],
	[/含水|水分/, "moisture content"], [/感官|气味/, "smell sensory"], [/风味|味道/, "taste"],
	[/统计|显著/, "statistical significant"], [/足够|保证|承诺/, "guarantee"],
];
export function expandPackagingQuery(query: string): string {
	const additions = glossary.filter(([pattern]) => pattern.test(query)).map(([, text]) => text);
	return additions.length ? `${query} ${additions.join(" ")}` : query;
}

const fields: Array<{ field: string; pattern: RegExp; names: string[]; question: string }> = [
	{ field: "dimensions", pattern: /尺寸|袋宽|袋高|袋长|\bdimensions?\b|\bbag size\b/i, names: ["dimensions"], question: "请提供该型号的尺寸图、尺寸定义与装填验证；装量不能确定生产尺寸。" },
	{ field: "price", pattern: /报价|价格|单价|交付价|\bprice\b|\bquote\b|\bcost\b/i, names: ["price"], question: "请提供带日期、币种、数量、交付条款的来源报价，并由有权限人员确认。" },
	{ field: "certificate", pattern: /认证|证书|合规|\bcertificate\b|\bcertification\b|\bFSC\b|\bcompliance\b/i, names: ["certificate"], question: "请提供证书编号、有效期、持有人和适用产品范围；机构证书不证明当前订单。" },
	{ field: "shelf_life", pattern: /保质期|\bshelf[ -]life\b/i, names: ["shelf_life"], question: "请提供同产品、装填、封口和储存条件的保质期验证；研究储存时长不是订单承诺。" },
	{ field: "seal_temperature", pattern: /封口温度|热封温度|\bseal(?:ing)? temperature\b/i, names: ["seal_temperature"], question: "请提供该材料与机台适用的热封窗口、压力和时间，安排实际封口验证。" },
	{ field: "valve_pressure", pattern: /阀.*压力|压力.*阀|pressure.*valve|valve.*pressure/i, names: ["valve_pressure"], question: "请提供阀型号、开启压力、单位、测试方法与条件。" },
	{ field: "thickness", pattern: /厚度|多厚|\bthick(?:ness)?\b/i, names: ["thickness"], question: "请限定具体材料层或总厚，并提供原始值、单位和测量方法。" },
	{ field: "grammage", pattern: /克重|\bgrammage\b/i, names: ["grammage"], question: "请提供该型号或样品克重的原始值与单位。" },
	{ field: "OTR", pattern: /\bOTR\b|oxygen transmission|氧气透过率|透氧率/i, names: ["OTR", "OTR_as_labelled"], question: "请提供 OTR 原始值、完整单位、测试方法、温湿度及压差；不直接比较单位不明的值。" },
	{ field: "WVTR", pattern: /\bWVTR\b|water vapor transmission|水蒸气透过率|水汽透过率/i, names: ["WVTR"], question: "请提供 WVTR 原始值、完整单位、测试方法与温湿度。" },
];
export function assessPackagingEvidence(query: string, hits: EvidenceHit[]): EvidenceAssessment {
	const wanted = fields.filter((f) => f.pattern.test(query));
	const asksMethod = /方法|标准|温度|湿度|压差|条件|\bmethod\b|\bstandard\b|\bconditions?\b|\btemperature\b|\bhumidity\b/i.test(query);
	const asksUnit = /单位|\bunits?\b/i.test(query);
	const generic = new Set(["OTR", "WVTR", "WVP", "ASTM", "ISO", "FSC"]);
	const identities = (query.match(/\b[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)*\b/g) ?? []).filter((id) => id.length > 1 && !generic.has(id));
	const checks: EvidenceAssessment["checks"] = wanted.map((field) => {
		const matches = hits.flatMap((h) => h.parameters.filter((p) => field.names.includes(p.name)).filter((p) => !identities.length || identities.some((id) => (p.subject ?? h.model).split(/[\s/]+/).includes(id))).map((p) => ({ hit: h, parameter: p })));
		const incomplete = asksMethod || identities.length > 1 || asksUnit && matches.some((m) => !m.parameter.originalUnit);
		return { field: field.field, status: !matches.length ? "missing" : incomplete ? "needs_review" : "present", evidenceIds: [...new Set(matches.map((m) => m.hit.evidenceId))], question: field.question };
	});
	return { status: checks.some((c) => c.status === "missing") ? "insufficient_evidence" : checks.length && checks.every((c) => c.status === "present") ? "source_values_available" : "needs_review", checks, conclusionAllowed: false };
}

export const packagingRetrievalPolicy: KnowledgeRetrievalPolicy = {
	version: "packaging-fields.v1", lexical: "field_idf", diversifyTables: true,
	prepare: (query) => ({ lexicalQuery: expandPackagingQuery(query), vectorQuery: expandPackagingQuery(query) }), assess: assessPackagingEvidence,
};
