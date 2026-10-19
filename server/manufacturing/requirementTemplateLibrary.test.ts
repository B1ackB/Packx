import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { createRequirementBrief } from "../../src/manufacturing/requirementBrief";
import type { RequirementDelivery } from "../../src/manufacturing/requirementDelivery";
import { RequirementTemplateService } from "./requirementTemplate";
import { RequirementTemplateLibrary } from "./requirementTemplateLibrary";
import { inspectTemplate, readOfficeZip, writeOfficeZip } from "../runtime/officeTemplate";
const roots: string[] = [], stores: RequirementTemplateLibrary[] = [];
const scope = { tenantId: "t", workspaceId: "w", runId: "r1", actorId: "a" };
afterEach(() => { stores.splice(0).forEach((store) => store.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
function setup(format = "docx") {
	const root = mkdtempSync(join(tmpdir(), "packx-library-")); roots.push(root);
	const artifacts = new FileArtifactContentStore(join(root, "artifacts")), path = join(root, "library.sqlite");
	const library = new RequirementTemplateLibrary(path); stores.push(library);
	const allowed = new Set(["conversation-1", "conversation-2"]), canRead = (id: string) => allowed.has(id);
	const service = new RequirementTemplateService(artifacts, undefined, { store: library, actorId: scope.actorId, canRead });
	const data = readFileSync(`public/templates/packaging-notice.${format}`), template = service.upload(scope, "a", `notice.${format}`, data);
	const mapping = Object.fromEntries(template.slots.map(({ key }) => [key, key === "notice_title" ? "title" : key]));
	const input = { name: "客户 A 通知", description: "售前通知", mapping, requestId: "save-1" };
	return { root, path, artifacts, library, allowed, canRead, service, data, template, mapping, input };
}
function delivery(runId = "r1", quantity = 7200): RequirementDelivery {
	return { schemaVersion: "requirement-delivery.v1", runId, version: 1, status: "draft", createdAt: "2026-10-02T00:00:00Z", sources: [], citations: {}, content: createRequirementBrief({ industry: "print", title: "包装通知", customerGoal: "订单需求", facts: [{ key: "quantity", version: 1, value: quantity, unit: "个", status: "unverified", sourceType: "model_output", sourceRef: "customer:1" }] }) };
}
for (const format of ["docx", "xlsx"]) it(`persists ${format} custom mappings and reuses only template/config in a new order after restart`, () => {
	const h = setup(format), saved = h.library.save(scope, "conversation-1", h.template, h.data, h.input, h.canRead);
	expect(h.library.save(scope, "conversation-1", h.template, h.data, h.input, h.canRead)).toEqual(saved);
	h.library.remember(scope, "conversation-2", saved);
	h.library.close(); stores.splice(stores.indexOf(h.library), 1);
	const restarted = new RequirementTemplateLibrary(h.path); stores.push(restarted);
	expect(restarted.selection(scope, "conversation-2")).toMatchObject({ libraryId: saved.libraryId, version: 1 });
	expect(restarted.list(scope, h.canRead)[0].mapping.notice_title).toBe("title");
	const service = new RequirementTemplateService(h.artifacts, undefined, { store: restarted, actorId: "a", canRead: h.canRead });
	const newScope = { ...scope, runId: "r2" }, d = delivery("r2", 9900), ref = { libraryId: saved.libraryId, version: saved.version };
	expect(service.localTemplates(newScope)).toEqual([]);
	const preview = service.preview(newScope, h.template.templateId, d, saved.mapping, ref);
	expect(preview.values.quantity).toContain("9900"); expect(preview.values.quantity).toContain("UNVERIFIED"); expect(preview.values.quantity).not.toContain("7200");
	expect(() => service.generate(newScope, "a", h.template.templateId, d, preview)).toThrow();
	const input = { ...preview, confirmed: true }, output = service.generate(newScope, "a", h.template.templateId, d, input);
	expect(service.generate(newScope, "a", h.template.templateId, d, input)).toEqual(output);
	expect(service.history(newScope, () => d)).toMatchObject([{ exportId: output.exportId, templateName: "客户 A 通知", templateVersion: 1, status: "draft" }]);
	expect(service.download(newScope, output.exportId, d).data.length).toBeGreaterThan(1000);
	expect(() => service.preview(newScope, h.template.templateId, d, saved.mapping)).toThrow(); // No task-local copy that can bypass source checks.
	h.allowed.delete("conversation-1");
	expect(restarted.list(scope, h.canRead)[0]).toMatchObject({ available: false, mapping: {} });
	expect(service.history(newScope, () => d)[0]).toMatchObject({ status: "stale", reason: expect.stringContaining("权限") });
	expect(() => service.download(newScope, output.exportId, d)).toThrow("权限");
});
it("keeps versions immutable, rejects stale writers/review hashes, and preserves old output against its pinned config", () => {
	const h = setup(), v1 = h.library.save(scope, "conversation-1", h.template, h.data, h.input, h.canRead), d = delivery();
	const ref = { libraryId: v1.libraryId, version: 1 };
	const preview = h.service.preview(scope, h.template.templateId, d, h.mapping, ref);
	const generated = h.service.generate(scope, "a", h.template.templateId, d, { ...preview, confirmed: true });
	const before = h.service.download(scope, generated.exportId, d).data;
	const update = { ...h.input, requestId: "save-2", libraryId: v1.libraryId, expectedVersion: 1, mapping: { ...h.mapping, notice_title: "customer_goal" } };
	const v2 = h.library.save(scope, "conversation-1", h.template, h.data, update, h.canRead);
	expect(v2.version).toBe(2); expect(h.library.save(scope, "conversation-1", h.template, h.data, update, h.canRead)).toEqual(v2);
	expect(() => h.library.save(scope, "conversation-1", h.template, h.data, { ...update, requestId: "racing-writer" }, h.canRead)).toThrow("新版本");
	expect(() => h.library.save(scope, "conversation-1", h.template, h.data, { ...update, name: "different" }, h.canRead)).toThrow("不同配置");
	expect(h.library.resolve(scope, ref, h.canRead).record.mapping).toEqual(h.mapping);
	expect(() => h.service.generate(scope, "a", h.template.templateId, d, { ...preview, confirmed: true })).toThrow("新版本");
	const p2 = h.service.preview(scope, h.template.templateId, d, v2.mapping, { libraryId: v2.libraryId, version: 2 });
	expect(p2.reviewHash).not.toBe(preview.reviewHash);
	expect(() => h.service.generate(scope, "a", h.template.templateId, d, { ...p2, reviewHash: preview.reviewHash, confirmed: true })).toThrow();
	expect(h.service.download(scope, generated.exportId, d).data).toEqual(before);
	for (const current of [delivery("r1", 8000), { ...d, status: "approved" as const, approval: { approvalId: "approved-now", artifactVersion: 1 } }, { ...d, status: "stale" as const }]) {
		expect(h.service.history(scope, () => current)[0].status).toBe("stale"); expect(() => h.service.download(scope, generated.exportId, current)).toThrow();
	}
	expect(h.service.history(scope, () => ({ unavailable: "来源已撤回" }))[0]).toMatchObject({ status: "stale", reason: "来源已撤回" });
});
it("validates changed placeholders, bad/missing mappings, tenant/workspace and source permissions", () => {
	const h = setup(), saved = h.library.save(scope, "conversation-1", h.template, h.data, h.input, h.canRead);
	for (const mapping of [{}, { ...h.mapping, quantity: "not_a_field" }, { ...h.mapping, extra: "title" }]) expect(() => h.library.save(scope, "conversation-1", h.template, h.data, { ...h.input, mapping }, h.canRead)).toThrow();
	const parts = readOfficeZip(h.data); parts.set("word/document.xml", Buffer.from(parts.get("word/document.xml")!.toString().replace("{{quantity}}", "{{new_quantity}}")));
	const changed = writeOfficeZip(parts), parsed = inspectTemplate(changed, "notice.docx"), template = { ...h.template, slots: parsed.slots, sha256: createHash("sha256").update(changed).digest("hex") };
	expect(() => h.library.save(scope, "conversation-1", template, changed, h.input, h.canRead)).toThrow("占位符");
	const newMapping = { ...h.mapping, new_quantity: "quantity" }; delete (newMapping as Record<string, string>).quantity;
	template.templateId = `template-${template.sha256}`;
	const replacement = h.library.save(scope, "conversation-1", template, changed, { ...h.input, requestId: "replacement", libraryId: saved.libraryId, expectedVersion: 1, mapping: newMapping }, h.canRead);
	expect(replacement.version).toBe(2); expect(h.library.resolve(scope, saved, h.canRead).data).toEqual(h.data);
	expect(h.library.resolve(scope, replacement, h.canRead).data).toEqual(changed);
	for (const other of [{ ...scope, tenantId: "other" }, { ...scope, workspaceId: "other" }]) {
		expect(h.library.list(other, h.canRead)).toEqual([]); expect(() => h.library.resolve(other, saved, h.canRead)).toThrow("不存在");
	}
	expect(h.library.list({ ...scope, actorId: "no-access" }, () => false)[0].name).toBe("来源任务不可用");
	expect(() => h.library.resolve(scope, saved, () => false)).toThrow("权限");
	const copy = h.library.save(scope, "conversation-2", h.template, h.data, { ...h.input, requestId: "copy" }, h.canRead, ["conversation-1"]);
	expect(() => h.library.save(scope, "conversation-2", h.template, h.data, { ...h.input, requestId: "copy" }, h.canRead)).toThrow("不同配置");
	expect(() => h.library.list(scope, () => { throw new Error("来源存储暂不可用"); })).toThrow("来源存储暂不可用");
	h.allowed.delete("conversation-1"); expect(() => h.library.resolve(scope, copy, h.canRead)).toThrow("权限");
});
it("discovers #29 exports without an index or migration and fails visibly on corrupted history/store", () => {
	const h = setup(), d = delivery(), preview = h.service.preview(scope, h.template.templateId, d, h.mapping);
	const result = h.service.generate(scope, "a", h.template.templateId, d, { ...preview, confirmed: true });
	// Reconstruct the exact legacy record shape in another run without any catalog index.
	const key = { ...scope, artifactId: result.exportId, artifactVersion: 1 };
	const legacy = h.artifacts.readJson(key) as Record<string, unknown>; delete legacy.templateName;
	const oldScope = { ...scope, runId: "legacy" };
	h.artifacts.putJson({ ...oldScope, artifactId: h.template.templateId, artifactVersion: 1 }, h.service.original(scope, h.template.templateId).record);
	h.artifacts.putJson({ ...oldScope, artifactId: result.exportId, artifactVersion: 1 }, legacy);
	const restarted = new RequirementTemplateService(new FileArtifactContentStore(join(h.root, "artifacts")));
	expect(restarted.history(oldScope, () => d)).toMatchObject([{ status: "draft", templateVersion: 1, templateName: "notice.docx" }]);
	expect(restarted.download(oldScope, result.exportId, d).data.length).toBeGreaterThan(1000);
	const saved = h.library.save(scope, "conversation-1", h.template, h.data, h.input, h.canRead);
	const db = new DatabaseSync(h.path); db.prepare("UPDATE template_blobs SET data=?").run(Buffer.from("corrupt")); db.close();
	expect(() => h.library.resolve(scope, saved, h.canRead)).toThrow("校验失败");
});
