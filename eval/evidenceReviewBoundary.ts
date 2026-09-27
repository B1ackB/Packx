import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AgentModelRequest } from "../src/agent/contracts";
import type { EvidenceReviewIssue } from "../src/enterprise/evidenceReview";
import { requirementEvidencePolicy } from "../server/manufacturing/requirementEvidencePolicy";
import { AnthropicMessagesClient } from "../server/anthropic/client";
import { AnthropicModelProvider } from "../server/runtime/anthropicModelProvider";
import { ModelSettings } from "../server/modelSettings";
import { atomicReport, onlyOutputLimitUnknowns } from "./requirementAutomaticRun";
import { boundedProvider, flashRates, pricedUsage, reservedUsd, unresolved, type Ledger } from "./requirementIntakeRun";
import { sha256 } from "./requirementIntake";
import { scoreReview, type ReviewCase } from "./evidenceReviewComparison";

export function routingPassed(issues: EvidenceReviewIssue[]) {
	return issues.every(issue => issue.kind === "scope_change" ? issue.suggestedAction === "reconfirm_plan"
		: issue.suggestedAction === "revise" ? requirementEvidencePolicy.canRevise([issue])
		: issue.suggestedAction === "request_input");
}

/** Keep the captured Host instruction and every evidence byte; replace only the domain policy. */
export function candidateReviewRequest(original: AgentModelRequest): AgentModelRequest {
	const request = structuredClone(original);
	assert(request.messages.length === 2 && request.messages[0]!.role === "system" && request.messages[1]!.role === "user", "unexpected_review_messages");
	const system = request.messages[0]!;
	assert(system.content.startsWith("Independently review the candidate") && system.content.includes("\nThis is a packaging presales"), "unexpected_baseline_policy");
	system.content = system.content.slice(0, system.content.indexOf("\n")) + "\n" + requirementEvidencePolicy.instructions.join("\n");
	const input = JSON.parse(request.messages[1]!.content);
	assert(input.policyVersion === "packaging-requirement-evidence.v2.2", "unexpected_baseline_version");
	input.policyVersion = requirementEvidencePolicy.version;
	request.messages[1]!.content = JSON.stringify(input);
	return request;
}

