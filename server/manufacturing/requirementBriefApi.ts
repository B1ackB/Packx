import { factSourceReference, type KnowledgeService } from "../knowledge/service";
import { KnowledgeError } from "../../src/enterprise/knowledge";
import type { RequirementDelivery } from "../../src/manufacturing/requirementDelivery";
import { evaluateRequirementBrief, type RequirementBriefV1 } from "../../src/manufacturing/requirementBrief";
import type { AssetInspectionRecord } from "../../src/runtime/assetInspection";
import type { ArtifactContentStore } from "../../src/enterprise/artifactStore";
import { ArtifactStoreError } from "../../src/enterprise/artifactStore";
import type { ProposalRunState } from "../../src/enterprise/contracts";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { requiredRequirementFacts, packagingFactKeys } from "../../src/manufacturing/requirementBrief";
import type {
	ConversationSummary,
	ConversationView,
	RequirementBriefMetricsSeriesView,
	RequirementBriefMetricsView,
	RequirementBriefRunMetricsPoint,
	RequirementBriefWorkspaceView,
} from "../../src/runtime/conversationContracts";
import type { RuntimeUsage } from "../../src/runtime/contracts";
import {
	ProposalWorkspaceApiController,
	ProposalWorkspaceValidationError,
} from "../enterprise/proposalWorkspaceApi";
import { ConversationApiController } from "../runtime/conversationApi";
import { FileConversationAttachmentStore } from "../runtime/conversationAttachments";
import { StageJobOutbox } from "../workers/stageJobOutbox";
import { StageJobScheduler } from "../workers/stageJobScheduler";
import type { PlanScope, PlanWorkspace } from "../../src/enterprise/agentPlan";
import { planRequirementSource } from "./planRequirementSource";
import type { ArtifactWorkspaceStartFact } from "../enterprise/proposalWorkspaceApi";

function industryFact(payload: unknown, _conversation: ConversationView) {
	if (
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		!("industry" in payload) ||
		payload.industry !== "print"
	) {
		throw new ProposalWorkspaceValidationError("当前仅支持包装需求（industry=print）。");
	}
	return [{
		key: "industry",
		value: payload.industry,
		status: "verified" as const,
		sourceType: "enterprise_source" as const,
		sourceRef: "domain:print:packaging",
	}];
}

