import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StageJobQueueError } from "../../src/enterprise/stageJobQueue";
import { FileStageJobQueue } from "./fileStageJobQueue";

const temporaryDirectories: string[] = [];

function createPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "blackx-stage-jobs-"));
	temporaryDirectories.push(directory);
	return join(directory, "jobs.json");
}

function input() {
	return {
		tenantId: "tenant-file",
		workspaceId: "workspace-file",
		runId: "run-file",
		stageId: "proposal",
		jobId: "job-file",
		commandId: "command-file",
		correlationId: "trace-file",
		expectedVersion: 2,
		sessionId: "session-file",
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("FileStageJobQueue", () => {
	it("recovers queued work after process-object reconstruction", () => {
		const path = createPath();
		new FileStageJobQueue(path).enqueue(input());
		const recovered = new FileStageJobQueue(path).claim("worker-file", 1_000);

		expect(recovered).toMatchObject({ jobId: "job-file", status: "leased" });
		expect(new FileStageJobQueue(path).ack(recovered!).status).toBe("completed");
	});

	it("persists the Session continuation before another worker claims the next slice", () => {
		const path = createPath();
		const firstQueue = new FileStageJobQueue(path);
		firstQueue.enqueue(input());
		const firstLease = firstQueue.claim("worker-a", 1_000)!;
		firstQueue.checkpoint(firstLease, {
			sessionId: "session-file",
			contextSnapshotId: "context-file-a",
		});

		const nextLease = new FileStageJobQueue(path).claim("worker-b", 1_000);
		expect(nextLease).toMatchObject({
			leaseOwner: "worker-b",
			sessionId: "session-file",
			lastContextSnapshotId: "context-file-a",
			sliceCount: 1,
		});
	});

	it("fails closed for a corrupt queue document", () => {
		const path = createPath();
		writeFileSync(path, "{\"schemaVersion\":1,\"jobs\":[{}]}\n", { mode: 0o600 });
		chmodSync(path, 0o600);
		expect(() => new FileStageJobQueue(path).list()).toThrowError(
			expect.objectContaining<Partial<StageJobQueueError>>({ code: "queue_corrupt" }),
		);
	});

	it("preserves legacy locks whose owner cannot be proven dead", () => {
		const path = createPath();
		mkdirSync(`${path}.lock`);
		const stale = new Date(Date.now() - 31_000);
		utimesSync(`${path}.lock`, stale, stale);

		expect(() => new FileStageJobQueue(path).enqueue(input())).toThrow(expect.objectContaining({ code: "queue_unavailable" }));
		expect(new FileStageJobQueue(path).list()).toEqual([]);
	});
});
