import type { RuntimeTurnRequest } from "../../src/runtime/contracts";

export function runtimeEvalEnabled(environment: NodeJS.ProcessEnv): boolean {
	return environment.BLACKX_ENABLE_RUNTIME_EVAL === "1";
}

/** External eval turns never choose tools, identity or sandbox policy; the Host supplies them. */
export function forceRuntimeEvalPolicy(
	payload: RuntimeTurnRequest,
	identity: { tenantId: string; workspaceId: string; actorId: string },
	timeoutMs: number,
): RuntimeTurnRequest {
	return {
		...payload,
		...identity,
		allowedTools: [],
		policy: { ...payload.policy, timeoutMs, sandboxMode: "read-only", approvalPolicy: "required" },
	};
}
