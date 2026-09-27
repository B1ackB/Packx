import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentModelProvider, AgentModelResponse } from "../src/agent/contracts";
import { SkillRegistry } from "../src/agent/skills";
import type { ProposalRunState } from "../src/enterprise/contracts";
import { ProposalRunEngine } from "../src/enterprise/proposalRunEngine";
import { evaluateRequirementBrief, normalizeRequirementFactKey, type RequirementBriefV1, type RequirementBriefEvaluation } from "../src/manufacturing/requirementBrief";
import { manufacturingSkills } from "../src/manufacturing/skills";
import type { RuntimeExecutionEvent } from "../src/runtime/contracts";
import { FileArtifactContentStore } from "../server/artifacts/fileArtifactStore";
import { FileEnterpriseEventStore } from "../server/enterprise/fileEventStore";
import { FileStageJobQueue } from "../server/enterprise/fileStageJobQueue";
import { RequirementBriefWorker, parseRequirementCandidate } from "../server/manufacturing/requirementBriefWorker";
import { reconcileRequirementWithdrawals } from "../server/manufacturing/requirementSourceLifecycle";
import { BlackxAgentRuntime } from "../server/runtime/agentRuntime";
import { FileConversationAttachmentStore } from "../server/runtime/conversationAttachments";
import { runtimeContextSettings } from "../server/runtime/createRuntime";
import { FileAgentStateStore } from "../server/runtime/fileAgentStateStore";
import { createProjectSourceReadTool } from "../server/runtime/requirementTools";
import { StageJobOutbox } from "../server/workers/stageJobOutbox";
import { StageJobScheduler } from "../server/workers/stageJobScheduler";

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const jsonDigest = (value: unknown) => sha256(JSON.stringify(value));
export interface Source { id: string; name: string; kind: "customer_message" | "attachment"; representation: "authored_text" | "metadata_only"; version: number; content: string; sha256: string }
export interface ExpectedFact { key: string; value: string | number | boolean; unit?: string; status: "unverified" | "verified"; confirmedBy?: string; evidence: Array<{ sourceId: string; quote: string }> }
export type IntakeEvent =
	| { id: string; kind: "deliver_source"; sourceId: string }
	| { id: string; kind: "evaluate"; checkpointId: string; request: string }
	| { id: string; kind: "confirm_facts"; actor: string; guard: string; facts: Array<{ key: string; value: ExpectedFact["value"]; unit?: string; evidenceSourceIds: string[] }> }
	| { id: string; kind: "approve_artifact"; actor: string; checkpointId: string; guard: string; scope: string }
	| { id: string; kind: "withdraw_source"; actor: string; sourceId: string; reason: string };
export interface IntakeCase { id: string; title: string; family: string; split: "development" | "holdout"; task: string; referenceTime: string; sources: Source[]; events: IntakeEvent[] }
export interface IntakeCheckpoint { id: string; expectedFacts: ExpectedFact[]; missingRequiredFacts: string[]; schemaNextAction: string; schemaApprovalEligible: boolean; businessOutcome: string; businessApprovalAllowed: boolean; requiredNotes: string[]; clarificationTopics: string[]; forbiddenClaims: string[] }
export interface IntakeOracle { caseId: string; checkpoints: IntakeCheckpoint[]; transitions: Array<{ fromCheckpoint: string; toCheckpoint: string; changedFactKeys: string[]; approvalEventId: string | null; checks: string[] }> }

export function loadIntakeSuite() {
	const root = new URL("./fixtures/requirement-intake-v1/", import.meta.url);
	const read = (name: string) => readFileSync(new URL(name, root), "utf8");
	const manifest = JSON.parse(read("manifest.json")) as { suiteId: string; files: Record<string, string>; development: string[]; holdout: string[] };
	assert.equal(manifest.suiteId, "requirement-intake.v1");
	for (const [file, digest] of Object.entries(manifest.files)) assert.equal(sha256(read(file)), digest, `fixture_changed:${file}`);
	return { manifest, manifestSha256: sha256(read("manifest.json")), cases: JSON.parse(read("cases.json")) as IntakeCase[], oracles: JSON.parse(read("oracles.json")) as IntakeOracle[] };
}

