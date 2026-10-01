import type { AssetInspectionRecord } from "../runtime/assetInspection";
import { errorText } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import type { LocalDirectoryListing, LocalFileLocations } from "../runtime/conversationFiles";
import type { Language } from "../i18n";
const client = new ConversationClient();

function Directory({ conversationId, path, name, openFile, language, initiallyOpen = false }: { conversationId: string; path: string; name: string; openFile: (path: string) => void; language: Language; initiallyOpen?: boolean }) {
	const en = language === "en";
	const [open, setOpen] = useState(initiallyOpen), [listing, setListing] = useState<LocalDirectoryListing>(), [error, setError] = useState("");
	useEffect(() => {
		if (!open || listing) return;
		let stopped = false;
		client.browseDirectory(conversationId, path).then((next) => { if (!stopped) { setListing(next); setError(""); } }).catch((cause) => { if (!stopped) setError(errorText(cause, language)); });
		return () => { stopped = true; };
	}, [conversationId, path, open, listing]);
	return <details className="file-tree-directory" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary title={path}>▣ {name}</summary>{error && <p role="alert" className="file-error">{errorText(error, language)}</p>}{open && !listing && !error && <p>{en ? "Reading directory…" : "正在读取目录…"}</p>}{listing && <div className="file-tree-children">{listing.entries.map((entry) => entry.kind === "directory" ? <Directory key={entry.absolutePath} conversationId={conversationId} path={entry.absolutePath} name={entry.name} openFile={openFile} language={language} /> : <button key={entry.absolutePath} className="file-tree-file" title={entry.absolutePath} onClick={() => openFile(entry.absolutePath)}>▤ {entry.name}</button>)}{!listing.entries.length && <small>{en ? "The directory is empty or contains no viewable files" : "目录为空或没有可查看的文件"}</small>}{listing.truncated && <small>{en ? "Only the first 200 items are shown. Open a subdirectory." : "只显示前 200 项，请打开具体子目录。"}</small>}</div>}</details>;
}
export function FileExplorer({ conversationId, onUseFile, language }: { conversationId: string; onUseFile: (path: string) => void; language: Language }) {
	const en = language === "en";
	const [locations, setLocations] = useState<LocalFileLocations>();
	const [input, setInput] = useState(""); const [root, setRoot] = useState(""); const [revision, setRevision] = useState(0);
	const [preview, setPreview] = useState<{ path: string; content: string; version?: number; document?: AssetInspectionRecord }>();
	const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
	const requestId = useRef(0);
	useEffect(() => {
		let stopped = false;
		client.fileLocations(conversationId).then((next) => { if (!stopped) { setLocations(next); setRoot((value) => value || next.locations.workingDirectory); setInput((value) => value || next.locations.workingDirectory); } }).catch((cause) => { if (!stopped) setError(errorText(cause, language)); });
		return () => { stopped = true; };
	}, [conversationId, revision]);
	useEffect(() => () => { requestId.current++; }, [conversationId]);
	async function openFile(path: string, version?: number) {
		const id = ++requestId.current; setBusy(true); setError(""); setPreview(undefined);
		try {
			if (version === undefined && /\.(pdf|docx?|xlsx?)$/i.test(path)) {
				const document = await client.readDocument(conversationId, path);
				if (id === requestId.current) setPreview({ path, content: "", document });
				return;
			}
			const result = version === undefined ? await client.readLocalFile(conversationId, path) : await client.readFile(conversationId, path, version);
			if (id === requestId.current) setPreview({ path, content: result.content, version });
		} catch (cause) { if (id === requestId.current) setError(errorText(cause, language)); }
		finally { if (id === requestId.current) setBusy(false); }
	}
	async function continueOcr() {
		if (!preview?.document?.ocrCursor) return;
		const current = preview, id = ++requestId.current; setBusy(true); setError("");
		try {
			const document = await client.readDocument(conversationId, current.path, current.document!.ocrCursor);
			if (id === requestId.current) setPreview({ ...current, document });
		} catch (cause) { if (id === requestId.current) setError(errorText(cause, language)); }
		finally { if (id === requestId.current) setBusy(false); }
	}
	function documentText(document: AssetInspectionRecord): string {
		const result = document.inspection;
		const heading = result.status === "parsed" ? (en ? "Extracted document text" : "提取的文档正文") : result.status === "needs_ocr" ? (en ? "No text layer: OCR is required." : "没有文字层，需要 OCR。") : (en ? "This format is not supported. Convert DOC/XLS to DOCX/XLSX." : "暂不支持此格式，请将 DOC/XLS 转为 DOCX/XLSX。");
		return `${heading}${result.truncated ? (en ? " · Truncated" : " · 已截断") : ""}\nSHA-256: ${document.sha256}\n\n${result.pages.map((page) => `${en ? "Page / section" : "页 / 区段"} ${page.page} · ${page.method ?? "text"}${page.warnings?.length ? ` · ${page.warnings.join(" · ")}` : ""}\n${page.text}`).join("\n\n")}`;
	}
	function browse(path: string) { requestId.current++; setBusy(false); setPreview(undefined); setError(""); setInput(path); setRoot(path); setRevision((value) => value + 1); }
	const recent = locations ? [...new Map(locations.files.map((file) => [file.path, file])).values()].filter((file) => file.status !== "deleted").slice(-12).reverse() : [];
	return <section className="file-explorer" aria-label={en ? "Local file browser" : "本地文件浏览器"}>
		<form onSubmit={(event) => { event.preventDefault(); browse(input.trim()); }}><label className="panel-field">{en ? "Absolute file or directory path" : "文件或目录绝对路径"}<input aria-label={en ? "Path to browse" : "浏览路径"} value={input} onChange={(event) => setInput(event.target.value)} placeholder="/Users/…/Documents" required /></label><div className="file-actions"><button disabled={!input.trim()}>{en ? "Open directory" : "打开目录"}</button><button type="button" disabled={!input.trim()} onClick={() => void openFile(input.trim())}>{en ? "Open file" : "打开文件"}</button><button type="button" onClick={() => { setRevision((value) => value + 1); if (preview) void openFile(preview.path, preview.version); }}>{en ? "Refresh" : "刷新"}</button></div></form>
		<div className="file-location-shortcuts">{locations && Object.entries(locations.locations).map(([key, path]) => <button key={key} title={path} onClick={() => browse(path)}>{({ homeDirectory: en ? "Home" : "主目录", workingDirectory: en ? "Workspace" : "工作目录", documentsDirectory: en ? "Documents" : "文档", desktopDirectory: en ? "Desktop" : "桌面" } as Record<string, string>)[key] ?? key}</button>)}</div>
		<p className="panel-note">{en ? "Read local files directly without approval. To modify one, give it to the Agent; writing and deletion still need your one-time approval. Text previews are limited to 128 KiB. PDF, DOCX and XLSX show extracted text (up to 10 MiB per file); layout is not preserved." : "直接查看本机文件，读取无需审批。要修改文件，可交给 Agent；写入与删除仍需你单次批准。文本预览最多 128 KiB；PDF、DOCX、XLSX 可查看提取正文（单文件最多 10 MiB），不保留原始排版。"}</p>
		{error && <p role="alert" className="file-error">{errorText(error, language)}</p>}{busy && <p role="status">{en ? "Opening file…" : "正在打开文件…"}</p>}
		{preview && <div className="explorer-preview"><div className="section-title"><strong>{en ? "File contents" : "文件内容"}{preview.version ? `${en ? " · snapshot" : " · 快照"} v${preview.version}` : ""}</strong><button onClick={() => { requestId.current++; setPreview(undefined); setBusy(false); }}>{en ? "Close preview" : "关闭预览"}</button></div><p className="local-path">{preview.path}</p><div className="file-actions"><button onClick={() => onUseFile(preview.path)}>{en ? "Give to Agent" : "交给 Agent"}</button></div>{preview.document?.ocrCursor && <button disabled={busy} onClick={() => void continueOcr()}>{en ? "Continue next OCR batch" : "继续下一批 OCR"}</button>}<pre>{preview.document ? documentText(preview.document) : preview.content || (en ? "(Empty file)" : "（空文件）")}</pre></div>}
		{recent.length > 0 && <details className="recent-files"><summary>{en ? "Recently used files" : "最近操作的文件"}</summary>{recent.map((file) => <button className="file-tree-file" key={file.path} title={file.path} onClick={() => void openFile(file.path, file.absolutePath ? undefined : file.version)}>{file.path.split("/").at(-1)}</button>)}</details>}
		{root && <div className="file-tree" aria-label={en ? "File tree" : "文件树"}><p className="local-path">{root}</p><Directory key={`${root}:${revision}`} conversationId={conversationId} path={root} name={root.split("/").at(-1) || root} openFile={(path) => void openFile(path)} language={language} initiallyOpen /></div>}
	</section>;
}
