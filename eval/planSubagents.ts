import assert from "node:assert/strict";
import { AgentPlanStore } from "../server/enterprise/agentPlanStore";
import { AgentPlanWorkflow } from "../server/enterprise/agentPlanWorkflow";
import { StageJobScheduler } from "../server/workers/stageJobScheduler";
import { InMemoryStageJobQueue } from "../src/enterprise/stageJobQueue";
import { BlackxAgentRuntime } from "../server/runtime/agentRuntime";
import { SkillRegistry } from "../src/agent/skills";
import { PLAN_LIMITS, parseSubagentResult } from "../src/enterprise/agentPlan";
import type { AgentModelProvider } from "../src/agent/contracts";

// Fixed, offline isolation evaluation. This measures orchestration properties,
// not real-model reasoning quality or commercial task effectiveness.
const objectives = ["SOURCE_A_ONLY", "SOURCE_B_ONLY"];
const spec = { summary: "Two independent source reviews", tasks: objectives.map((objective) => ({ title: objective, objective, tools: [] })) };
const calls: string[] = [];
let blocked = false;
const provider: AgentModelProvider = { async generate(request) {
	const input = request.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
	calls.push(input);
	const planning = request.messages.some((m) => m.content.includes("Plan only. Do not execute"));
	return { text: JSON.stringify(planning ? spec : { summary: "Fixed valid draft", evidence: ["synthetic-fixture"], limitations: ["No user or online-model validation"], assessment: { decision: blocked ? "replan" : "continue", reason: blocked ? "Required source is unavailable; the plan needs revision." : "Fixed fixture objective completed." } }), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
} };
const runtime = new BlackxAgentRuntime({ provider, skills: new SkillRegistry() });
const scope = { tenantId: "eval", workspaceId: "eval", runId: "plan-eval" };
const limits = { maxIterations: PLAN_LIMITS.iterations, maxToolExecutions: PLAN_LIMITS.tools, maxInputTokens: PLAN_LIMITS.inputTokens };
await runtime.executeTurn({ ...scope, stageId: "baseline", actorId: "evaluator", idempotencyKey: "baseline", input: objectives.join("; "), allowedTools: [], fallbackOutput: "{}", limits, policy: { sandboxMode: "read-only", approvalPolicy: "never", timeoutMs: PLAN_LIMITS.timeoutMs } });
const baselineInputs = calls.splice(0);
const store = new AgentPlanStore(":memory:");
try {
	const queue = new InMemoryStageJobQueue();
	const workflow = new AgentPlanWorkflow(store, queue, runtime, { readInput: () => ({ revision: 1, context: "shared source index" }), readTools: [], executionTools: [], instructions: [] });
	const scheduler = new StageJobScheduler(queue, { workerId: "eval", handlers: { "plan-subagents": (lease, signal, check) => workflow.execute(lease, signal, check) }, dispatchOutbox: () => workflow.reconcile() });
	let sequence = 0;
	const command = (body: Record<string, unknown>) => workflow.command(scope, "evaluator", { requestId: `command-${++sequence}`, revision: store.read(scope).revision, ...body });
	command({ action: "mode", mode: "plan" }); command({ action: "generate", objective: objectives.join("; ") });
	await scheduler.runNext();
	assert.equal(store.read(scope).versions[0].status, "awaiting_confirmation");
	assert.equal(calls.length, 1);
	command({ action: "confirm", version: 1, confirmed: true });
	await scheduler.runNext(); await scheduler.runNext();
	const plan = store.read(scope).versions[0];
	assert.equal(plan.status, "completed");
	assert.equal(plan.children.length, 2);
	assert(calls[1].includes(objectives[0]) && !calls[1].includes(objectives[1]));
	assert(calls[2].includes(objectives[1]) && !calls[2].includes(objectives[0]));
	assert(baselineInputs[0].includes(objectives[0]) && baselineInputs[0].includes(objectives[1]));
	console.log(JSON.stringify({ fixture: "packx-plan-isolation-v1", provider: "same fixed offline provider", sharedLimits: limits, lifetimeSliceLimit: PLAN_LIMITS.calls, passed: true, baseline: { modelCalls: baselineInputs.length, independentTaskContexts: 1 }, planSubagents: { modelCalls: calls.length, independentTaskContexts: plan.children.length, executedBeforeConfirmation: 0 }, conclusion: "Independent task contexts and explicit confirmation verified at two additional model calls; no real-model quality or speed improvement claimed." }, null, 2));
	blocked = true;
	const start = calls.length;
	command({ action: "generate", objective: objectives.join("; ") });
	await scheduler.runNext(); command({ action: "confirm", version: 2, confirmed: true });
	await scheduler.runNext(); await scheduler.runNext();
	const checkpoint = store.read(scope).versions[1];
	assert.equal(checkpoint.status, "failed");
	assert.equal(checkpoint.failure?.code, "plan_replan_required");
	assert.equal(checkpoint.children.length, 1);
	// The old result contract had no assessment: the same summary/evidence/
	// limitations pass its structural gate despite the reported blocker.
	const { assessment: _assessment, ...legacyOutput } = checkpoint.children[0].result;
	const legacyAccepted = !!parseSubagentResult(legacyOutput);
	assert(legacyAccepted);
	assert.equal(calls.length - start, 2);
	assert.throws(() => command({ action: "resume", version: 2 }), /plan_requires_revision/);
	command({ action: "replan", version: 2 });
	await scheduler.runNext(); await scheduler.runNext();
	assert.equal(store.read(scope).versions[2].status, "awaiting_confirmation");
	assert.equal(store.read(scope).versions[2].approval, undefined);
	assert(calls.at(-1)!.includes("Required source is unavailable"));
	assert.equal(calls.length - start, 3);
	console.log(JSON.stringify({ fixture: "packx-plan-checkpoint-v1", passed: true, provider: "same fixed offline provider", sharedLimits: limits, baselineWithoutCheckpoint: { legacyResultAccepted: legacyAccepted }, checkpoint: { laterTasksExecuted: 0, automaticReplans: 0, newApprovalRequired: true, extraReviewModelCalls: 0 }, conclusion: "A reported blocker stops advancement and manual replanning retains context behind a fresh confirmation; this fixture does not establish real-model plan quality." }, null, 2));
} finally { store.close(); }
