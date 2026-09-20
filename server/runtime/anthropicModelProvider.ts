import type { AgentModelProvider, AgentModelRequest } from "../../src/agent/contracts";
import { AnthropicCompatibilityError, AnthropicMessagesClient } from "../anthropic/client";
import type {
	AnthropicAssistantContentBlock,
	AnthropicContentBlock,
	AnthropicMessageRequest,
} from "../anthropic/types";

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
	if (!Number.isInteger(value.usage.input_tokens) || !Number.isInteger(value.usage.output_tokens)) {
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
		if (upstream.stop_reason === "model_context_window_exceeded") {
			throw new AnthropicCompatibilityError(
				"context_window_exceeded",
				"Model context window exceeded",
				{ adapterStatus: 422 },
			);
		}
		if (upstream.stop_reason === "max_tokens") {
			throw new AnthropicCompatibilityError(
				"output_limit",
				"Model output token limit reached",
				{ adapterStatus: 422 },
			);
		}
		if (upstream.stop_reason === "refusal") {
			throw new AnthropicCompatibilityError(
				"refusal",
				"Model refused the request",
				{ adapterStatus: 422 },
			);
		}
		if (upstream.stop_reason === "pause_turn") {
			throw new AnthropicCompatibilityError(
				"pause_turn",
				"Model paused the turn",
				{ adapterStatus: 503 },
			);
		}
		return {
			telemetry: {
				model: typeof upstream.model === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(upstream.model) ? upstream.model : this.model,
				stopReason: ["end_turn", "tool_use", "stop_sequence"].includes(upstream.stop_reason ?? "") ? upstream.stop_reason! : "unknown",
				inputTokens: upstream.usage.input_tokens, outputTokens: upstream.usage.output_tokens,
				cacheReadTokens: Number.isSafeInteger(upstream.usage.cache_read_input_tokens) && upstream.usage.cache_read_input_tokens! >= 0 ? upstream.usage.cache_read_input_tokens! : null,
				cacheWriteTokens: Number.isSafeInteger(upstream.usage.cache_creation_input_tokens) && upstream.usage.cache_creation_input_tokens! >= 0 ? upstream.usage.cache_creation_input_tokens! : null,
			},
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
			usage: {
				inputTokens: upstream.usage.input_tokens,
				cachedInputTokens: upstream.usage.cache_read_input_tokens ?? 0,
				outputTokens: upstream.usage.output_tokens,
				reasoningOutputTokens: upstream.usage.output_tokens_details?.thinking_tokens ?? 0,
			},
		};
	}

	async countTokens(request: AgentModelRequest, signal?: AbortSignal): Promise<number> {
		return (await this.client.countMessageTokens(toAnthropicRequest(request, this.model, this.maxTokens), signal)).input_tokens;
	}
}
