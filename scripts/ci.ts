import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { runWindowsIsolationProbe } from "./windowsIsolationProbe";

const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const setupNode = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const jobs = ["core-offline", "browser", "native-product", "windows-local-data"];
const install = "npm ci --ignore-scripts --no-audit --no-fund";
const command = (name: string) => `node --import tsx scripts/ci.ts ${name}`;
const gate = 'test "$CORE_RESULT" = success\ntest "$BROWSER_RESULT" = success\ntest "$NATIVE_RESULT" = success\ntest "$WINDOWS_RESULT" = success';
const toolsDirectory = resolve("temp/ci-tools");
const nativeFiles = ["macOsSeatbeltSandboxedToolExecutor.test.ts", "assetInspection.test.ts", "documentRead.test.ts"];
const windowsFiles = [
	"server/localDataBoundary.test.ts", "server/localBackup.test.ts", "server/localDataMigration.test.ts", "server/fileWriteLock.test.ts", "server/syncDirectory.test.ts",
	"server/enterprise/fileEventStoreRecovery.test.ts", "server/enterprise/fileStageJobQueue.test.ts", "server/enterprise/fileCronScheduleStore.test.ts",
	"src/agent/sandboxPaths.test.ts",
	"eval/windowsIsolationProbe.test.ts",
	"server/runtime/textDocumentInspection.test.ts",
	"eval/ciCommand.test.ts",
	"eval/windowsProductionBoundary.test.ts",
];

function ensure(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
function record(value: unknown): Record<string, unknown> {
	ensure(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object");
	return value as Record<string, unknown>;
}
function same(actual: unknown, expected: unknown, message: string) {
	ensure(isDeepStrictEqual(actual, expected), message);
}
function keys(value: Record<string, unknown>, allowed: string[]) {
	ensure(Object.keys(value).every((key) => allowed.includes(key)), "Unexpected configuration key");
}

export function validateWorkflow(source: string) {
	const document = parseDocument(source, { uniqueKeys: true });
	ensure(document.errors.length === 0, "Invalid workflow YAML");
	const workflow = record(document.toJS({ maxAliasCount: 0 }));
	keys(workflow, ["name", "on", "permissions", "concurrency", "jobs"]);
	same(workflow.permissions, {}, "Default permissions must be empty");
	same(workflow.on, { pull_request: { branches: ["main"] }, push: { branches: ["main"] }, workflow_dispatch: null }, "Unexpected workflow triggers or filters");
	same(workflow.concurrency, { group: "pr-checks-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}", "cancel-in-progress": true }, "Concurrency must cancel outdated runs independently");
	const configured = record(workflow.jobs);
	same(Object.keys(configured).sort(), [...jobs, "ci-required"].sort(), "Unexpected or missing job");
	const commands: Record<string, string[]> = {
		"core-offline": [install, ...["metadata", "tools", "policy", "secrets", "audit", "core"].map(command)],
		browser: [install, command("browser-install"), command("browser")],
		"native-product": [install, command("native")],
		"windows-local-data": [install, command("metadata"), command("windows-local-data")],
	};
	for (const name of jobs) {
		const job = record(configured[name]);
		keys(job, ["name", "runs-on", "timeout-minutes", "permissions", "steps"]);
		same(job.name, name, "Check names must remain stable");
		same(job["runs-on"], name === "native-product" ? "macos-15" : name === "windows-local-data" ? "windows-2025" : "ubuntu-24.04", "Unexpected runner");
		same(job["timeout-minutes"], { "core-offline": 20, browser: 15, "native-product": 25, "windows-local-data": 10 }[name], "Unexpected job timeout");
		same(job.permissions, { contents: "read" }, "Execution jobs must be read-only");
		ensure(Array.isArray(job.steps), "Missing execution steps");
		const steps = job.steps.map(record);
		same(steps.length, commands[name].length + 2, "Missing or additional execution step");
		for (const step of steps.slice(0, 2)) keys(step, ["name", "uses", "with"]);
		same(steps[0].uses, checkout, "Checkout must use the audited commit");
		same(steps[0].with, { "persist-credentials": false, ...(name === "core-offline" ? { "fetch-depth": 0 } : {}) }, "Checkout credentials/history policy changed");
		same(steps[1].uses, setupNode, "setup-node must use the audited commit");
		same(steps[1].with, { "node-version-file": ".nvmrc", "package-manager-cache": false }, "Node pinning/cache policy changed");
		for (const [index, step] of steps.slice(2).entries()) {
			keys(step, ["name", "run"]);
			same(step.run, commands[name][index], "Required command changed or unsafe step added");
		}
	}
	const required = record(configured["ci-required"]);
	keys(required, ["name", "runs-on", "timeout-minutes", "permissions", "needs", "if", "steps"]);
	same(required.name, "ci-required", "Required gate name changed");
	same(required["runs-on"], "ubuntu-24.04", "Unexpected gate runner");
	same(required["timeout-minutes"], 1, "Unexpected gate timeout");
	same(required.permissions, {}, "Gate must have no token permissions");
	same(required.needs, jobs, "Gate must depend on all execution jobs");
	same(required.if, "${{ always() }}", "Gate must inspect failed and skipped dependencies");
	ensure(Array.isArray(required.steps) && required.steps.length === 1, "Gate must contain one fixed check");
	const step = record(required.steps[0]);
	keys(step, ["name", "env", "run"]);
	same(step.env, { CORE_RESULT: "${{ needs.core-offline.result }}", BROWSER_RESULT: "${{ needs.browser.result }}", NATIVE_RESULT: "${{ needs.native-product.result }}", WINDOWS_RESULT: "${{ needs.windows-local-data.result }}" }, "Gate inputs must be dependency results only");
	same(String(step.run).trim(), gate, "Gate must reject every non-success result");
}

export function testEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const allowed = ["PATH", "HOME", "SystemRoot", "SystemDrive", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "PLAYWRIGHT_BROWSERS_PATH"];
	return { ...Object.fromEntries(allowed.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])), PATH: [dirname(process.execPath), input.PATH].filter(Boolean).join(delimiter), CI: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
}

