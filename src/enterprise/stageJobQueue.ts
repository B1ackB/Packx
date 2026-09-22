import type { AggregateScope, StageJobDispatch } from "./contracts";

export type EnqueueStageJob = StageJobDispatch;

export type StageJobStatus = "queued" | "leased" | "completed" | "dead_letter" | "cancelled";

export interface StageJobFailure {
	code: string;
	message: string;
	retryable: boolean;
	at: string;
}

export interface StageJob extends AggregateScope {
	schemaVersion: "stage-job.v1";
	jobId: string;
	stageId: string;
	commandId: string;
	correlationId: string;
	expectedVersion: number;
	sessionId: string;
	status: StageJobStatus;
	priority: number;
	deliveryCount: number;
	sliceCount: number;
	failureCount: number;
	totalFailureCount: number;
	recoveryCount: number;
	totalRecoveryDetectionDelayMs: number;
	maxFailures: number;
	maxSlices: number;
	availableAt: string;
	createdAt: string;
	updatedAt: string;
	leaseId?: string;
	leaseOwner?: string;
	leaseExpiresAt?: string;
	lastContextSnapshotId?: string;
	payload?: Record<string, unknown>;
	redriveCount: number;
	lastFailure?: StageJobFailure;
	lastRedrive?: {
		actorId: string;
		reason: string;
		at: string;
	};
	lastRecovery?: {
		previousLeaseOwner: string;
		expiredAt: string;
		recoveredAt: string;
		detectionDelayMs: number;
	};
}

export interface StageJobQueueMetrics {
	total: number;
	queued: number;
	ready: number;
	delayed: number;
	leased: number;
	completed: number;
	cancelled: number;
	deadLetter: number;
	deliveries: number;
	slices: number;
	failures: number;
	redrives: number;
	recoveries: number;
	recoveryDetectionDelayMs: number;
	oldestQueuedAgeMs: number;
}

export interface StageJobLease extends StageJob {
	status: "leased";
	leaseId: string;
	leaseOwner: string;
	leaseExpiresAt: string;
}

export interface StageJobLeaseKey {
	jobId: string;
	leaseId: string;
	leaseOwner: string;
}

export interface StageJobQueue {
	enqueue(input: EnqueueStageJob): StageJob;
	claim(workerId: string, leaseMs: number): StageJobLease | undefined;
	renew(lease: StageJobLeaseKey, leaseMs: number): StageJobLease;
	checkpoint(
		lease: StageJobLeaseKey,
		continuation: { sessionId: string; contextSnapshotId?: string; delayMs?: number },
	): StageJob;
	ack(lease: StageJobLeaseKey): StageJob;
	fail(
		lease: StageJobLeaseKey,
		failure: { code: string; message: string; retryable: boolean; delayMs?: number },
	): StageJob;
	redrive(
		jobId: string,
		request: {
			expectedUpdatedAt: string;
			actorId: string;
			reason: string;
			additionalSlices?: number;
		},
	): StageJob;
	cancel(jobId: string, scope: { tenantId: string; workspaceId: string; runId: string }): StageJob;
	get(jobId: string): StageJob | undefined;
	list(): StageJob[];
	listDeadLetters(scope?: { tenantId: string; workspaceId: string }): StageJob[];
	metrics(scope?: { tenantId: string; workspaceId: string }): StageJobQueueMetrics;
}

export interface StageJobQueueStorage {
	read(): StageJob[];
	transaction<Value>(operation: (jobs: StageJob[]) => Value): Value;
}

export interface StageJobQueueOptions {
	now?: () => Date;
	nextId?: () => string;
}

