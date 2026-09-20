import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { loadCoffeeCorpus } from "../manufacturing/coffeeOpenCorpus";
import { realKnowledgeCases } from "../../eval/knowledgeRealCases";
import { chunkingVariants, sourceDocuments, freezeChunkCases, chunkDocument, tokenRanges, coverage, scoreSpans, packEvidence, evidencePayload } from "../../eval/knowledgeChunkingSupport";
import type { EvidenceHit } from "../../src/enterprise/knowledge";
import { assertImport } from "./validation";

const corpus = loadCoffeeCorpus(), docs = sourceDocuments(corpus), cases = freezeChunkCases(realKnowledgeCases, docs);
const words = (text: string) => text.match(/\S+/g)?.length ?? 0;

it("freezes source-position labels independently of candidate chunk identifiers", () => {
	expect(cases).toEqual(JSON.parse(readFileSync("data/knowledge/chunking-v1/cases.json", "utf8")));
	expect(cases).toHaveLength(64); expect(cases.filter((c) => c.expected.length)).toHaveLength(56);
	for (const item of cases) for (const e of item.expected) {
		const unit = docs.flatMap((d) => d.units).find((u) => u.id === e.anchor.unitId)!;
		expect(unit.text.slice(e.anchor.start, e.anchor.end)).toBe(e.quote.startsWith('"') ? JSON.parse(e.quote) : e.quote);
		expect(coverage([e.anchor], e.bundle)).toBe(1);
	}
	const cell = cases.find((c) => c.id === "pla-otr-value-en")!.expected[0];
	const unit = docs.flatMap((d) => d.units).find((u) => u.id === cell.anchor.unitId)!;
	expect(cell.bundle.map((s) => unit.text.slice(s.start, s.end)).join(" ")).toContain("PLA-C3");
	expect(cell.bundle.map((s) => unit.text.slice(s.start, s.end)).join(" ")).toContain("0.1 MPa");
});

it("preserves the baseline and source table context while grouping only adjacent rows of one table", () => {
	for (const doc of docs) {
		const baseline = chunkDocument(doc, chunkingVariants[0], words);
		expect(baseline.map((c) => c.block)).toEqual(doc.manifest.blocks.map((b) => ({ ...b, parameters: [] })));
		const grouped = chunkDocument(doc, chunkingVariants[6], words);
		expect(grouped.filter((c) => !c.block.table).map((c) => c.block.text)).toEqual(baseline.filter((c) => !c.block.table).map((c) => c.block.text));
		for (const c of grouped.filter((c) => c.block.table)) {
			expect(c.block.table!.rows.length).toBeLessThanOrEqual(3);
			for (const span of c.spans) {
				const unit = doc.units.find((u) => u.id === span.unitId)!;
				expect(c.block.table!.headers).toEqual(unit.block.table!.headers);
				expect(c.block.table!.units).toEqual(unit.block.table!.units);
				expect(c.block.table!.footnotes).toEqual(unit.block.table!.footnotes);
				expect(c.block.table!.conditions).toEqual(unit.block.table!.conditions);
				expect(c.block.table!.rows).toContainEqual(unit.block.table!.rows[0]);
			}
		}
		for (const variant of chunkingVariants) expect(() => assertImport({ ...doc.manifest, blocks: chunkDocument(doc, variant, words).map((c) => c.block) })).not.toThrow();
	}
});

it("caps word-boundary windows, retains all non-whitespace text, and makes overlap advance", () => {
	const text = "alpha beta gamma delta epsilon zeta eta theta iota";
	for (const overlap of [0, 2]) {
		const ranges = tokenRanges(text, 4, overlap, words);
		expect(ranges.every(([start, end]) => words(text.slice(start, end)) <= 4)).toBe(true);
		for (let i = 0; i < text.length; i++) if (text[i] !== " ") expect(ranges.some(([start, end]) => i >= start && i < end)).toBe(true);
		expect(ranges.every(([start], i) => i === 0 || start > ranges[i - 1][0])).toBe(true);
	}
	expect(() => tokenRanges(text, 4, 4, words)).toThrow();
});

it("does not double-count overlap or match equal offsets in a different source unit", () => {
	const span = { unitId: "u", start: 0, end: 10 };
	expect(coverage([span], [{ ...span, end: 7 }, { ...span, start: 4 }])).toBe(1);
	expect(coverage([span], [{ ...span, end: 7 }, { ...span, end: 7 }])).toBe(.7);
	expect(coverage([span], [{ ...span, unitId: "other" }])).toBe(0);
	const item = { ...cases[0], expected: [{ ...cases[0].expected[0], anchor: span, bundle: [span] }] };
	expect(scoreSpans(item, [[{ ...span, end: 5 }], [{ ...span, start: 5 }]])).toMatchObject({ recall: 1, complete: 1, mrr: 0 });
});

it("counts citation metadata, skips oversized evidence, and never trims tables to fit a budget", () => {
	const make = (id: string, text: string) => ({ evidenceId: id, documentId: "doc", title: "title", publisher: "publisher", model: "model", revision: "rev", sourceUrl: "https://example.org", location: { section: "s" }, text } as EvidenceHit);
	const small = make("small", "value"), large = make("large", "x".repeat(2000));
	const budget = JSON.stringify([evidencePayload(small)]).length;
	const packed = packEvidence([large, small, small], budget, (text) => text.length);
	expect(packed.selected).toEqual([small]); expect(packed.skipped).toEqual(["large", "small"]); expect(packed.tokens).toBe(budget);
	expect(large.text).toHaveLength(2000);
});
