import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { requiredRequirementFacts } from "../../src/manufacturing/requirementBrief";
import type {
	ConversationView,
	RequirementBriefMetricsSeriesView,
	RequirementBriefWorkspaceView,
} from "../../src/runtime/conversationContracts";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { FileEnterpriseEventStore } from "../enterprise/fileEventStore";
import { ConversationApiController } from "../runtime/conversationApi";
import { FileConversationAttachmentStore } from "../runtime/conversationAttachments";
import { FakeAgentRuntime } from "../runtime/fakeAgentRuntime";
import { FileAgentStateStore } from "../runtime/fileAgentStateStore";
import { createProjectSourceReadTool } from "../runtime/requirementTools";
import { StageJobOutbox } from "../workers/stageJobOutbox";
import { StageJobScheduler } from "../workers/stageJobScheduler";
import { RequirementBriefWorkspaceApiController } from "./requirementBriefApi";
import { RequirementBriefWorker } from "./requirementBriefWorker";

const directories: string[] = [];
const context = {
	tenantId: "tenant-requirement",
	workspaceId: "workspace-requirement",
	actorId: "user-requirement",
};

function requirement(response: { body: unknown }): RequirementBriefWorkspaceView {
	return (response.body as { requirementBrief: RequirementBriefWorkspaceView }).requirementBrief;
}

