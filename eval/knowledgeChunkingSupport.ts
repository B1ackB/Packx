import { strict as assert } from "node:assert";
import type { EvidenceBlock, EvidenceHit, EvidenceLocation, KnowledgeImport } from "../src/enterprise/knowledge";
import { digest } from "../server/knowledge/store";
import type { RealCase } from "./knowledgeRealCases";

export const chunkingVariants = [
	{ id: "paragraph-1000-row-1", characters: 1000, tableRows: 1 },
	{ id: "paragraph-500-row-1", characters: 500, tableRows: 1 },
	{ id: "paragraph-1500-row-1", characters: 1500, tableRows: 1 },
	{ id: "section-256-overlap-0-row-1", tokens: 256, overlap: 0, tableRows: 1 },
	{ id: "section-256-overlap-64-row-1", tokens: 256, overlap: 64, tableRows: 1 },
	{ id: "section-384-overlap-64-row-1", tokens: 384, overlap: 64, tableRows: 1 },
	{ id: "paragraph-1000-row-3", characters: 1000, tableRows: 3 },
] as const;
export type Variant = (typeof chunkingVariants)[number];
export type TokenCount = (text: string) => number;
export interface Span { unitId: string; start: number; end: number }
interface Component { kind: "header" | "cell"; column: number; text: string; span: Span }
export interface SourceUnit {
	id: string; documentId: string; location: EvidenceLocation; text: string;
	block: EvidenceBlock; components: Component[];
}
export interface SourceDocument {
	manifest: KnowledgeImport; units: SourceUnit[];
	legacy: Array<{ unit: SourceUnit; span: Span }>;
}
export interface Chunk { block: EvidenceBlock; spans: Span[] }
export interface ChunkCase extends Omit<RealCase, "expected"> {
	expected: Array<{ documentId: string; quote: string; location: EvidenceLocation; anchor: Span; bundle: Span[] }>;
}

/** Offsets refer to normalized source text, not PDF bytes or candidate chunk IDs. */
export function sourceDocuments(corpus: KnowledgeImport[]): SourceDocument[] {
	return corpus.map((manifest) => {
		const units: SourceUnit[] = [], legacy: SourceDocument["legacy"] = [], paragraphs = new Map<string, SourceUnit>();
		for (const block of manifest.blocks) {
			const { part: _part, ...location } = block.location;
			const id = `${manifest.documentId}:${digest(location).slice(0, 20)}`;
			if (block.table) {
				assert.equal(block.table.rows.length, 1);
				const unit: SourceUnit = { id, documentId: manifest.documentId, location, block, text: block.text + "\n", components: [] };
				for (const kind of ["header", "cell"] as const) {
					const values = kind === "header" ? block.table.headers : block.table.rows[0];
					values.forEach((text, column) => {
						const start = unit.text.length; unit.text += text + "\n";
						unit.components.push({ kind, column, text, span: { unitId: id, start, end: start + text.length } });
					});
				}
				unit.text += JSON.stringify({ units: block.table.units, footnotes: block.table.footnotes, conditions: block.table.conditions });
				units.push(unit); legacy.push({ unit, span: { unitId: id, start: 0, end: unit.text.length } });
			} else {
				let unit = paragraphs.get(id);
				if (!unit) {
					unit = { id, documentId: manifest.documentId, location, block, text: "", components: [] };
					paragraphs.set(id, unit); units.push(unit);
				}
				if (unit.text) unit.text += " ";
				const start = unit.text.length; unit.text += block.text;
				legacy.push({ unit, span: { unitId: id, start, end: unit.text.length } });
			}
		}
		assert.equal(new Set(units.map((u) => u.id)).size, units.length, "Ambiguous source locations");
		return { manifest, units, legacy };
	});
}

