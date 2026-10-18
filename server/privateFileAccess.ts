import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

type Execute = (program: string, args: string[]) => string;
const system = process.env.SystemRoot ?? "C:\\Windows";
const execute: Execute = (program, args) => {
 const keys = ["SystemRoot", "SystemDrive", "USERPROFILE", "TEMP", "TMP", "PATH"];
 try { return execFileSync(join(system, "System32", program), args, { encoding: "utf8", timeout: 10000, maxBuffer: 65536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: Object.fromEntries(keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])) }); }
 catch { throw new Error("private_file_access_unavailable"); }
};

/** icacls /save emits SDDL. Accept only a protected DACL with explicit owner + SYSTEM full access. */
export function privateWindowsDacl(sddl: string, owner: string, localAdministrator = false) {
 if (!/^S-1-5-21-(?:\d+-){3}\d+$/.test(owner) || localAdministrator && !owner.endsWith("-500")) return false;
 const match = /^D:([A-Z]*)(.*)$/.exec(sddl.trim());
 if (!match || !match[1].includes("P") || /[^PAI]/.test(match[1])) return false;
 const entries = [...match[2].matchAll(/\(A;;(?:FA|0x1f01ff);;;(S-[0-9-]+|SY|LA)\)/g)];
 return entries.length === 2 && entries.map((entry) => entry[0]).join("") === match[2] && new Set(entries.map((entry) => entry[1])).size === 2 && entries.some((entry) => entry[1] === owner || localAdministrator && entry[1] === "LA") && entries.some((entry) => entry[1] === "SY" || entry[1] === "S-1-5-18") && entries.every((entry) => entry[1] === owner || entry[1] === "SY" || entry[1] === "S-1-5-18" || localAdministrator && entry[1] === "LA");
}

/** Host OS adapter, never a model Tool. No credential is passed to an OS command. */
export class PrivateFileAccess {
 constructor(private readonly platform = process.platform, private readonly run: Execute = execute) {}
 private owner() {
  const identity = this.run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const matches = identity.match(/S-1-5-21-(?:\d+-){3}\d+/g);
  if (matches?.length !== 1) throw new Error("private_file_owner_unavailable");
  const sid = matches[0];
  // LA is the machine-relative RID 500 alias, never a domain account inferred only from its RID.
  return { sid, localAdministrator: sid.endsWith("-500") && identity.trim().toLowerCase().startsWith(`"${hostname().toLowerCase()}\\`) };
 }
 assert(path: string) {
  if (this.platform !== "win32") { if (lstatSync(path).mode & 0o077) throw new Error("private_file_access_unsafe"); return; }
  const owner = this.owner(), directory = mkdtempSync(join(tmpdir(), "packx-private-acl-")), report = join(directory, "acl.txt");
  try {
   this.run("icacls.exe", [path, "/save", report, "/q"]);
   const lines = readFileSync(report).toString("utf16le").replace(/^\ufeff/, "").split(/\r?\n/).filter(Boolean);
   if (lines.length !== 2 || !privateWindowsDacl(lines[1], owner.sid, owner.localAdministrator)) throw new Error("private_file_access_unsafe");
  } finally { rmSync(directory, { recursive: true, force: true }); }
 }
 /** Only the caller's newly-created, empty O_EXCL temporary file may be hardened. */
 prepare(path: string) {
  if (this.platform === "win32") {
   const stat = lstatSync(path);
   if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 0) throw new Error("private_file_prepare_unsafe");
   this.run("icacls.exe", [path, "/inheritance:r", "/grant:r", `*${this.owner().sid}:F`, "*S-1-5-18:F", "/q"]);
   // Node-created Windows files may carry this explicit default ACE; remove it while still empty.
   this.run("icacls.exe", [path, "/remove:g", "*S-1-5-32-544", "/q"]);
  }
  this.assert(path);
 }
}
