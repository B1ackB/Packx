import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPackagingLifecycle } from "../server/eval/packagingLifecycle";

const root = mkdtempSync(join(tmpdir(), "packx-lifecycle-"));
try {
	const report = await runPackagingLifecycle(root);
	const output = JSON.stringify(report, null, 2) + "\n";
	if (process.argv[2]) writeFileSync(process.argv[2], output);
	console.log(output);
	if (!report.passed) process.exitCode = 1;
} finally { rmSync(root, { recursive: true, force: true }); }
