import type { SourceReportArtifact, SourceReportView } from "../../src/enterprise/sourceReport";
import { expect, test } from "./workspaceFixture";
const path = "/api/conversations/tutorial-fixture/source-reports";
const source = { schemaVersion: "source-snapshot.v1" as const, kind: "web" as const, name: "Supplier reference", requestedRef: "https://docs.example.test/spec", sourceRef: "https://docs.example.test/spec", sha256: "a".repeat(64), textSha256: "b".repeat(64), capturedAt: "2026-10-18T00:00:00Z", bytes: 80, truncated: false };
const artifact: SourceReportArtifact = { schemaVersion: "source-report.v1", version: 1, title: "Source comparison", status: "unverified", createdAt: source.capturedAt, sources: [{ ...source, snapshotRef: "artifact://source-report-1-source-0/v1", excerpt: "Supplier claims 100 um. Customer asks for 90 um.", excerptTruncated: false }], limitations: ["Unverified excerpts"] };
test("creates, reads and downloads a source report, then cancels new work without changing history", async ({ page, locale }, testInfo) => {
	const en = locale === "en-US";
	let view: SourceReportView = { revision: 0, allowedWebDomains: ["docs.example.test"], versions: [] };
	await page.route("**/api/conversations/tutorial-fixture/source-reports**", async route => {
		const req = route.request(), url = new URL(req.url());
		if (url.pathname === `${path}/1/sources/0`) return route.fulfill({ json: { ...source, text: "Saved original: supplier 100 um; customer 90 um. <script>must remain plain text</script>" } });
		if (url.pathname === `${path}/1`) return route.fulfill({ json: artifact });
		if (req.method() === "POST") {
			const body = req.postDataJSON(); expect(body.revision).toBe(view.revision);
			if (body.action === "start") {
				expect(body.inputs).toEqual([{ kind: "web", url: "https://docs.example.test/spec" }]);
				const version = view.versions.length + 1;
				view = { ...view, revision: view.revision + 1, versions: [...view.versions, { version, title: body.title, actorId: "fixture", createdAt: source.capturedAt, inputs: body.inputs, status: version === 1 ? "completed" : "running", generation: 1, attempts: 1, captured: version === 1 ? [{ index: 0, digest: "a".repeat(64) }] : [], available: true }] };
			} else if (body.action === "select") { view = { ...view, revision: view.revision + 1, selectedVersion: body.version ?? undefined, selectionRevision: view.revision + 1 };
			} else { expect(body.action).toBe("cancel"); view = { ...view, revision: view.revision + 1, versions: view.versions.map(v => v.version === body.version ? { ...v, status: "cancelled" } : v) }; }
		}
		return route.fulfill({ json: view });
	});
	await page.goto("/");
	if (await page.locator(".review-toggle").getAttribute("aria-expanded") === "false") await page.locator(".review-toggle").click();
	await page.locator("#tab-reports").click();
	const panel = page.locator("#panel-reports");
	await panel.getByLabel(en ? "Report title" : "报告名称", { exact: true }).fill("Source comparison");
	await panel.getByLabel(en ? "Web pages, one HTTPS URL per line" : "网页地址，每行一个 HTTPS 链接", { exact: true }).fill("https://docs.example.test/spec");
	await panel.getByRole("button", { name: en ? "Create source report" : "生成资料报告", exact: true }).click();
	await panel.getByRole("button", { name: en ? "Use v1 in tasks" : "将 v1 用于任务", exact: true }).click();
	await expect(panel).toContainText(en ? "Selected for tasks: v1" : "任务所选资料：v1");
	await panel.getByRole("button", { name: en ? "Read report" : "查看报告", exact: true }).click();
	await expect(panel.locator(".source-report-preview")).toContainText(/100 um/);
	await panel.getByRole("button", { name: en ? "Read saved source" : "查看保存的原文" }).click();
	await expect(panel.locator("pre").last()).toContainText("<script>must remain plain text</script>");
	const downloadEvent = page.waitForEvent("download"); await panel.getByRole("button", { name: en ? "Download report" : "下载报告", exact: true }).click();
	expect((await downloadEvent).suggestedFilename()).toBe("source-report-v1.json");
	await panel.getByRole("button", { name: en ? "Create source report" : "生成资料报告", exact: true }).click();
	await panel.getByRole("button", { name: en ? "Cancel collection" : "取消读取", exact: true }).click();
	await expect(panel).toContainText(en ? "Cancelled" : "已取消");
	expect(view.versions[0].status).toBe("completed"); expect(view.selectedVersion).toBe(1);
	await panel.getByRole("button", { name: en ? "Clear report selection" : "取消报告选择", exact: true }).click();
	expect(view.selectedVersion).toBeUndefined();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("source-report-workspace.png"), fullPage: true });
});
