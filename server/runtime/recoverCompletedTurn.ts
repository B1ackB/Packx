import { createHash } from "node:crypto";
import { PlanError, type PlanScope } from "../../src/enterprise/agentPlan";
import type { RuntimeTurnResult } from "../../src/runtime/contracts";
import type { FileAgentStateStore } from "./fileAgentStateStore";

export function recoverCompletedTurn(store: Pick<FileAgentStateStore, "getSession" | "listTraces">, scope: PlanScope, sessionId: string, key: string): RuntimeTurnResult | undefined {
	const session = store.getSession({ ...scope, sessionId });
	const last = session?.messages.at(-1);
	if (!last || last.role !== "assistant" || last.toolCalls?.length || last.durable || !last.content.trim()) return undefined;
	const trace = store.listTraces(scope).findLast((t) => t.idempotencyKey === key && t.sessionId === sessionId && t.status === "completed");
	// A final session without its completion trace has uncertain tool evidence.
	// Stop for review instead of repeating side effects or claiming success.
	const replyId = `reply-${createHash("sha256").update(key).digest("hex")}`;
	const reply = session?.transcript?.find(message => message.messageId === replyId && message.inReplyTo === key);
	if (!trace || last.messageId !== replyId || last.inReplyTo !== key || !reply || last.content !== reply.content) throw new PlanError("plan_completion_evidence_missing", 409);
	return { adapter: "blackx-agent", status: "completed", sessionId, executionId: trace.executionId, finalResponse: last.content, events: trace.events, usage: trace.usage, contextSnapshotId: trace.contextSnapshotId };
}
