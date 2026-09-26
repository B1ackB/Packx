import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlackxAgentRuntime } from "../runtime/agentRuntime";
import { SkillRegistry } from "../../src/agent/skills";
import { ProposalRunEngine } from "../../src/enterprise/proposalRunEngine";
import type { ArtifactContentStore } from "../../src/enterprise/artifactStore";
import { requirementBriefFixtures } from "../../src/manufacturing/requirementBrief.fixtures";
import { evaluateRequirementBrief, type RequirementBriefEvaluation, type RequirementBriefV1 } from "../../src/manufacturing/requirementBrief";
import type { EvidenceReviewIssue } from "../../src/enterprise/evidenceReview";
import { RuntimeFailure, type AgentRuntimePort, type RuntimeTurnRequest } from "../../src/runtime/contracts";
import { FileArtifactContentStore } from "../artifacts/fileArtifactStore";
import { RequirementBriefWorker } from "../manufacturing/requirementBriefWorker";
import { requirementEvidencePolicy } from "../manufacturing/requirementEvidencePolicy";
import { FileEnterpriseEventStore } from "./fileEventStore";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = requirementBriefFixtures[0]!;
const issue = (patch: Partial<EvidenceReviewIssue> = {}): EvidenceReviewIssue => ({
	kind: "omission", location: "/customerGoal", evidenceRefs: ["source:brief:v1"],
	reason: "遗漏客户要求：保留品牌原稿。", suggestedAction: "revise", ...patch,
});
const pass = { issues: [] };
const revised = { title: fixture.artifact.title, customerGoal: "保留品牌原稿，整理包装需求。", assumptions: [] };

function harness(outputs: Array<unknown | Error>, candidate: RequirementBriefV1 = structuredClone(fixture.artifact)) {
	const directory = mkdtempSync(join(tmpdir(), "packx-evidence-review-")); dirs.push(directory);
	const engine = new ProposalRunEngine(new FileEnterpriseEventStore(join(directory, "events.json")), "requirement-brief");
	const artifacts = new FileArtifactContentStore(join(directory, "artifacts"));
	const scope = { tenantId: "tenant", workspaceId: "workspace", runId: "review-run" };
	let count = 0;
	const envelope = () => ({ ...scope, actorId: "user", commandId: `seed-${count++}`, correlationId: "review", expectedVersion: engine.load(scope).aggregateVersion });
	engine.create(envelope()); engine.startProposal(envelope());
	for (const fact of [
		{ key: "industry", value: "print", status: "verified" as const, sourceType: "enterprise_source" as const, sourceRef: "domain:print" },
		{ key: "customer_brief", value: `${fixture.input} 保留品牌原稿。`, status: "unverified" as const, sourceType: "user_input" as const, sourceRef: "source:brief:v1" },
		...fixture.artifact.facts,
	]) engine.recordFactVersion({ ...envelope(), factKey: fact.key, factVersion: 1, value: fact.value, ...("unit" in fact ? { unit: fact.unit } : {}), status: fact.status, sourceType: fact.sourceType, sourceRef: fact.sourceRef });
	const requests: RuntimeTurnRequest[] = [];
	const runtime: AgentRuntimePort = {
		health: async () => ({ adapter: "fake", online: true }),
		async executeTurn(request) {
			requests.push(request);
			const output = request.stageId === "requirement-brief" ? candidate : outputs.shift();
			if (output instanceof Error) throw output;
			return { executionId: `execution-${requests.length}`, adapter: "fake", status: "completed", sessionId: `session-${requests.length}`, contextSnapshotId: `snapshot-${requests.length}`,
				finalResponse: typeof output === "string" ? output : JSON.stringify(output), events: [], usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 } };
		},
	};
	const command = { ...scope, commandId: "execute", correlationId: "review", expectedVersion: engine.load(scope).aggregateVersion };
	const run = (store: ArtifactContentStore = artifacts) => new RequirementBriefWorker(engine, runtime, store).execute(command);
	const read = (artifactId: string, artifactVersion = engine.load(scope).currentProposal!.version) => artifacts.readJson({ ...scope, artifactId, artifactVersion });
	const report = () => read("requirement-brief-evaluation") as RequirementBriefEvaluation;
	return { directory, scope, engine, artifacts, command, requests, run, read, report, runtime };
}

