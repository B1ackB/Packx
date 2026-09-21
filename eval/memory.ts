import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { PersonalMemoryStore } from "../server/enterprise/personalMemoryStore";
import { PersonalMemoryService, memorySourceAvailable } from "../server/enterprise/personalMemoryService";
import { FileAgentStateStore } from "../server/runtime/fileAgentStateStore";
import { BlackxAgentRuntime } from "../server/runtime/agentRuntime";
import { ConversationApiController } from "../server/runtime/conversationApi";
import { buildTaskContext } from "../server/enterprise/taskContext";
import { SkillRegistry } from "../src/agent/skills";
import { estimateRequestTokens } from "../src/agent/tokenBudget";
import type { ConversationView } from "../src/runtime/conversationContracts";
import type { AgentModelProvider } from "../src/agent/contracts";

if (process.argv.includes("--online")) throw new Error("Real semantic memory evaluation requires separate authorization; this command is offline only.");
const root = mkdtempSync(join(tmpdir(), "packx-memory-eval-"));
const identity = { tenantId: "eval", workspaceId: "w", actorId: "owner" };
const fixtures = { oldPreference: "PREF_A: 简洁中文", newPreference: "PREF_B: 详细英文", constraints: ["不得使用 PVC", "厚度 100 µm", "未解决：供应商测试条件", "source: sheet-A#row3"] };
let sessions = new FileAgentStateStore(root);
const memory = new PersonalMemoryStore(join(root, "memory.sqlite"), (scope, source) => memorySourceAvailable(sessions, scope, source));
const service = new PersonalMemoryService(memory, { getSession: (scope) => sessions.getSession(scope) });
const observed: Array<{ text: string; estimatedInputTokens: number }> = [];
const provider: AgentModelProvider = { generate: async (request) => {
	const text = JSON.stringify(request.messages); observed.push({ text, estimatedInputTokens: estimateRequestTokens(request) });
	return { text: text.includes(fixtures.newPreference) ? fixtures.newPreference : text.includes(fixtures.oldPreference) ? fixtures.oldPreference : "No personal preference", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
} };
function api() {
	return new ConversationApiController(new BlackxAgentRuntime({ provider, skills: new SkillRegistry(), sessions, snapshots: sessions, traces: sessions, executions: sessions,
		readTaskContext: (req) => service.context(identity, buildTaskContext({ scope: req, objective: fixtures.constraints.join("; "), transcript: sessions.load({ ...req, sessionId: req.sessionId ?? req.runId }).transcript })) }), sessions);
}
const timings: number[] = [];
try {
	let controller = api();
	const source = (controller.create(identity).body as { conversation: ConversationView }).conversation.conversationId;
	const other = (controller.create(identity).body as { conversation: ConversationView }).conversation.conversationId;
	const send = async (index: number) => {
		const start = performance.now(); const result = await controller.send(identity, other, { messageId: `turn-${index}`, content: `整理当前工作 ${index}` });
		timings.push(performance.now() - start); assert.equal(result.status, 200);
	};
	await send(0); // Frozen pre-memory behavior: tasks cannot recall another task's preference.
	assert(!observed[0].text.includes(fixtures.oldPreference));
	assert.equal(service.handle(identity, source, { action: "propose", requestId: "propose", draft: { topic: "报告风格", content: fixtures.oldPreference } }).status, 200);
	let item: import("../src/enterprise/personalMemory").PersonalMemory = memory.view(identity).items[0];
	assert.equal(memory.recall(identity).items.length, 0);
	memory.decide(identity, "confirm", item.id, item.revision, "confirm");
	sessions = new FileAgentStateStore(root); controller = api(); await send(1);
	assert(observed[1].text.includes(fixtures.oldPreference));
	for (const target of [{ ...identity, actorId: "other" }, { ...identity, tenantId: "other" }, { ...identity, workspaceId: "other" }]) assert.equal(memory.recall(target).items.length, 0);
	item = memory.view(identity).items[0];
	item = memory.propose(identity, "revise", { topic: "报告风格", content: fixtures.newPreference }, item.versions[0].source, item.id, item.revision);
	assert.equal(memory.recall(identity).items[0].version, 1);
	item = memory.decide(identity, "confirm-revision", item.id, item.revision, "confirm");
	await send(2); assert(observed[2].text.includes(fixtures.newPreference)); assert(!observed[2].text.includes(fixtures.oldPreference));
	memory.decide(identity, "forget", item.id, item.revision, "forget"); await send(3);
	assert(!observed[3].text.includes(fixtures.newPreference)); assert(!observed[3].text.includes(fixtures.oldPreference));
	const transcript = sessions.load({ ...identity, runId: other, sessionId: other }).transcript!;
	assert.equal(transcript.length, 8); assert(transcript.some((m) => m.content === fixtures.oldPreference));
	for (const input of observed) for (const constraint of fixtures.constraints) assert(input.text.includes(constraint));

	const report = { schemaVersion: "personal-memory-eval.v1", generatedAt: new Date().toISOString(), fixtureHash: createHash("sha256").update(JSON.stringify(fixtures)).digest("hex"), baseline: "No confirmed personal record; no cross-task preference in model input", execution: "deterministic Fake generation, real Enterprise SQLite, Runtime, Session and ContextEngine",
		checks: { baselineRecalls: 0, confirmedRecalls: 1, pendingNotRecalled: true, confirmedRevisionCorrect: true, revokedAbsentFromDerivedContext: true, uiTranscriptMessages: transcript.length, userConstraintsRetainedPerTurn: fixtures.constraints.length, restartPassed: true, isolation: ["actor", "tenant", "workspace"] },
		turns: observed.map((item, index) => ({ phase: ["baseline", "confirmed-after-restart", "revised", "forgotten"][index], estimatedInputTokens: item.estimatedInputTokens, durationMs: timings[index] })),
		generationCalls: observed.length, extraMemoryExtractionOrEmbeddingCalls: 0, paidCalls: 0, semanticQuality: "NOT_EVALUATED", tokenCount: "UTF-8/protocol heuristic, not provider usage; includes full Runtime instructions/tools. Fake latency is local mechanism overhead, not real model latency." };
	if (process.argv.includes("--write")) writeFileSync("docs/evidence/personal-memory-eval.json", JSON.stringify(report, null, "\t") + "\n");
	console.log(JSON.stringify(report, null, 2));
} finally { memory.close(); rmSync(root, { recursive: true, force: true }); }
