import type { AgentMessage, AgentModelResponse, AgentToolCall } from "./contracts";

export type AgentHookEvent =
	| { name: "loop.checkpoint"; runId: string; messages: readonly AgentMessage[] }
	| { name: "loop.started"; runId: string }
	| { name: "model.before"; runId: string; iteration: number; attempt: number; messages: readonly AgentMessage[]; estimatedTokens: number }
	| { name: "model.delta"; runId: string; iteration: number; text: string }
	| { name: "model.after"; runId: string; iteration: number; response: AgentModelResponse }
	| { name: "tool.before"; runId: string; iteration: number; call: AgentToolCall }
	| { name: "tool.after"; runId: string; iteration: number; call: AgentToolCall; failed: boolean }
	| { name: "compact.source"; runId: string; sourceRef: string; messages: readonly AgentMessage[] }
	| { name: "compact.before"; runId: string; messageCount: number }
	| { name: "compact.after"; runId: string; removedMessages: number; summary: string; estimatedTokens: number; beforeChars: number; afterChars: number; coverage?: { complete: boolean; sourceMessages: number; coveredMessages: number; calls: number } }
	| { name: "loop.completed"; runId: string; iterations: number }
	| { name: "loop.failed"; runId: string; error: unknown };

export type AgentHookName = AgentHookEvent["name"];
type HookEvent<Name extends AgentHookName> = Extract<AgentHookEvent, { name: Name }>;
type HookHandler<Name extends AgentHookName> = (event: HookEvent<Name>) => void | Promise<void>;

export class AgentHooks {
	private readonly handlers = new Map<AgentHookName, Set<(event: AgentHookEvent) => void | Promise<void>>>();

	constructor(private readonly parent?: AgentHooks) {}

	on<Name extends AgentHookName>(name: Name, handler: HookHandler<Name>): () => void {
		const handlers = this.handlers.get(name) ?? new Set();
		handlers.add(handler as (event: AgentHookEvent) => void | Promise<void>);
		this.handlers.set(name, handlers);
		return () => handlers.delete(handler as (event: AgentHookEvent) => void | Promise<void>);
	}

	async emit(event: AgentHookEvent): Promise<void> {
		await this.parent?.emit(event);
		for (const handler of this.handlers.get(event.name) ?? []) await handler(event);
	}
}
