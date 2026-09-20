import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentModelProvider } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import type { SandboxedToolExecutorPort, ToolExecutionManifest, ToolExecutionResult } from "../../src/agent/sandbox";
import { InMemoryEnterpriseEventStore } from "../../src/enterprise/inMemoryEventStore";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { manufacturingSkills } from "../../src/manufacturing/skills";
import { createRequirementBrief } from "../../src/manufacturing/requirementBrief";
import type { ConversationView, RequirementBriefWorkspaceView } from "../../src/runtime/conversationContracts";
import type { RequirementDelivery } from "../../src/manufacturing/requirementDelivery";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { ArtifactStoreError } from "../../src/enterprise/artifactStore";
import { RequirementBriefWorker } from "../manufacturing/requirementBriefWorker";
import { RequirementBriefWorkspaceApiController } from "../manufacturing/requirementBriefApi";
import { StageJobOutbox } from "../workers/stageJobOutbox";
import { StageJobScheduler } from "../workers/stageJobScheduler";
import { documentFixture } from "../testing/documentFixture";
import { AssetInspectionService, inspectionArtifactId } from "./assetInspection";
import { FileConversationAttachmentStore } from "./conversationAttachments";
import { BlackxAgentRuntime } from "./agentRuntime";
import { FileAgentStateStore } from "./fileAgentStateStore";
import { ConversationApiController } from "./conversationApi";
import { MacOsSeatbeltSandboxedToolExecutor } from "./macOsSeatbeltSandboxedToolExecutor";
import { FakeSandboxedToolExecutor } from "./fakeSandboxedToolExecutor";
import { createProjectSourceReadTool } from "./requirementTools";

const directories: string[] = [];
const context = { tenantId: "inspection-tenant", workspaceId: "inspection-workspace", actorId: "inspection-user" };
const usage = { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0 };

function fakeResult(manifest: ToolExecutionManifest): ToolExecutionResult {
	const bytes = readFileSync(manifest.command.argv[0]!);
	return {
		schemaVersion: "tool-execution-result.v1", attemptId: manifest.attemptId, status: "succeeded", exitCode: 0,
		startedAt: "2026-09-05T00:00:00.000Z", completedAt: "2026-09-05T00:00:00.001Z", durationMs: 1,
		stdout: { text: JSON.stringify({ schemaVersion: "asset-inspection.v1", bytes: bytes.length, kind: "pdf", status: "parsed", pages: [{ page: 1, text: "Quantity: 5000. Delivery: Hong Kong." }], pageCount: 1, truncated: false }), truncated: false },
		stderr: { text: "", truncated: false }, outputs: [],
		sandbox: { platform: "fake", profile: manifest.sandboxProfile, permissions: { readOnlyPaths: 1, writablePaths: 0, network: "deny-all", environmentKeys: ["LANG"] } },
	};
}

