import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SkillRegistry } from "../../src/agent/skills";
import type { RuntimeTurnRequest } from "../../src/runtime/contracts";
import type { RuntimeActivity } from "../../src/runtime/conversationContracts";
import { BlackxAgentRuntime } from "./agentRuntime";
import { FileAgentStateStore } from "./fileAgentStateStore";
import { buildTaskContext } from "../enterprise/taskContext";
import { readContextSource } from "./contextRead";
import type { AgentHostTool } from "../../src/agent/contracts";
import { ConversationApiController } from "./conversationApi";
import { recoverCompletedTurn } from "./recoverCompletedTurn";
import { repairStoredCompletion } from "./turnCompletion";

const request: RuntimeTurnRequest = {
	tenantId: "completion-tenant", workspaceId: "completion-workspace", runId: "completion-run", sessionId: "completion-session",
	stageId: "conversation", actorId: "completion-user", idempotencyKey: "completion-turn", input: "Explain the saved result", fallbackOutput: "unused",
	policy: { sandboxMode: "read-only", approvalPolicy: "never", timeoutMs: 10_000 },
};
const scope = { ...request, sessionId: request.sessionId! };
const usage = { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, reasoningOutputTokens: 2 };
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "packx-completion-")); roots.push(root);
	const state = new FileAgentStateStore(root);
	const generate = vi.fn(async () => ({ text: "The result is complete", toolCalls: [], usage }));
	const activities: RuntimeActivity[] = [];
	const make = (storage = new FileAgentStateStore(root)) => new BlackxAgentRuntime({ provider: { generate }, skills: new SkillRegistry(), sessions: storage, snapshots: storage, traces: storage, executions: storage, onActivity: (_scope, activity) => activities.push(activity) });
	return { root, state, generate, make, activities };
}

it.each(["after-intent", "before-session", "after-session", "before-trace", "after-trace"] as const)("repairs %s interruption after reopening without another model call", async boundary => {
	const { root, state, generate, make, activities } = fixture();
	const fail = () => { throw new Error(`injected_${boundary}`); };
	if (boundary === "after-intent") {
		const put = state.put.bind(state);
		vi.spyOn(state, "put").mockImplementation(value => { const result = put(value); if (value.skills.some(skill => skill.name === "host-turn-completion")) fail(); return result; });
	} else if (boundary.endsWith("session")) {
		const save = state.save.bind(state);
		vi.spyOn(state, "save").mockImplementation((...args) => {
			if (args[4] === null && boundary === "before-session") fail();
			const result = save(...args);
			if (args[4] === null) fail();
			return result;
		});
	} else {
		const putTrace = state.putTrace.bind(state);
		vi.spyOn(state, "putTrace").mockImplementation(value => { if (boundary === "before-trace") fail(); const result = putTrace(value); fail(); return result; });
	}
	await expect(make(state).executeTurn(request)).rejects.toThrow();
	const reopened = new FileAgentStateStore(root);
	const recovered = await make(reopened).executeTurn(request);
	if (boundary !== "after-trace") expect(activities.at(-1)).toMatchObject({ phase: "completed", executionId: recovered.executionId });
	expect(recovered).toMatchObject({ status: "completed", finalResponse: "The result is complete", usage });
	expect(await make().executeTurn(request)).toMatchObject({ executionId: recovered.executionId, finalResponse: recovered.finalResponse, usage });
	expect(generate).toHaveBeenCalledOnce();
	expect(reopened.load(scope).transcript?.filter(message => message.role === "assistant")).toHaveLength(1);
	expect(reopened.listTraces(scope)).toMatchObject([{ status: "completed", executionId: recovered.executionId, usage }]);
});

it.each(["input", "actor", "contract", "session"] as const)("rejects a changed %s during completion repair without overwriting the session", async change => {
	const { root, state, generate, make } = fixture();
	vi.spyOn(state, "putTrace").mockImplementation(() => { throw new Error("trace_unavailable"); });
	await expect(make(state).executeTurn(request)).rejects.toThrow();
	const reopened = new FileAgentStateStore(root);
	if (change === "session") {
		const prior = reopened.load(scope);
		reopened.save(scope, prior.revision, [...prior.messages, { role: "user", content: "A later user edit", messageId: "later" }], new Date().toISOString());
	}
	const before = reopened.load(scope);
	const changed = { ...request, ...(change === "input" ? { input: "different" } : change === "actor" ? { actorId: "other-user" } : change === "contract" ? { expectedOutputFields: { quantity: 42 } } : {}) };
	await expect(make(reopened).executeTurn(changed)).rejects.toMatchObject({ code: "session_conflict" });
	expect(reopened.load(scope)).toEqual(before);
	expect(generate).toHaveBeenCalledOnce();
});

it("keeps legacy replies without a completion intent fail-closed", async () => {
	const { state, generate, make } = fixture();
	const replyId = `reply-${createHash("sha256").update(request.idempotencyKey).digest("hex")}`;
	state.save(scope, 0, [{ role: "assistant", messageId: replyId, content: "Old unproven response" }], new Date().toISOString());
	await expect(make(state).executeTurn(request)).rejects.toMatchObject({ code: "context_failure" });
	expect(generate).not.toHaveBeenCalled();
});

