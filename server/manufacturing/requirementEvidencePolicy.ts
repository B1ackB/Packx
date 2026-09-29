import { isDeepStrictEqual } from "node:util";
import { createRequirementBrief, evaluateRequirementBrief, requiredRequirementFacts, optionalPackagingFacts, type RequirementBriefV1 } from "../../src/manufacturing/requirementBrief";
import type { EvidenceReviewPolicy, ReviewEvidence } from "../enterprise/evidenceReviewWorkflow";
import type { EvidenceReviewIssue } from "../../src/enterprise/evidenceReview";
import { originalCustomerText } from "./requirementCorrections";

function omissionSourceNotes(issue: EvidenceReviewIssue, evidence: ReviewEvidence[]) {
	if (issue.kind !== "omission" || issue.location !== "/facts" || issue.suggestedAction !== "revise") return [];
	return evidence.filter(item => issue.evidenceRefs.includes(item.ref)).flatMap(item => {
		const text = originalCustomerText(item);
		const note = text && `客户原文引用（${item.ref}）：${text}`;
		return note && note.length <= 2000 ? [note] : [];
	});
}

export function requirementReviewOutputLimit(value: string | undefined, modelCeiling: number): number | undefined {
	if (value === undefined) return undefined;
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > modelCeiling) throw new Error("PACKX_REVIEW_MAX_OUTPUT_TOKENS must be positive and no greater than PACKX_MODEL_MAX_OUTPUT_TOKENS");
	return limit;
}

export const requirementEvidencePolicy: EvidenceReviewPolicy = {
	version: "packaging-requirement-evidence.v2.6",
	instructions: [
		"This is a packaging presales requirement brief, not a production-ready specification. Check every customer requirement, including narrative constraints outside the canonical fact fields. Missing fields explicitly listed for clarification and unverified values explicitly awaiting confirmation are not themselves defects. Never invent dimensions, materials, quantities, prices, certifications, tooling or process parameters. Check claims in title, customerGoal and assumptions as well as facts. Verified facts cannot be changed. A plan's confirmation is only execution authorization. Scope changes require reconfirm_plan. Attachment metadata, unreadable scans and model summaries are not original textual evidence.",
		"Prefer direct correction of draft narrative errors when the original evidence is clear and consistent. For omission, unsupported or contradiction issues in /title, /customerGoal, /assumptions or a specific /assumptions/N, cite the supporting original evidence and use revise. For example, if the customer explicitly forbids PVC but customerGoal says PVC is allowed, revise that sentence to preserve the prohibition without asking the customer again. Use request_input only when correction needs a customer decision, original sources disagree, intent or evidence is insufficient, or a Fact/status/source/other protected field would need changing. Never resolve a real source conflict by choosing one side. Report the location of the defect separately from what is safe to repair: a missing narrative customer constraint may be repaired in assumptions even if reported at /facts. For such an omission the Host can append the complete cited short original text as a quotation, without confirming a Fact or adding another customer confirmation gate; do not edit Facts. Mixed findings requiring input must remain unresolved; scope changes require reconfirm_plan. Every revision is independently reviewed again.",
		`The complete required field set is ${requiredRequirementFacts.print.join(", ")}. Optional supported fields are ${optionalPackagingFacts.join(", ")}. Do not reopen explicit customer constraints or invent ambiguity in an explicitly stated arrival date. Clarification questions must address real missing information or conflicts; optional production details and internal run IDs are not customer requirements. Do not require absent optional fields, prices, production feasibility, final artwork or supplier qualifications for a presales requirement handoff when their limitations are explicitly stated. An artwork_status of not yet designed is a supplied value. Provided optional values must be recorded without becoming verified automatically. Preserve explicit customer statements that optional specifications or performance are still undecided as limitations, without inventing extra mandatory fields. Domain-generated questions for currently missing required fields must remain specific.`,
		"A model_output sourceType describes who extracted the value, not whether its sourceRef is original evidence. Check the referenced message, attachment or page supplied in evidence. Human confirmation verifies the stated order field only, never supplier certification. Unverified raw source containers (customer_brief, customer_attachments, plan_source, knowledge_source) and stale previous artifacts are Host bookkeeping, not additional customer confirmation gates. Reject a narrative that invents such a gate; keep actual business field confirmation requirements. New proposals against verified values remain pending and block handoff until explicitly confirmed. Conflicting dimensions and incompatible count units must remain unresolved. Check specific clarification questions and test conditions when their evidence is cited. Use JSON Pointer locations such as /assumptions/0, not candidate.assumptions[0]. Keep issues concise; do not repeat all evidence or report correctly disclosed unknowns as unsupported claims.",
	],
	evaluate: evaluateRequirementBrief,
	canRevise: (issues, evidence = []) => issues.length > 0 && issues.every((issue) =>
		issue.suggestedAction === "revise" && issue.evidenceRefs.length > 0 && ["omission", "unsupported", "contradiction"].includes(issue.kind) &&
		(/^\/(title|customerGoal|assumptions(?:\/\d+)?)$/.test(issue.location) || omissionSourceNotes(issue, evidence).length > 0)),
	revisionSchema: {
		type: "object", properties: {
			title: { type: "string", minLength: 1, maxLength: 500 },
			customerGoal: { type: "string", minLength: 1, maxLength: 8000 },
			assumptions: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 2000 } },
		}, required: ["title", "customerGoal", "assumptions"], additionalProperties: false,
	},
	applyRevision(content, output, issues, evidence = []) {
		if (!requirementEvidencePolicy.canRevise(issues, evidence)) throw new Error("revision_out_of_scope");
		const patch = JSON.parse(output);
		if (!patch || Object.keys(patch).sort().join() !== "assumptions,customerGoal,title" ||
			typeof patch.title !== "string" || !patch.title.trim() || patch.title.length > 500 ||
			typeof patch.customerGoal !== "string" || !patch.customerGoal.trim() || patch.customerGoal.length > 8000 ||
			!Array.isArray(patch.assumptions) || patch.assumptions.length > 30 ||
			patch.assumptions.some((v: unknown) => typeof v !== "string" || !v.trim() || v.length > 2000)) throw new Error("revision_out_of_scope");
		const candidate = content as RequirementBriefV1;
		const sourceNotes = issues.flatMap(issue => omissionSourceNotes(issue, evidence));
		for (const field of ["title", "customerGoal", "assumptions"] as const) {
			if (isDeepStrictEqual(candidate[field], patch[field])) continue;
			if (issues.some((issue) => issue.location === `/${field}`)) continue;
			if (field === "assumptions" && patch.assumptions.length >= candidate.assumptions.length && candidate.assumptions.every((value, index) => value === patch.assumptions[index]) && patch.assumptions.slice(candidate.assumptions.length).every((value: string) => sourceNotes.includes(value))) continue;
			if (field !== "assumptions" || candidate.assumptions.length !== patch.assumptions.length || candidate.assumptions.some((value, index) => value !== patch.assumptions[index] && !issues.some((issue) => issue.location === `/assumptions/${index}`))) throw new Error("unrequested_revision");
		}
		// A broad omission can only add verbatim, source-bound notes; it never authorizes a Fact edit.
		const revised = createRequirementBrief({ ...candidate, ...patch, assumptions: [...patch.assumptions, ...sourceNotes] });
		if (!evaluateRequirementBrief(revised).passed || !isDeepStrictEqual(revised.facts, candidate.facts)) throw new Error("invalid_revision");
		if (isDeepStrictEqual(revised, candidate)) throw new Error("revision_no_progress");
		return revised;
	},
};
