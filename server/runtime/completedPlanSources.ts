import type { AgentTool } from "../../src/agent/contracts";
import { AgentStateStoreError } from "../../src/agent/state";
import { PlanError, parsePlan, parseSubagentResult, type PlanScope, type PlanVersion } from "../../src/enterprise/agentPlan";
import { KnowledgeError } from "../../src/enterprise/knowledge";
import { SourceReportError } from "../../src/enterprise/sourceReport";
import { RuntimeFailure } from "../../src/runtime/contracts";
import { ConversationAttachmentError } from "./conversationAttachments";
import { TaskFileError } from "./localFileAccess";
import type { FileAgentStateStore } from "./fileAgentStateStore";
import { recoverCompletedTurn } from "./recoverCompletedTurn";
import { validateContextSources } from "./contextSources";

function sourceFailure(error: unknown): "changed" | "evidence_missing" | "limit" | "unavailable" {
	let leaf = error;
	for (let depth = 0; depth < 16 && leaf instanceof Error && leaf.cause; depth++) leaf = leaf.cause;
	if (leaf instanceof Error && leaf.cause) return "unavailable"; // An unbounded/cyclic cause chain is not proof of source withdrawal.
	if (leaf instanceof TaskFileError && leaf.code === "file_quota_exceeded") return "unavailable";
	if (leaf instanceof AgentStateStoreError) return leaf.code === "not_found" ? "evidence_missing" : "unavailable";
	if (leaf instanceof TaskFileError || leaf instanceof SourceReportError || leaf instanceof KnowledgeError) return leaf.status >= 400 && leaf.status < 500 ? "changed" : "unavailable";
	if (leaf instanceof ConversationAttachmentError) return ["attachment_not_found", "attachment_withdrawn", "attachment_conflict"].includes(leaf.code) ? "changed" : "unavailable";
	if (leaf instanceof RuntimeFailure) {
		if (leaf.code === "budget_exceeded" || leaf.message === "Context source dependency limit exceeded; rebuild task") return "limit";
		if (["Legacy tool archive has no source provenance; rebuild task context", "Archived context read has no source"].includes(leaf.message)) return "evidence_missing";
		return !leaf.retryable && ["context_failure", "permission_denied"].includes(leaf.code) ? "changed" : "unavailable";
	}
	return leaf instanceof Error && ["ENOENT", "EACCES", "EPERM"].includes(String((leaf as NodeJS.ErrnoException).code)) ? "changed" : "unavailable";
}

/** Bind original Plan receipts to immutable traces/snapshots, then reuse current source policy. */
export async function validateCompletedPlanSources(store: FileAgentStateStore, tools: readonly AgentTool[], scope: PlanScope, plan: PlanVersion, signal: AbortSignal): Promise<void> {
	const started = performance.now();
	const assertDeadline = () => { signal.throwIfAborted(); if (performance.now() - started >= 5000) throw new RuntimeFailure("infrastructure_failure", "Source review deadline exceeded; retry without replaying the task", true); };
	const traces = store.listTraces(scope);
	const receipts = { getSession: store.getSession.bind(store), listTraces: () => traces };
	const budget = { remainingSources: 128, remainingMessages: 10_000, remainingChars: 2_000_000 };
	const planner = traces.findLast(trace => trace.stageId === "plan" && trace.actorId === plan.actorId && trace.idempotencyKey === `plan-v${plan.version}-planning` && trace.status === "completed");
	if (!planner?.sessionId) throw new PlanError("plan_completion_evidence_missing");
	const expected = [{ stageId: "plan", sessionId: planner.sessionId, executionId: planner.executionId }, ...plan.children.map(child => ({ stageId: `subagent-${child.taskIndex}`, sessionId: child.sessionId, executionId: child.executionId }))];
	for (const item of expected) {
		assertDeadline();
		const trace = traces.find(trace => trace.executionId === item.executionId && trace.stageId === item.stageId && trace.sessionId === item.sessionId && trace.actorId === plan.actorId && trace.status === "completed");
		if (!trace?.contextSnapshotId) throw new PlanError("plan_completion_evidence_missing");
		const result = recoverCompletedTurn(receipts, scope, item.sessionId, trace.idempotencyKey);
		if (!result || result.executionId !== trace.executionId) throw new PlanError("plan_completion_evidence_missing");
		if (item.stageId === "plan" && JSON.stringify(parsePlan(JSON.parse(result.finalResponse), plan.spec!.tasks.flatMap(task => task.tools))) !== JSON.stringify(plan.spec)) throw new PlanError("plan_completion_evidence_missing");
		const child = plan.children.find(child => child.executionId === item.executionId);
		if (child && (trace.idempotencyKey !== plan.taskRuns?.find(run => run.taskIndex === child.taskIndex)?.idempotencyKey || JSON.stringify(parseSubagentResult(JSON.parse(result.finalResponse), true)) !== JSON.stringify(child.result))) throw new PlanError("plan_completion_evidence_missing");
		if (trace.events.some(event => event.type === "tool.completed" && event.status !== "succeeded")) throw new PlanError("plan_completion_evidence_missing");
		const roots = new Set([trace.contextSnapshotId]);
		for (const slice of traces.filter(slice => slice.sessionId === item.sessionId && slice.stageId === item.stageId && slice.actorId === plan.actorId && slice.idempotencyKey === trace.idempotencyKey && ["paused", "completed"].includes(slice.status))) {
			if (slice.contextSnapshotId) roots.add(slice.contextSnapshotId);
			for (const event of slice.events) {
				if (event.type === "context.snapshot.saved") roots.add(event.snapshotId);
				if (event.type === "context.summary") roots.add(event.callId);
			}
		}
		const visited = new Set<string>();
		for (const ref of roots) {
			assertDeadline();
			if (visited.has(ref)) continue;
			visited.add(ref);
			if (--budget.remainingSources < 0) throw new PlanError("plan_source_review_limit", 422);
			let snapshot;
			try { snapshot = store.read({ ...scope, sessionId: item.sessionId }, ref); }
			catch (error) { if (error instanceof AgentStateStoreError && error.code === "not_found") throw new PlanError("plan_completion_evidence_missing"); throw error; }
			try {
				await validateContextSources({ sessions: store, snapshots: store, tools: tools.filter(tool => tool.risk === "read"), readOnly: true, context: { ...scope, sessionId: item.sessionId, actorId: plan.actorId, executionId: trace.executionId, stageId: item.stageId, toolCallId: "completion-review", idempotencyKey: trace.idempotencyKey, signal }, binding: snapshot.contextBinding, historyBinding: snapshot.historyBinding, budget }, snapshot.messages, visited);
				assertDeadline();
			} catch (error) {
				signal.throwIfAborted();
				const failure = sourceFailure(error);
				if (failure === "limit") throw new PlanError("plan_source_review_limit", 422);
				if (failure === "evidence_missing") throw new PlanError("plan_completion_evidence_missing");
				if (failure === "changed") throw new RuntimeFailure("context_failure", "Completed task sources changed or are no longer permitted", false, { cause: error });
				throw new RuntimeFailure("infrastructure_failure", "Completed source review is unavailable; retry without replaying the task", true, { cause: error });
			}
		}
	}
}
