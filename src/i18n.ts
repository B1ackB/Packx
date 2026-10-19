export type Language = "zh" | "en";

export const languageNames: Record<Language, string> = {
	zh: "中文",
	en: "English",
};

export const fieldLabels: Record<Language, Record<string, string>> = {
	zh: {},
	en: {
		delivery_status: "Brief status", version: "Brief version", title: "Brief title", customer_goal: "Customer goal", missing_fields: "Missing information", assumptions: "Assumptions and limitations",
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
	zh: { parsed: "已读取", needs_ocr: "需要识别文字", metadata_only: "仅有文件信息", unsupported: "暂不支持读取" },
	en: { parsed: "Text available", needs_ocr: "Text recognition needed", metadata_only: "File information only", unsupported: "Unsupported format", approved: "Approved", superseded: "Superseded", cancelled: "Cancelled", suggested: "Suggested", unverified: "Unverified", verified: "Verified", rejected: "Rejected" },
};

export function labelFor(language: Language, key: string, fallback: string): string {
	return fieldLabels[language][key] ?? fallback;
}

export function statusFor(language: Language, key: string, fallback: string): string {
	return factStatusText[language][key] ?? fallback;
}

const errors: Record<string, [string, string]> = {
	report_selection_changed: ["任务所选报告或来源已变化，请核对所选版本并重新规划。", "The selected report or its sources changed. Review the selection and replan."],
	plan_report_import_unsupported: ["资料报告来源的任务结果仅供核对，暂不能直接导入需求单。", "Report-backed task results are for review; direct requirement import is not enabled."],
	report_invalid_command: ["请选择不重复的资料，并填写报告名称；最多 6 项来源、3 个网页。", "Choose distinct sources and a title; at most 6 sources including 3 pages."],
	report_running: ["当前报告仍在处理，请等待或取消后再新建。", "Wait for the current report or cancel it before starting another."],
	report_revision_conflict: ["报告状态已更新，请核对最新状态后重试。", "The report state changed. Review the latest state and retry."],
	report_source_changed: ["来源版本已变化或格式不支持，请重新选择文本资料。", "The source changed or is unsupported. Select the text source again."],
	report_source_unavailable: ["来源暂不可用，请核对资料是否已撤回及访问权限。", "A source is unavailable. Check withdrawal and access permissions."],
	report_artifact_corrupt: ["保存的报告或原文校验失败，已停止读取，请保留资料并排查。", "Saved report or source validation failed. Reading stopped; preserve the data for review."],
	report_version_limit: ["本任务已达 12 个报告版本，请核对已有报告。", "This task reached 12 report versions. Review existing reports."],
	report_not_retryable: ["此报告不能继续重试，请核对失败原因和已有资料。", "This report cannot be retried. Review the cause and saved sources."],
	source_too_large: ["单份来源超过 128 KiB，请拆分资料。", "A source exceeds 128 KiB. Split it into smaller files."],
	source_empty: ["来源没有可读取的文字，请检查原文。", "The source contains no readable text. Check the original."],
	web_url_denied: ["仅允许配置域名内的 HTTPS 网页，不接受登录信息、查询参数或其他端口。", "Use HTTPS on a permitted domain, without credentials, query parameters or other ports."],
	web_private_address: ["网页解析到私有或受限地址，已停止访问。", "The page resolved to a private or restricted address. Access stopped."],
	web_redirect_limit: ["网页重定向过多或无效，请使用原始资料的直接链接。", "The redirects are excessive or invalid. Use a direct source link."],
	web_content_unsupported: ["网页需为 UTF-8 纯文本或静态 HTML；不支持登录、脚本页面和压缩内容。", "Use UTF-8 plain text or static HTML; sign-in, scripts and compressed content are unsupported."],
	web_http_error: ["网页服务返回错误，请检查链接，或稍后重试可恢复的任务。", "The website returned an error. Check the link or retry recoverable work later."],
	web_timeout: ["网页读取超时，可重试剩余资料。", "Reading the page timed out. Retry the remaining sources."],
	web_unavailable: ["网页暂时无法连接，可稍后重试剩余资料。", "The page is temporarily unreachable. Retry the remaining sources later."],
	invalid_plan_dependencies: ["计划中的任务依赖无效，请重新生成并核对顺序。", "The task dependencies are invalid. Generate and review a new plan."],
	plan_dependency_not_ready: ["所需的前置任务尚无完成依据，请核对已有结果并重新规划。", "A prerequisite has no completion evidence. Review results and replan."],
	plan_dependency_context_too_large: ["前置任务的结果过长，请缩小任务范围后重新规划。", "The prerequisite reports are too large. Narrow the task and replan."],
	plan_source_not_ready: ["请选择已完成的最新计划版本，再导入需求单。", "Select the latest completed plan before creating a requirement draft."],
	plan_source_stale: ["会话或附件已变化，请重新规划后导入需求单。", "The conversation or attachments changed. Create a new plan before importing."],
	plan_source_too_large: ["计划资料超过需求单输入上限，请拆分为较小任务。", "The plan source is too large. Split it into smaller tasks."],
	plan_source_required: ["此需求单来自计划，请使用计划导入入口更新来源。", "Use the plan import action to update this requirement source."],
	plan_mode_requires_plan_action: ["当前选择了先规划，请生成并确认计划，或切换为直接执行。", "Generate and confirm a plan, or switch to Direct execution."],
	plan_revision_conflict: ["计划状态已更新，请查看最新状态后重试。", "The plan changed. Review its latest state and retry."],
	plan_sources_changed: ["会话或附件已变化，请重新生成计划并确认。", "The conversation or attachments changed. Generate and confirm a new plan."],
	plan_confirmation_required: ["请先确认当前版本的计划。", "Explicitly confirm the current plan version first."],
	plan_version_conflict: ["计划版本已变化，请确认最新版本。", "The plan version changed. Review the latest version."],
	pause_plan_before_switching: ["请先暂停当前计划，再切换模式。", "Pause the running plan before switching modes."],
	plan_not_ready: ["当前计划尚在执行，请暂停或等待完成。", "The current plan is running. Pause it or wait for completion."],
	plan_budget_exceeded: ["本计划已达到执行预算，请核对已有结果并重新规划。", "This plan reached its execution budget. Review results and create a new plan."],
	plan_requires_revision: ["此次失败需要修改计划后重新确认。", "Revise and confirm a new plan to resolve this failure."],
	plan_unavailable: ["计划服务暂时不可用，请稍后重试。", "The plan service is unavailable. Please retry later."],
	runtime_unavailable: ["暂时无法连接 Packx，请重新打开后重试。", "Cannot connect to Packx. Reopen it and try again."],
	real_provider_required: ["请先配置并启动实际模型服务。", "Configure and start a live model service first."],
	local_access_denied: ["当前页面无法访问此工作台，请从 Packx 重新打开。", "This page cannot access the workspace. Open it again from Packx."],
	conversation_not_found: ["会话已删除或不存在，请选择其他会话。", "This conversation was deleted or does not exist. Select another conversation."],
	conversation_cleanup_pending: ["会话已移除，关联任务仍在清理；请重试删除。", "The conversation was removed; related tasks are still being cleaned up. Retry deletion."],
	turn_in_progress: ["当前会话正在执行，请等待或停止后再试。", "This conversation is running. Wait or stop it before trying again."],
	turn_incomplete: ["上次回复未完成，请使用重试继续。", "The previous reply is incomplete. Use Retry to continue."],
	nothing_to_retry: ["当前没有可重试的消息。", "There is no message to retry."],
	message_conflict: ["消息内容已变化，请作为新消息发送。", "The message has changed. Send it as a new message."],
	file_path_denied: ["无法访问此文件，请选择有权使用的原文件。", "Cannot access this file. Select an original file you have permission to use."],
	file_scope_denied: ["当前会话没有此文件的访问权限。", "This conversation does not have access to this file."],
	file_not_found: ["文件或目标目录不存在，请刷新后检查路径。", "The file or destination directory does not exist. Refresh and check the path."],
	file_too_large: ["文件超过限制：文本最多 128 KiB，文档最多 10 MiB。", "File size exceeds the limit: 128 KiB for text or 10 MiB for documents."],
	file_input_invalid: ["文件内容或路径无效；PDF、DOCX、XLSX 请使用文档读取。", "Invalid file contents or path. Use document reading for PDF, DOCX and XLSX."],
	file_version_conflict: ["文件已变化，请重新读取并审批。", "The file has changed. Read it again and request a new approval."],
	file_approval_required: ["此次修改尚未批准或审批已过期，请重新发起审批。", "This change has not been approved, or approval expired. Request a new approval."],
	file_quota_exceeded: ["会话文件历史达到配额，请在新会话继续。", "The conversation file-history quota is full. Continue in a new conversation."],
	file_integrity_failure: ["文件内容校验失败，请核对原文件。", "File integrity verification failed. Check the original file."],
	permission_denied: ["你暂时没有执行此操作的权限，请联系管理员。", "You do not have permission for this action. Contact your administrator."],
	cancelled: ["任务已停止，未完成内容不会视为正式结果。", "The task was stopped. Incomplete content is not a final result."],
	timeout: ["操作超时，请检查服务并重试。", "The operation timed out. Check the service and retry."],
	model_failure: ["AI 暂时未能完成处理，请检查模型连接后重试。", "AI could not complete the request. Check the model connection and retry."],
	invalid_output: ["返回内容未通过校验，请检查文件格式或模型状态后重试。", "The response failed validation. Check the document format or model status and retry."],
	output_limit: ["本次内容过长，结果未完成。请缩小任务范围后重新执行。", "The result is too long to complete. Split the request into smaller tasks and try again."],
	invalid_conversation_request: ["消息或附件参数无效，请重新选择文件并发送。", "Invalid message or attachment parameters. Select the files again and send."],
	model_metrics_unavailable: ["模型统计暂时不可用，请稍后重试。", "Model statistics are temporarily unavailable. Try again shortly."],
	start_requirement_with_selected_evidence_first: ["请先保存所选资料，再生成或更新需求单。", "Save the selected sources, then create or update the brief."],
	evidence_unavailable: ["部分资料已不可用，请重新选择并核对来源。", "Some sources are no longer available. Choose and review current sources."],
	knowledge_access_denied: ["你没有使用这些资料的权限，请联系管理员。", "You do not have access to these sources. Contact your administrator."],
	knowledge_operation_failed: ["资料处理未完成，请检查授权和导入文件后重试。", "The sources could not be processed. Check permissions and the import file, then retry."],
	invalid_import_package: ["无法读取此资料包，请选择管理员提供的有效文件。", "Cannot read this source package. Choose a valid file supplied by your administrator."],
	import_package_too_large: ["资料包不能超过 1 MB，请拆分后导入。", "Source packages must be under 1 MB. Split this package before importing."],
	invalid_attachment_import: ["请选择已上传的文件，并提供对应的资料包。", "Choose an uploaded file and its matching source package."],
	requirement_worker_busy: ["需求单正在处理，请等待完成后重试。", "The brief is being processed. Wait for it to finish before retrying."],
	sample_or_ambiguous_parameter_requires_supplier_confirmation: ["这些参数来自研究样品或有多个对应值，请先向供应商核对。", "These values refer to research samples or multiple alternatives. Check with the supplier first."],
	evidence_candidate_conflict: ["该信息已有其他版本，请在需求单中核对后再添加。", "Another version of this information exists. Review it in the brief before adding it."],
	memory_revision_conflict: ["记忆内容已变化，请核对最新版本后重试。", "This memory has changed. Review the latest version and retry."],
	memory_topic_conflict: ["已有同主题记忆，请修改现有条目。", "A memory with this topic already exists. Edit that entry instead."],
	memory_source_unavailable: ["来源已不可用或记忆已到期，请重新核对。", "The source is unavailable or this memory has expired. Review it again."],
	memory_secret_denied: ["内容可能包含密码或连接密钥，请移除后再保存。", "This may contain a password or access key. Remove it before saving."],
	memory_active_limit: ["已达有效记忆上限，请先忘记不再需要的条目。", "The memory limit has been reached. Forget unused entries first."],
	trial_version_stale: ["需求单已更新，请核对当前版本后重新记录。", "The brief has changed. Review the current version before recording a new trial."],
	invalid_requirement_brief_request: ["请核对填写内容和需求单版本后重试。", "Check the entered information and brief version, then retry."],
	template_too_large: ["模板不能超过 5 MB，请缩小文件后重新上传。", "Templates must be under 5 MB. Reduce the file size and upload it again."],
	invalid_template: ["模板暂时无法使用，请核对填写标记和文件格式后重试。", "This template cannot be used yet. Check its fill-in markers and file format, then retry."],
};

export function errorText(error: unknown, language: Language): string {
	const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
	if (code && errors[code]) return errors[code][language === "en" ? 1 : 0];
	const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
	if (errors[message]) return errors[message][language === "en" ? 1 : 0];
	for (const pair of Object.values(errors)) if (pair.includes(message)) return pair[language === "en" ? 1 : 0];
	// Technical error details remain in service records, not customer-facing copy.
	return language === "en" ? "Operation failed. Refresh and retry." : "操作失败，请刷新后重试。";
}

const validationLabels: Record<string, [string, string]> = {
	invalid_schema: ["需求单暂时无法读取，请重新生成。", "This brief cannot be read. Generate it again."],
	unexpected_field: ["需求单含有无法识别的信息，请重新生成。", "The brief contains information that could not be recognized. Generate it again."],
	invalid_industry: ["当前仅支持包装行业需求。", "Only packaging requests are supported."],
	missing_title: ["请补充需求单标题。", "Add a title to the brief."], missing_customer_goal: ["请补充客户目标。", "Add the customer's goal."],
	invalid_facts: ["需求信息未能整理完成，请重新生成。", "The requirement information is incomplete. Generate it again."],
	invalid_fact: ["部分需求信息无法读取，请核对后重新生成。", "Some requirement information cannot be read. Review it and generate the brief again."],
	unexpected_fact_field: ["部分需求信息无法识别，请核对后重新生成。", "Some requirement information was not recognized. Review it and generate the brief again."],
	invalid_fact_key: ["部分信息缺少名称，请核对后重新生成。", "Some information has no label. Review it and generate the brief again."],
	duplicate_fact: ["需求信息存在重复，请核对后重新生成。", "Some requirements are duplicated. Review them and generate the brief again."],
	invalid_fact_version: ["部分信息版本不一致，请重新生成。", "Some information belongs to a different version. Generate the brief again."],
	invalid_fact_value: ["部分需求内容无效，请核对并修正。", "Some requirement values are invalid. Review and correct them."],
	invalid_fact_status: ["部分信息的确认状态异常，请重新核对。", "Some confirmation statuses could not be read. Review the information again."],
	invalid_source_type: ["部分信息的来源无法识别，请补充来源。", "Some sources could not be identified. Provide the original material."],
	invalid_fact_unit: ["部分数值的单位无效，请核对并修正。", "Some units are invalid. Review and correct them."],
	missing_source: ["部分信息缺少来源，请补充原文或资料。", "Some information has no source. Add the original text or document."],
	invalid_authority: ["已确认的信息仍缺少可靠来源，请补充依据。", "Confirmed information is missing a reliable source. Add supporting material."],
	unsupported_fact: ["部分信息不属于当前包装需求项目，请核对。", "Some information does not match the supported packaging requirements. Review it."],
	missing_fact_mismatch: ["待补充清单与需求内容不一致，请重新生成。", "The missing-information list does not match the brief. Generate it again."],
	invalid_assumptions: ["请补充完整的假设与限制说明。", "Complete the assumptions and limitations."],
	invalid_next_action: ["当前处理进度已变化，请刷新后继续。", "The task status has changed. Refresh before continuing."],
	invalid_pending_changes: ["待确认的变更未能完整保存，请重新生成。", "The proposed changes could not be saved in full. Generate the brief again."],
	invalid_pending_change: ["待确认的变更与当前信息不一致，请重新核对。", "A proposed change does not match the current information. Review it again."],
	invalid_candidate_conflicts: ["不同来源的核对记录不完整，请重新生成后确认。", "The source comparison is incomplete. Generate the brief again before confirming."],
};
export function validationText(issue: { code: string; message: string }, language: Language): string {
	return validationLabels[issue.code]?.[language === "en" ? 1 : 0] ?? (language === "en" ? "The brief needs another review. Check the information and generate it again." : "需求单检查未通过，请核对信息后重新生成。");
}

const documentWarnings: Record<string, [string, string]> = {
	ocr_supplement_may_conflict: ["识别文字可能与原文不一致，数值请以核对原件为准。", "Recognized text may differ from the original. Check values against the source."],
	ocr_requires_review: ["文字由自动识别获得，请对照原件核对。", "This text was recognized automatically. Check it against the original."],
	layout_not_preserved: ["表格排版和阅读顺序可能与原件不同。", "Table layout and reading order may differ from the original."],
	low_ocr_confidence: ["部分文字可能识别有误，请重点核对。", "Some text may have been read incorrectly. Review it carefully."],
	no_text_recognized: ["未识别出文字，请提供更清晰的文件或文字版。", "No text was recognized. Provide a clearer file or a text version."],
	ocr_failed: ["文字识别失败，请重试或提供文字版。", "Text recognition failed. Retry or provide a text version."],
	ocr_pending: ["此页尚未识别，请继续读取后续页面。", "This page has not been read yet. Continue reading the remaining pages."],
	page_render_failed: ["此页无法打开，请检查原文件。", "This page could not be opened. Check the original file."],
	invalid_page_bounds: ["此页尺寸异常，请检查原文件。", "This page has unusual dimensions. Check the original file."],
};
export function documentWarningText(warning: string, language: Language): string {
	return documentWarnings[warning]?.[language === "en" ? 1 : 0] ?? (language === "en" ? "Part of this document needs review against the original." : "部分内容需要对照原件核对。");
}
export function documentMethodText(method: string | undefined, language: Language): string {
	return method === "ocr" || method === "text+ocr" ? (language === "en" ? "Recognized text" : "识别文字") : (language === "en" ? "Document text" : "文档文字");
}
