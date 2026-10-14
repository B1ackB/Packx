import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	AggregateScope,
	AppendRequest,
	AppendResult,
	EnterpriseEvent,
	EnterpriseEventStore,
	OutboxMessage,
} from "../../src/enterprise/contracts";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";
import { type EventStoreDocument, isOutboxMessage, sameScope } from "./fileEventStore";

export interface SqliteEventStoreOptions {
	now?: () => Date;
	nextId?: () => string;
}

interface EventRow { event_json: string }
interface OutboxRow { document: string }

function unavailable(message: string, cause?: unknown): EnterpriseKernelError {
	return new EnterpriseKernelError("event_store_unavailable", message, { cause });
}

/**
 * Single-host Enterprise Event Store on node:sqlite. It keeps the file store's semantics:
 * commandId deduplication, expected-version conflicts, owner-scoped access and outbox lifecycle.
 * Events are stored as complete JSON documents so reads reproduce the file store exactly.
 */
export class SqliteEnterpriseEventStore implements EnterpriseEventStore {
	private readonly db: DatabaseSync;
	private readonly now: () => Date;
	private readonly nextId: () => string;

	constructor(filePath: string, options: SqliteEventStoreOptions = {}) {
		this.now = options.now ?? (() => new Date());
		this.nextId = options.nextId ?? (() => randomUUID());
		mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
		try {
			this.db = new DatabaseSync(filePath);
			this.db.exec(`
				PRAGMA journal_mode = WAL;
				PRAGMA busy_timeout = 2000;
				CREATE TABLE IF NOT EXISTS events (
					tenant_id TEXT NOT NULL,
					workspace_id TEXT NOT NULL,
					run_id TEXT NOT NULL,
					aggregate_version INTEGER NOT NULL,
					command_id TEXT NOT NULL,
					event_json TEXT NOT NULL,
					PRIMARY KEY (tenant_id, workspace_id, run_id, aggregate_version)
				);
				CREATE INDEX IF NOT EXISTS events_by_command ON events (tenant_id, workspace_id, run_id, command_id);
				CREATE INDEX IF NOT EXISTS events_by_run ON events (run_id);
				CREATE TABLE IF NOT EXISTS outbox (
					message_id TEXT PRIMARY KEY,
					status TEXT NOT NULL,
					available_at_ms INTEGER NOT NULL,
					created_at_ms INTEGER NOT NULL,
					document TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (status, available_at_ms, created_at_ms);
			`);
		} catch (error) {
			throw unavailable("Event Store database cannot be opened", error);
		}
		for (const path of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
			if (existsSync(path)) chmodSync(path, 0o600);
		}
	}

	close(): void {
		this.db.close();
	}

	read(scope: AggregateScope): EnterpriseEvent[] {
		this.assertScope(scope);
		return this.eventsFor(scope);
	}

	readCommand(scope: AggregateScope, commandId: string): EnterpriseEvent[] {
		return this.read(scope).filter((event) => event.commandId === commandId);
	}

	append(request: AppendRequest): AppendResult {
		return this.transaction(() => {
			if (request.events.length === 0) {
				throw unavailable("Event Store append requires a business event");
			}
			this.assertScope(request);
			const current = this.eventsFor(request);
			const requestedMessageIds = (request.outbox ?? []).map((message) => message.messageId);
			const duplicateOutbox = requestedMessageIds.flatMap((messageId) => {
				const message = this.outboxRow(messageId);
				return message ? [message] : [];
			});
			const duplicate = current.filter((event) => event.commandId === request.commandId);
			if (duplicate.length > 0) return { events: duplicate, outbox: duplicateOutbox, duplicate: true };
			if (current.length !== request.expectedVersion) {
				throw new EnterpriseKernelError("concurrency_conflict", "Aggregate version does not match the expected version");
			}

			const occurredAt = this.now().toISOString();
			const events = request.events.map((draft, index): EnterpriseEvent => ({
				tenantId: request.tenantId,
				workspaceId: request.workspaceId,
				runId: request.runId,
				eventId: this.nextId(),
				aggregateVersion: current.length + index + 1,
				commandId: request.commandId,
				correlationId: request.correlationId,
				actorId: request.actorId,
				occurredAt,
				data: draft.data,
			}));
			const outbox = (request.outbox ?? []).map((draft): OutboxMessage => ({
				...structuredClone(draft),
				schemaVersion: "enterprise-outbox.v1",
				status: "pending",
				deliveryCount: 0,
				availableAt: occurredAt,
				createdAt: occurredAt,
				updatedAt: occurredAt,
			}));
			if (!outbox.every(isOutboxMessage)) throw unavailable("Outbox message is invalid");
			if (outbox.some((message) => this.outboxRow(message.messageId)) ||
				new Set(outbox.map((message) => message.messageId)).size !== outbox.length) {
				throw new EnterpriseKernelError("concurrency_conflict", "Outbox message ID already exists");
			}
			for (const event of events) this.insertEvent(event);
			for (const message of outbox) this.insertOutbox(message);
			return { events, outbox, duplicate: false };
		});
	}

	readPendingOutbox(limit: number): OutboxMessage[] {
		if (!Number.isInteger(limit) || limit < 1) throw unavailable("Outbox read limit is invalid");
		const rows = this.db.prepare(`
			SELECT document FROM outbox
			WHERE status = 'pending' AND available_at_ms <= ?
			ORDER BY created_at_ms, rowid
			LIMIT ?
		`).all(this.now().getTime(), limit) as unknown as OutboxRow[];
		return rows.map((row) => JSON.parse(row.document) as OutboxMessage);
	}

