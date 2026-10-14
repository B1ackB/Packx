import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, linkSync, writeFileSync, existsSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationFileService, TaskFileError } from "./conversationFiles";
import type { AgentToolApprovalPort, AgentToolExecutionContext } from "../../src/agent/contracts";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
const scope = { tenantId: "tenant", workspaceId: "workspace", runId: "conversation-local", actorId: "user" };
type Request = Parameters<AgentToolApprovalPort["authorize"]>[0];
function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "blackx-local-files-"))); cleanup.push(root);
	const documents = join(root, "documents"); mkdirSync(documents);
	let active = true;
	const service = new ConversationFileService(join(root, "state"), () => { if (!active) throw new TaskFileError("conversation_not_found", "deleted", 404); }, undefined, [join(documents, "protected")]);
	return { root, documents, service, deleted: () => { active = false; } };
}
function request(path: string, expectedSha256: string | null, content?: string, key = crypto.randomUUID()): Request {
	return { ...scope, tool: content === undefined ? "file_delete" : "file_write", stageId: "conversation", executionId: "execution", toolCallId: "call", risk: "write", idempotencyKey: key, input: { path, expectedSha256, ...(content === undefined ? {} : { content }) } };
}
function context(req: Request, approvalId?: string): AgentToolExecutionContext { return { ...req, approvalId, signal: new AbortController().signal }; }
async function approved(service: ConversationFileService, req: Request) {
	const waiting = service.authorize(req);
	service.decide(scope, service.list(scope).approvals[0].id, "approved");
	return (await waiting).approvalId;
}
describe("real local files with explicit user approval", () => {
	it("requires approval even for new files, writes the real absolute path, then reads and deletes it with retained content", async () => {
		const { documents, service } = setup();
		const path = join(documents, "packaging.md"); const req = request(path, null, "draft");
		const waiting = service.authorize(req);
		expect(existsSync(path)).toBe(false);
		expect(service.list(scope).approvals[0]).toMatchObject({ path, expectedSha256: null, content: "draft" });
		service.decide(scope, service.list(scope).approvals[0].id, "approved");
		const v1 = service.apply("write", req.input, context(req, (await waiting).approvalId));
		expect(v1.absolutePath).toBe(path); expect(readFileSync(path, "utf8")).toBe("draft");
		const current = service.readLocal(scope, path);
		const modify = request(path, current.sha256, "revised");
		service.apply("write", modify.input, context(modify, await approved(service, modify)));
		expect(readFileSync(path, "utf8")).toBe("revised");
		const remove = request(path, service.readLocal(scope, path).sha256);
		service.apply("delete", remove.input, context(remove, await approved(service, remove)));
		expect(existsSync(path)).toBe(false);
		expect(service.read(scope, path, 1).content).toBe("draft");
		expect(service.read(scope, path, 2).content).toBe("revised");
	});

	it("modifies an existing user document in place and retains its original content before first change", async () => {
		const { documents, service } = setup();
		const path = join(documents, "existing.md"); writeFileSync(path, "user original");
		const req = request(path, service.readLocal(scope, path).sha256, "approved revision");
		expect(() => service.apply("write", req.input, context(req))).toThrow("审批");
		const decision = await approved(service, req);
		const result = service.apply("write", req.input, context(req, decision));
		expect(result.version).toBe(2);
		expect(service.read(scope, path, 1).content).toBe("user original");
		expect(readFileSync(path, "utf8")).toBe("approved revision");
		service.apply("write", req.input, context(req, decision));
		expect(service.list(scope).files).toHaveLength(2);
	});

	it("does not touch files after rejection or after an external edit invalidates approval", async () => {
		const { documents, service } = setup();
		const path = join(documents, "source.md"); writeFileSync(path, "source");
		const req = request(path, service.readLocal(scope, path).sha256, "candidate");
		const waiting = service.authorize(req); service.decide(scope, service.list(scope).approvals[0].id, "rejected");
		expect((await waiting).approved).toBe(false); expect(readFileSync(path, "utf8")).toBe("source");
		const next = { ...req, idempotencyKey: "next" }; const decision = await approved(service, next);
		writeFileSync(path, "external edit");
		expect(() => service.apply("write", next.input, context(next, decision))).toThrow("变化");
		expect(readFileSync(path, "utf8")).toBe("external edit");
	});

	it("binds consent to one path, content and conversation, and denies deleted sessions", async () => {
		const { documents, service, deleted } = setup();
		const path = join(documents, "new.md"); const req = request(path, null, "draft");
		const decision = await approved(service, req);
		expect(() => service.apply("write", { ...req.input as object, path: join(documents, "other.md") }, context(req, decision))).toThrow("审批");
		expect(() => service.apply("write", { ...req.input as object, content: "changed" }, context(req, decision))).toThrow("审批");
		expect(() => service.apply("write", req.input, { ...context(req, decision), runId: "another" })).toThrow("审批");
		expect(() => service.decide({ ...scope, runId: "another" }, decision!, "approved")).toThrow("不存在");
		expect(existsSync(path)).toBe(false);
		deleted(); expect(() => service.apply("write", req.input, context(req, decision))).toThrow("deleted");
	});

	it("rejects replacement of the target directory after approval, even for a new file", async () => {
		const { documents, service } = setup();
		const path = join(documents, "new.md"); const req = request(path, null, "draft");
		const decision = await approved(service, req);
		renameSync(documents, `${documents}-old`); mkdirSync(documents);
		expect(() => service.apply("write", req.input, context(req, decision))).toThrow("目录已变化");
		expect(existsSync(path)).toBe(false);
	});

	it("cancels stopped requests without changing disk, then permits a fresh operation request", async () => {
		const { documents, service } = setup(); const path = join(documents, "new.md");
		const req = request(path, null, "draft"); const controller = new AbortController();
		const waiting = service.authorize(req, controller.signal); const id = service.list(scope).approvals[0].id;
		controller.abort(); await expect(waiting).rejects.toThrow();
		expect(() => service.decide(scope, id, "approved")).toThrow("过期");
		expect(() => service.apply("write", req.input, context(req, id))).toThrow("审批");
		expect(existsSync(path)).toBe(false);
		const next = request(path, null, "new draft");
		service.apply("write", next.input, context(next, await approved(service, next)));
		expect(readFileSync(path, "utf8")).toBe("new draft");
	});

	it("returns real Host locations and reads regular files without directory preauthorization", () => {
		const { documents, service } = setup(); const path = join(documents, "existing.md"); writeFileSync(path, "original");
		const info = service.browse(scope);
		expect("locations" in info && info.locations?.homeDirectory).toBeTruthy();
		expect(service.readLocal(scope, path).content).toBe("original");
		expect(service.list(scope).approvals).toEqual([]);
		for (const path of ["/", "/etc", "/System", "/dev"]) expect(() => service.browse(scope, path)).toThrow("系统目录");
	});

	it("pages through every permitted file without duplicates and retains path restrictions", () => {
		const { documents, service, deleted } = setup();
		const names = Array.from({ length: 405 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`);
		for (const name of names) writeFileSync(join(documents, name), "fixture");
		writeFileSync(join(documents, ".env"), "secret");
		writeFileSync(join(documents, "credential.key"), "secret");
		mkdirSync(join(documents, "protected"));
		const first = service.browse(scope, documents);
		if (!("entries" in first)) throw new Error("Expected directory listing");
		expect(first).toMatchObject({ total: 405, truncated: true, nextAfter: names[199] });
		expect(first.entries).toHaveLength(200);
		const second = service.browse(scope, documents, first.nextAfter);
		if (!("entries" in second)) throw new Error("Expected directory listing");
		const last = service.browse(scope, documents, second.nextAfter);
		if (!("entries" in last)) throw new Error("Expected directory listing");
		expect(last).toMatchObject({ total: 405, truncated: false });
		expect(last.nextAfter).toBeUndefined();
		expect([...first.entries, ...second.entries, ...last.entries].map((entry) => entry.name)).toEqual(names);
		for (const cursor of ["../escape", ".env", "missing.txt"]) expect(() => service.browse(scope, documents, cursor)).toThrow();
		rmSync(join(documents, first.nextAfter!));
		expect(() => service.browse(scope, documents, first.nextAfter)).toThrow("刷新");
		deleted(); expect(() => service.browse(scope, documents, second.nextAfter)).toThrow("deleted");
	});

	it("invalidates legacy local approvals while retaining inert directory records", async () => {
		const { root, documents, service } = setup(); const path = join(documents, "new.md");
		const req = request(path, null, "draft"); const id = await approved(service, req);
		const stateRoot = join(root, "state"); const index = join(stateRoot, readdirSync(stateRoot)[0], "index.json");
		const state = JSON.parse(readFileSync(index, "utf8"));
		delete state.approvals[0].parentIdentity;
		state.approvals[0].grantId = "legacy-grant";
		state.directoryGrants = [{ id: "legacy-grant", path: documents, status: "active" }];
		writeFileSync(index, JSON.stringify(state));
		expect(() => service.apply("write", req.input, context(req, id))).toThrow("审批格式已过期");
		expect(service.list(scope).approvals).toEqual([]);
		expect(JSON.parse(readFileSync(index, "utf8")).approvals[0].status).toBe("cancelled");
		expect(existsSync(path)).toBe(false);
	});

	it("blocks parent/final symlinks, protected data and hidden secrets without any directory grant", async () => {
		const { root, documents, service } = setup();
		writeFileSync(join(root, "outside.md"), "private");
		symlinkSync(join(root, "outside.md"), join(documents, "link.md"));
		linkSync(join(root, "outside.md"), join(documents, "hard.md"));
		symlinkSync(root, join(documents, "escape"));
		mkdirSync(join(documents, "protected")); writeFileSync(join(documents, "protected", "audit.json"), "private");
		writeFileSync(join(documents, ".env"), "private");
		for (const path of [join(documents, "link.md"), join(documents, "hard.md"), join(documents, "escape", "outside.md"), join(documents, "protected", "audit.json"), join(documents, ".env")]) expect(() => service.readLocal(scope, path)).toThrow();
		const listing = service.browse(scope, documents);
		expect("entries" in listing && listing.entries.some((entry) => [".env", "link.md", "hard.md", "escape", "protected"].includes(entry.name))).toBe(false);
		const write = service.tools().find((tool) => tool.name === "file_write")!;
		expect(write.validate({ path: join(documents, "delivery.pdf"), expectedSha256: null, content: "not a PDF" })).toBe(false);
	});
});
