import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentToolExecutionContext, AgentToolExecutionRecord } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import { FileCronScheduleStore } from "../enterprise/fileCronScheduleStore";
import { FileStageJobQueue } from "../enterprise/fileStageJobQueue";
import { PersonalMemoryStore } from "../enterprise/personalMemoryStore";
import { PersonalMemoryService } from "../enterprise/personalMemoryService";
import { createAutomationTools } from "./automationTools";
import { mutationBinding, recoverAutomationMutation } from "./mutationRecovery";
import { FileAgentStateStore } from "./fileAgentStateStore";
import { BlackxAgentRuntime } from "./agentRuntime";

const now = new Date("2026-10-22T00:00:00.000Z");
const context: AgentToolExecutionContext = { tenantId: "mutation-tenant", workspaceId: "mutation-workspace", runId: "mutation-run", stageId: "conversation", actorId: "mutation-user", executionId: "mutation-execution", toolCallId: "mutation-call", idempotencyKey: "mutation-command", approvalId: "policy:mutation:v1", signal: new AbortController().signal };
const roots: string[] = [], memories: PersonalMemoryStore[] = [];
afterEach(() => { vi.restoreAllMocks(); memories.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "packx-mutation-")); roots.push(root);
	const open = () => ({ queue: new FileStageJobQueue(join(root, "jobs.json"), { now: () => now }), schedules: new FileCronScheduleStore(join(root, "cron.json"), () => now) });
	return { root, open, ...open() };
}
function record(tool: string, input: unknown, ctx = context): AgentToolExecutionRecord {
	return { ...mutationBinding(tool, input, ctx), schemaVersion: "tool-execution.v1", risk: "write", status: "unknown", startedAt: now.toISOString(), failureCode: "tool_execution_unknown" };
}
const cronInput = { name: "bounded-check", expression: "*/5 * * * *", timezone: "UTC", prompt: "Review the current state", maxRuns: 3 };

it.each(["background_task_create", "background_task_cancel", "cron_create", "cron_pause", "cron_resume"])("recovers %s from its committed receipt after restart without replaying a mutation", async name => {
	const { queue, schedules, open } = fixture();
	const tools = createAutomationTools(queue, schedules, () => now);
	let input: unknown = name === "background_task_create" ? { objective: "Review" } : cronInput;
	if (name === "background_task_cancel") {
		await tools.find(tool => tool.name === "background_task_create")!.execute({ objective: "Review" }, { ...context, idempotencyKey: "seed" });
		input = { taskId: queue.list()[0].jobId };
	} else if (name === "cron_pause" || name === "cron_resume") {
		await tools.find(tool => tool.name === "cron_create")!.execute(cronInput, { ...context, idempotencyKey: "seed" });
		input = { scheduleId: schedules.list(context)[0].scheduleId };
		if (name === "cron_resume") schedules.setStatus(schedules.list(context)[0].scheduleId, context, "paused");
	}
	const result = JSON.parse(JSON.stringify(await tools.find(tool => tool.name === name)!.execute(input, context)));
	const expected = record(name, input);
	// Later business state is not the historical result of the uncertain call.
	if (name === "background_task_create") queue.cancel(queue.list()[0].jobId, context);
	if (name === "cron_create" || name === "cron_resume") schedules.setStatus(schedules.list(context)[0].scheduleId, context, "paused");
	if (name === "cron_pause") schedules.setStatus(schedules.list(context)[0].scheduleId, context, "active", now.toISOString());
	const reopened = open(), before = { jobs: reopened.queue.list(), cron: reopened.schedules.list(context) };
	expect(JSON.parse(recoverAutomationMutation(reopened.queue, reopened.schedules, expected, context.signal)!.result)).toEqual(result);
	expect(recoverAutomationMutation(reopened.queue, reopened.schedules, expected, context.signal)?.evidenceRef).toContain(`:${name}`);
	expect({ jobs: reopened.queue.list(), cron: reopened.schedules.list(context) }).toEqual(before);
	for (const key of ["actorId", "executionId", "toolCallId", "stageId", "approvalId", "inputDigest"] as const) {
		expect(() => recoverAutomationMutation(reopened.queue, reopened.schedules, { ...expected, [key]: key === "inputDigest" ? "a".repeat(64) : "different" }, context.signal)).toThrow("mutation_receipt_identity_conflict");
	}
	for (const key of ["tenantId", "workspaceId", "runId"] as const) expect(recoverAutomationMutation(reopened.queue, reopened.schedules, { ...expected, [key]: "other" }, context.signal)).toBeUndefined();
	expect(() => recoverAutomationMutation(reopened.queue, reopened.schedules, expected, AbortSignal.abort())).toThrow();
});

