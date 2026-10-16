import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ModelSettings } from "./modelSettings";
import { PrivateFileAccess } from "./privateFileAccess";

describe.skipIf(process.platform !== "win32")("actual Windows private model settings", () => {
 it("hardens before writing, verifies real DACL, masks keys and refuses broadened access", () => {
  const root = mkdtempSync(join(tmpdir(), "packx-private-settings-")), path = join(root, "中文 私密.json");
  try {
   const access = new PrivateFileAccess("win32", (program, args) => {
    const output = execFileSync(join(process.env.SystemRoot!, "System32", program), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    if (args[1] === "/save") {
     const bytes = readFileSync(args[2]), lines = bytes.toString("utf16le").replace(/^\ufeff/, "").split(/\r?\n/).filter(Boolean);
     console.log(JSON.stringify({ probe: "owned-synthetic-private-acl", prefix: bytes.subarray(0, 2).toString("hex"), lines: lines.length, sddl: lines.find((line) => line.startsWith("D:"))?.replace(/S-\d+(?:-\d+)+/g, "SID").slice(0, 500) }));
    }
    return output;
   });
   const settings = new ModelSettings(path, {}, access), saved = settings.save({ revision: 0, mode: "anthropic", baseUrl: "https://example.invalid", model: "fixture", apiKey: "synthetic-private-key" }, "local-user");
   expect(saved.keyConfigured).toBe(true); expect(JSON.stringify(saved)).not.toContain("synthetic-private-key"); new PrivateFileAccess().assert(path);
   const environment: NodeJS.ProcessEnv = {}; new ModelSettings(path, {}).apply(environment); expect(environment.ANTHROPIC_API_KEY).toBe("synthetic-private-key");
   // Only this owned synthetic file receives a negative-control Everyone read grant.
   execFileSync(join(process.env.SystemRoot!, "System32", "icacls.exe"), [path, "/grant", "*S-1-1-0:R", "/q"], { stdio: "ignore", timeout: 10000 });
   expect(() => new ModelSettings(path, {})).toThrow("settings_file_unsafe"); expect(existsSync(path)).toBe(true); expect(readFileSync(path, "utf8")).toContain("synthetic-private-key");
  } finally { rmSync(root, { recursive: true, force: true }); }
 });
});
