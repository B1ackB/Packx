import { describe, expect, it, vi } from "vitest";
import { AnthropicMessagesClient } from "../anthropic/client";
import { AnthropicGenerationError, AnthropicModelProvider } from "./anthropicModelProvider";

describe("AnthropicModelProvider", () => {
	it("maps generic Agent messages, tools, schema, response and usage", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
			id: "msg-1",
			type: "message",
			role: "assistant",
			model: "model-a",
			content: [
				{ type: "text", text: "working" },
				{ type: "tool_use", id: "call-1", name: "lookup", input: { id: 1 } },
			],
			stop_reason: "tool_use",
			usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 },
		}), { status: 200, headers: { "content-type": "application/json" } }));
		const provider = new AnthropicModelProvider(new AnthropicMessagesClient({
			baseUrl: "https://example.invalid",
			apiKey: "test-key",
			fetch: fetchMock,
		}), "model-a");

		const result = await provider.generate({
			messages: [
				{ role: "system", content: "stable policy" },
				{
					role: "user",
					content: "check",
					attachments: [{
						type: "image",
						name: "reference.png",
						mediaType: "image/png",
						sourceRef: "attachment://conversation-a/attachment-a",
						sha256: "a".repeat(64),
						data: "aW1hZ2U=",
					}],
				},
			],
			tools: [{ name: "lookup", description: "Read", inputSchema: { type: "object" } }],
			reasoning: "disabled",
			outputSchema: { type: "object" },
			fallbackOutput: "unused",
		});

		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
			expect(body).toMatchObject({
			model: "model-a",
			thinking: { type: "disabled" },
			messages: [{ role: "user", content: [
				{ type: "text", text: "check" },
				{
					type: "image",
					source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
				},
			] }],
			tools: [{ name: "lookup", input_schema: { type: "object" } }],
		});
		expect(body.system[0].text).toBe("stable policy");
		expect(body.output_config.format.schema).toEqual({ type: "object" });
		expect(result).toMatchObject({
			text: "working",
			toolCalls: [{ id: "call-1", name: "lookup", input: { id: 1 } }],
			usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4 },
			telemetry: { model: "model-a", stopReason: "tool_use", cacheReadTokens: 3, cacheWriteTokens: null },
		});
	});

	it("uses the real Token Count contract shape", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
			JSON.stringify({ input_tokens: 23 }),
			{ status: 200, headers: { "content-type": "application/json" } },
		));
		const provider = new AnthropicModelProvider(new AnthropicMessagesClient({
			baseUrl: "https://example.invalid",
			apiKey: "test-key",
			fetch: fetchMock,
		}), "model-a");

		await expect(provider.countTokens({
			messages: [{ role: "user", content: "hello" }],
			tools: [],
			fallbackOutput: "unused",
		})).resolves.toBe(23);
	});

	it("round-trips signed thinking blocks unchanged across a tool call", async () => {
		const thinking = { type: "thinking" as const, thinking: "private reasoning", signature: "signed-1" };
		const toolUse = { type: "tool_use" as const, id: "call-1", name: "lookup", input: { id: 1 } };
		const fetchMock = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				id: "msg-1",
				type: "message",
				role: "assistant",
				model: "model-a",
				content: [thinking, toolUse],
				stop_reason: "tool_use",
				usage: { input_tokens: 12, output_tokens: 4 },
			}), { status: 200, headers: { "content-type": "application/json" } }))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				id: "msg-2",
				type: "message",
				role: "assistant",
				model: "model-a",
				content: [{ type: "text", text: "done" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 20, output_tokens: 2 },
			}), { status: 200, headers: { "content-type": "application/json" } }));
		const provider = new AnthropicModelProvider(new AnthropicMessagesClient({
			baseUrl: "https://example.invalid",
			apiKey: "test-key",
			fetch: fetchMock,
		}), "model-a");
		const tools = [{ name: "lookup", description: "Read", inputSchema: { type: "object" } }];

		const first = await provider.generate({
			messages: [{ role: "user", content: "check" }],
			tools,
			fallbackOutput: "unused",
		});
		const second = await provider.generate({
			messages: [
				{ role: "user", content: "check" },
				{
					role: "assistant",
					content: first.text,
					toolCalls: first.toolCalls,
					providerState: first.providerState,
				},
				{ role: "tool", content: "42", toolCallId: "call-1" },
			],
			tools,
			fallbackOutput: "unused",
		});

		const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
		expect(first.providerState).toMatchObject({ model: "model-a" });
		expect(secondBody.messages[1]).toEqual({ role: "assistant", content: [thinking, toolUse] });
		expect(secondBody.messages[2]).toEqual({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "call-1", content: "42" }],
		});
		expect(second.text).toBe("done");
	});

	it("rejects incomplete and malformed provider responses", async () => {
		for (const response of [
			{
				id: "msg-limit",
				type: "message",
				role: "assistant",
				model: "model-a",
				content: [{ type: "text", text: "partial" }],
				stop_reason: "max_tokens",
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			{ content: [{ type: "unexpected" }], usage: { input_tokens: 1, output_tokens: 1 } },
		]) {
			const provider = new AnthropicModelProvider(new AnthropicMessagesClient({
				baseUrl: "https://example.invalid",
				apiKey: "test-key",
				fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), {
					status: 200,
					headers: { "content-type": "application/json" },
				})),
			}), "model-a");
			await expect(provider.generate({
				messages: [{ role: "user", content: "hello" }],
				tools: [],
				fallbackOutput: "unused",
			})).rejects.toBeDefined();
		}
	});
});