export class RequirementBriefWorkspaceApiController extends ProposalWorkspaceApiController {
	constructor(
		conversations: ConversationApiController,
		private readonly requirementEngine: ProposalRunEngine,
		private readonly requirementArtifacts: ArtifactContentStore,
		outbox: StageJobOutbox,
		private readonly requirementScheduler: StageJobScheduler,
		attachments?: FileConversationAttachmentStore,
		private readonly now: () => string = () => new Date().toISOString(),
		readPlan?: (scope: PlanScope) => PlanWorkspace,
		private readonly knowledge?: KnowledgeService,
	) {
		super(conversations, requirementEngine, requirementArtifacts, outbox, requirementScheduler, {
			responseKey: "requirementBrief",
			requestErrorCode: "invalid_requirement_brief_request",
			failureCode: "requirement_brief_workspace_failed",
			runPrefix: "requirement",
			stageId: "requirement-brief",
			jobPrefix: "requirement",
			evaluationArtifactId: "requirement-brief-evaluation",
			protectedFactKeys: ["industry", "customer_brief", "customer_attachments", "plan_source", "knowledge_source"],
			assertWritable: (state) => {
				if (state.aggregateVersion > 0 && state.facts.industry?.value !== "print") throw new ProposalWorkspaceValidationError("历史非包装需求已停用，请新建包装会话；原始资料与交付版本保留。");
			},
			prepareStart: (payload, conversation, scope) => {
				const facts: ArtifactWorkspaceStartFact[] = industryFact(payload, conversation);
				const selected = knowledge?.store.selected({ ...scope, runId: conversation.conversationId });
				if (selected?.unavailable.length) throw new ProposalWorkspaceValidationError("已选证据过期或不可用，请在证据面板重新选择。", "evidence_unavailable");
				try { knowledge?.assertFacts(requirementEngine.load(scope), requirementEngine, selected?.hits ?? []); }
				catch (error) { if (error instanceof KnowledgeError) throw new ProposalWorkspaceValidationError("已有字段仍依赖旧证据，请重新录入并确认该字段。", error.code); throw error; }
				if (selected?.selection) facts.push({ key: "knowledge_source", value: JSON.stringify(selected.selection), status: "unverified", sourceType: "source_document", sourceRef: `knowledge-selection:${selected.selection.digest}` });
				const attachmentScope = {
					tenantId: scope.tenantId,
					workspaceId: scope.workspaceId,
					conversationId: conversation.conversationId,
				};
				const digest = attachments?.digest(attachmentScope);
				const planVersion = (payload as { planVersion?: unknown }).planVersion;
				let brief: string | undefined;
				if (planVersion !== undefined) {
					if (!readPlan) throw new ProposalWorkspaceValidationError("计划来源不可用。");
					const imported = planRequirementSource(readPlan({ ...scope, runId: conversation.conversationId }), planVersion, conversation,
						attachments?.list(attachmentScope).slice(-8).map(({ name, sourceRef, sha256 }) => ({ name, sourceRef, sha256 })) ?? []);
					const planSelection = JSON.parse(imported.brief).originalContext?.knowledge;
					if ((planSelection?.digest ?? null) !== (selected?.selection?.digest ?? null)) throw new ProposalWorkspaceValidationError("计划中的证据已变化，请重新规划。", "plan_evidence_stale");
					brief = imported.brief;
					facts.push(imported.source);
				} else if (this.requirementEngine.load(scope).facts.plan_source) {
					throw new ProposalWorkspaceValidationError("此需求单来自计划，请通过计划导入入口更新来源，或直接核对现有字段。", "plan_source_required");
				}
				if (digest) facts.push({
					key: "customer_attachments",
					value: digest,
					status: "unverified" as const,
					sourceType: "source_document" as const,
					sourceRef: `conversation:${conversation.conversationId}:attachments:${digest}`,
				});
				return { facts, brief, ...(brief ? { briefSourceType: "model_output" as const } : {}) };
			},
		});
	}

	override get(context: Parameters<ConversationApiController["get"]>[0], conversationId: unknown) {
		return this.respond(() => {
			const { scope } = this.target(context, conversationId);
			this.knowledge?.refreshRun(this.requirementEngine, scope);
			return super.get(context, conversationId);
		});
	}

	override resolveApproval(context: Parameters<ConversationApiController["get"]>[0], conversationId: unknown, payload: unknown) {
		return this.respond(() => {
			const { scope } = this.target(context, conversationId);
			this.knowledge?.refreshRun(this.requirementEngine, scope);
			try { this.knowledge?.assertRun(this.requirementEngine.load(scope), this.requirementEngine); }
			catch (error) { if (error instanceof KnowledgeError) return { status: 409, body: { code: error.code, message: "证据需要重新核对，不能批准。" } }; throw error; }
			return super.resolveApproval(context, conversationId, payload);
		});
	}

	override recordFact(context: Parameters<ConversationApiController["get"]>[0], conversationId: unknown, payload: unknown) {
		if (payload && typeof payload === "object" && "key" in payload &&
			!packagingFactKeys.includes(String(payload.key))) {
			return { status: 400, body: { code: "invalid_requirement_brief_request", message: "只能补充当前包装需求的标准字段。" } };
		}
		return super.recordFact(context, conversationId, payload);
	}

