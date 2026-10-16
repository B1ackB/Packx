import { describe, expect, it } from "vitest";
import { releaseSourcePaths } from "../scripts/build-release.mjs";

describe("portable release source boundary", () => {
 it("copies only tracked allowlisted source and explicit docs, excluding private evidence/configuration", () => {
  const allowed = ["package.json", "package-lock.json", ".env.example", "server/index.ts", "src/App.tsx", "scripts/launch.mjs", "docs/windows-release-start.md", "LICENSE"];
  const denied = [".env", ".env.production", ".packx-settings.json", "server/.env", "server/fixtures/customer.txt", "server/runtime/private.test.ts", "docs/evidence/user-uncommitted/source.json", "docs/customer.md", "node_modules/secret", ".blackx-data/events.json", "temp/customer.txt", ".git/config"];
  expect(releaseSourcePaths([...allowed, ...denied])).toEqual(allowed);
 });
});
