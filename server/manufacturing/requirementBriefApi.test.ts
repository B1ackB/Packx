import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { createRequirementBrief, requiredRequirementFacts, type RequirementBriefV1 } from "../../src/manufacturing/requirementBrief";
import type {
	ConversationView,
	RequirementBriefMetricsSeriesView,
	RequirementBriefWorkspaceView,
} from "../../src/runtime/conversationContracts";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { FileEnterpriseEventStore } from "../enterprise/fileEventStore";
import { ConversationApiController } from "../runtime/conversationApi";
import { FileConversationAttachmentStore } from "../runtime/conversationAttachments";
import { FakeAgentRuntime } from "../runtime/fakeAgentRuntime";
import { FileAgentStateStore } from "../runtime/fileAgentStateStore";
import { createProjectSourceReadTool } from "../runtime/requirementTools";
import { StageJobOutbox } from "../workers/stageJobOutbox";
import { StageJobScheduler } from "../workers/stageJobScheduler";
import { RequirementBriefWorkspaceApiController } from "./requirementBriefApi";
import { RequirementBriefWorker } from "./requirementBriefWorker";
import { requirementMessagesChanged } from "./requirementSourceLifecycle";
import { candidateConfirmationKey } from "./requirementCandidateConflicts";

import type { PlanScope, PlanWorkspace } from "../../src/enterprise/agentPlan";
import type { SourceReportArtifact, SourceReportBinding } from "../../src/enterprise/sourceReport";
import type { RequirementReportSources } from "./requirementReportSource";

const directories: string[] = [];
const context = {
	tenantId: "tenant-requirement",
	workspaceId: "workspace-requirement",
	actorId: "user-requirement",
};

function requirement(response: { body: unknown }): RequirementBriefWorkspaceView {
	return (response.body as { requirementBrief: RequirementBriefWorkspaceView }).requirementBrief;
}

function harness(options: { readPlan?: (scope: PlanScope) => PlanWorkspace; reports?: RequirementReportSources } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "blackx-requirement-workspace-"));
	directories.push(directory);
	const sessions = new FileAgentStateStore(join(directory, "agent"));
	const eventPath = join(directory, "events.json");
	const eventStore = new FileEnterpriseEventStore(eventPath);
	const engine = new ProposalRunEngine(eventStore, "requirement-brief");
	const attachments = new FileConversationAttachmentStore(join(directory, "attachments"));
	const runtime = new FakeAgentRuntime({
		sessions,
		snapshots: sessions,
		tools: [createProjectSourceReadTool(engine, attachments)],
		resolveImageAttachment: async (scope, attachment) => attachments.resolveImage(scope, attachment),
	});
	let conversationSequence = 0;
	const conversations = new ConversationApiController(
		runtime,
		sessions,
		() => "2026-09-04T00:00:00.000Z",
		() => `requirement-conversation-${conversationSequence += 1}`,
	);
	const created = (conversations.create(context).body as { conversation: ConversationView }).conversation;
	const stored = sessions.getSession({
		...context,
		runId: created.conversationId,
		sessionId: created.conversationId,
	})!;
	sessions.save(
		{ ...context, runId: created.conversationId, sessionId: created.conversationId },
		stored.revision,
		[{
			role: "user",
			content: "需要 5000 个咖啡豆包装袋，送到香港。",
			messageId: "requirement-message",
			createdAt: "2026-09-04T00:01:00.000Z",
			pinned: true,
		}],
		"2026-09-04T00:01:00.000Z",
	);
	const artifacts = new FileArtifactContentStore(join(directory, "artifacts"));
	const queue = new InMemoryStageJobQueue();
	const outbox = new StageJobOutbox(engine, eventStore, queue);
	const worker = new RequirementBriefWorker(engine, runtime, artifacts, attachments, undefined, undefined, undefined, conversations, options.reports);
	const scheduler = new StageJobScheduler(queue, {
		workerId: "requirement-workspace-test",
		handlers: { "requirement-brief": (lease, signal, guard) => worker.executeLease(lease, signal, guard) },
	});
	const controller = (currentEngine = engine) => new RequirementBriefWorkspaceApiController(
		conversations, currentEngine, artifacts, outbox, scheduler, attachments, undefined, options.readPlan, undefined, undefined, options.reports,
	);
	return {
		conversationId: created.conversationId,
		conversations,
		controller: controller(),
		reopen: () => controller(new ProposalRunEngine(new FileEnterpriseEventStore(eventPath), "requirement-brief")),
		attachments,
		engine, artifacts, runtime, queue,
		outbox,
		eventPath,
		sessions,
		scheduler,
	};
}

function approvalReview(view: RequirementBriefWorkspaceView) {
	return { approvalId: view.state.approval!.approvalId, artifactVersion: view.state.approval!.artifactVersion, expectedAggregateVersion: view.state.aggregateVersion };
}

async function readyForApproval(initialAttachment = false, h = harness(), planVersion?: number) {
	if (initialAttachment) h.attachments.put({ ...context, conversationId: h.conversationId }, { requestId: "initial-source", name: "initial.txt", mediaType: "text/plain", content: Buffer.from("数量 5000 个") });
	expect(h.controller.start(context, h.conversationId, { requestId: "start-ready", industry: "print", ...(planVersion ? { planVersion } : {}) }).status).toBe(202);
	await h.scheduler.runNext();
	for (const key of requiredRequirementFacts.print) {
		h.controller.recordFact(context, h.conversationId, { requestId: `record-${key}`, key, value: key === "quantity" ? 5000 : `confirmed-${key}` });
		const state = requirement(h.controller.get(context, h.conversationId)).state;
		expect(h.controller.resolveFact(context, h.conversationId, key, { requestId: `verify-${key}`, decision: "verified", expectedFactVersion: state.facts[key].version, expectedAggregateVersion: state.aggregateVersion }).status).toBe(200);
	}
	h.controller.start(context, h.conversationId, { requestId: "generate-ready", industry: "print", ...(planVersion ? { planVersion } : {}) });
	expect((await h.scheduler.runNext()).status).toBe("completed");
	expect(requirement(h.controller.get(context, h.conversationId)).state.stageStatus).toBe("waiting_approval");
	return h;
}

function appendMessage(h: ReturnType<typeof harness>, role: "user" | "assistant", content: string) {
	const scope = { ...context, runId: h.conversationId, sessionId: h.conversationId };
	const stored = h.sessions.getSession(scope)!;
	h.sessions.save(scope, stored.revision, [...stored.messages, { role, content, messageId: `message-${stored.revision}`, createdAt: "2026-09-30T00:00:00Z" }], "2026-09-30T00:00:00Z");
}

async function withCandidateConflict(fileSource = false) {
	const h = harness(), execute = h.runtime.executeTurn.bind(h.runtime);
	let value = 5000, sourceRef = "runtime-output", calls = 0;
	h.runtime.executeTurn = async (...args) => {
		calls++;
		const result = await execute(...args);
		return args[0].stageId === "requirement-brief" ? { ...result, finalResponse: JSON.stringify(createRequirementBrief({ industry: "print", title: "需求单", customerGoal: "核对数量", facts: [{ key: "quantity", value, unit: "pcs", version: 1, status: "unverified", sourceType: "model_output", sourceRef }] })) } : result;
	};
	const view = () => requirement(h.controller.get(context, h.conversationId));
	const run = async (requestId: string) => {
		expect(h.controller.start(context, h.conversationId, { requestId, industry: "print" }).status).toBe(202);
		expect((await h.scheduler.runNext()).status).toBe("completed");
	};
	await run("initial-candidate");
	const attachment = fileSource ? h.attachments.put({ ...context, conversationId: h.conversationId }, { requestId: "conflicting-file", name: "new-order.txt", mediaType: "text/plain", content: Buffer.from("新文件要求 6200 个。") }).attachment : undefined;
	if (attachment) sourceRef = attachment.sourceRef;
	else appendMessage(h, "user", "后续要求 6200 个，请核对前文。");
	value = 6200;
	await run("different-candidate");
	expect(view().candidateConflicts).toHaveLength(1);
	const review = (requestId = "choose-candidate") => ({ requestId, decision: "verified", expectedFactVersion: view().state.facts.quantity.version, expectedAggregateVersion: view().state.aggregateVersion, reviewedArtifactVersion: view().state.currentProposal!.version });
	return { ...h, view, run, review, attachment, calls: () => calls, setCandidate: (next: number) => { value = next; } };
}

