import type {
	ToolExecutionInvocation,
	ToolExecutionManifest,
} from "./sandbox";

export interface AgentToolCall {
	id: string;
	name: string;
	input: unknown;
}

export interface AgentImageAttachment {
	type: "image";
	name: string;
	mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
	sourceRef: string;
	sha256: string;
	data?: string;
}

export interface AgentMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	attachments?: AgentImageAttachment[];
	sources?: Array<{ name: string; mediaType: string; sourceRef: string; sha256: string }>;
	messageId?: string;
	kind?: "dialogue" | "summary" | "receipt" | "task_context";
	inReplyTo?: string;
	archivedContent?: string;
	sourceTool?: { name: string; input: unknown };
	readDependencies?: string[];
	receiptStatus?: "succeeded" | "unresolved" | "index";
	createdAt?: string;
	toolCalls?: AgentToolCall[];
	toolCallId?: string;
	providerState?: unknown;
	pinned?: boolean;
	durable?: boolean;
}

export interface AgentUsage {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
}

export interface AgentModelRequest {
	maxOutputTokens?: number;
	callContext?: { purpose: "summary" | "turn"; callId: string; sourceRef?: string; sourceRange?: [number, number] };
	/** Transient visible text only; never an authoritative completed response. */
	onText?: (text: string) => void | Promise<void>;
	messages: readonly AgentMessage[];
	tools: readonly AgentToolDefinition[];
	reasoning?: "disabled";
	outputSchema?: Record<string, unknown>;
	fallbackOutput: string;
}

export interface AgentModelResponse {
	text: string;
	toolCalls: AgentToolCall[];
	providerState?: unknown;
	usage: AgentUsage;
}

export interface AgentModelProvider {
	generate(request: AgentModelRequest, signal?: AbortSignal): Promise<AgentModelResponse>;
	countTokens?(request: AgentModelRequest, signal?: AbortSignal): Promise<number>;
}

export interface AgentToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

interface AgentToolBase extends AgentToolDefinition {
	/** Host source-lifecycle check when restoring archived output; never executes the tool. */
	validateContextResult?(input: unknown, output: string, context: AgentToolExecutionContext): void | Promise<void>;
	risk: "read" | "write" | "publish";
	idempotent: boolean;
	timeoutMs: number;
	maxResultChars: number;
	validate(input: unknown): boolean;
	createIdempotencyKey?(input: unknown, turnIdempotencyKey: string, scope?: Pick<AgentRunInput, "tenantId" | "workspaceId" | "runId">): string;
}

export interface AgentHostTool extends AgentToolBase {
	execution: "host";
	execute(input: unknown, context: AgentToolExecutionContext): Promise<unknown>;
}

export interface AgentSandboxedTool extends AgentToolBase {
	execution: "sandboxed";
	version: string;
	executable: string;
	sandbox: {
		environment: ToolExecutionManifest["environment"];
		network: ToolExecutionManifest["network"];
		limits: Omit<ToolExecutionManifest["limits"], "timeoutMs">;
	};
	createInvocation(input: unknown, context: AgentSandboxExecutionContext): ToolExecutionInvocation;
}

export type AgentTool = AgentHostTool | AgentSandboxedTool;

export type AgentToolFailureCode =
	| "tool_not_allowed"
	| "tool_input_invalid"
	| "tool_not_idempotent"
	| "tool_idempotency_conflict"
	| "tool_approval_required"
	| "tool_approval_denied"
	| "tool_execution_store_required"
	| "tool_timeout"
	| "tool_cancelled"
	| "tool_resource_exhausted"
	| "tool_sandbox_policy_denied"
	| "tool_sandbox_unavailable"
	| "tool_execution_unknown"
	| "tool_execution_failed";

export interface AgentToolExecutionContext {
	tenantId: string;
	workspaceId: string;
	runId: string;
	stageId: string;
	actorId: string;
	executionId: string;
	toolCallId: string;
	idempotencyKey: string;
	approvalId?: string;
	signal: AbortSignal;
}

export interface AgentSandboxExecutionContext extends AgentToolExecutionContext {
	sandboxAttemptId: string;
}

export interface AgentToolExecution {
	toolCallId: string;
	tool: string;
	risk: AgentTool["risk"];
	status: "succeeded" | "failed" | "denied" | "unknown";
	idempotencyKey: string;
	approvalId?: string;
	failureCode?: AgentToolFailureCode;
	durationMs: number;
	resultTruncated: boolean;
	replayed: boolean;
}

