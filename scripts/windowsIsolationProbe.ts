import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runWindowsBuildJob } from "./windowsBuildJob";

export function assessWindowsIsolationReport(value: unknown) {
	const reject = (message: string): never => { throw new Error(`Invalid Windows isolation experiment: ${message}`); };
	if (!value || typeof value !== "object" || Array.isArray(value)) reject("missing report");
	const report = value as Record<string, unknown>;
	if (report.schemaVersion !== "windows-isolation-experiment.v1" || report.experimentOnly !== true || report.productionAdapterEnabled !== false || (report.mode !== "diagnostic" && report.mode !== "strict")) reject("experiment boundary changed");
	for (const key of ["privateHandleNotInherited", "singleProcessJobRestricted", "legalHostSingleProcessDenied", "legalHostJobTreeTerminated", "lpacProcessTerminated", "profileDeleted"]) {
		if (report[key] !== true) reject(`required evidence missing: ${key}`);
	}
	const control = report.unsandboxedNetworkControl as Record<string, unknown> | undefined;
	if (!control || control.initializationError !== 0 || control.connectionError !== 0 || control.catalogAccessError !== 0 || control.observation !== "connected" || report.regularNetworkInitializationError !== 0) reject("positive network control failed");
	const networkGate = report.networkObservation === "access_denied" && report.networkInitializationError === 0 && report.networkConnectionError === 10013 && report.networkAccessDenied === true && report.childAssertions === 14 ? "verified" as const
		: report.networkObservation === "initialization_failed" && report.networkInitializationError === 10107 && report.networkConnectionError === -1 && report.catalogAccessError === 5 && report.networkAccessDenied === false && report.childAssertions === 13 ? "blocked" as const
		: reject("network denial was not verified or its initialization failure was not characterized");
	// This is a CI experiment, with no registered production executor. A diagnostic pass cannot enable one.
	return { schemaVersion: "windows-isolation-assessment.v1" as const, experimentValidated: true as const, productionAdapterEnabled: false as const,
		mode: report.mode as "diagnostic" | "strict", networkGate, passedChildAssertions: report.childAssertions as number, requiredChildAssertions: 14 as const };
}

/** Fixed CI experiment, never a production Tool executor. No scripts or system features are installed. */
export async function runWindowsIsolationProbe(environment: NodeJS.ProcessEnv): Promise<string> {
	if (process.platform !== "win32") throw new Error("Windows isolation probe requires Windows");
	const root = resolve(".");
	// The compiler batch accepts only the known hosted checkout path, never document/model input.
	if (!/^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/.test(root)) throw new Error("Unsupported CI checkout path for native probe");
	const policy = JSON.parse(readFileSync(".github/windows-isolation-toolchain.json", "utf8"));
	if (policy.purpose !== "diagnostic_only" || policy.productionAdapterEnabled !== false) throw new Error("Windows production adapter must remain disabled");
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
		writeFileSync(batch, `@echo off\r\ncall "${installation}\\VC\\Auxiliary\\Build\\vcvars64.bat" ${policy.windowsSdkVersion}\r\nif errorlevel 1 exit /b 1\r\ncl ${compilerFlags} "${join(root, "native/testing/WindowsIsolationProbe.cpp")}" /Fe:"${binary}" /link userenv.lib advapi32.lib ws2_32.lib ole32.lib\r\nif errorlevel 1 exit /b 1\r\ncl ${compilerFlags} "${join(root, "native/testing/WindowsIsolationWorker.cpp")}" /Fe:"${worker}" /link advapi32.lib ws2_32.lib\r\n`);
		const options = { encoding: "utf8" as const, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: environment };
		const compiler = await runWindowsBuildJob(join(environment.SystemRoot ?? "C:\\Windows", "System32/cmd.exe"), ["/d", "/s", "/c", batch], build, environment);
		console.error("fixed_probe:compile_completed; starting_native_probe");
		const output = execFileSync(binary, ["--diagnose", attempt, profile, worker], options);
		const assessment = assessWindowsIsolationReport(JSON.parse(output));
		if (assessment.mode !== "diagnostic") throw new Error("Diagnostic probe did not run");
		// Independently exercise the strict gate with fresh private resources. An unavailable network must still reject.
		const strictAttempt = join(scratch, "strict-attempt"), strictProfile = `Packx.Probe.${randomUUID().replaceAll("-", "")}`;
		mkdirSync(strictAttempt);
		console.error(`fixed_probe:strict_network_gate_attempt; profile=${strictProfile}`);
		const strict = spawnSync(binary, ["--probe", strictAttempt, strictProfile, worker], options);
		if (strict.error || ![0, 1].includes(strict.status ?? -1)) throw new Error(`Strict probe infrastructure failure: ${strict.error?.message ?? strict.status}\n${strict.stderr ?? ""}`);
		const strictAssessment = assessWindowsIsolationReport(JSON.parse(strict.stdout));
		if (strictAssessment.mode !== "strict" || strictAssessment.networkGate !== assessment.networkGate || strict.status !== (assessment.networkGate === "blocked" ? 1 : 0)) throw new Error("Strict probe no longer enforces the network gate");
		return `${JSON.stringify({ visualStudio: version, windowsSdk: policy.windowsSdkVersion, profileId: profile, strictProfileId: strictProfile, build: compiler.report })}\n${compiler.stdout}${compiler.stderr}\n${output}\n${JSON.stringify({ assessment, strictAssessment, strictExitCode: strict.status })}`;
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
