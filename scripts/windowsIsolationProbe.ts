import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runWindowsBuildJob } from "./windowsBuildJob";

function experimentReport(value: unknown) {
	const reject = (message: string): never => { throw new Error(`Invalid Windows isolation experiment: ${message}`); };
	if (!value || typeof value !== "object" || Array.isArray(value)) reject("missing report");
	const report = value as Record<string, unknown>;
	if (!["windows-isolation-experiment.v2", "windows-isolation-experiment.v3"].includes(String(report.schemaVersion)) || report.experimentOnly !== true || report.productionAdapterEnabled !== false || (report.mode !== "diagnostic" && report.mode !== "strict")) reject("experiment boundary changed");
	for (const key of ["privateHandleNotInherited", "singleProcessJobRestricted", "legalHostSingleProcessDenied", "legalHostJobTreeTerminated", "lpacProcessTerminated", "profileDeleted"]) {
		if (report[key] !== true) reject(`required evidence missing: ${key}`);
	}
	const control = report.unsandboxedNetworkControl as Record<string, unknown> | undefined;
	if (!control || control.initializationError !== 0 || control.socketError !== 0 || control.connectionError !== 0 || control.catalogAccessError !== 0 || control.observation !== "connected" || report.regularNetworkInitializationError !== 0) reject("positive network control failed");
	return { report, reject };
}

function networkDenialStage(report: Record<string, unknown>) {
	if (report.networkInitializationError !== 0 || report.networkAccessDenied !== true) return undefined;
	if (report.networkObservation === "access_denied" && report.networkSocketError === 0 && report.networkConnectionError === 10013) return "connect";
	if (report.networkObservation === "socket_access_denied" && report.networkSocketError === 10013 && report.networkConnectionError === -1) return "socket";
	return undefined;
}

export function assessWindowsIsolationReport(value: unknown) {
	const { report, reject } = experimentReport(value);
	if (report.schemaVersion !== "windows-isolation-experiment.v2" || report.capabilityPolicy !== "zero-capabilities" || !Array.isArray(report.capabilities) || report.capabilities.length !== 0) reject("zero-capability baseline changed");
	const denialStage = networkDenialStage(report);
	const networkGate = denialStage && report.childAssertions === 14 ? "verified" as const
		: report.networkObservation === "initialization_failed" && report.networkInitializationError === 10107 && report.networkSocketError === -1 && report.networkConnectionError === -1 && report.catalogAccessError === 5 && report.networkAccessDenied === false && report.childAssertions === 13 ? "blocked" as const
		: reject("network denial was not verified or its initialization failure was not characterized");
	// This is a CI experiment, with no registered production executor. A diagnostic pass cannot enable one.
	return { schemaVersion: "windows-isolation-assessment.v1" as const, experimentValidated: true as const, productionAdapterEnabled: false as const,
		mode: report.mode as "diagnostic" | "strict", networkGate, denialStage: denialStage ?? null, passedChildAssertions: report.childAssertions as number, requiredChildAssertions: 14 as const };
}

export function assessRegistryReadCandidate(value: unknown) {
	const { report, reject } = experimentReport(value);
	if (report.schemaVersion !== "windows-isolation-experiment.v3" || report.mode !== "strict" || report.capabilityPolicy !== "registry-read-only" || JSON.stringify(report.capabilities) !== '["registryRead"]') reject("unexpected candidate capabilities");
	for (const key of ["privateRegistryReadDenied", "privateRegistryWriteDenied", "privateRegistryDeleted"]) if (report[key] !== true) reject(`private registry boundary missing: ${key}`);
	const scope = report.registryScope as Record<string, unknown> | undefined;
	if (!scope || scope.assertions !== 7 || JSON.stringify(scope.systemReadCategories) !== '["winsock-catalog-metadata"]' || scope.realUserSecretsAccessed !== false) reject("registry resource scope missing");
	for (const key of ["credentialFixtureReadDenied", "credentialFixtureWriteDenied", "modelSettingsFixtureReadDenied", "modelSettingsFixtureWriteDenied", "capabilityGrantedUserFixtureReadable", "capabilityGrantedUserFixtureWriteDenied"]) if (scope![key] !== true) reject(`registry resource boundary missing: ${key}`);
	const denialStage = networkDenialStage(report);
	if (report.childAssertions !== 16 || !denialStage) reject("candidate did not verify network denial");
	return { schemaVersion: "windows-registry-read-feasibility.v1", networkGate: "verified", denialStage, passedChildAssertions: 16, registryScopeAssertions: 7, productionAdapterEnabled: false };
}

