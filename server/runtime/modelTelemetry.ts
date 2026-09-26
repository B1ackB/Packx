import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentModelProvider, AgentModelResponse, AgentModelRequest } from "../../src/agent/contracts";
import { abortable } from "../../src/agent/loop";
import type { ModelCallRecord, ModelTelemetryView } from "../../src/runtime/modelTelemetry";

import { AnthropicGenerationError } from "./anthropicModelProvider";
import { modelFailureCode } from "./modelFailure";

type Scope = { tenantId: string; workspaceId: string; runId: string };
type Index = { schemaVersion: "model-calls.v1"; scope: Scope; calls: ModelCallRecord[]; truncated: boolean };
export type ObservedModelResponse = AgentModelResponse & { telemetry?: ModelCallRecord["response"] };

/** Bounded local Host projection. Persists numeric metadata only, never prompts, responses or errors. */
export class ModelTelemetryStore {
	private readonly active = new Set<string>();
	private readonly root: string;
	readonly retentionLimit = 200;
	constructor(root: string, readonly configuredModel: string, private readonly now = Date.now) {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		if (lstatSync(root).isSymbolicLink()) throw new Error("Unsafe telemetry directory");
		this.root = realpathSync(root);
	}
	private path(scope: Scope) {
		if (![scope.tenantId, scope.workspaceId, scope.runId].every((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) throw new Error("Invalid telemetry scope");
		return join(this.root, `${createHash("sha256").update(JSON.stringify([scope.tenantId, scope.workspaceId, scope.runId])).digest("hex")}.json`);
	}
	private load(scope: Scope): Index {
		const path = this.path(scope);
		if (!existsSync(path)) return { schemaVersion: "model-calls.v1", scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, runId: scope.runId }, calls: [], truncated: false };
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new Error("Invalid telemetry index");
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		let index: Index;
		try { index = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
		if (index.schemaVersion !== "model-calls.v1" || !index.scope || index.scope.tenantId !== scope.tenantId || index.scope.workspaceId !== scope.workspaceId || index.scope.runId !== scope.runId || !Array.isArray(index.calls)) throw new Error("Telemetry scope mismatch");
		return index;
	}
	private save(scope: Scope, index: Index) {
		const path = this.path(scope), temporary = `${path}.${randomUUID()}.tmp`;
		try {
			const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try { writeFileSync(fd, JSON.stringify(index)); fsyncSync(fd); } finally { closeSync(fd); }
			renameSync(temporary, path);
			const directory = openSync(this.root, constants.O_RDONLY);
			try { fsyncSync(directory); } finally { closeSync(directory); }
		} finally { if (existsSync(temporary)) unlinkSync(temporary); }
	}
	view(scope: Scope): ModelTelemetryView {
		const index = this.load(scope);
		return { configuredModel: this.configuredModel, retentionLimit: this.retentionLimit, truncated: index.truncated,
			calls: index.calls.map((call) => call.status === "running" && !this.active.has(call.id) ? { ...call, status: "interrupted" } : call) };
	}
	wrap(provider: AgentModelProvider, scope: Scope, executionId: string): AgentModelProvider {
		const track = async <T>(kind: ModelCallRecord["kind"], action: () => Promise<T>, signal?: AbortSignal, context?: AgentModelRequest["callContext"]): Promise<T> => {
			signal?.throwIfAborted();
			const start = this.now();
			const call: ModelCallRecord = { ...(context ? { purpose: context.purpose, sourceRef: context.sourceRef, sourceRange: context.sourceRange, contextSnapshotId: context.callId } : { purpose: "turn" as const }), id: randomUUID(), executionId, kind, model: this.configuredModel, status: "running", startedAt: new Date(start).toISOString() };
			const index = this.load(scope);
			index.calls.push(call);
			if (index.calls.length > this.retentionLimit) { index.calls = index.calls.slice(-this.retentionLimit); index.truncated = true; }
			this.save(scope, index); this.active.add(call.id);
			let failure: { error: unknown } | undefined;
			try {
				const result = await (signal ? abortable(action(), signal) : action());
				call.status = "succeeded";
				if (kind === "generate") {
					call.response = (result as ObservedModelResponse).telemetry;
					call.usage = { ...(result as ObservedModelResponse).usage };
				} else if (typeof result === "number" && Number.isSafeInteger(result) && result >= 0) call.countedInputTokens = result;
				return result;
			} catch (error) {
				failure = { error };
				if (kind === "generate" && error instanceof AnthropicGenerationError) {
					call.usage = { ...error.usage };
					call.response = { ...error.telemetry };
				}
				call.status = signal?.aborted ? "cancelled" : "failed";
				// Upstream messages/types may contain secrets or customer text; expose a fixed category only.
				const status = (error as { providerStatus?: number })?.providerStatus;
				if (Number.isInteger(status) && status! >= 400 && status! <= 599) call.httpStatus = status;
				call.failure = signal?.aborted ? "request_cancelled" : modelFailureCode(error);
				throw error;
			} finally {
				call.latencyMs = Math.max(0, this.now() - start); this.active.delete(call.id);
				try {
					const latest = this.load(scope), position = latest.calls.findIndex((item) => item.id === call.id);
					if (position >= 0) { latest.calls[position] = call; this.save(scope, latest); }
				} catch (storageError) {
					if (!failure) throw storageError;
					throw new AggregateError([failure.error, storageError], "Model call and telemetry persistence failed", { cause: failure.error });
				}
			}
		};
		return { generate: (request, signal) => track("generate", () => provider.generate(request, signal), signal, request.callContext),
			...(provider.countTokens ? { countTokens: (request: Parameters<AgentModelProvider["generate"]>[0], signal?: AbortSignal) => track("count_tokens", () => provider.countTokens!(request, signal), signal, request.callContext) } : {}) };
	}
}
