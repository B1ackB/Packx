import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { AutoTokenizer } from "@huggingface/transformers";
import { KnowledgeStore, digest } from "../server/knowledge/store";
import { OnnxEmbedding, e5Model, e5Revision } from "../server/knowledge/onnxEmbedding";
import { loadCoffeeCorpus } from "../server/manufacturing/coffeeOpenCorpus";
import { assertImport } from "../server/knowledge/validation";
import { packagingRetrievalPolicy } from "../src/manufacturing/knowledgeRetrieval";
import type { EvidenceHit } from "../src/enterprise/knowledge";
import { realKnowledgeCases } from "./knowledgeRealCases";
import { chunkingVariants, sourceDocuments, freezeChunkCases, chunkDocument, unionSpans, evidencePayload, packEvidence, scoreSpans, mean, percentile } from "./knowledgeChunkingSupport";

const corpus = loadCoffeeCorpus(), sources = sourceDocuments(corpus), cases = freezeChunkCases(realKnowledgeCases, sources);
assert.equal(digest(realKnowledgeCases), digest(JSON.parse(readFileSync("data/knowledge/coffee-open-v1/questions.v1.json", "utf8"))));
const budget = 1024;
const protocol = {
	schemaVersion: "knowledge-chunking-protocol.v1", variants: chunkingVariants, corpusHash: digest(corpus), originalCaseHash: digest(realKnowledgeCases), caseHash: digest(cases),
	sourceHashes: Object.fromEntries(["server/knowledge/jats.ts", "server/knowledge/store.ts", "server/knowledge/ranking.ts", "server/knowledge/onnxEmbedding.ts", "src/manufacturing/knowledgeRetrieval.ts", "eval/knowledgeChunkingSupport.ts", "eval/knowledgeChunking.ts"].map((path) => [path, digest(readFileSync(path, "utf8"))])),
	model: { id: e5Model, revision: e5Revision, dtype: "q8", dimensions: 384, runtime: "transformers-4.3.0/cpu", tokenCounting: "pinned E5 tokenizer; add_special_tokens=false" },
	control: { modes: ["keyword", "vector", "hybrid"], primaryMode: "hybrid", policy: packagingRetrievalPolicy.version, candidateK: 8, diagnosticK: 5, budgetTokens: budget, concurrency: 1, parameters: "removed uniformly; no structured extraction/assessment score", productionIndexChanged: false },
	budgetRule: "Count JSON array of evidencePayload (ID, documentId, title, publisher, model, revision, sourceUrl, location, text, table). Greedy whole chunks in rank order, skip chunks that do not fit; no truncation. Query/prompt/generation excluded. E5 tokens are a context-size proxy, not generation-model tokens.",
	primaryMetric: "Macro fraction of provisional source bundles completely covered within 1024 tokens. Prose bundle=containing sentence by fixed punctuation rule; table bundle=sample cell+target header+target cell (unit question: sample+header). This is source-location coverage, not semantic entailment or expert correctness.",
	secondaryMetrics: ["anchor Recall@5 and MRR@5", "anchor recall and bundle character coverage at budget", "actual context tokens", "source-span duplication", "index chunks/tokens/forward passes/time/bytes", "retrieval latency P50/P95", "raw empty results on absent/filter cases"],
	spanRule: "Normalized JATS prose paragraphs reconstructed from existing parts; UTF-16 character offsets. Table rows have canonical caption/header/cell/footer text. Labels translated once from legacy references and scored only by source spans; repeated prose quotes use their first occurrence in the original labeled block. Cross-chunk union allowed for recall/coverage; MRR requires one chunk containing anchor. Source-coverage integrity ignores whitespace gaps.",
	windowRule: "256/384 token caps apply to prose only, within same section/anchor; word-boundary windows, overlap at most 64 tokens. Metadata is added identically by store embedding. Tables retain headers/units/footnotes/conditions. Three-row groups remain within one table; location.row denotes first row, full row lineage in chunk map.",
	limitations: ["5 CC BY research papers; no supplier TDS", "64 previously observed provisional cases, 56 answerable/8 absent or filters; 28 bilingual pairs", "0 human-reviewed gold labels", "development 30, previously observed frozen 34; no table queries in development", "single local run, fixed order, no statistical generalization or production promotion", "table diversification and E5 long-text pooling kept fixed; results measure interaction with current retrieval stack", "no answer generation, industrial parameter extraction accuracy, cost or business impact measured"],
};
const fixtureDir = resolve("data/knowledge/chunking-v1");
function writeJson(path: string, value: unknown) { writeFileSync(path + ".partial", JSON.stringify(value, null, "\t") + "\n"); renameSync(path + ".partial", path); }
if (process.argv.includes("--prepare")) {
	mkdirSync(fixtureDir, { recursive: true });
	for (const [name, value] of [["protocol", protocol], ["cases", cases]] as const) {
		const path = resolve(fixtureDir, `${name}.json`);
		if (existsSync(path)) assert.equal(digest(JSON.parse(readFileSync(path, "utf8"))), digest(value), "Frozen experiment changed; create a new version, do not overwrite observed labels");
		else writeJson(path, value);
	}
	console.log(JSON.stringify({ prepared: true, protocolHash: digest(protocol), cases: cases.length, humanReviewed: 0 }));
} else {
	assert.equal(digest(JSON.parse(readFileSync(resolve(fixtureDir, "protocol.json"), "utf8"))), digest(protocol), "Run --prepare before experiment; protocol/source changed");
	assert.equal(digest(JSON.parse(readFileSync(resolve(fixtureDir, "cases.json"), "utf8"))), digest(cases), "Frozen spans changed");
	const root = resolve(".blackx-data/knowledge-chunking", digest(protocol).slice(0, 16)); mkdirSync(root, { recursive: true });
	const controller = new AbortController(); const cancel = () => controller.abort(new Error("chunking_experiment_cancelled")); process.once("SIGINT", cancel);
	const embedding = await OnnxEmbedding.create();
	try {
		const tokenizer = await AutoTokenizer.from_pretrained(resolve(".blackx-data/knowledge-model", e5Model, e5Revision), { local_files_only: true });
		const count = (text: string): number => tokenizer(text, { add_special_tokens: false, truncation: false, padding: false }).input_ids.size;
		const scope = { tenantId: "chunking-eval", workspaceId: "coffee" }, runs: VariantRun[] = [];
		for (const variant of chunkingVariants) {
			controller.signal.throwIfAborted();
			const resultPath = resolve(root, `${variant.id}.json`);
			if (existsSync(resultPath)) {
				const previous = JSON.parse(readFileSync(resultPath, "utf8")) as VariantRun;
				assert.equal(previous.protocolHash, digest(protocol)); runs.push(previous); console.log(JSON.stringify({ resumed: variant.id })); continue;
			}
			const started = new Date().toISOString(), variantRoot = resolve(root, variant.id);
			const store = new KnowledgeStore(variantRoot, embedding, undefined, undefined, packagingRetrievalPolicy);
			const mapping = new Map<string, ReturnType<typeof chunkDocument>>();
			const indexRecords: Array<{ documentId: string; chunks: number; reused: boolean; elapsedMs: number; event: unknown }> = [];
			let fullSourceIntegrity = true;
			const contentLengths: number[] = [];
			try {
				for (const doc of sources) {
					const chunks = chunkDocument(doc, variant, count); mapping.set(doc.manifest.documentId, chunks);
					const spans = unionSpans(chunks.flatMap((c) => c.spans));
					for (const unit of doc.units) {
						let end = 0;
						for (const s of spans.filter((s) => s.unitId === unit.id)) { assert(!unit.text.slice(end, s.start).trim(), `Lost source text ${unit.id}`); end = s.end; }
						assert(!unit.text.slice(end).trim(), `Lost source tail ${unit.id}`);
						fullSourceIntegrity &&= end > 0;
					}
					const manifest = { ...doc.manifest, parser: { ...doc.manifest.parser, version: `${doc.manifest.parser.version}+eval-${variant.id}` }, blocks: chunks.map((c) => c.block) };
					assertImport(manifest);
					contentLengths.push(...chunks.map((c) => count(c.block.text + (c.block.table ? JSON.stringify(c.block.table) : ""))));
					const version = store.import(scope, manifest, "chunking-eval"), reused = version.status === "indexed", at = performance.now();
					await store.process(scope, version.versionId, controller.signal);
					assert.equal(store.get(scope, version.versionId)?.status, "indexed");
					const event = store.audit(scope).find((e) => e.type === "knowledge.indexed" && e.correlation === version.versionId);
					assert(event); indexRecords.push({ documentId: manifest.documentId, chunks: chunks.length, reused, elapsedMs: performance.now() - at, event: JSON.parse(String(event.data)) });
					console.log(JSON.stringify({ indexing: variant.id, document: manifest.documentId, chunks: chunks.length, reused }));
				}
				assert.equal(store.list(scope).filter((d) => d.status === "indexed").length, 5);
				writeJson(resolve(variantRoot, "chunk-map.json"), { schemaVersion: "chunking-source-map.v1", protocolHash: digest(protocol), documents: Object.fromEntries([...mapping].map(([id, chunks]) => [id, chunks.map((c) => ({ location: c.block.location, spans: c.spans }))])) });
				const modes = [];
				for (const mode of ["keyword", "vector", "hybrid"] as const) {
					const rows: Row[] = [];
					for (const item of cases) {
						const spansFor = (h: EvidenceHit) => {
							const chunk = mapping.get(h.documentId)![Number(h.evidenceId.split(":").at(-1)) - 1]; assert(chunk); return chunk.spans;
						};
						const result = await store.search(scope, { query: item.query, mode, limit: 8, provenance: "public_source", ...item.filters }, `chunking:${variant.id}:${mode}:${item.id}`, controller.signal);
						const packed = packEvidence(result.hits, budget, count), selectedSpans = packed.selected.flatMap(spansFor);
						const total = selectedSpans.reduce((n, s) => n + s.end - s.start, 0), unique = unionSpans(selectedSpans).reduce((n, s) => n + s.end - s.start, 0);
						rows.push({ id: item.id, category: item.category, language: item.language, split: item.split, family: item.family, table: item.expected.some((e) => e.location.table),
							top5: scoreSpans(item, result.hits.slice(0, 5).map(spansFor)), budget: scoreSpans(item, packed.selected.map(spansFor)), rawNoAnswerCorrect: item.expected.length ? null : result.hits.length === 0,
							contextTokens: packed.tokens, top5Tokens: count(JSON.stringify(result.hits.slice(0, 5).map(evidencePayload))), selected: packed.selected.map((h) => h.evidenceId), skipped: packed.skipped,
							duplication: total ? 1 - unique / total : 0, hits: result.hits.map((h) => ({ id: h.evidenceId, documentId: h.documentId, location: h.location, score: h.score, spans: spansFor(h) })), durationMs: result.durationMs, usage: result.usage });
					}
					const metrics = summarize(rows);
					modes.push({ mode, metrics, slices: Object.fromEntries(["zh", "en", "table", "prose", "development", "frozen"].map((slice) => [slice, summarize(rows.filter((r) => slice === "table" ? r.table : slice === "prose" ? !r.table : r.language === slice || r.split === slice))])), rows });
					console.log(JSON.stringify({ variant: variant.id, mode, metrics }));
				}
				store.close();
				const run: VariantRun = { variant: variant.id, protocolHash: digest(protocol), startedAt: started, completedAt: new Date().toISOString(),
					index: { documents: indexRecords, chunks: [...mapping.values()].reduce((n, c) => n + c.length, 0), fullSourceIntegrity, contentTokensP50: percentile(contentLengths, .5), contentTokensP95: percentile(contentLengths, .95), contentTokensMax: Math.max(...contentLengths), databaseBytes: statSync(resolve(variantRoot, "knowledge.sqlite")).size }, modes };
				writeJson(resultPath, run); runs.push(run);
			} catch (error) { store.close(); throw error; }
		}
		const report = { schemaVersion: "knowledge-chunking-result.v1", executedAt: new Date().toISOString(), protocolHash: digest(protocol), protocol, model: embedding.signature, root, cases: cases.length, answerable: cases.filter((c) => c.expected.length).length, humanReviewed: 0,
			hardware: { cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), platform: platform(), release: release(), node: process.version, concurrency: 1, onnxIntraOpThreads: 2, onnxInterOpThreads: 1 },
			generation: { calls: 0, timeMs: null, costUsd: null, correctness: null }, paidApiCalls: 0, productionPromotion: null, runs };
		writeJson(resolve("docs/evidence/knowledge-chunking-v1.json"), report);
		console.log(JSON.stringify({ report: "docs/evidence/knowledge-chunking-v1.json", protocolHash: digest(protocol) }));
	} finally { process.removeListener("SIGINT", cancel); await embedding.close(); }
}

