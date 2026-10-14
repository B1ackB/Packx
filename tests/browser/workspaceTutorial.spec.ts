import type { Page } from "@playwright/test";
import { expect, test } from "./workspaceFixture";

const dialog = (page: Page) => page.getByRole("dialog");
const next = (page: Page) => dialog(page).getByRole("button", { name: /^(下一步|Next)$/ });
const previous = (page: Page) => dialog(page).getByRole("button", { name: /^(上一步|Previous)$/ });
const exit = (page: Page) => dialog(page).getByRole("button", { name: /^(退出教程|Exit tutorial)$/ });
const topEntry = (page: Page) => page.locator(".topbar .tutorial-trigger");
const entry = (page: Page) => page.viewportSize()!.width < 1180 ? page.locator(".tutorial-panel-trigger") : topEntry(page);

async function expectStep(page: Page, step: number) {
	await expect(dialog(page)).toBeVisible();
	await expect(page.locator("dialog:modal")).toHaveCount(1);
	await expect(dialog(page).locator(".tutorial-meta span")).toContainText(`${step} / 7`);
	await expect(dialog(page).getByRole("heading")).toBeFocused();
	await expect(dialog(page).locator(".tutorial-card")).toBeInViewport({ ratio: 1 });
}

async function openWorkspace(page: Page) {
	if (await page.locator(".review-toggle").getAttribute("aria-expanded") === "false") await page.locator(".review-toggle").click();
	await expect(page.locator(".review-toggle")).toHaveAttribute("aria-expanded", "true");
}

test.beforeEach(async ({ page }) => {
	await page.goto("/");
	await expect(page.locator(".composer textarea")).toBeEnabled();
	await expect(page.locator(".fact-row")).toHaveCount(1);
});

for (const method of ["exit button", "Escape", "Finish"] as const) {
	test(`${method} restores the visible entry, original panel, and unsaved inputs`, async ({ page }) => {
		const sidebar = page.getByRole("button", { name: /^(切换会话侧栏|Toggle conversation sidebar)$/ });
		const sidebarWasOpen = await sidebar.getAttribute("aria-expanded");
		const composer = page.locator(".composer textarea");
		await composer.fill("Unsent customer follow-up\nKeep this draft.");
		await openWorkspace(page);
		const field = page.getByRole("combobox", { name: /^(需求字段|Requirement field)$/ });
		const value = page.locator("#requirement-fact-value");
		const unit = page.getByRole("textbox", { name: /^(字段单位|Field unit)$/ });
		await field.selectOption("quantity");
		await value.fill("6500");
		await unit.fill("bags");
		// The source step must temporarily reveal and later restore both details panels.
		const facts = page.locator("details.facts-card");
		await facts.locator(":scope > summary").click();
		await expect(facts).not.toHaveAttribute("open");
		await page.locator("#tab-memory").click();
		const topic = page.getByRole("textbox", { name: /^(主题|Topic)$/ });
		const note = page.getByRole("textbox", { name: /^(偏好或笔记|Preference or note)$/ });
		const expiry = page.getByLabel(/^(有效期（可选）|Expiry \(optional\))$/);
		await topic.fill("Unsubmitted preference");
		await note.fill("Keep the original sources.\nList open questions separately.");
		await expiry.fill("2099-12-31");

		await entry(page).click();
		await expectStep(page, 1);
		await expect(page.locator(".review-toggle")).toHaveAttribute("aria-expanded", "false");
		await expect(previous(page)).toBeDisabled();
		await next(page).click();
		await expectStep(page, 2);
		await expect(page.locator(".review-toggle")).toHaveAttribute("aria-expanded", "true");
		await expect(page.locator("#tab-requirement")).toHaveAttribute("aria-selected", "true");
		await next(page).click();
		await expectStep(page, 3);
		await expect(facts).toHaveAttribute("open", "");
		await expect(page.locator("details.fact-source")).toHaveAttribute("open", "");
		if (method === "exit button") await exit(page).click();
		else if (method === "Escape") await page.keyboard.press("Escape");
		else {
			for (let step = 4; step <= 7; step++) {
				await next(page).click();
				await expectStep(page, step);
			}
			await dialog(page).getByRole("button", { name: /^(完成|Finish)$/ }).click();
		}

		await expect(dialog(page)).toHaveCount(0);
		await expect(page.locator(".review-toggle")).toHaveAttribute("aria-expanded", "true");
		await expect(page.locator("#tab-memory")).toHaveAttribute("aria-selected", "true");
		await expect(page.locator("#panel-memory")).toBeVisible();
		await expect(sidebar).toHaveAttribute("aria-expanded", sidebarWasOpen!);
		await expect(entry(page)).toBeVisible();
		await expect(entry(page)).toBeFocused();
		await expect(topic).toHaveValue("Unsubmitted preference");
		await expect(note).toHaveValue("Keep the original sources.\nList open questions separately.");
		await expect(expiry).toHaveValue("2099-12-31");
		await expect(composer).toHaveValue("Unsent customer follow-up\nKeep this draft.");
		await page.locator("#tab-requirement").click();
		await expect(facts).not.toHaveAttribute("open");
		await expect(page.locator("details.fact-source")).not.toHaveAttribute("open");
		await facts.locator(":scope > summary").click();
		await expect(field).toHaveValue("quantity");
		await expect(value).toHaveValue("6500");
		await expect(unit).toHaveValue("bags");
		await entry(page).click();
		await expectStep(page, 1);
		await exit(page).click();
		await expect(entry(page)).toBeFocused();
	});
}

