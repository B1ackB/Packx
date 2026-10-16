import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreBackup, verifyBackup } from "./localBackup";
import { configureLocalData, lockLocalData } from "./localData";

const roots: string[] = [];
function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "packx-state-test-"))); roots.push(root);
	const data = join(root, "data"); mkdirSync(data);
	writeFileSync(join(data, "events.json"), JSON.stringify({ fact: { value: 5000, status: "unverified" } }));
	mkdirSync(join(data, "attachments")); writeFileSync(join(data, "attachments", "source.txt"), "Synthetic packaging source");
	const db = new DatabaseSync(join(data, "plans.sqlite"));
	db.exec("PRAGMA journal_mode=WAL; CREATE TABLE plans(version INTEGER, status TEXT); INSERT INTO plans VALUES(1, 'completed')");
	db.close();
	return { data, backup: join(root, "backup"), restored: join(root, "restored") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("local product backup and restore", () => {
	it("round-trips files and SQLite without changing the original or overwriting a destination", () => {
		const { data, backup, restored } = setup();
		const before = readFileSync(join(data, "events.json"), "utf8");
		const manifest = createBackup(data, backup);
		expect(verifyBackup(backup)).toEqual(manifest);
		expect(verifyBackup(backup)).toEqual(manifest);
		restoreBackup(backup, restored);
		expect(readFileSync(join(restored, "events.json"), "utf8")).toBe(before);
		expect(readFileSync(join(data, "events.json"), "utf8")).toBe(before);
		const db = new DatabaseSync(join(restored, "plans.sqlite"), { readOnly: true });
		expect(db.prepare("SELECT status FROM plans").get()?.status).toBe("completed"); db.close();
		expect(() => restoreBackup(backup, restored)).toThrow();
		expect(readFileSync(join(restored, "events.json"), "utf8")).toBe(before);
	});
	it("refuses a busy Host, nested backups, links, corrupt data and traversal before restoring", () => {
		const { data, backup, restored } = setup();
		const release = lockLocalData(data);
		expect(() => lockLocalData(data)).toThrow(/local_data_busy/);
		expect(() => createBackup(data, backup)).toThrow(/local_data_busy/); release();
		expect(() => createBackup(data, join(data, "backup"))).toThrow();
		symlinkSync(join(data, "events.json"), join(data, "linked.json"));
		expect(() => createBackup(data, backup)).toThrow(/unsafe_entry/); rmSync(join(data, "linked.json"));
		createBackup(data, backup);
		writeFileSync(join(backup, "events.json"), "corrupt");
		expect(() => restoreBackup(backup, restored)).toThrow(/integrity/);
		expect(existsSync(restored)).toBe(false);
		const manifest = JSON.parse(readFileSync(join(backup, "packx-backup.json"), "utf8"));
		manifest.files[0].path = "../escape"; writeFileSync(join(backup, "packx-backup.json"), JSON.stringify(manifest));
		expect(() => restoreBackup(backup, restored)).toThrow(/invalid_backup_path/);
	});
	it("checks a WAL snapshot without modifying the backup, and blocks an interrupted restore", () => {
		const { data, backup, restored } = setup();
		const db = new DatabaseSync(join(data, "plans.sqlite"));
		db.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO plans VALUES(2, 'paused')");
		const manifest = createBackup(data, backup);
		db.close();
		expect(verifyBackup(backup)).toEqual(manifest);
		restoreBackup(backup, restored);
		const restoredDb = new DatabaseSync(join(restored, "plans.sqlite"));
		expect(restoredDb.prepare("SELECT COUNT(*) AS count FROM plans").get()?.count).toBe(2); restoredDb.close();
		writeFileSync(join(restored, ".packx-incomplete"), "interrupted");
		expect(() => lockLocalData(restored)).toThrow(/restore_incomplete/);
	});
	it("rejects nested destinations through a directory symlink or Windows junction before creating files", () => {
		const { data, backup } = setup();
		const dataAlias = join(dirname(data), "data-alias"), backupAlias = join(dirname(data), "backup-alias");
		const type = process.platform === "win32" ? "junction" : "dir";
		symlinkSync(data, dataAlias, type);
		expect(() => createBackup(data, join(dataAlias, "nested"))).toThrow("backup_requires_separate_destination");
		expect(existsSync(join(data, "nested"))).toBe(false);
		createBackup(data, backup);
		symlinkSync(backup, backupAlias, type);
		expect(() => restoreBackup(backup, join(backupAlias, "nested"))).toThrow("restore_requires_separate_destination");
		expect(existsSync(join(backup, "nested"))).toBe(false);
	});
	it("relocates default stores while preserving explicit legacy overrides", () => {
		const environment: NodeJS.ProcessEnv = { BLACKX_DATA_ROOT: "/private/tmp/restored", BLACKX_STAGE_JOB_QUEUE_DRIVER: "sqlite", BLACKX_FILE_STORE_PATH: "/private/tmp/legacy-files" };
		const data = configureLocalData(environment);
		expect(data.paths.BLACKX_AGENT_STATE_PATH).toBe(resolve("/private/tmp/restored/agent"));
		expect(data.paths.BLACKX_STAGE_JOB_QUEUE_PATH).toBe(resolve("/private/tmp/restored/stage-jobs.sqlite"));
		expect(data.paths.BLACKX_FILE_STORE_PATH).toBe(resolve("/private/tmp/legacy-files"));
	});
});
