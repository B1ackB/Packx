import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runPackagingLifecycle } from "../server/eval/packagingLifecycle";

it("accepts six bounded packaging lifecycle cases including negative recovery paths", async () => {
	const root = mkdtempSync(join(tmpdir(), "packx-lifecycle-test-"));
	try {
		const report = await runPackagingLifecycle(root);
		expect(report.cases.map(({ name, passed, failure }) => ({ name, passed, failure }))).toEqual(expect.arrayContaining([expect.objectContaining({ name: "permission", passed: true })]));
		expect(report.passed, JSON.stringify(report.cases.filter((item) => !item.passed))).toBe(true);
		expect(report.delivered).toBe(5);
	} finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
