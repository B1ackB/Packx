import { useEffect, useRef, useState } from "react";
import type { AssetInspectionRecord } from "../runtime/assetInspection";
import { ConversationClient } from "../runtime/conversationClient";
import { inspectionStatusLabels } from "../manufacturing/requirementDelivery";
import { errorText, type Language } from "../i18n";

export const documentWarnings: Record<string, string> = {
	ocr_supplement_may_conflict: "OCR 补充文字可能与文字层冲突，数值以核对原件为准", ocr_requires_review: "OCR 识别结果，需对照原件核对", layout_not_preserved: "表格与阅读顺序未保证", low_ocr_confidence: "部分识别置信度较低", no_text_recognized: "未识别出文字", ocr_failed: "OCR 失败，请重试或提供文字版", ocr_pending: "此页等待下一批 OCR", page_render_failed: "页面渲染失败", invalid_page_bounds: "页面尺寸异常",
};
const client = new ConversationClient();
export function DocumentImportPreview({ conversationId, attachmentId, language }: { conversationId: string; attachmentId: string; language: Language }) {
	const en = language === "en";
	const [document, setDocument] = useState<AssetInspectionRecord>();
	const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	async function inspect(cursor?: string) {
		const current = new AbortController(); controller.current = current;
		setBusy(true); setError("");
		try { setDocument(await client.inspectAttachment(conversationId, attachmentId, current.signal, cursor)); }
		catch (reason) { setError(current.signal.aborted ? en ? "Cancelled. You can resume the last completed batch." : "已取消，可继续上次完成后的批次。" : errorText(reason, language)); }
		finally { setBusy(false); }
	}
	return <details className="document-import-preview"><summary>{en ? "Read / OCR preview" : "导入正文 / OCR 预览"}</summary>
		<button disabled={busy} onClick={() => void inspect()}>{en ? "Read document" : "读取文档"}</button>
		{busy && <><span role="status">{en ? "Reading locally…" : "正在本地读取…"}</span><button onClick={() => controller.current?.abort()}>{en ? "Cancel" : "取消"}</button></>}
		{error && <p role="alert">{error}</p>}
		{document && <><p>{en ? document.inspection.status : inspectionStatusLabels[document.inspection.status]} · {document.inspection.pages.length}{document.inspection.pageCount ? ` / ${document.inspection.pageCount}` : ""} {en ? "pages / sections" : "页 / 区段"}{document.inspection.truncated ? en ? " · Parser limit reached; incomplete content" : " · 达到解析上限，内容不完整" : ""}</p>
			{document.ocrCursor && <p>{en ? `OCR is pending from page ${document.inspection.ocrNextPage}.` : `第 ${document.inspection.ocrNextPage} 页起仍有待识别扫描内容。`} <button disabled={busy} onClick={() => void inspect(document.ocrCursor)}>{en ? "Continue next OCR batch" : "继续下一批 OCR"}</button></p>}
			<p>{en ? "OCR, tables and reading order require comparison with the original. This preview does not confirm facts. Send the attachment to use it in a requirement brief." : "OCR、复杂表格和阅读顺序需对照原件核对。本预览不确认事实；将附件随消息发送后，可用于需求单。"}</p>
			{document.inspection.pages.map((page) => <details key={page.page}><summary>{en ? "Page / section" : "页 / 区段"} {page.page} · {page.method ?? "text"}</summary>{page.warnings?.map((warning) => <p key={warning}>{en ? warning : documentWarnings[warning] ?? warning}</p>)}<pre>{page.text || (en ? "No readable text" : "无可读文字")}</pre></details>)}
		</>}
	</details>;
}
