import type { Page } from "@playwright/test";
import { createRequirementBrief } from "../../src/manufacturing/requirementBrief";
import type { RequirementDelivery } from "../../src/manufacturing/requirementDelivery";
import type { RequirementTemplateView } from "../../src/manufacturing/requirementTemplate";
import type { AssetInspectionRecord } from "../../src/runtime/assetInspection";
import type { ConversationAttachment, RequirementBriefWorkspaceView } from "../../src/runtime/conversationContracts";
import type { KnowledgeView } from "../../src/runtime/knowledgeView";
import type { ModelSettingsView } from "../../src/runtime/modelSettings";
import type { ModelTelemetryView } from "../../src/runtime/modelTelemetry";
import { expect, responses, test } from "./workspaceFixture";

const root = "/api/conversations/tutorial-fixture";
const digest = "0123456789abcdef".repeat(4);
const source: AssetInspectionRecord = {
	attachmentId: "attachment-abc", name: "Customer request.pdf", sha256: digest, sourceRef: "attachment://tutorial-fixture/attachment-abc", parserVersion: "1.3.0",
	inspection: { schemaVersion: "asset-inspection.v1", bytes: 1000, kind: "pdf", status: "parsed", truncated: false, pages: [{ page: 1, method: "ocr", text: "Original request: 5000 bags, 160 × 230 mm.", warnings: ["low_ocr_confidence", "future_parser_warning"] }] },
};
const attachment: ConversationAttachment = { attachmentId: source.attachmentId, name: source.name, conversationId: "tutorial-fixture", sourceRef: source.sourceRef, sha256: digest, mediaType: "application/pdf", size: 1000, kind: "file", modelInput: "metadata_only", createdAt: "2026-10-01T00:00:00Z" };
const delivery: RequirementDelivery = {
	schemaVersion: "requirement-delivery.v1", runId: "internal-run-id", version: 1, status: "draft", createdAt: attachment.createdAt,
	sources: [source], citations: { quantity: `${source.sourceRef}#page=1` },
	content: createRequirementBrief({ industry: "print", title: "Coffee bag requirements", customerGoal: "Prepare a packaging brief", facts: [{ key: "quantity", version: 1, value: 5000, status: "unverified", sourceType: "model_output", sourceRef: `${source.sourceRef}#page=1` }] }),
};
const template: RequirementTemplateView = { templateId: "template-internal", name: "Order template.docx", sha256: digest, format: "docx", slots: [{ key: "quantity", location: "word/document.xml#paragraph=0", context: "Order quantity: {{quantity}}" }] };
const knowledge: KnowledgeView = {
	documents: [], jobs: [], sources: [], coverage: [], unavailable: [], embedding: { kind: "local_model", signature: "internal-embedding-id" },
	review: { status: "unverified", questions: [], limitations: [], conflicts: [], comparisons: [], comparisonTruncated: false },
	hits: [{ evidenceId: "kb-internal-source", versionId: "internal-version", documentId: "internal-document", contentHash: digest, title: "Supplier pouch specification", publisher: "Sample supplier", model: "Pouch A", revision: "2026-10", sourceUrl: "https://example.test/source", provenance: "user_authorized", location: { section: "Materials", page: 1 }, text: "Sample supplier record: thickness 100 µm.", parameters: [{ name: "thickness", originalValue: "100", originalUnit: "µm", method: "Supplier measurement", conditions: "Room temperature", scope: "Film", authority: "supplier_claim", verification: "unverified" }], score: 1, warnings: ["candidate_not_verified", "effective_date_unknown", "unknown_source_warning"] }],
};

async function openPanel(page: Page, tab: string) {
	if (await page.locator(".review-toggle").getAttribute("aria-expanded") === "false") await page.locator(".review-toggle").click();
	await page.locator(`#tab-${tab}`).click();
}

async function expandDetails(page: Page, selector: string) {
	// Exercise all saved disclosures, including nested source and template panels.
	await page.locator(`${selector} details`).evaluateAll((details) => details.forEach((element) => (element as HTMLDetailsElement).open = true));
}

const technicalCopy = /SHA-?256|\bRSA\b|\bJSON\b|\bToken\b|\bRuntime\b|\bArtifact\b|\bHTTP\b|API Key|哈希|解析器|缓存|元数据|执行片|kb-internal|internal-run|future_parser_warning|unknown_source_warning|word\/document\.xml|attachment:\/\/|conversation:\/\//i;

