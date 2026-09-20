import type {
	AggregateScope,
	ApprovalState,
	ArtifactVersionState,
	EnterpriseEvent,
	EnterpriseEventData,
	EnterpriseEventStore,
	FactVersionState,
	FactSourceType,
	FactStatus,
	OutboxDraft,
	OutboxMessage,
	ProposalRunState,
} from "./contracts";
import { EnterpriseKernelError } from "./contracts";

export interface CommandEnvelope extends AggregateScope {
	commandId: string;
	correlationId: string;
	actorId: string;
	expectedVersion: number;
}

export interface CompleteProposalCommand extends CommandEnvelope {
	runtime: {
		executionId: string;
		adapterId: string;
		resumeHandle?: string;
		contextSnapshotId?: string;
	};
	artifact: {
		artifactId: string;
		schemaVersion: string;
		contentRef: string;
		inputFactVersions: Record<string, number>;
	};
	evaluation: {
		passed: boolean;
		reportRef: string;
	};
	approvalId: string;
}

export interface LinkProposalRuntimeCommand extends CommandEnvelope {
	executionId: string;
	adapterId: string;
	resumeHandle?: string;
	contextSnapshotId?: string;
}

export interface CreateProposalArtifactCommand extends CommandEnvelope {
	artifactId: string;
	schemaVersion: string;
	contentRef: string;
	inputFactVersions: Record<string, number>;
	runtimeExecutionId: string;
	contextSnapshotId?: string;
}

export interface CompleteProposalEvaluationCommand extends CommandEnvelope {
	artifactId: string;
	artifactVersion: number;
	passed: boolean;
	reportRef: string;
	approvalId: string;
	requestApproval?: boolean;
}

export interface ResolveApprovalCommand extends CommandEnvelope {
	approvalId: string;
	artifactId: string;
	artifactVersion: number;
	decision: "approved" | "rejected";
}

export interface RecordFactVersionCommand extends CommandEnvelope {
	factKey: string;
	factVersion: number;
	value: string | number | boolean;
	unit?: string;
	status: FactStatus;
	sourceType: FactSourceType;
	sourceRef: string;
}

export interface ResolveFactCommand extends CommandEnvelope {
	factKey: string;
	decision: "verified" | "rejected";
	sourceRef: string;
}

function initialState(scope: AggregateScope): ProposalRunState {
	return {
		tenantId: scope.tenantId,
		workspaceId: scope.workspaceId,
		runId: scope.runId,
		aggregateVersion: 0,
		status: "created",
		stageStatus: "pending",
		facts: {},
		factVersions: {},
		proposalVersions: [],
	};
}

function illegal(message: string): never {
	throw new EnterpriseKernelError("illegal_transition", message);
}

