import type { PlanWorkspace, PlanTaskRun } from "../../src/enterprise/agentPlan";
import { expect, test } from "./workspaceFixture";

const run = (taskIndex: number): PlanTaskRun => ({ taskIndex, attempt: 1, generation: 2, jobId: "fixture", leaseId: "fixture-lease", sessionId: `fixture-${taskIndex}`, idempotencyKey: `fixture-${taskIndex}`, status: "running", startedAt: "2026-10-19T00:00:00Z" });
const state: PlanWorkspace = { revision: 5, mode: "plan", versions: [{
	version: 1, objective: "Compare packaging sources", context: "{}", conversationRevision: 1, status: "running", actorId: "fixture", createdAt: "2026-10-19T00:00:00Z", generation: 2, calls: 3, children: [], readConcurrency: 2, taskRuns: [run(1), run(2)],
	approval: { actorId: "fixture", version: 1, at: "2026-10-19T00:00:00Z" },
	spec: { summary: "Read independent source claims, then combine results", tasks: [
		{ title: "Combine", objective: "Use declared reports", tools: [], dependsOn: [1, 2] },
		{ title: "Source A", objective: "Read selected source", tools: ["source_report_read"] },
		{ title: "Source B", objective: "Read selected source", tools: ["source_report_read"] },
	] },
}] };

test("shows both active nodes, the waiting dependency and the confirmed concurrency limit", async ({ page, locale }, testInfo) => {
	await page.route("**/api/conversations/tutorial-fixture/plan", route => route.fulfill({ json: { plan: state } }));
	await page.goto("/"); const panel = page.locator(".plan-panel"), en = locale === "en-US";
	for (const index of [1, 2]) await expect(panel.locator(`[data-plan-task="${index}"]`)).toContainText(en ? "Running" : "执行中");
	await expect(panel.locator('[data-plan-task="0"]')).toContainText(en ? "Waiting for prerequisite results" : "等待上游结果");
	await expect(panel).toContainText(en ? "Up to two independent read-only tasks" : "只读任务最多两项同时处理");
	await expect(panel).toContainText(en ? "Processing limits are not a price cap" : "处理次数限制不代表费用上限");
	await expect(panel.getByRole("button", { name: en ? "Pause" : "暂停", exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("parallel-running.png"), fullPage: true });
});

test("retains a completed node and exposes the failed node reason and explicit recovery", async ({ page, locale }, testInfo) => {
	const failed = structuredClone(state), plan = failed.versions[0]; plan.status = "failed"; plan.failure = { code: "rate_limit", retryable: true };
	plan.children = [{ taskIndex: 1, sessionId: "fixture-1", executionId: "fixture-result", result: { summary: "Source claim remains unverified", evidence: ["fixture source"], limitations: ["Review required"], assessment: { decision: "continue", reason: "Read complete" } } }];
	plan.taskRuns![0].status = "completed"; plan.taskRuns![1].status = "failed"; plan.taskRuns![1].failure = plan.failure;
	await page.route("**/api/conversations/tutorial-fixture/plan", route => route.fulfill({ json: { plan: failed } }));
	await page.goto("/"); const panel = page.locator(".plan-panel"), en = locale === "en-US";
	await expect(panel.locator('[data-plan-task="1"]')).toContainText(en ? "Completed" : "已完成");
	await expect(panel.locator('[data-plan-task="2"]')).toContainText(en ? "Failed" : "执行失败");
	await expect(panel.locator('[data-plan-task="2"]')).toContainText(en ? "model service is temporarily busy" : "模型服务暂时繁忙");
	await expect(panel.getByRole("button", { name: en ? "Resume approved plan" : "恢复已确认计划", exact: true })).toBeVisible();
	await panel.getByRole("button", { name: en ? "Resume approved plan" : "恢复已确认计划", exact: true }).scrollIntoViewIfNeeded();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("parallel-recovery.png"), fullPage: true });
});