function harness(native = false, omitInspection = false, input = documentFixture()) {
	const root = mkdtempSync(join(tmpdir(), "blackx-document-slice-")); directories.push(root);
	const events = new InMemoryEnterpriseEventStore();
	const engine = new ProposalRunEngine(events, "requirement-brief");
	const attachments = new FileConversationAttachmentStore(join(root, ".blackx-data", "attachments"));
	const sessions = new FileAgentStateStore(join(root, ".blackx-data", "sessions"));
	const artifacts = new FileArtifactContentStore(join(root, ".blackx-data", "artifacts"));
	const fake = new FakeSandboxedToolExecutor(async (manifest) => fakeResult(manifest));
	const executor: SandboxedToolExecutorPort = native ? new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot: root }) : fake;
	const inspector = new AssetInspectionService(engine, attachments, executor, root);
	let attachmentId = ""; let sourceRef = ""; let calls = 0; let modelSawInspection = false;
	const provider: AgentModelProvider = { async generate(request) {
		if (request.outputSchema?.properties && typeof request.outputSchema.properties === "object" && "issues" in request.outputSchema.properties) return { text: JSON.stringify({ issues: [] }), toolCalls: [], usage };
		calls += 1;
		if (calls === 1) return { text: "", toolCalls: [{ id: "source-1", name: "project_source_read", input: { sourceId: "customer-brief" } }, ...(!omitInspection ? [{ id: "inspection-1", name: "asset_metadata_inspect", input: { attachmentId } }] : [])], usage };
		modelSawInspection ||= request.messages.some((message) => message.role === "tool" && message.content.includes("asset-inspection.v1"));
		return { text: JSON.stringify(createRequirementBrief({ industry: "print", title: "咖啡包装需求", customerGoal: "整理客户 PDF", facts: [{ key: "quantity", version: 1, value: 5000, unit: "个", status: "unverified", sourceType: "model_output", sourceRef: `${sourceRef}#page=1` }] })), toolCalls: [], usage };
	} };
	const runtime = new BlackxAgentRuntime({ provider, tools: [inspector.tool(), inspector.documentTool(() => { throw new Error("Local paths are not granted by this fixture"); }), createProjectSourceReadTool(engine, attachments)], sandboxedToolExecutor: inspector, skills: new SkillRegistry(manufacturingSkills), sessions, snapshots: sessions, traces: sessions });
	const conversations = new ConversationApiController(runtime, sessions);
	const conversation = (conversations.create(context).body as { conversation: ConversationView }).conversation;
	const scope = { ...context, conversationId: conversation.conversationId };
	const stored = attachments.put(scope, { requestId: "upload-1", name: "customer.pdf", mediaType: "application/pdf", content: input }).attachment;
	attachmentId = stored.attachmentId; sourceRef = stored.sourceRef;
	const sessionScope = { ...context, runId: conversation.conversationId, sessionId: conversation.conversationId };
	sessions.save(sessionScope, sessions.getSession(sessionScope)!.revision, [{ role: "user", content: "请根据附件生成需求单", messageId: "message-1", pinned: true }], new Date().toISOString());
	const queue = new InMemoryStageJobQueue();
	const outbox = new StageJobOutbox(engine, events, queue);
	let worker = new RequirementBriefWorker(engine, runtime, artifacts, attachments, inspector);
	const scheduler = new StageJobScheduler(queue, { workerId: "document-worker", handlers: { "requirement-brief": (lease, signal, guard) => worker.executeLease(lease, signal, guard) } });
	const api = new RequirementBriefWorkspaceApiController(conversations, engine, artifacts, outbox, scheduler, attachments);
	const start = api.start(context, conversation.conversationId, { requestId: "start-1", industry: "print" });
	expect(start.status).toBe(202);
	const view = (start.body as { requirementBrief: RequirementBriefWorkspaceView }).requirementBrief;
	const run = { ...context, runId: view.runId };
	return { root, run, scope, api, scheduler, engine, attachments, artifacts, inspector, fake, stored, calls: () => calls, modelSawInspection: () => modelSawInspection, worker, replaceWorker: (value: RequirementBriefWorker) => { worker = value; }, runtime };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("asset inspection product slice", () => {
	it("recovers after a checkpoint without invoking the model or parser again", async () => {
		vi.useFakeTimers();
		const h = harness();
		const original = h.artifacts.putJson.bind(h.artifacts);
		let interrupted = false;
		vi.spyOn(h.artifacts, "putJson").mockImplementation((key, content) => {
			if (!interrupted && key.artifactId.startsWith("asset-inspection-")) { interrupted = true; throw new ArtifactStoreError("artifact_store_unavailable", "Simulated Worker interruption after checkpoint"); }
			return original(key, content);
		});
		expect(await h.scheduler.runNext()).toMatchObject({ status: "retry_scheduled" });
		expect(h.engine.load(h.run).currentProposal).toBeUndefined();
		const calls = h.calls();
		const recoveredInspector = new AssetInspectionService(h.engine, h.attachments, h.fake, h.root);
		h.replaceWorker(new RequirementBriefWorker(h.engine, { health: () => h.runtime.health(), executeTurn: async () => { throw new Error("Checkpoint recovery must not call model"); } }, h.artifacts, h.attachments, recoveredInspector));
		await vi.advanceTimersByTimeAsync(300);
		expect(await h.scheduler.runNext()).toMatchObject({ status: "completed" });
		expect(h.engine.load(h.run).currentProposal?.version).toBe(1);
		expect(h.calls()).toBe(calls);
		expect(h.fake.manifests).toHaveLength(1);
	});

	it("imports sandbox observations as versioned sources without promoting model Facts", async () => {
		const h = harness();
		expect(await h.scheduler.runNext()).toMatchObject({ status: "completed" });
		const state = h.engine.load(h.run);
		expect(state).toMatchObject({ stageStatus: "needs_input", facts: { quantity: { value: 5000, status: "unverified", sourceRef: `${h.stored.sourceRef}#page=1` } } });
		expect(h.artifacts.readJson({ ...h.run, artifactId: inspectionArtifactId(h.stored.attachmentId), artifactVersion: 1 })).toMatchObject({ sha256: h.stored.sha256, inspection: { status: "parsed" } });
		const result = h.api.delivery(context, h.scope.conversationId, 1);
		expect(result).toMatchObject({ status: 200, body: { delivery: { status: "draft", sources: [{ sha256: h.stored.sha256 }], citations: { quantity: `${h.stored.sourceRef}#page=1` } } } });
		expect(h.api.delivery({ ...context, tenantId: "other" }, h.scope.conversationId, 1).status).toBe(404);
		expect(h.fake.manifests[0]).toMatchObject({ network: { mode: "deny-all" }, paths: { writable: [] }, environment: { LANG: "en_US.UTF-8" } });
		expect(readdirSync(join(h.root, ".blackx-tool-inputs"))).toEqual([]);
		expect(h.modelSawInspection()).toBe(true);
		const recovered = new AssetInspectionService(h.engine, h.attachments, h.fake, h.root);
		expect(recovered.readRecords(h.run)).toHaveLength(1);
		expect(h.fake.manifests).toHaveLength(1);
	});
	it("fails the source gate when a model answers without inspecting the uploaded document", async () => {
		const h = harness(false, true);
		expect(await h.scheduler.runNext()).toMatchObject({ status: "dead_letter", job: { lastFailure: { code: "invalid_output" } } });
		expect(h.engine.load(h.run).currentProposal).toBeUndefined();
		expect(h.engine.load(h.run).facts.quantity).toBeUndefined();
	});
	it("rejects model paths and invalidates a frozen attachment set after another upload", () => {
		const h = harness();
		expect(h.inspector.tool().validate({ attachmentId: "../../secret" })).toBe(false);
		expect(h.inspector.tool().validate({ attachmentId: h.stored.attachmentId, path: "/etc/passwd" })).toBe(false);
		h.attachments.put(h.scope, { requestId: "upload-2", name: "revision.txt", mediaType: "text/plain", content: Buffer.from("Changed quantity") });
		expect(() => h.inspector.scope(h.run)).toThrow("资料已变化");
	});
	it("does not copy customer bytes through a staging-directory symlink", async () => {
		const h = harness();
		const outside = mkdtempSync(join(tmpdir(), "blackx-staging-outside-")); directories.push(outside);
		symlinkSync(outside, join(h.root, ".blackx-tool-inputs"));
		expect(await h.scheduler.runNext()).toMatchObject({ status: "dead_letter" });
		expect(readdirSync(outside)).toEqual([]);
		expect(h.engine.load(h.run).currentProposal).toBeUndefined();
	});
});

