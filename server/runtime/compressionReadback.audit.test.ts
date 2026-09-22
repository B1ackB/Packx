import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentHostTool, AgentMessage, AgentModelProvider, AgentModelRequest } from "../../src/agent/contracts";
import { ContextEngine } from "../../src/agent/context";
import { AgentHooks } from "../../src/agent/hooks";
import { SkillRegistry } from "../../src/agent/skills";
import { ModelContextSummarizer } from "../../src/agent/summarizer";
import { BlackxAgentRuntime } from "./agentRuntime";
import { ConversationApiController } from "./conversationApi";
import { contextReadTool, pageUnits } from "./contextRead";
import { FileAgentStateStore } from "./fileAgentStateStore";
import { buildTaskContext } from "../enterprise/taskContext";
import { checkpointSourceDigest, TaskCheckpointStore } from "../enterprise/taskCheckpointStore";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const now = "2026-09-22T01:00:00.000Z";
const usage = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 0, reasoningOutputTokens: 0 };
const scope = { tenantId: "audit-tenant", workspaceId: "audit-workspace", runId: "audit-run", sessionId: "audit-session" };
const request = { ...scope, actorId: "audit-user", stageId: "conversation", idempotencyKey: "audit-turn", input: "Read the archived source", fallbackOutput: "done", policy: { sandboxMode: "read-only" as const, approvalPolicy: "never" as const, timeoutMs: 5000 } };
const execution = { ...request, executionId: "audit-execution", toolCallId: "audit-call", signal: new AbortController().signal };

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "packx-compression-audit-"));
	roots.push(root);
	const state = new FileAgentStateStore(root);
	state.save(scope, 0, [], now);
	return { root, state };
}

function archive(state: FileAgentStateStore, snapshotId: string, messages: AgentMessage[], bindings: { contextBinding?: string; historyBinding?: string } = {}) {
	return state.put({ ...scope, ...bindings, schemaVersion: "context-snapshot.v2", snapshotId, iteration: 1, skills: [], messages, estimatedChars: JSON.stringify(messages).length, estimatedTokens: 0, removedMessages: 0, createdAt: now });
}

function runtime(state: FileAgentStateStore, provider: AgentModelProvider, extra: Partial<ConstructorParameters<typeof BlackxAgentRuntime>[0]> = {}) {
	return new BlackxAgentRuntime({ skills: new SkillRegistry(), sessions: state, snapshots: state, traces: state, executions: state, provider, now: () => now, ...extra });
}

it.each([0, 1, 3])("revalidates a context_read result after restart and %s later compactions", async (compactions) => {
	const { root, state } = fixture();
	let available = true;
	const validateContextResult = vi.fn(() => { if (!available) throw new Error("source_revoked"); });
	const source: AgentHostTool = { name: "source_read", description: "Synthetic governed source", execution: "host", risk: "read", idempotent: true, timeoutMs: 1000, maxResultChars: 1000, inputSchema: { type: "object" }, validate: () => true, execute: async () => ({ text: "SOURCE-A: 100 µm; no PVC" }), validateContextResult };
	archive(state, "source-a", [{ role: "tool", content: "SOURCE-A: 100 µm; no PVC", sourceTool: { name: "source_read", input: { source: "a" } } }]);
	let calls = 0;
	const provider: AgentModelProvider = { generate: async (input) => {
		if (input.callContext?.purpose === "summary") return { text: "Unverified working note from SOURCE-A.", toolCalls: [], usage };
		calls++;
		return calls === 1
			? { text: "", toolCalls: [{ id: "read-archive", name: "context_read", input: { sourceRef: "source-a", messageIndex: 0 } }], usage }
			: { text: "The archived source was read.", toolCalls: [], usage };
	} };
	// Only context_read is allowed; the origin tool remains available to Host validation.
	await runtime(state, provider, { tools: [source] }).executeTurn({ ...request, idempotencyKey: "read-governed-source" });
	expect(validateContextResult).toHaveBeenCalled();
	for (let index = 0; index < compactions; index++) {
		const result = await runtime(state, provider, { tools: [source], context: new ContextEngine(100) }).executeTurn({ ...request, idempotencyKey: `compress-readback-${index}`, input: "Continue using the readback" });
		expect(result.events.some((event) => event.type === "context.compacted" && event.removedMessages > 0)).toBe(true);
	}
	available = false;
	const generate = vi.fn(async () => ({ text: "This provider must not receive revoked material", toolCalls: [], usage }));
	await expect(runtime(new FileAgentStateStore(root), { generate }, { tools: [source] }).executeTurn({ ...request, idempotencyKey: "after-revocation", input: "Continue" })).rejects.toMatchObject({ code: "context_failure", retryable: false });
	expect(generate).not.toHaveBeenCalled();
});