function reduceEvent(
	state: ProposalRunState,
	event: EnterpriseEvent,
): ProposalRunState {
	const next = { ...state, aggregateVersion: event.aggregateVersion };
	const data = event.data;

	switch (data.type) {
		case "run.created":
			if (state.aggregateVersion !== 0) illegal("Run can only be created once");
			return next;
		case "stage.started":
			if (state.stageStatus !== "pending") illegal("Proposal stage is not pending");
			return { ...next, status: "running", stageStatus: "running", lastJobId: undefined };
		case "stage.execution_requested":
			if (state.stageStatus !== "running" && !(
				state.stageStatus === "waiting_approval" && state.approval?.status === "approved"
			)) {
				illegal("Proposal execution cannot be requested from the current stage state");
			}
			return { ...next, lastJobId: data.jobId };
		case "fact.version_recorded":
			return {
				...next,
				facts: {
					...state.facts,
					[data.factKey]: {
						key: data.factKey,
						version: data.factVersion,
						value: data.value,
						unit: data.unit,
						status: data.status,
						sourceType: data.sourceType,
						sourceRef: data.sourceRef,
						recordedAt: event.occurredAt,
						recordedBy: event.actorId,
					},
				},
				factVersions: {
					...state.factVersions,
					[data.factKey]: data.factVersion,
				},
			};
		case "runtime.execution.linked":
			if (state.stageStatus !== "running") {
				illegal("Runtime execution requires a running Proposal stage");
			}
			return {
				...next,
				lastRuntimeExecutionId: data.executionId,
				lastContextSnapshotId: data.contextSnapshotId,
			};
		case "artifact.version_created": {
			if (state.stageStatus !== "running") {
				illegal("Proposal Artifact requires a running Proposal stage");
			}
			const artifact: ArtifactVersionState = {
				artifactId: data.artifactId,
				version: data.artifactVersion,
				schemaVersion: data.schemaVersion,
				contentRef: data.contentRef,
				freshness: "fresh",
				inputFactVersions: { ...data.inputFactVersions },
				runtimeExecutionId: data.runtimeExecutionId,
				contextSnapshotId: data.contextSnapshotId,
			};
			return {
				...next,
				stageStatus: "evaluating",
				currentProposal: artifact,
				evaluation: undefined,
				approval: undefined,
				proposalVersions: [...state.proposalVersions, artifact],
			};
		}
		case "evaluation.completed":
			if (
				state.stageStatus !== "evaluating" ||
				state.currentProposal?.artifactId !== data.artifactId ||
				state.currentProposal.version !== data.artifactVersion
			) {
				illegal("Evaluation must target the current Proposal version");
			}
			return {
				...next,
				...(data.passed ? {} : { stageStatus: "retryable_failed" as const, status: "running" as const }),
				evaluation: {
					artifactId: data.artifactId,
					artifactVersion: data.artifactVersion,
					passed: data.passed,
					reportRef: data.reportRef,
				},
			};
		case "approval.requested": {
			if (
				state.stageStatus !== "evaluating" ||
				state.currentProposal?.artifactId !== data.artifactId ||
				state.currentProposal.version !== data.artifactVersion
			) {
				illegal("Approval must bind the evaluated current Proposal version");
			}
			const approval: ApprovalState = {
				approvalId: data.approvalId,
				artifactId: data.artifactId,
				artifactVersion: data.artifactVersion,
				status: "requested",
			};
			return {
				...next,
				status: "waiting_approval",
				stageStatus: "waiting_approval",
				approval,
			};
		}
		case "approval.resolved":
			if (
				state.stageStatus !== "waiting_approval" ||
				state.approval?.status !== "requested" ||
				state.approval.approvalId !== data.approvalId ||
				state.approval.artifactId !== data.artifactId ||
				state.approval.artifactVersion !== data.artifactVersion
			) {
				illegal("Approval decision does not target the active request");
			}
			return data.decision === "approved"
				? { ...next, approval: { ...state.approval, status: "approved" } }
				: {
						...next,
						status: "revision_required",
						stageStatus: "revision_required",
						approval: { ...state.approval, status: "rejected" },
					};
		case "artifact.marked_stale":
			if (
				state.currentProposal?.artifactId !== data.artifactId ||
				state.currentProposal.version !== data.artifactVersion
			) {
				illegal("Only the current Proposal version can become stale");
			}
			return {
				...next,
				currentProposal: { ...state.currentProposal, freshness: "stale" },
				proposalVersions: state.proposalVersions.map((artifact) =>
					artifact.artifactId === data.artifactId &&
					artifact.version === data.artifactVersion
						? { ...artifact, freshness: "stale" }
						: artifact,
				),
			};
		case "approval.superseded":
			if (
				state.approval?.approvalId !== data.approvalId ||
				state.approval.artifactId !== data.artifactId ||
				state.approval.artifactVersion !== data.artifactVersion
			) {
				illegal("Only the active Proposal approval can be superseded");
			}
			return {
				...next,
				approval: { ...state.approval, status: "superseded" },
			};
		case "stage.input_required":
			if (state.stageStatus !== "evaluating" || !state.evaluation?.passed) {
				illegal("Input can only be requested after a successful Evaluation");
			}
			return { ...next, status: "running", stageStatus: "needs_input" };
		case "stage.revision_required":
			if (state.currentProposal?.freshness !== "stale") {
				illegal("A revision requires a stale current Proposal");
			}
			return {
				...next,
				status: "revision_required",
				stageStatus: "revision_required",
			};
		case "stage.restarted":
			if (
				state.stageStatus !== "needs_input" &&
				state.stageStatus !== "revision_required" &&
				state.stageStatus !== "retryable_failed" &&
				state.stageStatus !== "cancelled"
			) {
				illegal("Proposal stage is not restartable from its current state");
			}
			return { ...next, status: "running", stageStatus: "running", lastJobId: undefined };
		case "stage.cancelled":
			if (state.stageStatus === "passed" || state.stageStatus === "cancelled") {
				illegal("Proposal stage cannot be cancelled from its current state");
			}
			return { ...next, status: "cancelled", stageStatus: "cancelled" };
		case "stage.completed":
			if (
				state.stageStatus !== "waiting_approval" ||
				state.approval?.status !== "approved" ||
				state.currentProposal?.freshness !== "fresh"
			) {
				illegal("Proposal Stage Gate requires an approved fresh Artifact");
			}
			return { ...next, status: "completed", stageStatus: "passed" };
	}
}

