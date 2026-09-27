import type { RequirementSourceView } from "../runtime/conversationContracts";

export function RequirementSource({ source, en }: { source?: RequirementSourceView; en: boolean }) {
	return <details className="fact-source">
		<summary>{en ? "Check source" : "核对原文"} · {source?.label ?? (en ? "Unavailable" : "暂不可用")}</summary>
		{source?.status === "available" && source.text
			? <><blockquote>{source.text}</blockquote>{source.truncated && <small>{en ? "Excerpt only; see the original attachment or conversation for full context." : "这里只展示摘录，完整上下文请查看原附件或会话。"}</small>}</>
			: <p>{source?.status === "withdrawn" ? (en ? "This source was withdrawn. Recheck the field against current material." : "该来源已撤回，请用当前资料重新核对字段。") : (en ? "No readable source excerpt. Check the original material before confirming." : "暂无可读原文，请查看原始资料后再确认。")}</p>}
		{source && <small className="source-digest">{source.ref}</small>}
	</details>;
}