it("can restore transcript readback without treating transcript as a missing snapshot", async () => {
	const { root, state } = fixture();
	state.save(scope, 1, [{ role: "user", kind: "dialogue", messageId: "original-user", content: "Original requirement: no PVC" }], now);
	const requests: AgentModelRequest[] = [];
	const provider: AgentModelProvider = { generate: async (input) => {
		requests.push(input);
		return requests.length === 1
			? { text: "", toolCalls: [{ id: "read-transcript", name: "context_read", input: { sourceRef: "transcript" } }], usage }
			: { text: "Original dialogue inspected.", toolCalls: [], usage };
	} };
	const taskContext = { binding: "task-v1", historyBinding: "history-v1", content: "Current state remains authoritative" };
	await runtime(state, provider).executeTurn({ ...request, taskContext });
	expect(requests.at(-1)?.messages.some((message) => message.role === "tool" && message.content.includes("Original requirement: no PVC"))).toBe(true);
	const generate = vi.fn(async () => ({ text: "done", toolCalls: [], usage }));
	expect((await runtime(new FileAgentStateStore(root), { generate }).executeTurn({ ...request, idempotencyKey: "after-transcript-read", input: "Continue", taskContext })).status).toBe("completed");
	expect(generate).toHaveBeenCalledTimes(1);
});

it.each([false, true])("revalidates persisted pre-fix context_read batches on upgrade (archived=%s)", async (archived) => {
	const { root, state } = fixture();
	archive(state, "legacy-source", [{ role: "tool", content: "SOURCE-A: 100 µm; no PVC", sourceTool: { name: "source_read", input: { source: "a" } } }]);
	const input = { sourceRef: "legacy-source", messageIndex: 0 };
	const result = await contextReadTool(scope, state, state, () => {}).execute(input, execution);
	// Baseline da4fcd1 persisted this complete call/result pair without sourceTool.
	const legacy: AgentMessage[] = [
		{ role: "assistant", content: "", toolCalls: [{ id: "legacy-read", name: "context_read", input }] },
		{ role: "tool", content: JSON.stringify(result), toolCallId: "legacy-read" },
	];
	if (archived) archive(state, "legacy-compact", legacy);
	state.save(scope, 1, archived ? [{ role: "user", kind: "summary", content: "Old unverified note from SOURCE-A", readDependencies: ["legacy-compact"] }] : legacy, now);
	const source: AgentHostTool = { name: "source_read", description: "Revoked synthetic source", execution: "host", risk: "read", idempotent: true, timeoutMs: 1000, maxResultChars: 1000, inputSchema: { type: "object" }, validate: () => true, execute: async () => ({}), validateContextResult: () => { throw new Error("source_revoked"); } };
	const generate = vi.fn(async () => ({ text: "Must not see pre-fix revoked data", toolCalls: [], usage }));
	await expect(runtime(new FileAgentStateStore(root), { generate }, { tools: [source] }).executeTurn(request)).rejects.toMatchObject({ code: "context_failure", retryable: false });
	expect(generate).not.toHaveBeenCalled();
});

