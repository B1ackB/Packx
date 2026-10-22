import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute, installBrowser } from "../scripts/ci";

describe("hosted browser dependency installation", () => {
	beforeEach(() => {
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("RUNNER_ENVIRONMENT", "github-hosted");
		vi.stubEnv("ImageOS", "ubuntu24");
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
	it("bounds signed Ubuntu downloads without changing the runner's global sources", () => {
		let configuration = "";
		const run = vi.fn<typeof execute>((file, args, env, timeout) => {
			if (run.mock.calls.length === 1) {
				expect(file).toBe("sudo");
				expect(args.slice(0, 2)).toEqual(["-n", "env"]);
				configuration = args[2].replace(/^APT_CONFIG=/, "");
				const config = readFileSync(configuration, "utf8");
				const sources = readFileSync(join(dirname(configuration), "ubuntu.sources"), "utf8");
				expect(config).toContain('Dir::Etc::sourceparts "-";');
				expect(config).toContain('Acquire::https::Timeout "30";');
				expect(config).toContain('Acquire::Retries "2";');
				expect(config).toContain('APT::Update::Error-Mode "any";');
				expect(sources).toContain("URIs: https://archive.ubuntu.com/ubuntu");
				expect(sources).toContain("URIs: https://security.ubuntu.com/ubuntu");
				expect(sources).toContain("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg");
				expect(sources).not.toMatch(/http:|trusted:|azure\.archive/i);
				expect(args.slice(3)).toEqual([process.execPath, "node_modules/@playwright/test/cli.js", "install-deps", "chromium"]);
			} else {
				expect(file).toBe(process.execPath);
				expect(args).toEqual(["node_modules/@playwright/test/cli.js", "install", "chromium", "--only-shell"]);
			}
			expect(env).toEqual({});
			expect(timeout).toBe(5 * 60_000);
			return "installed";
		});
		installBrowser(run, "linux");
		expect(run).toHaveBeenCalledTimes(2);
		expect(existsSync(dirname(configuration))).toBe(false);
	});
	it.each([1, 2])("fails closed and removes temporary configuration when phase %i fails", (failingPhase) => {
		const failure = new Error("download ETIMEDOUT");
		let configuration = "";
		const run = vi.fn<typeof execute>((_file, args) => {
			if (run.mock.calls.length === 1) configuration = args[2].replace(/^APT_CONFIG=/, "");
			if (run.mock.calls.length === failingPhase) throw failure;
			return "installed";
		});
		let error: unknown;
		try { installBrowser(run, "linux"); } catch (cause) { error = cause; }
		expect(error).toMatchObject({ cause: failure });
		expect((error as Error).message).toContain(failingPhase === 1 ? "system dependencies" : "Chromium download");
		expect((error as Error).message).toContain("ETIMEDOUT");
		expect(run).toHaveBeenCalledTimes(failingPhase);
		expect(existsSync(dirname(configuration))).toBe(false);
	});
	it.each([
		["darwin", "true", "github-hosted"],
		["win32", "true", "github-hosted"],
		["linux", "true", "self-hosted"],
		["linux", "", "github-hosted"],
	] as const)("keeps the standard installer on %s with Actions=%s and runner=%s", (platform, actions, runner) => {
		vi.stubEnv("GITHUB_ACTIONS", actions); vi.stubEnv("RUNNER_ENVIRONMENT", runner);
		const run = vi.fn<typeof execute>(() => "installed");
		installBrowser(run, platform);
		expect(run).toHaveBeenCalledExactlyOnceWith(process.execPath, ["node_modules/@playwright/test/cli.js", "install", "chromium", "--only-shell", "--with-deps"]);
	});
	it("rejects an unreviewed hosted Linux image before installing packages", () => {
		vi.stubEnv("ImageOS", "ubuntu26");
		const run = vi.fn<typeof execute>(() => "installed");
		expect(() => installBrowser(run, "linux")).toThrow("ubuntu24");
		expect(run).not.toHaveBeenCalled();
	});
});