it.each([false, true])("requires the reviewed artifact and human confirmation to settle both source candidates (choose new=%s)", async chooseNew => {
	const h = await withCandidateConflict();
	const before = h.view(), conflict = before.candidateConflicts![0];
	expect(before.candidateConflictSources?.[conflict.id]).toMatchObject({ previous: { status: "available", text: expect.stringContaining("5000") }, proposed: { status: "available", text: expect.stringContaining("6200") } });
	const input = h.review();
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", { ...input, requestId: 123 }).status).toBe(400);
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", { ...input, reviewedArtifactVersion: undefined })).toMatchObject({ status: 409, body: { code: "candidate_review_stale" } });
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", { ...input, reviewedArtifactVersion: 1 }).status).toBe(409);
	expect(h.controller.resolveFact({ ...context, tenantId: "other" }, h.conversationId, "quantity", input).status).toBe(404);
	if (chooseNew) {
		expect(h.controller.recordFact(context, h.conversationId, { requestId: "edit-candidate", key: "quantity", value: 6200, unit: "pcs" }).status).toBe(200);
		expect(h.view().candidateConflicts).toEqual(before.candidateConflicts);
		expect(h.view().state.facts.quantity.status).toBe("unverified");
	}
	const reviewed = h.review();
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", reviewed).status).toBe(200);
	const confirmed = h.view();
	expect(confirmed.candidateConflicts).toEqual([]);
	expect(confirmed.state.facts.quantity).toMatchObject({ value: chooseNew ? 6200 : 5000, status: "verified", sourceType: "human_confirmation" });
	expect(confirmed.state.currentProposal?.freshness).toBe("stale");
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", reviewed).status).toBe(200);
	expect(h.view().state.aggregateVersion).toBe(confirmed.state.aggregateVersion);
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", { ...reviewed, reviewedArtifactVersion: 1 }).status).toBe(409);
	await h.run("after-confirmation");
	expect(h.view().candidateConflicts).toEqual([]);
	expect((h.view().artifact?.content as RequirementBriefV1).pendingChanges).toBeUndefined();
	expect(h.artifacts.readJson({ ...confirmed.state, artifactId: "requirement-brief", artifactVersion: 2 })).toEqual(before.artifact!.content);
	expect(h.calls()).toBe(6); // Exactly the existing intake and review calls for each generation.
	appendMessage(h, "user", "又收到新的 8000 个需求。"); h.setCandidate(8000);
	await h.run("later-source-version");
	expect((h.view().artifact?.content as RequirementBriefV1).pendingChanges).toEqual([expect.objectContaining({ value: 8000 })]);
});

it.each(["message", "upload", "withdraw"] as const)("rejects confirmation after %s changes even with freshly read aggregate versions", async change => {
	const h = await withCandidateConflict(true), before = h.view();
	if (change === "message") appendMessage(h, "user", "数量还需要重新核对。");
	if (change === "upload") h.attachments.put({ ...context, conversationId: h.conversationId }, { requestId: "extra-file", name: "extra.txt", mediaType: "text/plain", content: Buffer.from("待核对") });
	if (change === "withdraw") expect(h.controller.withdrawAttachment(context, h.conversationId, h.attachment!.attachmentId, { requestId: "withdraw-source", reason: "该文件已撤回", sha256: h.attachment!.sha256 }).status).toBe(200);
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", h.review())).toMatchObject({ status: 409, body: { code: "candidate_review_stale" } });
	expect(h.view().candidateConflicts).toEqual(before.candidateConflicts);
	expect(h.view().state.facts.quantity.status).toBe("unverified");
	if (change === "withdraw") expect(h.view().candidateConflictSources?.[before.candidateConflicts![0].id].proposed.status).toBe("withdrawn");
});

it.each(["before-event", "after-event"] as const)("recovers candidate confirmation %s without treating intent as confirmation or duplicating it", async crashAt => {
	const h = await withCandidateConflict(), resolve = h.engine.resolveFact.bind(h.engine), input = h.review();
	let crashed = false;
	h.engine.resolveFact = command => {
		if (!crashed && crashAt === "before-event") { crashed = true; throw new Error("crash before confirmation event"); }
		const result = resolve(command);
		if (!crashed) { crashed = true; throw new Error("crash after confirmation event"); }
		return result;
	};
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", input).status).toBe(500);
	expect(h.artifacts.readJson({ ...h.view().state, ...candidateConfirmationKey(input.requestId) })).toMatchObject({ reviewedArtifactVersion: 2 });
	expect(h.view().candidateConflicts).toHaveLength(crashAt === "before-event" ? 1 : 0);
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", input).status).toBe(200);
	expect(h.view().candidateConflicts).toEqual([]);
	expect(h.engine.readEvents(h.view().state).filter(e => e.commandId === `${input.requestId}:fact-decision` && e.data.type === "fact.version_recorded")).toHaveLength(1);
	expect(h.calls()).toBe(4);
});

it("keeps the disagreement after rejecting a candidate and after a confirmation without a review receipt", async () => {
	const h = await withCandidateConflict(), conflicts = h.view().candidateConflicts;
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", { ...h.review("reject-candidate"), decision: "rejected" }).status).toBe(200);
	expect(h.view().candidateConflicts).toEqual(conflicts);
	h.controller.recordFact(context, h.conversationId, { requestId: "manual-edit", key: "quantity", value: 6200, unit: "pcs" });
	const state = h.view().state;
	h.engine.resolveFact({ ...state, actorId: context.actorId, commandId: "unbound:fact-decision", correlationId: "test", expectedVersion: state.aggregateVersion, factKey: "quantity", decision: "verified", sourceRef: "manual-unbound" });
	expect(h.view().candidateConflicts).toEqual(conflicts);
	await h.run("unbound-confirmation-draft");
	expect((h.view().artifact?.content as RequirementBriefV1).nextAction).toBe("clarify");
	expect(h.view().state.approval).toBeUndefined();
});

it.each(["rejected", "unbound_verified"])("keeps a third candidate after %s until the complete current list is reviewed", async status => {
	const h = await withCandidateConflict(), oldVersion = h.view().state.currentProposal!.version;
	if (status === "rejected") expect(h.controller.resolveFact(context, h.conversationId, "quantity", { ...h.review("reject-old"), decision: "rejected" }).status).toBe(200);
	else {
		const state = h.view().state;
		h.engine.resolveFact({ ...state, actorId: context.actorId, commandId: "unbound:fact-decision", correlationId: "test", expectedVersion: state.aggregateVersion, factKey: "quantity", decision: "verified", sourceRef: "manual-unbound" });
	}
	appendMessage(h, "user", "最新要求 8000 个，请核对。"); h.setCandidate(8000);
	await h.run("third-after-decision");
	expect(h.view().candidateConflicts).toHaveLength(2);
	expect(h.view().candidateConflicts).toContainEqual(expect.objectContaining({ proposed: expect.objectContaining({ value: 8000 }) }));
	expect(h.view().state.approval).toBeUndefined();
	const conflicts = h.view().candidateConflicts;
	await h.run("repeat-third");
	expect(h.view().candidateConflicts).toEqual(conflicts);
	expect(h.controller.recordFact(context, h.conversationId, { requestId: "choose-6200", key: "quantity", value: 6200, unit: "pcs" }).status).toBe(200);
	for (const reviewedArtifactVersion of [undefined, oldVersion]) expect(h.controller.resolveFact(context, h.conversationId, "quantity", { ...h.review("old-review"), reviewedArtifactVersion }).status).toBe(409);
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", h.review()).status).toBe(200);
	expect(h.view().candidateConflicts).toEqual([]);
	expect(h.view().state.facts.quantity).toMatchObject({ value: 6200, status: "verified", sourceType: "human_confirmation" });
	expect(h.calls()).toBe(8);
});

