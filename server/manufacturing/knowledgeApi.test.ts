import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { knowledgeWorkflow } from "../eval/knowledgeWorkflow";
import type { RequirementBriefWorkspaceView } from "../../src/runtime/conversationContracts";
import { requiredRequirementFacts } from "../../src/manufacturing/requirementBrief";
import { deliveryMarkdown, type RequirementDelivery } from "../../src/manufacturing/requirementDelivery";
import type { PlanWorkspace } from "../../src/enterprise/agentPlan";

it("runs selected evidence through real tools/context, human confirmation, approval and withdrawal", async () => {
	const root = mkdtempSync(join(tmpdir(), "packx-knowledge-flow-")); const h = knowledgeWorkflow(root);
	const view = () => (h.requirements.get(h.context, h.conversationId).body as { requirementBrief: RequirementBriefWorkspaceView }).requirementBrief;
	try {
		expect((await h.api.handle(h.context, h.conversationId, "demo")).status).toBe(202);
		await h.scheduler.runNext(); await h.scheduler.runNext();
		const result = await h.store.search(h.context, { query: "thickness", mode: "hybrid", model: "DEMO-PE-A", region: "HK", asOf: "2026-09-17T10:00:00.000Z" });
		expect(result).toMatchObject({ retrievalVersion: "packaging-fields.v1", assessment: { status: "source_values_available", conclusionAllowed: false } });
		const hit = result.hits[0]; expect(hit.location.page).toBe(2);
		const selected = await h.api.handle(h.context, h.conversationId, "select", { ids: [hit.evidenceId], applicability: { region: "HK", asOf: "2026-09-17T10:00:00.000Z" }, requestId: "select", expectedVersion: 0 });
		expect(selected.status).toBe(200);
		expect(h.requirements.start(h.context, h.conversationId, { requestId: "start", industry: "print" }).status).toBe(202);
		expect(await h.scheduler.runNext()).toMatchObject({ status: "completed" });
		expect(view().state.facts.material_thickness).toMatchObject({ status: "unverified", value: "0.1", sourceRef: hit.evidenceId });
		expect(view().state.facts.dimensions).toBeUndefined();
		expect(view().metrics.runtime.toolExecutionCount).toBeGreaterThanOrEqual(4);
		expect((await h.api.handle({ ...h.context, tenantId: "other" }, h.conversationId, "view")).status).toBe(404);
		for (const key of requiredRequirementFacts.print) {
			expect(h.requirements.recordFact(h.context, h.conversationId, { requestId: `set-${key}`, key, value: key === "quantity" ? 5000 : `synthetic-confirmed-${key}` }).status).toBe(200);
			expect(h.requirements.resolveFact(h.context, h.conversationId, key, { requestId: `confirm-${key}`, decision: "verified", expectedFactVersion: view().state.facts[key].version, expectedAggregateVersion: view().state.aggregateVersion }).status).toBe(200);
		}
		expect(h.requirements.resolveFact(h.context, h.conversationId, "material_thickness", { requestId: "confirm-thickness", decision: "verified", expectedFactVersion: view().state.facts.material_thickness.version, expectedAggregateVersion: view().state.aggregateVersion }).status).toBe(200);
		expect(h.requirements.start(h.context, h.conversationId, { requestId: "regenerate", industry: "print" }).status).toBe(202);
		expect(await h.scheduler.runNext()).toMatchObject({ status: "completed" });
		expect(view().state.stageStatus).toBe("waiting_approval");
		expect(h.requirements.resolveApproval(h.context, h.conversationId, { requestId: "approve", decision: "approved" }).status).toBe(202);
		await h.scheduler.runNext(); expect(view().state.stageStatus).toBe("passed");
		const delivery = h.requirements.delivery(h.context, h.conversationId, 2);
		expect(delivery.status).toBe(200);
		const content = (delivery.body as { delivery: RequirementDelivery }).delivery;
		expect(content.citations.material_thickness).toBe(hit.evidenceId);
		expect(deliveryMarkdown(content)).toContain(hit.evidenceId);
		expect(content.knowledgeEvidence?.[0].location.table).toBe("T1");
		expect((await h.api.handle(h.context, h.conversationId, "withdraw", { versionId: hit.versionId })).status).toBe(200);
		expect(view().state).toMatchObject({ currentProposal: { freshness: "stale" }, approval: { status: "superseded" }, stageStatus: "revision_required" });
		expect(h.requirements.delivery(h.context, h.conversationId, 2).status).toBe(409);
		expect(h.requirements.resolveApproval(h.context, h.conversationId, { requestId: "approve-revoked", decision: "approved" }).status).toBe(409);
		await h.api.handle(h.context, h.conversationId, "select", { ids: [], applicability: { region: "HK", asOf: "2026-09-17T10:00:00.000Z" }, requestId: "clear-revoked", expectedVersion: 1 });
		expect(h.requirements.start(h.context, h.conversationId, { requestId: "launder-confirmed-fact", industry: "print" })).toMatchObject({ status: 400, body: { code: "evidence_fact_requires_review" } });
		expect(h.requirements.recordFact(h.context, h.conversationId, { requestId: "independent-human-source", key: "material_thickness", value: "0.1", unit: "mm" }).status).toBe(200);
		expect(h.requirements.start(h.context, h.conversationId, { requestId: "reviewed-source", industry: "print" }).status).toBe(202);
		expect(await h.scheduler.runNext()).toMatchObject({ status: "completed" });
		const revised = h.requirements.delivery(h.context, h.conversationId, 3);
		expect(revised.status).toBe(200);
		expect((revised.body as { delivery: RequirementDelivery }).delivery.citations.material_thickness).toContain("fact-form:independent-human-source");
		expect(h.requirements.delivery(h.context, h.conversationId, 2).status).toBe(409);
	} finally { h.store.close(); rmSync(root, { recursive: true, force: true }); }
});

