import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import {
	ConversationAttachmentError,
	FileConversationAttachmentStore,
} from "./conversationAttachments";
import { createProjectSourceReadTool } from "./requirementTools";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("FileConversationAttachmentStore", () => {
	it("persists tenant-scoped attachments and makes retries idempotent", () => {
		const directory = mkdtempSync(join(tmpdir(), "blackx-attachments-"));
		directories.push(directory);
		const store = new FileConversationAttachmentStore(
			directory,
			() => "2026-09-04T12:00:00.000Z",
		);
		const scope = {
			tenantId: "tenant-a",
			workspaceId: "workspace-a",
			conversationId: "conversation-a",
		};
		const input = {
			requestId: "upload-1",
			name: "requirements.txt",
			mediaType: "application/octet-stream",
			content: Buffer.from("quantity: 5000", "utf8"),
		};

		const created = store.put(scope, input);
		const duplicate = store.put(scope, input);

		expect(created).toMatchObject({
			duplicate: false,
			attachment: {
				conversationId: "conversation-a",
				name: "requirements.txt",
				mediaType: "text/plain",
				kind: "text",
				modelInput: "text_extracted",
			},
		});
		expect(duplicate).toEqual({ attachment: created.attachment, duplicate: true });
		expect(store.list(scope)).toEqual([created.attachment]);
		expect(store.readText(scope)).toMatchObject([{
			attachmentId: created.attachment.attachmentId,
			name: "requirements.txt",
			content: "quantity: 5000",
			sourceRef: created.attachment.sourceRef,
		}]);
		expect(() => store.read({ ...scope, tenantId: "tenant-b" }, created.attachment.attachmentId)).toThrowError(
			expect.objectContaining({ code: "attachment_not_found" }) as Partial<ConversationAttachmentError>,
		);
	});

	it("rejects reuse of an upload request id for different content", () => {
		const directory = mkdtempSync(join(tmpdir(), "blackx-attachments-"));
		directories.push(directory);
		const store = new FileConversationAttachmentStore(directory);
		const scope = {
			tenantId: "tenant-a",
			workspaceId: "workspace-a",
			conversationId: "conversation-a",
		};
		const image = store.put(scope, {
			requestId: "upload-1",
			name: "reference.png",
			mediaType: "image/png",
			content: Buffer.from("one"),
		});
		expect(image.attachment).toMatchObject({ kind: "image", modelInput: "image" });
		const reference = store.imageReferences(scope, [image.attachment.attachmentId])[0];
		expect(reference).toMatchObject({
			type: "image",
			name: "reference.png",
			mediaType: "image/png",
		});
		expect(reference.data).toBeUndefined();
		expect(store.resolveImage(scope, reference)).toMatchObject({
			...reference,
			data: Buffer.from("one").toString("base64"),
		});

		expect(() => store.put(scope, {
			requestId: "upload-1",
			name: "reference.png",
			mediaType: "image/png",
			content: Buffer.from("two"),
		})).toThrowError(expect.objectContaining({
			code: "attachment_conflict",
		}) as Partial<ConversationAttachmentError>);
	});

	it("returns the frozen text attachment snapshot to the Requirement source tool", async () => {
		const directory = mkdtempSync(join(tmpdir(), "blackx-attachments-"));
		directories.push(directory);
		const attachments = new FileConversationAttachmentStore(directory);
		const scope = {
			tenantId: "tenant-a",
			workspaceId: "workspace-a",
			conversationId: "conversation-a",
		};
		attachments.put(scope, {
			requestId: "upload-1",
			name: "requirements.txt",
			mediaType: "text/plain",
			content: Buffer.from("quantity: 5000"),
		});
		const runScope = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, runId: "run-a" };
		const engine = new ProposalRunEngine(new InMemoryEnterpriseEventStore(), "requirement-brief");
		const command = (commandId: string, expectedVersion: number) => ({
			...runScope,
			actorId: "user-a",
			commandId,
			correlationId: "trace-a",
			expectedVersion,
		});
		engine.create(command("create", 0));
		engine.startProposal(command("start", 1));
		engine.recordFactVersion({
			...command("brief", 2),
			factKey: "customer_brief",
			factVersion: 1,
			value: "Coffee bag",
			status: "unverified",
			sourceType: "user_input",
			sourceRef: "conversation:conversation-a:revision:1",
		});
		engine.recordFactVersion({
			...command("industry", 3),
			factKey: "industry",
			factVersion: 1,
			value: "print",
			status: "verified",
			sourceType: "human_confirmation",
			sourceRef: "ui:industry:print",
		});
		engine.recordFactVersion({
			...command("attachments", 4),
			factKey: "customer_attachments",
			factVersion: 1,
			value: attachments.digest(scope)!,
			status: "unverified",
			sourceType: "source_document",
			sourceRef: `conversation:${scope.conversationId}:attachments:${attachments.digest(scope)}`,
		});

		const tool = createProjectSourceReadTool(engine, attachments);
		const result = await tool.execute(
			{ sourceId: "customer-brief" },
			{
				...runScope,
				stageId: "requirement-brief",
				actorId: "worker",
				executionId: "execution-a",
				toolCallId: "tool-a",
				idempotencyKey: "tool-a",
				signal: new AbortController().signal,
			},
		) as { textAttachments: Array<{ content: string; sourceRef: string }> };

		expect(result.textAttachments).toEqual([expect.objectContaining({
			content: "quantity: 5000",
			sourceRef: expect.stringMatching(/^attachment:\/\//),
		})]);
		const context = { ...runScope, stageId: "requirement-brief", actorId: "worker", executionId: "execution-a", toolCallId: "tool-a", idempotencyKey: "tool-a", signal: new AbortController().signal };
		expect(() => tool.validateContextResult!({ sourceId: "customer-brief" }, JSON.stringify(result), context)).not.toThrow();
		const source = attachments.list(scope)[0];
		attachments.withdraw(scope, source.attachmentId, { requestId: "withdraw", actorId: "user-a", reason: "旧订单附件不再适用", sha256: source.sha256 });
		expect(() => tool.validateContextResult!({ sourceId: "customer-brief" }, JSON.stringify(result), context)).toThrow();

	});
});
