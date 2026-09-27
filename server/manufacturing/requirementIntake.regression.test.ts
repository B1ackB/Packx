import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { createRequirementBrief, type RequirementBriefV1, type RequirementFactV1, type RequirementBriefEvaluation } from "../../src/manufacturing/requirementBrief";
import { requirementBriefFixtures } from "../../src/manufacturing/requirementBrief.fixtures";
import { manufacturingSkills } from "../../src/manufacturing/skills";
import { optionalPackagingFacts } from "../../src/manufacturing/requirementBrief";
import type { AgentRuntimePort, RuntimeTurnRequest } from "../../src/runtime/contracts";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { FileConversationAttachmentStore } from "../runtime/conversationAttachments";
import { RequirementBriefWorker, parseRequirementCandidate } from "./requirementBriefWorker";
import { reconcileRequirementWithdrawals } from "./requirementSourceLifecycle";
import { requirementEvidencePolicy } from "./requirementEvidencePolicy";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const fact = (key: string, value: string | number, unit?: string): RequirementFactV1 => ({ key, value, ...(unit ? { unit } : {}), version: 1, status: "unverified", sourceType: "model_output", sourceRef: "message-1" });
function harness() {
	const directory = mkdtempSync(join(tmpdir(), "intake-regression-")); directories.push(directory);
	const scope = { tenantId: "tenant", workspaceId: "workspace", runId: "run", conversationId: "conversation" };
	const engine = new ProposalRunEngine(new InMemoryEnterpriseEventStore(), "requirement-brief");
	const artifacts = new FileArtifactContentStore(join(directory, "artifacts"));
	const attachments = new FileConversationAttachmentStore(join(directory, "attachments"));
	const source = attachments.put(scope, { requestId: "spec", name: "spec.txt", mediaType: "text/plain", content: Buffer.from("外尺寸 212 × 162 × 92 mm；厚度 0.06 mm") }).attachment;
	let sequence = 0;
	const command = () => ({ ...scope, actorId: "employee", commandId: `command-${++sequence}`, correlationId: "test", expectedVersion: engine.load(scope).aggregateVersion });
	engine.create(command()); engine.startProposal(command());
	const record = (value: Omit<RequirementFactV1, "version">) => engine.recordFactVersion({ ...command(), factKey: value.key, factVersion: (engine.load(scope).factVersions[value.key] ?? 0) + 1, ...value });
	record({ key: "industry", value: "print", status: "verified", sourceType: "enterprise_source", sourceRef: "domain:print" });
	record({ key: "customer_brief", value: JSON.stringify({ messages: [{ sourceRef: "message-1", content: "先记录数量，尺寸待澄清；材料厚度 0.06 mm。" }] }), status: "unverified", sourceType: "user_input", sourceRef: "conversation:conversation:revision:1" });
	record({ key: "customer_attachments", value: attachments.digest(scope)!, status: "unverified", sourceType: "source_document", sourceRef: "conversation:conversation:attachments" });
	const requests: RuntimeTurnRequest[] = [];
	let candidate = createRequirementBrief({ industry: "print", title: "需求单", customerGoal: "核对本订单", facts: [] });
	let onIntake = () => {};
	const runtime: AgentRuntimePort = { health: async () => ({ adapter: "fake", online: true }), async executeTurn(request) {
		requests.push(request);
		if (request.stageId === "requirement-brief") onIntake();
		return { adapter: "fake", status: "completed", executionId: `execution-${requests.length}`, contextSnapshotId: `snapshot-${requests.length}`, finalResponse: JSON.stringify(request.stageId === "requirement-brief" ? candidate : { issues: [] }), events: [] };
	} };
	const read = () => artifacts.readJson({ ...scope, artifactId: "requirement-brief", artifactVersion: engine.load(scope).currentProposal!.version }) as RequirementBriefV1;
	const evaluation = () => artifacts.readJson({ ...scope, artifactId: "requirement-brief-evaluation", artifactVersion: engine.load(scope).currentProposal!.version }) as RequirementBriefEvaluation;
	return { scope, engine, attachments, source, requests, record, command, read, evaluation,
		async run(facts: RequirementFactV1[], missing?: string[], callback?: () => void) {
			candidate = createRequirementBrief({ industry: "print", title: "需求单", customerGoal: "核对本订单", facts });
			if (missing) candidate.missingRequiredFacts = missing;
			onIntake = callback ?? (() => {});
			return new RequirementBriefWorker(engine, runtime, artifacts, attachments).execute(command());
		},
	};
}

