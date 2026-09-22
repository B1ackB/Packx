import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentHostTool, AgentMessage, AgentModelProvider, AgentModelRequest } from "../../src/agent/contracts";
import { ContextEngine } from "../../src/agent/context";
import { SkillRegistry } from "../../src/agent/skills";
import { BlackxAgentRuntime } from "./agentRuntime";
import { contextReadTool, type pageUnits } from "./contextRead";
import { FileAgentStateStore } from "./fileAgentStateStore";

// Mechanism audit only. This deliberately lossy Fake cannot prove semantic summary quality.
const now = "2026-09-22T12:00:00.000Z";
const usage = { inputTokens: 10, outputTokens: 8, cachedInputTokens: 0, reasoningOutputTokens: 0 };
const scope = { tenantId: "continuation-tenant", workspaceId: "continuation-workspace", runId: "continuation-run", sessionId: "continuation-session" };
const request = { ...scope, actorId: "auditor", stageId: "conversation", idempotencyKey: "initial", input: "Original requirement: no PVC; supplier conditions remain unresolved.", fallbackOutput: "done", policy: { sandboxMode: "read-only" as const, approvalPolicy: "never" as const, timeoutMs: 10_000 } };
const execution = { ...request, executionId: "readback-execution", toolCallId: "readback-call", signal: new AbortController().signal };
const originals = {
	a: "SOURCE-A: 100 µm, not 100 mm; no PVC. Test: 23 °C / 50% RH. Supplier value is unverified.",
	b: "SOURCE-B: quote excludes freight; 5,000 bags is a proposal, not approval. Test method remains unresolved.",
};
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "packx-continuation-audit-"));
	roots.push(root);
	const state = new FileAgentStateStore(root);
	state.save(scope, 0, [], now);
	return { root, state };
}

function runtime(state: FileAgentStateStore, provider: AgentModelProvider, extra: Partial<ConstructorParameters<typeof BlackxAgentRuntime>[0]> = {}) {
	return new BlackxAgentRuntime({ skills: new SkillRegistry(), sessions: state, snapshots: state, traces: state, executions: state, provider, now: () => now, ...extra });
}

function assertOriginalBatch(messages: readonly AgentMessage[]) {
	const related = messages.filter((message) => message.toolCalls?.some((call) => ["source-a", "source-b"].includes(call.id)) || ["source-a", "source-b"].includes(message.toolCallId ?? ""));
	if (!related.length) return;
	expect(related).toHaveLength(3);
	const start = messages.indexOf(related[0]);
	expect(messages.slice(start, start + 3)).toEqual(related);
	expect(related[0].role).toBe("assistant");
	expect(related[0].toolCalls?.map((call) => call.id)).toEqual(["source-a", "source-b"]);
	expect(related.slice(1).map((message) => message.toolCallId)).toEqual(["source-a", "source-b"]);
	for (const [index, key] of (["a", "b"] as const).entries()) expect(JSON.parse(related[index + 1].content)).toEqual({ body: originals[key] });
}

async function governedHistory() {
	const { root, state } = fixture();
	let available = true;
	const validateContextResult = vi.fn((input: unknown, output: string) => {
		if (!available) throw new Error("source_revoked");
		expect(JSON.parse(output)).toEqual({ body: originals[(input as { id: keyof typeof originals }).id] });
	});
	const source: AgentHostTool = {
		name: "source_read", description: "Synthetic governed original", execution: "host", risk: "read", idempotent: true, timeoutMs: 1000, maxResultChars: 2000,
		inputSchema: { type: "object", properties: { id: { enum: ["a", "b"] } }, required: ["id"], additionalProperties: false },
		validate: (input) => !!input && typeof input === "object" && "id" in input && ["a", "b"].includes(String(input.id)),
		execute: async (input) => ({ body: originals[(input as { id: keyof typeof originals }).id] }), validateContextResult,
	};
	let calls = 0;
	const initial: AgentModelProvider = { generate: async (input) => {
		assertOriginalBatch(input.messages);
		return ++calls === 1
			? { text: "", toolCalls: ["a", "b"].map((id) => ({ id: `source-${id}`, name: source.name, input: { id } })), usage }
			: { text: "Original sources inspected; no permission or fact was upgraded.", toolCalls: [], usage };
	} };
	await runtime(state, initial, { tools: [source] }).executeTurn({ ...request, allowedTools: [source.name] });
	expect(calls).toBe(2);
	return { root, source, validateContextResult, revoke: () => { available = false; } };
}

