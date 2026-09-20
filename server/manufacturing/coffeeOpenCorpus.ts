import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvidenceBlock, EvidenceParameter, KnowledgeImport } from "../../src/enterprise/knowledge";
import { parseJats } from "../knowledge/jats";
import { assertImport } from "../knowledge/validation";

export const corpusRoot = resolve("data/knowledge/coffee-open-v1");
export const corpusAt = "2026-09-17T00:00:00.000Z";
export const familyFor = (id: string) => ["PMC11243642", "PMC10931445"].includes(id) ? "calabrese-coffee-films" : id;
export const splitFor = (id: string) => ["PMC11243642", "PMC10931445", "PMC10670670"].includes(id) ? "development" as const : "frozen" as const;
const param = (name: string, subject: string, originalValue: string, originalUnit: string): EvidenceParameter => ({ name, subject, originalValue, originalUnit, method: "", conditions: "", scope: "Research sample only; not a supplier specification or current-order approval", verification: "unverified", authority: "research_report" });
function annotate(id: string, blocks: EvidenceBlock[]) {
	// Source-bound transcriptions, not a universal extraction model. Missing tests stay empty.
	if (id === "PMC11243642") {
		for (const b of blocks.filter((b) => b.location.anchor === "sec3dot2-molecules-29-03006")) b.location.page = 13;
		blocks[35].parameters = [param("OTR", "STD", "<1.0", ""), param("grammage", "STD", "99", "g/m2"), param("thickness", "STD/PET", "12", "microns"), param("thickness", "STD/aluminium", "8", "microns"), param("thickness", "STD/PE", "60", "microns")];
		blocks[36].parameters = [param("OTR", "REC", "<0.5", ""), param("grammage", "REC", "81", "g/m2"), param("thickness", "REC/OPPHP", "15", "microns"), param("thickness", "REC/OPPHB", "16", "microns"), param("thickness", "REC/CPP/B", "50", "microns")];
	}
	if (id === "PMC10931445") {
		blocks[16].parameters = [param("OTR", "STD", "<1.0", ""), param("grammage", "STD", "99", "g/m2")];
		blocks[17].parameters = [param("OTR", "ALT", "<1.5", ""), param("grammage", "ALT", "90", "g/m2"), param("thickness", "ALT/PE", "55", "microns")];
	}
	if (id === "PMC9563479") for (const b of blocks.filter((b) => b.location.table === "Table 1")) {
		const r = b.table!.rows[0]; b.parameters = [param("air_permeability", r[0], r[1], "L/m2 s"), param("thickness", r[0], r[2], "mm")];
	}
	if (id === "PMC10670670") blocks[63].parameters = [param("thickness", "PLA/SCG experimental films", "40 and 50", "μm")];
	if (id === "PMC11944891") for (const b of blocks.filter((b) => b.location.table === "Table 3")) {
		b.location.page = 9; const r = b.table!.rows[0]; b.parameters = [param("OTR_as_labelled", r[0], r[3], "cm3 mm/(m2·d·0.1 MPa)"), param("WVTR", r[0], r[1], "g/m2·d"), param("WVP", r[0], r[2], "(10−7) (g/m·d·Pa)")];
	}
}
export function loadCoffeeCorpus(): KnowledgeImport[] {
	const acquisition = JSON.parse(readFileSync(resolve(corpusRoot, "acquisition.json"), "utf8")) as { records: { id: string; revision: string; status: string; license: string; citation: string; metadataSha256: string; files?: { file: string; sha256: string }[] }[] };
	return acquisition.records.filter((r) => r.status === "downloaded").map((r) => {
		if (r.license !== "CC BY") throw new Error("corpus_license_denied");
		if (createHash("sha256").update(readFileSync(resolve(corpusRoot, r.revision, "metadata.json"))).digest("hex") !== r.metadataSha256) throw new Error("corpus_metadata_changed_review_required");
		for (const f of r.files ?? []) if (createHash("sha256").update(readFileSync(resolve(corpusRoot, f.file))).digest("hex") !== f.sha256) throw new Error("corpus_snapshot_changed");
		const parsed = parseJats(readFileSync(resolve(corpusRoot, r.revision, `${r.revision}.xml`), "utf8")); annotate(r.id, parsed.blocks);
		const manifest: KnowledgeImport = { schemaVersion: "knowledge-import.v1", documentId: r.id, family: familyFor(r.id), title: parsed.title, publisher: `${parsed.authors.split(", ")[0]} et al.; MDPI`, model: `study:${r.id}`, revision: r.revision, sourceUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${r.id}/`, language: "en", regions: ["unknown"], publishedAt: parsed.publishedAt, effectiveAt: null, expiresAt: null, provenance: "public_source", visibility: "public", permission: { basis: `${parsed.authors}. ${r.citation}. CC BY 4.0 https://creativecommons.org/licenses/by/4.0/. Source: PMC/NLM (no endorsement). Changes: structured extraction, segmentation and unverified parameter transcription. Snapshot dated 2026-09-17; not claimed current.`, reference: `https://pmc-oa-opendata.s3.amazonaws.com/${r.revision}/${r.revision}.xml`, checkedAt: corpusAt, expiresAt: null, storage: true, indexing: true, redistribution: true }, parser: { name: "packx-jats", version: "1.0.0", status: "reviewed", reason: "Parser structure checked against JATS and selected PDF pages; no human industrial review. Body/abstract/table text indexed; figures, supplements and bibliography excluded. Unknown order applicability." }, blocks: parsed.blocks };
		assertImport(manifest); return manifest;
	});
}
