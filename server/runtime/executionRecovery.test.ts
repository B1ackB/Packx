import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentModelProvider, AgentToolApprovalPort, AgentToolExecutionRecord } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import { InMemoryAgentStateStore } from "../../src/agent/state";
import { BlackxAgentRuntime } from "./agentRuntime";
import { ConversationFileService } from "./conversationFiles";
import { FileAgentStateStore } from "./fileAgentStateStore";
import { LocalFileAccess } from "./localFileAccess";

const cleanup: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
const scope = { tenantId: "tenant", workspaceId: "workspace", runId: "task", actorId: "user" };
const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 };
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
type ApprovalRequest = Parameters<AgentToolApprovalPort["authorize"]>[0];
function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "packx-recovery-"))); cleanup.push(root);
	const filesRoot = join(root, "files"), ledgerRoot = join(root, "ledger"), path = join(root, "document.md");
	mkdirSync(join(root, "working")); writeFileSync(path, "before");
	let active = true;
	const assertActive = (value: typeof scope) => { if (!active || value.tenantId !== scope.tenantId || value.workspaceId !== scope.workspaceId || value.runId !== scope.runId || value.actorId !== scope.actorId) throw new Error("scope_denied"); };
	const files = new ConversationFileService(filesRoot, assertActive);
	const state = new FileAgentStateStore(ledgerRoot);
	const input = { path, expectedSha256: files.readLocal(scope, path).sha256, content: "after" };
	const request: ApprovalRequest = { ...scope, stageId: "conversation", tool: "file_write", toolCallId: "call", executionId: "original", risk: "write", idempotencyKey: "operation", input };
	return { root, path, files, state, input, request, restart: () => new ConversationFileService(filesRoot, assertActive), restartState: () => new FileAgentStateStore(ledgerRoot), deactivate: () => { active = false; } };
}
async function approve(files: ConversationFileService, request: ApprovalRequest) {
	const waiting = files.authorize(request);
	files.decide(scope, files.list(scope).approvals[0].id, "approved");
	return (await waiting).approvalId!;
}
async function reserve(h: ReturnType<typeof setup>) {
	const approvalId = await approve(h.files, h.request);
	const record: AgentToolExecutionRecord = { schemaVersion: "tool-execution.v1", ...scope, stageId: "conversation", tool: "file_write", toolCallId: "call", executionId: "original", risk: "write", idempotencyKey: "operation", inputDigest: sha(JSON.stringify(h.input)), approvalId, status: "started", startedAt: new Date().toISOString() };
	await h.state.claim(record);
	return record;
}
function crashAfterDiskWrite(files: ConversationFileService) {
	const internals = files as unknown as { save(scope: unknown, state: { approvals: Array<{ status: string }> }): void };
	const original = internals.save.bind(files);
	return vi.spyOn(internals, "save").mockImplementation((scope, state) => {
		if (state.approvals.some((approval) => approval.status === "applied")) throw new Error("crash_after_external_commit");
		original(scope, state);
	});
}

it.each(["started", "unknown"] as const)("repairs a %s ledger from an approved receipt, persists provenance, and never writes twice", async (status) => {
	const h = setup(), record = await reserve(h), writes = vi.spyOn(LocalFileAccess.prototype, "apply");
	h.files.apply("write", h.input, { ...h.request, approvalId: record.approvalId, signal: new AbortController().signal });
	if (status === "unknown") await h.state.complete(record, { status, result: "uncertain", resultDigest: sha("uncertain"), completedAt: new Date().toISOString() });
	const restarted = h.restartState(), expected = (await restarted.find(record))!;
	const outcome = (await h.restart().reconcile(expected, new AbortController().signal))!;
	const resolved = await restarted.resolve(expected, { ...outcome, resultDigest: sha(outcome.result), resolvedAt: new Date().toISOString() });
	expect(resolved).toMatchObject({ status: "succeeded", reconciliation: { previousStatus: status, evidenceRef: `file-approval:${record.approvalId}` } });
	expect(await restarted.resolve(expected, { ...outcome, resultDigest: sha(outcome.result), resolvedAt: new Date().toISOString() })).toEqual(resolved);
	expect((await h.restartState().find(record))?.status).toBe("succeeded");
	expect(writes).toHaveBeenCalledTimes(1); expect(readFileSync(h.path, "utf8")).toBe("after");
});

