import { afterEach, expect, it, vi } from "vitest";
import type { AggregateScope, FactVersionState, ProposalRunState } from "../../src/enterprise/contracts";
import type { EvidenceSelection } from "../../src/enterprise/knowledge";
import { SourceReportError, type SourceReportBinding } from "../../src/enterprise/sourceReport";
import { TaskCheckpointError } from "../../src/enterprise/taskCheckpoint";
import { SkillRegistry } from "../../src/agent/skills";
import type { RuntimeTurnRequest } from "../../src/runtime/contracts";
import { PersonalMemoryService } from "../enterprise/personalMemoryService";
import { PersonalMemoryStore } from "../enterprise/personalMemoryStore";
import { workspaceRunId } from "../enterprise/proposalWorkspaceApi";
import { checkpointSourceDigest, TaskCheckpointStore } from "../enterprise/taskCheckpointStore";
import { BlackxAgentRuntime } from "../runtime/agentRuntime";
import type { StoredAgentSession } from "../runtime/fileAgentStateStore";
import { createPackagingTaskContext } from "./packagingTaskContext";

const identity = { tenantId: "tenant", workspaceId: "workspace", actorId: "owner" };
const scope = { ...identity, runId: "conversation" };
const at = "2026-10-23T10:00:00.000Z";
const report: SourceReportBinding = { schemaVersion: "source-report-binding.v1", selectionRevision: 1, status: "selected", version: 1, reportDigest: "a".repeat(64), artifactRef: "artifact://source-report/v1", available: true };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function request(overrides: Partial<RuntimeTurnRequest> = {}): RuntimeTurnRequest {
	return { ...scope, stageId: "conversation", input: "Review packaging", fallbackOutput: "", idempotencyKey: "turn", policy: { sandboxMode: "read-only", approvalPolicy: "never", timeoutMs: 5000 }, ...overrides };
}
function fact(key: string, value: string, sourceRef = "human-input"): FactVersionState {
	return { key, value, sourceRef, version: 1, status: "unverified", sourceType: "user_input" };
}
function fixture() {
	const session: StoredAgentSession = { ...scope, sessionId: scope.runId, revision: 1, updatedAt: at,
		messages: [{ role: "user", content: "Old working message" }], transcript: [{ role: "user", kind: "dialogue", messageId: "user-1", content: "Compare packaging" }] };
	const sessions = { getSession: vi.fn<Parameters<typeof createPackagingTaskContext>[0]["sessions"]["getSession"]>(() => session) };
	const checkpoints = new TaskCheckpointStore(":memory:");
	const memoryStore = new PersonalMemoryStore(":memory:", () => true);
	cleanups.push(() => checkpoints.close(), () => memoryStore.close());
	const memory = new PersonalMemoryService(memoryStore, sessions);
	const memoryContext = vi.spyOn(memory, "context");
	const state: ProposalRunState = { ...scope, aggregateVersion: 0, status: "created", stageStatus: "pending", facts: {}, factVersions: {}, proposalVersions: [] };
	const selection: EvidenceSelection = { schemaVersion: "evidence-selection.v1", version: 1, selectedBy: identity.actorId, selectedAt: at, ids: ["evidence-1"], applicability: { region: "HK", asOf: "2026-10-23" }, digest: "evidence-digest" };
	const deps = {
		identity, sessions, checkpoints, memory,
		knowledge: { selected: vi.fn(() => ({ selection, hits: [], unavailable: [] as string[] })) },
		requirements: { load: vi.fn((target: AggregateScope) => ({ ...state, ...target })), readEvents: vi.fn(() => []) },
		attachments: { digest: vi.fn(() => "current-attachments"), list: vi.fn(() => [{ attachmentId: "attachment-a", conversationId: scope.runId, name: "brief.txt", mediaType: "text/plain", size: 20, sha256: "b".repeat(64), kind: "text" as const, modelInput: "text_extracted" as const, sourceRef: "attachment://conversation/attachment-a", createdAt: at }]) },
		reports: { binding: vi.fn(() => report), assertContext: vi.fn<Parameters<typeof createPackagingTaskContext>[0]["reports"]["assertContext"]>() },
	};
	return { context: createPackagingTaskContext(deps), deps, session, state, memoryStore, memoryContext };
}
function confirmMemory(store: PersonalMemoryStore) {
	const proposed = store.propose(identity, "propose", { topic: "Report style", content: "Use concise Chinese" }, { runId: scope.runId, kind: "user_entry", digest: "c".repeat(64) });
	return store.decide(identity, "confirm", proposed.id, proposed.revision, "confirm");
}

