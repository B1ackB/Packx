import { test, expect } from "./workspaceFixture";

test("shows the Windows text-only scope and restricts the file picker", async ({ page }) => {
	await page.route("**/api/runtime/health", (route) => route.fulfill({ json: { adapter: "blackx-agent", online: true, documents: { scope: "windows-utf8", components: "present", extensions: ["txt", "md", "csv", "json"], maxBytes: 131072, isolationVerification: "per-execution" } } }));
	await page.goto("/");
	await expect(page.locator(".document-capability")).toContainText("128");
	await expect(page.locator(".document-capability")).toContainText("PDF");
	await expect(page.locator('input[type="file"]')).toHaveAttribute("accept", ".txt,.md,.csv,.json");
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});
test("shows missing document components separately from a configured model", async ({ page }) => {
	await page.route("**/api/runtime/health", (route) => route.fulfill({ json: { adapter: "blackx-agent", online: true, documents: { scope: "windows-utf8", components: "missing", extensions: ["txt", "md", "csv", "json"], maxBytes: 131072, isolationVerification: "per-execution" } } }));
	await page.goto("/");
	await expect(page.locator(".document-capability")).toContainText(/missing|缺少/);
});