it.each(["requirement-runtime-checkpoint", "requirement-intake-corrections", "requirement-candidate-checkpoint"])("requires review of abandoned %s candidates before and after a new execution", async artifactId => {
	const h = harness(), execute = h.runtime.executeTurn.bind(h.runtime);
	let value: number | undefined = 5000, calls = 0;
	h.runtime.executeTurn = async (...args) => {
		calls++;
		const result = await execute(...args);
		return args[0].stageId === "requirement-brief" ? { ...result, finalResponse: JSON.stringify(createRequirementBrief({ industry: "print", title: "需求单", customerGoal: "核对数量", facts: value === undefined ? [] : [{ key: "quantity", value, unit: "pcs", version: 1, status: "unverified", sourceType: "model_output", sourceRef: "runtime-output" }] })) } : result;
	};
	const view = () => requirement(h.controller.get(context, h.conversationId));
	const review = () => ({ requestId: "confirm-abandoned", decision: "verified", expectedFactVersion: view().state.facts.quantity.version, expectedAggregateVersion: view().state.aggregateVersion, reviewedArtifactVersion: view().state.currentProposal!.version });
	h.controller.start(context, h.conversationId, { requestId: "initial", industry: "print" });
	expect((await h.scheduler.runNext()).status).toBe("completed");
	appendMessage(h, "user", "后续要求 6200 个，请核对前文。"); value = 6200;
	const put = h.artifacts.putJson.bind(h.artifacts); let crashed = false;
	h.artifacts.putJson = (key, output) => {
		const ref = put(key, output);
		if (!crashed && key.artifactId === artifactId) { crashed = true; throw new Error("abandoned candidate"); }
		return ref;
	};
	h.controller.start(context, h.conversationId, { requestId: "abandoned", industry: "print" });
	expect((await h.scheduler.runNext()).status).toBe("retry_scheduled");
	h.artifacts.putJson = put;
	expect(h.controller.cancel(context, h.conversationId, { requestId: "cancel-abandoned" }).status).toBe(200);
	expect(view().candidateConflicts).toEqual([expect.objectContaining({ firstArtifactVersion: 2, proposed: expect.objectContaining({ value: 6200 }) })]);
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", review()).status).toBe(409);
	value = undefined;
	h.controller.start(context, h.conversationId, { requestId: "after-abandon", industry: "print" });
	expect((await h.scheduler.runNext()).status).toBe("completed");
	expect(view().candidateConflicts).toHaveLength(1);
	expect((view().artifact!.content as RequirementBriefV1).nextAction).toBe("clarify");
	expect(view().state.approval).toBeUndefined();
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", { ...review(), reviewedArtifactVersion: undefined }).status).toBe(409);
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", review()).status).toBe(200);
	expect(view().candidateConflicts).toEqual([]);
	expect(view().state.facts.quantity).toMatchObject({ value: 5000, status: "verified" });
	expect(calls).toBe(5);
});

it("includes a third candidate after an unconfirmed manual edit and refuses to resolve it from the older brief", async () => {
	const h = await withCandidateConflict();
	h.controller.recordFact(context, h.conversationId, { requestId: "manual-choice", key: "quantity", value: 6200, unit: "pcs" });
	h.setCandidate(7000); await h.run("third-candidate");
	expect(h.view().candidateConflicts).toHaveLength(2);
	expect(h.view().candidateConflicts).toContainEqual(expect.objectContaining({ previous: expect.objectContaining({ value: 6200 }), proposed: expect.objectContaining({ value: 7000 }) }));
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", { ...h.review(), reviewedArtifactVersion: 2 }).status).toBe(409);
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", h.review()).status).toBe(200);
	expect(h.view().candidateConflicts).toEqual([]);
	await h.run("after-third-choice");
	expect((h.view().artifact?.content as RequirementBriefV1).pendingChanges).toBeUndefined();
});

it("requires manual entry when a legacy candidate's original source cannot be read", async () => {
	const h = await withCandidateConflict(), state = h.view().state;
	h.engine.recordFactVersion({ ...state, actorId: "worker", commandId: "legacy-value", correlationId: "test", expectedVersion: state.aggregateVersion, factKey: "quantity", factVersion: state.facts.quantity.version + 1, value: 5100, unit: "pcs", status: "unverified", sourceType: "model_output", sourceRef: "runtime:legacy" });
	await h.run("review-legacy-source");
	expect(h.view().candidateConflicts).toContainEqual(expect.objectContaining({ previous: expect.objectContaining({ value: 5100, sourceVersion: null }) }));
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", h.review())).toMatchObject({ status: 409, body: { code: "candidate_source_unavailable" } });
	expect(h.view().state.facts.quantity.status).toBe("unverified");
	h.controller.recordFact(context, h.conversationId, { requestId: "manual-replacement", key: "quantity", value: 6200, unit: "pcs" });
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", h.review()).status).toBe(200);
	expect(h.view().candidateConflicts).toEqual([]);
});

it.each(["review", "gate", "export"] as const)("invalidates changed user messages at %s without replacing confirmed Facts", async phase => {
	const h = await readyForApproval();
	const before = requirement(h.controller.get(context, h.conversationId));
	const input = { requestId: "message-approval", decision: "approved", ...approvalReview(before) };
	appendMessage(h, "assistant", "已记录，请核对。");
	expect(requirement(h.controller.get(context, h.conversationId)).state).toEqual(before.state);
	if (phase !== "review") expect(h.controller.resolveApproval(context, h.conversationId, input).status).toBe(202);
	if (phase === "export") expect((await h.scheduler.runNext()).status).toBe("completed");
	appendMessage(h, "user", "数量改为 7000 个，原来的 5000 个作废。");
	if (phase === "review") expect(h.controller.resolveApproval(context, h.conversationId, input)).toMatchObject({ status: 409, body: { code: "approval_review_stale" } });
	if (phase === "gate") expect(await h.scheduler.runNext()).toMatchObject({ status: "dead_letter", job: { lastFailure: { code: "context_failure" } } });
	expect(h.controller.delivery(context, h.conversationId, before.state.currentProposal!.version)).toMatchObject({ status: 200, body: { delivery: { status: "stale" } } });
	const state = requirement(h.controller.get(context, h.conversationId)).state;
	expect(state).toMatchObject({ stageStatus: "revision_required", approval: { status: "superseded" }, facts: { quantity: { value: 5000, status: "verified" } } });
	expect(requirement(h.controller.get(context, h.conversationId)).state.aggregateVersion).toBe(state.aggregateVersion);
});

it("fences a message change during intake before committing its checkpoint", async () => {
	const h = harness(), execute = h.runtime.executeTurn.bind(h.runtime);
	h.runtime.executeTurn = async (...args) => { const result = await execute(...args); appendMessage(h, "user", "改为 7000 个"); return result; };
	h.controller.start(context, h.conversationId, { requestId: "changed-during-intake", industry: "print" });
	expect(await h.scheduler.runNext()).toMatchObject({ status: "dead_letter", job: { lastFailure: { code: "context_failure" } } });
	expect(requirement(h.controller.get(context, h.conversationId)).state.proposalVersions).toHaveLength(0);
});

