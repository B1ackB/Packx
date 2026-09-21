import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FakeEmbedding } from "../knowledge/embedding";
import { KnowledgeStore } from "../knowledge/store";
import { coffeeProductManifests } from "./coffeeProductDirectory";
import { fdaPcrBoundary, fdaPcrModel, loadFdaPcrSnapshot, packagingExpansionCheckedAt, packagingExpansionManifests, packagingExpansionRoot } from "./packagingExpansion";

const roots: string[] = [], stores: KnowledgeStore[] = [];
const scope = { tenantId: "t", workspaceId: "w" };
function temporary() { const root = mkdtempSync(join(tmpdir(), "packx-expansion-")); roots.push(root); return root; }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("preserves every complete FDA row, source order, limits and empty fields without inventing Fact parameters", () => {
	const snapshot = loadFdaPcrSnapshot(), manifests = packagingExpansionManifests(), fda = manifests.find((m) => m.model === fdaPcrModel)!;
	expect(manifests).toHaveLength(11); expect(manifests.reduce((n, m) => n + m.blocks.length, 0)).toBe(470);
	expect(fda.blocks).toHaveLength(460); expect(fda.regions).toEqual(["US"]);
	for (const [i, record] of snapshot.records.entries()) {
		const block = fda.blocks[i]; expect(block.location).toMatchObject({ row: i + 1, anchor: `fda-pcr-${record["Recycle Number"]}` });
		for (const header of snapshot.headers) expect(block.text).toContain(`${header}: ${record[header] || "[not supplied in source]"}`);
		expect(block.parameters).toEqual([]); expect(block.text).toContain(fdaPcrBoundary); expect(block.text.length).toBeLessThanOrEqual(4000);
	}
	// Source row 286 is record 282: don't conflate an identifier with physical table location.
	expect(fda.blocks[285].location).toMatchObject({ row: 286, anchor: "fda-pcr-282" });
	expect(fda.blocks.find((b) => b.location.anchor === "fda-pcr-11")?.text).toContain("(< 2 weeks)");
	const limited = fda.blocks.find((b) => b.location.anchor === "fda-pcr-456")!.text;
	expect(limited).toContain("up to 50%"); expect(limited).toContain("C through E"); expect(limited).toContain("up to 100%"); expect(limited).toContain("F through G");
	expect(fda.blocks.find((b) => b.location.anchor === "fda-pcr-460")?.text).toContain("separated from food by an effective barrier");
	expect(coffeeProductManifests()).toHaveLength(6); expect(coffeeProductManifests().every((m) => m.revision === "coffee-products.2026-09-18.v1")).toBe(true);
});

it("refuses changed raw exports and derived rows before importing", () => {
	for (const file of ["fda-recycled-plastics.xls", "fda-recycled-plastics.json", "fda-reuse-policy.txt"]) {
		const root = temporary(); cpSync(packagingExpansionRoot, root, { recursive: true });
		writeFileSync(join(root, file), readFileSync(join(root, file), "utf8") + "changed");
		expect(() => loadFdaPcrSnapshot(root)).toThrow("packaging_snapshot_hash_mismatch");
	}
});

it("reuses immutable import, selection and restart reads, then blocks withdrawn or out-of-region evidence", async () => {
	const root = temporary(), store = new KnowledgeStore(root, new FakeEmbedding(), undefined, () => packagingExpansionCheckedAt); stores.push(store);
	const manifest = packagingExpansionManifests().find((m) => m.model === fdaPcrModel)!;
	const doc = store.import(scope, manifest, "operator"); await store.process(scope, doc.versionId);
	expect(store.import(scope, manifest, "operator").versionId).toBe(doc.versionId);
	const ordinal = manifest.blocks.findIndex((b) => b.location.anchor === "fda-pcr-456");
	const id = `${doc.versionId}:${ordinal + 1}`, task = { ...scope, runId: "run" };
	expect(store.readEvidence(scope, id).text).toBe(manifest.blocks[ordinal].text);
	expect(() => store.readEvidence(scope, id, { region: "HK" })).toThrow("evidence_unavailable");
	store.select(task, [id], { region: "US", asOf: packagingExpansionCheckedAt }, "operator", "select", 0);
	const restarted = new KnowledgeStore(root, new FakeEmbedding(), undefined, () => packagingExpansionCheckedAt); stores.push(restarted);
	expect(restarted.selected(task).hits[0].text).toBe(manifest.blocks[ordinal].text);
	expect(restarted.selected({ ...task, runId: "other" }).hits).toEqual([]);
	// The source is explicitly public; its task selection and governance remain scoped.
	expect(restarted.readEvidence({ tenantId: "other", workspaceId: "else" }, id).evidenceId).toBe(id);
	expect(() => restarted.transition({ tenantId: "other", workspaceId: "else" }, doc.versionId, "withdrawn", "other")).toThrow("knowledge_access_denied");
	store.transition(scope, doc.versionId, "withdrawn", "operator");
	expect(restarted.selected(task).unavailable).toEqual([id]); expect(() => restarted.readEvidence(scope, id)).toThrow("evidence_unavailable");
});

it("keeps private copies isolated, enforces directory review expiry and denies missing indexing permission", async () => {
	let now = packagingExpansionCheckedAt;
	const store = new KnowledgeStore(temporary(), new FakeEmbedding(), undefined, () => now); stores.push(store);
	const source = packagingExpansionManifests()[0]; source.visibility = "workspace";
	const doc = store.import(scope, source, "operator"); await store.process(scope, doc.versionId);
	expect(store.readEvidence(scope, `${doc.versionId}:1`).text).toContain("不是供应商原文");
	expect(() => store.readEvidence({ ...scope, workspaceId: "other" }, `${doc.versionId}:1`)).toThrow("evidence_unavailable");
	expect(() => store.readEvidence({ ...scope, tenantId: "other" }, `${doc.versionId}:1`)).toThrow("evidence_unavailable");
	expect(() => store.import(scope, { ...source, permission: { ...source.permission, indexing: false } }, "operator")).toThrow("permission_not_granted");
	now = "2026-12-21T00:00:00.000Z"; expect(() => store.readEvidence(scope, `${doc.versionId}:1`)).toThrow("evidence_unavailable");
});
