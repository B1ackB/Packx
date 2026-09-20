import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceParameter, KnowledgeImport } from "../../src/enterprise/knowledge";
import type { AgentToolExecutionContext } from "../../src/agent/contracts";
import { coffeeKnowledgeFixtures } from "../../src/manufacturing/knowledgeFixtures";
import { coffeeEvidenceReview, compareParameters } from "../../src/manufacturing/packagingKnowledge";
import { KnowledgeStore } from "../knowledge/store";
import { LexicalEmbedding } from "../knowledge/embedding";
import { assertImport } from "../knowledge/validation";
import { assertComparisonInput, compareEvidence, createPackagingComparisonTool } from "./knowledgeComparison";
import { knowledgeWorkflow } from "../eval/knowledgeWorkflow";

const snapshot = JSON.parse(readFileSync("data/knowledge/comparison-v1/cases.json", "utf8")) as { cases: Array<{ id: string; left: EvidenceParameter; right: EvidenceParameter; expected: { comparable: boolean; difference?: number } }> };
const scope = { tenantId: "t1", workspaceId: "w1" }, other = { tenantId: "t2", workspaceId: "w2" };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function setup(now = () => "2026-09-17T10:00:00.000Z") {
	const root = mkdtempSync(join(tmpdir(), "packx-compare-"));
	const store = new KnowledgeStore(root, new LexicalEmbedding(), undefined, now);
	cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
	const docs = [];
	for (const fixture of coffeeKnowledgeFixtures().slice(0, 2)) { const doc = store.import(scope, fixture, "operator"); await store.process(scope, doc.versionId); docs.push(doc); }
	return { store, left: { evidenceId: `${docs[0].versionId}:2`, parameterIndex: 0 }, right: { evidenceId: `${docs[1].versionId}:2`, parameterIndex: 0 }, docs };
}

describe("pre-fix frozen comparison cases (not industrial gold)", () => {
	it.each(snapshot.cases)("$id", ({ left, right, expected }) => {
		const result = compareParameters(left, right);
		expect(result.comparable).toBe(expected.comparable);
		if (expected.comparable) expect(result.difference).toBeCloseTo(expected.difference!, 10);
		else { expect(result.reasons.length).toBeGreaterThan(0); expect(result.difference).toBeUndefined(); }
	});
	it("rejects wrong dimensions and object-prototype names without crashing", () => {
		const p = snapshot.cases[0].left;
		for (const name of ["toString", "constructor", "__proto__"]) expect(compareParameters({ ...p, name }, { ...p, name }).comparable).toBe(false);
		expect(compareParameters({ ...p, originalUnit: "kg" }, { ...p, originalUnit: "kg" }).comparable).toBe(false);
	});
	it("names the specific missing side and condition instead of equating unknown values", () => {
		const p = snapshot.cases.find((c) => c.id === "otr-complete")!.left;
		const result = compareParameters(p, { ...p, testConditions: p.testConditions!.filter((c) => c.name !== "gas") });
		expect(result.conditionChecks.find((c) => c.name === "gas")).toMatchObject({ left: { value: "O2" }, right: undefined, status: "missing" });
		expect(result.conditionChecks.find((c) => c.name === "temperature")?.status).toBe("same");
	});
	it("bounds the advisory cross-product instead of silently claiming a full conflict scan", async () => {
		const { store, left, right } = await setup(), a = store.readEvidence(scope, left.evidenceId), b = store.readEvidence(scope, right.evidenceId);
		a.parameters = Array.from({ length: 16 }, () => a.parameters[0]); b.parameters = Array.from({ length: 16 }, () => b.parameters[0]);
		const review = coffeeEvidenceReview([a, b]); expect(review.comparisons).toHaveLength(64); expect(review.comparisonTruncated).toBe(true);
	});
	it("checks declared optional conditions and permits matching categorical orientation", () => {
		const p = snapshot.cases[0].left;
		for (const condition of [{ name: "temperature", value: "unknown", unit: "C" }, { name: "temperature", value: "23", unit: "kg" }]) {
			const source = { ...p, testConditions: [condition] }; expect(compareParameters(source, source).comparable).toBe(false);
		}
		const source = { ...p, testConditions: [{ name: "orientation", value: "MD", unit: "" }] }; expect(compareParameters(source, source).comparable).toBe(true);
	});
});

