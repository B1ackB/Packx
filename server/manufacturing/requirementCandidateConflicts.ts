import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ArtifactStoreError, type ArtifactContentStore } from "../../src/enterprise/artifactStore";
import type { EnterpriseEvent, FactVersionState, ProposalRunState } from "../../src/enterprise/contracts";
import { normalizeRequirementFactKey, validCandidateConflicts, type ManufacturingIndustry, type RequirementBriefV1, type RequirementFactV1, type RequirementCandidateConflict, type RequirementCandidateSource } from "../../src/manufacturing/requirementBrief";
import { replayProposalRun } from "../../src/enterprise/proposalRunEngine";
import { compareRequirementField } from "../../src/manufacturing/requirementField";
import { RuntimeFailure } from "../../src/runtime/contracts";
import type { ReviewEvidence } from "../enterprise/evidenceReviewWorkflow";
import { correctExtractedQuantity } from "./requirementCorrections";

export interface CandidateConfirmation {
	schemaVersion: "requirement-candidate-confirmation.v1";
	commandId: string;
	key: string;
	factVersion: number;
	expectedAggregateVersion: number;
	reviewedArtifactVersion: number;
	conflictIds: string[];
}

export function candidateConfirmationKey(requestId: string) {
	return { artifactId: `candidate-confirmation-${createHash("sha256").update(requestId).digest("hex")}`, artifactVersion: 1 };
}

export function readCandidateConfirmation(artifacts: ArtifactContentStore, state: ProposalRunState, requestId: string): CandidateConfirmation | undefined {
	try { return artifacts.readJson({ ...state, ...candidateConfirmationKey(requestId) }) as CandidateConfirmation; }
	catch (error) { if (error instanceof ArtifactStoreError && error.code === "artifact_not_found") return; throw error; }
}

/** A review intent alone is not a resolution: the matching human Fact event must exist. */
export function candidateConflictHistory(artifacts: ArtifactContentStore, state: ProposalRunState, events: EnterpriseEvent[], activeVersion?: number) {
	const found = new Map<string, RequirementCandidateConflict>();
	const collect = (conflicts: unknown) => {
		if (conflicts === undefined) return;
		if (!validCandidateConflicts(conflicts)) throw new RuntimeFailure("context_failure", "Stored candidate conflicts are invalid", false);
		for (const conflict of conflicts) {
			const previous = found.get(conflict.id);
			if (previous && !isDeepStrictEqual(previous, conflict)) throw new RuntimeFailure("context_failure", "Stored candidate conflict identity changed", false);
			found.set(conflict.id, conflict);
		}
	};
	for (const version of state.proposalVersions.filter(v => v.artifactId === "requirement-brief")) {
		const content = artifacts.readJson({ ...state, artifactId: version.artifactId, artifactVersion: version.version }) as { candidateConflicts?: unknown };
		collect(content?.candidateConflicts);
	}
	const read = (artifactId: string, artifactVersion: number) => {
		try { return artifacts.readJson({ ...state, artifactId, artifactVersion }); }
		catch (error) { if (!(error instanceof ArtifactStoreError) || error.code !== "artifact_not_found") throw error; }
	};
	// Also inspect reserved versions beyond the last published artifact: confirmation must see
	// abandoned results even before another Worker runs. Revisions may leave gaps below that version.
	for (let version = 1; ; version++) {
		const checkpoint = read("requirement-candidate-checkpoint", version);
		const runtime = read("requirement-runtime-checkpoint", version);
		if (checkpoint !== undefined) {
			if (!isRecord(checkpoint) || checkpoint.protocol !== "requirement-candidate-check.v1") throw new RuntimeFailure("context_failure", "Stored candidate checkpoint is invalid", false);
			collect(checkpoint.conflicts);
		} else if (runtime !== undefined && version !== activeVersion && !state.proposalVersions.some(v => v.version === version)) {
			collect(recoverUncomparedCandidates(runtime, artifacts, state, events, [...found.values()], version));
		}
		if (version > Math.max(state.currentProposal?.version ?? 0, activeVersion ?? 0) && runtime === undefined && checkpoint === undefined) break;
	}
	const resolutions = events.flatMap(event => {
		const data = event.data;
		if (data.type !== "fact.version_recorded" || data.status !== "verified" || data.sourceType !== "human_confirmation" || !event.commandId.endsWith(":fact-decision")) return [];
		const receipt = readCandidateConfirmation(artifacts, state, event.commandId.slice(0, -":fact-decision".length));
		if (!receipt) return [];
		const reviewed = events.find(e => e.data.type === "artifact.version_created" && e.data.artifactVersion === receipt.reviewedArtifactVersion && e.data.artifactId === "requirement-brief");
		if (receipt.schemaVersion !== "requirement-candidate-confirmation.v1" || receipt.commandId !== event.commandId || receipt.key !== data.factKey || receipt.factVersion !== data.factVersion ||
			receipt.expectedAggregateVersion + 1 !== event.aggregateVersion || !reviewed || reviewed.aggregateVersion > receipt.expectedAggregateVersion || !Array.isArray(receipt.conflictIds)) {
			throw new RuntimeFailure("context_failure", "Candidate confirmation does not match its human Fact event", false);
		}
		return [{ receipt, factVersion: data.factVersion }];
	});
	const open: RequirementCandidateConflict[] = [];
	const resolved: Array<{ conflict: RequirementCandidateConflict; factVersion: number }> = [];
	for (const conflict of found.values()) {
		const resolution = resolutions.find(r => r.receipt.key === conflict.key && r.receipt.reviewedArtifactVersion >= conflict.firstArtifactVersion && r.receipt.conflictIds.includes(conflict.id));
		if (resolution) resolved.push({ conflict, factVersion: resolution.factVersion });
		else open.push(conflict);
	}
	return { open, resolved };
}

