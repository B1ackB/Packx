import { createHash } from "node:crypto";
import { contextReadTool, pageUnits, readContextSource } from "./contextRead";
import type { ModelTelemetryStore } from "./modelTelemetry";
import type { RuntimeActivity } from "../../src/runtime/conversationContracts";
import type {
	AgentHostTool,
	AgentImageAttachment,
	AgentMessage,
	AgentModelProvider,
	AgentToolExecutionStore,
	AgentToolExecutionRecord,
} from "../../src/agent/contracts";
import { AgentCoreError } from "../../src/agent/contracts";
import { AgentHooks } from "../../src/agent/hooks";
import { abortable, AgentLoop, executionReceipt, type AgentLoopOptions } from "../../src/agent/loop";
import { SkillRegistry } from "../../src/agent/skills";
import { RuntimeLoopGuard } from "./loopGuard";
import {
	AgentStateStoreError,
	InMemoryAgentStateStore,
	type AgentSessionStore,
	type ContextSnapshotStore,
} from "../../src/agent/state";
import type {
	AgentRuntimePort,
	RuntimeHealth,
	RuntimeTraceStore,
	RuntimeTurnRequest,
	RuntimeTurnResult,
} from "../../src/runtime/contracts";
import { RuntimeFailure } from "../../src/runtime/contracts";
import { AnthropicCompatibilityError } from "../anthropic/client";

export interface BlackxAgentRuntimeOptions extends AgentLoopOptions {
	telemetry?: Pick<ModelTelemetryStore, "wrap">;
	onActivity?: (scope: { tenantId: string; workspaceId: string; runId: string }, activity: RuntimeActivity) => void;
	readTaskContext?: (request: RuntimeTurnRequest) => RuntimeTurnRequest["taskContext"];
	/** Enterprise outcome check only: must not repeat the external operation. */
	recoverToolExecution?: (record: AgentToolExecutionRecord, signal: AbortSignal) => Promise<{ result: string; evidenceRef: string } | undefined>;
	skills: SkillRegistry;
	sessions?: AgentSessionStore;
	snapshots?: ContextSnapshotStore;
	traces?: RuntimeTraceStore;
	clockMs?: () => number;
	resolveImageAttachment?: (
		scope: { tenantId: string; workspaceId: string },
		attachment: AgentImageAttachment,
	) => Promise<AgentImageAttachment>;
}

function withoutImageData(message: AgentMessage): AgentMessage {
	const { attachments, ...rest } = message;
	if (!attachments) return rest;
	return {
		...rest,
		attachments: attachments.map(({ data: _data, ...attachment }) => attachment),
	};
}

function classifyFailure(error: unknown, timedOut: boolean, cancelled: boolean): RuntimeFailure {
	if (error instanceof RuntimeFailure) return error;
	if (timedOut) return new RuntimeFailure("timeout", "Agent turn timed out", true, { cause: error });
	if (cancelled) return new RuntimeFailure("cancelled", "Agent turn cancelled", false, { cause: error });
	let cause: unknown = error;
	for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
		if (cause instanceof RuntimeFailure) return cause;
		if (cause instanceof AnthropicCompatibilityError) {
			if (cause.code === "context_window_exceeded") {
				return new RuntimeFailure("budget_exceeded", "Model context window was exceeded", false, { cause: error });
			}
			if (cause.code === "output_limit" || cause.code === "refusal") {
				return new RuntimeFailure("invalid_output", "Model did not produce a complete usable response", cause.code === "output_limit", { cause: error });
			}
			if (cause.providerStatus === 401 || cause.providerStatus === 403) {
				return new RuntimeFailure("authentication", "Model provider authentication failed", false, { cause: error });
			}
			if (cause.providerStatus === 429) {
				return new RuntimeFailure("rate_limit", "Model provider rate limited", true, { cause: error });
			}
			const status = cause.providerStatus ?? cause.adapterStatus;
			return new RuntimeFailure("model_failure", "Model provider request failed", Boolean(status && status >= 500), { cause: error });
		}
		cause = cause.cause;
	}
	if (error instanceof AgentCoreError) {
		return new RuntimeFailure(error.code, error.message, error.retryable, { cause: error });
	}
	if (error instanceof AgentStateStoreError) {
		if (error.code === "conflict") {
			return new RuntimeFailure("session_conflict", error.message, true, { cause: error });
		}
		return new RuntimeFailure("context_failure", error.message, error.code === "unavailable", { cause: error });
	}
	const message = error instanceof Error ? error.message : "Agent execution failed";
	if (message.includes("without a final response")) {
		return new RuntimeFailure("invalid_output", message, true, { cause: error });
	}
	return new RuntimeFailure("execution_failed", "Agent execution failed", true, { cause: error });
}

