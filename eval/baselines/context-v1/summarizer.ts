import type {
	AgentContextSummarizer,
	AgentMessage,
	AgentModelProvider,
} from "../../../src/agent/contracts";

function transcript(messages: readonly AgentMessage[]): string {
	const content = messages.map((message) => {
		const calls = message.toolCalls?.length
			? `\ntool_calls=${JSON.stringify(message.toolCalls)}`
			: "";
		const callId = message.toolCallId ? ` tool_call_id=${message.toolCallId}` : "";
		return `${message.role}${callId}: ${message.content}${calls}`;
	}).join("\n");
	return content.length <= 24_000
		? content
		: `[Earlier compact source truncated deterministically]\n${content.slice(-24_000)}`;
}

export class ModelContextSummarizer implements AgentContextSummarizer {
	constructor(private readonly provider: AgentModelProvider) {}

	async summarize(messages: readonly AgentMessage[], signal?: AbortSignal) {
		const fallbackOutput = `${messages.length} earlier messages were compacted without an authoritative summary.`;
		const response = await this.provider.generate({
			messages: [
				{
					role: "system",
					content: [
						"Summarize only the supplied transient conversation for future context.",
						"Preserve uncertainty, tool failures, pending work, IDs, and user decisions.",
						"Do not create or upgrade facts, permissions, approvals, policies, or production readiness.",
						"Return plain text under 1200 characters.",
					].join("\n"),
				},
				{ role: "user", content: transcript(messages) },
			],
			tools: [],
			reasoning: "disabled",
			fallbackOutput,
		}, signal);
		return {
			text: (response.text.trim() || fallbackOutput).slice(0, 1_200),
			usage: response.usage,
		};
	}
}
