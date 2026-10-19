import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileAgentStateStore } from "./fileAgentStateStore";
import { BlackxAgentRuntime } from "./agentRuntime";
import { SkillRegistry } from "../../src/agent/skills";
import { recoverCompletedTurn } from "./recoverCompletedTurn";

it("recovers committed child output without another model call and fails closed in the trace gap", async () => {
	const dir = mkdtempSync(join(tmpdir(), "packx-recover-"));
	try {
		const store = new FileAgentStateStore(dir); let calls = 0;
		const runtime = new BlackxAgentRuntime({ sessions: store, snapshots: store, traces: store, skills: new SkillRegistry(), provider: { async generate() { calls++; return { text: '{"summary":"done","evidence":[],"limitations":[]}', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } }; } } });
		const scope = { tenantId: "t", workspaceId: "w", runId: "conversation-r" };
		const completed = await runtime.executeTurn({ ...scope, sessionId: "child", stageId: "subagent-0", actorId: "user", idempotencyKey: "task-key", input: "task", fallbackOutput: "{}", policy: { sandboxMode: "read-only", approvalPolicy: "never", timeoutMs: 1000 } });
		const recovered = recoverCompletedTurn(new FileAgentStateStore(dir), scope, "child", "task-key");
		expect(recovered?.finalResponse).toBe(completed.finalResponse); expect(recovered?.executionId).toBe(completed.executionId); expect(calls).toBe(1);
		for (const inReplyTo of ["another-key", "task-key"]) {
			const session = store.load({ ...scope, sessionId: "child" });
			store.save({ ...scope, sessionId: "child" }, session.revision, [...session.messages, { role: "assistant", messageId: `mismatch-${inReplyTo}`, content: "Unrelated final result", inReplyTo }], new Date().toISOString());
			expect(() => recoverCompletedTurn(store, scope, "child", "task-key")).toThrow("plan_completion_evidence_missing");
		}
		expect(recoverCompletedTurn(store, { ...scope, tenantId: "other" }, "child", "task-key")).toBeUndefined();
		store.save({ ...scope, sessionId: "gap" }, 0, [{ role: "assistant", content: "done" }], new Date().toISOString());
		expect(() => recoverCompletedTurn(store, scope, "gap", "gap-key")).toThrow("plan_completion_evidence_missing");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

it("rejects malformed budgets and cannot raise adapter limits", async () => {
	let calls = 0;
	const runtime = new BlackxAgentRuntime({ maxIterations: 1, skills: new SkillRegistry(), provider: { async generate() { calls++; return { text: "", toolCalls: [{ id: `call-${calls}`, name: "missing", input: {} }], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } }; } } });
	const request = { tenantId: "t", workspaceId: "w", runId: "r", stageId: "s", actorId: "u", idempotencyKey: "i", input: "x", fallbackOutput: "{}", policy: { sandboxMode: "read-only" as const, approvalPolicy: "never" as const, timeoutMs: 1000 } };
	await expect(runtime.executeTurn({ ...request, limits: {} as never })).rejects.toMatchObject({ code: "invalid_output" });
	const response = await runtime.executeTurn({ ...request, limits: { maxIterations: 100, maxToolExecutions: 100, maxInputTokens: 1000000 } });
	expect(calls).toBe(1); expect(response.status).toBe("paused");
});
