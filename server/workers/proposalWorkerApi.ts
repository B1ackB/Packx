import { CronScheduleError, type CronScheduleStore } from "../../src/enterprise/cronSchedule";
import { automationScheduleView } from "../runtime/automationTools";
import { timingSafeEqual } from "node:crypto";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import { StageJobQueueError } from "../../src/enterprise/stageJobQueue";
import type { ProposalApiContext, ProposalApiResponse } from "../enterprise/proposalApi";
import { StageJobOutbox } from "./stageJobOutbox";
import { StageJobScheduler } from "./stageJobScheduler";

class ProposalWorkerApiValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredId(value: unknown, name: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 128 ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
	) {
		throw new ProposalWorkerApiValidationError(`${name} is invalid`);
	}
	return value;
}

function requiredVersion(value: unknown): number {
	if (!Number.isInteger(value) || Number(value) < 0) {
		throw new ProposalWorkerApiValidationError("expectedVersion is invalid");
	}
	return Number(value);
}

function requiredTimestamp(value: unknown, name: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new ProposalWorkerApiValidationError(`${name} is invalid`);
	}
	return value;
}

function requiredReason(value: unknown): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 500) {
		throw new ProposalWorkerApiValidationError("reason is invalid");
	}
	return value;
}

function optionalAdditionalSlices(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 32) {
		throw new ProposalWorkerApiValidationError("additionalSlices is invalid");
	}
	return Number(value);
}

function tokenMatches(authorization: string | undefined, expected: string): boolean {
	const match = authorization?.match(/^Bearer ([^\s]+)$/);
	if (!match) return false;
	const supplied = Buffer.from(match[1]);
	const configured = Buffer.from(expected);
	return supplied.byteLength === configured.byteLength && timingSafeEqual(supplied, configured);
}

export class ProposalWorkerApiController {
	constructor(
		private readonly scheduler: StageJobScheduler,
		private readonly outbox: StageJobOutbox,
		private readonly workerToken?: string,
		private readonly operatorToken?: string,
		private readonly schedules?: CronScheduleStore,
	) {
		if (workerToken && Buffer.byteLength(workerToken) < 32) {
			throw new Error("Proposal Worker API token must contain at least 32 bytes");
		}
		if (operatorToken && Buffer.byteLength(operatorToken) < 32) {
			throw new Error("Stage Job Operator API token must contain at least 32 bytes");
		}
		if (workerToken && operatorToken && tokenMatches(`Bearer ${workerToken}`, operatorToken)) {
			throw new Error("Worker and Operator API tokens must be different");
		}
	}

	async execute(
		context: ProposalApiContext,
		runId: unknown,
		payload: unknown,
	): Promise<ProposalApiResponse> {
		if (!this.workerToken) {
			return { status: 503, body: { code: "worker_api_disabled" } };
		}
		if (!tokenMatches(context.authorization, this.workerToken)) {
			return { status: 401, body: { code: "unauthorized" } };
		}
		try {
			if (!isRecord(payload)) {
				throw new ProposalWorkerApiValidationError("Worker command must be an object");
			}
			const command = {
				tenantId: requiredId(context.tenantId, "tenantId"),
				workspaceId: requiredId(context.workspaceId, "workspaceId"),
				runId: requiredId(runId, "runId"),
				commandId: requiredId(payload.commandId, "commandId"),
				correlationId: requiredId(payload.correlationId, "correlationId"),
				expectedVersion: requiredVersion(payload.expectedVersion),
			};
			const message = this.outbox.requestProposal(command);
			this.outbox.dispatchOne();
			const job = this.scheduler.getJob(message.payload.jobId, command);
			return {
				status: 202,
				body: {
					dispatch: job ? "queued" : "outbox_pending",
					messageId: message.messageId,
					job,
				},
			};
		} catch (error) {
			if (error instanceof ProposalWorkerApiValidationError) {
				return { status: 400, body: { code: "invalid_command", message: error.message } };
			}
			if (error instanceof StageJobQueueError) {
				return {
					status: error.code === "job_conflict" ? 409 : error.code === "invalid_job" ? 400 : 503,
					body: { code: error.code, message: error.message },
				};
			}
			if (error instanceof EnterpriseKernelError) {
				return {
					status: error.code === "concurrency_conflict" ? 409 : 503,
					body: { code: error.code, message: error.message },
				};
			}
			return { status: 500, body: { code: "worker_execution_failed" } };
		}
	}

	status(
		context: ProposalApiContext,
		jobId: unknown,
	): ProposalApiResponse {
		if (!this.workerToken) {
			return { status: 503, body: { code: "worker_api_disabled" } };
		}
		if (!tokenMatches(context.authorization, this.workerToken)) {
			return { status: 401, body: { code: "unauthorized" } };
		}
		try {
			const job = this.scheduler.getJob(requiredId(jobId, "jobId"), {
				tenantId: requiredId(context.tenantId, "tenantId"),
				workspaceId: requiredId(context.workspaceId, "workspaceId"),
			});
			return job
				? { status: 200, body: { job } }
				: { status: 404, body: { code: "job_not_found" } };
		} catch (error) {
			if (error instanceof ProposalWorkerApiValidationError) {
				return { status: 400, body: { code: "invalid_command", message: error.message } };
			}
			if (error instanceof StageJobQueueError) {
				return { status: 503, body: { code: error.code, message: error.message } };
			}
			return { status: 500, body: { code: "worker_status_failed" } };
		}
	}