export function replayProposalRun(
	scope: AggregateScope,
	events: EnterpriseEvent[],
): ProposalRunState {
	return events.reduce(reduceEvent, initialState(scope));
}

export class ProposalRunEngine {
	constructor(
		private readonly store: EnterpriseEventStore,
		private readonly stageId = "proposal",
	) {}

	load(scope: AggregateScope): ProposalRunState {
		return replayProposalRun(scope, this.store.read(scope));
	}

	readEvents(scope: AggregateScope): EnterpriseEvent[] {
		return this.store.read(scope);
	}

	create(command: CommandEnvelope): ProposalRunState {
		return this.execute(command, [{ type: "run.created" }], () => {
			if (this.store.read(command).length > 0) illegal("Run already exists");
		});
	}

	startProposal(command: CommandEnvelope): ProposalRunState {
		return this.execute(command, [{ type: "stage.started", stage: this.stageId }], (state) => {
			if (state.aggregateVersion === 0) illegal("Run must exist before starting a stage");
			if (state.stageStatus !== "pending") illegal("Proposal stage cannot start from its current state");
		});
	}

	completeProposal(command: CompleteProposalCommand): ProposalRunState {
		return this.execute(command, this.completeProposalEvents(command), (state) => {
			if (state.stageStatus !== "running") illegal("Proposal stage is not running");
			for (const [factKey, factVersion] of Object.entries(state.factVersions)) {
				if (command.artifact.inputFactVersions[factKey] !== factVersion) {
					illegal("Proposal Artifact does not consume the latest recorded Fact versions");
				}
			}
		});
	}

	linkProposalRuntime(command: LinkProposalRuntimeCommand): ProposalRunState {
		return this.execute(command, [{
			type: "runtime.execution.linked",
			executionId: command.executionId,
			adapterId: command.adapterId,
			resumeHandle: command.resumeHandle,
			contextSnapshotId: command.contextSnapshotId,
		}], (state) => {
			if (state.stageStatus !== "running") illegal("Proposal stage is not running");
		});
	}

