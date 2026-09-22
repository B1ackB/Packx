import type { ModelSettingsInput, ModelSettingsView } from "./modelSettings";
import type { PlanWorkspace } from "../enterprise/agentPlan";
import { readEvents } from "./eventStream";
import type { ModelTelemetryView } from "./modelTelemetry";
import type { RuntimeHealth } from "./contracts";
import type { ConversationFilesView, TaskFileVersion, LocalDirectoryListing, LocalFileLocations } from "./conversationFiles";
import type { RequirementDelivery } from "../manufacturing/requirementDelivery";
import type { RuntimeActivity } from "./conversationContracts";
import type { RuntimeTraceRecord } from "./contracts";
import type { Language } from "../i18n";
import type {
	BackgroundTaskView,
	ConversationAttachment,
	ConversationSummary,
	ConversationView,
	CronScheduleView,
	ProposalWorkspaceView,
	RequirementBriefMetricsSeriesView,
	RequirementBriefWorkspaceView,
} from "./conversationContracts";

interface ErrorPayload {
	code?: string;
	message?: string;
}

export class ConversationClientError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "ConversationClientError";
	}
}

let localSession: Promise<{ token: string }> | undefined;
async function accessHeaders(): Promise<Record<string, string>> {
	localSession ??= fetch("/api/local-session", { cache: "no-store" }).then(async (response) => {
		if (!response.ok) throw new ConversationClientError("local_access_denied", "无法建立本地会话，请使用服务端显示的本机地址。");
		return response.json() as Promise<{ token: string }>;
	}).catch((error) => { localSession = undefined; throw error; });
	return { "x-blackx-session-token": (await localSession).token };
}

async function request<Value>(path: string, init?: RequestInit): Promise<Value> {
	let response: Response;
	try {
		response = await fetch(path, {
			...init,
			headers: {
				...await accessHeaders(),
				...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
				...init?.headers,
			},
		});
	} catch (error) {
		throw new ConversationClientError("runtime_unavailable", "无法连接 Packx 服务端");
	}
	if (!response.ok) {
		const payload = await response.json().catch(() => ({})) as ErrorPayload;
		throw new ConversationClientError(
			payload.code ?? "request_failed",
			payload.message ?? `请求失败（HTTP ${response.status}）`,
		);
	}
	return response.json() as Promise<Value>;
}

async function attachmentRequest(path: string, init?: RequestInit): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(path, {
			...init,
			headers: { ...await accessHeaders(), ...init?.headers },
		});
	} catch {
		throw new ConversationClientError("runtime_unavailable", "无法连接 Packx 服务端");
	}
	if (!response.ok) {
		const payload = await response.json().catch(() => ({})) as ErrorPayload;
		throw new ConversationClientError(
			payload.code ?? "attachment_failed",
			payload.message ?? `附件请求失败（HTTP ${response.status}）`,
		);
	}
	return response;
}

