import { copyFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { runWindowsIsolationProbe } from "./windowsIsolationProbe";
import { testEnvironment } from "./ci";

// Existing pinned local toolchain only. Installs no SDK, changes no system configuration.
if (process.platform !== "win32") throw new Error("Windows is required");
console.log(await runWindowsIsolationProbe(testEnvironment(process.env), async (build) => {
	const destination = resolve(".blackx-tools"); mkdirSync(destination, { recursive: true });
	for (const name of ["text-inspector.exe", "text-inspector-worker.exe"]) copyFileSync(join(build, name), join(destination, name));
}));
console.log("Fixed Windows UTF-8 inspector built and isolation gates verified; PDF/Office and general commands are unsupported.");
