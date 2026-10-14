import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLocalDataVersion, migrateLocalData } from "./localData";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function dataRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "packx-data-migration-"));
	directories.push(root);
	ensureLocalDataVersion(root);
	return root;
}

function version(root: string): number {
	return JSON.parse(readFileSync(join(root, ".packx-data-version.json"), "utf8")).schemaVersion;
}

describe("local data migrations", () => {
	it("keeps the current version when no step is needed", () => {
		const root = dataRoot();

		expect(migrateLocalData(root)).toBe(1);
		expect(version(root)).toBe(1);
	});

	it("runs ordered steps and records each committed version", () => {
		const root = dataRoot();
		const log: string[] = [];
		const migrations = [
			{ from: 1, to: 2, run: () => { log.push("1->2"); } },
			{ from: 2, to: 3, run: () => { log.push("2->3"); } },
		];

		expect(migrateLocalData(root, migrations, 3)).toBe(3);
		expect(log).toEqual(["1->2", "2->3"]);
		expect(version(root)).toBe(3);
	});

	it("keeps the last committed version when a step fails and resumes after the fix", () => {
		const root = dataRoot();
		let attempts = 0;
		const migrations = [
			{ from: 1, to: 2, run: () => { attempts += 1; } },
			{ from: 2, to: 3, run: () => { throw new Error("disk full"); } },
		];

		expect(() => migrateLocalData(root, migrations, 3)).toThrow("disk full");
		expect(version(root)).toBe(2);

		const fixed = [
			{ from: 1, to: 2, run: () => { attempts += 1; } },
			{ from: 2, to: 3, run: () => undefined },
		];
		expect(migrateLocalData(root, fixed, 3)).toBe(3);
		expect(attempts).toBe(1);
		expect(version(root)).toBe(3);
	});

	it("refuses data written by a newer release and a missing migration step", () => {
		const newer = dataRoot();
		writeFileSync(join(newer, ".packx-data-version.json"), JSON.stringify({ schemaVersion: 9, adoptedAt: "2026-10-14T00:00:00.000Z" }));
		expect(() => migrateLocalData(newer, [], 3)).toThrow("unsupported_data_version");
		expect(version(newer)).toBe(9);

		const missing = dataRoot();
		expect(() => migrateLocalData(missing, [{ from: 1, to: 2, run: () => undefined }], 3)).toThrow("missing_data_migration: 2 -> 3");
		expect(version(missing)).toBe(2);
	});
});
