import { KnowledgeError, type EvidenceHit } from "../../src/enterprise/knowledge";

export interface RerankPort {
	readonly signature: string;
	score(query: string, passages: string[], signal?: AbortSignal): Promise<{ scores: number[]; inputTokens: number; forwardPasses: number; durationMs: number }>;
}
export function rerankText(hit: EvidenceHit) {
	return `${hit.title}\n${hit.model}\n${hit.location.section}\n${hit.text}\n${JSON.stringify(hit.table ?? {})}`;
}
export async function rerankCandidates(reranker: RerankPort, query: string, hits: EvidenceHit[], signal?: AbortSignal) {
	if (hits.length > 20) throw new KnowledgeError("rerank_candidate_limit");
	signal?.throwIfAborted();
	const batch = await reranker.score(query, hits.map(rerankText), signal);
	signal?.throwIfAborted();
	if (batch.scores.length !== hits.length || batch.scores.some((s) => !Number.isFinite(s))) throw new KnowledgeError("rerank_invalid_scores", 503);
	const ranked = hits.map((hit, index) => ({ ...hit, rerankScore: batch.scores[index], candidateRank: index + 1 })).sort((a, b) => b.rerankScore - a.rerankScore || a.candidateRank - b.candidateRank);
	return { hits: ranked, usage: batch };
}

/** Offline contract fake, not retrieval-quality evidence. */
export class FakeReranker implements RerankPort {
	readonly signature = "fake-reranker.v1";
	async score(_query: string, passages: string[], signal?: AbortSignal) {
		signal?.throwIfAborted();
		return { scores: passages.map((_, i) => -i), inputTokens: 0, forwardPasses: 0, durationMs: 0 };
	}
}