function continuationProvider() {
	return { generate: vi.fn(async (input: AgentModelRequest) => {
		if (input.callContext?.purpose === "summary") return { text: "Earlier work exists. This Fake deliberately omits the source details; verify original records.", toolCalls: [], usage };
		assertOriginalBatch(input.messages);
		return { text: "Continuation completed without changing authoritative facts.", toolCalls: [], usage };
	}) };
}

type Page<T> = ReturnType<typeof pageUnits<T>> & { sourceRef: string; status: string };

it.each([3, 5, 10])("keeps exact originals and complete tool batches reachable across %s actual compactions and Store restarts", async (rounds) => {
	const h = await governedHistory();
	const provider = continuationProvider();
	const archiveRefs: string[] = [];
	for (let index = 0; index < rounds; index++) {
		const state = new FileAgentStateStore(h.root);
		const result = await runtime(state, provider, { tools: [h.source], context: new ContextEngine(100) }).executeTurn({ ...request, idempotencyKey: `continuation-${index}`, input: `Continue ${index}; retain original uncertainty.` });
		expect(result.events.filter((event) => event.type === "context.compacted" && event.removedMessages > 0)).toHaveLength(1);
		const summaries = state.load(scope).messages.filter((message) => message.kind === "summary");
		expect(summaries).toHaveLength(1);
		expect(summaries[0].readDependencies).toHaveLength(1);
		const ref = summaries[0].readDependencies![0];
		archiveRefs.push(ref);
		const archived = new FileAgentStateStore(h.root).read(scope, ref);
		assertOriginalBatch(archived.messages);
		if (index) expect(archived.messages.some((message) => message.readDependencies?.includes(archiveRefs[index - 1]))).toBe(true);
	}
	expect(new Set(archiveRefs).size).toBe(rounds);
	expect(provider.generate.mock.calls.filter(([input]) => input.callContext?.purpose === "summary")).toHaveLength(rounds);

	// Follow only the references exposed by the current working summary and context_read.
	const restarted = new FileAgentStateStore(h.root);
	const read = contextReadTool(scope, restarted, restarted, () => {});
	let references = restarted.load(scope).messages.flatMap((message) => message.readDependencies ?? []);
	const traversed: string[] = [];
	const recovered: AgentMessage[] = [];
	while (references.length) {
		const ref = references.shift()!;
		expect(traversed).not.toContain(ref);
		traversed.push(ref);
		expect(traversed.length).toBeLessThanOrEqual(rounds);
		const page = await read.execute({ sourceRef: ref }, execution) as Page<AgentMessage>;
		expect(page).toMatchObject({ status: "historical_unverified", truncated: false, nextOffset: null });
		assertOriginalBatch(page.items);
		recovered.push(...page.items);
		references = [...references, ...page.items.flatMap((message) => message.readDependencies ?? [])];
	}
	expect(traversed).toEqual([...archiveRefs].reverse());
	for (const [key, body] of Object.entries(originals)) expect(recovered.find((message) => message.toolCallId === `source-${key}`)?.content).toBe(JSON.stringify({ body }));
	const transcript = await read.execute({ sourceRef: "transcript" }, execution) as Page<AgentMessage>;
	expect(transcript.items.find((message) => message.role === "user")?.content).toBe(request.input);
	expect(transcript.items.filter((message) => message.kind === "summary")).toHaveLength(0);

	h.revoke();
	const generate = vi.fn(async () => ({ text: "must not run", toolCalls: [], usage }));
	const countTokens = vi.fn(async () => 10);
	await expect(runtime(new FileAgentStateStore(h.root), { generate, countTokens }, { tools: [h.source] }).executeTurn({ ...request, idempotencyKey: "after-revocation", input: "Continue" })).rejects.toMatchObject({ code: "context_failure", retryable: false });
	expect(generate).not.toHaveBeenCalled();
	expect(countTokens).not.toHaveBeenCalled();
	expect(h.validateContextResult).toHaveBeenCalled();
});

