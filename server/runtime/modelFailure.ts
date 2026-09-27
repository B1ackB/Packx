/** Fixed categories only: upstream messages, URLs and arbitrary error types are not log data. */
export function modelFailureCode(error: unknown): string {
	let current = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++, current = current.cause) {
		const status = (current as { providerStatus?: unknown }).providerStatus;
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
