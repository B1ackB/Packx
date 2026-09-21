import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KnowledgeImport } from "../../src/enterprise/knowledge";
import { packagingExpansionVersion, packagingSourceDirectory } from "../../src/manufacturing/packagingExpansion";
import { assertImport } from "../knowledge/validation";

export const packagingExpansionRoot = resolve("data/knowledge/packaging-expansion-2026-09-21");
export const packagingExpansionCheckedAt = "2026-09-21T00:00:00.000Z";
export const fdaPcrModel = "database:fda-pcr-nol";
const reviewAt = "2026-12-20T00:00:00.000Z";
export const fdaPcrBoundary = "Packx scope: US food-contact PCR process records; snapshot only, not current product/order approval. Check the named process, food type, contact conditions and original letter; recheck the current FDA database before use. No verified production Fact is extracted. 美国食品接触再生塑料工艺快照；原始限制不得省略，不构成当前订单批准。";
const headers = ["Recycle Number", "Date of NOL", "Company", "Polymer abbrev", "Polymer", "Recycling Process", "Use Limitations"];
export interface FdaPcrSnapshot { schemaVersion: string; updatedAt: string; downloadedAt: string; headers: string[]; records: Array<Record<string, string>> }

export function loadFdaPcrSnapshot(root = packagingExpansionRoot): FdaPcrSnapshot {
	const acquisition = JSON.parse(readFileSync(resolve(root, "acquisition.json"), "utf8")) as { files: Array<{ file: string; sha256: string }>; rows: number };
	const expectedFiles = ["fda-recycled-plastics.xls", "fda-recycled-plastics.json", "fda-reuse-policy.txt"];
	if (acquisition.rows !== 460 || JSON.stringify(acquisition.files.map((f) => f.file)) !== JSON.stringify(expectedFiles)) throw new Error("packaging_snapshot_manifest_mismatch");
	for (const file of acquisition.files) if (createHash("sha256").update(readFileSync(resolve(root, file.file))).digest("hex") !== file.sha256) throw new Error("packaging_snapshot_hash_mismatch");
	const snapshot = JSON.parse(readFileSync(resolve(root, "fda-recycled-plastics.json"), "utf8")) as FdaPcrSnapshot;
	if (snapshot.schemaVersion !== "packx-fda-pcr-snapshot.v1" || snapshot.updatedAt !== "2026-09-04" || snapshot.downloadedAt !== "2026-09-21" || JSON.stringify(snapshot.headers) !== JSON.stringify(headers) || snapshot.records.length !== 460) throw new Error("packaging_snapshot_structure_mismatch");
	const ids = new Set<string>();
	for (const record of snapshot.records) {
		if (Object.keys(record).length !== headers.length || headers.some((h) => typeof record[h] !== "string" || h !== "Polymer abbrev" && !record[h]) || !/^\d{4}-\d{2}-\d{2}$/.test(record["Date of NOL"]) || !/^[1-9]\d*$/.test(record["Recycle Number"]) || Number(record["Recycle Number"]) > 460 || ids.has(record["Recycle Number"])) throw new Error("packaging_snapshot_row_mismatch");
		ids.add(record["Recycle Number"]);
	}
	return snapshot;
}

export function packagingExpansionManifests(): KnowledgeImport[] {
	const manifests: KnowledgeImport[] = packagingSourceDirectory.map((p) => ({
		schemaVersion: "knowledge-import.v1", documentId: `packaging-source-${p.id}`, family: `packaging-source-${p.id}`, title: `${p.publisher} / ${p.name} / 资料入口`, publisher: p.publisher, model: `catalog:source-${p.id}`, revision: packagingExpansionVersion, sourceUrl: p.url, language: "zh", regions: ["unknown"], publishedAt: null, effectiveAt: null, expiresAt: reviewAt, provenance: "public_source", visibility: "public",
		permission: { basis: "Packx 原创事实性目录：只保存名称、官方入口、用途分类及自编核对问题。许可仅覆盖该目录，不授予供应商/认证机构/数据库原文保存、索引或再分发权。FDA 官方表格另以独立公共数据快照导入。", reference: p.url, checkedAt: packagingExpansionCheckedAt, expiresAt: null, storage: true, indexing: true, redistribution: true },
		parser: { name: "packx-product-directory", version: "1.0.0", status: "reviewed", reason: "Metadata checked against official pages; no vendor technical text or order parameters. One whole authored directory record per chunk; zero overlap. Review deadline is Packx maintenance policy." },
		blocks: [{ location: { section: p.section, paragraph: 1 }, text: `${p.publisher} / ${p.name}\n【Packx 资料目录，不是供应商原文】\n类型：${p.kind === "database" ? "行业数据库入口" : "供应商资料入口"}；核查日期：2026-09-21；源资料修订日期：未说明。\n可用于查找：${p.question}\n官方查询入口：${p.query}\n限制与待核对事项：${p.limit}\n状态：unverified；目录命中不构成事实确认。`, parameters: [] }],
	}));
	const snapshot = loadFdaPcrSnapshot();
	manifests.push({
		schemaVersion: "knowledge-import.v1", documentId: "fda-pcr-nol", family: "fda-pcr-nol", title: "FDA 食品接触 PCR 再生塑料工艺 / Recycled Plastics NOL", publisher: "U.S. Food and Drug Administration", model: fdaPcrModel, revision: "FDA-PCR.2026-09-04.downloaded-2026-09-21.v1", sourceUrl: "https://www.fda.gov/food/packaging-food-contact-substances-fcs/recycled-plastics-food-packaging", language: "en", regions: ["US"], publishedAt: "2026-09-04T00:00:00.000Z", effectiveAt: null, expiresAt: reviewAt, provenance: "public_source", visibility: "public",
		permission: { basis: "FDA website policy: contents are public domain unless otherwise noted. This official FDA table export has no separate copyright notice. Credit: U.S. Food and Drug Administration; no endorsement. Downloaded 2026-09-21; source updated 2026-09-04. Changes: decode CSV/HTML entities and lists, normalize dates, preserve complete rows. No vendor attachments/logos included.", reference: "https://www.fda.gov/about-fda/about-website/website-policies", checkedAt: packagingExpansionCheckedAt, expiresAt: null, storage: true, indexing: true, redistribution: true },
		parser: { name: "packx-fda-pcr-csv", version: "1.0.0", status: "reviewed", reason: "All 460 source rows and all 7 fields retained; original export and transformation have SHA-256 records. Whole row per chunk, zero overlap. Row text preserves long cells without the generic table-cell limit. No current legal/order applicability or expert review asserted." },
		blocks: snapshot.records.map((r, i) => ({ location: { section: `FDA Recycled Plastics / Recycle Number ${r["Recycle Number"]}`, anchor: `fda-pcr-${r["Recycle Number"]}`, table: "FDA Recycled Plastics export (2026-09-04)", row: i + 1 }, text: `${fdaPcrBoundary}\nSource: FDA; updated 2026-09-04; downloaded 2026-09-21.\n${headers.map((h) => `${h}: ${r[h] || "[not supplied in source]"}`).join("\n")}\nCurrent database: https://www.hfpappexternal.fda.gov/scripts/fdcc/index.cfm?set=RecycledPlastics`, parameters: [] })),
	});
	for (const manifest of manifests) assertImport(manifest);
	return manifests;
}
