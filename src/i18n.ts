export type Language = "zh" | "en";

export const languageNames: Record<Language, string> = {
	zh: "中文",
	en: "English",
};

export const fieldLabels: Record<Language, Record<string, string>> = {
	zh: {},
	en: {
		product_type: "Packaging type",
		quantity: "Quantity",
		dimensions: "Dimensions",
		target_market: "Target market",
		target_delivery: "Target delivery date",
		delivery_location: "Delivery location",
		artwork_status: "Artwork status",
		material_structure: "Material structure", material_thickness: "Material thickness (with unit)", printing_process: "Printing process",
		surface_finish: "Surface finish", closure_type: "Closure type", valve_requirement: "Valve requirement",
	},
};

export const factStatusText: Record<Language, Record<string, string>> = {
	zh: {},
	en: { parsed: "Parsed", needs_ocr: "OCR required", metadata_only: "Metadata only", unsupported: "Unsupported format", approved: "Approved", superseded: "Superseded", cancelled: "Cancelled", suggested: "Suggested", unverified: "Unverified", verified: "Verified", rejected: "Rejected" },
};

export function labelFor(language: Language, key: string, fallback: string): string {
	return fieldLabels[language][key] ?? fallback;
}

export function statusFor(language: Language, key: string, fallback: string): string {
	return factStatusText[language][key] ?? fallback;
}

const errors: Record<string, [string, string]> = {
	plan_source_not_ready: ["请选择已完成的最新计划版本，再导入需求单。", "Select the latest completed plan before creating a requirement draft."],
	plan_source_stale: ["会话或附件已变化，请重新规划后导入需求单。", "The conversation or attachments changed. Create a new plan before importing."],
	plan_source_too_large: ["计划资料超过需求单输入上限，请拆分为较小任务。", "The plan source is too large. Split it into smaller tasks."],
	plan_source_required: ["此需求单来自计划，请使用计划导入入口更新来源。", "Use the plan import action to update this requirement source."],
	plan_mode_requires_plan_action: ["当前为 Plan 模式，请生成计划并确认具体版本，或切换直接执行。", "Generate and confirm a plan, or switch to Direct execution."],
	plan_revision_conflict: ["计划状态已更新，请查看最新状态后重试。", "The plan changed. Review its latest state and retry."],
	plan_sources_changed: ["会话或附件已变化，请重新生成计划并确认。", "The conversation or attachments changed. Generate and confirm a new plan."],
	plan_confirmation_required: ["请先确认当前版本的计划。", "Explicitly confirm the current plan version first."],
	plan_version_conflict: ["计划版本已变化，请确认最新版本。", "The plan version changed. Review the latest version."],
	pause_plan_before_switching: ["请先暂停当前计划，再切换模式。", "Pause the running plan before switching modes."],
	plan_not_ready: ["当前计划尚在执行，请暂停或等待完成。", "The current plan is running. Pause it or wait for completion."],
	plan_budget_exceeded: ["本计划已达到执行预算，请核对已有结果并重新规划。", "This plan reached its execution budget. Review results and create a new plan."],
	plan_requires_revision: ["此次失败需要修改计划后重新确认。", "Revise and confirm a new plan to resolve this failure."],
	plan_unavailable: ["计划服务暂时不可用，请稍后重试。", "The plan service is unavailable. Please retry later."],
	runtime_unavailable: ["无法连接 Packx 服务端，请检查服务是否启动。", "Cannot connect to Packx. Check that the server is running."],
	real_provider_required: ["请先配置并启动实际模型服务。", "Configure and start a live model service first."],
	local_access_denied: ["本地会话校验失败，请使用服务端显示的本机地址。", "Local session verification failed. Use the local address shown by the server."],
	conversation_not_found: ["会话已删除或不存在，请选择其他会话。", "This conversation was deleted or does not exist. Select another conversation."],
	conversation_cleanup_pending: ["会话已移除，关联任务仍在清理；请重试删除。", "The conversation was removed; related tasks are still being cleaned up. Retry deletion."],
	turn_in_progress: ["当前会话正在执行，请等待或停止后再试。", "This conversation is running. Wait or stop it before trying again."],
	turn_incomplete: ["上次回复未完成，请使用重试继续。", "The previous reply is incomplete. Use Retry to continue."],
	nothing_to_retry: ["当前没有可重试的消息。", "There is no message to retry."],
	message_conflict: ["消息内容已变化，请作为新消息发送。", "The message has changed. Send it as a new message."],
	file_path_denied: ["此文件路径受保护或包含链接，请选择普通文件的真实路径。", "This path is protected or contains links. Select the real path of a regular file."],
	file_scope_denied: ["当前会话没有此文件的访问权限。", "This conversation does not have access to this file."],
	file_not_found: ["文件或目标目录不存在，请刷新后检查路径。", "The file or destination directory does not exist. Refresh and check the path."],
	file_too_large: ["文件超过限制：文本最多 128 KiB，文档最多 10 MiB。", "File size exceeds the limit: 128 KiB for text or 10 MiB for documents."],
	file_input_invalid: ["文件内容或路径无效；PDF、DOCX、XLSX 请使用文档读取。", "Invalid file contents or path. Use document reading for PDF, DOCX and XLSX."],
	file_version_conflict: ["文件已变化，请重新读取并审批。", "The file has changed. Read it again and request a new approval."],
	file_approval_required: ["此次修改尚未批准或审批已过期，请重新发起审批。", "This change has not been approved, or approval expired. Request a new approval."],
	file_quota_exceeded: ["会话文件历史达到配额，请在新会话继续。", "The conversation file-history quota is full. Continue in a new conversation."],
	file_integrity_failure: ["文件内容校验失败，请核对原文件。", "File integrity verification failed. Check the original file."],
	permission_denied: ["此操作未获授权或被本机策略拒绝。", "This operation is not authorized or was denied by local policy."],
	cancelled: ["任务已停止，未完成内容不会视为正式结果。", "The task was stopped. Incomplete content is not a final result."],
	timeout: ["操作超时，请检查服务并重试。", "The operation timed out. Check the service and retry."],
	model_failure: ["模型调用失败，请检查模型状态后重试。", "The model call failed. Check model status and retry."],
	invalid_output: ["返回内容未通过校验，请检查文件格式或模型状态后重试。", "The response failed validation. Check the document format or model status and retry."],
	output_limit: ["模型输出达到上限，未接受不完整结果。请检查输出预算后明确发起新执行。", "The model reached its output limit. The incomplete result was rejected; review the output budget before starting a new execution."],
	invalid_conversation_request: ["消息或附件参数无效，请重新选择文件并发送。", "Invalid message or attachment parameters. Select the files again and send."],
	model_metrics_unavailable: ["模型统计暂时不可用，请稍后重试。", "Model statistics are temporarily unavailable. Try again shortly."],
};