/** Compare saved output against its original event snapshot; never replay a model or write Facts. */
function recoverUncomparedCandidates(runtime: unknown, artifacts: ArtifactContentStore, state: ProposalRunState, events: EnterpriseEvent[], history: RequirementCandidateConflict[], version: number): RequirementCandidateConflict[] {
	if (!isRecord(runtime) || runtime.schemaVersion !== "requirement-runtime-checkpoint.v1" || typeof runtime.finalResponse !== "string" ||
		!Number.isSafeInteger(runtime.inputAggregateVersion) || Number(runtime.inputAggregateVersion) < 1 || Number(runtime.inputAggregateVersion) > state.aggregateVersion) throw new RuntimeFailure("context_failure", "Stored runtime candidate snapshot is invalid", false);
	const inputEvents = events.filter(e => e.aggregateVersion <= Number(runtime.inputAggregateVersion));
	const baseline = replayProposalRun(state, inputEvents);
	const candidate = parseRequirementCandidate(runtime.finalResponse, "print");
	if (!candidate) return [];
	const evidence: ReviewEvidence[] = Object.values(baseline.facts).filter(f => f.key !== "customer_messages" && f.status !== "rejected" && f.sourceType !== "model_output").map(f => ({ ref: f.sourceRef, version: f.version, content: f }));
	for (const original of messageEvidence(inputEvents).filter(e => e.version === baseline.facts.customer_brief?.version)) if (!evidence.some(e => e.ref === original.ref)) evidence.push(original);
	const facts = candidateFacts("print", candidate);
	const comparisons = facts.flatMap(fact => {
		const current = baseline.facts[fact.key];
		const open = history.find(c => c.key === fact.key);
		const comparable = current && ["suggested", "unverified"].includes(current.status);
		const previous = comparable ? previousCandidateSource(current, evidence, inputEvents, artifacts, baseline) : open?.previous;
		if (!previous) return [];
		const comparison = compareRequirementField(fact.key, previous, fact);
		if (comparison.status === "equivalent") return [];
		const sourceRef = ["runtime-output", "project_source_read", "customer-brief"].includes(fact.sourceRef) ? baseline.facts.plan_source?.sourceRef ?? baseline.facts.customer_brief?.sourceRef : fact.sourceRef;
		if (!sourceRef) return [];
		const sourceVersion = evidence.find(e => e.ref === sourceRef)?.version ?? null;
		// Only reconstruct the same narrow correction when all original evidence is available.
		// Files/knowledge without their saved content cannot be treated as agreeing with the text.
		if (runtime.correctionProtocol === "requirement-extraction-correction.v1" && !baseline.facts.customer_attachments && !baseline.facts.knowledge_source &&
			comparable && previous.sourceVersion === sourceVersion && !candidate.missingRequiredFacts.some(k => normalizeRequirementFactKey("print", k) === fact.key) && facts.filter(f => f.key === fact.key).length === 1 &&
			correctExtractedQuantity({ ...fact, sourceRef }, current, evidence, String(facts.find(f => f.key === "product_type")?.value ?? baseline.facts.product_type?.value ?? ""))) return [];
		// Without a saved original source snapshot, retain the disagreement as unavailable, not verified evidence.
		const input = { key: fact.key, baseFactVersion: comparable ? current.version : open!.baseFactVersion, previous,
			proposed: { value: fact.value, ...(fact.unit ? { unit: fact.unit } : {}), sourceRef, sourceVersion }, comparison: comparison.status, reason: comparison.reason };
		const id = candidateConflictId(input);
		return [history.find(c => c.id === id) ?? { id, ...input, firstArtifactVersion: version }];
	});
	return [...new Map(comparisons.map(c => [c.id, c])).values()];
}

