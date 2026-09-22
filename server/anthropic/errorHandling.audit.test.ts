import { describe, expect, it, vi } from "vitest";
import { AnthropicMessagesClient } from "./client";
import { SkillRegistry } from "../../src/agent/skills";
import { InMemoryAgentStateStore } from "../../src/agent/state";
import { BlackxAgentRuntime } from "../runtime/agentRuntime";
import { AnthropicModelProvider } from "../runtime/anthropicModelProvider";

const request = {
	model: "audit-model",
	max_tokens: 10,
	stream: false,
	messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
};

function client(body: unknown, status = 200) {
	return new AnthropicMessagesClient({
		baseUrl: "https://example.invalid",
		apiKey: "audit-placeholder",
		fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), {
			status, headers: { "content-type": "application/json" },
		})),
	});
}

describe("Provider error boundary audit", () => {
	for (const method of ["createMessage", "countMessageTokens"] as const) {
		it.each([401, 429, 503])(`${method} preserves HTTP %i when the gateway returns a JSON string`, async (status) => {
			await expect(client("gateway failure", status)[method](request)).rejects.toMatchObject({
				name: "AnthropicCompatibilityError", code: "upstream_error", providerStatus: status,
			});
		});
	}

	it.each(["invalid", true, { input_tokens: -1 }, { input_tokens: Number.MAX_SAFE_INTEGER + 1 }])("rejects malformed token count %# with a structured adapter failure", async (body) => {
		await expect(client(body).countMessageTokens(request)).rejects.toMatchObject({
			name: "AnthropicCompatibilityError", code: "invalid_response", adapterStatus: 502,
		});
	});

	it.each([null, {}, { content: [null] }, { content: [{ type: "text", text: 42 }] }])("rejects malformed message %# before emitting invalid partial text", async (body) => {
		const onText = vi.fn();
		await expect(client(body).createMessage(request, undefined, onText)).rejects.toMatchObject({
			name: "AnthropicCompatibilityError", code: "invalid_response", adapterStatus: 502,
		});
		expect(onText).not.toHaveBeenCalled();
	});

	it.each([
		{ status: 401, code: "authentication", retryable: false },
		{ status: 429, code: "rate_limit", retryable: true },
		{ status: 503, code: "model_failure", retryable: true },
	])("preserves $code and retry safety through Provider, Runtime and Trace", async ({ status, code, retryable }) => {
		const state = new InMemoryAgentStateStore();
		const runtime = new BlackxAgentRuntime({
			provider: new AnthropicModelProvider(client("gateway failure", status), "audit-model"),
			skills: new SkillRegistry(), traces: state,
		});
		const scope = { tenantId: "audit-tenant", workspaceId: "audit-workspace", runId: "audit-run" };
		await expect(runtime.executeTurn({
			...scope, stageId: "conversation", actorId: "audit-user", idempotencyKey: "audit-turn",
			input: "hello", fallbackOutput: "unused",
			policy: { sandboxMode: "read-only", approvalPolicy: "never", timeoutMs: 1000 },
		})).rejects.toMatchObject({ code, retryable });
		expect(state.listTraces(scope)).toEqual([expect.objectContaining({
			status: "failed", failure: expect.objectContaining({ code, retryable }),
		})]);
	});
});