export function errorText(error: unknown, language: Language): string {
	const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
	if (code && errors[code]) return errors[code][language === "en" ? 1 : 0];
	const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
	for (const pair of Object.values(errors)) if (pair.includes(message)) return pair[language === "en" ? 1 : 0];
	// Unmapped service errors remain diagnosable without leaking raw provider messages into UI.
	const fallback = ["操作失败，请刷新后重试。", "Operation failed. Refresh and retry."];
	const previousCode = fallback.some((text) => message.startsWith(text)) ? / \(([a-z_]{1,80})\)$/.exec(message)?.[1] : undefined;
	const safeCode = code ?? previousCode;
	return fallback[language === "en" ? 1 : 0] + (safeCode && /^[a-z_]{1,80}$/.test(safeCode) ? ` (${safeCode})` : "");
}

const validationLabels: Record<string, string> = {
	invalid_schema: "需求单结构版本无效", unexpected_field: "需求单含有未定义字段", invalid_industry: "当前仅支持包装行业需求",
	missing_title: "需求单缺少标题", missing_customer_goal: "缺少客户目标", invalid_facts: "需求事实必须为列表",
	invalid_fact: "需求事实格式无效", unexpected_fact_field: "需求事实含有未定义字段", invalid_fact_key: "需求事实缺少稳定字段名",
	duplicate_fact: "需求事实字段重复", invalid_fact_version: "需求事实版本无效", invalid_fact_value: "需求事实内容无效",
	invalid_fact_status: "需求事实状态无效", invalid_source_type: "需求事实来源类型无效", invalid_fact_unit: "需求事实单位无效",
	missing_source: "需求事实缺少来源引用", invalid_authority: "已确认事实缺少权威来源", unsupported_fact: "存在非标准包装需求字段",
	missing_fact_mismatch: "缺失字段列表与实际情况不一致", invalid_assumptions: "假设与限制必须为非空文字", invalid_next_action: "下一步操作与当前需求状态不匹配",
};
export function validationText(issue: { code: string; message: string }, language: Language): string {
	return language === "en" ? issue.message : `${validationLabels[issue.code] ?? "需求校验未通过"} (${issue.code})`;
}
