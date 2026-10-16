import { createHash } from "node:crypto";
import type { ArtifactContentStore } from "../../src/enterprise/artifactStore";
import { ArtifactStoreError } from "../../src/enterprise/artifactStore";
import type { AggregateScope } from "../../src/enterprise/contracts";
import type { RequirementDelivery } from "../../src/manufacturing/requirementDelivery";
import { templateFieldValues, type RequirementTemplateView, type RequirementTemplatePreview, type TemplateLibraryRef, type TemplateHistoryEntry } from "../../src/manufacturing/requirementTemplate";
import { inspectTemplate, fillTemplate, OfficeTemplateError } from "../runtime/officeTemplate";

import { RequirementTemplateLibrary, TemplateLibraryError, checkedMapping } from "./requirementTemplateLibrary";

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
interface StoredTemplate { schemaVersion: "requirement-template.v1"; name: string; sha256: string; data: string; actorId: string; storedAt: string }
interface StoredExport { library?: TemplateLibraryRef; templateName?: string; schemaVersion: "requirement-template-export.v1"; event: "delivery.template_generated"; templateId: string; templateSha256: string; delivery: RequirementDelivery; mapping: Record<string, string>; reviewHash: string; data: string; sha256: string; actorId: string; createdAt: string; filename: string }

/** Product adapter. Atomic immutable records keep original, mapping, source versions and output together. */
export class RequirementTemplateService {
	constructor(private readonly artifacts: ArtifactContentStore, private readonly now = () => new Date().toISOString(), private readonly library?: { store: RequirementTemplateLibrary; actorId: string; canRead: (conversationId: string) => boolean }) {}
	private key(scope: AggregateScope, artifactId: string) { return { ...scope, artifactId, artifactVersion: 1 }; }
	upload(scope: AggregateScope, actorId: string, name: string, data: Buffer): RequirementTemplateView {
		if (!actorId || name.length > 180 || /[\x00-\x1f/\\]/.test(name)) throw new OfficeTemplateError("模板文件名不正确");
		const parsed = inspectTemplate(data, name), sha256 = hash(data), templateId = `template-${sha256}`;
		const record: StoredTemplate = { schemaVersion: "requirement-template.v1", name, sha256, data: data.toString("base64"), actorId, storedAt: this.now() };
		try { this.artifacts.readJson(this.key(scope, templateId)); }
		catch (error) { if (!(error instanceof ArtifactStoreError && error.code === "artifact_not_found")) throw error; this.artifacts.putJson(this.key(scope, templateId), record); }
		return { templateId, name, sha256, format: parsed.format, slots: parsed.slots };
	}
	original(scope: AggregateScope, templateId: string) {
		if (!/^template-[a-f0-9]{64}$/.test(templateId)) throw new OfficeTemplateError("模板编号无效");
		const record = this.artifacts.readJson(this.key(scope, templateId)) as StoredTemplate;
		const data = Buffer.from(record.data, "base64");
		if (hash(data) !== record.sha256 || templateId !== `template-${record.sha256}`) throw new OfficeTemplateError("模板内容已变化，请重新上传");
		const parsed = inspectTemplate(data, record.name);
		return { sourceConversationIds: [] as string[], record, parsed, view: { templateId, name: record.name, sha256: record.sha256, format: parsed.format, slots: parsed.slots } };
	}
	source(scope: AggregateScope, templateId: string, library?: TemplateLibraryRef, latest = true) {
		if (!library) return this.original(scope, templateId);
		if (!this.library) throw new TemplateLibraryError(503, "模板库不可用");
		const { record, data } = this.library.store.resolve({ ...scope, actorId: this.library.actorId }, library, this.library.canRead, latest);
		if (record.template.templateId !== templateId) throw new TemplateLibraryError(409, "模板原件与配置不匹配");
		return { sourceConversationIds: record.sourceConversationIds, record: { data: data.toString("base64"), name: record.template.name }, parsed: inspectTemplate(data, record.template.name), view: record.template };
	}

