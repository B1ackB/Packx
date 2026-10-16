import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { testEnvironment } from "../scripts/ci";

const archive = resolve(process.argv[2] ?? `releases/Packx-0.1.0-${process.platform === "win32" ? "windows" : "macos"}-${process.arch}.${process.platform === "win32" ? "zip" : "tar.gz"}`), root = realpathSync(mkdtempSync(join(tmpdir(), "packx-portable-")));
const appA = join(root, "中文 安装 A"), appB = join(root, "中文 升级 B"), dataA = join(root, "中文 原始数据"), dataB = join(root, "中文 新版数据"), rollback = join(root, "中文 回滚数据"), backup = join(root, "停机 备份");
const children = new Set<ChildProcess>();
function run(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}, expected = 0) {
 const result = spawnSync(process.execPath, args, { cwd, env: { ...testEnvironment(process.env), ...environment, ...extra }, encoding: "utf8", timeout: 240000, maxBuffer: 2 * 1024 * 1024 });
 assert.equal(result.status, expected, `${args.slice(0, 2).join(" ")}: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
 return result.stdout + result.stderr;
}
const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
const port = (reservation.address() as { port: number }).port; await new Promise<void>((done) => reservation.close(() => done()));
const base = `http://127.0.0.1:${port}`;
const environment = { PACKX_NO_OPEN: "1", BLACKX_PORT: String(port), BLACKX_RUNTIME_MODE: "fake", ANTHROPIC_API_KEY: "", BLACKX_DATA_ROOT: dataA };
let token = "", launcher: ChildProcess | undefined;
async function start(app: string, data = dataA, direct = false) {
 const child = spawn(process.execPath, direct ? ["--import", "tsx", "server/index.ts"] : ["scripts/launch.mjs"], { cwd: app, env: { ...testEnvironment(process.env), ...environment, BLACKX_PRODUCTION: "1", BLACKX_DATA_ROOT: data }, stdio: ["ignore", "pipe", "pipe"] });
 children.add(child); let logs = ""; child.stdout!.on("data", (c) => { logs = (logs + c).slice(-8000); }); child.stderr!.on("data", (c) => { logs = (logs + c).slice(-8000); });
 child.once("close", () => children.delete(child));
 for (let attempt = 0; attempt < 4800; ++attempt) {
  assert.equal(child.exitCode, null, logs);
  if (logs.includes("Packx listening on")) {
   const session = await fetch(`${base}/api/local-session`, { headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } });
   assert.equal(session.status, 200); token = (await session.json() as { token: string }).token; launcher = child; return child;
  }
  await delay(50);
 }
 throw new Error("Portable first-start readiness deadline exceeded.");
}
async function stop(app: string, data = dataA) {
 const closed = launcher && launcher.exitCode === null ? once(launcher, "close") : Promise.resolve();
 run(app, ["scripts/launch.mjs", "stop"], { BLACKX_DATA_ROOT: data }); await closed;
 assert(!existsSync(join(data, ".packx-operation.lock")));
}
async function request(path: string, method = "GET", body?: unknown) {
 const response = await fetch(base + path, { method, headers: { "x-blackx-session-token": token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`); return await response.json() as Record<string, any>;
}
try {
 const tar = process.platform === "win32" ? join(process.env.SystemRoot!, "System32", "tar.exe") : "/usr/bin/tar";
 for (const app of [appA, appB]) {
  mkdirSync(app); assert.equal(spawnSync(tar, ["-xf", archive, "-C", app]).status, 0);
  const manifest = JSON.parse(readFileSync(join(app, "packx-release.json"), "utf8"));
  assert.equal(manifest.platform, process.platform); assert.equal(manifest.arch, process.arch); assert.equal(manifest.signed, false);
  for (const file of manifest.files) {
   assert(!/(^|\/)(node_modules|evidence|\.blackx-data|\.packx-settings[^/]*|\.git)(\/|$)/.test(file.path));
   assert(file.path !== ".env"); assert.equal(createHash("sha256").update(readFileSync(join(app, file.path))).digest("hex"), file.sha256);
  }
  assert(!existsSync(join(app, "node_modules"))); assert(!existsSync(join(app, ".packx-settings.json")));
 }
 if (process.platform === "win32") {
  const noNode = spawnSync(join(process.env.SystemRoot!, "System32", "cmd.exe"), ["/d", "/c", "Start-Packx.cmd"], { cwd: appA, env: { ...testEnvironment(process.env), PATH: "" }, encoding: "utf8", input: "\r\n", timeout: 10000 });
  assert.equal(noNode.status, 1); assert(noNode.stdout.includes("Install Node.js"));
 }
 assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), readFileSync(`${archive}.sha256`, "utf8").split(" ")[0]);
 // Real dependency installation in the relocated directory; no symlink or developer checkout reuse.
 await start(appA);
 assert(existsSync(join(appA, ".packx-install.json")));
 const health = await request("/api/runtime/health"); assert.equal(health.adapter, "fake");
 const originalInstance = health.localHost.instanceId;
 assert(run(appA, ["scripts/launch.mjs"]).includes("already running"));
 assert.equal((await request("/api/runtime/health")).localHost.instanceId, originalInstance);
 run(appB, ["scripts/launch.mjs", "stop"], {}, 1); assert.equal((await request("/api/runtime/health")).localHost.instanceId, originalInstance);
 assert.equal((await fetch(base + "/api/local-shutdown", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
 assert.equal((await fetch(base + "/api/local-shutdown", { method: "POST", headers: { "content-type": "application/json", "x-blackx-session-token": token }, body: JSON.stringify({ instanceId: "stale" }) })).status, 409);
 assert.equal((await fetch(base + "/api/local-shutdown", { method: "POST", headers: { origin: "http://evil.invalid", "x-blackx-session-token": token } })).status, 403);
 assert((await fetch(base).then((r) => r.text())).includes("/assets/"));
 for (const path of ["/.env", "/.packx-settings.json", "/server/index.ts", "/src/App.tsx"]) assert.equal((await fetch(base + path)).status, 404);
 const created = (await request("/api/conversations", "POST", {})).conversation;
 const id = created.conversationId; await request(`/api/conversations/${id}`, "PATCH", { name: "发行中文恢复验收", nameRevision: 0 });
 if (process.platform === "win32") {
  assert.equal(health.documents.scope, "windows-utf8"); assert.equal(health.documents.components, "present");
  for (const name of ["scan.pdf", "office.docx", "photo.png"]) assert.equal((await fetch(`${base}/api/conversations/${id}/attachments?requestId=reject&name=${name}`, { method: "POST", headers: { "x-blackx-session-token": token }, body: "unsupported" })).status, 415);
  assert.equal((await fetch(`${base}/api/conversations/${id}/attachments?requestId=large&name=large.txt`, { method: "POST", headers: { "x-blackx-session-token": token }, body: Buffer.alloc(131073, 97) })).status, 413);
  const uploaded = await fetch(`${base}/api/conversations/${id}/attachments?requestId=text&name=${encodeURIComponent("中文 需求.txt")}`, { method: "POST", headers: { "x-blackx-session-token": token, "content-type": "text/plain" }, body: "中文包装 5000 个，待确认" });
  assert.equal(uploaded.status, 201); const attachment = (await uploaded.json() as { attachment: { attachmentId: string } }).attachment;
  const inspection = (await request(`/api/conversations/${id}/attachments/${attachment.attachmentId}/inspection`)).document;
  assert.equal(inspection.parserVersion, "windows-utf8.v1"); assert.equal(inspection.inspection.kind, "text");
 }
 const settings = await request("/api/model-settings", "PUT", { revision: 0, mode: "anthropic", baseUrl: "http://127.0.0.1:1", model: "offline-only", apiKey: "synthetic-portable-private-key" });
 assert.equal(settings.apiKey, undefined);
 await stop(appA); assert(run(appA, ["scripts/launch.mjs", "stop"]).includes("already stopped"));
 // Upgrade and rollback use separate directories and pre-upgrade backup, never in-place migration.
 run(appA, ["--import", "tsx", "scripts/local-state.ts", "backup", backup]);
 assert(!JSON.stringify(JSON.parse(readFileSync(join(backup, "packx-backup.json"), "utf8"))).includes(".packx-settings"));
 run(appA, ["--import", "tsx", "scripts/local-state.ts", "verify", backup]);
 run(appA, ["--import", "tsx", "scripts/local-state.ts", "restore", backup, dataB]);
 await start(appB, dataB); assert.equal((await request(`/api/conversations/${id}`)).conversation.title, "发行中文恢复验收");
 assert.equal((await request("/api/model-settings")).keyConfigured, false); await stop(appB, dataB);
 run(appA, ["--import", "tsx", "scripts/local-state.ts", "restore", backup, rollback]);
 await start(appA, rollback); assert.equal((await request(`/api/conversations/${id}`)).conversation.title, "发行中文恢复验收"); await stop(appA, rollback);
 // Kill only a directly owned fixture Host; product stop never uses process-name or PID killing.
 const owned = await start(appB, dataB, true), closed = once(owned, "close"); owned.kill("SIGKILL"); await closed;
 assert(existsSync(join(dataB, ".packx-operation.lock")));
 run(appB, ["scripts/launch.mjs"], { BLACKX_DATA_ROOT: dataB }, 1);
 run(appB, ["--import", "tsx", "scripts/local-state.ts", "recover-lock"], { BLACKX_DATA_ROOT: dataB });
 await start(appB, dataB); assert.equal((await request(`/api/conversations/${id}`)).conversation.title, "发行中文恢复验收"); await stop(appB, dataB);
 writeFileSync(join(appB, "dist/index.html"), "tampered fixture");
 assert(run(appB, ["scripts/launch.mjs"], { BLACKX_DATA_ROOT: dataB }, 1).includes("integrity check failed"));
 console.log("PASS portable release: genuine clean dependency install; Chinese/spaced relocation; same-instance reuse; foreign/auth/origin/stale-instance stop denial; protected UTF-8 and PDF/OCR/Office rejection on Windows; stopped backup, separate-data upgrade and rollback; owned Host crash, lock recovery, restart; tamper rejection; no model calls.");
} finally {
 for (const child of children) { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; }
 rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
