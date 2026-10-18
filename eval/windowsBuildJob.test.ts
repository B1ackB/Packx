import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { cleanupBuildResources, runWindowsBuildJob, type WindowsBuildReport } from "../scripts/windowsBuildJob";

async function until(check: () => boolean, timeoutMs = 10_000) {
	const started = performance.now();
	while (!check()) { if (performance.now() - started > timeoutMs) throw new Error("fixture handshake/cleanup timeout"); await delay(20); }
}

// Platform behavior is tested on real Windows by its no-skip mandatory CI slice.
it.runIf(process.platform === "win32")("reaps owned descendants on success, failure, timeout and owner abort; preserves unrelated processes (3 rounds)", async () => {
	for (let round = 0; round < 3; round++) for (const mode of ["success", "failure", "timeout", "owner_abort"] as const) {
		const root = mkdtempSync(join(tmpdir(), "packx-build-test-")), owned = join(root, "owned"); mkdirSync(owned);
		const ready = join(root, "ready.json"), release = join(root, "release"), heartbeat = join(root, "sentinel");
		const child = join(root, "child.mjs"), parent = join(root, "parent.mjs");
		// A live descendant holds its Windows current-directory handle. Removal
		// must fail before termination, then succeed after Job cleanup.
		writeFileSync(child, 'import fs from "node:fs"; process.chdir(process.argv[2]); fs.writeFileSync(process.argv[3]+".pending", JSON.stringify({pid:process.pid, startedAt:Date.now()})); fs.renameSync(process.argv[3]+".pending",process.argv[3]); setInterval(()=>{},1000);');
		writeFileSync(parent, 'import {spawn} from "node:child_process"; import fs from "node:fs"; const [child,owned,ready,release,mode]=process.argv.slice(2); spawn(process.execPath,[child,owned,ready],{stdio:"ignore"}); process.stdout.write("compiler-output\\n"); process.stderr.write("compiler-diagnostic\\n"); const timer=setInterval(()=>{if(fs.existsSync(ready)&&fs.existsSync(release)&&["success","failure"].includes(mode)){clearInterval(timer);process.exit(mode==="success"?0:37)}},20);');
		const sentinel = spawn(process.execPath, ["-e", 'const fs=require("fs"); setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),20);', heartbeat], { stdio: "ignore" });
		const sentinelClosed = new Promise<void>((accept) => sentinel.once("close", () => accept()));
		const abort = new AbortController();
		let result: Awaited<ReturnType<typeof runWindowsBuildJob>> | undefined, error: unknown, primary: unknown, work: Promise<void> | undefined;
		try {
			await until(() => existsSync(heartbeat));
			const deadline = mode === "timeout" ? 5000 : 15_000;
			work = runWindowsBuildJob(process.execPath, [parent, child, owned, ready, release, mode], root, process.env, deadline, abort.signal).then((value) => { result = value; }, (cause) => { error = cause; });
			// Include the existing 30s supervisor startup allowance; a separate 10s timer hid slow-start failures.
			await until(() => { if (error) throw error; return existsSync(ready); }, deadline + 30_000);
			const identity = JSON.parse(readFileSync(ready, "utf8")); expect(identity.pid).toBeGreaterThan(0);
			expect(() => rmSync(owned, { recursive: true })).toThrow();
			if (mode === "owner_abort") abort.abort(); else writeFileSync(release, "release own fixture");
			await work;
			if (mode === "owner_abort") expect(error).toMatchObject({ cause: { code: "ABORT_ERR" } });
			else {
				const report = result?.report ?? (error as { report?: WindowsBuildReport })?.report;
				expect(report).toMatchObject({ outcome: mode === "success" ? "succeeded" : mode === "failure" ? "exit_failed" : "timed_out", exitCode: mode === "success" ? 0 : mode === "failure" ? 37 : null, createdInJob: true, activeProcesses: 0, cleanupVerified: true, cleanupFailure: null });
				expect(report!.totalProcesses).toBeGreaterThanOrEqual(2);
				expect(report!.rootProcessId).not.toBe(identity.pid);
				expect(Number.isFinite(Date.parse(report!.rootCreationTime!))).toBe(true);
				if (mode === "success") { expect(result!.stdout).toContain("compiler-output"); expect(result!.stderr).toContain("compiler-diagnostic"); }
				else expect((error as Error).message).toContain("compiler-diagnostic");
			}
			await until(() => { try { rmSync(owned, { recursive: true, force: true }); return true; } catch { return false; } }, 5000);
			expect(sentinel.exitCode).toBeNull();
			const old = readFileSync(heartbeat, "utf8"); await until(() => readFileSync(heartbeat, "utf8") !== old);
		} catch (cause) { primary = cause; console.error(JSON.stringify({ suite: "windows-build-lifecycle", round, mode, primary: (cause as Error).message })); throw cause; }
		finally { abort.abort(); await work; sentinel.kill(); await sentinelClosed; cleanupBuildResources(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }), primary); }
	}
}, 150_000);

it.runIf(process.platform === "win32")("waits for supervisor close when aborted during startup, releasing cwd immediately (3 rounds)", async () => {
	for (let round = 0; round < 3; ++round) {
		const root = mkdtempSync(join(tmpdir(), "packx-build-startup-abort-")), controller = new AbortController();
		try {
			const work = runWindowsBuildJob(process.execPath, ["-e", "setInterval(()=>{},1000)"], root, process.env, 5000, controller.signal);
			queueMicrotask(() => controller.abort());
			await expect(work).rejects.toMatchObject({ cause: { code: "ABORT_ERR" } });
			// No retry: the returned promise must mean the supervisor no longer owns its cwd.
			rmSync(root, { recursive: true }); expect(existsSync(root)).toBe(false);
		} finally { controller.abort(); cleanupBuildResources(() => rmSync(root, { recursive: true, force: true })); }
	}
}, 30000);

it.runIf(process.platform === "win32")("reports a launch failure with its native cause and verified empty Job", async () => {
	const root = mkdtempSync(join(tmpdir(), "packx-build-missing-"));
	try { await expect(runWindowsBuildJob(join(root, "missing.exe"), [], root, process.env)).rejects.toMatchObject({ report: { outcome: "launch_failed", win32Error: 2, rootProcessId: 0, cleanupVerified: true } }); }
	finally { rmSync(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32")("preserves explicit Unicode caller environment and strips provider credentials", async () => {
	const root = mkdtempSync(join(tmpdir(), "packx-build-environment-"));
	const marker = "Packx 測試 with spaces", path = "C:\\Windows\\System32;C:\\packx-fixture";
	try {
		const result = await runWindowsBuildJob(process.execPath, ["-e", 'process.stdout.write(JSON.stringify({LANG:process.env.LANG,PATH:process.env.PATH,credentialPresent:!!process.env.ANTHROPIC_API_KEY}));'], root, { ...process.env, LANG: marker, PATH: path, ANTHROPIC_API_KEY: "synthetic-must-not-inherit" });
		expect(JSON.parse(result.stdout)).toEqual({ LANG: marker, PATH: path, credentialPresent: false });
	} finally { rmSync(root, { recursive: true, force: true }); }
});
