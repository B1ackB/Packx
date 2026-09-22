import type { StageJobLease } from "../../src/enterprise/stageJobQueue";
import { RuntimeFailure, type RuntimeFailureCode } from "../../src/runtime/contracts";
import type { ConversationApiContext, ConversationApiResponse } from "../runtime/conversationApi";
import { ConversationApiController } from "../runtime/conversationApi";
import type { StageJobHandlerResult } from "./stageJobScheduler";

interface BackgroundConversationPayload {
	type: "conversation.message.v1";
	messageId: string;
	content: string;
	actorId: string;
	requestedBy?: "user" | "agent" | "cron";
}

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function payload(value: unknown): BackgroundConversationPayload {
	if (!record(value) || value.type !== "conversation.message.v1") {
		throw new RuntimeFailure("invalid_output", "Background Task payload is invalid", false);
	}
	for (const key of ["messageId", "content", "actorId"] as const) {
		if (typeof value[key] !== "string" || !value[key]) {
			throw new RuntimeFailure("invalid_output", "Background Task payload is invalid", false);
		}
	}
	return value as unknown as BackgroundConversationPayload;
}

function responseFailure(response: ConversationApiResponse): RuntimeFailure {
	const body = record(response.body) ? response.body : {};
	const providerCode = typeof body.code === "string" ? body.code : "conversation_turn_failed";
	let code: RuntimeFailureCode = response.status >= 500 ? "infrastructure_failure" : "execution_failed";
	let retryable = response.status >= 500 || response.status === 409;
	if (providerCode === "repeated_actions" || providerCode === "consecutive_tool_failures") {
		code = providerCode;
		retryable = false;
	} else if (providerCode === "authentication") {
		code = "authentication";
		retryable = false;
	} else if (providerCode === "rate_limit") {
		code = "rate_limit";
		retryable = true;
	} else if (providerCode === "context_failure" || providerCode === "budget_exceeded" || providerCode === "model_failure" || providerCode === "timeout" || providerCode === "cancelled" || providerCode === "permission_denied" || providerCode === "max_iterations" || providerCode === "session_conflict" || providerCode === "runtime_unavailable" || providerCode === "execution_failed") {
		code = providerCode;
	} else if (providerCode === "invalid_output" || response.status === 400 || response.status === 404) {
		code = "invalid_output";
		retryable = false;
	}
	// HTTP status alone cannot decide whether replaying this Runtime failure is safe.
	if (typeof body.retryable === "boolean") retryable = body.retryable;
	return new RuntimeFailure(
		code,
		`Background conversation turn failed (${response.status}:${providerCode})`,
		retryable,
	);
}

export class BackgroundConversationWorker {
	constructor(private readonly conversations: ConversationApiController) {}

	async execute(lease: StageJobLease, signal?: AbortSignal, assertActive?: () => void): Promise<StageJobHandlerResult> {
		const message = payload(lease.payload);
		const context: ConversationApiContext = {
			tenantId: lease.tenantId,
			workspaceId: lease.workspaceId,
			actorId: message.actorId,
		};
		const response = await this.conversations.send(
			context,
			lease.runId,
			{ messageId: message.messageId, content: message.content },
			{ retryIncomplete: true, signal, assertActive },
		);
		if (response.status !== 200) throw responseFailure(response);
		const execution = record(response.body) && record(response.body.execution) ? response.body.execution : undefined;
		if (execution?.status === "paused") return {
			status: "paused", sessionId: lease.runId,
			...(typeof execution.contextSnapshotId === "string" ? { contextSnapshotId: execution.contextSnapshotId } : {}),
		};
		return { status: "completed" };
	}
}
