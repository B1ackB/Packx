import type { RuntimeUsage } from "../runtime/contracts";

export type AgentMode = "execute" | "plan";
export type PlanStatus = "planning" | "awaiting_confirmation" | "queued" | "running" | "paused" | "completed" | "stale" | "failed" | "cancelled" | "superseded";
export interface PlanTask {
	title: string;
	objective: string;
	tools: string[];
	/** Zero-based task indices within this immutable plan version. Omitted = independent. */
	dependsOn?: number[];
}
export interface PlanSpec {
	summary: string;
	tasks: PlanTask[];
}
export interface SubagentResult {
	summary: string;
	evidence: string[];
	limitations: string[];
	assessment?: { decision: "continue" | "replan"; reason: string };
}
export interface PlanTaskRun {
	taskIndex: number;
	attempt: number;
	generation: number;
	jobId: string;
	leaseId: string;
	sessionId: string;
	idempotencyKey: string;
	status: "running" | "paused" | "completed" | "failed" | "interrupted";
	startedAt: string;
	failure?: { code: string; retryable: boolean };
}
/** Host-owned receipt of inputs present before confirmation; contains no source bodies. */
export interface PlanInputDependencies {
	schemaVersion: "plan-input-dependencies.v1";
	contextSha256: string;
	facts: Array<{ key: string; version: number; sha256: string }>;
	artifacts: Array<{ artifactId: string; version: number; sha256: string }>;
}
export interface PlanVersion {
	version: number;
	objective: string;
	context: string;
	conversationRevision: number;
	status: PlanStatus;
	createdAt: string;
	actorId: string;
	spec?: PlanSpec;
	approval?: { actorId: string; version: number; at: string };
	generation: number;
	calls: number;
	children: Array<{ taskIndex: number; sessionId: string; executionId: string; result: SubagentResult; usage?: RuntimeUsage }>;
	activeTask?: number;
	/** Host-selected before confirmation; absent on legacy serial plans. */
	readConcurrency?: 2;
	/** Latest attempt per node; earlier transitions remain in append-only events. */
	taskRuns?: PlanTaskRun[];
	inputDependencies?: PlanInputDependencies;
	failure?: { code: string; retryable: boolean; reason?: string };
	replanFromVersion?: number;
}
export interface PlanWorkspace {
	revision: number;
	mode: AgentMode;
	versions: PlanVersion[];
	consecutiveFailures?: number;
}
export interface PlanScope { tenantId: string; workspaceId: string; runId: string }
export const PLAN_LIMITS = { tasks: 4, calls: 16, iterations: 4, tools: 8, inputTokens: 12_000, timeoutMs: 60_000, versions: 4, totalCalls: 32, consecutiveFailures: 3, dependencyChars: 24_000, inputRecords: 128 } as const;

export function planBudgetBlock(state: PlanWorkspace, generating = false): string | undefined {
	if ((state.consecutiveFailures ?? 0) >= PLAN_LIMITS.consecutiveFailures) return "plan_failure_limit";
	if (state.versions.reduce((sum, plan) => sum + plan.calls, 0) >= PLAN_LIMITS.totalCalls) return "plan_total_budget_exceeded";
	if (generating && state.versions.length >= PLAN_LIMITS.versions) return "plan_revision_limit";
	return undefined;
}
/** Result reconciliation reads existing receipts only, including when model budgets are exhausted. */
export function canReconcilePlan(plan?: PlanVersion): boolean {
	return !!plan?.approval && plan.readConcurrency === 2 && ["paused", "failed"].includes(plan.status)
		&& (!plan.failure || plan.failure.retryable || ["plan_job_failed", "plan_budget_exceeded", "plan_total_budget_exceeded", "plan_failure_limit"].includes(plan.failure.code))
		&& !!plan.taskRuns?.some(run => run.status !== "completed");
}
export class PlanError extends Error {
	constructor(readonly code: string, readonly status = 409) { super(code); this.name = "PlanError"; }
}
const bounded = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function parsePlan(value: unknown, allowedTools: readonly string[]): PlanSpec {
	if (!record(value) || Object.keys(value).some((key) => !["summary", "tasks"].includes(key)) || !bounded(value.summary, 2000) || !Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > PLAN_LIMITS.tasks) throw new PlanError("invalid_plan", 422);
	const count = value.tasks.length;
	const tasks = value.tasks.map((task, index): PlanTask => {
		if (!record(task) || Object.keys(task).some((key) => !["title", "objective", "tools", "dependsOn"].includes(key)) || !bounded(task.title, 120) || !bounded(task.objective, 4000) || !Array.isArray(task.tools) || task.tools.length > allowedTools.length || task.tools.some((tool) => typeof tool !== "string" || !allowedTools.includes(tool))) throw new PlanError("invalid_plan_task", 422);
		const deps = task.dependsOn;
		if (deps !== undefined && (!Array.isArray(deps) || deps.length >= count || new Set(deps).size !== deps.length || deps.some((dep) => !Number.isInteger(dep) || dep < 0 || dep >= count || dep === index))) throw new PlanError("invalid_plan_dependencies", 422);
		return { title: task.title, objective: task.objective, tools: [...new Set(task.tools as string[])], ...(deps === undefined ? {} : { dependsOn: deps as number[] }) };
	});
	const visited = new Set<number>();
	while (visited.size < tasks.length) {
		const index = tasks.findIndex((task, i) => !visited.has(i) && (task.dependsOn ?? []).every((dep) => visited.has(dep)));
		if (index < 0) throw new PlanError("invalid_plan_dependencies", 422);
		visited.add(index);
	}
	return { summary: value.summary, tasks };
}

