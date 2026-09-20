import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { coffeeKnowledgeFixtures } from "../../src/manufacturing/knowledgeFixtures";
import { packagingRetrievalPolicy } from "../../src/manufacturing/knowledgeRetrieval";
import { KnowledgeStore } from "./store";
import { FakeEmbedding } from "./embedding";
import { FakeReranker } from "./reranking";
import { loadCoffeeCorpus } from "../manufacturing/coffeeOpenCorpus";
import { loadCoffeeSupplement } from "../manufacturing/coffeeSupplement";
import { sourceDocuments, coverage } from "../../eval/knowledgeChunkingSupport";
import { overlapChunks } from "../../eval/knowledgeOverlapSupport";
import { nonWhitespace, sentenceChunks, sentenceRanges } from "../../eval/knowledgeSentenceSupport";

const scope = { tenantId: "t", workspaceId: "w" }, other = { tenantId: "other", workspaceId: "other" };
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
function setup(reranker = new FakeReranker()) {
	const root = mkdtempSync(join(tmpdir(), "packx-rerank-")), store = new KnowledgeStore(root, new FakeEmbedding(), undefined, undefined, packagingRetrievalPolicy, reranker);
	cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); return store;
}
async function ingest(store: KnowledgeStore, owner = scope) {
	const fixture = coffeeKnowledgeFixtures()[0];
	fixture.blocks = Array.from({ length: 25 }, (_, n) => ({ text: `coffee packaging film sample ${n}`, location: { section: "samples", paragraph: n + 1 }, parameters: [] }));
	const doc = store.import(owner, fixture, "test"); await store.process(owner, doc.versionId); return doc;
}
it("reranks the actual top twenty; keeps Tool/API limit at eight; keyword skips the model", async () => {
	const fake = new FakeReranker(), observed: number[] = [];
	fake.score = async (_, passages) => { observed.push(passages.length); return { scores: passages.map((_, n) => n), inputTokens: 123, forwardPasses: passages.length, durationMs: 2 }; };
	const store = setup(fake); await ingest(store); await ingest(store, other);
	const result = await store.search(scope, { query: "coffee", mode: "hybrid", limit: 5 });
	expect(observed).toEqual([20]); expect(result.hits).toHaveLength(5); expect(result.hits[0].candidateRank).toBe(20);
	expect(result.reranking).toMatchObject({ status: "completed", inputTokens: 123, candidateCount: 20 });
	const event = store.audit(scope)[0]; expect(JSON.parse(String(event.data)).candidateIds).toHaveLength(20);
	await expect(store.search(scope, { query: "coffee", mode: "hybrid", limit: 20 })).rejects.toThrow("invalid_knowledge_query");
	await store.search(scope, { query: "coffee", mode: "keyword" }); expect(observed).toHaveLength(1);
	expect((await store.searchCandidates(scope, { query: "coffee", mode: "hybrid" })).hits).toHaveLength(20); expect(observed).toHaveLength(1);
});
it("does not pass another workspace or an inapplicable document to the reranker", async () => {
	const fake = new FakeReranker(); let calls = 0;
	fake.score = async () => { calls++; throw new Error("must not be called"); };
	const store = setup(fake); await ingest(store, other);
	expect((await store.search(scope, { query: "coffee", mode: "hybrid" })).hits).toEqual([]);
	await ingest(store);
	expect((await store.search(scope, { query: "coffee", mode: "hybrid", model: "unknown-model" })).hits).toEqual([]);
	expect((await store.search(scope, { query: "coffee", mode: "hybrid", asOf: "2000-01-01T00:00:00.000Z" })).hits).toEqual([]); expect(calls).toBe(0);
});
it("rechecks revocation after asynchronous reranking and refuses invalid model scores", async () => {
	const fake = new FakeReranker(), store = setup(fake), doc = await ingest(store);
	fake.score = async (_, passages) => { store.transition(scope, doc.versionId, "withdrawn", "test"); return { scores: passages.map(() => 1), inputTokens: 0, forwardPasses: 1, durationMs: 0 }; };
	expect((await store.search(scope, { query: "coffee", mode: "hybrid" })).hits).toEqual([]);
	const invalid = new FakeReranker(); invalid.score = async () => ({ scores: [NaN], inputTokens: 0, forwardPasses: 0, durationMs: 0 });
	const another = setup(invalid); await ingest(another);
	const result = await another.search(scope, { query: "coffee", mode: "hybrid" }); expect(result.status).toBe("unavailable"); expect(result.hits).toEqual([]); expect(result.gaps).toContain("rerank_unavailable"); expect(result.reranking?.inputTokens).toBeNull();
	expect(result.usage.embeddingCalls).toBe(1);
});
it("propagates cancellation without returning unreranked evidence", async () => {
	const fake = new FakeReranker(), store = setup(fake), abort = new AbortController(); await ingest(store);
	fake.score = async (_, passages) => { abort.abort(new Error("cancelled")); return { scores: passages.map(() => 0), inputTokens: 0, forwardPasses: 0, durationMs: 0 }; };
	await expect(store.search(scope, { query: "coffee", mode: "hybrid" }, "cancel", abort.signal)).rejects.toThrow("cancelled");
});
it("whole-sentence overlap preserves all source text and tables without inventing boundaries", () => {
	const count = (s: string) => s.split(/\s+/).length;
	for (const doc of sourceDocuments([...loadCoffeeCorpus(), ...loadCoffeeSupplement()])) for (const cap of [0, 32, 64]) {
		const base = sentenceChunks(doc, "sentence-500", count), chunks = overlapChunks(doc, cap, count), units = new Map(doc.units.map((u) => [u.id, u]));
		expect(chunks.length).toBe(base.length);
		chunks.forEach((c, i) => {
			if (c.block.table) { expect(c).toEqual(base[i]); return; }
			const s = c.spans[0], u = units.get(s.unitId)!;
			expect(sentenceRanges(u).some((sentence) => sentence.start === s.start)).toBe(true);
			if (s.start !== base[i].spans[0].start) expect(count(u.text.slice(s.start, base[i].spans[0].start).trim())).toBeLessThanOrEqual(cap);
			expect(s.end).toBe(base[i].spans[0].end);
		});
		for (const u of doc.units) expect(coverage(nonWhitespace([{ unitId: u.id, start: 0, end: u.text.length }], units), chunks.flatMap((c) => c.spans))).toBe(1);
	}
});