export class StageJobQueueError extends Error {
	constructor(
		readonly code: "invalid_job" | "job_conflict" | "lease_lost" | "queue_corrupt" | "queue_unavailable",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "StageJobQueueError";
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

function validFailure(value: unknown): value is StageJobFailure {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const failure = value as Partial<StageJobFailure>;
	return validId(failure.code) &&
		typeof failure.message === "string" &&
		failure.message.length > 0 &&
		typeof failure.retryable === "boolean" &&
		validDate(failure.at);
}

function validRecovery(value: unknown): value is NonNullable<StageJob["lastRecovery"]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const recovery = value as Partial<NonNullable<StageJob["lastRecovery"]>>;
	return validId(recovery.previousLeaseOwner) &&
		validDate(recovery.expiredAt) &&
		validDate(recovery.recoveredAt) &&
		Number.isInteger(recovery.detectionDelayMs) && Number(recovery.detectionDelayMs) >= 0;
}

function validJson(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	const valid = Array.isArray(value)
		? value.every((item) => validJson(item, seen))
		: Object.getPrototypeOf(value) === Object.prototype &&
			Object.values(value).every((item) => validJson(item, seen));
	seen.delete(value);
	return valid;
}

function validPayload(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || !validJson(value)) return false;
	try {
		return JSON.stringify(value).length <= 65_536;
	} catch {
		return false;
	}
}

export function isStageJob(value: unknown): value is StageJob {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const job = value as Partial<StageJob>;
	const leaseFieldsValid = job.status === "leased"
		? validId(job.leaseId) && validId(job.leaseOwner) && validDate(job.leaseExpiresAt)
		: job.leaseId === undefined && job.leaseOwner === undefined && job.leaseExpiresAt === undefined;
	return job.schemaVersion === "stage-job.v1" &&
		[
			job.jobId,
			job.tenantId,
			job.workspaceId,
			job.runId,
			job.stageId,
			job.commandId,
			job.correlationId,
			job.sessionId,
		].every(validId) &&
		Number.isInteger(job.expectedVersion) && Number(job.expectedVersion) >= 0 &&
		["queued", "leased", "completed", "dead_letter", "cancelled"].includes(String(job.status)) &&
		Number.isInteger(job.priority) &&
		Number.isInteger(job.deliveryCount) && Number(job.deliveryCount) >= 0 &&
		Number.isInteger(job.sliceCount) && Number(job.sliceCount) >= 0 &&
		Number.isInteger(job.failureCount) && Number(job.failureCount) >= 0 &&
		Number.isInteger(job.totalFailureCount) && Number(job.totalFailureCount) >= 0 &&
		Number.isInteger(job.recoveryCount) && Number(job.recoveryCount) >= 0 &&
		Number.isInteger(job.totalRecoveryDetectionDelayMs) && Number(job.totalRecoveryDetectionDelayMs) >= 0 &&
		Number.isInteger(job.maxFailures) && Number(job.maxFailures) > 0 &&
		Number.isInteger(job.maxSlices) && Number(job.maxSlices) > 0 &&
		validDate(job.availableAt) && validDate(job.createdAt) && validDate(job.updatedAt) &&
		leaseFieldsValid &&
		(job.lastContextSnapshotId === undefined || validId(job.lastContextSnapshotId)) &&
		(job.payload === undefined || validPayload(job.payload)) &&
		Number.isInteger(job.redriveCount) && Number(job.redriveCount) >= 0 &&
		(job.lastFailure === undefined || validFailure(job.lastFailure)) &&
		(job.lastRecovery === undefined || validRecovery(job.lastRecovery)) &&
		(job.lastRedrive === undefined || Boolean(job.lastRedrive) &&
			validId(job.lastRedrive.actorId) &&
			typeof job.lastRedrive.reason === "string" && job.lastRedrive.reason.length > 0 &&
			validDate(job.lastRedrive.at));
}

