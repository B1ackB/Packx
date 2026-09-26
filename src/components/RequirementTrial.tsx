import { useEffect, useRef, useState, type FormEvent } from "react";
import { ConversationClient, ConversationClientError } from "../runtime/conversationClient";
import type { RequirementBriefWorkspaceView } from "../runtime/conversationContracts";
import type { RequirementTrialInput, RequirementTrialObservation } from "../manufacturing/requirementTrial";

const client = new ConversationClient();

export function RequirementTrial({ conversationId, workspace, en }: { conversationId: string; workspace: RequirementBriefWorkspaceView; en: boolean }) {
	const [startedAt, setStartedAt] = useState("");
	const [version, setVersion] = useState(0);
	const [running, setRunning] = useState(false);
	const [displayMs, setDisplayMs] = useState(0);
	const [caseId, setCaseId] = useState("");
	const [reviewer, setReviewer] = useState("");
	const [sourceKind, setSourceKind] = useState<RequirementTrialInput["sourceKind"]>("synthetic");
	const [corrections, setCorrections] = useState(0);
	const [errors, setErrors] = useState(0);
	const [outcome, setOutcome] = useState<RequirementTrialInput["outcome"] | "">("");
	const [notes, setNotes] = useState("");
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState<RequirementTrialObservation>();
	const [editableAfterFailure, setEditableAfterFailure] = useState(false);
	const [error, setError] = useState("");
	const timer = useRef({ activeSince: null as number | null, total: 0, interruptions: 0 });
	const pending = useRef<RequirementTrialInput | null>(null);
	const pause = () => {
		const current = timer.current;
		if (current.activeSince === null) return;
		current.total += Math.max(0, performance.now() - current.activeSince);
		current.activeSince = null;
		current.interruptions += 1;
		setRunning(false); setDisplayMs(current.total);
	};
	useEffect(() => {
		const tick = setInterval(() => { const t = timer.current; if (t.activeSince !== null) setDisplayMs(t.total + performance.now() - t.activeSince); }, 500);
		const hidden = () => { if (document.hidden) pause(); };
		const unloading = (event: BeforeUnloadEvent) => { if (timer.current.total > 0 || timer.current.activeSince !== null) event.preventDefault(); };
		window.addEventListener("blur", pause); document.addEventListener("visibilitychange", hidden); window.addEventListener("beforeunload", unloading);
		return () => { clearInterval(tick); window.removeEventListener("blur", pause); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("beforeunload", unloading); };
	}, []);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!outcome || running) return;
		setBusy(true); setError(""); setEditableAfterFailure(false);
		// Reuse exactly the same payload after a lost response; a retry cannot create another observation.
		const input = pending.current ?? { observationId: crypto.randomUUID(), caseId: caseId.trim(), reviewerAlias: reviewer.trim(), sourceKind, artifactVersion: version, expectedAggregateVersion: workspace.state.aggregateVersion, startedAt, endedAt: new Date().toISOString(), recordedReviewMs: Math.round(timer.current.total), interruptions: timer.current.interruptions, correctionCount: corrections, criticalErrorCount: errors, outcome, notes };
		pending.current = input;
		try { setSaved(await client.saveRequirementTrial(conversationId, input)); timer.current.total = 0; }
		catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setEditableAfterFailure(reason instanceof ConversationClientError && ["trial_version_stale", "invalid_requirement_brief_request"].includes(reason.code)); }
		finally { setBusy(false); }
	};
	const download = () => {
		const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2)], { type: "application/json" }));
		const link = document.createElement("a"); link.href = url; link.download = `review-trial-${saved!.input.observationId}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
	};
	return <details className="proposal-section trial-recorder">
		<summary>{en ? "Record a usability trial" : "记录一次试用"}</summary>
		<p>{en ? "Review time only. Pause while waiting or taking a break; leaving this window pauses automatically. Unsaved records are lost when switching tasks. Use case IDs and aliases, without customer details." : "仅记录人工核对计时。等待或休息时请暂停；离开窗口会自动暂停。切换任务会丢失未保存记录。请使用样例编号和人员代号，不填客户信息。"}</p>
		{saved ? <><p role="status">{en ? "Saved" : "已保存"} · v{saved.input.artifactVersion} · {saved.input.observationId}</p><button onClick={download}>{en ? "Download trial record" : "下载试用记录"}</button><details className="source-page"><summary>{en ? "View saved JSON" : "查看已保存的 JSON"}</summary><pre>{JSON.stringify(saved, null, 2)}</pre></details></> : <form onSubmit={(event) => void save(event)}>
			<fieldset disabled={busy || Boolean(pending.current)}>
				<label>{en ? "Case ID" : "样例编号"}<input required maxLength={80} value={caseId} onChange={(e) => setCaseId(e.target.value)} /></label>
				<label>{en ? "Reviewer alias" : "核对人员代号"}<input required maxLength={40} value={reviewer} onChange={(e) => setReviewer(e.target.value)} /></label>
				<label>{en ? "Data source" : "数据类型"}<select value={sourceKind} onChange={(e) => setSourceKind(e.target.value as typeof sourceKind)}><option value="synthetic">{en ? "Synthetic" : "合成样例"}</option><option value="authorized_real">{en ? "Authorized real material" : "已获授权的真实资料"}</option></select></label>
				<p role="timer">{Math.floor(displayMs / 60_000)}:{String(Math.floor(displayMs / 1000) % 60).padStart(2, "0")} · {running ? (en ? "Timing review" : "正在计时") : (en ? "Paused" : "已暂停")}</p>
				<button type="button" disabled={!workspace.state.currentProposal} onClick={() => { if (running) pause(); else { if (!startedAt) { setStartedAt(new Date().toISOString()); setVersion(workspace.state.currentProposal!.version); } timer.current.activeSince = performance.now(); setRunning(true); } }}>{running ? (en ? "Pause" : "暂停计时") : (en ? "Start / resume review" : "开始／继续核对计时")}</button>
				<label>{en ? "Fields corrected" : "人工修正字段数"}<input required type="number" min={0} max={10000} step={1} value={corrections} onChange={(e) => setCorrections(e.target.valueAsNumber)} /></label>
				<label>{en ? "Critical errors found" : "发现的关键错误数"}<input required type="number" min={0} max={10000} step={1} value={errors} onChange={(e) => setErrors(e.target.valueAsNumber)} /></label>
				<label>{en ? "Reviewer outcome" : "核对者验收结果"}<select required value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}><option value="">{en ? "Choose" : "请选择"}</option><option value="usable">{en ? "Usable after review" : "核对后可用"}</option><option value="needs_work">{en ? "Still needs work" : "仍需返工"}</option><option value="abandoned">{en ? "Abandoned" : "放弃任务"}</option></select></label>
				<label>{en ? "Failure / correction notes" : "失败或修正说明"}<textarea maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
			</fieldset>
			{pending.current && <p>{en ? "Retry preserves the original record. To revise a rejected record, unlock the form." : "重试会保留原始记录。若请求被拒绝，可解锁表单后重新核对。"} <button type="button" disabled={busy || !editableAfterFailure} onClick={() => { pending.current = null; setError(""); setEditableAfterFailure(false); }}>{en ? "Unlock" : "解锁表单"}</button></p>}
			<button type="submit" disabled={busy || running || !startedAt || !outcome}>{en ? "Save review record" : "保存核对记录"}</button>
			{error && <p role="alert">{error}</p>}
		</form>}
	</details>;
}
