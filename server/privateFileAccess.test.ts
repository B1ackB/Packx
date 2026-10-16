import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateWindowsDacl, PrivateFileAccess } from "./privateFileAccess";

const owner = "S-1-5-21-111-222-333-1001", safe = `D:P(A;;FA;;;${owner})(A;;FA;;;SY)`;
describe("private Windows settings ACL", () => {
 it("requires protected explicit full access for the actual owner and SYSTEM only", () => {
  expect(privateWindowsDacl(safe, owner)).toBe(true);
  const administrator = "S-1-5-21-111-222-333-500", alias = "D:P(A;;FA;;;LA)(A;;FA;;;SY)";
  expect(privateWindowsDacl(alias, administrator, true)).toBe(true);
  expect(privateWindowsDacl(alias, administrator)).toBe(false);
  expect(privateWindowsDacl(alias, owner, true)).toBe(false);
  for (const sddl of [safe.replace("D:P", "D:AI"), safe + "(A;;FR;;;BU)", safe.replace(owner, "S-1-5-21-1-2-3-1001"), safe.replace("A;;FA;;;SY", "A;ID;FA;;;SY"), "D:P", safe + "(XA;;FA;;;WD)", safe.replace(";;;SY", ";;;BA"), "D:P(A;;FA;;;SY)(A;;FA;;;S-1-5-18)"]) expect(privateWindowsDacl(sddl, owner)).toBe(false);
 });
 it("uses a Fake OS adapter and fails closed when permission evidence cannot be read", () => {
  const root = mkdtempSync(join(tmpdir(), "packx-private-fake-")), path = join(root, "empty"); writeFileSync(path, "");
  const calls: string[][] = [];
  const access = new PrivateFileAccess("win32", (file, args) => {
   calls.push([file, ...args]);
   if (file === "whoami.exe") return `"user","${owner}"`;
   if (args[1] === "/save") writeFileSync(args[2], Buffer.from(`empty\r\n${safe}\r\n`, "utf16le"));
   return "";
  });
  try {
   access.prepare(path); expect(calls.some((args) => args.includes("/inheritance:r"))).toBe(true);
   expect(() => new PrivateFileAccess("win32", () => { throw new Error("denied"); }).assert(path)).toThrow();
   writeFileSync(path, "already contains private data"); expect(() => access.prepare(path)).toThrow("private_file_prepare_unsafe");
  } finally { rmSync(root, { recursive: true, force: true }); }
 });
});