it("matches legacy readback to its own tool batch when a later turn reuses the same call ID", async () => {
	const { state } = fixture();
	archive(state, "revoked-source", [{ role: "tool", content: "Old revoked evidence", sourceTool: { name: "source_read", input: {} } }]);
	archive(state, "valid-source", [{ role: "user", content: "New independent source" }]);
	const messages: AgentMessage[] = [];
	for (const sourceRef of ["revoked-source", "valid-source"]) {
		const input = { sourceRef };
		const result = await contextReadTool(scope, state, state, () => {}).execute(input, execution);
		messages.push({ role: "assistant", content: "", toolCalls: [{ id: "reused-call-id", name: "context_read", input }] }, { role: "tool", toolCallId: "reused-call-id", content: JSON.stringify(result) });
	}
	state.save(scope, 1, messages, now);
	const source: AgentHostTool = { name: "source_read", description: "Revoked source", execution: "host", risk: "read", idempotent: true, timeoutMs: 1000, maxResultChars: 1000, inputSchema: { type: "object" }, validate: () => true, execute: async () => ({}), validateContextResult: () => { throw new Error("source_revoked"); } };
	const generate = vi.fn(async () => ({ text: "must not run", toolCalls: [], usage }));
	await expect(runtime(state, { generate }, { tools: [source] }).executeTurn(request)).rejects.toMatchObject({ code: "context_failure", retryable: false });
	expect(generate).not.toHaveBeenCalled();
});

it("lets the model handle a failed context_read without treating its error as successful legacy material", async () => {
	const { state } = fixture();
	const requests: AgentModelRequest[] = [];
	const generate = vi.fn(async (input: AgentModelRequest) => {
		requests.push(input);
		return requests.length === 1
			? { text: "", toolCalls: [{ id: "unavailable-read", name: "context_read", input: { sourceRef: "does-not-exist" } }], usage }
			: { text: "That source is unavailable; current facts remain unchanged.", toolCalls: [], usage };
	});
	const result = await runtime(state, { generate }).executeTurn(request);
	expect(result.status).toBe("completed");
	expect(generate).toHaveBeenCalledTimes(2);
	const failed = requests[1].messages.find((message) => message.toolCallId === "unavailable-read");
	expect(JSON.parse(failed!.content)).toMatchObject({ ok: false, error: { code: "tool_execution_failed" } });
});

it("revalidates a pre-fix externalized readback singleton that has no paired call or sourceTool", async () => {
	const { state } = fixture();
	archive(state, "singleton-origin", [{ role: "tool", content: "REVOKED-SINGLETON: " + "supplier evidence ".repeat(300), sourceTool: { name: "source_read", input: {} } }]);
	const output = await contextReadTool(scope, state, state, () => {}).execute({ sourceRef: "singleton-origin", messageIndex: 0 }, execution);
	// Before the fix, externalizeToolResult archived this successful readback without source metadata.
	archive(state, "legacy-singleton", [{ role: "tool", content: JSON.stringify(output) }]);
	state.save(scope, 1, [{ role: "user", kind: "summary", content: "Old readback note", readDependencies: ["legacy-singleton"] }], now);
	const source: AgentHostTool = { name: "source_read", description: "Revoked origin", execution: "host", risk: "read", idempotent: true, timeoutMs: 1000, maxResultChars: 1000, inputSchema: { type: "object" }, validate: () => true, execute: async () => ({}), validateContextResult: () => { throw new Error("source_revoked"); } };
	const generate = vi.fn(async () => ({ text: "must not run", toolCalls: [], usage }));
	await expect(runtime(state, { generate }, { tools: [source] }).executeTurn(request)).rejects.toMatchObject({ code: "context_failure", retryable: false });
	expect(generate).not.toHaveBeenCalled();
});

