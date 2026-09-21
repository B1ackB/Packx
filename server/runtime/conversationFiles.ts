import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentHostTool, AgentToolApprovalPort, AgentToolExecutionContext, AgentToolExecutionRecord } from "../../src/agent/contracts";
import type { ConversationFilesView, FileApprovalView, TaskFileVersion } from "../../src/runtime/conversationFiles";

export const conversationFileToolNames = ["file_list", "file_read", "file_write", "file_delete"] as const;
export { maxTaskFileBytes, TaskFileError } from "./localFileAccess";
import { LocalFileAccess, maxTaskFileBytes, TaskFileError, validLocalPath } from "./localFileAccess";
type Scope = { tenantId: string; workspaceId: string; runId: string; actorId: string };
type ApprovalRequest = Parameters<AgentToolApprovalPort["authorize"]>[0];
type Mutation = { path: string; expectedVersion?: number | null; expectedSha256?: string | null; content?: string; sourceVersion?: number };
type Approval = FileApprovalView & { idempotencyKey: string; inputDigest: string; requestDigest?: string; actorId: string; executionId: string; toolCallId: string; parentIdentity?: string; fileIdentity?: string; decidedBy?: string; decidedAt?: string; result?: TaskFileVersion; plannedResult?: TaskFileVersion; reconciledAt?: string };
type Manifest = { schemaVersion: "task-files.v1"; tenantId: string; workspaceId: string; runId: string; versions: TaskFileVersion[]; approvals: Approval[] };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fail(code: string, message: string, status = 409): never { throw new TaskFileError(code, message, status); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function validPath(path: unknown): path is string {
	return typeof path === "string" && path.length <= 180 && path === path.normalize("NFC") &&
		path.split("/").every((part) => /^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,79}$/u.test(part) && !part.endsWith(".") && !part.endsWith(" ")) &&
		/\.(txt|md|csv|json|html|svg)$/i.test(path);
}
function validMutation(value: unknown, operation: "write" | "delete"): value is Mutation {
	return record(value) && (validPath(value.path) || validLocalPath(value.path)) && Object.keys(value).every((key) => ["path", "expectedVersion", "expectedSha256", ...(operation === "write" ? ["content", "sourceVersion"] : [])].includes(key)) &&
		(operation !== "write" || !/\.(pdf|docx?|xlsx?|pptx?|zip|png|jpe?g|gif|webp|heic|psd|ai|exe|dmg|sqlite|db)$/i.test(value.path)) &&
		(validLocalPath(value.path) ? ((operation === "write" && value.expectedSha256 === null) || (typeof value.expectedSha256 === "string" && /^[a-f0-9]{64}$/.test(value.expectedSha256))) && value.expectedVersion === undefined : ((operation === "write" && value.expectedVersion === null) || (Number.isSafeInteger(value.expectedVersion) && Number(value.expectedVersion) > 0)) && value.expectedSha256 === undefined) &&
		(operation !== "write" || (value.sourceVersion === undefined ? typeof value.content === "string" && Buffer.byteLength(value.content) <= maxTaskFileBytes && !value.content.includes("\0") : value.content === undefined && Number.isSafeInteger(value.sourceVersion) && Number(value.sourceVersion) > 0));
}
const mutationDigest = (operation: "write" | "delete", input: Mutation) => hash(JSON.stringify([operation, input.path, input.expectedVersion ?? input.expectedSha256 ?? null, input.content ?? null, ...(input.sourceVersion === undefined ? [] : [input.sourceVersion])]));

/** Enterprise adapter: approved local file access with immutable history and per-operation user consent. */
export class ConversationFileService implements AgentToolApprovalPort {
	private readonly root: string;
	private readonly local: LocalFileAccess;
	constructor(root: string, private readonly assertActive: (scope: Scope) => void, private readonly now: () => number = Date.now, protectedPaths: readonly string[] = [], workspaceRoot?: string) {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		if (lstatSync(root).isSymbolicLink()) fail("file_path_denied", "文件区不能是符号链接", 403);
		this.root = realpathSync(root);
		this.local = new LocalFileAccess([this.root, ...protectedPaths], workspaceRoot);
	}

