import type { KnowledgeImport } from "../enterprise/knowledge";

/** Authored synthetic test material. These are NOT supplier products or production specifications. */
export function coffeeKnowledgeFixtures(): KnowledgeImport[] {
	return ["DEMO-PE-A", "DEMO-PET-B", "HOLDOUT-PAPER-C", "HOLDOUT-PE-D"].map((model, index) => ({
		schemaVersion: "knowledge-import.v1", documentId: model.toLowerCase(), family: index < 2 ? `development-${index}` : `holdout-${index}`,
		title: `合成测试资料 Synthetic coffee pouch ${model}`, publisher: "Packx synthetic fixtures", model, revision: "fixture-v1",
		sourceUrl: `synthetic://coffee/${model.toLowerCase()}`, language: "zh-en", regions: ["HK"],
		publishedAt: "2026-09-01T00:00:00.000Z", effectiveAt: "2026-09-01T00:00:00.000Z", expiresAt: null,
		provenance: "synthetic", visibility: "workspace",
		permission: { basis: "Packx authored synthetic regression material", reference: "repository:src/manufacturing/knowledgeFixtures.ts", checkedAt: "2026-09-17T00:00:00.000Z", expiresAt: null, storage: true, indexing: true, redistribution: true },
		parser: { name: "reviewed-structured-manifest", version: "1.0.0", status: "reviewed", reason: "Synthetic fixture; no real product or human review claim" },
		blocks: [{
			location: { page: 1, section: "材料结构 Structure" }, text: `${model} coffee pouch 咖啡包装袋。结构 ${index % 2 ? "PET/PE" : "PE/PE"}；仅为软件测试，不能采购或生产。`,
			parameters: [{ name: "structure", originalValue: index % 2 ? "PET/PE" : "PE/PE", originalUnit: "", method: "fixture declaration", conditions: "synthetic", scope: "flat film", verification: "unverified", authority: "supplier_claim" }],
		}, {
			location: { page: 2, section: "参数 Parameters", table: "T1" }, text: "厚度 thickness 与氧气阻隔 OTR。测试条件不同不得比较。",
			table: { headers: ["Parameter", "Value", "Unit", "Method", "Conditions"], units: ["", "", "", "", ""], rows: [["thickness", index % 2 ? "100" : "0.1", index % 2 ? "µm" : "mm", "fixture-thickness", "23 C"], ["OTR", String(index + 1), "cm3/(m2 day)", "fixture-OTR", index % 2 ? "38 C; 90% RH" : "23 C; 0% RH"]], footnotes: ["合成数字；整膜测试；不构成真实标准或测试报告。"], conditions: "See each row; flat film" },
			parameters: [
				{ name: "thickness", originalValue: index % 2 ? "100" : "0.1", originalUnit: index % 2 ? "µm" : "mm", method: "fixture-thickness", conditions: "23 C", scope: "flat film", verification: "unverified", authority: "supplier_claim" },
				{ name: "OTR", originalValue: String(index + 1), originalUnit: "cm3/(m2 day)", method: "fixture-OTR", conditions: index % 2 ? "38 C; 90% RH" : "23 C; 0% RH", scope: "flat film", verification: "unverified", authority: "supplier_claim" },
			],
		}],
	}));
}