it("uses the confirmed checkpoint through ConversationApi after raw user history exceeds 64k", async () => {
	const { state } = fixture();
	const target = { ...scope, runId: "conversation-long-audit", sessionId: "conversation-long-audit" };
	state.createSession(target, now);
	const original: AgentMessage[] = Array.from({ length: 80 }, (_, index) => ({ role: "user", kind: "dialogue", messageId: `long-${index}`, content: `Old user statement ${index}: ${"原始讨论".repeat(200)}` }));
	state.save(target, 1, original, now);
	const checkpoints = new TaskCheckpointStore(":memory:", () => now);
	try {
		const currentContext = () => {
			const transcript = state.load(target).transcript!;
			return buildTaskContext({ scope: target, objective: transcript.at(-1)!.content, transcript, checkpoint: checkpoints.active(target, transcript) });
		};
		const generate = vi.fn(async () => ({ text: "Confirmed requirements applied.", toolCalls: [], usage }));
		const agent = runtime(state, { generate }, { readTaskContext: currentContext });
		const api = new ConversationApiController(agent, state, undefined, undefined, [], undefined, undefined, undefined, undefined, currentContext);
		const identity = { ...scope, actorId: "audit-user" };
		const blocked = await api.send(identity, target.sessionId, { messageId: "blocked-long-turn", content: "Continue the current task" });
		expect(blocked).toMatchObject({ status: 502, body: { code: "budget_exceeded", retryable: false } });
		expect(generate).not.toHaveBeenCalled();
		const transcript = state.load(target).transcript!;
		checkpoints.command(target, identity.actorId, transcript, { action: "propose", requestId: "prepare-long", revision: 0, sourceDigest: checkpointSourceDigest(transcript), draft: { objective: "Compare current candidates", constraints: ["No PVC"], openQuestions: ["Supplier test conditions"], progressNotes: "Original discussion remains available" } });
		expect(checkpoints.active(target, transcript)).toBeUndefined();
		checkpoints.command(target, identity.actorId, transcript, { action: "confirm", requestId: "confirm-long", revision: 1, confirmed: true });
		const continued = await api.send(identity, target.sessionId, { messageId: "after-checkpoint", content: "List the unresolved supplier questions" });
		expect(continued.status).toBe(200);
		expect(generate).toHaveBeenCalledTimes(1);
		expect(currentContext().content.length).toBeLessThan(5000);
		expect(state.load(target).transcript?.slice(0, original.length).map((message) => message.content)).toEqual(original.map((message) => message.content));
	} finally { checkpoints.close(); }
});

it("keeps the current pending user image when checkpoint confirmation rebuilds a resumed API turn", async () => {
	const { state } = fixture();
	const previous: AgentMessage = { role: "user", kind: "dialogue", messageId: "covered", content: "Old requirement that the checkpoint replaces" };
	const checkpoints = new TaskCheckpointStore(":memory:", () => now);
	try {
		checkpoints.command(scope, request.actorId, [previous], { action: "propose", requestId: "prepare-image", revision: 0, sourceDigest: checkpointSourceDigest([previous]), draft: { objective: "Review this packaging image", constraints: ["Do not infer production dimensions"], openQuestions: [], progressNotes: "" } });
		checkpoints.command(scope, request.actorId, [previous], { action: "confirm", requestId: "confirm-image", revision: 1, confirmed: true });
		const current: AgentMessage = { role: "user", kind: "dialogue", messageId: "current-image-turn", content: "Describe this new image", pinned: true, attachments: [{ type: "image", name: "synthetic.png", mediaType: "image/png", sourceRef: "attachment://audit-run/attachment-12345678", sha256: "a".repeat(64) }] };
		state.save(scope, 1, [previous, current], now);
		const generate = vi.fn(async (_input: AgentModelRequest) => ({ text: "Synthetic image inspected.", toolCalls: [], usage }));
		const taskContext = buildTaskContext({ scope, objective: current.content, transcript: [previous, current], checkpoint: checkpoints.active(scope, [previous, current]) });
		const result = await runtime(state, { generate }, { resolveImageAttachment: async (_target, image) => ({ ...image, data: "c3ludGhldGlj" }) }).executeTurn({ ...request, idempotencyKey: current.messageId!, input: "", resume: true, taskContext });
		expect(result.status).toBe("completed");
		const messages = generate.mock.calls[0]?.[0]?.messages ?? [];
		expect(messages.some((message: AgentMessage) => message.messageId === current.messageId && message.attachments?.[0]?.data === "c3ludGhldGlj")).toBe(true);
		expect(messages.some((message: AgentMessage) => message.messageId === previous.messageId)).toBe(false);
	} finally { checkpoints.close(); }
});

