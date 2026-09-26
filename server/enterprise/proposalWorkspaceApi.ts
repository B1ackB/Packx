import { createHash } from "node:crypto";
import type { ArtifactContentStore } from "../../src/enterprise/artifactStore";
import { ArtifactStoreError } from "../../src/enterprise/artifactStore";
import type {
	AggregateScope,
	FactSourceType,
	FactStatus,
	ProposalRunState,
} from "../../src/enterprise/contracts";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { StageJobQueueError } from "../../src/enterprise/stageJobQueue";
import type {
	ConversationView,
	ProposalWorkspaceView,
} from "../../src/runtime/conversationContracts";
import type {
	ConversationApiContext,
	ConversationApiResponse,
} from "../runtime/conversationApi";
import { ConversationApiController } from "../runtime/conversationApi";
import { StageJobOutbox } from "../workers/stageJobOutbox";
import { StageJobScheduler } from "../workers/stageJobScheduler";

export class ProposalWorkspaceValidationError extends Error {
	constructor(message: string, readonly code?: string) { super(message); }
}

class ConversationAccessError extends Error {
	constructor(readonly response: ConversationApiResponse) {
		super("Conversation is unavailable");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredId(value: unknown, name: string, maximumLength = 128): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximumLength ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
	) {
		throw new ProposalWorkspaceValidationError(`${name} is invalid`);
	}
	return value;
}

function requestId(payload: unknown): string {
	if (!isRecord(payload)) {
		throw new ProposalWorkspaceValidationError("Request payload must be an object");
	}
	return requiredId(payload.requestId, "requestId", 64);
}

function decision(payload: unknown): "approved" | "rejected" {
	if (!isRecord(payload) || (payload.decision !== "approved" && payload.decision !== "rejected")) {
		throw new ProposalWorkspaceValidationError("decision is invalid");
	}
	return payload.decision;
}

