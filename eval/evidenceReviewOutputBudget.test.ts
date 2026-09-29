import { expect, it, vi } from "vitest";
import { AnthropicGenerationError } from "../server/runtime/anthropicModelProvider";
import { boundedProvider, reservedUsd, type Ledger } from "./requirementIntakeRun";
import { blockingUnknown, budgetCases, budgetRequest } from "./evidenceReviewOutputBudget";

it("changes only the output cap, keeps both control types, and excludes quarantined inputs", () => {
	const cases = budgetCases();
	expect(cases.map(input => input.id)).not.toContain("clean-control");
	expect(cases.map(input => input.id)).not.toContain("received-limit-83");
	expect(cases.filter(input => input.expected.kind === "no_issues")).toHaveLength(2);
	for (const input of cases) {
		const baseline = budgetRequest(input, 8192), candidate = budgetRequest(input, 16384);
		expect(baseline).toEqual(input.request);
		expect({ ...candidate, maxOutputTokens: 8192 }).toEqual(baseline);
	}
	expect(() => budgetRequest(cases[0], 32768)).toThrow("invalid_output_budget");
});

it("reserves the larger cap, stops unknowns, retains received truncation cost and never retries", async () => {
	const request = budgetRequest(budgetCases()[0], 16384);
	const usage = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 16384, reasoningOutputTokens: 0 };
	const generate = vi.fn(async () => { throw new AnthropicGenerationError("output_limit", "truncated", 422, usage, { model: "fixture", stopReason: "max_tokens", inputTokens: 1000, outputTokens: 16384, cacheReadTokens: 0, cacheWriteTokens: 0 }); });
	const ledger: Ledger = { usdLimit: 2, calls: [] };
	const provider = boundedProvider({ generate, async countTokens() { return 1000; } }, ledger, "fixture", () => "review", () => {});
	await expect(provider.generate(request)).rejects.toMatchObject({ code: "output_limit" });
	expect(reservedUsd(ledger)).toBeCloseTo((1000 * 0.3 + 16384 * 1.2) / 1e6);
	expect(blockingUnknown(ledger.calls)).toBe(false);
	await expect(provider.generate(request)).rejects.toThrow("unresolved_call_blocks_batch");
	expect(generate).toHaveBeenCalledTimes(1);
	const missing = structuredClone(ledger.calls); delete missing.at(-1)!.failedResponse;
	expect(blockingUnknown(missing)).toBe(true);
	const poor: Ledger = { usdLimit: 0.001, calls: [] };
	await expect(boundedProvider({ generate, async countTokens() { return 1000; } }, poor, "over-budget", () => "review", () => {}).generate(request)).rejects.toThrow("usd_limit");
	expect(generate).toHaveBeenCalledTimes(1);
	const broken: Ledger = { usdLimit: 2, calls: [] };
	await expect(boundedProvider({ async generate() { throw new Error("network"); }, async countTokens() { return 1000; } }, broken, "unknown", () => "review", () => {}).generate(request)).rejects.toThrow();
	expect(blockingUnknown(broken.calls)).toBe(true);
});
