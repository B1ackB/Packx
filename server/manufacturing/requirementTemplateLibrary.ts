import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { templateFieldLabels, type RequirementTemplateView, type TemplateLibraryEntry, type TemplateLibraryRef } from "../../src/manufacturing/requirementTemplate";
import { inspectTemplate } from "../runtime/officeTemplate";

export class TemplateLibraryError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}
type Scope = { tenantId: string; workspaceId: string; actorId: string };
interface Configuration extends Omit<TemplateLibraryEntry, "available" | "reason"> {
	schemaVersion: "template-configuration.v1";
	event: "template.configuration_saved";
	actorId: string;
	sourceConversationIds: string[];
}
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function checkedMapping(template: RequirementTemplateView, input: unknown): Record<string, string> {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new TemplateLibraryError(400, "请补全字段映射");
	const keys = [...new Set(template.slots.map((slot) => slot.key))].sort(), mapping: Record<string, string> = {};
	if (Object.keys(input).some((key) => !keys.includes(key))) throw new TemplateLibraryError(400, "占位符已变化，请重新映射");
	for (const key of keys) {
		const field = Object.hasOwn(input, key) ? (input as Record<string, unknown>)[key] : undefined;
		if (typeof field !== "string" || !Object.hasOwn(templateFieldLabels, field)) throw new TemplateLibraryError(400, `请重新映射字段：${key}`);
		mapping[key] = field;
	}
	if (!["version", "delivery_status"].every((field) => Object.values(mapping).includes(field))) throw new TemplateLibraryError(400, "必须映射版本和需求状态");
	return mapping;
}