it("does not repair a cancelled request or execute its model", async () => {
	const { state, generate, make } = fixture();
	vi.spyOn(state, "putTrace").mockImplementation(() => { throw new Error("trace_unavailable"); });
	await expect(make(state).executeTurn(request)).rejects.toThrow();
	await expect(make().executeTurn(request, AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
	expect(generate).toHaveBeenCalledOnce();
});

it("rejects changed task facts and keeps completion intents out of context readback", async () => {
	const { state, generate, make } = fixture();
	vi.spyOn(state, "putTrace").mockImplementation(() => { throw new Error("trace_unavailable"); });
	const task = { ...request, taskContext: buildTaskContext({ scope, objective: "Original task" }) };
	await expect(make(state).executeTurn(task)).rejects.toThrow();
	await expect(make().executeTurn({ ...task, taskContext: buildTaskContext({ scope, objective: "Revised task" }) })).rejects.toMatchObject({ code: "context_failure" });
	expect(generate).toHaveBeenCalledOnce();
	expect(() => readContextSource(scope, state, state, "completion-host-private")).toThrow("host_completion_intent_is_private");
});

it("checks source availability again before repairing completion without rerunning the read or model", async () => {
	const { root, state } = fixture();
	let available = true;
	const tool: AgentHostTool = { name: "source_read", description: "Read source", inputSchema: { type: "object" }, execution: "host", risk: "read", idempotent: true, timeoutMs: 1_000, maxResultChars: 2_000, validate: () => true,
		execute: vi.fn(async () => "Original source"), validateContextResult: () => { if (!available) throw new Error("source_removed"); } };
	const generate = vi.fn().mockResolvedValueOnce({ text: "", toolCalls: [{ id: "read", name: tool.name, input: {} }], usage }).mockResolvedValue({ text: "Source answer", toolCalls: [], usage });
	const make = (storage: FileAgentStateStore) => new BlackxAgentRuntime({ provider: { generate }, tools: [tool], skills: new SkillRegistry(), sessions: storage, snapshots: storage, traces: storage });
	vi.spyOn(state, "putTrace").mockImplementation(() => { throw new Error("trace_unavailable"); });
	const task = { ...request, allowedTools: [tool.name] };
	await expect(make(state).executeTurn(task)).rejects.toThrow();
	available = false;
	const reopened = new FileAgentStateStore(root), before = reopened.load(scope);
	await expect(make(reopened).executeTurn(task)).rejects.toMatchObject({ code: "context_failure" });
	expect(reopened.load(scope)).toEqual(before); expect(reopened.listTraces(scope)).toEqual([]);
	expect(tool.execute).toHaveBeenCalledOnce(); expect(generate).toHaveBeenCalledTimes(2);
	available = true;
	await expect(make(reopened).executeTurn(task)).resolves.toMatchObject({ finalResponse: "Source answer" });
	expect(generate).toHaveBeenCalledTimes(2);
});

it.each(["session", "trace"])("repairs the %s write window through the actual conversation retry entry", async boundary => {
	const { root, state, generate, make } = fixture();
	const api = new ConversationApiController(make(state), state);
	const id = (api.create(request).body as { conversation: { conversationId: string } }).conversation.conversationId;
	if (boundary === "trace") vi.spyOn(state, "putTrace").mockImplementation(() => { throw new Error("trace_unavailable"); });
	else {
		const save = state.save.bind(state);
		vi.spyOn(state, "save").mockImplementation((...args) => { if (args[4] === null) throw new Error("session_unavailable"); return save(...args); });
	}
	const message = { messageId: "api-turn", content: "Explain the saved result" };
	expect((await api.send(request, id, message)).status).toBeGreaterThanOrEqual(400);
	const reopened = new FileAgentStateStore(root), retry = new ConversationApiController(make(reopened), reopened);
	expect(await retry.retry(request, id)).toMatchObject({ status: 200 });
	expect(reopened.listTraces({ ...request, runId: id })).toMatchObject([{ status: "completed", idempotencyKey: message.messageId }]);
	expect(generate).toHaveBeenCalledOnce();
	expect(reopened.load({ ...request, runId: id, sessionId: id }).transcript?.filter(item => item.role === "assistant")).toHaveLength(1);
});

it.each(["session", "trace"])("repairs historical Plan completion before the %s write through its result-recovery entry", async boundary => {
	const { root, state, generate, make } = fixture();
	if (boundary === "trace") vi.spyOn(state, "putTrace").mockImplementation(() => { throw new Error("trace_unavailable"); });
	else {
		const save = state.save.bind(state);
		vi.spyOn(state, "save").mockImplementation((...args) => { if (args[4] === null) throw new Error("session_unavailable"); return save(...args); });
	}
	await expect(make(state).executeTurn(request)).rejects.toThrow();
	const reopened = new FileAgentStateStore(root);
	const recovered = recoverCompletedTurn(reopened, scope, scope.sessionId, request.idempotencyKey, () => repairStoredCompletion(reopened, scope, request.idempotencyKey, request.actorId));
	expect(recovered).toMatchObject({ finalResponse: "The result is complete", usage });
	expect(reopened.listTraces(scope)).toMatchObject([{ status: "completed" }]);
	expect(generate).toHaveBeenCalledOnce();
});
