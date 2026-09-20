import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { knowledgeWorkflow } from "../server/eval/knowledgeWorkflow";
import type { RequirementBriefWorkspaceView } from "../src/runtime/conversationContracts";

const directory = mkdtempSync(join(tmpdir(), "packx-coffee-demo-")); const h = knowledgeWorkflow(directory);
try {
	await h.api.handle(h.context, h.conversationId, "demo"); await h.scheduler.runNext(); await h.scheduler.runNext();
	const found = await h.store.search(h.context, { query: "thickness OTR", mode: "hybrid", model: "DEMO-PE-A", region: "HK" });
	const hit = found.hits[0];
	assert.equal((await h.api.handle(h.context, h.conversationId, "select", { ids: [hit.evidenceId], applicability: { region: "HK", asOf: "2026-09-17T10:00:00.000Z" }, requestId: "select-demo", expectedVersion: 0 })).status, 200);
	assert.equal(h.requirements.start(h.context, h.conversationId, { requestId: "demo-brief", industry: "print" }).status, 202);
	assert.equal((await h.scheduler.runNext()).status, "completed");
	const brief = (h.requirements.get(h.context, h.conversationId).body as { requirementBrief: RequirementBriefWorkspaceView }).requirementBrief;
	assert.equal(brief.state.facts.material_thickness.status, "unverified"); assert.equal(brief.state.facts.dimensions, undefined);
	console.log(JSON.stringify({ demo: "synthetic coffee evidence -> real Tool/ContextEngine -> Requirement Brief", source: { publisher: hit.publisher, model: hit.model, revision: hit.revision, location: hit.location }, fact: brief.state.facts.material_thickness, missing: brief.metrics.missingRequiredFacts, sourceSnapshot: brief.state.facts.knowledge_source.sourceRef, fabricatedDimensionRejected: true, paidModelCalls: 0, caveat: "Scripted Provider validates integration only; no real supplier data or model-quality claim." }, null, 2));
} finally { h.store.close(); rmSync(directory, { recursive: true, force: true }); }
