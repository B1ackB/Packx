import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { StageJobQueueError } from "../../src/enterprise/stageJobQueue";
import { FileCronScheduleStore } from "../enterprise/fileCronScheduleStore";
import { FileStageJobQueue } from "../enterprise/fileStageJobQueue";
import { CronDispatcher } from "./cronScheduler";

const roots: string[] = [];
const scope = { tenantId: "cron-tenant", workspaceId: "cron-workspace", runId: "cron-run", actorId: "cron-user" };
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "packx-cron-")); roots.push(root);
	let time = Date.parse("2026-10-22T00:00:00Z");
	const now = () => new Date(time), open = () => ({ store: new FileCronScheduleStore(join(root, "cron.json"), now), queue: new FileStageJobQueue(join(root, "queue.json"), { now }) });
	const { store, queue } = open(), errors: unknown[] = [], dispatcher = new CronDispatcher(store, queue, now, error => errors.push(error));
	const create = (scheduleId: string, maxRuns = 2) => store.create({ ...scope, scheduleId, name: scheduleId, expression: "*/5 * * * *", timezone: "UTC", prompt: "Review", maxRuns, nextRunAt: now().toISOString() });
	return { now, create, store, queue, open, errors, dispatcher, advance: () => { time += 300_000; } };
}

it("does not overlap occurrences, stops on job exhaustion, and resumes only after operator redrive succeeds", () => {
	const { create, store, queue, open, dispatcher, advance, now } = fixture();
	create("bounded"); expect(dispatcher.dispatchDue()).toBe(1);
	const job = queue.list()[0]; advance(); expect(dispatcher.dispatchDue()).toBe(0); expect(queue.list()).toHaveLength(1);
	const dead = queue.fail(queue.claim("worker", 10_000)!, { code: "permission_denied", message: "Review required", retryable: false });
	expect(dispatcher.dispatchDue()).toBe(0);
	const reopened = open();
	expect(reopened.store.get("bounded")).toMatchObject({ status: "failed", runCount: 1, pendingJobId: job.jobId, failure: { jobId: job.jobId, code: "permission_denied" } });
	expect(() => reopened.store.setStatus("bounded", scope, "active", now().toISOString())).toThrow();
	expect(() => reopened.store.recover("bounded", { ...scope, requestId: "skip-failure", expectedUpdatedAt: reopened.store.get("bounded")!.updatedAt, reason: "Must not skip failed job" })).toThrow();
	reopened.queue.redrive(job.jobId, { expectedUpdatedAt: dead.updatedAt, actorId: "operator", reason: "Permission restored" });
	const recovered = new CronDispatcher(reopened.store, reopened.queue, now);
	expect(recovered.dispatchDue()).toBe(0);
	reopened.queue.ack(reopened.queue.claim("worker", 10_000)!);
	expect(recovered.dispatchDue()).toBe(1);
	expect(reopened.queue.list()).toHaveLength(2);
	reopened.queue.ack(reopened.queue.claim("worker", 10_000)!);
	expect(recovered.dispatchDue()).toBe(0); advance(); expect(recovered.dispatchDue()).toBe(0);
	expect(store.get("bounded")).toMatchObject({ status: "completed", runCount: 2 });
});

it("isolates dispatch failures, persists a five-attempt limit, and audits scoped CAS recovery", () => {
	const { create, queue, open, dispatcher, errors, advance, now } = fixture();
	const original = create("broken"); create("healthy");
	const enqueue = queue.enqueue.bind(queue);
	const fault = vi.spyOn(queue, "enqueue").mockImplementation((input, mutation) => {
		if (input.payload?.actorId === "cron:broken") throw new StageJobQueueError("queue_unavailable", "Unavailable");
		return enqueue(input, mutation);
	});
	expect(dispatcher.dispatchDue()).toBe(1); expect(queue.list()).toHaveLength(1); expect(dispatcher.dispatchDue()).toBe(0);
	for (let i = 1; i < 5; i++) { advance(); expect(dispatcher.dispatchDue()).toBe(0); }
	expect(errors).toHaveLength(5); advance(); expect(dispatcher.dispatchDue()).toBe(0); expect(errors).toHaveLength(5);
	const reopened = open(), failed = reopened.store.get("broken")!;
	expect(failed).toMatchObject({ status: "failed", runCount: 0, dispatchFailure: { count: 5 }, nextRunAt: original.nextRunAt });
	const request = { ...scope, requestId: "operator-recover", expectedUpdatedAt: failed.updatedAt, reason: "Queue repaired" };
	expect(() => reopened.store.recover("broken", { ...request, tenantId: "other" })).toThrow();
	expect(() => reopened.store.recover("broken", { ...request, expectedUpdatedAt: original.updatedAt })).toThrow();
	expect(reopened.store.recover("broken", request)).toMatchObject({ status: "active", runCount: 0, nextRunAt: original.nextRunAt });
	expect(reopened.store.recover("broken", request).recoveries).toHaveLength(1);
	expect(() => reopened.store.recover("broken", { ...request, reason: "changed" })).toThrow();
	fault.mockRestore();
	expect(new CronDispatcher(reopened.store, reopened.queue, now).dispatchDue()).toBe(1);
	expect(reopened.store.get("broken")?.runCount).toBe(1);
	expect(reopened.queue.list()).toHaveLength(2);
});

it("rejects stale dispatch recovery when repeated failures share the same clock instant", () => {
	const { create, store } = fixture(), schedule = create("same-clock");
	for (let i = 0; i < 5; i++) store.defer(schedule.scheduleId, schedule.nextRunAt, "queue_unavailable");
	const failed = store.get(schedule.scheduleId)!;
	const request = { ...scope, requestId: "cycle-one", expectedUpdatedAt: failed.updatedAt, reason: "Reviewed" };
	store.recover(schedule.scheduleId, request);
	for (let i = 0; i < 5; i++) store.defer(schedule.scheduleId, schedule.nextRunAt, "queue_unavailable");
	expect(store.get(schedule.scheduleId)!.updatedAt).not.toBe(failed.updatedAt);
	expect(() => store.recover(schedule.scheduleId, { ...request, requestId: "stale-cycle-two" })).toThrow();
});

it("rejects a persisted irregular schedule before enqueue and keeps its failure bounded across restart", () => {
	const { store, queue, open, now, advance } = fixture();
	store.create({ ...scope, scheduleId: "legacy-irregular", name: "legacy", expression: "0,1,10 * * * *", timezone: "UTC", prompt: "Review", maxRuns: 3, nextRunAt: now().toISOString() });
	const reopened = open(), errors: unknown[] = [];
	const dispatcher = new CronDispatcher(reopened.store, reopened.queue, now, error => errors.push(error));
	for (let attempt = 0; attempt < 5; attempt++) {
		expect(dispatcher.dispatchDue()).toBe(0);
		advance();
	}
	expect(queue.list()).toHaveLength(0);
	expect(errors).toHaveLength(5);
	expect(open().store.get("legacy-irregular")).toMatchObject({ status: "failed", runCount: 0, failure: { code: "cron_frequency_below_five_minutes" } });
	expect(dispatcher.dispatchDue()).toBe(0);
	expect(errors).toHaveLength(5);
});
