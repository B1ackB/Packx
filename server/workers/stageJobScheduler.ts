import { ArtifactStoreError } from "../../src/enterprise/artifactStore";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import {
	StageJobQueueError,
	type StageJob,
	type StageJobLease,
	type StageJobQueue,
	type StageJobQueueMetrics,
} from "../../src/enterprise/stageJobQueue";
import { RuntimeFailure } from "../../src/runtime/contracts";

export type StageJobRunResult =
	| { status: "idle" | "busy" }
	| { status: "completed" | "paused" | "retry_scheduled" | "dead_letter" | "cancelled"; job: StageJob };

export interface StageJobHandlerResult {
	status: "completed" | "paused";
	sessionId?: string;
	contextSnapshotId?: string;
}

export type StageJobHandler = (lease: StageJobLease, signal: AbortSignal, assertActive: () => void) => Promise<StageJobHandlerResult>;

export interface StageJobSchedulerOptions {
	workerId: string;
	leaseMs?: number;
	pollIntervalMs?: number;
	heartbeatMs?: number;
	handlers?: Readonly<Record<string, StageJobHandler>>;
	dispatchOutbox?: () => unknown;
	assertRunnable?: (lease: StageJobLease) => void;
	onError?: (error: unknown) => void;
}

/** Attempt each independent scope, then report every failure without discarding its cause. */
export function reconcileIndependently(tasks: Readonly<Record<string, () => unknown>>): void {
	const failures: unknown[] = [], names: string[] = [];
	for (const [name, task] of Object.entries(tasks)) {
		try { task(); } catch (error) { failures.push(error); names.push(name); }
	}
	if (failures.length) throw new AggregateError(failures, `Reconciliation failed: ${names.join(", ")}`);
}

function safeFailure(error: unknown): { code: string; message: string; retryable: boolean } {
	if (error instanceof RuntimeFailure) {
		return { code: error.code, message: error.message, retryable: error.retryable };
	}
	if (error instanceof ArtifactStoreError) {
		return {
			code: error.code,
			message: error.message,
			retryable: error.code === "artifact_store_unavailable",
		};
	}
	if (error instanceof EnterpriseKernelError) {
		return {
			code: error.code,
			message: error.message,
			retryable: error.code === "event_store_unavailable",
		};
	}
	return {
		code: "worker_execution_failed",
		message: "Stage Job Worker execution failed",
		retryable: true,
	};
}

export class StageJobScheduler {
	private readonly leaseMs: number;
	private readonly pollIntervalMs: number;
	private readonly heartbeatMs: number;
	private running = false;
	private stopRequested = false;
	private timer?: NodeJS.Timeout;
	private readonly activeJobs = new Map<string, AbortController>();

	constructor(
		private readonly queue: StageJobQueue,
		private readonly options: StageJobSchedulerOptions,
	) {
		this.leaseMs = options.leaseMs ?? 135_000;
		this.pollIntervalMs = options.pollIntervalMs ?? 250;
		this.heartbeatMs = options.heartbeatMs ?? Math.max(250, Math.floor(this.leaseMs / 3));
		if (![this.leaseMs, this.pollIntervalMs, this.heartbeatMs].every(
			(value) => Number.isInteger(value) && value > 0,
		) || this.heartbeatMs >= this.leaseMs || options.workerId.length === 0) {
			throw new Error("Stage Job Scheduler configuration is invalid");
		}
	}

	getJob(
		jobId: string,
		scope: { tenantId: string; workspaceId: string },
	): StageJob | undefined {
		const job = this.queue.get(jobId);
		return job?.tenantId === scope.tenantId && job.workspaceId === scope.workspaceId
			? job
			: undefined;
	}

	jobsForRun(scope: { tenantId: string; workspaceId: string; runId: string }): StageJob[] {
		return this.queue.list().filter((job) =>
			job.tenantId === scope.tenantId &&
			job.workspaceId === scope.workspaceId &&
			job.runId === scope.runId,
		);
	}

	metrics(scope: { tenantId: string; workspaceId: string }): StageJobQueueMetrics {
		return this.queue.metrics(scope);
	}

	deadLetters(scope: { tenantId: string; workspaceId: string }): StageJob[] {
		return this.queue.listDeadLetters(scope);
	}

	redrive(
		jobId: string,
		scope: { tenantId: string; workspaceId: string },
		request: {
			expectedUpdatedAt: string;
			actorId: string;
			reason: string;
			additionalSlices?: number;
		},
	): StageJob | undefined {
		if (!this.getJob(jobId, scope)) return undefined;
		return this.queue.redrive(jobId, request);
	}

