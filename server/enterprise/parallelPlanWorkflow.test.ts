import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentPlanStore } from "./agentPlanStore";
import { planInputDependencies } from "./planInputDependencies";
import { AgentPlanWorkflow, type PlanWorkflowOptions } from "./agentPlanWorkflow";
import { FileStageJobQueue } from "./fileStageJobQueue";
import { StageJobScheduler } from "../workers/stageJobScheduler";
import { PLAN_LIMITS, PlanError, type PlanSpec } from "../../src/enterprise/agentPlan";
import { RuntimeFailure, type AgentRuntimePort, type RuntimeTurnRequest, type RuntimeTurnResult } from "../../src/runtime/contracts";

const scope = { tenantId: "parallel", workspaceId: "workspace", runId: "conversation" };
const graph: PlanSpec = { summary: "Read independent sources and join only declared reports", tasks: [
	{ title: "Join", objective: "JOIN", tools: [], dependsOn: [1, 2] },
	{ title: "A", objective: "SOURCE_A", tools: ["file_read"] },
	{ title: "B", objective: "SOURCE_B", tools: [] },
] };
const result = { summary: "unverified", evidence: ["fixture-source"], limitations: ["Fixed fixture only"], assessment: { decision: "continue", reason: "Source review finished" } };
function response(request: RuntimeTurnRequest, value: unknown = result): RuntimeTurnResult {
	return { adapter: "fake", status: "completed", executionId: request.idempotencyKey, finalResponse: JSON.stringify(value), events: [] };
}
function gate() { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; }
const cleanup: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) close(); });

function harness(worker: (request: RuntimeTurnRequest, signal?: AbortSignal) => Promise<RuntimeTurnResult>, spec = graph, extra: Partial<PlanWorkflowOptions> = {}) {
	const directory = mkdtempSync(join(tmpdir(), "packx-parallel-"));
	cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "plans.sqlite"), queuePath = join(directory, "queue.json");
	const store = new AgentPlanStore(path); cleanup.push(() => store.close());
	let time = Date.parse("2026-10-19T00:00:00Z"), context = "selected-source-version:1", id = 0;
	const queue = new FileStageJobQueue(queuePath, { now: () => new Date(time) });
	const requests: RuntimeTurnRequest[] = [], signals: AbortSignal[] = [];
	const runtime: AgentRuntimePort = { async health() { return { adapter: "fake", online: false }; }, async executeTurn(request, signal) {
		requests.push(request); if (signal) signals.push(signal);
		return request.stageId === "plan" ? response(request, spec) : worker(request, signal);
	} };
	const options: PlanWorkflowOptions = {
		readInput: () => ({ revision: 1, context }), readTools: ["file_read"], executionTools: ["file_read", "file_write"], instructions: [], maxReadConcurrency: 2,
		cancelJob: (jobId, target) => { scheduler.cancel(jobId, target); }, ...extra,
	};
	const workflow = new AgentPlanWorkflow(store, queue, runtime, options);
	const scheduler = new StageJobScheduler(queue, { workerId: "test", handlers: { "plan-subagents": (lease, signal, check) => workflow.execute(lease, signal, check) }, dispatchOutbox: () => workflow.reconcile() });
	const command = (body: Record<string, unknown>) => workflow.command(scope, "user", { revision: store.read(scope).revision, requestId: `test-${++id}`, version: 1, ...body });
	const start = async () => { command({ action: "mode", mode: "plan" }); command({ action: "generate", objective: "Review selected packaging sources" }); await scheduler.runNext(); command({ action: "confirm", confirmed: true }); };
	return { store, path, queue, queuePath, runtime, options, workflow, scheduler, requests, signals, command, start, plan: () => store.read(scope).versions[0], revoke: () => { context = "selected-source-version:withdrawn"; }, advance: () => { time += 200_000; } };
}

it("overlaps two independent nodes, persists reservations, fences duplicate delivery and joins in dependency order", async () => {
	const a = gate(), b = gate();
	const h = harness(async (request) => { const input = JSON.parse(request.input); if (input.objective === "SOURCE_A") await a.wait; if (input.objective === "SOURCE_B") await b.wait; return response(request, { ...result, summary: input.objective }); });
	await h.start();
	expect(h.plan().readConcurrency).toBe(2); expect(h.requests).toHaveLength(1);
	const pending = h.scheduler.runNext();
	await vi.waitFor(() => expect(h.plan().taskRuns?.filter((r) => r.status === "running")).toHaveLength(2));
	expect(h.plan().calls).toBe(3);
	h.workflow.reconcile(); h.workflow.reconcile(); expect(h.queue.list().filter((j) => j.status === "leased")).toHaveLength(1);
	const lease = h.queue.list().find((job) => job.status === "leased")!;
	await h.workflow.execute(lease as import("../../src/enterprise/stageJobQueue").StageJobLease, new AbortController().signal, () => {});
	expect(h.requests).toHaveLength(3);
	b.release(); await vi.waitFor(() => expect(h.plan().children.map((c) => c.taskIndex)).toEqual([2]));
	expect(h.requests.some((r) => r.stageId === "subagent-0")).toBe(false);
	a.release(); await pending; await h.scheduler.runNext();
	expect(h.plan().status).toBe("completed"); expect(h.plan().children.map((c) => c.taskIndex)).toEqual([2, 1, 0]);
	const workers = h.requests.slice(1); expect(new Set(workers.map((r) => r.sessionId)).size).toBe(3);
	expect(workers.every((r) => r.policy.sandboxMode === "read-only" && r.policy.approvalPolicy === "never")).toBe(true);
	expect(workers[0].input).not.toContain("dependencies"); expect(workers[1].input).not.toContain("dependencies");
	expect(JSON.parse(workers[2].input).dependencies.map((d: { taskIndex: number }) => d.taskIndex)).toEqual([1, 2]);
	await h.scheduler.runNext(); expect(h.requests).toHaveLength(4);
});

