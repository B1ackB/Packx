import type { RequirementBriefMetricsView } from "../runtime/conversationContracts";

export interface RequirementTrialInput {
	observationId: string;
	caseId: string;
	reviewerAlias: string;
	sourceKind: "synthetic" | "authorized_real";
	artifactVersion: number;
	expectedAggregateVersion: number;
	startedAt: string;
	endedAt: string;
	recordedReviewMs: number;
	interruptions: number;
	correctionCount: number;
	criticalErrorCount: number;
	outcome: "usable" | "needs_work" | "abandoned";
	notes: string;
}

export interface RequirementTrialObservation {
	schemaVersion: "requirement-review-trial.v1";
	measurement: "self_reported_review_timer";
	runId: string;
	actorId: string;
	storedAt: string;
	input: RequirementTrialInput;
	runtimeSnapshot: RequirementBriefMetricsView["runtime"];
}

export function validRequirementTrial(value: unknown): value is RequirementTrialInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as RequirementTrialInput;
	const fields = ["observationId", "caseId", "reviewerAlias", "sourceKind", "artifactVersion", "expectedAggregateVersion", "startedAt", "endedAt", "recordedReviewMs", "interruptions", "correctionCount", "criticalErrorCount", "outcome", "notes"];
	const bounded = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
	const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
	const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
	return Object.keys(v).length === fields.length && Object.keys(v).every((key) => fields.includes(key))
		&& typeof v.observationId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,63}$/.test(v.observationId)
		&& bounded(v.caseId, 80) && bounded(v.reviewerAlias, 40)
		&& ["synthetic", "authorized_real"].includes(v.sourceKind)
		&& integer(v.artifactVersion, 1, Number.MAX_SAFE_INTEGER) && integer(v.expectedAggregateVersion, 1, Number.MAX_SAFE_INTEGER)
		&& date(v.startedAt) && date(v.endedAt) && Date.parse(v.endedAt) >= Date.parse(v.startedAt)
		&& integer(v.recordedReviewMs, 0, 86_400_000) && v.recordedReviewMs <= Date.parse(v.endedAt) - Date.parse(v.startedAt) + 1000
		&& [v.interruptions, v.correctionCount, v.criticalErrorCount].every((count) => integer(count, 0, 10_000))
		&& ["usable", "needs_work", "abandoned"].includes(v.outcome)
		&& typeof v.notes === "string" && v.notes.length <= 1000;
}