it("fences concurrent checkpoint commands and source metadata changes across store instances", () => {
	const { root } = fixture();
	const first = new TaskCheckpointStore(join(root, "checkpoint.sqlite"), () => now);
	const second = new TaskCheckpointStore(join(root, "checkpoint.sqlite"), () => now);
	try {
		const transcript: AgentMessage[] = [{ role: "user", kind: "dialogue", messageId: "review-source", content: "Use this attachment", sources: [{ name: "supplier.txt", mediaType: "text/plain", sourceRef: "attachment://audit-run/attachment-12345678", sha256: "a".repeat(64) }] }];
		first.command(scope, request.actorId, transcript, { action: "propose", requestId: "review-concurrent", revision: 0, sourceDigest: checkpointSourceDigest(transcript), draft: { objective: "Check supplier data", constraints: [], openQuestions: [], progressNotes: "" } });
		const command = { action: "confirm", requestId: "confirm-concurrent", revision: 1, confirmed: true };
		const changed = transcript.map((message) => ({ ...message, sources: message.sources?.map((source) => ({ ...source, sha256: "b".repeat(64) })) }));
		expect(() => second.command(scope, request.actorId, changed, command)).toThrow("task_checkpoint_source_changed");
		expect(first.read(scope).revision).toBe(1);
		expect(() => second.command(scope, request.actorId, transcript, { ...command, revision: 0 })).toThrow("task_checkpoint_revision_conflict");
		const confirmed = second.command(scope, request.actorId, transcript, command);
		expect(confirmed.versions[0].status).toBe("active");
		expect(first.command(scope, request.actorId, transcript, command)).toEqual(confirmed);
	} finally { second.close(); first.close(); }
});

it("bounds cyclic snapshot validation without skipping a revoked source in the same archive", async () => {
	const { state } = fixture();
	archive(state, "cycle-a", [{ role: "tool", content: "readback B", sourceTool: { name: "context_read", input: { sourceRef: "cycle-b" } } }]);
	archive(state, "cycle-b", [
		{ role: "user", kind: "summary", content: "Older A note", readDependencies: ["cycle-a"] },
		{ role: "tool", content: "revoked", sourceTool: { name: "source_read", input: {} } },
	]);
	state.save(scope, 1, [{ role: "tool", content: "readback A", sourceTool: { name: "context_read", input: { sourceRef: "cycle-a" } } }], now);
	const reads = vi.spyOn(state, "read");
	const validateContextResult = vi.fn(() => { throw new Error("source_revoked"); });
	const source: AgentHostTool = { name: "source_read", description: "Revoked source", execution: "host", risk: "read", idempotent: true, timeoutMs: 1000, maxResultChars: 1000, inputSchema: { type: "object" }, validate: () => true, execute: async () => ({}), validateContextResult };
	const generate = vi.fn(async () => ({ text: "must not run", toolCalls: [], usage }));
	await expect(runtime(state, { generate }, { tools: [source] }).executeTurn(request)).rejects.toMatchObject({ code: "context_failure" });
	expect(validateContextResult).toHaveBeenCalledTimes(1);
	expect(reads).toHaveBeenCalledTimes(2);
	expect(generate).not.toHaveBeenCalled();
});

it("fails closed at the shared 128 snapshot dependency limit before calling the model", async () => {
	const { state } = fixture();
	for (let index = 0; index < 129; index++) archive(state, `chain-${index}`, index < 128
		? [{ role: "tool", content: "prior readback", sourceTool: { name: "context_read", input: { sourceRef: `chain-${index + 1}` } } }]
		: [{ role: "user", content: "oldest source" }]);
	state.save(scope, 1, [{ role: "tool", content: "chain root", sourceTool: { name: "context_read", input: { sourceRef: "chain-0" } } }], now);
	const reads = vi.spyOn(state, "read");
	const generate = vi.fn(async () => ({ text: "must not run", toolCalls: [], usage }));
	await expect(runtime(state, { generate }).executeTurn(request)).rejects.toMatchObject({ code: "context_failure" });
	expect(reads).toHaveBeenCalledTimes(128);
	expect(generate).not.toHaveBeenCalled();
});

