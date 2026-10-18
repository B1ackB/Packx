import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentToolApprovalPort, AgentToolExecutionContext } from "../../src/agent/contracts";
import { ConversationFileService, maxTaskFileBytes, TaskFileError } from "./conversationFiles";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const scope = { tenantId: "tenant", workspaceId: "workspace", runId: "conversation-one", actorId: "user" };
type Request = Parameters<AgentToolApprovalPort["authorize"]>[0];
function setup() {
	const root = mkdtempSync(join(tmpdir(), "blackx-task-files-")); directories.push(root);
	let active = true; let now = Date.now();
	const assertActive = () => { if (!active) throw new TaskFileError("conversation_not_found", "deleted", 404); };
	const service = new ConversationFileService(root, assertActive, () => now);
	return { root, service, restart: () => new ConversationFileService(root, assertActive, () => now), deleteSession: () => { active = false; }, expire: () => { now += 121_000; } };
}
function request(input: unknown, key = "one", tool = "file_write"): Request {
	return { ...scope, stageId: "conversation", executionId: "execution", toolCallId: "call", tool, input, risk: "write", idempotencyKey: key };
}
function context(req: Request, approvalId?: string): AgentToolExecutionContext { return { ...req, approvalId, signal: new AbortController().signal }; }
async function create(service: ConversationFileService) {
	const req = request({ path: "包装/方案.md", content: "第一版", expectedVersion: null });
	const waiting = service.authorize(req);
	service.decide(scope, service.list(scope).approvals[0].id, "approved");
	const approved = await waiting;
	return service.apply("write", req.input, context(req, approved.approvalId));
}

