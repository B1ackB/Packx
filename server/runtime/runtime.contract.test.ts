import { describe, expect, it, vi } from "vitest";
import type { AgentHostTool, AgentModelProvider, AgentTool } from "../../src/agent/contracts";
import { ContextEngine } from "../../src/agent/context";
import { AgentHooks } from "../../src/agent/hooks";
import { SkillRegistry } from "../../src/agent/skills";
import { InMemoryAgentStateStore } from "../../src/agent/state";
import { RuntimeFailure } from "../../src/runtime/contracts";
import { AnthropicMessagesClient } from "../anthropic/client";
import { BlackxAgentRuntime } from "./agentRuntime";
import { AnthropicModelProvider } from "./anthropicModelProvider";
import { FakeAgentRuntime } from "./fakeAgentRuntime";

const request = {
	tenantId: "tenant-1",
	workspaceId: "workspace-1",
	runId: "run-1",
	stageId: "proposal",
	actorId: "user-1",
	idempotencyKey: "turn-1",
	input: "Return structured output",
	fallbackOutput: JSON.stringify({ assistantMessage: "确定性回复" }),
	policy: {
		sandboxMode: "read-only" as const,
		approvalPolicy: "never" as const,
		timeoutMs: 120_000,
	},
};

const usage = {
	inputTokens: 10,
	cachedInputTokens: 0,
	outputTokens: 3,
	reasoningOutputTokens: 0,
};

