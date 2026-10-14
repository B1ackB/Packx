import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	readFile,
	readdir,
	realpath,
	rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { EgressProxy, type EgressProxyOptions } from "./egressProxy";
import { validToolExecutionManifest } from "../../src/agent/sandbox";
import type {
	SandboxedToolExecutorPort,
	ToolExecutionManifest,
	ToolExecutionOutput,
	ToolExecutionResult,
	ToolSandboxStatus,
} from "../../src/agent/sandbox";

const defaultSandboxExecutable = "/usr/bin/sandbox-exec";
const platform = "macos-seatbelt";

class SandboxPolicyError extends Error {}
class SandboxResourceError extends Error {}

interface PreparedExecution {
	executable: string;
	workingDirectory: string;
	literalReadPaths?: readonly string[];
	readOnlyPaths: readonly string[];
	writablePaths: readonly string[];
	temporaryDirectory: string;
	protectedPaths?: readonly string[];
	egressPort?: number;
}

export interface MacOsSeatbeltSandboxedToolExecutorOptions {
	workspaceRoot: string;
	sandboxExecutable?: string;
	protectedPaths?: readonly string[];
	egress?: Pick<EgressProxyOptions, "resolve" | "connect" | "onDecision">;
}

function inside(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function seatbeltString(value: string): string {
	return JSON.stringify(value);
}

function pathRules(paths: readonly string[]): string {
	return paths.map((path) => `(subpath ${seatbeltString(path)})`).join(" ");
}

function uniquePaths(paths: readonly string[]): readonly string[] {
	return [...new Set(paths)];
}

function ancestorRules(paths: readonly string[]): string {
	const ancestors = new Set<string>();
	for (const path of paths) {
		let parent = dirname(path);
		while (parent !== "/") {
			ancestors.add(parent);
			parent = dirname(parent);
		}
	}
	return [...ancestors].map((path) => `(literal ${seatbeltString(path)})`).join(" ");
}

export function compileMacOsSeatbeltProfile(execution: PreparedExecution): string {
	const declaredPaths = [
		execution.executable,
		execution.workingDirectory,
		...(execution.literalReadPaths ?? []),
		...execution.readOnlyPaths,
		...execution.writablePaths,
		execution.temporaryDirectory,
	];
	const protectedRules = pathRules(execution.protectedPaths ?? []);
	const readable = [
		"(literal \"/\")",
		"(subpath \"/System\")",
		"(subpath \"/bin\")",
		"(subpath \"/sbin\")",
		"(subpath \"/usr/bin\")",
		"(subpath \"/usr/sbin\")",
		"(subpath \"/usr/lib\")",
		"(subpath \"/usr/share\")",
		ancestorRules(declaredPaths),
		`(literal ${seatbeltString(execution.executable)})`,
		`(literal ${seatbeltString(execution.workingDirectory)})`,
		...(execution.literalReadPaths ?? []).map((path) => `(literal ${seatbeltString(path)})`),
		pathRules(execution.readOnlyPaths),
		pathRules(execution.writablePaths),
		`(subpath ${seatbeltString(execution.temporaryDirectory)})`,
	].filter(Boolean).join(" ");
	const writable = [
		pathRules(execution.writablePaths),
		`(subpath ${seatbeltString(execution.temporaryDirectory)})`,
	].filter(Boolean).join(" ");
	return [
		"(version 1)",
		"(allow default)",
		"(deny signal)",
		"(allow signal (target self))",
		"(deny network*)",
		...(execution.egressPort ? [`(allow network-outbound (remote ip ${seatbeltString(`localhost:${execution.egressPort}`)}))`] : []),
		"(deny file-read*)",
		`(allow file-read* ${readable})`,
		...(protectedRules ? [`(deny file-read* ${protectedRules})`] : []),
		"(deny file-write*)",
		`(allow file-write* ${writable})`,
		...(protectedRules ? [`(deny file-write* ${protectedRules})`] : []),
	].join("\n");
}

function redactHostPaths(text: string, paths: readonly (readonly [string, string])[]): string {
	let redacted = text;
	for (const [path, label] of [...paths].sort((left, right) => right[0].length - left[0].length)) {
		if (path.length > 1) redacted = redacted.split(path).join(label);
	}
	return redacted;
}

function mimeType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".gif": return "image/gif";
		case ".jpeg":
		case ".jpg": return "image/jpeg";
		case ".json": return "application/json";
		case ".pdf": return "application/pdf";
		case ".png": return "image/png";
		case ".svg": return "image/svg+xml";
		case ".txt": return "text/plain";
		case ".webp": return "image/webp";
		default: return "application/octet-stream";
	}
}

