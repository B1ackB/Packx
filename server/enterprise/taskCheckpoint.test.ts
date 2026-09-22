import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "../../src/agent/contracts";
import { InMemoryAgentStateStore } from "../../src/agent/state";
import { SkillRegistry } from "../../src/agent/skills";
import { BlackxAgentRuntime } from "../runtime/agentRuntime";
import { buildTaskContext } from "./taskContext";
import { checkpointSourceDigest, TaskCheckpointStore } from "./taskCheckpointStore";
import { PersonalMemoryService } from "./personalMemoryService";
import { PersonalMemoryStore } from "./personalMemoryStore";
import type { TaskCheckpointDraft } from "../../src/enterprise/taskCheckpoint";

const scope = { tenantId: "t", workspaceId: "w", runId: "r" };
const draft: TaskCheckpointDraft = { objective: "比较咖啡包装候选", constraints: ["不得使用 PVC", "厚度 100 µm", "使用中文说明"], openQuestions: ["供应商资质仍待核验"], progressNotes: "已列出候选；尚未通过业务验收。结果引用保留在当前 Artifact。" };
const user = (index: number, content = "普通讨论".repeat(200)): AgentMessage => ({ role: "user", kind: "dialogue", messageId: `u-${index}`, content });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function store() {
	const directory = mkdtempSync(join(tmpdir(), "packx-task-checkpoint-")), path = join(directory, "checkpoint.sqlite");
	const records = new TaskCheckpointStore(path);
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }), () => records.close());
	return { records, path };
}
function propose(records: TaskCheckpointStore, transcript: AgentMessage[], value = draft) {
	const state = records.read(scope);
	return records.command(scope, "owner", transcript, { action: "propose", requestId: `propose-${state.revision}`, revision: state.revision, sourceDigest: checkpointSourceDigest(transcript), draft: value });
}
function confirm(records: TaskCheckpointStore, transcript: AgentMessage[]) {
	const state = records.read(scope);
	return records.command(scope, "owner", transcript, { action: "confirm", requestId: `confirm-${state.revision}`, revision: state.revision, confirmed: true });
}

it("only an exact explicit confirmation replaces old conversation requirements; original data and current Facts remain separate", () => {
	const { records } = store();
	const transcript = Array.from({ length: 100 }, (_, i) => user(i));
	propose(records, transcript);
	expect(records.active(scope, transcript)).toBeUndefined();
	expect(() => buildTaskContext({ scope, objective: "continue", transcript })).toThrow("application limit");
	confirm(records, transcript);
	transcript.push(user(100, "新要求：只比较可回收候选。数量修改仍须确认。"));
	const checkpoint = records.active(scope, transcript);
	const result = buildTaskContext({ scope, objective: "continue", transcript, checkpoint, state: { ...scope, aggregateVersion: 3, status: "running", stageStatus: "running", facts: { quantity: { key: "quantity", value: 6000, version: 2, status: "unverified", sourceRef: "human-input", sourceType: "human_confirmation" } }, factVersions: { quantity: 2 }, proposalVersions: [] } });
	const data = JSON.parse(result.content);
	expect(result.content.length).toBeLessThan(5000);
	expect(data.userDecisions.map((item: { messageId: string }) => item.messageId)).toEqual(["u-100"]);
	expect(data.checkpoint.constraints).toContain("不得使用 PVC");
	expect(data.facts[0]).toMatchObject({ value: 6000, version: 2, status: "unverified" });
	expect(data.stage.status).toBe("running");
	expect(transcript).toHaveLength(101);
	expect(data.earlierDialogue).toMatchObject({ readTool: "context_read", sourceRef: "transcript", messageCount: 100 });
});

it("keeps task context bounded over repeated explicitly reviewed stages and retains historical versions", () => {
	const { records } = store(), transcript: AgentMessage[] = [];
	for (let stage = 0; stage < 12; stage++) {
		for (let i = 0; i < 40; i++) transcript.push(user(transcript.length));
		propose(records, transcript, { ...draft, progressNotes: `第 ${stage + 1} 阶段已整理；仍须核验供应商` }); confirm(records, transcript);
		const context = buildTaskContext({ scope, objective: "continue", transcript, checkpoint: records.active(scope, transcript) });
		expect(context.content.length).toBeLessThan(4000);
		expect(context.content).toContain("不得使用 PVC");
	}
	expect(transcript).toHaveLength(480);
	expect(records.read(scope).versions.filter((v) => v.status === "superseded")).toHaveLength(11);
});

it("rejects stale source confirmation and changed or deleted checkpoint source prefixes", () => {
	const { records } = store(), transcript = [user(0)];
	propose(records, transcript);
	expect(() => confirm(records, [...transcript, user(1)])).toThrow("source_changed");
	confirm(records, transcript);
	expect(() => records.active(scope, [user(0, "changed")])).toThrow("source_changed");
	expect(() => records.active(scope, [])).toThrow("source_changed");
});

