import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cpus, platform, release, totalmem } from "node:os";
import type { EvidenceParameter, EvidenceResult } from "../src/enterprise/knowledge";
import { compareParameters, comparisonRuleVersion, normalizeParameter } from "../src/manufacturing/packagingKnowledge";
import { packagingRetrievalPolicy } from "../src/manufacturing/knowledgeRetrieval";
import { KnowledgeStore, digest } from "../server/knowledge/store";
import { OnnxEmbedding } from "../server/knowledge/onnxEmbedding";
import { loadCoffeeCorpus } from "../server/manufacturing/coffeeOpenCorpus";
import { compareEvidence } from "../server/manufacturing/knowledgeComparison";
import { realKnowledgeCases } from "./knowledgeRealCases";

interface Case { id: string; origin: "synthetic_contract" | "real_source_pair"; left: EvidenceParameter; right: EvidenceParameter; expected: { comparable: boolean; difference?: number }; sources?: Array<{ documentId: string; block: number; parameterIndex: number }> }
const snapshot = JSON.parse(readFileSync("data/knowledge/comparison-v1/cases.json", "utf8")) as { corpusHash: string; cases: Case[] };
const baseline = JSON.parse(readFileSync("docs/evidence/knowledge-comparison-baseline.json", "utf8")) as { caseHash: string; results: Array<{ id: string; actual: { comparable: boolean; difference?: number } }> };
assert.equal(digest(snapshot), baseline.caseHash, "Do not rewrite pre-fix cases to match implementation");

// Frozen pre-fix Packx algorithm, retained only for repeatable paired evaluation; never used by the Host.
function legacyComparison(left: EvidenceParameter, right: EvidenceParameter) {
	const a = normalizeParameter(left), b = normalizeParameter(right), numeric = /^\d+(?:\.\d+)?$/;
	const av = a.normalized ?? (numeric.test(a.originalValue) ? { value: Number(a.originalValue), unit: a.originalUnit } : undefined);
	const bv = b.normalized ?? (numeric.test(b.originalValue) ? { value: Number(b.originalValue), unit: b.originalUnit } : undefined);
	const comparable = left.name === right.name && !!left.scope && left.scope === right.scope && !!left.method && left.method === right.method && !!left.conditions && left.conditions === right.conditions && !!av && !!bv && !!av.unit && av.unit === bv.unit && Number.isFinite(av.value) && Number.isFinite(bv.value);
	return { comparable, ...(comparable ? { difference: av!.value - bv!.value } : {}) };
}
const rows = snapshot.cases.map((item) => {
	const old = legacyComparison(item.left, item.right), actual = compareParameters(item.left, item.right);
	const recorded = baseline.results.find((r) => r.id === item.id)!.actual;
	assert.equal(old.comparable, recorded.comparable); assert.equal(old.difference, recorded.difference);
	assert.equal(actual.comparable, item.expected.comparable, item.id);
	if (item.expected.comparable) assert(Math.abs(actual.difference! - item.expected.difference!) < 1e-10, item.id);
	return { id: item.id, origin: item.origin, expected: item.expected, baseline: old, actual };
});
const summary = (items: typeof rows, key: "baseline" | "actual") => ({ cases: items.length, expectedComparable: items.filter((r) => r.expected.comparable).length, decisionAgreement: items.filter((r) => r[key].comparable === r.expected.comparable).length / items.length, falseComparable: items.filter((r) => r[key].comparable && !r.expected.comparable).length, falseBlocked: items.filter((r) => !r[key].comparable && r.expected.comparable).length });

