import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { coffeeKnowledgeFixtures } from "../../src/manufacturing/knowledgeFixtures";
import { coffeeEvidenceReview, compareParameters, normalizeParameter, packagingTerms } from "../../src/manufacturing/packagingKnowledge";
import { KnowledgeStore } from "./store";
import { KnowledgeService } from "./service";
import { FakeEmbedding, LexicalEmbedding, LocalEmbedding, validateVector } from "./embedding";
import { downloadSnapshot, publicIPv4 } from "./download";
import { StageJobScheduler } from "../workers/stageJobScheduler";
import { KnowledgeError, type KnowledgeImport } from "../../src/enterprise/knowledge";

const scope = { tenantId: "t1", workspaceId: "w1" };
const other = { tenantId: "t2", workspaceId: "w2" };
const now = "2026-09-17T10:00:00.000Z";
const folders: string[] = [], stores: KnowledgeStore[] = [];
function setup(embedding = new LexicalEmbedding(packagingTerms), clock = () => now) {
	const root = mkdtempSync(join(tmpdir(), "packx-knowledge-")); folders.push(root);
	const store = new KnowledgeStore(root, embedding, (b) => ({ ...b, parameters: b.parameters.map(normalizeParameter) }), clock); stores.push(store);
	return { root, store };
}
afterEach(() => { vi.unstubAllGlobals(); for (const store of stores.splice(0)) store.close(); for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function indexed(store: KnowledgeStore, fixture = coffeeKnowledgeFixtures()[0], owner = scope) { const doc = store.import(owner, fixture, "operator"); await store.process(owner, doc.versionId); return doc; }

describe("governed knowledge ingestion and retrieval", () => {
	it("deduplicates canonical imports, preserves tables, and separates model identity", async () => {
		const { store } = setup(); const fixture = coffeeKnowledgeFixtures()[0];
		const doc = await indexed(store, fixture);
		expect(store.import(scope, Object.fromEntries(Object.entries(fixture).reverse()), "operator").versionId).toBe(doc.versionId);
		expect(() => store.import(scope, { ...fixture, model: "another-model" }, "operator")).toThrow("document_identity_conflict");
		const result = await store.search(scope, { query: "厚度", mode: "hybrid" });
		expect(result.hits[0]).toMatchObject({ location: { page: 2, table: "T1" }, table: { footnotes: fixture.blocks[1].table!.footnotes } });
		expect(result.hits[0].parameters[0]).toMatchObject({ originalValue: "0.1", originalUnit: "mm", normalized: { value: 100, unit: "µm" } });
		expect(result.usage.generationCalls).toBe(0);
	});
	it.each(["keyword", "vector", "hybrid"] as const)("enforces scope before %s ranking and citation reads", async (mode) => {
		const { store } = setup(); const doc = await indexed(store);
		expect((await store.search(other, { query: "DEMO-PE-A", mode })).hits).toHaveLength(0);
		expect(() => store.readEvidence(other, `${doc.versionId}:1`)).toThrow("evidence_unavailable");
		expect(store.list({ ...scope, workspaceId: "w-other" })).toEqual([]);
	});
	it("allows explicitly public redistributable data, but only its owner can revoke it", async () => {
		const { store } = setup(); const fixture = coffeeKnowledgeFixtures()[0]; fixture.visibility = "public";
		const doc = await indexed(store, fixture);
		expect((await store.search(other, { query: fixture.model, mode: "keyword" })).hits).toHaveLength(2);
		expect(() => store.transition(other, doc.versionId, "withdrawn", "operator")).toThrow("knowledge_access_denied");
		store.transition(scope, doc.versionId, "withdrawn", "operator");
		expect((await store.search(other, { query: fixture.model, mode: "hybrid" })).hits).toHaveLength(0);
	});
	it("rejects permissions, credentials and fabricated extraction before storage", () => {
		const { store } = setup(); const fixture = coffeeKnowledgeFixtures()[0];
		expect(() => store.import(scope, { ...fixture, permission: { ...fixture.permission, indexing: false } }, "operator")).toThrow("permission_not_granted");
		expect(() => store.import(scope, { ...fixture, title: "Bearer abcdefghijklmnopqrstuvwxyz" }, "operator")).toThrow("secret_material_rejected");
		fixture.blocks[0].parameters[0].originalValue = "invented structure";
		expect(() => store.import(scope, fixture, "operator")).toThrow("parameter_not_in_source");
		expect(store.list(scope)).toEqual([]);
	});
	it.each(["needs_ocr", "needs_review", "failed"] as const)("keeps %s outside the index", async (status) => {
		const { store } = setup(); const fixture = coffeeKnowledgeFixtures()[0]; fixture.parser.status = status;
		const doc = await indexed(store, fixture);
		expect(store.get(scope, doc.versionId)?.status).toBe("needs_review");
		expect((await store.search(scope, { query: fixture.model, mode: "keyword" })).hits).toEqual([]);
	});
	it("filters expiry, future applicability, region and exact model without auto choosing latest", async () => {
		const { store } = setup(); const first = coffeeKnowledgeFixtures()[0];
		await indexed(store, first); await indexed(store, { ...first, revision: "v2", effectiveAt: "2027-01-01T00:00:00.000Z" });
		await indexed(store, { ...first, revision: "old", expiresAt: "2026-09-16T00:00:00.000Z" });
		store.purgeExpired(scope);
		expect(store.list(scope).find((d) => d.manifest.revision === "v2")?.status).toBe("indexed");
		const found = await store.search(scope, { query: first.model, mode: "keyword", region: "HK", asOf: now });
		expect(new Set(found.hits.map((h) => h.revision))).toEqual(new Set(["fixture-v1"]));
		expect((await store.search(scope, { query: first.model, mode: "keyword", model: "DEMO-PE", region: "HK" })).hits).toHaveLength(0);
		expect((await store.search(scope, { query: first.model, mode: "vector", region: "CN" })).hits).toHaveLength(0);
	});
	it("checks authorization again after an asynchronous embedding", async () => {
		const embedder = new LexicalEmbedding(packagingTerms); const { store } = setup(embedder); const doc = await indexed(store);
		const original = embedder.embed.bind(embedder);
		embedder.embed = async (texts) => { store.transition(scope, doc.versionId, "withdrawn", "operator"); return original(texts); };
		expect((await store.search(scope, { query: "coffee", mode: "vector" })).hits).toEqual([]);
	});
	it("resumes from parsed checkpoint, retries via existing queue, then rebuilds without duplicates", async () => {
		const { store } = setup(); const queue = new InMemoryStageJobQueue(); const service = new KnowledgeService(store, queue);
		const doc = store.import(scope, coffeeKnowledgeFixtures()[0], "operator");
		service.reconcile(scope); service.reconcile(scope); expect(queue.list()).toHaveLength(1);
		let calls = 0;
		await expect(store.process(scope, doc.versionId, undefined, () => { if (++calls === 2) throw new Error("simulated_crash"); })).rejects.toThrow("simulated_crash");
		expect(store.get(scope, doc.versionId)?.status).toBe("parsed");
		const scheduler = new StageJobScheduler(queue, { workerId: "test", handlers: { "knowledge-import": (lease, signal, guard) => service.execute(lease, signal, guard) } });
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
		store.rebuild(scope); service.reconcile(scope); expect(queue.list()).toHaveLength(2);
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
		expect((await store.search(scope, { query: "DEMO-PE-A", mode: "keyword" })).hits).toHaveLength(2);
	});
	it("recovers expired worker leases and cancellation prevents publication", async () => {
		let time = new Date(now); const { store } = setup(); const queue = new InMemoryStageJobQueue({ now: () => time }); const service = new KnowledgeService(store, queue);
		const doc = store.import(scope, coffeeKnowledgeFixtures()[0], "operator"); service.reconcile(scope);
		queue.claim("crashed-worker", 100); time = new Date(time.getTime() + 200);
		const lease = queue.claim("recovered-worker", 100)!; expect(lease.recoveryCount).toBe(1);
		await service.execute(lease, new AbortController().signal, () => {}); queue.ack(lease);
		const cancelled = store.import(scope, coffeeKnowledgeFixtures()[1], "operator"); store.transition(scope, cancelled.versionId, "cancelled", "operator");
		await store.process(scope, cancelled.versionId); expect(store.get(scope, cancelled.versionId)?.status).toBe("cancelled");
		expect(store.get(scope, doc.versionId)?.status).toBe("indexed");
	});
	it("persists retry exhaustion and permits an explicit operator redrive", async () => {
		let time = new Date(now); const embedding = new LexicalEmbedding(packagingTerms); const original = embedding.embed.bind(embedding);
		const { store } = setup(embedding); const queue = new InMemoryStageJobQueue({ now: () => time }); const service = new KnowledgeService(store, queue);
		const doc = store.import(scope, coffeeKnowledgeFixtures()[0], "operator"); service.reconcile(scope);
		embedding.embed = async () => { throw new KnowledgeError("local_model_unavailable", 503); };
		const scheduler = new StageJobScheduler(queue, { workerId: "test", handlers: { "knowledge-import": (lease, signal, guard) => service.execute(lease, signal, guard) } });
		for (const status of ["retry_scheduled", "retry_scheduled", "dead_letter"]) {
			expect(await scheduler.runNext()).toMatchObject({ status }); time = new Date(time.getTime() + 60_000);
		}
		expect(service.jobs(scope)[0]).toMatchObject({ status: "dead_letter", failureCount: 3, lastFailure: { message: "local_model_unavailable", retryable: true } });
		expect((await store.search(scope, { query: "DEMO-PE-A", mode: "keyword" })).hits).toHaveLength(0);
		embedding.embed = original; service.retry(scope, doc.versionId, "operator");
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
		expect(store.get(scope, doc.versionId)?.status).toBe("indexed");
	});
	it("does not publish vectors if the permission expires during embedding", async () => {
		let time = now; const embedding = new LexicalEmbedding(packagingTerms); const original = embedding.embed.bind(embedding);
		const { store } = setup(embedding, () => time); const fixture = coffeeKnowledgeFixtures()[0]; fixture.permission.expiresAt = "2026-09-18T00:00:00.000Z";
		embedding.embed = async (texts) => { time = "2026-09-19T00:00:00.000Z"; return original(texts); };
		const doc = await indexed(store, fixture);
		expect(store.get(scope, doc.versionId)).toMatchObject({ status: "needs_review", failure: "permission_expired" });
		expect((await store.search(scope, { query: fixture.model, mode: "keyword" })).hits).toHaveLength(0);
	});
	it("uses versioned selection CAS and rejects invalid evidence after restart", async () => {
		const { store, root } = setup(); const doc = await indexed(store); const task = { ...scope, runId: "conversation" };
		const selection = store.select(task, [`${doc.versionId}:2`], { region: "HK", asOf: now }, "operator", "select-one", 0);
		expect(store.select(task, selection.ids, selection.applicability, "operator", "select-one", 0)).toEqual(selection);
		expect(() => store.select(task, [], selection.applicability, "operator", "select-two", 0)).toThrow("selection_version_conflict");
		const restored = new KnowledgeStore(root, new LexicalEmbedding(packagingTerms)); stores.push(restored);
		expect(restored.selected(task).hits).toHaveLength(1);
		store.transition(scope, doc.versionId, "withdrawn", "operator");
		expect(restored.selected(task).unavailable).toEqual(selection.ids);
		expect(() => restored.assertSelection(scope, JSON.stringify(selection))).toThrow("evidence_unavailable");
	});
	it("refuses mixed embedding spaces and bad vectors", async () => {
		const { store, root } = setup(); await indexed(store);
		const alternate = new KnowledgeStore(root, new FakeEmbedding()); stores.push(alternate);
		expect((await alternate.search(scope, { query: "coffee", mode: "hybrid" })).status).toBe("unavailable");
		expect(() => validateVector([NaN], 1)).toThrow("embedding_space_mismatch");
		expect(() => validateVector([0, 0], 2)).toThrow("embedding_zero_vector");
		expect(() => new LocalEmbedding({ url: "https://paid.example/", model: "bge-m3", digest: "latest", dimensions: 1024, license: "MIT" })).toThrow();
	});
	it("preserves conflicting revisions and refuses mismatched barrier test conditions", async () => {
		const { store } = setup(); const fixtures = coffeeKnowledgeFixtures();
		for (const fixture of fixtures.slice(0, 2)) await indexed(store, fixture);
		const result = await store.search(scope, { query: "thickness OTR", mode: "keyword" });
		const review = coffeeEvidenceReview(result.hits);
		expect(review.comparisons.find((c) => c.parameter === "thickness")).toMatchObject({ comparable: true, difference: 0 });
		expect(review.comparisons.find((c) => c.parameter === "OTR")).toMatchObject({ comparable: false, reasons: ["test_conditions_mismatch_or_missing", "structured_test_conditions_missing"] });
		const p = fixtures[0].blocks[1].parameters[0]; expect(normalizeParameter({ ...p, originalValue: "<0.1" }).normalized).toBeUndefined();
		expect(compareParameters({ ...p, conditions: "" }, { ...p, conditions: "" }).comparable).toBe(false);
		expect(review.questions.some((q) => q.includes("WVTR"))).toBe(true);
	});
	it("rejects malicious query scope and unsafe download targets without a request", async () => {
		const { store } = setup();
		await expect(store.search(scope, { query: "x", mode: "keyword", tenantId: "t2" })).rejects.toThrow("invalid_knowledge_query");
		for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1", "100.64.0.1", "::1", "::ffff:127.0.0.1"]) expect(publicIPv4(ip)).toBe(false);
		for (const url of ["http://127.0.0.1", "https://169.254.169.254/", "https://example.com/"]) await expect(downloadSnapshot(url, [])).rejects.toThrow("download_not_authorized");
	});
	it("validates the local model protocol and records actual reported usage without downloading", async () => {
		const checksum = "a".repeat(64); const calls: string[] = [];
		vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
			calls.push(url.pathname);
			if (url.pathname === "/api/tags") return new Response(JSON.stringify({ models: [{ name: "approved:tag", digest: checksum }] }));
			expect(JSON.parse(String(init?.body))).toMatchObject({ model: "approved:tag", truncate: false });
			return new Response(JSON.stringify({ model: "approved:tag", embeddings: [[3, 4]], prompt_eval_count: 7, total_duration: 2_000_000 }));
		});
		const local = new LocalEmbedding({ url: "http://127.0.0.1:11434/", model: "approved:tag", digest: `sha256:${checksum}`, dimensions: 2, license: "test-contract-only" });
		expect(await local.embed(["fixture"])).toEqual({ vectors: [[.6, .8]], usage: { inputTokens: 7, modelDurationMs: 2 } });
		expect(calls).toEqual(["/api/tags", "/api/embed", "/api/tags"]);
	});
	it("keeps conflicting revisions visible and reports numerical disagreement", async () => {
		const { store } = setup(); const old = coffeeKnowledgeFixtures()[0]; const next = structuredClone(old);
		next.revision = "v2"; next.blocks[1].parameters[0].originalValue = "0.2"; next.blocks[1].table!.rows[0][1] = "0.2";
		await indexed(store, old); await indexed(store, next);
		const result = await store.search(scope, { query: "thickness", mode: "keyword", model: old.model });
		expect(new Set(result.hits.map((h) => h.revision))).toEqual(new Set(["fixture-v1", "v2"]));
		expect(coffeeEvidenceReview(result.hits).conflicts).toHaveLength(1);
	});
	it("invalid grant expiry purges vectors and direct evidence access", async () => {
		let clock = now; const { store } = setup(undefined, () => clock); const fixture: KnowledgeImport = coffeeKnowledgeFixtures()[0]; fixture.permission.expiresAt = "2026-09-18T00:00:00.000Z";
		const doc = await indexed(store, fixture); clock = "2026-09-19T00:00:00.000Z"; store.purgeExpired(scope);
		expect(store.get(scope, doc.versionId)?.status).toBe("withdrawn"); expect(() => store.readEvidence(scope, `${doc.versionId}:1`)).toThrow();
	});
});
