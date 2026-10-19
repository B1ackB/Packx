import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileToolExecutionManifest } from "../../src/agent/sandbox";
import type { ToolExecutionManifest } from "../../src/agent/sandbox";
import {
	compileMacOsSeatbeltProfile,
	diagnoseMacOsSeatbelt,
	MacOsSeatbeltSandboxedToolExecutor,
} from "./macOsSeatbeltSandboxedToolExecutor";

const runSeatbeltTests = process.platform === "darwin" && process.env.BLACKX_RUN_SEATBELT_TESTS === "1";

function processRecord(pid: number) {
	const observed = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,pgid=,state=,lstart=,comm="], { encoding: "utf8" });
	if (observed.status === 1 && !observed.stdout.trim()) return undefined;
	expect(observed.error).toBeUndefined();
	expect(observed.status, observed.stderr).toBe(0);
	const fields = observed.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.+)$/);
	expect(fields, observed.stdout).not.toBeNull();
	return { pid, parent: Number(fields![2]), state: fields![4], identity: `${fields![3]} ${fields![5]} ${fields![6]}`, raw: observed.stdout.trim() };
}

async function expectTerminated(original: NonNullable<ReturnType<typeof processRecord>>) {
	const observed = processRecord(original.pid);
	// kill(pid, 0) also succeeds for zombies. A reused PID is not the process started by this fixture.
	const same = observed?.identity === original.identity;
	expect(!same || observed!.state.startsWith("Z"), JSON.stringify({ original, observed })).toBe(true);
	await expect.poll(() => processRecord(original.pid)?.identity !== original.identity, { timeout: 2_000 }).toBe(true);
}

function manifest(
	workspaceRoot: string,
	overrides: {
		executable?: string;
		argv?: readonly string[];
		readOnly?: readonly string[];
		writable?: readonly string[];
		network?: ToolExecutionManifest["network"];
		limits?: Partial<ToolExecutionManifest["limits"]>;
	} = {},
): ToolExecutionManifest {
	return compileToolExecutionManifest({
		attemptId: randomUUID(),
		tenantId: "tenant-1",
		workspaceId: "workspace-1",
		runId: "run-1",
		stageId: "stage-1",
		executionId: "execution-1",
		toolCallId: "tool-call-1",
		tool: { name: "seatbelt_fixture", version: "1.0.0" },
		command: {
			executable: overrides.executable ?? "/usr/bin/true",
			argv: overrides.argv ?? [],
			workingDirectory: workspaceRoot,
		},
		paths: {
			readOnly: overrides.readOnly ?? [],
			writable: overrides.writable ?? [],
			temporaryDirectory: join(workspaceRoot, ".blackx-tmp", randomUUID()),
		},
		environment: { LANG: "C" },
		network: overrides.network ?? { mode: "deny-all", allowedDomains: [] },
		limits: {
			timeoutMs: 1_000,
			maxStdoutBytes: 8_192,
			maxStderrBytes: 8_192,
			maxOutputFiles: 4,
			maxOutputBytes: 8_192,
			...overrides.limits,
		},
		idempotencyKey: "seatbelt-fixture-1",
	});
}

describe("macOS Seatbelt profile compiler", () => {
	it("denies network and file access before reopening only declared paths", () => {
		const profile = compileMacOsSeatbeltProfile({
			executable: "/usr/bin/sips",
			workingDirectory: "/workspace",
			readOnlyPaths: ["/workspace/input.png"],
			writablePaths: ["/workspace/output"],
			temporaryDirectory: "/workspace/.blackx-tmp/attempt",
		});

		expect(profile).toContain("(deny network*)");
		expect(profile.indexOf("(deny file-read*)")).toBeLessThan(profile.indexOf("/workspace/input.png"));
		expect(profile.indexOf("(deny file-write*)")).toBeLessThan(profile.lastIndexOf("/workspace/output"));
		expect(profile).not.toContain("/Users/");
	});

	it("reports unsupported platforms or missing Seatbelt executables", async () => {
		const diagnostic = await diagnoseMacOsSeatbelt("/missing/sandbox-exec");

		expect(diagnostic).toEqual({
			available: false,
			reason: process.platform === "darwin"
				? "sandbox-exec is unavailable or not executable"
				: "macOS is required",
		});
	});

	it("fails closed instead of spawning without Seatbelt", async () => {
		const executor = new MacOsSeatbeltSandboxedToolExecutor({
			workspaceRoot: "/missing/workspace",
			sandboxExecutable: "/missing/sandbox-exec",
		});

		const failed = await executor.execute(manifest("/missing/workspace"), new AbortController().signal);

		expect(failed).toMatchObject({
			status: "sandbox_unavailable",
			sandbox: { platform: "macos-seatbelt" },
		});
	});
});