async function main() {
	const { values } = parseArgs({ options: { prepare: { type: "boolean" }, online: { type: "boolean" }, directory: { type: "string" } } });
	assert(values.directory && values.prepare !== values.online, "choose_prepare_or_online");
	const directory = resolve(values.directory), fixturePath = "eval/fixtures/evidence-review-concise/cases.json";
	const suite = JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: ReviewCase[] };
	const priorDirectory = "docs/evidence/review-boundary-2026-09-26";
	const budgetBytes = readFileSync(join(priorDirectory, "budget.json")), budget = JSON.parse(budgetBytes.toString());
	const priorBytes = gunzipSync(readFileSync(join(priorDirectory, "report.json.gz"))), prior = JSON.parse(priorBytes.toString());
	const priorPlanBytes = readFileSync(join(priorDirectory, "plan.json"));
	assert(prior.planSha256 === sha256(priorPlanBytes), "prior_plan_changed");
	assert(budget.usdLimit === 20 && prior.usdLimit === 20 && prior.status === "completed" && budget.reservedUsd === reservedUsd(prior), "prior_budget_mismatch");
	assert(prior.calls.every((c: { kind: string; response?: unknown; failedResponse?: unknown }) => c.kind !== "generate" || c.response || c.failedResponse), "new_prior_unknown_requires_review");
	const quarantined = JSON.parse(priorPlanBytes.toString()).retainedUnknown;
	assert(quarantined.requestSha256 === "2f3757207ab15c2e46fe91901ca1d15fcfb11eb03954d926cb0f843891e62854" && quarantined.reservationUsd === 0.011235, "unknown_identity_changed");
	assert(suite.cases.length === 16 && suite.cases.every(c => c.id !== "received-limit-83"), "quarantined_input_must_be_excluded");
	const files = ["eval/evidenceReviewBoundary.ts", fixturePath, "eval/evidenceReviewComparison.ts", "eval/requirementIntakeRun.ts", "eval/requirementAutomaticRun.ts", "eval/requirementIntake.ts", "server/runtime/modelFailure.ts", "server/runtime/anthropicModelProvider.ts", "server/runtime/modelTelemetry.ts", "server/anthropic/client.ts", "server/anthropic/stream.ts", "server/modelSettings.ts", "server/manufacturing/requirementEvidencePolicy.ts", "src/manufacturing/requirementBrief.ts", "src/enterprise/evidenceReview.ts", "package.json", "package-lock.json"];
	const hashes = () => Object.fromEntries(files.map(path => [path, sha256(readFileSync(path))]));
	const attempts = [1, 2].flatMap(repeat => suite.cases.flatMap((input, index) => ((repeat + index) % 2 ? ["baseline", "candidate"] : ["candidate", "baseline"]).map(arm => ({ id: `concise-${input.id}-${repeat}-${arm}`, caseId: input.id, repeat, arm }))));
	assert(requirementEvidencePolicy.version === "packaging-requirement-evidence.v2.4", "unexpected_candidate_policy");
	if (values.prepare) {
		mkdirSync(directory);
		atomicReport(join(directory, "plan.json"), { protocol: "review-concise-comparison.v1", sourceHashes: hashes(), budgetSha256: sha256(budgetBytes), priorReportSha256: sha256(priorBytes), priorReservedUsd: budget.reservedUsd, retainedUnknown: quarantined, attempts, model: "deepseek-v4-flash", maxOutputTokens: 8192, usdLimit: 20, rates: flashRates,
			candidateInstructions: requirementEvidencePolicy.instructions, gate: "Complete all 64 calls; candidate passes all 24 controls and all routing checks on valid outputs; candidate valid output count > baseline and truncations < baseline. Otherwise do not adopt. No evidence, scorer, model, reasoning or token limit change.",
			unknownPolicy: "Do not retry the quarantined input. Retain every previous reservation. A new transport or unclassified unknown stops this new trial; only received output_limit may end an independent review and continue.", semanticQuality: "NOT_EVALUATED beyond authored controls" });
		console.log(JSON.stringify({ mode: "prepared_no_network", attempts: attempts.length, reservedUsd: budget.reservedUsd })); return;
	}
	const planBytes = readFileSync(join(directory, "plan.json")), plan = JSON.parse(planBytes.toString());
	assert.deepEqual(plan.sourceHashes, hashes(), "frozen_source_changed"); assert.deepEqual(plan.attempts, attempts, "attempts_changed");
	assert.equal(plan.budgetSha256, sha256(budgetBytes)); assert.equal(plan.priorReportSha256, sha256(priorBytes));
	assert(!existsSync(join(directory, "report.json")), "new_report_required");
	writeFileSync(join(directory, "runner.lock"), `${process.pid}\n`, { flag: "wx" });
	const env = { ...process.env }; new ModelSettings(resolve(env.PACKX_SETTINGS_PATH ?? ".packx-settings.json"), env).apply(env);
	assert(env.ANTHROPIC_API_KEY && env.ANTHROPIC_BASE_URL?.replace(/\/$/, "") === "https://api.deepseek.com/anthropic", "official_provider_required");
	const upstream = new AnthropicModelProvider(new AnthropicMessagesClient({ baseUrl: env.ANTHROPIC_BASE_URL, apiKey: env.ANTHROPIC_API_KEY }), plan.model, 8192);
	const ledger: Ledger = { usdLimit: 20, priorReservedUsd: budget.reservedUsd, calls: [] }, results: unknown[] = [];
	let status = "running";
	const save = () => atomicReport(join(directory, "report.json"), { protocol: plan.protocol, planSha256: sha256(planBytes), priorReportSha256: sha256(priorBytes), status, ...ledger, reservedUsd: reservedUsd(ledger), knownUsageUsd: ledger.calls.reduce((sum, call) => sum + (call.response || call.failedResponse ? pricedUsage((call.response ?? call.failedResponse)!, flashRates) : 0), 0), results });
	save();
	try {
		for (const attempt of attempts) {
			assert.deepEqual(plan.sourceHashes, hashes(), "frozen_source_changed");
			const input = suite.cases.find(c => c.id === attempt.caseId)!, request = attempt.arm === "candidate" ? candidateReviewRequest(input.request) : structuredClone(input.request);
			assert(request.tools.length === 0 && !request.reasoning && request.maxOutputTokens === 8192, "request_boundary_changed");
			assert(sha256(JSON.stringify(request)) !== quarantined.requestSha256, "quarantined_request_cannot_repeat");
			const local: Ledger = { usdLimit: 20, priorReservedUsd: reservedUsd(ledger), calls: [] }; let copied = 0;
			const provider = boundedProvider(upstream, local, attempt.id, () => "isolated-review-concise", () => { ledger.calls.push(...local.calls.slice(copied)); copied = local.calls.length; save(); });
			const started = performance.now();
			try {
				const response = await provider.generate(request, AbortSignal.timeout(120_000)), score = scoreReview(input, response.text);
				results.push({ ...attempt, status: "valid", ...score, routingPassed: routingPassed(score.issues), canRevise: requirementEvidencePolicy.canRevise(score.issues), durationMs: Math.round(performance.now() - started) });
			} catch {
				results.push({ ...attempt, status: "failed", error: local.calls.at(-1)?.error ?? "invalid_review_or_local_failure", controlPassed: input.expected.kind === "protocol_only" ? null : false, routingPassed: false, durationMs: Math.round(performance.now() - started) });
			}
			save(); console.log(JSON.stringify(results.at(-1)));
			if (unresolved(local) && !onlyOutputLimitUnknowns(local.calls)) { status = "stopped_unknown"; break; }
			if (!local.calls.some(c => c.kind === "generate") || reservedUsd(ledger) >= 20) { status = "stopped_budget"; break; }
		}
		if (status === "running") status = "completed";
	} catch { status = "stopped_local_error"; }
	finally { save(); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
