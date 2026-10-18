export type ToolSandboxStatus =
	| "succeeded"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "resource_exhausted"
	| "policy_denied"
	| "sandbox_unavailable";

export interface ToolExecutionInvocation {
	readonly argv: readonly string[];
	readonly workingDirectory: string;
	readonly paths: {
		readonly readOnly: readonly string[];
		readonly writable: readonly string[];
		readonly temporaryDirectory: string;
	};
}

export interface ToolExecutionManifest {
	readonly schemaVersion: "tool-execution-manifest.v1";
	readonly attemptId: string;
	readonly tenantId: string;
	readonly workspaceId: string;
	readonly runId: string;
	readonly stageId: string;
	readonly executionId: string;
	readonly toolCallId: string;
	readonly tool: {
		readonly name: string;
		readonly version: string;
	};
	readonly sandboxProfile: "blackx-local-tool-sandbox.v1";
	readonly command: {
		readonly executable: string;
		readonly argv: readonly string[];
		readonly workingDirectory: string;
	};
	readonly paths: {
		readonly readOnly: readonly string[];
		readonly writable: readonly string[];
		readonly temporaryDirectory: string;
	};
	readonly environment: Readonly<Record<string, string>>;
	readonly network: {
		readonly mode: "deny-all" | "allowlist";
		readonly allowedDomains: readonly string[];
	};
	readonly limits: {
		readonly timeoutMs: number;
		readonly maxCpuSeconds?: number;
		readonly maxMemoryBytes?: number;
		readonly maxProcesses?: number;
		readonly maxStdoutBytes: number;
		readonly maxStderrBytes: number;
		readonly maxOutputFiles: number;
		readonly maxOutputBytes: number;
	};
	readonly idempotencyKey: string;
	readonly approvalId?: string;
}

export type ToolExecutionManifestInput = Omit<
	ToolExecutionManifest,
	"schemaVersion" | "sandboxProfile"
>;

export interface ToolExecutionOutput {
	readonly path: string;
	readonly size: number;
	readonly mimeType: string;
	readonly sha256: string;
}

export interface ToolExecutionResult {
	readonly schemaVersion: "tool-execution-result.v1";
	readonly attemptId: string;
	readonly status: ToolSandboxStatus;
	readonly exitCode: number | null;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly durationMs: number;
	readonly stdout: { readonly text: string; readonly truncated: boolean };
	readonly stderr: { readonly text: string; readonly truncated: boolean };
	readonly outputs: readonly ToolExecutionOutput[];
	readonly sandbox: {
		readonly profile: ToolExecutionManifest["sandboxProfile"];
		readonly platform: string;
		readonly terminationReason?: string;
		readonly permissions: {
			readonly readOnlyPaths: number;
			readonly writablePaths: number;
			readonly network: ToolExecutionManifest["network"]["mode"];
			readonly environmentKeys: readonly string[];
		};
	};
}

export interface SandboxedToolExecutorPort {
	execute(manifest: ToolExecutionManifest, signal: AbortSignal): Promise<ToolExecutionResult>;
}

function frozenStrings(values: readonly string[]): readonly string[] {
	return Object.freeze([...values]);
}

export function compileToolExecutionManifest(input: ToolExecutionManifestInput): ToolExecutionManifest {
	return Object.freeze({
		...input,
		schemaVersion: "tool-execution-manifest.v1",
		tool: Object.freeze({ ...input.tool }),
		sandboxProfile: "blackx-local-tool-sandbox.v1",
		command: Object.freeze({
			...input.command,
			argv: frozenStrings(input.command.argv),
		}),
		paths: Object.freeze({
			...input.paths,
			readOnly: frozenStrings(input.paths.readOnly),
			writable: frozenStrings(input.paths.writable),
		}),
		environment: Object.freeze({ ...input.environment }),
		network: Object.freeze({
			...input.network,
			allowedDomains: frozenStrings(input.network.allowedDomains),
		}),
		limits: Object.freeze({ ...input.limits }),
	});
}

function unique(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

function safeAbsolutePath(value: string): boolean {
	if (/^[A-Za-z]:\\/.test(value)) {
		return value.length < 260 && value.slice(3).split("\\").every(safeWindowsSegment);
	}
	const segments = value.split("/").slice(1);
	return value.startsWith("/") && !value.includes("\0") &&
		segments.length > 0 && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function safeWindowsSegment(value: string): boolean {
	return value.length > 0 && value.length <= 255 && !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value) &&
		!/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i.test(value);
}

function safeOutputPath(value: string, windows: boolean): boolean {
	const segments = value.split(/[\\/]/);
	return value.length > 0 &&
		!value.startsWith("/") &&
		!value.startsWith("\\") &&
		!value.includes("\0") &&
		segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && (!windows || safeWindowsSegment(segment)));
}

function positiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

export function validToolExecutionManifest(manifest: ToolExecutionManifest): boolean {
	const paths = [
		manifest.command.executable,
		manifest.command.workingDirectory,
		manifest.paths.temporaryDirectory,
		...manifest.paths.readOnly,
		...manifest.paths.writable,
	];
	return manifest.attemptId.trim().length > 0 &&
		manifest.tenantId.trim().length > 0 &&
		manifest.workspaceId.trim().length > 0 &&
		manifest.runId.trim().length > 0 &&
		manifest.stageId.trim().length > 0 &&
		manifest.executionId.trim().length > 0 &&
		manifest.toolCallId.trim().length > 0 &&
		manifest.tool.name.trim().length > 0 &&
		manifest.tool.version.trim().length > 0 &&
		paths.every((path) => safeAbsolutePath(path) && /^[A-Za-z]:\\/.test(path) === /^[A-Za-z]:\\/.test(manifest.command.executable)) &&
		unique(manifest.paths.readOnly) &&
		unique(manifest.paths.writable) &&
		manifest.command.argv.every((value) => typeof value === "string" && !value.includes("\0")) &&
		Object.entries(manifest.environment).every(([key, value]) =>
			/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !value.includes("\0")
		) &&
		unique(manifest.network.allowedDomains) &&
		(manifest.network.mode === "allowlist" || manifest.network.allowedDomains.length === 0) &&
		manifest.network.allowedDomains.every((domain) =>
			domain.trim() === domain && domain.length > 0 && !domain.includes(":") && !domain.includes("/")
		) &&
		positiveInteger(manifest.limits.timeoutMs) &&
		[manifest.limits.maxCpuSeconds, manifest.limits.maxMemoryBytes, manifest.limits.maxProcesses].every((v) => v === undefined || positiveInteger(v)) &&
		positiveInteger(manifest.limits.maxStdoutBytes) &&
		positiveInteger(manifest.limits.maxStderrBytes) &&
		nonNegativeInteger(manifest.limits.maxOutputFiles) &&
		nonNegativeInteger(manifest.limits.maxOutputBytes) &&
		manifest.idempotencyKey.trim().length > 0 && manifest.idempotencyKey.length <= 256 &&
		(manifest.approvalId === undefined || manifest.approvalId.trim().length > 0);
}

export function validToolExecutionResult(
	result: ToolExecutionResult,
	manifest: ToolExecutionManifest,
): boolean {
	const validStatus = [
		"succeeded",
		"failed",
		"timed_out",
		"cancelled",
		"resource_exhausted",
		"policy_denied",
		"sandbox_unavailable",
	].includes(result.status);
	const environmentKeys = Object.keys(manifest.environment).sort();
	const reportedEnvironmentKeys = [...result.sandbox.permissions.environmentKeys].sort();
	const outputPaths = result.outputs.map((output) => output.path);
	const windows = /^[A-Za-z]:\\/.test(manifest.command.executable);
	const outputBytes = result.outputs.reduce((total, output) => total + output.size, 0);
	const startedAt = Date.parse(result.startedAt);
	const completedAt = Date.parse(result.completedAt);
	return result.schemaVersion === "tool-execution-result.v1" &&
		validStatus &&
		(result.exitCode === null || Number.isSafeInteger(result.exitCode)) &&
		result.attemptId === manifest.attemptId &&
		result.sandbox.profile === manifest.sandboxProfile &&
		result.sandbox.platform.trim().length > 0 &&
		result.sandbox.permissions.readOnlyPaths === manifest.paths.readOnly.length &&
		result.sandbox.permissions.writablePaths === manifest.paths.writable.length &&
		result.sandbox.permissions.network === manifest.network.mode &&
		JSON.stringify(reportedEnvironmentKeys) === JSON.stringify(environmentKeys) &&
		Number.isFinite(result.durationMs) && result.durationMs >= 0 &&
		Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt &&
		new TextEncoder().encode(result.stdout.text).length <= manifest.limits.maxStdoutBytes &&
		new TextEncoder().encode(result.stderr.text).length <= manifest.limits.maxStderrBytes &&
		result.outputs.length <= manifest.limits.maxOutputFiles &&
		unique(outputPaths.map((path) => windows ? path.replaceAll("\\", "/").toLowerCase() : path)) &&
		Number.isSafeInteger(outputBytes) && outputBytes <= manifest.limits.maxOutputBytes &&
		result.outputs.every((output) =>
			safeOutputPath(output.path, windows) &&
			nonNegativeInteger(output.size) &&
			output.mimeType.trim().length > 0 &&
			/^[a-f0-9]{64}$/.test(output.sha256)
		) &&
		(result.status !== "succeeded" || result.exitCode === 0) &&
		(result.status === "succeeded" || Boolean(result.sandbox.terminationReason?.trim()));
}
