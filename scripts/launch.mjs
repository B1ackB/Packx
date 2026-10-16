import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const [major, minor] = process.versions.node.split(".").map(Number);
const action = process.argv[2] ?? "start";
if (!["darwin", "win32"].includes(process.platform) || major !== 24 || minor < 14 || !["start", "stop"].includes(action)) {
 console.error("Packx requires macOS or Windows x64 and Node.js 24.14+ (24.x). Usage: node scripts/launch.mjs [start|stop]. See START-HERE.md."); process.exit(1);
}
try { process.loadEnvFile(".env"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const port = Number(process.env.BLACKX_PORT ?? 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid BLACKX_PORT (1024..65535).");
const base = `http://127.0.0.1:${port}`;
const installationId = createHash("sha256").update(realpathSync(process.cwd())).digest("hex");
async function localHost() {
 let session;
 try { session = await fetch(`${base}/api/local-session`, { headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }, signal: AbortSignal.timeout(1500) }); }
 catch (error) { if (error.cause?.code === "ECONNREFUSED") return; throw new Error("Host status unknown; no process was stopped."); }
 if (!session.ok) throw new Error("The port is occupied by another service. No process was stopped.");
 const { token } = await session.json();
 const response = await fetch(`${base}/api/runtime/health`, { headers: { "x-blackx-session-token": token }, signal: AbortSignal.timeout(1500) });
 const health = response.ok ? await response.json() : undefined;
 if (health?.localHost?.installationId !== installationId || typeof health.localHost.instanceId !== "string") throw new Error("Another installation owns this port. Use its Stop-Packx command or choose a different BLACKX_PORT.");
 return { token, instanceId: health.localHost.instanceId };
}
async function stop() {
 const current = await localHost();
 if (!current) { if (existsSync(resolve(process.env.BLACKX_DATA_ROOT ?? ".blackx-data", ".packx-operation.lock"))) throw new Error("Host is unreachable but the data lock remains. Preserve it and use the documented recover-lock procedure."); console.log("Packx is already stopped."); return; }
 const result = await fetch(`${base}/api/local-shutdown`, { method: "POST", headers: { "content-type": "application/json", "x-blackx-session-token": current.token }, body: JSON.stringify({ instanceId: current.instanceId }), signal: AbortSignal.timeout(3000) });
 if (result.status !== 202) throw new Error("Host changed or shutdown was refused. No process was killed.");
 for (let attempt = 0; attempt < 140; ++attempt) {
  await new Promise((accept) => setTimeout(accept, 50));
  if (!await localHost() && !existsSync(resolve(process.env.BLACKX_DATA_ROOT ?? ".blackx-data", ".packx-operation.lock"))) { console.log("Packx stopped. Interrupted tasks may need recovery."); return; }
 }
 throw new Error("Shutdown is not confirmed. Preserve the data lock and inspect the original window.");
}
function open() {
 console.log(`Packx: ${base}`);
 if (process.env.PACKX_NO_OPEN === "1") return;
 const file = process.platform === "darwin" ? "/usr/bin/open" : join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe");
 const browser = spawn(file, process.platform === "darwin" ? [base] : ["url.dll,FileProtocolHandler", base], { stdio: "ignore", windowsHide: true });
 browser.on("error", () => console.error(`Open ${base} in your browser.`)); browser.unref();
}
try {
 if (action === "stop") { await stop(); }
 else if (await localHost()) { console.log("This Packx installation is already running."); open(); }
 else {
  const release = JSON.parse(readFileSync("packx-release.json", "utf8"));
  if (release.platform !== process.platform || release.arch !== process.arch) throw new Error("Release platform/architecture does not match this device.");
  for (const file of release.files) {
   const path = resolve(file.path), stat = lstatSync(path);
   if (!path.startsWith(process.cwd() + (process.platform === "win32" ? "\\" : "/")) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || createHash("sha256").update(readFileSync(path)).digest("hex") !== file.sha256) throw new Error("Release integrity check failed. Download a complete trusted release.");
  }
  const installKey = createHash("sha256").update(readFileSync("package-lock.json")).update(process.version + process.platform + process.arch).digest("hex");
  if (existsSync("node_modules") && (lstatSync("node_modules").isSymbolicLink() || realpathSync("node_modules") !== resolve("node_modules"))) throw new Error("Linked dependencies are not accepted in a portable release.");
  const receipt = existsSync(".packx-install.json") ? JSON.parse(readFileSync(".packx-install.json", "utf8")) : {};
  if (receipt.installKey !== installKey || !existsSync("node_modules/tsx")) {
   console.log("Installing dependencies pinned in package-lock.json. First installation needs internet; lifecycle scripts are disabled.");
   const npm = process.platform === "win32" ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : realpathSync(join(dirname(process.execPath), "npm"));
   const installed = spawnSync(process.execPath, [npm, "ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { stdio: "inherit", shell: false });
   if (installed.error || installed.status !== 0) throw new Error("Dependency installation failed. Retry Start-Packx after checking connectivity; no successful-install receipt was saved.");
   writeFileSync(".packx-install.json.tmp", JSON.stringify({ installKey }), { mode: 0o600 }); renameSync(".packx-install.json.tmp", ".packx-install.json");
  }
  const required = process.platform === "win32" ? ["text-inspector.exe", "text-inspector-worker.exe"] : ["asset-inspector", "tool-supervisor"];
  if (!existsSync("dist/index.html") || required.some((name) => !existsSync(join(".blackx-tools", name)))) throw new Error("Release is incomplete.");
  const host = spawn(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "server/index.ts"], { env: { ...process.env, BLACKX_PRODUCTION: "1" }, stdio: ["inherit", "pipe", "inherit"] });
  let opened = false, output = "";
  host.stdout.on("data", (chunk) => { process.stdout.write(chunk); output = (output + chunk).slice(-1000); if (!opened && output.includes("Packx listening on")) { opened = true; open(); } });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stop().catch((error) => { console.error(error.message); process.exitCode = 1; }); });
  host.once("error", () => { console.error("Packx could not start."); process.exitCode = 1; });
  host.once("exit", (code) => { if (code) console.error(`Packx stopped. Crash recovery: npm run state -- recover-lock\nData: ${resolve(process.env.BLACKX_DATA_ROOT ?? ".blackx-data")}`); process.exitCode = code ?? 1; });
 }
} catch (error) { console.error(error.message); process.exitCode = 1; }
