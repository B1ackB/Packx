import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import type { AgentModelProvider } from "../src/agent/contracts";
import { requirementEvidencePolicy } from "../server/manufacturing/requirementEvidencePolicy";
import { AnthropicMessagesClient } from "../server/anthropic/client";
import { AnthropicModelProvider } from "../server/runtime/anthropicModelProvider";
import { ModelSettings } from "../server/modelSettings";
import { routingPassed } from "./evidenceReviewBoundary";
import { scoreReview, type ReviewCase } from "./evidenceReviewComparison";
import { atomicReport } from "./requirementAutomaticRun";
import { boundedProvider, flashRates, pricedUsage, reservedUsd, type Call, type Ledger } from "./requirementIntakeRun";
import { sha256 } from "./requirementIntake";

const fixture = "eval/fixtures/evidence-review-concise/cases.json";
const excluded = ["received-limit-83", "clean-control"];
const arms = [8192, 16384] as const;
export function budgetCases(): ReviewCase[] {
	const suite = JSON.parse(readFileSync(fixture, "utf8")) as { cases: ReviewCase[] };
	const cases = suite.cases.filter(input => !excluded.includes(input.id));
	assert(cases.length === 15 && cases.filter(input => input.expected.kind !== "protocol_only").length === 11, "suite_changed");
	for (const input of cases) {
		assert.equal(JSON.parse(input.request.messages[1]!.content).policyVersion, "packaging-requirement-evidence.v2.2", "frozen_policy_changed");
		assert(input.request.tools.length === 0 && !input.request.reasoning && input.request.maxOutputTokens === 8192, "review_boundary_changed");
	}
	return cases;
}
export function budgetRequest(input: ReviewCase, maxOutputTokens: number) {
	assert(arms.some(value => value === maxOutputTokens), "invalid_output_budget");
	return { ...structuredClone(input.request), maxOutputTokens };
}
/** A complete max_tokens response is a measured failure; transport/ambiguous calls stop the batch. */
export function blockingUnknown(calls: Call[]) {
	return calls.some(call => call.status !== "completed" && !(call.status === "unknown" && call.kind === "generate" && call.error === "output_limit" && call.failedResponse?.telemetry.stopReason === "max_tokens"));
}
interface Attempt { id: string; caseId: string; repeat: number; maxOutputTokens: number }
interface Outcome extends Attempt {
	status: "valid" | "failed"; durationMs: number; controlPassed: boolean | null; routingPassed: boolean;
	error?: string; issues?: ReturnType<typeof scoreReview>["issues"];
}
export function budgetSummary(attempts: Attempt[], results: Outcome[], calls: Call[]) {
	const median = (values: number[]) => {
		const sorted = values.toSorted((a, b) => a - b), middle = Math.floor(sorted.length / 2);
		return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
	};
	return arms.map(maxOutputTokens => {
		const selected = results.filter(result => result.maxOutputTokens === maxOutputTokens);
		const own = calls.filter(call => selected.some(result => result.id === call.caseId)), generations = own.filter(call => call.kind === "generate");
		return { maxOutputTokens, planned: attempts.filter(attempt => attempt.maxOutputTokens === maxOutputTokens).length, arrived: selected.length,
			valid: selected.filter(result => result.status === "valid").length, truncations: selected.filter(result => result.error === "output_limit").length,
			controlsArrived: selected.filter(result => result.controlPassed !== null).length, controlsPassed: selected.filter(result => result.controlPassed === true).length,
			routingPassed: selected.filter(result => result.status === "valid" && result.routingPassed).length,
			medianAttemptMs: median(selected.map(result => result.durationMs)), medianGenerationMs: median(generations.map(call => call.durationMs ?? 0)),
			reservedUsd: reservedUsd({ usdLimit: 2, calls: own }), knownUsageUsd: generations.reduce((sum, call) => sum + (call.response || call.failedResponse ? pricedUsage((call.response ?? call.failedResponse)!, flashRates) : 0), 0),
			unavailableUsage: generations.filter(call => !call.response && !call.failedResponse).length,
			responseModels: [...new Set(generations.flatMap(call => ((call.response as { telemetry?: { model: string } } | undefined)?.telemetry ?? call.failedResponse?.telemetry)?.model ?? []))] };
	});
}

