import type { EvidenceHit } from "../enterprise/knowledge";
import { labelFor, statusFor, type Language } from "../i18n";
import type { RequirementBriefV1 } from "./requirementBrief";
import type { AssetInspectionRecord } from "../runtime/assetInspection";

export const requirementFieldLabels: Record<string, string> = {
	product_type: "包装类型", quantity: "数量", dimensions: "尺寸",
	target_market: "销售市场", target_delivery: "交付日期", delivery_location: "交付地点",
	artwork_status: "设计稿状态",
	material_structure: "材料结构", material_thickness: "材料厚度（含单位）", printing_process: "印刷方式",
	surface_finish: "表面工艺", closure_type: "封口方式", valve_requirement: "排气阀要求",
};
export const factStatusLabels: Record<string, string> = { verified: "已确认", unverified: "待确认", suggested: "建议", rejected: "已拒绝" };
export const inspectionStatusLabels: Record<string, string> = { parsed: "已解析", needs_ocr: "需要 OCR", metadata_only: "仅元数据", unsupported: "暂不支持解析" };

export interface RequirementDelivery {
	schemaVersion: "requirement-delivery.v1";
	runId: string;
	version: number;
	status: "draft" | "approved" | "stale";
	createdAt: string;
	content: RequirementBriefV1;
	sources: AssetInspectionRecord[];
	citations: Record<string, string>;
	sourcePlan?: string;
	knowledgeEvidence?: EvidenceHit[];
	approval?: { approvalId: string; artifactVersion: number };
}

const cell = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/[\\`*_[\]{}|]/g, "\\$&").replaceAll(/[\r\n]+/g, " ");
export function deliveryMarkdown(delivery: RequirementDelivery, language: Language = "zh"): string {
	const en = language === "en";
	const content = delivery.content;
	return [
		`# ${cell(content.title)}`, "",
		`${en ? "Version: " : "版本："}v${delivery.version} · ${{ draft: en ? "Unconfirmed draft" : "待确认草稿", approved: en ? "Current version approved" : "当前版本已批准", stale: en ? "Historical or stale version" : "历史或已失效版本" }[delivery.status]}`,
		`${en ? "Run: " : "任务："}${delivery.runId} · ${en ? "Created: " : "创建时间："}${delivery.createdAt}`, "",
		...(delivery.knowledgeEvidence?.length ? [en ? "## Selected candidate evidence (not fact confirmation)" : "## 选中的候选证据（不等于事实确认）", ...delivery.knowledgeEvidence.map((hit) => `- ${cell(hit.evidenceId)} · ${cell(hit.publisher)} · ${cell(hit.model)} · ${cell(hit.revision)} · ${hit.location.page ? `p${hit.location.page}` : ""} ${cell(hit.location.section)} ${cell(hit.location.table ?? "")} · ${cell(hit.sourceUrl)} · ${cell(hit.provenance)} · ${cell(hit.attribution ?? "")}`), ""] : []),
		...(delivery.sourcePlan ? [`${en ? "Source plan (unverified reports): " : "来源计划（报告待核对）："}${cell(delivery.sourcePlan)}`, ""] : []),
		en ? "This is a requirement record, not a production-ready file." : "本文件是需求整理记录，不是生产就绪文件。", "", cell(content.customerGoal), "",
		(en ? "| Field | Value | Status | Source |" : "| 字段 | 内容 | 状态 | 来源 |"), "| --- | --- | --- | --- |",
		...content.facts.map((fact) => `| ${cell(labelFor(language, fact.key, requirementFieldLabels[fact.key] ?? fact.key))} | ${cell(fact.value)} ${cell(fact.unit ?? "")} | ${statusFor(language, fact.status, factStatusLabels[fact.status])} | ${cell(delivery.citations[fact.key] ?? fact.sourceRef)} |`),
		"", (en ? "## Missing information" : "## 仍需补充"), ...content.missingRequiredFacts.map((key) => `- ${labelFor(language, key, requirementFieldLabels[key] ?? key)}`),
		...(content.missingRequiredFacts.length ? [] : [(en ? "No required fields are missing." : "无缺失必填字段。")]),
		"", (en ? "## Assumptions and limitations" : "## 假设与限制"), ...content.assumptions.map((item) => `- ${cell(item)}`),
		"", (en ? "## Sources" : "## 资料来源"), ...delivery.sources.flatMap((source) => [
			`- ${cell(source.name)} · ${statusFor(language, source.inspection.status, inspectionStatusLabels[source.inspection.status])}${source.inspection.truncated ? en ? " (truncated)" : "（内容截断）" : ""}`,
			`  ${en ? "Source" : "来源"}: ${source.sourceRef} · SHA-256: ${source.sha256} · ${en ? "Parser" : "解析器"}: ${source.parserVersion}`,
		]), "",
	].join("\n");
}