it("binds the Plan handoff to the selected evidence snapshot and rejects changed selections", async () => {
	const root = mkdtempSync(join(tmpdir(), "packx-knowledge-plan-"));
	let plan!: PlanWorkspace; const h = knowledgeWorkflow(root, () => plan);
	try {
		await h.api.handle(h.context, h.conversationId, "demo"); await h.scheduler.runNext(); await h.scheduler.runNext();
		const found = await h.store.search(h.context, { query: "thickness", mode: "keyword", model: "DEMO-PE-A" });
		await h.api.handle(h.context, h.conversationId, "select", { ids: [found.hits[0].evidenceId], applicability: { region: "HK", asOf: "2026-09-17T10:00:00.000Z" }, requestId: "plan-selection", expectedVersion: 0 });
		const selection = h.store.selection({ ...h.context, runId: h.conversationId })!;
		plan = { revision: 4, mode: "plan", versions: [{ version: 1, objective: "核对咖啡袋证据", context: JSON.stringify({ messages: [], attachments: [], knowledge: selection }), conversationRevision: h.sessions.getSession({ ...h.context, runId: h.conversationId, sessionId: h.conversationId })!.revision, status: "completed", createdAt: "2026-09-17T10:00:00.000Z", actorId: h.context.actorId, generation: 1, calls: 2, spec: { summary: "核对已选资料", tasks: [{ title: "读取证据", objective: "保留来源", tools: ["knowledge_selected"] }] }, approval: { actorId: h.context.actorId, version: 1, at: "2026-09-17T10:00:00.000Z" }, children: [{ taskIndex: 0, sessionId: "child", executionId: "execution", result: { summary: "厚度待人工确认", evidence: [found.hits[0].evidenceId], limitations: ["合成资料"] } }] }] };
		expect(h.requirements.start(h.context, h.conversationId, { requestId: "plan-import", industry: "print", planVersion: 1 }).status).toBe(202);
		expect(await h.scheduler.runNext()).toMatchObject({ status: "completed" });
		const view = (h.requirements.get(h.context, h.conversationId).body as { requirementBrief: RequirementBriefWorkspaceView }).requirementBrief;
		expect(JSON.parse(String(view.state.facts.customer_brief.value)).originalContext.knowledge.digest).toBe(selection.digest);
		expect(view.state.facts.plan_source.status).toBe("unverified");
		await h.api.handle(h.context, h.conversationId, "select", { ids: [], applicability: selection.applicability, requestId: "different-selection", expectedVersion: 1 });
		expect(h.requirements.start(h.context, h.conversationId, { requestId: "stale-plan", industry: "print", planVersion: 1 })).toMatchObject({ status: 400, body: { code: "evidence_fact_requires_review" } });
		expect(h.requirements.recordFact(h.context, h.conversationId, { requestId: "manual-review", key: "material_thickness", value: "awaiting supplier confirmation" }).status).toBe(200);
		expect(h.requirements.start(h.context, h.conversationId, { requestId: "changed-plan-evidence", industry: "print", planVersion: 1 })).toMatchObject({ status: 400, body: { code: "plan_evidence_stale" } });
	} finally { h.store.close(); rmSync(root, { recursive: true, force: true }); }
});

it("imports licensed research through the durable queue and refuses to convert research layers to order facts", async () => {
	const root = mkdtempSync(join(tmpdir(), "packx-research-flow-")); const h = knowledgeWorkflow(root);
	try {
		expect((await h.api.handle(h.context, h.conversationId, "open-research")).status).toBe(202);
		for (let i = 0; i < 5; i++) expect(await h.scheduler.runNext()).toMatchObject({ status: "completed" });
		const doc = h.store.list(h.context).find((d) => d.manifest.documentId === "PMC11243642")!;
		const id = `${doc.versionId}:37`;
		const hit = h.store.readEvidence(h.context, id); expect(hit.parameters[2].authority).toBe("research_report");
		expect((await h.api.handle(h.context, h.conversationId, "select", { ids: [id], applicability: { region: "unknown", asOf: "2026-09-17T10:00:00.000Z" }, requestId: "select-research", expectedVersion: 0 })).status).toBe(200);
		expect(h.requirements.start(h.context, h.conversationId, { requestId: "research-start", industry: "print" }).status).toBe(202);
		expect(await h.scheduler.runNext()).toMatchObject({ status: "completed" });
		const view = (h.requirements.get(h.context, h.conversationId).body as { requirementBrief: RequirementBriefWorkspaceView }).requirementBrief;
		expect(view.state.facts.material_thickness).toBeUndefined();
		expect(view.state.facts.knowledge_source).toBeDefined();
		expect((await h.api.handle(h.context, h.conversationId, "candidate", { evidenceId: id, parameter: "thickness", requestId: "promote-research" }))).toMatchObject({ status: 409, body: { code: "sample_or_ambiguous_parameter_requires_supplier_confirmation" } });
	} finally { h.store.close(); rmSync(root, { recursive: true, force: true }); }
});
