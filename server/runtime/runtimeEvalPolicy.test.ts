import { describe, expect, it } from "vitest";
import type { RuntimeTurnRequest } from "../../src/runtime/contracts";
import { forceRuntimeEvalPolicy, runtimeEvalEnabled } from "./runtimeEvalPolicy";

const identity = { tenantId: "host-tenant", workspaceId: "host-workspace", actorId: "host-actor" };
const payload: RuntimeTurnRequest = {
	tenantId: "forged-tenant", workspaceId: "forged-workspace", runId: "run", stageId: "stage", actorId: "forged-actor",
	idempotencyKey: "turn", input: "read", fallbackOutput: "", allowedTools: ["file_write"],
	policy: { sandboxMode: "workspace-write", approvalPolicy: "never", timeoutMs: 5_000 },
};

describe("runtime eval policy", () => {
	it("is disabled unless the explicit switch is exactly 1", () => {
		expect(runtimeEvalEnabled({})).toBe(false);
		expect(runtimeEvalEnabled({ BLACKX_ENABLE_RUNTIME_EVAL: "true" })).toBe(false);
		expect(runtimeEvalEnabled({ BLACKX_ENABLE_RUNTIME_EVAL: "1" })).toBe(true);
	});

	it("ignores request-supplied identity, tools and sandbox policy", () => {
		const forced = forceRuntimeEvalPolicy(payload, identity, 30_000);

		expect(forced).toMatchObject({
			tenantId: "host-tenant", workspaceId: "host-workspace", actorId: "host-actor",
			allowedTools: [],
			policy: { sandboxMode: "read-only", approvalPolicy: "required", timeoutMs: 30_000 },
		});
		expect(payload.policy.sandboxMode).toBe("workspace-write");
	});
});
