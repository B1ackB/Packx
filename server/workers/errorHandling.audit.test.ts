import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStoreError } from "../../src/enterprise/artifactStore";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { InMemoryStageJobQueue, type StageJobQueue } from "../../src/enterprise/stageJobQueue";
import { RuntimeFailure, type AgentRuntimePort, type RuntimeFailureCode } from "../../src/runtime/contracts";
import { FileStageJobQueue } from "../enterprise/fileStageJobQueue";
import { SqliteStageJobQueue } from "../enterprise/sqliteStageJobQueue";
import { ConversationApiController } from "../runtime/conversationApi";
import { FileAgentStateStore } from "../runtime/fileAgentStateStore";
import { BackgroundConversationWorker } from "./backgroundConversationWorker";
import { StageJobOutbox } from "./stageJobOutbox";
import { StageJobScheduler } from "./stageJobScheduler";

const directories: string[] = [];
const closers: Array<() => void> = [];
const scope = { tenantId: "tenant-error-audit", workspaceId: "workspace-error-audit", runId: "run-error-audit" };
const jobInput = {
	...scope, stageId: "audit", jobId: "job-audit", commandId: "command-audit",
	correlationId: "trace-audit", expectedVersion: 0, sessionId: "session-audit",
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const close of closers.splice(0)) close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function queueFor(adapter: "memory" | "file" | "sqlite"): StageJobQueue {
	const options = { now: () => new Date("2026-09-21T00:00:00.000Z") };
	if (adapter === "memory") return new InMemoryStageJobQueue(options);
	const directory = mkdtempSync(join(tmpdir(), "packx-error-audit-"));
	directories.push(directory);
	if (adapter === "file") return new FileStageJobQueue(join(directory, "queue.json"), options);
	const queue = new SqliteStageJobQueue(join(directory, "queue.sqlite"), options);
	closers.push(() => queue.close());
	return queue;
}

