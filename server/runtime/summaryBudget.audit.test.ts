import { expect, it, vi } from "vitest";
import type { AgentMessage, AgentModelRequest } from "../../src/agent/contracts";
import { ContextEngine } from "../../src/agent/context";
import { SkillRegistry } from "../../src/agent/skills";
import { InMemoryAgentStateStore } from "../../src/agent/state";
import { defaultSummaryBudget, ModelContextSummarizer } from "../../src/agent/summarizer";
import { BlackxAgentRuntime } from "./agentRuntime";

// Same synthetic source material as contextContinuationVerify.ts. No real model,
// tokenizer, bill or semantic summary quality is evaluated by these Fakes.
const requirement: AgentMessage = { role: "user", kind: "dialogue", messageId: "requirements", content: "有效要求：不得使用 PVC；厚度 100 µm（不是 100 mm）。供应商仍未完成资质核验；下一步等待供应商资格证书。测试结果与原始条件以历史检测报告为依据。" };
const lab: AgentMessage[] = [
	{ role: "assistant", content: "", toolCalls: [{ id: "lab-original", name: "fixture_read", input: { document: "report-C17" } }] },
	{ role: "tool", toolCallId: "lab-original", content: JSON.stringify({ document: "report-C17", sample: 4, evidenceCode: "SEAL-9Q7", temperatureCelsius: 23, relativeHumidityPercent: 50, citation: "report-C17#sample=4", note: "These are recorded test conditions, not permission to change a current order.", irrelevantAppendix: "普通检测流程说明，不包含当前样品结论。".repeat(180) }) },
];
function noise(round: number, count: number): AgentMessage[] {
	return Array.from({ length: count }, (_, index): AgentMessage[] => [
		{ role: "assistant", content: "", toolCalls: [{ id: `noise-${round}-${index}`, name: "fixture_read", input: { index } }] },
		{ role: "tool", toolCallId: `noise-${round}-${index}`, content: JSON.stringify({ id: index, status: "historical_unverified", notes: "历史供应商讨论与包装设计备选，尚未确认，不得据此更新订单参数。 Candidate packaging discussion; unverified and irrelevant to current order. ".repeat(35) }) },
	]).flat();
}
const original = [requirement, ...noise(0, 35), ...lab, ...noise(1, 75)];
// The first actual compaction retained the early user requirement and archived
// these 146 messages. Keep this fixture self-contained instead of relying on /tmp.
const firstArchive = original.slice(1, 147).map((message) => ({ ...message, pinned: false }));
const now = "2026-09-22T13:00:00.000Z";
const budgets = [4, 8, 16, 32] as const;
const allocationPerCall = 6000 + 512;
const budget = (maxCalls: number) => ({ ...defaultSummaryBudget, maxCalls, maxTotalTokens: maxCalls * allocationPerCall });
const usage = { inputTokens: 6000, outputTokens: 16, cachedInputTokens: 0, reasoningOutputTokens: 0 };

function provider(text = "Unverified Fake note. It deliberately omits all substantive evidence.", count = 6000) {
	return {
		countTokens: vi.fn(async (_request: AgentModelRequest) => count),
		generate: vi.fn(async (_request: AgentModelRequest) => ({ text, toolCalls: [], usage })),
	};
}

it.each([
	{ name: "full original", messages: original, expectedCoverage: [18, 34, 66, 130] },
	{ name: "first actual archive", messages: firstArchive, expectedCoverage: [17, 33, 65, 129] },
])("measures direct prefix coverage and evidence delivery for 4/8/16/32 calls on $name", async ({ messages, expectedCoverage }) => {
	expect(original).toHaveLength(223);
	expect(firstArchive).toHaveLength(146);
	expect(firstArchive.some((message) => message.messageId === "requirements")).toBe(false);
	const coverage: number[] = [];
	for (const maxCalls of budgets) {
		const fake = provider();
		const result = await new ModelContextSummarizer(fake, budget(maxCalls)).summarize(messages, undefined, "fixed-original");
		expect(fake.generate).toHaveBeenCalledTimes(maxCalls);
		expect(fake.countTokens).toHaveBeenCalledTimes(maxCalls);
		const delivered: AgentMessage[] = [];
		for (const [request] of fake.generate.mock.calls) {
			expect(request).toMatchObject({ tools: [], reasoning: "disabled", maxOutputTokens: 512, callContext: { purpose: "summary", sourceRef: "fixed-original" } });
			const [start, end] = request.callContext!.sourceRange!;
			expect(start).toBe(delivered.length);
			const batch = JSON.parse(request.messages[1].content) as AgentMessage[];
			expect(batch).toEqual(messages.slice(start, end));
			delivered.push(...batch);
		}
		expect(delivered[0]).toEqual(messages[0]);
		expect(delivered.some((message) => message.toolCallId === "lab-original")).toBe(maxCalls === 32);
		expect(result.coverage).toEqual({ calls: maxCalls, complete: false, sourceMessages: messages.length, coveredMessages: delivered.length });
		expect(result.usage).toEqual({ ...usage, inputTokens: usage.inputTokens * maxCalls, outputTokens: usage.outputTokens * maxCalls });
		expect(result.text).toContain("INCOMPLETE");
		expect(result.text).not.toContain("SEAL-9Q7");
		coverage.push(delivered.length);
	}
	expect(coverage).toEqual(expectedCoverage);
	// More processed messages alone do not make this lossy Fake preserve any facts.
});

