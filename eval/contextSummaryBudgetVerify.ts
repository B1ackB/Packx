import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { compactSummaryPrefix, ContextEngine } from "../src/agent/context";
import type { AgentMessage, AgentModelProvider, AgentModelRequest, AgentUsage } from "../src/agent/contracts";
import { ModelContextSummarizer } from "../src/agent/summarizer";
import { AnthropicMessagesClient } from "../server/anthropic/client";
import { ModelSettings } from "../server/modelSettings";
import { AnthropicModelProvider } from "../server/runtime/anthropicModelProvider";
import { FileAgentStateStore } from "../server/runtime/fileAgentStateStore";

// Isolated summary experiment, not a Runtime/AgentLoop or context_read evaluation.
// The only source material is the pinned synthetic first-round archive and its
// retained requirement/Host messages. --plan never reads settings or calls a model.
const protocol = "context-summary-budget.verify.v1";
const scope = { tenantId: "eval", workspaceId: "synthetic", runId: "continuation", sessionId: "continuation" };
const configurations = [4, 8, 16, 32].map((maxCalls) => ({ maxCalls, maxInputTokens: 6000, maxOutputTokens: 512, maxTotalTokens: maxCalls * 6512 }));
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => sha256(canonical(value));
const code = (error: unknown) => error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "inspect_call_ledger";

interface PriorReport {
	protocol: string;
	requestedModel: string;
	reservedUsd: number;
	limits: { usd: number };
	calls: Array<{ status: string; phase?: string; purpose?: string; summarySource?: { callId: string } }>;
	countRequests?: Array<{ status: string }>;
	unresolved?: boolean;
}
interface SourceReport extends PriorReport {
	fixtureHash: string;
	temporaryStateDirectory: string;
	query: string;
	hostContent: string;
	expected: Record<string, number | string | boolean>;
	results: Array<{ phase: string; sourceRef?: string; messageIndex?: number }>;
}
interface Call {
	phase: string;
	purpose: "summary" | "turn";
	status: "started" | "completed" | "unknown";
	requestSha256: string;
	callContext: AgentModelRequest["callContext"];
	countedInput: number;
	reservedOutput: number;
	reservedUsd: number;
	usage?: AgentUsage;
	text?: string;
	toolCalls?: unknown;
	telemetry?: unknown;
	durationMs?: number;
}