describe.skipIf(process.platform !== "darwin" || process.env.BLACKX_RUN_SEATBELT_TESTS !== "1")("native document product slice", () => {
	it("retains text beyond the legacy 8000-character parser limit", async () => {
		const h = harness(true, false, Buffer.from("x".repeat(9000)));
		expect(await h.scheduler.runNext()).toMatchObject({ status: "completed" });
		const inspection = h.inspector.readRecords(h.run)[0]!.inspection;
		expect(inspection).toMatchObject({ kind: "text", status: "parsed", truncated: false });
		expect(inspection.pages[0]!.text).toHaveLength(9000);
	}, 20_000);
	it("extracts pixel metadata without claiming image text or production dimensions", async () => {
		const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1EAAAAASUVORK5CYII=", "base64");
		const h = harness(true, false, pixel);
		expect(await h.scheduler.runNext()).toMatchObject({ status: "completed" });
		expect(h.inspector.readRecords(h.run)[0]!.inspection).toMatchObject({ kind: "image", status: "metadata_only", width: 1, height: 1, pages: [] });
	}, 20_000);

	it("runs Queue → Worker → Agent → real Seatbelt PDFKit → Artifact → export", async () => {
		expect(existsSync(".blackx-tools/asset-inspector")).toBe(true);
		const h = harness(true);
		expect(await h.scheduler.runNext()).toMatchObject({ status: "completed" });
		const delivery = (h.api.delivery(context, h.scope.conversationId, 1).body as { delivery: RequirementDelivery }).delivery;
		expect(delivery.sources[0]!.inspection).toMatchObject({ kind: "pdf", status: "parsed", pageCount: 1, pages: [{ page: 1, text: expect.stringContaining("Quantity: 5000") }] });
		expect(delivery.content.facts[0]!.status).toBe("unverified");
	}, 20_000);
	it("marks image-only PDF as needs OCR without inventing extracted text", async () => {
		const h = harness(true, false, documentFixture(""));
		expect(await h.scheduler.runNext()).toMatchObject({ status: "completed" });
		expect(h.inspector.readRecords(h.run)[0]!.inspection).toMatchObject({ status: "needs_ocr", pages: [{ page: 1, text: "" }] });
	}, 20_000);
});