let live: unknown = null;
if (process.argv.includes("--real")) {
	const corpus = loadCoffeeCorpus(); assert.equal(digest(corpus), snapshot.corpusHash);
	const frozen = JSON.parse(readFileSync("data/knowledge/coffee-open-v1/questions.v1.json", "utf8")); assert.equal(digest(frozen), digest(realKnowledgeCases));
	const previous = JSON.parse(readFileSync("docs/evidence/knowledge-optimization-regression.json", "utf8"));
	const old = previous.runs.find((r: { variant: string; mode: string }) => r.variant === "bilingual-idf-diverse" && r.mode === "hybrid");
	const embedding = await OnnxEmbedding.create(), store = new KnowledgeStore(resolve(".blackx-data/knowledge-real-eval", digest(corpus).slice(0, 16)), embedding, undefined, undefined, packagingRetrievalPolicy);
	const scope = { tenantId: "research-eval", workspaceId: "coffee" };
	try {
		const docs = store.list(scope).filter((d) => d.status === "indexed" && d.manifest.provenance === "public_source"); assert.equal(docs.length, 5, "Run eval:knowledge-real first");
		const comparisons = snapshot.cases.filter((c) => c.origin === "real_source_pair").map((item) => {
			const references = item.sources!.map((s) => ({ evidenceId: `${docs.find((d) => d.manifest.documentId === s.documentId)!.versionId}:${s.block}`, parameterIndex: s.parameterIndex }));
			const result = compareEvidence(store, scope, { left: references[0], right: references[1] }, item.id);
			assert.equal(result.comparison.comparable, item.expected.comparable); assert.equal(result.left.parameter.originalValue, item.left.originalValue); assert.equal(result.right.parameter.originalValue, item.right.originalValue);
			return { id: item.id, result };
		});
		const key = (hit: EvidenceResult["hits"][number]) => `${hit.documentId}:${hit.evidenceId.split(":").at(-1)}`;
		const retrieval = [];
		for (const item of realKnowledgeCases) {
			const result = await store.search(scope, { query: item.query, mode: "hybrid", limit: 5, provenance: "public_source", ...item.filters }, `comparison-regression:${item.id}`);
			const found = result.hits.map(key), expected = item.expected.map((e) => `${e.documentId}:${e.block}`), rank = found.findIndex((id) => expected.includes(id));
			assert.deepEqual(found, old.rows.find((r: { id: string }) => r.id === item.id).found, `Retrieval changed: ${item.id}`);
			retrieval.push({ id: item.id, found, expected, recall: expected.length ? expected.filter((id) => found.includes(id)).length / expected.length : null, mrr: expected.length ? rank < 0 ? 0 : 1 / (rank + 1) : null, rawNoAnswerCorrect: expected.length ? null : !found.length, durationMs: result.durationMs, usage: result.usage });
		}
		const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length, times = retrieval.map((r) => r.durationMs).sort((a, b) => a - b);
		live = { model: embedding.signature, corpusHash: digest(corpus), casesHash: digest(realKnowledgeCases), previousReportHash: digest(previous), rankingUnchangedForAll64: true, comparisons, retrieval, metrics: { recallAt5: mean(retrieval.flatMap((r) => r.recall === null ? [] : [r.recall])), mrr: mean(retrieval.flatMap((r) => r.mrr === null ? [] : [r.mrr])), rawNoAnswerAccuracy: mean(retrieval.flatMap((r) => r.rawNoAnswerCorrect === null ? [] : [Number(r.rawNoAnswerCorrect)])), p50Ms: times[Math.ceil(times.length * .5) - 1], p95Ms: times[Math.ceil(times.length * .95) - 1], embeddingTokens: retrieval.reduce((n, r) => n + (r.usage.inputTokens ?? 0), 0) } };
	} finally { store.close(); await embedding.close(); }
}
const report = { schemaVersion: "knowledge-comparison.v1", executedAt: new Date().toISOString(), caseHash: digest(snapshot), ruleVersion: comparisonRuleVersion, sourceHashes: Object.fromEntries(["src/manufacturing/packagingKnowledge.ts", "server/knowledge/store.ts", "server/manufacturing/knowledgeComparison.ts", "server/knowledge/validation.ts"].map((path) => [path, digest(readFileSync(path, "utf8"))])), baseline: summary(rows, "baseline"), current: summary(rows, "actual"), groups: ["synthetic_contract", "real_source_pair"].map((origin) => ({ origin, ...summary(rows.filter((r) => r.origin === origin), "actual") })), rows, live, hardware: { cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), platform: platform(), release: release(), node: process.version, concurrency: 1 }, paidModelCalls: 0, generationCalls: 0, costUsd: null, labelLimitations: "32 authored contract cases and 8 source-checked research pairs. Not human expert gold, not semantic entailment, not independent supplier-data generalization. Real-pair group contains no comparable positive examples." };
const path = `docs/evidence/knowledge-comparison-${live ? "real" : "offline"}.json`;
writeFileSync(path, JSON.stringify(report, null, "\t") + "\n");
console.log(JSON.stringify({ path, baseline: report.baseline, current: report.current, groups: report.groups, liveModelRegression: !!live }, null, 2));
