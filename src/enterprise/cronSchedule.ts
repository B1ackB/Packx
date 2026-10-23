import { findMutationReceipt, recordMutation, validMutationReceipts, type MutationReceipt, type RecordedMutation } from "./mutationReceipt";
import type { AggregateScope, OutboxRedriveRequest } from "./contracts";

export type CronScheduleStatus = "active" | "paused" | "completed" | "failed";

export interface CronScheduleInput extends AggregateScope {
	scheduleId: string;
	name: string;
	expression: string;
	timezone: string;
	prompt: string;
	actorId: string;
	maxRuns: number;
	nextRunAt: string;
}

export interface CronSchedule extends CronScheduleInput {
	mutationReceipts?: MutationReceipt[];
	pendingJobId?: string;
	dispatchFailure?: { count: number; code: string; at: string; retryAt: string };
	failure?: { code: string; at: string; jobId?: string };
	recoveries?: Array<Pick<OutboxRedriveRequest, "requestId" | "actorId" | "reason" | "expectedUpdatedAt"> & { at: string }>;
	schemaVersion: "cron-schedule.v1";
	status: CronScheduleStatus;
	runCount: number;
	createdAt: string;
	updatedAt: string;
	lastRunAt?: string;
}

export interface CronScheduleStore {
	create(input: CronScheduleInput, mutation?: RecordedMutation<CronSchedule>): CronSchedule;
	get(scheduleId: string): CronSchedule | undefined;
	list(scope: { tenantId: string; workspaceId: string }): CronSchedule[];
	due(now: string, limit?: number): CronSchedule[];
	pending(): CronSchedule[];
	settle(scheduleId: string, jobId: string, outcome: "completed" | "dead_letter" | "cancelled", code?: string): void;
	defer(scheduleId: string, expectedRunAt: string, code: string): void;
	recover(scheduleId: string, request: OutboxRedriveRequest): CronSchedule;
	acknowledge(scheduleId: string, expectedRunAt: string, nextRunAt?: string, jobId?: string): CronSchedule;
	setStatus(
		scheduleId: string,
		scope: { tenantId: string; workspaceId: string },
		status: "active" | "paused",
		nextRunAt?: string,
		mutation?: RecordedMutation<CronSchedule>,
	): CronSchedule;
}

export interface CronScheduleStorage {
	read(): CronSchedule[];
	transaction<Value>(operation: (schedules: CronSchedule[]) => Value): Value;
}

export class CronScheduleError extends Error {
	constructor(
		readonly code: "invalid_schedule" | "schedule_conflict" | "schedule_not_found" | "schedule_store_corrupt" | "schedule_store_unavailable" | "cron_frequency_below_five_minutes" | "cron_has_no_next_run",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CronScheduleError";
	}
}

function clone<Value>(value: Value): Value {
	return structuredClone(value);
}

function validId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isCronSchedule(value: unknown): value is CronSchedule {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const schedule = value as Partial<CronSchedule>;
	return schedule.schemaVersion === "cron-schedule.v1" &&
		validMutationReceipts(schedule) &&
		[schedule.scheduleId, schedule.tenantId, schedule.workspaceId, schedule.runId,
			schedule.actorId].every(validId) &&
		typeof schedule.name === "string" && schedule.name.length > 0 && schedule.name.length <= 120 &&
		typeof schedule.expression === "string" && schedule.expression.length > 0 && schedule.expression.length <= 120 &&
		typeof schedule.timezone === "string" && schedule.timezone.length > 0 && schedule.timezone.length <= 80 &&
		typeof schedule.prompt === "string" && schedule.prompt.length > 0 && schedule.prompt.length <= 8_000 &&
		["active", "paused", "completed", "failed"].includes(String(schedule.status)) &&
		(schedule.pendingJobId === undefined || validId(schedule.pendingJobId)) &&
		(schedule.dispatchFailure === undefined || Number.isSafeInteger(schedule.dispatchFailure.count) && schedule.dispatchFailure.count > 0 && validId(schedule.dispatchFailure.code) && validDate(schedule.dispatchFailure.at) && validDate(schedule.dispatchFailure.retryAt)) &&
		(schedule.failure === undefined || validId(schedule.failure.code) && validDate(schedule.failure.at) && (schedule.failure.jobId === undefined || validId(schedule.failure.jobId))) &&
		(schedule.status !== "failed" || schedule.failure !== undefined) &&
		(schedule.recoveries === undefined || Array.isArray(schedule.recoveries) && schedule.recoveries.length <= 64 && schedule.recoveries.every(item => validId(item.requestId) && validId(item.actorId) && typeof item.reason === "string" && item.reason.length > 0 && item.reason.length <= 500 && validDate(item.expectedUpdatedAt) && validDate(item.at))) &&
		Number.isInteger(schedule.maxRuns) && Number(schedule.maxRuns) > 0 && Number(schedule.maxRuns) <= 100 &&
		Number.isInteger(schedule.runCount) && Number(schedule.runCount) >= 0 &&
		validDate(schedule.nextRunAt) && validDate(schedule.createdAt) && validDate(schedule.updatedAt) &&
		(schedule.lastRunAt === undefined || validDate(schedule.lastRunAt));
}