it.each(["cancelled", "passed"] as const)("supports an explicit revision from %s and preserves the previous delivery", async terminal => {
	const h = await readyForApproval();
	const before = requirement(h.controller.get(context, h.conversationId));
	if (terminal === "passed") {
		h.controller.resolveApproval(context, h.conversationId, { requestId: "finish-before-revision", decision: "approved", ...approvalReview(before) });
		await h.scheduler.runNext();
		// Direct human entry after delivery also opens a revision, never verifies the new candidate.
		expect(h.controller.recordFact(context, h.conversationId, { requestId: "quantity-correction", key: "quantity", value: 7000 }).status).toBe(200);
		expect(requirement(h.controller.get(context, h.conversationId)).state.facts.quantity).toMatchObject({ value: 7000, status: "unverified" });
	} else h.controller.cancel(context, h.conversationId, { requestId: "stop-before-revision" });
	appendMessage(h, "user", "请按更正后的数量重新整理。");
	const input = { requestId: "explicit-revision", industry: "print" };
	expect(h.controller.start(context, h.conversationId, input).status).toBe(202);
	expect(h.controller.start(context, h.conversationId, input).status).toBe(202);
	expect((await h.scheduler.runNext()).status).toBe("completed");
	const after = requirement(h.controller.get(context, h.conversationId));
	expect(after.state.currentProposal!.version).toBeGreaterThan(before.state.currentProposal!.version);
	expect(h.controller.delivery(context, h.conversationId, before.state.currentProposal!.version)).toMatchObject({ body: { delivery: { status: "stale", content: before.artifact!.content } } });
});

it("opens a new execution after completed approval without requiring a dummy source change", async () => {
	const h = await readyForApproval(), before = requirement(h.controller.get(context, h.conversationId));
	h.controller.resolveApproval(context, h.conversationId, { requestId: "finish", decision: "approved", ...approvalReview(before) }); await h.scheduler.runNext();
	const finished = requirement(h.controller.get(context, h.conversationId)).state;
	expect(h.controller.start(context, h.conversationId, { requestId: "generate-ready", industry: "print" }).status).toBe(202);
	expect(requirement(h.controller.get(context, h.conversationId)).state).toEqual(finished);
	expect(h.controller.start(context, h.conversationId, { requestId: "revise-finished", industry: "print" }).status).toBe(202);
	expect((await h.scheduler.runNext()).status).toBe("completed");
	expect(requirement(h.controller.get(context, h.conversationId)).state).toMatchObject({ currentProposal: { version: 3 }, approval: { status: "requested" } });
});

it.each(["cancelled", "needs_input"] as const)("keeps the original execution replay from restarting %s", async status => {
	const h = harness(), input = { requestId: "original-execution", industry: "print" };
	h.controller.start(context, h.conversationId, input);
	if (status === "cancelled") h.controller.cancel(context, h.conversationId, { requestId: "cancel-original" });
	else await h.scheduler.runNext();
	const before = requirement(h.controller.get(context, h.conversationId)).state;
	expect(before.stageStatus).toBe(status);
	expect(h.controller.start(context, h.conversationId, input).status).toBe(202);
	expect(requirement(h.controller.get(context, h.conversationId)).state).toEqual(before);
	expect((await h.scheduler.runNext()).status).toBe("idle");
});

it.each(["requirement-runtime-checkpoint", "requirement-intake-corrections", "requirement-brief"])("preserves an abandoned %s and lets a new execution proceed", async artifactId => {
	const h = harness(), put = h.artifacts.putJson.bind(h.artifacts);
	let injected = false, abandoned: unknown;
	h.artifacts.putJson = (key, value) => {
		const ref = put(key, value);
		if (!injected && key.artifactId === artifactId) { injected = true; abandoned = value; throw new Error("crash after immutable write"); }
		return ref;
	};
	h.controller.start(context, h.conversationId, { requestId: "abandoned", industry: "print" });
	expect((await h.scheduler.runNext()).status).toBe("retry_scheduled");
	h.artifacts.putJson = put;
	h.controller.cancel(context, h.conversationId, { requestId: "cancel-abandoned" });
	expect(h.controller.start(context, h.conversationId, { requestId: "new-execution", industry: "print" }).status).toBe(202);
	expect((await h.scheduler.runNext()).status).toBe("completed");
	const state = requirement(h.controller.get(context, h.conversationId)).state;
	expect(state.currentProposal?.version).toBe(2);
	expect(h.artifacts.readJson({ ...state, artifactId, artifactVersion: 1 })).toEqual(abandoned);
	expect((h.artifacts.readJson({ ...state, artifactId: "requirement-runtime-checkpoint", artifactVersion: 2 }) as { workerCommandId: string }).workerCommandId).toBe("new-execution:execute");
});

it("restarts a cancelled first execution with changed messages before any Artifact exists", async () => {
	const h = harness();
	h.controller.start(context, h.conversationId, { requestId: "first-queued", industry: "print" });
	h.controller.cancel(context, h.conversationId, { requestId: "cancel-queued" });
	appendMessage(h, "user", "数量修改为 7000 个。");
	expect(h.controller.start(context, h.conversationId, { requestId: "new-input", industry: "print" }).status).toBe(202);
	expect((await h.scheduler.runNext()).status).toBe("completed");
	expect(requirement(h.controller.get(context, h.conversationId)).state.facts.customer_brief.value).toContain("7000");
});

it("preserves an orphan draft even when no intake checkpoint reserved its version", async () => {
	const h = harness();
	const started = requirement(h.controller.start(context, h.conversationId, { requestId: "orphan-draft", industry: "print" }));
	const orphan = { note: "An interrupted review wrote this draft before its version event" };
	h.artifacts.putJson({ ...context, runId: started.runId, artifactId: "requirement-brief", artifactVersion: 1 }, orphan);
	expect((await h.scheduler.runNext()).status).toBe("completed");
	expect(requirement(h.controller.get(context, h.conversationId)).state.currentProposal?.version).toBe(2);
	expect(h.artifacts.readJson({ ...context, runId: started.runId, artifactId: "requirement-brief", artifactVersion: 1 })).toEqual(orphan);
});

it("checks legacy text sources without invalidating them for assistant-only messages", async () => {
	const h = await readyForApproval(), state = requirement(h.controller.get(context, h.conversationId)).state;
	delete state.facts.customer_messages;
	appendMessage(h, "assistant", "已记录。");
	const read = () => (h.conversations.get(context, h.conversationId).body as { conversation: ConversationView }).conversation;
	expect(requirementMessagesChanged(state, read())).toBe(false);
	appendMessage(h, "user", "数量改为 7000 个。");
	expect(requirementMessagesChanged(state, read())).toBe(true);
});

