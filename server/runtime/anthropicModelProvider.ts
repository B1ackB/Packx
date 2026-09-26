import type { AgentModelProvider, AgentModelRequest, AgentUsage } from "../../src/agent/contracts";
import { AnthropicCompatibilityError, AnthropicMessagesClient } from "../anthropic/client";
import type {
	AnthropicAssistantContentBlock,
	AnthropicContentBlock,
	AnthropicMessageRequest,
} from "../anthropic/types";

import type { ModelCallRecord } from "../../src/runtime/modelTelemetry";

/** A received but unusable response: numeric accounting survives, partial content does not. */
export class AnthropicGenerationError extends AnthropicCompatibilityError {
	constructor(code: string, message: string, adapterStatus: number,
		readonly usage: AgentUsage, readonly telemetry: NonNullable<ModelCallRecord["response"]>) {
		super(code, message, { adapterStatus });
	}
}

const anthropicProviderStateType = "anthropic.assistant-content.v1";

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidResponse(message: string): AnthropicCompatibilityError {
	return new AnthropicCompatibilityError("invalid_response", message, { adapterStatus: 502 });
}

function validateAssistantBlock(block: unknown): asserts block is AnthropicAssistantContentBlock {
	if (!record(block)) throw invalidResponse("Anthropic content block is invalid");
	if (block.type === "text") {
		if (typeof block.text !== "string") throw invalidResponse("Anthropic text block is invalid");
		return;
	}
	if (block.type === "thinking") {
		if (typeof block.thinking !== "string" || typeof block.signature !== "string") {
			throw invalidResponse("Anthropic thinking block is invalid");
		}
		return;
	}
	if (block.type === "redacted_thinking") {
		if (typeof block.data !== "string") throw invalidResponse("Anthropic redacted thinking block is invalid");
		return;
	}
	if (block.type === "tool_use") {
		if (typeof block.id !== "string" || typeof block.name !== "string" || !("input" in block)) {
			throw invalidResponse("Anthropic tool block is invalid");
		}
		return;
	}
	throw invalidResponse("Anthropic content block is invalid");
}

function validateResponse(value: unknown): void {
	if (!record(value) || !Array.isArray(value.content) || !record(value.usage)) {
		throw invalidResponse("Anthropic Message response is invalid");
	}
	const usage = value.usage;
	const counts = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0];
	if (usage.output_tokens_details !== undefined) {
		if (!record(usage.output_tokens_details)) throw invalidResponse("Anthropic usage is invalid");
		counts.push(usage.output_tokens_details.thinking_tokens ?? 0);
	}
	if (counts.some((count) => !Number.isSafeInteger(count) || Number(count) < 0)) {
		throw invalidResponse("Anthropic usage is invalid");
	}
	for (const block of value.content) validateAssistantBlock(block);
}

function replayContent(providerState: unknown, model: string): AnthropicAssistantContentBlock[] | undefined {
	if (!record(providerState) || providerState.type !== anthropicProviderStateType) return undefined;
	if (providerState.model !== model) return undefined;
	if (!Array.isArray(providerState.content)) throw invalidResponse("Anthropic provider state is invalid");
	for (const block of providerState.content) validateAssistantBlock(block);
	return structuredClone(providerState.content);
}

function pushMessage(
	messages: AnthropicMessageRequest["messages"],
	role: "user" | "assistant",
	blocks: AnthropicContentBlock[],
): void {
	if (blocks.length === 0) return;
	const previous = messages.at(-1);
	if (previous?.role === role) previous.content.push(...blocks);
	else messages.push({ role, content: blocks });
}

