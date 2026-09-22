import { ModelTelemetryStore } from "./modelTelemetry";
import { RuntimeActivityStore } from "./runtimeActivity";
import { resolve } from "node:path";
import { SkillRegistry } from "../../src/agent/skills";
import { defaultContextBudget } from "../../src/agent/tokenBudget";
import { printSkills } from "../../src/print/skills";
import { manufacturingSkills } from "../../src/manufacturing/skills";
import type { AgentTool, AgentToolApprovalPort } from "../../src/agent/contracts";
import type { SandboxedToolExecutorPort } from "../../src/agent/sandbox";
import type { AgentRuntimePort } from "../../src/runtime/contracts";
import { AnthropicMessagesClient } from "../anthropic/client";
import { BlackxAgentRuntime, type BlackxAgentRuntimeOptions } from "./agentRuntime";
import { AnthropicModelProvider } from "./anthropicModelProvider";
import { FakeAgentRuntime } from "./fakeAgentRuntime";
import { FileAgentStateStore } from "./fileAgentStateStore";
import { MacOsSeatbeltSandboxedToolExecutor } from "./macOsSeatbeltSandboxedToolExecutor";

export interface RuntimeServices {
	runtime: AgentRuntimePort;
	state: FileAgentStateStore;
	activity: RuntimeActivityStore;
	telemetry: ModelTelemetryStore;
}

export interface RuntimeServicesOptions {
	readTaskContext?: BlackxAgentRuntimeOptions["readTaskContext"];
	recoverToolExecution?: BlackxAgentRuntimeOptions["recoverToolExecution"];
	tools?: readonly AgentTool[];
	approval?: AgentToolApprovalPort;
	sandboxedToolExecutor?: SandboxedToolExecutorPort;
	autonomouslyApprovedTools?: ReadonlySet<string>;
	resolveImageAttachment?: BlackxAgentRuntimeOptions["resolveImageAttachment"];
}

export function validateAnthropicBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "ANTHROPIC_BASE_URL must be a plain http(s) URL without Markdown link syntax",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("ANTHROPIC_BASE_URL must use http or https");
  }
  return value.replace(/\/$/, "");
}

function positiveSetting(environment: NodeJS.ProcessEnv, key: string, fallback: number): number {
	const value = environment[key] === undefined ? fallback : Number(environment[key]);
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
	return value;
}

/** Host configuration; model capacities and operator limits do not belong in Core. */
export function runtimeContextSettings(environment: NodeJS.ProcessEnv) {
	const officialFlash = environment.ANTHROPIC_BASE_URL?.replace(/\/$/, "") === "https://api.deepseek.com/anthropic" && ["deepseek-v4-flash", "deepseek-flash"].includes(environment.ANTHROPIC_MODEL ?? "");
	const contextWindowTokens = positiveSetting(environment, "PACKX_MODEL_CONTEXT_TOKENS", officialFlash ? 1_000_000 : defaultContextBudget.contextWindowTokens);
	const reservedOutputTokens = positiveSetting(environment, "PACKX_MODEL_MAX_OUTPUT_TOKENS", defaultContextBudget.reservedOutputTokens);
	const safetyMarginTokens = positiveSetting(environment, "PACKX_CONTEXT_SAFETY_TOKENS", defaultContextBudget.safetyMarginTokens);
	const maxInputTokens = positiveSetting(environment, "PACKX_MAX_INPUT_TOKENS", defaultContextBudget.applicationInputTokens);
	const effectiveInput = Math.min(maxInputTokens, contextWindowTokens - reservedOutputTokens - safetyMarginTokens);
	const compactTriggerTokens = positiveSetting(environment, "PACKX_COMPACT_TRIGGER_TOKENS", Math.floor(effectiveInput * 0.7));
	const compactTargetTokens = positiveSetting(environment, "PACKX_COMPACT_TARGET_TOKENS", Math.floor(effectiveInput * 0.45));
	if (compactTargetTokens >= compactTriggerTokens || compactTriggerTokens > effectiveInput) throw new Error("Context budgets require 0 < compact target < compact trigger <= available input tokens");
	return { contextWindowTokens, reservedOutputTokens, safetyMarginTokens, maxInputTokens, compactTriggerTokens, compactTargetTokens };
}

export function createRuntime(
	environment: NodeJS.ProcessEnv,
	options: RuntimeServicesOptions = {},
): RuntimeServices {
  const activity = new RuntimeActivityStore();
	const telemetry = new ModelTelemetryStore(resolve(environment.BLACKX_AGENT_STATE_PATH ?? ".blackx-data/agent", "model-calls"), (environment.BLACKX_RUNTIME_MODE ?? "fake") === "anthropic" ? environment.ANTHROPIC_MODEL ?? "unconfigured" : "fake");
  const mode = environment.BLACKX_RUNTIME_MODE ?? "fake";
	const state = new FileAgentStateStore(environment.BLACKX_AGENT_STATE_PATH ?? ".blackx-data/agent");
	const sandboxedToolExecutor = options.sandboxedToolExecutor ?? (process.platform === "darwin"
		? new MacOsSeatbeltSandboxedToolExecutor({
			workspaceRoot: resolve(environment.BLACKX_WORKSPACE_ROOT ?? "."),
		})
		: undefined);
  if (mode === "fake") {
		return {
			runtime: new FakeAgentRuntime({
				sessions: state,
				snapshots: state,
				tools: options.tools,
				sandboxedToolExecutor,
				resolveImageAttachment: options.resolveImageAttachment,
				readTaskContext: options.readTaskContext,
				recoverToolExecution: options.recoverToolExecution,
			}),
			state,
			activity,
			telemetry,
		};
  }

  if (mode === "anthropic") {
    const apiKey = environment.ANTHROPIC_API_KEY;
    const configuredBaseUrl = environment.ANTHROPIC_BASE_URL;
    const model = environment.ANTHROPIC_MODEL;
    if (!apiKey || !configuredBaseUrl || !model) {
      throw new Error(
        "BLACKX_RUNTIME_MODE=anthropic requires ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL and ANTHROPIC_MODEL",
      );
    }
    const baseUrl = validateAnthropicBaseUrl(configuredBaseUrl);
		return {
			runtime: new BlackxAgentRuntime({
				telemetry,
				onActivity: (scope, event) => activity.observe(scope, event),
				...runtimeContextSettings(environment),
				provider: new AnthropicModelProvider(
					new AnthropicMessagesClient({ baseUrl, apiKey }),
					model,
					positiveSetting(environment, "PACKX_MODEL_MAX_OUTPUT_TOKENS", defaultContextBudget.reservedOutputTokens),
				),
				skills: new SkillRegistry([...printSkills, ...manufacturingSkills]),
				tools: options.tools,
				sandboxedToolExecutor,
				resolveImageAttachment: options.resolveImageAttachment,
				readTaskContext: options.readTaskContext,
				recoverToolExecution: options.recoverToolExecution,
				approval: {
					authorize: async (request, signal) => options.autonomouslyApprovedTools?.has(request.tool)
						? { approved: true, approvalId: `policy:${request.tool}:v1` }
						: options.approval?.authorize(request, signal) ?? { approved: false },
				},
				audit: state,
				sessions: state,
				snapshots: state,
				traces: state,
				executions: state,
			}),
			state,
			activity,
			telemetry,
		};
  }

  throw new Error(`Unsupported BLACKX_RUNTIME_MODE: ${mode}`);
}