function boundedText(chunks: readonly Buffer[], limit: number): string {
	let text = Buffer.concat(chunks).toString("utf8");
	while (Buffer.byteLength(text) > limit) text = text.slice(0, -1);
	return text;
}

async function sha256(path: string): Promise<string> {
	const bytes = await readFile(path);
	return createHash("sha256").update(bytes).digest("hex");
}

async function collectOutputs(
	root: string,
	limits: ToolExecutionManifest["limits"],
): Promise<readonly ToolExecutionOutput[]> {
	const outputs: ToolExecutionOutput[] = [];
	let totalBytes = 0;
	let entries = 0;
	const visit = async (directory: string, depth = 0): Promise<void> => {
		if (depth > 32) throw new SandboxResourceError();
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (++entries > limits.maxOutputFiles + 64) throw new SandboxResourceError();
			const path = resolve(directory, entry.name);
			const metadata = await lstat(path);
			if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
				throw new SandboxPolicyError("Sandbox output must contain only regular files and directories");
			}
			if (metadata.isDirectory()) {
				await visit(path, depth + 1);
				continue;
			}
			if (metadata.nlink !== 1) throw new SandboxPolicyError("Sandbox output hard links are not allowed");
			totalBytes += metadata.size;
			if (outputs.length >= limits.maxOutputFiles || totalBytes > limits.maxOutputBytes) {
				throw new SandboxResourceError("Sandbox output exceeded its file or byte limit");
			}
			outputs.push({
				path: relative(root, path).split(sep).join("/"),
				size: metadata.size,
				mimeType: mimeType(path),
				sha256: await sha256(path),
			});
		}
	};
	await visit(root);
	return outputs.sort((left, right) => left.path.localeCompare(right.path));
}

async function canonicalWorkspaceEntry(
	lexicalWorkspaceRoot: string,
	canonicalWorkspaceRoot: string,
	path: string,
	type: "directory" | "file-or-directory",
): Promise<string> {
	const lexical = resolve(path);
	if (!inside(lexicalWorkspaceRoot, lexical) && !inside(canonicalWorkspaceRoot, lexical)) {
		throw new SandboxPolicyError("Sandbox path is outside the configured Workspace");
	}
	const metadata = await lstat(lexical);
	if (metadata.isSymbolicLink()) throw new SandboxPolicyError("Sandbox permission paths cannot be symbolic links");
	if (type === "directory" && !metadata.isDirectory()) throw new SandboxPolicyError("Sandbox directory path is not a directory");
	if (type === "file-or-directory" && !metadata.isDirectory() && !metadata.isFile()) {
		throw new SandboxPolicyError("Sandbox permission paths must be regular files or directories");
	}
	const canonical = await realpath(lexical);
	if (!inside(canonicalWorkspaceRoot, canonical)) {
		throw new SandboxPolicyError("Sandbox path resolves outside the configured Workspace");
	}
	return canonical;
}

