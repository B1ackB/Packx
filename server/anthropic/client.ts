import { readAnthropicStream } from "./stream";
import type {
	AnthropicMessageRequest,
	AnthropicMessageResponse,
	AnthropicTokenCountResponse,
} from "./types";

export class AnthropicCompatibilityError extends Error {
	readonly code: string;
	readonly providerStatus?: number;
	readonly adapterStatus?: number;

	constructor(
		code: string,
		message: string,
		status: { providerStatus?: number; adapterStatus?: number } = {},
	) {
		super(message);
		this.name = "AnthropicCompatibilityError";
		this.code = code;
		this.providerStatus = status.providerStatus;
		this.adapterStatus = status.adapterStatus;
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
	const body: unknown = await response.json().catch((error: unknown) => {
		// Do not disguise a broken success-response body as invalid JSON. Preserve known HTTP failures.
		if (response.ok && !(error instanceof SyntaxError)) throw error;
		return undefined;
	});
	if (!response.ok) {
		const error = record(body) && record(body.error) ? body.error : undefined;
		throw new AnthropicCompatibilityError(
			typeof error?.type === "string" ? error.type : "upstream_error",
			typeof error?.message === "string" ? error.message : `Anthropic-compatible endpoint returned HTTP ${response.status}`,
			{ providerStatus: response.status },
		);
	}
	if (!record(body)) {
		throw new AnthropicCompatibilityError("invalid_response", "Model response is invalid", { adapterStatus: 502 });
	}
	return body;
}

export interface AnthropicClientOptions {
  baseUrl: string;
  apiKey: string;
  anthropicVersion?: string;
  fetch?: typeof fetch;
}

export class AnthropicMessagesClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly anthropicVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.anthropicVersion = options.anthropicVersion ?? "2023-06-01";
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createMessage(
    request: AnthropicMessageRequest,
    signal?: AbortSignal,
	onText?: (text: string) => void | Promise<void>,
  ): Promise<AnthropicMessageResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.anthropicVersion,
      },
      body: JSON.stringify({ ...request, stream: Boolean(onText) }),
      signal,
    });

		if (response.ok && response.headers.get("content-type")?.includes("text/event-stream")) {
			if (!response.body) throw new AnthropicCompatibilityError("invalid_response", "Missing model stream");
			return readAnthropicStream(response.body, onText, signal);
		}
		const body = await readJsonResponse(response);
		if (!Array.isArray(body.content)) {
			throw new AnthropicCompatibilityError("invalid_response", "Model content is invalid", { adapterStatus: 502 });
		}
		// Some compatible endpoints return JSON even when streaming is requested.
		for (const block of body.content) {
			if (!record(block) || (block.type === "text" && typeof block.text !== "string")) {
				throw new AnthropicCompatibilityError("invalid_response", "Model content block is invalid", { adapterStatus: 502 });
			}
			if (block.type === "text") await onText?.(block.text as string);
		}
		return body as unknown as AnthropicMessageResponse;
  }

	async countMessageTokens(
		request: AnthropicMessageRequest,
		signal?: AbortSignal,
	): Promise<AnthropicTokenCountResponse> {
		const { max_tokens: _maxTokens, stream: _stream, ...body } = request;
		const response = await this.fetchImpl(`${this.baseUrl}/v1/messages/count_tokens`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": this.apiKey,
				"anthropic-version": this.anthropicVersion,
			},
			body: JSON.stringify(body),
			signal,
		});
		const result = await readJsonResponse(response);
		if (typeof result.input_tokens !== "number" || !Number.isSafeInteger(result.input_tokens) || result.input_tokens < 0) {
			throw new AnthropicCompatibilityError(
				"invalid_response",
				"Token Count response is invalid",
				{ adapterStatus: 502 },
			);
		}
		return { input_tokens: result.input_tokens };
	}
}