export class ConversationClient {
	taskCheckpoint(conversationId: string) { return request<import("../enterprise/taskCheckpoint").TaskCheckpointView>(`/api/conversations/${encodeURIComponent(conversationId)}/task-checkpoint`); }
	taskCheckpointCommand(conversationId: string, payload: unknown) { return request<import("../enterprise/taskCheckpoint").TaskCheckpointView>(`/api/conversations/${encodeURIComponent(conversationId)}/task-checkpoint`, { method: "POST", body: JSON.stringify(payload) }); }
	personalMemory(conversationId: string) { return request<import("../enterprise/personalMemory").MemoryView>(`/api/conversations/${encodeURIComponent(conversationId)}/memory`); }
	memoryCommand(conversationId: string, payload: unknown) { return request<import("../enterprise/personalMemory").MemoryView>(`/api/conversations/${encodeURIComponent(conversationId)}/memory`, { method: "POST", body: JSON.stringify(payload) }); }
	knowledge(conversationId: string) { return request<import("./knowledgeView").KnowledgeView>(`/api/conversations/${encodeURIComponent(conversationId)}/knowledge`); }
	searchKnowledge(conversationId: string, query: import("../enterprise/knowledge").KnowledgeQuery) { return request<import("./knowledgeView").KnowledgeSearchView>(`/api/conversations/${encodeURIComponent(conversationId)}/knowledge/search`, { method: "POST", body: JSON.stringify(query) }); }
	findCoffeeProducts(conversationId: string, query: string) { return request<import("./knowledgeView").KnowledgeSearchView>(`/api/conversations/${encodeURIComponent(conversationId)}/knowledge/products`, { method: "POST", body: JSON.stringify({ query }) }); }
	compareKnowledge(conversationId: string, input: import("./knowledgeView").PackagingComparisonInput) { return request<import("./knowledgeView").PackagingComparisonResult>(`/api/conversations/${encodeURIComponent(conversationId)}/knowledge/compare`, { method: "POST", body: JSON.stringify(input) }); }
	knowledgeCommand(conversationId: string, action: string, payload: unknown) { return request<unknown>(`/api/conversations/${encodeURIComponent(conversationId)}/knowledge/${action}`, { method: "POST", body: JSON.stringify(payload) }); }
	modelSettings() { return request<ModelSettingsView>("/api/model-settings"); }
	saveModelSettings(value: ModelSettingsInput) { return request<ModelSettingsView>("/api/model-settings", { method: "PUT", body: JSON.stringify(value) }); }
	async rename(conversationId: string, name: string, nameRevision: number, language: Language) {
		const result = await request<{ conversation: ConversationView }>(`/api/conversations/${encodeURIComponent(conversationId)}?language=${language}`, { method: "PATCH", body: JSON.stringify({ name, nameRevision }) });
		return result.conversation;
	}

	async watchActivity(conversationId: string, onActivity: (activity?: RuntimeActivity) => void, signal: AbortSignal): Promise<void> {
		const response = await attachmentRequest(`/api/conversations/${encodeURIComponent(conversationId)}/activity?stream=1`, { signal, headers: { accept: "text/event-stream" } });
		if (!response.body) throw new ConversationClientError("stream_unavailable", "Missing response stream");
		for await (const event of readEvents(response.body, signal)) onActivity(JSON.parse(event.data).activity ?? undefined);
	}

