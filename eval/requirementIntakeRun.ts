import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentModelProvider, AgentModelRequest, AgentModelResponse } from "../src/agent/contracts";
import { AnthropicMessagesClient } from "../server/anthropic/client";
import { ModelSettings } from "../server/modelSettings";
import { AnthropicGenerationError, AnthropicModelProvider } from "../server/runtime/anthropicModelProvider";
import { runtimeContextSettings } from "../server/runtime/createRuntime";
import { modelFailureCode } from "../server/runtime/modelFailure";
import { executeIntakeCase, failureCode, intakeLimits, jsonDigest, loadIntakeSuite, newIntakeResult, regrade, sha256, verdict, type IntakeResult, type Review } from "./requirementIntake";

export interface Call {
	caseId: string; eventId: string; kind: "count" | "generate"; purpose: string;
	status: "started" | "completed" | "unknown"; request: unknown; requestSha256: string;
	startedAt: string; durationMs?: number; tokens?: number; reservationUsd: number; response?: AgentModelResponse; failedResponse?: Pick<AnthropicGenerationError, "usage" | "telemetry">; error?: string;
}
export interface Ledger { usdLimit: number; calls: Call[]; priorReservedUsd?: number }
export const reservedUsd = (ledger: Ledger) => (ledger.priorReservedUsd ?? 0) + ledger.calls.reduce((sum, call) => sum + call.reservationUsd, 0);
export const unresolved = (ledger: Ledger) => ledger.calls.some((call) => call.status !== "completed");
export interface Rates { input: number; cached: number; output: number }
export const flashRates: Rates = { input: 0.3, cached: 0.006, output: 1.2 };
export const pricedUsage = <T extends Pick<AgentModelResponse, "usage">>(response: T, rates: Rates) => (response.usage.inputTokens * rates.input + response.usage.cachedInputTokens * rates.cached + response.usage.outputTokens * rates.output) / 1_000_000;

/** Explicit reviewed-stop continuation only; the original unknown and reservation remain unchanged. */
export function reviewedOutputStop(bytes: string) {
	const prior = JSON.parse(bytes) as { protocol: string; status: string; model: string; usdLimit: number; calls: Call[]; priorReservedUsd?: number };
	assert.equal(prior.protocol, "requirement-intake-online.v1", "unexpected_prior_protocol");
	assert.equal(prior.status, "stopped_unknown", "prior_not_stopped");
	assert.equal(prior.model, "deepseek-v4-flash", "prior_model_changed");
	const unknown = prior.calls.filter((c) => c.status !== "completed");
	assert(unknown.length === 1 && unknown[0].status === "unknown" && unknown[0].kind === "generate" && unknown[0].error === "output_limit", "not_a_reviewed_output_stop");
	assert(prior.calls.every((c) => Number.isFinite(c.reservationUsd) && c.reservationUsd >= 0), "invalid_prior_reservation");
	assert(!prior.priorReservedUsd && reservedUsd(prior) <= prior.usdLimit, "invalid_prior_budget");
	return { reportSha256: sha256(bytes), reservedUsd: reservedUsd(prior), estimatedUsageUsd: prior.calls.reduce((sum, c) => sum + (c.response || c.failedResponse ? pricedUsage((c.response ?? c.failedResponse)!, flashRates) : 0), 0), unknown: unknown.map((c) => ({ caseId: c.caseId, requestSha256: c.requestSha256, error: c.error, reservationUsd: c.reservationUsd, status: c.status })) };
}

