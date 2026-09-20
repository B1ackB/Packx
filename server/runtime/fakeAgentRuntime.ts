import type { AgentModelProvider, AgentTool } from "../../src/agent/contracts";
import type { SandboxedToolExecutorPort } from "../../src/agent/sandbox";
import { SkillRegistry } from "../../src/agent/skills";
import type { AgentSessionStore, ContextSnapshotStore } from "../../src/agent/state";
import { printSkills } from "../../src/print/skills";
import { manufacturingSkills } from "../../src/manufacturing/skills";
import { BlackxAgentRuntime, type BlackxAgentRuntimeOptions } from "./agentRuntime";

const fakeProvider: AgentModelProvider = {
	async generate(request) {
		return {
			// Explicit offline review fixture; production fallback remains invalid and fail-closed.
			text: request.outputSchema?.properties && typeof request.outputSchema.properties === "object" && "issues" in request.outputSchema.properties ? JSON.stringify({ issues: [] }) : request.fallbackOutput,
			toolCalls: [],
			usage: {
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
			},
		};
	},
};

export class FakeAgentRuntime extends BlackxAgentRuntime {
	constructor(options: {
		readTaskContext?: BlackxAgentRuntimeOptions["readTaskContext"];
		sessions?: AgentSessionStore;
		snapshots?: ContextSnapshotStore;
		tools?: readonly AgentTool[];
		sandboxedToolExecutor?: SandboxedToolExecutorPort;
		resolveImageAttachment?: BlackxAgentRuntimeOptions["resolveImageAttachment"];
	} = {}) {
		super({ provider: fakeProvider, skills: new SkillRegistry([...printSkills, ...manufacturingSkills]), ...options });
	}

	override async health() {
		return { adapter: "fake" as const, online: true, coreVersion: "m0.1" };
	}

	override async executeTurn(...parameters: Parameters<BlackxAgentRuntime["executeTurn"]>) {
		const result = await super.executeTurn(...parameters);
		return { ...result, adapter: "fake" as const };
	}
}
