import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class FileWriteLockError extends Error {}

/** SQLite owns the OS lock: process death releases it without deleting another writer's lock. */
export function withFileWriteLock<T>(path: string, operation: () => T): T {
	const lockPath = `${path}.lock`;
	let database: DatabaseSync | undefined;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		// Keep legacy ownerless directories blocked. Never infer that an old writer is dead.
		const descriptor = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
		closeSync(descriptor);
		const stat = lstatSync(lockPath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe write lock");
		database = new DatabaseSync(lockPath);
		database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
	} catch (cause) {
		database?.close();
		throw new FileWriteLockError("File write lock is unavailable; retain legacy locks for operator review", { cause });
	}
	try {
		// JSON, Artifact versions and execution ledgers keep their existing atomic writes.
		return operation();
	} finally {
		database.close();
	}
}