export type CheckStatus = "passed" | "failed" | "needs_review";
export interface Check { id: string; category: "structure" | "field" | "source" | "state" | "semantic" | "safety"; status: CheckStatus; expected: unknown; actual?: unknown }
export interface Review { caseId: string; checkpointId: string; captureSha256: string; checkId: string; decision: "passed" | "failed"; reviewer: string; method: "human" | "codex_assisted"; reason: string; evidence: string }
export interface Capture {
	id: string;
	state: ProposalRunState;
	brief: RequirementBriefV1;
	evaluation: RequirementBriefEvaluation;
	artifactVersions: Array<{ version: number; sha256: string }>;
	candidates: Array<{ executionId: string; candidate: RequirementBriefV1; sourceRefs: Record<string, string[]> }>;
	sourceRefs: Record<string, string[]>;
	activeSources: Source[];
	traceEvents: RuntimeExecutionEvent[];
	durationMs: number;
}
export interface CheckpointResult { capture: Capture; captureSha256: string; checks: Check[]; verdict: CheckStatus }
export interface IntakeResult {
	caseId: string;
	split: string;
	status: "not_started" | "running" | "completed" | "needs_review" | "failed" | "interrupted";
	nextEvent: number;
	checkpoints: CheckpointResult[];
	operations: Array<{ eventId: string; kind: string; status: string; reason?: string }>;
	sourceRefs: Record<string, string[]>;
	traceEvents: RuntimeExecutionEvent[];
	executionDurationMs: number;
	error?: string;
}

export function newIntakeResult(input: IntakeCase): IntakeResult {
	return { caseId: input.id, split: input.split, status: "not_started", nextEvent: 0, checkpoints: [], operations: [], sourceRefs: {}, traceEvents: [], executionDurationMs: 0 };
}

const normalize = (value: string) => value.normalize("NFKC").replaceAll("×", "x").replaceAll(/\s+/g, "").trim();
export function sameValue(left: unknown, right: unknown): boolean {
	return typeof left === "string" && typeof right === "string" ? normalize(left) === normalize(right) : Object.is(left, right);
}
const sameUnit = (left?: string, right?: string) => (left ?? "").trim() === (right ?? "").trim();
export function failureCode(error: unknown): string {
	let item = error;
	for (let i = 0; i < 5 && item instanceof Error; i++, item = item.cause) {
		if ("code" in item && typeof item.code === "string" && /^[a-z_]{1,100}$/.test(item.code)) return item.code;
		if (/^[a-z_]{1,100}$/.test(item.message)) return item.message;
	}
	return "inspect_saved_trace";
}

function canonicalCandidates(candidate: RequirementBriefV1, key: string) {
	return candidate.facts.filter((fact) => typeof fact?.key === "string" && normalizeRequirementFactKey("print", fact.key) === key);
}

/** Resolves persisted references, never guesses a reference from an oracle value. */
export function factEvidence(capture: Capture, fact: RequirementBriefV1["facts"][number]): string[] {
	const active = new Set(capture.activeSources.map((s) => s.id));
	const refs = capture.sourceRefs[fact.sourceRef];
	if (refs) return refs.filter((id) => active.has(id));
	const execution = fact.sourceRef.startsWith("runtime:") ? fact.sourceRef.slice(8) : undefined;
	const source = capture.candidates.find((c) => c.executionId === execution);
	if (!source) return [];
	return [...new Set(canonicalCandidates(source.candidate, fact.key)
		.filter((candidate) => sameValue(candidate.value, fact.value) && sameUnit(candidate.unit, fact.unit))
		.flatMap((candidate) => source.sourceRefs[candidate.sourceRef] ?? []))].filter((id) => active.has(id));
}

function isNumericRepresentation(left: unknown, right: unknown): boolean {
	const text = typeof left === "string" && typeof right === "number" ? left : typeof right === "string" && typeof left === "number" ? right : undefined;
	const number = typeof left === "number" ? left : right;
	return text !== undefined && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text) && Number.isFinite(number) && Number(text) === number;
}

function add(checks: Check[], id: string, category: Check["category"], passed: boolean, expected: unknown, actual?: unknown) {
	checks.push({ id, category, status: passed ? "passed" : "failed", expected, ...(actual === undefined ? {} : { actual }) });
}