test("keyboard focus stays in the tutorial and step navigation switches panels in both directions", async ({ page }) => {
	await topEntry(page).click();
	await expectStep(page, 1);
	await page.keyboard.press("ArrowLeft");
	await expectStep(page, 1);
	await page.keyboard.press("Tab");
	await expect(exit(page)).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(next(page)).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(exit(page)).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expectStep(page, 2);
	await expect(page.locator("#tab-requirement")).toHaveAttribute("aria-selected", "true");
	await expect(page.locator(".review-toggle")).toHaveAttribute("aria-expanded", "true");
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	await expect(previous(page)).toBeFocused();
	await previous(page).click();
	await expectStep(page, 1);
	await expect(page.locator(".review-toggle")).toHaveAttribute("aria-expanded", "false");
	await page.keyboard.press("Escape");
	await expect(topEntry(page)).toBeFocused();
});

test("an initially closed workspace and conversation sidebar stay closed after exiting", async ({ page }) => {
	const sidebar = page.getByRole("button", { name: /^(切换会话侧栏|Toggle conversation sidebar)$/ });
	if (await sidebar.getAttribute("aria-expanded") === "true") await sidebar.click();
	if (await page.locator(".review-toggle").getAttribute("aria-expanded") === "true") await page.locator(".review-toggle").click();
	await topEntry(page).click();
	await expectStep(page, 1);
	await next(page).click();
	await expectStep(page, 2);
	await expect(page.locator(".review-toggle")).toHaveAttribute("aria-expanded", "true");
	await page.keyboard.press("Escape");
	await expect(dialog(page)).toHaveCount(0);
	await expect(page.locator(".review-toggle")).toHaveAttribute("aria-expanded", "false");
	await expect(sidebar).toHaveAttribute("aria-expanded", "false");
	await expect(topEntry(page)).toBeFocused();
});

test("source details that were already open remain open after visiting and leaving the source step", async ({ page }) => {
	await openWorkspace(page);
	await page.locator('[data-tour="source"]').click();
	await entry(page).click();
	await expectStep(page, 1);
	await next(page).click();
	await expectStep(page, 2);
	await next(page).click();
	await expectStep(page, 3);
	await previous(page).click();
	await expectStep(page, 2);
	await expect(page.locator("details.fact-source")).toHaveAttribute("open", "");
	await page.keyboard.press("Escape");
	await expect(page.locator("details.facts-card")).toHaveAttribute("open", "");
	await expect(page.locator("details.fact-source")).toHaveAttribute("open", "");
	await expect(entry(page)).toBeFocused();
});
