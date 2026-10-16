import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export interface WindowsBuildReport {
	schemaVersion: "windows-build-job.v1";
	outcome: "succeeded" | "exit_failed" | "timed_out" | "launch_failed";
	rootProcessId: number;
	rootCreationTime: string | null;
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
	writeFileSync(request, JSON.stringify({ executable, arguments: args, cwd, timeoutMs }));
	let output = { stdout: "", stderr: "" }, failure: unknown, primary: unknown;
	try {
		try {
			output = await promisify(execFile)(join(environment.ProgramFiles ?? "C:\\Program Files", "PowerShell/7/pwsh.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", resolve("scripts/windowsBuildJob.ps1"), "-RequestFile", request, "-ResultFile", reportPath], { cwd, env: environment, timeout: timeoutMs + 30_000, maxBuffer: 2 * 1024 * 1024, signal, windowsHide: true });
		} catch (error) { failure = error; output = error as typeof output; }
		let report: WindowsBuildReport;
		try {
			report = JSON.parse(readFileSync(reportPath, "utf8"));
			if (report.schemaVersion !== "windows-build-job.v1" || !Number.isSafeInteger(report.rootProcessId) || !Number.isSafeInteger(report.activeProcesses) || !["succeeded", "exit_failed", "timed_out", "launch_failed"].includes(report.outcome)) throw new Error("Invalid build Job report");
		} catch (cause) { throw new Error(`Windows build supervisor unavailable: ${(failure as Error | undefined)?.message ?? "missing report"}`, { cause: failure ?? cause }); }
		if (failure || report.outcome !== "succeeded" || report.exitCode !== 0 || report.rootProcessId <= 0 || !report.rootCreationTime || !Number.isFinite(Date.parse(report.rootCreationTime)) || report.totalProcesses < 1 || !report.cleanupVerified || report.activeProcesses !== 0 || report.cleanupFailure) {
			throw Object.assign(new Error(`Windows build failed: ${JSON.stringify(report)}\n${output.stdout ?? ""}${output.stderr ?? ""}`, { cause: failure }), { report });
		}
		return { ...output, report };
	} catch (error) { primary = error; throw error; }
	finally {
		try { rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
		catch (cleanup) { throw new AggregateError([primary, cleanup].filter(Boolean), `Windows build supervisor scratch cleanup failed; original=${(primary as Error | undefined)?.message ?? "none"}`, { cause: primary ?? cleanup }); }
	}
}
