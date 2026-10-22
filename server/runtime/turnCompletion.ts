import { isStoredAgentMessages, isStoredRuntimeTrace } from "./fileAgentStateStore";
import { createHash } from "node:crypto";
import { appendTranscript, visibleDialogue, AgentStateStoreError, type AgentSessionScope, type AgentSessionState, type AgentSessionStore, type ContextSnapshotStore } from "../../src/agent/state";
import type { AgentMessage } from "../../src/agent/contracts";
import { RuntimeFailure, type RuntimeTraceRecord, type RuntimeTraceStore, type RuntimeTurnRequest, type RuntimeTurnResult } from "../../src/runtime/contracts";

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	return JSON.stringify(value);
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const stateDigest = (state: AgentSessionState) => digest({ messages: state.messages, transcript: state.transcript ?? [], checkpoint: state.checkpoint ?? null, historyBinding: state.historyBinding ?? null });
const snapshotId = (key: string) => `completion-${digest(key)}`;
const identity = (request: RuntimeTurnRequest, outputContractDigest?: string) => digest({ tenantId: request.tenantId, workspaceId: request.workspaceId, runId: request.runId, sessionId: request.sessionId, actorId: request.actorId, stageId: request.stageId, turnKey: request.idempotencyKey, input: request.input, attachments: request.attachments ?? [], outputContractDigest: outputContractDigest ?? null });

export interface TurnCompletion {
	schemaVersion: "turn-completion.v1";
	identity: string;
	baseRevision: number;
	baseDigest: string;
	targetDigest: string;
	messages: AgentMessage[];
	historyBinding?: string;
	trace: RuntimeTraceRecord;
}

/** The existing immutable snapshot port is the write-ahead intent; it is never model context. */
export function prepareCompletion(snapshots: ContextSnapshotStore, sessions: AgentSessionStore, scope: AgentSessionScope, request: RuntimeTurnRequest, trace: RuntimeTraceRecord, messages: AgentMessage[], expectedRevision: number): TurnCompletion {
	const base = sessions.load(scope);
	if (base.revision !== expectedRevision) throw new RuntimeFailure("session_conflict", "Session changed before completion preparation", true);
	const target = messages.map((message, index) => !message.messageId && visibleDialogue(message)
		? { ...message, messageId: `legacy-${base.revision}-${index}` } : message);
	const completion: TurnCompletion = {
		schemaVersion: "turn-completion.v1", identity: identity({ ...request, sessionId: scope.sessionId }, trace.outputContractDigest), baseRevision: base.revision, baseDigest: stateDigest(base),
		messages: target, ...(request.taskContext?.historyBinding ?? base.historyBinding ? { historyBinding: request.taskContext?.historyBinding ?? base.historyBinding } : {}),
		targetDigest: stateDigest({ revision: base.revision + 1, messages: target, transcript: appendTranscript(base.transcript ?? [], target, scope.sessionId), historyBinding: request.taskContext?.historyBinding ?? base.historyBinding }), trace,
	};
	const content = JSON.stringify(completion);
	snapshots.put({ ...scope, schemaVersion: "context-snapshot.v2", snapshotId: snapshotId(request.idempotencyKey), purpose: "archive", ...(request.taskContext ? { contextBinding: request.taskContext.binding } : {}), ...(request.taskContext?.historyBinding ? { historyBinding: request.taskContext.historyBinding } : {}),
		skills: [{ name: "host-turn-completion", version: "1" }], iteration: 1, messages: [{ role: "user", kind: "receipt", content }], estimatedChars: content.length, estimatedTokens: Math.ceil(content.length / 4), removedMessages: 0, createdAt: trace.completedAt });
	return completion;
}

