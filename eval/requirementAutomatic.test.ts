import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AgentModelProvider } from "../src/agent/contracts";
import { createRequirementBrief } from "../src/manufacturing/requirementBrief";
import { equivalentField, loadAutomaticSuite, scoreAutomatic } from "./requirementAutomatic";
import { executeIntakeCase, jsonDigest, newIntakeResult, verdict, type CheckpointResult, type IntakeResult } from "./requirementIntake";

const suite = loadAutomaticSuite(), root = mkdtempSync(join(tmpdir(), "packx-automatic-qualification-"));
const runs: IntakeResult[] = [];
beforeAll(async () => {
	for (const input of suite.cases) {
		const result = newIntakeResult(input), oracle = suite.oracles.find((o) => o.caseId === input.id)!;
		const provider: AgentModelProvider = { async generate(request) {
			if (request.outputSchema?.properties && typeof request.outputSchema.properties === "object" && "issues" in request.outputSchema.properties) return { text: '{"issues":[]}', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
			const event = input.events[result.nextEvent];
			if (event.kind !== "evaluate") throw new Error("unexpected_generation");
			const point = oracle.checkpoints.find((p) => p.id === event.checkpointId)!;
			const pending = (point as typeof point & { expectedPendingChanges: Array<{ key: string; value: number; unit: string; evidenceSourceIds: string[] }> }).expectedPendingChanges;
			const facts = point.expectedFacts.map((f) => {
				const change = pending.find((p) => p.key === f.key);
				const sourceId = change?.evidenceSourceIds[0] ?? f.evidence[0].sourceId;
				const sourceRef = Object.entries(result.sourceRefs).find(([ref, ids]) => ref.startsWith("attachment://") && ids.includes(sourceId))?.[0] ?? sourceId;
				return { key: f.key, value: change?.value ?? f.value, ...(f.unit ? { unit: change?.unit ?? f.unit } : {}), version: 1, status: "unverified" as const, sourceType: "model_output" as const, sourceRef };
			});
			return { text: JSON.stringify(createRequirementBrief({ industry: "print", title: "离线参考结果", customerGoal: "整理结构化需求供人工核对", facts, assumptions: [] })), toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } };
		} };
		await executeIntakeCase({ input, oracle, result, directory: join(root, input.id), provider, score: scoreAutomatic, save() {} });
		runs.push(result);
	}
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("executes 12 scripted reference scenarios and all 31 checkpoints through the production workflow", () => {
	expect(runs.map((r) => ({ id: r.caseId, verdict: verdict(r), error: r.error, failures: r.checkpoints.flatMap((p) => p.checks.filter((c) => c.status !== "passed")) }))).toEqual(suite.cases.map((c) => ({ id: c.id, verdict: "passed", error: undefined, failures: [] })));
	expect(runs.flatMap((r) => r.checkpoints)).toHaveLength(31);
	expect(runs.flatMap((r) => r.operations).some((o) => o.kind === "approve_artifact")).toBe(false);
});

it("accepts only frozen representation equivalences and preserves dimension units and order", () => {
	expect(equivalentField("quantity", { value: "3600", unit: "个" }, { value: 3600, unit: "pcs" })).toBe(true);
	expect(equivalentField("dimensions", { value: "外径90×高135", unit: "mm" }, { value: "外径 90 × 高 135 mm" })).toBe(true);
	expect(equivalentField("dimensions", { value: "外径90×高135mm", unit: "cm" }, { value: "外径 90 × 高 135 mm" })).toBe(false);
	expect(equivalentField("dimensions", { value: "内径90×高135mm" }, { value: "外径 90 × 高 135 mm" })).toBe(false);
	expect(equivalentField("quantity", { value: "3600 pcs" }, { value: 3600, unit: "pcs" })).toBe(false);
	expect(equivalentField("quantity", { value: 3600, unit: "卷" }, { value: 3600, unit: "pcs" })).toBe(false);
});

it.each(["quantity", "unit", "source", "verified", "missing", "duplicate", "approval", "artifact"])("rejects a %s mutant without letting other good fields hide it", (mutation) => {
	const point = structuredClone(runs[0].checkpoints[0]), capture = point.capture;
	const fact = capture.brief.facts.find((f) => f.key === "quantity")!;
	if (mutation === "quantity") fact.value = 999;
	if (mutation === "unit") fact.unit = "卷";
	if (mutation === "source") fact.sourceRef = "withdrawn:missing";
	if (mutation === "verified") fact.status = "verified";
	if (mutation === "missing") capture.brief.facts = capture.brief.facts.filter((f) => f.key !== "quantity");
	if (mutation === "duplicate") capture.brief.facts.push(structuredClone(fact));
	if (mutation === "approval") capture.state.approval = { approvalId: "unauthorized", artifactId: "requirement-brief", artifactVersion: capture.state.currentProposal!.version, status: "approved" };
	if (mutation === "artifact") capture.artifactVersions = [];
	else capture.artifactVersions = [{ version: capture.state.currentProposal!.version, sha256: jsonDigest(capture.brief) }];
	const oracle = suite.oracles[0];
	expect(scoreAutomatic(capture, oracle.checkpoints[0], oracle, []).verdict).not.toBe("passed");
});

it("requires the new proposal, its current fact version and its actual new source", () => {
	const run = runs.find((r) => r.caseId === "AI-09")!, oracle = suite.oracles.find((o) => o.caseId === run.caseId)!;
	const index = run.checkpoints.findIndex((p) => p.capture.id === "pending_change"), point = oracle.checkpoints.find((p) => p.id === "pending_change")!;
	for (const mutation of ["delete", "old_source", "wrong_version"]) {
		const capture = structuredClone(run.checkpoints[index].capture);
		if (mutation === "delete") capture.brief.pendingChanges = [];
		else if (mutation === "old_source") capture.brief.pendingChanges![0].sourceRef = "RI-09-S01";
		else capture.brief.pendingChanges![0].currentFactVersion += 1;
		capture.artifactVersions.find((a) => a.version === capture.state.currentProposal!.version)!.sha256 = jsonDigest(capture.brief);
		expect(scoreAutomatic(capture, point, oracle, run.checkpoints.slice(0, index)).verdict).toBe("failed");
	}
});

it("keeps unknown wording unresolved and refuses review injection", () => {
	const capture = structuredClone(runs[0].checkpoints[0].capture), oracle = suite.oracles[0];
	capture.brief.facts.find((f) => f.key === "product_type")!.value = "unlisted wording";
	capture.artifactVersions[0].sha256 = jsonDigest(capture.brief);
	const result = scoreAutomatic(capture, oracle.checkpoints[0], oracle, []);
	expect(result.checks.find((c) => c.id === "field:product_type:value")?.status).toBe("needs_review");
	expect(result.verdict).not.toBe("passed");
	expect(() => scoreAutomatic(capture, oracle.checkpoints[0], oracle, [] as CheckpointResult[], [{} as never])).toThrow("automatic_scoring_refuses_reviews");
});
