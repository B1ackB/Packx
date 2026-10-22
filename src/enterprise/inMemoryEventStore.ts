import { failOutboxDelivery, redriveOutboxDelivery } from "./outboxDelivery";
import type { OutboxRedriveRequest } from "./contracts";
import type {
	AggregateScope,
	AppendRequest,
	AppendResult,
	EnterpriseEvent,
	EnterpriseEventStore,
	OutboxMessage,
} from "./contracts";
import { EnterpriseKernelError } from "./contracts";

export interface InMemoryEventStoreOptions {
	now?: () => Date;
	nextId?: () => string;
}

function streamKey(scope: AggregateScope): string {
	return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${scope.runId}`;
}

function ownerKey(scope: AggregateScope): string {
	return `${scope.tenantId}\u0000${scope.workspaceId}`;
}

export class InMemoryEnterpriseEventStore implements EnterpriseEventStore {
	private readonly streams = new Map<string, EnterpriseEvent[]>();
	private readonly runOwners = new Map<string, string>();
	private readonly outbox = new Map<string, OutboxMessage>();
	private readonly now: () => Date;
	private readonly nextId: () => string;

	constructor(options: InMemoryEventStoreOptions = {}) {
		this.now = options.now ?? (() => new Date());
		this.nextId = options.nextId ?? (() => crypto.randomUUID());
	}

	read(scope: AggregateScope): EnterpriseEvent[] {
		this.assertScope(scope);
		return [...(this.streams.get(streamKey(scope)) ?? [])];
	}

	readCommand(scope: AggregateScope, commandId: string): EnterpriseEvent[] {
		return this.read(scope).filter((event) => event.commandId === commandId);
	}

	append(request: AppendRequest): AppendResult {
		if (request.events.length === 0) {
			throw new EnterpriseKernelError("event_store_unavailable", "Event Store append requires a business event");
		}
		this.assertScope(request, true);
		const key = streamKey(request);
		const current = this.streams.get(key) ?? [];
		const duplicate = current.filter(
			(event) => event.commandId === request.commandId,
		);
		const requestedMessageIds = new Set((request.outbox ?? []).map((message) => message.messageId));
		const duplicateOutbox = [...this.outbox.values()].filter(
			(message) => requestedMessageIds.has(message.messageId),
		);
		if (duplicate.length > 0) {
			return { events: [...duplicate], outbox: structuredClone(duplicateOutbox), duplicate: true };
		}
		if (current.length !== request.expectedVersion) {
			throw new EnterpriseKernelError(
				"concurrency_conflict",
				"Aggregate version does not match the expected version",
			);
		}

		const occurredAt = this.now().toISOString();
		const knownMessageIds = new Set(this.outbox.keys());
		if (requestedMessageIds.size !== (request.outbox?.length ?? 0) ||
			[...requestedMessageIds].some((messageId) => knownMessageIds.has(messageId))) {
			throw new EnterpriseKernelError("concurrency_conflict", "Outbox message ID already exists");
		}
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
		for (const message of outbox) {
			this.outbox.set(message.messageId, structuredClone(message));
		}
		this.streams.set(key, [...current, ...events]);
		this.runOwners.set(request.runId, ownerKey(request));
		return { events: [...events], outbox: structuredClone(outbox), duplicate: false };
	}

	readOutbox(scope: { tenantId: string; workspaceId: string }): OutboxMessage[] {
		return structuredClone([...this.outbox.values()].filter(message => message.payload.tenantId === scope.tenantId && message.payload.workspaceId === scope.workspaceId));
	}
	redriveOutbox(messageId: string, request: OutboxRedriveRequest): OutboxMessage {
		const updated = redriveOutboxDelivery(this.requireOutbox(messageId), request, this.now().toISOString());
		this.outbox.set(messageId, updated); return structuredClone(updated);
	}
	readPendingOutbox(limit: number): OutboxMessage[] {
		if (!Number.isInteger(limit) || limit < 1) {
			throw new EnterpriseKernelError("event_store_unavailable", "Outbox read limit is invalid");
		}
		const now = this.now().getTime();
		return structuredClone([...this.outbox.values()]
			.filter((message) => message.status === "pending" && Date.parse(message.availableAt) <= now)
			.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
			.slice(0, limit));
	}

	markOutboxPublished(messageId: string): OutboxMessage {
		const message = this.requireOutbox(messageId);
		if (message.status === "published") return structuredClone(message);
		if (message.status !== "pending") throw new EnterpriseKernelError("illegal_transition", "Outbox message requires operator redrive");
		const now = this.now().toISOString();
		const updated: OutboxMessage = {
			...message,
			status: "published",
			deliveryCount: message.deliveryCount + 1,
			publishedAt: now,
			updatedAt: now,
		};
		this.outbox.set(messageId, updated);
		return structuredClone(updated);
	}

	markOutboxFailed(
		messageId: string,
		failure: { code: string; message: string; delayMs: number; retryable?: boolean },
	): OutboxMessage {
		if (!Number.isInteger(failure.delayMs) || failure.delayMs < 0) {
			throw new EnterpriseKernelError("event_store_unavailable", "Outbox failure is invalid");
		}
		const message = this.requireOutbox(messageId);
		const updated = failOutboxDelivery(message, failure, this.now().toISOString());
		this.outbox.set(messageId, updated);
		return structuredClone(updated);
	}

	private requireOutbox(messageId: string): OutboxMessage {
		const message = this.outbox.get(messageId);
		if (!message) {
			throw new EnterpriseKernelError("event_store_unavailable", "Outbox message does not exist");
		}
		return message;
	}

	private assertScope(scope: AggregateScope, allowUnowned = false): void {
		const owner = this.runOwners.get(scope.runId);
		if (owner === undefined && allowUnowned) return;
		if (owner !== undefined && owner === ownerKey(scope)) return;
		if (owner === undefined && this.streams.has(streamKey(scope))) return;
		if (owner === undefined) return;
		throw new EnterpriseKernelError(
			"aggregate_access_denied",
			"Aggregate is unavailable in this tenant and workspace",
		);
	}
}