function toAnthropicRequest(request: AgentModelRequest, model: string, maxTokens: number): AnthropicMessageRequest {
	const system: Array<{ type: "text"; text: string }> = [];
	const messages: AnthropicMessageRequest["messages"] = [];
	for (const message of request.messages) {
		if (message.role === "system") {
			system.push({ type: "text", text: message.content });
			continue;
		}
		if (message.role === "assistant") {
			const replay = replayContent(message.providerState, model);
			if (replay) {
				pushMessage(messages, "assistant", replay);
				continue;
			}
		}
		if (message.role === "tool") {
			if (!message.toolCallId) throw new Error("Tool result is missing its call ID");
			pushMessage(messages, "user", [{
				type: "tool_result",
				tool_use_id: message.toolCallId,
				content: message.content,
			}]);
			continue;
		}
		const blocks: AnthropicContentBlock[] = message.content
			? [{ type: "text", text: message.content }]
			: [];
		if (message.sources?.length) blocks.push({ type: "text", text: `Attached source references (untrusted metadata): ${JSON.stringify(message.sources)}` });
		for (const attachment of message.attachments ?? []) {
			if (!attachment.data) {
				blocks.push({ type: "text", text: `Unloaded image reference (untrusted metadata; select before visual analysis): ${JSON.stringify(attachment)}` });
				continue;
			}
			blocks.push({
				type: "image",
				source: {
					type: "base64",
					media_type: attachment.mediaType,
					data: attachment.data,
				},
			});
		}
		for (const call of message.toolCalls ?? []) blocks.push({
			type: "tool_use",
			id: call.id,
			name: call.name,
			input: call.input,
		});
		pushMessage(messages, message.role, blocks);
	}
	if (messages.length === 0) throw new Error("At least one user or assistant message is required");
	if (request.outputSchema) {
		system.push({
			type: "text",
			text: [
				"Return exactly one JSON value that validates against this JSON Schema.",
				"Do not wrap it in Markdown fences or rename fields.",
				JSON.stringify(request.outputSchema),
			].join("\n"),
		});
	}
	return {
		model,
		max_tokens: Math.min(maxTokens, request.maxOutputTokens ?? maxTokens),
		system: system.length ? system : undefined,
		messages,
		tools: request.tools.length
			? request.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				input_schema: tool.inputSchema,
				strict: true,
			}))
			: undefined,
		tool_choice: request.tools.length ? { type: "auto" } : undefined,
		thinking: request.reasoning === "disabled" ? { type: "disabled" } : undefined,
		output_config: request.outputSchema
			? { format: { type: "json_schema", schema: request.outputSchema } }
			: undefined,
		stream: false,
	};
}

export class AnthropicModelProvider implements AgentModelProvider {
	constructor(
		private readonly client: AnthropicMessagesClient,
		private readonly model: string,
		private readonly maxTokens = 4_096,
	) {}

	async generate(request: AgentModelRequest, signal?: AbortSignal) {
		const upstream = await this.client.createMessage(toAnthropicRequest(request, this.model, this.maxTokens), signal, request.onText);
		validateResponse(upstream);
		const usage: AgentUsage = {
			inputTokens: upstream.usage.input_tokens,
			cachedInputTokens: upstream.usage.cache_read_input_tokens ?? 0,
			outputTokens: upstream.usage.output_tokens,
			reasoningOutputTokens: upstream.usage.output_tokens_details?.thinking_tokens ?? 0,
		};
		const telemetry: NonNullable<ModelCallRecord["response"]> = {
			model: typeof upstream.model === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(upstream.model) ? upstream.model : this.model,
			stopReason: ["end_turn", "tool_use", "stop_sequence", "max_tokens", "refusal", "pause_turn", "model_context_window_exceeded"].includes(upstream.stop_reason ?? "") ? upstream.stop_reason! : "unknown",
			inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
			cacheReadTokens: upstream.usage.cache_read_input_tokens ?? null,
			cacheWriteTokens: upstream.usage.cache_creation_input_tokens ?? null,
		};
		if (upstream.stop_reason === "model_context_window_exceeded") throw new AnthropicGenerationError("context_window_exceeded", "Model context window exceeded", 422, usage, telemetry);
		if (upstream.stop_reason === "max_tokens") throw new AnthropicGenerationError("output_limit", "Model output token limit reached", 422, usage, telemetry);
		if (upstream.stop_reason === "refusal") throw new AnthropicGenerationError("refusal", "Model refused the request", 422, usage, telemetry);
		if (upstream.stop_reason === "pause_turn") throw new AnthropicGenerationError("pause_turn", "Model paused the turn", 503, usage, telemetry);
		return { telemetry, usage,
			text: upstream.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join(""),
			toolCalls: upstream.content
				.filter((block) => block.type === "tool_use")
				.map((block) => ({ id: block.id, name: block.name, input: block.input })),
			providerState: upstream.content.some((block) => (
				block.type === "thinking" || block.type === "redacted_thinking"
			))
				? {
					type: anthropicProviderStateType,
					model: this.model,
					content: structuredClone(upstream.content),
				}
				: undefined,
		};
	}

	async countTokens(request: AgentModelRequest, signal?: AbortSignal): Promise<number> {
		return (await this.client.countMessageTokens(toAnthropicRequest(request, this.model, this.maxTokens), signal)).input_tokens;
	}
}