it("uses the schema field list in the Skill and persists supported optional values with their exact evidence", async () => {
	for (const key of optionalPackagingFacts) expect(manufacturingSkills[0].instructions).toContain(key);
	const h = harness();
	await h.run([{ ...fact("material_thickness", 0.06, "mm"), sourceRef: h.source.sourceRef, status: "verified" }]);
	expect(h.read().facts).toContainEqual(expect.objectContaining({ key: "material_thickness", value: 0.06, unit: "mm", status: "unverified", sourceRef: h.source.sourceRef }));
	expect(h.read().missingRequiredFacts).not.toContain("material_thickness");
	const evidence = JSON.parse(h.requests[1].input).evidence;
	expect(evidence).toContainEqual(expect.objectContaining({ ref: h.source.sourceRef, content: expect.objectContaining({ content: expect.stringContaining("0.06 mm") }) }));
});

it("restores required clarification after a permitted narrative revision without changing Facts", () => {
	const original = createRequirementBrief({ industry: "print", title: "需求单", customerGoal: "核对本订单", facts: [fact("quantity", 500)], assumptions: ["不得使用 PVC"] });
	const revised = requirementEvidencePolicy.applyRevision(original, JSON.stringify({ title: original.title, customerGoal: original.customerGoal, assumptions: ["不得使用 PVC"] }), [{ kind: "unsupported", location: "/assumptions", evidenceRefs: ["message-1"], reason: "移除无关叙述", suggestedAction: "revise" }]) as RequirementBriefV1;
	expect(revised.facts).toEqual(original.facts);
	expect(revised.assumptions.join()).toContain("宽、高、底折");
	expect(revised.assumptions).toContain("不得使用 PVC");
});

it("keeps pending changes and old-delivery warnings when a narrative revision omits them", () => {
	const original = createRequirementBrief({ industry: "print", title: "需求单", customerGoal: "核对本订单", facts: requirementBriefFixtures[0].artifact.facts, pendingChanges: [{ key: "quantity", currentFactVersion: 1, value: 6200, unit: "pcs", sourceRef: "message-1" }] });
	const revised = requirementEvidencePolicy.applyRevision(original, JSON.stringify({ title: original.title, customerGoal: original.customerGoal, assumptions: [] }), [{ kind: "unsupported", location: "/assumptions", evidenceRefs: ["message-1"], reason: "Remove unsupported narrative", suggestedAction: "revise" }]) as RequirementBriefV1;
	expect(revised.pendingChanges).toEqual(original.pendingChanges);
	expect(revised.facts).toEqual(original.facts);
	expect(revised.assumptions.join()).toContain("旧交付物不能继续");
	expect(revised.nextAction).toBe("confirm_facts");
});

it("does not present rejected historical dimensions as a candidate awaiting confirmation", async () => {
	const h = harness();
	h.engine.recordFactVersion({ ...h.command(), factKey: "dimensions", factVersion: 1, value: "旧尺寸", status: "rejected", sourceType: "human_confirmation", sourceRef: "withdrawal:employee" });
	await h.run([], ["dimensions"]);
	expect(h.read().facts.some((f) => f.key === "dimensions")).toBe(false);
	expect(h.read().assumptions.join()).not.toContain("历史候选保留待核对");
	expect(h.read().assumptions.join()).toContain("已拒绝或撤回");
});

it("withholds conflicting duplicate candidates while preserving the old unverified record for human review", async () => {
	const h = harness(); h.record(fact("dimensions", "200 × 150 × 80 mm"));
	await h.run([fact("dimensions", "200 × 150 × 80 mm"), { ...fact("dimensions", "212 × 162 × 92 mm"), sourceRef: h.source.sourceRef }]);
	expect(h.read().facts.some((f) => f.key === "dimensions")).toBe(false);
	expect(h.read().missingRequiredFacts).toContain("dimensions");
	expect(h.engine.load(h.scope).facts.dimensions).toMatchObject({ status: "unverified", version: 1 });
	expect(h.read().assumptions.join()).toContain("212 × 162 × 92");
	expect(h.evaluation().approvalEligible).toBe(false);
});

it("does not fill a declared missing total-piece count using a roll count", async () => {
	const h = harness();
	await h.run([fact("quantity", 30, "卷")], ["quantity"]);
	expect(h.read().facts.some((f) => f.key === "quantity")).toBe(false);
	expect(h.read().nextAction).toBe("clarify");
	expect(h.read().assumptions.join()).toContain("30 卷");
});

