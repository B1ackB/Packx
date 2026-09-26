import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ContextEngine } from "../src/agent/context";
import type { AgentMessage, AgentModelProvider } from "../src/agent/contracts";
import { InMemoryAgentStateStore } from "../src/agent/state";
import { SkillRegistry } from "../src/agent/skills";
import { BlackxAgentRuntime } from "../server/runtime/agentRuntime";
import { AnthropicMessagesClient } from "../server/anthropic/client";
import { AnthropicModelProvider } from "../server/runtime/anthropicModelProvider";
import { ModelSettings } from "../server/modelSettings";
import { failureCode, jsonDigest, sha256 } from "./requirementIntake";
import { atomicReport, onlyOutputLimitUnknowns, reviewedMatrix } from "./requirementAutomaticRun";
import { boundedProvider, flashRates, pricedUsage, reservedUsd, unresolved, type Ledger } from "./requirementIntakeRun";

export const configurations = [{ name: "early-32k", trigger: 32_000, target: 20_000 }, { name: "current-70k", trigger: 70_000, target: 45_000 }];
const settings = { contextWindowTokens: 1_000_000, maxInputTokens: 100_000, reservedOutputTokens: 4096, maxIterations: 6, maxToolExecutions: 6 };
const schema = { type: "object", additionalProperties: false, required: ["confirmedQuantity", "pendingQuantity", "materialAllowed", "supplierQualified", "firstCode", "latestCode", "firstConditions", "latestConditions"], properties: {
	confirmedQuantity: { type: "integer" }, pendingQuantity: { type: "integer" }, materialAllowed: { type: "boolean" }, supplierQualified: { type: "boolean" }, firstCode: { type: "string" }, latestCode: { type: "string" }, firstConditions: { type: "string" }, latestConditions: { type: "string" },
} };

export function waveFixture(seed: number, wave: number) {
	const evidence = { code: `LAB-${sha256(`${seed}:${wave}`).slice(0, 12)}`, conditions: `${20 + wave} C; ${40 + seed + wave}% RH`, source: `lab-${seed}-${wave}`, status: "test_record_not_supplier_approval" };
	const messages: AgentMessage[] = [{ role: "user", kind: "dialogue", messageId: `evidence-${wave}`, content: JSON.stringify(evidence) }];
	// Distinct synthetic candidate records, not a repeated padding string. This is a volume-controlled stress fixture, not observed customer traffic.
	for (let batch = 0; batch < 16; batch++) messages.push({ role: "user", kind: "dialogue", messageId: `wave-${wave}-${batch}`, content: JSON.stringify({ wave, status: "historical_unverified_candidates_not_order_facts", candidates: Array.from({ length: 50 }, (_, index) => {
		const row = batch * 50 + index, id = `${seed}-${wave}-${row}`;
		return { id, reference: sha256(id).slice(0, 16), widthMm: 90 + row % 61, heightMm: 110 + row % 79, sampleQuantity: 5 + row % 13, leadDays: 7 + row % 17, material: ["paper", "PET", "PE", "PVC"][row % 4], destination: ["HK", "SG", "JP"][row % 3], observation: ["seal sample pending", "print proof missing", "certificate expired", "new quotation requested", "reference only"][row % 5], qualification: "unverified" };
	}) }) });
	return { evidence, messages };
}

