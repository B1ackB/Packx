import type { RuntimeTurnResult } from "../runtime/contracts";

export interface EvidenceReviewIssue {
	kind: "omission" | "unsupported" | "contradiction" | "insufficient_evidence" | "scope_change";
	location: string;
	evidenceRefs: string[];
	reason: string;
	suggestedAction: "revise" | "request_input" | "reconfirm_plan";
}

export interface EvidenceReviewReport {
	schemaVersion: "evidence-review.v1";
	artifactId: string;
	artifactVersion: number;
	inputFactVersions: Record<string, number>;
	inputDigest: string;
	sourceVersions: Array<{ ref: string; version: string | number }>;
	status: "completed" | "failed";
	issues: EvidenceReviewIssue[];
	failure?: string;
	runtime?: Pick<RuntimeTurnResult, "executionId" | "adapter" | "contextSnapshotId" | "usage">;
	durationMs: number;
}

export const evidenceReviewSchema = {
	type: "object",
	properties: {
		issues: { type: "array", maxItems: 30, items: {
			type: "object",
			properties: {
				kind: { enum: ["omission", "unsupported", "contradiction", "insufficient_evidence", "scope_change"] },
				location: { type: "string", minLength: 1, maxLength: 200 },
				evidenceRefs: { type: "array", maxItems: 20, items: { type: "string" } },
				reason: { type: "string", minLength: 1, maxLength: 2000 },
				suggestedAction: { enum: ["revise", "request_input", "reconfirm_plan"] },
			},
			required: ["kind", "location", "evidenceRefs", "reason", "suggestedAction"], additionalProperties: false,
		} },
	},
	required: ["issues"], additionalProperties: false,
} as const;

export function parseEvidenceReview(text: string, refs: string[]): EvidenceReviewIssue[] {
	const value = JSON.parse(text);
	if (!value || Object.keys(value).join() !== "issues" || !Array.isArray(value.issues) || value.issues.length > 30) throw new Error("invalid_review");
	for (const issue of value.issues) {
		if (!issue || Object.keys(issue).sort().join() !== "evidenceRefs,kind,location,reason,suggestedAction" ||
			!evidenceReviewSchema.properties.issues.items.properties.kind.enum.includes(issue.kind) ||
			!evidenceReviewSchema.properties.issues.items.properties.suggestedAction.enum.includes(issue.suggestedAction) ||
			typeof issue.location !== "string" || !issue.location.trim() || issue.location.length > 200 ||
			typeof issue.reason !== "string" || !issue.reason.trim() || issue.reason.length > 2000 ||
			!Array.isArray(issue.evidenceRefs) || issue.evidenceRefs.length > 20 ||
			issue.evidenceRefs.some((ref: unknown) => typeof ref !== "string" || !refs.includes(ref)) ||
			(issue.kind !== "insufficient_evidence" && issue.evidenceRefs.length === 0)) throw new Error("invalid_review");
	}
	return value.issues;
}
