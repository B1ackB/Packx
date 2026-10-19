import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { AgentPlanStore } from "../server/enterprise/agentPlanStore";
import { AgentPlanWorkflow } from "../server/enterprise/agentPlanWorkflow";
import { StageJobScheduler } from "../server/workers/stageJobScheduler";
import { BlackxAgentRuntime } from "../server/runtime/agentRuntime";
import { InMemoryStageJobQueue } from "../src/enterprise/stageJobQueue";
import { SkillRegistry } from "../src/agent/skills";
import { PLAN_LIMITS } from "../src/enterprise/agentPlan";
import type { AgentModelProvider } from "../src/agent/contracts";

// Same graph, model fixture, context and slice budget; only Host concurrency varies.
const graph = { summary: "Read A and B, then sum their unverified reports", tasks: [
	{ title: "Sum", objective: "SUM", tools: [], dependsOn: [1, 2] },
	{ title: "A", objective: "A", tools: [] }, { title: "B", objective: "B", tools: [] },
] };
async function run(concurrency: 1 | 2) {
	let calls = 0, active = 0, maxActive = 0;
	const provider: AgentModelProvider = { async generate(request) {
		calls++;
		const planning = request.messages.some((message) => message.content.includes("Plan only. Do not execute"));
		const input = JSON.parse(request.messages.filter((m) => m.role === "user" && m.kind !== "task_context").at(-1)!.content);
		let summary = "";
		if (!planning) {
			if (input.objective === "SUM") {
				assert.equal(active, 0); assert.deepEqual(input.dependencies.map((d: { taskIndex: number }) => d.taskIndex), [1, 2]);
				assert(input.dependencies.every((d: { status: string }) => d.status === "unverified"));
				summary = String(input.dependencies.reduce((sum: number, d: { result: { summary: string } }) => sum + Number(d.result.summary), 0));
			} else {
				assert.equal(input.dependencies, undefined); active++; maxActive = Math.max(maxActive, active);
				try { await delay(80); summary = input.objective === "A" ? "4" : "7"; } finally { active--; }
			}
		}
		return { text: JSON.stringify(planning ? graph : { summary, evidence: ["synthetic:A=4,B=7"], limitations: ["Simulated 80ms wait; not a real model"], assessment: { decision: "continue", reason: "Fixture complete" } }), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
	} };
	const store = new AgentPlanStore(":memory:"), queue = new InMemoryStageJobQueue();
	try {
		const workflow = new AgentPlanWorkflow(store, queue, new BlackxAgentRuntime({ provider, skills: new SkillRegistry() }), { readInput: () => ({ revision: 1, context: "synthetic:A=4,B=7" }), readTools: [], executionTools: [], instructions: [], ...(concurrency === 2 ? { maxReadConcurrency: 2 as const } : {}) });
		const scheduler = new StageJobScheduler(queue, { workerId: "fixture", handlers: { "plan-subagents": (l, s, c) => workflow.execute(l, s, c) }, dispatchOutbox: () => workflow.reconcile() });
		const scope = { tenantId: "eval", workspaceId: "eval", runId: "same-graph" }; let id = 0;
		const command = (body: object) => workflow.command(scope, "eval", { requestId: `eval-${++id}`, revision: store.read(scope).revision, ...body });
		command({ action: "mode", mode: "plan" }); command({ action: "generate", objective: "Sum the independent source reports" }); await scheduler.runNext();
		assert.equal(calls, 1); command({ action: "confirm", version: 1, confirmed: true });
		const started = performance.now();
		for (let i = 0; i < 4; i++) await scheduler.runNext();
		const plan = store.read(scope).versions[0]; assert.equal(plan.status, "completed");
		assert.equal(maxActive, concurrency); assert.equal(calls, 4); assert.equal(plan.calls, 4);
		assert.equal(plan.children.find((c) => c.taskIndex === 0)!.result.summary, "11");
		return { concurrency, maxOverlappingSourceCalls: maxActive, actualFixtureCalls: calls, reservedRuntimeSlices: plan.calls, output: "11", elapsedMs: Math.round(performance.now() - started) };
	} finally { store.close(); }
}
const serial = await run(1), parallel = await run(2);
assert.equal(serial.output, parallel.output); assert.equal(serial.actualFixtureCalls, parallel.actualFixtureCalls);
console.log(JSON.stringify({ fixture: "packx-readonly-parallel-v1", passed: true, sharedLimits: PLAN_LIMITS, serial, parallel, conclusion: "Two independent reads overlap with identical fixture output and call count. Elapsed time includes artificial waiting; no real-model quality, price cap or user-value claim." }, null, 2));
