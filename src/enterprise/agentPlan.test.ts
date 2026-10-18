import { expect, it } from "vitest";
import { nextPlanTask, parsePlan, validPlanWorkspace, type PlanSpec, type PlanVersion } from "./agentPlan";

const task = (dependsOn?: number[]) => ({ title: "Review", objective: "Review a source", tools: [], ...(dependsOn === undefined ? {} : { dependsOn }) });
const spec = (dependencies: Array<number[] | undefined>): PlanSpec => ({ summary: "Source review", tasks: dependencies.map(task) });

it("preserves legacy plans and validates forward dependencies without changing task identities", () => {
	expect(parsePlan(spec([undefined, undefined]), [])).toEqual(spec([undefined, undefined]));
	expect(parsePlan(spec([[2], [], [1]]), [])).toEqual(spec([[2], [], [1]]));
});
it.each([
	[[0]], [[1]], [[-1]], [[0.5]], [["0"]], [[null]], ["invalid"],
	[[1], [0]], [[1], [2], [0]], [[1, 1], [], []], [[2], []],
])("rejects malformed or cyclic dependencies %j", (...dependencies) => {
	expect(() => parsePlan(spec(dependencies as number[][]), [])).toThrow("invalid_plan_dependencies");
});
it("selects the first ready task deterministically", () => {
	const plan = { spec: spec([[2], [], [1]]), children: [] } as unknown as PlanVersion;
	expect(nextPlanTask(plan)).toBe(1);
	plan.children.push({ taskIndex: 1 } as PlanVersion["children"][number]);
	expect(nextPlanTask(plan)).toBe(2);
	plan.children.push({ taskIndex: 2 } as PlanVersion["children"][number]);
	expect(nextPlanTask(plan)).toBe(0);
	plan.children.push({ taskIndex: 0 } as PlanVersion["children"][number]);
	expect(nextPlanTask(plan)).toBe(-1);
});
it("rejects duplicate, out-of-order or unproven dependency receipts in persisted state", () => {
	const result = { summary: "Report", evidence: ["fixture source"], limitations: [], assessment: { decision: "continue", reason: "Evidence collected" } };
	const child = (taskIndex: number) => ({ taskIndex, sessionId: `s${taskIndex}`, executionId: `e${taskIndex}`, result });
	const plan = { version: 1, objective: "Review", context: "sources", conversationRevision: 1, status: "completed", createdAt: "2026-10-18T00:00:00Z", actorId: "user", generation: 1, calls: 4,
		spec: spec([[2], [], [1]]), approval: { actorId: "user", version: 1, at: "2026-10-18T00:00:00Z" }, children: [child(1), child(2), child(0)] };
	const state = { revision: 5, mode: "plan", versions: [plan] };
	expect(validPlanWorkspace(state)).toBe(true);
	expect(validPlanWorkspace({ ...state, versions: [{ ...plan, children: [child(1), child(1), child(0)] }] })).toBe(false);
	expect(validPlanWorkspace({ ...state, versions: [{ ...plan, children: [child(0), child(1), child(2)] }] })).toBe(false);
	for (const unproven of [{ ...result, evidence: [] }, { ...result, assessment: undefined }]) {
		expect(validPlanWorkspace({ ...state, versions: [{ ...plan, children: [{ ...child(1), result: unproven }, child(2), child(0)] }] })).toBe(false);
	}
});
