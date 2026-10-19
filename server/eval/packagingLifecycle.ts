import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AgentModelProvider, AgentToolApprovalPort, AgentToolExecutionRecord } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { manufacturingSkills } from "../../src/manufacturing/skills";
import { requiredRequirementFacts } from "../../src/manufacturing/requirementBrief";
import type { ConversationView, RequirementBriefWorkspaceView } from "../../src/runtime/conversationContracts";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { FileEnterpriseEventStore } from "../enterprise/fileEventStore";
import { FileStageJobQueue } from "../enterprise/fileStageJobQueue";
import { RequirementBriefWorkspaceApiController } from "../manufacturing/requirementBriefApi";
import { RequirementBriefWorker } from "../manufacturing/requirementBriefWorker";
import { BlackxAgentRuntime } from "../runtime/agentRuntime";
import { ConversationApiController } from "../runtime/conversationApi";
import { FileConversationAttachmentStore } from "../runtime/conversationAttachments";
import { ConversationFileService } from "../runtime/conversationFiles";
import { FileAgentStateStore } from "../runtime/fileAgentStateStore";
import { LocalFileAccess } from "../runtime/localFileAccess";
import { createProjectSourceReadTool } from "../runtime/requirementTools";
import { StageJobOutbox } from "../workers/stageJobOutbox";
import { StageJobScheduler } from "../workers/stageJobScheduler";