describe.skipIf(!runSeatbeltTests)("macOS Seatbelt executor attack regression", () => {
	let workspaceRoot: string;
	let outsideRoot: string;

	beforeEach(() => {
		workspaceRoot = mkdtempSync(join(tmpdir(), "blackx-seatbelt-workspace-"));
		outsideRoot = mkdtempSync(join(tmpdir(), "blackx-seatbelt-outside-"));
		mkdirSync(join(workspaceRoot, ".blackx-tmp"));
	});

	afterEach(() => {
		rmSync(workspaceRoot, { recursive: true, force: true });
		rmSync(outsideRoot, { recursive: true, force: true });
	});

	it("reads only declared Workspace inputs and receives only allowlisted environment values", async () => {
		const input = join(workspaceRoot, "input.txt");
		writeFileSync(input, "allowed-input");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		const read = await executor.execute(manifest(workspaceRoot, {
			executable: "/bin/cat",
			argv: [input],
			readOnly: [input],
		}), new AbortController().signal);
		const environment = await executor.execute(manifest(workspaceRoot, {
			executable: "/usr/bin/env",
		}), new AbortController().signal);

		expect(read.stderr.text).toBe("");
		expect(read).toMatchObject({ status: "succeeded", exitCode: 0 });
		expect(read.stdout.text).toBe("allowed-input");
		expect(environment.stdout.text.trim()).toBe("LANG=C");
		expect(environment.stdout.text).not.toContain("ANTHROPIC_API_KEY");
	});

	it("denies undeclared reads and writes even when argv requests them", async () => {
		const outsideInput = join(outsideRoot, "secret.txt");
		const undeclaredInput = join(workspaceRoot, "undeclared-secret.txt");
		const undeclaredOutput = join(workspaceRoot, "undeclared.txt");
		writeFileSync(outsideInput, "secret");
		writeFileSync(undeclaredInput, "workspace-secret");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		const outsideRead = await executor.execute(manifest(workspaceRoot, {
			executable: "/bin/cat",
			argv: [outsideInput],
		}), new AbortController().signal);
		const workspaceRead = await executor.execute(manifest(workspaceRoot, {
			executable: "/bin/cat",
			argv: [undeclaredInput],
		}), new AbortController().signal);
		const write = await executor.execute(manifest(workspaceRoot, {
			executable: "/usr/bin/touch",
			argv: [undeclaredOutput],
		}), new AbortController().signal);

		expect(outsideRead.status).toBe("failed");
		expect(outsideRead.stdout.text).not.toContain("secret");
		expect(workspaceRead.status).toBe("failed");
		expect(workspaceRead.stdout.text).not.toContain("workspace-secret");
		expect(write.status).toBe("failed");
		expect(existsSync(undeclaredOutput)).toBe(false);
	});

	it("keeps Git and Packx control state denied even under a broad Workspace grant", async () => {
		const gitDirectory = join(workspaceRoot, ".git");
		const stateDirectory = join(workspaceRoot, ".blackx-data");
		const settingsFile = join(workspaceRoot, ".packx-settings.json");
		writeFileSync(settingsFile, "fixture-private-configuration");
		const gitConfig = join(gitDirectory, "config");
		const stateFile = join(stateDirectory, "events.json");
		mkdirSync(gitDirectory);
		mkdirSync(stateDirectory);
		writeFileSync(gitConfig, "git-secret");
		writeFileSync(stateFile, "state-before");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		const read = await executor.execute(manifest(workspaceRoot, {
			executable: "/bin/cat",
			argv: [gitConfig],
			readOnly: [workspaceRoot],
		}), new AbortController().signal);
		const write = await executor.execute(manifest(workspaceRoot, {
			executable: "/usr/bin/touch",
			argv: [stateFile],
			writable: [workspaceRoot],
		}), new AbortController().signal);

		const privateRead = await executor.execute(manifest(workspaceRoot, { executable: "/bin/cat", argv: [settingsFile], readOnly: [workspaceRoot] }), new AbortController().signal);
		expect(privateRead.status).toBe("failed");
		expect(privateRead.stdout.text).not.toContain("fixture-private-configuration");
		expect(read.status).toBe("failed");
		expect(read.stdout.text).not.toContain("git-secret");
		expect(write.status).toBe("failed");
		expect(readFileSync(stateFile, "utf8")).toBe("state-before");
	});

	it("allows declared writes and hashes staged regular-file outputs before cleanup", async () => {
		const input = join(workspaceRoot, "input.txt");
		const writable = join(workspaceRoot, "output");
		mkdirSync(writable);
		writeFileSync(input, "artifact-output");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const writeManifest = manifest(workspaceRoot, {
			executable: "/usr/bin/touch",
			argv: [join(writable, "allowed.txt")],
			writable: [writable],
		});
		const stagedManifest = manifest(workspaceRoot, {
			executable: "/bin/cp",
			readOnly: [input],
		});
		const stagedPath = join(stagedManifest.paths.temporaryDirectory, "artifact.txt");
		const stagedWithArgv = compileToolExecutionManifest({
			...stagedManifest,
			command: { ...stagedManifest.command, argv: [input, stagedPath] },
		});

		const write = await executor.execute(writeManifest, new AbortController().signal);
		const staged = await executor.execute(stagedWithArgv, new AbortController().signal);

		expect(write.stderr.text).toBe("");
		expect(write.status).toBe("succeeded");
		expect(readFileSync(join(writable, "allowed.txt"))).toHaveLength(0);
		expect(staged).toMatchObject({
			status: "succeeded",
			outputs: [{
				path: "artifact.txt",
				size: Buffer.byteLength("artifact-output"),
				mimeType: "text/plain",
				sha256: createHash("sha256").update("artifact-output").digest("hex"),
			}],
		});
		expect(existsSync(stagedManifest.paths.temporaryDirectory)).toBe(false);
	});

	it("rejects manifest paths outside the configured Workspace before spawn", async () => {
		const outsideInput = join(outsideRoot, "input.txt");
		writeFileSync(outsideInput, "outside");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		const denied = await executor.execute(manifest(workspaceRoot, {
			readOnly: [outsideInput],
		}), new AbortController().signal);

		expect(denied).toMatchObject({
			status: "policy_denied",
			sandbox: { terminationReason: "manifest_path_policy_denied" },
		});
	});

	it("rejects symbolic links in permission paths and staged outputs", async () => {
		const outsideInput = join(outsideRoot, "input.txt");
		const linkedInput = join(workspaceRoot, "linked-input.txt");
		writeFileSync(outsideInput, "outside");
		symlinkSync(outsideInput, linkedInput);
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		const permissionLink = await executor.execute(manifest(workspaceRoot, {
			readOnly: [linkedInput],
		}), new AbortController().signal);
		const outputManifest = manifest(workspaceRoot, { executable: "/bin/ln" });
		const outputLink = join(outputManifest.paths.temporaryDirectory, "linked-output.txt");
		const stagedLink = compileToolExecutionManifest({
			...outputManifest,
			command: { ...outputManifest.command, argv: ["-s", outsideInput, outputLink] },
		});
		const output = await executor.execute(stagedLink, new AbortController().signal);

		expect(permissionLink.status).toBe("policy_denied");
		expect(output).toMatchObject({
			status: "policy_denied",
			sandbox: { terminationReason: "output_validation_failed" },
		});
	});

	it("rejects staged hard links before returning their output manifest", async () => {
		const writable = join(workspaceRoot, "work");
		const source = join(writable, "source.txt");
		mkdirSync(writable);
		writeFileSync(source, "linked-content");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const base = manifest(workspaceRoot, {
			executable: "/bin/ln",
			writable: [writable],
		});
		const linked = compileToolExecutionManifest({
			...base,
			command: {
				...base.command,
				argv: [source, join(base.paths.temporaryDirectory, "hard-link.txt")],
			},
		});

		const output = await executor.execute(linked, new AbortController().signal);

		expect(output).toMatchObject({
			status: "policy_denied",
			outputs: [],
			sandbox: { terminationReason: "output_validation_failed" },
		});
	});

	it("enforces stdout and wall-clock limits and kills the process group", async () => {
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const noisy = await executor.execute(manifest(workspaceRoot, {
			executable: "/usr/bin/yes",
			limits: { maxStdoutBytes: 64 },
		}), new AbortController().signal);
		const slow = await executor.execute(manifest(workspaceRoot, {
			executable: "/bin/sh",
			argv: ["-c", "/bin/sleep 10 & echo $!; wait"],
			limits: { timeoutMs: 50 },
		}), new AbortController().signal);

		expect(noisy.status).toBe("resource_exhausted");
		expect(Buffer.byteLength(noisy.stdout.text)).toBeLessThanOrEqual(64);
		expect(noisy.stdout.truncated).toBe(true);
		expect(slow.status).toBe("timed_out");
		expect(slow.durationMs).toBeLessThan(2_000);
		const childPid = Number(slow.stdout.text.trim());
		expect(Number.isSafeInteger(childPid)).toBe(true);
		expect(childPid).toBeGreaterThan(1);
		const remaining = processRecord(childPid);
		if (remaining) expect(remaining.state, remaining.raw).toMatch(/^Z/);
		try {
			process.kill(childPid, 0);
			console.log(JSON.stringify({ cleanupObservation: "pid_still_visible", pid: childPid, process: processRecord(childPid) ?? "already_reaped" }));
		} catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH"); }
		// This short case has no pre-exit identity. Require eventual removal, and print OS state on failure.
		await expect.poll(() => processRecord(childPid), { timeout: 2_000 }).toBeUndefined();
	});

	it.each(["succeeded", "timed_out", "cancelled", "failed"] as const)("cleans the identified tool and descendant on %s", async (status) => {
		const ready = join(workspaceRoot, "ready"), release = join(workspaceRoot, "release");
		const controller = new AbortController();
		const job = manifest(workspaceRoot, {
			executable: "/bin/sh",
			argv: ["-c", '/bin/sleep 30 & child=$!; echo "$$ $child" > "$1"; while [ ! -f "$2" ]; do /bin/sleep .01; done; exit "$3"', "fixture", ready, release, status === "failed" ? "7" : "0"],
			writable: [workspaceRoot], limits: { timeoutMs: status === "timed_out" ? 1_000 : 5_000 },
		});
		const pending = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot }).execute(job, controller.signal);
		try {
			await expect.poll(() => existsSync(ready) && readFileSync(ready, "utf8").trim().split(" ").length === 2, { timeout: 3_000 }).toBe(true);
			const identities = readFileSync(ready, "utf8").trim().split(" ").map(Number).map(processRecord);
			expect(identities.every((record) => record && !record.state.startsWith("Z"))).toBe(true);
			if (status === "cancelled") controller.abort(new Error("user_cancelled"));
			else if (status !== "timed_out") writeFileSync(release, "release");
			const result = await pending;
			expect(result.status).toBe(status);
			for (const identity of identities) await expectTerminated(identity!);
			expect(existsSync(job.paths.temporaryDirectory)).toBe(false);
		} finally { controller.abort(); await pending; }
	}, 10_000);

	it("removes staging and returns no output when the supervisor cannot spawn after preflight", async () => {
		// An executable directory passes access(X_OK) but fails spawn; exercise the post-preflight error path.
		const job = manifest(workspaceRoot);
		const output = await new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot, supervisorExecutable: outsideRoot })
			.execute(job, new AbortController().signal);
		expect(output).toMatchObject({ status: "sandbox_unavailable", outputs: [], sandbox: { terminationReason: "sandbox_spawn_failed" } });
		expect(existsSync(job.paths.temporaryDirectory)).toBe(false);
	});

	it("propagates user cancellation and terminates the sandbox process group", async () => {
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const controller = new AbortController();
		const pending = executor.execute(manifest(workspaceRoot, {
			executable: "/bin/sleep",
			argv: ["10"],
		}), controller.signal);
		setTimeout(() => controller.abort(new Error("user_cancelled")), 20);

		const cancelled = await pending;

		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.durationMs).toBeLessThan(2_000);
	});

	it("denies localhost network access before the request reaches the Host", async () => {
		let connections = 0;
		const server = createServer((_request, response) => {
			response.end("unexpected");
		});
		server.on("connection", () => { connections += 1; });
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Local test server did not expose a TCP port");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const probe = ["-z", "-w", "2", "127.0.0.1", String(address.port)];

		try {
			const reachable = spawnSync("/usr/bin/nc", probe, { encoding: "utf8" });
			expect(reachable.status, "the same probe must reach the endpoint outside the sandbox").toBe(0);
			const denied = await executor.execute(manifest(workspaceRoot, {
				executable: "/usr/bin/nc",
				argv: probe,
			}), new AbortController().signal);

			expect(denied.status).toBe("failed");
			expect(denied.exitCode).not.toBe(0);
			expect(connections).toBe(1);
		} finally {
			await new Promise<void>((resolveClose, rejectClose) => server.close((error) =>
				error ? rejectClose(error) : resolveClose()
			));
		}
	});


	it("enforces CPU, sampled RSS and process-count budgets", async () => {
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const cpu = await executor.execute(manifest(workspaceRoot, { executable: "/bin/sh", argv: ["-c", "while :; do :; done"], limits: { timeoutMs: 5000, maxCpuSeconds: 1 } }), new AbortController().signal);
		expect(cpu.status).toBe("resource_exhausted");
		const memory = await executor.execute(manifest(workspaceRoot, { executable: "/bin/sleep", argv: ["10"], limits: { maxMemoryBytes: 1 } }), new AbortController().signal);
		expect(memory.status).toBe("resource_exhausted");
		const processes = await executor.execute(manifest(workspaceRoot, { executable: "/bin/sh", argv: ["-c", "sleep 10 & sleep 10 & wait"], limits: { maxProcesses: 1 } }), new AbortController().signal);
		expect(processes.status).toBe("resource_exhausted");
	}, 10_000);

	it("kills parser descendants and removes temporary output when the Host is forcibly terminated", async () => {
		const pidFile = join(workspaceRoot, "parser.pid");
		const job = manifest(workspaceRoot, { executable: "/bin/sh", argv: ["-c", `echo $$ > "${pidFile}"; sleep 30 & wait`], writable: [workspaceRoot], limits: { timeoutMs: 60_000 } });
		const code = `import { MacOsSeatbeltSandboxedToolExecutor } from ${JSON.stringify(resolve("server/runtime/macOsSeatbeltSandboxedToolExecutor.ts"))}; await new MacOsSeatbeltSandboxedToolExecutor({workspaceRoot:${JSON.stringify(workspaceRoot)}}).execute(${JSON.stringify(job)}, new AbortController().signal);`;
		const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: "ignore" });
		try {
			for (let i = 0; i < 200 && !existsSync(pidFile); i++) await delay(20);
			expect(existsSync(pidFile)).toBe(true);
			const parser = Number(readFileSync(pidFile, "utf8").trim());
			const exited = once(host, "exit"); host.kill("SIGKILL"); await exited;
			for (let i = 0; i < 100 && existsSync(job.paths.temporaryDirectory); i++) await delay(20);
			expect(existsSync(job.paths.temporaryDirectory)).toBe(false);
			let gone = false;
			for (let i = 0; i < 100; i++) {
				try { process.kill(parser, 0); } catch { gone = true; break; }
				await delay(20);
			}
			expect(gone).toBe(true);
		} finally { if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL"); }
	}, 10_000);

	it("reaches only allowlisted domains through the Host proxy", async () => {
		const upstream = createNetServer((socket) => socket.end("upstream-reached\n"));
		await new Promise<void>((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
		const upstreamPort = (upstream.address() as { port: number }).port;
		const dialed: string[] = [];
		const decisions: string[] = [];
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot, egress: {
			resolve: async (host) => host === "private.test" ? ["10.0.0.9"] : ["93.184.216.34"],
			connect: (address) => { dialed.push(address); return netConnect(upstreamPort, "127.0.0.1"); },
			onDecision: (decision) => decisions.push(`${decision.domain}:${decision.reason}`),
		} });
		const tunnel = "p=${HTTPS_PROXY##*:}; { printf 'CONNECT %s:443 HTTP/1.1\\r\\n\\r\\n' \"$0\"; sleep 2; } | /usr/bin/nc -w 3 127.0.0.1 \"$p\"";
		const attempt = (domain: string) => executor.execute(manifest(workspaceRoot, {
			executable: "/bin/sh",
			argv: ["-c", tunnel, domain],
			network: { mode: "allowlist", allowedDomains: ["allowed.test", "private.test"] },
		}), new AbortController().signal);

		try {
			const allowed = await attempt("allowed.test");
			const blocked = await attempt("blocked.test");
			const privateAddress = await attempt("private.test");

			expect(allowed.stdout.text).toContain("200 Connection Established");
			expect(allowed.stdout.text).toContain("upstream-reached");
			expect(blocked.stdout.text).toContain("403 Forbidden");
			expect(privateAddress.stdout.text).toContain("403 Forbidden");
			expect(dialed).toEqual(["93.184.216.34"]);
			expect(decisions).toEqual(expect.arrayContaining(["allowed.test:allowed", "blocked.test:domain_not_allowed", "private.test:private_address"]));
		} finally {
			await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
		}
	}, 20_000);

	it("denies signals to the supervisor and keeps the Host-side result intact", async () => {
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const job = manifest(workspaceRoot, { executable: "/bin/sh" });
		const attack = compileToolExecutionManifest({
			...job,
			command: { ...job.command, argv: ["-c", 'kill -9 $PPID 2>/dev/null; echo "kill-status=$?"; echo after', job.paths.temporaryDirectory] },
		});

		const result = await executor.execute(attack, new AbortController().signal);

		expect(result.status).toBe("succeeded");
		expect(result.stdout.text).toContain("kill-status=1");
		expect(result.stdout.text).toContain("after");
	});

	it("denies direct connections that bypass the proxy in allowlist mode", async () => {
		let direct = 0;
		const listener = createNetServer((socket) => { direct += 1; socket.end(); });
		await new Promise<void>((resolveListen) => listener.listen(0, "127.0.0.1", resolveListen));
		const port = (listener.address() as { port: number }).port;
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		try {
			const bypass = await executor.execute(manifest(workspaceRoot, {
				executable: "/usr/bin/nc",
				argv: ["-z", "-w", "2", "127.0.0.1", String(port)],
				network: { mode: "allowlist", allowedDomains: ["allowed.test"] },
			}), new AbortController().signal);

			expect(bypass.status).toBe("failed");
			expect(bypass.exitCode).not.toBe(0);
			expect(direct).toBe(0);
		} finally {
			await new Promise<void>((resolveClose) => listener.close(() => resolveClose()));
		}
	});

	it("fails closed when the egress proxy cannot listen, without spawning the Tool", async () => {
		const occupant = createNetServer();
		await new Promise<void>((resolveListen) => occupant.listen(0, "127.0.0.1", resolveListen));
		const port = (occupant.address() as { port: number }).port;
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot, egress: { listenPort: port } });
		const job = manifest(workspaceRoot, {
			executable: "/bin/sh",
			argv: ["-c", 'echo ran > "$0/marker.txt"', "placeholder"],
			network: { mode: "allowlist", allowedDomains: ["allowed.test"] },
		});
		const attempt = compileToolExecutionManifest({
			...job,
			command: { ...job.command, argv: ["-c", 'echo ran > "$0/marker.txt"', job.paths.temporaryDirectory] },
		});

		try {
			const result = await executor.execute(attempt, new AbortController().signal);

			expect(result).toMatchObject({ status: "sandbox_unavailable", sandbox: { terminationReason: "egress_proxy_unavailable" } });
			expect(result.outputs ?? []).toHaveLength(0);
			expect(existsSync(job.paths.temporaryDirectory)).toBe(false);
		} finally {
			await new Promise<void>((resolveClose) => occupant.close(() => resolveClose()));
		}
	});

	it("never imports output when the supervisor dies after the Tool wrote it", async () => {
		const killed = join(outsideRoot, "supervisor-killed.sh");
		const ready = join(outsideRoot, "supervisor-ready");
		writeFileSync(killed, `#!/bin/sh\necho partial > "$6/out.txt"\necho $$ > "${ready}"\nkill -STOP $$\n`, { mode: 0o755 });
		const crashed = join(outsideRoot, "supervisor-exit70.sh");
		writeFileSync(crashed, "#!/bin/sh\nexit 70\n", { mode: 0o755 });
		// This is an exit/partial-output fixture, not a one-second launch benchmark.
		// The test's existing 5s deadline stays in force; deadline tests retain 50ms/1s limits.
		const job = manifest(workspaceRoot, { executable: "/bin/sh", argv: ["-c", "true"], limits: { timeoutMs: 5000 } });
		const cancellation = new AbortController();
		const pending = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot, supervisorExecutable: killed })
			.execute(job, cancellation.signal);
		let signalled: Awaited<typeof pending>;
		try {
			await expect.poll(() => existsSync(ready), { timeout: 2000 }).toBe(true);
			const pid = Number(readFileSync(ready, "utf8").trim());
			expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
			expect(readFileSync(join(job.paths.temporaryDirectory, "out.txt"), "utf8")).toBe("partial\n");
			process.kill(-pid, "SIGKILL");
			signalled = await pending;
		} finally { cancellation.abort(); await pending; }
		const exited = await new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot, supervisorExecutable: crashed })
			.execute(manifest(workspaceRoot, { executable: "/bin/sh", argv: ["-c", "true"], limits: { timeoutMs: 5000 } }), new AbortController().signal);

		expect(signalled.status).toBe("failed");
		expect(signalled.outputs ?? []).toHaveLength(0);
		expect(signalled.exitCode).toBeNull();
		expect(exited).toMatchObject({ status: "sandbox_unavailable", sandbox: { terminationReason: "supervisor_failed" } });
		expect(exited.outputs ?? []).toHaveLength(0);
	});

	it("redacts host workspace and temporary paths from returned output", async () => {
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const job = manifest(workspaceRoot, { executable: "/bin/sh" });
		const probe = compileToolExecutionManifest({
			...job,
			command: { ...job.command, argv: ["-c", 'pwd; echo "$0"', join(job.paths.temporaryDirectory, "probe.txt")] },
		});

		const result = await executor.execute(probe, new AbortController().signal);

		expect(result.status).toBe("succeeded");
		expect(result.stdout.text).toBe("<workspace>\n<tmp>/probe.txt\n");
		expect(result.stdout.text).not.toContain(workspaceRoot);
	});

	it("denies public, private and DNS network destinations", async () => {
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const targets = ["1.1.1.1", "10.255.255.1", "example.com"];

		for (const target of targets) {
			const attempt = await executor.execute(manifest(workspaceRoot, {
				executable: "/usr/bin/nc",
				argv: ["-z", "-w", "2", target, "80"],
			}), new AbortController().signal);

			expect(attempt.status, target).toBe("failed");
			expect(attempt.exitCode, target).not.toBe(0);
			expect(attempt.stdout.text, target).toBe("");
		}
	}, 20_000);

	it("denies nested shell writes outside the declared scope", async () => {
		const escaped = join(outsideRoot, "escaped.txt");
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });

		const nested = await executor.execute(manifest(workspaceRoot, {
			executable: "/bin/sh",
			argv: ["-c", `echo escaped > "$0"`, escaped],
			writable: [workspaceRoot],
		}), new AbortController().signal);

		expect(nested).toMatchObject({ status: "failed", exitCode: 1 });
		expect(nested.stderr.text).toContain("Operation not permitted");
		expect(existsSync(escaped)).toBe(false);
	});

	it("rejects staged outputs that exceed the declared file-count limit", async () => {
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const job = manifest(workspaceRoot, {
			executable: "/bin/sh",
			argv: ["-c", `for i in 1 2 3; do echo x > "$0/$i.txt"; done`, "placeholder"],
			limits: { maxOutputFiles: 2 },
		});
		const tooMany = compileToolExecutionManifest({
			...job,
			command: { ...job.command, argv: ["-c", `for i in 1 2 3; do echo x > "$0/$i.txt"; done`, job.paths.temporaryDirectory] },
		});

		const result = await executor.execute(tooMany, new AbortController().signal);

		expect(result).toMatchObject({ status: "resource_exhausted", sandbox: { terminationReason: "output_limit_exceeded" } });
		expect(result.outputs ?? []).toHaveLength(0);
		expect(existsSync(job.paths.temporaryDirectory)).toBe(false);
	});

	it("rejects FIFO and other non-regular files in staged output", async () => {
		const executor = new MacOsSeatbeltSandboxedToolExecutor({ workspaceRoot });
		const job = manifest(workspaceRoot, { executable: "/usr/bin/mkfifo", argv: ["placeholder"] });
		const fifo = compileToolExecutionManifest({
			...job,
			command: { ...job.command, argv: [join(job.paths.temporaryDirectory, "pipe")] },
		});

		const result = await executor.execute(fifo, new AbortController().signal);

		expect(result).toMatchObject({ status: "policy_denied", sandbox: { terminationReason: "output_validation_failed" } });
		expect(result.outputs ?? []).toHaveLength(0);
		expect(existsSync(job.paths.temporaryDirectory)).toBe(false);
	});
});
