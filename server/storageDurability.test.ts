import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileArtifactContentStore } from "./artifacts/fileArtifactStore";
import { FileAgentStateStore } from "./runtime/fileAgentStateStore";
import { FileConversationAttachmentStore } from "./runtime/conversationAttachments";
import * as durability from "./syncDirectory";

const roots: string[] = [];
const scope = { tenantId: "tenant", workspaceId: "workspace", runId: "run", sessionId: "session" };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(["session", "artifact", "attachment"] as const)("reports a %s directory flush failure and recovers without losing the committed identity", (kind) => {
	const root = mkdtempSync(join(tmpdir(), "packx-durability-")); roots.push(root);
	const cause = new Error("injected_directory_flush_failure");
	const flush = vi.spyOn(durability, "syncDirectory").mockImplementationOnce(() => { throw cause; });
	if (kind === "session") {
		const state = new FileAgentStateStore(root), at = "2026-10-22T00:00:00.000Z";
		expect(() => state.save(scope, 0, [{ role: "user", content: "retained source" }], at)).toThrow(expect.objectContaining({ code: "unavailable", cause }));
		flush.mockRestore();
		const restarted = new FileAgentStateStore(root);
		expect(restarted.load(scope)).toMatchObject({ revision: 1, messages: [{ content: "retained source" }] });
		expect(() => restarted.save(scope, 0, [], at)).toThrow(expect.objectContaining({ code: "conflict" }));
		restarted.save(scope, 1, [{ role: "user", content: "retained source" }], at);
		expect(restarted.load(scope).revision).toBe(2);
	} else if (kind === "artifact") {
		const key = { ...scope, artifactId: "brief", artifactVersion: 1 }, value = { quantity: 5000 };
		expect(() => new FileArtifactContentStore(root).putJson(key, value)).toThrow(expect.objectContaining({ code: "artifact_store_unavailable", cause }));
		flush.mockRestore();
		const restarted = new FileArtifactContentStore(root);
		expect(restarted.readJson(key)).toEqual(value);
		expect(restarted.putJson(key, value)).toBe("artifact://brief/v1");
		expect(() => restarted.putJson(key, { quantity: 6000 })).toThrow(expect.objectContaining({ code: "artifact_conflict" }));
	} else {
		const owner = { ...scope, conversationId: "conversation" }, input = { requestId: "upload", name: "source.txt", mediaType: "text/plain", content: Buffer.from("retained source") };
		expect(() => new FileConversationAttachmentStore(root).put(owner, input)).toThrow(expect.objectContaining({ code: "attachment_store_unavailable", cause }));
		flush.mockRestore();
		const restarted = new FileConversationAttachmentStore(root);
		expect(restarted.list(owner)).toEqual([]);
		expect(() => restarted.put(owner, { ...input, name: "replacement.txt" })).toThrow(expect.objectContaining({ code: "attachment_conflict" }));
		const saved = restarted.put(owner, input);
		expect(restarted.put(owner, input)).toEqual({ ...saved, duplicate: true });
		expect(restarted.read(owner, saved.attachment.attachmentId).content).toEqual(input.content);
	}
});