/** Reconstruct authored message evidence from the immutable source Fact, not a model report. */
export function messageEvidence(events: EnterpriseEvent[]): ReviewEvidence[] {
	return events.flatMap(event => {
		const data = event.data;
		if (data.type !== "fact.version_recorded" || data.factKey !== "customer_brief" || data.sourceType !== "user_input" || typeof data.value !== "string") return [];
		const original: ReviewEvidence[] = [{ ref: data.sourceRef, version: data.factVersion, content: { content: data.value } }];
		try {
			const parsed = JSON.parse(data.value);
			if (Array.isArray(parsed?.messages)) for (const message of parsed.messages) {
				if (typeof message?.sourceRef === "string" && typeof message?.content === "string") original.push({ ref: message.sourceRef, version: data.factVersion, content: message });
			}
		} catch { /* Plain authored customer text. */ }
		return original;
	});
}

export function previousCandidateSource(fact: FactVersionState, evidence: ReviewEvidence[], events: EnterpriseEvent[], artifacts: ArtifactContentStore, state: ProposalRunState): RequirementCandidateSource {
	let version: string | number | null = fact.sourceType === "user_input" ? fact.version : null;
	const recorded = events.find(e => e.data.type === "fact.version_recorded" && e.data.factKey === fact.key && e.data.factVersion === fact.version);
	if (recorded && version === null) version = messageEvidence(events.filter(e => e.aggregateVersion <= recorded.aggregateVersion)).findLast(e => e.ref === fact.sourceRef)?.version ?? null;
	// Uploaded attachment identities and selected evidence IDs are immutable. Their source versions are not Fact versions.
	if (version === null && /^(attachment:\/\/|kb-)/.test(fact.sourceRef)) version = evidence.find(e => e.ref === fact.sourceRef)?.version ?? null;
	if (version === null) {
		for (const artifact of state.proposalVersions.filter(v => v.artifactId === "requirement-brief" && v.inputFactVersions[fact.key] === fact.version)) {
			try {
				const review = artifacts.readJson({ ...state, artifactId: "requirement-brief-review-input", artifactVersion: artifact.version }) as { evidence: ReviewEvidence[] };
				version = review.evidence.find(e => e.ref === fact.sourceRef)?.version ?? null;
				if (version !== null) break;
			} catch (error) { if (!(error instanceof ArtifactStoreError) || error.code !== "artifact_not_found") throw error; }
		}
	}
	return { value: fact.value, ...(fact.unit ? { unit: fact.unit } : {}), sourceRef: fact.sourceRef, sourceVersion: version };
}

export function candidateConflictId(input: Omit<RequirementCandidateConflict, "id" | "firstArtifactVersion">) {
	return `candidate-${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseRequirementCandidate(value: string, industry: ManufacturingIndustry): RequirementBriefV1 | undefined {
	let parsed: unknown;
	try {
		// Strip only one complete Markdown wrapper; never guess corrections inside the JSON.
		const text = value.trim();
		const fence = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/.exec(text);
		parsed = JSON.parse(fence?.[1] ?? text);
	} catch {
		return undefined;
	}
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== "requirement-brief.v1" ||
		parsed.industry !== industry ||
		typeof parsed.title !== "string" ||
		typeof parsed.customerGoal !== "string" ||
		!Array.isArray(parsed.facts) ||
		!Array.isArray(parsed.missingRequiredFacts) || parsed.missingRequiredFacts.some((key) => typeof key !== "string") ||
		!Array.isArray(parsed.assumptions) || parsed.assumptions.some((item) => typeof item !== "string")
	) return undefined;
	return parsed as unknown as RequirementBriefV1;
}

export function candidateFacts(industry: ManufacturingIndustry, value: RequirementBriefV1): RequirementFactV1[] {
	return value.facts.flatMap((fact) => {
		if (
			!fact ||
			typeof fact !== "object" ||
			typeof fact.key !== "string" ||
			(typeof fact.value !== "string" && typeof fact.value !== "number" && typeof fact.value !== "boolean") ||
			typeof fact.value === "string" && !fact.value.trim() ||
			typeof fact.value === "number" && !Number.isFinite(fact.value) ||
			fact.unit !== undefined && (typeof fact.unit !== "string" || !fact.unit.trim())
		) return [];
		const key = normalizeRequirementFactKey(industry, fact.key);
		if (!key) return [];
		return [{
			key,
			version: 1,
			value: typeof fact.value === "string" ? fact.value.trim() : fact.value,
			...(fact.unit ? { unit: fact.unit.trim() } : {}),
			status: "unverified" as const,
			sourceType: "model_output" as const,
			sourceRef: typeof fact.sourceRef === "string" ? fact.sourceRef : "runtime-output",
		}];
	});
}
