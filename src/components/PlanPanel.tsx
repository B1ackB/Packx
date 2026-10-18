import { PLAN_LIMITS, planBudgetBlock, type PlanWorkspace, type PlanStatus } from "../enterprise/agentPlan";
import { Markdown } from "./Markdown";
import { errorText, type Language } from "../i18n";

const labels: Record<PlanStatus, [string, string]> = {
	planning: ["正在规划（只读）", "Planning (read-only)"], awaiting_confirmation: ["等待你确认", "Awaiting your confirmation"],
	queued: ["等待执行", "Queued"], running: ["正在按计划执行", "Executing plan"], paused: ["已暂停", "Paused"],
	completed: ["执行完成，结果待核对", "Completed; review results"], failed: ["执行失败", "Failed"], cancelled: ["已取消", "Cancelled"], superseded: ["已被替代", "Superseded"],
};
const actionLabels: Record<string, [string, string]> = {
	source_report_read: ["读取所选资料报告（未验证）", "Read selected source report (unverified)"],
	file_list: ["查看文件列表", "Browse files"], file_read: ["读取文件", "Read files"], document_read: ["读取文档", "Read documents"],
	file_write: ["保存文件（需另行批准）", "Save files (separate approval required)"], file_delete: ["删除文件（需另行批准）", "Delete files (separate approval required)"],
	knowledge_search: ["查找资料", "Find sources"], knowledge_selected: ["查看已选资料", "Review selected sources"], knowledge_read: ["阅读资料原文", "Read original sources"],
	packaging_compare_evidence: ["比对包装参数", "Compare packaging parameters"], packaging_find_products: ["查找包装产品", "Find packaging products"],
};
export function PlanPanel({ state, language, busy, onCommand, part, onCreateBrief }: { state?: PlanWorkspace; language: Language; busy: boolean; onCommand: (command: Record<string, unknown>) => void; part: "controls" | "details"; onCreateBrief?: (version: number) => void }) {
	const en = language === "en";
	const plan = state?.versions.at(-1);
	let selectedReport: { version: number; available: boolean } | undefined;
	try { const binding = JSON.parse(plan?.context ?? "{}").sourceReport; if (binding?.status === "selected") selectedReport = binding; } catch { /* Legacy text contexts have no report binding. */ }
	const generationBlocked = state && planBudgetBlock(state, true);
	const executionBlocked = state && planBudgetBlock(state);
	const running = !!plan && ["planning", "queued", "running"].includes(plan.status);
	if (part === "details" && !plan) return null;
	return <section className={part === "controls" ? "plan-controls" : "plan-panel"} aria-label={en ? "Execution plan" : "执行计划"}>
		{part === "controls" && <div className="plan-toolbar">
			<label>{en ? "Mode " : "处理方式 "}<select aria-label={en ? "Processing mode" : "处理方式"} value={state?.mode ?? "execute"} disabled={!state || busy || running} onChange={(e) => onCommand({ action: "mode", mode: e.target.value })}>
				<option value="execute">{en ? "Direct execution" : "直接执行"}</option>
				<option value="plan">{en ? "Plan · confirm before execution" : "先规划 · 确认后执行"}</option>
			</select></label>
			{plan && <span role="status">v{plan.version} · {labels[plan.status][en ? 1 : 0]}</span>}
		</div>}
		{part === "controls" && state?.mode === "plan" && <p>{en ? "Planning is read-only. Confirm the plan to execute." : "规划仅读取资料，确认计划后执行。"}</p>}
		{part === "details" && plan && <details open={state?.mode === "plan"}>
			<summary>{en ? "Plan and results" : "计划与结果"} · v{plan.version}</summary>
			<p>{plan.objective}</p>
			{selectedReport && <p>{en ? `Bound source report v${selectedReport.version} · Unverified; final results require source review. Direct requirement import is not enabled for report-backed plans.` : `绑定资料报告 v${selectedReport.version} · 未验证，最终结果仍需核对来源；此类计划暂不支持直接导入需求单。`}</p>}
			{state && <p>{en ? "Task limits: " : "本任务已使用："}{state.versions.length}/{PLAN_LIMITS.versions}{en ? " plan versions · " : " 个计划版本 · "}{state.versions.reduce((sum, p) => sum + p.calls, 0)}/{PLAN_LIMITS.totalCalls}{en ? " processing steps · " : " 次处理 · "}{state.consecutiveFailures ?? 0}/{PLAN_LIMITS.consecutiveFailures}{en ? " consecutive failures" : " 次连续失败"}</p>}
			{generationBlocked && <p role="alert">{executionBlocked ? en ? "This task has reached its failure or execution limit. Review existing results and resolve the cause before starting a new task. Replanning cannot reset this budget." : "本任务已达到连续失败或执行总量上限。请先核对已有结果并解决原因，再新建任务；重新规划不能重置预算。" : en ? "Plan-version limit reached. You can still confirm or resume the current plan within its execution budget; further plans need a new task." : "已达计划版本上限。执行预算充足时仍可确认或恢复当前计划；后续新计划需新建任务。"}</p>}
			{plan.replanFromVersion && <p>{en ? `Replanned from v${plan.replanFromVersion}; requires a new confirmation.` : `基于 v${plan.replanFromVersion} 重新规划，需重新确认。`}</p>}
			{plan.spec && <>
				<Markdown text={plan.spec.summary} language={language} />
				<ol>{plan.spec.tasks.map((task, index) => {
					const child = plan.children.find((c) => c.taskIndex === index);
					const needsReplan = child && (child.result.assessment?.decision === "replan" || !child.result.evidence.length);
					return <li key={index}><strong>{task.title}</strong> · {needsReplan ? en ? "Needs replanning" : "需要重新规划" : child ? en ? "Completed" : "已完成" : plan.activeTask === index && running ? en ? "Running" : "执行中" : en ? "Pending" : "待执行"}
						<p>{task.objective}</p><small>{en ? "Planned actions: " : "计划操作："}{task.tools.map((tool) => actionLabels[tool]?.[en ? 1 : 0] ?? (en ? "Other processing" : "其他处理")).join(en ? ", " : "、") || (en ? "No file or source operations" : "无需操作文件或资料")}</small>
						{!!task.dependsOn?.length && <p>{en ? "Uses results from: " : "使用以下任务的结果："}{task.dependsOn.map((dep) => `${dep + 1}. ${plan.spec!.tasks[dep].title}`).join(en ? ", " : "、")} · {en ? "Reports require verification" : "结果仍需核对"}</p>}
						{child && <div><Markdown text={child.result.summary} language={language} />
							<p>{en ? "Reported evidence · review required" : "执行依据 · 待核对"}</p><ul>{child.result.evidence.map((item, i) => <li key={i}>{item}</li>)}</ul>
							<p>{en ? "Limitations" : "限制与待确认事项"}</p><ul>{child.result.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul>
							{child.result.assessment && <p>{en ? "Progress review: " : "进度核对："}{child.result.assessment.reason}</p>}
						</div>}
					</li>;
				})}</ol>
			</>}
			{plan.failure && <p role="alert">{en ? "The task did not complete. " : "任务未完成。"}{errorText({ code: plan.failure.code }, language)}{!executionBlocked && plan.failure.retryable ? en ? " You can resume." : "可以恢复执行。" : en ? generationBlocked ? " Resolve the cause before starting a new task." : " Revise the task and generate a new plan." : generationBlocked ? "请先处理原因，再新建任务。" : "请修改任务并生成新计划。"}</p>}
			<div className="plan-actions">
				{["failed", "paused", "awaiting_confirmation"].includes(plan.status) && state?.mode === "plan" && <button disabled={busy || !!generationBlocked} onClick={() => onCommand({ action: "replan", version: plan.version })}>{en ? "Replan using current results" : "结合当前结果重新规划"}</button>}
				{plan.status === "completed" && onCreateBrief && !selectedReport && <button disabled={busy} onClick={() => onCreateBrief(plan.version)}>{en ? "Create requirement draft from results" : "将结果转为需求单草稿"}</button>}
				{plan.status === "awaiting_confirmation" && state?.mode === "plan" && <button disabled={busy || !!executionBlocked} onClick={() => onCommand({ action: "confirm", version: plan.version, confirmed: true })}>{en ? `Confirm v${plan.version} and execute` : `确认 v${plan.version} 并执行`}</button>}
				{running && <button disabled={busy} onClick={() => onCommand({ action: "pause", version: plan.version })}>{en ? "Pause" : "暂停"}</button>}
				{(plan.status === "paused" || plan.status === "failed" && plan.failure?.retryable) && plan.approval && state?.mode === "plan" && <button disabled={busy || !!executionBlocked} onClick={() => onCommand({ action: "resume", version: plan.version })}>{en ? "Resume approved plan" : "恢复已确认计划"}</button>}
				{!["completed", "cancelled", "superseded"].includes(plan.status) && <button disabled={busy} onClick={() => onCommand({ action: "cancel", version: plan.version })}>{en ? "Cancel plan" : "取消计划"}</button>}
			</div>
			{state && state.versions.length > 1 && <details><summary>{en ? "Previous versions" : "历史版本"}</summary>{state.versions.slice(0, -1).map((p) => <div key={p.version}><strong>v{p.version} · {labels[p.status][en ? 1 : 0]}</strong><p>{p.spec?.summary ?? p.objective}</p></div>)}</details>}
		</details>}
	</section>;
}
