import { createHash } from "node:crypto";
import { Cron } from "croner";
import type { CronSchedule, CronScheduleStore } from "../../src/enterprise/cronSchedule";
import { StageJobQueueError, type StageJobQueue } from "../../src/enterprise/stageJobQueue";
import { enqueueBackgroundConversationTask } from "./backgroundTaskApi";

export function nextCronRun(expression: string, timezone: string, after: Date): Date {
	if (!expression.trim() || expression.length > 120 || !timezone.trim() || timezone.length > 80) {
		throw new Error("invalid_cron_schedule");
	}
	new Intl.DateTimeFormat("en", { timeZone: timezone }).format(after);
	const next = new Cron(expression, { timezone, paused: true }).nextRun(after);
	if (!next) throw new Error("cron_has_no_next_run");
	return next;
}

export function validateCronFrequency(expression: string, timezone: string, after: Date): Date {
	const first = nextCronRun(expression, timezone, after);
	const second = nextCronRun(expression, timezone, first);
	if (second.getTime() - first.getTime() < 300_000) throw new Error("cron_frequency_below_five_minutes");
	return first;
}

function occurrenceId(schedule: CronSchedule): string {
	return createHash("sha256")
		.update(`${schedule.scheduleId}\u0000${schedule.nextRunAt}`)
		.digest("hex");
}

export class CronDispatcher {
	constructor(
		private readonly schedules: CronScheduleStore,
		private readonly queue: StageJobQueue,
		private readonly now: () => Date = () => new Date(),
		private readonly onError?: (error: unknown) => void,
	) {}

	dispatchDue(limit = 10): number {
		const failures: unknown[] = [];
		for (const schedule of this.schedules.pending()) {
			try {
				const job = this.queue.get(schedule.pendingJobId!);
				if (!job || job.tenantId !== schedule.tenantId || job.workspaceId !== schedule.workspaceId || job.runId !== schedule.runId) throw new Error("cron_pending_job_unavailable");
				if (job.status === "completed" || job.status === "dead_letter" || job.status === "cancelled") this.schedules.settle(schedule.scheduleId, job.jobId, job.status, job.lastFailure?.code);
			} catch (error) { failures.push(error); }
		}
		const due = this.schedules.due(this.now().toISOString(), limit);
		let dispatched = 0;
		for (const schedule of due) {
			try {
				const occurrence = occurrenceId(schedule);
				const job = enqueueBackgroundConversationTask(this.queue, {
					tenantId: schedule.tenantId,
					workspaceId: schedule.workspaceId,
					conversationId: schedule.runId,
					messageId: `cron-${occurrence}`,
					content: `[定时任务：${schedule.name}]\n${schedule.prompt}`,
					actorId: `cron:${schedule.scheduleId}`,
					requestedBy: "cron",
				});
				const next = schedule.runCount + 1 >= schedule.maxRuns
					? undefined
					: nextCronRun(schedule.expression, schedule.timezone, new Date(schedule.nextRunAt)).toISOString();
				this.schedules.acknowledge(schedule.scheduleId, schedule.nextRunAt, next, job.jobId);
				dispatched++;
			} catch (error) {
				failures.push(error);
				try { this.schedules.defer(schedule.scheduleId, schedule.nextRunAt, error instanceof StageJobQueueError ? error.code : "cron_dispatch_failed"); }
				catch (storageError) { failures.push(storageError); }
			}
		}
		if (failures.length) { if (this.onError) for (const failure of failures) this.onError(failure); else throw new AggregateError(failures, "Cron dispatch failed", { cause: failures[0] }); }
		return dispatched;
	}
}