describe("typed condition import", () => {
	function manifest(): KnowledgeImport {
		const m = coffeeKnowledgeFixtures()[0], p = structuredClone(snapshot.cases.find((c) => c.id === "otr-complete")!.left);
		m.blocks = [{ location: { page: 1, section: "Synthetic condition table" }, text: `OTR ${p.originalValue} ${p.originalUnit}; ${p.conditions}; synthetic only`, parameters: [p] }];
		return m;
	}
	it("retains explicit conditions only when raw values and units occur in source", () => {
		const m = manifest(); expect(() => assertImport(m)).not.toThrow();
		m.blocks[0].parameters[0].testConditions![0].value = "invented temperature";
		expect(() => assertImport(m)).toThrow("test_condition_not_in_source");
	});
	it("rejects duplicate condition identities and extra condition properties", () => {
		const m = manifest(), p = m.blocks[0].parameters[0];
		p.testConditions!.push(p.testConditions![0]); expect(() => assertImport(m)).toThrow("invalid_import_manifest");
		p.testConditions = [{ name: "temperature", value: "23", unit: "C", tenantId: "t2" } as unknown as NonNullable<EvidenceParameter["testConditions"]>[number]];
		expect(() => assertImport(m)).toThrow("invalid_import_manifest");
	});
});

