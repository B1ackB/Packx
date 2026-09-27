import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ModelTelemetryStore, type ObservedModelResponse } from "./modelTelemetry";
import { summarizeModelCalls } from "../../src/runtime/modelTelemetry";
import { AnthropicCompatibilityError } from "../anthropic/client";
import { AnthropicGenerationError } from "./anthropicModelProvider";
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
const scope = { tenantId: "tenant", workspaceId: "workspace", runId: "conversation" };
const request = { messages: [{ role: "user" as const, content: "secret-prompt" }], tools: [], fallbackOutput: "" };
const result: ObservedModelResponse = { text: "secret-response", toolCalls: [], usage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 0 }, telemetry: { model: "actual-model", stopReason: "end_turn", inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 50 } };
function setup() { const root = mkdtempSync(join(tmpdir(), "blackx-telemetry-")); roots.push(root); return { root, store: new ModelTelemetryStore(root, "configured-model") }; }
describe("model call telemetry", () => {
	it("persists real attempts and numeric usage, separates token counting and isolates scopes", async () => {
		const { root, store } = setup();
		const provider = store.wrap({ generate: async () => result, countTokens: async () => 100 }, scope, "execution");
		await provider.countTokens!(request); await provider.generate(request);
		const restored = new ModelTelemetryStore(root, "configured-model").view(scope);
		expect(restored.calls).toHaveLength(2);
		expect(restored.calls[1]).toMatchObject({ status: "succeeded", executionId: "execution", response: { model: "actual-model" } });
		expect(summarizeModelCalls(restored.calls)).toMatchObject({ generated: 1, counted: 1, cacheHitRate: 0.25, cacheCoverage: 1, inputTokens: 100, outputTokens: 20 });
		for (const changed of [{ tenantId: "another" }, { workspaceId: "another" }, { runId: "another" }]) expect(store.view({ ...scope, ...changed }).calls).toEqual([]);
		const raw = readFileSync(join(root, readdirSync(root)[0]), "utf8"); expect(raw).not.toContain("secret-");
	});
	it("exposes in-flight requests, redacts upstream errors, and marks interrupted requests after restart", async () => {
		const { root, store } = setup(); let fail!: (error: Error) => void;
		const pending = store.wrap({ generate: () => new Promise((_resolve, reject) => { fail = reject; }) }, scope, "execution").generate(request);
		expect(store.view(scope).calls[0].status).toBe("running");
		expect(new ModelTelemetryStore(root, "configured-model").view(scope).calls[0].status).toBe("interrupted");
		fail(new AnthropicCompatibilityError("secret-type", "secret-error", { providerStatus: 429 }));
		await expect(pending).rejects.toThrow("secret-error");
		expect(store.view(scope).calls[0]).toMatchObject({ status: "failed", httpStatus: 429, failure: "rate_limited" });
		expect(JSON.stringify(store.view(scope))).not.toContain("secret-");
	});
	it("records cancellation even when the provider does not settle", async () => {
		const { store } = setup(); const controller = new AbortController();
		const waiting = store.wrap({ generate: () => new Promise(() => {}) }, scope, "execution").generate(request, controller.signal);
		controller.abort(); await expect(waiting).rejects.toThrow();
		expect(store.view(scope).calls[0]).toMatchObject({ status: "cancelled", failure: "request_cancelled" });
	});
	it("distinguishes missing cache fields from zero and weights by tokens instead of averaging percentages", async () => {
		const { store } = setup();
		await store.wrap({ generate: async () => ({ ...result, telemetry: { ...result.telemetry!, cacheReadTokens: null, cacheWriteTokens: null } }) }, scope, "execution").generate(request);
		expect(summarizeModelCalls(store.view(scope).calls)).toMatchObject({ cacheHitRate: null, cacheCoverage: 0 });
		await store.wrap({ generate: async () => ({ ...result, telemetry: { ...result.telemetry!, cacheReadTokens: 0, cacheWriteTokens: 0 } }) }, scope, "execution").generate(request);
		expect(summarizeModelCalls(store.view(scope).calls).cacheHitRate).toBe(0);
		await store.wrap({ generate: async () => result }, scope, "execution").generate(request);
		expect(summarizeModelCalls(store.view(scope).calls).cacheHitRate).toBeCloseTo(50 / 300);
	});
	it("bounds retained requests and labels the limited window", async () => {
		const { root, store } = setup(); const provider = store.wrap({ generate: async () => result }, scope, "execution");
		await provider.generate(request);
		const path = join(root, readdirSync(root)[0]); const index = JSON.parse(readFileSync(path, "utf8"));
		index.calls = Array.from({ length: 200 }, (_, i) => ({ ...index.calls[0], id: `seed-${i}` }));
		writeFileSync(path, JSON.stringify(index));
		await provider.generate(request);
		expect(store.view(scope).calls.some((call) => call.id === "seed-0")).toBe(false);
		expect(store.view(scope).calls).toHaveLength(200); expect(store.view(scope).truncated).toBe(true);
	});
});

it("persists a received failure's usage across restart while keeping it failed and redacted", async () => {
	const { root, store } = setup();
	const error = new AnthropicGenerationError("output_limit", "secret error text", 422, result.usage, { ...result.telemetry!, stopReason: "max_tokens" });
	const provider = store.wrap({ generate: async () => { throw error; } }, scope, "execution");
	await expect(provider.generate(request)).rejects.toBe(error);
	const calls = new ModelTelemetryStore(root, "configured-model").view(scope).calls;
	expect(calls[0]).toMatchObject({ status: "failed", usage: result.usage, response: { stopReason: "max_tokens" } });
	expect(summarizeModelCalls(calls)).toMatchObject({ failed: 1, succeeded: 0, responses: 1, outputTokens: 20 });
	expect(JSON.stringify(calls)).not.toContain("secret");
});

it("persists a fixed transport category without inventing usage or retaining private errors", async () => {
	const { root, store } = setup();
	const error = new TypeError("secret URL", { cause: Object.assign(new Error("secret socket"), { code: "UND_ERR_SOCKET" }) });
	await expect(store.wrap({ generate: async () => { throw error; } }, scope, "execution").generate(request)).rejects.toBe(error);
	const call = new ModelTelemetryStore(root, "configured-model").view(scope).calls[0];
	expect(call).toMatchObject({ status: "failed", failure: "transport_failure" });
	expect(call.usage).toBeUndefined(); expect(call.response).toBeUndefined();
	expect(JSON.stringify(call)).not.toContain("secret");
});