	createProposalArtifact(command: CreateProposalArtifactCommand): ProposalRunState {
		const state = this.load(command);
		const artifactVersion =
			(state.proposalVersions
				.filter((artifact) => artifact.artifactId === command.artifactId)
				.at(-1)?.version ?? 0) + 1;
		return this.execute(command, [{
			type: "artifact.version_created",
			artifactId: command.artifactId,
			artifactVersion,
			schemaVersion: command.schemaVersion,
			contentRef: command.contentRef,
			inputFactVersions: { ...command.inputFactVersions },
			runtimeExecutionId: command.runtimeExecutionId,
			contextSnapshotId: command.contextSnapshotId,
		}], (latest) => {
			if (latest.stageStatus !== "running") illegal("Proposal stage is not running");
			if (latest.lastRuntimeExecutionId !== command.runtimeExecutionId) {
				illegal("Proposal Artifact must use the linked Runtime execution");
			}
			this.assertCurrentFactLineage(latest, command.inputFactVersions);
		});
	}

	completeProposalEvaluation(
		command: CompleteProposalEvaluationCommand,
	): ProposalRunState {
		const events: EnterpriseEventData[] = [{
			type: "evaluation.completed",
			artifactId: command.artifactId,
			artifactVersion: command.artifactVersion,
			passed: command.passed,
			reportRef: command.reportRef,
		}];
		if (command.passed) {
			if (command.requestApproval === false) {
				events.push({ type: "stage.input_required", stage: this.stageId });
			} else {
				events.push({
					type: "approval.requested",
					approvalId: command.approvalId,
					artifactId: command.artifactId,
					artifactVersion: command.artifactVersion,
				});
			}
		}
		return this.execute(command, events, (state) => {
			if (
				state.stageStatus !== "evaluating" ||
				state.currentProposal?.artifactId !== command.artifactId ||
				state.currentProposal.version !== command.artifactVersion
			) {
				illegal("Evaluation must target the current Proposal version");
			}
		});
	}

	resolveApproval(command: ResolveApprovalCommand): ProposalRunState {
		return this.execute(
			command,
			[{
				type: "approval.resolved",
				approvalId: command.approvalId,
				artifactId: command.artifactId,
				artifactVersion: command.artifactVersion,
				decision: command.decision,
			}],
			(state) => {
				if (
					state.currentProposal?.artifactId !== command.artifactId ||
					state.currentProposal.version !== command.artifactVersion
				) {
					throw new EnterpriseKernelError(
						"artifact_version_mismatch",
						"Approval must target the current Proposal Artifact version",
					);
				}
			},
		);
	}

	/** External evidence can lose validity even after delivery. Preserve the artifact, revoke its approval. */
	invalidateSource(command: CommandEnvelope & { reason: string }): ProposalRunState {
		const state = this.load(command);
		const artifact = state.currentProposal;
		if (!artifact || artifact.freshness === "stale") return state;
		return this.execute(command, [
			{ type: "artifact.marked_stale", artifactId: artifact.artifactId, artifactVersion: artifact.version, reason: command.reason },
			...(state.approval && state.approval.status !== "superseded" ? [{ type: "approval.superseded" as const, approvalId: state.approval.approvalId, artifactId: state.approval.artifactId, artifactVersion: state.approval.artifactVersion }] : []),
			{ type: "stage.revision_required", stage: this.stageId },
		]);
	}

	confirmProposalGate(command: CommandEnvelope): ProposalRunState {
		return this.execute(
			command,
			[{ type: "stage.completed", stage: this.stageId }],
			(state) => {
				if (
					state.stageStatus !== "waiting_approval" ||
					state.approval?.status !== "approved" ||
					state.currentProposal?.freshness !== "fresh"
				) {
					illegal("Proposal Stage Gate requires an approved fresh Artifact");
				}
			},
		);
	}