it.each(["approved", "rejected"] as const)("rejects stale %s decisions and binds retries to the originally reviewed version", async decision => {
	const h = await readyForApproval();
	const view = () => requirement(h.controller.get(context, h.conversationId));
	const old = approvalReview(view());
	expect(h.controller.resolveApproval(context, h.conversationId, { requestId: "missing-version", decision }).status).toBe(400);
	h.controller.recordFact(context, h.conversationId, { requestId: "new-quantity", key: "quantity", value: 6000 });
	const changed = view().state;
	h.controller.resolveFact(context, h.conversationId, "quantity", { requestId: "confirm-new-quantity", decision: "verified", expectedFactVersion: changed.facts.quantity.version, expectedAggregateVersion: changed.aggregateVersion });
	h.controller.start(context, h.conversationId, { requestId: "new-version", industry: "print" });
	await h.scheduler.runNext();
	expect(h.controller.resolveApproval(context, h.conversationId, { requestId: "stale-tab", decision, ...old })).toMatchObject({ status: 409, body: { code: "approval_review_stale" } });
	expect(view().state.approval).toMatchObject({ status: "requested", artifactVersion: 3 });
	const input = { requestId: "current-decision", decision, ...approvalReview(view()) };
	expect(h.controller.resolveApproval({ ...context, tenantId: "other" }, h.conversationId, input).status).toBe(404);
	expect(h.controller.resolveApproval(context, h.conversationId, input).status).toBe(202);
	await h.scheduler.runNext();
	const done = view().state;
	expect(h.controller.resolveApproval(context, h.conversationId, input).status).toBe(202);
	expect(view().state).toEqual(done);
	expect(h.controller.resolveApproval(context, h.conversationId, { ...input, ...old }).status).toBe(409);
	expect(h.controller.resolveApproval(context, h.conversationId, { ...input, decision: decision === "approved" ? "rejected" : "approved" }).status).toBe(409);
});

it("recovers the gap between an approval commit and gate dispatch using the same reviewed request", async () => {
	const h = await readyForApproval();
	const input = { requestId: "dispatch-recovery", decision: "approved", ...approvalReview(requirement(h.controller.get(context, h.conversationId))) };
	const dispatch = h.outbox.requestStage.bind(h.outbox);
	h.outbox.requestStage = () => { throw new Error("crash before dispatch"); };
	expect(h.controller.resolveApproval(context, h.conversationId, input).status).toBe(500);
	expect(requirement(h.controller.get(context, h.conversationId)).state.approval?.status).toBe("approved");
	h.outbox.requestStage = dispatch;
	expect(h.controller.resolveApproval(context, h.conversationId, input).status).toBe(202);
	expect((await h.scheduler.runNext()).status).toBe("completed");
	expect(requirement(h.controller.get(context, h.conversationId)).state.stageStatus).toBe("passed");
});

it.each([false, true])("invalidates additions at review, gate and export (initial attachment=%s)", async initialAttachment => {
	for (const phase of ["review", "gate", "export"] as const) {
		const h = await readyForApproval(initialAttachment);
		const before = requirement(h.controller.get(context, h.conversationId));
		const input = { requestId: "approve-current", decision: "approved", ...approvalReview(before) };
		if (phase !== "review") expect(h.controller.resolveApproval(context, h.conversationId, input).status).toBe(202);
		if (phase === "export") expect((await h.scheduler.runNext()).status).toBe("completed");
		h.attachments.put({ ...context, conversationId: h.conversationId }, { requestId: "amendment", name: "amendment.txt", mediaType: "text/plain", content: Buffer.from("最新数量 7000 个，不使用原 5000 个订单") });
		if (phase === "review") expect(h.controller.resolveApproval(context, h.conversationId, input)).toMatchObject({ status: 409, body: { code: "approval_review_stale" } });
		if (phase === "gate") expect(await h.scheduler.runNext()).toMatchObject({ status: "dead_letter", job: { lastFailure: { code: "context_failure" } } });
		const delivered = h.controller.delivery(context, h.conversationId, before.state.currentProposal!.version);
		expect(delivered).toMatchObject({ status: 200, body: { delivery: { status: "stale" } } });
		const current = requirement(h.controller.get(context, h.conversationId)).state;
		expect(current).toMatchObject({ stageStatus: "revision_required", approval: { status: "superseded" }, facts: { quantity: { value: 5000, status: "verified" } } });
		expect(requirement(h.controller.get(context, h.conversationId)).state.aggregateVersion).toBe(current.aggregateVersion);
		// An explicit new intake can bind the changed snapshot; old approval stays invalid.
		expect(h.controller.start(context, h.conversationId, { requestId: "review-new-sources", industry: "print" }).status).toBe(202);
		expect((await h.scheduler.runNext()).status).toBe("completed");
		const regenerated = requirement(h.controller.get(context, h.conversationId)).state;
		expect(regenerated.currentProposal?.version).toBe(3);
		if (phase !== "review") {
			expect(h.controller.resolveApproval(context, h.conversationId, input).status).toBe(202);
			expect(requirement(h.controller.get(context, h.conversationId)).state).toEqual(regenerated);
		}
	}
});

it("confirms the reviewed version only, preserves source excerpts and deduplicates retries", async () => {
	const h = harness();
	h.controller.start(context, h.conversationId, { requestId: "start-review", industry: "print" });
	await h.scheduler.runNext();
	const view = () => requirement(h.controller.get(context, h.conversationId));
	h.controller.recordFact(context, h.conversationId, { requestId: "initial-quantity", key: "quantity", value: 5000 });
	const first = view();
	expect(first.factSources?.quantity).toMatchObject({ status: "available", text: expect.stringContaining("5000") });
	const input = { requestId: "confirm-reviewed", decision: "verified", expectedFactVersion: first.state.facts.quantity.version, expectedAggregateVersion: first.state.aggregateVersion };
	h.controller.recordFact(context, h.conversationId, { requestId: "changed-in-other-tab", key: "quantity", value: 6000 });
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", input)).toMatchObject({ status: 409, body: { code: "fact_review_stale" } });
	expect(view().state.facts.quantity).toMatchObject({ value: 6000, status: "unverified" });
	const current = view();
	const corrected = { ...input, expectedFactVersion: current.state.facts.quantity.version, expectedAggregateVersion: current.state.aggregateVersion };
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", corrected).status).toBe(200);
	const confirmed = view();
	expect(confirmed.factSources?.quantity).toMatchObject({ status: "available", text: "6000", label: "人工录入 / Employee entry" });
	expect(h.controller.resolveFact(context, h.conversationId, "quantity", corrected).status).toBe(200);
	expect(view().state.aggregateVersion).toBe(confirmed.state.aggregateVersion);
	expect(h.controller.resolveFact({ ...context, tenantId: "other" }, h.conversationId, "quantity", corrected).status).toBe(404);
});

