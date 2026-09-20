import { XMLParser, XMLValidator } from "fast-xml-parser";
import { KnowledgeError, type EvidenceBlock } from "../../src/enterprise/knowledge";

type Node = Record<string, unknown>;
const children = (node: Node, key: string): Node[] => Array.isArray(node[key]) ? node[key] as Node[] : [];
const attributes = (node: Node) => (node[":@"] ?? {}) as Record<string, string>;
export function jatsText(nodes: Node[]): string {
	return nodes.map((node) => Object.entries(node).filter(([key]) => key !== ":@").map(([key, value]) => key === "#text" ? String(value) : Array.isArray(value) ? jatsText(value) : "").join("")).join("").replace(/\s+/g, " ").trim();
}
const direct = (nodes: Node[], key: string) => nodes.flatMap((node) => children(node, key));
function descendants(nodes: Node[], key: string): Node[] {
	return nodes.flatMap((node) => Object.entries(node).flatMap(([name, value]) => name === key ? [node] : Array.isArray(value) ? descendants(value, key) : []));
}
function grid(rows: Node[]): string[][] {
	const result: string[][] = [];
	rows.forEach((node, r) => {
		result[r] ??= []; let c = 0;
		for (const cell of children(node, "tr")) {
			if (!cell.td && !cell.th) continue;
			while (result[r][c] !== undefined) c++;
			const a = attributes(cell), height = Number(a["@_rowspan"] ?? 1), width = Number(a["@_colspan"] ?? 1);
			if (![height, width].every((n) => Number.isInteger(n) && n > 0 && n <= 30)) throw new KnowledgeError("jats_invalid_table_span");
			const text = jatsText(children(cell, cell.td ? "td" : "th"));
			for (let y = r; y < r + height; y++) { result[y] ??= []; for (let x = c; x < c + width; x++) { if (result[y][x] !== undefined) throw new KnowledgeError("jats_overlapping_table_cells"); result[y][x] = text; } }
			c += width;
		}
	});
	return result;
}
function split(text: string): string[] {
	const result: string[] = [];
	while (text.length > 1000) { let at = text.lastIndexOf(". ", 1000) + 1; if (at < 300) at = text.lastIndexOf(" ", 1000); if (at < 1) at = 1000; result.push(text.slice(0, at)); text = text.slice(at).trim(); }
	if (text) result.push(text); return result;
}

/** Structured JATS body + abstract + table captions/headers/rows/footnotes. No entity expansion/network/guessed PDF page. */
export function parseJats(xml: string): { blocks: EvidenceBlock[]; authors: string; publishedAt: string; title: string; tableCount: number; paragraphCount: number } {
	if (Buffer.byteLength(xml) > 4_000_000 || /<!ENTITY|<!DOCTYPE[^>]*\[/i.test(xml)) throw new KnowledgeError("jats_unsafe_xml");
	if (XMLValidator.validate(xml) !== true) throw new KnowledgeError("jats_invalid_xml");
	const nodes = new XMLParser({ ignoreAttributes: false, preserveOrder: true, parseTagValue: false, trimValues: false }).parse(xml) as Node[];
	const article = direct(nodes, "article"), front = direct(article, "front"), meta = direct(front, "article-meta");
	const licenses = descendants(meta, "license");
	if (!licenses.some((n) => [attributes(n)["@_xlink:href"], jatsText(direct(children(n, "license"), "ali:license_ref"))].some((href) => /^https?:\/\/creativecommons.org\/licenses\/by\/4\.0\/$/.test(href ?? "")))) throw new KnowledgeError("jats_license_not_cc_by_4");
	const authors = descendants(meta, "contrib").filter((n) => attributes(n)["@_contrib-type"] === "author").map((n) => { const name = direct(children(n, "contrib"), "name"); return [jatsText(direct(name, "given-names")), jatsText(direct(name, "surname"))].filter(Boolean).join(" "); }).filter(Boolean).join(", ");
	const date = descendants(meta, "pub-date").find((n) => attributes(n)["@_pub-type"] === "epub" || attributes(n)["@_publication-format"] === "electronic");
	if (!date) throw new KnowledgeError("jats_date_missing");
	const d = children(date, "pub-date");
	const publishedAt = `${jatsText(direct(d, "year"))}-${jatsText(direct(d, "month")).padStart(2, "0")}-${jatsText(direct(d, "day")).padStart(2, "0")}T00:00:00.000Z`;
	const blocks: EvidenceBlock[] = []; let paragraphCount = 0;
	function walk(list: Node[], section: string, anchor?: string) {
		let paragraph = 0;
		for (const node of list) {
			if (node.sec) { const contents = children(node, "sec"), title = jatsText(direct(contents, "title")); walk(contents, [section, title].filter(Boolean).join(" / "), attributes(node)["@_id"] ?? anchor); }
			else if (node.p) { paragraph++; paragraphCount++; const content = jatsText(children(node, "p")); split(content).forEach((text, i) => blocks.push({ location: { section, anchor, paragraph, part: i + 1 }, text, parameters: [] })); }
		}
	}
	walk(direct(meta, "abstract"), "Abstract"); walk(direct(article, "body"), "");
	const tables = descendants(article, "table-wrap");
	for (const node of tables) {
		const body = children(node, "table-wrap"), tableId = attributes(node)["@_id"], label = jatsText(direct(body, "label")), caption = jatsText(direct(body, "caption"));
		if (!tableId) throw new KnowledgeError("jats_table_without_anchor");
		const table = direct(body, "table"), head = grid(descendants(direct(table, "thead"), "tr")), rows = grid(descendants(direct(table, "tbody"), "tr"));
		if (!head.length || !rows.length) throw new KnowledgeError("jats_table_needs_review");
		const width = Math.max(...head.map((r) => r.length));
		if (width > 20 || rows.some((r) => r.length !== width)) throw new KnowledgeError("jats_ragged_table");
		const headers = Array.from({ length: width }, (_, c) => [...new Set(head.map((r) => r[c]).filter(Boolean))].join(" / "));
		const footnote = jatsText(direct(body, "table-wrap-foot"));
		// Preserve the original compound unit IN its header; no regex unit guesses or implicit normalisation.
		for (let index = 0; index < rows.length; index++) blocks.push({ location: { section: label, anchor: tableId, table: label, row: index + 1 }, text: caption, table: { headers, units: headers.map(() => ""), rows: [rows[index]], footnotes: footnote ? [footnote] : [], conditions: "" }, parameters: [] });
	}
	if (!blocks.length || blocks.some((b) => !b.text)) throw new KnowledgeError("jats_empty_content");
	return { blocks, authors, publishedAt, title: jatsText(direct(direct(meta, "title-group"), "article-title")), tableCount: tables.length, paragraphCount };
}