function sentenceSpan(unit: SourceUnit, anchor: Span): Span {
	const boundaries = [0, ...Array.from(unit.text.matchAll(/[.!?]\s+(?=[A-Z(])/g), (m) => m.index + m[0].length), unit.text.length];
	const [start, end] = trimRange(unit.text, boundaries.filter((n) => n <= anchor.start).at(-1)!, boundaries.find((n) => n >= anchor.end)!);
	return { unitId: unit.id, start, end };
}

/** Translate the pre-existing provisional labels BEFORE evaluating candidate retrieval. */
export function freezeChunkCases(cases: RealCase[], documents: SourceDocument[]): ChunkCase[] {
	return cases.map((item) => ({ ...item, expected: item.expected.map((label) => {
		const doc = documents.find((d) => d.manifest.documentId === label.documentId)!;
		const { unit, span } = doc.legacy[label.block - 1];
		let anchor: Span, bundle: Span[];
		if (unit.block.table) {
			const quote = label.quote.startsWith('"') ? JSON.parse(label.quote) as string : label.quote;
			const exact = unit.components.filter((c) => c.text === quote);
			const matches = exact.length ? exact : unit.components.filter((c) => c.text.includes(quote));
			assert.equal(matches.length, 1, `Ambiguous table label ${item.id}`);
			const component = matches[0], start = component.span.start + component.text.indexOf(quote);
			anchor = { unitId: unit.id, start, end: start + quote.length };
			bundle = [unit.components.find((c) => c.kind === "cell" && c.column === 0)!.span,
				unit.components.find((c) => c.kind === "header" && c.column === component.column)!.span,
				component.span];
		} else {
			const text = unit.text.slice(span.start, span.end), start = text.indexOf(label.quote);
			// For repeated prose values (e.g. 180 days in one sentence), freeze the first occurrence.
			assert(start >= 0, `Missing quote ${item.id}`);
			anchor = { unitId: unit.id, start: span.start + start, end: span.start + start + label.quote.length };
			bundle = [sentenceSpan(unit, anchor)];
		}
		return { documentId: label.documentId, quote: label.quote, location: unit.location, anchor, bundle: unionSpans(bundle) };
	}) }));
}

export function unionSpans(spans: Span[]): Span[] {
	const result: Span[] = [];
	for (const span of [...spans].sort((a, b) => a.unitId.localeCompare(b.unitId) || a.start - b.start)) {
		const last = result.at(-1);
		if (last && last.unitId === span.unitId && span.start <= last.end) last.end = Math.max(last.end, span.end);
		else result.push({ ...span });
	}
	return result;
}
export function coverage(target: Span[], available: Span[]): number {
	const need = unionSpans(target), have = unionSpans(available);
	const size = need.reduce((n, s) => n + s.end - s.start, 0);
	const found = need.reduce((n, s) => n + have.filter((h) => h.unitId === s.unitId).reduce((v, h) => v + Math.max(0, Math.min(s.end, h.end) - Math.max(s.start, h.start)), 0), 0);
	return size ? found / size : 1;
}

function trimRange(text: string, start: number, end: number): [number, number] {
	while (start < end && /\s/.test(text[start])) start++;
	while (end > start && /\s/.test(text[end - 1])) end--;
	return [start, end];
}
function characterRanges(text: string, max: number): Array<[number, number]> {
	const result: Array<[number, number]> = []; let start = 0;
	while (start < text.length) {
		let end = text.length;
		if (end - start > max) {
			const rest = text.slice(start); let at = rest.lastIndexOf(". ", max) + 1;
			if (at < 300) at = rest.lastIndexOf(" ", max);
			if (at < 1) at = max;
			end = start + at;
		}
		result.push(trimRange(text, start, end)); start = end;
		while (start < text.length && /\s/.test(text[start])) start++;
	}
	return result;
}

/** Token cap applies to prose, with word boundaries and same-section scope. Tables stay atomic. */
export function tokenRanges(text: string, cap: number, overlap: number, count: TokenCount): Array<[number, number]> {
	assert(cap > overlap && overlap >= 0);
	const words = Array.from(text.matchAll(/\S+/g), (m) => ({ start: m.index, end: m.index + m[0].length }));
	const result: Array<[number, number]> = []; let first = 0;
	while (first < words.length) {
		let low = first + 1, high = words.length;
		assert(count(text.slice(words[first].start, words[first].end)) <= cap, "Unsplit token exceeds cap");
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (count(text.slice(words[first].start, words[mid - 1].end)) <= cap) low = mid;
			else high = mid - 1;
		}
		const end = low; result.push([words[first].start, words[end - 1].end]);
		assert(count(text.slice(words[first].start, words[end - 1].end)) <= cap);
		if (end === words.length) break;
		let next = end;
		while (next > first + 1 && count(text.slice(words[next - 1].start, words[end - 1].end)) <= overlap) next--;
		first = next;
	}
	return result;
}