/** Deterministic ready set; completion order never changes dependency routing. */
export function readyPlanTasks(plan: PlanVersion): number[] {
	const completed = new Set(plan.children.map((child) => child.taskIndex));
	return plan.spec?.tasks.flatMap((task, index) => !completed.has(index) && (task.dependsOn ?? []).every((dep) => completed.has(dep)) ? [index] : []) ?? [];
}
export function nextPlanTask(plan: PlanVersion): number { return readyPlanTasks(plan)[0] ?? -1; }
export function parseSubagentResult(value: unknown, requireAssessment = false): SubagentResult {
	if (!record(value) || Object.keys(value).some((key) => !["summary", "evidence", "limitations", "assessment"].includes(key)) || !bounded(value.summary, 8000) || ![value.evidence, value.limitations].every((v) => Array.isArray(v) && v.length <= 20 && v.every((s) => bounded(s, 1000)))) throw new PlanError("invalid_subagent_result", 422);
	const assessment = value.assessment;
	if ((requireAssessment || assessment !== undefined) && (!record(assessment) || Object.keys(assessment).some((key) => !["decision", "reason"].includes(key)) || !["continue", "replan"].includes(String(assessment.decision)) || !bounded(assessment.reason, 2000))) throw new PlanError("invalid_plan_assessment", 422);
	return { summary: value.summary, evidence: value.evidence as string[], limitations: value.limitations as string[], ...(assessment === undefined ? {} : { assessment: assessment as SubagentResult["assessment"] }) };
}
export const planSchema = {
	type: "object", additionalProperties: false, required: ["summary", "tasks"], properties: {
		summary: { type: "string", maxLength: 2000 },
		tasks: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", additionalProperties: false, required: ["title", "objective", "tools"], properties: { title: { type: "string", maxLength: 120 }, objective: { type: "string", maxLength: 4000 }, tools: { type: "array", items: { type: "string" } }, dependsOn: { type: "array", maxItems: 3, uniqueItems: true, items: { type: "integer", minimum: 0, maximum: 3 }, description: "Zero-based indices of prerequisite tasks; omit or [] for independent tasks. Must form an acyclic graph." } } } },
	},
};
export const subagentResultSchema = {
	type: "object", additionalProperties: false, required: ["summary", "evidence", "limitations", "assessment"], properties: {
		summary: { type: "string", maxLength: 8000 },
		evidence: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1000 } },
		limitations: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1000 } },
		assessment: { type: "object", additionalProperties: false, required: ["decision", "reason"], properties: { decision: { type: "string", enum: ["continue", "replan"] }, reason: { type: "string", minLength: 1, maxLength: 2000 } } },
	},
};

