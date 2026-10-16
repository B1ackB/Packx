import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { installTools, testEnvironment, validateAudit, validateBrowserReport, validateTestReport, validateWorkflow } from "../scripts/ci";

const source = readFileSync(".github/workflows/pr-checks.yml", "utf8");
function changed(mutate: (workflow: ReturnType<typeof parse>) => void) {
	const workflow = parse(source); mutate(workflow); return stringify(workflow);
}

describe("CI workflow security contract", () => {
	it("accepts the reviewed workflow and real YAML structure", () => {
		expect(() => validateWorkflow(source)).not.toThrow();
		expect(() => validateWorkflow(source + "\npermissions: write-all\n")).toThrow();
	});
	it.each([
		["default write permissions", (w: ReturnType<typeof parse>) => { w.permissions = { contents: "write" }; }],
		["job write permissions", (w: ReturnType<typeof parse>) => { w.jobs.browser.permissions = { contents: "write" }; }],
		["privileged PR event", (w: ReturnType<typeof parse>) => { w.on.pull_request_target = {}; }],
		["path filtering", (w: ReturnType<typeof parse>) => { w.on.pull_request.paths = ["src/**"]; }],
		["skipped job", (w: ReturnType<typeof parse>) => { w.jobs.browser.if = "false"; }],
		["skipped Windows job", (w: ReturnType<typeof parse>) => { w.jobs["windows-local-data"].if = "false"; }],
		["simulated Windows runner", (w: ReturnType<typeof parse>) => { w.jobs["windows-local-data"]["runs-on"] = "ubuntu-24.04"; }],
		["Windows suite replaced", (w: ReturnType<typeof parse>) => { w.jobs["windows-local-data"].steps.at(-1).run = "node --import tsx scripts/ci.ts core"; }],
		["failure ignored", (w: ReturnType<typeof parse>) => { w.jobs.browser["continue-on-error"] = true; }],
		["business secret", (w: ReturnType<typeof parse>) => { w.env = { KEY: "${{ secrets.MODEL_KEY }}" }; }],
		["persisted git credential", (w: ReturnType<typeof parse>) => { w.jobs.browser.steps[0].with["persist-credentials"] = true; }],
		["mutable action tag", (w: ReturnType<typeof parse>) => { w.jobs.browser.steps[0].uses = "actions/checkout@main"; }],
		["automatic cache", (w: ReturnType<typeof parse>) => { w.jobs.browser.steps[1].with["package-manager-cache"] = true; }],
		["lifecycle scripts", (w: ReturnType<typeof parse>) => { w.jobs.browser.steps[2].run = "npm ci"; }],
		["PR input injected into shell", (w: ReturnType<typeof parse>) => { w.jobs.browser.steps[3].run = "echo ${{ github.event.pull_request.title }}"; }],
		["artifact upload", (w: ReturnType<typeof parse>) => { w.jobs.browser.steps.push({ uses: "actions/upload-artifact@v4" }); }],
		["gate missing dependency", (w: ReturnType<typeof parse>) => { w.jobs["ci-required"].needs.pop(); }],
		["gate skips failures", (w: ReturnType<typeof parse>) => { delete w.jobs["ci-required"].if; }],
		["gate always succeeds", (w: ReturnType<typeof parse>) => { w.jobs["ci-required"].steps[0].run = "true"; }],
	] as const)("rejects %s", (_label, mutate) => {
		expect(() => validateWorkflow(changed(mutate))).toThrow();
	});
	it("removes business credentials, data paths and inherited online settings from test children", () => {
		const env = testEnvironment({ PATH: "/usr/bin", HOME: "/synthetic-home", SystemRoot: "C:\\Windows", ANTHROPIC_API_KEY: "synthetic", BLACKX_EVAL_BASE_URL: "http://127.0.0.1:1234", BLACKX_DATA_ROOT: "/synthetic-data", NODE_OPTIONS: "--require=unsafe", GITHUB_TOKEN: "synthetic", NPM_TOKEN: "synthetic" });
		expect(env.HOME).toBe("/synthetic-home");
		expect(env.SystemRoot).toBe("C:\\Windows");
		expect(env.PATH).toBe(`${dirname(process.execPath)}${delimiter}/usr/bin`);
		expect(env.CI).toBe("true");
		for (const key of ["ANTHROPIC_API_KEY", "BLACKX_EVAL_BASE_URL", "BLACKX_DATA_ROOT", "NODE_OPTIONS", "GITHUB_TOKEN", "NPM_TOKEN"]) expect(env[key]).toBeUndefined();
	});
	it("executes the actual gate and rejects all failure, skip and cancellation combinations", () => {
		const gate = parse(source).jobs["ci-required"].steps[0].run;
		for (const core of ["success", "failure", "skipped", "cancelled"]) {
			for (const browser of ["success", "failure", "skipped", "cancelled"]) {
				for (const native of ["success", "failure", "skipped", "cancelled"]) {
					for (const windows of ["success", "failure", "skipped", "cancelled"]) {
						const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", gate], { env: { CORE_RESULT: core, BROWSER_RESULT: browser, NATIVE_RESULT: native, WINDOWS_RESULT: windows } });
						expect(result.status === 0).toBe([core, browser, native, windows].every((status) => status === "success"));
					}
				}
			}
		}
	});
	it("accepts Windows report paths but still refuses missing or skipped Windows evidence", () => {
		const name = "C:\\checkout\\server\\localBackup.test.ts";
		expect(() => validateTestReport({ success: true, testResults: [{ name, assertionResults: [{ status: "passed" }] }] }, ["server/localBackup.test.ts"], true)).not.toThrow();
		expect(() => validateTestReport({ success: true, testResults: [{ name, assertionResults: [{ status: "pending" }] }] }, ["server/localBackup.test.ts"], true)).toThrow();
		expect(() => validateTestReport({ success: true, testResults: [] }, ["server/localBackup.test.ts"], true)).toThrow();
	});
});

