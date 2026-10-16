import { useEffect, useRef, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import { templateFieldLabels, type RequirementTemplateView, type RequirementTemplatePreview, type TemplateCatalog, type TemplateLibraryRef } from "../manufacturing/requirementTemplate";
import type { RequirementDelivery } from "../manufacturing/requirementDelivery";
import { errorText, labelFor, type Language } from "../i18n";

const client = new ConversationClient();
export function RequirementTemplate({ conversationId, delivery, language }: { conversationId: string; delivery?: RequirementDelivery; language: Language }) {
	const en = language === "en";
	const [catalog, setCatalog] = useState<TemplateCatalog>({ library: [], templates: [], history: [] });
	const [template, setTemplate] = useState<RequirementTemplateView>();
	const [library, setLibrary] = useState<TemplateLibraryRef>();
	const [mapping, setMapping] = useState<Record<string, string>>({});
	const [name, setName] = useState(""), [description, setDescription] = useState("");
	const [preview, setPreview] = useState<RequirementTemplatePreview>();
	const [confirmed, setConfirmed] = useState(false), [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
	const pendingSave = useRef<{ signature: string; requestId: string } | undefined>(undefined);
	function invalidate() { pendingSave.current = undefined; setPreview(undefined); setConfirmed(false); setDirty(true); setNotice(""); }
	function load(template: RequirementTemplateView, savedMapping?: Record<string, string>, ref?: TemplateLibraryRef) {
		pendingSave.current = undefined;
		setTemplate(template); setLibrary(ref); setPreview(undefined); setConfirmed(false); setDirty(false); setNotice("");
		setMapping(savedMapping ?? Object.fromEntries(template.slots.map((slot) => [slot.key, Object.hasOwn(templateFieldLabels, slot.key) ? slot.key : ""])));
		setName(template.name); setDescription("");
	}
	useEffect(() => {
		let cancelled = false;
		setBusy(true);
		void client.templateCatalog(conversationId).then((next) => {
			if (cancelled) return;
			setCatalog(next);
			if (next.selected) {
				const entry = next.library.find((item) => item.libraryId === next.selected!.libraryId);
				if (entry?.available && entry.version === next.selected.version) {
					load(entry.template, entry.mapping, next.selected); setName(entry.name); setDescription(entry.description);
				} else setError(en ? "Saved template changed or became unavailable. Select and review the current configuration." : "上次选择的模板已更新或不可用，请重新选择并核对配置。");
			}
		}).catch((reason) => { if (!cancelled) setError(errorText(reason, language)); }).finally(() => { if (!cancelled) setBusy(false); });
		return () => { cancelled = true; };
	}, [conversationId]);
	async function perform(action: () => Promise<void>) {
		setBusy(true); setError("");
		try { await action(); } catch (reason) {
			const uncertainSave = pendingSave.current && reason && typeof reason === "object" && "code" in reason && ["runtime_unavailable", "request_failed"].includes(String(reason.code));
			setError(uncertainSave ? en ? "Save result not confirmed. Keep this page and content unchanged, then click the same save button to retry. Check the library before refreshing." : "保存结果尚未确认。请保持页面和内容不变，再点击原保存按钮重试；刷新前先检查模板库。" : errorText(reason, language));
		}
		finally { setBusy(false); }
	}
	async function refresh() { setCatalog(await client.templateCatalog(conversationId)); }
	async function save(update: boolean) {
		if (!template) return;
		const input = { name, description, mapping, library, ...(update && library ? { libraryId: library.libraryId, expectedVersion: library.version } : {}) };
		const signature = JSON.stringify({ conversationId, templateId: template.templateId, input });
		if (pendingSave.current?.signature !== signature) pendingSave.current = { signature, requestId: crypto.randomUUID() };
		const entry = await client.saveTemplateConfiguration(conversationId, template.templateId, { ...input, requestId: pendingSave.current.requestId });
		pendingSave.current = undefined;
		setLibrary({ libraryId: entry.libraryId, version: entry.version }); setDirty(false); setPreview(undefined); setConfirmed(false);
		await refresh(); setNotice(en ? `Template saved · v${entry.version}. Preview this order before generation.` : `模板设置已保存 · v${entry.version}。请预览本次订单后再生成文件。`);
	}
	async function download(file: { exportId: string; filename: string; requirementVersion: number }) {
		const blob = await client.downloadTemplate(conversationId, file.exportId, file.requirementVersion);
		const url = URL.createObjectURL(blob), link = document.createElement("a");
		link.href = url; link.download = file.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	return <details className="requirement-template"><summary>{en ? "Template library and delivery history" : "模板库与交付历史"}</summary>
		<p>{en ? "Reuse a workspace template and its selected information. Each order still needs a fresh preview and confirmation; old values and approvals are never copied." : "复用本工作区的模板与填写设置。每笔订单仍需重新预览、确认，不带入旧订单的填充值或审批。"}</p>
		<label>{en ? "Workspace template" : "工作区模板"}<select aria-label={en ? "Workspace template" : "工作区模板"} disabled={busy} value={library?.libraryId ?? ""} onChange={(event) => {
			const entry = catalog.library.find((item) => item.libraryId === event.target.value); if (!entry) return;
			void perform(async () => { const selected = await client.selectLibraryTemplate(conversationId, entry); load(selected.template, selected.mapping, selected.library); setName(entry.name); setDescription(entry.description); });
		}}><option value="">{en ? "Choose a saved template" : "选择已保存模板"}</option>{catalog.library.map((entry) => <option key={entry.libraryId} value={entry.libraryId} disabled={!entry.available}>{entry.name} · v{entry.version}{entry.available ? "" : en ? " · unavailable" : " · 不可用"}</option>)}</select></label>
		<button disabled={busy} onClick={() => void perform(refresh)}>{en ? "Refresh library and history" : "刷新模板与历史"}</button>
		{catalog.library.filter((entry) => !entry.available).map((entry) => <p key={entry.libraryId}>{en ? "The source task is unavailable. Choose another template." : entry.reason}</p>)}
		{catalog.templates.length > 0 && <label>{en ? "Files uploaded in this task (including older versions)" : "本任务已上传原件（含旧版数据）"}<select aria-label={en ? "Task template originals" : "本任务模板原件"} disabled={busy} value={!library ? template?.templateId ?? "" : ""} onChange={(event) => { const file = catalog.templates.find((item) => item.templateId === event.target.value); if (file) load(file); }}><option value="">{en ? "Choose an original" : "选择原件并配置"}</option>{catalog.templates.map((file) => <option key={file.templateId} value={file.templateId}>{file.name}</option>)}</select></label>}
		<p>{en ? "Upload a Word or Excel template (up to 5 MB). Put a marker such as {{quantity}} wherever information should be filled in, then choose the matching requirement below. Blank spaces, empty cells and labels are not recognized automatically." : "上传 Word / Excel 模板（最多 5 MB）。在需要填写的位置加入 {{quantity}} 这样的填写标记，再在下方选择对应的需求信息。普通空格、空白单元格和标题不会被自动识别。"}</p>
		<p>{en ? "Include markers for the brief version and status. Keep each Word marker in one paragraph and each Excel marker in a text cell. Check the layout after opening the generated file. Confirming what to fill in does not confirm order details or approve the file." : "请预留需求单版本与状态的填写位置。Word 中每个标记须放在同一段落，Excel 中放在文字单元格内。生成后请打开文件核对排版。确认填写内容不代表确认订单信息，也不等于批准文件。"}</p>
		<p><a href="/templates/packaging-notice.docx" download>{en ? "Word example" : "下载 Word 示例"}</a> · <a href="/templates/packaging-notice.xlsx" download>{en ? "Excel example" : "下载 Excel 示例"}</a></p>
		<label className="file-upload-control"><span>{en ? "Upload template" : "上传模板"}</span><span className="file-upload-button" aria-hidden="true">{en ? "Choose a Word / Excel file" : "选择 Word / Excel 文件"}</span><input aria-label={en ? "Upload template" : "上传模板"} type="file" accept=".docx,.xlsx" disabled={busy} onChange={(event) => {
			const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
			void perform(async () => {
				if (file.size > 5 * 1024 * 1024) throw new Error("template_too_large");
				const uploaded = await client.uploadTemplate(conversationId, file);
				setTemplate(uploaded); setMapping(Object.fromEntries(uploaded.slots.map((slot) => [slot.key, !library && Object.hasOwn(templateFieldLabels, slot.key) ? slot.key : ""]))); invalidate(); if (!library) { setName(file.name); setDescription(""); } await refresh();
			});
		}} /></label>
		{busy && <p role="status">{en ? "Loading / saving…" : "正在读取或保存…"}</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
		{template && <><p>{template.name} · {en ? "Original saved" : "原件已保存"}{library && ` · ${en ? "saved settings" : "已保存设置"} v${library.version}`}</p>
			<label>{en ? "Template name" : "模板名称"}<input aria-label={en ? "Template name" : "模板名称"} maxLength={100} disabled={busy} value={name} onChange={(event) => { setName(event.target.value); invalidate(); }} /></label>
			<label>{en ? "Description" : "说明"}<input aria-label={en ? "Template description" : "模板说明"} maxLength={500} disabled={busy} value={description} onChange={(event) => { setDescription(event.target.value); invalidate(); }} /></label>
			<div className="table-scroll"><table><thead><tr><th>{en ? "Template marker" : "模板填写位置"}</th><th>{en ? "Requirement information" : "对应需求信息"}</th><th>{en ? "Value preview" : "填充值预览"}</th></tr></thead><tbody>{[...new Set(template.slots.map((slot) => slot.key))].map((key) => <tr key={key}><td><code>{`{{${key}}}`}</code><details><summary>{en ? "Template context" : "模板原文"}</summary>{template.slots.filter((slot) => slot.key === key).map((slot, index) => <p key={index}>{en ? "Position" : "位置"} {index + 1}<br />{slot.context}</p>)}</details></td><td><select aria-label={`${en ? "Fill with" : "填入内容"} ${key}`} disabled={busy} value={mapping[key] ?? ""} onChange={(event) => { setMapping({ ...mapping, [key]: event.target.value }); invalidate(); }}><option value="">{en ? "Choose information" : "请选择需求信息"}</option>{Object.entries(templateFieldLabels).map(([field, label]) => <option key={field} value={field}>{labelFor(language, field, label)}</option>)}</select></td><td>{preview ? mapping[key] === "version" ? `v${preview.version}` : preview.values[key] ?? "—" : "—"}</td></tr>)}</tbody></table></div>
			<button disabled={busy} onClick={() => void perform(() => save(false))}>{en ? "Save as new library template" : "另存为新模板"}</button>{library && <button disabled={busy || !dirty} onClick={() => void perform(() => save(true))}>{en ? "Save a new template version" : "保存模板新版本"}</button>}
			<p>{en ? "Saving adds this original and its fill-in settings to the workspace library. Deleted or inaccessible source tasks block reuse; saving does not confirm order details." : "保存会将原件与填写设置纳入工作区模板库。来源任务被删除或权限变化会阻止复用；保存不代表确认订单信息。"}</p>
			<button disabled={busy || !delivery || !!library && dirty} onClick={() => void perform(async () => { if (!delivery) return; setPreview(await client.previewTemplate(conversationId, template.templateId, delivery.version, mapping, library)); setConfirmed(false); })}>{en ? "Preview this order" : "预览本次订单"}</button>
			{library && dirty && <p>{en ? "Save the changed configuration before previewing." : "填写设置已修改，请先保存新版本再预览。"}</p>}
			{!delivery && <p>{en ? "Generate or restore a valid requirement version to preview." : "请先生成或恢复可读取的需求版本，才能预览填充。"}</p>}
			{preview && <>{preview.errors.map((message) => <p role="alert" key={message}>{message.startsWith("缺少映射：") ? (en ? `Choose what to fill in for ${message.slice(5)}.` : `请为 ${message.slice(5)} 选择对应的需求信息。`) : message.startsWith("必须映射") ? (en ? "Include both the brief version and status in the template." : "请在模板中同时设置需求单版本与状态。") : preview.status === "stale" ? (en ? "The brief or sources changed. Generate a new version before continuing." : "需求或来源已变化，请重新生成需求单后继续。") : (en ? "Check the template and selected information before generating." : "请核对模板及对应信息后再生成。")}</p>)}{template.format === "xlsx" && <p>{en ? "Formula support is limited. Templates that link to other files or run automatic actions are not accepted. Open the generated file in Excel to calculate formulas and check the results." : "仅支持部分表格公式，不接收关联其他文件或自动执行操作的模板。生成后请在 Excel 中计算公式并核对结果。"}</p>}<label><input type="checkbox" checked={confirmed} disabled={busy || preview.errors.length > 0} onChange={(event) => setConfirmed(event.target.checked)} />{en ? `I checked the template text, selected information, filled values and status for v${preview.version}.` : `我已核对模板文字、对应信息、填写内容及 v${preview.version} 的状态。`}</label><button disabled={busy || !confirmed || preview.errors.length > 0} onClick={() => void perform(async () => { const file = await client.generateTemplate(conversationId, preview); await refresh(); setNotice(`${en ? "Saved: " : "已保存："}${file.filename}`); await download({ ...file, requirementVersion: preview.version }); })}>{en ? "Save new file and download" : "保存新文件并下载"}</button></>}
		</>}
		<h4>{en ? "Delivery history" : "交付文件历史"}</h4><p>{en ? "Status is checked against current sources and approvals. Stale files remain visible but cannot be downloaded as current delivery." : "状态按当前来源与审批重新校验。失效文件保留历史，但不能作为当前交付下载；已下载到本机的文件无法撤回。"}</p>
		{!catalog.history.length && <p>{en ? "No generated files yet." : "尚无已生成文件。"}</p>}
		{catalog.history.map((file) => <div className="template-history-item" key={file.exportId}><strong>{file.filename}</strong><p>{file.format.toUpperCase()} · {new Date(file.createdAt).toLocaleString(en ? "en" : "zh-HK")} · {en ? "Requirement" : "需求"} v{file.requirementVersion} · {file.templateName} v{file.templateVersion}{file.libraryId ? "" : en ? " (task original)" : "（任务原件）"}</p><p>{{ draft: en ? "Current draft" : "当前草稿", approved: en ? "Current brief approved" : "当前需求已批准", stale: en ? "Stale / unavailable" : "已失效 / 不可用" }[file.status]}{file.reason ? en ? ": The brief, sources or access changed. Review the current version." : `：${file.reason}` : ""}</p><button disabled={busy || file.status === "stale"} onClick={() => void perform(async () => { try { await download(file); } finally { await refresh(); } })}>{en ? "Download" : "下载"} {file.filename}</button></div>)}
	</details>;
}
