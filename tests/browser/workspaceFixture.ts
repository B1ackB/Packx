import { expect, test as base } from "@playwright/test";
import type { PlanWorkspace } from "../../src/enterprise/agentPlan";
import type { MemoryView } from "../../src/enterprise/personalMemory";
import type { TaskCheckpointView } from "../../src/enterprise/taskCheckpoint";
import type { RuntimeHealth } from "../../src/runtime/contracts";
import type { ConversationView, RequirementBriefMetricsSeriesView, RequirementBriefWorkspaceView } from "../../src/runtime/conversationContracts";
import type { ConversationFilesView, LocalDirectoryListing, LocalFileLocations } from "../../src/runtime/conversationFiles";

// Synthetic UI data only: no backend, model, local files, or business commands.
const conversation: ConversationView = {
	conversationId: "tutorial-fixture", title: "Tutorial regression", preview: "Synthetic packaging request",
	updatedAt: "2026-10-01T00:00:00.000Z", revision: 1,
	messages: [{ messageId: "request-1", role: "user", content: "Synthetic request: 5000 coffee bags.", createdAt: "2026-10-01T00:00:00.000Z" }],
};
const requirement: RequirementBriefWorkspaceView = {
	runId: "tutorial-brief",
	state: {
		tenantId: "tutorial-tenant", workspaceId: "tutorial-workspace", runId: "tutorial-brief",
		aggregateVersion: 2, status: "running", stageStatus: "needs_input",
		facts: { quantity: { key: "quantity", value: 5000, unit: "个", version: 1, status: "unverified", sourceType: "user_input", sourceRef: "conversation://tutorial-fixture/request-1" } },
		factVersions: { quantity: 1 }, proposalVersions: [],
	},
	factSources: { quantity: { ref: "conversation://tutorial-fixture/request-1", label: "Synthetic customer request", status: "available", text: "Synthetic request: 5000 coffee bags." } },
	metrics: {
		schemaVersion: "requirement-brief-metrics.v1", canonicalFactHitRate: null, confirmedCandidateAccuracy: null, sourceCoverageRate: 1,
		canonicalCandidateFacts: 1, rawCandidateFacts: 1, confirmationRate: 0, confirmedRequiredFacts: 0, requiredFacts: 7,
		missingRequiredFacts: ["product_type", "quantity", "dimensions", "sales_region", "target_delivery", "delivery_destination", "artwork_status"],
		clarificationRounds: 0, clarificationQuestions: 0, artifactVersions: 0, cancelled: false,
		queue: { deliveryCount: 0, sliceCount: 0, failureCount: 0, totalFailureCount: 0, recoveryCount: 0, failureRate: null, recoveryRate: null },
		runtime: { latencyMs: null, usage: null, costUsd: null, costStatus: "unconfigured", toolExecutionCount: 0, toolFailureCount: 0, toolFailureRate: null },
	},
};
const metrics: RequirementBriefMetricsSeriesView = {
	schemaVersion: "requirement-brief-metrics-series.v1", generatedAt: conversation.updatedAt, points: [],
	totals: { runs: 1, passed: 0, needsInput: 1, waitingApproval: 0, cancelled: 0, active: 0, artifactVersions: 0, clarificationRounds: 0, clarificationQuestions: 0 },
	rates: { workflowCompletion: 0, evaluationPass: null, approvalEligibility: 0, stagePass: 0 },
	averages: { canonicalFactHitRate: null, confirmedCandidateAccuracy: null, sourceCoverageRate: 1, confirmationRate: 0, runtimeLatencyMs: null },
	queue: { deliveries: 0, slices: 0, failures: 0, recoveries: 0, failureRate: null, recoveryRate: null },
	runtime: { usage: null, toolExecutions: 0, toolFailures: 0, toolFailureRate: null, costUsd: null, costStatus: "unconfigured" },
};
const root = `/api/conversations/${conversation.conversationId}`;
export const responses: Record<string, unknown> = {
	"/api/local-session": { token: "synthetic-browser-session" },
	"/api/runtime/health": { adapter: "blackx-agent", online: true, providerStatus: "configured" } satisfies RuntimeHealth,
	"/api/conversations": { conversations: [{ ...conversation, messageCount: conversation.messages.length }] },
	"/api/requirement-brief/metrics": { requirementBriefMetrics: metrics },
	[root]: { conversation },
	[`${root}/attachments`]: { attachments: [] },
	[`${root}/background-tasks`]: { tasks: [] },
	[`${root}/cron-schedules`]: { schedules: [] },
	[`${root}/activity`]: {},
	[`${root}/plan`]: { plan: { revision: 0, mode: "execute", versions: [] } satisfies PlanWorkspace },
	[`${root}/requirement-brief`]: { requirementBrief: requirement },
	[`${root}/requirement-brief/templates`]: { library: [], templates: [], history: [] },
	[`${root}/files`]: { files: [], approvals: [] } satisfies ConversationFilesView,
	[`${root}/files/directories`]: { locations: { workingDirectory: "/synthetic-workspace" }, files: [] } satisfies LocalFileLocations,
	[`${root}/memory`]: { items: [], limits: { active: 16, items: 64, contentChars: 600 } } satisfies MemoryView,
	[`${root}/task-checkpoint`]: { revision: 0, versions: [], userMessageCount: 1, uncoveredUserMessages: 1, uncoveredChars: 44, sourceDigest: "synthetic-source", needsReview: false } satisfies TaskCheckpointView,
};

export const test = base.extend({
	page: async ({ page, baseURL, locale }, use) => {
		const unexpected: string[] = [];
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		await page.addInitScript((language) => localStorage.setItem("blackx-language", language), locale === "en-US" ? "en" : "zh");
		await page.route("**/*", async (route) => {
			const request = route.request(), url = new URL(request.url());
			if (url.origin !== baseURL || request.method() !== "GET") {
				unexpected.push(`${request.method()} ${url.href}`);
				return route.abort("blockedbyclient");
			}
			if (!url.pathname.startsWith("/api/")) return route.continue();
			if (!(url.pathname in responses)) {
				unexpected.push(`Unmocked API: ${url.pathname}`);
				return route.fulfill({ status: 500, json: { message: "Unexpected tutorial request" } });
			}
			if (url.pathname === `${root}/activity` && url.searchParams.has("stream")) {
				return route.fulfill({ contentType: "text/event-stream", body: "data: {}\n\n" });
			}
			if (url.pathname === `${root}/files/directories` && url.searchParams.has("path")) {
				return route.fulfill({ json: { directory: "/synthetic-workspace", entries: [], total: 0, truncated: false } satisfies LocalDirectoryListing });
			}
			return route.fulfill({ json: responses[url.pathname] });
		});
		await use(page);
		await page.unrouteAll({ behavior: "wait" });
		expect(unexpected, "Tutorial must not write data, call an unmocked API, or contact external services").toEqual([]);
		expect(pageErrors, "The workspace must not crash during the tutorial").toEqual([]);
	},
});
export { expect };