it("retains a verified value and blocks approval when a different value is proposed, even if the reviewer says pass", async () => {
	const h = harness();
	for (const f of requirementBriefFixtures[0].artifact.facts) h.record(f);
	const candidates = requirementBriefFixtures[0].artifact.facts.map((f) => f.key === "quantity" ? { ...f, value: 6200, status: "unverified" as const, sourceRef: "message-1" } : f);
	await h.run(candidates);
	expect(h.read().facts.find((f) => f.key === "quantity")).toMatchObject({ value: 10000, status: "verified" });
	expect(h.read().nextAction).toBe("confirm_facts");
	expect(h.read().pendingChanges).toEqual([{ key: "quantity", currentFactVersion: 1, value: 6200, unit: "pcs", sourceRef: "message-1" }]);
	expect(h.read().assumptions.join()).toContain("旧交付物不能继续");
	expect(h.evaluation().approvalEligible).toBe(false);
	expect(h.evaluation().issues).toContainEqual(expect.objectContaining({ code: "pending_fact_change" }));
	expect(h.engine.load(h.scope).approval).toBeUndefined();
});

it("does not invent lineage for a source absent from this run", async () => {
	const h = harness();
	await h.run([{ ...fact("quantity", 300), sourceRef: "other-tenant-source" }]);
	expect(h.read().facts).toEqual([]);
	expect(h.evaluation().issues).toContainEqual(expect.objectContaining({ code: "candidate_source_unavailable" }));
});

it.each([false, true])("keeps a new proposal when the model also echoes the confirmed value (reverse=%s)", async (reverse) => {
	const h = harness();
	const confirmed = requirementBriefFixtures[0].artifact.facts;
	for (const value of confirmed) h.record(value);
	const proposal = fact("quantity", 6200, "pcs");
	const candidates = [...confirmed, proposal];
	await h.run(reverse ? candidates.reverse() : candidates);
	expect(h.engine.load(h.scope).facts.quantity).toMatchObject({ value: 10000, version: 1, status: "verified" });
	expect(h.read().pendingChanges).toEqual([{ key: "quantity", currentFactVersion: 1, value: 6200, unit: "pcs", sourceRef: "message-1" }]);
	expect(h.read().nextAction).toBe("confirm_facts");
	expect(h.evaluation().approvalEligible).toBe(false);
	expect(h.engine.load(h.scope).approval).toBeUndefined();
});

it("still withholds two different new proposals beside an echoed confirmed value", async () => {
	const h = harness();
	const confirmed = requirementBriefFixtures[0].artifact.facts;
	for (const value of confirmed) h.record(value);
	await h.run([...confirmed, fact("quantity", 6200, "pcs"), fact("quantity", 7000, "pcs")]);
	expect(h.engine.load(h.scope).facts.quantity).toMatchObject({ value: 10000, version: 1, status: "verified" });
	expect(h.read().pendingChanges ?? []).toEqual([]);
	expect(h.evaluation().approvalEligible).toBe(false);
	expect(h.evaluation().issues).toContainEqual(expect.objectContaining({ code: "unresolved_fact" }));
});

it("reconciles a withdrawal after a crash, supersedes approval and keeps the original blob and artifact", async () => {
	const h = harness();
	const facts = requirementBriefFixtures[0].artifact.facts.map((f) => f.key === "dimensions" ? { ...f, sourceRef: h.source.sourceRef, value: "212 × 162 × 92 mm" } : f);
	for (const f of facts) h.record(f);
	await h.run(facts);
	const before = h.read();
	let state = h.engine.load(h.scope);
	h.engine.resolveApproval({ ...h.command(), ...state.approval!, decision: "approved" });
	h.engine.confirmProposalGate(h.command());
	const request = { requestId: "withdraw-1", actorId: "employee", reason: "旧尺寸附件不适用", sha256: h.source.sha256 };
	h.attachments.withdraw(h.scope, h.source.attachmentId, request);
	// Simulated crash between the tombstone and business-state reconciliation.
	expect(() => h.attachments.read(h.scope, h.source.attachmentId)).toThrow(expect.objectContaining({ code: "attachment_withdrawn" }));
	reconcileRequirementWithdrawals(h.engine, h.attachments, h.scope);
	state = h.engine.load(h.scope);
	expect(state).toMatchObject({ stageStatus: "revision_required", facts: { dimensions: { status: "rejected" } }, currentProposal: { freshness: "stale" }, approval: { status: "superseded" } });
	const count = h.engine.readEvents(h.scope).length;
	h.attachments.withdraw(h.scope, h.source.attachmentId, request);
	reconcileRequirementWithdrawals(h.engine, h.attachments, h.scope);
	expect(h.engine.readEvents(h.scope)).toHaveLength(count);
	expect(h.read()).toEqual(before);
	expect(h.attachments.read(h.scope, h.source.attachmentId, { includeWithdrawn: true }).content.toString()).toContain("212 × 162 × 92");
	expect(h.attachments.readText(h.scope)).toEqual([]);
	expect(h.attachments.digest(h.scope)).toBeDefined();
	expect(() => h.attachments.withdraw(h.scope, h.source.attachmentId, { ...request, reason: "different input" })).toThrow(expect.objectContaining({ code: "attachment_conflict" }));
	expect(() => h.attachments.read({ ...h.scope, tenantId: "other" }, h.source.attachmentId, { includeWithdrawn: true })).toThrow(expect.objectContaining({ code: "attachment_not_found" }));
});