function assertInput(input: CronScheduleInput): void {
	const candidate: CronSchedule = {
		...input,
		schemaVersion: "cron-schedule.v1",
		status: "active",
		runCount: 0,
		createdAt: input.nextRunAt,
		updatedAt: input.nextRunAt,
	};
	if (!isCronSchedule(candidate)) throw new CronScheduleError("invalid_schedule", "Cron Schedule is invalid");
}

export class DurableCronScheduleStore implements CronScheduleStore {
	constructor(
		private readonly storage: CronScheduleStorage,
		private readonly now: () => Date = () => new Date(),
	) {}

	create(input: CronScheduleInput, mutation?: RecordedMutation<CronSchedule>): CronSchedule {
		assertInput(input);
		return this.storage.transaction((schedules) => {
			const existing = schedules.find((schedule) => schedule.scheduleId === input.scheduleId);
			if (existing) {
				if (mutation) {
					if (!findMutationReceipt(existing.mutationReceipts, mutation.binding)) throw new CronScheduleError("schedule_conflict", "Existing schedule has no matching mutation receipt");
					return clone(existing);
				}
				const comparable = (({ schemaVersion: _schemaVersion, status: _status, runCount: _runCount,
					createdAt: _createdAt, updatedAt: _updatedAt, lastRunAt: _lastRunAt, mutationReceipts: _receipts, pendingJobId: _job, dispatchFailure: _dispatch, failure: _failure, recoveries: _recoveries, ...rest }) => rest)(existing);
				if (JSON.stringify(comparable) !== JSON.stringify(input)) {
					throw new CronScheduleError("schedule_conflict", "Cron Schedule ID is already bound to another request");
				}
				return clone(existing);
			}
			const now = this.now().toISOString();
			const schedule: CronSchedule = {
				...input,
				schemaVersion: "cron-schedule.v1",
				status: "active",
				runCount: 0,
				createdAt: now,
				updatedAt: now,
			};
			recordMutation(schedule, mutation);
			schedules.push(schedule);
			return clone(schedule);
		});
	}

	get(scheduleId: string): CronSchedule | undefined {
		if (!validId(scheduleId)) throw new CronScheduleError("invalid_schedule", "Cron Schedule ID is invalid");
		const schedule = this.storage.read().find((candidate) => candidate.scheduleId === scheduleId);
		return schedule ? clone(schedule) : undefined;
	}

	list(scope: { tenantId: string; workspaceId: string }): CronSchedule[] {
		if (![scope.tenantId, scope.workspaceId].every(validId)) {
			throw new CronScheduleError("invalid_schedule", "Cron Schedule scope is invalid");
		}
		return clone(this.storage.read()
			.filter((schedule) => schedule.tenantId === scope.tenantId && schedule.workspaceId === scope.workspaceId)
			.sort((left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt)));
	}

