import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, digest } from "../server/knowledge/store";
import { LexicalEmbedding, LocalEmbedding } from "../server/knowledge/embedding";
import { coffeeKnowledgeFixtures } from "../src/manufacturing/knowledgeFixtures";
import { normalizeParameter, packagingTerms } from "../src/manufacturing/packagingKnowledge";
import { knowledgeCases, publicDiscoveryQuestions } from "./knowledgeCases";

const root = mkdtempSync(join(tmpdir(), "packx-knowledge-eval-"));
const scope = { tenantId: "eval", workspaceId: "coffee" };
const embedding = process.env.PACKX_EMBEDDING_CONFIG ? new LocalEmbedding(JSON.parse(process.env.PACKX_EMBEDDING_CONFIG)) : new LexicalEmbedding(packagingTerms);
const store = new KnowledgeStore(root, embedding, (b) => ({ ...b, parameters: b.parameters.map(normalizeParameter) }), () => "2026-09-17T10:00:00.000Z");
try {
	const fixtures = coffeeKnowledgeFixtures();
	fixtures.push({ ...structuredClone(fixtures[0]), documentId: "expired-x", family: "expired-source", model: "EXPIRED-X", expiresAt: "2026-09-16T00:00:00.000Z" });
	const conflict = { ...structuredClone(fixtures[0]), documentId: "conflict-z", family: "conflict-versions", model: "CONFLICT-Z" };
	const conflictV2 = structuredClone(conflict); conflictV2.revision = "fixture-v2"; conflictV2.blocks[1].parameters[0].originalValue = "0.2"; conflictV2.blocks[1].table!.rows[0][1] = "0.2";
	fixtures.push(conflict, conflictV2);
	for (const fixture of fixtures) { const doc = store.import(scope, fixture, "eval-author"); await store.process(scope, doc.versionId); }
	const familySplits = new Map<string, Set<string>>();
	for (const item of knowledgeCases) { const splits = familySplits.get(item.family) ?? new Set(); splits.add(item.split); familySplits.set(item.family, splits); }
	assert([...familySplits.values()].every((s) => s.size === 1), "document family split leakage");
	const runs = [];
	for (const mode of ["keyword", "vector", "hybrid"] as const) {
		const rows = [];
		for (const item of knowledgeCases) {
			const started = performance.now();
			const result = await store.search(item.foreignTenant ? { tenantId: "outsider", workspaceId: "other" } : scope, { ...item.query, mode }, item.id);
			const latencyMs = performance.now() - started;
			const found = result.hits.map((h) => `${h.documentId}${item.category === "conflict" || item.category === "citation" ? `@${h.revision}` : ""}:${h.evidenceId.split(":").at(-1)}`);
			const relevant = found.filter((id) => item.expected.includes(id));
			const first = found.findIndex((id) => item.expected.includes(id));
			rows.push({ id: item.id, category: item.category, split: item.split, found, expected: item.expected, recallAt5: item.expected.length ? relevant.length / item.expected.length : null, mrr: item.expected.length ? first < 0 ? 0 : 1 / (first + 1) : null, noAnswerCorrect: item.expected.length ? null : found.length === 0, citationLocatorCorrect: result.hits.every((hit) => store.readEvidence(item.foreignTenant ? { tenantId: "outsider", workspaceId: "other" } : scope, hit.evidenceId).contentHash === hit.contentHash), latencyMs });
		}
		const answerable = rows.filter((r) => r.recallAt5 !== null), absent = rows.filter((r) => r.noAnswerCorrect !== null);
		const latency = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
		runs.push({ mode, recallAt5: answerable.reduce((sum, row) => sum + row.recallAt5!, 0) / answerable.length, mrr: answerable.reduce((sum, row) => sum + row.mrr!, 0) / answerable.length, noAnswerAccuracy: absent.filter((r) => r.noAnswerCorrect).length / absent.length, citationLocatorIntegrity: rows.filter((r) => r.citationLocatorCorrect).length / rows.length, p50Ms: latency[Math.floor(latency.length * .5)], p95Ms: latency[Math.floor(latency.length * .95)], rows });
	}
	const report = { schemaVersion: "knowledge-eval.v1", executedAt: new Date().toISOString(), provenance: "synthetic_assertions_only", caseCount: knowledgeCases.length, caseHash: digest(knowledgeCases), corpusHash: digest(fixtures), hardware: { platform: platform(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), node: process.version }, concurrency: 1, documents: fixtures.length, chunksPerDocument: 2, embedding: { signature: embedding.signature, dimensions: embedding.dimensions, kind: embedding.kind }, generation: { calls: 0, durationMs: null, costUsd: null, evidenceEntailment: null, unsupportedConclusionRate: null }, extraction: { automaticParameterAccuracy: null, reason: "Reviewed structured manifests, no automated industrial parameter extractor" }, disclaimer: "Tiny synthetic fixtures share templates. Family-disjoint labels test mechanics only, not held-out semantic generalization. No real supplier corpus, human-reviewed golden labels or learned-model quality claim.", runs, publicDiscoveryQuestions };
	const output = process.argv.includes("--report") ? join(process.cwd(), "docs/evidence/knowledge-baseline.json") : join(root, "report.json");
	mkdirSync(join(process.cwd(), "docs/evidence"), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, "\t") + "\n");
	console.log(JSON.stringify({ caseCount: report.caseCount, documents: report.documents, embedding: report.embedding.kind, results: runs.map(({ rows: _rows, ...metrics }) => metrics), persistedReport: process.argv.includes("--report") ? output : null }, null, 2));
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
