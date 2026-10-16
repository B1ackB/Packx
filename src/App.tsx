import { DocumentImportPreview } from "./components/DocumentImportPreview";
import { KnowledgePanel } from "./components/KnowledgePanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { ModelSettings } from "./components/ModelSettings";
import { PlanPanel } from "./components/PlanPanel";
import { planBudgetBlock, type PlanWorkspace } from "./enterprise/agentPlan";
import { errorText, validationText } from "./i18n";
import { ModelMonitor } from "./components/ModelMonitor";
import { FileExplorer } from "./components/FileExplorer";
import { ChangeEvent, FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "./components/Markdown";
import { ConversationFiles } from "./components/ConversationFiles";
import { DeleteConversationDialog } from "./components/DeleteConversationDialog";
import { RequirementTrial } from "./components/RequirementTrial";
import { RequirementSource } from "./components/RequirementSource";
import { WorkspaceTutorial, tutorialSteps } from "./components/WorkspaceTutorial";
import { DeliveryPreview } from "./components/DeliveryPreview";
import { requirementFieldLabels, factStatusLabels } from "./manufacturing/requirementDelivery";
import { languageNames, labelFor, statusFor, type Language } from "./i18n";
import type { AssetInspectionRecord } from "./runtime/assetInspection";
import { packagingFactKeys } from "./manufacturing/requirementBrief";
import type { RuntimeActivity } from "./runtime/conversationContracts";
import type { HostRuntimeHealth as RuntimeHealth } from "./runtime/hostCapabilities";
import { documentCapabilityText } from "./runtime/hostCapabilities";
import { ConversationClient, ConversationClientError } from "./runtime/conversationClient";
import type {
	BackgroundTaskView,
	ConversationAttachment,
	ConversationMessage,
	ConversationSummary,
	ConversationView,
	CronScheduleView,
	RequirementBriefMetricsSeriesView,
	RequirementBriefWorkspaceView,
} from "./runtime/conversationContracts";
import type {
	RequirementBriefEvaluation,
	RequirementBriefV1,
} from "./manufacturing/requirementBrief";

const client = new ConversationClient();
let bootstrapPromise: Promise<{
	health: RuntimeHealth;
	conversations: ConversationSummary[];
	active: ConversationView | undefined;
}> | undefined;

function summary(conversation: ConversationView): ConversationSummary {
	return {
		conversationId: conversation.conversationId,
		title: conversation.title,
		preview: conversation.preview,
		updatedAt: conversation.updatedAt,
		messageCount: conversation.messages.length,
	};
}

async function bootstrap(language: Language) {
	if (!bootstrapPromise) {
		bootstrapPromise = (async () => {
			const [health, existing] = await Promise.all([client.health(), client.list(language)]);
			const active = existing[0]
				? await client.get(existing[0].conversationId, language)
				: undefined;
			return {
				health,
				conversations: existing,
				active,
			};
		})();
	}
	return bootstrapPromise;
}

function displayTime(value: string, language: Language): string {
	return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(value));
}

function attachmentIdFromSourceRef(sourceRef: string): string | undefined {
	return /^attachment:\/\/[^/]+\/(attachment-[A-Za-z0-9]+)$/.exec(sourceRef)?.[1];
}

function errorMessage(error: unknown): string { return errorText(error, document.documentElement.lang === "en" ? "en" : "zh"); }

function requirementContent(value: unknown): RequirementBriefV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<RequirementBriefV1>;
	return candidate.schemaVersion === "requirement-brief.v1" &&
		typeof candidate.title === "string" &&
		typeof candidate.customerGoal === "string" &&
		Array.isArray(candidate.facts) &&
		Array.isArray(candidate.missingRequiredFacts)
		? candidate as RequirementBriefV1
		: undefined;
}

function evaluationReport(value: unknown): RequirementBriefEvaluation | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<RequirementBriefEvaluation>;
	return candidate.schemaVersion === "requirement-brief-evaluation.v1" &&
		typeof candidate.passed === "boolean" &&
		Array.isArray(candidate.issues)
		? candidate as RequirementBriefEvaluation
		: undefined;
}

const stageLabels = {
	pending: "等待开始",
	running: "正在生成",
	evaluating: "正在检查",
	needs_input: "需要补充/确认",
	waiting_approval: "等待批准",
	revision_required: "需要修订",
	cancelled: "已取消",
	passed: "已通过",
	retryable_failed: "检查未通过",
} as const;

const stageLabelsEn: Record<keyof typeof stageLabels, string> = {
	pending: "Not started",
	running: "Generating",
	evaluating: "Checking",
	needs_input: "Input needed",
	waiting_approval: "Awaiting approval",
	revision_required: "Revision needed",
	cancelled: "Cancelled",
	passed: "Passed",
	retryable_failed: "Check failed",
};

