import { dirname, resolve } from "node:path";
import { lockLocalData } from "../server/localData";
import { migrateEventStoreToSqlite } from "../server/enterprise/eventStoreMigration";

const [source, target] = process.argv.slice(2);
if (!source || !target) {
	console.error("usage: npm run migrate:event-store -- <events.json> <events.sqlite>");
	process.exit(2);
}
const sourcePath = resolve(source);
const release = lockLocalData(dirname(sourcePath));
try {
	const report = migrateEventStoreToSqlite(sourcePath, resolve(target));
	console.log(JSON.stringify(report, null, 2));
} finally {
	release();
}
