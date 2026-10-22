import { createHash } from "node:crypto";
import type {
	EnterpriseEventStore,
	OutboxMessage,
	OutboxRedriveRequest,
	StageJobDispatch,
} from "../../src/enterprise/contracts";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { StageJobQueueError, type StageJob, type StageJobQueue } from "../../src/enterprise/stageJobQueue";
import type { ProposalWorkerCommand } from "./proposalWorker";

export interface ProposalStageJobOptions {
	priority?: number;
	maxFailures?: number;
	maxSlices?: number;
}

function digest(command: ProposalWorkerCommand, stageId: string): string {
	return createHash("sha256")
		.update(JSON.stringify([
			command.tenantId,
			command.workspaceId,
			command.runId,
			stageId,
			command.commandId,
		]))
		.digest("hex")
		.slice(0, 32);
}

export function proposalStageJob(
	command: ProposalWorkerCommand,
	options: ProposalStageJobOptions = {},
): StageJobDispatch {
	const id = digest(command, "proposal");
	return {
		...command,
		jobId: `proposal-${id}`,
		stageId: "proposal",
		sessionId: `proposal-${id}`,
		priority: options.priority ?? 0,
		maxFailures: options.maxFailures ?? 5,
		maxSlices: options.maxSlices ?? 32,
	};
}

export type OutboxDispatchResult =
	| { status: "idle" }
	| { status: "published"; message: OutboxMessage; job: StageJob }
	| { status: "retry_scheduled" | "dead_letter"; message: OutboxMessage };

export class StageJobOutbox {
	constructor(
		private readonly engine: ProposalRunEngine,
		private readonly store: EnterpriseEventStore,
		private readonly queue: StageJobQueue,
		private readonly options: ProposalStageJobOptions = {},
	) {}

	requestProposal(command: ProposalWorkerCommand): OutboxMessage {
		return this.requestStage(command, {
			stageId: "proposal",
			jobPrefix: "proposal",
		});
	}

	requestStage(
		command: ProposalWorkerCommand,
		input: {
			stageId: string;
			jobPrefix: string;
			payload?: Record<string, unknown>;
		},
	): OutboxMessage {
		const id = digest(command, input.stageId);
		const payload: StageJobDispatch = {
			...command,
			expectedVersion: command.expectedVersion + 1,
			jobId: `${input.jobPrefix}-${id}`,
			stageId: input.stageId,
			sessionId: `${input.jobPrefix}-${id}`,
			priority: this.options.priority ?? 0,
			maxFailures: this.options.maxFailures ?? 5,
			maxSlices: this.options.maxSlices ?? 32,
			payload: input.payload,
		};
		return this.engine.requestProposalJob(
			{ ...command, actorId: "blackx-run-engine" },
			{
				messageId: `outbox-${payload.jobId}`,
				topic: "stage-job.requested",
				payload,
			},
		).message;
	}

	list(scope: { tenantId: string; workspaceId: string }) { return this.store.readOutbox(scope); }
	redrive(messageId: string, request: OutboxRedriveRequest) { return this.store.redriveOutbox(messageId, request); }
	dispatchOne(): OutboxDispatchResult {
		const message = this.store.readPendingOutbox(1)[0];
		if (!message) return { status: "idle" };
		try {
			const job = this.queue.enqueue(message.payload);
			return {
				status: "published",
				message: this.store.markOutboxPublished(message.messageId),
				job,
			};
		} catch (error) {
			const failure = error instanceof StageJobQueueError
				? { code: error.code, message: error.message }
				: { code: "outbox_delivery_failed", message: "Stage Job Outbox delivery failed" };
			const failed = this.store.markOutboxFailed(message.messageId, {
				...failure, retryable: !(error instanceof StageJobQueueError && ["invalid_job", "job_conflict"].includes(error.code)),
				delayMs: Math.min(30_000, 250 * 2 ** Math.min(10, message.failureCount ?? message.deliveryCount)),
			});
			return { status: failed.status === "dead_letter" ? "dead_letter" : "retry_scheduled", message: failed };
		}
	}
}
