import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentMessage, AgentToolApprovalPort } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import { BlackxAgentRuntime } from "./agentRuntime";
import { ConversationFileService } from "./conversationFiles";
import { FileAgentStateStore } from "./fileAgentStateStore";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scope = { tenantId: "tenant", workspaceId: "workspace", runId: "task", sessionId: "session", actorId: "user" };
const now = "2026-10-16T00:00:00Z";
const turn = { ...scope, stageId: "conversation", idempotencyKey: "resume", input: "继续", allowedTools: ["file_read", "file_list"], fallbackOutput: "", policy: { sandboxMode: "read-only" as const, approvalPolicy: "never" as const, timeoutMs: 2000 } };
async function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "packx-file-context-"))); roots.push(root);
	const filesRoot = join(root, "files"), path = join(root, "delivery.md"), files = new ConversationFileService(filesRoot, () => {});
	const input = { path, expectedSha256: null, content: "SYNTHETIC_SOURCE" };
	const request: Parameters<AgentToolApprovalPort["authorize"]>[0] = { ...scope, tool: "file_write", stageId: "conversation", executionId: "write", toolCallId: "write", input, risk: "write", idempotencyKey: "write" };
	const waiting = files.authorize(request); files.decide(scope, files.list(scope).approvals[0].id, "approved");
	files.apply("write", input, { ...request, approvalId: (await waiting).approvalId, signal: new AbortController().signal });
	const state = new FileAgentStateStore(join(root, "state"));
	return { root, path, files, state, request, restart: () => new ConversationFileService(filesRoot, () => {}, Date.now, [path]) };
}

it.each(["live", "history", "legacy", "archive", "legacy_externalized"] as const)("blocks revoked %s reads before the provider receives cached bytes", async (mode) => {
	const h = await fixture();
	const input = { path: h.path, ...(mode === "live" ? {} : { version: 1 }) };
	const output = mode === "live" ? h.files.readLocal(scope, h.path) : h.files.read(scope, h.path, 1);
	const messages: AgentMessage[] = [
		{ role: "assistant", content: "", toolCalls: [{ id: "read", name: "file_read", input }] },
		{ role: "tool", toolCallId: "read", content: JSON.stringify(output), ...(mode === "legacy" ? {} : { sourceTool: { name: "file_read", input } }) },
	];
	const archived = mode === "archive" || mode === "legacy_externalized";
	if (archived) h.state.put({ ...scope, schemaVersion: "context-snapshot.v2", snapshotId: "old-source", iteration: 1, skills: [], messages: mode === "legacy_externalized" ? [{ role: "tool", content: JSON.stringify(output) }] : messages, estimatedChars: 0, estimatedTokens: 0, removedMessages: 0, createdAt: now });
	h.state.save(scope, 0, archived ? [{ role: "user", kind: "summary", content: "Old synthetic summary", readDependencies: ["old-source"] }] : messages, now);
	const files = h.restart(), generate = vi.fn(async () => ({ text: "must not see source", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } }));
	expect(() => files.read(scope, h.path, 1)).toThrow("不可通过");
	const runtime = new BlackxAgentRuntime({ sessions: new FileAgentStateStore(join(h.root, "state")), snapshots: h.state, tools: files.tools(), skills: new SkillRegistry(), provider: { generate } });
	await expect(runtime.executeTurn(turn)).rejects.toMatchObject({ code: "context_failure", retryable: false });
	expect(generate).not.toHaveBeenCalled();
	expect(readFileSync(h.path, "utf8")).toBe("SYNTHETIC_SOURCE");
});

it("revalidates live bytes while retaining a permitted immutable historical version", async () => {
	const h = await fixture(), input = { path: h.path }, execution = { ...scope, stageId: "conversation", executionId: "read", toolCallId: "read", idempotencyKey: "read", signal: new AbortController().signal };
	const validator = h.files.tools().find((tool) => tool.name === "file_read")!.validateContextResult!;
	const live = JSON.stringify(h.files.readLocal(scope, h.path)), historical = JSON.stringify(h.files.read(scope, h.path, 1));
	validator(input, live, execution);
	writeFileSync(h.path, "changed by external user");
	expect(() => validator(input, live, execution)).toThrow("来源已变化");
	expect(() => validator({ ...input, version: 1 }, historical, execution)).not.toThrow();
});

it("cancels newly forbidden pending previews and rejects their cached file_list output", async () => {
	const h = await fixture();
	const request = { ...h.request, idempotencyKey: "pending", input: { path: h.path, expectedSha256: h.files.readLocal(scope, h.path).sha256, content: "replacement" } };
	const waiting = h.files.authorize(request);
	const previous = JSON.stringify(h.files.list(scope)), files = h.restart();
	expect(files.list(scope).approvals).toHaveLength(0);
	await expect(waiting).resolves.toMatchObject({ approved: false });
	const validator = files.tools().find((tool) => tool.name === "file_list")!.validateContextResult!;
	expect(() => validator({}, previous, { ...request, signal: new AbortController().signal })).toThrow("不可通过");
});

it("can continue a failed file read that returned only the Host failure envelope", async () => {
	const h = await fixture(), input = { path: h.path, version: 999 };
	h.state.save(scope, 0, [{ role: "assistant", content: "", toolCalls: [{ id: "failed", name: "file_read", input }] }, { role: "tool", toolCallId: "failed", content: JSON.stringify({ ok: false, error: { code: "tool_execution_failed", message: "Tool execution failed" } }) }], now);
	const generate = vi.fn(async () => ({ text: "ask for a permitted source", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } }));
	const runtime = new BlackxAgentRuntime({ sessions: h.state, snapshots: h.state, tools: h.restart().tools(), skills: new SkillRegistry(), provider: { generate } });
	await expect(runtime.executeTurn(turn)).resolves.toMatchObject({ finalResponse: "ask for a permitted source" });
	expect(generate).toHaveBeenCalledOnce();
});
