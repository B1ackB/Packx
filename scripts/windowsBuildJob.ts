import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// AbortError may arrive before close. Never release cwd/scratch while the owned supervisor still runs.
export function execFileUntilClosed(file: string, args: string[], options: ExecFileOptionsWithStringEncoding) {
	return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
		let closed = false, completed = false, failure: Error | null = null, output = { stdout: "", stderr: "" };
		const finish = () => { if (closed && completed) { if (failure) reject(Object.assign(failure, output)); else accept(output); } };
		const child = execFile(file, args, options, (error, stdout, stderr) => { failure = error; output = { stdout, stderr }; completed = true; finish(); });
		child.once("close", () => { closed = true; finish(); });
	});
}

export function cleanupBuildResources(cleanup: () => void, primary?: unknown) {
	try { cleanup(); }
	catch (error) { throw new AggregateError([primary, error].filter(Boolean), `Windows build cleanup failed; original=${(primary as Error | undefined)?.message ?? "none"}`, { cause: primary ?? error }); }
}

export interface WindowsBuildReport {
	schemaVersion: "windows-build-job.v1";
	outcome: "succeeded" | "exit_failed" | "timed_out" | "launch_failed";
	rootProcessId: number;
	rootCreationTime: string | null;
	createdInJob: boolean;
	exitCode: number | null;
	win32Error: number | null;
	totalProcesses: number;
	activeProcesses: number;
	cleanupVerified: boolean;
	failure: string | null;
	cleanupFailure: string | null;
	elapsedMs: number;
}

/** Own trusted CI compiler processes only; never an Agent Tool or sandbox executor. */
export async function runWindowsBuildJob(executable: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs = 90_000, signal?: AbortSignal) {
	if (process.platform !== "win32") throw new Error("Windows build Job requires Windows");
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Invalid build deadline");
	const scratch = mkdtempSync(join(tmpdir(), "packx-build-job-")), request = join(scratch, "request.json"), reportPath = join(scratch, "result.json");
	// Restore only public OS prerequisites omitted by the outer CI scrubber.
	// Pass the exact environment to cmd; never inherit PowerShell's mutations.
	const system = ["SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"];
	const allowed = [...system, "PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "LANG", "LC_ALL", "CI"];
	const childEnvironment = Object.fromEntries(allowed.flatMap((key) => { const value = environment[key] ?? (system.includes(key) ? process.env[key] : undefined); return value === undefined ? [] : [[key, value]]; }));
	writeFileSync(request, JSON.stringify({ executable, arguments: args, cwd, timeoutMs, environment: childEnvironment }));
	let output = { stdout: "", stderr: "" }, failure: unknown, primary: unknown;
	try {
		try {
			output = await execFileUntilClosed(join(environment.ProgramFiles ?? "C:\\Program Files", "PowerShell/7/pwsh.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", resolve("scripts/windowsBuildJob.ps1"), "-RequestFile", request, "-ResultFile", reportPath], { encoding: "utf8", cwd, env: environment, timeout: timeoutMs + 30_000, maxBuffer: 2 * 1024 * 1024, signal, windowsHide: true });
		} catch (error) { failure = error; output = error as typeof output; }
		let report: WindowsBuildReport;
		try {
			report = JSON.parse(readFileSync(reportPath, "utf8"));
			if (report.schemaVersion !== "windows-build-job.v1" || !Number.isSafeInteger(report.rootProcessId) || !Number.isSafeInteger(report.activeProcesses) || !["succeeded", "exit_failed", "timed_out", "launch_failed"].includes(report.outcome)) throw new Error("Invalid build Job report");
		} catch (cause) { throw new Error(`Windows build supervisor unavailable: ${(failure as Error | undefined)?.message ?? "missing report"}`, { cause: failure ?? cause }); }
		if (failure || report.outcome !== "succeeded" || report.exitCode !== 0 || report.rootProcessId <= 0 || !report.rootCreationTime || !Number.isFinite(Date.parse(report.rootCreationTime)) || !report.createdInJob || report.totalProcesses < 1 || !report.cleanupVerified || report.activeProcesses !== 0 || report.cleanupFailure) {
			throw Object.assign(new Error(`Windows build failed: ${JSON.stringify(report)}\n${output.stdout ?? ""}${output.stderr ?? ""}`, { cause: failure }), { report });
		}
		return { ...output, report };
	} catch (error) { primary = error; throw error; }
	finally {
		cleanupBuildResources(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), primary);
	}
}