it("recovers a crash between external write and file receipt publication from the durable intended result", async () => {
	const h = setup(), record = await reserve(h), fault = crashAfterDiskWrite(h.files);
	expect(() => h.files.apply("write", h.input, { ...h.request, approvalId: record.approvalId, signal: new AbortController().signal })).toThrow("crash_after_external_commit");
	fault.mockRestore();
	const files = h.restart(), outcome = await files.reconcile(record, new AbortController().signal);
	expect(outcome?.evidenceRef).toBe(`file-approval:${record.approvalId}`);
	expect(files.list(scope).files).toHaveLength(2);
	expect(await files.reconcile(record, new AbortController().signal)).toEqual(outcome);
	expect(files.list(scope).files).toHaveLength(2);
	expect(files.read(scope, h.path, 1).content).toBe("before");
});

it("recovers an approved deletion after a crash and restores it only through a new approved write", async () => {
	const h = setup(), original = await reserve(h);
	h.files.apply("write", h.input, { ...h.request, approvalId: original.approvalId, signal: new AbortController().signal });
	const request = { ...h.request, tool: "file_delete", idempotencyKey: "remove", input: { path: h.path, expectedSha256: h.files.readLocal(scope, h.path).sha256 } };
	const approvalId = await approve(h.files, request), record = { ...original, tool: request.tool, idempotencyKey: request.idempotencyKey, inputDigest: sha(JSON.stringify(request.input)), approvalId };
	await h.state.claim(record);
	const internals = h.files as unknown as { save(scope: unknown, state: { approvals: Array<{ id: string; status: string }> }): void }, save = internals.save.bind(h.files);
	const fault = vi.spyOn(internals, "save").mockImplementation((scope, state) => { if (state.approvals.some((item) => item.id === approvalId && item.status === "applied")) throw new Error("delete_crash"); save(scope, state); });
	expect(() => h.files.apply("delete", request.input, { ...request, approvalId, signal: new AbortController().signal })).toThrow("delete_crash"); fault.mockRestore();
	const files = h.restart(), outcome = await files.reconcile(record, new AbortController().signal);
	expect(JSON.parse(outcome!.result)).toMatchObject({ status: "deleted", version: 3 });
	const restore = { ...h.request, idempotencyKey: "restore-deleted", input: { path: h.path, expectedSha256: null, sourceVersion: 2 } };
	const restored = files.apply("write", restore.input, { ...restore, approvalId: await approve(files, restore), signal: new AbortController().signal });
	expect(restored).toMatchObject({ version: 4, restoredFromVersion: 2 }); expect(readFileSync(h.path, "utf8")).toBe("after");
});

it("does not mark an unexecuted or externally changed operation successful", async () => {
	const h = setup(), record = await reserve(h);
	expect(await h.files.reconcile(record, new AbortController().signal)).toBeUndefined();
	const fault = crashAfterDiskWrite(h.files);
	expect(() => h.files.apply("write", h.input, { ...h.request, approvalId: record.approvalId, signal: new AbortController().signal })).toThrow(); fault.mockRestore();
	writeFileSync(h.path, "external edit");
	expect(await h.restart().reconcile(record, new AbortController().signal)).toBeUndefined();
	expect(readFileSync(h.path, "utf8")).toBe("external edit");
	expect((await h.state.find(record))?.status).toBe("started");
});

it("rejects cross-scope, wrong input, cancelled and tampered evidence", async () => {
	const h = setup(), record = await reserve(h);
	const result = h.files.apply("write", h.input, { ...h.request, approvalId: record.approvalId, signal: new AbortController().signal });
	for (const delta of [{ tenantId: "other" }, { workspaceId: "other" }, { runId: "other" }, { actorId: "other" }]) await expect(h.files.reconcile({ ...record, ...delta }, new AbortController().signal)).rejects.toThrow("scope_denied");
	expect(await h.files.reconcile({ ...record, inputDigest: "wrong" }, new AbortController().signal)).toBeUndefined();
	await expect(h.files.reconcile(record, AbortSignal.abort())).rejects.toThrow();
	const historical = h.files.read(scope, h.path, result.version);
	writeFileSync(historical.file.storagePath!, "tampered");
	await expect(h.files.reconcile(record, new AbortController().signal)).rejects.toThrow("校验");
	h.deactivate(); await expect(h.restart().reconcile(record, new AbortController().signal)).rejects.toThrow("scope_denied");
});