/** Fixed CI experiment, never a production Tool executor. No scripts or system features are installed. */
export async function runWindowsIsolationProbe(environment: NodeJS.ProcessEnv, verifyText?: (build: string) => Promise<void>): Promise<string> {
	if (process.platform !== "win32") throw new Error("Windows isolation probe requires Windows");
	const root = resolve(".");
	// The compiler batch accepts only the known hosted checkout path, never document/model input.
	if (!/^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/.test(root)) throw new Error("Unsupported CI checkout path for native probe");
	const policy = JSON.parse(readFileSync(".github/windows-isolation-toolchain.json", "utf8"));
	if (policy.purpose !== "diagnostic_only" || policy.productionAdapterEnabled !== false) throw new Error("Diagnostic toolchain manifest boundary changed");
	const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
	const discovery = { encoding: "utf8" as const, timeout: 10_000, env: environment };
	const discover = (phase: string, args: string[]) => {
		const start = Date.now(); console.error(`windows_toolchain:${phase}:started; budget_ms=10000`);
		try { const output = execFileSync(vswhere, args, discovery); console.error(`windows_toolchain:${phase}:completed; elapsed_ms=${Date.now() - start}`); return output; }
		catch (cause) { throw new Error(`Windows toolchain discovery failed at ${phase}: ${(cause as NodeJS.ErrnoException).code ?? "exit_failed"}`, { cause }); }
	};
	const help = discover("version", ["-?"]).split(/\r?\n/)[0];
	if (!help.startsWith(`Visual Studio Locator version ${policy.vswhereVersion}+`)) throw new Error("Pinned vswhere is unavailable; refusing to skip");
	const select = ["-products", "*", "-version", policy.visualStudioRange, "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"];
	const installation = discover("installation_path", [...select, "-property", "installationPath"]).trim();
	const version = discover("installation_version", [...select, "-property", "installationVersion"]).trim();
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
		writeFileSync(batch, `@echo off\r\ncall "${installation}\\VC\\Auxiliary\\Build\\vcvars64.bat" ${policy.windowsSdkVersion}\r\nif errorlevel 1 exit /b 1\r\ncl ${compilerFlags} "${join(root, "native/testing/WindowsIsolationProbe.cpp")}" /Fe:"${binary}" /link userenv.lib advapi32.lib ws2_32.lib ole32.lib OneCoreUAP.lib\r\nif errorlevel 1 exit /b 1\r\ncl ${compilerFlags} "${join(root, "native/testing/WindowsIsolationWorker.cpp")}" /Fe:"${worker}" /link advapi32.lib ws2_32.lib\r\n`);
		writeFileSync(batch, readFileSync(batch, "utf8") + [
			["native/windows/TextInspector.cpp", "text-inspector.exe", "userenv.lib advapi32.lib ole32.lib OneCoreUAP.lib"],
			["native/windows/TextInspectorWorker.cpp", "text-inspector-worker.exe", "advapi32.lib ws2_32.lib OneCoreUAP.lib"],
			["native/testing/WindowsTextFaultWorker.cpp", "text-fault-worker.exe", ""],
		].map(([source, output, libraries]) => `if errorlevel 1 exit /b 1\r\ncl ${compilerFlags} "${join(root, source!)}" /Fe:"${join(build, output!)}" /link ${libraries}\r\n`).join(""));
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
		const candidateAttempt = join(scratch, "registry-attempt"), candidateProfile = `Packx.Probe.${randomUUID().replaceAll("-", "")}`; mkdirSync(candidateAttempt);
		const candidateOutput = execFileSync(binary, ["--registry-read", candidateAttempt, candidateProfile, worker], options);
		const candidateAssessment = assessRegistryReadCandidate(JSON.parse(candidateOutput));
		if (verifyText) await verifyText(build);
		return `${JSON.stringify({ visualStudio: version, windowsSdk: policy.windowsSdkVersion, profileId: profile, strictProfileId: strictProfile, build: compiler.report })}\n${compiler.stdout}${compiler.stderr}\n${output}\n${candidateOutput}\n${JSON.stringify({ assessment, strictAssessment, strictExitCode: strict.status, candidateAssessment })}`;
	} catch (cause) {
		failed = true;
		const diagnostic = cause as { message?: string; stdout?: string; stderr?: string };
		throw new Error(`Fixed isolation probe failed; requested test profile ${profile}; Windows support remains unverified\n${[diagnostic.message, diagnostic.stdout, diagnostic.stderr].filter(Boolean).join("\n").slice(-12000)}`, { cause });
	} finally {
		try { rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
		catch (cause) {
			const cleanup = new Error(`Fixed probe scratch cleanup failed: ${(cause as Error).message}`, { cause });
			if (!failed) throw cleanup;
			console.error(cleanup.message); // Preserve the original compile/probe failure; cleanup failure never passes the gate.
		}
	}
}
