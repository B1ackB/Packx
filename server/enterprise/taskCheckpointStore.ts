import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "../../src/agent/contracts";
import { visibleDialogue } from "../../src/agent/state";
import type { AggregateScope } from "../../src/enterprise/contracts";
import { checkpointDraft, TaskCheckpointError, type TaskCheckpointState, type TaskCheckpointVersion, type TaskCheckpointView } from "../../src/enterprise/taskCheckpoint";

const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const userDialogue = (transcript: readonly AgentMessage[]) => transcript.filter((message) => visibleDialogue(message) && message.role === "user");
export const checkpointSourceDigest = (transcript: readonly AgentMessage[]) => hash(userDialogue(transcript).map((message) => [message.messageId, message.content, message.sources ?? [], message.attachments?.map(({ data: _data, ...ref }) => ref) ?? []]));

export function checkpointTail(transcript: readonly AgentMessage[], checkpoint?: TaskCheckpointVersion): AgentMessage[] {
	const users = userDialogue(transcript);
	if (!checkpoint) return users;
	const prefix = users.slice(0, checkpoint.userMessageCount);
	if (checkpoint.status !== "active" || !checkpoint.confirmation || prefix.at(-1)?.messageId !== checkpoint.throughMessageId || checkpointSourceDigest(prefix) !== checkpoint.sourceDigest) throw new TaskCheckpointError("task_checkpoint_source_changed");
	return users.slice(checkpoint.userMessageCount);
}

/** Enterprise-owned, versioned user review. It never confirms Facts or completes a Stage. */
export class TaskCheckpointStore {
	private readonly db: DatabaseSync;
	constructor(path: string, private readonly now = () => new Date().toISOString()) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS task_checkpoint_events (
				tenant TEXT, workspace TEXT, run TEXT, revision INTEGER, command TEXT, digest TEXT,
				actor TEXT, type TEXT, at TEXT, state TEXT NOT NULL,
				PRIMARY KEY(tenant,workspace,run,revision), UNIQUE(tenant,workspace,run,command));`);
		if (path !== ":memory:") chmodSync(path, 0o600);
	}
	close() { this.db.close(); }
	private scope(scope: AggregateScope) {
		if (![scope.tenantId, scope.workspaceId, scope.runId].every(id)) throw new TaskCheckpointError("task_checkpoint_access_denied", 403);
		return [scope.tenantId, scope.workspaceId, scope.runId];
	}
	read(scope: AggregateScope): TaskCheckpointState {
		const row = this.db.prepare("SELECT state FROM task_checkpoint_events WHERE tenant=? AND workspace=? AND run=? ORDER BY revision DESC LIMIT 1").get(...this.scope(scope));
		if (!row) return { revision: 0, versions: [] };
		try {
			const state = JSON.parse(String(row.state)) as TaskCheckpointState;
			if (!Number.isSafeInteger(state.revision) || state.revision < 1 || !Array.isArray(state.versions) || state.versions.filter((v) => v.status === "active").length > 1 || state.versions.filter((v) => v.status === "proposed").length > 1) throw new Error();
			for (const [index, v] of state.versions.entries()) {
				checkpointDraft({ objective: v.objective, constraints: v.constraints, openQuestions: v.openQuestions, progressNotes: v.progressNotes });
				if (v.version !== index + 1 || !["proposed", "active", "superseded", "rejected"].includes(v.status) || !id(v.actorId) || !id(v.throughMessageId) || !Number.isSafeInteger(v.userMessageCount) || v.userMessageCount < 1 || !/^[a-f0-9]{64}$/.test(v.sourceDigest) || !Number.isFinite(Date.parse(v.createdAt)) || (["active", "superseded"].includes(v.status) && (!v.confirmation || !id(v.confirmation.actorId) || !Number.isFinite(Date.parse(v.confirmation.at))))) throw new Error();
			}
			return state;
		} catch { throw new TaskCheckpointError("task_checkpoint_store_invalid", 503); }
	}
	active(scope: AggregateScope, transcript: readonly AgentMessage[]) {
		const active = this.read(scope).versions.find((v) => v.status === "active");
		checkpointTail(transcript, active);
		return active;
	}
	view(scope: AggregateScope, transcript: readonly AgentMessage[]): TaskCheckpointView {
		const state = this.read(scope), users = userDialogue(transcript);
		const tail = checkpointTail(transcript, state.versions.find((v) => v.status === "active"));
		const uncoveredChars = tail.reduce((total, message) => total + message.content.length, 0);
		return { ...state, userMessageCount: users.length, uncoveredUserMessages: tail.length, uncoveredChars, sourceDigest: checkpointSourceDigest(users), needsReview: uncoveredChars >= 16_000 };
	}
	command(scope: AggregateScope, actor: string, transcript: readonly AgentMessage[], payload: unknown): TaskCheckpointView {
		if (!id(actor) || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new TaskCheckpointError("invalid_task_checkpoint_command", 400);
		const p = payload as Record<string, unknown>;
		if (Object.keys(p).some((key) => !["action", "requestId", "revision", "draft", "sourceDigest", "confirmed"].includes(key)) || !["propose", "confirm", "reject"].includes(String(p.action)) || !id(p.requestId) || !Number.isSafeInteger(p.revision) || Number(p.revision) < 0 || (p.action === "confirm" && p.confirmed !== true)) throw new TaskCheckpointError("invalid_task_checkpoint_command", 400);
		const keys = this.scope(scope), digest = hash(p);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const previous = this.db.prepare("SELECT digest FROM task_checkpoint_events WHERE tenant=? AND workspace=? AND run=? AND command=?").get(...keys, p.requestId);
			const state = this.read(scope);
			if (previous) {
				if (previous.digest !== digest) throw new TaskCheckpointError("task_checkpoint_command_conflict");
			} else {
				if (state.revision !== p.revision) throw new TaskCheckpointError("task_checkpoint_revision_conflict");
				const pending = state.versions.find((v) => v.status === "proposed");
				if (p.action === "propose") {
					if (pending) throw new TaskCheckpointError("task_checkpoint_pending");
					const users = userDialogue(transcript), last = users.at(-1);
					if (!last?.messageId || !id(last.messageId) || p.sourceDigest !== checkpointSourceDigest(users)) throw new TaskCheckpointError("task_checkpoint_source_changed");
					state.versions.push({ ...checkpointDraft(p.draft), version: state.versions.length + 1, status: "proposed", throughMessageId: last.messageId, userMessageCount: users.length, sourceDigest: String(p.sourceDigest), actorId: actor, createdAt: this.now() });
				} else {
					if (!pending) throw new TaskCheckpointError("task_checkpoint_proposal_missing");
					if (p.action === "confirm") {
						if (pending.sourceDigest !== checkpointSourceDigest(transcript)) throw new TaskCheckpointError("task_checkpoint_source_changed");
						for (const v of state.versions) if (v.status === "active") v.status = "superseded";
						pending.status = "active"; pending.confirmation = { actorId: actor, at: this.now() };
					} else pending.status = "rejected";
				}
				state.revision++;
				this.db.prepare("INSERT INTO task_checkpoint_events VALUES (?,?,?,?,?,?,?,?,?,?)").run(...keys, state.revision, p.requestId, digest, actor, `task_checkpoint.${String(p.action)}`, this.now(), JSON.stringify(state));
			}
			this.db.exec("COMMIT");
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
		return this.view(scope, transcript);
	}
}
