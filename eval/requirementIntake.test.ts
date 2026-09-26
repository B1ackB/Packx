import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentModelProvider, AgentModelRequest } from "../src/agent/contracts";
import { createRequirementBrief } from "../src/manufacturing/requirementBrief";
import { executeIntakeCase, factEvidence, loadIntakeSuite, newIntakeResult, regrade, scoreCapture, verdict, type Review } from "./requirementIntake";
import { boundedProvider, reservedUsd, reviewedOutputStop, reviewedPriorTrial, unresolved, type Ledger } from "./requirementIntakeRun";

import { AnthropicGenerationError } from "../server/runtime/anthropicModelProvider";
const suite = loadIntakeSuite();
const directories: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "intake-test-")); directories.push(path); return path; };
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 };
const request: AgentModelRequest = { messages: [{ role: "user", content: "synthetic input" }], tools: [], fallbackOutput: "" };

it("resolves the matching later candidate in the saved RI-10 failure without accepting a different value, unit or withdrawn source", () => {
	const baseline = JSON.parse(gunzipSync(readFileSync(new URL("../docs/evidence/requirement-intake-2026-09-25/baseline.report.json.gz", import.meta.url))).toString());
	const capture = baseline.results.find((r: { caseId: string }) => r.caseId === "RI-10").checkpoints[1].capture;
	const fact = capture.brief.facts.find((f: { key: string }) => f.key === "dimensions");
	expect(factEvidence(capture, fact)).toEqual(["RI-10-S04"]);
	expect(factEvidence(capture, { ...fact, value: "999 × 999 × 999 mm" })).toEqual([]);
	expect(factEvidence(capture, { ...fact, unit: "cm" })).toEqual([]);
	capture.activeSources = capture.activeSources.filter((s: { id: string }) => s.id !== "RI-10-S04");
	expect(factEvidence(capture, fact)).toEqual([]);
});

// Scripted answers ONLY exercise the runner. They never constitute online task evidence.
function scripted(wrongQuantity = false, equivalentDimension = false) {
	const input = structuredClone(suite.cases[0]), oracle = suite.oracles[0], requests: AgentModelRequest[] = [];
	input.sources.push({ ...input.sources[0], id: "future-source", content: "UNDISCLOSED_FUTURE_SOURCE" });
	const provider: AgentModelProvider = { async generate(request) {
		requests.push(JSON.parse(JSON.stringify(request)));
		if (request.outputSchema?.properties && typeof request.outputSchema.properties === "object" && "issues" in request.outputSchema.properties) return { text: JSON.stringify({ issues: [] }), toolCalls: [], usage };
		if (!request.messages.some((m) => m.role === "tool")) return { text: "", toolCalls: [{ id: `read-${requests.length}`, name: "project_source_read", input: { sourceId: "customer-brief" } }], usage };
		const facts = oracle.checkpoints[0].expectedFacts.map((fact) => ({ key: fact.key, value: wrongQuantity && fact.key === "quantity" ? 999 : fact.value, ...(fact.unit ? { unit: fact.unit } : {}), status: "unverified" as const, sourceType: "model_output" as const, sourceRef: input.sources[0].id, version: 1 }));
		if (equivalentDimension) { const dimension = facts.find((f) => f.key === "dimensions")!; dimension.value = "外径 90 × 高 135"; dimension.unit = "mm"; facts.find((f) => f.key === "quantity")!.unit = "个"; }
		return { text: JSON.stringify(createRequirementBrief({ industry: "print", title: "测试需求单", customerGoal: "整理本订单供员工核对，不承诺报价或生产可行性。", facts, assumptions: ["逐项确认后再批准交接。"] })), toolCalls: [], usage };
	} };
	return { input, oracle, requests, provider };
}

