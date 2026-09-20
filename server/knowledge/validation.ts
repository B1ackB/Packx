import { KnowledgeError, type KnowledgeImport, type KnowledgeQuery } from "../../src/enterprise/knowledge";

export const knowledgeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 500): value is string => typeof value === "string" && value.length <= max;
const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const optionalDate = (value: unknown) => value === null || date(value);
const strings = (value: unknown, max = 20): value is string[] => Array.isArray(value) && value.length <= max && value.every((v) => text(v));
export function safeSourceUrl(value: unknown): boolean {
	if (!text(value, 2000)) return false;
	if (/^synthetic:\/\/[a-z0-9/-]+$/.test(value)) return true;
	try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}

export function assertImport(value: unknown): asserts value is KnowledgeImport {
	const invalid = () => { throw new KnowledgeError("invalid_import_manifest"); };
	if (!record(value) || JSON.stringify(value).length > 1_000_000) return invalid();
	// Reject obvious credential material before any persistence or error logging.
	if (/(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|-----BEGIN .*PRIVATE KEY-----|(?:api[_-]?key|password|secret)\s*[=:]\s*[^\s,]{8,})/i.test(JSON.stringify(value))) throw new KnowledgeError("secret_material_rejected");
	if (value.schemaVersion !== "knowledge-import.v1" || !knowledgeId(value.documentId) || !knowledgeId(value.family) ||
		![value.title, value.publisher, value.model, value.revision, value.language].every((v) => text(v, 200) && v.length > 0) ||
		!safeSourceUrl(value.sourceUrl) || !strings(value.regions) || value.regions.length === 0 ||
		![value.publishedAt, value.effectiveAt, value.expiresAt].every(optionalDate) ||
		!["public_source", "user_authorized", "synthetic"].includes(String(value.provenance)) || !["workspace", "public"].includes(String(value.visibility))) return invalid();
	const p = value.permission;
	if (!record(p) || !text(p.basis, 1000) || !p.basis || !text(p.reference, 2000) || !p.reference || !date(p.checkedAt) || !optionalDate(p.expiresAt) ||
		![p.storage, p.indexing, p.redistribution].every((v) => typeof v === "boolean")) return invalid();
	if (!p.storage || !p.indexing || value.visibility === "public" && !p.redistribution) throw new KnowledgeError("permission_not_granted", 403);
	if (value.provenance === "synthetic" && !String(value.sourceUrl).startsWith("synthetic://")) return invalid();
	const parser = value.parser;
	if (!record(parser) || !text(parser.name) || !parser.name || !text(parser.version) || !parser.version || !text(parser.reason, 1000) || !["reviewed", "needs_review", "needs_ocr", "failed"].includes(String(parser.status))) return invalid();
	if (!Array.isArray(value.blocks) || value.blocks.length > 500 || value.blocks.length === 0 && parser.status === "reviewed") return invalid();
	for (const block of value.blocks) {
		if (!record(block) || !record(block.location) || (block.location.page !== undefined && (!Number.isSafeInteger(block.location.page) || Number(block.location.page) < 1)) || !text(block.location.section) || !block.location.section ||
			(block.location.anchor !== undefined && (!text(block.location.anchor) || !/^[a-zA-Z0-9._:-]+$/.test(block.location.anchor))) ||
			(block.location.page === undefined && block.location.anchor === undefined && block.location.paragraph === undefined) ||
			[block.location.paragraph, block.location.part].some((n) => n !== undefined && (!Number.isSafeInteger(n) || Number(n) < 1)) ||
			(block.location.table !== undefined && !text(block.location.table)) || (block.location.row !== undefined && (!Number.isSafeInteger(block.location.row) || Number(block.location.row) < 1)) ||
			!text(block.text, 4000) || !Array.isArray(block.parameters) || block.parameters.length > 16) return invalid();
		const table = block.table;
		if (table !== undefined && (!record(table) || !strings(table.headers) || !table.headers.length || !strings(table.units) || table.headers.length !== table.units.length ||
			!Array.isArray(table.rows) || table.rows.length > 30 || !table.rows.every((row) => strings(row) && row.length === (table.headers as unknown[]).length) ||
			!Array.isArray(table.footnotes) || table.footnotes.length > 20 || !table.footnotes.every((v) => text(v, 2000)) || !text(table.conditions) || !block.location.table)) return invalid();
		for (const param of block.parameters) {
			if (!record(param) || ![param.name, param.originalValue, param.originalUnit, param.method, param.conditions, param.scope].every((v) => text(v)) ||
				(param.subject !== undefined && !text(param.subject)) || !["unverified", "human_reviewed"].includes(String(param.verification)) || !["supplier_claim", "third_party_test", "certificate_record", "human_confirmation", "research_report"].includes(String(param.authority))) return invalid();
			const source = `${block.text}\n${JSON.stringify(table ?? {})}`;
			if (!param.originalValue || !source.includes(String(param.originalValue)) || param.originalUnit && !source.includes(String(param.originalUnit))) throw new KnowledgeError("parameter_not_in_source");
			if (param.testConditions !== undefined) {
				if (!Array.isArray(param.testConditions) || param.testConditions.length > 8 || param.testConditions.some((c) => !record(c) || Object.keys(c).some((key) => !["name", "value", "unit"].includes(key)) || !text(c.name, 40) || !/^[a-z][a-z_]*$/.test(c.name) || !text(c.value, 100) || !c.value || !text(c.unit, 100)) || new Set(param.testConditions.map((c) => c.name)).size !== param.testConditions.length) return invalid();
				if (param.testConditions.some((c) => !source.includes(c.value) || c.unit && !source.includes(c.unit))) throw new KnowledgeError("test_condition_not_in_source");
			}
		}
	}
}

export function assertQuery(value: unknown): asserts value is KnowledgeQuery {
	if (!record(value) || Object.keys(value).some((k) => !["query", "mode", "model", "region", "asOf", "limit", "provenance"].includes(k)) || !text(value.query, 300) || !value.query.trim() ||
		!["keyword", "vector", "hybrid"].includes(String(value.mode)) ||
		(value.model !== undefined && (!text(value.model, 200) || !value.model)) || (value.region !== undefined && (!text(value.region, 100) || !value.region)) ||
		(value.asOf !== undefined && !date(value.asOf)) ||
		(value.provenance !== undefined && !["public_source", "user_authorized", "synthetic"].includes(String(value.provenance))) ||
		(value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 8))) throw new KnowledgeError("invalid_knowledge_query");
}
