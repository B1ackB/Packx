import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentHostTool, AgentImageAttachment, AgentModelResponse } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import { InMemoryAgentStateStore } from "../../src/agent/state";
import { RuntimeFailure, type RuntimeTurnRequest } from "../../src/runtime/contracts";
import { AnthropicCompatibilityError } from "../anthropic/client";
import { BlackxAgentRuntime } from "./agentRuntime";
import { ModelTelemetryStore } from "./modelTelemetry";
import { AnthropicModelProvider } from "./anthropicModelProvider";
import { AnthropicMessagesClient } from "../anthropic/client";

const request: RuntimeTurnRequest = {
	tenantId: "audit-tenant", workspaceId: "audit-workspace", runId: "audit-run", stageId: "audit-stage",
	actorId: "audit-user", sessionId: "audit-session", idempotencyKey: "audit-turn", input: "Exercise failure recovery", fallbackOutput: "unused",
	policy: { sandboxMode: "read-only", approvalPolicy: "never", timeoutMs: 1000 },
};
const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 };
const final: AgentModelResponse = { text: "done", toolCalls: [], usage };
const scope = { ...request, sessionId: request.sessionId! };
const tool: AgentHostTool = {
	name: "audited-write", description: "Offline fault injection", inputSchema: { type: "object" },
	execution: "host", risk: "write", idempotent: true, timeoutMs: 50, maxResultChars: 1000,
	validate: () => true, createIdempotencyKey: () => "stable-operation", execute: async () => "written",
};
const toolResponse: AgentModelResponse = { text: "", toolCalls: [{ id: "audit-call", name: tool.name, input: {} }], usage };
const writeRequest: RuntimeTurnRequest = { ...request, allowedTools: [tool.name], policy: { ...request.policy, sandboxMode: "workspace-write", approvalPolicy: "required" } };
const approval = { authorize: async () => ({ approved: true, approvalId: "audit-approval" }) };
const audit = { append: async () => {} };

afterEach(() => vi.useRealTimers());

