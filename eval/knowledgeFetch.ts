import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

// Curated research articles, not supplier TDS. A rejected license never enters the corpus.
const supplement = process.argv.includes("--supplement");
const articles = supplement ? ["PMC12607991", "PMC12111376"] : ["PMC11243642", "PMC10931445", "PMC9563479", "PMC11031754", "PMC10670670", "PMC11944891"];
const root = join(process.cwd(), supplement ? "data/knowledge/coffee-open-v2" : "data/knowledge/coffee-open-v1");
const base = "https://pmc-oa-opendata.s3.amazonaws.com/";
const checkedAt = new Date().toISOString();
const hash = (content: Buffer, algorithm = "sha256") => createHash(algorithm).update(content).digest("hex");
const registryPath = join(root, "acquisition.json");
const records: Array<Record<string, unknown>> = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, "utf8")).records : [];
mkdirSync(root, { recursive: true });
function record(value: Record<string, unknown>) {
	const index = records.findIndex((r) => r.id === value.id); if (index < 0) records.push(value); else records[index] = value;
	writeFileSync(`${registryPath}.pending`, JSON.stringify({ schemaVersion: "coffee-acquisition.v1", service: "PMC Article Datasets via anonymous HTTPS", policy: "https://pmc.ncbi.nlm.nih.gov/tools/pmcaws/", robots: { url: `${base}robots.txt`, checkedAt: "2026-09-17T00:00:00.000Z", status: 404, interpretation: "No robots object at initial check; explicit dataset API authorization applies, no website crawling" }, records }, null, "\t") + "\n");
	renameSync(`${registryPath}.pending`, registryPath);
}
async function get(url: string) {
	await setTimeout(1100);
	// Operator-only fixed dataset command, never an Agent tool or arbitrary URL downloader.
	// This host resolves public DNS through a 198.18/15 proxy; the runtime downloader correctly rejects it.
	if (!articles.some((id) => ["json", "xml", "pdf"].some((kind) => url === `${base}${id}.1/${id}.1.${kind}`))) throw new Error("dataset_url_not_allowed");
	return execFileSync("curl", ["--fail", "--silent", "--show-error", "--proto", "=https", "--max-redirs", "0", "--max-time", "30", "--max-filesize", "10485760", url], { maxBuffer: 10 * 1024 * 1024, timeout: 35_000 });
}
for (const id of articles) {
	const revision = `${id}.1`, directory = join(root, revision); mkdirSync(directory, { recursive: true });
	const url = `${base}${revision}/${revision}.json`;
	const metadataBytes = await get(url), metadata = JSON.parse(metadataBytes.toString());
	if (metadata.pmcid !== id || metadata.version !== 1) throw new Error("metadata_identity_mismatch");
	const permitted = metadata.license_code === "CC BY" && metadata.is_pmc_openaccess === true && metadata.is_retracted === false && metadata.is_manuscript === false;
	writeFileSync(join(directory, "metadata.json"), metadataBytes);
	if (!permitted) { record({ id, revision, status: "excluded", license: metadata.license_code, checkedAt, metadataSha256: hash(metadataBytes), reason: "Requires CC BY, non-retracted final published version" }); continue; }
	const files = [];
	for (const kind of ["xml", "pdf"] as const) {
		const source = new URL(metadata[`${kind}_url`]);
		if (source.protocol !== "s3:" || source.hostname !== "pmc-oa-opendata" || source.pathname !== `/${revision}/${revision}.${kind}` || !/^[a-f0-9]{32}$/.test(source.searchParams.get("md5") ?? "")) throw new Error("metadata_url_rejected");
		const fileUrl = `${base}${revision}/${revision}.${kind}`, file = join(directory, `${revision}.${kind}`);
		const bytes = existsSync(file) ? readFileSync(file) : await get(fileUrl);
		if (hash(bytes, "md5") !== source.searchParams.get("md5")) throw new Error("source_changed_or_corrupt: review before refreshing snapshot");
		if (!existsSync(file)) writeFileSync(file, bytes, { flag: "wx" });
		files.push({ file: `${revision}/${revision}.${kind}`, url: fileUrl, bytes: bytes.length, sha256: hash(bytes), publisherMd5: hash(bytes, "md5") });
	}
	record({ id, revision, status: "downloaded", title: metadata.title, doi: metadata.doi, citation: metadata.citation, license: "CC BY", checkedAt, retrievedAt: records.find((r) => r.id === id)?.retrievedAt ?? new Date().toISOString(), metadataSha256: hash(metadataBytes), files });
	console.log(`${id}: CC BY; XML/PDF downloaded and checksum verified`);
}
