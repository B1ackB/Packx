import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelSettings } from "../modelSettings";
import { safeRuntimeDiagnostic } from "./runtimeDiagnostic";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("runtime diagnostics", () => {
	it("redacts configured secrets from the whole error chain", () => {
		const key = "sk-ant-env-secret-0123456789";
		const error = new Error(`upstream rejected ${key}`, { cause: new TypeError(`header carried ${key}`) });

		const diagnostic = safeRuntimeDiagnostic(error, { ANTHROPIC_API_KEY: key });

		expect(diagnostic).not.toContain(key);
		expect(diagnostic).toContain("[REDACTED]");
	});

	it("redacts key-shaped and bearer values even when they are not in the environment", () => {
		const diagnostic = safeRuntimeDiagnostic(new Error("bad credential sk-ant-unknown-98765432 and Bearer abc.def.ghi"), {});

		expect(diagnostic).not.toContain("sk-ant-unknown-98765432");
		expect(diagnostic).not.toContain("abc.def.ghi");
	});

	it("redacts a key saved in Packx settings once it is applied to the runtime environment", () => {
		const directory = mkdtempSync(join(tmpdir(), "packx-diagnostic-"));
		directories.push(directory);
		const key = "sk-ant-saved-0123456789abcdef";
		const path = join(directory, "settings.json");
		new ModelSettings(path, {}).save({
			revision: 0, mode: "anthropic", baseUrl: "https://api.example.test/anthropic", model: "claude-test", apiKey: key,
		}, "local-user");
		const environment: NodeJS.ProcessEnv = {};
		new ModelSettings(path, environment).apply(environment);

		const diagnostic = safeRuntimeDiagnostic(new Error(`provider echoed ${key}`), environment);

		expect(environment.ANTHROPIC_API_KEY).toBe(key);
		expect(diagnostic).not.toContain(key);
	});
});