// Received failures must remain failures even if their partial body happens to be valid JSON.
it.each(["max_tokens", "refusal", "pause_turn", "model_context_window_exceeded"])("retains sanitized accounting for %s without exposing partial content", async (stopReason) => {
	const provider = new AnthropicModelProvider(new AnthropicMessagesClient({ baseUrl: "https://example.invalid", apiKey: "test-key",
		fetch: async () => new Response(JSON.stringify({ model: "secret invalid model", stop_reason: stopReason,
			content: [{ type: "text", text: '{"issues":[]}' }, { type: "thinking", thinking: "secret reasoning", signature: "secret signature" }, { type: "tool_use", id: "partial", name: "publish", input: { secret: true } }],
			usage: { input_tokens: 100, output_tokens: 8192, cache_read_input_tokens: 20, output_tokens_details: { thinking_tokens: 8000 } },
		}), { headers: { "content-type": "application/json" } }),
	}), "configured-model");
	const error = await provider.generate({ messages: [{ role: "user", content: "check" }], tools: [], fallbackOutput: "" }).catch((error: unknown) => error);
	expect(error).toBeInstanceOf(AnthropicGenerationError);
	expect(error).toMatchObject({ usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 8192, reasoningOutputTokens: 8000 }, telemetry: { model: "configured-model", stopReason } });
	expect(JSON.stringify(error)).not.toMatch(/secret|issues|publish|partial/);
});

it.each([{ input_tokens: -1, output_tokens: 5 }, { input_tokens: 1, output_tokens: 1.5 }, { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: -2 }, { input_tokens: 1, output_tokens: 5, output_tokens_details: { thinking_tokens: "5" } }])("refuses invalid failure accounting: %j", async (usage) => {
	const provider = new AnthropicModelProvider(new AnthropicMessagesClient({ baseUrl: "https://example.invalid", apiKey: "test-key",
		fetch: async () => new Response(JSON.stringify({ stop_reason: "max_tokens", content: [], usage }), { headers: { "content-type": "application/json" } }),
	}), "model");
	await expect(provider.generate({ messages: [{ role: "user", content: "check" }], tools: [], fallbackOutput: "" })).rejects.toMatchObject({ code: "invalid_response" });
});