it("admits at most two of three independent nodes and keeps undeclared results out of a downstream context", async () => {
	const wait = gate();
	const spec = { ...graph, tasks: [{ ...graph.tasks[0], dependsOn: [3] }, graph.tasks[1], graph.tasks[2], { title: "C", objective: "SOURCE_C", tools: [] }] };
	const h = harness(async (request) => { if (request.stageId === "subagent-1" || request.stageId === "subagent-2") await wait.wait; return response(request); }, spec);
	await h.start(); const pending = h.scheduler.runNext();
	await vi.waitFor(() => expect(h.requests).toHaveLength(3));
	expect(h.requests.some((r) => r.stageId === "subagent-3")).toBe(false);
	wait.release(); await pending; await h.scheduler.runNext(); await h.scheduler.runNext();
	expect(h.plan().status).toBe("completed");
	expect(JSON.parse(h.requests.at(-1)!.input).dependencies.map((d: { taskIndex: number }) => d.taskIndex)).toEqual([3]);
});

it("retains a successful sibling, stops descendants on failure, and explicitly retries only remaining work", async () => {
	const fail = gate(); let retry = false;
	const h = harness(async (request) => { if (request.stageId === "subagent-2" && !retry) { await fail.wait; throw new RuntimeFailure("rate_limit", "limited", true); } return response(request); });
	await h.start(); const pending = h.scheduler.runNext();
	await vi.waitFor(() => expect(h.plan().children.map((c) => c.taskIndex)).toEqual([1]));
	fail.release(); await pending;
	expect(h.plan()).toMatchObject({ status: "failed", failure: { code: "rate_limit", retryable: true } });
	expect(h.plan().taskRuns?.find((r) => r.taskIndex === 2)?.status).toBe("failed");
	expect(h.requests.some((r) => r.stageId === "subagent-0")).toBe(false);
	retry = true; h.command({ action: "resume" }); await h.scheduler.runNext(); await h.scheduler.runNext();
	expect(h.plan().status).toBe("completed");
	expect(h.requests.filter((r) => r.stageId === "subagent-1")).toHaveLength(1);
	const retried = h.requests.filter((r) => r.stageId === "subagent-2"); expect(retried).toHaveLength(2); expect(retried[0].sessionId).not.toBe(retried[1].sessionId);
});

it.each(["pause", "cancel"])("propagates %s to both workers and rejects late results without waiting for an uncooperative adapter", async (action) => {
	const slow = gate(); let resume = false;
	const h = harness(async (request) => { if (!resume) await slow.wait; return response(request); });
	await h.start(); const pending = h.scheduler.runNext(); await vi.waitFor(() => expect(h.requests).toHaveLength(3));
	h.command({ action }); await pending;
	expect(h.signals.slice(1).every((s) => s.aborted)).toBe(true);
	expect(h.plan().taskRuns?.every((r) => r.status === "interrupted")).toBe(true);
	expect(h.plan().children).toHaveLength(0);
	if (action === "pause") { resume = true; h.command({ action: "resume" }); await h.scheduler.runNext(); await h.scheduler.runNext(); expect(h.plan().status).toBe("completed"); }
	const before = h.store.read(scope); slow.release(); await new Promise(resolve => setTimeout(resolve, 5));
	expect(h.store.read(scope)).toEqual(before);
});

it("withdraws the source during a wave, aborts its sibling and prohibits retrying stale confirmation", async () => {
	const slow = gate(); const h = harness(async (request) => { await slow.wait; return response(request); });
	await h.start(); const pending = h.scheduler.runNext(); await vi.waitFor(() => expect(h.requests).toHaveLength(3));
	h.revoke(); slow.release(); await pending;
	expect(h.plan()).toMatchObject({ status: "failed", children: [], failure: { code: "plan_sources_changed", retryable: false } });
	expect(h.signals.slice(1).every((s) => s.aborted)).toBe(true);
	expect(() => h.command({ action: "resume" })).toThrow("plan_requires_revision");
	expect(h.requests).toHaveLength(3);
});

