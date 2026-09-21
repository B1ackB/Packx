import type {
	AgentMessage,
	AgentToolExecutionKey,
	AgentToolExecutionRecord,
	AgentToolExecutionStore,
} from "./contracts";
import type { RuntimeTraceRecord, RuntimeTraceStore } from "../runtime/contracts";

export interface AgentSessionScope {
	tenantId: string;
	workspaceId: string;
	runId: string;
	sessionId: string;
}

/** Compare-and-swap a previously uncertain outcome using evidence supplied by the Host. */
export function resolveExecution(existing: AgentToolExecutionRecord, expected: AgentToolExecutionRecord, outcome: { result: string; resultDigest: string; evidenceRef: string; resolvedAt: string }): AgentToolExecutionRecord {
	const identity = (value: AgentToolExecutionRecord) => JSON.stringify([value.tenantId, value.workspaceId, value.runId, value.actorId, value.tool, value.idempotencyKey, value.approvalId, value.executionId, value.inputDigest]);
	if (identity(existing) !== identity(expected)) throw new AgentStateStoreError("conflict", "Execution reconciliation scope changed");
	if (existing.status === "succeeded") return structuredClone(existing);
	if (existing.status !== expected.status || existing.resultDigest !== expected.resultDigest) throw new AgentStateStoreError("conflict", "Execution reconciliation state changed");
	if (!outcome.evidenceRef || outcome.evidenceRef.length > 256 || !outcome.resultDigest || !Number.isFinite(Date.parse(outcome.resolvedAt))) throw new AgentStateStoreError("unavailable", "Execution reconciliation requires valid evidence");
	const { failureCode: _failureCode, ...record } = existing;
	return { ...record, status: "succeeded", result: outcome.result, resultDigest: outcome.resultDigest, completedAt: outcome.resolvedAt,
		reconciliation: { evidenceRef: outcome.evidenceRef, previousStatus: existing.status, ...(existing.failureCode ? { previousFailureCode: existing.failureCode } : {}), ...(existing.resultDigest ? { previousResultDigest: existing.resultDigest } : {}), resolvedAt: outcome.resolvedAt } };
}

export interface AgentSessionState {
	revision: number;
	historyBinding?: string;
	checkpoint?: { turnKey: string; contextBinding?: string };
	messages: AgentMessage[];
	/** Append-only visible dialogue, independent of the replaceable working messages. */
	transcript?: AgentMessage[];
	historyStatus?: "complete" | "legacy_partial";
}

export function visibleDialogue(message: AgentMessage): boolean {
	return (message.role === "user" || message.role === "assistant") &&
		(!message.kind || message.kind === "dialogue") && !message.durable && !message.toolCalls?.length &&
		(message.kind === "dialogue" || !message.content.startsWith("[Unverified compact summary;")) &&
		Boolean(message.content.trim() || message.attachments?.length || message.sources?.length);
}

export function appendTranscript(current: readonly AgentMessage[], candidates: readonly AgentMessage[], sessionId: string): AgentMessage[] {
	const result = structuredClone([...current]);
	for (const candidate of candidates.filter(visibleDialogue)) {
		const { pinned: _pinned, providerState: _providerState, ...message } = candidate;
		const messageId = message.messageId ?? `${sessionId}-legacy-${result.length + 1}`;
		const existing = result.find((item) => item.messageId === messageId);
		if (existing) {
			if (existing.content !== message.content || existing.role !== message.role ||
				JSON.stringify(existing.sources ?? []) !== JSON.stringify(message.sources ?? []) ||
				JSON.stringify(existing.attachments ?? []) !== JSON.stringify(message.attachments ?? [])) {
				throw new AgentStateStoreError("conflict", "Transcript message identity conflict");
			}
		} else result.push({ ...structuredClone(message), messageId, kind: "dialogue" });
	}
	return result;
}

