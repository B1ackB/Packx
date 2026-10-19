import type { SourceReportArtifact, SourceReportBinding } from "../../src/enterprise/sourceReport";
import type { PlanWorkspace } from "../../src/enterprise/agentPlan";
import type { ConversationView } from "../../src/runtime/conversationContracts";
import type { ArtifactWorkspaceStartFact } from "../enterprise/proposalWorkspaceApi";
import { ProposalWorkspaceValidationError } from "../enterprise/proposalWorkspaceApi";

export function planRequirementSource(state: PlanWorkspace, version: unknown, conversation: ConversationView, attachments: unknown[], selectedReport?: { binding: SourceReportBinding; report: SourceReportArtifact }) {
	const plan = state.versions.at(-1);
	if (!Number.isSafeInteger(version) || !plan || plan.version !== version || plan.status !== "completed" || plan.approval?.version !== version || !plan.spec || plan.children.length !== plan.spec.tasks.length) {
		throw new ProposalWorkspaceValidationError("请选择已完成的最新计划版本，再导入需求单。", "plan_source_not_ready");
	}
	if (conversation.revision !== plan.conversationRevision || JSON.stringify(JSON.parse(plan.context).attachments) !== JSON.stringify(attachments)) {
		throw new ProposalWorkspaceValidationError("会话或附件已变化，请重新规划后导入需求单。", "plan_source_stale");
	}
	const frozenReport = JSON.parse(plan.context).sourceReport;
	if (frozenReport?.status === "selected" && (!selectedReport || selectedReport.binding.status !== "selected" || !selectedReport.binding.available ||
		JSON.stringify(selectedReport.binding) !== JSON.stringify(frozenReport) || selectedReport.report.version !== frozenReport.version || selectedReport.report.status !== "unverified")) {
		throw new ProposalWorkspaceValidationError("报告来源已变化或不可用，请重新规划并核对来源。", "report_source_stale");
	}
	const sourceRef = `plan:${conversation.conversationId}:version:${plan.version}`;
	const brief = JSON.stringify({
		schemaVersion: "plan-requirement-source.v1", sourceRef,
		status: "unverified", objective: plan.objective, originalContext: JSON.parse(plan.context),
		plan: plan.spec, confirmation: plan.approval, results: plan.children,
		...(frozenReport?.status === "selected" ? { sourceReport: selectedReport!.report } : {}),
	});
	if (brief.length > 32_000) throw new ProposalWorkspaceValidationError("计划资料超过需求单输入上限，请拆分为较小任务。", "plan_source_too_large");
	const source: ArtifactWorkspaceStartFact = { key: "plan_source", value: sourceRef, status: "unverified", sourceType: "model_output", sourceRef };
	return { brief, source, ...(frozenReport?.status === "selected" ? { reportSource: { key: "report_source", value: JSON.stringify(selectedReport!.binding), status: "unverified" as const, sourceType: "source_document" as const, sourceRef: selectedReport!.binding.status === "selected" ? selectedReport!.binding.artifactRef : "" } } : {}) };
}
