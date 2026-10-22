import { createHash } from "node:crypto";
import type { AgentToolExecutionContext, AgentToolExecutionRecord } from "../../src/agent/contracts";
import { findMutationReceipt, type MutationBinding, type MutationReceipt } from "../../src/enterprise/mutationReceipt";
import type { StageJobQueue } from "../../src/enterprise/stageJobQueue";
import type { CronScheduleStore } from "../../src/enterprise/cronSchedule";

export function mutationBinding(tool: string, input: unknown, context: AgentToolExecutionContext): MutationBinding {
	context.signal.throwIfAborted();
	if (!context.approvalId) throw new Error("mutation_approval_required");
	const { tenantId, workspaceId, runId, stageId, actorId, executionId, toolCallId, idempotencyKey, approvalId } = context;
	return { tenantId, workspaceId, runId, stageId, actorId, executionId, toolCallId, idempotencyKey, approvalId, tool, inputDigest: `sha256:${createHash("sha256").update(JSON.stringify(input) ?? "undefined").digest("hex")}` };
}

export function mutationResult(receipts: MutationReceipt[] | undefined, binding: MutationBinding): unknown {
	const receipt = findMutationReceipt(receipts, binding);
	if (!receipt) throw new Error("mutation_receipt_missing");
	return JSON.parse(receipt.result);
}

export function recoverAutomationMutation(queue: StageJobQueue, schedules: CronScheduleStore, record: AgentToolExecutionRecord, signal: AbortSignal) {
	signal.throwIfAborted();
	const owners = record.tool.startsWith("background_task_") ? queue.list() : record.tool.startsWith("cron_") ? schedules.list(record) : [];
	for (const owner of owners) {
		if (owner.tenantId !== record.tenantId || owner.workspaceId !== record.workspaceId || owner.runId !== record.runId) continue;
		const receipt = findMutationReceipt(owner.mutationReceipts, record);
		if (receipt) return { result: receipt.result, evidenceRef: `mutation:${"jobId" in owner ? owner.jobId : owner.scheduleId}:${record.tool}` };
	}
	return undefined;
}
