import { TaskFileError } from "../runtime/localFileAccess";
import { RuntimeFailure } from "../../src/runtime/contracts";
import { validateCompletedPlanSources } from "../runtime/completedPlanSources";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentMessage, AgentToolApprovalPort } from "../../src/agent/contracts";
import { AgentStateStoreError } from "../../src/agent/state";
import { SkillRegistry } from "../../src/agent/skills";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { AgentPlanStore } from "./agentPlanStore";
import { AgentPlanWorkflow, type PlanWorkflowOptions } from "./agentPlanWorkflow";
import { StageJobScheduler } from "../workers/stageJobScheduler";
import { BlackxAgentRuntime } from "../runtime/agentRuntime";
import { ConversationFileService } from "../runtime/conversationFiles";
import { FileAgentStateStore } from "../runtime/fileAgentStateStore";

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
const scope = { tenantId: "tenant", workspaceId: "workspace", runId: "source-plan" };
const graph = { summary: "Read then summarize", tasks: [{ title: "Summary", objective: "SUMMARY", tools: [], dependsOn: [1, 2] }, { title: "Source", objective: "READ", tools: ["file_read"] }, { title: "Independent", objective: "SIDE", tools: [] }] };
const result = { summary: "Unverified report", evidence: ["local fixture"], limitations: ["Review required"], assessment: { decision: "continue", reason: "Read source" } };
async function fixture(mode: "live" | "externalized" | "readback" | "compacted" | "history" | "planner" | "pruned" = "live", finish = true, spec = graph) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "packx-completed-sources-")));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "source.txt"); writeFileSync(path, "ORIGINAL_SOURCE");
	const state = new FileAgentStateStore(join(root, "state")), files = new ConversationFileService(join(root, "files"), () => {});
	const store = new AgentPlanStore(join(root, "plans.sqlite")); cleanup.push(() => store.close());
	if (mode === "history") {
		const input = { path, expectedSha256: files.readLocal({ ...scope, actorId: "user" }, path).sha256, content: "APPROVED_UPDATE" };
		const request: Parameters<AgentToolApprovalPort["authorize"]>[0] = { ...scope, actorId: "user", stageId: "conversation", executionId: "setup", toolCallId: "setup", tool: "file_write", risk: "write", input, idempotencyKey: "setup" };
		const waiting = files.authorize(request); files.decide(request, files.list(request).approvals[0].id, "approved");
		files.apply("write", input, { ...request, approvalId: (await waiting).approvalId, signal: new AbortController().signal });
	}
	const tools = files.tools().map(tool => ({ ...tool, execute: vi.fn(tool.execute), ...(mode === "externalized" ? { maxResultChars: 40 } : {}) }));
	let calls = 0;
	const runtime = new BlackxAgentRuntime({ sessions: state, snapshots: state, traces: state, tools, skills: new SkillRegistry(), provider: { async generate(request) {
		calls++;
		const planning = request.messages.some(message => message.content.includes("Plan only. Do not execute"));
		const input = JSON.parse(request.messages.findLast(message => message.role === "user" && message.kind !== "task_context")!.content);
		const read = (mode === "planner" ? planning : !planning && input.objective === "READ") && !request.messages.some(message => message.role === "tool");
		let call = { id: "file", name: "file_read", input: { path, ...(mode === "history" ? { version: 1 } : {}) } } as { id: string; name: string; input: object };
		if (read && ["readback", "compacted"].includes(mode)) {
			const sessionId = store.read(scope).versions[0].taskRuns!.find(run => run.taskIndex === 1)!.sessionId;
			const messages: AgentMessage[] = [{ role: "assistant", content: "", toolCalls: [call] }, { role: "tool", toolCallId: call.id, content: JSON.stringify(files.readLocal({ ...scope, actorId: "user" }, path)), sourceTool: { name: call.name, input: call.input } }];
			const archive = (snapshotId: string, messages: AgentMessage[]) => state.put({ ...scope, sessionId, schemaVersion: "context-snapshot.v2", snapshotId, messages, iteration: 1, skills: [], estimatedChars: 0, estimatedTokens: 0, removedMessages: 0, createdAt: "2026-10-20T00:00:00Z" });
			if (mode === "compacted") { archive("file-body", messages); archive("historical-source", [{ role: "user", kind: "summary", content: "UNVERIFIED_SUMMARY", readDependencies: ["file-body"] }]); }
			else archive("historical-source", messages);
			call = { id: "history", name: "context_read", input: { sourceRef: "historical-source" } };
		}
		const more = mode === "pruned" && !planning && input.objective === "READ" && !read && !request.messages.some(message => message.role === "tool" && message.toolCallId === "second-read");
		return { text: read || more ? "" : JSON.stringify(planning ? spec : result), toolCalls: more ? [{ id: "second-read", name: "file_read", input: { path } }] : read ? [call] : [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
	} } });
	const queue = new InMemoryStageJobQueue();
	const options: PlanWorkflowOptions = { validateCompletedSources: (scope, plan, signal) => validateCompletedPlanSources(state, tools, scope, plan, signal), readInput: () => ({ revision: 1, context: JSON.stringify({ schemaVersion: "task-context.v1", scope, facts: [], artifacts: [], unresolved: [] }) }), readTools: ["file_read"], executionTools: ["file_read"], instructions: [], maxReadConcurrency: 2 };
	const workflow = new AgentPlanWorkflow(store, queue, runtime, options);
	const scheduler = new StageJobScheduler(queue, { workerId: "fixture", handlers: { "plan-subagents": (lease, signal, check) => workflow.execute(lease, signal, check) }, dispatchOutbox: () => workflow.reconcile() });
	let id = 0;
	const command = (body: object) => workflow.command(scope, "user", { requestId: `request-${++id}`, revision: store.read(scope).revision, ...body });
	command({ action: "mode", mode: "plan" }); command({ action: "generate", objective: "Read selected local file" }); await scheduler.runNext(); command({ action: "confirm", version: 1, confirmed: true });
	await scheduler.runNext(); if (finish) await scheduler.runNext();
	expect(store.read(scope).versions[0].status).toBe(finish ? "completed" : "running");
	return { root, path, state, files, store, workflow, options, queue, runtime, scheduler, tools, command, calls: () => calls };
}

it.each(["live", "externalized", "readback", "compacted", "planner"] as const)("invalidates completed %s file evidence without another model or tool execution", async mode => {
	const h = await fixture(mode), before = h.store.read(scope), calls = h.calls();
	const executions = h.tools.map(tool => tool.execute.mock.calls.length);
	writeFileSync(h.path, "REPLACED_SOURCE");
	const stale = await h.workflow.read(scope);
	expect(stale.versions[0].status).toBe("stale");
	expect(stale.versions[0].children).toEqual(before.versions[0].children);
	expect(h.calls()).toBe(calls);
	expect(await h.workflow.read(scope)).toEqual(stale);
	writeFileSync(h.path, "ORIGINAL_SOURCE"); expect(await h.workflow.read(scope)).toEqual(stale);
	expect(h.tools.map(tool => tool.execute.mock.calls.length)).toEqual(executions);
});


it("preserves a permitted historical backup despite current file edits, then invalidates it on permission revocation", async () => {
	const h = await fixture("history"), before = h.store.read(scope), calls = h.calls();
	writeFileSync(h.path, "NEWER_EXTERNAL_EDIT");
	expect(await h.workflow.read(scope)).toEqual(before);
	const denied = new ConversationFileService(join(h.root, "files"), () => {}, Date.now, [h.path]);
	h.options.validateCompletedSources = (scope, plan, signal) => validateCompletedPlanSources(h.state, denied.tools(), scope, plan, signal);
	expect((await h.workflow.read(scope)).versions[0].status).toBe("stale");
	expect(h.calls()).toBe(calls);
});

it("detects a missing file after reopening stores and appends only one stale event for overlapping readers", async () => {
	const h = await fixture(), store = new AgentPlanStore(join(h.root, "plans.sqlite")); cleanup.push(() => store.close());
	const state = new FileAgentStateStore(join(h.root, "state")), before = h.store.read(scope), calls = h.calls();
	const workflow = new AgentPlanWorkflow(store, h.queue, h.runtime, { ...h.options, validateCompletedSources: (scope, plan, signal) => validateCompletedPlanSources(state, h.tools, scope, plan, signal) });
	rmSync(h.path);
	const [first, second] = await Promise.all([workflow.read(scope), workflow.read(scope)]);
	expect(first).toEqual(second); expect(first.revision).toBe(before.revision + 1); expect(first.versions[0].status).toBe("stale"); expect(h.calls()).toBe(calls);
});

it("does not send completed upstream bytes to a dependent node after the source changes", async () => {
	const h = await fixture("live", false), calls = h.calls();
	writeFileSync(h.path, "REPLACED_SOURCE");
	await h.scheduler.runNext();
	expect(h.store.read(scope).versions[0]).toMatchObject({ status: "failed", failure: { code: "context_failure", retryable: false } });
	expect(h.store.read(scope).versions[0].children.map(child => child.taskIndex).sort()).toEqual([1, 2]); expect(h.calls()).toBe(calls);
});

it.each(["store", "tool", "quota", "deep_tool", "missing_receipt", "limit"] as const)("blocks use without falsely invalidating history on %s review failure", async mode => {
	const h = await fixture(), before = h.store.read(scope), calls = h.calls();
	if (mode === "store") vi.spyOn(h.state, "read").mockImplementation(() => { throw new AgentStateStoreError("unavailable", "fixture unavailable"); });
	if (mode === "tool") h.tools.find(tool => tool.name === "file_read")!.validateContextResult = () => { throw new Error("fixture storage outage"); };
	if (mode === "quota") h.tools.find(tool => tool.name === "file_read")!.validateContextResult = () => { throw new TaskFileError("file_quota_exceeded", "fixture storage quota", 413); };
	if (mode === "deep_tool") h.tools.find(tool => tool.name === "file_read")!.validateContextResult = () => {
		let error: Error = new Error("fixture storage outage");
		for (let depth = 0; depth < 20; depth++) error = new RuntimeFailure("context_failure", "wrapped source check", false, { cause: error });
		throw error;
	};
	if (mode === "missing_receipt") vi.spyOn(h.state, "listTraces").mockReturnValue(h.state.listTraces(scope).filter(trace => trace.stageId === "plan"));
	if (mode === "limit") {
		const read = h.state.read.bind(h.state);
		vi.spyOn(h.state, "read").mockImplementation((scope, ref) => ({ ...read(scope, ref), messages: [{ role: "user", content: "x".repeat(2_000_001) }] }));
	}
	await expect(h.workflow.read(scope)).rejects.toMatchObject({ code: mode === "missing_receipt" ? "plan_completion_evidence_missing" : mode === "limit" ? "plan_source_review_limit" : "plan_source_review_unavailable" });
	expect(h.store.read(scope)).toEqual(before); expect(h.calls()).toBe(calls);
});

it("fences an old asynchronous review when the user creates a new plan", async () => {
	const h = await fixture(), before = h.store.read(scope); let release!: () => void;
	h.options.validateCompletedSources = async () => { await new Promise<void>(resolve => { release = resolve; }); throw new RuntimeFailure("context_failure", "old source changed", false); };
	const pending = h.workflow.read(scope);
	h.command({ action: "generate", objective: "New source task" }); release();
	const current = await pending;
	expect(current.versions[1].status).toBe("planning"); expect(current.versions[0]).toEqual(before.versions[0]);
});


it("bounds an uncooperative source check and ignores its late completion", async () => {
	const h = await fixture(), before = h.store.read(scope), controller = new AbortController(); let release!: () => void;
	vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
	h.options.validateCompletedSources = async () => { await new Promise<void>(resolve => { release = resolve; }); };
	const pending = h.workflow.read(scope);
	controller.abort(new Error("fixture deadline"));
	await expect(pending).rejects.toMatchObject({ code: "plan_source_review_unavailable", status: 503 });
	expect(h.store.read(scope)).toEqual(before);
	release(); await Promise.resolve(); expect(h.store.read(scope)).toEqual(before);
});


it.each(["current", "legacy"] as const)("rejects %s tool evidence when its source validator is no longer permitted", async mode => {
	const h = await fixture(), calls = h.calls();
	if (mode === "legacy") {
		const read = h.state.read.bind(h.state);
		vi.spyOn(h.state, "read").mockImplementation((scope, ref) => ({ ...read(scope, ref), messages: read(scope, ref).messages.map(({ sourceTool: _source, ...message }) => message) }));
	}
	h.options.validateCompletedSources = (scope, plan, signal) => validateCompletedPlanSources(h.state, [], scope, plan, signal);
	expect((await h.workflow.read(scope)).versions[0].status).toBe("stale"); expect(h.calls()).toBe(calls);
});

it("does not resolve another tenant's completion traces or file snapshots", async () => {
	const h = await fixture(), calls = h.calls();
	await expect(validateCompletedPlanSources(h.state, h.tools, { ...scope, tenantId: "other" }, h.store.read(scope).versions[0], new AbortController().signal)).rejects.toMatchObject({ code: "plan_completion_evidence_missing" });
	expect(h.calls()).toBe(calls);
});


it("uses the same read-only source review for a new single-node plan without migrating old serial state", async () => {
	const h = await fixture("live", true, { summary: "Single read", tasks: [graph.tasks[1]] });
	const plan = h.store.read(scope).versions[0];
	expect(plan.readConcurrency).toBe(2); expect(plan.children).toHaveLength(1); expect(plan.taskRuns).toHaveLength(1);
	writeFileSync(h.path, "CHANGED_SINGLE_SOURCE");
	expect((await h.workflow.read(scope)).versions[0].status).toBe("stale");
});


it("rejects a source review that exceeded elapsed time even before the timer callback can run", async () => {
	const h = await fixture(), before = h.store.read(scope);
	vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(5001);
	await expect(h.workflow.read(scope)).rejects.toMatchObject({ code: "plan_source_review_unavailable", status: 503 });
	expect(h.store.read(scope)).toEqual(before);
});


it("blocks missing archived provenance without presenting it as source withdrawal", async () => {
	const h = await fixture(), before = h.store.read(scope), read = h.state.read.bind(h.state);
	vi.spyOn(h.state, "read").mockImplementation((scope, ref) => ({ ...read(scope, ref), messages: [{ role: "tool", content: "ORPHANED_HISTORICAL_BODY" }] }));
	await expect(h.workflow.read(scope)).rejects.toMatchObject({ code: "plan_completion_evidence_missing" });
	expect(h.store.read(scope)).toEqual(before);
});


it("reviews earlier model input snapshots even when the final context no longer carries that read", async () => {
	const h = await fixture("pruned"), before = h.store.read(scope), trace = h.state.listTraces(scope).find(trace => trace.stageId === "subagent-1" && trace.status === "completed")!;
	expect(trace.events.filter(event => event.type === "context.snapshot.saved")).toHaveLength(3);
	const read = h.state.read.bind(h.state);
	// Fault injection: simulate an omitted final-context link; original intermediate evidence remains immutable.
	vi.spyOn(h.state, "read").mockImplementation((scope, ref) => {
		const snapshot = read(scope, ref);
		return ref !== trace.contextSnapshotId ? snapshot : { ...snapshot, messages: snapshot.messages.filter(message => !["file", "second-read"].includes(message.toolCallId ?? "") && message.sourceTool?.name !== "file_read" && !message.toolCalls?.some(call => call.name === "file_read")) };
	});
	writeFileSync(h.path, "CHANGED_EARLIER_SOURCE");
	expect((await h.workflow.read(scope)).versions[0].status).toBe("stale");
	expect(h.store.read(scope).versions[0].children).toEqual(before.versions[0].children);
});
