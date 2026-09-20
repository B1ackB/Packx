import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cpus, platform, release, totalmem } from "node:os";
import { AutoTokenizer } from "@huggingface/transformers";
import { KnowledgeStore, digest } from "../server/knowledge/store";
import { OnnxEmbedding, e5Model, e5Revision } from "../server/knowledge/onnxEmbedding";
import { loadCoffeeCorpus } from "../server/manufacturing/coffeeOpenCorpus";
import { assertImport } from "../server/knowledge/validation";
import { packagingRetrievalPolicy } from "../src/manufacturing/knowledgeRetrieval";
import { sourceDocuments, unionSpans, coverage, mean, percentile, type ChunkCase, type Span } from "./knowledgeChunkingSupport";
import { sentenceVariants, sentenceRanges, sentenceChunks, sentenceScore, expandEvidence, packPackets, nonWhitespace, boundaryProbes, type SentenceVariant, type SentenceChunk } from "./knowledgeSentenceSupport";

const corpus = loadCoffeeCorpus(), sources = sourceDocuments(corpus), units = new Map(sources.flatMap((d) => d.units.map((u) => [u.id, u] as const)));
const cases = JSON.parse(readFileSync("data/knowledge/chunking-v1/cases.json", "utf8")) as ChunkCase[];
const probes = boundaryProbes(sources, JSON.parse(readFileSync("docs/evidence/knowledge-chunking-boundary-audit.json", "utf8")));
const budget = 1024, fixtureDir = resolve("data/knowledge/chunking-v2");
const protocol = {
	schemaVersion: "knowledge-sentence-protocol.v2", variants: sentenceVariants, corpusHash: digest(corpus), caseHash: digest(cases), boundaryProbeHash: digest(probes),
	sourceHashes: Object.fromEntries(["server/knowledge/jats.ts", "server/knowledge/store.ts", "server/knowledge/ranking.ts", "server/knowledge/onnxEmbedding.ts", "src/manufacturing/knowledgeRetrieval.ts", "eval/knowledgeChunkingSupport.ts", "eval/knowledgeSentenceSupport.ts", "eval/knowledgeSentence.ts"].map((p) => [p, digest(readFileSync(p, "utf8"))])),
	model: { id: e5Model, revision: e5Revision, dimensions: 384, dtype: "q8", runtime: "transformers-4.3.0/cpu" }, segmentation: { implementation: "Intl.Segmenter/sentence + fixed abbreviation guard", icu: process.versions.icu, node: process.version, targetCharacters: 500, longSentenceThreshold: 500, longSentenceTokenCap: 128, longSentenceOverlapMax: 32 },
	retrieval: { policy: packagingRetrievalPolicy.version, modes: ["keyword", "vector", "hybrid"], primary: "hybrid", candidateK: 8, diagnosticK: 5, concurrency: 1, queryReuse: "One search per index/query/mode; expansion variants share identical candidates. Four indexes, seven output policies." },
	primaryMetric: "Complete provisional source bundle in a 1024 E5-token JSON evidence budget; ignore whitespace-only gaps for all variants. V1 source labels and all 64 questions unchanged. Strict V1 punctuation/character scores are not substituted retroactively.",
	budget: { tokens: budget, counting: "E5 tokenizer, no special tokens; whole payload array including citation metadata, expansion ranges and source IDs", selection: "rank-order greedy, whole packets only, skip too large; identical source ranges deduplicated; no partial expansion fallback" },
	expansion: "Same document VERSION and original paragraph only; restore all sentences intersecting the hit, or entire original paragraph including adjacent sentences. Linked mode restores only deliberately split long sentences. No question/answer label is passed to expansion. Every referenced chunk is re-read through store permission/date/state filters and anchor is rechecked.",
	boundaryMetric: "Separate mechanical replay of 19 known legacy cuts: choose first chunk containing left source word, then measure adjacent-word integrity before/after packing. Oracle source hit, NOT retrieval accuracy or human gold. Long-sentence replay separately checks all source sentences over 500 characters.",
	limitations: ["5 research papers / 4 families; 64 observed provisional queries, 56 answerable / 8 absent or filter cases; 0 human gold", "Only one native-segmented sentence exceeds 500 chars; synthetic tests show mechanics, not real quality", "Sentence boundaries are ICU heuristics, not semantic certainty; source paragraph boundaries remain", "No production promotion, no Agent/Fact/Approval changes", "Single serial run, no significance or production latency claim", "No generation model, paid API or new dependency"],
};
function writeJson(path: string, value: unknown) { writeFileSync(path + ".partial", JSON.stringify(value, null, "\t") + "\n"); renameSync(path + ".partial", path); }
if (process.argv.includes("--prepare")) {
	mkdirSync(fixtureDir, { recursive: true });
	for (const [name, value] of [["protocol", protocol], ["cases", cases], ["boundary-probes", probes]] as const) {
		const path = resolve(fixtureDir, `${name}.json`);
		if (existsSync(path)) assert.equal(digest(JSON.parse(readFileSync(path, "utf8"))), digest(value), "Frozen experiment changed; use a new protocol version");
		else writeJson(path, value);
	}
	console.log(JSON.stringify({ prepared: true, protocolHash: digest(protocol), cases: cases.length, boundaryProbes: probes.length }));
} else {
	for (const [name, value] of [["protocol", protocol], ["cases", cases], ["boundary-probes", probes]] as const) assert.equal(digest(JSON.parse(readFileSync(resolve(fixtureDir, `${name}.json`), "utf8"))), digest(value), "Protocol/source changed; prepare a new experiment version");
	const root = resolve(".blackx-data/knowledge-sentence", digest(protocol).slice(0, 16)); mkdirSync(root, { recursive: true });
	const scope = { tenantId: "chunking-eval", workspaceId: "coffee" };
	const embedding = await OnnxEmbedding.create(), controller = new AbortController();
	const cancel = () => controller.abort(new Error("sentence_experiment_cancelled")); process.once("SIGINT", cancel);
	try {
		const tokenizer = await AutoTokenizer.from_pretrained(resolve(".blackx-data/knowledge-model", e5Model, e5Revision), { local_files_only: true });
		const count = (text: string): number => tokenizer(text, { add_special_tokens: false, truncation: false, padding: false }).input_ids.size;
		const indexes = [];
		for (const index of [...new Set(sentenceVariants.map((v) => v.index))]) {
			controller.signal.throwIfAborted();
			const path = resolve(root, `${index}.json`);
			if (existsSync(path)) { const previous = JSON.parse(readFileSync(path, "utf8")) as IndexRun; assert.equal(previous.protocolHash, digest(protocol)); indexes.push(previous); console.log(JSON.stringify({ resumed: index })); continue; }
			const startedAt = new Date().toISOString(), dir = resolve(root, index), store = new KnowledgeStore(dir, embedding, undefined, undefined, packagingRetrievalPolicy);
			try {
				const mapping = new Map<string, { chunks: SentenceChunk[]; versionId: string }>(), documents = [];
				for (const doc of sources) {
					const chunks = sentenceChunks(doc, index, count), spans = unionSpans(chunks.flatMap((c) => c.spans));
					for (const unit of doc.units) assert.equal(coverage(nonWhitespace([{ unitId: unit.id, start: 0, end: unit.text.length }], units), spans), 1, `Source loss: ${unit.id}`);
					const alias = index === "legacy-1000" ? "paragraph-1000-row-1" : index === "legacy-500" ? "paragraph-500-row-1" : index;
					const manifest = { ...doc.manifest, parser: { ...doc.manifest.parser, version: `${doc.manifest.parser.version}+eval-${alias}` }, blocks: chunks.map((c) => c.block) }; assertImport(manifest);
					const version = store.import(scope, manifest, "sentence-eval"), reused = version.status === "indexed", at = performance.now();
					await store.process(scope, version.versionId, controller.signal); assert.equal(store.get(scope, version.versionId)?.status, "indexed");
					mapping.set(doc.manifest.documentId, { chunks, versionId: version.versionId });
					const event = store.audit(scope).find((e) => e.type === "knowledge.indexed" && e.correlation === version.versionId); assert(event);
					documents.push({ documentId: doc.manifest.documentId, chunks: chunks.length, linkedChildren: chunks.filter((c) => c.parent).length, reused, elapsedMs: performance.now() - at, indexed: JSON.parse(String(event.data)) });
					console.log(JSON.stringify({ indexing: index, document: doc.manifest.documentId, chunks: chunks.length, reused }));
				}
				assert.equal(store.list(scope).filter((d) => d.status === "indexed").length, 5);
				writeJson(resolve(dir, "source-map.json"), Object.fromEntries(mapping));
				const variants = sentenceVariants.filter((v) => v.index === index), runs: OutputRun[] = [];
				for (const variant of variants) {
					const replay = (documentId: string, left: Span, target: Span) => {
						const doc = sources.find((d) => d.manifest.documentId === documentId)!, data = mapping.get(documentId)!;
						const ordinal = data.chunks.findIndex((c) => coverage([left], c.spans) === 1); assert(ordinal >= 0);
						const read = (id: string) => store.readEvidence(scope, id, { provenance: "public_source" }), hit = read(`${data.versionId}:${ordinal + 1}`);
						const packet = expandEvidence(hit, doc, data.chunks, variant.expansion, read), packed = packPackets([packet], budget, count);
						const need = nonWhitespace([target], units);
						return { indexedComplete: coverage(need, data.chunks[ordinal].spans) === 1, returnedComplete: coverage(need, packed.selected.flatMap((p) => p.spans)) === 1, tokens: packed.tokens, skipped: packed.skipped, sourceIds: packet.payload.expansion?.sourceIds ?? [hit.evidenceId] };
					};
					const boundaries = probes.map((p) => ({ id: p.id, ...replay(p.documentId, p.leftAnchor, p.target) }));
					const longSentences = sources.flatMap((doc) => doc.units.filter((u) => !u.block.table).flatMap((unit) => sentenceRanges(unit, doc.manifest.language).filter((s) => s.end - s.start > 500).map((s) => ({ documentId: doc.manifest.documentId, span: s, ...replay(doc.manifest.documentId, { ...s, end: s.start + 1 }, s) }))));
					runs.push({ variant: variant.id, expansion: variant.expansion, boundaries, longSentences, modes: [] });
				}
				for (const mode of ["keyword", "vector", "hybrid"] as const) {
					const rowsByVariant = new Map(variants.map((v) => [v.id, [] as Row[]]));
					for (const item of cases) {
						const query = { query: item.query, mode, limit: 8, provenance: "public_source" as const, ...item.filters };
						const result = await store.search(scope, query, `sentence:${index}:${mode}:${item.id}`, controller.signal);
						const spansFor = (h: (typeof result.hits)[number]) => mapping.get(h.documentId)!.chunks[Number(h.evidenceId.split(":").at(-1)) - 1].spans;
						for (const variant of variants) {
							const at = performance.now(); let referenceReads = 0;
							const packets = result.hits.map((hit) => expandEvidence(hit, sources.find((d) => d.manifest.documentId === hit.documentId)!, mapping.get(hit.documentId)!.chunks, variant.expansion, (id) => { referenceReads++; return store.readEvidence(scope, id, query); }));
							const packed = packPackets(packets, budget, count), contextMs = performance.now() - at;
							rowsByVariant.get(variant.id)!.push({ id: item.id, language: item.language, split: item.split, table: item.expected.some((e) => e.location.table), category: item.category,
								top5: sentenceScore(item, result.hits.slice(0, 5).map(spansFor), units), budget: sentenceScore(item, packed.selected.map((p) => p.spans), units), rawNoAnswerCorrect: item.expected.length ? null : result.hits.length === 0,
								contextTokens: packed.tokens, selected: packed.selected.map((p) => ({ id: p.payload.evidenceId, spans: p.spans, expansion: p.payload.expansion ?? null })), skipped: packed.skipped, referenceReads, contextMs, retrievalMs: result.durationMs, totalMs: result.durationMs + contextMs, queryInputTokens: result.usage.inputTokens,
								hits: result.hits.map((h) => ({ id: h.evidenceId, documentId: h.documentId, spans: spansFor(h), score: h.score })) });
						}
					}
					for (const run of runs) {
						const rows = rowsByVariant.get(run.variant)!;
						const metrics = summarize(rows), slices = Object.fromEntries(["zh", "en", "table", "prose", "development", "frozen"].map((slice) => [slice, summarize(rows.filter((r) => slice === "table" ? r.table : slice === "prose" ? !r.table : r.language === slice || r.split === slice))]));
						run.modes.push({ mode, metrics, slices, rows }); console.log(JSON.stringify({ variant: run.variant, mode, metrics }));
					}
				}
				const run: IndexRun = { index, protocolHash: digest(protocol), startedAt, completedAt: new Date().toISOString(), documents, sourceIntegrity: true, runs, databaseBytesIncludingWal: ["knowledge.sqlite", "knowledge.sqlite-wal", "knowledge.sqlite-shm"].map((name) => resolve(dir, name)).filter(existsSync).reduce((n, p) => n + statSync(p).size, 0) };
				writeJson(path, run); indexes.push(run);
			} finally { store.close(); }
		}
		writeJson(resolve("docs/evidence/knowledge-sentence-v2.json"), { schemaVersion: "knowledge-sentence-results.v2", executedAt: new Date().toISOString(), root, protocol, protocolHash: digest(protocol), model: embedding.signature,
			hardware: { cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), platform: platform(), release: release(), node: process.version, icu: process.versions.icu, concurrency: 1, onnxThreads: [2, 1] }, indexes,
			generation: { calls: 0, correctness: null, costUsd: null }, paidApiCalls: 0, productionPromotion: null });
		console.log(JSON.stringify({ report: "docs/evidence/knowledge-sentence-v2.json", protocolHash: digest(protocol) }));
	} finally { process.removeListener("SIGINT", cancel); await embedding.close(); }
}

