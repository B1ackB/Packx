import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentModelProvider, AgentToolAuditEvent, AgentToolExecutionRecord } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import { AgentStateStoreError, type ContextSnapshotRecord } from "../../src/agent/state";
import { FileAgentStateStore } from "./fileAgentStateStore";
import { BlackxAgentRuntime } from "./agentRuntime";
import type { RuntimeTraceRecord } from "../../src/runtime/contracts";

const directories: string[] = [];
const scope = {
	tenantId: "tenant-a",
	workspaceId: "workspace-a",
	runId: "run-a",
	sessionId: "session-a",
};

function store(): { root: string; state: FileAgentStateStore } {
	const root = mkdtempSync(join(tmpdir(), "blackx-agent-state-"));
	directories.push(root);
	return { root, state: new FileAgentStateStore(root) };
}

function snapshot(createdAt = "2026-09-02T00:00:00.000Z"): ContextSnapshotRecord {
	return {
		schemaVersion: "context-snapshot.v2",
		...scope,
		snapshotId: "snapshot-a-i1",
		iteration: 1,
		skills: [{ name: "skill-a", version: "1.0.0" }],
		messages: [{ role: "user", content: "hello", pinned: true }],
		estimatedChars: 5,
		estimatedTokens: 2,
		removedMessages: 0,
		createdAt,
	};
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("FileAgentStateStore", () => {
	it("persists an idempotent deletion tombstone and rejects late saves or recreation after restart", () => {
		const { root, state } = store();
		const now = "2026-09-05T00:00:00.000Z";
		state.save(scope, 0, [{ role: "user", content: "artifact source" }], now);
		expect(state.deleteSession({ ...scope, tenantId: "other" }, "user", now)).toBeUndefined();
		const deleted = state.deleteSession(scope, "user", now)!;
		const restarted = new FileAgentStateStore(root);
		expect(restarted.getSession(scope)).toBeUndefined();
		expect(restarted.listSessions(scope)).toEqual([]);
		expect(restarted.listSessions(scope, true)).toEqual([deleted]);
		expect(deleted.messages[0].content).toBe("artifact source");
		expect(deleted.deletion).toEqual({ actorId: "user", deletedAt: now });
		expect(restarted.deleteSession(scope, "another-user", "2026-09-06T00:00:00.000Z")).toEqual(deleted);
		for (const revision of [0, 1, deleted.revision]) expect(() => restarted.save(scope, revision, [], now)).toThrow("deleted");
		expect(() => restarted.createSession(scope, now)).toThrow("deleted");
		expect(() => restarted.load(scope)).toThrow("deleted");
	});

	it("persists a tenant-scoped Session with optimistic concurrency", () => {
		const { root, state } = store();
		const saved = state.save(scope, 0, [{ role: "user", content: "secret" }], "2026-09-02T00:00:00.000Z");
		const restarted = new FileAgentStateStore(root);

		expect(saved.revision).toBe(1);
		expect(restarted.load(scope)).toMatchObject({
			revision: 1,
			historyStatus: "complete",
			transcript: [{ role: "user", content: "secret", messageId: "legacy-0-0" }],
			messages: [{ role: "user", content: "secret", messageId: "legacy-0-0" }],
		});
		expect(restarted.load({ ...scope, tenantId: "tenant-b" })).toEqual({ revision: 0, messages: [] });
		expect(() => restarted.save(scope, 0, [], "2026-09-02T00:00:01.000Z")).toThrowError(
			expect.objectContaining({ code: "conflict" }) as AgentStateStoreError,
		);
		const path = join(root, "tenant-a", "workspace-a", "run-a", "sessions", "session-a.json");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("lists server Sessions by tenant and most recent update", () => {
		const { state } = store();
		state.createSession(scope, "2026-09-02T00:00:00.000Z");
		state.createSession(
			{ ...scope, runId: "run-b", sessionId: "session-b" },
			"2026-09-02T00:01:00.000Z",
		);
		state.createSession(
			{ ...scope, tenantId: "tenant-b", runId: "run-c", sessionId: "session-c" },
			"2026-09-02T00:02:00.000Z",
		);

		expect(state.listSessions({ tenantId: "tenant-a", workspaceId: "workspace-a" })
			.map((session) => session.sessionId)).toEqual(["session-b", "session-a"]);
	});

	it("resumes Session history after Runtime reconstruction", async () => {
		const { root, state } = store();
		const providerState = {
			type: "anthropic.assistant-content.v1",
			model: "model-a",
			content: [{ type: "thinking", thinking: "private", signature: "signed-1" }],
		};
		const firstProvider: AgentModelProvider = {
			generate: async () => ({
				text: "first-response",
				toolCalls: [],
				providerState,
				usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
			}),
		};
		const request = {
			tenantId: scope.tenantId,
			workspaceId: scope.workspaceId,
			runId: scope.runId,
			stageId: "proposal",
			actorId: "user-1",
			idempotencyKey: "turn-1",
			sessionId: scope.sessionId,
			input: "first-input",
			fallbackOutput: "unused",
			policy: { sandboxMode: "read-only" as const, approvalPolicy: "never" as const, timeoutMs: 1_000 },
		};
		await new BlackxAgentRuntime({
			provider: firstProvider,
			skills: new SkillRegistry(),
			sessions: state,
			snapshots: state,
		}).executeTurn(request);

		let resumedMessages: string[] = [];
		let resumedProviderState: unknown;
		const restartedState = new FileAgentStateStore(root);
		await new BlackxAgentRuntime({
			provider: {
				generate: async (modelRequest) => {
					resumedMessages = modelRequest.messages.map((message) => message.content);
					resumedProviderState = modelRequest.messages.find(
						(message) => message.content === "first-response",
					)?.providerState;
					return {
						text: "second-response",
						toolCalls: [],
						usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
					};
				},
			},
			skills: new SkillRegistry(),
			sessions: restartedState,
			snapshots: restartedState,
		}).executeTurn({ ...request, idempotencyKey: "turn-2", input: "second-input" });

		expect(resumedMessages).toContain("first-input");
		expect(resumedMessages).toContain("first-response");
		expect(resumedMessages).toContain("second-input");
		expect(resumedProviderState).toEqual(providerState);
	});

	it("stores immutable Context Snapshots idempotently across restarts", () => {
		const { root, state } = store();
		state.put(snapshot());
		const restarted = new FileAgentStateStore(root);

		expect(restarted.read(scope, "snapshot-a-i1")).toEqual(snapshot());
		expect(restarted.put(snapshot("2026-09-02T00:01:00.000Z")).createdAt).toBe(
			"2026-09-02T00:00:00.000Z",
		);
		expect(() => restarted.put({ ...snapshot(), estimatedChars: 6 })).toThrowError(
			expect.objectContaining({ code: "conflict" }) as AgentStateStoreError,
		);
	});

	it("persists one Tool execution per tenant, workspace, Tool, and idempotency key", async () => {
		const { root, state } = store();
		const record: AgentToolExecutionRecord = {
			schemaVersion: "tool-execution.v1",
			tenantId: scope.tenantId,
			workspaceId: scope.workspaceId,
			runId: scope.runId,
			stageId: "proposal",
			actorId: "user-1",
			executionId: "execution-1",
			tool: "write-record",
			toolCallId: "call-1",
			risk: "write",
			idempotencyKey: "stable-operation",
			approvalId: "approval-1",
			inputDigest: "sha256:input",
			status: "started",
			startedAt: "2026-09-02T00:00:00.000Z",
		};
		expect((await state.claim(record)).duplicate).toBe(false);
		await state.complete(record, {
			status: "succeeded",
			result: "done",
			resultDigest: "sha256:result",
			completedAt: "2026-09-02T00:00:01.000Z",
		});

		const restarted = new FileAgentStateStore(root);
		const duplicate = await restarted.claim({ ...record, toolCallId: "call-2", executionId: "execution-2" });
		expect(duplicate).toMatchObject({ duplicate: true, record: { toolCallId: "call-1", status: "succeeded", result: "done" } });
		expect(await restarted.find(record)).toMatchObject({ status: "succeeded", resultDigest: "sha256:result" });
	});

	it("persists audit events after removing undefined optional fields", () => {
		const { state } = store();
		const event: AgentToolAuditEvent = {
			type: "tool.execution.completed",
			tenantId: scope.tenantId,
			workspaceId: scope.workspaceId,
			runId: scope.runId,
			stageId: "conversation",
			actorId: "user-1",
			executionId: "execution-audit",
			tool: "cron_create",
			toolCallId: "call-audit",
			risk: "write",
			idempotencyKey: "cron-audit",
			approvalId: "policy:cron_create:v1",
			status: "succeeded",
			failureCode: undefined,
			replayed: false,
			occurredAt: "2026-09-03T00:00:00.000Z",
		};

		expect(() => state.append(event)).not.toThrow();
		expect(() => state.append(event)).not.toThrow();
	});

	it("persists tenant-scoped Runtime traces idempotently", () => {
		const { root, state } = store();
		const trace: RuntimeTraceRecord = {
			schemaVersion: "runtime-trace.v1",
			tenantId: scope.tenantId,
			workspaceId: scope.workspaceId,
			runId: scope.runId,
			stageId: "research",
			actorId: "eval-runner",
			executionId: "execution-trace",
			idempotencyKey: "turn-trace",
			status: "completed",
			startedAt: "2026-09-03T00:00:00.000Z",
			completedAt: "2026-09-03T00:00:01.000Z",
			durationMs: 1_000,
			sessionId: scope.sessionId,
			events: [{ type: "turn.started" }],
		};
		state.putTrace(trace);
		expect(state.putTrace(trace)).toEqual(trace);
		expect(new FileAgentStateStore(root).listTraces(scope)).toEqual([trace]);
		expect(state.listTraces({ ...scope, tenantId: "tenant-b" })).toEqual([]);
	});

	it("normalizes undefined optional Runtime event fields before persistence", () => {
		const { root, state } = store();
		state.putTrace({
			schemaVersion: "runtime-trace.v1",
			tenantId: scope.tenantId,
			workspaceId: scope.workspaceId,
			runId: scope.runId,
			stageId: "research",
			actorId: "eval-runner",
			executionId: "execution-tool-trace",
			idempotencyKey: "turn-tool-trace",
			status: "completed",
			startedAt: "2026-09-03T00:00:00.000Z",
			completedAt: "2026-09-03T00:00:01.000Z",
			durationMs: 1_000,
			events: [{
				type: "tool.completed",
				tool: "research_source_read",
				toolCallId: "read-source",
				risk: "read",
				status: "succeeded",
				failureCode: undefined,
				durationMs: 1,
				resultTruncated: false,
				replayed: false,
			}],
		});

		const [trace] = new FileAgentStateStore(root).listTraces(scope);
		expect(trace?.events[0]).not.toHaveProperty("failureCode");
	});

	it("fails closed on corrupt Session data", () => {
		const { root, state } = store();
		const directory = join(root, "tenant-a", "workspace-a", "run-a", "sessions");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "session-a.json"), "{}", "utf8");

		expect(() => state.load(scope)).toThrowError(
			expect.objectContaining({ code: "corrupt" }) as AgentStateStoreError,
		);
	});
});