it.each([{ compact: false, counted: false }, { compact: true, counted: false }, { compact: false, counted: true }])("rechecks a source revoked between readback and the next model request (%j)", async ({ compact, counted }) => {
	const { state } = fixture();
	let available = true;
	archive(state, "mid-turn-source", [{ role: "tool", content: "SOURCE-A: 100 µm; no PVC", sourceTool: { name: "source_read", input: {} } }]);
	const source: AgentHostTool = { name: "source_read", description: "Synthetic source", execution: "host", risk: "read", idempotent: true, timeoutMs: 1000, maxResultChars: 1000, inputSchema: { type: "object" }, validate: () => true, execute: async () => ({}), validateContextResult: () => { if (!available) throw new Error("source_revoked"); } };
	const hooks = new AgentHooks();
	hooks.on("tool.after", (event) => { if (event.call.name === "context_read") available = false; });
	const generate = vi.fn(async (input: AgentModelRequest) => {
		if (input.callContext?.purpose === "summary") return { text: "Unverified SOURCE-A note.", toolCalls: [], usage };
		return available
			? { text: "", toolCalls: [{ id: "read-before-revocation", name: "context_read", input: { sourceRef: "mid-turn-source" } }], usage }
			: { text: "Must not receive data revoked before this call", toolCalls: [], usage };
	});
	const countTokens = vi.fn(async (_input: AgentModelRequest) => 100);
	await expect(runtime(state, { generate, ...(counted ? { countTokens } : {}) }, { tools: [source], hooks, ...(compact ? { context: new ContextEngine(100) } : {}) }).executeTurn(request)).rejects.toMatchObject({ code: "context_failure", retryable: false });
	expect(generate).toHaveBeenCalledTimes(1);
	expect(countTokens).toHaveBeenCalledTimes(counted ? 1 : 0);
});

it("rechecks after a token count so revocation before generation cannot reuse the earlier validation", async () => {
	const { state } = fixture();
	let available = true;
	state.save(scope, 1, [{ role: "tool", content: "Old evidence", sourceTool: { name: "source_read", input: {} } }], now);
	const source: AgentHostTool = { name: "source_read", description: "Source changes after count", execution: "host", risk: "read", idempotent: true, timeoutMs: 1000, maxResultChars: 1000, inputSchema: { type: "object" }, validate: () => true, execute: async () => ({}), validateContextResult: () => { if (!available) throw new Error("source_revoked"); } };
	const countTokens = vi.fn(async () => { available = false; return 100; });
	const generate = vi.fn(async () => ({ text: "must not run", toolCalls: [], usage }));
	await expect(runtime(state, { countTokens, generate }, { tools: [source] }).executeTurn(request)).rejects.toMatchObject({ code: "context_failure", retryable: false });
	expect(countTokens).toHaveBeenCalledTimes(1);
	expect(generate).not.toHaveBeenCalled();
});