it("reproduces the oversized single-line readback limit through actual compression and a disk restart", async () => {
	const { root, state } = fixture();
	const original = `Do not change 100 µm; no PVC; ${"source evidence ".repeat(2000)}`;
	state.save(scope, 1, [{ role: "user", kind: "dialogue", messageId: "oversized-original", content: original }], now);
	const provider = continuationProvider();
	const result = await runtime(state, provider, { context: new ContextEngine(100) }).executeTurn({ ...request, input: "Continue the previous discussion." });
	expect(result.events.some((event) => event.type === "context.compacted" && event.removedMessages === 1)).toBe(true);
	expect(provider.generate.mock.calls.filter(([input]) => input.callContext?.purpose === "summary")).toHaveLength(0);
	const restarted = new FileAgentStateStore(root);
	const summary = restarted.load(scope).messages.find((message) => message.kind === "summary")!;
	expect(summary.content).toContain("INCOMPLETE");
	const sourceRef = summary.readDependencies![0];
	expect(restarted.read(scope, sourceRef).messages[0].content).toBe(original);
	expect(restarted.load(scope).transcript![0].content).toBe(original);
	const read = contextReadTool(scope, restarted, restarted, () => {});
	for (const ref of [sourceRef, "transcript"]) for (const selection of [{}, { messageIndex: 0 }]) {
		const page = await read.execute({ sourceRef: ref, ...selection }, execution) as Page<unknown>;
		expect(page).toMatchObject({ items: [], error: "single_unit_exceeds_budget", truncated: true, nextOffset: 0 });
	}
	// Coverage describes the immediate source messages, not inherited omissions.
	// A later lossy summary can say complete while the original is still unreadable.
	for (let index = 1; index <= 2; index++) await runtime(new FileAgentStateStore(root), provider, { context: new ContextEngine(100) }).executeTurn({ ...request, idempotencyKey: `oversized-continued-${index}`, input: `Continue ${index}.` });
	const laterSummary = new FileAgentStateStore(root).load(scope).messages.find((message) => message.kind === "summary")!;
	expect(laterSummary.content).toContain("Coverage: complete");
	expect(laterSummary.content).not.toContain("INCOMPLETE");
	const stillBlocked = await read.execute({ sourceRef, messageIndex: 0 }, execution) as Page<unknown>;
	expect(stillBlocked).toMatchObject({ error: "single_unit_exceeds_budget", nextOffset: 0 });
});

