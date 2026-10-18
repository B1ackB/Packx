import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SourceReportWorkflow } from "./sourceReportWorkflow";
import { RestrictedWebSource } from "../runtime/restrictedWebSource";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { FileConversationAttachmentStore } from "../runtime/conversationAttachments";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { SourceReportError } from "../../src/enterprise/sourceReport";
import { StageJobScheduler } from "../workers/stageJobScheduler";
const scope = { tenantId: "tenant", workspaceId: "workspace", runId: "conversation-report", actorId: "user" };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function harness(web = new RestrictedWebSource({ allowedDomains: ["docs.example.test"], resolve: async () => ["93.184.216.34"], transport: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("Supplier claims thickness 100 um; unverified.") }) })) {
	const root = mkdtempSync(join(tmpdir(), "packx-source-report-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const artifacts = new FileArtifactContentStore(join(root, "artifacts")), attachments = new FileConversationAttachmentStore(join(root, "attachments"));
	const file = attachments.put({ ...scope, conversationId: scope.runId }, { requestId: "file", name: "customer.txt", mediaType: "text/plain", content: Buffer.from("Customer requests thickness 90 um; not confirmed.") }).attachment;
	const inputs = [{ kind: "attachment", attachmentId: file.attachmentId, sha256: file.sha256 }, { kind: "web", url: "https://docs.example.test/spec" }];
	let available = true, id = 0;
	const create = () => {
		const queue = new InMemoryStageJobQueue();
		const workflow = new SourceReportWorkflow(join(root, "reports.sqlite"), queue, artifacts, attachments, web, { assertAvailable: target => { if (!available || JSON.stringify(target) !== JSON.stringify(scope)) throw new SourceReportError("report_scope_unavailable", 404); }, cancelJob: (id, target) => { scheduler.cancel(id, target); }, now: () => "2026-10-18T00:00:00Z" }); cleanups.push(() => workflow.close());
		const scheduler = new StageJobScheduler(queue, { workerId: `test-${++id}`, handlers: { "source-report": (lease, signal, guard) => workflow.execute(lease, signal, guard) }, dispatchOutbox: () => workflow.reconcile() });
		const command = (body: Record<string, unknown>) => workflow.command(scope, { requestId: `request-${++id}`, revision: workflow.view(scope).revision, ...body });
		return { workflow, queue, scheduler, command };
	};
	return { ...create(), root, create, file, inputs, artifacts, attachments, remove: () => { available = false; } };
}
it("freezes file + web snapshots, recovers queued intent, and publishes immutable unverified report versions", async () => {
	const h = harness(); h.command({ action: "start", title: "Compare source claims", inputs: h.inputs });
	await h.scheduler.runNext();
	expect(h.workflow.view(scope).versions[0]).toMatchObject({ status: "running", captured: [{ index: 0 }] });
	const restarted = h.create(); restarted.workflow.reconcile(); restarted.workflow.reconcile(); expect(restarted.queue.list()).toHaveLength(1);
	await restarted.scheduler.runNext(); await restarted.scheduler.runNext(); await restarted.scheduler.runNext();
	const report = restarted.workflow.report(scope, 1);
	expect(report).toMatchObject({ status: "unverified", sources: [{ excerpt: "Customer requests thickness 90 um; not confirmed." }, { excerpt: "Supplier claims thickness 100 um; unverified." }] });
	expect(report.sources.every(s => /^[a-f0-9]{64}$/.test(s.sha256) && s.snapshotRef.startsWith("artifact://"))).toBe(true);
	restarted.command({ action: "start", title: "Second version", inputs: h.inputs });
	for (let i = 0; i < 3; i++) await restarted.scheduler.runNext();
	expect(restarted.workflow.report(scope, 1)).toEqual(report); expect(restarted.workflow.report(scope, 2).title).toBe("Second version");
});
it("replays commands once, rejects stale/colliding commands and other owners", () => {
	const h = harness(); const request = { action: "start", requestId: "once", revision: 0, title: "Sources", inputs: h.inputs };
	h.workflow.command(scope, request); h.workflow.command(scope, request); expect(h.workflow.view(scope).versions).toHaveLength(1);
	expect(() => h.workflow.command(scope, { ...request, title: "changed" })).toThrow("report_command_conflict");
	expect(() => h.workflow.command(scope, { ...request, requestId: "stale" })).toThrow("report_revision_conflict");
	expect(() => h.workflow.view({ ...scope, actorId: "other" })).toThrow("report_scope_unavailable");
});
it("denies reports after source withdrawal and cancels deleted conversation work", async () => {
	const h = harness(); h.command({ action: "start", title: "Sources", inputs: h.inputs });
	for (let i = 0; i < 3; i++) await h.scheduler.runNext();
	h.attachments.withdraw({ ...scope, conversationId: scope.runId }, h.file.attachmentId, { requestId: "withdraw", actorId: scope.actorId, reason: "Source revoked", sha256: h.file.sha256 });
	expect(h.workflow.view(scope).versions[0].available).toBe(false); expect(() => h.workflow.report(scope, 1)).toThrow("withdrawn");
	const second = harness(); second.command({ action: "start", title: "Sources", inputs: second.inputs }); second.remove(); second.workflow.reconcile();
	expect(second.queue.list()[0].status).toBe("cancelled");
});
it("cancels an in-flight read and fences its late output", async () => {
	let started!: () => void, release!: () => void;
	const entered = new Promise<void>(r => { started = r; }), waiting = new Promise<void>(r => { release = r; });
	const web = new RestrictedWebSource({ allowedDomains: ["docs.example.test"], resolve: async () => ["93.184.216.34"], transport: async () => { started(); await waiting; return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("late") }; } });
	const h = harness(web); h.command({ action: "start", title: "Sources", inputs: [h.inputs[1]] });
	const pending = h.scheduler.runNext(); await entered; h.command({ action: "cancel", version: 1 }); release(); await pending;
	expect(h.workflow.view(scope).versions[0]).toMatchObject({ status: "cancelled", captured: [] }); expect(() => h.workflow.report(scope, 1)).toThrow("report_not_found");
});
it("retries only remaining GET work and retains committed snapshots", async () => {
	let calls = 0;
	const h = harness(new RestrictedWebSource({ allowedDomains: ["docs.example.test"], resolve: async () => ["93.184.216.34"], transport: async () => { calls++; return { status: calls === 1 ? 503 : 200, headers: { "content-type": "text/plain" }, body: Buffer.from("recovered") }; } }));
	h.command({ action: "start", title: "Sources", inputs: h.inputs }); await h.scheduler.runNext(); await h.scheduler.runNext();
	expect(h.workflow.view(scope).versions[0]).toMatchObject({ status: "failed", captured: [{ index: 0 }], failure: { retryable: true } });
	h.command({ action: "retry", version: 1 }); await h.scheduler.runNext(); await h.scheduler.runNext();
	expect(h.workflow.report(scope, 1).sources[1].excerpt).toBe("recovered"); expect(calls).toBe(2);
});
it("rejects changed sources, duplicate inputs and non-permitted URLs before queue insertion", () => {
	const h = harness();
	for (const inputs of [[{ ...h.inputs[0], sha256: "0".repeat(64) }], [h.inputs[0], h.inputs[0]], [{ kind: "web", url: "https://private.test/" }]]) expect(() => h.command({ action: "start", title: "Sources", inputs })).toThrow();
	expect(h.queue.list()).toHaveLength(0);
});

it.each(["snapshot", "report"])("recovers the %s Artifact/event gap without repeating committed GET snapshots", async (phase) => {
	let calls = 0;
	const h = harness(new RestrictedWebSource({ allowedDomains: ["docs.example.test"], resolve: async () => ["93.184.216.34"], transport: async () => { calls++; return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("stable source") }; } }));
	const put = h.artifacts.putJson.bind(h.artifacts); let crashed = false;
	h.artifacts.putJson = (key, content) => { const result = put(key, content); if (!crashed && (key.artifactId === "source-report") === (phase === "report")) { crashed = true; throw new SourceReportError("injected_commit_gap", 503, true); } return result; };
	h.command({ action: "start", title: "Sources", inputs: [h.inputs[1]] });
	await h.scheduler.runNext(); if (phase === "report") await h.scheduler.runNext();
	expect(h.workflow.view(scope).versions[0]).toMatchObject({ status: "failed", failure: { retryable: true } });
	h.command({ action: "retry", version: 1 }); for (let i = 0; i < 3; i++) await h.scheduler.runNext();
	expect(h.workflow.report(scope, 1).sources[0].excerpt).toBe("stable source"); expect(calls).toBe(1);
});
it("caps retries and exposes full bounded source text behind the same access checks", async () => {
	const h = harness(); h.command({ action: "start", title: "Sources", inputs: h.inputs });
	for (let i = 0; i < 3; i++) await h.scheduler.runNext();
	expect(h.workflow.source(scope, 1, 0).text).toContain("90 um");
	expect(() => h.workflow.source(scope, 1, 2)).toThrow("report_not_found");
	expect(() => h.workflow.source({ ...scope, workspaceId: "other" }, 1, 0)).toThrow("report_scope_unavailable");
	const failed = harness(new RestrictedWebSource({ allowedDomains: ["docs.example.test"], resolve: async () => ["93.184.216.34"], transport: async () => ({ status: 503, headers: {}, body: Buffer.alloc(0) }) }));
	failed.command({ action: "start", title: "Unavailable", inputs: [failed.inputs[1]] });
	for (let attempt = 1; attempt <= 3; attempt++) { await failed.scheduler.runNext(); if (attempt < 3) failed.command({ action: "retry", version: 1 }); }
	expect(() => failed.command({ action: "retry", version: 1 })).toThrow("report_not_retryable");
});