export function validPlanWorkspace(value: unknown): value is PlanWorkspace {
	if (!record(value) || !Number.isInteger(value.revision) || Number(value.revision) < 1 || !["plan", "execute"].includes(String(value.mode)) || !Array.isArray(value.versions)) return false;
	if (value.consecutiveFailures !== undefined && (!Number.isInteger(value.consecutiveFailures) || Number(value.consecutiveFailures) < 0 || Number(value.consecutiveFailures) > PLAN_LIMITS.consecutiveFailures)) return false;
	try {
		return value.versions.every((p, index) => {
			if (!record(p) || p.version !== index + 1 || !bounded(p.objective, 8000) || typeof p.context !== "string" || !Number.isInteger(p.conversationRevision) || Number(p.conversationRevision) < 0 || !["planning", "awaiting_confirmation", "queued", "running", "paused", "completed", "stale", "failed", "cancelled", "superseded"].includes(String(p.status)) || !Number.isInteger(p.calls) || Number(p.calls) < 0 || Number(p.calls) > PLAN_LIMITS.calls || !Number.isInteger(p.generation) || Number(p.generation) < 1 || !bounded(p.actorId, 128) || typeof p.createdAt !== "string" || !Number.isFinite(Date.parse(p.createdAt)) || !Array.isArray(p.children) || p.children.length > PLAN_LIMITS.tasks) return false;
			const declaredTools = record(p.spec) && Array.isArray(p.spec.tasks) ? p.spec.tasks.flatMap((t) => record(t) && Array.isArray(t.tools) ? t.tools.filter((tool): tool is string => bounded(tool, 128)) : []) : [];
			const spec = p.spec === undefined ? undefined : parsePlan(p.spec, declaredTools);
			if (p.readConcurrency !== undefined && (p.readConcurrency !== 2 || !spec)) return false;
			if (p.inputDependencies !== undefined) {
				const dependencies = p.inputDependencies;
				if (p.readConcurrency !== 2 || !record(dependencies) || Object.keys(dependencies).sort().join() !== "artifacts,contextSha256,facts,schemaVersion" || dependencies.schemaVersion !== "plan-input-dependencies.v1" || typeof dependencies.contextSha256 !== "string" || !/^[a-f0-9]{64}$/.test(dependencies.contextSha256) || !Array.isArray(dependencies.facts) || !Array.isArray(dependencies.artifacts) || dependencies.facts.length + dependencies.artifacts.length > PLAN_LIMITS.inputRecords) return false;
				for (const [records, identity] of [[dependencies.facts, "key"], [dependencies.artifacts, "artifactId"]] as const) {
					const seen = new Set<string>();
					for (const item of records) {
						if (!record(item) || Object.keys(item).sort().join() !== [identity, "sha256", "version"].sort().join() || !bounded(item[identity], 128) || seen.has(String(item[identity])) || !Number.isSafeInteger(item.version) || Number(item.version) < 1 || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) return false;
						seen.add(String(item[identity]));
					}
				}
			}
			if (p.taskRuns !== undefined) {
				if (p.readConcurrency !== 2 || !Array.isArray(p.taskRuns) || p.taskRuns.length > (spec?.tasks.length ?? 0)) return false;
				const indices = new Set<number>();
				for (const run of p.taskRuns) {
					if (!record(run) || !Number.isInteger(run.taskIndex) || Number(run.taskIndex) < 0 || Number(run.taskIndex) >= spec!.tasks.length || indices.has(Number(run.taskIndex)) || !Number.isInteger(run.attempt) || Number(run.attempt) < 1 || Number(run.attempt) > Number(p.calls) || !Number.isInteger(run.generation) || Number(run.generation) < 1 || Number(run.generation) > Number(p.generation) || ![run.jobId, run.leaseId, run.sessionId, run.idempotencyKey].every((v) => bounded(v, 128)) || !["running", "paused", "completed", "failed", "interrupted"].includes(String(run.status)) || typeof run.startedAt !== "string" || !Number.isFinite(Date.parse(run.startedAt))) return false;
					if (run.failure !== undefined && (!record(run.failure) || !bounded(run.failure.code, 128) || typeof run.failure.retryable !== "boolean")) return false;
					if (run.status === "running" && (!["queued", "running"].includes(String(p.status)) || run.generation !== p.generation)) return false;
					if ((run.status === "completed") !== p.children.some((child) => record(child) && child.taskIndex === run.taskIndex)) return false;
					indices.add(Number(run.taskIndex));
				}
				if (p.taskRuns.filter((run) => record(run) && run.status === "running").length > 2) return false;
			}
			if (["awaiting_confirmation", "queued", "running", "paused", "completed", "stale"].includes(String(p.status)) && !spec) return false;
			if (p.approval !== undefined && (!record(p.approval) || p.approval.version !== p.version || !bounded(p.approval.actorId, 128) || typeof p.approval.at !== "string" || !Number.isFinite(Date.parse(p.approval.at)))) return false;
			if (["queued", "running", "paused", "completed", "stale"].includes(String(p.status)) && !p.approval) return false;
			if (["completed", "stale"].includes(String(p.status)) && p.children.length !== spec?.tasks.length) return false;
			if (p.status === "stale" && (p.readConcurrency !== 2 || !record(p.failure) || p.failure.code !== "plan_sources_changed" || p.failure.retryable !== false)) return false;
			if (p.replanFromVersion !== undefined && (!Number.isInteger(p.replanFromVersion) || Number(p.replanFromVersion) < 1 || Number(p.replanFromVersion) >= Number(p.version))) return false;
			if (p.failure !== undefined && (!record(p.failure) || !bounded(p.failure.code, 128) || typeof p.failure.retryable !== "boolean" || (p.failure.reason !== undefined && !bounded(p.failure.reason, 2000)))) return false;
			if (["completed", "stale"].includes(String(p.status)) && p.children.some((child) => record(child) && record(child.result) && record(child.result.assessment) && child.result.assessment.decision === "replan")) return false;
			const completed = new Set<number>();
			const successful = new Set<number>();
			return p.children.every((child) => {
				if (!record(child) || !Number.isInteger(child.taskIndex) || Number(child.taskIndex) < 0 || Number(child.taskIndex) >= (spec?.tasks.length ?? 0) || completed.has(Number(child.taskIndex)) || !bounded(child.sessionId, 128) || !bounded(child.executionId, 128)) return false;
				const task = spec!.tasks[Number(child.taskIndex)];
				if (!(task.dependsOn ?? []).every((dep) => successful.has(dep))) return false;
				const result = parseSubagentResult(child.result);
				completed.add(Number(child.taskIndex));
				if (result.evidence.length && result.assessment?.decision === "continue") successful.add(Number(child.taskIndex));
				return true;
			});
		});
	} catch { return false; }
}
