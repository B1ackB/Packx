import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AgentModelRequest } from "../src/agent/contracts";
import { parseEvidenceReview } from "../src/enterprise/evidenceReview";
import { AnthropicMessagesClient } from "../server/anthropic/client";
import { AnthropicModelProvider } from "../server/runtime/anthropicModelProvider";
import { ModelSettings } from "../server/modelSettings";
import { atomicReport, onlyOutputLimitUnknowns } from "./requirementAutomaticRun";
import { boundedProvider, flashRates, pricedUsage, reservedUsd, unresolved, type Ledger } from "./requirementIntakeRun";
import { failureCode, sha256 } from "./requirementIntake";

export interface ReviewCase {
	id: string; request: AgentModelRequest;
	expected: { kind: string; issueKinds?: string[]; locations?: string[]; reasonTerms?: string[] };
}
export function scoreReview(input: ReviewCase, text: string) {
	const body = JSON.parse(input.request.messages.at(-1)!.content);
	const issues = parseEvidenceReview(text, body.evidence.map((e: { ref: string }) => e.ref));
	const expected = input.expected;
	const controlPassed = expected.kind === "protocol_only" ? null : expected.kind === "no_issues" ? issues.length === 0 : issues.some(issue =>
		expected.issueKinds!.includes(issue.kind) && expected.locations!.some(path => issue.location === path || issue.location.startsWith(path + "/")) &&
		expected.reasonTerms!.some(term => issue.reason.includes(term)));
	return { issues, controlPassed };
}

async function main() {
	const { values } = parseArgs({ options: { prepare: { type: "boolean" }, online: { type: "boolean" }, directory: { type: "string" } } });
	assert(values.directory && values.prepare !== values.online, "choose_prepare_or_online");
	const directory = resolve(values.directory), fixturePath = "eval/fixtures/evidence-review-output/cases.json";
	const fixtureBytes = readFileSync(fixturePath), suite = JSON.parse(fixtureBytes.toString()) as { sourceReportSha256: string; cases: ReviewCase[] };
	const sourceFiles = ["eval/evidenceReviewComparison.ts", fixturePath, "eval/requirementIntakeRun.ts", "eval/requirementAutomaticRun.ts", "eval/requirementIntake.ts", "server/modelSettings.ts", "server/runtime/anthropicModelProvider.ts", "server/anthropic/client.ts", "server/anthropic/types.ts", "server/anthropic/stream.ts", "src/enterprise/evidenceReview.ts"];
	const hashes = () => Object.fromEntries(sourceFiles.map(path => [path, sha256(readFileSync(path))]));
	const attempts = [1, 2].flatMap(repeat => suite.cases.flatMap((input, index) => ((index + repeat) % 2 ? ["default", "disabled"] : ["disabled", "default"]).map(arm => ({ id: `${input.id}-${repeat}-${arm}`, caseId: input.id, repeat, arm }))));
	if (values.prepare) {
		mkdirSync(directory);
		writeFileSync(join(directory, "plan.json"), JSON.stringify({ protocol: "evidence-review-output-comparison.v1", sourceHashes: hashes(), priorReportSha256: suite.sourceReportSha256, model: "deepseek-v4-flash", usdLimit: 20, maxOutputTokens: 8192, rates: flashRates, attempts,
			gate: "All eight disabled-arm control calls pass; disabled valid output count >= default; disabled truncations < default. Otherwise no default change.",
			unknownPolicy: "Keep all reservations. Received output_limit may end this independent review; any other unknown stops the experiment. Never resume a prior business request.",
			semanticQuality: "NOT_EVALUATED beyond frozen narrow controls", source: "https://api-docs.deepseek.com/guides/thinking_mode/" }, null, "\t") + "\n", { flag: "wx" });
		console.log(JSON.stringify({ mode: "prepared_no_network", attempts: attempts.length })); return;
	}
	const planBytes = readFileSync(join(directory, "plan.json")), plan = JSON.parse(planBytes.toString());
	assert.deepEqual(plan.sourceHashes, hashes(), "frozen_source_changed"); assert.deepEqual(plan.attempts, attempts, "attempts_changed");
	const priorBytes = readFileSync("temp/pending-change-online-2026-09-26-r3/report.json"), prior = JSON.parse(priorBytes.toString());
	assert.equal(sha256(priorBytes), plan.priorReportSha256, "prior_report_changed");
	assert(prior.status === "completed" && prior.usdLimit === 20 && onlyOutputLimitUnknowns(prior.calls), "prior_not_reviewed");
	assert(Math.abs(reservedUsd(prior) - prior.reservedUsd) < 1e-9, "prior_budget_changed");
	assert(!existsSync(join(directory, "report.json")), "new_report_required");
	writeFileSync(join(directory, "runner.lock"), `${process.pid}\n`, { flag: "wx" });
	const env = { ...process.env }; new ModelSettings(resolve(env.PACKX_SETTINGS_PATH ?? ".packx-settings.json"), env).apply(env);
	assert(env.ANTHROPIC_API_KEY && env.ANTHROPIC_BASE_URL?.replace(/\/$/, "") === "https://api.deepseek.com/anthropic", "official_provider_required");
	const upstream = new AnthropicModelProvider(new AnthropicMessagesClient({ baseUrl: env.ANTHROPIC_BASE_URL, apiKey: env.ANTHROPIC_API_KEY }), plan.model, 8192);
	const ledger: Ledger = { usdLimit: 20, priorReservedUsd: prior.reservedUsd, calls: [] };
	const results: unknown[] = []; let status = "running";
	const save = () => atomicReport(join(directory, "report.json"), { protocol: plan.protocol, planSha256: sha256(planBytes), priorReportSha256: sha256(priorBytes), status, ...ledger, reservedUsd: reservedUsd(ledger), knownUsageUsd: ledger.calls.reduce((sum, call) => sum + (call.response || call.failedResponse ? pricedUsage((call.response ?? call.failedResponse)!, flashRates) : 0), 0), results });
	save();
	try {
		for (const attempt of attempts) {
			assert.deepEqual(plan.sourceHashes, hashes(), "frozen_source_changed");
			const input = suite.cases.find(c => c.id === attempt.caseId)!;
			const request = structuredClone(input.request);
			if (attempt.arm === "disabled") request.reasoning = "disabled";
			else delete request.reasoning;
			assert(request.tools.length === 0 && request.maxOutputTokens === 8192, "review_boundary_changed");
			const local: Ledger = { usdLimit: 20, priorReservedUsd: reservedUsd(ledger), calls: [] }; let copied = 0;
			const provider = boundedProvider(upstream, local, attempt.id, () => "isolated-read-only-review", () => { ledger.calls.push(...local.calls.slice(copied)); copied = local.calls.length; save(); });
			const started = performance.now();
			try {
				const response = await provider.generate(request, AbortSignal.timeout(120_000));
				const score = scoreReview(input, response.text);
				results.push({ ...attempt, status: "valid", ...score, durationMs: Math.round(performance.now() - started) });
			} catch (error) {
				results.push({ ...attempt, status: "failed", error: failureCode(error), controlPassed: input.expected.kind === "protocol_only" ? null : false, durationMs: Math.round(performance.now() - started) });
			}
			save(); console.log(JSON.stringify(results.at(-1)));
			if (unresolved(local) && !onlyOutputLimitUnknowns(local.calls)) { status = "stopped_unknown"; break; }
			if (!local.calls.some(c => c.kind === "generate") || reservedUsd(ledger) >= 20) { status = "stopped_budget"; break; }
		}
		if (status === "running") status = "completed";
	} catch (error) { status = "stopped_error"; throw error; }
	finally { save(); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
