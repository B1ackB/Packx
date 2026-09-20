import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceBlock, EvidenceHit, EvidenceResult, KnowledgeDocument } from "../../src/enterprise/knowledge";
import type { AgentToolExecutionContext } from "../../src/agent/contracts";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { coffeeKnowledgeFixtures } from "../../src/manufacturing/knowledgeFixtures";
import { assessPackagingEvidence, expandPackagingQuery, packagingRetrievalPolicy } from "../../src/manufacturing/knowledgeRetrieval";
import { diverseTables, fieldRanking, type RankRow } from "./ranking";
import { KnowledgeStore } from "./store";
import { LexicalEmbedding } from "./embedding";
import { KnowledgeService } from "./service";

const scope = { tenantId: "t1", workspaceId: "w1" }, now = "2026-09-17T10:00:00.000Z";
const fixture = coffeeKnowledgeFixtures()[0];
const doc: KnowledgeDocument = { ...scope, versionId: "version1", contentHash: "hash1", importedAt: now, status: "indexed", indexRevision: 1, failure: null, manifest: fixture };
function row(id: number, text: string, table?: string, subject = "sample"): RankRow {
	const block: EvidenceBlock = { text, location: { section: "Methods", page: 1, ...(table ? { table, row: id } : {}) }, parameters: [] };
	if (table) block.table = { headers: ["Sample", "Thickness"], units: ["", "µm"], rows: [[subject, "100"]], footnotes: [], conditions: "" };
	return { id: `version1:${id}`, doc, block, terms: [] };
}
const hit = (block = fixture.blocks[1]): EvidenceHit => ({ ...fixture, ...block, evidenceId: "version1:1", versionId: doc.versionId, contentHash: doc.contentHash, warnings: [], score: 1 });
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function setup() {
	const root = mkdtempSync(join(tmpdir(), "packx-ranking-")), embedding = new LexicalEmbedding();
	const store = new KnowledgeStore(root, embedding, undefined, () => now, packagingRetrievalPolicy);
	cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
	return { store, embedding };
}

describe("field ranking and table budgets", () => {
	it("ranks a distinguishing method above boilerplate repeated in captions", () => {
		const rows = [row(1, "The thickness was measured with a microscope."), ...[2, 3, 4].map((n) => row(n, "Thickness microscope study samples films table", "T1"))];
		expect(fieldRanking(rows, "Which microscope measured thickness in the study?")[0].row.id).toBe("version1:1");
	});
	it("breaks tied scores in source order instead of random content hash order", () => {
		const first = row(1, "thickness"), next = row(2, "thickness"); first.id = "zzz:1"; next.id = "aaa:2";
		expect(fieldRanking([next, first], "thickness").map((r) => r.row.id)).toEqual(["zzz:1", "aaa:2"]);
	});
	it("keeps useful sections and conflicting document versions, then fills unused slots", () => {
		const rows = [row(1, "caption", "T1"), row(2, "caption", "T1"), row(3, "method"), row(4, "conflict", "T1")];
		rows[3].doc = { ...doc, versionId: "version2" };
		const ranked = rows.map((r, n) => ({ row: r, score: 10 - n }));
		expect(diverseTables(ranked, 3).map((r) => r.row.id)).toEqual(["version1:1", "version1:3", "version1:4"]);
		expect(diverseTables(ranked, 4)).toHaveLength(4);
	});
	it.each([["GP", "LDPE"], ["PLA-C3", "PLA-O3"]])("preserves explicitly requested rows %s and %s for comparison", (a, b) => {
		const ranked = [row(1, "caption", "T1", a), row(2, "caption", "T1", b), row(3, "other")].map((r, n) => ({ row: r, score: 10 - n }));
		expect(diverseTables(ranked, 2, `${a} 和 ${b} 厚度`).map((r) => r.row.id)).toEqual(["version1:1", "version1:2"]);
	});
	it("does not merge separate tables that share a section anchor", () => {
		const rows = [row(1, "first table", "T1"), row(2, "second table", "T2"), row(3, "method")];
		for (const r of rows) r.block.location.anchor = "methods";
		expect(diverseTables(rows.map((r) => ({ row: r, score: 1 })), 2).map((r) => r.row.id)).toEqual(["version1:1", "version1:2"]);
	});
});

