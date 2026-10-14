import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillRegistry } from "../../src/agent/skills";
import type { RuntimeTurnRequest } from "../../src/runtime/contracts";
import { BlackxAgentRuntime } from "./agentRuntime";
import { ConversationApiController } from "./conversationApi";
import { FileAgentStateStore } from "./fileAgentStateStore";

const directories: string[] = [];
const context = { tenantId: "tenant-policy", workspaceId: "workspace-policy", actorId: "user-policy" };

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function harness(allowedTools: string[]) {
	const directory = mkdtempSync(join(tmpdir(), "packx-conversation-policy-"));
	directories.push(directory);
	const sessions = new FileAgentStateStore(directory);
	const runtime = new BlackxAgentRuntime({
		skills: new SkillRegistry(), sessions, snapshots: sessions, traces: sessions,
		tools: [{ name: "file_write", description: "write", inputSchema: { type: "object" }, execution: "host", risk: "write", idempotent: true, timeoutMs: 100, maxResultChars: 100, createIdempotencyKey: (_input, key) => key, validate: () => true, execute: async () => ({}) }],
		provider: { generate: async () => ({ text: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } }) },
	});
	const requests: RuntimeTurnRequest[] = [];
	const execute = runtime.executeTurn.bind(runtime);
	runtime.executeTurn = ((request: RuntimeTurnRequest, signal?: AbortSignal) => {
		requests.push(request);
		return execute(request, signal);
	}) as typeof runtime.executeTurn;
	const api = new ConversationApiController(runtime, sessions, undefined, () => "policy-conversation", allowedTools);
	return { api, requests };
}

async function sendMessage(api: ConversationApiController, extra: Record<string, unknown> = {}) {
	const created = api.create(context).body as { conversation: { conversationId: string } };
	return api.send(context, created.conversation.conversationId, { messageId: "message-1", content: "Summarize the request", ...extra });
}

describe("conversation turn policy", () => {
	it("keeps a turn without Host tools read-only and never approval-gated", async () => {
		const { api, requests } = harness([]);

		expect(await sendMessage(api)).toMatchObject({ status: 200 });
		expect(requests[0]).toMatchObject({
			allowedTools: [],
			policy: { sandboxMode: "read-only", approvalPolicy: "never" },
		});
	});

	it("allows workspace writes only with Host tools and required approval", async () => {
		const { api, requests } = harness(["file_write"]);

		expect(await sendMessage(api)).toMatchObject({ status: 200 });
		expect(requests[0]).toMatchObject({
			allowedTools: ["file_write"],
			policy: { sandboxMode: "workspace-write", approvalPolicy: "required" },
		});
	});

	it("does not let request-supplied tools or policy widen the Host policy", async () => {
		const { api, requests } = harness([]);

		expect(await sendMessage(api, {
			allowedTools: ["file_write"],
			policy: { sandboxMode: "workspace-write", approvalPolicy: "never", timeoutMs: 1 },
		})).toMatchObject({ status: 200 });
		expect(requests[0]).toMatchObject({
			allowedTools: [],
			policy: { sandboxMode: "read-only", approvalPolicy: "never" },
		});
		expect(requests[0].policy.timeoutMs).not.toBe(1);
	});
});
