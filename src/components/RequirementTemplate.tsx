import { useEffect, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import { templateFieldLabels, type RequirementTemplateView, type RequirementTemplatePreview } from "../manufacturing/requirementTemplate";
import type { RequirementDelivery } from "../manufacturing/requirementDelivery";
import { errorText, type Language } from "../i18n";

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
		<p>{en ? "Upload a DOCX or XLSX template (up to 5 MiB). Replace fillable text in your own file with placeholders such as {{customer_name}}. Map each placeholder below. Ordinary blank cells and labels are not automatically recognized." : "上传自己的 DOCX / XLSX 模板（最多 5 MiB）。先在原文件需要填充的位置写入 {{customer_name}} 这样的占位符，再在下方逐项映射。普通空格、空白单元格和字段标签不会被自动识别。"}</p>
		<p>{en ? "Include placeholders for version and delivery status. Word placeholders may span styled runs within one paragraph. Excel placeholders belong in text cells. Formatting and images are retained; review the final layout in Office. Mapping confirmation does not confirm business facts or approve the file." : "请预留版本与交付状态占位符。Word 占位符需在同一段落中；Excel 占位符放在文本单元格内。保留原有样式和图片，生成后请在 Office 核对排版。确认映射不会确认业务事实，也不等于批准该文件。"}</p>
		<p><a href="/templates/packaging-notice.docx" download>{en ? "Word example" : "下载 Word 示例"}</a> · <a href="/templates/packaging-notice.xlsx" download>{en ? "Excel example" : "下载 Excel 示例"}</a></p>
		<label>{en ? "Upload template" : "上传模板"}<input type="file" accept=".docx,.xlsx" disabled={busy} onChange={(event) => {
			const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
			void perform(async () => { if (file.size > 5 * 1024 * 1024) throw new Error(en ? "Template exceeds 5 MiB" : "模板不能超过 5 MiB"); const uploaded = await client.uploadTemplate(conversationId, file); selectTemplate(uploaded); localStorage.setItem(storageKey, uploaded.templateId); });
		}} /></label>
		{error && <p role="alert">{error}</p>}
		{template && <><p>{template.name} · {en ? "Original saved" : "原件已保存"} · SHA-256 {template.sha256.slice(0, 16)}…</p>
			<div className="table-scroll"><table><thead><tr><th>{en ? "Placeholder and location" : "占位符与位置"}</th><th>{en ? "Requirement field" : "需求字段"}</th><th>{en ? "Value preview" : "填充值预览"}</th></tr></thead><tbody>{[...new Set(template.slots.map((slot) => slot.key))].map((key) => <tr key={key}><td><code>{`{{${key}}}`}</code><details><summary>{en ? "Template context" : "模板原文"}</summary>{template.slots.filter((slot) => slot.key === key).map((slot, index) => <p key={index}>{slot.location}<br />{slot.context}</p>)}</details></td><td><select aria-label={`${en ? "Map" : "映射"} ${key}`} disabled={busy} value={mapping[key] ?? ""} onChange={(event) => { setMapping({ ...mapping, [key]: event.target.value }); setPreview(undefined); setConfirmed(false); setSaved(undefined); }}><option value="">{en ? "Select a field" : "请选择字段"}</option>{Object.entries(templateFieldLabels).map(([field, label]) => <option key={field} value={field}>{en ? field : label}</option>)}</select></td><td>{preview?.values[key] ?? "—"}</td></tr>)}</tbody></table></div>
			<button disabled={busy} onClick={() => void perform(async () => { setPreview(await client.previewTemplate(conversationId, template.templateId, delivery.version, mapping)); setConfirmed(false); setSaved(undefined); })}>{en ? "Preview mapped values" : "预览映射与填充值"}</button>
			{preview && <>{preview.errors.map((message) => <p role="alert" key={message}>{message}</p>)}{template.format === "xlsx" && <p>{en ? "Existing formulas are not calculated here. Only a limited set of internal formulas is accepted; external references and active content are refused. Open Excel to recalculate and check the result." : "这里不计算原有公式；仅接收有限的内部公式，拒绝外部引用及主动内容。请在 Excel 打开文件，重算并核对结果。"}</p>}<label><input type="checkbox" checked={confirmed} disabled={busy || preview.errors.length > 0} onChange={(event) => setConfirmed(event.target.checked)} />{en ? `I checked the template text, mapping, values and status for v${delivery.version}.` : `我已核对模板固定文字、字段映射、填充值及 v${delivery.version} 的状态。`}</label><button disabled={busy || !confirmed || preview.errors.length > 0} onClick={() => void perform(async () => { const file = await client.generateTemplate(conversationId, preview); setSaved(file); await download(file); })}>{en ? "Save new file and download" : "保存新文件并下载"}</button></>}
			{saved && <p role="status">{en ? "Saved: " : "已保存："}{saved.filename} <button disabled={busy} onClick={() => void perform(() => download(saved))}>{en ? "Download again" : "重新下载"}</button></p>}
		</>}
	</details>;
}