function harness() {
	const directory = mkdtempSync(join(tmpdir(), "blackx-requirement-workspace-"));
	directories.push(directory);
	const sessions = new FileAgentStateStore(join(directory, "agent"));
	const eventPath = join(directory, "events.json");
	const eventStore = new FileEnterpriseEventStore(eventPath);
	const engine = new ProposalRunEngine(eventStore, "requirement-brief");
	const attachments = new FileConversationAttachmentStore(join(directory, "attachments"));
	const runtime = new FakeAgentRuntime({
		sessions,
		snapshots: sessions,
		tools: [createProjectSourceReadTool(engine, attachments)],
		resolveImageAttachment: async (scope, attachment) => attachments.resolveImage(scope, attachment),
	});
	let conversationSequence = 0;
	const conversations = new ConversationApiController(
		runtime,
		sessions,
		() => "2026-09-04T00:00:00.000Z",
		() => `requirement-conversation-${conversationSequence += 1}`,
	);
	const created = (conversations.create(context).body as { conversation: ConversationView }).conversation;
	const stored = sessions.getSession({
		...context,
		runId: created.conversationId,
		sessionId: created.conversationId,
	})!;
	sessions.save(
		{ ...context, runId: created.conversationId, sessionId: created.conversationId },
		stored.revision,
		[{
			role: "user",
			content: "需要 5000 个咖啡豆包装袋，送到香港。",
			messageId: "requirement-message",
			createdAt: "2026-09-04T00:01:00.000Z",
			pinned: true,
		}],
		"2026-09-04T00:01:00.000Z",
	);
	const artifacts = new FileArtifactContentStore(join(directory, "artifacts"));
	const queue = new InMemoryStageJobQueue();
	const outbox = new StageJobOutbox(engine, eventStore, queue);
	const worker = new RequirementBriefWorker(engine, runtime, artifacts, attachments);
	const scheduler = new StageJobScheduler(queue, {
		workerId: "requirement-workspace-test",
		handlers: { "requirement-brief": (lease, signal, guard) => worker.executeLease(lease, signal, guard) },
	});
	return {
		conversationId: created.conversationId,
		conversations,
		controller: new RequirementBriefWorkspaceApiController(
			conversations,
			engine,
			artifacts,
			outbox,
			scheduler,
			attachments,
		),
		attachments,
		eventPath,
		sessions,
		scheduler,
	};
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("RequirementBriefWorkspaceApiController", () => {
	it("rejects new furniture requests and fields before creating any workflow", () => {
		const { controller, conversationId } = harness();
		expect(controller.start(context, conversationId, { requestId: "retired", industry: "furniture" })).toMatchObject({ status: 400 });
		expect(requirement(controller.get(context, conversationId))).toBeNull();
		controller.start(context, conversationId, { requestId: "packaging", industry: "print" });
		const before = requirement(controller.get(context, conversationId)).state.aggregateVersion;
		expect(controller.recordFact(context, conversationId, { requestId: "retired-field", key: "installation_required", value: true })).toMatchObject({ status: 400 });
		expect(requirement(controller.get(context, conversationId)).state.aggregateVersion).toBe(before);
	});

	it("keeps a legacy industry read-only and refuses queued execution without rewriting its facts", async () => {
		const { controller, conversationId, eventPath, scheduler } = harness();
		const started = requirement(controller.start(context, conversationId, { requestId: "legacy-seed", industry: "print" }));
		const engine = new ProposalRunEngine(new FileEnterpriseEventStore(eventPath), "requirement-brief");
		engine.recordFactVersion({ ...context, runId: started.runId, commandId: "legacy-industry", correlationId: "legacy-import", expectedVersion: started.state.aggregateVersion,
			factKey: "industry", factVersion: 2, value: "furniture", status: "verified", sourceType: "human_confirmation", sourceRef: "legacy:confirmed" }, { duringExecution: true });
		const before = engine.load(started.state).aggregateVersion;
		expect(requirement(controller.get(context, conversationId)).readOnlyReason).toContain("包装");
		expect(controller.start(context, conversationId, { requestId: "convert", industry: "print" }).status).toBe(400);
		expect(controller.recordFact(context, conversationId, { requestId: "edit", key: "quantity", value: 100 }).status).toBe(400);
		expect(controller.resolveFact(context, conversationId, "quantity", { requestId: "confirm", decision: "verified" }).status).toBe(400);
		expect(controller.resolveApproval(context, conversationId, { requestId: "approve", decision: "approved" }).status).toBe(400);
		expect(controller.delivery(context, conversationId, 1).status).toBe(410);
		expect(await scheduler.runNext()).toMatchObject({ status: "dead_letter" });
		expect(engine.load(started.state).aggregateVersion).toBe(before);
		expect(engine.load(started.state).facts.industry.value).toBe("furniture");
		expect((controller.metricsSeries(context).body as { requirementBriefMetrics: RequirementBriefMetricsSeriesView }).requirementBriefMetrics.totals.runs).toBe(0);
		expect(controller.cancel(context, conversationId, { requestId: "cancel-legacy" }).status).toBe(200);
	});
	it("persists needs-input state, confirmed Facts, Artifact versions, Evaluation, and Approval", async () => {
		const { controller, conversationId, eventPath, scheduler } = harness();

		expect(controller.get(context, conversationId)).toEqual({
			status: 200,
			body: { requirementBrief: null },
		});
		const started = controller.start(context, conversationId, {
			requestId: "requirement-start-1",
			industry: "print",
		});
		expect(requirement(started).state.facts.industry).toMatchObject({
			value: "print",
			status: "verified",
			sourceType: "enterprise_source",
			sourceRef: "domain:print:packaging",
		});
		const firstRun = await scheduler.runNext();
		expect(firstRun).toMatchObject({ status: "completed" });
		const needsInput = requirement(controller.get(context, conversationId));
		expect(needsInput).toMatchObject({
			state: {
				stageStatus: "needs_input",
				currentProposal: { artifactId: "requirement-brief", version: 1 },
				evaluation: { passed: true },
			},
			artifact: {
				content: {
					schemaVersion: "requirement-brief.v1",
					nextAction: "clarify",
				},
			},
			metrics: {
				schemaVersion: "requirement-brief-metrics.v1",
				canonicalFactHitRate: null,
				confirmationRate: 0,
				confirmedRequiredFacts: 0,
				requiredFacts: 7,
				clarificationRounds: 1,
				artifactVersions: 1,
				cancelled: false,
				queue: { deliveryCount: 1, sliceCount: 1, recoveryCount: 0 },
				runtime: { usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null, costStatus: "unconfigured" },
			},
		});
		expect(needsInput.metrics.missingRequiredFacts).toEqual(requiredRequirementFacts.print);
		expect(needsInput.metrics.runtime.latencyMs).toEqual(expect.any(Number));

		const restoredEngine = new ProposalRunEngine(
			new FileEnterpriseEventStore(eventPath),
			"requirement-brief",
		);
		const restored = restoredEngine.load({
			tenantId: context.tenantId,
			workspaceId: context.workspaceId,
			runId: needsInput.runId,
		});
		expect(restored).toMatchObject({
			aggregateVersion: needsInput.state.aggregateVersion,
			stageStatus: "needs_input",
			currentProposal: { version: 1 },
		});

		for (const key of requiredRequirementFacts.print) {
			controller.recordFact(context, conversationId, {
				requestId: `record-${key}`,
				key,
				value: key === "quantity" ? 5_000 : `confirmed-${key}`,
			});
			const resolved = controller.resolveFact(context, conversationId, key, {
				requestId: `verify-${key}`,
				decision: "verified",
			});
			expect(requirement(resolved).state.facts[key]).toMatchObject({
				version: 2,
				status: "verified",
				sourceType: "human_confirmation",
			});
		}

		controller.start(context, conversationId, {
			requestId: "requirement-start-2",
			industry: "print",
		});
		const secondRun = await scheduler.runNext();
		expect(secondRun).toMatchObject({ status: "completed" });
		const waiting = requirement(controller.get(context, conversationId));
		expect(waiting).toMatchObject({
			state: {
				stageStatus: "waiting_approval",
				currentProposal: { version: 2, freshness: "fresh" },
				evaluation: { passed: true, artifactVersion: 2 },
				approval: { status: "requested", artifactVersion: 2 },
			},
			artifact: { content: { nextAction: "ready_for_approval" } },
			evaluation: { report: { approvalEligible: true } },
			metrics: {
				confirmationRate: 1,
				confirmedRequiredFacts: 7,
				missingRequiredFacts: [],
				clarificationRounds: 1,
				artifactVersions: 2,
			},
		});

		controller.resolveApproval(context, conversationId, {
			requestId: "requirement-approval-1",
			decision: "approved",
		});
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
		expect(requirement(controller.get(context, conversationId))).toMatchObject({
			state: {
				status: "completed",
				stageStatus: "passed",
				approval: { status: "approved", artifactVersion: 2 },
			},
			metrics: {
				artifactVersions: 2,
				confirmationRate: 1,
				queue: { deliveryCount: 3, sliceCount: 3, totalFailureCount: 0 },
			},
		});
		expect(controller.delivery(context, conversationId, 1)).toMatchObject({ status: 200, body: { delivery: { version: 1, status: "stale" } } });
		expect(controller.delivery(context, conversationId, 2)).toMatchObject({ status: 200, body: { delivery: { version: 2, status: "approved", approval: { artifactVersion: 2 } } } });
		expect(controller.delivery(context, conversationId, 999).status).toBe(404);
		expect(controller.delivery({ ...context, tenantId: "other" }, conversationId, 2).status).toBe(404);
		const series = (controller.metricsSeries(context).body as {
			requirementBriefMetrics: RequirementBriefMetricsSeriesView;
		}).requirementBriefMetrics;
		expect(series).toMatchObject({
			schemaVersion: "requirement-brief-metrics-series.v1",
			totals: {
				runs: 1,
				passed: 1,
				needsInput: 0,
				artifactVersions: 2,
				clarificationRounds: 1,
				clarificationQuestions: 7,
			},
			rates: { workflowCompletion: 1, evaluationPass: 1, approvalEligibility: 1, stagePass: 1 },
			averages: {
				confirmedCandidateAccuracy: null,
				sourceCoverageRate: 1,
			},
			queue: {
				deliveries: 3,
				slices: 3,
				failures: 0,
				recoveries: 0,
				failureRate: 0,
				recoveryRate: 0,
			},
			runtime: { toolExecutions: 0, toolFailures: 0, toolFailureRate: null },
		});
		expect(series.points).toHaveLength(1);
		expect(series.points[0]).toMatchObject({
			conversationId,
			industry: "print",
			stageStatus: "passed",
			evaluationPassed: true,
			approvalEligible: true,
			completedAt: expect.any(String),
		});
	});

	it("builds a tenant-scoped time series across Requirement Runs", async () => {
		const { controller, conversationId, conversations, scheduler, sessions } = harness();
		controller.start(context, conversationId, { requestId: "series-run-1", industry: "print" });
		controller.cancel(context, conversationId, { requestId: "series-cancel-1" });

		const second = (conversations.create(context).body as { conversation: ConversationView }).conversation;
		const stored = sessions.getSession({
			...context,
			runId: second.conversationId,
			sessionId: second.conversationId,
		})!;
		sessions.save(
			{ ...context, runId: second.conversationId, sessionId: second.conversationId },
			stored.revision,
			[{
				role: "user",
				content: "需要一批瓦楞包装纸箱，交货地点待确认。",
				messageId: "series-message-2",
				createdAt: "2026-09-04T00:02:00.000Z",
				pinned: true,
			}],
			"2026-09-04T00:02:00.000Z",
		);
		controller.start(context, second.conversationId, { requestId: "series-run-2", industry: "print" });
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });

		const series = (controller.metricsSeries(context).body as {
			requirementBriefMetrics: RequirementBriefMetricsSeriesView;
		}).requirementBriefMetrics;
		expect(series.totals).toMatchObject({ runs: 2, cancelled: 1, needsInput: 1 });
		expect(series.points).toHaveLength(2);
		expect(new Set(series.points.map((point) => point.conversationId))).toEqual(
			new Set([conversationId, second.conversationId]),
		);
		expect(series.points.every((point) => Number.isFinite(Date.parse(point.startedAt)))).toBe(true);

		const isolated = (controller.metricsSeries({ ...context, tenantId: "other-tenant" }).body as {
			requirementBriefMetrics: RequirementBriefMetricsSeriesView;
		}).requirementBriefMetrics;
		expect(isolated.totals.runs).toBe(0);
		expect(isolated.points).toEqual([]);
	});

	it("rejects an invalid industry and does not expose another tenant's Run", () => {
		const { controller, conversationId } = harness();
		expect(controller.start(context, conversationId, {
			requestId: "invalid-industry",
			industry: "other",
		})).toMatchObject({ status: 400 });
		controller.start(context, conversationId, {
			requestId: "valid-industry",
			industry: "print",
		});
		expect(controller.get({ ...context, tenantId: "other-tenant" }, conversationId)).toEqual({
			status: 404,
			body: { code: "conversation_not_found" },
		});
	});

	it("cancels a queued Requirement Run idempotently and persists the terminal state", async () => {
		const { controller, conversationId, eventPath, scheduler } = harness();
		controller.start(context, conversationId, {
			requestId: "cancel-start",
			industry: "print",
		});
		const cancelled = controller.cancel(context, conversationId, { requestId: "cancel-request" });
		expect(requirement(cancelled)).toMatchObject({
			state: { status: "cancelled", stageStatus: "cancelled" },
			job: { status: "cancelled" },
			metrics: {
				cancelled: true,
				queue: { deliveryCount: 0, recoveryCount: 0 },
			},
		});
		const repeated = controller.cancel(context, conversationId, { requestId: "cancel-request" });
		expect(requirement(repeated).state.aggregateVersion).toBe(requirement(cancelled).state.aggregateVersion);
		expect(await scheduler.runNext()).toEqual({ status: "idle" });

		const cancellationRestoreEngine = new ProposalRunEngine(
			new FileEnterpriseEventStore(eventPath),
			"requirement-brief",
		);
		const restored = cancellationRestoreEngine.load({
			tenantId: context.tenantId,
			workspaceId: context.workspaceId,
			runId: requirement(cancelled).runId,
		});
		expect(restored).toMatchObject({ status: "cancelled", stageStatus: "cancelled" });

		const reopened = controller.start(context, conversationId, {
			requestId: "reopen-request",
			industry: "print",
		});
		expect(requirement(reopened)).toMatchObject({
			state: { status: "running", stageStatus: "running" },
			job: { status: "queued" },
		});
		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
		const reviewed = requirement(controller.get(context, conversationId));
		expect(reviewed).toMatchObject({
			state: { stageStatus: "needs_input", currentProposal: { version: 1 } },
			metrics: { cancelled: false },
		});
		const eventTypes = cancellationRestoreEngine.readEvents(reviewed.state).map((event) => event.data.type);
		expect(eventTypes.indexOf("stage.cancelled")).toBeLessThan(eventTypes.lastIndexOf("stage.restarted"));
	});

	it("versions the current attachment set into Requirement source lineage", () => {
		const { attachments, controller, conversationId } = harness();
		attachments.put({
			...context,
			conversationId,
		}, {
			requestId: "attachment-upload",
			name: "customer-notes.txt",
			mediaType: "text/plain",
			content: Buffer.from("delivery date: 2026-10-01"),
		});

		const started = requirement(controller.start(context, conversationId, {
			requestId: "requirement-with-attachment",
			industry: "print",
		}));

		expect(started.state.facts.customer_attachments).toMatchObject({
			version: 1,
			status: "unverified",
			sourceType: "source_document",
		});
		expect(started.state.facts.customer_attachments.sourceRef).toContain(
			`conversation:${conversationId}:attachments:`,
		);
	});

	it("passes the frozen image snapshot through the Requirement Worker without storing Base64", async () => {
		const { attachments, controller, conversationId, scheduler, sessions } = harness();
		attachments.put({
			...context,
			conversationId,
		}, {
			requestId: "reference-upload",
			name: "reference.png",
			mediaType: "image/png",
			content: Buffer.from("reference-image"),
		});
		const started = requirement(controller.start(context, conversationId, {
			requestId: "requirement-with-image",
			industry: "print",
		}));

		expect(await scheduler.runNext()).toMatchObject({ status: "completed" });
		const runtimeSession = sessions.listSessions(context).find((session) => session.runId === started.runId && session.messages.some((message) => message.attachments?.length));
		const storedAttachments = runtimeSession?.messages.flatMap((message) => message.attachments ?? []) ?? [];
		expect(storedAttachments).toEqual([
			expect.objectContaining({
				name: "reference.png",
				mediaType: "image/png",
			}),
		]);
		expect(storedAttachments.every((attachment) => attachment.data === undefined)).toBe(true);
	});
});
