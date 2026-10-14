import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { documentMethodText, documentWarningText, errorText, statusFor, validationText } from "./i18n";
import { RequirementSource } from "./components/RequirementSource";
import { PlanPanel } from "./components/PlanPanel";
import { Markdown } from "./components/Markdown";
import { createRequirementBrief } from "./manufacturing/requirementBrief";
import { deliveryHtml, deliveryMarkdown, type RequirementDelivery } from "./manufacturing/requirementDelivery";

it("renders bilingual export labels and leaves source facts intact", () => {
	const delivery: RequirementDelivery = { schemaVersion: "requirement-delivery.v1", runId: "r", version: 2, status: "draft", createdAt: "2026-09-07", sources: [], citations: {}, content: createRequirementBrief({ industry: "print", title: "Packaging", customerGoal: "Review customer request", facts: [{ key: "quantity", version: 1, value: 5000, status: "unverified", sourceType: "model_output", sourceRef: "attachment:a" }] }) };
	// Assumptions are source content, not UI labels.
	delivery.content.assumptions = [];
	for (const render of [deliveryHtml, deliveryMarkdown]) {
		const english = render(delivery, "en");
		expect(english).toContain("Quantity"); expect(english).toContain("Unverified"); expect(english).not.toMatch(/\p{Script=Han}/u);
		expect(render(delivery, "zh")).toContain("数量");
	}
	delivery.content.facts[0].value = "客户原文";
	expect(deliveryHtml(delivery, "en")).toContain("客户原文");
});
it("localizes errors and markdown controls in both directions", () => {
	const error = { code: "file_version_conflict" };
	const english = errorText(error, "en"); expect(english).toContain("changed"); expect(errorText(english, "zh")).toContain("文件已变化");
	expect(statusFor("en", "needs_ocr", "需要 OCR")).toBe("Text recognition needed");
	const text = "```\nexample\n```\n![reference](https://example.test/image.png)";
	const englishMarkup = renderToStaticMarkup(<Markdown text={text} language="en" />);
	expect(englishMarkup).toContain("Copy"); expect(englishMarkup).toContain("Image: "); expect(englishMarkup).not.toMatch(/\p{Script=Han}/u);
	expect(renderToStaticMarkup(<Markdown text={text} language="zh" />)).toContain("复制");
});
it("keeps unconditional Chinese JSX labels out of bilingual UI components", () => {
	const paths = ["src/App.tsx", ...readdirSync("src/components").filter((name) => name.endsWith(".tsx") && !name.includes(".test.")).map((name) => `src/components/${name}`)];
	const untranslated: string[] = [];
	for (const path of paths) {
		const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
		function walk(node: ts.Node) {
			if (ts.isJsxText(node) && /\p{Script=Han}/u.test(node.text)) untranslated.push(`${path}: ${node.text.trim()}`);
			if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) && /\p{Script=Han}/u.test(node.initializer.text)) untranslated.push(`${path}: ${node.initializer.text}`);
			ts.forEachChild(node, walk);
		}
		walk(source);
	}
	expect(untranslated).toEqual([]);
});

it("shows review guidance without exposing service codes or changing source text", () => {
	for (const language of ["zh", "en"] as const) {
		for (const error of [{ code: "unknown_internal_failure", message: "RSA sha256:private-details" }, new Error("unknown_internal_failure")]) {
			expect(errorText(error, language)).not.toMatch(/unknown_internal_failure|RSA|sha256/);
		}
		expect(errorText({ code: "memory_revision_conflict" }, language)).toMatch(/最新|latest/);
		expect(validationText({ code: "missing_source", message: "Fact quantity has no sourceRef" }, language)).toMatch(/来源|source/);
		expect(validationText({ code: "future_schema_error", message: "Invalid JSON payload" }, language)).not.toMatch(/schema|JSON|payload/);
		expect(documentWarningText("low_ocr_confidence", language)).toMatch(/核对|Review/);
		expect(documentWarningText("future_parser_warning", language)).not.toContain("future_parser_warning");
		expect(documentMethodText("text+ocr", language)).not.toContain("ocr");
		const ref = "attachment://internal-id/sha256:0123456789";
		const text = "Original customer wording: RSA / 5000 bags";
		const markup = renderToStaticMarkup(<RequirementSource en={language === "en"} source={{ ref, label: "customer.txt", text, status: "available" }} />);
		expect(markup).toContain(text);
		expect(markup).toContain("customer.txt");
		expect(markup).not.toContain(ref);
		expect(renderToStaticMarkup(<RequirementSource en={language === "en"} source={{ ref, label: ref, status: "unavailable" }} />)).not.toContain(ref);
		const plan = renderToStaticMarkup(<PlanPanel part="details" language={language} busy={false} onCommand={() => {}} state={{ revision: 1, mode: "plan", versions: [{ version: 1, objective: "Review the document", context: "", conversationRevision: 1, status: "awaiting_confirmation", createdAt: "2026-10-12", actorId: "staff", generation: 1, calls: 0, children: [], spec: { summary: "Review before execution", tasks: [{ title: "Update the files", objective: "Review the requested file changes", tools: ["file_write", "file_delete"] }] } }] }} />);
		expect(plan).toMatch(/需另行批准|separate approval required/);
		expect(plan).not.toMatch(/file_write|file_delete/);
	}
});
