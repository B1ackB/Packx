import { createHash } from "node:crypto";
import type { AgentToolCall } from "../../src/agent/contracts";
import type { AgentHooks } from "../../src/agent/hooks";
import { RuntimeFailure, type RuntimeLoopGuardState } from "../../src/runtime/contracts";

export const LOOP_GUARD_LIMITS = { failures: 3, repeats: 3, period: 4 } as const;

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "undefined";
}

export function validLoopGuard(value: unknown): value is RuntimeLoopGuardState {
	if (!value || typeof value !== "object") return false;
	const state = value as RuntimeLoopGuardState;
	return Number.isSafeInteger(state.sequence) && state.sequence > 0 &&
		Array.isArray(state.actions) && state.actions.length <= LOOP_GUARD_LIMITS.repeats * LOOP_GUARD_LIMITS.period && state.actions.every((item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)) &&
		Number.isInteger(state.consecutiveFailures) && state.consecutiveFailures >= 0 && state.consecutiveFailures <= LOOP_GUARD_LIMITS.failures &&
		(state.blocked === undefined || state.blocked === "repeated_actions" || state.blocked === "consecutive_tool_failures");
}

export class RuntimeLoopGuard {
	readonly state: RuntimeLoopGuardState;
	constructor(previous?: RuntimeLoopGuardState) {
		if (previous && !validLoopGuard(previous)) throw new RuntimeFailure("infrastructure_failure", "Invalid persisted loop guard", false);
		this.state = previous ? { ...previous, actions: [...previous.actions], sequence: previous.sequence + 1 } : { sequence: 1, actions: [], consecutiveFailures: 0 };
	}
	check() {
		if (this.state.blocked) throw new RuntimeFailure(this.state.blocked, this.state.blocked === "repeated_actions"
			? "Repeated tool actions stopped this turn; revise the task before trying again."
			: "Three consecutive tool failures stopped this turn; resolve the cause before trying again.", false);
	}
	before(call: AgentToolCall) {
		this.check();
		const digest = createHash("sha256").update(canonical([call.name, call.input])).digest("hex");
		const actions = [...this.state.actions, digest].slice(-LOOP_GUARD_LIMITS.repeats * LOOP_GUARD_LIMITS.period);
		for (let period = 1; period <= LOOP_GUARD_LIMITS.period; period++) {
			const tail = actions.slice(-period * LOOP_GUARD_LIMITS.repeats);
			if (tail.length === period * LOOP_GUARD_LIMITS.repeats && tail.every((action, index) => action === tail[index % period])) {
				this.state.blocked = "repeated_actions";
				this.check();
			}
		}
		this.state.actions = actions;
	}
	after(failed: boolean) {
		this.state.consecutiveFailures = failed ? this.state.consecutiveFailures + 1 : 0;
		if (this.state.consecutiveFailures >= LOOP_GUARD_LIMITS.failures) this.state.blocked = "consecutive_tool_failures";
		this.check();
	}
	attach(hooks: AgentHooks, signal: AbortSignal) {
		hooks.on("tool.before", ({ call }) => { signal.throwIfAborted(); this.before(call); });
		hooks.on("tool.after", ({ failed }) => { signal.throwIfAborted(); this.after(failed); });
	}
}
