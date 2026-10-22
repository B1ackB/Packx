import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { createDeterministicProposal } from "../../src/print/solutionProposal";
import type {
	AgentRuntimePort,
	RuntimeHealth,
	RuntimeTurnRequest,
	RuntimeTurnResult,
} from "../../src/runtime/contracts";
import { RuntimeFailure } from "../../src/runtime/contracts";
import { ProposalWorker } from "./proposalWorker";
import { proposalStageJob } from "./stageJobOutbox";
import { StageJobScheduler } from "./stageJobScheduler";

const temporaryDirectories: string[] = [];

class SlicedRuntime implements AgentRuntimePort {
	readonly requests: RuntimeTurnRequest[] = [];
	readonly signals: Array<AbortSignal | undefined> = [];

	constructor(
		private pausesRemaining: number,
		private readonly finalResponse: string,
		private failuresRemaining = 0,
		private readonly delayMs = 0,
	) {}

	health(): Promise<RuntimeHealth> {
		return Promise.resolve({ adapter: "fake", online: true });
	}

	async executeTurn(request: RuntimeTurnRequest, signal?: AbortSignal): Promise<RuntimeTurnResult> {
		this.requests.push(request);
		this.signals.push(signal);
		if (this.delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, this.delayMs));
		}
		if (this.failuresRemaining-- > 0) {
			throw new RuntimeFailure("model_failure", "Provider unavailable", true);
		}
		const call = this.requests.length;
		const paused = this.pausesRemaining-- > 0;
		return {
			executionId: `execution-${call}`,
			adapter: "fake",
			status: paused ? "paused" : "completed",
			sessionId: request.sessionId,
			contextSnapshotId: `context-${call}`,
			finalResponse: paused ? "" : this.finalResponse,
			events: [],
		};
	}
}

function prepare(
	runtime: AgentRuntimePort,
	now: () => Date = () => new Date("2026-09-03T00:00:00.000Z"),
	schedulerOptions: Partial<ConstructorParameters<typeof StageJobScheduler>[1]> = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "blackx-stage-scheduler-"));
	temporaryDirectories.push(directory);
	const engine = new ProposalRunEngine(new InMemoryEnterpriseEventStore());
	const base = {
		tenantId: "tenant-scheduler",
		workspaceId: "workspace-scheduler",
		runId: "run-scheduler",
		correlationId: "trace-scheduler",
		actorId: "user-scheduler",
	};
	engine.create({ ...base, commandId: "create", expectedVersion: 0 });
	engine.startProposal({ ...base, commandId: "start", expectedVersion: 1 });
	const state = engine.recordFactVersion({
		...base,
		commandId: "fact",
		expectedVersion: 2,
		factKey: "quantity",
		factVersion: 1,
		value: 10_000,
		unit: "bags",
		status: "unverified",
		sourceType: "user_input",
		sourceRef: "message-a",
	});
	const queue = new InMemoryStageJobQueue({
		now,
		nextId: (() => {
			let value = 0;
			return () => `lease-${++value}`;
		})(),
	});
	const proposalWorker = new ProposalWorker(engine, runtime, new FileArtifactContentStore(directory));
	const scheduler = new StageJobScheduler(queue, {
		workerId: "worker-scheduler",
		leaseMs: 1_000,
		...schedulerOptions,
		handlers: {
			proposal: (lease, signal, guard) => proposalWorker.executeLease(lease, signal, guard),
			...schedulerOptions.handlers,
		},
	});
	const command = {
		tenantId: base.tenantId,
		workspaceId: base.workspaceId,
		runId: base.runId,
		commandId: "execute-proposal",
		correlationId: base.correlationId,
		expectedVersion: state.aggregateVersion,
	};
	return { command, engine, queue, scheduler };
}

