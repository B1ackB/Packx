import { isDeepStrictEqual } from "node:util";
import type { AgentModelProvider } from "../../src/agent/contracts";
import { SkillRegistry } from "../../src/agent/skills";
import { InMemoryAgentStateStore } from "../../src/agent/state";
import type { EnterpriseEventStore, ProposalRunState, StageStatus } from "../../src/enterprise/contracts";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import type { StageJobQueue } from "../../src/enterprise/stageJobQueue";
import {
	requirementBriefFixtures,
	type RequirementBriefFixture,
} from "../../src/manufacturing/requirementBrief.fixtures";
import type { RequirementBriefEvaluation, RequirementBriefV1 } from "../../src/manufacturing/requirementBrief";
import { manufacturingSkills } from "../../src/manufacturing/skills";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { FileEnterpriseEventStore } from "../enterprise/fileEventStore";
import { FileStageJobQueue } from "../enterprise/fileStageJobQueue";
import { RequirementBriefWorker } from "../manufacturing/requirementBriefWorker";
import { BlackxAgentRuntime } from "../runtime/agentRuntime";
import { createProjectSourceReadTool } from "../runtime/requirementTools";
import { StageJobOutbox } from "../workers/stageJobOutbox";
import { StageJobScheduler } from "../workers/stageJobScheduler";

export interface M2RequirementWorkflowResult {
	fixtureId: string;
	industry: RequirementBriefFixture["industry"];
	expectedApprovalEligible: boolean;
	evaluationPassed: boolean;
	approvalEligible: boolean;
	finalStageStatus: StageStatus;
	artifactVersion: number;
	artifactMatched: boolean;
	queueJobs: number;
	queueDeliveries: number;
	toolReadSucceeded: boolean;
	toolExecutions: number;
	toolFailures: number;
	events: string[];
}

export interface M2RequirementWorkflowReport {
	contract: "blackx-m2-packaging-workflow-baseline-v3";
	passed: boolean;
	fixtures: number;
	approvalEligible: number;
	industries: { print: number };
	results: M2RequirementWorkflowResult[];
}

const tenantId = "m2-eval-tenant";
const workspaceId = "m2-eval-workspace";

function candidate(fixture: RequirementBriefFixture): RequirementBriefV1 {
	return {
		...fixture.artifact,
		facts: fixture.artifact.facts.map((fact) => ({
			...fact,
			status: "unverified",
			sourceType: "model_output",
			sourceRef: "runtime-output",
		})),
	};
}

function runtimeFor(
	fixture: RequirementBriefFixture,
	engine: ProposalRunEngine,
	state: InMemoryAgentStateStore,
): BlackxAgentRuntime {
	let call = 0;
	const provider: AgentModelProvider = {
		async generate(request) {
			if (request.outputSchema?.properties && typeof request.outputSchema.properties === "object" && "issues" in request.outputSchema.properties) return { text: JSON.stringify({ issues: [] }), toolCalls: [], usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 } };
			call += 1;
			return call === 1
				? {
					text: "",
					toolCalls: [{
						id: `read-${fixture.fixtureId}`,
						name: "project_source_read",
						input: { sourceId: "customer-brief" },
					}],
					usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 },
				}
				: {
					text: JSON.stringify(candidate(fixture)),
					toolCalls: [],
					usage: { inputTokens: 180, cachedInputTokens: 40, outputTokens: 120, reasoningOutputTokens: 0 },
				};
		},
	};
	return new BlackxAgentRuntime({
		provider,
		skills: new SkillRegistry(manufacturingSkills),
		tools: [createProjectSourceReadTool(engine)],
		sessions: state,
		snapshots: state,
		traces: state,
		maxIterations: 4,
	});
}

function seedRun(engine: ProposalRunEngine, fixture: RequirementBriefFixture): ProposalRunState {
	const scope = { tenantId, workspaceId, runId: `m2-${fixture.fixtureId}` };
	const envelope = (commandId: string, expectedVersion: number) => ({
		...scope,
		actorId: "m2-eval-seed",
		commandId,
		correlationId: `m2-eval:${fixture.fixtureId}`,
		expectedVersion,
	});
	let state = engine.create(envelope(`${fixture.fixtureId}:create`, 0));
	state = engine.startProposal(envelope(`${fixture.fixtureId}:start`, state.aggregateVersion));
	const facts = [{
		key: "customer_brief",
		version: 1,
		value: fixture.input,
		status: "unverified" as const,
		sourceType: "user_input" as const,
		sourceRef: `fixture:${fixture.fixtureId}`,
	}, {
		key: "industry",
		version: 1,
		value: fixture.industry,
		status: "verified" as const,
		sourceType: "human_confirmation" as const,
		sourceRef: `fixture:${fixture.fixtureId}:industry`,
	}, ...fixture.artifact.facts];
	for (const fact of facts) {
		state = engine.recordFactVersion({
			...envelope(`${fixture.fixtureId}:fact:${fact.key}`, state.aggregateVersion),
			factKey: fact.key,
			factVersion: fact.version,
			value: fact.value,
			unit: fact.unit,
			status: fact.status,
			sourceType: fact.sourceType,
			sourceRef: fact.sourceRef,
		});
	}
	return state;
}

