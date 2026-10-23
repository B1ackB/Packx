import { expect, it } from "vitest";
import { ModelProviderError, modelFailureCode } from "./modelFailure";

it.each([
	["UND_ERR_SOCKET", "transport_failure"], ["ECONNRESET", "transport_failure"],
	["UND_ERR_BODY_TIMEOUT", "provider_timeout"], ["ETIMEDOUT", "provider_timeout"],
])("classifies nested %s without emitting customer text or addresses", (code, category) => {
	const cause = Object.assign(new Error("secret-key at https://private.example/customer"), { code });
	expect(modelFailureCode(new TypeError("private request failed", { cause }))).toBe(category);
});

it("keeps HTTP failures distinct from malformed output and never emits arbitrary codes", () => {
	expect(modelFailureCode(new ModelProviderError("authentication", "safe message", false, { httpStatus: 401 }))).toBe("provider_auth");
	expect(modelFailureCode(new ModelProviderError("rate_limit", "safe message", true, { httpStatus: 429 }))).toBe("rate_limited");
	expect(modelFailureCode(new ModelProviderError("model_failure", "safe message", true, { httpStatus: 503 }))).toBe("provider_http_error");
	expect(modelFailureCode(new ModelProviderError("output_limit", "safe message", false))).toBe("output_limit");
	const unknown = Object.assign(new Error("private_customer_text"), { code: "private_customer_code" });
	unknown.cause = unknown;
	expect(modelFailureCode(unknown)).toBe("unclassified_model_failure");
	expect(modelFailureCode(new DOMException("private signal", "TimeoutError"))).toBe("provider_timeout");
	expect(modelFailureCode(new DOMException("private signal", "AbortError"))).toBe("request_cancelled");
});