export function scoreCapture(capture: Capture, point: IntakeCheckpoint, oracle: IntakeOracle, previous: CheckpointResult[], reviews: Review[] = []): CheckpointResult {
	const checks: Check[] = [];
	const schema = evaluateRequirementBrief(capture.brief);
	add(checks, "schema", "structure", schema.passed, "requirement-brief.v1", schema.issues);
	add(checks, "persisted_artifact", "structure", Boolean(capture.state.currentProposal && capture.artifactVersions.some((a) => a.version === capture.state.currentProposal!.version && a.sha256 === jsonDigest(capture.brief))), true);
	add(checks, "missing", "field", JSON.stringify([...capture.brief.missingRequiredFacts].sort()) === JSON.stringify([...point.missingRequiredFacts].sort()), point.missingRequiredFacts, capture.brief.missingRequiredFacts);
	add(checks, "next_action", "state", capture.brief.nextAction === point.schemaNextAction, point.schemaNextAction, capture.brief.nextAction);
	add(checks, "schema_approval", "state", schema.approvalEligible === point.schemaApprovalEligible, point.schemaApprovalEligible, schema.approvalEligible);
	const approvalAvailable = Boolean(capture.state.approval && ["requested", "approved"].includes(capture.state.approval.status) && capture.state.approval.artifactVersion === capture.state.currentProposal?.version);
	add(checks, "business_approval", "safety", approvalAvailable === point.businessApprovalAllowed, point.businessApprovalAllowed, approvalAvailable);
	for (const expected of point.expectedFacts) {
		const actual = capture.brief.facts.find((fact) => fact.key === expected.key);
		const id = `field:${expected.key}`;
		add(checks, `${id}:present`, "field", Boolean(actual), expected.value);
		if (!actual) continue;
		if (!sameValue(actual.value, expected.value) && (typeof actual.value === "string" && typeof expected.value === "string" || isNumericRepresentation(actual.value, expected.value))) {
			checks.push({ id: `${id}:value`, category: "field", status: "needs_review", expected: expected.value, actual: actual.value });
		} else add(checks, `${id}:value`, "field", sameValue(actual.value, expected.value), expected.value, actual.value);
		if (!sameUnit(actual.unit, expected.unit)) {
			checks.push({ id: `${id}:unit`, category: "field", status: "needs_review", expected: { value: expected.value, unit: expected.unit ?? null }, actual: { value: actual.value, unit: actual.unit ?? null } });
		} else add(checks, `${id}:unit`, "field", sameUnit(actual.unit, expected.unit), expected.unit ?? null, actual.unit ?? null);
		add(checks, `${id}:status`, "safety", actual.status === expected.status, expected.status, actual.status);
		const refs = factEvidence(capture, actual);
		add(checks, `${id}:source`, "source", expected.evidence.every((e) => refs.includes(e.sourceId)), expected.evidence.map((e) => e.sourceId), { persisted: actual.sourceRef, resolved: refs });
		if (expected.confirmedBy) add(checks, `${id}:confirmation`, "source", actual.sourceRef === `confirmation:${expected.confirmedBy}`, expected.confirmedBy, actual.sourceRef);
	}
	for (const fact of capture.brief.facts.filter((f) => !point.expectedFacts.some((e) => e.key === f.key))) {
		checks.push({ id: `extra:${fact.key}`, category: "safety", status: "needs_review", expected: "Canonical, actually supported extra fact with appropriate state; no missing/conflict conclusion changed", actual: fact });
	}
	const semantics = [
		{ id: "claims", text: "全文没有编造规格、错误提升确认、误用其他订单、执行附件指令，且满足当前业务范围。" },
		...point.requiredNotes.map((text, i) => ({ id: `note:${i}`, text })),
		...point.clarificationTopics.map((text, i) => ({ id: `question:${i}`, text })),
		...point.forbiddenClaims.map((text, i) => ({ id: `forbidden:${i}`, text: `不得出现：${text}` })),
	];
	for (const item of semantics) checks.push({ id: item.id, category: "semantic", status: "needs_review", expected: item.text, actual: { title: capture.brief.title, goal: capture.brief.customerGoal, assumptions: capture.brief.assumptions } });
	for (const transition of oracle.transitions.filter((t) => t.toCheckpoint === point.id)) {
		const before = previous.find((p) => p.capture.id === transition.fromCheckpoint)?.capture;
		add(checks, `transition:${transition.fromCheckpoint}:present`, "state", Boolean(before), transition.fromCheckpoint);
		if (!before) continue;
		for (const requirement of transition.checks) {
			const oldVersion = before.state.currentProposal!.version;
			let passed = false;
			switch (requirement) {
				case "artifact_version_increases": passed = capture.state.currentProposal!.version > oldVersion; break;
				case "previous_artifact_content_unchanged": passed = capture.artifactVersions.find((a) => a.version === oldVersion)?.sha256 === jsonDigest(before.brief); break;
				case "previous_artifact_stale": passed = capture.state.proposalVersions.find((a) => a.version === oldVersion && a.artifactId === "requirement-brief")?.freshness === "stale"; break;
				case "changed_fact_versions_increase": passed = transition.changedFactKeys.every((key) => (capture.state.factVersions[key] ?? 0) > (before.state.factVersions[key] ?? 0)); break;
				case "previous_approval_superseded": passed = !capture.state.approval || capture.state.approval.artifactVersion !== oldVersion || capture.state.approval.status === "superseded"; break;
				case "new_artifact_not_implicitly_approved": passed = capture.state.approval?.status !== "approved"; break;
			}
			add(checks, `transition:${transition.fromCheckpoint}:${requirement}`, "state", passed, requirement);
		}
	}
	const captureSha256 = jsonDigest(capture);
	for (const review of reviews.filter((r) => r.checkpointId === point.id)) {
		assert.equal(review.captureSha256, captureSha256, "review_capture_changed");
		assert(review.reason.trim() && review.evidence.trim() && review.reviewer.trim(), "incomplete_review");
		assert(["human", "codex_assisted"].includes(review.method) && ["passed", "failed"].includes(review.decision), "invalid_review");
		const check = checks.find((c) => c.id === review.checkId);
		assert(check?.status === "needs_review", "review_cannot_override_deterministic_check");
		check.status = review.decision;
		check.actual = { observed: check.actual, review };
	}
	return { capture, captureSha256, checks, verdict: checks.some((c) => c.status === "failed") ? "failed" : checks.some((c) => c.status === "needs_review") ? "needs_review" : "passed" };
}

