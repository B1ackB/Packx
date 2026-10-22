import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { EnterpriseEventStore } from "../../src/enterprise/contracts";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { InMemoryStageJobQueue, StageJobQueueError } from "../../src/enterprise/stageJobQueue";
import { FileEnterpriseEventStore } from "../enterprise/fileEventStore";
import { SqliteEnterpriseEventStore } from "../enterprise/sqliteEventStore";
import { StageJobOutbox } from "./stageJobOutbox";

const roots: string[] = [], databases: SqliteEnterpriseEventStore[] = [];
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const scope = { tenantId: "outbox-tenant", workspaceId: "outbox-workspace", runId: "outbox-run", actorId: "outbox-operator", correlationId: "outbox-correlation" };
function fixture(adapter: string) {
	const root = mkdtempSync(join(tmpdir(), "packx-outbox-")); roots.push(root);
	let time = Date.parse("2026-10-22T00:00:00Z");
	const options = { now: () => new Date(time) }, memory = new InMemoryEnterpriseEventStore(options);
	const open = (): EnterpriseEventStore => {
		if (adapter === "memory") return memory;
		if (adapter === "file") return new FileEnterpriseEventStore(join(root, "events.json"), options);
		const store = new SqliteEnterpriseEventStore(join(root, "events.sqlite"), options); databases.push(store); return store;
	};
	const store = open(), engine = new ProposalRunEngine(store), queue = new InMemoryStageJobQueue(options), outbox = new StageJobOutbox(engine, store, queue);
	engine.create({ ...scope, commandId: "create", expectedVersion: 0 });
	engine.startProposal({ ...scope, commandId: "start", expectedVersion: 1 });
	const message = outbox.requestProposal({ ...scope, commandId: "execute", expectedVersion: 2 });
	return { open, store, engine, queue, outbox, message, advance: () => { time += 60_000; } };
}

it.each(["memory", "file", "sqlite"])("bounds %s delivery failures, retains dead letters across restart and audits idempotent operator recovery", adapter => {
	const { store, open, queue, outbox, message, advance } = fixture(adapter);
	const unavailable = vi.spyOn(queue, "enqueue").mockImplementation(() => { throw new StageJobQueueError("queue_unavailable", "offline"); });
	for (let attempt = 1; attempt <= 5; attempt++) {
		expect(outbox.dispatchOne()).toMatchObject({ status: attempt < 5 ? "retry_scheduled" : "dead_letter", message: { deliveryCount: attempt, failureCount: attempt } });
		expect(outbox.dispatchOne()).toEqual({ status: "idle" }); advance();
	}
	const reopened = open(), dead = reopened.readOutbox(scope)[0];
	expect(dead).toMatchObject({ status: "dead_letter", failureCount: 5 });
	expect(reopened.readPendingOutbox(10)).toEqual([]);
	expect(reopened.readOutbox({ ...scope, tenantId: "other" })).toEqual([]);
	expect(() => reopened.markOutboxPublished(message.messageId)).toThrow();
	const request = { ...scope, requestId: "recover-1", expectedUpdatedAt: dead.updatedAt, reason: "Queue storage repaired" };
	expect(() => reopened.redriveOutbox(message.messageId, { ...request, workspaceId: "other" })).toThrow();
	expect(() => reopened.redriveOutbox(message.messageId, { ...request, expectedUpdatedAt: message.updatedAt })).toThrow();
	expect(reopened.redriveOutbox(message.messageId, request)).toMatchObject({ status: "pending", failureCount: 0, deliveryCount: 5, redrives: [{ actorId: scope.actorId, reason: request.reason }] });
	expect(reopened.redriveOutbox(message.messageId, request).redrives).toHaveLength(1);
	expect(() => reopened.redriveOutbox(message.messageId, { ...request, actorId: "other" })).toThrow();
	unavailable.mockRestore();
	const recovered = new StageJobOutbox(new ProposalRunEngine(reopened), reopened, queue);
	expect(recovered.dispatchOne()).toMatchObject({ status: "published", message: { deliveryCount: 6 } });
	// A lost operator response can be retried even after delivery without reopening it.
	expect(reopened.redriveOutbox(message.messageId, request).status).toBe("published");
	expect(recovered.dispatchOne()).toEqual({ status: "idle" });
	expect(queue.list()).toHaveLength(1);
	expect(store.readOutbox(scope)[0].status).toBe("published");
});

it.each(["invalid_job", "job_conflict"] as const)("dead-letters permanent %s without consuming five dispatch attempts", code => {
	const { queue, outbox, advance } = fixture("memory");
	const enqueue = vi.spyOn(queue, "enqueue").mockImplementation(() => { throw new StageJobQueueError(code, "operator review required"); });
	expect(outbox.dispatchOne()).toMatchObject({ status: "dead_letter", message: { deliveryCount: 1 } });
	advance(); expect(outbox.dispatchOne()).toEqual({ status: "idle" }); expect(enqueue).toHaveBeenCalledOnce();
});

it("recovers a lost Outbox ACK after reopening without adding a second queue job", () => {
	const { store, open, queue, outbox, advance } = fixture("file");
	vi.spyOn(store, "markOutboxPublished").mockImplementation(() => { throw new Error("ack_unavailable"); });
	expect(outbox.dispatchOne()).toMatchObject({ status: "retry_scheduled" });
	expect(queue.list()).toHaveLength(1);
	advance();
	const reopened = open();
	expect(new StageJobOutbox(new ProposalRunEngine(reopened), reopened, queue).dispatchOne()).toMatchObject({ status: "published" });
	expect(queue.list()).toHaveLength(1);
});

it.each(["memory", "file", "sqlite"])("rejects a stale %s recovery version when the clock has not advanced", adapter => {
	const { store, message } = fixture(adapter);
	const failure = { code: "job_conflict", message: "Review", delayMs: 0, retryable: false };
	const dead = store.markOutboxFailed(message.messageId, failure);
	const request = { ...scope, requestId: "cycle-one", expectedUpdatedAt: dead.updatedAt, reason: "Reviewed" };
	store.redriveOutbox(message.messageId, request);
	const next = store.markOutboxFailed(message.messageId, failure);
	expect(next.updatedAt).not.toBe(dead.updatedAt);
	expect(() => store.redriveOutbox(message.messageId, { ...request, requestId: "stale-cycle-two" })).toThrow();
});
