import type { AgentUsage } from "../../src/agent/contracts";
import type { ModelCallRecord } from "../../src/runtime/modelTelemetry";

export type ModelProviderFailureCode = "authentication" | "rate_limit" | "context_window_exceeded" | "output_limit" | "refusal" | "pause_turn" | "invalid_response" | "model_failure";

/** Adapters supply safe messages and validated numeric accounting, never partial model output. */
export class ModelProviderError extends Error {
	readonly httpStatus?: number;
	readonly usage?: AgentUsage;
	readonly telemetry?: ModelCallRecord["response"];
	constructor(readonly code: ModelProviderFailureCode, message: string, readonly retryable: boolean,
		options: ErrorOptions & { httpStatus?: number; usage?: AgentUsage; telemetry?: ModelCallRecord["response"] } = {}) {
		super(message, options);
		this.name = "ModelProviderError";
		this.httpStatus = options.httpStatus;
		this.usage = options.usage;
		this.telemetry = options.telemetry;
	}
}

/** Fixed categories only: upstream messages, URLs and arbitrary error types are not log data. */
export function modelFailureCode(error: unknown): string {
	let current = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++, current = current.cause) {
		const status = current instanceof ModelProviderError ? current.httpStatus : (current as { providerStatus?: unknown }).providerStatus;
		if (current instanceof ModelProviderError && current.code === "authentication") return "provider_auth";
		if (current instanceof ModelProviderError && current.code === "rate_limit") return "rate_limited";
		if (status === 401 || status === 403) return "provider_auth";
		if (status === 429) return "rate_limited";
		if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return "provider_http_error";
		const value = (current as { code?: unknown }).code;
		const code = typeof value === "string" ? value : "";
		if (["output_limit", "refusal", "pause_turn", "context_window_exceeded", "invalid_response"].includes(code)) return code;
		if (["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"].includes(code) || current.name === "TimeoutError") return "provider_timeout";
		if (["UND_ERR_SOCKET", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ENETUNREACH"].includes(code)) return "transport_failure";
		if (current.name === "AbortError" || code === "ABORT_ERR") return "request_cancelled";
		if (current.message === "invalid_or_incomplete_model_stream") return "incomplete_response";
		if (["invalid_usage", "invalid_token_count", "usage_exceeds_reservation"].includes(current.message)) return current.message;
	}
	return "unclassified_model_failure";
}
