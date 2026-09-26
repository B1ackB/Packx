import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentModelProvider } from "../src/agent/contracts";
import { AnthropicMessagesClient } from "../server/anthropic/client";
import { AnthropicModelProvider } from "../server/runtime/anthropicModelProvider";
import { ModelSettings } from "../server/modelSettings";
import { runtimeContextSettings } from "../server/runtime/createRuntime";
import { executeIntakeCase, failureCode, intakeLimits, newIntakeResult, sha256, verdict, type IntakeResult } from "./requirementIntake";
import { boundedProvider, flashRates, pricedUsage, reservedUsd, unresolved, type Call, type Ledger, type Rates } from "./requirementIntakeRun";
import { loadAutomaticSuite, scoreAutomatic } from "./requirementAutomatic";

export const priceProfiles: Record<string, Rates> = { "deepseek-v4-flash": flashRates, "deepseek-v4-pro": { input: 1.32, cached: 0.044, output: 3.96 } };
export interface Attempt { id: string; caseId: string; arm: "baseline" | "candidate"; model: string; repeat: number }
export function matrixPlan(ids: string[], repeats = 3): Attempt[] {
	assert(ids.length > 0 && new Set(ids).size === ids.length && Number.isSafeInteger(repeats) && repeats > 0 && repeats <= 3, "invalid_matrix");
	const attempts: Attempt[] = [];
	for (let repeat = 1; repeat <= repeats; repeat++) for (const [index, caseId] of ids.entries()) {
		for (const arm of ((repeat + index) % 2 ? ["baseline", "candidate"] : ["candidate", "baseline"]) as Array<Attempt["arm"]>) attempts.push({ id: `flash-${arm}-${caseId}-${repeat}`, caseId, arm, model: "deepseek-v4-flash", repeat });
	}
	for (let repeat = 1; repeat <= repeats; repeat++) for (const caseId of ids) attempts.push({ id: `pro-candidate-${caseId}-${repeat}`, caseId, arm: "candidate", model: "deepseek-v4-pro", repeat });
	return attempts;
}

const sharedFiles = ["eval/requirementIntake.ts", "eval/requirementIntakeRun.ts", "eval/requirementAutomatic.ts", "eval/requirementAutomaticRun.ts"];
const hashes = (root: string, files: string[]) => Object.fromEntries(files.map((file) => [file, sha256(readFileSync(join(root, file)))]));
export const onlyOutputLimitUnknowns = (calls: Call[]) => calls.some((c) => c.status !== "completed") && calls.every((c) => c.status === "completed" || c.status === "unknown" && c.kind === "generate" && c.error === "output_limit");