it("runs the real Worker/Runtime/store without seeding answers, keeps semantics pending, and checks immutable versions", async () => {
	const { input, oracle, requests, provider } = scripted(), result = newIntakeResult(input);
	await executeIntakeCase({ input, oracle, result, directory: temporary(), provider, save() {} });
	expect(result.error, JSON.stringify({ operations: result.operations, trace: result.traceEvents })).toBeUndefined(); expect(result.status).toBe("completed"); expect(result.checkpoints).toHaveLength(2);
	expect(result.checkpoints.flatMap((p) => p.checks.filter((c) => c.status === "failed")), JSON.stringify(result.checkpoints.map((p) => ({ evaluation: p.capture.evaluation, approval: p.capture.state.approval })))).toEqual([]);
	expect(verdict(result)).toBe("needs_review");
	const first = JSON.stringify(requests[0]);
	expect(first).not.toContain('"expectedFacts"'); expect(first).not.toContain(input.events[2].id);
	const initial = JSON.parse(requests[0].messages.find((m) => m.kind === "task_context")!.content);
	expect(initial.facts.map((f: { key: string }) => f.key).sort()).toEqual(["customer_brief", "industry"]);
	expect(JSON.stringify(requests)).not.toContain("UNDISCLOSED_FUTURE_SOURCE");
	expect(JSON.stringify(requests)).toContain(input.sources[0].content);
	const draft = result.checkpoints[0].capture, confirmed = result.checkpoints[1].capture;
	expect(draft.brief.facts.every((f) => f.status === "unverified")).toBe(true);
	expect(confirmed.brief.facts.every((f) => f.status === "verified")).toBe(true);
	expect(result.traceEvents.some((e) => e.type === "tool.completed" && e.status === "succeeded")).toBe(true);
	const reviews: Review[] = result.checkpoints.flatMap((p) => p.checks.filter((c) => c.status === "needs_review").map((c) => ({ caseId: input.id, checkpointId: p.capture.id, captureSha256: p.captureSha256, checkId: c.id, decision: "passed", reviewer: "offline-test", method: "codex_assisted", reason: "Scripted fixture sanity check only", evidence: "Scripted fixture output, not a real-model judgment" })));
	regrade(result, oracle, reviews); expect(verdict(result)).toBe("passed");
	expect(() => scoreCapture(draft, oracle.checkpoints[0], oracle, [], [{ ...reviews[0], checkId: "schema" }])).toThrow("review_cannot_override_deterministic_check");
	expect(() => scoreCapture(draft, oracle.checkpoints[0], oracle, [], [{ ...reviews[0], captureSha256: "wrong" }])).toThrow("review_capture_changed");
	const wrongBinding = structuredClone(draft); wrongBinding.sourceRefs["customer-brief"] = ["future-source"];
	expect(factEvidence(wrongBinding, wrongBinding.brief.facts[0])).toEqual([input.sources[0].id]);
});

it("blocks synthetic confirmation when the model candidate is wrong, without silently injecting gold", async () => {
	const { input, oracle, provider } = scripted(true), result = newIntakeResult(input);
	await executeIntakeCase({ input, oracle, result, directory: temporary(), provider, save() {} });
	expect(result.status).toBe("failed"); expect(result.error).toBe("confirmation_candidate_not_observed");
	expect(result.checkpoints).toHaveLength(1);
	expect(result.checkpoints[0].capture.brief.facts.find((f) => f.key === "quantity")).toMatchObject({ value: 999, status: "unverified" });
	expect(verdict(result)).toBe("failed");
});

it("requires explicit review for exact numeric text while retaining value, unit and source guards", async () => {
	const { input, oracle, provider } = scripted(), result = newIntakeResult(input);
	await executeIntakeCase({ input, oracle, result, directory: temporary(), provider, save() {} });
	const capture = structuredClone(result.checkpoints[0].capture);
	const quantity = capture.brief.facts.find((f) => f.key === "quantity")!;
	const valueStatus = (value: string) => {
		quantity.value = value;
		return scoreCapture(capture, oracle.checkpoints[0], oracle, []).checks.find((c) => c.id === "field:quantity:value")!.status;
	};
	expect(valueStatus("3600")).toBe("needs_review");
	expect(valueStatus("3.6")).toBe("failed");
	expect(valueStatus("3600 pcs")).toBe("failed");
	quantity.value = "3600"; quantity.unit = "箱"; quantity.sourceRef = "withdrawn-source";
	const checks = scoreCapture(capture, oracle.checkpoints[0], oracle, []).checks;
	expect(checks.find((c) => c.id === "field:quantity:unit")!.status).toBe("needs_review");
	expect(checks.find((c) => c.id === "field:quantity:source")!.status).toBe("failed");
});

