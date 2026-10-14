import { useEffect, useRef, useState } from "react";
import type { AssetInspectionRecord } from "../runtime/assetInspection";
import { ConversationClient } from "../runtime/conversationClient";
import { documentMethodText, documentWarningText, errorText, statusFor, type Language } from "../i18n";
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
		catch (reason) { setError(current.signal.aborted ? en ? "Stopped. You can continue from the last page read." : "已停止，可从上次读完的位置继续。" : errorText(reason, language)); }
		finally { setBusy(false); }
	}
	return <details className="document-import-preview"><summary>{en ? "Preview document text" : "预览文档内容"}</summary>
		<button disabled={busy} onClick={() => void inspect()}>{en ? "Read document" : "读取文档"}</button>
		{busy && <><span role="status">{en ? "Reading locally…" : "正在本地读取…"}</span><button onClick={() => controller.current?.abort()}>{en ? "Cancel" : "取消"}</button></>}
		{error && <p role="alert">{error}</p>}
		{document && <><p>{statusFor(language, document.inspection.status, en ? "Needs review" : "待核对")} · {document.inspection.pages.length}{document.inspection.pageCount ? ` / ${document.inspection.pageCount}` : ""} {en ? "pages / sections" : "页 / 区段"}{document.inspection.truncated ? en ? " · Only part of the document is shown" : " · 当前仅显示部分内容" : ""}</p>
			{document.ocrCursor && <p>{en ? `Text recognition is pending from page ${document.inspection.ocrNextPage}.` : `第 ${document.inspection.ocrNextPage} 页起仍有待识别的内容。`} <button disabled={busy} onClick={() => void inspect(document.ocrCursor)}>{en ? "Read remaining pages" : "继续识别后续页面"}</button></p>}
			<p>{en ? "Check recognized text, tables and reading order against the original. Previewing does not confirm information. Send the attachment with a message to use it in the brief." : "请对照原件核对识别文字、表格和阅读顺序。预览不代表确认信息；将附件随消息发送后，可用于需求单。"}</p>
			{document.inspection.pages.map((page) => <details key={page.page}><summary>{en ? "Page / section" : "页 / 区段"} {page.page} · {documentMethodText(page.method, language)}</summary>{page.warnings?.map((warning) => <p key={warning}>{documentWarningText(warning, language)}</p>)}<pre>{page.text || (en ? "No readable text" : "无可读文字")}</pre></details>)}
		</>}
	</details>;
}
