import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { SkillRegistry } from "../../src/agent/skills";
import { BlackxAgentRuntime } from "./agentRuntime";
import { FileAgentStateStore } from "./fileAgentStateStore";
import { FileStageJobQueue } from "../enterprise/fileStageJobQueue";
import { FileCronScheduleStore } from "../enterprise/fileCronScheduleStore";
import { recoverAutomationMutation } from "./mutationRecovery";
import type { AgentToolExecutionRecord } from "../../src/agent/contracts";
import type { RuntimeTurnRequest } from "../../src/runtime/contracts";
import { PersonalMemoryStore } from "../enterprise/personalMemoryStore";
import { PersonalMemoryService } from "../enterprise/personalMemoryService";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(resolve(path)).href);
const request: RuntimeTurnRequest = { tenantId: "process-tenant", workspaceId: "process-workspace", runId: "process-run", sessionId: "process-session", actorId: "process-user", stageId: "conversation", idempotencyKey: "process-turn", input: "Finish once", fallbackOutput: "unused", policy: { sandboxMode: "read-only", approvalPolicy: "never", timeoutMs: 10_000 } };

it.skipIf(process.platform === "win32").each(["intent", "session", "trace"])("repairs completion after SIGKILL immediately after %s commit", async boundary => {
	const root = mkdtempSync(join(tmpdir(), "packx-killed-completion-")); roots.push(root);
	const source = `
import { appendFileSync } from 'node:fs';
import { FileAgentStateStore } from ${moduleUrl("server/runtime/fileAgentStateStore.ts")};
import { BlackxAgentRuntime } from ${moduleUrl("server/runtime/agentRuntime.ts")};
import { SkillRegistry } from ${moduleUrl("src/agent/skills.ts")};
const state = new FileAgentStateStore(${JSON.stringify(root)}), boundary = ${JSON.stringify(boundary)};
const kill = () => process.kill(process.pid, 'SIGKILL');
if (boundary === 'intent') { const put = state.put.bind(state); state.put = value => { const result = put(value); if (value.skills.some(s => s.name === 'host-turn-completion')) kill(); return result; }; }
if (boundary === 'session') { const save = state.save.bind(state); state.save = (...args) => { const result = save(...args); if (args[4] === null) kill(); return result; }; }
if (boundary === 'trace') { const put = state.putTrace.bind(state); state.putTrace = value => { const result = put(value); if (value.status === 'completed') kill(); return result; }; }
const runtime = new BlackxAgentRuntime({ sessions: state, snapshots: state, executions: state, traces: state, skills: new SkillRegistry(), provider: { generate: async () => { appendFileSync(${JSON.stringify(join(root, "calls"))}, 'call'); return { text: 'Durable answer', toolCalls: [], usage: { inputTokens: 5, outputTokens: 3, cachedInputTokens: 0, reasoningOutputTokens: 0 } }; } } });
await runtime.executeTurn(${JSON.stringify(request)});`;
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], { encoding: "utf8", timeout: 15_000 });
	expect(child.signal, child.stderr).toBe("SIGKILL");
	const state = new FileAgentStateStore(root), generate = vi.fn(async () => { throw new Error("must_not_generate"); });
	const runtime = new BlackxAgentRuntime({ sessions: state, snapshots: state, executions: state, traces: state, skills: new SkillRegistry(), provider: { generate } });
	await expect(runtime.executeTurn(request)).resolves.toMatchObject({ status: "completed", finalResponse: "Durable answer", usage: { inputTokens: 5, outputTokens: 3 } });
	expect(generate).not.toHaveBeenCalled(); expect(readFileSync(join(root, "calls"), "utf8")).toBe("call");
	expect(state.listTraces(request)).toHaveLength(1);
	expect(state.load({ ...request, sessionId: request.sessionId! }).transcript?.filter(item => item.role === "assistant")).toHaveLength(1);
});

