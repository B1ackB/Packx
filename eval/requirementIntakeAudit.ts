import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { jsonDigest, loadIntakeSuite, sha256, verdict, type IntakeCheckpoint, type IntakeResult, type Review } from "./requirementIntake";
import type { Call } from "./requirementIntakeRun";

export interface RecordedIntakeReport {
	protocol: string;
	model: string;
	manifestSha256: string;
	sourceSha256: string;
	scoringProtocolSha256: string;
	caseIds: string[];
	results: IntakeResult[];
	calls: Call[];
	reviews: Review[];
}

/** Read-only accounting of saved judgments. Never regrades old captures with today's production rules. */
export function auditIntakeReport(report: RecordedIntakeReport) {
	const suite = loadIntakeSuite();
	assert(/^requirement-intake-online\.v[2-5]$/.test(report.protocol), "unsupported_recorded_protocol");
	assert.equal(report.manifestSha256, suite.manifestSha256, "audit_fixture_changed");
	assert(Array.isArray(report.results) && Array.isArray(report.calls) && Array.isArray(report.reviews), "invalid_report_arrays");
	assert(Array.isArray(report.caseIds) && report.caseIds.length > 0 && new Set(report.caseIds).size === report.caseIds.length, "invalid_case_selection");
	assert.deepEqual(report.results.map((r) => r.caseId).sort(), [...report.caseIds].sort(), "missing_or_duplicate_case_result");
	const rows = report.results.map((result) => {
		const oracle = suite.oracles.find((o) => o.caseId === result.caseId);
		assert(oracle, "unknown_case");
		assert(["not_started", "running", "completed", "needs_review", "failed", "interrupted"].includes(result.status), "invalid_execution_status");
		assert(Array.isArray(result.checkpoints) && Array.isArray(result.traceEvents), "invalid_case_arrays");
		assert(Number.isFinite(result.executionDurationMs) && result.executionDurationMs >= 0, "invalid_duration");
		assert(new Set(result.checkpoints.map((p) => p.capture.id)).size === result.checkpoints.length, "duplicate_checkpoint");
		if (result.status === "not_started") assert.equal(result.checkpoints.length, 0, "unstarted_case_has_capture");
		const deterministic = { passed: 0, failed: 0 };
		const reviewDependent = { passed: 0, failed: 0, needs_review: 0 };
		const reviewMethods: Record<string, number> = {};
		const failures: Array<{ checkpointId: string; checkId: string; grading: "deterministic" | "review" }> = [];
		for (const point of result.checkpoints) {
			const expected: IntakeCheckpoint | undefined = oracle.checkpoints.find((p) => p.id === point.capture.id);
			assert(expected, "unknown_checkpoint");
			assert.equal(point.captureSha256, jsonDigest(point.capture), "capture_changed");
			assert(Array.isArray(point.checks) && point.checks.length > 0, "missing_checks");
			assert(new Set(point.checks.map((c) => c.id)).size === point.checks.length, "duplicate_check");
			const requiredIds: string[] = ["schema", "persisted_artifact", "missing", "next_action", "schema_approval", "business_approval", "claims",
				...expected.requiredNotes.map((_, i) => `note:${i}`), ...expected.clarificationTopics.map((_, i) => `question:${i}`), ...expected.forbiddenClaims.map((_, i) => `forbidden:${i}`)];
			assert(requiredIds.every((id) => point.checks.some((c) => c.id === id)), "required_check_missing");
			for (const check of point.checks) {
				assert(["passed", "failed", "needs_review"].includes(check.status), "invalid_check_status");
				const review = check.actual && typeof check.actual === "object" && "review" in check.actual ? check.actual.review as Review : undefined;
				const dependent = Boolean(review) || check.status === "needs_review" || check.category === "semantic";
				if (review) {
					assert(["human", "codex_assisted"].includes(review.method), "unknown_review_method");
					assert.equal(review.caseId, result.caseId, "review_case_changed");
					assert.equal(review.checkpointId, point.capture.id, "review_checkpoint_changed");
					assert.equal(review.captureSha256, point.captureSha256, "review_capture_changed");
					assert.equal(review.checkId, check.id, "review_check_changed");
					assert.equal(review.decision, check.status, "review_decision_changed");
					assert(report.reviews.some((r) => jsonDigest(r) === jsonDigest(review)), "review_not_in_report");
					reviewMethods[review.method] = (reviewMethods[review.method] ?? 0) + 1;
				} else if (check.category === "semantic") assert.equal(check.status, "needs_review", "semantic_verdict_without_review");
				if (dependent) reviewDependent[check.status]++;
				else {
					assert(check.status !== "needs_review");
					deterministic[check.status]++;
				}
				if (check.status === "failed") failures.push({ checkpointId: point.capture.id, checkId: check.id, grading: dependent ? "review" : "deterministic" });
			}
			assert.equal(point.verdict, point.checks.some((c) => c.status === "failed") ? "failed" : point.checks.some((c) => c.status === "needs_review") ? "needs_review" : "passed", "checkpoint_verdict_changed");
		}
		const missingCheckpoints = oracle.checkpoints.filter((p) => !result.checkpoints.some((c) => c.capture.id === p.id)).map((p) => p.id);
		const reviewRequired = Object.values(reviewDependent).reduce((sum, n) => sum + n, 0);
		const fullCheckpointCoverage = missingCheckpoints.length === 0;
		const tools = result.traceEvents.filter((e) => e.type === "tool.completed");
		return {
			caseId: result.caseId, split: result.split, executionStatus: result.status, recordedVerdict: verdict(result),
			plannedCheckpoints: oracle.checkpoints.length, reachedCheckpoints: result.checkpoints.length, missingCheckpoints,
			deterministic, reviewDependent, reviewMethods, failures,
			allObservedDeterministicChecksPassed: deterministic.passed > 0 && deterministic.failed === 0,
			fullyAutomaticallyVerified: result.status === "completed" && fullCheckpointCoverage && deterministic.passed > 0 && deterministic.failed === 0 && reviewRequired === 0,
			generationCalls: report.calls.filter((c) => c.caseId === result.caseId && c.kind === "generate").length,
			toolCalls: tools.length, toolFailures: tools.filter((e) => e.status !== "succeeded").length,
			compactions: result.traceEvents.filter((e) => e.type === "context.compacted").length,
			executionDurationMs: result.executionDurationMs, error: result.error ?? null,
		};
	});
	for (const call of report.calls) {
		assert(report.caseIds.includes(call.caseId), "call_case_not_selected");
		assert(["count", "generate"].includes(call.kind) && ["started", "completed", "unknown"].includes(call.status), "invalid_call");
	}
	const started = rows.filter((r) => r.executionStatus !== "not_started");
	return {
		protocol: "requirement-intake-recorded-audit.v1",
		mode: "offline_recorded_evidence_only",
		original: { protocol: report.protocol, model: report.model, manifestSha256: report.manifestSha256, sourceSha256: report.sourceSha256, scoringProtocolSha256: report.scoringProtocolSha256 },
		limitations: [
			"Historical trajectory includes scripted confirmations and may include review-dependent approvals; this is not a new unattended run.",
			"No current-code regrading, new model calls, causal comparison, or user productivity measurement.",
			"All observed deterministic checks passing is not full-task success; missing checkpoints and review-dependent checks remain visible.",
			"Source-ID association is not semantic entailment. Costs and earlier unknown calls remain in the original ledger; this audit does not recompute them.",
		],
		summary: {
			selected: rows.length, started: started.length, notStarted: rows.length - started.length,
			recordedPassed: started.filter((r) => r.recordedVerdict === "passed").length,
			recordedFailed: started.filter((r) => r.recordedVerdict === "failed").length,
			recordedNeedsReview: started.filter((r) => r.recordedVerdict === "needs_review").length,
			fullyAutomaticallyVerified: started.filter((r) => r.fullyAutomaticallyVerified).length,
			casesWithAllObservedDeterministicChecksPassed: started.filter((r) => r.allObservedDeterministicChecksPassed).length,
			plannedCheckpoints: rows.reduce((sum, r) => sum + r.plannedCheckpoints, 0),
			reachedCheckpoints: rows.reduce((sum, r) => sum + r.reachedCheckpoints, 0),
			deterministicPassed: rows.reduce((sum, r) => sum + r.deterministic.passed, 0),
			deterministicFailed: rows.reduce((sum, r) => sum + r.deterministic.failed, 0),
			reviewDependentChecks: rows.reduce((sum, r) => sum + Object.values(r.reviewDependent).reduce((n, v) => n + v, 0), 0),
			unresolvedReviewChecks: rows.reduce((sum, r) => sum + r.reviewDependent.needs_review, 0),
			currentUnresolvedCalls: report.calls.filter((c) => c.status !== "completed").length,
		},
		rows,
	};
}

export function main() {
	const { values } = parseArgs({ options: { report: { type: "string" }, output: { type: "string" } } });
	assert(values.report, "report_path_required");
	const file = readFileSync(resolve(values.report));
	const bytes = values.report.endsWith(".gz") ? gunzipSync(file) : file;
	const report = JSON.parse(bytes.toString("utf8")) as RecordedIntakeReport;
	const output = { inputFileSha256: sha256(file), inputReportSha256: sha256(bytes), ...auditIntakeReport(report) };
	const json = JSON.stringify(output, null, "\t") + "\n";
	if (values.output) writeFileSync(resolve(values.output), json, { flag: "wx", mode: 0o600 });
	else process.stdout.write(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
