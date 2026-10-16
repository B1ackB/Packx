import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	DurableStageJobQueue,
	isStageJob,
	StageJobQueueError,
	type StageJob,
	type StageJobQueueOptions,
	type StageJobQueueStorage,
} from "../../src/enterprise/stageJobQueue";

interface QueueDocument {
	schemaVersion: 1;
	jobs: StageJob[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class FileStageJobQueueStorage implements StageJobQueueStorage {
	constructor(private readonly filePath: string) {}

	read(): StageJob[] {
		return structuredClone(this.load().jobs);
	}

	transaction<Value>(operation: (jobs: StageJob[]) => Value): Value {
		return this.withLock(() => {
			const document = this.load();
			const jobs = structuredClone(document.jobs);
			const result = operation(jobs);
			if (JSON.stringify(jobs) !== JSON.stringify(document.jobs)) {
				this.write({ schemaVersion: 1, jobs });
			}
			return result;
		});
	}

	private load(): QueueDocument {
		if (!existsSync(this.filePath)) return { schemaVersion: 1, jobs: [] };
		try {
			const value = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
			if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.jobs)) {
				throw new Error("invalid_stage_job_queue");
			}
			const jobs = value.jobs.map((job) => isRecord(job)
				? {
					...job,
					redriveCount: job.redriveCount ?? 0,
					totalFailureCount: job.totalFailureCount ?? job.failureCount ?? 0,
					recoveryCount: job.recoveryCount ?? 0,
					totalRecoveryDetectionDelayMs: job.totalRecoveryDetectionDelayMs ?? 0,
				}
				: job);
			if (!jobs.every(isStageJob)) throw new Error("invalid_stage_job_queue");
			const jobIds = new Set(jobs.map((job) => job.jobId));
			if (jobIds.size !== jobs.length) throw new Error("duplicate_stage_job_id");
			return { schemaVersion: 1, jobs };
		} catch (error) {
			throw new StageJobQueueError(
				"queue_corrupt",
				"Persistent Stage Job Queue cannot be decoded safely",
				{ cause: error },
			);
		}
	}

	private write(document: QueueDocument): void {
		const directory = dirname(this.filePath);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporaryPath, `${JSON.stringify(document)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			const handle = openSync(temporaryPath, "r+");
			try {
				fsyncSync(handle);
			} finally {
				closeSync(handle);
			}
			renameSync(temporaryPath, this.filePath);
			chmodSync(this.filePath, 0o600);
		} catch (error) {
			if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
			throw new StageJobQueueError(
				"queue_unavailable",
				"Persistent Stage Job Queue write failed",
				{ cause: error },
			);
		}
	}

	private withLock<Value>(operation: () => Value): Value {
		const lockPath = `${this.filePath}.lock`;
		mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
		try {
			mkdirSync(lockPath, { mode: 0o700 });
		} catch (error) {
			try {
				if (Date.now() - statSync(lockPath).mtimeMs <= 30_000) throw error;
				rmdirSync(lockPath);
				mkdirSync(lockPath, { mode: 0o700 });
			} catch (recoveryError) {
				throw new StageJobQueueError(
					"queue_unavailable",
					"Persistent Stage Job Queue is locked by another writer",
					{ cause: recoveryError },
				);
			}
		}
		try {
			return operation();
		} finally {
			rmdirSync(lockPath);
		}
	}
}

export class FileStageJobQueue extends DurableStageJobQueue {
	constructor(filePath: string, options: StageJobQueueOptions = {}) {
		super(new FileStageJobQueueStorage(filePath), options);
	}
}
