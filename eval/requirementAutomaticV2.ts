import { compareRequirementField } from "../src/manufacturing/requirementField";
import { scoreAutomatic } from "./requirementAutomatic";

/** Separate score version. Historical v1 reports and normalization stay immutable. */
export const automaticProtocolV2 = "requirement-automatic.v2";
export const scoreAutomaticV2: typeof scoreAutomatic = (capture, point, oracle, previous, reviews = []) => {
	const result = scoreAutomatic(capture, point, oracle, previous, reviews);
	for (const expected of point.expectedFacts) {
		const actual = capture.brief.facts.find((fact) => fact.key === expected.key);
		if (!actual) continue;
		const comparison = compareRequirementField(expected.key, actual, expected);
		for (const suffix of ["value", "unit"]) {
			const check = result.checks.find((check) => check.id === `field:${expected.key}:${suffix}`);
			if (check) {
				check.status = comparison.status === "equivalent" ? "passed" : comparison.status === "different" ? "failed" : "needs_review";
				check.reason = comparison.reason;
			}
		}
	}
	// Source, authority, version, missing fields, approval and artifact checks remain independent.
	result.verdict = result.checks.some((check) => check.status === "failed") ? "failed" : result.checks.some((check) => check.status === "needs_review") ? "needs_review" : "passed";
	return result;
};