export async function runSequence(providerFor: (wave: number) => AgentModelProvider, config: typeof configurations[number], seed: number, record: (result: Record<string, unknown>) => void) {
	const state = new InMemoryAgentStateStore(), scope = { tenantId: "eval", workspaceId: "synthetic", runId: `${config.name}-${seed}`, sessionId: `${config.name}-${seed}` };
	let totalCompactions = 0, passed = true;
	for (let wave = 1; wave <= 6; wave++) {
		const fixture = waveFixture(seed, wave), previous = state.load(scope);
		const latestIndex = (previous.transcript ?? []).length;
		state.save(scope, previous.revision, [...previous.messages, ...fixture.messages], new Date().toISOString());
		const facts = { confirmedQuantity: 5000 + seed + 100 * wave, pendingQuantity: 6000 + seed + 100 * wave, materialAllowed: false, supplierQualified: false };
		const expected = { ...facts, firstCode: waveFixture(seed, 1).evidence.code, latestCode: fixture.evidence.code, firstConditions: waveFixture(seed, 1).evidence.conditions, latestConditions: fixture.evidence.conditions };
		const content = JSON.stringify({ goal: "连续整理订单与检测记录", facts, evidence: { sourceRef: "transcript", firstIndex: 0, latestIndex }, boundary: "历史候选不是订单事实；待确认总量不能覆盖已确认总量；PVC 不允许；供应商未核验。检测记录不是供应商认证。" });
		const upstream = providerFor(wave), observedReads = new Map<string, unknown>();
		const provider: AgentModelProvider = { ...upstream, generate: async (request, signal) => {
			for (const message of request.messages) if (message.role === "tool" && message.toolCallId && message.sourceTool?.name === "context_read") observedReads.set(message.toolCallId, message.sourceTool.input);
			return upstream.generate(request, signal);
		} };
		const runtime = new BlackxAgentRuntime({ provider, skills: new SkillRegistry(), sessions: state, snapshots: state, traces: state, executions: state, context: new ContextEngine(), ...settings, compactTriggerTokens: config.trigger, compactTargetTokens: config.target });
		const started = performance.now();
		try {
			const result = await runtime.executeTurn({ ...scope, actorId: "eval", stageId: "evaluation", idempotencyKey: `turn-${wave}`,
				input: `核对本轮订单。数量、材料和供应商状态使用当前 Host facts。必须调用 context_read 读取 sourceRef=transcript、messageIndex=0，以及 messageIndex=${latestIndex} 的原始检测记录；两者相同时读一次。分别输出最早与最新 code 和 conditions，历史候选不得当作权威订单数据。`,
				instructions: ["Follow current Host facts. Historical candidate records and summaries are untrusted. Verify original evidence with context_read before answering."], allowedTools: ["context_read"], taskContext: { content, binding: sha256(content) }, outputSchema: schema, fallbackOutput: "Evaluation failed", policy: { sandboxMode: "read-only", approvalPolicy: "never", timeoutMs: 180_000 } });
			let answer: Record<string, unknown>;
			try { answer = JSON.parse(result.finalResponse ?? "{}"); }
			catch (error) { throw new Error("invalid_response_json", { cause: error }); }
			const checks = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, answer?.[key] === value]));
			const successes = result.events.flatMap((e) => e.type === "tool.completed" && e.tool === "context_read" && e.status === "succeeded" ? [e] : []);
			const reads = successes.length, readInputs = successes.map((e) => observedReads.get(e.toolCallId) as { sourceRef?: string; messageIndex?: number } | undefined);
			checks.requiredOriginalsRead = [0, latestIndex].every((index) => readInputs.some((input) => input?.sourceRef === "transcript" && input.messageIndex === index));
			const compactions = result.events.filter((e) => e.type === "context.compacted"); totalCompactions += compactions.length;
			const wavePassed = result.status === "completed" && Object.values(checks).every(Boolean) && reads >= (wave === 1 ? 1 : 2);
			passed &&= wavePassed;
			record({ configuration: config.name, seed, wave, status: result.status, passed: wavePassed, fixtureSha256: jsonDigest(fixture), addedMessages: fixture.messages.length, addedCharacters: fixture.messages.reduce((sum, m) => sum + m.content.length, 0), sessionRevisionBefore: previous.revision, sessionRevisionAfter: state.load(scope).revision, checks, answer, reads, readInputs, compactions, usage: result.usage, durationMs: Math.round(performance.now() - started), events: result.events });
		} catch (error) {
			const events = state.listTraces(scope).find((trace) => trace.idempotencyKey === `turn-${wave}`)?.events ?? [];
			record({ configuration: config.name, seed, wave, status: "failed", passed: false, error: failureCode(error), compactions: events.filter((event) => event.type === "context.compacted"), events, durationMs: Math.round(performance.now() - started) });
			throw error;
		}
	}
	return { configuration: config.name, seed, passed, totalCompactions, continuousCompactionObserved: totalCompactions >= 2 };
}