export function execute(file: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeout = 10 * 60_000) {
	const result = spawnSync(file, args, { env: { ...testEnvironment(process.env), ...extraEnv }, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
	const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
	if (result.error || result.status !== 0) throw new Error(`Command failed: ${basename(file)} ${args.slice(0, 3).join(" ")} (status ${result.status ?? "unavailable"}${errorCode ? `, error ${errorCode}` : ""})\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-12_000)}`, { cause: result.error });
	return result.stdout;
}
function npm(args: string[], env: NodeJS.ProcessEnv = {}) {
	return process.platform === "win32"
		? execute(process.execPath, [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), ...args], env)
		: execute("npm", args, env);
}
function digest(data: string | Buffer) {
	return createHash("sha256").update(data).digest("hex");
}

export function validateAudit(report: unknown, status: number | null) {
	const value = record(report);
	ensure(!value.error && value.auditReportVersion === 2, "Dependency audit unavailable or invalid");
	const counts = record(record(value.metadata).vulnerabilities);
	for (const severity of ["info", "low", "moderate", "high", "critical", "total"]) ensure(Number.isInteger(counts[severity]) && Number(counts[severity]) >= 0, "Incomplete dependency audit");
	ensure(counts.high === 0 && counts.critical === 0, `Dependency audit blocked: high=${counts.high}, critical=${counts.critical}; no exceptions configured`);
	ensure(status === 0, "Dependency audit command failed");
	return counts;
}

type TestSuite = { name: string; assertionResults: Array<{ status: string }> };
export function validateTestReport(report: { success: boolean; testResults: TestSuite[] }, requiredFiles: string[], noSkips = false) {
	ensure(report.success === true && Array.isArray(report.testResults), "Test execution failed or report missing");
	for (const file of requiredFiles) {
		const suites = report.testResults.filter((suite) => suite.name.replaceAll("\\", "/").endsWith(`/${file}`));
		ensure(suites.length > 0, `Required suite missing: ${file}`);
		const assertions = suites.flatMap((suite) => suite.assertionResults);
		ensure(assertions.some((item) => item.status === "passed"), `Required suite did not execute: ${file}`);
		if (noSkips) ensure(assertions.every((item) => item.status === "passed"), `Required suite failed or skipped: ${file}`);
	}
}

type BrowserSuite = { specs?: Array<{ tests: Array<{ projectName: string; status: string }> }>; suites?: BrowserSuite[] };
export function validateBrowserReport(report: { config: { projects: Array<{ name: string }> }; stats: { expected: number; unexpected: number; skipped: number; flaky: number }; suites: BrowserSuite[] }) {
	const projects = ["desktop-zh", "narrow-zh", "narrow-en"];
	same(report.config.projects.map((item) => item.name).sort(), projects.sort(), "Browser project coverage changed");
	const collect = (suites: BrowserSuite[]): Array<{ projectName: string; status: string }> => suites.flatMap((suite) => [...(suite.specs ?? []).flatMap((spec) => spec.tests), ...collect(suite.suites ?? [])]);
	const tests = collect(report.suites);
	for (const project of projects) ensure(tests.some((test) => test.projectName === project && test.status === "expected"), `Browser project did not execute: ${project}`);
	ensure(report.stats.expected > 0 && report.stats.unexpected === 0 && report.stats.skipped === 0 && report.stats.flaky === 0, "Browser tests missing, failed, skipped or flaky");
}

export async function installTools() {
	const manifest = JSON.parse(readFileSync(".github/ci-tools.json", "utf8"));
	for (const name of ["actionlint", "gitleaks"]) {
		const tool = manifest[name], asset = tool.assets[`${process.platform}-${process.arch}`];
		ensure(asset && /^[a-f0-9]{64}$/.test(asset.sha256), "Unsupported tool platform or missing checksum");
		ensure(tool.repository === { actionlint: "rhysd/actionlint", gitleaks: "gitleaks/gitleaks" }[name], "Unapproved tool repository");
		ensure(/^\d+\.\d+\.\d+$/.test(tool.version) && /^[a-z0-9_.]+\.tar\.gz$/.test(asset.file), "Invalid tool release pin");
		const response = await fetch(`https://github.com/${tool.repository}/releases/download/v${tool.version}/${asset.file}`, { signal: AbortSignal.timeout(120_000) });
		ensure(response.ok, `Tool download failed: ${name}`);
		const archive = Buffer.from(await response.arrayBuffer());
		ensure(digest(archive) === asset.sha256, `Tool checksum mismatch: ${name}`);
		const directory = join(toolsDirectory, name);
		mkdirSync(directory, { recursive: true });
		const archivePath = join(directory, "download.tar.gz");
		writeFileSync(archivePath, archive, { mode: 0o600 });
		try {
			for (const entry of [name, name === "actionlint" ? "LICENSE.txt" : "LICENSE"]) {
				const extracted = spawnSync("tar", ["-xOf", archivePath, entry], { maxBuffer: 64 * 1024 * 1024 });
				ensure(!extracted.error && extracted.status === 0 && extracted.stdout.length > 0, `Missing tool or license: ${name}`);
				writeFileSync(join(directory, entry), extracted.stdout, { mode: 0o600 });
			}
			chmodSync(join(directory, name), 0o700);
		} finally { rmSync(archivePath, { force: true }); }
		console.log(`${name} ${tool.version}: checksum verified; license retained`);
	}
}

function policy() {
	same(readdirSync(".github/workflows").sort(), ["pr-checks.yml"], "Additional workflows require security review");
	validateWorkflow(readFileSync(".github/workflows/pr-checks.yml", "utf8"));
	ensure(readFileSync(".nvmrc", "utf8").trim() === "24.14.0", "Node version change requires CI review");
	const files = execute("git", ["ls-files", "-z"]).split("\0").filter(Boolean);
	for (const path of files) {
		ensure(!/(^|\/)(\.blackx-data|\.blackx-tools|\.packx-settings\.json[^/]*|releases|node_modules)(\/|$)/.test(path), "Forbidden tracked data/configuration directory");
		ensure(!/(^|\/)\.env(?:\..*)?$/.test(path) || path === ".env.example", "Forbidden tracked environment file");
		ensure(!lstatSync(path).isSymbolicLink(), "Tracked symbolic links require data-boundary review");
	}
	execute(join(toolsDirectory, "actionlint/actionlint"), ["-shellcheck=", "-pyflakes=", ".github/workflows/pr-checks.yml"]);
	console.log("Workflow syntax, permissions, execution steps and tracked path policy passed");
}

function secrets() {
	const directory = mkdtempSync(join(tmpdir(), "packx-ci-secrets-"));
	const binary = join(toolsDirectory, "gitleaks/gitleaks");
	const config = resolve(".github/gitleaks.toml");
	try {
		const fixtures = join(directory, "fixtures/docs/evidence"); mkdirSync(fixtures, { recursive: true });
		const fixturePath = join(fixtures, "scanner.json");
		const fake = "ghp_" + digest("Packx non-credential scanner regression").slice(0, 36);
		writeFileSync(fixturePath, JSON.stringify({ "server/runtime/conversationApi.ts": digest("synthetic source") }, null, "\t"));
		const fixtureArgs = ["dir", join(directory, "fixtures"), "--config", config, "--redact=100", "--no-banner", "--gitleaks-ignore-path", "/dev/null", "--ignore-gitleaks-allow"];
		const clean = spawnSync(binary, fixtureArgs, { env: testEnvironment(process.env), encoding: "utf8" });
		ensure(!clean.error && clean.status === 0, "Scanner regression: content digest must remain acceptable");
		for (const synthetic of [fake, digest("Packx non-credential generic scanner regression")]) {
			writeFileSync(fixturePath, `API_KEY="${synthetic}" # gitleaks:allow\n`);
			const denied = spawnSync(binary, fixtureArgs, { env: testEnvironment(process.env), encoding: "utf8" });
			ensure(!denied.error && denied.status === 1 && !`${denied.stdout}${denied.stderr}`.includes(synthetic), "Scanner regression: credential-like value must be rejected and redacted");
		}
		console.log("Secret scanner negative control: rejected synthetic credential without disclosure; digest allowance remains narrow");
		const snapshot = join(directory, "tracked"); mkdirSync(snapshot);
		for (const path of execute("git", ["ls-files", "-z"]).split("\0").filter(Boolean)) {
			ensure(!lstatSync(path).isSymbolicLink(), "Secret snapshot rejects symbolic links");
			mkdirSync(dirname(join(snapshot, path)), { recursive: true }); copyFileSync(path, join(snapshot, path));
		}
		for (const mode of ["dir", "git"]) {
			const reportPath = join(directory, `${mode}.json`);
			const result = spawnSync(binary, [mode, mode === "dir" ? snapshot : ".", "--config", config, "--redact=100", "--no-banner", "--exit-code=42", "--report-format=json", "--report-path", reportPath, "--gitleaks-ignore-path", "/dev/null", "--ignore-gitleaks-allow", "--max-archive-depth=2", "--max-decode-depth=2", ...(mode === "git" ? ["--log-opts=--all --full-history"] : [])], { env: testEnvironment(process.env), encoding: "utf8", timeout: 5 * 60_000, maxBuffer: 32 * 1024 * 1024 });
			// Raw scanner output is never forwarded, even on failure.
			const findings = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;
			ensure(!result.error && (result.status === 0 || result.status === 42) && Array.isArray(findings), "Secret scanner failed; raw diagnostics withheld");
			if (findings.length) {
				console.error(JSON.stringify({ scan: mode, total: findings.length, findings: findings.slice(0, 20).map((item) => ({ rule: item.RuleID, file: item.File.replace(snapshot + "/", ""), line: item.StartLine })) }));
				throw new Error("Secret scan blocked; inspect only the redacted rule/path locations");
			}
			ensure(result.status === 0, "Secret scanner failed");
			console.log(`Secret scan ${mode}: no findings`);
		}
	} finally { rmSync(directory, { recursive: true, force: true }); }
}

function audit() {
	const result = spawnSync("npm", ["audit", "--json", "--audit-level=high", "--registry=https://registry.npmjs.org"], { env: testEnvironment(process.env), encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
	ensure(!result.error, "Dependency audit infrastructure failure");
	let report: unknown;
	try { report = JSON.parse(result.stdout); } catch { throw new Error("Dependency audit returned invalid JSON"); }
	console.log(JSON.stringify({ audit: validateAudit(report, result.status) }));
}

function testSuite(native: boolean) {
	const report = resolve(`temp/ci-${native ? "native" : "core"}.json`);
	mkdirSync(dirname(report), { recursive: true }); rmSync(report, { force: true });
	const output = npm(["run", native ? "test:native" : "test", "--", "--reporter=default", "--reporter=json", `--outputFile=${report}`]);
	const required = native ? nativeFiles : ["runtime/runtime.contract.test.ts", "runtime/executionRecovery.test.ts", "runtime/fileContextPermissions.test.ts", "eval/packagingLifecycle.test.ts", "enterprise/enterpriseEventStore.contract.test.ts", "enterprise/personalMemory.test.ts"];
	const parsed = JSON.parse(readFileSync(report, "utf8"));
	validateTestReport(parsed, required, native);
	console.log(output.slice(-3000));
	console.log(JSON.stringify({ suite: native ? "native" : "core", total: parsed.numTotalTests, passed: parsed.numPassedTests, pending: parsed.numPendingTests }));
}

async function main(task: string) {
	ensure(process.version === `v${readFileSync(".nvmrc", "utf8").trim()}`, "Use the exact Node version in .nvmrc");
	switch (task) {
		case "tools": await installTools(); break;
		case "policy": policy(); break;
		case "secrets": secrets(); break;
		case "audit": audit(); break;
		case "core":
			testSuite(false); console.log(npm(["run", "build"]));
			for (const name of ["offline", "context", "recovery", "loop-safety", "memory", "m1", "m2", "plan", "packaging-lifecycle"]) { npm(["run", `eval:${name}`]); console.log(`Offline evaluation ${name}: passed`); }
			break;
		case "native":
			ensure(process.platform === "darwin", "Native verification requires macOS; refusing to skip");
			console.log(execute("xcrun", ["--version"])); console.log(npm(["run", "build"])); console.log(npm(["run", "build:native"]));
			testSuite(true); console.log(npm(["run", "eval:product"])); break;
		case "windows-local-data": {
			ensure(process.platform === "win32", "Windows local-data verification requires Windows; refusing to simulate");
			const report = resolve("temp/ci-windows-local-data.json"); mkdirSync(dirname(report), { recursive: true }); rmSync(report, { force: true });
			console.log(execute(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...windowsFiles, "--reporter=default", "--reporter=json", `--outputFile=${report}`]));
			const parsed = JSON.parse(readFileSync(report, "utf8"));
			validateTestReport(parsed, windowsFiles, true);
			console.log(JSON.stringify({ suite: "windows-local-data", total: parsed.numTotalTests, passed: parsed.numPassedTests, pending: parsed.numPendingTests }));
			console.log(runWindowsIsolationProbe(testEnvironment(process.env)));
			break;
		}
		case "browser-install": console.log(execute(process.execPath, ["node_modules/@playwright/test/cli.js", "install", "chromium", "--only-shell", "--with-deps"])); break;
		case "browser": {
			const report = resolve("temp/ci-browser.json"); mkdirSync(dirname(report), { recursive: true }); rmSync(report, { force: true });
			console.log(npm(["run", "test:browser", "--", "--reporter=list,json"], { PLAYWRIGHT_JSON_OUTPUT_FILE: report }));
			const value = JSON.parse(readFileSync(report, "utf8"));
			validateBrowserReport(value);
			console.log(JSON.stringify({ browser: value.stats })); break;
		}
		case "metadata": {
			const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
			console.log(JSON.stringify({ node: process.version, npm: npm(["--version"]).trim(), platform: process.platform, arch: process.arch, image: process.env.ImageOS, imageVersion: process.env.ImageVersion, checkout: execute("git", ["rev-parse", "HEAD"]).trim(), head: event.pull_request?.head?.sha, base: event.pull_request?.base?.sha, workflowSha256: digest(readFileSync(".github/workflows/pr-checks.yml")), lockSha256: digest(readFileSync("package-lock.json")) })); break;
		}
		default: throw new Error("Expected tools, policy, secrets, audit, core, native, windows-local-data, browser-install, browser or metadata");
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv[2]).catch((error) => { console.error(error instanceof Error ? error.message : "CI failed"); process.exitCode = 1; });
}