export interface ContextSnapshotRecord extends AgentSessionScope {
	contextBinding?: string;
	historyBinding?: string;
	purpose?: "turn" | "summary" | "archive";
	schemaVersion: "context-snapshot.v2";
	snapshotId: string;
	iteration: number;
	skills: Array<{ name: string; version: string }>;
	messages: AgentMessage[];
	estimatedChars: number;
	estimatedTokens: number;
	removedMessages: number;
	createdAt: string;
}

export interface AgentSessionStore {
	load(scope: AgentSessionScope): AgentSessionState;
	save(
		scope: AgentSessionScope,
		expectedRevision: number,
		messages: readonly AgentMessage[],
		updatedAt: string,
		checkpoint?: AgentSessionState["checkpoint"] | null,
		historyBinding?: string,
	): AgentSessionState;
}

export interface ContextSnapshotStore {
	put(snapshot: ContextSnapshotRecord): ContextSnapshotRecord;
	read(scope: AgentSessionScope, snapshotId: string): ContextSnapshotRecord;
}

export class AgentStateStoreError extends Error {
	constructor(
		readonly code: "not_found" | "conflict" | "corrupt" | "unavailable",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "AgentStateStoreError";
	}
}

function key(scope: AgentSessionScope): string {
	return JSON.stringify([scope.tenantId, scope.workspaceId, scope.runId, scope.sessionId]);
}

function cloneMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((message) => ({
		...message,
		sources: message.sources?.map((source) => ({ ...source })),
		attachments: message.attachments?.map((attachment) => ({ ...attachment })),
		toolCalls: message.toolCalls?.map((call) => ({ ...call })),
		...(message.providerState === undefined
			? {}
			: { providerState: structuredClone(message.providerState) }),
	}));
}

function snapshotKey(scope: AgentSessionScope, snapshotId: string): string {
	return `${key(scope)}\n${snapshotId}`;
}

function equivalentSnapshot(left: ContextSnapshotRecord, right: ContextSnapshotRecord): boolean {
	const { createdAt: _leftCreatedAt, ...leftComparable } = left;
	const { createdAt: _rightCreatedAt, ...rightComparable } = right;
	return JSON.stringify(leftComparable) === JSON.stringify(rightComparable);
}

function toolExecutionKey(key: AgentToolExecutionKey): string {
	return JSON.stringify([key.tenantId, key.workspaceId, key.tool, key.idempotencyKey]);
}

export class InMemoryAgentStateStore implements AgentSessionStore, ContextSnapshotStore, AgentToolExecutionStore, RuntimeTraceStore {
	private readonly sessions = new Map<string, AgentSessionState>();
	private readonly snapshots = new Map<string, ContextSnapshotRecord>();
	private readonly toolExecutions = new Map<string, AgentToolExecutionRecord>();
	private readonly traces = new Map<string, RuntimeTraceRecord>();

	putTrace(trace: RuntimeTraceRecord): RuntimeTraceRecord {
		const key = JSON.stringify([trace.tenantId, trace.workspaceId, trace.runId, trace.executionId]);
		const existing = this.traces.get(key);
		if (existing && JSON.stringify(existing) !== JSON.stringify(trace)) {
			throw new AgentStateStoreError("conflict", "Runtime Trace identity conflict");
		}
		this.traces.set(key, structuredClone(trace));
		return structuredClone(trace);
	}

	listTraces(scope: { tenantId: string; workspaceId: string; runId: string }): RuntimeTraceRecord[] {
		return [...this.traces.values()]
			.filter((trace) => trace.tenantId === scope.tenantId && trace.workspaceId === scope.workspaceId && trace.runId === scope.runId)
			.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
			.map((trace) => structuredClone(trace));
	}

	load(scope: AgentSessionScope): AgentSessionState {
		const state = this.sessions.get(key(scope));
		return state
			? structuredClone(state)
			: { revision: 0, messages: [] };
	}