	recordFactVersion(
		command: RecordFactVersionCommand,
		options: { duringExecution?: boolean } = {},
	): ProposalRunState {
		const state = this.load(command);
		const current = state.currentProposal;
		const usedVersion = current?.inputFactVersions[command.factKey];
		const invalidates =
			current?.freshness === "fresh" &&
			usedVersion !== command.factVersion;
		const events: EnterpriseEventData[] = [{
			type: "fact.version_recorded",
			factKey: command.factKey,
			factVersion: command.factVersion,
			value: command.value,
			unit: command.unit,
			status: command.status,
			sourceType: command.sourceType,
			sourceRef: command.sourceRef,
		}];
		if (invalidates && current) {
			events.push({
				type: "artifact.marked_stale",
				artifactId: current.artifactId,
				artifactVersion: current.version,
				reason: `${command.factKey} changed`,
			});
			if (state.approval) {
				events.push({
					type: "approval.superseded",
					approvalId: state.approval.approvalId,
					artifactId: state.approval.artifactId,
					artifactVersion: state.approval.artifactVersion,
				});
			}
			events.push({ type: "stage.revision_required", stage: this.stageId });
		}
		return this.execute(command, events, (latest) => {
			if (latest.stageStatus === "cancelled" || latest.stageStatus === "passed") {
				illegal("Facts cannot change after the stage is terminal");
			}
			if (
				latest.stageStatus === "evaluating" ||
				latest.stageStatus === "running" && latest.lastJobId && !options.duringExecution
			) {
				throw new EnterpriseKernelError(
					"concurrency_conflict",
					"Facts cannot change while the Proposal Worker is executing",
				);
			}
			this.assertFactAuthority(command);
			const recorded = latest.factVersions[command.factKey];
			if (recorded !== undefined && command.factVersion <= recorded) {
				illegal("Fact versions must increase monotonically");
			}
		});
	}

	resolveFact(command: ResolveFactCommand): ProposalRunState {
		if (this.readFactCommand(command, command.commandId)) return this.load(command);
		const current = this.load(command).facts[command.factKey];
		if (!current) illegal("Fact does not exist");
		if (current.status !== "suggested" && current.status !== "unverified") {
			illegal("Only suggested or unverified Facts can be resolved");
		}
		return this.recordFactVersion({
			...command,
			factVersion: current.version + 1,
			value: current.value,
			unit: current.unit,
			status: command.decision,
			sourceType: "human_confirmation",
		});
	}

	readFactCommand(scope: AggregateScope, commandId: string): FactVersionState | undefined {
		const event = this.store.readCommand(scope, commandId)
			.find((candidate) => candidate.data.type === "fact.version_recorded");
		if (!event || event.data.type !== "fact.version_recorded") return undefined;
		return {
			key: event.data.factKey,
			version: event.data.factVersion,
			value: event.data.value,
			unit: event.data.unit,
			status: event.data.status,
			sourceType: event.data.sourceType,
			sourceRef: event.data.sourceRef,
			recordedAt: event.occurredAt,
			recordedBy: event.actorId,
		};
	}

	restartProposal(command: CommandEnvelope): ProposalRunState {
		return this.execute(
			command,
			[{ type: "stage.restarted", stage: this.stageId }],
			(state) => {
				if (
					state.stageStatus !== "needs_input" &&
					state.stageStatus !== "revision_required" &&
					state.stageStatus !== "retryable_failed" &&
					state.stageStatus !== "cancelled"
				) {
					illegal("Proposal stage is not restartable from its current state");
				}
			},
		);
	}

	cancelStage(command: CommandEnvelope): ProposalRunState {
		const state = this.load(command);
		const events: EnterpriseEventData[] = [];
		if (state.approval && state.approval.status !== "superseded") {
			events.push({
				type: "approval.superseded",
				approvalId: state.approval.approvalId,
				artifactId: state.approval.artifactId,
				artifactVersion: state.approval.artifactVersion,
			});
		}
		events.push({ type: "stage.cancelled", stage: this.stageId });
		return this.execute(command, events, (latest) => {
			if (latest.aggregateVersion === 0) illegal("Run must exist before cancellation");
			if (latest.stageStatus === "passed" || latest.stageStatus === "cancelled") {
				illegal("Proposal stage cannot be cancelled from its current state");
			}
		});
	}

