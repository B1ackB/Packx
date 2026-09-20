import type { AgentModelRequest } from "./contracts";

/** Application policy, not a claim about any provider/model's published capacity. */
export const defaultContextBudget = {
	contextWindowTokens: 131_072,
	reservedOutputTokens: 4_096,
	safetyMarginTokens: 8_192,
	applicationInputTokens: 100_000,
	source: "packx-application-policy.v1; operator must validate against configured model",
};

/** Conservative heuristic, not a tokenizer: UTF-8 bytes/3 + protocol and image allowances. */
export function estimateRequestTokens(request: AgentModelRequest): number {
	const messages = request.messages.map(({ attachments, ...message }) => ({
		...message, attachments: attachments?.map(({ data: _data, ...image }) => image),
	}));
	const bytes = new TextEncoder().encode(JSON.stringify({ messages, tools: request.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), outputSchema: request.outputSchema })).length;
	return Math.ceil(bytes / 3) + request.messages.length * 12 + request.messages.reduce((sum, message) => sum + (message.attachments?.filter((image) => image.data).length ?? 0) * 4096, 0);
}
