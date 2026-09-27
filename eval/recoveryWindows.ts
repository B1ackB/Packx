import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentHooks } from "../src/agent/hooks";
import { SkillRegistry } from "../src/agent/skills";
import { ProposalRunEngine } from "../src/enterprise/proposalRunEngine";
import { createDeterministicProposal } from "../src/print/solutionProposal";
import type { AgentRuntimePort } from "../src/runtime/contracts";
import { FileArtifactContentStore } from "../server/artifacts/fileArtifactStore";
import { FileEnterpriseEventStore } from "../server/enterprise/fileEventStore";
import { FileStageJobQueue } from "../server/enterprise/fileStageJobQueue";
import { BlackxAgentRuntime } from "../server/runtime/agentRuntime";
import { FileAgentStateStore } from "../server/runtime/fileAgentStateStore";
import { ModelTelemetryStore } from "../server/runtime/modelTelemetry";
import { ProposalWorker } from "../server/workers/proposalWorker";
import { StageJobOutbox } from "../server/workers/stageJobOutbox";
import { StageJobScheduler } from "../server/workers/stageJobScheduler";

const scope = { tenantId: "recovery-eval", workspaceId: "synthetic", runId: "order" };
const request = { ...scope, actorId: "fixture-operator", stageId: "conversation", sessionId: "same-session", idempotencyKey: "same-turn", input: "Return the synthetic result", allowedTools: [], fallbackOutput: "", policy: { sandboxMode: "read-only" as const, approvalPolicy: "never" as const, timeoutMs: 5000 } };
type Window = "model-before-session" | "session-before-trace" | "enqueue-before-outbox-ack" | "stale-worker";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
function boundary(root: string, waitForRelease = false) {
	writeFileSync(join(root, "ready.json"), JSON.stringify({ at: Date.now() }));
	do { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); } while (!waitForRelease || !existsSync(join(root, "release")));
}

function runtime(root: string, window?: Window) {
	const state = new FileAgentStateStore(join(root, "state")), hooks = new AgentHooks();
	if (window === "model-before-session") hooks.on("model.after", () => boundary(root));
	if (window === "session-before-trace") {
		const put = state.putTrace.bind(state);
		state.putTrace = (trace) => { if (trace.status === "completed") boundary(root); return put(trace); };
	}
	return new BlackxAgentRuntime({ sessions: state, snapshots: state, traces: state, executions: state, skills: new SkillRegistry(), hooks,
		telemetry: new ModelTelemetryStore(join(root, "telemetry"), "fake"),
		provider: { async generate() { appendFileSync(join(root, "generations.log"), "generated\n"); return { text: "synthetic result", toolCalls: [], usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 } }; } },
	});
}

function business(root: string, initialize = false) {
	const store = new FileEnterpriseEventStore(join(root, "events.json")), engine = new ProposalRunEngine(store);
	const queue = new FileStageJobQueue(join(root, "queue.json")), artifacts = new FileArtifactContentStore(join(root, "artifacts"));
	const envelope = (id: string) => ({ ...scope, actorId: "fixture-operator", commandId: id, correlationId: "recovery", expectedVersion: engine.load(scope).aggregateVersion });
	const outbox = new StageJobOutbox(engine, store, queue);
	if (initialize) {
		engine.create(envelope("create")); engine.startProposal(envelope("start"));
		engine.recordFactVersion({ ...envelope("fact"), factKey: "quantity", factVersion: 1, value: 5000, unit: "bags", status: "verified", sourceType: "human_confirmation", sourceRef: "synthetic-confirmation" });
		outbox.requestProposal(envelope("request"));
	}
	return { store, engine, queue, artifacts, outbox, envelope };
}

function fakeRuntime(root?: string): AgentRuntimePort {
	return { health: async () => ({ adapter: "fake", online: true }), async executeTurn() {
		if (root) boundary(root, true);
		return { executionId: "synthetic-runtime", adapter: "fake", status: "completed", sessionId: "synthetic-session", contextSnapshotId: "synthetic-context", finalResponse: JSON.stringify(createDeterministicProposal({})), events: [] };
	} };
}

