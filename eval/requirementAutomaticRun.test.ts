import { expect, it } from "vitest";
import { loadAutomaticSuite } from "./requirementAutomatic";
import { attemptSummary, matrixPlan, matrixSummary, onlyOutputLimitUnknowns, priceProfiles, reviewedMatrix } from "./requirementAutomaticRun";
import { newIntakeResult } from "./requirementIntake";
import { boundedProvider, pricedUsage, reservedUsd, type Call, type Ledger } from "./requirementIntakeRun";

it("freezes 72 interleaved same-model attempts and 36 second-model attempts without duplicate identities", () => {
	const ids = loadAutomaticSuite().manifest.caseIds, plan = matrixPlan(ids);
	expect(plan).toHaveLength(108);
	expect(new Set(plan.map((a) => a.id)).size).toBe(108);
	expect(plan.slice(0, 72).every((a) => a.model === "deepseek-v4-flash")).toBe(true);
	expect(plan.slice(72).every((a) => a.model === "deepseek-v4-pro" && a.arm === "candidate")).toBe(true);
	for (const id of ids) for (const arm of ["baseline", "candidate"]) expect(plan.filter((a) => a.caseId === id && a.arm === arm && a.model === "deepseek-v4-flash")).toHaveLength(3);
	expect(plan[0].arm).not.toBe(plan[24].arm);
});

it("reviews only terminal output-limit failures, retains their full reserve, and rejects transport uncertainty", () => {
	const prior = { protocol: "requirement-automatic-matrix.v1", status: "stopped_unknown", usdLimit: 20, reservedUsd: 0.01, results: [{ id: "old", executionStatus: "completed" }], calls: [{ caseId: "old", kind: "generate", status: "unknown", error: "output_limit", reservationUsd: 0.01 }] };
	expect(reviewedMatrix(JSON.stringify(prior)).reservedUsd).toBe(0.01);
	expect(onlyOutputLimitUnknowns([])).toBe(false);
	expect(() => reviewedMatrix(JSON.stringify({ ...prior, calls: [{ ...prior.calls[0], error: "disconnected" }] }))).toThrow("only_received_output_limits_can_be_reviewed");
	expect(() => reviewedMatrix(JSON.stringify({ ...prior, calls: [{ ...prior.calls[0], status: "started" }] }))).toThrow("only_received_output_limits_can_be_reviewed");
	expect(() => reviewedMatrix(JSON.stringify({ ...prior, reservedUsd: 0 }))).toThrow("prior_budget_mismatch");
});

it("an independent attempt cannot spend the reserve retained for a failed predecessor", async () => {
	let generations = 0;
	const local: Ledger = { usdLimit: 0.1, priorReservedUsd: 0.095, calls: [] };
	const provider = boundedProvider({ async countTokens() { return 1000; }, async generate() { generations++; throw new Error("should_not_send"); } }, local, "new-attempt", () => "event", () => {});
	await expect(provider.generate({ messages: [], tools: [], maxOutputTokens: 8192, fallbackOutput: "" })).rejects.toThrow("usd_limit");
	expect(generations).toBe(0); expect(reservedUsd(local)).toBe(0.095);
});

it("requires the exact reviewed request identity for one transport-terminated generation and retains its reserve", () => {
	const requestSha256 = "a".repeat(64);
	const prior = { protocol: "requirement-automatic-matrix.v1", status: "stopped_unknown", usdLimit: 20, reservedUsd: 0.04, results: [{ id: "old", executionStatus: "failed" }], calls: [{ caseId: "old", kind: "generate", status: "unknown", error: "terminated", requestSha256, reservationUsd: 0.04 }] };
	expect(() => reviewedMatrix(JSON.stringify(prior))).toThrow("only_received_output_limits_can_be_reviewed");
	expect(() => reviewedMatrix(JSON.stringify(prior), "b".repeat(64))).toThrow("review_must_identify_one_terminated_generation");
	expect(() => reviewedMatrix(JSON.stringify({ ...prior, calls: [prior.calls[0], prior.calls[0]] }), requestSha256)).toThrow("review_must_identify_one_terminated_generation");
	expect(reviewedMatrix(JSON.stringify(prior), requestSha256).reservedUsd).toBe(0.04);
});

it("reports unstarted attempts, failures and unknown costs instead of silently reducing the denominator", () => {
	const suite = loadAutomaticSuite(), plan = matrixPlan(suite.manifest.caseIds), result = newIntakeResult(suite.cases[0]);
	result.status = "failed"; result.error = "model_failure";
	const summary = matrixSummary(plan, [attemptSummary(plan[0], result, [])]);
	expect(summary[0]).toMatchObject({ planned: 36, recorded: 1, notRecorded: 35, passed: 0, failed: 1, passRateStarted: 0, knownCostPerSuccessUsd: null });
	expect(summary[1]).toMatchObject({ planned: 36, recorded: 0, notRecorded: 36, passRateStarted: null });
});

it("counts received failure usage in task cost without treating the task or call as completed", () => {
	const suite = loadAutomaticSuite(), plan = matrixPlan(suite.manifest.caseIds), result = newIntakeResult(suite.cases[0]);
	result.status = "failed";
	const call: Call = { caseId: plan[0].id, eventId: "review", kind: "generate", purpose: "evidence_review", status: "unknown", error: "output_limit", request: {}, requestSha256: "frozen", startedAt: "2026-09-26", reservationUsd: 0.02,
		failedResponse: { usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 8192, reasoningOutputTokens: 0 }, telemetry: { model: "model", stopReason: "max_tokens", inputTokens: 100, outputTokens: 8192, cacheReadTokens: null, cacheWriteTokens: null } } };
	const measured = attemptSummary(plan[0], result, [call]);
	expect(measured).toMatchObject({ verdict: "failed", unresolvedCalls: 1, unavailableUsageCalls: 0, usage: { outputTokens: 8192 } });
	expect(measured.knownUsageUsd).toBeCloseTo(0.0098604);
	expect(matrixSummary(plan, [measured])[0]).toMatchObject({ passed: 0, failed: 1, hasUnknownUsage: false });
	delete call.failedResponse;
	expect(matrixSummary(plan, [attemptSummary(plan[0], result, [call])])[0].hasUnknownUsage).toBe(true);
});

it("reserves the actual model profile and preserves its uncertain cost without allowing another call", async () => {
	const ledger: Ledger = { usdLimit: 0.1, calls: [] }; let calls = 0;
	const bounded = boundedProvider({ async countTokens() { return 1000; }, async generate() { calls++; throw new Error("disconnected"); } }, ledger, "attempt", () => "event", () => {}, priceProfiles["deepseek-v4-pro"]);
	const request = { messages: [], tools: [], maxOutputTokens: 8192, fallbackOutput: "" };
	await expect(bounded.generate(request)).rejects.toThrow("disconnected");
	expect(reservedUsd(ledger)).toBeCloseTo((1000 * 1.32 + 8192 * 3.96) / 1e6);
	await expect(bounded.generate(request)).rejects.toThrow("unresolved_call_blocks_batch");
	expect(calls).toBe(1);
	expect(pricedUsage({ text: "", toolCalls: [], usage: { inputTokens: 1000, cachedInputTokens: 2000, outputTokens: 100, reasoningOutputTokens: 50 } }, priceProfiles["deepseek-v4-pro"])).toBeCloseTo(0.001804);
});
