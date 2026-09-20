import type { EvidenceHit, EvidenceParameter } from "../enterprise/knowledge";

// These terms affect retrieval only; they never supply missing product parameters.
export const packagingTerms: ReadonlyArray<readonly string[]> = [
	["coffee", "咖啡", "咖啡豆"], ["pouch", "bag", "包装袋", "封口袋"],
	["thickness", "厚度"], ["structure", "结构", "材料结构"],
	["oxygen", "otr", "氧气", "氧气透过率"], ["wvtr", "moisture", "水蒸气", "水蒸气透过率"],
	["barrier", "阻隔"], ["valve", "排气阀"], ["polyethylene", "pe", "聚乙烯"],
	["pet", "polyester", "聚酯"], ["aluminum", "aluminium", "铝"],
];

export function normalizeParameter(parameter: EvidenceParameter): EvidenceParameter {
	const { normalized: _untrusted, ...original } = parameter;
	// Inequalities, ranges, tolerances and compound units require explicit handling, never parseFloat.
	if (!/^\d+(?:\.\d+)?$/.test(parameter.originalValue)) return original;
	const value = Number(parameter.originalValue);
	const factor = parameter.name === "thickness" ? ({ mm: 1000, um: 1, "µm": 1, "μm": 1, microns: 1, mil: 25.4 } as Record<string, number>)[parameter.originalUnit] : undefined;
	if (!Number.isFinite(value) || factor === undefined) return original;
	return { ...original, normalized: { value: Number((value * factor).toPrecision(12)), unit: "µm" } };
}

