import { createHash } from "node:crypto";
import { StageJobQueueError, type StageJob, type StageJobQueue } from "../../src/enterprise/stageJobQueue";
import type { AgentRuntimePort } from "../../src/runtime/contracts";
import type { BackgroundTaskView } from "../../src/runtime/conversationContracts";
import type { ConversationApiContext, ConversationApiResponse } from "../runtime/conversationApi";
import { ConversationApiController } from "../runtime/conversationApi";

class BackgroundTaskValidationError extends Error {}

function id(value: unknown, name: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new BackgroundTaskValidationError(`${name} is invalid`);
	}
	return value;
}

function text(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 32_000) {
		throw new BackgroundTaskValidationError("message content is invalid");
	}
	return value.trim();
}

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function backgroundTaskView(job: StageJob): BackgroundTaskView {
	const messageId = typeof job.payload?.messageId === "string" ? job.payload.messageId : job.commandId;
	return {
		taskId: job.jobId,
		conversationId: job.runId,
		messageId,
		status: job.status,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		deliveryCount: job.deliveryCount,
		failureCount: job.failureCount,
		...(job.lastFailure ? { lastFailure: job.lastFailure } : {}),
	};
}

function taskId(
	context: { tenantId: string; workspaceId: string },
	conversationId: string,
	messageId: string,
): string {
	const digest = createHash("sha256")
		.update(`${context.tenantId}\u0000${context.workspaceId}\u0000${conversationId}\u0000${messageId}`)
		.digest("hex");
	return `background-${digest}`;
}

export function enqueueBackgroundConversationTask(
	queue: StageJobQueue,
	request: {
		tenantId: string;
		workspaceId: string;
		conversationId: string;
		messageId: string;
		content: string;
		actorId: string;
		requestedBy: "user" | "agent" | "cron";
		availableAt?: string;
	},
): StageJob {
	const idValue = taskId(request, request.conversationId, request.messageId);
	return queue.enqueue({
		tenantId: request.tenantId,
		workspaceId: request.workspaceId,
		runId: request.conversationId,
		jobId: idValue,
		stageId: "conversation-background",
		commandId: request.messageId,
		correlationId: idValue,
		expectedVersion: 0,
		sessionId: request.conversationId,
		maxFailures: request.requestedBy === "agent" ? 10 : 5,
		// Use the queue's bounded continuation budget (32 slices), also for Cron deliveries.
		availableAt: request.availableAt,
		payload: {
			type: "conversation.message.v1",
			messageId: request.messageId,
			content: request.content,
			actorId: request.actorId,
			requestedBy: request.requestedBy,
		},
	});
}

export class BackgroundTaskApiController {
	constructor(
		private readonly queue: StageJobQueue,
		private readonly conversations: ConversationApiController,
		private readonly runtime: AgentRuntimePort,
	) {}

	async create(
		context: ConversationApiContext,
		conversationIdValue: unknown,
		payload: unknown,
	): Promise<ConversationApiResponse> {
		try {
			if (!record(payload)) throw new BackgroundTaskValidationError("message payload must be an object");
			const completeContext = {
				tenantId: id(context.tenantId, "tenantId"),
				workspaceId: id(context.workspaceId, "workspaceId"),
				actorId: id(context.actorId, "actorId"),
			};
			const conversationId = id(conversationIdValue, "conversationId");
			const messageId = id(payload.messageId, "messageId");
			const content = text(payload.content);
			if ((await this.runtime.health()).adapter !== "blackx-agent") {
				return { status: 503, body: { code: "real_provider_required" } };
			}
			const conversation = this.conversations.get(completeContext, conversationId);
			if (conversation.status !== 200) return conversation;
			const job = enqueueBackgroundConversationTask(this.queue, {
				...completeContext,
				conversationId,
				messageId,
				content,
				requestedBy: "user",
			});
			return { status: 202, body: { task: backgroundTaskView(job) } };
		} catch (error) {
			return this.failure(error, "background_task_create_failed");
		}
	}

	list(context: ConversationApiContext, conversationIdValue: unknown): ConversationApiResponse {
		try {
			const access = this.conversations.get(context, conversationIdValue);
			if (access.status !== 200) return access;
			const tenantId = id(context.tenantId, "tenantId");
			const workspaceId = id(context.workspaceId, "workspaceId");
			const conversationId = id(conversationIdValue, "conversationId");
			const tasks = this.queue.list()
				.filter((job) => job.stageId === "conversation-background" &&
					job.tenantId === tenantId &&
					job.workspaceId === workspaceId &&
					job.runId === conversationId)
				.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
				.map(backgroundTaskView);
			return { status: 200, body: { tasks } };
		} catch (error) {
			return this.failure(error, "background_task_list_failed");
		}
	}

	get(context: ConversationApiContext, taskIdValue: unknown): ConversationApiResponse {
		try {
			const tenantId = id(context.tenantId, "tenantId");
			const workspaceId = id(context.workspaceId, "workspaceId");
			const idValue = id(taskIdValue, "taskId");
			const job = this.queue.get(idValue);
			return job?.stageId === "conversation-background" &&
				job.tenantId === tenantId &&
				job.workspaceId === workspaceId && this.conversations.get(context, job.runId).status === 200
				? { status: 200, body: { task: backgroundTaskView(job) } }
				: { status: 404, body: { code: "background_task_not_found" } };
		} catch (error) {
			return this.failure(error, "background_task_read_failed");
		}
	}

	private failure(error: unknown, fallbackCode: string): ConversationApiResponse {
		if (error instanceof BackgroundTaskValidationError) {
			return { status: 400, body: { code: "invalid_background_task_request", message: error.message } };
		}
		if (error instanceof StageJobQueueError) {
			return {
				status: error.code === "job_conflict" ? 409 : error.code === "invalid_job" ? 400 : 503,
				body: { code: error.code, message: error.message },
			};
		}
		return { status: 500, body: { code: fallbackCode } };
	}
}
