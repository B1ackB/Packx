import type { ProposalRunState } from "../enterprise/contracts";
import type { RuntimeUsage } from "./contracts";

export interface RuntimeActivity {
	executionId: string;
	phase: "starting" | "model" | "tool" | "completed" | "paused" | "failed";
	updatedAt: string;
	iteration?: number;
	partialText?: string;
	tool?: string;
}

export interface ConversationMessage {
	messageId: string;
	role: "user" | "assistant";
	content: string;
	createdAt: string;
	attachments?: Array<{
		name: string;
		mediaType: string;
		sourceRef: string;
	}>;
}

export interface ConversationView {
	historyStatus?: "complete" | "legacy_partial";
	nameRevision?: number;
	searchText?: string;
	conversationId: string;
	title: string;
	preview: string;
	updatedAt: string;
	revision: number;
	messages: ConversationMessage[];
}

export interface ConversationSummary extends Omit<ConversationView, "revision" | "messages"> {
	messageCount: number;
}

export interface ConversationAttachment {
	withdrawal?: { requestId: string; actorId: string; reason: string; at: string; sha256: string };
	attachmentId: string;
	conversationId: string;
	name: string;
	mediaType: string;
	size: number;
	sha256: string;
	kind: "image" | "text" | "file";
	modelInput: "image" | "text_extracted" | "metadata_only";
	sourceRef: string;
	createdAt: string;
}

export type BackgroundTaskStatus = "queued" | "leased" | "completed" | "dead_letter" | "cancelled";

export interface BackgroundTaskView {
	taskId: string;
	conversationId: string;
	messageId: string;
	status: BackgroundTaskStatus;
	createdAt: string;
	updatedAt: string;
	deliveryCount: number;
	failureCount: number;
	lastFailure?: {
		code: string;
		message: string;
		retryable: boolean;
		at: string;
	};
}

export interface CronScheduleView {
	scheduleId: string;
	conversationId: string;
	name: string;
	expression: string;
	timezone: string;
	status: "active" | "paused" | "completed";
	runCount: number;
	maxRuns: number;
	nextRunAt: string;
	lastRunAt?: string;
}

export interface ProposalWorkspaceView {
	runId: string;
	state: ProposalRunState;
	artifact?: {
		content: unknown;
	};
	evaluation?: {
		report: unknown;
	};
	job?: {
		jobId: string;
		leaseExpiresAt?: string;
		status: "queued" | "leased" | "completed" | "dead_letter" | "cancelled";
		failureCount: number;
		lastFailure?: {
			code: string;
			message: string;
		};
	};
}

export interface RequirementBriefMetricsView {
	schemaVersion: "requirement-brief-metrics.v1";
	canonicalFactHitRate: number | null;
	confirmedCandidateAccuracy: number | null;
	sourceCoverageRate: number | null;
	canonicalCandidateFacts: number;
	rawCandidateFacts: number;
	confirmationRate: number;
	confirmedRequiredFacts: number;
	requiredFacts: number;
	missingRequiredFacts: string[];
	clarificationRounds: number;
	clarificationQuestions: number;
	artifactVersions: number;
	cancelled: boolean;
	queue: {
		deliveryCount: number;
		sliceCount: number;
		failureCount: number;
		totalFailureCount: number;
		recoveryCount: number;
		failureRate: number | null;
		recoveryRate: number | null;
	};
	runtime: {
		latencyMs: number | null;
		usage: RuntimeUsage | null;
		costUsd: number | null;
		costStatus: "unconfigured";
		toolExecutionCount: number;
		toolFailureCount: number;
		toolFailureRate: number | null;
	};
}

export interface RequirementBriefWorkspaceView extends ProposalWorkspaceView {
	readOnlyReason?: string;
	metrics: RequirementBriefMetricsView;
	factSources?: Record<string, RequirementSourceView>;
	proposalSources?: Record<string, RequirementSourceView>;
}

export interface RequirementSourceView {
	ref: string;
	label: string;
	status: "available" | "unavailable" | "withdrawn";
	text?: string;
	truncated?: boolean;
}

export interface RequirementBriefRunMetricsPoint {
	runId: string;
	conversationId: string;
	industry?: "print";
	stageStatus: ProposalRunState["stageStatus"];
	evaluationPassed: boolean | null;
	approvalEligible: boolean;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	metrics: RequirementBriefMetricsView;
}

export interface RequirementBriefMetricsSeriesView {
	schemaVersion: "requirement-brief-metrics-series.v1";
	generatedAt: string;
	points: RequirementBriefRunMetricsPoint[];
	totals: {
		runs: number;
		passed: number;
		needsInput: number;
		waitingApproval: number;
		cancelled: number;
		active: number;
		artifactVersions: number;
		clarificationRounds: number;
		clarificationQuestions: number;
	};
	rates: {
		workflowCompletion: number | null;
		evaluationPass: number | null;
		approvalEligibility: number | null;
		stagePass: number | null;
	};
	averages: {
		canonicalFactHitRate: number | null;
		confirmedCandidateAccuracy: number | null;
		sourceCoverageRate: number | null;
		confirmationRate: number | null;
		runtimeLatencyMs: number | null;
	};
	queue: {
		deliveries: number;
		slices: number;
		failures: number;
		recoveries: number;
		failureRate: number | null;
		recoveryRate: number | null;
	};
	runtime: {
		usage: RuntimeUsage | null;
		toolExecutions: number;
		toolFailures: number;
		toolFailureRate: number | null;
		costUsd: number | null;
		costStatus: "unconfigured";
	};
}
