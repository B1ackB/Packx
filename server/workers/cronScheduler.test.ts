import { describe, expect, it } from "vitest";
import { InMemoryCronScheduleStore, type CronScheduleStore } from "../../src/enterprise/cronSchedule";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { CronDispatcher, validateCronFrequency } from "./cronScheduler";

describe("CronDispatcher", () => {
	it("uses timezone-aware Cron parsing and rejects sub-five-minute schedules", () => {
		expect(validateCronFrequency("*/5 * * * *", "Asia/Hong_Kong", new Date("2026-09-03T00:00:00Z")))
			.toEqual(new Date("2026-09-03T00:05:00Z"));
		expect(() => validateCronFrequency("* * * * *", "UTC", new Date("2026-09-03T00:00:00Z")))
			.toThrow("cron_frequency_below_five_minutes");
	});

	it("replays the same occurrence after a crash between enqueue and schedule ACK", () => {
		let now = new Date("2026-09-03T00:05:00.000Z");
		const store = new InMemoryCronScheduleStore(() => now);
		store.create({
			tenantId: "tenant-cron-dispatch",
			workspaceId: "workspace-cron-dispatch",
			runId: "conversation-cron-dispatch",
			scheduleId: "schedule-cron-dispatch",
			name: "five-minute-check",
			expression: "*/5 * * * *",
			timezone: "UTC",
			prompt: "check status",
			actorId: "agent:user-cron-dispatch",
			maxRuns: 1,
			nextRunAt: now.toISOString(),
		});
		const queue = new InMemoryStageJobQueue({ now: () => now });
		let crash = true;
		const crashOnce = new Proxy(store as CronScheduleStore, {
			get(target, property, receiver) {
				if (property !== "acknowledge") return Reflect.get(target, property, receiver);
				return (...parameters: Parameters<CronScheduleStore["acknowledge"]>) => {
					if (crash) {
						crash = false;
						throw new Error("injected_crash_after_enqueue");
					}
					return target.acknowledge(...parameters);
				};
			},
		});
		const dispatcher = new CronDispatcher(crashOnce, queue, () => now);

		expect(() => dispatcher.dispatchDue()).toThrow("Cron dispatch failed");
		expect(queue.list()).toHaveLength(1);
		now = new Date(now.getTime() + 1_000);
		expect(dispatcher.dispatchDue()).toBe(1);
		expect(queue.list()).toHaveLength(1);
		expect(store.get("schedule-cron-dispatch")).toMatchObject({ status: "active", runCount: 1, pendingJobId: queue.list()[0].jobId });
		queue.ack(queue.claim("worker", 10_000)!);
		expect(dispatcher.dispatchDue()).toBe(0);
		expect(store.get("schedule-cron-dispatch")).toMatchObject({ status: "completed", runCount: 1 });
	});

	it.each(["0,1,10 * * * *", "0,30 0,10 * * * *"])("rejects later short intervals in %s", expression => {
		expect(() => validateCronFrequency(expression, "UTC", new Date("2026-10-23T10:02:00Z"), 3))
			.toThrow("cron_frequency_below_five_minutes");
	});

	it("checks the authorized horizon and the prior occurrence when resuming", () => {
		const now = new Date("2026-10-23T10:02:00Z");
		expect(validateCronFrequency("*/5 * * * *", "UTC", now, 100)).toEqual(new Date("2026-10-23T10:05:00Z"));
		expect(() => validateCronFrequency("* * * * *", "UTC", now, 1)).toThrow("cron_frequency_below_five_minutes");
		for (const count of [0, 101, 1.5]) expect(() => validateCronFrequency("*/5 * * * *", "UTC", now, count)).toThrow("invalid_cron_run_limit");
		expect(() => validateCronFrequency("*/5 * * * *", "UTC", now, 2, "2026-10-23T10:01:00Z")).toThrow("cron_frequency_below_five_minutes");
		expect(() => validateCronFrequency("2026-10-24T00:00:00", "UTC", now, 2)).toThrow("cron_has_no_next_run");
	});
});
