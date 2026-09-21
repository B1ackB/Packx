import type { MemoryView } from "../src/enterprise/personalMemory";
import type { PlanWorkspace } from "../src/enterprise/agentPlan";
import type { KnowledgeView, PackagingComparisonResult } from "../src/runtime/knowledgeView";
import { readEvents } from "../src/runtime/eventStream";
import { summarizeModelCalls, type ModelTelemetryView } from "../src/runtime/modelTelemetry";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { documentFixture } from "../server/testing/documentFixture";
import { createRequirementBrief, requiredRequirementFacts, type RequirementBriefEvaluation } from "../src/manufacturing/requirementBrief";
import type { ConversationView, RequirementBriefWorkspaceView, RuntimeActivity } from "../src/runtime/conversationContracts";
import type { RequirementDelivery } from "../src/manufacturing/requirementDelivery";
import type { ConversationFilesView, LocalFileLocations } from "../src/runtime/conversationFiles";
import type { AnthropicMessageRequest } from "../server/anthropic/types";
import { FileAgentStateStore } from "../server/runtime/fileAgentStateStore";
import { FileCronScheduleStore } from "../server/enterprise/fileCronScheduleStore";
import { FileEnterpriseEventStore } from "../server/enterprise/fileEventStore";
import { ProposalRunEngine } from "../src/enterprise/proposalRunEngine";

