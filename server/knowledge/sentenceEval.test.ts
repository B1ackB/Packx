import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sourceDocuments, coverage, type SourceDocument, type SourceUnit } from "../../eval/knowledgeChunkingSupport";
import { boundaryProbes, expandEvidence, nonWhitespace, packPackets, sentenceChunks, sentenceRanges } from "../../eval/knowledgeSentenceSupport";
import { loadCoffeeCorpus } from "../manufacturing/coffeeOpenCorpus";
import { KnowledgeStore } from "./store";
import { FakeEmbedding } from "./embedding";
import type { EvidenceHit } from "../../src/enterprise/knowledge";

const corpus = loadCoffeeCorpus(), docs = sourceDocuments(corpus), words = (text: string) => text.match(/\S+/g)?.length ?? 0;
const unit = (text: string): SourceUnit => ({ id: "u", documentId: "d", location: { section: "s", paragraph: 1 }, text, block: { location: { section: "s", paragraph: 1 }, text, parameters: [] }, components: [] });
function syntheticDoc(text: string): SourceDocument {
	return sourceDocuments([{ ...corpus[0], documentId: "d", blocks: [unit(text).block] }])[0];
}

it("keeps decimal units and test conditions, handles Chinese punctuation and guarded abbreviations", () => {
	const text = "See Fig. 2 for the film. Dr. Smith used e.g. PLA at 2.61 mm. OTR was 7 cm3/(m2·d) at 23 °C and 0% RH.";
	expect(sentenceRanges(unit(text)).map((s) => text.slice(s.start, s.end))).toEqual(["See Fig. 2 for the film.", "Dr. Smith used e.g. PLA at 2.61 mm.", "OTR was 7 cm3/(m2·d) at 23 °C and 0% RH."]);
	const zh = "测试温度为23 °C，湿度为50%。厚度为0.075 mm，未经订单确认。";
	expect(sentenceRanges(unit(zh), "zh").map((s) => zh.slice(s.start, s.end))).toEqual(["测试温度为23 °C，湿度为50%。", "厚度为0.075 mm，未经订单确认。"]);
});

it("allows an oversized intact sentence and links every bounded long-sentence fragment to its original", () => {
	const text = `The tested material ${"retains unverified sample conditions ".repeat(40)}has thickness 0.075 mm at 23 °C and 50% RH.`;
	const doc = syntheticDoc(text), whole = sentenceChunks(doc, "sentence-500", words), linked = sentenceChunks(doc, "sentence-linked", words);
	expect(whole).toHaveLength(1); expect(whole[0].block.text).toBe(text);
	expect(linked.length).toBeGreaterThan(1);
	for (const c of linked) { expect(words(c.block.text)).toBeLessThanOrEqual(128); expect(c.parent).toEqual({ unitId: doc.units[0].id, start: 0, end: text.length }); }
	const need = nonWhitespace([{ unitId: doc.units[0].id, start: 0, end: text.length }], new Map(doc.units.map((u) => [u.id, u])));
	expect(coverage(need, linked.flatMap((c) => c.spans))).toBe(1);
});

it("keeps all source characters and complete table structures in both sentence indexes", () => {
	for (const doc of docs) for (const kind of ["sentence-500", "sentence-linked"] as const) {
		const chunks = sentenceChunks(doc, kind, words), units = new Map(doc.units.map((u) => [u.id, u]));
		for (const u of doc.units) expect(coverage(nonWhitespace([{ unitId: u.id, start: 0, end: u.text.length }], units), chunks.flatMap((c) => c.spans))).toBe(1);
		expect(chunks.filter((c) => c.block.table).map((c) => c.block.table)).toEqual(doc.manifest.blocks.filter((b) => b.table).map((b) => b.table));
	}
});

it("protects all nineteen known cross-boundary word pairs with sentence-aware chunking", () => {
	const probes = boundaryProbes(docs, JSON.parse(readFileSync("docs/evidence/knowledge-chunking-boundary-audit.json", "utf8")));
	expect(probes).toHaveLength(19);
	for (const p of probes) {
		const doc = docs.find((d) => d.manifest.documentId === p.documentId)!;
		expect(sentenceChunks(doc, "sentence-500", words).some((c) => coverage([p.target], c.spans) === 1)).toBe(true);
	}
});

