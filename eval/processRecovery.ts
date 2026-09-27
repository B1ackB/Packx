import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolExecutionRecord } from "../src/agent/contracts";
import { SkillRegistry } from "../src/agent/skills";
import { BlackxAgentRuntime } from "../server/runtime/agentRuntime";
import { ConversationFileService } from "../server/runtime/conversationFiles";
import { FileAgentStateStore } from "../server/runtime/fileAgentStateStore";
import { LocalFileAccess } from "../server/runtime/localFileAccess";

const scope = { tenantId: "process-fixture", workspaceId: "process-fixture", runId: "run", actorId: "operator" };
type Window = "effect-before-receipt" | "receipt-before-ledger";
const content = "Synthetic order: 4800 bags. No PVC. Supplier data still requires confirmation.";
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function stopAtBoundary(root: string) {
	writeFileSync(join(root, "boundary.json"), JSON.stringify({ physicalWrites: 1 }));
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // Only the parent SIGKILL can cross this boundary.
}

async function child(root: string, window: Window) {
	const files = new ConversationFileService(join(root, "files"), () => {});
	const ledger = new FileAgentStateStore(join(root, "ledger"));
	const input = { path: join(root, "draft.md"), expectedSha256: null, content };
	const request = { ...scope, stageId: "conversation", tool: "file_write", toolCallId: "write", executionId: "interrupted", idempotencyKey: "write-once", risk: "write" as const, input };
	const waiting = files.authorize(request);
	files.decide(scope, files.list(scope).approvals[0].id, "approved");
	const approvalId = (await waiting).approvalId!;
	const record: AgentToolExecutionRecord = { schemaVersion: "tool-execution.v1", ...scope, stageId: request.stageId, tool: request.tool, toolCallId: request.toolCallId, executionId: request.executionId, idempotencyKey: request.idempotencyKey, risk: "write", inputDigest: hash(JSON.stringify(input)), approvalId, status: "started", startedAt: new Date().toISOString() };
	await ledger.claim(record);
	writeFileSync(join(root, "record.json"), JSON.stringify(record));
	if (window === "effect-before-receipt") {
		const apply = LocalFileAccess.prototype.apply;
		LocalFileAccess.prototype.apply = function (...args) { const result = apply.apply(this, args); stopAtBoundary(root); return result; };
	}
	files.apply("write", input, { ...request, approvalId, signal: new AbortController().signal });
	stopAtBoundary(root);
}

async function run(window: Window, changedAfterCrash: boolean) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "packx-process-recovery-")));
	const worker = fork(fileURLToPath(import.meta.url), ["--child", root, window], { execArgv: ["--import", "tsx"], silent: true });
	let stderr = ""; worker.stderr?.on("data", (data) => { stderr = (stderr + data).slice(-2000); });
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => worker.once("exit", (code, signal) => resolve({ code, signal })));
	try {
		const deadline = Date.now() + 10_000;
		while (!existsSync(join(root, "boundary.json"))) {
			if (worker.exitCode !== null || worker.signalCode !== null || Date.now() > deadline) throw new Error(`Child did not reach ${window}: ${stderr}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert(worker.kill("SIGKILL"));
		assert.equal((await exited).signal, "SIGKILL");
		const record = JSON.parse(readFileSync(join(root, "record.json"), "utf8")) as AgentToolExecutionRecord;
		const ledger = new FileAgentStateStore(join(root, "ledger"));
		assert.equal((await ledger.find(record))?.status, "started");
		assert.equal(readFileSync(join(root, "draft.md"), "utf8"), content);
		if (changedAfterCrash) writeFileSync(join(root, "draft.md"), "External edit after crash");
		const before = readFileSync(join(root, "draft.md"), "utf8");
		const files = new ConversationFileService(join(root, "files"), () => {});
		let duplicateWrites = 0;
		const apply = LocalFileAccess.prototype.apply;
		LocalFileAccess.prototype.apply = function (...args) { duplicateWrites++; return apply.apply(this, args); };
		try {
			const runtime = new BlackxAgentRuntime({ skills: new SkillRegistry(), sessions: ledger, snapshots: ledger, executions: ledger, traces: ledger, tools: files.tools(), recoverToolExecution: (record, signal) => files.reconcile(record, signal), provider: {
				async generate(input) { return { text: input.messages.some((message) => message.kind === "receipt" && message.content.includes('"status":"succeeded"')) ? "reconciled" : "requires_attention", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } }; },
			} });
			const result = await runtime.executeTurn({ ...scope, stageId: "conversation", sessionId: "restarted", idempotencyKey: "recover", input: "Continue only from verified execution receipts", allowedTools: ["file_write"], fallbackOutput: "", policy: { sandboxMode: "workspace-write", approvalPolicy: "required", timeoutMs: 2000 } });
			const status = (await ledger.find(record))!.status;
			assert.equal(status === "succeeded", !changedAfterCrash);
			assert.equal(result.finalResponse, changedAfterCrash ? "requires_attention" : "reconciled");
			assert.equal(readFileSync(join(root, "draft.md"), "utf8"), before);
			assert.equal(duplicateWrites, 0);
			return { window, signal: "SIGKILL", changedAfterCrash, initialLedgerStatus: "started", recoveredLedgerStatus: status, originalWrites: 1, duplicateWrites, continuation: result.finalResponse };
		} finally { LocalFileAccess.prototype.apply = apply; }
	} finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); await exited; rmSync(root, { recursive: true, force: true }); }
}

if (process.argv.includes("--online")) throw new Error("This evaluation makes no online calls");
if (process.argv[2] === "--child") await child(process.argv[3], process.argv[4] as Window);
else {
	const report = { schemaVersion: "process-recovery-eval.v1", mode: "offline-real-process-termination", at: new Date().toISOString(), paidCalls: 0, semanticQuality: "NOT_EVALUATED", limitations: ["Local filesystem only", "Fake model", "SIGKILL is not a power-loss/fsync test", "Does not prove recovery of remote API side effects or model requests"], cases: [await run("effect-before-receipt", false), await run("receipt-before-ledger", false), await run("effect-before-receipt", true)] };
	if (process.argv.includes("--write")) writeFileSync("docs/evidence/process-recovery-2026-09-26.json", `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 2));
}