describe("Packx Agent Runtime contract", () => {
	it("aborts approval waits and prevents late approval from executing a stopped turn", async () => {
		let release!: (value: { approved: boolean; approvalId: string }) => void;
		let approvalSignal: AbortSignal | undefined;
		const execute = vi.fn(async () => "must not run");
		const tool: AgentHostTool = { name: "approval-wait", description: "Wait for review", inputSchema: { type: "object" }, execution: "host", risk: "write", idempotent: true, timeoutMs: 1000, maxResultChars: 100, validate: () => true, createIdempotencyKey: () => "review-once", execute };
		const runtime = new BlackxAgentRuntime({
			provider: { generate: async () => ({ text: "", toolCalls: [{ id: "call", name: tool.name, input: {} }], usage }) },
			tools: [tool], skills: new SkillRegistry(), audit: { append: async () => {} },
			approval: { authorize: async (_request, signal) => { approvalSignal = signal; return new Promise((resolve) => { release = resolve; }); } },
		});
		const abort = new AbortController();
		const pending = runtime.executeTurn({ ...request, allowedTools: [tool.name], policy: { ...request.policy, sandboxMode: "workspace-write", approvalPolicy: "required" } }, abort.signal);
		const failed = expect(pending).rejects.toMatchObject({ code: "cancelled" });
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		abort.abort(); await failed;
		expect(approvalSignal?.aborted).toBe(true);
		release({ approved: true, approvalId: "too-late" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(execute).not.toHaveBeenCalled();
	});

	it("provides a deterministic Fake with resumable session identity", async () => {
		const runtime = new FakeAgentRuntime();
		const first = await runtime.executeTurn(request);
		const resumed = await runtime.executeTurn({ ...request, sessionId: first.sessionId });

		expect((await runtime.health()).adapter).toBe("fake");
		expect(JSON.parse(first.finalResponse)).toEqual({ assistantMessage: "确定性回复" });
		expect(resumed.sessionId).toBe(first.sessionId);
		expect(first.events.map((event) => event.type)).toEqual([
			"session.started",
			"turn.started",
			"context.snapshot.saved",
			"model.started",
			"model.completed",
			"message.completed",
			"turn.completed",
		]);
	});

	it("runs model, tool, and model again through the self-owned loop and hooks", async () => {
		let calls = 0;
		const providerState = { type: "test.provider-state", signed: "opaque-1" };
		const provider: AgentModelProvider = {
			async generate(modelRequest) {
				calls += 1;
				if (calls === 1) {
					return {
						text: "",
						toolCalls: [{ id: "call-1", name: "lookup", input: { id: 1 } }],
						providerState,
						usage,
					};
				}
				expect(modelRequest.messages).toContainEqual(expect.objectContaining({
					role: "assistant",
					providerState,
				}));
				return { text: "done", toolCalls: [], usage };
			},
		};
		const tool: AgentHostTool = {
			name: "lookup",
			description: "Read a test value",
			inputSchema: { type: "object" },
			execution: "host",
			risk: "read",
			idempotent: true,
			timeoutMs: 1_000,
			maxResultChars: 1_000,
			validate: (input) => Boolean(input) && typeof input === "object",
			execute: async () => ({ value: 42 }),
		};
		const hooks = new AgentHooks();
		const reached: string[] = [];
		for (const name of ["loop.started", "model.before", "model.after", "tool.before", "tool.after", "loop.completed"] as const) {
			hooks.on(name, () => {
				reached.push(name);
			});
		}
		const state = new InMemoryAgentStateStore();
		const runtime = new BlackxAgentRuntime({
			provider,
			tools: [tool],
			hooks,
			skills: new SkillRegistry(),
			sessions: state,
			snapshots: state,
		});

		const result = await runtime.executeTurn({
			...request,
			sessionId: "session-loop",
			contextSnapshotId: "snapshot-loop",
			allowedTools: ["lookup"],
		});

		expect(result.finalResponse).toBe("done");
		expect(result.usage?.inputTokens).toBe(20);
		expect(result.events.map((event) => event.type)).toContain("tool.completed");
		expect(result.contextSnapshotId).toBe("snapshot-loop-i2");
		expect(state.read({
			tenantId: request.tenantId,
			workspaceId: request.workspaceId,
			runId: request.runId,
			sessionId: "session-loop",
		}, "snapshot-loop-i2").messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-1" });
		expect(state.load({
			tenantId: request.tenantId,
			workspaceId: request.workspaceId,
			runId: request.runId,
			sessionId: "session-loop",
		}).messages).toContainEqual(expect.objectContaining({ role: "assistant", providerState }));
		expect(reached).toEqual([
			"loop.started",
			"model.before",
			"model.after",
			"tool.before",
			"tool.after",
			"model.before",
			"model.after",
			"loop.completed",
		]);
	});

	it("persists Context Snapshot before a failed Model call", async () => {
		const state = new InMemoryAgentStateStore();
		const runtime = new BlackxAgentRuntime({
			provider: { generate: async () => { throw new Error("provider_down"); } },
			skills: new SkillRegistry(),
			sessions: state,
			snapshots: state,
			traces: state,
			now: () => "2026-09-02T00:00:00.000Z",
		});
		await expect(runtime.executeTurn({
			...request,
			sessionId: "session-failed",
			contextSnapshotId: "snapshot-failed",
		})).rejects.toMatchObject({ code: "model_failure" });

		expect(state.read({
			tenantId: request.tenantId,
			workspaceId: request.workspaceId,
			runId: request.runId,
			sessionId: "session-failed",
		}, "snapshot-failed-i1")).toMatchObject({
			iteration: 1,
			createdAt: "2026-09-02T00:00:00.000Z",
		});
		expect(state.listTraces(request)).toMatchObject([{
			status: "failed",
			failure: { code: "model_failure", retryable: true },
			events: [
				{ type: "session.started" },
				{ type: "turn.started" },
				{ type: "context.snapshot.saved", snapshotId: "snapshot-failed-i1" },
				{ type: "model.started", iteration: 1 },
				{ type: "turn.failed" },
			],
		}]);
	});

	it("preserves provider authentication classification through token counting", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
			error: { type: "authentication_error", message: "invalid key" },
		}), { status: 401, headers: { "content-type": "application/json" } }));
		const runtime = new BlackxAgentRuntime({
			provider: new AnthropicModelProvider(new AnthropicMessagesClient({
				baseUrl: "https://example.invalid",
				apiKey: "test-key",
				fetch: fetchMock,
			}), "model-a"),
			skills: new SkillRegistry(),
		});

		await expect(runtime.executeTurn(request)).rejects.toMatchObject({
			code: "authentication",
			retryable: false,
		});
	});

	it("keeps tool calls paired with their results during deterministic compaction", () => {
		const context = new ContextEngine(180);
		const messages = context.compile({
			instructions: ["stable policy"],
			skills: [],
			history: [
				{ role: "user", content: "x".repeat(160) },
				{ role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "lookup", input: {} }] },
				{ role: "tool", content: "42", toolCallId: "call-1" },
			],
			input: "current",
		});
		const compacted = context.compact(messages);
		const toolCall = compacted.messages.find((message) => message.toolCalls?.[0]?.id === "call-1");
		const toolResult = compacted.messages.find((message) => message.toolCallId === "call-1");

		expect(Boolean(toolCall)).toBe(Boolean(toolResult));
		expect(compacted.removedMessages).toBeGreaterThan(0);
	});

	it("never compacts an open Tool batch", () => {
		const context = new ContextEngine(80);
		const messages = context.compile({
			instructions: [],
			skills: [],
			history: [
				{ role: "user", content: "old".repeat(100) },
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{ id: "call-1", name: "lookup", input: {} },
						{ id: "call-2", name: "lookup", input: {} },
					],
				},
				{ role: "tool", content: "first", toolCallId: "call-1" },
			],
			input: "current",
		});
		const compacted = context.compact(messages);

		expect(compacted.messages).toContainEqual(expect.objectContaining({
			role: "assistant",
			toolCalls: expect.arrayContaining([expect.objectContaining({ id: "call-2" })]),
		}));
		expect(compacted.messages).toContainEqual(expect.objectContaining({ role: "tool", toolCallId: "call-1" }));
	});

	it("enforces timeout and cancellation at the self-owned runtime boundary", async () => {
		const provider: AgentModelProvider = {
			async generate() {
				await new Promise<void>(() => {});
				return { text: "never", toolCalls: [], usage };
			},
		};
		const runtime = new BlackxAgentRuntime({ provider, skills: new SkillRegistry() });
		await expect(runtime.executeTurn({
			...request,
			policy: { ...request.policy, timeoutMs: 5 },
		})).rejects.toMatchObject({ code: "timeout", retryable: true } satisfies Partial<RuntimeFailure>);

		const controller = new AbortController();
		const running = runtime.executeTurn(request, controller.signal);
		controller.abort(new Error("manual_abort"));
		await expect(running).rejects.toMatchObject({ code: "cancelled", retryable: false } satisfies Partial<RuntimeFailure>);
	});

	it("rejects unknown skills before calling the provider", async () => {
		const provider: AgentModelProvider = {
			generate: async () => ({ text: "unused", toolCalls: [], usage }),
		};
		const runtime = new BlackxAgentRuntime({ provider, skills: new SkillRegistry() });
		await expect(runtime.executeTurn({ ...request, skills: ["missing"] })).rejects.toMatchObject({
			code: "context_failure",
		});
	});

	it("summarizes removed transient context before the next Model call", async () => {
		let summarizedMessages = 0;
		const state = new InMemoryAgentStateStore();
		state.save({
			tenantId: request.tenantId,
			workspaceId: request.workspaceId,
			runId: request.runId,
			sessionId: "summary-session",
		}, 0, [{ role: "user", content: "old context ".repeat(40) }], "2026-09-02T00:00:00.000Z");
		const runtime = new BlackxAgentRuntime({
			provider: {
				generate: async (modelRequest) => {
					expect(modelRequest.messages.some((message) => (
						message.content.includes("Unverified compact summary") && message.content.includes("earlier decision retained")
					))).toBe(true);
					return { text: "done", toolCalls: [], usage };
				},
			},
			summarizer: {
				summarize: async (messages) => {
					summarizedMessages = messages.length;
					return { text: "earlier decision retained", usage };
				},
			},
			context: new ContextEngine(180),
			skills: new SkillRegistry(),
			sessions: state,
			snapshots: state,
		});

		const result = await runtime.executeTurn({
			...request,
			sessionId: "summary-session",
			input: "current input",
			instructions: ["stable policy"],
		});

		expect(summarizedMessages).toBeGreaterThan(0);
		expect(result.usage?.inputTokens).toBe(20);
		expect(result.events).toContainEqual(expect.objectContaining({
			type: "context.compacted",
			summaries: 1,
		}));
		const snapshot = state.read({
			tenantId: request.tenantId,
			workspaceId: request.workspaceId,
			runId: request.runId,
			sessionId: "summary-session",
		}, result.contextSnapshotId ?? "missing");
		expect(snapshot.messages).toContainEqual(expect.objectContaining({
			role: "user",
			content: expect.stringContaining("Unverified compact summary"),
		}));
		expect(snapshot.messages).not.toContainEqual(expect.objectContaining({
			role: "system",
			content: expect.stringContaining("earlier decision retained"),
		}));
	});

	it("returns timed-out tool failure to the model and continues", async () => {
		let calls = 0;
		const provider: AgentModelProvider = {
			async generate(modelRequest) {
				calls += 1;
				if (calls === 1) {
					return { text: "", toolCalls: [{ id: "slow-1", name: "slow", input: {} }], usage };
				}
				expect(JSON.parse(modelRequest.messages.at(-1)?.content ?? "{}")).toMatchObject({
					error: { code: "tool_timeout" },
				});
				return { text: "recovered", toolCalls: [], usage };
			},
		};
		const slow: AgentHostTool = {
			name: "slow",
			description: "Never returns",
			inputSchema: { type: "object" },
			execution: "host",
			risk: "read",
			idempotent: true,
			timeoutMs: 5,
			maxResultChars: 100,
			validate: () => true,
			execute: async () => new Promise<never>(() => {}),
		};
		const runtime = new BlackxAgentRuntime({
			provider,
			tools: [slow],
			skills: new SkillRegistry(),
		});

		const result = await runtime.executeTurn({ ...request, allowedTools: ["slow"] });
		expect(result.finalResponse).toBe("recovered");
		expect(result.events).toContainEqual(expect.objectContaining({
			type: "tool.completed",
			tool: "slow",
			status: "failed",
			failureCode: "tool_timeout",
		}));
	});

	it("checkpoints at the iteration slice limit and resumes without duplicating user input", async () => {
		let calls = 0;
		let resumedUserInputs = 0;
		let resumedInputPinned = false;
		const provider: AgentModelProvider = {
			async generate(modelRequest) {
				calls += 1;
				if (calls === 3) {
					resumedUserInputs = modelRequest.messages.filter((message) => message.content === request.input).length;
					resumedInputPinned = modelRequest.messages.some((message) => message.content === request.input && message.pinned === true);
					return { text: "done after resume", toolCalls: [], usage };
				}
				return { text: "", toolCalls: [{ id: `call-${calls}`, name: "read", input: {} }], usage };
			},
		};
		const read: AgentHostTool = {
			name: "read",
			description: "Read",
			inputSchema: { type: "object" },
			execution: "host",
			risk: "read",
			idempotent: true,
			timeoutMs: 100,
			maxResultChars: 100,
			validate: () => true,
			execute: async () => "ok",
		};
		const runtime = new BlackxAgentRuntime({
			provider,
			tools: [read],
			skills: new SkillRegistry(),
			maxIterations: 2,
		});
		const first = await runtime.executeTurn({
			...request,
			allowedTools: ["read"],
			sessionId: "scheduled-session",
			resume: "if-present",
		});
		expect(first).toMatchObject({
			status: "paused",
			finalResponse: "",
		});
		expect(first.events).toContainEqual({ type: "turn.checkpointed", reason: "iteration_slice_limit", iterations: 2 });
		const resumed = await runtime.executeTurn({
			...request,
			allowedTools: ["read"],
			sessionId: first.sessionId,
			resume: "if-present",
		});
		expect(resumed).toMatchObject({ status: "completed", finalResponse: "done after resume" });
		expect(calls).toBe(3);
		expect(resumedUserInputs).toBe(1);
		expect(resumedInputPinned).toBe(true);
	});

	it("uses 32 model iterations as the default execution-slice fuse", async () => {
		let calls = 0;
		const read: AgentHostTool = {
			name: "read-loop",
			description: "Read",
			inputSchema: { type: "object" },
			execution: "host",
			risk: "read",
			idempotent: true,
			timeoutMs: 100,
			maxResultChars: 100,
			validate: () => true,
			execute: async () => "ok",
		};
		const runtime = new BlackxAgentRuntime({
			provider: {
				generate: async () => ({
					text: "",
					toolCalls: [{ id: `call-${++calls}`, name: read.name, input: { page: calls } }],
					usage,
				}),
			},
			tools: [read],
			skills: new SkillRegistry(),
		});

		const result = await runtime.executeTurn({ ...request, allowedTools: [read.name] });
		expect(result.status).toBe("paused");
		expect(result.events).toContainEqual({ type: "turn.checkpointed", reason: "iteration_slice_limit", iterations: 32 });
		expect(calls).toBe(32);
	});

	it("uses exact token counts before the character fallback", async () => {
		const result = await new BlackxAgentRuntime({
			provider: {
				countTokens: async () => 10,
				generate: async () => ({ text: "done", toolCalls: [], usage }),
			},
			context: new ContextEngine(1),
			skills: new SkillRegistry(),
			maxInputTokens: 1_000,
		}).executeTurn(request);

		expect(result.events.some((event) => event.type === "context.compacted")).toBe(false);
	});

	it("compacts once and retries a provider context-window failure", async () => {
		const state = new InMemoryAgentStateStore();
		const scope = {
			tenantId: request.tenantId,
			workspaceId: request.workspaceId,
			runId: request.runId,
			sessionId: "session-reactive-compact",
		};
		state.save(scope, 0, [{ role: "user", content: "old transient context ".repeat(200) }], "2026-09-02T00:00:00.000Z");
		let calls = 0;
		const runtime = new BlackxAgentRuntime({
			provider: {
				countTokens: async (modelRequest) => Math.ceil(modelRequest.messages.reduce((total, message) => total + message.content.length, 0) / 4),
				generate: async () => {
					calls += 1;
					if (calls === 1) throw Object.assign(new Error("too long"), { code: "context_window_exceeded" });
					return { text: "recovered", toolCalls: [], usage };
				},
			},
			summarizer: { summarize: async () => ({ text: "old context summary", usage }) },
			skills: new SkillRegistry(),
			sessions: state,
			snapshots: state,
			compactTriggerTokens: 900_000,
			maxInputTokens: 1_000_000,
		});
		const result = await runtime.executeTurn({
			...request,
			sessionId: scope.sessionId,
			contextSnapshotId: "snapshot-reactive",
		});

		expect(calls).toBe(2);
		expect(result.events).toContainEqual(expect.objectContaining({ type: "context.compacted", summaries: 1 }));
		expect(state.read(scope, "snapshot-reactive-i1-retry2").iteration).toBe(1);
	});

	it("deduplicates write side effects and preserves deterministic receipts through compaction", async () => {
		const state = new InMemoryAgentStateStore();
		let modelCalls = 0;
		let writes = 0;
		const write: AgentHostTool = {
			name: "durable-write",
			description: "Write once",
			inputSchema: { type: "object" },
			execution: "host",
			risk: "write",
			idempotent: true,
			timeoutMs: 100,
			maxResultChars: 100,
			validate: () => true,
			createIdempotencyKey: () => "record:stable-operation",
			execute: async () => {
				writes += 1;
				return "persisted-result";
			},
		};
		const runtime = new BlackxAgentRuntime({
			provider: {
				generate: async () => {
					modelCalls += 1;
					return modelCalls % 2 === 1
						? { text: "", toolCalls: [{ id: `write-${modelCalls}`, name: write.name, input: { value: modelCalls >= 5 ? 2 : 1 } }], usage }
						: { text: "done", toolCalls: [], usage };
				},
			},
			tools: [write],
			approval: { authorize: async () => ({ approved: true, approvalId: "approval-1" }) },
			audit: { append: async () => {} },
			executions: state,
			sessions: state,
			snapshots: state,
			skills: new SkillRegistry(),
		});
		const writeRequest = {
			...request,
			allowedTools: [write.name],
			policy: { ...request.policy, sandboxMode: "workspace-write" as const, approvalPolicy: "required" as const },
		};
		const first = await runtime.executeTurn({ ...writeRequest, sessionId: "write-session-1" });
		const second = await runtime.executeTurn({ ...writeRequest, sessionId: "write-session-2" });
		const conflicting = await runtime.executeTurn({ ...writeRequest, sessionId: "write-session-3" });

		expect(writes).toBe(1);
		expect(first.events).toContainEqual(expect.objectContaining({ type: "tool.completed", replayed: false }));
		expect(second.events).toContainEqual(expect.objectContaining({ type: "tool.completed", replayed: true, status: "succeeded" }));
		expect(conflicting.events).toContainEqual(expect.objectContaining({
			type: "tool.completed",
			replayed: true,
			status: "denied",
			failureCode: "tool_idempotency_conflict",
		}));
		const history = state.load({
			tenantId: request.tenantId,
			workspaceId: request.workspaceId,
			runId: request.runId,
			sessionId: "write-session-1",
		}).messages;
		const context = new ContextEngine(300);
		const compacted = context.compact(context.compile({
			instructions: [],
			skills: [],
			history: [{ role: "user", content: "discard me ".repeat(100) }, ...history],
			input: "continue",
		}));
		expect(compacted.messages).toContainEqual(expect.objectContaining({
			durable: true,
			content: expect.stringContaining("record:stable-operation"),
		}));
	});

	it("fails closed instead of replaying an unresolved write reservation", async () => {
		const state = new InMemoryAgentStateStore();
		await state.claim({
			schemaVersion: "tool-execution.v1",
			tenantId: request.tenantId,
			workspaceId: request.workspaceId,
			runId: request.runId,
			stageId: request.stageId,
			actorId: request.actorId,
			executionId: "crashed-execution",
			tool: "uncertain-write",
			toolCallId: "crashed-call",
			risk: "write",
			idempotencyKey: "uncertain-operation",
			approvalId: "approval-1",
			inputDigest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
			status: "started",
			startedAt: "2026-09-02T00:00:00.000Z",
		});
		let calls = 0;
		let writes = 0;
		const tool: AgentHostTool = {
			name: "uncertain-write",
			description: "Write",
			inputSchema: { type: "object" },
			execution: "host",
			risk: "write",
			idempotent: true,
			timeoutMs: 100,
			maxResultChars: 100,
			validate: () => true,
			createIdempotencyKey: () => "uncertain-operation",
			execute: async () => {
				writes += 1;
				return "must-not-run";
			},
		};
		const result = await new BlackxAgentRuntime({
			provider: {
				generate: async (modelRequest) => {
					calls += 1;
					if (calls === 1) return { text: "", toolCalls: [{ id: "retry-call", name: tool.name, input: {} }], usage };
					expect(JSON.parse(modelRequest.messages.find((message) => message.toolCallId === "retry-call")?.content ?? "{}")).toMatchObject({
						error: { code: "tool_execution_unknown" },
					});
					return { text: "needs reconciliation", toolCalls: [], usage };
				},
			},
			tools: [tool],
			approval: { authorize: async () => ({ approved: true, approvalId: "approval-1" }) },
			audit: { append: async () => {} },
			executions: state,
			skills: new SkillRegistry(),
		}).executeTurn({
			...request,
			allowedTools: [tool.name],
			policy: { ...request.policy, sandboxMode: "workspace-write", approvalPolicy: "required" },
		});

		expect(writes).toBe(0);
		expect(result.events).toContainEqual(expect.objectContaining({
			type: "tool.completed",
			status: "unknown",
			failureCode: "tool_execution_unknown",
			replayed: true,
		}));
	});

	it("classifies permission, token budget, and audit infrastructure failures", async () => {
		const provider: AgentModelProvider = {
			countTokens: async () => 101,
			generate: async () => ({ text: "unused", toolCalls: [], usage }),
		};
		await expect(new BlackxAgentRuntime({
			provider,
			skills: new SkillRegistry(),
		}).executeTurn({ ...request, allowedTools: ["missing"] })).rejects.toMatchObject({
			code: "permission_denied",
			retryable: false,
		});
		await expect(new BlackxAgentRuntime({
			provider,
			skills: new SkillRegistry(),
			maxInputTokens: 100,
		}).executeTurn(request)).rejects.toMatchObject({
			code: "budget_exceeded",
			retryable: false,
		});

		let calls = 0;
		let writes = 0;
		const write: AgentHostTool = {
			name: "audited-write",
			description: "Write",
			inputSchema: { type: "object" },
			execution: "host",
			risk: "write",
			idempotent: true,
			timeoutMs: 100,
			maxResultChars: 100,
			validate: () => true,
			createIdempotencyKey: (_input, turnKey) => `${turnKey}:audited-write`,
			execute: async () => { writes += 1; return "written"; },
		};
		await expect(new BlackxAgentRuntime({
			provider: {
				generate: async () => {
					calls += 1;
					return { text: "", toolCalls: [{ id: "audit-1", name: write.name, input: {} }], usage };
				},
			},
			tools: [write],
			approval: { authorize: async () => ({ approved: true, approvalId: "approval-audit" }) },
			audit: { append: async () => { throw new Error("audit_down"); } },
			skills: new SkillRegistry(),
		}).executeTurn({
			...request,
			allowedTools: [write.name],
			policy: { ...request.policy, sandboxMode: "workspace-write", approvalPolicy: "required" },
		})).rejects.toMatchObject({ code: "infrastructure_failure", retryable: true });
		expect(calls).toBe(1);
		expect(writes).toBe(0);
	});

	it("denies write tools by default and executes them only with trusted approval and audit", async () => {
		let deniedCalls = 0;
		const write: AgentHostTool = {
			name: "write-record",
			description: "Write one record",
			inputSchema: { type: "object" },
			execution: "host",
			risk: "write",
			idempotent: true,
			timeoutMs: 100,
			maxResultChars: 100,
			validate: () => true,
			createIdempotencyKey: (input, turnKey) => `${turnKey}:record:${String((input as { value?: unknown }).value)}`,
			execute: async () => {
				deniedCalls += 1;
				return "written";
			},
		};
		let modelCalls = 0;
		const denied = await new BlackxAgentRuntime({
			provider: {
				generate: async (modelRequest) => {
					modelCalls += 1;
					if (modelCalls === 1) return {
						text: "",
						toolCalls: [{ id: "write-1", name: write.name, input: { value: 1 } }],
						usage,
					};
					expect(JSON.parse(modelRequest.messages.at(-1)?.content ?? "{}")).toMatchObject({
						error: { code: "tool_approval_required" },
					});
					return { text: "denied safely", toolCalls: [], usage };
				},
			},
			tools: [write],
			skills: new SkillRegistry(),
		}).executeTurn({ ...request, allowedTools: [write.name] });
		expect(deniedCalls).toBe(0);
		expect(denied.events).toContainEqual(expect.objectContaining({
			type: "tool.completed",
			status: "denied",
			failureCode: "tool_approval_required",
		}));

		const audit: Array<{ type: string; approvalId?: string }> = [];
		let executionContext: { actorId: string; executionId: string; idempotencyKey: string; approvalId?: string } | undefined;
		modelCalls = 0;
		const approved = await new BlackxAgentRuntime({
			provider: {
				generate: async () => {
					modelCalls += 1;
					return modelCalls === 1
						? { text: "", toolCalls: [{ id: "write-2", name: write.name, input: { value: 2 } }], usage }
						: { text: "written safely", toolCalls: [], usage };
				},
			},
			tools: [{
				...write,
				execute: async (_input, context) => {
					executionContext = context;
					return "written";
				},
			}],
			approval: {
				authorize: async (approvalRequest) => {
					expect(approvalRequest).toMatchObject({
						actorId: "user-1",
						toolCallId: "write-2",
						risk: "write",
						idempotencyKey: "turn-1:record:2",
					});
					return { approved: true, approvalId: "approval-1" };
				},
			},
			audit: { append: async (event) => { audit.push(event); } },
			skills: new SkillRegistry(),
		}).executeTurn({
			...request,
			allowedTools: [write.name],
			policy: { ...request.policy, sandboxMode: "workspace-write", approvalPolicy: "required" },
		});

		expect(approved.finalResponse).toBe("written safely");
		expect(executionContext).toMatchObject({ actorId: "user-1", idempotencyKey: "turn-1:record:2", approvalId: "approval-1" });
		expect(executionContext?.executionId).toEqual(expect.any(String));
		expect(audit).toEqual([
			expect.objectContaining({ type: "tool.execution.started", approvalId: "approval-1" }),
			expect.objectContaining({ type: "tool.execution.completed", approvalId: "approval-1" }),
		]);
		expect(approved.events).toContainEqual(expect.objectContaining({
			type: "tool.completed",
			status: "succeeded",
			risk: "write",
		}));
	});

	it("classifies model-visible Tool validation, execution, idempotency, and approval failures", async () => {
		let calls = 0;
		const base: AgentHostTool = {
			name: "base",
			description: "Test tool",
			inputSchema: { type: "object" },
			execution: "host",
			risk: "read",
			idempotent: true,
			timeoutMs: 100,
			maxResultChars: 100,
			validate: () => true,
			execute: async () => "ok",
		};
		const tools: AgentTool[] = [
			base,
			{ ...base, name: "invalid", validate: () => false },
			{ ...base, name: "explode", execute: async () => { throw new Error("secret-provider-detail"); } },
			{ ...base, name: "unsafe-write", risk: "write", idempotent: false },
			{
				...base,
				name: "denied-write",
				risk: "write",
				createIdempotencyKey: (_input, turnKey) => `${turnKey}:denied-write`,
			},
		];
		const runtime = new BlackxAgentRuntime({
			provider: {
				generate: async (modelRequest) => {
					calls += 1;
					if (calls === 1) return {
						text: "",
						toolCalls: [
							{ id: "unknown-1", name: "unknown", input: {} },
							{ id: "invalid-1", name: "invalid", input: {} },
							{ id: "progress-1", name: "base", input: { step: 1 } },
							{ id: "explode-1", name: "explode", input: {} },
							{ id: "unsafe-1", name: "unsafe-write", input: {} },
							{ id: "progress-2", name: "base", input: { step: 2 } },
							{ id: "denied-1", name: "denied-write", input: {} },
						],
						usage,
					};
					const failures = modelRequest.messages
						.filter((message) => message.role === "tool" && message.content !== "ok")
						.map((message) => JSON.parse(message.content).error.code);
					expect(modelRequest.messages.some((message) => message.content.includes("secret-provider-detail"))).toBe(false);
					expect(failures).toEqual([
						"tool_not_allowed",
						"tool_input_invalid",
						"tool_execution_failed",
						"tool_not_idempotent",
						"tool_approval_denied",
					]);
					return { text: "recovered", toolCalls: [], usage };
				},
			},
			tools,
			approval: { authorize: async () => ({ approved: false }) },
			audit: { append: async () => {} },
			skills: new SkillRegistry(),
		});
		const result = await runtime.executeTurn({
			...request,
			allowedTools: tools.map((tool) => tool.name),
			policy: { ...request.policy, sandboxMode: "workspace-write", approvalPolicy: "required" },
		});

		expect(result.events.filter((event) => event.type === "tool.completed").filter((event) => event.status !== "succeeded").map((event) => event.failureCode)).toEqual([
			"tool_not_allowed",
			"tool_input_invalid",
			"tool_execution_failed",
			"tool_not_idempotent",
			"tool_approval_denied",
		]);
	});

	it("scopes session history by tenant, workspace, and run", async () => {
		const seen: string[][] = [];
		const provider: AgentModelProvider = {
			async generate(modelRequest) {
				seen.push(modelRequest.messages.map((message) => message.content));
				return { text: "ok", toolCalls: [], usage };
			},
		};
		const runtime = new BlackxAgentRuntime({ provider, skills: new SkillRegistry() });
		await runtime.executeTurn({ ...request, input: "tenant-a-secret", sessionId: "shared" });
		await runtime.executeTurn({
			...request,
			tenantId: "tenant-2",
			input: "tenant-b-input",
			sessionId: "shared",
		});

		expect(seen[1]).not.toContain("tenant-a-secret");
		expect(seen[1]).toContain("tenant-b-input");
	});
});