it("reads every original row from an actually externalized tool result after ten compactions and restarts", async () => {
	const { root, state } = fixture();
	const rows = Array.from({ length: 160 }, (_, index) => ({ id: `original-${index}`, text: `固定资料 ${index}: ${"供应商声明未经确认；".repeat(25)}`, thickness: "100 µm", condition: "23 °C / 50% RH", approved: false }));
	let available = true;
	const source: AgentHostTool = {
		name: "rows_read", description: "Synthetic large source", execution: "host", risk: "read", idempotent: true, timeoutMs: 1000, maxResultChars: 1000,
		inputSchema: { type: "object" }, validate: () => true, execute: async () => ({ rows }),
		validateContextResult: (_input, output) => { if (!available) throw new Error("source_revoked"); expect(JSON.parse(output)).toEqual({ rows }); },
	};
	let calls = 0;
	await runtime(state, { generate: async () => ++calls === 1
		? { text: "", toolCalls: [{ id: "large-original", name: source.name, input: {} }], usage }
		: { text: "The full source was archived without claiming confirmation.", toolCalls: [], usage },
	}, { tools: [source] }).executeTurn({ ...request, allowedTools: [source.name] });
	const originalResult = state.load(scope).messages.find((message) => message.toolCallId === "large-original")!;
	expect(JSON.parse(originalResult.content)).toMatchObject({ status: "body_externalized", readTool: "context_read", truncated: true });
	const provider = continuationProvider();
	for (let index = 0; index < 10; index++) await runtime(new FileAgentStateStore(root), provider, { tools: [source], context: new ContextEngine(100) }).executeTurn({ ...request, idempotencyKey: `externalized-${index}`, input: `Continue ${index}.` });
	const restarted = new FileAgentStateStore(root);
	const read = contextReadTool(scope, restarted, restarted, () => {});
	let ref = restarted.load(scope).messages.find((message) => message.kind === "summary")!.readDependencies![0];
	for (let depth = 0; depth < 10; depth++) {
		const page = await read.execute({ sourceRef: ref }, execution) as Page<AgentMessage>;
		expect(page.truncated).toBe(false);
		const toolResult = page.items.find((message) => message.toolCallId === "large-original");
		if (depth === 9) {
			expect(toolResult).toBeDefined();
			expect(page.items.some((message) => message.role === "assistant" && message.toolCalls?.[0].id === "large-original")).toBe(true);
			ref = JSON.parse(toolResult!.content).sourceRef;
		} else ref = page.items.find((message) => message.kind === "summary")!.readDependencies![0];
	}
	const recovered: unknown[] = [];
	let offset = 0, pages = 0;
	while (true) {
		const page = await read.execute({ sourceRef: ref, messageIndex: 0, jsonPointer: "/rows", offset }, execution) as Page<unknown>;
		expect(page.items.length).toBeGreaterThan(0);
		expect(JSON.stringify(page).length).toBeLessThan(read.maxResultChars);
		recovered.push(...page.items); pages++;
		if (page.nextOffset === null) break;
		expect(page.nextOffset).toBeGreaterThan(offset);
		offset = page.nextOffset;
		expect(pages).toBeLessThan(rows.length);
	}
	expect(pages).toBeGreaterThan(1);
	expect(recovered).toEqual(rows);
	available = false;
	const generate = vi.fn(async () => ({ text: "must not run", toolCalls: [], usage }));
	await expect(runtime(new FileAgentStateStore(root), { generate }, { tools: [source] }).executeTurn({ ...request, idempotencyKey: "externalized-revoked", input: "Continue" })).rejects.toMatchObject({ code: "context_failure", retryable: false });
	expect(generate).not.toHaveBeenCalled();
});

it("accepts 128 real compression dependencies but stops the next turn when compaction creates dependency 129", async () => {
	const h = await governedHistory();
	const provider = continuationProvider();
	for (let index = 0; index < 128; index++) {
		const state = new FileAgentStateStore(h.root);
		const result = await runtime(state, provider, { tools: [h.source], context: new ContextEngine(100) }).executeTurn({ ...request, idempotencyKey: `boundary-${index}`, input: `Continue ${index}; preserve uncertainty.` });
		expect(result.status).toBe("completed");
		expect(result.events.filter((event) => event.type === "context.compacted" && event.removedMessages > 0)).toHaveLength(1);
	}
	expect(provider.generate.mock.calls.filter(([input]) => input.callContext?.purpose === "summary")).toHaveLength(128);
	const before = new FileAgentStateStore(h.root).load(scope);
	const blocked = continuationProvider();
	await expect(runtime(new FileAgentStateStore(h.root), blocked, { tools: [h.source], context: new ContextEngine(100) }).executeTurn({ ...request, idempotencyKey: "boundary-129", input: "Continue at the boundary." })).rejects.toMatchObject({ code: "context_failure", retryable: false });
	// The 128 existing dependencies were valid: the failing turn can summarize,
	// but its new 129-deep working chain must not reach the main model.
	expect(blocked.generate.mock.calls.filter(([input]) => input.callContext?.purpose === "turn")).toHaveLength(0);
	expect(blocked.generate.mock.calls.filter(([input]) => input.callContext?.purpose === "summary")).toHaveLength(1);
	expect(new FileAgentStateStore(h.root).load(scope).messages).toEqual(before.messages);
}, 30_000);
