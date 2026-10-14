import { useEffect, useRef, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import type { KnowledgeSearchView, KnowledgeView, PackagingComparisonResult } from "../runtime/knowledgeView";
import type { EvidenceHit, KnowledgeQuery } from "../enterprise/knowledge";
import { errorText, type Language } from "../i18n";
import type { ConversationAttachment } from "../runtime/conversationContracts";
import "./knowledge.css";
import { coffeeEvidenceQuestions, testConditionLabels } from "../manufacturing/packagingKnowledge";

const labels: Record<string, [string, string]> = {
	keyword: ["按关键词查找", "Match keywords"], vector: ["按意思查找", "Match meaning"], hybrid: ["综合查找", "Match keywords and meaning"],
	public_source: ["公开资料", "Public source"], user_authorized: ["已获授权的资料", "Authorized source"], synthetic: ["演示资料，不可用于真实订单", "Demo material; not for real orders"],
	supplier_claim: ["供应商提供", "Supplier information"], third_party_test: ["第三方检测", "Third-party test"], certificate_record: ["证书记录", "Certificate record"], human_confirmation: ["人工确认", "Human confirmation"], research_report: ["研究报告", "Research report"],
	unverified: ["待确认", "Unconfirmed"], human_reviewed: ["已人工核对", "Reviewed by a person"],
	imported: ["等待读取", "Waiting to be read"], parsed: ["正在整理", "Preparing"], indexed: ["可供查找", "Available to search"], needs_review: ["待核对", "Needs review"], withdrawn: ["已撤回", "Withdrawn"], cancelled: ["已取消", "Cancelled"],
	queued: ["等待处理", "Waiting"], leased: ["正在处理", "Processing"], completed: ["已完成", "Completed"], dead_letter: ["处理未完成，可重试", "Processing failed; retry available"],
	workspace: ["当前工作区可用", "Available in this workspace"], public: ["公开资料", "Public source"],
	candidate_not_verified: ["引用前请核对", "Review before using"], synthetic_not_product_data: ["演示资料，不可用于真实订单", "Demo material; not for real orders"], effective_date_unknown: ["生效日期待核对", "Effective date needs review"], region_unknown: ["适用地区待确认", "Applicable region is unconfirmed"],
	retrieval_degraded: ["部分查找功能暂不可用", "Some search options are unavailable"], embedding_unavailable: ["暂时无法按意思查找", "Matching by meaning is unavailable"], rerank_unavailable: ["暂时无法按相关程度排序", "Sorting by relevance is unavailable"], index_rebuild_required: ["资料需重新整理后才能查找", "Sources need preparing again before searching"], no_supported_answer: ["未找到足够依据", "No supporting evidence found"], order_applicability_required: ["请核对订单地区和日期", "Check the order region and date"], retrieval_is_not_entailment: ["找到资料不代表已确认适用", "A search result does not confirm suitability"], result_bounded: ["仅显示部分结果", "Only some results are shown"],
	source_directory: ["资料目录", "Source directory"], public_database_snapshot: ["公开记录", "Public records"], product_directory: ["产品目录", "Product directory"], product_information: ["产品介绍", "Product information"], technical_datasheet: ["技术资料", "Technical datasheet"], classification: ["分类资料", "Classification guide"], normative_document: ["标准或法规", "Standard or regulation"], regulatory_discovery: ["法规查询入口", "Regulatory source"], certification_notice: ["认证通知", "Certification notice"],
	structure: ["材料结构", "Material structure"], thickness: ["厚度", "Thickness"],
};
const client = new ConversationClient();
export function KnowledgePanel({ conversationId, language, attachments = [] }: { conversationId: string; language: Language; attachments?: ConversationAttachment[] }) {
	const en = language === "en";
	const label = (code: string) => labels[code]?.[en ? 1 : 0] ?? (en ? "Needs review" : "待核对");
	const parameterName = (name: string) => labels[name]?.[en ? 1 : 0] ?? name;
	const [view, setView] = useState<KnowledgeView>();
	const [search, setSearch] = useState<KnowledgeSearchView>();
	const [query, setQuery] = useState("咖啡袋 厚度 阻隔");
	const [model, setModel] = useState("");
	const [region, setRegion] = useState("HK");
	const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
	const [mode, setMode] = useState<KnowledgeQuery["mode"]>("keyword");
	const [ids, setIds] = useState<string[]>([]);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const [manifest, setManifest] = useState("");
	const [packageName, setPackageName] = useState("");
	const [attachmentId, setAttachmentId] = useState("");
	const [leftParameter, setLeftParameter] = useState("");
	const [rightParameter, setRightParameter] = useState("");
	const [comparison, setComparison] = useState<PackagingComparisonResult>();
	const comparisonEpoch = useRef(0);
	useEffect(() => { comparisonEpoch.current++; setComparison(undefined); }, [conversationId, search, view, leftParameter, rightParameter, region, asOf]);
	const reload = async () => { const next = await client.knowledge(conversationId); setView(next); return next; };
	useEffect(() => {
		let active = true;
		void client.knowledge(conversationId).then((next) => { if (active) { setView(next); setIds(next.selection?.ids ?? []); } }).catch((e: Error) => { if (active) setError(errorText(e, language)); });
		return () => { active = false; };
	}, [conversationId]);
	useEffect(() => {
		if (!view?.documents.some((doc) => ["imported", "parsed"].includes(doc.status))) return;
		const timer = window.setInterval(() => { void reload().catch((e: Error) => setError(errorText(e, language))); }, 1500);
		return () => window.clearInterval(timer);
	}, [view, conversationId]);
	const run = async (operation: () => Promise<unknown>) => {
		setBusy(true); setError(""); setNotice("");
		try { await operation(); await reload(); } catch (e) { setError(errorText(e, language)); } finally { setBusy(false); }
	};
	const candidate = (hit: EvidenceHit, parameter: string) => run(async () => {
		await client.knowledgeCommand(conversationId, "candidate", { evidenceId: hit.evidenceId, parameter, requestId: crypto.randomUUID() });
		setNotice(en ? "Added as unverified. Review and confirm in Requirements." : "已加入待确认字段，请在需求单中核对。");
	});
	const hits = search?.result.hits ?? view?.hits ?? [];
	const review = search?.review ?? view?.review;
	const comparisonHits = [...new Map([...(view?.hits ?? []), ...hits].map((hit) => [hit.evidenceId, hit])).values()];
	const parameters = comparisonHits.flatMap((hit) => hit.parameters.map((p, index) => ({ value: JSON.stringify({ evidenceId: hit.evidenceId, parameterIndex: index }), label: `${hit.model} / ${p.subject ?? p.scope} / ${parameterName(p.name)}: ${p.originalValue} ${p.originalUnit} (${hit.revision})` })));
	const compare = async () => {
		const epoch = ++comparisonEpoch.current;
		setBusy(true); setError(""); setComparison(undefined);
		try {
			const result = await client.compareKnowledge(conversationId, { left: JSON.parse(leftParameter), right: JSON.parse(rightParameter), region, asOf: new Date(`${asOf}T00:00:00Z`).toISOString() });
			if (epoch === comparisonEpoch.current) setComparison(result);
		} catch (e) { if (epoch === comparisonEpoch.current) setError(errorText(e, language)); }
		finally { setBusy(false); }
	};
	return <section className="knowledge-panel" aria-label={en ? "Packaging evidence" : "包装数据与证据"}>
		<p className="panel-intro">{en ? "Find sources for your brief. Selected information still needs confirmation." : "查找资料，加入需求单。引用内容仍需确认。"}</p>
		{error && <p role="alert" className="knowledge-alert">{errorText(error, language)}</p>}
		{notice && <p role="status">{notice}</p>}
		{!!view?.unavailable.length && <p role="alert">{en ? "Selected evidence is no longer available. Remove it and review the sources." : "部分已选证据已撤回、过期或权限变化。停止引用，移除后重新核对。"}</p>}
		<form onSubmit={(e) => { e.preventDefault(); void run(async () => setSearch(await client.searchKnowledge(conversationId, { query, mode, ...(model ? { model } : {}), region, asOf: new Date(`${asOf}T00:00:00Z`).toISOString(), limit: 5 }))); }}>
			<label>{en ? "Question or model" : "问题或型号"}<input value={query} maxLength={300} onChange={(e) => setQuery(e.target.value)} required /></label>
			<div className="knowledge-fields">
				<label>{en ? "Region" : "订单地区"}<input value={region === "unknown" ? "" : region} placeholder={en ? "Unspecified" : "待确认"} onChange={(e) => setRegion(e.target.value || "unknown")} /></label>
				<label>{en ? "Applicable date" : "适用日期"}<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required /></label>
			</div>
			<details className="panel-disclosure"><summary>{en ? "Search options" : "筛选设置"}</summary>
				<label>{en ? "Exact document / model" : "限定资料或型号"}<input list="knowledge-document-models" value={model} onChange={(e) => setModel(e.target.value)} /><datalist id="knowledge-document-models">{view?.documents.map((d) => <option key={d.versionId} value={d.manifest.model}>{d.manifest.title}</option>)}</datalist></label>
				<label>{en ? "Search method" : "查找方式"}<select value={mode} onChange={(e) => setMode(e.target.value as KnowledgeQuery["mode"])}><option value="keyword">{label("keyword")}</option><option value="vector">{label("vector")}</option><option value="hybrid">{label("hybrid")}</option></select></label>
			</details>
			<div className="panel-actions">
				<button className="primary-action" disabled={busy || !query.trim()} type="submit">{busy ? en ? "Searching…" : "查询中…" : en ? "Search evidence" : "查找证据"}</button>
				<button type="button" disabled={busy || !query.trim()} onClick={() => void run(async () => { setSearch(await client.findCoffeeProducts(conversationId, query)); setRegion("unknown"); })}>{en ? "Product directory" : "查产品目录"}</button>
			</div>
			<details className="panel-disclosure"><summary>{en ? "Example questions" : "问题示例"}</summary>
				<div className="knowledge-fields">{coffeeEvidenceQuestions.map((step) => <button type="button" key={step.label} onClick={() => setQuery(step.query)}>{step.label}</button>)}</div>
				<button type="button" onClick={() => { setRegion("US"); setQuery("PET recycling food contact use limitations"); }}>{en ? "US FDA records" : "美国 FDA 记录"}</button>
			</details>
		</form>
		{search && <p role="status">{en ? "Results" : "查询结果"} · {search.result.hits.length} {en ? "sources" : "条证据"}{search.result.gaps.length > 0 && ` · ${search.result.gaps.map(label).join(" / ")}`}</p>}
		{search?.result.degradation && <p role="status">{en ? `Some search options are unavailable. Results use ${search.result.degradation.effectiveMode === "keyword" ? "keyword matching" : "combined matching without relevance sorting"}. Check the source before using it.` : `部分查找功能暂不可用，本次${search.result.degradation.effectiveMode === "keyword" ? "按关键词查找" : "使用综合查找，未按相关程度排序"}。使用前请核对原文与适用条件。`}</p>}
		{search?.questions && <details open><summary>{en ? "Questions for the supplier" : "下一步逐项向供应商核对"}</summary>{search.questions.map((q) => <p key={q.field}>{q.question}</p>)}</details>}
		{search?.result.assessment && <aside role="status" className="knowledge-alert">
			<strong>{({ insufficient_evidence: en ? "There is not enough supporting material to draw a conclusion." : "当前资料不足，不能据此下结论。", source_values_available: en ? "Source parameter records found; applicability and confirmation remain open." : "找到原始参数记录；不等于已回答全部问题或已确认适用。", needs_review: en ? "Read the source and resolve scope or test-condition gaps." : "需要核对原文、适用范围及测试条件。" })[search.result.assessment.status]}</strong>
			{search.result.assessment.checks.map((check) => <p key={check.field}>{check.status === "present" ? (en ? "Source record available" : "有原始记录") : check.status === "missing" ? (en ? "No matching information found in these sources" : "当前资料中未找到对应信息") : (en ? "Needs review" : "待复核")} — {check.question}</p>)}
			<small>{en ? "This checks only the information found here. Review the full source before confirming." : "这里只检查本次找到的信息，不代表全文没有答案；引用前仍需核对确认。"}</small>
		</aside>}
		{hits.map((hit) => <article className="knowledge-evidence" key={hit.evidenceId}>
			<label><input type="checkbox" checked={ids.includes(hit.evidenceId)} disabled={busy || !ids.includes(hit.evidenceId) && ids.length >= 8} onChange={(e) => setIds(e.target.checked ? [...ids, hit.evidenceId] : ids.filter((id) => id !== hit.evidenceId))} />{hit.title}</label>
			<p>{hit.publisher} · {!hit.model.startsWith("catalog:") && `${hit.model} · `}{hit.revision} · {label(hit.provenance)}</p>
			<small>{hit.location.page ? `p${hit.location.page} / ` : ""}{hit.location.section} {hit.location.table ?? ""}{hit.location.row ? ` / row ${hit.location.row}` : ""}{hit.location.paragraph ? ` / ¶${hit.location.paragraph}` : ""} · {hit.warnings.map(label).join(" / ")}</small>
			{hit.sourceUrl.startsWith("https://") && <p><a href={hit.sourceUrl + (hit.sourceUrl.endsWith(".pdf") && hit.location.page ? `#page=${hit.location.page}` : hit.location.anchor ? `#${encodeURIComponent(hit.location.anchor)}` : "")} target="_blank" rel="noreferrer">{en ? "Open original source" : "查看官方原始位置"}</a></p>}
			<details><summary>{hit.model.startsWith("catalog:") ? (en ? "Packx directory record (not vendor original)" : "Packx 整理的目录记录（不是厂商原文）") : (en ? "Original source · review before use" : "资料原文 · 使用前请核对")}</summary><pre>{hit.text}</pre>{hit.table && <><div className="knowledge-table"><table><thead><tr>{hit.table.headers.map((h, i) => <th key={i}>{h} {hit.table!.units[i]}</th>)}</tr></thead><tbody>{hit.table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div><p>{hit.table.conditions}</p>{hit.table.footnotes.map((note) => <small key={note}>{note}</small>)}</>}</details>
			{hit.attribution && <small>{hit.attribution}</small>}
			{hit.parameters.map((parameter, index) => <div key={`${parameter.name}-${index}`} className="knowledge-parameter"><strong>{parameter.subject ? `${parameter.subject} / ` : ""}{parameterName(parameter.name)}</strong>: {parameter.originalValue} {parameter.originalUnit}{parameter.normalized && <span> → {parameter.normalized.value} {parameter.normalized.unit}</span>}<small>{parameter.method || (en ? "Method unknown" : "方法待核对")} · {parameter.conditions || (en ? "Conditions unknown" : "条件待核对")} · {label(parameter.authority)} · {label(parameter.verification)}</small>{parameter.authority !== "research_report" && ["structure", "thickness"].includes(parameter.name) && <button disabled={busy || !view?.selection?.ids.includes(hit.evidenceId)} onClick={() => void candidate(hit, parameter.name)}>{en ? "Add as an unverified requirement field" : "作为待确认字段加入需求单"}</button>}</div>)}
		</article>)}
		{(hits.length > 0 || ids.length > 0 || !!view?.selection?.ids.length) && <div className="evidence-selection">
			<p>{en ? "Selected" : "已选"} {ids.length} / 8 · {en ? "Saved" : "已保存"} {view?.selection?.ids.length ?? 0}</p>
			<button className="primary-action" disabled={busy || !region || !asOf} onClick={() => void run(async () => { await client.knowledgeCommand(conversationId, "select", { ids, applicability: { region, asOf: new Date(`${asOf}T00:00:00Z`).toISOString() }, expectedVersion: view?.selection?.version ?? 0, requestId: crypto.randomUUID() }); setNotice(en ? "Selection saved. Create or update the brief, then confirm its fields." : "证据已保存。请生成需求单并逐项确认。"); })}>{en ? "Save selection" : "保存所选证据"}</button>
		</div>}
		<details><summary>{en ? "Compare parameters" : "参数比对"}</summary>
			<p>{en ? "Select the exact sample and layer. This compares observations and does not confirm order suitability." : "逐项选择样品、材料层和参数。这里比较来源记录，不确认当前订单适用性；需要引用到需求单时，仍须保存相应证据选择。"}</p>
			<div className="knowledge-fields">{[{ value: leftParameter, setValue: setLeftParameter, label: en ? "Left parameter" : "左侧参数" }, { value: rightParameter, setValue: setRightParameter, label: en ? "Right parameter" : "右侧参数" }].map(({ value, setValue, label }) => <label key={label}>{label}<select value={value} disabled={busy} onChange={(e) => setValue(e.target.value)}><option value="">{en ? "Choose a source record" : "请选择具体来源记录"}</option>{parameters.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>)}</div>
			<button disabled={busy || !region || !asOf || !parameters.some((p) => p.value === leftParameter) || !parameters.some((p) => p.value === rightParameter)} onClick={() => void compare()}>{en ? "Check comparability" : "核对是否可以比较"}</button>
			{comparison && <div role="status">
				<strong>{comparison.status === "comparable" ? (en ? "Numerically comparable observations; confirmation is still required." : "这两条记录满足数值比较规则，仍待人工核对适用性。") : (en ? "Direct numerical comparison is blocked." : "条件不足，不能直接进行数值比较。")}</strong>
				{comparison.status === "comparable" && <p>{en ? "Left minus right" : "左侧减右侧"}：{comparison.comparison.difference} {comparison.comparison.unit}</p>}
				{[comparison.left, comparison.right].map((source, i) => <article className="knowledge-evidence" key={i}>
					<strong>{i === 0 ? (en ? "Left" : "左侧") : (en ? "Right" : "右侧")} · {source.publisher} / {source.model} / {source.parameter.subject ?? source.parameter.scope}</strong>
					<p>{parameterName(source.parameter.name)}：{source.parameter.originalValue} {source.parameter.originalUnit}{source.parameter.normalized && ` → ${source.parameter.normalized.value} ${source.parameter.normalized.unit}`}</p>
					<p>{en ? "Method / conditions / scope" : "方法 / 原文条件 / 测量范围"}：{source.parameter.method || "未知"} / {source.parameter.conditions || "未知"} / {source.parameter.scope || "未知"}</p>
					{source.parameter.testConditions?.map((c) => <small key={c.name}>{!en && Object.hasOwn(testConditionLabels, c.name) ? testConditionLabels[c.name] : c.name}: {c.value} {c.unit}</small>)}
					<small>{source.revision} · {source.location.page ? `p${source.location.page} / ` : ""}{source.location.section} {source.location.table ?? ""} · {label(source.parameter.authority)} · {label(source.parameter.verification)}</small>
				</article>)}
				{comparison.questions.map((question) => <p key={question}>{question}</p>)}
				{comparison.warnings.includes("authority_types_differ") && <p role="alert">{en ? "The sources have different authority types; numerical comparability does not make their evidence equally strong." : "两条来源的权威类型不同；数值可以比较，不代表证据强度相同。"}</p>}
				<p>{en ? "This does not rank suppliers, certify compliance, approve facts or determine production parameters." : "该结果不代表厂商优劣、认证或合规结论，不确认事实，也不确定生产参数。"}</p>
				<details><summary>{en ? "Review record" : "核对记录"}</summary><small>{new Date(comparison.createdAt).toLocaleString(en ? "en-US" : "zh-CN")}</small>{[comparison.left, comparison.right].map((source, i) => <p key={i}>{source.title} · {source.revision} · {parameterName(source.parameter.name)}</p>)}</details>
			</div>}
		</details>
		{review && <details open={review.conflicts.length > 0}><summary>{en ? "Supplier follow-up" : "供应商待核对"}{review.conflicts.length > 0 && ` · ${en ? "Conflicts found" : "存在冲突"}`}</summary>{review.questions.map((q) => <p key={q}>{q}</p>)}{review.limitations.map((q) => <small key={q}>{q}</small>)}{review.comparisonTruncated && <p role="status">{en ? "Automatic conflict hints cover only the first 64 pairs. Select specific parameters above to inspect the rest." : "自动冲突提示仅检查前 64 组；其余记录请在上方明确选择参数核对。"}</p>}{!!review.conflicts.length && <p role="alert">{en ? "Conflicting values for the same model and sample require review; the newest version is not automatically applicable." : "同型号、同样品资料存在数值差异，需要并列复核；不自动采用最新版。"}</p>}</details>}
		<details><summary>{en ? "Manage sources" : "资料管理"} · {view?.documents.length ?? 0}</summary>
			<p>{en ? "Directories and research are references; check model, region and date before use." : "目录和论文仅作参考；使用前核对型号、地区和日期。"}</p>
			<button disabled={busy} onClick={() => void run(async () => { await client.knowledgeCommand(conversationId, "open-products", {}); setRegion("unknown"); setNotice(en ? "FDA records and the product directory are being imported. Select US for FDA records; directory applicability still needs review. Full supplier datasheets are not included and orders are not approved." : "已提交 FDA 记录与目录导入。查 FDA 记录时请选择美国地区；目录适用地区待确认。不含供应商技术资料全文，也不代表订单已获批准。"); })}>{en ? "Import packaging sources" : "导入包装资料"}</button>
			<button disabled={busy} onClick={() => void run(async () => { await client.knowledgeCommand(conversationId, "open-research", {}); setRegion("unknown"); if (view?.embedding.kind === "local_model") setMode("hybrid"); setQuery("REC 膜的克重及单位是什么？"); setNotice(en ? "Importing 5 licensed research papers. Region and order suitability remain unconfirmed; do not use research values directly as order requirements." : "正在导入 5 篇获准使用的研究全文，适用地区与订单适用性待核对；研究数值不能直接用作订单参数。"); })}>{en ? "Import 5 licensed research papers" : "导入 5 篇获准使用的研究全文"}</button>
			<button disabled={busy} onClick={() => void run(() => client.knowledgeCommand(conversationId, "demo", {}))}>{en ? "Import two synthetic demo documents" : "导入 2 份合成演示资料"}</button>
			<button disabled={busy} onClick={() => void run(() => client.knowledgeCommand(conversationId, "rebuild", {}))}>{en ? "Prepare sources again" : "重新整理资料"}</button>
			{view?.documents.map((doc) => <div className="knowledge-evidence" key={doc.versionId}><strong>{doc.manifest.title}</strong><p>{label(doc.status)}{doc.failure && ` · ${errorText({ code: doc.failure }, language)}`}</p>{view.jobs.filter((job) => job.versionId === doc.versionId).map((job) => <p key={job.jobId}>{label(job.status)}{job.lastFailure && ` · ${errorText(job.lastFailure, language)}`} · {en ? "Failures / recoveries" : "失败 / 恢复"} {job.failureCount} / {job.recoveryCount}{job.status === "dead_letter" && <button disabled={busy} onClick={() => void run(() => client.knowledgeCommand(conversationId, "retry", { versionId: doc.versionId }))}>{en ? "Retry" : "重试"}</button>}</p>)}<small>{doc.manifest.revision} · {new Date(doc.importedAt).toLocaleDateString(en ? "en-US" : "zh-CN")} · {label(doc.manifest.visibility)}</small>{["imported", "parsed"].includes(doc.status) && <button disabled={busy} onClick={() => void run(() => client.knowledgeCommand(conversationId, "cancel", { versionId: doc.versionId }))}>{en ? "Cancel import" : "取消导入"}</button>}{doc.status !== "withdrawn" && <button disabled={busy} onClick={() => void run(async () => { await client.knowledgeCommand(conversationId, "withdraw", { versionId: doc.versionId }); setSearch(undefined); })}>{en ? "Stop using this source (keep history)" : "撤回资料（保留历史）"}</button>}</div>)}
			<p>{en ? "Choose a source package prepared by your administrator (up to 1 MB). Only import material you are authorized to save and search; public access alone does not grant that permission." : "选择管理员准备的资料包（最多 1 MB）。请确保已获得保存和查阅授权；公开可读不代表可以直接收录。"}</p>
			<label className="file-upload-control"><span>{en ? "Source package" : "选择资料包"}</span><span className="file-upload-button" aria-hidden="true">{en ? "Choose a source package" : "选择资料包文件"}</span><input aria-label={en ? "Source package" : "选择资料包"} type="file" accept=".json,application/json" disabled={busy} onChange={(event) => {
				const file = event.target.files?.[0]; event.target.value = "";
				setManifest(""); setPackageName(""); setError("");
				if (!file) return;
				if (file.size > 1_000_000) { setError(errorText({ code: "import_package_too_large" }, language)); return; }
				setBusy(true);
				void file.text().then((text) => {
					const value: unknown = JSON.parse(text);
					if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_import_package");
					setManifest(text); setPackageName(file.name);
				}).catch(() => setError(errorText({ code: "invalid_import_package" }, language))).finally(() => setBusy(false));
			}} /></label>
			{packageName && <p role="status">{en ? "Ready to import" : "待导入"}：{packageName}</p>}
			<button disabled={busy || !manifest} onClick={() => void run(() => client.knowledgeCommand(conversationId, "import", JSON.parse(manifest)))}>{en ? "Import source package" : "导入资料包"}</button>
			<label>{en ? "Read an uploaded file (optional)" : "读取已上传的文件（可选）"}<select value={attachmentId} onChange={(e) => setAttachmentId(e.target.value)}><option value="">{en ? "Choose a file" : "请选择文件"}</option>{attachments.filter((attachment) => !attachment.withdrawal).map((attachment) => <option key={attachment.attachmentId} value={attachment.attachmentId}>{attachment.name}</option>)}</select></label>
			<button disabled={busy || !manifest || !attachments.some((attachment) => attachment.attachmentId === attachmentId && !attachment.withdrawal)} onClick={() => void run(() => client.knowledgeCommand(conversationId, "parse-attachment", { manifest: JSON.parse(manifest), attachmentId }))}>{en ? "Read file for review" : "读取文件并核对"}</button>
		</details>
		<details><summary>{en ? "Source directory and gaps" : "来源目录与缺口"}</summary><small>{en ? "Metadata only; full text is not included." : "仅登记来源信息，不包含全文。"}</small>{view?.sources.map((source) => <article key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.publisher} · {label(source.type)}</a><p>{source.scope} · {source.version}</p><small>{source.permission === "metadata_only" ? (en ? "Source link only; full text is not included" : "仅有资料链接，不含全文") : source.permission} · {source.limitation}</small><a href={source.terms} target="_blank" rel="noreferrer">{en ? "Usage terms review" : "条款核验入口"}</a></article>)}{view?.coverage.map((row, i) => <p key={i}>{row.category} × {row.material} × {row.process} × {row.region}：{row.missing}</p>)}</details>
		{search && <details className="panel-disclosure retrieval-details"><summary>{en ? "Search summary" : "查找概况"}</summary>
			<p>{search.result.status === "candidates" ? (en ? "Sources found; check suitability before use." : "已找到资料，使用前请核对适用性。") : search.result.status === "no_evidence" ? (en ? "No supporting source found. Try another question or add material." : "暂未找到依据，请换个问题或补充资料。") : (en ? "Search is temporarily unavailable. Please retry later." : "暂时无法查找，请稍后重试。")}</p>
			<small>{en ? "Time taken" : "本次耗时"}：{(search.result.durationMs / 1000).toFixed(1)} {en ? "seconds" : "秒"}</small>
			{search.result.reranking && <p>{search.result.reranking.status === "completed" ? (en ? `Sorted ${search.result.reranking.candidateCount} sources by relevance.` : `已按相关程度整理 ${search.result.reranking.candidateCount} 条资料。`) : search.result.degradation ? (en ? "Relevance sorting is unavailable. Check the listed sources carefully." : "暂时无法按相关程度排序，请逐条核对已找到的资料。") : (en ? "The sources could not be sorted, so no results were returned." : "资料整理未完成，本次未返回结果。")}</p>}
		</details>}
	</section>;
}