/** Workspace-owned immutable configurations. No Run ID substitution and no order values in this store. */
export class RequirementTemplateLibrary {
	private readonly db: DatabaseSync;
	constructor(path: string, private readonly now = () => new Date().toISOString()) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
			CREATE TABLE IF NOT EXISTS template_selections (tenant TEXT, workspace TEXT, actor TEXT, conversation TEXT, ref TEXT NOT NULL, PRIMARY KEY(tenant,workspace,actor,conversation));
			CREATE TABLE IF NOT EXISTS template_blobs (tenant TEXT, workspace TEXT, sha TEXT, data BLOB NOT NULL, PRIMARY KEY(tenant,workspace,sha));
			CREATE TABLE IF NOT EXISTS template_configurations (tenant TEXT, workspace TEXT, id TEXT, version INTEGER, actor TEXT, command TEXT, digest TEXT, record TEXT NOT NULL, PRIMARY KEY(tenant,workspace,id,version), UNIQUE(tenant,workspace,actor,command));`);
		if (path !== ":memory:") chmodSync(path, 0o600);
	}
	close() { this.db.close(); }
	private scope(scope: Scope) {
		if (![scope.tenantId, scope.workspaceId, scope.actorId].every(id)) throw new TemplateLibraryError(403, "模板库访问被拒绝");
		return [scope.tenantId, scope.workspaceId];
	}
	selection(scope: Scope, conversationId: string): TemplateLibraryRef | undefined {
		const row = this.db.prepare("SELECT ref FROM template_selections WHERE tenant=? AND workspace=? AND actor=? AND conversation=?").get(...this.scope(scope), scope.actorId, conversationId);
		return row ? JSON.parse(String(row.ref)) as TemplateLibraryRef : undefined;
	}
	remember(scope: Scope, conversationId: string, ref: TemplateLibraryRef) {
		this.db.prepare("INSERT INTO template_selections VALUES (?,?,?,?,?) ON CONFLICT(tenant,workspace,actor,conversation) DO UPDATE SET ref=excluded.ref").run(...this.scope(scope), scope.actorId, conversationId, JSON.stringify(ref));
	}

	private record(scope: Scope, ref: TemplateLibraryRef): Configuration {
		if (!id(ref?.libraryId) || !Number.isSafeInteger(ref.version) || ref.version < 1) throw new TemplateLibraryError(400, "模板版本无效");
		const row = this.db.prepare("SELECT record FROM template_configurations WHERE tenant=? AND workspace=? AND id=? AND version=?").get(...this.scope(scope), ref.libraryId, ref.version);
		if (!row) throw new TemplateLibraryError(404, "模板版本不存在");
		return JSON.parse(String(row.record)) as Configuration;
	}
	private available(record: Configuration, canRead: (conversationId: string) => boolean) { return record.sourceConversationIds.every(canRead); }
	list(scope: Scope, canRead: (conversationId: string) => boolean): TemplateLibraryEntry[] {
		return this.db.prepare("SELECT record FROM template_configurations c WHERE tenant=? AND workspace=? AND version=(SELECT MAX(version) FROM template_configurations WHERE tenant=c.tenant AND workspace=c.workspace AND id=c.id) ORDER BY rowid DESC").all(...this.scope(scope)).map((row) => {
			const record = JSON.parse(String(row.record)) as Configuration;
			const { schemaVersion: _schema, event: _event, actorId: _actor, sourceConversationIds: _sources, ...entry } = record;
			if (!this.available(record, canRead)) return { ...entry, name: "来源任务不可用", description: "", mapping: {}, template: { ...entry.template, name: "", slots: [] }, available: false, reason: "来源任务已删除或权限变化；请从可访问的原件另存新模板" };
			return { ...entry, available: true };
		});
	}
	resolve(scope: Scope, ref: TemplateLibraryRef, canRead: (conversationId: string) => boolean, latest = false) {
		const record = this.record(scope, ref);
		if (!this.available(record, canRead)) throw new TemplateLibraryError(403, "模板来源任务已删除或权限变化；请重新选择可用模板");
		if (latest) {
			const row = this.db.prepare("SELECT MAX(version) AS version FROM template_configurations WHERE tenant=? AND workspace=? AND id=?").get(...this.scope(scope), ref.libraryId);
			if (row?.version !== ref.version) throw new TemplateLibraryError(409, "模板配置已有新版本，请重新选择、预览并确认");
		}
		checkedMapping(record.template, record.mapping);
		const blob = this.db.prepare("SELECT data FROM template_blobs WHERE tenant=? AND workspace=? AND sha=?").get(...this.scope(scope), record.template.sha256);
		if (!blob) throw new TemplateLibraryError(503, "模板原件不可用");
		const data = Buffer.from(blob.data as Uint8Array);
		if (hash(data) !== record.template.sha256) throw new TemplateLibraryError(503, "模板原件校验失败");
		return { record, data };
	}
	save(scope: Scope, sourceConversationId: string, template: RequirementTemplateView, data: Buffer, input: unknown, canRead: (conversationId: string) => boolean, inheritedSources: string[] = []): TemplateLibraryEntry {
		const p = input as { name?: unknown; description?: unknown; mapping?: unknown; requestId?: unknown; libraryId?: unknown; expectedVersion?: unknown } | null;
		this.scope(scope);
		if (!p || !id(p.requestId) || !id(sourceConversationId) || typeof p.name !== "string" || !p.name.trim() || p.name.length > 100 || typeof p.description !== "string" || p.description.length > 500 || /[\x00-\x1f]/.test(p.name + p.description)) throw new TemplateLibraryError(400, "请填写模板名称、说明及有效保存请求");
		if (![sourceConversationId, ...inheritedSources].every(canRead)) throw new TemplateLibraryError(403, "来源任务不可访问");
		const mapping = checkedMapping(template, p.mapping);
		const parsed = inspectTemplate(data, template.name);
		if (hash(data) !== template.sha256 || JSON.stringify(parsed.slots) !== JSON.stringify(template.slots)) throw new TemplateLibraryError(400, "模板占位符已变化，请重新映射");
		const isUpdate = p.libraryId !== undefined;
		if (isUpdate && (!id(p.libraryId) || !Number.isSafeInteger(p.expectedVersion) || Number(p.expectedVersion) < 1)) throw new TemplateLibraryError(400, "更新必须提供已读取的模板版本");
		const digest = hash(JSON.stringify({ sourceConversationId, inheritedSources: [...new Set(inheritedSources)].sort(), template: template.sha256, name: p.name.trim(), description: p.description, mapping, libraryId: p.libraryId ?? null, expectedVersion: p.expectedVersion ?? null }));
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const prior = this.db.prepare("SELECT record,digest FROM template_configurations WHERE tenant=? AND workspace=? AND actor=? AND command=?").get(...this.scope(scope), scope.actorId, p.requestId);
			if (prior) {
				if (prior.digest !== digest) throw new TemplateLibraryError(409, "保存请求已用于不同配置，请刷新后重试");
				const record = JSON.parse(String(prior.record)) as Configuration;
				this.resolve(scope, record, canRead); this.db.exec("COMMIT");
				return { ...record, available: true };
			}
			const previous = isUpdate ? this.resolve(scope, { libraryId: p.libraryId as string, version: p.expectedVersion as number }, canRead, true).record : undefined;
			const total = this.db.prepare("SELECT COUNT(DISTINCT id) AS n FROM template_configurations WHERE tenant=? AND workspace=?").get(...this.scope(scope));
			if ((!previous && Number(total?.n) >= 100) || previous && previous.version >= 50) throw new TemplateLibraryError(409, "已达到模板库上限（100 个模板，每个 50 版）");
			const record: Configuration = { schemaVersion: "template-configuration.v1", event: "template.configuration_saved", libraryId: previous?.libraryId ?? `template-config-${randomUUID()}`, version: (previous?.version ?? 0) + 1, name: p.name.trim(), description: p.description, template, mapping, createdAt: this.now(), actorId: scope.actorId, sourceConversationIds: [...new Set([...(previous?.sourceConversationIds ?? []), ...inheritedSources, sourceConversationId])] };
			this.db.prepare("INSERT OR IGNORE INTO template_blobs VALUES (?,?,?,?)").run(...this.scope(scope), template.sha256, data);
			this.db.prepare("INSERT INTO template_configurations VALUES (?,?,?,?,?,?,?,?)").run(...this.scope(scope), record.libraryId, record.version, scope.actorId, p.requestId, digest, JSON.stringify(record));
			this.db.exec("COMMIT"); return { ...record, available: true };
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
}
