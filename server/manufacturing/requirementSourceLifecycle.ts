import { createHash } from "node:crypto";
import type { AggregateScope, ProposalRunState } from "../../src/enterprise/contracts";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { factSourceReference } from "../knowledge/service";
import { FileConversationAttachmentStore, type ConversationAttachmentScope } from "../runtime/conversationAttachments";

export function requirementAttachmentSnapshotChanged(state: ProposalRunState, attachments: FileConversationAttachmentStore, scope: ConversationAttachmentScope) {
	return state.facts.customer_attachments?.value !== attachments.digest(scope);
}

/** A new upload invalidates review too, including the first attachment after a text-only brief. */
export function reconcileRequirementAttachments(engine: ProposalRunEngine, attachments: FileConversationAttachmentStore, scope: AggregateScope & ConversationAttachmentScope) {
	const state = engine.load(scope);
	if (state.currentProposal?.freshness === "fresh" && requirementAttachmentSnapshotChanged(state, attachments, scope)) {
		engine.invalidateSource({ ...scope, actorId: "source-reconciliation", commandId: `attachment-snapshot-stale-${state.currentProposal.version}-${state.aggregateVersion}`,
			correlationId: "source-reconciliation", expectedVersion: state.aggregateVersion, reason: "附件来源已变化；原交付物和审批需要重新核对。" });
	}
	// Keep the old snapshot until an explicit new intake. Uploads never confirm or replace Facts.
	return reconcileRequirementWithdrawals(engine, attachments, scope);
}

/** Reconcile only persisted, explicit employee withdrawals. Never infer a withdrawal from model text. */
export function reconcileRequirementWithdrawals(engine: ProposalRunEngine, attachments: FileConversationAttachmentStore, scope: AggregateScope & ConversationAttachmentScope) {
	const withdrawn = attachments.list(scope, { includeWithdrawn: true }).filter((attachment) => attachment.withdrawal).sort((a, b) => a.withdrawal!.at.localeCompare(b.withdrawal!.at));
	let state = engine.load(scope);
	if (!withdrawn.length || !state.aggregateVersion) return state;
	const events = engine.readEvents(scope);
	const affected = Object.values(state.facts).filter((fact) => {
		if (fact.status === "rejected") return false;
		const source = factSourceReference(events, fact.key, fact.version);
		// Legacy extraction versions kept only runtime IDs. Their source is ambiguous, so withdrawal conservatively requires employee reconfirmation.
		return source?.startsWith("runtime:") || withdrawn.some((attachment) => source === attachment.sourceRef || source?.startsWith(`${attachment.sourceRef}#`));
	});
	const digest = attachments.digest(scope)!;
	// A tombstone is the durable intent. Repeating this after a crash neither restores the source nor repeats a model call.
	if (state.facts.customer_attachments?.value === digest && affected.length === 0) return state;
	const withdrawal = withdrawn.at(-1)!.withdrawal!;
	const prefix = `source-withdrawal-${createHash("sha256").update(JSON.stringify(withdrawn.map((a) => [a.attachmentId, a.withdrawal]))).digest("hex").slice(0, 24)}`;
	const command = (suffix: string) => ({ ...scope, actorId: withdrawal.actorId, commandId: `${prefix}:${suffix}`, correlationId: prefix, expectedVersion: engine.load(scope).aggregateVersion });
	state = engine.invalidateSource({ ...command(`artifact-${state.currentProposal?.version ?? 0}`), reason: "员工撤回来源；相关字段、交付物和审批需要重新核对。" });
	// An executing Worker observes the changed attachment digest and must stop before writing.
	if (state.stageStatus === "running" && state.lastJobId || state.stageStatus === "evaluating" || state.stageStatus === "cancelled") return state;
	for (const fact of affected) {
		if (engine.hasCommand(scope, `${prefix}:fact-${fact.key}-${fact.version}`)) continue;
		engine.recordFactVersion({ ...command(`fact-${fact.key}-${fact.version}`), factKey: fact.key, factVersion: fact.version + 1,
			value: fact.value, unit: fact.unit, status: "rejected", sourceType: "human_confirmation", sourceRef: fact.sourceRef });
	}
	state = engine.load(scope);
	if (state.facts.customer_attachments?.value !== digest) {
		state = engine.recordFactVersion({ ...command(`attachments-${state.factVersions.customer_attachments ?? 0}`), factKey: "customer_attachments", factVersion: (state.factVersions.customer_attachments ?? 0) + 1,
			value: digest, status: "unverified", sourceType: "source_document", sourceRef: `conversation:${scope.conversationId}:attachments:${digest}` });
	}
	return state;
}
