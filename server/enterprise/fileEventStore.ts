import { FileWriteLockError, withFileWriteLock } from "../fileWriteLock";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type {
	AggregateScope,
	AppendRequest,
	AppendResult,
	EnterpriseEvent,
	EnterpriseEventStore,
	OutboxMessage,
} from "../../src/enterprise/contracts";
import { EnterpriseKernelError } from "../../src/enterprise/contracts";

interface EventStoreDocument {
	schemaVersion: 3;
	events: EnterpriseEvent[];
	outbox: OutboxMessage[];
}

export interface FileEventStoreOptions {
	now?: () => Date;
	nextId?: () => string;
}

const eventTypes = new Set([
	"run.created",
	"stage.started",
	"stage.execution_requested",
	"fact.version_recorded",
	"runtime.execution.linked",
	"artifact.version_created",
	"evaluation.completed",
	"approval.requested",
	"approval.resolved",
	"artifact.marked_stale",
	"approval.superseded",
	"stage.input_required",
	"stage.revision_required",
	"stage.restarted",
	"stage.cancelled",
	"stage.completed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) > 0;
}

function isFactValue(value: unknown): value is string | number | boolean {
	return (
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function isFactVersions(value: unknown): value is Record<string, number> {
	return (
		isRecord(value) &&
		Object.entries(value).every(
			([key, version]) => key.length > 0 && isPositiveInteger(version),
		)
	);
}

function isEventData(value: Record<string, unknown>): boolean {
	if (!isString(value.type) || !eventTypes.has(value.type)) return false;
	switch (value.type) {
		case "run.created":
			return true;
		case "stage.started":
		case "stage.input_required":
		case "stage.revision_required":
		case "stage.restarted":
		case "stage.cancelled":
		case "stage.completed":
			return isId(value.stage);
		case "stage.execution_requested":
			return isId(value.stage) && isId(value.jobId);
		case "fact.version_recorded":
			return (
				isString(value.factKey) &&
				isPositiveInteger(value.factVersion) &&
				isFactValue(value.value) &&
				(value.unit === undefined || isString(value.unit)) &&
				["suggested", "unverified", "verified", "rejected"].includes(
					String(value.status),
				) &&
				["user_input", "source_document", "model_output", "enterprise_source", "human_confirmation"].includes(
					String(value.sourceType),
				) &&
				isString(value.sourceRef)
			);
		case "runtime.execution.linked":
			return (
				isString(value.executionId) &&
				isString(value.adapterId) &&
				(value.resumeHandle === undefined || isString(value.resumeHandle)) &&
				(value.contextSnapshotId === undefined || isString(value.contextSnapshotId))
			);
		case "artifact.version_created":
			return (
				isString(value.artifactId) &&
				isPositiveInteger(value.artifactVersion) &&
				isString(value.schemaVersion) &&
				isString(value.contentRef) &&
				isFactVersions(value.inputFactVersions) &&
				isString(value.runtimeExecutionId) &&
				(value.contextSnapshotId === undefined || isString(value.contextSnapshotId))
			);
		case "evaluation.completed":
			return (
				isString(value.artifactId) &&
				isPositiveInteger(value.artifactVersion) &&
				typeof value.passed === "boolean" &&
				isString(value.reportRef)
			);
		case "approval.requested":
		case "approval.superseded":
			return (
				isString(value.approvalId) &&
				isString(value.artifactId) &&
				isPositiveInteger(value.artifactVersion)
			);
		case "approval.resolved":
			return (
				isString(value.approvalId) &&
				isString(value.artifactId) &&
				isPositiveInteger(value.artifactVersion) &&
				(value.decision === "approved" || value.decision === "rejected")
			);
		case "artifact.marked_stale":
			return (
				isString(value.artifactId) &&
				isPositiveInteger(value.artifactVersion) &&
				isString(value.reason)
			);
	}
	return false;
}

function isEnterpriseEvent(value: unknown): value is EnterpriseEvent {
	if (!isRecord(value) || !isRecord(value.data)) return false;
	return (
		isString(value.tenantId) &&
		isString(value.workspaceId) &&
		isString(value.runId) &&
		isString(value.eventId) &&
		isPositiveInteger(value.aggregateVersion) &&
		isString(value.commandId) &&
		isString(value.correlationId) &&
		isString(value.actorId) &&
		isString(value.occurredAt) &&
		Number.isFinite(Date.parse(value.occurredAt)) &&
		isEventData(value.data)
	);
}

function isOutboxMessage(value: unknown): value is OutboxMessage {
	if (!isRecord(value) || !isRecord(value.payload)) return false;
	const payload = value.payload;
	return value.schemaVersion === "enterprise-outbox.v1" &&
		isId(value.messageId) &&
		value.topic === "stage-job.requested" &&
		(value.status === "pending" || value.status === "published") &&
		Number.isInteger(value.deliveryCount) && Number(value.deliveryCount) >= 0 &&
		isString(value.availableAt) && Number.isFinite(Date.parse(value.availableAt)) &&
		isString(value.createdAt) && Number.isFinite(Date.parse(value.createdAt)) &&
		isString(value.updatedAt) && Number.isFinite(Date.parse(value.updatedAt)) &&
		(value.publishedAt === undefined || isString(value.publishedAt) && Number.isFinite(Date.parse(value.publishedAt))) &&
		(value.lastFailure === undefined || isRecord(value.lastFailure) &&
			isId(value.lastFailure.code) && isString(value.lastFailure.message) &&
			isString(value.lastFailure.at) && Number.isFinite(Date.parse(value.lastFailure.at))) &&
		[
			payload.jobId,
			payload.tenantId,
			payload.workspaceId,
			payload.runId,
			payload.stageId,
			payload.commandId,
			payload.correlationId,
			payload.sessionId,
		].every(isId) &&
		Number.isInteger(payload.expectedVersion) && Number(payload.expectedVersion) >= 0 &&
		(payload.priority === undefined || Number.isInteger(payload.priority)) &&
		(payload.maxFailures === undefined || Number.isInteger(payload.maxFailures) && Number(payload.maxFailures) > 0) &&
		(payload.maxSlices === undefined || Number.isInteger(payload.maxSlices) && Number(payload.maxSlices) > 0) &&
		(payload.availableAt === undefined || isString(payload.availableAt) && Number.isFinite(Date.parse(payload.availableAt)));
}

function hasValidStreamIntegrity(events: EnterpriseEvent[]): boolean {
	const eventIds = new Set<string>();
	const owners = new Map<string, string>();
	const nextVersions = new Map<string, number>();
	for (const event of events) {
		if (eventIds.has(event.eventId)) return false;
		eventIds.add(event.eventId);
		const owner = `${event.tenantId}\u0000${event.workspaceId}`;
		const existingOwner = owners.get(event.runId);
		if (existingOwner !== undefined && existingOwner !== owner) return false;
		owners.set(event.runId, owner);
		const stream = `${owner}\u0000${event.runId}`;
		const expectedVersion = nextVersions.get(stream) ?? 1;
		if (event.aggregateVersion !== expectedVersion) return false;
		nextVersions.set(stream, expectedVersion + 1);
	}
	return true;
}

function sameScope(event: EnterpriseEvent, scope: AggregateScope): boolean {
	return (
		event.tenantId === scope.tenantId &&
		event.workspaceId === scope.workspaceId &&
		event.runId === scope.runId
	);
}

function sameOwner(event: EnterpriseEvent, scope: AggregateScope): boolean {
	return (
		event.tenantId === scope.tenantId &&
		event.workspaceId === scope.workspaceId
	);
}

export class FileEnterpriseEventStore implements EnterpriseEventStore {
	private readonly now: () => Date;
	private readonly nextId: () => string;

	constructor(
		private readonly filePath: string,
		options: FileEventStoreOptions = {},
	) {
		this.now = options.now ?? (() => new Date());
		this.nextId = options.nextId ?? (() => crypto.randomUUID());
	}

	read(scope: AggregateScope): EnterpriseEvent[] {
		const document = this.loadDocument();
		this.assertScope(document.events, scope);
		return document.events.filter((event) => sameScope(event, scope));
	}

	readCommand(scope: AggregateScope, commandId: string): EnterpriseEvent[] {
		return this.read(scope).filter((event) => event.commandId === commandId);
	}

	append(request: AppendRequest): AppendResult {
		return this.withWriteLock(() => {
			if (request.events.length === 0) {
				throw new EnterpriseKernelError("event_store_unavailable", "Event Store append requires a business event");
			}
			const document = this.loadDocument();
			this.assertScope(document.events, request);
			const current = document.events.filter((event) => sameScope(event, request));
			const duplicate = current.filter(
				(event) => event.commandId === request.commandId,
			);
			const requestedMessageIds = new Set((request.outbox ?? []).map((message) => message.messageId));
			const duplicateOutbox = document.outbox.filter((message) => requestedMessageIds.has(message.messageId));
			if (duplicate.length > 0) {
				return { events: duplicate, outbox: duplicateOutbox, duplicate: true };
			}
			if (current.length !== request.expectedVersion) {
				throw new EnterpriseKernelError(
					"concurrency_conflict",
					"Aggregate version does not match the expected version",
				);
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
			if (!outbox.every(isOutboxMessage)) {
				throw new EnterpriseKernelError("event_store_unavailable", "Outbox message is invalid");
			}
			const knownMessageIds = new Set(document.outbox.map((message) => message.messageId));
			if (outbox.some((message) => knownMessageIds.has(message.messageId)) ||
				new Set(outbox.map((message) => message.messageId)).size !== outbox.length) {
				throw new EnterpriseKernelError("concurrency_conflict", "Outbox message ID already exists");
			}
			this.writeDocument({
				schemaVersion: 3,
				events: [...document.events, ...events],
				outbox: [...document.outbox, ...outbox],
			});
			return { events, outbox, duplicate: false };
		});
	}

	readPendingOutbox(limit: number): OutboxMessage[] {
		if (!Number.isInteger(limit) || limit < 1) {
			throw new EnterpriseKernelError("event_store_unavailable", "Outbox read limit is invalid");
		}
		const now = this.now().getTime();
		return structuredClone(this.loadDocument().outbox
			.filter((message) => message.status === "pending" && Date.parse(message.availableAt) <= now)
			.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
			.slice(0, limit));
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

	markOutboxFailed(
		messageId: string,
		failure: { code: string; message: string; delayMs: number },
	): OutboxMessage {
		if (!isId(failure.code) || !isString(failure.message) ||
			!Number.isInteger(failure.delayMs) || failure.delayMs < 0) {
			throw new EnterpriseKernelError("event_store_unavailable", "Outbox failure is invalid");
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

	private assertScope(events: EnterpriseEvent[], scope: AggregateScope): void {
		const ownerEvent = events.find((event) => event.runId === scope.runId);
		if (!ownerEvent || sameOwner(ownerEvent, scope)) return;
		throw new EnterpriseKernelError(
			"aggregate_access_denied",
			"Aggregate is unavailable in this tenant and workspace",
		);
	}

	private loadDocument(): EventStoreDocument {
		if (!existsSync(this.filePath)) {
			return { schemaVersion: 3, events: [], outbox: [] };
		}
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
			if (
				isRecord(parsed) &&
				parsed.schemaVersion === 2 &&
				Array.isArray(parsed.events) &&
				parsed.events.every(isEnterpriseEvent) &&
				hasValidStreamIntegrity(parsed.events)
			) {
				return { schemaVersion: 3, events: parsed.events, outbox: [] };
			}
			if (
				!isRecord(parsed) ||
				parsed.schemaVersion !== 3 ||
				!Array.isArray(parsed.events) ||
				!parsed.events.every(isEnterpriseEvent) ||
				!hasValidStreamIntegrity(parsed.events) ||
				!Array.isArray(parsed.outbox) ||
				!parsed.outbox.every(isOutboxMessage) ||
				new Set(parsed.outbox.map((message) => message.messageId)).size !== parsed.outbox.length
			) {
				throw new Error("invalid_event_store_document");
			}
			return { schemaVersion: 3, events: parsed.events, outbox: parsed.outbox };
		} catch (error) {
			throw new EnterpriseKernelError(
				"event_store_corrupt",
				"Persistent Event Store cannot be decoded safely",
				{ cause: error },
			);
		}
	}

	private updateOutbox(
		messageId: string,
		update: (message: OutboxMessage, now: string) => OutboxMessage,
	): OutboxMessage {
		return this.withWriteLock(() => {
			const document = this.loadDocument();
			const index = document.outbox.findIndex((message) => message.messageId === messageId);
			if (index < 0) {
				throw new EnterpriseKernelError("event_store_unavailable", "Outbox message does not exist");
			}
			const message = update(document.outbox[index], this.now().toISOString());
			document.outbox[index] = message;
			this.writeDocument(document);
			return structuredClone(message);
		});
	}

	private writeDocument(document: EventStoreDocument): void {
		const directory = dirname(this.filePath);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.filePath}.${process.pid}.${this.nextId()}.tmp`;
		try {
			writeFileSync(temporaryPath, `${JSON.stringify(document)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			const handle = openSync(temporaryPath, "r");
			try {
				fsyncSync(handle);
			} finally {
				closeSync(handle);
			}
			renameSync(temporaryPath, this.filePath);
			chmodSync(this.filePath, 0o600);
		} catch (error) {
			if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
			throw new EnterpriseKernelError(
				"event_store_unavailable",
				"Persistent Event Store write failed",
				{ cause: error },
			);
		}
	}

	private withWriteLock<T>(operation: () => T): T {
		try { return withFileWriteLock(this.filePath, operation); }
		catch (error) {
			if (error instanceof FileWriteLockError) throw new EnterpriseKernelError("concurrency_conflict", "Persistent Event Store is locked or unavailable", { cause: error });
			throw error;
		}
	}
}
