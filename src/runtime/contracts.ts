import type { AgentImageAttachment } from "../agent/contracts";

export type RuntimeAdapterKind = "fake" | "blackx-agent" | "client-fallback";

export type RuntimeFailureCode =
  | "authentication"
  | "rate_limit"
	| "model_failure"
  | "timeout"
  | "cancelled"
  | "invalid_output"
	| "context_failure"
	| "budget_exceeded"
	| "repeated_actions"
	| "consecutive_tool_failures"
	| "permission_denied"
	| "max_iterations"
	| "session_conflict"
	| "infrastructure_failure"
  | "runtime_unavailable"
  | "execution_failed";

export interface RuntimeUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export type RuntimeExecutionEvent =
	| { type: "context.rebuilt"; reason: "history_binding_changed"; discardedMessages: number }
	| { type: "session.started"; sessionId: string }
	| { type: "turn.started" }
	| { type: "model.started"; iteration: number; attempt: number }
	| { type: "model.completed"; iteration: number; durationMs: number; usage: RuntimeUsage }
	| { type: "context.snapshot.saved"; snapshotId: string; iteration: number }
	| { type: "context.summary"; callId: string; sourceRef?: string; sourceRange?: [number, number]; status: "started" | "completed" | "failed"; durationMs?: number; usage?: RuntimeUsage }
	| { type: "context.compacted"; removedMessages: number; summaries: number; beforeChars?: number; afterChars?: number; estimatedTokens?: number; coverage?: { complete: boolean; sourceMessages: number; coveredMessages: number; calls: number } }
	| { type: "input.attachments.resolved"; count: number }
	| { type: "message.completed"; text: string }
	| { type: "tool.started"; tool: string; toolCallId: string; risk: "read" | "write" | "publish"; idempotencyKey: string }
	| { type: "tool.reconciled"; tool: string; toolCallId: string; idempotencyKey: string; status: "succeeded" | "unresolved"; durationMs: number; evidenceRef?: string; failureCode?: "no_evidence" | "source_unavailable" | "timeout" }
	| {
		type: "tool.completed";
		tool: string;
		toolCallId: string;
		risk: "read" | "write" | "publish";
		status: "succeeded" | "failed" | "denied" | "unknown";
		failureCode?: string;
		durationMs: number;
		resultTruncated: boolean;
		replayed: boolean;
	}
	| { type: "turn.checkpointed"; reason: "iteration_slice_limit"; iterations: number }
	| { type: "turn.completed"; usage: RuntimeUsage; iterations: number }
	| { type: "loop.guard.stopped"; code: "repeated_actions" | "consecutive_tool_failures" }
  | { type: "turn.failed"; message: string };

export interface RuntimeTurnRequest {
	taskContext?: { content: string; binding: string; historyBinding?: string };
  tenantId: string;
  workspaceId: string;
  runId: string;
  stageId: string;
	actorId: string;
  idempotencyKey: string;
	contextSnapshotId?: string;
	sessionId?: string;
	resume?: boolean | "if-present";
	instructions?: string[];
	skills?: string[];
	allowedTools?: string[];
  input: string;
	attachments?: AgentImageAttachment[];
  outputSchema?: Record<string, unknown>;
	limits?: { maxIterations: number; maxToolExecutions: number; maxInputTokens: number };
  fallbackOutput: string;
  policy: {
		sandboxMode: "read-only" | "workspace-write";
		approvalPolicy: "never" | "required";
    timeoutMs: number;
  };
}

export interface RuntimeTurnResult {
  executionId: string;
  adapter: RuntimeAdapterKind;
	status: "completed" | "paused";
	sessionId?: string;
	contextSnapshotId?: string;
  finalResponse: string;
  events: RuntimeExecutionEvent[];
  usage?: RuntimeUsage;
}

export interface RuntimeTraceRecord {
	schemaVersion: "runtime-trace.v1";
	tenantId: string;
	workspaceId: string;
	runId: string;
	stageId: string;
	actorId: string;
	executionId: string;
	idempotencyKey: string;
	status: "completed" | "paused" | "failed";
	startedAt: string;
	completedAt: string;
	durationMs: number;
	sessionId?: string;
	contextSnapshotId?: string;
	events: RuntimeExecutionEvent[];
	usage?: RuntimeUsage;
	loopGuard?: RuntimeLoopGuardState;
	failure?: {
		code: RuntimeFailureCode;
		retryable: boolean;
		message: string;
	};
}

// Host-owned state; never reconstructed from model messages or summaries.
export interface RuntimeLoopGuardState {
	sequence: number;
	actions: string[];
	consecutiveFailures: number;
	blocked?: "repeated_actions" | "consecutive_tool_failures";
}

export interface RuntimeTraceStore {
	putTrace(trace: RuntimeTraceRecord): RuntimeTraceRecord;
	listTraces(scope: { tenantId: string; workspaceId: string; runId: string }): RuntimeTraceRecord[];
}

export interface RuntimeHealth {
	adapter: RuntimeAdapterKind;
	online: boolean;
	coreVersion?: string;
	providerStatus?: "configured" | "last_request_succeeded" | "last_request_failed";
}

export interface AgentRuntimePort {
  health(): Promise<RuntimeHealth>;
  executeTurn(
    request: RuntimeTurnRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeTurnResult>;
}

export class RuntimeFailure extends Error {
  readonly code: RuntimeFailureCode;
  readonly retryable: boolean;

  constructor(
    code: RuntimeFailureCode,
    message: string,
    retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeFailure";
    this.code = code;
    this.retryable = retryable;
  }
}