it("pauses for equivalent wording/unit review and resumes without repeating a completed model turn", async () => {
	const { input, oracle, provider, requests } = scripted(false, true), result = newIntakeResult(input), directory = temporary();
	await executeIntakeCase({ input, oracle, result, directory, provider, save() {} });
	expect(result.status).toBe("needs_review"); expect(result.error).toBe("confirmation_value_requires_review");
	expect(result.checkpoints).toHaveLength(1);
	const before = requests.length, point = result.checkpoints[0];
	const reviews: Review[] = point.checks.filter((c) => c.id.startsWith("field:") && c.status === "needs_review").map((c) => ({ caseId: input.id, checkpointId: point.capture.id, captureSha256: point.captureSha256, checkId: c.id, decision: "passed", method: "codex_assisted", reviewer: "offline-test", reason: "Same individual count and dimensions; unit representation only", evidence: "3600 个 = 3600 pcs; 外径 90 × 高 135 mm" }));
	expect(reviews).toHaveLength(3);
	await executeIntakeCase({ input, oracle, result, directory, provider, reviews, save() {} });
	expect(result.status).toBe("completed"); expect(result.error).toBeUndefined();
	expect(result.checkpoints).toHaveLength(2); expect(requests.length - before).toBe(before);
	expect(result.checkpoints[1].capture.brief.facts.find((f) => f.key === "dimensions")).toMatchObject({ value: "外径 90 × 高 135 mm", status: "verified" });
});

it("persists intent before network use, preserves unknown reservation, and blocks all subsequent calls", async () => {
	const ledger: Ledger = { usdLimit: 0.1, calls: [] }; let requests = 0, saves = 0;
	const provider = boundedProvider({ async countTokens() { expect(ledger.calls.at(-1)?.status).toBe("started"); return 100; }, async generate() { requests++; expect(ledger.calls.at(-1)?.status).toBe("started"); throw new Error("connection_lost"); } }, ledger, "RI-01", () => "event", () => { saves++; });
	await expect(provider.generate(request)).rejects.toThrow("connection_lost");
	expect(unresolved(ledger)).toBe(true); expect(reservedUsd(ledger)).toBeCloseTo(0.0196908);
	await expect(provider.generate(request)).rejects.toThrow("unresolved_call_blocks_batch");
	expect(requests).toBe(1); expect(saves).toBe(4);
});

it("keeps transport failure classification redacted, reserved, and non-replayable", async () => {
	const ledger: Ledger = { usdLimit: 20, priorReservedUsd: 12.84109872, calls: [] }; let calls = 0;
	const error = new TypeError("private customer URL", { cause: Object.assign(new Error("private key"), { code: "UND_ERR_SOCKET" }) });
	const provider = boundedProvider({ countTokens: async () => 100, generate: async () => { calls++; throw error; } }, ledger, "new", () => "review", () => {});
	await expect(provider.generate(request)).rejects.toBe(error);
	expect(ledger.calls.at(-1)).toMatchObject({ status: "unknown", error: "transport_failure" });
	expect(ledger.calls.at(-1)?.response).toBeUndefined(); expect(ledger.calls.at(-1)?.failedResponse).toBeUndefined();
	expect(JSON.stringify(ledger)).not.toContain("private");
	expect(reservedUsd(ledger)).toBeGreaterThan(12.84109872);
	await expect(provider.generate(request)).rejects.toThrow("unresolved_call_blocks_batch"); expect(calls).toBe(1);
});

it("retains a reviewed output-limit reservation and rejects arbitrary unknown replays", () => {
	const previous = { protocol: "requirement-intake-online.v1", status: "stopped_unknown", model: "deepseek-v4-flash", usdLimit: 20, calls: [{ kind: "generate", status: "unknown", error: "output_limit", reservationUsd: 0.05, requestSha256: "unchanged", caseId: "RI-01" }] };
	const carried = reviewedOutputStop(JSON.stringify(previous));
	expect(carried.reservedUsd).toBe(0.05); expect(carried.unknown[0].status).toBe("unknown");
	expect(reservedUsd({ usdLimit: 20, priorReservedUsd: carried.reservedUsd, calls: [] })).toBe(0.05);
	previous.calls[0].error = "connection_lost";
	expect(() => reviewedOutputStop(JSON.stringify(previous))).toThrow("not_a_reviewed_output_stop");
});

