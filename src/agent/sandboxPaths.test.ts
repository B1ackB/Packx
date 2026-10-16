import { describe, expect, it } from "vitest";
import { compileToolExecutionManifest, validToolExecutionManifest, validToolExecutionResult, type ToolExecutionResult } from "./sandbox";

function manifest() {
	return compileToolExecutionManifest({
		attemptId: "attempt", tenantId: "tenant", workspaceId: "workspace", runId: "run", stageId: "stage", executionId: "execution", toolCallId: "call",
		tool: { name: "inspect", version: "1" },
		command: { executable: "C:\\Program Files\\Packx\\inspect.exe", argv: [], workingDirectory: "C:\\workspace\\attempt" },
		paths: { readOnly: ["C:\\workspace\\attempt\\输入.txt"], writable: [], temporaryDirectory: "C:\\workspace\\attempt\\output" },
		environment: {}, network: { mode: "deny-all", allowedDomains: [] },
		limits: { timeoutMs: 1000, maxStdoutBytes: 1000, maxStderrBytes: 1000, maxOutputFiles: 2, maxOutputBytes: 1000 }, idempotencyKey: "inspect-1",
	});
}

function result(paths: string[]): ToolExecutionResult {
	const input = manifest();
	return {
		schemaVersion: "tool-execution-result.v1", attemptId: input.attemptId, status: "succeeded", exitCode: 0,
		startedAt: "2026-10-16T00:00:00Z", completedAt: "2026-10-16T00:00:00Z", durationMs: 0,
		stdout: { text: "", truncated: false }, stderr: { text: "", truncated: false },
		outputs: paths.map(path => ({ path, size: 1, mimeType: "text/plain", sha256: "0".repeat(64) })),
		sandbox: { profile: input.sandboxProfile, platform: "windows-test-only", permissions: { readOnlyPaths: 1, writablePaths: 0, network: "deny-all", environmentKeys: [] } },
	};
}

describe("Windows tool path contract (syntax is not OS isolation)", () => {
	it("accepts explicit local drive paths with spaces and Unicode", () => {
		expect(validToolExecutionManifest(manifest())).toBe(true);
		expect(validToolExecutionResult(result(["pages/输出.txt"]), manifest())).toBe(true);
	});
	it.each([
		"C:relative.txt", "C:/mixed/file.txt", "\\rooted.txt", "\\\\server\\share\\file.txt", "\\\\?\\C:\\file.txt", "\\\\.\\PhysicalDrive0",
		"C:\\", "C:\\workspace\\..\\secret", "C:\\workspace\\.\\file", "C:\\workspace\\\\file", "C:\\workspace\\file:stream",
		"C:\\workspace\\CON", "C:\\workspace\\nul.txt", "C:\\workspace\\COM¹.txt", "C:\\workspace\\LPT9.log", "C:\\workspace\\file.", "C:\\workspace\\file ",
		"C:\\workspace\\NUL .txt", "C:\\workspace\\CONIN$",
		"C:\\workspace\\bad\nname", "C:\\workspace\\*.txt", "C:\\workspace\\" + "a".repeat(260), "/posix/input.txt",
	])("rejects ambiguous, device, stream or mixed-family input %j", path => {
		const input = manifest();
		expect(validToolExecutionManifest({ ...input, paths: { ...input.paths, readOnly: [path] } })).toBe(false);
	});
	it.each(["executable", "workingDirectory", "temporaryDirectory", "writable"])("checks the %s boundary as well", field => {
		const input = manifest(), path = "C:\\workspace\\file:stream";
		const invalid = field === "executable" || field === "workingDirectory"
			? { ...input, command: { ...input.command, [field]: path } }
			: { ...input, paths: { ...input.paths, [field]: field === "writable" ? [path] : path } };
		expect(validToolExecutionManifest(invalid)).toBe(false);
	});
	it.each(["C:stream", "file:stream", "NUL.txt", "dir/COM²", "dir/CONOUT$", "dir/file.", "dir/file ", "../escape", "dir\\..\\escape"])("rejects Windows output alias %j", path => {
		expect(validToolExecutionResult(result([path]), manifest())).toBe(false);
	});
	it("rejects case and separator aliases of the same Windows output", () => {
		expect(validToolExecutionResult(result(["dir/Report.txt", "DIR\\report.TXT"]), manifest())).toBe(false);
	});
	it("preserves POSIX paths and output names without importing Node in Core", () => {
		const input = manifest();
		const posix = { ...input, command: { ...input.command, executable: "/tools/inspect", workingDirectory: "/workspace/attempt" }, paths: { ...input.paths, readOnly: ["/workspace/input.txt"], temporaryDirectory: "/workspace/attempt/output" } };
		expect(validToolExecutionManifest(posix)).toBe(true);
		expect(validToolExecutionResult(result(["file:stream"]), posix)).toBe(true);
	});
});
