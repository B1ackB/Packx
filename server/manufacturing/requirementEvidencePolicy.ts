import { isDeepStrictEqual } from "node:util";
import { evaluateRequirementBrief, type RequirementBriefV1 } from "../../src/manufacturing/requirementBrief";
import type { EvidenceReviewPolicy } from "../enterprise/evidenceReviewWorkflow";

export const requirementEvidencePolicy: EvidenceReviewPolicy = {
	version: "packaging-requirement-evidence.v1",
	instructions: [
		"This is a packaging presales requirement brief, not a production-ready specification. Check every customer requirement, including narrative constraints outside the canonical fact fields. Missing fields explicitly listed for clarification and unverified values explicitly awaiting confirmation are not themselves defects. Never invent dimensions, materials, quantities, prices, certifications, tooling or process parameters. Check claims in title, customerGoal and assumptions as well as facts. Verified facts cannot be changed; contradictions with sources require human input. A plan's confirmation is only execution authorization. Scope changes require reconfirm_plan. Attachment metadata, unreadable scans and model summaries are not original textual evidence.",
	],
	evaluate: evaluateRequirementBrief,
	canRevise: (issues) => issues.length > 0 && issues.every((issue) =>
		issue.suggestedAction === "revise" && ["omission", "unsupported"].includes(issue.kind) &&
		/^\/(title|customerGoal|assumptions(?:\/\d+)?)$/.test(issue.location)),
	revisionSchema: {
		type: "object", properties: {
			title: { type: "string", minLength: 1, maxLength: 500 },
			customerGoal: { type: "string", minLength: 1, maxLength: 8000 },
			assumptions: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 2000 } },
		}, required: ["title", "customerGoal", "assumptions"], additionalProperties: false,
	},
	applyRevision(content, output, issues) {
		const patch = JSON.parse(output);
		if (!patch || Object.keys(patch).sort().join() !== "assumptions,customerGoal,title" ||
			typeof patch.title !== "string" || !patch.title.trim() || patch.title.length > 500 ||
			typeof patch.customerGoal !== "string" || !patch.customerGoal.trim() || patch.customerGoal.length > 8000 ||
			!Array.isArray(patch.assumptions) || patch.assumptions.length > 30 ||
			patch.assumptions.some((v: unknown) => typeof v !== "string" || !v.trim() || v.length > 2000)) throw new Error("revision_out_of_scope");
		const candidate = content as RequirementBriefV1;
		for (const field of ["title", "customerGoal", "assumptions"] as const) {
			if (isDeepStrictEqual(candidate[field], patch[field])) continue;
			if (issues.some((issue) => issue.location === `/${field}`)) continue;
			if (field !== "assumptions" || candidate.assumptions.length !== patch.assumptions.length || candidate.assumptions.some((value, index) => value !== patch.assumptions[index] && !issues.some((issue) => issue.location === `/assumptions/${index}`))) throw new Error("unrequested_revision");
		}
		const revised = { ...candidate, ...patch };
		if (!evaluateRequirementBrief(revised).passed || !isDeepStrictEqual(revised.facts, candidate.facts)) throw new Error("invalid_revision");
		return revised;
	},
};