it("reconciles changed sources while both adapters are blocked, cancels their lease and fences late replies", async () => {
	const slow = gate();
	const h = harness(async (request) => { await slow.wait; return response(request); });
	await h.start(); const pending = h.scheduler.runNext();
	await vi.waitFor(() => expect(h.requests).toHaveLength(3));
	h.queue.enqueue({ ...scope, jobId: "legacy-plan-copy", stageId: "plan-subagents", commandId: "legacy-copy", correlationId: "legacy-copy", sessionId: "legacy-session", expectedVersion: 1, payload: { version: 1, generation: h.plan().generation } });
	try {
		h.revoke(); h.workflow.reconcile();
		expect(h.plan()).toMatchObject({ status: "failed", calls: 3, children: [], failure: { code: "plan_sources_changed", retryable: false } });
		expect(h.signals.slice(1).every((signal) => signal.aborted)).toBe(true);
		expect(h.queue.list().filter(job => job.payload?.generation === h.plan().generation).map(job => job.status)).toEqual(["cancelled", "cancelled"]);
		await pending;
		const before = h.store.read(scope);
		h.workflow.reconcile(); h.workflow.reconcile();
		expect(h.store.read(scope)).toEqual(before);
		expect(() => h.command({ action: "resume" })).toThrow("plan_requires_revision");
		slow.release(); await Promise.resolve();
		expect(h.store.read(scope)).toEqual(before);
	} finally {
		if (["queued", "running"].includes(h.plan().status)) h.command({ action: "cancel" });
		slow.release(); await pending;
	}
});

it("keeps a successful sibling as history when a changed source stops its blocked sibling", async () => {
	const slow = gate();
	const h = harness(async (request) => { if (request.stageId === "subagent-2") await slow.wait; return response(request); });
	await h.start(); const pending = h.scheduler.runNext();
	await vi.waitFor(() => expect(h.plan().children.map(child => child.taskIndex)).toEqual([1]));
	h.revoke(); h.workflow.dispatch(scope); await pending;
	expect(h.plan()).toMatchObject({ status: "failed", calls: 3, failure: { code: "plan_sources_changed", retryable: false } });
	expect(h.plan().children.map(child => child.taskIndex)).toEqual([1]);
	expect(h.plan().taskRuns?.map(run => run.status)).toEqual(["completed", "interrupted"]);
	h.command({ action: "replan" }); await h.scheduler.runNext();
	const revised = h.store.read(scope).versions.at(-1)!;
	expect(revised).toMatchObject({ version: 2, status: "awaiting_confirmation", replanFromVersion: 1, context: "selected-source-version:withdrawn", children: [] });
	expect(revised.approval).toBeUndefined();
	const before = h.store.read(scope); slow.release(); await Promise.resolve();
	expect(h.store.read(scope)).toEqual(before);
});

it("repairs a persisted source invalidation whose queue cancellation failed before restart", async () => {
	const h = harness(async request => response(request)); await h.start();
	const cancel = h.options.cancelJob!;
	h.revoke(); h.options.cancelJob = () => { throw new PlanError("queue_unavailable", 503); };
	expect(() => h.workflow.dispatch(scope)).toThrow("queue_unavailable");
	expect(h.plan()).toMatchObject({ status: "failed", calls: 1, failure: { code: "plan_sources_changed", retryable: false } });
	const before = h.store.read(scope);
	const reopened = new AgentPlanStore(h.path); cleanup.push(() => reopened.close());
	const queue = new FileStageJobQueue(h.queuePath);
	const workflow = new AgentPlanWorkflow(reopened, queue, h.runtime, { ...h.options, cancelJob: cancel });
	workflow.reconcile(); workflow.reconcile();
	expect(reopened.read(scope)).toEqual(before);
	expect(queue.list().filter(job => job.payload?.generation === h.plan().generation).map(job => job.status)).toEqual(["cancelled"]);
	expect(h.requests).toHaveLength(1);
});

it("does not classify an unavailable context store as revoked sources or cancel its workers", async () => {
	const slow = gate(), h = harness(async request => { await slow.wait; return response(request); });
	await h.start(); const pending = h.scheduler.runNext();
	await vi.waitFor(() => expect(h.requests).toHaveLength(3));
	const read = h.options.readInput, before = h.store.read(scope);
	try {
		h.options.readInput = () => { throw new PlanError("context_store_unavailable", 503); };
		expect(() => h.workflow.reconcile()).toThrow(AggregateError);
		expect(h.store.read(scope)).toEqual(before);
		expect(h.signals.slice(1).some(signal => signal.aborted)).toBe(false);
	} finally {
		h.options.readInput = read; h.command({ action: "cancel" }); slow.release(); await pending;
	}
});

it("invalidates only the requested scope and leaves another confirmed graph untouched", async () => {
	const slow = gate(), other = { ...scope, runId: "other-conversation" };
	const contexts = new Map([[scope.runId, "source:original"], [other.runId, "source:other"]]);
	const h = harness(async request => { await slow.wait; return response(request); }, graph, { readInput: target => ({ revision: 1, context: contexts.get(target.runId)! }) });
	await h.start();
	const copy = structuredClone(h.plan()); copy.context = "source:other";
	h.store.change(other, "fixture", "fixture", "host", "fixture", 0, state => { state.mode = "plan"; state.versions = [copy]; });
	h.advance(); h.workflow.dispatch(other);
	const otherState = h.store.read(other), otherJob = h.queue.list().find(job => job.runId === other.runId);
	const pending = h.scheduler.runNext(); await vi.waitFor(() => expect(h.requests).toHaveLength(3));
	contexts.set(scope.runId, "source:changed"); h.workflow.dispatch(scope); await pending;
	expect(h.plan().failure?.code).toBe("plan_sources_changed");
	expect(h.store.read(other)).toEqual(otherState);
	expect(h.queue.get(otherJob!.jobId)).toEqual(otherJob);
	slow.release();
});

