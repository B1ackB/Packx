import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { configureLocalData } from "../server/localData";
import { FileStageJobQueue } from "../server/enterprise/fileStageJobQueue";
import { loadCoffeeCorpus } from "../server/manufacturing/coffeeOpenCorpus";
import { coffeeProductManifests } from "../server/manufacturing/coffeeProductDirectory";
import type { AnthropicMessageRequest } from "../server/anthropic/types";
import type { EvidenceHit, EvidenceResult, KnowledgeDocument } from "../src/enterprise/knowledge";
import type { ConversationView } from "../src/runtime/conversationContracts";
import type { KnowledgeView } from "../src/runtime/knowledgeView";
import type { ModelTelemetryView } from "../src/runtime/modelTelemetry";

// Explicit provisioning command: keeps real data and a labelled verification task in the normal app.
// Generation is a loopback fixture; retrieval, queue, Tool, ContextEngine and persistence are real.
const environment = { ...process.env };
const data = configureLocalData(environment);
assert(!existsSync(join(data.root, ".packx-operation.lock")), "Stop Packx before connecting; never replace a running Host lock.");
assert((environment.BLACKX_STAGE_JOB_QUEUE_DRIVER ?? "file") === "file", "This command requires the file queue; use the existing import API with a SQLite queue.");
assert(new FileStageJobQueue(environment.BLACKX_STAGE_JOB_QUEUE_PATH!).list().every((j) => j.stageId === "knowledge-import" || ["completed", "cancelled", "dead_letter"].includes(j.status)), "Finish unrelated background work before provisioning.");
if (existsSync(environment.BLACKX_CRON_SCHEDULE_PATH!)) {
	const cron = JSON.parse(readFileSync(environment.BLACKX_CRON_SCHEDULE_PATH!, "utf8")) as { schedules: Array<{ status: string }> };
	assert(cron.schedules.every((s) => s.status !== "active"), "Pause active schedules before provisioning with a fixture Provider.");
}
const productMode = process.argv.includes("--products");
const verificationStartedAt = new Date().toISOString();
const manifests = productMode ? coffeeProductManifests() : loadCoffeeCorpus();
const temporary = mkdtempSync(join(tmpdir(), "packx-knowledge-connect-"));
const receiptPath = join(data.root, "knowledge", productMode ? "product-connection.json" : "connection.json");
const marker = productMode ? "产品目录连通验证" : "知识库连通验证";
let providerCalls = 0;
const received: Array<{ tool: string; hits: EvidenceHit[] }> = [];
const provider = createServer(async (request, response) => {
	try {
		const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString()) as AnthropicMessageRequest;
		response.setHeader("content-type", "application/json");
		if (request.url?.endsWith("count_tokens")) { response.end(JSON.stringify({ input_tokens: 100 })); return; }
		assert(JSON.stringify(body.messages).includes(marker), "Unrelated work must not use this fixture");
		providerCalls++;
		const last = body.messages.at(-1)?.content ?? [];
		const result = last.find((b) => b.type === "tool_result");
		let content: unknown[];
		if (result?.type === "tool_result") {
			const raw = JSON.parse(result.content) as EvidenceResult & { result?: EvidenceResult };
			const parsed = raw.result ?? raw;
			const hit = parsed.hits.find((h) => productMode ? h.model === "catalog:cflex-ecolamhighplus" : h.parameters.some((p) => p.name === "grammage" && p.subject === "REC"));
			assert(hit, "Actual source parameters did not reach the model context");
			received.push({ tool: result.tool_use_id, hits: parsed.hits });
			if (productMode) {
				assert.equal(hit.parameters.length, 0); assert(hit.text.includes("不是供应商原文"));
				content = [{ type: "text", text: `【本地工具连通验证；测试 Provider 整理】\n${hit.title}\n仅产品目录，生产参数未知。需要索取具体型号 TDS，逐项核对层序、各层厚度、OTR/WVTR 单位及测试条件、阀和封口匹配。\n版本：${hit.revision}\n证据：${hit.evidenceId}\n官方入口：${hit.sourceUrl}\n选入任务不等于确认材料或审批。` }];
			} else {
				const parameter = hit.parameters.find((p) => p.name === "grammage" && p.subject === "REC")!;
				assert.equal(parameter.verification, "unverified"); assert.equal(parameter.authority, "research_report");
				content = [{ type: "text", text: `【本地工具连通验证；回复由测试 Provider 整理】\n\n实际知识库返回 REC 研究样品克重原值：${parameter.originalValue} ${parameter.originalUnit}。\n来源：${hit.title}，${hit.revision}，第 ${hit.location.page} 页，${hit.location.section}。\n证据：${hit.evidenceId}\n原文：${hit.sourceUrl}\n\n资料来自真实研究全文；参数仍未确认，不能直接作为订单规格。本任务验证工具与上下文链路，不代表生成模型质量。` }];
			}
		} else {
			const selected = JSON.stringify(last).includes("已选证据");
			const tool = selected ? "knowledge_selected" : productMode ? "packaging_find_products" : "knowledge_search";
			assert(body.tools?.some((t) => t.name === tool), "Knowledge Tool missing from normal conversation");
			content = [{ type: "tool_use", id: tool, name: tool, input: selected ? {} : productMode ? { query: "EcoLamHighPlus", coffeeForm: "roasted_beans" } : { query: "REC 膜的克重及单位是什么？", mode: "hybrid", model: "study:PMC11243642", provenance: "public_source", limit: 5 } }];
		}
		response.end(JSON.stringify({ id: `connect-${providerCalls}`, type: "message", role: "assistant", model: "local-knowledge-connection-fixture", content, stop_reason: result ? "end_turn" : "tool_use", usage: { input_tokens: 100, output_tokens: 100 } }));
	} catch { response.writeHead(500); response.end(JSON.stringify({ error: { type: "fixture_error", message: "Knowledge source did not reach the model context" } })); }
});
let host: ChildProcess | undefined;
let base = "", token = "";
const stopHost = async () => {
	const running = host; host = undefined;
	if (running && running.exitCode === null && running.signalCode === null) { const exited = once(running, "exit"); running.kill("SIGTERM"); await exited; }
};
const cleanup = async () => {
	await stopHost(); provider.closeAllConnections(); if (provider.listening) await new Promise<void>((done) => provider.close(() => done()));
	rmSync(temporary, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void cleanup().then(() => process.exit(130)));
async function startHost() {
	const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
	const port = (reservation.address() as { port: number }).port;
	await new Promise<void>((done) => reservation.close(() => done()));
	base = `http://127.0.0.1:${port}`;
	host = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { stdio: ["ignore", "ignore", "ignore"], env: {
		...environment, BLACKX_DATA_ROOT: data.root, BLACKX_PORT: String(port), BLACKX_PRODUCTION: "1", PACKX_KNOWLEDGE_MODEL: "local-e5", PACKX_EMBEDDING_CONFIG: "",
		...(productMode ? { PACKX_KNOWLEDGE_RERANKER: "local-mmarco" } : {}),
		PACKX_SETTINGS_PATH: join(temporary, "unused-settings.json"), BLACKX_RUNTIME_MODE: "anthropic", ANTHROPIC_API_KEY: "offline-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, ANTHROPIC_MODEL: "local-knowledge-connection-fixture",
	} });
	for (let i = 0; i < 150; i++) {
		assert(host.exitCode === null && host.signalCode === null, "Host startup failed; inspect normal configuration and model cache");
		try {
			const session = await fetch(`${base}/api/local-session`, { headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }, signal: AbortSignal.timeout(1000) });
			if (session.ok) { token = ((await session.json()) as { token: string }).token; return; }
		} catch { /* Host is loading the pinned local model. */ }
		await delay(100);
	}
	throw new Error("Host startup timeout");
}
async function api<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
	const response = await fetch(`${base}${path}`, { method, headers: { "x-blackx-session-token": token, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(130_000) });
	assert(response.ok, `${path}: HTTP ${response.status}`);
	return response.json() as Promise<T>;
}
try {
	provider.listen(0, "127.0.0.1"); await once(provider, "listening");
	await startHost();
	let conversationId = existsSync(receiptPath) ? (JSON.parse(readFileSync(receiptPath, "utf8")) as { conversationId: string }).conversationId : undefined;
	if (conversationId) {
		assert(/^conversation-[a-zA-Z0-9._:-]+$/.test(conversationId));
		const response = await fetch(`${base}/api/conversations/${conversationId}`, { headers: { "x-blackx-session-token": token } });
		if (response.status === 404) conversationId = undefined; else assert(response.ok);
	}
	if (!conversationId) conversationId = (await api<{ conversation: ConversationView }>("/api/conversations", {})).conversation.conversationId;
	writeFileSync(receiptPath, JSON.stringify({ schemaVersion: "knowledge-connection.v1", status: "verifying", conversationId }, null, "\t") + "\n", { mode: 0o600 });
	const path = `/api/conversations/${conversationId}`, knowledgePath = `${path}/knowledge`;
	const conversation = (await api<{ conversation: ConversationView }>(path)).conversation;
	await api(path, { name: productMode ? "产品目录连通验证（来源与缺口 / 本地测试回复）" : "知识库连通验证（真实资料 / 本地测试回复）", nameRevision: conversation.nameRevision ?? 0 }, "PATCH");
	const importAction = productMode ? "open-products" : "open-research";
	const imported = await api<{ documents: KnowledgeDocument[] }>(`${knowledgePath}/${importAction}`, {});
	assert.equal(imported.documents.length, manifests.length);
	console.log("Import submitted to the normal Packx durable queue; waiting for local E5 indexing.");
	const ids = imported.documents.map((d) => d.versionId).sort();
	let view = await api<KnowledgeView>(knowledgePath);
	for (let i = 0; i < 240 && !ids.every((id) => view.documents.some((d) => d.versionId === id && d.status === "indexed")); i++) {
		assert(!view.jobs.some((j) => ids.includes(j.versionId) && j.status === "dead_letter"), "Import failed; inspect the existing import panel and retry");
		await delay(1000); view = await api<KnowledgeView>(knowledgePath);
	}
	assert(ids.every((id) => view.documents.some((d) => d.versionId === id && d.status === "indexed")), "Import timeout; durable jobs remain resumable");
	assert.equal(view.embedding.kind, "local_model"); assert(view.embedding.signature.includes("multilingual-e5-small"));
	const again = await api<{ documents: KnowledgeDocument[] }>(`${knowledgePath}/${importAction}`, {});
	assert.deepEqual(again.documents.map((d) => d.versionId).sort(), ids);
	const ask = async (selected: boolean) => {
		const turn = await api<{ conversation: ConversationView }>(`${path}/messages`, { messageId: `kb-connect-${randomUUID()}`, content: `${marker}：${selected ? "读取已选证据" : "调用检索工具"}，${productMode ? "查找 EcoLamHighPlus 的官方资料入口和待向供应商逐项核对的字段。" : "列出 REC 膜克重、单位和资料出处。请保留研究样品及未确认状态。"}` });
		assert(turn.conversation.messages.at(-1)?.content.includes(productMode ? "仅产品目录" : "81 g/m2"), "Actual source missing from the persisted response");
	};
	await ask(false);
	const hit = received.at(-1)!.hits.find((h) => productMode ? h.model === "catalog:cflex-ecolamhighplus" : h.parameters.some((p) => p.subject === "REC" && p.name === "grammage"))!;
	await api(`${knowledgePath}/select`, { ids: [hit.evidenceId], applicability: { region: "unknown", asOf: new Date().toISOString() }, requestId: randomUUID(), expectedVersion: view.selection?.version ?? 0 });
	await ask(true);
	await stopHost(); await startHost();
	const restarted = await api<KnowledgeView>(knowledgePath);
	assert(ids.every((id) => restarted.documents.some((d) => d.versionId === id && d.status === "indexed")));
	assert(restarted.selection?.ids.includes(hit.evidenceId));
	await ask(false); await ask(true);
	const ranked = productMode ? (await api<{ result: EvidenceResult }>(`${knowledgePath}/search`, { query: "EcoLamHighPlus 咖啡袋产品资料入口", mode: "hybrid", limit: 5 })).result : undefined;
	if (ranked) { assert.equal(ranked.reranking?.status, "completed"); assert(ranked.reranking.candidateCount <= 20); assert(ranked.hits.some((h) => h.model === "catalog:cflex-ecolamhighplus")); }
	const telemetry = await api<ModelTelemetryView>(`${path}/model-calls`);
	assert(telemetry.calls.filter((c) => c.startedAt >= verificationStartedAt).every((c) => c.model === "local-knowledge-connection-fixture" && c.status === "succeeded"));
	const receipt = { schemaVersion: "knowledge-connection.v1", status: "ready", connectedAt: new Date().toISOString(), dataRoot: data.root, database: join(data.root, "knowledge", "knowledge.sqlite"), conversationId, documents: ids.length, chunks: manifests.reduce((n, m) => n + m.blocks.length, 0), versionIds: ids, embedding: restarted.embedding, reranking: ranked?.reranking, duplicateImportSameVersions: true, restartReadPassed: true, toolResultsReachedContext: received.map((r) => ({ tool: r.tool, evidenceIds: r.hits.map((h) => h.evidenceId) })), example: { evidenceId: hit.evidenceId, revision: hit.revision, model: hit.model, location: hit.location, ...(productMode ? { recordType: "metadata_only", parameters: [] } : { originalValue: "81", originalUnit: "g/m2" }), verification: "unverified" }, fixtureGenerationCalls: providerCalls, paidModelCalls: 0, limitation: "Actual stored data and normal Host/ContextEngine integration; scripted local generation is not real LLM quality. Product metadata is not vendor full text. Existing generation settings are unchanged." };
	writeFileSync(receiptPath, JSON.stringify(receipt, null, "\t") + "\n", { mode: 0o600 });
	console.log(JSON.stringify({ receipt: receiptPath, documents: receipt.documents, chunks: receipt.chunks, conversationId, restartReadPassed: true, paidModelCalls: 0 }, null, 2));
} finally { await cleanup(); }
