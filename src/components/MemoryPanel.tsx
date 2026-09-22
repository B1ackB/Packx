import { useEffect, useRef, useState } from "react";
import type { MemoryView, PersonalMemory } from "../enterprise/personalMemory";
import { ConversationClient } from "../runtime/conversationClient";
import type { Language } from "../i18n";
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
			void client.personalMemory(conversationId).then((result) => { if (!stopped && current === epoch.current) setView(result); }).catch((e: Error) => { if (!stopped && current === epoch.current) setError(e.message); });
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
		catch (e) { setError(e instanceof Error ? e.message : "memory_unavailable"); return false; }
		finally { setBusy(false); }
	}
	const reset = () => { setEditing(undefined); setTopic(""); setContent(""); setExpiry(""); };
	return <section className="knowledge-panel" aria-label={en ? "Personal memory" : "个人记忆"}>
		<details><summary>{en ? "Review this task's current requirements and progress" : "整理当前任务的要求与进展"}</summary><TaskCheckpointPanel key={conversationId} conversationId={conversationId} language={language} /></details>
		<p>{en ? "Confirmed preferences and notes are available in your other tasks in this workspace. Review the exact content before confirming. Order specifications still require Fact confirmation." : "确认后的偏好和笔记可用于你在当前工作区的其他任务。请核对具体内容后确认；订单参数仍需单独确认事实。"}</p>
		<p>{en ? "Revising, forgetting, expiry or deleting the source task invalidates old working context. Original chat history remains available. Do not store passwords or keys." : "修订、忘记、到期或删除来源任务后，旧工作上下文会失效，正在执行的任务可能停止并需要重新发起。原始聊天仍保留。请勿存入密码或密钥。"}</p>
		{error && <p role="alert">{({ memory_revision_conflict: en ? "The memory changed; review the latest version." : "记忆版本已变化，请核对最新内容。", memory_topic_conflict: en ? "This topic already exists. Revise that memory instead." : "已有同主题记忆，请修改现有条目。", memory_source_unavailable: en ? "The source is unavailable or expired." : "来源已不可用或记忆已到期。", memory_secret_denied: en ? "Potential secret detected; do not store it." : "检测到疑似密钥或密码，请勿存储。", memory_active_limit: en ? "Active memory limit reached. Forget unused entries first." : "已达有效记忆上限，请先忘记不再需要的条目。" } as Record<string, string>)[error] ?? error}</p>}
		<form onSubmit={(event) => { event.preventDefault(); void command({ action: "propose", draft: { topic, content, ...(expiry ? { expiresAt: new Date(`${expiry}T23:59:59`).toISOString() } : {}) }, ...(editing ? { memoryId: editing.id, revision: editing.revision } : {}) }).then((ok) => { if (ok) reset(); }); }}>
			<strong>{editing ? en ? "Propose a revision" : "提出修订" : en ? "Add a personal memory" : "添加个人记忆"}</strong>
			<label>{en ? "Topic" : "主题"}<input value={topic} maxLength={60} required onChange={(event) => setTopic(event.target.value)} placeholder={en ? "Preferred report style" : "例如：报告表达偏好"} /></label>
			<label>{en ? "Preference or note" : "偏好或笔记"}<textarea value={content} maxLength={600} required rows={4} onChange={(event) => setContent(event.target.value)} placeholder={en ? "Use concise Chinese and list unresolved supplier questions separately." : "例如：请用简洁中文，并单独列出尚待供应商确认的问题。"} /></label>
			<label>{en ? "Expiry (optional)" : "有效期（可选）"}<input type="date" value={expiry} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setExpiry(event.target.value)} /></label>
			<button disabled={busy || !topic.trim() || !content.trim()}>{en ? "Prepare for review" : "生成待确认条目"}</button>
			{editing && <button type="button" onClick={reset}>{en ? "Cancel edit" : "取消编辑"}</button>}
		</form>
		<p>{en ? "Active" : "已确认"} {view?.items.filter((item) => item.activeVersion && item.available).length ?? 0} / {view?.limits.active ?? 16}</p>
		{view?.items.filter((item) => item.status !== "revoked").map((item) => {
			const active = item.versions.find((version) => version.version === item.activeVersion);
			const pending = item.versions.find((version) => version.version === item.pendingVersion);
			return <article className="knowledge-evidence" key={item.id}>
				<strong>{active?.topic ?? pending?.topic}</strong>
				{!item.available && <p role="status">{item.unavailableReason === "expired" ? en ? "Expired; not recalled" : "已到期，不会召回" : en ? "Source unavailable; not recalled" : "来源不可用，不会召回"}</p>}
				{active && <><p>{en ? "Confirmed" : "当前确认版本"} v{active.version}</p><p style={{ whiteSpace: "pre-wrap" }}>{active.content}</p><small>{active.expiresAt ? `${en ? "Expires" : "到期时间"} ${new Date(active.expiresAt).toLocaleString()}` : en ? "Valid until revised or forgotten" : "有效至修订或忘记"}</small></>}
				{pending && <div><p><strong>{en ? "Pending confirmation" : "待你确认"} v{pending.version}</strong></p><p>{pending.topic}</p><p style={{ whiteSpace: "pre-wrap" }}>{pending.content}</p><small>{pending.expiresAt ? new Date(pending.expiresAt).toLocaleString() : en ? "No expiry" : "未设有效期"}</small><p>{en ? "This candidate is not used in other tasks yet." : "此候选尚未用于其他任务；旧确认版本在修订确认前仍有效。"}</p><button disabled={busy} onClick={() => void command({ action: "confirm", memoryId: item.id, revision: item.revision, confirmed: true })}>{en ? "Confirm cross-task use" : "确认用于其他任务"}</button><button disabled={busy} onClick={() => void command({ action: "reject", memoryId: item.id, revision: item.revision })}>{en ? "Reject candidate" : "拒绝候选"}</button></div>}
				<p><small>{en ? "Source task" : "来源任务"}：{(pending ?? active)?.source.runId}</small></p>
				{active && !pending && <button disabled={busy} onClick={() => { setEditing(item); setTopic(active.topic); setContent(active.content); setExpiry(active.expiresAt?.slice(0, 10) ?? ""); }}>{en ? "Revise" : "修订"}</button>}
				<button disabled={busy} onClick={() => void command({ action: "forget", memoryId: item.id, revision: item.revision })}>{en ? "Forget this memory" : "撤回并忘记这条记忆"}</button>
			</article>;
		})}
	</section>;
}