	private directory(scope: Scope): string {
		this.assertActive(scope);
		if (![scope.tenantId, scope.workspaceId, scope.runId, scope.actorId].every((part) => typeof part === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(part))) fail("file_scope_denied", "文件身份无效", 403);
		if (realpathSync(this.root) !== this.root || lstatSync(this.root).isSymbolicLink()) fail("file_path_denied", "文件区路径已变化", 403);
		const directory = join(this.root, hash(JSON.stringify([scope.tenantId, scope.workspaceId, scope.runId])));
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) fail("file_path_denied", "文件区路径不安全", 403);
		return directory;
	}

	private readSafe(path: string): string {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 24 * 1024 * 1024) fail("file_path_denied", "文件区对象不安全", 403);
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try { return readFileSync(fd, "utf8"); } finally { closeSync(fd); }
	}

	private load(scope: Scope): Manifest {
		const path = join(this.directory(scope), "index.json");
		if (!existsSync(path)) return { schemaVersion: "task-files.v1", tenantId: scope.tenantId, workspaceId: scope.workspaceId, runId: scope.runId, versions: [], approvals: [] };
		const state = JSON.parse(this.readSafe(path)) as Manifest;
		if (state.schemaVersion !== "task-files.v1" || state.tenantId !== scope.tenantId || state.workspaceId !== scope.workspaceId || state.runId !== scope.runId) fail("file_scope_denied", "文件区身份不匹配", 403);
		return state;
	}

	private writeNew(path: string, content: string): void {
		const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
	}
	private save(scope: Scope, state: Manifest): void {
		const directory = this.directory(scope);
		const temporary = join(directory, `${randomUUID()}.tmp`);
		try {
			const serialized = JSON.stringify(state);
			if (Buffer.byteLength(serialized) > 20 * 1024 * 1024) fail("file_quota_exceeded", "当前会话文件区记录已达到配额", 413);
			this.writeNew(temporary, serialized);
			renameSync(temporary, join(directory, "index.json"));
			const fd = openSync(directory, constants.O_RDONLY);
			try { fsyncSync(fd); } finally { closeSync(fd); }
		} finally { if (existsSync(temporary)) unlinkSync(temporary); }
	}

	private current(state: Manifest, path: string) { return [...state.versions].reverse().find((file) => file.path === path); }
	private resolveMutation(scope: Scope, input: Mutation): Mutation {
		return input.sourceVersion === undefined ? input : { ...input, content: this.read(scope, input.path, input.sourceVersion).content };
	}
	browse(scope: Scope, path?: string) {
		this.load(scope);
		return path ? this.local.list(path) : { locations: this.local.locations(), files: this.list(scope).files };
	}
	readDocument(scope: Scope, path: string) { this.load(scope); return this.local.readDocument(path); }
	readLocal(scope: Scope, path: string) {
		this.load(scope);
		const { absolutePath, content, sha256, size } = this.local.read(path);
		return { absolutePath, content, sha256, size };
	}
	private checkParent(approval: Approval) {
		if (isAbsolute(approval.path) && this.local.check(approval.path) !== approval.parentIdentity) fail("file_approval_required", "目标目录已变化或审批格式已过期，请重新审批", 403);
	}
	private applyLocal(operation: "write" | "delete", input: Mutation, context: AgentToolExecutionContext, state: Manifest, approval: Approval): TaskFileVersion {
		const disk = this.local.inspect(input.path);
		if (disk?.identity !== approval.fileIdentity) fail("file_version_conflict", "文件对象已变化，请重新审批");
		const previous = this.current(state, input.path);
		let number = previous?.version ?? 0;
		const base = { artifactId: `file-${hash(input.path)}`, path: input.path, absolutePath: input.path, createdAt: new Date(this.now()).toISOString(), actorId: context.actorId, executionId: context.executionId, approvalId: approval.id };
		const saveContent = (version: TaskFileVersion, content: string) => {
			const path = join(this.directory(context), `${version.artifactId}-v${version.version}.txt`);
			if (existsSync(path)) { if (this.readSafe(path) !== content) fail("file_recovery_conflict", "历史备份存在冲突，需要人工核对"); }
			else this.writeNew(path, content);
		};
		if (disk && (previous?.sha256 !== disk.sha256 || previous.status === "deleted")) {
			const before: TaskFileVersion = { ...base, version: ++number, sha256: disk.sha256, size: disk.size, status: "draft" };
			saveContent(before, disk.content); state.versions.push(before);
		}
		if (state.versions.reduce((sum, v) => sum + v.size, 0) + Buffer.byteLength(input.content ?? "") > 20 * 1024 * 1024) fail("file_quota_exceeded", "历史备份已达配额，未修改磁盘文件", 413);
		const version: TaskFileVersion = { ...base, version: ++number, sha256: hash(input.content ?? ""), size: Buffer.byteLength(input.content ?? ""), status: operation === "delete" ? "deleted" : "draft", ...(input.sourceVersion ? { restoredFromVersion: input.sourceVersion } : {}) };
		if (operation === "write") saveContent(version, input.content!);
		approval.status = "executing";
		approval.plannedResult = version;
		this.save(context, state); // Durable preimage + intent before touching a user's file.
		context.signal.throwIfAborted();
		this.checkParent(approval);
		this.local.apply(input.path, operation === "write" ? input.content! : undefined, input.expectedSha256!, approval.fileIdentity, approval.parentIdentity!);
		state.versions.push(version); approval.status = "applied"; approval.result = version;
		this.save(context, state);
		return version;
	}

	/** Reconcile an approved outcome using stored receipts or the exact durable intended postcondition. Never writes the user's file. */
	async reconcile(record: AgentToolExecutionRecord, signal: AbortSignal): Promise<{ result: string; evidenceRef: string } | undefined> {
		signal.throwIfAborted();
		if (record.status === "succeeded" || !["file_write", "file_delete"].includes(record.tool)) return;
		const state = this.load(record);
		const approval = state.approvals.find((item) => item.id === record.approvalId);
		if (!approval || approval.actorId !== record.actorId || approval.idempotencyKey !== record.idempotencyKey || approval.requestDigest !== record.inputDigest || !approval.decidedBy || approval.decidedBy.startsWith("policy:") || approval.operation !== (record.tool === "file_write" ? "write" : "delete")) return;
		if (approval.status !== "applied" && approval.status !== "executing") return;
		this.checkParent(approval);
		let result = approval.result;
		if (approval.status === "executing") {
			result = approval.plannedResult;
			if (!result || !isAbsolute(approval.path) || result.actorId !== record.actorId || result.executionId !== record.executionId || result.approvalId !== approval.id || result.path !== approval.path || result.sha256 !== hash(approval.content ?? "") || result.version !== (this.current(state, approval.path)?.version ?? 0) + 1) return;
			if (state.approvals.some((item) => item.path === approval.path && item.id !== approval.id && ["executing", "applied"].includes(item.status) && state.approvals.indexOf(item) > state.approvals.indexOf(approval))) return;
			const disk = this.local.inspect(approval.path);
			if (approval.operation === "delete" ? disk !== undefined : disk?.sha256 !== result.sha256 || disk?.size !== result.size) return;
			const previous = this.current(state, approval.path);
			if (approval.before !== undefined && (!previous || previous.status === "deleted" || this.content(record, previous) !== approval.before)) return;
			if (result.status !== "deleted") this.content(record, result);
			signal.throwIfAborted();
			state.versions.push(result); approval.result = result; approval.status = "applied"; approval.reconciledAt = new Date(this.now()).toISOString();
			this.save(record, state);
		}
		if (!result || result.approvalId !== approval.id || result.actorId !== record.actorId || !state.versions.some((version) => version.path === result!.path && version.version === result!.version && version.sha256 === result!.sha256 && version.approvalId === approval.id)) return;
		if (result.status !== "deleted") this.content(record, result);
		signal.throwIfAborted();
		return { result: JSON.stringify({ ...result, storagePath: result.status === "deleted" ? undefined : join(this.directory(record), `${result.artifactId}-v${result.version}.txt`) }), evidenceRef: `file-approval:${approval.id}` };
	}
	private checkVersion(state: Manifest, input: Mutation): void {
		if (isAbsolute(input.path)) {
			const current = this.local.inspect(input.path);
			if ((current?.sha256 ?? null) !== input.expectedSha256) fail("file_version_conflict", "磁盘文件已变化，请重新读取并审批");
			return;
		}
		if ((this.current(state, input.path)?.version ?? null) !== input.expectedVersion) fail("file_version_conflict", "文件版本已变化，请重新读取并发起审批");
	}
	private content(scope: Scope, version: TaskFileVersion): string {
		if (!/^file-[a-f0-9]{64}$/.test(version.artifactId) || !Number.isSafeInteger(version.version) || version.version < 1) fail("file_path_denied", "文件版本无效", 403);
		const content = this.readSafe(join(this.directory(scope), `${version.artifactId}-v${version.version}.txt`));
		if (hash(content) !== version.sha256) fail("file_integrity_failure", "文件内容校验失败");
		return content;
	}

	list(scope: Scope): ConversationFilesView {
		const state = this.load(scope);
		let changed = false;
		for (const approval of state.approvals) if (["pending", "approved"].includes(approval.status) && (this.now() >= Date.parse(approval.expiresAt) || (isAbsolute(approval.path) && !approval.parentIdentity))) { approval.status = "cancelled"; changed = true; }
		if (changed) this.save(scope, state);
		return { files: state.versions.map((v) => ({ ...v, storagePath: v.status === "deleted" ? undefined : join(this.directory(scope), `${v.artifactId}-v${v.version}.txt`) })), approvals: state.approvals.filter((a) => a.status === "pending").map((a) => ({ id: a.id, operation: a.operation, path: a.path, expectedVersion: a.expectedVersion, expectedSha256: a.expectedSha256, content: a.content, sourceVersion: a.sourceVersion, before: a.before, status: a.status, createdAt: a.createdAt, expiresAt: a.expiresAt })) };
	}
	read(scope: Scope, path: string, version?: number): { file: TaskFileVersion; content: string } {
		if ((!validPath(path) && !validLocalPath(path)) || (version !== undefined && (!Number.isSafeInteger(version) || version < 1))) fail("file_input_invalid", "文件路径或版本无效", 400);
		const state = this.load(scope);
		const file = version === undefined ? this.current(state, path) : state.versions.find((v) => v.path === path && v.version === version);
		if (!file || file.status === "deleted") fail("file_not_found", "文件不存在；已删除文件可读取删除前的版本", 404);
		return { file: { ...file, storagePath: join(this.directory(scope), `${file.artifactId}-v${file.version}.txt`) }, content: this.content(scope, file) };
	}

	async authorize(request: ApprovalRequest, signal?: AbortSignal): Promise<{ approved: boolean; approvalId?: string }> {
		if (request.tool !== "file_write" && request.tool !== "file_delete") return { approved: false };
		signal?.throwIfAborted();
		const operation = request.tool === "file_write" ? "write" : "delete";
		if (!validMutation(request.input, operation)) return { approved: false };
		const input = this.resolveMutation(request, request.input);
		const inputDigest = mutationDigest(operation, input);
		const state = this.load(request);
		let approval = state.approvals.find((a) => a.idempotencyKey === request.idempotencyKey);
		if (approval && (approval.inputDigest !== inputDigest || approval.actorId !== request.actorId)) fail("file_idempotency_conflict", "操作请求与原始授权不匹配");
		if (!approval) {
			this.checkVersion(state, input);
			const previous = this.current(state, input.path);
			if (!isAbsolute(input.path) && operation === "delete" && (!previous || previous.status === "deleted")) fail("file_not_found", "文件不存在", 404);
			if (state.approvals.length >= 512 || state.versions.reduce((sum, v) => sum + v.size, 0) + Buffer.byteLength(input.content ?? "") > 20 * 1024 * 1024) fail("file_quota_exceeded", "当前会话文件区已达到配额", 413);
			approval = { id: randomUUID(), operation, ...input, inputDigest, requestDigest: `sha256:${hash(JSON.stringify(request.input))}`, idempotencyKey: request.idempotencyKey, actorId: request.actorId, executionId: request.executionId, toolCallId: request.toolCallId, status: "pending", createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 120_000).toISOString(), before: !isAbsolute(input.path) && previous && previous.status !== "deleted" ? this.content(request, previous) : undefined };
			if (isAbsolute(input.path)) {
				const disk = this.local.inspect(input.path);
				approval.parentIdentity = this.local.check(input.path);
				approval.fileIdentity = disk?.identity;
				approval.before = disk?.content;
			}
			state.approvals.push(approval);
			this.save(request, state);
		}
		// Waiting does not hold a storage lock. Abort/timeout cancels the exact pending request.
		try {
			while (approval.status === "pending") {
				await delay(200, undefined, { signal });
				approval = this.load(request).approvals.find((a) => a.id === approval!.id)!;
				if (this.now() >= Date.parse(approval.expiresAt)) { this.cancel(request, approval.id); return { approved: false }; }
			}
			signal?.throwIfAborted();
			return { approved: approval.status === "approved" || approval.status === "applied", approvalId: approval.id };
		} catch (error) {
			if (signal?.aborted) { try { this.cancel(request, approval.id); } catch { /* A deleted conversation is already inaccessible. */ } }
			throw error;
		}
	}

	private cancel(scope: Scope, id: string): void {
		const state = this.load(scope);
		const approval = state.approvals.find((a) => a.id === id);
		if (approval && (approval.status === "pending" || approval.status === "approved")) { approval.status = "cancelled"; this.save(scope, state); }
	}
	decide(scope: Scope, id: string, decision: "approved" | "rejected"): void {
		if (decision !== "approved" && decision !== "rejected") fail("file_input_invalid", "审批决定无效", 400);
		const state = this.load(scope);
		const approval = state.approvals.find((a) => a.id === id);
		if (!approval) fail("file_approval_not_found", "审批不存在", 404);
		if (approval.status === decision || (decision === "approved" && approval.status === "applied")) return;
		if (approval.status !== "pending" || this.now() >= Date.parse(approval.expiresAt)) fail("file_approval_expired", "审批已结束或过期，请让 Agent 重新发起");
		if (decision === "approved") { this.checkVersion(state, approval); this.checkParent(approval); }
		approval.status = decision;
		approval.decidedBy = scope.actorId;
		approval.decidedAt = new Date(this.now()).toISOString();
		this.save(scope, state);
	}

	apply(operation: "write" | "delete", value: unknown, context: AgentToolExecutionContext): TaskFileVersion {
		context.signal.throwIfAborted();
		if (!validMutation(value, operation)) fail("file_input_invalid", "文件操作参数无效", 400);
		const input = this.resolveMutation(context, value);
		const state = this.load(context);
		const approval = state.approvals.find((a) => a.id === context.approvalId);
		if (!approval || approval.idempotencyKey !== context.idempotencyKey || approval.actorId !== context.actorId || approval.inputDigest !== mutationDigest(operation, input)) fail("file_approval_required", "文件操作缺少匹配的审批", 403);
		if (approval.status === "applied" && approval.result) return { ...approval.result, storagePath: approval.result.status === "deleted" ? undefined : join(this.directory(context), `${approval.result.artifactId}-v${approval.result.version}.txt`) };
		if (approval.status !== "approved" || !approval.decidedBy || approval.decidedBy.startsWith("policy:") || this.now() >= Date.parse(approval.expiresAt)) fail("file_approval_required", "文件审批无效或已过期", 403);
		this.checkVersion(state, input);
		this.checkParent(approval);
		if (isAbsolute(input.path)) return this.applyLocal(operation, input, context, state, approval);
		const previous = this.current(state, input.path);
		if (state.versions.reduce((sum, v) => sum + v.size, 0) + Buffer.byteLength(input.content ?? "") > 20 * 1024 * 1024) fail("file_quota_exceeded", "当前会话文件区已达到配额", 413);
		if (previous && previous.status !== "deleted") this.content(context, previous); // Detect disk changes after review.
		const version: TaskFileVersion = { artifactId: `file-${hash(input.path)}`, path: input.path, version: (previous?.version ?? 0) + 1, sha256: hash(input.content ?? ""), size: Buffer.byteLength(input.content ?? ""), status: operation === "delete" ? "deleted" : "draft", createdAt: new Date(this.now()).toISOString(), actorId: context.actorId, executionId: context.executionId, approvalId: approval.id, ...(input.sourceVersion ? { restoredFromVersion: input.sourceVersion } : {}) };
		if (operation === "write") {
			const path = join(this.directory(context), `${version.artifactId}-v${version.version}.txt`);
			// A crash before manifest publication may leave this immutable, unreferenced blob.
			if (existsSync(path)) {
				if (this.readSafe(path) !== input.content) fail("file_recovery_conflict", "存在未提交的文件版本，需要检查后恢复");
			} else this.writeNew(path, input.content!);
		}
		state.versions.push(version);
		approval.status = "applied";
		approval.result = version;
		this.save(context, state); // Version, decision and receipt commit together.
		return { ...version, storagePath: version.status === "deleted" ? undefined : join(this.directory(context), `${version.artifactId}-v${version.version}.txt`) };
	}

	tools(): AgentHostTool[] {
		return conversationFileToolNames.map((name): AgentHostTool => {
			const write = name === "file_write"; const remove = name === "file_delete"; const list = name === "file_list";
			return { name, execution: "host", risk: write || remove ? "write" : "read", idempotent: true, timeoutMs: 5_000, maxResultChars: 150_000,
				description: list ? "不传 path 返回本机真实 homeDirectory、workingDirectory 等位置和会话历史。指定绝对目录 path 列出磁盘目录，无需预授权。" : name === "file_read" ? "读取本机真实 UTF-8 文件，返回 absolutePath 与 sha256。相对路径读取旧会话文件；指定 version 读取历史备份。" : write ? "在真实绝对路径新建或修改文本文件，调用即发起显示路径和内容的单次审批，批准后执行，无需用户提前授权目录。先读取 sha256 作为 expectedSha256，新建使用 null。相对路径仅用于会话存储，使用 expectedVersion。恢复历史版本时传 sourceVersion 代替 content，由 Host 读取同一路径的不可变备份并展示新的写入审批；旧版本和审批不被覆盖。最多128 KiB。" : "审批后删除真实绝对路径文件；先读取 sha256 作为 expectedSha256。保留内容备份，不支持删除目录。相对路径使用旧会话 expectedVersion。",
				inputSchema: { type: "object", properties: list ? { path: { type: "string" } } : { path: { type: "string" }, ...(write || remove ? { expectedVersion: { type: ["integer", "null"], minimum: 1 }, expectedSha256: { type: ["string", "null"] } } : { version: { type: "integer", minimum: 1 } }), ...(write ? { content: { type: "string" }, sourceVersion: { type: "integer", minimum: 1 } } : {}) }, required: list ? [] : ["path"], ...(write ? { oneOf: [{ required: ["content"] }, { required: ["sourceVersion"] }] } : {}), additionalProperties: false },
				validate: (input) => write || remove ? validMutation(input, write ? "write" : "delete") : record(input) && (list ? Object.keys(input).every((key) => key === "path") && (input.path === undefined || validLocalPath(input.path)) : (validPath(input.path) || validLocalPath(input.path)) && Object.keys(input).every((key) => ["path", "version"].includes(key)) && (input.version === undefined || (Number.isSafeInteger(input.version) && Number(input.version) > 0))),
				createIdempotencyKey: (input, turnKey, scope) => {
					const value = input as Mutation;
					return `file:${hash(JSON.stringify([scope?.tenantId, scope?.workspaceId, scope?.runId, name, turnKey, value.path, value.expectedVersion ?? value.expectedSha256 ?? null, value.content ?? null, ...(value.sourceVersion === undefined ? [] : [value.sourceVersion])]))}`;
				},
				execute: async (input, context) => {
					context.signal.throwIfAborted();
					if (write || remove) return this.apply(write ? "write" : "delete", input, context);
					if (list) return this.browse(context, (input as { path?: string }).path);
					const value = input as { path: string; version?: number };
					return isAbsolute(value.path) && value.version === undefined ? this.readLocal(context, value.path) : this.read(context, value.path, value.version);
				},
			};
		});
	}
}