	due(now: string, limit = 10): CronSchedule[] {
		if (!validDate(now) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new CronScheduleError("invalid_schedule", "Cron due scan is invalid");
		}
		return clone(this.storage.read()
			.filter((schedule) => schedule.status === "active" && !schedule.pendingJobId && Date.parse(schedule.nextRunAt) <= Date.parse(now) && (!schedule.dispatchFailure || Date.parse(schedule.dispatchFailure.retryAt) <= Date.parse(now)))
			.sort((left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt))
			.slice(0, limit));
	}

	acknowledge(scheduleId: string, expectedRunAt: string, nextRunAt?: string, jobId?: string): CronSchedule {
		if (!validId(scheduleId) || !validDate(expectedRunAt) || nextRunAt !== undefined && !validDate(nextRunAt) || jobId !== undefined && !validId(jobId)) {
			throw new CronScheduleError("invalid_schedule", "Cron acknowledgement is invalid");
		}
		return this.storage.transaction((schedules) => {
			const schedule = schedules.find((candidate) => candidate.scheduleId === scheduleId);
			if (!schedule) throw new CronScheduleError("schedule_not_found", "Cron Schedule does not exist");
			if (jobId && schedule.lastRunAt === expectedRunAt && schedule.pendingJobId === jobId) return clone(schedule);
			if (schedule.status !== "active" || schedule.pendingJobId || schedule.runCount >= schedule.maxRuns || schedule.nextRunAt !== expectedRunAt) {
				throw new CronScheduleError("schedule_conflict", "Cron Schedule occurrence was already acknowledged");
			}
			const runCount = schedule.runCount + 1;
			const now = this.now().toISOString();
			const updated: CronSchedule = {
				...schedule,
				status: !jobId && (runCount >= schedule.maxRuns || !nextRunAt) ? "completed" : "active",
				...(jobId ? { pendingJobId: jobId } : {}),
				dispatchFailure: undefined,
				runCount,
				nextRunAt: nextRunAt ?? expectedRunAt,
				lastRunAt: expectedRunAt,
				updatedAt: now,
			};
			schedules[schedules.indexOf(schedule)] = updated;
			return clone(updated);
		});
	}

	pending(): CronSchedule[] { return clone(this.storage.read().filter(schedule => schedule.pendingJobId)); }

	settle(scheduleId: string, jobId: string, outcome: "completed" | "dead_letter" | "cancelled", code = "cron_job_failed"): void {
		if (![scheduleId, jobId, code].every(validId) || !["completed", "dead_letter", "cancelled"].includes(outcome)) throw new CronScheduleError("invalid_schedule", "Cron job outcome is invalid");
		this.storage.transaction(schedules => {
			const schedule = schedules.find(value => value.scheduleId === scheduleId && value.pendingJobId === jobId);
			if (!schedule || schedule.status === "failed" && outcome === "dead_letter") return;
			const now = this.now().toISOString();
			if (outcome === "dead_letter") { schedule.status = "failed"; schedule.failure = { code, jobId, at: now }; }
			else {
				delete schedule.pendingJobId; delete schedule.failure;
				schedule.status = schedule.runCount >= schedule.maxRuns ? "completed" : outcome === "cancelled" || schedule.status === "paused" ? "paused" : "active";
			}
			schedule.updatedAt = new Date(Math.max(Date.parse(now), Date.parse(schedule.updatedAt) + 1)).toISOString();
		});
	}

	defer(scheduleId: string, expectedRunAt: string, code: string): void {
		if (![scheduleId, code].every(validId) || !validDate(expectedRunAt)) throw new CronScheduleError("invalid_schedule", "Cron dispatch failure is invalid");
		this.storage.transaction(schedules => {
			const schedule = schedules.find(value => value.scheduleId === scheduleId);
			if (!schedule || schedule.status !== "active" || schedule.pendingJobId || schedule.nextRunAt !== expectedRunAt) return;
			const now = this.now(), count = (schedule.dispatchFailure?.count ?? 0) + 1;
			schedule.dispatchFailure = { count, code, at: now.toISOString(), retryAt: new Date(now.getTime() + Math.min(30_000, 250 * 2 ** Math.min(count, 10))).toISOString() };
			schedule.updatedAt = new Date(Math.max(now.getTime(), Date.parse(schedule.updatedAt) + 1)).toISOString();
			if (count >= 5) { schedule.status = "failed"; schedule.failure = { code, at: now.toISOString() }; }
		});
	}

