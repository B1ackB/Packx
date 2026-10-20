import type { EnterpriseEvent, FactVersionState, ProposalRunState } from "../../src/enterprise/contracts";
import type { RequirementSourceView } from "../../src/runtime/conversationContracts";
import type { RequirementBriefV1, RequirementFactV1 } from "../../src/manufacturing/requirementBrief";
import { packagingFactKeys, requiredRequirementFacts } from "../../src/manufacturing/requirementBrief";
import { compareRequirementField } from "../../src/manufacturing/requirementField";
import { factSourceReference } from "../knowledge/service";
import type { ReviewEvidence } from "../enterprise/evidenceReviewWorkflow";
import { messageEvidence } from "./requirementCandidateConflicts";
import { originalCustomerText } from "./requirementCorrections";

export function sourceExcerpt(text: string, value: string | number | boolean): { text: string; truncated: boolean } {
	const at = text.indexOf(String(value));
	const start = Math.max(0, at - 240);
	const end = Math.min(text.length, start + 1600);
	return { text: `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`, truncated: start > 0 || end < text.length };
}

export function requirementSourceViews(state: ProposalRunState, events: EnterpriseEvent[], sources: RequirementSourceView[]): Record<string, RequirementSourceView> {
	return Object.fromEntries(Object.values(state.facts).filter((fact) => packagingFactKeys.includes(fact.key)).map((fact) => {
		const ref = factSourceReference(events, fact.key, fact.version) ?? fact.sourceRef;
		const source = sources.find((item) => item.ref === ref);
		const excerpt = source?.text ? sourceExcerpt(source.text, fact.value) : undefined;
		return [fact.key, source ? { ...source, ...excerpt, truncated: Boolean(source.truncated || excerpt?.truncated) } : { ref, status: "unavailable", label: ref }];
	}));
}

/** A conservative absence check, not proof that a number has the right meaning or units. */
export function unsupportedNarrativeNumbers(brief: RequirementBriefV1, sourceContent: unknown): string[] {
	const numbers = (text: string) => text.replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, (value) => value.replaceAll(",", "")).match(/\d+(?:\.\d+)?/g) ?? [];
	const supported = new Set(numbers(JSON.stringify(sourceContent)));
	// Only this occurrence is schema metadata; the same number elsewhere still needs a source.
	const narrative = [brief.title, brief.customerGoal, ...brief.assumptions].join("\n").replace(
		/(?<![\d.,+\-])(\d+)\s*(?:(?:个|项)\s*必填字段|required fields\b)/gi,
		(phrase: string, count: string) => Number(count) === requiredRequirementFacts[brief.industry].length ? phrase.replace(count, "") : phrase,
	);
	return [...new Set(numbers(narrative))].filter((number) => !supported.has(number));
}

/** Read-only representation comparison; never adds a basis to the confirmed Fact. */
export function sameConfirmedDelivery(current: FactVersionState, candidate: RequirementFactV1, evidence: ReviewEvidence[], events: EnterpriseEvent[]): boolean {
	if (current.key !== "target_delivery" || current.status !== "verified" || current.sourceType !== "human_confirmation" ||
		compareRequirementField(current.key, current, candidate).reason !== "delivery_basis_requires_confirmation") return false;
	const confirmation = events.findLast(event => event.data.type === "fact.version_recorded" && event.data.factKey === current.key &&
		event.data.factVersion === current.version && event.data.status === "verified" && event.data.sourceType === "human_confirmation" &&
		event.data.value === current.value && event.data.unit === current.unit && event.data.sourceRef === current.sourceRef);
	if (!confirmation) return false;
	const frozenEvents = events.filter(event => event.aggregateVersion <= confirmation.aggregateVersion);
	const ref = factSourceReference(frozenEvents, current.key, current.version);
	if (candidate.sourceRef !== ref && candidate.sourceRef !== current.sourceRef) return false;
	const frozen = messageEvidence(frozenEvents).findLast(item => item.ref === ref);
	const live = evidence.filter(item => item.ref === ref);
	const original = frozen && originalCustomerText(frozen);
	if (!frozen || !original || live.length !== 1 || live[0].version !== frozen.version || originalCustomerText(live[0]) !== original) return false;
	const qualified = [current.value, candidate.value].map(value => String(value).normalize("NFKC").replaceAll(/\s/g, "")).find(value => /^\d{4}-\d{2}-\d{2}(?:到货|出货)$/.test(value));
	const deliveryText = /\d{4}-\d{2}-\d{2}|到货|出货|交期|交货|发货/;
	const explicit = (text: string) => {
		const clauses = text.normalize("NFKC").split(/[，,。；;\n]/).filter(clause => deliveryText.test(clause));
		if (clauses.length !== 1 || /不是|不要|并非|未定|待|或|改|取消|撤回|可能|预计|大约|旧|原来|之前|[?？]/.test(clauses[0]) ||
			(clauses[0].match(/\d{4}-\d{2}-\d{2}/g) ?? []).length !== 1 || (clauses[0].match(/到货|出货/g) ?? []).length !== 1) return;
		return /(\d{4}-\d{2}-\d{2})\s*(到货|出货)/.exec(clauses[0])?.slice(1).join("");
	};
	if (!qualified || explicit(original) !== qualified) return false;
	return evidence.every(item => {
		const text = originalCustomerText(item);
		if (text !== undefined) return !deliveryText.test(text.normalize("NFKC")) || explicit(text) === qualified;
		const data = item.content as Record<string, unknown> | null;
		return !(data?.truncated || data?.excerptOnly || data?.sourceType === "source_document" || data?.representation !== undefined ||
			typeof data?.text === "string" || ["unreadable", "withdrawn", "rejected"].includes(String(data?.status)));
	});
}