it("joins current packaging sources and marks changed attachments without promoting facts", () => {
	const h = fixture();
	h.state.aggregateVersion = 3;
	h.state.facts = { quantity: fact("quantity", "5000", "attachment://conversation/attachment-a"), customer_attachments: fact("customer_attachments", "old-attachments", "attachment-set") };
	const value = JSON.parse(h.context.conversation(scope).content);
	expect(value).toMatchObject({ objective: "Compare packaging", userDecisions: [{ messageId: "user-1" }], stage: { runId: workspaceRunId(scope, scope.runId, "requirement"), aggregateVersion: 3 }, knowledge: { ids: ["evidence-1"] }, sourceReport: report,
		attachments: [{ name: "brief.txt", sourceRef: "attachment://conversation/attachment-a", sha256: "b".repeat(64) }] });
	expect(value.facts).toContainEqual(expect.objectContaining({ key: "quantity", value: "5000", status: "unverified", sourceValidity: "stale" }));
	expect(value.unresolved).toContainEqual({ key: "quantity", version: 1, reason: "confirmation_required" });
	expect(value.unresolved).not.toContainEqual(expect.objectContaining({ key: "customer_attachments", reason: "confirmation_required" }));
	expect(h.memoryContext).not.toHaveBeenCalled();
	h.session.transcript = undefined;
	h.state.aggregateVersion = 0;
	expect(JSON.parse(h.context.conversation(scope).content)).toMatchObject({ objective: "Old working message", stage: { status: "conversation" } });
});

it("rejects foreign scopes before reading stores and preserves unavailable-source failures", () => {
	const h = fixture();
	for (const target of [{ ...scope, tenantId: "other" }, { ...scope, workspaceId: "other" }]) expect(() => h.context.conversation(target)).toThrow(expect.objectContaining({ code: "permission_denied" }));
	expect(h.deps.sessions.getSession).not.toHaveBeenCalled();
	expect(h.deps.knowledge.selected).not.toHaveBeenCalled();
	h.deps.sessions.getSession.mockReturnValueOnce(undefined);
	expect(() => h.context.conversation(scope)).toThrow(expect.objectContaining({ code: "conversation_not_found", status: 404 }));
	h.deps.knowledge.selected.mockReturnValueOnce({ selection: h.deps.knowledge.selected().selection, hits: [], unavailable: ["evidence-1"] });
	expect(() => h.context.conversation(scope)).toThrow(expect.objectContaining({ code: "evidence_unavailable", status: 409 }));
	const cause = new TaskCheckpointError("task_checkpoint_source_changed");
	vi.spyOn(h.deps.checkpoints, "active").mockImplementationOnce(() => { throw cause; });
	expect(() => h.context.conversation(scope)).toThrow(expect.objectContaining({ code: "context_failure", retryable: false, cause }));
});

it.each(["plan", "subagent-1", "subagent-20"])("revalidates the selected report before memory for %s", (stageId) => {
	const h = fixture();
	const base = h.context.conversation(scope);
	h.context.read(request({ stageId, taskContext: base }));
	expect(h.deps.reports.assertContext).toHaveBeenCalledWith(expect.objectContaining({ stageId, actorId: identity.actorId, runId: scope.runId }), base.content);
	h.memoryContext.mockClear();
	const cause = new SourceReportError("report_source_unavailable");
	h.deps.reports.assertContext.mockImplementationOnce(() => { throw cause; });
	expect(() => h.context.read(request({ stageId, taskContext: base }))).toThrow(expect.objectContaining({ code: "context_failure", retryable: false, cause }));
	expect(h.memoryContext).not.toHaveBeenCalled();
});

it.each(["requirement-brief", "requirement-brief-review-call", "requirement-brief-revision-call"])("checks the original conversation and owner for %s", (stageId) => {
	const h = fixture();
	h.state.facts = { report_source: fact("report_source", JSON.stringify(report), "report:1"), customer_brief: fact("customer_brief", "Package request", "conversation:original:revision:3") };
	const turn = request({ stageId, actorId: "blackx-worker", runId: "requirement-run" });
	const context = h.context.read(turn)!;
	expect(JSON.parse(context.content).sourceReport).toEqual(report);
	expect(h.deps.reports.assertContext).toHaveBeenCalledWith(expect.objectContaining({ runId: "original", actorId: identity.actorId, stageId }), expect.any(String));
	const cause = new SourceReportError("report_selection_changed");
	h.deps.reports.assertContext.mockImplementationOnce(() => { throw cause; });
	expect(() => h.context.read(turn)).toThrow(expect.objectContaining({ code: "context_failure", retryable: false, cause }));
	h.state.facts.customer_brief.sourceRef = "missing";
	expect(() => h.context.read(turn)).toThrow("Report conversation is unavailable");
	h.state.facts.report_source.sourceRef = "report:none";
	h.deps.reports.assertContext.mockClear();
	h.context.read(turn);
	expect(h.deps.reports.assertContext).not.toHaveBeenCalled();
});