it.each(budgets)("reserves the full per-call output allowance and stops %s-call allocation one token below the last call", async (maxCalls) => {
	const fake = provider();
	const result = await new ModelContextSummarizer(fake, { ...budget(maxCalls), maxTotalTokens: maxCalls * allocationPerCall - 1 }).summarize(original, undefined, "allocation-boundary");
	expect(fake.generate).toHaveBeenCalledTimes(maxCalls - 1);
	expect(fake.countTokens).toHaveBeenCalledTimes(maxCalls);
	expect(result.coverage?.calls).toBe(maxCalls - 1);
	expect(result.usage.inputTokens).toBe(6000 * (maxCalls - 1));
	expect(result.usage.outputTokens).toBe(16 * (maxCalls - 1));
	// The reservation is 512 output tokens even though the Fake reports only 16 used.
	expect(result.coverage?.complete).toBe(false);
});

it("does not get eight calls by changing maxCalls alone while retaining the four-call total allocation", async () => {
	const fake = provider();
	const result = await new ModelContextSummarizer(fake, { ...defaultSummaryBudget, maxCalls: 8 }).summarize(original, undefined, "unchanged-total");
	expect(result.coverage?.calls).toBe(4);
	expect(fake.generate).toHaveBeenCalledTimes(4);
	expect(fake.countTokens).toHaveBeenCalledTimes(5);
});

it.each(budgets)("shares the %s-call allowance across separate summarize operations on one instance", async (maxCalls) => {
	const fake = provider();
	const summarizer = new ModelContextSummarizer(fake, budget(maxCalls));
	for (let index = 0; index < maxCalls; index++) {
		const result = await summarizer.summarize([{ role: "user", content: `Distinct unresolved point ${index}` }], undefined, `compact-${index}`);
		expect(result.coverage).toEqual({ complete: true, sourceMessages: 1, coveredMessages: 1, calls: 1 });
	}
	const exhausted = await summarizer.summarize([{ role: "user", content: "A later compression still needs coverage" }], undefined, "later-compact");
	expect(exhausted.coverage).toEqual({ complete: false, sourceMessages: 1, coveredMessages: 0, calls: 0 });
	expect(exhausted.text).toContain("later-compact");
	expect(fake.generate).toHaveBeenCalledTimes(maxCalls);
	expect(fake.countTokens).toHaveBeenCalledTimes(maxCalls);
});

it("keeps a failed generation's reservation consumed and never automatically repeats that call", async () => {
	const countTokens = vi.fn(async () => 6000);
	const generate = vi.fn(async () => { throw new Error("unknown_provider_outcome"); });
	const summarizer = new ModelContextSummarizer({ generate, countTokens }, { ...budget(4), maxTotalTokens: allocationPerCall });
	await expect(summarizer.summarize([requirement], undefined, "first-attempt")).rejects.toThrow("unknown_provider_outcome");
	const later = await summarizer.summarize([requirement], undefined, "later-attempt");
	expect(later.coverage).toMatchObject({ calls: 0, coveredMessages: 0, complete: false });
	expect(generate).toHaveBeenCalledTimes(1);
});