	modelCalls(conversationId: string, requirement = false): Promise<ModelTelemetryView> {
		return request(`/api/conversations/${encodeURIComponent(conversationId)}/model-calls${requirement ? "?run=requirement" : ""}`);
	}
	fileLocations(conversationId: string): Promise<LocalFileLocations> {
		return request(`/api/conversations/${encodeURIComponent(conversationId)}/files/directories`);
	}
	browseDirectory(conversationId: string, path: string): Promise<LocalDirectoryListing> {
		return request(`/api/conversations/${encodeURIComponent(conversationId)}/files/directories?${new URLSearchParams({ path })}`);
	}
	async readDocument(conversationId: string, path: string) {
		return (await request<{ document: import("./assetInspection").AssetInspectionRecord }>(`/api/conversations/${encodeURIComponent(conversationId)}/files/document-content?${new URLSearchParams({ path })}`)).document;
	}
	readLocalFile(conversationId: string, path: string): Promise<{ absolutePath: string; content: string; sha256: string }> {
		return request(`/api/conversations/${encodeURIComponent(conversationId)}/files/local-content?${new URLSearchParams({ path })}`);
	}
	files(conversationId: string): Promise<ConversationFilesView> {
		return request(`/api/conversations/${encodeURIComponent(conversationId)}/files`);
	}
	readFile(conversationId: string, path: string, version: number): Promise<{ file: TaskFileVersion; content: string }> {
		return request(`/api/conversations/${encodeURIComponent(conversationId)}/files/content?${new URLSearchParams({ path, version: String(version) })}`);
	}
	decideFile(conversationId: string, approvalId: string, decision: "approved" | "rejected"): Promise<ConversationFilesView> {
		return request(`/api/conversations/${encodeURIComponent(conversationId)}/files/approvals/${encodeURIComponent(approvalId)}`, { method: "POST", body: JSON.stringify({ decision }) });
	}
	async delete(conversationId: string): Promise<void> {
		await request(`/api/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
	}

	async stop(conversationId: string): Promise<void> {
		await request(`/api/conversations/${encodeURIComponent(conversationId)}/stop`, { method: "POST" });
	}

	async retry(conversationId: string): Promise<ConversationView> {
		return (await request<{ conversation: ConversationView }>(`/api/conversations/${encodeURIComponent(conversationId)}/retry`, { method: "POST" })).conversation;
	}

	async activity(conversationId: string, requirement = false): Promise<RuntimeActivity | undefined> {
		return (await request<{ activity?: RuntimeActivity }>(`/api/conversations/${encodeURIComponent(conversationId)}/activity${requirement ? "?run=requirement" : ""}`)).activity;
	}

	async delivery(conversationId: string, version: number): Promise<RequirementDelivery> {
		return (await request<{ delivery: RequirementDelivery }>(`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief/versions/${version}`)).delivery;
	}

	async exportDelivery(conversationId: string, version: number, format: "md" | "html" | "json", language: Language = "zh"): Promise<Blob> {
		const response = await attachmentRequest(`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief/versions/${version}?format=${format}&language=${language}`);
		return response.blob();
	}

	health(): Promise<RuntimeHealth> {
		return request<RuntimeHealth>("/api/runtime/health");
	}

	async list(language: Language = "zh"): Promise<ConversationSummary[]> {
		return (await request<{ conversations: ConversationSummary[] }>(`/api/conversations?language=${language}`)).conversations;
	}

	async create(language: Language = "zh"): Promise<ConversationView> {
		return (await request<{ conversation: ConversationView }>("/api/conversations", {
			method: "POST",
			body: JSON.stringify({ language }),
		})).conversation;
	}

	async get(conversationId: string, language: Language = "zh"): Promise<ConversationView> {
		return (await request<{ conversation: ConversationView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}?language=${language}`,
		)).conversation;
	}

	async listAttachments(conversationId: string): Promise<ConversationAttachment[]> {
		return (await request<{ attachments: ConversationAttachment[] }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/attachments`,
		)).attachments;
	}

	async uploadAttachment(
		conversationId: string,
		requestId: string,
		file: File,
	): Promise<ConversationAttachment> {
		const query = new URLSearchParams({ requestId, name: file.name });
		const response = await attachmentRequest(
			`/api/conversations/${encodeURIComponent(conversationId)}/attachments?${query}`,
			{
				method: "POST",
				body: file,
				headers: { "content-type": file.type || "application/octet-stream" },
			},
		);
		return ((await response.json()) as { attachment: ConversationAttachment }).attachment;
	}

	async readAttachment(conversationId: string, attachmentId: string): Promise<Blob> {
		const response = await attachmentRequest(
			`/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}/content`,
		);
		return response.blob();
	}

	async listTraces(conversationId: string): Promise<RuntimeTraceRecord[]> {
		return (await request<{ traces: RuntimeTraceRecord[] }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/traces`,
		)).traces;
	}

	async getPlan(conversationId: string): Promise<PlanWorkspace> {
		return (await request<{ plan: PlanWorkspace }>(`/api/conversations/${encodeURIComponent(conversationId)}/plan`)).plan;
	}

	async planCommand(conversationId: string, command: Record<string, unknown>): Promise<PlanWorkspace> {
		return (await request<{ plan: PlanWorkspace }>(`/api/conversations/${encodeURIComponent(conversationId)}/plan`, { method: "POST", body: JSON.stringify(command) })).plan;
	}

	async send(
		conversationId: string,
		message: { messageId: string; content: string; attachmentIds?: string[] },
	): Promise<ConversationView> {
		return (await request<{ conversation: ConversationView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/messages`,
			{ method: "POST", body: JSON.stringify(message) },
		)).conversation;
	}

	async createBackgroundTask(
		conversationId: string,
		message: { messageId: string; content: string },
	): Promise<BackgroundTaskView> {
		return (await request<{ task: BackgroundTaskView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/background-tasks`,
			{ method: "POST", body: JSON.stringify(message) },
		)).task;
	}

	async listBackgroundTasks(conversationId: string): Promise<BackgroundTaskView[]> {
		return (await request<{ tasks: BackgroundTaskView[] }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/background-tasks`,
		)).tasks;
	}

	async getBackgroundTask(taskId: string): Promise<BackgroundTaskView> {
		return (await request<{ task: BackgroundTaskView }>(
			`/api/background-tasks/${encodeURIComponent(taskId)}`,
		)).task;
	}

	async listCronSchedules(conversationId: string): Promise<CronScheduleView[]> {
		return (await request<{ schedules: CronScheduleView[] }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/cron-schedules`,
		)).schedules;
	}

	async getProposal(conversationId: string): Promise<ProposalWorkspaceView | null> {
		return (await request<{ proposal: ProposalWorkspaceView | null }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/proposal`,
		)).proposal;
	}

	async startProposal(conversationId: string, requestId: string): Promise<ProposalWorkspaceView> {
		return (await request<{ proposal: ProposalWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/proposal`,
			{ method: "POST", body: JSON.stringify({ requestId }) },
		)).proposal;
	}

	async recordProposalFact(
		conversationId: string,
		requestId: string,
		fact: { key: string; value: string | number | boolean; unit?: string },
	): Promise<ProposalWorkspaceView> {
		return (await request<{ proposal: ProposalWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/proposal/facts`,
			{ method: "POST", body: JSON.stringify({ requestId, ...fact }) },
		)).proposal;
	}

	async resolveProposalFact(
		conversationId: string,
		factKey: string,
		requestId: string,
		decision: "verified" | "rejected",
	): Promise<ProposalWorkspaceView> {
		return (await request<{ proposal: ProposalWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/proposal/facts/${encodeURIComponent(factKey)}/decision`,
			{ method: "POST", body: JSON.stringify({ requestId, decision }) },
		)).proposal;
	}

	async resolveProposalApproval(
		conversationId: string,
		requestId: string,
		decision: "approved" | "rejected",
	): Promise<ProposalWorkspaceView> {
		return (await request<{ proposal: ProposalWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/proposal/approval`,
			{ method: "POST", body: JSON.stringify({ requestId, decision }) },
		)).proposal;
	}

	async getRequirementBrief(conversationId: string): Promise<RequirementBriefWorkspaceView | null> {
		return (await request<{ requirementBrief: RequirementBriefWorkspaceView | null }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief`,
		)).requirementBrief;
	}

	async getRequirementBriefMetrics(): Promise<RequirementBriefMetricsSeriesView> {
		return (await request<{ requirementBriefMetrics: RequirementBriefMetricsSeriesView }>(
			"/api/requirement-brief/metrics",
		)).requirementBriefMetrics;
	}

	async startRequirementBrief(
		conversationId: string,
		requestId: string,
		planVersion?: number,
	): Promise<RequirementBriefWorkspaceView> {
		return (await request<{ requirementBrief: RequirementBriefWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief`,
			{ method: "POST", body: JSON.stringify({ requestId, industry: "print", planVersion }) },
		)).requirementBrief;
	}

	async recordRequirementFact(
		conversationId: string,
		requestId: string,
		fact: { key: string; value: string | number | boolean; unit?: string },
	): Promise<RequirementBriefWorkspaceView> {
		return (await request<{ requirementBrief: RequirementBriefWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief/facts`,
			{ method: "POST", body: JSON.stringify({ requestId, ...fact }) },
		)).requirementBrief;
	}

	async resolveRequirementFact(
		conversationId: string,
		factKey: string,
		requestId: string,
		decision: "verified" | "rejected",
	): Promise<RequirementBriefWorkspaceView> {
		return (await request<{ requirementBrief: RequirementBriefWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief/facts/${encodeURIComponent(factKey)}/decision`,
			{ method: "POST", body: JSON.stringify({ requestId, decision }) },
		)).requirementBrief;
	}

	async resolveRequirementApproval(
		conversationId: string,
		requestId: string,
		decision: "approved" | "rejected",
	): Promise<RequirementBriefWorkspaceView> {
		return (await request<{ requirementBrief: RequirementBriefWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief/approval`,
			{ method: "POST", body: JSON.stringify({ requestId, decision }) },
		)).requirementBrief;
	}

	async cancelRequirementBrief(
		conversationId: string,
		requestId: string,
	): Promise<RequirementBriefWorkspaceView> {
		return (await request<{ requirementBrief: RequirementBriefWorkspaceView }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/requirement-brief/cancel`,
			{ method: "POST", body: JSON.stringify({ requestId }) },
		)).requirementBrief;
	}
}
