import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentHooks } from "../src/agent/hooks";
import { AgentLoop } from "../src/agent/loop";
import { FileAgentStateStore } from "../server/runtime/fileAgentStateStore";
import { contextReadTool } from "../server/runtime/contextRead";
import { RuntimeLoopGuard } from "../server/runtime/loopGuard";
import { checkPrior, loadLongFixture, measureLongReadback, originalVisibility } from "./contextLongReadback";

const fixture = loadLongFixture(), directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function state() { const path = mkdtempSync(join(tmpdir(), "long-readback-test-")); directories.push(path); return new FileAgentStateStore(path); }
const result = (): Parameters<typeof measureLongReadback>[0] => ({ phase: "test", caseId: "test", version: "candidate", sample: 1, status: "completed", passed: true, toolCompletions: [], toolResults: {}, modelInputs: [], initialVisibility: { host: false, report: false, requirements: false } });

it("distinguishes complete original bodies from the actual externalized long checkpoint and query excerpts", () => {
	expect(fixture.cases.map((item) => originalVisibility(item.session.messages, fixture))).toEqual([
		{ host: false, report: false, requirements: false }, { host: false, report: true, requirements: true }, { host: false, report: false, requirements: true },
	]);
	const excerpt = { role: "tool" as const, sourceTool: { name: "context_read", input: { sourceRef: fixture.labRead.sourceRef, query: "report-C17" } }, content: JSON.stringify({ items: [{ text: fixture.labText }] }) };
	expect(originalVisibility([excerpt], fixture).report).toBe(false);
	const raw = { ...excerpt, sourceTool: { name: "context_read", input: fixture.labRead } };
	expect(originalVisibility([raw], fixture).report).toBe(true);
});

it("rejects unresolved or inconsistent spending ledgers and requires enough room for the whole long protocol", () => {
	const prior = JSON.parse(readFileSync(new URL("../docs/evidence/context-search-convergence-online.json", import.meta.url), "utf8"));
	expect(checkPrior(prior, 17, 12)).toMatchObject({ fits: true, requiredUsd: 16.363712 });
	expect(checkPrior(prior, prior.limits.usd, 12).fits).toBe(false);
	for (const change of [{ unresolved: true }, { status: "running" }, { calls: [{ status: "unknown" }] }, { countRequests: [{ status: "started" }] }, { reservedUsd: 18 }, { reservedUsd: NaN }, { requestedModel: "another-model" }]) expect(() => checkPrior({ ...prior, ...change }, 17, 12)).toThrow("invalid_or_unresolved_prior_ledger");
	expect(() => checkPrior(prior, 2, 12)).toThrow("invalid_protocol_budget");
	expect(() => checkPrior(prior, 18, 12)).toThrow("invalid_protocol_budget");
});

it("recognizes full originals recovered through both normal externalized-body read envelopes", async () => {
	const item = fixture.cases.find((candidate) => candidate.id === "body-externalized")!, store = state();
	for (const snapshot of item.snapshots) store.put(snapshot);
	const previous = item.session.messages.find((message) => message.sourceTool?.name === "context_read" && (message.sourceTool.input as { messageIndex?: number }).messageIndex === fixture.labRead.messageIndex && message.content.includes('"status":"body_externalized"'))!;
	const sourceRef = JSON.parse(previous.content).sourceRef as string;
	const tool = contextReadTool(fixture.scope, store, store, () => {});
	for (const input of [{ sourceRef }, { sourceRef, messageIndex: 0 }]) {
		const output = await tool.execute(input, { ...fixture.scope, actorId: "eval", stageId: "test", executionId: "e", toolCallId: "restored", idempotencyKey: "read", signal: new AbortController().signal }) as { items: Array<{ text?: string; content?: string }> };
		expect(JSON.parse(output.items[0].text ?? output.items[0].content!).items[0].text).toBe(fixture.labText);
		const message = { role: "tool" as const, content: JSON.stringify(output), sourceTool: { name: "context_read", input } };
		expect(originalVisibility([message], fixture).report).toBe(true);
		const measured = result(); measured.caseId = item.id;
		measured.modelInputs = [{ iteration: 1, host: true, requirements: true, report: false }];
		measured.toolCompletions = [{ iteration: 1, failed: false, call: { id: "restored", name: "context_read", input } }];
		measured.toolResults.restored = message;
		expect(measureLongReadback(measured, fixture, store, []).fullReportRecoveryReads).toEqual(["restored"]);
	}
});

