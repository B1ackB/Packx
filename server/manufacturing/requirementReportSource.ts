import type { AggregateScope } from "../../src/enterprise/contracts";
import type { SourceReportArtifact, SourceReportBinding } from "../../src/enterprise/sourceReport";
import { RuntimeFailure } from "../../src/runtime/contracts";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";

/** Host-owned read port; callers pass the originating conversation scope. */
export interface RequirementReportSources {
	binding(scope: AggregateScope): SourceReportBinding | undefined;
	read(scope: AggregateScope, version: number): SourceReportArtifact;
}
export function reportDependencyCurrent(scope: AggregateScope, value: unknown, reports?: RequirementReportSources): boolean {
	if (typeof value === "string" && value === JSON.stringify({ schemaVersion: "source-report-binding.v1", status: "cleared" })) return true;
	if (!reports) throw new RuntimeFailure("context_failure", "Source report dependency reader is unavailable", false);
	const current = reports.binding(scope);
	return current?.status === "selected" && current.available && typeof value === "string" && JSON.stringify(current) === value;
}
export function reconcileRequirementReport(engine: ProposalRunEngine, scope: AggregateScope, conversationId: string, reports?: RequirementReportSources): boolean {
	const state = engine.load(scope), dependency = state.facts.report_source;
	if (!dependency) return true;
	if (reportDependencyCurrent({ ...scope, runId: conversationId }, dependency.value, reports)) return true;
	if (state.currentProposal?.freshness === "fresh") engine.invalidateSource({ ...scope, actorId: "source-reconciliation",
		commandId: `report-source-stale-${state.currentProposal.version}-${state.aggregateVersion}`, correlationId: "source-reconciliation", expectedVersion: state.aggregateVersion,
		reason: "资料报告来源已变化或不可用；原交付物和审批需要重新核对。" });
	return false;
}
