import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentImageAttachment } from "../../src/agent/contracts";
import type { ConversationAttachment } from "../../src/runtime/conversationContracts";

export interface ConversationAttachmentScope {
	tenantId: string;
	workspaceId: string;
	conversationId: string;
}

export class ConversationAttachmentError extends Error {
	constructor(
		readonly code: "invalid_attachment" | "attachment_conflict" | "attachment_not_found" | "attachment_withdrawn" | "attachment_store_unavailable",
		message: string,
	) {
		super(message);
		this.name = "ConversationAttachmentError";
	}
}

const textTypes = new Set([
	"application/json",
	"text/csv",
	"text/markdown",
	"text/plain",
]);
const previewImageTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

function id(value: string, name: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new ConversationAttachmentError("invalid_attachment", `${name} is invalid`);
	}
	return value;
}

function name(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 200 || /[\u0000-\u001f/\\]/.test(trimmed)) {
		throw new ConversationAttachmentError("invalid_attachment", "attachment name is invalid");
	}
	return trimmed;
}

function mediaType(value: string, fileName: string): string {
	let normalized = value.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
	if (normalized === "application/octet-stream") {
		const extension = fileName.toLowerCase().split(".").at(-1);
		normalized = {
			csv: "text/csv",
			json: "application/json",
			md: "text/markdown",
			txt: "text/plain",
		}[extension ?? ""] ?? normalized;
	}
	if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)) {
		throw new ConversationAttachmentError("invalid_attachment", "attachment media type is invalid");
	}
	return normalized;
}

function kind(value: string): ConversationAttachment["kind"] {
	if (previewImageTypes.has(value)) return "image";
	if (textTypes.has(value)) return "text";
	return "file";
}