async function prepareExecution(
	manifest: ToolExecutionManifest,
	configuredWorkspaceRoot: string,
): Promise<PreparedExecution> {
	const lexicalWorkspaceRoot = resolve(configuredWorkspaceRoot);
	const canonicalWorkspaceRoot = await realpath(lexicalWorkspaceRoot);
	const executableMetadata = await lstat(manifest.command.executable);
	if (executableMetadata.isSymbolicLink() || !executableMetadata.isFile()) {
		throw new SandboxPolicyError("Sandbox executable must be a regular file, not a symbolic link");
	}
	await access(manifest.command.executable, constants.X_OK);
	const executable = await realpath(manifest.command.executable);
	const workingDirectory = await canonicalWorkspaceEntry(
		lexicalWorkspaceRoot,
		canonicalWorkspaceRoot,
		manifest.command.workingDirectory,
		"directory",
	);
	const readOnlyPaths = await Promise.all(manifest.paths.readOnly.map((path) =>
		canonicalWorkspaceEntry(lexicalWorkspaceRoot, canonicalWorkspaceRoot, path, "file-or-directory")
	));
	const writablePaths = await Promise.all(manifest.paths.writable.map((path) =>
		canonicalWorkspaceEntry(lexicalWorkspaceRoot, canonicalWorkspaceRoot, path, "directory")
	));
	const temporaryDirectory = resolve(manifest.paths.temporaryDirectory);
	if (!inside(lexicalWorkspaceRoot, temporaryDirectory) && !inside(canonicalWorkspaceRoot, temporaryDirectory)) {
		throw new SandboxPolicyError("Sandbox temporary directory is outside the configured Workspace");
	}
	const temporaryParent = await canonicalWorkspaceEntry(
		lexicalWorkspaceRoot,
		canonicalWorkspaceRoot,
		dirname(temporaryDirectory),
		"directory",
	);
	const canonicalTemporaryDirectory = resolve(temporaryParent, basename(temporaryDirectory));
	if (!inside(canonicalWorkspaceRoot, canonicalTemporaryDirectory)) {
		throw new SandboxPolicyError("Sandbox temporary directory resolves outside the configured Workspace");
	}
	try {
		await mkdir(canonicalTemporaryDirectory, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new SandboxPolicyError("Sandbox temporary directory must be unique per attempt");
		}
		throw error;
	}
	return {
		executable,
		workingDirectory,
		literalReadPaths: uniquePaths([
			resolve(manifest.command.workingDirectory),
			workingDirectory,
		]),
		readOnlyPaths: uniquePaths([
			...manifest.paths.readOnly.flatMap((path, index) => [resolve(path), readOnlyPaths[index]!]),
			resolve(manifest.paths.temporaryDirectory),
			canonicalTemporaryDirectory,
		]),
		writablePaths: uniquePaths([
			...manifest.paths.writable.flatMap((path, index) => [resolve(path), writablePaths[index]!]),
			resolve(manifest.paths.temporaryDirectory),
			canonicalTemporaryDirectory,
		]),
		temporaryDirectory: canonicalTemporaryDirectory,
		protectedPaths: uniquePaths([
			resolve(lexicalWorkspaceRoot, ".git"),
			resolve(canonicalWorkspaceRoot, ".git"),
			resolve(lexicalWorkspaceRoot, ".blackx-data"),
			resolve(canonicalWorkspaceRoot, ".blackx-data"),
			resolve(canonicalWorkspaceRoot, ".packx-settings.json"),
			resolve(canonicalWorkspaceRoot, ".env"),
		]),
	};
}

function result(
	manifest: ToolExecutionManifest,
	startedAt: Date,
	status: ToolSandboxStatus,
	exitCode: number | null,
	stdout: ToolExecutionResult["stdout"],
	stderr: ToolExecutionResult["stderr"],
	outputs: readonly ToolExecutionOutput[],
	terminationReason?: string,
): ToolExecutionResult {
	const completedAt = new Date();
	return {
		schemaVersion: "tool-execution-result.v1",
		attemptId: manifest.attemptId,
		status,
		exitCode,
		startedAt: startedAt.toISOString(),
		completedAt: completedAt.toISOString(),
		durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
		stdout,
		stderr,
		outputs,
		sandbox: {
			profile: manifest.sandboxProfile,
			platform,
			...(terminationReason ? { terminationReason } : {}),
			permissions: {
				readOnlyPaths: manifest.paths.readOnly.length,
				writablePaths: manifest.paths.writable.length,
				network: manifest.network.mode,
				environmentKeys: Object.keys(manifest.environment),
			},
		},
	};
}

function failureResult(
	manifest: ToolExecutionManifest,
	startedAt: Date,
	status: Exclude<ToolSandboxStatus, "succeeded">,
	reason: string,
): ToolExecutionResult {
	return result(
		manifest,
		startedAt,
		status,
		null,
		{ text: "", truncated: false },
		{ text: "", truncated: false },
		[],
		reason,
	);
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!pid) return;
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

