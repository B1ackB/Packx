import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { createRequirementBrief } from "../../src/manufacturing/requirementBrief";
import type { RequirementDelivery } from "../../src/manufacturing/requirementDelivery";
import { RequirementTemplateService } from "./requirementTemplate";
import { fillTemplate, inspectTemplate, readOfficeZip, writeOfficeZip } from "../runtime/officeTemplate";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const scope = { tenantId: "t", workspaceId: "w", runId: "r" };
function setup() {
	const root = mkdtempSync(join(tmpdir(), "packx-template-")); roots.push(root);
	const artifacts = new FileArtifactContentStore(root);
	return { artifacts, service: new RequirementTemplateService(artifacts, () => "2026-10-01T00:00:00Z") };
}
function delivery(): RequirementDelivery {
	return { schemaVersion: "requirement-delivery.v1", runId: "r", version: 1, status: "draft", createdAt: "2026-10-01T00:00:00Z", sources: [], citations: {}, content: createRequirementBrief({ industry: "print", title: "包装需求通知", customerGoal: "整理包装需求", facts: [{ key: "quantity", version: 1, value: 7200, unit: "个", status: "unverified", sourceType: "model_output", sourceRef: "customer:1" }] }) };
}
for (const format of ["docx", "xlsx"]) it(`imports an original ${format} template, maps a custom field, persists and recovers immutable output`, () => {
	const { artifacts, service } = setup(); const bytes = readFileSync(`public/templates/packaging-notice.${format}`);
	const template = service.upload(scope, "user", `my-template.${format}`, bytes);
	const mapping = Object.fromEntries(template.slots.map(({ key }) => [key, key === "notice_title" ? "title" : key]));
	const d = delivery(), preview = service.preview(scope, template.templateId, d, mapping);
	expect(preview.errors).toEqual([]); expect(preview.values.quantity).toContain("UNVERIFIED"); expect(preview.values.dimensions).toContain("MISSING");
	expect(() => service.generate(scope, "user", template.templateId, d, { mapping, reviewHash: preview.reviewHash })).toThrow();
	const input = { mapping, reviewHash: preview.reviewHash, confirmed: true };
	const output = service.generate(scope, "user", template.templateId, d, input);
	const restarted = new RequirementTemplateService(artifacts);
	expect(restarted.generate(scope, "user", template.templateId, d, input)).toEqual(output);
	const result = restarted.download(scope, output.exportId, d), parts = readOfficeZip(result.data), original = readOfficeZip(bytes);
	const xml = [...parts.values()].map((part) => part.toString()).join("\n");
	expect(xml).toContain("7200"); expect(xml).toContain("DRAFT"); expect(xml).not.toContain("{{");
	for (const [name, data] of original) if (!/document.xml|header\d|footer\d|worksheets\/|sharedStrings|workbook.xml$/.test(name)) expect(parts.get(name)).toEqual(data);
	expect(() => restarted.view({ ...scope, tenantId: "other" }, template.templateId)).toThrow();
	expect(() => restarted.download(scope, output.exportId, { ...d, status: "stale" })).toThrow();
	expect(() => restarted.download(scope, output.exportId, { ...d, status: "approved", approval: { approvalId: "new", artifactVersion: 1 } })).toThrow();
	const changed = structuredClone(d); changed.content.facts[0].value = 8300;
	expect(() => restarted.generate(scope, "user", template.templateId, changed, input)).toThrow();
	expect(service.preview(scope, template.templateId, d, {}).errors.length).toBeGreaterThan(0);
	expect(() => service.generate(scope, "user", template.templateId, d, { ...input, mapping: { ...mapping, quantity: "dimensions" } })).toThrow();
});

it("refuses corrupt, oversized, no-placeholder, active content and dangerous formulas; preserves safe formulas without cached values", () => {
	const bytes = readFileSync("public/templates/packaging-notice.xlsx"), parts = readOfficeZip(bytes);
	expect(() => inspectTemplate(Buffer.from("broken"), "test.xlsx")).toThrow();
	expect(() => inspectTemplate(Buffer.alloc(6 * 1024 * 1024), "test.xlsx")).toThrow();
	const sheet = "xl/worksheets/sheet1.xml", original = parts.get(sheet)!.toString();
	parts.set(sheet, Buffer.from(original.replace(/\{\{.*?\}\}/g, "")));
	expect(() => inspectTemplate(writeOfficeZip(parts), "test.xlsx")).toThrow("占位符");
	parts.set(sheet, Buffer.from(original)); parts.set("xl/vbaProject.bin", Buffer.from("macro"));
	expect(() => inspectTemplate(writeOfficeZip(parts), "test.xlsx")).toThrow(); parts.delete("xl/vbaProject.bin");
	for (const formula of ['WEBSERVICE(&quot;https://example.com&quot;)', "[other.xlsx]A1", 'HYPERLINK(&quot;https://example.com&quot;)', "SUM(A1:A2)"]) {
		parts.set(sheet, Buffer.from(original.replace('</x:sheetData>', `<x:row r="20"><x:c r="B20"><x:f>${formula}</x:f><x:v>999</x:v></x:c></x:row></x:sheetData>`)));
		if (formula !== "SUM(A1:A2)") expect(() => inspectTemplate(writeOfficeZip(parts), "test.xlsx")).toThrow();
		else {
			const template = inspectTemplate(writeOfficeZip(parts), "test.xlsx");
			const filled = readOfficeZip(fillTemplate(template, Object.fromEntries(template.slots.map((slot) => [slot.key, "=literal; not a formula"]))));
			expect(filled.get(sheet)!.toString()).toContain('<x:f>SUM(A1:A2)</x:f>'); expect(filled.get(sheet)!.toString()).not.toContain('999');
			expect(filled.get("xl/workbook.xml")!.toString()).toContain('fullCalcOnLoad="1"');
		}
	}
	parts.set(sheet, Buffer.from(original)); parts.set("evil.xml", Buffer.from('<!DOCTYPE a [<!ENTITY a SYSTEM "file:///etc/passwd">]><a>&a;</a>'));
	expect(() => inspectTemplate(writeOfficeZip(parts), "test.xlsx")).toThrow();
	const word = readOfficeZip(readFileSync("public/templates/packaging-notice.docx"));
	word.set("word/field.xml", Buffer.from('<q:instrText xmlns:q="http://schemas.openxmlformats.org/wordprocessingml/2006/main">DDEAUTO example</q:instrText>'));
	expect(() => inspectTemplate(writeOfficeZip(word), "test.docx")).toThrow();
});
