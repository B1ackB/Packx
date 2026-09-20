import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cpus, release, totalmem } from "node:os";
import { AutoTokenizer } from "@huggingface/transformers";
import { KnowledgeStore, digest } from "../server/knowledge/store";
import { OnnxEmbedding, e5Model, e5Revision } from "../server/knowledge/onnxEmbedding";
import { OnnxReranker } from "../server/knowledge/onnxReranker";
import { rerankCandidates } from "../server/knowledge/reranking";
import { loadCoffeeCorpus } from "../server/manufacturing/coffeeOpenCorpus";
import { loadCoffeeSupplement } from "../server/manufacturing/coffeeSupplement";
import { packagingRetrievalPolicy } from "../src/manufacturing/knowledgeRetrieval";
import type { EvidenceHit } from "../src/enterprise/knowledge";
import { coverage, evidencePayload, mean, percentile, sourceDocuments, unionSpans, type ChunkCase, type Span } from "./knowledgeChunkingSupport";
import { nonWhitespace, packPackets, sentenceChunks, sentenceScore, type SentenceChunk } from "./knowledgeSentenceSupport";
import { overlapChunks, overlapVariants } from "./knowledgeOverlapSupport";
import { supplementCases } from "./knowledgeOverlapCases";

const corpus = [...loadCoffeeCorpus(), ...loadCoffeeSupplement()], docs = sourceDocuments(corpus);
const oldCases = JSON.parse(readFileSync("data/knowledge/chunking-v1/cases.json", "utf8")) as ChunkCase[];
const cases = [...oldCases, ...supplementCases(docs)], units = new Map(docs.flatMap((d) => d.units.map((u) => [u.id, u] as const)));
const fixture = resolve("data/knowledge/chunking-v3"), budget = 1024;
const protocol = {
	schema: "knowledge-overlap-rerank.v3", corpusHash: digest(corpus), caseHash: digest(cases), overlaps: overlapVariants,
	chunking: "Unchanged sentence-500 base boundaries; prepend complete trailing sentences within the same original paragraph up to 0/32/64 E5 tokens. Never split a sentence to fill overlap. Actual overlap can be zero. Table rows/headers/units/conditions/footnotes unchanged.",
	retrieval: { candidateK: 20, returnedK: 8, diagnosticK: 5, budgetTokens: budget, paths: ["keyword", "vector", "hybrid", "hybrid-top20", "hybrid-rerank20"], policy: packagingRetrievalPolicy.version, rerankQuery: "Original question, no translation or rewriting", rerankScores: "Uncalibrated logits; descending stable sort; no acceptance threshold; oversized pairs split at whitespace and use max window score; full evidence retained" },
	embedding: JSON.parse(readFileSync("docs/evidence/knowledge-model-lock.json", "utf8")), reranker: JSON.parse(readFileSync("docs/evidence/knowledge-reranker-lock.json", "utf8")),
	node: process.version, icu: process.versions.icu,
	sourceHashes: Object.fromEntries(["eval/knowledgeOverlap.ts", "eval/knowledgeOverlapCases.ts", "eval/knowledgeOverlapSupport.ts", "eval/knowledgeSentenceSupport.ts", "eval/knowledgeChunkingSupport.ts", "server/knowledge/store.ts", "server/knowledge/ranking.ts", "server/knowledge/reranking.ts", "server/knowledge/onnxReranker.ts", "server/knowledge/onnxEmbedding.ts", "server/knowledge/validation.ts", "server/knowledge/jats.ts", "server/manufacturing/coffeeSupplement.ts", "src/manufacturing/knowledgeRetrieval.ts"].map((p) => [p, digest(readFileSync(p, "utf8"))])),
	labels: "64 previously observed questions plus 16 new bilingual source-checked questions from two independent new families; new questions frozen before V3 execution. No expert gold. All paths use exactly the same seven documents and 80 cases; not directly comparable to V2's five-document totals.",
	decisionRule: "Primary metric: complete source bundle at 1024 tokens for hybrid and reranked hybrid. Report wins/losses and new-family slice. Prefer no overlap on ties; do not claim generalization from 2 families/16 provisional questions. Reranker latency/cost separately measured. No generation.",
};
function write(path: string, value: unknown) { writeFileSync(path + ".partial", JSON.stringify(value, null, "\t") + "\n"); renameSync(path + ".partial", path); }
if (process.argv.includes("--prepare")) {
	mkdirSync(fixture, { recursive: true });
	for (const [name, value] of [["protocol", protocol], ["cases", cases]] as const) {
		const path = resolve(fixture, name + ".json");
		if (existsSync(path)) assert.equal(digest(JSON.parse(readFileSync(path, "utf8"))), digest(value), "Frozen protocol changed: make a new version"); else write(path, value);
	}
	console.log(JSON.stringify({ prepared: true, protocolHash: digest(protocol), documents: corpus.length, cases: cases.length }));
} else {
	assert.equal(digest(JSON.parse(readFileSync(resolve(fixture, "protocol.json"), "utf8"))), digest(protocol));
	assert.equal(digest(JSON.parse(readFileSync(resolve(fixture, "cases.json"), "utf8"))), digest(cases));
	const root = resolve(".blackx-data/knowledge-overlap", digest(protocol).slice(0, 16)); mkdirSync(root, { recursive: true });
	const embedding = await OnnxEmbedding.create(), reranker = await OnnxReranker.create(), cancel = new AbortController();
	const stop = () => cancel.abort(new Error("experiment_cancelled")); process.once("SIGINT", stop);
	try {
		const tokenizer = await AutoTokenizer.from_pretrained(resolve(".blackx-data/knowledge-model", e5Model, e5Revision), { local_files_only: true });
		const count = (text: string): number => tokenizer(text, { add_special_tokens: false, truncation: false, padding: false }).input_ids.size;
		const scope = { tenantId: "chunking-eval", workspaceId: "coffee" }, indexes = [];
		for (const overlap of overlapVariants) {
			const dir = resolve(root, `overlap-${overlap}`), store = new KnowledgeStore(dir, embedding, undefined, undefined, packagingRetrievalPolicy);
			try {
				const map = new Map<string, SentenceChunk[]>(), documents = [];
				for (const doc of docs) {
					const chunks = overlapChunks(doc, overlap, count), base = sentenceChunks(doc, "sentence-500", count);
					const spans = unionSpans(chunks.flatMap((c) => c.spans));
					for (const u of doc.units) assert.equal(coverage(nonWhitespace([{ unitId: u.id, start: 0, end: u.text.length }], units), spans), 1);
					assert.deepEqual(chunks.filter((c) => c.block.table).map((c) => c.block.table), base.filter((c) => c.block.table).map((c) => c.block.table));
					const actual = chunks.filter((c) => !c.block.table).map((c) => {
						const i = chunks.indexOf(c), s = c.spans[0], original = base[i].spans[0];
						return s.start === original.start ? 0 : count(units.get(s.unitId)!.text.slice(s.start, original.start).trim());
					});
					const manifest = { ...doc.manifest, parser: { ...doc.manifest.parser, version: `${doc.manifest.parser.version}+overlap-${overlap}` }, blocks: chunks.map((c) => c.block) };
					const version = store.import(scope, manifest, "overlap-eval"), reused = version.status === "indexed", at = performance.now();
					await store.process(scope, version.versionId, cancel.signal); assert.equal(store.get(scope, version.versionId)?.status, "indexed"); map.set(doc.manifest.documentId, chunks);
					const metricsPath = resolve(dir, `${doc.manifest.documentId}.json`);
					const event = store.audit(scope).find((e) => e.type === "knowledge.indexed" && e.correlation === version.versionId);
					const metrics = existsSync(metricsPath) ? JSON.parse(readFileSync(metricsPath, "utf8")) : { id: doc.manifest.documentId, chunks: chunks.length, prose: actual.length, overlapped: actual.filter(Boolean).length, overlapTokens: actual.reduce((a, b) => a + b, 0), maxOverlap: Math.max(...actual), actualOverlap: actual, indexMs: performance.now() - at, usage: event ? JSON.parse(String(event.data)).usage : null };
					write(metricsPath, metrics); documents.push(metrics); console.log(JSON.stringify({ overlap, indexed: doc.manifest.documentId, chunks: chunks.length, reused }));
				}
				const rowPath = resolve(dir, "rows.json"), rows: Row[] = existsSync(rowPath) ? JSON.parse(readFileSync(rowPath, "utf8")) : [];
				for (const item of cases) {
					if (rows.some((r) => r.id === item.id && r.path === "hybrid-rerank20")) continue;
					const query = { query: item.query, limit: 8, provenance: "public_source" as const, ...item.filters };
					const push = (path: string, hits: EvidenceHit[], retrievalMs: number, candidateHits = hits, rerank?: Awaited<ReturnType<typeof rerankCandidates>>["usage"]) => {
						const at = performance.now(), spansFor = (h: EvidenceHit): Span[] => map.get(h.documentId)![Number(h.evidenceId.split(":").at(-1)) - 1].spans;
						const packets = hits.slice(0, 8).map((h) => { store.readEvidence(scope, h.evidenceId, query); return { payload: evidencePayload(h), spans: spansFor(h), versionId: h.versionId }; });
						const packed = packPackets(packets, budget, count), selectedSpans = packed.selected.flatMap((p) => p.spans);
						const total = selectedSpans.reduce((n, s) => n + s.end - s.start, 0), unique = unionSpans(selectedSpans).reduce((n, s) => n + s.end - s.start, 0);
						rows.push({ id: item.id, path, newFamily: !oldCases.some((c) => c.id === item.id), language: item.language, table: item.expected.some((e) => e.location.table), top5: sentenceScore(item, hits.slice(0, 5).map(spansFor), units), candidateRecall: sentenceScore(item, candidateHits.map(spansFor), units)?.recall ?? null, budget: sentenceScore(item, packed.selected.map((p) => p.spans), units), rawNoAnswerCorrect: item.expected.length ? null : hits.length === 0, tokens: packed.tokens, duplicateSourceCharacters: total - unique, retrievalMs, rerankMs: rerank?.durationMs ?? 0, totalMs: retrievalMs + (rerank?.durationMs ?? 0) + performance.now() - at, rerankTokens: rerank?.inputTokens ?? 0, rerankPasses: rerank?.forwardPasses ?? 0, hits: hits.map((h) => ({ id: h.evidenceId, rerankScore: h.rerankScore })), selected: packed.selected.map((p) => p.payload.evidenceId), skipped: packed.skipped });
					};
					for (const mode of ["keyword", "vector", "hybrid"] as const) {
						const result = await store.search(scope, { ...query, mode }, `overlap:${overlap}:${mode}:${item.id}`, cancel.signal); push(mode, result.hits, result.durationMs);
					}
					const result = await store.searchCandidates(scope, { ...query, mode: "hybrid" }, `overlap:${overlap}:candidates:${item.id}`, cancel.signal);
					push("hybrid-top20", result.hits, result.durationMs);
					const ranked = await rerankCandidates(reranker, item.query, result.hits, cancel.signal);
					push("hybrid-rerank20", ranked.hits, result.durationMs, result.hits, ranked.usage);
					write(rowPath, rows); if (rows.length % 50 === 0) console.log(JSON.stringify({ overlap, completedQueries: rows.length / 5 }));
				}
				const paths = protocol.retrieval.paths.map((path) => {
					const selected = rows.filter((r) => r.path === path);
					return { path, metrics: summarize(selected), newFamilies: summarize(selected.filter((r) => r.newFamily)), existingFamilies: summarize(selected.filter((r) => !r.newFamily)), chinese: summarize(selected.filter((r) => r.language === "zh")), english: summarize(selected.filter((r) => r.language === "en")), failures: selected.filter((r) => r.budget && r.budget.complete < 1).map((r) => r.id) };
				});
				indexes.push({ overlap, documents, paths, rows }); console.log(JSON.stringify({ overlap, paths }));
			} finally { store.close(); }
		}
		write(resolve("docs/evidence/knowledge-overlap-rerank-v3.json"), { protocol, protocolHash: digest(protocol), completedAt: new Date().toISOString(), root, hardware: { cpu: cpus()[0]?.model, cores: cpus().length, memory: totalmem(), os: release(), concurrency: 1, onnxThreads: [2, 1] }, indexes, paidCalls: 0, generationCalls: 0, generationCost: null });
	} finally { process.removeListener("SIGINT", stop); await embedding.close(); await reranker.close(); }
}
interface Row {
	id: string; path: string; newFamily: boolean; language: string; table: boolean; top5: ReturnType<typeof sentenceScore>; candidateRecall: number | null; budget: ReturnType<typeof sentenceScore>; rawNoAnswerCorrect: boolean | null; tokens: number; duplicateSourceCharacters: number; retrievalMs: number; rerankMs: number; totalMs: number; rerankTokens: number; rerankPasses: number; hits: Array<{ id: string; rerankScore?: number }>; selected: string[]; skipped: ReturnType<typeof packPackets>["skipped"];
}
function summarize(rows: Row[]) {
	const answerable = rows.filter((r) => r.budget);
	return { cases: rows.length, answerable: answerable.length, recallAt5: mean(answerable.map((r) => r.top5!.recall)), mrrAt5: mean(answerable.map((r) => r.top5!.mrr)), candidateRecall: mean(answerable.map((r) => r.candidateRecall!)), completeAt1024: mean(answerable.map((r) => r.budget!.complete)), rawNoAnswerAccuracy: mean(rows.flatMap((r) => r.rawNoAnswerCorrect === null ? [] : [Number(r.rawNoAnswerCorrect)])), tokensMean: mean(rows.map((r) => r.tokens)), duplicateCharactersMean: mean(rows.map((r) => r.duplicateSourceCharacters)), retrievalP50: percentile(rows.map((r) => r.retrievalMs), .5), retrievalP95: percentile(rows.map((r) => r.retrievalMs), .95), rerankP50: percentile(rows.map((r) => r.rerankMs), .5), rerankP95: percentile(rows.map((r) => r.rerankMs), .95), totalP50: percentile(rows.map((r) => r.totalMs), .5), totalP95: percentile(rows.map((r) => r.totalMs), .95), rerankTokens: rows.reduce((n, r) => n + r.rerankTokens, 0), rerankPasses: rows.reduce((n, r) => n + r.rerankPasses, 0) };
}