it.each(budgets)("bounds count-endpoint attempts separately when all candidate batches exceed measured input at %s calls", async (maxCalls) => {
	const fake = provider(undefined, 6001);
	const result = await new ModelContextSummarizer(fake, budget(maxCalls)).summarize(original, undefined, "count-overflow");
	expect(fake.generate).not.toHaveBeenCalled();
	expect(fake.countTokens.mock.calls.length).toBeGreaterThan(0);
	expect(fake.countTokens.mock.calls.length).toBeLessThanOrEqual(maxCalls * 4);
	expect(result.coverage).toMatchObject({ calls: 0, coveredMessages: 0, complete: false });
	expect(result.usage.inputTokens).toBe(0);
});

it.each(budgets)("cannot repair an oversized source or recover omitted ancestor evidence by raising calls to %s", async (maxCalls) => {
	const fake = provider(undefined, 1000);
	const oversized = { role: "tool" as const, content: `${"source evidence ".repeat(2000)}ANCESTOR-9Q7; 23 °C / 50% RH` };
	const skipped = await new ModelContextSummarizer(fake, budget(maxCalls)).summarize([oversized], undefined, "oversized-source");
	// The conservative byte precheck rejects the whole unit before consulting the Fake tokenizer.
	expect(fake.countTokens).not.toHaveBeenCalled();
	expect(fake.generate).not.toHaveBeenCalled();
	expect(skipped.coverage).toMatchObject({ complete: false, coveredMessages: 0 });
	expect(skipped.text).toContain("INCOMPLETE");
	const ancestor: AgentMessage = { role: "user", kind: "summary", content: skipped.text, readDependencies: ["oversized-source"] };
	const later = await new ModelContextSummarizer(fake, budget(maxCalls)).summarize([ancestor], undefined, "descendant-source");
	expect(later.coverage).toMatchObject({ complete: true, coveredMessages: 1, calls: 1 });
	expect(fake.generate).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(fake.generate.mock.calls[0][0].messages)).not.toContain("ANCESTOR-9Q7");
	expect(later.text).not.toContain("INCOMPLETE");
	expect(later.text).not.toContain("ANCESTOR-9Q7");
});

it("grows the concatenated summary when accepting more bounded outputs instead of imposing a single 512-token final summary", async () => {
	const text = "Unverified source note. ".repeat(40);
	const fake = provider(text);
	const result = await new ModelContextSummarizer(fake, budget(16)).summarize(original, undefined, "many-output-fragments");
	expect(result.coverage?.calls).toBe(16);
	expect(result.text.length).toBeGreaterThan(text.length * 16);
	expect(result.text.length).toBeGreaterThan(512 * 8);
	for (const [request] of fake.generate.mock.calls) expect(request.maxOutputTokens).toBe(512);
});

it("uses a custom Runtime summarizer's own provider and lifetime rather than rebuilding it for each turn", async () => {
	const scope = { tenantId: "audit", workspaceId: "summary", runId: "budget", sessionId: "budget" };
	const state = new InMemoryAgentStateStore();
	state.save(scope, 0, original, now);
	const summaryProvider = provider();
	const summarizer = new ModelContextSummarizer(summaryProvider, budget(8));
	const generate = vi.fn(async () => ({ text: "Done. No authoritative fact was changed.", toolCalls: [], usage }));
	const runtime = new BlackxAgentRuntime({ provider: { generate }, summarizer, context: new ContextEngine(100), skills: new SkillRegistry(), sessions: state, snapshots: state, executions: state, traces: state, now: () => now });
	const request = { ...scope, stageId: "audit", actorId: "auditor", input: "Continue with current facts.", fallbackOutput: "done", policy: { sandboxMode: "read-only" as const, approvalPolicy: "never" as const, timeoutMs: 5000 } };
	const first = await runtime.executeTurn({ ...request, idempotencyKey: "custom-first" });
	expect(summaryProvider.generate).toHaveBeenCalledTimes(8);
	expect(first.events.some((event) => event.type === "context.compacted" && event.removedMessages > 0)).toBe(true);
	// Injected providers do not automatically inherit Runtime summary telemetry/snapshots.
	expect(first.events.some((event) => event.type === "context.summary")).toBe(false);
	const second = await runtime.executeTurn({ ...request, idempotencyKey: "custom-second" });
	expect(second.events.some((event) => event.type === "context.compacted" && event.removedMessages > 0)).toBe(true);
	expect(summaryProvider.generate).toHaveBeenCalledTimes(8);
	expect(generate).toHaveBeenCalledTimes(2);
	expect(state.load(scope).messages.find((message) => message.kind === "summary")?.content).toContain("INCOMPLETE");
});
