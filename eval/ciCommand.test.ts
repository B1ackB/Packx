import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "../scripts/ci";

describe("CI command failure diagnostics", () => {
	let root: string;
	beforeEach(() => { root = mkdtempSync(join(tmpdir(), "packx-ci-command-")); });
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	it("retains the spawn error when an executable is missing and output is absent", () => {
		let error: unknown;
		try { execute(join(root, "missing-program"), []); } catch (cause) { error = cause; }
		expect(error).toMatchObject({ cause: { code: "ENOENT" } });
		expect((error as Error).message).toMatch(/Command failed: missing-program.*status unavailable.*error ENOENT/);
	});
	it("keeps exit status and the bounded diagnostic tail", () => {
		const fixture = join(root, "failure.mjs");
		writeFileSync(fixture, 'import { writeSync } from "node:fs"; writeSync(1, "OUTPUT_START" + "x".repeat(20000) + "OUTPUT_END"); writeSync(2, "failure-detail"); process.exitCode = 7;');
		let message = "";
		try { execute(process.execPath, [fixture]); } catch (error) { message = (error as Error).message; }
		expect(message).toContain("status 7"); expect(message).toContain("OUTPUT_ENDfailure-detail");
		expect(message).not.toContain("OUTPUT_START"); expect(message.length).toBeLessThan(12_500);
	});
	it("preserves a timeout reason when exit status is unavailable", () => {
		const fixture = join(root, "timeout.mjs"); writeFileSync(fixture, "setInterval(() => {}, 1000);");
		let error: unknown;
		try { execute(process.execPath, [fixture], {}, 40); } catch (cause) { error = cause; }
		expect(error).toMatchObject({ cause: { code: "ETIMEDOUT" } });
		expect((error as Error).message).toMatch(/Command failed: .*error ETIMEDOUT/);
	});
});
