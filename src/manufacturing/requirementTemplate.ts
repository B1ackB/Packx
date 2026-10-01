import { factStatusLabels, requirementFieldLabels, type RequirementDelivery } from "./requirementDelivery";

export interface RequirementTemplateView {
	templateId: string;
	name: string;
	sha256: string;
	format: "docx" | "xlsx";
	slots: Array<{ key: string; location: string; context: string }>;
}
export interface RequirementTemplatePreview {
	template: RequirementTemplateView;
	mapping: Record<string, string>;
	values: Record<string, string>;
	errors: string[];
	reviewHash: string;
	status: RequirementDelivery["status"];
	version: number;
}
export const templateFieldLabels: Record<string, string> = {
	delivery_status: "需求版本状态", version: "需求版本", title: "需求标题", customer_goal: "客户目标", missing_fields: "缺失字段", assumptions: "假设与限制", ...requirementFieldLabels,
};
export function templateFieldValues(delivery: RequirementDelivery): Record<string, string> {
	return {
		delivery_status: `${{ draft: "待确认草稿 / DRAFT", approved: "需求版本已批准 / BRIEF APPROVED", stale: "已失效 / STALE" }[delivery.status]}；模板映射不等于文件审批；非生产文件`,
		version: `v${delivery.version}${delivery.approval ? ` · ${delivery.approval.approvalId}` : ""}`,
		title: delivery.content.title, customer_goal: delivery.content.customerGoal,
		missing_fields: delivery.content.missingRequiredFacts.map((key) => requirementFieldLabels[key] ?? key).join("、") || "无",
		assumptions: delivery.content.assumptions.join("；") || "无",
		...Object.fromEntries(Object.keys(requirementFieldLabels).map((key) => {
			const fact = delivery.content.facts.find((fact) => fact.key === key);
			return [key, fact ? `${fact.value}${fact.unit ? ` ${fact.unit}` : ""}${fact.status === "verified" ? "" : ` [${factStatusLabels[fact.status]} / UNVERIFIED]`}` : "[缺失 / MISSING]"];
		})),
	};
}
