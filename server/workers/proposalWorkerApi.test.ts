import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { InMemoryCronScheduleStore } from "../../src/enterprise/cronSchedule";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import type { ProposalApiContext } from "../enterprise/proposalApi";
import { FakeAgentRuntime } from "../runtime/fakeAgentRuntime";
import { ProposalWorker } from "./proposalWorker";
import { ProposalWorkerApiController } from "./proposalWorkerApi";
import { proposalStageJob, StageJobOutbox } from "./stageJobOutbox";
import { StageJobScheduler } from "./stageJobScheduler";

const token = "worker-api-test-token-with-sufficient-entropy";
const operatorToken = "operator-api-test-token-with-sufficient-entropy";
const temporaryDirectories: string[] = [];
const context = {
	tenantId: "tenant-api",
	workspaceId: "workspace-api",
	authorization: `Bearer ${token}`,
} satisfies ProposalApiContext;

function harness(
	configuredToken: string | null = token,
	configuredOperatorToken: string | null = operatorToken,
) {
	const directory = mkdtempSync(join(tmpdir(), "blackx-worker-api-"));
	temporaryDirectories.push(directory);
	const store = new InMemoryEnterpriseEventStore();
	const engine = new ProposalRunEngine(store);
	const envelope = {
		tenantId: "tenant-api",
		workspaceId: "workspace-api",
		runId: "run-api",
		correlationId: "trace-api",
		actorId: "user-api",
	};
	engine.create({ ...envelope, commandId: "create", expectedVersion: 0 });
	engine.startProposal({ ...envelope, commandId: "start", expectedVersion: 1 });
	const queue = new InMemoryStageJobQueue();
	const worker = new ProposalWorker(
		engine,
		new FakeAgentRuntime(),
		new FileArtifactContentStore(directory),
	);
	const scheduler = new StageJobScheduler(queue, {
		workerId: "worker-api",
		handlers: { proposal: (lease, signal, guard) => worker.executeLease(lease, signal, guard) },
	});
	const schedules = new InMemoryCronScheduleStore();
	const controller = new ProposalWorkerApiController(
		scheduler,
		new StageJobOutbox(engine, store, queue),
		configuredToken ?? undefined,
		configuredOperatorToken ?? undefined,
		schedules,
	);
	return { engine, controller, queue, scheduler, store, schedules };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("ProposalWorkerApiController", () => {
	it("restricts Outbox and Cron recovery to scoped operators with an observed version and immutable request ID", () => {
		const { controller, store, engine, queue, schedules } = harness();
		const operator = { ...context, actorId: "operator-api", authorization: `Bearer ${operatorToken}` };
		const outbox = new StageJobOutbox(engine, store, queue);
		const message = outbox.requestProposal({ ...context, runId: "run-api", commandId: "dispatch", correlationId: "trace-api", expectedVersion: 2 });
		const dead = store.markOutboxFailed(message.messageId, { code: "job_conflict", message: "Review", delayMs: 0, retryable: false });
		const schedule = schedules.create({ ...context, runId: "run-api", actorId: "user-api", scheduleId: "schedule-api", name: "Review", expression: "*/5 * * * *", timezone: "UTC", prompt: "Review", maxRuns: 1, nextRunAt: new Date().toISOString() });
		for (let i = 0; i < 5; i++) schedules.defer(schedule.scheduleId, schedule.nextRunAt, "queue_unavailable");
		for (const read of [controller.outboxStatus.bind(controller), controller.cronStatus.bind(controller)]) {
			expect(read(context).status).toBe(401);
			expect(read(operator).status).toBe(200);
		}
		expect(controller.outboxStatus({ ...operator, tenantId: "other" })).toMatchObject({ body: { messages: [] } });
		expect(controller.cronStatus({ ...operator, workspaceId: "other" })).toMatchObject({ body: { schedules: [] } });
		for (const [id, updatedAt, recover] of [
			[message.messageId, dead.updatedAt, controller.outboxRedrive.bind(controller)],
			[schedule.scheduleId, schedules.get(schedule.scheduleId)!.updatedAt, controller.cronRecover.bind(controller)],
		] as const) {
			const body = { requestId: `recover-${id}`, expectedUpdatedAt: updatedAt, reason: "Reviewed storage failure" };
			expect(recover(context, id, body).status).toBe(401);
			expect(recover({ ...operator, tenantId: "other" }, id, body).status).toBe(404);
			expect(recover(operator, id, { ...body, expectedUpdatedAt: "2020-01-01T00:00:00Z" }).status).toBe(409);
			expect(recover(operator, id, { ...body, requestId: undefined }).status).toBe(400);
			expect(recover({ ...operator, actorId: undefined }, id, body).status).toBe(400);
			expect(recover(operator, id, body).status).toBe(200);
			expect(recover(operator, id, body).status).toBe(200);
			expect(recover(operator, id, { ...body, reason: "Changed" }).status).toBe(409);
		}
		const disabled = harness(token, null).controller;
		expect(disabled.outboxStatus(operator).status).toBe(503);
		expect(disabled.cronRecover(operator, "schedule-api", {}).status).toBe(503);
	});
	it("queues the server-owned Worker with Worker credentials", async () => {
		const { controller, engine, scheduler } = harness();
		const response = await controller.execute(context, "run-api", {
			commandId: "execute-v1",
			correlationId: "trace-api",
			expectedVersion: 2,
		});

		expect(response).toMatchObject({
			status: 202,
			body: {
				job: {
					status: "queued",
					stageId: "proposal",
				},
			},
		});
		const jobId = (response.body as { job: { jobId: string } }).job.jobId;
		expect(controller.status(context, jobId)).toMatchObject({
			status: 200,
			body: { job: { jobId, status: "queued" } },
		});
		expect(controller.status(
			{ ...context, tenantId: "another-tenant" },
			jobId,
		)).toEqual({ status: 404, body: { code: "job_not_found" } });
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
		const waiting = engine.load({
			tenantId: "tenant-api",
			workspaceId: "workspace-api",
			runId: "run-api",
		});
		const approved = engine.resolveApproval({
			tenantId: "tenant-api",
			workspaceId: "workspace-api",
			runId: "run-api",
			commandId: "approve-v1",
			correlationId: "trace-api",
			actorId: "approver-api",
			expectedVersion: waiting.aggregateVersion,
			approvalId: waiting.approval?.approvalId ?? "missing",
			artifactId: "solution-proposal",
			artifactVersion: 1,
			decision: "approved",
		});
		expect(approved.approval?.status).toBe("approved");
		expect(engine.hasCommand({
			tenantId: "tenant-api",
			workspaceId: "workspace-api",
			runId: "run-api",
		}, "confirm-gate-v1:evaluation")).toBe(false);
		const queuedGate = await controller.execute(context, "run-api", {
			commandId: "confirm-gate-v1",
			correlationId: "trace-api",
			expectedVersion: approved.aggregateVersion,
		});
		expect(queuedGate).toMatchObject({ status: 202, body: { job: { status: "queued" } } });
		expect(queuedGate).toMatchObject({ body: { job: { commandId: "confirm-gate-v1" } } });
		const gateResult = await scheduler.runNext();
		expect(gateResult).toMatchObject({
			status: "completed",
			job: { commandId: "confirm-gate-v1", status: "completed" },
		});
		expect(engine.load({
			tenantId: "tenant-api",
			workspaceId: "workspace-api",
			runId: "run-api",
		})).toMatchObject({ status: "completed", stageStatus: "passed" });
	});

	it("fails closed when the Worker API is disabled or unauthorized", async () => {
		expect(await harness(null).controller.execute(context, "run-api", {})).toEqual({
			status: 503,
			body: { code: "worker_api_disabled" },
		});
		expect(await harness().controller.execute(
			{ ...context, authorization: "Bearer wrong" },
			"run-api",
			{},
		)).toEqual({ status: 401, body: { code: "unauthorized" } });
	});

	it("exposes tenant-scoped metrics and audited DLQ redrive only to operators", () => {
		const { controller, queue } = harness();
		const job = queue.enqueue(proposalStageJob({
			tenantId: "tenant-api",
			workspaceId: "workspace-api",
			runId: "run-api",
			commandId: "dead-job",
			correlationId: "trace-api",
			expectedVersion: 2,
		}));
		const dead = queue.fail(queue.claim("worker-failing", 1_000)!, {
			code: "permission_denied",
			message: "operator decision required",
			retryable: false,
		});
		const operatorContext = {
			...context,
			actorId: "operator-api",
			authorization: `Bearer ${operatorToken}`,
		};

		expect(controller.metrics(operatorContext)).toMatchObject({
			status: 200,
			body: { metrics: { deadLetter: 1, total: 1 } },
		});
		expect(controller.deadLetters(operatorContext)).toMatchObject({
			status: 200,
			body: { jobs: [{ jobId: job.jobId, status: "dead_letter" }] },
		});
		expect(controller.redrive(operatorContext, job.jobId, {
			expectedUpdatedAt: dead.updatedAt,
			reason: "manual evidence reviewed",
			additionalSlices: 2,
		})).toMatchObject({
			status: 200,
			body: {
				job: {
					status: "queued",
					redriveCount: 1,
					lastRedrive: { actorId: "operator-api" },
				},
			},
		});
		expect(controller.metrics({
			...operatorContext,
			authorization: `Bearer ${token}`,
		})).toEqual({ status: 401, body: { code: "unauthorized" } });
	});
});
