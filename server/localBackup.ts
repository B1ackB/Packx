import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdtempSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lockLocalData, within } from "./localData";

interface Manifest { schemaVersion: "packx-local-backup.v1"; createdAt: string; files: Array<{ path: string; bytes: number; sha256: string }> }
const manifestName = "packx-backup.json";
function files(root: string, prefix = ""): string[] {
	return readdirSync(resolve(root, prefix)).sort().flatMap((name) => {
		const path = prefix ? `${prefix}/${name}` : name;
		if (path === ".packx-operation.lock") return [];
		const stat = lstatSync(resolve(root, path));
		if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile() || stat.isFile() && stat.nlink !== 1) throw new Error("backup_unsafe_entry");
		if (stat.isFile() && stat.size > 256 * 1024 * 1024) throw new Error("backup_file_exceeds_256_mib");
		return stat.isDirectory() ? files(root, path) : [path];
	});
}
function digest(root: string, path: string) {
	const bytes = readFileSync(resolve(root, path));
	return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function checkSqlite(root: string, paths: string[]) {
	for (const path of paths.filter((path) => /\.(sqlite|db)$/.test(path))) {
		// SQLite may update shared-memory files even on a read-only connection. Inspect a disposable copy.
		const scratch = mkdtempSync(resolve(tmpdir(), "packx-backup-check-"));
		try {
			copy(root, scratch, paths.filter((candidate) => candidate === path || candidate === `${path}-wal` || candidate === `${path}-shm`));
			const db = new DatabaseSync(resolve(scratch, path), { readOnly: true });
			try { if (!Object.values(db.prepare("PRAGMA quick_check").get() ?? {}).includes("ok")) throw new Error("backup_database_corrupt"); }
			finally { db.close(); }
		} finally { rmSync(scratch, { recursive: true, force: true }); }
	}
}
function copy(root: string, destination: string, paths: string[]) {
	for (const path of paths) {
		const target = resolve(destination, path);
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		copyFileSync(resolve(root, path), target, constants.COPYFILE_EXCL);
		chmodSync(target, 0o600);
	}
}
export function verifyBackup(directory: string): Manifest {
	if (lstatSync(directory).isSymbolicLink()) throw new Error("backup_unsafe_directory");
	const manifest = JSON.parse(readFileSync(resolve(directory, manifestName), "utf8")) as Manifest;
	if (manifest.schemaVersion !== "packx-local-backup.v1" || !Array.isArray(manifest.files) || manifest.files.length > 100_000) throw new Error("invalid_backup_manifest");
	const paths = manifest.files.map((file) => {
		if (!file || typeof file.path !== "string" || !file.path || file.path.split("/").some((part) => !part || part === "." || part === "..") || file.path.includes("\\") || !within(resolve(directory), resolve(directory, file.path))) throw new Error("invalid_backup_path");
		if (file.path === manifestName || file.path === ".packx-incomplete" || file.path === ".packx-operation.lock" || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("invalid_backup_entry");
		return file.path;
	});
	if (new Set(paths).size !== paths.length || JSON.stringify([...paths].sort()) !== JSON.stringify(files(directory).filter((path) => path !== manifestName).sort())) throw new Error("backup_file_set_mismatch");
	for (const file of manifest.files) {
		const actual = digest(directory, file.path);
		if (file.bytes !== actual.bytes || file.sha256 !== actual.sha256) throw new Error("backup_integrity_failure");
	}
	checkSqlite(directory, paths);
	return manifest;
}
export function createBackup(root: string, destination: string) {
	root = realpathSync(root); destination = resolve(realpathSync(dirname(resolve(destination))), basename(resolve(destination)));
	if (!existsSync(root) || within(root, destination) || within(destination, root)) throw new Error("backup_requires_separate_destination");
	const release = lockLocalData(root);
	let created = false;
	try {
		mkdirSync(destination, { mode: 0o700 }); created = true;
		const paths = files(root);
		if (paths.includes(manifestName) || paths.includes(".packx-incomplete")) throw new Error("backup_reserved_entry");
		copy(root, destination, paths);
		const manifest: Manifest = { schemaVersion: "packx-local-backup.v1", createdAt: new Date().toISOString(), files: paths.map((path) => digest(destination, path)) };
		writeFileSync(resolve(destination, manifestName), JSON.stringify(manifest, null, "\t"), { mode: 0o600, flag: "wx" });
		verifyBackup(destination);
		return manifest;
	} catch (error) { if (created) rmSync(destination, { recursive: true, force: true }); throw error; }
	finally { release(); }
}
export function restoreBackup(source: string, destination: string) {
	source = realpathSync(source); destination = resolve(realpathSync(dirname(resolve(destination))), basename(resolve(destination)));
	if (within(source, destination) || within(destination, source)) throw new Error("restore_requires_separate_destination");
	const manifest = verifyBackup(source);
	mkdirSync(destination, { mode: 0o700 });
	const marker = resolve(destination, ".packx-incomplete");
	writeFileSync(marker, "Restore in progress; do not start Packx here.", { mode: 0o600, flag: "wx" });
	try {
		copy(source, destination, manifest.files.map((file) => file.path));
		for (const file of manifest.files) if (digest(destination, file.path).sha256 !== file.sha256) throw new Error("restore_integrity_failure");
		checkSqlite(destination, manifest.files.map((file) => file.path));
		rmSync(marker);
	} catch (error) { throw new Error("restore_incomplete: retain the original data and inspect the new directory", { cause: error }); }
	return manifest;
}
