import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileToolExecutionManifest, type ToolExecutionManifest, type SandboxedToolExecutorPort } from "../../src/agent/sandbox";
import type { AgentModelProvider } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { manufacturingSkills } from "../../src/manufacturing/skills";
import { requiredRequirementFacts } from "../../src/manufacturing/requirementBrief";
import type { ConversationView, RequirementBriefWorkspaceView } from "../../src/runtime/conversationContracts";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { RequirementBriefWorker } from "../manufacturing/requirementBriefWorker";
import { RequirementBriefWorkspaceApiController } from "../manufacturing/requirementBriefApi";
import { StageJobOutbox } from "../workers/stageJobOutbox";
import { StageJobScheduler } from "../workers/stageJobScheduler";
import { AssetInspectionService, inspectionArtifactId } from "./assetInspection";
import { FileConversationAttachmentStore } from "./conversationAttachments";
import { BlackxAgentRuntime } from "./agentRuntime";
import { FileAgentStateStore } from "./fileAgentStateStore";
import { ConversationApiController } from "./conversationApi";
import { createProjectSourceReadTool } from "./requirementTools";
import { WindowsTextSandboxedToolExecutor } from "./windowsTextSandboxedToolExecutor";

const roots: string[] = [], binary = process.env.PACKX_WINDOWS_NATIVE_TOOLS ?? resolve(".blackx-tools");
const root = () => { const path = mkdtempSync(join(tmpdir(), "packx-protected-text-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
function fixture(bytes = Buffer.from("中文包装\nQuantity: 5000"), tools = binary) {
	const workspace = root(), attemptId = randomUUID(), directory = join(workspace, ".blackx-tool-inputs", attemptId); mkdirSync(directory, { recursive: true });
	const input = join(directory, "input.bin"); writeFileSync(input, bytes);
	const executor = new WindowsTextSandboxedToolExecutor(workspace, tools);
	const manifest = compileToolExecutionManifest({ attemptId, tenantId: "tenant", workspaceId: "workspace", runId: "run", stageId: "stage", executionId: "execution", toolCallId: "call", idempotencyKey: attemptId, tool: { name: "asset_metadata_inspect", version: "windows-utf8.v1" }, command: { executable: executor.executable, argv: [input, "1"], workingDirectory: directory }, paths: { readOnly: [input], writable: [], temporaryDirectory: join(directory, "output") }, environment: { LANG: "en_US.UTF-8" }, network: { mode: "deny-all", allowedDomains: [] }, limits: { timeoutMs: 10000, maxCpuSeconds: 30, maxMemoryBytes: 64 * 1024 * 1024, maxProcesses: 1, maxStdoutBytes: 1048576, maxStderrBytes: 4096, maxOutputFiles: 0, maxOutputBytes: 0 } });
	return { workspace, directory, input, executor, manifest };
}
async function until(check: () => boolean) { for (let i = 0; i < 500; ++i) { if (check()) return; await new Promise((accept) => setTimeout(accept, 20)); } throw new Error("Bounded native readiness deadline exceeded"); }
function broker(stage: string, input: string, timeout: number, output = 1048576, ownerProcess = false) {
	const args = [stage, `Packx.Text.${randomUUID().replaceAll("-", "")}`, input, join(binary, "text-fault-worker.exe"), String(timeout), String(output)];
	const program = join(binary, "text-inspector.exe");
	const ownerCode = 'import {spawn} from "node:child_process"; const [exe,...args]=JSON.parse(process.argv[1]); const child=spawn(exe,args,{stdio:["pipe",process.stdout,process.stderr]}); child.on("error",()=>process.exit(9)); setInterval(()=>{},1000);';
	const child = ownerProcess ? spawn(process.execPath, ["--input-type=module", "--eval", ownerCode, JSON.stringify([program, ...args])], { stdio: ["pipe", "pipe", "pipe"] }) : spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
	const chunks: Buffer[] = []; child.stdout.on("data", (data) => chunks.push(data)); let errors = ""; child.stderr.on("data", (data) => { errors += data; });
	const done = new Promise<Record<string, unknown>>((accept, reject) => { child.on("error", reject); child.on("close", (code) => {
		if (ownerProcess) { until(() => existsSync(join(stage, "execution.json"))).then(() => accept(JSON.parse(readFileSync(join(stage, "execution.json"), "utf8")))).catch(reject); return; }
		try { if (code !== 0) throw new Error(errors); accept(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (cause) { reject(new Error(`Native lifecycle failure ${errors}`, { cause })); }
	}); });
	void done.catch(() => {}); // A readiness assertion may fail first; the owned process still has a bounded lifetime.
	const guard = setTimeout(() => { child.stdin.destroy(); child.kill(); }, 15000); child.once("close", () => clearTimeout(guard));
	return { child, done };
}

async function productSlice(factory: (workspace: string) => SandboxedToolExecutorPort & { executable: string }) {
		const workspace = root(), context = { tenantId: "tenant", workspaceId: "workspace", actorId: "user" }, events = new InMemoryEnterpriseEventStore(), engine = new ProposalRunEngine(events, "requirement-brief");
		const attachments = new FileConversationAttachmentStore(join(workspace, "attachments")), sessions = new FileAgentStateStore(join(workspace, "sessions")), artifacts = new FileArtifactContentStore(join(workspace, "artifacts"));
		const executor = factory(workspace), inspector = new AssetInspectionService(engine, attachments, executor, workspace, executor.executable, undefined, "windows-utf8.v1");
		let attachmentId = "", observed = false;
		const usage = { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0 };
		const provider: AgentModelProvider = { async generate(request) {
			if (request.outputSchema?.properties && "issues" in (request.outputSchema.properties as object)) return { text: '{"issues":[]}', toolCalls: [], usage };
			if (!request.messages.some((message) => message.role === "tool")) return { text: "", toolCalls: [{ id: "source", name: "project_source_read", input: { sourceId: "customer-brief" } }, { id: "inspect", name: "asset_metadata_inspect", input: { attachmentId } }], usage };
			observed ||= request.messages.some((message) => message.role === "tool" && message.content.includes("windows-utf8.v1") && message.content.includes("5000"));
			return { text: request.fallbackOutput, toolCalls: [], usage };
		} };
		const runtime = new BlackxAgentRuntime({ provider, tools: [inspector.tool(), inspector.documentTool(() => { throw new Error("Windows local paths are not supported"); }), createProjectSourceReadTool(engine, attachments)], sandboxedToolExecutor: inspector, skills: new SkillRegistry(manufacturingSkills), sessions, snapshots: sessions, traces: sessions });
		const conversations = new ConversationApiController(runtime, sessions), conversationId = (conversations.create(context).body as { conversation: ConversationView }).conversation.conversationId;
		const stored = attachments.put({ ...context, conversationId }, { requestId: "upload", name: "customer.txt", mediaType: "text/plain", content: Buffer.from("5000 个包装袋，资料仅供确认") }).attachment; attachmentId = stored.attachmentId;
		const scope = { ...context, runId: conversationId, sessionId: conversationId }, current = sessions.getSession(scope)!; sessions.save(scope, current.revision, [{ role: "user", content: "请整理附件的包装需求", messageId: "source", pinned: true }], new Date().toISOString());
		const queue = new InMemoryStageJobQueue(), outbox = new StageJobOutbox(engine, events, queue), worker = new RequirementBriefWorker(engine, runtime, artifacts, attachments, inspector, undefined, undefined, conversations);
		const scheduler = new StageJobScheduler(queue, { workerId: "windows-native", handlers: { "requirement-brief": (lease, signal, guard) => worker.executeLease(lease, signal, guard) } }), api = new RequirementBriefWorkspaceApiController(conversations, engine, artifacts, outbox, scheduler, attachments);
		expect(api.start(context, conversationId, { requestId: "start", industry: "print" }).status).toBe(202); const initial = await scheduler.runNext(); expect(initial, JSON.stringify(initial)).toMatchObject({ status: "completed" }); expect(observed).toBe(true);
		const view = () => (api.get(context, conversationId).body as { requirementBrief: RequirementBriefWorkspaceView }).requirementBrief;
		const run = { ...context, runId: view().runId }; expect(view().state.stageStatus).toBe("needs_input");
		expect(artifacts.readJson({ ...run, artifactId: inspectionArtifactId(attachmentId), artifactVersion: 1 })).toMatchObject({ sha256: stored.sha256, parserVersion: "windows-utf8.v1", inspection: { kind: "text" } });
		const restarted = new AssetInspectionService(engine, attachments, executor, workspace, executor.executable, undefined, "windows-utf8.v1"); expect(restarted.readRecords(run)[0]?.sha256).toBe(stored.sha256);
		const values: Record<string, string | number> = { product_type: "包装袋", quantity: 5000, dimensions: "100×200mm", target_market: "香港", target_delivery: "2026-11-30", delivery_location: "香港", artwork_status: "待提供" };
		for (const key of requiredRequirementFacts.print) { expect(api.recordFact(context, conversationId, { requestId: `record-${key}`, key, value: values[key] }).status).toBe(200); const state = view().state; expect(api.resolveFact(context, conversationId, key, { requestId: `verify-${key}`, decision: "verified", expectedFactVersion: state.facts[key].version, expectedAggregateVersion: state.aggregateVersion }).status).toBe(200); }
		expect(api.start(context, conversationId, { requestId: "generate", industry: "print" }).status).toBe(202); const generated = await scheduler.runNext(); expect(generated, JSON.stringify(generated)).toMatchObject({ status: "completed" });
		const state = view().state; expect(state.stageStatus).toBe("waiting_approval"); const approval = { requestId: "approve", decision: "approved", approvalId: state.approval!.approvalId, artifactVersion: state.approval!.artifactVersion, expectedAggregateVersion: state.aggregateVersion };
		expect(api.resolveApproval(context, conversationId, approval).status).toBe(202); await scheduler.runNext(); expect(api.delivery(context, conversationId, state.currentProposal!.version)).toMatchObject({ status: 200, body: { delivery: { status: "approved" } } });
		expect(api.delivery({ ...context, tenantId: "other" }, conversationId, state.currentProposal!.version).status).toBe(404); expect(readdirSync(join(workspace, ".blackx-tool-inputs"))).toEqual([]);
}

describe.skipIf(process.platform !== "win32" || !process.env.PACKX_WINDOWS_NATIVE_TOOLS)("actual Windows protected UTF-8 operation", () => {
	it("reads exact UTF-8 under LPAC and rejects malformed/binary inputs without a Host fallback", async () => {
		for (let i = 0; i < 3; ++i) {
			const f = fixture(Buffer.from("\ufeff中文\n\\\"".repeat(2000))), result = await f.executor.execute(f.manifest, new AbortController().signal);
			expect(result, JSON.stringify(result)).toMatchObject({ status: "succeeded", exitCode: 0, sandbox: { terminationReason: "lpac_registry_read_job_cleanup_verified" } });
			expect(JSON.parse(result.stdout.text).pages[0].text).toBe(readFileSync(f.input, "utf8").slice(1));
			expect(existsSync(join(f.directory, "native"))).toBe(false);
		}
		const valid = fixture(Buffer.from("PK packaging text")); expect(await valid.executor.execute(valid.manifest, new AbortController().signal)).toMatchObject({ status: "succeeded" });
		for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from("a\0b"), Buffer.from("%PDF-1.7"), Buffer.from([0x50, 0x4b, 3, 4])]) {
			const f = fixture(bytes); expect(await f.executor.execute(f.manifest, new AbortController().signal)).toMatchObject({ status: "failed", stdout: { text: "" } });
		}
		const large = fixture(Buffer.alloc(131073, 97)); expect(await large.executor.execute(large.manifest, new AbortController().signal)).toMatchObject({ status: "policy_denied" });
	}, 60000);
	it("denies undeclared paths, network, commands, environment and hardlinked inputs", async () => {
		const f = fixture();
		for (const manifest of [ { ...f.manifest, command: { ...f.manifest.command, executable: "C:\\Windows\\System32\\cmd.exe" } }, { ...f.manifest, environment: { LANG: "en_US.UTF-8", API_KEY: "synthetic" } }, { ...f.manifest, network: { mode: "allowlist", allowedDomains: ["example.com"] } }, { ...f.manifest, paths: { ...f.manifest.paths, writable: [f.workspace] } } ] as ToolExecutionManifest[]) expect(await f.executor.execute(manifest, new AbortController().signal)).toMatchObject({ status: "policy_denied" });
		linkSync(f.input, join(f.directory, "alias.bin")); expect(await f.executor.execute(f.manifest, new AbortController().signal)).toMatchObject({ status: "policy_denied" });
	});
	it("bounds timeout, cancellation and output, cleaning only the owned Job and profile in three rounds", async () => {
		for (let i = 0; i < 3; ++i) for (const mode of ["timeout", "cancel", "output"] as const) {
			const f = fixture(Buffer.from(mode)), stage = join(f.directory, "native"); const run = broker(stage, f.input, mode === "timeout" ? 200 : 10000, mode === "output" ? 1024 : 1048576);
			if (mode === "cancel") { await until(() => existsSync(join(stage, "worker.json"))); run.child.stdin.destroy(); }
			expect(await run.done).toMatchObject({ status: mode === "timeout" ? "timed_out" : mode === "cancel" ? "cancelled" : "resource_exhausted", cleanupVerified: true, profileDeleted: true });
			rmSync(stage, { recursive: true }); expect(existsSync(stage)).toBe(false);
		}
	}, 60000);
	it("cleans a running LPAC worker and owned profile after the real Node Host is killed", async () => {
		for (let i = 0; i < 3; ++i) {
			const f = fixture(Buffer.from("sleep")), stage = join(f.directory, "native"), run = broker(stage, f.input, 10000, 1048576, true);
			await until(() => existsSync(join(stage, "worker.json"))); run.child.kill("SIGKILL");
			expect(await run.done).toMatchObject({ status: "cancelled", cleanupVerified: true, profileDeleted: true });
			rmSync(stage, { recursive: true });
		}
	}, 60000);
	it("propagates AbortSignal promptly through the actual Port and verifies cleanup in three rounds", async () => {
		const tools = root();
		copyFileSync(join(binary, "text-inspector.exe"), join(tools, "text-inspector.exe"));
		// Deliberately injected Host-owned fixture, with no production registration or model-selected command.
		copyFileSync(join(binary, "text-fault-worker.exe"), join(tools, "text-inspector-worker.exe"));
		for (let i = 0; i < 3; ++i) {
			const f = fixture(Buffer.from("sleep"), tools), controller = new AbortController();
			const pending = f.executor.execute(f.manifest, controller.signal);
			await until(() => existsSync(join(f.directory, "native", "worker.json")));
			const cancelledAt = Date.now(); controller.abort();
			expect(await pending).toMatchObject({ status: "cancelled", sandbox: { terminationReason: "owner_cancelled_cleanup_verified" } });
			expect(Date.now() - cancelledAt).toBeLessThan(5000); expect(existsSync(join(f.directory, "native"))).toBe(false);
		}
	}, 60000);
	it("runs upload → native Tool → versioned Artifact → confirmation → approval → delivery, and recovers source observations", () => productSlice((workspace) => new WindowsTextSandboxedToolExecutor(workspace, binary)), 60000);
});


it("retains Windows parser provenance through the generic business gates (offline Fake Port)", async () => {
	await productSlice((workspace) => ({ executable: join(workspace, "fixed-inspector"), async execute(manifest) {
		const bytes = readFileSync(manifest.command.argv[0]!); const timestamp = new Date().toISOString();
		return { schemaVersion: "tool-execution-result.v1", attemptId: manifest.attemptId, status: "succeeded", exitCode: 0, startedAt: timestamp, completedAt: timestamp, durationMs: 0,
			stdout: { text: JSON.stringify({ schemaVersion: "asset-inspection.v1", bytes: bytes.length, kind: "text", status: "parsed", pages: [{ page: 1, text: bytes.toString("utf8"), method: "text" }], truncated: false }), truncated: false }, stderr: { text: "", truncated: false }, outputs: [],
			sandbox: { profile: manifest.sandboxProfile, platform: "fake", permissions: { readOnlyPaths: 1, writablePaths: 0, network: "deny-all", environmentKeys: ["LANG"] } } };
	} }));
});
