import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateRequirementBrief, packagingFactKeys, requiredRequirementFacts } from "../src/manufacturing/requirementBrief";

const root = new URL("./fixtures/requirement-intake-v1/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), "utf8");
const hash = (content: string) => createHash("sha256").update(content).digest("hex");

interface Fact {
	key: string;
	value: string | number | boolean;
	unit?: string;
	status: "unverified" | "verified";
	confirmedBy?: string;
	evidence: Array<{ sourceId: string; quote: string }>;
}

interface ConfirmationFact {
	key: string;
	value: Fact["value"];
	unit?: string;
	evidenceSourceIds: string[];
}

type InputEvent =
	| { id: string; kind: "deliver_source"; sourceId: string }
	| { id: string; kind: "evaluate"; checkpointId: string; request: string }
	| { id: string; kind: "confirm_facts"; actor: string; guard: string; facts: ConfirmationFact[] }
	| { id: string; kind: "approve_artifact"; actor: string; guard: string; scope: string; checkpointId: string }
	| { id: string; kind: "withdraw_source"; actor: string; sourceId: string; reason: string };

interface IntakeCase {
	id: string;
	title: string;
	family: string;
	split: "development" | "holdout";
	provenance: string;
	task: string;
	sources: Array<{ id: string; name: string; kind: string; version: number; representation: string; content: string; sha256: string }>;
	events: InputEvent[];
}

interface Checkpoint {
	id: string;
	expectedFacts: Fact[];
	missingRequiredFacts: string[];
	schemaNextAction: string;
	schemaApprovalEligible: boolean;
	businessOutcome: string;
	businessApprovalAllowed: boolean;
	requiredNotes: string[];
	clarificationTopics: string[];
	forbiddenClaims: string[];
	artifactRequired: boolean;
}

interface Oracle {
	caseId: string;
	checkpoints: Checkpoint[];
	transitions: Array<{ fromCheckpoint: string; toCheckpoint: string; changedFactKeys: string[]; approvalEventId: string | null; checks: string[] }>;
}

const cases = JSON.parse(read("cases.json")) as IntakeCase[];
const oracles = JSON.parse(read("oracles.json")) as Oracle[];
const manifest = JSON.parse(read("manifest.json")) as {
	schemaVersion: string; status: string; caseCount: number; checkpointCount: number;
	development: string[]; holdout: string[]; files: Record<string, string>;
};

function unique(values: string[]) {
	assert.equal(new Set(values).size, values.length, `Duplicate IDs: ${values.join(", ")}`);
}

function validateCase(input: IntakeCase, oracle: Oracle) {
	assert.equal(input.provenance, "authored_synthetic");
	assert.equal(oracle.caseId, input.id);
	assert(input.task.trim() && input.title.trim());
	unique(input.sources.map((s) => s.id));
	unique(input.events.map((e) => e.id));
	unique(oracle.checkpoints.map((p) => p.id));
	const sources = new Map(input.sources.map((s) => [s.id, s]));
	const points = new Map(oracle.checkpoints.map((p) => [p.id, p]));
	const delivered = new Set<string>();
	const withdrawn = new Set<string>();
	const evaluated = new Map<string, number>();
	const confirmations = new Map<string, ConfirmationFact[]>();
	const approvals = new Map<string, string>();
	for (const source of input.sources) {
		assert(source.id.startsWith(`${input.id}-S`) && source.content.trim());
		assert.equal(source.version, 1);
		assert.equal(hash(source.content), source.sha256, `Source hash: ${source.id}`);
		assert(["authored_text", "metadata_only"].includes(source.representation));
		assert(["customer_message", "attachment"].includes(source.kind));
	}
	for (const [index, event] of input.events.entries()) {
		assert(event.id.startsWith(`${input.id}-E`));
		switch (event.kind) {
			case "deliver_source":
				assert(sources.has(event.sourceId) && !delivered.has(event.sourceId));
				delivered.add(event.sourceId);
				break;
			case "withdraw_source":
				assert.equal(event.actor, "authorized_operator");
				assert(delivered.has(event.sourceId) && !withdrawn.has(event.sourceId));
				assert(event.reason.trim());
				withdrawn.add(event.sourceId);
				break;
			case "confirm_facts":
				assert.equal(event.actor, "authorized_operator");
				assert.equal(event.guard, "matching_candidate_required");
				assert(evaluated.size > 0 && event.facts.length > 0, "No extraction checkpoint before confirmation");
				unique(event.facts.map((f) => f.key));
				for (const fact of event.facts) {
					assert(packagingFactKeys.includes(fact.key));
					assert(fact.evidenceSourceIds.length > 0);
					for (const id of fact.evidenceSourceIds) assert(delivered.has(id) && !withdrawn.has(id));
				}
				confirmations.set(event.id, event.facts);
				break;
			case "approve_artifact":
				assert.equal(event.actor, "authorized_operator");
				assert.equal(event.guard, "all_checkpoint_checks_passed");
				assert.equal(event.scope, "exact_current_artifact_version");
				assert(evaluated.has(event.checkpointId) && points.get(event.checkpointId)?.businessApprovalAllowed);
				approvals.set(event.id, event.checkpointId);
				break;
			case "evaluate": {
				assert(event.request.trim() && !evaluated.has(event.checkpointId));
				const point = points.get(event.checkpointId);
				assert(point, `Missing oracle: ${event.checkpointId}`);
				unique(point.expectedFacts.map((f) => f.key));
				assert.equal(point.artifactRequired, true);
				assert(["needs_clarification", "awaiting_confirmation", "ready_for_review"].includes(point.businessOutcome));
				assert.equal(point.businessApprovalAllowed, point.businessOutcome === "ready_for_review");
				assert.deepEqual([...point.missingRequiredFacts].sort(), requiredRequirementFacts.print.filter((k) => !point.expectedFacts.some((f) => f.key === k)).sort());
				for (const fact of point.expectedFacts) {
					assert(packagingFactKeys.includes(fact.key));
					assert(fact.evidence.length > 0);
					for (const evidence of fact.evidence) {
						assert(delivered.has(evidence.sourceId) && !withdrawn.has(evidence.sourceId), `Inactive/future evidence: ${evidence.sourceId}`);
						const source = sources.get(evidence.sourceId)!;
						assert.equal(source.representation, "authored_text", "Metadata is not field evidence");
						assert(evidence.quote.trim() && source.content.includes(evidence.quote), `Quote not in source: ${evidence.sourceId}/${fact.key}`);
						assert(typeof fact.value === "number"
							? evidence.quote.match(/\d+(?:\.\d+)?/g)?.includes(String(fact.value))
							: evidence.quote.includes(String(fact.value)), `Value not in cited quote: ${fact.key}`);
					}
					if (fact.status === "verified") {
						const action = confirmations.get(fact.confirmedBy ?? "")?.find((f) => f.key === fact.key);
						assert(action, `Missing earlier confirmation: ${fact.key}`);
						assert.deepEqual([action.value, action.unit], [fact.value, fact.unit]);
						assert.deepEqual([...action.evidenceSourceIds].sort(), fact.evidence.map((e) => e.sourceId).sort());
					} else {
						assert.equal(fact.status, "unverified");
						assert.equal(fact.confirmedBy, undefined);
					}
				}
				const evaluation = evaluateRequirementBrief({
					schemaVersion: "requirement-brief.v1", industry: "print", title: input.title, customerGoal: input.task,
					facts: point.expectedFacts.map((fact) => ({ key: fact.key, version: 1, value: fact.value, ...(fact.unit ? { unit: fact.unit } : {}), status: fact.status, sourceType: fact.status === "verified" ? "human_confirmation" : "model_output", sourceRef: fact.confirmedBy ?? fact.evidence[0].sourceId })),
					missingRequiredFacts: point.missingRequiredFacts, assumptions: point.requiredNotes, nextAction: point.schemaNextAction,
				});
				assert(evaluation.passed, JSON.stringify(evaluation.issues));
				assert.equal(evaluation.approvalEligible, point.schemaApprovalEligible);
				if (point.businessOutcome === "needs_clarification") assert(point.clarificationTopics.length > 0);
				if (point.schemaApprovalEligible && !point.businessApprovalAllowed) assert(point.requiredNotes.length > 0);
				evaluated.set(point.id, index);
				break;
			}
			default:
				assert.fail(`Unknown event: ${JSON.stringify(event)}`);
		}
	}
	assert.equal(delivered.size, input.sources.length);
	assert.equal(evaluated.size, oracle.checkpoints.length);
	for (const transition of oracle.transitions) {
		assert(evaluated.has(transition.fromCheckpoint) && evaluated.has(transition.toCheckpoint));
		assert(evaluated.get(transition.fromCheckpoint)! < evaluated.get(transition.toCheckpoint)!);
		for (const key of transition.changedFactKeys) assert(packagingFactKeys.includes(key));
		const before = new Map(points.get(transition.fromCheckpoint)!.expectedFacts.map((f) => [f.key, f]));
		const after = new Map(points.get(transition.toCheckpoint)!.expectedFacts.map((f) => [f.key, f]));
		const changed = [...new Set([...before.keys(), ...after.keys()])].filter((key) => JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)));
		assert.deepEqual(changed.sort(), [...transition.changedFactKeys].sort());
		assert(transition.checks.includes("previous_artifact_content_unchanged"));
		if (transition.approvalEventId) {
			assert.equal(approvals.get(transition.approvalEventId), transition.fromCheckpoint);
			assert(transition.checks.includes("previous_approval_superseded"));
		}
	}
}