	view(scope: AggregateScope, templateId: string) { return this.original(scope, templateId).view; }
	preview(scope: AggregateScope, templateId: string, delivery: RequirementDelivery, input: unknown, library?: TemplateLibraryRef, pinned = false): RequirementTemplatePreview {
		const { view } = this.source(scope, templateId, library, !pinned);
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new OfficeTemplateError("请核对模板字段映射");
		const mapping: Record<string, string> = {}, values: Record<string, string> = {}, errors: string[] = [];
		const fields = templateFieldValues(delivery);
		if (library) {
			if (!this.library) throw new TemplateLibraryError(503, "模板库不可用");
			const config = this.library.store.resolve({ ...scope, actorId: this.library.actorId }, library, this.library.canRead, !pinned).record;
			if (config.template.sha256 !== view.sha256 || JSON.stringify(checkedMapping(view, input)) !== JSON.stringify(config.mapping)) throw new TemplateLibraryError(409, "模板或映射与保存配置不同，请先保存新版本");
		}
		for (const key of [...new Set(view.slots.map((slot) => slot.key))].sort()) {
			const field = Object.hasOwn(input, key) ? (input as Record<string, unknown>)[key] : undefined;
			if (typeof field !== "string" || !Object.hasOwn(fields, field)) { errors.push(`缺少映射：${key}`); continue; }
			mapping[key] = field; values[key] = fields[field];
		}
		for (const field of ["delivery_status", "version"]) if (!Object.values(mapping).includes(field)) errors.push(`必须映射 ${field}，使导出文件显示状态与版本`);
		if (delivery.status === "stale") errors.push("需求或来源已变化，请重新生成并核对当前版本");
		const reviewHash = hash(JSON.stringify({ template: view.sha256, delivery, mapping, ...(library ? { library } : {}) }));
		return { template: view, mapping, values, errors, reviewHash, ...(library ? { library } : {}), version: delivery.version, status: delivery.status };
	}
	generate(scope: AggregateScope, actorId: string, templateId: string, delivery: RequirementDelivery, input: { mapping?: unknown; reviewHash?: unknown; confirmed?: unknown; library?: TemplateLibraryRef }) {
		const preview = this.preview(scope, templateId, delivery, input?.mapping, input?.library);
		if (!actorId || input?.confirmed !== true || preview.errors.length || input.reviewHash !== preview.reviewHash) throw new OfficeTemplateError(preview.errors.join("；") || "模板、映射或需求版本已变化，请先预览并确认");
		const exportId = `template-export-${preview.reviewHash}`;
		try {
			const stored = this.artifacts.readJson(this.key(scope, exportId)) as StoredExport;
			return { exportId, filename: stored.filename, sha256: stored.sha256 };
		} catch (error) { if (!(error instanceof ArtifactStoreError && error.code === "artifact_not_found")) throw error; }
		const { parsed } = this.source(scope, templateId, input.library);
		const data = fillTemplate(parsed, preview.values);
		const filename = `requirement-v${delivery.version}-${preview.reviewHash.slice(0, 10)}.${parsed.format}`;
		const record: StoredExport = { schemaVersion: "requirement-template-export.v1", event: "delivery.template_generated", templateId, templateSha256: preview.template.sha256, templateName: preview.library && this.library ? this.library.store.resolve({ ...scope, actorId }, preview.library, this.library.canRead).record.name : preview.template.name, ...(preview.library ? { library: preview.library } : {}), delivery, mapping: preview.mapping, reviewHash: preview.reviewHash, data: data.toString("base64"), sha256: hash(data), actorId, createdAt: this.now(), filename };
		this.artifacts.putJson(this.key(scope, exportId), record);
		return { exportId, filename, sha256: record.sha256 };
	}
	localTemplates(scope: AggregateScope) {
		return this.artifacts.list(scope).filter((key) => /^template-[a-f0-9]{64}$/.test(key.artifactId) && key.artifactVersion === 1).map((key) => this.view(scope, key.artifactId));
	}
	history(scope: AggregateScope, readDelivery: (version: number) => RequirementDelivery | { unavailable: string }): TemplateHistoryEntry[] {
		return this.artifacts.list(scope).filter((key) => /^template-export-[a-f0-9]{64}$/.test(key.artifactId) && key.artifactVersion === 1).map((key): TemplateHistoryEntry => {
			const stored = this.artifacts.readJson(key) as StoredExport;
			if (stored.schemaVersion !== "requirement-template-export.v1" || !stored.delivery || !Number.isSafeInteger(stored.delivery.version)) throw new ArtifactStoreError("artifact_store_unavailable", "交付历史记录损坏");
			const current = readDelivery(stored.delivery.version);
			let reason = "unavailable" in current ? current.unavailable : undefined;
			if (!reason && !("unavailable" in current)) {
				try {
					const preview = this.preview(scope, stored.templateId, current, stored.mapping, stored.library, true);
					if (preview.errors.length || preview.reviewHash !== stored.reviewHash) reason = "事实、来源、需求版本或审批状态已变化；请使用当前版本重新预览并生成";
				} catch (error) {
					if (error instanceof OfficeTemplateError || error instanceof TemplateLibraryError && error.status < 500) reason = error.message;
					else throw error;
				}
			}
			return { exportId: key.artifactId, filename: stored.filename, format: stored.filename.endsWith(".docx") ? "docx" : "xlsx", createdAt: stored.createdAt, requirementVersion: stored.delivery.version, templateName: stored.templateName ?? this.view(scope, stored.templateId).name, templateVersion: stored.library?.version ?? 1, ...(stored.library ? { libraryId: stored.library.libraryId } : {}), status: reason || "unavailable" in current ? "stale" : current.status, ...(reason ? { reason } : {}) };
		}).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.exportId.localeCompare(b.exportId));
	}

	download(scope: AggregateScope, exportId: string, delivery: RequirementDelivery) {
		if (!/^template-export-[a-f0-9]{64}$/.test(exportId)) throw new OfficeTemplateError("交付文件编号无效");
		const stored = this.artifacts.readJson(this.key(scope, exportId)) as StoredExport;
		const current = this.preview(scope, stored.templateId, delivery, stored.mapping, stored.library, true);
		if (current.errors.length || current.reviewHash !== stored.reviewHash) throw new OfficeTemplateError("需求状态或来源已变化，请重新预览并生成文件；历史记录保留");
		const data = Buffer.from(stored.data, "base64");
		if (hash(data) !== stored.sha256) throw new OfficeTemplateError("交付文件校验失败");
		return { data, filename: stored.filename };
	}
}