export class FileConversationAttachmentStore {
	constructor(
		private readonly rootDirectory: string,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	put(
		scope: ConversationAttachmentScope,
		input: { requestId: string; name: string; mediaType: string; content: Buffer },
	): { attachment: ConversationAttachment; duplicate: boolean } {
		const requestId = id(input.requestId, "requestId");
		const attachmentName = name(input.name);
		const attachmentMediaType = mediaType(input.mediaType, attachmentName);
		if (input.content.byteLength === 0 || input.content.byteLength > 10 * 1024 * 1024) {
			throw new ConversationAttachmentError("invalid_attachment", "attachment must be between 1 byte and 10 MB");
		}
		if (textTypes.has(attachmentMediaType)) {
			try {
				new TextDecoder("utf-8", { fatal: true }).decode(input.content);
			} catch {
				throw new ConversationAttachmentError("invalid_attachment", "text attachment must be valid UTF-8");
			}
		}
		const directory = this.directory(scope);
		const attachmentId = `attachment-${createHash("sha256")
			.update(`${scope.tenantId}\u0000${scope.workspaceId}\u0000${scope.conversationId}\u0000${requestId}`)
			.digest("hex")
			.slice(0, 32)}`;
		const sha256 = createHash("sha256").update(input.content).digest("hex");
		const metadataPath = join(directory, `${attachmentId}.json`);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		return this.withLock(metadataPath, () => {
			if (existsSync(metadataPath)) {
				const existing = this.readMetadata(metadataPath);
				if (
					existing.name !== attachmentName ||
					existing.mediaType !== attachmentMediaType ||
					existing.size !== input.content.byteLength ||
					existing.sha256 !== sha256
				) {
					throw new ConversationAttachmentError(
						"attachment_conflict",
						"requestId is already bound to another attachment",
					);
				}
				return { attachment: existing, duplicate: true };
			}
			const existingAttachments = this.list(scope, { includeWithdrawn: true });
			if (
				existingAttachments.length >= 20 ||
				existingAttachments.reduce((total, attachment) => total + attachment.size, 0) + input.content.byteLength > 50 * 1024 * 1024
			) {
				throw new ConversationAttachmentError(
					"invalid_attachment",
					"a conversation may contain up to 20 attachments and 50 MB",
				);
			}
			const attachment: ConversationAttachment = {
				attachmentId,
				conversationId: scope.conversationId,
				name: attachmentName,
				mediaType: attachmentMediaType,
				size: input.content.byteLength,
				sha256,
				kind: kind(attachmentMediaType),
				modelInput: textTypes.has(attachmentMediaType)
					? "text_extracted"
					: kind(attachmentMediaType) === "image" && input.content.byteLength <= 5 * 1024 * 1024
						? "image"
						: "metadata_only",
				sourceRef: `attachment://${attachmentId}`,
				createdAt: this.now(),
			};
			this.atomicWrite(join(directory, `${attachmentId}.bin`), input.content);
			this.atomicWrite(metadataPath, Buffer.from(JSON.stringify(attachment), "utf8"));
			return { attachment, duplicate: false };
		});
	}

	/** A durable tombstone disables reads before downstream invalidation; retries finish Host reconciliation. */
	withdraw(scope: ConversationAttachmentScope, attachmentId: string, input: { requestId: string; actorId: string; reason: string; sha256: string }): ConversationAttachment {
		id(input.requestId, "requestId"); id(input.actorId, "actorId");
		if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000 || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new ConversationAttachmentError("invalid_attachment", "withdrawal reason and source hash are required");
		const path = join(this.directory(scope), `${id(attachmentId, "attachmentId")}.json`);
		const stored = this.read(scope, attachmentId, { includeWithdrawn: true }).attachment;
		if (stored.sha256 !== input.sha256) throw new ConversationAttachmentError("attachment_conflict", "withdrawal targets a different attachment version");
		return this.withLock(path, () => {
			const current = this.readMetadata(path);
			if (current.withdrawal) {
				if (current.withdrawal.requestId === input.requestId && (current.withdrawal.actorId !== input.actorId || current.withdrawal.reason !== input.reason.trim())) throw new ConversationAttachmentError("attachment_conflict", "withdrawal requestId has different input");
				return current;
			}
			this.atomicWrite(`${path}.withdrawal`, Buffer.from(JSON.stringify({ requestId: input.requestId, actorId: input.actorId, sha256: input.sha256, reason: input.reason.trim(), at: this.now() })));
			return this.readMetadata(path);
		});
	}

	list(scope: ConversationAttachmentScope, options: { includeWithdrawn?: boolean } = {}): ConversationAttachment[] {
		const directory = this.directory(scope);
		if (!existsSync(directory)) return [];
		return readdirSync(directory)
			.filter((entry) => entry.endsWith(".json"))
			.map((entry) => this.readMetadata(join(directory, entry)))
			.filter((attachment) => options.includeWithdrawn || !attachment.withdrawal)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	read(scope: ConversationAttachmentScope, attachmentId: string, options: { includeWithdrawn?: boolean } = {}): {
		attachment: ConversationAttachment;
		content: Buffer;
	} {
		const targetId = id(attachmentId, "attachmentId");
		const directory = this.directory(scope);
		const metadataPath = join(directory, `${targetId}.json`);
		const contentPath = join(directory, `${targetId}.bin`);
		if (!existsSync(metadataPath) || !existsSync(contentPath)) {
			throw new ConversationAttachmentError("attachment_not_found", "attachment does not exist");
		}
		const attachment = this.readMetadata(metadataPath);
		if (attachment.withdrawal && !options.includeWithdrawn) throw new ConversationAttachmentError("attachment_withdrawn", "attachment was withdrawn and is no longer valid evidence");
		const content = readFileSync(contentPath);
		if (attachment.attachmentId !== targetId || attachment.conversationId !== scope.conversationId || attachment.size !== content.length || createHash("sha256").update(content).digest("hex") !== attachment.sha256) {
			throw new ConversationAttachmentError("attachment_conflict", "attachment integrity check failed");
		}
		return { attachment, content };
	}

	digest(scope: ConversationAttachmentScope): string | undefined {
		const attachments = this.list(scope);
		if (attachments.length === 0 && this.list(scope, { includeWithdrawn: true }).length === 0) return undefined;
		return createHash("sha256")
			.update(attachments.map((attachment) => [
				attachment.attachmentId,
				attachment.name,
				attachment.mediaType,
				attachment.sha256,
			].join(":"))
				.join("\n"))
			.digest("hex");
	}

	readText(scope: ConversationAttachmentScope, maxChars = 24_000): Array<{
		truncated: boolean;
		sha256: string;
		readTool: string;
		attachmentId: string;
		name: string;
		content: string;
		sourceRef: string;
	}> {
		let remaining = maxChars;
		return this.list(scope).flatMap((attachment) => {
			if (attachment.kind !== "text") return [];
			const decoded = this.read(scope, attachment.attachmentId).content.toString("utf8");
			const lines: string[] = [];
			let size = 0;
			for (const line of decoded.split("\n")) {
				const length = line.length + (lines.length ? 1 : 0);
				if (size + length > remaining) break;
				lines.push(line); size += length;
			}
			const content = lines.join("\n");
			remaining -= content.length;
			return [{
				attachmentId: attachment.attachmentId,
				name: attachment.name,
				content,
				truncated: content !== decoded,
				sha256: attachment.sha256,
				readTool: "document_read",
				sourceRef: attachment.sourceRef,
			}];
		});
	}

	imageReferences(
		scope: ConversationAttachmentScope,
		attachmentIds?: readonly string[],
	): AgentImageAttachment[] {
		const selected = attachmentIds ? new Set(attachmentIds.map((value) => id(value, "attachmentId"))) : undefined;
		const available = this.list(scope);
		if (selected && [...selected].some((attachmentId) => !available.some((item) => item.attachmentId === attachmentId))) {
			throw new ConversationAttachmentError("attachment_not_found", "selected attachment does not exist");
		}
		return available
			.filter((attachment) => attachment.modelInput === "image" && (!selected || selected.has(attachment.attachmentId)))
			.slice(0, 8)
			.map((attachment) => ({
				type: "image",
				name: attachment.name,
				mediaType: attachment.mediaType as AgentImageAttachment["mediaType"],
				sourceRef: `attachment://${scope.conversationId}/${attachment.attachmentId}`,
				sha256: attachment.sha256,
			}));
	}

	resolveImage(
		scope: { tenantId: string; workspaceId: string },
		attachment: AgentImageAttachment,
	): AgentImageAttachment {
		const match = /^attachment:\/\/([^/]+)\/([^/]+)$/.exec(attachment.sourceRef);
		if (!match) throw new ConversationAttachmentError("invalid_attachment", "image source reference is invalid");
		const stored = this.read({
			...scope,
			conversationId: match[1],
		}, match[2]);
		if (
			stored.attachment.modelInput !== "image" ||
			stored.attachment.name !== attachment.name ||
			stored.attachment.mediaType !== attachment.mediaType ||
			stored.attachment.sha256 !== attachment.sha256
		) {
			throw new ConversationAttachmentError("attachment_conflict", "image reference does not match stored content");
		}
		return { ...attachment, data: stored.content.toString("base64") };
	}

	private directory(scope: ConversationAttachmentScope): string {
		return join(
			this.rootDirectory,
			id(scope.tenantId, "tenantId"),
			id(scope.workspaceId, "workspaceId"),
			id(scope.conversationId, "conversationId"),
		);
	}

	private readMetadata(path: string): ConversationAttachment {
		try {
			const attachment = JSON.parse(readFileSync(path, "utf8")) as ConversationAttachment;
			const withdrawal = existsSync(`${path}.withdrawal`) ? JSON.parse(readFileSync(`${path}.withdrawal`, "utf8")) as ConversationAttachment["withdrawal"] : undefined;
			if (withdrawal && (withdrawal.sha256 !== attachment.sha256 || !withdrawal.requestId || !withdrawal.actorId || !withdrawal.at || !withdrawal.reason)) throw new Error("invalid_withdrawal");
			return {
				...attachment,
				...(withdrawal ? { withdrawal } : {}),
				modelInput: attachment.kind === "text"
					? "text_extracted"
					: attachment.kind === "image" && attachment.size <= 5 * 1024 * 1024
						? "image"
						: "metadata_only",
			};
		} catch {
			throw new ConversationAttachmentError("attachment_store_unavailable", "attachment metadata cannot be read");
		}
	}

	private atomicWrite(path: string, content: Buffer): void {
		const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
		try {
			writeFileSync(temporaryPath, content, { mode: 0o600 });
			renameSync(temporaryPath, path);
		} finally {
			if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		}
	}

	private withLock<T>(path: string, operation: () => T): T {
		const lockPath = `${path}.lock`;
		try {
			mkdirSync(lockPath);
		} catch {
			throw new ConversationAttachmentError("attachment_store_unavailable", "attachment is locked by another upload");
		}
		try {
			return operation();
		} finally {
			rmdirSync(lockPath);
		}
	}
}
