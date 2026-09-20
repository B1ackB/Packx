import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { KnowledgeStore, digest } from "../server/knowledge/store";
import { OnnxEmbedding } from "../server/knowledge/onnxEmbedding";
import { loadCoffeeCorpus, corpusRoot } from "../server/manufacturing/coffeeOpenCorpus";
import { granularTasks, realKnowledgeCases } from "./knowledgeRealCases";
import { normalizeParameter, coffeeEvidenceReview } from "../src/manufacturing/packagingKnowledge";
import type { EvidenceResult } from "../src/enterprise/knowledge";

interface ResultRow { id: string; category: string; language: string; split: string; found: string[]; expected: string[]; recallAt5: number | null; mrr: number | null; rawNoAnswerCorrect: boolean | null; locatorIntegrity: boolean; latencyMs: number; usage: EvidenceResult["usage"] }

const fixtures = loadCoffeeCorpus();
const frozen = JSON.parse(readFileSync(resolve(corpusRoot, "questions.v1.json"), "utf8"));
assert.equal(digest(frozen), digest(realKnowledgeCases), "Question changes require a new version before running");
const familySplits = new Map<string, Set<string>>();
for (const c of realKnowledgeCases) { const s = familySplits.get(c.family) ?? new Set(); s.add(c.split); familySplits.set(c.family, s); for (const e of c.expected) assert(JSON.stringify(fixtures.find((d) => d.documentId === e.documentId)!.blocks[e.block - 1]).includes(e.quote)); }
assert([...familySplits.values()].every((s) => s.size === 1));
const startup = performance.now(); const embedding = await OnnxEmbedding.create(); const startupMs = performance.now() - startup;
const scope = { tenantId: "research-eval", workspaceId: "coffee" };
const root = resolve(".blackx-data/knowledge-real-eval", digest(fixtures).slice(0, 16));
const store = new KnowledgeStore(root, embedding, (b) => ({ ...b, parameters: b.parameters.map(normalizeParameter) }));
const key = (hit: { documentId: string; evidenceId: string }) => `${hit.documentId}:${hit.evidenceId.split(":").at(-1)}`;
const mean = (a: number[]) => a.length ? a.reduce((n, x) => n + x, 0) / a.length : null;
const percentile = (a: number[], p: number) => [...a].sort((a, b) => a - b)[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)];
try {
	if (process.argv.includes("--rebuild")) store.rebuild(scope);
	const indexStart = performance.now(); const indexedVersions = new Set<string>();
	for (const manifest of fixtures) { const d = store.import(scope, manifest, "research-operator"); await store.process(scope, d.versionId); indexedVersions.add(d.versionId); console.log(JSON.stringify({ indexed: manifest.documentId, blocks: manifest.blocks.length })); }
	const indexingMs = performance.now() - indexStart;
	const indexEvents = store.audit(scope).filter((r) => r.type === "knowledge.indexed" && indexedVersions.has(JSON.parse(String(r.data)).versionId));
	const runs = [];
	for (const mode of ["keyword", "vector", "hybrid"] as const) {
		const rows: ResultRow[] = [];
		for (const item of realKnowledgeCases) {
			const result = await store.search(scope, { query: item.query, mode, limit: 5, provenance: "public_source", ...item.filters }, item.id);
			const found = result.hits.map(key), expected = item.expected.map((e) => `${e.documentId}:${e.block}`), first = found.findIndex((id) => expected.includes(id));
			const relevant = expected.filter((id) => found.includes(id));
			rows.push({ id: item.id, category: item.category, language: item.language, split: item.split, found, expected, recallAt5: expected.length ? relevant.length / expected.length : null, mrr: expected.length ? first < 0 ? 0 : 1 / (first + 1) : null, rawNoAnswerCorrect: expected.length ? null : found.length === 0, locatorIntegrity: result.hits.every((h) => store.readEvidence(scope, h.evidenceId).contentHash === h.contentHash), latencyMs: result.durationMs, usage: result.usage });
		}
		const summary = (items: typeof rows) => ({ cases: items.length, answerable: items.filter((r) => r.expected.length).length, recallAt5: mean(items.flatMap((r) => r.recallAt5 === null ? [] : [r.recallAt5])), mrr: mean(items.flatMap((r) => r.mrr === null ? [] : [r.mrr])), rawNoAnswerAccuracy: mean(items.flatMap((r) => r.rawNoAnswerCorrect === null ? [] : [Number(r.rawNoAnswerCorrect)])), p50Ms: percentile(items.map((r) => r.latencyMs), .5), p95Ms: percentile(items.map((r) => r.latencyMs), .95) });
		const run = { mode, all: summary(rows), development: summary(rows.filter((r) => r.split === "development")), frozen: summary(rows.filter((r) => r.split === "frozen")), zh: summary(rows.filter((r) => r.language === "zh")), en: summary(rows.filter((r) => r.language === "en")), rows };
		runs.push(run); console.log(JSON.stringify({ mode, ...run.all }));
	}
	const scoped = [];
	// Explicit user-provided document choice is extra information, not an automatic retrieval improvement.
	for (const mode of ["keyword", "vector", "hybrid"] as const) {
		const rows = [];
		for (const item of realKnowledgeCases.filter((c) => c.expected.length > 0)) {
			const result = await store.search(scope, { query: item.query, mode, limit: 5, model: `study:${item.expected[0].documentId}` }, `scoped-${item.id}`);
			const expected = item.expected.map((e) => `${e.documentId}:${e.block}`);
			rows.push({ id: item.id, language: item.language, found: result.hits.map(key), recallAt5: expected.filter((id) => result.hits.map(key).includes(id)).length / expected.length, latencyMs: result.durationMs });
		}
		scoped.push({ mode, condition: "Correct document explicitly selected; expected labels used to simulate user choice. Oracle diagnostic, not autonomous retrieval.", recallAt5: mean(rows.map((r) => r.recallAt5)), rows });
	}
	const granular = [];
	for (const task of granularTasks) for (const mode of ["keyword", "vector", "hybrid"] as const) {
		const broad = await store.search(scope, { query: task.broad, mode, limit: 8 });
		const atomic: EvidenceResult[] = []; for (const q of task.questions) atomic.push(await store.search(scope, { query: q, mode, limit: 2 }));
		const summarize = (rs: typeof atomic) => ({ coverage: task.expected.filter((id) => rs.flatMap((r) => r.hits.map(key)).includes(id)).length / task.expected.length, queries: rs.length, maxReturnedPassages: rs.length === 1 ? 8 : rs.length * 2, inputTokens: rs.reduce((n, r) => n + (r.usage.inputTokens ?? 0), 0), durationMs: rs.reduce((n, r) => n + r.durationMs, 0), hits: rs.flatMap((r) => r.hits.map(key)) });
		granular.push({ id: task.id, mode, expected: task.expected, broad: summarize([broad]), atomic: summarize(atomic) });
	}
	// Real-content, real-model isolation + interrupted indexing/recovery/withdrawal regression.
	const privateDoc = { ...structuredClone(fixtures[0]), documentId: "private-research-control", model: "PRIVATE-CONTROL", revision: `control-${new Date().toISOString()}`, visibility: "workspace" as const, blocks: fixtures[0].blocks.slice(35, 37) };
	const pd = store.import(scope, privateDoc, "research-operator");
	if (pd.status === "withdrawn") throw new Error("Remove only the dedicated eval directory before repeating reliability tests");
	const aborted = new AbortController(); aborted.abort(); let interrupted = false;
	try { await store.process(scope, pd.versionId, aborted.signal); } catch { interrupted = true; }
	await store.process(scope, pd.versionId);
	const owner = await store.search(scope, { query: "REC film", model: "PRIVATE-CONTROL", mode: "hybrid" });
	const foreign = await store.search({ tenantId: "outsider", workspaceId: "other" }, { query: "REC film", model: "PRIVATE-CONTROL", mode: "hybrid" });
	assert(owner.hits.length > 0 && foreign.hits.length === 0);
	const permissionChecks = ["keyword", "vector", "hybrid"].map((mode) => mode);
	for (const mode of permissionChecks) assert.equal((await store.search({ tenantId: "outsider", workspaceId: "other" }, { query: "REC", model: "PRIVATE-CONTROL", mode })).hits.length, 0);
	const selected = owner.hits; const gaps = coffeeEvidenceReview(selected);
	store.transition(scope, pd.versionId, "withdrawn", "research-operator");
	assert.equal((await store.search(scope, { query: "REC film", model: "PRIVATE-CONTROL", mode: "hybrid" })).hits.length, 0);
	const report = { schemaVersion: "knowledge-real-eval.v1", executedAt: new Date().toISOString(), corpusHash: digest(fixtures), caseHash: digest(realKnowledgeCases), documents: fixtures.length, chunks: fixtures.reduce((n, d) => n + d.blocks.length, 0), parameters: fixtures.flatMap((d) => d.blocks.flatMap((b) => b.parameters)).length, caseCount: realKnowledgeCases.length, labelStatus: "agent_source_checked_pending_human_review", humanReviewedCases: 0, frozenBeforeFirstExperiment: true, familySplits: Object.fromEntries([...familySplits].map(([k, v]) => [k, [...v]])), hardware: { platform: platform(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), node: process.version }, concurrency: 1, embedding: { signature: embedding.signature, dimensions: embedding.dimensions, kind: embedding.kind, cpuThreads: 2, network: "disabled during index and search" }, startupMs, indexingMs, scope: "Exploratory retrieval relevance on 5 licensed research papers; no vendor product coverage or human expert gold. The 0.12 cosine floor is an unchanged baseline, not calibrated answerability.", generation: { modelCalls: 0, paidCalls: 0, durationMs: null, costUsd: null, unsupportedConclusionRate: null, entailmentAccuracy: null }, extraction: { method: "JATS structure + 40 source-bound parameter transcriptions", automatedGeneralParameterAccuracy: null, humanReviewedParameters: 0, sourceSpanChecks: true }, reliability: { realPrivateContentDeniedAllThreePaths: true, interruptionObserved: interrupted, recovered: true, withdrawalRemoved: true, reviews: gaps }, indexEvents, runs, scoped, granular, limitations: ["Small corpus and provisional labels; do not claim generalization or production performance", "PDF page QA limited to selected pages; all other locations use JATS section/table anchors", "No learned reranker or query rewriting; no paid generation or LLM judge", "Raw retrieval returning a passage is not a supported answer. No-answer false positives are reported, not hidden", "Granular queries hold passage count at 8 but require 4 queries versus 1; costs are not equal"] };
	mkdirSync("docs/evidence", { recursive: true }); writeFileSync(resolve(root, "latest-report.json"), JSON.stringify(report, null, "\t") + "\n");
	console.log(JSON.stringify({ report: resolve(root, "latest-report.json"), granular, reliability: report.reliability }, null, 2));
} finally { store.close(); await embedding.close(); }