it.each([0, 100, 500, 1000, 3000, 10_000])("keeps complete tool batches atomic and unfinished calls intact at %s characters", (budget) => {
	const context = new ContextEngine(budget);
	const complete: AgentMessage[] = [
		{ role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", input: {} }, { id: "b", name: "read", input: {} }] },
		{ role: "tool", toolCallId: "a", content: "A".repeat(1100), archivedContent: "archive-a" },
		{ role: "tool", toolCallId: "b", content: "B".repeat(1100), archivedContent: "archive-b" },
	];
	const open: AgentMessage[] = [
		{ role: "assistant", content: "", toolCalls: [{ id: "c", name: "read", input: {} }, { id: "d", name: "read", input: {} }] },
		{ role: "tool", toolCallId: "c", content: "C".repeat(1200), archivedContent: "archive-c" },
	];
	const history: AgentMessage[] = [{ role: "system", content: "Must retain policy", pinned: true }, ...complete, { role: "user", content: "Continue" }, ...open];
	const result = context.compact(history);
	expect(result.messages).toContain(history[0]);
	expect(complete.filter((message) => result.messages.includes(message)).length).toBe(result.messages.includes(complete[0]) ? 3 : 0);
	for (const message of open) expect(result.messages).toContain(message);
	expect(context.pruneToolBodies(history).find((message) => message.toolCallId === "c")?.content).toBe(open[1].content);
});

it("reconstructs every archived JSON row exactly by following bounded continuation offsets", async () => {
	const { state } = fixture();
	const rows = Array.from({ length: 160 }, (_, index) => ({ id: `row-${index}`, text: `Original row ${index}: ${"资料".repeat(160)}`, thickness: "100 µm", condition: "23 °C / 50% RH", footnote: "Unverified supplier statement" }));
	archive(state, "rows", [{ role: "tool", content: JSON.stringify({ rows }) }], { contextBinding: "old-task" });
	let validations = 0;
	const read = contextReadTool(scope, state, state, () => { validations++; }, "current-task");
	const recovered: unknown[] = [];
	let offset = 0;
	let pages = 0;
	while (offset < rows.length) {
		const result = await read.execute({ sourceRef: "rows", messageIndex: 0, jsonPointer: "/rows", offset }, execution) as ReturnType<typeof pageUnits> & { stale: boolean; status: string };
		expect(result.stale).toBe(true);
		expect(result.status).toBe("historical_unverified");
		expect(result.items.length).toBeGreaterThan(0);
		expect(JSON.stringify(result).length).toBeLessThan(read.maxResultChars);
		recovered.push(...result.items);
		pages++;
		if (result.nextOffset === null) break;
		expect(result.nextOffset).toBeGreaterThan(offset);
		offset = result.nextOffset;
		expect(pages).toBeLessThan(rows.length);
	}
	expect(pages).toBeGreaterThan(1);
	expect(validations).toBe(pages);
	expect(recovered).toEqual(rows);
});

it.each(["tenantId", "workspaceId", "runId", "sessionId"] as const)("denies archive readback across %s", async (key) => {
	const { state } = fixture();
	archive(state, "isolated", [{ role: "user", content: "private synthetic source" }]);
	const other = { ...scope, [key]: "other-scope" };
	await expect(contextReadTool(other, state, state, () => {}).execute({ sourceRef: "isolated" }, { ...execution, ...other })).rejects.toThrow();
});

it("denies obsolete history bindings before exposing a selected field", async () => {
	const { state } = fixture();
	archive(state, "old-memory", [{ role: "tool", content: JSON.stringify({ preference: "revoked preference" }) }], { historyBinding: "memory-v1" });
	const validate = vi.fn(async () => {});
	const read = contextReadTool(scope, state, state, () => {}, "task-v2", validate, "memory-v2");
	await expect(read.execute({ sourceRef: "old-memory", messageIndex: 0, jsonPointer: "/preference" }, execution)).rejects.toThrow("context_history_binding_changed");
	expect(validate).not.toHaveBeenCalled();
});

it("marks an oversized one-line source uncovered and explicitly reports the remaining readback boundary", async () => {
	const { state } = fixture();
	const content = `Do not change 100 µm; no PVC; ${"source evidence ".repeat(2000)}`;
	const messages: AgentMessage[] = [{ role: "user", content }];
	const generate = vi.fn(async () => ({ text: "Should not summarize partial data", toolCalls: [], usage }));
	const result = await new ModelContextSummarizer({ generate }).summarize(messages, undefined, "oversized-line");
	expect(generate).not.toHaveBeenCalled();
	expect(result.coverage).toMatchObject({ complete: false, coveredMessages: 0, sourceMessages: 1 });
	expect(result.text).toContain("INCOMPLETE");
	expect(result.text).toContain("oversized-line");
	archive(state, "oversized-line", messages);
	const read = contextReadTool(scope, state, state, () => {});
	for (const input of [{ sourceRef: "oversized-line" }, { sourceRef: "oversized-line", messageIndex: 0 }]) {
		const page = await read.execute(input, execution) as ReturnType<typeof pageUnits>;
		expect(page).toMatchObject({ items: [], error: "single_unit_exceeds_budget", truncated: true, nextOffset: 0 });
	}
	expect(state.read(scope, "oversized-line").messages[0].content).toBe(content);
});

it("does not reset the summarizer call budget after a later compression", async () => {
	const generate = vi.fn(async () => ({ text: "Unverified bounded note.", toolCalls: [], usage }));
	const summarizer = new ModelContextSummarizer({ generate });
	for (let index = 0; index < 4; index++) {
		const result = await summarizer.summarize([{ role: "user", content: `Unresolved item ${index}` }], undefined, `source-${index}`);
		expect(result.coverage).toMatchObject({ complete: true, calls: 1 });
	}
	const exhausted = await summarizer.summarize([{ role: "user", content: "Fifth unresolved item" }], undefined, "source-five");
	expect(generate).toHaveBeenCalledTimes(4);
	expect(exhausted.coverage).toMatchObject({ complete: false, calls: 0, coveredMessages: 0 });
	expect(exhausted.text).toContain("source-five");
});
