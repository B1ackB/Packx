import { describe, expect, it, vi } from "vitest";
import { AnthropicMessagesClient } from "./client";

describe("AnthropicMessagesClient", () => {
	it.each(["createMessage", "countMessageTokens"] as const)("preserves a transport failure while reading %s JSON", async (method) => {
		const broken = new TypeError("private address", { cause: Object.assign(new Error("private socket"), { code: "UND_ERR_SOCKET" }) });
		const client = new AnthropicMessagesClient({ baseUrl: "https://example.invalid", apiKey: "test",
			fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(broken); } }), { headers: { "content-type": "application/json" } }),
		});
		await expect(client[method]({ model: "model", max_tokens: 10, messages: [], stream: false })).rejects.toBe(broken);
	});
	it("preserves a received HTTP error even if its error body is unreadable", async () => {
		const client = new AnthropicMessagesClient({ baseUrl: "https://example.invalid", apiKey: "test",
			fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("private transport")); } }), { status: 401 }),
		});
		await expect(client.createMessage({ model: "model", max_tokens: 10, messages: [], stream: false })).rejects.toMatchObject({ providerStatus: 401 });
	});

  it("uses Anthropic authentication headers without exposing the key in the body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "model-a",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new AnthropicMessagesClient({
      baseUrl: "https://example.invalid/",
      apiKey: "secret-test-key",
      fetch: fetchMock,
    });

    await client.createMessage({
      model: "model-a",
      max_tokens: 10,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      stream: false,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://example.invalid/v1/messages");
    expect(init?.headers).toMatchObject({
      "x-api-key": "secret-test-key",
      "anthropic-version": "2023-06-01",
    });
    expect(init?.body).not.toContain("secret-test-key");
  });

	it("uses the official token count endpoint without generation-only fields", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ input_tokens: 17 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const client = new AnthropicMessagesClient({
			baseUrl: "https://example.invalid",
			apiKey: "secret-test-key",
			fetch: fetchMock,
		});

		await expect(client.countMessageTokens({
			model: "model-a",
			max_tokens: 100,
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
			stream: false,
		})).resolves.toEqual({ input_tokens: 17 });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://example.invalid/v1/messages/count_tokens");
		expect(JSON.parse(String(init?.body))).not.toHaveProperty("max_tokens");
		expect(JSON.parse(String(init?.body))).not.toHaveProperty("stream");
	});

	it("distinguishes real provider HTTP status from adapter validation status", async () => {
		const providerFailure = new AnthropicMessagesClient({
			baseUrl: "https://example.invalid",
			apiKey: "test-key",
			fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
				error: { type: "authentication_error", message: "invalid key" },
			}), { status: 401, headers: { "content-type": "application/json" } })),
		});
		await expect(providerFailure.createMessage({
			model: "model-a",
			max_tokens: 10,
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
			stream: false,
		})).rejects.toMatchObject({ providerStatus: 401, adapterStatus: undefined });

		const adapterFailure = new AnthropicMessagesClient({
			baseUrl: "https://example.invalid",
			apiKey: "test-key",
			fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ input_token_count: 4 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})),
		});
		await expect(adapterFailure.countMessageTokens({
			model: "model-a",
			max_tokens: 10,
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
			stream: false,
		})).rejects.toMatchObject({ providerStatus: undefined, adapterStatus: 502 });
	});
});