it("rechecks sources before dispatch and rechecks the read-only whitelist without consuming worker budget", async () => {
	const h = harness(async (request) => response(request)); await h.start(); h.revoke(); await h.scheduler.runNext();
	expect(h.requests).toHaveLength(1); expect(h.plan()).toMatchObject({ calls: 1, status: "failed", failure: { code: "plan_sources_changed" } });
	const other = harness(async (request) => response(request)); await other.start(); other.options.readTools = [];
	await other.scheduler.runNext(); expect(other.requests).toHaveLength(1); expect(other.plan().failure?.code).toBe("plan_readonly_required");
});

it("keeps a plan containing a write tool serial and retains separate file approval", async () => {
	const h = harness(async (request) => response(request), { ...graph, tasks: [{ ...graph.tasks[1], tools: ["file_write"] }, graph.tasks[2]] });
	await h.start(); expect(h.plan().readConcurrency).toBeUndefined();
	await h.scheduler.runNext(); expect(h.requests).toHaveLength(2);
	expect(h.requests[1].policy).toMatchObject({ sandboxMode: "workspace-write", approvalPolicy: "required" });
});

it("reopens between slices, preserves a completed sibling and resumes a checkpoint with the same Session/key", async () => {
	let paused = false;
	const h = harness(async (request) => {
		if (request.stageId === "subagent-2" && !paused) { paused = true; return { ...response(request), status: "paused", finalResponse: "" }; }
		return response(request);
	});
	await h.start(); await h.scheduler.runNext();
	expect(h.plan().children.map((c) => c.taskIndex)).toEqual([1]);
	expect(h.plan().taskRuns?.find((r) => r.taskIndex === 2)?.status).toBe("paused");
	const store = new AgentPlanStore(h.path); cleanup.push(() => store.close());
	const queue = new FileStageJobQueue(h.queuePath);
	const workflow = new AgentPlanWorkflow(store, queue, h.runtime, h.options);
	const scheduler = new StageJobScheduler(queue, { workerId: "reopened", handlers: { "plan-subagents": (l, s, c) => workflow.execute(l, s, c) }, dispatchOutbox: () => workflow.reconcile() });
	await scheduler.runNext(); await scheduler.runNext();
	expect(store.read(scope).versions[0].status).toBe("completed");
	expect(h.requests.filter((r) => r.stageId === "subagent-1")).toHaveLength(1);
	const continued = h.requests.filter((r) => r.stageId === "subagent-2");
	expect(continued).toHaveLength(2); expect(continued[1]).toEqual(continued[0]);
	expect(store.read(scope).versions[0].calls).toBe(5);
});

it("reserves the last shared call slot once and never refunds failed or uncertain attempts", async () => {
	const h = harness(async (request) => response(request)); await h.start();
	h.store.change(scope, "near-limit", "limit", "host", "fixture", h.store.read(scope).revision, (s) => { s.versions[0].calls = PLAN_LIMITS.calls - 1; });
	await h.scheduler.runNext(); expect(h.requests).toHaveLength(2); expect(h.plan().calls).toBe(PLAN_LIMITS.calls);
	await h.scheduler.runNext(); expect(h.requests).toHaveLength(2);
	expect(h.plan()).toMatchObject({ status: "failed", failure: { code: "plan_budget_exceeded" }, children: [{ taskIndex: 1 }] });
});

it("times out both unresponsive nodes, stops the wave and fences provider replies arriving after the deadline", async () => {
	const wait = gate(), h = harness(async (request) => { await wait.wait; return response(request); });
	await h.start(); vi.useFakeTimers(); const pending = h.scheduler.runNext();
	await vi.advanceTimersByTimeAsync(PLAN_LIMITS.timeoutMs); await pending;
	expect(h.plan()).toMatchObject({ status: "failed", children: [], failure: { code: "timeout", retryable: true } });
	const before = h.store.read(scope); wait.release(); await Promise.resolve(); expect(h.store.read(scope)).toEqual(before);
});

