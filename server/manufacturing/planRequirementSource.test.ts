import { describe, expect, it } from "vitest";
import type { PlanWorkspace } from "../../src/enterprise/agentPlan";
import type { ConversationView } from "../../src/runtime/conversationContracts";
import { planRequirementSource } from "./planRequirementSource";

const conversation = { conversationId: "conversation-a", revision: 0, messages: [] } as unknown as ConversationView;
function workspace(): PlanWorkspace {
	return { revision: 4, mode: "plan", versions: [{ version: 1, objective: "整理模拟咖啡袋需求", context: JSON.stringify({ messages: [], attachments: [] }), conversationRevision: 0, status: "completed", createdAt: "2026-09-13T00:00:00Z", actorId: "user", generation: 1, calls: 2, spec: { summary: "读取资料", tasks: [{ title: "任务", objective: "读取", tools: [] }] }, approval: { actorId: "user", version: 1, at: "2026-09-13T00:01:00Z" }, children: [{ taskIndex: 0, sessionId: "child-a", executionId: "execution-a", result: { summary: "数量可能为 5000", evidence: ["模拟资料"], limitations: ["数量待确认"] } }] }] };
}
describe("Plan requirement source", () => {
	it("retains version, execution lineage and uncertainty without requiring a chat message", () => {
		const result = planRequirementSource(workspace(), 1, conversation, []);
		expect(result.source).toMatchObject({ status: "unverified", sourceType: "model_output", sourceRef: "plan:conversation-a:version:1" });
		expect(JSON.parse(result.brief)).toMatchObject({ results: [{ sessionId: "child-a", executionId: "execution-a", result: { limitations: ["数量待确认"] } }] });
	});
	it("rejects incomplete, stale, unapproved and oversized sources", () => {
		for (const status of ["running", "cancelled", "superseded"] as const) {
			const state = workspace(); state.versions[0].status = status;
			expect(() => planRequirementSource(state, 1, conversation, [])).toThrow();
		}
		expect(() => planRequirementSource(workspace(), 2, conversation, [])).toThrow();
		expect(() => planRequirementSource(workspace(), 1, { ...conversation, revision: 1 }, [])).toThrow();
		expect(() => planRequirementSource(workspace(), 1, conversation, [{ name: "new.pdf" }])).toThrow();
		const state = workspace(); delete state.versions[0].approval;
		expect(() => planRequirementSource(state, 1, conversation, [])).toThrow();
		const large = workspace(); large.versions[0].context = JSON.stringify({ messages: ["x".repeat(32_000)], attachments: [] });
		expect(() => planRequirementSource(large, 1, conversation, [])).toThrow();
	});
});


it("imports a report-backed plan only with the exact current Host binding and keeps both report and facts unverified", () => {
	const state = workspace();
	const binding = { schemaVersion: "source-report-binding.v1" as const, selectionRevision: 2, status: "selected" as const, version: 1, reportDigest: "a".repeat(64), artifactRef: "artifact://source-report/v1", available: true };
	const report = { schemaVersion: "source-report.v1" as const, version: 1, title: "Source excerpts", status: "unverified" as const, createdAt: "2026-10-19T00:00:00Z", sources: [], limitations: ["Review required"] };
	state.versions[0].context = JSON.stringify({ attachments: [], sourceReport: binding });
	expect(() => planRequirementSource(state, 1, conversation, [])).toThrow();
	expect(() => planRequirementSource(state, 1, conversation, [], { binding: { ...binding, selectionRevision: 3 }, report })).toThrow();
	expect(() => planRequirementSource(state, 1, conversation, [], { binding: { ...binding, available: false }, report })).toThrow();
	const imported = planRequirementSource(state, 1, conversation, [], { binding, report });
	expect(imported.reportSource).toMatchObject({ key: "report_source", status: "unverified", sourceRef: binding.artifactRef, value: JSON.stringify(binding) });
	expect(JSON.parse(imported.brief)).toMatchObject({ status: "unverified", sourceReport: { status: "unverified" } });
});
