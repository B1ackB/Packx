import { createHash } from "node:crypto";
import { chmodSync, constants, copyFileSync, existsSync, readFileSync } from "node:fs";
import { SqliteEnterpriseEventStore } from "./sqliteEventStore";
import { readEventStoreDocument } from "./fileEventStore";

export interface EventStoreMigrationReport {
	source: string;
	target: string;
	backup: string;
	sourceSha256: string;
	events: number;
	outbox: number;
	runs: number;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Migrates a file Event Store into an empty SQLite database. The source is validated and backed up first,
 * and the import is verified per aggregate inside one transaction. The source file is never modified.
 */
export function migrateEventStoreToSqlite(sourcePath: string, targetPath: string, now = new Date()): EventStoreMigrationReport {
	if (!existsSync(sourcePath)) throw new Error("event_store_source_missing");
	const sourceSha256 = sha256(sourcePath);
	const document = readEventStoreDocument(sourcePath);
	const backup = `${sourcePath}.migrated-${now.toISOString().replace(/[:.]/g, "-")}.bak`;
	copyFileSync(sourcePath, backup, constants.COPYFILE_EXCL);
	chmodSync(backup, 0o600);
	if (sha256(backup) !== sourceSha256) throw new Error("event_store_backup_mismatch");

	const target = new SqliteEnterpriseEventStore(targetPath);
	try {
		const counts = target.importDocument(document);
		return { source: sourcePath, target: targetPath, backup, sourceSha256, ...counts };
	} finally {
		target.close();
	}
}