it.each(["completed", "missing", "uncertain"])("reopens durable state and reconciles %s execution evidence under a new lease", async (evidence) => {
	const h = harness(async (request) => response(request)); await h.start();
	const lease = h.queue.claim("crashed", 1000)!;
	// Crash after reserving both workers, before the coordinator records either receipt.
	h.store.change(scope, "crash-window", "reserved", "host", "subagent.started", h.store.read(scope).revision, (s) => {
		const plan = s.versions[0]; plan.status = "running"; plan.calls += 2;
		plan.taskRuns = [1, 2].map((taskIndex) => ({ taskIndex, attempt: 1, generation: plan.generation, jobId: lease.jobId, leaseId: lease.leaseId, sessionId: `saved-${taskIndex}`, idempotencyKey: `saved-key-${taskIndex}`, status: "running", startedAt: "2026-10-19T00:00:00Z" }));
	});
	// Existing queue deliberately dead-letters a lost graph lease; explicit Resume
	// is required, so no unknown model charge is silently replayed after a restart.
	h.advance(); expect(h.queue.claim("detect-expiry", 1000)).toBeUndefined();
	const reopened = new AgentPlanStore(h.path); cleanup.push(() => reopened.close());
	const queue = new FileStageJobQueue(h.queuePath), recovered: string[] = [];
	const workflow = new AgentPlanWorkflow(reopened, queue, h.runtime, { ...h.options, recoverResult: (_target, sessionId, key) => {
		if (!sessionId.startsWith("saved-")) return undefined;
		recovered.push(key);
		if (evidence === "uncertain") throw new PlanError("plan_completion_evidence_missing");
		return evidence === "completed" ? { adapter: "fake", status: "completed", sessionId, executionId: key, finalResponse: JSON.stringify(result), events: [] } : undefined;
	} });
	const scheduler = new StageJobScheduler(queue, { workerId: "restarted", handlers: { "plan-subagents": (l, s, c) => workflow.execute(l, s, c) }, dispatchOutbox: () => workflow.reconcile() });
	workflow.reconcile(); expect(reopened.read(scope).versions[0]).toMatchObject({ status: "failed", failure: { code: "plan_job_failed", retryable: true } });
	workflow.command(scope, "user", { action: "resume", version: 1, requestId: "restart-resume", revision: reopened.read(scope).revision });
	workflow.reconcile(); workflow.reconcile();
	await scheduler.runNext(); await scheduler.runNext();
	const plan = reopened.read(scope).versions[0];
	expect(recovered.length).toBeGreaterThan(0);
	if (evidence === "uncertain") { expect(plan).toMatchObject({ status: "failed", failure: { code: "plan_completion_evidence_missing", retryable: false } }); expect(h.requests).toHaveLength(1); }
	else {
		expect(plan.status).toBe("completed"); expect(plan.children).toHaveLength(3);
		expect(h.requests.length).toBe(evidence === "completed" ? 2 : 4);
		expect(plan.calls).toBe(evidence === "completed" ? 4 : 6);
	}
	// An old process cannot submit through its expired graph lease.
	await expect(h.workflow.execute(lease, new AbortController().signal, () => { h.queue.renew(lease, 1000); })).resolves.toEqual({ status: "completed" });
});


it.each(["version", "total"])("reconciles completed receipts at the %s budget limit without invoking Runtime or changing counters", async limit => {
	const spec = { ...graph, tasks: graph.tasks.slice(1) };
	const h = harness(async request => response(request), spec); await h.start();
	h.store.change(scope, "crashed-at-cap", "fixture", "host", "fixture", h.store.read(scope).revision, state => {
		const plan = state.versions[0]; plan.calls = PLAN_LIMITS.calls; plan.status = "failed"; plan.failure = { code: "plan_job_failed", retryable: true };
		plan.taskRuns = [0, 1].map(taskIndex => ({ taskIndex, attempt: 1, generation: plan.generation, jobId: "crashed", leaseId: "expired", sessionId: `saved-${taskIndex}`, idempotencyKey: `saved-${taskIndex}`, status: "interrupted", startedAt: "2026-10-19T00:00:00Z", failure: { code: "plan_job_failed", retryable: true } }));
		if (limit === "total") {
			const old = structuredClone(plan); old.status = "superseded";
			plan.version = 2; plan.approval!.version = 2; state.versions = [old, plan];
		}
	});
	h.options.recoverResult = (_scope, sessionId, key) => ({ adapter: "fake", status: "completed", sessionId, executionId: key, finalResponse: JSON.stringify(result), events: [] });
	const before = h.store.read(scope), version = before.versions.at(-1)!.version;
	const body = { action: "reconcile", requestId: "reconcile-once", revision: before.revision, version };
	h.workflow.command(scope, "user", body);
	const after = h.store.read(scope); h.workflow.command(scope, "user", body);
	expect(h.store.read(scope)).toEqual(after); expect(h.requests).toHaveLength(1);
	expect(after.versions.at(-1)).toMatchObject({ status: "completed", calls: PLAN_LIMITS.calls, children: [{ taskIndex: 0 }, { taskIndex: 1 }] });
	expect(after.versions.at(-1)!.taskRuns?.every(run => run.status === "completed" && !run.failure)).toBe(true);
	expect(after.versions.map(plan => plan.calls)).toEqual(before.versions.map(plan => plan.calls));
});

it("saved-result reconciliation keeps partial success, never fills missing evidence and cannot reuse changed sources", async () => {
	const h = harness(async request => response(request)); await h.start();
	h.store.change(scope, "partial-reconcile", "fixture", "host", "fixture", h.store.read(scope).revision, state => {
		const plan = state.versions[0]; plan.calls = PLAN_LIMITS.calls; plan.status = "failed"; plan.failure = { code: "plan_budget_exceeded", retryable: false };
		plan.taskRuns = [1, 2].map(taskIndex => ({ taskIndex, attempt: 1, generation: plan.generation, jobId: "crashed", leaseId: "expired", sessionId: `saved-${taskIndex}`, idempotencyKey: `saved-${taskIndex}`, status: "interrupted", startedAt: "2026-10-19T00:00:00Z" }));
	});
	h.options.recoverResult = (_scope, sessionId, key) => sessionId === "saved-2" ? { adapter: "fake", status: "completed", sessionId, executionId: key, finalResponse: JSON.stringify(result), events: [] } : undefined;
	h.command({ action: "reconcile" }); expect(h.plan().children.map(child => child.taskIndex)).toEqual([2]); expect(h.plan().status).toBe("failed");
	expect(() => h.command({ action: "reconcile" })).toThrow("plan_no_completed_results");
	h.revoke(); expect(() => h.command({ action: "reconcile" })).toThrow("plan_sources_changed");
	expect(h.requests).toHaveLength(1); expect(h.plan().calls).toBe(PLAN_LIMITS.calls);
});

