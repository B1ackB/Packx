import { describe, expect, it } from "vitest";
import { requirementBriefFixtures } from "./requirementBrief.fixtures";
import { createRequirementBrief, evaluateRequirementBrief, normalizeRequirementFactKey } from "./requirementBrief";

describe("M2 Requirement Brief baseline", () => {
	it("keeps specific required questions until their fields are supplied without reopening optional specifications", () => {
		const baseline = structuredClone(requirementBriefFixtures[0].artifact);
		const missing = createRequirementBrief({ ...baseline, facts: baseline.facts.filter((f) => !["dimensions", "quantity"].includes(f.key)), assumptions: ["不得使用 PVC"] });
		expect(missing.assumptions.join()).toContain("宽、高、底折");
		expect(missing.assumptions.join()).toContain("内尺寸或外尺寸");
		expect(missing.assumptions.join()).toContain("每卷/箱数量");
		expect(missing.assumptions.join()).not.toContain("厚度");
		const supplied = createRequirementBrief({ ...baseline, assumptions: missing.assumptions });
		expect(supplied.assumptions).toEqual(["不得使用 PVC"]);
		expect(supplied.facts).toEqual(baseline.facts);
	});
	it("keeps optional packaging details in drafts and requires their explicit confirmation before approval", () => {
		const baseline = structuredClone(requirementBriefFixtures[0].artifact);
		const material = { ...baseline.facts[0], key: "material_structure", value: "模拟客户材料说明，尚待核对", status: "unverified" as const, sourceType: "model_output" as const };
		const draft = createRequirementBrief({ ...baseline, facts: [...baseline.facts, material] });
		expect(draft.missingRequiredFacts).toEqual([]);
		expect(draft.nextAction).toBe("confirm_facts");
		expect(evaluateRequirementBrief(draft)).toMatchObject({ passed: true, approvalEligible: false });
		const confirmed = createRequirementBrief({ ...draft, facts: draft.facts.map((fact) => fact.key === material.key ? { ...fact, status: "verified", sourceType: "human_confirmation" } : fact) });
		expect(evaluateRequirementBrief(confirmed).approvalEligible).toBe(true);
		expect(evaluateRequirementBrief(baseline).approvalEligible).toBe(true);
	});
	it("rejects retired industries and their fields in new artifacts", () => {
		const artifact = structuredClone(requirementBriefFixtures[0]!.artifact);
		expect(evaluateRequirementBrief({ ...artifact, industry: "furniture" })).toMatchObject({ passed: false, approvalEligible: false, issues: expect.arrayContaining([expect.objectContaining({ code: "invalid_industry" })]) });
		artifact.facts.push({ ...artifact.facts[0], key: "installation_required", value: true });
		expect(evaluateRequirementBrief(artifact)).toMatchObject({ passed: false, approvalEligible: false, issues: expect.arrayContaining([expect.objectContaining({ code: "unsupported_fact" })]) });
	});
	it("keeps ten packaging tasks on one deterministic contract", () => {
		expect(requirementBriefFixtures).toHaveLength(10);
		expect(new Set(requirementBriefFixtures.map((fixture) => fixture.industry))).toEqual(
			new Set(["print"]),
		);
		for (const fixture of requirementBriefFixtures) {
			expect(evaluateRequirementBrief(fixture.artifact), fixture.fixtureId).toMatchObject({
				passed: true,
				approvalEligible: fixture.expectedApprovalEligible,
			});
		}
	});

	it("refuses to treat model output as a verified Fact", () => {
		const artifact = structuredClone(requirementBriefFixtures[0]!.artifact);
		artifact.facts[0] = {
			...artifact.facts[0]!,
			sourceType: "model_output",
			status: "verified",
		};

		expect(evaluateRequirementBrief(artifact)).toMatchObject({
			passed: false,
			approvalEligible: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: "invalid_authority" })]),
		});
	});

	it("requires the declared gap and next action to match the actual Facts", () => {
		const artifact = structuredClone(requirementBriefFixtures[1]!.artifact);
		artifact.missingRequiredFacts = [];
		artifact.nextAction = "ready_for_approval";

		expect(evaluateRequirementBrief(artifact)).toMatchObject({
			passed: false,
			approvalEligible: false,
			issues: expect.arrayContaining([
				expect.objectContaining({ code: "missing_fact_mismatch" }),
				expect.objectContaining({ code: "invalid_next_action" }),
			]),
		});
	});

	it("normalizes known aliases and rejects non-canonical Artifact Facts", () => {
		expect(normalizeRequirementFactKey("print", "Packaging Type")).toBe("product_type");
		expect(normalizeRequirementFactKey("print", "quantity_reference")).toBe("quantity");
		expect(normalizeRequirementFactKey("print", "installation_required")).toBeUndefined();

		const artifact = structuredClone(requirementBriefFixtures[5]!.artifact);
		artifact.facts.push({
			key: "focus_areas",
			version: 1,
			value: "尺寸与稿件",
			status: "unverified",
			sourceType: "model_output",
			sourceRef: "runtime:test",
		});
		expect(evaluateRequirementBrief(artifact)).toMatchObject({
			passed: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: "unsupported_fact" })]),
		});
	});
});
