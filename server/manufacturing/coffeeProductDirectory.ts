import { randomUUID } from "node:crypto";
import type { AgentHostTool } from "../../src/agent/contracts";
import { KnowledgeError, type EvidenceResult, type KnowledgeImport, type KnowledgeScope } from "../../src/enterprise/knowledge";
import { coffeeDirectoryVersion, coffeeProductDirectory, coffeeSupplierQuestions, type CoffeeForm } from "../../src/manufacturing/coffeeProducts";
import { terms } from "../knowledge/embedding";
import { KnowledgeStore, digest } from "../knowledge/store";

const checkedAt = "2026-09-18T00:00:00.000Z";
export function coffeeProductManifests(): KnowledgeImport[] {
	return coffeeProductDirectory.map((p) => ({ schemaVersion: "knowledge-import.v1", documentId: `catalog-${p.id}`, family: `product-directory-${p.manufacturer.replaceAll(" ", "-")}`, title: `${p.manufacturer} / ${p.product} / 产品资料目录`, publisher: p.manufacturer, model: `catalog:${p.id}`, revision: coffeeDirectoryVersion, sourceUrl: p.sourceUrl, language: "zh", regions: ["unknown"], publishedAt: null, effectiveAt: null, expiresAt: "2026-12-17T00:00:00.000Z", provenance: "public_source", visibility: "public",
		permission: { basis: "Packx 自编的公开资料目录，仅含名称、来源定位、分类标签和自编追问。许可范围只覆盖本目录；供应商全文未下载、未获得索引/再分发授权。目录内容不是供应商原文、规格或认证。", reference: p.termsUrl, checkedAt, expiresAt: null, storage: true, indexing: true, redistribution: true },
		parser: { name: "packx-product-directory", version: "1.0.0", status: "reviewed", reason: "Manually curated metadata and official links only; 90-day directory review deadline, not supplier document expiry. Original document version may be unknown. No extracted production parameters." },
		blocks: [{ location: { section: p.sourceSection, paragraph: 1 }, text: `${p.manufacturer} / ${p.product}\n【Packx 资料目录，不是供应商原文】\n资料修订标记：${p.sourceVersion ?? "未说明"}。分类：${p.forms.join(", ")}；检索标签：${p.keywords.join(" ")}。\n${p.note}\n已获准入库的该系列 TDS：无。层序、厚度、OTR/WVTR、测试条件、订单适用性、报价与认证：待供应商资料与人工核对。`, parameters: [] }],
	}));
}
interface ProductQuery { query: string; coffeeForm?: CoffeeForm }
function assertProductQuery(input: unknown): asserts input is ProductQuery {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new KnowledgeError("invalid_product_query");
	const x = input as Record<string, unknown>;
	if (Object.keys(x).some((k) => !["query", "coffeeForm"].includes(k)) || typeof x.query !== "string" || !x.query.trim() || x.query.length > 300 || x.coffeeForm !== undefined && !["roasted_beans", "ground", "instant"].includes(String(x.coffeeForm))) throw new KnowledgeError("invalid_product_query");
}
export async function findCoffeeProducts(store: KnowledgeStore, scope: KnowledgeScope, input: unknown, correlationId: string = randomUUID(), signal?: AbortSignal) {
	assertProductQuery(input); const started = performance.now(), tokens = terms(input.query);
	const records = coffeeProductDirectory.filter((p) => !input.coffeeForm || p.forms.includes(input.coffeeForm)).map((p) => {
		const text = `${p.manufacturer} ${p.product} ${p.keywords.join(" ")}`.toLowerCase();
		return { product: p, score: tokens.filter((t) => text.includes(t)).length + (input.query.toLowerCase().includes(p.product.toLowerCase()) ? 100 : 0) };
	}).filter((p) => p.score > 0).sort((a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id)).slice(0, 6);
	const responses: EvidenceResult[] = [];
	for (const { product } of records) responses.push(await store.search(scope, { query: product.product, mode: "keyword", model: `catalog:${product.id}`, provenance: "public_source", limit: 1 }, `${correlationId}:${product.id}`, signal));
	const hits = responses.flatMap((r) => r.hits), warnings = ["directory_metadata_not_supplier_evidence", "supplier_tds_permission_required", "do_not_infer_order_parameters", ...(!input.coffeeForm ? ["confirm_coffee_form"] : [])];
	const result: EvidenceResult = { schemaVersion: "evidence-result.v1", status: hits.length ? "candidates" : "no_evidence", correlationId, indexVersion: "knowledge-blocks.v1", corpusVersion: digest(responses.map((r) => r.corpusVersion)), embedding: store.embedding.signature, retrievalVersion: coffeeDirectoryVersion, hits, gaps: [...warnings, ...(!hits.length ? ["no_matching_imported_directory_record"] : [])], durationMs: performance.now() - started, usage: { embeddingCalls: 0, generationCalls: 0, costUsd: 0, inputTokens: 0, modelDurationMs: 0 } };
	return { result, questions: coffeeSupplierQuestions, conclusionAllowed: false, recordType: "metadata_only", verification: "unverified" };
}
export function createCoffeeProductTool(store: KnowledgeStore): AgentHostTool {
	return { name: "packaging_find_products", description: "Start coffee packaging sourcing with this product-directory tool. Returns manufacturer/product-family metadata, official source links and specific supplier questions, never supplier full text or verified specifications. Coffee form is an explicit filter: roasted_beans, ground or instant. Cite returned evidenceId, preserve unknown parameters; no production sizes, prices, certification or shelf life may be inferred. Directory records can be selected using the normal evidence workflow. Research papers are excluded.", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 300 }, coffeeForm: { enum: ["roasted_beans", "ground", "instant"] } }, required: ["query"], additionalProperties: false }, execution: "host", risk: "read", idempotent: true, timeoutMs: 1000, maxResultChars: 24_000,
		validate: (input) => { try { assertProductQuery(input); return true; } catch { return false; } },
		execute: async (input, context) => { context.signal.throwIfAborted(); return findCoffeeProducts(store, context, input, context.executionId, context.signal); } };
}
