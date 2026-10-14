import { describe, expect, it } from "vitest";
import type { AgentHostTool, AgentToolApprovalPort, AgentToolAuditEvent } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import { BlackxAgentRuntime } from "./agentRuntime";

const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 };
const request = {
	tenantId: "tenant-publish", workspaceId: "workspace-publish", runId: "run-publish", stageId: "publish",
	actorId: "user-publish", idempotencyKey: "turn-publish", input: "Publish the approved brief", fallbackOutput: "done",
	allowedTools: ["publish_brief"],
	policy: { sandboxMode: "read-only" as const, approvalPolicy: "never" as const, timeoutMs: 5_000 },
};

function publishTool(calls: { count: number }): AgentHostTool {
	return {
		name: "publish_brief",
		description: "Publish one approved brief to an external recipient",
		inputSchema: { type: "object" },
		execution: "host",
		risk: "publish",
		idempotent: true,
		timeoutMs: 100,
		maxResultChars: 100,
		validate: () => true,
		createIdempotencyKey: (_input, turnKey) => `${turnKey}:publish`,
		execute: async () => {
			calls.count += 1;
			return "published";
		},
	};
}

function runtimeWith(tool: AgentHostTool, options: { approval?: AgentToolApprovalPort; audit?: AgentToolAuditEvent[] }) {
	let modelCalls = 0;
	return new BlackxAgentRuntime({
		skills: new SkillRegistry(),
		tools: [tool],
		approval: options.approval,
		audit: options.audit ? { append: async (event) => { options.audit!.push(event); } } : undefined,
		provider: {
			generate: async () => {
				modelCalls += 1;
				return modelCalls === 1
					? { text: "", toolCalls: [{ id: "publish-1", name: tool.name, input: {} }], usage }
					: { text: "finished", toolCalls: [], usage };
			},
		},
	});
}

describe("publish risk gate", () => {
	it("does not publish without a Host approval port", async () => {
		const calls = { count: 0 };
		const result = await runtimeWith(publishTool(calls), {}).executeTurn({ ...request });

		expect(calls.count).toBe(0);
		expect(result.events).toContainEqual(expect.objectContaining({ type: "tool.completed", status: "denied", failureCode: "tool_approval_required" }));
	});

	it("does not publish when the Host approval is rejected", async () => {
		const calls = { count: 0 };
		const result = await runtimeWith(publishTool(calls), {
			approval: { authorize: async () => ({ approved: false }) },
			audit: [],
		}).executeTurn({ ...request, policy: { ...request.policy, sandboxMode: "workspace-write", approvalPolicy: "required" } });

		expect(calls.count).toBe(0);
		expect(result.events).toContainEqual(expect.objectContaining({ type: "tool.completed", status: "denied", failureCode: "tool_approval_denied" }));
	});

	it("publishes once with a trusted approval and records the attempt", async () => {
		const calls = { count: 0 };
		const audit: AgentToolAuditEvent[] = [];
		const result = await runtimeWith(publishTool(calls), {
			approval: { authorize: async () => ({ approved: true, approvalId: "publish-approval-1" }) },
			audit,
		}).executeTurn({ ...request, policy: { ...request.policy, sandboxMode: "workspace-write", approvalPolicy: "required" } });

		expect(calls.count).toBe(1);
		expect(result.events).toContainEqual(expect.objectContaining({ type: "tool.completed", status: "succeeded", risk: "publish" }));
		expect(audit).toEqual([
			expect.objectContaining({ type: "tool.execution.started", approvalId: "publish-approval-1" }),
			expect.objectContaining({ type: "tool.execution.completed", approvalId: "publish-approval-1" }),
		]);
	});
});