it("keeps the active version during review, rejects candidates and deduplicates commands without reviving old versions", () => {
	const { records } = store(), transcript = [user(0)];
	propose(records, transcript); confirm(records, transcript);
	const first = records.active(scope, transcript);
	const pending = propose(records, transcript, { ...draft, constraints: ["改用英文"] });
	expect(records.active(scope, transcript)).toEqual(first);
	const command = { action: "reject", requestId: "reject", revision: pending.revision };
	const rejected = records.command(scope, "owner", transcript, command);
	expect(records.command(scope, "owner", transcript, command)).toEqual(rejected);
	expect(records.active(scope, transcript)).toEqual(first);
	expect(() => records.command(scope, "owner", transcript, { ...command, action: "confirm", confirmed: true })).toThrow("command_conflict");
	expect(() => records.command(scope, "owner", transcript, { action: "confirm", requestId: "bad-confirm", revision: rejected.revision })).toThrow("invalid_task_checkpoint_command");
});

it("persists isolated state and fails closed on corrupt records and invalid input", () => {
	const { records, path } = store(), transcript = [user(0)];
	propose(records, transcript); confirm(records, transcript);
	const reopened = new TaskCheckpointStore(path); cleanups.push(() => reopened.close());
	expect(reopened.active(scope, transcript)?.constraints).toContain("不得使用 PVC");
	for (const other of [{ ...scope, tenantId: "other" }, { ...scope, workspaceId: "other" }, { ...scope, runId: "other" }]) expect(reopened.read(other).versions).toEqual([]);
	expect(() => propose(records, transcript, { ...draft, constraints: ["x".repeat(401)] })).toThrow("invalid_task_checkpoint");
	const db = new DatabaseSync(path); cleanups.push(() => db.close());
	db.exec("UPDATE task_checkpoint_events SET state='{}'");
	expect(() => records.read(scope)).toThrow("store_invalid");
});

it("rolls back failed confirmation audit writes and can retry the identical command after recovery", () => {
	const { records, path } = store(), transcript = [user(0)]; propose(records, transcript);
	const before = records.read(scope), db = new DatabaseSync(path); cleanups.push(() => db.close());
	db.exec("CREATE TRIGGER fail_confirm BEFORE INSERT ON task_checkpoint_events WHEN NEW.type='task_checkpoint.confirm' BEGIN SELECT RAISE(ABORT,'synthetic_disk_failure'); END;");
	expect(() => confirm(records, transcript)).toThrow("synthetic_disk_failure");
	expect(records.read(scope)).toEqual(before);
	db.exec("DROP TRIGGER fail_confirm"); confirm(records, transcript);
	expect(records.active(scope, transcript)?.version).toBe(1);
});

it("rebuilds old derived context on confirmation and rejects a paused turn with an obsolete checkpoint", async () => {
	const { records } = store(), transcript = [user(0, "旧讨论：obsolete-draft-marker")];
	const state = new InMemoryAgentStateStore(), session = { ...scope, sessionId: "r" };
	state.save(session, 0, [...transcript, { role: "assistant", content: "obsolete-draft-marker" }], new Date().toISOString());
	propose(records, transcript); confirm(records, transcript);
	const generate = vi.fn(async (request: import("../../src/agent/contracts").AgentModelRequest) => {
		expect(JSON.stringify(request.messages)).not.toContain("obsolete-draft-marker");
		expect(JSON.stringify(request.messages)).toContain("继续");
		return { text: "done", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
	});
	const runtime = new BlackxAgentRuntime({ provider: { generate }, skills: new SkillRegistry(), sessions: state, snapshots: state, traces: state, readTaskContext: () => buildTaskContext({ scope, objective: "continue", transcript, checkpoint: records.active(scope, transcript) }) });
	const request = { ...scope, sessionId: "r", actorId: "owner", stageId: "conversation", idempotencyKey: "new-turn", input: "继续", fallbackOutput: "", policy: { sandboxMode: "read-only" as const, approvalPolicy: "never" as const, timeoutMs: 5000 } };
	const result = await runtime.executeTurn(request);
	expect(result.events.some((event) => event.type === "context.rebuilt")).toBe(true);
	expect(state.load(session).transcript?.some((m) => m.role === "assistant" && m.content === "obsolete-draft-marker")).toBe(true);
	const current = state.load(session);
	state.save(session, current.revision, current.messages, new Date().toISOString(), { turnKey: "paused", contextBinding: "old-binding" });
	await expect(runtime.executeTurn({ ...request, idempotencyKey: "paused", resume: true })).rejects.toMatchObject({ code: "context_failure", retryable: false });
	expect(generate).toHaveBeenCalledTimes(1);
});

it("composes task and personal-memory dependencies idempotently for conversation and frozen Plan inputs", () => {
	const { records } = store(), transcript = [user(0)]; propose(records, transcript); confirm(records, transcript);
	const memory = new PersonalMemoryStore(":memory:", () => true); cleanups.push(() => memory.close());
	const service = new PersonalMemoryService(memory, { getSession: () => undefined });
	const base = buildTaskContext({ scope, objective: "continue", transcript, checkpoint: records.active(scope, transcript) });
	const first = service.context({ ...scope, actorId: "owner" }, base);
	expect(service.context({ ...scope, actorId: "owner" }, first).historyBinding).toBe(first.historyBinding);
	expect(service.context({ ...scope, actorId: "owner" }, { content: first.content, binding: first.binding }).historyBinding).toBe(first.historyBinding);
	propose(records, transcript, { ...draft, constraints: ["改用英文"] }); confirm(records, transcript);
	const revised = service.context({ ...scope, actorId: "owner" }, buildTaskContext({ scope, objective: "continue", transcript, checkpoint: records.active(scope, transcript) }));
	expect(revised.historyBinding).not.toBe(first.historyBinding);
});