it.skipIf(process.platform === "win32").each(["background_task_create", "cron_create", "memory_propose"])("reconciles %s after a killed process commits business state but leaves the ledger started", async tool => {
	const root = mkdtempSync(join(tmpdir(), "packx-killed-mutation-")); roots.push(root);
	const source = `
import { FileAgentStateStore } from ${moduleUrl("server/runtime/fileAgentStateStore.ts")};
import { FileStageJobQueue } from ${moduleUrl("server/enterprise/fileStageJobQueue.ts")};
import { FileCronScheduleStore } from ${moduleUrl("server/enterprise/fileCronScheduleStore.ts")};
import { createAutomationTools } from ${moduleUrl("server/runtime/automationTools.ts")};
import { mutationBinding } from ${moduleUrl("server/runtime/mutationRecovery.ts")};
import { PersonalMemoryStore } from ${moduleUrl("server/enterprise/personalMemoryStore.ts")};
import { PersonalMemoryService } from ${moduleUrl("server/enterprise/personalMemoryService.ts")};
const root = ${JSON.stringify(root)}, state = new FileAgentStateStore(root + '/agent'), queue = new FileStageJobQueue(root + '/queue.json'), schedules = new FileCronScheduleStore(root + '/cron.json');
const context = { ...${JSON.stringify(request)}, executionId: 'process-execution', toolCallId: 'call', approvalId: 'policy:process:v1', signal: new AbortController().signal };
const name = ${JSON.stringify(tool)}, input = name === 'memory_propose' ? { sourceMessageId: 'remember', topic: 'Reports', content: 'Use concise Chinese.' } : name === 'background_task_create' ? { objective: 'Review' } : { name: 'Review', expression: '*/5 * * * *', timezone: 'UTC', prompt: 'Review', maxRuns: 2 };
await state.claim({ ...mutationBinding(name, input, context), schemaVersion: 'tool-execution.v1', risk: 'write', status: 'started', startedAt: new Date().toISOString() });
if (name === 'memory_propose') {
	state.save({ ...context, sessionId: context.runId }, 0, [{ role: 'user', kind: 'dialogue', messageId: 'remember', content: '请长期记住：报告使用简洁中文' }], new Date().toISOString());
	await new PersonalMemoryService(new PersonalMemoryStore(root + '/memory.sqlite', () => true), state).tool().execute(input, context);
} else await createAutomationTools(queue, schedules).find(tool => tool.name === name).execute(input, context);
process.kill(process.pid, 'SIGKILL');`;
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], { encoding: "utf8", timeout: 15_000 });
	expect(child.signal, child.stderr).toBe("SIGKILL");
	const state = new FileAgentStateStore(join(root, "agent")), [record] = await state.list(request);
	expect(record.status).toBe("started");
	const queue = new FileStageJobQueue(join(root, "queue.json")), schedules = new FileCronScheduleStore(join(root, "cron.json"));
	if (tool === "memory_propose") {
		const store = new PersonalMemoryStore(join(root, "memory.sqlite"), () => true);
		try {
			const receipt = new PersonalMemoryService(store, state).reconcile(record, new AbortController().signal);
			expect(JSON.parse(receipt!.result)).toMatchObject({ active: false, status: "awaiting_user_confirmation" });
			expect(store.view(request).items).toHaveLength(1); expect(store.recall(request).items).toEqual([]); expect(store.audit(request)).toHaveLength(1);
		} finally { store.close(); }
		return;
	}
	const recovered = recoverAutomationMutation(queue, schedules, record as AgentToolExecutionRecord, new AbortController().signal);
	expect(JSON.parse(recovered!.result)).toMatchObject({ ok: true });
	expect(queue.list().length + schedules.list(request).length).toBe(1);
	// The dead process cannot retain the writer lock.
	if (tool === "background_task_create") queue.cancel(queue.list()[0].jobId, request);
	else schedules.setStatus(schedules.list(request)[0].scheduleId, request, "paused");
	expect(recoverAutomationMutation(queue, schedules, record, new AbortController().signal)).toEqual(recovered);
});