afterEach(() => {
	vi.useRealTimers();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("StageJobScheduler", () => {
	it("aborts on lost ownership and rejects a non-cooperative provider's late Artifact", async () => {
		vi.useFakeTimers();
		let current = new Date("2026-09-05T00:00:00Z");
		const runtime = new SlicedRuntime(0, JSON.stringify(createDeterministicProposal({})), 0, 60);
		const { command, queue, scheduler, engine } = prepare(runtime, () => current, { leaseMs: 30, heartbeatMs: 5 });
		queue.enqueue(proposalStageJob(command));
		const initialVersion = engine.load(command).aggregateVersion;
		const pending = scheduler.runNext().catch((error: unknown) => error);
		current = new Date(current.getTime() + 31);
		const successor = queue.claim("new-worker", 1000);
		expect(successor).toBeDefined();
		await vi.advanceTimersByTimeAsync(5);
		expect(runtime.signals[0]?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(55);
		expect(await pending).toMatchObject({ code: "lease_lost" });
		expect(engine.load(command).aggregateVersion).toBe(initialVersion);
		expect(engine.load(command).currentProposal).toBeUndefined();
		expect(queue.get(successor!.jobId)?.status).toBe("leased");
	});

	it("checks the lease at commit even when the heartbeat timer has not run", async () => {
		let current = new Date("2026-09-05T00:00:00Z");
		let resolve!: (result: RuntimeTurnResult) => void;
		const runtime: AgentRuntimePort = { health: async () => ({ adapter: "fake", online: true }), executeTurn: () => new Promise((done) => { resolve = done; }) };
		const { command, queue, scheduler, engine } = prepare(runtime, () => current);
		queue.enqueue(proposalStageJob(command));
		const pending = scheduler.runNext();
		current = new Date(current.getTime() + 1001);
		resolve({ executionId: "late", adapter: "fake", status: "completed", contextSnapshotId: "late-context", finalResponse: JSON.stringify(createDeterministicProposal({})), events: [] });
		await expect(pending).rejects.toMatchObject({ code: "lease_lost" });
		expect(engine.load(command).currentProposal).toBeUndefined();
	});

	it("releases the worker after each slice and schedules the same Session again", async () => {
		const proposal = createDeterministicProposal({
			quantity: {
				key: "quantity",
				version: 1,
				value: 10_000,
				unit: "bags",
				status: "unverified",
				sourceType: "user_input",
				sourceRef: "message-a",
			},
		});
		const runtime = new SlicedRuntime(2, JSON.stringify(proposal));
		const { command, engine, queue, scheduler } = prepare(runtime);
		const enqueued = queue.enqueue(proposalStageJob(command, { maxSlices: 4 }));

		expect(await scheduler.runNext()).toMatchObject({
			status: "paused",
			job: { status: "queued", sliceCount: 1 },
		});
		expect(await scheduler.runNext()).toMatchObject({
			status: "paused",
			job: { status: "queued", sliceCount: 2 },
		});
		expect(await scheduler.runNext()).toMatchObject({
			status: "completed",
			job: { status: "completed", sliceCount: 3, deliveryCount: 3 },
		});
		expect(await scheduler.runNext()).toEqual({ status: "idle" });
		expect(new Set(runtime.requests.map((request) => request.sessionId))).toEqual(
			new Set([enqueued.sessionId]),
		);
		expect(runtime.requests.every((request) => request.resume === "if-present")).toBe(true);
		expect(queue.get(enqueued.jobId)?.status).toBe("completed");
		expect(engine.load(command)).toMatchObject({
			status: "waiting_approval",
			stageStatus: "waiting_approval",
		});
	});

	it("classifies a retryable Runtime failure and backs off before the next claim", async () => {
		let current = new Date("2026-09-03T00:00:00.000Z");
		const proposal = createDeterministicProposal({});
		const runtime = new SlicedRuntime(0, JSON.stringify(proposal), 1);
		const { command, queue, scheduler } = prepare(runtime, () => current);
		queue.enqueue(proposalStageJob(command, { maxSlices: 4 }));

		expect(await scheduler.runNext()).toMatchObject({
			status: "retry_scheduled",
			job: { status: "queued", failureCount: 1, lastFailure: { code: "model_failure" } },
		});
		expect(await scheduler.runNext()).toEqual({ status: "idle" });
		current = new Date("2026-09-03T00:00:00.250Z");
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
	});

	it("renews a lease while a slow slice is still running", async () => {
		vi.useFakeTimers();
		const proposal = createDeterministicProposal({
			quantity: {
				key: "quantity",
				version: 1,
				value: 10_000,
				unit: "bags",
				status: "unverified",
				sourceType: "user_input",
				sourceRef: "message-a",
			},
		});
		const runtime = new SlicedRuntime(0, JSON.stringify(proposal), 0, 60);
		const { command, queue, scheduler } = prepare(
			runtime,
			() => new Date(),
			{ leaseMs: 30, heartbeatMs: 5 },
		);
		queue.enqueue(proposalStageJob(command, { maxSlices: 4 }));
		const running = scheduler.runNext();
		await vi.advanceTimersByTimeAsync(40);

		expect(queue.claim("worker-competing", 30)).toBeUndefined();
		await vi.advanceTimersByTimeAsync(20);
		expect(await running).toMatchObject({ status: "completed" });
	});

	it("dispatches a registered non-proposal job through the same durable scheduler", async () => {
		let handledJobId = "";
		const runtime = new SlicedRuntime(0, "unused");
		const { queue, scheduler } = prepare(runtime, undefined, {
			handlers: {
				"conversation-background": async (lease) => {
					handledJobId = lease.jobId;
					return { status: "completed" };
				},
			},
		});
		queue.enqueue({
			tenantId: "tenant-scheduler",
			workspaceId: "workspace-scheduler",
			runId: "conversation-a",
			stageId: "conversation-background",
			jobId: "background-a",
			commandId: "message-a",
			correlationId: "background-a",
			expectedVersion: 0,
			sessionId: "conversation-a",
		});

		expect(await scheduler.runNext()).toMatchObject({ status: "completed", job: { jobId: "background-a" } });
		expect(handledJobId).toBe("background-a");
	});

	it("cooperatively aborts and releases a leased job when it is cancelled", async () => {
		let started!: () => void;
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const runtime = new SlicedRuntime(0, "unused");
		const { queue, scheduler } = prepare(runtime, undefined, {
			handlers: {
				"cancel-stage": async (_lease, signal) => {
					started();
					await new Promise<void>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(
							new RuntimeFailure("execution_failed", "Stage Job cancelled", false),
						), { once: true });
					});
					return { status: "completed" };
				},
			},
		});
		const job = queue.enqueue({
			tenantId: "tenant-scheduler",
			workspaceId: "workspace-scheduler",
			runId: "cancel-run",
			stageId: "cancel-stage",
			jobId: "cancel-active",
			commandId: "cancel-command",
			correlationId: "cancel-correlation",
			expectedVersion: 0,
			sessionId: "cancel-session",
		});
		const result = scheduler.runNext();
		await running;

		expect(scheduler.cancel(job.jobId, job)).toMatchObject({ status: "cancelled" });
		expect(await result).toMatchObject({ status: "cancelled", job: { status: "cancelled" } });
	});

	it("waits for shutdown cleanup and preserves the active lease for restart recovery", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let current = new Date("2026-10-22T00:00:00Z"), cleaned = false;
		const queue = new InMemoryStageJobQueue({ now: () => current });
		const job = queue.enqueue({ tenantId: "tenant", workspaceId: "workspace", runId: "run", stageId: "cleanup", jobId: "job", commandId: "command", correlationId: "trace", expectedVersion: 0, sessionId: "session" });
		const scheduler = new StageJobScheduler(queue, { workerId: "stopping-worker", leaseMs: 1000, heartbeatMs: 250, handlers: {
			cleanup: async (_lease, signal) => {
				try { await gate; signal.throwIfAborted(); return { status: "completed" }; }
				finally { cleaned = true; }
			},
		} });
		const running = scheduler.runNext();
		let drained = false;
		const stopping = Promise.resolve(scheduler.stop()).then(() => { drained = true; });
		await Promise.resolve();
		const stoppedBeforeCleanup = drained;
		release();
		await running; await stopping;
		expect(stoppedBeforeCleanup).toBe(false);
		expect(cleaned).toBe(true);
		expect(queue.get(job.jobId)).toMatchObject({ status: "leased", failureCount: 0 });
		current = new Date(current.getTime() + 1001);
		// A stopped scheduler must neither reconcile nor claim work again.
		await scheduler.runNext();
		expect(queue.get(job.jobId)?.deliveryCount).toBe(1);
		const restarted = new StageJobScheduler(queue, { workerId: "restarted-worker", handlers: { cleanup: async () => ({ status: "completed" }) } });
		expect(await restarted.runNext()).toMatchObject({ status: "completed", job: { deliveryCount: 2, recoveryCount: 1, failureCount: 0 } });
	});
});