it("stores review observations immutably with scope and version binding, without confirming business state", async () => {
	const h = harness();
	h.controller.start(context, h.conversationId, { requestId: "trial-start", industry: "print" });
	await h.scheduler.runNext();
	const before = requirement(h.controller.get(context, h.conversationId));
	const input = { observationId: "observation-0001", caseId: "SYN-1", reviewerAlias: "operator-A", sourceKind: "synthetic", artifactVersion: 1, expectedAggregateVersion: before.state.aggregateVersion, startedAt: "2026-09-26T01:00:00.000Z", endedAt: "2026-09-26T01:01:00.000Z", recordedReviewMs: 30_000, interruptions: 1, correctionCount: 2, criticalErrorCount: 1, outcome: "needs_work", notes: "合成资料，手动计时。" };
	expect(h.controller.saveTrialObservation(context, h.conversationId, { ...input, unexpected: true }).status).toBe(400);
	expect(h.controller.saveTrialObservation(context, h.conversationId, { ...input, recordedReviewMs: 120_000 }).status).toBe(400);
	expect(h.controller.saveTrialObservation(context, h.conversationId, { ...input, expectedAggregateVersion: 1 }).status).toBe(409);
	const saved = h.controller.saveTrialObservation(context, h.conversationId, input);
	expect(saved).toMatchObject({ status: 201, body: { observation: { measurement: "self_reported_review_timer", actorId: context.actorId, input } } });
	expect(h.controller.saveTrialObservation(context, h.conversationId, input)).toMatchObject({ status: 200, body: saved.body });
	expect(h.controller.saveTrialObservation(context, h.conversationId, { ...input, outcome: "usable" }).status).toBe(409);
	expect(h.controller.trialObservation(context, h.conversationId, input.observationId)).toMatchObject({ status: 200, body: { observation: expect.objectContaining({ input }) } });
	expect(h.controller.trialObservation({ ...context, tenantId: "other" }, h.conversationId, input.observationId).status).toBe(404);
	expect(h.controller.saveTrialObservation({ ...context, actorId: "other" }, h.conversationId, input).status).toBe(409);
	expect(requirement(h.controller.get(context, h.conversationId)).state).toEqual(before.state);
});

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("RequirementBriefWorkspaceApiController", () => {
	it("withdraws an owned attachment through the API, refuses active work and isolates other tenants", async () => {
		const h = harness();
		const source = h.attachments.put({ ...context, conversationId: h.conversationId }, { requestId: "upload", name: "spec.txt", mediaType: "text/plain", content: Buffer.from("dimensions: 200 x 100 mm") }).attachment;
		const payload = { requestId: "withdraw", reason: "wrong order", sha256: source.sha256 };
		expect(h.controller.withdrawAttachment({ ...context, tenantId: "other" }, h.conversationId, source.attachmentId, payload).status).toBe(404);
		expect(h.controller.withdrawAttachment(context, h.conversationId, source.attachmentId, { reason: "missing request" }).status).toBe(400);
		h.controller.start(context, h.conversationId, { requestId: "start", industry: "print" });
		expect(h.controller.withdrawAttachment(context, h.conversationId, source.attachmentId, payload).status).toBe(409);
		expect(h.attachments.list({ ...context, conversationId: h.conversationId })).toHaveLength(1);
		await h.scheduler.runNext();
		expect(h.controller.withdrawAttachment(context, h.conversationId, source.attachmentId, payload).status).toBe(200);
		expect(h.controller.withdrawAttachment(context, h.conversationId, source.attachmentId, payload).status).toBe(200);
		expect(h.attachments.list({ ...context, conversationId: h.conversationId })).toEqual([]);
		expect(requirement(h.controller.get(context, h.conversationId)).state.currentProposal?.freshness).toBe("stale");
	});

	it("rejects new furniture requests and fields before creating any workflow", () => {
		const { controller, conversationId } = harness();
		expect(controller.start(context, conversationId, { requestId: "retired", industry: "furniture" })).toMatchObject({ status: 400 });
		expect(requirement(controller.get(context, conversationId))).toBeNull();
		controller.start(context, conversationId, { requestId: "packaging", industry: "print" });
		const before = requirement(controller.get(context, conversationId)).state.aggregateVersion;
		expect(controller.recordFact(context, conversationId, { requestId: "retired-field", key: "installation_required", value: true })).toMatchObject({ status: 400 });
		expect(requirement(controller.get(context, conversationId)).state.aggregateVersion).toBe(before);
	});

	it("keeps a legacy industry read-only and refuses queued execution without rewriting its facts", async () => {
		const { controller, conversationId, eventPath, scheduler } = harness();
		const started = requirement(controller.start(context, conversationId, { requestId: "legacy-seed", industry: "print" }));
		const engine = new ProposalRunEngine(new FileEnterpriseEventStore(eventPath), "requirement-brief");
		engine.recordFactVersion({ ...context, runId: started.runId, commandId: "legacy-industry", correlationId: "legacy-import", expectedVersion: started.state.aggregateVersion,
			factKey: "industry", factVersion: 2, value: "furniture", status: "verified", sourceType: "human_confirmation", sourceRef: "legacy:confirmed" }, { duringExecution: true });
		const before = engine.load(started.state).aggregateVersion;
		expect(requirement(controller.get(context, conversationId)).readOnlyReason).toContain("包装");
		expect(controller.start(context, conversationId, { requestId: "convert", industry: "print" }).status).toBe(400);
		expect(controller.recordFact(context, conversationId, { requestId: "edit", key: "quantity", value: 100 }).status).toBe(400);
		expect(controller.resolveFact(context, conversationId, "quantity", { requestId: "confirm", decision: "verified" }).status).toBe(400);
		expect(controller.resolveApproval(context, conversationId, { requestId: "approve", decision: "approved" }).status).toBe(400);
		expect(controller.delivery(context, conversationId, 1).status).toBe(410);
		expect(await scheduler.runNext()).toMatchObject({ status: "dead_letter" });
		expect(engine.load(started.state).aggregateVersion).toBe(before);
		expect(engine.load(started.state).facts.industry.value).toBe("furniture");
		expect((controller.metricsSeries(context).body as { requirementBriefMetrics: RequirementBriefMetricsSeriesView }).requirementBriefMetrics.totals.runs).toBe(0);
		expect(controller.cancel(context, conversationId, { requestId: "cancel-legacy" }).status).toBe(200);
	});
	it("persists needs-input state, confirmed Facts, Artifact versions, Evaluation, and Approval", async () => {
		const { controller, conversationId, eventPath, scheduler } = harness();

		expect(controller.get(context, conversationId)).toEqual({
			status: 200,
			body: { requirementBrief: null },
		});
		const started = controller.start(context, conversationId, {
			requestId: "requirement-start-1",
			industry: "print",
		});
		expect(requirement(started).state.facts.industry).toMatchObject({
			value: "print",
			status: "verified",
			sourceType: "enterprise_source",
			sourceRef: "domain:print:packaging",
		});
		const firstRun = await scheduler.runNext();
		expect(firstRun).toMatchObject({ status: "completed" });
		const needsInput = requirement(controller.get(context, conversationId));
		expect(needsInput).toMatchObject({
			state: {
				stageStatus: "needs_input",
				currentProposal: { artifactId: "requirement-brief", version: 1 },
				evaluation: { passed: true },
			},
			artifact: {
				content: {
					schemaVersion: "requirement-brief.v1",
					nextAction: "clarify",
				},
			},
			metrics: {
				schemaVersion: "requirement-brief-metrics.v1",
				canonicalFactHitRate: null,
				confirmationRate: 0,
				confirmedRequiredFacts: 0,
				requiredFacts: 7,
				clarificationRounds: 1,
				artifactVersions: 1,
				cancelled: false,
				queue: { deliveryCount: 1, sliceCount: 1, recoveryCount: 0 },
				runtime: { usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null, costStatus: "unconfigured" },
			},
		});
		expect(needsInput.metrics.missingRequiredFacts).toEqual(requiredRequirementFacts.print);
		expect(needsInput.metrics.runtime.latencyMs).toEqual(expect.any(Number));

		const restoredEngine = new ProposalRunEngine(
			new FileEnterpriseEventStore(eventPath),
			"requirement-brief",
		);
		const restored = restoredEngine.load({
			tenantId: context.tenantId,
			workspaceId: context.workspaceId,
			runId: needsInput.runId,
		});
		expect(restored).toMatchObject({
			aggregateVersion: needsInput.state.aggregateVersion,
			stageStatus: "needs_input",
			currentProposal: { version: 1 },
		});

		for (const key of requiredRequirementFacts.print) {
			controller.recordFact(context, conversationId, {
				requestId: `record-${key}`,
				key,
				value: key === "quantity" ? 5_000 : `confirmed-${key}`,
			});
			const review = requirement(controller.get(context, conversationId)).state;
			const resolved = controller.resolveFact(context, conversationId, key, {
				expectedFactVersion: review.facts[key].version,
				expectedAggregateVersion: review.aggregateVersion,
				requestId: `verify-${key}`,
				decision: "verified",
			});
			expect(requirement(resolved).state.facts[key]).toMatchObject({
				version: 2,
				status: "verified",
				sourceType: "human_confirmation",
			});
		}

		controller.start(context, conversationId, {
			requestId: "requirement-start-2",
			industry: "print",
		});
		const secondRun = await scheduler.runNext();
		expect(secondRun).toMatchObject({ status: "completed" });
		const waiting = requirement(controller.get(context, conversationId));
		expect(waiting).toMatchObject({
			state: {
				stageStatus: "waiting_approval",
				currentProposal: { version: 2, freshness: "fresh" },
				evaluation: { passed: true, artifactVersion: 2 },
				approval: { status: "requested", artifactVersion: 2 },
			},
			artifact: { content: { nextAction: "ready_for_approval" } },
			evaluation: { report: { approvalEligible: true } },
			metrics: {
				confirmationRate: 1,
				confirmedRequiredFacts: 7,
				missingRequiredFacts: [],
				clarificationRounds: 1,
				artifactVersions: 2,
			},
		});

		controller.resolveApproval(context, conversationId, {
			requestId: "requirement-approval-1",
			approvalId: waiting.state.approval!.approvalId,
			artifactVersion: waiting.state.approval!.artifactVersion,
			expectedAggregateVersion: waiting.state.aggregateVersion,
			decision: "approved",
		});
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
		expect(requirement(controller.get(context, conversationId))).toMatchObject({
			state: {
				status: "completed",
				stageStatus: "passed",
				approval: { status: "approved", artifactVersion: 2 },
			},
			metrics: {
				artifactVersions: 2,
				confirmationRate: 1,
				queue: { deliveryCount: 3, sliceCount: 3, totalFailureCount: 0 },
			},
		});
		expect(controller.delivery(context, conversationId, 1)).toMatchObject({ status: 200, body: { delivery: { version: 1, status: "stale" } } });
		expect(controller.delivery(context, conversationId, 2)).toMatchObject({ status: 200, body: { delivery: { version: 2, status: "approved", approval: { artifactVersion: 2 } } } });
		expect(controller.delivery(context, conversationId, 999).status).toBe(404);
		expect(controller.delivery({ ...context, tenantId: "other" }, conversationId, 2).status).toBe(404);
		const series = (controller.metricsSeries(context).body as {
			requirementBriefMetrics: RequirementBriefMetricsSeriesView;
		}).requirementBriefMetrics;
		expect(series).toMatchObject({
			schemaVersion: "requirement-brief-metrics-series.v1",
			totals: {
				runs: 1,
				passed: 1,
				needsInput: 0,
				artifactVersions: 2,
				clarificationRounds: 1,
				clarificationQuestions: 7,
			},
			rates: { workflowCompletion: 1, evaluationPass: 1, approvalEligibility: 1, stagePass: 1 },
			averages: {
				confirmedCandidateAccuracy: null,
				sourceCoverageRate: 1,
			},
			queue: {
				deliveries: 3,
				slices: 3,
				failures: 0,
				recoveries: 0,
				failureRate: 0,
				recoveryRate: 0,
			},
			runtime: { toolExecutions: 0, toolFailures: 0, toolFailureRate: null },
		});
		expect(series.points).toHaveLength(1);
		expect(series.points[0]).toMatchObject({
			conversationId,
			industry: "print",
			stageStatus: "passed",
			evaluationPassed: true,
			approvalEligible: true,
			completedAt: expect.any(String),
		});
	});

	it("builds a tenant-scoped time series across Requirement Runs", async () => {
		const { controller, conversationId, conversations, scheduler, sessions } = harness();
		controller.start(context, conversationId, { requestId: "series-run-1", industry: "print" });
		controller.cancel(context, conversationId, { requestId: "series-cancel-1" });

		const second = (conversations.create(context).body as { conversation: ConversationView }).conversation;
		const stored = sessions.getSession({
			...context,
			runId: second.conversationId,
			sessionId: second.conversationId,
		})!;
		sessions.save(
			{ ...context, runId: second.conversationId, sessionId: second.conversationId },
			stored.revision,
			[{
				role: "user",
				content: "需要一批瓦楞包装纸箱，交货地点待确认。",
				messageId: "series-message-2",
				createdAt: "2026-09-04T00:02:00.000Z",
				pinned: true,
			}],
			"2026-09-04T00:02:00.000Z",
		);
		controller.start(context, second.conversationId, { requestId: "series-run-2", industry: "print" });
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });

		const series = (controller.metricsSeries(context).body as {
			requirementBriefMetrics: RequirementBriefMetricsSeriesView;
		}).requirementBriefMetrics;
		expect(series.totals).toMatchObject({ runs: 2, cancelled: 1, needsInput: 1 });
		expect(series.points).toHaveLength(2);
		expect(new Set(series.points.map((point) => point.conversationId))).toEqual(
			new Set([conversationId, second.conversationId]),
		);
		expect(series.points.every((point) => Number.isFinite(Date.parse(point.startedAt)))).toBe(true);

		const isolated = (controller.metricsSeries({ ...context, tenantId: "other-tenant" }).body as {
			requirementBriefMetrics: RequirementBriefMetricsSeriesView;
		}).requirementBriefMetrics;
		expect(isolated.totals.runs).toBe(0);
		expect(isolated.points).toEqual([]);
	});

	it("rejects an invalid industry and does not expose another tenant's Run", () => {
		const { controller, conversationId } = harness();
		expect(controller.start(context, conversationId, {
			requestId: "invalid-industry",
			industry: "other",
		})).toMatchObject({ status: 400 });
		controller.start(context, conversationId, {
			requestId: "valid-industry",
			industry: "print",
		});
		expect(controller.get({ ...context, tenantId: "other-tenant" }, conversationId)).toEqual({
			status: 404,
			body: { code: "conversation_not_found" },
		});
	});

	it("cancels a queued Requirement Run idempotently and persists the terminal state", async () => {
		const { controller, conversationId, eventPath, scheduler } = harness();
		controller.start(context, conversationId, {
			requestId: "cancel-start",
			industry: "print",
		});
		const cancelled = controller.cancel(context, conversationId, { requestId: "cancel-request" });
		expect(requirement(cancelled)).toMatchObject({
			state: { status: "cancelled", stageStatus: "cancelled" },
			job: { status: "cancelled" },
			metrics: {
				cancelled: true,
				queue: { deliveryCount: 0, recoveryCount: 0 },
			},
		});
		const repeated = controller.cancel(context, conversationId, { requestId: "cancel-request" });
		expect(requirement(repeated).state.aggregateVersion).toBe(requirement(cancelled).state.aggregateVersion);
		expect(await scheduler.runNext()).toEqual({ status: "idle" });

		const cancellationRestoreEngine = new ProposalRunEngine(
			new FileEnterpriseEventStore(eventPath),
			"requirement-brief",
		);
		const restored = cancellationRestoreEngine.load({
			tenantId: context.tenantId,
			workspaceId: context.workspaceId,
			runId: requirement(cancelled).runId,
		});
		expect(restored).toMatchObject({ status: "cancelled", stageStatus: "cancelled" });

		const reopened = controller.start(context, conversationId, {
			requestId: "reopen-request",
			industry: "print",
		});
		expect(requirement(reopened)).toMatchObject({
			state: { status: "running", stageStatus: "running" },
			job: { status: "queued" },
		});
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
		const reviewed = requirement(controller.get(context, conversationId));
		expect(reviewed).toMatchObject({
			state: { stageStatus: "needs_input", currentProposal: { version: 1 } },
			metrics: { cancelled: false },
		});
		const eventTypes = cancellationRestoreEngine.readEvents(reviewed.state).map((event) => event.data.type);
		expect(eventTypes.indexOf("stage.cancelled")).toBeLessThan(eventTypes.lastIndexOf("stage.restarted"));
	});

	it("versions the current attachment set into Requirement source lineage", () => {
		const { attachments, controller, conversationId } = harness();
		attachments.put({
			...context,
			conversationId,
		}, {
			requestId: "attachment-upload",
			name: "customer-notes.txt",
			mediaType: "text/plain",
			content: Buffer.from("delivery date: 2026-10-01"),
		});

		const started = requirement(controller.start(context, conversationId, {
			requestId: "requirement-with-attachment",
			industry: "print",
		}));

		expect(started.state.facts.customer_attachments).toMatchObject({
			version: 1,
			status: "unverified",
			sourceType: "source_document",
		});
		expect(started.state.facts.customer_attachments.sourceRef).toContain(
			`conversation:${conversationId}:attachments:`,
		);
	});

	it("passes the frozen image snapshot through the Requirement Worker without storing Base64", async () => {
		const { attachments, controller, conversationId, scheduler, sessions } = harness();
		attachments.put({
			...context,
			conversationId,
		}, {
			requestId: "reference-upload",
			name: "reference.png",
			mediaType: "image/png",
			content: Buffer.from("reference-image"),
		});
		const started = requirement(controller.start(context, conversationId, {
			requestId: "requirement-with-image",
			industry: "print",
		}));

		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
		const runtimeSession = sessions.listSessions(context).find((session) => session.runId === started.runId && session.messages.some((message) => message.attachments?.length));
		const storedAttachments = runtimeSession?.messages.flatMap((message) => message.attachments ?? []) ?? [];
		expect(storedAttachments).toEqual([
			expect.objectContaining({
				name: "reference.png",
				mediaType: "image/png",
			}),
		]);
		expect(storedAttachments.every((attachment) => attachment.data === undefined)).toBe(true);
	});
});