describe("requirement-intake.v1 authored fixture integrity (not Agent performance)", () => {
	it("pins the input, oracle, readable casebook and scoring protocol", () => {
		expect(manifest.status).toBe("authored_not_model_evaluated");
		expect(Object.keys(manifest.files).sort()).toEqual(["CASEBOOK.md", "README.md", "cases.json", "oracles.json"].sort());
		for (const [name, expected] of Object.entries(manifest.files)) expect(hash(read(name))).toBe(expected);
	});

	it("keeps 16 cases in four families with three development and one reserved case each", () => {
		unique(cases.map((c) => c.id)); unique(oracles.map((o) => o.caseId));
		expect(cases).toHaveLength(16);
		expect(manifest.caseCount).toBe(cases.length);
		expect(manifest.checkpointCount).toBe(oracles.reduce((sum, o) => sum + o.checkpoints.length, 0));
		expect(oracles.map((o) => o.caseId).sort()).toEqual(cases.map((c) => c.id).sort());
		expect(manifest.development).toEqual(cases.filter((c) => c.split === "development").map((c) => c.id));
		expect(manifest.holdout).toEqual(cases.filter((c) => c.split === "holdout").map((c) => c.id));
		expect(new Set(cases.map((c) => c.family)).size).toBe(4);
		for (const family of new Set(cases.map((c) => c.family))) {
			expect(cases.filter((c) => c.family === family && c.split === "development")).toHaveLength(3);
			expect(cases.filter((c) => c.family === family && c.split === "holdout")).toHaveLength(1);
		}
	});

	it.each(cases)("$id has supported, temporally available evidence and explicit confirmation", (input) => {
		validateCase(input, oracles.find((o) => o.caseId === input.id)!);
	});

	it("rejects a fabricated citation, premature confirmation and revoked evidence", () => {
		const wrongQuote = structuredClone(oracles[0]);
		wrongQuote.checkpoints[0].expectedFacts[0].evidence[0].quote = "not present in the input";
		expect(() => validateCase(cases[0], wrongQuote)).toThrow(/Quote not in source/);
		const wrongValue = structuredClone(oracles[0]);
		wrongValue.checkpoints[0].expectedFacts.find((f) => f.key === "quantity")!.value = 3601;
		expect(() => validateCase(cases[0], wrongValue)).toThrow(/Value not in cited quote/);
		const premature = structuredClone(oracles[0]);
		premature.checkpoints[0].expectedFacts[0] = premature.checkpoints[1].expectedFacts[0];
		expect(() => validateCase(cases[0], premature)).toThrow(/Missing earlier confirmation/);
		const revoked = structuredClone(oracles[10]);
		const fact = revoked.checkpoints[1].expectedFacts[0];
		fact.evidence = revoked.checkpoints[0].expectedFacts.find((f) => f.key === "dimensions")!.evidence;
		expect(() => validateCase(cases[10], revoked)).toThrow(/Inactive\/future evidence/);
	});
});