it("observes source changes without an API notification while both workers stay blocked", async () => {
	const slow = gate(), h = harness(async request => { await slow.wait; return response(request); });
	await h.start(); vi.useFakeTimers(); const pending = h.scheduler.runNext();
	await vi.advanceTimersByTimeAsync(1); expect(h.requests).toHaveLength(3);
	h.revoke(); await vi.advanceTimersByTimeAsync(1000); await pending;
	expect(h.plan()).toMatchObject({ status: "failed", children: [], failure: { code: "plan_sources_changed" } });
	expect(h.signals.slice(1).every(signal => signal.aborted)).toBe(true); slow.release();
});


it.each([
	["missing-trace", "plan_completion_evidence_missing"], ["tool", "plan_tool_failed"], ["session", "plan_completion_evidence_missing"],
	["json", "invalid_plan_output"], ["evidence", "plan_replan_required"], ["assessment", "plan_replan_required"],
])("saved-result reconciliation rejects %s evidence without another Runtime call", async (fault, expected) => {
	const spec = { ...graph, tasks: graph.tasks.slice(1) }, h = harness(async request => response(request), spec); await h.start();
	h.store.change(scope, "receipt-fault", "fixture", "host", "fixture", h.store.read(scope).revision, state => {
		const plan = state.versions[0]; plan.status = "paused"; plan.calls = PLAN_LIMITS.calls;
		plan.taskRuns = [0, 1].map(taskIndex => ({ taskIndex, attempt: 1, generation: plan.generation, jobId: "crashed", leaseId: "expired", sessionId: `saved-${taskIndex}`, idempotencyKey: `saved-${taskIndex}`, status: "interrupted", startedAt: "2026-10-19T00:00:00Z" }));
	});
	h.options.recoverResult = (_scope, sessionId, key) => {
		if (sessionId === "saved-1") return undefined;
		if (fault === "missing-trace") throw new PlanError("plan_completion_evidence_missing");
		return { adapter: "fake", status: "completed", sessionId: fault === "session" ? "another-session" : sessionId, executionId: key,
			finalResponse: fault === "json" ? "{}invalid" : JSON.stringify({ ...result, ...(fault === "evidence" ? { evidence: [] } : {}), ...(fault === "assessment" ? { assessment: { decision: "replan", reason: "Source cannot support the objective" } } : {}) }),
			events: fault === "tool" ? [{ type: "tool.completed", tool: "file_read", toolCallId: "read", risk: "read", status: "failed", durationMs: 1, resultTruncated: false, replayed: false }] : [],
		};
	};
	h.command({ action: "reconcile" });
	expect(h.plan()).toMatchObject({ status: "failed", calls: PLAN_LIMITS.calls, failure: { code: expected, retryable: false } });
	expect(h.requests).toHaveLength(1);
});


it("marks completed read-only results stale on the next read after a source change, preserving history and budgets", async () => {
	const h = harness(async request => response(request));
	await h.start(); await h.scheduler.runNext(); await h.scheduler.runNext();
	const completed = h.store.read(scope), before = completed.versions[0];
	expect(before.status).toBe("completed");
	h.revoke();
	const changed = (await h.workflow.read(scope)), stale = changed.versions[0];
	expect(stale.status).toBe("stale");
	expect(stale.failure).toEqual({ code: "plan_sources_changed", retryable: false });
	expect(stale.children).toEqual(before.children);
	expect(stale.taskRuns).toEqual(before.taskRuns);
	expect(stale.approval).toEqual(before.approval);
	expect(stale.calls).toBe(before.calls);
	expect(stale.generation).toBe(before.generation);
	expect(changed.consecutiveFailures).toBe(completed.consecutiveFailures);
	expect(h.requests).toHaveLength(4);
	h.workflow.reconcile(); h.workflow.reconcile();
	expect((await h.workflow.read(scope))).toEqual(changed);
	expect(h.queue.list().filter(job => ["queued", "leased"].includes(job.status))).toEqual([]);
});


it("retains stale results through restart and restored inputs; only a new plan and confirmation can execute", async () => {
	const h = harness(async request => response(request));
	await h.start(); await h.scheduler.runNext(); await h.scheduler.runNext();
	const completed = h.store.read(scope), original = h.options.readInput(scope);
	h.revoke();
	const store = new AgentPlanStore(h.path); cleanup.push(() => store.close());
	const queue = new FileStageJobQueue(h.queuePath);
	const workflow = new AgentPlanWorkflow(store, queue, h.runtime, h.options);
	const stale = (await workflow.read(scope));
	expect(stale.versions[0].status).toBe("stale");
	h.options.readInput = () => original;
	expect((await workflow.read(scope))).toEqual(stale);
	for (const action of ["resume", "confirm", "reconcile", "cancel"]) expect(() => h.command({ action, confirmed: true })).toThrow();
	expect(h.requests).toHaveLength(4);
	h.command({ action: "replan" }); await h.scheduler.runNext();
	const revised = h.store.read(scope).versions[1];
	expect(revised).toMatchObject({ status: "awaiting_confirmation", replanFromVersion: 1, calls: 1, children: [] });
	expect(revised.approval).toBeUndefined();
	expect(h.requests).toHaveLength(5);
	await h.scheduler.runNext(); expect(h.requests).toHaveLength(5);
	h.command({ action: "confirm", version: 2, confirmed: true }); await h.scheduler.runNext(); await h.scheduler.runNext();
	expect(h.store.read(scope).versions[1].status).toBe("completed");
	expect(h.store.read(scope).versions[0].children).toEqual(completed.versions[0].children);
});