it("fences a late Worker result after its source was withdrawn", async () => {
	const h = harness();
	await expect(h.run([{ ...fact("dimensions", "212 × 162 × 92 mm"), sourceRef: h.source.sourceRef }], undefined, () => {
		h.attachments.withdraw(h.scope, h.source.attachmentId, { requestId: "during-turn", actorId: "employee", reason: "source invalid", sha256: h.source.sha256 });
	})).rejects.toMatchObject({ code: "context_failure" });
	expect(h.engine.load(h.scope).currentProposal).toBeUndefined();
	expect(h.engine.load(h.scope).facts.dimensions).toBeUndefined();
});


it("keeps verified Host facts when a model merely omits them", async () => {
	const h = harness();
	for (const f of requirementBriefFixtures[0].artifact.facts) h.record(f);
	await h.run([]);
	expect(h.read().facts).toHaveLength(7);
	expect(h.evaluation().approvalEligible).toBe(true);
});

it("requires reconfirmation for legacy runtime-only lineage and excludes withdrawn evidence from later reviews", async () => {
	const h = harness();
	h.record({ ...fact("dimensions", "212 × 162 × 92 mm"), sourceRef: "runtime:legacy-execution" });
	h.record({ ...fact("dimensions", "212 × 162 × 92 mm"), sourceRef: "confirmation:employee", status: "verified", sourceType: "human_confirmation" });
	h.attachments.withdraw(h.scope, h.source.attachmentId, { requestId: "withdraw-legacy", actorId: "employee", reason: "旧文件已撤回，需要重新核对依赖字段", sha256: h.source.sha256 });
	reconcileRequirementWithdrawals(h.engine, h.attachments, h.scope);
	expect(h.engine.load(h.scope).facts.dimensions.status).toBe("rejected");
	await h.run([{ ...fact("dimensions", "212 × 162 × 92 mm"), sourceRef: h.source.sourceRef }]);
	expect(h.read().facts).toEqual([]);
	expect(JSON.parse(h.requests.at(-1)!.input).evidence.some((e: { ref: string }) => e.ref === h.source.sourceRef)).toBe(false);
	expect(h.evaluation().issues).toContainEqual(expect.objectContaining({ code: "candidate_source_unavailable" }));
});


it("accepts a complete JSON fence without changing its contents, but never guesses malformed JSON", () => {
	const candidate = requirementBriefFixtures[0].artifact;
	const text = JSON.stringify(candidate);
	for (const output of [text, "  " + text + "  ", "```json\n" + text + "\n```", "```\n" + text + "\n```"])
		expect(parseRequirementCandidate(output, "print")).toEqual(candidate);
	for (const output of ["Explanation before JSON\n```json\n" + text + "\n```", text + "}", text.replace('"nextAction":', '} ,"nextAction":')])
		expect(parseRequirementCandidate(output, "print")).toBeUndefined();
});


it("ignores a redundant unit beside an unchanged verified text value without rewriting the fact", async () => {
	const h = harness();
	const facts = requirementBriefFixtures[0].artifact.facts.map((f) => f.key === "dimensions" ? { ...f, value: "外尺寸 140 × 240 × 80 mm", unit: undefined } : f);
	for (const f of facts) h.record(f);
	await h.run(facts.map((f) => f.key === "dimensions" ? { ...f, unit: "mm" } : f));
	expect(h.read().facts.find((f) => f.key === "dimensions")).toMatchObject({ value: "外尺寸 140 × 240 × 80 mm", version: 1, status: "verified" });
	expect(h.read().facts.find((f) => f.key === "dimensions")?.unit).toBeUndefined();
	expect(h.evaluation().approvalEligible).toBe(true);
});


it("keeps raw source records visible without turning them into impossible customer confirmation tasks", async () => {
	const h = harness(); h.record(fact("quantity", 100, "pcs"));
	await h.run([]);
	const context = JSON.parse(h.requests[0].taskContext!.content);
	expect(context.facts).toContainEqual(expect.objectContaining({ key: "customer_brief", status: "unverified" }));
	expect(context.unresolved.map((item: { key: string }) => item.key)).toEqual(["quantity"]);
	expect(h.engine.load(h.scope).facts.customer_brief.status).toBe("unverified");
});
