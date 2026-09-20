import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { cpus, platform, release, totalmem } from "node:os";
import { KnowledgeStore, digest } from "../server/knowledge/store";
import { OnnxEmbedding } from "../server/knowledge/onnxEmbedding";
import { loadCoffeeCorpus } from "../server/manufacturing/coffeeOpenCorpus";
import { realKnowledgeCases, granularTasks } from "./knowledgeRealCases";
import { packagingRetrievalPolicy, expandPackagingQuery } from "../src/manufacturing/knowledgeRetrieval";
import type { EvidenceResult, KnowledgeRetrievalPolicy } from "../src/enterprise/knowledge";

// Choose on development only. --all is a subsequent, explicitly observed regression set, not a fresh blind test.
const all = process.argv.includes("--all");
const corpus = loadCoffeeCorpus(), root = resolve(".blackx-data/knowledge-real-eval", digest(corpus).slice(0, 16));
assert.equal(digest(realKnowledgeCases), digest(JSON.parse(readFileSync("data/knowledge/coffee-open-v1/questions.v1.json", "utf8"))));
const cases = realKnowledgeCases.filter((q) => all || q.split === "development");
const sourceHashes = { policySourceHash: digest(readFileSync("src/manufacturing/knowledgeRetrieval.ts", "utf8")), rankingSourceHash: digest(readFileSync("server/knowledge/ranking.ts", "utf8")), storeSourceHash: digest(readFileSync("server/knowledge/store.ts", "utf8")) };
const development = all ? JSON.parse(readFileSync("docs/evidence/knowledge-optimization-development.json", "utf8")) : undefined;
if (development) for (const [key, hash] of Object.entries(sourceHashes)) assert.equal(development[key], hash, "Candidate changed since development measurement; rerun development before regression");
const embedding = await OnnxEmbedding.create();
const variants: Array<{ name: string; policy?: KnowledgeRetrievalPolicy }> = [
	{ name: "baseline" },
	{ name: "bilingual-only", policy: { ...packagingRetrievalPolicy, version: "ablation-bilingual.v1", lexical: "overlap", diversifyTables: false } },
	{ name: "field-idf-only", policy: { ...packagingRetrievalPolicy, version: "ablation-idf.v1", diversifyTables: false, prepare: (query) => ({ lexicalQuery: query, vectorQuery: query }) } },
	{ name: "bilingual-idf", policy: { ...packagingRetrievalPolicy, version: "ablation-bilingual-idf.v1", diversifyTables: false } },
	{ name: "bilingual-idf-diverse", policy: packagingRetrievalPolicy },
];
const scope = { tenantId: "research-eval", workspaceId: "coffee" };
const key = (hit: EvidenceResult["hits"][number]) => `${hit.documentId}:${hit.evidenceId.split(":").at(-1)}`;
const avg = (values: number[]) => values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
const quantile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const runs = [];
try {
	for (const variant of variants) {
		const store = new KnowledgeStore(root, embedding, undefined, undefined, variant.policy);
		try {
			assert.equal(store.list(scope).filter((d) => d.status === "indexed" && d.manifest.provenance === "public_source").length, 5, "Run eval:knowledge-real first");
			for (const mode of ["keyword", "vector", "hybrid"] as const) {
				const rows = [];
				for (const item of cases) {
					const result = await store.search(scope, { query: item.query, mode, limit: 5, provenance: "public_source", ...item.filters }, `${variant.name}:${item.id}`);
					const found = result.hits.map(key), expected = item.expected.map((e) => `${e.documentId}:${e.block}`), rank = found.findIndex((id) => expected.includes(id));
					rows.push({ id: item.id, query: item.query, category: item.category, language: item.language, split: item.split, found, expected, recall: expected.length ? expected.filter((k) => found.includes(k)).length / expected.length : null, mrr: expected.length ? rank < 0 ? 0 : 1 / (rank + 1) : null, rawNoAnswerCorrect: expected.length ? null : found.length === 0, status: result.status, retrievalVersion: result.retrievalVersion, assessment: result.assessment, durationMs: result.durationMs, usage: result.usage });
				}
				const metrics = { recallAt5: avg(rows.flatMap((r) => r.recall === null ? [] : [r.recall])), mrr: avg(rows.flatMap((r) => r.mrr === null ? [] : [r.mrr])), zhRecallAt5: avg(rows.flatMap((r) => r.language === "zh" && r.recall !== null ? [r.recall] : [])), enRecallAt5: avg(rows.flatMap((r) => r.language === "en" && r.recall !== null ? [r.recall] : [])), rawNoAnswerAccuracy: avg(rows.flatMap((r) => r.rawNoAnswerCorrect === null ? [] : [Number(r.rawNoAnswerCorrect)])), p50Ms: quantile(rows.map((r) => r.durationMs), .5), p95Ms: quantile(rows.map((r) => r.durationMs), .95), embeddingTokens: rows.reduce((sum, r) => sum + (r.usage.inputTokens ?? 0), 0) };
				const fieldChecks = { productionQuestions: rows.filter((r) => r.category === "no_answer").length, productionQuestionsWithMissingField: rows.filter((r) => r.category === "no_answer" && r.assessment?.checks.some((c) => c.status === "missing")).length, answerableQuestionsMarkedInsufficient: rows.filter((r) => r.expected.length && r.assessment?.status === "insufficient_evidence").length, sourceValuesAvailable: rows.filter((r) => r.assessment?.status === "source_values_available").length, semanticCorrectness: null };
				runs.push({ variant: variant.name, mode, metrics, fieldChecks, rows }); console.log(JSON.stringify({ variant: variant.name, mode, ...metrics }));
			}
		} finally { store.close(); }
	}
	const granular = [];
	if (all) for (const variant of [variants[0], variants.at(-1)!]) {
		const store = new KnowledgeStore(root, embedding, undefined, undefined, variant.policy);
		try { for (const task of granularTasks) for (const mode of ["keyword", "vector", "hybrid"] as const) {
			const broad = await store.search(scope, { query: task.broad, mode, limit: 8 });
			const atomic = []; for (const query of task.questions) atomic.push(await store.search(scope, { query, mode, limit: 2 }));
			const found = atomic.flatMap((r) => r.hits.map(key));
			granular.push({ variant: variant.name, id: task.id, mode, broadCoverage: task.expected.filter((k) => broad.hits.map(key).includes(k)).length / task.expected.length, atomicCoverage: task.expected.filter((k) => found.includes(k)).length / task.expected.length, queries: { broad: 1, atomic: 4 }, tokens: { broad: broad.usage.inputTokens, atomic: atomic.reduce((n, r) => n + (r.usage.inputTokens ?? 0), 0) }, found });
		} } finally { store.close(); }
	}
	const report = { schemaVersion: "knowledge-optimization.v1", executedAt: new Date().toISOString(), caseCount: cases.length, selection: all ? "observed-regression-not-blind" : "development", selectedCandidate: "bilingual-idf-diverse", developmentReportHash: development ? digest(development) : null, corpusHash: digest(corpus), caseHash: digest(realKnowledgeCases), ...sourceHashes, model: embedding.signature, indexUnchanged: true, documents: 5, chunks: 568, concurrency: 1, humanReviewedCases: 0, hardware: { cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), platform: platform(), release: release(), node: process.version }, budget: "K=5; one query embedding per vector/hybrid search; expanded query has additional tokens, no extra model calls", runs, granular, exampleExpansion: expandPackagingQuery("REC 膜的 OPPHP 厚度和克重"), generation: { calls: 0, costUsd: null, supportedAnswerAccuracy: null }, warning: "Structured-support assessment is not free-text entailment or an answer correctness score. Previous frozen labels have been observed; no independent generalization claim." };
	mkdirSync("docs/evidence", { recursive: true }); writeFileSync(`docs/evidence/knowledge-optimization-${all ? "regression" : "development"}.json`, JSON.stringify(report, null, "\t") + "\n");
} finally { await embedding.close(); }
