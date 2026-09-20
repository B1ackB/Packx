import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { KnowledgeStore } from "../knowledge/store";
import { FakeEmbedding } from "../knowledge/embedding";
import { coffeeProductManifests, findCoffeeProducts } from "./coffeeProductDirectory";
import { coffeeProductDirectory } from "../../src/manufacturing/coffeeProducts";
import { loadCoffeeCorpus } from "./coffeeOpenCorpus";

it("product discovery returns source-bound metadata and gaps, not papers or invented specifications", async () => {
	const root = mkdtempSync(join(tmpdir(), "packx-catalog-")), scope = { tenantId: "t", workspaceId: "w" };
	const store = new KnowledgeStore(root, new FakeEmbedding(), undefined, () => "2026-09-18T12:00:00.000Z");
	try {
		for (const manifest of [...coffeeProductManifests(), loadCoffeeCorpus()[0]]) { const doc = store.import(scope, manifest, "operator"); await store.process(scope, doc.versionId); }
		for (const product of coffeeProductDirectory) {
			const response = await findCoffeeProducts(store, scope, { query: product.product });
			expect(response.result.hits[0].model).toBe(`catalog:${product.id}`); expect(response.result.hits[0].sourceUrl).toBe(product.sourceUrl);
			expect(response.result.hits.every((h) => h.model.startsWith("catalog:") && h.parameters.length === 0)).toBe(true);
			expect(response.questions.map((q) => q.field)).toContain("barrier"); expect(response.conclusionAllowed).toBe(false);
		}
		const candidates = await findCoffeeProducts(store, scope, { query: "500克咖啡豆袋需要选什么材料", coffeeForm: "roasted_beans" });
		expect(candidates.result.hits).toHaveLength(3); expect(candidates.result.hits.some((h) => h.model.includes("amfiber"))).toBe(false);
		expect((await findCoffeeProducts(store, scope, { query: "AmFiber", coffeeForm: "roasted_beans" })).result.hits).toHaveLength(0);
		expect((await findCoffeeProducts(store, scope, { query: "不存在的型号ZX999" })).result.hits).toHaveLength(0);
		const selected = candidates.result.hits[0];
		store.select({ ...scope, runId: "order" }, [selected.evidenceId], { region: "unknown", asOf: "2026-09-18T12:00:00.000Z" }, "operator", "select-directory", 0);
		expect(store.selected({ ...scope, runId: "order" }).hits[0].parameters).toEqual([]);
		store.transition(scope, selected.versionId, "withdrawn", "operator");
		expect(store.selected({ ...scope, runId: "order" }).unavailable).toContain(selected.evidenceId);
		expect((await findCoffeeProducts(store, scope, { query: selected.model.split(":")[1] })).result.hits.some((h) => h.evidenceId === selected.evidenceId)).toBe(false);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
it("product directory respects private scope, expiry and invalid input", async () => {
	const root = mkdtempSync(join(tmpdir(), "packx-catalog-")), scope = { tenantId: "t", workspaceId: "w" }; let now = "2026-09-18T12:00:00.000Z";
	const store = new KnowledgeStore(root, new FakeEmbedding(), undefined, () => now);
	try {
		const manifest = coffeeProductManifests()[0]; manifest.visibility = "workspace";
		const doc = store.import(scope, manifest, "operator"); await store.process(scope, doc.versionId);
		expect((await findCoffeeProducts(store, { tenantId: "other", workspaceId: "w" }, { query: "EcoLamHighPlus" })).result.hits).toEqual([]);
		now = "2027-01-01T00:00:00.000Z"; expect((await findCoffeeProducts(store, scope, { query: "EcoLamHighPlus" })).result.hits).toEqual([]);
		await expect(findCoffeeProducts(store, scope, { query: "coffee", coffeeForm: "invented" })).rejects.toThrow("invalid_product_query");
		await expect(findCoffeeProducts(store, scope, { query: "coffee", tenantId: "other" })).rejects.toThrow("invalid_product_query");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