async function main() {
	const { values } = parseArgs({ options: { prepare: { type: "boolean" }, online: { type: "boolean" }, directory: { type: "string" } } });
	assert(values.directory && values.prepare !== values.online, "choose_prepare_or_online");
	assert.equal(requirementEvidencePolicy.version, "packaging-requirement-evidence.v2.2", "historical_trial_cannot_use_new_production_policy");
	const directory = resolve(values.directory), cases = budgetCases();
	const attempts: Attempt[] = [1, 2].flatMap(repeat => cases.flatMap((input, index) => ((repeat + index) % 2 ? arms : [...arms].reverse()).map(maxOutputTokens => ({ id: `budget-${input.id}-${repeat}-${maxOutputTokens}`, caseId: input.id, repeat, maxOutputTokens }))));
	const files = ["eval/evidenceReviewOutputBudget.ts", "eval/evidenceReviewOutputBudget.test.ts", fixture, "eval/evidenceReviewBoundary.ts", "eval/evidenceReviewComparison.ts", "eval/requirementIntakeRun.ts", "eval/requirementAutomaticRun.ts", "eval/requirementIntake.ts", "server/runtime/modelFailure.ts", "server/runtime/anthropicModelProvider.ts", "server/anthropic/client.ts", "server/anthropic/types.ts", "server/anthropic/stream.ts", "server/modelSettings.ts", "server/manufacturing/requirementEvidencePolicy.ts", "src/manufacturing/requirementBrief.ts", "src/enterprise/evidenceReview.ts", "package.json", "package-lock.json"];
	const priorFiles = ["docs/evidence/review-output-2026-09-26/low.report.json.gz", "docs/evidence/review-concise-2026-09-26/report.json.gz", "docs/evidence/review-concise-2026-09-26/budget.json"];
	const hashes = (paths: string[]) => Object.fromEntries(paths.map(path => [path, sha256(readFileSync(path))]));
	const priorUnknown = priorFiles.slice(0, 2).flatMap(path => {
		const report = JSON.parse(gunzipSync(readFileSync(path)).toString()) as Ledger;
		return report.calls.filter(call => call.status !== "completed" && !call.failedResponse).map(({ caseId, requestSha256, error, reservationUsd }) => ({ source: path, caseId, requestSha256, error, reservationUsd }));
	});
	assert.equal(priorUnknown.length, 2, "prior_unknown_inventory_changed");
	if (values.prepare) {
		mkdirSync(directory);
		writeFileSync(join(directory, "plan.json"), JSON.stringify({ protocol: "review-output-budget.v1", authorization: "User approved on 2026-09-29: independent USD 2 read-only comparison of 8192 vs 16384 output tokens", usdLimit: 2, maxInputTokens: 24000, timeoutMs: 120000,
			sourceHashes: hashes(files), retainedPriorHashes: hashes(priorFiles), retainedPriorUnknown: priorUnknown, excludedCaseIds: excluded,
			model: "deepseek-v4-flash", servedModelNotice: "Official pricing: legacy alias is served by V4.1-Flash; compare both arms now, not against historical model quality", rates: flashRates, priceVerifiedOn: "2026-09-29", priceSource: "https://api-docs.deepseek.com/quick_start/pricing/", priceBasis: "Peak ceiling estimate, not invoice", attempts,
			gate: "Complete 60 attempts. Candidate passes all 22 controls and every routing check on valid output. Candidate valid outputs >= baseline, truncations < baseline. Response model identities must match. Otherwise do not adopt.",
			unknownPolicy: "No retry or resume. Stop on any ambiguous call; complete received output_limit may continue to the next independent attempt. Retain all reservations, including failures. Historical budgets remain separate and unchanged.", semanticQuality: "NOT_EVALUATED beyond authored narrow controls" }, null, "\t") + "\n", { flag: "wx", mode: 0o600 });
		console.log(JSON.stringify({ mode: "prepared_no_network", attempts: attempts.length, usdLimit: 2, controlsPerArm: 22 })); return;
	}
	const planBytes = readFileSync(join(directory, "plan.json")), plan = JSON.parse(planBytes.toString());
	assert.deepEqual(plan.sourceHashes, hashes(files), "frozen_source_changed"); assert.deepEqual(plan.retainedPriorHashes, hashes(priorFiles), "old_evidence_changed");
	assert.deepEqual(plan.attempts, attempts); assert.deepEqual(plan.rates, flashRates); assert(plan.usdLimit === 2 && plan.maxInputTokens === 24000 && plan.timeoutMs === 120000 && plan.model === "deepseek-v4-flash", "budget_changed");
	assert(!existsSync(join(directory, "report.json")), "new_report_required");
	const env = { ...process.env }; new ModelSettings(resolve(env.PACKX_SETTINGS_PATH ?? ".packx-settings.json"), env).apply(env);
	assert(env.ANTHROPIC_API_KEY && env.ANTHROPIC_BASE_URL?.replace(/\/$/, "") === "https://api.deepseek.com/anthropic", "official_provider_required");
	writeFileSync(join(directory, "runner.lock"), `${process.pid}\n`, { flag: "wx" });
	const upstream = new AnthropicModelProvider(new AnthropicMessagesClient({ baseUrl: env.ANTHROPIC_BASE_URL, apiKey: env.ANTHROPIC_API_KEY }), plan.model, 16384);
	const counted: AgentModelProvider = {
		async countTokens(request, signal) { const count = await upstream.countTokens(request, signal); assert(count <= plan.maxInputTokens, "review_input_limit"); return count; },
		async generate(request, signal) { const { providerState: _privateReasoning, ...result } = await upstream.generate(request, signal); return result; },
	};
	const ledger: Ledger = { usdLimit: 2, calls: [] }, results: Outcome[] = [];
	let status = "running";
	const save = () => atomicReport(join(directory, "report.json"), { protocol: plan.protocol, planSha256: sha256(planBytes), model: plan.model, status, semanticQuality: plan.semanticQuality, ...ledger, reservedUsd: reservedUsd(ledger), summary: budgetSummary(attempts, results, ledger.calls), results });
	save();
	try {
		for (const attempt of attempts) {
			assert.deepEqual(plan.sourceHashes, hashes(files), "frozen_source_changed");
			const input = cases.find(input => input.id === attempt.caseId)!, request = budgetRequest(input, attempt.maxOutputTokens);
			assert(!priorUnknown.some(call => call.requestSha256 === sha256(JSON.stringify(request))), "quarantined_request_cannot_repeat");
			const local: Ledger = { usdLimit: 2, priorReservedUsd: reservedUsd(ledger), calls: [] }; let copied = 0;
			const provider = boundedProvider(counted, local, attempt.id, () => "isolated-review-output-budget", () => { ledger.calls.push(...local.calls.slice(copied)); copied = local.calls.length; save(); });
			const started = performance.now();
			try {
				const response = await provider.generate(request, AbortSignal.timeout(plan.timeoutMs));
				assert.equal(response.toolCalls.length, 0, "unexpected_review_tool");
				const score = scoreReview(input, response.text);
				results.push({ ...attempt, status: "valid", ...score, routingPassed: routingPassed(score.issues), durationMs: Math.round(performance.now() - started) });
			} catch {
				results.push({ ...attempt, status: "failed", error: local.calls.at(-1)?.error ?? "invalid_review_or_local_failure", controlPassed: input.expected.kind === "protocol_only" ? null : false, routingPassed: false, durationMs: Math.round(performance.now() - started) });
			}
			save(); const last = results.at(-1)!; console.log(JSON.stringify({ ...last, issues: undefined }));
			if (blockingUnknown(local.calls)) { status = "stopped_unknown"; break; }
			if (!local.calls.some(call => call.kind === "generate") || reservedUsd(ledger) >= 2) { status = "stopped_budget"; break; }
		}
		if (status === "running") status = "completed";
	} catch { status = "stopped_local_error"; }
	finally { save(); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
