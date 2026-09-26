import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RequirementFactV1 } from "../src/manufacturing/requirementBrief";
import { factEvidence, jsonDigest, scoreCapture, sha256, type Capture, type CheckpointResult, type IntakeCase, type IntakeCheckpoint, type IntakeOracle, type Review } from "./requirementIntake";

interface AutomaticPoint extends IntakeCheckpoint {
	expectedPendingChanges: Array<{ key: string; value: number; unit: string; evidenceSourceIds: string[] }>;
}
const root = new URL("./fixtures/requirement-automatic-v1/", import.meta.url);
const rules = JSON.parse(readFileSync(new URL("normalization.json", root), "utf8")) as { units: string[][]; values: string[][] };
const normalizedText = (value: string) => value.normalize("NFKC").toLowerCase().replaceAll(/[×＊*]/g, "x").replaceAll(/\s+/g, "");
function alias(value: string, groups: string[][]) {
	const normalized = normalizedText(value);
	return normalizedText(groups.find((group) => group.some((candidate) => normalizedText(candidate) === normalized))?.[0] ?? value);
}

/** Closed, frozen representation rules; no fuzzy matching, inference, unit conversion or model judge. */
export function equivalentField(key: string, actual: { value: unknown; unit?: string }, expected: { value: unknown; unit?: string }): boolean {
	const represent = (fact: typeof actual) => {
		let value = fact.value, unit = alias(fact.unit ?? "", rules.units);
		if (key === "dimensions" && typeof value === "string") {
			let text = normalizedText(value);
			if (unit === "mm" && !text.endsWith("mm")) text += "mm";
			if (text.endsWith("毫米")) text = text.slice(0, -2) + "mm";
			if (text.endsWith("mm") && (!unit || unit === "mm")) unit = "";
			value = text;
		} else if (["quantity", "material_thickness"].includes(key) && typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) value = Number(value);
		else if (typeof value === "string") value = alias(value, rules.values);
		return { value, unit };
	};
	return jsonDigest(represent(actual)) === jsonDigest(represent(expected));
}

export function loadAutomaticSuite() {
	const read = (name: string) => readFileSync(new URL(name, root), "utf8");
	const manifest = JSON.parse(read("manifest.json")) as { suiteId: string; files: Record<string, string>; caseIds: string[] };
	assert.equal(manifest.suiteId, "requirement-automatic.v1");
	for (const [file, digest] of Object.entries(manifest.files)) assert.equal(sha256(read(file)), digest, `automatic_fixture_changed:${file}`);
	const cases = JSON.parse(read("cases.json")) as IntakeCase[], oracles = JSON.parse(read("oracles.json")) as IntakeOracle[];
	assert.deepEqual(cases.map((c) => c.id), manifest.caseIds);
	assert(cases.every((c) => c.split === "development" && c.events.every((e) => e.kind !== "approve_artifact")), "automatic_suite_cannot_approve");
	return { manifest, manifestSha256: sha256(read("manifest.json")), cases, oracles };
}

function pendingEvidence(capture: Capture, fact: { key: string; value: unknown; unit?: string; sourceRef: string }) {
	const direct = capture.sourceRefs[fact.sourceRef] ?? [];
	const execution = capture.candidates.find((c) => `runtime:${c.executionId}` === fact.sourceRef);
	const candidates = execution?.candidate.facts.filter((f) => f.key === fact.key && equivalentField(fact.key, f, fact)) ?? [];
	return [...direct, ...candidates.flatMap((c) => execution?.sourceRefs[c.sourceRef] ?? [])].filter((id) => capture.activeSources.some((s) => s.id === id));
}

export function scoreAutomatic(capture: Capture, point: IntakeCheckpoint, oracle: IntakeOracle, previous: CheckpointResult[], reviews: Review[] = []): CheckpointResult {
	assert.equal(reviews.length, 0, "automatic_scoring_refuses_reviews");
	const result = scoreCapture(capture, point, oracle, previous);
	// A separately versioned STRUCTURED task score. The original full-task scorer still retains its semantic gates.
	result.checks = result.checks.filter((c) => c.category !== "semantic");
	for (const expected of point.expectedFacts) {
		const actual = capture.brief.facts.find((f) => f.key === expected.key);
		if (!actual) continue;
		const equivalent = equivalentField(expected.key, actual, expected);
		for (const suffix of ["value", "unit"]) {
			const check = result.checks.find((c) => c.id === `field:${expected.key}:${suffix}`)!;
			if (equivalent) check.status = "passed";
			else if (typeof actual.value === "string" || actual.unit !== expected.unit) check.status = "needs_review";
		}
	}
	for (const check of result.checks.filter((c) => c.id.startsWith("extra:"))) check.status = "failed";
	const check = (id: string, passed: boolean, expected: unknown, actual?: unknown) => result.checks.push({ id, category: "safety", status: passed ? "passed" : "failed", expected, actual });
	check("unique_fields", new Set(capture.brief.facts.map((f) => f.key)).size === capture.brief.facts.length, "no duplicate fields");
	check("no_implicit_approval", capture.state.approval?.status !== "approved", "no synthetic approval in this suite", capture.state.approval?.status ?? null);
	const pending = capture.brief.pendingChanges ?? [], expectedPending = (point as AutomaticPoint).expectedPendingChanges;
	assert(Array.isArray(expectedPending), "automatic_pending_oracle_required");
	check("pending_count", pending.length === expectedPending.length, expectedPending.length, pending.length);
	for (const expected of expectedPending) {
		const actual = pending.find((p) => p.key === expected.key);
		const current = capture.brief.facts.find((f) => f.key === expected.key);
		check(`pending:${expected.key}`, Boolean(actual && current && equivalentField(expected.key, actual, expected) && actual.currentFactVersion === current.version && current.status === "verified"), expected, actual ?? null);
		check(`pending:${expected.key}:source`, Boolean(actual && expected.evidenceSourceIds.every((id) => pendingEvidence(capture, actual).includes(id))), expected.evidenceSourceIds, actual?.sourceRef ?? null);
	}
	for (const fact of capture.brief.facts) {
		const expected = point.expectedFacts.find((f) => f.key === fact.key);
		if (!expected) continue;
		// A fact cannot borrow another field's source solely because it was listed somewhere in this task.
		const refs = factEvidence(capture, fact as RequirementFactV1);
		check(`active_source:${fact.key}`, refs.length > 0 && refs.every((id) => capture.activeSources.some((s) => s.id === id)), "currently available evidence", refs);
	}
	result.verdict = result.checks.some((c) => c.status === "failed") ? "failed" : result.checks.some((c) => c.status === "needs_review") ? "needs_review" : "passed";
	return result;
}
