import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, lstatSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, join, relative, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const docs = new Set(["docs/release-start.md", "docs/windows-release-start.md", "docs/local-operations.md", "docs/api-configuration.md", "docs/windows-release-notices.md"]);
export function releaseSourcePaths(tracked) {
 return tracked.filter((path) => {
  if (/(^|\/)(\.env(?:\..*)?|\.packx-settings[^/]*|\.blackx-data|node_modules|evidence|fixtures|__tests__)(\/|$)/.test(path) && path !== ".env.example") return false;
  if (/\.test\.tsx?$/.test(path)) return false;
  return ["package.json", "package-lock.json", ".nvmrc", ".env.example", "LICENSE"].includes(path) || docs.has(path) || /^(server|src|scripts|examples)\//.test(path) || path.startsWith("data/knowledge/packaging-expansion-2026-09-21/");
 });
}
function command(file, args) {
 const result = spawnSync(file, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
 if (result.error || result.status !== 0) throw new Error(`Release command failed: ${basename(file)}`);
 return result.stdout;
}
function copyFile(source, destination) {
 const stat = lstatSync(source);
 if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Release input must be a regular, unlinked file.");
 mkdirSync(dirname(destination), { recursive: true, mode: 0o700 }); cpSync(source, destination);
}
export function buildRelease(outputArgument, nativeDirectory = ".blackx-tools") {
 if (!["darwin", "win32"].includes(process.platform) || (process.platform === "win32" && process.arch !== "x64")) throw new Error("Build releases on matching macOS or Windows x64.");
 command("git", ["diff", "--quiet", "HEAD", "--"]);
 const commit = command("git", ["rev-parse", "HEAD"]).trim();
 const version = JSON.parse(readFileSync("package.json", "utf8")).version;
 const name = `Packx-${version}-${process.platform === "win32" ? "windows" : "macos"}-${process.arch}`;
 const output = resolve(outputArgument ?? `releases/${name}`), archive = output + (process.platform === "win32" ? ".zip" : ".tar.gz");
 if (existsSync(archive)) throw new Error("Release archive already exists; use a new destination.");
 mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); mkdirSync(output, { recursive: false, mode: 0o700 });
 // Git's tracked index is the authority. Untracked user evidence/configuration is never traversed.
 for (const path of releaseSourcePaths(command("git", ["ls-files", "-z"]).split("\0").filter(Boolean))) copyFile(path, join(output, path));
 for (const entry of ["index.html", ...readdirSync("dist/assets").map((file) => `assets/${file}`)]) {
  if (entry !== "index.html" && !/^assets\/[A-Za-z0-9_.-]+\.(js|css)$/.test(entry)) throw new Error("Unexpected frontend output; build a fresh dist directory.");
  copyFile(join("dist", entry), join(output, "dist", entry));
 }
 const releasePackage = JSON.parse(readFileSync(join(output, "package.json"), "utf8"));
 releasePackage.scripts = { start: "node scripts/launch.mjs", doctor: releasePackage.scripts.doctor, state: releasePackage.scripts.state };
 writeFileSync(join(output, "package.json"), JSON.stringify(releasePackage, null, "\t") + "\n");
 const binaries = process.platform === "win32" ? ["text-inspector.exe", "text-inspector-worker.exe"] : ["asset-inspector", "tool-supervisor"];
 for (const binary of binaries) {
  const source = resolve(nativeDirectory, binary);
  if (process.platform === "win32") {
   const bytes = readFileSync(source), pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
   if (bytes.toString("ascii", 0, 2) !== "MZ" || pe < 0 || pe + 6 > bytes.length || bytes.toString("ascii", pe, pe + 4) !== "PE\0\0" || bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error("Expected the verified AMD64 native build.");
  }
  copyFile(source, join(output, ".blackx-tools", binary));
 }
 if (process.platform === "win32") {
  for (const [file, action] of [["Start-Packx.cmd", "start"], ["Stop-Packx.cmd", "stop"]]) {
   writeFileSync(join(output, file), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"%SystemRoot%\\System32\\where.exe" node >nul 2>nul\r\nif errorlevel 1 (\r\n echo Install Node.js 24.14+ 24.x, then reopen this command. See START-HERE.md.\r\n pause\r\n exit /b 1\r\n)\r\nnode scripts/launch.mjs ' + action + '\r\nif errorlevel 1 (\r\n pause\r\n exit /b 1\r\n)\r\n');
  }
 } else {
  writeFileSync(join(output, "Packx.command"), '#!/bin/zsh\nset -eu\ncd "${0:A:h}"\nexport PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"\nif ! command -v node >/dev/null; then\n print "Install Node.js 24.14+ 24.x; see START-HERE.md."\n read "?Press Return to close."\n exit 1\nfi\nnode scripts/launch.mjs || { read "?Packx stopped. Press Return to close."; exit 1; }\n');
  chmodSync(join(output, "Packx.command"), 0o700);
 }
 copyFile(process.platform === "win32" ? "docs/windows-release-start.md" : "docs/release-start.md", join(output, "START-HERE.md"));
 const files = [];
 function walk(root) {
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
   const path = join(root, entry.name);
   if (entry.isDirectory()) walk(path);
   else files.push({ path: relative(output, path).split(process.platform === "win32" ? "\\" : "/").join("/"), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
  }
 }
 walk(output);
 writeFileSync(join(output, "packx-release.json"), JSON.stringify({ schemaVersion: 1, version, commit, platform: process.platform, arch: process.arch, node: "24.14+ <25", signed: false, distribution: "internal-validation", documentScope: process.platform === "win32" ? "windows-utf8" : "macos-documents", files }, null, "\t"));
 const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
 command(tar, [process.platform === "win32" ? "-a" : "-z", "-cf", archive, "-C", output, "."]);
 writeFileSync(`${archive}.sha256`, `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${basename(archive)}\n`);
 console.log(`Release: ${output}\nArchive: ${archive}`);
 return { output, archive };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) buildRelease(process.argv[2], process.argv[3]);