describe("requirement evidence review boundary", () => {
	it.each(["intake", "revision"])("blocks an unsupported narrative number introduced during %s", async (phase) => {
		const candidate = structuredClone(fixture.artifact);
		if (phase === "intake") candidate.customerGoal = "总数量为 6085 个。";
		const h = harness(phase === "revision" ? [{ issues: [issue()] }, { ...revised, customerGoal: "保留品牌原稿，总数量为 6085 个。" }, pass] : [pass], candidate);
		const before = h.engine.load(h.scope).facts;
		await h.run();
		expect(h.report()).toMatchObject({ passed: false, approvalEligible: false });
		expect(h.report().issues).toContainEqual(expect.objectContaining({ code: "unsupported_narrative_number" }));
		expect(h.engine.load(h.scope).facts).toEqual(before);
		expect(h.engine.load(h.scope).approval).toBeUndefined();
		expect(h.requests).toHaveLength(phase === "intake" ? 1 : 3);
	});

	it("runs rules before independent review and still requires version-bound human approval", async () => {
		const h = harness([pass]); await h.run();
		expect(h.engine.load(h.scope)).toMatchObject({ stageStatus: "waiting_approval", approval: { artifactVersion: 1, status: "requested" } });
		const request = h.requests[1]!;
		expect(request).toMatchObject({ stageId: "requirement-brief-review-call", allowedTools: [], skills: [], limits: { maxIterations: 1 }, policy: { sandboxMode: "read-only", approvalPolicy: "never" }, fallbackOutput: "{}" });
		expect(request.sessionId).toBeUndefined();
		expect(JSON.parse(request.input)).toMatchObject({ ruleValidation: { passed: true }, userRequirements: { version: 1 }, inputFactVersions: { customer_brief: 1 } });
		expect(h.report().evidenceReview).toMatchObject({ artifactVersion: 1, inputFactVersions: { customer_brief: 1 }, status: "completed" });
		await h.run(); expect(h.requests).toHaveLength(2);
	});

	it("repairs one narrative omission into v2, reviews again, and leaves all Facts identical", async () => {
		const h = harness([{ issues: [issue()] }, revised, pass]);
		const before = h.engine.load(h.scope).facts;
		await h.run();
		expect(h.engine.load(h.scope)).toMatchObject({ stageStatus: "waiting_approval", approval: { artifactVersion: 2 }, facts: before });
		expect(h.read("requirement-brief", 1)).toEqual(fixture.artifact);
		expect(h.read("requirement-brief", 2)).toMatchObject({ ...revised, facts: fixture.artifact.facts });
		expect(h.requests.map((r) => r.stageId)).toEqual(["requirement-brief", "requirement-brief-review-call", "requirement-brief-revision-call", "requirement-brief-review-call"]);
	});

	it("stops after the second review even when the model asks for another revision", async () => {
		const h = harness([{ issues: [issue()] }, revised, { issues: [issue()] }]); await h.run();
		expect(h.engine.load(h.scope)).toMatchObject({ stageStatus: "needs_input", currentProposal: { version: 2 }, evaluation: { passed: false } });
		expect(h.engine.load(h.scope).approval).toBeUndefined();
		expect(h.report().decision).toBe("request_input");
		await h.run(); expect(h.requests).toHaveLength(4);
	});

	it.each([
		issue({ kind: "contradiction", location: "/facts/quantity", suggestedAction: "revise" }),
		issue({ kind: "insufficient_evidence", evidenceRefs: [], suggestedAction: "request_input", reason: "缺少供应商原始测试报告，不能证实材料性能。" }),
		issue({ kind: "scope_change", suggestedAction: "reconfirm_plan" }),
		issue({ location: "/facts/quantity" }),
		// Online low/disabled review found a missing narrative constraint but targeted Facts.
		// Keep the detection, block automatic rewriting of authoritative state.
		issue({ location: "/facts", reason: "Original customer source forbids PVC, but the narrative omits that constraint." }),
	])("routes $kind / $location to the user without revising Facts or running tools", async (finding) => {
		const h = harness([{ issues: [finding] }]); const before = h.engine.load(h.scope).facts;
		await h.run();
		expect(h.engine.load(h.scope)).toMatchObject({ stageStatus: "needs_input", facts: before, evaluation: { passed: false } });
		expect(h.requests).toHaveLength(2);
		expect(h.report().decision).toBe(finding.kind === "scope_change" ? "reconfirm_plan" : "request_input");
	});

	it.each([
		"not json", "{}", { issues: [], approved: true }, { issues: [issue({ evidenceRefs: ["invented-source"] })] },
		new RuntimeFailure("timeout", "timeout", true), new RuntimeFailure("budget_exceeded", "budget", false), new Error("provider failed"),
	])("never accepts an invalid or failed review: %s", async (output) => {
		const h = harness([output]); await h.run();
		expect(h.report()).toMatchObject({ passed: false, evidenceReview: { status: "failed" } });
		expect(h.engine.load(h.scope).approval).toBeUndefined();
		await h.run(); expect(h.requests).toHaveLength(2);
	});

	it.each([{ ...revised, title: "无关新标题" }, { ...revised, facts: [{ key: "quantity", value: 1, status: "verified" }] }, { ...revised, tools: ["publish"] }, new RuntimeFailure("timeout", "timeout", true)])("rejects an out-of-scope or failed revision without modifying the old artifact", async (output) => {
		const h = harness([{ issues: [issue()] }, output]); await h.run();
		expect(h.engine.load(h.scope)).toMatchObject({ stageStatus: "needs_input", currentProposal: { version: 1 } });
		expect(h.read("requirement-brief", 1)).toEqual(fixture.artifact);
		expect(h.report().passed).toBe(false);
		expect(h.requests).toHaveLength(3);
	});

	it("a model pass cannot override failed deterministic validation", async () => {
		const h = harness([pass], { ...fixture.artifact, schemaVersion: "wrong" } as unknown as RequirementBriefV1);
		await h.run(); expect(h.report().passed).toBe(false); expect(h.engine.load(h.scope).approval).toBeUndefined();
		expect(h.requests).toHaveLength(1);
		expect(h.report().evidenceReview).toMatchObject({ status: "failed", failure: "deterministic_validation_failed" });
	});

	it.each(["requirement-brief-review-call", "requirement-brief-review", "requirement-brief-revision-call", "requirement-brief-evaluation", "requirement-brief"])("replays durable checkpoints after a crash following %s persistence", async (crashId) => {
		const h = harness([{ issues: [issue()] }, revised, pass]); let crashed = false;
		const store: ArtifactContentStore = {
			readJson: (key) => h.artifacts.readJson(key),
			putJson(key, value) {
				const result = h.artifacts.putJson(key, value);
				if (!crashed && key.artifactId === crashId && (crashId !== "requirement-brief" || key.artifactVersion === 2)) { crashed = true; throw new Error("simulated crash"); }
				return result;
			},
		};
		await expect(h.run(store)).rejects.toThrow("simulated crash");
		await h.run();
		expect(h.engine.load(h.scope)).toMatchObject({ stageStatus: "waiting_approval", approval: { artifactVersion: 2 } });
		expect(h.requests).toHaveLength(4);
		expect(h.engine.readEvents(h.scope).filter((e) => e.data.type === "artifact.version_created")).toHaveLength(2);
	});

	it("fails closed on an ambiguous in-flight call after restart without purchasing a repeated call", async () => {
		const h = harness([pass]); let crash = true;
		const store: ArtifactContentStore = { readJson: (key) => h.artifacts.readJson(key), putJson(key, value) {
			if (crash && key.artifactId === "requirement-brief-review-call") { crash = false; throw new Error("lost result"); }
			return h.artifacts.putJson(key, value);
		} };
		await expect(h.run(store)).rejects.toThrow("lost result"); await h.run();
		expect(h.report()).toMatchObject({ passed: false, evidenceReview: { failure: "interrupted_review" } });
		expect(h.requests).toHaveLength(2);
	});

	it("does not reuse or overwrite a review checkpoint after its policy version changes", async () => {
		const h = harness([pass]); const version = requirementEvidencePolicy.version;
		const store: ArtifactContentStore = { readJson: key => h.artifacts.readJson(key), putJson(key, value) {
			const ref = h.artifacts.putJson(key, value);
			if (key.artifactId === "requirement-brief-review-call") throw new Error("crash after old policy response");
			return ref;
		} };
		try {
			requirementEvidencePolicy.version = "historical-policy";
			await expect(h.run(store)).rejects.toThrow("crash after old policy response");
		} finally { requirementEvidencePolicy.version = version; }
		await expect(h.run()).rejects.toThrow();
		expect(h.requests).toHaveLength(2);
		expect(h.read("requirement-brief-review-input", 1)).toMatchObject({ policyVersion: "historical-policy" });
		expect(h.engine.load(h.scope).approval).toBeUndefined();
	});

	it("rejects a late response after cancellation and does not persist a passing report", async () => {
		const h = harness([pass]); const execute = h.runtime.executeTurn.bind(h.runtime);
		h.runtime.executeTurn = async (request) => {
			const result = await execute(request);
			if (request.stageId.includes("review")) h.engine.cancelStage({ ...h.command, actorId: "user", commandId: "cancel", expectedVersion: h.engine.load(h.scope).aggregateVersion });
			return result;
		};
		await expect(h.run()).rejects.toThrow("Review sources changed");
		expect(h.engine.load(h.scope).stageStatus).toBe("cancelled");
	});

	it.each(["paused", "client-fallback", "tool"])("blocks a %s runtime result", async (kind) => {
		const h = harness([pass]); const execute = h.runtime.executeTurn.bind(h.runtime);
		h.runtime.executeTurn = async (request) => {
			const result = await execute(request);
			if (request.stageId.includes("review")) {
				if (kind === "paused") result.status = "paused";
				if (kind === "client-fallback") result.adapter = "client-fallback";
				if (kind === "tool") result.events = [{ type: "tool.started", tool: "write", toolCallId: "bad", risk: "write", idempotencyKey: "bad" }];
			}
			return result;
		};
		await h.run(); expect(h.report().passed).toBe(false);
	});

	it.each(["execute:review-evaluation-v1", "execute:review-restart", "execute:review-runtime", "execute:review-artifact"])("recovers after event commit %s without repeating generation or review", async (commandId) => {
		const h = harness([{ issues: [issue()] }, revised, pass]);
		let crash = true;
		const guard = () => { if (crash && h.engine.hasCommand(h.scope, commandId)) { crash = false; throw new Error("lease lost"); } };
		await expect(new RequirementBriefWorker(h.engine, h.runtime, h.artifacts).execute(h.command, undefined, undefined, guard)).rejects.toThrow("lease lost");
		const restored = new ProposalRunEngine(new FileEnterpriseEventStore(join(h.directory, "events.json")), "requirement-brief");
		await new RequirementBriefWorker(restored, h.runtime, new FileArtifactContentStore(join(h.directory, "artifacts"))).execute(h.command);
		expect(restored.load(h.scope).approval?.artifactVersion).toBe(2); expect(h.requests).toHaveLength(4);
	});

	it("keeps review artifacts tenant-scoped and invalidates approval when a source Fact changes", async () => {
		const h = harness([pass]); await h.run();
		expect(() => h.artifacts.readJson({ ...h.scope, tenantId: "other", artifactId: "requirement-brief-review", artifactVersion: 1 })).toThrow("does not exist");
		h.engine.recordFactVersion({ ...h.command, actorId: "user", commandId: "changed-source", expectedVersion: h.engine.load(h.scope).aggregateVersion, factKey: "customer_brief", factVersion: 2, value: "新交期", status: "unverified", sourceType: "user_input", sourceRef: "source:brief:v2" });
		expect(h.engine.load(h.scope)).toMatchObject({ currentProposal: { freshness: "stale" }, approval: { status: "superseded" } });
		expect(h.read("requirement-brief-review", 1)).toMatchObject({ inputFactVersions: { customer_brief: 1 } });
	});

	it("enforces the empty tool allowlist through the real Core, even when the reviewer requests a write", async () => {
		const h = harness([]); let writes = 0;
		const realRuntime = new BlackxAgentRuntime({
			skills: new SkillRegistry([]),
			tools: [{ name: "write", description: "must never execute", execution: "host", risk: "write", inputSchema: { type: "object" }, idempotent: true, timeoutMs: 100, maxResultChars: 100, validate: () => true, execute: async () => { writes++; return {}; } }],
			provider: { generate: async () => ({ text: "", toolCalls: [{ id: "write", name: "write", input: {} }], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 } }) },
		});
		const execute = h.runtime.executeTurn.bind(h.runtime);
		h.runtime.executeTurn = (request, signal) => request.stageId === "requirement-brief" ? execute(request, signal) : realRuntime.executeTurn(request, signal);
		await h.run(); expect(writes).toBe(0); expect(h.report().passed).toBe(false);
	});

	it("fixed baseline comparison records both scripted detection and a known model miss honestly", async () => {
		const cases = [
			{ name: "omission", goal: fixture.artifact.customerGoal, response: { issues: [issue({ suggestedAction: "request_input" })] }, baselineAccepts: true, reviewerAccepts: false },
			{ name: "unsupported", goal: "包装已取得食品接触认证。", response: { issues: [issue({ kind: "unsupported", reason: "来源没有认证文件，无法支持此结论。", suggestedAction: "request_input" })] }, baselineAccepts: true, reviewerAccepts: false },
			{ name: "contradiction", goal: "本次订单为 500 个袋子。", response: { issues: [issue({ kind: "contradiction", reason: "叙述中的 500 个与确认的 10000 个矛盾。", suggestedAction: "request_input" })] }, baselineAccepts: true, reviewerAccepts: false },
			{ name: "clean", goal: revised.customerGoal, response: pass, baselineAccepts: true, reviewerAccepts: true },
			{ name: "model-misses-omission", goal: fixture.artifact.customerGoal, response: pass, baselineAccepts: true, reviewerAccepts: true },
		];
		for (const row of cases) {
			const candidate = { ...fixture.artifact, customerGoal: row.goal };
			const h = harness([row.response], candidate); await h.run();
			expect(evaluateRequirementBrief(candidate).approvalEligible, row.name).toBe(row.baselineAccepts);
			expect(h.report().approvalEligible, row.name).toBe(row.reviewerAccepts);
		}
	});
});
