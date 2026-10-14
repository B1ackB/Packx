import type { AssetInspectionRecord } from "../runtime/assetInspection";
import { documentMethodText, documentWarningText, errorText } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import type { LocalDirectoryListing, LocalFileLocations } from "../runtime/conversationFiles";
import type { Language } from "../i18n";
const client = new ConversationClient();

function FileIcon({ folder = false }: { folder?: boolean }) {
	return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={folder ? "M3 7V5h6l2 2h10v13H3V7Z" : "M14 3H5v18h14V8l-5-5ZM14 3v5h5"} /></svg>;
}
function Directory({ conversationId, path, name, openFile, selectedPath, language, initiallyOpen = false }: { conversationId: string; path: string; name: string; openFile: (path: string) => void; selectedPath?: string; language: Language; initiallyOpen?: boolean }) {
	const en = language === "en";
	const [open, setOpen] = useState(initiallyOpen), [listing, setListing] = useState<LocalDirectoryListing>(), [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const mounted = useRef(true);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	useEffect(() => {
		if (!open || listing) return;
		let stopped = false;
		client.browseDirectory(conversationId, path).then((next) => { if (!stopped) { setListing(next); setError(""); } }).catch((cause) => { if (!stopped) setError(errorText(cause, language)); });
		return () => { stopped = true; };
	}, [conversationId, path, open, listing]);
	async function loadMore(restart = false) {
		setBusy(true); setError("");
		try {
			const next = await client.browseDirectory(conversationId, path, restart ? undefined : listing?.nextAfter);
			if (mounted.current) setListing((current) => ({ ...next, entries: [...new Map([...(restart ? [] : current?.entries ?? []), ...next.entries].map((entry) => [entry.absolutePath, entry])).values()] }));
		} catch (cause) { if (mounted.current) setError(errorText(cause, language)); }
		finally { if (mounted.current) setBusy(false); }
	}
	return <details className="file-tree-directory" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
		<summary title={path}><span className="file-name"><FileIcon folder /><span>{name}</span></span>{listing && <small>{listing.total}</small>}</summary>
		{error && <p role="alert" className="file-error">{errorText(error, language)} <button onClick={() => void loadMore(true)} disabled={busy}>{en ? "Retry" : "重试"}</button></p>}
		{open && !listing && !error && <p className="panel-note">{en ? "Loading…" : "加载中…"}</p>}
		{listing && <div className="file-tree-children">
			{listing.entries.map((entry) => entry.kind === "directory"
				? <Directory key={entry.absolutePath} conversationId={conversationId} path={entry.absolutePath} name={entry.name} openFile={openFile} selectedPath={selectedPath} language={language} />
				: <button key={entry.absolutePath} className={`file-tree-file${selectedPath === entry.absolutePath ? " selected" : ""}`} title={entry.absolutePath} onClick={() => openFile(entry.absolutePath)}><span className="file-name"><FileIcon /><span>{entry.name}</span></span><small>{entry.size < 1024 ? `${entry.size} B` : entry.size < 1024 * 1024 ? `${(entry.size / 1024).toFixed(1)} KB` : `${(entry.size / 1024 / 1024).toFixed(1)} MB`}</small></button>)}
			{!listing.entries.length && <p className="panel-note">{en ? "No accessible files" : "暂无可访问的文件"}</p>}
			{listing.truncated && <div className="file-pagination"><small>{en ? "Showing" : "已显示"} {listing.entries.length} / {listing.total}</small><button disabled={busy} onClick={() => void loadMore()}>{busy ? en ? "Loading…" : "加载中…" : en ? "Load more" : "加载更多"}</button></div>}
		</div>}
	</details>;
}
export function FileExplorer({ conversationId, onUseFile, language }: { conversationId: string; onUseFile: (path: string) => void; language: Language }) {
	const en = language === "en";
	const [locations, setLocations] = useState<LocalFileLocations>();
	const [input, setInput] = useState(""); const [root, setRoot] = useState(""); const [revision, setRevision] = useState(0);
	const [preview, setPreview] = useState<{ path: string; content: string; version?: number; document?: AssetInspectionRecord }>();
	const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
	const requestId = useRef(0);
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => { listRef.current?.querySelector(".file-tree-file.selected")?.scrollIntoView({ block: "nearest" }); }, [preview?.path]);
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
		const heading = result.status === "parsed" ? (en ? "Extracted document text" : "提取的文档正文") : result.status === "needs_ocr" ? (en ? "Text recognition is needed to read this file." : "此文件需要先识别文字。") : (en ? "This format is not supported. Convert DOC/XLS to DOCX/XLSX." : "暂不支持此格式，请将 DOC/XLS 转为 DOCX/XLSX。");
		return `${heading}${result.truncated ? (en ? " · Excerpt" : " · 部分内容") : ""}\n\n${result.pages.map((page) => `${en ? "Page / section" : "页 / 区段"} ${page.page} · ${documentMethodText(page.method, language)}${page.warnings?.length ? ` · ${page.warnings.map((warning) => documentWarningText(warning, language)).join(" · ")}` : ""}\n${page.text}`).join("\n\n")}`;
	}
	function browse(path: string) { requestId.current++; setBusy(false); setPreview(undefined); setError(""); setInput(path); setRoot(path); setRevision((value) => value + 1); }
	const parent = root.slice(0, root.lastIndexOf("/"));
	const recent = locations ? [...new Map(locations.files.map((file) => [file.path, file])).values()].filter((file) => file.status !== "deleted").reverse() : [];
	return <section className="file-explorer" aria-label={en ? "Local file browser" : "本地文件浏览器"}>
		<div className="file-explorer-toolbar">
			<div className="file-location-shortcuts">{locations && Object.entries(locations.locations).map(([key, path]) => <button key={key} className={root === path ? "selected" : ""} title={path} onClick={() => browse(path)}>{({ homeDirectory: en ? "Home" : "主目录", workingDirectory: en ? "Workspace" : "工作目录", documentsDirectory: en ? "Documents" : "文档", desktopDirectory: en ? "Desktop" : "桌面" } as Record<string, string>)[key] ?? key}</button>)}</div>
			<div className="file-navigation"><button disabled={!parent} onClick={() => browse(parent)} aria-label={en ? "Parent folder" : "返回上级目录"}>↑</button><span className="local-path" title={root}>{root}</span><button onClick={() => { setRevision((value) => value + 1); if (preview) void openFile(preview.path, preview.version); }}>{en ? "Refresh" : "刷新"}</button></div>
			<details className="file-path-entry"><summary>{en ? "Go to a path" : "输入路径"}</summary><form onSubmit={(event) => { event.preventDefault(); browse(input.trim()); }}><label className="panel-field">{en ? "File or folder path" : "文件或文件夹路径"}<input aria-label={en ? "Path to browse" : "浏览路径"} value={input} onChange={(event) => setInput(event.target.value)} placeholder="/Users/…/Documents" required /></label><div className="file-actions"><button disabled={!input.trim()}>{en ? "Open folder" : "打开文件夹"}</button><button type="button" disabled={!input.trim()} onClick={() => void openFile(input.trim())}>{en ? "Open file" : "打开文件"}</button></div></form></details>
		</div>
		{error && <p role="alert" className="file-error">{errorText(error, language)}</p>}{busy && <p role="status">{en ? "Opening file…" : "正在打开文件…"}</p>}
		<div className="file-list-scroll" ref={listRef}>
			{root && <div className="file-tree" aria-label={en ? "File tree" : "文件树"}><Directory key={`${root}:${revision}`} conversationId={conversationId} path={root} name={root.split("/").at(-1) || root} openFile={(path) => void openFile(path)} selectedPath={preview?.path} language={language} initiallyOpen /></div>}
			{recent.length > 0 && <details className="recent-files"><summary>{en ? "Task files" : "任务文件"} · {recent.length}</summary>{recent.map((file) => <button className="file-tree-file" key={file.path} title={file.path} onClick={() => void openFile(file.path, file.absolutePath ? undefined : file.version)}><span className="file-name"><FileIcon /><span>{file.path.split("/").at(-1)}</span></span></button>)}</details>}
		</div>
		{preview && <div className="explorer-preview"><div className="section-title"><strong>{en ? "File contents" : "文件内容"}{preview.version ? `${en ? " · saved version" : " · 已保存版本"} v${preview.version}` : ""}</strong><button onClick={() => { requestId.current++; setPreview(undefined); setBusy(false); }}>{en ? "Close preview" : "关闭预览"}</button></div><p className="explorer-file-name" title={preview.path}>{preview.path.split("/").at(-1)}</p><details className="file-source-path"><summary>{en ? "File location" : "文件位置"}</summary><small className="local-path">{preview.path}</small></details><div className="file-actions"><button onClick={() => onUseFile(preview.path)}>{en ? "Use in conversation" : "加入对话"}</button></div>{preview.document?.ocrCursor && <button disabled={busy} onClick={() => void continueOcr()}>{en ? "Read remaining pages" : "继续识别后续页面"}</button>}<pre>{preview.document ? documentText(preview.document) : preview.content || (en ? "(Empty file)" : "（空文件）")}</pre></div>}
		<details className="file-help"><summary>{en ? "File access" : "文件访问说明"}</summary><p>{en ? "Hidden files, passwords and protected files are excluded. Changes and deletion need approval. Larger files may show only part of their contents; check the original for layout." : "隐藏文件、密码及受保护内容不展示。修改与删除需批准。较大文件可能只显示部分内容，排版请以原文件为准。"}</p></details>
	</section>;
}