	delivery(context: Parameters<ConversationApiController["get"]>[0], conversationId: unknown, version: number) {
		return this.respond(() => {
			const { scope } = this.target(context, conversationId);
			this.knowledge?.refreshRun(this.requirementEngine, scope);
			const state = this.requirementEngine.load(scope);
			if (state.aggregateVersion > 0 && state.facts.industry?.value !== "print") return { status: 410, body: { code: "industry_retired", message: "历史非包装交付保留在本地，不再通过当前包装需求单导出。" } };
			const artifact = state.proposalVersions.find((item) => item.artifactId === "requirement-brief" && item.version === version);
			if (!Number.isSafeInteger(version) || !artifact) return { status: 404, body: { code: "artifact_not_found" } };
			const content = this.requirementArtifacts.readJson({ ...scope, artifactId: artifact.artifactId, artifactVersion: version });
			if (!evaluateRequirementBrief(content).passed) return { status: 409, body: { code: "invalid_artifact", message: "该版本未通过结构校验，不能导出为需求单。" } };
			const events = this.requirementEngine.readEvents(scope);
			const created = events.find((event) => event.data.type === "artifact.version_created" && event.data.artifactId === artifact.artifactId && event.data.artifactVersion === version);
			const checkpoint = this.readCheckpointMetrics(state, version);
			const brief = content as RequirementBriefV1;
			const sourcePlan = artifact.inputFactVersions.plan_source === undefined ? undefined : events.find((event) => event.data.type === "fact.version_recorded" && event.data.factKey === "plan_source" && event.data.factVersion === artifact.inputFactVersions.plan_source);
			const citations: Record<string, string> = {};
			const knowledgeSource = artifact.inputFactVersions.knowledge_source === undefined ? undefined : events.find((event) => event.data.type === "fact.version_recorded" && event.data.factKey === "knowledge_source" && event.data.factVersion === artifact.inputFactVersions.knowledge_source);
			let knowledgeEvidence: import("../../src/enterprise/knowledge").EvidenceHit[] = [];
			if (knowledgeSource?.data.type === "fact.version_recorded") {
				try { knowledgeEvidence = this.knowledge!.store.assertSelection(scope, String(knowledgeSource.data.value)); }
				catch { return { status: 409, body: { code: "evidence_unavailable", message: "来源已撤回、过期或权限变化，此交付物必须复核。" } }; }
			}
			for (const fact of brief.facts) {
				const evidenceRef = factSourceReference(events, fact.key, fact.version);
				if (evidenceRef?.startsWith("kb-")) {
					if (!knowledgeEvidence.some((hit) => hit.evidenceId === evidenceRef)) return { status: 409, body: { code: "evidence_fact_requires_review", message: "字段仍依赖旧证据，需要重新核对。" } };
				}
				if (evidenceRef) citations[fact.key] = evidenceRef;
			}
			const approved = artifact.freshness !== "stale" && state.currentProposal?.version === version && state.approval?.status === "approved" && state.approval.artifactVersion === version;
			const delivery: RequirementDelivery = {
				schemaVersion: "requirement-delivery.v1", runId: scope.runId, version,
				status: artifact.freshness === "stale" || state.currentProposal?.version !== version ? "stale" : approved ? "approved" : "draft",
				createdAt: created?.occurredAt ?? "", content: brief, knowledgeEvidence, sources: checkpoint?.inspections ?? [], citations,
				...(sourcePlan?.data.type === "fact.version_recorded" ? { sourcePlan: sourcePlan.data.sourceRef } : {}),
				...(approved ? { approval: { approvalId: state.approval!.approvalId, artifactVersion: version } } : {}),
			};
			return { status: 200, body: { delivery } };
		});
	}

	metricsSeries(context: Parameters<ConversationApiController["list"]>[0]) {
		return this.respond(() => {
			const response = this.conversations.list(context);
			if (response.status !== 200) return response;
			const conversations = (response.body as { conversations: ConversationSummary[] }).conversations;
			const points = conversations.flatMap((conversation): RequirementBriefRunMetricsPoint[] => {
				const { scope } = this.target(context, conversation.conversationId);
				const state = this.requirementEngine.load(scope);
				if (state.aggregateVersion === 0 || state.facts.industry?.value !== "print") return [];
				const events = this.requirementEngine.readEvents(state);
				const first = events[0];
				const last = events.at(-1);
				if (!first || !last) return [];
				const terminal = events.findLast((event) =>
					event.data.type === "stage.completed" || event.data.type === "stage.cancelled",
				);
				const industry = state.facts.industry?.value;
				return [{
					runId: state.runId,
					conversationId: conversation.conversationId,
					...(industry === "print" ? { industry } : {}),
					stageStatus: state.stageStatus,
					evaluationPassed: state.evaluation?.passed ?? null,
					approvalEligible: Boolean(state.approval),
					startedAt: first.occurredAt,
					updatedAt: last.occurredAt,
					...(terminal ? { completedAt: terminal.occurredAt } : {}),
					metrics: this.metrics(state),
				}];
			}).sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
			return {
				status: 200,
				body: { requirementBriefMetrics: this.summarize(points) },
			};
		});
	}

