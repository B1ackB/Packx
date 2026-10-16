import { ModelSettings } from "../server/modelSettings";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { configureLocalData, within } from "../server/localData";
import { documentCapabilities } from "../server/runtime/documentCapabilities";

let failures = 0;
function report(ok: boolean, label: string, action: string) {
	console.log(`${ok ? "OK" : "ACTION"} · ${label}${ok ? "" : ` — ${action}`}`);
	if (!ok) failures++;
}
const [major, minor] = process.versions.node.split(".").map(Number);
report(major === 24 && minor >= 14, "Node 24.14+", "Use the Node version recorded in .nvmrc.");
const documents = documentCapabilities();
report(documents.scope !== "unavailable", "Native document platform", "Use a supported macOS build or the limited Windows UTF-8 package.");
console.log(`INFO · Document scope: ${documents.scope}; isolation is checked per execution, not proven by component presence.`);
report(existsSync("node_modules/tsx"), "Workspace dependencies", "Run npm ci.");
if (process.platform === "darwin" && !existsSync("packx-release.json")) report(spawnSync("/usr/bin/xcrun", ["--find", "swiftc"], { encoding: "utf8", timeout: 10_000 }).status === 0, "Native compiler", "Install Apple Command Line Tools.");
report(documents.components === "present", "Native document components", "Obtain a complete matching release, or build the documented native tools.");
const environment = { ...process.env };
try { new ModelSettings(resolve(".packx-settings.json"), environment).apply(environment); }
catch { report(false, "Private settings file", "Check file permissions and format; never paste its credentials into logs."); }
const data = configureLocalData(environment);
report(!existsSync(resolve(data.root, ".packx-operation.lock")), "Data root available", "Stop Packx before maintenance; for an abandoned lock, follow docs/local-operations.md.");
report(!existsSync(resolve(data.root, ".packx-incomplete")), "No interrupted restore", "Use the original data or repeat restore into a new directory.");
report(Object.values(data.paths).every((path) => within(data.root, path)), "Stores inside the data root", "Custom paths require a coordinated backup; see docs/local-operations.md.");
const mode = environment.BLACKX_RUNTIME_MODE ?? "fake";
report(["fake", "anthropic"].includes(mode), "Runtime mode", "Use fake for browsing or anthropic for a configured provider.");
if (mode === "anthropic") {
	let valid = false;
	try {
		const url = new URL(environment.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com");
		valid = ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
	} catch { /* Configuration errors are reported without revealing values. */ }
	report(valid, "Provider URL structure", "Use an http(s) service root with no credentials, query or fragment.");
	report(Boolean(environment.ANTHROPIC_MODEL?.trim()), "Model ID configured", "Set ANTHROPIC_MODEL in .env.");
	report(Boolean(environment.ANTHROPIC_API_KEY?.trim()), "Provider credential configured", "Set ANTHROPIC_API_KEY privately in .env.");
} else console.log("INFO · Fake mode supports browsing. Use npm run dev:fixture for a fixed, no-key demonstration.");
console.log("No provider request was sent. Configuration checks do not prove model compatibility or task quality.");
process.exitCode = failures ? 1 : 0;
