export interface ModelCallRecord {
	id: string;
	purpose?: "summary" | "turn";
	sourceRef?: string;
	sourceRange?: [number, number];
	contextSnapshotId?: string;
	countedInputTokens?: number;
	usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
	executionId: string;
	kind: "generate" | "count_tokens";
	model: string;
	status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
	startedAt: string;
	latencyMs?: number;
	httpStatus?: number;
	failure?: string;
	response?: { model: string; stopReason: string; inputTokens: number; outputTokens: number; cacheReadTokens: number | null; cacheWriteTokens: number | null };
}
export interface ModelTelemetryView {
	configuredModel: string;
	calls: ModelCallRecord[];
	retentionLimit: number;
	truncated: boolean;
}
export function summarizeModelCalls(calls: ModelCallRecord[]) {
	const generated = calls.filter((call) => call.kind === "generate");
	const responses = generated.flatMap((call) => call.response ? [call.response] : []);
	const cacheKnown = responses.filter((item) => item.cacheReadTokens !== null && item.cacheWriteTokens !== null);
	const cached = cacheKnown.reduce((sum, item) => sum + item.cacheReadTokens!, 0);
	const total = cacheKnown.reduce((sum, item) => sum + item.inputTokens + item.cacheReadTokens! + item.cacheWriteTokens!, 0);
	const ended = generated.filter((call) => call.latencyMs !== undefined);
	return { generated: generated.length, counted: calls.length - generated.length,
		succeeded: generated.filter((call) => call.status === "succeeded").length,
		failed: generated.filter((call) => call.status === "failed").length,
		running: generated.filter((call) => call.status === "running").length,
		cancelled: generated.filter((call) => ["cancelled", "interrupted"].includes(call.status)).length,
		averageLatencyMs: ended.length ? ended.reduce((sum, call) => sum + call.latencyMs!, 0) / ended.length : null,
		inputTokens: responses.reduce((sum, item) => sum + item.inputTokens, 0), outputTokens: responses.reduce((sum, item) => sum + item.outputTokens, 0),
		cacheReadTokens: cached, cacheWriteTokens: cacheKnown.reduce((sum, item) => sum + item.cacheWriteTokens!, 0),
		cacheCoverage: cacheKnown.length, responses: responses.length, cacheHitRate: total ? cached / total : null };
}
