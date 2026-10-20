import type { AgentMessage, AgentTool, AgentToolExecutionContext } from "../../src/agent/contracts";
import { AgentStateStoreError, type AgentSessionStore, type ContextSnapshotStore } from "../../src/agent/state";
import { abortable } from "../../src/agent/loop";
import { RuntimeFailure } from "../../src/runtime/contracts";
import { readContextSource } from "./contextRead";

interface SourceValidationOptions {
	sessions: AgentSessionStore;
	snapshots: ContextSnapshotStore;
	tools?: readonly AgentTool[];
	context: AgentToolExecutionContext & { sessionId: string };
	binding?: string;
	historyBinding?: string;
	/** Completed worker sessions have never been permitted to write. */
	readOnly?: true;
	budget?: { remainingSources: number; remainingMessages: number; remainingChars: number };
}

/** Shared restore/completion check. Calls validators only, never tools or models. */
export async function validateContextSources(options: SourceValidationOptions, messages: readonly AgentMessage[], visited = new Set<string>()): Promise<void> {
	const { sessions, snapshots, tools, context, binding, historyBinding } = options;
	const scope = context, combinedSignal = context.signal;
	const validateSources = (messages: readonly AgentMessage[], visited?: Set<string>) => validateContextSources(options, messages, visited);
	// Older v2 records may predate an adapter's source validator. Complete
	// protocol groups retain the trusted tool name and original input.
	const charge = (message: AgentMessage) => {
		if (options.budget && (--options.budget.remainingMessages < 0 || (options.budget.remainingChars -= JSON.stringify(message).length) < 0)) throw new RuntimeFailure("budget_exceeded", "Source review exceeds its bounded read budget", false);
	};
	const legacyReads = new Map<string, { name: string; input: unknown }>();
	for (const message of messages) {
		charge(message);
		if (message.role !== "tool") {
			legacyReads.clear();
			if (message.role === "assistant") for (const call of message.toolCalls ?? []) {
				if (options.readOnly || call.name === "context_read" || tools?.some((tool) => tool.name === call.name && tool.validateContextResult)) legacyReads.set(call.id, { name: call.name, input: call.input });
			}
		}
		combinedSignal.throwIfAborted();
		for (const ref of message.readDependencies ?? []) {
			if (visited.has(ref)) continue;
			if (visited.size >= 128) throw new RuntimeFailure("context_failure", "Context source dependency limit exceeded; rebuild task", false);
			visited.add(ref);
			if (options.budget && --options.budget.remainingSources < 0) throw new RuntimeFailure("budget_exceeded", "Source review exceeds its bounded reference budget", false);
			const dependency = snapshots.read(scope, ref);
			if (historyBinding !== undefined && dependency.historyBinding !== historyBinding) throw new RuntimeFailure("context_failure", "Archived context dependency changed; rebuild task", false);
			await validateSources(dependency.messages, visited);
		}
		let legacyRead: { name: string; input: unknown } | undefined;
		if (!message.sourceTool && message.role === "tool" && message.toolCallId && legacyReads.has(message.toolCallId)) {
			const call = legacyReads.get(message.toolCallId)!;
			if (call.name !== "context_read" && call.name !== "execution_ledger_read") legacyRead = call;
			try {
				const output = JSON.parse(message.content) as { status?: string; ok?: boolean; error?: { code?: string; message?: string } };
				// Exact Host failure envelopes contain no source bytes. Do not turn
				// a prior failed read into an assertion of successful source access.
				if (output.ok === false && Object.keys(output).sort().join() === "error,ok" && output.error?.code === "tool_execution_failed" && Object.keys(output.error).sort().join() === "code,message" && output.error.message === "Tool execution failed") legacyRead = undefined;
				if (call.name === "context_read" && ["historical_unverified", "body_externalized"].includes(output.status ?? "")) legacyRead = call;
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
		if (!sourceTool && message.role === "tool" && (messages.length === 1 || options.readOnly && !legacyReads.has(message.toolCallId ?? ""))) {
			throw new RuntimeFailure("context_failure", "Legacy tool archive has no source provenance; rebuild task context", false);
		}
		if (!sourceTool) continue;
		if (sourceTool.name === "context_read") {
			const ref = (sourceTool.input as { sourceRef?: unknown })?.sourceRef;
			if (typeof ref !== "string") throw new RuntimeFailure("context_failure", "Archived context read has no source", false);
			if (visited.has(ref)) continue;
			if (visited.size >= 128) throw new RuntimeFailure("context_failure", "Context source dependency limit exceeded; rebuild task", false);
			visited.add(ref);
			if (options.budget && --options.budget.remainingSources < 0) throw new RuntimeFailure("budget_exceeded", "Source review exceeds its bounded reference budget", false);
			try {
				const source = readContextSource(scope, sessions, snapshots, ref, binding, historyBinding);
				await validateSources(source.messages, visited);
			} catch (error) { throw new RuntimeFailure("context_failure", "Read-back source is unavailable, changed or no longer permitted", false, { cause: error }); }
			continue;
		}
		const tool = tools?.find((item) => item.name === sourceTool.name);
		if (!tool?.validateContextResult) throw new RuntimeFailure("context_failure", "Source validation tool unavailable", false);
		let output = message.content;
		let envelope: { status?: string; sourceRef?: string } | undefined;
		try { envelope = JSON.parse(output); } catch { /* Plain-text bodies are validated by their source adapter. */ }
		if (envelope?.status === "body_externalized" && typeof envelope.sourceRef === "string") {
			if (options.budget && --options.budget.remainingSources < 0) throw new RuntimeFailure("budget_exceeded", "Source review exceeds its bounded reference budget", false);
			const body = snapshots.read(scope, envelope.sourceRef).messages;
			if (body.length !== 1 || body[0].role !== "tool") throw new AgentStateStoreError("not_found", "Externalized tool result body is missing or invalid");
			const archived = body[0];
			charge(archived); output = archived.content;
		}
		try { await abortable(Promise.resolve(tool.validateContextResult(sourceTool.input, output, { ...context, toolCallId: message.toolCallId ?? "restore" })), combinedSignal); }
		catch (error) { combinedSignal.throwIfAborted(); throw new RuntimeFailure("context_failure", "Context source is unavailable, changed or no longer permitted", false, { cause: error }); }
	}
}