	recover(scheduleId: string, request: OutboxRedriveRequest): CronSchedule {
		return this.storage.transaction(schedules => {
			const schedule = schedules.find(value => value.scheduleId === scheduleId && value.tenantId === request.tenantId && value.workspaceId === request.workspaceId);
			if (!schedule) throw new CronScheduleError("schedule_not_found", "Schedule unavailable in this scope");
			if (![request.actorId, request.requestId].every(validId) || typeof request.reason !== "string" || !request.reason.trim() || request.reason.length > 500 || !validDate(request.expectedUpdatedAt)) throw new CronScheduleError("invalid_schedule", "Recovery requires actor, reason, request ID and observed version");
			const prior = schedule.recoveries?.find(value => value.requestId === request.requestId);
			if (prior) {
				if (prior.actorId !== request.actorId || prior.reason !== request.reason || prior.expectedUpdatedAt !== request.expectedUpdatedAt) throw new CronScheduleError("schedule_conflict", "Recovery request changed");
				return clone(schedule);
			}
			if (schedule.status !== "failed" || schedule.pendingJobId || schedule.updatedAt !== request.expectedUpdatedAt || (schedule.recoveries?.length ?? 0) >= 64) throw new CronScheduleError("schedule_conflict", "Recover its dead-letter job first, or refresh the observed schedule");
			const at = this.now().toISOString();
			schedule.recoveries = [...(schedule.recoveries ?? []), { requestId: request.requestId, actorId: request.actorId, reason: request.reason, expectedUpdatedAt: request.expectedUpdatedAt, at }];
			schedule.status = "active"; schedule.updatedAt = new Date(Math.max(Date.parse(at), Date.parse(schedule.updatedAt) + 1)).toISOString(); delete schedule.dispatchFailure; delete schedule.failure;
			return clone(schedule);
		});
	}

	setStatus(
		scheduleId: string,
		scope: { tenantId: string; workspaceId: string },
		status: "active" | "paused",
		nextRunAt?: string,
		mutation?: RecordedMutation<CronSchedule>,
	): CronSchedule {
		if (!validId(scheduleId) || ![scope.tenantId, scope.workspaceId].every(validId) ||
			status === "active" && !validDate(nextRunAt)) {
			throw new CronScheduleError("invalid_schedule", "Cron Schedule status update is invalid");
		}
		return this.storage.transaction((schedules) => {
			const schedule = schedules.find((candidate) => candidate.scheduleId === scheduleId &&
				candidate.tenantId === scope.tenantId && candidate.workspaceId === scope.workspaceId);
			if (!schedule) throw new CronScheduleError("schedule_not_found", "Cron Schedule does not exist");
			if (mutation && findMutationReceipt(schedule.mutationReceipts, mutation.binding)) return clone(schedule);
			if (schedule.status === "completed" || schedule.status === "failed") {
				throw new CronScheduleError("schedule_conflict", "Completed Cron Schedule cannot be resumed");
			}
			const updated = {
				...schedule,
				status,
				...(nextRunAt ? { nextRunAt } : {}),
				updatedAt: this.now().toISOString(),
			};
			recordMutation(updated, mutation);
			schedules[schedules.indexOf(schedule)] = updated;
			return clone(updated);
		});
	}
}

class InMemoryCronScheduleStorage implements CronScheduleStorage {
	private schedules: CronSchedule[] = [];

	read(): CronSchedule[] {
		return clone(this.schedules);
	}

	transaction<Value>(operation: (schedules: CronSchedule[]) => Value): Value {
		const schedules = clone(this.schedules);
		const result = operation(schedules);
		this.schedules = schedules;
		return result;
	}
}

export class InMemoryCronScheduleStore extends DurableCronScheduleStore {
	constructor(now?: () => Date) {
		super(new InMemoryCronScheduleStorage(), now);
	}
}
