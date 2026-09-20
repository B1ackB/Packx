import type {
	AgentContextSummarizer,
	AgentMessage,
	AgentModelProvider,
	AgentRunInput,
	AgentRunResult,
	AgentTool,
	AgentToolApprovalPort,
	AgentToolAuditPort,
	AgentToolExecution,
	AgentToolExecutionContext,
	AgentToolExecutionRecord,
	AgentToolExecutionStore,
	AgentToolFailureCode,
	AgentUsage,
} from "./contracts";
import { AgentCoreError } from "./contracts";
import { compactSummaryPrefix, ContextEngine } from "./context";
import { AgentHooks } from "./hooks";
import {
	compileToolExecutionManifest,
	validToolExecutionManifest,
	validToolExecutionResult,
} from "./sandbox";
import type {
	SandboxedToolExecutorPort,
	ToolExecutionResult,
} from "./sandbox";
import { defaultContextBudget, estimateRequestTokens } from "./tokenBudget";
import { defaultSummaryBudget, ModelContextSummarizer } from "./summarizer";

const emptyUsage = (): AgentUsage => ({
	inputTokens: 0,
	cachedInputTokens: 0,
	outputTokens: 0,
	reasoningOutputTokens: 0,
});

function addUsage(total: AgentUsage, next: AgentUsage): void {
	total.inputTokens += next.inputTokens;
	total.cachedInputTokens += next.cachedInputTokens;
	total.outputTokens += next.outputTokens;
	total.reasoningOutputTokens += next.reasoningOutputTokens;
}

export async function abortable<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
	if (signal.aborted) throw signal.reason;
	return new Promise<Value>((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		signal.addEventListener("abort", aborted, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
	});
}

async function toolOutput(value: unknown, maxChars: number, externalize?: (content: string) => Promise<string>): Promise<{ text: string; truncated: boolean; archivedContent?: string }> {
	let output: string;
	if (typeof value === "string") output = value;
	else {
		try {
			output = JSON.stringify(value) ?? "Tool returned no serializable result";
		} catch {
			output = "Tool returned a non-serializable result";
		}
	}
	const archivedContent = externalize && output.length > Math.min(4000, maxChars) ? await externalize(output) : undefined;
	return output.length <= maxChars
		? { text: output, truncated: false, archivedContent }
		: { text: archivedContent ?? JSON.stringify({ ok: false, error: { code: "tool_result_too_large", message: "No partial value returned; use a paginated tool" }, truncated: true }), truncated: true };
}

function toolFailure(code: AgentToolFailureCode, message: string): string {
	return JSON.stringify({ ok: false, error: { code, message } });
}

function validToolInput(tool: AgentTool, input: unknown): boolean {
	try {
		return tool.validate(input);
	} catch {
		return false;
	}
}

function sandboxFailure(status: Exclude<ToolExecutionResult["status"], "succeeded">): {
	code: AgentToolFailureCode;
	message: string;
} {
	switch (status) {
		case "timed_out": return { code: "tool_timeout", message: "Sandboxed Tool execution timed out" };
		case "cancelled": return { code: "tool_cancelled", message: "Sandboxed Tool execution was cancelled" };
		case "resource_exhausted": return { code: "tool_resource_exhausted", message: "Sandboxed Tool exceeded a resource limit" };
		case "policy_denied": return { code: "tool_sandbox_policy_denied", message: "Sandbox policy denied Tool execution" };
		case "sandbox_unavailable": return { code: "tool_sandbox_unavailable", message: "Native Tool Sandbox is unavailable" };
		case "failed": return { code: "tool_execution_failed", message: "Sandboxed Tool execution failed" };
	}
}

function nestedCode(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
		if ("code" in current && typeof current.code === "string") return current.code;
		current = current.cause;
	}
	return undefined;
}