function assertInput(input: EnqueueStageJob): void {
	if (![
		input.jobId,
		input.tenantId,
		input.workspaceId,
		input.runId,
		input.stageId,
		input.commandId,
		input.correlationId,
		input.sessionId,
	].every(validId)) {
		throw new StageJobQueueError("invalid_job", "Stage Job identity is invalid");
	}
	if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
		throw new StageJobQueueError("invalid_job", "Stage Job expectedVersion is invalid");
	}
	if (input.priority !== undefined && !Number.isInteger(input.priority)) {
		throw new StageJobQueueError("invalid_job", "Stage Job priority is invalid");
	}
	if (input.maxFailures !== undefined && (!Number.isInteger(input.maxFailures) || input.maxFailures < 1)) {
		throw new StageJobQueueError("invalid_job", "Stage Job maxFailures is invalid");
	}
	if (input.maxSlices !== undefined && (!Number.isInteger(input.maxSlices) || input.maxSlices < 1)) {
		throw new StageJobQueueError("invalid_job", "Stage Job maxSlices is invalid");
	}
	if (input.availableAt !== undefined && !validDate(input.availableAt)) {
		throw new StageJobQueueError("invalid_job", "Stage Job availableAt is invalid");
	}
	if (input.payload !== undefined && !validPayload(input.payload)) {
		throw new StageJobQueueError("invalid_job", "Stage Job payload must be JSON and no larger than 64 KiB");
	}
}

function sameIdentity(job: StageJob, input: EnqueueStageJob): boolean {
	return job.tenantId === input.tenantId &&
		job.workspaceId === input.workspaceId &&
		job.runId === input.runId &&
		job.stageId === input.stageId &&
		job.commandId === input.commandId &&
		job.correlationId === input.correlationId &&
		job.expectedVersion === input.expectedVersion &&
		job.sessionId === input.sessionId &&
		JSON.stringify(job.payload) === JSON.stringify(input.payload);
}

function assertDelay(delayMs: number | undefined): number {
	if (delayMs === undefined) return 0;
	if (!Number.isInteger(delayMs) || delayMs < 0) {
		throw new StageJobQueueError("invalid_job", "Stage Job delay is invalid");
	}
	return delayMs;
}

function withoutLease(job: StageJob): StageJob {
	const { leaseId: _leaseId, leaseOwner: _leaseOwner, leaseExpiresAt: _leaseExpiresAt, ...rest } = job;
	return rest;
}

export class DurableStageJobQueue implements StageJobQueue {
	private readonly now: () => Date;
	private readonly nextId: () => string;

	constructor(
		private readonly storage: StageJobQueueStorage,
		options: StageJobQueueOptions = {},
	) {
		this.now = options.now ?? (() => new Date());
		this.nextId = options.nextId ?? (() => crypto.randomUUID());
	}

	enqueue(input: EnqueueStageJob): StageJob {
		assertInput(input);
		return this.storage.transaction((jobs) => {
			const existing = jobs.find((job) => job.jobId === input.jobId);
			if (existing) {
				if (!sameIdentity(existing, input)) {
					throw new StageJobQueueError("job_conflict", "Stage Job ID is already bound to another command");
				}
				return clone(existing);
			}
			const now = this.now().toISOString();
			const job: StageJob = {
				schemaVersion: "stage-job.v1",
				...input,
				status: "queued",
				priority: input.priority ?? 0,
				deliveryCount: 0,
				sliceCount: 0,
				failureCount: 0,
				totalFailureCount: 0,
				recoveryCount: 0,
				totalRecoveryDetectionDelayMs: 0,
				maxFailures: input.maxFailures ?? 5,
				maxSlices: input.maxSlices ?? 32,
				redriveCount: 0,
				availableAt: input.availableAt ?? now,
				createdAt: now,
				updatedAt: now,
			};
			jobs.push(job);
			return clone(job);
		});
	}

	renew(lease: StageJobLeaseKey, leaseMs: number): StageJobLease {
		if (!Number.isInteger(leaseMs) || leaseMs < 1) {
			throw new StageJobQueueError("invalid_job", "Stage Job lease duration is invalid");
		}
		return this.updateLease(lease, (job, now) => ({
			...job,
			leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
			updatedAt: now.toISOString(),
		})) as StageJobLease;
	}

