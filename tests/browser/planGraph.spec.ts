import type { PlanWorkspace } from "../../src/enterprise/agentPlan";
import { expect, test } from "./workspaceFixture";

const state: PlanWorkspace = { revision: 3, mode: "plan", versions: [{
	version: 1, objective: "Read customer sources, then prepare a sourced comparison", context: JSON.stringify({ sourceReport: { status: "selected", version: 1, available: true } }), conversationRevision: 1, status: "awaiting_confirmation", createdAt: "2026-10-18T00:00:00Z", actorId: "fixture", generation: 1, calls: 1, children: [],
	spec: { summary: "Review the proposed sources and dependency before execution", tasks: [
		{ title: "Prepare comparison", objective: "Use the selected source report", tools: [], dependsOn: [1] },
		{ title: "Review customer source", objective: "Read the original attachment", tools: ["file_read"] },
	] },
}] };

test("shows prerequisite reports before plan confirmation in both languages", async ({ page, locale }, testInfo) => {
	await page.route("**/api/conversations/tutorial-fixture/plan", (route) => route.fulfill({ json: { plan: state } }));
	await page.goto("/");
	const panel = page.locator(".plan-panel");
	await expect(panel).toContainText(locale === "en-US" ? "Uses results from: 2. Review customer source" : "使用以下任务的结果：2. Review customer source");
	await expect(panel).toContainText(locale === "en-US" ? "Reports require verification" : "结果仍需核对");
	await expect(panel).toContainText(locale === "en-US" ? "Bound source report v1" : "绑定资料报告 v1");
	await expect(panel.getByRole("button", { name: locale === "en-US" ? "Confirm v1 and execute" : "确认 v1 并执行", exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("plan-dependencies.png"), fullPage: true });
});
