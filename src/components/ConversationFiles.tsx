import { errorText } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import type { ConversationFilesView, TaskFileVersion } from "../runtime/conversationFiles";
import type { Language } from "../i18n";

const client = new ConversationClient();
export function ConversationFiles({ conversationId, language }: { conversationId: string; language: Language }) {
	const en = language === "en";
	const [view, setView] = useState<ConversationFilesView>({ files: [], approvals: [] });
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [preview, setPreview] = useState<{ file: TaskFileVersion; content: string }>();
	const alive = useRef(true);
	const approvalCard = useRef<HTMLElement>(null);
	const pendingId = view.approvals[0]?.id;
	useEffect(() => { if (pendingId) approvalCard.current?.scrollIntoView({ block: "nearest" }); }, [pendingId]);
	useEffect(() => {
		alive.current = true;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		async function refresh() {
			try { const next = await client.files(conversationId); if (!stopped) setView(next); }
			catch (cause) { if (!stopped) setError(errorText(cause, language)); }
			if (!stopped) timer = setTimeout(() => void refresh(), 1000);
		}
		void refresh();
		return () => { stopped = true; alive.current = false; clearTimeout(timer); };
	}, [conversationId]);
	async function decide(id: string, decision: "approved" | "rejected") {
		setBusy(true); setError("");
		try { const next = await client.decideFile(conversationId, id, decision); if (alive.current) setView(next); }
		catch (cause) { if (alive.current) setError(errorText(cause, language)); }
		finally { if (alive.current) setBusy(false); }
	}
	async function read(file: TaskFileVersion) {
		setError("");
		try { const next = await client.readFile(conversationId, file.path, file.version); if (alive.current) setPreview(next); }
		catch (cause) { if (alive.current) setError(errorText(cause, language)); }
	}
	function download() {
		if (!preview) return;
		const url = URL.createObjectURL(new Blob([preview.content], { type: "application/octet-stream" }));
		const anchor = document.createElement("a"); anchor.href = url; anchor.download = preview.file.path.split("/").at(-1)!; anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	const paths = [...new Set(view.files.map((file) => file.path))];
	return <section className="conversation-files" aria-label={en ? "Conversation files" : "会话文件区"}>
		{view.approvals.map((approval, index) => <article ref={index === 0 ? approvalCard : undefined} className="file-approval" key={approval.id} aria-live="polite" aria-label={`${en ? "File approval" : "文件审批"} ${approval.path}`}>
			<strong>{en ? `Allow ${approval.operation === "delete" ? "deletion" : approval.before === undefined ? "creation" : "changes"} to this file?` : `是否允许${approval.operation === "delete" ? "删除" : approval.before === undefined ? "新建" : "修改"}此文件？`}</strong>
			<p className="local-path"><strong>{approval.path}</strong></p>
			{approval.sourceVersion !== undefined && <p>{en ? `Restore the content of version ${approval.sourceVersion} as a new version. Current content will be backed up.` : `将历史版本 ${approval.sourceVersion} 的内容恢复为新版本，并保留当前内容备份。`}</p>}
			<p>{approval.path.startsWith("/") ? en ? "This directly operates on the file at this absolute disk path" : "将直接操作此绝对路径的磁盘文件" : en ? "This writes to local conversation storage" : "将写入本机的会话存储"} · {en ? "one-time approval for this change · retain a backup before changes and deletion" : "仅授权本次改动 · 修改和删除前保留备份"}</p>
			<details><summary>{en ? "Review this change" : "查看本次修改内容"}</summary><div className="file-review">
				<div><b>{en ? "Before" : "原内容"}</b><pre>{approval.before ?? (en ? "(File does not exist; it will be created)" : "（文件不存在，将新建）")}</pre></div>
				<div><b>{approval.operation === "delete" ? en ? "After deletion" : "删除后" : en ? "After writing" : "写入后"}</b><pre>{approval.operation === "delete" ? en ? "The original file is deleted; the historical backup remains available to view and download." : "删除原路径的文件，历史备份仍可查看和下载。" : approval.content}</pre></div>
			</div></details>
			<div className="file-actions"><button disabled={busy} onClick={() => void decide(approval.id, "rejected")}>{en ? "Reject" : "拒绝"}</button><button className="file-approve-button" disabled={busy} onClick={() => void decide(approval.id, "approved")}>{en ? `Approve this ${approval.operation === "delete" ? "deletion" : "write"}` : `批准此次${approval.operation === "delete" ? "删除" : "写入"}`}</button></div>
			<small>{en ? "Approval waits for up to two minutes and expires if the task stops. Approve only the displayed content and version." : "审批最多等待两分钟，任务停止后失效。只批准当前显示的内容和版本。"}</small>
		</article>)}
		{error && <p role="alert" className="file-error">{errorText(error, language)}</p>}
		<details className="file-browser"><summary>{en ? "Conversation files" : "会话文件"} · {paths.length} {en ? "paths" : "个路径"}{view.files.some((file) => file.status === "deleted") ? en ? " (including history)" : "（含历史）" : ""}</summary>
			<p>{en ? "Local historical snapshots are saved here. Tell the Agent which path to save or modify; it asks permission before acting. Text is limited to 128 KiB." : "这里保存本机历史快照。直接告诉 Agent 要保存或修改的路径，执行前会询问是否允许。文本最多 128 KiB。"}</p>
			<div className="file-version-list">{paths.map((path) => {
				const versions = view.files.filter((file) => file.path === path);
				return <details key={path}><summary>{path} · v{versions.at(-1)!.version}{versions.at(-1)!.status === "deleted" ? en ? " · deleted" : " · 已删除" : ""}</summary>
					{[...versions].reverse().map((file) => <div className="file-version" key={file.version}><span>v{file.version} · {file.status === "deleted" ? en ? "Deletion record" : "删除记录" : `${(file.size / 1024).toFixed(1)} KiB`}</span>{file.status !== "deleted" && <button onClick={() => void read(file)}>{en ? `View v${file.version}` : `查看 v${file.version}`}</button>}</div>)}
				</details>;
			})}</div>
			{preview && <div className="file-preview"><div className="file-actions"><strong>{preview.file.path} · v{preview.file.version}</strong><button onClick={download}>{en ? "Download this version" : "下载此版本"}</button><button onClick={() => setPreview(undefined)}>{en ? "Close preview" : "关闭预览"}</button></div><p className="local-path">{en ? "Local historical snapshot" : "本机历史快照"}：{preview.file.storagePath}</p><pre>{preview.content}</pre></div>}
		</details>
	</section>;
}
