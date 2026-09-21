import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEmbedding } from "../server/knowledge/embedding";
import { OnnxEmbedding } from "../server/knowledge/onnxEmbedding";
import { OnnxReranker } from "../server/knowledge/onnxReranker";
import { digest, KnowledgeStore } from "../server/knowledge/store";
import { coffeeProductManifests } from "../server/manufacturing/coffeeProductDirectory";
import { loadCoffeeCorpus } from "../server/manufacturing/coffeeOpenCorpus";
import { fdaPcrModel, packagingExpansionCheckedAt, packagingExpansionManifests, packagingExpansionRoot } from "../server/manufacturing/packagingExpansion";
import { packagingRetrievalPolicy } from "../src/manufacturing/knowledgeRetrieval";
import { normalizeParameter } from "../src/manufacturing/packagingKnowledge";
import type { EvidenceHit, KnowledgeImport } from "../src/enterprise/knowledge";

assert(!process.argv.includes("--online"), "No online or paid model evaluation is permitted by this command");
const local = process.argv.includes("--local-model"), output = process.argv.includes("--write");
const probeSource = readFileSync(join(packagingExpansionRoot, "cases.json"), "utf8");
type Probe = { id: string; query: string; model?: string; anchor?: string; contains?: string; control?: boolean };
const probes = (JSON.parse(probeSource) as { cases: Probe[] }).cases;
const baseline = [...loadCoffeeCorpus(), ...coffeeProductManifests()], expansion = packagingExpansionManifests();
assert.equal(baseline.length, 11); assert.equal(baseline.reduce((n, m) => n + m.blocks.length, 0), 574);
const started = performance.now(), embedding = local ? await OnnxEmbedding.create() : new FakeEmbedding();
const reranker = local ? await OnnxReranker.create() : undefined;
const root = mkdtempSync(join(tmpdir(), "packx-enrichment-eval-")), scope = { tenantId: "enrichment-eval", workspaceId: "isolated" };
let store = new KnowledgeStore(root, embedding, (b) => ({ ...b, parameters: b.parameters.map(normalizeParameter) }), () => packagingExpansionCheckedAt, packagingRetrievalPolicy, reranker);
const indexRows: Array<{ documentId: string; blocks: number; durationMs: number }> = [];
async function index(manifests: KnowledgeImport[]) {
	for (const manifest of manifests) {
		const start = performance.now(), doc = store.import(scope, manifest, "operator"); await store.process(scope, doc.versionId);
		assert.equal(store.get(scope, doc.versionId)?.status, "indexed"); assert.equal(store.import(scope, manifest, "operator").versionId, doc.versionId);
		indexRows.push({ documentId: manifest.documentId, blocks: manifest.blocks.length, durationMs: performance.now() - start });
	}
}
function matches(hit: EvidenceHit, p: Probe) { return (!p.model || hit.model === p.model) && (!p.anchor || hit.location.anchor === p.anchor) && (!p.contains || hit.text.includes(p.contains) || JSON.stringify(hit.table ?? {}).includes(p.contains)); }
async function measure(phase: string) {
	const rows = [];
	for (const probe of probes) {
		const result = await store.search(scope, { query: probe.query, mode: "hybrid", limit: 5 }, `${phase}-${probe.id}`);
		assert.equal(result.usage.generationCalls, 0); if (local) assert.equal(result.reranking?.status, "completed");
		const rank = result.hits.findIndex((h) => matches(h, probe)) + 1;
		rows.push({ id: probe.id, control: !!probe.control, foundAt: rank || null, completeSourceText: rank > 0 && store.readEvidence(scope, result.hits[rank - 1].evidenceId).text === result.hits[rank - 1].text, durationMs: result.durationMs, usage: result.usage, reranking: result.reranking, hits: result.hits.map((h) => ({ model: h.model, anchor: h.location.anchor, evidenceId: h.evidenceId })) });
	}
	return rows;
}
try {
	await index(baseline); console.log("Frozen baseline indexed: 11 documents / 574 blocks.");
	const before = await measure("baseline");
	await index(expansion); console.log("Expansion indexed: 11 additional documents / 470 blocks.");
	const after = await measure("expanded");
	const docs = store.list(scope), fda = docs.find((d) => d.manifest.model === fdaPcrModel)!;
	const fdaManifest = expansion.find((m) => m.model === fdaPcrModel)!;
	for (const [i, b] of fdaManifest.blocks.entries()) assert.equal(store.readEvidence(scope, `${fda.versionId}:${i + 1}`).text, b.text);
	const selectedId = `${fda.versionId}:456`, task = { ...scope, runId: "probe" };
	store.select(task, [selectedId], { region: "US", asOf: packagingExpansionCheckedAt }, "operator", "select", 0);
	store.close(); store = new KnowledgeStore(root, embedding, undefined, () => packagingExpansionCheckedAt, packagingRetrievalPolicy, reranker);
	assert.equal(store.selected(task).hits[0].evidenceId, selectedId);
	store.transition(scope, fda.versionId, "withdrawn", "operator"); assert.deepEqual(store.selected(task).unavailable, [selectedId]);
	const summarize = (rows: typeof before) => ({ newSourceProbes: rows.filter((r) => !r.control).length, newSourceHitsAt5: rows.filter((r) => !r.control && r.foundAt !== null).length, controlProbes: rows.filter((r) => r.control).length, controlHitsAt5: rows.filter((r) => r.control && r.foundAt !== null).length, completeSourceTextOnHits: rows.filter((r) => r.completeSourceText).length, embeddingCalls: rows.reduce((n, r) => n + r.usage.embeddingCalls, 0), queryInputTokens: rows.reduce((n, r) => n + (r.usage.inputTokens ?? 0), 0), rerankingCalls: rows.filter((r) => r.reranking?.status === "completed").length, rerankingInputTokens: rows.reduce((n, r) => n + (r.reranking?.inputTokens ?? 0), 0), meanDurationMs: rows.reduce((n, r) => n + r.durationMs, 0) / rows.length });
	const report = { schemaVersion: "packaging-enrichment-eval.v1", generatedAt: new Date().toISOString(), execution: local ? "pinned-local-e5-and-mmarco" : "fake-mechanism-only", fixtureHash: digest(probeSource), baselineManifestHash: digest(baseline), expansionManifestHash: digest(expansion), embedding: { signature: embedding.signature, dimensions: embedding.dimensions }, reranker: reranker?.signature ?? null, strategy: { research: "existing JATS paragraphs ~1000 characters and complete table rows; unchanged", directory: "one complete authored record", fda: "one complete original data row with all 7 fields; long cells preserved in text", overlap: 0, embeddingChanged: false, runtimeChanged: false }, corpus: { beforeDocuments: baseline.length, beforeBlocks: 574, addedDocuments: expansion.length, addedBlocks: 470, afterDocuments: docs.length, afterBlocks: 1044, officialDataRows: 460, newDatabaseEntrypoints: 8, newSupplierEntrypoints: 2, newSupplierTechnicalFulltexts: 0 }, verification: { sourceRowsReadBackExactly: 460, duplicateImportSameVersions: true, restartedSelectionReadable: true, withdrawnSelectionUnavailable: true }, baseline: { summary: summarize(before), rows: before }, expanded: { summary: summarize(after), rows: after }, index: indexRows, elapsedMs: performance.now() - started, paidCalls: 0, generationCalls: 0, limitations: ["Source-bound probes prepared before this run; Agent labels, no human expert review or independent blind test.", "Coverage increase on new-source probes is caused by adding previously absent data; it is not a retrieval-algorithm or end-to-end answer-quality gain.", "FDA snapshot is a US process/conditions source, not a current order or product compliance determination.", "Directory records are not vendor technical fulltexts. Real generation quality NOT_EVALUATED.", "Local timings include the selected runtime and corpus; not production latency claims. Fake runs prove mechanism only."] };
	if (output) writeFileSync(`docs/evidence/knowledge-expansion-2026-09-21${local ? "-local" : "-fake"}.json`, JSON.stringify(report, null, "\t") + "\n");
	console.log(JSON.stringify({ execution: report.execution, corpus: report.corpus, baseline: report.baseline.summary, expanded: report.expanded.summary, verification: report.verification, paidCalls: 0, generationCalls: 0 }, null, "\t"));
} finally { store.close(); if (embedding instanceof OnnxEmbedding) await embedding.close(); await reranker?.close(); rmSync(root, { recursive: true, force: true }); }
