import assert from "node:assert/strict";
import type { AgentHostTool, AgentModelProvider } from "../src/agent/contracts";
import { AgentLoop } from "../src/agent/loop";
import { SkillRegistry } from "../src/agent/skills";
import { BlackxAgentRuntime } from "../server/runtime/agentRuntime";
import { RuntimeFailure } from "../src/runtime/contracts";

const limits = { maxIterations: 12, maxToolExecutions: 16, maxInputTokens: 12000 };
const request = { tenantId: "eval", workspaceId: "eval", runId: "loop-safety", stageId: "task", actorId: "eval", idempotencyKey: "task", input: "Fixed task", allowedTools: ["read"], fallbackOutput: "unused", policy: { sandboxMode: "read-only" as const, approvalPolicy: "never" as const, timeoutMs: 1000 } };
const cases = ["repeat", "cycle", "failures", "progress"] as const;
const reports = [];
for (const fixture of cases) {
	const outcomes = [];
	for (const guarded of [false, true]) {
		let modelCalls = 0; let toolCalls = 0;
		const provider: AgentModelProvider = { async generate() {
			modelCalls++;
			return { text: fixture === "progress" && modelCalls === 5 ? "done" : "", toolCalls: fixture === "progress" && modelCalls === 5 ? [] : [{ id: `id-${modelCalls}`, name: "read", input: { page: fixture === "repeat" ? 1 : fixture === "cycle" ? modelCalls % 2 : modelCalls } }], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
		} };
		const tool: AgentHostTool = { name: "read", description: "read", inputSchema: { type: "object" }, execution: "host", risk: "read", idempotent: true, timeoutMs: 100, maxResultChars: 100, validate: () => true, async execute() { toolCalls++; if (fixture === "failures") throw new Error("fixture failure"); return "ok"; } };
		let stopped: string;
		try {
			stopped = guarded
				? (await new BlackxAgentRuntime({ provider, tools: [tool], skills: new SkillRegistry() }).executeTurn({ ...request, limits })).status
				: (await new AgentLoop({ provider, tools: [tool], ...limits }).run({ ...request, executionId: "baseline", instructions: [], skills: [], history: [] })).stopReason;
		} catch (error) {
			assert(error instanceof RuntimeFailure); stopped = error.code;
		}
		outcomes.push({ guarded, modelCalls, toolCalls, stopped });
	}
	const [baseline, guarded] = outcomes;
	if (fixture === "progress") assert.deepEqual({ ...guarded, guarded: false }, baseline);
	else {
		assert.equal(baseline.toolCalls, 12);
		assert.equal(guarded.toolCalls, fixture === "repeat" ? 2 : fixture === "cycle" ? 5 : 3);
		assert.equal(guarded.stopped, fixture === "failures" ? "consecutive_tool_failures" : "repeated_actions");
	}
	reports.push({ fixture, baseline, guarded });
}
console.log(JSON.stringify({ fixture: "packx-loop-safety-v1", provider: "same deterministic offline provider", limits, passed: true, reports, limitation: "Measures deterministic stopping and unchanged productive fixture behavior; not real-model task quality or billing." }, null, 2));
