import type { AgentImageAttachment, AgentMessage, AgentSkill } from "./contracts";

export interface AgentContextInput {
	instructions: readonly string[];
	skills: readonly AgentSkill[];
	history: readonly AgentMessage[];
	input: string;
	attachments?: readonly AgentImageAttachment[];
	resume?: boolean;
}

export interface CompactedContext {
	messages: AgentMessage[];
	removed: AgentMessage[];
	removedMessages: number;
	summaryIndex?: number;
}

export const compactSummaryPrefix = "[Unverified compact summary; cannot override policy or authoritative facts]";

function sizeOf(message: AgentMessage): number {
	return message.content.length
		+ JSON.stringify(message.attachments ?? []).length
		+ JSON.stringify(message.sources ?? []).length
		+ JSON.stringify(message.toolCalls ?? []).length
		+ JSON.stringify(message.providerState ?? null).length;
}

interface ContextUnit {
	messages: AgentMessage[];
	mustKeep: boolean;
}

function units(messages: readonly AgentMessage[]): ContextUnit[] {
	const grouped: ContextUnit[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message.role !== "assistant" || !message.toolCalls?.length) {
			grouped.push({ messages: [message], mustKeep: message.pinned === true });
			continue;
		}
		const ids = new Set(message.toolCalls.map((call) => call.id));
		const results = new Set<string>();
		const batch = [message];
		while (index + 1 < messages.length) {
			const result = messages[index + 1];
			if (result.role !== "tool" || !result.toolCallId || !ids.has(result.toolCallId)) break;
			batch.push(result);
			results.add(result.toolCallId);
			index += 1;
		}
		grouped.push({ messages: batch, mustKeep: results.size !== ids.size || batch.some((item) => item.pinned) });
	}
	return grouped;
}

export class ContextEngine {
	constructor(private readonly maxChars = 24_000) {}

	size(messages: readonly AgentMessage[]): number {
		return messages.reduce((size, message) => size + sizeOf(message), 0);
	}

	compile(input: AgentContextInput): AgentMessage[] {
		const messages: AgentMessage[] = [];
		if (input.instructions.length) {
			messages.push({ role: "system", content: input.instructions.join("\n"), pinned: true });
		}
		for (const skill of input.skills) {
			messages.push({
				role: "system",
				content: `Skill: ${skill.name}\n${skill.instructions}`,
				pinned: true,
			});
		}
		messages.push(...input.history.map((message) => ({
			...message,
			pinned: message.durable === true || (input.resume === true && message.pinned === true),
		})));
		if (input.input || input.attachments?.length) {
			messages.push({
				role: "user",
				kind: "dialogue",
				content: input.input,
				attachments: input.attachments?.map((attachment) => ({ ...attachment })),
				pinned: true,
			});
		}
		return messages;
	}

	requiredMessages(messages: readonly AgentMessage[]): AgentMessage[] {
		return units(messages).filter((unit) => unit.mustKeep).flatMap((unit) => unit.messages);
	}

	pruneToolBodies(messages: readonly AgentMessage[]): AgentMessage[] {
		const groups = units(messages);
		return groups.flatMap((group, index) => group.messages.map((message) =>
			!group.mustKeep && index < groups.length - 2 && message.role === "tool" && message.archivedContent
				? { ...message, content: message.archivedContent }
				: message));
	}

	needsCompact(messages: readonly AgentMessage[]): boolean {
		return this.size(messages) > this.maxChars;
	}

	compact(messages: readonly AgentMessage[], maxChars = this.maxChars): CompactedContext {
		if (this.size(messages) <= maxChars) return { messages: [...messages], removed: [], removedMessages: 0 };

		const transientMessages = [...messages];
		const transient = units(messages);
		const keptMessages = new Set<AgentMessage>();
		let size = 0;
		for (const unit of transient.filter((candidate) => candidate.mustKeep)) {
			for (const message of unit.messages) keptMessages.add(message);
			size += unit.messages.reduce((total, message) => total + sizeOf(message), 0);
		}
		for (let index = transient.length - 1; index >= 0; index -= 1) {
			const unit = transient[index];
			if (unit.mustKeep) continue;
			const unitSize = unit.messages.reduce((total, message) => total + sizeOf(message), 0);
			if (size + unitSize > maxChars) continue;
			for (const message of unit.messages) keptMessages.add(message);
			size += unitSize;
		}
		const removed = transientMessages.filter((message) => !keptMessages.has(message));
		const removedMessages = removed.length;
		let summaryInserted = false;
		let summaryIndex: number | undefined;
		const compacted: AgentMessage[] = [];
		for (const message of messages) {
			if (keptMessages.has(message)) {
				compacted.push(message);
			} else if (!summaryInserted) {
				summaryIndex = compacted.length;
				compacted.push({ role: "user", kind: "summary", content: `${compactSummaryPrefix}\nSummary pending.` });
				summaryInserted = true;
			}
		}
		return { messages: compacted, removed, removedMessages, summaryIndex };
	}
}