it("recovers a checkpoint written by a different process that exits without closing its stores", async () => {
	const h = harness(); h.command({ action: "start", title: "Process recovery", inputs: h.inputs });
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
		import { SourceReportWorkflow } from "./server/enterprise/sourceReportWorkflow.ts";
		import { RestrictedWebSource } from "./server/runtime/restrictedWebSource.ts";
		import { FileArtifactContentStore } from "./server/artifacts/fileArtifactStore.ts";
		import { FileConversationAttachmentStore } from "./server/runtime/conversationAttachments.ts";
		import { InMemoryStageJobQueue } from "./src/enterprise/stageJobQueue.ts";
		import { StageJobScheduler } from "./server/workers/stageJobScheduler.ts";
		import { join } from "node:path";
		const root=process.argv[1], queue=new InMemoryStageJobQueue();
		const workflow=new SourceReportWorkflow(join(root,"reports.sqlite"),queue,new FileArtifactContentStore(join(root,"artifacts")),new FileConversationAttachmentStore(join(root,"attachments")),new RestrictedWebSource({allowedDomains:["docs.example.test"]}),{assertAvailable:()=>{},cancelJob:()=>{}});
		const scheduler=new StageJobScheduler(queue,{workerId:"child",handlers:{"source-report":(lease,signal,guard)=>workflow.execute(lease,signal,guard)},dispatchOutbox:()=>workflow.reconcile()});
		await scheduler.runNext(); process.exit(23);
	`, h.root], { encoding: "utf8", timeout: 10_000 });
	expect(child.status, child.stderr).toBe(23);
	const restarted = h.create();
	expect(restarted.workflow.view(scope).versions[0].captured).toHaveLength(1);
	for (let i = 0; i < 3; i++) await restarted.scheduler.runNext();
	expect(restarted.workflow.report(scope, 1).sources).toHaveLength(2);
});


it("rejects corrupt persisted counters and modified Artifact bytes", async () => {
	const h = harness(); h.command({ action: "start", title: "Integrity", inputs: h.inputs });
	for (let i = 0; i < 3; i++) await h.scheduler.runNext();
	const artifactPath = join(h.root, "artifacts", scope.tenantId, scope.workspaceId, scope.runId, "source-report", "v1.json");
	const report = JSON.parse(readFileSync(artifactPath, "utf8")); report.title = "tampered"; writeFileSync(artifactPath, JSON.stringify(report));
	expect(() => h.workflow.report(scope, 1)).toThrow("report_artifact_corrupt");
	const db = new DatabaseSync(join(h.root, "reports.sqlite"));
	const row = db.prepare("SELECT revision,state FROM source_report_events ORDER BY revision DESC LIMIT 1").get()!;
	const state = JSON.parse(String(row.state)); state.versions[0].attempts = 99;
	db.prepare("UPDATE source_report_events SET state=? WHERE revision=?").run(JSON.stringify(state), row.revision); db.close();
	expect(() => h.workflow.view(scope)).toThrow("report_store_corrupt");
});

it("withdraws access to a report when its redirected destination leaves the domain policy", async () => {
	const web = new RestrictedWebSource({ allowedDomains: ["docs.example.test", "final.example.test"], resolve: async () => ["93.184.216.34"], transport: async url => url.hostname === "docs.example.test" ? { status: 302, headers: { location: "https://final.example.test/spec" }, body: Buffer.alloc(0) } : { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("frozen supplier source") } });
	const h = harness(web); h.command({ action: "start", title: "Redirect source", inputs: [h.inputs[1]] });
	await h.scheduler.runNext(); await h.scheduler.runNext();
	expect(h.workflow.report(scope, 1).sources[0]).toMatchObject({ requestedRef: "https://docs.example.test/spec", sourceRef: "https://final.example.test/spec" });
	web.allowedDomains.splice(web.allowedDomains.indexOf("final.example.test"), 1);
	expect(h.workflow.view(scope).versions[0].available).toBe(false);
	expect(() => h.workflow.report(scope, 1)).toThrow("web_url_denied");
});
