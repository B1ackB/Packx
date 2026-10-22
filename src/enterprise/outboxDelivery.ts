import { EnterpriseKernelError, type OutboxMessage, type OutboxRedriveRequest } from "./contracts";

export const outboxFailureLimit = 5;
export function failOutboxDelivery(message: OutboxMessage, failure: { code: string; message: string; delayMs: number; retryable?: boolean }, now: string): OutboxMessage {
	if (message.status !== "pending") return message;
	const failureCount = (message.failureCount ?? message.deliveryCount) + 1;
	const updatedAt = new Date(Math.max(Date.parse(now), Date.parse(message.updatedAt) + 1)).toISOString();
	return { ...message, status: failure.retryable === false || failureCount >= outboxFailureLimit ? "dead_letter" : "pending", failureCount,
		deliveryCount: message.deliveryCount + 1, availableAt: new Date(Date.parse(now) + failure.delayMs).toISOString(), updatedAt,
		lastFailure: { code: failure.code, message: failure.message, at: now } };
}

export function redriveOutboxDelivery(message: OutboxMessage, request: OutboxRedriveRequest, now: string): OutboxMessage {
	const id = (value: string) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
	if (message.payload.tenantId !== request.tenantId || message.payload.workspaceId !== request.workspaceId) throw new EnterpriseKernelError("aggregate_access_denied", "Outbox message is unavailable in this scope");
	if (![request.tenantId, request.workspaceId, request.actorId, request.requestId].every(id) || typeof request.reason !== "string" || !request.reason.trim() || request.reason.length > 500 || !Number.isFinite(Date.parse(request.expectedUpdatedAt))) throw new EnterpriseKernelError("illegal_transition", "Outbox redrive requires an actor, reason, request ID and observed version");
	const prior = message.redrives?.find(value => value.requestId === request.requestId);
	if (prior) {
		if (prior.actorId !== request.actorId || prior.reason !== request.reason || prior.expectedUpdatedAt !== request.expectedUpdatedAt) throw new EnterpriseKernelError("concurrency_conflict", "Outbox redrive request changed");
		return message;
	}
	if (message.status !== "dead_letter" || message.updatedAt !== request.expectedUpdatedAt || (message.redrives?.length ?? 0) >= 64) throw new EnterpriseKernelError("concurrency_conflict", "Outbox redrive state changed or its operator budget is exhausted");
	return { ...message, status: "pending", failureCount: 0, availableAt: now, updatedAt: new Date(Math.max(Date.parse(now), Date.parse(message.updatedAt) + 1)).toISOString(),
		redrives: [...(message.redrives ?? []), { requestId: request.requestId, actorId: request.actorId, reason: request.reason, expectedUpdatedAt: request.expectedUpdatedAt, at: now }] };
}