it("restores source context through server permission checks and rejects another tenant or withdrawn anchor", async () => {
	const root = mkdtempSync(join(tmpdir(), "packx-sentence-eval-")), store = new KnowledgeStore(root, new FakeEmbedding());
	try {
		const doc = syntheticDoc(`The tested material ${"retains sample conditions ".repeat(40)}has thickness 0.075 mm at 23 °C.`), chunks = sentenceChunks(doc, "legacy-500", words);
		const scope = { tenantId: "tenant-a", workspaceId: "work" }, other = { tenantId: "tenant-b", workspaceId: "work" };
		const version = store.import(scope, { ...doc.manifest, visibility: "workspace", blocks: chunks.map((c) => c.block) }, "owner"); await store.process(scope, version.versionId);
		const hit = store.readEvidence(scope, `${version.versionId}:1`), reads: string[] = [];
		const packet = expandEvidence(hit, doc, chunks, "paragraph", (id) => { reads.push(id); return store.readEvidence(scope, id); });
		expect(packet.payload.text).toBe(doc.units[0].text); expect(packet.payload.expansion!.sourceIds).toHaveLength(chunks.length);
		expect(reads.at(-1)).toBe(hit.evidenceId);
		expect(() => expandEvidence(hit, doc, chunks, "paragraph", (id) => store.readEvidence(other, id))).toThrow("evidence_unavailable");
		store.transition(scope, version.versionId, "withdrawn", "owner");
		expect(() => expandEvidence(hit, doc, chunks, "paragraph", (id) => store.readEvidence(scope, id))).toThrow("evidence_unavailable");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

it("fails closed on a sibling-version mismatch or withdrawal during expansion", () => {
	const doc = syntheticDoc(`The film ${"has unverified research properties ".repeat(30)}contains 7 units.`), chunks = sentenceChunks(doc, "legacy-500", words);
	const hit = (i: number): EvidenceHit => ({ evidenceId: `v:${i + 1}`, versionId: "v", contentHash: "hash", documentId: "d", title: "t", publisher: "p", model: "m", revision: "r", sourceUrl: "https://example.org", provenance: "synthetic", score: 1, warnings: [], ...chunks[i].block });
	expect(() => expandEvidence(hit(0), doc, chunks, "paragraph", (id) => ({ ...hit(Number(id.split(":")[1]) - 1), versionId: "another" }))).toThrow();
	let calls = 0;
	expect(() => expandEvidence(hit(0), doc, chunks, "paragraph", (id) => { if (++calls > 2) throw new Error("evidence_unavailable"); return hit(Number(id.split(":")[1]) - 1); })).toThrow("evidence_unavailable");
});

it("deduplicates equal parent context, charges source lineage, and rejects oversized packets intact", () => {
	const doc = syntheticDoc(`The film ${"has unverified research properties ".repeat(30)}contains 7 units.`), chunks = sentenceChunks(doc, "legacy-500", words);
	const hit = (i: number) => ({ evidenceId: `v:${i + 1}`, versionId: "v", contentHash: "h", documentId: "d", title: "t", ...chunks[i].block }) as EvidenceHit;
	const read = (id: string) => hit(Number(id.split(":")[1]) - 1);
	const packet = expandEvidence(hit(0), doc, chunks, "paragraph", read), duplicate = expandEvidence(hit(1), doc, chunks, "paragraph", read);
	const length = JSON.stringify([packet.payload]).length, packed = packPackets([packet, duplicate], length, (text) => text.length);
	expect(packed.selected).toHaveLength(1); expect(packed.skipped[0].reason).toBe("duplicate"); expect(packed.tokens).toBe(length);
	expect(packPackets([packet], length - 1, (text) => text.length).selected).toHaveLength(0);
	expect(packet.payload.text).toBe(doc.units[0].text);
});