it.each(["subagent-a", "subagent-1-extra", "requirement-brief-review", "requirement-brief-revision-call-extra", "proposal"])("does not broaden stage policies to %s", (stageId) => {
	const h = fixture();
	const base = { content: "{}", binding: "base" };
	expect(h.context.read(request({ actorId: "blackx-worker", stageId, taskContext: base }))).toBe(base);
	expect(h.deps.reports.assertContext).not.toHaveBeenCalled();
	expect(h.deps.requirements.load).not.toHaveBeenCalled();
	expect(h.memoryContext).not.toHaveBeenCalled();
});

it("delegates memory only to the local owner or the exact requirement worker stage", () => {
	const h = fixture();
	confirmMemory(h.memoryStore);
	const base = { content: "{}", binding: "base" };
	for (const turn of [request({ stageId: "proposal", taskContext: base }), request({ actorId: "blackx-worker", stageId: "requirement-brief", taskContext: base })]) {
		expect(h.context.read(turn)?.content).toContain("Use concise Chinese");
	}
	h.memoryContext.mockClear();
	for (const changes of [{ actorId: "other" }, { tenantId: "other" }, { workspaceId: "other" }, { actorId: "blackx-worker", stageId: "requirement-brief-review-call" }, { actorId: "blackx-worker", stageId: "requirement-brief-revision-call" }, { actorId: "blackx-worker", stageId: "plan" }]) {
		expect(h.context.read(request({ stageId: "proposal", taskContext: base, ...changes }))).toBe(base);
	}
	expect(h.memoryContext).not.toHaveBeenCalled();
});

it("keeps checkpoint history and refreshes memory bindings through the new seam", () => {
	const h = fixture(), transcript = h.session.transcript!;
	const checkpoint = { objective: "Compare recyclable packaging", constraints: ["No PVC"], openQuestions: [], progressNotes: "No production approval" };
	h.deps.checkpoints.command(scope, identity.actorId, transcript, { action: "propose", requestId: "checkpoint-propose", revision: 0, sourceDigest: checkpointSourceDigest(transcript), draft: checkpoint });
	h.deps.checkpoints.command(scope, identity.actorId, transcript, { action: "confirm", requestId: "checkpoint-confirm", revision: 1, confirmed: true });
	transcript.push({ role: "user", kind: "dialogue", messageId: "user-2", content: "Keep the supplier question open" });
	h.state.aggregateVersion = 1; h.state.facts = { quantity: { ...fact("quantity", "5000"), status: "verified" } };
	const active = confirmMemory(h.memoryStore), before = h.context.read(request())!;
	expect(JSON.parse(before.content)).toMatchObject({ objective: checkpoint.objective, checkpoint, userDecisions: [{ messageId: "user-2" }], facts: [{ key: "quantity", status: "verified", value: "5000" }] });
	h.memoryStore.decide(identity, "forget", active.id, active.revision, "forget");
	const after = h.context.read(request())!;
	expect(after.binding).not.toBe(before.binding);
	expect(after.historyBinding).not.toBe(before.historyBinding);
	expect(after.content).not.toContain("Use concise Chinese");
	expect(JSON.parse(after.content).facts).toEqual(JSON.parse(before.content).facts);
	expect(transcript).toHaveLength(2);
	transcript[0].content = "Changed confirmed source";
	expect(() => h.context.read(request())).toThrow(expect.objectContaining({ code: "context_failure", cause: expect.any(TaskCheckpointError) }));
});

it.each(["report", "memory"])("stops before a tool when %s is revoked during a model call", async (changed) => {
	const h = fixture(), active = confirmMemory(h.memoryStore);
	const base = h.context.conversation(scope), execute = vi.fn(async () => ({ ok: true }));
	const runtime = new BlackxAgentRuntime({ skills: new SkillRegistry(), readTaskContext: h.context.read,
		provider: { generate: async () => {
			if (changed === "memory") h.memoryStore.decide(identity, "forget", active.id, active.revision, "forget");
			else h.deps.reports.assertContext.mockImplementation(() => { throw new SourceReportError("report_source_unavailable"); });
			return { text: "", toolCalls: [{ id: "call", name: "write_result", input: {} }], usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
		} },
		tools: [{ name: "write_result", description: "Record result", execution: "host", inputSchema: { type: "object" }, risk: "write", idempotent: true, maxResultChars: 1000, timeoutMs: 1000, validate: () => true, execute }],
	});
	await expect(runtime.executeTurn(request({ stageId: "plan", taskContext: base, allowedTools: ["write_result"], policy: { sandboxMode: "workspace-write", approvalPolicy: "never", timeoutMs: 5000 } }))).rejects.toMatchObject({ code: "context_failure" });
	expect(execute).not.toHaveBeenCalled();
});
