import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppendRequest, EnterpriseEventStore, OutboxDraft } from "../../src/enterprise/contracts";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import { FileEnterpriseEventStore } from "./fileEventStore";
import { SqliteEnterpriseEventStore } from "./sqliteEventStore";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const scope = { tenantId: "tenant-contract", workspaceId: "workspace-contract", runId: "run-contract" };

function makeStore(driver: "file" | "sqlite", clock: { now: Date }): { store: EnterpriseEventStore; reopen: () => EnterpriseEventStore } {
	const directory = mkdtempSync(join(tmpdir(), "packx-event-contract-"));
	directories.push(directory);
	let nextId = 0;
	const options = { now: () => clock.now, nextId: () => `id-${++nextId}` };
	if (driver === "file") {
		const path = join(directory, "events.json");
		return { store: new FileEnterpriseEventStore(path, options), reopen: () => new FileEnterpriseEventStore(path, options) };
	}
	const path = join(directory, "events.sqlite");
	const first = new SqliteEnterpriseEventStore(path, options);
	return {
		store: first,
		reopen: () => {
			first.close();
			return new SqliteEnterpriseEventStore(path, options);
		},
	};
}

function append(overrides: Partial<AppendRequest> = {}): AppendRequest {
	return {
		...scope,
		expectedVersion: 0,
		commandId: "create-contract",
		correlationId: "trace-contract",
		actorId: "user-contract",
		events: [{ data: { type: "run.created" } }],
		...overrides,
	};
}

function outbox(messageId: string, runId = scope.runId): OutboxDraft {
	return {
		messageId,
		topic: "stage-job.requested",
		payload: {
			...scope,
			runId,
			jobId: `job-${messageId}`,
			stageId: "proposal",
			commandId: `command-${messageId}`,
			correlationId: "trace-contract",
			expectedVersion: 1,
			sessionId: "session-contract",
		},
	};
}

for (const driver of ["file", "sqlite"] as const) {
	describe(`Enterprise Event Store contract: ${driver}`, () => {
		it("appends once, returns the original events on replay, and reconstructs after reopening", () => {
			const clock = { now: new Date("2026-10-14T00:00:00.000Z") };
			const { store, reopen } = makeStore(driver, clock);
			const created = store.append(append());
			const replay = store.append(append());

			expect(created).toMatchObject({ duplicate: false, events: [expect.objectContaining({ aggregateVersion: 1 })] });
			expect(replay).toEqual({ events: created.events, outbox: [], duplicate: true });
			expect(reopen().read(scope)).toEqual(created.events);
		});

		it("rejects a stale expected version without writing", () => {
			const clock = { now: new Date("2026-10-14T00:00:00.000Z") };
			const { store } = makeStore(driver, clock);
			store.append(append());

			expect(() => store.append(append({ expectedVersion: 0, commandId: "stale" }))).toThrow(
				expect.objectContaining({ code: "concurrency_conflict" }) as Partial<EnterpriseKernelError>,
			);
			expect(store.read(scope)).toHaveLength(1);
		});

		it("denies reads and appends from another tenant or workspace", () => {
			const clock = { now: new Date("2026-10-14T00:00:00.000Z") };
			const { store } = makeStore(driver, clock);
			store.append(append());

			expect(() => store.read({ ...scope, tenantId: "tenant-other" })).toThrow(
				expect.objectContaining({ code: "aggregate_access_denied" }) as Partial<EnterpriseKernelError>,
			);
			expect(() => store.append({ ...append({ expectedVersion: 1, commandId: "cross" }), workspaceId: "workspace-other" })).toThrow(
				expect.objectContaining({ code: "aggregate_access_denied" }) as Partial<EnterpriseKernelError>,
			);
		});

		it("publishes, delays and redelivers outbox messages on the same schedule", () => {
			const clock = { now: new Date("2026-10-14T00:00:00.000Z") };
			const { store } = makeStore(driver, clock);
			store.append(append({ outbox: [outbox("message-1"), outbox("message-2")] }));

			expect(store.readPendingOutbox(10).map((message) => message.messageId)).toEqual(["message-1", "message-2"]);
			store.markOutboxFailed("message-1", { code: "dispatch_failed", message: "retry later", delayMs: 60_000 });
			expect(store.readPendingOutbox(10).map((message) => message.messageId)).toEqual(["message-2"]);

			clock.now = new Date("2026-10-14T00:01:00.000Z");
			expect(store.readPendingOutbox(10).map((message) => message.messageId)).toEqual(["message-1", "message-2"]);
			expect(store.markOutboxPublished("message-1")).toMatchObject({ status: "published", deliveryCount: 2 });
			expect(store.readPendingOutbox(10).map((message) => message.messageId)).toEqual(["message-2"]);
		});

		it("rejects duplicate outbox identifiers, unknown messages and invalid failures", () => {
			const clock = { now: new Date("2026-10-14T00:00:00.000Z") };
			const { store } = makeStore(driver, clock);
			store.append(append({ outbox: [outbox("message-dup")] }));

			expect(() => store.append(append({ expectedVersion: 1, commandId: "dup", outbox: [outbox("message-dup")] }))).toThrow(
				expect.objectContaining({ code: "concurrency_conflict" }) as Partial<EnterpriseKernelError>,
			);
			expect(() => store.markOutboxPublished("missing")).toThrow(EnterpriseKernelError);
			expect(() => store.markOutboxFailed("message-dup", { code: "bad code!", message: "x", delayMs: 0 })).toThrow(EnterpriseKernelError);
			expect(() => store.readPendingOutbox(0)).toThrow(EnterpriseKernelError);
		});
	});
}