	markOutboxPublished(messageId: string): OutboxMessage {
		return this.updateOutbox(messageId, (message, now) => message.status === "published"
			? message
			: {
				...message,
				status: "published",
				deliveryCount: message.deliveryCount + 1,
				publishedAt: now,
				updatedAt: now,
			});
	}

	markOutboxFailed(messageId: string, failure: { code: string; message: string; delayMs: number }): OutboxMessage {
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(failure.code) || typeof failure.message !== "string" ||
			!Number.isInteger(failure.delayMs) || failure.delayMs < 0) {
			throw unavailable("Outbox failure is invalid");
		}
		return this.updateOutbox(messageId, (message, now) => message.status === "published"
			? message
			: {
				...message,
				deliveryCount: message.deliveryCount + 1,
				availableAt: new Date(Date.parse(now) + failure.delayMs).toISOString(),
				updatedAt: now,
				lastFailure: { code: failure.code, message: failure.message, at: now },
			});
	}

	/**
	 * Imports a validated file-store document into an empty database and verifies every
	 * aggregate read back against the source. Any difference rolls the whole import back.
	 */
	importDocument(document: EventStoreDocument): { events: number; outbox: number; runs: number } {
		return this.transaction(() => {
			const existing = this.db.prepare("SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM outbox) AS total").get() as { total: number };
			if (existing.total !== 0) throw new EnterpriseKernelError("concurrency_conflict", "Target Event Store is not empty");
			for (const event of document.events) this.insertEvent(event);
			for (const message of document.outbox) this.insertOutbox(message);
			const runs = new Map<string, AggregateScope>();
			for (const event of document.events) runs.set(`${event.tenantId}\u0000${event.workspaceId}\u0000${event.runId}`, event);
			for (const scope of runs.values()) {
				const expected = document.events.filter((event) => sameScope(event, scope));
				if (JSON.stringify(this.eventsFor(scope)) !== JSON.stringify(expected)) {
					throw unavailable("Imported events differ from the source document");
				}
			}
			for (const message of document.outbox) {
				if (JSON.stringify(this.outboxRow(message.messageId)) !== JSON.stringify(message)) {
					throw unavailable("Imported outbox differs from the source document");
				}
			}
			return { events: document.events.length, outbox: document.outbox.length, runs: runs.size };
		});
	}

	private transaction<T>(operation: () => T): T {
		try {
			this.db.exec("BEGIN IMMEDIATE");
		} catch (error) {
			throw new EnterpriseKernelError("concurrency_conflict", "Persistent Event Store is locked or unavailable", { cause: error });
		}
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* the original failure is more useful */ }
			if (error instanceof EnterpriseKernelError) throw error;
			throw unavailable("Persistent Event Store write failed", error);
		}
	}

	private eventsFor(scope: AggregateScope): EnterpriseEvent[] {
		const rows = this.db.prepare(`
			SELECT event_json FROM events
			WHERE tenant_id = ? AND workspace_id = ? AND run_id = ?
			ORDER BY aggregate_version
		`).all(scope.tenantId, scope.workspaceId, scope.runId) as unknown as EventRow[];
		return rows.map((row) => JSON.parse(row.event_json) as EnterpriseEvent);
	}

	private assertScope(scope: AggregateScope): void {
		const owner = this.db.prepare("SELECT tenant_id, workspace_id FROM events WHERE run_id = ? LIMIT 1").get(scope.runId) as
			| { tenant_id: string; workspace_id: string }
			| undefined;
		if (!owner) return;
		if (owner.tenant_id === scope.tenantId && owner.workspace_id === scope.workspaceId) return;
		throw new EnterpriseKernelError("aggregate_access_denied", "Aggregate is unavailable in this tenant and workspace");
	}

	private insertEvent(event: EnterpriseEvent): void {
		this.db.prepare(`
			INSERT INTO events (tenant_id, workspace_id, run_id, aggregate_version, command_id, event_json)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(event.tenantId, event.workspaceId, event.runId, event.aggregateVersion, event.commandId, JSON.stringify(event));
	}

	private insertOutbox(message: OutboxMessage): void {
		this.db.prepare(`
			INSERT INTO outbox (message_id, status, available_at_ms, created_at_ms, document)
			VALUES (?, ?, ?, ?, ?)
		`).run(message.messageId, message.status, Date.parse(message.availableAt), Date.parse(message.createdAt), JSON.stringify(message));
	}

	private outboxRow(messageId: string): OutboxMessage | undefined {
		const row = this.db.prepare("SELECT document FROM outbox WHERE message_id = ?").get(messageId) as OutboxRow | undefined;
		return row ? JSON.parse(row.document) as OutboxMessage : undefined;
	}

	private updateOutbox(messageId: string, update: (message: OutboxMessage, now: string) => OutboxMessage): OutboxMessage {
		return this.transaction(() => {
			const current = this.outboxRow(messageId);
			if (!current) throw unavailable("Outbox message does not exist");
			const message = update(current, this.now().toISOString());
			this.db.prepare(`
				UPDATE outbox SET status = ?, available_at_ms = ?, created_at_ms = ?, document = ? WHERE message_id = ?
			`).run(message.status, Date.parse(message.availableAt), Date.parse(message.createdAt), JSON.stringify(message), messageId);
			return structuredClone(message);
		});
	}
}
