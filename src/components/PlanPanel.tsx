import { PLAN_LIMITS, planBudgetBlock, type PlanWorkspace, type PlanStatus } from "../enterprise/agentPlan";
import { Markdown } from "./Markdown";
import type { Language } from "../i18n";

const labels: Record<PlanStatus, [string, string]> = {
	planning: ["正在规划（只读）", "Planning (read-only)"], awaiting_confirmation: ["等待你确认", "Awaiting your confirmation"],
	queued: ["等待执行", "Queued"], running: ["子 Agent 执行中", "Subagents running"], paused: ["已暂停", "Paused"],
	completed: ["执行完成，结果待核对", "Completed; review results"], failed: ["执行失败", "Failed"], cancelled: ["已取消", "Cancelled"], superseded: ["已被替代", "Superseded"],
};
export function PlanPanel({ state, language, busy, onCommand, part, onCreateBrief }: { state?: PlanWorkspace; language: Language; busy: boolean; onCommand: (command: Record<string, unknown>) => void; part: "controls" | "details"; onCreateBrief?: (version: number) => void }) {
	const en = language === "en";
	const plan = state?.versions.at(-1);
	const generationBlocked = state && planBudgetBlock(state, true);
	const executionBlocked = state && planBudgetBlock(state);
	const running = !!plan && ["planning", "queued", "running"].includes(plan.status);
	if (part === "details" && !plan) return null;
	return <section className={part === "controls" ? "plan-controls" : "plan-panel"} aria-label={en ? "Plan and subagents" : "计划与子 Agent"}>
		{part === "controls" && <div className="plan-toolbar">
			<label>{en ? "Mode " : "模式 "}<select aria-label={en ? "Agent mode" : "Agent 模式"} value={state?.mode ?? "execute"} disabled={!state || busy || running} onChange={(e) => onCommand({ action: "mode", mode: e.target.value })}>
				<option value="execute">{en ? "Direct execution" : "直接执行"}</option>
				<option value="plan">{en ? "Plan · confirm before execution" : "Plan · 确认后执行"}</option>
			</select></label>
			{plan && <span role="status">v{plan.version} · {labels[plan.status][en ? 1 : 0]}</span>}
		</div>}
		{part === "controls" && state?.mode === "plan" && <p>{en ? "Plan is read-only. Review the plan above and confirm its version before subagents execute." : "Plan 阶段只读。请先核对上方计划，确认具体版本后再启动子 Agent。"}</p>}
		{part === "details" && plan && <details open={state?.mode === "plan"}>
			<summary>{en ? "Plan and results" : "计划与结果"} · v{plan.version}</summary>
			<p>{plan.objective}</p>
			{state && <p>{en ? "Task budget: " : "任务累计预算："}{state.versions.length}/{PLAN_LIMITS.versions}{en ? " plan versions · " : " 个计划版本 · "}{state.versions.reduce((sum, p) => sum + p.calls, 0)}/{PLAN_LIMITS.totalCalls}{en ? " execution slices · " : " 个执行片 · "}{state.consecutiveFailures ?? 0}/{PLAN_LIMITS.consecutiveFailures}{en ? " consecutive failures" : " 次连续失败"}</p>}
			{generationBlocked && <p role="alert">{executionBlocked ? en ? "This task has reached its failure or execution limit. Review existing results and resolve the cause before starting a new task. Replanning cannot reset this budget." : "本任务已达到连续失败或执行总量上限。请先核对已有结果并解决原因，再新建任务；重新规划不能重置预算。" : en ? "Plan-version limit reached. You can still confirm or resume the current plan within its execution budget; further plans need a new task." : "已达计划版本上限。执行预算充足时仍可确认或恢复当前计划；后续新计划需新建任务。"}</p>}
			{plan.replanFromVersion && <p>{en ? `Replanned from v${plan.replanFromVersion}; requires a new confirmation.` : `基于 v${plan.replanFromVersion} 重新规划，需重新确认。`}</p>}
			{plan.spec && <>
				<Markdown text={plan.spec.summary} language={language} />
				<ol>{plan.spec.tasks.map((task, index) => {
					const child = plan.children.find((c) => c.taskIndex === index);
					const needsReplan = child && (child.result.assessment?.decision === "replan" || !child.result.evidence.length);
					return <li key={index}><strong>{task.title}</strong> · {needsReplan ? en ? "Needs replanning" : "需要重新规划" : child ? en ? "Completed" : "已完成" : plan.activeTask === index && running ? en ? "Running" : "执行中" : en ? "Pending" : "待执行"}
						<p>{task.objective}</p><small>{en ? "Tools: " : "工具："}{task.tools.join(", ") || (en ? "None" : "无")}</small>
						{child && <div><Markdown text={child.result.summary} language={language} />
							<p>{en ? "Evidence (reported by subagent)" : "执行证据（子 Agent 报告，待核对）"}</p><ul>{child.result.evidence.map((item, i) => <li key={i}>{item}</li>)}</ul>
							<p>{en ? "Limitations" : "限制与待确认事项"}</p><ul>{child.result.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul>
							{child.result.assessment && <p>{en ? "Plan checkpoint: " : "计划检查点："}{child.result.assessment.reason}</p>}
						</div>}
					</li>;
				})}</ol>
			</>}
			{plan.failure && <p role="alert">{en ? "The task did not complete. " : "任务未完成。"}{plan.failure.code}{!executionBlocked && plan.failure.retryable ? en ? " You can resume." : "可以恢复执行。" : en ? generationBlocked ? " Resolve the cause before starting a new task." : " Revise the task and generate a new plan." : generationBlocked ? "请先处理原因，再新建任务。" : "请修改任务并生成新计划。"}</p>}
			{plan.failure?.reason && <p>{plan.failure.reason}</p>}
			<div className="plan-actions">
				{["failed", "paused", "awaiting_confirmation"].includes(plan.status) && state?.mode === "plan" && <button disabled={busy || !!generationBlocked} onClick={() => onCommand({ action: "replan", version: plan.version })}>{en ? "Replan using current results" : "结合当前结果重新规划"}</button>}
				{plan.status === "completed" && onCreateBrief && <button disabled={busy} onClick={() => onCreateBrief(plan.version)}>{en ? "Create requirement draft from results" : "将结果转为需求单草稿"}</button>}
				{plan.status === "awaiting_confirmation" && state?.mode === "plan" && <button disabled={busy || !!executionBlocked} onClick={() => onCommand({ action: "confirm", version: plan.version, confirmed: true })}>{en ? `Confirm v${plan.version} and run subagents` : `确认 v${plan.version} 并启动子 Agent`}</button>}
				{running && <button disabled={busy} onClick={() => onCommand({ action: "pause", version: plan.version })}>{en ? "Pause" : "暂停"}</button>}
				{(plan.status === "paused" || plan.status === "failed" && plan.failure?.retryable) && plan.approval && state?.mode === "plan" && <button disabled={busy || !!executionBlocked} onClick={() => onCommand({ action: "resume", version: plan.version })}>{en ? "Resume approved plan" : "恢复已确认计划"}</button>}
				{!["completed", "cancelled", "superseded"].includes(plan.status) && <button disabled={busy} onClick={() => onCommand({ action: "cancel", version: plan.version })}>{en ? "Cancel plan" : "取消计划"}</button>}
			</div>
			{state && state.versions.length > 1 && <details><summary>{en ? "Previous versions" : "历史版本"}</summary>{state.versions.slice(0, -1).map((p) => <div key={p.version}><strong>v{p.version} · {labels[p.status][en ? 1 : 0]}</strong><p>{p.spec?.summary ?? p.objective}</p></div>)}</details>}
		</details>}
	</section>;
}
