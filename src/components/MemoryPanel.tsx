import { useEffect, useRef, useState } from "react";
import type { MemoryView, PersonalMemory } from "../enterprise/personalMemory";
import { ConversationClient } from "../runtime/conversationClient";
import { errorText, type Language } from "../i18n";
import "./knowledge.css";
import { TaskCheckpointPanel } from "./TaskCheckpointPanel";

const client = new ConversationClient();
export function MemoryPanel({ conversationId, language }: { conversationId: string; language: Language }) {
	const en = language === "en";
	const [view, setView] = useState<MemoryView>();
	const [topic, setTopic] = useState("");
	const [content, setContent] = useState("");
	const [expiry, setExpiry] = useState("");
	const [editing, setEditing] = useState<PersonalMemory>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const pendingCommand = useRef<{ payload: string; requestId: string } | undefined>(undefined);
	const epoch = useRef(0);
	useEffect(() => {
		let stopped = false;
		const refresh = () => {
			const current = ++epoch.current;
			void client.personalMemory(conversationId).then((result) => { if (!stopped && current === epoch.current) setView(result); }).catch((e: Error) => { if (!stopped && current === epoch.current) setError(errorText(e, language)); });
		};
		refresh(); const timer = window.setInterval(refresh, 2000);
		return () => { stopped = true; window.clearInterval(timer); };
	}, [conversationId]);
	async function command(payload: Record<string, unknown>) {
		setBusy(true); setError("");
		const serialized = JSON.stringify(payload);
		if (pendingCommand.current?.payload !== serialized) pendingCommand.current = { payload: serialized, requestId: crypto.randomUUID() };
		try {
			const result = await client.memoryCommand(conversationId, { ...payload, requestId: pendingCommand.current.requestId });
			epoch.current++; setView(result); pendingCommand.current = undefined; return true;
		}
		catch (e) { setError(errorText(e, language)); return false; }
		finally { setBusy(false); }
	}
	const reset = () => { setEditing(undefined); setTopic(""); setContent(""); setExpiry(""); };
	return <section className="knowledge-panel" aria-label={en ? "Personal memory" : "个人记忆"}>
		<p className="panel-intro">{en ? "Save preferences for your other tasks in this workspace. Confirm each entry before use." : "保存偏好，确认后用于当前工作区的其他任务。"}</p>
		{error && <p role="alert">{errorText(error, language)}</p>}
		<form onSubmit={(event) => { event.preventDefault(); void command({ action: "propose", draft: { topic, content, ...(expiry ? { expiresAt: new Date(`${expiry}T23:59:59`).toISOString() } : {}) }, ...(editing ? { memoryId: editing.id, revision: editing.revision } : {}) }).then((ok) => { if (ok) reset(); }); }}>
			<strong>{editing ? en ? "Revise memory" : "修订记忆" : en ? "New memory" : "添加记忆"}</strong>
			<label>{en ? "Topic" : "主题"}<input value={topic} maxLength={60} required onChange={(event) => setTopic(event.target.value)} placeholder={en ? "Preferred report style" : "例如：报告表达偏好"} /></label>
			<label>{en ? "Preference or note" : "偏好或笔记"}<textarea value={content} maxLength={600} required rows={3} onChange={(event) => setContent(event.target.value)} placeholder={en ? "Use concise Chinese and list open questions." : "例如：用简洁中文，单独列出待确认的问题。"} /></label>
			<label>{en ? "Expiry (optional)" : "有效期（可选）"}<input type="date" value={expiry} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setExpiry(event.target.value)} /></label>
			<small>{en ? "Do not store passwords or keys. Order details need separate confirmation." : "请勿存入密码或密钥；订单参数需单独确认。"}</small>
			<button className="primary-action" disabled={busy || !topic.trim() || !content.trim()}>{en ? "Prepare for review" : "添加待确认条目"}</button>
			{editing && <button type="button" onClick={reset}>{en ? "Cancel edit" : "取消编辑"}</button>}
		</form>
		<p>{en ? "Active" : "已确认"} {view?.items.filter((item) => item.activeVersion && item.available).length ?? 0} / {view?.limits.active ?? 16}</p>
		{view?.items.filter((item) => item.status !== "revoked").map((item) => {
			const active = item.versions.find((version) => version.version === item.activeVersion);
			const pending = item.versions.find((version) => version.version === item.pendingVersion);
			return <article className="knowledge-evidence" key={item.id}>
				<strong>{active?.topic ?? pending?.topic}</strong>
				{!item.available && <p role="status">{item.unavailableReason === "expired" ? en ? "Expired; no longer used" : "已到期，不再使用" : en ? "Source unavailable; no longer used" : "来源不可用，不再使用"}</p>}
				{active && <><p>{en ? "Confirmed" : "当前确认版本"} v{active.version}</p><p style={{ whiteSpace: "pre-wrap" }}>{active.content}</p><small>{active.expiresAt ? `${en ? "Expires" : "到期时间"} ${new Date(active.expiresAt).toLocaleString()}` : en ? "Valid until revised or forgotten" : "有效至修订或忘记"}</small></>}
				{pending && <div><p><strong>{en ? "Pending confirmation" : "待你确认"} v{pending.version}</strong></p><p>{pending.topic}</p><p style={{ whiteSpace: "pre-wrap" }}>{pending.content}</p><small>{pending.expiresAt ? new Date(pending.expiresAt).toLocaleString() : en ? "No expiry" : "未设有效期"}</small><p>{en ? "This candidate is not used in other tasks yet." : "此候选尚未用于其他任务；旧确认版本在修订确认前仍有效。"}</p><button disabled={busy} onClick={() => void command({ action: "confirm", memoryId: item.id, revision: item.revision, confirmed: true })}>{en ? "Confirm cross-task use" : "确认用于其他任务"}</button><button disabled={busy} onClick={() => void command({ action: "reject", memoryId: item.id, revision: item.revision })}>{en ? "Reject candidate" : "拒绝候选"}</button></div>}
				<p><small>{en ? "Source" : "来源"}：{(pending ?? active)?.source.runId === conversationId ? (en ? "This task" : "当前任务") : (en ? "Another task in this workspace" : "当前工作区的其他任务")}</small></p>
				{active && !pending && <button disabled={busy} onClick={() => { setEditing(item); setTopic(active.topic); setContent(active.content); setExpiry(active.expiresAt?.slice(0, 10) ?? ""); }}>{en ? "Revise" : "修订"}</button>}
				<button disabled={busy} onClick={() => void command({ action: "forget", memoryId: item.id, revision: item.revision })}>{en ? "Forget this memory" : "撤回并忘记这条记忆"}</button>
			</article>;
		})}
		<details><summary>{en ? "Task progress" : "当前任务进展"}</summary><TaskCheckpointPanel key={conversationId} conversationId={conversationId} language={language} /></details>
		<details className="panel-disclosure"><summary>{en ? "Memory usage" : "记忆使用说明"}</summary>
			<p>{en ? "Revising, forgetting, expiry or deleting the source task stops use of the old preference. Running tasks may need to be restarted. Your original conversation is retained." : "修订、忘记、到期或删除来源任务后，旧偏好不再用于后续处理。正在执行的任务可能需要重新开始，原聊天记录仍保留。"}</p>
		</details>
	</section>;
}