interface Row {
	id: string; language: string; split: string; table: boolean; category: string; top5: ReturnType<typeof sentenceScore>; budget: ReturnType<typeof sentenceScore>; rawNoAnswerCorrect: boolean | null;
	contextTokens: number; selected: Array<{ id: string; spans: Span[]; expansion: ReturnType<typeof expandEvidence>["payload"]["expansion"] | null }>; skipped: ReturnType<typeof packPackets>["skipped"];
	referenceReads: number; contextMs: number; retrievalMs: number; totalMs: number; queryInputTokens: number | null; hits: Array<{ id: string; documentId: string; spans: Span[]; score: number }>;
}
function summarize(rows: Row[]) {
	const answered = rows.filter((r) => r.budget);
	return { cases: rows.length, answerable: answered.length, recallAt5: mean(answered.map((r) => r.top5!.recall)), mrrAt5: mean(answered.map((r) => r.top5!.mrr)), anchorRecallAtBudget: mean(answered.map((r) => r.budget!.recall)),
		bundleCompleteAtBudget: mean(answered.map((r) => r.budget!.complete)), bundleCoverageAtBudget: mean(answered.map((r) => r.budget!.bundleCoverage)), rawNoAnswerAccuracy: mean(rows.flatMap((r) => r.rawNoAnswerCorrect === null ? [] : [Number(r.rawNoAnswerCorrect)])),
		contextTokensMean: mean(rows.map((r) => r.contextTokens)), contextTokensMax: rows.length ? Math.max(...rows.map((r) => r.contextTokens)) : null, returnedChunksMean: mean(rows.map((r) => r.selected.length)), referenceReadsMean: mean(rows.map((r) => r.referenceReads)),
		retrievalP50Ms: percentile(rows.map((r) => r.retrievalMs), .5), retrievalP95Ms: percentile(rows.map((r) => r.retrievalMs), .95), contextP50Ms: percentile(rows.map((r) => r.contextMs), .5), contextP95Ms: percentile(rows.map((r) => r.contextMs), .95), totalP50Ms: percentile(rows.map((r) => r.totalMs), .5), totalP95Ms: percentile(rows.map((r) => r.totalMs), .95), queryInputTokens: rows.reduce((n, r) => n + (r.queryInputTokens ?? 0), 0) };
}
interface OutputRun {
	variant: SentenceVariant["id"]; expansion: string;
	boundaries: Array<{ id: string; indexedComplete: boolean; returnedComplete: boolean; tokens: number; skipped: ReturnType<typeof packPackets>["skipped"]; sourceIds: string[] }>;
	longSentences: Array<{ documentId: string; span: Span; indexedComplete: boolean; returnedComplete: boolean; tokens: number; skipped: ReturnType<typeof packPackets>["skipped"]; sourceIds: string[] }>;
	modes: Array<{ mode: string; metrics: ReturnType<typeof summarize>; slices: Record<string, ReturnType<typeof summarize>>; rows: Row[] }>;
}
interface IndexRun {
	index: SentenceVariant["index"]; protocolHash: string; startedAt: string; completedAt: string; sourceIntegrity: boolean; databaseBytesIncludingWal: number;
	documents: Array<{ documentId: string; chunks: number; linkedChildren: number; reused: boolean; elapsedMs: number; indexed: unknown }>; runs: OutputRun[];
}