describe.each(["memory", "file", "sqlite"] as const)("%s queue error recovery budget", (adapter) => {
	it("requires an explicit slice increase before redriving a slice-exhausted job", async () => {
		const queue = queueFor(adapter);
		queue.enqueue({ ...jobInput, maxSlices: 1 });
		const handler = vi.fn(async () => ({ status: "paused" as const, sessionId: jobInput.sessionId }));
		const scheduler = new StageJobScheduler(queue, { workerId: "worker-audit", handlers: { audit: handler } });
		expect(await scheduler.runNext()).toMatchObject({ status: "dead_letter", job: { sliceCount: 1, maxSlices: 1 } });
		const dead = queue.get(jobInput.jobId)!;

		expect(() => scheduler.redrive(dead.jobId, scope, {
			expectedUpdatedAt: dead.updatedAt, actorId: "operator-audit", reason: "retry without raising approved budget",
		})).toThrowError(expect.objectContaining({ code: "job_conflict" }));
		expect(queue.get(dead.jobId)).toEqual(dead);
		expect(await scheduler.runNext()).toEqual({ status: "idle" });
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("allows only the explicitly added slice and preserves the previous checkpoint and audit", async () => {
		const queue = queueFor(adapter);
		queue.enqueue({ ...jobInput, maxSlices: 1 });
		const handler = vi.fn(async () => ({ status: "paused" as const, sessionId: jobInput.sessionId, contextSnapshotId: "snapshot-audit" }));
		const scheduler = new StageJobScheduler(queue, { workerId: "worker-audit", handlers: { audit: handler } });
		await scheduler.runNext();
		const dead = queue.get(jobInput.jobId)!;
		expect(scheduler.redrive(dead.jobId, scope, {
			expectedUpdatedAt: dead.updatedAt, actorId: "operator-audit", reason: "one more approved slice", additionalSlices: 1,
		})).toMatchObject({ status: "queued", maxSlices: 2, sliceCount: 1, lastContextSnapshotId: "snapshot-audit", redriveCount: 1 });
		expect(await scheduler.runNext()).toMatchObject({ status: "dead_letter", job: { sliceCount: 2, maxSlices: 2, lastFailure: { code: "slice_budget_exceeded" } } });
		expect(await scheduler.runNext()).toEqual({ status: "idle" });
		expect(handler).toHaveBeenCalledTimes(2);
	});
});

describe("StageJobScheduler failure injection", () => {
	it.each([
		{ error: new RuntimeFailure("permission_denied", "denied", false), code: "permission_denied", retryable: false },
		{ error: new RuntimeFailure("rate_limit", "limited", true), code: "rate_limit", retryable: true },
		{ error: new ArtifactStoreError("artifact_store_unavailable", "unavailable"), code: "artifact_store_unavailable", retryable: true },
		{ error: new ArtifactStoreError("artifact_conflict", "conflict"), code: "artifact_conflict", retryable: false },
		{ error: new EnterpriseKernelError("event_store_unavailable", "unavailable"), code: "event_store_unavailable", retryable: true },
		{ error: new EnterpriseKernelError("concurrency_conflict", "conflict"), code: "concurrency_conflict", retryable: false },
	])("preserves $code classification and exhausts only its allowed retry budget", async ({ error, code, retryable }) => {
		let now = new Date("2026-09-21T00:00:00.000Z");
		const queue = new InMemoryStageJobQueue({ now: () => now });
		queue.enqueue({ ...jobInput, maxFailures: 2 });
		const handler = vi.fn(async () => { throw error; });
		const scheduler = new StageJobScheduler(queue, { workerId: "worker-audit", handlers: { audit: handler } });
		expect(await scheduler.runNext()).toMatchObject({
			status: retryable ? "retry_scheduled" : "dead_letter",
			job: { failureCount: 1, lastFailure: { code, retryable } },
		});
		expect(await scheduler.runNext()).toEqual({ status: "idle" });
		if (retryable) {
			now = new Date(now.getTime() + 250);
			expect(await scheduler.runNext()).toMatchObject({ status: "dead_letter", job: { failureCount: 2, totalFailureCount: 2, lastFailure: { code, retryable } } });
		}
		expect(await scheduler.runNext()).toEqual({ status: "idle" });
		expect(handler).toHaveBeenCalledTimes(retryable ? 2 : 1);
	});

	it("sanitizes an unclassified exception before it enters durable queue state", async () => {
		const queue = new InMemoryStageJobQueue();
		queue.enqueue(jobInput);
		const scheduler = new StageJobScheduler(queue, { workerId: "worker-audit", handlers: {
			audit: async () => { throw new Error("fixture-private-message-secret"); },
		} });
		expect(await scheduler.runNext()).toMatchObject({ status: "retry_scheduled", job: { lastFailure: { code: "worker_execution_failed", retryable: true } } });
		expect(JSON.stringify(queue.list())).not.toContain("fixture-private-message-secret");
	});

	it("does not acknowledge a handler that ignores cancellation and returns late", async () => {
		const queue = new InMemoryStageJobQueue();
		queue.enqueue(jobInput);
		let complete!: (result: { status: "completed" }) => void;
		const deferred = new Promise<{ status: "completed" }>((resolve) => { complete = resolve; });
		const scheduler = new StageJobScheduler(queue, { workerId: "worker-audit", handlers: { audit: () => deferred } });
		const running = scheduler.runNext();
		expect(scheduler.cancel(jobInput.jobId, scope)).toMatchObject({ status: "cancelled" });
		complete({ status: "completed" });
		expect(await running).toMatchObject({ status: "cancelled", job: { sliceCount: 0, status: "cancelled" } });
	});

	it("does not record the old handler failure after another worker has reclaimed its lease", async () => {
		let now = new Date("2026-09-21T00:00:00.000Z");
		const queue = new InMemoryStageJobQueue({ now: () => now });
		queue.enqueue(jobInput);
		let fail!: (error: unknown) => void;
		const deferred = new Promise<{ status: "completed" }>((_resolve, reject) => { fail = reject; });
		const scheduler = new StageJobScheduler(queue, { workerId: "worker-old", leaseMs: 100, heartbeatMs: 30, handlers: { audit: () => deferred } });
		const running = scheduler.runNext();
		now = new Date(now.getTime() + 101);
		const replacement = queue.claim("worker-new", 100)!;
		fail(new RuntimeFailure("model_failure", "late failure", true));
		await expect(running).rejects.toMatchObject({ code: "lease_lost" });
		expect(queue.get(jobInput.jobId)).toEqual(replacement);
		expect(queue.ack(replacement)).toMatchObject({ status: "completed", totalFailureCount: 1 });
	});

	it("rejects an incomplete pause result instead of acknowledging or retrying it", async () => {
		const queue = new InMemoryStageJobQueue();
		queue.enqueue(jobInput);
		const scheduler = new StageJobScheduler(queue, { workerId: "worker-audit", handlers: { audit: async () => ({ status: "paused" }) } });
		expect(await scheduler.runNext()).toMatchObject({ status: "dead_letter", job: { sliceCount: 0, lastFailure: { code: "invalid_output", retryable: false } } });
	});
});

describe("Outbox persistence failure injection", () => {
	it("retries an Outbox ACK failure after work already completed without dispatching it again", async () => {
		let now = new Date("2026-09-21T00:00:00.000Z");
		const store = new InMemoryEnterpriseEventStore({ now: () => now });
		const engine = new ProposalRunEngine(store);
		const command = { ...scope, actorId: "user-audit", correlationId: "trace-audit" };
		engine.create({ ...command, commandId: "create", expectedVersion: 0 });
		engine.startProposal({ ...command, commandId: "start", expectedVersion: 1 });
		const queue = new InMemoryStageJobQueue({ now: () => now });
		const outbox = new StageJobOutbox(engine, store, queue);
		outbox.requestStage({ ...command, commandId: "execute", expectedVersion: 2 }, { stageId: "audit", jobPrefix: "audit" });
		vi.spyOn(store, "markOutboxPublished").mockImplementationOnce(() => { throw new EnterpriseKernelError("event_store_unavailable", "injected ACK failure"); });
		expect(outbox.dispatchOne()).toMatchObject({ status: "retry_scheduled" });
		const handler = vi.fn(async () => ({ status: "completed" as const }));
		const scheduler = new StageJobScheduler(queue, { workerId: "worker-audit", handlers: { audit: handler } });
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
		now = new Date(now.getTime() + 250);
		expect(outbox.dispatchOne()).toMatchObject({ status: "published", job: { status: "completed" } });
		expect(await scheduler.runNext()).toEqual({ status: "idle" });
		expect(handler).toHaveBeenCalledTimes(1);
		expect(queue.list()).toHaveLength(1);
		expect(store.readPendingOutbox(10)).toEqual([]);
	});
});

describe("Background Runtime failure contract", () => {
	const codes: RuntimeFailureCode[] = [
		"authentication", "rate_limit", "model_failure", "timeout", "cancelled", "invalid_output",
		"context_failure", "budget_exceeded", "repeated_actions", "consecutive_tool_failures",
		"permission_denied", "max_iterations", "session_conflict", "infrastructure_failure",
		"runtime_unavailable", "execution_failed",
	];
	it.each(codes.flatMap((code) => [true, false].map((retryable) => ({ code, retryable }))))(
		"preserves $code with retryable=$retryable through the real conversation API",
		async ({ code, retryable }) => {
			const directory = mkdtempSync(join(tmpdir(), "packx-background-error-audit-"));
			directories.push(directory);
			const executeTurn = vi.fn(async () => { throw new RuntimeFailure(code, "fixture failure", retryable); });
			const runtime: AgentRuntimePort = {
				health: async () => ({ adapter: "blackx-agent", online: true }),
				executeTurn,
			};
			const conversations = new ConversationApiController(runtime, new FileAgentStateStore(directory), undefined, () => scope.runId);
			const created = conversations.create({ ...scope, actorId: "user-audit" });
			expect(created.status).toBe(201);
			const conversationId = (created.body as { conversation: { conversationId: string } }).conversation.conversationId;
			const queue = new InMemoryStageJobQueue();
			queue.enqueue({ ...jobInput, runId: conversationId, sessionId: conversationId, payload: { type: "conversation.message.v1", messageId: "message-audit", content: "fixture", actorId: "user-audit" } });
			const worker = new BackgroundConversationWorker(conversations);
			const scheduler = new StageJobScheduler(queue, { workerId: "worker-audit", handlers: { audit: (lease, signal, check) => worker.execute(lease, signal, check) } });
			expect(await scheduler.runNext()).toMatchObject({
				status: retryable ? "retry_scheduled" : "dead_letter",
				job: { lastFailure: { code, retryable } },
			});
			expect(executeTurn).toHaveBeenCalledTimes(1);
		},
	);
});

describe("SQLite queue commit recovery", () => {
	it("rolls back a failed acknowledgement and accepts the original lease after the store recovers", () => {
		const directory = mkdtempSync(join(tmpdir(), "packx-queue-commit-audit-"));
		directories.push(directory);
		const path = join(directory, "queue.sqlite");
		const options = { now: () => new Date("2026-09-21T00:00:00.000Z") };
		const queue = new SqliteStageJobQueue(path, options);
		const database = new DatabaseSync(path);
		try {
			queue.enqueue(jobInput);
			const lease = queue.claim("worker-audit", 1000)!;
			database.exec("CREATE TRIGGER fail_queue_commit BEFORE UPDATE ON stage_job_queue BEGIN SELECT RAISE(ABORT, 'injected_queue_commit_failure'); END;");
			expect(() => queue.ack(lease)).toThrowError(expect.objectContaining({ code: "queue_unavailable" }));
			expect(queue.get(jobInput.jobId)).toEqual(lease);
			database.exec("DROP TRIGGER fail_queue_commit;");
			const restarted = new SqliteStageJobQueue(path, options);
			try {
				expect(restarted.get(jobInput.jobId)).toEqual(lease);
				expect(restarted.ack(lease)).toMatchObject({ status: "completed", sliceCount: 1, deliveryCount: 1 });
				expect(restarted.claim("worker-next", 1000)).toBeUndefined();
			} finally {
				restarted.close();
			}
		} finally {
			database.close();
			queue.close();
		}
	});
});
