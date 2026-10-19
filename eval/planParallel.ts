import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationFileService } from "../server/runtime/conversationFiles";
import { FileAgentStateStore } from "../server/runtime/fileAgentStateStore";
import { validateCompletedPlanSources } from "../server/runtime/completedPlanSources";
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
	{ title: "A", objective: "A", tools: ["file_read"] }, { title: "B", objective: "B", tools: ["file_read"] },
] };
async function run(concurrency: 1 | 2, change: "candidate" | "tool" = "candidate") {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "packx-parallel-eval-")));
	const paths = { A: join(directory, "A.txt"), B: join(directory, "B.txt") };
	writeFileSync(paths.A, "4"); writeFileSync(paths.B, "7");
	const state = new FileAgentStateStore(join(directory, "state")), files = new ConversationFileService(join(directory, "files"), () => {}), tools = files.tools();
	let calls = 0, active = 0, maxActive = 0;
	const inputs = { schemaVersion: "task-context.v1", facts: [{ key: "sourceA", version: 1, value: 4, status: "unverified" }, { key: "sourceB", version: 1, value: 7, status: "unverified" }], artifacts: [], unresolved: [] };
	const provider: AgentModelProvider = { async generate(request) {
		calls++;
		const planning = request.messages.some((message) => message.content.includes("Plan only. Do not execute"));
		const input = JSON.parse(request.messages.filter((m) => m.role === "user" && m.kind !== "task_context").at(-1)!.content);
		let summary = "";
		let toolCalls: Array<{ id: string; name: string; input: { path: string } }> = [];
		if (!planning) {
			if (input.objective === "SUM") {
				assert.equal(active, 0); assert.deepEqual(input.dependencies.map((d: { taskIndex: number }) => d.taskIndex), [1, 2]);
				assert(input.dependencies.every((d: { status: string }) => d.status === "unverified"));
				summary = String(input.dependencies.reduce((sum: number, d: { result: { summary: string } }) => sum + Number(d.result.summary), 0));
			} else {
				assert.equal(input.dependencies, undefined);
				const read = request.messages.findLast(message => message.role === "tool");
				if (read) summary = JSON.parse(read.content).content;
				else {
					active++; maxActive = Math.max(maxActive, active);
					try { await delay(80); toolCalls = [{ id: "read", name: "file_read", input: { path: paths[input.objective as "A" | "B"] } }]; } finally { active--; }
				}
			}
		}
		return { text: toolCalls.length ? "" : JSON.stringify(planning ? graph : { summary, evidence: ["synthetic:A=4,B=7"], limitations: ["Simulated 80ms wait; not a real model"], assessment: { decision: "continue", reason: "Fixture complete" } }), toolCalls, usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
	} };
	const store = new AgentPlanStore(":memory:"), queue = new InMemoryStageJobQueue();
	try {
		const workflow = new AgentPlanWorkflow(store, queue, new BlackxAgentRuntime({ provider, tools, sessions: state, snapshots: state, traces: state, skills: new SkillRegistry() }), { readInput: () => ({ revision: 1, context: JSON.stringify(inputs) }), readTools: ["file_read"], executionTools: ["file_read"], instructions: [], ...(concurrency === 2 ? { maxReadConcurrency: 2 as const, validateCompletedSources: (scope: import("../src/enterprise/agentPlan").PlanScope, plan: import("../src/enterprise/agentPlan").PlanVersion, signal: AbortSignal) => validateCompletedPlanSources(state, tools, scope, plan, signal) } : {}) });
		const scheduler = new StageJobScheduler(queue, { workerId: "fixture", handlers: { "plan-subagents": (l, s, c) => workflow.execute(l, s, c) }, dispatchOutbox: () => workflow.reconcile() });
		const scope = { tenantId: "eval", workspaceId: "eval", runId: "same-graph" }; let id = 0;
		const command = (body: object) => workflow.command(scope, "eval", { requestId: `eval-${++id}`, revision: store.read(scope).revision, ...body });
		command({ action: "mode", mode: "plan" }); command({ action: "generate", objective: "Sum the independent source reports" }); await scheduler.runNext();
		assert.equal(calls, 1); command({ action: "confirm", version: 1, confirmed: true });
		const started = performance.now();
		for (let i = 0; i < 4; i++) await scheduler.runNext();
		const plan = store.read(scope).versions[0]; assert.equal(plan.status, "completed", JSON.stringify(plan));
		assert.equal(maxActive, concurrency); assert.equal(calls, 6); assert.equal(plan.calls, 4);
		assert.equal(plan.children.find((c) => c.taskIndex === 0)!.result.summary, "11");
		const elapsedMs = Math.round(performance.now() - started);
		if (concurrency === 2) {
			assert.deepEqual(plan.inputDependencies?.facts.map(fact => [fact.key, fact.version]), [["sourceA", 1], ["sourceB", 1]]);
			if (change === "candidate") inputs.facts[0].value = 5; else writeFileSync(paths.A, "5");
			const stale = (await workflow.read(scope));
			assert.equal(stale.versions[0].status, "stale"); assert.deepEqual(stale.versions[0].children, plan.children);
			assert.deepEqual((await workflow.read(scope)), stale); assert.equal(calls, 6);
		}
		return { concurrency, maxOverlappingSourceCalls: maxActive, actualFixtureCalls: calls, reservedRuntimeSlices: plan.calls, output: "11", elapsedMs, frozenCandidateRechecked: concurrency === 2 && change === "candidate", completedToolSourceRechecked: concurrency === 2 && change === "tool" };
	} finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}
const serial = await run(1), parallel = await run(2), completedToolSource = await run(2, "tool");
assert.equal(serial.output, parallel.output); assert.equal(serial.actualFixtureCalls, parallel.actualFixtureCalls);
console.log(JSON.stringify({ fixture: "packx-readonly-parallel-v2", passed: true, sharedLimits: PLAN_LIMITS, serial, parallel, completedToolSource, conclusion: "Two independent reads overlap with identical fixture output and call count. Elapsed time includes artificial waiting; no real-model quality, price cap or user-value claim." }, null, 2));