it("measures same-batch coverage intersections while distinguishing pagination and incomplete searches", () => {
	const store = state(), measured = result();
	for (const ref of ["parent", "child"]) store.put({ ...fixture.scope, schemaVersion: "context-snapshot.v2", snapshotId: ref, purpose: "archive", iteration: 1, skills: [], estimatedChars: 0, estimatedTokens: 0, removedMessages: 0, createdAt: "2026-09-24T00:00:00Z", messages: [{ role: "user", content: "report-C17", ...(ref === "parent" ? { readDependencies: ["child"] } : {}) }] });
	for (const [id, sourceRef, offset] of [["a", "parent", 0], ["b", "child", 0], ["c", "parent", 2]] as const) {
		measured.toolCompletions.push({ iteration: 1, failed: false, call: { id, name: "context_read", input: { sourceRef, query: "report-C17", offset } } });
		measured.toolResults[id] = { role: "tool", content: JSON.stringify({ searchComplete: true, items: [] }) };
	}
	const metrics = measureLongReadback(measured, fixture, store, []);
	expect(metrics.sameBatchQueryOverlaps).toEqual([
		{ iteration: 1, callIds: ["a", "b"], sharedSourceRefs: ["child"], differentPages: false },
		{ iteration: 1, callIds: ["a", "c"], sharedSourceRefs: ["parent", "child"], differentPages: true },
		{ iteration: 1, callIds: ["b", "c"], sharedSourceRefs: ["child"], differentPages: false },
	]);
	measured.toolResults.b.content = JSON.stringify({ searchComplete: false, items: [] });
	expect(measureLongReadback(measured, fixture, store, []).sameBatchQueryOverlaps).toHaveLength(1);
});

it("counts reading an already-visible report separately from restoring a body removed from later input", () => {
	const measured = result();
	measured.modelInputs = [{ iteration: 1, host: true, requirements: true, report: true }, { iteration: 2, host: true, requirements: true, report: false }];
	for (const [id, iteration] of [["redundant", 1], ["recovery", 2]] as const) {
		measured.toolCompletions.push({ iteration, failed: false, call: { id, name: "context_read", input: fixture.labRead } });
		measured.toolResults[id] = { role: "tool", content: JSON.stringify({ items: [{ text: fixture.labText }] }) };
	}
	expect(measureLongReadback(measured, fixture, state(), [])).toMatchObject({ toolsChosenWithAllOriginalsVisible: 1, fullReportReadsWhileAlreadyVisible: ["redundant"], fullReportRecoveryReads: ["recovery"] });
	measured.caseId = "body-externalized"; measured.modelInputs = [measured.modelInputs[1]];
	expect(measureLongReadback(measured, fixture, state(), []).fullReportRecoveryReads).toContain("recovery");
});

it("marks body-dependent metrics unknown when the guard stops a batch after a successful read but before checkpointing", async () => {
	const store = state(), measured = result(), hooks = new AgentHooks(), signal = new AbortController().signal;
	for (const snapshot of fixture.cases[0].snapshots) store.put(snapshot);
	hooks.on("tool.after", (event) => { measured.toolCompletions.push({ iteration: event.iteration, call: event.call, failed: event.failed }); });
	hooks.on("loop.checkpoint", (event) => { for (const message of event.messages) if (message.role === "tool" && message.toolCallId) measured.toolResults[message.toolCallId] = message; });
	new RuntimeLoopGuard().attach(hooks, signal);
	const loop = new AgentLoop({ hooks, tools: [contextReadTool(fixture.scope, store, store, () => {})], maxIterations: 1, provider: {
		countTokens: async () => 100,
		generate: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 }, toolCalls: [
			{ id: "read", name: "context_read", input: fixture.labRead },
			...[1, 2, 3].map((n) => ({ id: `bad-${n}`, name: `missing-${n}`, input: {} })),
		] }),
	} });
	await expect(loop.run({ ...fixture.scope, actorId: "eval", stageId: "test", executionId: "test", idempotencyKey: "test", instructions: [], skills: [], history: [], input: "read", allowedTools: ["context_read"], policy: { sandboxMode: "read-only", approvalPolicy: "never" }, fallbackOutput: "unused" }, signal)).rejects.toMatchObject({ code: "consecutive_tool_failures" });
	expect(measured.toolCompletions.map((entry) => entry.failed)).toEqual([false, true, true, true]);
	expect(measured.toolResults).toEqual({});
	expect(measureLongReadback(measured, fixture, store, [])).toMatchObject({ toolsExecuted: 4, failedTools: 3, measurementComplete: false, missingResultBodies: ["read"], sameBatchQueryOverlaps: null, fullReportReadsWhileAlreadyVisible: null, fullReportRecoveryReads: null });
});