async function main() {
	const { values } = parseArgs({ options: { plan: { type: "boolean" }, online: { type: "boolean" }, "source-report": { type: "string" }, "prior-report": { type: "string" }, report: { type: "string" } } });
	if (Boolean(values.plan) === Boolean(values.online)) throw new Error("choose_plan_or_authorized_online");
	if (!values["source-report"] || !values["prior-report"] || !values.report) throw new Error("source_prior_and_new_report_paths_required");
	const sourcePath = resolve(values["source-report"]), priorPath = resolve(values["prior-report"]), output = resolve(values.report);
	if (existsSync(output) || existsSync(`${output}.next`)) throw new Error("existing_report_must_not_be_overwritten_or_replayed");
	const sourceBytes = readFileSync(sourcePath, "utf8"), priorBytes = readFileSync(priorPath, "utf8");
	const source = JSON.parse(sourceBytes) as SourceReport, prior = JSON.parse(priorBytes) as PriorReport;
	if (source.protocol !== "context-continuation.verify.v1" || source.fixtureHash !== "1fa06a791b8a62374aa07d0a538e5047c3e8502ba42f6421d8732ff3697e68b4" || source.requestedModel !== "deepseek-v4-flash" || !source.temporaryStateDirectory) throw new Error("source_fixture_or_model_mismatch");
	if (!Array.isArray(prior.calls) || prior.calls.some((call) => call.status !== "completed") || prior.unresolved || prior.countRequests?.some((call) => call.status !== "completed") || prior.requestedModel !== source.requestedModel || !Number.isFinite(prior.reservedUsd) || prior.reservedUsd < 0) throw new Error("invalid_or_unresolved_prior_ledger");
	// Keep the inherited cap, including its recorded floating-point representation.
	const usdLimit = prior.limits?.usd;
	if (!Number.isFinite(usdLimit) || Math.abs(usdLimit - 2.929132) > 1e-9 || prior.reservedUsd >= usdLimit) throw new Error("invalid_inherited_budget");
	const location = source.results.find((result) => result.phase === "positive-control-location");
	const firstTurn = source.calls.find((call) => call.phase === "compact-round-1" && call.purpose === "turn");
	if (!location?.sourceRef || location.messageIndex !== 71 || firstTurn?.status !== "completed" || !firstTurn.summarySource?.callId) throw new Error("missing_first_round_source");
	const store = new FileAgentStateStore(join(source.temporaryStateDirectory, "evolving"));
	const archive = store.read(scope, location.sourceRef), firstRequest = store.read(scope, firstTurn.summarySource.callId);
	if (archive.purpose !== "archive" || archive.messages.length !== 146 || digest(archive.messages) !== "35230b3a6f649c9bdc1803db8e66086d3f7a0d61608f889ced86766bf7fbd319") throw new Error("first_round_archive_changed");
	const requirements = firstRequest.messages.filter((message) => message.messageId === "requirements");
	const hosts = firstRequest.messages.filter((message) => message.kind === "task_context");
	const instructions = firstRequest.messages.filter((message) => message.role === "system").map((message) => message.content);
	if (requirements.length !== 1 || hosts.length !== 1 || hosts[0].content !== source.hostContent) throw new Error("retained_scoring_context_missing");
	const requirement = requirements[0], host = hosts[0], expected = source.expected;
	const scoringSource = { instructions, host, requirement, query: source.query, expected };
	if (digest(scoringSource) !== "923623c6ab9fe0f2ad4cd73883077160ef4765b4feae21fa9c0de1eddabbc25d") throw new Error("fixed_scoring_context_changed");
	const schema = { type: "object", additionalProperties: false, required: Object.keys(expected), properties: Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, { type: [typeof value === "number" ? "integer" : typeof value, "null"], ...(key === "pendingQuantity" ? { description: "Proposed replacement TOTAL order quantity, not increment or difference." } : {}), ...(key === "nextAction" ? { description: "Use await_supplier_certificate if waiting for the supplier's qualification certificate; otherwise null." } : {}) }])) };
	const limits = { usd: usdLimit, calls: 80, countRequests: 360, inputTokens: 100_000, outputTokens: 4096, timeoutMsPerConfiguration: 180_000 };
	const provenance = {
		sourceReport: sourcePath, priorReport: priorPath, sourceReportSha256: sha256(sourceBytes), priorReportSha256: sha256(priorBytes),
		sourceRef: location.sourceRef, messageIndex: location.messageIndex, sourceMessages: archive.messages.length, sourceSnapshotSha256: digest(archive), sourceMessagesSha256: digest(archive.messages),
		retainedRequestSnapshotId: firstRequest.snapshotId, retainedRequestSnapshotSha256: digest(firstRequest), retainedRequirementSha256: digest(requirement), scoringSourceSha256: digest(scoringSource),
	};
	const scriptSha256 = sha256(readFileSync(new URL(import.meta.url)));
	const sourceHashes = Object.fromEntries(["src/agent/context.ts", "src/agent/summarizer.ts", "server/runtime/anthropicModelProvider.ts", "server/anthropic/client.ts"].map((path) => [path, sha256(readFileSync(resolve(path)))]));
	const plan = { protocol, syntheticOnly: true, scope, configurations, limits, provenance, scriptSha256, sourceHashes, requestedModel: source.requestedModel, priorReservedUsd: prior.reservedUsd, initialRemainingReservedUsd: usdLimit - prior.reservedUsd, maximumProtocolGenerations: configurations.reduce((sum, config) => sum + config.maxCalls + 1, 0), summaryCountCache: true, scoring: "ContextEngine.compile: same system instructions + Host + retained requirements + new unverified summary + original query; tools=[]; one answer per configuration", limitation: "Isolated summary experiment; no Runtime, retrieval, source lifecycle enforcement, or iterative recovery. Reservation is a ceiling estimate, not the provider invoice." };
	if (values.plan) { console.log(JSON.stringify(plan, null, "\t")); return; }

	const environment = { ...process.env };
	new ModelSettings(resolve(environment.PACKX_SETTINGS_PATH ?? ".packx-settings.json"), environment).apply(environment);
	if (environment.ANTHROPIC_BASE_URL?.replace(/\/$/, "") !== "https://api.deepseek.com/anthropic" || environment.ANTHROPIC_MODEL !== source.requestedModel || !environment.ANTHROPIC_API_KEY) throw new Error("configured_official_deepseek_model_required");
	const provider = new AnthropicModelProvider(new AnthropicMessagesClient({ baseUrl: environment.ANTHROPIC_BASE_URL!, apiKey: environment.ANTHROPIC_API_KEY! }), source.requestedModel, limits.outputTokens);
	const calls: Call[] = [], results: Array<Record<string, unknown>> = [];
	const countRequests: Array<{ phase: string; purpose: string; requestSha256: string; callContext: AgentModelRequest["callContext"]; status: "started" | "completed" | "unknown"; tokens?: number; durationMs?: number }> = [];
	const report = { ...plan, baselineCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), generatedAt: new Date().toISOString(), status: "running", rates: { inputPerMillionUsd: 0.3, outputPerMillionUsd: 1.2, basis: "Same reservation rates as preceding experiment; cache discounts ignored; not billed cost." }, reservedUsd: prior.reservedUsd, tokenCountRequests: 0, countCacheHits: 0, unresolved: false, calls, countRequests, results, scoringSource, outputSchema: schema };
	const save = (initial = false) => {
		const target = initial ? output : `${output}.next`;
		writeFileSync(target, JSON.stringify(report, null, "\t") + "\n", { flag: "wx", mode: 0o600 });
		if (!initial) renameSync(target, output);
	};
	const cache = new Map<string, number>();
	let phase = "initial";
	const count = async (request: AgentModelRequest, signal?: AbortSignal) => {
		if (report.unresolved) throw new Error("uncertain_request_requires_review");
		signal?.throwIfAborted();
		const key = digest({ messages: request.messages, tools: request.tools, outputSchema: request.outputSchema, reasoning: request.reasoning });
		if (cache.has(key)) { report.countCacheHits++; return cache.get(key)!; }
		if (countRequests.length >= limits.countRequests) throw new Error("count_budget_exceeded");
		const entry: typeof countRequests[number] = { phase, purpose: request.callContext?.purpose ?? "turn", requestSha256: digest(request), callContext: request.callContext, status: "started" };
		countRequests.push(entry); report.tokenCountRequests = countRequests.length; save();
		const started = performance.now();
		try {
			const tokens = await provider.countTokens(request, signal);
			if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("invalid_token_count");
			Object.assign(entry, { status: "completed", tokens, durationMs: Math.round(performance.now() - started) });
			cache.set(key, tokens); save(); return tokens;
		} catch (error) { entry.status = "unknown"; entry.durationMs = Math.round(performance.now() - started); report.unresolved = true; save(); throw error; }
	};
	const bounded: AgentModelProvider = { countTokens: count, generate: async (request, signal) => {
		if (report.unresolved) throw new Error("uncertain_request_requires_review");
		const countedInput = await count(request, signal), purpose = request.callContext?.purpose ?? "turn", reservedOutput = request.maxOutputTokens ?? limits.outputTokens;
		if (request.tools.length || countedInput > (purpose === "summary" ? 6000 : limits.inputTokens) || reservedOutput !== (purpose === "summary" ? 512 : limits.outputTokens)) throw new Error("request_limits_changed");
		const reservation = (countedInput * report.rates.inputPerMillionUsd + reservedOutput * report.rates.outputPerMillionUsd) / 1e6;
		if (calls.length >= limits.calls || report.reservedUsd + reservation > usdLimit) throw new Error("generation_budget_exceeded");
		report.reservedUsd += reservation;
		const call: Call = { phase, purpose, status: "started", requestSha256: digest(request), callContext: request.callContext, countedInput, reservedOutput, reservedUsd: reservation };
		calls.push(call); save(); const started = performance.now();
		try {
			const response = await provider.generate(request, signal);
			Object.assign(call, { status: "completed", usage: response.usage, text: response.text, toolCalls: response.toolCalls, telemetry: response.telemetry, durationMs: Math.round(performance.now() - started) });
			save(); return response;
		} catch (error) { call.status = "unknown"; call.durationMs = Math.round(performance.now() - started); report.unresolved = true; save(); throw error; }
	} };
	save(true);
	try {
		for (const config of configurations) {
			phase = `summary-calls-${config.maxCalls}`;
			const started = performance.now(), before = calls.length, reservedBefore = report.reservedUsd;
			const result: Record<string, unknown> = { phase, status: "started", budget: config }; results.push(result); save();
			console.log(JSON.stringify({ phase, status: "started", reservedUsd: report.reservedUsd }));
			try {
				const signal = AbortSignal.timeout(limits.timeoutMsPerConfiguration);
				const summary = await new ModelContextSummarizer(bounded, config).summarize(archive.messages, signal, location.sourceRef);
				const summaryCalls = calls.slice(before).filter((call) => call.purpose === "summary");
				Object.assign(result, { summary, labDeliveredToSummary: summaryCalls.some((call) => { const range = call.callContext?.sourceRange; return range && range[0] <= location.messageIndex! && range[1] > location.messageIndex!; }), sourceRanges: summaryCalls.map((call) => call.callContext?.sourceRange) }); save();
				const summaryMessage: AgentMessage = { role: "user", kind: "summary", content: `${compactSummaryPrefix}\n${summary.text}`, readDependencies: [location.sourceRef] };
				const messages = new ContextEngine().compile({ instructions, skills: [], history: [host, requirement, summaryMessage], input: source.query });
				const request: AgentModelRequest = { messages, tools: [], outputSchema: schema, fallbackOutput: "Verification failed", maxOutputTokens: limits.outputTokens, callContext: { purpose: "turn", callId: `${phase}-answer` } };
				Object.assign(result, { answerRequestSha256: digest(request), answerMessagesSha256: digest(messages), answerInputChars: new ContextEngine().size(messages), summaryChars: summaryMessage.content.length }); save();
				const answerResponse = await bounded.generate(request, signal);
				let answer: Record<string, unknown> | undefined;
				try { const parsed: unknown = JSON.parse(answerResponse.text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) answer = parsed as Record<string, unknown>; } catch { /* A completed invalid answer is a scored result, never retried. */ }
				const checks = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, answer?.[key] === value]));
				const schemaValid = Boolean(answer && Object.keys(answer).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => key in answer! && (answer![key] === null || (typeof answer![key] === typeof value && (typeof value !== "number" || Number.isInteger(answer![key]))))));
				Object.assign(result, { status: "completed", answer: answer ?? null, checks, correctFields: Object.values(checks).filter(Boolean).length, schemaValid, passed: !answerResponse.toolCalls.length && schemaValid && Object.values(checks).every(Boolean) });
			} catch (error) { Object.assign(result, { status: "stopped", error: code(error), passed: false }); throw error; }
			finally {
				Object.assign(result, { durationMs: Math.round(performance.now() - started), generationCalls: calls.length - before, reservedUsd: report.reservedUsd - reservedBefore }); save();
				console.log(JSON.stringify({ phase, status: result.status, coverage: (result.summary as { coverage?: unknown } | undefined)?.coverage, correctFields: result.correctFields, labDeliveredToSummary: result.labDeliveredToSummary, reservedUsd: report.reservedUsd }));
			}
		}
		report.status = "completed";
	} catch (error) { report.status = "stopped"; results.push({ phase: "experiment-stopped", error: code(error), unresolved: report.unresolved }); process.exitCode = 1; }
	if (results.some((result) => result.passed === false)) process.exitCode = 1;
	save();
	console.log(JSON.stringify({ report: output, status: report.status, calls: calls.length, tokenCountRequests: countRequests.length, reservedUsd: report.reservedUsd, allScoresPassed: results.every((result) => result.passed === true) }));
}

await main().catch((error: unknown) => { console.error(JSON.stringify({ status: "stopped", error: code(error) })); process.exitCode = 1; });