type Row = {
	id: string; category: string; language: string; split: string; family: string; table: boolean;
	top5: ReturnType<typeof scoreSpans>; budget: ReturnType<typeof scoreSpans>; rawNoAnswerCorrect: boolean | null;
	contextTokens: number; top5Tokens: number; selected: string[]; skipped: string[]; duplication: number;
	hits: Array<{ id: string; documentId: string; location: EvidenceHit["location"]; score: number; spans: import("./knowledgeChunkingSupport").Span[] }>;
	durationMs: number; usage: { inputTokens: number | null };
};
function summarize(rows: Row[]) {
	const answered = rows.filter((r) => r.budget), absent = rows.filter((r) => r.rawNoAnswerCorrect !== null);
	return { cases: rows.length, answerable: answered.length, recallAt5: mean(answered.map((r) => r.top5!.recall)), mrrAt5: mean(answered.map((r) => r.top5!.mrr)),
		anchorRecallAtBudget: mean(answered.map((r) => r.budget!.recall)), bundleCompleteAtBudget: mean(answered.map((r) => r.budget!.complete)), bundleCoverageAtBudget: mean(answered.map((r) => r.budget!.bundleCoverage)),
		rawNoAnswerAccuracy: mean(absent.map((r) => Number(r.rawNoAnswerCorrect))), contextTokensMean: mean(rows.map((r) => r.contextTokens)), contextTokensP95: percentile(rows.map((r) => r.contextTokens), .95), contextTokensMax: rows.length ? Math.max(...rows.map((r) => r.contextTokens)) : null,
		top5TokensMean: mean(rows.map((r) => r.top5Tokens)), selectedChunksMean: mean(rows.map((r) => r.selected.length)), duplicationMean: mean(rows.map((r) => r.duplication)), p50Ms: percentile(rows.map((r) => r.durationMs), .5), p95Ms: percentile(rows.map((r) => r.durationMs), .95), queryEmbeddingTokens: rows.reduce((n, r) => n + (r.usage.inputTokens ?? 0), 0) };
}
interface VariantRun {
	variant: string; protocolHash: string; startedAt: string; completedAt: string;
	index: { documents: Array<{ documentId: string; chunks: number; reused: boolean; elapsedMs: number; event: unknown }>; chunks: number; fullSourceIntegrity: boolean; contentTokensP50: number | null; contentTokensP95: number | null; contentTokensMax: number; databaseBytes: number };
	modes: Array<{ mode: string; metrics: ReturnType<typeof summarize>; slices: Record<string, ReturnType<typeof summarize>>; rows: Row[] }>;
}
