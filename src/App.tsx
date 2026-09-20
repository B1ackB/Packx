import { KnowledgePanel } from "./components/KnowledgePanel";
import { ModelSettings } from "./components/ModelSettings";
import { PlanPanel } from "./components/PlanPanel";
import type { PlanWorkspace } from "./enterprise/agentPlan";
import { errorText, validationText } from "./i18n";
import { ModelMonitor } from "./components/ModelMonitor";
import { FileExplorer } from "./components/FileExplorer";
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { Markdown } from "./components/Markdown";
import { ConversationFiles } from "./components/ConversationFiles";
import { DeleteConversationDialog } from "./components/DeleteConversationDialog";
import { DeliveryPreview } from "./components/DeliveryPreview";
import { requirementFieldLabels, factStatusLabels } from "./manufacturing/requirementDelivery";
import { languageNames, labelFor, statusFor, type Language } from "./i18n";
import type { AssetInspectionRecord } from "./runtime/assetInspection";
import { packagingFactKeys } from "./manufacturing/requirementBrief";
import type { RuntimeActivity } from "./runtime/conversationContracts";
import type { RuntimeHealth } from "./runtime/contracts";
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
	evaluating: "正在评测",
	needs_input: "需要补充/确认",
	waiting_approval: "等待批准",
	revision_required: "需要修订",
	cancelled: "已取消",
	passed: "已通过",
	retryable_failed: "评测未通过",
} as const;

const stageLabelsEn: Record<keyof typeof stageLabels, string> = {
	pending: "Not started",
	running: "Generating",
	evaluating: "Evaluating",
	needs_input: "Input needed",
	waiting_approval: "Awaiting approval",
	revision_required: "Revision needed",
	cancelled: "Cancelled",
	passed: "Passed",
	retryable_failed: "Evaluation failed",
};