it.each(["memory", "file"])("rejects stale and cross-task reconciliation in the %s store", async (kind) => {
	const h = setup(), record = await reserve(h), store = kind === "file" ? h.state : new InMemoryAgentStateStore();
	await store.claim(record);
	const outcome = { result: "ok", resultDigest: sha("ok"), evidenceRef: "receipt:1", resolvedAt: new Date().toISOString() };
	await expect(store.resolve({ ...record, runId: "other" }, outcome)).rejects.toThrow("scope");
	await store.complete(record, { status: "unknown", result: "unknown", resultDigest: sha("unknown"), completedAt: outcome.resolvedAt });
	await expect(store.resolve(record, outcome)).rejects.toThrow("state changed");
});

it("restores immutable history through a fresh approved write and refuses concurrent edits", async () => {
	const h = setup(), record = await reserve(h);
	h.files.apply("write", h.input, { ...h.request, approvalId: record.approvalId, signal: new AbortController().signal });
	const input = { path: h.path, expectedSha256: h.files.readLocal(scope, h.path).sha256, sourceVersion: 1 };
	const request = { ...h.request, input, idempotencyKey: "restore" };
	const waiting = h.files.authorize(request), pending = h.files.list(scope).approvals[0];
	expect(pending).toMatchObject({ sourceVersion: 1, before: "after", content: "before" });
	expect(readFileSync(h.path, "utf8")).toBe("after");
	h.files.decide(scope, pending.id, "approved");
	const context = { ...request, approvalId: (await waiting).approvalId, signal: new AbortController().signal };
	const restored = h.files.apply("write", input, context);
	expect(restored).toMatchObject({ version: 3, restoredFromVersion: 1 });
	expect(h.files.read(scope, h.path, 2).content).toBe("after");
	expect(readFileSync(h.path, "utf8")).toBe("before");
	const next = { ...request, idempotencyKey: "restore-again", input: { ...input, expectedSha256: h.files.readLocal(scope, h.path).sha256, sourceVersion: 2 } };
	const approvalId = await approve(h.files, next); writeFileSync(h.path, "new user edit");
	expect(() => h.files.apply("write", next.input, { ...next, approvalId, signal: new AbortController().signal })).toThrow("变化");
	expect(readFileSync(h.path, "utf8")).toBe("new user edit");
	const tool = h.files.tools().find((tool) => tool.name === "file_write")!;
	expect(tool.validate(input)).toBe(true); expect(tool.validate({ ...input, content: "injected" })).toBe(false);
	expect(tool.createIdempotencyKey!(input, "turn", scope)).not.toBe(tool.createIdempotencyKey!({ ...input, sourceVersion: 2 }, "turn", scope));
});

it("reconciles before the model, refreshes deterministic receipts and continues without replaying a write", async () => {
	const h = setup(), record = await reserve(h), fault = crashAfterDiskWrite(h.files);
	expect(() => h.files.apply("write", h.input, { ...h.request, approvalId: record.approvalId, signal: new AbortController().signal })).toThrow(); fault.mockRestore();
	await h.state.complete(record, { status: "unknown", result: "unknown", resultDigest: sha("unknown"), completedAt: new Date().toISOString() });
	const files = h.restart(), writes = vi.spyOn(files, "apply"), provider: AgentModelProvider = { generate: async (request) => {
		expect(request.messages.find((message) => message.kind === "receipt")?.content).toContain("succeeded");
		return { text: "Continue using the recovered result", toolCalls: [], usage };
	} };
	const runtime = new BlackxAgentRuntime({ provider, skills: new SkillRegistry(), sessions: h.state, snapshots: h.state, traces: h.state, executions: h.state, tools: files.tools(), recoverToolExecution: (record, signal) => files.reconcile(record, signal) });
	const request = { ...scope, stageId: "conversation", sessionId: "task", idempotencyKey: "continue", input: "continue", allowedTools: ["file_write"], fallbackOutput: "", policy: { sandboxMode: "workspace-write" as const, approvalPolicy: "required" as const, timeoutMs: 2000 } };
	const result = await runtime.executeTurn(request);
	expect(result.events).toContainEqual(expect.objectContaining({ type: "tool.reconciled", status: "succeeded" }));
	expect(result.status).toBe("completed"); expect(writes).not.toHaveBeenCalled();
	expect((await h.restartState().find(record))?.reconciliation?.evidenceRef).toBe(`file-approval:${record.approvalId}`);
	expect(await runtime.executeTurn(request)).toMatchObject({ executionId: result.executionId });
});