export interface AgentToolExecutionKey {
	tenantId: string;
	workspaceId: string;
	tool: string;
	idempotencyKey: string;
}

export interface AgentToolExecutionRecord extends AgentToolExecutionKey {
	schemaVersion: "tool-execution.v1";
	runId: string;
	stageId: string;
	actorId: string;
	executionId: string;
	toolCallId: string;
	risk: "write" | "publish";
	status: "started" | "succeeded" | "unknown";
	approvalId: string;
	inputDigest: string;
	resultDigest?: string;
	result?: string;
	failureCode?: AgentToolFailureCode;
	startedAt: string;
	completedAt?: string;
	/** Host-verified outcome; never supplied by a model or ordinary completion. */
	reconciliation?: { evidenceRef: string; previousStatus: "started" | "unknown"; previousFailureCode?: AgentToolFailureCode; previousResultDigest?: string; resolvedAt: string };
}

export interface AgentToolExecutionStore {
	list?(scope: { tenantId: string; workspaceId: string; runId: string }): Promise<AgentToolExecutionRecord[]>;
	claim(record: AgentToolExecutionRecord): Promise<{ record: AgentToolExecutionRecord; duplicate: boolean }>;
	complete(
		key: AgentToolExecutionKey,
		completion: Pick<AgentToolExecutionRecord, "status" | "result" | "resultDigest" | "failureCode" | "completedAt">,
	): Promise<AgentToolExecutionRecord>;
	find(key: AgentToolExecutionKey): Promise<AgentToolExecutionRecord | undefined>;
	resolve?(expected: AgentToolExecutionRecord, outcome: { result: string; resultDigest: string; evidenceRef: string; resolvedAt: string }): Promise<AgentToolExecutionRecord>;
}

export interface AgentToolApprovalPort {
	authorize(request: {
		tenantId: string;
		workspaceId: string;
		runId: string;
		stageId: string;
		actorId: string;
		executionId: string;
		tool: string;
		toolCallId: string;
		risk: "write" | "publish";
		input: unknown;
		idempotencyKey: string;
	}, signal?: AbortSignal): Promise<{ approved: boolean; approvalId?: string }>;
}

export interface AgentToolAuditEvent {
	type: "tool.execution.started" | "tool.execution.completed";
	tenantId: string;
	workspaceId: string;
	runId: string;
	stageId: string;
	actorId: string;
	executionId: string;
	tool: string;
	toolCallId: string;
	risk: AgentTool["risk"];
	idempotencyKey: string;
	approvalId?: string;
	status?: AgentToolExecution["status"];
	failureCode?: AgentToolFailureCode;
	replayed?: boolean;
	occurredAt: string;
}

export interface AgentToolAuditPort {
	append(event: AgentToolAuditEvent): void | Promise<void>;
}

export interface AgentContextSummary {
	text: string;
	usage: AgentUsage;
	coverage?: { complete: boolean; sourceMessages: number; coveredMessages: number; calls: number };
}

export interface AgentContextSummarizer {
	summarize(messages: readonly AgentMessage[], signal?: AbortSignal, sourceRef?: string): Promise<AgentContextSummary>;
}

export type AgentCoreFailureCode =
	| "model_failure"
	| "context_failure"
	| "budget_exceeded"
	| "permission_denied"
	| "max_iterations"
	| "infrastructure_failure";

export class AgentCoreError extends Error {
	constructor(
		readonly code: AgentCoreFailureCode,
		message: string,
		readonly retryable: boolean,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "AgentCoreError";
	}
}

export interface AgentSkill {
	name: string;
	version: string;
	description: string;
	instructions: string;
}

export interface AgentRunInput {
	tenantId: string;
	workspaceId: string;
	runId: string;
	stageId: string;
	actorId: string;
	executionId: string;
	idempotencyKey: string;
	instructions: readonly string[];
	skills: readonly AgentSkill[];
	history: readonly AgentMessage[];
	input: string;
	attachments?: readonly AgentImageAttachment[];
	resume?: boolean;
	allowedTools: readonly string[];
	policy: {
		sandboxMode: "read-only" | "workspace-write";
		approvalPolicy: "never" | "required";
	};
	outputSchema?: Record<string, unknown>;
	fallbackOutput: string;
}

export interface AgentRunResult {
	stopReason: "completed" | "slice_limit";
	finalText: string;
	messages: AgentMessage[];
	usage: AgentUsage;
	iterations: number;
	removedMessages: number;
	compactSummaries: number;
	toolExecutions: AgentToolExecution[];
}
