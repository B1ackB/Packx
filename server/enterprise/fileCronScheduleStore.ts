import { withFileWriteLock } from "../fileWriteLock";
import { syncDirectory } from "../syncDirectory";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	CronScheduleError,
	DurableCronScheduleStore,
	isCronSchedule,
	type CronSchedule,
	type CronScheduleStorage,
} from "../../src/enterprise/cronSchedule";

class FileCronScheduleStorage implements CronScheduleStorage {
	constructor(private readonly filePath: string) {}

	read(): CronSchedule[] {
		return structuredClone(this.load());
	}

	transaction<Value>(operation: (schedules: CronSchedule[]) => Value): Value {
		return this.withLock(() => {
			const current = this.load();
			const schedules = structuredClone(current);
			const result = operation(schedules);
			if (JSON.stringify(schedules) !== JSON.stringify(current)) this.write(schedules);
			return result;
		});
	}

	private load(): CronSchedule[] {
		if (!existsSync(this.filePath)) return [];
		try {
			const document = JSON.parse(readFileSync(this.filePath, "utf8")) as {
				schemaVersion?: unknown;
				schedules?: unknown;
			};
			if (document.schemaVersion !== 1 || !Array.isArray(document.schedules)) {
				throw new Error("invalid_cron_schedule_store");
			}
			const schedules = document.schedules.map((schedule) => {
				if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return schedule;
				const { conversationId: _legacyConversationId, ...current } = schedule as Record<string, unknown>;
				return current;
			});
			if (!schedules.every(isCronSchedule) ||
				new Set(schedules.map((schedule) => schedule.scheduleId)).size !== schedules.length) {
				throw new Error("invalid_cron_schedule_store");
			}
			return schedules;
		} catch (error) {
			throw new CronScheduleError("schedule_store_corrupt", "Cron Schedule Store cannot be decoded safely", { cause: error });
		}
	}

	private write(schedules: CronSchedule[]): void {
		mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporaryPath, `${JSON.stringify({ schemaVersion: 1, schedules })}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
				flush: true,
			});
			renameSync(temporaryPath, this.filePath);
			chmodSync(this.filePath, 0o600);
			syncDirectory(dirname(this.filePath));
		} catch (error) {
			if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
			throw new CronScheduleError("schedule_store_unavailable", "Cron Schedule Store write failed", { cause: error });
		}
	}

	private withLock<Value>(operation: () => Value): Value {
		try { return withFileWriteLock(this.filePath, operation); }
		catch (cause) {
			if (cause instanceof CronScheduleError) throw cause;
			throw new CronScheduleError("schedule_store_unavailable", "Persistent store is locked or unavailable", { cause });
		}
	}
}

export class FileCronScheduleStore extends DurableCronScheduleStore {
	constructor(filePath: string, now?: () => Date) {
		super(new FileCronScheduleStorage(filePath), now);
	}
}
