import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { auditIntakeReport, type RecordedIntakeReport } from "./requirementIntakeAudit";

const saved = gunzipSync(readFileSync("docs/evidence/requirement-intake-repairs-2026-09-25/trial-c.report.json.gz")).toString("utf8");
const report = () => JSON.parse(saved) as RecordedIntakeReport;

it("keeps historical assisted results separate from automatic evidence without mutating captures", () => {
	const input = report(), before = JSON.stringify(input), result = auditIntakeReport(input);
	expect(JSON.stringify(input)).toBe(before);
	expect(result.summary).toMatchObject({ started: 12, recordedPassed: 9, recordedFailed: 3, fullyAutomaticallyVerified: 0, plannedCheckpoints: 31, reachedCheckpoints: 29, currentUnresolvedCalls: 1 });
	expect(result.summary.reviewDependentChecks).toBe(input.reviews.length);
	expect(result.rows.find((r) => r.caseId === "RI-09")).toMatchObject({ recordedVerdict: "failed", allObservedDeterministicChecksPassed: true, fullyAutomaticallyVerified: false });
	expect(result.rows.find((r) => r.caseId === "RI-14")?.missingCheckpoints).toHaveLength(2);
});

it("counts failures as failures even when all other observed checks pass", () => {
	const input = report(), point = input.results[1].checkpoints[0];
	point.checks.find((c) => c.id === "field:quantity:status")!.status = "failed";
	point.verdict = "failed";
	const result = auditIntakeReport(input);
	expect(result.summary.started).toBe(12);
	expect(result.rows[1].deterministic.failed).toBe(1);
	expect(result.rows[1].allObservedDeterministicChecksPassed).toBe(false);
	expect(result.summary.recordedPassed).toBe(8);
});

it("does not treat unreviewed output or a partial trajectory as a completed automatic task", () => {
	const input = report(), result = input.results[1];
	result.status = "needs_review";
	result.checkpoints = result.checkpoints.slice(0, 1);
	const point = result.checkpoints[0];
	for (const check of point.checks) {
		if (check.actual && typeof check.actual === "object" && "review" in check.actual && "observed" in check.actual) {
			check.actual = check.actual.observed;
			check.status = "needs_review";
		}
	}
	point.verdict = "needs_review";
	const row = auditIntakeReport(input).rows[1];
	expect(row.recordedVerdict).toBe("needs_review");
	expect(row.reviewDependent.needs_review).toBeGreaterThan(0);
	expect(row.missingCheckpoints).toHaveLength(1);
	expect(row.fullyAutomaticallyVerified).toBe(false);
});

it("retains unstarted cases and refuses to silently remove a selected attempt", () => {
	const input = report();
	input.results[1] = { ...input.results[1], status: "not_started", checkpoints: [], traceEvents: [], executionDurationMs: 0 };
	input.calls = input.calls.filter((c) => c.caseId !== input.results[1].caseId);
	expect(auditIntakeReport(input).summary).toMatchObject({ selected: 12, started: 11, notStarted: 1 });
	input.results.pop();
	expect(() => auditIntakeReport(input)).toThrow("missing_or_duplicate_case_result");
});

it("rejects changed captures, detached reviews, omitted checks and mismatched suites", () => {
	let input = report();
	input.results[0].checkpoints[0].capture.brief.title = "changed";
	expect(() => auditIntakeReport(input)).toThrow("capture_changed");
	input = report(); input.reviews = [];
	expect(() => auditIntakeReport(input)).toThrow("review_not_in_report");
	input = report(); input.results[0].checkpoints[0].checks = input.results[0].checkpoints[0].checks.filter((c) => c.id !== "claims");
	expect(() => auditIntakeReport(input)).toThrow("required_check_missing");
	input = report(); input.manifestSha256 = "changed";
	expect(() => auditIntakeReport(input)).toThrow("audit_fixture_changed");
});