async function runFixture(
	fixture: RequirementBriefFixture,
	engine: ProposalRunEngine,
	store: EnterpriseEventStore,
	queue: StageJobQueue,
	artifacts: FileArtifactContentStore,
): Promise<M2RequirementWorkflowResult> {
	let state = seedRun(engine, fixture);
	const scope = { tenantId, workspaceId, runId: state.runId };
	const runtimeState = new InMemoryAgentStateStore();
	const worker = new RequirementBriefWorker(engine, runtimeFor(fixture, engine, runtimeState), artifacts);
	const outbox = new StageJobOutbox(engine, store, queue);
	const scheduler = new StageJobScheduler(queue, {
		workerId: `m2-worker-${fixture.fixtureId}`,
		handlers: { "requirement-brief": (lease, signal, guard) => worker.executeLease(lease, signal, guard) },
		dispatchOutbox: () => outbox.dispatchOne(),
	});
	const request = {
		...scope,
		commandId: `${fixture.fixtureId}:execute`,
		correlationId: `m2-eval:${fixture.fixtureId}`,
		expectedVersion: state.aggregateVersion,
	};
	outbox.requestStage(request, { stageId: "requirement-brief", jobPrefix: "requirement" });
	const execution = await scheduler.runNext();
	if (execution.status !== "completed") {
		throw new Error(`${fixture.fixtureId} Worker did not complete: ${execution.status}`);
	}
	state = engine.load(scope);
	const artifactVersion = state.currentProposal?.version;
	if (!artifactVersion || !state.evaluation) {
		throw new Error(`${fixture.fixtureId} did not persist ArtifactVersion and Evaluation`);
	}
	const evaluation = artifacts.readJson({
		...scope,
		artifactId: "requirement-brief-evaluation",
		artifactVersion,
	}) as RequirementBriefEvaluation;
	const artifact = artifacts.readJson({
		...scope,
		artifactId: "requirement-brief",
		artifactVersion,
	});
	const checkpoint = artifacts.readJson({
		...scope,
		artifactId: "requirement-runtime-checkpoint",
		artifactVersion,
	}) as { toolExecutionCount?: number; toolFailureCount?: number };
	if (fixture.expectedApprovalEligible) {
		if (!state.approval) throw new Error(`${fixture.fixtureId} did not request Approval`);
		state = engine.resolveApproval({
			...scope,
			actorId: "m2-eval-approver",
			commandId: `${fixture.fixtureId}:approval`,
			correlationId: `m2-eval:${fixture.fixtureId}`,
			expectedVersion: state.aggregateVersion,
			approvalId: state.approval.approvalId,
			artifactId: state.approval.artifactId,
			artifactVersion: state.approval.artifactVersion,
			decision: "approved",
		});
		outbox.requestStage({
			...scope,
			commandId: `${fixture.fixtureId}:gate`,
			correlationId: `m2-eval:${fixture.fixtureId}`,
			expectedVersion: state.aggregateVersion,
		}, { stageId: "requirement-brief", jobPrefix: "requirement" });
		const gate = await scheduler.runNext();
		if (gate.status !== "completed") throw new Error(`${fixture.fixtureId} Approval Gate did not complete`);
		state = engine.load(scope);
	}
	const jobs = queue.list().filter((job) =>
		job.tenantId === tenantId && job.workspaceId === workspaceId && job.runId === state.runId,
	);
	const traces = runtimeState.listTraces(scope);
	return {
		fixtureId: fixture.fixtureId,
		industry: fixture.industry,
		expectedApprovalEligible: fixture.expectedApprovalEligible,
		evaluationPassed: evaluation.passed,
		approvalEligible: evaluation.approvalEligible,
		finalStageStatus: state.stageStatus,
		artifactVersion,
		artifactMatched: isDeepStrictEqual(artifact, fixture.artifact),
		queueJobs: jobs.length,
		queueDeliveries: jobs.reduce((total, job) => total + job.deliveryCount, 0),
		toolReadSucceeded: traces.some((trace) => trace.events.some((event) =>
			event.type === "tool.completed" && event.tool === "project_source_read" && event.status === "succeeded",
		)),
		toolExecutions: checkpoint.toolExecutionCount ?? 0,
		toolFailures: checkpoint.toolFailureCount ?? 0,
		events: engine.readEvents(scope).map((event) => event.data.type),
	};
}

export async function runM2RequirementWorkflow(directory: string): Promise<M2RequirementWorkflowReport> {
	const store = new FileEnterpriseEventStore(`${directory}/events.json`);
	const engine = new ProposalRunEngine(store, "requirement-brief");
	const queue = new FileStageJobQueue(`${directory}/stage-jobs.json`);
	const artifacts = new FileArtifactContentStore(`${directory}/artifacts`);
	const results: M2RequirementWorkflowResult[] = [];
	for (const fixture of requirementBriefFixtures) {
		results.push(await runFixture(fixture, engine, store, queue, artifacts));
	}
	const passed = results.every((result) =>
		result.evaluationPassed &&
		result.approvalEligible === result.expectedApprovalEligible &&
		result.finalStageStatus === (result.expectedApprovalEligible ? "passed" : "needs_input") &&
		result.artifactVersion === 1 &&
		result.artifactMatched &&
		result.queueJobs === (result.expectedApprovalEligible ? 2 : 1) &&
		result.queueDeliveries === result.queueJobs &&
		result.toolReadSucceeded &&
		result.toolExecutions === 1 &&
		result.toolFailures === 0 &&
		result.events.includes("artifact.version_created") &&
		result.events.includes("evaluation.completed") &&
		(result.expectedApprovalEligible
			? result.events.includes("approval.requested") && result.events.includes("approval.resolved")
			: result.events.includes("stage.input_required")),
	);
	return {
		contract: "blackx-m2-packaging-workflow-baseline-v3",
		passed,
		fixtures: results.length,
		approvalEligible: results.filter((result) => result.approvalEligible).length,
		industries: {
			print: results.filter((result) => result.industry === "print").length,
		},
		results,
	};
}