	protected override view(state: ProposalRunState): RequirementBriefWorkspaceView {
		return {
			...super.view(state),
			...(state.facts.industry?.value !== "print" ? { readOnlyReason: "此历史需求不在当前包装业务范围内，已停止生成、修改和审批。原始会话与交付记录保留，请新建会话处理包装需求。" } : {}),
			metrics: this.metrics(state),
		};
	}

	private metrics(state: ProposalRunState): RequirementBriefMetricsView {
		const industry = state.facts.industry?.value;
		const required = industry === "print"
			? requiredRequirementFacts[industry]
			: [];
		const confirmedRequiredFacts = required.filter((key) => state.facts[key]?.status === "verified").length;
		const missingRequiredFacts = required.filter((key) => {
			const fact = state.facts[key];
			return !fact || fact.status === "rejected";
		});
		const checkpoints = state.proposalVersions
			.filter((artifact) => artifact.artifactId === "requirement-brief")
			.map((artifact) => this.readCheckpointMetrics(state, artifact.version))
			.filter((checkpoint) => checkpoint !== undefined);
		const rawCandidateFacts = checkpoints.reduce(
			(total, checkpoint) => total + (checkpoint.rawCandidateFactCount ?? 0),
			0,
		);
		const canonicalCandidateFacts = checkpoints.reduce(
			(total, checkpoint) => total + (checkpoint.canonicalCandidateFactCount ?? 0),
			0,
		);
		const toolExecutionCount = checkpoints.reduce(
			(total, checkpoint) => total + (checkpoint.toolExecutionCount ?? 0),
			0,
		);
		const toolFailureCount = checkpoints.reduce(
			(total, checkpoint) => total + (checkpoint.toolFailureCount ?? 0),
			0,
		);
		const usages = checkpoints.flatMap((checkpoint) => checkpoint.usage ? [checkpoint.usage] : []);
		const usage = usages.length > 0
			? usages.reduce<RuntimeUsage>((total, current) => ({
				inputTokens: total.inputTokens + current.inputTokens,
				cachedInputTokens: total.cachedInputTokens + current.cachedInputTokens,
				outputTokens: total.outputTokens + current.outputTokens,
				reasoningOutputTokens: total.reasoningOutputTokens + current.reasoningOutputTokens,
			}), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 })
			: null;
		const durations = checkpoints.flatMap((checkpoint) =>
			checkpoint.runtimeDurationMs === undefined ? [] : [checkpoint.runtimeDurationMs],
		);
		const jobs = this.requirementScheduler.jobsForRun(state);
		const deliveryCount = jobs.reduce((total, job) => total + job.deliveryCount, 0);
		const totalFailureCount = jobs.reduce((total, job) => total + job.totalFailureCount, 0);
		const recoveryCount = jobs.reduce((total, job) => total + job.recoveryCount, 0);
		const modelCandidates = new Map<string, { value: string | number | boolean; unit?: string }>();
		for (const event of this.requirementEngine.readEvents(state)) {
			if (event.data.type === "fact.version_recorded" && event.data.sourceType === "model_output") {
				modelCandidates.set(event.data.factKey, { value: event.data.value, unit: event.data.unit });
			}
		}
		const confirmedCandidates = [...modelCandidates].filter(([key, candidate]) => {
			const current = state.facts[key];
			return current?.status === "verified" &&
				Object.is(current.value, candidate.value) && current.unit === candidate.unit;
		}).length;
		const artifactMetrics = state.proposalVersions
			.filter((artifact) => artifact.artifactId === "requirement-brief")
			.map((artifact) => this.readArtifactMetrics(state, artifact.version));
		const artifactFactCount = artifactMetrics.reduce((total, metrics) => total + metrics.facts, 0);
		const sourcedArtifactFacts = artifactMetrics.reduce((total, metrics) => total + metrics.sourcedFacts, 0);
		return {
			schemaVersion: "requirement-brief-metrics.v1",
			canonicalFactHitRate: rawCandidateFacts > 0
				? canonicalCandidateFacts / rawCandidateFacts
				: null,
			confirmedCandidateAccuracy: modelCandidates.size > 0
				? confirmedCandidates / modelCandidates.size
				: null,
			sourceCoverageRate: artifactFactCount > 0
				? sourcedArtifactFacts / artifactFactCount
				: null,
			canonicalCandidateFacts,
			rawCandidateFacts,
			confirmationRate: required.length > 0 ? confirmedRequiredFacts / required.length : 0,
			confirmedRequiredFacts,
			requiredFacts: required.length,
			missingRequiredFacts,
			clarificationRounds: this.requirementEngine.readEvents(state)
				.filter((event) => event.data.type === "stage.input_required").length,
			clarificationQuestions: artifactMetrics.reduce(
				(total, metrics) => total + metrics.missingRequiredFacts,
				0,
			),
			artifactVersions: state.proposalVersions.filter(
				(artifact) => artifact.artifactId === "requirement-brief",
			).length,
			cancelled: state.stageStatus === "cancelled",
			queue: {
				deliveryCount,
				sliceCount: jobs.reduce((total, job) => total + job.sliceCount, 0),
				failureCount: jobs.reduce((total, job) => total + job.failureCount, 0),
				totalFailureCount,
				recoveryCount,
				failureRate: deliveryCount > 0 ? totalFailureCount / deliveryCount : null,
				recoveryRate: deliveryCount > 0 ? recoveryCount / deliveryCount : null,
			},
			runtime: {
				latencyMs: durations.length > 0 ? durations.reduce((total, duration) => total + duration, 0) : null,
				usage,
				costUsd: null,
				costStatus: "unconfigured",
				toolExecutionCount,
				toolFailureCount,
				toolFailureRate: toolExecutionCount > 0 ? toolFailureCount / toolExecutionCount : null,
			},
		};
	}

	private readCheckpointMetrics(
		state: ProposalRunState,
		artifactVersion: number,
	): {
		inspections?: AssetInspectionRecord[];
		runtimeDurationMs?: number;
		usage?: RuntimeUsage;
		rawCandidateFactCount?: number;
		canonicalCandidateFactCount?: number;
		toolExecutionCount?: number;
		toolFailureCount?: number;
	} | undefined {
		let value: unknown;
		try {
			value = this.requirementArtifacts.readJson({
				...state,
				artifactId: "requirement-runtime-checkpoint",
				artifactVersion,
			});
		} catch (error) {
			if (error instanceof ArtifactStoreError && error.code === "artifact_not_found") return undefined;
			throw error;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		return value as {
			inspections?: AssetInspectionRecord[];
			runtimeDurationMs?: number;
			usage?: RuntimeUsage;
			rawCandidateFactCount?: number;
			canonicalCandidateFactCount?: number;
			toolExecutionCount?: number;
			toolFailureCount?: number;
		};
	}

	private readArtifactMetrics(
		state: ProposalRunState,
		artifactVersion: number,
	): { facts: number; sourcedFacts: number; missingRequiredFacts: number } {
		const value = this.requirementArtifacts.readJson({
			...state,
			artifactId: "requirement-brief",
			artifactVersion,
		});
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { facts: 0, sourcedFacts: 0, missingRequiredFacts: 0 };
		}
		const record = value as { facts?: unknown; missingRequiredFacts?: unknown };
		const facts = Array.isArray(record.facts) ? record.facts : [];
		return {
			facts: facts.length,
			sourcedFacts: facts.filter((fact) =>
				Boolean(fact) && typeof fact === "object" && !Array.isArray(fact) &&
				typeof (fact as { sourceRef?: unknown }).sourceRef === "string" &&
				Boolean((fact as { sourceRef: string }).sourceRef.trim()),
			).length,
			missingRequiredFacts: Array.isArray(record.missingRequiredFacts)
				? record.missingRequiredFacts.length
				: 0,
		};
	}

	private summarize(points: RequirementBriefRunMetricsPoint[]): RequirementBriefMetricsSeriesView {
		const average = (values: number[]) => values.length > 0
			? values.reduce((total, value) => total + value, 0) / values.length
			: null;
		const evaluated = points.filter((point) => point.evaluationPassed !== null);
		const usages = points.flatMap((point) => point.metrics.runtime.usage ? [point.metrics.runtime.usage] : []);
		const usage = usages.length > 0
			? usages.reduce<RuntimeUsage>((total, current) => ({
				inputTokens: total.inputTokens + current.inputTokens,
				cachedInputTokens: total.cachedInputTokens + current.cachedInputTokens,
				outputTokens: total.outputTokens + current.outputTokens,
				reasoningOutputTokens: total.reasoningOutputTokens + current.reasoningOutputTokens,
			}), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 })
			: null;
		return {
			schemaVersion: "requirement-brief-metrics-series.v1",
			generatedAt: this.now(),
			points,
			totals: {
				runs: points.length,
				passed: points.filter((point) => point.stageStatus === "passed").length,
				needsInput: points.filter((point) => point.stageStatus === "needs_input").length,
				waitingApproval: points.filter((point) => point.stageStatus === "waiting_approval").length,
				cancelled: points.filter((point) => point.stageStatus === "cancelled").length,
				active: points.filter((point) => ["pending", "running", "evaluating", "revision_required", "retryable_failed"].includes(point.stageStatus)).length,
				artifactVersions: points.reduce((total, point) => total + point.metrics.artifactVersions, 0),
				clarificationRounds: points.reduce((total, point) => total + point.metrics.clarificationRounds, 0),
				clarificationQuestions: points.reduce((total, point) => total + point.metrics.clarificationQuestions, 0),
			},
			rates: {
				workflowCompletion: points.length > 0
					? points.filter((point) => ["needs_input", "waiting_approval", "passed"].includes(point.stageStatus)).length / points.length
					: null,
				evaluationPass: evaluated.length > 0
					? evaluated.filter((point) => point.evaluationPassed).length / evaluated.length
					: null,
				approvalEligibility: points.length > 0
					? points.filter((point) => point.approvalEligible).length / points.length
					: null,
				stagePass: points.length > 0
					? points.filter((point) => point.stageStatus === "passed").length / points.length
					: null,
			},
			averages: {
				canonicalFactHitRate: average(points.flatMap((point) =>
					point.metrics.canonicalFactHitRate === null ? [] : [point.metrics.canonicalFactHitRate],
				)),
				confirmedCandidateAccuracy: average(points.flatMap((point) =>
					point.metrics.confirmedCandidateAccuracy === null ? [] : [point.metrics.confirmedCandidateAccuracy],
				)),
				sourceCoverageRate: average(points.flatMap((point) =>
					point.metrics.sourceCoverageRate === null ? [] : [point.metrics.sourceCoverageRate],
				)),
				confirmationRate: average(points.map((point) => point.metrics.confirmationRate)),
				runtimeLatencyMs: average(points.flatMap((point) =>
					point.metrics.runtime.latencyMs === null ? [] : [point.metrics.runtime.latencyMs],
				)),
			},
			queue: (() => {
				const deliveries = points.reduce((total, point) => total + point.metrics.queue.deliveryCount, 0);
				const failures = points.reduce((total, point) => total + point.metrics.queue.totalFailureCount, 0);
				const recoveries = points.reduce((total, point) => total + point.metrics.queue.recoveryCount, 0);
				return {
					deliveries,
					slices: points.reduce((total, point) => total + point.metrics.queue.sliceCount, 0),
					failures,
					recoveries,
					failureRate: deliveries > 0 ? failures / deliveries : null,
					recoveryRate: deliveries > 0 ? recoveries / deliveries : null,
				};
			})(),
			runtime: {
				usage,
				toolExecutions: points.reduce((total, point) => total + point.metrics.runtime.toolExecutionCount, 0),
				toolFailures: points.reduce((total, point) => total + point.metrics.runtime.toolFailureCount, 0),
				toolFailureRate: (() => {
					const executions = points.reduce((total, point) => total + point.metrics.runtime.toolExecutionCount, 0);
					const failures = points.reduce((total, point) => total + point.metrics.runtime.toolFailureCount, 0);
					return executions > 0 ? failures / executions : null;
				})(),
				costUsd: null,
				costStatus: "unconfigured",
			},
		};
	}
}
