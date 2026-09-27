import { expect, it } from "vitest";
import type { AgentModelProvider } from "../src/agent/contracts";
import { configurations, runSequence, waveFixture } from "./contextContinuous";

it.each(configurations)("keeps one Session through six waves, actual compactions and original readbacks: $name", async (config) => {
	let summaryCalls = 0;
	const waves: Array<Record<string, unknown>> = [];
	const result = await runSequence((wave): AgentModelProvider => {
		let turnCalls = 0;
		return {
			async countTokens(request) { return Math.ceil(JSON.stringify(request).length / 3); },
			async generate(request) {
				const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
				if (request.callContext?.purpose === "summary") { summaryCalls++; return { text: "Unverified records remain available in original archives.", toolCalls: [], usage }; }
				const latestIndex = Number(request.messages.findLast((m) => m.role === "user" && m.content.includes("必须调用 context_read"))!.content.match(/以及 messageIndex=(\d+)/)![1]);
				if (++turnCalls === 1) return { text: "", toolCalls: [...new Set([0, latestIndex])].map((index) => ({ id: `read-${wave}-${index}`, name: "context_read", input: { sourceRef: "transcript", messageIndex: index } })), usage };
				const original = request.messages.filter((m) => m.role === "tool" && m.toolCallId?.startsWith(`read-${wave}-`));
				expect(original).toHaveLength(wave === 1 ? 1 : 2);
				expect(original.at(-1)!.content).toContain(waveFixture(1, wave).evidence.code);
				return { text: JSON.stringify({ confirmedQuantity: 5001 + 100 * wave, pendingQuantity: 6001 + 100 * wave, materialAllowed: false, supplierQualified: false, firstCode: waveFixture(1, 1).evidence.code, latestCode: waveFixture(1, wave).evidence.code, firstConditions: waveFixture(1, 1).evidence.conditions, latestConditions: waveFixture(1, wave).evidence.conditions }), toolCalls: [], usage };
			},
		};
	}, config, 1, (wave) => waves.push(wave));
	expect(result.passed, JSON.stringify(waves)).toBe(true);
	expect(result.continuousCompactionObserved).toBe(true);
	expect(summaryCalls).toBeGreaterThan(1);
	expect(waves).toHaveLength(6);
	for (let i = 1; i < waves.length; i++) expect(waves[i].sessionRevisionBefore).toBe(waves[i - 1].sessionRevisionAfter);
}, 30_000);

it("stops a failed sequence at its first ambiguous generation without starting another wave", async () => {
	const requestedWaves: number[] = [], recorded: Array<Record<string, unknown>> = [];
	await expect(runSequence((wave) => {
		requestedWaves.push(wave);
		return { async countTokens() { return 100; }, async generate() { throw new Error("disconnected"); } };
	}, configurations[1], 1, (wave) => recorded.push(wave))).rejects.toThrow();
	expect(requestedWaves).toEqual([1]);
	expect(recorded).toHaveLength(1);
	expect(recorded[0]).toMatchObject({ wave: 1, status: "failed", passed: false });
	expect(Array.isArray(recorded[0].events)).toBe(true);
});

it("records malformed completed model output as a sequence failure without generating the next wave", async () => {
	const recorded: Array<Record<string, unknown>> = [];
	let requestedWaves = 0;
	await expect(runSequence(() => {
		requestedWaves++;
		return { async countTokens() { return 100; }, async generate() { return { text: "{broken", toolCalls: [], usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } }; } };
	}, configurations[1], 1, (wave) => recorded.push(wave))).rejects.toThrow("invalid_response_json");
	expect(requestedWaves).toBe(1);
	expect(recorded[0]).toMatchObject({ status: "failed", error: "invalid_response_json", passed: false });
});