	cancel(
		jobId: string,
		scope: { tenantId: string; workspaceId: string; runId: string },
	): StageJob | undefined {
		const job = this.getJob(jobId, scope);
		if (!job || job.runId !== scope.runId) return undefined;
		const cancelled = this.queue.cancel(jobId, scope);
		this.activeJobs.get(jobId)?.abort("stage_job_cancelled");
		return cancelled;
	}

	async runNext(): Promise<StageJobRunResult> {
		if (this.running) return { status: "busy" };
		this.running = true;
		let lease = undefined as ReturnType<StageJobQueue["claim"]>;
		try {
			try { this.options.dispatchOutbox?.(); }
			catch (error) {
				// Direct callers without an error sink still receive the failure.
				if (!this.options.onError) throw error;
				this.options.onError(error);
			}
			lease = this.queue.claim(this.options.workerId, this.leaseMs);
			if (!lease) return { status: "idle" };
			const handler = this.handlerFor(lease);
			if (!handler) {
				const job = this.queue.fail(lease, {
					code: "unsupported_stage",
					message: `No Worker is registered for stage ${lease.stageId}`,
					retryable: false,
				});
				return { status: "dead_letter", job };
			}

			let activeLease = lease;
			const controller = new AbortController();
			this.activeJobs.set(lease.jobId, controller);
			let heartbeatError: unknown;
			const assertActive = () => {
				controller.signal.throwIfAborted();
				try {
					this.options.assertRunnable?.(activeLease);
					// Renew at the commit boundary too: timers may be delayed by synchronous work.
					activeLease = this.queue.renew(activeLease, this.leaseMs);
				} catch (error) {
					heartbeatError = error;
					controller.abort(error);
					throw error;
				}
			};
			const heartbeat = setInterval(() => {
				try {
					assertActive();
				} catch (error) {
					heartbeatError = error;
				}
			}, this.heartbeatMs);
			let result: StageJobHandlerResult;
			try {
				assertActive();
				result = await handler(activeLease, controller.signal, assertActive);
				assertActive();
			} finally {
				clearInterval(heartbeat);
			}
			if (heartbeatError) throw heartbeatError;
			const current = this.queue.get(activeLease.jobId);
			if (current?.status === "cancelled") return { status: "cancelled", job: current };
			if (result.status === "paused") {
				if (!result.sessionId) {
					throw new RuntimeFailure("invalid_output", "Paused Stage Job omitted sessionId", false);
				}
				const job = this.queue.checkpoint(activeLease, {
					sessionId: result.sessionId,
					contextSnapshotId: result.contextSnapshotId,
				});
				return { status: job.status === "dead_letter" ? "dead_letter" : "paused", job };
			}
			return { status: "completed", job: this.queue.ack(activeLease) };
		} catch (error) {
			if (!lease || error instanceof StageJobQueueError && error.code === "lease_lost") throw error;
			const current = this.queue.get(lease.jobId);
			if (current?.status === "cancelled") return { status: "cancelled", job: current };
			const failure = safeFailure(error);
			const delayMs = failure.retryable
				? Math.min(30_000, 250 * 2 ** lease.failureCount)
				: 0;
			const job = this.queue.fail(lease, { ...failure, delayMs });
			return {
				status: job.status === "dead_letter" ? "dead_letter" : "retry_scheduled",
				job,
			};
		} finally {
			if (lease) this.activeJobs.delete(lease.jobId);
			this.running = false;
		}
	}

	private handlerFor(lease: StageJobLease): StageJobHandler | undefined {
		return this.options.handlers?.[lease.stageId];
	}

	start(): () => void {
		if (this.timer) return () => this.stop();
		this.stopRequested = false;
		const tick = async () => {
			if (this.stopRequested) return;
			let delay = this.pollIntervalMs;
			try {
				const result = await this.runNext();
				if (result.status !== "idle" && result.status !== "busy") delay = 0;
			} catch (error) {
				this.options.onError?.(error);
			} finally {
				if (!this.stopRequested) this.timer = setTimeout(tick, delay);
			}
		};
		this.timer = setTimeout(tick, 0);
		return () => this.stop();
	}

	stop(): void {
		this.stopRequested = true;
		for (const controller of this.activeJobs.values()) controller.abort(new RuntimeFailure("cancelled", "Worker stopped", false));
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