	claim(workerId: string, leaseMs: number): StageJobLease | undefined {
		if (!validId(workerId) || !Number.isInteger(leaseMs) || leaseMs < 1) {
			throw new StageJobQueueError("invalid_job", "Worker lease request is invalid");
		}
		const observedAt = this.now();
		if (!this.storage.read().some((job) =>
			job.status === "queued" && Date.parse(job.availableAt) <= observedAt.getTime() ||
			job.status === "leased" && Date.parse(job.leaseExpiresAt ?? "") <= observedAt.getTime(),
		)) return undefined;
		return this.storage.transaction((jobs) => {
			const now = this.now();
			this.recoverExpiredLeases(jobs, now);
			const queued = jobs
				.filter((job) => job.status === "queued" && Date.parse(job.availableAt) <= now.getTime())
				.sort((left, right) =>
					right.priority - left.priority ||
					Date.parse(left.availableAt) - Date.parse(right.availableAt) ||
					Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
					left.jobId.localeCompare(right.jobId),
				)[0];
			if (!queued) return undefined;
			const claimed: StageJobLease = {
				...queued,
				status: "leased",
				deliveryCount: queued.deliveryCount + 1,
				leaseId: this.nextId(),
				leaseOwner: workerId,
				leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
				updatedAt: now.toISOString(),
			};
			jobs[jobs.indexOf(queued)] = claimed;
			return clone(claimed);
		});
	}

	checkpoint(
		lease: StageJobLeaseKey,
		continuation: { sessionId: string; contextSnapshotId?: string; delayMs?: number },
	): StageJob {
		if (!validId(continuation.sessionId) ||
			(continuation.contextSnapshotId !== undefined && !validId(continuation.contextSnapshotId))) {
			throw new StageJobQueueError("invalid_job", "Stage Job continuation is invalid");
		}
		const delayMs = assertDelay(continuation.delayMs);
		return this.updateLease(lease, (job, now) => {
			const sliceCount = job.sliceCount + 1;
			const exhausted = sliceCount >= job.maxSlices;
			return {
				...withoutLease(job),
				status: exhausted ? "dead_letter" : "queued",
				sessionId: continuation.sessionId,
				lastContextSnapshotId: continuation.contextSnapshotId ?? job.lastContextSnapshotId,
				sliceCount,
				failureCount: 0,
				availableAt: new Date(now.getTime() + delayMs).toISOString(),
				updatedAt: now.toISOString(),
				lastFailure: exhausted
					? {
						code: "slice_budget_exceeded",
						message: "Stage Job exhausted its execution-slice budget",
						retryable: false,
						at: now.toISOString(),
					}
					: job.lastFailure,
			};
		});
	}

	ack(lease: StageJobLeaseKey): StageJob {
		return this.updateLease(lease, (job, now) => ({
			...withoutLease(job),
			status: "completed",
			sliceCount: job.sliceCount + 1,
			failureCount: 0,
			updatedAt: now.toISOString(),
		}));
	}

	fail(
		lease: StageJobLeaseKey,
		failure: { code: string; message: string; retryable: boolean; delayMs?: number },
	): StageJob {
		if (!validId(failure.code) || typeof failure.message !== "string" || failure.message.length === 0) {
			throw new StageJobQueueError("invalid_job", "Stage Job failure is invalid");
		}
		const delayMs = assertDelay(failure.delayMs);
		return this.updateLease(lease, (job, now) => {
			const failureCount = job.failureCount + 1;
			const retryable = failure.retryable && failureCount < job.maxFailures;
			return {
				...withoutLease(job),
				status: retryable ? "queued" : "dead_letter",
				failureCount,
				totalFailureCount: job.totalFailureCount + 1,
				availableAt: new Date(now.getTime() + (retryable ? delayMs : 0)).toISOString(),
				updatedAt: now.toISOString(),
				lastFailure: {
					code: failure.code,
					message: failure.message,
					retryable: failure.retryable,
					at: now.toISOString(),
				},
			};
		});
	}

