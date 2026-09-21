import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") throw new Error("Build native Packx releases on macOS.");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const name = `Packx-${version}-macos-${process.arch}`;
const output = resolve(process.argv[2] ?? `releases/${name}`);
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
mkdirSync(output, { recursive: false, mode: 0o700 });
// An explicit allowlist keeps private configuration, business data and local credentials out.
for (const path of ["package.json", "package-lock.json", ".nvmrc", ".env.example", "LICENSE", "dist", "server", "src", "scripts", "docs", "examples", "data/knowledge/packaging-expansion-2026-09-21"]) {
	cpSync(path, join(output, path), { recursive: true, filter: (source) => !source.endsWith(".test.ts") && !source.endsWith(".test.tsx") && !lstatSync(source).isSymbolicLink() });
}
const releasePackage = JSON.parse(readFileSync(join(output, "package.json"), "utf8"));
releasePackage.scripts = { start: "node scripts/launch.mjs", doctor: releasePackage.scripts.doctor, state: releasePackage.scripts.state };
writeFileSync(join(output, "package.json"), JSON.stringify(releasePackage, null, "\t") + "\n");
mkdirSync(join(output, ".blackx-tools"), { mode: 0o700 });
for (const binary of ["asset-inspector", "tool-supervisor"]) cpSync(resolve(".blackx-tools", binary), join(output, ".blackx-tools", binary));
writeFileSync(join(output, "Packx.command"), '#!/bin/zsh\nset -eu\ncd "${0:A:h}"\nexport PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"\nif ! command -v node >/dev/null; then\n\tprint "Install Node.js 24.14+ (24.x), then reopen Packx. See START-HERE.md."\n\tread "?Press Return to close."\n\texit 1\nfi\nnode scripts/launch.mjs || { read "?Packx stopped. Press Return to close."; exit 1; }\n');
chmodSync(join(output, "Packx.command"), 0o700);
cpSync("docs/release-start.md", join(output, "START-HERE.md"));
const files = [];
function walk(root) {
	for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) walk(path);
		else files.push({ path: relative(output, path), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
	}
}
walk(output);
writeFileSync(join(output, "packx-release.json"), JSON.stringify({ schemaVersion: 1, version, platform: process.platform, arch: process.arch, node: "24.14+ <25", files }, null, "\t"));
const archive = `${output}.tar.gz`;
const tar = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", output, "."], { stdio: "inherit" });
if (tar.status !== 0) throw new Error("release_archive_failed");
writeFileSync(`${archive}.sha256`, `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${archive.split("/").at(-1)}\n`);
console.log(`Release: ${output}\nArchive: ${archive}`);