it("does not approve until every checkpoint check passes, and approval resume makes no model calls", async () => {
	const { input, oracle, provider, requests } = scripted(), result = newIntakeResult(input), directory = temporary();
	input.events.push({ id: "approval-test", kind: "approve_artifact", actor: "authorized_operator", guard: "all_checkpoint_checks_passed", checkpointId: "confirmed", scope: "exact_current_artifact_version" });
	await executeIntakeCase({ input, oracle, result, directory, provider, save() {} });
	expect(result.status).toBe("needs_review"); expect(result.error).toBe("approval_requires_all_checks");
	expect(result.checkpoints.at(-1)?.capture.state.approval?.status).toBe("requested");
	const before = requests.length;
	const reviews: Review[] = result.checkpoints.flatMap((p) => p.checks.filter((c) => c.status === "needs_review").map((c) => ({ caseId: input.id, checkpointId: p.capture.id, captureSha256: p.captureSha256, checkId: c.id, decision: "passed", reviewer: "offline-test", method: "codex_assisted", reason: "Fixture gate check", evidence: "Scripted fixture only" })));
	await executeIntakeCase({ input, oracle, result, directory, provider, reviews, save() {} });
	expect(result.status).toBe("completed"); expect(requests).toHaveLength(before);
	expect(result.operations.at(-1)).toMatchObject({ eventId: "approval-test", status: "completed" });
});

it("refuses a generation before spending past the cap and retains count evidence", async () => {
	const ledger: Ledger = { usdLimit: 0.001, calls: [] }; let requests = 0;
	const provider = boundedProvider({ async countTokens() { return 100; }, async generate() { requests++; return { text: "ok", toolCalls: [], usage }; } }, ledger, "RI-01", () => "event", () => {});
	await expect(provider.generate(request)).rejects.toThrow("usd_limit");
	expect(requests).toBe(0); expect(reservedUsd(ledger)).toBe(0); expect(unresolved(ledger)).toBe(false);
	expect(ledger.calls).toHaveLength(1);
});


it("carries every old reservation and unknown call into a new trial without replaying them", () => {
	const prior = JSON.parse(gunzipSync(readFileSync("docs/evidence/requirement-intake-2026-09-25/baseline.report.json.gz")).toString());
	const carried = reviewedPriorTrial(JSON.stringify(prior));
	expect(carried.reservedUsd).toBeCloseTo(1.5151977);
	expect(carried.estimatedUsageUsd).toBeCloseTo(0.210202896);
	expect(carried.unknown).toHaveLength(4);
	prior.calls[0].status = "started";
	expect(() => reviewedPriorTrial(JSON.stringify(prior))).toThrow("invalid_prior_ledger");
});

it.each([false, true])("records received failure usage without releasing its reservation or retrying (overrun=%s)", async (overrun) => {
	const ledger: Ledger = { usdLimit: 20, priorReservedUsd: 12.34383912, calls: [] }; let attempts = 0;
	const error = new AnthropicGenerationError("output_limit", "Output limit", 422, { ...usage, outputTokens: overrun ? 100000 : 8192 }, { model: "model", stopReason: "max_tokens", inputTokens: 100, outputTokens: overrun ? 100000 : 8192, cacheReadTokens: null, cacheWriteTokens: null });
	const provider = boundedProvider({ countTokens: async () => 100, generate: async () => { attempts++; throw error; } }, ledger, "test", () => "test", () => {});
	await expect(provider.generate(request)).rejects.toThrow(overrun ? "usage_exceeds_reservation" : "Output limit");
	expect(ledger.calls.at(-1)).toMatchObject({ status: "unknown", error: overrun ? "usage_exceeds_reservation" : "output_limit", failedResponse: { usage: error.usage } });
	expect(ledger.calls.at(-1)?.response).toBeUndefined();
	expect(reservedUsd(ledger)).toBeCloseTo(12.34383912 + 0.0196908);
	await expect(provider.generate(request)).rejects.toThrow("unresolved_call_blocks_batch");
	expect(attempts).toBe(1);
});