/** A new trial carries every earlier reservation; it cannot resume an ambiguous old request. */
export function reviewedPriorTrial(bytes: string) {
	const prior = JSON.parse(bytes) as Report;
	assert(["requirement-intake-online.v2", "requirement-intake-online.v3", "requirement-intake-online.v4", "requirement-intake-online.v5"].includes(prior.protocol), "unexpected_prior_protocol");
	assert(prior.status !== "running" && prior.results.length > 0 && prior.results.every((r) => ["completed", "failed"].includes(r.status)), "prior_trial_not_terminal");
	assert(prior.calls.every((c) => ["completed", "unknown"].includes(c.status) && Number.isFinite(c.reservationUsd) && c.reservationUsd >= 0), "invalid_prior_ledger");
	assert(Number.isFinite(reservedUsd(prior)) && reservedUsd(prior) <= prior.usdLimit, "invalid_prior_budget");
	return { reportSha256: sha256(bytes), reservedUsd: reservedUsd(prior),
		estimatedUsageUsd: (prior.reviewedStop?.estimatedUsageUsd ?? 0) + prior.calls.reduce((sum, c) => sum + (c.response || c.failedResponse ? pricedUsage((c.response ?? c.failedResponse)!, flashRates) : 0), 0),
		unknown: [...(prior.reviewedStop?.unknown ?? []), ...prior.calls.filter((c) => c.status === "unknown").map((c) => ({ caseId: c.caseId, requestSha256: c.requestSha256, error: c.error, reservationUsd: c.reservationUsd, status: c.status }))],
	};
}

/** Never refunds a reservation or retries an uncertain network request. */
export function boundedProvider(provider: AgentModelProvider, ledger: Ledger, caseId: string, eventId: () => string, save: () => void, rates: Rates = flashRates): AgentModelProvider {
	assert(Object.values(rates).every((n) => Number.isFinite(n) && n >= 0) && rates.input >= rates.cached && rates.output > 0, "invalid_price_profile");
	const counts = new Map<string, number>();
	const start = (kind: Call["kind"], request: AgentModelRequest, reservationUsd = 0) => {
		assert(!unresolved(ledger), "unresolved_call_blocks_batch");
		const snapshot = JSON.parse(JSON.stringify(request));
		const properties = request.outputSchema?.properties;
		const purpose = request.callContext?.purpose === "summary" ? "summary" : properties && typeof properties === "object" && "issues" in properties ? "evidence_review" : properties && typeof properties === "object" && "facts" in properties ? "intake" : "revision";
		const call: Call = { caseId, eventId: eventId(), kind, purpose, status: "started", request: snapshot, requestSha256: jsonDigest(snapshot), startedAt: new Date().toISOString(), reservationUsd };
		ledger.calls.push(call); save(); return call;
	};
	const count = async (request: AgentModelRequest, signal?: AbortSignal) => {
		assert(!unresolved(ledger), "unresolved_call_blocks_batch");
		signal?.throwIfAborted();
		const key = jsonDigest(request), cached = counts.get(key);
		if (cached !== undefined) return cached;
		assert(provider.countTokens, "provider_count_required");
		assert(ledger.calls.filter((c) => c.caseId === caseId && c.kind === "count").length < intakeLimits.maxCountsPerCase, "count_limit");
		const call = start("count", request), started = performance.now();
		try {
			const tokens = await provider.countTokens(request, signal);
			assert(Number.isSafeInteger(tokens) && tokens >= 0, "invalid_token_count");
			call.tokens = tokens; call.status = "completed"; counts.set(key, tokens); return tokens;
		} catch (error) { call.status = "unknown"; call.error = modelFailureCode(error); throw error; }
		finally { call.durationMs = Math.round(performance.now() - started); save(); }
	};
	return { countTokens: count, generate: async (request, signal) => {
		assert(!unresolved(ledger), "unresolved_call_blocks_batch");
		signal?.throwIfAborted();
		assert(ledger.calls.filter((c) => c.caseId === caseId && c.kind === "generate").length < intakeLimits.maxGenerationsPerCase, "generation_limit");
		const tokens = await count(request, signal), output = request.maxOutputTokens ?? intakeLimits.maxOutputTokens;
		assert(tokens <= 100_000 && Number.isSafeInteger(output) && output > 0 && output <= intakeLimits.maxOutputTokens, "token_limit");
		const reservation = (tokens * rates.input + output * rates.output) / 1_000_000;
		assert(reservedUsd(ledger) + reservation <= ledger.usdLimit, "usd_limit");
		signal?.throwIfAborted();
		const call = start("generate", request, reservation), started = performance.now(); call.tokens = tokens;
		try {
			const response = await provider.generate(request, signal);
			assert(Object.values(response.usage).every((n) => Number.isSafeInteger(n) && n >= 0), "invalid_usage");
			call.response = response;
			assert(pricedUsage(response, rates) <= reservation + 0.000001, "usage_exceeds_reservation");
			call.status = "completed"; return response;
		} catch (error) {
			call.status = "unknown"; call.error = modelFailureCode(error);
			if (error instanceof AnthropicGenerationError) {
				call.failedResponse = { usage: error.usage, telemetry: error.telemetry };
				if (pricedUsage(error, rates) > reservation + 0.000001) {
					call.error = "usage_exceeds_reservation";
					throw new Error("usage_exceeds_reservation", { cause: error });
				}
			}
			throw error;
		}
		finally { call.durationMs = Math.round(performance.now() - started); save(); }
	} };
}