it("does not mark completed results stale when the input store fails and does not touch another scope", async () => {
	const h = harness(async request => response(request), graph, { assertAvailable: () => {} });
	await h.start(); await h.scheduler.runNext(); await h.scheduler.runNext();
	const before = h.store.read(scope), readInput = h.options.readInput;
	expect((await h.workflow.read(scope))).toEqual(before);
	h.options.readInput = () => { throw new PlanError("context_store_unavailable", 503); };
	await expect(h.workflow.read(scope)).rejects.toThrow("context_store_unavailable");
	expect(h.store.read(scope)).toEqual(before);
	h.options.readInput = readInput;
	const other = { ...scope, tenantId: "another-tenant" };
	const otherState = h.store.change(other, "fixture-copy", "fixture", "fixture", "fixture.completed", 0, state => Object.assign(state, structuredClone(before), { revision: 0 }));
	h.revoke(); (await h.workflow.read(scope));
	expect(h.plan().status).toBe("stale");
	expect(h.store.read(other)).toEqual(otherState);
	expect(h.requests).toHaveLength(4);
});

it("keeps legacy serial completion unchanged when current inputs change", async () => {
	const h = harness(async request => response(request), graph, { maxReadConcurrency: undefined });
	await h.start(); for (let i = 0; i < 3; i++) await h.scheduler.runNext();
	const completed = h.store.read(scope);
	expect(completed.versions[0].readConcurrency).toBeUndefined();
	expect(completed.versions[0].status).toBe("completed");
	h.revoke(); expect((await h.workflow.read(scope))).toEqual(completed);
	expect(h.requests).toHaveLength(4);
});


it("checks completed inputs on demand without rebuilding them in every general queue sweep", async () => {
	const h = harness(async request => response(request), graph, { assertAvailable: () => {} });
	await h.start(); await h.scheduler.runNext(); await h.scheduler.runNext();
	const readInput = vi.fn(h.options.readInput); h.options.readInput = readInput;
	h.workflow.reconcile(); h.workflow.reconcile();
	expect(readInput).not.toHaveBeenCalled();
	(await h.workflow.read(scope)); expect(readInput).toHaveBeenCalledTimes(1);
});


it.each(["report", "attachment", "knowledge", "verified_fact", "prior_artifact", "unknown_input", "revision"])("keeps downstream draft changes out of completion validity but detects changed %s", async change => {
	const frozen = { schemaVersion: "task-context.v1", scope, attachments: [{ sourceRef: "attachment://source", sha256: "original" }], sourceReport: { status: "selected", version: 1, selectionRevision: 1 }, knowledge: { digest: "original" },
		facts: [{ key: "quantity", version: 1, status: "verified", value: 100 }], artifacts: [{ artifactId: "prior", version: 1 }], unresolved: [], stage: { status: "passed" }, completed: [], pendingChanges: [], approval: null };
	let input = { revision: 1, context: JSON.stringify(frozen) };
	const h = harness(async request => response(request), graph, { assertAvailable: () => {}, readInput: () => input });
	await h.start(); await h.scheduler.runNext(); await h.scheduler.runNext();
	const completed = h.store.read(scope);
	const downstream = { ...frozen, stage: { status: "waiting_approval" }, completed: [{ version: 2 }], pendingChanges: [{ key: "candidate" }], approval: { id: "new-draft-approval" },
		facts: [...frozen.facts, { key: "candidate", version: 1, status: "unverified", value: 200 }], artifacts: [...frozen.artifacts, { artifactId: "new-draft", version: 1 }] };
	input = { revision: 1, context: JSON.stringify(downstream) };
	expect((await h.workflow.read(scope))).toEqual(completed);
	downstream.facts[1].status = "verified";
	input = { revision: 1, context: JSON.stringify(downstream) };
	expect((await h.workflow.read(scope))).toEqual(completed);
	const changed = structuredClone(downstream);
	if (change === "report") changed.sourceReport.selectionRevision++;
	if (change === "attachment") changed.attachments[0].sha256 = "changed";
	if (change === "knowledge") changed.knowledge.digest = "changed";
	if (change === "verified_fact") changed.facts[0].value = 101;
	if (change === "prior_artifact") changed.artifacts[0].version++;
	input = { revision: change === "revision" ? 2 : 1, context: JSON.stringify(change === "unknown_input" ? { ...changed, newPolicyInput: "changed" } : changed) };
	expect((await h.workflow.read(scope)).versions[0].status).toBe("stale");
	expect(h.requests).toHaveLength(4);
});


