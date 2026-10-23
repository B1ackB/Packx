import { describe, expect, it } from "vitest";
import type { AgentModelProvider } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import { InMemoryAgentStateStore } from "../../src/agent/state";
import { InMemoryCronScheduleStore } from "../../src/enterprise/cronSchedule";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { BlackxAgentRuntime } from "./agentRuntime";
import { automationToolNames, createAutomationTools } from "./automationTools";

describe("Agent automation tools", () => {
	it.each(["create", "resume"])("rejects an irregular Cron schedule through the %s tool", async action => {
		const now = () => new Date("2026-10-23T10:02:00Z");
		const queue = new InMemoryStageJobQueue({ now }), schedules = new InMemoryCronScheduleStore(now);
		const scope = { tenantId: "tenant", workspaceId: "workspace", runId: "conversation", actorId: "user" };
		const input = { name: "irregular", expression: "0,1,10 * * * *", timezone: "UTC", prompt: "Review", maxRuns: 3 };
		if (action === "resume") {
			schedules.create({ ...scope, ...input, scheduleId: "legacy", nextRunAt: "2026-10-23T10:10:00Z" });
			schedules.setStatus("legacy", scope, "paused");
		}
		const tool = createAutomationTools(queue, schedules, now).find(tool => tool.name === `cron_${action}`)!;
		await expect(tool.execute(action === "create" ? input : { scheduleId: "legacy" }, {
			...scope, stageId: "conversation", executionId: "execution", toolCallId: "call", idempotencyKey: "request", approvalId: "bounded-policy", signal: new AbortController().signal,
		})).rejects.toMatchObject({ code: "cron_frequency_below_five_minutes" });
		expect(queue.list()).toHaveLength(0);
		if (action === "create") expect(schedules.list(scope)).toHaveLength(0);
		else expect(schedules.get("legacy")).toMatchObject({ status: "paused", runCount: 0 });
	});

	it("replays a completed schedule's resume receipt without changing state or bypassing its identity", async () => {
		const now = () => new Date("2026-10-23T10:02:00Z");
		const queue = new InMemoryStageJobQueue({ now }), schedules = new InMemoryCronScheduleStore(now);
		const context = { tenantId: "tenant", workspaceId: "workspace", runId: "conversation", actorId: "user", stageId: "conversation", executionId: "execution", toolCallId: "call", idempotencyKey: "resume", approvalId: "bounded-policy", signal: new AbortController().signal };
		const input = { scheduleId: "bounded" };
		schedules.create({ ...context, ...input, name: "bounded", expression: "*/5 * * * *", timezone: "UTC", prompt: "Review", maxRuns: 1, nextRunAt: "2026-10-23T10:05:00Z" });
		schedules.setStatus(input.scheduleId, context, "paused");
		const tool = createAutomationTools(queue, schedules, now).find(tool => tool.name === "cron_resume")!;
		const result = await tool.execute(input, context);
		schedules.acknowledge(input.scheduleId, schedules.get(input.scheduleId)!.nextRunAt);
		const completed = schedules.get(input.scheduleId);
		expect(completed).toMatchObject({ status: "completed", runCount: 1 });
		expect(await tool.execute(input, context)).toEqual(result);
		for (const key of ["actorId", "approvalId", "executionId"] as const) {
			await expect(tool.execute(input, { ...context, [key]: "different" })).rejects.toThrow("mutation_receipt_identity_conflict");
		}
		for (const key of ["tenantId", "workspaceId", "runId"] as const) {
			expect(await tool.execute(input, { ...context, [key]: "other" })).toEqual({ ok: false, code: "cron_schedule_not_found" });
		}
		await expect(tool.execute(input, { ...context, approvalId: undefined })).rejects.toThrow("mutation_approval_required");
		await expect(tool.execute(input, { ...context, signal: AbortSignal.abort() })).rejects.toThrow();
		expect(schedules.get(input.scheduleId)).toEqual(completed);
		expect(queue.list()).toHaveLength(0);
	});

	it("lets the model autonomously enqueue one background task through policy and audit", async () => {
		const queue = new InMemoryStageJobQueue();
		const schedules = new InMemoryCronScheduleStore();
		const state = new InMemoryAgentStateStore();
		let modelCalls = 0;
		const provider: AgentModelProvider = {
			async generate() {
				modelCalls += 1;
				return modelCalls === 1
					? {
						text: "",
						toolCalls: [{
							id: "background-call",
							name: "background_task_create",
							input: { objective: "prepare a bounded report" },
						}],
						usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
					}
					: {
						text: "后台任务已经创建",
						toolCalls: [],
						usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
					};
			},
		};
		const runtime = new BlackxAgentRuntime({
			provider,
			tools: createAutomationTools(queue, schedules),
			approval: { authorize: async () => ({ approved: true, approvalId: "policy:test" }) },
			audit: { append: async () => {} },
			executions: state,
			sessions: state,
			snapshots: state,
			skills: new SkillRegistry(),
		});

		const result = await runtime.executeTurn({
			tenantId: "tenant-tools",
			workspaceId: "workspace-tools",
			runId: "conversation-tools",
			stageId: "conversation",
			actorId: "user-tools",
			idempotencyKey: "turn-tools",
			input: "handle this asynchronously",
			fallbackOutput: "failed",
			allowedTools: [...automationToolNames],
			policy: { sandboxMode: "workspace-write", approvalPolicy: "required", timeoutMs: 1_000 },
		});

		expect(result.finalResponse).toBe("后台任务已经创建");
		expect(queue.list()).toHaveLength(1);
		expect(queue.list()[0]).toMatchObject({
			stageId: "conversation-background",
			payload: { requestedBy: "agent", actorId: "agent:user-tools" },
		});
		expect(result.events).toContainEqual(expect.objectContaining({
			type: "tool.completed",
			tool: "background_task_create",
			status: "succeeded",
		}));
	});

	it("lets the model create a bounded Cron schedule with an explicit timezone", async () => {
		const queue = new InMemoryStageJobQueue();
		const schedules = new InMemoryCronScheduleStore(() => new Date("2026-09-03T00:00:00.000Z"));
		const state = new InMemoryAgentStateStore();
		let modelCalls = 0;
		const runtime = new BlackxAgentRuntime({
			provider: {
				async generate() {
					modelCalls += 1;
					return modelCalls === 1
						? {
							text: "",
							toolCalls: [{
								id: "cron-call",
								name: "cron_create",
								input: {
									name: "daily-review",
									expression: "0 9 * * *",
									timezone: "Asia/Hong_Kong",
									prompt: "review the latest state",
									maxRuns: 3,
								},
							}],
							usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
						}
						: {
							text: "定时任务已经创建",
							toolCalls: [],
							usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
						};
				},
			},
			tools: createAutomationTools(queue, schedules, () => new Date("2026-09-03T00:00:00.000Z")),
			approval: { authorize: async () => ({ approved: true, approvalId: "policy:test" }) },
			audit: { append: async () => {} },
			executions: state,
			sessions: state,
			snapshots: state,
			skills: new SkillRegistry(),
		});

		await runtime.executeTurn({
			tenantId: "tenant-cron-tools",
			workspaceId: "workspace-cron-tools",
			runId: "conversation-cron-tools",
			stageId: "conversation",
			actorId: "user-cron-tools",
			idempotencyKey: "turn-cron-tools",
			input: "run a daily review three times",
			fallbackOutput: "failed",
			allowedTools: [...automationToolNames],
			policy: { sandboxMode: "workspace-write", approvalPolicy: "required", timeoutMs: 1_000 },
		});

		expect(schedules.list({ tenantId: "tenant-cron-tools", workspaceId: "workspace-cron-tools" }))
			.toMatchObject([{
				runId: "conversation-cron-tools",
				expression: "0 9 * * *",
				timezone: "Asia/Hong_Kong",
				maxRuns: 3,
				nextRunAt: "2026-09-03T01:00:00.000Z",
			}]);
	});
});
