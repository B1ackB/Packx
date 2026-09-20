import type { EvidenceHit, EvidenceResult, EvidenceSelection, KnowledgeDocument, EvidenceParameterRef, ParameterEvidence } from "../enterprise/knowledge";
import type { knowledgeSources, knowledgeCoverage } from "../manufacturing/knowledgeSources";
import type { coffeeEvidenceReview } from "../manufacturing/packagingKnowledge";

export interface KnowledgeView {
	documents: KnowledgeDocument[];
	jobs: Array<{ jobId: string; versionId: string; status: string; lastFailure?: { code: string }; failureCount: number; recoveryCount: number }>;
	sources: typeof knowledgeSources;
	coverage: typeof knowledgeCoverage;
	selection?: EvidenceSelection;
	hits: EvidenceHit[];
	unavailable: string[];
	review: ReturnType<typeof coffeeEvidenceReview>;
	embedding: { signature: string; kind: string };
}
export interface KnowledgeSearchView { result: EvidenceResult; review: ReturnType<typeof coffeeEvidenceReview>; questions?: Array<{ field: string; question: string }> }
export interface PackagingComparisonInput { left: EvidenceParameterRef; right: EvidenceParameterRef; region?: string; asOf?: string }
export interface PackagingComparisonResult {
	schemaVersion: "packaging-comparison.v1";
	ruleVersion: string;
	correlationId: string;
	createdAt: string;
	filters: { region?: string; asOf?: string };
	status: "comparable" | "needs_review";
	verification: "unverified";
	conclusionAllowed: false;
	left: ParameterEvidence;
	right: ParameterEvidence;
	comparison: Omit<ReturnType<typeof import("../manufacturing/packagingKnowledge").compareParameters>, "left" | "right">;
	questions: string[];
	warnings: string[];
	durationMs: number;
	usage: { embeddingCalls: 0; generationCalls: 0 };
}