function reportHarness() {
	let binding: SourceReportBinding = { schemaVersion: "source-report-binding.v1", selectionRevision: 1, status: "selected", version: 1, reportDigest: "a".repeat(64), artifactRef: "artifact://source-report/v1", available: true };
	const report: SourceReportArtifact = { schemaVersion: "source-report.v1", version: 1, title: "Untrusted source", status: "unverified", createdAt: "2026-10-19T00:00:00Z", sources: [], limitations: ["Source claims require confirmation"] };
	let plan!: PlanWorkspace, unavailable = false;
	const h = harness({ readPlan: () => plan, reports: {
		binding: scope => { expect(scope.runId).toBe(h.conversationId); if (unavailable) throw new Error("store unavailable"); return structuredClone(binding); },
		read: () => structuredClone(report),
	} });
	const conversation = (h.conversations.get(context, h.conversationId).body as { conversation: ConversationView }).conversation;
	const replan = (reportBound = true) => {
		const version = (plan?.versions.at(-1)?.version ?? 0) + 1;
		plan = { revision: version, mode: "plan", versions: [{ version, objective: "核对未验证的来源", context: JSON.stringify({ attachments: [], ...(reportBound ? { sourceReport: binding } : {}) }), conversationRevision: conversation.revision, status: "completed", createdAt: report.createdAt, actorId: context.actorId, generation: 2, calls: 2,
			spec: { summary: "资料待核对", tasks: [{ title: "核对", objective: "读取资料", tools: [] }] }, approval: { actorId: context.actorId, version, at: report.createdAt },
			children: [{ taskIndex: 0, sessionId: "report-session", executionId: "report-execution", result: { summary: "数量可能为 5000", evidence: ["artifact://source-report/v1"], limitations: ["待人工确认"] } }],
		}] };
		return version;
	};
	replan();
	return { ...h, replan, setUnavailable: () => { unavailable = true; }, change: (change: "clear" | "reselect" | "withdraw") => {
		if (change === "clear") binding = { schemaVersion: "source-report-binding.v1", selectionRevision: binding.selectionRevision + 1, status: "cleared" };
		else if (binding.status === "selected") binding = { ...binding, ...(change === "reselect" ? { selectionRevision: binding.selectionRevision + 1 } : { available: false }) };
	} };
}