test.beforeEach(async ({ page }) => {
	const workspace = structuredClone((responses[`${root}/requirement-brief`] as { requirementBrief: RequirementBriefWorkspaceView }).requirementBrief);
	workspace.state.currentProposal = { artifactId: "requirement-brief", version: 1, schemaVersion: "requirement-brief.v1", contentRef: "internal-content-ref", freshness: "fresh", inputFactVersions: { quantity: 1 }, runtimeExecutionId: "internal-execution" };
	workspace.state.proposalVersions = [workspace.state.currentProposal];
	workspace.artifact = { content: delivery.content };
	workspace.evaluation = { report: { schemaVersion: "requirement-brief-evaluation.v1", passed: false, approvalEligible: false, issues: [{ code: "missing_source", message: "Fact has no sourceRef" }] } };
	workspace.factSources = { quantity: { ref: source.sourceRef, label: source.name, text: source.inspection.pages[0].text, status: "available" } };
	const settings: ModelSettingsView = { revision: 1, mode: "anthropic", baseUrl: "https://example.test", model: "Sample model", keyConfigured: true, restartRequired: false };
	const monitor: ModelTelemetryView = { configuredModel: "Sample model", retentionLimit: 50, truncated: false, calls: [
		{ id: "internal-call", executionId: "internal-execution", model: "Sample model", kind: "generate", status: "failed", startedAt: attachment.createdAt, latencyMs: 1250, httpStatus: 503, failure: "unknown_internal_failure" },
		{ id: "internal-count", executionId: "internal-execution", model: "Sample model", kind: "count_tokens", status: "succeeded", startedAt: attachment.createdAt },
	] };
	const overrides: Record<string, unknown> = {
		[`${root}/requirement-brief`]: { requirementBrief: workspace },
		[`${root}/requirement-brief/versions/1`]: { delivery },
		[`${root}/requirement-brief/templates/${template.templateId}`]: { template },
		[`${root}/attachments`]: { attachments: [attachment] },
		[`${root}/knowledge`]: knowledge,
		[`${root}/model-calls`]: monitor,
		"/api/model-settings": settings,
	};
	await page.route("**/api/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (route.request().method() === "GET" && path in overrides) return route.fulfill({ json: overrides[path] });
		return route.fallback();
	});
	await page.addInitScript(({ templateId }) => localStorage.setItem("packx-template:tutorial-fixture", templateId), template);
	await page.goto("/");
	await expect(page.locator(".delivery-preview h3")).toHaveText("Coffee bag requirements");
});

test("brief, source, template and model details use customer language", async ({ page }, testInfo) => {
	await openPanel(page, "requirement");
	await expect(page.locator(".requirement-template")).toContainText(template.name);
	await expandDetails(page, "#panel-requirement");
	await expect(page.locator("#panel-requirement")).not.toContainText(technicalCopy);
	await expect(page.locator(".source-page pre").first()).toHaveText(source.inspection.pages[0].text);
	await expect(page.locator(".delivery-status")).toHaveText(/草稿|Draft/);
	await expect(page.locator(".source-list")).toContainText(/识别有误|read incorrectly/);
	await page.screenshot({ path: testInfo.outputPath("brief-copy.png") });
	await openPanel(page, "models");
	await expect(page.locator(".model-settings form")).toBeVisible();
	await expect(page.locator(".model-call")).toHaveCount(1);
	await expandDetails(page, "#panel-models");
	await expect(page.locator("#panel-models")).not.toContainText(technicalCopy);
	await expect(page.locator(".model-call")).toContainText(/操作失败|Operation failed/);
	await expect(page.getByLabel(/^(连接密钥|Access key)$/)).toHaveAttribute("type", "password");
	await page.screenshot({ path: testInfo.outputPath("model-copy.png") });
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("source import uses files and names, preserves requests, and rejects malformed packages", async ({ page }, testInfo) => {
	const commands: Array<{ action: string; payload: unknown }> = [];
	await page.route("**/knowledge/*", async (route) => {
		const action = new URL(route.request().url()).pathname.split("/").at(-1)!;
		if (route.request().method() !== "POST" || !["import", "parse-attachment"].includes(action)) return route.fallback();
		commands.push({ action, payload: route.request().postDataJSON() });
		await route.fulfill({ json: {} });
	});
	await openPanel(page, "knowledge");
	await expect(page.locator("#panel-knowledge")).toContainText("Supplier pouch specification");
	await expandDetails(page, "#panel-knowledge");
	await expect(page.locator("#panel-knowledge")).not.toContainText(technicalCopy);
	await expect(page.locator("#panel-knowledge")).toContainText(/待确认|Unconfirmed/);
	const upload = page.getByLabel(/^(选择资料包|Source package)$/);
	const importButton = page.getByRole("button", { name: /^(导入资料包|Import source package)$/ });
	await upload.setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("invalid JSON") });
	await expect(page.locator("#panel-knowledge [role=alert]")).toContainText(/无法读取|Cannot read/);
	await expect(importButton).toBeDisabled();
	expect(commands).toEqual([]);
	const manifest = { schemaVersion: "knowledge-import.v1", documentId: "package-id", permission: { storage: true, indexing: true }, blocks: [] };
	await upload.setInputFiles({ name: "Source package.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(manifest)) });
	await expect(importButton).toBeEnabled();
	await importButton.click();
	await expect.poll(() => commands.length).toBe(1);
	expect(commands[0]).toEqual({ action: "import", payload: manifest });
	const files = page.getByRole("combobox", { name: /^(读取已上传的文件（可选）|Read an uploaded file \(optional\))$/ });
	await expect(files.locator("option").last()).toHaveText(source.name);
	await files.selectOption(attachment.attachmentId);
	await page.getByRole("button", { name: /^(读取文件并核对|Read file for review)$/ }).click();
	await expect.poll(() => commands.length).toBe(2);
	expect(commands[1]).toEqual({ action: "parse-attachment", payload: { manifest, attachmentId: attachment.attachmentId } });
	await upload.setInputFiles({ name: "broken.json", mimeType: "application/json", buffer: Buffer.from("[]") });
	await expect(importButton).toBeDisabled();
	await expect(page.locator("#panel-knowledge")).not.toContainText(technicalCopy);
	await page.screenshot({ path: testInfo.outputPath("sources-copy.png") });
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});
