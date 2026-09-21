import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SkillRegistry } from "../src/agent/skills";
import { KnowledgeError } from "../src/enterprise/knowledge";
import { coffeeKnowledgeFixtures } from "../src/manufacturing/knowledgeFixtures";
import { packagingRetrievalPolicy } from "../src/manufacturing/knowledgeRetrieval";
import { BlackxAgentRuntime } from "../server/runtime/agentRuntime";
import { FileAgentStateStore } from "../server/runtime/fileAgentStateStore";
import { ConversationFileService } from "../server/runtime/conversationFiles";
import { LocalFileAccess } from "../server/runtime/localFileAccess";
import { KnowledgeStore } from "../server/knowledge/store";
import { FakeEmbedding } from "../server/knowledge/embedding";
import { FakeReranker } from "../server/knowledge/reranking";
import type { AgentToolExecutionRecord } from "../src/agent/contracts";

if (process.argv.includes("--online")) throw new Error("This recovery evaluation is offline only");
const scope = { tenantId: "fixture", workspaceId: "fixture", runId: "task", actorId: "operator" };
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
async function recovery(enabled: boolean, status: "started" | "unknown") {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "packx-recovery-eval-")));
	const diskApply = LocalFileAccess.prototype.apply;
	let writes = 0;
	LocalFileAccess.prototype.apply = function (...args) { const result = diskApply.apply(this, args); writes++; return result; };
	try {
		const files = new ConversationFileService(join(root, "files"), () => {}), state = new FileAgentStateStore(join(root, "ledger"));
		const input = { path: join(root, "draft.md"), expectedSha256: null, content: "100 µm; no PVC; supplier qualification unresolved" };
		const request = { ...scope, stageId: "conversation", tool: "file_write", toolCallId: "write", executionId: "interrupted", idempotencyKey: "write-once", risk: "write" as const, input };
		const waiting = files.authorize(request); files.decide(scope, files.list(scope).approvals[0].id, "approved");
		const approvalId = (await waiting).approvalId!;
		const record: AgentToolExecutionRecord = { schemaVersion: "tool-execution.v1", ...scope, stageId: request.stageId, tool: request.tool, toolCallId: request.toolCallId, executionId: request.executionId, idempotencyKey: request.idempotencyKey, risk: "write", inputDigest: sha(JSON.stringify(input)), approvalId, status: "started", startedAt: new Date().toISOString() };
		await state.claim(record);
		files.apply("write", input, { ...request, approvalId, signal: new AbortController().signal });
		// Fault boundary: the file receipt committed, but execution completion did not.
		if (status === "unknown") await state.complete(record, { status, result: "uncertain", resultDigest: sha("uncertain"), completedAt: new Date().toISOString() });
		const restarted = new FileAgentStateStore(join(root, "ledger")), recoveredFiles = new ConversationFileService(join(root, "files"), () => {});
		let modelCalls = 0;
		const runtime = new BlackxAgentRuntime({ skills: new SkillRegistry(), sessions: restarted, snapshots: restarted, executions: restarted, traces: restarted, tools: recoveredFiles.tools(),
			...(enabled ? { recoverToolExecution: (record: AgentToolExecutionRecord, signal: AbortSignal) => recoveredFiles.reconcile(record, signal) } : {}),
			provider: { generate: async (request) => { modelCalls++; const ready = request.messages.some((message) => message.kind === "receipt" && message.content.includes('"status":"succeeded"'));
				return { text: ready ? "ready_for_next_step" : "reconciliation_required", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } }; } } });
		const start = performance.now();
		const result = await runtime.executeTurn({ ...scope, stageId: "conversation", sessionId: "task", idempotencyKey: "continue", input: "Continue only when the earlier operation is verified", allowedTools: ["file_write"], fallbackOutput: "", policy: { sandboxMode: "workspace-write", approvalPolicy: "required", timeoutMs: 2000 } });
		const after = (await restarted.find(record))!;
		assert.equal(readFileSync(input.path, "utf8"), input.content); assert.equal(writes, 1);
		assert.equal(after.status === "succeeded", enabled); assert.equal(result.finalResponse === "ready_for_next_step", enabled);
		return { initialStatus: status, recoveryEnabled: enabled, unresolvedAfter: after.status === "succeeded" ? 0 : 1, continuationReady: result.finalResponse === "ready_for_next_step", physicalWrites: writes, duplicateWrites: writes - 1, modelCalls, recoveryEvents: result.events.filter((event) => event.type === "tool.reconciled").length, elapsedMs: Number((performance.now() - start).toFixed(3)) };
	} finally { LocalFileAccess.prototype.apply = diskApply; rmSync(root, { recursive: true, force: true }); }
}
async function retrieval(policy: "strict" | "degrade", failure: "embedding" | "reranking") {
	const root = mkdtempSync(join(tmpdir(), "packx-retrieval-recovery-eval-")), embedding = new FakeEmbedding(), reranker = new FakeReranker();
	const store = new KnowledgeStore(root, embedding, undefined, undefined, packagingRetrievalPolicy, reranker, policy);
	try {
		const fixture = coffeeKnowledgeFixtures()[0]; fixture.blocks = [{ text: "coffee packaging; no PVC; 100 µm; 23 °C, 50% RH", location: { section: "conditions", paragraph: 1 }, parameters: [] }];
		const doc = store.import(scope, fixture, "operator"); await store.process(scope, doc.versionId);
		let embeddingCalls = 0, rerankCalls = 0; const embed = embedding.embed.bind(embedding);
		embedding.embed = async (texts) => { embeddingCalls++; if (failure === "embedding") throw new KnowledgeError("local_embedding_unavailable", 503); return embed(texts); };
		reranker.score = async () => { rerankCalls++; throw new Error("temporary reranker outage"); };
		const start = performance.now();
		const result = await store.search(scope, { query: "coffee", mode: "hybrid" }).catch((error) => { if (error instanceof KnowledgeError && error.code === "local_embedding_unavailable") return undefined; throw error; });
		assert.equal(Boolean(result?.hits.length), policy === "degrade");
		assert.equal(Boolean(result?.degradation), policy === "degrade");
		if (result?.hits.length) assert.equal(result.hits[0].text, fixture.blocks[0].text);
		return { policy, failure, status: result?.status ?? "failed", candidateCount: result?.hits.length ?? 0, markedDegraded: Boolean(result?.degradation), effectiveMode: result?.degradation?.effectiveMode ?? null, embeddingCalls, rerankCalls, generationCalls: 0, elapsedMs: Number((performance.now() - start).toFixed(3)) };
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}
const report = { schemaVersion: "reliability-recovery-eval.v1", mode: "offline-fault-injection", referenceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	baseline: "Same fixture with recovery disabled / strict retrieval; represents prior behavior, not a checkout replay", paidCalls: 0, semanticQuality: "NOT_EVALUATED", latencyMetric: "Local Fake and filesystem elapsed time; not real model latency", tokens: "Not measured; no real model token usage",
	execution: [await recovery(false, "started"), await recovery(true, "started"), await recovery(false, "unknown"), await recovery(true, "unknown")],
	retrieval: [await retrieval("strict", "reranking"), await retrieval("degrade", "reranking"), await retrieval("strict", "embedding"), await retrieval("degrade", "embedding")] };
if (process.argv.includes("--write")) writeFileSync("docs/evidence/reliability-recovery.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
