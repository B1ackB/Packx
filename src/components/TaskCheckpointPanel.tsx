import { useEffect, useRef, useState } from "react";
import type { TaskCheckpointDraft, TaskCheckpointView } from "../enterprise/taskCheckpoint";
import { ConversationClient } from "../runtime/conversationClient";
import type { Language } from "../i18n";

const client = new ConversationClient();
const empty: TaskCheckpointDraft = { objective: "", constraints: [], openQuestions: [], progressNotes: "" };

export function TaskCheckpointPanel({ conversationId, language }: { conversationId: string; language: Language }) {
	const en = language === "en";
	const [view, setView] = useState<TaskCheckpointView>();
	const [draft, setDraft] = useState<TaskCheckpointDraft>(empty);
	const [constraints, setConstraints] = useState("");
	const [questions, setQuestions] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const pendingCommand = useRef<{ body: string; requestId: string } | undefined>(undefined);
	const epoch = useRef(0);
	const activeConversation = useRef(conversationId);
	activeConversation.current = conversationId;
	useEffect(() => {
		let stopped = false;
		setView(undefined); setDraft(empty); setConstraints(""); setQuestions(""); setBusy(false); setError(""); pendingCommand.current = undefined;
		const refresh = () => {
			const current = ++epoch.current;
			void client.taskCheckpoint(conversationId).then((result) => { if (!stopped && current === epoch.current) setView(result); }).catch(() => { if (!stopped) setError(en ? "Unable to load task review." : "暂时无法读取阶段整理。"); });
		};
		refresh(); const timer = window.setInterval(refresh, 3000);
		return () => { stopped = true; window.clearInterval(timer); };
	}, [conversationId, en]);
	async function command(payload: Record<string, unknown>) {
		if (!view) return;
		setBusy(true); setError("");
		const value = { ...payload, revision: view.revision }, body = JSON.stringify(value);
		if (pendingCommand.current?.body !== body) pendingCommand.current = { body, requestId: crypto.randomUUID() };
		try {
			const result = await client.taskCheckpointCommand(conversationId, { ...value, requestId: pendingCommand.current.requestId });
			if (activeConversation.current !== conversationId) return;
			epoch.current++; setView(result); pendingCommand.current = undefined;
		} catch (e) {
			if (activeConversation.current !== conversationId) return;
			const code = e instanceof Error ? e.message : "";
			setError(code.includes("source_changed") || code.includes("revision_conflict") ? en ? "The conversation changed. Review the latest messages and prepare a new draft." : "对话或整理版本已变化，请核对最新消息后重新整理。" : en ? "Unable to save. Check the fields and retry; each item is limited to 400 characters." : "保存未成功，请核对内容后重试；每条约束或待办最多 400 字。计划模式下请先退出计划模式再整理。");
		} finally { if (activeConversation.current === conversationId) setBusy(false); }
	}
	const active = view?.versions.find((item) => item.status === "active");
	const pending = view?.versions.find((item) => item.status === "proposed");
	const render = (value: TaskCheckpointDraft) => <><p><strong>{en ? "Goal" : "当前目标"}</strong>：{value.objective}</p><p><strong>{en ? "Active constraints" : "仍有效的要求"}</strong></p><ul>{value.constraints.map((item, i) => <li key={i}>{item}</li>)}</ul><p><strong>{en ? "Open questions" : "待解决事项"}</strong></p><ul>{value.openQuestions.map((item, i) => <li key={i}>{item}</li>)}</ul><p><strong>{en ? "Progress notes" : "进展笔记"}</strong>：{value.progressNotes || "—"}</p></>;
	return <section className="knowledge-panel" aria-label={en ? "Task review" : "任务阶段整理"}>
		<p>{en ? "Review the current goal and every still-active requirement. Once confirmed, this record replaces earlier conversational instructions for this task. Original messages remain readable; order facts and approvals keep their separate confirmation." : "请整理当前目标，并保留所有仍有效的要求。确认后，此记录将替代此前的对话要求；原始消息仍可回读，订单事实与审批仍需单独确认。"}</p>
		<p>{en ? "Progress notes help continue work; they do not prove a stage is completed. Confirming during execution may stop that step so it can continue with the updated requirements." : "进展笔记用于继续工作，不代表阶段已经验收完成。执行中确认新版本可能使当前步骤停止，需要按新要求继续。"}</p>
		{view?.needsReview && <p role="status">{en ? "The discussion is getting long. Review the task now to make room for the next stage." : "当前讨论较长，建议整理本阶段，为后续工作保留空间。"}</p>}
		{error && <p role="alert">{error}</p>}
		{active && <details><summary>{en ? "Current confirmed review" : "当前确认记录"} v{active.version}</summary>{render(active)}</details>}
		{pending ? <article className="knowledge-evidence"><strong>{en ? "Review before applying" : "请核对后再应用"} v{pending.version}</strong>{render(pending)}<p>{en ? "Check this against the original conversation and previous review, including requirements you still need. Confirmation replaces the previous review and earlier conversational requirements." : "请对照原始对话和上一版逐项核对，确认没有遗漏仍需遵守的要求。应用后将替代上一版及更早的对话要求。"}</p><button disabled={busy} onClick={() => void command({ action: "confirm", confirmed: true })}>{en ? "Confirm and use this review" : "确认完整，应用阶段整理"}</button><button disabled={busy} onClick={() => void command({ action: "reject" })}>{en ? "Reject and edit again" : "拒绝，重新整理"}</button></article> : <form onSubmit={(event) => {
			event.preventDefault();
			void command({ action: "propose", sourceDigest: view?.sourceDigest, draft: { ...draft, constraints: constraints.split("\n").map((item) => item.trim()).filter(Boolean), openQuestions: questions.split("\n").map((item) => item.trim()).filter(Boolean) } });
		}}>
			{active && <button type="button" onClick={() => { setDraft({ objective: active.objective, constraints: active.constraints, openQuestions: active.openQuestions, progressNotes: active.progressNotes }); setConstraints(active.constraints.join("\n")); setQuestions(active.openQuestions.join("\n")); }}>{en ? "Start from current review" : "以上一版为基础修改"}</button>}
			<label>{en ? "Current goal" : "当前目标"}<textarea required maxLength={1000} value={draft.objective} onChange={(event) => setDraft({ ...draft, objective: event.target.value })} /></label>
			<label>{en ? "Active requirements — one per line, up to 20" : "仍有效的要求：每行一条，最多 20 条"}<textarea rows={5} value={constraints} onChange={(event) => setConstraints(event.target.value)} /></label>
			<label>{en ? "Open questions — one per line, up to 10" : "待解决事项：每行一条，最多 10 条"}<textarea rows={3} value={questions} onChange={(event) => setQuestions(event.target.value)} /></label>
			<label>{en ? "Progress and where to find the results" : "已有进展及成果位置"}<textarea rows={3} maxLength={1500} value={draft.progressNotes} onChange={(event) => setDraft({ ...draft, progressNotes: event.target.value })} /></label>
			<button disabled={busy || !view?.userMessageCount}>{en ? "Prepare review" : "生成待确认记录"}</button>
		</form>}
	</section>;
}