function App() {
	const [language, setLanguage] = useState<Language>(() => localStorage.getItem("blackx-language") === "en" ? "en" : "zh");
	const [panelTab, setPanelTab] = useState<"requirement" | "models" | "files" | "knowledge" | "memory">("requirement");
	const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 760);
	const [reviewOpen, setReviewOpen] = useState(() => window.innerWidth >= 1180);
	const [tutorial, setTutorial] = useState<{ step: number; panelTab: typeof panelTab; sidebarOpen: boolean; reviewOpen: boolean }>();
	const tutorialButtonRef = useRef<HTMLButtonElement>(null);
	const [activity, setActivity] = useState<RuntimeActivity>();
	const [requirementActivity, setRequirementActivity] = useState<RuntimeActivity>();
	const [health, setHealth] = useState<RuntimeHealth>();
	const [search, setSearch] = useState("");
	const [renaming, setRenaming] = useState(false);
	const [taskName, setTaskName] = useState("");
	const [nameBusy, setNameBusy] = useState(false);
	const [conversations, setConversations] = useState<ConversationSummary[]>([]);
	const [active, setActive] = useState<ConversationView>();
	const activeIdRef = useRef<string | undefined>(undefined);
	const activeGeneration = useRef(0);
	const deletedIds = useRef(new Set<string>());
	const selectionVersion = useRef(0);
	const [pendingDelete, setPendingDelete] = useState<ConversationSummary>();
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string>();
	const activate = (conversation?: ConversationView) => {
		setRenaming(false);
		activeGeneration.current++;
		activeIdRef.current = conversation?.conversationId;
		setActive(conversation);
	};
	const updateActive = (conversation: ConversationView) => {
		if (activeIdRef.current === conversation.conversationId && !deletedIds.current.has(conversation.conversationId)) setActive(conversation);
	};
	const [planState, setPlanState] = useState<PlanWorkspace>();
	const [planBusy, setPlanBusy] = useState(false);
	const planRunning = !!planState && ["planning", "queued", "running"].includes(planState.versions.at(-1)?.status ?? "");
	const [draft, setDraft] = useState("");
	const [attachments, setAttachments] = useState<ConversationAttachment[]>([]);
	const [, setParsedSources] = useState<AssetInspectionRecord[]>([]);
	const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
	const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
	const [uploading, setUploading] = useState(false);
	const [loading, setLoading] = useState(true);
	const [sending, setSending] = useState(false);
	const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskView[]>([]);
	const [cronSchedules, setCronSchedules] = useState<CronScheduleView[]>([]);
	const [requirement, setRequirement] = useState<RequirementBriefWorkspaceView>();
	const [requirementMetrics, setRequirementMetrics] = useState<RequirementBriefMetricsSeriesView>();
	const [requirementBusy, setRequirementBusy] = useState(false);
	const [factKey, setFactKey] = useState("");
	const [factValue, setFactValue] = useState("");
	const [factUnit, setFactUnit] = useState("");
	const [error, setError] = useState<string>();
	const chatScrollRef = useRef<HTMLElement>(null);
	const followChatRef = useRef(true);
	const newConversationRef = useRef<HTMLButtonElement>(null);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const en = language === "en";
	const stageLabel = (status: keyof typeof stageLabels) => en ? stageLabelsEn[status] : stageLabels[status];
	const defaultConversationTitle = en ? "New packaging request" : "新的包装需求";
	const displayConversationTitle = (title: string) => title === "新会话" || title === "New conversation" ? defaultConversationTitle : title;
	const fieldLabel = (key: string) => labelFor(language, key, requirementFieldLabels[key] ?? (en ? "Other requirement" : "其他需求信息"));
	const factStatus = (status: string) => statusFor(language, status, factStatusLabels[status] ?? status);

	useEffect(() => {
		localStorage.setItem("blackx-language", language);
		document.documentElement.lang = language === "en" ? "en" : "zh-CN";
		document.title = language === "en" ? "Packx · Packaging Workspace" : "Packx · 包装需求工作区";
	}, [language]);

	useEffect(() => {
		let cancelled = false;
		void bootstrap(language)
			.then((result) => {
				if (cancelled) return;
				setHealth(result.health);
				setConversations(result.conversations);
				activate(result.active);
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		void client.listBackgroundTasks(active.conversationId)
			.then((tasks) => {
				if (cancelled) return;
				setBackgroundTasks((current) => [
					...current.filter((task) => task.conversationId !== active.conversationId),
					...tasks,
				]);
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [active?.conversationId, active?.revision]);

	useEffect(() => {
		setPlanState(undefined); setPlanBusy(false);
		if (!active) return;
		const id = active.conversationId;
		let cancelled = false;
		const refresh = async () => {
			try { const next = await client.getPlan(id); if (!cancelled) setPlanState((old) => old && old.revision > next.revision ? old : next); }
			catch (reason) { if (!cancelled) setError(errorMessage(reason)); }
		};
		void refresh();
		const timer = setInterval(() => { void refresh(); }, 1500);
		return () => { cancelled = true; clearInterval(timer); };
	}, [active?.conversationId]);

	const planCommand = async (command: Record<string, unknown>) => {
		if (!active || !planState || planBusy) return;
		const id = active.conversationId;
		setPlanBusy(true); setError(undefined);
		try {
			const next = await client.planCommand(id, { ...command, revision: planState.revision, requestId: crypto.randomUUID() });
			if (activeIdRef.current === id) setPlanState((old) => old && old.revision > next.revision ? old : next);
			const updated = await client.get(id, language); updateActive(updated); await refreshList(updated);
		} catch (reason) { if (activeIdRef.current === id) setError(errorMessage(reason)); }
		finally { if (activeIdRef.current === id) setPlanBusy(false); }
	};

	useEffect(() => {
		setAttachments([]);
		setUploading(false);
		setParsedSources([]);
		setSelectedAttachmentIds([]);
		if (!active) return;
		let cancelled = false;
		void client.listAttachments(active.conversationId)
			.then((items) => {
				if (!cancelled) setAttachments(items);
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [active?.conversationId]);

	useEffect(() => {
		setAttachmentPreviews({});
		if (!active) return;
		let cancelled = false;
		const objectUrls: string[] = [];
		void Promise.all(attachments
			.filter((attachment) => attachment.kind === "image")
			.map(async (attachment) => {
				const url = URL.createObjectURL(await client.readAttachment(
					active.conversationId,
					attachment.attachmentId,
				));
				objectUrls.push(url);
				return [attachment.attachmentId, url] as const;
			}))
			.then((entries) => {
				if (cancelled) {
					objectUrls.forEach((url) => URL.revokeObjectURL(url));
					return;
				}
				setAttachmentPreviews(Object.fromEntries(entries));
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
			objectUrls.forEach((url) => URL.revokeObjectURL(url));
		};
	}, [active?.conversationId, attachments]);

	useEffect(() => {
		setRequirement(undefined);
		setRequirementBusy(false);
		setFactKey(""); setFactValue(""); setFactUnit("");
	}, [active?.conversationId]);

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		void client.getRequirementBrief(active.conversationId)
			.then((next) => {
				if (!cancelled) {
					setRequirement((current) => current && next && current.runId === next.runId && current.state.aggregateVersion > next.state.aggregateVersion ? current : next ?? undefined);
				}
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
		};
		// Host reconciles sources on read; preserve edits while refreshing version and approval state.
	}, [active?.conversationId, active?.revision, attachments]);

	useEffect(() => {
		if (!active || !requirement || requirement.readOnlyReason) return;
		const waiting = requirement.state.stageStatus === "running" && requirement.job?.status !== "dead_letter" ||
			requirement.state.stageStatus === "evaluating" ||
			requirement.job?.status === "queued" ||
			requirement.job?.status === "leased" ||
			requirement.state.stageStatus === "waiting_approval" && requirement.state.approval?.status === "approved";
		if (!waiting) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void client.getRequirementBrief(active.conversationId)
				.then((next) => {
					if (cancelled) return;
					if (next) setRequirement(next);
					if (next?.job?.status === "dead_letter") {
						setError(errorMessage(next.job.lastFailure));
					}
				})
				.catch((reason) => { if (!cancelled) setError(errorMessage(reason)); });
		}, 750);
		return () => { cancelled = true; window.clearTimeout(timer); };
	}, [active?.conversationId, requirement]);

	useEffect(() => {
		let cancelled = false;
		void client.getRequirementBriefMetrics()
			.then((metrics) => {
				if (!cancelled) setRequirementMetrics(metrics);
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [conversations.length, requirement?.state.aggregateVersion]);

	useEffect(() => {
		setCronSchedules([]);
		if (!active) return;
		let cancelled = false;
		void client.listCronSchedules(active.conversationId)
			.then((schedules) => {
				if (!cancelled) setCronSchedules(schedules);
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [active?.conversationId, active?.revision]);

	useEffect(() => {
		const pending = backgroundTasks.filter((task) => task.status === "queued" || task.status === "leased");
		if (!pending.length) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void Promise.all(pending.map((task) => client.getBackgroundTask(task.taskId)))
				.then(async (updatedTasks) => {
					if (cancelled) return;
					setBackgroundTasks((current) => current.map((task) =>
						updatedTasks.find((updated) => updated.taskId === task.taskId) ?? task,
					));
					const completedActiveTask = updatedTasks.some((task) =>
						task.status === "completed" && task.conversationId === active?.conversationId,
					);
					if (completedActiveTask && active) {
						const updated = await client.get(active.conversationId);
						if (cancelled) return;
						updateActive(updated);
						await refreshList(updated);
					}
					const failed = updatedTasks.find((task) => task.status === "dead_letter");
					if (failed) setError(errorMessage(failed.lastFailure));
				})
				.catch((reason) => { if (!cancelled) setError(errorMessage(reason)); });
		}, 750);
		return () => { cancelled = true; window.clearTimeout(timer); };
	}, [backgroundTasks, active?.conversationId]);

	useEffect(() => {
		const view = chatScrollRef.current;
		if (!view || !followChatRef.current) return;
		view.scrollTo({ top: view.scrollHeight, behavior: activity?.partialText ? "auto" : "smooth" });
	}, [active?.conversationId, active?.messages.length, sending, activity?.partialText]);

	const refreshList = async (_current: ConversationView) => {
		const next = await client.list(language);
		setConversations(next.filter((item) => !deletedIds.current.has(item.conversationId)));
	};

	const createConversation = async () => {
		if (sending || deleting) return;
		const version = ++selectionVersion.current;
		setError(undefined);
		try {
			const created = await client.create(language);
			if (version !== selectionVersion.current) return;
			followChatRef.current = true;
			activate(created);
			setDraft("");
			if (window.innerWidth < 760) setSidebarOpen(false);
			setConversations((current) => [summary(created), ...current]);
		} catch (reason) {
			setError(errorMessage(reason));
		}
	};

	const selectConversation = async (conversationId: string) => {
		if (sending || deleting || deletedIds.current.has(conversationId)) return;
		if (window.innerWidth < 760) setSidebarOpen(false);
		if (active?.conversationId === conversationId) return;
		setError(undefined);
		const version = ++selectionVersion.current;
		try {
			followChatRef.current = true;
			const selected = await client.get(conversationId, language);
			if (version !== selectionVersion.current || deletedIds.current.has(conversationId)) return;
			activate(selected);
			setDraft("");
		} catch (reason) {
			setError(errorMessage(reason));
		}
	};

	const deleteConversation = async () => {
		if (!pendingDelete || deleting || uploading || requirementBusy) return;
		const conversationId = pendingDelete.conversationId;
		++selectionVersion.current;
		setDeleting(true);
		setDeleteError(undefined);
		try {
			let warning: string | undefined;
			try { await client.delete(conversationId); }
			catch (reason) {
				// Another tab may have deleted the same conversation already.
				if (!(reason instanceof ConversationClientError) || !["conversation_not_found", "conversation_cleanup_pending"].includes(reason.code)) throw reason;
				if (reason.code === "conversation_cleanup_pending") warning = reason.message;
			}
			setError(warning);
			deletedIds.current.add(conversationId);
			bootstrapPromise = undefined;
			const remaining = conversations.filter((item) => !deletedIds.current.has(item.conversationId));
			setConversations(remaining);
			setBackgroundTasks((current) => current.filter((task) => task.conversationId !== conversationId));
			if (activeIdRef.current === conversationId) {
				activate(undefined);
				setDraft(""); setSending(false); setRequirement(undefined);
				setActivity(undefined); setRequirementActivity(undefined);
				setAttachments([]); setUploading(false); setSelectedAttachmentIds([]); setParsedSources([]); setAttachmentPreviews({});
				setCronSchedules([]); setFactKey(""); setFactValue(""); setFactUnit("");
				const index = conversations.findIndex((item) => item.conversationId === conversationId);
				const next = remaining[Math.min(index, remaining.length - 1)];
				if (next) {
					try { activate(await client.get(next.conversationId)); }
					catch (reason) { setError(errorMessage(reason)); }
				}
			}
			setPendingDelete(undefined);
			requestAnimationFrame(() => newConversationRef.current?.focus());
		} catch (reason) { setDeleteError(errorMessage(reason)); }
		finally { setDeleting(false); }
	};

	const send = async (raw: string) => {
		const content = raw.trim();
		if (planState?.mode === "plan") {
			if (content && !planRunning && !planBusy && !planBudgetBlock(planState, true)) await planCommand({ action: "generate", objective: content });
			return;
		}
		if (planRunning) return;
		const selectedAttachments = attachments.filter((attachment) => selectedAttachmentIds.includes(attachment.attachmentId));
		if ((!content && selectedAttachments.length === 0) || !active || sending || hasActiveBackgroundTask || health?.adapter !== "blackx-agent") return;
		const messageId = `message-${crypto.randomUUID()}`;
		const optimistic: ConversationMessage = {
			messageId,
			role: "user",
			content,
			createdAt: new Date().toISOString(),
			attachments: selectedAttachments.map((attachment) => ({
				name: attachment.name,
				mediaType: attachment.mediaType,
				sourceRef: `attachment://${active.conversationId}/${attachment.attachmentId}`,
			})),
		};
		const conversationId = active.conversationId;
		setDraft("");
		setError(undefined);
		followChatRef.current = true;
		setSending(true);
		setActive((current) => current && current.conversationId === conversationId
			? { ...current, messages: [...current.messages, optimistic], preview: content }
			: current);
		try {
			const updated = await client.send(conversationId, {
				messageId,
				content,
				attachmentIds: selectedAttachments.map((attachment) => attachment.attachmentId),
			});
			if (activeIdRef.current !== conversationId || deletedIds.current.has(conversationId)) return;
			updateActive(updated);
			setSelectedAttachmentIds([]);
			await refreshList(updated);
		} catch (reason) {
			if (activeIdRef.current === conversationId && !deletedIds.current.has(conversationId)) setError(errorMessage(reason));
		} finally {
			if (activeIdRef.current === conversationId) setSending(false);
		}
	};

	const startRequirement = async (planVersion?: number) => {
		if (!active || requirementBusy || sending || !realProvider) return;
		const conversationId = active.conversationId, generation = activeGeneration.current;
		const isCurrent = () => activeIdRef.current === conversationId && activeGeneration.current === generation;
		setRequirementBusy(true);
		setError(undefined);
		try {
			const next = await client.startRequirementBrief(
				conversationId,
				`requirement-${crypto.randomUUID()}`,
				planVersion ?? (requirement?.state.facts.plan_source ? Number(/:version:(\d+)$/.exec(requirement.state.facts.plan_source.sourceRef)?.[1]) : undefined),
			);
			if (!isCurrent()) return;
			setRequirement(next);
			setPanelTab("requirement");
			setReviewOpen(true);
		} catch (reason) {
			if (isCurrent()) setError(errorMessage(reason));
		} finally {
			if (isCurrent()) setRequirementBusy(false);
		}
	};

	const uploadAttachments = async (event: ChangeEvent<HTMLInputElement>) => {
		const input = event.currentTarget;
		const files = [...(input.files ?? [])];
		if (!active || files.length === 0 || uploading) return;
		const conversationId = active.conversationId, generation = activeGeneration.current;
		const isCurrent = () => activeIdRef.current === conversationId && activeGeneration.current === generation;
		setUploading(true);
		setError(undefined);
		try {
			const uploaded: ConversationAttachment[] = [];
			for (const file of files) {
				uploaded.push(await client.uploadAttachment(
					active.conversationId,
					`upload-${crypto.randomUUID()}`,
					file,
				));
			}
			const remaining = await client.listAttachments(conversationId);
			if (!isCurrent()) return;
			setAttachments(remaining);
			setSelectedAttachmentIds((current) => [...new Set([
				...current,
				...uploaded.map((attachment) => attachment.attachmentId),
			])]);
		} catch (reason) {
			if (isCurrent()) setError(errorMessage(reason));
		} finally {
			input.value = "";
			if (isCurrent()) setUploading(false);
		}
	};

	const withdrawAttachment = async (attachment: ConversationAttachment) => {
		if (!active || uploading) return;
		const conversationId = active.conversationId, generation = activeGeneration.current;
		const isCurrent = () => activeIdRef.current === conversationId && activeGeneration.current === generation;
		const reason = window.prompt(en ? `Withdraw ${attachment.name}? Its content will remain in history, but dependent fields and deliveries must be reviewed. Enter a reason:` : `撤回 ${attachment.name} 后，依赖它的字段和交付物需要重新核对，历史内容保留。请填写撤回原因：`);
		if (!reason?.trim()) return;
		setUploading(true); setError(undefined);
		try {
			const remaining = await client.withdrawAttachment(conversationId, attachment, `withdraw-${crypto.randomUUID()}`, reason.trim());
			if (!isCurrent()) return;
			setAttachments(remaining);
			setSelectedAttachmentIds((current) => current.filter((id) => id !== attachment.attachmentId));
		} catch (cause) { if (isCurrent()) setError(errorMessage(cause)); }
		finally { if (isCurrent()) setUploading(false); }
	};

	const downloadAttachment = async (attachment: ConversationAttachment) => {
		if (!active) return;
		try {
			const url = URL.createObjectURL(await client.readAttachment(
				active.conversationId,
				attachment.attachmentId,
			));
			const link = document.createElement("a");
			link.href = url;
			link.download = attachment.name;
			link.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 0);
		} catch (reason) {
			setError(errorMessage(reason));
		}
	};

	const useAttachment = (attachment: ConversationAttachment) => {
		setSelectedAttachmentIds((current) => current.includes(attachment.attachmentId)
			? current.filter((attachmentId) => attachmentId !== attachment.attachmentId)
			: [...current, attachment.attachmentId].slice(-8));
	};

	const resolveRequirementApproval = async (decision: "approved" | "rejected") => {
		if (!active || requirementBusy || requirement?.state.approval?.status !== "requested") return;
		const conversationId = active.conversationId, generation = activeGeneration.current;
		const isCurrent = () => activeIdRef.current === conversationId && activeGeneration.current === generation;
		setRequirementBusy(true);
		setError(undefined);
		try {
			const next = await client.resolveRequirementApproval(
				active.conversationId,
				`approval-${crypto.randomUUID()}`,
				decision,
				{ approvalId: requirement.state.approval.approvalId, artifactVersion: requirement.state.approval.artifactVersion, expectedAggregateVersion: requirement.state.aggregateVersion },
			);
			if (!isCurrent()) return;
			setRequirement(next);
		} catch (reason) {
			if (!isCurrent()) return;
			setError(errorMessage(reason));
			if (reason instanceof ConversationClientError && ["approval_review_stale", "approval_review_version_required", "concurrency_conflict"].includes(reason.code)) {
				try { const latest = await client.getRequirementBrief(conversationId); if (isCurrent()) setRequirement(latest ?? undefined); }
				catch { /* Keep the stale-review error until a successful refresh. */ }
			}
		} finally {
			if (isCurrent()) setRequirementBusy(false);
		}
	};

	const cancelRequirement = async () => {
		if (!active || !requirement || requirementBusy || requirement.state.stageStatus === "passed") return;
		const conversationId = active.conversationId, generation = activeGeneration.current;
		const isCurrent = () => activeIdRef.current === conversationId && activeGeneration.current === generation;
		setRequirementBusy(true);
		setError(undefined);
		try {
			const next = await client.cancelRequirementBrief(
				active.conversationId,
				`cancel-${crypto.randomUUID()}`,
			);
			if (!isCurrent()) return;
			setRequirement(next);
		} catch (reason) {
			if (!isCurrent()) return;
			setError(errorMessage(reason));
		} finally {
			if (isCurrent()) setRequirementBusy(false);
		}
	};

	const recordFact = async (event: FormEvent) => {
		event.preventDefault();
		if (!active || !requirement || requirementBusy || !factKey.trim() || !factValue.trim()) return;
		const conversationId = active.conversationId, generation = activeGeneration.current;
		const isCurrent = () => activeIdRef.current === conversationId && activeGeneration.current === generation;
		setRequirementBusy(true);
		setError(undefined);
		try {
			const next = await client.recordRequirementFact(
				active.conversationId,
				`fact-${crypto.randomUUID()}`,
				{
					key: factKey.trim(),
					value: factKey === "quantity" ? Number(factValue) : factValue.trim(),
					unit: factUnit.trim() || undefined,
				},
			);
			if (!isCurrent()) return;
			setRequirement(next);
			setFactKey("");
			setFactValue("");
			setFactUnit("");
		} catch (reason) {
			if (!isCurrent()) return;
			setError(errorMessage(reason));
		} finally {
			if (isCurrent()) setRequirementBusy(false);
		}
	};

	const resolveFact = async (key: string, decision: "verified" | "rejected") => {
		if (!active || !requirement || !requirement.state.facts[key] || requirementBusy) return;
		const conversationId = active.conversationId, generation = activeGeneration.current;
		const isCurrent = () => activeIdRef.current === conversationId && activeGeneration.current === generation;
		setRequirementBusy(true);
		setError(undefined);
		try {
			const next = await client.resolveRequirementFact(
				active.conversationId,
				key,
				`fact-decision-${crypto.randomUUID()}`,
				decision,
				requirement.state.facts[key].version,
				requirement.state.aggregateVersion,
				requirement.candidateConflicts?.some(c => c.key === key) ? requirement.state.currentProposal?.version : undefined,
			);
			if (!isCurrent()) return;
			setRequirement(next);
		} catch (reason) {
			if (!isCurrent()) return;
			setError(errorMessage(reason));
			if (reason instanceof ConversationClientError && ["fact_review_stale", "candidate_review_stale", "concurrency_conflict"].includes(reason.code)) {
				try { const latest = await client.getRequirementBrief(conversationId); if (isCurrent()) setRequirement(latest ?? undefined); }
				catch { /* Preserve the conflict message and require a manual refresh. */ }
			}
		} finally {
			if (isCurrent()) setRequirementBusy(false);
		}
	};

	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		void send(draft);
	};

	const realProvider = health?.adapter === "blackx-agent";
	const activeBackgroundTasks = backgroundTasks.filter((task) =>
		task.conversationId === active?.conversationId && (task.status === "queued" || task.status === "leased"),
	);
	const hasActiveBackgroundTask = activeBackgroundTasks.length > 0;
	const activeCronSchedules = cronSchedules.filter((schedule) => schedule.status === "active");
	const hasUserMessage = Boolean(active?.messages.some((message) => message.role === "user"));
	const content = requirementContent(requirement?.artifact?.content);
	const evaluation = evaluationReport(requirement?.evaluation?.report);
	const reviewRecovery = evaluation?.decision === "recover_review";
	const facts = Object.values(requirement?.state.facts ?? {})
		.filter((fact) => packagingFactKeys.includes(fact.key))
		.sort((left, right) => packagingFactKeys.indexOf(left.key) - packagingFactKeys.indexOf(right.key));
	const tutorialSourceKey = (facts.find((fact) => fact.key === "quantity") ?? facts[0])?.key;
	const unconfirmedFacts = facts.filter((fact) => ["suggested", "unverified"].includes(fact.status));
	const tutorialConfirmKey = (unconfirmedFacts.find((fact) => fact.key === tutorialSourceKey) ?? unconfirmedFacts[0])?.key;
	const requirementRunning = !requirement?.readOnlyReason && (requirement?.state.stageStatus === "running" && requirement.job?.status !== "dead_letter" ||
		requirement?.state.stageStatus === "evaluating" ||
		requirement?.job?.status === "queued" ||
		requirement?.job?.status === "leased");
	const requirementLeaseExpired = requirement?.job?.status === "leased" && Boolean(requirement.job.leaseExpiresAt && Date.parse(requirement.job.leaseExpiresAt) <= Date.now());
	const requirementTerminal = requirement?.state.stageStatus === "passed" || requirement?.state.stageStatus === "cancelled";

	useEffect(() => {
		if (!active) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		const connect = async () => {
			try { await client.watchActivity(active.conversationId, (next) => { if (!controller.signal.aborted) setActivity((current) => current && next && current.updatedAt > next.updatedAt ? current : next); }, controller.signal); }
			catch { /* Reconnect below; periodic status remains a fallback. */ }
			if (!controller.signal.aborted) timer = setTimeout(() => void connect(), 1500);
		};
		void connect();
		return () => { controller.abort(); clearTimeout(timer); };
	}, [active?.conversationId]);

	useEffect(() => {
		setActivity(undefined); setRequirementActivity(undefined);
		if (!active) return;
		let cancelled = false;
		const update = async () => {
			try {
				const [chat, task, freshHealth] = await Promise.all([client.activity(active.conversationId), requirementRunning ? client.activity(active.conversationId, true) : undefined, client.health()]);
				if (!cancelled) { setActivity((current) => current && chat && current.updatedAt > chat.updatedAt ? current : chat); setRequirementActivity(task); setHealth(freshHealth); }
				if (!sending && chat && ["completed", "failed", "paused"].includes(chat.phase)) {
					const restored = await client.get(active.conversationId);
					if (!cancelled) setActive((current) => current?.conversationId === restored.conversationId && current.revision < restored.revision ? restored : current);
				}
			} catch { /* The next interaction reports connection errors; stale progress is cleared. */
				if (!cancelled) { setActivity(undefined); setRequirementActivity(undefined); }
			}
		};
		void update();
		const timer = window.setInterval(() => void update(), 1000);
		return () => { cancelled = true; window.clearInterval(timer); };
	}, [active?.conversationId, sending, requirementRunning]);

	useEffect(() => {
		if (tutorial) return;
		const resize = () => { if (window.innerWidth < 1180) setReviewOpen(false); if (window.innerWidth < 760) setSidebarOpen(false); };
		const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setReviewOpen(false); if (window.innerWidth < 760) setSidebarOpen(false); } };
		window.addEventListener("resize", resize); window.addEventListener("keydown", escape);
		return () => { window.removeEventListener("resize", resize); window.removeEventListener("keydown", escape); };
	}, [!!tutorial]);

	useLayoutEffect(() => {
		if (!tutorial) return;
		const navigate = () => {
			setSidebarOpen(window.innerWidth >= 760 && tutorial.sidebarOpen);
			setReviewOpen(tutorialSteps[tutorial.step].panel === "requirement");
			if (tutorialSteps[tutorial.step].panel === "requirement") setPanelTab("requirement");
		};
		navigate(); window.addEventListener("resize", navigate);
		return () => window.removeEventListener("resize", navigate);
	}, [tutorial?.step]);

	const closeTutorial = () => {
		if (!tutorial) return;
		setPanelTab(tutorial.panelTab);
		setSidebarOpen(tutorial.sidebarOpen && window.innerWidth >= 760);
		setReviewOpen(tutorial.reviewOpen);
		setTutorial(undefined);
		requestAnimationFrame(() => {
			const entry = tutorial.reviewOpen && window.innerWidth < 1180 ? document.querySelector<HTMLButtonElement>(".tutorial-panel-trigger") : tutorialButtonRef.current;
			entry?.focus({ preventScroll: true });
		});
	};

	const retryReply = async () => {
		if (!active || sending) return;
		setSending(true); setError(undefined);
		try { const updated = await client.retry(active.conversationId); updateActive(updated); await refreshList(updated); }
		catch (reason) { if (activeIdRef.current === active.conversationId && !deletedIds.current.has(active.conversationId)) setError(errorMessage(reason)); }
		finally { if (activeIdRef.current === active.conversationId) setSending(false); }
	};
	const stopReply = async () => {
		if (!active) return;
		try { await client.stop(active.conversationId); }
		catch (reason) { setError(errorMessage(reason)); }
	};
	const progressLabel = (value?: RuntimeActivity) => value?.phase === "tool"
		? value.tool === "asset_metadata_inspect" || value.tool === "document_read" ? en ? "Reading files…" : "正在读取资料…" : en ? "Processing…" : "正在处理…"
		: value?.phase === "model" ? en ? "Preparing a reply…" : "正在整理回复…" : en ? "Preparing…" : "正在准备…";
	const replyRunning = sending || (planState?.mode !== "plan" && !planRunning && Boolean(activity && ["starting", "model", "tool"].includes(activity.phase)));
	const fieldOptions = packagingFactKeys;

	return (
		<div className={`app-shell ${sidebarOpen ? "sidebar-open" : ""} ${reviewOpen ? "review-open" : ""}`}>
			<button className="drawer-backdrop" aria-label={en ? "Close sidebar" : "关闭侧栏"} onClick={() => { setReviewOpen(false); if (window.innerWidth < 760) setSidebarOpen(false); }} />
			<aside className="sidebar">
				<div className="brand-lockup">
					<span className="brand-mark" aria-hidden="true">Px</span>
					<div>
						<strong>Packx</strong>
						<span>{en ? "Packaging workspace" : "包装需求工作台"}</span>
					</div>
				</div>

				<button ref={newConversationRef} className="new-task" onClick={() => void createConversation()} disabled={sending || deleting || loading}>
					<span aria-hidden="true">＋</span> {en ? "New request" : "新建需求"}
				</button>

				<div className="history-label">{en ? "Recent requests" : "最近的需求"}</div>
				<input className="task-search" type="search" aria-label={en ? "Search tasks" : "搜索任务"} placeholder={en ? "Search requests…" : "搜索需求与计划…"} value={search} onChange={(e) => setSearch(e.target.value)} />
					{search && !conversations.some((c) => `${c.title} ${c.preview} ${c.searchText ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && <p role="status">{en ? "No matching tasks" : "没有匹配的任务"}</p>}
				<nav className="conversation-list" aria-label={en ? "Conversation history" : "会话历史"}>
					{!loading && conversations.length === 0 && <p className="history-empty">{en ? "No requests yet" : "暂无需求"}</p>}
					{conversations.filter((c) => `${c.title} ${c.preview} ${c.searchText ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map((conversation) => (
						<div className="conversation-item" key={conversation.conversationId}>
						<button
							className={active?.conversationId === conversation.conversationId ? "active" : ""}
							onClick={() => void selectConversation(conversation.conversationId)}
							disabled={sending || deleting}
						>
							<strong>{displayConversationTitle(conversation.title)}</strong>
							<small>{displayTime(conversation.updatedAt, language)} · {conversation.messageCount} {en ? "messages" : "条"}</small>
						</button>
						<button className="delete-conversation" aria-label={`${en ? "Delete conversation" : "删除会话"}：${displayConversationTitle(conversation.title)}`} title={en ? "Delete conversation" : "删除会话"}
							disabled={deleting || uploading || requirementBusy}
							onClick={() => { setDeleteError(undefined); setPendingDelete(conversation); }}>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
						</button>
						</div>
					))}
				</nav>

				<div className="sidebar-footer">
					<button className="secondary-action" onClick={() => { setPanelTab("models"); setReviewOpen(true); }}>{en ? "Model settings" : "模型设置"}<span aria-hidden="true">↗</span></button>
					<div className="runtime-light">
						<i className={realProvider ? "online" : "offline"} />
						{!realProvider ? en ? "Model not configured" : "模型尚未配置" : health?.providerStatus === "last_request_succeeded" ? en ? "Last request completed" : "最近处理成功" : health?.providerStatus === "last_request_failed" ? en ? "Last request failed" : "最近处理未完成" : en ? "Model configured · pending verification" : "模型已配置 · 待验证"}
					</div>
					<label className="language-selector">{en ? "Language" : "语言"}<select value={language} onChange={(event) => setLanguage(event.target.value as Language)} aria-label={en ? "Language" : "语言"}>{Object.entries(languageNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
					<p className="document-capability" role="status">{documentCapabilityText(health?.documents, en)}</p>
					<details className="permission-summary"><summary>{en ? "File access & permissions" : "文件访问与权限"}</summary><p>{en ? "Packx can read local files within its allowed scope. Before creating, changing or deleting a file, it shows the path and content for your approval and keeps a backup. Files are read on this device; extracted information still needs your confirmation." : "Packx 可在授权范围内读取本机文件。新建、修改或删除前，会展示路径与内容，经你单次批准后执行并保留备份。附件在本机读取，提取的信息仍需你确认。"}</p></details>
				</div>
			</aside>

			<main className="conversation">
				<header className="topbar">
					<button className="panel-toggle" aria-label={en ? "Toggle conversation sidebar" : "切换会话侧栏"} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></svg></button>
					<div>
						<span className="eyebrow">PACKX WORKSPACE</span>
						<div className="task-heading"><h1 title={active ? displayConversationTitle(active.title) : undefined}>{active ? displayConversationTitle(active.title) : (en ? "Packaging workspace" : "包装需求工作台")}</h1>
							{active && !renaming && <button className="rename-task" aria-label={en ? "Rename task" : "重命名任务"} title={en ? "Rename task" : "重命名任务"} onClick={() => { setTaskName(active.title); setRenaming(true); }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" /></svg></button>}
						</div>
						{active && (renaming ? <form className="task-name-form" onSubmit={(e) => {
							e.preventDefault(); const id = active.conversationId; setNameBusy(true);
							void client.rename(id, taskName, active.nameRevision ?? 0, language).then(async (next) => { updateActive(next); if (activeIdRef.current === id) setRenaming(false); await refreshList(next); }).catch((reason) => setError(reason instanceof ConversationClientError && reason.code === "task_name_conflict" ? en ? "Task name changed in another window. Reload before renaming." : "任务名称已在其他窗口更改，请刷新后重命名。" : errorMessage(reason))).finally(() => setNameBusy(false));
						}}><input aria-label={en ? "Task name" : "任务名称"} autoFocus required maxLength={100} value={taskName} onChange={(e) => setTaskName(e.target.value)} /><button disabled={nameBusy || !taskName.trim()}>{en ? "Save name" : "保存名称"}</button><button type="button" disabled={nameBusy} onClick={() => setRenaming(false)}>{en ? "Cancel" : "取消"}</button></form> : null)}
					</div>
					<button ref={tutorialButtonRef} type="button" className="panel-toggle tutorial-trigger" onClick={() => setTutorial({ step: 0, panelTab, sidebarOpen, reviewOpen })}>{en ? "Usage tutorial" : "使用教程"}</button>
					<button className="panel-toggle review-toggle" aria-expanded={reviewOpen} onClick={() => setReviewOpen(!reviewOpen)}><span className="workspace-toggle-label">{en ? "Workspace" : "工作区"} · </span>{{ requirement: en ? "Requirements" : "需求单", models: en ? "Models" : "模型", knowledge: en ? "Evidence" : "证据", memory: en ? "Memory" : "记忆", files: en ? "Files" : "文件" }[panelTab]}</button>
				</header>

				<section
					ref={chatScrollRef}
					className="chat-scroll"
					aria-live="polite"
					onScroll={(event) => {
						const view = event.currentTarget;
						followChatRef.current = view.scrollHeight - view.scrollTop - view.clientHeight < 80;
					}}
				>
					{loading ? (
						<div className="empty-state"><p>{en ? "Loading your workspace…" : "正在加载你的工作台…"}</p></div>
					) : active && (active.messages.length || active.historyStatus === "legacy_partial") ? (
						<div className="message-list">
							{active.historyStatus === "legacy_partial" && <p role="status">{en ? "Some history from this older task may be missing. All remaining original messages are shown." : "此旧任务可能缺少部分历史记录；这里只展示仍保存的原始消息。"}</p>}
							{active.messages.map((message) => (
								<article key={message.messageId} className={`message ${message.role}`}>
									<div className="avatar">{message.role === "assistant" ? "Px" : en ? "You" : "你"}</div>
									<div className="message-content">
										<div className="message-meta">
											<strong>{message.role === "assistant" ? "Packx" : en ? "You" : "你"}</strong>
											<time>{displayTime(message.createdAt, language)}</time>
										</div>
										<Markdown text={message.content} language={language} />
										{message.attachments?.length ? (
											<div className="message-attachments">
												{message.attachments.map((attachment) => {
													const attachmentId = attachmentIdFromSourceRef(attachment.sourceRef);
													const preview = attachmentId ? attachmentPreviews[attachmentId] : undefined;
													return <span key={attachment.sourceRef}>
														{preview && <img src={preview} alt="" />}
														{attachment.name}
													</span>;
												})}
											</div>
										) : null}
									</div>
								</article>
							))}
							{(replyRunning || hasActiveBackgroundTask) && (
								<article className="message assistant thinking">
									<div className="avatar">Px</div>
									<div>
										<span>{hasActiveBackgroundTask ? en ? "Working in the background…" : "正在后台处理…" : progressLabel(activity)}</span>
										{activity?.partialText && !hasActiveBackgroundTask ? <Markdown text={activity.partialText} language={language} /> : <div className="thinking-dots"><i /><i /><i /></div>}
									</div>
								</article>
							)}
						</div>
					) : planState?.versions.length ? null : (
						<div className="empty-state welcome-state">
							<span className="empty-mark" aria-hidden="true">Px</span>
							<h2>{en ? "Start a packaging request" : "开始整理包装需求"}</h2>
							<p>{en ? "Describe your request or add files to create a draft." : "描述需求或添加资料，生成待确认的需求单。"}</p>
							{!active ? <button data-tour="start-request" className="primary-action welcome-action" onClick={() => void createConversation()} disabled={deleting}>{en ? "Start your first request" : "开始整理需求"}<span aria-hidden="true">→</span></button> : <>
								<div className="prompt-grid" aria-label={en ? "Example requests" : "需求示例"}>
									<button onClick={() => { setDraft(en ? "I need a 500 g coffee bean packaging bag. Please help me identify the information that needs confirmation first." : "我想做一款500克咖啡豆包装袋，请先帮我梳理需要确认的信息。"); composerRef.current?.focus(); }}><span className="prompt-title">{en ? "Coffee bean pouch" : "咖啡豆包装袋"}<span aria-hidden="true">↗</span></span></button>
									<button onClick={() => { setDraft(en ? "I need custom folding cartons for skincare products. Please help me confirm the carton type, dimensions, quantity, and delivery details." : "我想定制一批护肤品包装纸盒，请先帮我梳理盒型、尺寸、数量和交付信息。"); composerRef.current?.focus(); }}><span className="prompt-title">{en ? "Skincare carton" : "护肤品包装纸盒"}<span aria-hidden="true">↗</span></span></button>
								</div>
							</>}
						</div>
					)}
					{active && <PlanPanel part="details" state={planState} language={language} busy={planBusy || sending || hasActiveBackgroundTask || requirementBusy || requirementRunning} onCommand={(c) => { void planCommand(c); }} onCreateBrief={!requirement?.readOnlyReason ? (version) => { void startRequirement(version); } : undefined} />}
				</section>

				<div className="composer-wrap">
					{active && <ConversationFiles key={active.conversationId} conversationId={active.conversationId} language={language} />}
					{!realProvider && !loading && (
						<div className="provider-warning">{en ? "Connect a model in settings to get started." : "请先在模型设置中完成连接。"}</div>
					)}
					{error && <div className="error-banner" role="alert">{errorText(error, language)}<button aria-label={en ? "Dismiss error" : "关闭错误提示"} onClick={() => setError(undefined)}>×</button></div>}
					{planState?.mode !== "plan" && !planRunning && !replyRunning && !hasActiveBackgroundTask && active?.messages.at(-1)?.role === "user" && <button className="retry-action" disabled={!realProvider} onClick={() => void retryReply()}>{en ? "Continue the unfinished reply" : "继续上次未完成的回复"}</button>}
					{activeCronSchedules.length > 0 && (
						<div className="cron-banner" role="status">
							{en ? "Scheduled tasks: " : "定时任务："}{activeCronSchedules.length} {en ? "· next run " : "个 · 下次运行 "}{displayTime(activeCronSchedules[0].nextRunAt, language)}
						</div>
					)}
					{attachments.length > 0 && (
						<details className="composer-attachments" open={selectedAttachmentIds.length > 0 || uploading}><summary>{en ? "Files" : "资料"} · {attachments.length}{selectedAttachmentIds.length > 0 && ` · ${en ? "Selected" : "已选"} ${selectedAttachmentIds.length}`}</summary>
						<div className="attachment-list" aria-label={en ? "Conversation attachments" : "会话附件"}>
							{attachments.map((attachment) => (
								<div className="attachment-item" key={attachment.attachmentId}><button
									type="button"
									className={selectedAttachmentIds.includes(attachment.attachmentId) ? "selected" : ""}
									onClick={() => useAttachment(attachment)}
									title={`${attachment.name} · ${(attachment.size / 1024).toFixed(1)} KB`}
								>
									{attachmentPreviews[attachment.attachmentId]
										? <img src={attachmentPreviews[attachment.attachmentId]} alt="" />
										: <span>{attachment.kind === "text" ? "TXT" : "FILE"}</span>}
									<strong>{attachment.name}</strong>
									<small>{selectedAttachmentIds.includes(attachment.attachmentId) ? en ? "Attached" : "已选中" : en ? "Add to message" : "附到消息"}</small>
								</button><button className="attachment-download" onClick={() => void downloadAttachment(attachment)} aria-label={`${en ? "Download" : "下载"} ${attachment.name}`}>{en ? "Download" : "下载"}</button><button disabled={uploading || sending || requirementBusy || hasActiveBackgroundTask} onClick={() => void withdrawAttachment(attachment)} aria-label={`${en ? "Withdraw" : "撤回"} ${attachment.name}`}>{en ? "Withdraw" : "撤回"}</button>{active && <DocumentImportPreview key={`${active.conversationId}:${attachment.attachmentId}`} conversationId={active.conversationId} attachmentId={attachment.attachmentId} language={language} />}</div>
							))}
						</div></details>
					)}
					{active && <PlanPanel part="controls" state={planState} language={language} busy={planBusy || sending || hasActiveBackgroundTask} onCommand={(c) => { void planCommand(c); }} />}
					<form data-tour="intake" className="composer" onSubmit={onSubmit}>
						<textarea
							ref={composerRef}
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
									event.preventDefault();
									void send(draft);
								}
							}}
							rows={2}
							placeholder={hasActiveBackgroundTask
								? en ? "You can send again after the background task completes" : "当前会话的后台任务完成后可继续发送"
								: realProvider ? en ? "Describe the packaging request, or add your customer’s source material…" : "描述包装需求，或添加客户资料…" : en ? "Set up a model connection to get started" : "在模型设置中完成连接，即可开始"}
							disabled={!active || !realProvider || replyRunning || hasActiveBackgroundTask || planBusy || planRunning}
							aria-label={en ? "Conversation input" : "对话输入"}
						/>
						<div className="composer-tools">
							<label className={uploading ? "attachment-upload disabled" : "attachment-upload"}>
								<input
									type="file"
									multiple
									accept={health?.documents?.scope === "windows-utf8" ? ".txt,.md,.csv,.json" : "image/*,.pdf,.docx,.xlsx,.txt,.md,.csv,.json"}
									onChange={(event) => void uploadAttachments(event)}
									disabled={!active || uploading}
								/>
								{uploading ? en ? "Uploading…" : "上传中…" : en ? "＋ Add files" : "＋ 添加资料"}
							</label>
							<span>{en ? "Enter to send · Shift + Enter for a new line" : "Enter 发送 · Shift + Enter 换行"}</span>
							{replyRunning && <button type="button" className="stop-button" onClick={() => void stopReply()}>{en ? "Stop" : "停止"}</button>}
							<button
								type="submit"
								className="send-button"
								aria-label={planState?.mode === "plan" ? en ? "Generate plan" : "生成计划" : en ? "Send message" : "发送消息"}
								disabled={(!draft.trim() && selectedAttachmentIds.length === 0) || !realProvider || sending || hasActiveBackgroundTask || planBusy || planRunning || (planState?.mode === "plan" && (!draft.trim() || !!planBudgetBlock(planState, true)))}
							>
								↑
							</button>
						</div>
					</form>
					<small className="disclaimer">{en ? "Review AI-extracted information before confirming." : "AI 提取的信息，请核对后确认。"}</small>
				</div>
			</main>

			<aside className="proposal-panel" aria-label={en ? "Workspace" : "多功能工作区"}>
				<header className="proposal-header">
					<button className="panel-toggle" aria-label={en ? "Close workspace" : "关闭工作区"} onClick={() => setReviewOpen(false)}>×</button>
					<div>
						<span className="eyebrow">WORKSPACE</span>
						<h2>{{ requirement: en ? "Requirement brief" : "需求单", models: en ? "Model connection" : "模型连接", knowledge: en ? "Reference sources" : "资料与证据", memory: en ? "Personal memory" : "个人记忆", files: en ? "Local files" : "本机文件" }[panelTab]}</h2>
					</div>
					<button type="button" className="panel-toggle tutorial-trigger tutorial-panel-trigger" onClick={() => setTutorial({ step: 0, panelTab, sidebarOpen, reviewOpen })}>{en ? "Usage tutorial" : "使用教程"}</button>
					{panelTab === "requirement" && requirement && (
						<span className={`proposal-status ${requirement.state.stageStatus}`}>
							{reviewRecovery && requirement.state.stageStatus === "needs_input" ? (en ? "Review needs recovery" : "复核待恢复") : stageLabel(requirement.state.stageStatus)}
						</span>
					)}
				</header>

				<div className="workspace-tabs" role="tablist" aria-label={en ? "Workspace tools" : "工作区功能"}>
					{(["requirement", "knowledge", "memory", "models", "files"] as const).map((tab, index, tabs) => <button key={tab} role="tab" data-tour={tab === "requirement" ? "brief-tab" : undefined} id={`tab-${tab}`} aria-controls={`panel-${tab}`} aria-selected={panelTab === tab} tabIndex={panelTab === tab ? 0 : -1} onClick={() => setPanelTab(tab)} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length; setPanelTab(tabs[next]); (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next])?.focus(); } }}>{ { requirement: en ? "Brief" : "需求单", models: en ? "Models" : "模型", knowledge: en ? "Evidence" : "证据", memory: en ? "Memory" : "记忆", files: en ? "Files" : "文件" }[tab]}</button>)}
				</div>
				<div className="proposal-body" role="tabpanel" id="panel-requirement" aria-labelledby="tab-requirement" hidden={panelTab !== "requirement"}>
					{requirementMetrics && requirementMetrics.totals.runs > 0 && (
						<details className="proposal-section diagnostics"><summary>{en ? "Task overview" : "任务统计"}</summary>
							<div className="section-title"><strong>{en ? "Requirements overview" : "需求处理概况"}</strong><code>{requirementMetrics.totals.runs} {en ? "tasks" : "次任务"}</code></div>
							<dl className="run-metadata">
								<div><dt>{en ? "Tasks completed" : "任务完成比例"}</dt><dd>{requirementMetrics.rates.workflowCompletion === null ? "—" : `${Math.round(requirementMetrics.rates.workflowCompletion * 100)}%`}</dd></div>
								<div><dt>{en ? "Briefs approved" : "需求单通过比例"}</dt><dd>{requirementMetrics.rates.stagePass === null ? "—" : `${Math.round(requirementMetrics.rates.stagePass * 100)}%`}</dd></div>
								<div><dt>{en ? "Checks passed" : "检查通过比例"}</dt><dd>{requirementMetrics.rates.evaluationPass === null ? "—" : `${Math.round(requirementMetrics.rates.evaluationPass * 100)}%`}</dd></div>
								<div><dt>{en ? "Waiting for action" : "等待处理"}</dt><dd>{requirementMetrics.totals.needsInput}</dd></div>
								<div><dt>{en ? "Average information confirmed" : "平均信息确认比例"}</dt><dd>{requirementMetrics.averages.confirmationRate === null ? "—" : `${Math.round(requirementMetrics.averages.confirmationRate * 100)}%`}</dd></div>
								<div><dt>{en ? "Confirmed unchanged" : "原样确认比例"}</dt><dd>{requirementMetrics.averages.confirmedCandidateAccuracy === null ? "—" : `${Math.round(requirementMetrics.averages.confirmedCandidateAccuracy * 100)}%`}</dd></div>
								<div><dt>{en ? "Reference presence" : "引用填写率"}</dt><dd>{requirementMetrics.averages.sourceCoverageRate === null ? "—" : `${Math.round(requirementMetrics.averages.sourceCoverageRate * 100)}%`}</dd></div>
								<div><dt>{en ? "Brief versions / follow-up questions" : "需求单版本 / 待核对问题"}</dt><dd>{requirementMetrics.totals.artifactVersions} / {requirementMetrics.totals.clarificationQuestions}</dd></div>
								<div><dt>{en ? "Tasks recovered / failed" : "任务恢复 / 失败比例"}</dt><dd>{requirementMetrics.queue.recoveryRate === null ? "—" : `${Math.round(requirementMetrics.queue.recoveryRate * 100)}%`} / {requirementMetrics.queue.failureRate === null ? "—" : `${Math.round(requirementMetrics.queue.failureRate * 100)}%`}</dd></div>
								<div><dt>{en ? "Processing errors" : "处理出错比例"}</dt><dd>{requirementMetrics.runtime.toolFailureRate === null ? "—" : `${Math.round(requirementMetrics.runtime.toolFailureRate * 100)}%`}</dd></div>
								<div><dt>{en ? "Average processing time" : "平均处理耗时"}</dt><dd>{requirementMetrics.averages.runtimeLatencyMs === null ? "—" : `${Math.round(requirementMetrics.averages.runtimeLatencyMs)} ms`}</dd></div>
							</dl>
							<div className="verification-list">
								<strong>{en ? "Recent tasks" : "最近处理记录"}</strong>
								{requirementMetrics.points.slice(-6).reverse().map((point) => (
									<span key={point.runId}>{displayTime(point.startedAt, language)} · {stageLabel(point.stageStatus)} · {point.metrics.artifactVersions} {en ? "brief versions" : "个需求单版本"}</span>
								))}
							</div>
						</details>
					)}
					{requirement?.readOnlyReason ? (
						<section className="proposal-empty"><strong>{en ? "Historical requirement (read-only)" : "历史需求（只读）"}</strong><p>{requirement.readOnlyReason}</p>
							<p>{en ? "Historical status: " : "历史状态："}{reviewRecovery && requirement.state.stageStatus === "needs_input" ? (en ? "Review needs recovery" : "复核待恢复") : stageLabel(requirement.state.stageStatus)} · {requirement.state.proposalVersions.length} {en ? "delivery versions" : "个交付版本"}</p>
							{!requirementTerminal && <button className="secondary-action" disabled={requirementBusy} onClick={() => void cancelRequirement()}>{en ? "Cancel historical task" : "取消历史任务"}</button>}
						</section>
					) : !requirement ? (
						<section className="proposal-empty brief-empty">
							<span className="brief-empty-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M14 3H5v18h14V8l-5-5Z" /><path d="M14 3v5h5M8 12h8M8 16h6" /></svg></span>
							<strong data-tour="brief-overview">{en ? "No brief yet" : "暂无需求单"}</strong>
							<p>{!hasUserMessage ? en ? "Send a request to create a draft." : "先发送需求，再生成草稿。" : en ? "Create a draft, then review and confirm." : "生成草稿，核对后确认。"}</p>
							<button
								className="primary-action" data-tour="generate"
								onClick={() => void startRequirement()}
								disabled={!hasUserMessage || !realProvider || requirementBusy || sending}
							>
								{requirementBusy ? en ? "Creating…" : "正在创建…" : en ? "Create requirement brief" : "生成需求单"}
							</button>
						</section>
					) : (
						<>
							<section className="brief-guidance">
								{requirementLeaseExpired && <p role="alert">{en ? "Processing was interrupted. Waiting for recovery; completion is not confirmed." : "处理已中断，正在等待恢复；尚未确认完成。"}</p>}
								<p role="status">{requirementRunning ? en ? "Preparing your draft…" : "正在整理草稿…" : requirement.state.stageStatus === "passed" ? en ? "Approved. Ready to export." : "已批准，可导出当前版本。" : requirement.state.stageStatus === "waiting_approval" ? en ? "Review the draft, then approve or reject it." : "核对草稿后，批准或拒绝当前版本。" : reviewRecovery ? en ? "Review failed; draft saved. Check the error and restart. No customer input is needed." : "复核失败，草稿已保存。查看原因后重新执行，无需补充客户资料。" : requirement.state.currentProposal?.freshness === "stale" ? en ? "Sources or confirmed information changed. Review the changes, then generate and approve a new version." : "资料或确认信息已变化，旧版本已失效。请核对变更，生成新版本并重新审批。" : en ? "Complete and confirm the fields, then generate a new version." : "补全并确认信息，再生成新版本。"}</p>

							</section>

							{content && active && requirement.state.currentProposal && <DeliveryPreview conversationId={active.conversationId} versions={requirement.state.proposalVersions.map((item) => item.version)} currentVersion={requirement.state.currentProposal.version} revision={requirement.state.aggregateVersion} onSources={setParsedSources} language={language} />}

							<details className="proposal-section diagnostics"><summary>{en ? "Task details" : "本次处理详情"}</summary>
								<dl className="run-metadata">
									<div><dt>{en ? "Industry" : "行业"}</dt><dd>{en ? "Packaging" : "包装"}</dd></div>
									{requirement.state.facts.plan_source && <div><dt>{en ? "Source" : "资料来源"}</dt><dd>{en ? "Plan" : "计划"} v{requirement.state.facts.plan_source.sourceRef.split(":version:")[1]}</dd></div>}
									<div><dt>{en ? "Status" : "状态"}</dt><dd>{reviewRecovery && requirement.state.stageStatus === "needs_input" ? (en ? "Review needs recovery" : "复核待恢复") : stageLabel(requirement.state.stageStatus)}</dd></div>
									<div><dt>{en ? "Version" : "版本"}</dt><dd>{requirement.state.currentProposal?.version ?? "—"}</dd></div>
									<div><dt>{en ? "Processing progress" : "处理进度"}</dt><dd>{requirement.job ? ({ queued: en ? "Queued" : "排队中", leased: en ? "Running" : "执行中", completed: en ? "Completed" : "已完成", cancelled: en ? "Cancelled" : "已取消", dead_letter: en ? "Failed" : "执行失败" }[requirement.job.status]) : "—"}</dd></div>
								</dl>
								<div className="section-title"><strong>{en ? "Review progress" : "核对进展"}</strong></div>
								<p>{en ? "Confirmed unchanged measures adoption; reference presence only checks that a reference exists. Neither proves factual accuracy. Processing time excludes human review time." : "原样确认比例表示采纳情况；引用填写率只表示有引用。两者均不等于事实准确率。运行耗时不含人工核对时间。"}</p>
								<dl className="run-metadata">
									<div><dt>{en ? "Information confirmed" : "信息确认比例"}</dt><dd>{Math.round(requirement.metrics.confirmationRate * 100)}% ({requirement.metrics.confirmedRequiredFacts}/{requirement.metrics.requiredFacts})</dd></div>
									<div><dt>{en ? "Confirmed unchanged" : "原样确认比例"}</dt><dd>{requirement.metrics.confirmedCandidateAccuracy === null ? "—" : `${Math.round(requirement.metrics.confirmedCandidateAccuracy * 100)}%`}</dd></div>
									<div><dt>{en ? "Reference presence" : "引用填写率"}</dt><dd>{requirement.metrics.sourceCoverageRate === null ? "—" : `${Math.round(requirement.metrics.sourceCoverageRate * 100)}%`}</dd></div>
									<div><dt>{en ? "Missing information" : "待补充信息"}</dt><dd>{requirement.metrics.missingRequiredFacts.length}</dd></div>
									<div><dt>{en ? "Clarification rounds" : "澄清轮次"}</dt><dd>{requirement.metrics.clarificationRounds}</dd></div>
									<div><dt>{en ? "Processing time" : "处理耗时"}</dt><dd>{requirement.metrics.runtime.latencyMs === null ? "—" : `${requirement.metrics.runtime.latencyMs} ms`}</dd></div>
									<div><dt>{en ? "Cost" : "成本"}</dt><dd>{requirement.metrics.runtime.costStatus === "unconfigured" ? en ? "Pricing not configured" : "未配置价格" : `$${requirement.metrics.runtime.costUsd}`}</dd></div>
									<div><dt>{en ? "Clarification questions" : "澄清问题"}</dt><dd>{requirement.metrics.clarificationQuestions}</dd></div>
									<div><dt>{en ? "Recoveries / failures" : "恢复 / 失败"}</dt><dd>{requirement.metrics.queue.recoveryCount} / {requirement.metrics.queue.totalFailureCount}</dd></div>
									<div><dt>{en ? "Processing errors" : "处理出错比例"}</dt><dd>{requirement.metrics.runtime.toolFailureRate === null ? "—" : `${Math.round(requirement.metrics.runtime.toolFailureRate * 100)}%`}</dd></div>
								</dl>
							</details>

							<details className="proposal-section facts-card" open={unconfirmedFacts.length > 0 || !!content?.pendingChanges?.length || !!requirement.candidateConflicts?.length || !facts.length}>
								<summary>{en ? "Review information" : "核对信息"}<span>{unconfirmedFacts.length} {en ? "unconfirmed" : "项待确认"}</span></summary>
								{requirement.candidateConflicts?.map(conflict => <div className="fact-change" key={conflict.id}>
									<strong>{fieldLabel(conflict.key)} · {en ? "Candidates need your decision" : "候选分歧待人工确认"}</strong>
									<p>{en ? "Both candidates are unconfirmed. Confirm the current value below, or enter a different value and then confirm it. Generating another draft or rejecting a candidate does not resolve this disagreement." : "两个候选均未确认。核对来源后，可确认下方当前值，或填入适用值再确认。重新生成或拒绝候选不会解除分歧。"}</p>
									{(["previous", "proposed"] as const).map(side => <div key={side}>
										<strong>{side === "previous" ? en ? "Earlier candidate" : "此前候选" : en ? "Later candidate" : "后续候选"}: {String(conflict[side].value)} {conflict[side].unit}</strong>
										<RequirementSource source={requirement.candidateConflictSources?.[conflict.id]?.[side]} en={en} />
										<button type="button" disabled={requirementBusy || requirementRunning || requirementTerminal} onClick={() => { setFactKey(conflict.key); setFactValue(String(conflict[side].value)); setFactUnit(conflict[side].unit ?? ""); document.getElementById("requirement-fact-value")?.focus(); }}>{en ? "Copy to edit form" : "填入修改表"}</button>
									</div>)}
								</div>)}
								{facts.map((fact) => (
									<div className="fact-row" key={`${fact.key}-${fact.version}`}>
										<div>
											<small title={`v${fact.version}`}>{fieldLabel(fact.key)}</small>
											<strong>{String(fact.value)}{fact.unit ? ` ${fact.unit}` : ""}</strong>
											<small>{factStatus(fact.status)} · {fact.sourceType === "model_output" ? en ? "AI extracted" : "AI 提取" : fact.sourceType === "human_confirmation" ? en ? "Human confirmed" : "人工确认" : en ? "Manually entered" : "人工录入"}</small>
											<RequirementSource source={requirement.factSources?.[fact.key]} en={en} tutorialTarget={fact.key === tutorialSourceKey} />
											{content?.pendingChanges?.filter((change) => change.key === fact.key && change.currentFactVersion === fact.version).map((change) => <div className="fact-change" key={change.key}>
												<strong>{en ? "Proposed change" : "新变更待确认"}: {String(change.value)} {change.unit}</strong>
												<p>{en ? "The confirmed value above stays in effect until you review this change. Earlier deliveries need rechecking." : "核对前保留上方已确认值；旧交付物需重新核对。"}</p>
												<RequirementSource source={requirement.proposalSources?.[fact.key]} en={en} />
												<button type="button" disabled={requirementBusy || requirementRunning || requirementTerminal || requirement.state.currentProposal?.freshness !== "fresh"} onClick={() => { setFactKey(change.key); setFactValue(String(change.value)); setFactUnit(change.unit ?? ""); document.getElementById("requirement-fact-value")?.focus(); }}>{en ? "Copy to edit form" : "填入修改表"}</button>
											</div>)}
										</div>
										{(fact.status === "suggested" || fact.status === "unverified") && (
											<div className="fact-actions" data-tour={fact.key === tutorialConfirmKey ? "confirm" : undefined}>
												<button onClick={() => void resolveFact(fact.key, "rejected")} disabled={requirementBusy || requirementRunning || requirementTerminal}>{en ? "Reject" : "拒绝"}</button>
												<button onClick={() => void resolveFact(fact.key, "verified")} disabled={requirementBusy || requirementRunning || requirementTerminal}>{requirement.candidateConflicts?.some(c => c.key === fact.key) ? en ? "Confirm current value" : "确认采用当前值" : en ? "Confirm" : "确认"}</button>
											</div>
										)}
									</div>
								))}
								<form className="fact-form" onSubmit={(event) => void recordFact(event)}>
									<select data-tour="fact-form" value={factKey} onChange={(event) => { setFactKey(event.target.value); setFactValue(""); }} aria-label={en ? "Requirement field" : "需求字段"} disabled={requirement.state.stageStatus === "cancelled"}><option value="">{en ? "Choose a field to add" : "选择要补充的字段"}</option>{fieldOptions.map((key) => <option key={key} value={key}>{fieldLabel(key)}</option>)}</select>
									<input id="requirement-fact-value" value={factValue} type={factKey === "quantity" ? "number" : factKey === "target_delivery" ? "date" : "text"} min={factKey === "quantity" ? 1 : undefined} step={1} required onChange={(event) => setFactValue(event.target.value)} placeholder={factKey === "dimensions" ? en ? "Example: W 160 × H 230 + bottom 80 mm" : "例如：宽 160 × 高 230 + 底 80 mm" : en ? "Enter value" : "填写内容"} aria-label={en ? "Field value" : "字段内容"} disabled={requirement.state.stageStatus === "cancelled"} />
									<input value={factUnit} onChange={(event) => setFactUnit(event.target.value)} placeholder={en ? "Unit (optional)" : "单位（可选）"} aria-label={en ? "Field unit" : "字段单位"} disabled={requirement.state.stageStatus === "cancelled"} />
									<button type="submit" disabled={requirementBusy || requirementRunning || requirement.state.stageStatus === "cancelled" || !factKey.trim() || !factValue.trim()}>{en ? "Add unverified information" : "添加待确认信息"}</button>
								</form>
								<small>{en ? "Confirm new information item by item. Changes make earlier briefs stale, so generate a new version." : "新增信息需逐项确认。修改后旧需求单会失效，请重新生成。"}</small>
							</details>

							{active && <RequirementTrial key={requirement.runId} conversationId={active.conversationId} workspace={requirement} en={en} />}



							{requirement.state.currentProposal && !content && (
								<section className="proposal-section invalid-artifact">
									<strong>{en ? "Unable to display this brief" : "暂时无法展示需求单"}</strong>
									<p>{en ? "Original output is saved. See validation for details." : "原始内容已保存，请查看校验详情。"}</p>
								</section>
							)}

							{evaluation && (
								<details className={`proposal-section evaluation ${evaluation.passed ? "passed" : "failed"}`} open={!evaluation.passed || evaluation.evidenceReview?.status === "failed" || !!evaluation.evidenceReview?.issues.length || !!evaluation.extractionCorrections?.length}>
									<summary>{en ? "Review results" : "检查结果"}<span>{evaluation.approvalEligible ? en ? "Passed" : "通过" : en ? "Action needed" : "需处理"}</span></summary>
									{evaluation.issues.length === 0
										? <p>{en ? `Content structure and confirmation status checked. ${evaluation.approvalEligible ? "Ready for approval." : "More information or confirmation is still needed."}` : `内容结构与确认状态已检查。${evaluation.approvalEligible ? "可以审批。" : "仍需补充或确认信息。"}`}</p>
										: evaluation.issues.map((issue, index) => <p key={`${issue.code}-${index}`}>{validationText(issue, language)}</p>)}
									{evaluation.extractionCorrections?.map((correction, index) => <details key={index}>
										<summary>{en ? "Extraction corrected; confirmation still needed" : "已纠正提取错误，仍待确认"} · {fieldLabel(correction.field)}: {String(correction.previousValue)} → {correction.value} {correction.unit}</summary>
										<p>{en ? "Original excerpt" : "原文摘录"}</p><blockquote>{correction.quote}</blockquote>
									</details>)}
									{evaluation.evidenceReview && <>
										<p>{en ? "Evidence review" : "证据复核"} · v{evaluation.evidenceReview.artifactVersion} · {evaluation.evidenceReview.status === "failed" ? (en ? "Incomplete — approval blocked" : "未完成，已阻止审批") : (en ? "Completed" : "已完成")}</p>
										{evaluation.evidenceReview.issues.map((issue, index) => <div key={index}>
											<strong>{issue.location.startsWith("/facts/") ? fieldLabel(issue.location.split("/")[2]) : issue.location === "/customerGoal" ? (en ? "Customer goal" : "客户目标") : issue.location === "/assumptions" ? (en ? "Assumptions and limitations" : "假设与限制") : (en ? "Information to review" : "待核对内容")}</strong><p>{issue.reason}</p>
											<p>{issue.evidenceRefs.length ? (en ? `${issue.evidenceRefs.length} supporting references; check the original sources above.` : `涉及 ${issue.evidenceRefs.length} 条资料，请在上方核对原文。`) : (en ? "Insufficient evidence" : "证据不足")}</p>
											<p>{en ? "Suggested action" : "建议动作"}: {issue.suggestedAction === "revise" ? (en ? "Revise the brief" : "修订需求单") : issue.suggestedAction === "reconfirm_plan" ? (en ? "Reconfirm plan" : "重新确认计划") : (en ? "Provide or confirm evidence" : "补充或确认资料")}</p>
										</div>)}
										{evaluation.decision === "reconfirm_plan" && <p>{en ? "The scope needs to change. Replan and confirm the new version before importing it again." : "需求涉及范围变化。请重新规划并确认新计划版本，再导入需求单。"}</p>}
									</>}
								</details>
							)}

							{requirement.state.approval?.status === "requested" && (
								<section data-tour="approve" className="proposal-section approval-card">
									<strong>{en ? "Confirm requirement brief" : "确认需求单"} · v{requirement.state.approval.artifactVersion}</strong>
									<p>{en ? "Approval applies only to the current version; future request changes invalidate it." : "审批只绑定当前版本；后续需求变化会使该审批失效。"}</p>
									<div className="approval-actions">
										<button onClick={() => void resolveRequirementApproval("rejected")} disabled={requirementBusy}>{en ? "Reject" : "拒绝"}</button>
										<button className="primary-action" onClick={() => void resolveRequirementApproval("approved")} disabled={requirementBusy}>{en ? "Approve current version" : "批准当前版本"}</button>
									</div>
								</section>
							)}

							{requirement.state.approval && requirement.state.approval.status !== "requested" && requirement.state.approval.status !== "approved" && (
								<div className={`approval-result ${requirement.state.approval.status}`}>{en ? "Requirement brief confirmation: " : "需求单确认："}{statusFor(language, requirement.state.approval.status, ({ approved: "已批准", rejected: "已拒绝", superseded: "已失效", cancelled: "已取消" } as Record<string, string>)[requirement.state.approval.status] ?? requirement.state.approval.status)}</div>
							)}
							{requirement.job?.status === "dead_letter" && (
								<div className="proposal-failure">{errorText(requirement.job.lastFailure, language)}</div>
							)}

							{requirement.state.stageStatus !== "passed" && requirement.state.stageStatus !== "cancelled" && (
								<button className="secondary-action" onClick={() => void cancelRequirement()} disabled={requirementBusy}>{en ? "Cancel task" : "取消任务"}</button>
							)}
							{requirement.state.stageStatus === "passed" && <p className="cancelled-note">{en ? "Changes require a new version and approval. Previous versions stay available." : "修改后需生成新版本并重新批准，旧版本保留。"}</p>}
							{requirement.state.stageStatus === "cancelled" && (
								<div className="cancelled-note">{en ? "Content and history are saved. You can resume the review." : "内容与历史记录已保留，可重新审查。"}</div>
							)}
							<button
								className="secondary-action" data-tour="generate"
								onClick={() => void startRequirement()}
								disabled={(!hasUserMessage && !requirement.state.facts.plan_source) || !realProvider || requirementBusy || sending || requirementRunning || requirement.state.stageStatus === "waiting_approval"}
							>
								{requirementRunning
									? progressLabel(requirementActivity)
									: requirement.state.stageStatus === "cancelled"
										? en ? "Re-review requirement brief" : "重新审查需求单"
										: reviewRecovery ? en ? "Try again (may incur a fee)" : "重新处理（可能产生费用）" : en ? "Generate new version" : "生成新版本"}
							</button>
						</>
					)}
				</div>
				<div className="proposal-body" role="tabpanel" id="panel-knowledge" aria-labelledby="tab-knowledge" hidden={panelTab !== "knowledge"}>{active && (reviewOpen && panelTab === "knowledge" || tutorial?.reviewOpen && tutorial.panelTab === "knowledge") ? <KnowledgePanel key={active.conversationId} conversationId={active.conversationId} attachments={attachments} language={language} /> : <p>{en ? "Select a task to inspect packaging evidence." : "选择任务后查看包装证据。"}</p>}</div>
				<div className="proposal-body" role="tabpanel" id="panel-memory" aria-labelledby="tab-memory" hidden={panelTab !== "memory"}>{active && (reviewOpen && panelTab === "memory" || tutorial?.reviewOpen && tutorial.panelTab === "memory") ? <MemoryPanel key={active.conversationId} conversationId={active.conversationId} language={language} /> : <p>{en ? "Select a task to manage personal memory." : "选择任务后管理个人记忆。"}</p>}</div>
				<div className="proposal-body" role="tabpanel" id="panel-models" aria-labelledby="tab-models" hidden={panelTab !== "models"}>{(reviewOpen && panelTab === "models" || tutorial?.reviewOpen && tutorial.panelTab === "models") && <ModelSettings language={language} />}{active && (reviewOpen && panelTab === "models" || tutorial?.reviewOpen && tutorial.panelTab === "models") ? <details className="proposal-section diagnostics"><summary>{en ? "Processing history" : "处理记录"}</summary><ModelMonitor key={active.conversationId} conversationId={active.conversationId} language={language} /></details> : !active && <p>{en ? "Create or select a task to view processing history." : "新建或选择任务后查看处理记录。"}</p>}</div>
				<div className="proposal-body" role="tabpanel" id="panel-files" aria-labelledby="tab-files" hidden={panelTab !== "files"}>{active ? <FileExplorer key={active.conversationId} conversationId={active.conversationId} language={language} onUseFile={(path) => { setDraft(en ? `Please read and help me work with this file: ${path}\nRequest:` : `请读取并协助处理这个文件：${path}\n处理要求：`); if (window.innerWidth < 1180) setReviewOpen(false); }} /> : <p>{en ? "Create or select a conversation to browse local files." : "新建或选择会话后浏览本机文件。"}</p>}</div>
			</aside>
			{tutorial && <WorkspaceTutorial language={language} step={tutorial.step} onStep={(step) => setTutorial((current) => current ? { ...current, step } : current)} onClose={closeTutorial} />}
			{pendingDelete && <DeleteConversationDialog title={pendingDelete.title} busy={deleting} error={deleteError} language={language}
				onCancel={() => setPendingDelete(undefined)} onConfirm={() => void deleteConversation()} />}
		</div>
	);
}

export default App;