export async function diagnoseMacOsSeatbelt(
	sandboxExecutable = defaultSandboxExecutable,
): Promise<{ available: boolean; reason?: string }> {
	if (process.platform !== "darwin") return { available: false, reason: "macOS is required" };
	try {
		await access(sandboxExecutable, constants.X_OK);
		return { available: true };
	} catch {
		return { available: false, reason: "sandbox-exec is unavailable or not executable" };
	}
}

export class MacOsSeatbeltSandboxedToolExecutor implements SandboxedToolExecutorPort {
	private readonly sandboxExecutable: string;

	constructor(private readonly options: MacOsSeatbeltSandboxedToolExecutorOptions) {
		this.sandboxExecutable = options.sandboxExecutable ?? defaultSandboxExecutable;
	}

	async execute(manifest: ToolExecutionManifest, signal: AbortSignal): Promise<ToolExecutionResult> {
		const startedAt = new Date();
		if (!validToolExecutionManifest(manifest)) return failureResult(manifest, startedAt, "policy_denied", "invalid_manifest");
		const supervisor = resolve(".blackx-tools/tool-supervisor");
		try { await access(supervisor, constants.X_OK); }
		catch { return failureResult(manifest, startedAt, "sandbox_unavailable", "supervisor_unavailable"); }
		const abortedStatus = () => signal.reason instanceof Error && signal.reason.message === "tool_timeout"
			? "timed_out" as const
			: "cancelled" as const;
		const diagnostic = await diagnoseMacOsSeatbelt(this.sandboxExecutable);
		if (!diagnostic.available) {
			return failureResult(manifest, startedAt, "sandbox_unavailable", diagnostic.reason ?? "seatbelt_unavailable");
		}
		if (signal.aborted) {
			const status = abortedStatus();
			return failureResult(manifest, startedAt, status, `${status}_before_spawn`);
		}

		let execution: PreparedExecution | undefined;
		try {
			execution = await prepareExecution(manifest, this.options.workspaceRoot);
			execution.protectedPaths = [...execution.protectedPaths ?? [], ...this.options.protectedPaths ?? []];
		} catch (error) {
			return failureResult(
				manifest,
				startedAt,
				error instanceof SandboxPolicyError ? "policy_denied" : "sandbox_unavailable",
				error instanceof SandboxPolicyError ? "manifest_path_policy_denied" : "sandbox_preflight_failed",
			);
		}
		const hostPaths: Array<readonly [string, string]> = [
			[execution.temporaryDirectory, "<tmp>"],
			[resolve(manifest.paths.temporaryDirectory), "<tmp>"],
			[execution.workingDirectory, "<workspace>"],
			[resolve(this.options.workspaceRoot), "<workspace>"],
			[await realpath(resolve(this.options.workspaceRoot)), "<workspace>"],
			[homedir(), "<home>"],
		];
		let egress: EgressProxy | undefined;
		if (manifest.network.mode === "allowlist") {
			egress = new EgressProxy({ allowedDomains: manifest.network.allowedDomains, ...this.options.egress });
			try {
				execution.egressPort = await egress.start();
			} catch {
				await egress.stop().catch(() => undefined);
				await rm(execution.temporaryDirectory, { recursive: true, force: true });
				return failureResult(manifest, startedAt, "sandbox_unavailable", "egress_proxy_unavailable");
			}
		}
		const egressEnvironment = execution.egressPort
			? Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].map((key) => [key, `http://127.0.0.1:${execution!.egressPort}`]))
			: {};

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let stdoutStoredBytes = 0;
		let stderrStoredBytes = 0;
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let forcedStatus: "timed_out" | "cancelled" | "resource_exhausted" | undefined;
		let child: ReturnType<typeof spawn> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const terminate = (status: typeof forcedStatus) => {
			if (forcedStatus) return;
			forcedStatus = status;
			killProcessGroup(child?.pid, "SIGTERM");
			killTimer = setTimeout(() => killProcessGroup(child?.pid, "SIGKILL"), 1000);
			killTimer.unref();
		};
		const aborted = () => terminate(abortedStatus());

		try {
			const profile = compileMacOsSeatbeltProfile(execution);
			child = spawn(
				supervisor,
				[
					String(Math.min(manifest.limits.maxCpuSeconds ?? 30, 30)),
					String(Math.min(manifest.limits.maxMemoryBytes ?? 512 * 1024 * 1024, 512 * 1024 * 1024)),
					String(Math.min(manifest.limits.maxProcesses ?? 8, 8)),
					String(manifest.limits.maxOutputBytes), String(manifest.limits.maxOutputFiles + 64), execution.temporaryDirectory,
					this.sandboxExecutable, "-p", profile, execution.executable, ...manifest.command.argv,
				],
				{
					cwd: execution.workingDirectory,
					detached: true,
					env: { ...manifest.environment, ...egressEnvironment },
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			signal.addEventListener("abort", aborted, { once: true });
			if (signal.aborted) aborted();
			timeout = setTimeout(() => terminate("timed_out"), manifest.limits.timeoutMs);
			timeout.unref();

			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > manifest.limits.maxStdoutBytes) {
					stdoutTruncated = true;
					terminate("resource_exhausted");
				}
				if (stdoutStoredBytes < manifest.limits.maxStdoutBytes) {
					const stored = chunk.subarray(0, manifest.limits.maxStdoutBytes - stdoutStoredBytes);
					stdoutChunks.push(stored);
					stdoutStoredBytes += stored.length;
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.length;
				if (stderrBytes > manifest.limits.maxStderrBytes) {
					stderrTruncated = true;
					terminate("resource_exhausted");
				}
				if (stderrStoredBytes < manifest.limits.maxStderrBytes) {
					const stored = chunk.subarray(0, manifest.limits.maxStderrBytes - stderrStoredBytes);
					stderrChunks.push(stored);
					stderrStoredBytes += stored.length;
				}
			});

			const outcome = await new Promise<{ code: number | null; error?: NodeJS.ErrnoException }>((resolveOutcome) => {
				child!.once("error", (error: NodeJS.ErrnoException) => resolveOutcome({ code: null, error }));
				child!.once("close", (code) => resolveOutcome({ code }));
			});
			killProcessGroup(child.pid, "SIGKILL");

			const stdout = {
				text: redactHostPaths(boundedText(stdoutChunks, manifest.limits.maxStdoutBytes), hostPaths),
				truncated: stdoutTruncated,
			};
			const stderr = {
				text: redactHostPaths(boundedText(stderrChunks, manifest.limits.maxStderrBytes), hostPaths),
				truncated: stderrTruncated,
			};
			if (outcome.error) {
				return result(manifest, startedAt, "sandbox_unavailable", null, stdout, stderr, [], "sandbox_spawn_failed");
			}
			if (forcedStatus) {
				return result(manifest, startedAt, forcedStatus, outcome.code, stdout, stderr, [], forcedStatus);
			}
			if (outcome.code === 75) return result(manifest, startedAt, "resource_exhausted", outcome.code, stdout, stderr, [], "native_resource_limit");
			if (outcome.code === 70) return result(manifest, startedAt, "sandbox_unavailable", outcome.code, stdout, stderr, [], "supervisor_failed");
			if (outcome.code !== 0) {
				const unavailable = outcome.code === 71 && stderr.text.includes("sandbox_apply");
				return result(
					manifest,
					startedAt,
					unavailable ? "sandbox_unavailable" : "failed",
					outcome.code,
					stdout,
					stderr,
					[],
					unavailable ? "seatbelt_apply_failed" : `exit_code_${outcome.code ?? "signal"}`,
				);
			}

			try {
				const outputs = await collectOutputs(execution.temporaryDirectory, manifest.limits);
				return result(manifest, startedAt, "succeeded", 0, stdout, stderr, outputs);
			} catch (error) {
				return result(
					manifest,
					startedAt,
					error instanceof SandboxResourceError ? "resource_exhausted" : "policy_denied",
					0,
					stdout,
					stderr,
					[],
					error instanceof SandboxResourceError ? "output_limit_exceeded" : "output_validation_failed",
				);
			}
		} finally {
			if (timeout) clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			signal.removeEventListener("abort", aborted);
			if (child?.pid) killProcessGroup(child.pid, "SIGKILL");
			await egress?.stop();
			if (execution) await rm(execution.temporaryDirectory, { recursive: true, force: true });
		}
	}
}
