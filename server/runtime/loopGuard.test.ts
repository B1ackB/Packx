import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentHostTool, AgentModelProvider } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import { InMemoryAgentStateStore } from "../../src/agent/state";
import { BlackxAgentRuntime } from "./agentRuntime";
import { FileAgentStateStore } from "./fileAgentStateStore";

const request = { tenantId: "t", workspaceId: "w", runId: "r", stageId: "s", actorId: "u", idempotencyKey: "turn", sessionId: "session", input: "task", fallbackOutput: "unused", allowedTools: ["read"], policy: { sandboxMode: "read-only" as const, approvalPolicy: "never" as const, timeoutMs: 1000 } };
const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 };
const tool: AgentHostTool = { name: "read", description: "read", inputSchema: { type: "object" }, execution: "host", risk: "read", idempotent: true, timeoutMs: 100, maxResultChars: 100, validate: () => true, execute: async () => "ok" };
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it.each([
	{ name: "same canonical arguments despite new IDs/key order", input: (n: number) => n % 2 ? { b: 2, a: { y: 2, x: 1 } } : { a: { x: 1, y: 2 }, b: 2 }, executed: 2 },
	{ name: "A/B cycle", input: (n: number) => ({ page: n % 2 }), executed: 5 },
	{ name: "four-action cycle", input: (n: number) => ({ page: n % 4 }), executed: 11 },
])("stops $name before dispatch and records the non-retryable reason", async ({ input, executed }) => {
	let calls = 0; let executions = 0;
	const state = new InMemoryAgentStateStore();
	const runtime = new BlackxAgentRuntime({ skills: new SkillRegistry(), traces: state,
		tools: [{ ...tool, execute: async () => { executions++; return "ok"; } }],
		provider: { generate: async () => ({ text: "", usage, toolCalls: [{ id: `id-${++calls}`, name: "read", input: input(calls) }] }) },
	});
	await expect(runtime.executeTurn(request)).rejects.toMatchObject({ code: "repeated_actions", retryable: false });
	expect(executions).toBe(executed);
	const trace = state.listTraces(request)[0];
	expect(trace.events).toContainEqual({ type: "loop.guard.stopped", code: "repeated_actions" });
	expect(trace.loopGuard?.actions.every((digest) => /^[a-f0-9]{64}$/.test(digest))).toBe(true);
	await expect(runtime.executeTurn(request)).rejects.toMatchObject({ code: "repeated_actions", retryable: false });
	expect(calls).toBe(executed + 1);
});

it("stops after the third failure inside a batch, before the fourth tool or another model call", async () => {
	let executions = 0; let calls = 0;
	const runtime = new BlackxAgentRuntime({ skills: new SkillRegistry(), tools: [{ ...tool, execute: async () => { executions++; throw new Error("failed"); } }], provider: { generate: async () => {
		calls++; return { text: "", usage, toolCalls: [1, 2, 3, 4].map((n) => ({ id: `id-${n}`, name: "read", input: { page: n } })) };
	} } });
	await expect(runtime.executeTurn(request)).rejects.toMatchObject({ code: "consecutive_tool_failures", retryable: false });
	expect(executions).toBe(3); expect(calls).toBe(1);
});

it("allows changed actions to recover and resets the failure streak on success", async () => {
	let calls = 0;
	const runtime = new BlackxAgentRuntime({ skills: new SkillRegistry(), tools: [{ ...tool, execute: async (input) => { if ((input as { page: number }).page % 3) throw new Error("failed"); return "ok"; } }], provider: { generate: async () => ({ text: ++calls === 7 ? "done" : "", usage, toolCalls: calls === 7 ? [] : [{ id: `id-${calls}`, name: "read", input: { page: calls } }] }) } });
	expect((await runtime.executeTurn(request)).finalResponse).toBe("done");
	expect(calls).toBe(7);
});

it.each([false, true])("preserves action/failure guard across slices and Runtime reconstruction (failing=%s)", async (failing) => {
	const dir = mkdtempSync(join(tmpdir(), "packx-loop-guard-")); directories.push(dir);
	let calls = 0; let executions = 0;
	const provider: AgentModelProvider = { generate: async () => ({ text: "", usage, toolCalls: [{ id: `id-${++calls}`, name: "read", input: failing ? { page: calls } : { privateQuery: "sensitive text" } }] }) };
	const run = (overrides = {}) => {
		const state = new FileAgentStateStore(dir);
		return new BlackxAgentRuntime({ provider, sessions: state, traces: state, snapshots: state, skills: new SkillRegistry(), maxIterations: 1,
			tools: [{ ...tool, execute: async () => { executions++; if (failing) throw new Error("failed"); return "ok"; } }],
			// Identical timestamps deliberately exercise sequence-based recovery.
			now: () => "2026-09-20T00:00:00Z",
		}).executeTurn({ ...request, resume: "if-present", ...overrides });
	};
	expect((await run()).status).toBe("paused"); expect((await run()).status).toBe("paused");
	const code = failing ? "consecutive_tool_failures" : "repeated_actions";
	await expect(run()).rejects.toMatchObject({ code, retryable: false });
	await expect(run()).rejects.toMatchObject({ code, retryable: false });
	expect(calls).toBe(3); expect(executions).toBe(failing ? 3 : 2);
	const trace = new FileAgentStateStore(dir).listTraces(request).find((t) => t.loopGuard?.blocked);
	expect(JSON.stringify(trace?.loopGuard)).not.toContain("sensitive text");
	// New user turns and other tenants do not inherit this turn's stop state.
	expect((await run({ idempotencyKey: "new-turn" })).status).toBe("paused");
	expect((await run({ tenantId: "another-tenant" })).status).toBe("paused");
});