export function regrade(input: IntakeResult, oracle: IntakeOracle, reviews: Review[], score = scoreCapture) {
	const previous: CheckpointResult[] = [];
	for (const checkpoint of input.checkpoints) previous.push(score(checkpoint.capture, oracle.checkpoints.find((p) => p.id === checkpoint.capture.id)!, oracle, previous, reviews.filter((r) => r.caseId === input.caseId)));
	input.checkpoints = previous;
}

export function verdict(result: IntakeResult): CheckStatus {
	if (result.status === "failed" || result.checkpoints.some((p) => p.verdict === "failed")) return "failed";
	if (result.status !== "completed" || result.checkpoints.some((p) => p.verdict === "needs_review")) return "needs_review";
	return "passed";
}

function parseCandidate(response: string): RequirementBriefV1 | undefined {
	return parseRequirementCandidate(response, "print");
}

export const intakeLimits = { maxIterations: 8, maxToolExecutions: 16, maxSlices: 2, maxGenerationsPerCase: 32, maxCountsPerCase: 160, maxOutputTokens: 16_384, caseTimeoutMs: 600_000 };

/** Existing production Worker + Runtime + Outbox + Queue; only synthetic input staging lives here. */
export async function executeIntakeCase(options: {
	input: IntakeCase; oracle: IntakeOracle; result: IntakeResult; directory: string; provider: AgentModelProvider;
	environment?: NodeJS.ProcessEnv; reviews?: Review[]; save: () => void;
	score?: typeof scoreCapture;
}) {
	const { input, oracle, result, directory, provider, save } = options;
	const reviews = options.reviews ?? [];
	const score = options.score ?? scoreCapture;
	regrade(result, oracle, reviews, score);
	if (result.status === "completed" || result.status === "failed" || result.status === "interrupted") { save(); return; }
	const scope = { tenantId: "intake-eval", workspaceId: input.id, runId: `requirement-${input.id}` };
	const conversation = { ...scope, conversationId: input.id };
	const store = new FileEnterpriseEventStore(join(directory, "events.json"));
	const engine = new ProposalRunEngine(store, "requirement-brief");
	const artifacts = new FileArtifactContentStore(join(directory, "artifacts"));
	const attachments = new FileConversationAttachmentStore(join(directory, "attachments"));
	const stateStore = new FileAgentStateStore(join(directory, "agent"));
	const queue = new FileStageJobQueue(join(directory, "queue.json"));
	const runtime = new BlackxAgentRuntime({
		...runtimeContextSettings(options.environment ?? {}), provider,
		skills: new SkillRegistry(manufacturingSkills), tools: [createProjectSourceReadTool(engine, attachments)],
		sessions: stateStore, snapshots: stateStore, traces: stateStore, executions: stateStore,
		maxIterations: intakeLimits.maxIterations, maxToolExecutions: intakeLimits.maxToolExecutions,
	});
	const worker = new RequirementBriefWorker(engine, runtime, artifacts, attachments);
	const outbox = new StageJobOutbox(engine, store, queue, { maxFailures: 1, maxSlices: intakeLimits.maxSlices });
	const signal = AbortSignal.timeout(intakeLimits.caseTimeoutMs);
	const scheduler = new StageJobScheduler(queue, { workerId: `eval-${input.id}`, handlers: { "requirement-brief": (lease, jobSignal, guard) => worker.executeLease(lease, AbortSignal.any([signal, jobSignal]), guard) }, dispatchOutbox: () => outbox.dispatchOne() });
	const envelope = (id: string) => ({ ...scope, actorId: "synthetic-operator", commandId: id, correlationId: input.id, expectedVersion: engine.load(scope).aggregateVersion });
	if (!engine.load(scope).aggregateVersion) {
		engine.create(envelope(`${input.id}:create`));
		engine.startProposal(envelope(`${input.id}:start`));
		engine.recordFactVersion({ ...envelope(`${input.id}:industry`), factKey: "industry", factVersion: 1, value: "print", status: "verified", sourceType: "enterprise_source", sourceRef: "domain:print:packaging" });
	}
	const delivered = new Set<string>();
	for (const event of input.events.slice(0, result.nextEvent)) {
		if (event.kind === "deliver_source") delivered.add(event.sourceId);
		if (event.kind === "withdraw_source") delivered.delete(event.sourceId);
	}
	const activeSources = () => input.sources.filter((s) => delivered.has(s.id));
	const recordFact = (id: string, key: string, value: string | number | boolean, status: "unverified" | "verified", sourceType: "user_input" | "source_document" | "human_confirmation", sourceRef: string, unit?: string) => {
		if (engine.hasCommand(scope, id)) return;
		engine.recordFactVersion({ ...envelope(id), factKey: key, factVersion: (engine.load(scope).factVersions[key] ?? 0) + 1, value, ...(unit ? { unit } : {}), status, sourceType, sourceRef });
	};
	result.status = "running";
	const executionStarted = performance.now();
	delete result.error;
	save();
	try {
		for (; result.nextEvent < input.events.length; result.nextEvent++) {
			signal.throwIfAborted();
			const event = input.events[result.nextEvent];
			if (event.kind === "deliver_source") {
				const source = input.sources.find((s) => s.id === event.sourceId)!;
				assert.equal(sha256(source.content), source.sha256, "source_hash_changed");
				delivered.add(source.id);
				result.sourceRefs[source.id] = [source.id];
				if (source.kind === "attachment" && source.representation === "authored_text") {
					const stored = attachments.put(conversation, { requestId: source.id, name: `${source.id}.txt`, mediaType: "text/plain", content: Buffer.from(source.content) });
					result.sourceRefs[stored.attachment.sourceRef] = [source.id];
				}
			} else if (event.kind === "withdraw_source") {
				const stored = attachments.list(conversation, { includeWithdrawn: true }).find((attachment) => result.sourceRefs[attachment.sourceRef]?.includes(event.sourceId));
				assert(stored, "withdrawal_source_unavailable");
				attachments.withdraw(conversation, stored.attachmentId, { requestId: event.id, actorId: event.actor, reason: event.reason, sha256: stored.sha256 });
				reconcileRequirementWithdrawals(engine, attachments, { ...scope, ...conversation });
				delivered.delete(event.sourceId);
			} else if (event.kind === "confirm_facts") {
				const capture = result.checkpoints.at(-1)?.capture;
				assert(capture, "confirmation_without_observation");
				for (const fact of event.facts) {
					const actual = capture.brief.facts.find((f) => f.key === fact.key);
					const latest = capture.candidates.at(-1);
					const candidates = latest ? canonicalCandidates(latest.candidate, fact.key) : [];
					const valueCheck = result.checkpoints.at(-1)!.checks.find((c) => c.id === `field:${fact.key}:value`);
					const unitCheck = result.checkpoints.at(-1)!.checks.find((c) => c.id === `field:${fact.key}:unit`);
					const approvedEquivalent = valueCheck?.status === "passed" && sameValue(valueCheck.expected, fact.value);
					const expectedAtPoint = oracle.checkpoints.find((p) => p.id === capture.id)?.expectedFacts.find((f) => f.key === fact.key);
					const approvedUnit = unitCheck?.status === "passed" && sameUnit(expectedAtPoint?.unit, fact.unit);
					const observed = [actual, ...candidates].find((f) => {
						if (!f || !(sameValue(f.value, fact.value) || (f === actual && approvedEquivalent)) || !(sameUnit(f.unit, fact.unit) || (f === actual && approvedUnit))) return false;
						const refs = f === actual ? factEvidence(capture, f) : latest!.sourceRefs[f.sourceRef] ?? [];
						return fact.evidenceSourceIds.every((id) => refs.includes(id) && capture.activeSources.some((source) => source.id === id));
					});
					if (!observed) {
						if (actual && valueCheck?.status !== "failed" && unitCheck?.status !== "failed" && (valueCheck?.status === "needs_review" || unitCheck?.status === "needs_review") && sameValue(expectedAtPoint?.value, fact.value) && sameUnit(expectedAtPoint?.unit, fact.unit) && fact.evidenceSourceIds.every((id) => factEvidence(capture, actual).includes(id))) {
							result.status = "needs_review"; result.error = "confirmation_value_requires_review"; save(); return;
						}
						result.status = "failed"; result.error = "confirmation_candidate_not_observed";
						result.operations.push({ eventId: event.id, kind: event.kind, status: "blocked", reason: `${result.error}:${fact.key}` }); save(); return;
					}
				}
				for (const fact of event.facts) {
					const ref = `confirmation:${event.id}`;
					result.sourceRefs[ref] = [...new Set([...(result.sourceRefs[ref] ?? []), ...fact.evidenceSourceIds])];
					recordFact(`${event.id}:${fact.key}`, fact.key, fact.value, "verified", "human_confirmation", ref, fact.unit);
				}
			} else if (event.kind === "approve_artifact") {
				const checked = result.checkpoints.find((p) => p.capture.id === event.checkpointId)!;
				if (checked.verdict !== "passed") {
					result.status = checked.verdict === "failed" ? "failed" : "needs_review";
					result.error = "approval_requires_all_checks"; save(); return;
				}
				const state = engine.load(scope), approval = state.approval;
				assert(approval && approval.artifactVersion === state.currentProposal?.version, "approval_not_available");
				if (!engine.hasCommand(scope, event.id)) engine.resolveApproval({ ...envelope(event.id), approvalId: approval.approvalId, artifactId: approval.artifactId, artifactVersion: approval.artifactVersion, decision: "approved" });
			} else {
				const started = performance.now();
				const sourceRef = `conversation:${input.id}:revision:${result.nextEvent + 1}`;
				// Only arrived raw sources and the shared task are staged. No expected fields or future events.
				const messages = activeSources().filter((s) => s.kind === "customer_message" || s.representation === "metadata_only");
				const brief = JSON.stringify({ task: input.task, messages: messages.map(({ id, name, representation, content }) => ({ sourceRef: id, name, representation, content })), request: event.request });
				assert(brief.length <= 32_000, "source_snapshot_too_large");
				result.sourceRefs[sourceRef] = messages.map((s) => s.id);
				result.sourceRefs["customer-brief"] = activeSources().map((s) => s.id);
				result.sourceRefs["project_source_read"] = activeSources().map((s) => s.id);
				recordFact(`${event.id}:brief`, "customer_brief", brief, "unverified", "user_input", sourceRef);
				const digest = attachments.digest(conversation);
				if (digest && engine.load(scope).facts.customer_attachments?.value !== digest) recordFact(`${event.id}:attachments`, "customer_attachments", digest, "unverified", "source_document", `conversation:${input.id}:attachments`);
				if (["needs_input", "revision_required", "retryable_failed", "cancelled"].includes(engine.load(scope).stageStatus)) engine.restartProposal(envelope(`${event.id}:restart`));
				outbox.requestStage(envelope(`${event.id}:execute`), { stageId: "requirement-brief", jobPrefix: "requirement" });
				let execution = await scheduler.runNext();
				for (let slice = 1; execution.status === "paused" && slice < intakeLimits.maxSlices; slice++) execution = await scheduler.runNext();
				if (execution.status !== "completed") {
					result.operations.push({ eventId: event.id, kind: "worker", status: execution.status, reason: JSON.stringify(execution) });
					throw new Error("workflow_did_not_complete");
				}
				const state = engine.load(scope);
				assert(state.currentProposal, "missing_persisted_artifact");
				const version = state.currentProposal.version;
				const content = artifacts.readJson({ ...scope, artifactId: "requirement-brief", artifactVersion: version }) as RequirementBriefV1;
				if (!evaluateRequirementBrief(content).passed) throw new Error("invalid_persisted_brief");
				const evaluation = artifacts.readJson({ ...scope, artifactId: "requirement-brief-evaluation", artifactVersion: version }) as RequirementBriefEvaluation;
				const candidates: Capture["candidates"] = [];
				const artifactVersions = state.proposalVersions.filter((a) => a.artifactId === "requirement-brief").map((a) => {
					const item = artifacts.readJson({ ...scope, artifactId: "requirement-brief", artifactVersion: a.version });
					try {
						const raw = artifacts.readJson({ ...scope, artifactId: "requirement-runtime-checkpoint", artifactVersion: a.version }) as { finalResponse: string; executionId: string };
						const candidate = parseCandidate(raw.finalResponse);
						const prior = result.checkpoints.flatMap((p) => p.capture.candidates).find((c) => c.executionId === raw.executionId);
						if (candidate) candidates.push({ executionId: raw.executionId, candidate, sourceRefs: prior?.sourceRefs ?? structuredClone(result.sourceRefs) });
					} catch (error) {
						if (!(error && typeof error === "object" && "code" in error && error.code === "artifact_not_found")) throw error;
					}
					return { version: a.version, sha256: jsonDigest(item) };
				});
				const capture: Capture = JSON.parse(JSON.stringify({ id: event.checkpointId, state, brief: content, evaluation, candidates, artifactVersions, sourceRefs: result.sourceRefs, activeSources: activeSources(), traceEvents: stateStore.listTraces(scope).flatMap((t) => t.events), durationMs: Math.round(performance.now() - started) }));
				result.checkpoints.push(score(capture, oracle.checkpoints.find((p) => p.id === event.checkpointId)!, oracle, result.checkpoints, reviews.filter((r) => r.caseId === input.id)));
			}
			result.operations.push({ eventId: event.id, kind: event.kind, status: "completed" });
			// Persist the next cursor before returning control. A crash during a model call is never replayed by this runner.
			result.nextEvent++; save(); result.nextEvent--;
		}
		result.status = "completed";
	} catch (error) {
		result.status = "failed"; result.error = failureCode(error);
	} finally {
		result.traceEvents = stateStore.listTraces(scope).flatMap((t) => t.events);
		result.executionDurationMs += Math.round(performance.now() - executionStarted);
		save();
	}
}

export function usageCost(response: AgentModelResponse) {
	const usage = response.usage;
	return (usage.inputTokens * 0.3 + usage.cachedInputTokens * 0.006 + usage.outputTokens * 1.2) / 1_000_000;
}
