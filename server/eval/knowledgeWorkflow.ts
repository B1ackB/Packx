import { join } from "node:path";
import { InMemoryStageJobQueue } from "../../src/enterprise/stageJobQueue";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import { SkillRegistry } from "../../src/agent/skills";
import type { AgentModelProvider } from "../../src/agent/contracts";
import { createRequirementBrief } from "../../src/manufacturing/requirementBrief";
import { manufacturingSkills } from "../../src/manufacturing/skills";
import { normalizeParameter, packagingTerms } from "../../src/manufacturing/packagingKnowledge";
import { packagingRetrievalPolicy } from "../../src/manufacturing/knowledgeRetrieval";
import type { EvidenceHit, EvidenceResult } from "../../src/enterprise/knowledge";
import type { PlanScope, PlanWorkspace } from "../../src/enterprise/agentPlan";
import type { ConversationView } from "../../src/runtime/conversationContracts";
import { FileEnterpriseEventStore } from "../enterprise/fileEventStore";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { FileAgentStateStore } from "../runtime/fileAgentStateStore";
import { BlackxAgentRuntime } from "../runtime/agentRuntime";
import { createProjectSourceReadTool } from "../runtime/requirementTools";
import { ConversationApiController } from "../runtime/conversationApi";
import { RequirementBriefWorker } from "../manufacturing/requirementBriefWorker";
import { RequirementBriefWorkspaceApiController } from "../manufacturing/requirementBriefApi";
import { KnowledgeApi } from "../manufacturing/knowledgeApi";
import { createPackagingComparisonTool } from "../manufacturing/knowledgeComparison";
import { createCoffeeProductTool } from "../manufacturing/coffeeProductDirectory";
import { KnowledgeStore } from "../knowledge/store";
import { KnowledgeService } from "../knowledge/service";
import { LexicalEmbedding } from "../knowledge/embedding";
import { StageJobOutbox } from "../workers/stageJobOutbox";
import { StageJobScheduler } from "../workers/stageJobScheduler";

export function knowledgeWorkflow(root: string, readPlan?: (scope: PlanScope) => PlanWorkspace) {
	const context = { tenantId: "knowledge-demo", workspaceId: "coffee", actorId: "demo-user" };
	const events = new FileEnterpriseEventStore(join(root, "events.json"));
	const engine = new ProposalRunEngine(events, "requirement-brief");
	const sessions = new FileAgentStateStore(join(root, "agent"));
	const artifacts = new FileArtifactContentStore(join(root, "artifacts"));
	const queue = new InMemoryStageJobQueue();
	const store = new KnowledgeStore(join(root, "knowledge"), new LexicalEmbedding(packagingTerms), (block) => ({ ...block, parameters: block.parameters.map(normalizeParameter) }), () => "2026-09-17T10:00:00.000Z", packagingRetrievalPolicy);
	const knowledge = new KnowledgeService(store, queue);
	const provider: AgentModelProvider = { generate: async (request) => {
		const toolResult = request.messages.findLast((message) => message.role === "tool" && message.toolCallId === "selected-evidence");
		const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 };
		if (!toolResult) return { text: "", toolCalls: [{ id: "customer-source", name: "project_source_read", input: { sourceId: "customer-brief" } }, { id: "missing-dimensions", name: "knowledge_search", input: { query: "500 克咖啡袋的生产尺寸是什么？", mode: "hybrid", limit: 2 } }, { id: "selected-evidence", name: "knowledge_selected", input: {} }], usage };
		const searchResult = request.messages.findLast((message) => message.role === "tool" && message.toolCallId === "missing-dimensions");
		const evidence = searchResult ? JSON.parse(searchResult.content) as EvidenceResult : undefined;
		if (evidence?.assessment?.status !== "insufficient_evidence" || evidence.assessment.conclusionAllowed !== false) throw new Error("missing_evidence_assessment_in_runtime_context");
		const result = JSON.parse(toolResult.content) as { hits: EvidenceHit[] };
		const comparisonResult = request.messages.findLast((message) => message.role === "tool" && message.toolCallId === "parameter-comparison");
		if (result.hits.length && !comparisonResult) return { text: "", toolCalls: [{ id: "parameter-comparison", name: "packaging_compare_evidence", input: { left: { evidenceId: result.hits[0].evidenceId, parameterIndex: 0 }, right: { evidenceId: result.hits.at(-1)!.evidenceId, parameterIndex: result.hits.at(-1)!.parameters.length - 1 } } }], usage };
		if (comparisonResult && JSON.parse(comparisonResult.content).conclusionAllowed !== false) throw new Error("comparison_boundary_missing_in_context");
		const hit = result.hits?.find((h) => h.parameters.some((p) => p.name === "thickness"));
		const p = hit?.parameters.find((p) => p.name === "thickness");
		const candidate = createRequirementBrief({ industry: "print", title: "合成咖啡袋证据演示", customerGoal: "500 克咖啡袋；尺寸与实际型号适用性待确认", facts: hit && p ? [
			{ key: "material_thickness", value: p.originalValue, unit: p.originalUnit, version: 1, status: "verified", sourceType: "model_output", sourceRef: hit.evidenceId },
			// Intentional fabricated parameter: the Worker must reject unsupported evidence attribution.
			{ key: "dimensions", value: "150 x 200 mm", version: 1, status: "verified", sourceType: "model_output", sourceRef: hit.evidenceId },
		] : [], assumptions: ["离线脚本 Provider；不代表真实模型能力或供应商数据。"] });
		return { text: JSON.stringify(candidate), toolCalls: [], usage };
	} };
	const runtime = new BlackxAgentRuntime({ provider, skills: new SkillRegistry(manufacturingSkills), sessions, snapshots: sessions, traces: sessions, tools: [createProjectSourceReadTool(engine), ...knowledge.tools(engine), createPackagingComparisonTool(store), createCoffeeProductTool(store)], maxIterations: 4 });
	const conversations = new ConversationApiController(runtime, sessions, undefined, () => "conversation-knowledge-demo");
	const conversation = (conversations.create(context).body as { conversation: ConversationView }).conversation;
	const sessionScope = { ...context, runId: conversation.conversationId, sessionId: conversation.conversationId };
	const session = sessions.getSession(sessionScope)!;
	sessions.save(sessionScope, session.revision, [{ role: "user", content: "需要 500 克咖啡豆包装袋，请核对材料候选和缺失条件。", messageId: "brief", createdAt: "2026-09-17T10:00:00.000Z", pinned: true }], "2026-09-17T10:00:00.000Z");
	const outbox = new StageJobOutbox(engine, events, queue);
	const worker = new RequirementBriefWorker(engine, runtime, artifacts, undefined, undefined, knowledge);
	const scheduler = new StageJobScheduler(queue, { workerId: "demo-worker", handlers: { "knowledge-import": (lease, signal, guard) => knowledge.execute(lease, signal, guard), "requirement-brief": (lease, signal, guard) => worker.executeLease(lease, signal, guard) } });
	const requirements = new RequirementBriefWorkspaceApiController(conversations, engine, artifacts, outbox, scheduler, undefined, undefined, readPlan, knowledge);
	const api = new KnowledgeApi(knowledge, conversations, engine);
	return { context, conversationId: conversation.conversationId, store, knowledge, queue, scheduler, requirements, api, engine, sessions };
}