async function digest(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function executionReceipt(records: readonly AgentToolExecutionRecord[]): AgentMessage {
	return {
		role: "user",
		kind: "receipt",
	receiptStatus: records.every((record) => record.status === "succeeded") ? "succeeded" : "unresolved",
		content: [
			"[Deterministic tool execution receipts; authoritative values come from the execution ledger]",
			JSON.stringify(records.map((record) => ({
				actorId: record.actorId,
				executionId: record.executionId,
				tool: record.tool,
				toolCallId: record.toolCallId,
				idempotencyKey: record.idempotencyKey,
				status: record.status,
				approvalId: record.approvalId,
				inputDigest: record.inputDigest,
				resultDigest: record.resultDigest,
				failureCode: record.failureCode,
			}))),
		].join("\n"),
		pinned: true,
		durable: true,
	};
}

export interface AgentLoopOptions {
	provider: AgentModelProvider;
	externalizeToolResult?: (content: string, sourceTool?: AgentMessage["sourceTool"]) => Promise<string>;
	tools?: readonly AgentTool[];
	hooks?: AgentHooks;
	context?: ContextEngine;
	summarizer?: AgentContextSummarizer;
	approval?: AgentToolApprovalPort;
	audit?: AgentToolAuditPort;
	executions?: AgentToolExecutionStore;
	sandboxedToolExecutor?: SandboxedToolExecutorPort;
	maxIterations?: number;
	maxToolExecutions?: number;
	maxInputTokens?: number;
	contextWindowTokens?: number;
	reservedOutputTokens?: number;
	safetyMarginTokens?: number;
	compactTriggerTokens?: number;
	compactTargetTokens?: number;
	now?: () => string;
}

export class AgentLoop {
	private readonly tools: Map<string, AgentTool>;
	private readonly hooks: AgentHooks;
	private readonly context: ContextEngine;
	private readonly summarizer: AgentContextSummarizer;
	private readonly maxIterations: number;
	private readonly maxToolExecutions: number;
	private readonly maxInputTokens: number;
	private readonly compactTriggerTokens: number;
	private readonly compactTargetTokens: number;
	private readonly now: () => string;

	constructor(private readonly options: AgentLoopOptions) {
		this.tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
		this.hooks = options.hooks ?? new AgentHooks();
		this.context = options.context ?? new ContextEngine();
		this.maxIterations = options.maxIterations ?? 32;
		this.maxToolExecutions = options.maxToolExecutions ?? 64;
		this.maxInputTokens = Math.min(options.maxInputTokens ?? defaultContextBudget.applicationInputTokens,
			(options.contextWindowTokens ?? defaultContextBudget.contextWindowTokens) - (options.reservedOutputTokens ?? defaultContextBudget.reservedOutputTokens) - (options.safetyMarginTokens ?? defaultContextBudget.safetyMarginTokens));
		if (!Number.isSafeInteger(this.maxInputTokens) || this.maxInputTokens < 1) throw new AgentCoreError("budget_exceeded", "Invalid model input/output budget", false);
		this.summarizer = options.summarizer ?? new ModelContextSummarizer(options.provider, {
			...defaultSummaryBudget,
			maxInputTokens: Math.min(defaultSummaryBudget.maxInputTokens, this.maxInputTokens),
			maxOutputTokens: Math.min(defaultSummaryBudget.maxOutputTokens, options.reservedOutputTokens ?? defaultContextBudget.reservedOutputTokens),
		});
		this.compactTriggerTokens = options.compactTriggerTokens ?? Math.floor(this.maxInputTokens * 0.7);
		this.compactTargetTokens = options.compactTargetTokens ?? Math.floor(this.maxInputTokens * 0.45);
		this.now = options.now ?? (() => new Date().toISOString());
	}

	private modelRequest(messages: readonly AgentMessage[], tools: readonly AgentTool[], input: AgentRunInput) {
		return {
			messages,
			tools,
			outputSchema: input.outputSchema,
			fallbackOutput: input.fallbackOutput,
			maxOutputTokens: this.options.reservedOutputTokens ?? defaultContextBudget.reservedOutputTokens,
		};
	}

	private async countTokens(messages: readonly AgentMessage[], tools: readonly AgentTool[], input: AgentRunInput, signal?: AbortSignal) {
		const request = this.modelRequest(messages, tools, input);
		if (!this.options.provider.countTokens) return estimateRequestTokens(request);
		try {
			const counted = await this.options.provider.countTokens(request, signal);
			if (!Number.isSafeInteger(counted) || counted < 0) throw new Error("invalid_token_count");
			return counted;
		} catch (error) {
			throw new AgentCoreError("model_failure", "Model token count failed", true, { cause: error });
		}
	}

	async run(input: AgentRunInput, signal: AbortSignal = new AbortController().signal): Promise<AgentRunResult> {
		const allowedTools = input.allowedTools.map((name) => {
			const tool = this.tools.get(name);
			if (!tool) throw new AgentCoreError("permission_denied", `Unknown allowed tool: ${name}`, false);
			return tool;
		});
		let messages = this.context.compile(input);
		const boundReceipts = () => {
			if (!this.options.executions?.list) return;
			const completed = messages.filter((message) => message.receiptStatus === "succeeded");
			if (completed.length <= 4) return;
			const omitted = new Set(completed.slice(0, -4));
			messages = messages.filter((message) => !omitted.has(message) && message.receiptStatus !== "index");
			messages.push({ role: "user", kind: "receipt", receiptStatus: "index", durable: true, pinned: true,
				content: "Earlier completed operations remain in the execution ledger. Use execution_ledger_read to inspect this task's records before repeating work. Unknown operations require reconciliation. Receipt eviction does not release idempotency keys." });
		};
		const turnMessageId = (await digest(input.idempotencyKey)).slice(7);
		if (!input.resume && (input.input || input.attachments?.length) && messages.at(-1)?.role === "user") messages[messages.length - 1].messageId = `input-${turnMessageId}`;
		boundReceipts();
		let removedMessages = 0;
		const usage = emptyUsage();
		let compactSummaries = 0;
		let compactions = 0;
		const toolExecutions: AgentToolExecution[] = [];
		const compact = async (maxChars?: number): Promise<{ estimatedTokens: number; removedMessages: number }> => {
			const beforeChars = this.context.size(messages);
			let coverage: Awaited<ReturnType<AgentContextSummarizer["summarize"]>>["coverage"];
			await this.hooks.emit({ name: "compact.before", runId: input.runId, messageCount: messages.length });
			messages = this.context.pruneToolBodies(messages);
			const compacted = this.context.compact(messages, maxChars);
			let summary = "";
			if (compacted.removedMessages > 0 && compacted.summaryIndex !== undefined) {
				try {
					const sourceRef = `compact-${input.executionId}-${++compactions}`;
					await this.hooks.emit({ name: "compact.source", runId: input.runId, sourceRef, messages: compacted.removed });
					const result = await this.summarizer.summarize(compacted.removed, signal, sourceRef);
					summary = result.text;
					coverage = result.coverage;
					addUsage(usage, result.usage);
					compacted.messages[compacted.summaryIndex] = {
						role: "user",
						kind: "summary",
						readDependencies: [sourceRef],
						content: `${compactSummaryPrefix}\n${summary}`,
					};
					compactSummaries += 1;
				} catch (error) {
					throw new AgentCoreError("context_failure", "Context summarization failed", true, { cause: error });
				}
			}
			messages = compacted.messages;
			removedMessages += compacted.removedMessages;
			const estimatedTokens = await this.countTokens(messages, allowedTools, input, signal);
			await this.hooks.emit({
				name: "compact.after",
				runId: input.runId,
				removedMessages: compacted.removedMessages,
				beforeChars, afterChars: this.context.size(messages), coverage,
				summary,
				estimatedTokens,
			});
			return { estimatedTokens, removedMessages: compacted.removedMessages };
		};
		try {
			await this.hooks.emit({ name: "loop.started", runId: input.runId });
			for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
				if (signal?.aborted) throw signal.reason;
				let estimatedTokens = await this.countTokens(messages, allowedTools, input, signal);
				const estimatedByChars = !this.options.provider.countTokens && this.context.needsCompact(messages);
				if (estimatedTokens > this.maxInputTokens && await this.countTokens(this.context.requiredMessages(messages), allowedTools, input, signal) > this.maxInputTokens) throw new AgentCoreError("budget_exceeded", "Required policy/task/tool protocol content exceeds input budget", false);
				if (estimatedByChars || estimatedTokens >= this.compactTriggerTokens) {
					const targetChars = estimatedByChars
						? undefined
						: Math.floor(this.context.size(messages) * this.compactTargetTokens / Math.max(estimatedTokens, 1));
					estimatedTokens = (await compact(targetChars)).estimatedTokens;
				}
				if (estimatedTokens > this.maxInputTokens) {
					throw new AgentCoreError("budget_exceeded", "Context exceeds the model input token budget", false);
				}

				let response;
				for (let attempt = 1; attempt <= 2; attempt += 1) {
					await this.hooks.emit({
						name: "model.before",
						runId: input.runId,
						iteration,
						attempt,
						messages: messages.map((message) => ({ ...message })),
						estimatedTokens,
					});
					try {
						response = await this.options.provider.generate({ ...this.modelRequest(messages, allowedTools, input), onText: async (text) => {
							signal?.throwIfAborted();
							await this.hooks.emit({ name: "model.delta", runId: input.runId, iteration, text });
						} }, signal);
						break;
					} catch (error) {
						if (attempt === 1 && nestedCode(error) === "context_window_exceeded") {
							const targetChars = Math.min(
								Math.floor(this.context.size(messages) * this.compactTargetTokens / Math.max(estimatedTokens, 1)),
								Math.floor(this.context.size(messages) * 0.5),
							);
							const compacted = await compact(targetChars);
							if (compacted.removedMessages > 0) {
								estimatedTokens = compacted.estimatedTokens;
								if (estimatedTokens > this.maxInputTokens) throw new AgentCoreError("budget_exceeded", "Compacted context exceeds input budget", false);
								continue;
							}
						}
						throw new AgentCoreError("model_failure", "Model provider call failed", true, { cause: error });
					}
				}
				if (!response) throw new AgentCoreError("model_failure", "Model provider call failed", true);
				addUsage(usage, response.usage);
				await this.hooks.emit({
					name: "model.after",
					runId: input.runId,
					iteration,
					response: {
						text: response.text,
						toolCalls: response.toolCalls.map((call) => ({ ...call })),
						usage: { ...response.usage },
					},
				});
				messages.push({
					role: "assistant",
					...(response.toolCalls.length ? {} : { kind: "dialogue" as const }),
					messageId: response.toolCalls.length ? `step-${input.executionId}-${iteration}` : `reply-${turnMessageId}`,
					inReplyTo: input.idempotencyKey,
					content: response.text,
					createdAt: this.now(),
					toolCalls: response.toolCalls,
					...(response.providerState === undefined ? {} : { providerState: response.providerState }),
				});

				if (response.toolCalls.length === 0) {
					if (!response.text.trim()) throw new Error("Model completed without a final response");
					await this.hooks.emit({ name: "loop.completed", runId: input.runId, iterations: iteration });
					return {
						stopReason: "completed",
						finalText: response.text,
						messages,
						usage,
						iterations: iteration,
						removedMessages,
						compactSummaries,
						toolExecutions,
					};
				}
				if (toolExecutions.length + response.toolCalls.length > this.maxToolExecutions) {
					throw new AgentCoreError("budget_exceeded", `Agent loop exceeded ${this.maxToolExecutions} Tool executions`, false);
				}

				const receiptRecords: AgentToolExecutionRecord[] = [];
				for (const call of response.toolCalls) {
					await this.hooks.emit({ name: "tool.before", runId: input.runId, iteration, call: { ...call } });
					const tool = this.tools.get(call.name);
					const startedAt = Date.now();
					let idempotencyKey = `${input.idempotencyKey}:${call.id}`;
					let status: AgentToolExecution["status"] = "failed";
					let failureCode: AgentToolFailureCode | undefined;
					let approvalId: string | undefined;
					let output = toolFailure("tool_execution_failed", "Tool execution did not produce a result");
					let resultTruncated = false;
					let archivedContent: string | undefined;
					let replayed = false;
					if (!tool || !allowedTools.includes(tool)) {
						failureCode = "tool_not_allowed";
						status = "denied";
						output = toolFailure(failureCode, `Tool is not allowed: ${call.name}`);
					} else if (!validToolInput(tool, call.input)) {
						failureCode = "tool_input_invalid";
						output = toolFailure(failureCode, `Tool input validation failed: ${call.name}`);
					} else {
						if (tool.risk !== "read") {
							if (tool.idempotent && tool.createIdempotencyKey) {
								try {
									idempotencyKey = tool.createIdempotencyKey(call.input, input.idempotencyKey, { tenantId: input.tenantId, workspaceId: input.workspaceId, runId: input.runId });
								} catch (error) {
									throw new AgentCoreError("infrastructure_failure", "Tool idempotency key generation failed", false, { cause: error });
								}
							}
							if (!tool.idempotent || !tool.createIdempotencyKey || !idempotencyKey.trim() || idempotencyKey.length > 256) {
								failureCode = "tool_not_idempotent";
							} else if (!this.options.executions) {
								failureCode = "tool_execution_store_required";
							} else if (
								input.policy.sandboxMode !== "workspace-write" ||
								input.policy.approvalPolicy !== "required" ||
								!this.options.approval ||
								!this.options.audit
							) {
								failureCode = "tool_approval_required";
							} else {
								let decision;
								try {
									decision = await abortable(this.options.approval.authorize({
										tenantId: input.tenantId,
										workspaceId: input.workspaceId,
										runId: input.runId,
										stageId: input.stageId,
										actorId: input.actorId,
										executionId: input.executionId,
										tool: tool.name,
										toolCallId: call.id,
										risk: tool.risk,
										input: call.input,
										idempotencyKey,
									}, signal), signal);
								} catch (error) {
									signal.throwIfAborted();
									throw new AgentCoreError("infrastructure_failure", "Tool approval lookup failed", true, { cause: error });
								}
								if (
									!decision.approved ||
									!decision.approvalId?.trim() ||
									decision.approvalId.length > 128
								) failureCode = "tool_approval_denied";
								else approvalId = decision.approvalId;
							}
							if (failureCode) {
								status = "denied";
								output = toolFailure(failureCode, `Tool side effect denied: ${tool.name}`);
							}
						}
					}
					if (tool && !failureCode) {
						signal.throwIfAborted();
						let ledgerRecord: AgentToolExecutionRecord | undefined;
						if (tool.risk !== "read") {
							try {
								await this.options.audit?.append({
									type: "tool.execution.started",
									tenantId: input.tenantId,
									workspaceId: input.workspaceId,
									runId: input.runId,
									stageId: input.stageId,
									actorId: input.actorId,
									executionId: input.executionId,
									tool: tool.name,
									toolCallId: call.id,
									risk: tool.risk,
									idempotencyKey,
									approvalId,
									occurredAt: this.now(),
								});
								const inputDigest = await digest(JSON.stringify(call.input) ?? "undefined");
								const claimed = await this.options.executions!.claim({
									schemaVersion: "tool-execution.v1",
									tenantId: input.tenantId,
									workspaceId: input.workspaceId,
									runId: input.runId,
									stageId: input.stageId,
									actorId: input.actorId,
									executionId: input.executionId,
									tool: tool.name,
									toolCallId: call.id,
									risk: tool.risk,
									idempotencyKey,
									approvalId: approvalId!,
									inputDigest,
									status: "started",
									startedAt: this.now(),
								});
								ledgerRecord = claimed.record;
								if (claimed.duplicate) {
									replayed = true;
									if (ledgerRecord.inputDigest !== inputDigest) {
										status = "denied";
										failureCode = "tool_idempotency_conflict";
										output = toolFailure(failureCode, "Idempotency key was already used with different Tool input");
									} else if (ledgerRecord.status === "succeeded" && ledgerRecord.result !== undefined) {
										output = ledgerRecord.result;
										status = "succeeded";
									} else {
										status = "unknown";
										failureCode = "tool_execution_unknown";
										output = toolFailure(failureCode, "Earlier Tool execution has an uncertain side effect and requires reconciliation");
									}
								}
							} catch (error) {
								if (error instanceof AgentCoreError) throw error;
								throw new AgentCoreError("infrastructure_failure", "Tool execution ledger write failed", true, { cause: error });
							}
						}
						const timeout = new AbortController();
						let timer: ReturnType<typeof setTimeout> | undefined;
						try {
							if (!replayed) {
								timer = setTimeout(() => timeout.abort(new Error("tool_timeout")), tool.timeoutMs);
								const toolSignal = signal
									? AbortSignal.any([signal, timeout.signal])
									: timeout.signal;
								const executionContext: AgentToolExecutionContext = {
									tenantId: input.tenantId,
									workspaceId: input.workspaceId,
									runId: input.runId,
									stageId: input.stageId,
									actorId: input.actorId,
									executionId: input.executionId,
									toolCallId: call.id,
									idempotencyKey,
									approvalId,
									signal: toolSignal,
								};
								if (tool.execution === "host") {
									const result = await toolOutput(
										await abortable(tool.execute(call.input, executionContext), toolSignal),
										tool.maxResultChars, this.options.externalizeToolResult ? (content) => this.options.externalizeToolResult!(content, tool.validateContextResult ? { name: call.name, input: call.input } : undefined) : undefined,
									);
									output = result.text;
									resultTruncated = result.truncated;
									archivedContent = result.archivedContent;
									status = "succeeded";
								} else if (!this.options.sandboxedToolExecutor) {
									failureCode = "tool_sandbox_unavailable";
									status = "failed";
									output = toolFailure(failureCode, "Native Tool Sandbox is unavailable");
								} else {
									const sandboxContext = {
										...executionContext,
										sandboxAttemptId: crypto.randomUUID(),
									};
									const invocation = tool.createInvocation(call.input, sandboxContext);
									const persistentWriteDenied = invocation.paths.writable.length > 0 &&
										(tool.risk === "read" || input.policy.sandboxMode !== "workspace-write");
									if (persistentWriteDenied) {
										failureCode = "tool_sandbox_policy_denied";
										status = "denied";
										output = toolFailure(failureCode, "Sandboxed Tool requested persistent writes outside its Host policy");
									} else {
										const manifest = compileToolExecutionManifest({
											attemptId: sandboxContext.sandboxAttemptId,
											tenantId: sandboxContext.tenantId,
											workspaceId: sandboxContext.workspaceId,
											runId: sandboxContext.runId,
											stageId: sandboxContext.stageId,
											executionId: sandboxContext.executionId,
											toolCallId: sandboxContext.toolCallId,
											tool: { name: tool.name, version: tool.version },
											command: {
												executable: tool.executable,
												argv: invocation.argv,
												workingDirectory: invocation.workingDirectory,
											},
											paths: invocation.paths,
											environment: tool.sandbox.environment,
											network: tool.sandbox.network,
											limits: { timeoutMs: tool.timeoutMs, ...tool.sandbox.limits },
											idempotencyKey: sandboxContext.idempotencyKey,
											approvalId: sandboxContext.approvalId,
										});
										if (!validToolExecutionManifest(manifest)) {
											failureCode = "tool_sandbox_policy_denied";
											status = "denied";
											output = toolFailure(failureCode, "Sandboxed Tool manifest failed Host validation");
										} else {
											const sandboxResult = await abortable(
												this.options.sandboxedToolExecutor.execute(manifest, toolSignal),
												toolSignal,
											);
											if (!validToolExecutionResult(sandboxResult, manifest)) {
												failureCode = "tool_execution_failed";
												status = tool.risk === "read" ? "failed" : "unknown";
												output = toolFailure(failureCode, "Sandboxed Tool result failed Host validation");
											} else if (sandboxResult.status === "succeeded") {
												const result = await toolOutput(sandboxResult, tool.maxResultChars, this.options.externalizeToolResult ? (content) => this.options.externalizeToolResult!(content, tool.validateContextResult ? { name: call.name, input: call.input } : undefined) : undefined);
												output = result.text;
												resultTruncated = result.truncated;
									archivedContent = result.archivedContent;
												status = "succeeded";
											} else {
												const failure = sandboxFailure(sandboxResult.status);
												failureCode = failure.code;
												status = sandboxResult.status === "policy_denied"
													? "denied"
													: sandboxResult.status === "sandbox_unavailable" || tool.risk === "read"
														? "failed"
														: "unknown";
												output = toolFailure(failure.code, failure.message);
											}
										}
									}
								}
							}
						} catch (error) {
							if (signal?.aborted) throw signal.reason;
							if (error instanceof AgentCoreError) throw error;
							failureCode = timeout.signal.aborted
								? "tool_timeout"
								: tool.execution === "sandboxed"
									? "tool_sandbox_unavailable"
									: "tool_execution_failed";
							status = tool.risk === "read" ? "failed" : "unknown";
							output = toolFailure(
								failureCode,
								failureCode === "tool_timeout"
									? "Tool execution timed out"
									: failureCode === "tool_sandbox_unavailable"
										? "Native Tool Sandbox failed"
										: "Tool execution failed",
							);
						} finally {
							if (timer) clearTimeout(timer);
						}
						if (tool.risk !== "read" && ledgerRecord && !replayed) {
							try {
								ledgerRecord = await this.options.executions!.complete(ledgerRecord, {
									status: status === "succeeded" ? "succeeded" : "unknown",
									result: output,
									resultDigest: await digest(output),
									...(failureCode ? { failureCode } : {}),
									completedAt: this.now(),
								});
							} catch (error) {
								throw new AgentCoreError("infrastructure_failure", "Tool execution ledger completion failed", true, { cause: error });
							}
						}
						if (ledgerRecord) receiptRecords.push(ledgerRecord);
					}
					messages.push({ role: "tool", content: output, toolCallId: call.id, ...(tool?.validateContextResult && status === "succeeded" ? { sourceTool: { name: call.name, input: call.input } } : {}), ...(archivedContent ? { archivedContent } : {}) });
					const execution: AgentToolExecution = {
						toolCallId: call.id,
						tool: call.name,
						risk: tool?.risk ?? "read",
						status,
						idempotencyKey,
						approvalId,
						failureCode,
						durationMs: Math.max(0, Date.now() - startedAt),
						resultTruncated,
						replayed,
					};
					toolExecutions.push(execution);
					if (tool && tool.risk !== "read" && this.options.audit) {
						try {
							await this.options.audit.append({
								type: "tool.execution.completed",
								tenantId: input.tenantId,
								workspaceId: input.workspaceId,
								runId: input.runId,
								stageId: input.stageId,
								actorId: input.actorId,
								executionId: input.executionId,
								tool: call.name,
								toolCallId: call.id,
								risk: tool.risk,
								idempotencyKey,
								approvalId,
								status,
								failureCode,
								replayed,
								occurredAt: this.now(),
							});
						} catch (error) {
							throw new AgentCoreError("infrastructure_failure", "Tool audit write failed", true, { cause: error });
						}
					}
					await this.hooks.emit({ name: "tool.after", runId: input.runId, iteration, call: { ...call }, failed: status !== "succeeded" });
				}
				if (receiptRecords.length > 0) messages.push(executionReceipt(receiptRecords));
				boundReceipts();
				await this.hooks.emit({ name: "loop.checkpoint", runId: input.runId, messages });
			}
			return {
				stopReason: "slice_limit",
				finalText: "",
				messages,
				usage,
				iterations: this.maxIterations,
				removedMessages,
				compactSummaries,
				toolExecutions,
			};
		} catch (error) {
			await this.hooks.emit({ name: "loop.failed", runId: input.runId, error });
			throw error;
		}
	}
}