describe("CI fail-closed evidence checks", () => {
	function audit(high = 0, critical = 0) {
		return { auditReportVersion: 2, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical, total: high + critical } } };
	}
	it("accepts a complete clean audit and refuses errors or incomplete responses", () => {
		expect(validateAudit(audit(), 0).total).toBe(0);
		for (const [report, status] of [[audit(), 1], [{ error: {} }, 1], [{}, 0], [null, null], [{ auditReportVersion: 2, metadata: { vulnerabilities: {} } }, 0]] as const) expect(() => validateAudit(report, status)).toThrow();
	});
	it("blocks high/critical findings even if a report claims an exception or exits successfully", () => {
		expect(() => validateAudit(audit(1), 0)).toThrow(/blocked/);
		expect(() => validateAudit({ ...audit(0, 1), exceptions: [{ expires: "2000-01-01" }] }, 0)).toThrow(/blocked/);
	});
	it("requires actual assertions for every native suite and rejects skipped or missing suites", () => {
		const report = { success: true, testResults: [{ name: "/fixture/native.test.ts", assertionResults: [{ status: "passed" }] }] };
		expect(() => validateTestReport(report, ["native.test.ts"], true)).not.toThrow();
		expect(() => validateTestReport(report, ["missing.test.ts"], true)).toThrow(/missing/);
		for (const statuses of [[], ["pending"], ["passed", "pending"], ["passed", "failed"]]) {
			expect(() => validateTestReport({ success: true, testResults: [{ name: "/fixture/native.test.ts", assertionResults: statuses.map((status) => ({ status })) }] }, ["native.test.ts"], true)).toThrow();
		}
	});
	it("requires actual browser executions in all three viewport/language projects", () => {
		const names = ["desktop-zh", "narrow-zh", "narrow-en"];
		const report = { config: { projects: names.map((name) => ({ name })) }, stats: { expected: 3, unexpected: 0, skipped: 0, flaky: 0 }, suites: [{ specs: [{ tests: names.map((projectName) => ({ projectName, status: "expected" })) }] }] };
		expect(() => validateBrowserReport(report)).not.toThrow();
		expect(() => validateBrowserReport({ ...report, suites: [] })).toThrow(/did not execute/);
		expect(() => validateBrowserReport({ ...report, stats: { ...report.stats, skipped: 1 } })).toThrow(/skipped/);
	});
	it("does not execute a downloaded tool whose checksum differs", async () => {
		vi.stubGlobal("fetch", async () => new Response("synthetic corrupt archive"));
		try { await expect(installTools()).rejects.toThrow(/checksum mismatch/); }
		finally { vi.unstubAllGlobals(); }
	});
});
