import { RequirementTemplate } from "./RequirementTemplate";
import { documentWarningText, errorText } from "../i18n";
import { useEffect, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import { compareRequirementVersions, factStatusLabels, inspectionStatusLabels, requirementFieldLabels, type RequirementDelivery } from "../manufacturing/requirementDelivery";
import { labelFor, statusFor, type Language } from "../i18n";

const client = new ConversationClient();

export function DeliveryPreview({ conversationId, versions, currentVersion, revision, language }: {
	conversationId: string; versions: number[]; currentVersion: number; revision: number; language: Language;
}) {
	const en = language === "en";
	const field = (key: string) => labelFor(language, key, requirementFieldLabels[key] ?? key);
	const value = (fact?: { value: string | number | boolean; unit?: string; status: string }) => fact ? `${fact.value} ${fact.unit ?? ""} · ${statusFor(language, fact.status, factStatusLabels[fact.status] ?? fact.status)}` : "—";
	const [version, setVersion] = useState(currentVersion);
	const [delivery, setDelivery] = useState<RequirementDelivery>();
	const [previous, setPrevious] = useState<RequirementDelivery>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [sourceRef, setSourceRef] = useState<string>();
	useEffect(() => { setVersion(currentVersion); }, [conversationId, currentVersion]);
	useEffect(() => {
		let cancelled = false;
		setDelivery(undefined); setPrevious(undefined); setError("");
		const before = versions.filter((value) => value < version).sort((a, b) => b - a)[0];
		void Promise.all([client.delivery(conversationId, version), before ? client.delivery(conversationId, before).catch(() => undefined) : undefined])
			.then(([now, prior]) => { if (!cancelled) { setDelivery(now); setPrevious(prior); } })
			.catch((reason) => { if (!cancelled) setError(errorText(reason, language)); });
		return () => { cancelled = true; };
	}, [conversationId, version, revision]);

	async function download(format: "md" | "html" | "json") {
		setBusy(true); setError("");
		try {
			const blob = await client.exportDelivery(conversationId, version, format, language);
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url; link.download = `requirement-v${version}.${format}`; link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (reason) { setError(errorText(reason, language)); }
		finally { setBusy(false); }
	}

	return <section className="proposal-section delivery-preview" aria-label={en ? "Requirement brief preview and export" : "需求单预览与导出"}>
		<div className="section-title" data-tour="brief-overview"><strong>{en ? "Requirement brief" : "需求单"}</strong><select aria-label={en ? "Requirement brief version" : "需求单版本"} value={version} onChange={(event) => setVersion(Number(event.target.value))}>{versions.map((item) => <option key={item} value={item}>v{item}{item === currentVersion ? en ? " · Current" : " · 当前" : en ? " · Historical" : " · 历史"}</option>)}</select></div>
		{error && <p role="alert">{errorText(error, language)}</p>}
		{!delivery && !error && <p role="status">{en ? "Loading version…" : "正在读取版本…"}</p>}
		{delivery && <>
			<span className={`delivery-status ${delivery.status}`}>{{ draft: en ? "Draft · unapproved" : "草稿 · 待批准", approved: en ? "Approved" : "已批准", stale: en ? "Outdated · review required" : "已失效 · 需重新核对" }[delivery.status]}</span>
			<h3>{delivery.content.title}</h3><p>{delivery.content.customerGoal}</p>
			<details className="delivery-fields"><summary>{en ? "All fields" : "完整需求信息"} · {delivery.content.facts.length}</summary><div className="table-scroll"><table><thead><tr><th>{en ? "Field" : "字段"}</th><th>{en ? "Value and status" : "内容与状态"}</th><th>{en ? "Source" : "来源"}</th></tr></thead><tbody>{delivery.content.facts.map((fact) => {
				const ref = delivery.citations[fact.key] ?? fact.sourceRef;
				const source = delivery.sources.find((item) => ref.startsWith(`${item.sourceRef}#page=`));
				return <tr key={fact.key}><td>{field(fact.key)}</td><td>{value(fact)}</td><td>{source ? <button className="text-action" onClick={() => { setSourceRef(source.sourceRef); document.getElementById(`sources-${version}`)?.scrollIntoView({ block: "nearest" }); }}>{source.name} · {en ? "page" : "第"} {ref.split("#page=")[1]}{en ? "" : " 页"}</button> : <small>{ref.startsWith("plan:") ? fact.status === "verified" ? en ? "Plan report · human confirmed" : "计划资料 · 已人工核对" : en ? "Plan report · verify source" : "计划资料 · 需核对来源" : fact.sourceType === "model_output" ? en ? "AI extraction · check source" : "AI 提取 · 待核对" : fact.sourceType === "human_confirmation" ? en ? "Human confirmed" : "人工确认" : en ? "Conversation / human input" : "会话 / 人工输入"}</small>}</td></tr>;
			})}</tbody></table></div></details>
			{delivery.content.missingRequiredFacts.length > 0 && <p className="missing-facts">{en ? "Still needed: " : "待补充："}{delivery.content.missingRequiredFacts.map(field).join(en ? ", " : "、")}</p>}
			{delivery.content.assumptions.length > 0 && <details><summary>{en ? "Assumptions and limitations" : "假设与限制"}</summary><ul>{delivery.content.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
			{previous && <details><summary>{en ? `Compare with v${previous.version} · ` : `与 v${previous.version} 比较 · `}{compareRequirementVersions(previous.content, delivery.content).length} {en ? "field changes" : "个字段变化"}</summary>{compareRequirementVersions(previous.content, delivery.content).map((change) => <div className="version-change" key={change.key}><strong>{field(change.key)}</strong><del>{value(change.before)}</del><span>{value(change.after)}</span></div>)}</details>}
			<div id={`sources-${version}`} className="source-list">{delivery.sources.map((source) => <details key={source.attachmentId} open={sourceRef === source.sourceRef} onToggle={(event) => { if (!event.currentTarget.open && sourceRef === source.sourceRef) setSourceRef(undefined); }}><summary>{source.name} <small>{statusFor(language, source.inspection.status, inspectionStatusLabels[source.inspection.status])}{source.inspection.truncated ? en ? " · Partial content" : " · 仅显示部分内容" : ""}</small></summary>
				{source.inspection.status === "needs_ocr" && <p>{en ? "This PDF has no extractable text. Provide a text version or enter key fields manually." : "这份 PDF 没有可提取文字。请补充文字版或人工录入关键字段。"}</p>}
				{source.inspection.ocrNextPage && <p>{en ? "Some pages still need text recognition. Continue in the attachment preview, then regenerate the brief." : "仍有未识别的页面，请在附件预览继续读取，再重新生成需求单。"}</p>}
				{source.inspection.width && <p>{source.inspection.width} × {source.inspection.height} {en ? "pixels · not a printing dimension or production-ready proof" : "像素 · 不代表印刷尺寸或生产就绪"}</p>}
				{source.inspection.pages.map((page) => <div className="source-page" key={page.page}><strong>{en ? "Page" : "第"} {page.page}{en ? "" : " 页"}</strong>{page.warnings?.map((warning) => <p key={warning}>{documentWarningText(warning, language)}</p>)}<pre>{page.text || (en ? "No text could be extracted from this page" : "本页无可提取文字")}</pre></div>)}
			</details>)}</div>
			<div className="export-actions" data-tour="export"><button disabled={busy} onClick={() => void download("md")}>{en ? "Export text" : "导出文本"}</button><button disabled={busy} onClick={() => void download("html")}>{en ? "Print version" : "打印版"}</button><details className="export-more"><summary>{en ? "More" : "更多"}</summary><button disabled={busy} onClick={() => void download("json")}>{en ? "Download data copy" : "下载数据副本"}</button></details></div>
			<small>{en ? "Version and status are included. The print version can be saved as PDF." : "导出保留版本与状态，打印版可另存为 PDF。"}</small>
		</>}
		<RequirementTemplate key={`${conversationId}:${version}:${revision}`} conversationId={conversationId} delivery={delivery} language={language} />
	</section>;
}
