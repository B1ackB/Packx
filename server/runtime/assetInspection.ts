import { pageUnits } from "./contextRead";
import { processIsGone } from "../localData";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentSandboxedTool, AgentToolExecutionContext } from "../../src/agent/contracts";
import type { SandboxedToolExecutorPort, ToolExecutionManifest, ToolExecutionResult } from "../../src/agent/sandbox";
import { compileToolExecutionManifest, validToolExecutionResult } from "../../src/agent/sandbox";
import { isAssetInspection, type AssetInspectionRecord } from "../../src/runtime/assetInspection";
import { RuntimeFailure } from "../../src/runtime/contracts";
import type { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { FileConversationAttachmentStore, type ConversationAttachmentScope } from "./conversationAttachments";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";

/** Host adapter: only a copy of the selected input crosses into the native parser. */
export class AssetInspectionService implements SandboxedToolExecutorPort {
	private readonly inputs = new Map<string, { directory: string; run: { tenantId: string; workspaceId: string; runId: string }; offset: number; record: Omit<AssetInspectionRecord, "inspection"> }>();
	private readonly cache: FileArtifactContentStore;
	constructor(
		private readonly engine: ProposalRunEngine,
		private readonly attachments: FileConversationAttachmentStore,
		private readonly executor: SandboxedToolExecutorPort,
		private readonly workspaceRoot: string,
		private readonly executable = resolve(".blackx-tools/asset-inspector"),
		cacheDirectory = join(workspaceRoot, ".blackx-data", "inspection-cache"),
	) {
		this.cache = new FileArtifactContentStore(cacheDirectory);
		reapAbandonedInputs(join(workspaceRoot, ".blackx-tool-inputs"));
	}

	scope(run: { tenantId: string; workspaceId: string; runId: string }): ConversationAttachmentScope {
		const state = this.engine.load(run);
		const conversationId = /^conversation:(.+):revision:\d+$/.exec(state.facts.customer_brief?.sourceRef ?? "")?.[1];
		if (!conversationId) throw new RuntimeFailure("context_failure", "需求来源不可用", false);
		const scope = { tenantId: run.tenantId, workspaceId: run.workspaceId, conversationId };
		if (this.attachments.digest(scope) !== state.facts.customer_attachments?.value) {
			throw new RuntimeFailure("context_failure", "资料已变化，请重新审查需求单", false);
		}
		return scope;
	}

	documentTool(readLocal: (context: AgentToolExecutionContext, path: string) => { content: Buffer; sha256: string }): AgentSandboxedTool {
		return this.tool(readLocal);
	}

	async preview(context: { tenantId: string; workspaceId: string; actorId: string; runId: string }, path: string, readLocal: (context: AgentToolExecutionContext, path: string) => { content: Buffer; sha256: string }, signal: AbortSignal): Promise<AssetInspectionRecord> {
		const tool = this.documentTool(readLocal);
		const id = randomUUID();
		const scope = { ...context, signal, stageId: "document-preview", executionId: id, toolCallId: id, idempotencyKey: id, sandboxAttemptId: id };
		const invocation = await tool.createInvocation({ path }, scope);
		const manifest = compileToolExecutionManifest({ ...scope, attemptId: id, tool: { name: tool.name, version: tool.version }, command: { executable: tool.executable, argv: invocation.argv, workingDirectory: invocation.workingDirectory }, paths: invocation.paths, environment: tool.sandbox.environment, network: tool.sandbox.network, limits: { ...tool.sandbox.limits, timeoutMs: tool.timeoutMs } });
		const result = await this.execute(manifest, signal);
		if (result.status !== "succeeded") throw new RuntimeFailure("invalid_output", "Document parser failed: " + result.status, false);
		return JSON.parse(result.stdout.text) as AssetInspectionRecord;
	}

	tool(readLocal?: (context: AgentToolExecutionContext, path: string) => { content: Buffer; sha256: string }): AgentSandboxedTool {
		return {
			validateContextResult: (input, output, context) => {
				const result = JSON.parse(output) as { stdout: { text: string } };
				const record = JSON.parse(result.stdout.text) as AssetInspectionRecord;
				const value = input as { attachmentId?: string; path?: string };
				const scope = readLocal && context.stageId !== "requirement-brief" ? { tenantId: context.tenantId, workspaceId: context.workspaceId, conversationId: context.runId } : this.scope(context);
				const sha256 = value.path && readLocal ? readLocal(context, value.path).sha256 : this.attachments.read(scope, value.attachmentId!).attachment.sha256;
				if (sha256 !== record.sha256) throw new RuntimeFailure("context_failure", "Document source changed", false);
			},
			name: readLocal ? "document_read" : "asset_metadata_inspect", version: "1.2.0", execution: "sandboxed",
			description: "Inspect one current customer attachment in an offline native sandbox. Extract actual PDF pages, Word DOCX paragraphs/tables, Excel XLSX sheet/cell raw stored values (number/date display formatting is not applied), UTF-8 text or image metadata. Use attachmentId for an uploaded file or path for an absolute local file. Legacy DOC/XLS, encrypted documents and image-only scans need conversion/OCR. Formulas use cached values only, never run macros. Output is paginated by complete lines. Pass the returned continuation.cursor with the same source to continue; each call rechecks permission and source hash. sourceTruncated means the parser limit was reached; do not claim complete coverage. Never establishes verified business facts.",
			inputSchema: { type: "object", properties: { attachmentId: { type: "string", pattern: "^attachment-[a-f0-9]+$" }, ...(readLocal ? { cursor: { type: "string", description: "sha256:offset from previous result; rechecks the current source hash" }, path: { type: "string", description: "Absolute local document path" } } : {}) }, ...(readLocal ? {} : { required: ["attachmentId"] }), additionalProperties: false },
			validate: (input) => Boolean(input && typeof input === "object" && Object.keys(input).filter((key) => key !== "cursor").length === 1 && (!("cursor" in input) || (readLocal && typeof input.cursor === "string" && /^[a-f0-9]{64}:\d{1,7}$/.test(input.cursor))) && (("attachmentId" in input && typeof input.attachmentId === "string" && /^attachment-[a-f0-9]+$/.test(input.attachmentId)) || (readLocal && "path" in input && typeof input.path === "string" && input.path.startsWith("/") && input.path.length <= 4096))),
			risk: "read", idempotent: true, timeoutMs: 15_000, maxResultChars: readLocal ? 24_000 : 180_000,
			executable: this.executable,
			sandbox: { environment: { LANG: "en_US.UTF-8" }, network: { mode: "deny-all", allowedDomains: [] }, limits: { maxStdoutBytes: 8_000_000, maxStderrBytes: 4096, maxOutputFiles: 0, maxOutputBytes: 0 } },
			createInvocation: (input, context) => {
				context.signal.throwIfAborted();
				const value = input as { attachmentId?: string; path?: string; cursor?: string };
				const local = value.path && readLocal ? readLocal(context, value.path) : undefined;
				const scope = readLocal && context.stageId !== "requirement-brief" ? { tenantId: context.tenantId, workspaceId: context.workspaceId, conversationId: context.runId } : this.scope(context);
				const { attachment, content } = local ? { content: local.content, attachment: { attachmentId: `local-${createHash("sha256").update(value.path!).digest("hex")}`, name: basename(value.path!), sha256: local.sha256, sourceRef: `local-file:${value.path!}` } } : this.attachments.read(scope, value.attachmentId!);
				if (value.cursor && value.cursor.split(":")[0] !== attachment.sha256) throw new RuntimeFailure("context_failure", "Document source changed since previous page", false);
				const inputRoot = join(this.workspaceRoot, ".blackx-tool-inputs");
				mkdirSync(inputRoot, { recursive: true, mode: 0o700 });
				if (lstatSync(inputRoot).isSymbolicLink() || realpathSync(inputRoot) !== join(realpathSync(this.workspaceRoot), ".blackx-tool-inputs")) throw new RuntimeFailure("permission_denied", "Staging directory must remain inside the Workspace", false);
				const directory = join(inputRoot, context.sandboxAttemptId);
				mkdirSync(directory, { mode: 0o700 });
				const path = join(directory, "input.bin");
				try {
					writeFileSync(join(directory, ".owner.json"), JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
					writeFileSync(path, content, { flag: "wx", mode: 0o400 });
				} catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
				this.inputs.set(context.sandboxAttemptId, { directory, offset: Number(value.cursor?.split(":")[1] ?? 0), run: { tenantId: context.tenantId, workspaceId: context.workspaceId, runId: context.runId }, record: {
					attachmentId: attachment.attachmentId, name: attachment.name, sha256: attachment.sha256,
					sourceRef: attachment.sourceRef, parserVersion: "1.2.0",
				} });
				return { argv: [path], workingDirectory: directory, paths: { readOnly: [path], writable: [], temporaryDirectory: join(directory, "output") } };
			},
		};
	}

	async execute(manifest: ToolExecutionManifest, signal: AbortSignal): Promise<ToolExecutionResult> {
		if (!["asset_metadata_inspect", "document_read"].includes(manifest.tool.name)) return this.executor.execute(manifest, signal);
		const prepared = this.inputs.get(manifest.attemptId);
		if (!prepared || manifest.command.executable !== this.executable || manifest.command.argv[0] !== join(prepared.directory, "input.bin")) {
			throw new RuntimeFailure("permission_denied", "Native parser invocation is not Host-owned", false);
		}
		try {
			const result = await this.executor.execute(manifest, signal);
			signal.throwIfAborted();
			if (!validToolExecutionResult(result, manifest)) throw new RuntimeFailure("invalid_output", "Native parser result is invalid", false);
			if (result.status !== "succeeded") return result;
			const inspection: unknown = JSON.parse(result.stdout.text);
			if (!isAssetInspection(inspection)) throw new RuntimeFailure("invalid_output", "Native parser schema is invalid", false);
			const record = { ...prepared.record, inspection };
			// A content-addressed parser observation survives context compaction and Worker restarts.
			// The Worker still validates the frozen source digest and imports a versioned Artifact.
			this.cache.putJson({ ...prepared.run, artifactId: this.cacheId(record.attachmentId, record.sha256), artifactVersion: 1 }, record);
			if (manifest.tool.name === "document_read") {
				const lines = inspection.pages.flatMap((page) => page.text.split("\n").map((text, line) => ({ page: page.page, line: line + 1, text })));
				const page = pageUnits(lines, prepared.offset, 14_000);
				const groups = new Map<number, string[]>();
				for (const line of page.items) groups.set(line.page, [...(groups.get(line.page) ?? []), `[line ${line.line}] ${line.text}`]);
				return { ...result, stdout: { text: JSON.stringify({ ...record, inspection: { ...inspection, pages: [...groups].map(([page, texts]) => ({ page, text: texts.join("\n") })), truncated: page.truncated || inspection.truncated },
					continuation: { cursor: page.nextOffset === null || page.error ? null : `${record.sha256}:${page.nextOffset}`, offset: prepared.offset, total: page.total, sourceTruncated: inspection.truncated, ...(page.error ? { error: page.error } : {}) } }), truncated: false } };
			}
			return { ...result, stdout: { text: JSON.stringify(record), truncated: false } };
		} finally {
			this.inputs.delete(manifest.attemptId);
			rmSync(prepared.directory, { recursive: true, force: true });
		}
	}

	private cacheId(attachmentId: string, sha256: string): string {
		return `inspection-${createHash("sha256").update(`${attachmentId}:${sha256}:1.2.0`).digest("hex")}`;
	}

	readRecords(run: { tenantId: string; workspaceId: string; runId: string }): AssetInspectionRecord[] {
		const scope = this.scope(run);
		return this.attachments.list(scope).map((attachment) => {
			let value: AssetInspectionRecord;
			try { value = this.cache.readJson({ ...run, artifactId: this.cacheId(attachment.attachmentId, attachment.sha256), artifactVersion: 1 }) as AssetInspectionRecord; }
			catch { throw new RuntimeFailure("invalid_output", "尚未成功检查所有资料，请重试。", false); }
			const stored = this.attachments.read(scope, attachment.attachmentId);
			if (!isAssetInspection(value.inspection) || value.sha256 !== attachment.sha256 || value.inspection.bytes !== stored.content.length || value.parserVersion !== "1.2.0") throw new RuntimeFailure("invalid_output", "解析记录与原始资料不匹配", false);
			return { attachmentId: attachment.attachmentId, name: attachment.name, sha256: attachment.sha256, sourceRef: attachment.sourceRef, parserVersion: value.parserVersion, inspection: value.inspection };
		});
	}

}

export function inspectionArtifactId(attachmentId: string): string {
	return `asset-inspection-${createHash("sha256").update(attachmentId).digest("hex").slice(0, 24)}`;
}

export function reapAbandonedInputs(root: string) {
	if (!existsSync(root)) return;
	if (lstatSync(root).isSymbolicLink()) throw new Error("unsafe_staging_root");
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^[A-Za-z0-9-]+$/.test(entry.name)) continue;
		const directory = join(root, entry.name);
		const owner = join(directory, ".owner.json");
		if (existsSync(owner)) {
			const stat = lstatSync(owner);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) continue;
			let pid: number;
			try { pid = JSON.parse(readFileSync(owner, "utf8")).pid; } catch { continue; }
			if (processIsGone(pid)) rmSync(directory, { recursive: true, force: true });
		} else if (Date.now() - statSync(directory).mtimeMs > 86_400_000) {
			// Compatibility cleanup for old releases whose native jobs were limited to 15 seconds.
			rmSync(directory, { recursive: true, force: true });
		}
	}
}