function storedCompletion(snapshots: ContextSnapshotStore, scope: AgentSessionScope, key: string) {
	let snapshot;
	try { snapshot = snapshots.read(scope, snapshotId(key)); }
	catch (error) { if (error instanceof AgentStateStoreError && error.code === "not_found") return undefined; throw error; }
	let completion: TurnCompletion;
	try {
		completion = JSON.parse(snapshot.messages[0].content);
		if (snapshot.skills.length !== 1 || snapshot.skills[0].name !== "host-turn-completion" || snapshot.skills[0].version !== "1" || snapshot.messages.length !== 1 || completion.schemaVersion !== "turn-completion.v1" || !Number.isSafeInteger(completion.baseRevision) || completion.baseRevision < 0 || ![completion.baseDigest, completion.targetDigest, completion.identity].every(value => /^[a-f0-9]{64}$/.test(value)) || !isStoredAgentMessages(completion.messages) || !isStoredRuntimeTrace(completion.trace) || completion.trace.status !== "completed" || completion.trace.tenantId !== scope.tenantId || completion.trace.workspaceId !== scope.workspaceId || completion.trace.runId !== scope.runId || completion.trace.sessionId !== scope.sessionId || completion.trace.idempotencyKey !== key) throw new Error();
	} catch { throw new RuntimeFailure("context_failure", "Stored turn completion intent is invalid; preserve it for review", false); }
	return { completion, snapshot };
}

export function readCompletion(snapshots: ContextSnapshotStore, scope: AgentSessionScope, request: RuntimeTurnRequest, outputContractDigest?: string): TurnCompletion | undefined {
	const stored = storedCompletion(snapshots, scope, request.idempotencyKey);
	if (!stored) return undefined;
	const { completion, snapshot } = stored;
	if (completion.trace.actorId !== request.actorId || completion.trace.stageId !== request.stageId || completion.identity !== identity({ ...request, sessionId: scope.sessionId }, outputContractDigest)) throw new RuntimeFailure("session_conflict", "Turn completion belongs to different input, actor or output contract", false);
	if (snapshot.contextBinding !== request.taskContext?.binding || snapshot.historyBinding !== request.taskContext?.historyBinding) throw new RuntimeFailure("context_failure", "Turn completion sources changed; preserve the original intent", false);
	return completion;
}

/** Repair historical completion evidence only. Callers still validate current business/source state. */
export function repairStoredCompletion(store: AgentSessionStore & ContextSnapshotStore & RuntimeTraceStore, scope: AgentSessionScope, key: string, actorId?: string): RuntimeTurnResult | undefined {
	const stored = storedCompletion(store, scope, key);
	if (!stored) return undefined;
	if (actorId !== undefined && stored.completion.trace.actorId !== actorId) throw new RuntimeFailure("permission_denied", "Completion belongs to another actor", false);
	return commitCompletion(store, store, scope, stored.completion);
}

export function commitCompletion(sessions: AgentSessionStore, traces: RuntimeTraceStore, scope: AgentSessionScope, completion: TurnCompletion): RuntimeTurnResult {
	const current = sessions.load(scope);
	const replyId = `reply-${createHash("sha256").update(completion.trace.idempotencyKey).digest("hex")}`;
	if (!completion.messages.some(message => message.messageId === replyId && message.role === "assistant" && visibleDialogue(message))) throw new RuntimeFailure("context_failure", "Completion intent has no final reply", false);
	if (current.revision === completion.baseRevision && stateDigest(current) === completion.baseDigest) {
		const targetDigest = stateDigest({ revision: current.revision + 1, messages: completion.messages, transcript: appendTranscript(current.transcript ?? [], completion.messages, scope.sessionId), historyBinding: completion.historyBinding ?? current.historyBinding });
		if (targetDigest !== completion.targetDigest) throw new RuntimeFailure("context_failure", "Completion intent content changed", false);
		sessions.save(scope, current.revision, completion.messages, completion.trace.completedAt, null, completion.historyBinding);
	} else if (current.revision !== completion.baseRevision + 1 || stateDigest(current) !== completion.targetDigest) {
		throw new RuntimeFailure("session_conflict", "Turn completion cannot overwrite a changed session", false);
	}
	const saved = sessions.load(scope);
	if (stateDigest(saved) !== completion.targetDigest) throw new RuntimeFailure("context_failure", "Completed session differs from its durable intent", false);
	traces.putTrace(completion.trace);
	const reply = saved.transcript?.find(message => message.messageId === replyId && message.role === "assistant");
	if (!reply) throw new RuntimeFailure("context_failure", "Completion intent has no final reply", false);
	return { adapter: "blackx-agent", status: "completed", sessionId: scope.sessionId, executionId: completion.trace.executionId, finalResponse: reply.content, events: completion.trace.events, usage: completion.trace.usage, contextSnapshotId: completion.trace.contextSnapshotId };
}