	redrive(
		jobId: string,
		request: {
			expectedUpdatedAt: string;
			actorId: string;
			reason: string;
			additionalSlices?: number;
		},
	): StageJob {
		if (!validId(jobId) || !validId(request.actorId) || !validDate(request.expectedUpdatedAt) ||
			typeof request.reason !== "string" || request.reason.length < 1 || request.reason.length > 500 ||
			(request.additionalSlices !== undefined &&
				(!Number.isInteger(request.additionalSlices) || request.additionalSlices < 1 || request.additionalSlices > 32))) {
			throw new StageJobQueueError("invalid_job", "Stage Job redrive request is invalid");
		}
		return this.storage.transaction((jobs) => {
			const job = jobs.find((candidate) => candidate.jobId === jobId);
			if (!job || job.status !== "dead_letter") {
				throw new StageJobQueueError("job_conflict", "Only a dead-letter Stage Job can be redriven");
			}
			if (job.updatedAt !== request.expectedUpdatedAt) {
				throw new StageJobQueueError("job_conflict", "Stage Job changed before redrive");
			}
			if (job.sliceCount >= job.maxSlices + (request.additionalSlices ?? 0)) {
				throw new StageJobQueueError("job_conflict", "Stage Job redrive requires additional execution slices");
			}
			const now = this.now().toISOString();
			const updated: StageJob = {
				...job,
				status: "queued",
				failureCount: 0,
				maxSlices: job.maxSlices + (request.additionalSlices ?? 0),
				redriveCount: job.redriveCount + 1,
				availableAt: now,
				updatedAt: now,
				lastRedrive: { actorId: request.actorId, reason: request.reason, at: now },
			};
			jobs[jobs.indexOf(job)] = updated;
			return clone(updated);
		});
	}

	cancel(jobId: string, scope: { tenantId: string; workspaceId: string; runId: string }): StageJob {
		if (![jobId, scope.tenantId, scope.workspaceId, scope.runId].every(validId)) {
			throw new StageJobQueueError("invalid_job", "Stage Job cancellation is invalid");
		}
		return this.storage.transaction((jobs) => {
			const job = jobs.find((candidate) => candidate.jobId === jobId &&
				candidate.tenantId === scope.tenantId &&
				candidate.workspaceId === scope.workspaceId &&
				candidate.runId === scope.runId);
			if (!job) throw new StageJobQueueError("job_conflict", "Stage Job does not exist in this scope");
			if (job.status === "cancelled" || job.status === "completed") return clone(job);
			if (job.status !== "queued" && job.status !== "leased") {
				throw new StageJobQueueError("job_conflict", "Only a queued or leased Stage Job can be cancelled");
			}
			const updated: StageJob = { ...job, status: "cancelled", updatedAt: this.now().toISOString() };
			delete updated.leaseId;
			delete updated.leaseOwner;
			delete updated.leaseExpiresAt;
			jobs[jobs.indexOf(job)] = updated;
			return clone(updated);
		});
	}

	get(jobId: string): StageJob | undefined {
		if (!validId(jobId)) throw new StageJobQueueError("invalid_job", "Stage Job ID is invalid");
		const job = this.storage.read().find((candidate) => candidate.jobId === jobId);
		return job ? clone(job) : undefined;
	}

	list(): StageJob[] {
		return clone(this.storage.read());
	}

	listDeadLetters(scope?: { tenantId: string; workspaceId: string }): StageJob[] {
		return this.list().filter((job) => job.status === "dead_letter" &&
			(!scope || job.tenantId === scope.tenantId && job.workspaceId === scope.workspaceId));
	}