it("does not invoke recovery for a different actor or a tool outside the current allowlist", async () => {
	const h = setup(), record = await reserve(h), recover = vi.fn(async () => undefined);
	const runtime = new BlackxAgentRuntime({ skills: new SkillRegistry(), executions: h.state, tools: h.files.tools(), recoverToolExecution: recover, provider: { generate: async () => ({ text: "still unresolved", toolCalls: [], usage }) } });
	for (const variant of [{ actorId: "other", allowedTools: ["file_write"] }, { actorId: scope.actorId, allowedTools: [] }]) await runtime.executeTurn({ ...scope, ...variant, stageId: "conversation", idempotencyKey: "check", input: "continue", fallbackOutput: "", policy: { sandboxMode: "read-only", approvalPolicy: "never", timeoutMs: 1000 } });
	expect(recover).not.toHaveBeenCalled(); expect((await h.state.find(record))?.status).toBe("started");
});

it("rejects a late reconciliation result after cancellation without changing the ledger", async () => {
	const h = setup(), record = await reserve(h), controller = new AbortController();
	let release!: (result: { result: string; evidenceRef: string }) => void, started!: () => void;
	const entered = new Promise<void>((resolve) => { started = resolve; }), generate = vi.fn(async () => ({ text: "must not run", toolCalls: [], usage }));
	const runtime = new BlackxAgentRuntime({ skills: new SkillRegistry(), executions: h.state, tools: h.files.tools(), provider: { generate }, recoverToolExecution: () => { started(); return new Promise((resolve) => { release = resolve; }); } });
	const pending = runtime.executeTurn({ ...scope, stageId: "conversation", idempotencyKey: "continue", input: "continue", allowedTools: ["file_write"], fallbackOutput: "", policy: { sandboxMode: "workspace-write", approvalPolicy: "required", timeoutMs: 1000 } }, controller.signal);
	const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
	await entered; controller.abort(); await rejected;
	release({ result: "late", evidenceRef: "must-not-be-used" }); await Promise.resolve();
	expect(generate).not.toHaveBeenCalled(); expect((await h.state.find(record))?.status).toBe("started");
});

it("executes history restoration through the ordinary model-tool-approval-ledger path", async () => {
	const h = setup(), record = await reserve(h);
	h.files.apply("write", h.input, { ...h.request, approvalId: record.approvalId, signal: new AbortController().signal });
	const input = { path: h.path, expectedSha256: h.files.readLocal(scope, h.path).sha256, sourceVersion: 1 };
	let calls = 0;
	const runtime = new BlackxAgentRuntime({ skills: new SkillRegistry(), sessions: h.state, snapshots: h.state, executions: h.state, traces: h.state, audit: h.state, tools: h.files.tools(),
		approval: { authorize: async (request) => ({ approved: true, approvalId: await approve(h.files, request) }) },
		provider: { generate: async () => ({ text: calls++ ? "restored" : "", toolCalls: calls === 1 ? [{ id: "restore", name: "file_write", input }] : [], usage }) } });
	const result = await runtime.executeTurn({ ...scope, stageId: "conversation", idempotencyKey: "restore-turn", input: "Restore version 1", allowedTools: ["file_write"], fallbackOutput: "", policy: { sandboxMode: "workspace-write", approvalPolicy: "required", timeoutMs: 2000 } });
	expect(result.events).toContainEqual(expect.objectContaining({ type: "tool.completed", status: "succeeded" }));
	expect(readFileSync(h.path, "utf8")).toBe("before");
	expect((await h.state.list(scope)).find((item) => item.status === "succeeded")?.result).toContain('"restoredFromVersion":1');
});
