import { strict as assert } from "node:assert";
import type { EvidenceHit } from "../src/enterprise/knowledge";
import { chunkDocument, chunkingVariants, coverage, evidencePayload, tokenRanges, unionSpans, type Chunk, type ChunkCase, type SourceDocument, type SourceUnit, type Span, type TokenCount } from "./knowledgeChunkingSupport";

export const sentenceVariants = [
	{ id: "current-1000", index: "legacy-1000", expansion: "none" },
	{ id: "previous-500", index: "legacy-500", expansion: "none" },
	{ id: "whole-sentence-500", index: "sentence-500", expansion: "none" },
	{ id: "long-sentence-linked", index: "sentence-linked", expansion: "linked" },
	{ id: "500-restore-sentence", index: "legacy-500", expansion: "sentence" },
	{ id: "500-restore-paragraph", index: "legacy-500", expansion: "paragraph" },
	{ id: "linked-restore-paragraph", index: "sentence-linked", expansion: "paragraph" },
] as const;
export type SentenceVariant = (typeof sentenceVariants)[number];
export interface SentenceChunk extends Chunk { parent?: Span }

/** Native deterministic segmentation; ICU version is frozen in the experiment protocol. */
export function sentenceRanges(unit: SourceUnit, language = "en"): Span[] {
	const result: Span[] = [];
	for (const s of new Intl.Segmenter(language, { granularity: "sentence" }).segment(unit.text)) {
		const leading = s.segment.length - s.segment.trimStart().length;
		const end = s.index + s.segment.trimEnd().length;
		if (end <= s.index + leading) continue;
		const previous = result.at(-1);
		// Bounded abbreviation guard, not a claim of semantic sentence recognition.
		if (previous && /\b(?:Dr|Mr|Mrs|Ms|Prof|Fig|Figs|Eq|Eqs|Ref|Refs|vs|e\.g|i\.e|et al)\.$/i.test(unit.text.slice(previous.start, previous.end))) previous.end = end;
		else result.push({ unitId: unit.id, start: s.index + leading, end });
	}
	return result;
}

export function sentenceChunks(doc: SourceDocument, index: SentenceVariant["index"], count: TokenCount): SentenceChunk[] {
	if (index === "legacy-1000" || index === "legacy-500") return chunkDocument(doc, chunkingVariants[index === "legacy-1000" ? 0 : 1], count);
	const result: SentenceChunk[] = [];
	for (const unit of doc.units) {
		if (unit.block.table) { result.push({ block: { ...unit.block, parameters: [] }, spans: [{ unitId: unit.id, start: 0, end: unit.text.length }] }); continue; }
		let pending: Span | undefined, part = 0;
		const emit = (span: Span, parent?: Span) => result.push({ block: { location: { ...unit.location, part: ++part }, text: unit.text.slice(span.start, span.end), parameters: [] }, spans: [span], ...(parent ? { parent } : {}) });
		const flush = () => { if (pending) emit(pending); pending = undefined; };
		for (const s of sentenceRanges(unit, doc.manifest.language)) {
			if (index === "sentence-linked" && s.end - s.start > 500) {
				flush();
				for (const [start, end] of tokenRanges(unit.text.slice(s.start, s.end), 128, 32, count)) emit({ unitId: unit.id, start: s.start + start, end: s.start + end }, s);
			} else {
				if (pending && s.end - pending.start > 500) flush();
				pending = pending ? { ...pending, end: s.end } : s;
			}
		}
		flush();
	}
	return result;
}

export function nonWhitespace(spans: Span[], units: Map<string, SourceUnit>): Span[] {
	return spans.flatMap((s) => Array.from(units.get(s.unitId)!.text.slice(s.start, s.end).matchAll(/\S+/g), (m) => ({ unitId: s.unitId, start: s.start + m.index, end: s.start + m.index + m[0].length })));
}
export function sentenceScore(item: ChunkCase, hits: Span[][], units: Map<string, SourceUnit>) {
	if (!item.expected.length) return null;
	const spans = hits.flat();
	const anchors = item.expected.map((e) => nonWhitespace([e.anchor], units)), bundles = item.expected.map((e) => nonWhitespace(e.bundle, units));
	const rank = hits.findIndex((h) => anchors.some((a) => coverage(a, h) === 1));
	return { recall: anchors.filter((a) => coverage(a, spans) === 1).length / anchors.length, mrr: rank < 0 ? 0 : 1 / (rank + 1), complete: bundles.filter((b) => coverage(b, spans) === 1).length / bundles.length,
		bundleCoverage: bundles.reduce((n, b) => n + coverage(b, spans), 0) / bundles.length };
}