	metrics(scope?: { tenantId: string; workspaceId: string }): StageJobQueueMetrics {
		const now = this.now().getTime();
		const jobs = this.list().filter((job) =>
			!scope || job.tenantId === scope.tenantId && job.workspaceId === scope.workspaceId,
		);
		const queued = jobs.filter((job) => job.status === "queued");
		return {
			total: jobs.length,
			queued: queued.length,
			ready: queued.filter((job) => Date.parse(job.availableAt) <= now).length,
			delayed: queued.filter((job) => Date.parse(job.availableAt) > now).length,
			leased: jobs.filter((job) => job.status === "leased").length,
			completed: jobs.filter((job) => job.status === "completed").length,
			cancelled: jobs.filter((job) => job.status === "cancelled").length,
			deadLetter: jobs.filter((job) => job.status === "dead_letter").length,
			deliveries: jobs.reduce((sum, job) => sum + job.deliveryCount, 0),
			slices: jobs.reduce((sum, job) => sum + job.sliceCount, 0),
			failures: jobs.reduce((sum, job) => sum + job.totalFailureCount, 0),
			redrives: jobs.reduce((sum, job) => sum + job.redriveCount, 0),
			recoveries: jobs.reduce((sum, job) => sum + job.recoveryCount, 0),
			recoveryDetectionDelayMs: jobs.reduce(
				(sum, job) => sum + job.totalRecoveryDetectionDelayMs,
				0,
			),
			oldestQueuedAgeMs: queued.length === 0
				? 0
				: Math.max(0, now - Math.min(...queued.map((job) => Date.parse(job.createdAt)))),
		};
	}

	private updateLease(
		lease: StageJobLeaseKey,
		transition: (job: StageJobLease, now: Date) => StageJob,
	): StageJob {
		if (![lease.jobId, lease.leaseId, lease.leaseOwner].every(validId)) {
			throw new StageJobQueueError("invalid_job", "Stage Job lease identity is invalid");
		}
		return this.storage.transaction((jobs) => {
			const job = jobs.find((candidate) => candidate.jobId === lease.jobId);
			const now = this.now();
			if (job?.status !== "leased" || job.leaseId !== lease.leaseId ||
				job.leaseOwner !== lease.leaseOwner || Date.parse(job.leaseExpiresAt ?? "") <= now.getTime()) {
				throw new StageJobQueueError("lease_lost", "Stage Job lease is no longer owned by this worker");
			}
			const updated = transition(job as StageJobLease, now);
			jobs[jobs.indexOf(job)] = updated;
			return clone(updated);
		});
	}

	private recoverExpiredLeases(jobs: StageJob[], now: Date): void {
		for (const job of jobs) {
			if (job.status !== "leased" || Date.parse(job.leaseExpiresAt ?? "") > now.getTime()) continue;
			if (!job.leaseOwner || !job.leaseExpiresAt) {
				throw new StageJobQueueError("queue_corrupt", "Leased Stage Job is missing lease identity");
			}
			const failureCount = job.failureCount + 1;
			const expiredAt = job.leaseExpiresAt;
			const detectionDelayMs = Math.max(0, now.getTime() - Date.parse(expiredAt));
			const recovered: StageJob = {
				...withoutLease(job),
				status: failureCount < job.maxFailures ? "queued" : "dead_letter",
				failureCount,
				totalFailureCount: job.totalFailureCount + 1,
				recoveryCount: job.recoveryCount + 1,
				totalRecoveryDetectionDelayMs: job.totalRecoveryDetectionDelayMs + detectionDelayMs,
				availableAt: now.toISOString(),
				updatedAt: now.toISOString(),
				lastFailure: {
					code: "worker_lease_expired",
					message: "Worker lease expired before acknowledgement",
					retryable: true,
					at: now.toISOString(),
				},
				lastRecovery: {
					previousLeaseOwner: job.leaseOwner,
					expiredAt,
					recoveredAt: now.toISOString(),
					detectionDelayMs,
				},
			};
			jobs[jobs.indexOf(job)] = recovered;
		}
	}
}

export class InMemoryStageJobQueueStorage implements StageJobQueueStorage {
	private jobs: StageJob[] = [];

	read(): StageJob[] {
		return clone(this.jobs);
	}

	transaction<Value>(operation: (jobs: StageJob[]) => Value): Value {
		const jobs = clone(this.jobs);
		const result = operation(jobs);
		this.jobs = jobs;
		return result;
	}
}

export class InMemoryStageJobQueue extends DurableStageJobQueue {
	constructor(options: StageJobQueueOptions = {}) {
		super(new InMemoryStageJobQueueStorage(), options);
	}
}
