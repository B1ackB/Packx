import type { FactVersionState } from "../../src/enterprise/contracts";
import type { RequirementFactV1, RequirementExtractionCorrection } from "../../src/manufacturing/requirementBrief";
import { compareRequirementField } from "../../src/manufacturing/requirementField";
import type { ReviewEvidence } from "../enterprise/evidenceReviewWorkflow";

/** Only complete original customer text, never summaries, extracted Facts or unreadable metadata. */
export function originalCustomerText(evidence: ReviewEvidence): string | undefined {
	const value = evidence.content as Record<string, unknown> | null;
	if (!value || value.status === "unreadable" || value.status === "rejected" || value.status === "withdrawn" || value.truncated || value.excerptOnly) return;
	if (typeof value.content === "string" && (value.representation === "authored_text" || value.representation === undefined) && !value.sourceType) return value.content;
	if (value.key === "customer_brief" && value.sourceType === "user_input" && typeof value.value === "string") {
		try { JSON.parse(value.value); } catch { return value.value; }
	}
}

// ponytail: deliberately limited to a single explicit piece count in original text.
// Broaden only with fixed counterexamples for ranges, per-pack counts and amendments.
function explicitQuantity(text: string, productType?: string) {
	if (/(?:可能|预计|大约|至少|最多|不少于|不超过|追加|加单|改为|改成|变更|取消|撤回|负责人批准|待批准|未确认|尚未确认|maybe|about|additional|pending|change|cancel)/i.test(text)) return;
	const matches = [...text.matchAll(/(?<![\d.,+\-])([1-9]\d*)\s*(个|件|只|张|pcs\b)/gi)];
	if (matches.length !== 1 || [...text.matchAll(/\d\s*(?:个|件|只|张|pcs|卷|箱|包|套|roll|carton)/gi)].length !== 1) return;
	const match = matches[0];
	const prefix = text.slice(0, match.index).split(/[，,。；;\n]/).at(-1)!.trim().replace(/[：:]$/, "").trim();
	const suffix = text.slice(match.index! + match[0].length).split(/[，,。；;\n]/)[0].trim();
	if (suffix || !["数量", "总数量", "订单数量", "订单总量", "总量", "quantity", productType].filter(Boolean).includes(prefix)) return;
	const clause = prefix + match[0];
	if (/(?:每|样|试|或|约|至|到|以上|以下|左右|不少|不多|多于|少于|不含|不需要|不是|不要|非|曾|之前|旧|原来|per|sample|or\b|[-~～])/i.test(clause)) return;
	const value = Number(match[1]);
	return Number.isSafeInteger(value) ? { value, unit: match[2].toLowerCase() } : undefined;
}

export function correctExtractedQuantity(fact: RequirementFactV1, current: FactVersionState | undefined, evidence: ReviewEvidence[], productType?: string): { fact: RequirementFactV1; audit: RequirementExtractionCorrection } | undefined {
	if (fact.key !== "quantity" || fact.status !== "unverified" || fact.sourceType !== "model_output" ||
		current && (current.status !== "unverified" || current.sourceType !== "model_output" || current.sourceRef !== fact.sourceRef)) return;
	const sources = evidence.filter(item => item.ref === fact.sourceRef);
	if (sources.length !== 1) return;
	const source = sources[0], quote = originalCustomerText(source);
	if (!quote || quote.length > 8000) return;
	const corrected = explicitQuantity(quote, productType);
	if (!corrected || compareRequirementField("quantity", fact, corrected).reason !== "numeric_mismatch") return;
	// Any other customer statement with a count must unambiguously agree. Never choose a source by recency.
	for (const item of evidence) {
		const text = originalCustomerText(item);
		if (text === undefined) {
			const data = item.content as Record<string, unknown> | null;
			if (data?.status === "unreadable" || data?.status === "rejected" || data?.status === "withdrawn" || data?.representation !== undefined || data?.sourceType === "source_document" || typeof data?.text === "string" || data?.truncated || data?.excerptOnly) return;
			continue;
		}
		if (!/\d\s*(?:个|件|只|张|pcs|卷|箱|包|套|roll|carton)/i.test(text)) {
			if (/(?:数量|总量|追加|加单|改为|改成|撤回|取消|quantity|count|[一二三四五六七八九十百千万两]+\s*(?:个|件|只|张|卷|箱|包|套))/i.test(text)) return;
			continue;
		}
		const other = explicitQuantity(text, productType);
		if (!other || compareRequirementField("quantity", corrected, other).status !== "equivalent") return;
	}
	return { fact: { ...fact, value: corrected.value }, audit: {
		field: "quantity", previousValue: fact.value, value: corrected.value, unit: fact.unit,
		status: "unverified", sourceRef: source.ref, sourceVersion: source.version, quote,
		reason: "explicit_original_quantity", previousFactVersion: current?.version ?? null,
	} };
}
