import { mutationBinding, mutationResult } from "./mutationRecovery";
import { findMutationReceipt } from "../../src/enterprise/mutationReceipt";
import { createHash } from "node:crypto";
import type { AgentHostTool } from "../../src/agent/contracts";
import type { CronSchedule, CronScheduleStore } from "../../src/enterprise/cronSchedule";
import type { StageJob, StageJobQueue } from "../../src/enterprise/stageJobQueue";
import { backgroundTaskView, enqueueBackgroundConversationTask } from "../workers/backgroundTaskApi";
import { validateCronFrequency } from "../workers/cronScheduler";

export const automationToolNames = [
	"background_task_create",
	"background_task_status",
	"background_task_cancel",
	"cron_create",
	"cron_list",
	"cron_pause",
	"cron_resume",
] as const;

export const automationWriteToolNames = new Set([
	"background_task_create",
	"background_task_cancel",
	"cron_create",
	"cron_pause",
	"cron_resume",
]);

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, key: string, maxLength: number): boolean {
	return record(value) && typeof value[key] === "string" && value[key].trim().length > 0 &&
		String(value[key]).length <= maxLength;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function automationScheduleView(schedule: CronSchedule) {
	return {
		scheduleId: schedule.scheduleId,
		conversationId: schedule.runId,
		name: schedule.name,
		expression: schedule.expression,
		timezone: schedule.timezone,
		status: schedule.status,
		runCount: schedule.runCount,
		maxRuns: schedule.maxRuns,
		nextRunAt: schedule.nextRunAt,
		lastRunAt: schedule.lastRunAt,
		updatedAt: schedule.updatedAt,
		pendingJobId: schedule.pendingJobId,
		failure: schedule.failure,
		dispatchFailure: schedule.dispatchFailure,
	};
}

function scopedSchedule(
	schedules: CronScheduleStore,
	scheduleId: string,
	context: { tenantId: string; workspaceId: string; runId: string },
): CronSchedule | undefined {
	const schedule = schedules.get(scheduleId);
	return schedule?.tenantId === context.tenantId &&
		schedule.workspaceId === context.workspaceId &&
		schedule.runId === context.runId
		? schedule
		: undefined;
}

export function createAutomationTools(
	queue: StageJobQueue,
	schedules: CronScheduleStore,
	now: () => Date = () => new Date(),
): AgentHostTool[] {
	return [
		{
			name: "background_task_create",
			description: "Create one bounded background task in the current conversation when the work should continue asynchronously. Do not use for a quick direct answer.",
			inputSchema: {
				type: "object",
				properties: { objective: { type: "string", maxLength: 8_000 } },
				required: ["objective"],
				additionalProperties: false,
			},
			execution: "host",
			risk: "write",
			idempotent: true,
			timeoutMs: 1_000,
			maxResultChars: 2_000,
			validate: (input) => stringField(input, "objective", 8_000),
			createIdempotencyKey: (_input, turnKey) => `${turnKey}:background_task_create`,
			execute: async (input, context) => {
				const objective = String((input as { objective: string }).objective).trim();
				const messageId = `agent-task-${digest(context.idempotencyKey)}`;
				const binding = mutationBinding("background_task_create", input, context);
				const job = enqueueBackgroundConversationTask(queue, {
					tenantId: context.tenantId, workspaceId: context.workspaceId, conversationId: context.runId,
					messageId, content: `[Agent 后台任务]\n${objective}`, actorId: `agent:${context.actorId}`,
					requestedBy: "agent", availableAt: new Date(now().getTime() + 5_000).toISOString(),
				}, { binding, result: (value: StageJob) => ({ ok: true, task: backgroundTaskView(value) }) });
				return mutationResult(job.mutationReceipts, binding);
			},
		},
		{
			name: "background_task_status",
			description: "Read the status of a background task in the current tenant and conversation.",
			inputSchema: {
				type: "object",
				properties: { taskId: { type: "string" } },
				required: ["taskId"],
				additionalProperties: false,
			},
			execution: "host",
			risk: "read",
			idempotent: true,
			timeoutMs: 1_000,
			maxResultChars: 2_000,
			validate: (input) => stringField(input, "taskId", 128),
			execute: async (input, context) => {
				const job = queue.get(String((input as { taskId: string }).taskId));
				return job?.stageId === "conversation-background" && job.tenantId === context.tenantId &&
					job.workspaceId === context.workspaceId && job.runId === context.runId
					? { ok: true, task: backgroundTaskView(job) }
					: { ok: false, code: "background_task_not_found" };
			},
		},
		{
			name: "background_task_cancel",
			description: "Cancel a queued background task in the current conversation. A task already leased by a worker cannot be cancelled by this tool.",
			inputSchema: {
				type: "object",
				properties: { taskId: { type: "string" } },
				required: ["taskId"],
				additionalProperties: false,
			},
			execution: "host",
			risk: "write",
			idempotent: true,
			timeoutMs: 1_000,
			maxResultChars: 2_000,
			validate: (input) => stringField(input, "taskId", 128),
			createIdempotencyKey: (input, turnKey) => `${turnKey}:background_task_cancel:${String((input as { taskId: string }).taskId)}`,
			execute: async (input, context) => {
				const binding = mutationBinding("background_task_cancel", input, context);
				const job = queue.cancel(String((input as { taskId: string }).taskId), context,
					{ binding, result: value => ({ ok: true, task: backgroundTaskView(value) }) });
				return mutationResult(job.mutationReceipts, binding);
			},
		},
		{
			name: "cron_create",
			description: "Create a bounded recurring background task for the current conversation. Minimum frequency is five minutes and maxRuns is required (1-100).",
			inputSchema: {
				type: "object",
				properties: {
					name: { type: "string", maxLength: 120 },
					expression: { type: "string", maxLength: 120 },
					timezone: { type: "string", maxLength: 80 },
					prompt: { type: "string", maxLength: 8_000 },
					maxRuns: { type: "integer", minimum: 1, maximum: 100 },
				},
				required: ["name", "expression", "timezone", "prompt", "maxRuns"],
				additionalProperties: false,
			},
			execution: "host",
			risk: "write",
			idempotent: true,
			timeoutMs: 1_000,
			maxResultChars: 2_000,
			validate: (input) => stringField(input, "name", 120) &&
				stringField(input, "expression", 120) &&
				stringField(input, "timezone", 80) &&
				stringField(input, "prompt", 8_000) &&
				Number.isInteger((input as Record<string, unknown>).maxRuns) &&
				Number((input as Record<string, unknown>).maxRuns) >= 1 &&
				Number((input as Record<string, unknown>).maxRuns) <= 100,
			createIdempotencyKey: (_input, turnKey) => `${turnKey}:cron_create`,
			execute: async (input, context) => {
				const request = input as { name: string; expression: string; timezone: string; prompt: string; maxRuns: number };
				const binding = mutationBinding("cron_create", input, context);
				const schedule = schedules.create({
					tenantId: context.tenantId, workspaceId: context.workspaceId, runId: context.runId,
					scheduleId: `schedule-${digest(context.idempotencyKey)}`, name: request.name.trim(),
					expression: request.expression.trim(), timezone: request.timezone.trim(), prompt: request.prompt.trim(),
					actorId: `agent:${context.actorId}`, maxRuns: request.maxRuns,
					nextRunAt: validateCronFrequency(request.expression, request.timezone, now(), request.maxRuns).toISOString(),
				}, { binding, result: value => ({ ok: true, schedule: automationScheduleView(value) }) });
				return mutationResult(schedule.mutationReceipts, binding);
			},
		},
		{
			name: "cron_list",
			description: "List Cron schedules for the current conversation.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			execution: "host",
			risk: "read",
			idempotent: true,
			timeoutMs: 1_000,
			maxResultChars: 8_000,
			validate: (input) => record(input) && Object.keys(input).length === 0,
			execute: async (_input, context) => ({
				ok: true,
				schedules: schedules.list(context)
					.filter((schedule) => schedule.runId === context.runId)
					.map(automationScheduleView),
			}),
		},
		...(["pause", "resume"] as const).map((action): AgentHostTool => ({
			name: `cron_${action}`,
			description: `${action === "pause" ? "Pause" : "Resume"} a Cron schedule in the current conversation.`,
			inputSchema: {
				type: "object",
				properties: { scheduleId: { type: "string" } },
				required: ["scheduleId"],
				additionalProperties: false,
			},
			execution: "host",
			risk: "write",
			idempotent: true,
			timeoutMs: 1_000,
			maxResultChars: 2_000,
			validate: (input) => stringField(input, "scheduleId", 128),
			createIdempotencyKey: (input, turnKey) => `${turnKey}:cron_${action}:${String((input as { scheduleId: string }).scheduleId)}`,
			execute: async (input, context) => {
				const scheduleId = String((input as { scheduleId: string }).scheduleId);
				const existing = scopedSchedule(schedules, scheduleId, context);
				if (!existing) return { ok: false, code: "cron_schedule_not_found" };
				const binding = mutationBinding(`cron_${action}`, input, context);
				const receipt = findMutationReceipt(existing.mutationReceipts, binding);
				if (receipt) return JSON.parse(receipt.result);
				const updated = schedules.setStatus(
					scheduleId,
					context,
					action === "pause" ? "paused" : "active",
					action === "resume"
						? validateCronFrequency(existing.expression, existing.timezone, now(), existing.maxRuns - existing.runCount, existing.lastRunAt).toISOString()
						: undefined,
					{ binding, result: value => ({ ok: true, schedule: automationScheduleView(value) }) },
				);
				return mutationResult(updated.mutationReceipts, binding);
			},
		})),
	];
}
