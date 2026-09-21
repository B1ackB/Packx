import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { KnowledgeError } from "../../src/enterprise/knowledge";
import { coffeeKnowledgeFixtures } from "../../src/manufacturing/knowledgeFixtures";
import { packagingRetrievalPolicy } from "../../src/manufacturing/knowledgeRetrieval";
import { FakeEmbedding } from "./embedding";
import { FakeReranker } from "./reranking";
import { KnowledgeStore } from "./store";

const scope = { tenantId: "tenant", workspaceId: "workspace" }, cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) cleanup(); });
async function setup(policy: "strict" | "degrade" = "degrade") {
	const root = mkdtempSync(join(tmpdir(), "packx-knowledge-recovery-")), embedding = new FakeEmbedding(), reranker = new FakeReranker();
	const store = new KnowledgeStore(root, embedding, undefined, undefined, packagingRetrievalPolicy, reranker, policy);
	cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
	const fixture = coffeeKnowledgeFixtures()[0];
	fixture.blocks = Array.from({ length: 10 }, (_, index) => ({ text: `coffee packaging ${index}: no PVC; 100 µm; 23 °C, 50% RH`, location: { section: "conditions", paragraph: index + 1 }, parameters: [] }));
	const doc = store.import(scope, fixture, "test"); await store.process(scope, doc.versionId);
	return { store, embedding, reranker, doc };
}

it("returns marked, bounded original candidates when optional reranking fails", async () => {
	const h = await setup(); h.reranker.score = async () => { throw new Error("temporary inference failure"); };
	const result = await h.store.search(scope, { query: "coffee", mode: "hybrid", limit: 3 });
	expect(result).toMatchObject({ status: "candidates", degradation: { effectiveMode: "hybrid", reason: "rerank_unavailable" }, reranking: { status: "failed", inputTokens: null, forwardPasses: null } });
	expect(result.hits).toHaveLength(3); expect(result.hits.every((hit) => hit.text.includes("no PVC; 100 µm"))).toBe(true);
	expect(result.assessment?.conclusionAllowed).toBe(false);
	expect(result.gaps).toContain("retrieval_degraded");
	expect(JSON.parse(String(h.store.audit(scope)[0].data)).degradation).toEqual(result.degradation);
	expect((await h.store.search({ ...scope, workspaceId: "other" }, { query: "coffee", mode: "hybrid" })).hits).toEqual([]);
});

it("can retain the prior strict policy for comparison", async () => {
	const h = await setup("strict"); h.reranker.score = async () => { throw new Error("temporary"); };
	expect(await h.store.search(scope, { query: "coffee", mode: "hybrid" })).toMatchObject({ status: "unavailable", hits: [] });
});

it("falls back once from hybrid to keywords for a temporary embedding failure without extra model calls", async () => {
	const h = await setup(); let calls = 0;
	h.embedding.embed = async () => { calls++; throw new KnowledgeError("local_embedding_unavailable", 503); };
	h.reranker.score = async () => { throw new Error("must not call the reranker on keyword fallback"); };
	const result = await h.store.search(scope, { query: "coffee", mode: "hybrid", limit: 2 });
	expect(result).toMatchObject({ status: "candidates", degradation: { effectiveMode: "keyword", reason: "embedding_unavailable" }, usage: { embeddingCalls: 1, generationCalls: 0, inputTokens: null, modelDurationMs: null } });
	expect(result.hits).toHaveLength(2); expect(result.reranking).toBeUndefined(); expect(calls).toBe(1);
	await expect(h.store.search(scope, { query: "coffee", mode: "vector" })).rejects.toThrow("local_embedding_unavailable");
});

it("rechecks revocation after both embedding and reranking failures", async () => {
	for (const step of ["embedding", "reranking"] as const) {
		const h = await setup();
		if (step === "embedding") h.embedding.embed = async () => { h.store.transition(scope, h.doc.versionId, "withdrawn", "test"); throw new KnowledgeError("local_embedding_unavailable", 503); };
		else h.reranker.score = async () => { h.store.transition(scope, h.doc.versionId, "withdrawn", "test"); throw new Error("temporary"); };
		const result = await h.store.search(scope, { query: "coffee", mode: "hybrid" });
		expect(result.hits).toEqual([]); expect(result.status).toBe("no_evidence");
	}
});

it("does not hide integrity failures or convert cancellation into degraded success", async () => {
	const h = await setup();
	h.embedding.embed = async () => { throw new KnowledgeError("embedding_model_digest_mismatch", 409); };
	await expect(h.store.search(scope, { query: "coffee", mode: "hybrid" })).rejects.toThrow("digest_mismatch");
	const other = await setup(), controller = new AbortController();
	other.reranker.score = async () => { controller.abort(new Error("user_cancelled")); throw new Error("temporary"); };
	await expect(other.store.search(scope, { query: "coffee", mode: "hybrid" }, "cancel", controller.signal)).rejects.toThrow("user_cancelled");
});

it("bounds a non-cooperative reranker and discards its late results", async () => {
	const h = await setup(); let resolve!: (value: Awaited<ReturnType<FakeReranker["score"]>>) => void;
	h.reranker.score = () => new Promise((done) => { resolve = done; });
	// AbortSignal.timeout uses platform timers rather than Vitest timers; replace only that boundary.
	const timeout = new AbortController(); const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
	const pending = h.store.search(scope, { query: "coffee", mode: "hybrid", limit: 2 });
	while (!resolve) await Promise.resolve();
	timeout.abort(new DOMException("deadline", "TimeoutError"));
	const result = await pending;
	expect(result.degradation?.reason).toBe("rerank_unavailable"); expect(result.hits).toHaveLength(2);
	resolve({ scores: [], inputTokens: 0, forwardPasses: 0, durationMs: 0 });
	expect(result.reranking?.status).toBe("failed"); timer.mockRestore();
});
