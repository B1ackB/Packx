import assert from "node:assert/strict";
import { AgentPlanStore } from "../server/enterprise/agentPlanStore";
import { AgentPlanWorkflow } from "../server/enterprise/agentPlanWorkflow";
import { StageJobScheduler } from "../server/workers/stageJobScheduler";
import { InMemoryStageJobQueue } from "../src/enterprise/stageJobQueue";
import { BlackxAgentRuntime } from "../server/runtime/agentRuntime";
import { SkillRegistry } from "../src/agent/skills";
import { PLAN_LIMITS } from "../src/enterprise/agentPlan";
import type { AgentModelProvider } from "../src/agent/contracts";

// Same deterministic provider, sources and slice limits. Measures orchestration
// and extra calls only, not reasoning quality, latency or real-user benefit.
const graph = { summary: "Read sources and combine their reports", tasks: [
	{ title: "Combine", objective: "SUM", tools: [], dependsOn: [1, 2] },
	{ title: "Read A", objective: "READ_A", tools: [] },
	{ title: "Read B", objective: "READ_B", tools: [] },
] };
const inputs: Array<{ objective: string; dependencies?: Array<{ taskIndex: number; status: string; result: { summary: string } }> }> = [];
const provider: AgentModelProvider = { async generate(request) {
	const planning = request.messages.some((m) => m.content.includes("Plan only. Do not execute"));
	const input = JSON.parse(request.messages.filter((m) => m.role === "user" && m.kind !== "task_context").at(-1)!.content) as typeof inputs[number];
	inputs.push(input);
	let summary = input.objective === "READ_A" ? "4" : input.objective === "READ_B" ? "7" : "11";
	if (input.objective === "SUM") {
		assert.deepEqual(input.dependencies?.map((d) => d.taskIndex), [1, 2]);
		assert(input.dependencies?.every((d) => d.status === "unverified"));
		summary = String(input.dependencies!.reduce((sum, d) => sum + Number(d.result.summary), 0));
	} else assert.equal(input.dependencies, undefined);
	return { text: JSON.stringify(planning ? graph : { summary, evidence: ["synthetic-source:A=4,B=7"], limitations: ["Offline synthetic evaluation"], assessment: { decision: "continue", reason: "Fixed fixture completed" } }), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
} };
const runtime = new BlackxAgentRuntime({ provider, skills: new SkillRegistry() });
const scope = { tenantId: "eval", workspaceId: "eval", runId: "plan-graph" };
const limits = { maxIterations: PLAN_LIMITS.iterations, maxToolExecutions: PLAN_LIMITS.tools, maxInputTokens: PLAN_LIMITS.inputTokens };
const baseline = await runtime.executeTurn({ ...scope, stageId: "baseline", actorId: "eval", idempotencyKey: "baseline", input: JSON.stringify({ objective: "READ_AND_SUM_A_B" }), taskContext: { content: "synthetic sources A=4; B=7", binding: "fixed" }, allowedTools: [], fallbackOutput: "{}", limits, policy: { sandboxMode: "read-only", approvalPolicy: "never", timeoutMs: PLAN_LIMITS.timeoutMs } });
assert.equal(JSON.parse(baseline.finalResponse).summary, "11");
const baselineCalls = inputs.splice(0).length;
const store = new AgentPlanStore(":memory:");
try {
	const queue = new InMemoryStageJobQueue();
	const workflow = new AgentPlanWorkflow(store, queue, runtime, { readInput: () => ({ revision: 1, context: "synthetic sources A=4; B=7" }), readTools: [], executionTools: [], instructions: [] });
	const scheduler = new StageJobScheduler(queue, { workerId: "eval", handlers: { "plan-subagents": (lease, signal, guard) => workflow.execute(lease, signal, guard) }, dispatchOutbox: () => workflow.reconcile() });
	let id = 0;
	const command = (body: Record<string, unknown>) => workflow.command(scope, "eval", { requestId: `eval-${++id}`, revision: store.read(scope).revision, ...body });
	command({ action: "mode", mode: "plan" }); command({ action: "generate", objective: "Read A and B, combine their reported values" });
	await scheduler.runNext(); await scheduler.runNext();
	assert.equal(inputs.length, 1); assert.equal(store.read(scope).versions[0].status, "awaiting_confirmation");
	command({ action: "confirm", version: 1, confirmed: true });
	for (let i = 0; i < 4; i++) await scheduler.runNext();
	const plan = store.read(scope).versions[0];
	assert.equal(plan.status, "completed");
	assert.deepEqual(plan.children.map((c) => c.taskIndex), [1, 2, 0]);
	assert.equal(plan.children.at(-1)!.result.summary, "11");
	assert.deepEqual(inputs.slice(1).map((i) => i.objective), ["READ_A", "READ_B", "SUM"]);
	assert.equal(inputs.length, 4);
	console.log(JSON.stringify({ fixture: "packx-plan-graph-v1", passed: true, provider: "same fixed offline provider", sharedSliceLimits: limits, baseline: { modelCalls: baselineCalls, output: "11" }, graph: { modelCalls: inputs.length, taskOrder: plan.children.map((c) => c.taskIndex), output: "11", executedBeforeConfirmation: 0, maxConcurrency: 1, dependencyReportsRemainUnverified: true }, conclusion: "Dependency routing and confirmation verified at three extra calls. No real-model quality, speed, exact cost or business-value improvement established." }, null, 2));
} finally { store.close(); }