describe("error handling fault-injection audit", () => {
	it("does not automatically repeat an uncertain transport failure despite a retryable runtime category", async () => {
		const directory = mkdtempSync(join(tmpdir(), "packx-transport-audit-"));
		try {
			const state = new InMemoryAgentStateStore(), telemetry = new ModelTelemetryStore(directory, "offline-model");
			const generate = vi.fn(async () => { throw new TypeError("private URL", { cause: Object.assign(new Error("private socket"), { code: "UND_ERR_SOCKET" }) }); });
			const runtime = new BlackxAgentRuntime({ provider: { generate }, telemetry, skills: new SkillRegistry(), sessions: state, traces: state });
			await expect(runtime.executeTurn(request)).rejects.toMatchObject({ code: "model_failure", retryable: true });
			expect(generate).toHaveBeenCalledOnce();
			expect(telemetry.view(request).calls).toMatchObject([{ status: "failed", failure: "transport_failure" }]);
			expect(state.listTraces(request)).toMatchObject([{ status: "failed", failure: { code: "model_failure" } }]);
			expect(JSON.stringify(telemetry.view(request))).not.toContain("private");
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});

	it("retains failed generation cost without persisting a final message or executing a partial tool", async () => {
		const directory = mkdtempSync(join(tmpdir(), "packx-received-failure-"));
		try {
			const state = new InMemoryAgentStateStore();
			const execute = vi.fn(async () => "must not run");
			const provider = new AnthropicModelProvider(new AnthropicMessagesClient({ baseUrl: "https://example.invalid", apiKey: "test",
				fetch: async (url) => new Response(JSON.stringify(String(url).endsWith("/count_tokens") ? { input_tokens: 100 } : { content: [{ type: "tool_use", id: "partial", name: tool.name, input: {} }], stop_reason: "max_tokens", usage: { input_tokens: 100, output_tokens: 8192 } }), { headers: { "content-type": "application/json" } }),
			}), "offline-model");
			const telemetry = new ModelTelemetryStore(directory, "offline-model");
			const runtime = new BlackxAgentRuntime({ provider, telemetry, skills: new SkillRegistry(), sessions: state, traces: state, tools: [{ ...tool, execute }], approval, audit });
			await expect(runtime.executeTurn(writeRequest)).rejects.toMatchObject({ code: "invalid_output", retryable: true });
			expect(execute).not.toHaveBeenCalled();
			expect(state.load(scope).transcript ?? []).not.toContainEqual(expect.objectContaining({ role: "assistant" }));
			expect(state.listTraces(request)).toMatchObject([{ status: "failed", failure: { code: "invalid_output" } }]);
			expect(new ModelTelemetryStore(directory, "offline-model").view(request).calls.filter(call => call.kind === "generate")).toMatchObject([{ status: "failed", usage: { outputTokens: 8192 }, response: { stopReason: "max_tokens" } }]);
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});

	it.each(["trace", "activity"] as const)("preserves authentication failure when %s reporting also fails", async (reporter) => {
		const state = new InMemoryAgentStateStore();
		const providerError = new AnthropicCompatibilityError("authentication_error", "private provider detail", { providerStatus: 401 });
		const reportingError = new Error(`${reporter}_unavailable`);
		if (reporter === "trace") vi.spyOn(state, "putTrace").mockImplementation(() => { throw reportingError; });
		const runtime = new BlackxAgentRuntime({
			provider: { generate: async () => { throw providerError; } },
			skills: new SkillRegistry(), traces: state,
			onActivity: (_scope, activity) => { if (reporter === "activity" && activity.phase === "failed") throw reportingError; },
		});
		const failure = await runtime.executeTurn(request).catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: "authentication", retryable: false });
		const aggregate = (failure as Error).cause as AggregateError;
		expect(aggregate).toBeInstanceOf(AggregateError);
		expect(aggregate.errors).toContain(reportingError);
		expect(((aggregate.cause as Error).cause as Error).cause).toBe(providerError);
		if (reporter === "activity") expect(state.listTraces(request)).toMatchObject([{ status: "failed", failure: { code: "authentication", retryable: false } }]);
	});

	it.each(["trace", "activity"] as const)("preserves explicit cancellation when %s reporting also fails", async (reporter) => {
		const controller = new AbortController();
		const state = new InMemoryAgentStateStore();
		if (reporter === "trace") vi.spyOn(state, "putTrace").mockImplementation(() => { throw new Error("trace_storage_unavailable"); });
		const runtime = new BlackxAgentRuntime({
			provider: { generate: async () => { controller.abort(new Error("user_cancelled")); throw controller.signal.reason; } },
			skills: new SkillRegistry(), traces: state,
			onActivity: (_scope, activity) => { if (reporter === "activity" && activity.phase === "failed") throw new Error("activity_sink_unavailable"); },
		});
		await expect(runtime.executeTurn(request, controller.signal)).rejects.toMatchObject({ code: "cancelled", retryable: false });
	});

	it("preserves provider authentication when telemetry persistence also fails", async () => {
		const directory = mkdtempSync(join(tmpdir(), "packx-error-audit-"));
		try {
			const telemetry = new ModelTelemetryStore(directory, "fake-model");
			const providerError = new AnthropicCompatibilityError("authentication_error", "private provider detail", { providerStatus: 401 });
			const runtime = new BlackxAgentRuntime({
				provider: { generate: async () => {
					writeFileSync(join(directory, readdirSync(directory)[0]), "invalid-json");
					throw providerError;
				} },
				telemetry, skills: new SkillRegistry(),
			});
			const failure = await runtime.executeTurn(request).catch((error: unknown) => error);
			expect(failure).toMatchObject({ code: "authentication", retryable: false });
			const aggregate = ((failure as Error).cause as Error).cause as AggregateError;
			expect(aggregate).toBeInstanceOf(AggregateError);
			expect(aggregate.cause).toBe(providerError);
			expect(aggregate.errors).toEqual([providerError, expect.any(SyntaxError)]);
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});

	it("does not claim completion when telemetry persistence fails after a successful provider response", async () => {
		const directory = mkdtempSync(join(tmpdir(), "packx-error-audit-"));
		try {
			const state = new InMemoryAgentStateStore();
			const runtime = new BlackxAgentRuntime({
				provider: { generate: async () => {
					writeFileSync(join(directory, readdirSync(directory)[0]), "invalid-json");
					return final;
				} },
				telemetry: new ModelTelemetryStore(directory, "fake-model"), skills: new SkillRegistry(), sessions: state, traces: state,
			});
			await expect(runtime.executeTurn(request)).rejects.toBeInstanceOf(RuntimeFailure);
			expect(state.listTraces(request)).toMatchObject([{ status: "failed" }]);
			expect(state.load(scope).transcript ?? []).not.toContainEqual(expect.objectContaining({ role: "assistant" }));
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});

	it("fails closed when a completed response cannot persist its trace and blocks model replay", async () => {
		const state = new InMemoryAgentStateStore();
		const persistTrace = state.putTrace.bind(state);
		vi.spyOn(state, "putTrace").mockImplementation((trace) => {
			if (trace.status === "completed") throw new Error("trace_storage_unavailable");
			return persistTrace(trace);
		});
		const generate = vi.fn(async () => final);
		const runtime = new BlackxAgentRuntime({ provider: { generate }, skills: new SkillRegistry(), sessions: state, traces: state });
		await expect(runtime.executeTurn(request)).rejects.toBeInstanceOf(RuntimeFailure);
		expect(state.listTraces(request)).toMatchObject([{ status: "failed" }]);
		expect(state.load(scope).transcript).toContainEqual(expect.objectContaining({ role: "assistant", content: "done" }));
		await expect(runtime.executeTurn(request)).rejects.toMatchObject({ code: "context_failure", retryable: false });
		expect(generate).toHaveBeenCalledOnce();
	});

	it.each([
		["execution listing", "timeout"], ["execution listing", "cancelled"],
		["image resolution", "timeout"], ["image resolution", "cancelled"],
		["source validation", "timeout"], ["source validation", "cancelled"],
	] as const)("bounds %s by turn %s even if the adapter ignores cancellation", async (boundary, failureCode) => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const state = new InMemoryAgentStateStore();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const entered = vi.fn();
		const generate = vi.fn(async () => final);
		const attachment: AgentImageAttachment = { type: "image", name: "fixture.png", mediaType: "image/png", sourceRef: "fixture", sha256: "a".repeat(64) };
		const validationTool: AgentHostTool = { ...tool, risk: "read", validateContextResult: async () => { entered(); await gate; } };
		if (boundary === "execution listing") vi.spyOn(state, "list").mockImplementation(async () => { entered(); await gate; return []; });
		if (boundary === "source validation") state.save(scope, 0, [{ role: "tool", content: "stored evidence", sourceTool: { name: tool.name, input: {} } }], "2026-09-21T00:00:00Z");
		const runtime = new BlackxAgentRuntime({
			provider: { generate }, skills: new SkillRegistry(), executions: state, sessions: state, traces: state,
			tools: [validationTool],
			resolveImageAttachment: async (_scope, image) => { entered(); await gate; return { ...image, data: "aGVsbG8=" }; },
		});
		let failure: unknown;
		const pending = runtime.executeTurn({ ...request, ...(boundary === "image resolution" ? { attachments: [attachment] } : {}), policy: { ...request.policy, timeoutMs: 50 } }, controller.signal)
			.catch((error: unknown) => { failure = error; });
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(entered).toHaveBeenCalledOnce();
			if (failureCode === "cancelled") controller.abort(new Error("user_cancelled"));
			await vi.advanceTimersByTimeAsync(failureCode === "timeout" ? 50 : 0);
			const failureBeforeAdapterRelease = failure;
			release();
			await pending;
			await vi.advanceTimersByTimeAsync(0);
			expect(failureBeforeAdapterRelease).toMatchObject({ code: failureCode, retryable: failureCode === "timeout" });
			expect(generate).not.toHaveBeenCalled();
			expect(state.listTraces(request)).toMatchObject([{ status: "failed", failure: { code: failureCode } }]);
			expect(state.load(scope).transcript ?? []).not.toContainEqual(expect.objectContaining({ role: "assistant" }));
		} finally { release(); await pending; }
	});

	it("accepts synchronous source validation when applying the cancellation boundary", async () => {
		const state = new InMemoryAgentStateStore();
		state.save(scope, 0, [{ role: "tool", content: "stored evidence", sourceTool: { name: tool.name, input: {} } }], "2026-09-21T00:00:00Z");
		const validateContextResult = vi.fn(() => {});
		const generate = vi.fn(async () => final);
		const runtime = new BlackxAgentRuntime({
			provider: { generate }, skills: new SkillRegistry(), sessions: state,
			tools: [{ ...tool, risk: "read", validateContextResult }],
		});
		await expect(runtime.executeTurn(request)).resolves.toMatchObject({ status: "completed", finalResponse: "done" });
		// Revalidate at restore and again immediately before the provider call.
		expect(validateContextResult).toHaveBeenCalledTimes(2);
		expect(generate).toHaveBeenCalledOnce();
	});

	it("fails closed before side effects when reservation persistence fails", async () => {
		const state = new InMemoryAgentStateStore();
		const execute = vi.fn(tool.execute);
		vi.spyOn(state, "claim").mockRejectedValue(new Error("storage_offline"));
		const runtime = new BlackxAgentRuntime({ provider: { generate: async () => toolResponse }, tools: [{ ...tool, execute }], skills: new SkillRegistry(), executions: state, approval, audit });
		await expect(runtime.executeTurn(writeRequest)).rejects.toMatchObject({ code: "infrastructure_failure", retryable: true });
		expect(execute).not.toHaveBeenCalled();
	});

	it("does not repeat a committed side effect after ledger completion storage fails", async () => {
		const state = new InMemoryAgentStateStore();
		const complete = vi.spyOn(state, "complete").mockRejectedValueOnce(new Error("storage_offline"));
		const execute = vi.fn(tool.execute);
		const generate = vi.fn().mockResolvedValueOnce(toolResponse).mockResolvedValueOnce(toolResponse).mockResolvedValue(final);
		const runtime = new BlackxAgentRuntime({ provider: { generate }, tools: [{ ...tool, execute }], skills: new SkillRegistry(), executions: state, approval, audit });
		await expect(runtime.executeTurn(writeRequest)).rejects.toMatchObject({ code: "infrastructure_failure", retryable: true });
		expect(await state.list(request)).toMatchObject([{ status: "started" }]);
		const retried = await runtime.executeTurn(writeRequest);
		expect(retried.events).toContainEqual(expect.objectContaining({ type: "tool.completed", status: "unknown", failureCode: "tool_execution_unknown", replayed: true }));
		expect(execute).toHaveBeenCalledOnce();
		expect(complete).toHaveBeenCalledOnce();
	});

	it("blocks replay after a timed-out write with an uncertain side effect", async () => {
		const state = new InMemoryAgentStateStore();
		const execute = vi.fn(async () => new Promise<never>(() => {}));
		const generate = vi.fn().mockResolvedValueOnce(toolResponse).mockResolvedValueOnce(final).mockResolvedValueOnce(toolResponse).mockResolvedValue(final);
		const runtime = new BlackxAgentRuntime({ provider: { generate }, tools: [{ ...tool, timeoutMs: 5, execute }], skills: new SkillRegistry(), executions: state, approval, audit });
		const first = await runtime.executeTurn(writeRequest);
		expect(first.events).toContainEqual(expect.objectContaining({ type: "tool.completed", status: "unknown", failureCode: "tool_timeout" }));
		const second = await runtime.executeTurn({ ...writeRequest, idempotencyKey: "audit-retry" });
		expect(second.events).toContainEqual(expect.objectContaining({ type: "tool.completed", status: "unknown", failureCode: "tool_execution_unknown", replayed: true }));
		expect(execute).toHaveBeenCalledOnce();
	});

	it("fails closed when input validation throws and does not consult approval", async () => {
		const execute = vi.fn(tool.execute);
		const authorize = vi.fn(approval.authorize);
		const runtime = new BlackxAgentRuntime({
			provider: { generate: vi.fn().mockResolvedValueOnce(toolResponse).mockResolvedValue(final) },
			tools: [{ ...tool, execute, validate: () => { throw new Error("malformed_input"); } }],
			skills: new SkillRegistry(), approval: { authorize }, audit,
		});
		const result = await runtime.executeTurn(writeRequest);
		expect(result.events).toContainEqual(expect.objectContaining({ type: "tool.completed", status: "failed", failureCode: "tool_input_invalid" }));
		expect(authorize).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});
});
