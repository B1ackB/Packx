import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { scoreReview, type ReviewCase } from "./evidenceReviewComparison";

const suite = JSON.parse(readFileSync("eval/fixtures/evidence-review-output/cases.json", "utf8")) as { cases: ReviewCase[] };
it("keeps the closed controls out of prompts and rejects missing or irrelevant detections", () => {
	expect(suite.cases).toHaveLength(9);
	for (const input of suite.cases) {
		expect(input.request.tools).toEqual([]);
		expect(input.request).not.toHaveProperty("expected");
		if (input.expected.kind === "detect_issue") {
			expect(scoreReview(input, '{"issues":[]}').controlPassed).toBe(false);
			const issue = { kind: input.expected.issueKinds![0], location: input.expected.locations![0], reason: input.expected.reasonTerms![0], evidenceRefs: ["RI-13-S01"], suggestedAction: "request_input" };
			expect(scoreReview(input, JSON.stringify({ issues: [issue] })).controlPassed).toBe(true);
			expect(scoreReview(input, JSON.stringify({ issues: [{ ...issue, reason: "unrelated issue" }] })).controlPassed).toBe(false);
			expect(() => scoreReview(input, JSON.stringify({ issues: [{ ...issue, evidenceRefs: ["invented"] }] }))).toThrow();
		}
	}
	expect(scoreReview(suite.cases.find(c => c.id === "clean-control")!, '{"issues":[]}').controlPassed).toBe(true);
	expect(scoreReview(suite.cases[0], '{"issues":[]}').controlPassed).toBeNull();
});