// Deterministic local provider: exercises the real HTTP adapter, never contacts a model vendor.
const directory = mkdtempSync(join(tmpdir(), "blackx-product-smoke-"));
const dataDirectory = join(realpathSync(directory), "state"); mkdirSync(dataDirectory);
const documents = join(realpathSync(directory), "user-documents"); mkdirSync(documents);
const planDocument = join(documents, "plan-output.md");
const localDocument = join(documents, "客户包装需求.md");
const serve = process.argv.includes("--serve");
const settingsPath = resolve(`.packx-settings.json-${crypto.randomUUID()}.fixture`);
const provider = createServer(async (request, response) => {
	const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const body = JSON.parse(Buffer.concat(chunks).toString()) as AnthropicMessageRequest;
	response.setHeader("content-type", "application/json");
	if (request.url?.endsWith("count_tokens")) { response.end(JSON.stringify({ input_tokens: 100 })); return; }
	const blocks = body.messages.flatMap((message) => message.content);
	const last = body.messages.at(-1)?.content ?? [];
	const requirement = body.tools?.some((tool) => tool.name === "project_source_read");
	let content: unknown[];
	const instructions = JSON.stringify(body.system);
	if (instructions.includes("Independently review the candidate")) {
		content = [{ type: "text", text: JSON.stringify({ issues: [] }) }];
	} else if (instructions.includes("Plan only. Do not execute") && JSON.stringify(blocks).includes("plan-write-fixture")) {
		content = [{ type: "text", text: JSON.stringify({ summary: "Create an explicitly approved draft file", tasks: [{ title: "Write draft", objective: "plan-write-fixture", tools: ["file_write"] }] }) }];
	} else if (instructions.includes("Plan only. Do not execute")) {
		content = [{ type: "text", text: JSON.stringify({ summary: "整理包装需求资料，分别核对来源与缺失信息（固定演示计划）。", tasks: [{ title: "来源核对", objective: "汇总包装资料来源并保留未验证状态。", tools: ["file_list"] }, { title: "缺失信息", objective: "列出需要用户确认的包装需求字段。", tools: [] }] }) }];
	} else if (instructions.includes("Execute ONLY this approved subtask") && !last.some((block) => block.type === "tool_result") && JSON.stringify(blocks).includes("plan-write-fixture")) {
		content = [{ type: "tool_use", id: "plan-write", name: "file_write", input: { path: planDocument, expectedSha256: null, content: "Draft from approved plan; facts remain unverified." } }];
	} else if (instructions.includes("Execute ONLY this approved subtask") && body.tools?.some((tool) => tool.name === "file_list") && !last.some((block) => block.type === "tool_result")) {
		content = [{ type: "tool_use", id: "plan-list", name: "file_list", input: {} }];
	} else if (instructions.includes("Execute ONLY this approved subtask")) {
		content = [{ type: "text", text: JSON.stringify({ summary: "已完成本子任务的固定演示输出。数量、尺寸与交期仍待用户确认。", evidence: ["local-fixture：此响应只验证编排链路，不代表真实模型核验。"], limitations: ["未验证生产参数；未写入文件。"], assessment: { decision: "continue", reason: "已完成固定演示任务，业务事实仍待确认。" } }) }];
	} else if (JSON.stringify(last).includes("memory-propose-fixture") && !last.some((block) => block.type === "tool_result")) {
		content = [{ type: "tool_use", id: "memory-candidate", name: "memory_propose", input: { sourceMessageId: "memory-propose-source", topic: "报告偏好", content: "请用简洁中文列出未解决问题。" } }];
	} else if (last.some((block) => block.type === "tool_result" && block.tool_use_id === "memory-candidate")) {
		content = [{ type: "text", text: "候选已提交，请到个人记忆面板确认。" }];
	} else if (requirement && !last.some((block) => block.type === "tool_result")) {
		const system = JSON.stringify(body.system);
		const ids = [...new Set(system.match(/attachment-[a-f0-9]+/g) ?? [])];
		content = [{ type: "tool_use", id: `source-${Date.now()}`, name: "project_source_read", input: { sourceId: "customer-brief" } }, ...ids.map((attachmentId) => ({ type: "tool_use", id: `inspect-${attachmentId}-${Date.now()}`, name: "asset_metadata_inspect", input: { attachmentId } }))];
	} else if (requirement) {
		const raw = JSON.stringify(blocks);
		const sourceRef = raw.match(/attachment:\/\/[^\s"\\]+/g)?.[0]?.replace(/#page=\d+$/, "") ?? "runtime:fixture";
		const values: Record<string, string | number> = { product_type: "咖啡豆自立袋", quantity: 5000, dimensions: "160 × 230 + 80 mm", target_market: "香港", target_delivery: "2026-11-30", delivery_location: "香港九龙", artwork_status: "品牌稿待提供" };
		content = [{ type: "text", text: JSON.stringify(createRequirementBrief({ industry: "print", title: "咖啡包装需求单", customerGoal: "整理客户资料，确认数量、尺寸与交付要求。", facts: requiredRequirementFacts.print.map((key) => ({ key, version: 1, value: values[key]!, status: "unverified", sourceType: "model_output", sourceRef: `${sourceRef}#page=1` })) })) }];
	} else if (JSON.stringify(last).includes("Attached source references") && !last.some((block) => block.type === "tool_result")) {
		const id = JSON.stringify(last).match(/attachment-[a-f0-9]+/)?.[0];
		content = [{ type: "tool_use", id: "document-read", name: "document_read", input: { attachmentId: id } }];
	} else if (last.some((block) => block.type === "tool_result" && block.tool_use_id === "document-read")) {
		const result = last.find((block) => block.type === "tool_result");
		const parsed = JSON.parse(JSON.parse(result!.type === "tool_result" ? result!.content : "{}").stdout.text);
		content = [{ type: "text", text: `Read ${parsed.name} (${parsed.inspection.status}).\n\n${parsed.inspection.pages.map((page: { text: string }) => page.text).join("\n")}\n\nValues remain unverified until you confirm them.` }];
	} else if (JSON.stringify(last).includes("本地文件测试") && !last.some((block) => block.type === "tool_result")) {
		const remove = JSON.stringify(last).includes("删除");
		const previous = existsSync(localDocument) ? readFileSync(localDocument, "utf8") : undefined;
		content = [...(previous !== undefined ? [{ type: "tool_use", id: "local-read", name: "file_read", input: { path: localDocument } }] : []), { type: "tool_use", id: "local-mutate", name: remove ? "file_delete" : "file_write", input: { path: localDocument, expectedSha256: previous === undefined ? null : createHash("sha256").update(previous).digest("hex"), ...(remove ? {} : { content: "# 已审批的包装需求\n客户尺寸仍待确认。" }) } }];
	} else if (JSON.stringify(last).includes("文件读取测试") && !last.some((block) => block.type === "tool_result")) {
		content = [{ type: "tool_use", id: "file-list", name: "file_list", input: {} }, { type: "tool_use", id: "file-read", name: "file_read", input: { path: "包装方案.md" } }];
	} else if (JSON.stringify(last).includes("文件操作测试") && !last.some((block) => block.type === "tool_result")) {
		const text = JSON.stringify(last);
		const remove = text.includes("删除");
		const overwrite = text.includes("覆盖");
		content = [{ type: "tool_use", id: `file-${Date.now()}`, name: remove ? "file_delete" : "file_write", input: { path: "包装方案.md", expectedVersion: remove ? 2 : overwrite ? 1 : null, ...(remove ? {} : { content: overwrite ? "# 包装方案 v2\n待用户核对尺寸。" : "# 包装方案 v1\n模型建议，待确认。" }) } }];
	} else if (JSON.stringify(last).includes("定时任务删除回归") && !last.some((block) => block.type === "tool_result")) {
		content = [{ type: "tool_use", id: "cron-delete-test", name: "cron_create", input: { name: "删除回归", expression: "*/5 * * * *", timezone: "Asia/Hong_Kong", prompt: "汇总需求", maxRuns: 2 } }];
	} else {
		const text = JSON.stringify(last);
		await new Promise((resolve) => setTimeout(resolve, text.includes("停止测试") ? 5000 : 350));
		content = [{ type: "text", text: "## 已收到你的需求\n\n先核对资料中的信息，再生成需求单。\n\n| 项目 | 当前状态 |\n| --- | --- |\n| 附件 | 已保存，生成需求单时解析 |\n| 关键字段 | 等待确认 |\n\n- 核对数量和交付地点\n- 补充设计稿状态\n\n```text\n资料 → 核对 → 生成版本 → 确认交付\n```\n\n这是本地固定测试响应。" }];
	}
	const result = { id: "fixture-response", type: "message", role: "assistant", model: "local-fixture", content, stop_reason: content.some((block) => (block as { type: string }).type === "tool_use") ? "tool_use" : "end_turn", usage: { input_tokens: 100, output_tokens: 80, cache_read_input_tokens: 50, cache_creation_input_tokens: 50 } };
	if (!body.stream) { response.end(JSON.stringify(result)); return; }
	response.setHeader("content-type", "text/event-stream");
	const emit = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
	emit({ type: "message_start", message: { ...result, content: [], stop_reason: null, usage: { ...result.usage, output_tokens: 0 } } });
	for (const [index, raw] of content.entries()) {
		const block = raw as { type: string; text?: string; input?: unknown };
		emit({ type: "content_block_start", index, content_block: block.type === "text" ? { ...block, text: "" } : { ...block, input: {} } });
		const parts = [...(block.text ?? JSON.stringify(block.input))];
		for (let offset = 0; offset < parts.length; offset += 20) {
			emit({ type: "content_block_delta", index, delta: block.type === "text" ? { type: "text_delta", text: parts.slice(offset, offset + 20).join("") } : { type: "input_json_delta", partial_json: parts.slice(offset, offset + 20).join("") } });
			await new Promise((resolve) => setTimeout(resolve, serve ? 40 : 4));
		}
		emit({ type: "content_block_stop", index });
	}
	await new Promise((resolve) => setTimeout(resolve, 150));
	emit({ type: "message_delta", delta: { stop_reason: result.stop_reason }, usage: { output_tokens: 80 } });
	emit({ type: "message_stop" }); response.end();
});
provider.listen(0, "127.0.0.1"); await once(provider, "listening");
const providerPort = (provider.address() as { port: number }).port;
const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
const port = serve ? 5178 : (reservation.address() as { port: number }).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const baseUrl = `http://127.0.0.1:${port}`;
const host = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { env: {
	...process.env, PACKX_SETTINGS_PATH: settingsPath, BLACKX_DATA_ROOT: dataDirectory, BLACKX_PORT: String(port), BLACKX_RUNTIME_MODE: "anthropic", ANTHROPIC_API_KEY: "offline-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${providerPort}`, ANTHROPIC_MODEL: "local-fixture",
	BLACKX_FILE_STORE_PATH: join(dataDirectory, "files"), BLACKX_AGENT_STATE_PATH: join(dataDirectory, "sessions"), BLACKX_EVENT_STORE_PATH: join(dataDirectory, "events.json"), BLACKX_STAGE_JOB_QUEUE_DRIVER: "file", BLACKX_STAGE_JOB_QUEUE_PATH: join(dataDirectory, "queue.json"), BLACKX_CRON_SCHEDULE_PATH: join(dataDirectory, "cron.json"), BLACKX_ATTACHMENT_STORE_PATH: join(dataDirectory, "attachments"), BLACKX_ARTIFACT_STORE_PATH: join(dataDirectory, "artifacts"), BLACKX_INSPECTION_CACHE_PATH: join(dataDirectory, "inspections"), BLACKX_WORKSPACE_ROOT: directory, BLACKX_ENABLE_RUNTIME_EVAL: "0", BLACKX_COMMAND_API_TOKEN: "", BLACKX_WORKER_API_TOKEN: "", BLACKX_OPERATOR_API_TOKEN: "",
}, stdio: ["ignore", "pipe", "pipe"] });
let output = ""; host.stdout.on("data", (chunk) => { output += String(chunk); }); host.stderr.on("data", (chunk) => { output += String(chunk); });
const close = async () => {
	host.kill("SIGTERM");
	if (host.exitCode === null && host.signalCode === null) await once(host, "exit");
	provider.closeAllConnections(); await new Promise<void>((resolve) => provider.close(() => resolve()));
	rmSync(directory, { recursive: true, force: true });
	rmSync(settingsPath, { force: true });
};
process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
try {
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (host.exitCode !== null) throw new Error(`Host exited: ${output}`);
		try { ready = (await fetch(baseUrl)).ok; } catch { /* Starting. */ }
		if (ready) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert(ready, `Host did not start: ${output}`);
	assert.equal((await fetch(baseUrl)).headers.get("x-frame-options"), "DENY");
	assert.equal((await fetch(`${baseUrl}/api/conversations`)).status, 403);
	const session = await fetch(`${baseUrl}/api/local-session`, { headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } }).then((response) => response.json()) as { token: string };
	assert(session.token);
	const headers = { "x-blackx-session-token": session.token };
	for (const extra of [{ origin: "https://evil.test" }, { "x-blackx-tenant-id": "other" }]) assert.equal((await fetch(`${baseUrl}/api/conversations`, { headers: { ...headers, ...extra } })).status, 403);
	assert.equal((await fetch(`${baseUrl}/api/runtime/turn`, { method: "POST", headers })).status, 403);
	async function api<T = { conversation: ConversationView; requirementBrief: RequirementBriefWorkspaceView; delivery: RequirementDelivery; activity?: RuntimeActivity }>(path: string, body?: unknown) {
		const response = await fetch(`${baseUrl}${path}`, { headers: { ...headers, "content-type": "application/json" }, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const value = await response.json(); assert(response.ok, `${path}: ${JSON.stringify(value)}`); return value as T;
	}
	const planId = (await api("/api/conversations", {})).conversation.conversationId;
	const memoryPath = `/api/conversations/${planId}/memory`;
	const proposedMemory = await api<MemoryView>(memoryPath, { action: "propose", requestId: "memory-smoke-propose", draft: { topic: "报告语言", content: "请使用简洁中文。" } });
	const memoryItem = proposedMemory.items[0];
	assert.equal(memoryItem.status, "proposed");
	const memoryConfirm = { action: "confirm", requestId: "memory-smoke-confirm", memoryId: memoryItem.id, revision: memoryItem.revision, confirmed: true };
	const confirmedMemory = await api<MemoryView>(memoryPath, memoryConfirm);
	assert.equal(confirmedMemory.items[0].activeVersion, 1);
	assert.deepEqual(await api<MemoryView>(memoryPath, memoryConfirm), confirmedMemory);
	const memoryTask = (await api("/api/conversations", {})).conversation.conversationId;
	assert.deepEqual(await api<MemoryView>(`/api/conversations/${memoryTask}/memory`), confirmedMemory);
	for (const extra of [{ "x-blackx-actor-id": "other" }, { "x-blackx-workspace-id": "other" }]) assert.equal((await fetch(`${baseUrl}${memoryPath}`, { headers: { ...headers, ...extra } })).status, 403);
	await api<MemoryView>(memoryPath, { action: "forget", requestId: "memory-smoke-forget", memoryId: memoryItem.id, revision: confirmedMemory.items[0].revision });
	assert.equal((await api<MemoryView>(`/api/conversations/${memoryTask}/memory`)).items[0].status, "revoked");
	const memoryTurn = await api(`/api/conversations/${memoryTask}/messages`, { messageId: "memory-propose-source", content: "请长期记住：报告用简洁中文列出未解决问题。memory-propose-fixture" });
	assert(memoryTurn.conversation.messages.at(-1)?.content.includes("请到个人记忆面板确认"));
	const toolMemory = (await api<MemoryView>(memoryPath)).items.find((item) => item.status === "proposed")!;
	assert(toolMemory); assert.equal(toolMemory.activeVersion, undefined);
	assert.equal(toolMemory.versions[0].source.messageId, "memory-propose-source");
	await api<MemoryView>(memoryPath, { action: "reject", requestId: "memory-tool-reject", memoryId: toolMemory.id, revision: toolMemory.revision });
	console.log("PASS: authenticated personal memory API, cross-task confirmation/revoke, command replay, owner spoof denial and real memory_propose Tool candidate without auto-confirmation; local fixture only.");
	const comparisonTask = (await api("/api/conversations", {})).conversation.conversationId;
	const knowledgePath = `/api/conversations/${comparisonTask}/knowledge`;
	await api(`${knowledgePath}/demo`, {});
	let knowledge = await api<KnowledgeView>(knowledgePath);
	for (let i = 0; i < 100 && knowledge.documents.filter((d) => d.status === "indexed").length !== 2; i++) { await new Promise((resolve) => setTimeout(resolve, 100)); knowledge = await api<KnowledgeView>(knowledgePath); }
	assert.equal(knowledge.documents.filter((d) => d.status === "indexed").length, 2);
	const sourceA = knowledge.documents.find((d) => d.manifest.model === "DEMO-PE-A")!, sourceB = knowledge.documents.find((d) => d.manifest.model === "DEMO-PET-B")!;
	const pair = { left: { evidenceId: `${sourceA.versionId}:2`, parameterIndex: 0 }, right: { evidenceId: `${sourceB.versionId}:2`, parameterIndex: 0 }, region: "HK", asOf: "2026-09-17T10:00:00.000Z" };
	const comparable = await api<PackagingComparisonResult>(`${knowledgePath}/compare`, pair);
	assert.equal(comparable.status, "comparable"); assert.equal(comparable.comparison.difference, 0); assert.equal(comparable.conclusionAllowed, false);
	const barrier = await api<PackagingComparisonResult>(`${knowledgePath}/compare`, { ...pair, left: { ...pair.left, parameterIndex: 1 }, right: { ...pair.right, parameterIndex: 1 } });
	assert.equal(barrier.status, "needs_review"); assert(barrier.comparison.reasons.includes("structured_test_conditions_missing"));
	for (const [extraHeaders, body, expectedStatus] of [[{}, { ...pair, originalValue: "invented" }, 400], [{ "x-blackx-tenant-id": "foreign" }, pair, 403]] as const) assert.equal((await fetch(`${baseUrl}${knowledgePath}/compare`, { method: "POST", headers: { ...headers, ...extraHeaders, "content-type": "application/json" }, body: JSON.stringify(body) })).status, expectedStatus);
	await api(`${knowledgePath}/withdraw`, { versionId: sourceB.versionId });
	assert.equal((await fetch(`${baseUrl}${knowledgePath}/compare`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(pair) })).status, 404);
	console.log("PASS: parameter comparison HTTP path, exact citations, equivalent thickness, blocked barrier conditions, injected values, tenant spoofing and source withdrawal; synthetic fixtures only.");
	const planPath = `/api/conversations/${planId}/plan`;
	let planState = (await api<{ plan: PlanWorkspace }>(planPath)).plan;
	const planCommand = async (command: Record<string, unknown>) => {
		planState = (await api<{ plan: PlanWorkspace }>(planPath, { ...command, revision: planState.revision, requestId: crypto.randomUUID() })).plan;
	};
	const awaitPlan = async (status: string) => {
		for (let i = 0; i < 150; i++) {
			planState = (await api<{ plan: PlanWorkspace }>(planPath)).plan;
			if (planState.versions.at(-1)?.status === status) return;
			assert.notEqual(planState.versions.at(-1)?.status, "failed", JSON.stringify(planState));
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`Plan did not reach ${status}`);
	};
	await planCommand({ action: "mode", mode: "plan" });
	await planCommand({ action: "generate", objective: "整理包装需求并列出待确认信息" });
	await awaitPlan("awaiting_confirmation");
	assert.equal(planState.versions[0].children.length, 0);
	const bypass = await fetch(`${baseUrl}/api/conversations/${planId}/messages`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ messageId: "plan-bypass", content: "同意并执行" }) });
	assert.equal(bypass.status, 409);
	await planCommand({ action: "confirm", version: 1, confirmed: true });
	await awaitPlan("completed");
	assert.equal(planState.versions[0].children.length, 2);
	assert.equal(new Set(planState.versions[0].children.map((c) => c.sessionId)).size, 2);
	const planSummary = (await api(`/api/conversations/${planId}`)).conversation;
	assert.equal(planSummary.title, "整理包装需求并列出待确认信息");
	const rename = await fetch(`${baseUrl}/api/conversations/${planId}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "咖啡袋交接计划", nameRevision: planSummary.nameRevision }) });
	assert(rename.ok); assert.equal(((await rename.json()) as { conversation: ConversationView }).conversation.revision, planSummary.revision);
	assert.equal((await api(`/api/conversations/${planId}`)).conversation.title, "咖啡袋交接计划");
	assert.equal((await api<{ plan: PlanWorkspace }>(planPath)).plan.revision, planState.revision);
	const privateSettings = await api<{ revision: number; keyConfigured: boolean; apiKey?: string }>("/api/model-settings");
	assert.equal(privateSettings.keyConfigured, true); assert.equal(privateSettings.apiKey, undefined);
	const saveSettings = await fetch(`${baseUrl}/api/model-settings`, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ revision: privateSettings.revision, mode: "anthropic", baseUrl: `http://127.0.0.1:${providerPort}`, model: "local-fixture", apiKey: "offline-fixture-only" }) });
	assert.equal(saveSettings.status, 200);
	for (const path of [`/${settingsPath.split("/").at(-1)}`, `/@fs${settingsPath}`, `/@fs${dataDirectory}/sessions/plans.sqlite`]) {
		const raw = await fetch(baseUrl + path);
		assert([403, 404].includes(raw.status), `Private file served through frontend: ${path}`);
		assert(!(await raw.text()).includes("offline-fixture-only"));
	}

	assert.equal((await fetch(`${baseUrl}/api/model-settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
	const planBriefPath = `/api/conversations/${planId}/requirement-brief`;
	const importBody = { requestId: "plan-import", industry: "print", planVersion: 1 };
	await api(planBriefPath, importBody);
	await api(planBriefPath, importBody);
	const settlePlanBrief = async () => {
		for (let i = 0; i < 150; i++) {
			const view = (await api(planBriefPath)).requirementBrief;
			assert.notEqual(view.job?.status, "dead_letter", JSON.stringify(view.job));
			if (!["queued", "leased"].includes(view.job?.status ?? "")) return view;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("Plan requirement draft did not settle");
	};
	const imported = await settlePlanBrief();
	assert.equal(imported.state.facts.plan_source.sourceRef, `plan:${planId}:version:1`);
	assert.equal(imported.state.facts.quantity.status, "unverified");
	assert.equal(imported.state.facts.quantity.sourceRef, `plan:${planId}:version:1`);
	assert.equal(imported.state.proposalVersions.length, 1);
	assert.equal((await api(`${planBriefPath}/versions/1`)).delivery.sourcePlan, `plan:${planId}:version:1`);
	if (!serve) {
		await api(`${planBriefPath}/facts`, { requestId: "plan-material", key: "material_structure", value: "模拟材料要求，供演示核对" });
		for (const key of [...requiredRequirementFacts.print, "material_structure"]) await api(`${planBriefPath}/facts/${key}/decision`, { requestId: `plan-confirm-${key}`, decision: "verified" });
		await api(planBriefPath, { ...importBody, requestId: "plan-regenerate" });
		assert.equal((await settlePlanBrief()).state.stageStatus, "waiting_approval");
		await api(`${planBriefPath}/approval`, { requestId: "plan-approve-delivery", decision: "approved" });
		assert.equal((await settlePlanBrief()).state.stageStatus, "passed");
		const delivery = (await api(`${planBriefPath}/versions/2`)).delivery;
		assert.equal(delivery.status, "approved");
		assert.equal(delivery.sourcePlan, `plan:${planId}:version:1`);
		assert(delivery.content.facts.some((fact) => fact.key === "material_structure" && fact.status === "verified"));
		for (const format of ["md", "html", "json"]) {
			const response = await fetch(`${baseUrl}${planBriefPath}/versions/2?format=${format}`, { headers });
			assert(response.ok); assert((await response.text()).includes(`plan:${planId}:version:1`));
		}
	}
	await planCommand({ action: "mode", mode: "execute" });
	if (!serve) {
		await planCommand({ action: "mode", mode: "plan" });
		await planCommand({ action: "generate", objective: "plan-write-fixture: create a packaging draft" });
		await awaitPlan("awaiting_confirmation");
		assert(!existsSync(planDocument));
		await planCommand({ action: "confirm", version: 2, confirmed: true });
		const approval = await pendingFor(`/api/conversations/${planId}`);
		assert(!existsSync(planDocument), "Plan approval must not bypass file approval");
		await api(`/api/conversations/${planId}/files/approvals/${approval.id}`, { decision: "approved" });
		await awaitPlan("completed");
		assert.equal(readFileSync(planDocument, "utf8"), "Draft from approved plan; facts remain unverified.");
		await planCommand({ action: "mode", mode: "execute" });
	}
	console.log("PASS: Plan mode, explicit version confirmation, isolated subagents and persisted results through local HTTP fixture.");
	const id = (await api("/api/conversations", {})).conversation.conversationId as string;
	const path = `/api/conversations/${id}`;
	// Observe real HTTP text before the message POST has completed, with authenticated SSE.
	assert.equal((await fetch(`${baseUrl}${path}/activity?stream=1`)).status, 403);
	const streamController = new AbortController();
	const eventResponse = await fetch(`${baseUrl}${path}/activity?stream=1`, { headers, signal: streamController.signal });
	assert(eventResponse.headers.get("content-type")?.includes("text/event-stream"));
	let firstText!: () => void; const streamed = new Promise<void>((resolve) => { firstText = resolve; });
	const consuming = (async () => { try { for await (const event of readEvents(eventResponse.body!, streamController.signal)) { if (JSON.parse(event.data).activity?.partialText) firstText(); } } catch (error) { if (!streamController.signal.aborted) throw error; } })();
	let completedReply = false;
	const streamedReply = api(`${path}/messages`, { messageId: "stream-1", content: "流式输出测试" }).then(() => { completedReply = true; });
	await Promise.race([streamed, new Promise((_, reject) => setTimeout(() => reject(new Error("No streamed text")), 10_000).unref())]);
	assert.equal(completedReply, false); await streamedReply; streamController.abort(); await consuming;
	async function pendingFor(conversationPath: string) {
		for (let i = 0; i < 100; i++) { const view = await fetch(`${baseUrl}${conversationPath}/files`, { headers }).then((response) => response.json()) as ConversationFilesView; if (view.approvals[0]) return view.approvals[0]; await new Promise((resolve) => setTimeout(resolve, 50)); }
		throw new Error("File approval not requested");
	}
	const createFile = api(`${path}/messages`, { messageId: "file-create", content: "文件操作测试：新建包装方案" });
	await api(`${path}/files/approvals/${(await pendingFor(path)).id}`, { decision: "approved" }); await createFile;
	async function files(): Promise<ConversationFilesView> { return await fetch(`${baseUrl}${path}/files`, { headers }).then((response) => response.json()) as ConversationFilesView; }
	assert.equal((await files()).files[0]?.version, 1);
	await api(`${path}/messages`, { messageId: "file-read", content: "文件读取测试：读取包装方案" });
	assert.equal((await fetch(`${baseUrl}${path}/files`)).status, 403);
	if (!serve) {
	const otherId = (await api("/api/conversations", {})).conversation.conversationId;
	const otherCreate = api(`/api/conversations/${otherId}/messages`, { messageId: "file-create", content: "文件操作测试：新建包装方案" });
	await api(`/api/conversations/${otherId}/files/approvals/${(await pendingFor(`/api/conversations/${otherId}`)).id}`, { decision: "approved" }); await otherCreate;
	const otherFiles = await fetch(`${baseUrl}/api/conversations/${otherId}/files`, { headers }).then((response) => response.json()) as ConversationFilesView;
	assert.equal(otherFiles.files[0]?.version, 1, "same message id in another conversation must create an independent file");
	await fetch(`${baseUrl}/api/conversations/${otherId}`, { method: "DELETE", headers });
	async function pendingFile() {
		for (let i = 0; i < 100; i++) { const pending = (await files()).approvals[0]; if (pending) return pending; await new Promise((resolve) => setTimeout(resolve, 50)); }
		throw new Error("File approval not requested");
	}
	const overwrite = api(`${path}/messages`, { messageId: "file-overwrite", content: "文件操作测试：覆盖包装方案" });
	const review = await pendingFile();
	assert.equal((await files()).files.length, 1);
	assert.equal(review.before, "# 包装方案 v1\n模型建议，待确认。");
	const reviewUrl = `${path}/files/approvals/${review.id}`;
	assert.equal((await fetch(`${baseUrl}${reviewUrl}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approved" }) })).status, 403);
	await api(reviewUrl, { decision: "approved" }); await overwrite;
	assert.equal((await files()).files.at(-1)?.version, 2);
	const rejectDelete = api(`${path}/messages`, { messageId: "file-reject", content: "文件操作测试：删除包装方案" });
	await api(`${path}/files/approvals/${(await pendingFile()).id}`, { decision: "rejected" }); await rejectDelete;
	assert.equal((await files()).files.at(-1)?.status, "draft");
	const stopDelete = api(`${path}/messages`, { messageId: "file-stop", content: "文件操作测试：删除包装方案" }).catch((error: unknown) => error);
	const stoppedApproval = await pendingFile();
	await api(`${path}/stop`, {}); assert(await stopDelete instanceof Error);
	assert.equal((await fetch(`${baseUrl}${path}/files/approvals/${stoppedApproval.id}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ decision: "approved" }) })).status, 409);
	const remove = api(`${path}/messages`, { messageId: "file-delete", content: "文件操作测试：删除包装方案" });
	await api(`${path}/files/approvals/${(await pendingFile()).id}`, { decision: "approved" }); await remove;
	assert.equal((await files()).files.at(-1)?.status, "deleted");
	const oldVersion = await fetch(`${baseUrl}${path}/files/content?path=${encodeURIComponent("包装方案.md")}&version=1`, { headers }).then((response) => response.json()) as { content: string };
	assert.equal(oldVersion.content, "# 包装方案 v1\n模型建议，待确认。");
	assert.equal((await fetch(`${baseUrl}${path}/files/directories`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: documents }) })).status, 403);
	assert.equal((await fetch(`${baseUrl}${path}/files/directories?path=${encodeURIComponent(documents)}`, { headers })).status, 200);
	assert.equal((await fetch(`${baseUrl}${path}/files/directories`, { method: "POST", headers, body: JSON.stringify({ path: documents }) })).status, 410);
	const localCreate = api(`${path}/messages`, { messageId: "local-create", content: "本地文件测试：新建" });
	const localReview = await pendingFor(path); assert.equal(localReview.path, localDocument); assert(!existsSync(localDocument));
	await api(`${path}/files/approvals/${localReview.id}`, { decision: "approved" }); await localCreate;
	assert(readFileSync(localDocument, "utf8").includes("已审批"));
	writeFileSync(localDocument, "客户手工调整的原文");
	const localWrite = api(`${path}/messages`, { messageId: "local-write", content: "本地文件测试：修改" });
	const localChange = await pendingFor(path); assert.equal(localChange.before, "客户手工调整的原文");
	await api(`${path}/files/approvals/${localChange.id}`, { decision: "approved" }); await localWrite;
	assert(readFileSync(localDocument, "utf8").includes("已审批"));
	const localDelete = api(`${path}/messages`, { messageId: "local-delete", content: "本地文件测试：删除" });
	await api(`${path}/files/approvals/${(await pendingFor(path)).id}`, { decision: "approved" }); await localDelete;
	assert(!existsSync(localDocument));
	const backup = await fetch(`${baseUrl}${path}/files/content?${new URLSearchParams({ path: localDocument, version: "2" })}`, { headers }).then((response) => response.json()) as { content: string };
	assert.equal(backup.content, "客户手工调整的原文");
	assert.equal((await fetch(`${baseUrl}${path}/files/directories/retired-grant`, { method: "DELETE", headers })).status, 410);
	assert.equal((await fetch(`${baseUrl}${path}/files/directories?path=${encodeURIComponent(documents)}`, { headers })).status, 200);
	}
	await api(`${path}/messages`, { messageId: "smoke-message", content: "需要 5000 个咖啡豆包装袋，资料见附件。" });
	const pdf = documentFixture(); writeFileSync(join(directory, "customer.pdf"), pdf);
	const upload = await fetch(`${baseUrl}${path}/attachments?requestId=smoke-upload&name=customer.pdf`, { method: "POST", headers: { ...headers, "content-type": "application/pdf" }, body: pdf });
	assert(upload.ok);
	const attachment = (await upload.json() as { attachment: { attachmentId: string } }).attachment;
	const start = await api(`${path}/requirement-brief`, { requestId: "smoke-start", industry: "print" }); assert(start.requirementBrief.runId);
	async function settled(): Promise<RequirementBriefWorkspaceView> {
		for (let attempt = 0; attempt < 150; attempt++) {
			const view = (await api(`${path}/requirement-brief`)).requirementBrief as RequirementBriefWorkspaceView;
			assert.notEqual(view.job?.status, "dead_letter", JSON.stringify(view.job?.lastFailure));
			if (!["queued", "leased"].includes(view.job?.status ?? "")) return view;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("Workflow did not finish");
	}
	const draft = await settled(); assert.equal(draft.state.stageStatus, "needs_input");
	const review = (draft.evaluation?.report as RequirementBriefEvaluation).evidenceReview;
	assert.equal(review?.status, "completed"); assert.equal(review?.artifactVersion, 1);
	assert(review.sourceVersions.some((source) => source.ref.includes("#page=1")));
	const v1 = await api(`${path}/requirement-brief/versions/1`); assert.equal(v1.delivery.sources[0].inspection.status, "parsed"); assert.equal(v1.delivery.status, "draft");
	assert.equal((await api<LocalFileLocations>(`${path}/files/directories`)).locations.workingDirectory, realpathSync(directory));
	const metrics = await api<ModelTelemetryView>(`${path}/model-calls`);
	assert(metrics.calls.some((call) => call.kind === "count_tokens"));
	assert(metrics.calls.some((call) => call.kind === "generate" && call.status === "succeeded" && call.response?.model === "local-fixture"));
	assert.equal(summarizeModelCalls(metrics.calls).cacheHitRate, 0.25);
	const workflowMetrics = await api<ModelTelemetryView>(`${path}/model-calls?run=requirement`);
	assert(workflowMetrics.calls.length > 0);
	assert(workflowMetrics.calls.every((call) => !metrics.calls.some((other) => other.id === call.id)));
	assert.equal((await fetch(`${baseUrl}${path}/model-calls`)).status, 403);
	assert.equal((await fetch(`${baseUrl}${path}/model-calls`, { headers: { ...headers, "x-blackx-tenant-id": "other" } })).status, 403);
	assert(!JSON.stringify(metrics).includes("offline-fixture-only"));

	if (serve) {
		for (const name of ["packaging.docx", "packaging.xlsx"]) writeFileSync(join(documents, name), readFileSync(`server/testing/documents/${name}`));
		writeFileSync(localDocument, "# 客户包装需求\n客户原文，尚未被 Agent 修改。");
		console.log(JSON.stringify({ mode: "offline-browser-fixture", url: baseUrl, conversationId: id, fixtureDirectory: directory, localDirectory: documents, checks: "auth + real native PDF slice passed; draft ready" }));
		await new Promise(() => {});
	} else {
		for (const key of requiredRequirementFacts.print) await api(`${path}/requirement-brief/facts/${key}/decision`, { requestId: `verify-${key}`, decision: "verified" });
		await api(`${path}/requirement-brief`, { requestId: "smoke-revise", industry: "print" });
		assert.equal((await settled()).state.stageStatus, "waiting_approval");
		await api(`${path}/requirement-brief/approval`, { requestId: "smoke-approve", decision: "approved" });
		assert.equal((await settled()).state.stageStatus, "passed");
		assert.equal((await api(`${path}/requirement-brief/versions/1`)).delivery.status, "stale");
		assert.equal((await api(`${path}/requirement-brief/versions/2`)).delivery.status, "approved");
		for (const format of ["md", "html", "json"]) { const response = await fetch(`${baseUrl}${path}/requirement-brief/versions/2?format=${format}`, { headers }); assert(response.ok); assert((await response.text()).includes("5000")); }
		const pending = api(`${path}/messages`, { messageId: "cancel-message", content: "停止测试" }).catch((error: unknown) => error);
		for (let attempt = 0; attempt < 40; attempt++) { if ((await api(`${path}/activity`)).activity?.phase === "model") break; await new Promise((resolve) => setTimeout(resolve, 50)); }
		await api(`${path}/stop`, {}); assert(await pending instanceof Error);
		assert.equal((await api(path)).conversation.messages.at(-1)?.role, "user");
		assert((await api<ModelTelemetryView>(`${path}/model-calls`)).calls.some((call) => call.status === "cancelled"));
		await api(`${path}/messages`, { messageId: "cron-delete", content: "定时任务删除回归：香港时区，每5分钟汇总需求，执行2次。" });
		const schedules = new FileCronScheduleStore(join(dataDirectory, "cron.json"));
		assert.equal(schedules.list({ tenantId: "local-user", workspaceId: "default-workspace" }).filter((schedule) => schedule.runId === id && schedule.status === "active").length, 1);
		const deletingTurn = api(`${path}/messages`, { messageId: "delete-message", content: "停止测试，删除运行中的会话" }).catch((error: unknown) => error);
		for (let attempt = 0; attempt < 40; attempt++) { if ((await api(`${path}/activity`)).activity?.phase === "model") break; await new Promise((resolve) => setTimeout(resolve, 50)); }
		const background = await fetch(`${baseUrl}${path}/background-tasks`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ messageId: "delete-background", content: "删除后不应继续" }) });
		assert.equal(background.status, 202);
		const task = (await background.json() as { task: { taskId: string } }).task;
		assert.equal((await fetch(`${baseUrl}${path}`, { method: "DELETE" })).status, 403);
		const deletion = await fetch(`${baseUrl}${path}`, { method: "DELETE", headers });
		assert.equal(deletion.status, 200); const deletionBody = await deletion.json();
		assert.deepEqual(await fetch(`${baseUrl}${path}`, { method: "DELETE", headers }).then((response) => response.json()), deletionBody);
		assert(await deletingTurn instanceof Error);
		for (const suffix of ["", "/files", "/files/content?path=anything.md", "/attachments", `/attachments/${attachment.attachmentId}/content`, "/traces", "/activity", "/model-calls", "/model-calls?run=requirement", "/background-tasks", "/cron-schedules", "/requirement-brief", "/requirement-brief/versions/2", "/proposal"]) assert.equal((await fetch(`${baseUrl}${path}${suffix}`, { headers })).status, 404, suffix);
		assert.equal((await fetch(`${baseUrl}/api/background-tasks/${task.taskId}`, { headers })).status, 404);
		assert.equal((await fetch(`${baseUrl}${path}/messages`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ messageId: "after-delete", content: "hello" }) })).status, 404);
		const remaining = await fetch(`${baseUrl}/api/conversations`, { headers }).then((response) => response.json()) as { conversations: ConversationView[] };
		assert(!remaining.conversations.some((conversation) => conversation.conversationId === id));
		const persisted = new FileAgentStateStore(join(dataDirectory, "sessions"));
		assert.equal(persisted.getSession({ tenantId: "local-user", workspaceId: "default-workspace", runId: id, sessionId: id }), undefined);
		assert(schedules.list({ tenantId: "local-user", workspaceId: "default-workspace" }).every((schedule) => schedule.status === "paused"));
		const retained = new ProposalRunEngine(new FileEnterpriseEventStore(join(dataDirectory, "events.json")), "requirement-brief").load({ tenantId: "local-user", workspaceId: "default-workspace", runId: start.requirementBrief.runId });
		assert.equal(retained.stageStatus, "passed"); assert.equal(retained.approval?.status, "approved");
		console.log("PASS: authenticated live SSE before completion, durable scoped model calls, cache usage, cancellation telemetry, Agent-triggered per-operation approval without directory grants, approved creation/modification/deletion at absolute paths, original-content backups, retired grant APIs, all-write approval, scoped history, same-message isolation, native PDF slice, workflow approval/exports, cancellation, conversation deletion and audit retention; provider = local deterministic fixture.");
	}
} finally { await close(); }
