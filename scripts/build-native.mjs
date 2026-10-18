import { mkdirSync, statSync, existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform === "win32") {
	const built = spawnSync(process.execPath, ["--import", "tsx", "scripts/build-windows-native.ts"], { stdio: "inherit", shell: false });
	process.exit(built.error || built.status !== 0 ? 1 : 0);
}
if (process.platform !== "darwin") {
	console.log("Native document inspection requires macOS; other platforms fail closed.");
	process.exit(0);
}
const source = resolve("native/AssetInspector.swift");
const office = resolve("native/OfficeReader.swift");
const output = resolve(".blackx-tools/asset-inspector");
mkdirSync(resolve(".blackx-tools"), { recursive: true, mode: 0o700 });
if (!existsSync(output) || Math.max(statSync(source).mtimeMs, statSync(office).mtimeMs) > statSync(output).mtimeMs) {
	const main = resolve(".blackx-tools/main.swift");
	copyFileSync(source, main);
	const result = spawnSync("/usr/bin/xcrun", ["swiftc", "-emit-executable", main, office, "-O", "-o", output, "-module-cache-path", resolve(".blackx-tools/module-cache")], { stdio: "inherit", shell: false });
	if (result.error || result.status !== 0) {
		console.error("Native parser build failed. Install Apple Command Line Tools and retry npm run build:native.");
		process.exit(1);
	}
}
console.log("Native asset inspector ready.");

const supervisorSource = resolve("native/ToolSupervisor.c");
const supervisorOutput = resolve(".blackx-tools/tool-supervisor");
if (!existsSync(supervisorOutput) || statSync(supervisorSource).mtimeMs > statSync(supervisorOutput).mtimeMs) {
	const built = spawnSync("/usr/bin/xcrun", ["clang", "-Wall", "-Wextra", "-Werror", "-O2", supervisorSource, "-o", supervisorOutput], { stdio: "inherit", shell: false });
	if (built.error || built.status !== 0) process.exit(1);
}
console.log("Native resource supervisor ready.");
