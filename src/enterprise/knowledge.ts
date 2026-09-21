/** Evidence is a candidate observation, never a verified business Fact. */
export interface KnowledgeScope { tenantId: string; workspaceId: string }
export type KnowledgeProvenance = "public_source" | "user_authorized" | "synthetic";
export interface EvidenceLocation { page?: number; section: string; anchor?: string; paragraph?: number; part?: number; table?: string; row?: number }
export interface EvidenceParameter {
	name: string;
	subject?: string;
	originalValue: string;
	originalUnit: string;
	normalized?: { value: number; unit: string };
	method: string;
	conditions: string;
	testConditions?: Array<{ name: string; value: string; unit: string }>;
	scope: string;
	verification: "unverified" | "human_reviewed";
	authority: "supplier_claim" | "third_party_test" | "certificate_record" | "human_confirmation" | "research_report";
}
export interface EvidenceBlock {
	location: EvidenceLocation;
	text: string;
	table?: { headers: string[]; units: string[]; rows: string[][]; footnotes: string[]; conditions: string };
	parameters: EvidenceParameter[];
}
export interface KnowledgeImport {
	schemaVersion: "knowledge-import.v1";
	documentId: string;
	family: string;
	title: string;
	publisher: string;
	model: string;
	revision: string;
	sourceUrl: string;
	language: string;
	regions: string[];
	publishedAt: string | null;
	effectiveAt: string | null;
	expiresAt: string | null;
	provenance: KnowledgeProvenance;
	visibility: "workspace" | "public";
	permission: { basis: string; reference: string; checkedAt: string; expiresAt: string | null; storage: boolean; indexing: boolean; redistribution: boolean };
	parser: { name: string; version: string; status: "reviewed" | "needs_review" | "needs_ocr" | "failed"; reason: string };
	blocks: EvidenceBlock[];
}
export type KnowledgeStatus = "imported" | "parsed" | "indexed" | "needs_review" | "withdrawn" | "cancelled";
export interface KnowledgeDocument extends KnowledgeScope {
	versionId: string;
	contentHash: string;
	importedAt: string;
	status: KnowledgeStatus;
	indexRevision: number;
	failure: string | null;
	manifest: Omit<KnowledgeImport, "blocks">;
}
export interface EvidenceHit {
	evidenceId: string;
	versionId: string;
	contentHash: string;
	documentId: string;
	title: string;
	publisher: string;
	model: string;
	revision: string;
	sourceUrl: string;
	provenance: KnowledgeProvenance;
	location: EvidenceLocation;
	attribution?: string;
	text: string;
	table?: EvidenceBlock["table"];
	parameters: EvidenceParameter[];
	score: number;
	rerankScore?: number;
	candidateRank?: number;
	warnings: string[];
}
export interface EvidenceParameterRef { evidenceId: string; parameterIndex: number }
export type ParameterEvidence = Pick<EvidenceHit, "evidenceId" | "versionId" | "contentHash" | "documentId" | "title" | "publisher" | "model" | "revision" | "sourceUrl" | "provenance" | "location" | "attribution" | "warnings"> & { parameterIndex: number; parameter: EvidenceParameter };
export interface KnowledgeQuery {
	query: string;
	mode: "keyword" | "vector" | "hybrid";
	model?: string;
	region?: string;
	asOf?: string;
	provenance?: KnowledgeProvenance;
	limit?: number;
}
export interface EvidenceResult {
	schemaVersion: "evidence-result.v1";
	status: "candidates" | "no_evidence" | "unavailable";
	correlationId: string;
	indexVersion: string;
	corpusVersion: string;
	embedding: string;
	retrievalVersion?: string;
	assessment?: EvidenceAssessment;
	reranking?: { status: "completed" | "failed"; model: string; candidateCount: number; durationMs: number; inputTokens: number | null; forwardPasses: number | null; failure?: string };
	degradation?: { requestedMode: KnowledgeQuery["mode"]; effectiveMode: "keyword" | "hybrid"; reason: "embedding_unavailable" | "rerank_unavailable" };
	hits: EvidenceHit[];
	gaps: string[];
	durationMs: number;
	usage: { embeddingCalls: number; generationCalls: 0; costUsd: number | null; inputTokens: number | null; modelDurationMs: number | null };
}
/** A bounded check of structured evidence availability, not entailment or Fact verification. */
export interface EvidenceAssessment {
	status: "insufficient_evidence" | "source_values_available" | "needs_review";
	checks: Array<{ field: string; status: "missing" | "present" | "needs_review"; evidenceIds: string[]; question: string }>;
	conclusionAllowed: false;
}
export interface KnowledgeRetrievalPolicy {
	version: string;
	lexical: "overlap" | "field_idf";
	diversifyTables: boolean;
	prepare(query: string): { lexicalQuery: string; vectorQuery: string };
	assess?(query: string, hits: EvidenceHit[]): EvidenceAssessment;
}
export interface EvidenceSelection {
	schemaVersion: "evidence-selection.v1";
	version: number;
	selectedBy: string;
	selectedAt: string;
	ids: string[];
	applicability: { region: string; asOf: string };
	digest: string;
}
export class KnowledgeError extends Error {
	constructor(readonly code: string, readonly status = 400) { super(code); }
}