it.each(["value", "version", "confirmation", "source", "withdrawal", "removed"])("invalidates completed results when a frozen unverified input changes: %s", async change => {
	const frozen = { schemaVersion: "task-context.v1", scope, facts: [{ key: "quantity", version: 1, value: 100, status: "unverified", sourceRef: "attachment:customer-v1", sourceValidity: "current_record_source_not_independently_verified" }], artifacts: [], unresolved: [{ key: "quantity", version: 1, reason: "confirmation_required" }] };
	let context = JSON.stringify(frozen);
	const h = harness(async request => response(request), graph, { readInput: () => ({ revision: 1, context }) });
	await h.start(); await h.scheduler.runNext(); await h.scheduler.runNext();
	const completed = h.store.read(scope);
	const changed = structuredClone(frozen);
	if (change === "value") changed.facts[0].value++;
	if (change === "version") changed.facts[0].version++;
	if (change === "confirmation") changed.facts[0].status = "verified";
	if (change === "source") changed.facts[0].sourceRef = "attachment:replacement";
	if (change === "withdrawal") changed.facts[0].sourceValidity = "stale";
	if (change === "removed") changed.facts = [];
	context = JSON.stringify(changed);
	const stale = (await h.workflow.read(scope));
	expect(stale.versions[0].status).toBe("stale");
	expect(stale.versions[0].children).toEqual(completed.versions[0].children);
	expect(stale.versions[0].inputDependencies).toEqual(completed.versions[0].inputDependencies);
	expect((await h.workflow.read(scope))).toEqual(stale);
	expect(h.requests).toHaveLength(4);
});


it("persists the input receipt before confirmation, validates it after restart and never adopts later records", async () => {
	const frozen = { schemaVersion: "task-context.v1", scope, facts: [{ key: "quantity", version: 2, status: "suggested", value: 100 }, { key: "material", version: 1, status: "rejected", value: "unsuitable" }], artifacts: [{ artifactId: "source-comparison", version: 3, freshness: "fresh" }], unresolved: [] };
	let context = JSON.stringify(frozen);
	const h = harness(async request => response(request), graph, { readInput: () => ({ revision: 1, context }) });
	await h.start();
	const dependencies = h.plan().inputDependencies!;
	expect(dependencies).toMatchObject({ schemaVersion: "plan-input-dependencies.v1", facts: [{ key: "material", version: 1 }, { key: "quantity", version: 2 }], artifacts: [{ artifactId: "source-comparison", version: 3 }] });
	expect(JSON.stringify(dependencies)).not.toContain("unsuitable");
	expect(dependencies.facts.every(item => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
	await h.scheduler.runNext(); await h.scheduler.runNext();
	const completed = h.store.read(scope);
	const store = new AgentPlanStore(h.path); cleanup.push(() => store.close());
	const workflow = new AgentPlanWorkflow(store, h.queue, h.runtime, h.options);
	expect((await workflow.read(scope))).toEqual(completed);
	const downstream = { ...frozen, facts: [...frozen.facts].reverse().concat(Array.from({ length: 128 }, (_, index) => ({ key: `new-draft-${index}`, version: 1, status: "verified", value: "downstream" }))), artifacts: [...frozen.artifacts, { artifactId: "new-output", version: 1, freshness: "fresh" }] };
	context = JSON.stringify(downstream);
	expect((await workflow.read(scope))).toEqual(completed);
	downstream.facts.find(fact => fact.key === "material")!.value = "changed rejected input";
	context = JSON.stringify(downstream);
	const stale = (await workflow.read(scope));
	expect(stale.versions[0].status).toBe("stale");
	expect(stale.versions[0].inputDependencies).toEqual(dependencies);
	expect(stale.versions[0].calls).toBe(completed.versions[0].calls);
	expect(h.requests).toHaveLength(4);
});

it("does not invent candidate dependencies for completed legacy plans without a receipt", async () => {
	const frozen = { schemaVersion: "task-context.v1", scope, facts: [{ key: "quantity", version: 1, status: "unverified", value: 100 }], artifacts: [], unresolved: [] };
	let context = JSON.stringify(frozen);
	const h = harness(async request => response(request), graph, { readInput: () => ({ revision: 1, context }) });
	await h.start(); await h.scheduler.runNext(); await h.scheduler.runNext();
	h.store.change(scope, "fixture-legacy", "legacy", "fixture", "fixture.legacy", h.store.read(scope).revision, state => { delete state.versions[0].inputDependencies; });
	const legacy = h.store.read(scope);
	frozen.facts[0].value++;
	context = JSON.stringify(frozen);
	expect((await h.workflow.read(scope))).toEqual(legacy);
	expect(h.plan().inputDependencies).toBeUndefined();
});


it("rejects ambiguous or oversized frozen records rather than omitting their dependencies", () => {
	const fact = { key: "quantity", version: 1, status: "unverified", value: 100 };
	const source = { schemaVersion: "task-context.v1", facts: [fact], artifacts: [{ artifactId: "source", version: 1 }], unresolved: [] };
	for (const invalid of [
		{ ...source, facts: [fact, fact] }, { ...source, artifacts: [source.artifacts[0], source.artifacts[0]] },
		{ ...source, facts: [{ ...fact, version: 0 }] }, { ...source, facts: [{ ...fact, key: "" }] },
		{ ...source, unresolved: null }, { ...source, facts: Array.from({ length: 129 }, (_, index) => ({ ...fact, key: `key${index}` })) },
	]) expect(() => planInputDependencies(JSON.stringify(invalid))).toThrow("plan_input_dependencies_invalid");
	expect(planInputDependencies("legacy text")).toBeUndefined();
});