describe("bounded structured evidence assessment", () => {
	it("expands terminology without inventing quantities, models or source selections", () => {
		const query = "500 克 REC/STD OTR 厚度和测试条件";
		const expanded = expandPackagingQuery(query);
		expect(expanded.startsWith(query)).toBe(true); expect(expanded).toContain("thickness");
		expect(expanded.match(/\d+/g)).toEqual(["500"]); expect(expandPackagingQuery("REC thickness OTR")).toBe("REC thickness OTR");
	});
	it("reports available values without confirming facts, and requires the named sample", () => {
		expect(assessPackagingEvidence("DEMO-PE-A 厚度", [hit()])).toMatchObject({ status: "source_values_available", conclusionAllowed: false });
		expect(assessPackagingEvidence("UNKNOWN-MODEL 厚度", [hit()])).toMatchObject({ status: "insufficient_evidence", checks: [{ status: "missing", evidenceIds: [] }] });
	});
	it("does not let related passages fill production gaps or hide a missing field", () => {
		for (const query of ["500 克咖啡袋尺寸", "订单报价", "FSC 认证", "保质期", "热封温度", "阀门开启压力", "厚度和报价"]) {
			expect(assessPackagingEvidence(query, [hit()]).status).toBe("insufficient_evidence");
		}
	});
	it("distinguishes a value from missing units, conditions, and multi-sample comparison", () => {
		const incomplete = hit(); incomplete.parameters = incomplete.parameters.map((p) => ({ ...p, originalUnit: "" }));
		expect(assessPackagingEvidence("OTR 原值及单位", [incomplete]).status).toBe("needs_review");
		expect(assessPackagingEvidence("厚度测试方法", [hit()]).status).toBe("needs_review");
		expect(assessPackagingEvidence("DEMO-PE-A 和 DEMO-PET-B 厚度", [hit()]).status).toBe("needs_review");
		expect(assessPackagingEvidence("咖啡包装是否适用", [hit()])).toMatchObject({ status: "needs_review", checks: [], conclusionAllowed: false });
	});
});

describe("policy integration and permission regression", () => {
	it("isolates term frequency, scores, references and assessments before all three retrieval modes", async () => {
		const { store } = setup(); const own = store.import(scope, fixture, "operator"); await store.process(scope, own.versionId);
		const modes = ["keyword", "vector", "hybrid"] as const;
		const before = await Promise.all(modes.map((mode) => store.search(scope, { query: "thickness", mode })));
		const foreign = { tenantId: "t2", workspaceId: "w2" }, privateFixture = structuredClone(fixture);
		privateFixture.blocks = Array.from({ length: 20 }, () => fixture.blocks[1]);
		const hidden = store.import(foreign, privateFixture, "operator"); await store.process(foreign, hidden.versionId);
		for (const [i, mode] of modes.entries()) {
			const after = await store.search(scope, { query: "thickness", mode });
			expect(after.hits).toEqual(before[i].hits); expect(after.assessment).toEqual(before[i].assessment); expect(after.corpusVersion).toBe(before[i].corpusVersion);
			expect(after.retrievalVersion).toBe(packagingRetrievalPolicy.version);
		}
		expect(() => store.readEvidence(scope, `${hidden.versionId}:1`)).toThrow("evidence_unavailable");
	});
	it.each(["vector", "hybrid"] as const)("removes evidence and its field references if revoked during %s inference", async (mode) => {
		const { store, embedding } = setup(); const own = store.import(scope, fixture, "operator"); await store.process(scope, own.versionId);
		const embed = embedding.embed.bind(embedding);
		embedding.embed = async (texts) => { store.transition(scope, own.versionId, "withdrawn", "operator"); return embed(texts); };
		const result = await store.search(scope, { query: "厚度", mode });
		expect(result.hits).toEqual([]); expect(result.assessment).toMatchObject({ status: "insufficient_evidence", checks: [{ evidenceIds: [] }] });
	});
	it("recomputes field references after the real Tool result is bounded", async () => {
		const { store } = setup(); const large = structuredClone(fixture);
		large.blocks = Array.from({ length: 8 }, (_, i) => ({ ...structuredClone(fixture.blocks[1]), location: { page: i + 1, section: "Parameters", table: `T${i}` }, text: "thickness " + "synthetic context ".repeat(220) }));
		const own = store.import(scope, large, "operator"); await store.process(scope, own.versionId);
		const engine = new ProposalRunEngine(new InMemoryEnterpriseEventStore(), "requirement-brief");
		const tool = new KnowledgeService(store, new InMemoryStageJobQueue()).tools(engine)[0];
		const context: AgentToolExecutionContext = { ...scope, runId: "run", stageId: "stage", actorId: "operator", executionId: "bounded", toolCallId: "bounded", idempotencyKey: "bounded", signal: new AbortController().signal };
		const result = await tool.execute({ query: "thickness", mode: "keyword", limit: 8 }, context) as EvidenceResult;
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(23_000); expect(result.gaps).toContain("result_bounded");
		expect(result.hits.length).toBeGreaterThan(0); expect(result.hits.length).toBeLessThan(8);
		expect(result.assessment!.checks[0].evidenceIds).toEqual(result.hits.map((h) => h.evidenceId));
		await expect(tool.execute({ query: "thickness", mode: "keyword", tenantId: "other" }, context)).rejects.toThrow("invalid_knowledge_query");
	});
});