function factValue(payload: unknown): string | number | boolean {
	if (!isRecord(payload)) {
		throw new ProposalWorkspaceValidationError("Request payload must be an object");
	}
	const value = payload.value;
	if (
		(typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
		(typeof value === "number" && !Number.isFinite(value)) ||
		(typeof value === "string" && (!value.trim() || value.length > 4_096))
	) {
		throw new ProposalWorkspaceValidationError("value is invalid");
	}
	return typeof value === "string" ? value.trim() : value;
}

function factUnit(payload: unknown): string | undefined {
	if (!isRecord(payload) || payload.unit === undefined || payload.unit === "") return undefined;
	if (typeof payload.unit !== "string" || payload.unit.length > 32 || /[\r\n\u0000]/.test(payload.unit)) {
		throw new ProposalWorkspaceValidationError("unit is invalid");
	}
	return payload.unit;
}

function factDecision(payload: unknown): "verified" | "rejected" {
	if (!isRecord(payload) || (payload.decision !== "verified" && payload.decision !== "rejected")) {
		throw new ProposalWorkspaceValidationError("Fact decision is invalid");
	}
	return payload.decision;
}

function sameFact(
	left: { key: string; value: string | number | boolean; unit?: string; status: string },
	right: { key: string; value: string | number | boolean; unit?: string; status: string },
): boolean {
	return left.key === right.key &&
		Object.is(left.value, right.value) &&
		left.unit === right.unit &&
		left.status === right.status;
}

export interface ArtifactWorkspaceStartFact {
	key: string;
	value: string | number | boolean;
	unit?: string;
	status: FactStatus;
	sourceType: FactSourceType;
	sourceRef: string;
}

export interface ArtifactWorkspaceOptions {
	responseKey: string;
	requestErrorCode: string;
	failureCode: string;
	runPrefix: string;
	stageId: string;
	jobPrefix: string;
	evaluationArtifactId: string;
	protectedFactKeys?: readonly string[];
	assertWritable?: (state: ProposalRunState) => void;
	prepareStart?: (
		payload: unknown,
		conversation: ConversationView,
		scope: AggregateScope,
	) => { facts: ArtifactWorkspaceStartFact[]; brief?: string; briefSourceType?: FactSourceType };
}

const proposalWorkspaceOptions: ArtifactWorkspaceOptions = {
	responseKey: "proposal",
	requestErrorCode: "invalid_proposal_request",
	failureCode: "proposal_workspace_failed",
	runPrefix: "proposal",
	stageId: "proposal",
	jobPrefix: "proposal",
	evaluationArtifactId: "proposal-evaluation",
};

export function workspaceRunId(
	scope: Omit<AggregateScope, "runId">,
	conversationId: string,
	prefix: string,
): string {
	const digest = createHash("sha256")
		.update(`${scope.tenantId}\u0000${scope.workspaceId}\u0000${conversationId}`)
		.digest("hex")
		.slice(0, 32);
	return `${prefix}-${digest}`;
}

export class ProposalWorkspaceApiController {
	constructor(
		protected readonly conversations: ConversationApiController,
		private readonly engine: ProposalRunEngine,
		private readonly artifacts: ArtifactContentStore,
		private readonly outbox: StageJobOutbox,
		private readonly scheduler: StageJobScheduler,
		private readonly options: ArtifactWorkspaceOptions = proposalWorkspaceOptions,
	) {}

	get(context: ConversationApiContext, conversationId: unknown): ConversationApiResponse {
		return this.respond(() => {
			const { scope } = this.target(context, conversationId);
			const state = this.engine.load(scope);
			return {
				status: 200,
				body: this.body(state.aggregateVersion === 0 ? null : this.view(state)),
			};
		});
	}

	start(
		context: ConversationApiContext,
		conversationId: unknown,
		payload: unknown,
	): ConversationApiResponse {
		return this.respond(() => {
			const id = requestId(payload);
			const { scope, conversation } = this.target(context, conversationId);
			this.options.assertWritable?.(this.engine.load(scope));
			const actorId = requiredId(context.actorId, "actorId");
			const messages = conversation.messages.filter((message) => message.role === "user");
			const prepared = this.options.prepareStart?.(payload, conversation, scope);
			if (messages.length === 0 && !prepared?.brief) {
				throw new ProposalWorkspaceValidationError("Conversation has no user message to propose from");
			}
			const brief = prepared?.brief ?? messages.map((message) => message.content).join("\n\n");
			if (brief.length > 32_000) {
				throw new ProposalWorkspaceValidationError("Conversation brief is too large");
			}
			const extraStartFacts = prepared?.facts ?? [];
			const correlationId = `${id}:${this.options.stageId}`;
			let state = this.engine.load(scope);
			if (state.aggregateVersion === 0) {
				state = this.engine.create({
					...scope,
					actorId,
					commandId: `${id}:create`,
					correlationId,
					expectedVersion: 0,
				});
			}
			if (state.stageStatus === "pending") {
				state = this.engine.startProposal({
					...scope,
					actorId,
					commandId: `${id}:start`,
					correlationId,
					expectedVersion: state.aggregateVersion,
				});
			}

			const sourceRef = `conversation:${conversation.conversationId}:revision:${conversation.revision}`;
			const startFacts = [
				{
					key: "customer_brief",
					value: brief,
					status: "unverified" as const,
					sourceType: prepared?.briefSourceType ?? "user_input" as const,
					sourceRef,
				},
				...extraStartFacts,
			];
			for (const fact of startFacts) {
				const factCommandId = `${id}:fact:${fact.key}`;
				const existing = state.facts[fact.key];
				if (this.engine.hasCommand(scope, factCommandId)) {
					if (!existing || !sameFact(existing, fact) || existing.sourceRef !== fact.sourceRef) {
						throw new EnterpriseKernelError(
							"concurrency_conflict",
							"requestId is already bound to another Workspace snapshot",
						);
					}
					continue;
				}
				if (existing && sameFact(existing, fact) && existing.sourceRef === fact.sourceRef) continue;
				state = this.engine.recordFactVersion({
					...scope,
					actorId,
					commandId: factCommandId,
					correlationId,
					expectedVersion: state.aggregateVersion,
					factKey: fact.key,
					factVersion: (state.factVersions[fact.key] ?? 0) + 1,
					value: fact.value,
					unit: fact.unit,
					status: fact.status,
					sourceType: fact.sourceType,
					sourceRef: fact.sourceRef,
				});
			}
			if (
				state.stageStatus === "needs_input" ||
				state.stageStatus === "revision_required" ||
				state.stageStatus === "retryable_failed" ||
				state.stageStatus === "cancelled"
			) {
				state = this.engine.restartProposal({
					...scope,
					actorId,
					commandId: `${id}:restart`,
					correlationId,
					expectedVersion: state.aggregateVersion,
				});
			}

			const workerCommandId = `${id}:execute`;
			if (state.stageStatus !== "running" && !this.engine.hasCommand(scope, workerCommandId)) {
				throw new EnterpriseKernelError(
					"illegal_transition",
					"Proposal cannot start from the current state",
				);
			}
			this.requestJob({
				...scope,
				commandId: workerCommandId,
				correlationId,
				expectedVersion: state.aggregateVersion,
			});
			this.outbox.dispatchOne();
			return { status: 202, body: this.body(this.view(this.engine.load(scope))) };
		});
	}

	resolveApproval(
		context: ConversationApiContext,
		conversationId: unknown,
		payload: unknown,
	): ConversationApiResponse {
		return this.respond(() => {
			const id = requestId(payload);
			const selectedDecision = decision(payload);
			const { scope } = this.target(context, conversationId);
			this.options.assertWritable?.(this.engine.load(scope));
			const actorId = requiredId(context.actorId, "actorId");
			let state = this.engine.load(scope);
			const approval = state.approval;
			if (!approval || !state.currentProposal) {
				throw new EnterpriseKernelError("illegal_transition", "Proposal has no active approval");
			}
			const commandId = `${id}:approval`;
			if (this.engine.hasCommand(scope, commandId)) {
				if (approval.status !== selectedDecision) {
					throw new EnterpriseKernelError(
						"concurrency_conflict",
						"requestId is already bound to another approval decision",
					);
				}
			} else {
				state = this.engine.resolveApproval({
					...scope,
					actorId,
					commandId,
					correlationId: `${id}:proposal-approval`,
					expectedVersion: state.aggregateVersion,
					approvalId: approval.approvalId,
					artifactId: approval.artifactId,
					artifactVersion: approval.artifactVersion,
					decision: selectedDecision,
				});
			}
			if (selectedDecision === "approved") {
				this.requestJob({
					...scope,
					commandId: `${id}:gate`,
					correlationId: `${id}:proposal-approval`,
					expectedVersion: state.aggregateVersion,
				});
				this.outbox.dispatchOne();
			}
			return { status: 202, body: this.body(this.view(this.engine.load(scope))) };
		});
	}

	cancel(
		context: ConversationApiContext,
		conversationId: unknown,
		payload: unknown,
	): ConversationApiResponse {
		return this.respond(() => {
			const id = requestId(payload);
			const { scope } = this.target(context, conversationId);
			const actorId = requiredId(context.actorId, "actorId");
			const commandId = `${id}:cancel`;
			let state = this.engine.load(scope);
			if (!this.engine.hasCommand(scope, commandId)) {
				state = this.engine.cancelStage({
					...scope,
					actorId,
					commandId,
					correlationId: `${id}:${this.options.stageId}-cancel`,
					expectedVersion: state.aggregateVersion,
				});
			}
			if (state.lastJobId) {
				const job = this.scheduler.getJob(state.lastJobId, scope);
				if (job?.status === "queued" || job?.status === "leased") {
					this.scheduler.cancel(state.lastJobId, scope);
				}
			}
			return { status: 200, body: this.body(this.view(this.engine.load(scope))) };
		});
	}

	recordFact(
		context: ConversationApiContext,
		conversationId: unknown,
		payload: unknown,
	): ConversationApiResponse {
		return this.respond(() => {
			const id = requestId(payload);
			if (!isRecord(payload)) {
				throw new ProposalWorkspaceValidationError("Request payload must be an object");
			}
			const factKey = requiredId(payload.key, "factKey", 64);
			if (this.options.protectedFactKeys?.includes(factKey)) {
				throw new ProposalWorkspaceValidationError(`${factKey} is managed by the Intake source`);
			}
			const value = factValue(payload);
			const unit = factUnit(payload);
			const { scope, conversation } = this.target(context, conversationId);
			this.options.assertWritable?.(this.engine.load(scope));
			const actorId = requiredId(context.actorId, "actorId");
			const state = this.engine.load(scope);
			if (state.aggregateVersion === 0) {
				throw new EnterpriseKernelError("illegal_transition", "Proposal Run does not exist");
			}
			const commandId = `${id}:fact`;
			const recorded = this.engine.readFactCommand(scope, commandId);
			const candidate = { key: factKey, value, unit, status: "unverified" };
			if (recorded && !sameFact(recorded, candidate)) {
				throw new EnterpriseKernelError(
					"concurrency_conflict",
					"requestId is already bound to another Fact candidate",
				);
			}
			const next = recorded
				? state
				: this.engine.recordFactVersion({
						...scope,
						actorId,
						commandId,
						correlationId: `${id}:fact-update`,
						expectedVersion: state.aggregateVersion,
						factKey,
						factVersion: (state.factVersions[factKey] ?? 0) + 1,
						value,
						unit,
						status: "unverified",
						sourceType: "user_input",
						sourceRef: `conversation:${conversation.conversationId}:fact-form:${id}`,
					});
			return { status: 200, body: this.body(this.view(next)) };
		});
	}

	resolveFact(
		context: ConversationApiContext,
		conversationId: unknown,
		factKeyValue: unknown,
		payload: unknown,
	): ConversationApiResponse {
		return this.respond(() => {
			const id = requestId(payload);
			const selectedDecision = factDecision(payload);
			const expected = (payload as { expectedAggregateVersion?: unknown }).expectedAggregateVersion;
			if (expected !== undefined && (!Number.isSafeInteger(expected) || Number(expected) < 1)) throw new ProposalWorkspaceValidationError("expectedAggregateVersion must be a positive integer");
			const factKey = requiredId(factKeyValue, "factKey", 64);
			if (this.options.protectedFactKeys?.includes(factKey)) {
				throw new ProposalWorkspaceValidationError(`${factKey} is managed by the Intake source`);
			}
			const { scope, conversation } = this.target(context, conversationId);
			const actorId = requiredId(context.actorId, "actorId");
			const state = this.engine.load(scope);
			const current = state.facts[factKey];
			this.options.assertWritable?.(state);
			if (!current) {
				throw new EnterpriseKernelError("illegal_transition", "Fact does not exist");
			}
			const commandId = `${id}:fact-decision`;
			const recorded = this.engine.readFactCommand(scope, commandId);
			if (recorded && (recorded.key !== factKey || recorded.status !== selectedDecision)) {
				throw new EnterpriseKernelError(
					"concurrency_conflict",
					"requestId is already bound to another Fact decision",
				);
			}
			const next = recorded
				? state
				: this.engine.resolveFact({
						...scope,
						actorId,
						commandId,
						correlationId: `${id}:fact-decision`,
						expectedVersion: expected === undefined ? state.aggregateVersion : Number(expected),
						factKey,
						decision: selectedDecision,
						sourceRef: `conversation:${conversation.conversationId}:fact-decision:${id}`,
					});
			return { status: 200, body: this.body(this.view(next)) };
		});
	}

	protected target(
		context: ConversationApiContext,
		conversationIdValue: unknown,
	): { scope: AggregateScope; conversation: ConversationView } {
		const tenantId = requiredId(context.tenantId, "tenantId");
		const workspaceId = requiredId(context.workspaceId, "workspaceId");
		const conversationId = requiredId(conversationIdValue, "conversationId");
		const response = this.conversations.get(context, conversationId);
		if (response.status !== 200) throw new ConversationAccessError(response);
		const conversation = (response.body as { conversation: ConversationView }).conversation;
		return {
			conversation,
			scope: {
				tenantId,
				workspaceId,
				runId: workspaceRunId({ tenantId, workspaceId }, conversationId, this.options.runPrefix),
			},
		};
	}

	protected view(state: ProposalRunState): ProposalWorkspaceView {
		const artifact = state.currentProposal
			? {
				content: this.artifacts.readJson({
					...state,
					artifactId: state.currentProposal.artifactId,
					artifactVersion: state.currentProposal.version,
				}),
			}
			: undefined;
		const evaluation = state.evaluation
			? {
				report: this.artifacts.readJson({
					...state,
					artifactId: this.options.evaluationArtifactId,
					artifactVersion: state.evaluation.artifactVersion,
				}),
			}
			: undefined;
		const job = state.lastJobId
			? this.scheduler.getJob(state.lastJobId, state)
			: undefined;
		return {
			runId: state.runId,
			state,
			artifact,
			evaluation,
			job: job && {
				jobId: job.jobId,
				leaseExpiresAt: job.leaseExpiresAt,
				status: job.status,
				failureCount: job.failureCount,
				lastFailure: job.lastFailure && {
					code: job.lastFailure.code,
					message: job.lastFailure.message,
				},
			},
		};
	}

	private requestJob(command: Parameters<StageJobOutbox["requestProposal"]>[0]): void {
		this.outbox.requestStage(command, {
			stageId: this.options.stageId,
			jobPrefix: this.options.jobPrefix,
		});
	}

	private body(value: ProposalWorkspaceView | null): Record<string, unknown> {
		return { [this.options.responseKey]: value };
	}

	protected respond(operation: () => ConversationApiResponse): ConversationApiResponse {
		try {
			return operation();
		} catch (error) {
			if (error instanceof ConversationAccessError) return error.response;
			if (error instanceof ProposalWorkspaceValidationError) {
				return { status: 400, body: { code: error.code ?? this.options.requestErrorCode, message: error.message } };
			}
			if (error instanceof EnterpriseKernelError) {
				const status = error.code === "aggregate_access_denied"
					? 404
					: error.code === "concurrency_conflict"
						? 409
						: error.code === "illegal_transition" || error.code === "artifact_version_mismatch"
							? 422
							: 503;
				return { status, body: { code: error.code, message: error.message } };
			}
			if (error instanceof ArtifactStoreError) {
				return { status: 503, body: { code: error.code, message: error.message } };
			}
			if (error instanceof StageJobQueueError) {
				return {
					status: error.code === "job_conflict" || error.code === "invalid_job" ? 409 : 503,
					body: { code: error.code, message: error.message },
				};
			}
			return { status: 500, body: { code: this.options.failureCode } };
		}
	}
}
