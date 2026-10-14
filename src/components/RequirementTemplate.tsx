import { useEffect, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import { templateFieldLabels, type RequirementTemplateView, type RequirementTemplatePreview } from "../manufacturing/requirementTemplate";
import type { RequirementDelivery } from "../manufacturing/requirementDelivery";
import { errorText, labelFor, type Language } from "../i18n";

const client = new ConversationClient();
export function RequirementTemplate({ conversationId, delivery, language }: { conversationId: string; delivery: RequirementDelivery; language: Language }) {
	const en = language === "en";
	const storageKey = `packx-template:${conversationId}`;
	const [template, setTemplate] = useState<RequirementTemplateView>();
	const [mapping, setMapping] = useState<Record<string, string>>({});
	const [preview, setPreview] = useState<RequirementTemplatePreview>();
	const [confirmed, setConfirmed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState<{ exportId: string; filename: string }>();
	function selectTemplate(value: RequirementTemplateView) {
		setTemplate(value); setPreview(undefined); setConfirmed(false); setSaved(undefined);
		setMapping(Object.fromEntries(value.slots.map((slot) => [slot.key, Object.hasOwn(templateFieldLabels, slot.key) ? slot.key : ""])));
	}
	useEffect(() => {
		let cancelled = false;
		const id = localStorage.getItem(storageKey);
		if (id) void client.template(conversationId, id).then((value) => { if (!cancelled) selectTemplate(value); }).catch(() => { if (!cancelled) localStorage.removeItem(storageKey); });
		return () => { cancelled = true; };
	}, [conversationId]);
	async function perform(action: () => Promise<void>) {
		setBusy(true); setError("");
		try { await action(); } catch (reason) { setError(errorText(reason, language)); }
		finally { setBusy(false); }
	}
	async function download(file: { exportId: string; filename: string }) {
		const blob = await client.downloadTemplate(conversationId, file.exportId, delivery.version);
		const url = URL.createObjectURL(blob), link = document.createElement("a");
		link.href = url; link.download = file.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	return <details className="requirement-template"><summary>{en ? "Use your Word / Excel template" : "使用自己的 Word / Excel 模板"}</summary>
		<p>{en ? "Upload a Word or Excel template (up to 5 MB). Put a marker such as {{quantity}} wherever information should be filled in, then choose the matching requirement below. Blank spaces, empty cells and labels are not recognized automatically." : "上传 Word / Excel 模板（最多 5 MB）。在需要填写的位置加入 {{quantity}} 这样的填写标记，再在下方选择对应的需求信息。普通空格、空白单元格和标题不会被自动识别。"}</p>
		<p>{en ? "Include markers for the brief version and status. Keep each Word marker in one paragraph and each Excel marker in a text cell. Check the layout after opening the generated file. Confirming what to fill in does not confirm order details or approve the file." : "请预留需求单版本与状态的填写位置。Word 中每个标记须放在同一段落，Excel 中放在文字单元格内。生成后请打开文件核对排版。确认填写内容不代表确认订单信息，也不等于批准文件。"}</p>
		<p><a href="/templates/packaging-notice.docx" download>{en ? "Word example" : "下载 Word 示例"}</a> · <a href="/templates/packaging-notice.xlsx" download>{en ? "Excel example" : "下载 Excel 示例"}</a></p>
		<label className="file-upload-control"><span>{en ? "Upload template" : "上传模板"}</span><span className="file-upload-button" aria-hidden="true">{en ? "Choose a Word / Excel file" : "选择 Word / Excel 文件"}</span><input aria-label={en ? "Upload template" : "上传模板"} type="file" accept=".docx,.xlsx" disabled={busy} onChange={(event) => {
			const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
			void perform(async () => { if (file.size > 5 * 1024 * 1024) throw new Error("template_too_large"); const uploaded = await client.uploadTemplate(conversationId, file); selectTemplate(uploaded); localStorage.setItem(storageKey, uploaded.templateId); });
		}} /></label>
		{error && <p role="alert">{error}</p>}
		{template && <><p>{template.name} · {en ? "Original saved" : "原件已保存"}</p>
			<div className="table-scroll"><table><thead><tr><th>{en ? "Template marker" : "模板填写位置"}</th><th>{en ? "Requirement information" : "对应需求信息"}</th><th>{en ? "Value preview" : "填充值预览"}</th></tr></thead><tbody>{[...new Set(template.slots.map((slot) => slot.key))].map((key) => <tr key={key}><td><code>{`{{${key}}}`}</code><details><summary>{en ? "Template context" : "模板原文"}</summary>{template.slots.filter((slot) => slot.key === key).map((slot, index) => <p key={index}>{en ? "Position" : "位置"} {index + 1}<br />{slot.context}</p>)}</details></td><td><select aria-label={`${en ? "Fill with" : "填入内容"} ${key}`} disabled={busy} value={mapping[key] ?? ""} onChange={(event) => { setMapping({ ...mapping, [key]: event.target.value }); setPreview(undefined); setConfirmed(false); setSaved(undefined); }}><option value="">{en ? "Choose information" : "请选择需求信息"}</option>{Object.entries(templateFieldLabels).map(([field, label]) => <option key={field} value={field}>{labelFor(language, field, label)}</option>)}</select></td><td>{preview ? mapping[key] === "version" ? `v${delivery.version}` : preview.values[key] ?? "—" : "—"}</td></tr>)}</tbody></table></div>
			<button disabled={busy} onClick={() => void perform(async () => { setPreview(await client.previewTemplate(conversationId, template.templateId, delivery.version, mapping)); setConfirmed(false); setSaved(undefined); })}>{en ? "Preview filled content" : "预览填写内容"}</button>
			{preview && <>{preview.errors.map((message) => <p role="alert" key={message}>{message.startsWith("缺少映射：") ? (en ? `Choose what to fill in for ${message.slice(5)}.` : `请为 ${message.slice(5)} 选择对应的需求信息。`) : message.startsWith("必须映射") ? (en ? "Include both the brief version and status in the template." : "请在模板中同时设置需求单版本与状态。") : delivery.status === "stale" ? (en ? "The brief or sources changed. Generate a new version before continuing." : "需求或来源已变化，请重新生成需求单后继续。") : (en ? "Check the template and selected information before generating." : "请核对模板及对应信息后再生成。")}</p>)}{template.format === "xlsx" && <p>{en ? "Formula support is limited. Templates that link to other files or run automatic actions are not accepted. Open the generated file in Excel to calculate formulas and check the results." : "仅支持部分表格公式，不接收关联其他文件或自动执行操作的模板。生成后请在 Excel 中计算公式并核对结果。"}</p>}<label><input type="checkbox" checked={confirmed} disabled={busy || preview.errors.length > 0} onChange={(event) => setConfirmed(event.target.checked)} />{en ? `I checked the template text, selected information, filled values and status for v${delivery.version}.` : `我已核对模板文字、对应信息、填写内容及 v${delivery.version} 的状态。`}</label><button disabled={busy || !confirmed || preview.errors.length > 0} onClick={() => void perform(async () => { const file = await client.generateTemplate(conversationId, preview); setSaved(file); await download(file); })}>{en ? "Save new file and download" : "保存新文件并下载"}</button></>}
			{saved && <p role="status">{en ? "Saved: " : "已保存："}{saved.filename} <button disabled={busy} onClick={() => void perform(() => download(saved))}>{en ? "Download again" : "重新下载"}</button></p>}
		</>}
	</details>;
}