export const lifecycleCases = ["delivery", "restart", "duplicate", "cancel", "permission", "unknown_effect"] as const;
export const lifecycleBudget = { modelCallsPerCase: 24, syntheticTokensPerCall: 40, toolCallsPerCase: 12 };
const context = { tenantId: "lifecycle-tenant", workspaceId: "lifecycle-workspace", actorId: "lifecycle-user" };
const usage = { inputTokens: 32, outputTokens: 8, cachedInputTokens: 0, reasoningOutputTokens: 0 };
const input = "模拟客户资料：10000 个咖啡豆自立拉链袋，160 × 230 + 80 mm，香港市场，2026-11-30 香港交货，品牌稿件待提供。";
const values: Record<string, string | number> = { product_type: "咖啡豆自立拉链袋", quantity: 10000, dimensions: "160 × 230 + 80 mm", target_market: "香港", target_delivery: "2026-11-30", delivery_location: "香港", artwork_status: "品牌稿件待提供" };
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export async function runPackagingLifecycle(directory: string) {
	const results = [];
	for (const name of lifecycleCases) {
		const root = join(realpathSync(directory), name); mkdirSync(root);
		let modelCalls = 0, toolCalls = 0, humanDecisions = 0, manualInterventions = 0, physicalWrites = 0, delivered = false;
		const diskApply = LocalFileAccess.prototype.apply;
		LocalFileAccess.prototype.apply = function (...args) { physicalWrites++; return diskApply.apply(this, args); };
		const errors: string[] = [], checks: string[] = [];
		const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks.push(label); };
		const meter: AgentModelProvider["generate"] = async (request) => {
			assert.ok(++modelCalls <= lifecycleBudget.modelCallsPerCase, "fixed model budget exceeded");
			const review = request.outputSchema?.properties && "issues" in (request.outputSchema.properties as object);
			if (!review && request.tools.some((tool) => tool.name === "project_source_read") && !request.messages.some((message) => message.role === "tool")) {
				assert.ok(++toolCalls <= lifecycleBudget.toolCallsPerCase);
				return { text: "", toolCalls: [{ id: `source-${modelCalls}`, name: "project_source_read", input: { sourceId: "customer-brief" } }], usage };
			}
			return { text: review ? '{"issues":[]}' : request.fallbackOutput, toolCalls: [], usage };
		};
		const build = () => {
			const state = new FileAgentStateStore(join(root, "agent"));
			const events = new FileEnterpriseEventStore(join(root, "events.json"));
			const engine = new ProposalRunEngine(events, "requirement-brief");
			const attachments = new FileConversationAttachmentStore(join(root, "attachments"));
			const runtime = new BlackxAgentRuntime({ provider: { generate: meter }, skills: new SkillRegistry(manufacturingSkills), sessions: state, snapshots: state, executions: state, tools: [createProjectSourceReadTool(engine, attachments)] });
			const conversations = new ConversationApiController(runtime, state, () => "2026-10-16T00:00:00Z", () => "lifecycle-conversation");
			const artifacts = new FileArtifactContentStore(join(root, "artifacts"));
			const queue = new FileStageJobQueue(join(root, "queue.json"));
			const outbox = new StageJobOutbox(engine, events, queue);
			const worker = new RequirementBriefWorker(engine, runtime, artifacts, attachments, undefined, undefined, undefined, conversations);
			const scheduler = new StageJobScheduler(queue, { workerId: "lifecycle", handlers: { "requirement-brief": (lease, signal, guard) => worker.executeLease(lease, signal, guard) } });
			return { state, attachments, engine, scheduler, controller: new RequirementBriefWorkspaceApiController(conversations, engine, artifacts, outbox, scheduler, attachments), conversations };
		};
		let h = build();
		try {
			const conversationId = (h.conversations.create(context).body as { conversation: ConversationView }).conversation.conversationId;
			const scope = { ...context, runId: conversationId, sessionId: conversationId };
			const stored = h.state.getSession(scope)!;
			h.state.save(scope, stored.revision, [{ role: "user", content: input, messageId: "customer-input", pinned: true }], "2026-10-16T00:01:00Z");
			h.attachments.put({ ...context, conversationId }, { requestId: "source", name: "customer.txt", mediaType: "text/plain", content: Buffer.from(input) });
			const view = () => (h.controller.get(context, conversationId).body as { requirementBrief: RequirementBriefWorkspaceView }).requirementBrief;
			check("initial request accepted", (await h.controller.start(context, conversationId, { requestId: "initial", industry: "print" })).status === 202);
			const initial = await h.scheduler.runNext();
			check("source stage executed", initial.status === "completed");
			check("unconfirmed input cannot approve", view().state.stageStatus === "needs_input");
			for (const key of requiredRequirementFacts.print) {
				check(`record ${key}`, h.controller.recordFact(context, conversationId, { requestId: `record-${key}`, key, value: values[key] }).status === 200);
				const state = view().state;
				check(`confirm ${key}`, h.controller.resolveFact(context, conversationId, key, { requestId: `verify-${key}`, decision: "verified", expectedFactVersion: state.facts[key].version, expectedAggregateVersion: state.aggregateVersion }).status === 200); humanDecisions++;
			}
			await h.controller.start(context, conversationId, { requestId: "generate", industry: "print" });
			check("requirement generated", (await h.scheduler.runNext()).status === "completed");
			const before = view().state;
			check("approval is version bound", before.stageStatus === "waiting_approval" && before.approval?.artifactVersion === before.currentProposal?.version);
			if (name === "cancel") {
				check("cancel accepted", h.controller.cancel(context, conversationId, { requestId: "cancel" }).status === 200);
				h = build(); await h.scheduler.runNext();
				check("cancel survives restart", view().state.stageStatus === "cancelled");
				const response = h.controller.delivery(context, conversationId, before.currentProposal!.version);
				check("cancel cannot deliver approved output", response.status !== 200 || (response.body as { delivery: { status: string } }).delivery.status !== "approved");
				errors.push("cancelled");
			} else {
				const approval = { requestId: "approve", decision: "approved", approvalId: before.approval!.approvalId, artifactVersion: before.approval!.artifactVersion, expectedAggregateVersion: before.aggregateVersion };
				const approved = h.controller.resolveApproval(context, conversationId, approval);
				check("human artifact approval accepted", approved.status === 202); humanDecisions++;
				if (name === "restart") h = build();
				await h.scheduler.runNext();
				check("approved workflow passed", view().state.stageStatus === "passed");
				if (name === "duplicate") {
					const calls = modelCalls, version = view().state.currentProposal!.version;
					check("approval replay accepted", [200, 202].includes(h.controller.resolveApproval(context, conversationId, approval).status));
					await h.scheduler.runNext();
					check("approval replay creates no work or version", calls === modelCalls && version === view().state.currentProposal!.version);
				}
				const deliveryResponse = h.controller.delivery(context, conversationId, before.currentProposal!.version);
				const delivery = (deliveryResponse.body as { delivery: { status: string; citations: Record<string, string>; content: unknown } }).delivery;
				check("delivery has approval and source citations", deliveryResponse.status === 200 && delivery.status === "approved" && Object.keys(delivery.citations).length === 7);
				check("cross tenant cannot read delivery", h.controller.delivery({ ...context, tenantId: "other" }, conversationId, before.currentProposal!.version).status === 404);
				const exports = join(root, "exports"); mkdirSync(exports);
				const path = join(exports, "delivery.md"), content = `DELIVERY_FIXTURE\n${JSON.stringify(delivery, null, 2)}\n`;
				const assertScope = (candidate: typeof context & { runId: string }) => { assert.equal(candidate.tenantId, scope.tenantId); assert.equal(candidate.workspaceId, scope.workspaceId); assert.equal(candidate.actorId, scope.actorId); assert.equal(candidate.runId, scope.runId); };
				let files = new ConversationFileService(join(root, "files"), assertScope);
				const mutation = { path, content, expectedSha256: null };
				const request: Parameters<AgentToolApprovalPort["authorize"]>[0] = { ...scope, stageId: "conversation", executionId: "export", tool: "file_write", toolCallId: "export", risk: "write", idempotencyKey: "export", input: mutation };
				const waiting = files.authorize(request); files.decide(scope, files.list(scope).approvals[0].id, "approved"); humanDecisions++;
				const approvalId = (await waiting).approvalId!;
				const ledger: AgentToolExecutionRecord = { ...request, approvalId, schemaVersion: "tool-execution.v1", inputDigest: sha(JSON.stringify(mutation)), status: "started", startedAt: new Date().toISOString() };
				await h.state.claim(ledger);
				files.apply("write", mutation, { ...request, approvalId, signal: new AbortController().signal });
				if (name !== "unknown_effect") await h.state.complete(ledger, { status: "succeeded", result: "exported", resultDigest: sha("exported"), completedAt: new Date().toISOString() });
				check("approved bytes delivered", readFileSync(path, "utf8") === content); delivered = true;
				if (name === "duplicate") {
					const count = files.list(scope).files.length;
					files.apply("write", mutation, { ...request, approvalId, signal: new AbortController().signal });
					check("export duplicate creates no new version or physical write", physicalWrites === 1 && files.list(scope).files.length === count && readFileSync(path, "utf8") === content);
				}
				if (name === "permission") {
					// Establish a genuine model/tool session, then restore it under a narrower Host policy.
					const readTurn = { ...scope, sessionId: "permission-read", stageId: "conversation", idempotencyKey: "read", input: "读取交付备份", allowedTools: ["file_read"], fallbackOutput: "", policy: { sandboxMode: "workspace-write" as const, approvalPolicy: "required" as const, timeoutMs: 2000 } };
					const reader = (service: ConversationFileService, call: boolean) => new BlackxAgentRuntime({ sessions: h.state, snapshots: h.state, tools: service.tools(), skills: new SkillRegistry(), provider: { generate: async (request) => { await meter({ ...request, tools: [] }); if (call && !request.messages.some((m) => m.role === "tool")) { toolCalls++; return { text: "", toolCalls: [{ id: "historical-read", name: "file_read", input: { path, version: 1 } }], usage }; } return { text: "read complete", toolCalls: [], usage }; } } });
					await reader(files, true).executeTurn(readTurn);
					files = new ConversationFileService(join(root, "files"), assertScope, Date.now, [exports]);
					manualInterventions++;
					let denied = false; try { files.readLocal(scope, path); } catch { denied = true; } check("live read denied after policy tightening", denied);
					denied = false; try { files.read(scope, path, 1); } catch { denied = true; }
					// Record both paths even when the first assertion fails on the baseline.
					const beforeCalls = modelCalls;
					let contextDenied = false; try { await reader(files, false).executeTurn({ ...readTurn, idempotencyKey: "resume", input: "继续使用上次内容" }); } catch (error) { contextDenied = (error as { code?: string }).code === "context_failure"; }
					if (!denied) errors.push("permission_history_bypass"); if (!contextDenied) errors.push("permission_context_replay");
					check("historical read denied after policy tightening", denied);
					check("cached source denied before next model call", contextDenied && modelCalls === beforeCalls); errors.push("permission_denied");
				} else if (name === "unknown_effect") {
					await h.state.complete(ledger, { status: "unknown", result: "worker crashed after external commit", resultDigest: sha("worker crashed after external commit"), completedAt: new Date().toISOString() });
					h = build(); files = new ConversationFileService(join(root, "files"), assertScope);
					const runtime = new BlackxAgentRuntime({ sessions: h.state, snapshots: h.state, executions: h.state, tools: files.tools(), skills: new SkillRegistry(), recoverToolExecution: (record, signal) => files.reconcile(record, signal), provider: { generate: async (request) => { await meter({ ...request, tools: [] }); return { text: "recovery inspected", toolCalls: [], usage }; } } });
					const turn = { ...scope, sessionId: "recover", stageId: "conversation", idempotencyKey: "recover", input: "核验原操作，禁止重发", allowedTools: ["file_write"], fallbackOutput: "", policy: { sandboxMode: "workspace-write" as const, approvalPolicy: "required" as const, timeoutMs: 2000 } };
					const recovered = await runtime.executeTurn(turn);
					check("receipt resolves unknown without replay", (await h.state.find(ledger))?.status === "succeeded" && recovered.events.some((event) => event.type === "tool.reconciled") && files.list(scope).files.length === 1);
					const unresolved = { ...ledger, idempotencyKey: "unperformed", approvalId: "missing-evidence", toolCallId: "unperformed", status: "started" as const };
					await h.state.claim(unresolved);
					await runtime.executeTurn({ ...turn, idempotencyKey: "unresolved" });
					check("missing evidence stays unresolved without physical replay", physicalWrites === 1 && (await h.state.find(unresolved))?.status === "started" && files.list(scope).files.length === 1); manualInterventions++; errors.push("unknown_side_effect_requires_review");
				}
			}
			results.push({ name, passed: true, delivered, modelCalls, syntheticTokens: modelCalls * 40, toolCalls, humanDecisions, manualInterventions, physicalWrites, errors, checks });
		} catch (error) {
			results.push({ name, passed: false, delivered, modelCalls, syntheticTokens: modelCalls * 40, toolCalls, humanDecisions, manualInterventions, physicalWrites, errors, checks, failure: (error as Error).message });
		} finally { LocalFileAccess.prototype.apply = diskApply; }
	}
	return { schemaVersion: "packaging-lifecycle-eval.v1", mode: "offline-synthetic-controller-and-runtime", budget: lifecycleBudget, paidCalls: 0, semanticQuality: "NOT_EVALUATED", cases: results, passed: results.every((result) => result.passed), safetyAcceptance: results.filter((result) => result.passed).length / results.length, delivered: results.filter((result) => result.delivered).length, modelCalls: results.reduce((sum, result) => sum + result.modelCalls, 0), humanDecisions: results.reduce((sum, result) => sum + result.humanDecisions, 0), manualInterventions: results.reduce((sum, result) => sum + result.manualInterventions, 0) };
}
