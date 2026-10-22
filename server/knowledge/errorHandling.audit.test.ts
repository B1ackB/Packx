import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { coffeeKnowledgeFixtures } from "../../src/manufacturing/knowledgeFixtures";
import { StageJobScheduler } from "../workers/stageJobScheduler";
import { FakeEmbedding, type EmbeddingPort } from "./embedding";
import { KnowledgeService } from "./service";
import { KnowledgeStore } from "./store";

it.each(["cancel", "timeout", "delayed_timer"] as const)("rejects late indexing results after %s and releases the worker", async (stop) => {
	vi.useFakeTimers();
	const clock = vi.spyOn(performance, "now").mockReturnValue(0);
	const deadline = new AbortController();
	const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
	const root = mkdtempSync(join(tmpdir(), "packx-index-error-audit-"));
	const scope = { tenantId: "audit-tenant", workspaceId: "audit-workspace" };
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const baseline = new FakeEmbedding();
	const embed = vi.fn<EmbeddingPort["embed"]>(async (texts) => { await gate; return baseline.embed(texts); });
	const store = new KnowledgeStore(root, { ...baseline, embed });
	const queue = new InMemoryStageJobQueue();
	const service = new KnowledgeService(store, queue);
	const scheduler = new StageJobScheduler(queue, { workerId: "audit-worker", handlers: {
		"knowledge-import": (lease, signal, assertActive) => service.execute(lease, signal, assertActive),
		"audit-next": async () => ({ status: "completed" }),
	} });
	let pending: Promise<unknown> | undefined;
	try {
		const doc = store.import(scope, coffeeKnowledgeFixtures()[0], "audit-user");
		service.reconcile(scope);
		const job = queue.list()[0];
		let settled = false;
		pending = scheduler.runNext().then((result) => { settled = true; return result; });
		await vi.advanceTimersByTimeAsync(0);
		expect(embed).toHaveBeenCalledOnce();
		if (stop === "cancel") scheduler.cancel(job.jobId, { ...scope, runId: job.runId });
		else if (stop === "timeout") deadline.abort(new DOMException("Indexing deadline exceeded", "TimeoutError"));
		else clock.mockReturnValue(120_001);
		await vi.advanceTimersByTimeAsync(0);
		const stoppedBeforeEmbeddingReturned = settled;
		release();
		await expect(pending).resolves.toMatchObject(stop === "cancel" ? { status: "cancelled" } : {
			status: "retry_scheduled", job: { failureCount: 1, lastFailure: { code: "timeout", retryable: true } },
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(stoppedBeforeEmbeddingReturned).toBe(stop !== "delayed_timer");
		if (stop === "timeout") expect(timeout).toHaveBeenCalledWith(120_000);
		expect(store.get(scope, doc.versionId)?.status).toBe("parsed");
		expect(store.audit(scope).some((event) => event.type === "knowledge.indexed")).toBe(false);
		expect((await store.search(scope, { query: "coffee", mode: "keyword" })).hits).toEqual([]);
		queue.enqueue({ ...scope, runId: "audit-next", stageId: "audit-next", jobId: "audit-next", sessionId: "audit-next", commandId: "audit-next", correlationId: "audit-next", expectedVersion: 0 });
		await expect(scheduler.runNext()).resolves.toMatchObject({ status: "completed", job: { jobId: "audit-next" } });
	} finally {
		release();
		await pending;
		scheduler.stop();
		store.close();
		rmSync(root, { recursive: true, force: true });
		vi.useRealTimers();
		timeout.mockRestore();
		clock.mockRestore();
	}
});
