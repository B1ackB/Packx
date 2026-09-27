import type { EnterpriseEvent, ProposalRunState } from "../../src/enterprise/contracts";
import type { RequirementSourceView } from "../../src/runtime/conversationContracts";
import type { RequirementBriefV1 } from "../../src/manufacturing/requirementBrief";
import { packagingFactKeys } from "../../src/manufacturing/requirementBrief";
import { factSourceReference } from "../knowledge/service";

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
	return [...new Set(numbers([brief.title, brief.customerGoal, ...brief.assumptions].join("\n")))].filter((number) => !supported.has(number));
}