export function deliveryHtml(delivery: RequirementDelivery, language: Language = "zh"): string {
	const en = language === "en";
	const escape = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
	return `<!doctype html><html lang="${en ? "en" : "zh-CN"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(delivery.content.title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;color:#24211d;max-width:960px;margin:40px auto;padding:24px}table{border-collapse:collapse;width:100%}td,th{padding:10px;border:1px solid #ccc;text-align:left;overflow-wrap:anywhere}small{color:#555}pre{white-space:pre-wrap;overflow-wrap:anywhere}h1{font-size:28px}@media print{body{margin:0;padding:0}tr{break-inside:avoid}}</style><h1>${escape(delivery.content.title)}</h1><p>v${delivery.version} · ${escape({ draft: en ? "Unconfirmed draft" : "待确认草稿", approved: en ? "Current version approved" : "当前版本已批准", stale: en ? "Historical or stale version" : "历史或已失效版本" }[delivery.status])}</p><p>${escape(delivery.content.customerGoal)}</p><table><thead><tr><th>${en ? "Field" : "字段"}</th><th>${en ? "Value" : "内容"}</th><th>${en ? "Status" : "状态"}</th><th>${en ? "Source" : "来源"}</th></tr></thead><tbody>${delivery.content.facts.map((fact) => `<tr><td>${escape(labelFor(language, fact.key, requirementFieldLabels[fact.key] ?? fact.key))}</td><td>${escape(fact.value)} ${escape(fact.unit ?? "")}</td><td>${escape(statusFor(language, fact.status, factStatusLabels[fact.status]))}</td><td>${escape(delivery.citations[fact.key] ?? fact.sourceRef)}</td></tr>`).join("")}</tbody></table><h2>${en ? "Missing fields" : "缺失字段"}</h2><p>${escape(delivery.content.missingRequiredFacts.map((key) => labelFor(language, key, requirementFieldLabels[key] ?? key)).join("、") || (en ? "None" : "无"))}</p><h2>${en ? "Assumptions and limitations" : "假设与限制"}</h2><p>${escape(delivery.content.assumptions.join("；"))}</p><h2>${en ? "Sources" : "资料来源"}</h2>${delivery.sourcePlan ? `<p>${en ? "Source plan (unverified reports): " : "来源计划（报告待核对）："}${escape(delivery.sourcePlan)}</p>` : ""}${(delivery.knowledgeEvidence ?? []).map((hit) => `<p>${escape(hit.evidenceId)} · ${escape(hit.publisher)} · ${escape(hit.model)} · ${escape(hit.revision)} · ${hit.location.page ? `p${hit.location.page}` : ""} ${escape(hit.location.section)} ${escape(hit.location.table ?? "")} · ${escape(hit.sourceUrl)} · ${escape(hit.provenance)} · ${escape(hit.attribution ?? "")} · unverified</p>`).join("")}${delivery.sources.map((source) => `<section><h3>${escape(source.name)}</h3><small>${escape(statusFor(language, source.inspection.status, inspectionStatusLabels[source.inspection.status]))}${source.inspection.truncated ? en ? " · Truncated" : " · 内容截断" : ""} · SHA-256 ${escape(source.sha256)}</small>${source.inspection.pages.map((page) => `<details><summary>${en ? "Page / section" : "页 / 区段"} ${page.page}</summary><pre>${escape(page.text)}</pre></details>`).join("")}</section>`).join("")}<p>${en ? "This is a requirement record, not a production-ready file." : "本文件是需求整理记录，不是生产就绪文件。"}</p><small>${escape(delivery.runId)} · ${escape(delivery.createdAt)}</small></html>`;
}

export function compareRequirementVersions(before: RequirementBriefV1, after: RequirementBriefV1) {
	const keys = new Set([...before.facts, ...after.facts].map((fact) => fact.key));
	return [...keys].flatMap((key) => {
		const left = before.facts.find((fact) => fact.key === key);
		const right = after.facts.find((fact) => fact.key === key);
		if (JSON.stringify(left) === JSON.stringify(right)) return [];
		return [{ key, before: left, after: right }];
	});
}
