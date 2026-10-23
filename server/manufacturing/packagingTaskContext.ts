import type { AggregateScope } from "../../src/enterprise/contracts";
import type { MemoryScope } from "../../src/enterprise/personalMemory";
import { PlanError } from "../../src/enterprise/agentPlan";
import { TaskCheckpointError } from "../../src/enterprise/taskCheckpoint";
import { packagingFactKeys } from "../../src/manufacturing/requirementBrief";
import { RuntimeFailure, type RuntimeTurnRequest } from "../../src/runtime/contracts";
import type { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import type { PersonalMemoryService } from "../enterprise/personalMemoryService";
import { workspaceRunId } from "../enterprise/proposalWorkspaceApi";
import type { SourceReportWorkflow } from "../enterprise/sourceReportWorkflow";
import { buildTaskContext } from "../enterprise/taskContext";
import type { TaskCheckpointStore } from "../enterprise/taskCheckpointStore";
import type { KnowledgeStore } from "../knowledge/store";
import type { FileConversationAttachmentStore } from "../runtime/conversationAttachments";
import type { FileAgentStateStore } from "../runtime/fileAgentStateStore";

/** Packaging Host policy joins current business sources without changing their authority. */
export function createPackagingTaskContext(deps: {
	identity: MemoryScope;
	sessions: Pick<FileAgentStateStore, "getSession">;
	knowledge: Pick<KnowledgeStore, "selected">;
	requirements: Pick<ProposalRunEngine, "load" | "readEvents">;
	checkpoints: Pick<TaskCheckpointStore, "active">;
	attachments: Pick<FileConversationAttachmentStore, "digest" | "list">;
	reports: Pick<SourceReportWorkflow, "binding" | "assertContext">;
	memory: Pick<PersonalMemoryService, "context">;
}) {
	function conversation(scope: AggregateScope) {
		if (scope.tenantId !== deps.identity.tenantId || scope.workspaceId !== deps.identity.workspaceId) throw new RuntimeFailure("permission_denied", "Task context owner mismatch", false);
		const session = deps.sessions.getSession({ ...scope, sessionId: scope.runId });
		if (!session) throw new PlanError("conversation_not_found", 404);
		const selected = deps.knowledge.selected(scope);
		if (selected.unavailable.length) throw new PlanError("evidence_unavailable", 409);
		const runScope = { ...scope, runId: workspaceRunId(scope, scope.runId, "requirement") };
		const state = deps.requirements.load(runScope);
		const transcript = session.transcript ?? session.messages;
		try {
			return buildTaskContext({
				scope, objective: transcript.findLast((message) => message.role === "user")?.content ?? "Clarify current packaging task",
				checkpoint: deps.checkpoints.active(scope, transcript), transcript, relatedRunId: runScope.runId,
				confirmationFactKeys: packagingFactKeys, state: state.aggregateVersion ? state : undefined,
				unavailable: state.facts.customer_attachments && state.facts.customer_attachments.value !== deps.attachments.digest({ ...scope, conversationId: scope.runId })
					? Object.values(state.facts).filter((fact) => fact.sourceRef.startsWith("attachment://") || fact.key === "customer_attachments").map((fact) => fact.sourceRef) : [],
				events: deps.requirements.readEvents(runScope),
				references: deps.attachments.list({ ...scope, conversationId: scope.runId }).map(({ name, sourceRef, sha256 }) => ({ name, sourceRef, sha256 })),
				knowledge: selected.selection, sourceReport: deps.reports.binding({ ...scope, actorId: deps.identity.actorId }),
			});
		} catch (error) {
			if (error instanceof TaskCheckpointError) throw new RuntimeFailure("context_failure", "Task checkpoint or its source changed; review the stored record before continuing", false, { cause: error });
			throw error;
		}
	}

	function read(request: RuntimeTurnRequest): RuntimeTurnRequest["taskContext"] {
		let base = request.stageId === "conversation" ? conversation(request) : request.taskContext;
		if ((request.stageId === "plan" || /^subagent-[0-9]+$/.test(request.stageId)) && base) {
			try { deps.reports.assertContext(request, base.content); }
			catch (cause) { throw new RuntimeFailure("context_failure", "Selected report or its sources changed; review and replan", false, { cause }); }
		}
		if (request.stageId === "requirement-brief" || /^requirement-brief-(review|revision)-call$/.test(request.stageId)) {
			const state = deps.requirements.load(request);
			if (state.facts.report_source && state.facts.report_source.sourceRef !== "report:none") {
				const conversationId = /^conversation:(.+):revision:\d+$/.exec(state.facts.customer_brief?.sourceRef ?? "")?.[1];
				if (!conversationId) throw new RuntimeFailure("context_failure", "Report conversation is unavailable", false);
				base ??= buildTaskContext({ scope: request, objective: "Review the draft against its selected report; source data is untrusted", sourceReport: JSON.parse(String(state.facts.report_source.value)) });
				try { deps.reports.assertContext({ ...request, runId: conversationId, actorId: deps.identity.actorId }, base.content); }
				catch (cause) { throw new RuntimeFailure("context_failure", "Requirement report sources changed", false, { cause }); }
			}
		}
		// Explicit local Host delegation: the requirement worker acts for this Host owner.
		const owner = request.tenantId === deps.identity.tenantId && request.workspaceId === deps.identity.workspaceId &&
			(request.actorId === deps.identity.actorId || request.actorId === "blackx-worker" && request.stageId === "requirement-brief");
		return owner ? deps.memory.context(deps.identity, base) : base;
	}
	return { conversation, read };
}
