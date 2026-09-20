import { randomUUID } from "node:crypto";
import { loadCoffeeCorpus } from "./coffeeOpenCorpus";
import { coffeeProductManifests, findCoffeeProducts } from "./coffeeProductDirectory";
import { compareEvidence } from "./knowledgeComparison";
import { KnowledgeError, type EvidenceSelection, type KnowledgeImport } from "../../src/enterprise/knowledge";
import { coffeeEvidenceReview } from "../../src/manufacturing/packagingKnowledge";
import { coffeeKnowledgeFixtures } from "../../src/manufacturing/knowledgeFixtures";
import { knowledgeCoverage, knowledgeSources } from "../../src/manufacturing/knowledgeSources";
import type { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import type { AssetInspectionRecord } from "../../src/runtime/assetInspection";
import { workspaceRunId } from "../enterprise/proposalWorkspaceApi";
import type { KnowledgeService } from "../knowledge/service";
import { digest } from "../knowledge/store";
import { assertImport, knowledgeId } from "../knowledge/validation";
import type { ConversationApiController, ConversationApiContext } from "../runtime/conversationApi";

export class KnowledgeApi {
	constructor(private readonly knowledge: KnowledgeService, private readonly conversations: ConversationApiController, private readonly engine: ProposalRunEngine, private readonly inspect?: (scope: { tenantId: string; workspaceId: string; actorId: string; runId: string }, attachmentId: string) => Promise<AssetInspectionRecord>) {}
	refreshAffected(scope: { tenantId: string; workspaceId: string }) {
		for (const task of this.knowledge.store.taskScopes(scope)) this.knowledge.refreshRun(this.engine, { ...task, runId: workspaceRunId(scope, task.runId, "requirement") });
	}
	async handle(context: ConversationApiContext, conversationId: string, action: string, payload: unknown = {}) {
		try {
			if (![context.tenantId, context.workspaceId, context.actorId, conversationId].every(knowledgeId)) throw new KnowledgeError("knowledge_access_denied", 403);
			const access = this.conversations.get(context, conversationId);
			if (access.status !== 200) return access;
			const scope = { tenantId: context.tenantId!, workspaceId: context.workspaceId!, runId: conversationId };
			const requirementScope = { ...scope, runId: workspaceRunId(scope, conversationId, "requirement") };
			const actor = context.actorId!;
			const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
			const store = this.knowledge.store;
			if (action === "view") {
				this.knowledge.refreshRun(this.engine, requirementScope);
				const selected = store.selected(scope);
				return { status: 200, body: { documents: store.list(scope), jobs: this.knowledge.jobs(scope), sources: knowledgeSources, coverage: knowledgeCoverage, ...selected, review: coffeeEvidenceReview(selected.hits), embedding: { signature: store.embedding.signature, kind: store.embedding.kind } } };
			}
			if (action === "search") { const result = await store.search(scope, payload); return { status: 200, body: { result, review: coffeeEvidenceReview(result.hits) } }; }
			if (action === "products") { const response = await findCoffeeProducts(store, scope, payload); return { status: 200, body: { ...response, review: coffeeEvidenceReview(response.result.hits) } }; }
			if (action === "open-products") {
				const docs = coffeeProductManifests().map((manifest) => store.import(scope, manifest, actor));
				this.knowledge.reconcile(scope); return { status: 202, body: { documents: docs, warning: "Product discovery metadata only; no vendor full text or verified order specifications" } };
			}
			if (action === "compare") return { status: 200, body: compareEvidence(store, scope, payload) };
			if (action === "demo") {
				const docs = coffeeKnowledgeFixtures().slice(0, 2).map((fixture) => store.import(scope, fixture, actor));
				this.knowledge.reconcile(scope); return { status: 202, body: { documents: docs } };
			}
			if (action === "open-research") {
				const manifests = loadCoffeeCorpus();
				for (const doc of store.list(scope)) if (doc.tenantId === scope.tenantId && doc.workspaceId === scope.workspaceId && doc.manifest.parser.name === "packx-jats" && doc.manifest.model.startsWith("study:PMC") && !manifests.some((m) => m.documentId === doc.manifest.documentId) && doc.status !== "withdrawn") store.transition(scope, doc.versionId, "withdrawn", actor, "source_permission_changed");
				this.refreshAffected(scope);
				const docs = manifests.map((manifest) => store.import(scope, manifest, actor));
				this.knowledge.reconcile(scope); return { status: 202, body: { documents: docs, warning: "Licensed research samples; unknown order applicability; parameters remain unverified" } };
			}
			if (action === "import") { const doc = store.import(scope, payload, actor); this.knowledge.reconcile(scope); return { status: 202, body: { document: doc } }; }
			if (action === "parse-attachment") {
				if (!this.inspect || typeof data.attachmentId !== "string" || !/^attachment-[a-f0-9]+$/.test(data.attachmentId) || !data.manifest || typeof data.manifest !== "object") throw new KnowledgeError("invalid_attachment_import");
				// Validate authorization BEFORE parsing or persisting any source content.
				const input = { ...data.manifest, blocks: [], parser: { name: "native-asset-inspector", version: "1.1.0", status: "needs_review", reason: "Table/condition review required" } };
				assertImport(input);
				const parsed = await this.inspect({ ...scope, actorId: actor }, data.attachmentId);
				const manifest: KnowledgeImport = { ...input, parser: { ...input.parser, status: parsed.inspection.status === "needs_ocr" ? "needs_ocr" : "needs_review", reason: `Native status ${parsed.inspection.status}; truncated=${parsed.inspection.truncated}; raw sha256=${parsed.sha256}; tables require review` }, blocks: parsed.inspection.pages.flatMap((page) => {
					// Preserve page identity without silently dropping text; long pages need manual import.
					return page.text.length <= 4000 ? [{ location: { page: page.page, section: "native-page-unreviewed" }, text: page.text, parameters: [] }] : [];
				}) };
				const doc = store.import(scope, manifest, actor); this.knowledge.reconcile(scope); return { status: 202, body: { document: doc, warning: "Original attachment retained. Review all pages/tables before importing a new reviewed manifest." } };
			}
			if (action === "select") {
				const state = this.engine.load(requirementScope);
				if (["running", "evaluating"].includes(state.stageStatus) && state.lastJobId) throw new KnowledgeError("requirement_worker_busy", 409);
				const selection = store.select(scope, data.ids as string[], data.applicability as EvidenceSelection["applicability"], actor, String(data.requestId), Number(data.expectedVersion));
				if (state.currentProposal && state.facts.knowledge_source?.value !== JSON.stringify(selection)) this.engine.invalidateSource({ ...requirementScope, commandId: `evidence-selection:${digest(selection)}`, correlationId: randomUUID(), actorId: actor, expectedVersion: state.aggregateVersion, reason: "User selected different evidence; regenerate the requirement brief" });
				return { status: 200, body: { selection } };
			}
			if (action === "candidate") {
				const selected = store.selected(scope);
				if (selected.unavailable.length) throw new KnowledgeError("evidence_unavailable", 409);
				const state = this.engine.load(requirementScope);
				if (!state.aggregateVersion || !selected.selection || state.facts.knowledge_source?.value !== JSON.stringify(selected.selection)) throw new KnowledgeError("start_requirement_with_selected_evidence_first", 409);
				const hit = selected.hits.find((h) => h.evidenceId === data.evidenceId);
				const parameter = hit?.parameters.find((p) => p.name === data.parameter);
				const key = ({ structure: "material_structure", thickness: "material_thickness" } as Record<string, string>)[String(data.parameter)];
				if (!hit || !parameter || !key || !knowledgeId(data.requestId)) throw new KnowledgeError("invalid_evidence_candidate");
				if (parameter.authority === "research_report" || hit.parameters.filter((p) => p.name === parameter.name).length !== 1) throw new KnowledgeError("sample_or_ambiguous_parameter_requires_supplier_confirmation", 409);
				const commandId = `evidence-fact:${data.requestId}`;
				const previous = this.engine.readFactCommand(requirementScope, commandId);
				if (previous && (previous.key !== key || previous.value !== parameter.originalValue || previous.sourceRef !== hit.evidenceId)) throw new KnowledgeError("evidence_candidate_conflict", 409);
				if (!previous) this.engine.recordFactVersion({ ...requirementScope, expectedVersion: state.aggregateVersion, commandId, correlationId: data.requestId, actorId: actor, factKey: key, factVersion: (state.factVersions[key] ?? 0) + 1, value: parameter.originalValue, ...(parameter.originalUnit ? { unit: parameter.originalUnit } : {}), status: "unverified", sourceType: "source_document", sourceRef: hit.evidenceId });
				return { status: 200, body: { status: "unverified", key, sourceRef: hit.evidenceId } };
			}
			if (action === "withdraw" || action === "cancel") {
				store.transition(scope, String(data.versionId), action === "withdraw" ? "withdrawn" : "cancelled", actor, action === "withdraw" ? "source_withdrawn" : "cancelled_by_user");
				this.refreshAffected(scope); return { status: 200, body: { status: action } };
			}
			if (action === "retry") { this.knowledge.retry(scope, String(data.versionId), actor); return { status: 202, body: { status: "retry_queued" } }; }
			if (action === "rebuild") { store.rebuild(scope); this.knowledge.reconcile(scope); return { status: 202, body: { status: "rebuilding" } }; }
			if (action === "evidence") return { status: 200, body: { evidence: store.readEvidence(scope, String(data.evidenceId)) } };
			throw new KnowledgeError("knowledge_route_not_found", 404);
		} catch (error) {
			return { status: error instanceof KnowledgeError ? error.status : 409, body: { code: error instanceof KnowledgeError ? error.code : "knowledge_operation_failed", message: error instanceof KnowledgeError ? error.code : "知识操作失败；检查权限、任务状态或导入记录。" } };
		}
	}
}
