export interface AggregateScope {
	tenantId: string;
	workspaceId: string;
	runId: string;
}

export type RunStatus =
	| "created"
	| "running"
	| "waiting_approval"
	| "revision_required"
	| "cancelled"
	| "completed";

export type StageStatus =
	| "pending"
	| "running"
	| "evaluating"
	| "needs_input"
	| "waiting_approval"
	| "revision_required"
	| "cancelled"
	| "passed"
	| "retryable_failed";

export type ApprovalStatus =
	| "requested"
	| "approved"
	| "rejected"
	| "superseded";

export type FactStatus = "suggested" | "unverified" | "verified" | "rejected";

export type FactSourceType =
	| "user_input"
	| "source_document"
	| "model_output"
	| "enterprise_source"
	| "human_confirmation";

export interface FactVersionState {
	key: string;
	version: number;
	value: string | number | boolean;
	unit?: string;
	status: FactStatus;
	sourceType: FactSourceType;
	sourceRef: string;
	recordedAt?: string;
	recordedBy?: string;
}

export interface ArtifactVersionState {
	artifactId: string;
	version: number;
	schemaVersion: string;
	contentRef: string;
	freshness: "fresh" | "stale";
	inputFactVersions: Record<string, number>;
	runtimeExecutionId: string;
	contextSnapshotId?: string;
}

export interface ApprovalState {
	approvalId: string;
	artifactId: string;
	artifactVersion: number;
	status: ApprovalStatus;
}

export interface ProposalEvaluationState {
	artifactId: string;
	artifactVersion: number;
	passed: boolean;
	reportRef: string;
}

export interface ProposalRunState extends AggregateScope {
	aggregateVersion: number;
	status: RunStatus;
	stageStatus: StageStatus;
	facts: Record<string, FactVersionState>;
	factVersions: Record<string, number>;
	proposalVersions: ArtifactVersionState[];
	currentProposal?: ArtifactVersionState;
	evaluation?: ProposalEvaluationState;
	approval?: ApprovalState;
	lastJobId?: string;
	lastRuntimeExecutionId?: string;
	lastContextSnapshotId?: string;
}

export type EnterpriseEventData =
	| { type: "run.created" }
	| { type: "stage.started"; stage: string }
	| { type: "stage.execution_requested"; stage: string; jobId: string }
	| {
			type: "fact.version_recorded";
			factKey: string;
			factVersion: number;
			value: string | number | boolean;
			unit?: string;
			status: FactStatus;
			sourceType: FactSourceType;
			sourceRef: string;
		}
	| {
			type: "runtime.execution.linked";
			executionId: string;
			adapterId: string;
			resumeHandle?: string;
			contextSnapshotId?: string;
		}
	| {
			type: "artifact.version_created";
			artifactId: string;
			artifactVersion: number;
			schemaVersion: string;
			contentRef: string;
			inputFactVersions: Record<string, number>;
			runtimeExecutionId: string;
			contextSnapshotId?: string;
		}
	| {
			type: "evaluation.completed";
			artifactId: string;
			artifactVersion: number;
			passed: boolean;
			reportRef: string;
		}
	| {
			type: "approval.requested";
			approvalId: string;
			artifactId: string;
			artifactVersion: number;
		}
	| {
			type: "approval.resolved";
			approvalId: string;
			artifactId: string;
			artifactVersion: number;
			decision: "approved" | "rejected";
		}
	| {
			type: "artifact.marked_stale";
			artifactId: string;
			artifactVersion: number;
			reason: string;
		}
	| {
			type: "approval.superseded";
			approvalId: string;
			artifactId: string;
			artifactVersion: number;
		}
	| { type: "stage.input_required"; stage: string }
	| { type: "stage.revision_required"; stage: string }
	| { type: "stage.restarted"; stage: string }
	| { type: "stage.cancelled"; stage: string }
	| { type: "stage.completed"; stage: string };

export interface EnterpriseEvent extends AggregateScope {
	eventId: string;
	aggregateVersion: number;
	commandId: string;
	correlationId: string;
	actorId: string;
	occurredAt: string;
	data: EnterpriseEventData;
}

export interface EventDraft {
	data: EnterpriseEventData;
}

export interface StageJobDispatch extends AggregateScope {
	jobId: string;
	stageId: string;
	commandId: string;
	correlationId: string;
	expectedVersion: number;
	sessionId: string;
	priority?: number;
	maxFailures?: number;
	maxSlices?: number;
	availableAt?: string;
	payload?: Record<string, unknown>;
}

export interface OutboxDraft {
	messageId: string;
	topic: "stage-job.requested";
	payload: StageJobDispatch;
}

export interface OutboxRedriveRequest {
	tenantId: string;
	workspaceId: string;
	actorId: string;
	requestId: string;
	reason: string;
	expectedUpdatedAt: string;
}

export interface OutboxMessage extends OutboxDraft {
	failureCount?: number;
	redrives?: Array<Pick<OutboxRedriveRequest, "actorId" | "requestId" | "reason" | "expectedUpdatedAt"> & { at: string }>;
	schemaVersion: "enterprise-outbox.v1";
	status: "pending" | "published" | "dead_letter";
	deliveryCount: number;
	availableAt: string;
	createdAt: string;
	updatedAt: string;
	publishedAt?: string;
	lastFailure?: {
		code: string;
		message: string;
		at: string;
	};
}

export interface AppendRequest extends AggregateScope {
	expectedVersion: number;
	commandId: string;
	correlationId: string;
	actorId: string;
	events: EventDraft[];
	outbox?: OutboxDraft[];
}

export interface AppendResult {
	events: EnterpriseEvent[];
	outbox: OutboxMessage[];
	duplicate: boolean;
}

export interface EnterpriseEventStore {
	read(scope: AggregateScope): EnterpriseEvent[];
	readCommand(scope: AggregateScope, commandId: string): EnterpriseEvent[];
	append(request: AppendRequest): AppendResult;
	readPendingOutbox(limit: number): OutboxMessage[];
	readOutbox(scope: { tenantId: string; workspaceId: string }): OutboxMessage[];
	redriveOutbox(messageId: string, request: OutboxRedriveRequest): OutboxMessage;
	markOutboxPublished(messageId: string): OutboxMessage;
	markOutboxFailed(
		messageId: string,
		failure: { code: string; message: string; delayMs: number; retryable?: boolean },
	): OutboxMessage;
}

export class EnterpriseKernelError extends Error {
	readonly code:
		| "aggregate_access_denied"
		| "concurrency_conflict"
		| "illegal_transition"
		| "artifact_version_mismatch"
		| "event_store_corrupt"
		| "event_store_unavailable";

	constructor(
		code: EnterpriseKernelError["code"],
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "EnterpriseKernelError";
		this.code = code;
	}
}