/** Keep received output-limit failures and explicitly reviewed transport uncertainty reserved; never replay their attempts. */
export function reviewedMatrix(bytes: string, reviewedTransportRequest?: string) {
	const prior = JSON.parse(bytes) as { protocol: string; status: string; usdLimit: number; reservedUsd: number; priorReservedUsd?: number; planSha256: string; results: Array<ReturnType<typeof attemptSummary>>; calls: Call[] };
	assert(prior.protocol === "requirement-automatic-matrix.v1" && prior.status === "stopped_unknown", "prior_matrix_not_stopped");
	if (reviewedTransportRequest) {
		const unknown = prior.calls.filter((call) => call.status !== "completed" && !(call.status === "unknown" && call.kind === "generate" && call.error === "output_limit"));
		assert(/^[a-f0-9]{64}$/.test(reviewedTransportRequest) && unknown.length === 1 && unknown[0].status === "unknown" && unknown[0].kind === "generate" && unknown[0].error === "terminated" && unknown[0].requestSha256 === reviewedTransportRequest, "review_must_identify_one_terminated_generation");
	} else assert(onlyOutputLimitUnknowns(prior.calls), "only_received_output_limits_can_be_reviewed");
	assert(prior.results.length > 0 && new Set(prior.results.map((r) => r.id)).size === prior.results.length, "invalid_prior_results");
	assert(prior.results.every((r) => ["completed", "failed", "needs_review", "interrupted"].includes(r.executionStatus)), "prior_attempt_still_running");
	assert(prior.calls.every((c) => Number.isFinite(c.reservationUsd) && c.reservationUsd >= 0 && prior.results.some((r) => r.id === c.caseId)), "invalid_prior_call");
	assert(Number.isFinite(prior.usdLimit) && prior.usdLimit > 0 && prior.usdLimit <= 20 && Number.isFinite(prior.reservedUsd) && Math.abs(reservedUsd(prior) - prior.reservedUsd) < 1e-9 && prior.reservedUsd <= prior.usdLimit, "prior_budget_mismatch");
	return prior;
}
export function atomicReport(path: string, report: unknown) {
	const next = `${path}.next`, fd = openSync(next, "wx", 0o600);
	try { writeFileSync(fd, JSON.stringify(report, null, "\t") + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
	renameSync(next, path);
}

function prepare(directory: string, priorPath?: string, reviewedTransportRequest?: string) {
	assert(!reviewedTransportRequest || priorPath, "transport_review_requires_prior_report");
	const suite = loadAutomaticSuite();
	mkdirSync(directory, { mode: 0o700 });
	const archiveDirectory = "docs/evidence/requirement-intake-repairs-2026-09-25";
	const archiveManifest = JSON.parse(readFileSync(join(archiveDirectory, "manifest.json"), "utf8"));
	const archive = join(archiveDirectory, "trial-c.source.tar.gz");
	assert.equal(sha256(readFileSync(archive)), archiveManifest.files.find((f: { path: string }) => f.path === "trial-c.source.tar.gz").sha256, "baseline_archive_changed");
	const archiveFiles = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
	assert(archiveFiles.every((p) => !p.startsWith("/") && !p.split("/").includes("..") && /^(?:src\/|server\/|eval\/|package(?:-lock)?\.json$)/.test(p)), "unsafe_source_archive");
	const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src", "server", "package.json", "package-lock.json"], { encoding: "utf8" }).trim().split("\n");
	const files = [...new Set(tracked)].filter((f) => !f.includes(".test.")).sort();
	const production: Record<string, Record<string, string>> = {};
	for (const arm of ["baseline", "candidate"]) {
		const root = join(directory, arm); mkdirSync(root);
		if (arm === "baseline") execFileSync("tar", ["-xzf", resolve(archive), "-C", root]);
		else for (const file of files) { mkdirSync(dirname(join(root, file)), { recursive: true }); copyFileSync(file, join(root, file)); }
		const armFiles = (arm === "baseline" ? archiveFiles.filter((f) => /^(src\/|server\/|package)/.test(f)) : files).sort();
		production[arm] = hashes(root, armFiles);
		mkdirSync(join(root, "eval"), { recursive: true });
		copyFileSync("eval/requirementIntake.ts", join(root, "eval/requirementIntake.ts"));
		symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
	}
	const priorBytes = priorPath ? readFileSync(resolve(priorPath), "utf8") : undefined, prior = priorBytes ? reviewedMatrix(priorBytes, reviewedTransportRequest) : undefined;
	if (priorPath && prior) {
		const bytes = readFileSync(join(dirname(resolve(priorPath)), "plan.json")); assert.equal(sha256(bytes), prior.planSha256, "prior_plan_changed");
		const old = JSON.parse(bytes.toString()); assert.equal(old.suiteSha256, suite.manifestSha256, "prior_suite_changed"); assert.deepEqual(old.production, production, "continuation_production_changed");
		for (const file of sharedFiles.filter((f) => f !== "eval/requirementAutomaticRun.ts")) assert.equal(old.sharedHashes[file], sha256(readFileSync(file)), "continuation_execution_or_score_changed");
	}
	const plan = { protocol: "requirement-automatic-matrix.v1", suiteSha256: suite.manifestSha256, sharedHashes: hashes(process.cwd(), sharedFiles), production,
		priorMatrix: priorPath && prior ? { path: resolve(priorPath), sha256: sha256(priorBytes!), reservedUsd: prior.reservedUsd, usdLimit: prior.usdLimit, skippedAttemptIds: prior.results.map((r) => r.id), ...(reviewedTransportRequest ? { reviewedTransportRequest } : {}) } : null,
		outputLimitPolicy: prior ? "retain_reservation_skip_attempt_continue_independent" : "stop_batch",
		models: priceProfiles, priceSource: "https://api-docs.deepseek.com/quick_start/pricing/", priceVerifiedOn: "2026-09-26", priceBasis: "Peak ceiling; not invoice; V4-Flash alias serves V4.1-Flash; V4-Pro kept per current pricing and changelog",
		limits: { ...intakeLimits, maxOutputTokens: 8192 }, context: runtimeContextSettings({ PACKX_MODEL_MAX_OUTPUT_TOKENS: "8192" }),
		attempts: matrixPlan(suite.manifest.caseIds), historicalEvidence: { manifestSha256: sha256(readFileSync(join(archiveDirectory, "manifest.json"))), reportSha256: archiveManifest.finalReportSha256, retainedReservationUsd: archiveManifest.retainedReservationUsd, retainedUnknowns: archiveManifest.retainedUnknowns, note: "Separate previous authorization; preserved, never replayed or charged to this new cap" } };
	writeFileSync(join(directory, "plan.json"), JSON.stringify(plan, null, "\t") + "\n", { flag: "wx", mode: 0o600 });
	return plan;
}

export function attemptSummary(attempt: Attempt, result: IntakeResult, calls: Call[]) {
	const own = calls.filter((c) => c.caseId === attempt.id), generations = own.filter((c) => c.kind === "generate");
	const toolEvents = result.traceEvents.filter((e) => e.type === "tool.completed");
	return { ...attempt, executionStatus: result.status, verdict: verdict(result), error: result.error ?? null,
		checkpoints: result.checkpoints.length, failedChecks: result.checkpoints.flatMap((p) => p.checks.filter((c) => c.status !== "passed").map((c) => ({ checkpoint: p.capture.id, id: c.id, category: c.category, status: c.status }))),
		durationMs: result.executionDurationMs, modelCalls: generations.length, countCalls: own.length - generations.length,
		toolCalls: toolEvents.length, toolFailures: toolEvents.filter((e) => e.status !== "succeeded").length,
		toolStatuses: Object.fromEntries(["succeeded", "failed", "denied", "unknown"].map((status) => [status, toolEvents.filter((e) => e.status === status).length])),
		toolFailureCodes: toolEvents.flatMap((e) => e.failureCode ? [e.failureCode] : []),
		modelDurationMs: generations.reduce((sum, c) => sum + (c.durationMs ?? 0), 0), toolDurationMs: toolEvents.reduce((sum, e) => sum + e.durationMs, 0),
		compactions: result.traceEvents.filter((e) => e.type === "context.compacted").length,
		knownUsageUsd: generations.reduce((sum, c) => sum + (c.response || c.failedResponse ? pricedUsage((c.response ?? c.failedResponse)!, priceProfiles[attempt.model]) : 0), 0),
		reservedUsd: own.reduce((sum, c) => sum + c.reservationUsd, 0), unresolvedCalls: own.filter((c) => c.status !== "completed").length,
		unavailableUsageCalls: generations.filter((c) => !c.response && !c.failedResponse).length,
		usage: Object.fromEntries(["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"].map((key) => [key, generations.reduce((sum, c) => sum + ((c.response ?? c.failedResponse)?.usage[key as keyof NonNullable<Call["response"]>["usage"]] ?? 0), 0)])),
		responseModels: [...new Set(generations.map((c) => (c.response as { telemetry?: { model?: string } } | undefined)?.telemetry?.model).filter(Boolean))],
	};
}

export function matrixSummary(plan: Attempt[], results: Array<ReturnType<typeof attemptSummary>>) {
	const distribution = (values: number[]) => {
		const sorted = values.toSorted((a, b) => a - b), n = sorted.length;
		return n ? { median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2, min: sorted[0], max: sorted[n - 1] } : null;
	};
	return [...new Set(plan.map((a) => `${a.model}/${a.arm}`))].map((group) => {
		const planned = plan.filter((a) => `${a.model}/${a.arm}` === group), own = results.filter((r) => `${r.model}/${r.arm}` === group), passed = own.filter((r) => r.verdict === "passed"), cost = own.reduce((sum, r) => sum + r.knownUsageUsd, 0);
		return { group, planned: planned.length, recorded: own.length, notRecorded: planned.length - own.length, passed: passed.length, failed: own.filter((r) => r.verdict === "failed").length, needsReview: own.filter((r) => r.verdict === "needs_review").length,
			passRateStarted: own.length ? passed.length / own.length : null, knownUsageUsd: cost, knownCostPerSuccessUsd: passed.length ? cost / passed.length : null, hasUnknownUsage: own.some((r) => r.unavailableUsageCalls > 0),
			durationAllMs: distribution(own.map((r) => r.durationMs)), durationPassedMs: distribution(passed.map((r) => r.durationMs)), generationsPerAttempt: distribution(own.map((r) => r.modelCalls)), toolsPerAttempt: distribution(own.map((r) => r.toolCalls)),
			cases: [...new Set(planned.map((a) => a.caseId))].map((caseId) => ({ caseId, planned: planned.filter((a) => a.caseId === caseId).length, outcomes: own.filter((r) => r.caseId === caseId).map((r) => ({ repeat: r.repeat, verdict: r.verdict, error: r.error })), allThreePassed: own.filter((r) => r.caseId === caseId && r.verdict === "passed").length === 3 })),
		};
	});
}

async function main() {
	const { values } = parseArgs({ options: { prepare: { type: "boolean" }, online: { type: "boolean" }, directory: { type: "string" }, "usd-limit": { type: "string" }, "reviewed-prior-matrix": { type: "string" }, "reviewed-transport-request": { type: "string" } } });
	if (!values.prepare && !values.online) { console.log(JSON.stringify({ mode: "plan_no_network", attempts: matrixPlan(loadAutomaticSuite().manifest.caseIds), required: "--prepare --directory <new path>; then --online --directory <prepared path> --usd-limit <new cap>" }, null, 2)); return; }
	assert(values.directory && values.prepare !== values.online, "choose_prepare_or_online");
	const directory = resolve(values.directory);
	if (values.prepare) { const plan = prepare(directory, values["reviewed-prior-matrix"], values["reviewed-transport-request"]); console.log(JSON.stringify({ directory, attempts: plan.attempts.length, skippedAttempts: plan.priorMatrix?.skippedAttemptIds.length ?? 0, planSha256: sha256(readFileSync(join(directory, "plan.json"))) })); return; }
	assert(!values["reviewed-prior-matrix"] && !values["reviewed-transport-request"], "prior_must_be_frozen_at_prepare");
	const planBytes = readFileSync(join(directory, "plan.json")), plan = JSON.parse(planBytes.toString()) as ReturnType<typeof prepare>;
	const suite = loadAutomaticSuite();
	assert.equal(plan.suiteSha256, suite.manifestSha256, "suite_changed");
	assert.deepEqual(plan.sharedHashes, hashes(process.cwd(), sharedFiles), "shared_execution_or_scoring_changed");
	// Scoring and the common Provider Adapter are imported from the working tree; pin those transitive dependencies as well.
	assert.deepEqual(plan.production.candidate, hashes(process.cwd(), Object.keys(plan.production.candidate)), "shared_production_dependencies_changed");
	for (const arm of ["baseline", "candidate"]) {
		assert.deepEqual(plan.production[arm], hashes(join(directory, arm), Object.keys(plan.production[arm])), "frozen_source_changed");
		assert.equal(sha256(readFileSync(join(directory, arm, "eval/requirementIntake.ts"))), plan.sharedHashes["eval/requirementIntake.ts"], "frozen_executor_changed");
	}
	assert(!existsSync(join(directory, "report.json")), "existing_matrix_never_replayed");
	const usdLimit = Number(values["usd-limit"]); assert(Number.isFinite(usdLimit) && usdLimit > 0 && usdLimit <= 20, "explicit_new_cap_up_to_20_required");
	const priorBytes = plan.priorMatrix ? readFileSync(plan.priorMatrix.path, "utf8") : undefined;
	if (plan.priorMatrix) assert.equal(sha256(priorBytes!), plan.priorMatrix.sha256, "prior_report_changed");
	const prior = priorBytes ? reviewedMatrix(priorBytes, plan.priorMatrix?.reviewedTransportRequest) : undefined;
	if (prior) { assert.equal(prior.usdLimit, usdLimit, "total_cap_cannot_reset"); assert(prior.reservedUsd < usdLimit, "no_remaining_budget"); }
	writeFileSync(join(directory, "runner.lock"), `${process.pid}\n`, { flag: "wx", mode: 0o600 });
	const env = { ...process.env }; new ModelSettings(resolve(env.PACKX_SETTINGS_PATH ?? ".packx-settings.json"), env).apply(env);
	assert(env.ANTHROPIC_API_KEY && env.ANTHROPIC_BASE_URL?.replace(/\/$/, "") === "https://api.deepseek.com/anthropic", "official_configured_provider_required");
	// Freeze effective runtime budgets independently of mutable user settings.
	const runtimeEnv = { PACKX_MODEL_MAX_OUTPUT_TOKENS: "8192" };
	assert.deepEqual(runtimeContextSettings(runtimeEnv), plan.context, "context_changed");
	const ledger: Ledger = { usdLimit, calls: [], priorReservedUsd: prior?.reservedUsd ?? 0 };
	const results: Array<ReturnType<typeof attemptSummary>> = prior ? [...prior.results] : [];
	let active: { attempt: Attempt; result: IntakeResult } | undefined;
	let status = "running";
	let budgetStopped = false;
	const save = () => {
		if (active) atomicReport(join(directory, `${active.attempt.id}.json`), { attempt: active.attempt, result: active.result, calls: ledger.calls.filter((c) => c.caseId === active!.attempt.id) });
		atomicReport(join(directory, "report.json"), { protocol: plan.protocol, planSha256: sha256(planBytes), suiteSha256: plan.suiteSha256, status, semanticQuality: "NOT_EVALUATED", usdLimit, priorReservedUsd: ledger.priorReservedUsd, priorMatrix: plan.priorMatrix, outputLimitPolicy: plan.outputLimitPolicy, reservedUsd: reservedUsd(ledger), unresolved: Boolean(prior) || unresolved(ledger), blockingUnresolved: unresolved(ledger) && !(plan.outputLimitPolicy === "retain_reservation_skip_attempt_continue_independent" && onlyOutputLimitUnknowns(ledger.calls)), results, summary: matrixSummary(plan.attempts, results),
			active: active ? { ...active.attempt, executionStatus: active.result.status } : null,
			calls: ledger.calls.map(({ request: _request, response, ...call }) => ({ ...call, ...(response ? { usage: response.usage } : {}) })) });
	};
	const executors: Record<string, typeof executeIntakeCase> = {};
	for (const arm of ["baseline", "candidate"]) executors[arm] = (await import(pathToFileURL(join(directory, arm, "eval/requirementIntake.ts")).href)).executeIntakeCase;
	save();
	try {
		for (const attempt of plan.attempts) {
			if (results.some((result) => result.id === attempt.id)) continue;
			const input = suite.cases.find((c) => c.id === attempt.caseId)!, oracle = suite.oracles.find((o) => o.caseId === attempt.caseId)!;
			const result = newIntakeResult(input); active = { attempt, result }; save();
			const client = new AnthropicModelProvider(new AnthropicMessagesClient({ baseUrl: env.ANTHROPIC_BASE_URL!, apiKey: env.ANTHROPIC_API_KEY! }), attempt.model, 8192);
			// Each independent attempt retains the entire prior reserve. An unknown blocks this attempt; no call from it is retried.
			const local: Ledger = { usdLimit, priorReservedUsd: reservedUsd(ledger), calls: [] }; let copied = 0;
			const saveCall = () => { ledger.calls.push(...local.calls.slice(copied)); copied = local.calls.length; save(); };
			const bounded = boundedProvider(client, local, attempt.id, () => input.events[result.nextEvent]?.id ?? "end", saveCall, priceProfiles[attempt.model]);
			const provider: AgentModelProvider = { ...bounded, async generate(request, signal) {
				try { return await bounded.generate(request, signal); }
				catch (error) { if (failureCode(error) === "usd_limit") budgetStopped = true; throw error; }
			} };
			await executors[attempt.arm]({ input, oracle, result, directory: join(directory, "state", attempt.id), provider, environment: runtimeEnv, score: scoreAutomatic, save });
			results.push(attemptSummary(attempt, result, ledger.calls)); save();
			console.log(JSON.stringify({ attempt: attempt.id, result: verdict(result), error: result.error, completedAttempts: results.length, reservedUsd: reservedUsd(ledger) }));
			if (unresolved(local) && !(plan.outputLimitPolicy === "retain_reservation_skip_attempt_continue_independent" && onlyOutputLimitUnknowns(local.calls))) { status = "stopped_unknown"; break; }
			if (budgetStopped) { status = "stopped_budget"; break; }
		}
		if (status === "running") status = "completed";
	} catch (error) { status = unresolved(ledger) ? "stopped_unknown" : "stopped_error"; throw error; }
	finally { save(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(failureCode(error)); process.exitCode = 1; });
