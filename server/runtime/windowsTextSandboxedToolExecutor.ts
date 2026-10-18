import { spawn } from "node:child_process";
import { lstatSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { validToolExecutionManifest, type SandboxedToolExecutorPort, type ToolExecutionManifest, type ToolExecutionResult, type ToolSandboxStatus } from "../../src/agent/sandbox";
import { isAssetInspection } from "../../src/runtime/assetInspection";

/** One fixed native text operation; unsupported invocations never fall back to a shell or Host parser. */
export class WindowsTextSandboxedToolExecutor implements SandboxedToolExecutorPort {
	readonly executable: string;
	private readonly broker: string;
	constructor(private readonly workspaceRoot: string, binaryDirectory = resolve(".blackx-tools")) {
		this.executable = join(binaryDirectory, "text-inspector-worker.exe");
		this.broker = join(binaryDirectory, "text-inspector.exe");
	}
	async execute(manifest: ToolExecutionManifest, signal: AbortSignal): Promise<ToolExecutionResult> {
		const startedAt = new Date();
		const result = (status: ToolSandboxStatus, reason: string, text = "", exitCode: number | null = null): ToolExecutionResult => ({
			schemaVersion: "tool-execution-result.v1", attemptId: manifest.attemptId, status, exitCode, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt.getTime(),
			stdout: { text, truncated: false }, stderr: { text: "", truncated: false }, outputs: [],
			sandbox: { profile: manifest.sandboxProfile, platform: "win32", terminationReason: reason, permissions: { readOnlyPaths: manifest.paths.readOnly.length, writablePaths: 0, network: "deny-all", environmentKeys: ["LANG"] } },
		});
		if (signal.aborted) return result("cancelled", "cancelled_before_launch");
		if (process.platform !== "win32") return result("sandbox_unavailable", "windows_required");
		const directory = join(this.workspaceRoot, ".blackx-tool-inputs", manifest.attemptId), source = join(directory, "input.bin");
		const policyMatches = validToolExecutionManifest(manifest) && manifest.schemaVersion === "tool-execution-manifest.v1" && manifest.sandboxProfile === "blackx-local-tool-sandbox.v1" &&
			/^[A-Za-z0-9-]{1,128}$/.test(manifest.attemptId) && ["asset_metadata_inspect", "document_read"].includes(manifest.tool.name) && manifest.tool.version === "windows-utf8.v1" &&
			manifest.command.executable === this.executable && manifest.command.workingDirectory === directory && JSON.stringify(manifest.command.argv) === JSON.stringify([source, "1"]) &&
			JSON.stringify(manifest.paths.readOnly) === JSON.stringify([source]) && manifest.paths.writable.length === 0 && manifest.paths.temporaryDirectory === join(directory, "output") &&
			manifest.network.mode === "deny-all" && manifest.network.allowedDomains.length === 0 && JSON.stringify(manifest.environment) === '{"LANG":"en_US.UTF-8"}' &&
			manifest.limits.maxOutputFiles === 0 && manifest.limits.maxOutputBytes === 0 && (manifest.limits.maxMemoryBytes ?? 0) >= 64 * 1024 * 1024 &&
			(manifest.limits.maxCpuSeconds ?? 0) >= 30 && manifest.limits.timeoutMs <= 60000;
		if (!policyMatches) return result("policy_denied", "fixed_text_policy_required");
		try {
			for (const path of [this.workspaceRoot, join(this.workspaceRoot, ".blackx-tool-inputs"), directory, source, this.broker, this.executable]) {
				const info = lstatSync(path);
				if (info.isSymbolicLink() || realpathSync(path).toLowerCase() !== resolve(path).toLowerCase() || info.isFile() && info.nlink !== 1) return result("policy_denied", "path_identity_changed");
			}
			const info = lstatSync(source);
			if (!info.isFile() || !info.size || info.size > 131072) return result("policy_denied", "text_input_limit_128kib");
		} catch { return result("sandbox_unavailable", "native_text_binary_or_input_unavailable"); }
		const stage = join(directory, "native"), profile = `Packx.Text.${randomUUID().replaceAll("-", "")}`;
		let cleanupVerified = false;
		const unavailable = (reason: string) => {
			console.error(JSON.stringify({ type: "windows_text.execution_unavailable", cleanupVerified, tenantId: manifest.tenantId, workspaceId: manifest.workspaceId, runId: manifest.runId, attemptId: manifest.attemptId, profile, reason }));
			return result("sandbox_unavailable", reason);
		};
		try {
			const outcome = await new Promise<{ output: string; code: number | null; forced: boolean; expired: boolean }>((accept, reject) => {
				// Detached avoids libuv killing this trusted cleanup broker with the Host; keep its pipe and process reference.
				// This trusted broker receives no model/customer credentials. The worker receives an even smaller native allowlist.
				const child = spawn(this.broker, [stage, profile, source, this.executable, String(manifest.limits.timeoutMs), String(Math.min(manifest.limits.maxStdoutBytes, 1048576))], { cwd: dirname(this.broker), detached: true, windowsHide: true, env: { SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemDrive, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE }, stdio: ["pipe", "pipe", "pipe"] });
				const chunks: Buffer[] = []; let size = 0, forced = false, expired = false;
				const cancel = () => child.stdin.destroy(); // EOF also occurs when the Node Host crashes; broker kills Job and deletes its profile.
				const deadline = setTimeout(() => { expired = true; cancel(); }, manifest.limits.timeoutMs);
				const hardDeadline = setTimeout(() => { forced = true; child.kill(); }, manifest.limits.timeoutMs + 15000);
				const clear = () => { clearTimeout(deadline); clearTimeout(hardDeadline); signal.removeEventListener("abort", cancel); };
				child.stdin.on("error", () => {}); // EPIPE after a completed broker is expected; process outcome is authoritative.
				child.stdout.on("data", (data: Buffer) => { size += data.length; if (size > 2 * 1048576) { forced = true; child.kill(); } else chunks.push(data); });
				child.stderr.resume(); // Never include native paths or customer text in model-visible errors.
				signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
				child.once("error", (error) => { clear(); reject(error); });
				child.once("close", (code) => { clear(); accept({ output: Buffer.concat(chunks).toString("utf8"), code, forced, expired }); });
			});
			if (outcome.code !== 0 || outcome.forced) return unavailable("broker_failed_cleanup_unconfirmed");
			const report = JSON.parse(outcome.output) as Record<string, unknown>;
			if (report.schemaVersion !== "windows-text-execution.v1" || report.cleanupVerified !== true || report.profileDeleted !== true || !Number.isSafeInteger(report.workerPid) || !["succeeded", "failed", "cancelled", "timed_out", "resource_exhausted"].includes(String(report.status))) return unavailable("native_evidence_invalid");
			cleanupVerified = true;
			if (signal.aborted) return result("cancelled", "owner_cancelled_cleanup_verified");
			if (outcome.expired || report.status === "timed_out") return result("timed_out", "deadline_cleanup_verified");
			if (report.status === "failed" && report.diagnostic && typeof report.diagnostic === "object") {
				const code = (report.diagnostic as { error?: unknown }).error;
				const known = ["token_unavailable", "token_boundary_missing", "capability_boundary_missing", "network_initialization_failed", "network_boundary_not_verified", "input_unavailable", "input_limit_or_identity", "input_read_failed", "binary_content", "unsupported_format", "invalid_encoding", "empty_input"];
				if (typeof code === "string" && known.includes(code)) return result(/^(token|capability|network)_/.test(code) ? "sandbox_unavailable" : "failed", code);
			}
			if (report.status !== "succeeded") return result(report.status as ToolSandboxStatus, "native_text_" + report.status);
			if (report.exitCode !== 0 || !isAssetInspection(report.inspection) || report.inspection.kind !== "text" || report.inspection.bytes !== lstatSync(source).size) return result("failed", "native_text_output_invalid");
			return result("succeeded", "lpac_registry_read_job_cleanup_verified", JSON.stringify(report.inspection), 0);
		} catch { return unavailable(cleanupVerified ? "native_result_validation_failed" : "broker_or_report_failed_cleanup_unconfirmed"); }
		finally {
			// Do not delete an uncertain broker's resources while it might still own them.
			if (cleanupVerified) rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	}
}
