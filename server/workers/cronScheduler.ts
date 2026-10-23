import { createHash } from "node:crypto";
import { Cron } from "croner";
import { CronScheduleError, type CronSchedule, type CronScheduleStore } from "../../src/enterprise/cronSchedule";
import { StageJobQueueError, type StageJobQueue } from "../../src/enterprise/stageJobQueue";
import { enqueueBackgroundConversationTask } from "./backgroundTaskApi";

function parseCron(expression: string, timezone: string, after: Date): Cron {
	if (!expression.trim() || expression.length > 120 || !timezone.trim() || timezone.length > 80) {
		throw new CronScheduleError("invalid_schedule", "invalid_cron_schedule");
	}
	new Intl.DateTimeFormat("en", { timeZone: timezone }).format(after);
	return new Cron(expression, { timezone, paused: true });
}

export function nextCronRun(expression: string, timezone: string, after: Date): Date {
	const next = parseCron(expression, timezone, after).nextRun(after);
	if (!next) throw new CronScheduleError("cron_has_no_next_run", "cron_has_no_next_run");
	return next;
}

function assertInterval(previous: Date, next: Date): void {
	if (next.getTime() - previous.getTime() < 300_000) throw new CronScheduleError("cron_frequency_below_five_minutes", "cron_frequency_below_five_minutes");
}

export function validateCronFrequency(expression: string, timezone: string, after: Date, remainingRuns = 100, lastRunAt?: string): Date {
	if (!Number.isInteger(remainingRuns) || remainingRuns < 1 || remainingRuns > 100) throw new CronScheduleError("invalid_schedule", "invalid_cron_run_limit");
	// Preserve the two-occurrence minimum while checking every authorized future occurrence.
	const count = Math.max(2, remainingRuns), runs = parseCron(expression, timezone, after).nextRuns(count, after);
	if (runs.length !== count) throw new CronScheduleError("cron_has_no_next_run", "cron_has_no_next_run");
	if (lastRunAt) assertInterval(new Date(lastRunAt), runs[0]);
	for (let index = 1; index < runs.length; index++) assertInterval(runs[index - 1], runs[index]);
	return runs[0];
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
				const current = new Date(schedule.nextRunAt);
				if (schedule.lastRunAt) assertInterval(new Date(schedule.lastRunAt), current);
				// Validate before enqueue: invalid legacy schedules must not create unacknowledged jobs.
				const next = schedule.runCount + 1 >= schedule.maxRuns ? undefined : nextCronRun(schedule.expression, schedule.timezone, current);
				if (next) assertInterval(current, next);
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
				this.schedules.acknowledge(schedule.scheduleId, schedule.nextRunAt, next?.toISOString(), job.jobId);
				dispatched++;
			} catch (error) {
				failures.push(error);
				try { this.schedules.defer(schedule.scheduleId, schedule.nextRunAt, error instanceof StageJobQueueError || error instanceof CronScheduleError ? error.code : "cron_dispatch_failed"); }
				catch (storageError) { failures.push(storageError); }
			}
		}
		if (failures.length) { if (this.onError) for (const failure of failures) this.onError(failure); else throw new AggregateError(failures, "Cron dispatch failed", { cause: failures[0] }); }
		return dispatched;
	}
}