export function chunkDocument(doc: SourceDocument, variant: Variant, count: TokenCount): Chunk[] {
	const chunks: Chunk[] = [];
	// Preserve the exact baseline, including its current locations and string boundaries.
	if (variant.id === "paragraph-1000-row-1") return doc.manifest.blocks.map((b, i) => ({ block: { ...b, parameters: [] }, spans: [doc.legacy[i].span] }));
	for (let index = 0; index < doc.units.length;) {
		const unit = doc.units[index];
		if (unit.block.table) {
			const group = [unit]; index++;
			while (group.length < variant.tableRows && index < doc.units.length) {
				const next = doc.units[index];
				if (!next.block.table || next.location.anchor !== unit.location.anchor || next.location.table !== unit.location.table) break;
				const shape = (b: EvidenceBlock) => ({ text: b.text, ...b.table, rows: [] });
				assert.deepEqual(shape(next.block), shape(unit.block)); group.push(next); index++;
			}
			chunks.push({ block: { ...unit.block, table: { ...unit.block.table, rows: group.flatMap((u) => u.block.table!.rows) }, parameters: [] },
				spans: group.map((u) => ({ unitId: u.id, start: 0, end: u.text.length })) });
		} else if ("characters" in variant) {
			for (const [part, [start, end]] of characterRanges(unit.text, variant.characters).entries()) chunks.push({
				block: { location: { ...unit.location, part: part + 1 }, text: unit.text.slice(start, end), parameters: [] }, spans: [{ unitId: unit.id, start, end }],
			});
			index++;
		} else {
			const group = [unit]; index++;
			while (index < doc.units.length && !doc.units[index].block.table && doc.units[index].location.section === unit.location.section && doc.units[index].location.anchor === unit.location.anchor) group.push(doc.units[index++]);
			let text = "";
			const offsets = group.map((u) => { if (text) text += "\n\n"; const start = text.length; text += u.text; return { unit: u, start, end: text.length }; });
			for (const [part, [start, end]] of tokenRanges(text, variant.tokens, variant.overlap, count).entries()) {
				const members = offsets.filter((o) => o.start < end && o.end > start);
				chunks.push({ block: { location: { ...members[0].unit.location, part: part + 1 }, text: text.slice(start, end), parameters: [] },
					spans: members.map((o) => ({ unitId: o.unit.id, start: Math.max(start, o.start) - o.start, end: Math.min(end, o.end) - o.start })) });
			}
		}
	}
	return chunks;
}

/** Canonical payload includes provenance and table context; no prompt or generation tokens claimed. */
export function evidencePayload(hit: EvidenceHit) {
	return { evidenceId: hit.evidenceId, documentId: hit.documentId, title: hit.title, publisher: hit.publisher, model: hit.model, revision: hit.revision, sourceUrl: hit.sourceUrl, location: hit.location, text: hit.text, table: hit.table };
}
export function packEvidence(hits: EvidenceHit[], budget: number, count: TokenCount) {
	const selected: EvidenceHit[] = [], skipped: string[] = [];
	for (const hit of hits) {
		if (count(JSON.stringify([...selected, hit].map(evidencePayload))) <= budget) selected.push(hit);
		else skipped.push(hit.evidenceId);
	}
	return { selected, skipped, tokens: count(JSON.stringify(selected.map(evidencePayload))) };
}
export function scoreSpans(item: ChunkCase, hits: Span[][]) {
	if (!item.expected.length) return null;
	const spans = hits.flat();
	const recall = item.expected.filter((e) => coverage([e.anchor], spans) === 1).length / item.expected.length;
	const rank = hits.findIndex((h) => item.expected.some((e) => coverage([e.anchor], h) === 1));
	const bundleCoverage = item.expected.reduce((n, e) => n + coverage(e.bundle, spans), 0) / item.expected.length;
	const complete = item.expected.filter((e) => coverage(e.bundle, spans) === 1).length / item.expected.length;
	return { recall, mrr: rank < 0 ? 0 : 1 / (rank + 1), bundleCoverage, complete };
}

export const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
export const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1] : null;
