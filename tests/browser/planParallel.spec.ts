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
