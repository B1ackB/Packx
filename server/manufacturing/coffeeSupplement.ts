import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KnowledgeImport } from "../../src/enterprise/knowledge";
import { parseJats } from "../knowledge/jats";
import { assertImport } from "../knowledge/validation";

/** Separate edition: never changes the original five-paper corpus or its evaluation labels. */
export function loadCoffeeSupplement(): KnowledgeImport[] {
	const root = resolve("data/knowledge/coffee-open-v2");
	const acquisition = JSON.parse(readFileSync(resolve(root, "acquisition.json"), "utf8")) as { records: Array<{ id: string; revision: string; status: string; license: string; checkedAt: string; citation: string; metadataSha256: string; files: Array<{ file: string; sha256: string }> }> };
	return acquisition.records.filter((r) => r.status === "downloaded").map((r) => {
		if (!["PMC12607991", "PMC12111376"].includes(r.id) || r.revision !== `${r.id}.1` || r.license !== "CC BY") throw new Error("supplement_identity_or_license_denied");
		const check = (path: string, hash: string) => { if (createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex") !== hash) throw new Error("supplement_snapshot_changed"); };
		check(`${r.revision}/metadata.json`, r.metadataSha256);
		for (const f of r.files) {
			if (![`${r.revision}/${r.revision}.xml`, `${r.revision}/${r.revision}.pdf`].includes(f.file)) throw new Error("supplement_file_rejected");
			check(f.file, f.sha256);
		}
		const metadata = JSON.parse(readFileSync(resolve(root, r.revision, "metadata.json"), "utf8"));
		if (metadata.license_code !== "CC BY" || metadata.is_retracted !== false || metadata.is_manuscript !== false || metadata.is_pmc_openaccess !== true) throw new Error("supplement_permission_changed");
		const p = parseJats(readFileSync(resolve(root, r.revision, `${r.revision}.xml`), "utf8"));
		const manifest: KnowledgeImport = { schemaVersion: "knowledge-import.v1", documentId: r.id, family: r.id === "PMC12607991" ? "fernandez-coffee-polyphenols" : "instant-coffee-humidity", title: p.title, publisher: `${p.authors.split(", ")[0]} et al.; MDPI`, model: `study:${r.id}`, revision: r.revision, sourceUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${r.id}/`, language: "en", regions: ["unknown"], publishedAt: p.publishedAt, effectiveAt: null, expiresAt: null, provenance: "public_source", visibility: "public",
			permission: { basis: `${p.authors}. ${r.citation}. CC BY 4.0 https://creativecommons.org/licenses/by/4.0/. Source: PMC/NLM (no endorsement). Changes: structural extraction and segmentation. No human industrial review. ${r.id === "PMC12111376" ? "Instant coffee was removed from packaging: not a sealed-bag shelf-life test." : "Experimental packages only; unusual source units and modelled half-life must not become order specifications."}`, reference: `https://pmc-oa-opendata.s3.amazonaws.com/${r.revision}/${r.revision}.xml`, checkedAt: r.checkedAt, expiresAt: null, storage: true, indexing: true, redistribution: true },
			parser: { name: "packx-jats", version: "1.0.0", status: "reviewed", reason: "JATS structure and targeted passages checked; no expert verification. Body/abstract/table rows only; figures, bibliography and supplements excluded. Original PDF retained; page numbers not inferred." }, blocks: p.blocks };
		assertImport(manifest); return manifest;
	});
}
