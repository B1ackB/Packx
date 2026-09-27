import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { EvidenceReviewIssue } from "../src/enterprise/evidenceReview";
import { candidateReviewRequest, routingPassed } from "./evidenceReviewBoundary";
import { requirementEvidencePolicy } from "../server/manufacturing/requirementEvidencePolicy";
import { scoreReview, type ReviewCase } from "./evidenceReviewComparison";

it("measures action safety without correcting the model's path or granting revision authority", () => {
	const issue: EvidenceReviewIssue = { kind: "omission", location: "/facts", evidenceRefs: ["source"], reason: "missing narrative", suggestedAction: "revise" };
	expect(routingPassed([issue])).toBe(false); expect(issue.location).toBe("/facts");
	expect(routingPassed([{ ...issue, location: "/customerGoal" }])).toBe(true);
	expect(routingPassed([{ ...issue, suggestedAction: "request_input" }])).toBe(true);
	expect(routingPassed([{ ...issue, kind: "contradiction", location: "/customerGoal" }])).toBe(false);
	expect(routingPassed([{ ...issue, kind: "scope_change", suggestedAction: "reconfirm_plan" }])).toBe(true);
	expect(routingPassed([{ ...issue, kind: "scope_change", suggestedAction: "request_input" }])).toBe(false);
});

it("changes only domain instructions and policy identity, retaining the full evidence and Host boundary", () => {
	const suite = JSON.parse(readFileSync("eval/fixtures/evidence-review-concise/cases.json", "utf8")) as { cases: ReviewCase[] };
	for (const input of suite.cases) {
		const before = structuredClone(input.request), next = candidateReviewRequest(input.request);
		expect(input.request).toEqual(before);
		const originalBody = JSON.parse(before.messages[1]!.content), candidateBody = JSON.parse(next.messages[1]!.content);
		expect(candidateBody).toEqual({ ...originalBody, policyVersion: requirementEvidencePolicy.version });
		expect(next.messages[0]!.content.split("\n")[0]).toBe(before.messages[0]!.content.split("\n")[0]);
		expect(next.messages[0]!.content.endsWith(requirementEvidencePolicy.instructions.join("\n"))).toBe(true);
		expect({ ...next, messages: [] }).toEqual({ ...before, messages: [] });
	}
	const invalid = structuredClone(suite.cases[0]!.request); invalid.messages = [...invalid.messages, { role: "user", content: "unbound extra input" }];
	expect(() => candidateReviewRequest(invalid)).toThrow("unexpected_review_messages");
});

it("keeps prior cases unchanged and qualifies the four new controls before any model output", () => {
	const old = JSON.parse(readFileSync("eval/fixtures/evidence-review-boundary/cases.json", "utf8")) as { cases: ReviewCase[] };
	const suite = JSON.parse(readFileSync("eval/fixtures/evidence-review-concise/cases.json", "utf8")) as { cases: ReviewCase[] };
	expect(suite.cases).toHaveLength(16); expect(suite.cases.slice(0, 12)).toEqual(old.cases);
	const findings = [
		{ kind: "contradiction", location: "/facts/1", reason: "数量原文 12000，候选为 12500。" },
		{ kind: "unsupported", location: "/assumptions/3", reason: "产品类型确认不能证明食品接触认证。" },
		{ kind: "insufficient_evidence", location: "/facts", reason: "扫描资料没有原文正文。" },
	];
	for (const [index, input] of suite.cases.slice(12).entries()) {
		expect(scoreReview(input, '{"issues":[]}').controlPassed).toBe(index === 0);
		if (index === 0) continue;
		const body = JSON.parse(input.request.messages[1]!.content);
		const finding = { ...findings[index - 1], suggestedAction: "request_input", evidenceRefs: [body.evidence.find((e: { ref: string }) => e.ref.endsWith("-S01")).ref] };
		expect(scoreReview(input, JSON.stringify({ issues: [finding] })).controlPassed).toBe(true);
		expect(scoreReview(input, JSON.stringify({ issues: [{ ...finding, location: "/unrelated" }] })).controlPassed).toBe(false);
		expect(() => scoreReview(input, JSON.stringify({ issues: [{ ...finding, evidenceRefs: ["invented"] }] }))).toThrow();
		if (input.id === "missing-original") {
			expect(JSON.stringify(body.evidence)).not.toContain("12000");
			expect(JSON.stringify(body.evidence)).not.toContain("禁止使用 PVC");
		}
	}
});

it("excludes the quarantined input and keeps new positive/negative sources aligned", () => {
	const suite = JSON.parse(readFileSync("eval/fixtures/evidence-review-boundary/cases.json", "utf8")) as { cases: ReviewCase[] };
	expect(suite.cases).toHaveLength(12); expect(suite.cases.map(c => c.id)).not.toContain("received-limit-83");
	expect(suite.cases.filter(c => c.expected.kind !== "protocol_only")).toHaveLength(8);
	for (const input of suite.cases.filter(c => c.id.startsWith("logo-"))) {
		const body = JSON.parse(input.request.messages.at(-1)!.content);
		const source = body.evidence.find((e: { ref: string }) => e.ref === `RB-${input.id}-S01`);
		expect(source.content.content).toContain("Logo 不得镜像");
		const container = body.evidence.find((e: { content: { key?: string } }) => e.content.key === "customer_brief");
		expect(JSON.parse(container.content.value).messages[0].content).toContain("Logo 不得镜像");
		expect(JSON.stringify(body.candidate).includes("Logo 不得镜像")).toBe(input.id === "logo-clean");
		expect(scoreReview(input, '{"issues":[]}').controlPassed).toBe(input.id === "logo-clean");
	}
});