export interface Packet {
	payload: ReturnType<typeof evidencePayload> & { expansion?: { kind: string; sourceIds: string[]; ranges: Span[] } };
	spans: Span[]; versionId: string;
}

/** Evaluation adapter only. Expansion never accepts labels or queries, and rechecks every source through the store's permission boundary. */
export function expandEvidence(hit: EvidenceHit, doc: SourceDocument, chunks: SentenceChunk[], expansion: SentenceVariant["expansion"], read: (id: string) => EvidenceHit): Packet {
	assert.equal(hit.documentId, doc.manifest.documentId);
	const ordinal = Number(hit.evidenceId.split(":").at(-1)) - 1, chunk = chunks[ordinal]; assert(chunk);
	const check = (id: string, expected: SentenceChunk) => {
		const source = read(id);
		assert.equal(source.documentId, hit.documentId); assert.equal(source.versionId, hit.versionId); assert.equal(source.contentHash, hit.contentHash);
		assert.equal(source.text, expected.block.text); assert.deepEqual(source.table, expected.block.table);
		return source;
	};
	const fresh = check(hit.evidenceId, chunk);
	let target = chunk.spans;
	if (!chunk.block.table && expansion !== "none") target = chunk.spans.map((s) => {
		const unit = doc.units.find((u) => u.id === s.unitId)!;
		if (expansion === "linked") return chunk.parent ?? s;
		if (expansion === "paragraph") return { unitId: unit.id, start: 0, end: unit.text.length };
		const sentences = sentenceRanges(unit, doc.manifest.language).filter((r) => r.start < s.end && r.end > s.start);
		assert(sentences.length); return { unitId: unit.id, start: sentences[0].start, end: sentences.at(-1)!.end };
	});
	if (JSON.stringify(target) === JSON.stringify(chunk.spans)) return { payload: evidencePayload(fresh), spans: chunk.spans, versionId: hit.versionId };
	assert.equal(target.length, 1); const span = target[0], unit = doc.units.find((u) => u.id === span.unitId)!;
	const sourceIds: string[] = [], provided: Span[] = [];
	chunks.forEach((c, i) => {
		if (!c.spans.some((s) => s.unitId === span.unitId && s.start < span.end && s.end > span.start)) return;
		const id = `${hit.versionId}:${i + 1}`; check(id, c); sourceIds.push(id); provided.push(...c.spans);
	});
	assert.equal(coverage(nonWhitespace(target, new Map([[unit.id, unit]])), provided), 1, "Expansion source incomplete");
	check(hit.evidenceId, chunk); // Recheck after sibling reads: no stale anchor after withdrawal.
	return { payload: { ...evidencePayload(fresh), text: unit.text.slice(span.start, span.end), location: unit.location, expansion: { kind: expansion, sourceIds, ranges: target } }, spans: target, versionId: hit.versionId };
}

export function packPackets(packets: Packet[], budget: number, count: TokenCount) {
	const selected: Packet[] = [], skipped: Array<{ id: string; reason: "duplicate" | "budget" }> = [], keys = new Set<string>();
	for (const p of packets) {
		const key = JSON.stringify([p.versionId, unionSpans(p.spans)]);
		if (keys.has(key)) { skipped.push({ id: p.payload.evidenceId, reason: "duplicate" }); continue; }
		if (count(JSON.stringify([...selected, p].map((p) => p.payload))) > budget) { skipped.push({ id: p.payload.evidenceId, reason: "budget" }); continue; }
		keys.add(key); selected.push(p);
	}
	return { selected, skipped, tokens: count(JSON.stringify(selected.map((p) => p.payload))) };
}

export interface BoundaryProbe { id: string; documentId: string; target: Span; leftAnchor: Span; phrase: string }
/** Independent of sentence segmentation: two adjacent source words at each of the 19 recorded failures. */
export function boundaryProbes(documents: SourceDocument[], audit: { results: Array<{ variant: string; examples: Array<{ documentId: string; span: Span }> }> }): BoundaryProbe[] {
	return audit.results.find((r) => r.variant === "paragraph-500-row-1")!.examples.map((example, index) => {
		const unit = documents.find((d) => d.manifest.documentId === example.documentId)!.units.find((u) => u.id === example.span.unitId)!;
		const left = Array.from(unit.text.slice(0, example.span.end).matchAll(/\S+/g)).at(-1)!;
		const right = /\S+/.exec(unit.text.slice(example.span.end))!;
		const target = { unitId: unit.id, start: left.index, end: example.span.end + right.index + right[0].length };
		return { id: `boundary-${index + 1}`, documentId: example.documentId, target, leftAnchor: { ...target, end: left.index + left[0].length }, phrase: unit.text.slice(target.start, target.end) };
	});
}
