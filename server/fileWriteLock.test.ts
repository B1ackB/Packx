import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { withFileWriteLock } from "./fileWriteLock";
import { FileArtifactContentStore } from "./artifacts/fileArtifactStore";
import { FileAgentStateStore } from "./runtime/fileAgentStateStore";
import { FileEnterpriseEventStore } from "./enterprise/fileEventStore";
import { ProposalRunEngine } from "../src/enterprise/proposalRunEngine";

const scope = { tenantId: "tenant", workspaceId: "workspace", runId: "run", sessionId: "session" };
const key = { ...scope, artifactId: "draft", artifactVersion: 1 };
const command = { ...scope, actorId: "employee", commandId: "create", correlationId: "crash-test", expectedVersion: 0 };
const now = "2026-09-30T00:00:00.000Z";
const modulePath = (path: string) => JSON.stringify(resolve(path));

it.each(["artifact", "session", "event"] as const)("releases the %s writer lock on SIGKILL before and after atomic commit", kind => {
	for (const phase of ["before", "after"]) {
		const root = mkdtempSync(join(tmpdir(), "packx-store-crash-"));
		try {
			const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
				import fs from 'node:fs';
				import { syncBuiltinESMExports } from 'node:module';
				const rename = fs.renameSync;
				fs.renameSync = (...args) => {
					if (${JSON.stringify(phase)} === 'before') process.kill(process.pid, 'SIGKILL');
					rename(...args);
					process.kill(process.pid, 'SIGKILL');
				};
				syncBuiltinESMExports();
				const { FileArtifactContentStore } = await import(${modulePath("server/artifacts/fileArtifactStore.ts")});
				const { FileAgentStateStore } = await import(${modulePath("server/runtime/fileAgentStateStore.ts")});
				const { FileEnterpriseEventStore } = await import(${modulePath("server/enterprise/fileEventStore.ts")});
				const { ProposalRunEngine } = await import(${modulePath("src/enterprise/proposalRunEngine.ts")});
				const root = ${JSON.stringify(root)};
				if (${JSON.stringify(kind)} === 'artifact') new FileArtifactContentStore(root).putJson(${JSON.stringify(key)}, { value: 5000 });
				if (${JSON.stringify(kind)} === 'session') new FileAgentStateStore(root).createSession(${JSON.stringify(scope)}, ${JSON.stringify(now)});
				if (${JSON.stringify(kind)} === 'event') new ProposalRunEngine(new FileEnterpriseEventStore(root + '/events.json')).create(${JSON.stringify(command)});
			`], { encoding: "utf8", timeout: 10_000 });
			expect(child.signal, child.stderr).toBe("SIGKILL");
			if (kind === "artifact") {
				const store = new FileArtifactContentStore(root);
				if (phase === "after") expect(store.readJson(key)).toEqual({ value: 5000 });
				store.putJson(key, { value: 5000 });
				expect(() => store.putJson(key, { value: 6000 })).toThrow(expect.objectContaining({ code: "artifact_conflict" }));
			} else if (kind === "session") {
				const store = new FileAgentStateStore(root);
				expect(store.load(scope).revision).toBe(phase === "before" ? 0 : 1);
				store.save(scope, store.load(scope).revision, [], now);
				expect(store.load(scope).revision).toBe(phase === "before" ? 1 : 2);
			} else {
				const engine = new ProposalRunEngine(new FileEnterpriseEventStore(join(root, "events.json")));
				expect(engine.load(scope).aggregateVersion).toBe(phase === "before" ? 0 : 1);
				engine.create(command);
				engine.startProposal({ ...command, commandId: "start", expectedVersion: 1 });
				expect(engine.load(scope).aggregateVersion).toBe(2);
			}
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
});

it("excludes a live writer across processes and releases the lock when that process dies", async () => {
	const root = mkdtempSync(join(tmpdir(), "packx-lock-owner-")), path = join(root, "state.json");
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
		import { writeSync } from 'node:fs';
		import { withFileWriteLock } from ${modulePath("server/fileWriteLock.ts")};
		withFileWriteLock(${JSON.stringify(path)}, () => { writeSync(1, 'locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); });
	`], { stdio: ["ignore", "pipe", "pipe"] });
	const exited = once(child, "exit");
	try {
		await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
		expect(() => withFileWriteLock(path, () => { throw new Error("must not execute"); })).toThrow("File write lock is unavailable");
		child.kill("SIGKILL"); await exited;
		expect(withFileWriteLock(path, () => "recovered")).toBe("recovered");
		expect(() => withFileWriteLock(path, () => { throw new Error("original failure"); })).toThrow("original failure");
		expect(withFileWriteLock(path, () => "released")).toBe("released");
	} finally { child.kill("SIGKILL"); await exited; rmSync(root, { recursive: true, force: true }); }
}, 15_000);

it("preserves unknown legacy locks, corrupt lock files and symlink targets", () => {
	const root = mkdtempSync(join(tmpdir(), "packx-lock-invalid-"));
	try {
		const legacy = join(root, "legacy.json"), corrupt = join(root, "corrupt.json"), link = join(root, "link.json");
		mkdirSync(`${legacy}.lock`);
		writeFileSync(`${corrupt}.lock`, "not sqlite");
		symlinkSync(`${corrupt}.lock`, `${link}.lock`);
		for (const path of [legacy, corrupt, link]) expect(() => withFileWriteLock(path, () => "must not execute")).toThrow("File write lock is unavailable");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