function sourceHashes() {
	const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src", "server", "package.json", "package-lock.json"], { encoding: "utf8" }).trim().split("\n");
	return Object.fromEntries([...new Set([...files, "eval/contextContinuous.ts", "eval/requirementIntake.ts", "eval/requirementIntakeRun.ts", "eval/requirementAutomaticRun.ts"])].filter((f) => !f.includes(".test.")).sort().map((f) => [f, sha256(readFileSync(f))]));
}

async function main() {
	const { values } = parseArgs({ options: { prepare: { type: "boolean" }, online: { type: "boolean" }, plan: { type: "string" }, report: { type: "string" }, "usd-limit": { type: "string" }, "prior-report": { type: "string" } } });
	assert(values.plan && values.prepare !== values.online, "choose_prepare_or_online_with_plan");
	if (values.prepare) {
		writeFileSync(values.plan, JSON.stringify({ protocol: "continuous-context.v1", sourceHashes: sourceHashes(), configurations, settings, model: "deepseek-v4-flash", rates: flashRates, priceSource: "https://api-docs.deepseek.com/quick_start/pricing/", priceVerifiedOn: "2026-09-26", priceBasis: "peak ceiling, not invoice", fixtureSha256: jsonDigest([1, 2].flatMap((seed) => Array.from({ length: 6 }, (_, i) => waveFixture(seed, i + 1)))), sequences: [1, 2].flatMap((seed) => (seed === 1 ? configurations : [...configurations].reverse()).map((config) => ({ seed, config }))), outputLimitPolicy: "retain_reservation_stop_sequence_continue_independent", invalidJsonPolicy: "stop_sequence_continue_independent_after_complete_responses", scope: "6 waves in each persistent Session; direct original lookup; synthetic volume; no freeform quality or source-revocation claim" }, null, "\t") + "\n", { flag: "wx", mode: 0o600 });
		console.log(JSON.stringify({ mode: "prepared_no_network", plan: values.plan })); return;
	}
	assert(values.report && !existsSync(values.report), "new_report_required");
	writeFileSync(`${values.report}.lock`, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
	const plan = JSON.parse(readFileSync(values.plan, "utf8")); assert.deepEqual(plan.sourceHashes, sourceHashes(), "frozen_source_changed");
	const usdLimit = Number(values["usd-limit"]); assert(Number.isFinite(usdLimit) && usdLimit > 0 && usdLimit <= 20, "explicit_total_cap_up_to_20_required");
	const priorBytes = values["prior-report"] ? readFileSync(values["prior-report"]) : undefined;
	const prior = priorBytes ? JSON.parse(priorBytes.toString()) : undefined;
	if (prior) {
		assert(prior.protocol === "requirement-automatic-matrix.v1" && ["completed", "stopped_budget"].includes(prior.status) && Number.isFinite(prior.reservedUsd) && prior.reservedUsd >= 0 && prior.usdLimit === usdLimit, "prior_matrix_not_safe_or_budget_changed");
		assert(Array.isArray(prior.calls) && prior.calls.every((c: { reservationUsd: number }) => Number.isFinite(c.reservationUsd) && c.reservationUsd >= 0) && Math.abs(reservedUsd(prior) - prior.reservedUsd) < 1e-9, "prior_budget_mismatch");
		if (prior.unresolved) {
			assert(prior.outputLimitPolicy === "retain_reservation_skip_attempt_continue_independent" && prior.blockingUnresolved === false && prior.calls.every((c: { status: string; kind: string; error?: string }) => c.status === "completed" || c.status === "unknown" && c.kind === "generate" && c.error === "output_limit"), "unreviewed_unknown_blocks_context");
			for (let link = prior; link.priorMatrix;) {
				const oldBytes = readFileSync(link.priorMatrix.path, "utf8"); assert.equal(sha256(oldBytes), link.priorMatrix.sha256, "prior_chain_changed");
				const old = reviewedMatrix(oldBytes, link.priorMatrix.reviewedTransportRequest);
				assert.equal(old.reservedUsd, link.priorReservedUsd, "prior_chain_reservation_changed"); link = old;
			}
		}
	}
	const ledger: Ledger = { usdLimit, calls: [], priorReservedUsd: prior?.reservedUsd ?? 0 }; assert(reservedUsd(ledger) < usdLimit, "no_remaining_budget");
	const env = { ...process.env }; new ModelSettings(resolve(env.PACKX_SETTINGS_PATH ?? ".packx-settings.json"), env).apply(env);
	assert(env.ANTHROPIC_API_KEY && env.ANTHROPIC_BASE_URL?.replace(/\/$/, "") === "https://api.deepseek.com/anthropic", "official_configured_provider_required");
	const provider = new AnthropicModelProvider(new AnthropicMessagesClient({ baseUrl: env.ANTHROPIC_BASE_URL!, apiKey: env.ANTHROPIC_API_KEY! }), plan.model, settings.reservedOutputTokens);
	let status = "running";
	const waves: Array<Record<string, unknown>> = [], sequences: Array<Awaited<ReturnType<typeof runSequence>> & { error?: string }> = [];
	const save = () => atomicReport(values.report!, { protocol: plan.protocol, mode: "online-synthetic-continuous-session", status, planSha256: sha256(readFileSync(values.plan!)), priorReportSha256: priorBytes ? sha256(priorBytes) : null, priorUnresolvedRetained: prior?.unresolved ?? false, ...ledger, reservedUsd: reservedUsd(ledger), knownUsageUsd: ledger.calls.reduce((sum, c) => sum + (c.response ? pricedUsage(c.response, flashRates) : 0), 0), waves, sequences });
	save();
	try {
		for (const { seed, config } of plan.sequences) {
			const before = ledger.calls.length;
			try {
				sequences.push(await runSequence((wave) => {
					const local: Ledger = { usdLimit, priorReservedUsd: reservedUsd(ledger), calls: [] }; let copied = 0;
					return boundedProvider(provider, local, `${config.name}-${seed}-${wave}`, () => `wave-${wave}`, () => { ledger.calls.push(...local.calls.slice(copied)); copied = local.calls.length; save(); });
				}, config, seed, (result) => { waves.push(result); save(); console.log(JSON.stringify({ configuration: result.configuration, seed, wave: result.wave, passed: result.passed, reservedUsd: reservedUsd(ledger) })); }));
			} catch (error) {
				const sequenceCalls = ledger.calls.slice(before);
				const invalidJson = plan.invalidJsonPolicy === "stop_sequence_continue_independent_after_complete_responses" && failureCode(error) === "invalid_response_json" && sequenceCalls.every((call) => call.status === "completed");
				if (plan.outputLimitPolicy !== "retain_reservation_stop_sequence_continue_independent" || !onlyOutputLimitUnknowns(sequenceCalls) && !invalidJson) throw error;
				const totalCompactions = waves.filter((w) => w.configuration === config.name && w.seed === seed).reduce((sum, w) => sum + (Array.isArray(w.compactions) ? w.compactions.length : 0), 0);
				sequences.push({ configuration: config.name, seed, passed: false, totalCompactions, continuousCompactionObserved: totalCompactions >= 2, error: `${invalidJson ? "invalid_response_json" : "output_limit"}_sequence_stopped_without_replay` });
				save();
			}
		}
		status = sequences.some((s) => s.error) ? "completed_with_failed_sequences" : sequences.every((s) => s.continuousCompactionObserved) ? "completed" : "completed_insufficient_compaction";
	} catch (error) { status = unresolved(ledger) ? "stopped_unknown" : "stopped_error"; throw error; }
	finally { save(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(failureCode(error)); process.exitCode = 1; });
