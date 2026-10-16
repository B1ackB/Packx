import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Fixed CI experiment, never a production Tool executor. No scripts or system features are installed. */
export function runWindowsIsolationProbe(environment: NodeJS.ProcessEnv): string {
	if (process.platform !== "win32") throw new Error("Windows isolation probe requires Windows");
	const root = resolve(".");
	// The compiler batch accepts only the known hosted checkout path, never document/model input.
	if (!/^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/.test(root)) throw new Error("Unsupported CI checkout path for native probe");
	const policy = JSON.parse(readFileSync(".github/windows-isolation-toolchain.json", "utf8"));
	const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
	const discovery = { encoding: "utf8" as const, timeout: 10_000, env: environment };
	const help = execFileSync(vswhere, ["-?"], discovery).split(/\r?\n/)[0];
	if (!help.startsWith(`Visual Studio Locator version ${policy.vswhereVersion}+`)) throw new Error("Pinned vswhere is unavailable; refusing to skip");
	const select = ["-products", "*", "-version", policy.visualStudioRange, "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"];
	const installation = execFileSync(vswhere, [...select, "-property", "installationPath"], discovery).trim();
	const version = execFileSync(vswhere, [...select, "-property", "installationVersion"], discovery).trim();
	if (!installation || version !== policy.visualStudioVersion) throw new Error("Pinned MSVC installation is unavailable; refusing to skip");
	mkdirSync("temp", { recursive: true });
	const scratch = mkdtempSync(resolve("temp/windows-isolation-"));
	const build = join(scratch, "build"), attempt = join(scratch, "attempt");
	const profile = `Packx.Probe.${randomUUID().replaceAll("-", "")}`;
	let failed = false;
	try {
		mkdirSync(build); mkdirSync(attempt);
		const binary = join(build, "isolation-probe.exe"), batch = join(build, "compile.cmd");
		const worker = join(build, "isolation-worker.exe");
		const compilerFlags = "/nologo /std:c++20 /W4 /WX /MT /EHsc /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00";
		writeFileSync(batch, `@echo off\r\ncall "${installation}\\VC\\Auxiliary\\Build\\vcvars64.bat" ${policy.windowsSdkVersion}\r\nif errorlevel 1 exit /b 1\r\ncl ${compilerFlags} "${join(root, "native/testing/WindowsIsolationProbe.cpp")}" /Fe:"${binary}" /link userenv.lib advapi32.lib ws2_32.lib ole32.lib\r\nif errorlevel 1 exit /b 1\r\ncl ${compilerFlags} "${join(root, "native/testing/WindowsIsolationWorker.cpp")}" /Fe:"${worker}"\r\n`);
		const options = { encoding: "utf8" as const, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: environment };
		const compiler = execFileSync(join(environment.SystemRoot ?? "C:\\Windows", "System32/cmd.exe"), ["/d", "/s", "/c", batch], { ...options, cwd: build });
		console.error("fixed_probe:compile_completed; starting_native_probe");
		const output = execFileSync(binary, ["--probe", attempt, profile, worker], options);
		const report = JSON.parse(output);
		if (report.childAssertions !== 14 || report.privateHandleNotInherited !== true || report.networkAccessDenied !== true || report.networkInitializationError !== 0 || report.singleProcessJobRestricted !== true || report.legalHostSingleProcessDenied !== true || report.legalHostJobTreeTerminated !== true || report.lpacProcessTerminated !== true || report.profileDeleted !== true) throw new Error("Native isolation evidence is incomplete");
		return `${JSON.stringify({ visualStudio: version, windowsSdk: policy.windowsSdkVersion, profileId: profile })}\n${compiler}\n${output}`;
	} catch (cause) {
		failed = true;
		const diagnostic = cause as { message?: string; stdout?: string; stderr?: string };
		throw new Error(`Fixed isolation probe failed; requested test profile ${profile}; no production tool was enabled\n${[diagnostic.message, diagnostic.stdout, diagnostic.stderr].filter(Boolean).join("\n").slice(-12000)}`, { cause });
	} finally {
		try { rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
		catch (cause) {
			const cleanup = new Error(`Fixed probe scratch cleanup failed: ${(cause as Error).message}`, { cause });
			if (!failed) throw cleanup;
			console.error(cleanup.message); // Preserve the original compile/probe failure; cleanup failure never passes the gate.
		}
	}
}