	save(
		scope: AgentSessionScope,
		expectedRevision: number,
		messages: readonly AgentMessage[],
		_updatedAt: string,
		checkpoint?: AgentSessionState["checkpoint"] | null,
		historyBinding?: string,
	): AgentSessionState {
		const current = this.load(scope);
		if (current.revision !== expectedRevision) {
			throw new AgentStateStoreError("conflict", "Agent Session revision changed");
		}
		const identified = messages.map((message, index) => visibleDialogue(message) && !message.messageId ? { ...message, messageId: `legacy-${expectedRevision}-${index}` } : message);
		const next = { checkpoint: checkpoint === null ? undefined : checkpoint ?? current.checkpoint, historyBinding: historyBinding ?? current.historyBinding, revision: expectedRevision + 1, messages: cloneMessages(identified),
			transcript: appendTranscript(current.transcript ?? [], identified, scope.sessionId), historyStatus: current.historyStatus ?? "complete" as const };
		this.sessions.set(key(scope), next);
		return this.load(scope);
	}

	put(snapshot: ContextSnapshotRecord): ContextSnapshotRecord {
		const recordKey = snapshotKey(snapshot, snapshot.snapshotId);
		const existing = this.snapshots.get(recordKey);
		if (existing) {
			if (!equivalentSnapshot(existing, snapshot)) {
				throw new AgentStateStoreError("conflict", "Context Snapshot already exists with different content");
			}
			return structuredClone(existing);
		}
		this.snapshots.set(recordKey, structuredClone(snapshot));
		return structuredClone(snapshot);
	}

	read(scope: AgentSessionScope, snapshotId: string): ContextSnapshotRecord {
		const snapshot = this.snapshots.get(snapshotKey(scope, snapshotId));
		if (!snapshot) throw new AgentStateStoreError("not_found", "Context Snapshot does not exist");
		return structuredClone(snapshot);
	}

	async list(scope: { tenantId: string; workspaceId: string; runId: string }) {
		return [...this.toolExecutions.values()].filter((record) => record.tenantId === scope.tenantId && record.workspaceId === scope.workspaceId && record.runId === scope.runId).map((record) => structuredClone(record));
	}

	async claim(record: AgentToolExecutionRecord): Promise<{ record: AgentToolExecutionRecord; duplicate: boolean }> {
		const key = toolExecutionKey(record);
		const existing = this.toolExecutions.get(key);
		if (existing) return { record: structuredClone(existing), duplicate: true };
		this.toolExecutions.set(key, structuredClone(record));
		return { record: structuredClone(record), duplicate: false };
	}

	async complete(
		key: AgentToolExecutionKey,
		completion: Pick<AgentToolExecutionRecord, "status" | "result" | "resultDigest" | "failureCode" | "completedAt">,
	): Promise<AgentToolExecutionRecord> {
		const recordKey = toolExecutionKey(key);
		const existing = this.toolExecutions.get(recordKey);
		if (!existing) throw new AgentStateStoreError("not_found", "Tool execution reservation does not exist");
		if (existing.status !== "started") return structuredClone(existing);
		const completed = { ...existing, ...completion };
		this.toolExecutions.set(recordKey, structuredClone(completed));
		return structuredClone(completed);
	}

	async find(key: AgentToolExecutionKey): Promise<AgentToolExecutionRecord | undefined> {
		const record = this.toolExecutions.get(toolExecutionKey(key));
		return record ? structuredClone(record) : undefined;
	}

	async resolve(expected: AgentToolExecutionRecord, outcome: Parameters<typeof resolveExecution>[2]) {
		const key = toolExecutionKey(expected), existing = this.toolExecutions.get(key);
		if (!existing) throw new AgentStateStoreError("not_found", "Tool execution reservation does not exist");
		const resolved = resolveExecution(existing, expected, outcome);
		this.toolExecutions.set(key, structuredClone(resolved));
		return structuredClone(resolved);
	}
}