async function child(root: string, window: Window) {
	if (window === "model-before-session" || window === "session-before-trace") { await runtime(root, window).executeTurn(request); return; }
	const { store, engine, queue, artifacts, outbox } = business(root, true);
	if (window === "enqueue-before-outbox-ack") { store.markOutboxPublished = () => { boundary(root); throw new Error("unreachable"); }; outbox.dispatchOne(); return; }
	outbox.dispatchOne();
	const worker = new ProposalWorker(engine, fakeRuntime(root), artifacts);
	const scheduler = new StageJobScheduler(queue, { workerId: "old-worker", leaseMs: 250, heartbeatMs: 80, handlers: { proposal: (lease, signal, guard) => worker.executeLease(lease, signal, guard) } });
	try { await scheduler.runNext(); throw new Error("stale_worker_was_accepted"); }
	catch (error) { writeFileSync(join(root, "old-worker.json"), JSON.stringify({ code: (error as { code?: string }).code })); }
}

async function runWindow(window: Window) {
	const root = mkdtempSync(join(tmpdir(), "packx-window-"));
	const worker = fork(fileURLToPath(import.meta.url), ["--child", root, window], { execArgv: ["--import", "tsx"], silent: true });
	let stderr = ""; worker.stderr?.on("data", (data) => { stderr = (stderr + data).slice(-2000); });
	const exited = new Promise<NodeJS.Signals | null>((done) => worker.once("exit", (_code, signal) => done(signal)));
	const waitStart = performance.now();
	try {
		const deadline = Date.now() + 10000;
		while (!existsSync(join(root, "ready.json"))) {
			assert(worker.exitCode === null && worker.signalCode === null && Date.now() < deadline, `boundary_not_reached:${window}:${stderr}`);
			await sleep(20);
		}
		if (window === "stale-worker") {
			const { engine, queue, artifacts } = business(root);
			const before = engine.load(scope).aggregateVersion;
			await sleep(300);
			const next = queue.claim("new-worker", 10000); assert(next);
			writeFileSync(join(root, "release"), "release");
			await exited;
			assert.equal(JSON.parse(readFileSync(join(root, "old-worker.json"), "utf8")).code, "lease_lost");
			assert.equal(engine.load(scope).aggregateVersion, before);
			const successor = new ProposalWorker(engine, fakeRuntime(), artifacts);
			await successor.executeLease(next, undefined, () => { queue.renew(next, 10000); }); queue.ack(next);
			assert.equal(engine.load(scope).proposalVersions.length, 1);
			return { window, process: "two-real-processes", oldWorkerCommitRejected: true, artifactVersions: 1, recovered: true, durationMs: Math.round(performance.now() - waitStart) };
		}
		assert(worker.kill("SIGKILL")); assert.equal(await exited, "SIGKILL");
		if (window === "enqueue-before-outbox-ack") {
			const { store, queue, outbox } = business(root), pending = store.readPendingOutbox(1)[0]; assert(pending);
			const jobId = pending.payload.jobId; assert(queue.get(jobId));
			assert.equal(outbox.dispatchOne().status, "published");
			assert.equal(queue.claim("restarted", 1000)?.jobId, jobId);
			assert.equal(queue.claim("duplicate", 1000), undefined);
			return { window, signal: "SIGKILL", recovered: true, duplicateJobs: 0 };
		}
		const before = readFileSync(join(root, "generations.log"), "utf8").trim().split("\n").length;
		let outcome = "completed";
		try { await runtime(root).executeTurn(request); } catch (error) { outcome = (error as { code: string }).code; }
		const after = readFileSync(join(root, "generations.log"), "utf8").trim().split("\n").length;
		assert.equal(before, 1);
		assert.equal(outcome, window === "model-before-session" ? "completed" : "context_failure");
		assert.equal(after, window === "model-before-session" ? 2 : 1);
		return { window, signal: "SIGKILL", outcome, generationsBeforeCrash: before, generationsAfterRestart: after - before,
			recoveredWithoutRegeneration: false, finding: window === "model-before-session" ? "Model response is not durable before Session save; retry regenerates. No exactly-once model-cost guarantee." : "Session reply survives but completed Trace is absent; Runtime stops without another generation." };
	} finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); await exited; rmSync(root, { recursive: true, force: true }); }
}

