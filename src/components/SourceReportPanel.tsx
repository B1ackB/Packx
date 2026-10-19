import { useEffect, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import type { ConversationAttachment } from "../runtime/conversationContracts";
import { REPORT_LIMITS, type SourceReportArtifact, type SourceReportView } from "../enterprise/sourceReport";
import { errorText, type Language } from "../i18n";
const client = new ConversationClient();
export function SourceReportPanel({ conversationId, attachments, language }: { conversationId: string; attachments: ConversationAttachment[]; language: Language }) {
	const en = language === "en";
	const [view, setView] = useState<SourceReportView>();
	const [title, setTitle] = useState(""); const [urls, setUrls] = useState("");
	const [selected, setSelected] = useState<string[]>([]);
	const [report, setReport] = useState<SourceReportArtifact>();
	const [sourceText, setSourceText] = useState<{ index: number; text: string; truncated: boolean }>();
	const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>();
	useEffect(() => {
		let disposed = false; let timer: ReturnType<typeof setTimeout>;
		const load = async () => {
			try { const next = await client.sourceReports(conversationId); if (!disposed) setView(next); }
			catch (error) { if (!disposed) setError(error); }
			if (!disposed) timer = setTimeout(() => void load(), 1500);
		};
		void load(); return () => { disposed = true; clearTimeout(timer); };
	}, [conversationId]);
	const files = attachments.filter(a => a.kind === "text" && a.size <= REPORT_LIMITS.bytes);
	const running = view?.versions.some(v => v.status === "queued" || v.status === "running");
	async function command(action: string, version?: number | null) {
		if (!view) return;
		setBusy(true); setError(undefined); setReport(undefined);
		try { setView(await client.sourceReportCommand(conversationId, { action, requestId: crypto.randomUUID(), revision: view.revision,
			...(action === "start" ? { title, inputs: [
				...files.filter(a => selected.includes(a.attachmentId)).map(a => ({ kind: "attachment", attachmentId: a.attachmentId, sha256: a.sha256 })),
				...urls.split("\n").map(s => s.trim()).filter(Boolean).map(url => ({ kind: "web", url })),
			] } : { version }),
		})); } catch (error) { setError(error); } finally { setBusy(false); }
	}
	async function open(version: number, download = false) {
		setError(undefined); setBusy(true);
		try {
			const result = await client.sourceReport(conversationId, version); setReport(result); setSourceText(undefined);
			if (download) {
				const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
				const link = document.createElement("a"); link.href = url; link.download = `source-report-v${version}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
			}
		} catch (error) { setReport(undefined); setError(error); } finally { setBusy(false); }
	}
	const labels = { queued: en ? "Queued" : "等待处理", running: en ? "Collecting sources" : "正在读取资料", completed: en ? "Ready for review" : "报告待核对", failed: en ? "Stopped" : "已停止", cancelled: en ? "Cancelled" : "已取消" };
	async function readSource(index: number) {
		if (!report) return; setError(undefined);
		try { const source = await client.sourceReportSnapshot(conversationId, report.version, index); setSourceText({ index, text: source.text, truncated: source.truncated }); }
		catch (error) { setSourceText(undefined); setReport(undefined); setError(error); }
	}
	return <section className="source-reports">
		<p>{en ? "Explicitly select one immutable version for chat and Plan tasks. New reports do not replace it. Changing or clearing the selection invalidates plans that used the previous selection." : "可明确选定一个不可变版本供对话与计划任务使用；新报告不会自动替换所选版本。更改或取消选择会使依赖旧选择的计划失效。"}</p>
		{view?.selectedVersion && <p role="status">{en ? `Selected for tasks: v${view.selectedVersion}` : `任务所选资料：v${view.selectedVersion}`} <button disabled={busy} onClick={() => void command("select", null)}>{en ? "Clear report selection" : "取消报告选择"}</button></p>}
		<p>{en ? "Collect selected text files and permitted web pages into a versioned source report. No model connection is needed. Excerpts remain unverified." : "将所选文本文件和允许访问的网页整理为版本化资料报告，无需模型连接。摘录仍需核对。"}</p>
		<p>{en ? "Text files up to 128 KiB; up to 6 sources, including 3 web pages. Upload files using Add files in the conversation." : "支持不超过 128 KiB 的文本文件；最多 6 项来源，其中网页最多 3 项。可从对话区“添加资料”上传文件。"}</p>
		{error != null && <p role="alert">{errorText(error, language)}</p>}
		<form onSubmit={e => { e.preventDefault(); void command("start"); }}>
			<label>{en ? "Report title" : "报告名称"}<input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} required /></label>
			<fieldset><legend>{en ? "Select text files" : "选择文本资料"}</legend>{files.length ? files.map(a => <label key={a.attachmentId}><input type="checkbox" checked={selected.includes(a.attachmentId)} onChange={e => setSelected(e.target.checked ? [...selected, a.attachmentId] : selected.filter(id => id !== a.attachmentId))} />{a.name}</label>) : <p>{en ? "No supported text files yet." : "暂时没有可用的文本资料。"}</p>}</fieldset>
			<label>{en ? "Web pages, one HTTPS URL per line" : "网页地址，每行一个 HTTPS 链接"}<textarea rows={3} value={urls} onChange={e => setUrls(e.target.value)} maxLength={6144} disabled={!view?.allowedWebDomains.length} /></label>
			<p>{view?.allowedWebDomains.length ? `${en ? "Permitted domains: " : "允许访问的域名："}${view.allowedWebDomains.join(", ")}` : en ? "Web reading is disabled until the Host configures permitted domains." : "网页读取尚未开启，需由 Host 配置允许访问的域名。"}{en ? " No sign-in, query parameters, scripts or interactive pages." : " 不支持登录、查询参数、脚本或交互网页。"}</p>
			<button disabled={busy || !view || running || !title.trim() || !selected.length && !urls.trim()}>{en ? "Create source report" : "生成资料报告"}</button>
		</form>
		{view?.versions.slice().reverse().map(v => <article key={v.version} className="proposal-section">
			<h3>v{v.version} · {v.title}</h3><p role="status">{labels[v.status]} · {v.captured.length}/{v.inputs.length}</p>
			{!v.available && <p>{en ? "A source or report was withdrawn, changed, denied, or failed its integrity check. Content is unavailable." : "来源或报告已撤回、变更、被拒绝访问或未通过完整性检查，内容暂不可用。"}</p>}
			{v.failure && <p>{errorText({ code: v.failure.code }, language)}</p>}
			{(v.status === "queued" || v.status === "running") && <button disabled={busy} onClick={() => void command("cancel", v.version)}>{en ? "Cancel collection" : "取消读取"}</button>}
			{v.status === "failed" && v.failure?.retryable && v.attempts < REPORT_LIMITS.attempts && v.available && <button disabled={busy || running} onClick={() => void command("retry", v.version)}>{en ? "Retry remaining sources" : "重试剩余资料"}</button>}
			{v.status === "completed" && v.available && <><button disabled={busy} onClick={() => void open(v.version)}>{en ? "Read report" : "查看报告"}</button> <button disabled={busy} onClick={() => void open(v.version, true)}>{en ? "Download report" : "下载报告"}</button></>}
			{v.status === "completed" && v.available && <button disabled={busy || view.selectedVersion === v.version} onClick={() => void command("select", v.version)}>{en ? `Use v${v.version} in tasks` : `将 v${v.version} 用于任务`}</button>}
		</article>)}
		{report && view?.versions.some(v => v.version === report.version && v.available) && <article className="source-report-preview"><h3>{report.title} · v{report.version}</h3><p>{en ? "Source excerpts · Unverified. Review original sources; this report does not resolve conflicting claims." : "资料摘录 · 未验证。请核对原始来源；本报告不裁决互相冲突的说法。"}</p>{report.sources.map((s, i) => <section key={i}><h4>{i + 1}. {s.name}</h4><p>{s.sourceRef}</p><p>{en ? "Captured: " : "读取时间："}{s.capturedAt}</p><details><summary>{en ? "Source fingerprint" : "来源指纹"}</summary><code>{s.sha256}</code></details><pre>{s.excerpt}</pre>{s.excerptTruncated && <p>{en ? "Excerpt is incomplete; check the original." : "摘录不完整，请核对原文。"}</p>}<button onClick={() => void readSource(i)}>{en ? "Read saved source" : "查看保存的原文"}</button>{sourceText?.index === i && <><pre>{sourceText.text}</pre>{sourceText.truncated && <p>{en ? "Saved text is incomplete; check the original source." : "保存的文字不完整，请核对原始来源。"}</p>}</>}</section>)}</article>}
	</section>;
}
