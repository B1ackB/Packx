import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentSandboxedTool } from "../src/agent/contracts";
import { AnthropicModelProvider } from "../server/runtime/anthropicModelProvider";
import { createRuntime } from "../server/runtime/createRuntime";

it("keeps the ordinary Windows runtime fail-closed without an explicitly supplied executor", async () => {
	const root = mkdtempSync(join(tmpdir(), "packx-windows-entry-"));
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	// Unit injection on macOS/Linux; this identical case also runs on real Windows CI.
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	const invocation = vi.fn(() => ({ argv: [], workingDirectory: root, paths: { readOnly: [], writable: [], temporaryDirectory: join(root, "attempt") } }));
	const tool: AgentSandboxedTool = { name: "isolated_fixture", description: "Synthetic sandbox-only tool", inputSchema: { type: "object" }, execution: "sandboxed", risk: "read", idempotent: true, version: "1", executable: join(root, "untrusted.exe"), timeoutMs: 1000, maxResultChars: 1000, validate: () => true, createInvocation: invocation, sandbox: { environment: {}, network: { mode: "deny-all", allowedDomains: [] }, limits: { maxStdoutBytes: 1024, maxStderrBytes: 1024, maxOutputFiles: 0, maxOutputBytes: 0 } } };
	let calls = 0;
	const tokens = vi.spyOn(AnthropicModelProvider.prototype, "countTokens").mockResolvedValue(64);
	const model = vi.spyOn(AnthropicModelProvider.prototype, "generate").mockImplementation(async () => ({ text: calls++ ? "unavailable" : "", toolCalls: calls === 1 ? [{ id: "isolated", name: tool.name, input: {} }] : [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 }, providerState: undefined, telemetry: { model: "fixture", stopReason: "fixture", inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null } }));
	try {
		const services = createRuntime({ BLACKX_RUNTIME_MODE: "anthropic", BLACKX_AGENT_STATE_PATH: root, ANTHROPIC_API_KEY: "offline-fixture", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_MODEL: "fixture" }, { tools: [tool] });
		const result = await services.runtime.executeTurn({ tenantId: "tenant", workspaceId: "workspace", runId: "task", actorId: "user", stageId: "conversation", idempotencyKey: "attempt", input: "Run isolated fixture", allowedTools: [tool.name], fallbackOutput: "", policy: { sandboxMode: "read-only", approvalPolicy: "never", timeoutMs: 2000 } });
		expect(result.events).toContainEqual(expect.objectContaining({ type: "tool.completed", tool: tool.name, status: "failed", failureCode: "tool_sandbox_unavailable" }));
		expect(invocation).not.toHaveBeenCalled();
		expect(model).toHaveBeenCalledTimes(2);
	} finally { model.mockRestore(); tokens.mockRestore(); Object.defineProperty(process, "platform", platform); rmSync(root, { recursive: true, force: true }); }
});