function eventReplay() {
	const root = mkdtempSync(join(tmpdir(), "packx-event-replay-"));
	try {
		const { engine, envelope, artifacts } = business(root, true);
		const content = { synthetic: true, quantity: 5000 }, artifactId = "proposal";
		const contentRef = artifacts.putJson({ ...scope, artifactId, artifactVersion: 1 }, content);
		engine.completeProposal({ ...envelope("complete"), runtime: { executionId: "fixture", adapterId: "fake", contextSnapshotId: "fixture" }, artifact: { artifactId, schemaVersion: "fixture.v1", contentRef, inputFactVersions: engine.load(scope).factVersions }, evaluation: { passed: true, reportRef: "fixture-evaluation" }, approvalId: "fixture-approval" });
		engine.resolveApproval({ ...envelope("approve"), approvalId: "fixture-approval", artifactId, artifactVersion: 1, decision: "approved" });
		engine.recordFactVersion({ ...envelope("change"), factKey: "quantity", factVersion: 2, value: 6200, unit: "bags", status: "verified", sourceType: "human_confirmation", sourceRef: "new-synthetic-confirmation" });
		const current = engine.load(scope); assert.equal(current.approval?.status, "superseded"); assert.equal(current.currentProposal?.freshness, "stale");
		assert.deepEqual(business(root).engine.load(scope), current);
		const bytes = JSON.parse(readFileSync(join(root, "events.json"), "utf8"));
		writeFileSync(join(root, "v2.json"), JSON.stringify({ schemaVersion: 2, events: bytes.events }));
		assert.deepEqual(new ProposalRunEngine(new FileEnterpriseEventStore(join(root, "v2.json"))).load(scope), current);
		bytes.events[0].data.type = "unknown.future.event";
		writeFileSync(join(root, "corrupt.json"), JSON.stringify(bytes));
		assert.throws(() => new ProposalRunEngine(new FileEnterpriseEventStore(join(root, "corrupt.json"))).load(scope), { code: "event_store_corrupt" });
		assert.throws(() => new FileArtifactContentStore(join(root, "missing-blobs")).readJson({ ...scope, artifactId, artifactVersion: 1 }), { code: "artifact_not_found" });
		return { window: "event-replay", v2AndV3StateEqual: true, oldApprovalSuperseded: true, oldArtifactStale: true, unknownEventRejected: true, missingBlobDetected: true, modelCalls: 0, externalSideEffects: 0, limitation: "File-format compatibility, not a general event-schema migration framework" };
	} finally { rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[2] === "--child") await child(process.argv[3], process.argv[4] as Window);
else {
	assert(!process.argv.includes("--online"), "offline_only");
	const cases: Array<Record<string, unknown>> = [];
	for (const window of ["model-before-session", "session-before-trace", "enqueue-before-outbox-ack", "stale-worker"] as Window[]) cases.push(await runWindow(window));
	cases.push(eventReplay());
	const report = { protocol: "recovery-windows.v1", mode: "offline-real-processes-fake-model", paidCalls: 0, powerLossTested: false, semanticQuality: "NOT_EVALUATED", cases };
	const index = process.argv.indexOf("--output");
	if (index >= 0) writeFileSync(resolve(process.argv[index + 1]), JSON.stringify(report, null, "\t") + "\n", { flag: "wx" });
	console.log(JSON.stringify(report, null, 2));
}