	requestProposalJob(
		command: CommandEnvelope,
		outbox: OutboxDraft,
	): { state: ProposalRunState; message: OutboxMessage } {
		const duplicate = this.store.readCommand(command, command.commandId);
		if (duplicate.length === 0) {
			const state = this.load(command);
			if (state.stageStatus !== "running" && !(
				state.stageStatus === "waiting_approval" && state.approval?.status === "approved"
			)) {
				illegal("Proposal execution cannot be requested from the current stage state");
			}
		}
		const result = this.store.append({
			...command,
				events: [{
					data: {
						type: "stage.execution_requested",
						stage: this.stageId,
					jobId: outbox.payload.jobId,
				},
			}],
			outbox: [outbox],
		});
		const message = result.outbox[0];
		if (!message) {
			throw new EnterpriseKernelError("event_store_unavailable", "Proposal Job Outbox message is missing");
		}
		return { state: this.load(command), message };
	}

	hasCommand(scope: AggregateScope, commandId: string): boolean {
		return this.store.readCommand(scope, commandId).length > 0;
	}

	private completeProposalEvents(
		command: CompleteProposalCommand,
	): EnterpriseEventData[] {
		const state = this.load(command);
		const artifactVersion =
			(state.proposalVersions
				.filter((artifact) => artifact.artifactId === command.artifact.artifactId)
				.at(-1)?.version ?? 0) + 1;
		const events: EnterpriseEventData[] = [
			{
				type: "runtime.execution.linked",
				executionId: command.runtime.executionId,
				adapterId: command.runtime.adapterId,
				resumeHandle: command.runtime.resumeHandle,
				contextSnapshotId: command.runtime.contextSnapshotId,
			},
			{
				type: "artifact.version_created",
				artifactId: command.artifact.artifactId,
				artifactVersion,
				schemaVersion: command.artifact.schemaVersion,
				contentRef: command.artifact.contentRef,
				inputFactVersions: { ...command.artifact.inputFactVersions },
				runtimeExecutionId: command.runtime.executionId,
				contextSnapshotId: command.runtime.contextSnapshotId,
			},
			{
				type: "evaluation.completed",
				artifactId: command.artifact.artifactId,
				artifactVersion,
				passed: command.evaluation.passed,
				reportRef: command.evaluation.reportRef,
			},
		];
		if (command.evaluation.passed) {
			events.push({
				type: "approval.requested",
				approvalId: command.approvalId,
				artifactId: command.artifact.artifactId,
				artifactVersion,
			});
		}
		return events;
	}

	private assertCurrentFactLineage(
		state: ProposalRunState,
		inputFactVersions: Record<string, number>,
	): void {
		for (const [factKey, factVersion] of Object.entries(state.factVersions)) {
			if (inputFactVersions[factKey] !== factVersion) {
				illegal("Proposal Artifact does not consume the latest recorded Fact versions");
			}
		}
	}

	private assertFactAuthority(command: RecordFactVersionCommand): void {
		if (
			command.status === "verified" &&
			command.sourceType !== "enterprise_source" &&
			command.sourceType !== "human_confirmation"
		) {
			illegal("Verified Facts require an enterprise source or human confirmation");
		}
		if (command.status === "rejected" && command.sourceType !== "human_confirmation") {
			illegal("Rejected Facts require human confirmation");
		}
		if (
			command.sourceType === "human_confirmation" &&
			command.status !== "verified" &&
			command.status !== "rejected"
		) {
			illegal("Human confirmation must verify or reject a Fact");
		}
	}

	private execute(
		command: CommandEnvelope,
		events: EnterpriseEventData[],
		validate?: (state: ProposalRunState) => void,
	): ProposalRunState {
		const duplicate = this.store.readCommand(command, command.commandId);
		if (duplicate.length > 0) return this.load(command);
		const state = this.load(command);
		validate?.(state);
		this.store.append({
			...command,
			events: events.map((data) => ({ data })),
		});
		return this.load(command);
	}
}