test("explains source invalidation, retains history and requires a newly confirmed plan", async ({ page, locale }, testInfo) => {
	const invalidated = structuredClone(state), plan = invalidated.versions[0];
	plan.status = "failed"; plan.failure = { code: "plan_sources_changed", retryable: false };
	plan.children = [{ taskIndex: 1, sessionId: "fixture-1", executionId: "fixture-result", result: { summary: "Historical source claim remains unverified", evidence: ["fixture source"], limitations: ["Source selection changed"], assessment: { decision: "continue", reason: "Read complete before source change" } } }];
	plan.taskRuns![0].status = "completed";
	plan.taskRuns![1].status = "interrupted"; plan.taskRuns![1].failure = plan.failure;
	await page.route("**/api/conversations/tutorial-fixture/plan", route => route.fulfill({ json: { plan: invalidated } }));
	await page.goto("/"); const panel = page.locator(".plan-panel"), en = locale === "en-US";
	await expect(panel.getByRole("alert")).toContainText(en ? "sources or selected report changed" : "任务资料或所选报告已变化");
	await expect(panel.getByRole("alert")).toContainText(en ? "Review retained results" : "保留结果仅供核对");
	await expect(panel.locator('[data-plan-task="1"]')).toContainText(en ? "Completed" : "已完成");
	await expect(panel.locator('[data-plan-task="2"]')).toContainText(en ? "Stopped" : "已停止");
	await expect(panel.getByRole("button", { name: en ? "Resume approved plan" : "恢复已确认计划", exact: true })).toHaveCount(0);
	await expect(panel.getByRole("button", { name: en ? "Replan using current results" : "结合当前结果重新规划", exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
	await panel.getByRole("button", { name: en ? "Replan using current results" : "结合当前结果重新规划", exact: true }).scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("parallel-source-invalidated.png"), fullPage: true });
});


test("checks saved results at the execution limit without enabling resume or changing the call counter", async ({ page, locale }) => {
	const saved = structuredClone(state), plan = saved.versions[0], en = locale === "en-US";
	plan.status = "failed"; plan.calls = 16; plan.failure = { code: "plan_budget_exceeded", retryable: true };
	for (const run of plan.taskRuns!) { run.status = "interrupted"; run.failure = plan.failure; }
	let commands = 0;
	await page.route("**/api/conversations/tutorial-fixture/plan", async route => {
		if (route.request().method() === "POST") {
			const command = route.request().postDataJSON();
			expect(command).toMatchObject({ action: "reconcile", version: 1, revision: 5 }); commands++;
			plan.status = "completed"; delete plan.failure; saved.revision++;
			plan.children = plan.spec!.tasks.map((_, taskIndex) => ({ taskIndex, sessionId: `saved-${taskIndex}`, executionId: `saved-${taskIndex}`, result: { summary: "Saved unverified result", evidence: ["saved fixture"], limitations: ["Review required"] } }));
			for (const run of plan.taskRuns!) { run.status = "completed"; delete run.failure; }
		}
		await route.fulfill({ json: { plan: saved } });
	});
	await page.goto("/"); const panel = page.locator(".plan-panel");
	await expect(panel.getByRole("button", { name: en ? "Resume approved plan" : "恢复已确认计划", exact: true })).toBeDisabled();
	const reconcile = panel.getByRole("button", { name: en ? "Check saved results · no model requests" : "核对已保存结果 · 不发起模型请求", exact: true });
	await expect(reconcile).toBeEnabled(); await reconcile.click();
	await expect(page.locator(".plan-controls")).toContainText(en ? "Completed; review results" : "执行完成，结果待核对");
	await expect(panel).toContainText("16/32"); expect(commands).toBe(1);
});

test("offers an unverified requirement draft for completed report-backed plans and explains its dependency", async ({ page, locale }) => {
	const completed = structuredClone(state), plan = completed.versions[0], en = locale === "en-US";
	plan.status = "completed"; plan.context = JSON.stringify({ sourceReport: { status: "selected", version: 1, available: true } });
	await page.route("**/api/conversations/tutorial-fixture/plan", route => route.fulfill({ json: { plan: completed } }));
	await page.goto("/"); const panel = page.locator(".plan-panel");
	await expect(panel).toContainText(en ? "Import creates an unverified draft" : "导入只创建未验证草稿");
	await expect(panel).toContainText(en ? "keeps this report version as a dependency" : "保留此报告版本作为依赖");
	await expect(panel.getByRole("button", { name: en ? "Create requirement draft from results" : "将结果转为需求单草稿", exact: true })).toBeEnabled();
});