export class BlackxAgentRuntime implements AgentRuntimePort {
	private readonly sessions: AgentSessionStore;
	private readonly snapshots: ContextSnapshotStore;
	private readonly executions: AgentToolExecutionStore;
	private readonly traces: RuntimeTraceStore;
	private readonly now: () => string;
	private readonly clockMs: () => number;

	constructor(private readonly options: BlackxAgentRuntimeOptions) {
		const memory = new InMemoryAgentStateStore();
		this.sessions = options.sessions ?? memory;
		this.snapshots = options.snapshots ?? memory;
		this.executions = options.executions ?? memory;
		this.traces = options.traces ?? memory;
		this.now = options.now ?? (() => new Date().toISOString());
		this.clockMs = options.clockMs ?? (() => Date.now());
	}

	private providerStatus: NonNullable<RuntimeHealth["providerStatus"]> = "configured";

	async health(): Promise<RuntimeHealth> {
		return { adapter: "blackx-agent", online: true, coreVersion: "m0.1", providerStatus: this.providerStatus };
	}

	async executeTurn(request: RuntimeTurnRequest, signal?: AbortSignal): Promise<RuntimeTurnResult> {
		if (![request.tenantId, request.workspaceId, request.runId, request.stageId, request.actorId, request.idempotencyKey].every((value) => value.trim())) {
			throw new RuntimeFailure("invalid_output", "Runtime identity and idempotency fields must be non-empty", false);
		}
		if (request.resume && !request.sessionId) {
			throw new RuntimeFailure("invalid_output", "Runtime resume requires a Session ID", false);
		}
		if ((request.attachments?.length ?? 0) > 8 || request.attachments?.some((attachment) => attachment.data)) {
			throw new RuntimeFailure("invalid_output", "Runtime accepts up to 8 image references and no inline image data", false);
		}
		if (request.limits && [request.limits.maxIterations, request.limits.maxToolExecutions, request.limits.maxInputTokens].some((value) => !Number.isInteger(value) || value < 1)) throw new RuntimeFailure("invalid_output", "Runtime limits must be positive integers", false);
		const timeout = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			timeout.abort(new Error("runtime_timeout"));
		}, request.policy.timeoutMs);
		const combinedSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
		const sessionId = request.sessionId ?? `session-${crypto.randomUUID()}`;
		const executionId = crypto.randomUUID();
		const startedAt = this.now();
		const startedMs = this.clockMs();
		let traceEvents: RuntimeTurnResult["events"] = [
			{ type: "session.started", sessionId },
			{ type: "turn.started" },
		];
		const snapshotBaseId = request.contextSnapshotId ?? `context-${executionId}`;
		const scope = {
			tenantId: request.tenantId,
			workspaceId: request.workspaceId,
			runId: request.runId,
			sessionId,
		};

		const progress = (phase: RuntimeActivity["phase"], detail: { tool?: string; iteration?: number; partialText?: string } = {}) => {
			this.options.onActivity?.(scope, { executionId, phase, updatedAt: this.now(), ...detail });
		};
		let guard = new RuntimeLoopGuard();
		try {
			combinedSignal.throwIfAborted();
			const previous = this.traces.listTraces(scope)
				.filter((trace) => trace.stageId === request.stageId && trace.idempotencyKey === request.idempotencyKey && trace.sessionId === sessionId && trace.loopGuard)
				.sort((a, b) => b.loopGuard!.sequence - a.loopGuard!.sequence)[0]?.loopGuard;
			guard = new RuntimeLoopGuard(previous);
			guard.check();
			progress("starting");
			const session = this.sessions.load(scope);
			if (request.resume === true && session.revision === 0) {
				throw new RuntimeFailure("context_failure", "Runtime Session does not exist for resume", false);
			}
			const resuming = Boolean(request.resume && session.revision > 0);
			const taskContext = this.options.readTaskContext?.(request) ?? request.taskContext;
			if (resuming && session.checkpoint?.turnKey === request.idempotencyKey && session.checkpoint.contextBinding !== taskContext?.binding) throw new RuntimeFailure("context_failure", "Checkpoint task facts or source versions changed; rebuild the task", false);
			let sessionRevision = session.revision;
			const validateContext = () => {
				const current = this.options.readTaskContext?.(request) ?? request.taskContext;
				if (current?.binding !== taskContext?.binding) throw new RuntimeFailure("context_failure", "Task facts or source versions changed during execution", false);
			};
			const replyId = `reply-${createHash("sha256").update(request.idempotencyKey).digest("hex")}`;
			const priorReply = session.transcript?.find((message) => message.messageId === replyId);
			if (priorReply) {
				const priorInput = session.transcript?.find((message) => message.messageId === replyId.replace("reply-", "input-"));
				if (priorInput && (priorInput.content !== request.input || JSON.stringify(priorInput.attachments ?? []) !== JSON.stringify(request.attachments ?? []))) throw new RuntimeFailure("session_conflict", "Turn idempotency key was reused with different input", false);
				const trace = this.traces.listTraces(scope).findLast((item) => item.sessionId === sessionId && item.idempotencyKey === request.idempotencyKey && item.status === "completed");
				if (!trace) throw new RuntimeFailure("context_failure", "Completed dialogue is missing execution evidence; review required", false);
				return { adapter: "blackx-agent", status: "completed", sessionId, executionId: trace.executionId, finalResponse: priorReply.content, events: trace.events, usage: trace.usage, contextSnapshotId: trace.contextSnapshotId };
			}
			const hydrate = async (attachment: AgentImageAttachment): Promise<AgentImageAttachment> => {
				if (!this.options.resolveImageAttachment) {
					throw new RuntimeFailure("context_failure", "Runtime image resolver is not configured", false);
				}
				let resolved: AgentImageAttachment;
				try {
					resolved = await abortable(this.options.resolveImageAttachment(scope, attachment), combinedSignal);
				} catch (error) {
					combinedSignal.throwIfAborted();
					throw new RuntimeFailure("context_failure", "Runtime image attachment could not be resolved", false, { cause: error });
				}
				if (
					!resolved.data ||
					resolved.sourceRef !== attachment.sourceRef ||
					resolved.sha256 !== attachment.sha256 ||
					resolved.mediaType !== attachment.mediaType
				) {
					throw new RuntimeFailure("context_failure", "Runtime image attachment failed integrity validation", false);
				}
				return resolved;
			};
			const validateSources = async (messages: readonly AgentMessage[], visited = new Set<string>()): Promise<void> => {
				// Older v2 records predate context_read source metadata. Complete protocol
				// groups still retain the trusted tool name and original input.
				const legacyReads = new Map<string, unknown>();
				for (const message of messages) {
					if (message.role !== "tool") {
						legacyReads.clear();
						if (message.role === "assistant") for (const call of message.toolCalls ?? []) if (call.name === "context_read") legacyReads.set(call.id, call.input);
					}
					combinedSignal.throwIfAborted();
					for (const ref of message.readDependencies ?? []) {
						if (visited.has(ref)) continue;
						if (visited.size >= 128) throw new RuntimeFailure("context_failure", "Context source dependency limit exceeded; rebuild task", false);
						visited.add(ref);
						const dependency = this.snapshots.read(scope, ref);
						if (taskContext?.historyBinding !== undefined && dependency.historyBinding !== taskContext.historyBinding) throw new RuntimeFailure("context_failure", "Archived context dependency changed; rebuild task", false);
						await validateSources(dependency.messages, visited);
					}
					let legacyRead: { name: string; input: unknown } | undefined;
					if (!message.sourceTool && message.role === "tool" && message.toolCallId && legacyReads.has(message.toolCallId)) {
						try {
							const output = JSON.parse(message.content) as { status?: string };
							if (["historical_unverified", "body_externalized"].includes(output.status ?? "")) legacyRead = { name: "context_read", input: legacyReads.get(message.toolCallId) };
						} catch { /* Failed reads and ordinary text do not assert a readable source. */ }
					}
					if (!message.sourceTool && !legacyRead && message.role === "tool") {
						// Pre-fix externalized readbacks are singleton archives, without
						// their assistant call. Recognize only the Host's exact page shape.
						try {
							const value = JSON.parse(message.content) as Record<string, unknown>;
							const page = value.status === "historical_unverified" && typeof value.stale === "boolean" && Array.isArray(value.items) && Number.isSafeInteger(value.offset) && Number.isSafeInteger(value.total) && typeof value.truncated === "boolean" && (value.nextOffset === null || Number.isSafeInteger(value.nextOffset));
							const external = value.status === "body_externalized" && value.readTool === "context_read" && value.truncated === true;
							if ((page || external) && typeof value.sourceRef === "string") legacyRead = { name: "context_read", input: { sourceRef: value.sourceRef } };
						} catch { /* Unrelated text is not treated as a source reference. */ }
					}
					const sourceTool = message.sourceTool ?? legacyRead;
					if (!sourceTool) continue;
					if (sourceTool.name === "context_read") {
						const ref = (sourceTool.input as { sourceRef?: unknown })?.sourceRef;
						if (typeof ref !== "string") throw new RuntimeFailure("context_failure", "Archived context read has no source", false);
						if (visited.has(ref)) continue;
						if (visited.size >= 128) throw new RuntimeFailure("context_failure", "Context source dependency limit exceeded; rebuild task", false);
						visited.add(ref);
						try {
							const source = readContextSource(scope, this.sessions, this.snapshots, ref, taskContext?.binding, taskContext?.historyBinding);
							await validateSources(source.messages, visited);
						} catch (error) { throw new RuntimeFailure("context_failure", "Read-back source is unavailable, changed or no longer permitted", false, { cause: error }); }
						continue;
					}
					const tool = this.options.tools?.find((item) => item.name === sourceTool.name);
					if (!tool?.validateContextResult) throw new RuntimeFailure("context_failure", "Source validation tool unavailable", false);
					let output = message.content;
					let envelope: { status?: string; sourceRef?: string } | undefined;
					try { envelope = JSON.parse(output); } catch { /* Plain-text bodies are validated by their source adapter. */ }
					if (envelope?.status === "body_externalized" && typeof envelope.sourceRef === "string") output = this.snapshots.read(scope, envelope.sourceRef).messages[0].content;
					try { await abortable(Promise.resolve(tool.validateContextResult(sourceTool.input, output, { ...scope, actorId: request.actorId, executionId, stageId: request.stageId, toolCallId: message.toolCallId ?? "restore", idempotencyKey: request.idempotencyKey, signal: combinedSignal })), combinedSignal); }
					catch (error) { combinedSignal.throwIfAborted(); throw new RuntimeFailure("context_failure", "Context source is unavailable, changed or no longer permitted", false, { cause: error }); }
				}
			};
			const observationEvents: RuntimeTurnResult["events"] = [];
			const rebuild = taskContext?.historyBinding !== undefined && session.historyBinding !== taskContext.historyBinding;
			// ConversationApi persists the current user input before resume. Keep only
			// that exact turn; the last older user instruction may have been superseded.
			const currentInputId = replyId.replace("reply-", "input-");
			const working = rebuild ? session.messages.filter((message) => message.role === "user" && (!message.kind || message.kind === "dialogue") && !message.durable && (message.messageId === request.idempotencyKey || message.messageId === currentInputId)) : session.messages;
			if (rebuild && session.messages.length) {
				const event = { type: "context.rebuilt" as const, reason: "history_binding_changed" as const, discardedMessages: session.messages.length - working.length };
				observationEvents.push(event); traceEvents.push(event);
			}
			await validateSources(working);
			const selectedImageMessage = request.attachments?.length ? undefined : working.findLast((message) => message.attachments?.length && message.pinned);
			const history: AgentMessage[] = await Promise.all(working.filter((message) => message.kind !== "task_context").map(async (message) => ({
				...message,
				...(message.attachments?.length && message !== selectedImageMessage ? {
					attachments: message.attachments.map(({ data: _data, ...reference }) => reference),
				} : { attachments: message.attachments ? await Promise.all(message.attachments.map(hydrate)) : undefined }),
			})));
			if (this.executions.list) {
				const ledger = await abortable(this.executions.list(scope), combinedSignal);
				let recoveryChecks = 0;
				for (let index = 0; index < ledger.length; index++) {
					const record = ledger[index];
					if (record.status === "succeeded" || record.actorId !== request.actorId || !request.allowedTools?.includes(record.tool) || !this.options.recoverToolExecution || !this.executions.resolve || recoveryChecks >= 32) continue;
					recoveryChecks++;
					const tool = this.options.tools?.find((tool) => tool.name === record.tool);
					if (!tool || tool.risk === "read") continue;
					const recoverySignal = AbortSignal.any([combinedSignal, AbortSignal.timeout(Math.min(tool.timeoutMs, 5000))]);
					const recoveryStarted = this.clockMs();
					let recoveryFailure: "no_evidence" | "source_unavailable" | "timeout" = "no_evidence";
					let outcome: { result: string; evidenceRef: string } | undefined;
					try { outcome = await abortable(this.options.recoverToolExecution(record, recoverySignal), recoverySignal); }
					catch { combinedSignal.throwIfAborted(); recoveryFailure = recoverySignal.aborted ? "timeout" : "source_unavailable"; }
					combinedSignal.throwIfAborted();
					validateContext();
					if (outcome) ledger[index] = await abortable(this.executions.resolve(record, { ...outcome, resultDigest: `sha256:${createHash("sha256").update(outcome.result).digest("hex")}`, resolvedAt: this.now() }), combinedSignal);
					const event = { type: "tool.reconciled" as const, tool: record.tool, toolCallId: record.toolCallId, idempotencyKey: record.idempotencyKey, status: outcome ? "succeeded" as const : "unresolved" as const, durationMs: Math.max(0, this.clockMs() - recoveryStarted), ...(outcome ? { evidenceRef: outcome.evidenceRef } : { failureCode: recoveryFailure }) };
					traceEvents.push(event); observationEvents.push(event);
				}
				if (ledger.length) {
					for (let i = history.length - 1; i >= 0; i--) if (history[i].kind === "receipt" || history[i].content.startsWith("[Deterministic tool execution receipts;")) history.splice(i, 1);
					const recent = ledger.filter((record) => record.status === "succeeded").sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-4);
					history.push(executionReceipt([...ledger.filter((record) => record.status !== "succeeded"), ...recent]));
					history.push({ role: "user", kind: "receipt", receiptStatus: "index", pinned: true, durable: true, content: "Complete receipts are in execution_ledger_read. Never repeat successful operations or replay unknown effects without reconciliation." });
				}
			}
			if (taskContext) history.unshift({ role: "user", kind: "task_context", content: taskContext.content, pinned: true, durable: true });
			const inputAttachments = request.attachments && !resuming
				? await Promise.all(request.attachments.map(hydrate))
				: undefined;
			if (combinedSignal.aborted) throw combinedSignal.reason;
			const skills = this.options.skills.resolve(request.skills ?? []);
			let removedMessages = 0;
			let finalContextSnapshotId: string | undefined;
			const observe = (event: RuntimeTurnResult["events"][number]) => {
				observationEvents.push(event);
				traceEvents.push(event);
			};
			const resolvedAttachmentCount = history.reduce(
				(count, message) => count + (message.attachments?.filter((attachment) => attachment.data).length ?? 0),
				inputAttachments?.length ?? 0,
			);
			if (resolvedAttachmentCount > 0) {
				observe({ type: "input.attachments.resolved", count: resolvedAttachmentCount });
			}
			const modelStarted = new Map<number, number>();
			const maxIterations = Math.min(request.limits?.maxIterations ?? Infinity, this.options.maxIterations ?? 32);
			const maxToolExecutions = Math.min(request.limits?.maxToolExecutions ?? Infinity, this.options.maxToolExecutions ?? 64);
			let attemptedTools = 0, currentIteration = 0, pendingBatchTools = 0;
			const hooks = new AgentHooks(this.options.hooks);
			guard.attach(hooks, combinedSignal);
			hooks.on("compact.after", (event) => {
				removedMessages += event.removedMessages;
				observe({
					type: "context.compacted",
					removedMessages: event.removedMessages,
					summaries: event.summary ? 1 : 0,
					beforeChars: event.beforeChars, afterChars: event.afterChars, estimatedTokens: event.estimatedTokens, coverage: event.coverage,
				});
			});
			let partialText = "";
			hooks.on("model.delta", (event) => {
				combinedSignal.throwIfAborted();
				partialText = (partialText + event.text).slice(0, 128_000);
				progress("model", { iteration: event.iteration, partialText });
			});
			hooks.on("tool.before", (event) => { attemptedTools++; pendingBatchTools--; progress("tool", { tool: event.call.name, iteration: event.iteration }); });
			hooks.on("model.before", (event) => {
				combinedSignal.throwIfAborted();
				currentIteration = event.iteration;
				partialText = "";
				progress("model", { iteration: event.iteration, partialText });
				const snapshotId = `${snapshotBaseId}-i${event.iteration}${event.attempt > 1 ? `-retry${event.attempt}` : ""}`;
				const saved = this.snapshots.put({
					schemaVersion: "context-snapshot.v2",
					...(taskContext ? { contextBinding: taskContext.binding } : {}),
					...(taskContext?.historyBinding ? { historyBinding: taskContext.historyBinding } : {}),
					...scope,
					snapshotId,
					iteration: event.iteration,
					skills: skills.map((skill) => ({ name: skill.name, version: skill.version })),
					messages: event.messages.map(withoutImageData),
					estimatedChars: event.messages.reduce(
						(total, message) => total
							+ message.content.length
							+ JSON.stringify(message.attachments ?? []).length
							+ JSON.stringify(message.toolCalls ?? []).length
							+ JSON.stringify(message.providerState ?? null).length,
						0,
					),
					estimatedTokens: event.estimatedTokens,
					removedMessages,
					createdAt: this.now(),
				});
				finalContextSnapshotId = saved.snapshotId;
				observe({ type: "context.snapshot.saved", snapshotId: saved.snapshotId, iteration: saved.iteration });
				modelStarted.set(event.iteration, this.clockMs());
				observe({ type: "model.started", iteration: event.iteration, attempt: event.attempt });
			});
			hooks.on("model.after", (event) => {
				pendingBatchTools = event.response.toolCalls.length;
				const completedAt = this.clockMs();
				observe({
					type: "model.completed",
					iteration: event.iteration,
					durationMs: Math.max(0, completedAt - (modelStarted.get(event.iteration) ?? completedAt)),
					usage: { ...event.response.usage },
				});
			});
			const saveWorking = (messages: readonly AgentMessage[], paused: boolean) => {
				validateContext();
				const saved = this.sessions.save(scope, sessionRevision, messages
					.filter((message) => message.kind !== "task_context" && !(message.role === "system" && message.pinned))
					.map((message) => ({ ...withoutImageData(message), pinned: message.durable === true || (paused && message.pinned === true) })),
					this.now(), paused ? { turnKey: request.idempotencyKey, ...(taskContext ? { contextBinding: taskContext.binding } : {}) } : null, taskContext?.historyBinding);
				sessionRevision = saved.revision;
			};
			hooks.on("loop.checkpoint", (event) => saveWorking(event.messages, true));
			const archive = (snapshotId: string, messages: readonly AgentMessage[], purpose: "archive" | "summary" = "archive") => {
				this.snapshots.put({ ...scope, schemaVersion: "context-snapshot.v2", snapshotId, iteration: 1, skills: [], messages: messages.map(withoutImageData),
					estimatedChars: JSON.stringify(messages.map(withoutImageData)).length, estimatedTokens: 0, removedMessages: 0, createdAt: this.now(), purpose,
					...(taskContext ? { contextBinding: taskContext.binding } : {}), ...(taskContext?.historyBinding ? { historyBinding: taskContext.historyBinding } : {}) });
			};
			hooks.on("compact.source", async (event) => { await validateSources(event.messages); archive(event.sourceRef, event.messages); });
			const validateRequestSources = async (modelRequest: Parameters<AgentModelProvider["generate"]>[0]) => {
				validateContext();
				const summarySource = modelRequest.callContext?.purpose === "summary" ? modelRequest.callContext.sourceRef : undefined;
				await validateSources(summarySource ? this.snapshots.read(scope, summarySource).messages : modelRequest.messages);
			};
			const measuredProvider = this.options.telemetry?.wrap(this.options.provider, scope, executionId) ?? this.options.provider;
			const provider = { ...measuredProvider,
				...(measuredProvider.countTokens ? { countTokens: async (modelRequest: Parameters<typeof measuredProvider.generate>[0], modelSignal?: AbortSignal) => {
					await validateRequestSources(modelRequest);
					if (modelRequest.callContext?.purpose === "summary") archive(modelRequest.callContext.callId, modelRequest.messages, "summary");
					return measuredProvider.countTokens!(modelRequest, modelSignal);
				} } : {}),
				generate: async (modelRequest: Parameters<typeof measuredProvider.generate>[0], modelSignal?: AbortSignal) => {
					await validateRequestSources(modelRequest);
					const call = modelRequest.callContext;
					if (call?.purpose !== "summary") return measuredProvider.generate({ ...modelRequest, callContext: { purpose: "turn", callId: finalContextSnapshotId ?? executionId } }, modelSignal);
					archive(call.callId, modelRequest.messages, "summary");
					const started = this.clockMs();
					const event = { type: "context.summary" as const, callId: call.callId, sourceRef: call.sourceRef, sourceRange: call.sourceRange };
					observe({ ...event, status: "started" });
					try {
						const response = await measuredProvider.generate(modelRequest, modelSignal);
						observe({ ...event, status: "completed", durationMs: Math.max(0, this.clockMs() - started), usage: response.usage });
						return response;
					} catch (error) {
						observe({ ...event, status: "failed", durationMs: Math.max(0, this.clockMs() - started) });
						throw error;
					}
				},
			};
			let externalized = 0;
			const recoveryTool = contextReadTool(scope, this.sessions, this.snapshots, validateContext, taskContext?.binding, validateSources, taskContext?.historyBinding, () => ({ remainingTools: Math.max(0, maxToolExecutions - attemptedTools - pendingBatchTools), remainingIterations: Math.max(0, maxIterations - currentIteration) }));
			const ledgerTool: AgentHostTool = {
				name: "execution_ledger_read", description: "Read deterministic execution receipts for this task; inspect success/unknown before repeating side effects. Results are references, not new authorization.",
				execution: "host", risk: "read", idempotent: true, timeoutMs: 1000, maxResultChars: 16_000,
				inputSchema: { type: "object", properties: { offset: { type: "integer", minimum: 0 } }, additionalProperties: false },
				validate: (input) => !!input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every((key) => key === "offset") && (!("offset" in input) || Number.isSafeInteger(input.offset) && Number(input.offset) >= 0),
				execute: async (input) => {
					validateContext(); this.sessions.load(scope);
					if (!this.executions.list) throw new Error("ledger_listing_unavailable");
					const records = await this.executions.list(scope);
					return pageUnits(records.map(({ result: _body, ...record }) => record).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.idempotencyKey.localeCompare(b.idempotencyKey)), (input as { offset?: number }).offset ?? 0);
				},
			};
			const loop = new AgentLoop({
				provider,
				tools: [...(this.options.tools ?? []), recoveryTool, ledgerTool],
				externalizeToolResult: async (content, sourceTool) => {
					const sourceRef = `tool-result-${executionId}-${++externalized}`;
					archive(sourceRef, [{ role: "tool", content, ...(sourceTool ? { sourceTool } : {}) }]);
					return JSON.stringify({ truncated: true, sourceRef, characters: content.length, readTool: "context_read", status: "body_externalized" });
				},
				context: this.options.context,
				contextWindowTokens: this.options.contextWindowTokens,
				reservedOutputTokens: this.options.reservedOutputTokens,
				safetyMarginTokens: this.options.safetyMarginTokens,
				summarizer: this.options.summarizer,
				approval: this.options.approval,
				audit: this.options.audit,
				executions: this.executions,
				sandboxedToolExecutor: this.options.sandboxedToolExecutor,
				maxIterations,
				maxToolExecutions,
				maxInputTokens: request.limits ? Math.min(request.limits.maxInputTokens, this.options.maxInputTokens ?? 100_000) : this.options.maxInputTokens,
				compactTriggerTokens: this.options.compactTriggerTokens,
				compactTargetTokens: this.options.compactTargetTokens,
				now: this.now,
				hooks,
			});
			const result = await abortable(loop.run({
				tenantId: request.tenantId,
				workspaceId: request.workspaceId,
				runId: request.runId,
				stageId: request.stageId,
				actorId: request.actorId,
				executionId,
				idempotencyKey: request.idempotencyKey,
				instructions: request.instructions ?? [],
				skills,
				history,
				input: resuming ? "" : request.input,
				attachments: inputAttachments,
				resume: resuming,
				allowedTools: [...(request.allowedTools ?? []), "context_read", "execution_ledger_read"],
				policy: request.policy,
				outputSchema: request.outputSchema,
				fallbackOutput: request.fallbackOutput,
			}, combinedSignal), combinedSignal);
			combinedSignal.throwIfAborted();
			saveWorking(result.messages, result.stopReason === "slice_limit");
			const response: RuntimeTurnResult = {
				executionId,
				adapter: "blackx-agent",
				status: result.stopReason === "completed" ? "completed" : "paused",
				sessionId,
				contextSnapshotId: finalContextSnapshotId,
				finalResponse: result.finalText,
				events: [
					{ type: "session.started", sessionId },
					{ type: "turn.started" },
					...observationEvents,
					...result.toolExecutions.flatMap((execution) => [
						{
							type: "tool.started" as const,
							tool: execution.tool,
							toolCallId: execution.toolCallId,
							risk: execution.risk,
							idempotencyKey: execution.idempotencyKey,
						},
						{
							type: "tool.completed" as const,
							tool: execution.tool,
							toolCallId: execution.toolCallId,
							risk: execution.risk,
							status: execution.status,
							failureCode: execution.failureCode,
							durationMs: execution.durationMs,
							resultTruncated: execution.resultTruncated,
							replayed: execution.replayed,
						},
					]),
					...(result.stopReason === "completed"
						? [
							{ type: "message.completed" as const, text: result.finalText },
							{ type: "turn.completed" as const, usage: result.usage, iterations: result.iterations },
						]
						: [{ type: "turn.checkpointed" as const, reason: "iteration_slice_limit" as const, iterations: result.iterations }]),
				],
				usage: result.usage,
			};
			traceEvents = response.events;
			this.traces.putTrace({
				schemaVersion: "runtime-trace.v1",
				tenantId: request.tenantId,
				workspaceId: request.workspaceId,
				runId: request.runId,
				stageId: request.stageId,
				actorId: request.actorId,
				executionId,
				idempotencyKey: request.idempotencyKey,
				status: response.status,
				startedAt,
				completedAt: this.now(),
				durationMs: Math.max(0, this.clockMs() - startedMs),
				sessionId,
				contextSnapshotId: response.contextSnapshotId,
				events: response.events.map((event) => event.type === "message.completed"
					? { ...event, text: "[stored in session]" }
					: event),
				usage: response.usage,
				loopGuard: guard.state,
			});
			this.providerStatus = "last_request_succeeded";
			progress(response.status);
			return response;
		} catch (error) {
			const failure = classifyFailure(error, timedOut, Boolean(signal?.aborted));
			if (guard.state.blocked) traceEvents.push({ type: "loop.guard.stopped", code: guard.state.blocked });
			if (failure.code !== "cancelled") this.providerStatus = "last_request_failed";
			const reportingFailures: unknown[] = [];
			try { progress("failed"); } catch (reportingError) { reportingFailures.push(reportingError); }
			traceEvents = [...traceEvents, { type: "turn.failed", message: failure.message }];
			try { this.traces.putTrace({
				schemaVersion: "runtime-trace.v1",
				tenantId: request.tenantId,
				workspaceId: request.workspaceId,
				runId: request.runId,
				stageId: request.stageId,
				actorId: request.actorId,
				executionId,
				idempotencyKey: request.idempotencyKey,
				status: "failed",
				startedAt,
				completedAt: this.now(),
				durationMs: Math.max(0, this.clockMs() - startedMs),
				sessionId,
				events: traceEvents,
				failure: { code: failure.code, retryable: failure.retryable, message: failure.message },
				loopGuard: guard.state,
			}); } catch (reportingError) { reportingFailures.push(reportingError); }
			if (reportingFailures.length) {
				throw new RuntimeFailure(failure.code, failure.message, failure.retryable, {
					cause: new AggregateError([failure, ...reportingFailures], "Runtime failure reporting failed", { cause: failure }),
				});
			}
			throw failure;
		} finally {
			clearTimeout(timer);
		}
	}
}