describe("server comparison boundary", () => {
	it("binds exact parameters to immutable versions, normalizes deterministically and audits references only", async () => {
		const { store, left, right } = await setup(); const result = compareEvidence(store, scope, { left, right, region: "HK" }, "comparison-test");
		expect(result).toMatchObject({ status: "comparable", verification: "unverified", conclusionAllowed: false, comparison: { difference: 0, unit: "µm" }, left: { parameter: { originalValue: "0.1", originalUnit: "mm" } }, right: { parameter: { originalValue: "100", originalUnit: "µm" } } });
		expect(result.left.evidenceId).toBe(left.evidenceId); expect(result.left.location.page).toBe(2);
		const event = store.audit(scope).find((e) => e.type === "knowledge.parameters_read")!;
		expect(event.correlation).toBe("comparison-test"); expect(JSON.parse(String(event.data))).toMatchObject({ references: [left, right], consumerVersion: result.ruleVersion });
		expect(String(event.data)).not.toContain("originalValue"); expect(JSON.stringify(result).length).toBeLessThan(23_000);
	});
	it("does not let a model replace source numbers, indices or permission filters", async () => {
		const { left, right } = await setup();
		for (const input of [{ left, right, tenantId: "t2" }, { left: { ...left, originalValue: "999" }, right }, { left: { ...left, parameterIndex: -1 }, right }, { left: { ...left, parameterIndex: 16 }, right }, { left: { ...left, parameterIndex: .5 }, right }, { left, right, asOf: "now" }]) expect(() => assertComparisonInput(input)).toThrow();
	});
	it("rejects private references before returning either source and respects dates/regions", async () => {
		const { store, left, right } = await setup();
		for (const filtered of [{ region: "CN" }, { asOf: "2000-01-01T00:00:00.000Z" }]) expect(() => compareEvidence(store, scope, { left, right, ...filtered })).toThrow("evidence_unavailable");
		expect(() => compareEvidence(store, other, { left, right })).toThrow("evidence_unavailable");
		expect(store.audit(other)).toEqual([]);
		expect(() => compareEvidence(store, scope, { left, right: { ...right, parameterIndex: 15 } })).toThrow("parameter_unavailable");
	});
	it("allows explicitly public redistributable references under another valid scope", async () => {
		const { store } = await setup(), references = [];
		for (const m of coffeeKnowledgeFixtures().slice(0, 2)) { m.visibility = "public"; const doc = store.import(scope, m, "operator"); await store.process(scope, doc.versionId); references.push({ evidenceId: `${doc.versionId}:2`, parameterIndex: 0 }); }
		expect(compareEvidence(store, other, { left: references[0], right: references[1] }).status).toBe("comparable");
		expect(store.audit(other).filter((e) => e.type === "knowledge.parameters_read")).toHaveLength(1);
	});
	it("rechecks withdrawn sources and leaves previous audit evidence intact", async () => {
		const { store, left, right, docs } = await setup(); compareEvidence(store, scope, { left, right });
		store.transition(scope, docs[1].versionId, "withdrawn", "operator");
		expect(() => compareEvidence(store, scope, { left, right })).toThrow("evidence_unavailable");
		expect(store.audit(scope).filter((e) => e.type === "knowledge.parameters_read")).toHaveLength(1);
	});
	it("rechecks permission expiry even before purge runs", async () => {
		let now = "2026-09-17T10:00:00.000Z"; const { store, left } = await setup(() => now);
		const m = coffeeKnowledgeFixtures()[1]; m.revision = "expiring"; m.permission.expiresAt = "2026-09-18T00:00:00.000Z";
		const doc = store.import(scope, m, "operator"); await store.process(scope, doc.versionId);
		const right = { evidenceId: `${doc.versionId}:2`, parameterIndex: 0 }; compareEvidence(store, scope, { left, right }); now = "2026-09-19T00:00:00.000Z";
		expect(() => compareEvidence(store, scope, { left, right })).toThrow("evidence_unavailable");
	});
	it("keeps different authority states visible and does not call different samples a source conflict", async () => {
		const { store, left, right } = await setup(); const a = store.readEvidence(scope, left.evidenceId), b = store.readEvidence(scope, right.evidenceId);
		b.publisher = a.publisher; b.model = a.model; a.parameters[0].subject = "inner layer"; b.parameters[0].subject = "outer layer"; b.parameters[0].originalValue = "120";
		expect(coffeeEvidenceReview([a, b]).conflicts).toEqual([]);
		b.parameters[0].subject = a.parameters[0].subject; expect(coffeeEvidenceReview([a, b]).conflicts).toHaveLength(1);
		const m = coffeeKnowledgeFixtures()[1]; m.revision = "third-party"; m.blocks[1].parameters[0].authority = "third_party_test";
		const doc = store.import(scope, m, "operator"); await store.process(scope, doc.versionId);
		expect(compareEvidence(store, scope, { left, right: { evidenceId: `${doc.versionId}:2`, parameterIndex: 0 } }).warnings).toContain("authority_types_differ");
	});
	it("rejects self-comparison, checks cancellation, and exposes the typed read-only Tool", async () => {
		const { store, left, right } = await setup();
		expect(compareEvidence(store, scope, { left, right: left })).toMatchObject({ status: "needs_review", comparison: { reasons: ["same_parameter_reference"] } });
		const tool = createPackagingComparisonTool(store); expect(tool).toMatchObject({ risk: "read", idempotent: true, maxResultChars: 24_000 });
		const controller = new AbortController();
		const context: AgentToolExecutionContext = { ...scope, runId: "run", stageId: "stage", actorId: "operator", executionId: "tool-compare", toolCallId: "tool", idempotencyKey: "tool", signal: controller.signal };
		expect(await tool.execute({ left, right }, context)).toMatchObject({ status: "comparable", correlationId: "tool-compare" });
		controller.abort(); await expect(tool.execute({ left, right }, context)).rejects.toThrow();
	});
	it("runs the comparison API under the task boundary without confirming any business facts", async () => {
		const root = mkdtempSync(join(tmpdir(), "packx-compare-api-")), h = knowledgeWorkflow(root);
		cleanups.push(() => { h.store.close(); rmSync(root, { recursive: true, force: true }); });
		await h.api.handle(h.context, h.conversationId, "demo"); await h.scheduler.runNext(); await h.scheduler.runNext();
		const docs = h.store.list(h.context);
		const refs = docs.map((d) => ({ evidenceId: `${d.versionId}:2`, parameterIndex: 0 }));
		const result = await h.api.handle(h.context, h.conversationId, "compare", { left: refs[0], right: refs[1] });
		expect(result).toMatchObject({ status: 200, body: { status: "comparable", conclusionAllowed: false } });
		expect(h.store.selection({ ...h.context, runId: h.conversationId })).toBeUndefined();
		expect((await h.api.handle({ ...h.context, tenantId: "foreign" }, h.conversationId, "compare", { left: refs[0], right: refs[1] })).status).toBe(404);
	});
});
