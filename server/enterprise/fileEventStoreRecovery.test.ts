import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { FileEnterpriseEventStore } from "./fileEventStore";

const directories: string[] = [];
const scope = { tenantId: "tenant-recovery", workspaceId: "workspace-recovery", runId: "run-recovery" };

function storePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "packx-event-recovery-"));
	directories.push(directory);
	return join(directory, "events.json");
}

function command(commandId: string, expectedVersion: number) {
	return { ...scope, commandId, correlationId: "trace-recovery", actorId: "user-recovery", expectedVersion };
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("file event store recovery", () => {
	it("upgrades a schema v2 document on the next committed write", () => {
		const filePath = storePath();
		const engine = new ProposalRunEngine(new FileEnterpriseEventStore(filePath));
		engine.create(command("create", 0));
		const v3 = JSON.parse(readFileSync(filePath, "utf8")) as { events: unknown[] };
		writeFileSync(filePath, JSON.stringify({ schemaVersion: 2, events: v3.events }));

		const before = new ProposalRunEngine(new FileEnterpriseEventStore(filePath)).load(scope);
		const started = new ProposalRunEngine(new FileEnterpriseEventStore(filePath)).startProposal(command("start", before.aggregateVersion));

		expect(before.aggregateVersion).toBe(1);
		expect(started.aggregateVersion).toBe(2);
		expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({ schemaVersion: 3, outbox: [] });
	});

	it("ignores an orphaned partial write left by a crash before the rename", () => {
		const filePath = storePath();
		const engine = new ProposalRunEngine(new FileEnterpriseEventStore(filePath));
		const created = engine.create(command("create", 0));
		writeFileSync(`${filePath}.4242.crashed.tmp`, '{"schemaVersion":3,"events":[{"trunc');

		const recovered = new ProposalRunEngine(new FileEnterpriseEventStore(filePath)).load(scope);

		expect(recovered).toEqual(created);
		expect(readFileSync(`${filePath}.4242.crashed.tmp`, "utf8")).toContain("trunc");
	});

	it("never deletes a file that already occupies its temporary write path", () => {
		const filePath = storePath();
		const engine = new ProposalRunEngine(new FileEnterpriseEventStore(filePath, { nextId: () => "collide" }));
		const created = engine.create(command("create", 0));
		const occupied = `${filePath}.${process.pid}.collide.tmp`;
		writeFileSync(occupied, "another writer's bytes");

		expect(() => engine.startProposal(command("start", created.aggregateVersion))).toThrow(EnterpriseKernelError);
		expect(readFileSync(occupied, "utf8")).toBe("another writer's bytes");
		expect(new ProposalRunEngine(new FileEnterpriseEventStore(filePath)).load(scope)).toEqual(created);
	});
});
