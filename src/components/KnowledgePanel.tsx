import { useEffect, useRef, useState } from "react";
import { ConversationClient } from "../runtime/conversationClient";
import type { KnowledgeSearchView, KnowledgeView, PackagingComparisonResult } from "../runtime/knowledgeView";
import type { EvidenceHit, KnowledgeQuery } from "../enterprise/knowledge";
import type { Language } from "../i18n";
import "./knowledge.css";
import { coffeeEvidenceQuestions, testConditionLabels } from "../manufacturing/packagingKnowledge";

const client = new ConversationClient();
export function KnowledgePanel({ conversationId, language }: { conversationId: string; language: Language }) {
	const en = language === "en";
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
	const [attachmentId, setAttachmentId] = useState("");
	const [leftParameter, setLeftParameter] = useState("");
	const [rightParameter, setRightParameter] = useState("");
	const [comparison, setComparison] = useState<PackagingComparisonResult>();
	const comparisonEpoch = useRef(0);
	useEffect(() => { comparisonEpoch.current++; setComparison(undefined); }, [conversationId, search, view, leftParameter, rightParameter, region, asOf]);
	const reload = async () => { const next = await client.knowledge(conversationId); setView(next); return next; };
	useEffect(() => {
		let active = true;
		void client.knowledge(conversationId).then((next) => { if (active) { setView(next); setIds(next.selection?.ids ?? []); } }).catch((e: Error) => { if (active) setError(e.message); });
		return () => { active = false; };
	}, [conversationId]);
	useEffect(() => {
		if (!view?.documents.some((doc) => ["imported", "parsed"].includes(doc.status))) return;
		const timer = window.setInterval(() => { void reload().catch((e: Error) => setError(e.message)); }, 1500);
		return () => window.clearInterval(timer);
	}, [view, conversationId]);
	const run = async (operation: () => Promise<unknown>) => {
		setBusy(true); setError(""); setNotice("");
		try { await operation(); await reload(); } catch (e) { setError(e instanceof Error ? e.message : "knowledge_operation_failed"); } finally { setBusy(false); }
	};
	const candidate = (hit: EvidenceHit, parameter: string) => run(async () => {
		await client.knowledgeCommand(conversationId, "candidate", { evidenceId: hit.evidenceId, parameter, requestId: crypto.randomUUID() });
		setNotice(en ? "Added as unverified. Review and confirm in Requirements." : "已加入待确认字段。请在需求单中核对并人工确认，再生成新版本。 ");
	});
	const hits = search?.result.hits ?? view?.hits ?? [];
	const review = search?.review ?? view?.review;
	const comparisonHits = [...new Map([...(view?.hits ?? []), ...hits].map((hit) => [hit.evidenceId, hit])).values()];
	const parameters = comparisonHits.flatMap((hit) => hit.parameters.map((p, index) => ({ value: JSON.stringify({ evidenceId: hit.evidenceId, parameterIndex: index }), label: `${hit.model} / ${p.subject ?? p.scope} / ${p.name}: ${p.originalValue} ${p.originalUnit} (${hit.revision})` })));
	const compare = async () => {
		const epoch = ++comparisonEpoch.current;
		setBusy(true); setError(""); setComparison(undefined);
		try {
			const result = await client.compareKnowledge(conversationId, { left: JSON.parse(leftParameter), right: JSON.parse(rightParameter), region, asOf: new Date(`${asOf}T00:00:00Z`).toISOString() });
			if (epoch === comparisonEpoch.current) setComparison(result);
		} catch (e) { if (epoch === comparisonEpoch.current) setError(e instanceof Error ? e.message : "comparison_failed"); }
		finally { setBusy(false); }
	};
	return <section className="knowledge-panel" aria-label={en ? "Packaging evidence" : "包装数据与证据"}>
		<p>{en ? "Select source evidence, then generate a requirement brief. Selection does not verify facts." : "选择证据后生成需求单。选入任务不等于确认事实；型号、地区与日期必须按当前订单核对。"}</p>
		<p>{en ? "Start with supplier product leads. Papers are supplementary references." : "选材先查供应商与产品系列。论文仅作研究参考；资料目录不能替代型号技术资料。"}</p>
		<button disabled={busy} onClick={() => void run(async () => { await client.knowledgeCommand(conversationId, "open-products", {}); setRegion("unknown"); setNotice("产品目录已提交导入，索引完成后可检索。仅包含官方入口和待核对项，不包含获授权的供应商全文或已确认生产参数。"); })}>{en ? "Import supplier product directory" : "导入供应商产品目录"}</button>
		<button disabled={busy || !query.trim()} onClick={() => void run(async () => { setSearch(await client.findCoffeeProducts(conversationId, query)); setRegion("unknown"); })}>{en ? "Search product directory" : "按当前问题查产品目录"}</button>
		{error && <p role="alert" className="knowledge-alert">{error === "start_requirement_with_selected_evidence_first" ? "先保存证据选择，再创建或重新生成需求单。" : error}</p>}
		{notice && <p role="status">{notice}</p>}
		{!!view?.unavailable.length && <p role="alert">{en ? "Selected evidence is no longer available. Remove it and review the sources." : "部分已选证据已撤回、过期或权限变化。停止引用，移除后重新核对。"}</p>}
		<form onSubmit={(e) => { e.preventDefault(); void run(async () => setSearch(await client.searchKnowledge(conversationId, { query, mode, ...(model ? { model } : {}), region, asOf: new Date(`${asOf}T00:00:00Z`).toISOString(), limit: 5 }))); }}>
			<p>{en ? "Ask one parameter at a time, then check its unit, method and conditions." : "先核对样品，再逐项问结构、层厚、单位、方法和条件。相关段落不代表问题已得到回答。"}</p>
			<div className="knowledge-fields">{coffeeEvidenceQuestions.map((step) => <button type="button" key={step.label} onClick={() => setQuery(step.query)}>{step.label}</button>)}</div>
			<label>{en ? "Question or exact model" : "问题 / 型号 / 材料缩写"}<input value={query} maxLength={300} onChange={(e) => setQuery(e.target.value)} required /></label>
			<div className="knowledge-fields">
				<label>{en ? "Exact document / model" : "限定资料 / 型号（精确）"}<input list="knowledge-document-models" value={model} onChange={(e) => setModel(e.target.value)} /><datalist id="knowledge-document-models">{view?.documents.map((d) => <option key={d.versionId} value={d.manifest.model}>{d.manifest.title}</option>)}</datalist></label>
				<label>{en ? "Region" : "订单地区"}<input value={region} onChange={(e) => setRegion(e.target.value)} required /></label>
				<label>{en ? "Applicable date" : "订单适用日期"}<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required /></label>
				<label>{en ? "Retrieval" : "检索路径"}<select value={mode} onChange={(e) => setMode(e.target.value as KnowledgeQuery["mode"])}><option value="keyword">{en ? "Keywords / exact fields" : "关键词 / 精确字段"}</option><option value="vector">{en ? "Vector" : "向量"}</option><option value="hybrid">{en ? "Hybrid (RRF)" : "混合（RRF）"}</option></select></label>
			</div>
			<button disabled={busy || !query.trim()} type="submit">{en ? "Search evidence" : "检索证据"}</button>
		</form>
		<small>{view?.embedding.kind === "local_model" ? "本地模型向量；以评测报告为准" : "当前为词项特征向量基线，未启用真实语义模型；不称为 BM25。"}</small>
		{search && <p role="status">{search.result.status} · {search.result.hits.length} {en ? "hits" : "条"} · {search.result.durationMs.toFixed(1)} ms · {search.result.gaps.join(" / ")}</p>}
		{search?.result.reranking && <p role="status">{search.result.reranking.status === "completed" ? (en ? `Locally reranked ${search.result.reranking.candidateCount} candidates` : `已对 ${search.result.reranking.candidateCount} 条候选证据进行本地重排`) : (en ? "Reranking failed; no evidence returned" : "重排失败，本次未返回证据")} · {search.result.reranking.durationMs.toFixed(0)} ms</p>}
		{search?.questions && <details open><summary>{en ? "Questions for the supplier" : "下一步逐项向供应商核对"}</summary>{search.questions.map((q) => <p key={q.field}>{q.question}</p>)}</details>}
		{search?.result.assessment && <aside role="status" className="knowledge-alert">
			<strong>{({ insufficient_evidence: en ? "Structured support is missing. Do not infer an answer." : "缺少结构化证据支持，不能据此下结论。", source_values_available: en ? "Source parameter records found; applicability and confirmation remain open." : "找到原始参数记录；不等于已回答全部问题或已确认适用。", needs_review: en ? "Read the source and resolve scope or test-condition gaps." : "需要核对原文、适用范围及测试条件。" })[search.result.assessment.status]}</strong>
			{search.result.assessment.checks.map((check) => <p key={check.field}>{check.field} · {check.status === "present" ? (en ? "Source record available" : "有原始记录") : check.status === "missing" ? (en ? "No matching structured record in retrieved evidence" : "当前命中无匹配的结构化记录") : (en ? "Needs review" : "待复核")} — {check.question}</p>)}
			<small>{en ? "This check does not establish absence from all documents or verify a Fact." : "这里只检查当前命中的结构化字段，不证明全文没有答案，也不确认业务事实。"}</small>
		</aside>}
		{hits.map((hit) => <article className="knowledge-evidence" key={hit.evidenceId}>
			<label><input type="checkbox" checked={ids.includes(hit.evidenceId)} disabled={busy || !ids.includes(hit.evidenceId) && ids.length >= 8} onChange={(e) => setIds(e.target.checked ? [...ids, hit.evidenceId] : ids.filter((id) => id !== hit.evidenceId))} />{hit.title}</label>
			<p>{hit.publisher} · {hit.model} · {hit.revision} · {hit.provenance === "synthetic" ? "合成测试，不可用于真实订单" : hit.provenance}</p>
			<small>{hit.location.page ? `p${hit.location.page} / ` : ""}{hit.location.section} {hit.location.table ?? ""}{hit.location.row ? ` / row ${hit.location.row}` : ""}{hit.location.paragraph ? ` / ¶${hit.location.paragraph}` : ""} · {hit.warnings.join(" / ")}</small>
			{hit.sourceUrl.startsWith("https://") && <p><a href={hit.sourceUrl + (hit.sourceUrl.endsWith(".pdf") && hit.location.page ? `#page=${hit.location.page}` : hit.location.anchor ? `#${encodeURIComponent(hit.location.anchor)}` : "")} target="_blank" rel="noreferrer">{en ? "Open original source" : "查看官方原始位置"}</a></p>}
			<details><summary>{hit.model.startsWith("catalog:") ? (en ? "Packx directory record (not vendor original)" : "Packx 整理的目录记录（不是厂商原文）") : (en ? "Original evidence (untrusted content)" : "资料原文（不可信输入）")}</summary><pre>{hit.text}</pre>{hit.table && <><div className="knowledge-table"><table><thead><tr>{hit.table.headers.map((h, i) => <th key={i}>{h} {hit.table!.units[i]}</th>)}</tr></thead><tbody>{hit.table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div><p>{hit.table.conditions}</p>{hit.table.footnotes.map((note) => <small key={note}>{note}</small>)}</>}</details>
			{hit.attribution && <small>{hit.attribution}</small>}
			{hit.parameters.map((parameter, index) => <div key={`${parameter.name}-${index}`} className="knowledge-parameter"><strong>{parameter.subject ? `${parameter.subject} / ` : ""}{parameter.name}</strong>: {parameter.originalValue} {parameter.originalUnit}{parameter.normalized && <span> → {parameter.normalized.value} {parameter.normalized.unit}</span>}<small>{parameter.method || "方法未知"} · {parameter.conditions || "条件未知"} · {parameter.authority} · {parameter.verification}</small>{parameter.authority !== "research_report" && ["structure", "thickness"].includes(parameter.name) && <button disabled={busy || !view?.selection?.ids.includes(hit.evidenceId)} onClick={() => void candidate(hit, parameter.name)}>{en ? "Add as an unverified requirement field" : "作为待确认字段加入需求单"}</button>}</div>)}
			<small className="knowledge-id">{hit.evidenceId}</small>
		</article>)}
		<p>{en ? "Selected" : "待选择"} {ids.length} / 8; {en ? "Saved" : "已保存"} {view?.selection?.ids.length ?? 0} (v{view?.selection?.version ?? 0}）。</p>
		<button disabled={busy || !region || !asOf} onClick={() => void run(async () => { await client.knowledgeCommand(conversationId, "select", { ids, applicability: { region, asOf: new Date(`${asOf}T00:00:00Z`).toISOString() }, expectedVersion: view?.selection?.version ?? 0, requestId: crypto.randomUUID() }); setNotice("已保存证据选择。现在可在 Plan 使用证据，或创建/重新生成需求单。材料与参数仍需人工确认。"); })}>{en ? "Save evidence selection to task" : "保存证据选择到当前任务"}</button>
		<details open><summary>{en ? "Compare two source parameters" : "明确选择两条来源参数进行比对"}</summary>
			<p>{en ? "Select the exact sample and layer. This compares observations and does not confirm order suitability." : "逐项选择样品、材料层和参数。这里比较来源记录，不确认当前订单适用性；需要引用到需求单时，仍须保存相应证据选择。"}</p>
			<div className="knowledge-fields">{[{ value: leftParameter, setValue: setLeftParameter, label: en ? "Left parameter" : "左侧参数" }, { value: rightParameter, setValue: setRightParameter, label: en ? "Right parameter" : "右侧参数" }].map(({ value, setValue, label }) => <label key={label}>{label}<select value={value} disabled={busy} onChange={(e) => setValue(e.target.value)}><option value="">{en ? "Choose a source record" : "请选择具体来源记录"}</option>{parameters.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>)}</div>
			<button disabled={busy || !region || !asOf || !parameters.some((p) => p.value === leftParameter) || !parameters.some((p) => p.value === rightParameter)} onClick={() => void compare()}>{en ? "Check comparability" : "核对是否可以比较"}</button>
			{comparison && <div role="status">
				<strong>{comparison.status === "comparable" ? (en ? "Numerically comparable observations; confirmation is still required." : "这两条记录满足数值比较规则，仍待人工核对适用性。") : (en ? "Direct numerical comparison is blocked." : "条件不足，不能直接进行数值比较。")}</strong>
				{comparison.status === "comparable" && <p>{en ? "Left minus right" : "左侧减右侧"}：{comparison.comparison.difference} {comparison.comparison.unit}</p>}
				{[comparison.left, comparison.right].map((source, i) => <article className="knowledge-evidence" key={i}>
					<strong>{i === 0 ? (en ? "Left" : "左侧") : (en ? "Right" : "右侧")} · {source.publisher} / {source.model} / {source.parameter.subject ?? source.parameter.scope}</strong>
					<p>{source.parameter.name}：{source.parameter.originalValue} {source.parameter.originalUnit}{source.parameter.normalized && ` → ${source.parameter.normalized.value} ${source.parameter.normalized.unit}`}</p>
					<p>{en ? "Method / conditions / scope" : "方法 / 原文条件 / 测量范围"}：{source.parameter.method || "未知"} / {source.parameter.conditions || "未知"} / {source.parameter.scope || "未知"}</p>
					{source.parameter.testConditions?.map((c) => <small key={c.name}>{!en && Object.hasOwn(testConditionLabels, c.name) ? testConditionLabels[c.name] : c.name}: {c.value} {c.unit}</small>)}
					<small>{source.revision} · {source.location.page ? `p${source.location.page} / ` : ""}{source.location.section} {source.location.table ?? ""} · {source.parameter.authority} · {source.parameter.verification}</small>
				</article>)}
				{comparison.questions.map((question) => <p key={question}>{question}</p>)}
				{comparison.warnings.includes("authority_types_differ") && <p role="alert">{en ? "The sources have different authority types; numerical comparability does not make their evidence equally strong." : "两条来源的权威类型不同；数值可以比较，不代表证据强度相同。"}</p>}
				<p>{en ? "This does not rank suppliers, certify compliance, approve facts or determine production parameters." : "该结果不代表厂商优劣、认证或合规结论，不确认事实，也不确定生产参数。"}</p>
				<details><summary>{en ? "Review trace" : "核对记录"}</summary><small>{comparison.ruleVersion} · {comparison.correlationId} · {comparison.createdAt}</small>{[comparison.left, comparison.right].map((s, i) => <p key={i}>{s.evidenceId} / parameter {s.parameterIndex + 1} · {s.contentHash}</p>)}</details>
			</div>}
		</details>
		{review && <details open><summary>{en ? "Supplier questions and source conflicts" : "供应商追问与来源冲突"}</summary>{review.questions.map((q) => <p key={q}>{q}</p>)}{review.limitations.map((q) => <small key={q}>{q}</small>)}{review.comparisonTruncated && <p role="status">{en ? "Automatic conflict hints cover only the first 64 pairs. Select specific parameters above to inspect the rest." : "自动冲突提示仅检查前 64 组；其余记录请在上方明确选择参数核对。"}</p>}{!!review.conflicts.length && <p role="alert">{en ? "Conflicting values for the same model and sample require review; the newest version is not automatically applicable." : "同型号、同样品资料存在数值差异，需要并列复核；不自动采用最新版。"}</p>}</details>}
		<details><summary>{en ? "Imports and quality (" : "导入与质量状态（"}{view?.documents.length ?? 0}）</summary>
			<button disabled={busy} onClick={() => void run(async () => { await client.knowledgeCommand(conversationId, "open-research", {}); setRegion("unknown"); if (view?.embedding.kind === "local_model") setMode("hybrid"); setQuery("REC 膜的克重及单位是什么？"); setNotice("导入 5 篇 CC BY 研究全文。地区为 unknown，仅作研究证据；不能直接用作订单参数。"); })}>{en ? "Import 5 licensed research papers" : "导入 5 篇获准使用的研究全文"}</button>
			<button disabled={busy} onClick={() => void run(() => client.knowledgeCommand(conversationId, "demo", {}))}>{en ? "Import two synthetic demo documents" : "导入 2 份合成演示资料"}</button>
			<button disabled={busy} onClick={() => void run(() => client.knowledgeCommand(conversationId, "rebuild", {}))}>{en ? "Rebuild index" : "重建索引"}</button>
			{view?.documents.map((doc) => <div className="knowledge-evidence" key={doc.versionId}><strong>{doc.manifest.title}</strong><p>{doc.status} · {doc.failure ?? doc.manifest.parser.reason}</p>{view.jobs.filter((job) => job.versionId === doc.versionId).map((job) => <p key={job.jobId}>{job.status} · {job.lastFailure?.code ?? ""} · {en ? "Failures / recoveries" : "失败 / 恢复"} {job.failureCount} / {job.recoveryCount}{job.status === "dead_letter" && <button disabled={busy} onClick={() => void run(() => client.knowledgeCommand(conversationId, "retry", { versionId: doc.versionId }))}>{en ? "Retry" : "重试"}</button>}</p>)}<small>{doc.manifest.revision} · {doc.importedAt} · {doc.manifest.visibility}</small>{["imported", "parsed"].includes(doc.status) && <button disabled={busy} onClick={() => void run(() => client.knowledgeCommand(conversationId, "cancel", { versionId: doc.versionId }))}>{en ? "Cancel import" : "取消导入"}</button>}{doc.status !== "withdrawn" && <button disabled={busy} onClick={() => void run(async () => { await client.knowledgeCommand(conversationId, "withdraw", { versionId: doc.versionId }); setSearch(undefined); })}>{en ? "Withdraw from retrieval (retain audit)" : "撤回检索（保留审计）"}</button>}</div>)}
			<label>{en ? "Authorized structured import manifest (JSON)" : "授权后的结构化资料清单（JSON）"}<textarea rows={6} value={manifest} onChange={(e) => setManifest(e.target.value)} placeholder={en ? "Use the import format in docs/knowledge/README.md. Public access is not an indexing license." : "按 docs/knowledge/README.md 的导入格式准备。公开可读不代表获准全文索引。"} /></label>
			<input type="file" accept=".json,application/json" aria-label={en ? "Read import manifest" : "读取导入清单"} onChange={(e) => { const file = e.target.files?.[0]; if (file && file.size <= 1_000_000) void file.text().then(setManifest); else setError("清单最大 1 MB"); }} />
			<button disabled={busy || !manifest} onClick={() => void run(() => client.knowledgeCommand(conversationId, "import", JSON.parse(manifest)))}>{en ? "Import under manifest permission" : "按清单授权导入"}</button>
			<label>{en ? "Uploaded attachment ID (optional, uses sandboxed parser)" : "已上传附件 ID（可选，调用现有受限解析器）"}<input value={attachmentId} onChange={(e) => setAttachmentId(e.target.value)} /></label><button disabled={busy || !manifest || !attachmentId} onClick={() => void run(() => client.knowledgeCommand(conversationId, "parse-attachment", { manifest: JSON.parse(manifest), attachmentId }))}>{en ? "Parse attachment into pending review" : "解析附件并进入待复核"}</button>
		</details>
		<details><summary>{en ? "Real source registry and coverage gaps (metadata only)" : "真实数据源登记与覆盖缺口（不是全文语料）"}</summary>{view?.sources.map((source) => <article key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.publisher} · {source.type}</a><p>{source.scope} · {source.version}</p><small>{source.permission} · {source.limitation} · {source.robots}</small><a href={source.terms} target="_blank" rel="noreferrer">{en ? "Usage terms review" : "条款核验入口"}</a></article>)}{view?.coverage.map((row, i) => <p key={i}>{row.category} × {row.material} × {row.process} × {row.region}：{row.missing}</p>)}</details>
	</section>;
}
