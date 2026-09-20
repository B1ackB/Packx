import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { digest } from "../server/knowledge/store";

// Replay historical protocols in a disposable source tree, never overwrite the current store.
const edition = process.argv.at(-1); assert(edition === "v1" || edition === "v2" || edition === "v3", "Pass v1, v2 or v3");
const root = process.cwd(), temp = mkdtempSync(join(tmpdir(), "packx-rag-replay-"));
try {
	for (const path of ["eval", "server", "src", "data/knowledge", "docs/evidence"]) { mkdirSync(resolve(temp, path, ".."), { recursive: true }); cpSync(resolve(root, path), resolve(temp, path), { recursive: true }); }
	for (const path of ["node_modules", ".blackx-data"]) symlinkSync(resolve(root, path), resolve(temp, path), "dir");
	cpSync(resolve(root, "package.json"), resolve(temp, "package.json"));
	const oldStore = readFileSync(`data/knowledge/chunking-${edition === "v3" ? "v3" : "v2"}/source-snapshots/store.ts.txt`, "utf8");
	writeFileSync(resolve(temp, "server/knowledge/store.ts"), oldStore);
	const protocol = JSON.parse(readFileSync(`data/knowledge/chunking-${edition}/protocol.json`, "utf8"));
	assert.equal(digest(oldStore), protocol.sourceHashes["server/knowledge/store.ts"]);
	const script = edition === "v1" ? "knowledgeChunking.ts" : edition === "v2" ? "knowledgeSentence.ts" : "knowledgeOverlap.ts";
	execFileSync(process.execPath, ["--import", "tsx", `eval/${script}`], { cwd: temp, stdio: "inherit" });
	console.log(JSON.stringify({ replay: edition, sourceSnapshotVerified: true, currentSourcesUnchanged: true, originalReportsUnchanged: true }));
} finally { rmSync(temp, { recursive: true, force: true }); }