it("reconciles the uncertain ledger before a model attempts the same background command", async () => {
	const { queue, schedules, root } = fixture();
	const tools = createAutomationTools(queue, schedules, () => now), input = { objective: "Review once" };
	const tool = tools.find(tool => tool.name === "background_task_create")!;
	const ctx = { ...context, idempotencyKey: "turn:background_task_create" };
	await tool.execute(input, ctx);
	const state = new FileAgentStateStore(join(root, "agent"));
	const { failureCode: _failure, ...reservation } = record(tool.name, input, ctx);
	await state.claim({ ...reservation, status: "started" });
	await state.complete(record(tool.name, input, ctx), { status: "unknown", failureCode: "tool_execution_unknown", result: "unknown", resultDigest: "unknown", completedAt: now.toISOString() });
	const execute = vi.spyOn(tool, "execute");
	const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 };
	const generate = vi.fn().mockResolvedValueOnce({ text: "", toolCalls: [{ id: "same-call", name: tool.name, input }], usage }).mockResolvedValue({ text: "Saved", toolCalls: [], usage });
	const runtime = new BlackxAgentRuntime({ provider: { generate }, tools, skills: new SkillRegistry(), sessions: state, snapshots: state, traces: state, executions: state,
		approval: { authorize: async () => ({ approved: true, approvalId: context.approvalId }) }, audit: { append: async () => {} }, recoverToolExecution: async (entry, signal) => recoverAutomationMutation(queue, schedules, entry, signal) });
	const result = await runtime.executeTurn({ ...context, idempotencyKey: "turn", sessionId: context.runId, input: "Continue", fallbackOutput: "unused", allowedTools: [tool.name], policy: { sandboxMode: "workspace-write", approvalPolicy: "required", timeoutMs: 10_000 } });
	expect(result.events).toContainEqual(expect.objectContaining({ type: "tool.reconciled", status: "succeeded" }));
	expect(result.events).toContainEqual(expect.objectContaining({ type: "tool.completed", status: "succeeded", replayed: true }));
	expect(execute).not.toHaveBeenCalled();
	expect(queue.list()).toHaveLength(1);
	expect(await state.find(record(tool.name, input, ctx))).toMatchObject({ status: "succeeded", reconciliation: { previousStatus: "unknown" } });
});

it("rolls back queue and Cron mutations when receipt creation fails", () => {
	const { queue, schedules, open } = fixture();
	const mutation = { binding: mutationBinding("cron_create", cronInput, context), result: () => { throw new Error("receipt_unavailable"); } };
	expect(() => schedules.create({ ...context, ...cronInput, scheduleId: "test-schedule", nextRunAt: now.toISOString() }, mutation)).toThrow();
	expect(() => queue.enqueue({ ...context, sessionId: context.runId, jobId: "test-job", commandId: "command", correlationId: "correlation", expectedVersion: 0 }, mutation)).toThrow();
	expect(open().queue.list()).toEqual([]);
	expect(open().schedules.list(context)).toEqual([]);
});

it("commits memory candidates and receipts atomically without activating or restoring forgotten content", async () => {
	const { root } = fixture(), sessions = new FileAgentStateStore(join(root, "agent")), path = join(root, "memory.sqlite");
	const scope = { ...context, sessionId: context.runId };
	sessions.save(scope, 0, [{ role: "user", kind: "dialogue", messageId: "remember", content: "请长期记住：报告使用简洁中文" }], now.toISOString());
	const open = () => { const store = new PersonalMemoryStore(path, () => true); memories.push(store); return store; };
	const store = open(), service = new PersonalMemoryService(store, sessions), input = { sourceMessageId: "remember", topic: "Reporting", content: "Use concise Chinese." };
	const db = new DatabaseSync(path);
	try {
		db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON personal_memory_receipts BEGIN SELECT RAISE(ABORT, 'receipt_unavailable'); END");
		await expect(service.tool().execute(input, context)).rejects.toThrow("receipt_unavailable");
		expect(store.view(context).items).toEqual([]); expect(store.audit(context)).toEqual([]);
		db.exec("DROP TRIGGER fail_receipt");
	} finally { db.close(); }
	const result = await service.tool().execute(input, context);
	expect(store.recall(context).items).toEqual([]);
	const item = store.view(context).items[0];
	store.decide(context, "forget", item.id, item.revision, "forget");
	const reopened = open(), recovered = new PersonalMemoryService(reopened, sessions).reconcile(record("memory_propose", input), context.signal);
	expect(JSON.parse(recovered!.result)).toEqual(result);
	expect(result).toMatchObject({ status: "awaiting_user_confirmation", active: false });
	expect(reopened.recall(context).items).toEqual([]);
	expect(JSON.stringify(reopened.view(context))).not.toContain(input.content);
	expect(reopened.audit(context)).toHaveLength(2);
	expect(() => new PersonalMemoryService(reopened, sessions).reconcile({ ...record("memory_propose", input), approvalId: "other" }, context.signal)).toThrow("mutation_receipt_identity_conflict");
});
