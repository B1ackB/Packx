import { describe, expect, it } from "vitest";
import { runtimeContextSettings, validateAnthropicBaseUrl } from "./createRuntime";

describe("Anthropic Runtime configuration", () => {
	it("recognizes official DeepSeek Flash capacity without increasing the application input budget", () => {
		const environment = { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic/", ANTHROPIC_MODEL: "deepseek-v4-flash" };
		expect(runtimeContextSettings(environment)).toMatchObject({ contextWindowTokens: 1_000_000, maxInputTokens: 100_000, compactTriggerTokens: 70_000, compactTargetTokens: 45_000 });
		expect(runtimeContextSettings({ ...environment, ANTHROPIC_BASE_URL: "https://gateway.example/anthropic" }).contextWindowTokens).toBe(131_072);
		expect(runtimeContextSettings({ ...environment, ANTHROPIC_MODEL: "unverified-model" }).contextWindowTokens).toBe(131_072);
		expect(runtimeContextSettings({ ...environment, PACKX_MODEL_CONTEXT_TOKENS: "65536" }).contextWindowTokens).toBe(65536);
	});
	it("validates explicit compression thresholds against the effective model input limit", () => {
		expect(runtimeContextSettings({ PACKX_COMPACT_TRIGGER_TOKENS: "32000", PACKX_COMPACT_TARGET_TOKENS: "20000" })).toMatchObject({ compactTriggerTokens: 32000, compactTargetTokens: 20000 });
		for (const settings of [{ PACKX_COMPACT_TRIGGER_TOKENS: "0" }, { PACKX_COMPACT_TARGET_TOKENS: "70000" }, { PACKX_COMPACT_TRIGGER_TOKENS: "100001" }, { PACKX_MODEL_CONTEXT_TOKENS: "10000" }, { PACKX_COMPACT_TARGET_TOKENS: "NaN" }]) expect(() => runtimeContextSettings(settings)).toThrow();
	});
  it("accepts a plain HTTP URL and removes a trailing slash", () => {
    expect(validateAnthropicBaseUrl("https://api.deepseek.com/anthropic/")).toBe(
      "https://api.deepseek.com/anthropic",
    );
  });

  it("rejects copied Markdown link syntax at startup", () => {
    expect(() =>
      validateAnthropicBaseUrl(
        "[https://api.deepseek.com/anthropic](https://api.deepseek.com/anthropic)",
      ),
    ).toThrow("plain http(s) URL");
  });
});