export function compareParameters(left: EvidenceParameter, right: EvidenceParameter) {
	const reasons: string[] = [];
	const declared = (s: string) => !!s.trim() && !/^(?:unknown|n\/?a|not (?:reported|specified|available|measured)|none|tbd|未说明|未提供|未知|不详|无|待确认|[?—-]+)$/i.test(s.trim());
	const units: Record<string, string[]> = { grammage: ["g/m2", "g/m²", "gsm"], OTR: ["cm3/(m2 day)", "cm3/(m2·d)", "cm³/(m²·d)", "cc/(m2 day)"], WVTR: ["g/(m2 day)", "g/m2·d", "g/(m2·d)", "g/(m²·d)", "g/m²·d"], WVP: ["(10−7) (g/m·d·Pa)", "g/(m day Pa)", "g/(m·d·Pa)"], air_permeability: ["L/m2 s", "L/(m2 s)", "L/(m²·s)"] };
	if (left.name !== right.name) reasons.push("parameter_mismatch");
	if ([left, right].some((p) => p.name !== "thickness" && !Object.hasOwn(units, p.name))) reasons.push("parameter_not_supported");
	if ([left, right].some((p) => p.name === "OTR_as_labelled")) reasons.push("parameter_semantics_require_review");
	if (!declared(left.scope) || left.scope !== right.scope) reasons.push("scope_mismatch_or_missing");
	if (!declared(left.method) || left.method !== right.method) reasons.push("test_method_mismatch_or_missing");
	if (!declared(left.conditions) || left.conditions !== right.conditions) reasons.push("test_conditions_mismatch_or_missing");
	const required: Record<string, string[]> = { OTR: ["temperature", "relative_humidity", "pressure_difference", "gas"], WVTR: ["temperature", "humidity_source", "humidity_receiver"], WVP: ["temperature", "humidity_source", "humidity_receiver"], air_permeability: ["temperature", "relative_humidity", "pressure_difference"] };
	const conditionUnits: Record<string, string[]> = { temperature: ["C", "°C", "K", "F", "°F"], relative_humidity: ["%", "% RH", "%RH"], pressure_difference: ["Pa", "kPa", "bar", "atm"], humidity_source: ["%", "% RH", "%RH"], humidity_receiver: ["%", "% RH", "%RH"] };
	const conditionDeclared = (c: NonNullable<EvidenceParameter["testConditions"]>[number]) => declared(c.value) && (Object.hasOwn(conditionUnits, c.name) ? conditionUnits[c.name].includes(c.unit) && /^-?\d+(?:\.\d+)?$/.test(c.value) && Number.isFinite(Number(c.value)) : c.name !== "gas" || c.unit === "");
	const complete = (p: EvidenceParameter) => (Object.hasOwn(required, p.name) ? required[p.name] : []).every((name) => p.testConditions?.some((c) => c.name === name && conditionDeclared(c)));
	if (!complete(left) || !complete(right)) reasons.push("structured_test_conditions_missing");
	const context = (p: EvidenceParameter) => JSON.stringify([...(p.testConditions ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((c) => [c.name, c.value, c.unit]));
	if (context(left) !== context(right)) reasons.push("structured_test_conditions_mismatch");
	const names = [...new Set([...(Object.hasOwn(required, left.name) ? required[left.name] : []), ...(Object.hasOwn(required, right.name) ? required[right.name] : []), ...(left.testConditions ?? []).map((c) => c.name), ...(right.testConditions ?? []).map((c) => c.name)])];
	const conditionChecks = names.map((name) => {
		const a = left.testConditions?.find((c) => c.name === name), b = right.testConditions?.find((c) => c.name === name);
		return { name, left: a, right: b, status: !a || !b || !conditionDeclared(a) || !conditionDeclared(b) ? "missing" as const : a.value === b.value && a.unit === b.unit ? "same" as const : "different" as const };
	});
	if (conditionChecks.some((c) => c.status === "missing") && !reasons.includes("structured_test_conditions_missing")) reasons.push("structured_test_conditions_missing");
	const a = normalizeParameter(left), b = normalizeParameter(right);
	const numeric = /^\d+(?:\.\d+)?$/;
	const av = a.normalized ?? (numeric.test(a.originalValue) ? { value: Number(a.originalValue), unit: a.originalUnit } : undefined);
	const bv = b.normalized ?? (numeric.test(b.originalValue) ? { value: Number(b.originalValue), unit: b.originalUnit } : undefined);
	if (!av || !bv || !av.unit || av.unit !== bv.unit || !Number.isFinite(av.value) || !Number.isFinite(bv.value)) reasons.push("unit_or_value_not_comparable");
	if ([a, b].some((p) => p.name === "thickness" ? !p.normalized : !(Object.hasOwn(units, p.name) && units[p.name].includes(p.originalUnit)))) reasons.push("unit_dimension_unrecognized");
	return { comparable: reasons.length === 0, reasons, conditionChecks, left: a, right: b, ...(reasons.length === 0 ? { difference: av!.value - bv!.value, unit: av!.unit } : {}) };
}

export const comparisonRuleVersion = "packaging-parameters.v2";
export const testConditionLabels: Record<string, string> = { temperature: "测试温度", relative_humidity: "相对湿度", pressure_difference: "压差", gas: "测试气体", humidity_source: "供给侧湿度", humidity_receiver: "接收侧湿度" };
export const comparisonReasonLabels: Record<string, string> = {
	parameter_mismatch: "参数名称不同", parameter_not_supported: "此参数不能自动做数值比较", parameter_semantics_require_review: "原文指标名称与物理含义需要人工核对",
	scope_mismatch_or_missing: "测量范围不同或未说明（须区分整膜和材料层）", test_method_mismatch_or_missing: "测试方法或版本不同、缺失或标为未知",
	test_conditions_mismatch_or_missing: "原文测试条件不同、缺失或标为未知", structured_test_conditions_missing: "缺少逐项记录的温湿度、压差或气体条件",
	structured_test_conditions_mismatch: "逐项测试条件或单位不一致", unit_or_value_not_comparable: "单位不同、原值含范围/不等号/误差或不是有效数值",
	unit_dimension_unrecognized: "单位尚未确认为该指标的可计算单位", same_parameter_reference: "重复选择了同一条来源参数",
};

export function coffeeEvidenceReview(hits: EvidenceHit[]) {
	const questions: string[] = [];
	for (const name of ["structure", "thickness", "OTR", "WVTR"]) {
		if (!hits.some((hit) => hit.parameters.some((p) => p.name === name))) questions.push(`请供应商提供具体型号的 ${name} 原始资料、版本和测试条件。`);
	}
	for (const hit of hits) for (const p of hit.parameters) {
		if (!p.originalUnit) questions.push(`${hit.model} / ${p.subject ?? p.name}：${p.name} 的原始单位是什么？`);
		if (["OTR", "WVTR", "WVP", "OTR_as_labelled", "air_permeability"].includes(p.name)) {
			if (!p.method) questions.push(`${hit.model} / ${p.subject ?? p.name}：${p.name} 的测试方法、标准版本及报告位置是什么？`);
			if (!p.conditions) questions.push(`${hit.model} / ${p.subject ?? p.name}：${p.name} 的温度、湿度、压差及气体条件是什么？`);
		}
	}
	const comparisons: Array<{ leftEvidence: string; rightEvidence: string; parameter: string } & ReturnType<typeof compareParameters>> = [];
	let comparisonTruncated = false;
	// ponytail: cap the advisory scan; explicit two-reference comparisons remain available beyond this budget.
	scan: for (const [index, left] of hits.entries()) for (const right of hits.slice(index + 1)) for (const a of left.parameters) for (const b of right.parameters) {
		if (a.name !== b.name) continue;
		if (comparisons.length === 64) { comparisonTruncated = true; break scan; }
		comparisons.push({ leftEvidence: left.evidenceId, rightEvidence: right.evidenceId, parameter: a.name, ...compareParameters(a, b) });
	}
	return {
		status: "unverified" as const, comparisons, comparisonTruncated, questions: [...new Set(questions)],
		conflicts: comparisons.filter((c) => c.comparable && c.difference !== 0 && c.left.subject === c.right.subject && hits.find((h) => h.evidenceId === c.leftEvidence)?.publisher === hits.find((h) => h.evidenceId === c.rightEvidence)?.publisher && hits.find((h) => h.evidenceId === c.leftEvidence)?.model === hits.find((h) => h.evidenceId === c.rightEvidence)?.model),
		limitations: ["500 克只描述装量，不能推出尺寸、厚度、保质期或报价。", "供应商宣传、测试和证书记录须分别核对；证书查询不证明当前订单认证。", "选入任务不等于确认事实；必须明确当前订单的地区、日期和型号适用性。"],
	};
}

/** Each question asks for one evidence obligation. It supplies no order parameters. */
export const coffeeEvidenceQuestions = [
	{ label: "1. 样品与订单", query: "研究样品是咖啡纸包、胶囊、生豆还是烘焙豆？实际装量和包装方式是什么？" },
	{ label: "2. 各层结构", query: "REC 膜由哪些材料层组成？每层的名称和缩写是什么？" },
	{ label: "3. 厚度", query: "REC 膜的 OPPHP 层厚度与原始单位是什么？" },
	{ label: "4. 阻隔原始值", query: "REC 膜的 OTR 原始值是否含小于号？原始单位是什么？" },
	{ label: "5. 氧气测试条件", query: "咖啡银皮 PLA 薄膜氧气渗透测试的温度和湿度是什么？" },
	{ label: "6. 水蒸气测试方法", query: "咖啡银皮 PLA 薄膜水蒸气渗透实验采用哪个标准？" },
	{ label: "7. 储存实验", query: "REC 咖啡纸包研究的储存温度和时长是什么？" },
	{ label: "8. 不支持的订单参数", query: "500 克烘焙咖啡豆袋应该用什么生产尺寸？" },
] as const;