describe("conversation file permissions and recovery", () => {
	it("keeps file operation keys canonical and scoped without changing existing tool keys", () => {
		const { service } = setup(); const tool = service.tools().find((tool) => tool.name === "file_write")!;
		const input = { path: "ok.md", content: "draft", expectedVersion: null };
		const key = tool.createIdempotencyKey!(input, "message", scope);
		expect(tool.createIdempotencyKey!({ expectedVersion: null, content: "draft", path: "ok.md" }, "message", scope)).toBe(key);
		expect(tool.createIdempotencyKey!(input, "message", { ...scope, runId: "conversation-two" })).not.toBe(key);
	});

	it.each([true, false])("recovers only identical unreferenced blobs after a crash (matching=%s)", async (matching) => {
		const { root, service, restart } = setup(); const first = await create(service);
		const req = request({ path: first.path, content: "second", expectedVersion: 1 }, "recovery");
		const waiting = service.authorize(req);
		service.decide(scope, service.list(scope).approvals[0].id, "approved");
		const approval = await waiting;
		writeFileSync(join(root, readdirSync(root)[0], `${first.artifactId}-v2.txt`), matching ? "second" : "unrelated", { mode: 0o600 });
		const apply = () => restart().apply("write", req.input, context(req, approval.approvalId));
		if (matching) { expect(apply().version).toBe(2); expect(restart().read(scope, first.path).content).toBe("second"); }
		else { expect(apply).toThrow("恢复"); expect(restart().read(scope, first.path).content).toBe("第一版"); }
	});

	it("creates a real immutable file, denies unapproved changes, binds approval to content, and replays once", async () => {
		const { root, service, restart } = setup();
		const first = await create(service);
		const stored = join(root, readdirSync(root)[0], `${first.artifactId}-v1.txt`);
		expect(readdirSync(join(root, readdirSync(root)[0]))).toContain(`${first.artifactId}-v1.txt`);
		const req = request({ path: first.path, content: "第二版", expectedVersion: 1 }, "overwrite");
		expect(() => service.apply("write", req.input, context(req))).toThrow("审批");
		const wait = service.authorize(req);
		const pending = service.list(scope).approvals[0];
		expect(pending).toMatchObject({ operation: "write", expectedVersion: 1, before: "第一版", content: "第二版" });
		expect(service.read(scope, first.path).content).toBe("第一版");
		restart().decide(scope, pending.id, "approved");
		const approved = await wait;
		expect(() => service.apply("write", { ...req.input as object, content: "偷换内容" }, context(req, approved.approvalId))).toThrow("匹配");
		const v2 = service.apply("write", req.input, context(req, approved.approvalId));
		expect(restart().apply("write", req.input, context(req, approved.approvalId))).toEqual(v2);
		expect(restart().list(scope).files).toHaveLength(2);
		expect(restart().read(scope, first.path, 1).content).toBe("第一版");
		expect(restart().read(scope, first.path).content).toBe("第二版");
		writeFileSync(stored, "篡改磁盘");
		expect(() => service.read(scope, first.path, 1)).toThrow("校验失败");
	});

	it("rejects deletion, then approves deletion with recoverable history and requires approval to restore", async () => {
		const { service } = setup(); const first = await create(service);
		const req = request({ path: first.path, expectedVersion: 1 }, "delete", "file_delete");
		const rejected = service.authorize(req);
		service.decide(scope, service.list(scope).approvals[0].id, "rejected");
		expect((await rejected).approved).toBe(false);
		expect(service.read(scope, first.path).content).toBe("第一版");
		const next = { ...req, idempotencyKey: "delete-again" };
		const waiting = service.authorize(next);
		service.decide(scope, service.list(scope).approvals[0].id, "approved");
		const approved = await waiting;
		const deleted = service.apply("delete", next.input, context(next, approved.approvalId));
		expect(deleted).toMatchObject({ version: 2, status: "deleted" });
		expect(() => service.read(scope, first.path)).toThrow("不存在");
		expect(service.read(scope, first.path, 1).content).toBe("第一版");
		const restore = request({ path: first.path, expectedVersion: 2, content: service.read(scope, first.path, 1).content }, "restore");
		const restoring = service.authorize(restore);
		service.decide(scope, service.list(scope).approvals[0].id, "approved");
		service.apply("write", restore.input, context(restore, (await restoring).approvalId));
		expect(service.read(scope, first.path)).toMatchObject({ content: "第一版", file: { version: 3, status: "draft" } });
	});

	it("binds cached task-file reads to their immutable version across an approved edit and deletion", async () => {
		const { service } = setup(); await create(service);
		const input = { path: "包装/方案.md" }, prior = JSON.stringify(service.read(scope, input.path));
		const validator = service.tools().find((tool) => tool.name === "file_read")!.validateContextResult!;
		const req = request({ ...input, content: "updated", expectedVersion: 1 }, "update");
		const waiting = service.authorize(req); service.decide(scope, service.list(scope).approvals[0].id, "approved");
		service.apply("write", req.input, context(req, (await waiting).approvalId));
		expect(() => validator(input, prior, context(req))).not.toThrow();
		const remove = request({ ...input, expectedVersion: 2 }, "remove", "file_delete");
		const deleting = service.authorize(remove); service.decide(scope, service.list(scope).approvals[0].id, "approved");
		service.apply("delete", remove.input, context(remove, (await deleting).approvalId));
		expect(() => validator(input, prior, context(remove))).not.toThrow();
		expect(service.read(scope, input.path, 1).content).toBe("第一版");
	});

	it("rejects stale decisions and versions even when two operations were independently approved", async () => {
		const { service } = setup(); await create(service);
		const one = request({ path: "包装/方案.md", content: "a", expectedVersion: 1 }, "a");
		const two = request({ path: "包装/方案.md", content: "b", expectedVersion: 1 }, "b");
		const waits = [service.authorize(one), service.authorize(two)];
		for (const pending of service.list(scope).approvals) service.decide(scope, pending.id, "approved");
		const decisions = await Promise.all(waits);
		service.apply("write", one.input, context(one, decisions[0].approvalId));
		expect(() => service.apply("write", two.input, context(two, decisions[1].approvalId))).toThrow("版本已变化");
		expect(service.read(scope, "包装/方案.md").content).toBe("a");
	});

	it("cancels pending approvals on abort, expires after restart, and refuses deleted sessions", async () => {
		const { service, restart, expire, deleteSession } = setup(); await create(service);
		const abort = new AbortController();
		const req = request({ path: "包装/方案.md", expectedVersion: 1 }, "abort", "file_delete");
		const waiting = service.authorize(req, abort.signal);
		const id = service.list(scope).approvals[0].id;
		abort.abort(); await expect(waiting).rejects.toThrow();
		expect(service.list(scope).approvals).toHaveLength(0);
		expect(() => service.decide(scope, id, "approved")).toThrow("过期");
		const pending = service.authorize({ ...req, idempotencyKey: "expiry" });
		expire(); expect(restart().list(scope).approvals).toHaveLength(0);
		expect((await pending).approved).toBe(false);
		deleteSession(); expect(() => service.read(scope, "包装/方案.md")).toThrow("deleted");
	});

	it("isolates tenants, workspaces, sessions and approval ids; blocks traversal, binary/large content and symlinks", async () => {
		const { root, service } = setup(); const first = await create(service);
		for (const changed of [{ tenantId: "other" }, { workspaceId: "other" }, { runId: "conversation-other" }]) {
			expect(service.list({ ...scope, ...changed }).files).toHaveLength(0);
			expect(() => service.decide({ ...scope, ...changed }, first.approvalId, "approved")).toThrow("审批不存在");
		}
		const write = service.tools().find((tool) => tool.name === "file_write")!;
		for (const path of ["../secret.md", "/etc/passwd", ".env", "a/../../b.md", "a\\b.md", "x.sh", "a//b.md", "a/../b.md"]) expect(write.validate({ path, content: "x", expectedVersion: null })).toBe(false);
		expect(write.validate({ path: "ok.md", content: "x".repeat(maxTaskFileBytes + 1), expectedVersion: null })).toBe(false);
		expect(write.validate({ path: "ok.md", content: "binary\0", expectedVersion: null })).toBe(false);
		const directory = readdirSync(root).find((entry) => readdirSync(join(root, entry)).some((name) => name.endsWith(".txt")))!;
		const blob = join(root, directory, `${first.artifactId}-v1.txt`);
		rmSync(blob); symlinkSync("/etc/hosts", blob);
		expect(() => service.read(scope, first.path)).toThrow("不安全");
	});
});