it.each(["clear", "reselect", "withdraw"] as const)("invalidates report-dependent artifacts and approvals after %s, including stale browsers, restart and historical export", async change => {
	const h = reportHarness();
	await readyForApproval(false, h, 1);
	const before = requirement(h.controller.get(context, h.conversationId)), version = before.state.currentProposal!.version;
	expect(before.state.facts.report_source).toMatchObject({ status: "unverified", sourceType: "source_document", sourceRef: "artifact://source-report/v1" });
	expect(h.controller.recordFact(context, h.conversationId, { requestId: "forge-report", key: "report_source", value: "forged" }).status).toBe(400);
	const approved = h.controller.resolveApproval(context, h.conversationId, { requestId: "approve-report", decision: "approved", ...approvalReview(before) });
	expect(approved.status).toBe(202); await h.scheduler.runNext();
	expect(h.controller.delivery(context, h.conversationId, version).status).toBe(200);
	const saved = h.artifacts.readJson({ ...before.state, artifactId: "requirement-brief", artifactVersion: version });
	h.change(change);
	expect(h.controller.resolveApproval(context, h.conversationId, { requestId: "stale-browser", decision: "approved", ...approvalReview(before) })).toMatchObject({ status: 409, body: { code: "report_source_stale" } });
	const stale = requirement(h.controller.get(context, h.conversationId));
	expect(stale.state).toMatchObject({ stageStatus: "revision_required", currentProposal: { freshness: "stale" }, approval: { status: "superseded" } });
	expect(stale.state.facts).toEqual(before.state.facts);
	expect(requirement(h.controller.get(context, h.conversationId)).state.aggregateVersion).toBe(stale.state.aggregateVersion);
	expect(h.reopen().delivery(context, h.conversationId, version)).toMatchObject({ status: 409, body: { code: "report_source_stale" } });
	expect(h.artifacts.readJson({ ...before.state, artifactId: "requirement-brief", artifactVersion: version })).toEqual(saved);
	expect(h.controller.get({ ...context, tenantId: "other" }, h.conversationId).status).toBe(404);
	// A replacement with no report records the cleared dependency, while old versions keep theirs.
	const newVersion = h.replan(false);
	expect(h.controller.start(context, h.conversationId, { requestId: "new-plan-source", industry: "print", planVersion: newVersion }).status).toBe(202);
	expect((await h.scheduler.runNext()).status).toBe("completed");
	expect(requirement(h.controller.get(context, h.conversationId)).state.facts.report_source.sourceRef).toBe("report:none");
	expect(h.controller.delivery(context, h.conversationId, version).status).toBe(409);
});

it("preserves approvals when the report store is unavailable and refuses stale report imports", async () => {
	const h = reportHarness(); await readyForApproval(false, h, 1);
	const before = requirement(h.controller.get(context, h.conversationId));
	h.setUnavailable();
	expect(h.controller.get(context, h.conversationId).status).toBe(500);
	expect(h.engine.load(before.state)).toEqual(before.state);
	const stale = reportHarness(); stale.change("reselect");
	expect(stale.controller.start(context, stale.conversationId, { requestId: "stale-import", industry: "print", planVersion: 1 })).toMatchObject({ status: 400, body: { code: "report_source_stale" } });
});

it("fences a late requirement worker result after its selected report becomes unavailable", async () => {
	const h = reportHarness(), execute = h.runtime.executeTurn.bind(h.runtime);
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
	h.runtime.executeTurn = async (...args) => { const result = await execute(...args); enter(); await held; return result; };
	expect(h.controller.start(context, h.conversationId, { requestId: "held-report", industry: "print", planVersion: 1 }).status).toBe(202);
	const pending = h.scheduler.runNext();
	try {
		await Promise.race([entered, pending.then(() => { throw new Error("Worker ended before the injected hold"); })]);
		h.change("withdraw");
		h.controller.reconcileReportSources(context, h.conversationId);
	} finally { release(); }
	expect((await pending).status).toBe("dead_letter");
	const after = requirement(h.controller.get(context, h.conversationId));
	expect(after.state.currentProposal).toBeUndefined();
	expect(after.state.approval).toBeUndefined();
	expect(after.state.facts.report_source.status).toBe("unverified");
});
