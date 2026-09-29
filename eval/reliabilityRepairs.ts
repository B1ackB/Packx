import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { SkillRegistry } from "../src/agent/skills";
import { InMemoryAgentStateStore } from "../src/agent/state";
import { BlackxAgentRuntime } from "../server/runtime/agentRuntime";
import { compareRequirementField, requirementFieldProtocol } from "../src/manufacturing/requirementField";
import { sha256, type IntakeResult } from "./requirementIntake";
import type { RuntimeTurnRequest } from "../src/runtime/contracts";
import { loadAutomaticSuite } from "./requirementAutomatic";
import { automaticProtocolV2, scoreAutomaticV2 } from "./requirementAutomaticV2";

/** Offline outcome-gate replay, not a new model run or a replay of the full compact sequence. */
export async function replayStaleAnswer() {
	const path = "docs/evidence/automatic-online-2026-09-26/context.report.json.gz", bytes = readFileSync(path);
	const historical = JSON.parse(gunzipSync(bytes).toString());
	const wave = historical.waves.find((item: { configuration: string; seed: number; wave: number }) => item.configuration === "current-70k" && item.seed === 1 && item.wave === 2);
	assert(wave?.answer?.confirmedQuantity === 5101 && wave.answer.pendingQuantity === 6101, "historical_failure_changed");
	const finalText = wave.events.find((event: { type: string }) => event.type === "message.completed").text;
	assert.deepEqual(JSON.parse(finalText), wave.answer);
	const call = historical.calls.find((item: { caseId: string; response?: { text: string } }) => item.caseId === "current-70k-1-2" && item.response?.text === finalText);
	assert(call, "historical_response_not_found");
	const expected: NonNullable<RuntimeTurnRequest["expectedOutputFields"]> = JSON.parse(call.request.messages.find((message: { kind?: string }) => message.kind === "task_context").content).facts;
	assert.deepEqual(expected, { confirmedQuantity: 5201, pendingQuantity: 6201, materialAllowed: false, supplierQualified: false }, "historical_host_facts_changed");
	const outcomes = [];
	for (const guarded of [false, true]) {
		const state = new InMemoryAgentStateStore();
		const runtime = new BlackxAgentRuntime({ skills: new SkillRegistry(), sessions: state, traces: state, provider: {
			async generate() { return { text: finalText, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } }; },
		} });
		const request: RuntimeTurnRequest & { sessionId: string } = { tenantId: "replay", workspaceId: "synthetic", runId: `guard-${guarded}`, sessionId: "replay", stageId: "outcome-check", actorId: "eval", idempotencyKey: "historical-answer",
			input: JSON.stringify(expected), taskContext: { content: JSON.stringify(expected), binding: sha256(JSON.stringify(expected)) },
			...(guarded ? { expectedOutputFields: expected } : {}), allowedTools: [], fallbackOutput: "", policy: { sandboxMode: "read-only" as const, approvalPolicy: "never" as const, timeoutMs: 5000 } };
		let failure: string | null = null;
		try { await runtime.executeTurn(request); } catch (error) { failure = (error as { code: string }).code; }
		const traces = state.listTraces(request), savedReply = (state.load(request).transcript ?? []).some(message => message.messageId?.startsWith("reply-"));
		assert.equal(failure, guarded ? "invalid_output" : null);
		assert.equal(savedReply, !guarded);
		outcomes.push({ guarded, failure, savedReply, rejections: traces.flatMap(trace => trace.events.filter(event => event.type === "output.rejected")) });
	}
	return { source: path, sourceSha256: sha256(bytes), finalTextSha256: sha256(finalText), observed: wave.answer, expected, outcomes };
}

/** Diagnostic rescoring only: old observations, execution failures and reports remain unchanged. */
function rescoreSavedFields() {
	const directory = "docs/evidence/automatic-online-2026-09-26", suite = loadAutomaticSuite();
	const files = readdirSync(directory).filter(file => /^(?:initial\.)?(?:flash-baseline|flash-candidate|pro-candidate)-AI-\d+-\d+\.json\.gz$/.test(file)).sort();
	const observations = files.map(file => {
		const bytes = readFileSync(`${directory}/${file}`);
		const { attempt, result } = JSON.parse(gunzipSync(bytes).toString()) as { attempt: { id: string }; result: IntakeResult };
		const oracle = suite.oracles.find(item => item.caseId === result.caseId)!;
		assert(oracle, "historical_oracle_missing");
		const checkpoints = result.checkpoints.map((saved, index) => {
			const point = oracle.checkpoints.find(item => item.id === saved.capture.id)!;
			assert(point, "historical_checkpoint_missing");
			const updated = scoreAutomaticV2(saved.capture, point, oracle, result.checkpoints.slice(0, index));
			return { id: point.id, originalVerdict: saved.verdict, rescoredVerdict: updated.verdict, changes: updated.checks.flatMap(check => {
				const original = saved.checks.find(item => item.id === check.id)!;
				assert(original, "unexpected_new_check");
				return original.status === check.status ? [] : [{ id: check.id, before: original.status, after: check.status, reason: check.reason }];
			}) };
		});
		return { source: `${directory}/${file}`, sourceSha256: sha256(bytes), attempt: attempt.id, executionStatus: result.status, originalError: result.error ?? null, checkpoints };
	});
	assert.equal(new Set(observations.map(item => item.attempt)).size, observations.length, "duplicate_saved_attempt");
	return { protocol: automaticProtocolV2, suiteSha256: suite.manifestSha256, attempts: observations.length, checkpoints: observations.reduce((sum, item) => sum + item.checkpoints.length, 0), observations };
}

async function main() {
	const { values } = parseArgs({ options: { report: { type: "string" } } });
	const replay = await replayStaleAnswer();
	const comparisons = [
		{ key: "quantity", actual: { value: "5201", unit: "pcs" }, expected: { value: 5101, unit: "pcs" } },
		{ key: "quantity", actual: { value: "5201", unit: "个" }, expected: { value: 5201, unit: "pcs" } },
		{ key: "target_delivery", actual: { value: "2026-10-15 到货" }, expected: { value: "2026-10-15" } },
	].map(item => ({ ...item, comparison: compareRequirementField(item.key, item.actual, item.expected) }));
	assert.deepEqual(comparisons.map(item => item.comparison.status), ["different", "equivalent", "needs_review"]);
	const rescoring = rescoreSavedFields();
	const files = ["eval/reliabilityRepairs.ts", "server/runtime/agentRuntime.ts", "server/runtime/fileAgentStateStore.ts", "src/runtime/contracts.ts", "src/manufacturing/requirementField.ts", "eval/requirementAutomaticV2.ts", "eval/requirementAutomatic.ts", "eval/requirementIntake.ts"];
	const report = { protocol: "requirement-reliability-repairs.v1", mode: "offline-historical-output-gate-replay", modelCalls: 0, semanticQuality: "NOT_EVALUATED", fieldProtocol: requirementFieldProtocol,
		sourceHashes: Object.fromEntries(files.map(path => [path, sha256(readFileSync(path))])), replay, comparisons, rescoring };
	if (values.report) writeFileSync(values.report, JSON.stringify(report, null, "\t") + "\n", { flag: "wx" });
	console.log(JSON.stringify({ mode: report.mode, modelCalls: 0, report: values.report ?? null, outcomes: replay.outcomes, fieldStatuses: comparisons.map(item => item.comparison.status), rescoredAttempts: rescoring.attempts, rescoredCheckpoints: rescoring.checkpoints }));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
