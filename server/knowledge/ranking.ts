import type { EvidenceBlock, KnowledgeDocument } from "../../src/enterprise/knowledge";
import { terms } from "./embedding";

export interface RankRow { id: string; block: EvidenceBlock; doc: KnowledgeDocument; terms: string[] }
export interface Ranked<T> { row: T; score: number }
const stop = new Set("a an and are as at be been by can did do does for from had has have how in into is it its of on or per that the their these this those to was were what when where which who with without would study studies reported report given using used value values original raw please paper films film packaging packages samples sample research table".split(" "));
const tokenize = (text: string) => terms(text).filter((t) => !stop.has(t));
// Stable source order, independent of a content hash changing unrelated document metadata.
export function sourceOrder(a: RankRow, b: RankRow): number {
	return a.doc.manifest.documentId.localeCompare(b.doc.manifest.documentId) || a.doc.manifest.revision.localeCompare(b.doc.manifest.revision) || Number(a.id.split(":").at(-1)) - Number(b.id.split(":").at(-1)) || a.id.localeCompare(b.id);
}
export function fieldRanking<T extends RankRow>(rows: T[], query: string): Ranked<T>[] {
	const wanted = tokenize(query);
	const fields = rows.map((row) => {
		const table = row.block.table;
		// Caption/footnotes are context shared by many rows; cells+headers contain the distinguishing evidence.
		const body = table ? table.rows.flatMap((cells) => cells.map((cell, i) => `${table.headers[i]} ${table.units[i]} ${cell}`)).join(" ") : row.block.text;
		return { row, body: new Set(tokenize(body)), context: new Set(tokenize(`${table ? row.block.text : ""} ${row.block.location.section} ${(table?.footnotes ?? []).join(" ")}`)), title: new Set(tokenize(`${row.doc.manifest.title} ${row.doc.manifest.model}`)) };
	});
	const weights = new Map(wanted.map((term) => {
		const df = fields.filter((f) => f.body.has(term)).length;
		return [term, Math.log(1 + (rows.length - df + .5) / (df + .5))];
	}));
	return fields.map((f) => ({ row: f.row, score: wanted.reduce((sum, term) => sum + weights.get(term)! * (f.body.has(term) ? 1 : f.context.has(term) ? .2 : f.title.has(term) ? .1 : 0), 0) + (f.row.doc.manifest.model.toLowerCase() === query.toLowerCase() ? 10 : 0) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || sourceOrder(a.row, b.row));
}

/** Keep every version; avoid spending all K slots on repeated rows of one table. No rows are discarded. */
export function diverseTables<T extends RankRow>(ranking: Ranked<T>[], limit: number, query = ""): Ranked<T>[] {
	const selected: Ranked<T>[] = [], deferred: Ranked<T>[] = [], counts = new Map<string, number>();
	const queryTerms = new Set(terms(query));
	for (const item of ranking) {
		const table = item.row.block.location.table;
		const key = JSON.stringify([item.row.doc.versionId, item.row.block.location.anchor ?? "", table]);
		const requestedRow = item.row.block.table?.rows.some((row) => row[0].length >= 2 && terms(row[0]).length === 1 && queryTerms.has(row[0].normalize("NFKC").toLowerCase()));
		if (table && !requestedRow && (counts.get(key) ?? 0) >= 1) deferred.push(item);
		else { selected.push(item); if (table) counts.set(key, (counts.get(key) ?? 0) + 1); }
	}
	return [...selected, ...deferred].slice(0, limit);
}
