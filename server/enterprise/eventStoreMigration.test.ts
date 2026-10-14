import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import { FileEnterpriseEventStore } from "./fileEventStore";
import { migrateEventStoreToSqlite } from "./eventStoreMigration";
import { SqliteEnterpriseEventStore } from "./sqliteEventStore";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const runA = { tenantId: "tenant-migrate", workspaceId: "workspace-migrate", runId: "run-a" };
const runB = { tenantId: "tenant-migrate", workspaceId: "workspace-migrate", runId: "run-b" };

function fixture(): { dir: string; source: string; target: string } {
	const dir = mkdtempSync(join(tmpdir(), "packx-event-migration-"));
	directories.push(dir);
	return { dir, source: join(dir, "events.json"), target: join(dir, "events.sqlite") };
}

function writeFileStore(source: string): void {
	const store = new FileEnterpriseEventStore(source, { now: () => new Date("2026-10-14T00:00:00.000Z"), nextId: (() => { let n = 0; return () => `evt-${++n}`; })() });
	store.append({ ...runA, expectedVersion: 0, commandId: "create-a", correlationId: "trace", actorId: "user", events: [{ data: { type: "run.created" } }] });
	store.append({ ...runB, expectedVersion: 0, commandId: "create-b", correlationId: "trace", actorId: "user", events: [{ data: { type: "run.created" } }], outbox: [{
		messageId: "message-b",
		topic: "stage-job.requested",
		payload: { ...runB, jobId: "job-b", stageId: "proposal", commandId: "job-command-b", correlationId: "trace", expectedVersion: 1, sessionId: "session-b" },
	}] });
}

describe("file to SQLite Event Store migration", () => {
	it("imports every aggregate and outbox message, keeps a checksummed backup, and leaves the source unchanged", () => {
		const { source, target } = fixture();
		writeFileStore(source);
		const before = readFileSync(source);

		const report = migrateEventStoreToSqlite(source, target, new Date("2026-10-14T03:00:00.000Z"));

		expect(report).toMatchObject({ events: 2, outbox: 1, runs: 2 });
		expect(readFileSync(source).equals(before)).toBe(true);
		expect(readFileSync(report.backup).equals(before)).toBe(true);
		expect(statSync(report.backup).mode & 0o777).toBe(0o600);

		const sqlite = new SqliteEnterpriseEventStore(target);
		const file = new FileEnterpriseEventStore(source);
		expect(sqlite.read(runA)).toEqual(file.read(runA));
		expect(sqlite.read(runB)).toEqual(file.read(runB));
		expect(sqlite.readPendingOutbox(10)).toEqual(file.readPendingOutbox(10));
		sqlite.close();
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	it("imports a schema v2 document that has no outbox", () => {
		const { source, target } = fixture();
		writeFileStore(source);
		const v3 = JSON.parse(readFileSync(source, "utf8")) as { events: Array<{ runId: string }> };
		writeFileSync(source, JSON.stringify({ schemaVersion: 2, events: v3.events.filter((event) => event.runId === "run-a") }));

		expect(migrateEventStoreToSqlite(source, target)).toMatchObject({ events: 1, outbox: 0, runs: 1 });
	});

	it("refuses to import into a database that already holds events", () => {
		const { source, target } = fixture();
		writeFileStore(source);
		migrateEventStoreToSqlite(source, target);

		expect(() => migrateEventStoreToSqlite(source, target)).toThrow(
			expect.objectContaining({ code: "concurrency_conflict" }) as Partial<EnterpriseKernelError>,
		);
	});

	it("fails before creating a target when the source is corrupt or missing", () => {
		const { dir, source, target } = fixture();
		writeFileSync(source, '{"schemaVersion":3,"events":[');

		expect(() => migrateEventStoreToSqlite(source, target)).toThrow(
			expect.objectContaining({ code: "event_store_corrupt" }) as Partial<EnterpriseKernelError>,
		);
		expect(existsSync(target)).toBe(false);
		expect(readdirSync(dir).some((name) => name.includes("migrated"))).toBe(false);
		expect(() => migrateEventStoreToSqlite(join(dir, "absent.json"), target)).toThrow("event_store_source_missing");
	});
});
