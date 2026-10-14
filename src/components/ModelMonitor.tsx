import { errorText } from "../i18n";
import { useEffect, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import { summarizeModelCalls, type ModelTelemetryView } from "../runtime/modelTelemetry";
import type { Language } from "../i18n";

const client = new ConversationClient();
const statusLabels = { running: "等待响应", succeeded: "成功", failed: "失败", cancelled: "已取消", interrupted: "执行中断" };
const statusLabelsEn = { running: "Awaiting response", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" };
export function ModelMonitor({ conversationId, language }: { conversationId: string; language: Language }) {
	const en = language === "en";
	const status = (value: keyof typeof statusLabels) => en ? statusLabelsEn[value] : statusLabels[value];
	const [requirement, setRequirement] = useState(false);
	const [view, setView] = useState<ModelTelemetryView>();
	const [error, setError] = useState("");
	useEffect(() => {
		let stopped = false; let timer: ReturnType<typeof setTimeout>;
		setView(undefined); setError("");
		async function refresh() {
			try { const next = await client.modelCalls(conversationId, requirement); if (!stopped) { setView(next); setError(""); } }
			catch (cause) { if (!stopped) setError(errorText(cause, language)); }
			if (!stopped) timer = setTimeout(() => void refresh(), 1000);
		}
		void refresh(); return () => { stopped = true; clearTimeout(timer); };
	}, [conversationId, requirement]);
	const summary = view && summarizeModelCalls(view.calls);
	const latest = view?.calls.filter((call) => call.kind === "generate").at(-1);
	return <section className="model-monitor" aria-label={en ? "AI activity" : "AI 处理记录"}>
		<label className="panel-field">{en ? "Scope" : "统计范围"}<select value={requirement ? "requirement" : "chat"} onChange={(event) => setRequirement(event.target.value === "requirement")}><option value="chat">{en ? "Current conversation (including background tasks)" : "当前会话（含后台任务）"}</option><option value="requirement">{en ? "Current requirement brief" : "当前需求单"}</option></select></label>
		{error && <p role="alert" className="file-error">{errorText(error, language)} · {en ? "the data below may be stale" : "下方数据可能已过期"}</p>}
		{!view ? <p>{en ? "Loading activity…" : "正在读取处理记录…"}</p> : <>
			<div className="model-identity"><small>{en ? "Current model" : "当前模型"}</small><strong>{view.configuredModel}</strong><span>{latest ? `${en ? "Latest result" : "最近处理结果"}：${status(latest.status)}` : en ? "No activity yet" : "暂无处理记录"}</span></div>
			<div className="monitor-grid">
				<div><small>{en ? "Times processed" : "处理次数"}</small><strong>{summary!.generated}</strong></div>
				<div><small>{en ? "In progress" : "正在处理"}</small><strong>{summary!.running}</strong></div>
				<div><small>{en ? "Succeeded / failed" : "成功 / 失败"}</small><strong>{summary!.succeeded} / {summary!.failed}</strong></div>
				<div><small>{en ? "Average response time" : "平均响应耗时"}</small><strong>{summary!.averageLatencyMs === null ? "—" : `${(summary!.averageLatencyMs / 1000).toFixed(2)} s`}</strong></div>
			</div>
			<p className="panel-note">{en ? `Statistics cover saved activity since recording began. Each task retains up to ${view.retentionLimit} recent records.${view.truncated ? " Earlier records are no longer included." : ""}` : `统计从启用记录后开始，每个任务最多保留最近 ${view.retentionLimit} 条记录。${view.truncated ? "更早记录已不计入本次统计。" : ""}`}</p>
			<div className="model-call-list"><h3>{en ? "Processing history" : "处理历史"}</h3>{!summary!.generated && <p>{en ? "Processing results appear here after you send a message." : "发送消息后，这里会显示处理结果。"}</p>}{view.calls.filter((call) => call.kind === "generate").slice().reverse().map((call) => <details key={call.id} className={`model-call ${call.status}`}><summary><span>{status(call.status)}</span><small>{new Date(call.startedAt).toLocaleTimeString(en ? "en-US" : "zh-CN")} · {call.latencyMs === undefined ? en ? "In progress" : "进行中" : `${(call.latencyMs / 1000).toFixed(1)} ${en ? "s" : "秒"}`}</small></summary><dl className="run-metadata"><div><dt>{en ? "Model used" : "使用模型"}</dt><dd>{call.model}</dd></div><div><dt>{en ? "Result" : "处理结果"}</dt><dd>{status(call.status)}</dd></div></dl>{call.status === "failed" && <p>{errorText({ code: call.failure }, language)}</p>}{call.status === "interrupted" && <p>{en ? "Processing was interrupted. Review the saved result before continuing." : "处理已中断，请核对已保存的结果后继续。"}</p>}</details>)}</div>
		</>}
	</section>;
}