interface Report extends Ledger {
	protocol: "requirement-intake-online.v5"; createdAt: string; updatedAt: string;
	status: string; manifestSha256: string; sourceSha256: string; commit: string; sourceHashes: Record<string, string>;
	model: string; endpoint: string; limits: typeof intakeLimits; rates: object; environment: Record<string, string>;
	caseIds: string[]; results: IntakeResult[]; reviews: Review[];
	scoringProtocolSha256: string; reviewedStop?: ReturnType<typeof reviewedOutputStop>;
}

function codeHashes() {
	const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src", "server", "eval", "package.json", "package-lock.json"], { encoding: "utf8" }).trim().split("\n");
	return Object.fromEntries([...new Set(files)].filter((f) => !f.includes(".test.") && (!f.startsWith("eval/") || ["eval/requirementIntake.ts", "eval/requirementIntakeRun.ts"].includes(f))).sort().map((file) => [file, sha256(readFileSync(file))]));
}

function atomicWrite(file: string, value: unknown) {
	const fd = openSync(`${file}.next`, "wx", 0o600);
	try { writeFileSync(fd, JSON.stringify(value, null, "\t") + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
	renameSync(`${file}.next`, file);
}

export function summarize(report: Pick<Report, "results" | "calls" | "usdLimit" | "reviewedStop" | "priorReservedUsd">) {
	const started = report.results.filter((r) => r.status !== "not_started");
	return {
		started: started.length, passed: started.filter((r) => verdict(r) === "passed").length,
		failed: started.filter((r) => verdict(r) === "failed").length, pending: started.filter((r) => verdict(r) === "needs_review").length,
		notStarted: report.results.length - started.length, unresolved: unresolved(report) || Boolean(report.reviewedStop?.unknown.length), currentBatchUnresolved: unresolved(report), reservedUsd: reservedUsd(report), priorReservedUsd: report.priorReservedUsd ?? 0,
		estimatedUsageUsd: report.calls.reduce((sum, c) => sum + (c.response || c.failedResponse ? pricedUsage((c.response ?? c.failedResponse)!, flashRates) : 0), 0),
		cumulativeKnownUsageUsd: (report.reviewedStop?.estimatedUsageUsd ?? 0) + report.calls.reduce((sum, c) => sum + (c.response || c.failedResponse ? pricedUsage((c.response ?? c.failedResponse)!, flashRates) : 0), 0),
		generations: report.calls.filter((c) => c.kind === "generate").length, counts: report.calls.filter((c) => c.kind === "count").length,
		usageTokens: Object.fromEntries(["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"].map((key) => [key, report.calls.reduce((sum, c) => sum + ((c.response ?? c.failedResponse)?.usage[key as keyof AgentModelResponse["usage"]] ?? 0), 0)])),
		generationPurposes: Object.fromEntries(["intake", "evidence_review", "revision", "summary"].map((purpose) => [purpose, report.calls.filter((c) => c.kind === "generate" && c.purpose === purpose).length])),
		tools: started.flatMap((r) => r.traceEvents).filter((e) => e.type === "tool.completed").length,
		toolFailures: started.flatMap((r) => r.traceEvents).filter((e) => e.type === "tool.completed" && e.status !== "succeeded").length,
		compactions: started.flatMap((r) => r.traceEvents).filter((e) => e.type === "context.compacted").length,
		executionDurationMs: started.reduce((sum, r) => sum + r.executionDurationMs, 0),
	};
}

export async function main() {
	const { values } = parseArgs({ options: { online: { type: "boolean" }, resume: { type: "boolean" }, "review-only": { type: "boolean" }, directory: { type: "string" }, cases: { type: "string" }, "include-holdout": { type: "boolean" }, "usd-limit": { type: "string" }, reviews: { type: "string" }, "reviewed-output-stop": { type: "string" }, "prior-report": { type: "string" } } });
	const suite = loadIntakeSuite(), ids = values.cases?.split(",") ?? suite.manifest.development;
	assert(ids.length && new Set(ids).size === ids.length && ids.every((id) => suite.cases.some((c) => c.id === id)), "invalid_case_selection");
	assert(values["include-holdout"] || ids.every((id) => suite.manifest.development.includes(id)), "holdout_requires_explicit_selection");
	if (!values.online && !values["review-only"]) {
		console.log(JSON.stringify({ mode: "plan_no_network", suite: suite.manifest.suiteId, cases: ids, limits: intakeLimits, required: "--online --directory <new directory> --usd-limit <explicit USD cap>" }, null, 2)); return;
	}
	assert(values.directory, "directory_required");
	assert(!(values.online && values["review-only"]), "ambiguous_mode");
	const directory = resolve(values.directory), file = join(directory, "report.json");
	const resume = Boolean(values.resume || values["review-only"]);
	if (!resume) { mkdirSync(dirname(directory), { recursive: true }); mkdirSync(directory, { mode: 0o700 }); }
	else assert(existsSync(file), "report_missing");
	const lock = join(directory, "runner.lock"); mkdirSync(lock);
	try {
		const hashes = codeHashes(), sourceSha256 = jsonDigest(hashes);
		const environment = { ...process.env };
		new ModelSettings(resolve(environment.PACKX_SETTINGS_PATH ?? ".packx-settings.json"), environment).apply(environment);
		environment.PACKX_MODEL_MAX_OUTPUT_TOKENS = String(intakeLimits.maxOutputTokens);
		const scoringProtocolSha256 = sha256(readFileSync(new URL("./fixtures/requirement-intake-v1/scoring-v5.md", import.meta.url)));
		const model = environment.ANTHROPIC_MODEL ?? "", endpoint = environment.ANTHROPIC_BASE_URL ?? "";
		const contextEnv = Object.fromEntries(Object.entries(runtimeContextSettings(environment)).map(([key, value]) => [key, String(value)]));
		const usdLimit = Number(values["usd-limit"]);
		let report: Report;
		if (resume) {
			report = JSON.parse(readFileSync(file, "utf8"));
			assert.equal(report.protocol, "requirement-intake-online.v5");
			assert.equal(report.scoringProtocolSha256, scoringProtocolSha256, "scoring_changed");
			assert.equal(report.manifestSha256, suite.manifestSha256, "fixture_changed");
			assert.equal(report.sourceSha256, sourceSha256, "source_changed");
			if (values.online) {
				assert(!unresolved(report) && report.status !== "running", "unsafe_resume");
				assert.equal(report.model, model, "model_changed"); assert.equal(report.endpoint, endpoint, "endpoint_changed");
				assert.equal(report.usdLimit, usdLimit, "budget_changed");
				assert.deepEqual(report.caseIds, ids, "case_selection_changed");
			}
		} else {
			assert(Number.isFinite(usdLimit) && usdLimit > 0, "explicit_budget_required");
			assert(!(values["reviewed-output-stop"] && values["prior-report"]), "ambiguous_prior_ledger");
			const reviewedStop = values["prior-report"] ? reviewedPriorTrial(readFileSync(resolve(values["prior-report"]), "utf8")) : values["reviewed-output-stop"] ? reviewedOutputStop(readFileSync(resolve(values["reviewed-output-stop"]), "utf8")) : undefined;
			assert(!reviewedStop || reviewedStop.reservedUsd < usdLimit, "prior_exceeds_budget");
			report = { protocol: "requirement-intake-online.v5", scoringProtocolSha256, createdAt: new Date().toISOString(), updatedAt: "", status: "running", manifestSha256: suite.manifestSha256, sourceSha256, sourceHashes: hashes, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), model, endpoint, environment: contextEnv, usdLimit, priorReservedUsd: reviewedStop?.reservedUsd ?? 0, ...(reviewedStop ? { reviewedStop } : {}), limits: intakeLimits, rates: { inputPerMillionUsd: 0.3, cachedInputPerMillionUsd: 0.006, outputPerMillionUsd: 1.2, source: "https://api-docs.deepseek.com/quick_start/pricing/", verifiedOn: "2026-09-25", peakCeilingNotInvoice: true }, caseIds: ids, calls: [], results: ids.map((id) => newIntakeResult(suite.cases.find((c) => c.id === id)!)), reviews: [] };
		}
		const save = () => { report.updatedAt = new Date().toISOString(); atomicWrite(file, report); };
		if (values.reviews) {
			const added = JSON.parse(readFileSync(resolve(values.reviews), "utf8")) as Review[];
			assert(Array.isArray(added), "reviews_array_required");
			for (const review of added) {
				assert(report.results.some((r) => r.caseId === review.caseId && r.checkpoints.some((p) => p.capture.id === review.checkpointId)), "review_unknown_checkpoint");
				const old = report.reviews.find((r) => r.caseId === review.caseId && r.checkpointId === review.checkpointId && r.checkId === review.checkId);
				if (old) assert.deepEqual(old, review, "review_cannot_be_overwritten"); else report.reviews.push(review);
			}
		}
		for (const result of report.results) regrade(result, suite.oracles.find((o) => o.caseId === result.caseId)!, report.reviews);
		if (values.online) {
			assert(environment.BLACKX_RUNTIME_MODE === "anthropic" && environment.ANTHROPIC_API_KEY, "configured_provider_required");
			assert(endpoint.replace(/\/$/, "") === "https://api.deepseek.com/anthropic" && ["deepseek-v4-flash", "deepseek-v4.1-flash"].includes(model), "unverified_pricing_profile");
			assert.deepEqual(report.environment, contextEnv, "context_configuration_changed");
			report.status = "running"; save();
			const upstream = new AnthropicModelProvider(new AnthropicMessagesClient({ baseUrl: endpoint, apiKey: environment.ANTHROPIC_API_KEY! }), model, intakeLimits.maxOutputTokens);
			for (const result of report.results) {
				if (unresolved(report)) break;
				const input = suite.cases.find((c) => c.id === result.caseId)!;
				console.log(JSON.stringify({ case: input.id, status: "starting", event: result.nextEvent }));
				const provider = boundedProvider(upstream, report, input.id, () => input.events[result.nextEvent]?.id ?? "end", save);
				await executeIntakeCase({ input, oracle: suite.oracles.find((o) => o.caseId === input.id)!, result, directory: join(directory, input.id), provider, environment, reviews: report.reviews, save });
				console.log(JSON.stringify({ case: input.id, status: result.status, verdict: verdict(result), error: result.error, checkpoints: result.checkpoints.length, reservedUsd: reservedUsd(report) }));
			}
		}
		report.status = unresolved(report) ? "stopped_unknown" : report.results.some((r) => r.status !== "not_started" && verdict(r) === "needs_review") ? "awaiting_review" : "finished";
		save();
		const pending = report.results.flatMap((r) => r.checkpoints.flatMap((p) => p.checks.filter((c) => c.status === "needs_review").map((c) => ({ caseId: r.caseId, checkpointId: p.capture.id, captureSha256: p.captureSha256, checkId: c.id, expected: c.expected, actual: c.actual, decision: "", reviewer: "", method: "", reason: "", evidence: "" }))));
		atomicWrite(join(directory, "pending-reviews.json"), pending);
		console.log(JSON.stringify({ directory, status: report.status, ...summarize(report) }, null, 2));
	} finally { rmSync(lock, { recursive: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(failureCode(error)); process.exitCode = 1; });