function App() {
	const [language, setLanguage] = useState<Language>(() => localStorage.getItem("blackx-language") === "en" ? "en" : "zh");
	const [panelTab, setPanelTab] = useState<"requirement" | "models" | "files" | "knowledge">("requirement");
	const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 760);
	const [reviewOpen, setReviewOpen] = useState(() => window.innerWidth >= 1180);
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
	const deletedIds = useRef(new Set<string>());
	const selectionVersion = useRef(0);
	const [pendingDelete, setPendingDelete] = useState<ConversationSummary>();
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string>();
	const activate = (conversation?: ConversationView) => {
		setRenaming(false);
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
	const en = language === "en";
	const stageLabel = (status: keyof typeof stageLabels) => en ? stageLabelsEn[status] : stageLabels[status];
	const defaultConversationTitle = en ? "New conversation" : "新会话";
	const defaultConversationPreview = en ? "No messages yet" : "尚未发送消息";
	const displayConversationTitle = (title: string) => title === "新会话" || title === "New conversation" ? defaultConversationTitle : title;
	const displayConversationPreview = (preview: string) => preview === "尚未发送消息" || preview === "No messages yet" ? defaultConversationPreview : preview;
	const fieldLabel = (key: string) => labelFor(language, key, requirementFieldLabels[key] ?? key);
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
		if (!active) return;
		let cancelled = false;
		void client.getRequirementBrief(active.conversationId)
			.then((next) => {
				if (!cancelled) {
					setRequirement(next ?? undefined);
				}
			})
			.catch((reason) => {
				if (!cancelled) setError(errorMessage(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [active?.conversationId]);

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
				setAttachments([]); setSelectedAttachmentIds([]); setParsedSources([]); setAttachmentPreviews({});
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
			if (content && !planRunning && !planBusy) await planCommand({ action: "generate", objective: content });
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
		const conversationId = active.conversationId;
		setRequirementBusy(true);
		setError(undefined);
		try {
			const next = await client.startRequirementBrief(
				conversationId,
				`requirement-${crypto.randomUUID()}`,
				planVersion ?? (requirement?.state.facts.plan_source ? Number(/:version:(\d+)$/.exec(requirement.state.facts.plan_source.sourceRef)?.[1]) : undefined),
			);
			if (activeIdRef.current !== conversationId) return;
			setRequirement(next);
			setPanelTab("requirement");
			setReviewOpen(true);
		} catch (reason) {
			if (activeIdRef.current === conversationId) setError(errorMessage(reason));
		} finally {
			if (activeIdRef.current === conversationId) setRequirementBusy(false);
		}
	};

	const uploadAttachments = async (event: ChangeEvent<HTMLInputElement>) => {
		const input = event.currentTarget;
		const files = [...(input.files ?? [])];
		if (!active || files.length === 0 || uploading) return;
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
			setAttachments(await client.listAttachments(active.conversationId));
			setSelectedAttachmentIds((current) => [...new Set([
				...current,
				...uploaded.map((attachment) => attachment.attachmentId),
			])]);
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			input.value = "";
			setUploading(false);
		}
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
		setRequirementBusy(true);
		setError(undefined);
		try {
			setRequirement(await client.resolveRequirementApproval(
				active.conversationId,
				`approval-${crypto.randomUUID()}`,
				decision,
			));
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setRequirementBusy(false);
		}
	};

	const cancelRequirement = async () => {
		if (!active || !requirement || requirementBusy || requirement.state.stageStatus === "passed") return;
		setRequirementBusy(true);
		setError(undefined);
		try {
			setRequirement(await client.cancelRequirementBrief(
				active.conversationId,
				`cancel-${crypto.randomUUID()}`,
			));
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setRequirementBusy(false);
		}
	};

	const recordFact = async (event: FormEvent) => {
		event.preventDefault();
		if (!active || !requirement || requirementBusy || !factKey.trim() || !factValue.trim()) return;
		setRequirementBusy(true);
		setError(undefined);
		try {
			setRequirement(await client.recordRequirementFact(
				active.conversationId,
				`fact-${crypto.randomUUID()}`,
				{
					key: factKey.trim(),
					value: factKey === "quantity" ? Number(factValue) : factValue.trim(),
					unit: factUnit.trim() || undefined,
				},
			));
			setFactKey("");
			setFactValue("");
			setFactUnit("");
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setRequirementBusy(false);
		}
	};

	const resolveFact = async (key: string, decision: "verified" | "rejected") => {
		if (!active || requirementBusy) return;
		setRequirementBusy(true);
		setError(undefined);
		try {
			setRequirement(await client.resolveRequirementFact(
				active.conversationId,
				key,
				`fact-decision-${crypto.randomUUID()}`,
				decision,
			));
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setRequirementBusy(false);
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
	const facts = Object.values(requirement?.state.facts ?? {})
		.filter((fact) => packagingFactKeys.includes(fact.key))
		.sort((left, right) => left.key.localeCompare(right.key));
	const requirementRunning = !requirement?.readOnlyReason && (requirement?.state.stageStatus === "running" && requirement.job?.status !== "dead_letter" ||
		requirement?.state.stageStatus === "evaluating" ||
		requirement?.job?.status === "queued" ||
		requirement?.job?.status === "leased");
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
		const resize = () => { if (window.innerWidth < 1180) setReviewOpen(false); if (window.innerWidth < 760) setSidebarOpen(false); };
		const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setReviewOpen(false); if (window.innerWidth < 760) setSidebarOpen(false); } };
		window.addEventListener("resize", resize); window.addEventListener("keydown", escape);
		return () => { window.removeEventListener("resize", resize); window.removeEventListener("keydown", escape); };
	}, []);

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
	const progressLabel = (value?: RuntimeActivity) => value?.phase === "tool" ? `${en ? "Running" : "正在"}${value.tool === "asset_metadata_inspect" ? en ? " attachment analysis" : "解析附件" : value.tool === "project_source_read" ? en ? " requirement source read" : "读取需求来源" : en ? " tool" : "执行工具"}${value.tool ? ` · ${value.tool}` : ""}` : value?.phase === "model" ? `${en ? "Analysing" : "正在分析"}${value.iteration ? en ? ` · pass ${value.iteration}` : ` · 第 ${value.iteration} 轮` : ""}` : en ? "Preparing task" : "正在准备任务";
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
						<span>{en ? "Packaging Workspace" : "包装工作台"}</span>
					</div>
				</div>

				<button ref={newConversationRef} className="new-task" onClick={() => void createConversation()} disabled={sending || deleting || loading}>
					<span>＋</span> {en ? "New conversation" : "新建会话"}
				</button>

				<div className="history-label">{en ? "Conversation history" : "会话历史"}</div>
				<input className="task-search" type="search" aria-label={en ? "Search tasks" : "搜索任务"} placeholder={en ? "Search names and plan objectives" : "搜索任务名称与计划目标"} value={search} onChange={(e) => setSearch(e.target.value)} />
					{search && !conversations.some((c) => `${c.title} ${c.preview} ${c.searchText ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && <p role="status">{en ? "No matching tasks" : "没有匹配的任务"}</p>}
				<nav className="conversation-list" aria-label={en ? "Conversation history" : "会话历史"}>
					{!loading && conversations.length === 0 && <p className="history-empty">{en ? "No conversations yet. Start a new one." : "暂无会话，新建一个开始吧。"}</p>}
					{conversations.filter((c) => `${c.title} ${c.preview} ${c.searchText ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map((conversation) => (
						<div className="conversation-item" key={conversation.conversationId}>
						<button
							className={active?.conversationId === conversation.conversationId ? "active" : ""}
							onClick={() => void selectConversation(conversation.conversationId)}
							disabled={sending || deleting}
						>
							<strong>{displayConversationTitle(conversation.title)}</strong>
							<span>{displayConversationPreview(conversation.preview)}</span>
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
					<button className="secondary-action" onClick={() => { setPanelTab("models"); setReviewOpen(true); }}>{en ? "Configure model" : "配置模型"}</button>
					<div className="runtime-light">
						<i className={realProvider ? "online" : "offline"} />
						{!realProvider ? en ? "Model not configured" : "模型尚未配置" : health?.providerStatus === "last_request_succeeded" ? en ? "Last request succeeded" : "最近请求成功" : health?.providerStatus === "last_request_failed" ? en ? "Last request failed" : "最近请求失败" : en ? "Model configured · pending verification" : "模型已配置 · 待验证"}
					</div>
					<label className="language-selector">{en ? "Language" : "语言"}<select value={language} onChange={(event) => setLanguage(event.target.value as Language)} aria-label={en ? "Language" : "语言"}>{Object.entries(languageNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
					<details className="permission-summary"><summary>{en ? "Local access and tool permissions" : "本地访问与工具权限"}</summary><p>{en ? "This device binds the conversation identity. The Agent can read local files; before creating, changing, or deleting one, it shows the exact path and content for your one-time approval and retains a backup. Attachment inspection never uses the network, and facts still require human confirmation." : "会话身份由本机服务绑定。可读取本机真实文件；Agent 会在新建、修改或删除前展示具体路径和内容，等你单次批准后执行，并保留备份。附件解析禁止联网，事实仍需人工确认。"}</p></details>
				</div>
			</aside>

			<main className="conversation">
				<header className="topbar">
					<button className="panel-toggle" aria-label={en ? "Toggle conversation sidebar" : "切换会话侧栏"} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
					<div>
						<span className="eyebrow">PACKX WORKSPACE</span>
						<h1>{active ? displayConversationTitle(active.title) : (en ? "Packx conversation" : "Packx 会话")}</h1>
						{active && (renaming ? <form className="task-name-form" onSubmit={(e) => {
							e.preventDefault(); const id = active.conversationId; setNameBusy(true);
							void client.rename(id, taskName, active.nameRevision ?? 0, language).then(async (next) => { updateActive(next); if (activeIdRef.current === id) setRenaming(false); await refreshList(next); }).catch((reason) => setError(reason instanceof ConversationClientError && reason.code === "task_name_conflict" ? en ? "Task name changed in another window. Reload before renaming." : "任务名称已在其他窗口更改，请刷新后重命名。" : errorMessage(reason))).finally(() => setNameBusy(false));
						}}><input aria-label={en ? "Task name" : "任务名称"} autoFocus required maxLength={100} value={taskName} onChange={(e) => setTaskName(e.target.value)} /><button disabled={nameBusy || !taskName.trim()}>{en ? "Save name" : "保存名称"}</button><button type="button" disabled={nameBusy} onClick={() => setRenaming(false)}>{en ? "Cancel" : "取消"}</button></form> : <button className="rename-task" onClick={() => { setTaskName(active.title); setRenaming(true); }}>{en ? "Rename task" : "重命名任务"}</button>)}
					</div>
					<button className="panel-toggle review-toggle" aria-expanded={reviewOpen} onClick={() => setReviewOpen(!reviewOpen)}>{en ? "Workspace" : "工作区"} · {{ requirement: en ? "Requirements" : "需求单", models: en ? "Models" : "模型", knowledge: en ? "Evidence" : "证据", files: en ? "Files" : "文件" }[panelTab]}</button>
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
						<div className="empty-state"><p>{en ? "Loading conversations…" : "正在加载服务端会话…"}</p></div>
					) : active?.messages.length ? (
						<div className="message-list">
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
										<span>{hasActiveBackgroundTask ? en ? "A background task is running; you can switch conversations." : "后台任务正在执行，可以切换会话" : progressLabel(activity)}</span>
										{activity?.partialText && !hasActiveBackgroundTask ? <Markdown text={activity.partialText} language={language} /> : <div className="thinking-dots"><i /><i /><i /></div>}
									</div>
								</article>
							)}
						</div>
					) : planState?.versions.length ? null : (
						<div className="empty-state">
							<span className="empty-mark">Px</span>
							<h2>{en ? "Start a new packaging request" : "开始一个新的包装需求任务"}</h2>
							<p>{en ? "Upload reference material and describe what you need delivered. Packx organises the request, flags missing information, and creates a requirement brief you can review and export." : "上传资料，描述你要交付什么。Packx 会整理需求、标出缺失信息，生成可核对与导出的需求单。"}</p>
							{!active ? <button className="secondary-action" onClick={() => void createConversation()} disabled={deleting}>{en ? "Start a conversation" : "开始新会话"}</button> : <div className="prompt-grid">
								<button onClick={() => setDraft(en ? "I need a 500 g coffee bean packaging bag. Please help me identify the information that needs confirmation first." : "我想做一款500克咖啡豆包装袋，请先帮我梳理需要确认的信息。")}>{en ? "Coffee packaging request" : "咖啡豆包装需求"}</button>
								<button onClick={() => setDraft(en ? "I need custom folding cartons for skincare products. Please help me confirm the carton type, dimensions, quantity, and delivery details." : "我想定制一批护肤品包装纸盒，请先帮我梳理盒型、尺寸、数量和交付信息。")}>{en ? "Skincare carton request" : "护肤品纸盒需求"}</button>
							</div>}
						</div>
					)}
					{active && <PlanPanel part="details" state={planState} language={language} busy={planBusy || sending || hasActiveBackgroundTask || requirementBusy || requirementRunning} onCommand={(c) => { void planCommand(c); }} onCreateBrief={!requirementTerminal && !requirement?.readOnlyReason ? (version) => { void startRequirement(version); } : undefined} />}
				</section>

				<div className="composer-wrap">
					{active && <ConversationFiles key={active.conversationId} conversationId={active.conversationId} language={language} />}
					{!realProvider && !loading && (
						<div className="provider-warning">{en ? "The model service is not configured. Connect a local model to begin; saved conversations and requirement briefs remain available to review." : "模型服务尚未配置。配置本地模型连接后即可开始；已保存的会话和需求单仍可查看。"}</div>
					)}
					{error && <div className="error-banner" role="alert">{errorText(error, language)}<button aria-label={en ? "Dismiss error" : "关闭错误提示"} onClick={() => setError(undefined)}>×</button></div>}
					{planState?.mode !== "plan" && !planRunning && !replyRunning && !hasActiveBackgroundTask && active?.messages.at(-1)?.role === "user" && <button className="retry-action" disabled={!realProvider} onClick={() => void retryReply()}>{en ? "Continue the unfinished reply" : "继续上次未完成的回复"}</button>}
					{hasActiveBackgroundTask && (
						<div className="task-banner" role="status">
							{en ? "Background task: " : "后台任务："}{activeBackgroundTasks.some((task) => task.status === "leased") ? en ? "Model processing" : "模型处理中" : en ? "Queued or waiting to retry" : "排队或等待重试"}
						</div>
					)}
					{activeCronSchedules.length > 0 && (
						<div className="cron-banner" role="status">
							{en ? "Agent-managed schedules: " : "Agent 管理的定时任务："}{activeCronSchedules.length} {en ? "· next run " : "个 · 下次运行 "}{displayTime(activeCronSchedules[0].nextRunAt, language)}
						</div>
					)}
					{attachments.length > 0 && (
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
									<small>{selectedAttachmentIds.includes(attachment.attachmentId) ? en ? "Will be read with the next message" : "将随下一条消息读取" : en ? "Attach to the next message" : "点击附到下一条消息"}</small>
								</button><button className="attachment-download" onClick={() => void downloadAttachment(attachment)} aria-label={`${en ? "Download" : "下载"} ${attachment.name}`}>{en ? "Download" : "下载"}</button></div>
							))}
						</div>
					)}
					{active && <PlanPanel part="controls" state={planState} language={language} busy={planBusy || sending || hasActiveBackgroundTask} onCommand={(c) => { void planCommand(c); }} />}
					<form className="composer" onSubmit={onSubmit}>
						<textarea
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
								: realProvider ? en ? "Message Packx…" : "发送消息给 Packx…" : en ? "Connect a live model API first" : "请先连接实际模型 API"}
							disabled={!active || !realProvider || replyRunning || hasActiveBackgroundTask || planBusy || planRunning}
							aria-label={en ? "Conversation input" : "对话输入"}
						/>
						<div className="composer-tools">
							<label className={uploading ? "attachment-upload disabled" : "attachment-upload"}>
								<input
									type="file"
									multiple
									accept="image/*,.pdf,.docx,.xlsx,.txt,.md,.csv,.json"
									onChange={(event) => void uploadAttachments(event)}
									disabled={!active || uploading}
								/>
								{uploading ? en ? "Uploading…" : "上传中…" : en ? "＋ Image / file" : "＋ 图片 / 文件"}
							</label>
							<span>{en ? "Enter to send · Shift + Enter for a new line" : "Enter 发送 · Shift + Enter 换行"}</span>
							{replyRunning && <button type="button" className="stop-button" onClick={() => void stopReply()}>{en ? "Stop" : "停止"}</button>}
							<button
								type="submit"
								className="send-button"
								disabled={(!draft.trim() && selectedAttachmentIds.length === 0) || !realProvider || sending || hasActiveBackgroundTask || planBusy || planRunning || (planState?.mode === "plan" && !draft.trim())}
							>
								↑
							</button>
						</div>
					</form>
					<small className="disclaimer">{en ? "Confirm AI-extracted information yourself. Requirement briefs retain their source material and version history." : "AI 提取的信息需你确认。需求单保留资料来源与版本记录。"}</small>
				</div>
			</main>

			<aside className="proposal-panel" aria-label={en ? "Workspace" : "多功能工作区"}>
				<header className="proposal-header">
					<button className="panel-toggle" aria-label={en ? "Close workspace" : "关闭工作区"} onClick={() => setReviewOpen(false)}>×</button>
					<div>
						<span className="eyebrow">WORKSPACE</span>
						<h2>{{ requirement: en ? "Requirements workspace" : "需求单工作区", models: en ? "Model monitor" : "模型监控", knowledge: en ? "Packaging evidence" : "包装数据与证据", files: en ? "File browser" : "文件浏览" }[panelTab]}</h2>
					</div>
					{panelTab === "requirement" && requirement && (
						<span className={`proposal-status ${requirement.state.stageStatus}`}>
							{stageLabel(requirement.state.stageStatus)}
						</span>
					)}
				</header>

				<div className="workspace-tabs" role="tablist" aria-label={en ? "Workspace tools" : "工作区功能"}>
					{(["requirement", "knowledge", "models", "files"] as const).map((tab, index, tabs) => <button key={tab} role="tab" id={`tab-${tab}`} aria-controls={`panel-${tab}`} aria-selected={panelTab === tab} tabIndex={panelTab === tab ? 0 : -1} onClick={() => setPanelTab(tab)} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length; setPanelTab(tabs[next]); (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next])?.focus(); } }}>{ { requirement: en ? "Requirements" : "需求单", models: en ? "Model calls" : "模型调用", knowledge: en ? "Evidence" : "证据", files: en ? "Files" : "文件" }[tab]}</button>)}
				</div>
				<div className="proposal-body" role="tabpanel" id="panel-requirement" aria-labelledby="tab-requirement" hidden={panelTab !== "requirement"}>
					{requirementMetrics && requirementMetrics.totals.runs > 0 && (
						<details className="proposal-section diagnostics"><summary>{en ? "Run metrics" : "运行统计"}</summary>
							<div className="section-title"><strong>{en ? "Cross-run metrics" : "跨运行指标"}</strong><code>{requirementMetrics.totals.runs} {en ? "runs" : "次运行"}</code></div>
							<dl className="run-metadata">
								<div><dt>{en ? "Workflow completion" : "工作流完成"}</dt><dd>{requirementMetrics.rates.workflowCompletion === null ? "—" : `${Math.round(requirementMetrics.rates.workflowCompletion * 100)}%`}</dd></div>
								<div><dt>{en ? "Stage pass" : "Stage 通过"}</dt><dd>{requirementMetrics.rates.stagePass === null ? "—" : `${Math.round(requirementMetrics.rates.stagePass * 100)}%`}</dd></div>
								<div><dt>{en ? "Evaluation pass" : "评测通过"}</dt><dd>{requirementMetrics.rates.evaluationPass === null ? "—" : `${Math.round(requirementMetrics.rates.evaluationPass * 100)}%`}</dd></div>
								<div><dt>{en ? "Needs input" : "需要补充"}</dt><dd>{requirementMetrics.totals.needsInput}</dd></div>
								<div><dt>{en ? "Average fact confirmation" : "平均 Fact 确认"}</dt><dd>{requirementMetrics.averages.confirmationRate === null ? "—" : `${Math.round(requirementMetrics.averages.confirmationRate * 100)}%`}</dd></div>
								<div><dt>{en ? "Candidate accuracy" : "候选确认准确率"}</dt><dd>{requirementMetrics.averages.confirmedCandidateAccuracy === null ? "—" : `${Math.round(requirementMetrics.averages.confirmedCandidateAccuracy * 100)}%`}</dd></div>
								<div><dt>{en ? "Source coverage" : "来源覆盖"}</dt><dd>{requirementMetrics.averages.sourceCoverageRate === null ? "—" : `${Math.round(requirementMetrics.averages.sourceCoverageRate * 100)}%`}</dd></div>
								<div><dt>{en ? "Artifacts / clarification questions" : "Artifact / 澄清问题"}</dt><dd>{requirementMetrics.totals.artifactVersions} / {requirementMetrics.totals.clarificationQuestions}</dd></div>
								<div><dt>{en ? "Queue recovery / failure rate" : "Queue 恢复 / 失败率"}</dt><dd>{requirementMetrics.queue.recoveryRate === null ? "—" : `${Math.round(requirementMetrics.queue.recoveryRate * 100)}%`} / {requirementMetrics.queue.failureRate === null ? "—" : `${Math.round(requirementMetrics.queue.failureRate * 100)}%`}</dd></div>
								<div><dt>{en ? "Tool failure rate" : "Tool 失败率"}</dt><dd>{requirementMetrics.runtime.toolFailureRate === null ? "—" : `${Math.round(requirementMetrics.runtime.toolFailureRate * 100)}%`}</dd></div>
								<div><dt>{en ? "Total tokens (in / out)" : "总 Token (in / out)"}</dt><dd>{requirementMetrics.runtime.usage ? `${requirementMetrics.runtime.usage.inputTokens} / ${requirementMetrics.runtime.usage.outputTokens}` : "—"}</dd></div>
								<div><dt>{en ? "Average runtime latency" : "平均 Runtime 延迟"}</dt><dd>{requirementMetrics.averages.runtimeLatencyMs === null ? "—" : `${Math.round(requirementMetrics.averages.runtimeLatencyMs)} ms`}</dd></div>
							</dl>
							<div className="verification-list">
								<strong>{en ? "Recent run timeline" : "最近运行时间序列"}</strong>
								{requirementMetrics.points.slice(-6).reverse().map((point) => (
									<span key={point.runId}>{displayTime(point.startedAt, language)} · {point.industry ?? "unknown"} · {stageLabel(point.stageStatus)} · Artifact v{point.metrics.artifactVersions}</span>
								))}
							</div>
						</details>
					)}
					{requirement?.readOnlyReason ? (
						<section className="proposal-empty"><strong>{en ? "Historical requirement (read-only)" : "历史需求（只读）"}</strong><p>{requirement.readOnlyReason}</p>
							<p>{en ? "Historical status: " : "历史状态："}{stageLabel(requirement.state.stageStatus)} · {requirement.state.proposalVersions.length} {en ? "delivery versions" : "个交付版本"}</p>
							{!requirementTerminal && <button className="secondary-action" disabled={requirementBusy} onClick={() => void cancelRequirement()}>{en ? "Cancel historical task" : "取消历史任务"}</button>}
						</section>
					) : !requirement ? (
						<section className="proposal-empty">
							<strong>{en ? "Organise source material into a deliverable requirement brief" : "把资料整理成可交付的需求单"}</strong>
							<p>{en ? "Review packaging type, dimensions, quantity, market, delivery date, and artwork one by one, then confirm the current version." : "围绕包装类型、尺寸、数量、市场、交期和稿件，逐项核对资料，再确认当前版本。"}</p>
							<button
								className="primary-action"
								onClick={() => void startRequirement()}
								disabled={!hasUserMessage || !realProvider || requirementBusy || sending}
							>
								{requirementBusy ? en ? "Creating…" : "正在创建…" : en ? "Create requirement brief" : "生成需求单"}
							</button>
							{!hasUserMessage && <small>{en ? "First, describe a clear packaging request." : "先描述一条明确的包装需求。"}</small>}
						</section>
					) : (
						<>
							<section className="workflow-track" aria-label={en ? "Requirement brief workflow progress" : "Requirement Brief 工作流进度"}>
								<span className="done">{en ? "Collect" : "收集需求"}</span>
								<span className={requirement.state.currentProposal ? "done" : "active"}>{en ? "Organise" : "整理资料"}</span>
								<span className={requirement.state.evaluation ? "done" : requirement.state.stageStatus === "evaluating" ? "active" : ""}>{en ? "Validate" : "校验"}</span>
								<span className={requirement.state.stageStatus === "passed" ? "done" : requirement.state.stageStatus === "waiting_approval" ? "active" : ""}>{en ? "Confirm" : "确认交付"}</span>
							</section>

							<section className="proposal-section">
								<div className="section-title"><strong>{en ? "Task overview" : "任务概览"}</strong><code>v{requirement.state.aggregateVersion}</code></div>
								<p role="status">{requirementRunning ? en ? "Organising your material. You can return later to review it." : "正在整理资料，完成后可核对草稿。" : requirement.state.stageStatus === "passed" ? en ? "Approved. Export the current delivery below." : "当前版本已批准，可在下方导出交付物。" : requirement.state.stageStatus === "waiting_approval" ? en ? "Review the draft and approve or reject this version below." : "请核对草稿，在下方批准或拒绝当前版本。" : en ? "Review missing information and unconfirmed fields below, then generate the next version." : "请在下方补充缺失信息、核对待确认字段，再生成新版本。"}</p>
								<dl className="run-metadata">
									<div><dt>{en ? "Industry" : "行业"}</dt><dd>{en ? "Packaging" : "包装"}</dd></div>
									{requirement.state.facts.plan_source && <div><dt>{en ? "Source" : "资料来源"}</dt><dd>Plan v{requirement.state.facts.plan_source.sourceRef.split(":version:")[1]}</dd></div>}
									<div><dt>{en ? "Status" : "状态"}</dt><dd>{stageLabel(requirement.state.stageStatus)}</dd></div>
									<div><dt>{en ? "Version" : "版本"}</dt><dd>{requirement.state.currentProposal?.version ?? "—"}</dd></div>
									<div><dt>{en ? "Queue" : "队列"}</dt><dd>{requirement.job ? ({ queued: en ? "Queued" : "排队中", leased: en ? "Running" : "执行中", completed: en ? "Completed" : "已完成", cancelled: en ? "Cancelled" : "已取消", dead_letter: en ? "Failed" : "执行失败" }[requirement.job.status]) : "—"}</dd></div>
								</dl>
							</section>

							<details className="proposal-section diagnostics"><summary>{en ? "This run's details" : "本次运行详情"}</summary>
								<div className="section-title"><strong>{en ? "Product metrics" : "产品指标"}</strong><code>{requirement.metrics.schemaVersion}</code></div>
								<dl className="run-metadata">
									<div><dt>{en ? "Canonical match rate" : "Canonical 命中"}</dt><dd>{requirement.metrics.canonicalFactHitRate === null ? "—" : `${Math.round(requirement.metrics.canonicalFactHitRate * 100)}%`}</dd></div>
									<div><dt>{en ? "Fact confirmation" : "Fact 确认"}</dt><dd>{Math.round(requirement.metrics.confirmationRate * 100)}% ({requirement.metrics.confirmedRequiredFacts}/{requirement.metrics.requiredFacts})</dd></div>
									<div><dt>{en ? "Confirmed candidate accuracy" : "候选确认准确率"}</dt><dd>{requirement.metrics.confirmedCandidateAccuracy === null ? "—" : `${Math.round(requirement.metrics.confirmedCandidateAccuracy * 100)}%`}</dd></div>
									<div><dt>{en ? "Source coverage" : "来源覆盖"}</dt><dd>{requirement.metrics.sourceCoverageRate === null ? "—" : `${Math.round(requirement.metrics.sourceCoverageRate * 100)}%`}</dd></div>
									<div><dt>{en ? "Missing facts" : "缺失 Fact"}</dt><dd>{requirement.metrics.missingRequiredFacts.length}</dd></div>
									<div><dt>{en ? "Clarification rounds" : "澄清轮次"}</dt><dd>{requirement.metrics.clarificationRounds}</dd></div>
									<div><dt>Token (in / out)</dt><dd>{requirement.metrics.runtime.usage ? `${requirement.metrics.runtime.usage.inputTokens} / ${requirement.metrics.runtime.usage.outputTokens}` : "—"}</dd></div>
									<div><dt>{en ? "Runtime latency" : "Runtime 延迟"}</dt><dd>{requirement.metrics.runtime.latencyMs === null ? "—" : `${requirement.metrics.runtime.latencyMs} ms`}</dd></div>
									<div><dt>{en ? "Cost" : "成本"}</dt><dd>{requirement.metrics.runtime.costStatus === "unconfigured" ? en ? "Pricing not configured" : "未配置价格" : `$${requirement.metrics.runtime.costUsd}`}</dd></div>
									<div><dt>{en ? "Clarification questions" : "澄清问题"}</dt><dd>{requirement.metrics.clarificationQuestions}</dd></div>
									<div><dt>{en ? "Recoveries / failures" : "恢复 / 失败"}</dt><dd>{requirement.metrics.queue.recoveryCount} / {requirement.metrics.queue.totalFailureCount}</dd></div>
									<div><dt>{en ? "Tool failure rate" : "Tool 失败率"}</dt><dd>{requirement.metrics.runtime.toolFailureRate === null ? "—" : `${Math.round(requirement.metrics.runtime.toolFailureRate * 100)}%`}</dd></div>
								</dl>
							</details>

							<section className="proposal-section facts-card">
								<div className="section-title"><strong>{en ? "Review key information" : "核对关键信息"}</strong><span>{facts.length}</span></div>
								{facts.map((fact) => (
									<div className="fact-row" key={`${fact.key}-${fact.version}`}>
										<div>
											<small>{fieldLabel(fact.key)} · v{fact.version}</small>
											<strong>{String(fact.value)}{fact.unit ? ` ${fact.unit}` : ""}</strong>
											<small>{factStatus(fact.status)} · {fact.sourceType === "model_output" ? en ? "AI extracted" : "AI 提取" : fact.sourceType === "human_confirmation" ? en ? "Human confirmed" : "人工确认" : en ? "Human entered" : "人工输入"}</small>
										</div>
										{(fact.status === "suggested" || fact.status === "unverified") && (
											<div className="fact-actions">
												<button onClick={() => void resolveFact(fact.key, "rejected")} disabled={requirementBusy || requirementRunning || requirementTerminal}>{en ? "Reject" : "拒绝"}</button>
												<button onClick={() => void resolveFact(fact.key, "verified")} disabled={requirementBusy || requirementRunning || requirementTerminal}>{en ? "Confirm" : "确认"}</button>
											</div>
										)}
									</div>
								))}
								<form className="fact-form" onSubmit={(event) => void recordFact(event)}>
									<select value={factKey} onChange={(event) => { setFactKey(event.target.value); setFactValue(""); }} aria-label={en ? "Requirement field" : "需求字段"} disabled={requirementTerminal}><option value="">{en ? "Choose a field to add" : "选择要补充的字段"}</option>{fieldOptions.map((key) => <option key={key} value={key}>{fieldLabel(key)}</option>)}</select>
									<input value={factValue} type={factKey === "quantity" ? "number" : factKey === "target_delivery" ? "date" : "text"} min={factKey === "quantity" ? 1 : undefined} step={1} required onChange={(event) => setFactValue(event.target.value)} placeholder={factKey === "dimensions" ? en ? "Example: W 160 × H 230 + bottom 80 mm" : "例如：宽 160 × 高 230 + 底 80 mm" : en ? "Enter value" : "填写内容"} aria-label={en ? "Field value" : "字段内容"} disabled={requirementTerminal} />
									<input value={factUnit} onChange={(event) => setFactUnit(event.target.value)} placeholder={en ? "Unit (optional)" : "单位（可选）"} aria-label={en ? "Field unit" : "字段单位"} disabled={requirementTerminal} />
									<button type="submit" disabled={requirementBusy || requirementRunning || requirementTerminal || !factKey.trim() || !factValue.trim()}>{en ? "Add unverified information" : "添加待确认信息"}</button>
								</form>
								<small>{en ? "Confirm new information item by item. Changes make earlier briefs stale, so generate a new version." : "新增信息需逐项确认。修改后旧需求单会失效，请重新生成。"}</small>
							</section>

							{content && active && requirement.state.currentProposal && <DeliveryPreview conversationId={active.conversationId} versions={requirement.state.proposalVersions.map((item) => item.version)} currentVersion={requirement.state.currentProposal.version} revision={requirement.state.aggregateVersion} onSources={setParsedSources} language={language} />}

							{requirement.state.currentProposal && !content && (
								<section className="proposal-section invalid-artifact">
									<strong>{en ? "The artifact cannot be shown as a structured requirement brief" : "Artifact 无法作为结构化 Requirement Brief 展示"}</strong>
									<p>{en ? "The raw output is retained; Evaluation records the reason for failure." : "原始输出已经留存，Evaluation 会记录失败原因。"}</p>
								</section>
							)}

							{evaluation && (
								<section className={`proposal-section evaluation ${evaluation.passed ? "passed" : "failed"}`}>
									<div className="section-title"><strong>{en ? "Requirement validation" : "需求校验"}</strong><span>{evaluation.passed ? en ? "Passed" : "通过" : en ? "Failed" : "未通过"}</span></div>
									{evaluation.issues.length === 0
										? <p>{en ? `Structure and authoritative-state checks passed. ${evaluation.approvalEligible ? "Ready for approval." : "More information or confirmation is still needed."}` : `结构和权威状态检查通过。${evaluation.approvalEligible ? "可以审批。" : "仍需补充或确认 信息。"}`}</p>
										: evaluation.issues.map((issue) => <p key={issue.code}>{validationText(issue, language)}</p>)}
								</section>
							)}

							{requirement.state.approval?.status === "requested" && (
								<section className="proposal-section approval-card">
									<strong>{en ? "Confirm requirement brief" : "确认需求单"} · v{requirement.state.approval.artifactVersion}</strong>
									<p>{en ? "Approval applies only to the current version; future request changes invalidate it." : "审批只绑定当前版本；后续需求变化会使该审批失效。"}</p>
									<div className="approval-actions">
										<button onClick={() => void resolveRequirementApproval("rejected")} disabled={requirementBusy}>{en ? "Reject" : "拒绝"}</button>
										<button className="primary-action" onClick={() => void resolveRequirementApproval("approved")} disabled={requirementBusy}>{en ? "Approve current version" : "批准当前版本"}</button>
									</div>
								</section>
							)}

							{requirement.state.approval && requirement.state.approval.status !== "requested" && (
								<div className={`approval-result ${requirement.state.approval.status}`}>{en ? "Requirement brief confirmation: " : "需求单确认："}{statusFor(language, requirement.state.approval.status, ({ approved: "已批准", rejected: "已拒绝", superseded: "已失效", cancelled: "已取消" } as Record<string, string>)[requirement.state.approval.status] ?? requirement.state.approval.status)}</div>
							)}
							{requirement.job?.status === "dead_letter" && (
								<div className="proposal-failure">{errorText(requirement.job.lastFailure, language)}</div>
							)}

							{requirement.state.stageStatus !== "passed" && requirement.state.stageStatus !== "cancelled" && (
								<button className="secondary-action" onClick={() => void cancelRequirement()} disabled={requirementBusy}>{en ? "Cancel task" : "取消任务"}</button>
							)}
							{requirement.state.stageStatus === "passed" && <p className="cancelled-note">{en ? "The current version is approved. Start a new task for new requirements to preserve this delivery record." : "当前版本已批准。如有新需求，请新建任务，保留本次交付记录。"}</p>}
							{requirement.state.stageStatus === "cancelled" && (
								<div className="cancelled-note">{en ? "The request, facts, artifacts, and audit events are retained. Re-review continues from the existing version without deleting history." : "已保留需求、Fact、Artifact 与审计事件；重新审查会从现有版本继续，不会删除历史。"}</div>
							)}
							<button
								className="secondary-action"
								onClick={() => void startRequirement()}
								disabled={(!hasUserMessage && !requirement.state.facts.plan_source) || !realProvider || requirementBusy || sending || requirementRunning || requirement.state.stageStatus === "waiting_approval" || requirement.state.stageStatus === "passed"}
							>
								{requirementRunning
									? progressLabel(requirementActivity)
									: requirement.state.stageStatus === "cancelled"
										? en ? "Re-review requirement brief" : "重新审查需求单"
										: en ? "Generate a new version with the latest information" : "用最新信息生成新版本"}
							</button>
						</>
					)}
				</div>
				<div className="proposal-body" role="tabpanel" id="panel-knowledge" aria-labelledby="tab-knowledge" hidden={panelTab !== "knowledge"}>{active && reviewOpen && panelTab === "knowledge" ? <KnowledgePanel key={active.conversationId} conversationId={active.conversationId} language={language} /> : <p>{en ? "Select a task to inspect packaging evidence." : "选择任务后查看包装证据。"}</p>}</div>
				<div className="proposal-body" role="tabpanel" id="panel-models" aria-labelledby="tab-models" hidden={panelTab !== "models"}>{reviewOpen && panelTab === "models" && <ModelSettings language={language} />}{active && reviewOpen && panelTab === "models" ? <ModelMonitor key={active.conversationId} conversationId={active.conversationId} language={language} /> : !active && <p>{en ? "Create or select a conversation to view model calls." : "新建或选择会话后查看模型调用。"}</p>}</div>
				<div className="proposal-body" role="tabpanel" id="panel-files" aria-labelledby="tab-files" hidden={panelTab !== "files"}>{active ? <FileExplorer key={active.conversationId} conversationId={active.conversationId} language={language} onUseFile={(path) => { setDraft(en ? `Please read and help me work with this file: ${path}\nRequest:` : `请读取并协助处理这个文件：${path}\n处理要求：`); if (window.innerWidth < 1180) setReviewOpen(false); }} /> : <p>{en ? "Create or select a conversation to browse local files." : "新建或选择会话后浏览本机文件。"}</p>}</div>
			</aside>
			{pendingDelete && <DeleteConversationDialog title={pendingDelete.title} busy={deleting} error={deleteError} language={language}
				onCancel={() => setPendingDelete(undefined)} onConfirm={() => void deleteConversation()} />}
		</div>
	);
}

export default App;