	metrics(context: ProposalApiContext): ProposalApiResponse {
		return this.operatorResponse(context, () => ({
			status: 200,
			body: {
				metrics: this.scheduler.metrics({
					tenantId: requiredId(context.tenantId, "tenantId"),
					workspaceId: requiredId(context.workspaceId, "workspaceId"),
				}),
			},
		}));
	}

	deadLetters(context: ProposalApiContext): ProposalApiResponse {
		return this.operatorResponse(context, () => ({
			status: 200,
			body: {
				jobs: this.scheduler.deadLetters({
					tenantId: requiredId(context.tenantId, "tenantId"),
					workspaceId: requiredId(context.workspaceId, "workspaceId"),
				}),
			},
		}));
	}

	redrive(
		context: ProposalApiContext,
		jobId: unknown,
		payload: unknown,
	): ProposalApiResponse {
		return this.operatorResponse(context, () => {
			if (!isRecord(payload)) {
				throw new ProposalWorkerApiValidationError("Redrive payload must be an object");
			}
			const job = this.scheduler.redrive(
				requiredId(jobId, "jobId"),
				{
					tenantId: requiredId(context.tenantId, "tenantId"),
					workspaceId: requiredId(context.workspaceId, "workspaceId"),
				},
				{
					expectedUpdatedAt: requiredTimestamp(payload.expectedUpdatedAt, "expectedUpdatedAt"),
					actorId: requiredId(context.actorId, "actorId"),
					reason: requiredReason(payload.reason),
					additionalSlices: optionalAdditionalSlices(payload.additionalSlices),
				},
			);
			return job
				? { status: 200, body: { job } }
				: { status: 404, body: { code: "job_not_found" } };
		});
	}

	outboxStatus(context: ProposalApiContext): ProposalApiResponse {
		return this.operatorResponse(context, () => ({ status: 200, body: { messages: this.outbox.list({ tenantId: requiredId(context.tenantId, "tenantId"), workspaceId: requiredId(context.workspaceId, "workspaceId") }) } }));
	}
	outboxRedrive(context: ProposalApiContext, messageId: unknown, payload: unknown): ProposalApiResponse {
		return this.operatorResponse(context, () => ({ status: 200, body: { message: this.outbox.redrive(requiredId(messageId, "messageId"), this.recoveryRequest(context, payload)) } }));
	}
	cronStatus(context: ProposalApiContext): ProposalApiResponse {
		return this.operatorResponse(context, () => {
			if (!this.schedules) return { status: 503, body: { code: "cron_operator_unavailable" } };
			return { status: 200, body: { schedules: this.schedules.list({ tenantId: requiredId(context.tenantId, "tenantId"), workspaceId: requiredId(context.workspaceId, "workspaceId") }).map(automationScheduleView) } };
		});
	}
	cronRecover(context: ProposalApiContext, scheduleId: unknown, payload: unknown): ProposalApiResponse {
		return this.operatorResponse(context, () => {
			if (!this.schedules) return { status: 503, body: { code: "cron_operator_unavailable" } };
			return { status: 200, body: { schedule: automationScheduleView(this.schedules.recover(requiredId(scheduleId, "scheduleId"), this.recoveryRequest(context, payload))) } };
		});
	}
	private recoveryRequest(context: ProposalApiContext, payload: unknown) {
		if (!isRecord(payload)) throw new ProposalWorkerApiValidationError("Recovery request must be an object");
		return { tenantId: requiredId(context.tenantId, "tenantId"), workspaceId: requiredId(context.workspaceId, "workspaceId"), actorId: requiredId(context.actorId, "actorId"),
			requestId: requiredId(payload.requestId, "requestId"), expectedUpdatedAt: requiredTimestamp(payload.expectedUpdatedAt, "expectedUpdatedAt"), reason: requiredReason(payload.reason) };
	}

	private operatorResponse(
		context: ProposalApiContext,
		operation: () => ProposalApiResponse,
	): ProposalApiResponse {
		if (!this.operatorToken) {
			return { status: 503, body: { code: "operator_api_disabled" } };
		}
		if (!tokenMatches(context.authorization, this.operatorToken)) {
			return { status: 401, body: { code: "unauthorized" } };
		}
		try {
			return operation();
		} catch (error) {
			if (error instanceof ProposalWorkerApiValidationError) {
				return { status: 400, body: { code: "invalid_command", message: error.message } };
			}
			if (error instanceof StageJobQueueError) {
				return {
					status: error.code === "job_conflict" ? 409 : error.code === "invalid_job" ? 400 : 503,
					body: { code: error.code, message: error.message },
				};
			}
			if (error instanceof EnterpriseKernelError) return { status: error.code === "concurrency_conflict" ? 409 : error.code === "aggregate_access_denied" ? 404 : 503, body: { code: error.code, message: error.message } };
			if (error instanceof CronScheduleError) return { status: error.code === "schedule_conflict" ? 409 : error.code === "schedule_not_found" ? 404 : error.code === "invalid_schedule" ? 400 : 503, body: { code: error.code, message: error.message } };
			return { status: 500, body: { code: "operator_execution_failed" } };
		}
	}
}
